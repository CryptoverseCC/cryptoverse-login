
import {
  TConnectRequest,
  TConnectResponse,
  TEthereumAddress
} from "../services/loginProvider";
import { Window, setIdentities, getProvider, setProvider } from "./utils";

export const connect = async ({ name }: TConnectRequest): Promise<TConnectResponse> => {
  const MewConnect = await import(/* webpackPrefetch: true */ '@myetherwallet/mewconnect-web-client');
  const WalletConnectProvider = await import(/* webpackPrefetch: true */ "@walletconnect/web3-provider");
  const x = (await import(/* webpackPrefetch: true */ 'ethers'));
  const d = x.default;
  const BrowserProvider = x.BrowserProvider;
  const Web3Modal = (await import(/* webpackPrefetch: true */ "web3modal")).default;
  const getProviderInfoByName = (await import(/* webpackPrefetch: true */ "web3modal")).getProviderInfoByName;

  let providerOptions = {
    walletconnect: {
      package: WalletConnectProvider,
      options: {
        infuraId: "b14cd69b84584cc39ec753dfaf245d63", // TODO: Move to some settings
      },
    },
    mewconnect: {
      package: MewConnect,
      options: {
        infuraId: "b14cd69b84584cc39ec753dfaf245d63", // TODO: Move to some settings
      }
    }
  };

  const sentry = (window as unknown as Window).Sentry;

  const web3Modal = new Web3Modal({
    network: "mainnet",
    //cacheProvider: true,
    providerOptions,
  });

  sentry.onLoad(() => sentry?.setContext("providerName", { name }));

  const pi = getProviderInfoByName(name)

  let prvder: any;

  try {
    prvder = await web3Modal.connectTo(pi.id);
  } catch (error) {
    sentry.onLoad(() => sentry?.setContext("providerInstance", { prvder }));
    sentry.onLoad(() => sentry?.captureException(error)); // TODO: wrap Sentry in some service eg. ErrorReporter
    return { identities: [] };
  }

  setProvider(new BrowserProvider(prvder));

  let addresses: TEthereumAddress[];

  try {
    addresses = await getProvider().send("eth_requestAccounts", []);
  } catch (error) {
    sentry?.captureException(error); // TODO: wrap Sentry in some service eg. ErrorReporter
    return { identities: [] };
  }

  sentry.onLoad(() => sentry?.setContext("user", { addresses }));

  if (!addresses) {
    try {
      await (prvder as unknown as any).enable();
      addresses = await getProvider().listAccounts();
    } catch (error) {
      sentry.onLoad(() => sentry?.captureException(error)); // TODO: wrap Sentry in some service eg. ErrorReporter
      return { identities: [] };
    }
  }

  sentry.onLoad(() => sentry?.setContext("user", { addresses }));

  if (!addresses) {
    return { identities: [] }
  }

  return { identities: setIdentities(addresses) };
};
