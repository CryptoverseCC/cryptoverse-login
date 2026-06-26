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

    // The verified ENS/UD human-readable name is released into the standard OIDC
    // claims only when the `profile` scope is granted (it is real-world-linkable
    // identity). The address-derived synthetic claims always populate. The
    // resolved `enrichment` is returned regardless so `cv_identities` (its own
    // `mail` grant) still carries the verified name even without `profile`.
    let profile = req.requested_scope.iter().any(|s| s == "profile");
    let (mut id_token, enrichment) = user_data::get_data(
        &st.eth,
        &st.enrichment_cache,
        &req.subject,
        &st.mailserver_domain,
        &st.profile_domain,
        st.email_verified_claim,
        profile,
    )
    .await;

    // `cv_identities` placement is gated on the `mail` scope. For a non-mail
    // client neither token carries it: the access token stays `{}` and the
    // id_token keeps only the (scope-gated) standard claims. When `mail` is
    // granted we build the object **once** from the verified primary already
    // resolved (the returned `enrichment` — no second on-chain call) and attach
    // the *same* value to both the id_token claims (so it also appears in Hydra's
    // `/userinfo`) and the access token (Hydra nests that under the token's `ext`).
    let access_token = if req.requested_scope.iter().any(|s| s == "mail") {
        let cv_identities = build_cv_identities(&req.subject, user_data::primary_of(&enrichment));
        if let Some(obj) = id_token.as_object_mut() {
            obj.insert("cv_identities".to_string(), cv_identities.clone());
        }
        serde_json::json!({ "cv_identities": cv_identities })
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

/// Build the `cv_identities` object (schema `cv_identities/v1`) for the `mail`
/// scope — the ETHMail mail-stack contract. The same value is attached to both
/// the id_token claims and the access token by the consent handler.
///
/// Shape is **nested**: `primary_name` is an OBJECT carrying the verified name
/// plus its per-name `kind` / `chain_id` / `verified_at`, or `null` when there
/// is no forward-verified primary (the test-account case). `primary` is the
/// single verified name (ENS preferred, else Unstoppable Domains) resolved from
/// the enrichment `get_data` already produced (via [`user_data::primary_of`]) —
/// so there is **no second on-chain resolution**, and it is carried under the
/// `mail` grant even when the standard `name` claim was `profile`-gated away.
/// `owned` is **always `null`** for now: a tri-state where `null` means "not
/// enumerated", signalling the relying party to run its own ownership check for
/// any non-primary name.
fn build_cv_identities(
    subject: &str,
    primary: Option<(String, &'static str)>,
) -> serde_json::Value {
    let primary_name = match primary {
        Some((name, kind)) => serde_json::json!({
            "name": name,
            "kind": kind,
            "chain_id": cryptoverse_core::auth::configured_chain_id(),
            "verified_at": time::OffsetDateTime::now_utc().unix_timestamp(),
        }),
        None => serde_json::Value::Null,
    };
    serde_json::json!({
        "schema": "cv_identities/v1",
        "address": subject,
        "primary_name": primary_name,
        "owned": serde_json::Value::Null,
    })
}

#[cfg(test)]
mod tests {
    use super::build_cv_identities;
    use serde_json::json;

    const SUBJECT: &str = "0x000000000000000000000000000000000000dead";

    /// A user WITH a verified ENS primary: `cv_identities` carries the
    /// `cv_identities/v1` schema, the subject `address`, and a nested
    /// `primary_name` object with the name, `kind: "ens"`, the configured
    /// `chain_id`, and a real epoch-seconds `verified_at`. `owned` is `null`.
    #[test]
    fn cv_identities_for_ens_primary() {
        let cv = build_cv_identities(SUBJECT, Some(("alice.eth".to_string(), "ens")));
        assert_eq!(cv["schema"], json!("cv_identities/v1"));
        assert_eq!(cv["address"], json!(SUBJECT));
        assert_eq!(cv["owned"], serde_json::Value::Null);

        let primary = &cv["primary_name"];
        assert_eq!(primary["name"], json!("alice.eth"));
        assert_eq!(primary["kind"], json!("ens"));
        assert_eq!(
            primary["chain_id"],
            json!(cryptoverse_core::auth::configured_chain_id())
        );
        assert!(primary["verified_at"].as_i64().expect("epoch seconds") > 1_700_000_000);
    }

    /// UD-only primary surfaces inside the nested object with `kind: "ud"`.
    #[test]
    fn cv_identities_for_ud_primary() {
        let cv = build_cv_identities(SUBJECT, Some(("bob.crypto".to_string(), "ud")));
        assert_eq!(cv["schema"], json!("cv_identities/v1"));
        assert_eq!(cv["address"], json!(SUBJECT));
        assert_eq!(cv["primary_name"]["name"], json!("bob.crypto"));
        assert_eq!(cv["primary_name"]["kind"], json!("ud"));
        assert_eq!(cv["owned"], serde_json::Value::Null);
    }

    /// A user WITHOUT any verified primary (the test-account case): the whole
    /// `primary_name` is `null`; `schema`/`address`/`owned` still populate.
    #[test]
    fn cv_identities_for_no_primary() {
        let cv = build_cv_identities(SUBJECT, None);
        assert_eq!(cv["schema"], json!("cv_identities/v1"));
        assert_eq!(cv["address"], json!(SUBJECT));
        assert_eq!(cv["primary_name"], serde_json::Value::Null);
        assert_eq!(cv["owned"], serde_json::Value::Null);
    }

    /// The consent handler's placement contract: under the `mail` scope the
    /// **same** `cv_identities` object is injected into the id_token claims
    /// **and** set on the access token; under a non-mail scope neither token
    /// carries it (the id_token stays byte-identical to `get_data`'s output).
    ///
    /// This mirrors the in-handler logic (build once, attach to both) without a
    /// live Hydra: it exercises exactly the scope branch the handler runs.
    #[test]
    fn mail_scope_injects_into_both_tokens() {
        let base_id_token = json!({ "sub": SUBJECT, "name": SUBJECT });

        // --- mail scope: inject the same cv_identities into both ---
        let mut id_token = base_id_token.clone();
        let cv = build_cv_identities(SUBJECT, Some(("alice.eth".to_string(), "ens")));
        id_token
            .as_object_mut()
            .unwrap()
            .insert("cv_identities".to_string(), cv.clone());
        let access_token = json!({ "cv_identities": cv });

        assert_eq!(
            id_token["cv_identities"]["schema"],
            json!("cv_identities/v1")
        );
        assert_eq!(
            id_token["cv_identities"]["primary_name"]["name"],
            json!("alice.eth")
        );
        // Same value on both sessions.
        assert_eq!(id_token["cv_identities"], access_token["cv_identities"]);

        // --- non-mail scope: id_token untouched, access token empty ---
        let non_mail_id_token = base_id_token.clone();
        let non_mail_access_token = json!({});
        assert!(non_mail_id_token.get("cv_identities").is_none());
        assert_eq!(non_mail_id_token, base_id_token);
        assert_eq!(non_mail_access_token, json!({}));
    }
}
