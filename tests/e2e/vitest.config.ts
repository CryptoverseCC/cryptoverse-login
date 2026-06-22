import { defineConfig } from "vitest/config";

/**
 * vitest runs ONLY the pure-Node unit tests (the headless WalletConnect test
 * wallet's signer + namespace logic). The Playwright browser specs under
 * `specs/` use the Playwright runner, not vitest — exclude them so
 * `yarn test:unit` doesn't try to execute `test.describe()` from the wrong
 * runner.
 */
export default defineConfig({
  test: {
    include: ["wc-wallet/**/*.test.ts"],
    environment: "node",
  },
});
