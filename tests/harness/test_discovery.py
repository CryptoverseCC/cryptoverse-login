"""OIDC metadata is exposed correctly through the gateway."""
import json

import _lib


def test_openid_discovery(http):
    status, _, body = http.request(f"{_lib.GATEWAY}/.well-known/openid-configuration")
    assert status == 200, body
    d = json.loads(body)
    assert d["issuer"]
    for endpoint in ("authorization_endpoint", "token_endpoint", "jwks_uri", "userinfo_endpoint"):
        assert d.get(endpoint), f"discovery missing {endpoint}"


def test_jwks(http):
    status, _, body = http.request(f"{_lib.GATEWAY}/.well-known/jwks.json")
    assert status == 200, body
    keys = json.loads(body).get("keys", [])
    assert keys, "no signing keys published"
    assert keys[0]["kty"] == "RSA"
