import { test, expect, chromium, type Page } from "@playwright/test";
import { runLoginAndAssertClaims } from "../fixtures/loginFlow.js";
import type { WalletDriver } from "../fixtures/loginFlow.js";
import { WalletConnectTestWallet } from "../wc-wallet/responder.js";
import { SEED_PHRASE } from "../fixtures/wallet.js";

/**
 * WalletConnect desktop-QR e2e: drive the IdP's WalletConnect connector with a
 * HEADLESS @reown/walletkit "test wallet" (no extension, no phone).
 *
 * Unlike the dappwright specs this needs NO browser extension, so it runs in a
 * plain (even headless) Chromium — but it DOES need a real Reown projectId
 * (`WALLETCONNECT_PROJECT_ID`), because both the IdP's WC connector and the test
 * wallet's WalletKit relay require one. Without it the IdP omits the WC connector
 * entirely (`embed/utils.ts`), so this spec self-skips.
 *
 * Flow: click the "WalletConnect" tile -> the IdP's QR modal (in the TOP window)
 * renders a `wc:` URI -> we scrape it -> hand it to the headless wallet, which
 * pairs, auto-approves the session, and auto-signs the SIWE personal_sign.
 */

const PROJECT_ID = process.env.WALLETCONNECT_PROJECT_ID ?? "";

/**
 * Scrape the `wc:` pairing URI from the IdP's WalletConnect QR modal.
 *
 * The WC connector here uses `showQrModal: true` (`embed/utils.ts`), so the
 * official WalletConnect modal web component renders in the TOP window. We try,
 * in order:
 *   1. read the clipboard after clicking the modal's "Copy" control, and
 *   2. read the `uri` off any rendered `<wui-qr-code uri="wc:...">` / element
 *      attribute or the modal's anchor href.
 *
 * VERIFY AGAINST LIVE APP: the modal's exact DOM (custom-element tag names, the
 * copy-button selector) depends on the bundled @walletconnect/modal version.
 * Confirm these selectors against the running IdP and adjust if the scrape
 * returns null.
 */
async function scrapeWcUri(page: Page): Promise<string> {
  // Grant clipboard read so the "Copy link" path works.
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"])
    .catch(() => {});

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // (1) Try any element carrying the uri as an attribute (qr-code components
    //     commonly expose `uri="wc:..."`).
    const fromAttr = await page
      .locator("[uri^='wc:']")
      .first()
      .getAttribute("uri")
      .catch(() => null);
    if (fromAttr?.startsWith("wc:")) return fromAttr;

    // (2) Try the clipboard after clicking a copy control, if present.
    const copy = page
      .getByRole("button", { name: /copy/i })
      .or(page.locator("[data-testid*='copy'], wui-link, button:has-text('Copy')"))
      .first();
    if (await copy.isVisible().catch(() => false)) {
      await copy.click().catch(() => {});
      const clip = await page
        .evaluate(() => navigator.clipboard.readText())
        .catch(() => "");
      if (clip.startsWith("wc:")) return clip;
    }

    await page.waitForTimeout(500);
  }
  throw new Error(
    "Could not scrape a wc: URI from the WalletConnect modal — verify the modal selectors against the live app.",
  );
}

test.describe("WalletConnect SIWE login (headless test wallet)", () => {
  test.skip(
    !PROJECT_ID,
    "WALLETCONNECT_PROJECT_ID not set — the IdP omits the WC connector and WalletKit needs a projectId.",
  );

  // No extension here, so override the dappwright-bound context with a plain
  // Chromium (lets this spec run without xvfb if needed).
  test("logs in via a scraped wc: URI and a headless WalletKit wallet", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    const wallet = new WalletConnectTestWallet({
      projectId: PROJECT_ID,
      mnemonic: SEED_PHRASE,
    });
    await wallet.init();

    try {
      const driver: WalletDriver = {
        // The wagmi walletConnect connector names itself "WalletConnect".
        // VERIFY AGAINST LIVE APP: confirm the picker tile label.
        pickerName: "WalletConnect",
        // After the tile is clicked the QR modal appears in the top window;
        // scrape the URI and pair the headless wallet.
        onWalletSelected: async (p) => {
          const uri = await scrapeWcUri(p);
          await wallet.pair(uri);
          await wallet.waitForSession();
        },
        // The headless wallet auto-approves on pair and auto-signs on request,
        // so there are no popups to click — these are no-ops.
        approveConnect: async () => {},
        approveSign: async () => {},
      };

      await runLoginAndAssertClaims({ page, driver });
    } finally {
      await wallet.close();
      await context.close();
      await browser.close();
    }
  });

  test("sanity: the headless wallet derives the expected subject", async () => {
    const wallet = new WalletConnectTestWallet({
      projectId: PROJECT_ID || "placeholder",
      mnemonic: SEED_PHRASE,
    });
    // address is derived locally (no init/relay needed).
    expect(wallet.address).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
