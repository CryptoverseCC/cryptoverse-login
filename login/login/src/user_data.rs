//! Builds the OIDC ID-token claims for a subject (lowercased Ethereum address).
//!
//! Port of `backend/src/routes/userData.ts`. Enriches the token with ENS and
//! Unstoppable Domains reverse-resolution names plus generated
//! `{address}@{MAILSERVER_DOMAIN}` emails. All on-chain lookups are best-effort.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use alloy::primitives::Address;
use cryptoverse_core::eth::Eth;
use serde_json::json;
use tokio::sync::RwLock;

/// How long a per-address enrichment result is reused before re-resolving from
/// chain. ENS / UD names change rarely; 10 min trades a small staleness window
/// for skipping the (slow, multi-RPC) reverse lookups on repeat logins.
const ENRICHMENT_TTL: Duration = Duration::from_secs(10 * 60);

/// The on-chain-derived part of a user's profile: the ENS and Unstoppable
/// Domains reverse names. Everything else in the ID token is pure formatting of
/// these plus the address, so caching this pair is enough.
#[derive(Clone, Default)]
pub struct Enrichment {
    pub ens: Option<String>,
    pub ud: Option<String>,
}

/// A tiny in-process TTL cache of `Enrichment` keyed by the lowercased address.
///
/// Hand-rolled over a `RwLock<HashMap<…>>` rather than pulling in `moka`: the
/// map holds one small entry per recently-seen address and the access pattern
/// is trivial (point lookup + insert), so a dependency-free cache is the leaner
/// choice and keeps the build free of any new transitive crates.
///
/// **Negative-result policy:** a "no name" result *is* cached (with the same
/// TTL) — that's the common case (most addresses have neither ENS nor UD) and
/// re-resolving it on every login is exactly the cost we want to avoid. A
/// *transient RPC failure* is **not** distinguishable from a genuine "no name"
/// at this layer (both surface as `None` by the module's best-effort contract),
/// but the 10-minute TTL bounds how long any such miss is pinned, so a flaky
/// RPC can't durably hide a name.
#[derive(Default)]
pub struct EnrichmentCache {
    map: RwLock<HashMap<String, (Instant, Enrichment)>>,
}

impl EnrichmentCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return a fresh (non-expired) cached entry, or `None` on miss/expiry.
    async fn get(&self, key: &str) -> Option<Enrichment> {
        let guard = self.map.read().await;
        let (at, value) = guard.get(key)?;
        if at.elapsed() < ENRICHMENT_TTL {
            Some(value.clone())
        } else {
            None
        }
    }

    async fn put(&self, key: String, value: Enrichment) {
        self.map.write().await.insert(key, (Instant::now(), value));
    }
}

/// Resolve the cacheable on-chain enrichment for `owner`, consulting the TTL
/// cache first. On a miss, the two reverse lookups run concurrently and the
/// result is stored (see `EnrichmentCache` for the negative-result policy).
async fn resolve_enrichment(eth: &Eth, cache: &EnrichmentCache, owner: Address) -> Enrichment {
    let key = format!("{owner:#x}"); // lowercased 0x-hex
    if let Some(hit) = cache.get(&key).await {
        return hit;
    }
    // ENS reverse and Unstoppable Domains reverse are independent on-chain
    // lookups, so run them concurrently and join — same result, ~half the
    // wall-clock latency on a cache miss.
    let (ens, ud) = tokio::join!(eth.ens_reverse(owner), eth.ud_reverse(owner));
    let enrichment = Enrichment { ens, ud };
    cache.put(key, enrichment.clone()).await;
    enrichment
}

/// Build the `id_token` claims object for `subject`.
///
/// `email_verified` is the value put on the `email_verified` claim — see the
/// claim's inline comment: it must default to `false` because the generated
/// `{address}@{MAILSERVER_DOMAIN}` mailbox is synthetic and never delivered to.
pub async fn get_data(
    eth: &Eth,
    cache: &EnrichmentCache,
    subject: &str,
    mailserver_domain: &str,
    profile_domain: &str,
    email_verified: bool,
) -> serde_json::Value {
    let user = subject;
    let default_email = format!("{user}@{mailserver_domain}");

    let mut email_all = vec![default_email.clone()];
    let mut ens_email_default: Option<String> = None;
    let mut ens_email_all: Vec<String> = vec![];
    let mut ud_email_default: Option<String> = None;
    let mut ud_email_all: Vec<String> = vec![];

    let mut name_all = vec![user.to_string()];
    let mut ens_name_default: Option<String> = None;
    let mut ens_name_all: Vec<String> = vec![];
    let mut ud_name_default: Option<String> = None;
    let mut ud_name_all: Vec<String> = vec![];

    if let Ok(owner) = subject.parse::<Address>() {
        // Per-address enrichment (ENS + UD reverse) is resolved through a TTL
        // cache; on a miss the two lookups run concurrently (see
        // `resolve_enrichment`).
        let Enrichment { ens, ud } = resolve_enrichment(eth, cache, owner).await;

        if let Some(ens) = ens {
            // Strip only the trailing `.eth` (a `.replace` would also mangle a
            // name that legitimately contains "eth", e.g. "ethan.eth").
            let local = ens.strip_suffix(".eth").unwrap_or(&ens);
            let email = format!("{local}@{mailserver_domain}");
            email_all.push(email.clone());
            ens_email_default = Some(email.clone());
            ens_email_all.push(email);

            name_all.push(ens.clone());
            ens_name_default = Some(ens.clone());
            ens_name_all.push(ens);
        }

        if let Some(ud) = ud {
            // Unstoppable Domains issues many TLDs (.crypto, .nft, .x, .wallet,
            // .dao, …), so strip whatever the actual trailing label is rather
            // than only ".crypto". The local part is everything before the last
            // dot; a name with no dot is used as-is.
            let local = ud.rsplit_once('.').map(|(head, _)| head).unwrap_or(&ud);
            let email = format!("{local}@unstoppable.email");
            email_all.push(email.clone());
            ud_email_default = Some(email.clone());
            ud_email_all.push(email);

            name_all.push(ud.clone());
            ud_name_default = Some(ud.clone());
            ud_name_all.push(ud);
        }
    }

    let emails = json!({
        "default": default_email,
        "all": email_all,
        "ens": { "default": ens_email_default, "all": ens_email_all },
        "unstoppabledomains": { "default": ud_email_default, "all": ud_email_all },
    });

    let names = json!({
        "default": user,
        "all": name_all,
        "ens": { "default": ens_name_default.clone(), "all": ens_name_all },
        "unstoppabledomains": { "default": ud_name_default.clone(), "all": ud_name_all },
    });

    // The OIDC `name` claim is the verified primary name (ENS preferred, else
    // UD) when one resolved, falling back to the address. `preferred_username`
    // and `nickname` are intentionally left as-is.
    let primary_name = primary_identity(ens_name_default.as_deref(), ud_name_default.as_deref())
        .map(|(name, _kind)| name.to_string());
    let name_claim = primary_name.as_deref().unwrap_or(user);

    json!({
        "address": { "country": "Cryptoverse", "region": "Ethereum" },
        "birthdate": "",
        // The verified identity is the *Ethereum address*, not the synthetic
        // `{address}@{MAILSERVER_DOMAIN}` mailbox (which is generated, never
        // confirmed, and may not even receive mail). Asserting `email_verified:
        // true` here would be a false claim that relying parties may trust for
        // account-recovery / password-reset. So it defaults to `false`; an
        // operator running a real, delivering mailserver can opt in via
        // `EMAIL_VERIFIED_CLAIM=true`.
        "email_verified": email_verified,
        "email": default_email,
        "emails": emails,
        "family_name": "Ethereum",
        "gender": "ethereum-address",
        "given_name": user,
        "locale": "",
        "middle_name": "",
        "name": name_claim,
        "names": names,
        "nickname": ens_name_default,
        "phone_number_verified": false,
        "phone_number": "",
        "picture": format!("https://{profile_domain}/{user}.png"),
        "preferred_username": user,
        "profile": format!("https://{profile_domain}/{user}"),
        "sub": user,
        "updated_at": 0,
        "website": format!("https://{user}.{profile_domain}/"),
        "zoneinfo": "",
    })
}

/// Pick the verified primary identity from the resolved ENS and UD default
/// names: **ENS is preferred, else UD, else none**. Returns the name and its
/// namespace (`"ens"` | `"ud"`).
///
/// Both inputs are already forward-/ownership-verified by the enrichment layer
/// (`ens_reverse` only returns a name whose forward `addr` resolves back to the
/// address; `ud_reverse` only returns an owned name), so this is a pure
/// selection — no extra on-chain work.
fn primary_identity<'a>(
    ens_default: Option<&'a str>,
    ud_default: Option<&'a str>,
) -> Option<(&'a str, &'static str)> {
    if let Some(ens) = ens_default {
        Some((ens, "ens"))
    } else {
        ud_default.map(|ud| (ud, "ud"))
    }
}

/// Extract the verified primary `(name, kind)` from an already-built `id_token`
/// claims object (as produced by [`get_data`]). Lets the consent handler reuse
/// the enrichment result for `cv_identities` **without triggering a second
/// on-chain resolution** — it just reads back the `names.{ens,unstoppabledomains}.default`
/// fields `get_data` already populated. ENS is preferred, else UD, else `None`.
pub fn primary_from_id_token(id_token: &serde_json::Value) -> Option<(String, &'static str)> {
    let ens = id_token["names"]["ens"]["default"].as_str();
    let ud = id_token["names"]["unstoppabledomains"]["default"].as_str();
    primary_identity(ens, ud).map(|(name, kind)| (name.to_string(), kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0x0000000000000000000000000000000000000001";

    #[tokio::test]
    async fn cache_miss_on_empty() {
        let cache = EnrichmentCache::new();
        assert!(cache.get(KEY).await.is_none(), "empty cache must miss");
    }

    #[tokio::test]
    async fn cache_hit_returns_stored_value() {
        let cache = EnrichmentCache::new();
        let value = Enrichment {
            ens: Some("vitalik.eth".to_string()),
            ud: None,
        };
        cache.put(KEY.to_string(), value.clone()).await;

        let hit = cache.get(KEY).await.expect("fresh entry must hit");
        assert_eq!(hit.ens.as_deref(), Some("vitalik.eth"));
        assert_eq!(hit.ud, None);

        // A different key still misses.
        assert!(cache
            .get("0x0000000000000000000000000000000000000002")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn cache_caches_negative_result() {
        // "No name" is a valid, cacheable result (the common case).
        let cache = EnrichmentCache::new();
        cache.put(KEY.to_string(), Enrichment::default()).await;
        let hit = cache
            .get(KEY)
            .await
            .expect("negative result must be cached");
        assert!(hit.ens.is_none() && hit.ud.is_none());
    }

    /// `.eth` is stripped only as a *suffix* (not every occurrence), so a name
    /// like "ethan.eth" keeps its "eth" inside the local part.
    #[test]
    fn ens_local_part_strips_only_trailing_eth() {
        let ens = "ethan.eth";
        let local = ens.strip_suffix(".eth").unwrap_or(ens);
        assert_eq!(local, "ethan");

        let ens = "vitalik.eth";
        assert_eq!(ens.strip_suffix(".eth").unwrap_or(ens), "vitalik");
    }

    /// The UD local part strips whatever the trailing TLD is, not only ".crypto".
    #[test]
    fn ud_local_part_strips_actual_tld() {
        for (name, expected) in [
            ("brad.crypto", "brad"),
            ("alice.nft", "alice"),
            ("bob.wallet", "bob"),
            ("dao.x", "dao"),
            ("nodot", "nodot"),
        ] {
            let local = name.rsplit_once('.').map(|(h, _)| h).unwrap_or(name);
            assert_eq!(local, expected, "for {name}");
        }
    }

    /// `email_verified` reflects the passed flag (honest default is false): the
    /// synthetic mailbox is never asserted verified unless explicitly opted in.
    #[tokio::test]
    async fn email_verified_claim_reflects_flag() {
        // Address that won't resolve (offline Eth via unroutable RPC).
        std::env::set_var("ETH_RPC_URL", "http://127.0.0.1:1");
        std::env::set_var("RPC_TIMEOUT_MS", "150");
        let eth = Eth::from_env().expect("eth");
        let cache = EnrichmentCache::new();
        let subject = "0x0000000000000000000000000000000000000001";

        let claims = get_data(&eth, &cache, subject, "ethmail.cc", "cryptoverse.cc", false).await;
        assert_eq!(claims["email_verified"], serde_json::json!(false));

        let claims = get_data(&eth, &cache, subject, "ethmail.cc", "cryptoverse.cc", true).await;
        assert_eq!(claims["email_verified"], serde_json::json!(true));
    }

    /// Primary selection: ENS preferred, else UD, else none.
    #[test]
    fn primary_identity_prefers_ens_then_ud_then_none() {
        assert_eq!(
            primary_identity(Some("alice.eth"), Some("alice.crypto")),
            Some(("alice.eth", "ens")),
            "ENS wins when both present"
        );
        assert_eq!(
            primary_identity(None, Some("alice.crypto")),
            Some(("alice.crypto", "ud")),
            "UD used when no ENS"
        );
        assert_eq!(
            primary_identity(Some("alice.eth"), None),
            Some(("alice.eth", "ens")),
            "ENS used when no UD"
        );
        assert_eq!(primary_identity(None, None), None, "none when neither");
    }

    /// `primary_from_id_token` reads back the verified default names that
    /// `get_data` populated (no second resolution), ENS-preferred.
    #[test]
    fn primary_from_id_token_reads_back_defaults() {
        let with_ens = json!({
            "names": {
                "ens": { "default": "alice.eth" },
                "unstoppabledomains": { "default": "alice.crypto" },
            }
        });
        assert_eq!(
            primary_from_id_token(&with_ens),
            Some(("alice.eth".to_string(), "ens"))
        );

        let ud_only = json!({
            "names": {
                "ens": { "default": serde_json::Value::Null },
                "unstoppabledomains": { "default": "bob.crypto" },
            }
        });
        assert_eq!(
            primary_from_id_token(&ud_only),
            Some(("bob.crypto".to_string(), "ud"))
        );

        let none = json!({
            "names": {
                "ens": { "default": serde_json::Value::Null },
                "unstoppabledomains": { "default": serde_json::Value::Null },
            }
        });
        assert_eq!(primary_from_id_token(&none), None);
    }

    /// With no resolvable primary (the test-account case), the `name` claim
    /// falls back to the address — must not regress.
    #[tokio::test]
    async fn name_claim_falls_back_to_address() {
        std::env::set_var("ETH_RPC_URL", "http://127.0.0.1:1");
        std::env::set_var("RPC_TIMEOUT_MS", "150");
        let eth = Eth::from_env().expect("eth");
        let cache = EnrichmentCache::new();
        let subject = "0x0000000000000000000000000000000000000001";

        let claims = get_data(&eth, &cache, subject, "ethmail.cc", "cryptoverse.cc", false).await;
        assert_eq!(claims["name"], serde_json::json!(subject));
        // And `primary_from_id_token` agrees there is no primary.
        assert_eq!(primary_from_id_token(&claims), None);
    }

    #[tokio::test]
    async fn cache_entry_expires_after_ttl() {
        let cache = EnrichmentCache::new();
        // Insert an entry whose timestamp is already older than the TTL.
        let stale = Instant::now()
            .checked_sub(ENRICHMENT_TTL + Duration::from_secs(1))
            .expect("clock far enough from boot");
        cache.map.write().await.insert(
            KEY.to_string(),
            (
                stale,
                Enrichment {
                    ens: Some("stale.eth".to_string()),
                    ud: None,
                },
            ),
        );
        assert!(
            cache.get(KEY).await.is_none(),
            "an entry older than the TTL must be treated as a miss"
        );
    }
}
