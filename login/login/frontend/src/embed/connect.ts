import {
  connect as wagmiConnect,
  disconnect,
  getAccount,
} from "@wagmi/core";
import { TConnectRequest, TConnectResponse } from "../services/loginProvider";
import {
  Window,
  getConfig,
  findConnector,
  setIdentities,
  getIdentities,
} from "./utils";

// Map wallet/RPC errors to something a user can act on.
function humanize(error: unknown): string {
  const e = error as { code?: number; name?: string; cause?: { code?: number } };
  const code = e?.code ?? e?.cause?.code;
  if (code === 4001 || e?.name === "UserRejectedRequestError") {
    return "Connection request rejected in your wallet.";
  }
  if (code === -32002) {
    return "A connection request is already pending — open your wallet to approve it.";
  }
  return "Couldn't connect to the wallet. Please try again.";
}

// A single connect can be in flight at a time (a wallet only handles one
// `eth_requestAccounts` prompt). A second click while one is pending must not
// fire another request — that's what produced the silent -32002 in the console.
let inflight: Promise<TConnectResponse> | null = null;

export const connect = async ({
  id,
}: TConnectRequest): Promise<TConnectResponse> => {
  const sentry = (window as unknown as Window).Sentry;

  if (inflight) {
    return {
      identities: getIdentities(),
      error: "A wallet request is already in progress — check your wallet.",
    };
  }

  const config = getConfig();
  const connector = findConnector(config, id);
  if (!connector) {
    return { identities: [], error: "That wallet is no longer available." };
  }

  inflight = (async (): Promise<TConnectResponse> => {
    try {
      // A lingering connection makes wagmi throw "already connected"; drop it so
      // re-selecting a wallet (or switching wallets) starts a clean request.
      if (getAccount(config).isConnected) {
        await disconnect(config).catch(() => {});
      }
      const result = await wagmiConnect(config, { connector });
      return { identities: setIdentities(result.accounts) };
    } catch (error) {
      sentry?.captureException?.(error);
      return { identities: [], error: humanize(error) };
    }
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
};
