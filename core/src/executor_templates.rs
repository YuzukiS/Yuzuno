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
//! stored that this one can't read. The user saves them through these
//! browser routes, and a lead of a Project with `executor_templates_change`
//! (executor_template_changes.rs, YN-24); each save is a row of the list's
//! history there.
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

pub(crate) const KEY: &str = "executors.templates";
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
pub(crate) const MAX_TEMPLATES: usize = 50;
pub const MAX_INSTRUCTIONS: usize = 8 * 1024;
/// `maxConcurrent` is a field an older page still sends (YN-2 S5): a
/// template has no limit of its own any more, only each machine has. For
/// one release a save that sends it is taken and the value dropped; the
/// release after refuses it as unknown.
/// What `limits.maxConcurrent` still answers, for that same release: a
/// template page from before S5 reads its field's bound from it.
const OLDER_PAGES_MAX_CONCURRENT: u32 = 64;
const FIELDS: [&str; 15] = ["id", "label", "namePattern", "harness", "model", "reasoningEffort", "permissionPreset",
    "permissionMode", "machineId", "instructions", "maxConcurrent", "origin", "deliveryMode", "steps", "whenToChoose"];
/// How a template's work is delivered (YN-23, T-43 S1a): a pull request
/// (unset, as every template saved before), a commit without one, or no
/// repository change at all. Said in its executors' materials; Core holds
/// no PR, review or merge operation to it.
pub const DELIVERY_MODES: [&str; 3] = ["pr", "direct-commit", "none"];
/// The kinds a template's steps have, and those only a `pr` template has.
const STEP_KINDS: [&str; 9] = ["materials", "work", "result", "gate", "job", "pr", "review", "ci", "merge"];
const PR_STEP_KINDS: [&str; 4] = ["pr", "review", "ci", "merge"];
const STEP_FIELDS: [&str; 4] = ["kind", "label", "rounds", "approver"];
/// Who answers a gate step; unset is the user.
const APPROVERS: [&str; 3] = ["user", "lead", "either"];
pub const MAX_STEPS: usize = 12;
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
    /// One of `DELIVERY_MODES`; unset is `pr`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_mode: Option<String>,
    /// 1 to 12 steps its executors follow, descriptive for now: Core keeps
    /// no state of them. Unset is its delivery mode's (`default_steps`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<Step>>,
    /// One line, at most 200 characters: what work to choose it for, read
    /// by a lead choosing a template (`executor_templates_list`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when_to_choose: Option<String>,
}

/// A step of a template (YN-23). A step with a field this Core doesn't know
/// doesn't read, so its template is a later Core's: kept as it is by a save.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    /// One of `STEP_KINDS`.
    pub kind: String,
    /// What the step is, at most 60 characters; unset is its kind alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// A review step's rounds, 1 or 2; unset is 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rounds: Option<i64>,
    /// A gate step's approver, one of `APPROVERS`; unset is the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approver: Option<String>,
}

impl Step {
    fn of(kind: &str) -> Self {
        Self { kind: kind.into(), label: None, rounds: None, approver: None }
    }

    /// Checked as the editor shows it: `n` is the step's place, from 1.
    fn validate(&self, n: usize, delivery: &str) -> Result<()> {
        let kind = self.kind.as_str();
        ensure!(STEP_KINDS.contains(&kind), "Step {n}: a step is materials, work, result, gate, job, pr, review, ci or merge, not {kind}");
        ensure!(delivery == "pr" || !PR_STEP_KINDS.contains(&kind), "Step {n}: a {kind} step is for a template delivered by pull request (pr), not {delivery}");
        if let Some(label) = &self.label {
            single_line(label, &format!("Step {n}'s label"), 60)?;
        }
        match self.rounds {
            Some(_) if kind != "review" => bail!("Step {n}: only a review step has rounds"),
            Some(rounds) => ensure!((1..=2).contains(&rounds), "Step {n}: a review is 1 or 2 rounds"),
            None => {}
        }
        match self.approver.as_deref() {
            Some(_) if kind != "gate" => bail!("Step {n}: only a gate step has an approver"),
            Some(approver) => ensure!(APPROVERS.contains(&approver), "Step {n}: a gate's approver is user, lead or either, not {approver}"),
            None => {}
        }
        Ok(())
    }
}

/// The steps of a template that sets none, by its delivery mode.
pub fn default_steps(delivery: &str) -> Vec<Step> {
    let kinds: &[&str] = match delivery {
        "direct-commit" => &["materials", "work", "job", "result"],
        "none" => &["materials", "work", "result"],
        _ => &["materials", "work", "job", "pr", "review", "ci", "merge"],
    };
    kinds.iter().map(|kind| Step::of(kind)).collect()
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

impl Templates {
    /// The stored templates, a later Core's too, as stored.
    pub(crate) fn stored_templates(&self) -> Vec<Value> {
        self.stored.as_ref().and_then(|s| s["templates"].as_array().cloned()).unwrap_or_default()
    }
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
        if let Some(mode) = self.delivery_mode.as_deref() {
            ensure!(DELIVERY_MODES.contains(&mode), "A template's delivery is pr, direct-commit or none, not {mode}");
        }
        if let Some(steps) = &self.steps {
            ensure!((1..=MAX_STEPS).contains(&steps.len()), "A template has 1 to {MAX_STEPS} steps");
            for (n, step) in steps.iter().enumerate() {
                step.validate(n + 1, self.delivery())?;
            }
        }
        if let Some(line) = &self.when_to_choose {
            single_line(line, "When to choose it", 200)?;
        }
        Ok(())
    }

    /// Its delivery mode: unset is `pr`, today's flow.
    pub(crate) fn delivery(&self) -> &str {
        self.delivery_mode.as_deref().unwrap_or("pr")
    }

    /// Its steps, or its delivery mode's when it sets none.
    pub(crate) fn resolved_steps(&self) -> Vec<Step> {
        self.steps.clone().unwrap_or_else(|| default_steps(self.delivery()))
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
            delivery_mode: None, steps: None, when_to_choose: None,
        }
    }

    /// What a dispatch's materials say of this template, from the list
    /// `source` names (`workspace`, or `builtin` for the general executor,
    /// whose id is none; `project` in materials from before YN-2 S2). A
    /// template's also say how its work is delivered and its steps, resolved
    /// (YN-23), and when to choose it if it says; the general executor's say
    /// neither, as before.
    pub(crate) fn given(&self, source: &str) -> Value {
        let id = (!self.id.is_empty()).then_some(self.id.as_str());
        let mut given = json!({"id":id,"label":self.label,"source":source,"instructions":self.instructions});
        if id.is_some() {
            given["deliveryMode"] = json!(self.delivery());
            given["steps"] = json!(self.resolved_steps());
            if let Some(line) = &self.when_to_choose {
                given["whenToChoose"] = json!(line);
            }
        }
        given
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
pub(crate) fn readable(value: &Value) -> Option<Template> {
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

pub(crate) fn list_at(db: &Connection, key: &str) -> Result<Templates> {
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

/// The ten presets (YN-23, T-43 S1a), in each language the page has. A
/// preset names no harness: the page fills in the default for new Agents.
const PRESETS: &str = include_str!("executor_templates/presets.json");
/// The languages presets are written in, as the page names them.
pub(crate) const PRESET_LANGUAGES: [&str; 2] = ["en", "zh-Hans"];

/// The template presets the user can adopt in Settings, one entry per preset
/// and language: `{id, language, label, whenToChoose, modelHint,
/// instructions, deliveryMode, steps?, permissions?}`, where `permissions`
/// gives the permission for each harness (`codex`: a permissionPreset,
/// `claude`: a permissionMode). Never stored by Core and never saved by an
/// Agent: adopting one fills an unsaved template on the page, and the
/// user's ordinary save writes it.
pub(crate) fn presets() -> Vec<Value> {
    static RESOLVED: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
    RESOLVED.get_or_init(|| {
        let source: Value = serde_json::from_str(PRESETS).expect("presets.json is JSON");
        let mut out = Vec::new();
        for preset in source["presets"].as_array().expect("presets.json lists presets") {
            for language in PRESET_LANGUAGES {
                let text = &preset[language];
                let mut item = json!({
                    "id": preset["id"], "language": language, "label": text["label"], "whenToChoose": text["whenToChoose"],
                    "modelHint": text["modelHint"], "instructions": text["instructions"], "deliveryMode": preset["deliveryMode"],
                });
                if let Some(steps) = preset["steps"].as_array() {
                    item["steps"] = steps.iter().map(|step| {
                        let mut step = step.clone();
                        match step["label"][language].as_str() {
                            Some(label) => step["label"] = json!(label),
                            None => {
                                if let Some(step) = step.as_object_mut() {
                                    step.remove("label");
                                }
                            }
                        }
                        step
                    }).collect();
                }
                if preset["permissions"].is_object() {
                    item["permissions"] = preset["permissions"].clone();
                }
                out.push(item);
            }
        }
        out
    }).clone()
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
    let parsed = templates.iter().map(|value| parse_one(value, opencode, saved)).collect::<Result<Vec<_>>>()?;
    let ids: BTreeSet<_> = parsed.iter().map(|t| t.id.as_str()).collect();
    ensure!(ids.len() == parsed.len(), "Each template id must be used once");
    Ok(parsed)
}

/// One template a save or a lead's change names, checked strictly: no field this
/// Core doesn't know and every value valid, with OpenCode's gate as
/// `parse_save` says.
pub(crate) fn parse_one(value: &Value, opencode: bool, saved: &[Template]) -> Result<Template> {
    let Some(object) = value.as_object() else { bail!("A template is an object") };
    if let Some(field) = object.keys().find(|k| !FIELDS.contains(&k.as_str())) {
        bail!("Unknown template field: {field}");
    }
    if let Some(steps) = object.get("steps").and_then(Value::as_array) {
        for (n, step) in steps.iter().enumerate() {
            let Some(step) = step.as_object() else { bail!("Step {}: a step is an object", n + 1) };
            if let Some(field) = step.keys().find(|k| !STEP_FIELDS.contains(&k.as_str())) {
                bail!("Step {}: unknown step field: {field}", n + 1);
            }
        }
    }
    // An older page's `maxConcurrent` is taken and dropped (S5): Template has no such field.
    let template: Template = serde_json::from_value(value.clone()).map_err(|e| anyhow::anyhow!("Invalid template: {e}"))?;
    let kept = saved.iter().any(|t| t.id == template.id && t.harness == "opencode");
    template.validate(opencode || kept)?;
    Ok(template)
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
        if current.version != expected {
            // A lead's change is named (YN-24): the user didn't make it here.
            match crate::executor_template_changes::by_leads_since(&tx, expected)? {
                Some(changes) => bail!("version_conflict: {changes} after you read the templates; reload before saving"),
                None => bail!("version_conflict: these executor templates changed; reload before saving"),
            }
        }
        let stored = write_list(&tx, &current, &templates)?;
        crate::executor_template_changes::record(&tx, &current, &templates, crate::executor_template_changes::Author::User)?;
        tx.commit()?;
        read_list(Some(stored))
    }
}

/// Writes `templates` as the next version of the list `current` is, keeping
/// what a later Core stored (`stored_list`); the stored list's text.
pub(crate) fn write_list(tx: &Connection, current: &Templates, templates: &[Template]) -> Result<String> {
    let stored = stored_list(current, templates, current.version + 1)?.to_string();
    tx.execute(
        "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![KEY, stored],
    )?;
    Ok(stored)
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
        "limits": {"templates": MAX_TEMPLATES.max(workspace.templates.len()), "instructionsBytes": MAX_INSTRUCTIONS,
            "maxConcurrent": OLDER_PAGES_MAX_CONCURRENT},
        "opencodeEnabled": crate::opencode_agent::enabled(),
        "appliesTo": "Dispatches from a template from now on; executors already created keep their own settings.",
    })
}

/// The view, with who changed each template last, when and why (YN-24).
fn shown(store: &Store, workspace: &Templates) -> Result<Value> {
    let mut answer = view(workspace);
    answer["lastModified"] = crate::executor_template_changes::last_modified(&*store.db.read()?, &workspace.templates)?;
    Ok(answer)
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
        let mut answer = shown(s, &s.executor_templates()?)?;
        // A Project's id says whose new-Agent defaults the general executor takes.
        answer["general"] = general_view(s, query.project_id.as_deref())?;
        Ok(answer)
    }).await?))
}

/// Parses and checks a save, and reads the catalogs its new models need
/// before the store transaction: a catalog can take long.
async fn prepared(ws: &Arc<Workspace>, input: &Save, saved: Templates) -> Result<Vec<Template>> {
    let mut templates = parse_save(&input.templates, crate::opencode_agent::enabled(), &saved.templates)?;
    confirmed(ws, &mut templates, &saved.templates).await?;
    Ok(templates)
}

/// Each model `templates` name anew, against `saved`, confirmed by this Core
/// host's catalogs as a save confirms them.
pub(crate) async fn confirmed(ws: &Arc<Workspace>, templates: &mut [Template], saved: &[Template]) -> Result<()> {
    let local = |harness: &str| templates.iter().any(|t| t.harness == harness && t.names_new_model(saved));
    let catalogs = Catalogs {
        codex: if local("codex") { Some(ws.catalog().await) } else { None },
        claude: if local("claude") { Some(ws.claude_catalog().await) } else { None },
    };
    confirm_models(templates, saved, &catalogs)
}

async fn put_templates(State(ws): State<Arc<Workspace>>, Json(input): Json<Save>) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let current = ws.stored(|s| s.executor_templates()).await?;
    let templates = prepared(&ws, &input, current).await?;
    let saved = ws.stored(move |s| shown(s, &s.save_templates(input.expected_version, templates)?)).await?;
    ws.changes.send(json!({"executorTemplates": true}));
    Ok(Json(saved))
}

/// A page from before YN-2 S2 saving a Project's own list is told where
/// templates are now; nothing is written.
async fn put_project_templates(Path(_id): Path<String>) -> Result<Json<Value>, ApiError> {
    Err(anyhow::anyhow!("setting_moved: executor templates are kept for the whole Workspace now, in Settings → Executor templates; \
        this Project's own were copied there. Nothing was saved; reload the page").into())
}

// ---- The Agent tool: a lead reads the list to choose a template (YN-23) ----

/// The read-only list an Agent reads. Saving stays the user's (the browser
/// routes above); no Agent tool writes templates.
pub(crate) const LIST_TOOL: &str = "executor_templates_list";

pub(crate) fn tool_definition() -> Value {
    json!({
        "name": LIST_TOOL,
        "description": "List the Workspace's executor templates, to choose one for task_dispatch with executor {templateId}. Each template has its id and label; whenToChoose, a line saying what work it is for (absent if its template has none); deliveryMode: pr (the work is delivered as a pull request), direct-commit (committed without one) or none (no repository change: the result is the deliverable); steps, what its executors follow, each {kind, label?, rounds? (review), approver? (gate: user, lead or either; unset is user)}, its delivery mode's default when it sets none; these are descriptive: Core does not track steps or hold PR, review or merge operations to a mode. Each also names its harness (codex, claude or opencode), model, reasoningEffort, permissionPreset (Codex) or permissionMode (Claude Code) and machineId (local, a machine's id or auto); an unset one inherits the defaults for new Agents. instructionsBytes is the size of the instructions its executors get with their materials (0 for none). general says what executor {} makes for your Project. laterTemplates counts templates a newer Core saved that this one can't offer. With full true, for leads of a Project only, each also has template: the template as saved, every field, to change and send back whole with executor_templates_change. The user saves templates in Settings, and a lead with executor_templates_change; version is the list's version, its expectedVersion.",
        "inputSchema": {"type":"object","properties":{"full":{"type":"boolean","description":"Also give each template as saved, instructions included: for leads of a Project only (YN-24)."}},"required":[],"additionalProperties":false},
    })
}

/// What `executor_templates_list` says of one template.
fn listed(template: &Template) -> Value {
    let mut item = json!({
        "id": template.id, "label": template.label, "deliveryMode": template.delivery(), "steps": template.resolved_steps(),
        "harness": template.harness,
        "instructionsBytes": template.instructions.as_deref().map_or(0, str::len),
    });
    for (field, value) in [("whenToChoose", &template.when_to_choose), ("model", &template.model), ("reasoningEffort", &template.reasoning_effort),
        ("permissionPreset", &template.permission_preset), ("permissionMode", &template.permission_mode), ("machineId", &template.machine_id)] {
        if let Some(value) = value {
            item[field] = json!(value);
        }
    }
    item
}

/// The list for `actor` (None: the user), with the general executor of its Project.
fn list_for(store: &Store, actor: Option<&str>, full: bool) -> Result<Value> {
    let list = store.executor_templates()?;
    let project: Option<String> = match actor {
        Some(actor) => store.db.read()?
            .query_row("SELECT project_id FROM project_agents WHERE agent_id=?1", [actor], |r| r.get(0)).optional()?,
        None => None,
    };
    Ok(json!({
        "version": list.version,
        "templates": list.templates.iter().map(|template| {
            let mut item = listed(template);
            // As saved, for a lead's change to send back whole (YN-24).
            if full {
                item["template"] = json!(template);
            }
            item
        }).collect::<Vec<_>>(),
        "laterTemplates": list.later_templates,
        "general": general_view(store, project.as_deref())?,
    }))
}

/// Whether `actor` may read the templates whole (`full`, YN-24): a lead of
/// its Project, as one that changes them; executors and other members list
/// them without their instructions.
fn reads_whole(db: &Connection, actor: &str) -> Result<()> {
    let project: Option<String> = db.query_row("SELECT project_id FROM project_agents WHERE agent_id=?1", [actor], |r| r.get(0)).optional()?;
    let leads = match project {
        Some(project) => crate::agent_roles::leads(db, actor, &project)?,
        None => false,
    };
    ensure!(leads, "not_lead: only a lead of a Project reads the templates whole (full); without full, executor_templates_list lists them without their instructions");
    Ok(())
}

pub async fn call(ws: Arc<Workspace>, actor: Option<String>, operation: String, input: Value) -> Result<Value> {
    let input = input.as_object().ok_or_else(|| anyhow::anyhow!("invalid_input: expected an object"))?;
    if let Some(key) = input.keys().find(|k| k.as_str() != "full") {
        bail!("invalid_input: unknown field {key}");
    }
    let full = match input.get("full") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(full)) => *full,
        Some(_) => bail!("invalid_input: full is true or false"),
    };
    match operation.as_str() {
        LIST_TOOL => ws.stored(move |store| {
            if let (true, Some(actor)) = (full, actor.as_deref()) {
                reads_whole(&*store.db.read()?, actor)?;
            }
            list_for(store, actor.as_deref(), full)
        }).await,
        _ => bail!("unknown_operation: {operation}"),
    }
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/executor-templates", get(get_templates).put(put_templates))
        .route("/api/projects/{id}/executor-templates", put(put_project_templates))

}

#[cfg(test)]
#[path = "executor_templates_tests.rs"]
mod tests;
