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

    let body = AcceptConsent {
        grant_scope: req.requested_scope,
        grant_access_token_audience: req.requested_access_token_audience,
        session: ConsentSession {
            // No debug/placeholder claims in the issued access token. The
            // identity lives in the id_token; the access token carries no custom
            // claims unless a real need is added.
            access_token: serde_json::json!({}),
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
