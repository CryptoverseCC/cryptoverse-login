# Local stack (podman) with real Hydra

Brings up the **full** Cryptoverse Login stack — postgres + Ory Hydra 2.x +
login + wrapper + gateway — in a single podman pod, and drives a **headless**
OAuth2 authorization-code + OIDC login through it, signing the EIP-4361 (SIWE)
message with a test key (no browser/wallet needed).

This exercises everything the Selenium suite does except the browser/wallet UI:
real Hydra as the token engine, the HAProxy gateway routing (including the
consent → `/oauth2/final` `Location` rewrite), SIWE verification, consent
auto-accept, and ID-token enrichment.

## Prerequisites

- `podman` (rootless is fine)
- Build the three service images and the SIWE signer helper:

  ```bash
  # service images (build context = the Cargo workspace root, login/)
  podman build -t localhost/cryptoverse-login/login:test   -f login/login/Dockerfile   login
  podman build -t localhost/cryptoverse-login/wrapper:test -f login/wrapper/Dockerfile login
  podman build -t localhost/cryptoverse-login/gateway:test login/gateway

  # SIWE signer used by the smoke test
  cargo build -p cryptoverse-core --example sign --manifest-path login/Cargo.toml
  ```

## Run

```bash
podman kube play local-stack/cryptoverse-stack.yaml

# wait ~5s for Hydra to migrate + serve, then verify discovery:
curl -s -H "Host: login.cryptoverse.local" \
  http://127.0.0.1:8000/.well-known/openid-configuration | python3 -m json.tool

# drive the full OAuth + SIWE flow:
python3 local-stack/smoke_test.py

# tear down:
podman kube down local-stack/cryptoverse-stack.yaml
```

`smoke_test.py` prints each step and the decoded ID-token claims, asserting that
`sub` and the enriched `email` match the signing address.

## Notes

- Containers in the pod share one network namespace (they reach each other via
  `127.0.0.1:<port>`); only the gateway (`8000`) and Hydra admin (`4445`) are
  published to the host.
- Hydra runs in `--dev` mode so it accepts the local `http` issuer. **Do not use
  this manifest in production** — it has dev secrets and no TLS.
- This is for local validation only; the production deployment is the Helm chart
  in `charts/login` (real Hydra chart, Ingress/TLS, Postgres, ServiceMonitor).
