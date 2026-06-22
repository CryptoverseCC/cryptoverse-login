import {
  createConfig,
  http,
  getConnectors,
  watchAccount,
  type Config,
  type Connector,
  type CreateConnectorFn,
} from "@wagmi/core";
import { mainnet } from "@wagmi/core/chains";
import { coinbaseWallet, walletConnect } from "@wagmi/connectors";
import { IIdentity, TWalletInfo } from "../services/loginProvider";
import { connectorIcon } from "./walletIcons";

export interface Window {
  Sentry: any;
  ready: Promise<void>;
}

const state: { identities: IIdentity[] } = { identities: [] };

export const setIdentities = (accounts: readonly string[]): IIdentity[] => {
  state.identities = accounts.map((address) => ({
    name: address.toLowerCase(),
    ens: null,
    active: true,
  }));
  return state.identities;
};

export const getIdentities = (): IIdentity[] => state.identities;

let config: Config | null = null;

// Build the wagmi config once, on first `init`. EIP-6963 multi-injected
// discovery surfaces browser wallets (MetaMask, Rabby, …) as connectors
// automatically; the non-injected transports (Coinbase, WalletConnect) are
// added explicitly. WalletConnect is only included when a project id is given.
// The app only connects + signs — there are no on-chain reads here (balance
// gating is enforced server-side) — so a public HTTP transport is enough and
// no RPC key is needed in the browser.
export function ensureConfig(opts: {
  walletConnectProjectId?: string;
  appName?: string;
}): Config {
  if (config) return config;

  const connectors: CreateConnectorFn[] = [
    coinbaseWallet({ appName: opts.appName || "Cryptoverse Login" }),
  ];
  if (opts.walletConnectProjectId) {
    connectors.push(
      walletConnect({
        projectId: opts.walletConnectProjectId,
        showQrModal: true,
      })
    );
  }

  config = createConfig({
    chains: [mainnet],
    transports: { [mainnet.id]: http() },
    connectors,
    multiInjectedProviderDiscovery: true,
  });

  // Keep identities in sync when the wallet switches accounts.
  watchAccount(config, {
    onChange(account) {
      if (account.addresses && account.addresses.length) {
        setIdentities(account.addresses as readonly string[]);
      }
    },
  });

  return config;
}

export function getConfig(): Config {
  if (!config) throw new Error("wagmi config not initialised; call init first");
  return config;
}

export const listWallets = (cfg: Config): TWalletInfo[] =>
  getConnectors(cfg).map((c: Connector) => ({
    id: c.uid,
    name: c.name,
    logo: connectorIcon(c),
  }));

export const findConnector = (cfg: Config, id: string): Connector | undefined =>
  getConnectors(cfg).find((c: Connector) => c.uid === id);
