# Acceptance test — full SIWE login through the demo RP (`tests/acceptance/`)

A single deterministic, headless end-to-end check that the **deployed** IdP
version really logs the **demo relying party** in and issues correct claims. It
is the gate `just deploy` runs (step 5/6) after Argo CD reports Healthy, so a
deploy only "succeeds" if a real login actually works — not just if the pods are
up.

## What it does

`demo_login.py` drives the complete OAuth2 + OIDC + EIP-4361 (SIWE) flow exactly
as a browser+wallet would, but with a **programmatic signer** (`eth_account`)
instead of a wallet UI — so it needs **no browser, no xvfb, no extension, no
WalletConnect projectId**, which is what makes it safe to run on every deploy
(including the background commit-hook deploy).

```
demo /protected → IdP authorize → Hydra login_challenge → /login (read SIWE params)
  → sign EIP-4361 with a test key → POST /login/process → consent (auto-accept)
  → demo /oidc/callback (demo exchanges the code server-side) → demo success page
  → ASSERT sub == signer address (lowercased) and email == {sub}@{MAILSERVER_DOMAIN}
```

It asserts only the **deterministic, address-derived** claims (`sub`, `email`),
so it does not depend on external mainnet RPC (ENS/UD resolution) and stays
reliable as a deploy gate.

## Run it

```bash
just e2e                                   # defaults to the local heavyops hosts
just e2e <demo_url> <login_url>            # or point at any deployed stack
python3 tests/acceptance/demo_login.py <demo_url> <login_url>   # directly
```

Needs `python3` + `requests` + `eth_account`. Env overrides: `DEMO_URL`,
`LOGIN_URL`, `ACCEPT_KEY` (signer private key, default Hardhat #1),
`MAILSERVER_DOMAIN` (default `ethmail.cc`), `ACCEPT_TIMEOUT`.

## Relationship to the other test layers

- `tests/harness/` — backend HTTP correctness against the **IdP directly**.
- `tests/e2e/` — real browser + **real wallet** (MetaMask/Coinbase/WC); highest
  fidelity, needs a display/extension or a Reown projectId.
- `tests/acceptance/` — **this**: the one headless, no-dependency, full-login
  check wired into `just deploy` as the per-deploy acceptance gate.
