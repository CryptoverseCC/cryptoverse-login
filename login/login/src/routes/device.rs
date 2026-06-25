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
    http::{
        header::{CONTENT_SECURITY_POLICY, ORIGIN, X_FRAME_OPTIONS},
        HeaderMap, HeaderValue, StatusCode,
    },
    response::{Html, IntoResponse, Redirect, Response},
};
use minijinja::context;
use serde::Deserialize;

use super::{count, public_origin};
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct DeviceQuery {
    /// The encrypted challenge Hydra issued on the redirect from
    /// `/oauth2/device/verify`. Required — without it there is nothing to accept.
    pub device_challenge: Option<String>,
    /// Optional `user_code`, present when the user followed the
    /// `verification_uri_complete` link (the code is pre-filled for the user to
    /// confirm — never auto-submitted, so a lured link can't bind a code without
    /// an explicit click; see the `process` CSRF note).
    #[serde(default)]
    pub user_code: Option<String>,
}

/// `GET /device` — render the code-entry page. Requires `device_challenge`
/// (400 if absent); pre-fills the `user_code` when supplied (the user still
/// submits explicitly).
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

    // The code from `verification_uri_complete` is pre-filled for convenience, but
    // the user must explicitly submit it — RFC 8628 §3.3.1: the verification page
    // is a deliberate human confirmation that a device may act as them. Never
    // auto-submit; that would let a lured link silently approve a device code.
    let user_code = q.user_code.unwrap_or_default();

    render_device(&st, StatusCode::OK, &device_challenge, &user_code, None)
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
pub async fn process(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Form(form): Form<ProcessForm>,
) -> Response {
    // CSRF: a cross-site form auto-POST would otherwise silently bind an
    // attacker's device code to the victim's about-to-happen wallet login. Reject
    // when the browser's `Origin` doesn't match our own forwarded host. (The
    // explicit-submit page + anti-frame headers are the backstop for clients that
    // send no Origin.)
    if !origin_allowed(&headers) {
        count("error-device-csrf", "unknown");
        return (StatusCode::FORBIDDEN, "Cross-site request blocked.").into_response();
    }

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
                return render_device(&st, status, &form.device_challenge, user_code, Some(msg));
            }
            (StatusCode::BAD_GATEWAY, "Authentication service error").into_response()
        }
    }
}

/// `GET /device/success` — a tiny terminal page for `urls.device.success`.
pub async fn success(State(st): State<Arc<AppState>>) -> Response {
    match st.templates.get_template("device_success.html") {
        Ok(tmpl) => match tmpl.render(context! {}) {
            Ok(body) => no_frame(Html(body).into_response()),
            Err(e) => {
                tracing::error!("device_success render failed: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "render error").into_response()
            }
        },
        Err(_) => {
            // Fallback so success never 500s even if the template is missing.
            no_frame(
                Html("<!DOCTYPE html><title>Signed in</title><p>You're signed in. You can return to your device or app.</p>")
                    .into_response(),
            )
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
        error => error,
    }) {
        Ok(b) => b,
        Err(e) => {
            tracing::error!("device render failed: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "render error").into_response();
        }
    };
    no_frame((status, Html(body)).into_response())
}

/// Attach anti-framing headers. The device verification/success pages are
/// standalone and must never be embedded (clickjacking the confirm button);
/// scoped to these handlers so the deliberately-iframed `/login` SPA is untouched.
fn no_frame(mut resp: Response) -> Response {
    let headers = resp.headers_mut();
    headers.insert(X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("frame-ancestors 'none'"),
    );
    resp
}

/// CSRF check for `POST /device`: when the browser sends an `Origin`, require its
/// host to match the IdP's own forwarded host, rejecting a cross-site auto-POST
/// that would silently bind a device code to the victim. A request with no Origin
/// (non-browser client / curl harness) is allowed — modern browsers always send
/// Origin on a cross-site POST, and the explicit-submit page + anti-frame headers
/// cover the rest. Host-only comparison (the ingress may differ on scheme/port
/// between the Origin and the forwarded host).
fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let host_only = |s: &str| -> String {
        let authority = s.split("://").last().unwrap_or(s);
        let authority = authority.split('/').next().unwrap_or(authority);
        authority
            .rsplit_once(':')
            .map(|(h, _)| h)
            .unwrap_or(authority)
            .to_ascii_lowercase()
    };
    let (forwarded_host, _scheme) = public_origin(headers);
    !forwarded_host.is_empty() && host_only(origin) == host_only(&forwarded_host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header::HOST, HeaderName};

    fn hm(pairs: &[(HeaderName, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(k.clone(), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn origin_allowed_when_absent() {
        // Non-browser client (curl harness/CLI) sends no Origin → allowed.
        assert!(origin_allowed(&hm(&[(HOST, "login.example")])));
    }

    #[test]
    fn origin_allowed_same_host_ignoring_port_and_scheme() {
        assert!(origin_allowed(&hm(&[
            (HOST, "login.example:9443"),
            (ORIGIN, "https://login.example:9443"),
        ])));
        // Forwarded host without a port still matches an Origin that carries one.
        assert!(origin_allowed(&hm(&[
            (HOST, "login.example"),
            (ORIGIN, "https://login.example:9443"),
        ])));
    }

    #[test]
    fn origin_rejected_cross_site_or_opaque() {
        assert!(!origin_allowed(&hm(&[
            (HOST, "login.example"),
            (ORIGIN, "https://evil.com"),
        ])));
        // An opaque/"null" Origin (sandboxed iframe) is rejected.
        assert!(!origin_allowed(&hm(&[
            (HOST, "login.example"),
            (ORIGIN, "null"),
        ])));
    }
}
