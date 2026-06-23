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

    pub async fn accept_login_request(
        &self,
        challenge: &str,
        subject: &str,
    ) -> anyhow::Result<RedirectResponse> {
        let url = format!("{}/admin/oauth2/auth/requests/login/accept", self.base);
        let resp = self
            .http
            .put(url)
            .query(&[("login_challenge", challenge)])
            .json(&serde_json::json!({ "subject": subject }))
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
}
