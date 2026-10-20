//! Per-Agent native context settings. Requested values are never usage evidence.
use crate::{model::{AgentDetail, AgentSettings}, rpc::Rpc};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex};

// JSON integers must round-trip exactly through the browser and fit native i64
// arithmetic (including the native compaction multiplication by nine).
const MAX_TOKENS: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Overrides {
    pub context_window: Option<u64>,
    pub auto_compact_token_limit: Option<u64>,
}
impl From<&AgentSettings> for Overrides {
    fn from(s: &AgentSettings) -> Self {
        Self { context_window: s.context_window, auto_compact_token_limit: s.auto_compact_token_limit }
    }
}
impl Overrides {
    pub fn custom(&self) -> bool { self.context_window.is_some() || self.auto_compact_token_limit.is_some() }
    pub fn validate(&self) -> Result<()> {
        for (name, value) in [("上下文窗口", self.context_window), ("自动压缩阈值", self.auto_compact_token_limit)] {
            if value.is_some_and(|n| n == 0 || n > MAX_TOKENS) { bail!("{name}必须是 1 到 {MAX_TOKENS} 之间的整数"); }
        }
        if let (Some(window), Some(limit)) = (self.context_window, self.auto_compact_token_limit) {
            if limit > window { bail!("自动压缩阈值不能超过配置的上下文窗口；Codex 还会按模型限制降低阈值"); }
        }
        Ok(())
    }
}

/// Merge, never replace, the config shared with permissions, effort and MCP.
/// Omission means native config/model default. JSON null is NOT an unset in
/// Codex 0.162.1: it becomes an invalid empty string for these integer keys.
pub(crate) fn apply(settings: &AgentSettings, params: &mut Value) {
    let overrides = Overrides::from(settings);
    if let Some(effort) = &settings.reasoning_effort { params["config"]["model_reasoning_effort"] = effort.clone().into(); }
    if let Some(window) = overrides.context_window { params["config"]["model_context_window"] = window.into(); }
    // A custom window's automatic threshold follows that window, replacing
    // an inherited low threshold. Native Codex clamps both to its model caps.
    let compact = overrides.auto_compact_token_limit.or_else(|| overrides.context_window.map(|w| (w * 9 / 10).max(1)));
    if let Some(limit) = compact { params["config"]["model_auto_compact_token_limit"] = limit.into(); }
}

pub(crate) fn capability(config: &Value) -> bool {
    config.get("model_context_window").is_some() && config.get("model_auto_compact_token_limit").is_some()
}
pub(crate) async fn check(rpc: &Rpc, cwd: &str, settings: &AgentSettings) -> Result<()> {
    let requested = Overrides::from(settings);
    requested.validate()?;
    if requested.custom() {
        let response = rpc.request("config/read", json!({"cwd":cwd,"includeLayers":false})).await?;
        if !capability(&response["config"]) { bail!("此执行机器的 Codex 未报告上下文配置能力；请先更新该机器的 Codex，配置未应用"); }
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct State {
    applied: Mutex<HashMap<String, (u64, Overrides, bool)>>,
    awaiting_turn: Mutex<HashMap<String, (u64, Option<String>)>>,
    resume_needed: Mutex<HashMap<String, u64>>,
}
impl State {
    pub fn needs_resume(&self, id: &str, generation: u64) -> bool {
        self.resume_needed.lock().unwrap().get(id) == Some(&generation)
    }
    pub fn require_resume(&self, id: &str, generation: u64) {
        self.resume_needed.lock().unwrap().insert(id.into(), generation);
    }
    pub fn awaiting_fresh_usage(&self, id: &str, generation: u64) {
        self.awaiting_turn.lock().unwrap().insert(id.into(), (generation, None));
    }
    /// A surviving remote thread can already be running when we reattach.
    /// Its matching usage is live evidence; replay from older turns is not.
    pub fn resumed_running_turn(&self, id: &str, generation: u64, thread: &Value) {
        let active = thread["turns"].as_array().and_then(|turns| turns.iter().rev()
            .find(|turn| turn["status"] == "inProgress")).and_then(|turn| turn["id"].as_str());
        let mut awaiting = self.awaiting_turn.lock().unwrap();
        if let Some((g, allowed)) = awaiting.get_mut(id) {
            if *g == generation { *allowed = active.map(str::to_owned); }
        }
    }
    /// Resume can replay the OLD window even after native config changed.
    /// Only a new turn, or the confirmed active remote turn, is evidence.
    pub fn accepts_usage_event(&self, id: &str, generation: u64, method: &str, turn_id: Option<&str>) -> bool {
        let mut awaiting = self.awaiting_turn.lock().unwrap();
        let Some((g, active)) = awaiting.get(id) else { return true; };
        if *g != generation { return true; }
        if method == "thread/tokenUsage/updated" {
            return turn_id.is_some() && active.as_deref() == turn_id;
        }
        if method == "turn/started" { awaiting.remove(id); }
        true
    }
    pub fn attached(&self, id: &str, generation: u64, settings: &AgentSettings, fresh: bool) {
        let mut needed = self.resume_needed.lock().unwrap();
        if needed.get(id) == Some(&generation) { needed.remove(id); }
        self.applied.lock().unwrap().insert(id.into(), (generation, settings.into(), fresh));
    }
    pub fn detached(&self, id: &str, generation: u64) {
        let mut needed = self.resume_needed.lock().unwrap();
        if needed.get(id) == Some(&generation) { needed.remove(id); }
        let mut awaiting = self.awaiting_turn.lock().unwrap();
        if awaiting.get(id).is_some_and(|(g, _)| *g == generation) { awaiting.remove(id); }
        let mut entries = self.applied.lock().unwrap();
        if entries.get(id).is_some_and(|entry| entry.0 == generation) { entries.remove(id); }
    }
    pub fn submitted(&self, id: &str, generation: u64, settings: &AgentSettings) -> bool {
        !self.needs_resume(id, generation) && self.applied.lock().unwrap().get(id).is_some_and(|(g, s, fresh)| *g == generation && *fresh && *s == Overrides::from(settings))
    }
}

pub(crate) fn idle(detail: &AgentDetail) -> bool {
    detail.agent.closed_at.is_none()
        && detail.agent.connection_state == "connected"
        && detail.agent.status == "idle"
        && detail.pending.is_empty()
        && !detail.turns.iter().any(|t| t["status"] == "inProgress")
        && !detail.message_receipts.iter().any(|r| matches!(r.status.as_str(), "sending" | "uncertain"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_omit_integer_keys_and_custom_window_replaces_inherited_threshold() {
        let mut p = json!({"config":{"mcp_servers":{"yuzuno":{"enabled":true}},"approvals_reviewer":"auto_review"}});
        let mut settings = AgentSettings::default();
        apply(&settings, &mut p);
        assert!(p["config"].get("model_context_window").is_none());
        settings.reasoning_effort = Some("xhigh".into()); settings.context_window = Some(872_000);
        apply(&settings, &mut p);
        assert_eq!(p["config"]["model_auto_compact_token_limit"], 784_800);
        assert_eq!(p["config"]["model_context_window"], 872_000);
        assert_eq!(p["config"]["model_reasoning_effort"], "xhigh");
        assert_eq!(p["config"]["mcp_servers"]["yuzuno"]["enabled"], true);
        assert_eq!(p["config"]["approvals_reviewer"], "auto_review");
        settings.auto_compact_token_limit = Some(600_000); apply(&settings, &mut p);
        assert_eq!(p["config"]["model_auto_compact_token_limit"], 600_000);
    }
    #[test]
    fn validates_native_integer_and_cross_field_boundaries() {
        for n in [0, MAX_TOKENS + 1, u64::MAX] {
            assert!(Overrides { context_window: Some(n), ..Default::default() }.validate().is_err());
            assert!(Overrides { auto_compact_token_limit: Some(n), ..Default::default() }.validate().is_err());
        }
        assert!(Overrides { context_window: Some(1), ..Default::default() }.validate().is_ok());
        assert!(Overrides { context_window: Some(100), auto_compact_token_limit: Some(101) }.validate().is_err());
        assert!(!capability(&json!({})));
        assert!(capability(&json!({"model_context_window":null,"model_auto_compact_token_limit":null})));
    }
    #[test]
    fn cached_resume_usage_cannot_confirm_new_settings() {
        let state = State::default();
        state.awaiting_fresh_usage("a", 3);
        assert!(!state.accepts_usage_event("a", 3, "thread/tokenUsage/updated", Some("old")));
        assert!(state.accepts_usage_event("b", 3, "thread/tokenUsage/updated", Some("old")));
        assert!(state.accepts_usage_event("a", 3, "turn/started", None));
        assert!(state.accepts_usage_event("a", 3, "thread/tokenUsage/updated", Some("new")));
    }
    #[test]
    fn resumed_remote_turn_accepts_its_usage_but_not_older_replay() {
        let state = State::default();
        state.awaiting_fresh_usage("a", 3);
        let thread = json!({"turns":[{"id":"old","status":"completed"},{"id":"active","status":"inProgress"}]});
        state.resumed_running_turn("a", 2, &thread);
        assert!(!state.accepts_usage_event("a", 3, "thread/tokenUsage/updated", Some("active")));
        state.resumed_running_turn("a", 3, &thread);
        assert!(state.accepts_usage_event("a", 3, "thread/tokenUsage/updated", Some("active")));
        assert!(!state.accepts_usage_event("a", 3, "thread/tokenUsage/updated", Some("old")));
        assert!(!state.accepts_usage_event("a", 3, "thread/tokenUsage/updated", None));
        state.awaiting_fresh_usage("a", 3);
        assert!(!state.accepts_usage_event("a", 3, "thread/tokenUsage/updated", Some("active")));
    }
    #[test]
    fn attachment_evidence_is_agent_and_generation_scoped() {
        let state = State::default(); let mut s = AgentSettings::default(); s.context_window = Some(872000);
        state.attached("a", 2, &s, true);
        assert!(state.submitted("a", 2, &s)); assert!(!state.submitted("b", 2, &s));
        state.detached("a", 1); assert!(state.submitted("a", 2, &s));
        state.require_resume("a", 2);
        assert!(!state.submitted("a", 2, &s));
        state.detached("a", 1); assert!(state.needs_resume("a", 2));
        state.attached("a", 2, &s, true);
        assert!(!state.needs_resume("a", 2)); assert!(state.submitted("a", 2, &s));
        assert!(!state.submitted("a", 3, &s));
        state.attached("a", 3, &s, false); assert!(!state.submitted("a", 3, &s));
    }
}
