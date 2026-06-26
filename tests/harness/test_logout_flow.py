"""RP-initiated logout (OIDC end-session) completes through the /logout provider.

Drives the full flow: log in (which, with REMEMBER_FOR > 0, leaves a Hydra
session), then hit the end-session endpoint with the `id_token_hint` and a
registered `post_logout_redirect_uri`. Hydra validates the hint and redirects the
browser through the login backend's `/logout` provider (one-time
`logout_challenge`), which accepts and lands on the post-logout redirect.
"""
import _lib


def test_rp_initiated_logout_passes_through_provider_to_post_logout(http):
    post_logout = "http://localhost:9876/after-logout"
    client = _lib.create_client(scope="openid", post_logout_redirect_uris=[post_logout])
    try:
        tokens, _claims, _addr = _lib.full_login(http, client)

        loc = (
            f"{_lib.GATEWAY}/oauth2/sessions/logout"
            f"?id_token_hint={tokens['id_token']}"
            f"&post_logout_redirect_uri={post_logout}"
            f"&state=logout-state-xyz"
        )
        saw_provider = False
        final = None
        for _ in range(6):
            status, nxt, _ = http.request(loc)
            assert status in (200, 302, 303), f"logout step -> {status}"
            if not nxt:
                final = loc
                break
            if "/logout?" in nxt and "logout_challenge=" in nxt:
                saw_provider = True
            if nxt.startswith(post_logout):
                final = nxt
                break
            loc = nxt

        assert saw_provider, "logout did not pass through the /logout provider page"
        assert final and final.startswith(post_logout), f"final redirect was {final}"
        assert "state=logout-state-xyz" in final, "post-logout state not preserved"
    finally:
        _lib.delete_client(client[0])
