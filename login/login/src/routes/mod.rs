pub mod consent;
pub mod login;

use axum::http::HeaderMap;

/// Increment the `login_status{status,client}` counter (kept identical to the
/// previous Node backend so existing dashboards/alerts keep working).
pub(crate) fn count(status: &str, client: &str) {
    metrics::counter!("login_status", "status" => status.to_string(), "client" => client.to_string())
        .increment(1);
}

/// Derive the public `(host, scheme)` from the request as forwarded by the
/// TLS-terminating ingress: `X-Forwarded-Host` / `X-Forwarded-Proto`, falling
/// back to the `Host` header and `https`. This keeps the service free of any
/// hardcoded domain, port, or scheme.
pub(crate) fn public_origin(headers: &HeaderMap) -> (String, String) {
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
