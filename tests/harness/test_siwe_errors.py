"""SIWE verification rejects bad / replayed / expired signatures (no login granted)."""
from datetime import datetime, timedelta, timezone

import _lib


def _begin(http, client):
    cid, _secret, redirect = client
    _challenge, login_redirect = _lib.authorize(http, cid, redirect)
    return _lib.login_data(http, login_redirect)


def test_bad_signature_rejected(http, basic_client):
    ld = _begin(http, basic_client)
    _, address = _lib.sign("warmup")
    message = _lib.build_message(address, ld["siwe"])
    status, _, _ = _lib.post_login(http, ld["challenge"], message, "0xdeadbeef")
    assert status == 401


def test_wrong_nonce_rejected(http, basic_client):
    """A signature whose nonce isn't bound to this Hydra challenge must fail."""
    ld = _begin(http, basic_client)
    _, address = _lib.sign("warmup")
    siwe = dict(ld["siwe"], nonce="00000000000000000000000000000000")
    message = _lib.build_message(address, siwe)
    signature, _ = _lib.sign(message)
    status, _, _ = _lib.post_login(http, ld["challenge"], message, signature)
    assert status == 401


def test_expired_message_rejected(http, basic_client):
    ld = _begin(http, basic_client)
    _, address = _lib.sign("warmup")
    past = datetime.now(timezone.utc) - timedelta(hours=2)
    message = _lib.build_message(address, ld["siwe"], issued=past, expires=past + timedelta(minutes=5))
    signature, _ = _lib.sign(message)
    status, _, _ = _lib.post_login(http, ld["challenge"], message, signature)
    assert status == 401
