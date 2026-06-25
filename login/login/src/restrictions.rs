//! Token-gating ("restrictions").
//!
//! Port of the previous `backend/src/routes/restrictions.ts`. Restrictions come
//! from the client's Hydra `metadata.restrictions`, or fall back to a JSON file
//! keyed by `client_id` (re-read per request for zero-downtime edits). Each
//! entry carries a `tokenAddress` or `contractAliases` plus a `condition`
//! expression evaluated against on-chain `balanceOf` values.
//!
//! The expression engine is [`evalexpr`] (replacing mathjs). Like mathjs it
//! works on `f64`, so balances are scaled by token `decimals` and coerced to
//! float before evaluation. Condition variables are `balanceOf` (single-token
//! form) or `<Alias>balanceOf` (aliases form), matching the previous keys.

use std::collections::BTreeMap;

use alloy::primitives::Address;
use cryptoverse_core::eth::Eth;
use cryptoverse_core::hydra::OAuth2Client;
use evalexpr::{ContextWithMutableVariables, DefaultNumericTypes, HashMapContext, Node, Value};
use serde::{Deserialize, Serialize};

/// Message shown when a gated balance could not be read on-chain (RPC down,
/// bad token address, decimals/parse failure). The gate is INDETERMINATE, so we
/// **fail closed** (deny) — never silently pass a `> 0` check during an outage.
const INDETERMINATE_MSG: &str =
    "Could not verify your on-chain balances right now. Please try again.";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Restriction {
    #[serde(rename = "contractAliases", default)]
    pub contract_aliases: Option<BTreeMap<String, String>>,
    #[serde(rename = "tokenAddress", default)]
    pub token_address: Option<String>,
    pub condition: String,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckResult {
    pub passed: bool,
    pub condition: String,
    pub message: Option<String>,
    pub data: BTreeMap<String, f64>,
}

/// Resolve the restriction set for a client, or `None` if the client is
/// unrestricted (everyone may log in).
pub async fn get_restrictions(client: &OAuth2Client, file: &str) -> Option<Vec<Restriction>> {
    // 1. Inline on the Hydra client metadata.
    if let Some(value) = client.metadata.get("restrictions") {
        if !value.is_null() {
            match serde_json::from_value::<Vec<Restriction>>(value.clone()) {
                Ok(restrictions) => return Some(restrictions),
                Err(e) => tracing::warn!("invalid metadata.restrictions: {e}"),
            }
        }
    }

    // 2. Fall back to the per-client JSON file (read every request on purpose).
    let contents = tokio::fs::read_to_string(file).await.ok()?;
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&contents)
        .map_err(|e| tracing::warn!("invalid {file}: {e}"))
        .ok()?;
    let entry = map.get(&client.client_id)?;
    serde_json::from_value::<Vec<Restriction>>(entry.clone())
        .map_err(|e| tracing::warn!("invalid restrictions for {}: {e}", client.client_id))
        .ok()
}

/// Evaluate every restriction for `owner`. The login is allowed only when all
/// `passed` are true (callers check with `.iter().all(...)`).
pub async fn check_restrictions(
    eth: &Eth,
    restrictions: &[Restriction],
    owner: Address,
) -> Vec<CheckResult> {
    let mut results = Vec::with_capacity(restrictions.len());
    for restriction in restrictions {
        results.push(check_one(eth, restriction, owner).await);
    }
    results
}

async fn check_one(eth: &Eth, restriction: &Restriction, owner: Address) -> CheckResult {
    let mut context = HashMapContext::<DefaultNumericTypes>::new();
    let mut data = BTreeMap::new();

    // Resolve every gated balance. A failure (RPC down / bad address / decimals
    // parse) makes the gate INDETERMINATE — we must NOT coerce it to 0.0 and let
    // a `> 0` check silently "fail" (or a `== 0` check silently pass) during an
    // outage. Instead we fail closed with a distinct, observable message.
    if let Some(aliases) = &restriction.contract_aliases {
        for (name, token) in aliases {
            let key = format!("{name}balanceOf");
            match balance_for(eth, token, owner).await {
                Ok(value) => {
                    data.insert(key.clone(), value);
                    let _ = context.set_value(key, Value::Float(value));
                }
                Err(()) => return indeterminate(restriction, data),
            }
        }
    }

    if let Some(token) = &restriction.token_address {
        let key = "balanceOf".to_string();
        match balance_for(eth, token, owner).await {
            Ok(value) => {
                data.insert(key.clone(), value);
                let _ = context.set_value(key, Value::Float(value));
            }
            Err(()) => return indeterminate(restriction, data),
        }
    }

    // Parse the condition once so we can both validate its variables and
    // evaluate it. A parse error is a *config* error (bad expression), distinct
    // from a genuine user denial — fail closed, but say so clearly.
    let tree = match evalexpr::build_operator_tree::<DefaultNumericTypes>(&restriction.condition) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(
                "restriction condition `{}` is not a valid expression: {e}",
                restriction.condition
            );
            return config_error(restriction, data, "restriction condition is misconfigured");
        }
    };

    // Every identifier the condition references must have been provided (i.e.
    // it names a `balanceOf` / `<Alias>balanceOf` we actually resolved). A typo
    // like `MAblanceOf` would otherwise make evalexpr error and look like a user
    // denial; surface it as a config error instead.
    if let Some(missing) = missing_identifier(&tree, &data) {
        tracing::error!(
            "restriction condition `{}` references unknown variable `{missing}` \
             (provided: {:?})",
            restriction.condition,
            data.keys().collect::<Vec<_>>()
        );
        return config_error(
            restriction,
            data,
            &format!("restriction references unknown variable `{missing}`"),
        );
    }

    let passed = match tree.eval_boolean_with_context(&context) {
        Ok(result) => result,
        Err(e) => {
            // With variables validated above, a remaining error is a config
            // issue (type/operator misuse), not a user denial.
            tracing::error!(
                "condition `{}` failed to evaluate: {e}",
                restriction.condition
            );
            return config_error(restriction, data, "restriction condition is misconfigured");
        }
    };

    CheckResult {
        passed,
        condition: restriction.condition.clone(),
        message: restriction.message.clone(),
        data,
    }
}

/// A balance we couldn't read → fail closed with the indeterminate message.
fn indeterminate(restriction: &Restriction, data: BTreeMap<String, f64>) -> CheckResult {
    CheckResult {
        passed: false,
        condition: restriction.condition.clone(),
        message: Some(INDETERMINATE_MSG.to_string()),
        data,
    }
}

/// A misconfigured restriction (bad expression / unknown variable) → fail closed
/// with a message that distinguishes it from a genuine balance denial.
fn config_error(restriction: &Restriction, data: BTreeMap<String, f64>, msg: &str) -> CheckResult {
    CheckResult {
        passed: false,
        condition: restriction.condition.clone(),
        message: Some(msg.to_string()),
        data,
    }
}

/// First variable identifier referenced by `tree` that wasn't provided in
/// `data`, if any.
fn missing_identifier(
    tree: &Node<DefaultNumericTypes>,
    data: &BTreeMap<String, f64>,
) -> Option<String> {
    tree.iter_variable_identifiers()
        .find(|id| !data.contains_key(*id))
        .map(|id| id.to_string())
}

/// Resolve a single token balance. `Err(())` means INDETERMINATE (bad address
/// or RPC/decimals/parse failure) — the caller fails the whole restriction
/// closed; it never substitutes 0.0.
async fn balance_for(eth: &Eth, token: &str, owner: Address) -> Result<f64, ()> {
    let token = token.parse::<Address>().map_err(|e| {
        tracing::error!("invalid token address `{token}`: {e}");
    })?;
    eth.balance_of(token, owner).await.map_err(|e| {
        tracing::warn!("balanceOf unavailable for {token}/{owner}: {e}");
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eval(condition: &str, vars: &[(&str, f64)]) -> bool {
        let mut ctx = HashMapContext::<DefaultNumericTypes>::new();
        for (k, v) in vars {
            ctx.set_value((*k).to_string(), Value::Float(*v)).unwrap();
        }
        evalexpr::eval_boolean_with_context(condition, &ctx).unwrap()
    }

    #[test]
    fn single_token_condition() {
        assert!(eval("balanceOf > 0", &[("balanceOf", 5.0)]));
        assert!(!eval("balanceOf > 0", &[("balanceOf", 0.0)]));
    }

    #[test]
    fn alias_sum_condition() {
        assert!(eval(
            "ALAbalanceOf + MAbalanceOf > 0",
            &[("ALAbalanceOf", 0.0), ("MAbalanceOf", 3.0)]
        ));
        assert!(!eval(
            "ALAbalanceOf + MAbalanceOf > 10",
            &[("ALAbalanceOf", 4.0), ("MAbalanceOf", 3.0)]
        ));
    }

    #[test]
    fn parses_restriction_shapes() {
        let single: Restriction =
            serde_json::from_str(r#"{"tokenAddress":"0xabc","condition":"balanceOf > 0"}"#)
                .unwrap();
        assert_eq!(single.token_address.as_deref(), Some("0xabc"));

        let aliased: Restriction = serde_json::from_str(
            r#"{"contractAliases":{"ALA":"0x1","MA":"0x2"},"condition":"ALAbalanceOf + MAbalanceOf > 0","message":"hi"}"#,
        )
        .unwrap();
        assert_eq!(aliased.contract_aliases.unwrap().len(), 2);
        assert_eq!(aliased.message.as_deref(), Some("hi"));
    }

    /// `decimals` scaling: a 6-decimal token (USDC-like) raw balance is divided
    /// by 1e6 before the condition sees it. Here we assert the *gate semantics*
    /// against the already-scaled value: a threshold of "at least 100 tokens"
    /// passes for 150.0 and fails for 50.5, exactly as the scaled f64 would.
    #[test]
    fn six_decimal_token_scaling_semantics() {
        // 150_000_000 raw / 1e6 = 150.0 → passes "balanceOf >= 100".
        assert!(eval("balanceOf >= 100", &[("balanceOf", 150.0)]));
        // 50_500_000 raw / 1e6 = 50.5 → fails.
        assert!(!eval("balanceOf >= 100", &[("balanceOf", 50.5)]));
    }

    /// A valid `Eth` whose RPC points at a closed local port, so any on-chain
    /// read fails fast — used to prove the fail-closed path.
    fn unreachable_eth() -> Eth {
        std::env::remove_var("ALCHEMY_API_KEY");
        std::env::remove_var("INFURA_API_KEY");
        std::env::remove_var("ETH_RPC_URL_FALLBACK");
        std::env::set_var("ETH_RPC_URL", "http://127.0.0.1:1");
        std::env::set_var("RPC_TIMEOUT_MS", "200");
        Eth::from_env().expect("build unreachable Eth")
    }

    /// An unreadable balance (RPC down) must FAIL the restriction closed with the
    /// indeterminate message — never pass, and never coerce to 0.0.
    #[tokio::test]
    async fn fails_closed_when_balance_unavailable() {
        let eth = unreachable_eth();
        let owner: Address = "0x0000000000000000000000000000000000000001"
            .parse()
            .unwrap();
        let restriction = Restriction {
            contract_aliases: None,
            // USDC mainnet address; the read still fails because the RPC is down.
            token_address: Some("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".to_string()),
            condition: "balanceOf > 0".to_string(),
            message: Some("members only".to_string()),
        };
        let result = check_one(&eth, &restriction, owner).await;
        assert!(!result.passed, "an indeterminate balance must fail closed");
        assert_eq!(result.message.as_deref(), Some(INDETERMINATE_MSG));
    }

    /// A bad token address is a config error → fail closed, distinct message,
    /// and crucially NOT a silent 0.0 pass for an `== 0` condition.
    #[tokio::test]
    async fn fails_closed_on_bad_token_address() {
        let eth = unreachable_eth();
        let owner: Address = "0x0000000000000000000000000000000000000001"
            .parse()
            .unwrap();
        let restriction = Restriction {
            contract_aliases: None,
            token_address: Some("not-an-address".to_string()),
            // Note: would *pass* if we coerced the failed read to 0.0.
            condition: "balanceOf == 0".to_string(),
            message: None,
        };
        let result = check_one(&eth, &restriction, owner).await;
        assert!(
            !result.passed,
            "a bad token address must not pass a `== 0` gate via a coerced 0.0"
        );
        assert_eq!(result.message.as_deref(), Some(INDETERMINATE_MSG));
    }

    /// A condition referencing a variable that wasn't provided is a config
    /// error, surfaced distinctly from a genuine denial. We use a token-based
    /// restriction (so `balanceOf` exists) whose condition references an
    /// undefined `MAbalanceOf`. The balance read is short-circuited by using a
    /// cache-seeded path is overkill here — instead assert the validator alone.
    #[test]
    fn missing_variable_is_detected() {
        let tree =
            evalexpr::build_operator_tree::<DefaultNumericTypes>("balanceOf + MAbalanceOf > 0")
                .unwrap();
        let mut data = BTreeMap::new();
        data.insert("balanceOf".to_string(), 1.0);
        // `MAbalanceOf` was never provided → flagged as missing.
        assert_eq!(
            missing_identifier(&tree, &data).as_deref(),
            Some("MAbalanceOf")
        );

        // When every referenced variable is present, nothing is missing.
        data.insert("MAbalanceOf".to_string(), 2.0);
        assert!(missing_identifier(&tree, &data).is_none());
    }
}
