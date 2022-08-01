import { ethers } from "ethers";
import fetch from 'node-fetch';

// @ts-ignore
global.fetch = fetch;

// let provider = new ethers.providers.JsonRpcProvider(
//   "https://mainnet.infura.io/v3/b14cd69b84584cc39ec753dfaf245d63"
// );

type Email = string
type Name = string;
type ETHAddress = string;
type UDomain = Name;
type UDEmail = Email;
type ENSName = Name;
type ENSEmail = Email;

type Collection<T> = {
  default: T;
  all: T[];
}

type IDTokenEmails = {
  default: Email;
  all: Email[];
  ens: Collection<ENSEmail>;
  unstoppabledomains: Collection<UDEmail>;
}

type IDTokenNames = {
  default: Name;
  all: Name[];
  ens: Collection<ENSName>;
  unstoppabledomains: Collection<UDomain>;
}

type Address = {
  country: string; //Country name component.
  formatted?: string; //Full mailing address, formatted for display or use on a mailing label. This field MAY contain multiple lines, separated by newlines. Newlines can be represented either as a carriage return/line feed pair ("\r\n") or as a single line feed character ("\n").
  locality?: string; // City or locality component.
  postal_code?: string; //Zip code or postal code component.
  region: string; //State, province, prefecture, or region component.
  street_address?: string; //Full street address component, which MAY include house number, street name, Post Office Box, and multi-line extended street address information. This field MAY contain multiple lines, separated by newlines. Newlines can be represented either as a carriage return/line feed pair ("\r\n") or as a single line feed character ("\n").
}

interface IDToken {
  address: Address; 	//End-User's preferred postal address. The value of the address member is a JSON [RFC4627] structure containing some or all of the members defined in Section 5.1.1.
  birthdate: string; //End-User's birthday, represented as an ISO 8601:2004 [ISO8601‑2004] YYYY-MM-DD format. The year MAY be 0000, indicating that it is omitted. To represent only the year, YYYY format is allowed. Note that depending on the underlying platform's date related function, providing just year can result in varying month and day, so the implementers need to take this factor into account to correctly process the dates.
  email_verified: boolean; //True if the End-User's e-mail address has been verified; otherwise false. When this Claim Value is true, this means that the OP took affirmative steps to ensure that this e-mail address was controlled by the End-User at the time the verification was performed. The means by which an e-mail address is verified is context-specific, and dependent upon the trust framework or contractual agreements within which the parties are operating.
  email: Email; //End-User's preferred e-mail address. Its value MUST conform to the RFC 5322 [RFC5322] addr-spec syntax. The RP MUST NOT rely upon this value being unique, as discussed in Section 5.7.
  emails: IDTokenEmails;
  family_name: string; //Surname(s) or last name(s) of the End-User. Note that in some cultures, people can have multiple family names or no family name; all can be present, with the names being separated by space characters.
  gender: string; //End-User's gender. Values defined by this specification are female and male. Other values MAY be used when neither of the defined values are applicable.
  given_name: string; //Given name(s) or first name(s) of the End-User. Note that in some cultures, people can have multiple given names; all can be present, with the names being separated by space characters.
  locale: string; //End-User's locale, represented as a BCP47 [RFC5646] language tag. This is typically an ISO 639-1 Alpha-2 [ISO639‑1] language code in lowercase and an ISO 3166-1 Alpha-2 [ISO3166‑1] country code in uppercase, separated by a dash. For example, en-US or fr-CA. As a compatibility note, some implementations have used an underscore as the separator rather than a dash, for example, en_US; Relying Parties MAY choose to accept this locale syntax as well.
  middle_name: string; //Middle name(s) of the End-User. Note that in some cultures, people can have multiple middle names; all can be present, with the names being separated by space characters. Also note that in some cultures, middle names are not used.
  name: ETHAddress; //End-User's full name in displayable form including all name parts, possibly including titles and suffixes, ordered according to the End-User's locale and preferences.
  names: IDTokenNames;
  nickname: ENSName; //Casual name of the End-User that may or may not be the same as the given_name. For instance, a nickname value of Mike might be returned alongside a given_name value of Michael.
  phone_number_verified: boolean; //True if the End-User's phone number has been verified; otherwise false. When this Claim Value is true, this means that the OP took affirmative steps to ensure that this phone number was controlled by the End-User at the time the verification was performed. The means by which a phone number is verified is context-specific, and dependent upon the trust framework or contractual agreements within which the parties are operating. When true, the phone_number Claim MUST be in E.164 format and any extensions MUST be represented in RFC 3966 format.
  phone_number: string; //End-User's preferred telephone number. E.164 [E.164] is RECOMMENDED as the format of this Claim, for example, +1 (425) 555-1212 or +56 (2) 687 2400. If the phone number contains an extension, it is RECOMMENDED that the extension be represented using the RFC 3966 [RFC3966] extension syntax, for example, +1 (604) 555-1234;ext=5678.
  picture: string; //URL of the End-User's profile picture. This URL MUST refer to an image file (for example, a PNG, JPEG, or GIF image file), rather than to a Web page containing an image. Note that this URL SHOULD specifically reference a profile photo of the End-User suitable for displaying when describing the End-User, rather than an arbitrary photo taken by the End-User.
  preferred_username: string; //Shorthand name by which the End-User wishes to be referred to at the RP, such as janedoe or j.doe. This value MAY be any valid JSON : string; //ncluding special characters such as @, /, or whitespace. The RP MUST NOT rely upon this value being unique, as discussed in Section 5.7.
  profile: string; //URL of the End-User's profile page. The contents of this Web page SHOULD be about the End-User.
  sub: ETHAddress; //Subject - Identifier for the End-User at the Issuer.
  updated_at: number; 	//Time the End-User's information was last updated. Its value is a JSON number representing the number of seconds from 1970-01-01T0:0:0Z as measured in UTC until the date/time.
  website: string; //URL of the End-User's Web page or blog. This Web page SHOULD contain information published by the End-User or an organization that the End-User is affiliated with.
  zoneinfo: string; //String from zoneinfo [zoneinfo] time zone database representing the End-User's time zone. For example, Europe/Paris or America/Los_Angeles.
}

type TUDDomain = {
  name: string;
}

type UDAPIResponse = {
  domains: TUDDomain[];
}

async function getUDomains(address: ETHAddress): Promise<UDomain[]> {
  const response = await fetch(`https://unstoppabledomains.com/api/v1/resellers/udtesting/domains?owner=${address}&extension=crypto`)
  const data = await response.json() as UDAPIResponse;
  return data.domains.map(domain => domain.name as UDomain).filter(name => name.endsWith(".crypto"));
}

export async function getData(response): Promise<IDToken> {
  const user: ETHAddress = response.subject;
  const domain: string = process.env.MAILSERVER_DOMAIN;

  const emails: IDTokenEmails = {
    default: `${user}@${domain}`,
    all: [`${user}@${domain}`],
    ens: {
      default: null,
      all: []
    },
    unstoppabledomains: {
      default: null,
      all: []
    }
  }
  const names: IDTokenNames = {
    default: user,
    all: [user],
    ens: {
      default: null,
      all: []
    },
    unstoppabledomains: {
      default: null,
      all: []
    }
  }

  console.log(user, typeof (user))

  require("util").inspect.defaultOptions.depth = null;

  const provider = ethers.getDefaultProvider("mainnet", {
    infura: "b14cd69b84584cc39ec753dfaf245d63",
    alchemy: "SMpPuRIv3DSD_7SYzkMf9TPOS4HbNSq8",
  });

  const ENSName = await provider.lookupAddress(user);

  console.log("ENS: Address lookup result:", ENSName);

  if (ENSName) {
    const ENSEmail = `${ENSName.replace(/\.eth/gi, "")}@${domain}`;

    emails.all.push(ENSEmail);
    emails.ens.default = ENSEmail;
    emails.ens.all.push(ENSEmail);

    names.all.push(ENSName);
    names.ens.default = ENSName;
    names.ens.all.push(ENSName);
  }

  const UNames = await getUDomains(user);

  console.log("UD: Address lookup result:", UNames);

  if (UNames) {


    UNames.forEach(name => {
      const UDEmail = `${name.replace(/\.crypto$/, "")}@unstoppable.email`;
      emails.all.push(UDEmail);
      emails.unstoppabledomains.default = emails.unstoppabledomains.default ?? name;
      emails.unstoppabledomains.all.push(UDEmail)

      names.all.push(name);
      names.unstoppabledomains.default = names.unstoppabledomains.default ?? name;
      names.unstoppabledomains.all.push(name);
    });
  }

  return {
    address: {
      country: "Cryptoverse",
      region: "Ethereum",
    },
    birthdate: '',
    email_verified: true,
    email: `${user}@${domain}`,
    emails,
    family_name: "Ethereum",
    gender: "ethereum-address",
    given_name: user,
    locale: '',
    middle_name: '',
    name: user,
    names,
    nickname: names.ens.default,
    phone_number_verified: false,
    phone_number: '',
    picture: `https://cryptoverse.cc/${user}.png`,
    preferred_username: user,
    profile: `https://cryptoverse.cc/${user}`,
    sub: user,
    updated_at: 0,
    website: `https://${user}.cryptoverse.cc/`,
    zoneinfo: '',
  };
}
