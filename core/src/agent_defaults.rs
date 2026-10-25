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
//!
//! Codex on the Core host also takes a default model and reasoning effort,
//! from that host's catalog (`model/list`): the same chain, as one pair, so
//! an effort is always one its model offers. Nowhere else: SSH machines have
//! no catalog here, and Claude Code and OpenCode keep their own path. A
//! create request that leaves the model out inherits it; `null` asks for
//! Codex's own default and so overrides what would be inherited; an empty
//! string, as older clients send, is not taken as a choice.
use crate::{model::AgentSettings, server::ApiError, store::Store, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
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
    /// Codex on the Core host only: a model of its catalog; unset is Codex's
    /// own default there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_model: Option<String>,
    /// One of that model's reasoning efforts; unset is the model's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_reasoning_effort: Option<String>,
}

impl AgentDefaults {
    fn validate(&self) -> Result<()> {
        for name in [&self.codex_model, &self.codex_reasoning_effort].into_iter().flatten() {
            ensure!(!name.trim().is_empty() && name.len() <= 200 && !name.chars().any(char::is_control),
                "A model or reasoning effort is a name from the Codex catalog");
        }
        ensure!(self.codex_reasoning_effort.is_none() || self.codex_model.is_some(), "Choose the Codex model the reasoning effort is for");
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
    #[serde(default, deserialize_with = "present")]
    codex_model: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    codex_reasoning_effort: Option<Option<String>>,
}

/// Left out (`None`), `null` (`Some(None)`) or a value.
pub(crate) fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

/// A create request's model (Codex on the Core host reads all three).
#[derive(Clone, Debug, Default, PartialEq)]
pub enum ModelAsk {
    /// Left out, or an empty string as older clients send: not a choice.
    #[default]
    Inherit,
    /// `null`: Codex's own default, whatever a default for new Agents says.
    Native,
    Named(String),
}

impl ModelAsk {
    /// As the request's model was read before: a name, or the harness's own default.
    pub fn as_before(&self) -> String {
        match self {
            ModelAsk::Named(model) => model.clone(),
            _ => String::new(),
        }
    }
}

pub fn model_ask<'de, D: Deserializer<'de>>(d: D) -> Result<ModelAsk, D::Error> {
    Ok(match Option::<String>::deserialize(d)? {
        None => ModelAsk::Native,
        Some(model) if model.trim().is_empty() => ModelAsk::Inherit,
        Some(model) => ModelAsk::Named(model.trim().to_owned()),
    })
}

/// A model and effort as this Core host's Codex catalog (`{"models":[…]}`)
/// offers them: the model's name there, or why not.
pub fn check_in_catalog(catalog: &Value, model: &str, effort: Option<&str>) -> Result<String> {
    let models = catalog["models"].as_array().context("The Codex model list is not one this Core reads")?;
    let entry = models.iter().find(|m| m["model"].as_str() == Some(model) || m["id"].as_str() == Some(model))
        .with_context(|| format!("{model} is not among this Core host's Codex models"))?;
    if let Some(effort) = effort {
        let offered = entry["supportedReasoningEfforts"].as_array().is_some_and(|all| all.iter().any(|e| e["reasoningEffort"] == effort));
        ensure!(offered, "{model} doesn't offer the reasoning effort {effort}");
    }
    Ok(entry["model"].as_str().or_else(|| entry["id"].as_str()).unwrap_or(model).to_owned())
}

/// The model and effort a Codex Agent on the Core host gets, with where each
/// came from, and what must be checked against the catalog first.
#[derive(Debug, PartialEq)]
pub struct ModelPlan {
    /// "" is Codex's own default on the Core host.
    pub model: String,
    pub effort: Option<String>,
    /// A default's model and effort, or the request's model when it asks for
    /// an effort, with the source to name if the check fails.
    pub check: Option<(String, Option<String>, &'static str)>,
    pub sources: (&'static str, &'static str),
}

/// The request's own model first (`null` included), then the project's,
/// then the Workspace's, then Codex's own default; an effort with the model
/// it came with. `None` where this doesn't apply: the request's model is then
/// used as before, and an effort is refused.
pub fn resolve_model(
    defaults: &AgentDefaults,
    project: Option<&AgentDefaults>,
    local_codex: bool,
    asked: &ModelAsk,
    effort: Option<Option<&str>>,
) -> Result<Option<ModelPlan>> {
    if !local_codex {
        ensure!(effort.is_none(), "A reasoning effort can be chosen at creation only for Codex on the Core host");
        return Ok(None);
    }
    let asked_effort = effort.flatten().map(str::to_owned);
    let effort_source = |value: &Option<String>, layer: &'static str| if effort.is_some() { "request" } else if value.is_some() { layer } else { "builtin" };
    Ok(Some(match asked {
        ModelAsk::Named(model) => ModelPlan {
            model: model.clone(),
            check: asked_effort.as_ref().map(|e| (model.clone(), Some(e.clone()), "request")),
            sources: ("request", effort_source(&asked_effort, "request")),
            effort: asked_effort,
        },
        ModelAsk::Native => {
            ensure!(asked_effort.is_none(), "Codex's own default model takes its own reasoning effort; choose a model to choose an effort");
            ModelPlan { model: String::new(), effort: None, check: None, sources: ("request", effort_source(&None, "request")) }
        }
        ModelAsk::Inherit => {
            ensure!(asked_effort.is_none(), "Choose the Codex model the reasoning effort is for");
            let none = AgentDefaults::default();
            let project = project.unwrap_or(&none);
            let found = [(project, "project"), (defaults, "workspace")].into_iter().find(|(layer, _)| layer.codex_model.is_some());
            match found {
                Some((layer, source)) => {
                    let model = layer.codex_model.clone().unwrap_or_default();
                    // `null` asks for the model's own effort instead of the default's.
                    let effort_value = if effort.is_some() { None } else { layer.codex_reasoning_effort.clone() };
                    ModelPlan {
                        check: Some((model.clone(), effort_value.clone(), source)),
                        sources: (source, effort_source(&effort_value, source)),
                        model,
                        effort: effort_value,
                    }
                }
                None => ModelPlan { model: String::new(), effort: None, check: None, sources: ("builtin", effort_source(&None, "builtin")) },
            }
        }
    }))
}

impl Change {
    fn apply(self, mut defaults: AgentDefaults) -> AgentDefaults {
        if let Some(value) = self.harness { defaults.harness = value; }
        if let Some(value) = self.codex_permission_preset { defaults.codex_permission_preset = value; }
        if let Some(value) = self.claude_permission_mode { defaults.claude_permission_mode = value; }
        if let Some(value) = self.codex_model {
            // Back to Codex's own model: its effort goes too, unless named.
            if value.is_none() && self.codex_reasoning_effort.is_none() { defaults.codex_reasoning_effort = None; }
            defaults.codex_model = value;
        }
        if let Some(value) = self.codex_reasoning_effort { defaults.codex_reasoning_effort = value; }
        defaults
    }

    /// A change that names a model or effort, which the catalog must confirm.
    fn names_a_model(&self) -> bool {
        matches!(self.codex_model, Some(Some(_))) || matches!(self.codex_reasoning_effort, Some(Some(_)))
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
    // The model and its effort come from one layer, together.
    let (model, effort) = match [(project, "project"), (saved, "workspace")].into_iter().find(|(layer, _)| layer.codex_model.is_some()) {
        Some((layer, source)) => (
            json!({"value": layer.codex_model, "source": source}),
            json!({"value": layer.codex_reasoning_effort, "source": if layer.codex_reasoning_effort.is_some() { source } else { "builtin" }}),
        ),
        None => (json!({"value": null, "source": "builtin"}), json!({"value": null, "source": "builtin"})),
    };
    json!({
        "harness": field(&project.harness, &saved.harness, Some(BUILT_IN_HARNESS)),
        "codexPermissionPreset": field(&project.codex_permission_preset, &saved.codex_permission_preset, None),
        "claudePermissionMode": field(&project.claude_permission_mode, &saved.claude_permission_mode, Some(BUILT_IN_CLAUDE_MODE)),
        "codexModel": model,
        "codexReasoningEffort": effort,
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
        "builtIn": {"harness":BUILT_IN_HARNESS,"codexPermissionPreset":null,"claudePermissionMode":BUILT_IN_CLAUDE_MODE,"codexModel":null,"codexReasoningEffort":null},
        "effective": effective(saved, project.map_or(&none, |(_, own)| own)),
        "appliesTo": "Agents created from now on; existing Agents keep their own settings.",
        "modelAppliesTo": "Codex Agents created on the Core host. SSH machines, Claude Code and OpenCode keep their own model and effort.",
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

/// A change applied to `current` and validated; a model or effort it names
/// confirmed by this Core host's Codex catalog, as the catalog names it.
async fn checked(ws: &Arc<Workspace>, current: AgentDefaults, change: Change) -> Result<AgentDefaults> {
    let names_a_model = change.names_a_model();
    let mut next = change.apply(current);
    next.validate()?;
    if let (true, Some(model)) = (names_a_model, next.codex_model.clone()) {
        let catalog = ws.catalog().await.map_err(|e| anyhow::anyhow!("Can't read this Core host's Codex models: {e:#}; nothing was saved"))?;
        let named = check_in_catalog(&catalog, &model, next.codex_reasoning_effort.as_deref()).map_err(|e| anyhow::anyhow!("{e:#}; nothing was saved"))?;
        next.codex_model = Some(named);
    }
    Ok(next)
}

async fn set_defaults(State(ws): State<Arc<Workspace>>, Json(change): Json<Value>) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let change: Change = serde_json::from_value(change).map_err(|e| anyhow::anyhow!("Invalid defaults: {e}"))?;
    let current = ws.stored(|s| s.agent_defaults()).await?;
    let next = checked(&ws, current, change).await?;
    let saved = ws.stored(move |s| {
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
    let project = id.clone();
    // As other changes to a project: an archived one is not changed (review 404bdbd3).
    let current = ws.stored(move |s| {
        s.ensure_project_assignable(&project)?;
        s.project_agent_defaults(&project)
    }).await?;
    let next = checked(&ws, current, change).await?;
    let answer = ws.stored(move |s| {
        s.ensure_project_assignable(&id)?;
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
        assert_eq!(next, AgentDefaults { harness: Some("claude".into()), codex_permission_preset: None, claude_permission_mode: Some("auto".into()), ..Default::default() });
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

        let set = AgentDefaults { harness: Some("claude".into()), codex_permission_preset: Some("config".into()), claude_permission_mode: Some("auto".into()), ..Default::default() };
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
        let workspace = AgentDefaults { harness: Some("claude".into()), codex_permission_preset: Some("config".into()), claude_permission_mode: Some("auto".into()), ..Default::default() };
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

    #[derive(Deserialize)]
    struct Asked {
        #[serde(default, deserialize_with = "model_ask")]
        model: ModelAsk,
    }

    #[test]
    fn a_requests_model_left_out_or_empty_inherits_and_null_is_codexs_own() {
        let asked = |value: Value| serde_json::from_value::<Asked>(value).unwrap().model;
        assert_eq!(asked(json!({})), ModelAsk::Inherit);
        assert_eq!(asked(json!({"model":""})), ModelAsk::Inherit, "an empty string is not taken as a choice");
        assert_eq!(asked(json!({"model":null})), ModelAsk::Native);
        assert_eq!(asked(json!({"model":" m-big "})), ModelAsk::Named("m-big".into()));
        assert_eq!((ModelAsk::Inherit.as_before(), ModelAsk::Named("m".into()).as_before()), (String::new(), "m".into()));
    }

    fn catalog() -> Value {
        json!({"models":[
            {"id":"m-small","model":"m-small","defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"medium"}]},
            {"id":"m-big","model":"m-big","supportedReasoningEfforts":[{"reasoningEffort":"high"}]},
        ]})
    }

    #[test]
    fn a_model_and_effort_must_be_ones_the_core_hosts_catalog_offers_together() {
        assert_eq!(check_in_catalog(&catalog(), "m-small", Some("low")).unwrap(), "m-small");
        assert_eq!(check_in_catalog(&catalog(), "m-big", None).unwrap(), "m-big");
        assert!(check_in_catalog(&catalog(), "m-small", Some("high")).unwrap_err().to_string().contains("doesn't offer the reasoning effort high"));
        assert!(check_in_catalog(&catalog(), "gone", None).unwrap_err().to_string().contains("not among this Core host's Codex models"));
        assert!(check_in_catalog(&json!({}), "m-big", None).is_err(), "no list: nothing confirmed");
        // Stored: an effort needs its model in the same place; null model clears its effort.
        let saved = AgentDefaults { codex_model: Some("m-small".into()), codex_reasoning_effort: Some("low".into()), ..Default::default() };
        assert!(change(json!({"codexModel":null,"codexReasoningEffort":"low"})).apply(saved.clone()).validate().is_err());
        let cleared = change(json!({"codexModel":null})).apply(saved);
        assert_eq!((cleared.codex_model, cleared.codex_reasoning_effort), (None, None));
        assert!(change(json!({"codexModel":"m-big"})).names_a_model());
        assert!(!change(json!({"codexModel":null,"harness":"codex"})).names_a_model());
    }

    #[test]
    fn codex_on_the_core_host_takes_its_model_and_effort_from_the_request_then_project_then_workspace() {
        let workspace = AgentDefaults { codex_model: Some("m-big".into()), codex_reasoning_effort: Some("high".into()), ..Default::default() };
        let project = AgentDefaults { codex_model: Some("m-small".into()), ..Default::default() };
        let plan = |project: Option<&AgentDefaults>, asked: ModelAsk, effort: Option<Option<&str>>| resolve_model(&workspace, project, true, &asked, effort);
        // Nothing asked: the Workspace's pair, checked against the catalog first.
        let inherited = plan(None, ModelAsk::Inherit, None).unwrap().unwrap();
        assert_eq!((inherited.model.as_str(), inherited.effort.as_deref(), inherited.sources), ("m-big", Some("high"), ("workspace", "workspace")));
        assert_eq!(inherited.check, Some(("m-big".into(), Some("high".into()), "workspace")));
        // In the project: its model, with its own (none) effort, not the Workspace's.
        let in_project = plan(Some(&project), ModelAsk::Inherit, None).unwrap().unwrap();
        assert_eq!((in_project.model.as_str(), in_project.effort, in_project.sources), ("m-small", None, ("project", "builtin")));
        // Codex's own default asked for: it overrides what would be inherited.
        let native = plan(Some(&project), ModelAsk::Native, None).unwrap().unwrap();
        assert_eq!((native.model.as_str(), native.effort, native.check, native.sources), ("", None, None, ("request", "builtin")));
        // A model named: its own effort unless one is named, checked only then (older requests as before).
        let named = plan(None, ModelAsk::Named("m-small".into()), None).unwrap().unwrap();
        assert_eq!((named.effort, named.check, named.sources), (None, None, ("request", "builtin")));
        let with_effort = plan(None, ModelAsk::Named("m-small".into()), Some(Some("low"))).unwrap().unwrap();
        assert_eq!(with_effort.check, Some(("m-small".into(), Some("low".into()), "request")));
        // An effort without the model it is for, or for Codex's own model: refused.
        assert!(plan(None, ModelAsk::Inherit, Some(Some("low"))).is_err());
        assert!(plan(None, ModelAsk::Native, Some(Some("low"))).is_err());
        // No default anywhere: Codex's own, exactly as before.
        let none = resolve_model(&AgentDefaults::default(), None, true, &ModelAsk::Inherit, None).unwrap().unwrap();
        assert_eq!((none.model.as_str(), none.effort, none.check, none.sources), ("", None, None, ("builtin", "builtin")));
    }

    #[test]
    fn elsewhere_the_model_is_as_before_and_an_effort_is_refused() {
        let workspace = AgentDefaults { codex_model: Some("m-big".into()), ..Default::default() };
        // SSH machine, Claude Code or OpenCode: no model default applies.
        assert_eq!(resolve_model(&workspace, None, false, &ModelAsk::Inherit, None).unwrap(), None);
        assert_eq!(resolve_model(&workspace, None, false, &ModelAsk::Named("x".into()), None).unwrap(), None);
        assert!(resolve_model(&workspace, None, false, &ModelAsk::Named("x".into()), Some(Some("high"))).is_err());
        let shown = view(&workspace, None);
        assert_eq!(shown["effective"]["codexModel"], json!({"value":"m-big","source":"workspace"}));
        assert_eq!(shown["effective"]["codexReasoningEffort"], json!({"value":null,"source":"builtin"}));
        assert!(shown["modelAppliesTo"].as_str().unwrap().contains("SSH machines, Claude Code and OpenCode keep their own"));
    }
}
