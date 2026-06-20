# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cryptoverse Login is an **OIDC / OAuth2 identity provider that authenticates users with their Ethereum wallet** ("Sign in with Ethereum"). It wraps [ORY Hydra](https://www.ory.sh/hydra/) (the audited OAuth2/OIDC token engine) and supplies the login + consent UI. The subject of every issued identity is the user's lowercased Ethereum address; the consent step enriches the ID token with ENS / Unstoppable Domains names and generated `{address}@{MAILSERVER_DOMAIN}` emails. Optional **token-gating** can require an address to hold certain ERC-20 balances before login is allowed.

Authentication uses the **EIP-4361 (Sign-In with Ethereum / SIWE)** standard. Everything runs in Kubernetes, deployed via the Helm chart in `charts/login`. There is no way to run the full system without a cluster (see Commands).

> The application services are **Rust** (axum). Hydra stays as the token engine; the gateway stays HAProxy; the wallet UI stays a thin TypeScript/React app. A prior version had a Node/TS login backend and a Python/Flask wrapper — those are gone.

## Component architecture

Four containers, all behind the gateway.

- **gateway** (`login/gateway`, HAProxy) — the single ingress. Routing lives entirely in `haproxy.conf`:
  - `/login`, `/consent` → **login** backend
  - `/oauth2/auth`, `/oauth2/final` → **wrapper**
  - `/oauth2/introspect` → Hydra **admin** (`/admin/...`), gated behind HTTP basic auth (`INTROSPECT_ACCESS_USER/PASS`)
  - everything else (`/oauth2/...`, `/.well-known/...`) → Hydra **public**
  - Rewrites the path `/oauth2/inner` → `/oauth2/auth` so the wrapper's iframe can load Hydra's real authorize endpoint.
  - Rewrites Hydra's consent redirect `Location` header into `/oauth2/final?url=...` so the wrapper renders a final page.

- **Rust workspace** (`login/`, a Cargo workspace) — three crates:
  - **`core`** (`login/core`, crate `cryptoverse-core`) — shared library:
    - `hydra.rs` — thin `reqwest` client for Hydra 2.x **admin** API (get/accept login & consent). No official ORY Rust SDK; the surface is small.
    - `auth.rs` — EIP-4361 verification via the [`siwe`](https://github.com/spruceid/siwe-rs) crate, plus `nonce_for_challenge` (see SIWE below).
    - `eth.rs` — [`alloy`](https://github.com/alloy-rs/alloy) provider: ENS reverse resolution (hand-rolled EIP-137 namehash + registry/resolver calls), ERC-20 `balanceOf`, Unstoppable Domains `reverseOf`.
    - `config.rs`, `telemetry.rs` (tracing + Sentry + a Prometheus handle).
  - **`wrapper`** (`login/wrapper`, axum) — two routes rendering thin HTML shells (minijinja; templates reused from the old Flask app, embedded via `include_str!`):
    - `GET /oauth2/auth` → `embed.html`: the **top-level** page; loads `embed.js` and an `<iframe>` at `/oauth2/inner`.
    - `GET /oauth2/final` → `final.html`: completes the redirect back to the relying party.
  - **`login`** (`login/login`, axum) — the core. The Hydra **login & consent provider** and the SPA host:
    - `GET /login` (`routes/login.rs::page`) → renders the SPA `index.html` with challenge, client metadata, restrictions, and **SIWE params**.
    - `POST /login/process` (`routes/login.rs::process`) → verifies the SIWE message+signature (`core::auth::verify`), runs token-gating, then `accept_login_request` with `subject = recovered address`.
    - `GET /consent` (`routes/consent.rs`) → auto-accepts consent and attaches the ID token built by `user_data.rs::get_data` (ENS + Unstoppable Domains).
    - `GET /---/metrics` → Prometheus exposition; keeps the `login_status{status,client}` counter the dashboards expect.
    - everything else → static SPA assets via `tower_http::ServeDir` (rooted at `STATIC_DIR`, files live under `/login/...`).
    - The **frontend** (`login/login/frontend`, React/CRA via CRACO + MUI v4) is unchanged in structure — still emits three bundles (`main`/`embed`/`final`); see the iframe split below. The login crate lives alongside it in the same directory.

## The iframe ↔ top-window split (most important non-obvious detail)

A wallet provider (MetaMask injection, WalletConnect, MEW) must live in the **top-level window**, not in an iframe. So the login UI is split across a Comlink RPC boundary:

- The **top window** (`embed.js`, served by wrapper's `embed.html`) owns the wallet. It exposes `init / connect / login / identities / redirect` over Comlink (`frontend/src/embed/*`).
- The **iframe** (`main` bundle, the React app) renders the UI and calls those methods on the parent via `Comlink.wrap(...window.parent)` (`frontend/src/services/loginProvider.ts`). It never touches the wallet directly.
- Flow: iframe asks parent to `connect` → parent returns addresses → iframe asks parent to `login` → parent builds the SIWE message, signs it, returns `{message, signature, challenge, address}` → iframe `POST`s `message`+`signature`+`challenge` to `/login/process`.

When editing wallet/connection code, decide which side of this boundary it belongs to. `loginProvider.ts` defines the shared `IProvider` interface both sides implement.

## SIWE (EIP-4361) — the auth contract

Replaces the old custom message (`Cryptoverse Login - auth.cryptoverse.cc|csrf|challenge`).

- The backend issues SIWE params in `loginData.siwe` (`domain`, `uri`, `statement`, `version`, `chainId`, `nonce`, `expirationMinutes`). The **nonce is `sha256(login_challenge)[..16]` hex** — deterministically derived from Hydra's one-time login challenge, so verification is **stateless and multi-replica safe** (no shared nonce store) and a signature is bound to exactly one login flow.
- The frontend assembles the canonical EIP-4361 message in `frontend/src/embed/login.ts::buildSiweMessage` and the backend re-derives + checks the nonce in `core::auth::verify`. **Both sides implement EIP-4361**, so the formats interoperate — but if you touch one builder, keep it spec-compliant. The round-trip is covered by `core/src/auth.rs` tests (`verifies_real_signature_roundtrip`, `rejects_wrong_nonce`).
- `verify` checks: signature (EIP-191), domain == `DOMAIN`, nonce == derived, and the message's expiry/not-before. CSRF tokens were dropped — the signature + challenge-bound nonce are the protection.

## Conventions & gotchas

- **Token-gating** (`login/login/src/restrictions.rs`): restrictions come from the client's Hydra `metadata.restrictions`, or fall back to `RESTRICTIONS_FILE` (default `/config/restrictions.json`, a ConfigMap) keyed by `client_id`, re-read per request. Each entry has a `tokenAddress` or `contractAliases` plus a `condition` evaluated by **[`evalexpr`]** (replacing mathjs) against on-chain `balanceOf` values. Condition variables are `balanceOf` (single token) or `<Alias>balanceOf` (aliases form). evalexpr works on `f64`, so balances are scaled by `decimals` and coerced to float — keep that in mind for balance math.
- **alloy API churn**: the http provider is built via `RootProvider::new(ClientBuilder::default().http(url))` and requires alloy's `reqwest-rustls-tls` feature (rustls, no OpenSSL). If you bump alloy, the provider-construction and `.call()` APIs are the things most likely to break.
- Secrets are guarded by a **detect-secrets** pre-commit hook; annotate intentional matches with `# pragma: allowlist secret`.
- Production Helm values are GPG-encrypted: `charts/login/values.prod.yaml.gpg`. Don't commit a plaintext `values.prod.yaml`.

## Commands

### Rust workspace (`login/`)
```bash
cargo build --workspace        # build core + login + wrapper
cargo test --workspace         # unit tests (SIWE round-trip, evalexpr, namehash, ...)
cargo clippy --workspace --all-targets
cargo fmt
cargo run -p wrapper           # needs env (PORT, DOMAIN, SENTRY_*)
cargo run -p login             # needs env (HYDRA_ADMIN_URL, DOMAIN, MAILSERVER_DOMAIN, INDEX_TEMPLATE, STATIC_DIR, ...)
```
The `login` binary serves the SPA from `STATIC_DIR` and renders `INDEX_TEMPLATE` (the frontend-built `index.html`); without a frontend build those paths are absent and `GET /login` 500s — fine for unit tests.

### Frontend (`login/login/frontend`)
```bash
yarn start            # CRACO dev server
yarn build            # production build (emits main/embed/final bundles + index.html template)
yarn test             # CRA/Jest tests
yarn storybook        # component stories on :6006
```

### Docker images
Build context is the workspace root (`login/`), because the binaries share the `core` crate:
```bash
docker build -f login/login/Dockerfile   login/   # login (multi-stage: yarn build → cargo build → runtime)
docker build -f login/wrapper/Dockerfile login/   # wrapper
```
`docker-compose.build.yml` encodes these contexts.

### Local full stack via podman (real Hydra, no cluster)
`local-stack/` brings up postgres + Ory Hydra 2.x + login + wrapper + gateway in
one podman pod and drives a headless OAuth2 + SIWE flow (signs EIP-4361 with a
test key via the `cryptoverse-core` `sign` example). Good for validating the
whole backend without a cluster or browser. See `local-stack/README.md`.
```bash
podman kube play local-stack/cryptoverse-stack.yaml
python3 local-stack/smoke_test.py      # asserts id_token sub + enriched email
podman kube down local-stack/cryptoverse-stack.yaml
```

### Local full-stack (requires microk8s)
```bash
./setup.sh    # microk8s addons + postgres + Hydra, builds images, helm-installs login + demo app
              # Domains: login.cryptoverse.local, login-demo.cryptoverse.local
```

### Selenium end-to-end tests (`tests/`)
Drive a MetaMask Firefox extension against the demo Django app. Put `geckodriver` in `tests/tools/`. This is the primary end-to-end safety net.
```bash
cd tests && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt --upgrade
pytest test_full.py --verbose --log-cli-level=INFO
```

### CI/CD (GitHub Actions)
- **`build.yml`** (PRs / pushes to `master`): builds gateway/login/wrapper/demo images (login & wrapper from the `login/` context) → DO registry tagged with git SHA → microk8s → `helm dependency update` + `helm install` → Selenium suite.
- **`release.yml`** (tags `v[0-9]+.[0-9]+.[0-9]+`): decrypts prod values and `helm upgrade`s production. Release by pushing a semver tag.

## Hydra

Subchart `hydra` is pinned in `charts/login/Chart.yaml` (currently **0.62.1 → Ory Hydra v26.2.0**, the 2.x line). Hydra config lives under the `hydra:` block in `charts/login/values*.yaml`. The chart is apiVersion v2; the dependency lock is regenerated by `helm dependency update` (there is no committed lock).
