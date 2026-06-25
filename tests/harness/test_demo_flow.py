"""The browser-facing OAuth flow renders the wrapper's embed + final pages and
completes end-to-end.

This exercises the gateway -> wrapper path (`/oauth2/auth` = the top-level embed
page, `/oauth2/final` = the post-consent redirect page) that the other harness
tests bypass by going straight to `/oauth2/inner` (-> Hydra). That gap let a
wrapper template render error (the minijinja `tojson` filter, missing its `json`
feature) ship as a **502 on the real demo login flow** while every other test
stayed green. This test would have caught it.

The full browser+wallet journey is covered by the Playwright `tests/e2e/` suite;
here we drive the same endpoints with curl + the Rust SIWE signer (no JS).
"""
import json
import re
from urllib.parse import urlparse, parse_qs, unquote

import _lib


def test_demo_browser_flow_renders_wrapper_pages_and_issues_token(http, basic_client):
    client_id, secret, redirect = basic_client
    base = (f"/oauth2/auth?response_type=code&scope=openid&client_id={client_id}"
            f"&redirect_uri={redirect}&state=demo-harness-state&nonce=demo-harness-nonce")

    # 1. The wrapper's top-level embed page — what the demo redirects the browser
    #    to. Must render (200); a template/filter error here surfaces as a 502.
    status, _, body = http.request(_lib.GATEWAY + base)
    assert status == 200, f"/oauth2/auth (embed) -> {status}"
    assert 'id="auth"' in body and "embed.js" in body, "embed page didn't render the iframe + embed.js"

    # 2. The embed iframe loads /oauth2/inner (rewritten to Hydra's authorize).
    status, loc, _ = http.request(_lib.GATEWAY + base.replace("/oauth2/auth", "/oauth2/inner"))
    assert status in (302, 303) and "login_challenge=" in (loc or ""), f"/oauth2/inner -> {status} {loc}"

    # 3. SIWE login (Rust signer, same as test_login_flow).
    ld = _lib.login_data(http, loc)
    _, address = _lib.sign("warmup")
    message = _lib.build_message(address, ld["siwe"])
    signature, _ = _lib.sign(message)
    status, _, body = _lib.post_login(http, ld["challenge"], message, signature)
    assert status == 200, f"/login/process -> {status}: {body}"

    # 4. login_verifier -> consent -> consent_verifier; the gateway rewrites
    #    Hydra's consent redirect into /oauth2/final?url=<rp redirect with code>.
    loc = json.loads(body)["redirect"]
    for _ in range(3):
        status, loc, _ = http.request(_lib.to_gateway(loc))
    assert "/oauth2/final" in (loc or ""), f"expected /oauth2/final redirect, got {loc}"

    # 5. The wrapper's final page (also renders via the `tojson` filter). Must render.
    status, _, fbody = http.request(_lib.to_gateway(loc))
    assert status == 200, f"/oauth2/final -> {status}"
    assert "redirectUrl" in fbody, "final page didn't render the redirect script"

    # 6. The real relying-party redirect (carrying the auth code) is the url= param.
    rp_redirect = unquote(parse_qs(urlparse(loc).query)["url"][0])
    code = re.search(r"code=([^&\s]+)", rp_redirect)
    assert code, f"no auth code in final redirect {rp_redirect}"

    # 7. Exchange the code -> tokens; the id_token subject is the signer address.
    status, _, tbody = http.request(f"{_lib.GATEWAY}/oauth2/token", "POST", data={
        "grant_type": "authorization_code", "code": code.group(1),
        "redirect_uri": redirect, "client_id": client_id, "client_secret": secret})
    assert status == 200, f"token exchange -> {status}: {tbody}"
    assert _lib.decode_jwt(json.loads(tbody)["id_token"])["sub"] == address.lower()
