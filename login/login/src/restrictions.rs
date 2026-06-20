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
use evalexpr::{ContextWithMutableVariables, DefaultNumericTypes, HashMapContext, Value};
use serde::{Deserialize, Serialize};

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

    if let Some(aliases) = &restriction.contract_aliases {
        for (name, token) in aliases {
            let key = format!("{name}balanceOf");
            let value = balance_for(eth, token, owner).await;
            data.insert(key.clone(), value);
            let _ = context.set_value(key, Value::Float(value));
        }
    }

    if let Some(token) = &restriction.token_address {
        let key = "balanceOf".to_string();
        let value = balance_for(eth, token, owner).await;
        data.insert(key.clone(), value);
        let _ = context.set_value(key, Value::Float(value));
    }

    let passed = match evalexpr::eval_boolean_with_context(&restriction.condition, &context) {
        Ok(result) => result,
        Err(e) => {
            tracing::warn!("condition `{}` failed to evaluate: {e}", restriction.condition);
            false
        }
    };

    CheckResult {
        passed,
        condition: restriction.condition.clone(),
        message: restriction.message.clone(),
        data,
    }
}

async fn balance_for(eth: &Eth, token: &str, owner: Address) -> f64 {
    match token.parse::<Address>() {
        Ok(token) => eth.balance_of(token, owner).await,
        Err(e) => {
            tracing::warn!("invalid token address `{token}`: {e}");
            0.0
        }
    }
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
            serde_json::from_str(r#"{"tokenAddress":"0xabc","condition":"balanceOf > 0"}"#).unwrap();
        assert_eq!(single.token_address.as_deref(), Some("0xabc"));

        let aliased: Restriction = serde_json::from_str(
            r#"{"contractAliases":{"ALA":"0x1","MA":"0x2"},"condition":"ALAbalanceOf + MAbalanceOf > 0","message":"hi"}"#,
        )
        .unwrap();
        assert_eq!(aliased.contract_aliases.unwrap().len(), 2);
        assert_eq!(aliased.message.as_deref(), Some("hi"));
    }
}
