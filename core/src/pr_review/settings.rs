//! The reviewer new reviews use (T-190): a project's own, else the
//! Workspace's, else the built-in one. A review takes it once, when it is
//! created, from the project its task belongs to (`project_tasks`), not from
//! the Agent that asks or the page it is asked from; a task in no project
//! takes the Workspace's. Harness and model go together, from one place. An
//! incremental round, a continuation and a delivery's registered review are
//! held to the reviewer of the review they follow by their own checks, and a
//! retried request gets its first answer: a later change never rewrites a
//! review already started.
use crate::{server::ApiError, store::Store, workspace::Workspace};
use anyhow::{ensure, Result};
use axum::{extract::{Path, State}, Json};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Settings {
    pub harness: String,
    pub model: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            harness: "codex".into(),
            model: super::MODEL.into(),
        }
    }
}
/// The Workspace's reviewer, or the built-in one: what a task in no project uses.
pub(crate) fn read(db: &rusqlite::Connection) -> Result<Settings> {
    Ok(read_saved(db)?.unwrap_or_default())
}
const KEY: &str = "review.settings";
/// Where a project's own reviewer is kept: beside the Workspace's, not in the
/// project's record, as its new-Agent defaults are.
pub(crate) fn project_key(project: &str) -> String {
    format!("review.settings.project:{project}")
}
fn read_at(db: &rusqlite::Connection, key: &str) -> Result<Option<Settings>> {
    let raw: Option<String> = db
        .query_row("SELECT value FROM workspace_meta WHERE key=?1", [key], |r| r.get(0))
        .optional()?;
    Ok(match raw {
        Some(raw) => Some(serde_json::from_str(&raw)?),
        None => None,
    })
}
/// The Workspace's own reviewer for new reviews, or none: the built-in one.
fn read_saved(db: &rusqlite::Connection) -> Result<Option<Settings>> {
    read_at(db, KEY)
}
/// The project `task` belongs to, by its own assignment.
fn task_project(db: &rusqlite::Connection, task: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [task], |r| r.get(0))
        .optional()?)
}
/// The reviewer a new review of `task` gets, and where it comes from:
/// "project", "workspace" or "builtin".
pub(crate) fn resolve(db: &rusqlite::Connection, task: &str) -> Result<(Settings, &'static str)> {
    if let Some(project) = task_project(db, task)? {
        if let Some(own) = read_at(db, &project_key(&project))? {
            return Ok((own, "project"));
        }
    }
    Ok(match read_saved(db)? {
        Some(settings) => (settings, "workspace"),
        None => (Settings::default(), "builtin"),
    })
}
/// The reviewer a new review of `task` gets.
pub(crate) fn for_task(db: &rusqlite::Connection, task: &str) -> Result<Settings> {
    Ok(resolve(db, task)?.0)
}
/// `settings` with where it comes from, as a page shows it.
pub(crate) fn sourced(settings: Settings, source: &str) -> Result<Value> {
    let mut value = serde_json::to_value(settings)?;
    value["source"] = source.into();
    Ok(value)
}
/// The reviewer new reviews use and where it comes from (T-190): "workspace"
/// when this Workspace chose it, "builtin" otherwise.
fn view(saved: Option<Settings>) -> Result<Value> {
    let source = if saved.is_some() { "workspace" } else { "builtin" };
    let mut value = serde_json::to_value(saved.unwrap_or_default())?;
    value["source"] = source.into();
    value["builtIn"] = serde_json::to_value(Settings::default())?;
    Ok(value)
}
/// A project's reviewer for new reviews of its tasks: its own when it chose
/// one, else what it inherits (the Workspace's or the built-in one), with
/// the source of each.
fn project_view(project: &str, workspace: Option<Settings>, own: Option<Settings>) -> Result<Value> {
    let inherited = view(workspace)?;
    let mut value = match &own {
        Some(own) => sourced(own.clone(), "project")?,
        None => inherited.clone(),
    };
    value["builtIn"] = serde_json::to_value(Settings::default())?;
    value["projectId"] = project.into();
    value["saved"] = serde_json::to_value(own)?;
    value["inherited"] = json!({"harness": inherited["harness"], "model": inherited["model"], "source": inherited["source"]});
    Ok(value)
}
impl Store {
    pub(super) fn review_settings(&self) -> Result<Settings> {
        read(&*self.db.read()?)
    }
    pub(crate) fn save_review_settings(&self, settings: &Settings) -> Result<()> {
        self.db.write()?.execute("INSERT INTO workspace_meta(key,value) VALUES('review.settings',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(settings)?])?;
        Ok(())
    }
    fn saved_review_settings(&self) -> Result<Option<Settings>> {
        read_saved(&*self.db.read()?)
    }
    fn project_review_view(&self, project: &str) -> Result<Value> {
        let db = self.db.read()?;
        project_view(project, read_saved(&db)?, read_at(&db, &project_key(project))?)
    }
    pub(crate) fn save_project_review_settings(&self, project: &str, settings: &Settings) -> Result<()> {
        self.db.write()?.execute(
            "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![project_key(project), serde_json::to_string(settings)?],
        )?;
        Ok(())
    }
    /// Removes the project's choice: its tasks inherit again.
    pub(crate) fn clear_project_review_settings(&self, project: &str) -> Result<()> {
        self.db.write()?.execute("DELETE FROM workspace_meta WHERE key=?1", [project_key(project)])?;
        Ok(())
    }
    /// Removes the Workspace's choice, rather than saving the built-in one.
    fn clear_review_settings(&self) -> Result<()> {
        self.db.write()?.execute("DELETE FROM workspace_meta WHERE key='review.settings'", [])?;
        Ok(())
    }
}
pub(super) async fn get(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    let saved = ws.stored(|s| s.saved_review_settings()).await?;
    Ok(Json(view(saved)?))
}
/// New reviews use the built-in reviewer again. As with any change, reviews
/// already started keep theirs; a continuation or delivery that needs the
/// earlier reviewer is refused by its own checks.
pub(super) async fn reset(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    ws.stored(|s| s.clear_review_settings()).await?;
    ws.changes.send(json!({"prReviews":true}));
    Ok(Json(view(None)?))
}
/// A reviewer this Core can run: Codex's own model, or a model of the
/// native Claude catalog.
async fn validate(ws: &Arc<Workspace>, settings: &Settings) -> Result<()> {
    match settings.harness.as_str() {
        "codex" => ensure!(
            settings.model == super::MODEL,
            "Codex reviews use GPT-6.1 Sol"
        ),
        "claude" => {
            let catalog = ws.claude_catalog().await?;
            ensure!(
                catalog["models"]
                    .as_array()
                    .is_some_and(|m| m.iter().any(|m| m["model"] == settings.model)),
                "Choose a model from the native Claude model catalog"
            );
        }
        _ => anyhow::bail!("Unknown review harness"),
    }
    Ok(())
}
pub(super) async fn set(
    State(ws): State<Arc<Workspace>>,
    Json(settings): Json<Settings>,
) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    validate(&ws, &settings).await?;
    let value = view(Some(settings.clone()))?;
    ws.stored(move |s| s.save_review_settings(&settings))
        .await?;
    ws.changes.send(json!({"prReviews":true}));
    Ok(Json(value))
}

/// A project's reviewer for new reviews of its tasks, and what it inherits.
pub(super) async fn get_project(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let value = ws.stored(move |s| {
        s.project(&id)?;
        s.project_review_view(&id)
    }).await?;
    Ok(Json(value))
}
/// A project's own reviewer: harness and model together. Only new reviews of
/// its tasks use it; an archived project is not changed.
pub(super) async fn set_project(
    State(ws): State<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(settings): Json<Settings>,
) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let project = id.clone();
    ws.stored(move |s| s.ensure_project_assignable(&project)).await?;
    validate(&ws, &settings).await?;
    let value = ws.stored(move |s| {
        s.ensure_project_assignable(&id)?;
        s.save_project_review_settings(&id, &settings)?;
        s.project_review_view(&id)
    }).await?;
    ws.changes.send(json!({"prReviews":true}));
    Ok(Json(value))
}
/// The project inherits again: its own choice is removed.
pub(super) async fn reset_project(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let value = ws.stored(move |s| {
        s.ensure_project_assignable(&id)?;
        s.clear_project_review_settings(&id)?;
        s.project_review_view(&id)
    }).await?;
    ws.changes.send(json!({"prReviews":true}));
    Ok(Json(value))
}

#[cfg(test)]
mod source_tests {
    use super::*;

    #[test]
    fn a_reset_removes_the_workspace_reviewer_and_new_reviews_use_the_built_in_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        assert!(store.saved_review_settings().unwrap().is_none());
        assert_eq!(view(None).unwrap()["source"], "builtin");
        let chosen = Settings { harness: "claude".into(), model: "claude-opus-5-5".into() };
        store.save_review_settings(&chosen).unwrap();
        let saved = store.saved_review_settings().unwrap();
        let shown = view(saved).unwrap();
        assert_eq!((shown["harness"].as_str(), shown["source"].as_str()), (Some("claude"), Some("workspace")));
        assert_eq!(shown["builtIn"], json!({"harness":"codex","model":super::super::MODEL}));
        store.clear_review_settings().unwrap();
        assert!(store.saved_review_settings().unwrap().is_none(), "the choice is removed, not overwritten");
        assert_eq!(store.review_settings().unwrap().harness, "codex");
    }

    #[test]
    fn a_tasks_reviewer_is_its_projects_then_the_workspaces_then_the_built_in_one_as_one_pair() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        let task = |key: &str| {
            let id = store.collaboration_call(None, "task_create", json!({"requestId": key, "title": key})).unwrap()["task"]["id"].as_str().unwrap().to_owned();
            crate::collaboration_store::task_key(&store.db.read().unwrap(), &id).unwrap().0
        };
        let (alone, inside, elsewhere) = (task("alone"), task("inside"), task("elsewhere"));
        let project = store.create_project("Reviewed", Default::default()).unwrap().id;
        let other = store.create_project("Other", Default::default()).unwrap().id;
        crate::projects::set_task_project(&store.db.write().unwrap(), &inside, Some(&project)).unwrap();
        crate::projects::set_task_project(&store.db.write().unwrap(), &elsewhere, Some(&other)).unwrap();
        let resolve = |task: &str| { let (s, source) = super::resolve(&store.db.read().unwrap(), task).unwrap(); (s.harness, s.model, source) };
        assert_eq!(resolve(&inside), ("codex".into(), super::super::MODEL.into(), "builtin"));
        let workspace = Settings { harness: "claude".into(), model: "workspace-choice".into() };
        store.save_review_settings(&workspace).unwrap();
        let own = Settings { harness: "claude".into(), model: "project-choice".into() };
        store.save_project_review_settings(&project, &own).unwrap();
        // Its own project's reviewer, harness and model together; another project's never.
        assert_eq!(resolve(&inside), ("claude".into(), "project-choice".into(), "project"));
        assert_eq!(resolve(&alone), ("claude".into(), "workspace-choice".into(), "workspace"));
        assert_eq!(resolve(&elsewhere), ("claude".into(), "workspace-choice".into(), "workspace"));
        let shown = store.project_review_view(&project).unwrap();
        assert_eq!((shown["model"].as_str(), shown["source"].as_str(), shown["saved"]["model"].as_str()), (Some("project-choice"), Some("project"), Some("project-choice")));
        assert_eq!(shown["inherited"], json!({"harness":"claude","model":"workspace-choice","source":"workspace"}));
        // Cleared: it inherits again; the Workspace's own is untouched.
        store.clear_project_review_settings(&project).unwrap();
        assert_eq!(resolve(&inside), ("claude".into(), "workspace-choice".into(), "workspace"));
        assert_eq!(store.project_review_view(&project).unwrap()["saved"], Value::Null);
        // Deleted with its project (once it holds no tasks).
        store.save_project_review_settings(&other, &own).unwrap();
        crate::projects::set_task_project(&store.db.write().unwrap(), &elsewhere, None).unwrap();
        store.delete_project(&other).unwrap();
        assert!(read_at(&store.db.read().unwrap(), &project_key(&other)).unwrap().is_none());
    }
}
