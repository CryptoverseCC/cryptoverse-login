import * as Comlink from "comlink";
import {
  IProvider,
  TIdentitiesRequest,
  TIdentitiesResponse,
} from "../services/loginProvider";
import { Window, getIdentities } from "./utils";
import { init } from "./init";
import { login } from "./login";
import { connect } from "./connect";

// Marker for the parent->iframe readiness ping and the iframe->parent greeting.
// Comlink does NOT buffer messages posted before the remote attaches its
// listener, so the two sides must perform an explicit handshake (see below).
const HANDSHAKE_READY = "embed-ready";
const HANDSHAKE_HELLO = "hello";
type HandshakeMessage = { __cryptoverse?: string };

// The iframe (#auth) is served from the SAME origin as this embed page (the IdP),
// so every cross-window message is pinned to that origin: we post the readiness
// ping to it and reject any `message` event whose origin differs. This keeps the
// exposed Comlink surface (notably `redirect`, which calls window.location.assign)
// reachable only from our own iframe, not an arbitrary framing page.
const IDP_ORIGIN =
  typeof window !== "undefined" ? window.location.origin : "";

// The embed is the TOP-WINDOW page (served by the wrapper's embed.html). It owns
// the wallet (a wallet provider must run top-level, not inside an iframe) and
// exposes init/connect/identities/login/redirect to the iframe over Comlink.
//
// STARTUP RACE (do not reintroduce): the iframe (#auth) makes a single Comlink
// `init()` call as soon as the React app mounts. Comlink does NOT buffer
// messages — if that `init()` postMessage reaches this window before
// `Comlink.expose` has attached its listener, the message is silently dropped
// and the iframe's `init()` never resolves (the user then hits the 60s hang
// guard: "We couldn't load your wallets"). Two things make the handshake
// race-free regardless of which side starts first:
//   1. Register `ifr.onload` SYNCHRONOUSLY during module eval (NOT behind a
//      setTimeout) so the handler exists before the iframe can finish loading.
//   2. On every load: `Comlink.expose` for the CURRENT contentWindow, then post
//      an `embed-ready` ping so the iframe knows the parent is now listening.
//      The iframe also retries `init()` and posts a `hello` on mount; we
//      re-post `embed-ready` whenever we receive a `hello`, so a ready ping that
//      was sent before the iframe attached its own listener still recovers.
// NOTE the iframe NAVIGATES more than once (/oauth2/inner -> Hydra authorize ->
// /login, the React SPA), so `onload` fires multiple times. We must re-expose
// against the FINAL /login document's contentWindow on each load — never bind
// once to a stale contentWindow.
(window as unknown as Window).ready = new Promise<void>((resolve, reject) => {
  try {
    // The iframe navigates several times (/oauth2/inner -> Hydra -> /login ->
    // /oauth2/final) and we re-`expose` on each load, so multiple Comlink
    // listeners accumulate on this top window and a single fire-and-forget
    // `redirect` message is serviced more than once. Guard so the RP callback is
    // hit EXACTLY once — a second navigation reuses the auth code and bounces the
    // user to the RP's error page.
    let redirected = false;
    const loginProvider: IProvider = {
      init,
      login,
      connect,
      identities: async (
        _request: TIdentitiesRequest
      ): Promise<TIdentitiesResponse> => {
        return { identities: getIdentities() };
      },
      redirect: (url) => {
        if (redirected) return;
        redirected = true;
        window.location.assign(url);
      },
    };

    const ifr = document.querySelector("#auth") as HTMLIFrameElement;

    // Post the readiness ping into the iframe's CURRENT document. Cheap and
    // idempotent, so it's safe to fire on every load and on every `hello`.
    const signalReady = () => {
      ifr.contentWindow?.postMessage(
        { __cryptoverse: HANDSHAKE_READY },
        IDP_ORIGIN
      );
    };

    ifr.onload = () => {
      // Re-expose against THIS document's window every time the iframe
      // navigates; binding once would leave us listening on a stale window
      // after the /oauth2/inner -> Hydra -> /login chain. Comlink.expose
      // attaches its own message listener, so the previous one is replaced for
      // the new endpoint and there is no double-handling. `allowedOrigins`
      // restricts which message origins Comlink will service, and the endpoint's
      // targetOrigin pins our replies — both to the IdP origin (the iframe).
      Comlink.expose(
        loginProvider,
        Comlink.windowEndpoint(ifr.contentWindow!, self, IDP_ORIGIN),
        [IDP_ORIGIN]
      );
      const loader = document.getElementById("loader") as HTMLElement | null;
      if (loader) loader.style.display = "none";
      signalReady();
    };

    ifr.onerror = (error) => {
      const sentry = (window as unknown as Window).Sentry;
      sentry?.captureException(error);
    };

    // Symmetric-race recovery: if the iframe attached its `embed-ready` listener
    // only AFTER we already posted the ping (so it missed it), the iframe posts
    // a `hello`; reply with a fresh `embed-ready`. (The iframe's `init()` retry
    // loop alone would also recover, but this makes the first attempt land.)
    window.addEventListener("message", (event: MessageEvent) => {
      // Only trust greetings from the IdP origin (our iframe).
      if (event.origin !== IDP_ORIGIN) return;
      const data = event.data as HandshakeMessage | null;
      if (data && data.__cryptoverse === HANDSHAKE_HELLO) {
        signalReady();
      }
    });
  } catch (error) {
    reject(error);
    return;
  }
  resolve();
});
