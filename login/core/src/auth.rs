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

use serde::Serialize;
use sha2::{Digest, Sha256};
use siwe::{Message, VerificationOpts};
use time::OffsetDateTime;

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
    /// Build the SIWE parameters for a given Hydra login challenge.
    pub fn new(domain: &str, statement: &str, challenge: &str) -> Self {
        Self {
            domain: domain.to_string(),
            uri: format!("https://{domain}/"),
            statement: statement.to_string(),
            version: "1".to_string(),
            chain_id: 1,
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
    #[error("SIWE verification failed: {0}")]
    Verify(String),
}

fn decode_signature(sig: &str) -> Result<Vec<u8>, AuthError> {
    let sig = sig.strip_prefix("0x").unwrap_or(sig);
    hex::decode(sig).map_err(|e| AuthError::Signature(e.to_string()))
}

/// Verify a SIWE message + signature against the expected domain and the nonce
/// bound to the originating Hydra challenge. Validates the signature (EIP-191),
/// the nonce, the domain, and the message's time bounds (expiry / not-before).
pub async fn verify(
    message: &str,
    signature: &str,
    expected_domain: &str,
    challenge: &str,
) -> Result<VerifiedLogin, AuthError> {
    let msg: Message = message.parse().map_err(|e| AuthError::Parse(format!("{e}")))?;
    let sig = decode_signature(signature)?;

    // Domain is checked explicitly (string compare) in addition to the library
    // check, to avoid depending on the exact `Authority` type for opts.
    let got_domain = msg.domain.to_string();
    if !got_domain.eq_ignore_ascii_case(expected_domain) {
        return Err(AuthError::Domain {
            expected: expected_domain.to_string(),
            got: got_domain,
        });
    }

    let opts = VerificationOpts {
        nonce: Some(nonce_for_challenge(challenge)),
        timestamp: Some(OffsetDateTime::now_utc()),
        ..Default::default()
    };

    msg.verify(&sig, &opts)
        .await
        .map_err(|e| AuthError::Verify(format!("{e}")))?;

    Ok(VerifiedLogin {
        address: format!("0x{}", hex::encode(msg.address)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[tokio::test]
    async fn verifies_real_signature_roundtrip() {
        use alloy::signers::local::PrivateKeySigner;
        use alloy::signers::SignerSync;

        // Fixed test key (well-known Hardhat account #1).
        let signer: PrivateKeySigner =
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" // pragma: allowlist secret
                .parse()
                .unwrap();
        let address = signer.address();
        let checksummed = address.to_checksum(None);

        let challenge = "hydra-login-challenge-xyz";
        let nonce = nonce_for_challenge(challenge);

        // Exactly the EIP-4361 layout the frontend `buildSiweMessage` produces.
        let message = format!(
            "login.cryptoverse.cc wants you to sign in with your Ethereum account:\n\
             {checksummed}\n\n\
             Sign in to Cryptoverse Login\n\n\
             URI: https://login.cryptoverse.cc/\n\
             Version: 1\n\
             Chain ID: 1\n\
             Nonce: {nonce}\n\
             Issued At: 2020-01-01T00:00:00.000Z\n\
             Expiration Time: 2100-01-01T00:00:00.000Z"
        );

        let signature = signer.sign_message_sync(message.as_bytes()).unwrap();
        let sig_hex = format!("0x{}", hex::encode(signature.as_bytes()));

        let verified = verify(&message, &sig_hex, "login.cryptoverse.cc", challenge)
            .await
            .expect("valid SIWE message must verify");
        assert_eq!(
            verified.address,
            format!("0x{}", hex::encode(address.as_slice()))
        );
    }

    #[tokio::test]
    async fn rejects_wrong_nonce() {
        use alloy::signers::local::PrivateKeySigner;
        use alloy::signers::SignerSync;

        let signer: PrivateKeySigner =
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" // pragma: allowlist secret
                .parse()
                .unwrap();
        let checksummed = signer.address().to_checksum(None);
        // Nonce derived from a *different* challenge than the one we verify with.
        let nonce = nonce_for_challenge("some-other-challenge");
        let message = format!(
            "login.cryptoverse.cc wants you to sign in with your Ethereum account:\n\
             {checksummed}\n\n\
             Sign in to Cryptoverse Login\n\n\
             URI: https://login.cryptoverse.cc/\n\
             Version: 1\n\
             Chain ID: 1\n\
             Nonce: {nonce}\n\
             Issued At: 2020-01-01T00:00:00.000Z\n\
             Expiration Time: 2100-01-01T00:00:00.000Z"
        );
        let signature = signer.sign_message_sync(message.as_bytes()).unwrap();
        let sig_hex = format!("0x{}", hex::encode(signature.as_bytes()));

        let result = verify(&message, &sig_hex, "login.cryptoverse.cc", "the-real-challenge").await;
        assert!(result.is_err(), "nonce bound to wrong challenge must fail");
    }

    #[tokio::test]
    async fn rejects_garbage_signature() {
        // A syntactically valid SIWE message but a bogus signature must fail.
        let nonce = nonce_for_challenge("chal");
        let message = format!(
            "login.cryptoverse.cc wants you to sign in with your Ethereum account:\n\
             0x0000000000000000000000000000000000000000\n\n\
             Sign in to Cryptoverse Login\n\n\
             URI: https://login.cryptoverse.cc/\n\
             Version: 1\n\
             Chain ID: 1\n\
             Nonce: {nonce}\n\
             Issued At: 2026-01-01T00:00:00.000Z"
        );
        let result = verify(
            &message,
            "0xdeadbeef",
            "login.cryptoverse.cc",
            "chal",
        )
        .await;
        assert!(result.is_err());
    }
}
