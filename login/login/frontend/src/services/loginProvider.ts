import * as Comlink from "comlink";

export type TProviderName = string;
export type TEthereumAddress = string;
export type TTokenAddress = string;
export type TSignature = string;
export type TChallenge = string;
export type TSourceId = string;
export type TClientId = string;
export type TAppName = string;

export type TCondition = string;
export type TMessage = string;

// EIP-4361 (Sign-In with Ethereum) parameters supplied by the backend in
// `loginData.siwe`. The frontend assembles the canonical message from these.
export type TSiweParams = {
  domain: string;
  uri: string;
  statement: string;
  version: string;
  chainId: number;
  nonce: string;
  expirationMinutes: number;
};

export type TRestriction = {
  tokenAddress: TTokenAddress;
  condition: TCondition;
  message?: TMessage;
};

export type TRestrictions = TRestriction[];

export type TMetadata = {
  app: TAppName;
  restrictions: TRestrictions;
};

export type TLoginData = {
  siwe: TSiweParams;
  challenge: TChallenge;
  sourceId: TSourceId;
  clientId: TClientId;
  restrictions?: TRestrictions;
  metadata?: TMetadata;
  // WalletConnect Cloud / Reown project id, injected by the backend (empty when
  // unset — the WalletConnect connector is then omitted and injected wallets
  // still work). Kept here so the IdP stays deployment-agnostic (no hardcoded key).
  walletConnectProjectId?: string;
};

// Login data is rendered by the backend into a `<script type="application/json"
// id="login-data">` block in index.html; parse it here. NB: only the iframe
// (the React app) carries this block — the top-window embed receives what it
// needs (e.g. the WalletConnect project id) over Comlink via `init`.
const loginDataElement =
  typeof document !== "undefined" ? document.getElementById("login-data") : null;
export const loginData = JSON.parse(
  loginDataElement?.textContent || "{}"
) as TLoginData;

export interface IIdentity {
  name: string;
  ens: string | null;
  active: boolean;
}

// A wallet the user can connect with. Derived from a wagmi connector
// (EIP-6963-discovered injected wallets, WalletConnect, Coinbase). `id` is the
// connector's runtime uid; `logo` is its icon when the wallet advertises one.
export type TWalletInfo = {
  id: string;
  name: TProviderName;
  logo?: string;
};

// Pushed by the embed (top window) over Comlink whenever the live connector set
// changes — EIP-6963 wallets announce asynchronously, so the list can grow (or
// shrink) after the initial snapshot. The iframe passes this as a
// `Comlink.proxy`'d function so the embed can invoke it across the boundary.
export type TWalletsChangedCallback = (wallets: TWalletInfo[]) => void;

export type TInitRequest = {
  walletConnectProjectId?: string;
  appName?: string;
  // Optional live-update channel. When supplied, the embed keeps watching the
  // connector set and re-pushes the wallet list as it changes. When omitted, the
  // embed returns a single settled snapshot instead (backward-safe).
  onWalletsChanged?: TWalletsChangedCallback;
};

export type TInitResponse = {
  wallets: TWalletInfo[];
};

export type TConnectRequest = {
  id: string;
};

export type TConnectResponse = {
  identities: IIdentity[];
  // Human-readable reason when a connection couldn't complete (rejected,
  // already-pending, etc.) so the UI can show it instead of failing silently.
  error?: string;
};

export type TIdentitiesRequest = {};

export type TIdentitiesResponse = {
  identities: IIdentity[];
} | null;

export type TLoginResponse = {
  // The full EIP-4361 message that was signed, posted to the backend for
  // verification (which re-derives the expected nonce from the challenge).
  message: TMessage;
  signature: TSignature;
  challenge: TChallenge;
  address: TEthereumAddress;
} | null;

export type TLoginRequest = {
  address: TEthereumAddress;
};

export type TInnerLoginRequest = {
  address: TEthereumAddress;
  siwe: TSiweParams;
  challenge: TChallenge;
};

export interface IProvider {
  init: (request: TInitRequest) => Promise<TInitResponse>;
  connect: (request: TConnectRequest) => Promise<TConnectResponse>;
  identities: (request: TIdentitiesRequest) => Promise<TIdentitiesResponse>;
  login: (request: TInnerLoginRequest) => Promise<TLoginResponse>;
  redirect: (url: string) => void;
}

interface CommunicationChannel {
  loginProvider: Comlink.Remote<IProvider> | IProvider;
}

let channel = {
  loginProvider: Comlink.wrap(Comlink.windowEndpoint(window.parent)),
} as CommunicationChannel;

function init(request: TInitRequest) {
  // The embed lives in a separate top-window page without the login-data block,
  // so hand it the request-derived config it needs to build the wagmi config.
  // If the caller (the React app) supplied an `onWalletsChanged` callback, wrap
  // it with `Comlink.proxy` so the top-window embed can invoke it across the
  // iframe boundary as connectors are discovered / removed.
  const onWalletsChanged = request.onWalletsChanged
    ? Comlink.proxy(request.onWalletsChanged)
    : undefined;
  return channel.loginProvider.init({
    walletConnectProjectId: loginData.walletConnectProjectId,
    appName: loginData.metadata?.app,
    onWalletsChanged,
  });
}

function connect(request: TConnectRequest) {
  return channel.loginProvider.connect(request);
}

function identities(request: TIdentitiesRequest) {
  return channel.loginProvider.identities(request);
}

function login(request: TLoginRequest) {
  return channel.loginProvider.login({
    address: request.address,
    siwe: loginData.siwe,
    challenge: loginData.challenge,
  });
}

export interface ILoginProvider {
  loginData: TLoginData;
  init: (request: TInitRequest) => Promise<TInitResponse>;
  connect: (request: TConnectRequest) => Promise<TConnectResponse>;
  login: (request: TLoginRequest) => Promise<TLoginResponse>;
  identities: (request: TIdentitiesRequest) => Promise<TIdentitiesResponse>;
}

export function LoginProvider(
  _channel: CommunicationChannel | null
): ILoginProvider {
  return {
    loginData: loginData,
    init: init,
    connect: connect,
    login: login,
    identities: identities,
  };
}
