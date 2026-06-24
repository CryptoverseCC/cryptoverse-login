import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the Cryptoverse Login browser/wallet e2e suite.
 *
 * Three projects, one per wallet connector the IdP exposes:
 *   - `metamask`  — drives the real MetaMask extension via dappwright
 *   - `coinbase`  — drives the real Coinbase Wallet extension via dappwright
 *   - `walletconnect` — drives the WC desktop-QR path with a headless
 *     @reown/walletkit "test wallet" (no extension; skips without a projectId)
 *
 * Extensions require HEADED Chromium (Chromium has no headless extension
 * support), so on Linux/CI you MUST wrap the run in xvfb:
 *
 *   xvfb-run --auto-servernum yarn test:e2e
 *
 * The kind stack serves TLS from a local mkcert CA, so `ignoreHTTPSErrors`
 * accepts the self-signed cert (the old Selenium suite used
 * `acceptInsecureCerts`). The dappwright launch context is created by
 * dappwright itself; the per-project use-options below apply to the pages
 * Playwright opens within it.
 */

// The demo relying party (the thing under test) and the IdP host. Defaults
// match `tests/kind/setup.sh` (host port 9443, nip.io domains). Override for a
// differently-exposed stack.
const DEMO_URL =
  process.env.DEMO_URL ?? "https://login-demo.cv.127.0.0.1.nip.io:9443";
const LOGIN_URL =
  process.env.LOGIN_URL ?? "https://login.cv.127.0.0.1.nip.io:9443";

// The WalletConnect project (Reown Cloud) id. Empty => the IdP omits the WC
// connector and the WC spec self-skips.
const WALLETCONNECT_PROJECT_ID =
  process.env.WALLETCONNECT_PROJECT_ID ?? "";

export default defineConfig({
  testDir: "./specs",
  // Extensions + wallet popups + on-chain-less SIWE round-trips are slow; give
  // each test generous headroom. Tune down once the cluster is proven local.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  // Wallet extensions share a single persistent browser context per worker, so
  // run serially — parallel workers would fight over the same extension state.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],

  use: {
    baseURL: DEMO_URL,
    // The kind cluster's mkcert CA is not in the system trust store inside CI;
    // accept it (parity with the old Selenium `acceptInsecureCerts`).
    ignoreHTTPSErrors: true,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      // Plain headless Chromium (NO wallet extension, NO xvfb, NO projectId).
      // Drives the demo -> IdP flow and asserts the wallet picker tiles render
      // — a regression guard for the Comlink iframe<->parent startup race
      // (see specs/picker-loads.spec.ts). Runnable anywhere headless.
      name: "picker",
      testMatch: /picker-loads\.spec\.ts/,
      use: {
        headless: true,
        // Belt-and-suspenders with the top-level `ignoreHTTPSErrors` for the
        // kind stack's self-signed mkcert TLS.
        launchOptions: { args: ["--ignore-certificate-errors"] },
      },
    },
    {
      name: "metamask",
      testMatch: /metamask\.spec\.ts/,
    },
    {
      name: "coinbase",
      testMatch: /coinbase\.spec\.ts/,
    },
    {
      name: "walletconnect",
      testMatch: /walletconnect\.spec\.ts/,
      // Surfaced to the spec via env; the spec test.skip()s if it's empty.
      metadata: { walletConnectProjectId: WALLETCONNECT_PROJECT_ID },
    },
  ],

  // Shared constants other modules read from the environment.
  metadata: {
    demoUrl: DEMO_URL,
    loginUrl: LOGIN_URL,
  },
});
