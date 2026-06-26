# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cryptoverse Login is an **OIDC / OAuth2 identity provider that authenticates users with their Ethereum wallet** ("Sign in with Ethereum"). It wraps [ORY Hydra](https://www.ory.sh/hydra/) (the audited OAuth2/OIDC token engine) and supplies the login + consent UI. The subject of every issued identity is the user's lowercased Ethereum address; the consent step enriches the ID token with **forward-verified** ENS / Unstoppable Domains names and generated `{address}@{MAILSERVER_DOMAIN}` emails. Optional **token-gating** can require an address to hold certain ERC-20 balances before login is allowed.

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
    - `hydra.rs` — thin `reqwest` client for Hydra 2.x **admin** API (get/accept login & consent; accept device user-code). No official ORY Rust SDK; the surface is small.
    - `auth.rs` — EIP-4361 verification via the [`siwe`](https://github.com/spruceid/siwe-rs) crate, plus `nonce_for_challenge` (see SIWE below). Enforces a **mandatory** `Expiration Time` + server-side max-age, and checks `version`/`chainId`/`uri` against what was issued.
    - `eth.rs` — [`alloy`](https://github.com/alloy-rs/alloy) provider: **forward-verified** ENS reverse resolution (the reverse name's own `addr(node)` must resolve back to the address — never a bare, owner-settable reverse record; hand-rolled EIP-137 namehash + registry/resolver), **forward-verified Basenames** (`*.base.eth`, resolved natively on a second **Base L2** provider from `BASE_RPC_URL` — ENSIP-19 `nameForAddr` + the same forward-`addr`-must-match check; absent `BASE_RPC_URL` ⇒ off, no mainnet fallback), **ownership-verified** Unstoppable Domains (`reverseOf` + `ownerOf`), and ERC-20 / ERC-721 / ERC-1155 `balanceOf`. Names that can't be verified (incl. offchain/CCIP) are dropped. Security-relevant reads (ERC-1271/6492 validation, gated balances) return `Result` and **fail closed** (deny) on RPC error — distinct from a clean negative; enrichment stays best-effort (`None`).
    - `config.rs`, `telemetry.rs` (tracing + Sentry + a Prometheus handle).
  - **`wrapper`** (`login/wrapper`, axum) — two routes rendering thin HTML shells (minijinja; templates reused from the old Flask app, embedded via `include_str!`):
    - `GET /oauth2/auth` → `embed.html`: the **top-level** page; loads `embed.js` and an `<iframe>` at `/oauth2/inner`.
    - `GET /oauth2/final` → `final.html`: completes the redirect back to the relying party.
  - **`login`** (`login/login`, axum) — the core. The Hydra **login & consent provider** and the SPA host:
    - `GET /login` (`routes/login.rs::page`) → renders the SPA `index.html` with challenge, client metadata, restrictions, and **SIWE params**.
    - `POST /login/process` (`routes/login.rs::process`) → verifies the SIWE message+signature (`core::auth::verify`), runs token-gating, then `accept_login_request` with `subject = recovered address`. It stamps OIDC **`acr`/`amr`** assurance: `amr=["sig"]` (SIWE = signature PoP), `acr="wallet"` or `"wallet-gated"` when token-gating was enforced and satisfied. The accept also sets `remember`/`remember_for` from **`REMEMBER_FOR`** (default 3600s) — non-zero gives SSO and is what makes logout/back-channel fire.
    - `GET /logout` (`routes/logout.rs`) → the **RP-initiated logout** provider (`urls.logout`). Hydra redirects here (one-time `logout_challenge`) after validating the RP's `id_token_hint` at `/oauth2/sessions/logout`; we auto-accept (`core::hydra::accept_logout_request`) and follow Hydra's `redirect_to` (clears session, fires back-/front-channel logout, lands on the post-logout redirect). Server-rendered, no wallet/JS. Gateway routes `/logout` to this backend.
    - `GET /consent` (`routes/consent.rs`) → auto-accepts consent and attaches the **ID token** built by `user_data.rs::get_data` (verified ENS/UD names — `name` = the verified primary — but only when the **`profile`** scope is granted, else `name` falls back to the address and a `has_primary_name` boolean signals one exists; `email_verified` defaults **false** unless `EMAIL_VERIFIED_CLAIM=true`). On tokens carrying the **`mail`** scope it also adds **`cv_identities`** (nested `v1`: `{schema, address, primary_name:{name,kind,chain_id,verified_at}|null, owned:null}`) to the **ID token** (so it surfaces in the ID token *and* `/userinfo`) and the **access token** (which Hydra nests under the `ext` claim).
    - `GET /device` / `POST /device` (`routes/device.rs`) → the **device-authorization-grant** (RFC 8628) user-code verification page (server-rendered minijinja, templates bundled via `include_str!`, no wallet/JS). It accepts the `user_code` via Hydra (`core::hydra::accept_device_request`) and redirects into the **standard `/login` → `/consent` SIWE flow**, reused unchanged — so native clients (mail apps, CLIs) get a token without a browser of their own. `GET /device/success` is the landing page. The gateway routes `/device` to this backend; `/oauth2/device/*` already reach Hydra.
    - `GET /---/metrics` → Prometheus exposition; keeps the `login_status{status,client}` counter the dashboards expect (now incl. `device-verify-*` and `rpc_calls_total{label,result}`).
    - everything else → static SPA assets via `tower_http::ServeDir` (rooted at `STATIC_DIR`, files live under `/login/...`).
    - The **frontend** (`login/login/frontend`, React + **Vite**, **MUI v7** on emotion) emits three bundles (`main`/`embed`/`final`); see the iframe split and "Frontend build contract" below. Wallet connectivity is **`@wagmi/core` + `viem`** (EIP-6963 injected discovery + WalletConnect v2 + Coinbase). The login crate lives alongside it in the same directory.

## The iframe ↔ top-window split (most important non-obvious detail)

A wallet provider (injected/MetaMask, WalletConnect, Coinbase) must live in the **top-level window**, not in an iframe. So the login UI is split across a Comlink RPC boundary:

- The **top window** (`embed.js`, served by wrapper's `embed.html`) owns the wallet via a **`@wagmi/core` config** built in `frontend/src/embed/utils.ts` (EIP-6963 injected discovery + WalletConnect v2 + Coinbase; one viem `signMessage` replaces the old per-wallet signers). It exposes `init / connect / login / identities / redirect` over Comlink (`frontend/src/embed/*`).
- The **iframe** (`main` bundle, the React app) renders the UI and calls those methods on the parent via `Comlink.wrap(...window.parent)` (`frontend/src/services/loginProvider.ts`). It never touches the wallet directly.
- Flow: iframe `init`s the parent (passing the WalletConnect project id — the embed page has **no `login-data` block of its own**) and gets back the EIP-6963-discovered wallet list → user picks one → iframe asks parent to `connect` by connector id → parent returns addresses → iframe asks parent to `login` → parent builds + signs the SIWE message (viem), returns `{message, signature, challenge, address}` → iframe `POST`s `message`+`signature`+`challenge` to `/login/process` (as `URLSearchParams`, to preserve the signed message's LF line endings — a `<form>`/FormData would normalise them to CRLF and break EIP-4361 parsing).

When editing wallet/connection code, decide which side of this boundary it belongs to. `loginProvider.ts` defines the shared `IProvider` interface both sides implement (`init`/`connect` payloads now carry the project id and a connector id respectively).

## Frontend build contract (Vite) — preserve this

The SPA builds with **Vite** (`frontend/vite.config.ts`); the backend + gateway depend on the exact output shape, so keep it intact when touching the build:

- **base `/login/`**, output to `build/`. Three entries via `rollupOptions.input`: `main` (= `index.html`), `embed` (`src/embed/index.ts`), `final` (`src/final/index.ts`).
- `embed.js` / `final.js` MUST stay **unhashed** at `build/static/js/` — the wrapper templates hardcode `/login/static/js/{embed,final}.js`. They are ES modules, so the wrapper loads them with `type="module"` (the inline scripts that set `window.redirectUrl` / await `window.ready` still order correctly because module scripts are deferred).
- `index.html` (frontend root) is the **minijinja template** the login backend renders; it must keep `{{ title }}` and `<script type="application/json" id="login-data">{{ login_data | safe }}</script>`. **minijinja parses `{{ }}` even inside HTML comments** — never write placeholder examples in comments, it 500s the login pod at template registration.
- The Docker frontend stage must NOT set `NODE_ENV=production` before `yarn install` (Vite / `@vitejs/plugin-react` / `typescript` are devDependencies and would be skipped). It strips `src/stories` before building, so stories/tests never reach the runtime image.

## SIWE (EIP-4361) — the auth contract

Replaces the old custom message (`Cryptoverse Login - auth.cryptoverse.cc|csrf|challenge`).

- The backend issues SIWE params in `loginData.siwe` (`domain`, `uri`, `statement`, `version`, `chainId`, `nonce`, `expirationMinutes`). The `domain`/`uri` are **derived per-request** from the headers the ingress forwards (`X-Forwarded-Host`/`X-Forwarded-Proto`, falling back to `Host`/`https`) — there is no hardcoded domain or port, so the IdP works on whatever host the ingress serves (`routes/mod.rs::public_origin`, mirrored in the gateway's `haproxy.conf` and the wrapper). The **nonce is `sha256(login_challenge)[..16]` hex** — deterministically derived from Hydra's one-time login challenge, so verification is **stateless and multi-replica safe** (no shared nonce store) and a signature is bound to exactly one login flow.
- The frontend assembles the canonical EIP-4361 message in `frontend/src/embed/login.ts::buildSiweMessage` and the backend re-derives + checks the nonce in `core::auth::verify`. **Both sides implement EIP-4361**, so the formats interoperate — but if you touch one builder, keep it spec-compliant. The round-trip is covered by `core/src/auth.rs` tests (`verifies_real_signature_roundtrip`, `rejects_wrong_nonce`).
- `verify` checks: signature (EIP-191), domain == the request's forwarded host, nonce == derived, and the message's expiry/not-before. CSRF tokens were dropped — the signature + challenge-bound nonce are the protection.

## Conventions & gotchas

- **Token-gating** (`login/login/src/restrictions.rs`): restrictions come from the client's Hydra `metadata.restrictions`, or fall back to `RESTRICTIONS_FILE` (default `/config/restrictions.json`, a ConfigMap) keyed by `client_id`, re-read per request. Each entry has a `tokenAddress` or `contractAliases` plus a `condition` evaluated by **[`evalexpr`]** (replacing mathjs) against on-chain `balanceOf` values. Condition variables are `balanceOf` (single token) or `<Alias>balanceOf` (aliases form). evalexpr works on `f64`, so balances are scaled by `decimals` and coerced to float — keep that in mind for balance math. A single-token entry may set `standard` to `"erc20"` (default, decimals-scaled), `"erc721"` (NFT collection / DAO membership — raw whole-unit count, so `balanceOf > 0` = "owns at least one"), or `"erc1155"` (+ a `tokenId`); the NFT reads (`eth::nft_balance_of` / `erc1155_balance_of`) **fail closed** exactly like the ERC-20 path. `contractAliases` stay ERC-20. A `"passport"` entry (no `tokenAddress`) gates by **Gitcoin / Human Passport** humanity score: it reads the on-chain decoder on **Base** (`eth::passport_score`, needs `BASE_RPC_URL`) and exposes the variable `passportScore` (e.g. `"passportScore >= 20"`); a no/expired passport or any read error fails closed (deny). Generic recipient-keyed **EAS** isn't on-chain-queryable without an off-chain indexer (EAS is UID-addressed), so Passport — whose stamps *are* EAS attestations decoded on-chain — is the fail-closeable attestation gate.
- **alloy API churn**: the http provider is built via `RootProvider::new(ClientBuilder::default().http(url))` and requires alloy's `reqwest-rustls-tls` feature (rustls, no OpenSSL). If you bump alloy, the provider-construction and `.call()` APIs are the things most likely to break.
- **WalletConnect**: needs a free Reown / WalletConnect Cloud `projectId`, supplied via `WALLETCONNECT_PROJECT_ID` (chart + `tests/kind` values) → `loginData.walletConnectProjectId`. Empty ⇒ the WalletConnect connector is omitted (injected wallets still work); no key is hardcoded.
- **Hardware wallets (Ledger / Trezor)** — already supported, **no new connectors or dependencies**. Both are WalletConnect v2 wallets (Ledger Live mobile/desktop; **Trezor Suite added WalletConnect support in Aug 2025**), so they ride the existing `walletConnect()` connector in `login/login/frontend/src/embed/utils.ts`. Operationally this requires a provisioned Reown `projectId` (see above) with **mainnet (chainId 1)** and the **`personal_sign`** method enabled in the Reown dashboard; an empty projectId omits the WC connector ⇒ no hardware-wallet path. Do **not** add `@trezor/connect-web` (needs its own hosted iframe/popup, which conflicts with the top-window embed) or `@ledgerhq/connect-kit` (CDN-loaded at runtime, a supply-chain risk) — WalletConnect is the supported route for both. Future option (not implemented): pass `showQrModal:false` to the connector and render the WC `display_uri` QR inside the branded top-window UI instead of WalletConnect's own modal.
- **Passkeys & EIP-7702 — already supported via the existing signature path, no new code.** A **passkey-secured smart account** (P-256/WebAuthn signer, e.g. Coinbase Smart Wallet) authenticates through the **ERC-1271/6492** branch of `core::auth::verify` — the passkey assertion is verified on-chain inside `isValidSignature`, so the backend never handles P-256 (the verifier is scheme-agnostic). Requires the configured chain to expose a reachable **secp256r1 verifier / RIP-7212**, and the wallet to connect via an existing connector (EIP-6963 / WalletConnect / Coinbase). **EIP-7702** delegated EOAs also work unchanged: a `personal_sign` SIWE still ecrecovers to the same address (fast path), and a session-key/1271-form signature falls through to the contract path — the ecrecover-before-1271 ordering is a deliberate, documented IdP stance (see `verify`). Keep the contract fallback unconditional.
- **Claim privacy / scope-gating**: `user_data::get_data` takes an `expose_names` flag — the **verified ENS/UD human-readable name** (`name`, `names.*`, `emails.*`, `nickname`) is released only when the client was granted the **`profile`** scope (it's real-world-linkable). Address-derived synthetic claims always populate (they reveal only the public `sub`). A `has_primary_name` boolean always signals a verified name exists *without* disclosing it. The **`mail`-scope `cv_identities`** still carries the verified primary regardless of `profile` (built in `consent.rs` from the returned `Enrichment` via `user_data::primary_of`, no second on-chain call).
- **Frontend checks**: `yarn typecheck` (tsc, includes stories) + `yarn test` — a vitest/jsdom test (`frontend/src/stories/stories.render.test.tsx`) that mounts **every Storybook story** and asserts it renders (it already caught real DOM-nesting / missing-key bugs). Add a story for any new component state; the render test discovers it automatically. Stories drive the App/background screens with a mock `ILoginProvider` (`frontend/src/stories/mockLoginProvider.ts`).
- Secrets are guarded by a **detect-secrets** pre-commit hook; annotate intentional matches with `# pragma: allowlist secret`.
- Production Helm values are GPG-encrypted: `charts/login/values.prod.yaml.gpg`. Don't commit a plaintext `values.prod.yaml`.

## Commands

### Rust workspace (`login/`)
```bash
cargo build --workspace        # build core + login + wrapper
cargo test --workspace         # unit tests (SIWE round-trip, evalexpr, namehash, ...); also spins up `anvil` for the deterministic ERC-1271 smart-account test (tests/erc1271_anvil.rs) — auto-skips if `anvil` isn't on PATH (CI installs it via foundry, with CV_REQUIRE_ANVIL=1 to make a missing anvil a hard failure)
cargo clippy --workspace --all-targets
cargo fmt
cargo run -p wrapper           # needs env (PORT, HYDRA_ADMIN_URL, SENTRY_*); domain is request-derived
cargo run -p login             # needs env (HYDRA_ADMIN_URL, MAILSERVER_DOMAIN, INDEX_TEMPLATE, STATIC_DIR, ...)
```
The `login` binary serves the SPA from `STATIC_DIR` and renders `INDEX_TEMPLATE` (the frontend-built `index.html`); without a frontend build those paths are absent and `GET /login` 500s — fine for unit tests.

### Frontend (`login/login/frontend`)
```bash
yarn dev              # Vite dev server
yarn build            # Vite build → static/js/{embed,final}.js (unhashed) + hashed main + index.html template
yarn typecheck        # tsc --noEmit (includes stories + tests)
yarn test             # vitest: mounts every Storybook story in jsdom (render check)
yarn storybook        # Storybook v8 (react-vite) on :6006
yarn build-storybook  # static Storybook → storybook-static/
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

### Local cluster via kind (production-faithful; primary local loop)
`tests/kind/setup.sh` brings the whole system up on a local **kind** cluster
(rootless podman), wired like prod: the real Helm charts + Postgres-backed Hydra +
self-signed TLS seeded per ingress host (openssl, no cert-manager; the charts'
`certManagerIssuer` value defaults to `cryptoverse-common` for prod but is `""`
in `values-kind.yaml`) + ingress-nginx on host `:9443`, with
`nip.io` domains (`login.cv.127.0.0.1.nip.io`, `login-demo.cv.127.0.0.1.nip.io`). Iterate by
rebuilding images + `helm upgrade` + `kubectl rollout restart`. See `tests/kind/README.md`.
```bash
tests/kind/setup.sh            # build images, cluster, ingress, self-signed TLS, postgres, deploy
tests/kind/teardown.sh
```
Validate the backend fast with the **harness** (curl-driven, no browser; `tests/harness/`):
```bash
kubectl -n cryptoverse-login port-forward svc/cryptoverse-login-hydra-admin 4445:4445 &
HARNESS_GATEWAY=https://login.cv.127.0.0.1.nip.io:9443 HARNESS_HOST= \
  HARNESS_HYDRA_ADMIN=http://127.0.0.1:4445 pytest tests/harness/ -v
```
The harness drives the full OAuth2 + SIWE flow with a Rust signer but **does not
execute the wallet JS** — the wagmi connect/sign path needs the Selenium suite or a
real browser. Storybook + the vitest render test cover the components in isolation.

### Local full-stack (requires microk8s)
```bash
./setup.sh    # microk8s addons + postgres + Hydra, builds images, helm-installs login + demo app
              # Domains: login.cryptoverse.local, login-demo.cryptoverse.local
```

### Browser/wallet end-to-end tests (`tests/e2e/`)
Playwright + [`@tenkeylabs/dappwright`](https://github.com/TenKeyLabs/dappwright) drive the real Sign-In-with-Ethereum flow against the demo Django app and assert the issued ID-token claims. Three Playwright projects: the **MetaMask** and **Coinbase** browser extensions (real extensions, headed Chromium → need an X display, so run under **xvfb** on Linux/CI), plus a **headless `@reown/walletkit` WalletConnect** test wallet (needs a Reown **projectId**, self-skips without one). Needs a deployed stack — use the **kind** cluster (`tests/kind/setup.sh`). This is the primary end-to-end safety net; it replaced the retired Selenium + Firefox suite (`test_full.py`). See `tests/e2e/README.md`.
```bash
cd tests/e2e && yarn install && npx playwright install chromium
yarn typecheck && yarn test:unit && yarn test:list      # offline sanity (no cluster/display)
xvfb-run --auto-servernum yarn test:e2e:metamask        # MetaMask extension (no projectId)
xvfb-run --auto-servernum yarn test:e2e:coinbase        # Coinbase extension
WALLETCONNECT_PROJECT_ID=<id> yarn test:e2e:walletconnect   # WalletConnect (needs projectId)
```

### CI/CD (GitHub Actions)
- **`build.yml`** (PRs / pushes to `master`): builds gateway/login/wrapper/demo images (login & wrapper from the `login/` context) → DO registry tagged with git SHA → microk8s → `helm dependency update` + `helm install` → the **`tests/harness/`** curl-driven backend suite (the full OAuth2+SIWE flow, device grant, logout, acr/amr, token-gating, introspection, SIWE errors — needs no display; `test_blocklist` is `--ignore`d as it'd restart the Deployment mid-job) → the `tests/e2e/` Playwright + dappwright **MetaMask** project under xvfb. `values.ci.yaml` carries the logout/device Hydra URLs + a public `ethRpcUrl` so the harness's on-chain-dependent cases pass. (Coinbase/WalletConnect e2e projects still aren't wired in — WalletConnect needs a Reown projectId secret.)
- **`release.yml`** (tags `v[0-9]+.[0-9]+.[0-9]+`): decrypts prod values and `helm upgrade`s production. Release by pushing a semver tag.

## Hydra

Subchart `hydra` is pinned in `charts/login/Chart.yaml` (currently **0.62.1 → Ory Hydra v26.2.0**, the 2.x line). Hydra config lives under the `hydra:` block in `charts/login/values*.yaml`. The chart is apiVersion v2; the dependency lock is regenerated by `helm dependency update` (there is no committed lock).

Hydra issues **JWT access tokens** (`strategies.access_token: jwt`) signed by the published JWKS, so relying parties validate them offline (introspection still works; JWT access tokens can't be revoked before expiry — keep TTLs short). The **device grant** (RFC 8628) is wired via `urls.device.{verification,success}` pointing at the login backend's `/device` page; clients opt in with the `urn:ietf:params:oauth:grant-type:device_code` grant type. Custom access-token claims (e.g. `cv_identities`) land under the token's `ext` claim. New env knobs surfaced in `values.yaml`: `SIWE_CHAIN_ID`, `SIWE_STATEMENT`, `RPC_TIMEOUT_MS`, `ETH_RPC_URL_FALLBACK`, `EMAIL_VERIFIED_CLAIM`.
