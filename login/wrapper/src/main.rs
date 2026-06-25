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
    /// Open-redirect allowlist for `/oauth2/final`'s `url=` target, parsed from
    /// `ALLOWED_REDIRECT_HOSTS` (comma-separated hostnames). Empty ⇒ protection
    /// disabled (any http(s) host allowed), preserving the pre-allowlist
    /// behaviour so it's opt-in / non-breaking.
    allowed_redirect_hosts: Vec<String>,
}

/// Validate that `url` is an absolute `http`/`https` URL with a host, so it is
/// safe to hand to the `embed` template as an iframe `src`. It is rendered into a
/// JS string literal via `tojson` (which prevents breakout), and this rejects
/// non-http(s) schemes (`javascript:`, `data:`, …) and scheme-relative / relative
/// values that could redirect somewhere unexpected. (The `/oauth2/final` target
/// goes through `final_redirect_target`, which additionally enforces the host
/// allowlist and renders the normalized URL.)
///
/// The `url=` value may arrive percent-encoded, so we validate the decoded form.
fn is_safe_redirect(url: &str) -> bool {
    let decoded = percent_decode(url);
    match url::Url::parse(&decoded) {
        Ok(u) => matches!(u.scheme(), "http" | "https") && u.has_host(),
        Err(_) => false,
    }
}

/// Parse the `ALLOWED_REDIRECT_HOSTS` env value into a hostname allowlist:
/// comma-separated, trimmed, lowercased, with empty entries dropped.
fn parse_allowed_redirect_hosts(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|h| h.trim().to_ascii_lowercase())
        .filter(|h| !h.is_empty())
        .collect()
}

/// Decide whether `url`'s host is permitted by the redirect allowlist. An EMPTY
/// allowlist permits any host (preserving the pre-allowlist, opt-in behaviour); a
/// non-empty allowlist requires the host (lowercased, port-agnostic) to be a
/// member. A url with no host is rejected when the allowlist is non-empty.
fn host_allowed(url: &url::Url, allowlist: &[String]) -> bool {
    if allowlist.is_empty() {
        return true;
    }
    match url.host_str() {
        Some(host) => allowlist.contains(&host.to_ascii_lowercase()),
        None => false,
    }
}

/// Validate the `/oauth2/final` redirect target and return the EXACT normalized
/// URL string to render. The query is `url=<target>`; the target carries its own
/// `&`-separated params, so we strip only the literal `url=` prefix (never parse
/// it as form data). The target may arrive percent-encoded, so decode once, parse
/// it, enforce http(s) + host + allowlist on the PARSED url, and return that same
/// url's normalized string.
///
/// Returning the parsed/normalized form (not the raw query slice) is a security
/// requirement, not cosmetics: otherwise the allowlist check and the browser can
/// disagree on the host. E.g. `https://allowed%2f@evil.com/cb` percent-decodes to
/// the `/`-terminated authority `allowed` for our check, but a browser handed the
/// RAW string parses the host as `evil.com`. Checking and rendering the one
/// parsed `Url` (whose `%2f` is a real `/` that ends the authority at `allowed`)
/// closes that parse-here / use-there open redirect.
fn final_redirect_target(raw_query: &str, allowlist: &[String]) -> Result<String, &'static str> {
    let target = raw_query.strip_prefix("url=").unwrap_or(raw_query);
    let decoded = percent_decode(target);
    let parsed = match url::Url::parse(&decoded) {
        Ok(u) if matches!(u.scheme(), "http" | "https") && u.has_host() => u,
        _ => return Err("invalid redirect"),
    };
    if !host_allowed(&parsed, allowlist) {
        return Err("redirect host not allowed");
    }
    Ok(parsed.to_string())
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

    let allowed_redirect_hosts = parse_allowed_redirect_hosts(&cryptoverse_core::config::var_or(
        "ALLOWED_REDIRECT_HOSTS",
        "",
    ));

    if allowed_redirect_hosts.is_empty() {
        tracing::warn!(
            "open-redirect protection on /oauth2/final is DISABLED (any http(s) host allowed); \
             set ALLOWED_REDIRECT_HOSTS to your relying-party hosts to enable it"
        );
    } else {
        tracing::info!(
            "open-redirect allowlist active: {}",
            allowed_redirect_hosts.join(", ")
        );
    }

    let state = Arc::new(AppState {
        env,
        version: cryptoverse_core::config::version(),
        sentry_dsn: cryptoverse_core::config::sentry_dsn().unwrap_or_default(),
        sentry_env: cryptoverse_core::config::sentry_env(),
        allowed_redirect_hosts,
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
/// `/oauth2/final?url=<the original redirect>`. We validate + normalize the
/// target (`final_redirect_target`) and hand the SAME normalized URL to
/// `final.js`, so the host we allowlist-checked is exactly the host the browser
/// navigates to (`window.location.assign`).
async fn final_page(State(st): State<Arc<AppState>>, RawQuery(query): RawQuery) -> Response {
    let raw = query.unwrap_or_default();
    let url = match final_redirect_target(&raw, &st.allowed_redirect_hosts) {
        Ok(u) => u,
        Err(reason) => {
            tracing::warn!("final: {reason} for query `{raw}`");
            return (StatusCode::BAD_REQUEST, reason).into_response();
        }
    };

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

    #[test]
    fn final_target_permits_listed_host_rejects_others() {
        let allow = parse_allowed_redirect_hosts("login-demo.cv.127.0.0.1.nip.io");
        // The legit demo RP callback (host match, port-agnostic) — normalized url
        // keeps the host + port + path + query.
        let t = final_redirect_target(
            "url=https://login-demo.cv.127.0.0.1.nip.io:9443/oidc/callback/?code=abc&state=xyz",
            &allow,
        )
        .expect("listed host allowed");
        assert!(t.starts_with("https://login-demo.cv.127.0.0.1.nip.io:9443/oidc/callback"));
        // Case-insensitive host match.
        assert!(
            final_redirect_target("url=https://LOGIN-DEMO.cv.127.0.0.1.NIP.IO/cb", &allow).is_ok()
        );
        // An attacker-controlled host is refused.
        assert!(final_redirect_target("url=https://attacker.com/steal?code=abc", &allow).is_err());
        // A host that merely contains the allowed host as a substring is refused
        // (exact host match, not substring).
        assert!(final_redirect_target(
            "url=https://login-demo.cv.127.0.0.1.nip.io.attacker.com/cb",
            &allow
        )
        .is_err());
    }

    #[test]
    fn final_target_closes_encoded_authority_open_redirect() {
        // The parse-here / use-there bypass: `%2f@evil.com` percent-decodes so a
        // naive host check sees the allowed host, but a browser handed the RAW
        // string parses the host as evil.com. Because we render the PARSED url, the
        // rendered target's host is the allowed host (the decoded `/` ends the
        // authority), never evil.com.
        let allow = parse_allowed_redirect_hosts("login-demo.cv.127.0.0.1.nip.io");
        let t = final_redirect_target(
            "url=https://login-demo.cv.127.0.0.1.nip.io%2f@evil.com/cb",
            &allow,
        )
        .expect("encoded-slash form normalizes to the allowed host");
        let host = url::Url::parse(&t).unwrap().host_str().unwrap().to_string();
        assert_eq!(
            host, "login-demo.cv.127.0.0.1.nip.io",
            "rendered redirect host must be the allowed host, not evil.com"
        );
        // The plain userinfo form (real host = evil.com) is rejected outright.
        assert!(final_redirect_target(
            "url=https://login-demo.cv.127.0.0.1.nip.io@evil.com/cb",
            &allow
        )
        .is_err());
    }

    #[test]
    fn final_target_empty_allowlist_permits_any_http_host() {
        let allow = parse_allowed_redirect_hosts("");
        assert!(final_redirect_target("url=https://attacker.com/cb", &allow).is_ok());
        assert!(final_redirect_target("url=http://localhost:8080/cb", &allow).is_ok());
        // Non-http(s) is still rejected even with an empty allowlist.
        assert!(final_redirect_target("url=javascript:alert(1)", &allow).is_err());
    }

    #[test]
    fn parses_allowed_redirect_hosts_trimmed_lowercased_nonempty() {
        let hosts = parse_allowed_redirect_hosts(" Demo.Example.COM , , rp.example.org ,");
        assert_eq!(
            hosts,
            vec!["demo.example.com".to_string(), "rp.example.org".to_string()]
        );
    }
}
