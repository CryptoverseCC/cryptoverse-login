//! On-chain helpers: ENS reverse resolution, Unstoppable Domains reverse
//! resolution, and ERC-20 balances (for token-gating).
//!
//! **Enrichment** (ENS / UD names) is best-effort: a flaky RPC must never block
//! a login, so those lookups return `Option`/`None` on error and log at `warn`.
//!
//! The names they emit are **verified**, not bare reverse records: a reverse
//! record is owner-settable free text, so [`Eth::ens_reverse`] only returns a
//! name whose own forward `addr(node)` resolves back to the address (the
//! ENS-standard verified-primary-name check), and [`Eth::ud_reverse`] only
//! returns a name whose token the address provably owns (`ownerOf`). Anything
//! unverifiable — including offchain/CCIP names we can't follow — fails closed to
//! `None`, so we never assert a name the user does not control.
//!
//! **Security-relevant reads** — signature validation (ERC-1271/6492) and gated
//! ERC-20 balances — are *not* best-effort. They return `Result`, so the caller
//! can tell "RPC down / could not check" apart from "checked and invalid / zero"
//! and **fail closed** (deny) on the former rather than silently passing.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use alloy::primitives::{address, keccak256, Address, Bytes, FixedBytes, B256, U256};
use alloy::providers::{DynProvider, Provider, RootProvider};
use alloy::rpc::client::ClientBuilder;
use alloy::rpc::types::TransactionRequest;
use alloy::sol;
use alloy::sol_types::SolValue;
use tokio::sync::RwLock;

// ENS registry (mainnet) and the Unstoppable Domains UNS ProxyReader (mainnet).
const ENS_REGISTRY: Address = address!("00000000000C2E074eC69A0dFb2997BA6C7d2e1e");
const UD_PROXY_READER: Address = address!("049aba7510f45BA5b64ea9E658E342F904DB358D");

// Basenames (`*.base.eth`) on Base L2 (chainId 8453), resolved NATIVELY on Base
// — not via CCIP/mainnet. The reverse read uses the ENSIP-19 L2ReverseRegistrar
// singleton (it stores the primary name directly, no reverse-node math needed);
// forward verification mirrors the ENS path against Base's own ENS registry.
const BASE_L2_REVERSE_REGISTRAR: Address = address!("0000000000D8e504002cC26E3Ec46D81971C1664");
const BASE_REGISTRY: Address = address!("B94704422c2a1e396835A571837Aa5AE53285a95");

// Gitcoin / Human Passport on-chain decoder on **Base** (chainId 8453). Passport
// "stamps" are EAS attestations; the decoder is the on-chain `address -> score`
// reader (the one EAS-backed credential that's queryable by recipient without an
// off-chain indexer). `getScore` is 4-decimal fixed-point (raw 200000 = 20.0); it
// REVERTS for an address with no / expired passport — which (like any read error
// here) fails the gate closed. Used for sybil-resistant login gating.
const GITCOIN_PASSPORT_DECODER_BASE: Address = address!("aa24a127d10C68C8F9Ac06199AA606953cD82eE7");

/// Default per-request timeout (ms) for JSON-RPC calls and the UD metadata HTTP
/// fetch when `RPC_TIMEOUT_MS` is unset. A hung RPC must never block a login
/// indefinitely; on timeout a security-relevant call surfaces as
/// [`EthError::Unavailable`] (fail closed) and an enrichment call as `None`.
const DEFAULT_RPC_TIMEOUT_MS: u64 = 3000;

/// An error from an on-chain read. Distinguishes a clean negative result
/// (handled by the caller's own logic) from "couldn't reach / parse the RPC",
/// which security-relevant callers must treat as INDETERMINATE → DENY.
#[derive(Debug, thiserror::Error)]
pub enum EthError {
    /// The RPC was unreachable, timed out, or returned a transport/parse error.
    /// The on-chain truth is unknown — callers must fail closed.
    #[error("on-chain read unavailable ({label}): {cause}")]
    Unavailable { label: String, cause: String },
}

impl EthError {
    fn unavailable(label: &str, cause: impl std::fmt::Display) -> Self {
        EthError::Unavailable {
            label: label.to_string(),
            cause: cause.to_string(),
        }
    }
}

/// Three-state outcome of [`Eth::verify_signature`]. Unlike a bare `bool`, this
/// keeps "the RPC was unreachable" (→ retryable, observable) distinct from "the
/// signature is genuinely not valid" (→ a real auth failure).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigCheck {
    /// The universal validator returned `0x01`.
    Valid,
    /// The validator returned `0x00` or the call reverted: definitively invalid.
    Invalid,
}

/// ERC-6492 detection suffix: a wrapped (counterfactual) signature ends with
/// these 32 bytes (`0x6492…6492`). See <https://eips.ethereum.org/EIPS/eip-6492>.
pub const ERC6492_MAGIC_SUFFIX: [u8; 32] =
    hex_literal_suffix(b"6492649264926492649264926492649264926492649264926492649264926492");

/// `bytes4(keccak256("isValidSignature(bytes32,bytes)"))` — the ERC-1271 magic
/// value returned by a contract wallet for a *valid* signature.
pub const ERC1271_MAGIC_VALUE: [u8; 4] = [0x16, 0x26, 0xba, 0x7e];

/// Creation bytecode of the ERC-6492 `ValidateSigOffchain` helper (which embeds
/// `UniversalSigValidator`). This is the canonical, deployless universal
/// signature validator: an `eth_call` with **no `to`** runs this contract's
/// constructor, which validates the signature and `return`s a single byte —
/// `0x01` for valid, `0x00` for invalid. The constructor handles all three
/// cases internally — plain EOA `ecrecover`, deployed ERC-1271, and
/// counterfactual ERC-6492 (it runs the CREATE2 factory deploy, then 1271).
///
/// This is byte-for-byte the constant viem ships as
/// `erc6492SignatureValidatorByteCode` (`src/constants/contracts.ts`), so our
/// behaviour matches viem's `verifyHash`. Source: EIP-6492 reference contracts.
const UNIVERSAL_VALIDATOR_BYTECODE: &str = "608060405234801561001057600080fd5b5060405161069438038061069483398101604081905261002f9161051e565b600061003c848484610048565b9050806000526001601ff35b60007f64926492649264926492649264926492649264926492649264926492649264926100748361040c565b036101e7576000606080848060200190518101906100929190610577565b60405192955090935091506000906001600160a01b038516906100b69085906105dd565b6000604051808303816000865af19150503d80600081146100f3576040519150601f19603f3d011682016040523d82523d6000602084013e6100f8565b606091505b50509050876001600160a01b03163b60000361016057806101605760405162461bcd60e51b815260206004820152601e60248201527f5369676e617475726556616c696461746f723a206465706c6f796d656e74000060448201526064015b60405180910390fd5b604051630b135d3f60e11b808252906001600160a01b038a1690631626ba7e90610190908b9087906004016105f9565b602060405180830381865afa1580156101ad573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906101d19190610633565b6001600160e01b03191614945050505050610405565b6001600160a01b0384163b1561027a57604051630b135d3f60e11b808252906001600160a01b03861690631626ba7e9061022790879087906004016105f9565b602060405180830381865afa158015610244573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906102689190610633565b6001600160e01b031916149050610405565b81516041146102df5760405162461bcd60e51b815260206004820152603a602482015260008051602061067483398151915260448201527f3a20696e76616c6964207369676e6174757265206c656e6774680000000000006064820152608401610157565b6102e7610425565b5060208201516040808401518451859392600091859190811061030c5761030c61065d565b016020015160f81c9050601b811480159061032b57508060ff16601c14155b1561038c5760405162461bcd60e51b815260206004820152603b602482015260008051602061067483398151915260448201527f3a20696e76616c6964207369676e617475726520762076616c756500000000006064820152608401610157565b60408051600081526020810180835289905260ff83169181019190915260608101849052608081018390526001600160a01b0389169060019060a0016020604051602081039080840390855afa1580156103ea573d6000803e3d6000fd5b505050602060405103516001600160a01b0316149450505050505b9392505050565b600060208251101561041d57600080fd5b508051015190565b60405180606001604052806003906020820280368337509192915050565b6001600160a01b038116811461045857600080fd5b50565b634e487b7160e01b600052604160045260246000fd5b60005b8381101561048c578181015183820152602001610474565b50506000910152565b600082601f8301126104a657600080fd5b81516001600160401b038111156104bf576104bf61045b565b604051601f8201601f19908116603f011681016001600160401b03811182821017156104ed576104ed61045b565b60405281815283820160200185101561050557600080fd5b610516826020830160208701610471565b949350505050565b60008060006060848603121561053357600080fd5b835161053e81610443565b6020850151604086015191945092506001600160401b0381111561056157600080fd5b61056d86828701610495565b9150509250925092565b60008060006060848603121561058c57600080fd5b835161059781610443565b60208501519093506001600160401b038111156105b357600080fd5b6105bf86828701610495565b604086015190935090506001600160401b0381111561056157600080fd5b600082516105ef818460208701610471565b9190910192915050565b828152604060208201526000825180604084015261061e816060850160208701610471565b601f01601f1916919091016060019392505050565b60006020828403121561064557600080fd5b81516001600160e01b03198116811461040557600080fd5b634e487b7160e01b600052603260045260246000fdfe5369676e617475726556616c696461746f72237265636f7665725369676e6572";

/// Compile-time conversion of an ASCII-hex byte string into the 32-byte suffix.
const fn hex_literal_suffix(s: &[u8; 64]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (hex_nibble(s[i * 2]) << 4) | hex_nibble(s[i * 2 + 1]);
        i += 1;
    }
    out
}

const fn hex_nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => 0,
    }
}

sol! {
    #[sol(rpc)]
    interface IERC20 {
        function decimals() external view returns (uint8);
        function balanceOf(address owner) external view returns (uint256);
    }

    // ERC-1155 `balanceOf` takes a token id, so it needs its own interface (a
    // different selector from ERC-20/721's `balanceOf(address)`). ERC-721 reuses
    // IERC20::balanceOf — the `balanceOf(address)` signature is identical; only
    // the decimals scaling differs (NFTs are whole units), handled in the caller.
    #[sol(rpc)]
    interface IERC1155 {
        function balanceOf(address account, uint256 id) external view returns (uint256);
    }

    #[sol(rpc)]
    interface ENSRegistry {
        function resolver(bytes32 node) external view returns (address);
    }

    #[sol(rpc)]
    interface ENSNameResolver {
        function name(bytes32 node) external view returns (string);
    }

    // The EIP-137 forward resolver: `addr(node)` maps an ENS name's namehash to
    // the address it points at. Used to *verify* a reverse record — the name is
    // only trusted if its own forward `addr` resolves back to the same owner.
    #[sol(rpc)]
    interface ENSAddrResolver {
        function addr(bytes32 node) external view returns (address);
    }

    #[sol(rpc)]
    interface IUDProxyReader {
        function reverseOf(address addr) external view returns (uint256);
        function ownerOf(uint256 tokenId) external view returns (address);
    }

    // ENSIP-19 L2ReverseRegistrar (Base): unlike mainnet's two-step
    // resolver→`name(node)`, this singleton stores the primary name for an
    // address directly, so a single `nameForAddr(addr)` yields the candidate
    // name. The forward-verify (Registry.resolver → L2Resolver.addr) reuses the
    // `ENSRegistry` / `ENSAddrResolver` interfaces above — same shape on Base.
    #[sol(rpc)]
    interface IGitcoinPassportDecoder {
        function getScore(address user) external view returns (uint256);
    }

    #[sol(rpc)]
    interface IL2ReverseRegistrar {
        function nameForAddr(address addr) external view returns (string);
    }
}

/// The ABI tuple of an ERC-6492 wrapper payload (everything before the magic
/// suffix): `(address create2Factory, bytes factoryCalldata, bytes signature)`.
type Erc6492Wrapper = (Address, Bytes, Bytes);

/// True if `signature` is an ERC-6492 wrapped (counterfactual) signature, i.e.
/// its last 32 bytes equal the magic suffix.
pub fn is_erc6492_wrapped(signature: &[u8]) -> bool {
    signature.len() >= 32 && signature[signature.len() - 32..] == ERC6492_MAGIC_SUFFIX
}

/// Decode an ERC-6492 wrapper into `(factory, factoryCalldata, innerSignature)`.
/// Returns `None` if `signature` is not 6492-wrapped or the payload is malformed.
pub fn decode_erc6492_wrapper(signature: &[u8]) -> Option<(Address, Bytes, Bytes)> {
    if !is_erc6492_wrapped(signature) {
        return None;
    }
    let payload = &signature[..signature.len() - 32];
    <Erc6492Wrapper as SolValue>::abi_decode_params(payload).ok()
}

#[derive(Clone)]
pub struct Eth {
    provider: DynProvider,
    /// Optional secondary endpoint (`ETH_RPC_URL_FALLBACK`) tried when the
    /// primary times out — a cheap resilience hedge against a single flaky RPC.
    fallback: Option<DynProvider>,
    /// Optional **Base L2** (chainId 8453) provider, built from `BASE_RPC_URL`.
    /// `None` when that env var is unset/empty — then Basenames is simply
    /// disabled and every [`Eth::basename_reverse`] returns `None`. It is a
    /// distinct chain from the mainnet `provider`, so it gets its own handle.
    base: Option<DynProvider>,
    http: reqwest::Client,
    /// Per-request timeout for JSON-RPC calls, from `RPC_TIMEOUT_MS`.
    timeout: Duration,
    /// Per-token cache of the immutable ERC-20 `decimals()`. The value never
    /// changes for a deployed token, so it is cached for the process lifetime
    /// (no TTL needed) — this removes one RPC round-trip from every
    /// `balance_of` (i.e. every token-gating check).
    decimals: Arc<RwLock<HashMap<Address, u8>>>,
}

impl Eth {
    /// Build from env: prefers Alchemy, then Infura, then `ETH_RPC_URL`, then a
    /// public endpoint. The per-call timeout comes from `RPC_TIMEOUT_MS`
    /// (default [`DEFAULT_RPC_TIMEOUT_MS`]); an optional `ETH_RPC_URL_FALLBACK`
    /// is dialled when the primary times out.
    pub fn from_env() -> anyhow::Result<Self> {
        let url = mainnet_rpc_url();
        let provider = RootProvider::new(ClientBuilder::default().http(url.parse()?)).erased();

        let fallback = match crate::config::var_opt("ETH_RPC_URL_FALLBACK") {
            Some(u) => Some(RootProvider::new(ClientBuilder::default().http(u.parse()?)).erased()),
            None => None,
        };

        // Base L2 provider for Basenames. Built identically to the mainnet one
        // but from `BASE_RPC_URL`; absent/empty ⇒ `None` ⇒ Basenames disabled
        // (never breaks `from_env`, never falls back to mainnet for Base reads).
        let base = match crate::config::var_opt("BASE_RPC_URL") {
            Some(u) => Some(RootProvider::new(ClientBuilder::default().http(u.parse()?)).erased()),
            None => None,
        };

        let timeout_ms = crate::config::var_opt("RPC_TIMEOUT_MS")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(DEFAULT_RPC_TIMEOUT_MS);
        let timeout = Duration::from_millis(timeout_ms);

        // The UD metadata HTTP client gets an explicit timeout. The alloy
        // provider's own reqwest version is internal (and differs from the
        // workspace's), so JSON-RPC `.call()`s are bounded with
        // `tokio::time::timeout` at each call site instead — see `rpc_timeout`.
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .expect("failed to build HTTP client");
        Ok(Self {
            provider,
            fallback,
            base,
            http,
            timeout,
            decimals: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// Read the ERC-20 `decimals()` for `token`, caching the (immutable) result
    /// per token address. Most tokens implement `decimals`. A failure is
    /// **not** defaulted to 18 — that silently mis-scales a gated balance (a
    /// 6-decimal USDC balance read as 18 decimals collapses to ~0). Instead the
    /// error propagates so the caller fails closed; the cache is only written on
    /// success, so a transient error never pins a wrong value.
    async fn decimals_of(&self, token: Address) -> Result<u8, EthError> {
        if let Some(&d) = self.decimals.read().await.get(&token) {
            return Ok(d);
        }
        let d = self
            .rpc_call("decimals()", |p| async move {
                IERC20::new(token, p).decimals().call().await
            })
            .await?;
        self.decimals.write().await.insert(token, d);
        Ok(d)
    }

    /// ERC-20 balance of `owner` for `token`, scaled by the token's `decimals`
    /// and returned as `f64` (so it can be fed to the token-gating expression
    /// evaluator, which can't handle `U256`).
    ///
    /// Returns `Err(EthError::Unavailable)` on any RPC / parse / decimals
    /// failure. The token-gating caller must treat that as INDETERMINATE and
    /// **deny** (fail closed) — never coerce it to `0.0`, or an RPC outage would
    /// silently let `balanceOf == 0` "pass" a `> 0` gate.
    pub async fn balance_of(&self, token: Address, owner: Address) -> Result<f64, EthError> {
        // `decimals()` is immutable for a deployed token, so it is cached per
        // token address — saving one RPC round-trip on every repeat check.
        let decimals = self.decimals_of(token).await?;

        let raw: U256 = self
            .rpc_call("balanceOf()", |p| async move {
                IERC20::new(token, p).balanceOf(owner).call().await
            })
            .await?;

        match alloy::primitives::utils::format_units(raw, decimals) {
            Ok(s) => s
                .parse::<f64>()
                .map_err(|e| EthError::unavailable("balanceOf() parse", e)),
            Err(e) => Err(EthError::unavailable("balanceOf() format_units", e)),
        }
    }

    /// ERC-721 / NFT count of `owner` for `token`: the RAW `balanceOf(address)`
    /// with **no decimals scaling** (NFTs are whole units), as `f64` for the
    /// token-gating evaluator — so `balanceOf > 0` means "owns at least one".
    /// Gates by NFT collection / DAO membership. Fails closed exactly like
    /// [`balance_of`](Self::balance_of): any RPC/parse failure → `Unavailable`,
    /// never a coerced `0.0`.
    pub async fn nft_balance_of(&self, token: Address, owner: Address) -> Result<f64, EthError> {
        let raw: U256 = self
            .rpc_call("nft balanceOf()", |p| async move {
                IERC20::new(token, p).balanceOf(owner).call().await
            })
            .await?;
        raw_count_to_f64(raw, "nft balanceOf()")
    }

    /// ERC-1155 balance of `owner` for `(token, id)` — `balanceOf(address,uint256)`,
    /// raw count (no decimals), fail-closed. Gates by a specific ERC-1155 token id
    /// (e.g. a membership/edition token).
    pub async fn erc1155_balance_of(
        &self,
        token: Address,
        owner: Address,
        id: U256,
    ) -> Result<f64, EthError> {
        let raw: U256 = self
            .rpc_call("erc1155 balanceOf()", |p| async move {
                IERC1155::new(token, p).balanceOf(owner, id).call().await
            })
            .await?;
        raw_count_to_f64(raw, "erc1155 balanceOf()")
    }

    /// Validate a signature for `signer` over the 32-byte `hash`, covering
    /// **contract wallets** (ERC-1271) and **counterfactual / pre-deploy**
    /// wallets (ERC-6492) in addition to plain EOAs.
    ///
    /// This performs the canonical ERC-6492 *deployless* universal validation:
    /// an `eth_call` with **no `to`** whose calldata is the
    /// [`UNIVERSAL_VALIDATOR_BYTECODE`] (the `ValidateSigOffchain` creation code)
    /// concatenated with the ABI-encoded constructor args
    /// `(address signer, bytes32 hash, bytes signature)`. The contract's
    /// constructor validates the signature and returns a single byte — `0x01`
    /// (valid) or `0x00` (invalid). Internally it branches on
    /// `signer.code.length`:
    ///
    /// - already-deployed contract → ERC-1271 `isValidSignature`;
    /// - 6492-wrapped + not yet deployed → runs the CREATE2 factory deploy in
    ///   the (discarded) call state, then ERC-1271;
    /// - otherwise → `ecrecover`.
    ///
    /// This is exactly viem's `verifyHash` strategy, so the full ERC-6492
    /// counterfactual case **is** handled, not just the already-deployed one.
    ///
    /// `signature` should be the raw signature bytes (a 65-byte ECDSA sig, an
    /// ERC-1271 contract sig, or an ERC-6492-wrapped sig — all accepted).
    ///
    /// Returns:
    /// - `Ok(SigCheck::Valid)`   — validator returned `0x01`;
    /// - `Ok(SigCheck::Invalid)` — validator returned `0x00` **or the call
    ///   reverted** (a revert is a definitive "not valid": deploy failed, 1271
    ///   threw, bad length, …);
    /// - `Err(EthError::Unavailable)` — the RPC was unreachable / timed out /
    ///   un-parseable, so validity is **unknown**.
    ///
    /// Distinguishing the last case is the point: a flaky RPC must surface as a
    /// retryable "couldn't check" rather than masquerade as a forged signature,
    /// so a Safe / smart-account user gets an observable error, not a silent 401.
    pub async fn verify_signature(
        &self,
        signer: Address,
        hash: B256,
        signature: &[u8],
    ) -> Result<SigCheck, EthError> {
        // calldata = creation bytecode ++ abi.encode(address, bytes32, bytes)
        let mut data = hex::decode(UNIVERSAL_VALIDATOR_BYTECODE).map_err(|e| {
            // A malformed embedded constant is a build-time bug, not an outage,
            // but there's no signature to validate, so report Unavailable.
            tracing::error!("universal validator bytecode is not valid hex: {e}");
            EthError::unavailable("ERC-1271/6492 bytecode", e)
        })?;
        let args = (signer, hash, Bytes::from(signature.to_vec())).abi_encode_params();
        data.extend_from_slice(&args);
        let data = Bytes::from(data);

        // Deployless call: no `to`, the bytecode runs as a constructor.
        let result = self
            .rpc_call("ERC-1271/6492 validation", |p| {
                let tx = TransactionRequest::default().input(data.clone().into());
                async move { p.call(tx).await }
            })
            .await;

        match result {
            // `ValidateSigOffchain` returns 1 byte: 0x01 = valid, else invalid.
            Ok(out) => Ok(if out.first() == Some(&1) {
                SigCheck::Valid
            } else {
                SigCheck::Invalid
            }),
            // The deployless validator signals an INVALID signature by reverting
            // (bad length / v value, failed ecrecover), which alloy surfaces as a
            // call error whose cause reads "execution reverted". That is a
            // definitive "no" → Invalid (terminal 401). Only a genuine
            // transport/timeout/rate-limit failure is Unavailable (retryable 503).
            Err(e) => {
                let EthError::Unavailable { cause, .. } = &e;
                if is_revert(cause) {
                    return Ok(SigCheck::Invalid);
                }
                tracing::warn!("ERC-1271/6492 validation unavailable for {signer}: {e}");
                Err(e)
            }
        }
    }

    /// ENS **verified primary name** for `owner` (`addr -> name`, *forward-checked*).
    ///
    /// A reverse record (`addr.reverse → name`) is **free text the address owner
    /// can set to any string**, including a name they don't control. Returning it
    /// as-is would assert a name the user may not own — a spoofing hole (a
    /// downstream relying party could authorize "act-as alice.eth" off it). So
    /// this performs the ENS-standard verification: after reading the reverse
    /// `name`, it forward-resolves that name's own `addr(namehash(name))` and only
    /// returns the name if **that address equals `owner`** (the 20 address bytes
    /// compared exactly, checksum-agnostic). The returned name is therefore one
    /// the user **provably controls**, not a bare reverse record.
    ///
    /// Fails **closed** (`None`) on any of: no reverse record, the forward
    /// resolver is zero, the forward `addr` is zero or ≠ `owner`, the name has no
    /// standard on-chain forward record (e.g. offchain / CCIP-read names — we do
    /// not follow CCIP, so they are treated as unverified), or any RPC error.
    pub async fn ens_reverse(&self, owner: Address) -> Option<String> {
        let reverse_name = format!("{}.addr.reverse", hex::encode(owner.as_slice()));
        let node = namehash(&reverse_name);

        let resolver = match self
            .rpc_call("ENS registry.resolver", |p| async move {
                ENSRegistry::new(ENS_REGISTRY, p)
                    .resolver(node)
                    .call()
                    .await
            })
            .await
        {
            Ok(addr) => addr,
            Err(e) => {
                tracing::warn!("ENS registry.resolver failed for {owner}: {e}");
                return None;
            }
        };
        if resolver.is_zero() {
            return None;
        }

        // NOTE: this second call is data-dependent on the first (the resolver
        // address came from `registry.resolver`), so the two CANNOT be collapsed
        // into a single Multicall3 batch — they are deliberately sequential.
        let name = match self
            .rpc_call("ENS resolver.name", |p| async move {
                ENSNameResolver::new(resolver, p).name(node).call().await
            })
            .await
        {
            Ok(name) if !name.is_empty() => name,
            Ok(_) => return None,
            Err(e) => {
                tracing::warn!("ENS resolver.name failed for {owner}: {e}");
                return None;
            }
        };

        // Forward-verify: the reverse record is unauthenticated free text, so the
        // claimed `name` is only trusted if *it* forward-resolves back to `owner`.
        if self.ens_forward_matches(&name, owner).await {
            Some(name)
        } else {
            None
        }
    }

    /// Does `name`'s standard on-chain forward record resolve to `owner`?
    ///
    /// Looks up `name`'s resolver via `ENSRegistry.resolver(namehash(name))`, then
    /// calls that resolver's EIP-137 `addr(node)` and compares the result to
    /// `owner` (full 20-byte equality). Returns `false` — never asserts the name —
    /// when the forward resolver is zero, `addr` is zero or different, the name has
    /// no standard forward record (offchain/CCIP names included), or any RPC error
    /// occurs. This is the verification that turns an arbitrary reverse string into
    /// a name the user provably controls.
    async fn ens_forward_matches(&self, name: &str, owner: Address) -> bool {
        let node = namehash(name);

        let resolver = match self
            .rpc_call("ENS forward registry.resolver", |p| async move {
                ENSRegistry::new(ENS_REGISTRY, p)
                    .resolver(node)
                    .call()
                    .await
            })
            .await
        {
            Ok(addr) => addr,
            Err(e) => {
                tracing::warn!("ENS forward registry.resolver failed for {name}: {e}");
                return false;
            }
        };
        if resolver.is_zero() {
            // No forward resolver set ⇒ no standard on-chain forward record ⇒
            // unverifiable. Fail closed.
            return false;
        }

        let resolved = match self
            .rpc_call("ENS forward resolver.addr", |p| async move {
                ENSAddrResolver::new(resolver, p).addr(node).call().await
            })
            .await
        {
            Ok(addr) => addr,
            Err(e) => {
                // A resolver without `addr(bytes32)` (or an offchain/CCIP resolver
                // that reverts to signal a lookup) reverts here — we don't follow
                // CCIP-read, so we cannot verify it. Treat as unverified.
                tracing::warn!("ENS forward resolver.addr failed for {name}: {e}");
                return false;
            }
        };

        // Checksum is irrelevant: `Address` is the raw 20 bytes, so `==` compares
        // them exactly. A zero forward address never matches a real `owner`.
        !resolved.is_zero() && resolved == owner
    }

    /// Unstoppable Domains **ownership-verified** reverse resolution.
    ///
    /// Reads the reverse token id from the UNS ProxyReader, then — because a UD
    /// reverse record is, like ENS's, an owner-settable pointer that must not be
    /// trusted blind — **verifies on-chain ownership**: the name is only kept if
    /// `ProxyReader.ownerOf(token_id) == owner`. Only after that does it fetch the
    /// human-readable name from the UD metadata API. The returned name is one the
    /// user **provably owns**, not an unverified reverse pointer.
    ///
    /// Fails **closed** (`None`) on: no reverse token, an `ownerOf` mismatch, or
    /// any RPC / metadata error.
    pub async fn ud_reverse(&self, owner: Address) -> Option<String> {
        let token_id: U256 = match self
            .rpc_call("UD reverseOf", |p| async move {
                IUDProxyReader::new(UD_PROXY_READER, p)
                    .reverseOf(owner)
                    .call()
                    .await
            })
            .await
        {
            Ok(id) => id,
            Err(e) => {
                tracing::warn!("UD reverseOf failed for {owner}: {e}");
                return None;
            }
        };
        if token_id.is_zero() {
            return None;
        }

        // Ownership check: the reverse pointer is owner-settable, so confirm the
        // address actually owns the token before trusting its name. A revert here
        // (e.g. a burned / nonexistent token) is surfaced by `ownerOf` as an RPC
        // error → None (fail closed), same as a mismatch.
        let token_owner = match self
            .rpc_call("UD ownerOf", |p| async move {
                IUDProxyReader::new(UD_PROXY_READER, p)
                    .ownerOf(token_id)
                    .call()
                    .await
            })
            .await
        {
            Ok(addr) => addr,
            Err(e) => {
                tracing::warn!("UD ownerOf failed for {owner}: {e}");
                return None;
            }
        };
        if token_owner.is_zero() || token_owner != owner {
            tracing::warn!(
                "UD reverse for {owner} points at token {token_id} owned by {token_owner}; \
                 ignoring unverified name"
            );
            return None;
        }

        let url = format!("https://resolve.unstoppabledomains.com/metadata/{token_id}");
        let data: serde_json::Value = match self.http.get(&url).send().await {
            Ok(resp) => match resp.json().await {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!("UD metadata parse failed: {e}");
                    return None;
                }
            },
            Err(e) => {
                tracing::warn!("UD metadata fetch failed: {e}");
                return None;
            }
        };

        data.get("name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    }

    /// Basenames (`*.base.eth`) **verified primary name** for `owner`, resolved
    /// natively on **Base L2 (chainId 8453)** — not via CCIP/mainnet.
    ///
    /// Like ENS, a reverse record is owner-settable free text, so the same
    /// non-negotiable discipline applies: the candidate name is **only** returned
    /// if its own forward `addr(namehash(name))` on Base resolves back to `owner`.
    /// The reverse read uses the ENSIP-19 [`BASE_L2_REVERSE_REGISTRAR`] singleton,
    /// which stores the name directly (`nameForAddr(addr)` — no manual reverse-node
    /// math); the forward-verify reads the resolver from the Base [`BASE_REGISTRY`]
    /// and calls its `addr(node)` (the L2Resolver is *read from the registry*, never
    /// hardcode-only).
    ///
    /// Fails **closed** (`None`) on any of: Basenames disabled (no `BASE_RPC_URL`),
    /// an empty reverse name, a zero/missing forward resolver, a forward `addr`
    /// that is zero or ≠ `owner`, or any RPC error. Best-effort, exactly like
    /// [`Eth::ens_reverse`].
    pub async fn basename_reverse(&self, owner: Address) -> Option<String> {
        let name = match self
            .base_rpc_call("Base L2ReverseRegistrar.nameForAddr", |p| async move {
                IL2ReverseRegistrar::new(BASE_L2_REVERSE_REGISTRAR, p)
                    .nameForAddr(owner)
                    .call()
                    .await
            })
            .await
        {
            Ok(name) if !name.is_empty() => name,
            Ok(_) => return None,
            Err(e) => {
                tracing::warn!("Base nameForAddr failed for {owner}: {e}");
                return None;
            }
        };

        // Forward-verify on Base: the reverse record is unauthenticated free text,
        // so the claimed `name` is only trusted if *it* forward-resolves back to
        // `owner` against Base's own ENS registry/resolver.
        if self.basename_forward_matches(&name, owner).await {
            Some(name)
        } else {
            None
        }
    }

    /// Does `name`'s standard forward record on **Base** resolve to `owner`?
    ///
    /// Mirrors [`Eth::ens_forward_matches`] exactly, but on the Base chain: looks
    /// up `name`'s resolver via `BASE_REGISTRY.resolver(namehash(name))`, then
    /// calls that resolver's `addr(node)` and compares to `owner` (full 20-byte
    /// equality). Returns `false` — never asserts the name — on a zero resolver,
    /// a zero/different `addr`, or any RPC error. This is the verification that
    /// turns an arbitrary reverse string into a name the user provably controls.
    async fn basename_forward_matches(&self, name: &str, owner: Address) -> bool {
        let node = namehash(name);

        let resolver = match self
            .base_rpc_call("Base forward registry.resolver", |p| async move {
                ENSRegistry::new(BASE_REGISTRY, p)
                    .resolver(node)
                    .call()
                    .await
            })
            .await
        {
            Ok(addr) => addr,
            Err(e) => {
                tracing::warn!("Base forward registry.resolver failed for {name}: {e}");
                return false;
            }
        };
        if resolver.is_zero() {
            // No forward resolver set ⇒ no standard forward record ⇒
            // unverifiable. Fail closed.
            return false;
        }

        let resolved = match self
            .base_rpc_call("Base forward resolver.addr", |p| async move {
                ENSAddrResolver::new(resolver, p).addr(node).call().await
            })
            .await
        {
            Ok(addr) => addr,
            Err(e) => {
                tracing::warn!("Base forward resolver.addr failed for {name}: {e}");
                return false;
            }
        };

        // Checksum is irrelevant: `Address` is the raw 20 bytes, so `==` compares
        // them exactly. A zero forward address never matches a real `owner`.
        !resolved.is_zero() && resolved == owner
    }

    /// The Gitcoin / Human Passport humanity score for `owner`, read from the
    /// on-chain decoder on **Base** and scaled from its 4-decimal fixed-point to a
    /// plain `f64` (raw `200000` → `20.0`) for the token-gating evaluator (the
    /// variable `passportScore`). Passport stamps are EAS attestations; this
    /// decoder is the one EAS-backed credential queryable by recipient on-chain.
    ///
    /// Fails **closed** (`Err(Unavailable)`) on ANY decoder error — including the
    /// revert the decoder raises for an address with no / expired passport — so a
    /// `passportScore >= N` gate denies whenever a score can't be positively read.
    /// With no `BASE_RPC_URL` the Base provider is absent ⇒ unavailable ⇒ deny.
    pub async fn passport_score(&self, owner: Address) -> Result<f64, EthError> {
        let raw: U256 = self
            .base_rpc_call("Base GitcoinPassportDecoder.getScore", |p| async move {
                IGitcoinPassportDecoder::new(GITCOIN_PASSPORT_DECODER_BASE, p)
                    .getScore(owner)
                    .call()
                    .await
            })
            .await?;
        // 4-decimal fixed point (raw 200000 = score 20.0).
        match alloy::primitives::utils::format_units(raw, 4u8) {
            Ok(s) => s
                .parse::<f64>()
                .map_err(|e| EthError::unavailable("passport getScore parse", e)),
            Err(e) => Err(EthError::unavailable("passport getScore format_units", e)),
        }
    }
}

impl Eth {
    /// The single JSON-RPC chokepoint. `make` builds the awaitable call against
    /// a given provider, so it can be re-issued for the retry/fallback paths.
    ///
    /// Resilience: on a **timeout** we retry once against the primary, then —
    /// if configured — once against [`Eth::fallback`]. A non-timeout transport
    /// error is returned immediately (a retry against the same down endpoint is
    /// unlikely to help and just adds latency). Every attempt's outcome is
    /// recorded on `rpc_calls_total{label,result}` (`ok`|`timeout`|`error`).
    ///
    /// Returns `Err(EthError::Unavailable)` only when we could not get an answer
    /// (timeout/transport/parse). A successful RPC that yields a "negative"
    /// value (zero balance, `0x00` validity byte) is `Ok` — the *caller* decides
    /// what that means.
    async fn rpc_call<F, Fut, T, E>(&self, label: &str, make: F) -> Result<T, EthError>
    where
        // alloy's `EthCall`/`CallBuilder` are `IntoFuture`, not `Future`
        // directly, so accept anything awaitable. The provider is passed *by
        // value* (a cheap `DynProvider` clone) so the contract instance built
        // inside the closure owns it and the returned future is self-contained
        // (no borrow of a closure-local temporary).
        F: Fn(DynProvider) -> Fut,
        Fut: std::future::IntoFuture<Output = Result<T, E>>,
        E: std::fmt::Display,
    {
        // First + retry against the primary, then one attempt on the fallback.
        let mut last: Option<String> = None;
        let attempts = 2usize; // primary: initial + one retry-on-timeout
        for attempt in 0..attempts {
            match tokio::time::timeout(self.timeout, make(self.provider.clone()).into_future())
                .await
            {
                Ok(Ok(v)) => {
                    crate::telemetry::record_rpc_call(label, "ok");
                    return Ok(v);
                }
                Ok(Err(e)) => {
                    // A clean transport/RPC error: don't retry the same endpoint.
                    crate::telemetry::record_rpc_call(label, "error");
                    return Err(EthError::unavailable(label, e));
                }
                Err(_) => {
                    crate::telemetry::record_rpc_call(label, "timeout");
                    last = Some(format!("{label} timed out after {:?}", self.timeout));
                    if attempt + 1 < attempts {
                        tracing::warn!("{label} timed out (attempt {}), retrying", attempt + 1);
                    }
                }
            }
        }

        // Primary exhausted by timeouts — try the optional fallback once.
        if let Some(fallback) = &self.fallback {
            tracing::warn!("{label} timed out on primary RPC, trying fallback");
            match tokio::time::timeout(self.timeout, make(fallback.clone()).into_future()).await {
                Ok(Ok(v)) => {
                    crate::telemetry::record_rpc_call(label, "ok");
                    return Ok(v);
                }
                Ok(Err(e)) => {
                    crate::telemetry::record_rpc_call(label, "error");
                    return Err(EthError::unavailable(label, e));
                }
                Err(_) => {
                    crate::telemetry::record_rpc_call(label, "timeout");
                    last = Some(format!("{label} timed out (primary + fallback)"));
                }
            }
        }

        Err(EthError::unavailable(
            label,
            last.unwrap_or_else(|| "timed out".to_string()),
        ))
    }

    /// The JSON-RPC chokepoint for **Base L2** reads. Same timeout + retry-on-
    /// timeout + metric treatment as [`Eth::rpc_call`], but against the optional
    /// [`Eth::base`] provider (there is no Base fallback — `BASE_RPC_URL` is a
    /// single endpoint). Returns `Err(EthError::Unavailable)` when Base is
    /// disabled (no `base` provider) or the call could not be answered, so the
    /// best-effort caller maps either to `None`.
    async fn base_rpc_call<F, Fut, T, E>(&self, label: &str, make: F) -> Result<T, EthError>
    where
        F: Fn(DynProvider) -> Fut,
        Fut: std::future::IntoFuture<Output = Result<T, E>>,
        E: std::fmt::Display,
    {
        let Some(base) = &self.base else {
            // Basenames disabled (no BASE_RPC_URL) — treat as unavailable so the
            // best-effort caller yields `None` without ever touching mainnet.
            return Err(EthError::unavailable(label, "BASE_RPC_URL not configured"));
        };

        let mut last: Option<String> = None;
        let attempts = 2usize; // initial + one retry-on-timeout
        for attempt in 0..attempts {
            match tokio::time::timeout(self.timeout, make(base.clone()).into_future()).await {
                Ok(Ok(v)) => {
                    crate::telemetry::record_rpc_call(label, "ok");
                    return Ok(v);
                }
                Ok(Err(e)) => {
                    crate::telemetry::record_rpc_call(label, "error");
                    return Err(EthError::unavailable(label, e));
                }
                Err(_) => {
                    crate::telemetry::record_rpc_call(label, "timeout");
                    last = Some(format!("{label} timed out after {:?}", self.timeout));
                    if attempt + 1 < attempts {
                        tracing::warn!("{label} timed out (attempt {}), retrying", attempt + 1);
                    }
                }
            }
        }

        Err(EthError::unavailable(
            label,
            last.unwrap_or_else(|| "timed out".to_string()),
        ))
    }
}

/// An `eth_call` *revert* (the deployless validator's definitive "no" for a
/// malformed/invalid signature) surfaces with a cause that reads "execution
/// reverted" — distinct from the RPC being unreachable. Tiny testable predicate.
fn is_revert(cause: &str) -> bool {
    cause.to_ascii_lowercase().contains("revert")
}

/// Convert a raw whole-unit `U256` count (an ERC-721/1155 balance, no decimals)
/// to the `f64` the gating evaluator uses. Goes through `format_units(_, 0)` so
/// an unexpected parse failure surfaces as `Unavailable` (fail closed) rather
/// than a coerced `0.0`.
fn raw_count_to_f64(raw: U256, label: &'static str) -> Result<f64, EthError> {
    match alloy::primitives::utils::format_units(raw, 0u8) {
        Ok(s) => s
            .parse::<f64>()
            .map_err(|e| EthError::unavailable(label, e)),
        Err(e) => Err(EthError::unavailable(label, e)),
    }
}

/// Pick the mainnet JSON-RPC URL from the environment.
fn mainnet_rpc_url() -> String {
    if let Some(key) = crate::config::var_opt("ALCHEMY_API_KEY") {
        return format!("https://eth-mainnet.g.alchemy.com/v2/{key}");
    }
    if let Some(key) = crate::config::var_opt("INFURA_API_KEY") {
        return format!("https://mainnet.infura.io/v3/{key}");
    }
    crate::config::var_or("ETH_RPC_URL", "https://eth.llamarpc.com")
}

/// EIP-137 namehash.
fn namehash(name: &str) -> FixedBytes<32> {
    let mut node = FixedBytes::<32>::ZERO;
    if !name.is_empty() {
        for label in name.split('.').rev() {
            let label_hash = keccak256(label.as_bytes());
            let mut buf = [0u8; 64];
            buf[..32].copy_from_slice(node.as_slice());
            buf[32..].copy_from_slice(label_hash.as_slice());
            node = keccak256(buf);
        }
    }
    node
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namehash_empty_is_zero() {
        assert_eq!(namehash(""), FixedBytes::<32>::ZERO);
    }

    /// A validator revert classifies as a definitive INVALID signature; a
    /// transport/timeout/rate-limit cause stays Unavailable (retryable).
    #[test]
    fn revert_is_invalid_transport_is_unavailable() {
        assert!(is_revert(
            "server returned an error response: error code 3: execution reverted"
        ));
        assert!(is_revert(
            "execution reverted: SignatureValidator#recoverSigner: invalid signature length"
        ));
        assert!(!is_revert(
            "error sending request for url (http://rpc): connection refused"
        ));
        assert!(!is_revert("ERC-1271/6492 validation timed out after 3s"));
        assert!(!is_revert(
            "server returned an error response: error code -32005"
        ));
    }

    /// The per-token `decimals` cache returns the seeded value with no RPC.
    /// Builds an `Eth` whose provider points at an unroutable URL so any
    /// accidental network call would error/hang — the test passing proves the
    /// cached read path is taken (no provider call is made).
    #[tokio::test]
    async fn decimals_cache_hit_avoids_rpc() {
        // Provider URL is never dialled on a cache hit.
        let provider =
            RootProvider::new(ClientBuilder::default().http("http://127.0.0.1:1".parse().unwrap()))
                .erased();
        let eth = Eth {
            provider,
            fallback: None,
            base: None,
            http: reqwest::Client::new(),
            timeout: Duration::from_millis(DEFAULT_RPC_TIMEOUT_MS),
            decimals: Arc::new(RwLock::new(HashMap::new())),
        };

        let token = address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"); // USDC
        eth.decimals.write().await.insert(token, 6);

        // Returns the cached 6 immediately; the unroutable provider is untouched.
        let d = eth
            .decimals_of(token)
            .await
            .expect("cached decimals must resolve without an RPC");
        assert_eq!(d, 6, "cached decimals must be returned without an RPC");

        // A second token is not in the cache.
        let other = address!("dAC17F958D2ee523a2206206994597C13D831ec7"); // USDT
        assert!(eth.decimals.read().await.get(&other).is_none());
    }

    #[test]
    fn namehash_eth_matches_known_vector() {
        // Well-known EIP-137 test vector for "eth".
        let expected = "93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae";
        assert_eq!(hex::encode(namehash("eth").as_slice()), expected);
    }

    /// The forward-verification step hashes the *claimed name itself* (e.g.
    /// `vitalik.eth`), which is a different node than the reverse record
    /// (`<addr>.addr.reverse`). Pin the well-known `vitalik.eth` namehash so a
    /// regression in the forward node derivation is caught offline.
    #[test]
    fn forward_namehash_of_name_matches_known_vector() {
        // Canonical EIP-137 namehash of "vitalik.eth".
        let expected = "ee6c4522aab0003e8d14cd40a6af439055fd2577951148c14b6cea9a53475835";
        assert_eq!(hex::encode(namehash("vitalik.eth").as_slice()), expected);

        // The reverse node for the same owner is a *different* node — confirming
        // forward verification hashes the name, not the reverse record.
        let owner = address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"); // vitalik.eth
        let reverse = format!("{}.addr.reverse", hex::encode(owner.as_slice()));
        assert_ne!(namehash("vitalik.eth"), namehash(&reverse));
    }

    /// An ENS reverse lookup against an unreachable RPC must **fail closed** to
    /// `None` — never surface an unverified name — because the forward-verify
    /// RPCs can't run. (The reverse read itself also fails, but this pins the
    /// best-effort `None` contract end-to-end.)
    #[tokio::test]
    async fn ens_reverse_unreachable_rpc_is_none() {
        let eth = offline_eth();
        let owner = address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
        assert!(
            eth.ens_reverse(owner).await.is_none(),
            "an unreachable RPC must yield no (unverified) ENS name"
        );
    }

    /// A UD reverse lookup against an unreachable RPC must **fail closed** to
    /// `None` — the `ownerOf` ownership check can't run, so no name is asserted.
    #[tokio::test]
    async fn ud_reverse_unreachable_rpc_is_none() {
        let eth = offline_eth();
        let owner = address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
        assert!(
            eth.ud_reverse(owner).await.is_none(),
            "an unreachable RPC must yield no (unverified) UD name"
        );
    }

    /// With Basenames **disabled** (no `BASE_RPC_URL` ⇒ no Base provider),
    /// `basename_reverse` must fail closed to `None` without any network call —
    /// and it must NOT fall back to the mainnet provider for a Base read.
    #[tokio::test]
    async fn basename_reverse_disabled_is_none() {
        let eth = no_base_eth();
        let owner = address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
        assert!(
            eth.basename_reverse(owner).await.is_none(),
            "Basenames disabled must yield None (no Base provider, no mainnet fallback)"
        );
    }

    /// A Basename reverse lookup against an unreachable Base RPC must **fail
    /// closed** to `None` — the forward-verify reads can't run, so no name is
    /// asserted (same best-effort contract as `ens_reverse`).
    #[tokio::test]
    async fn basename_reverse_unreachable_rpc_is_none() {
        let eth = offline_eth(); // Base provider points at a closed port
        let owner = address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
        assert!(
            eth.basename_reverse(owner).await.is_none(),
            "an unreachable Base RPC must yield no (unverified) Basename"
        );
    }

    /// The verification predicate is plain 20-byte address equality (checksum is
    /// irrelevant since `Address` is the raw bytes), and a zero forward address
    /// never matches a real owner. This pins the comparison `ens_forward_matches`
    /// makes without needing a live RPC.
    #[test]
    fn forward_address_match_predicate() {
        let owner = address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
        // Same address parsed from differing checksum casings must be equal.
        let same_lower: Address = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045"
            .parse()
            .unwrap();
        assert_eq!(
            owner, same_lower,
            "checksum casing must not affect equality"
        );

        let other = address!("0000000000000000000000000000000000000001");
        assert_ne!(owner, other, "a different forward address must not match");

        // The exact guard `ens_forward_matches` applies: `!addr.is_zero() && addr
        // == owner`. A zero forward address must fail it; a matching owner passes.
        let guard = |addr: Address| !addr.is_zero() && addr == owner;
        assert!(!guard(Address::ZERO), "zero forward addr never matches");
        assert!(guard(same_lower), "a matching forward addr passes");
    }

    #[test]
    fn erc6492_magic_suffix_const_is_correct() {
        // The suffix is `0x6492` repeated 16 times.
        assert_eq!(
            hex::encode(ERC6492_MAGIC_SUFFIX),
            "6492649264926492649264926492649264926492649264926492649264926492"
        );
    }

    #[test]
    fn detects_erc6492_wrapped_signature() {
        // A short payload followed by the magic suffix is "wrapped".
        let mut sig = vec![0xaa; 10];
        sig.extend_from_slice(&ERC6492_MAGIC_SUFFIX);
        assert!(is_erc6492_wrapped(&sig));

        // A plain 65-byte ECDSA signature is not wrapped.
        let eoa = vec![0u8; 65];
        assert!(!is_erc6492_wrapped(&eoa));

        // Too short to even contain the suffix.
        assert!(!is_erc6492_wrapped(&[0u8; 4]));

        // Right length but wrong trailing bytes.
        let mut wrong = vec![0u8; 64];
        wrong[63] = 0x91;
        assert!(!is_erc6492_wrapped(&wrong));
    }

    #[test]
    fn decodes_erc6492_wrapper_roundtrip() {
        // Build a wrapper exactly as a wallet would: abi.encode((factory,
        // calldata, innerSig)) ++ magic suffix.
        let factory = address!("00000000000000000000000000000000DeaDBeef");
        let calldata = Bytes::from(vec![0x12, 0x34, 0x56]);
        let inner = Bytes::from(vec![0xab; 65]);

        let mut wrapped = (factory, calldata.clone(), inner.clone()).abi_encode_params();
        wrapped.extend_from_slice(&ERC6492_MAGIC_SUFFIX);

        let (f, c, s) = decode_erc6492_wrapper(&wrapped).expect("must decode wrapper");
        assert_eq!(f, factory);
        assert_eq!(c, calldata);
        assert_eq!(s, inner);

        // A non-wrapped signature decodes to None.
        assert!(decode_erc6492_wrapper(&[0u8; 65]).is_none());
    }

    #[test]
    fn universal_validator_bytecode_is_valid_hex_and_well_formed() {
        // The embedded bytecode must decode and carry the recognisable markers
        // (PUSH32 of the magic suffix, the trailing "SignatureValidator#..."
        // ASCII) so an accidental truncation/edit is caught at test time.
        let bytes = hex::decode(UNIVERSAL_VALIDATOR_BYTECODE)
            .expect("universal validator bytecode must be valid hex");
        // Contains the 32-byte 6492 magic as a constant (PUSH32 operand).
        assert!(
            bytes.windows(32).any(|w| w == ERC6492_MAGIC_SUFFIX),
            "bytecode must embed the 6492 magic constant"
        );
        // Ends with the "SignatureValidator#recoverSigner" revert string.
        assert!(
            UNIVERSAL_VALIDATOR_BYTECODE
                .ends_with("5369676e617475726556616c696461746f72237265636f7665725369676e6572"),
            "bytecode tail (recoverSigner ASCII) is missing — likely truncated"
        );
    }

    /// The Coinbase Smart Wallet **replay-safe EIP-712 digest** of `hash`: the
    /// value the CBSW's `_isValidSignature` actually `ecrecover`s against. This
    /// mirrors `ERC1271._eip712Hash` in coinbase/smart-wallet:
    ///
    /// `keccak256(0x1901 ‖ domainSeparator ‖ keccak256(MESSAGE_TYPEHASH ‖ hash))`
    ///
    /// with domain `EIP712Domain(name="Coinbase Smart Wallet", version="1",
    /// chainId, verifyingContract=account)` and
    /// `MESSAGE_TYPEHASH = keccak256("CoinbaseSmartWalletMessage(bytes32 hash)")`.
    /// Used only by the live ERC-6492 test to build a genuine owner signature.
    fn cbsw_replay_safe_hash(account: Address, chain_id: u64, hash: B256) -> B256 {
        let eip712_domain_typehash = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
        );
        let domain_separator = keccak256(
            (
                eip712_domain_typehash,
                keccak256("Coinbase Smart Wallet"),
                keccak256("1"),
                U256::from(chain_id),
                account,
            )
                .abi_encode(),
        );
        let message_typehash = keccak256("CoinbaseSmartWalletMessage(bytes32 hash)");
        let hash_struct = keccak256((message_typehash, hash).abi_encode());

        let mut buf = Vec::with_capacity(2 + 32 + 32);
        buf.extend_from_slice(&[0x19, 0x01]);
        buf.extend_from_slice(domain_separator.as_slice());
        buf.extend_from_slice(hash_struct.as_slice());
        keccak256(buf)
    }

    /// An `Eth` whose primary RPC points at a closed local port, so a call that
    /// actually hits the network fails fast with connection-refused (no real
    /// network, no long wait) — used to assert the fail-closed paths.
    fn offline_eth() -> Eth {
        let provider =
            RootProvider::new(ClientBuilder::default().http("http://127.0.0.1:1".parse().unwrap()))
                .erased();
        // A Base provider that also points at the closed port, so the Basenames
        // path is *enabled but unreachable* — exercising its fail-closed branch.
        let base =
            RootProvider::new(ClientBuilder::default().http("http://127.0.0.1:1".parse().unwrap()))
                .erased();
        Eth {
            provider,
            fallback: None,
            base: Some(base),
            http: reqwest::Client::new(),
            timeout: Duration::from_millis(200),
            decimals: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// An `Eth` with **Basenames disabled** (no Base provider), mirroring an
    /// environment where `BASE_RPC_URL` is unset/empty. `basename_reverse` must
    /// short-circuit to `None` without any network call.
    fn no_base_eth() -> Eth {
        let provider =
            RootProvider::new(ClientBuilder::default().http("http://127.0.0.1:1".parse().unwrap()))
                .erased();
        Eth {
            provider,
            fallback: None,
            base: None,
            http: reqwest::Client::new(),
            timeout: Duration::from_millis(200),
            decimals: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// An RPC failure on `balance_of` must surface as `Err(Unavailable)` — NOT
    /// `Ok(0.0)` — so the token-gating caller can fail closed instead of letting
    /// a `> 0` gate "pass" during an outage.
    #[tokio::test]
    async fn balance_of_unreachable_rpc_is_unavailable_not_zero() {
        let eth = offline_eth();
        let token = address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
        let owner = address!("0000000000000000000000000000000000000001");
        let res = eth.balance_of(token, owner).await;
        assert!(
            matches!(res, Err(EthError::Unavailable { .. })),
            "an unreachable RPC must be Unavailable, not Ok(0.0); got {res:?}"
        );
    }

    /// `verify_signature` against an unreachable RPC must be `Err(Unavailable)`,
    /// not `Ok(SigCheck::Invalid)` — a flaky RPC must not look like a forgery.
    #[tokio::test]
    async fn verify_signature_unreachable_rpc_is_unavailable() {
        let eth = offline_eth();
        let signer = address!("0000000000000000000000000000000000000001");
        let res = eth.verify_signature(signer, B256::ZERO, &[0u8; 65]).await;
        assert!(
            matches!(res, Err(EthError::Unavailable { .. })),
            "unreachable RPC must be Unavailable; got {res:?}"
        );
    }

    /// Offline negative: a non-zero signature that is NOT 6492-wrapped and NOT a
    /// valid 65-byte ECDSA sig over the hash must not be detected as wrapped, and
    /// the wrapper decode must reject it. (Strengthens the earlier all-zero case
    /// with a wrong-magic, non-trivial payload.)
    #[test]
    fn non_zero_wrong_magic_signature_is_not_wrapped() {
        // 96 bytes of 0xAB, last 32 bytes are NOT the 6492 magic.
        let mut sig = vec![0xABu8; 96];
        // Make the trailing 32 bytes a recognisable wrong magic.
        for b in sig[64..].iter_mut() {
            *b = 0x11;
        }
        assert!(
            !is_erc6492_wrapped(&sig),
            "wrong trailing magic ⇒ not wrapped"
        );
        assert!(
            decode_erc6492_wrapper(&sig).is_none(),
            "a non-wrapped sig must not decode as a 6492 wrapper"
        );
    }

    /// Live ERC-1271 / ERC-6492 validation against a real RPC.
    ///
    /// Ignored by default so `cargo test` never needs network. Run with a real
    /// mainnet RPC:
    ///
    /// ```bash
    /// ETH_RPC_URL=https://eth.llamarpc.com \
    ///   cargo test -p cryptoverse-core -- --ignored live_contract_signature
    /// ```
    ///
    /// This is the **negative** live check: a random signer + zero hash + zero
    /// sig is definitively NOT valid, and the deployless call must return a clean
    /// `Invalid` (or, if the RPC is flaky, `Unavailable`) — never panic. The
    /// **positive** happy path (a genuine smart-account signature →
    /// `SigCheck::Valid`) is covered by [`live_erc6492_coinbase_smart_wallet`].
    #[tokio::test]
    #[ignore = "requires a live RPC (set ETH_RPC_URL); see doc comment"]
    async fn live_contract_signature() {
        let eth = Eth::from_env().expect("build provider from env");

        let signer = address!("0000000000000000000000000000000000000001");
        match eth.verify_signature(signer, B256::ZERO, &[0u8; 65]).await {
            Ok(SigCheck::Invalid) => { /* expected */ }
            Ok(SigCheck::Valid) => panic!("a zero signature must not validate as Valid"),
            Err(e) => eprintln!("RPC unavailable during live negative check: {e}"),
        }
    }

    /// **The headline differentiator, proven live**: a *genuine* counterfactual
    /// ERC-6492 signature from a (not-yet-deployed) **Coinbase Smart Wallet**
    /// validates as [`SigCheck::Valid`] — exactly the case an `ecrecover`-only
    /// backend rejects.
    ///
    /// Ignored by default (needs a real mainnet RPC). Run:
    ///
    /// ```bash
    /// cd login && set -a; . ../.env; set +a
    /// ETH_RPC_URL="$ALCHEMY_URL" \
    ///   cargo test -p cryptoverse-core --ignored \
    ///   live_erc6492_coinbase_smart_wallet -- --nocapture
    /// ```
    ///
    /// We construct the signature from scratch for the well-known Hardhat test
    /// key `0x59c6…690d` (EOA `0x7099…79C8`) — the *owner* of a CBSW that is not
    /// yet deployed — and feed it through the real [`Eth::verify_signature`]. The
    /// deployless [`UNIVERSAL_VALIDATOR_BYTECODE`] does the CREATE2 factory deploy
    /// in the (discarded) call state, then ERC-1271-validates. Construction:
    ///
    /// 1. `owners = [bytes32(owner)]`, `nonce = 0`.
    /// 2. The counterfactual account address (= the ERC-1271 `verifyingContract`
    ///    *and* the `signer` we pass to `verify_signature`) is read live from the
    ///    canonical mainnet factory's `getAddress(owners, nonce)` view —
    ///    [`CBSW_FACTORY`] `0x0BA5…428a`.
    /// 3. The owner ECDSA-signs the CBSW **replay-safe EIP-712 digest** of the
    ///    app hash (`keccak256(0x1901 ‖ domainSeparator ‖ keccak256(
    ///    MESSAGE_TYPEHASH ‖ hash))`, domain `"Coinbase Smart Wallet" / "1"`,
    ///    chainId 1, verifyingContract = the account) — see [`cbsw_replay_safe_hash`].
    ///    `SignatureCheckerLib` does a raw `ecrecover` over that digest (no EIP-191
    ///    prefix), so we sign the digest directly.
    /// 4. inner ERC-1271 sig = `abi.encode(SignatureWrapper{ownerIndex:0,
    ///    signatureData: ecdsaSig})`.
    /// 5. `factoryCalldata = createAccount(owners, nonce)` (selector `0x3ffba36f`).
    /// 6. 6492 wrapper = `abi.encode(factory, factoryCalldata, innerSig) ‖
    ///    0x6492…6492`.
    ///
    /// Asserts `verify_signature(account, app_hash, wrapper) == Valid`.
    #[tokio::test]
    #[ignore = "requires a live RPC (set ETH_RPC_URL); see doc comment"]
    async fn live_erc6492_coinbase_smart_wallet() {
        use alloy::providers::DynProvider;
        use alloy::signers::local::PrivateKeySigner;
        use alloy::signers::SignerSync;
        use alloy::sol_types::SolCall;

        sol! {
            #[sol(rpc)]
            interface ICBSWFactory {
                function getAddress(bytes[] owners, uint256 nonce) external view returns (address);
                function createAccount(bytes[] owners, uint256 nonce) external payable returns (address);
            }
        }

        // Hardhat account #1 — a well-known throwaway key (EOA 0x7099…79C8).
        // pragma: allowlist secret
        const TEST_KEY: &str = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
        // Canonical Coinbase Smart Wallet factory (mainnet, also same across chains).
        const CBSW_FACTORY: Address = address!("0BA5ED0c6AA8c49038F819E587E2633c4A9F428a");

        let eth = Eth::from_env().expect("build provider from env");

        // A second provider handle (typed `DynProvider`) for the factory view +
        // code check — `Eth` deliberately exposes only `verify_signature`, so the
        // test does its own read-only setup calls.
        let url = mainnet_rpc_url();
        let provider: DynProvider = match url.parse() {
            Ok(u) => RootProvider::new(ClientBuilder::default().http(u)).erased(),
            Err(e) => {
                eprintln!("skipping: bad RPC url {url}: {e}");
                return;
            }
        };

        let signer: PrivateKeySigner = TEST_KEY.parse().expect("valid test key");
        let owner = signer.address();

        // owners = [bytes32(owner)] (the 20-byte address left-padded to 32 bytes).
        let owners: Vec<Bytes> = vec![Bytes::from(owner.into_word().0.to_vec())];
        let nonce = U256::ZERO;

        // (2) counterfactual account address from the live factory view.
        let factory = ICBSWFactory::new(CBSW_FACTORY, provider.clone());
        let account = match factory.getAddress(owners.clone(), nonce).call().await {
            Ok(a) => a,
            Err(e) => {
                eprintln!("skipping: factory.getAddress unavailable (RPC flaky?): {e}");
                return;
            }
        };

        // Sanity: the account must be counterfactual (no code) so we're really
        // exercising the ERC-6492 CREATE2-then-1271 path, not a plain deployed
        // ERC-1271. (If someone deployed it, the 1271 branch still proves Valid.)
        if let Ok(code) = provider.get_code_at(account).await {
            eprintln!(
                "CBSW account {account} code len = {} (0 ⇒ counterfactual ERC-6492 path)",
                code.len()
            );
        }

        // (3) the app hash + its CBSW replay-safe EIP-712 digest.
        let app_hash = keccak256("cryptoverse smart-account login test");
        let digest = cbsw_replay_safe_hash(account, 1, app_hash);

        // (3b) owner ECDSA-signs the RAW digest (SignatureCheckerLib does a bare
        // ecrecover, NOT an EIP-191 personal_sign).
        let ecdsa = signer
            .sign_hash_sync(&digest)
            .expect("sign digest")
            .as_bytes();

        // (4) inner ERC-1271 sig = abi.encode(SignatureWrapper{ownerIndex, sig}).
        let inner = (U256::ZERO, Bytes::from(ecdsa.to_vec())).abi_encode_params();

        // (5) factoryCalldata = createAccount(owners, nonce).
        let factory_calldata = ICBSWFactory::createAccountCall {
            owners: owners.clone(),
            nonce,
        }
        .abi_encode();

        // (6) ERC-6492 wrapper = abi.encode(factory, calldata, inner) ++ magic.
        let mut wrapper = (
            CBSW_FACTORY,
            Bytes::from(factory_calldata),
            Bytes::from(inner),
        )
            .abi_encode_params();
        wrapper.extend_from_slice(&ERC6492_MAGIC_SUFFIX);
        assert!(
            is_erc6492_wrapped(&wrapper),
            "constructed signature must carry the 6492 magic suffix"
        );

        // The whole point: this is exactly the signature a pure-ecrecover backend
        // would reject (the EOA `owner` is NOT the `account` we pass as signer).
        // The universal validator deploys the CBSW, then ERC-1271-validates → Valid.
        match eth.verify_signature(account, app_hash, &wrapper).await {
            Ok(SigCheck::Valid) => { /* the differentiator, proven */ }
            Ok(SigCheck::Invalid) => {
                panic!("genuine ERC-6492 Coinbase Smart Wallet signature must be Valid")
            }
            Err(e) => eprintln!("RPC unavailable during live ERC-6492 check: {e}"),
        }
    }

    /// Live forward-verified ENS resolution against a real mainnet RPC.
    ///
    /// Ignored by default (needs network). Run with a real RPC:
    ///
    /// ```bash
    /// ETH_RPC_URL=https://eth.llamarpc.com \
    ///   cargo test -p cryptoverse-core -- --ignored ens_reverse_forward_verified_live
    /// ```
    ///
    /// `vitalik.eth` has a primary name whose forward `addr` resolves back to the
    /// same address, so the verified lookup must return `Some("vitalik.eth")`. A
    /// fresh random address has no reverse record, so it must be `None`. This
    /// exercises the full reverse → forward-`addr` → equality path live; the
    /// offline tests pin the fail-closed behaviour and the node derivation.
    #[tokio::test]
    #[ignore = "requires a live RPC (set ETH_RPC_URL); see doc comment"]
    async fn ens_reverse_forward_verified_live() {
        let eth = Eth::from_env().expect("build provider from env");

        let vitalik = address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
        match eth.ens_reverse(vitalik).await {
            Some(name) => assert_eq!(
                name, "vitalik.eth",
                "the forward-verified primary name must be vitalik.eth"
            ),
            // If the RPC is flaky the best-effort contract yields None; don't fail
            // the suite on infrastructure, but surface it.
            None => eprintln!("ENS lookup returned None (RPC flaky, or record changed)"),
        }

        // An address with no reverse record verifies to nothing.
        let no_name = address!("000000000000000000000000000000000000dEaD");
        assert!(
            eth.ens_reverse(no_name).await.is_none(),
            "an address with no primary name must not produce a verified name"
        );
    }

    /// Live ownership-verified Unstoppable Domains resolution against a real
    /// mainnet RPC. Ignored by default (needs network).
    ///
    /// ```bash
    /// ETH_RPC_URL=https://eth.llamarpc.com \
    ///   cargo test -p cryptoverse-core -- --ignored ud_reverse_ownership_verified_live
    /// ```
    ///
    /// READY-TO-RUN SCAFFOLD — most addresses have no UD reverse record, so the
    /// positive assertion is left for a committed vector (an address with a UD
    /// reverse record it provably owns). The negative branch runs live today: a
    /// fresh address must verify to `None` (no reverse token, or `ownerOf`
    /// mismatch ⇒ fail closed).
    #[tokio::test]
    #[ignore = "requires a live RPC (set ETH_RPC_URL); see doc comment"]
    async fn ud_reverse_ownership_verified_live() {
        let eth = Eth::from_env().expect("build provider from env");

        // Negative (live): no UD reverse record ⇒ ownership check never trusts a
        // name ⇒ None.
        let no_name = address!("000000000000000000000000000000000000dEaD");
        assert!(
            eth.ud_reverse(no_name).await.is_none(),
            "an address without a UD reverse record must yield None"
        );

        // Positive (commit a real vector to enable):
        //
        // let owner = address!("<address that owns a UD domain set as its reverse>");
        // assert_eq!(eth.ud_reverse(owner).await.as_deref(), Some("<name.crypto>"));
    }

    /// Live forward-verified **Basenames** (`*.base.eth`) resolution against a
    /// real **Base** RPC. Ignored by default (needs network + a Base endpoint).
    /// Run with a Base RPC:
    ///
    /// ```bash
    /// BASE_RPC_URL=https://base-rpc.publicnode.com \
    ///   cargo test -p cryptoverse-core -- --ignored basename_reverse_forward_verified_live
    /// ```
    ///
    /// Mirrors [`ens_reverse_forward_verified_live`] on Base: it exercises the
    /// full `nameForAddr` → forward `addr` → equality path live. The positive
    /// assertion is left for a committed vector (an address whose `*.base.eth`
    /// primary forward-resolves back to it). The negative branch runs live today:
    /// a fresh address has no Base primary, so it must verify to `None`.
    #[tokio::test]
    #[ignore = "requires a live Base RPC (set BASE_RPC_URL); see doc comment"]
    async fn basename_reverse_forward_verified_live() {
        let eth = Eth::from_env().expect("build provider from env");

        // Negative (live): an address with no Base primary name verifies to
        // nothing (no reverse name, or the forward `addr` won't match).
        let no_name = address!("000000000000000000000000000000000000dEaD");
        assert!(
            eth.basename_reverse(no_name).await.is_none(),
            "an address with no Basename primary must not produce a verified name"
        );

        // Positive (commit a real vector to enable):
        //
        // let owner = address!("<address whose *.base.eth primary resolves back>");
        // assert_eq!(eth.basename_reverse(owner).await.as_deref(), Some("<name.base.eth>"));
    }
}
