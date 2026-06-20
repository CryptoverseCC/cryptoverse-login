# Cryptoverse Login

An OIDC / OAuth2 identity provider that authenticates users with their Ethereum
wallet using **Sign-In with Ethereum (EIP-4361)**. It wraps [ORY Hydra](https://www.ory.sh/hydra/)
and supplies the login + consent UI; the issued identity's subject is the user's
Ethereum address, enriched with ENS / Unstoppable Domains names. Optional
token-gating can require ERC-20 balances before login.

The application services (`login`, `wrapper`) are a **Rust / axum** Cargo
workspace under `login/`; Hydra is the token engine, HAProxy is the gateway, and
the wallet UI is a thin React/TypeScript app. See `CLAUDE.md` for architecture.

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

## Run selenium tests locally

```bash
$ cd tests
$ source .venv/bin/activate.fish
$ pip install -r requirements.txt --upgrade
$ pytest test_full.py --verbose --log-level=INFO --capture=no --log-cli-level=INFO
```
