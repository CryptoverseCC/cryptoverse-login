//! Tracing, Sentry and Prometheus initialisation shared by both services.

use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};

/// Initialise `tracing` with an env-filter (`RUST_LOG`, default `info`) plus a
/// Sentry breadcrumb/event layer. Call once at startup, before `init_sentry`'s
/// guard is dropped.
pub fn init_tracing() {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer())
        .with(sentry::integrations::tracing::layer())
        .init();
}

/// Initialise Sentry if `SENTRY_DSN` is set. The returned guard must be kept
/// alive for the lifetime of the process (drop flushes pending events).
pub fn init_sentry() -> Option<sentry::ClientInitGuard> {
    let dsn = crate::config::sentry_dsn()?;
    let guard = sentry::init((
        dsn,
        sentry::ClientOptions {
            release: Some(crate::config::version().into()),
            environment: Some(crate::config::sentry_env().into()),
            send_default_pii: false,
            ..Default::default()
        },
    ));
    Some(guard)
}

/// Install the global Prometheus recorder and return a handle that renders the
/// metrics text exposition format for the `/---/metrics` endpoint.
pub fn init_metrics() -> PrometheusHandle {
    PrometheusBuilder::new()
        .install_recorder()
        .expect("failed to install Prometheus recorder")
}

/// Increment `rpc_calls_total{label,result}` (result = `ok` | `timeout` |
/// `error`). Emitted at the single JSON-RPC chokepoint in [`crate::eth`] so
/// dashboards can watch RPC health (and tell a timeout storm apart from a
/// provider returning errors). Uses the same global `metrics` recorder as the
/// `login_status` counter, so it is rendered by the same Prometheus handle.
pub fn record_rpc_call(label: &str, result: &str) {
    metrics::counter!(
        "rpc_calls_total",
        "label" => label.to_string(),
        "result" => result.to_string(),
    )
    .increment(1);
}
