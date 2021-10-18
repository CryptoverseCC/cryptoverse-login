import MewConnect from '@myetherwallet/mewconnect-web-client';
import WalletConnectProvider from "@walletconnect/web3-provider";
import { ethers } from "ethers";
import Web3Modal, { getProviderInfoByName } from "web3modal";
import {
  TConnectRequest,
  TConnectResponse
} from "../services/loginProvider";
import { Window, setIdentities, setProvider, getProvider, setEthers } from "./utils";


export const connect = async ({ name }: TConnectRequest): Promise<TConnectResponse> => {
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

  sentry?.setContext("providerName", { name });

  const pi = getProviderInfoByName(name)

  let p;

  try {
    p = await web3Modal.connectTo(pi.id);
  } catch (error) {
    sentry?.setContext("providerInstance", { p });
    sentry?.captureException(error); // TODO: wrap Sentry in some service eg. ErrorReporter
    return { identities: [] };
  }

  ethers.utils.Logger.setLogLevel(ethers.utils.Logger.levels.DEBUG);

  setProvider(new ethers.providers.Web3Provider(p));
  setEthers(ethers);

  let addresses;

  try {
    addresses = await getProvider().send("eth_requestAccounts", []);
  } catch (error) {
    sentry?.captureException(error); // TODO: wrap Sentry in some service eg. ErrorReporter
  }

  sentry?.setContext("user", { addresses });

  if (!addresses) {
    try {
      await p.enable();
      addresses = await getProvider().listAccounts();
    } catch (error) {
      sentry?.captureException(error); // TODO: wrap Sentry in some service eg. ErrorReporter
      return { identities: [] };
    }
  }

  sentry?.setContext("user", { addresses });

  if (!addresses) {
    return { identities: [] }
  }

  return { identities: setIdentities(addresses) };
};
