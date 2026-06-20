//! The **login** service: ORY Hydra login & consent provider plus the SPA host.
//!
//! Routes:
//! - `GET  /login`         → render the SPA with challenge + SIWE params
//! - `POST /login/process` → verify EIP-4361 signature, token-gate, accept login
//! - `GET  /consent`       → auto-accept consent with an enriched ID token
//! - `GET  /---/metrics`   → Prometheus exposition (`login_status` counter, etc.)
//! - everything else       → static SPA assets (served from `STATIC_DIR`)
//!
//! Rust/axum port of the previous Node/Express backend.

mod restrictions;
mod routes;
mod user_data;

use std::sync::Arc;

use axum::{
    extract::State,
    routing::{get, post},
    Router,
};
use cryptoverse_core::{config, eth::Eth, hydra::Hydra, telemetry};
use metrics_exporter_prometheus::PrometheusHandle;
use minijinja::Environment;
use tower_http::{services::ServeDir, trace::TraceLayer};

pub struct AppState {
    pub hydra: Hydra,
    pub eth: Eth,
    pub templates: Environment<'static>,
    /// Domain used only for the user's profile/picture/website claims
    /// (`PROFILE_DOMAIN`); the IdP's own domain is derived per-request.
    pub profile_domain: String,
    pub mailserver_domain: String,
    pub statement: String,
    pub restrictions_file: String,
    pub metrics_handle: PrometheusHandle,
}

#[tokio::main]
async fn main() {
    let _sentry = telemetry::init_sentry();
    telemetry::init_tracing();
    let metrics_handle = telemetry::init_metrics();

    let hydra = Hydra::from_env().expect("HYDRA_ADMIN_URL must be set");
    let eth = Eth::from_env().expect("failed to build Ethereum provider");

    // The SPA `index.html` is a frontend build artifact (handed minijinja
    // placeholders). It is copied into the image at INDEX_TEMPLATE; load it at
    // startup. Absent in a bare `cargo run` without a frontend build.
    let index_path = config::var_or("INDEX_TEMPLATE", "templates/index.html");
    let mut templates = Environment::new();
    match std::fs::read_to_string(&index_path) {
        Ok(src) => templates
            .add_template_owned("index.html", src)
            .expect("failed to register index.html template"),
        Err(e) => tracing::warn!("index template `{index_path}` not loaded: {e}"),
    }

    let static_dir = config::var_or("STATIC_DIR", "public");

    let state = Arc::new(AppState {
        hydra,
        eth,
        templates,
        profile_domain: config::var_or("PROFILE_DOMAIN", "cryptoverse.cc"),
        mailserver_domain: config::var_or("MAILSERVER_DOMAIN", "ethmail.cc"),
        statement: config::var_or("SIWE_STATEMENT", "Sign in to Cryptoverse Login"),
        restrictions_file: config::var_or("RESTRICTIONS_FILE", "/config/restrictions.json"),
        metrics_handle,
    });

    let app = Router::new()
        .route("/login", get(routes::login::page))
        .route("/login/process", post(routes::login::process))
        .route("/consent", get(routes::consent::consent))
        .route("/---/metrics", get(metrics))
        .route("/healthz", get(|| async { "ok" }))
        .fallback_service(ServeDir::new(&static_dir))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port = config::port();
    let addr = format!("0.0.0.0:{port}");
    tracing::info!("login listening on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}

async fn metrics(State(st): State<Arc<AppState>>) -> String {
    st.metrics_handle.render()
}
