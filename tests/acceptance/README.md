# Acceptance — `just deploy` gate (`just e2e`)

`just deploy` runs an acceptance test (step 5/6) after Argo CD reports Healthy, so
a deploy only "succeeds" if a real login actually works against the just-rolled
version — not just if the pods are up. Two flavours:

| recipe | what | needs |
|---|---|---|
| **`just e2e`** (the gate) | **REAL browser + wallet, in a self-contained container.** Playwright drives a real MetaMask extension through the full SIWE login (the actual frontend: wagmi connect, the Comlink iframe↔parent handshake, in-browser EIP-4361 building, the wallet popup). Runner: [`tests/e2e/run-e2e.sh`](../e2e/run-e2e.sh); image: [`tests/e2e/Dockerfile`](../e2e/Dockerfile). | **only `podman`/`docker`** + a reachable stack — Node, the browsers, xvfb, deps and the wallet extension are all baked into the image |
| `just e2e-api` | fast **headless backend** flow — `demo_login.py` drives the same login with a programmatic `eth_account` signer (no browser/display) and asserts the demo's ID-token claims. | `python3` + `requests` + `eth_account` |

Both drive the login **through the demo RP** and end on the demo's own success
page, so they verify the demo↔IdP integration, not just the IdP in isolation.

```bash
just e2e                         # real browser gate (container), defaults to local hosts
just e2e <demo_url> <login_url>
just e2e-api                     # fast headless backend check
E2E_PROJECT=coinbase just e2e    # the image also supports the Coinbase extension
```

## How the gate runs (container) — and the gotchas

`run-e2e.sh` builds `tests/e2e/Dockerfile` (FROM `mcr.microsoft.com/playwright:v1.61.0`,
pinned to match `@playwright/test`) and runs it `--network=host` so `127.0.0.1:18443`
in the container is the host's ingress. Three things that took iterating and must
stay:

1. **Nothing from the host.** Node/browsers/xvfb/deps are in the image. (This
   replaced an earlier host-node approach that failed because the only host `node`
   was a **snap**, which swallows stdout and won't drive a browser detached.)
2. **Pre-baked extension.** dappwright lazily downloads the wallet extension on
   first bootstrap; doing that at *runtime inside a Playwright worker in a
   container* deadlocks. The Dockerfile pre-downloads it at **build** time
   (`precache-wallet.cjs`, `TEST_PARALLEL_INDEX=0`), so the test never downloads.
3. **`-t` + output to a file.** dappwright's setup needs a TTY (`podman run -t`),
   but streaming straight to stdout under `-t` causes **PTY backpressure** that
   blocks the test when the reader is a pipe/file. The image runs the test with
   output to an in-container file and `cat`s it once at the end.
4. **`--add-host`** maps the nip.io/local hostnames to `127.0.0.1` so the
   host-networked container needs no DNS; real CI hostnames resolve normally.

`--network=host` + nip.io is loopback-specific; in CI against a routable stack,
pass real `DEMO_URL`/`LOGIN_URL` and the `--add-host` overrides simply don't apply.

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
  `just e2e` containerizes its `metamask` project as the deploy gate.
- `tests/acceptance/` — **this**: the `just deploy` gate wiring (`just e2e` →
  containerized real browser; `just e2e-api` → headless backend).
