import { providers } from "web3modal";
import { ProviderList } from "./components/ConnectWalletPage";

export const walletProviders: ProviderList = [
  { provider: providers.WALLETCONNECT, active: true },
  { provider: providers.PORTIS, active: true },
  { provider: providers.FORTMATIC, active: true },
  { provider: providers.TORUS, active: true },
  { provider: providers.VENLY, active: true },
  { provider: providers.AUTHEREUM, active: true },
  { provider: providers.BURNERCONNECT, active: true },
  { provider: providers.MEWCONNECT, active: true },
  { provider: providers.DCENT, active: true },
  { provider: providers.LEDGER, active: true },
  { provider: providers.BITSKI, active: true },
  { provider: providers.FRAME, active: true },
  { provider: providers.BINANCECHAINWALLET, active: true },
  { provider: providers.COINBASEWALLET, active: true },
  { provider: providers.SEQUENCE, active: true },
  { provider: providers.OPERA, active: true },
  { provider: providers.WEB3AUTH, active: true },
  { provider: providers.BITKEEPWALLET, active: true },
];
