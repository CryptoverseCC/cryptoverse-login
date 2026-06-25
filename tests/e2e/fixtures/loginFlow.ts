import { expect, type Page, type FrameLocator } from "@playwright/test";
import {
  ACCOUNT_ADDRESS,
  assertSubset,
  expectedIdToken,
} from "./wallet.js";

/**
 * Drives the demo relying party through the full Sign-In-with-Ethereum flow and
 * asserts the issued ID-token claims. The wallet-specific steps (approving the
 * connect popup, signing the SIWE message, and — for WalletConnect — supplying a
 * pairing URI) are injected as callbacks, so MetaMask, Coinbase and the headless
 * WC test wallet all reuse this one flow.
 *
 * Selectors are derived from the current product code, NOT the retired Selenium
 * suite (the UI was redesigned). Where a selector depends on live DOM that this
 * harness can't execute against here, it is flagged "VERIFY AGAINST LIVE APP".
 *
 *  - demo home button text: `Login with Ethereum Wallet`
 *      (tests/cryptoverse-login-demo/.../templates/demo/home.html)
 *  - wallet picker tiles live INSIDE an iframe (`//body/iframe`, historically),
 *    each a button with aria-label `Connect with <name>`
 *      (login/login/frontend/src/components/Wallet.tsx). The old intermediate
 *    "Ethereum Wallet" step is GONE in the redesigned UI.
 *  - identity card (after connect): aria-label `Sign in with <ens-or-short>`
 *    where <short> is a TRUNCATED address (e.g. 0xae89…a94b), so we click the
 *    sole active identity rather than matching the full address
 *      (login/login/frontend/src/components/Identity.tsx).
 *  - demo success page: <title>Cryptoverse Login - Demo - Success</title>,
 *    <span>{address}</span>, <pre class="data">{pretty JSON id_token}</pre>
 *      (tests/cryptoverse-login-demo/.../templates/demo/protected.html)
 */

/** Locate the login iframe that hosts the React wallet picker. */
function loginFrame(page: Page): FrameLocator {
  // The wrapper renders the top-level embed page with a single <iframe> at
  // /oauth2/inner -> Hydra authorize -> /login. Historically `//body/iframe`.
  // VERIFY AGAINST LIVE APP if the wrapper template changes its iframe nesting.
  return page.frameLocator("iframe").first();
}

export interface WalletDriver {
  /** Human label used in logs / the picker tile (e.g. "MetaMask"). */
  pickerName: string;
  /**
   * Approve the wallet's connection popup. Called after the user clicks the
   * wallet tile and the dapp fires `eth_requestAccounts`.
   */
  approveConnect(): Promise<void>;
  /**
   * Approve the wallet's `personal_sign` (SIWE) popup. Called after the user
   * clicks their identity card and the dapp fires `personal_sign`.
   */
  approveSign(): Promise<void>;
  /**
   * Optional hook fired immediately after the wallet tile is clicked, before
   * `approveConnect`. The WalletConnect driver uses it to scrape the `wc:` URI
   * from the QR modal and hand it to the headless test wallet.
   */
  onWalletSelected?(page: Page): Promise<void>;
}

export interface RunLoginOptions {
  page: Page;
  driver: WalletDriver;
  /** Expected subject address (defaults to the seed's account 0). */
  address?: string;
  /** Override the demo RP base URL (defaults to Playwright's baseURL "/"). */
  demoPath?: string;
}

/**
 * Run the end-to-end login and return the parsed ID token from the demo's
 * success page.
 */
export async function runLogin({
  page,
  driver,
  address = ACCOUNT_ADDRESS,
  demoPath = "/",
}: RunLoginOptions): Promise<Record<string, unknown>> {
  // 1. Demo home -> click "Login with Ethereum Wallet".
  await page.goto(demoPath);
  await page.getByText("Login with Ethereum Wallet").click();

  // 2. We're now on the IdP, inside the login iframe. The redesigned UI shows a
  //    landing screen first; click "Continue with a wallet" to reveal the picker.
  const frame = loginFrame(page);
  const cta = frame.getByRole("button", { name: "Continue with a wallet" });
  await expect(cta).toBeVisible();
  await cta.click();

  // Pick the wallet tile by its accessible name.
  const tile = frame.getByRole("button", {
    name: `Connect with ${driver.pickerName}`,
  });
  await expect(tile).toBeVisible();
  await tile.click();

  // 2a. WalletConnect: scrape the wc: URI now (the QR modal is in the TOP
  //     window) and pair the headless test wallet.
  if (driver.onWalletSelected) {
    await driver.onWalletSelected(page);
  }

  // 3. Approve the connection popup in the wallet.
  await driver.approveConnect();

  // 4. The iframe now lists the connected identity. Click the sole active card.
  const identity = frame.getByRole("button", { name: /^Sign in with / });
  await expect(identity.first()).toBeVisible();
  await identity.first().click();

  // 5. Approve the SIWE personal_sign popup in the wallet.
  await driver.approveSign();

  // 6. Redirect lands back on the demo success page. Assert title + subject.
  await page.waitForURL(/.*/, { timeout: 60_000 });
  await expect(page).toHaveTitle(/Cryptoverse Login - Demo - Success/, {
    timeout: 60_000,
  });
  await expect(
    page.locator("span", { hasText: address }).first(),
  ).toBeVisible();

  // 7. Parse the pretty-printed ID token JSON from <pre class="data">.
  const raw = await page.locator("pre.data").innerText();
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Run the login and assert the full expected claim set for `address`. */
export async function runLoginAndAssertClaims(
  opts: RunLoginOptions,
): Promise<void> {
  const idToken = await runLogin(opts);
  assertSubset(expectedIdToken(opts.address ?? ACCOUNT_ADDRESS), idToken);
}
