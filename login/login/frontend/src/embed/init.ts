import { TInitRequest, TInitResponse } from "../services/loginProvider";
import { ensureConfig, listWallets, Window } from "./utils";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Build the wagmi config (using the request-derived WalletConnect project id /
// app name from the iframe) and list the wallets the user can connect with.
// EIP-6963 wallets announce themselves asynchronously, so give them a brief
// window to arrive before snapshotting the connector list.
export const init = async (request: TInitRequest): Promise<TInitResponse> => {
  const sentry = (window as unknown as Window).Sentry;
  try {
    const config = ensureConfig({
      walletConnectProjectId: request.walletConnectProjectId,
      appName: request.appName,
    });
    await wait(350);
    return { wallets: listWallets(config) };
  } catch (error) {
    sentry?.captureException(error);
    return { wallets: [] };
  }
};
