import { test, expect, type Page, type FrameLocator } from "@playwright/test";

/**
 * Regression test for the iframe<->parent wallet-list handshake
 * ("We couldn't load your wallets").
 *
 * The bug: when the React wallet picker mounts it calls Comlink `init()` on the
 * top window (the embed page that owns the wallet) to fetch the wallet list,
 * passing an `onWalletsChanged` live-update callback. That callback is a
 * FUNCTION, so it must cross the iframe boundary as a `Comlink.proxy`. The
 * un-fixed code passed it NESTED inside the request object
 * (`init({ onWalletsChanged: Comlink.proxy(fn) })`). Comlink only recognises a
 * proxy as a TOP-LEVEL argument — it does NOT recurse into object properties —
 * so the nested function was structured-cloned instead and threw
 * `DataCloneError: ...could not be cloned`. `init()` rejected, and the user saw
 * the terminal "We couldn't load your wallets" error. (A secondary startup race
 * — the parent attaching its Comlink listener after the iframe's first call — is
 * also closed by an explicit `embed-ready`/`hello` handshake.) The failure is
 * WALLET-INDEPENDENT and reproduces in plain headless Chromium with NO
 * extension.
 *
 * This test drives the real demo RP -> IdP flow in plain headless Chromium (no
 * MetaMask, no xvfb), enters the picker (clicking "Continue with a wallet" —
 * which is what MOUNTS the picker App and fires `init()`), and asserts that a
 * wallet TILE renders (i.e. `init()` resolved) and the error state does NOT
 * appear. On the un-fixed code `init()` rejects (DataCloneError) and the error
 * shows: the tile never appears, so the test FAILS. With the fix (the proxied
 * callback is passed as a top-level Comlink argument + the embed-ready
 * handshake) a tile renders and the test PASSES.
 *
 * Selectors:
 *  - demo home button text: `Login with Ethereum Wallet`
 *  - IdP picker entry: a button `Continue with a wallet` inside the login iframe
 *    (login/login/frontend/src/backgrounds/Default.tsx) which mounts the React
 *    picker App and triggers `init()`.
 *  - wallet tiles live INSIDE the login iframe, each a `role=button` with
 *    aria-label `Connect with <name>` (login/login/frontend/src/components/Wallet.tsx).
 *    The Coinbase connector is ALWAYS offered (embed/utils.ts), so a
 *    "Connect with Coinbase Wallet" tile must appear once init() resolves; the
 *    generic injected fallback ("Browser Wallet") may also appear. We match ANY
 *    `Connect with ` tile so the test is wallet-independent.
 *  - the failure surface is the StatusView error "We couldn't load your wallets"
 *    (App.tsx), which we assert does NOT appear.
 */

// The login iframe hosts the React picker (demo -> /oauth2/auth embed ->
// /oauth2/inner == Hydra authorize -> /login SPA). The single <iframe> navigates
// a few times; a FrameLocator re-resolves on each access (unlike a captured
// Frame handle, which detaches across navigation), so locators stay valid as the
// chain settles on the /login SPA.
function loginFrame(page: Page): FrameLocator {
  return page.frameLocator("iframe").first();
}

test.describe("wallet picker startup (Comlink handshake regression)", () => {
  test("renders a wallet tile (init() resolves, no 'couldn't load' error)", async ({
    page,
  }) => {
    // 1. Demo home -> click the login button -> redirect into the IdP.
    await page.goto("/");
    await page.getByText("Login with Ethereum Wallet").click();

    // 2. Inside the login iframe, click "Continue with a wallet". This is what
    //    MOUNTS the React picker App and fires the iframe->parent `init()` call —
    //    the path that exercises the bug. (The landing card renders even on
    //    un-fixed code; the picker App and its init() only start on this click.)
    const frame = loginFrame(page);
    const continueBtn = frame.locator(
      'button:has-text("Continue with a wallet")'
    );
    await expect(continueBtn).toBeVisible({ timeout: 20_000 });
    await continueBtn.click();

    // 3. Decisive assertion: a wallet TILE renders, i.e. `init()` RESOLVED with
    //    the wallet list (the Coinbase connector is always offered). On the
    //    un-fixed code `init()` rejects (the nested Comlink proxy DataCloneError)
    //    and the picker shows "We couldn't load your wallets" instead, so a tile
    //    NEVER appears and this times out — the regression is caught here. Sane
    //    window, well under the app's 60s HANG_MS.
    const tile = frame.locator('[aria-label^="Connect with "]').first();
    const errorState = frame.getByText(/couldn.t load your wallets/i);

    await expect(
      tile,
      "wallet picker tile never rendered — init() did not resolve (the " +
        "iframe<->parent wallet-list handshake regressed)"
    ).toBeVisible({ timeout: 25_000 });

    // 4. And the terminal "couldn't load your wallets" error must not be showing.
    await expect(errorState).toHaveCount(0);
  });
});
