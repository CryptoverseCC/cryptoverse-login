#!/usr/bin/env python3
"""Headless OAuth2 authorization-code + OIDC + SIWE flow against the local stack.

Simulates what the browser/wallet would do: drives Hydra through the gateway,
renders the login page, signs the EIP-4361 message with a test key (via the Rust
`sign` example), accepts consent, gets the code, exchanges it for tokens, and
checks the ID token's `sub` + enriched email match the signing address.

Usage:
    podman kube play local-stack/cryptoverse-stack.yaml
    python3 local-stack/smoke_test.py
"""
import base64
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, parse_qs

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIGNER = os.environ.get("SIGNER", os.path.join(REPO, "login/target/debug/examples/sign"))
GATEWAY = "http://127.0.0.1:8000"
ADMIN = "http://127.0.0.1:4445"
HOST = "login.cryptoverse.local"
CJ = "/tmp/cryptoverse_flow_cookies.txt"
# Well-known public test key (Hardhat account #1) — not a real secret.
KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"  # pragma: allowlist secret
REDIRECT = "http://localhost:9876/callback"
CLIENT_ID = "smoke-client"
CLIENT_SECRET = "smoke-secret"  # pragma: allowlist secret

open(CJ, "w").close()  # fresh cookie jar


def curl(url, method="GET", data=None, host=HOST, json_body=None):
    cmd = ["curl", "-s", "-i", "-b", CJ, "-c", CJ, "-X", method]
    if host:
        cmd += ["-H", f"Host: {host}"]
    if json_body is not None:
        cmd += ["-H", "Content-Type: application/json", "--data", json.dumps(json_body)]
    if data:
        for k, v in data.items():
            cmd += ["--data-urlencode", f"{k}={v}"]
    cmd.append(url)
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    # text=True normalises CRLF->LF, so split on the first blank line either way.
    parts = re.split(r"\r?\n\r?\n", out, maxsplit=1)
    head = parts[0]
    body = parts[1] if len(parts) > 1 else ""
    status = int(re.search(r"HTTP/\S+ (\d+)", head).group(1))
    m = re.search(r"(?im)^location:\s*(.*?)\s*$", head)
    return status, (m.group(1) if m else None), body


def to_gateway(abs_url):
    p = urlparse(abs_url)
    return GATEWAY + p.path + (("?" + p.query) if p.query else "")


def sign(message):
    r = subprocess.run([SIGNER, KEY], input=message, capture_output=True, text=True)
    return r.stdout.strip(), r.stderr.strip()  # (signature, checksummed address)


def step(n, msg):
    print(f"\n[{n}] {msg}")


# --- 0. (re)create the OAuth2 client -----------------------------------------
step(0, "Create OAuth2 client via Hydra admin")
subprocess.run(["curl", "-s", "-X", "DELETE", f"{ADMIN}/admin/clients/{CLIENT_ID}"], capture_output=True)
client = {
    "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
    "grant_types": ["authorization_code"], "response_types": ["code"],
    "redirect_uris": [REDIRECT], "scope": "openid",
    "token_endpoint_auth_method": "client_secret_post",
}
s, _, b = curl(f"{ADMIN}/admin/clients", "POST", host=None, json_body=client)
print(f"    create client -> HTTP {s}")
assert s in (200, 201), b

# --- 1. authorize (simulate the iframe loading /oauth2/inner) -----------------
step(1, "GET /oauth2/inner (authorize) -> expect redirect to /login")
authz = (f"{GATEWAY}/oauth2/inner?client_id={CLIENT_ID}&redirect_uri={REDIRECT}"
         f"&response_type=code&scope=openid&state=smoke-state-123")
s, loc, _ = curl(authz)
print(f"    HTTP {s} -> /login (login_challenge present: {'login_challenge=' in (loc or '')})")
assert s in (302, 303) and "login_challenge=" in (loc or ""), loc

# --- 2. render the login page, read login-data -------------------------------
step(2, "GET /login -> render SPA, read login-data JSON")
s, _, body = curl(to_gateway(loc))
m = re.search(r'<script type="application/json" id="login-data">(.*?)</script>', body, re.S)
assert m, f"no login-data in body (HTTP {s})"
ld = json.loads(m.group(1))
siwe = ld["siwe"]
print(f"    HTTP {s}  clientId={ld['clientId']}  nonce={siwe['nonce']}")

# --- 3. build + sign the SIWE message ----------------------------------------
step(3, "Build EIP-4361 message and sign with test key")
_, address = sign("warmup")  # grab the checksummed address first
issued = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
expires = (datetime.now(timezone.utc) + timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
message = "\n".join([
    f"{siwe['domain']} wants you to sign in with your Ethereum account:",
    address, "", siwe["statement"], "",
    f"URI: {siwe['uri']}", f"Version: {siwe['version']}",
    f"Chain ID: {siwe['chainId']}", f"Nonce: {siwe['nonce']}",
    f"Issued At: {issued}", f"Expiration Time: {expires}",
])
signature, _ = sign(message)
print(f"    address={address}  signature={signature[:20]}...")

# --- 4. POST /login/process (verify SIWE, accept login) ----------------------
step(4, "POST /login/process -> verify SIWE, accept login")
s, _, body = curl(f"{GATEWAY}/login/process", "POST", data={
    "challenge": ld["challenge"], "message": message, "signature": signature, "response": "api",
})
print(f"    HTTP {s}")
assert s == 200, body
hydra_redirect = json.loads(body)["redirect"]

# --- 5. continue at Hydra (login_verifier) -> consent ------------------------
step(5, "Follow login_verifier -> expect redirect to /consent")
s, loc, _ = curl(to_gateway(hydra_redirect))
print(f"    HTTP {s}  consent_challenge present: {'consent_challenge=' in (loc or '')}")
assert s in (302, 303) and "consent_challenge=" in (loc or ""), loc

# --- 6. consent (auto-accept) -> back to Hydra -------------------------------
step(6, "GET /consent -> auto-accept")
s, loc, _ = curl(to_gateway(loc))
print(f"    HTTP {s}  consent_verifier present: {'consent_verifier=' in (loc or '')}")
assert s in (302, 303), loc

# --- 7. continue at Hydra (consent_verifier) -> code (via gateway rewrite) ----
step(7, "Follow consent_verifier -> gateway rewrites to /oauth2/final?url=<code>")
s, loc, _ = curl(to_gateway(loc))
m = re.search(r"code=([^&\s]+)", loc or "")
assert m, f"no code in {loc}"
code = m.group(1)
print(f"    HTTP {s}  code={code[:18]}...  (gateway rewrote to /oauth2/final: {'/oauth2/final' in (loc or '')})")

# --- 8. exchange code for tokens ---------------------------------------------
step(8, "POST /oauth2/token -> exchange code")
s, _, body = curl(f"{GATEWAY}/oauth2/token", "POST", data={
    "grant_type": "authorization_code", "code": code,
    "redirect_uri": REDIRECT, "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
})
print(f"    HTTP {s}")
assert s == 200, body
tok = json.loads(body)

# --- 9. decode id_token claims -----------------------------------------------
step(9, "Decode id_token claims")
payload_b64 = tok["id_token"].split(".")[1]
payload_b64 += "=" * (-len(payload_b64) % 4)
claims = json.loads(base64.urlsafe_b64decode(payload_b64))
print(f"    iss={claims.get('iss')}")
print(f"    sub={claims.get('sub')}")
print(f"    email={claims.get('email')}  email_verified={claims.get('email_verified')}")

expected_sub = address.lower()
ok = claims.get("sub") == expected_sub and claims.get("email") == f"{expected_sub}@ethmail.cc"
print("\n=== RESULT ===")
print("PASS — sub & enriched email match the SIWE signer address" if ok
      else f"FAIL — sub={claims.get('sub')}")
sys.exit(0 if ok else 1)
