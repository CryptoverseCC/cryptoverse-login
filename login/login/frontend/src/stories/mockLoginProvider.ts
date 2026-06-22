import {
  ILoginProvider,
  TConnectRequest,
  TInitRequest,
  TLoginRequest,
} from "../services/loginProvider";
import { identities, loginData, wallets } from "./fixtures";

// A canned ILoginProvider so the App / background stories render the full flow
// without the real Comlink-to-parent wallet bridge. Override any method to drive
// a specific edge case (e.g. a connect that returns an error).
export function makeMockLoginProvider(
  overrides: Partial<ILoginProvider> = {}
): ILoginProvider {
  return {
    loginData,
    init: async (_req: TInitRequest) => ({ wallets }),
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
