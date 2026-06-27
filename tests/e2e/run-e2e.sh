#!/usr/bin/env bash
# Run the REAL browser + wallet Playwright e2e (a wallet extension via dappwright)
# under a virtual display — the `just deploy` acceptance gate. Unlike the curl/
# eth_account backend flow (tests/acceptance/demo_login.py), this drives a real
# Chromium with a real MetaMask extension, so it exercises the actual frontend:
# wagmi connect, the Comlink iframe<->parent handshake, in-browser EIP-4361
# building, and the wallet popup — i.e. it gates what a real user actually hits.
#
# Display: Chromium can't load extensions headless, and there is no host xvfb /
# sudo here, so we reuse the `Xvfb` binary that ships inside podman's container-
# overlay storage (its libs resolve on the host) — the pattern from
# tests/e2e/perf/run-connect-perf.sh. On a host with a real display, set DISPLAY
# and this still works (it prefers an Xvfb already on PATH).
#
# Env: DEMO_URL / LOGIN_URL (the deployed stack, passed by `just e2e`),
#      E2E_PROJECT (default "metamask"; "coinbase" also works), E2E_TIMEOUT.
set -uo pipefail
# A NON-snap node is required. Snap-confined node (/snap/bin/node) SWALLOWS stdout
# and fails to drive an external browser in a detached/no-TTY context — i.e.
# exactly how `just deploy` (and the background commit hook) runs this gate. Prefer
# a real node under ~/.local/nodejs; keep /snap/bin late only for yarn etc.
export PATH="${HOME}/.local/nodejs/bin:${HOME}/.local/bin:/snap/bin:${PATH}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # tests/e2e
PROJECT="${E2E_PROJECT:-metamask}"
RUN_TIMEOUT="${E2E_TIMEOUT:-300}"

if [ ! -x "${HERE}/node_modules/.bin/playwright" ]; then
  echo "FATAL: tests/e2e deps not installed — run 'yarn install' in tests/e2e" >&2
  exit 2
fi
NODE_BIN="$(command -v node 2>/dev/null || true)"
[ -n "${NODE_BIN}" ] || { echo "FATAL: node not on PATH" >&2; exit 2; }
case "${NODE_BIN}" in
  /snap/*)
    echo "FATAL: resolved node is the snap (${NODE_BIN}) — it swallows stdout and fails" >&2
    echo "       to drive the browser detached. Install a non-snap node, e.g.:" >&2
    echo "       mkdir -p ~/.local/nodejs && curl -fsSL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz | tar -xJ -C ~/.local/nodejs --strip-components=1" >&2
    exit 2;;
esac

# Locate Xvfb: prefer one on PATH (real display / CI xvfb), else the binary inside
# podman's container-overlay storage (a pulled image carries it; no apt/sudo).
XVFB="$(command -v Xvfb 2>/dev/null || true)"
[ -n "${XVFB}" ] || XVFB="$(find "${HOME}/.local/share/containers/storage/overlay" -name Xvfb -type f 2>/dev/null | head -n1)"
if [ -z "${XVFB}" ] || [ ! -x "${XVFB}" ]; then
  echo "FATAL: no Xvfb binary found (need a host display, or a pulled image carrying Xvfb)" >&2
  exit 2
fi
echo "e2e: node=${NODE_BIN} ($(node --version)) Xvfb=${XVFB} project=${PROJECT}"
echo "e2e: demo=${DEMO_URL:-<default>} login=${LOGIN_URL:-<default>}"

DNUM="${DISPLAY_NUM:-99}"
"${XVFB}" ":${DNUM}" -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb-e2e.log 2>&1 &
XVFB_PID=$!
trap 'kill "${XVFB_PID}" 2>/dev/null' EXIT
sleep 2
if ! kill -0 "${XVFB_PID}" 2>/dev/null; then
  echo "FATAL: Xvfb failed to start:" >&2; cat /tmp/xvfb-e2e.log >&2; exit 3
fi
export DISPLAY=":${DNUM}"

cd "${HERE}"
run() { timeout "${RUN_TIMEOUT}" node_modules/.bin/playwright test --project="${PROJECT}" --reporter=list; }

# dappwright DOWNLOADS the wallet extension on first use, which can race and fail
# the very first time on a cold cache; retry once (the cached run is deterministic).
if run; then
  exit 0
fi
echo "e2e: first attempt failed (cold extension download?) — retrying once…" >&2
run
