//! Deterministic ERC-1271 (deployed smart-account) signature coverage.
//!
//! `core::auth::verify` tries an EIP-191 `ecrecover` fast path, then falls back
//! to [`cryptoverse_core::eth::Eth::verify_signature`], which deployless-
//! `eth_call`s the ERC-6492 universal validator. That fallback is the **only**
//! path a Safe / Argent / Coinbase-Smart-Wallet user takes — an EOA test never
//! reaches it, so a bug there silently locks out every smart-account user. Live
//! coverage exists (the `#[ignore]`d `live_erc6492_coinbase_smart_wallet` test),
//! but it needs a mainnet RPC and so never runs in CI.
//!
//! This test makes the **deployed ERC-1271** branch covered *deterministically*:
//! it spawns a local [`anvil`] node, deploys a minimal `Mock1271` contract whose
//! `isValidSignature` raw-`ecrecover`s the 65-byte sig against a stored owner,
//! and drives the real [`Eth::verify_signature`] / [`auth::verify`] code against
//! it — no network, no live RPC. The counterfactual ERC-6492 (CREATE2 factory)
//! case stays covered by the live CBSW test plus the offline 6492-wrapper unit
//! tests in `eth.rs`; building a 6492 factory here is deliberately out of scope.
//!
//! ## Skip vs. fail
//!
//! `anvil` may be absent locally. The test then **skips cleanly** — UNLESS
//! `CV_REQUIRE_ANVIL` is set (CI sets it), in which case a missing `anvil` is a
//! hard `panic!` so CI can never silently lose this coverage.
//!
//! ## Why one test function
//!
//! `Eth::from_env()` reads process-global env (`ETH_RPC_URL`, `RPC_TIMEOUT_MS`,
//! …). Setting those is a global mutation that would race other `#[tokio::test]`s
//! run in parallel by the test harness. So *all* anvil work lives in this single
//! `#[tokio::test]` — anvil is spawned once, the mock deployed once, and the
//! three asserts run sequentially, with no env race against any sibling test.

use alloy::network::{EthereumWallet, TransactionBuilder};
use alloy::node_bindings::Anvil;
use alloy::primitives::{keccak256, Address, B256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::SignerSync;
use alloy::sol_types::SolValue;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use cryptoverse_core::auth::{nonce_for_challenge, verify};
use cryptoverse_core::eth::{Eth, SigCheck};

/// Creation (constructor) bytecode of the minimal ERC-1271 mock below, produced
/// by `forge inspect Mock1271 bytecode` with **solc 0.8.35** (optimizer on, 200
/// runs). It returns the ERC-1271 magic value `0x1626ba7e` iff the 65-byte sig
/// **raw-`ecrecover`s** to the constructor-stored owner; otherwise `0xffffffff`.
///
/// Mirrors the `UNIVERSAL_VALIDATOR_BYTECODE` convention in `eth.rs`: the source
/// is recorded here so a regeneration is auditable, and a tiny offline test
/// (`mock1271_bytecode_is_valid_hex`) decodes it so a truncated paste is caught
/// even on a machine without `anvil`.
///
/// ```solidity
/// // SPDX-License-Identifier: MIT
/// pragma solidity ^0.8.20;
/// contract Mock1271 {
///     address public owner;
///     constructor(address _owner) { owner = _owner; }
///     function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
///         if (sig.length != 65) return 0xffffffff;
///         bytes32 r = bytes32(sig[0:32]); bytes32 s = bytes32(sig[32:64]); uint8 v = uint8(sig[64]);
///         return ecrecover(hash, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
///     }
/// }
/// ```
const MOCK1271_CREATION_BYTECODE: &str = "6080604052348015600e575f5ffd5b5060405161031e38038061031e833981016040819052602b91604e565b5f80546001600160a01b0319166001600160a01b03929092169190911790556079565b5f60208284031215605d575f5ffd5b81516001600160a01b03811681146072575f5ffd5b9392505050565b610298806100865f395ff3fe608060405234801561000f575f5ffd5b5060043610610034575f3560e01c80631626ba7e146100385780638da5cb5b14610069575b5f5ffd5b61004b610046366004610192565b610093565b6040516001600160e01b031990911681526020015b60405180910390f35b5f5461007b906001600160a01b031681565b6040516001600160a01b039091168152602001610060565b5f604182146100ab57506001600160e01b031961018b565b5f6100b96020828587610209565b6100c291610230565b90505f6100d3604060208688610209565b6100dc91610230565b90505f858560408181106100f2576100f261024e565b5f805460408051928352602083018082528d9052949092013560f81c93810184905260608101879052608081018690529293506001600160a01b0316916001915060a0016020604051602081039080840390855afa158015610156573d5f5f3e3d5ffd5b505050602060405103516001600160a01b03161461017c576001600160e01b0319610185565b630b135d3f60e11b5b93505050505b9392505050565b5f5f5f604084860312156101a4575f5ffd5b83359250602084013567ffffffffffffffff8111156101c1575f5ffd5b8401601f810186136101d1575f5ffd5b803567ffffffffffffffff8111156101e7575f5ffd5b8660208284010111156101f8575f5ffd5b939660209190910195509293505050565b5f5f85851115610217575f5ffd5b83861115610223575f5ffd5b5050820193919092039150565b80356020831015610248575f19602084900360031b1b165b92915050565b634e487b7160e01b5f52603260045260245ffdfea264697066735822122068c5d92c1451914a865c3ed88861a378fa37267ad51773b01a0f0b6fc11cd58f64736f6c63430008230033";

/// Offline guard: the embedded mock bytecode must `hex::decode` (so a truncated /
/// corrupted paste is caught even without `anvil`). Mirrors the
/// `universal_validator_bytecode_is_valid_hex_and_well_formed` check in `eth.rs`.
#[test]
fn mock1271_bytecode_is_valid_hex() {
    let bytes =
        hex::decode(MOCK1271_CREATION_BYTECODE).expect("Mock1271 creation bytecode must be hex");
    assert!(
        bytes.len() > 200,
        "Mock1271 creation bytecode looks truncated ({} bytes)",
        bytes.len()
    );
}

// SIWE message constants, matching `auth.rs`'s own roundtrip test so the message
// we build is exactly what the frontend produces and `verify` enforces.
const TEST_HOST: &str = "login.cryptoverse.cc";
const TEST_SCHEME: &str = "https";
const TEST_CHAIN: u64 = 1;

/// Build the canonical EIP-4361 message for `address_line`, identical in shape to
/// `auth.rs`'s `build_message` (the address line is parameterised so we can point
/// it at the *contract* account while signing with the owner key).
fn build_siwe_message(address_line: &str, challenge: &str) -> String {
    let now = OffsetDateTime::now_utc();
    let issued_at = now.format(&Rfc3339).unwrap();
    let expiration = (now + Duration::minutes(10)).format(&Rfc3339).unwrap();
    format!(
        "{TEST_HOST} wants you to sign in with your Ethereum account:\n\
         {address_line}\n\n\
         Sign in to Cryptoverse Login\n\n\
         URI: {TEST_SCHEME}://{TEST_HOST}/\n\
         Version: 1\n\
         Chain ID: {TEST_CHAIN}\n\
         Nonce: {nonce}\n\
         Issued At: {issued_at}\n\
         Expiration Time: {expiration}",
        nonce = nonce_for_challenge(challenge),
    )
}

/// The whole ERC-1271 deployed-smart-account path, end to end, against a local
/// anvil node. Spawns anvil **once**, deploys `Mock1271(owner)` **once**, then
/// runs three sequential asserts (no env race — see the module docs).
#[tokio::test]
async fn erc1271_deployed_smart_account_signature() -> anyhow::Result<()> {
    // --- Gate: spawn anvil, or skip cleanly (unless CI demands it). ----------
    let anvil = match Anvil::new().chain_id(TEST_CHAIN).try_spawn() {
        Ok(a) => a,
        Err(e) => {
            if std::env::var_os("CV_REQUIRE_ANVIL").is_some() {
                panic!(
                    "CV_REQUIRE_ANVIL is set but anvil could not be spawned: {e}. \
                     CI must not silently lose ERC-1271 coverage — install foundry."
                );
            }
            eprintln!("skipping erc1271_anvil: anvil unavailable ({e})");
            return Ok(());
        }
    };

    // The first two anvil dev accounts: `owner` controls the smart account; the
    // second is an unrelated key used to forge an INVALID signature in Assert 2.
    let owner_signer = PrivateKeySigner::from(&anvil.keys()[0]);
    let other_signer = PrivateKeySigner::from(&anvil.keys()[1]);
    let owner: Address = owner_signer.address();
    let endpoint = anvil.endpoint();

    // --- Build the `Eth` under test from env, pointed at anvil. --------------
    // `from_env` honours `ETH_RPC_URL`; clear the Alchemy/Infura keys so they
    // can't pre-empt it. This mutates process-global env — which is exactly why
    // ALL anvil work is confined to this single test (see module docs).
    std::env::remove_var("ALCHEMY_API_KEY");
    std::env::remove_var("INFURA_API_KEY");
    std::env::set_var("ETH_RPC_URL", &endpoint);
    std::env::set_var("RPC_TIMEOUT_MS", "10000");
    let eth = Eth::from_env()?;

    // --- Deploy Mock1271(owner) via a funded deployer. -----------------------
    // `ProviderBuilder::new()` installs the recommended fillers (nonce, gas,
    // chain-id), so a contract-creation tx (no `to`, input = creation bytecode
    // ++ abi-encoded constructor args) is sent and mined without manual gas math.
    let deployer = ProviderBuilder::new()
        .wallet(EthereumWallet::from(owner_signer.clone()))
        .connect_http(endpoint.parse()?);

    let mut init_code = hex::decode(MOCK1271_CREATION_BYTECODE)?;
    init_code.extend_from_slice(&(owner,).abi_encode_params());
    // `with_deploy_code` sets the input AND marks the tx `to = TxKind::Create`,
    // which the wallet filler requires to recognise a contract-creation tx.
    let deploy_tx = TransactionRequest::default().with_deploy_code(init_code);

    let receipt = deployer
        .send_transaction(deploy_tx)
        .await?
        .get_receipt()
        .await?;
    let account = receipt
        .contract_address
        .expect("deployment receipt must carry the new contract address");
    assert_ne!(
        account, owner,
        "the contract account must differ from its EOA owner"
    );

    // === Assert 1: a valid owner signature → SigCheck::Valid. ================
    // The mock raw-`ecrecover`s the 65-byte sig over `app_hash`; `sign_hash_sync`
    // produces exactly that raw signature, so it recovers to `owner`.
    let app_hash: B256 = keccak256(b"cryptoverse erc-1271 deployed smart-account login");
    let valid_sig = owner_signer.sign_hash_sync(&app_hash)?.as_bytes();
    assert_eq!(
        eth.verify_signature(account, app_hash, &valid_sig).await?,
        SigCheck::Valid,
        "a valid owner signature must validate against the deployed ERC-1271 mock"
    );

    // === Assert 2: a different key's signature → SigCheck::Invalid. ==========
    // `other_signer` is not the stored owner, so the mock's `ecrecover` yields a
    // different address and it returns the non-magic value → Invalid (a clean
    // negative, NOT an Unavailable — the RPC is reachable).
    let wrong_sig = other_signer.sign_hash_sync(&app_hash)?.as_bytes();
    assert_eq!(
        eth.verify_signature(account, app_hash, &wrong_sig).await?,
        SigCheck::Invalid,
        "a non-owner signature must be Invalid against the deployed ERC-1271 mock"
    );

    // === Assert 3: full auth::verify through the ERC-1271 branch. ============
    // The real Safe-login analog: a SIWE message whose address line is the
    // *contract* account, signed by the owner EOA. The EOA fast path recovers
    // `owner` (≠ `account`) and so does NOT match, forcing the on-chain contract
    // path — which the deployed mock validates. `verify` must return the contract
    // address (lowercased) as the authenticated subject.
    let challenge = "erc1271-anvil-challenge";
    let message = build_siwe_message(&account.to_checksum(None), challenge);

    // The contract path validates against `msg.eip191_hash()`; the owner signs
    // that exact digest raw (`sign_hash_sync`), so the mock's raw `ecrecover`
    // recovers `owner`. We compute the same EIP-191 hash the `siwe` crate does.
    let eip191_hash: B256 = eip191_hash_of(&message);
    let sig = owner_signer.sign_hash_sync(&eip191_hash)?.as_bytes();
    let sig_hex = format!("0x{}", hex::encode(sig));

    // Sanity: the EOA fast path genuinely does NOT match (owner ≠ account), so
    // this really exercises the contract fallback and not the ecrecover path.
    let recovered_eoa = owner_signer
        .sign_hash_sync(&eip191_hash)?
        .recover_address_from_prehash(&eip191_hash)?;
    assert_eq!(
        recovered_eoa, owner,
        "the raw signature must recover the owner EOA, not the contract"
    );
    assert_ne!(
        recovered_eoa, account,
        "owner must differ from the contract account so the EOA fast path is bypassed"
    );

    let verified = verify(
        &message,
        &sig_hex,
        TEST_HOST,
        TEST_SCHEME,
        TEST_CHAIN,
        challenge,
        &eth,
    )
    .await
    .expect("a deployed-ERC-1271 SIWE login must verify through the contract path");
    assert_eq!(
        verified.address,
        format!("0x{}", hex::encode(account.as_slice())),
        "the authenticated subject must be the (lowercased) contract account"
    );

    Ok(())
}

/// The EIP-191 `personal_sign` hash of `message`:
/// `keccak256("\x19Ethereum Signed Message:\n" + len + message)`. This is exactly
/// the digest the `siwe` crate's `eip191_hash()` computes and that the wallet
/// signs over, so signing it raw lets the ERC-1271 mock's `ecrecover` recover the
/// owner EOA.
fn eip191_hash_of(message: &str) -> B256 {
    let mut buf = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
    buf.extend_from_slice(message.as_bytes());
    keccak256(buf)
}
