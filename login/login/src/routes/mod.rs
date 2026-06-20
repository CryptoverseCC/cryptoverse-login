pub mod consent;
pub mod login;

/// Increment the `login_status{status,client}` counter (kept identical to the
/// previous Node backend so existing dashboards/alerts keep working).
pub(crate) fn count(status: &str, client: &str) {
    metrics::counter!("login_status", "status" => status.to_string(), "client" => client.to_string())
        .increment(1);
}
