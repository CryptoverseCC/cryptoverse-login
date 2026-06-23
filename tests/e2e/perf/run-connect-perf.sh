#!/usr/bin/env bash
# Run the connect-time perf script (Approach A: real MetaMask) under a virtual
# display. In this sandbox there is no $DISPLAY and no apt; the only Xvfb on disk
# lives inside a container overlay, but its binary runs fine on the host (all its
# shared libs resolve). We start it on :99, run the script, then tear it down.
#
# If a real X display is already available (CI with xvfb-run, or a desktop), just
# run:  DISPLAY=:0 TEST_PARALLEL_INDEX=0 node perf/connect-chunks.mjs
# (this script is the sandbox path). CONNECTOR / DO_SIGN env are passed through.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$HERE/.." && pwd)"

# Locate an Xvfb binary: prefer one on PATH, else the container-overlay copy.
XVFB="$(command -v Xvfb 2>/dev/null || true)"
if [ -z "$XVFB" ]; then
  XVFB="$(find "$HOME/.local/share/containers/storage/overlay" -name Xvfb -type f 2>/dev/null | head -n1)"
fi
if [ -z "$XVFB" ] || [ ! -x "$XVFB" ]; then
  echo "FATAL: no Xvfb binary found. Provide a real display via DISPLAY and run perf/connect-chunks.mjs directly." >&2
  exit 2
fi
echo "Using Xvfb: $XVFB"

DISPLAY_NUM="${DISPLAY_NUM:-99}"
"$XVFB" ":${DISPLAY_NUM}" -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb-perf.log 2>&1 &
XVFB_PID=$!
trap 'kill "$XVFB_PID" 2>/dev/null' EXIT
sleep 2
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "FATAL: Xvfb failed to start; log:" >&2
  cat /tmp/xvfb-perf.log >&2
  exit 3
fi
echo "Xvfb up on :${DISPLAY_NUM} (pid $XVFB_PID)"

export DISPLAY=":${DISPLAY_NUM}"
# dappwright only DOWNLOADS the extension on the "primary worker" (it normally runs
# under the Playwright test runner, which sets TEST_PARALLEL_INDEX). Running the
# script standalone, we must declare ourselves primary or bootstrap deadlocks
# forever on "Waiting for primary worker to download metamask...".
export TEST_PARALLEL_INDEX="${TEST_PARALLEL_INDEX:-0}"
cd "$E2E_DIR"
# Drive the real connect path (CONNECTOR / DO_SIGN passed through via env).
node perf/connect-chunks.mjs
RC=$?
echo "connect-chunks.mjs exited $RC"
exit $RC
