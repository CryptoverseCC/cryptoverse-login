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

// --- iframe<->parent startup handshake (see embed/index.ts) -----------------
// Comlink does NOT buffer messages posted before the remote attaches its
// listener. If this iframe's first `init()` postMessage reaches the parent
// before the parent's `Comlink.expose` listener exists, that message is
// silently dropped and `init()` would never resolve — the user then hits the
// 60s hang guard ("We couldn't load your wallets"). We make startup race-free
// from BOTH orderings:
//   - The parent posts an `embed-ready` ping once its `Comlink.expose` listener
//     is attached (on every iframe load). We wait for that ping before the FIRST
//     `init()`, so the call can't be dropped — there is then exactly one
//     in-flight Comlink call (no stacked/dangling retries in the common case).
//   - For the SYMMETRIC race (the parent posted `embed-ready` before this iframe
//     attached its listener, so we missed it) we post a `hello`; the parent
//     re-posts `embed-ready` on receiving it.
//   - As a final backstop against a fully-lost handshake, if no `embed-ready`
//     arrives within a short window we proceed to call `init()` anyway and, if
//     that call itself doesn't settle, re-issue it on an interval until the
//     parent answers — bounded by a total budget (the App's HANG_MS guard is
//     the outer backstop and surfaces the error if even this budget is spent).
const HANDSHAKE_READY = "embed-ready";
const HANDSHAKE_HELLO = "hello";
type HandshakeMessage = { __cryptoverse?: string };
// If no `embed-ready` lands this fast, proceed to call init() anyway (the
// retry loop below then recovers a dropped first call).
const READY_WAIT_MS = 1500;
// Re-issue init() this often if a call hasn't settled (dropped message path).
const INIT_RETRY_MS = 250;
// Upper bound on the whole handshake. Comfortably under App.tsx's HANG_MS (60s)
// so this rejects (App shows the terminal error) rather than racing the guard.
const INIT_TOTAL_BUDGET_MS = 30 * 1000;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Resolve as soon as the parent's `embed-ready` ping arrives, or after
// READY_WAIT_MS, whichever comes first. Posts a `hello` so a parent that came up
// first re-sends `embed-ready` (covers the symmetric, listener-attached-late
// race). Self-cleans its listener/timer so nothing dangles.
function waitForEmbedReady(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      resolve();
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as HandshakeMessage | null;
      if (data && data.__cryptoverse === HANDSHAKE_READY) finish();
    };
    window.addEventListener("message", onMessage);
    const timer = window.setTimeout(finish, READY_WAIT_MS);
    // Nudge the parent in case its `embed-ready` was posted before this listener
    // existed; harmless if the parent isn't up yet (init() retry still recovers).
    window.parent?.postMessage({ __cryptoverse: HANDSHAKE_HELLO }, "*");
  });
}

// Sentinel marking "this attempt's retry tick fired" vs a real init() response.
// A unique object reference can't collide with any TInitResponse the parent
// could return.
const RETRY_TICK = Symbol("retry-tick");

async function init(request: TInitRequest): Promise<TInitResponse> {
  // The embed lives in a separate top-window page without the login-data block,
  // so hand it the request-derived config it needs to build the wagmi config.
  const payload = {
    walletConnectProjectId: loginData.walletConnectProjectId,
    appName: loginData.metadata?.app,
  };

  // The live-update callback is a FUNCTION, so it must cross the iframe boundary
  // as a `Comlink.proxy` (Comlink sets up a MessageChannel for it). CRUCIAL:
  // Comlink only recognises a proxy when it is a TOP-LEVEL argument — it does
  // NOT recurse into object properties, so a proxy nested inside `payload`
  // (`{ onWalletsChanged: Comlink.proxy(fn) }`) is structured-cloned instead and
  // throws `DataCloneError: ...could not be cloned`, which surfaced to the user
  // as "We couldn't load your wallets". We therefore pass the proxied callback
  // as its OWN positional argument. `IProvider.init`'s public type is unchanged
  // (`(request) => ...`); the embed's `init` reads this optional 2nd arg and the
  // `onWalletsChanged` field of `TInitRequest`/`payload` is intentionally unused
  // on the wire.
  const onWalletsChanged = request.onWalletsChanged
    ? Comlink.proxy(request.onWalletsChanged)
    : undefined;

  // The remote `init` accepts (request, onWalletsChanged?); cast through the
  // Comlink Remote whose declared arity is 1.
  const remoteInit = channel.loginProvider.init as unknown as (
    req: typeof payload,
    cb?: TWalletsChangedCallback
  ) => Promise<TInitResponse>;

  // 1. Make sure the parent is listening before the first call (common path:
  //    exactly one Comlink call, no stacked retries).
  await waitForEmbedReady();

  // 2. Issue init(); if a call doesn't settle within INIT_RETRY_MS (a dropped
  //    message, e.g. the ready ping was lost), re-issue until one resolves or the
  //    budget is spent. Abandoned attempts are bounded by the budget/interval.
  const deadline = Date.now() + INIT_TOTAL_BUDGET_MS;
  for (;;) {
    const result = await Promise.race([
      remoteInit(payload, onWalletsChanged),
      wait(INIT_RETRY_MS).then(() => RETRY_TICK),
    ]);
    if (result !== RETRY_TICK) return result as TInitResponse;
    if (Date.now() >= deadline) {
      throw new Error("embed init handshake timed out");
    }
    // Re-nudge before retrying so a parent that only just came up re-sends ready
    // and is guaranteed to be exposing before the next call.
    window.parent?.postMessage({ __cryptoverse: HANDSHAKE_HELLO }, "*");
  }
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
