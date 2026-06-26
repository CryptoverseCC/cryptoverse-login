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
use std::time::{Duration, Instant};

use axum::{
    extract::{RawQuery, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use cryptoverse_core::hydra::Hydra;
use minijinja::{context, Environment};

struct AppState {
    env: Environment<'static>,
    version: String,
    sentry_dsn: String,
    sentry_env: String,
    /// Hydra admin client, used to fetch the set of registered relying-party
    /// `redirect_uris` that `/oauth2/final` validates its target against.
    hydra: Hydra,
    /// Cached snapshot of the registered redirect targets (refreshed from Hydra),
    /// so the common case doesn't hit the admin API on every redirect.
    redirect_cache: tokio::sync::Mutex<Option<RedirectCache>>,
}

/// How long a fetched set of registered redirect URIs is trusted before a
/// refresh. Redirect URIs only change when a client is (de)registered.
const REDIRECT_CACHE_TTL: Duration = Duration::from_secs(60);

/// Minimum gap between forced refreshes triggered by a cache MISS, so an attacker
/// hammering `/oauth2/final` with unregistered targets can't turn each request
/// into a Hydra admin call. A genuinely just-registered client is still picked up
/// within this window.
const MISS_REFRESH_COOLDOWN: Duration = Duration::from_secs(2);

struct RedirectCache {
    targets: Vec<RedirectTarget>,
    fetched_at: Instant,
    last_attempt: Instant,
}

/// Comparison key for a redirect URI: scheme + host + port + path, ignoring query
/// and fragment. Hydra appends the OAuth2 response params (`code`, `state`, …) to
/// the client's registered URI, so origin+path is the stable part to match — and
/// matching parsed components (not a raw string) is what closes the
/// percent-encoded-authority open redirect.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RedirectTarget {
    scheme: String,
    host: String,
    port: Option<u16>,
    path: String,
}

impl RedirectTarget {
    fn parse(raw: &str) -> Option<Self> {
        let u = url::Url::parse(raw).ok()?;
        if !matches!(u.scheme(), "http" | "https") {
            return None;
        }
        Some(Self {
            scheme: u.scheme().to_ascii_lowercase(),
            host: u.host_str()?.to_ascii_lowercase(),
            port: u.port_or_known_default(),
            path: u.path().to_string(),
        })
    }
}

/// Validate that `url` is an absolute `http`/`https` URL with a host, so it is
/// safe to hand to the `embed` template as an iframe `src`. It is rendered into a
/// JS string literal via `tojson` (which prevents breakout), and this rejects
/// non-http(s) schemes (`javascript:`, `data:`, …) and scheme-relative / relative
/// values that could redirect somewhere unexpected. (The `/oauth2/final` target
/// instead goes through `parse_final_redirect` + `is_registered_redirect`, which
/// require it to match a registered client redirect URI and render the normalized
/// URL.)
///
/// The `url=` value may arrive percent-encoded, so we validate the decoded form.
fn is_safe_redirect(url: &str) -> bool {
    let decoded = percent_decode(url);
    match url::Url::parse(&decoded) {
        Ok(u) => matches!(u.scheme(), "http" | "https") && u.has_host(),
        Err(_) => false,
    }
}

/// Parse the `/oauth2/final` `url=<target>` query into the normalized URL to
/// render plus its comparison key. The target carries its own `&`-separated
/// params, so we strip only the literal `url=` prefix (never parse it as form
/// data); it may arrive percent-encoded, so we decode once and parse.
///
/// Returning the parsed/normalized URL (not the raw query slice) is a security
/// requirement: otherwise the membership check and the browser can disagree on
/// the host. `https://allowed%2f@evil.com/cb` percent-decodes to the
/// `/`-terminated authority `allowed`, so our parser keys on host `allowed` (path
/// `/@evil.com/cb`), and a browser handed the SAME normalized string also lands on
/// `allowed` — never `evil.com`. The `RedirectTarget` then has to match a
/// registered client redirect URI, so an unregistered host/path is rejected.
fn parse_final_redirect(raw_query: &str) -> Result<(url::Url, RedirectTarget), &'static str> {
    let target = raw_query.strip_prefix("url=").unwrap_or(raw_query);
    let decoded = percent_decode(target);
    let parsed = match url::Url::parse(&decoded) {
        Ok(u) if matches!(u.scheme(), "http" | "https") && u.has_host() => u,
        _ => return Err("invalid redirect"),
    };
    let key = RedirectTarget::parse(parsed.as_str()).ok_or("invalid redirect")?;
    Ok((parsed, key))
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

/// Build the minijinja environment with the embedded templates. Shared by `main`
/// and the render regression test, so the test exercises the real templates
/// (incl. the `tojson` filter, which needs minijinja's `json` feature).
fn build_env() -> Environment<'static> {
    let mut env = Environment::new();
    env.add_template("embed.html", include_str!("../templates/embed.html"))
        .expect("embed.html");
    env.add_template("final.html", include_str!("../templates/final.html"))
        .expect("final.html");
    env
}

#[tokio::main]
async fn main() {
    let _sentry = cryptoverse_core::telemetry::init_sentry();
    cryptoverse_core::telemetry::init_tracing();

    let env = build_env();

    let hydra = Hydra::from_env().expect("HYDRA_ADMIN_URL must be set");
    tracing::info!(
        "/oauth2/final redirect targets are validated against registered client \
         redirect_uris from Hydra (no static allowlist)"
    );

    let state = Arc::new(AppState {
        env,
        version: cryptoverse_core::config::version(),
        sentry_dsn: cryptoverse_core::config::sentry_dsn().unwrap_or_default(),
        sentry_env: cryptoverse_core::config::sentry_env(),
        hydra,
        redirect_cache: tokio::sync::Mutex::new(None),
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

/// Whether `target` matches a registered client redirect URI, consulting (and
/// refreshing) the cached set. On a cache MISS the target may be a just-registered
/// client the snapshot predates, so we force one refresh — rate-limited by
/// `MISS_REFRESH_COOLDOWN` so this can't be used to hammer Hydra.
async fn is_registered_redirect(st: &AppState, target: &RedirectTarget) -> bool {
    let mut cache = st.redirect_cache.lock().await;
    let stale = cache
        .as_ref()
        .is_none_or(|c| c.fetched_at.elapsed() > REDIRECT_CACHE_TTL);
    if stale {
        refresh_redirect_cache(&st.hydra, &mut cache).await;
    }
    if let Some(c) = cache.as_ref() {
        if c.targets.contains(target) {
            return true;
        }
        if c.last_attempt.elapsed() > MISS_REFRESH_COOLDOWN {
            refresh_redirect_cache(&st.hydra, &mut cache).await;
            return cache.as_ref().is_some_and(|c| c.targets.contains(target));
        }
    }
    false
}

/// Refresh the cached registered-redirect set from Hydra. On failure the last
/// known-good set is kept (only `last_attempt` advances) so a transient Hydra blip
/// doesn't break redirects; a cold start with Hydra down leaves the set empty,
/// which fails closed (every target rejected).
async fn refresh_redirect_cache(hydra: &Hydra, cache: &mut Option<RedirectCache>) {
    let now = Instant::now();
    match hydra.list_redirect_uris().await {
        Ok(uris) => {
            let targets = uris
                .iter()
                .filter_map(|u| RedirectTarget::parse(u))
                .collect();
            *cache = Some(RedirectCache {
                targets,
                fetched_at: now,
                last_attempt: now,
            });
        }
        Err(e) => {
            tracing::warn!("failed to refresh registered redirect URIs from Hydra: {e}");
            if let Some(c) = cache.as_mut() {
                c.last_attempt = now;
            }
        }
    }
}

/// Final redirect page. The gateway rewrote Hydra's consent `Location` into
/// `/oauth2/final?url=<the original redirect>`. We parse + normalize the target,
/// require it to match a **registered client redirect URI** (fetched from Hydra,
/// not a static list), and hand that SAME normalized URL to `final.js` — so the
/// target we validated is exactly the one the browser navigates to.
async fn final_page(State(st): State<Arc<AppState>>, RawQuery(query): RawQuery) -> Response {
    let raw = query.unwrap_or_default();
    let (parsed, key) = match parse_final_redirect(&raw) {
        Ok(v) => v,
        Err(reason) => {
            tracing::warn!("final: {reason} for query `{raw}`");
            return (StatusCode::BAD_REQUEST, reason).into_response();
        }
    };
    if !is_registered_redirect(&st, &key).await {
        tracing::warn!("final: redirect target is not a registered redirect_uri `{parsed}`");
        return (
            StatusCode::BAD_REQUEST,
            "redirect target is not a registered client redirect URI",
        )
            .into_response();
    }
    let url = parsed.to_string();

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
    fn renders_embed_and_final_without_filter_errors() {
        // Regression: embed.html/final.html use the `tojson` filter, which needs
        // minijinja's `json` feature. Without it, render() errors at runtime and
        // the handler 502s the browser OAuth flow (cargo build still succeeds, so
        // only a real render catches it). Render both templates for real.
        let env = build_env();
        let url = "https://login-demo.cv.127.0.0.1.nip.io:9443/oidc/callback/?code=abc&state=xyz";
        for name in ["embed.html", "final.html"] {
            let out = env
                .get_template(name)
                .unwrap()
                .render(context! { url => url, version => "test", sentry_dsn => "", sentry_env => "test" })
                .unwrap_or_else(|e| panic!("render {name} failed: {e}"));
            assert!(
                out.contains("login-demo.cv.127.0.0.1.nip.io"),
                "{name} should embed the redirect url"
            );
        }
    }

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

    fn registered(uris: &[&str]) -> Vec<RedirectTarget> {
        uris.iter()
            .filter_map(|u| RedirectTarget::parse(u))
            .collect()
    }

    #[test]
    fn final_target_matches_registered_redirect_uri() {
        let reg = registered(&["https://login-demo.cv.127.0.0.1.nip.io:9443/oidc/callback/"]);
        // Hydra emits the registered URI with the OAuth2 response params appended.
        let (parsed, key) = parse_final_redirect(
            "url=https://login-demo.cv.127.0.0.1.nip.io:9443/oidc/callback/?code=abc&state=xyz",
        )
        .expect("valid target");
        assert!(reg.contains(&key), "registered redirect must match");
        assert!(parsed
            .as_str()
            .starts_with("https://login-demo.cv.127.0.0.1.nip.io:9443/oidc/callback/"));
    }

    #[test]
    fn final_target_rejects_unregistered_host() {
        let reg = registered(&["https://login-demo.cv.127.0.0.1.nip.io:9443/oidc/callback/"]);
        let (_p, key) = parse_final_redirect("url=https://attacker.com/oidc/callback/?code=abc")
            .expect("parses");
        assert!(!reg.contains(&key), "unregistered host must be rejected");
    }

    #[test]
    fn final_target_closes_encoded_authority_open_redirect() {
        // The parse-here / use-there bypass: `%2f@evil.com` percent-decodes so the
        // PARSED host is the registered one, but with path `/@evil.com/...`, which
        // is not a registered redirect path -> rejected. And the normalized url a
        // browser navigates to has host = the registered host, never evil.com.
        let reg = registered(&["https://login-demo.cv.127.0.0.1.nip.io:9443/oidc/callback/"]);
        let (parsed, key) = parse_final_redirect(
            "url=https://login-demo.cv.127.0.0.1.nip.io:9443%2f@evil.com/oidc/callback/?code=abc",
        )
        .expect("parses");
        assert_eq!(parsed.host_str(), Some("login-demo.cv.127.0.0.1.nip.io"));
        assert!(
            !reg.contains(&key),
            "decoded path /@evil.com/... is not a registered redirect"
        );
        // Plain userinfo form: the real host is evil.com -> not registered.
        let (_p2, key2) = parse_final_redirect(
            "url=https://login-demo.cv.127.0.0.1.nip.io:9443@evil.com/oidc/callback/?code=abc",
        )
        .expect("parses");
        assert!(!reg.contains(&key2));
    }

    #[test]
    fn final_target_rejects_non_http_or_relative() {
        assert!(parse_final_redirect("url=javascript:alert(1)").is_err());
        assert!(parse_final_redirect("url=//evil.example.com").is_err());
        assert!(parse_final_redirect("url=/relative/path").is_err());
    }

    #[test]
    fn redirect_target_default_port_equivalence_and_path_sensitivity() {
        // https default port: explicit :443 == omitted.
        assert_eq!(
            RedirectTarget::parse("https://app.example/cb"),
            RedirectTarget::parse("https://app.example:443/cb"),
        );
        // A different path is a different target (exact-path match).
        assert_ne!(
            RedirectTarget::parse("https://app.example/cb"),
            RedirectTarget::parse("https://app.example/cb/sub"),
        );
        // A different host is a different target.
        assert_ne!(
            RedirectTarget::parse("https://app.example/cb"),
            RedirectTarget::parse("https://evil.example/cb"),
        );
    }
}
