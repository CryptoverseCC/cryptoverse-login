#!/usr/bin/env bash
#
# Bring up the full Cryptoverse Login stack on a local kind cluster (rootless
# podman), wired and exposed like production:
#   - the real Helm charts (gateway + login + wrapper + Ory Hydra 2.x + maester)
#   - Postgres-backed Hydra (not in-memory)
#   - self-signed TLS certs seeded per ingress host (no cert-manager; TokenTube-style)
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

say "Namespaces + Postgres for Hydra"
for ns in "$NS_LOGIN" "$NS_DEMO"; do
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
done

# TLS: a self-signed cert per ingress host, seeded straight into the secret the
# chart's ingress references — no cert-manager (same approach as TokenTube's
# infra/up.sh). values-kind.yaml sets certManagerIssuer="" so the ingress carries
# no cert-manager annotation and nothing reissues/overwrites these. The cert is
# kept across runs once present; delete the secret to regenerate (e.g. after a
# domain change — the SAN check below also regenerates if the host no longer matches).
seed_selfsigned_tls() {  # $1=host  $2=namespace  $3=secretName
  if kubectl -n "$2" get secret "$3" -o jsonpath='{.data.tls\.crt}' 2>/dev/null \
       | base64 -d 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null \
       | grep -q "DNS:$1"; then
    echo "  $2/$3: keeping existing self-signed cert for $1"; return
  fi
  local d; d=$(mktemp -d)
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "$d/tls.key" -out "$d/tls.crt" \
    -subj "/CN=$1" -addext "subjectAltName=DNS:$1" >/dev/null 2>&1
  kubectl create secret tls "$3" -n "$2" --cert="$d/tls.crt" --key="$d/tls.key" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  rm -rf "$d"
  echo "  $2/$3: new self-signed cert (CN/SAN=$1)"
}
say "Self-signed TLS certs for the ingress hosts (no cert-manager)"
seed_selfsigned_tls "$LOGIN_DOMAIN" "$NS_LOGIN" cryptoverse-login
seed_selfsigned_tls "$DEMO_DOMAIN"  "$NS_DEMO"  login-demo-tls
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

say "Deploying login chart (Postgres-backed Hydra, self-signed TLS)"
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

say "Registering the ETHMail webclient OAuth2 client"
# ETHMail's webclient (separate repo: Webclient/charts/ethmail-webclient/values-local.yaml)
# expects a Hydra client `ethmail-webclient` with this exact id/secret + the mail and
# offline_access scopes + the `ethmail` audience. We register it via the admin API (the
# OAuth2Client CRD would mint a random client_id; ETHMail needs this fixed one). Idempotent;
# skips gracefully if the admin API isn't reachable. webmail.cv... is allowlisted for the
# final-redirect in values-kind.yaml so the browser login completes.
ETHMAIL_WC_SECRET="ethmail-webclient-secret" # pragma: allowlist secret
kubectl -n "$NS_LOGIN" port-forward svc/cryptoverse-login-hydra-admin 4455:4445 >/dev/null 2>&1 &
HPF=$!
for i in $(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:4455/health/ready 2>/dev/null && break || sleep 0.5; done
curl -fsS -o /dev/null -X DELETE http://127.0.0.1:4455/admin/clients/ethmail-webclient 2>/dev/null || true
curl -fsS -o /dev/null -X POST http://127.0.0.1:4455/admin/clients \
  -H 'Content-Type: application/json' --data @- <<JSON && echo "  registered client_id=ethmail-webclient" || echo "  (ethmail-webclient registration skipped — admin API not reachable)"
{
  "client_id": "ethmail-webclient",
  "client_secret": "$ETHMAIL_WC_SECRET",
  "client_name": "ETHMail Webclient (RoundCube)",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "openid email profile offline_access mail",
  "audience": ["ethmail"],
  "redirect_uris": [
    "https://webmail.cv.127.0.0.1.nip.io:9443/index.php/login/oauth",
    "https://webmail.cv.127.0.0.1.nip.io/index.php/login/oauth"
  ],
  "token_endpoint_auth_method": "client_secret_post"
}
JSON
kill "$HPF" 2>/dev/null || true

say "Verifying OIDC discovery through the ingress"
curl -fsSk "$LOGIN_URL/.well-known/openid-configuration" | head -c 160 || \
  echo "(discovery not ready yet — give Hydra a few more seconds)"

cat <<EOF

== Ready ==
Login:  $LOGIN_URL/      Demo: $DEMO_URL/

TLS is a self-signed cert per host (no CA). Over a port-forward the browser warns
once per host — accept it. The login UI also loads inside an iframe on the demo,
and a browser can't show a cert prompt inside an iframe, so trust the LOGIN host
first: open $LOGIN_URL/ directly and accept (or import) its cert, then the demo's
iframe loads. Export a cert to import into your OS/browser trust store with:
  kubectl -n $NS_LOGIN get secret cryptoverse-login -o jsonpath='{.data.tls\\.crt}' | base64 -d > login.crt

Prove it works (fast, no browser):
  kubectl -n $NS_LOGIN port-forward svc/cryptoverse-login-hydra-admin 4445:4445 &
  HARNESS_GATEWAY=$LOGIN_URL HARNESS_HOST= HARNESS_HYDRA_ADMIN=http://127.0.0.1:4445 \\
    pytest tests/harness/ -v

Full browser/wallet e2e (Playwright + dappwright; see tests/e2e/README.md):
  cd tests/e2e && yarn install && npx playwright install chromium
  xvfb-run --auto-servernum yarn test:e2e:metamask

Tear down: tests/kind/teardown.sh
EOF
