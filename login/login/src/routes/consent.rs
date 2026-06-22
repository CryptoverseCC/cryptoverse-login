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
            return (StatusCode::BAD_GATEWAY, "Hydra error").into_response();
        }
    };

    let id_token = user_data::get_data(
        &st.eth,
        &req.subject,
        &st.mailserver_domain,
        &st.profile_domain,
    )
    .await;

    let body = AcceptConsent {
        grant_scope: req.requested_scope,
        grant_access_token_audience: req.requested_access_token_audience,
        session: ConsentSession {
            access_token: serde_json::json!({ "some_custom_claim": "some_custom_value" }),
            id_token,
        },
    };

    match st.hydra.accept_consent_request(&challenge, &body).await {
        Ok(resp) => Redirect::to(&resp.redirect_to).into_response(),
        Err(e) => {
            tracing::error!("accept_consent_request failed: {e}");
            (StatusCode::BAD_GATEWAY, "Hydra error").into_response()
        }
    }
}
