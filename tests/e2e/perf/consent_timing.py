#!/usr/bin/env python3
"""Measure GET /consent latency to verify the enrichment TTL cache (#3) +
parallel ENS/UD (#2) + real on-chain RPC (#7) on the live kind stack.

Reuses the curl-driven harness library (tests/harness/_lib.py). For each run we
drive the full SIWE login up to the consent redirect, then time JUST the
`GET /consent` request (the step that calls user_data::get_data -> ENS + UD
reverse lookups). The FIRST login for an address is a cache MISS (real parallel
RPC round-trips to mainnet); subsequent logins within the 10-min TTL are cache
HITS (no RPC).

READ-ONLY measurement. No product code is touched.

Usage:
  HARNESS_GATEWAY=https://login.127.0.0.1.nip.io:9443 HARNESS_HOST= \
    HARNESS_HYDRA_ADMIN=http://127.0.0.1:4445 \
    python3 consent_timing.py --rounds 6 --key <hex>
"""
import argparse
import os
import sys
import time
from urllib.parse import urlparse

# Make the harness library importable.
HARNESS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "harness",
)
sys.path.insert(0, HARNESS)

import _lib  # noqa: E402


def time_consent(http, login_redirect):
    """Drive login_verifier -> consent redirect, then TIME the GET /consent.

    Returns (consent_ms, consent_redirect_location). The timed request is the
    one that runs user_data::get_data (ENS + UD reverse lookups)."""
    # login_verifier -> consent_challenge redirect (not timed: pure Hydra hop).
    status, loc, _ = http.request(_lib.to_gateway(login_redirect))
    assert status in (302, 303) and "consent_challenge=" in (loc or ""), \
        f"consent redirect -> {status} {loc}"
    # THE timed step: GET /consent -> builds the enriched id_token via get_data.
    t0 = time.perf_counter()
    status, loc2, _ = http.request(_lib.to_gateway(loc))
    dt = (time.perf_counter() - t0) * 1000.0
    assert status in (302, 303), f"consent accept -> {status}"
    return dt, loc2


def one_login_consent(client, key):
    """Full SIWE login for `key`, returning the consent latency in ms."""
    client_id, secret, redirect = client
    http = _lib.Http()
    challenge, login_redirect = _lib.authorize(http, client_id, redirect)
    ld = _lib.login_data(http, login_redirect)
    _, address = _lib.sign("warmup", key)
    message = _lib.build_message(address, ld["siwe"])
    signature, _ = _lib.sign(message, key)
    status, _, body = _lib.post_login(http, ld["challenge"], message, signature)
    assert status == 200, f"/login/process -> {status}: {body}"
    import json
    consent_ms, _ = time_consent(http, json.loads(body)["redirect"])
    return consent_ms, address


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=6,
                    help="number of consecutive logins for the SAME address")
    ap.add_argument("--key", default=_lib.TEST_KEY,
                    help="signer private key hex (default: Hardhat #1)")
    args = ap.parse_args()

    print(f"GATEWAY={_lib.GATEWAY} HYDRA_ADMIN={_lib.HYDRA_ADMIN}")
    client = _lib.create_client()
    try:
        times = []
        addr = None
        for i in range(args.rounds):
            ms, addr = one_login_consent(client, args.key)
            tag = "MISS (cold, real RPC)" if i == 0 else "expect HIT (cached)"
            times.append(ms)
            print(f"  round {i+1}: consent GET = {ms:8.1f} ms   [{tag}]")
        print(f"\naddress under test: {addr.lower()}")
        print(f"round 1 (cold/miss): {times[0]:.1f} ms")
        if len(times) > 1:
            warm = times[1:]
            print(f"rounds 2..{len(times)} (cached): "
                  f"min {min(warm):.1f}  max {max(warm):.1f}  "
                  f"mean {sum(warm)/len(warm):.1f} ms")
            print(f"speedup (cold / cached-mean): "
                  f"{times[0] / (sum(warm)/len(warm)):.1f}x")
    finally:
        _lib.delete_client(client[0])


if __name__ == "__main__":
    main()
