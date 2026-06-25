"""RFC 8628 device authorization grant end-to-end.

Drives the full grant against the gateway + Hydra, reusing the existing SIWE +
consent harness steps for the login leg (which the device flow funnels into
unchanged):

  device  POST /oauth2/device/auth            -> {device_code, user_code, ...}
  browser GET  /oauth2/device/verify?user_code=...
               -> 302 to OUR /device?device_challenge=...
  browser POST /device  (device_challenge + user_code)
               -> redirect_to into the STANDARD login pipeline
  browser ... /login (SIWE) -> /consent -> /device/success
  device  POST /oauth2/token  (grant_type=device_code, poll)
               -> id_token / access_token with sub == lowercased signer address

NOTE: the query-param name Hydra uses on the redirect to /device
(`device_challenge`) is verified for the *accept* call but the redirect itself
was not live-traced. The test captures the actual redirect query and asserts the
param is present, so a mismatch fails loudly here rather than silently.
"""
import json
from urllib.parse import urlparse, parse_qs

import pytest

import _lib

DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"


@pytest.fixture
def device_client():
    """A public device-grant client (token_endpoint_auth_method=none)."""
    client = _lib.create_client(
        scope="openid email profile mail offline_access",
        grant_types=[DEVICE_GRANT, "refresh_token"],
        public=True,
    )
    yield client
    _lib.delete_client(client[0])


def test_device_authorization_grant(http, device_client):
    client_id, _secret, _redirect = device_client

    # 1. Device starts the grant. Public client => client_id in the body, no auth.
    status, _, body = http.request(
        f"{_lib.GATEWAY}/oauth2/device/auth", "POST",
        data={"client_id": client_id, "scope": "openid email profile mail offline_access"},
    )
    assert status == 200, f"/oauth2/device/auth -> {status}: {body}"
    dev = json.loads(body)
    assert "device_code" in dev and "user_code" in dev, dev
    device_code = dev["device_code"]
    user_code = dev["user_code"]

    # 2. Browser opens the verification URI. Hydra mints a device_challenge and
    #    302s to OUR /device page. Capture the actual redirect query so a
    #    param-name mismatch is obvious.
    status, loc, _ = http.request(
        f"{_lib.GATEWAY}/oauth2/device/verify?user_code={user_code}",
    )
    assert status in (302, 303), f"/oauth2/device/verify -> {status} {loc}"
    assert loc, "device/verify produced no redirect"
    q = parse_qs(urlparse(loc).query)
    assert "device_challenge" in q, (
        f"expected device_challenge on redirect to /device, got query={q!r} "
        f"(loc={loc!r}) -- confirm the param name in the live e2e"
    )
    assert "/device" in urlparse(loc).path, f"redirect not to /device: {loc}"
    device_challenge = q["device_challenge"][0]

    # 3. Browser POSTs the code to OUR /device -> redirect into login pipeline.
    status, loc, body = http.request(
        f"{_lib.GATEWAY}/device", "POST",
        data={"device_challenge": device_challenge, "user_code": user_code},
    )
    assert status in (302, 303), f"POST /device -> {status}: {body}"
    assert loc, "POST /device produced no redirect"

    # 4. Follow redirect into the STANDARD login flow (login_challenge). Reuse
    #    the existing SIWE + consent steps exactly like _lib.full_login.
    status, login_redirect, _ = http.request(_lib.to_gateway(loc))
    assert status in (302, 303) and "login_challenge=" in (login_redirect or ""), \
        f"device -> login_challenge redirect -> {status} {login_redirect}"

    ld = _lib.login_data(http, login_redirect)
    _, address = _lib.sign("warmup")
    message = _lib.build_message(address, ld["siwe"])
    signature, _ = _lib.sign(message)
    status, _, body = _lib.post_login(http, ld["challenge"], message, signature)
    assert status == 200, f"/login/process -> {status}: {body}"

    # login_verifier -> consent -> consent_verifier -> device/success.
    status, loc, _ = http.request(_lib.to_gateway(json.loads(body)["redirect"]))
    assert status in (302, 303) and "consent_challenge=" in (loc or ""), \
        f"consent redirect -> {status} {loc}"
    status, loc, _ = http.request(_lib.to_gateway(loc))      # /consent -> consent_verifier
    assert status in (302, 303), f"consent accept -> {status} {loc}"
    # Follow the rest of the chain to completion (lands on device/success).
    for _ in range(5):
        if not loc or status not in (302, 303):
            break
        status, loc, _ = http.request(_lib.to_gateway(loc))

    # 5. Device polls the token endpoint and now gets tokens.
    status, _, body = http.request(
        f"{_lib.GATEWAY}/oauth2/token", "POST",
        data={"grant_type": DEVICE_GRANT, "device_code": device_code, "client_id": client_id},
    )
    assert status == 200, f"device token poll -> {status}: {body}"
    tokens = json.loads(body)
    assert "access_token" in tokens and "id_token" in tokens, tokens
    claims = _lib.decode_jwt(tokens["id_token"])
    assert claims["sub"] == address.lower(), f"sub {claims['sub']!r} != {address.lower()!r}"
