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
pub async fn get_data(
    eth: &Eth,
    cache: &EnrichmentCache,
    subject: &str,
    mailserver_domain: &str,
    profile_domain: &str,
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
            let email = format!("{}@{mailserver_domain}", ens.replace(".eth", ""));
            email_all.push(email.clone());
            ens_email_default = Some(email.clone());
            ens_email_all.push(email);

            name_all.push(ens.clone());
            ens_name_default = Some(ens.clone());
            ens_name_all.push(ens);
        }

        if let Some(ud) = ud {
            let email = format!(
                "{}@unstoppable.email",
                ud.strip_suffix(".crypto").unwrap_or(&ud)
            );
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
        "ens": { "default": ens_name_default, "all": ens_name_all },
        "unstoppabledomains": { "default": ud_name_default, "all": ud_name_all },
    });

    json!({
        "address": { "country": "Cryptoverse", "region": "Ethereum" },
        "birthdate": "",
        "email_verified": true,
        "email": default_email,
        "emails": emails,
        "family_name": "Ethereum",
        "gender": "ethereum-address",
        "given_name": user,
        "locale": "",
        "middle_name": "",
        "name": user,
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
