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
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM workspace_meta WHERE key='review.settings'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match raw {
        Some(raw) => serde_json::from_str(&raw)?,
        None => Settings::default(),
    })
}
impl Store {
    pub(super) fn review_settings(&self) -> Result<Settings> {
        read(&*self.db.read()?)
    }
    pub(crate) fn save_review_settings(&self, settings: &Settings) -> Result<()> {
        self.db.write()?.execute("INSERT INTO workspace_meta(key,value) VALUES('review.settings',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(settings)?])?;
        Ok(())
    }
}
pub(super) async fn get(State(ws): State<Arc<Workspace>>) -> Result<Json<Settings>, ApiError> {
    Ok(Json(ws.stored(|s| s.review_settings()).await?))
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
    let value = serde_json::to_value(&settings)?;
    ws.stored(move |s| s.save_review_settings(&settings))
        .await?;
    ws.changes.send(json!({"prReviews":true}));
    Ok(Json(value))
}
