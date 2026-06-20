# Production-faithful local cluster on kind

Brings up the whole system on a local [kind](https://kind.sigs.k8s.io/) cluster
(rootless podman), wired and exposed **like production** — so you can iterate
with the real deploy and prove correctness:

- the *same* Helm charts: gateway (HAProxy) + login + wrapper + **Ory Hydra 2.x**
  + hydra-maester + the demo relying party
- **Postgres-backed Hydra** (not in-memory) with the chart's automigration
- **cert-manager** issuing the ingress TLS via the `cryptoverse-common`
  ClusterIssuer — the chart annotations work unmodified
- **ingress-nginx** on host `:9443` (→ node `:443`), `nip.io` domains
- optional Prometheus (`WITH_MONITORING=1`)

Validate it with the [`tests/harness/`](../harness/) suite (fast, no browser) and
the Selenium browser/wallet test (`../test_full.py`).

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
`login.127.0.0.1.nip.io:9443`. Hydra's issuer is the one fixed value (an OIDC
requirement), set in `values-kind.yaml`.

## Run

```bash
tests/kind/setup.sh              # build images, cluster, ingress, cert-manager, postgres, deploy
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
| `clusterissuer.yaml` | self-signed `cryptoverse-common` ClusterIssuer (cert-manager) |
| `values-kind.yaml` | login chart overrides (nip.io domain, local images, Postgres DSN) |
| `values-demo-kind.yaml` | demo chart overrides (browser vs in-cluster OIDC endpoints) |
| `setup.sh` / `teardown.sh` | bring up / tear down |

## Notes

- Domains are `login.127.0.0.1.nip.io` / `demo.127.0.0.1.nip.io` (resolve to
  127.0.0.1, no `/etc/hosts`). The CA is cert-manager's self-signed issuer; the
  harness uses `curl -k` and the Selenium test sets `acceptInsecureCerts`. For a
  fully-trusted local CA, swap in `mkcert` and seed a cert-manager CA Issuer.
- ENS / Unstoppable Domains lookups have no RPC key here and resolve to empty for
  the test account — matching the expected ID-token claims.
- The demo pod only starts once hydra-maester has minted the `demo-oauth2client`
  secret; `setup.sh` waits for that.
