#!/usr/bin/env bash
#
# Bring up the full Cryptoverse Login stack on a local kind cluster (rootless
# podman), wired and exposed like production:
#   - the real Helm charts (gateway + login + wrapper + Ory Hydra 2.x + maester)
#   - Postgres-backed Hydra (not in-memory)
#   - cert-manager issuing the ingress TLS via the cryptoverse-common ClusterIssuer
#   - ingress-nginx on :443, nip.io domains
#   - the demo relying party
#
# Then validate it with the harness (tests/harness/) and/or the browser/wallet
# end-to-end suite (tests/e2e/, Playwright + dappwright).
#
set -euo pipefail
export KIND_EXPERIMENTAL_PROVIDER=podman

CLUSTER=cryptoverse-login
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIND_DIR="$REPO/tests/kind"
NS_LOGIN=cryptoverse-login
NS_DEMO=cryptoverse-login-demo
LOGIN_DOMAIN=login.cv.127.0.0.1.nip.io
DEMO_DOMAIN=login-demo.cv.127.0.0.1.nip.io
PORT=9443   # host port mapped to the ingress (node :443); services are port-agnostic
LOGIN_URL="https://$LOGIN_DOMAIN:$PORT"
DEMO_URL="https://$DEMO_DOMAIN:$PORT"
INGRESS_NGINX="https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/kind/deploy.yaml"
CERT_MANAGER="https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml"

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

say "Checking prerequisites"
for t in podman kind kubectl helm; do command -v "$t" >/dev/null || die "missing tool: $t"; done
inst=$(sysctl -n fs.inotify.max_user_instances 2>/dev/null || echo 0)
[ "$inst" -ge 512 ] || die "fs.inotify.max_user_instances=$inst too low for a kind node.
  sudo sysctl -w fs.inotify.max_user_instances=512 fs.inotify.max_user_watches=524288"

say "Building images (skipping any already built)"
build() { podman image exists "$1" || podman build -t "$@"; }
build localhost/cryptoverse-login/login:test             -f "$REPO/login/login/Dockerfile"   "$REPO/login"
build localhost/cryptoverse-login/wrapper:test           -f "$REPO/login/wrapper/Dockerfile" "$REPO/login"
build localhost/cryptoverse-login/gateway:test           "$REPO/login/gateway"
build localhost/cryptoverse-login/demo-python-django:test "$REPO/tests/cryptoverse-login-demo/demo"

if ! kind get clusters | grep -qx "$CLUSTER"; then
  say "Creating kind cluster '$CLUSTER' (rootless podman)"
  systemd-run --user --scope -p "Delegate=yes" \
    kind create cluster --config "$KIND_DIR/cluster.yaml"
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

say "Installing ingress-nginx"
kubectl apply -f "$INGRESS_NGINX"
# The controller pod isn't created the instant `apply` returns, and `kubectl
# wait` errors on a not-yet-existing resource — so wait on the Deployment.
until kubectl -n ingress-nginx get deploy/ingress-nginx-controller >/dev/null 2>&1; do sleep 2; done
kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=180s
kubectl annotate ingressclass nginx ingressclass.kubernetes.io/is-default-class=true --overwrite

say "Installing cert-manager + mkcert-backed cryptoverse-common CA issuer"
kubectl apply -f "$CERT_MANAGER"
until kubectl -n cert-manager get deploy/cert-manager-webhook >/dev/null 2>&1; do sleep 2; done
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=180s
# Back the issuer with a local mkcert CA so both hosts' certs chain to one root
# you can trust on the machine running your browser (no per-host warnings).
if ! command -v mkcert >/dev/null; then
  curl -fsSL -o "$HOME/.local/bin/mkcert" \
    https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-linux-amd64
  chmod +x "$HOME/.local/bin/mkcert"
fi
CAROOT=$(mkcert -CAROOT)
# Create the CA if it doesn't exist yet (issue a throwaway cert; no trust-store install).
[ -f "$CAROOT/rootCA.pem" ] || mkcert -cert-file /tmp/_mkcert.pem -key-file /tmp/_mkcert-key.pem localhost >/dev/null 2>&1
kubectl -n cert-manager create secret tls cryptoverse-ca \
  --cert="$CAROOT/rootCA.pem" --key="$CAROOT/rootCA-key.pem" \
  --dry-run=client -o yaml | kubectl apply -f -
# Retry the issuer until the validating webhook is actually serving.
until kubectl apply -f "$KIND_DIR/clusterissuer.yaml" 2>/dev/null; do sleep 3; done

say "Namespaces + Postgres for Hydra"
for ns in "$NS_LOGIN" "$NS_DEMO"; do
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
done
kubectl apply -f "$KIND_DIR/postgres.yaml"
until kubectl -n "$NS_LOGIN" get deploy/postgres >/dev/null 2>&1; do sleep 2; done
kubectl -n "$NS_LOGIN" rollout status deploy/postgres --timeout=120s

MON_FLAGS=()
if [ "${WITH_MONITORING:-0}" = "1" ]; then
  say "Installing kube-prometheus-stack (WITH_MONITORING=1)"
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo update >/dev/null
  helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
    -n monitoring --create-namespace --wait --timeout 8m
  MON_FLAGS=(--set monitoring.enabled=true)
fi

say "Loading images into kind"
# `kind load docker-image` doesn't reliably detect podman images, so go via an
# archive (podman save | kind load image-archive).
archive=$(mktemp --suffix=.tar)
for img in login wrapper gateway demo-python-django; do
  rm -f "$archive"   # podman save can't overwrite an existing docker-archive
  podman save -o "$archive" "localhost/cryptoverse-login/$img:test"
  kind load image-archive "$archive" --name "$CLUSTER"
done
rm -f "$archive"

# Use a real mainnet RPC from the gitignored root .env (e.g. an Alchemy URL) when
# present, overriding the public fallback in values-kind.yaml. ALCHEMY_URL is a
# full URL so it maps to ETH_RPC_URL; the key never enters git (.env is ignored).
RPC_FLAGS=()
if [ -f "$REPO/.env" ]; then set +e; . "$REPO/.env"; set -e; fi
if [ -n "${ALCHEMY_URL:-}" ]; then
  say "Using ALCHEMY_URL from .env as ETH_RPC_URL"
  RPC_FLAGS=(--set-string "ethRpcUrl=$ALCHEMY_URL")
fi

say "Deploying login chart (Postgres-backed Hydra, cert-manager TLS)"
helm dependency update "$REPO/charts/login" >/dev/null
helm upgrade --install cryptoverse-login "$REPO/charts/login" \
  -n "$NS_LOGIN" -f "$KIND_DIR/values-kind.yaml" "${RPC_FLAGS[@]}" "${MON_FLAGS[@]}" --wait --timeout 6m

say "Deploying demo chart"
helm upgrade --install demo "$REPO/tests/cryptoverse-login-demo/charts/demo" \
  -n "$NS_DEMO" -f "$KIND_DIR/values-demo-kind.yaml"
echo "Waiting for hydra-maester to mint the demo OAuth2Client secret..."
for i in $(seq 1 60); do
  kubectl -n "$NS_DEMO" get secret demo-oauth2client >/dev/null 2>&1 && break || sleep 5
done
kubectl -n "$NS_DEMO" rollout status deploy/demo --timeout=180s || true

say "Verifying OIDC discovery through the ingress"
curl -fsSk "$LOGIN_URL/.well-known/openid-configuration" | head -c 160 || \
  echo "(discovery not ready yet — give Hydra a few more seconds)"

cat <<EOF

== Ready ==
Login:  $LOGIN_URL/      Demo: $DEMO_URL/

Trust the local CA on the machine running your browser (one time, no warnings):
  CA root: $CAROOT/rootCA.pem
  - same machine: mkcert -install
  - remote browser (e.g. over VS Code/SSH): copy that file over and, on a Mac,
      'mkcert -install' (brew install mkcert nss) or import it into Firefox
      (Settings > Privacy & Security > Certificates > View Certificates >
       Authorities > Import, trust for websites).

Prove it works (fast, no browser):
  kubectl -n $NS_LOGIN port-forward svc/cryptoverse-login-hydra-admin 4445:4445 &
  HARNESS_GATEWAY=$LOGIN_URL HARNESS_HOST= HARNESS_HYDRA_ADMIN=http://127.0.0.1:4445 \\
    pytest tests/harness/ -v

Full browser/wallet e2e (Playwright + dappwright; see tests/e2e/README.md):
  cd tests/e2e && yarn install && npx playwright install chromium
  xvfb-run --auto-servernum yarn test:e2e:metamask

Tear down: tests/kind/teardown.sh
EOF
