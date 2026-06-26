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

/// The on-chain-derived part of a user's profile: the ENS, Basenames, and
/// Unstoppable Domains reverse names. Everything else in the ID token is pure
/// formatting of these plus the address, so caching this triple is enough.
#[derive(Clone, Default)]
pub struct Enrichment {
    pub ens: Option<String>,
    /// Forward-verified `*.base.eth` primary, resolved natively on Base L2.
    /// `None` when Basenames is disabled (no `BASE_RPC_URL`) or unverifiable.
    pub basename: Option<String>,
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
    // ENS reverse, Basenames reverse (Base L2), and Unstoppable Domains reverse
    // are independent on-chain lookups, so run them concurrently and join — same
    // result, ~a third the wall-clock latency on a cache miss.
    let (ens, basename, ud) = tokio::join!(
        eth.ens_reverse(owner),
        eth.basename_reverse(owner),
        eth.ud_reverse(owner)
    );
    let enrichment = Enrichment { ens, basename, ud };
    cache.put(key, enrichment.clone()).await;
    enrichment
}

/// Build the `id_token` claims object for `subject`, returning it alongside the
/// resolved [`Enrichment`] (so the consent handler can build `cv_identities`
/// without a second on-chain lookup).
///
/// `email_verified` is the value put on the `email_verified` claim — see the
/// claim's inline comment: it must default to `false` because the generated
/// `{address}@{MAILSERVER_DOMAIN}` mailbox is synthetic and never delivered to.
///
/// `expose_names` gates the **verified ENS / Unstoppable Domains human-readable
/// names** in the standard OIDC claims (`name`, `names.*`, `emails.*`,
/// `nickname`): these are real-world-linkable identity and are released only when
/// the relying party was granted the `profile` scope. The address-derived
/// synthetic claims always populate — they reveal only the address, which is the
/// public `sub` anyway. (The `mail`-scope `cv_identities` claim still carries the
/// verified primary regardless, built by the consent handler from the returned
/// `Enrichment` — `mail` is its own explicit grant.)
pub async fn get_data(
    eth: &Eth,
    cache: &EnrichmentCache,
    subject: &str,
    mailserver_domain: &str,
    profile_domain: &str,
    email_verified: bool,
    expose_names: bool,
) -> (serde_json::Value, Enrichment) {
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
    let mut basename_name_default: Option<String> = None;
    let mut basename_name_all: Vec<String> = vec![];
    let mut ud_name_default: Option<String> = None;
    let mut ud_name_all: Vec<String> = vec![];

    let enrichment = if let Ok(owner) = subject.parse::<Address>() {
        // Per-address enrichment (ENS + UD reverse) is resolved through a TTL
        // cache; on a miss the two lookups run concurrently (see
        // `resolve_enrichment`). It is always resolved (and returned, for
        // `cv_identities`); whether it surfaces in the standard claims below is
        // gated by `expose_names`.
        resolve_enrichment(eth, cache, owner).await
    } else {
        Enrichment::default()
    };
    // `has_primary_name` is a privacy-preserving boolean: it tells a relying party
    // that a verified primary name exists for this address WITHOUT disclosing it,
    // so an RP without the `profile` scope can still branch on it.
    let has_primary_name = primary_identity(
        enrichment.ens.as_deref(),
        enrichment.basename.as_deref(),
        enrichment.ud.as_deref(),
    )
    .is_some();

    if expose_names {
        let Enrichment { ens, basename, ud } = enrichment.clone();

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

        if let Some(basename) = basename {
            // A Basename is `*.base.eth`; strip only the trailing `.base.eth`
            // suffix for the email local part (a `.replace` would mangle a name
            // that legitimately contains "base.eth" earlier in the label).
            let local = basename.strip_suffix(".base.eth").unwrap_or(&basename);
            let email = format!("{local}@{mailserver_domain}");
            email_all.push(email.clone());
            // Basenames don't get their own `emails.*` namespace (the JSON keeps
            // the `ens` / `unstoppabledomains` shape); the address is still
            // reachable via `emails.all` and `names.basenames`.

            name_all.push(basename.clone());
            basename_name_default = Some(basename.clone());
            basename_name_all.push(basename);
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
        "basenames": { "default": basename_name_default.clone(), "all": basename_name_all },
        "unstoppabledomains": { "default": ud_name_default.clone(), "all": ud_name_all },
    });

    // The OIDC `name` claim is the verified primary name (ENS preferred, then
    // basename, else UD) when one resolved, falling back to the address.
    // `preferred_username` and `nickname` are intentionally left as-is.
    let primary_name = primary_identity(
        ens_name_default.as_deref(),
        basename_name_default.as_deref(),
        ud_name_default.as_deref(),
    )
    .map(|(name, _kind)| name.to_string());
    let name_claim = primary_name.as_deref().unwrap_or(user);

    let id_token = json!({
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
        // Privacy-preserving signal: a verified primary name exists for this
        // address, without disclosing it (the name itself is `profile`-gated).
        "has_primary_name": has_primary_name,
        "phone_number_verified": false,
        "phone_number": "",
        "picture": format!("https://{profile_domain}/{user}.png"),
        "preferred_username": user,
        "profile": format!("https://{profile_domain}/{user}"),
        "sub": user,
        "updated_at": 0,
        "website": format!("https://{user}.{profile_domain}/"),
        "zoneinfo": "",
    });
    (id_token, enrichment)
}

/// Pick the verified primary identity from the resolved ENS, Basename, and UD
/// default names: **ENS is preferred, then Basename, else UD, else none**.
/// Returns the name and its namespace (`"ens"` | `"basename"` | `"ud"`).
///
/// All inputs are already forward-/ownership-verified by the enrichment layer
/// (`ens_reverse` / `basename_reverse` only return a name whose forward `addr`
/// resolves back to the address; `ud_reverse` only returns an owned name), so
/// this is a pure selection — no extra on-chain work.
fn primary_identity<'a>(
    ens_default: Option<&'a str>,
    basename_default: Option<&'a str>,
    ud_default: Option<&'a str>,
) -> Option<(&'a str, &'static str)> {
    if let Some(ens) = ens_default {
        Some((ens, "ens"))
    } else if let Some(basename) = basename_default {
        Some((basename, "basename"))
    } else {
        ud_default.map(|ud| (ud, "ud"))
    }
}

/// The verified primary `(name, kind)` from a resolved [`Enrichment`] — ENS
/// preferred, then Basename, else Unstoppable Domains, else `None`. Used by the
/// consent handler to build `cv_identities` from the enrichment [`get_data`]
/// already resolved (**no second on-chain lookup**), independent of whether the
/// names were exposed in the standard claims (which is `profile`-gated).
pub fn primary_of(enrichment: &Enrichment) -> Option<(String, &'static str)> {
    primary_identity(
        enrichment.ens.as_deref(),
        enrichment.basename.as_deref(),
        enrichment.ud.as_deref(),
    )
    .map(|(name, kind)| (name.to_string(), kind))
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
            basename: None,
            ud: None,
        };
        cache.put(KEY.to_string(), value.clone()).await;

        let hit = cache.get(KEY).await.expect("fresh entry must hit");
        assert_eq!(hit.ens.as_deref(), Some("vitalik.eth"));
        assert_eq!(hit.basename, None);
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
        assert!(hit.ens.is_none() && hit.basename.is_none() && hit.ud.is_none());
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

        let (claims, _) = get_data(
            &eth,
            &cache,
            subject,
            "ethmail.cc",
            "cryptoverse.cc",
            false,
            true,
        )
        .await;
        assert_eq!(claims["email_verified"], serde_json::json!(false));

        let (claims, _) = get_data(
            &eth,
            &cache,
            subject,
            "ethmail.cc",
            "cryptoverse.cc",
            true,
            true,
        )
        .await;
        assert_eq!(claims["email_verified"], serde_json::json!(true));
    }

    /// The verified ENS/UD human-readable name is gated by `expose_names`
    /// (`profile` scope): when not exposed, the standard claims fall back to the
    /// address and `names.ens.default` is null — but the `Enrichment` is STILL
    /// returned (so `cv_identities` under the `mail` scope keeps the name) and the
    /// `has_primary_name` boolean still signals one exists.
    #[tokio::test]
    async fn verified_name_is_profile_gated_but_enrichment_returned() {
        std::env::set_var("ETH_RPC_URL", "http://127.0.0.1:1");
        std::env::set_var("RPC_TIMEOUT_MS", "150");
        let eth = Eth::from_env().expect("eth");
        let cache = EnrichmentCache::new();
        let subject = "0x0000000000000000000000000000000000000001";
        let owner: Address = subject.parse().unwrap();
        // Seed a verified ENS name so resolve_enrichment serves it from cache.
        cache
            .put(
                format!("{owner:#x}"),
                Enrichment {
                    ens: Some("alice.eth".to_string()),
                    basename: None,
                    ud: None,
                },
            )
            .await;

        // expose_names = false (no `profile`): name is redacted to the address,
        // but the enrichment is returned and the boolean still flags a name.
        let (claims, enrichment) = get_data(
            &eth,
            &cache,
            subject,
            "ethmail.cc",
            "cryptoverse.cc",
            false,
            false,
        )
        .await;
        assert_eq!(claims["name"], serde_json::json!(subject));
        assert!(claims["names"]["ens"]["default"].is_null());
        assert_eq!(claims["has_primary_name"], serde_json::json!(true));
        assert_eq!(
            primary_of(&enrichment),
            Some(("alice.eth".to_string(), "ens"))
        );

        // expose_names = true (`profile` granted): the verified name surfaces.
        let (claims, _) = get_data(
            &eth,
            &cache,
            subject,
            "ethmail.cc",
            "cryptoverse.cc",
            false,
            true,
        )
        .await;
        assert_eq!(claims["name"], serde_json::json!("alice.eth"));
        assert_eq!(
            claims["names"]["ens"]["default"],
            serde_json::json!("alice.eth")
        );
    }

    /// A resolved **Basename** (no ENS) surfaces under `names.basenames`, is
    /// chosen as the `name` claim (ENS > basename > UD), and its stripped local
    /// part appears in `emails.all` — while the `ens`/`unstoppabledomains`
    /// namespaces stay null. Profile-gated like the other verified names.
    #[tokio::test]
    async fn basename_surfaces_in_names_and_is_chosen_over_ud() {
        std::env::set_var("ETH_RPC_URL", "http://127.0.0.1:1");
        std::env::set_var("RPC_TIMEOUT_MS", "150");
        let eth = Eth::from_env().expect("eth");
        let cache = EnrichmentCache::new();
        let subject = "0x0000000000000000000000000000000000000001";
        let owner: Address = subject.parse().unwrap();
        // Seed a verified basename + a UD name, but NO ENS — so the basename must
        // win the primary selection over the UD name.
        cache
            .put(
                format!("{owner:#x}"),
                Enrichment {
                    ens: None,
                    basename: Some("alice.base.eth".to_string()),
                    ud: Some("alice.crypto".to_string()),
                },
            )
            .await;

        // expose_names = true (`profile` granted): the basename surfaces.
        let (claims, enrichment) = get_data(
            &eth,
            &cache,
            subject,
            "ethmail.cc",
            "cryptoverse.cc",
            false,
            true,
        )
        .await;

        // The new `names.basenames` namespace mirrors the ens/UD shape.
        assert_eq!(
            claims["names"]["basenames"]["default"],
            serde_json::json!("alice.base.eth")
        );
        assert_eq!(
            claims["names"]["basenames"]["all"],
            serde_json::json!(["alice.base.eth"])
        );
        // The ENS namespace is null (no ENS resolved); UD still surfaces.
        assert!(claims["names"]["ens"]["default"].is_null());
        assert_eq!(
            claims["names"]["unstoppabledomains"]["default"],
            serde_json::json!("alice.crypto")
        );

        // The `name` claim picks the basename over the UD name (ENS > basename > UD).
        assert_eq!(claims["name"], serde_json::json!("alice.base.eth"));
        assert_eq!(
            primary_of(&enrichment),
            Some(("alice.base.eth".to_string(), "basename"))
        );

        // The basename's stripped local part lands in `emails.all`.
        let all = claims["emails"]["all"]
            .as_array()
            .expect("emails.all array");
        assert!(
            all.iter().any(|e| e == "alice@ethmail.cc"),
            "basename local part must appear in emails.all; got {all:?}"
        );

        // expose_names = false (`profile` not granted): basename redacted from the
        // standard claims, but the enrichment (→ cv_identities) keeps it.
        let (claims, enrichment) = get_data(
            &eth,
            &cache,
            subject,
            "ethmail.cc",
            "cryptoverse.cc",
            false,
            false,
        )
        .await;
        assert_eq!(claims["name"], serde_json::json!(subject));
        assert!(claims["names"]["basenames"]["default"].is_null());
        assert_eq!(claims["has_primary_name"], serde_json::json!(true));
        assert_eq!(
            primary_of(&enrichment),
            Some(("alice.base.eth".to_string(), "basename"))
        );
    }

    /// Primary selection precedence: **ENS > basename > UD > none**.
    #[test]
    fn primary_identity_prefers_ens_then_basename_then_ud_then_none() {
        assert_eq!(
            primary_identity(
                Some("alice.eth"),
                Some("alice.base.eth"),
                Some("alice.crypto")
            ),
            Some(("alice.eth", "ens")),
            "ENS wins over basename and UD"
        );
        assert_eq!(
            primary_identity(None, Some("alice.base.eth"), Some("alice.crypto")),
            Some(("alice.base.eth", "basename")),
            "basename used over UD when no ENS"
        );
        assert_eq!(
            primary_identity(None, Some("alice.base.eth"), None),
            Some(("alice.base.eth", "basename")),
            "basename used when only basename present"
        );
        assert_eq!(
            primary_identity(None, None, Some("alice.crypto")),
            Some(("alice.crypto", "ud")),
            "UD used when no ENS and no basename"
        );
        assert_eq!(
            primary_identity(Some("alice.eth"), None, None),
            Some(("alice.eth", "ens")),
            "ENS used when alone"
        );
        assert_eq!(
            primary_identity(None, None, None),
            None,
            "none when neither"
        );
    }

    /// `primary_of` selects the verified primary from the resolved enrichment
    /// (ENS preferred, then basename, else UD, else none) — what feeds
    /// `cv_identities`.
    #[test]
    fn primary_of_selects_ens_then_basename_then_ud_then_none() {
        // ENS wins over both a basename and a UD name.
        assert_eq!(
            primary_of(&Enrichment {
                ens: Some("alice.eth".to_string()),
                basename: Some("alice.base.eth".to_string()),
                ud: Some("alice.crypto".to_string()),
            }),
            Some(("alice.eth".to_string(), "ens"))
        );
        // No ENS ⇒ a basename is chosen over UD.
        assert_eq!(
            primary_of(&Enrichment {
                ens: None,
                basename: Some("alice.base.eth".to_string()),
                ud: Some("alice.crypto".to_string()),
            }),
            Some(("alice.base.eth".to_string(), "basename"))
        );
        // No ENS, no basename ⇒ UD.
        assert_eq!(
            primary_of(&Enrichment {
                ens: None,
                basename: None,
                ud: Some("bob.crypto".to_string()),
            }),
            Some(("bob.crypto".to_string(), "ud"))
        );
        assert_eq!(primary_of(&Enrichment::default()), None);
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

        let (claims, enrichment) = get_data(
            &eth,
            &cache,
            subject,
            "ethmail.cc",
            "cryptoverse.cc",
            false,
            true,
        )
        .await;
        assert_eq!(claims["name"], serde_json::json!(subject));
        // And the enrichment agrees there is no verified primary.
        assert_eq!(primary_of(&enrichment), None);
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
                    basename: None,
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
