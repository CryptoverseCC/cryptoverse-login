//! Builds the OIDC ID-token claims for a subject (lowercased Ethereum address).
//!
//! Port of `backend/src/routes/userData.ts`. Enriches the token with ENS and
//! Unstoppable Domains reverse-resolution names plus generated
//! `{address}@{MAILSERVER_DOMAIN}` emails. All on-chain lookups are best-effort.

use alloy::primitives::Address;
use cryptoverse_core::eth::Eth;
use serde_json::json;

/// Build the `id_token` claims object for `subject`.
pub async fn get_data(
    eth: &Eth,
    subject: &str,
    mailserver_domain: &str,
    profile_domain: &str,
) -> serde_json::Value {
    let user = subject;
    let default_email = format!("{user}@{mailserver_domain}");

    let mut email_all = vec![default_email.clone()];
    let mut ens_email_default: Option<String> = None;
    let mut ens_email_all: Vec<String> = vec![];
    let mut ud_email_default: Option<String> = None;
    let mut ud_email_all: Vec<String> = vec![];

    let mut name_all = vec![user.to_string()];
    let mut ens_name_default: Option<String> = None;
    let mut ens_name_all: Vec<String> = vec![];
    let mut ud_name_default: Option<String> = None;
    let mut ud_name_all: Vec<String> = vec![];

    if let Ok(owner) = subject.parse::<Address>() {
        if let Some(ens) = eth.ens_reverse(owner).await {
            let email = format!("{}@{mailserver_domain}", ens.replace(".eth", ""));
            email_all.push(email.clone());
            ens_email_default = Some(email.clone());
            ens_email_all.push(email);

            name_all.push(ens.clone());
            ens_name_default = Some(ens.clone());
            ens_name_all.push(ens);
        }

        if let Some(ud) = eth.ud_reverse(owner).await {
            let email = format!(
                "{}@unstoppable.email",
                ud.strip_suffix(".crypto").unwrap_or(&ud)
            );
            email_all.push(email.clone());
            ud_email_default = Some(email.clone());
            ud_email_all.push(email);

            name_all.push(ud.clone());
            ud_name_default = Some(ud.clone());
            ud_name_all.push(ud);
        }
    }

    let emails = json!({
        "default": default_email,
        "all": email_all,
        "ens": { "default": ens_email_default, "all": ens_email_all },
        "unstoppabledomains": { "default": ud_email_default, "all": ud_email_all },
    });

    let names = json!({
        "default": user,
        "all": name_all,
        "ens": { "default": ens_name_default, "all": ens_name_all },
        "unstoppabledomains": { "default": ud_name_default, "all": ud_name_all },
    });

    json!({
        "address": { "country": "Cryptoverse", "region": "Ethereum" },
        "birthdate": "",
        "email_verified": true,
        "email": default_email,
        "emails": emails,
        "family_name": "Ethereum",
        "gender": "ethereum-address",
        "given_name": user,
        "locale": "",
        "middle_name": "",
        "name": user,
        "names": names,
        "nickname": ens_name_default,
        "phone_number_verified": false,
        "phone_number": "",
        "picture": format!("https://{profile_domain}/{user}.png"),
        "preferred_username": user,
        "profile": format!("https://{profile_domain}/{user}"),
        "sub": user,
        "updated_at": 0,
        "website": format!("https://{user}.{profile_domain}/"),
        "zoneinfo": "",
    })
}
