# Production-faithful local cluster on kind

Brings up the whole system on a local [kind](https://kind.sigs.k8s.io/) cluster
(rootless podman), wired and exposed **like production** — so you can iterate
with the real deploy and prove correctness:

- the *same* Helm charts: gateway (HAProxy) + login + wrapper + **Ory Hydra 2.x**
  + hydra-maester + the demo relying party
- **Postgres-backed Hydra** (not in-memory) with the chart's automigration
- **self-signed TLS** seeded per ingress host (openssl, like TokenTube's
  `infra/up.sh`) — no cert-manager; the charts set `certManagerIssuer=""` so the
  ingress carries no cert-manager annotation and nothing reissues the cert
- **ingress-nginx** on host `:9443` (→ node `:443`), `nip.io` domains
- optional Prometheus (`WITH_MONITORING=1`)

Validate it with the [`tests/harness/`](../harness/) suite (fast, no browser) and
the browser/wallet [`tests/e2e/`](../e2e/README.md) suite (Playwright + dappwright).

## One-time host prerequisites

A kind node needs plenty of inotify instances (one sysctl, needs root):

```bash
sudo sysctl -w fs.inotify.max_user_instances=512 fs.inotify.max_user_watches=524288
# persist (optional):
echo -e "fs.inotify.max_user_instances=512\nfs.inotify.max_user_watches=524288" \
  | sudo tee /etc/sysctl.d/99-kind-cryptoverse.conf
```

`setup.sh` checks it and exits with the exact command if it isn't set. **No port
sysctl is needed** — the ingress is published on the high host port `9443` (→
node `443`), which rootless podman can bind.

### Domain/port-agnostic

The services have no hardcoded domain, port, or scheme: the gateway, login, and
wrapper all derive the public origin from the request the ingress forwards
(`X-Forwarded-Host` / `X-Forwarded-Proto`, falling back to `Host`). So the system
works on whatever host:port the ingress is configured for — here
`login.cv.127.0.0.1.nip.io:9443`. Hydra's issuer is the one fixed value (an OIDC
requirement), set in `values-kind.yaml`.

## Run

```bash
tests/kind/setup.sh              # build images, cluster, ingress, self-signed TLS, postgres, deploy
# WITH_MONITORING=1 tests/kind/setup.sh   # also install kube-prometheus-stack
tests/kind/teardown.sh
```

`setup.sh` is idempotent (skips already-built images and an existing cluster) and
prints the exact harness + Selenium commands when it finishes.

## Layout

| file | purpose |
|---|---|
| `cluster.yaml` | kind cluster (ingress-ready node, host `:9443` → node `:443`) |
| `postgres.yaml` | Postgres for Hydra |
| `values-kind.yaml` | login chart overrides (nip.io domain, local images, Postgres DSN, `certManagerIssuer=""`) |
| `values-demo-kind.yaml` | demo chart overrides (browser vs in-cluster OIDC endpoints) |
| `setup.sh` / `teardown.sh` | bring up / tear down |

## Notes

- Domains are `login.cv.127.0.0.1.nip.io` / `login-demo.cv.127.0.0.1.nip.io` (resolve to
  127.0.0.1, no `/etc/hosts`). TLS is a **self-signed cert per host** seeded by
  `setup.sh` (openssl, like TokenTube's `infra/up.sh`) straight into the secret
  the chart's ingress references — no cert-manager. Over a port-forward the
  browser warns once per host; accept it. Because the login iframe loads the
  login host and a browser **can't prompt for a cert inside an iframe**, trust
  the login host first — open `https://login.cv.127.0.0.1.nip.io:9443/` directly
  and accept (or import) its cert, then the demo's iframe loads. The harness uses
  `curl -k`; the Playwright e2e suite sets `ignoreHTTPSErrors`. Delete a TLS
  secret to regenerate its cert.
- ENS / Unstoppable Domains lookups have no RPC key here and resolve to empty for
  the test account — matching the expected ID-token claims.
- The demo pod only starts once hydra-maester has minted the `demo-oauth2client`
  secret; `setup.sh` waits for that.
