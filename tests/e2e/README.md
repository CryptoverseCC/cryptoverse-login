# Browser/wallet end-to-end suite (`tests/e2e/`)

The wallet-browser layer of the test pyramid. It drives the **demo relying
party** through the real Sign-In-with-Ethereum flow — pick a wallet, approve the
connection, sign the EIP-4361 (SIWE) message, redirect back — and asserts the
issued ID-token claims for a fixed account. It replaces the retired Selenium +
Firefox + MetaMask suite (`../test_full.py`) with a maintained
**[dappwright](https://github.com/TenKeyLabs/dappwright) + Playwright** harness.

Three wallet connectors, three Playwright projects:

| project | wallet | how it's automated | needs |
|---|---|---|---|
| `metamask` | MetaMask **extension** | dappwright (real extension, headed Chromium) | kind cluster + **X display** (xvfb) |
| `coinbase` | Coinbase **extension** | dappwright (real extension, headed Chromium) | kind cluster + **X display** (xvfb) |
| `walletconnect` | WalletConnect (desktop QR) | a **headless** `@reown/walletkit` test wallet (no extension) | kind cluster + a **Reown projectId** |

The same login flow + claim assertions are shared across all three
(`fixtures/loginFlow.ts`, `fixtures/wallet.ts`); only the wallet-popup driver
differs.

## Layout

```
tests/e2e/
├── package.json            # pinned deps (see "Pinned versions")
├── tsconfig.json
├── playwright.config.ts    # projects metamask/coinbase/walletconnect; ignoreHTTPSErrors
├── vitest.config.ts        # scopes vitest to the wc-wallet unit tests only
├── fixtures/
│   ├── wallet.ts           # seed/account/password + expected ID-token claims (ported from test_full.py)
│   ├── dappwright.ts       # dappwright Playwright fixtures (metamaskTest / coinbaseTest)
│   └── loginFlow.ts        # the shared demo-RP → iframe → connect → sign → assert flow
├── specs/
│   ├── metamask.spec.ts
│   ├── coinbase.spec.ts
│   └── walletconnect.spec.ts
└── wc-wallet/
    ├── signer.ts           # pure seed-key personal_sign signer (viem)
    ├── responder.ts        # headless @reown/walletkit test wallet (pair + approve + sign)
    └── signer.test.ts      # pure-Node unit tests (vitest) — no browser/cluster
```

## What runs offline vs. what needs the full stack

| command | needs | what it does |
|---|---|---|
| `yarn typecheck` | nothing | `tsc --noEmit` |
| `yarn test:unit` | nothing | vitest: the WC test wallet's signer + namespace logic (pure Node) |
| `yarn test:list` | nothing | `playwright test --list` — proves the specs/config parse |
| `yarn test:e2e:metamask` | kind cluster + xvfb | full MetaMask browser e2e |
| `yarn test:e2e:coinbase` | kind cluster + xvfb | full Coinbase browser e2e |
| `yarn test:e2e:walletconnect` | kind cluster + projectId | full WalletConnect e2e (headless wallet; no xvfb needed) |

(Use `npm run …` if you don't have `yarn`.)

## Setup

```bash
cd tests/e2e
yarn install            # or: npm install
npx playwright install chromium   # one-time browser download
```

Offline checks (no cluster, no display) — run these to know the harness itself
is healthy:

```bash
yarn typecheck
yarn test:unit
yarn test:list
```

## Running the full browser e2e

### 1. Bring up the cluster

```bash
tests/kind/setup.sh        # real charts + Hydra + the demo RP on a local kind cluster
```

It serves the demo at `https://login-demo.cv.127.0.0.1.nip.io:9443` and the IdP at
`https://login.cv.127.0.0.1.nip.io:9443`, with TLS from a local **mkcert** CA. The
suite sets `ignoreHTTPSErrors`, so you do **not** need to trust the CA for the
tests (you do for a manual browser).

### 2. MetaMask / Coinbase (extensions → need a headed browser under xvfb)

Chromium cannot load extensions headless, and dappwright drives a real
extension, so on Linux/CI wrap the run in a virtual framebuffer:

```bash
xvfb-run --auto-servernum yarn test:e2e:metamask
xvfb-run --auto-servernum yarn test:e2e:coinbase
# or both extension projects at once:
xvfb-run --auto-servernum yarn playwright test --project=metamask --project=coinbase
```

On macOS/Windows there's no xvfb; a real display is used (the windows are
visible). `headless: false` is mandatory either way.

### 3. WalletConnect (headless test wallet → needs a Reown projectId)

This project uses no extension — a headless `@reown/walletkit` wallet pairs with
the `wc:` URI scraped from the IdP's QR modal. Both the IdP's WC connector and
the test wallet's relay need a free **Reown / WalletConnect Cloud** projectId
(`https://cloud.reown.com`). Without it the IdP omits the WC connector entirely
and this project **self-skips**.

```bash
WALLETCONNECT_PROJECT_ID=<your-reown-project-id> yarn test:e2e:walletconnect
```

The cluster must be deployed with the **same** projectId
(`WALLETCONNECT_PROJECT_ID` in `tests/kind/values-kind.yaml` /
`charts/login`), so the embed page actually offers WalletConnect.

### Everything at once

```bash
WALLETCONNECT_PROJECT_ID=<id> xvfb-run --auto-servernum yarn test:e2e
```

## Environment variables

| var | default | meaning |
|---|---|---|
| `DEMO_URL` | `https://login-demo.cv.127.0.0.1.nip.io:9443` | demo RP base URL (Playwright `baseURL`) |
| `LOGIN_URL` | `https://login.cv.127.0.0.1.nip.io:9443` | IdP host (informational) |
| `WALLETCONNECT_PROJECT_ID` | _(empty)_ | enables the `walletconnect` project |
| `MAILSERVER_DOMAIN` | `ethmail.cc` | for the email claim assertions (kind default) |
| `PROFILE_DOMAIN` | `cryptoverse.cc` | for the picture/profile/website claim assertions (kind default) |
| `CI` | _(unset)_ | enables the HTML reporter + `forbidOnly` |

The fixed account (BIP-44 m/44'/60'/0'/0/0 of the seed in `fixtures/wallet.ts`)
is `0xae89b4e1b97661dab58bee7771e95ec58fc6a94b` — the same account the old
Selenium suite used, so the claim assertions are unchanged.

## Pinned versions

```
@playwright/test       1.61.0
@tenkeylabs/dappwright  2.13.5   (MetaMask + Coinbase extensions; Playwright-only)
@reown/walletkit        1.5.5    (successor to @walletconnect/web3wallet)
@walletconnect/core     2.23.9
@walletconnect/utils    2.23.9   (buildApprovedNamespaces / getSdkError)
viem                    2.53.1
typescript              5.9.3
vitest                  4.1.9
```

`@reown/walletkit@1.5.5` already depends on `@walletconnect/core@2.23.9` and
`@walletconnect/utils@2.23.9`, so the pins line up exactly (no duplicate
WalletConnect copies).

## Selectors that need confirming against the live app

This harness was written against the current product source, but a few DOM hooks
can only be confirmed against a running cluster. If a spec fails to find an
element, check these first (each is flagged `VERIFY AGAINST LIVE APP` in code):

- **Login iframe**: `page.frameLocator("iframe")` — the wrapper renders the
  picker inside one iframe (historically `//body/iframe`).
- **Wallet tile**: `Connect with <name>` (from `Wallet.tsx`). The wallet name is
  the EIP-6963 / connector name — confirm the exact label for **Coinbase**
  (`Coinbase Wallet`) and **WalletConnect** (`WalletConnect`). The redesigned UI
  has **no** intermediate "Ethereum Wallet" step the old test clicked.
- **Identity card**: `Sign in with <ens-or-short-address>` where the address is
  **truncated** (e.g. `0xae89…a94b`) — the spec clicks the sole active card, not
  a full-address match.
- **WalletConnect QR modal**: the `wc:` URI scrape (`specs/walletconnect.spec.ts`
  `scrapeWcUri`) tries a `[uri^='wc:']` attribute and a clipboard "Copy" button.
  The modal's exact custom-element tags depend on the bundled
  `@walletconnect/modal` version — confirm and adjust if the scrape returns null.
- **Demo success page**: `<title>Cryptoverse Login - Demo - Success</title>`,
  `<span>{address}</span>`, `<pre class="data">{json}</pre>` — stable
  (`protected.html`).

## Relationship to the other test layers

- `tests/harness/` — backend HTTP correctness (browser-free; start here).
- `tests/e2e/` — **this** suite: the wallet-browser layer.
- `login/login/frontend` vitest stories render test — the UI components in
  isolation.
