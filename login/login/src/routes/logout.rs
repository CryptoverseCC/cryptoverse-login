//! The RP-initiated **logout** provider (`urls.logout`).
//!
//! When a relying party redirects the user to Hydra's end-session endpoint
//! (`/oauth2/sessions/logout`) with an `id_token_hint`, Hydra validates it and
//! 302-redirects the browser to **our** logout page with a one-time
//! `logout_challenge`. We accept it and follow Hydra's `redirect_to`, which
//! clears the session, fires back-/front-channel logout to the clients, and lands
//! on the post-logout redirect.
//!
//! Auto-accept is safe: the `logout_challenge` is the capability — Hydra only
//! mints one after validating the RP's `id_token_hint`, so an attacker cannot
//! forge one to force-logout a victim. Server-rendered, no wallet/JS.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
};
use serde::Deserialize;

use super::count;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct LogoutQuery {
    pub logout_challenge: Option<String>,
}

/// `GET /logout` — accept the logout request and follow Hydra's redirect.
pub async fn page(State(st): State<Arc<AppState>>, Query(q): Query<LogoutQuery>) -> Response {
    count("logout-start", "unknown");

    let Some(challenge) = q.logout_challenge.filter(|c| !c.is_empty()) else {
        count("error-bad-request-logout", "unknown");
        return (
            StatusCode::BAD_REQUEST,
            "Missing logout_challenge. Start sign-out from the application.",
        )
            .into_response();
    };

    match st.hydra.accept_logout_request(&challenge).await {
        Ok(resp) => {
            count("logout-accept", "unknown");
            Redirect::to(&resp.redirect_to).into_response()
        }
        Err(e) => {
            tracing::error!("accept_logout_request failed: {e}");
            count("logout-error", "unknown");
            (StatusCode::BAD_GATEWAY, "Logout service error").into_response()
        }
    }
}
