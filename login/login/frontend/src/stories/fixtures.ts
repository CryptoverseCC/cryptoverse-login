import {
  IIdentity,
  TLoginData,
  TRestrictions,
  TWalletInfo,
} from "../services/loginProvider";

const icon = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

const FOX = icon(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="#f6851b"/>` +
    `<path d="M32 12 18 22l5 12 9 6 9-6 5-12z" fill="#fff"/></svg>`
);
const COINBASE = icon(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="#0052FF"/>` +
    `<circle cx="32" cy="32" r="18" fill="#fff"/>` +
    `<rect x="25" y="25" width="14" height="14" rx="3" fill="#0052FF"/></svg>`
);
const WALLETCONNECT = icon(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="#3396FF"/>` +
    `<path d="M20 27c7-7 17-7 24 0l1 1-3 3-1-1c-5-5-13-5-18 0l-1 1-3-3z" fill="#fff"/></svg>`
);

// --- wallets (TWalletInfo) ----------------------------------------------------
export const walletMetaMask: TWalletInfo = {
  id: "io.metamask",
  name: "MetaMask",
  logo: FOX,
};
export const walletCoinbase: TWalletInfo = {
  id: "coinbaseWallet",
  name: "Coinbase Wallet",
  logo: COINBASE,
};
export const walletWalletConnect: TWalletInfo = {
  id: "walletConnect",
  name: "WalletConnect",
  logo: WALLETCONNECT,
};
// A connector that advertises no icon — exercises the fallback wallet glyph.
export const walletNoLogo: TWalletInfo = {
  id: "com.unknown.wallet",
  name: "Unbranded Wallet",
};
export const walletLongName: TWalletInfo = {
  id: "com.long",
  name: "A Wallet With An Unusually Long Display Name",
};

export const wallets: TWalletInfo[] = [
  walletMetaMask,
  walletCoinbase,
  walletWalletConnect,
  walletNoLogo,
];

// A second injected wallet that "announces" (EIP-6963) only after init — used to
// exercise the live wallet-list-update path (the embed re-pushes the list via
// the `onWalletsChanged` Comlink callback when a connector arrives).
export const walletRabby: TWalletInfo = {
  id: "io.rabby",
  name: "Rabby Wallet",
  logo: FOX,
};

// The "Browser Wallet" tile the generic injected() fallback maps to when NO
// EIP-6963 wallet was discovered (single-`window.ethereum` environments).
export const walletBrowserFallback: TWalletInfo = {
  id: "injected",
  name: "Browser Wallet",
};

// The list after a late EIP-6963 announcement (Rabby joins). The live-update
// callback pushes this once a connector arrives post-init.
export const walletsAfterDiscovery: TWalletInfo[] = [...wallets, walletRabby];

// --- identities (IIdentity) ---------------------------------------------------
export const identityActive: IIdentity = {
  name: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  ens: null,
  active: true,
};
export const identityInactive: IIdentity = {
  name: "0xab5801a7d398351b8be11c439e05c5b3259aec9b",
  ens: null,
  active: false,
};
export const identityEns: IIdentity = {
  name: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  ens: "vitalik.eth",
  active: true,
};
export const identities: IIdentity[] = [identityActive, identityEns];

// --- restrictions (TRestrictions) ---------------------------------------------
export const restrictionWithMessage: TRestrictions = [
  {
    tokenAddress: "0x35bD01FC9d6D5D81CA9E055Db88Dc49aa2c699A8",
    condition: "balanceOf >= 75",
    message: "You need at least 75 FWB tokens to log in to this app.",
  },
];
export const restrictionNoMessage: TRestrictions = [
  {
    tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    condition: "balanceOf > 0",
  },
];
export const restrictionsMultiple: TRestrictions = [
  ...restrictionWithMessage,
  ...restrictionNoMessage,
];

// --- login data (TLoginData) --------------------------------------------------
export const loginData: TLoginData = {
  siwe: {
    domain: "login.example.com",
    uri: "https://login.example.com/login",
    statement: "Sign in to Cryptoverse Login",
    version: "1",
    chainId: 1,
    nonce: "a1b2c3d4e5f60718",
    expirationMinutes: 10,
  },
  challenge: "story-challenge",
  sourceId: "default",
  clientId: "demo-client",
  metadata: { app: "demo.app", restrictions: [] },
  restrictions: [],
  walletConnectProjectId: "",
};
