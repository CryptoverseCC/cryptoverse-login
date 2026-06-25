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
    let siwe = auth::SiweChallenge::new(&host, &scheme, &st.statement, &challenge, st.chain_id);

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
        "walletConnectProjectId": st.wallet_connect_project_id.clone(),
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

    let (host, scheme) = super::public_origin(&headers);
    // `&st.eth` is threaded in so SIWE verification can fall back from the EOA
    // (EIP-191) path to on-chain ERC-1271 / ERC-6492 validation for smart-contract
    // and counterfactual wallets (e.g. Coinbase Smart Wallet).
    let verified = match auth::verify(
        &form.message,
        &form.signature,
        &host,
        &scheme,
        st.chain_id,
        &form.challenge,
        &st.eth,
    )
    .await
    {
        Ok(v) => v,
        // A genuinely invalid / expired / wrong-field signature → 401, terminal.
        Err(
            e @ (auth::AuthError::Parse(_)
            | auth::AuthError::Signature(_)
            | auth::AuthError::Domain { .. }
            | auth::AuthError::Field(_)
            | auth::AuthError::Time(_)
            | auth::AuthError::Verify(_)),
        ) => {
            tracing::warn!("SIWE verification failed: {e}");
            count("error-siwe-verify", &client_id);
            return error_response(
                &form.response,
                StatusCode::UNAUTHORIZED,
                &format!("Login error: {e}"),
            );
        }
        // We couldn't reach the RPC to validate a contract-wallet signature, so
        // validity is unknown. This is NOT a forgery — surface a distinct,
        // retryable 503 so a Safe / smart-account user can try again rather than
        // see a misleading "invalid signature" 401.
        Err(auth::AuthError::RpcUnavailable(e)) => {
            tracing::warn!("SIWE verification could not reach RPC: {e}");
            count("error-siwe-rpc-unavailable", &client_id);
            return error_response(
                &form.response,
                StatusCode::SERVICE_UNAVAILABLE,
                "Couldn't verify your wallet right now. Please try again.",
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
                // Log the full detail (conditions + on-chain balances) server-side
                // only — never serialise the user's balances back to the browser.
                tracing::warn!(
                    "restriction checks failed for {subject}: {}",
                    serde_json::to_string(&results).unwrap_or_default()
                );
                count("error-restricted", &client_id);
                // Return only the per-restriction messages of the failing checks
                // (or a generic line if none carry a message).
                let messages: Vec<String> = results
                    .iter()
                    .filter(|r| !r.passed)
                    .filter_map(|r| r.message.clone())
                    .collect();
                let msg = if messages.is_empty() {
                    "Your address does not meet the requirements to log in.".to_string()
                } else {
                    messages.join(" ")
                };
                return error_response(&form.response, StatusCode::FORBIDDEN, &msg);
            }
        }
    }

    match st
        .hydra
        .accept_login_request(&form.challenge, &subject)
        .await
    {
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
            hydra_error_response(&e)
        }
    }
}

/// Map a Hydra admin-call failure to a sensible HTTP status, instead of
/// collapsing everything to 502. A 4xx from Hydra means *our request* was bad
/// (e.g. the challenge was already used / expired → 409, other 4xx → 400); a
/// transport error or 5xx means Hydra itself is the problem → 502.
fn hydra_error_response(err: &anyhow::Error) -> Response {
    if let Some(re) = err.downcast_ref::<reqwest::Error>() {
        if let Some(status) = re.status() {
            if status.is_client_error() {
                // 409/410 typically mean the one-time challenge is gone.
                if status == reqwest::StatusCode::CONFLICT
                    || status == reqwest::StatusCode::GONE
                    || status == reqwest::StatusCode::NOT_FOUND
                {
                    return (
                        StatusCode::CONFLICT,
                        "This login request is no longer valid. Please start again.",
                    )
                        .into_response();
                }
                return (StatusCode::BAD_REQUEST, "Invalid login request.").into_response();
            }
        }
    }
    // Transport error, timeout, or Hydra 5xx → upstream is unavailable.
    (StatusCode::BAD_GATEWAY, "Authentication service error").into_response()
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
