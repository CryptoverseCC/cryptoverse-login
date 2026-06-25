import {
  createConfig,
  http,
  getConnectors,
  watchAccount,
  type Config,
  type Connector,
  type CreateConnectorFn,
} from "@wagmi/core";
import {
  mainnet,
  base,
  optimism,
  arbitrum,
  polygon,
  sepolia,
  type Chain,
} from "@wagmi/core/chains";
import { coinbaseWallet, injected, walletConnect } from "@wagmi/connectors";
import { IIdentity, TWalletInfo } from "../services/loginProvider";
import { connectorIcon } from "./walletIcons";

// Map the backend-configured SIWE chain id to a viem chain object. Signing is a
// pure EIP-191 personal_sign — no RPC call is made in the browser (balance gating
// is server-side) — so a known-chain object is all wagmi needs; an unknown id
// falls back to mainnet. The id still ends up in the signed SIWE message
// (`Chain ID:`), so picking the right one keeps the signature on the right chain.
const CHAINS_BY_ID: Record<number, Chain> = {
  [mainnet.id]: mainnet, // 1
  [base.id]: base, // 8453
  [optimism.id]: optimism, // 10
  [arbitrum.id]: arbitrum, // 42161
  [polygon.id]: polygon, // 137
  [sepolia.id]: sepolia, // 11155111
};

export function chainForId(chainId?: number): Chain {
  return (chainId && CHAINS_BY_ID[chainId]) || mainnet;
}

// The wagmi id of the generic, EIP-6963-agnostic `injected()` connector. It
// talks to whatever `window.ethereum` is present without announcing an `rdns`.
// EIP-6963-discovered injected connectors instead carry `id === <rdns>` (wagmi
// builds them via `injected({ target: { id: info.rdns } })`) plus a populated
// `rdns`. We use this to dedupe the bare fallback against discovered wallets.
const GENERIC_INJECTED_ID = "injected";

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
// automatically; a generic `injected()` fallback covers wallets that expose
// `window.ethereum` without announcing (mobile dapp-browser WebViews); the
// non-injected transports (Coinbase, WalletConnect) are added explicitly.
// WalletConnect is only included when a project id is given.
// The app only connects + signs — there are no on-chain reads here (balance
// gating is enforced server-side) — so a public HTTP transport is enough and
// no RPC key is needed in the browser.
export function ensureConfig(opts: {
  walletConnectProjectId?: string;
  appName?: string;
  // The SIWE chain id threaded from the iframe (loginData.siwe.chainId). Selects
  // the viem chain the wagmi config is built on; defaults to mainnet if absent
  // or unknown. The config is built once, so the first init's chainId wins.
  chainId?: number;
}): Config {
  if (config) return config;

  const chain = chainForId(opts.chainId);

  const connectors: CreateConnectorFn[] = [
    // Coinbase Wallet is ALWAYS present (mobile + extension + Smart Wallet). We
    // deliberately keep Coinbase Smart Wallet enabled (no `preference: 'eoaOnly'`):
    // the backend gains ERC-1271/6492 verification this campaign, so smart-contract
    // wallet signatures are accepted. `'all'` is the wagmi default; we set it
    // explicitly to document the intent and guard against a future default flip.
    coinbaseWallet({
      appName: opts.appName || "Cryptoverse Login",
      preference: { options: "all" },
    }),
    // Generic injected fallback. EIP-6963 discovery (below) only catches wallets
    // that *announce* themselves; wallets that expose only `window.ethereum`
    // without an EIP-6963 announcement — notably mobile in-app dapp-browser
    // WebViews — would otherwise produce ZERO injected connectors. This bare
    // `injected()` connector ensures such a wallet is still selectable. It is
    // deduped against discovered wallets in `listWallets()` so it never shows up
    // as a second tile alongside an EIP-6963 wallet.
    injected(),
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
    chains: [chain],
    transports: { [chain.id]: http() },
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

// True for an EIP-6963-discovered injected connector. wagmi builds these via
// `injected({ target: { id: info.rdns } })`, so they carry a populated `rdns`
// (and `id === rdns`). The generic `injected()` fallback has neither.
const isDiscoveredInjected = (c: Connector): boolean =>
  Boolean((c as Connector & { rdns?: string | readonly string[] }).rdns);

// The mapped wallet list shown in the picker. Two concerns are handled here:
//
//  1. Dedupe the generic `injected()` fallback against EIP-6963-discovered
//     wallets. If at least one announced injected wallet exists, the bare
//     fallback is redundant (it would point at the same `window.ethereum`) and
//     is hidden so the user doesn't see a duplicate / ambiguous "Injected" tile.
//     When NO injected wallet was discovered, the fallback IS surfaced (relabeled
//     "Browser Wallet") so single-`window.ethereum` environments stay usable.
//  2. Dedupe discovered wallets among themselves by rdns/name, in case two
//     providers announce under the same identity.
export const listWallets = (cfg: Config): TWalletInfo[] => {
  const connectors = getConnectors(cfg);
  const hasDiscoveredInjected = connectors.some(isDiscoveredInjected);

  const seen = new Set<string>();
  const wallets: TWalletInfo[] = [];

  for (const c of connectors) {
    // Hide the generic injected fallback when a real injected wallet announced.
    if (c.id === GENERIC_INJECTED_ID && hasDiscoveredInjected) continue;

    // Relabel the bare fallback so the lone tile reads sensibly when shown.
    const name = c.id === GENERIC_INJECTED_ID ? "Browser Wallet" : c.name;

    // Dedup key: rdns (most stable, for discovered injected wallets) else name.
    const rdns = (c as Connector & { rdns?: string | readonly string[] }).rdns;
    const key = (
      typeof rdns === "string" && rdns ? rdns : name
    ).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    wallets.push({ id: c.uid, name, logo: connectorIcon(c) });
  }

  return wallets;
};

export const findConnector = (cfg: Config, id: string): Connector | undefined =>
  getConnectors(cfg).find((c: Connector) => c.uid === id);
