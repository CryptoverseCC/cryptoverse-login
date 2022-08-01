import { getInjectedProvider } from "web3modal";
import {
  TInnerLoginRequest, TLoginResponse,
} from "../services/loginProvider";
import { signers } from "./signers";
import { getProvider, getEthers, Window } from "./utils";


export const login = async ({ address, csrf, challenge }: TInnerLoginRequest): Promise<TLoginResponse> => {
  const sentry = (window as unknown as Window).Sentry;
  let message = `Cryptoverse Login - auth.cryptoverse.cc|${csrf}|${challenge}`;
  let signer;

  const pp = getInjectedProvider();

  sentry.onLoad(() => sentry?.setContext("provider", {
    name: pp?.name,
    id: pp?.id,
  }));

  sentry.onLoad(() => sentry?.setContext("user", {
    address
  }));

  if (pp) {
    const name = pp.name.toLowerCase();
    signer = signers[name];
  }

  if (!signer) {
    signer = signers.default;
  }

  signer = signer(getProvider(), getEthers());

  let signature;

  try {
    signature = await signer.sign(message)
  } catch (error) {
    sentry?.captureException(error); // TODO: wrap Sentry in some service eg. ErrorReporter
    return null;
  }


  try {
    await signer.verify(signature, message, address);
  } catch (error) {
    sentry?.captureException(error); // TODO: wrap Sentry in some service eg. ErrorReporter
    return null;
  }

  try {
    return {
      signature,
      csrf,
      challenge,
      address,
    };
  } catch (error) {
    sentry?.captureException(error); // TODO: wrap Sentry in some service eg. ErrorReporter
    return null;
  }
};
