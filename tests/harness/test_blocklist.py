"""Blocklist regression: a globally blocked address is denied at /login/process.

Unlike the rest of the harness (pure HTTP, cluster-agnostic), the blocklist is a
file mounted from the login ConfigMap (BLOCKLIST_FILE), read fresh per request.
To exercise the real deny path end-to-end this test must mutate cluster state: it
patches `blocklist.json` in the ConfigMap to contain the test key's address and
restarts the login Deployment so the new pod mounts it, asserts the login is
denied, then restores the original blocklist and restarts back — confirming a
normal login succeeds again. This mirrors the manual block/revert check.

Self-skips when kubectl / the login Deployment isn't reachable (the podman
local-stack, or no cluster at all), so the rest of the suite stays cluster-
agnostic. Knobs (defaults target the kind cluster):
  HARNESS_KUBECTL, HARNESS_K8S_CONTEXT, HARNESS_K8S_NAMESPACE,
  HARNESS_LOGIN_CONFIGMAP, HARNESS_LOGIN_DEPLOY.

MUST run serially (pytest's default): while the test key's address is blocked,
every other login in the suite would also be denied — the finally-block restores
the original blocklist before any other test runs.
"""
import json
import os
import shutil
import subprocess
import time

import pytest

import _lib

KUBECTL = os.getenv("HARNESS_KUBECTL", "kubectl")
CONTEXT = os.getenv("HARNESS_K8S_CONTEXT", "kind-cryptoverse-login")
NAMESPACE = os.getenv("HARNESS_K8S_NAMESPACE", "cryptoverse-login")
CONFIGMAP = os.getenv("HARNESS_LOGIN_CONFIGMAP", "cryptoverse-login-login")
DEPLOY = os.getenv("HARNESS_LOGIN_DEPLOY", "deploy/cryptoverse-login-login")
# Hardhat #1 address (what TEST_KEY signs as), lowercased — the OIDC subject the
# backend compares against the blocklist (case-insensitively).
TEST_ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"


def _kubectl(*args, check=True):
    cmd = [KUBECTL.split()[0], *KUBECTL.split()[1:]]
    if CONTEXT:
        cmd += ["--context", CONTEXT]
    if NAMESPACE:
        cmd += ["-n", NAMESPACE]
    cmd += list(args)
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


def _cluster_available():
    if not shutil.which(KUBECTL.split()[0]):
        return False
    try:
        _kubectl("get", DEPLOY, "-o", "name")
        return True
    except subprocess.CalledProcessError:
        return False


cluster = pytest.mark.skipif(
    not _cluster_available(),
    reason="blocklist regression needs kubectl + the login Deployment (kind cluster)",
)


def _get_blocklist_json():
    return _kubectl("get", "configmap", CONFIGMAP,
                    "-o", r"jsonpath={.data.blocklist\.json}").stdout


def _set_blocklist_json(value):
    patch = json.dumps({"data": {"blocklist.json": value}})
    _kubectl("patch", "configmap", CONFIGMAP, "--type", "merge", "-p", patch)
    # The mounted file only refreshes on the kubelet sync (~60s) — restart so the
    # new pod mounts the patched ConfigMap deterministically, then wait for ready.
    _kubectl("rollout", "restart", DEPLOY)
    _kubectl("rollout", "status", DEPLOY, "--timeout=120s")


def _attempt_login_once():
    """Drive one SIWE login through /login/process; return (status, body)."""
    client = _lib.create_client(scope="openid")
    http = _lib.Http()
    try:
        cid, _secret, redirect = client
        _challenge, login_redirect = _lib.authorize(http, cid, redirect)
        ld = _lib.login_data(http, login_redirect)
        _, address = _lib.sign("warmup")
        message = _lib.build_message(address, ld["siwe"])
        signature, _ = _lib.sign(message)
        status, _, body = _lib.post_login(http, ld["challenge"], message, signature)
        return status, body
    finally:
        _lib.delete_client(client[0])


def _attempt_login(retries=6, delay=1.0):
    """Like _attempt_login_once, but ride out the brief post-restart window where
    the gateway has no ready login backend (503) or /login isn't up yet."""
    last = (None, "")
    for i in range(retries):
        try:
            status, body = _attempt_login_once()
            if status not in (502, 503):
                return status, body
            last = (status, body)
        except AssertionError as exc:  # /login or authorize not ready yet
            last = (None, str(exc))
        if i < retries - 1:
            time.sleep(delay)
    return last


@cluster
def test_blocked_address_denied_then_restored():
    original = _get_blocklist_json()
    try:
        # Block the test key's address; the next login must be denied at
        # /login/process — before token-gating, no token issued.
        _set_blocklist_json(json.dumps([TEST_ADDRESS]))
        status, body = _attempt_login()
        assert status == 403, f"blocked login -> {status}: {body}"
        assert "not permitted" in body.lower(), f"unexpected deny body: {body}"
    finally:
        # Restore EXACTLY what was there (default "[]" if it was unset/empty) so
        # the rest of the suite — and the cluster — are unaffected.
        _set_blocklist_json(original or "[]")

    # Revert sanity: with the address un-blocked, the same login succeeds again.
    status, body = _attempt_login()
    assert status == 200, f"after restore -> {status}: {body}"
