import { getConnectors, watchConnectors } from "@wagmi/core";
import {
  TInitRequest,
  TInitResponse,
  TWalletsChangedCallback,
} from "../services/loginProvider";
import { ensureConfig, listWallets, Window } from "./utils";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Module-level guard for the single `watchConnectors` subscription, mirroring
// the `ensureConfig` memoization in utils.ts (`if (config) return config`). A
// re-mount / retry / React StrictMode double-invoke can call `init` more than
// once; without this guard each call would stack another subscription and fire
// the Comlink callback multiple times per connector change. We register the
// subscription at most once and just swap the stored callback on later calls.
let watching = false;
let onChangeCallback: (() => void) | null = null;

// Build the wagmi config (using the request-derived WalletConnect project id /
// app name from the iframe) and list the wallets the user can connect with.
//
// EIP-6963 wallets announce themselves asynchronously, so the connector set is
// not stable at the moment `init` runs. Rather than a fixed wait-then-snapshot
// (which loses any wallet that announces late), we:
//   1. return an immediate snapshot for the first render, and
//   2. if the iframe gave us a live-update callback (`onWalletsChanged`), keep a
//      `watchConnectors` subscription open and re-push the wallet list each time
//      the connector set changes (a wallet announces / is removed).
// If no callback was supplied we fall back to a single settled snapshot — the
// old behaviour — so the path stays backward-safe.
// The live-update callback arrives as a SEPARATE positional argument (a
// top-level `Comlink.proxy`), not nested in `request` — Comlink can only
// transfer a proxy at the top level (see services/loginProvider.ts::init).
// `request.onWalletsChanged` is kept in the type for the call site but is no
// longer the wire channel; we read the 2nd arg, falling back to the field for
// safety.
export const init = async (
  request: TInitRequest,
  onWalletsChangedArg?: TWalletsChangedCallback
): Promise<TInitResponse> => {
  const sentry = (window as unknown as Window).Sentry;
  try {
    const config = ensureConfig({
      walletConnectProjectId: request.walletConnectProjectId,
      appName: request.appName,
    });

    // Diagnostic: dump the raw connector set once so "only MetaMask appears"
    // (Coinbase missing, no injected fallback, …) is diagnosable from the
    // console. Coinbase should ALWAYS be present here.
    console.info(
      "[cryptoverse] connectors:",
      getConnectors(config).map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
      }))
    );

    const onWalletsChanged = onWalletsChangedArg ?? request.onWalletsChanged;

    if (onWalletsChanged) {
      // Live mode: push the current list now, then keep pushing as connectors
      // arrive/leave. The subscription's `onChange` invokes the *latest* stored
      // callback, so a repeat `init` only swaps `onChangeCallback` rather than
      // registering a second `watchConnectors` subscription.
      onChangeCallback = () => {
        try {
          onWalletsChanged(listWallets(config));
        } catch (err) {
          sentry?.captureException?.(err);
        }
      };
      if (!watching) {
        // `watchConnectors` returns an unsubscribe fn; we keep the subscription
        // for the lifetime of the page (the embed is the top window and lives
        // until redirect), so there's nothing to tear down here.
        watchConnectors(config, {
          onChange() {
            onChangeCallback?.();
          },
        });
        watching = true;
      }
      return { wallets: listWallets(config) };
    }

    // Backward-safe fallback: no live channel, so give EIP-6963 wallets a brief
    // window to announce before taking a single snapshot.
    await wait(350);
    return { wallets: listWallets(config) };
  } catch (error) {
    sentry?.captureException(error);
    return { wallets: [] };
  }
};
