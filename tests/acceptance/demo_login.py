#!/usr/bin/env python3
"""Deploy-gate acceptance test: a FULL headless Sign-In-with-Ethereum login
driven all the way THROUGH the demo relying party.

Unlike `tests/harness/` (which drives the IdP directly) this exercises the demo
app end to end exactly as a browser+wallet would, but with a programmatic signer
instead of a wallet UI — so it runs headless, deterministically, with no xvfb /
extension / projectId, which is what makes it safe to gate every `just deploy`.

Flow (cookie session carried throughout, like a browser):
  1. GET  demo /protected         -> follows OIDC redirect to the IdP authorize
  2. GET  IdP /oauth2/inner        -> Hydra authorize -> /login?login_challenge=…
  3. GET  /login                   -> read the `login-data` JSON (SIWE params)
  4. build + sign the EIP-4361 message with a well-known test key (eth_account)
  5. POST /login/process           -> verify SIWE + accept the Hydra login
  6. follow login_verifier         -> /consent  -> auto-accept -> consent_verifier
  7. follow to the demo /oidc/callback (gateway wraps it in /oauth2/final?url=…)
  8. the demo exchanges the code server-side and renders its success page
  9. ASSERT the demo's success page shows sub == signer address (lowercased) and
     email == {sub}@{MAILSERVER_DOMAIN}

Usage:  demo_login.py <demo_url> <login_url>
        (also reads DEMO_URL / LOGIN_URL / ACCEPT_KEY / MAILSERVER_DOMAIN env)
Exit 0 = the new app version really logs the demo in and issues correct claims.
"""
import html
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlparse, parse_qs, unquote

try:
    import requests
    import urllib3
    from eth_account import Account
    from eth_account.messages import encode_defunct
except ImportError as e:  # pragma: no cover - environment guard
    print(f"FAIL: missing python dep ({e}). Need: requests, eth_account.", file=sys.stderr)
    sys.exit(2)

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

DEMO = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
    "DEMO_URL", "https://cryptoverse-login-demo.127.0.0.1.nip.io:18443")).rstrip("/")
LOGIN = (sys.argv[2] if len(sys.argv) > 2 else os.environ.get(
    "LOGIN_URL", "https://cryptoverse-login.127.0.0.1.nip.io:18443")).rstrip("/")
# Well-known public test key (Hardhat account #1) — not a real secret.
KEY = os.environ.get(
    "ACCEPT_KEY",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")  # pragma: allowlist secret
MAILSERVER_DOMAIN = os.environ.get("MAILSERVER_DOMAIN", "ethmail.cc")
TIMEOUT = int(os.environ.get("ACCEPT_TIMEOUT", "30"))

ACCT = Account.from_key(KEY)
ADDR = ACCT.address            # checksummed
EXPECTED_SUB = ADDR.lower()

S = requests.Session()
S.verify = False               # local self-signed CA on :18443


def fail(msg, resp=None):
    print(f"\n✗ FAIL: {msg}")
    if resp is not None:
        print(f"    status={resp.status_code} url={resp.url}")
        print(f"    body[:600]={resp.text[:600]!r}")
    sys.exit(1)


def step(n, msg):
    print(f"[{n}] {msg}")


def loc_of(resp):
    """Absolute Location header of a redirect, resolved against the request URL."""
    l = resp.headers.get("location")
    return urljoin(resp.url, l) if l else None


print(f"acceptance: demo={DEMO} login={LOGIN} signer={EXPECTED_SUB}")

# 1. Demo /protected -> follow the OIDC redirect onto the IdP authorize page.
step(1, "GET demo /protected -> IdP authorize")
r = S.get(f"{DEMO}/protected", allow_redirects=True, timeout=TIMEOUT)
authorize_url = r.url
if "/oauth2/auth" not in authorize_url:
    fail("demo did not redirect to the IdP /oauth2/auth authorize endpoint", r)
q = parse_qs(urlparse(authorize_url).query)
if q.get("client_id", [""])[0] != "cryptoverse-login-demo":
    fail(f"unexpected client_id in authorize: {q.get('client_id')}", r)
# The RP's own redirect_uri + state, echoed back on the callback. We rebuild the
# callback from these (not the wrapper's url= param, which the gateway doesn't
# re-encode) so the demo's mozilla-django-oidc state lookup succeeds.
rp_redirect_uri = q.get("redirect_uri", [""])[0]
rp_state = q.get("state", [""])[0]

# 2. Drive Hydra authorize via the gateway's inner path -> login_challenge.
step(2, "GET IdP /oauth2/inner -> Hydra authorize -> /login?login_challenge")
inner_url = authorize_url.replace("/oauth2/auth", "/oauth2/inner")
r = S.get(inner_url, allow_redirects=False, timeout=TIMEOUT)
login_loc = loc_of(r)
if r.status_code not in (302, 303) or not login_loc or "login_challenge=" not in login_loc:
    fail("Hydra did not issue a login_challenge (client/redirect_uri rejected?)", r)

# 3. Render /login, read the login-data JSON (challenge + SIWE params).
step(3, "GET /login -> read login-data JSON")
r = S.get(login_loc, allow_redirects=True, timeout=TIMEOUT)
m = re.search(r'<script type="application/json" id="login-data">(.*?)</script>', r.text, re.S)
if not m:
    fail("no login-data block on the login page (SPA failed to render?)", r)
ld = json.loads(html.unescape(m.group(1)))
siwe, challenge = ld["siwe"], ld["challenge"]
print(f"    clientId={ld.get('clientId')} domain={siwe['domain']} nonce={siwe['nonce']}")

# 4. Build the canonical EIP-4361 message and sign it with the test key.
step(4, "Build + sign EIP-4361 message")
issued = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
expires = (datetime.now(timezone.utc) + timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
message = "\n".join([
    f"{siwe['domain']} wants you to sign in with your Ethereum account:",
    ADDR, "", siwe["statement"], "",
    f"URI: {siwe['uri']}", f"Version: {siwe['version']}",
    f"Chain ID: {siwe['chainId']}", f"Nonce: {siwe['nonce']}",
    f"Issued At: {issued}", f"Expiration Time: {expires}",
])
sig = ACCT.sign_message(encode_defunct(text=message)).signature.hex()
if not sig.startswith("0x"):
    sig = "0x" + sig

# 5. POST /login/process — verify the SIWE signature + accept the Hydra login.
#    `response=api` returns JSON {redirect}; tolerate a plain 302 too.
step(5, "POST /login/process -> verify SIWE + accept login")
r = S.post(f"{LOGIN}/login/process",
           data={"challenge": challenge, "message": message, "signature": sig, "response": "api"},
           allow_redirects=False, timeout=TIMEOUT)
if r.status_code == 200:
    try:
        verifier = urljoin(r.url, r.json()["redirect"])
    except Exception:
        fail("login/process 200 but no JSON {redirect}", r)
elif r.status_code in (302, 303):
    verifier = loc_of(r)
else:
    fail("login/process rejected the SIWE signature", r)

# 6. login_verifier -> /consent -> auto-accept -> consent_verifier.
step(6, "Follow login_verifier -> consent (auto-accept)")
r = S.get(verifier, allow_redirects=False, timeout=TIMEOUT)
consent_loc = loc_of(r)
if not consent_loc or "consent_challenge=" not in consent_loc:
    fail("login_verifier did not redirect to /consent", r)
r = S.get(consent_loc, allow_redirects=False, timeout=TIMEOUT)
verifier2 = loc_of(r)
if r.status_code not in (302, 303) or not verifier2:
    fail("/consent did not auto-accept", r)

# 7. consent_verifier -> code; the gateway wraps the RP redirect as
#    /oauth2/final?url=<demo callback?code=…>. Unwrap to the real demo callback.
step(7, "Follow consent_verifier -> demo /oidc/callback")
r = S.get(verifier2, allow_redirects=False, timeout=TIMEOUT)
final_loc = loc_of(r)
if not final_loc:
    fail("consent_verifier produced no redirect", r)
# The code lives somewhere in the (possibly wrapped /oauth2/final) redirect.
m = re.search(r"code=([^&\s\"']+)", unquote(final_loc))
if not m:
    fail(f"no authorization code in the RP redirect: {final_loc}", r)
# Rebuild the demo callback ourselves so BOTH code and state are present (the
# wrapper's url= param loses state through the gateway's non-re-encoded rewrite).
demo_cb = f"{rp_redirect_uri}?code={m.group(1)}&state={rp_state}"

# 8. Hit the demo callback to complete login (the demo exchanges the code +
#    validates the id_token server-side); it redirects to LOGIN_REDIRECT_URL, so
#    then load /protected explicitly — it renders the success page only when the
#    session is authenticated.
step(8, "GET demo /oidc/callback -> complete login -> GET /protected")
cb = S.get(demo_cb, allow_redirects=True, timeout=TIMEOUT)
r = S.get(f"{DEMO}/protected", allow_redirects=True, timeout=TIMEOUT)
body = r.text
if "Cryptoverse Login - Demo - Success" not in body:
    fail(f"demo /protected not authenticated after callback (login/token-exchange "
         f"failed; callback landed {cb.url})", r)

# 9. Assert the claims the DEMO itself rendered from the issued ID token.
step(9, "Assert ID-token claims on the demo success page")
m = re.search(r'<pre class="data">(.*?)</pre>', body, re.S)
if not m:
    fail("no id_token JSON (<pre class='data'>) on the success page", r)
claims = json.loads(html.unescape(m.group(1)))
sub, email = claims.get("sub"), claims.get("email")
expected_email = f"{EXPECTED_SUB}@{MAILSERVER_DOMAIN}"
print(f"    sub={sub} email={email} email_verified={claims.get('email_verified')}")
if sub != EXPECTED_SUB:
    fail(f"sub mismatch: got {sub}, expected {EXPECTED_SUB}")
if email != expected_email:
    fail(f"email mismatch: got {email}, expected {expected_email}")

print(f"\n✓ PASS — demo logged in via SIWE; sub + email correct ({EXPECTED_SUB})")
sys.exit(0)
