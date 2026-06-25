//! The RFC 8628 **device authorization grant** verification page.
//!
//! Hydra owns the device-code lifecycle (`/oauth2/device/auth`, the token
//! polling, and `/oauth2/device/verify`). When the user opens
//! `/oauth2/device/verify`, Hydra mints an encrypted `device_challenge` and
//! 302-redirects the browser to **our** `urls.device.verification` page with
//! `?device_challenge=...`. This module renders that page: it collects the
//! `user_code` and calls the admin **accept**, which returns a `redirect_to`
//! that enters the standard login → consent pipeline (our existing `/login` +
//! `/consent` routes, reused unchanged). After consent the browser lands on
//! `urls.device.success` and the device's token polling returns tokens.
//!
//! This page is **server-rendered** and needs no wallet/JS — the wallet step
//! happens later on the branded `/login` SPA.

use std::sync::Arc;

use axum::{
    extract::{Form, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Redirect, Response},
};
use minijinja::context;
use serde::Deserialize;

use super::count;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct DeviceQuery {
    /// The encrypted challenge Hydra issued on the redirect from
    /// `/oauth2/device/verify`. Required — without it there is nothing to accept.
    pub device_challenge: Option<String>,
    /// Optional `user_code`, present when the user followed the
    /// `verification_uri_complete` (the code is pre-filled and auto-submitted).
    #[serde(default)]
    pub user_code: Option<String>,
}

/// `GET /device` — render the code-entry page. Requires `device_challenge`
/// (400 if absent); pre-fills + auto-submits when a `user_code` is supplied.
pub async fn page(State(st): State<Arc<AppState>>, Query(q): Query<DeviceQuery>) -> Response {
    count("device-verify-init", "unknown");

    let Some(device_challenge) = q.device_challenge.filter(|c| !c.is_empty()) else {
        count("error-bad-request-device-init", "unknown");
        return (
            StatusCode::BAD_REQUEST,
            "Missing device_challenge. Open the verification link shown on your device.",
        )
            .into_response();
    };

    let user_code = q.user_code.unwrap_or_default();
    // One-click path: a non-empty pre-filled code (from verification_uri_complete)
    // auto-submits the form.
    let auto_submit = !user_code.is_empty();

    render_device(
        &st,
        StatusCode::OK,
        &device_challenge,
        &user_code,
        auto_submit,
        None,
    )
}

#[derive(Debug, Deserialize)]
pub struct ProcessForm {
    pub device_challenge: String,
    #[serde(default)]
    pub user_code: String,
}

/// `POST /device` — accept the device request with the submitted `user_code`.
/// On success Hydra returns a `redirect_to` into the standard login pipeline. A
/// Hydra 4xx (bad/expired code) re-renders the page with an inline error so the
/// user can retype.
pub async fn process(State(st): State<Arc<AppState>>, Form(form): Form<ProcessForm>) -> Response {
    if form.device_challenge.is_empty() {
        count("error-bad-request-device-init", "unknown");
        return (StatusCode::BAD_REQUEST, "Missing device_challenge.").into_response();
    }

    let user_code = form.user_code.trim();
    if user_code.is_empty() {
        return render_device(
            &st,
            StatusCode::BAD_REQUEST,
            &form.device_challenge,
            "",
            false,
            Some("Please enter the code shown on your device."),
        );
    }

    match st
        .hydra
        .accept_device_request(&form.device_challenge, user_code)
        .await
    {
        Ok(resp) => {
            count("device-verify-accept", "unknown");
            Redirect::to(&resp.redirect_to).into_response()
        }
        Err(e) => {
            tracing::warn!("accept_device_request failed: {e}");
            count("device-verify-error", "unknown");
            // A Hydra 4xx means the user_code was wrong/expired — re-render so
            // the user can retype. Transport/5xx is a genuine upstream error.
            if let Some((status, msg)) = device_hydra_error(&e) {
                return render_device(
                    &st,
                    status,
                    &form.device_challenge,
                    user_code,
                    false,
                    Some(msg),
                );
            }
            (StatusCode::BAD_GATEWAY, "Authentication service error").into_response()
        }
    }
}

/// `GET /device/success` — a tiny terminal page for `urls.device.success`.
pub async fn success(State(st): State<Arc<AppState>>) -> Response {
    match st.templates.get_template("device_success.html") {
        Ok(tmpl) => match tmpl.render(context! {}) {
            Ok(body) => Html(body).into_response(),
            Err(e) => {
                tracing::error!("device_success render failed: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "render error").into_response()
            }
        },
        Err(_) => {
            // Fallback so success never 500s even if the template is missing.
            Html("<!DOCTYPE html><title>Signed in</title><p>You're signed in. You can return to your device or app.</p>")
                .into_response()
        }
    }
}

/// Map a Hydra admin-call failure to an inline-error status + message when it is
/// a client error (bad/expired `user_code`). Returns `None` for transport errors
/// or Hydra 5xx, which the caller turns into a 502.
fn device_hydra_error(err: &anyhow::Error) -> Option<(StatusCode, &'static str)> {
    let re = err.downcast_ref::<reqwest::Error>()?;
    let status = re.status()?;
    if status.is_client_error() {
        Some((
            StatusCode::BAD_REQUEST,
            "That code is invalid or has expired. Check your device and try again.",
        ))
    } else {
        None
    }
}

/// Render `device.html` with the given fields, returned under `status`. `error`
/// is shown inline so the user can retype an invalid code.
fn render_device(
    st: &AppState,
    status: StatusCode,
    device_challenge: &str,
    user_code: &str,
    auto_submit: bool,
    error: Option<&str>,
) -> Response {
    let tmpl = match st.templates.get_template("device.html") {
        Ok(t) => t,
        Err(_) => {
            tracing::error!("device.html template not loaded");
            return (StatusCode::INTERNAL_SERVER_ERROR, "device UI not built").into_response();
        }
    };
    let body = match tmpl.render(context! {
        title => "Device sign-in",
        device_challenge => device_challenge,
        user_code => user_code,
        auto_submit => auto_submit,
        error => error,
    }) {
        Ok(b) => b,
        Err(e) => {
            tracing::error!("device render failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "render error").into_response();
        }
    };
    (status, Html(body)).into_response()
}
