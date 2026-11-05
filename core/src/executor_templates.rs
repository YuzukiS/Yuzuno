//! Executor templates (T-34, executor model phase 1; docs/executor-model.md):
//! what an Agent that Core creates for one task from a dispatch is made of.
//! A template names its harness, model and permissions, how its Agent is
//! named and where it works, and instructions it starts with.
//!
//! The Workspace keeps a list, and each Project its own, beside the defaults
//! for new Agents (`workspace_meta`). A dispatch names a template by its id
//! and gets the task's Project's template of that id first, else the
//! Workspace's. Lists are read leniently, so a later Core's further fields do
//! not stop this one; a save is checked strictly, against the version it was
//! read at, and replaces the whole list, keeping as it was what a later Core
//! stored that this one can't read. Only the user saves them: these are
//! browser routes, never a collaboration operation.
//!
//! Executors run on this Core host only. A template's `maxConcurrent` limits
//! how many of its executors hold a slot at once (executor_slots.rs, T-35).
use crate::{
    agent_defaults::{catalog_entry, catalog_name, check_in_catalog, CLAUDE_MODES, CODEX_PRESETS},
    server::ApiError,
    store::Store,
    workspace::Workspace,
};
use anyhow::{bail, ensure, Result};
use axum::{extract::{Path, Query, State}, routing::{get, put}, Json, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeSet, sync::Arc};

const KEY: &str = "executors.templates";
/// Where a Project's own templates are kept.
pub(crate) fn project_key(project: &str) -> String {
    format!("executors.templates.project:{project}")
}
const HARNESSES: [&str; 3] = ["codex", "claude", "opencode"];
/// An executor's name: `{task}` is the task's ID, `{label}` the template's.
pub const DEFAULT_NAME_PATTERN: &str = "{task} · {label}";
const MAX_TEMPLATES: usize = 50;
pub const MAX_INSTRUCTIONS: usize = 8 * 1024;
const MAX_CONCURRENT: u32 = 64;
/// What a save says of a `maxConcurrent` it can't take, whatever was wrong
/// with it (a negative number, a fraction, text): the editor says the same.
const AT_ONCE: &str = "At most at once is a whole number from 1 to 64";
const FIELDS: [&str; 11] = ["id", "label", "namePattern", "harness", "model", "reasoningEffort", "permissionPreset",
    "permissionMode", "machineId", "instructions", "maxConcurrent"];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub label: String,
    /// Unset is `DEFAULT_NAME_PATTERN`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_pattern: Option<String>,
    pub harness: String,
    /// Codex or Claude Code: a model of this Core host's catalog. Unset
    /// inherits the defaults for new Agents (the Project's, then the
    /// Workspace's), as an Agent created without one does. OpenCode: none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Codex only, with a model: one of that model's efforts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Codex only; unset inherits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_preset: Option<String>,
    /// Claude Code only; unset inherits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// Unset, or `local`: this Core host (phase 1 has no other).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    /// Given to the executor with its dispatch's materials, at most 8 KiB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// At most this many of its executors hold a slot at once, within the
    /// Workspace's, Project's and machine's limits (executor_slots.rs); unset
    /// adds no limit of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrent: Option<u32>,
}

/// A list as stored, with the version a save is checked against.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Templates {
    pub version: i64,
    pub templates: Vec<Template>,
    /// Templates in the list this Core can't read (a later Core's shape):
    /// not offered here, and kept as they are by a save here.
    #[serde(skip_serializing_if = "is_zero")]
    pub later_templates: usize,
    /// The list as stored, for what a save keeps.
    #[serde(skip)]
    stored: Option<Value>,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

fn single_line(value: &str, what: &str, max: usize) -> Result<()> {
    ensure!(!value.trim().is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control),
        "{what} is a line of at most {max} characters");
    Ok(())
}

fn named(value: &Option<String>, what: &str) -> Result<()> {
    if let Some(name) = value {
        ensure!(!name.trim().is_empty() && name.len() <= 200 && !name.chars().any(char::is_control),
            "{what} is a name of at most 200 bytes");
    }
    Ok(())
}

/// The placeholders a name pattern may use.
fn check_pattern(pattern: &str) -> Result<()> {
    single_line(pattern, "A name pattern", 120)?;
    let mut rest = pattern;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}') else { bail!("A name pattern's `{{` is not closed") };
        let name = &rest[open + 1..open + close];
        ensure!(matches!(name, "task" | "label"), "A name pattern can use {{task}} and {{label}}, not {{{name}}}");
        rest = &rest[open + close + 1..];
    }
    Ok(())
}

/// Phase 1 makes executors on this Core host only: no machine, or `local`.
pub(crate) fn this_host_only(machine: Option<&str>) -> Result<()> {
    if let Some(machine) = machine.filter(|m| *m != "local") {
        bail!("Executors run on this Core host in this phase, not on {machine}; other machines come with phase 2 (T-35)");
    }
    Ok(())
}

impl Template {
    /// `opencode`: whether this Core creates OpenCode Agents (`opencode_agent::enabled`).
    /// A dispatch checks its template again: a list is read leniently.
    pub(crate) fn validate(&self, opencode: bool) -> Result<()> {
        ensure!(!self.id.is_empty() && self.id.len() <= 48 && !self.id.starts_with('-')
            && self.id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
            "A template's id is 1 to 48 lowercase letters, digits and hyphens");
        single_line(&self.label, "A template's label", 80)?;
        if let Some(pattern) = &self.name_pattern {
            check_pattern(pattern)?;
        }
        ensure!(HARNESSES.contains(&self.harness.as_str()), "A template's harness is Codex, Claude Code or OpenCode, not {}", self.harness);
        named(&self.model, "A model")?;
        named(&self.reasoning_effort, "A reasoning effort")?;
        match self.harness.as_str() {
            "codex" => {
                ensure!(self.permission_mode.is_none(), "A Claude Code permission mode does not apply to a Codex template");
                ensure!(self.reasoning_effort.is_none() || self.model.is_some(), "Choose the Codex model the reasoning effort is for");
                if let Some(preset) = self.permission_preset.as_deref().filter(|p| !CODEX_PRESETS.contains(p)) {
                    bail!("Unknown Codex permission mode: {preset}");
                }
            }
            "claude" => {
                ensure!(self.permission_preset.is_none(), "A Codex permission mode does not apply to a Claude Code template");
                ensure!(self.reasoning_effort.is_none(), "A Claude Code template takes no reasoning effort; each Agent keeps its own");
                if let Some(mode) = self.permission_mode.as_deref().filter(|m| !CLAUDE_MODES.contains(m)) {
                    bail!("Unknown Claude Code permission mode: {mode}");
                }
            }
            _ => {
                ensure!(opencode, "OpenCode Agents aren't enabled on this Core");
                ensure!(self.model.is_none() && self.reasoning_effort.is_none(),
                    "An OpenCode template takes no model: an OpenCode Agent starts with its own configuration's");
                ensure!(self.permission_preset.is_none() && self.permission_mode.is_none(),
                    "OpenCode takes its permissions from its own configuration");
            }
        }
        this_host_only(self.machine_id.as_deref())?;
        if let Some(text) = &self.instructions {
            ensure!(text.len() <= MAX_INSTRUCTIONS, "A template's instructions are at most 8 KiB");
        }
        if let Some(limit) = self.max_concurrent {
            ensure!((1..=MAX_CONCURRENT).contains(&limit), "{AT_ONCE}");
        }
        Ok(())
    }

    /// The name of the executor this template makes for the task `task` (its
    /// ID): the pattern filled in, cut to the 100 bytes an Agent's name has.
    pub(crate) fn agent_name(&self, task: &str) -> String {
        let name = self.name_pattern.as_deref().unwrap_or(DEFAULT_NAME_PATTERN).replace("{task}", task).replace("{label}", &self.label);
        let name = name.trim();
        let mut end = name.len().min(100);
        while !name.is_char_boundary(end) {
            end -= 1;
        }
        name[..end].trim_end().to_owned()
    }

    /// Whether a save must check its model against this host's catalog: it
    /// names one, and not the one the saved template of its id has.
    fn names_new_model(&self, saved: &[Template]) -> bool {
        self.model.is_some() && !saved.iter().any(|t| t.id == self.id && t.harness == self.harness
            && t.model == self.model && t.reasoning_effort == self.reasoning_effort && t.permission_mode == self.permission_mode)
    }
}

/// A stored template as this Core can use it: one it reads, whose values it
/// accepts. A later Core's template that reads but holds what this Core
/// refuses (another harness or machine, a larger limit) is not this Core's
/// (R2 70093e91). OpenCode's gate is not part of it: an OpenCode template
/// saved while OpenCode was enabled stays this Core's own.
fn readable(value: &Value) -> Option<Template> {
    let template: Template = serde_json::from_value(value.clone()).ok()?;
    template.validate(true).ok().map(|_| template)
}

/// A list read leniently: a template this Core can't use (a later Core's)
/// is left out of what it offers, not an error.
fn read_list(raw: Option<String>) -> Result<Templates> {
    let Some(raw) = raw else { return Ok(Templates::default()) };
    let value: Value = serde_json::from_str(&raw)?;
    let all = value["templates"].as_array().cloned().unwrap_or_default();
    let templates: Vec<Template> = all.iter().filter_map(readable).collect();
    Ok(Templates {
        version: value["version"].as_i64().unwrap_or(0),
        later_templates: all.len() - templates.len(),
        templates,
        stored: Some(value),
    })
}

/// What a save stores: the templates it names, with what a later Core
/// stored that this Core doesn't read kept as it was, so a save here never
/// drops it: each named template's fields this Core doesn't know, the
/// templates it can't use (unless the save names their id, which replaces
/// one whole), and the list's own fields.
fn stored_list(current: &Templates, templates: &[Template], version: i64) -> Result<Value> {
    let mut stored = current.stored.as_ref().and_then(Value::as_object).cloned().unwrap_or_default();
    let before: Vec<Value> = stored.get("templates").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut items = Vec::with_capacity(templates.len());
    for template in templates {
        let mut item = serde_json::to_value(template)?;
        // Only from a template this Core can use: one it can't is replaced
        // as sent, never mixed with its fields (R3 46d5d3d0).
        let old = before.iter().find(|old| old["id"] == template.id.as_str()).filter(|old| readable(old).is_some());
        if let Some(old) = old.and_then(Value::as_object) {
            for (field, value) in old.iter().filter(|(field, _)| !FIELDS.contains(&field.as_str())) {
                item[field] = value.clone();
            }
        }
        items.push(item);
    }
    let named = |old: &Value| old["id"].as_str().is_some_and(|id| templates.iter().any(|t| t.id == id));
    items.extend(before.iter().filter(|old| readable(old).is_none() && !named(old)).cloned());
    stored.insert("version".into(), version.into());
    stored.insert("templates".into(), items.into());
    Ok(Value::Object(stored))
}

fn list_at(db: &Connection, key: &str) -> Result<Templates> {
    read_list(db.query_row("SELECT value FROM workspace_meta WHERE key=?1", [key], |r| r.get(0)).optional()?)
}

/// The template of this id a dispatch of a task in `project` gets: the
/// Project's own, else the Workspace's, and which one it is.
pub(crate) fn template_in(db: &Connection, project: Option<&str>, id: &str) -> Result<Option<(Template, &'static str)>> {
    if let Some(project) = project {
        if let Some(own) = list_at(db, &project_key(project))?.templates.into_iter().find(|t| t.id == id) {
            return Ok(Some((own, "project")));
        }
    }
    Ok(list_at(db, KEY)?.templates.into_iter().find(|t| t.id == id).map(|t| (t, "workspace")))
}

/// The templates a save names, each checked strictly: no field this Core
/// doesn't know, every value valid, each id once. While OpenCode is off
/// (`opencode` false), an OpenCode template saved before stays, and stays
/// editable, so the rest of the list does too (R2 70093e91, R4 42f066e2):
/// no new one is added, and a dispatch from one is refused.
fn parse_save(templates: &[Value], opencode: bool, saved: &[Template]) -> Result<Vec<Template>> {
    ensure!(templates.len() <= MAX_TEMPLATES, "At most {MAX_TEMPLATES} templates");
    let mut parsed = Vec::with_capacity(templates.len());
    for value in templates {
        let Some(object) = value.as_object() else { bail!("A template is an object") };
        if let Some(field) = object.keys().find(|k| !FIELDS.contains(&k.as_str())) {
            bail!("Unknown template field: {field}");
        }
        // Before serde, whose own words for a negative number or a fraction
        // the user would see instead.
        if let Some(limit) = object.get("maxConcurrent").filter(|v| !v.is_null()) {
            ensure!(limit.as_u64().is_some_and(|n| (1..=u64::from(MAX_CONCURRENT)).contains(&n)), "{AT_ONCE}");
        }
        let template: Template = serde_json::from_value(value.clone()).map_err(|e| anyhow::anyhow!("Invalid template: {e}"))?;
        let kept = saved.iter().any(|t| t.id == template.id && t.harness == "opencode");
        template.validate(opencode || kept)?;
        parsed.push(template);
    }
    let ids: BTreeSet<_> = parsed.iter().map(|t| t.id.as_str()).collect();
    ensure!(ids.len() == parsed.len(), "Each template id must be used once");
    Ok(parsed)
}

/// This Core host's catalogs a save needs, read before its transaction.
struct Catalogs {
    codex: Option<Result<Value>>,
    claude: Option<Result<Value>>,
}

/// A model each template names, as the catalog names it. A model unchanged
/// from the saved template of its id is not checked again.
fn confirm_models(templates: &mut [Template], saved: &[Template], catalogs: &Catalogs) -> Result<()> {
    let read = |catalog: &Option<Result<Value>>, harness: &str| -> Result<Value> {
        match catalog {
            Some(Ok(catalog)) => Ok(catalog.clone()),
            Some(Err(e)) => bail!("Can't read this Core host's {harness} models: {e:#}; nothing was saved"),
            None => bail!("Can't read this Core host's {harness} models; nothing was saved"),
        }
    };
    for template in templates.iter_mut().filter(|t| t.names_new_model(saved)) {
        let model = template.model.clone().unwrap_or_default();
        match template.harness.as_str() {
            "codex" => {
                let catalog = read(&catalogs.codex, "Codex")?;
                let checked = check_in_catalog(&catalog, &model, template.reasoning_effort.as_deref())
                    .map_err(|e| anyhow::anyhow!("{}: {e:#}; nothing was saved", template.label))?;
                template.model = Some(checked);
            }
            "claude" => {
                let catalog = read(&catalogs.claude, "Claude Code")?;
                let entry = catalog_entry(&catalog, "Claude Code", &model)
                    .map_err(|e| anyhow::anyhow!("{}: {e:#}; nothing was saved", template.label))?;
                ensure!(!(entry["supportsAutoMode"] == false && template.permission_mode.as_deref() == Some("auto")),
                    "{}: {model} can't run in Auto mode; nothing was saved", template.label);
                template.model = Some(catalog_name(entry, &model));
            }
            _ => {}
        }
    }
    Ok(())
}

impl Store {
    pub(crate) fn executor_templates(&self) -> Result<Templates> {
        list_at(&*self.db.read()?, KEY)
    }

    /// A Project's own templates; none saved is an empty list.
    pub(crate) fn project_executor_templates(&self, project: &str) -> Result<Templates> {
        let db = self.db.read()?;
        crate::projects::ensure_exists(&db, project)?;
        list_at(&db, &project_key(project))
    }

    /// `template_in`, read on its own.
    #[cfg(test)]
    pub(crate) fn executor_template(&self, project: Option<&str>, id: &str) -> Result<Option<(Template, &'static str)>> {
        template_in(&*self.db.read()?, project, id)
    }

    /// Replaces the list at `key`, checked against `expected` in the same
    /// transaction; the version moves on with every save, an empty list too.
    fn save_templates_at(&self, key: &str, project: Option<&str>, expected: i64, templates: Vec<Template>) -> Result<Templates> {
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        if let Some(project) = project {
            crate::projects::ensure_assignable(&tx, project)?;
        }
        let current = list_at(&tx, key)?;
        ensure!(current.version == expected, "version_conflict: these executor templates changed; reload before saving");
        let stored = stored_list(&current, &templates, current.version + 1)?.to_string();
        tx.execute(
            "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, stored],
        )?;
        tx.commit()?;
        read_list(Some(stored))
    }
}

/// The lists, and what a dispatch can use: for a Project, its own templates
/// and the Workspace's whose id it doesn't use itself.
fn view(workspace: &Templates, project: Option<(&str, &Templates)>) -> Value {
    let mut available: Vec<Value> = vec![];
    if let Some((_, own)) = project {
        available.extend(own.templates.iter().map(|t| json!({"template": t, "source": "project"})));
    }
    let shadowed = |id: &str| project.is_some_and(|(_, own)| own.templates.iter().any(|t| t.id == id));
    available.extend(workspace.templates.iter().filter(|t| !shadowed(&t.id)).map(|t| json!({"template": t, "source": "workspace"})));
    let mut view = json!({
        "workspace": workspace,
        "available": available,
        "defaultNamePattern": DEFAULT_NAME_PATTERN,
        "limits": {"templates": MAX_TEMPLATES, "instructionsBytes": MAX_INSTRUCTIONS, "maxConcurrent": MAX_CONCURRENT},
        "opencodeEnabled": crate::opencode_agent::enabled(),
        "appliesTo": "Dispatches from a template from now on; executors already created keep their own settings.",
    });
    if let Some((id, own)) = project {
        view["project"] = json!({"id": id, "version": own.version, "templates": own.templates});
        if own.later_templates > 0 {
            view["project"]["laterTemplates"] = own.later_templates.into();
        }
    }
    view
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForProject {
    #[serde(default)]
    project_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    expected_version: i64,
    templates: Vec<Value>,
}

async fn get_templates(State(ws): State<Arc<Workspace>>, Query(query): Query<ForProject>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.stored(move |s| {
        let workspace = s.executor_templates()?;
        Ok(match query.project_id {
            Some(id) => {
                let own = s.project_executor_templates(&id)?;
                view(&workspace, Some((&id, &own)))
            }
            None => view(&workspace, None),
        })
    }).await?))
}

/// Parses and checks a save, and reads the catalogs its new models need
/// before the store transaction: a catalog can take long.
async fn prepared(ws: &Arc<Workspace>, input: &Save, saved: Templates) -> Result<Vec<Template>> {
    let mut templates = parse_save(&input.templates, crate::opencode_agent::enabled(), &saved.templates)?;
    let local = |harness: &str| templates.iter().any(|t| t.harness == harness && t.names_new_model(&saved.templates));
    let catalogs = Catalogs {
        codex: if local("codex") { Some(ws.catalog().await) } else { None },
        claude: if local("claude") { Some(ws.claude_catalog().await) } else { None },
    };
    confirm_models(&mut templates, &saved.templates, &catalogs)?;
    Ok(templates)
}

async fn put_templates(State(ws): State<Arc<Workspace>>, Json(input): Json<Save>) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let current = ws.stored(|s| s.executor_templates()).await?;
    let templates = prepared(&ws, &input, current).await?;
    let saved = ws.stored(move |s| s.save_templates_at(KEY, None, input.expected_version, templates)).await?;
    ws.changes.send(json!({"executorTemplates": true}));
    Ok(Json(view(&saved, None)))
}

async fn put_project_templates(
    State(ws): State<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(input): Json<Save>,
) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let project = id.clone();
    let current = ws.stored(move |s| s.project_executor_templates(&project)).await?;
    let templates = prepared(&ws, &input, current).await?;
    let project = id.clone();
    let answer = ws.stored(move |s| {
        let saved = s.save_templates_at(&project_key(&project), Some(&project), input.expected_version, templates)?;
        Ok(view(&s.executor_templates()?, Some((&project, &saved))))
    }).await?;
    ws.changes.send(json!({"executorTemplates": true, "projectId": id}));
    Ok(Json(answer))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/executor-templates", get(get_templates).put(put_templates))
        .route("/api/projects/{id}/executor-templates", put(put_project_templates))
}

#[cfg(test)]
#[path = "executor_templates_tests.rs"]
mod tests;
