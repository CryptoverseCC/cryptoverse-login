/**
 * Shared wallet constants + ID-token claim assertions.
 *
 * Ported verbatim from the retired Selenium suite (`tests/test_full.py` +
 * `tests/metamask/pages.py`) so the new dappwright/Playwright harness exercises
 * the SAME deterministic account and asserts the SAME claims. Reuse the
 * seed/account/assertions; the mechanics (Selenium page objects, window
 * switching, fixed sleeps) are gone.
 */

/**
 * The fixed BIP-39 mnemonic the old suite imported into MetaMask
 * (`tests/metamask/pages.py::ImportForm.next`). dappwright imports it the same
 * way; the headless WalletConnect test wallet derives its signing key from it.
 */
export const SEED_PHRASE =
  "elephant frog rib donate live collect uniform lamp inch urge dish wash";

/**
 * The wallet-unlock password the old suite set (`pas = "selenium_tests"`).
 * dappwright needs a password (min length varies by extension version); reusing
 * the old one keeps parity. It is NOT security-sensitive — a throwaway local
 * test wallet.
 */
export const WALLET_PASSWORD = "selenium_tests"; // pragma: allowlist secret

/**
 * The first account derived from {@link SEED_PHRASE} (BIP-44 path
 * m/44'/60'/0'/0/0), lowercased — the value the IdP uses as the OIDC subject.
 * The old suite hardcoded this exact address; the WC test wallet re-derives it
 * from the seed and asserts it matches (see `wc-wallet/responder.ts`).
 */
export const ACCOUNT_ADDRESS =
  "0xae89b4e1b97661dab58bee7771e95ec58fc6a94b";

/**
 * Domains the kind cluster issues claims with. These are the chart defaults
 * (`tests/kind/values-kind.yaml` sets `mailserverDomain: ethmail.cc`; nothing
 * overrides `PROFILE_DOMAIN`, so it falls back to `cryptoverse.cc` — see
 * `login/login/src/main.rs`). Overridable via env for a differently-configured
 * stack.
 */
export const MAILSERVER_DOMAIN = process.env.MAILSERVER_DOMAIN ?? "ethmail.cc";
export const PROFILE_DOMAIN = process.env.PROFILE_DOMAIN ?? "cryptoverse.cc";

/**
 * The expected ID-token claims for {@link ACCOUNT_ADDRESS} on the kind cluster.
 * Mirrors the `assert_subset({...})` block in `test_full.py`, but parameterized
 * by the mail/profile domains and the address so it's reusable across wallets.
 *
 * ENS / Unstoppable Domains resolve to empty here — the kind cluster has no RPC
 * key, matching the chart's documented behaviour (`tests/kind/README.md`).
 */
export function expectedIdToken(
  address: string = ACCOUNT_ADDRESS,
  mailserverDomain: string = MAILSERVER_DOMAIN,
  profileDomain: string = PROFILE_DOMAIN,
): Record<string, unknown> {
  const email = `${address}@${mailserverDomain}`;
  return {
    address: { country: "Cryptoverse", region: "Ethereum" },
    birthdate: "",
    email,
    // The {address}@domain mailbox is synthesized, not delivery-verified, so the
    // IdP asserts email_verified=false by default (EMAIL_VERIFIED_CLAIM opt-in).
    email_verified: false,
    emails: {
      all: [email],
      default: email,
      ens: { all: [], default: null },
      unstoppabledomains: { all: [], default: null },
    },
    family_name: "Ethereum",
    gender: "ethereum-address",
    given_name: address,
    locale: "",
    middle_name: "",
    name: address,
    names: {
      all: [address],
      default: address,
      ens: { all: [], default: null },
      unstoppabledomains: { all: [], default: null },
    },
    nickname: null,
    phone_number: "",
    phone_number_verified: false,
    picture: `https://${profileDomain}/${address}.png`,
    preferred_username: address,
    profile: `https://${profileDomain}/${address}`,
    sub: address,
    website: `https://${address}.${profileDomain}/`,
    zoneinfo: "",
  };
}

/**
 * Assert every key/value in `expected` is present and deep-equal in `actual`
 * (the JS analogue of the old `assert_subset` helper — Python's removed
 * `assertDictContainsSubset`). Throws an Error with a precise path on mismatch.
 */
export function assertSubset(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  path = "id_token",
): void {
  for (const [key, value] of Object.entries(expected)) {
    const here = `${path}.${key}`;
    if (!(key in actual)) {
      throw new Error(`${here} missing`);
    }
    const got = (actual as Record<string, unknown>)[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      if (got === null || typeof got !== "object" || Array.isArray(got)) {
        throw new Error(
          `${here} expected an object, got ${JSON.stringify(got)}`,
        );
      }
      assertSubset(
        value as Record<string, unknown>,
        got as Record<string, unknown>,
        here,
      );
    } else if (JSON.stringify(value) !== JSON.stringify(got)) {
      throw new Error(
        `${here} = ${JSON.stringify(got)}, expected ${JSON.stringify(value)}`,
      );
    }
  }
}
