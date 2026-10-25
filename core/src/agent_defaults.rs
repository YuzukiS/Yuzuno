//! Defaults for new Agents (T-190): the Workspace's own choice of harness and
//! of each harness's permissions, used only when an Agent is created. Unset
//! means Yuzuno's built-in behaviour, and clearing a choice deletes it rather
//! than copying the built-in value. Existing Agents keep their own record;
//! whether a permission is allowed is still decided when each Agent starts
//! on its machine (Codex's requirements, the mode Claude Code reports).
use crate::{model::AgentSettings, server::ApiError, store::Store, workspace::Workspace};
use anyhow::{bail, Result};
use axum::{extract::State, routing::get, Json, Router};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

const KEY: &str = "agents.defaults";
const HARNESSES: [&str; 2] = ["codex", "claude"];
/// `config` follows the machine's Codex configuration; the others are
/// Yuzuno's own choice (`permissions::resolve`).
const CODEX_PRESETS: [&str; 4] = ["config", "ask", "auto", "full"];
/// The modes a Claude Agent can select (`claude::SELECTABLE_PERMISSION_MODES`).
const CLAUDE_MODES: [&str; 2] = ["default", "auto"];
const BUILT_IN_HARNESS: &str = "codex";
const BUILT_IN_CLAUDE_MODE: &str = "default";

/// As stored. Read leniently, so a later Core's further defaults do not stop
/// this one reading the ones it knows.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_permission_preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_permission_mode: Option<String>,
}

impl AgentDefaults {
    fn validate(&self) -> Result<()> {
        if let Some(harness) = self.harness.as_deref().filter(|h| !HARNESSES.contains(h)) {
            bail!("A new Agent's harness can be Codex or Claude Code, not {harness}");
        }
        if let Some(preset) = self.codex_permission_preset.as_deref().filter(|p| !CODEX_PRESETS.contains(p)) {
            bail!("Unknown Codex permission mode: {preset}");
        }
        if let Some(mode) = self.claude_permission_mode.as_deref().filter(|m| !CLAUDE_MODES.contains(m)) {
            bail!("Unknown Claude Code permission mode: {mode}");
        }
        Ok(())
    }
}

/// A change: a field left out stays as it is, `null` deletes that choice.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Change {
    #[serde(default, deserialize_with = "present")]
    harness: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    codex_permission_preset: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    claude_permission_mode: Option<Option<String>>,
}

fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

impl Change {
    fn apply(self, mut defaults: AgentDefaults) -> AgentDefaults {
        if let Some(value) = self.harness { defaults.harness = value; }
        if let Some(value) = self.codex_permission_preset { defaults.codex_permission_preset = value; }
        if let Some(value) = self.claude_permission_mode { defaults.claude_permission_mode = value; }
        defaults
    }
}

/// What a new Agent gets: its harness and settings, and where each came from
/// ("request", "workspace" or "builtin").
pub struct Resolved {
    pub harness: String,
    pub settings: AgentSettings,
    pub sources: Value,
}

/// The create request's own choice first, then the Workspace's default, then
/// the built-in behaviour. A permission of the other harness is refused when
/// asked for and ignored when it is only a default.
pub fn resolve(
    defaults: &AgentDefaults,
    harness: Option<&str>,
    permission_preset: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<Resolved> {
    let source = |asked: bool, saved: bool| if asked { "request" } else if saved { "workspace" } else { "builtin" };
    let harness_source = source(harness.is_some(), defaults.harness.is_some());
    let harness = harness.or(defaults.harness.as_deref()).unwrap_or(BUILT_IN_HARNESS).to_owned();
    let mut settings = AgentSettings::default();
    let permission = match harness.as_str() {
        "codex" => {
            if permission_mode.is_some() {
                bail!("A Claude Code permission mode does not apply to a Codex Agent");
            }
            if let Some(preset) = permission_preset.filter(|p| !CODEX_PRESETS.contains(p)) {
                bail!("Unknown Codex permission mode: {preset}");
            }
            settings.permission_preset = permission_preset.or(defaults.codex_permission_preset.as_deref()).map(str::to_owned);
            source(permission_preset.is_some(), defaults.codex_permission_preset.is_some())
        }
        "claude" => {
            if permission_preset.is_some() {
                bail!("A Codex permission mode does not apply to a Claude Code Agent");
            }
            if let Some(mode) = permission_mode.filter(|m| !CLAUDE_MODES.contains(m)) {
                bail!("Unknown Claude Code permission mode: {mode}");
            }
            settings.permission_mode = permission_mode.or(defaults.claude_permission_mode.as_deref()).map(str::to_owned);
            source(permission_mode.is_some(), defaults.claude_permission_mode.is_some())
        }
        _ => {
            if permission_preset.is_some() || permission_mode.is_some() {
                bail!("This harness takes its permissions from its own configuration");
            }
            "builtin"
        }
    };
    Ok(Resolved { harness, settings, sources: json!({"harness":harness_source,"permission":permission}) })
}

impl Store {
    pub(crate) fn agent_defaults(&self) -> Result<AgentDefaults> {
        let raw: Option<String> = self.db.read()?
            .query_row("SELECT value FROM workspace_meta WHERE key=?1", [KEY], |r| r.get(0))
            .optional()?;
        Ok(match raw {
            Some(raw) => serde_json::from_str(&raw)?,
            None => AgentDefaults::default(),
        })
    }

    /// No choice left is no row: the built-in behaviour again.
    pub(crate) fn save_agent_defaults(&self, defaults: &AgentDefaults) -> Result<()> {
        let db = self.db.write()?;
        if *defaults == AgentDefaults::default() {
            db.execute("DELETE FROM workspace_meta WHERE key=?1", [KEY])?;
        } else {
            db.execute(
                "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![KEY, serde_json::to_string(defaults)?],
            )?;
        }
        Ok(())
    }
}

/// The saved choices, the built-in behaviour, and what a new Agent gets now
/// with the source of each. A Codex preset of `null` is Yuzuno's legacy "Ask
/// for approval" (on-request, workspace-write).
fn view(saved: &AgentDefaults) -> Value {
    let from = |set: bool| if set { "workspace" } else { "builtin" };
    json!({
        "saved": saved,
        "builtIn": {"harness":BUILT_IN_HARNESS,"codexPermissionPreset":null,"claudePermissionMode":BUILT_IN_CLAUDE_MODE},
        "effective": {
            "harness": {"value":saved.harness.as_deref().unwrap_or(BUILT_IN_HARNESS),"source":from(saved.harness.is_some())},
            "codexPermissionPreset": {"value":saved.codex_permission_preset,"source":from(saved.codex_permission_preset.is_some())},
            "claudePermissionMode": {"value":saved.claude_permission_mode.as_deref().unwrap_or(BUILT_IN_CLAUDE_MODE),
                "source":from(saved.claude_permission_mode.is_some())},
        },
        "appliesTo": "Agents created from now on; existing Agents keep their own settings.",
    })
}

async fn get_defaults(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    let saved = ws.stored(|s| s.agent_defaults()).await?;
    Ok(Json(view(&saved)))
}

async fn set_defaults(State(ws): State<Arc<Workspace>>, Json(change): Json<Value>) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let change: Change = serde_json::from_value(change).map_err(|e| anyhow::anyhow!("Invalid defaults: {e}"))?;
    let saved = ws.stored(move |s| {
        let next = change.apply(s.agent_defaults()?);
        next.validate()?;
        s.save_agent_defaults(&next)?;
        Ok(next)
    }).await?;
    ws.changes.send(json!({"agentDefaults":true}));
    Ok(Json(view(&saved)))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/agent-defaults", get(get_defaults).post(set_defaults))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(value: Value) -> Change {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_change_leaves_out_what_it_does_not_name_and_null_deletes_a_choice() {
        let saved = AgentDefaults { harness: Some("claude".into()), codex_permission_preset: Some("config".into()), ..Default::default() };
        let next = change(json!({"codexPermissionPreset":null,"claudePermissionMode":"auto"})).apply(saved);
        assert_eq!(next, AgentDefaults { harness: Some("claude".into()), codex_permission_preset: None, claude_permission_mode: Some("auto".into()) });
        assert!(serde_json::from_value::<Change>(json!({"model":"x"})).is_err(), "an unknown default is refused");
        for wrong in [json!({"harness":"opencode"}), json!({"codexPermissionPreset":"yolo"}), json!({"claudePermissionMode":"bypassPermissions"})] {
            assert!(change(wrong.clone()).apply(AgentDefaults::default()).validate().is_err(), "{wrong}");
        }
    }

    #[test]
    fn a_new_agent_takes_its_request_then_the_workspace_default_then_the_built_in() {
        let none = AgentDefaults::default();
        let built_in = resolve(&none, None, None, None).unwrap();
        assert_eq!((built_in.harness.as_str(), built_in.settings.permission_preset.as_deref()), ("codex", None));
        assert_eq!(built_in.settings, AgentSettings::default(), "nothing set: exactly as before");
        assert_eq!(built_in.sources, json!({"harness":"builtin","permission":"builtin"}));

        let set = AgentDefaults { harness: Some("claude".into()), codex_permission_preset: Some("config".into()), claude_permission_mode: Some("auto".into()) };
        let workspace = resolve(&set, None, None, None).unwrap();
        assert_eq!((workspace.harness.as_str(), workspace.settings.permission_mode.as_deref()), ("claude", Some("auto")));
        assert_eq!(workspace.settings.permission_preset, None, "a Codex default does not reach a Claude Agent");
        assert_eq!(workspace.sources, json!({"harness":"workspace","permission":"workspace"}));

        let codex = resolve(&set, Some("codex"), None, None).unwrap();
        assert_eq!(codex.settings.permission_preset.as_deref(), Some("config"));
        assert_eq!(codex.settings.permission_mode, None, "a Claude default does not reach a Codex Agent");
        assert_eq!(codex.sources, json!({"harness":"request","permission":"workspace"}));

        let asked = resolve(&set, Some("codex"), Some("ask"), None).unwrap();
        assert_eq!(asked.settings.permission_preset.as_deref(), Some("ask"));
        assert_eq!(asked.sources["permission"], "request");
    }

    #[test]
    fn a_permission_for_the_other_harness_or_an_unknown_one_is_refused() {
        let none = AgentDefaults::default();
        assert!(resolve(&none, Some("codex"), None, Some("auto")).is_err());
        assert!(resolve(&none, Some("claude"), Some("full"), None).is_err());
        assert!(resolve(&none, Some("codex"), Some("bypass"), None).is_err());
        assert!(resolve(&none, Some("claude"), None, Some("bypassPermissions")).is_err());
        assert!(resolve(&none, Some("opencode"), Some("ask"), None).is_err());
        let opencode = resolve(&AgentDefaults { codex_permission_preset: Some("full".into()), ..Default::default() }, Some("opencode"), None, None).unwrap();
        assert_eq!(opencode.settings, AgentSettings::default());
    }

    #[test]
    fn the_stored_defaults_are_read_leniently_and_no_choice_is_no_row() {
        let later: AgentDefaults = serde_json::from_value(json!({"harness":"claude","codexModel":"later-core"})).unwrap();
        assert_eq!(later.harness.as_deref(), Some("claude"));
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        assert_eq!(store.agent_defaults().unwrap(), AgentDefaults::default());
        store.save_agent_defaults(&AgentDefaults { claude_permission_mode: Some("auto".into()), ..Default::default() }).unwrap();
        assert_eq!(store.agent_defaults().unwrap().claude_permission_mode.as_deref(), Some("auto"));
        store.save_agent_defaults(&AgentDefaults::default()).unwrap();
        let rows: i64 = store.db.read().unwrap()
            .query_row("SELECT COUNT(*) FROM workspace_meta WHERE key=?1", [KEY], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "cleared: the built-in behaviour again, no copied value");
    }
}
