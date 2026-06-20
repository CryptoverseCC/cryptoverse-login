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
    http::HeaderMap,
    response::Html,
    routing::get,
    Router,
};
use minijinja::{context, Environment};

struct AppState {
    env: Environment<'static>,
    version: String,
    sentry_dsn: String,
    sentry_env: String,
    domain: String,
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
        domain: cryptoverse_core::config::domain(),
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
) -> Html<String> {
    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or(&st.domain);

    let url = match query {
        Some(q) if !q.is_empty() => format!("https://{host}/oauth2/inner?{q}"),
        _ => format!("https://{host}/oauth2/inner"),
    };

    let tmpl = st.env.get_template("embed.html").expect("embed template");
    let body = tmpl
        .render(context! {
            url => url,
            version => st.version,
            sentry_dsn => st.sentry_dsn,
            sentry_env => st.sentry_env,
        })
        .expect("render embed");
    Html(body)
}

/// Final redirect page. The gateway rewrote Hydra's consent `Location` into
/// `/oauth2/final?url=<the original redirect>`. We strip the leading `url=` from
/// the raw query (the target URL carries its own `&`-separated params, so we
/// must not parse it as form data) and hand it to `final.js`.
async fn final_page(State(st): State<Arc<AppState>>, RawQuery(query): RawQuery) -> Html<String> {
    let raw = query.unwrap_or_default();
    let url = raw.strip_prefix("url=").unwrap_or(&raw).to_string();

    let tmpl = st.env.get_template("final.html").expect("final template");
    let body = tmpl
        .render(context! {
            url => url,
            version => st.version,
            sentry_dsn => st.sentry_dsn,
            sentry_env => st.sentry_env,
        })
        .expect("render final");
    Html(body)
}
