"""Shared helpers for the IdP test harness.

Cluster-agnostic: everything is driven over HTTP (via curl, so cookies / TLS /
Host headers / redirect inspection are trivial) and configured by env vars, so
the same suite runs against the local podman stack and a kind deployment.
"""
import json
import os
import re
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, parse_qs

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# --- configuration (env-overridable) -----------------------------------------
GATEWAY = os.getenv("HARNESS_GATEWAY", "http://127.0.0.1:8000")
HYDRA_ADMIN = os.getenv("HARNESS_HYDRA_ADMIN", "http://127.0.0.1:4445")
# Host header sent to the gateway. For real domains (kind) leave empty.
HOST = os.getenv("HARNESS_HOST", "login.cryptoverse.local")
# Simulate what a TLS-terminating ingress forwards. Setting these proves the
# system derives its public origin from the request (any domain/port/scheme).
XFWD_HOST = os.getenv("HARNESS_XFWD_HOST")
XFWD_PROTO = os.getenv("HARNESS_XFWD_PROTO")
SIGNER = os.getenv("HARNESS_SIGNER", os.path.join(REPO, "login/target/debug/examples/sign"))
MAILSERVER_DOMAIN = os.getenv("HARNESS_MAILSERVER_DOMAIN", "ethmail.cc")
INTROSPECT_USER = os.getenv("HARNESS_INTROSPECT_USER", "introspect")
INTROSPECT_PASS = os.getenv("HARNESS_INTROSPECT_PASS", "introspectpw")  # pragma: allowlist secret

# Well-known Hardhat test key #1 -> 0x70997970C51812dc3A010C7d01b50e0d17dc79C8.
# Holds 0 of every mainnet token, which makes token-gating assertions deterministic.
TEST_KEY = os.getenv("HARNESS_TEST_KEY",
                     "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")  # pragma: allowlist secret
# Mainnet USDC, used only for an on-chain balanceOf the test account has 0 of.
USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"


def _split(out):
    parts = re.split(r"\r?\n\r?\n", out, maxsplit=1)
    head = parts[0]
    body = parts[1] if len(parts) > 1 else ""
    status = int(re.search(r"HTTP/\S+ (\d+)", head).group(1))
    m = re.search(r"(?im)^location:\s*(.*?)\s*$", head)
    return status, (m.group(1) if m else None), body


class Http:
    """A curl-backed HTTP client with a persistent cookie jar (one per flow)."""

    def __init__(self):
        self.jar = f"/tmp/harness-{uuid.uuid4().hex}.cookies"
        open(self.jar, "w").close()

    def request(self, url, method="GET", data=None, host=HOST, basic=None, headers=None):
        cmd = ["curl", "-sk", "-i", "-b", self.jar, "-c", self.jar, "-X", method]
        if host:
            cmd += ["-H", f"Host: {host}"]
        if XFWD_HOST:
            cmd += ["-H", f"X-Forwarded-Host: {XFWD_HOST}"]
        if XFWD_PROTO:
            cmd += ["-H", f"X-Forwarded-Proto: {XFWD_PROTO}"]
        if basic:
            cmd += ["-u", basic]
        for h in headers or []:
            cmd += ["-H", h]
        for k, v in (data or {}).items():
            cmd += ["--data-urlencode", f"{k}={v}"]
        cmd.append(url)
        out = subprocess.run(cmd, capture_output=True, text=True).stdout
        return _split(out)


def to_gateway(abs_url):
    """Rewrite an absolute issuer URL to a gateway request (path+query preserved)."""
    p = urlparse(abs_url)
    return GATEWAY + p.path + (("?" + p.query) if p.query else "")


# --- Hydra admin (client lifecycle) ------------------------------------------
def create_client(metadata=None, scope="openid", redirect_uri="http://localhost:9876/callback",
                  grant_types=None, token_endpoint_auth_method=None, public=False,
                  post_logout_redirect_uris=None):
    """Register an OAuth2 client with Hydra.

    Defaults reproduce the historical authorization-code client. Pass
    `grant_types` (e.g. the device-code grant) and/or `public=True` (a public
    client with `token_endpoint_auth_method="none"`, as the device flow needs)
    to vary it; `token_endpoint_auth_method` overrides either default.
    """
    cid = "harness-" + uuid.uuid4().hex[:12]
    grant_types = grant_types or ["authorization_code"]
    if token_endpoint_auth_method is None:
        token_endpoint_auth_method = "none" if public else "client_secret_post"
    spec = {
        "client_id": cid, "client_secret": "harness-secret",  # pragma: allowlist secret
        "grant_types": grant_types, "response_types": ["code"],
        "redirect_uris": [redirect_uri], "scope": scope,
        "token_endpoint_auth_method": token_endpoint_auth_method,
    }
    if metadata is not None:
        spec["metadata"] = metadata
    if post_logout_redirect_uris is not None:
        spec["post_logout_redirect_uris"] = post_logout_redirect_uris
    out = subprocess.run(
        ["curl", "-sk", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
         f"{HYDRA_ADMIN}/admin/clients", "-H", "Content-Type: application/json",
         "--data", json.dumps(spec)],
        capture_output=True, text=True).stdout
    assert out in ("200", "201"), f"create client failed: HTTP {out}"
    return cid, "harness-secret", redirect_uri  # pragma: allowlist secret


def delete_client(client_id):
    subprocess.run(["curl", "-sk", "-X", "DELETE", f"{HYDRA_ADMIN}/admin/clients/{client_id}"],
                   capture_output=True)


# --- SIWE (build + sign) ------------------------------------------------------
def sign(message, key=TEST_KEY):
    r = subprocess.run([SIGNER, key], input=message, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"signer failed: {r.stderr}")
    return r.stdout.strip(), r.stderr.strip()  # signature, checksummed address


def build_message(address, siwe, issued=None, expires=None):
    issued = issued or datetime.now(timezone.utc)
    expires = expires or (issued + timedelta(minutes=10))
    fmt = "%Y-%m-%dT%H:%M:%S.000Z"
    return "\n".join([
        f"{siwe['domain']} wants you to sign in with your Ethereum account:",
        address, "", siwe["statement"], "",
        f"URI: {siwe['uri']}", f"Version: {siwe['version']}",
        f"Chain ID: {siwe['chainId']}", f"Nonce: {siwe['nonce']}",
        f"Issued At: {issued.strftime(fmt)}", f"Expiration Time: {expires.strftime(fmt)}",
    ])


# --- flow steps ---------------------------------------------------------------
def authorize(http, client_id, redirect_uri, state="harness-state"):
    url = (f"{GATEWAY}/oauth2/inner?client_id={client_id}&redirect_uri={redirect_uri}"
           f"&response_type=code&scope=openid&state={state}")
    status, loc, _ = http.request(url)
    assert status in (302, 303) and "login_challenge=" in (loc or ""), f"authorize -> {status} {loc}"
    return parse_qs(urlparse(loc).query)["login_challenge"][0], loc


def login_data(http, login_redirect):
    status, _, body = http.request(to_gateway(login_redirect))
    assert status == 200, f"GET /login -> {status}"
    m = re.search(r'<script type="application/json" id="login-data">(.*?)</script>', body, re.S)
    assert m, "login-data block not found"
    return json.loads(m.group(1))


def post_login(http, challenge, message, signature):
    # HARNESS_CRLF replicates a browser HTML form, which normalises the signed
    # message's LF to CRLF on submit (the signature is still over the LF form).
    if os.getenv("HARNESS_CRLF"):
        message = message.replace("\n", "\r\n")
    return http.request(f"{GATEWAY}/login/process", "POST",
                        data={"challenge": challenge, "message": message,
                              "signature": signature, "response": "api"})


def finish_and_get_tokens(http, login_redirect, client_id, client_secret, redirect_uri):
    """Drive login_verifier -> consent -> code -> token after a successful login."""
    status, loc, _ = http.request(to_gateway(login_redirect))         # login_verifier -> consent
    assert status in (302, 303) and "consent_challenge=" in (loc or ""), f"consent redirect -> {status}"
    status, loc, _ = http.request(to_gateway(loc))                    # /consent -> consent_verifier
    assert status in (302, 303), f"consent accept -> {status}"
    status, loc, _ = http.request(to_gateway(loc))                    # consent_verifier -> code
    code = re.search(r"code=([^&\s]+)", loc or "")
    assert code, f"no authorization code in {loc}"
    status, _, body = http.request(f"{GATEWAY}/oauth2/token", "POST", data={
        "grant_type": "authorization_code", "code": code.group(1),
        "redirect_uri": redirect_uri, "client_id": client_id, "client_secret": client_secret})
    assert status == 200, f"token exchange -> {status}: {body}"
    return json.loads(body)


def decode_jwt(token):
    import base64
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


def full_login(http, client, key=TEST_KEY):
    """End-to-end happy path -> returns (tokens, id_token_claims)."""
    client_id, secret, redirect = client
    challenge, login_redirect = authorize(http, client_id, redirect)
    ld = login_data(http, login_redirect)
    _, address = sign("warmup", key)
    message = build_message(address, ld["siwe"])
    signature, _ = sign(message, key)
    status, _, body = post_login(http, ld["challenge"], message, signature)
    assert status == 200, f"/login/process -> {status}: {body}"
    tokens = finish_and_get_tokens(http, json.loads(body)["redirect"], client_id, secret, redirect)
    return tokens, decode_jwt(tokens["id_token"]), address
