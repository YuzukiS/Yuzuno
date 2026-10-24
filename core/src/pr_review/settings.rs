use crate::{server::ApiError, store::Store, workspace::Workspace};
use anyhow::{ensure, Result};
use axum::{extract::State, Json};
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
pub(crate) fn read(db: &rusqlite::Connection) -> Result<Settings> {
    Ok(read_saved(db)?.unwrap_or_default())
}
/// The Workspace's own reviewer for new reviews, or none: the built-in one.
fn read_saved(db: &rusqlite::Connection) -> Result<Option<Settings>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM workspace_meta WHERE key='review.settings'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match raw {
        Some(raw) => Some(serde_json::from_str(&raw)?),
        None => None,
    })
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
pub(super) async fn set(
    State(ws): State<Arc<Workspace>>,
    Json(settings): Json<Settings>,
) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let validate: Result<()> = async {
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
    .await;
    validate?;
    let value = view(Some(settings.clone()))?;
    ws.stored(move |s| s.save_review_settings(&settings))
        .await?;
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
}
