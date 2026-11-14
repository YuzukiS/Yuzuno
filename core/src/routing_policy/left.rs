//! Whether what an executor was routed to has left the routing policy (YN-138).
//!
//! An executor keeps the candidate and the account or key it was given while
//! they are there. It has left them, and only then Core moves it, when for
//! certain:
//! - its candidate was removed (`candidateRemoved`) or turned off (`candidateOff`);
//! - its claude-swap account was taken out of its candidate's pool
//!   (`accountLeftPool`), or claude-swap no longer lists it (`accountNotListed`);
//! - its candidate's credential is another now (`credentialChanged`), or its
//!   key or Codex home is gone (`keyMissing`, `homeMissing`).
//!
//! A quota running low or a time window closing is not leaving. A reading that
//! is missing, stale or unavailable decides nothing. With routing off nothing
//! has left. This is pure: the callers read the policy, the route, the profile
//! and the readings.
use crate::routing_launch::RuntimeProfile;
use serde_json::{json, Value};

/// Why an executor's candidate, account or key has left.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Left {
    pub code: &'static str,
    pub message: String,
    pub message_zh: String,
}

impl Left {
    fn new(code: &'static str, message: impl Into<String>, message_zh: impl Into<String>) -> Self {
        Self { code, message: message.into(), message_zh: message_zh.into() }
    }

    /// As a route keeps a reason (evaluate.rs `reason`).
    pub(crate) fn reason(&self) -> Value {
        json!({"code": self.code, "message": self.message, "messageZh": self.message_zh})
    }
}

/// The candidate `route` chose, as `policy` has it now.
fn chosen<'a>(policy: &'a Value, route: &Value) -> Option<&'a Value> {
    let id = route["chosen"].as_str()?;
    policy["candidates"].as_array()?.iter().find(|c| c["id"] == id)
}

/// The account's number, for the words: as claude-swap lists it, else as the route kept it.
fn number(route: &Value, fingerprint: &str, cswap: &Value) -> String {
    let listed = cswap["accounts"].as_array().into_iter().flatten().find(|a| a["fingerprint"] == fingerprint).map(|a| &a["number"]);
    match listed.or_else(|| (route["account"]["fingerprint"] == fingerprint).then(|| &route["account"]["number"])) {
        Some(Value::Number(n)) => n.to_string(),
        _ => fingerprint.chars().take(8).collect(),
    }
}

/// Whether the claude-swap account `fingerprint` that `route` runs on has left:
/// taken out of its pool candidate's accounts, or no longer listed by a fresh
/// and available claude-swap reading (`cswap`, the readings' view).
pub(crate) fn account_left(policy: &Value, route: &Value, fingerprint: &str, cswap: &Value) -> Option<Left> {
    if policy["enabled"] != true {
        return None;
    }
    let pool = chosen(policy, route).map(|c| &c["credential"]).filter(|c| c["kind"] == "pool");
    if let Some(accounts) = pool.and_then(|c| c["accounts"].as_array()) {
        if !accounts.iter().any(|f| f == fingerprint) {
            let n = number(route, fingerprint, cswap);
            return Some(Left::new("accountLeftPool", format!("Its claude-swap account {n} was taken out of its candidate's pool"),
                format!("它绑定的 claude-swap 账号 {n} 已移出候选的账号池")));
        }
    }
    let fresh = !cswap.is_null() && cswap["stale"] != true && cswap.get("unavailable").is_none_or(Value::is_null);
    let listed = cswap["accounts"].as_array();
    if fresh && listed.is_some_and(|l| !l.iter().any(|a| a["fingerprint"] == fingerprint)) {
        let n = number(route, fingerprint, cswap);
        return Some(Left::new("accountNotListed", format!("claude-swap no longer lists its account {n}"),
            format!("claude-swap 已不再列出它的账号 {n}")));
    }
    None
}

/// Whether what `route` gave an executor, with `profile` its runtime profile now,
/// has left `policy`: `keys` are the routing keys' ids set now, `homes` the Codex
/// homes listed, `cswap` the readings' claude-swap view.
pub(crate) fn left(policy: &Value, route: &Value, profile: Option<&RuntimeProfile>, keys: &[String], homes: &[String], cswap: &Value)
    -> Option<Left> {
    if policy["enabled"] != true {
        return None;
    }
    let id = route["chosen"].as_str()?;
    let Some(candidate) = chosen(policy, route) else {
        return Some(Left::new("candidateRemoved", format!("Its candidate {id} was removed from the routing policy"),
            format!("它的候选 {id} 已从路由策略里删掉")));
    };
    if candidate["enabled"] != true {
        return Some(Left::new("candidateOff", format!("Its candidate {id} was turned off"), format!("它的候选 {id} 已关掉")));
    }
    let credential = &candidate["credential"];
    let changed = || Some(Left::new("credentialChanged", format!("Its candidate {id} runs on another account or key now"),
        format!("它的候选 {id} 现在用的是别的账号或密钥")));
    match (credential["kind"].as_str(), profile) {
        (Some("pool"), Some(RuntimeProfile::ClaudeAccount { fingerprint })) => account_left(policy, route, fingerprint, cswap),
        (Some("apiKey"), Some(RuntimeProfile::ApiKey { key_id })) => {
            if credential["keyId"] != key_id.as_str() {
                return changed();
            }
            (!keys.iter().any(|k| k == key_id)).then(|| Left::new("keyMissing", format!("The routing key {key_id} is not set"),
                format!("路由密钥 {key_id} 没有设置")))
        }
        (Some("codexHome"), Some(RuntimeProfile::CodexHome { id: home })) => {
            if credential["id"] != home.as_str() {
                return changed();
            }
            (!homes.iter().any(|h| h == home)).then(|| Left::new("homeMissing", format!("The Codex home {home} is no longer listed"),
                format!("Codex 目录 {home} 已不在列表里")))
        }
        (Some("login"), None) => None,
        // A kind it knows, with a profile of another kind (or none): the credential changed.
        (Some("pool" | "apiKey" | "codexHome" | "login"), _) => changed(),
        // A kind this Core doesn't know decides nothing.
        _ => None,
    }
}

#[cfg(test)]
#[path = "left_tests.rs"]
mod tests;
