# IdP test harness

A deterministic, browser-free suite that proves the identity provider works
end-to-end. It drives the **real** flow over HTTP — OIDC discovery, the
authorization-code + Sign-In-with-Ethereum login, consent, token exchange, ID
token claims, token-gating, and introspection — so you can change the system and
re-run for confidence in seconds.

It signs SIWE messages with a fixed test key (via the Rust `sign` example), so
there's no wallet/MetaMask in the critical path. The browser/wallet dimension is
covered separately by the [`../e2e/`](../e2e/README.md) suite (Playwright + dappwright).

## What it checks

| file | proves |
|---|---|
| `test_discovery.py` | `/.well-known/openid-configuration` + JWKS are served |
| `test_login_flow.py` | full SIWE auth-code flow → ID token `sub`/email/names; `/userinfo` |
| `test_siwe_errors.py` | bad signature, wrong/replayed nonce, and expired messages are rejected |
| `test_token_gating.py` | `metadata.restrictions` allow/deny by on-chain balance |
| `test_introspection.py` | `/oauth2/introspect` requires basic auth and reports tokens active |

## Prerequisites

- `curl`, `pytest`, and the SIWE signer:
  ```bash
  cargo build -p cryptoverse-core --example sign --manifest-path login/Cargo.toml
  pip install -r tests/harness/requirements.txt
  ```

## Run against the local podman stack

The defaults target `local-stack/` (bring it up first — see `local-stack/README.md`):

```bash
podman kube play local-stack/cryptoverse-stack.yaml
pytest tests/harness/ -v
```

## Run against the kind cluster

Point the env at the deployment (Hydra admin isn't exposed publicly, so
port-forward it):

```bash
kubectl -n cryptoverse-login port-forward svc/cryptoverse-login-hydra-admin 4445:4445 &
HARNESS_GATEWAY=https://login.127.0.0.1.nip.io:9443 \
HARNESS_HOST= \
HARNESS_HYDRA_ADMIN=http://127.0.0.1:4445 \
  pytest tests/harness/ -v
```

## Configuration

| env var | default (podman) | meaning |
|---|---|---|
| `HARNESS_GATEWAY` | `http://127.0.0.1:8000` | public gateway base URL |
| `HARNESS_HOST` | `login.cryptoverse.local` | `Host` header (empty for real domains) |
| `HARNESS_HYDRA_ADMIN` | `http://127.0.0.1:4445` | Hydra admin API (client lifecycle) |
| `HARNESS_INTROSPECT_USER` / `_PASS` | `introspect` / `introspectpw` | gateway introspect basic-auth |
| `HARNESS_MAILSERVER_DOMAIN` | `ethmail.cc` | expected generated-email domain |
| `HARNESS_SIGNER` | `login/target/debug/examples/sign` | SIWE signer binary |
