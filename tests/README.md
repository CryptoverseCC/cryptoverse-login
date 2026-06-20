# Tests

Two layers, both run against a deployed stack (use [`kind/`](kind/README.md) for
a production-faithful local cluster):

- **[`harness/`](harness/README.md) — the correctness harness (start here).** A
  fast, deterministic, browser-free suite that drives the whole IdP over HTTP
  (OIDC discovery, SIWE auth-code login, consent, tokens, claims, token-gating,
  introspection). This is what you re-run to know the system still works.
- **`test_full.py` — the browser/wallet e2e.** A real Firefox + MetaMask through
  the demo RP → Sign-In with Ethereum → back to the demo, asserting the ID-token
  claims. Higher-fidelity but slower/heavier (pinned MetaMask + geckodriver).

```bash
tests/kind/setup.sh              # bring up the cluster (prints the exact commands)
pytest tests/harness/ -v         # prove correctness (see harness/README.md for env)
pytest tests/test_full.py -v     # full browser/wallet run
```

---

## Browser/wallet e2e (`test_full.py`)

`test_full.py` drives a real Firefox + MetaMask through the whole login flow
against a deployed stack: demo RP → Sign-In with Ethereum → back to the demo,
then asserts the issued ID-token claims.

### 1. Bring up a local cluster (kind)

See [`kind/README.md`](kind/README.md):

```bash
tests/kind/setup.sh
```

This deploys the real charts (gateway + login + wrapper + Ory Hydra 2.x) and the
demo app on a local kind cluster and prints the exact test command, e.g.:

```
DOMAIN_LOGIN=login.127.0.0.1.nip.io DOMAIN_DEMO_APP=demo.127.0.0.1.nip.io \
  pytest test_full.py -v --log-cli-level=INFO
```

### 2. Test prerequisites

- **geckodriver** in `tests/tools/` (already vendored; update from
  [releases](https://github.com/mozilla/geckodriver/releases) if your Firefox is
  newer).
- **MetaMask** is pinned to `extensions/metamask-firefox-9.1.0.zip` — the page
  selectors in `metamask/pages.py` match that version, so don't bump it casually.
- Python deps:

```bash
cd tests
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

### 3. Run

```bash
DOMAIN_LOGIN=login.127.0.0.1.nip.io DOMAIN_DEMO_APP=demo.127.0.0.1.nip.io \
  pytest test_full.py -v --log-cli-level=INFO
```

Env vars:

| var | default | meaning |
|---|---|---|
| `DOMAIN_LOGIN` | `login.cryptoverse.cc` | the IdP host |
| `DOMAIN_DEMO_APP` | `login-demo.cryptoverse.cc` | the demo RP host |
| `ASSETS_PATH` | `./assets` | screenshots are written here |
| `HEADLESS` | `1` | set `0` to watch the browser |

The test seeds MetaMask from a fixed mnemonic (account
`0xae89b4e1b97661dab58bee7771e95ec58fc6a94b`) and verifies the ID token's `sub`,
generated email, and ENS/UD name structure.

## Notes

- The login message is now **EIP-4361 (Sign-In with Ethereum)**; the Selenium
  flow is unchanged (MetaMask still shows a "Sign" button for `personal_sign`).
- Self-signed certs are accepted via `acceptInsecureCerts` (set in the fixture).
- `mobile.py` is an unmaintained WalletConnect/mobile experiment, not part of the
  suite.
