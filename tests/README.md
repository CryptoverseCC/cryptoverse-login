# Tests

Three layers, all run against a deployed stack (use [`kind/`](kind/README.md) for
a production-faithful local cluster):

- **[`harness/`](harness/README.md) — the correctness harness (start here).** A
  fast, deterministic, browser-free suite that drives the whole IdP over HTTP
  (OIDC discovery, SIWE auth-code login, consent, tokens, claims, token-gating,
  introspection). This is what you re-run to know the system still works.
- **[`e2e/`](e2e/README.md) — the browser/wallet end-to-end suite.** A real
  browser through the demo relying party → Sign-In with Ethereum → back to the
  demo, asserting the issued ID-token claims. Built on **dappwright + Playwright**
  and covering **three** wallet connectors: the **MetaMask** and **Coinbase**
  browser extensions, plus a **headless WalletConnect** test wallet. Replaces the
  old Selenium + Firefox + MetaMask test (`test_full.py`, now retired).
- **Component render tests** (`login/login/frontend`): `yarn test` mounts every
  Storybook story in jsdom and asserts it renders — the UI components in
  isolation, no cluster needed.

```bash
tests/kind/setup.sh              # bring up the cluster (prints the exact commands)
pytest tests/harness/ -v         # prove correctness (see harness/README.md for env)
cd tests/e2e && yarn install && yarn test:e2e   # full browser/wallet run (see e2e/README.md)
```

## The layering

| layer | dir | scope | needs |
|---|---|---|---|
| backend HTTP | `harness/` | the whole IdP over HTTP/OIDC | deployed stack |
| wallet browser | `e2e/` | demo RP → SIWE → claims, per wallet | stack + (xvfb for extensions / Reown projectId for WalletConnect) |
| components | `login/login/frontend` (vitest stories) | UI components in isolation | nothing |

Each layer catches different failures: the harness proves the token engine +
SIWE verification + claims; `e2e/` proves the actual wallet connect/sign path in
a browser; the story render test proves the components mount and the screens
compose. Re-run the harness for fast confidence; run `e2e/` before a release or
when touching the wallet/iframe code.

## Browser/wallet e2e — see [`e2e/README.md`](e2e/README.md)

The e2e suite has its own README with full instructions (prerequisites, the
exact commands per wallet, what runs offline, and the DOM selectors to confirm
against the live app). In short:

```bash
tests/kind/setup.sh                                  # 1. cluster up
cd tests/e2e && yarn install && npx playwright install chromium
yarn typecheck && yarn test:unit && yarn test:list   # offline sanity (no cluster/display)
xvfb-run --auto-servernum yarn test:e2e:metamask     # MetaMask extension (needs X display)
xvfb-run --auto-servernum yarn test:e2e:coinbase     # Coinbase extension (needs X display)
WALLETCONNECT_PROJECT_ID=<id> yarn test:e2e:walletconnect   # WalletConnect (needs a Reown projectId)
```

The suite reuses the old test's fixed account
(`0xae89b4e1b97661dab58bee7771e95ec58fc6a94b`, seeded from the same mnemonic) and
the same ID-token claim assertions.

## Retired: the old Selenium suite

`test_full.py` (Selenium + Firefox + a vendored MetaMask Firefox extension) has
been **deleted** and superseded by [`e2e/`](e2e/README.md). Also removed:
`tests/metamask/` (its page objects), `tests/requirements.txt` and
`tests/pytest.ini` (which existed only for that test).

**Still on disk but now unused** — safe for you to delete (left in place so this
change doesn't silently drop vendored binaries):

- `tests/tools/geckodriver` — the Firefox WebDriver (Playwright bundles its own).
- `tests/extensions/metamask-firefox-9.1.0.zip`,
  `tests/extensions/metamask-chrome-9.1.0.zip`,
  `tests/extensions/metamask-chrome-10.17.0.zip` — dappwright downloads the
  extension itself, so these vendored zips are no longer referenced.

> `mobile.py` (an Appium/WalletConnect mobile experiment) was already not part of
> the suite and is left untouched — it belongs to the separate mobile-automation
> effort.

## Notes

- The login message is **EIP-4361 (Sign-In with Ethereum)**.
- The kind stack uses self-signed mkcert certs — the harness uses `curl -k`, the
  e2e suite sets Playwright's `ignoreHTTPSErrors`.
- Other references to `test_full.py` outside `tests/` (the root `README.md`,
  `CLAUDE.md`, `.github/workflows/build.yml`, and the print-out in
  `tests/kind/setup.sh`) still mention the old command and should be updated to
  point at `tests/e2e/` when those files are next touched.
```
