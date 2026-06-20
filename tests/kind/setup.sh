#!/usr/bin/env bash
#
# Bring up the full Cryptoverse Login stack on a local kind cluster (rootless
# podman) and deploy the demo RP, ready for the Selenium suite in tests/.
#
# The cluster runs on standard :443 (the gateway hardcodes https://${DOMAIN}),
# using nip.io domains (resolve to 127.0.0.1 — no /etc/hosts needed) and
# self-signed certs (the test sets acceptInsecureCerts).
#
set -euo pipefail
export KIND_EXPERIMENTAL_PROVIDER=podman

CLUSTER=cryptoverse-login
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NS_LOGIN=cryptoverse-login
NS_DEMO=cryptoverse-login-demo
LOGIN_DOMAIN=login.127.0.0.1.nip.io
DEMO_DOMAIN=demo.127.0.0.1.nip.io
INGRESS_NGINX="https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/kind/deploy.yaml"

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

say "Checking prerequisites"
for t in podman kind kubectl helm openssl; do command -v "$t" >/dev/null || die "missing tool: $t"; done

# kind nodes need plenty of inotify instances; binding rootless :443 needs the
# unprivileged port range lowered. Both are one-time host sysctls (need sudo).
inst=$(sysctl -n fs.inotify.max_user_instances 2>/dev/null || echo 0)
[ "$inst" -ge 512 ] || die "fs.inotify.max_user_instances=$inst is too low for a kind node.
  sudo sysctl -w fs.inotify.max_user_instances=512 fs.inotify.max_user_watches=524288"
ups=$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo 1024)
[ "$ups" -le 443 ] || die "net.ipv4.ip_unprivileged_port_start=$ups prevents rootless binding of :443.
  sudo sysctl -w net.ipv4.ip_unprivileged_port_start=443"

say "Building images (skipping any already built)"
build() { podman image exists "$1" || podman build -t "$@"; }
build localhost/cryptoverse-login/login:test           -f "$REPO/login/login/Dockerfile"   "$REPO/login"
build localhost/cryptoverse-login/wrapper:test         -f "$REPO/login/wrapper/Dockerfile" "$REPO/login"
build localhost/cryptoverse-login/gateway:test         "$REPO/login/gateway"
build localhost/cryptoverse-login/demo-python-django:test "$REPO/tests/cryptoverse-login-demo/demo"

if ! kind get clusters | grep -qx "$CLUSTER"; then
  say "Creating kind cluster '$CLUSTER' (rootless podman)"
  # systemd scope gives the node full cgroup delegation (reliable rootless boot).
  systemd-run --user --scope -p "Delegate=yes" \
    kind create cluster --config "$REPO/tests/kind/cluster.yaml"
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

say "Installing ingress-nginx"
kubectl apply -f "$INGRESS_NGINX"
kubectl wait --namespace ingress-nginx --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller --timeout=180s
# The demo ingress has no ingressClassName, so make nginx the default.
kubectl annotate ingressclass nginx ingressclass.kubernetes.io/is-default-class=true --overwrite

say "Namespaces + self-signed TLS"
for ns in "$NS_LOGIN" "$NS_DEMO"; do
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
done
mkcert() { # domain namespace secret-name
  local dir; dir=$(mktemp -d)
  openssl req -x509 -nodes -newkey rsa:2048 -days 7 \
    -keyout "$dir/tls.key" -out "$dir/tls.crt" \
    -subj "/CN=$1" -addext "subjectAltName=DNS:$1" >/dev/null 2>&1
  kubectl -n "$2" create secret tls "$3" --cert="$dir/tls.crt" --key="$dir/tls.key" \
    --dry-run=client -o yaml | kubectl apply -f -
  rm -rf "$dir"
}
mkcert "$LOGIN_DOMAIN" "$NS_LOGIN" cryptoverse-login   # hardcoded in login-ingress.yaml
mkcert "$DEMO_DOMAIN"  "$NS_DEMO"  login-demo-tls

say "Loading images into kind"
for img in login wrapper gateway demo-python-django; do
  kind load docker-image "localhost/cryptoverse-login/$img:test" --name "$CLUSTER"
done

say "Deploying login chart (Hydra dsn=memory)"
helm dependency update "$REPO/charts/login" >/dev/null
helm upgrade --install cryptoverse-login "$REPO/charts/login" \
  -n "$NS_LOGIN" -f "$REPO/tests/kind/values-kind.yaml" --wait --timeout 5m

say "Deploying demo chart"
# No --wait: the demo pod can't start until hydra-maester reconciles the
# OAuth2Client and creates its secret; we wait for that explicitly below.
helm upgrade --install demo "$REPO/tests/cryptoverse-login-demo/charts/demo" \
  -n "$NS_DEMO" -f "$REPO/tests/kind/values-demo-kind.yaml"
echo "Waiting for hydra-maester to create the demo OAuth2Client secret..."
for i in $(seq 1 60); do
  kubectl -n "$NS_DEMO" get secret demo-oauth2client >/dev/null 2>&1 && break || sleep 5
done
kubectl -n "$NS_DEMO" rollout status deploy/demo --timeout=180s || true

say "Verifying OIDC discovery through the ingress"
curl -fsSk "https://$LOGIN_DOMAIN/.well-known/openid-configuration" | head -c 200 || \
  echo "(discovery not ready yet — give Hydra a few more seconds)"

cat <<EOF

== Ready ==
Login:  https://$LOGIN_DOMAIN/
Demo:   https://$DEMO_DOMAIN/

Run the Selenium suite:
  cd $REPO/tests
  python3 -m venv .venv && . .venv/bin/activate
  pip install -r requirements.txt
  DOMAIN_LOGIN=$LOGIN_DOMAIN DOMAIN_DEMO_APP=$DEMO_DOMAIN \\
    pytest test_full.py -v --log-cli-level=INFO

Tear down with: tests/kind/teardown.sh
EOF
