import { metamaskTest as test } from "../fixtures/dappwright.js";
import { runLoginAndAssertClaims } from "../fixtures/loginFlow.js";
import type { WalletDriver } from "../fixtures/loginFlow.js";

/**
 * MetaMask extension e2e: demo RP -> Sign-In-with-Ethereum -> back to the demo,
 * asserting the issued ID-token claims for the seeded account.
 *
 * Prerequisites (see README): a kind cluster up (`tests/kind/setup.sh`) and a
 * real X display (`xvfb-run` on Linux/CI). Run:
 *   xvfb-run --auto-servernum yarn test:e2e:metamask
 */
test.describe("MetaMask SIWE login", () => {
  test("logs in and the demo shows the expected ID-token claims", async ({
    page,
    wallet,
  }) => {
    const driver: WalletDriver = {
      // EIP-6963 announces MetaMask as "MetaMask"; the picker tile is
      // `Connect with MetaMask`.
      pickerName: "MetaMask",
      // dappwright `.approve()` clicks through MetaMask's connect popup
      // (Next -> Connect in older UIs, a single Connect in newer ones).
      approveConnect: () => wallet.approve(),
      // `.sign()` approves the personal_sign (SIWE) popup.
      approveSign: () => wallet.sign(),
    };

    await runLoginAndAssertClaims({ page, driver });
  });
});
