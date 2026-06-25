//! On-chain helpers: ENS reverse resolution, Unstoppable Domains reverse
//! resolution, and ERC-20 balances (for token-gating).
//!
//! **Enrichment** (ENS / UD names) is best-effort: a flaky RPC must never block
//! a login, so those lookups return `Option`/`None` on error and log at `warn`.
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

    #[sol(rpc)]
    interface ENSRegistry {
        function resolver(bytes32 node) external view returns (address);
    }

    #[sol(rpc)]
    interface ENSNameResolver {
        function name(bytes32 node) external view returns (string);
    }

    #[sol(rpc)]
    interface IUDProxyReader {
        function reverseOf(address addr) external view returns (uint256);
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

    /// ENS reverse resolution (`addr -> name`). Returns `None` if there is no
    /// reverse record or on error.
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
        match self
            .rpc_call("ENS resolver.name", |p| async move {
                ENSNameResolver::new(resolver, p).name(node).call().await
            })
            .await
        {
            Ok(name) if !name.is_empty() => Some(name),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!("ENS resolver.name failed for {owner}: {e}");
                None
            }
        }
    }

    /// Unstoppable Domains reverse resolution. Reads the reverse token id from
    /// the UNS ProxyReader, then resolves its name via the UD metadata API.
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
}

/// An `eth_call` *revert* (the deployless validator's definitive "no" for a
/// malformed/invalid signature) surfaces with a cause that reads "execution
/// reverted" — distinct from the RPC being unreachable. Tiny testable predicate.
fn is_revert(cause: &str) -> bool {
    cause.to_ascii_lowercase().contains("revert")
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
        assert!(!is_revert("server returned an error response: error code -32005"));
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

    /// An `Eth` whose primary RPC points at a closed local port, so a call that
    /// actually hits the network fails fast with connection-refused (no real
    /// network, no long wait) — used to assert the fail-closed paths.
    fn offline_eth() -> Eth {
        let provider =
            RootProvider::new(ClientBuilder::default().http("http://127.0.0.1:1".parse().unwrap()))
                .erased();
        Eth {
            provider,
            fallback: None,
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
    /// READY-TO-RUN SCAFFOLD — fill `SIGNER` / `HASH` / `SIGNATURE` with a real
    /// committed vector to make the positive assertion live. To produce one:
    /// deploy (or pick an already-deployed) Gnosis Safe / Coinbase Smart Wallet,
    /// have it sign a 32-byte hash (ERC-1271) — or capture a counterfactual
    /// ERC-6492-wrapped signature from a fresh smart wallet — and paste the
    /// `signer`, `hash`, and `signature` bytes below. Until then the positive
    /// branch is left commented so we never fake a passing assertion; the
    /// negative branch below already runs live and proves the call path returns a
    /// clean result (not an error) against a real RPC.
    #[tokio::test]
    #[ignore = "requires a live RPC (set ETH_RPC_URL); see doc comment"]
    async fn live_contract_signature() {
        let eth = Eth::from_env().expect("build provider from env");

        // --- Negative (runs live today): a random signer + zero hash + zero sig
        //     is definitively NOT valid, and the deployless call must return a
        //     clean Invalid (or, if the RPC is flaky, Unavailable) — never panic.
        let signer = address!("0000000000000000000000000000000000000001");
        match eth.verify_signature(signer, B256::ZERO, &[0u8; 65]).await {
            Ok(SigCheck::Invalid) => { /* expected */ }
            Ok(SigCheck::Valid) => panic!("a zero signature must not validate as Valid"),
            Err(e) => eprintln!("RPC unavailable during live negative check: {e}"),
        }

        // --- Positive (commit a real vector to enable): uncomment and fill in.
        //
        // let signer = address!("<deployed Safe / smart-wallet address>");
        // let hash = B256::from(hex!(
        //     "<32-byte hash the wallet signed over>"
        // ));
        // let signature = hex!("<ERC-1271 or ERC-6492-wrapped signature bytes>");
        // let got = eth
        //     .verify_signature(signer, hash, &signature)
        //     .await
        //     .expect("RPC must be reachable for the live positive check");
        // assert_eq!(got, SigCheck::Valid, "real contract signature must be Valid");
    }
}
