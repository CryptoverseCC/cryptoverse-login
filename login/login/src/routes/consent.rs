//! The Hydra consent provider: auto-accept and attach the enriched ID token.
//!
//! Port of `backend/src/routes/consent.ts`.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
};
use cryptoverse_core::hydra::{AcceptConsent, ConsentSession};
use serde::Deserialize;

use super::count;
use crate::{user_data, AppState};

#[derive(Debug, Deserialize)]
pub struct ConsentQuery {
    pub consent_challenge: Option<String>,
}

/// `GET /consent` — auto-accept consent with the requested scope/audience and a
/// session whose `id_token` is built by `user_data::get_data`.
pub async fn consent(State(st): State<Arc<AppState>>, Query(q): Query<ConsentQuery>) -> Response {
    let Some(challenge) = q.consent_challenge.filter(|c| !c.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            "Expected a consent challenge to be set but received none.",
        )
            .into_response();
    };

    let req = match st.hydra.get_consent_request(&challenge).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("get_consent_request failed: {e}");
            count("consent-error-retrieving-hydra-request", "unknown");
            return (StatusCode::BAD_GATEWAY, "Hydra error").into_response();
        }
    };
    let client_id = req.client.client_id.clone();
    count("consent-start", &client_id);

    let id_token = user_data::get_data(
        &st.eth,
        &st.enrichment_cache,
        &req.subject,
        &st.mailserver_domain,
        &st.profile_domain,
        st.email_verified_claim,
    )
    .await;

    // Access-token claims. Lean by default (`{}`): a token without the `mail`
    // scope is byte-identical to the historical output. Only when the `mail`
    // scope is granted do we surface the verified primary name on the access
    // token as `cv_identities` (see `build_cv_identities`).
    let access_token = if req.requested_scope.iter().any(|s| s == "mail") {
        serde_json::json!({ "cv_identities": build_cv_identities(&id_token) })
    } else {
        serde_json::json!({})
    };

    let body = AcceptConsent {
        grant_scope: req.requested_scope,
        grant_access_token_audience: req.requested_access_token_audience,
        session: ConsentSession {
            access_token,
            id_token,
        },
    };

    match st.hydra.accept_consent_request(&challenge, &body).await {
        Ok(resp) => {
            count("consent-success", &client_id);
            Redirect::to(&resp.redirect_to).into_response()
        }
        Err(e) => {
            tracing::error!("accept_consent_request failed: {e}");
            count("consent-error", &client_id);
            (StatusCode::BAD_GATEWAY, "Hydra error").into_response()
        }
    }
}

/// Build the `cv_identities` object placed on the **access token** for the
/// `mail` scope — the ETHMail mail-stack contract (a Dovecot/Postfix relying
/// party reads the access token headlessly).
///
/// **Primary-only**: it surfaces the single verified primary name (ENS
/// preferred, else Unstoppable Domains, else `null`) that `get_data` already
/// resolved for the id_token — read back via [`user_data::primary_from_id_token`]
/// so there is **no second on-chain resolution**. `owned` is **always `null`**
/// for now: it's a tri-state where `null` means "not enumerated", signalling the
/// relying party to run its own ownership check for any non-primary name.
fn build_cv_identities(id_token: &serde_json::Value) -> serde_json::Value {
    let (primary_name, kind) = match user_data::primary_from_id_token(id_token) {
        Some((name, kind)) => (
            serde_json::Value::String(name),
            serde_json::Value::String(kind.to_string()),
        ),
        None => (serde_json::Value::Null, serde_json::Value::Null),
    };
    serde_json::json!({
        "primary_name": primary_name,
        "kind": kind,
        "chain_id": cryptoverse_core::auth::configured_chain_id(),
        "verified_at": time::OffsetDateTime::now_utc().unix_timestamp(),
        "owned": serde_json::Value::Null,
    })
}

#[cfg(test)]
mod tests {
    use super::build_cv_identities;
    use serde_json::json;

    /// A user WITH a verified ENS primary: `cv_identities` carries that name,
    /// `kind: "ens"`, a real epoch-seconds `verified_at`, and `owned: null`.
    #[test]
    fn cv_identities_for_ens_primary() {
        let id_token = json!({
            "names": {
                "ens": { "default": "alice.eth" },
                "unstoppabledomains": { "default": "alice.crypto" },
            }
        });
        let cv = build_cv_identities(&id_token);
        assert_eq!(cv["primary_name"], json!("alice.eth"));
        assert_eq!(cv["kind"], json!("ens"));
        assert_eq!(
            cv["chain_id"],
            json!(cryptoverse_core::auth::configured_chain_id())
        );
        assert!(cv["verified_at"].as_i64().expect("epoch seconds") > 1_700_000_000);
        assert_eq!(cv["owned"], serde_json::Value::Null);
    }

    /// UD-only primary surfaces with `kind: "ud"`.
    #[test]
    fn cv_identities_for_ud_primary() {
        let id_token = json!({
            "names": {
                "ens": { "default": serde_json::Value::Null },
                "unstoppabledomains": { "default": "bob.crypto" },
            }
        });
        let cv = build_cv_identities(&id_token);
        assert_eq!(cv["primary_name"], json!("bob.crypto"));
        assert_eq!(cv["kind"], json!("ud"));
        assert_eq!(cv["owned"], serde_json::Value::Null);
    }

    /// A user WITHOUT any verified primary (the test-account case): both
    /// `primary_name` and `kind` are `null`; the metadata fields still populate.
    #[test]
    fn cv_identities_for_no_primary() {
        let id_token = json!({
            "names": {
                "ens": { "default": serde_json::Value::Null },
                "unstoppabledomains": { "default": serde_json::Value::Null },
            }
        });
        let cv = build_cv_identities(&id_token);
        assert_eq!(cv["primary_name"], serde_json::Value::Null);
        assert_eq!(cv["kind"], serde_json::Value::Null);
        assert_eq!(cv["owned"], serde_json::Value::Null);
        assert!(cv["verified_at"].as_i64().is_some());
    }
}
