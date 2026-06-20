# Local end-to-end on kind

Brings up the real charts (gateway + login + wrapper + **Ory Hydra 2.x** +
hydra-maester) and the demo relying party on a local [kind](https://kind.sigs.k8s.io/)
cluster using **rootless podman**, ready for the Selenium suite in `tests/`.

This deploys the *same Helm charts* used in production (CI uses `dsn: memory`
for Hydra; so do we), so it validates the charts + images, not just the binaries.

## One-time host prerequisites

A kind node and a rootless `:443` bind need two sysctls (kind nodes are
inotify-heavy, and rootless podman can't bind ports `<1024` by default):

```bash
sudo sysctl -w fs.inotify.max_user_instances=512 fs.inotify.max_user_watches=524288
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=443
# persist (optional):
echo -e "fs.inotify.max_user_instances=512\nfs.inotify.max_user_watches=524288\nnet.ipv4.ip_unprivileged_port_start=443" \
  | sudo tee /etc/sysctl.d/99-kind-cryptoverse.conf
```

`:443` must be free on the host (other kind clusters often use high ports like
`8443`, so this usually doesn't clash). `setup.sh` checks both sysctls and exits
with the exact command if they're not set.

## Why :443 (not a high port)

The gateway rewrites Hydra's consent redirect to `https://${DOMAIN}/oauth2/final`
with **no port**, and nginx strips the port from the upstream `Host` header — so
the public origin must be standard `:443`. Keeping it on 443 means the charts run
**unmodified** (production-faithful).

## Run

```bash
tests/kind/setup.sh        # build images, create cluster, ingress, certs, deploy
# ... then the Selenium suite (setup.sh prints the exact command) ...
tests/kind/teardown.sh
```

`setup.sh` is idempotent: it skips already-built images and an existing cluster.

## Layout

| file | purpose |
|---|---|
| `cluster.yaml` | kind cluster (ingress-ready node, host `:443` → node `:443`) |
| `values-kind.yaml` | login chart overrides (nip.io domain, local images, Hydra `dsn: memory`) |
| `values-demo-kind.yaml` | demo chart overrides (browser vs in-cluster OIDC endpoints) |
| `setup.sh` / `teardown.sh` | bring up / tear down |

## Notes

- Domains are `login.127.0.0.1.nip.io` / `demo.127.0.0.1.nip.io` (resolve to
  127.0.0.1 with no `/etc/hosts`). Certs are self-signed; the Selenium test sets
  `acceptInsecureCerts`.
- ENS / Unstoppable Domains lookups have no RPC key here and resolve to empty for
  the test account — matching the expected ID-token claims in `test_full.py`.
- The demo pod only starts once hydra-maester has reconciled its `OAuth2Client`
  and created the `demo-oauth2client` secret; `setup.sh` waits for that.
