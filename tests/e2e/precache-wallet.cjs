// Build-time pre-download of the wallet extension into dappwright's cache
// (os.tmpdir()/dappwright/<wallet>). dappwright downloads the extension lazily on
// first bootstrap; doing that at RUNTIME deadlocks when it happens inside a
// Playwright worker in a container, so we do it ONCE here at image-build time (a
// single direct bootstrap, declared primary via TEST_PARALLEL_INDEX=0). The actual
// test then finds the extension cached and skips the download entirely.
//
// This is a THROWAWAY wallet purely to trigger the download — the build step
// removes its session afterwards, so the real test seeds its own fresh wallet
// (the account asserted on comes from tests/e2e/fixtures/wallet.ts at run time).
const dw = require("@tenkeylabs/dappwright");

(async () => {
  const wallet = process.env.E2E_PROJECT === "coinbase" ? "coinbase" : "metamask";
  const Wallet = wallet === "coinbase" ? dw.CoinbaseWallet : dw.MetaMaskWallet;
  const [, , ctx] = await dw.default.bootstrap("", {
    wallet,
    version: Wallet.recommendedVersion,
    // Standard Hardhat/Anvil test mnemonic — throwaway, discarded with the session.
    seed: "test test test test test test test test test test test junk", // pragma: allowlist secret
    password: "password1234", // pragma: allowlist secret
    headless: false,
  });
  await ctx.close();
  console.log(`precache: ${wallet} ${Wallet.recommendedVersion} cached`);
  process.exit(0);
})().catch((e) => {
  console.error("precache failed:", (e && (e.message || e)) || e);
  process.exit(1);
});
