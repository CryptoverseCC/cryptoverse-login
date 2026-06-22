import {
  test as base,
  expect,
  type BrowserContext,
} from "@playwright/test";
import dappwright, {
  type Dappwright,
  MetaMaskWallet,
  CoinbaseWallet,
} from "@tenkeylabs/dappwright";
import { SEED_PHRASE, WALLET_PASSWORD } from "./wallet.js";

/**
 * dappwright Playwright fixtures, shared by the MetaMask and Coinbase specs.
 *
 * dappwright `bootstrap()`s a HEADED Chromium with the chosen wallet extension
 * installed and the fixed seed imported, then hands back a `Dappwright` driver
 * (`.approve()`, `.sign()`, `.confirmTransaction()`, …) plus the persistent
 * `BrowserContext`. We expose:
 *   - `wallet`  — the Dappwright driver for the active wallet
 *   - `context` — the wallet's persistent browser context
 *   - `page`    — a fresh page in that context to drive the demo RP
 *
 * Two ready-made fixtures (`metamaskTest`, `coinbaseTest`) select the wallet.
 * Both require a real X display — wrap runs in `xvfb-run` on Linux/CI. dappwright
 * does NOT support headless (Chromium can't load extensions headless).
 */

type WalletId = "metamask" | "coinbase";

interface WalletFixtures {
  wallet: Dappwright;
}

interface WorkerFixtures {
  walletContext: BrowserContext;
}

function makeTest(walletId: WalletId, version: string) {
  return base.extend<WalletFixtures, WorkerFixtures>({
    // One persistent context per worker: the extension is installed + seeded
    // once, not per test (bootstrap is expensive).
    walletContext: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        const [, , context] = await dappwright.bootstrap("", {
          wallet: walletId,
          version,
          seed: SEED_PHRASE,
          password: WALLET_PASSWORD,
          headless: false, // extensions require headed Chromium (+ xvfb on CI)
        });
        await use(context);
        await context.close();
      },
      { scope: "worker" },
    ],

    // Bind Playwright's default `context` to the wallet's persistent context so
    // `page` (and baseURL navigation) run inside the extension-enabled browser.
    context: async ({ walletContext }, use) => {
      await use(walletContext);
    },

    wallet: async ({ walletContext }, use) => {
      const wallet = await dappwright.getWallet(walletId, walletContext);
      await use(wallet);
    },
  });
}

/** Playwright `test` wired to a seeded MetaMask extension. */
export const metamaskTest = makeTest(
  "metamask",
  MetaMaskWallet.recommendedVersion,
);

/** Playwright `test` wired to a seeded Coinbase Wallet extension. */
export const coinbaseTest = makeTest(
  "coinbase",
  CoinbaseWallet.recommendedVersion,
);

export { expect };
