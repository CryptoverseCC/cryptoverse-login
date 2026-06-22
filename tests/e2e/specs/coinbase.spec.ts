import { coinbaseTest as test } from "../fixtures/dappwright.js";
import { runLoginAndAssertClaims } from "../fixtures/loginFlow.js";
import type { WalletDriver } from "../fixtures/loginFlow.js";

/**
 * Coinbase Wallet extension e2e: demo RP -> Sign-In-with-Ethereum -> back to the
 * demo, asserting the issued ID-token claims for the seeded account.
 *
 * The IdP always offers a Coinbase connector (`embed/utils.ts`), so the picker
 * shows a "Coinbase Wallet" tile. dappwright drives the real Coinbase extension.
 *
 * Prerequisites (see README): a kind cluster up and a real X display.
 *   xvfb-run --auto-servernum yarn test:e2e:coinbase
 */
test.describe("Coinbase Wallet SIWE login", () => {
  test("logs in and the demo shows the expected ID-token claims", async ({
    page,
    wallet,
  }) => {
    const driver: WalletDriver = {
      // wagmi's coinbaseWallet connector names itself "Coinbase Wallet".
      // VERIFY AGAINST LIVE APP: confirm the exact tile label the picker renders
      // for the Coinbase connector (it comes from the connector's `.name`).
      pickerName: "Coinbase Wallet",
      approveConnect: () => wallet.approve(),
      approveSign: () => wallet.sign(),
    };

    await runLoginAndAssertClaims({ page, driver });
  });
});
