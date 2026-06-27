# Acceptance — `just deploy` gate (`just e2e`)

`just deploy` runs an acceptance test (step 5/6) after Argo CD reports Healthy, so
a deploy only "succeeds" if a real login actually works against the just-rolled
version — not just if the pods are up. Two flavours:

| recipe | what | needs |
|---|---|---|
| **`just e2e`** (the gate) | **REAL browser + wallet** — Playwright drives a real MetaMask extension through the full SIWE login (the actual frontend: wagmi connect, the Comlink iframe↔parent handshake, in-browser EIP-4361 building, the wallet popup). Runner: [`tests/e2e/run-e2e.sh`](../e2e/run-e2e.sh). | a **non-snap** node (see below), the `tests/e2e` deps, and an `Xvfb` (host display or the binary inside podman's container-overlay storage — no apt/sudo) |
| `just e2e-api` | fast **headless backend** flow — `demo_login.py` drives the same login with a programmatic `eth_account` signer (no browser/display) and asserts the demo's ID-token claims. Good for a quick local check. | `python3` + `requests` + `eth_account` |

Both drive the login **through the demo RP** and end on the demo's own success
page, so they verify the demo↔IdP integration, not just the IdP in isolation.

```bash
just e2e                         # real browser gate, defaults to the local hosts
just e2e <demo_url> <login_url>
just e2e-api                     # fast headless backend check
E2E_PROJECT=coinbase just e2e    # the runner also supports the Coinbase extension
```

## Why a non-snap node (gotcha)

The gate runs **detached / no-TTY** (that's how `just deploy` and the background
commit hook invoke it). A **snap-confined** `node` (`/snap/bin/node`) **swallows
stdout and fails to drive an external browser** in that context — the test exits
1 with no output. `run-e2e.sh` therefore prefers `~/.local/nodejs/bin/node` and
**refuses to run under snap node** with a clear message. Install a non-snap node
once (no sudo):

```bash
mkdir -p ~/.local/nodejs
curl -fsSL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz \
  | tar -xJ -C ~/.local/nodejs --strip-components=1
```

## `demo_login.py` (the `e2e-api` flow)

Drives the complete OAuth2 + OIDC + EIP-4361 (SIWE) flow with a programmatic
signer instead of a wallet UI:

```
demo /protected → IdP authorize → Hydra login_challenge → /login (read SIWE params)
  → sign EIP-4361 with a test key → POST /login/process → consent (auto-accept)
  → demo /oidc/callback (demo exchanges the code) → demo success page
  → ASSERT sub == signer address (lowercased) and email == {sub}@{MAILSERVER_DOMAIN}
```

Asserts only deterministic address-derived claims (`sub`, `email`), so it doesn't
depend on external mainnet RPC (ENS/UD). Env overrides: `DEMO_URL`, `LOGIN_URL`,
`ACCEPT_KEY` (default Hardhat #1), `MAILSERVER_DOMAIN` (default `ethmail.cc`).

## Relationship to the other test layers

- `tests/harness/` — backend HTTP correctness against the **IdP directly**.
- `tests/e2e/` — the real browser + wallet Playwright suite (MetaMask/Coinbase/WC);
  `just e2e` reuses its `metamask` project as the deploy gate.
- `tests/acceptance/` — **this**: the `just deploy` gate wiring (`just e2e` →
  real browser; `just e2e-api` → headless backend).
