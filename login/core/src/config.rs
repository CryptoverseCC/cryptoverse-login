//! Small environment-variable helpers shared by both services.

use std::env;

/// Required env var; returns an error if missing.
pub fn var(key: &str) -> anyhow::Result<String> {
    env::var(key).map_err(|_| anyhow::anyhow!("missing required env var `{key}`"))
}

/// Optional env var with a default.
pub fn var_or(key: &str, default: &str) -> String {
    env::var(key)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// Optional env var; `None` if unset or empty.
pub fn var_opt(key: &str) -> Option<String> {
    env::var(key).ok().filter(|s| !s.is_empty())
}

/// HTTP port the service listens on (`PORT`, default 3000).
pub fn port() -> u16 {
    var_or("PORT", "3000").parse().unwrap_or(3000)
}

/// Release version string (`VERSION`), surfaced to Sentry and templates.
pub fn version() -> String {
    var_or("VERSION", "dev")
}

/// Sentry DSN (`SENTRY_DSN`), `None` disables Sentry.
pub fn sentry_dsn() -> Option<String> {
    var_opt("SENTRY_DSN")
}

/// Sentry environment (`SENTRY_ENV`, default `development`).
pub fn sentry_env() -> String {
    var_or("SENTRY_ENV", "development")
}

/// Public domain this IdP is served on (`DOMAIN`), e.g. `login.cryptoverse.cc`.
/// Used as the EIP-4361 `domain` and to build absolute URIs.
pub fn domain() -> String {
    var_or("DOMAIN", "login.cryptoverse.cc")
}
