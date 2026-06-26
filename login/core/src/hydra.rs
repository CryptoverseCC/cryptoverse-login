//! Thin typed client for the ORY Hydra 2.x **admin** API.
//!
//! Only the four login/consent endpoints this IdP needs are implemented. There
//! is no official ORY Rust SDK, and the admin surface is small and stable, so a
//! hand-rolled `reqwest` client is the pragmatic choice.
//!
//! Base URL is Hydra's admin service (`HYDRA_ADMIN_URL`), and in Hydra 2.x the
//! admin endpoints live under `/admin/...`.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Per-request timeout for Hydra admin calls. Hydra is co-located (in-cluster)
/// so it's normally sub-millisecond, but a stuck connection must not block a
/// login indefinitely — the route handlers already map a client error to a
/// `502`/`401`, so a timeout surfaces as the existing Hydra-error path.
const HYDRA_TIMEOUT: Duration = Duration::from_secs(5);

/// The OAuth2 client (relying party) as returned by Hydra. `metadata` is kept
/// opaque so callers can interpret app name / restrictions however they like.
#[derive(Debug, Clone, Deserialize)]
pub struct OAuth2Client {
    pub client_id: String,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

/// Response of `GET /admin/oauth2/auth/requests/login`.
#[derive(Debug, Clone, Deserialize)]
pub struct LoginRequest {
    pub challenge: String,
    pub client: OAuth2Client,
    #[serde(default)]
    pub request_url: Option<String>,
    #[serde(default)]
    pub requested_scope: Vec<String>,
    #[serde(default)]
    pub subject: String,
}

/// Response of `GET /admin/oauth2/auth/requests/consent`.
#[derive(Debug, Clone, Deserialize)]
pub struct ConsentRequest {
    pub challenge: String,
    #[serde(default)]
    pub subject: String,
    pub client: OAuth2Client,
    #[serde(default)]
    pub requested_scope: Vec<String>,
    #[serde(default)]
    pub requested_access_token_audience: Vec<String>,
}

/// Body for accepting a device verification request (RFC 8628). Hydra binds the
/// submitted `user_code` to the encrypted `device_challenge` and, on success,
/// returns the URL that hands off to the standard login → consent pipeline.
#[derive(Debug, Clone, Serialize)]
struct AcceptDeviceUserCode {
    user_code: String,
}

/// Body for accepting a consent request.
#[derive(Debug, Clone, Serialize)]
pub struct AcceptConsent {
    pub grant_scope: Vec<String>,
    pub grant_access_token_audience: Vec<String>,
    pub session: ConsentSession,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConsentSession {
    pub access_token: serde_json::Value,
    pub id_token: serde_json::Value,
}

/// Hydra accept responses return a URL the user-agent should be redirected to.
#[derive(Debug, Clone, Deserialize)]
pub struct RedirectResponse {
    pub redirect_to: String,
}

#[derive(Debug, Clone)]
pub struct Hydra {
    base: String,
    http: reqwest::Client,
}

impl Hydra {
    /// Build a client against the Hydra admin base URL (`HYDRA_ADMIN_URL`).
    pub fn new(base: impl Into<String>) -> Self {
        let mut headers = reqwest::header::HeaderMap::new();
        // Mirror the previous Node backend which forced this on every request so
        // Hydra builds `https` redirect URLs behind the TLS-terminating gateway.
        headers.insert(
            "X-Forwarded-Proto",
            reqwest::header::HeaderValue::from_static("https"),
        );
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(HYDRA_TIMEOUT)
            .build()
            .expect("failed to build reqwest client");
        Self {
            base: base.into().trim_end_matches('/').to_string(),
            http,
        }
    }

    /// Construct from the `HYDRA_ADMIN_URL` env var.
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self::new(crate::config::var("HYDRA_ADMIN_URL")?))
    }

    pub async fn get_login_request(&self, challenge: &str) -> anyhow::Result<LoginRequest> {
        let url = format!("{}/admin/oauth2/auth/requests/login", self.base);
        let resp = self
            .http
            .get(url)
            .query(&[("login_challenge", challenge)])
            .send()
            .await?
            .error_for_status()?;
        Ok(resp.json().await?)
    }

    /// Accept a login request, binding the recovered `subject` plus the achieved
    /// authentication assurance: `acr` (a single context-class string) and `amr`
    /// (the methods used, RFC 8176). `remember_for > 0` asks Hydra to remember the
    /// authenticated session for that many seconds (a stable `sid`), which both
    /// gives the user SSO across relying parties AND is what makes RP-initiated +
    /// back-channel **logout** actually fire (Hydra skips the logout provider and
    /// channel notifications for non-remembered sessions). `0` disables it.
    pub async fn accept_login_request(
        &self,
        challenge: &str,
        subject: &str,
        acr: &str,
        amr: &[&str],
        remember_for: i64,
    ) -> anyhow::Result<RedirectResponse> {
        let url = format!("{}/admin/oauth2/auth/requests/login/accept", self.base);
        let resp = self
            .http
            .put(url)
            .query(&[("login_challenge", challenge)])
            .json(&serde_json::json!({
                "subject": subject,
                "acr": acr,
                "amr": amr,
                "remember": remember_for > 0,
                "remember_for": remember_for.max(0),
            }))
            .send()
            .await?
            .error_for_status()?;
        Ok(resp.json().await?)
    }

    /// Accept an RP-initiated logout request. Hydra redirects the browser here
    /// (`urls.logout`) with a one-time `logout_challenge` after it has validated
    /// the RP's `id_token_hint` at the end-session endpoint. Accepting it returns
    /// the `redirect_to` that clears the session, fires back-/front-channel logout
    /// to the clients, and lands on the post-logout redirect.
    pub async fn accept_logout_request(&self, challenge: &str) -> anyhow::Result<RedirectResponse> {
        let url = format!("{}/admin/oauth2/auth/requests/logout/accept", self.base);
        let resp = self
            .http
            .put(url)
            .query(&[("logout_challenge", challenge)])
            .send()
            .await?
            .error_for_status()?;
        Ok(resp.json().await?)
    }

    /// Accept a device-verification request (RFC 8628 device authorization
    /// grant). `device_challenge` is the encrypted challenge Hydra issued on the
    /// 302 from `/oauth2/device/verify`; `user_code` is the code the user typed.
    ///
    /// Hydra binds the code to the challenge and returns a `redirect_to` URL
    /// that enters the **standard** login → consent pipeline (our existing
    /// `/login` + `/consent` routes). There is no `GET` device-request endpoint
    /// in Hydra 2.x — accept is the only call.
    pub async fn accept_device_request(
        &self,
        device_challenge: &str,
        user_code: &str,
    ) -> anyhow::Result<RedirectResponse> {
        let url = format!("{}/admin/oauth2/auth/requests/device/accept", self.base);
        let resp = self
            .http
            .put(url)
            .query(&[("device_challenge", device_challenge)])
            .json(&AcceptDeviceUserCode {
                user_code: user_code.to_string(),
            })
            .send()
            .await?
            .error_for_status()?;
        Ok(resp.json().await?)
    }

    pub async fn get_consent_request(&self, challenge: &str) -> anyhow::Result<ConsentRequest> {
        let url = format!("{}/admin/oauth2/auth/requests/consent", self.base);
        let resp = self
            .http
            .get(url)
            .query(&[("consent_challenge", challenge)])
            .send()
            .await?
            .error_for_status()?;
        Ok(resp.json().await?)
    }

    pub async fn accept_consent_request(
        &self,
        challenge: &str,
        body: &AcceptConsent,
    ) -> anyhow::Result<RedirectResponse> {
        let url = format!("{}/admin/oauth2/auth/requests/consent/accept", self.base);
        let resp = self
            .http
            .put(url)
            .query(&[("consent_challenge", challenge)])
            .json(body)
            .send()
            .await?
            .error_for_status()?;
        Ok(resp.json().await?)
    }

    /// Fetch every registered OAuth2 client's `redirect_uris` from the admin API
    /// (`GET /admin/clients`, following Hydra's `Link: …; rel="next"` pagination).
    ///
    /// Used to validate a redirect target against the redirect URIs the relying
    /// parties actually registered — the permitted set is exactly what Hydra
    /// holds, so there is no static, operator-maintained allowlist to drift.
    pub async fn list_redirect_uris(&self) -> anyhow::Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Client {
            #[serde(default)]
            redirect_uris: Vec<String>,
        }

        let mut out = Vec::new();
        let mut url = format!("{}/admin/clients?page_size=500", self.base);
        // Bound the page walk defensively (500 * 100 = 50k clients) so a broken
        // `Link` header can never loop forever.
        for _ in 0..100 {
            let resp = self.http.get(&url).send().await?.error_for_status()?;
            let next = next_page_url(&self.base, resp.headers());
            let clients: Vec<Client> = resp.json().await?;
            for c in clients {
                out.extend(c.redirect_uris);
            }
            match next {
                Some(n) => url = n,
                None => break,
            }
        }
        Ok(out)
    }
}

/// Extract the absolute URL of the `rel="next"` link from a Hydra pagination
/// `Link` header, if present. Hydra returns a path-relative target
/// (`</admin/clients?page_token=…>; rel="next"`), so it's joined onto `base`.
fn next_page_url(base: &str, headers: &reqwest::header::HeaderMap) -> Option<String> {
    let link = headers.get(reqwest::header::LINK)?.to_str().ok()?;
    for part in link.split(',') {
        if part.contains("rel=\"next\"") {
            let start = part.find('<')? + 1;
            let end = part.find('>')?;
            let target = &part[start..end];
            return Some(if target.starts_with("http") {
                target.to_string()
            } else {
                format!("{base}{target}")
            });
        }
    }
    None
}
