#!/usr/bin/env bash
# Run the real browser + wallet e2e (a real MetaMask extension via dappwright)
# in a SELF-CONTAINED container. The host needs ONLY a container runtime
# (podman/docker) and a reachable deployed stack — Node, the browsers, xvfb and
# all deps live in the image (tests/e2e/Dockerfile). This is the `just deploy`
# acceptance gate, and it is portable to CI unchanged.
#
# Unlike the curl/eth_account backend flow (`just e2e-api`), this drives the REAL
# frontend a user hits: wagmi connect, the Comlink iframe<->parent handshake,
# in-browser EIP-4361 building, and the wallet popup.
#
# Env: DEMO_URL / LOGIN_URL (deployed stack; passed by `just e2e`),
#      E2E_PROJECT (default "metamask"; "coinbase" also works),
#      E2E_IMAGE (built tag), E2E_RUNTIME (podman|docker).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # tests/e2e
IMAGE="${E2E_IMAGE:-cryptoverse-login-e2e:local}"
PROJECT="${E2E_PROJECT:-metamask}"
DEMO_URL="${DEMO_URL:-https://cryptoverse-login-demo.127.0.0.1.nip.io:18443}"
LOGIN_URL="${LOGIN_URL:-https://cryptoverse-login.127.0.0.1.nip.io:18443}"

RT="${E2E_RUNTIME:-}"
[ -n "${RT}" ] || RT="$(command -v podman 2>/dev/null || command -v docker 2>/dev/null || true)"
[ -n "${RT}" ] || { echo "FATAL: need podman or docker on PATH" >&2; exit 2; }
echo "e2e: runtime=${RT} image=${IMAGE} project=${PROJECT}"
echo "e2e: demo=${DEMO_URL} login=${LOGIN_URL}"

echo "e2e: building image (cached after the first build)…"
"${RT}" build -t "${IMAGE}" "${HERE}" || { echo "FATAL: e2e image build failed" >&2; exit 2; }

# Map loopback (nip.io/local) hostnames to 127.0.0.1 so the host-networked
# container reaches the ingress with NO DNS dependency. Real CI hostnames (a
# routable stack) resolve via normal DNS, so they get no override.
add_hosts=()
for u in "${DEMO_URL}" "${LOGIN_URL}"; do
  h="$(printf '%s' "${u}" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"
  case "${h}" in
    *.nip.io|*.sslip.io|*.local|localhost) add_hosts+=(--add-host "${h}:127.0.0.1");;
  esac
done

run() {
  # -t: allocate a pseudo-TTY. dappwright's MetaMask bootstrap/download HANGS
  #     without one; podman creates the pty itself, so this works even when the
  #     host has no TTY (the detached deploy-gate / commit-hook context).
  # --network=host: 127.0.0.1:18443 in the container == the host's ingress.
  "${RT}" run --rm -t --network=host ${add_hosts[@]+"${add_hosts[@]}"} \
    -e DEMO_URL="${DEMO_URL}" -e LOGIN_URL="${LOGIN_URL}" -e E2E_PROJECT="${PROJECT}" \
    "${IMAGE}"
}

# The wallet extension is pre-baked into the image (Dockerfile), so there is no
# runtime download; retry once only to absorb transient browser/render flakiness.
if run; then exit 0; fi
echo "e2e: first attempt failed — retrying once…" >&2
run
