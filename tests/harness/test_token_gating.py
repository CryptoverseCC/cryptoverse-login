"""Token-gating: restrictions on the client's metadata allow/deny login by
on-chain balance. The test account holds 0 of every mainnet token, so the
assertions are deterministic."""
import _lib


def _attempt_login(http, client):
    cid, _secret, redirect = client
    _challenge, login_redirect = _lib.authorize(http, cid, redirect)
    ld = _lib.login_data(http, login_redirect)
    _, address = _lib.sign("warmup")
    message = _lib.build_message(address, ld["siwe"])
    signature, _ = _lib.sign(message)
    return _lib.post_login(http, ld["challenge"], message, signature)


def test_gating_denies_insufficient_balance(http):
    client = _lib.create_client(metadata={
        "app": "gated-deny",
        "restrictions": [{"tokenAddress": _lib.USDC, "condition": "balanceOf > 0"}],
    })
    try:
        status, _, body = _attempt_login(http, client)
        assert status == 403, f"expected login denied, got {status}: {body}"
    finally:
        _lib.delete_client(client[0])


def test_gating_allows_when_condition_met(http):
    client = _lib.create_client(metadata={
        "app": "gated-allow",
        "restrictions": [{"tokenAddress": _lib.USDC, "condition": "balanceOf >= 0"}],
    })
    try:
        status, _, body = _attempt_login(http, client)
        assert status == 200, f"expected login allowed, got {status}: {body}"
    finally:
        _lib.delete_client(client[0])
