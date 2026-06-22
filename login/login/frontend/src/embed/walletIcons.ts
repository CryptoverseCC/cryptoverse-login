import type { Connector } from "@wagmi/core";

// EIP-6963 injected wallets advertise their own icon, but the explicitly-added
// connectors (Coinbase, WalletConnect) often don't expose one — so supply brand
// marks as a fallback so every tile has a recognizable icon.
const dataUri = (svg: string) =>
  `data:image/svg+xml,${encodeURIComponent(svg)}`;

const COINBASE = dataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
    `<rect width="1024" height="1024" fill="#0052FF"/>` +
    `<circle cx="512" cy="512" r="282" fill="#fff"/>` +
    `<rect x="396" y="396" width="232" height="232" rx="56" fill="#0052FF"/></svg>`
);

const WALLETCONNECT = dataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
    `<rect width="512" height="512" rx="128" fill="#3396FF"/>` +
    `<path fill="#fff" d="M169 198c48-47 126-47 174 0l6 6a6 6 0 0 1 0 8l-20 20a3 3 0 0 1-4 0l-8-8c-34-33-88-33-122 0` +
    `l-9 8a3 3 0 0 1-4 0l-20-20a6 6 0 0 1 0-8zm215 40 18 18a6 6 0 0 1 0 8l-81 80a9 9 0 0 1-12 0l-58-56a1 1 0 0 0-2 0` +
    `l-57 56a9 9 0 0 1-12 0l-81-80a6 6 0 0 1 0-8l18-18a9 9 0 0 1 12 0l58 56a1 1 0 0 0 2 0l57-56a9 9 0 0 1 12 0l58 56` +
    `a1 1 0 0 0 2 0l57-56a9 9 0 0 1 12 0z"/></svg>`
);

const BY_KEY: Record<string, string> = {
  coinbaseWallet: COINBASE,
  coinbaseWalletSDK: COINBASE,
  walletConnect: WALLETCONNECT,
};

export function connectorIcon(connector: Connector): string | undefined {
  const own = (connector as Connector & { icon?: string }).icon;
  if (own) return own;
  return BY_KEY[connector.type] ?? BY_KEY[connector.id];
}
