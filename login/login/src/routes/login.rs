//! The Hydra login provider: render the SPA, then verify the SIWE signature.
//!
//! Port of `backend/src/routes/login.ts`, with the custom signed message
//! replaced by EIP-4361 (see `cryptoverse_core::auth`).

use std::sync::Arc;

use alloy::primitives::Address;
use axum::{
    extract::{Form, Query, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    Json,
};
use cryptoverse_core::auth;
use minijinja::context;
use serde::Deserialize;

use super::count;
use crate::{restrictions, AppState};

#[derive(Debug, Deserialize)]
pub struct LoginQuery {
    pub login_challenge: Option<String>,
}

/// `GET /login` — fetch the Hydra login request and render the SPA shell with
/// the challenge, client metadata, restrictions and SIWE parameters.
pub async fn page(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<LoginQuery>,
) -> Response {
    count("login-init", "unknown");

    let Some(challenge) = q.login_challenge.filter(|c| !c.is_empty()) else {
        count("error-bad-request-login-init", "unknown");
        return (StatusCode::BAD_REQUEST, "Missing Param").into_response();
    };

    let login_req = match st.hydra.get_login_request(&challenge).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("get_login_request failed: {e}");
            count("error-during-init-error", "unknown");
            return (StatusCode::BAD_GATEWAY, "Hydra error").into_response();
        }
    };

    let client_id = login_req.client.client_id.clone();
    let metadata = &login_req.client.metadata;
    let title = metadata
        .get("app")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| client_id.clone());

    let restrictions =
        restrictions::get_restrictions(&login_req.client, &st.restrictions_file).await;

    let source_id = login_req
        .request_url
        .as_deref()
        .and_then(|u| query_param(u, "ac"))
        .unwrap_or_else(|| "default".to_string());

    let (host, scheme) = super::public_origin(&headers);
    let siwe = auth::SiweChallenge::new(&host, &scheme, &st.statement, &challenge);

    // Single JSON object the SPA reads from a `<script type="application/json">`
    // block (see frontend/services/loginProvider.ts). Embedding as data (not
    // executable JS) avoids any minifier/quoting hazards.
    let login_data = serde_json::json!({
        "challenge": challenge,
        "sourceId": source_id,
        "clientId": client_id.clone(),
        "siwe": serde_json::to_value(&siwe).unwrap_or(serde_json::Value::Null),
        "restrictions": serde_json::to_value(&restrictions).unwrap_or(serde_json::Value::Null),
        "metadata": metadata.clone(),
    });
    // Escape `<` so embedded values can't terminate the surrounding <script>.
    let login_data_json = serde_json::to_string(&login_data)
        .unwrap_or_else(|_| "{}".to_string())
        .replace('<', "\\u003c");

    let tmpl = match st.templates.get_template("index.html") {
        Ok(t) => t,
        Err(_) => {
            tracing::error!("index.html template not loaded; build the frontend");
            return (StatusCode::INTERNAL_SERVER_ERROR, "login UI not built").into_response();
        }
    };

    let body = match tmpl.render(context! {
        title => title,
        login_data => login_data_json,
    }) {
        Ok(b) => b,
        Err(e) => {
            tracing::error!("index render failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "render error").into_response();
        }
    };

    count("login-init-response", &client_id);
    Html(body).into_response()
}

#[derive(Debug, Deserialize)]
pub struct ProcessForm {
    pub challenge: String,
    /// The full EIP-4361 message the wallet signed.
    pub message: String,
    /// `0x`-prefixed 65-byte signature.
    pub signature: String,
    /// `"api"` → JSON `{redirect}`, otherwise an HTTP redirect.
    #[serde(default)]
    pub response: Option<String>,
}

/// `POST /login/process` — verify the SIWE signature, run token-gating, and
/// accept the Hydra login request with `subject = recovered address`.
pub async fn process(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Form(form): Form<ProcessForm>,
) -> Response {
    if form.challenge.is_empty() {
        count("error-missing-challenge", "unknown");
        return (StatusCode::BAD_REQUEST, "Missing Param").into_response();
    }

    let login_req = match st.hydra.get_login_request(&form.challenge).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("get_login_request failed: {e}");
            count("error-retrieving-hydra-request", "unknown");
            return (StatusCode::BAD_GATEWAY, "Hydra error").into_response();
        }
    };
    let client_id = login_req.client.client_id.clone();
    count("login-start", &client_id);

    let (host, _scheme) = super::public_origin(&headers);
    let verified =
        match auth::verify(&form.message, &form.signature, &host, &form.challenge).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("SIWE verification failed: {e}");
                count("error-siwe-verify", &client_id);
                return error_response(
                    &form.response,
                    StatusCode::UNAUTHORIZED,
                    &format!("Login error: {e}"),
                );
            }
        };
    let subject = verified.address;

    // Token-gating: `None` (or empty) means unrestricted.
    if let Some(rs) = restrictions::get_restrictions(&login_req.client, &st.restrictions_file).await
    {
        if !rs.is_empty() {
            let owner = match subject.parse::<Address>() {
                Ok(a) => a,
                Err(e) => {
                    tracing::error!("recovered address unparsable: {e}");
                    count("error-unknown", &client_id);
                    return (StatusCode::INTERNAL_SERVER_ERROR, "address error").into_response();
                }
            };
            let results = restrictions::check_restrictions(&st.eth, &rs, owner).await;
            if !results.iter().all(|r| r.passed) {
                tracing::warn!("restriction checks failed for {subject}");
                count("error-restricted", &client_id);
                let msg = format!(
                    "Your address fails conditions: {}",
                    serde_json::to_string(&results).unwrap_or_default()
                );
                return error_response(&form.response, StatusCode::FORBIDDEN, &msg);
            }
        }
    }

    match st.hydra.accept_login_request(&form.challenge, &subject).await {
        Ok(resp) => {
            tracing::info!("LOGIN {client_id} {subject}");
            count("success", &client_id);
            if form.response.as_deref() == Some("api") {
                Json(serde_json::json!({ "redirect": resp.redirect_to })).into_response()
            } else {
                Redirect::to(&resp.redirect_to).into_response()
            }
        }
        Err(e) => {
            tracing::error!("accept_login_request failed: {e}");
            count("error-unknown", &client_id);
            (StatusCode::BAD_GATEWAY, "Hydra error").into_response()
        }
    }
}

fn error_response(response: &Option<String>, status: StatusCode, message: &str) -> Response {
    if response.as_deref() == Some("api") {
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    } else {
        (status, message.to_string()).into_response()
    }
}

/// Extract a single (non-decoded) query parameter from a URL string.
fn query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_param_extracts_ac() {
        let u = "https://login.cryptoverse.cc/oauth2/auth?client_id=x&ac=demo&scope=openid";
        assert_eq!(query_param(u, "ac").as_deref(), Some("demo"));
        assert_eq!(query_param(u, "missing"), None);
    }
}
