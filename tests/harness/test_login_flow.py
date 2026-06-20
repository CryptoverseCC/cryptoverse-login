"""The full authorization-code + SIWE + consent flow yields an enriched ID token."""
import json

import _lib


def test_full_siwe_login(http, basic_client):
    tokens, claims, address = _lib.full_login(http, basic_client)
    sub = address.lower()

    assert "access_token" in tokens and "id_token" in tokens
    assert claims["sub"] == sub
    assert claims["email"] == f"{sub}@{_lib.MAILSERVER_DOMAIN}"
    assert claims["email_verified"] is True
    assert claims["name"] == sub
    assert claims["preferred_username"] == sub
    assert claims["names"]["default"] == sub
    assert claims["emails"]["default"] == f"{sub}@{_lib.MAILSERVER_DOMAIN}"
    # The test account has no ENS / Unstoppable Domains names.
    assert claims["emails"]["ens"]["default"] is None
    assert claims["names"]["unstoppabledomains"]["default"] is None
    assert claims["address"] == {"country": "Cryptoverse", "region": "Ethereum"}


def test_userinfo_returns_subject(http, basic_client):
    tokens, _, address = _lib.full_login(http, basic_client)
    status, _, body = http.request(
        f"{_lib.GATEWAY}/userinfo",
        headers=[f"Authorization: Bearer {tokens['access_token']}"],
    )
    assert status == 200, body
    assert json.loads(body)["sub"] == address.lower()
