import {
  ILoginProvider,
  TConnectRequest,
  TInitRequest,
  TLoginRequest,
} from "../services/loginProvider";
import {
  identities,
  loginData,
  wallets,
  walletsAfterDiscovery,
} from "./fixtures";

// A canned ILoginProvider so the App / background stories render the full flow
// without the real Comlink-to-parent wallet bridge. Override any method to drive
// a specific edge case (e.g. a connect that returns an error).
export function makeMockLoginProvider(
  overrides: Partial<ILoginProvider> = {}
): ILoginProvider {
  return {
    loginData,
    // Mirrors the real embed: return an initial snapshot, and — when the caller
    // supplies the live-update callback — re-push an expanded list shortly after
    // to mimic an EIP-6963 wallet announcing late. The render test just asserts
    // it mounts; this also lets a story show the post-discovery state.
    init: async (req: TInitRequest) => {
      if (req.onWalletsChanged) {
        setTimeout(() => req.onWalletsChanged?.(walletsAfterDiscovery), 0);
      }
      return { wallets };
    },
    connect: async (_req: TConnectRequest) => ({ identities }),
    identities: async () => ({ identities }),
    login: async (_req: TLoginRequest) => ({
      message: "Sign-in message",
      signature: "0xsignature",
      challenge: loginData.challenge,
      address: identities[0].name,
    }),
    ...overrides,
  };
}
