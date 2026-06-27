# Self-contained image for the real browser + wallet e2e (MetaMask via dappwright).
#
# Built FROM the official Playwright image so Node, the browsers, every system lib,
# and xvfb come from the image — the host needs NOTHING but a container runtime and
# a reachable deployed stack. Pinned to the SAME Playwright version as package.json
# (@playwright/test 1.61.0) so the image's preinstalled browsers match the test
# runner (no browser re-download). This is what `just deploy`'s gate runs, and it
# is portable to CI unchanged.
FROM mcr.microsoft.com/playwright:v1.61.0-noble

WORKDIR /e2e

# Deps in a cached layer (re-runs only when package.json / yarn.lock change).
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile

# Pre-download the wallet extension into dappwright's cache (/tmp/dappwright) at
# BUILD time. dappwright's lazy download deadlocks if it happens at runtime inside a
# Playwright worker in a container; with the extension already cached the test skips
# the download. TEST_PARALLEL_INDEX=0 marks this single bootstrap the primary; the
# throwaway session is removed so the real test seeds a fresh wallet.
COPY precache-wallet.cjs ./
RUN TEST_PARALLEL_INDEX=0 xvfb-run --auto-servernum node precache-wallet.cjs \
 && rm -rf /tmp/dappwright/session*

# The rest of the suite (node_modules + test-results excluded via .dockerignore).
COPY . .

# Headed extensions can't run truly headless; the base image ships xvfb-run, which
# gives Chromium a virtual display. The target URLs and wallet project are passed
# at run time via env (DEMO_URL / LOGIN_URL / E2E_PROJECT) by run-e2e.sh.
ENV E2E_PROJECT=metamask
# One shell command: run the test under xvfb-run with output to an in-container
# FILE, then cat the file and exit with the test's code. Two reasons for the file:
# (1) under `-t` (which dappwright's setup needs) streaming straight to stdout lets
# a slow/piped reader cause PTY backpressure that blocks the test; (2) cat-ing once
# at the end is a single small write, immune to that. `timeout` bounds a hang.
CMD ["sh", "-c", "timeout 240 xvfb-run --auto-servernum node_modules/.bin/playwright test --project=\"${E2E_PROJECT}\" --reporter=list >/tmp/e2e.out 2>&1; rc=$?; cat /tmp/e2e.out; exit $rc"]
