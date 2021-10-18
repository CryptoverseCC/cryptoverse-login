import { getProviderInfoById } from "web3modal";
import { ProviderList } from "./components/ConnectWalletPage";


export const walletProviders: ProviderList = [
  { provider: getProviderInfoById("walletconnect"), active: true },
  { provider: getProviderInfoById("mewconnect"), active: true },
  { provider: getProviderInfoById("fortmatic"), active: false },
  { provider: getProviderInfoById("torus"), active: false },
  { provider: getProviderInfoById("authereum"), active: false },
  { provider: getProviderInfoById("burnerconnect"), active: false },
  { provider: getProviderInfoById("portis"), active: false },
  { provider: getProviderInfoById("arkane"), active: false },
  { provider: getProviderInfoById("dcentwallet"), active: false },
  { provider: getProviderInfoById("bitski"), active: false },
];
