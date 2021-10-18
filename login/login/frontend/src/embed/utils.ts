import { IIdentity } from "../services/loginProvider";

export interface Window {
  Sentry: any;
  ethereum: any;
  ready: Promise<void>;
}
let ethereum = (window as unknown as Window).ethereum;

const state: { identities: IIdentity[], provider: any, ethers: any } = {
  identities: [],
  provider: null,
  ethers: null,
};

export const setIdentities = (accounts: string[]) => {
  state.identities = accounts.map((address: string) => ({
    name: address,
    ens: null,
    active: true,
  }))
  return state.identities;
}
export const getIdentities = () => {
  return state.identities;
}

export const setProvider = (provider: any) => {
  state.provider = provider;
}
export const getProvider = () => {
  return state.provider;
}

export const setEthers = (ethers: any) => {
  state.ethers = ethers;
}
export const getEthers = () => {
  return state.ethers;
}


const startChangeWatcher = () => {
  if (ethereum && ethereum.on) {
    ethereum.on('accountsChanged', function (accounts: string[]) {
      setIdentities(accounts);
    });
  }
}

startChangeWatcher();
