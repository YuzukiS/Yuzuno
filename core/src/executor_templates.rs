//! Executor templates (T-34, executor model phase 1; docs/executor-model.md):
//! what an Agent that Core creates for one task from a dispatch is made of.
//! A template names its harness, model and permissions, how its Agent is
//! named and where it works, and instructions it starts with.
//!
//! The Workspace keeps one list, beside the defaults for new Agents
//! (`workspace_meta`), and a dispatch names a template of it by its id
//! (YN-2 S2). Project lists an earlier Core kept are copied into it once at
//! open (`migrate`) and stay stored as they were; no dispatch reads them.
//! Lists are read leniently, so a later Core's further fields do
//! not stop this one; a save is checked strictly, against the version it was
//! read at, and replaces the whole list, keeping as it was what a later Core
//! stored that this one can't read. Only the user saves them: these are
//! browser routes, never a collaboration operation.
//!
//! A template's executors run on this Core host, on the machine it names, or
//! on the one Core chooses for each dispatch (`auto`, T-35 S3b); a
//! dispatch's own machineId wins (T-35 S3a). How many run at once is each
//! machine's limit alone (executor_slots.rs, YN-2 S5), not a template's.
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
/// Where a Project's own templates were kept before YN-2 S2: read only by
/// `migrate`, and removed with their Project (projects.rs).
pub(crate) fn project_key(project: &str) -> String {
    format!("executors.templates.project:{project}")
}
const HARNESSES: [&str; 3] = ["codex", "claude", "opencode"];
/// An executor's name: `{task}` is the task's ID, `{label}` the template's.
pub const DEFAULT_NAME_PATTERN: &str = "{task} · {label}";
/// The general executor's label (YN-2), so its name is `{task} · Executor`.
pub const GENERAL_LABEL: &str = "Executor";
const MAX_TEMPLATES: usize = 50;
pub const MAX_INSTRUCTIONS: usize = 8 * 1024;
/// `maxConcurrent` is a field an older page still sends (YN-2 S5): a
/// template has no limit of its own any more, only each machine has. For
/// one release a save that sends it is taken and the value dropped; the
/// release after refuses it as unknown.
const FIELDS: [&str; 12] = ["id", "label", "namePattern", "harness", "model", "reasoningEffort", "permissionPreset",
    "permissionMode", "machineId", "instructions", "maxConcurrent", "origin"];
/// The Project lists the migration has copied, each at the version it read.
const MOVED: &str = "executors.templates.moved";

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
    /// Where its executors run: unset or `local` for this Core host, a
    /// registered machine's id (T-35 S3a), or `auto` for the one Core chooses
    /// at each dispatch (S3b); a dispatch's own machineId wins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    /// Given to the executor with its dispatch's materials, at most 8 KiB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// A template the migration copied from a Project's own list (YN-2 S2):
    /// which Project, and the id it had there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
}

/// Where a copied template came from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub project_id: String,
    pub project_name: String,
    pub id: String,
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

/// A machine a template or a dispatch names for its executors: `local`, a
/// registered machine's id, which a dispatch checks against the Machines
/// list, or `auto`, for Core to choose one at each dispatch
/// (collaboration_store/executor_choice.rs, T-35 S3b). OpenCode runs on this
/// Core host only (`opencode_create_on`): `auto` chooses it.
pub(crate) fn machine_named(machine: Option<&str>, harness: &str) -> Result<()> {
    let Some(machine) = machine else { return Ok(()) };
    ensure!(!machine.is_empty() && machine.len() <= 128 && !machine.chars().any(char::is_control),
        "A machine is named by its id, at most 128 characters");
    ensure!(matches!(machine, "local" | "auto") || harness != "opencode", "OpenCode executors run on this Core host only, not on {machine}");
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
        machine_named(self.machine_id.as_deref(), &self.harness)?;
        if let Some(text) = &self.instructions {
            ensure!(text.len() <= MAX_INSTRUCTIONS, "A template's instructions are at most 8 KiB");
        }
        if let Some(origin) = &self.origin {
            for part in [&origin.project_id, &origin.project_name, &origin.id] {
                ensure!(part.len() <= 200 && !part.chars().any(char::is_control), "A template's origin names its Project and id, at most 200 bytes each");
            }
        }
        Ok(())
    }

    /// The general executor a dispatch with no `templateId` makes (YN-2):
    /// `harness` is the new-Agent default of the task's Project, else the
    /// Workspace's, and everything else is unset, so the executor inherits
    /// the defaults for new Agents as any new Agent does. It has no
    /// instructions of its own: the Project's handover and the task's
    /// materials are its instructions. Its id is empty, which no saved
    /// template can have.
    pub(crate) fn general(harness: String) -> Self {
        Self {
            id: String::new(), label: GENERAL_LABEL.into(), name_pattern: None, harness, model: None, reasoning_effort: None,
            permission_preset: None, permission_mode: None, machine_id: None, instructions: None, origin: None,
        }
    }

    /// What a dispatch's materials say of this template, from the list
    /// `source` names (`workspace`, or `builtin` for the general executor,
    /// whose id is none; `project` in materials from before YN-2 S2).
    pub(crate) fn given(&self, source: &str) -> Value {
        let id = (!self.id.is_empty()).then_some(self.id.as_str());
        json!({"id":id,"label":self.label,"source":source,"instructions":self.instructions})
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

/// The Workspace's template of this id, which a dispatch names.
pub(crate) fn template(db: &Connection, id: &str) -> Result<Option<Template>> {
    Ok(list_at(db, KEY)?.templates.into_iter().find(|t| t.id == id))
}

/// The template ids a dispatch can name, for a refusal that names none of them.
pub(crate) fn ids(db: &Connection) -> Result<Vec<String>> {
    Ok(list_at(db, KEY)?.templates.into_iter().map(|t| t.id).collect())
}

/// The template presets the user can adopt in Settings: template-shaped
/// objects, never stored by Core and never saved by an Agent. T-43 fills
/// this list; adopting one is the user's ordinary save.
pub(crate) fn presets() -> Vec<Value> {
    Vec::new()
}

/// A stored template without these fields.
fn without(value: &Value, fields: &[&str]) -> Value {
    let mut value = value.clone();
    if let Some(object) = value.as_object_mut() {
        for field in fields {
            object.remove(*field);
        }
    }
    value
}

/// Whether `item`, of the Workspace's list, is `template` of `project`'s
/// list already: the same stored template, or a copy made of it under a free
/// id and a label naming its Project.
fn holds(item: &Value, template: &Value, project: &str) -> bool {
    without(item, &["origin"]) == without(template, &["origin"])
        || (item["origin"]["projectId"] == project && item["origin"]["id"] == template["id"]
            && without(item, &["origin", "id", "label"]) == without(template, &["origin", "id", "label"]))
}

/// `text` cut to `max` characters.
fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The first `<id>-2`, `<id>-3`… no template in `items` has, at most 48 bytes.
fn free_id(items: &[Value], id: &str) -> String {
    (2..).map(|n| {
        let suffix = format!("-{n}");
        let base: String = id.chars().take(48 - suffix.len()).collect();
        format!("{}{suffix}", base.trim_end_matches('-'))
    }).find(|candidate| !items.iter().any(|item| item["id"] == candidate.as_str())).unwrap()
}

/// YN-2 S2, on every open: each Project's own template list an earlier Core
/// kept is copied into the Workspace's once per version of it, so a list an
/// older Core saved again later is copied again. A template already there as
/// it is (the same id and fields, or an earlier copy of it) is not copied;
/// one whose id the Workspace uses for another gets the first free
/// `<id>-<n>` and its Project's name in its label; each copy says where it
/// came from (`origin`). The Project lists are left as they are, and a
/// template this Core can't read stays in its list. In one transaction.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    let lists: Vec<(String, String)> = db
        .prepare("SELECT key, value FROM workspace_meta WHERE key LIKE 'executors.templates.project:%' ORDER BY key")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if lists.is_empty() {
        return Ok(());
    }
    let tx = db.unchecked_transaction()?;
    let raw_moved: Option<String> = tx.query_row("SELECT value FROM workspace_meta WHERE key=?1", [MOVED], |r| r.get(0)).optional()?;
    let mut moved = raw_moved.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let workspace = list_at(&tx, KEY)?;
    let mut stored = workspace.stored.clone().unwrap_or_else(|| json!({"version": 0, "templates": []}));
    let mut items: Vec<Value> = stored["templates"].as_array().cloned().unwrap_or_default();
    let mut appended = false;
    for (key, raw) in lists {
        let project = key.trim_start_matches("executors.templates.project:").to_owned();
        let Ok(list) = serde_json::from_str::<Value>(&raw) else { continue };
        let version = list["version"].as_i64().unwrap_or(0);
        if moved.get(&project).and_then(Value::as_i64).is_some_and(|done| done >= version) {
            continue;
        }
        let name: Option<String> = tx
            .query_row("SELECT json_extract(data,'$.name') FROM projects WHERE id=?1", [&project], |r| r.get(0))
            .optional()?
            .flatten();
        // A Project that is gone takes its list with it (projects.rs).
        let Some(name) = name else { continue };
        for template in list["templates"].as_array().into_iter().flatten().filter(|t| readable(t).is_some()) {
            let id = template["id"].as_str().unwrap_or_default().to_owned();
            if items.iter().any(|item| holds(item, template, &project)) {
                continue;
            }
            let mut copy = template.clone();
            copy["origin"] = json!({"projectId": project, "projectName": name, "id": id});
            if items.iter().any(|item| item["id"] == id.as_str()) {
                copy["id"] = json!(free_id(&items, &id));
                let suffix = format!(" ({})", cut(&name, 40));
                let label = template["label"].as_str().unwrap_or(&id);
                copy["label"] = json!(format!("{}{suffix}", cut(label, 80 - suffix.chars().count())));
            }
            items.push(copy);
            appended = true;
        }
        moved.insert(project, version.into());
    }
    if appended {
        stored["version"] = json!(workspace.version + 1);
        stored["templates"] = json!(items);
        tx.execute("INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![KEY, stored.to_string()])?;
    }
    tx.execute("INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![MOVED, Value::Object(moved).to_string()])?;
    tx.commit()?;
    Ok(())
}

/// The templates a save names, each checked strictly: no field this Core
/// doesn't know, every value valid, each id once. While OpenCode is off
/// (`opencode` false), an OpenCode template saved before stays, and stays
/// editable, so the rest of the list does too (R2 70093e91, R4 42f066e2):
/// no new one is added, and a dispatch from one is refused.
fn parse_save(templates: &[Value], opencode: bool, saved: &[Template]) -> Result<Vec<Template>> {
    // The migration may have passed the limit: a list keeps what it holds.
    let most = MAX_TEMPLATES.max(saved.len());
    ensure!(templates.len() <= most, "At most {most} templates");
    let mut parsed = Vec::with_capacity(templates.len());
    for value in templates {
        let Some(object) = value.as_object() else { bail!("A template is an object") };
        if let Some(field) = object.keys().find(|k| !FIELDS.contains(&k.as_str())) {
            bail!("Unknown template field: {field}");
        }
        // An older page's `maxConcurrent` is taken and dropped (S5): Template has no such field.
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

    /// `template`, read on its own.
    #[cfg(test)]
    pub(crate) fn executor_template(&self, id: &str) -> Result<Option<Template>> {
        template(&*self.db.read()?, id)
    }

    /// Replaces the Workspace's list, checked against `expected` in the same
    /// transaction; the version moves on with every save, an empty list too.
    fn save_templates(&self, expected: i64, templates: Vec<Template>) -> Result<Templates> {
        let key = KEY;
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
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

/// The Workspace's list, what a dispatch can use (the same templates, for
/// clients that read `available`), and the presets the user can adopt.
fn view(workspace: &Templates) -> Value {
    let available: Vec<Value> = workspace.templates.iter().map(|t| json!({"template": t, "source": "workspace"})).collect();
    json!({
        "workspace": workspace,
        "available": available,
        "presets": presets(),
        "defaultNamePattern": DEFAULT_NAME_PATTERN,
        // A list the migration took past the limit keeps what it holds.
        "limits": {"templates": MAX_TEMPLATES.max(workspace.templates.len()), "instructionsBytes": MAX_INSTRUCTIONS},
        "opencodeEnabled": crate::opencode_agent::enabled(),
        "appliesTo": "Dispatches from a template from now on; executors already created keep their own settings.",
    })
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

/// What a general executor (YN-2, `executor: {}`) of a task in `project`
/// would be made with now: its harness and where that came from.
fn general_view(store: &Store, project: Option<&str>) -> Result<Value> {
    let (harness, source) = crate::agent_defaults::new_agent_harness(&*store.db.read()?, project)?;
    Ok(json!({"label": GENERAL_LABEL, "harness": harness, "harnessSource": source}))
}

async fn get_templates(State(ws): State<Arc<Workspace>>, Query(query): Query<ForProject>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.stored(move |s| {
        if let Some(id) = &query.project_id {
            crate::projects::ensure_exists(&*s.db.read()?, id)?;
        }
        let mut answer = view(&s.executor_templates()?);
        // A Project's id says whose new-Agent defaults the general executor takes.
        answer["general"] = general_view(s, query.project_id.as_deref())?;
        Ok(answer)
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
    let saved = ws.stored(move |s| s.save_templates(input.expected_version, templates)).await?;
    ws.changes.send(json!({"executorTemplates": true}));
    Ok(Json(view(&saved)))
}

/// A page from before YN-2 S2 saving a Project's own list is told where
/// templates are now; nothing is written.
async fn put_project_templates(Path(_id): Path<String>) -> Result<Json<Value>, ApiError> {
    Err(anyhow::anyhow!("setting_moved: executor templates are kept for the whole Workspace now, in Settings → Executor templates; \
        this Project's own were copied there. Nothing was saved; reload the page").into())
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/executor-templates", get(get_templates).put(put_templates))
        .route("/api/projects/{id}/executor-templates", put(put_project_templates))
}

#[cfg(test)]
#[path = "executor_templates_tests.rs"]
mod tests;
