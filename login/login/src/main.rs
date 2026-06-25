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
    extract::{Request, State},
    http::header::{HeaderValue, CACHE_CONTROL},
    middleware::Next,
    response::Response,
    routing::{get, post},
    Router,
};
use cryptoverse_core::{config, eth::Eth, hydra::Hydra, telemetry};
use metrics_exporter_prometheus::PrometheusHandle;
use minijinja::Environment;
use tower::ServiceBuilder;
use tower_governor::{
    governor::GovernorConfigBuilder, key_extractor::SmartIpKeyExtractor, GovernorLayer,
};
use tower_http::{services::ServeDir, trace::TraceLayer};

/// `Cache-Control` for Vite content-hashed assets (hashed JS/CSS, `*.woff2`
/// fonts): the filename changes whenever the bytes do, so they're safe to cache
/// forever and skip revalidation.
const CACHE_IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// `Cache-Control` for the two stable-name entrypoints (`embed.js`/`final.js`):
/// the URL is fixed but the bytes change per deploy, so the browser must
/// revalidate (a 304 when unchanged) rather than serve a stale module.
const CACHE_NO_CACHE: &str = "no-cache";

/// True if `path` is a Vite content-hashed asset whose name encodes its bytes.
/// Hashed bundles live under `/login/static/` (JS/CSS) with a `-<hash>` or
/// `.<hash>` infix, and fonts are emitted as `*.woff2`. The two **unhashed**
/// entrypoints `embed.js`/`final.js` (stable names) are deliberately excluded.
fn is_hashed_asset(path: &str) -> bool {
    if path.ends_with("/embed.js") || path.ends_with("/final.js") {
        return false;
    }
    path.ends_with(".woff2") || path.ends_with(".js") || path.ends_with(".css")
}

/// Adds a `Cache-Control` header to static-asset responses based on the request
/// path: long-lived `immutable` for content-hashed assets, `no-cache` for the
/// stable-name entrypoints. Only sets the header when it isn't already present
/// and only for successful responses, so error pages and the SPA index (served
/// by the `/login` route, not this middleware) are untouched.
async fn cache_control(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let mut resp = next.run(req).await;

    if !resp.status().is_success() || resp.headers().contains_key(CACHE_CONTROL) {
        return resp;
    }

    let policy = if is_hashed_asset(&path) {
        CACHE_IMMUTABLE
    } else if path.ends_with("/embed.js") || path.ends_with("/final.js") {
        CACHE_NO_CACHE
    } else {
        return resp;
    };
    resp.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(policy));
    resp
}

pub struct AppState {
    pub hydra: Hydra,
    pub eth: Eth,
    /// TTL cache of per-address ENS/UD enrichment, shared across requests so
    /// repeat logins for the same address skip the on-chain reverse lookups.
    pub enrichment_cache: user_data::EnrichmentCache,
    pub templates: Environment<'static>,
    /// Domain used only for the user's profile/picture/website claims
    /// (`PROFILE_DOMAIN`); the IdP's own domain is derived per-request.
    pub profile_domain: String,
    pub mailserver_domain: String,
    pub statement: String,
    /// SIWE chain id (`SIWE_CHAIN_ID`, default mainnet). Issued to the frontend
    /// (`loginData.siwe.chainId`) and enforced in `auth::verify`.
    pub chain_id: u64,
    /// Value of the OIDC `email_verified` claim (`EMAIL_VERIFIED_CLAIM`, default
    /// `false`). The synthetic `{address}@{MAILSERVER_DOMAIN}` mailbox is not a
    /// verified inbox; only set this when a real, delivering mailserver backs it.
    pub email_verified_claim: bool,
    /// WalletConnect Cloud / Reown project id forwarded to the SPA so it can
    /// offer the WalletConnect connector. Empty when unset (the connector is
    /// then omitted; injected wallets still work). No key is hardcoded.
    pub wallet_connect_project_id: String,
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

    // The device-flow (RFC 8628) verification pages are server-rendered and
    // bundled into the binary (no ConfigMap/volume needed), so they're always
    // available regardless of the frontend build.
    templates
        .add_template("device.html", include_str!("../templates/device.html"))
        .expect("failed to register device.html template");
    templates
        .add_template(
            "device_success.html",
            include_str!("../templates/device_success.html"),
        )
        .expect("failed to register device_success.html template");

    let static_dir = config::var_or("STATIC_DIR", "public");

    let state = Arc::new(AppState {
        hydra,
        eth,
        enrichment_cache: user_data::EnrichmentCache::new(),
        templates,
        profile_domain: config::var_or("PROFILE_DOMAIN", "cryptoverse.cc"),
        mailserver_domain: config::var_or("MAILSERVER_DOMAIN", "ethmail.cc"),
        statement: config::var_or("SIWE_STATEMENT", "Sign in to Cryptoverse Login"),
        chain_id: cryptoverse_core::auth::configured_chain_id(),
        email_verified_claim: config::var_or("EMAIL_VERIFIED_CLAIM", "false")
            .eq_ignore_ascii_case("true"),
        wallet_connect_project_id: config::var_or("WALLETCONNECT_PROJECT_ID", ""),
        restrictions_file: config::var_or("RESTRICTIONS_FILE", "/config/restrictions.json"),
        metrics_handle,
    });

    // Static SPA assets, with a `Cache-Control` policy applied per request path
    // (immutable for hashed assets, no-cache for the stable entrypoints). The
    // middleware is scoped to this service so the API/SPA-index routes above are
    // untouched.
    let static_service = ServiceBuilder::new()
        .layer(axum::middleware::from_fn(cache_control))
        .service(ServeDir::new(&static_dir));

    // Per-client rate limit on the credential-bearing POSTs (`/login/process`,
    // which fires eth_calls, and the device-flow accept `POST /device`). The IdP
    // runs behind a TLS-terminating ingress, so all sockets share its IP — key on
    // the forwarded client IP (`SmartIpKeyExtractor` reads `X-Forwarded-For` /
    // `Forwarded`) instead of the peer address. Limits are deliberately generous
    // (burst of 30, then ~1 req/sec replenish per client) so normal logins and
    // the harness/e2e suites are never throttled; it only blunts brute-force /
    // signature-spray bursts. `finish()` only fails on a nonsensical config.
    let governor_conf = std::sync::Arc::new(
        GovernorConfigBuilder::default()
            .per_second(1)
            .burst_size(30)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .expect("valid rate-limit config"),
    );
    // Rate-limited POSTs: `/login/process` (signature verification + eth_calls)
    // and the device-flow accept `POST /device` (also signature/credential
    // bearing). Both share the one generous governor config above. `GET /device`
    // and `/device/success` (form rendering) stay unthrottled below. Keying is
    // by forwarded client IP, so the harness/e2e suites aren't throttled.
    let governed_router = Router::new()
        .route("/login/process", post(routes::login::process))
        .route("/device", post(routes::device::process))
        .layer(GovernorLayer {
            config: governor_conf,
        });

    let app = Router::new()
        .route("/login", get(routes::login::page))
        .merge(governed_router)
        .route("/consent", get(routes::consent::consent))
        .route("/device", get(routes::device::page))
        .route("/device/success", get(routes::device::success))
        .route("/---/metrics", get(metrics))
        .route("/healthz", get(|| async { "ok" }))
        .fallback_service(static_service)
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

#[cfg(test)]
mod tests {
    use super::is_hashed_asset;

    #[test]
    fn hashed_assets_are_immutable() {
        // Vite content-hashed bundles + fonts → immutable.
        assert!(is_hashed_asset("/login/static/js/main-a1b2c3d4.js"));
        assert!(is_hashed_asset("/login/static/css/main-deadbeef.css"));
        assert!(is_hashed_asset("/login/static/media/inter-9f8e7d.woff2"));
    }

    #[test]
    fn stable_entrypoints_are_not_hashed() {
        // The two unhashed, stable-name entrypoints must NOT be marked immutable.
        assert!(!is_hashed_asset("/login/static/js/embed.js"));
        assert!(!is_hashed_asset("/login/static/js/final.js"));
    }

    #[test]
    fn non_asset_paths_are_not_hashed() {
        assert!(!is_hashed_asset("/login"));
        assert!(!is_hashed_asset("/login/index.html"));
        assert!(!is_hashed_asset("/favicon.ico"));
    }
}
