# Cryptoverse Login

An OIDC / OAuth2 identity provider that authenticates users with their Ethereum
wallet using **Sign-In with Ethereum (EIP-4361)**. It wraps [ORY Hydra](https://www.ory.sh/hydra/)
and supplies the login + consent UI; the issued identity's subject is the user's
Ethereum address, enriched with ENS / Unstoppable Domains names. Optional
token-gating can require ERC-20 balances before login.

The application services (`login`, `wrapper`) are a **Rust / axum** Cargo
workspace under `login/`; Hydra is the token engine, HAProxy is the gateway, and
the wallet UI is a thin React/TypeScript app. See `CLAUDE.md` for architecture.

## Supported wallets

Connectivity is `@wagmi/core` + `viem`: EIP-6963 injected wallets (MetaMask,
etc.), Coinbase Wallet, and **WalletConnect v2**. **Hardware wallets (Ledger and
Trezor) are supported through WalletConnect** — Ledger Live and Trezor Suite
(WalletConnect support added Aug 2025) both connect via the existing
WalletConnect connector, with no extra dependencies. WalletConnect (and hence
the hardware-wallet path) requires a Reown / WalletConnect Cloud `projectId`
(`WALLETCONNECT_PROJECT_ID`); without it the WalletConnect connector is omitted.

## Develop the Rust services

```bash
$ cd login
$ cargo build --workspace
$ cargo test --workspace
$ cargo clippy --workspace --all-targets
```

## Frontend (wallet UI)

```bash
$ cd login/login/frontend
$ yarn install && yarn build   # or: yarn start
```

## Build

Use GitHub Actions — builds on PRs (images built from the `login/` workspace context).

## Release

Use GitHub Actions — releases on semver tags (`vX.Y.Z`).

## Build & run application on local microk8s

```bash
$ ./setup.sh
```

## Run the browser/wallet end-to-end tests locally

The end-to-end suite (`tests/e2e/`) drives the real Sign-In-with-Ethereum flow in
a browser using **Playwright + [dappwright](https://github.com/TenKeyLabs/dappwright)**
(MetaMask + Coinbase extensions, plus a headless `@reown/walletkit` WalletConnect
test wallet). It replaces the retired Selenium suite. Bring up a stack first
(`tests/kind/setup.sh`), then:

```bash
$ cd tests/e2e
$ yarn install && npx playwright install chromium
$ xvfb-run --auto-servernum yarn test:e2e:metamask   # MetaMask (no projectId needed)
```

See [`tests/e2e/README.md`](tests/e2e/README.md) for the Coinbase / WalletConnect
projects and the full test layering.
