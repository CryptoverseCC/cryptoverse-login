"""The /oauth2/introspect endpoint is gated behind HTTP basic auth at the gateway
and reports issued tokens as active."""
import json

import _lib


def test_introspection_requires_auth(http, basic_client):
    tokens, _, _ = _lib.full_login(http, basic_client)
    status, _, _ = http.request(
        f"{_lib.GATEWAY}/oauth2/introspect", "POST", data={"token": tokens["access_token"]})
    assert status == 401


def test_introspection_reports_active(http, basic_client):
    tokens, _, _ = _lib.full_login(http, basic_client)
    status, _, body = http.request(
        f"{_lib.GATEWAY}/oauth2/introspect", "POST",
        data={"token": tokens["access_token"]},
        basic=f"{_lib.INTROSPECT_USER}:{_lib.INTROSPECT_PASS}")
    assert status == 200, body
    assert json.loads(body)["active"] is True
