//! The **wrapper** service.
//!
//! Two routes that render thin HTML shells, sitting between the gateway and
//! Hydra so the wallet code can run in the **top-level window** (see the iframe
//! split documented in `CLAUDE.md`):
//!
//! - `GET /oauth2/auth`  → `embed.html`: top page; loads `embed.js` and an
//!   `<iframe>` pointing at `/oauth2/inner` (the proxied Hydra authorize endpoint).
//! - `GET /oauth2/final` → `final.html`: completes the redirect back to the RP.
//!
//! This is a 1:1 Rust/axum port of the previous Python/Flask `wrapper.py`; the
//! Jinja templates are reused unchanged via minijinja.

use std::sync::Arc;

use axum::{
    extract::{RawQuery, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use minijinja::{context, Environment};

struct AppState {
    env: Environment<'static>,
    version: String,
    sentry_dsn: String,
    sentry_env: String,
}

/// Validate that `url` is an absolute `http`/`https` URL with a host, so it is
/// safe to hand to the templates as a redirect / iframe `src`. Both call sites
/// render it into a JS string literal via `tojson` (which prevents breakout),
/// and this rejects non-http(s) schemes (`javascript:`, `data:`, …) and
/// scheme-relative / relative values that could redirect somewhere unexpected.
///
/// The `url=` value may arrive percent-encoded, so we validate the decoded form.
fn is_safe_redirect(url: &str) -> bool {
    let decoded = percent_decode(url);
    match url::Url::parse(&decoded) {
        Ok(u) => matches!(u.scheme(), "http" | "https") && u.has_host(),
        Err(_) => false,
    }
}

/// Minimal percent-decoder (enough to validate a redirect target). Invalid
/// escapes are left as-is; this is for validation, not canonicalisation.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Derive the public `(host, scheme)` from the request as forwarded by the
/// TLS-terminating ingress (`X-Forwarded-Host` / `X-Forwarded-Proto`, falling
/// back to `Host` / `https`). No hardcoded domain, port, or scheme.
fn public_origin(headers: &HeaderMap) -> (String, String) {
    let first = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(',').next().unwrap_or(v).trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let host = first("x-forwarded-host")
        .or_else(|| first("host"))
        .unwrap_or_default();
    let scheme = first("x-forwarded-proto").unwrap_or_else(|| "https".to_string());
    (host, scheme)
}

#[tokio::main]
async fn main() {
    let _sentry = cryptoverse_core::telemetry::init_sentry();
    cryptoverse_core::telemetry::init_tracing();

    let mut env = Environment::new();
    env.add_template("embed.html", include_str!("../templates/embed.html"))
        .expect("embed.html");
    env.add_template("final.html", include_str!("../templates/final.html"))
        .expect("final.html");

    let state = Arc::new(AppState {
        env,
        version: cryptoverse_core::config::version(),
        sentry_dsn: cryptoverse_core::config::sentry_dsn().unwrap_or_default(),
        sentry_env: cryptoverse_core::config::sentry_env(),
    });

    let app = Router::new()
        .route("/oauth2/auth", get(embed))
        .route("/oauth2/final", get(final_page))
        .route("/healthz", get(|| async { "ok" }))
        .with_state(state);

    let port = cryptoverse_core::config::port();
    let addr = format!("0.0.0.0:{port}");
    tracing::info!("wrapper listening on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}

/// Top-level authorize page. Rewrites the incoming `/oauth2/auth?...` into an
/// `https://{host}/oauth2/inner?...` URL the iframe will load (the gateway maps
/// `/oauth2/inner` back to Hydra's real `/oauth2/auth`).
async fn embed(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let (host, scheme) = public_origin(&headers);

    let url = match query {
        Some(q) if !q.is_empty() => format!("{scheme}://{host}/oauth2/inner?{q}"),
        _ => format!("{scheme}://{host}/oauth2/inner"),
    };

    // The URL is built from the (trusted) forwarded origin, but validate it as a
    // defence-in-depth check — a malformed forwarded host shouldn't yield an
    // iframe `src` we can't vouch for.
    if !is_safe_redirect(&url) {
        tracing::warn!("embed: refusing to render unsafe iframe src `{url}`");
        return (StatusCode::BAD_REQUEST, "invalid request").into_response();
    }

    let tmpl = st.env.get_template("embed.html").expect("embed template");
    let body = tmpl
        .render(context! {
            url => url,
            version => st.version,
            sentry_dsn => st.sentry_dsn,
            sentry_env => st.sentry_env,
        })
        .expect("render embed");
    Html(body).into_response()
}

/// Final redirect page. The gateway rewrote Hydra's consent `Location` into
/// `/oauth2/final?url=<the original redirect>`. We strip the leading `url=` from
/// the raw query (the target URL carries its own `&`-separated params, so we
/// must not parse it as form data) and hand it to `final.js`.
async fn final_page(State(st): State<Arc<AppState>>, RawQuery(query): RawQuery) -> Response {
    let raw = query.unwrap_or_default();
    let url = raw.strip_prefix("url=").unwrap_or(&raw).to_string();

    // `url` is the redirect target the gateway placed in the query. Reject
    // anything that isn't an absolute http(s) URL (open-redirect / `javascript:`
    // protection) before handing it to `final.js` as a `window.location`.
    if !is_safe_redirect(&url) {
        tracing::warn!("final: refusing unsafe redirect target `{url}`");
        return (StatusCode::BAD_REQUEST, "invalid redirect").into_response();
    }

    let tmpl = st.env.get_template("final.html").expect("final template");
    let body = tmpl
        .render(context! {
            url => url,
            version => st.version,
            sentry_dsn => st.sentry_dsn,
            sentry_env => st.sentry_env,
        })
        .expect("render final");
    Html(body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_absolute_https_redirect() {
        assert!(is_safe_redirect(
            "https://demo.cryptoverse.cc/callback?code=abc&state=xyz"
        ));
        assert!(is_safe_redirect("http://localhost:8080/cb"));
    }

    #[test]
    fn accepts_percent_encoded_redirect() {
        // The gateway may percent-encode the `url=` value.
        assert!(is_safe_redirect(
            "https%3A%2F%2Fdemo.cryptoverse.cc%2Fcb%3Fcode%3Dabc"
        ));
    }

    #[test]
    fn rejects_dangerous_or_relative_redirects() {
        // Non-http(s) schemes and breakout attempts must be refused.
        assert!(!is_safe_redirect("javascript:alert(1)"));
        assert!(!is_safe_redirect(
            "data:text/html,<script>alert(1)</script>"
        ));
        assert!(!is_safe_redirect("//evil.example.com")); // scheme-relative
        assert!(!is_safe_redirect("/relative/path"));
        assert!(!is_safe_redirect("not a url"));
        assert!(!is_safe_redirect(""));
        // A value crafted to break out of the old `"{{ url|safe }}"` literal.
        assert!(!is_safe_redirect("\";alert(1);//"));
    }

    #[test]
    fn rejects_percent_encoded_javascript() {
        assert!(!is_safe_redirect("javascript%3Aalert(1)"));
    }
}
