//! Defaults for new Agents (T-190): the Workspace's own choice of harness and
//! of each harness's permissions, used only when an Agent is created. Unset
//! means Yuzuno's built-in behaviour, and clearing a choice deletes it rather
//! than copying the built-in value. Existing Agents keep their own record;
//! whether a permission is allowed is still decided when each Agent starts
//! on its machine (Codex's requirements, the mode Claude Code reports).
//!
//! A project may override the same fields for Agents created in it: the
//! create request's own choice, then the project's, then the Workspace's,
//! then the built-in behaviour. Clearing a project's choice deletes only that
//! override; the project then inherits again. It is kept beside the
//! Workspace's (`workspace_meta`), not in the project's record, which older
//! Cores rewrite without the fields they don't know.
use crate::{model::AgentSettings, server::ApiError, store::Store, workspace::Workspace};
use anyhow::{bail, Result};
use axum::{extract::{Path, Query, State}, routing::{get, post}, Json, Router};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

const KEY: &str = "agents.defaults";
/// Where a project's overrides are kept.
pub(crate) fn project_key(project: &str) -> String {
    format!("agents.defaults.project:{project}")
}
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
/// ("request", "project", "workspace" or "builtin").
pub struct Resolved {
    pub harness: String,
    pub settings: AgentSettings,
    pub sources: Value,
}

/// A value and the layer it came from: the request's own, the project's,
/// the Workspace's, or none of them (the built-in behaviour).
fn layered<'a>(asked: Option<&'a str>, project: Option<&'a str>, workspace: Option<&'a str>) -> (Option<&'a str>, &'static str) {
    match (asked, project, workspace) {
        (Some(value), _, _) => (Some(value), "request"),
        (None, Some(value), _) => (Some(value), "project"),
        (None, None, Some(value)) => (Some(value), "workspace"),
        (None, None, None) => (None, "builtin"),
    }
}

/// The create request's own choice first, then the chosen project's
/// override, then the Workspace's default, then the built-in behaviour. A
/// permission of the other harness is refused when asked for and ignored
/// when it is only a default.
pub fn resolve(
    defaults: &AgentDefaults,
    project: Option<&AgentDefaults>,
    harness: Option<&str>,
    permission_preset: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<Resolved> {
    let none = AgentDefaults::default();
    let project = project.unwrap_or(&none);
    let (chosen, harness_source) = layered(harness, project.harness.as_deref(), defaults.harness.as_deref());
    let harness = chosen.unwrap_or(BUILT_IN_HARNESS).to_owned();
    let mut settings = AgentSettings::default();
    let permission = match harness.as_str() {
        "codex" => {
            if permission_mode.is_some() {
                bail!("A Claude Code permission mode does not apply to a Codex Agent");
            }
            if let Some(preset) = permission_preset.filter(|p| !CODEX_PRESETS.contains(p)) {
                bail!("Unknown Codex permission mode: {preset}");
            }
            let (preset, source) = layered(permission_preset, project.codex_permission_preset.as_deref(), defaults.codex_permission_preset.as_deref());
            settings.permission_preset = preset.map(str::to_owned);
            source
        }
        "claude" => {
            if permission_preset.is_some() {
                bail!("A Codex permission mode does not apply to a Claude Code Agent");
            }
            if let Some(mode) = permission_mode.filter(|m| !CLAUDE_MODES.contains(m)) {
                bail!("Unknown Claude Code permission mode: {mode}");
            }
            let (mode, source) = layered(permission_mode, project.claude_permission_mode.as_deref(), defaults.claude_permission_mode.as_deref());
            settings.permission_mode = mode.map(str::to_owned);
            source
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
    fn defaults_at(&self, key: &str) -> Result<AgentDefaults> {
        let raw: Option<String> = self.db.read()?
            .query_row("SELECT value FROM workspace_meta WHERE key=?1", [key], |r| r.get(0))
            .optional()?;
        Ok(match raw {
            Some(raw) => serde_json::from_str(&raw)?,
            None => AgentDefaults::default(),
        })
    }

    /// No choice left is no row: inherited (or built in) again.
    fn save_defaults_at(&self, key: &str, defaults: &AgentDefaults) -> Result<()> {
        let db = self.db.write()?;
        if *defaults == AgentDefaults::default() {
            db.execute("DELETE FROM workspace_meta WHERE key=?1", [key])?;
        } else {
            db.execute(
                "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![key, serde_json::to_string(defaults)?],
            )?;
        }
        Ok(())
    }

    pub(crate) fn agent_defaults(&self) -> Result<AgentDefaults> {
        self.defaults_at(KEY)
    }

    pub(crate) fn save_agent_defaults(&self, defaults: &AgentDefaults) -> Result<()> {
        self.save_defaults_at(KEY, defaults)
    }

    /// A project's own overrides; none saved is no override.
    pub(crate) fn project_agent_defaults(&self, project: &str) -> Result<AgentDefaults> {
        self.defaults_at(&project_key(project))
    }

    pub(crate) fn save_project_agent_defaults(&self, project: &str, defaults: &AgentDefaults) -> Result<()> {
        self.save_defaults_at(&project_key(project), defaults)
    }
}

/// Each field's value for a new Agent and where it came from, given the
/// Workspace's choices and, in a project, its overrides.
fn effective(saved: &AgentDefaults, project: &AgentDefaults) -> Value {
    let field = |project: &Option<String>, saved: &Option<String>, built_in: Option<&str>| {
        let (value, source) = layered(None, project.as_deref(), saved.as_deref());
        json!({"value": value.or(built_in), "source": source})
    };
    json!({
        "harness": field(&project.harness, &saved.harness, Some(BUILT_IN_HARNESS)),
        "codexPermissionPreset": field(&project.codex_permission_preset, &saved.codex_permission_preset, None),
        "claudePermissionMode": field(&project.claude_permission_mode, &saved.claude_permission_mode, Some(BUILT_IN_CLAUDE_MODE)),
    })
}

/// The saved choices, the built-in behaviour, and what a new Agent gets now
/// with the source of each; for a project, also its own overrides and what
/// it inherits without them. A Codex preset of `null` is Yuzuno's legacy
/// "Ask for approval" (on-request, workspace-write).
fn view(saved: &AgentDefaults, project: Option<(&str, &AgentDefaults)>) -> Value {
    let none = AgentDefaults::default();
    let mut view = json!({
        "saved": saved,
        "builtIn": {"harness":BUILT_IN_HARNESS,"codexPermissionPreset":null,"claudePermissionMode":BUILT_IN_CLAUDE_MODE},
        "effective": effective(saved, project.map_or(&none, |(_, own)| own)),
        "appliesTo": "Agents created from now on; existing Agents keep their own settings.",
    });
    if let Some((id, own)) = project {
        view["project"] = json!({"id": id, "saved": own, "inherited": effective(saved, &none)});
    }
    view
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForProject {
    #[serde(default)]
    project_id: Option<String>,
}

async fn get_defaults(State(ws): State<Arc<Workspace>>, Query(query): Query<ForProject>) -> Result<Json<Value>, ApiError> {
    let answer = ws.stored(move |s| {
        let saved = s.agent_defaults()?;
        Ok(match query.project_id {
            Some(id) => {
                s.project(&id)?;
                let own = s.project_agent_defaults(&id)?;
                view(&saved, Some((&id, &own)))
            }
            None => view(&saved, None),
        })
    }).await?;
    Ok(Json(answer))
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
    Ok(Json(view(&saved, None)))
}

/// A project's overrides: a field left out stays as it is, `null` deletes
/// only this project's choice, so it inherits again.
async fn set_project_defaults(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(change): Json<Value>) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let change: Change = serde_json::from_value(change).map_err(|e| anyhow::anyhow!("Invalid defaults: {e}"))?;
    let answer = ws.stored(move |s| {
        // As other changes to a project: an archived one is not changed (review 404bdbd3).
        s.ensure_project_assignable(&id)?;
        let next = change.apply(s.project_agent_defaults(&id)?);
        next.validate()?;
        s.save_project_agent_defaults(&id, &next)?;
        Ok(view(&s.agent_defaults()?, Some((&id, &next))))
    }).await?;
    ws.changes.send(json!({"agentDefaults":true}));
    Ok(Json(answer))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/agent-defaults", get(get_defaults).post(set_defaults))
        .route("/api/projects/{id}/agent-defaults", post(set_project_defaults))
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
        let built_in = resolve(&none, None, None, None, None).unwrap();
        assert_eq!((built_in.harness.as_str(), built_in.settings.permission_preset.as_deref()), ("codex", None));
        assert_eq!(built_in.settings, AgentSettings::default(), "nothing set: exactly as before");
        assert_eq!(built_in.sources, json!({"harness":"builtin","permission":"builtin"}));

        let set = AgentDefaults { harness: Some("claude".into()), codex_permission_preset: Some("config".into()), claude_permission_mode: Some("auto".into()) };
        let workspace = resolve(&set, None, None, None, None).unwrap();
        assert_eq!((workspace.harness.as_str(), workspace.settings.permission_mode.as_deref()), ("claude", Some("auto")));
        assert_eq!(workspace.settings.permission_preset, None, "a Codex default does not reach a Claude Agent");
        assert_eq!(workspace.sources, json!({"harness":"workspace","permission":"workspace"}));

        let codex = resolve(&set, None, Some("codex"), None, None).unwrap();
        assert_eq!(codex.settings.permission_preset.as_deref(), Some("config"));
        assert_eq!(codex.settings.permission_mode, None, "a Claude default does not reach a Codex Agent");
        assert_eq!(codex.sources, json!({"harness":"request","permission":"workspace"}));

        let asked = resolve(&set, None, Some("codex"), Some("ask"), None).unwrap();
        assert_eq!(asked.settings.permission_preset.as_deref(), Some("ask"));
        assert_eq!(asked.sources["permission"], "request");
    }

    #[test]
    fn a_permission_for_the_other_harness_or_an_unknown_one_is_refused() {
        let none = AgentDefaults::default();
        assert!(resolve(&none, None, Some("codex"), None, Some("auto")).is_err());
        assert!(resolve(&none, None, Some("claude"), Some("full"), None).is_err());
        assert!(resolve(&none, None, Some("codex"), Some("bypass"), None).is_err());
        assert!(resolve(&none, None, Some("claude"), None, Some("bypassPermissions")).is_err());
        assert!(resolve(&none, None, Some("opencode"), Some("ask"), None).is_err());
        let opencode = resolve(&AgentDefaults { codex_permission_preset: Some("full".into()), ..Default::default() }, None, Some("opencode"), None, None).unwrap();
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

    #[test]
    fn in_a_project_its_override_comes_after_the_request_and_before_the_workspace() {
        let workspace = AgentDefaults { harness: Some("claude".into()), codex_permission_preset: Some("config".into()), claude_permission_mode: Some("auto".into()) };
        let project = AgentDefaults { harness: Some("codex".into()), codex_permission_preset: Some("full".into()), ..Default::default() };
        // The project's harness and Codex permissions; nothing asked.
        let new = resolve(&workspace, Some(&project), None, None, None).unwrap();
        assert_eq!((new.harness.as_str(), new.settings.permission_preset.as_deref()), ("codex", Some("full")));
        assert_eq!(new.sources, json!({"harness":"project","permission":"project"}));
        // The request's own choice still wins.
        let asked = resolve(&workspace, Some(&project), None, Some("ask"), None).unwrap();
        assert_eq!((asked.settings.permission_preset.as_deref(), &asked.sources["permission"]), (Some("ask"), &json!("request")));
        // A Claude Agent asked for in it: the project sets no Claude mode, so the Workspace's applies,
        // and the project's Codex permissions are not carried over.
        let claude = resolve(&workspace, Some(&project), Some("claude"), None, None).unwrap();
        assert_eq!((claude.settings.permission_mode.as_deref(), claude.settings.permission_preset.as_deref()), (Some("auto"), None));
        assert_eq!(claude.sources, json!({"harness":"request","permission":"workspace"}));
        // Another harness's permission asked for in a project is still refused.
        assert!(resolve(&workspace, Some(&project), None, None, Some("auto")).is_err());
        // No project, or a project with no overrides: as before.
        let outside = resolve(&workspace, None, None, None, None).unwrap();
        let plain = resolve(&workspace, Some(&AgentDefaults::default()), None, None, None).unwrap();
        assert_eq!((outside.harness, outside.sources), (plain.harness, plain.sources));
    }

    #[test]
    fn a_projects_overrides_are_its_own_and_go_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        let project = store.create_project("Lab", Default::default()).unwrap();
        store.save_agent_defaults(&AgentDefaults { harness: Some("claude".into()), ..Default::default() }).unwrap();
        let own = change(json!({"harness":"codex","codexPermissionPreset":"auto"})).apply(store.project_agent_defaults(&project.id).unwrap());
        store.save_project_agent_defaults(&project.id, &own).unwrap();
        // null deletes only that override; a field left out stays.
        let next = change(json!({"harness":null})).apply(store.project_agent_defaults(&project.id).unwrap());
        assert_eq!(next, AgentDefaults { codex_permission_preset: Some("auto".into()), ..Default::default() });
        store.save_project_agent_defaults(&project.id, &next).unwrap();
        assert_eq!(store.agent_defaults().unwrap().harness.as_deref(), Some("claude"), "the Workspace's choice is untouched");
        let shown = view(&store.agent_defaults().unwrap(), Some((&project.id, &next)));
        assert_eq!(shown["effective"]["harness"], json!({"value":"claude","source":"workspace"}), "inherited again");
        assert_eq!(shown["effective"]["codexPermissionPreset"], json!({"value":"auto","source":"project"}));
        assert_eq!(shown["project"]["inherited"]["codexPermissionPreset"], json!({"value":null,"source":"builtin"}));
        // Deleting the project deletes its overrides; none left is no row.
        store.delete_project(&project.id).unwrap();
        let rows: i64 = store.db.read().unwrap()
            .query_row("SELECT COUNT(*) FROM workspace_meta WHERE key LIKE 'agents.defaults.project:%'", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0);
    }
}
