//! EIP-4361 (Sign-In with Ethereum) verification.
//!
//! The previous implementation used an ad-hoc signed string
//! (`Cryptoverse Login - auth.cryptoverse.cc|csrf|challenge`) with no nonce,
//! expiry or domain binding. This module replaces it with standard SIWE using
//! the [`siwe`] crate, so any spec-compliant wallet/library interoperates.
//!
//! ## Stateless nonce binding
//!
//! SIWE's nonce exists for replay protection. Rather than persisting nonces in a
//! shared store (which would force sticky sessions across replicas), we derive
//! the nonce deterministically from Hydra's one-time `login_challenge`. The
//! challenge is already high-entropy and server-issued, so binding the nonce to
//! it ties a signature to exactly one login flow while staying fully stateless.

use alloy::primitives::Address;
use serde::Serialize;
use sha2::{Digest, Sha256};
use siwe::{Message, VerificationOpts};
use time::{Duration, OffsetDateTime};

use crate::eth::{Eth, EthError, SigCheck};

/// Default SIWE chain id when `SIWE_CHAIN_ID` is unset (Ethereum mainnet).
const DEFAULT_CHAIN_ID: u64 = 1;

/// Hard cap on how far in the past a message's `Issued At` may be, regardless of
/// the message's own (attacker-controlled) `Expiration Time`. A signature older
/// than this is rejected even if it claims a far-future expiry — bounding the
/// replay window server-side. The frontend's own expiry is much shorter (10
/// min); this is the backstop.
const MAX_MESSAGE_AGE: Duration = Duration::minutes(60);

/// The configured SIWE chain id (`SIWE_CHAIN_ID`, default mainnet). Flows into
/// both the issued [`SiweChallenge`] (→ `loginData.siwe.chainId` for the
/// frontend) and the `verify` check, so the two cannot drift apart.
pub fn configured_chain_id() -> u64 {
    crate::config::var_opt("SIWE_CHAIN_ID")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_CHAIN_ID)
}

/// Parameters handed to the frontend (via `loginData`) so it can assemble the
/// canonical EIP-4361 message with the connected wallet address.
#[derive(Debug, Clone, Serialize)]
pub struct SiweChallenge {
    pub domain: String,
    pub uri: String,
    pub statement: String,
    pub version: String,
    #[serde(rename = "chainId")]
    pub chain_id: u64,
    pub nonce: String,
    /// How long (minutes) the assembled message stays valid; the frontend sets
    /// `expirationTime = issuedAt + this`.
    #[serde(rename = "expirationMinutes")]
    pub expiration_minutes: u32,
}

impl SiweChallenge {
    /// Build the SIWE parameters for a given Hydra login challenge. `host` and
    /// `scheme` come from the incoming request (forwarded by the ingress), so the
    /// SIWE domain follows whatever host the user actually visited — no hardcoded
    /// domain or port. `chain_id` is the configured [`configured_chain_id`], so
    /// the value the frontend signs is the value `verify` enforces.
    pub fn new(host: &str, scheme: &str, statement: &str, challenge: &str, chain_id: u64) -> Self {
        Self {
            domain: host.to_string(),
            uri: format!("{scheme}://{host}/"),
            statement: statement.to_string(),
            version: "1".to_string(),
            chain_id,
            nonce: nonce_for_challenge(challenge),
            expiration_minutes: 10,
        }
    }
}

/// Deterministically derive a SIWE-valid nonce (`[a-zA-Z0-9]{8,}`) from the
/// Hydra login challenge. Same challenge → same nonce, so verification needs no
/// shared state.
pub fn nonce_for_challenge(challenge: &str) -> String {
    let digest = Sha256::digest(challenge.as_bytes());
    // 16 bytes -> 32 lowercase hex chars: alphanumeric and well over the 8-char
    // minimum required by EIP-4361.
    hex::encode(&digest[..16])
}

/// Outcome of a successful verification.
#[derive(Debug, Clone)]
pub struct VerifiedLogin {
    /// Lowercased `0x`-prefixed Ethereum address of the signer.
    pub address: String,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("malformed SIWE message: {0}")]
    Parse(String),
    #[error("malformed signature: {0}")]
    Signature(String),
    #[error("domain mismatch: expected `{expected}`, got `{got}`")]
    Domain { expected: String, got: String },
    /// The message's `version`, `chainId`, or `uri` didn't match what this IdP
    /// issued, or a required field (e.g. `Expiration Time`) was absent.
    #[error("SIWE field mismatch: {0}")]
    Field(String),
    /// Time-bound failure: expired, not-yet-valid, missing expiry, or too old.
    #[error("SIWE message time check failed: {0}")]
    Time(String),
    #[error("SIWE verification failed: {0}")]
    Verify(String),
    /// We could not reach the RPC to validate a contract-wallet (ERC-1271/6492)
    /// signature, so validity is **unknown**. This is *not* "invalid" — the
    /// caller should surface a retryable error (HTTP 503), not a 401, so a flaky
    /// RPC doesn't look like a forged signature to a Safe / smart-account user.
    #[error("could not verify wallet signature on-chain right now: {0}")]
    RpcUnavailable(String),
}

fn decode_signature(sig: &str) -> Result<Vec<u8>, AuthError> {
    let sig = sig.strip_prefix("0x").unwrap_or(sig);
    hex::decode(sig).map_err(|e| AuthError::Signature(e.to_string()))
}

/// Verify a SIWE message + signature against the expected domain and the nonce
/// bound to the originating Hydra challenge. Validates the nonce, the domain,
/// the message's time bounds (expiry / not-before) and the signature.
///
/// ## Signature verification: EOA → ERC-1271 → ERC-6492
///
/// 1. **EOA fast path (no network):** try EIP-191 `ecrecover`. If the recovered
///    address matches the SIWE `address`, we're done — purely local, so the
///    common case stays stateless and offline.
/// 2. **Contract wallets:** if the fast path doesn't match (recovery failed, or
///    the wallet is a smart contract whose signature isn't a 65-byte ECDSA sig),
///    fall through to on-chain validation via [`Eth::verify_signature`]. That
///    one `eth_call` covers both **ERC-1271** (already-deployed contract wallet)
///    and **ERC-6492** (counterfactual / not-yet-deployed wallet, e.g. a fresh
///    Coinbase Smart Wallet) — see its docs. This needs the RPC, hence `eth`.
///
/// The domain / nonce / time / version / chain / uri checks are enforced
/// *before and regardless of* which signature path matches, so a contract-wallet
/// signature is held to the same replay/expiry/binding rules as an EOA one.
///
/// ## Single-use / replay
///
/// There is deliberately **no shared nonce store** (it would force sticky
/// sessions across replicas, see the module docs). Single-use is instead
/// enforced by the combination of:
///   1. the nonce being bound to Hydra's one-time `login_challenge`, and
///   2. `accept_login_request` invalidating that challenge on first use — so a
///      replayed `(message, signature)` for the same challenge is rejected by
///      Hydra at the accept step, and a different challenge yields a different
///      required nonce here, and
///   3. a **mandatory** `Expiration Time` plus a server-side [`MAX_MESSAGE_AGE`]
///      cap, so even before Hydra consumes the challenge the replay window is
///      bounded (a never-expiring SIWE message is rejected outright).
///
/// `expected_host` / `expected_scheme` are the public origin the ingress
/// forwarded; `expected_chain_id` is [`configured_chain_id`].
pub async fn verify(
    message: &str,
    signature: &str,
    expected_host: &str,
    expected_scheme: &str,
    expected_chain_id: u64,
    challenge: &str,
    eth: &Eth,
) -> Result<VerifiedLogin, AuthError> {
    // Browsers normalise a form field's LF to CRLF on submit, but EIP-4361 uses
    // LF and the wallet signed the LF form — so strip CR before parsing/verifying.
    let message = message.replace("\r\n", "\n");
    let msg: Message = message
        .parse()
        .map_err(|e| AuthError::Parse(format!("{e}")))?;
    let sig = decode_signature(signature)?;

    // --- Field binding: the message must match what *this* IdP issued. ------
    // Domain (string compare, in addition to the library's opts check).
    let got_domain = msg.domain.to_string();
    if !got_domain.eq_ignore_ascii_case(expected_host) {
        return Err(AuthError::Domain {
            expected: expected_host.to_string(),
            got: got_domain,
        });
    }
    // Version: the siwe crate already only parses "1" (→ Version::V1), but be
    // explicit so an intent change is obvious and any future variant is rejected.
    if !matches!(msg.version, siwe::Version::V1) {
        return Err(AuthError::Field(format!(
            "unsupported SIWE version: {:?}",
            msg.version
        )));
    }
    // Chain id must equal the configured chain.
    if msg.chain_id != expected_chain_id {
        return Err(AuthError::Field(format!(
            "chain id mismatch: expected {expected_chain_id}, got {}",
            msg.chain_id
        )));
    }
    // URI scheme+host must match the expected origin. The frontend builds the
    // URI as `{scheme}://{host}/`, so compare those components (ignore path /
    // trailing slash, which carry no security meaning here).
    match (msg.uri.scheme_str(), uri_host(&msg)) {
        (scheme, Some(host))
            if scheme.eq_ignore_ascii_case(expected_scheme)
                && host.eq_ignore_ascii_case(expected_host) => {}
        _ => {
            return Err(AuthError::Field(format!(
                "uri mismatch: expected `{expected_scheme}://{expected_host}`, got `{}`",
                msg.uri
            )));
        }
    }

    // --- Time bounds: independent of the signature scheme. ------------------
    let now = OffsetDateTime::now_utc();
    // Require an explicit expiry. `valid_at` returns true when `expiration_time`
    // is absent → a never-expiring, infinitely-replayable message. Reject it.
    let Some(exp) = msg.expiration_time.as_ref() else {
        return Err(AuthError::Time(
            "message has no Expiration Time (would never expire)".into(),
        ));
    };
    if *exp < now {
        return Err(AuthError::Time("message has expired".into()));
    }
    // not-before (if present) must already have passed.
    if let Some(nbf) = msg.not_before.as_ref() {
        if *nbf > now {
            return Err(AuthError::Time("message is not yet valid".into()));
        }
    }
    // Server-side max-age backstop: reject a signature whose Issued At is too far
    // in the past even if it claims a far-future expiry.
    let issued_at: &OffsetDateTime = msg.issued_at.as_ref();
    if now - *issued_at > MAX_MESSAGE_AGE {
        return Err(AuthError::Time(format!(
            "message issued too long ago (> {} min)",
            MAX_MESSAGE_AGE.whole_minutes()
        )));
    }
    // Also guard against a wildly future Issued At (clock skew abuse).
    if *issued_at - now > Duration::minutes(5) {
        return Err(AuthError::Time("message issued in the future".into()));
    }

    // --- Nonce: bound to the one-time Hydra challenge. ----------------------
    let expected_nonce = nonce_for_challenge(challenge);
    if msg.nonce != expected_nonce {
        return Err(AuthError::Verify(format!(
            "nonce mismatch: expected `{expected_nonce}`, got `{}`",
            msg.nonce
        )));
    }

    // 1. EOA fast path — EIP-191 ecrecover, no network. `verify` checks the
    //    recovered address equals the SIWE address, plus nonce/time again.
    let opts = VerificationOpts {
        nonce: Some(expected_nonce),
        timestamp: Some(now),
        ..Default::default()
    };
    let eip191_err = match msg.verify(&sig, &opts).await {
        Ok(()) => {
            return Ok(VerifiedLogin {
                address: format!("0x{}", hex::encode(msg.address)),
            });
        }
        // Keep the original EIP-191 error so we can log/return it instead of
        // discarding it when the contract path also doesn't apply.
        Err(e) => e,
    };

    // We only reach here for a *signature* failure of the EOA path. Domain,
    // version, chain, URI, expiry/not-before, max-age and nonce were all already
    // checked and short-circuited above, so `msg.verify` (which re-checks nonce
    // and time) cannot be failing for those reasons now — the only remaining
    // cause is "these bytes aren't a valid 65-byte ECDSA sig recovering to this
    // address", which is exactly the smart-contract-wallet case to try on-chain.
    // The preserved `eip191_err` is logged and folded into the final error rather
    // than discarded, so a genuine bad-EOA-sig isn't masked by the contract path.
    tracing::debug!("EIP-191 EOA verify did not match ({eip191_err}); trying contract path");

    // 2. Contract wallet — ERC-1271 (deployed) / ERC-6492 (counterfactual).
    //    The hash is the EIP-191 personal_sign hash of the SIWE message string,
    //    which siwe computes for us, identical to what the wallet signed over.
    let hash = msg
        .eip191_hash()
        .map_err(|e| AuthError::Verify(format!("hashing message failed: {e}")))?;
    let signer = Address::from(msg.address);
    match eth.verify_signature(signer, hash.into(), &sig).await {
        Ok(SigCheck::Valid) => Ok(VerifiedLogin {
            address: format!("0x{}", hex::encode(msg.address)),
        }),
        Ok(SigCheck::Invalid) => Err(AuthError::Verify(format!(
            "signature is not a valid EOA (EIP-191: {eip191_err}), ERC-1271 or ERC-6492 signature"
        ))),
        // RPC unreachable: validity is unknown. Surface it distinctly so the
        // route returns a retryable 503 rather than a "forged signature" 401.
        Err(EthError::Unavailable { .. }) => Err(AuthError::RpcUnavailable(
            "on-chain signature validation RPC unreachable".into(),
        )),
    }
}

/// Host component of a SIWE message's `uri` (`iri-string` exposes it via the
/// authority components). Returns `None` if the URI has no authority.
fn uri_host(msg: &Message) -> Option<String> {
    msg.uri.authority_components().map(|a| a.host().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An `Eth` whose RPC is a non-routable address, so the contract-wallet
    /// (ERC-1271/6492) fallback fails fast with a connection error (→ `false`)
    /// instead of reaching the network. Tests that hit the EOA fast path never
    /// touch it; tests of *rejection* use it to prove no signature slips through
    /// the contract path either — all without real network access.
    fn offline_eth() -> Eth {
        // Point at a closed local port so the contract-path `eth_call` fails fast
        // with connection-refused (no real network, no timeout wait).
        std::env::remove_var("ALCHEMY_API_KEY");
        std::env::remove_var("INFURA_API_KEY");
        std::env::set_var("ETH_RPC_URL", "http://127.0.0.1:1");
        Eth::from_env().expect("build offline Eth")
    }

    #[test]
    fn nonce_is_deterministic_and_valid() {
        let a = nonce_for_challenge("abc123challenge");
        let b = nonce_for_challenge("abc123challenge");
        assert_eq!(a, b);
        assert!(a.len() >= 8);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn nonce_differs_per_challenge() {
        assert_ne!(nonce_for_challenge("one"), nonce_for_challenge("two"));
    }

    use alloy::signers::local::PrivateKeySigner;
    use alloy::signers::SignerSync;
    use time::format_description::well_known::Rfc3339;

    const TEST_HOST: &str = "login.cryptoverse.cc";
    const TEST_SCHEME: &str = "https";
    const TEST_CHAIN: u64 = 1;
    /// Hardhat account #1 — a well-known throwaway test key.
    const TEST_KEY: &str = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // pragma: allowlist secret

    fn test_signer() -> PrivateKeySigner {
        TEST_KEY.parse().unwrap()
    }

    fn rfc3339(t: OffsetDateTime) -> String {
        t.format(&Rfc3339).unwrap()
    }

    /// Build the canonical EIP-4361 message the frontend produces, with
    /// overridable fields so each negative test can perturb exactly one thing.
    #[allow(clippy::too_many_arguments)]
    fn build_message(
        address_line: &str,
        statement: &str,
        uri: &str,
        version: &str,
        chain_id: &str,
        nonce: &str,
        issued_at: &str,
        expiration: Option<&str>,
        not_before: Option<&str>,
    ) -> String {
        let mut m = format!(
            "{TEST_HOST} wants you to sign in with your Ethereum account:\n\
             {address_line}\n\n\
             {statement}\n\n\
             URI: {uri}\n\
             Version: {version}\n\
             Chain ID: {chain_id}\n\
             Nonce: {nonce}\n\
             Issued At: {issued_at}"
        );
        if let Some(exp) = expiration {
            m.push_str(&format!("\nExpiration Time: {exp}"));
        }
        if let Some(nbf) = not_before {
            m.push_str(&format!("\nNot Before: {nbf}"));
        }
        m
    }

    /// A valid, freshly-issued message for `challenge`, signed by the test key.
    fn signed_valid(challenge: &str) -> (String, String) {
        let signer = test_signer();
        let now = OffsetDateTime::now_utc();
        let message = build_message(
            &signer.address().to_checksum(None),
            "Sign in to Cryptoverse Login",
            "https://login.cryptoverse.cc/",
            "1",
            "1",
            &nonce_for_challenge(challenge),
            &rfc3339(now),
            Some(&rfc3339(now + Duration::minutes(10))),
            None,
        );
        let sig = signer.sign_message_sync(message.as_bytes()).unwrap();
        (message, format!("0x{}", hex::encode(sig.as_bytes())))
    }

    async fn run(message: &str, sig: &str, challenge: &str) -> Result<VerifiedLogin, AuthError> {
        verify(
            message,
            sig,
            TEST_HOST,
            TEST_SCHEME,
            TEST_CHAIN,
            challenge,
            &offline_eth(),
        )
        .await
    }

    #[tokio::test]
    async fn verifies_real_signature_roundtrip() {
        let challenge = "hydra-login-challenge-xyz";
        let (message, sig) = signed_valid(challenge);
        let verified = run(&message, &sig, challenge)
            .await
            .expect("valid SIWE message must verify");
        assert_eq!(
            verified.address,
            format!("0x{}", hex::encode(test_signer().address().as_slice()))
        );
    }

    #[tokio::test]
    async fn verifies_message_with_crlf_line_endings() {
        // The wallet signs the LF form; the browser then POSTs CRLF.
        let challenge = "crlf-challenge";
        let (lf, sig) = signed_valid(challenge);
        let crlf = lf.replace('\n', "\r\n");
        let verified = run(&crlf, &sig, challenge)
            .await
            .expect("CRLF-normalised message must verify");
        assert_eq!(
            verified.address,
            format!("0x{}", hex::encode(test_signer().address().as_slice()))
        );
    }

    #[tokio::test]
    async fn rejects_wrong_nonce() {
        // Sign with a nonce bound to a *different* challenge than we verify with.
        let (message, sig) = signed_valid("some-other-challenge");
        let result = run(&message, &sig, "the-real-challenge").await;
        assert!(
            matches!(result, Err(AuthError::Verify(_))),
            "nonce bound to wrong challenge must fail: {result:?}"
        );
    }

    #[tokio::test]
    async fn rejects_garbage_signature() {
        let challenge = "chal";
        let (message, _) = signed_valid(challenge);
        // Valid message, bogus signature → offline contract path can't reach an
        // RPC, so this surfaces as RpcUnavailable (couldn't check) — still a
        // failure (never Ok). A reachable-but-invalid sig would be Verify.
        let result = run(&message, "0xdeadbeef", challenge).await;
        assert!(result.is_err(), "a garbage signature must never verify");
    }

    // --- New negative tests (item 10) --------------------------------------

    #[tokio::test]
    async fn rejects_wrong_domain() {
        let challenge = "dom";
        let (message, sig) = signed_valid(challenge);
        // Verify against a different expected host than the message's domain.
        let result = verify(
            &message,
            &sig,
            "evil.example.com",
            TEST_SCHEME,
            TEST_CHAIN,
            challenge,
            &offline_eth(),
        )
        .await;
        assert!(
            matches!(result, Err(AuthError::Domain { .. })),
            "wrong domain must be a Domain error: {result:?}"
        );
    }

    #[tokio::test]
    async fn rejects_wrong_chain_id() {
        let challenge = "chain";
        let (message, sig) = signed_valid(challenge);
        // Expect a different chain than the message's `Chain ID: 1`.
        let result = verify(
            &message,
            &sig,
            TEST_HOST,
            TEST_SCHEME,
            137,
            challenge,
            &offline_eth(),
        )
        .await;
        assert!(
            matches!(result, Err(AuthError::Field(_))),
            "wrong chain id must be a Field error: {result:?}"
        );
    }

    #[tokio::test]
    async fn rejects_wrong_uri_scheme() {
        let challenge = "uri";
        let signer = test_signer();
        let now = OffsetDateTime::now_utc();
        // URI with an http scheme while we expect https.
        let message = build_message(
            &signer.address().to_checksum(None),
            "Sign in to Cryptoverse Login",
            "http://login.cryptoverse.cc/",
            "1",
            "1",
            &nonce_for_challenge(challenge),
            &rfc3339(now),
            Some(&rfc3339(now + Duration::minutes(10))),
            None,
        );
        let sig = signer.sign_message_sync(message.as_bytes()).unwrap();
        let sig = format!("0x{}", hex::encode(sig.as_bytes()));
        let result = run(&message, &sig, challenge).await;
        assert!(
            matches!(result, Err(AuthError::Field(_))),
            "mismatched URI scheme must be a Field error: {result:?}"
        );
    }

    #[tokio::test]
    async fn rejects_missing_expiration_time() {
        let challenge = "noexp";
        let signer = test_signer();
        let now = OffsetDateTime::now_utc();
        let message = build_message(
            &signer.address().to_checksum(None),
            "Sign in to Cryptoverse Login",
            "https://login.cryptoverse.cc/",
            "1",
            "1",
            &nonce_for_challenge(challenge),
            &rfc3339(now),
            None, // no Expiration Time
            None,
        );
        let sig = signer.sign_message_sync(message.as_bytes()).unwrap();
        let sig = format!("0x{}", hex::encode(sig.as_bytes()));
        let result = run(&message, &sig, challenge).await;
        assert!(
            matches!(result, Err(AuthError::Time(_))),
            "a never-expiring message must be a Time error: {result:?}"
        );
    }

    #[tokio::test]
    async fn rejects_expired_message() {
        let challenge = "exp";
        let signer = test_signer();
        let now = OffsetDateTime::now_utc();
        // Issued and expired in the recent past (still within max-age window).
        let message = build_message(
            &signer.address().to_checksum(None),
            "Sign in to Cryptoverse Login",
            "https://login.cryptoverse.cc/",
            "1",
            "1",
            &nonce_for_challenge(challenge),
            &rfc3339(now - Duration::minutes(20)),
            Some(&rfc3339(now - Duration::minutes(10))),
            None,
        );
        let sig = signer.sign_message_sync(message.as_bytes()).unwrap();
        let sig = format!("0x{}", hex::encode(sig.as_bytes()));
        let result = run(&message, &sig, challenge).await;
        assert!(
            matches!(result, Err(AuthError::Time(_))),
            "an expired message must be a Time error: {result:?}"
        );
    }

    #[tokio::test]
    async fn rejects_not_yet_valid_message() {
        let challenge = "nbf";
        let signer = test_signer();
        let now = OffsetDateTime::now_utc();
        let message = build_message(
            &signer.address().to_checksum(None),
            "Sign in to Cryptoverse Login",
            "https://login.cryptoverse.cc/",
            "1",
            "1",
            &nonce_for_challenge(challenge),
            &rfc3339(now),
            Some(&rfc3339(now + Duration::minutes(30))),
            Some(&rfc3339(now + Duration::minutes(10))), // Not Before in the future
        );
        let sig = signer.sign_message_sync(message.as_bytes()).unwrap();
        let sig = format!("0x{}", hex::encode(sig.as_bytes()));
        let result = run(&message, &sig, challenge).await;
        assert!(
            matches!(result, Err(AuthError::Time(_))),
            "a not-yet-valid message must be a Time error: {result:?}"
        );
    }

    #[tokio::test]
    async fn rejects_too_old_message() {
        let challenge = "old";
        let signer = test_signer();
        let now = OffsetDateTime::now_utc();
        // Issued 2 h ago but claims a far-future expiry → caught by MAX_MESSAGE_AGE.
        let message = build_message(
            &signer.address().to_checksum(None),
            "Sign in to Cryptoverse Login",
            "https://login.cryptoverse.cc/",
            "1",
            "1",
            &nonce_for_challenge(challenge),
            &rfc3339(now - Duration::hours(2)),
            Some(&rfc3339(now + Duration::hours(24))),
            None,
        );
        let sig = signer.sign_message_sync(message.as_bytes()).unwrap();
        let sig = format!("0x{}", hex::encode(sig.as_bytes()));
        let result = run(&message, &sig, challenge).await;
        assert!(
            matches!(result, Err(AuthError::Time(_))),
            "an over-aged message must be a Time error: {result:?}"
        );
    }

    #[tokio::test]
    async fn rejects_tampered_statement() {
        // Sign message A, then submit an altered message B (different statement)
        // with A's signature → recovery yields a different address ⇒ rejected.
        let challenge = "tamper";
        let (message, sig) = signed_valid(challenge);
        let tampered = message.replace(
            "Sign in to Cryptoverse Login",
            "Sign in to Cryptoverse Login and approve a transfer",
        );
        assert_ne!(tampered, message, "tamper must actually change the message");
        let result = run(&tampered, &sig, challenge).await;
        assert!(
            result.is_err(),
            "a message altered after signing must not verify: {result:?}"
        );
    }

    #[tokio::test]
    async fn rejects_tampered_uri() {
        // Same as above but tamper the URI host (also fails the URI field check,
        // and would fail signature recovery regardless).
        let challenge = "tamperuri";
        let (message, sig) = signed_valid(challenge);
        let tampered = message.replace(
            "URI: https://login.cryptoverse.cc/",
            "URI: https://evil.example.com/",
        );
        let result = run(&tampered, &sig, challenge).await;
        assert!(
            result.is_err(),
            "a message with an altered URI must not verify: {result:?}"
        );
    }

    #[tokio::test]
    async fn configured_chain_id_defaults_and_reads_env() {
        std::env::remove_var("SIWE_CHAIN_ID");
        assert_eq!(configured_chain_id(), 1, "default chain id is mainnet");
        std::env::set_var("SIWE_CHAIN_ID", "137");
        assert_eq!(configured_chain_id(), 137);
        std::env::remove_var("SIWE_CHAIN_ID");
    }
}
