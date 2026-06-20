//! On-chain helpers: ENS reverse resolution, Unstoppable Domains reverse
//! resolution, and ERC-20 balances (for token-gating).
//!
//! All calls are **best-effort**: the previous Node backend caught every
//! on-chain error and continued with whatever data it had, so a flaky RPC never
//! blocks a login. We preserve that — lookups return `Option`/default on error
//! and log at `warn`.

use alloy::primitives::{address, keccak256, Address, FixedBytes, U256};
use alloy::providers::{DynProvider, Provider, RootProvider};
use alloy::rpc::client::ClientBuilder;
use alloy::sol;

// ENS registry (mainnet) and the Unstoppable Domains UNS ProxyReader (mainnet).
const ENS_REGISTRY: Address = address!("00000000000C2E074eC69A0dFb2997BA6C7d2e1e");
const UD_PROXY_READER: Address = address!("049aba7510f45BA5b64ea9E658E342F904DB358D");

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

#[derive(Clone)]
pub struct Eth {
    provider: DynProvider,
    http: reqwest::Client,
}

impl Eth {
    /// Build from env: prefers Alchemy, then Infura, then `ETH_RPC_URL`, then a
    /// public endpoint.
    pub fn from_env() -> anyhow::Result<Self> {
        let url = mainnet_rpc_url();
        let provider = RootProvider::new(ClientBuilder::default().http(url.parse()?)).erased();
        Ok(Self {
            provider,
            http: reqwest::Client::new(),
        })
    }

    /// ERC-20 balance of `owner` for `token`, scaled by the token's `decimals`
    /// and returned as `f64` (so it can be fed to the token-gating expression
    /// evaluator, which can't handle `U256`). Returns `0.0` on any error.
    pub async fn balance_of(&self, token: Address, owner: Address) -> f64 {
        let erc = IERC20::new(token, &self.provider);

        // Most tokens implement `decimals`; default to 18 if not.
        let decimals: u8 = match erc.decimals().call().await {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!("decimals() failed for {token}: {e}; defaulting to 18");
                18
            }
        };

        let raw: U256 = match erc.balanceOf(owner).call().await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("balanceOf() failed for {token}/{owner}: {e}");
                return 0.0;
            }
        };

        match alloy::primitives::utils::format_units(raw, decimals) {
            Ok(s) => s.parse().unwrap_or(0.0),
            Err(e) => {
                tracing::warn!("format_units failed: {e}");
                0.0
            }
        }
    }

    /// ENS reverse resolution (`addr -> name`). Returns `None` if there is no
    /// reverse record or on error.
    pub async fn ens_reverse(&self, owner: Address) -> Option<String> {
        let reverse_name = format!("{}.addr.reverse", hex::encode(owner.as_slice()));
        let node = namehash(&reverse_name);

        let registry = ENSRegistry::new(ENS_REGISTRY, &self.provider);
        let resolver = match registry.resolver(node).call().await {
            Ok(addr) => addr,
            Err(e) => {
                tracing::warn!("ENS registry.resolver failed for {owner}: {e}");
                return None;
            }
        };
        if resolver.is_zero() {
            return None;
        }

        let resolver = ENSNameResolver::new(resolver, &self.provider);
        match resolver.name(node).call().await {
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
        let reader = IUDProxyReader::new(UD_PROXY_READER, &self.provider);
        let token_id: U256 = match reader.reverseOf(owner).call().await {
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

    #[test]
    fn namehash_eth_matches_known_vector() {
        // Well-known EIP-137 test vector for "eth".
        let expected = "93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae";
        assert_eq!(hex::encode(namehash("eth").as_slice()), expected);
    }
}
