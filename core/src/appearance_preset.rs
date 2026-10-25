//! One Appearance preset shared in this Workspace (T-194): saved only when a
//! user saves a device's Appearance here, read by the Workspace's clients to
//! preview and apply on their own device. Core keeps it and never applies it
//! anywhere; it is not preference sync. A save names the Workspace and the
//! revision it read, and is refused when either is no longer this one's, so
//! no client overwrites a newer preset it has not seen.
//!
//! Core checks the shape: the Appearance names a client may keep (as
//! appearance-file.ts lists them), each a short lowercase word or a small
//! whole number, which also bounds its size. Whether a value is one this
//! version shows (a palette it has, a size within its range) is the
//! client's to judge when it reads the preset, as with an Appearance file.
use crate::{remote_access::RemoteRequest, server::ApiError, store::Store, workspace::Workspace};
use anyhow::{bail, Result};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const KEY: &str = "appearance.preset";
/// The preset's own format; a later one is refused, never read as this one.
pub const VERSION: u64 = 1;
const WORDS: [&str; 4] = ["palette", "theme", "agentList", "projectGroups"];
const NUMBERS: [&str; 1] = ["fontSize"];
const GROUPS: [(&str, &[&str]); 2] = [("dock", &["jobs", "actions", "subAgents"]), ("turnDock", &["numbers", "bars"])];
const MAX_WORD: usize = 32;
const MAX_NUMBER: u64 = 64;

/// A save: the Workspace and revision the client read (0 when there was no
/// preset), and the Appearance to keep.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    workspace_id: String,
    expected_revision: u64,
    version: u64,
    appearance: Value,
}

fn word(name: &str, value: &Value) -> Result<()> {
    match value.as_str() {
        Some(text) if !text.is_empty() && text.len() <= MAX_WORD
            && text.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') => Ok(()),
        _ => bail!("{name} is not an Appearance value: {value}"),
    }
}

fn number(name: &str, value: &Value) -> Result<()> {
    match value.as_u64() {
        Some(n) if n <= MAX_NUMBER => Ok(()),
        _ => bail!("{name} is not an Appearance value: {value}"),
    }
}

/// Only the Appearance names a client keeps, each of its kind; at least one.
fn validate(appearance: &Value) -> Result<()> {
    let Some(fields) = appearance.as_object() else { bail!("The preset's Appearance is not a set of settings") };
    if fields.is_empty() {
        bail!("The preset holds no Appearance settings");
    }
    for (name, value) in fields {
        if WORDS.contains(&name.as_str()) {
            word(name, value)?;
        } else if NUMBERS.contains(&name.as_str()) {
            number(name, value)?;
        } else if let Some((_, parts)) = GROUPS.iter().find(|(group, _)| group == name) {
            let Some(inner) = value.as_object() else { bail!("{name} is not a set of settings") };
            for (part, value) in inner {
                if !parts.contains(&part.as_str()) {
                    bail!("{name}.{part} is not an Appearance setting");
                }
                number(&format!("{name}.{part}"), value)?;
            }
        } else {
            bail!("{name} is not an Appearance setting");
        }
    }
    Ok(())
}

/// Why a save was not kept, with the preset as it is now.
#[derive(Debug)]
enum Refused {
    OtherWorkspace,
    Changed(Value),
}

impl Store {
    /// The preset as kept: no row until a first save.
    pub(crate) fn appearance_preset(&self) -> Result<Option<Value>> {
        let raw: Option<String> = self.db.read()?
            .query_row("SELECT value FROM workspace_meta WHERE key=?1", [KEY], |r| r.get(0))
            .optional()?;
        Ok(match raw {
            Some(raw) => Some(serde_json::from_str(&raw)?),
            None => None,
        })
    }

    /// Keeps `appearance` as the next revision, only if the preset is still
    /// the one the client read. Read and write are one transaction, so two
    /// saves from the same revision cannot both be kept.
    fn save_appearance_preset(&self, save: &Save, via: &str) -> Result<std::result::Result<Value, Refused>> {
        if save.workspace_id != self.workspace_id()? {
            return Ok(Err(Refused::OtherWorkspace));
        }
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let current: Option<Value> = tx
            .query_row("SELECT value FROM workspace_meta WHERE key=?1", [KEY], |r| r.get::<_, String>(0))
            .optional()?
            .map(|raw| serde_json::from_str(&raw))
            .transpose()?;
        let revision = current.as_ref().and_then(|preset| preset["revision"].as_u64()).unwrap_or(0);
        if revision != save.expected_revision {
            return Ok(Err(Refused::Changed(current.unwrap_or(Value::Null))));
        }
        let preset = json!({
            "version": VERSION,
            "revision": revision + 1,
            "savedAt": crate::model::now(),
            "savedVia": via,
            "appearance": save.appearance,
        });
        tx.execute(
            "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![KEY, serde_json::to_string(&preset)?],
        )?;
        tx.commit()?;
        Ok(Ok(preset))
    }
}

fn view(workspace_id: String, preset: Option<Value>) -> Value {
    json!({"workspaceId": workspace_id, "preset": preset})
}

async fn get_preset(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    let (id, preset) = ws.stored(|s| Ok((s.workspace_id()?, s.appearance_preset()?))).await?;
    Ok(Json(view(id, preset)))
}

/// Keeps one save, once: a refusal is answered, never retried here.
async fn save_preset(
    State(ws): State<Arc<Workspace>>,
    remote: Option<Extension<RemoteRequest>>,
    Json(save): Json<Value>,
) -> Result<Response, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let save: Save = serde_json::from_value(save).map_err(|e| anyhow::anyhow!("Invalid preset: {e}"))?;
    if save.version != VERSION {
        return Err(anyhow::anyhow!("This Core keeps Appearance presets of version {VERSION}, not {}", save.version).into());
    }
    validate(&save.appearance)?;
    let via = if remote.is_some() { "remote" } else { "local" };
    let (id, saved) = ws.stored(move |s| Ok((s.workspace_id()?, s.save_appearance_preset(&save, via)?))).await?;
    Ok(match saved {
        Ok(preset) => Json(view(id, Some(preset))).into_response(),
        Err(Refused::OtherWorkspace) => (StatusCode::CONFLICT, Json(json!({
            "error": "The preset was read from another Workspace, not this one. Nothing was saved.",
            "code": "other_workspace",
            "workspaceId": id,
        }))).into_response(),
        Err(Refused::Changed(current)) => (StatusCode::CONFLICT, Json(json!({
            "error": "The shared preset changed since it was read. Nothing was saved.",
            "code": "preset_changed",
            "workspaceId": id,
            "preset": Some(current).filter(|p| !p.is_null()),
        }))).into_response(),
    })
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/appearance-preset", get(get_preset).put(save_preset))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    fn appearance() -> Value {
        json!({"palette":"yuzu","theme":"dark","fontSize":18,"agentList":"compact","projectGroups":"cards",
            "dock":{"jobs":3,"actions":5,"subAgents":5},"turnDock":{"numbers":8,"bars":4}})
    }

    #[test]
    fn only_appearance_names_of_their_kind_within_the_bound_are_kept() {
        validate(&appearance()).unwrap();
        validate(&json!({"theme":"light"})).unwrap();
        for wrong in [
            json!({}),
            json!("palette=yuzu"),
            json!({"sendKey":"enter"}),
            json!({"time":{"clock":"h24"}}),
            json!({"cwd":"/home/someone"}),
            json!({"palette":"Yuzu Green"}),
            json!({"palette":7}),
            json!({"fontSize":"18"}),
            json!({"fontSize":-1}),
            json!({"fontSize":1000}),
            json!({"dock":{"jobs":3,"token":1}}),
            json!({"dock":5}),
            json!({"theme":"x".repeat(MAX_WORD + 1)}),
        ] {
            assert!(validate(&wrong).is_err(), "{wrong}");
        }
    }

    async fn call(ws: &Arc<Workspace>, method: &str, body: Option<Value>, remote: bool) -> (StatusCode, Value) {
        let mut request = axum::http::Request::builder().method(method).uri("/api/appearance-preset");
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        let mut request = request
            .body(body.map_or_else(axum::body::Body::empty, |b| axum::body::Body::from(b.to_string())))
            .unwrap();
        if remote {
            request.extensions_mut().insert(RemoteRequest);
        }
        let response = router().with_state(ws.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    fn save(workspace: &str, expected: u64, appearance: Value) -> Value {
        json!({"workspaceId":workspace,"expectedRevision":expected,"version":VERSION,"appearance":appearance})
    }

    #[tokio::test]
    async fn a_save_needs_this_workspace_and_the_revision_read_and_never_overwrites_a_newer_one() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
        let (status, none) = call(&ws, "GET", None, false).await;
        assert_eq!(status, StatusCode::OK);
        let id = none["workspaceId"].as_str().unwrap().to_owned();
        assert!(!id.is_empty());
        assert_eq!(none["preset"], Value::Null, "nothing until a first save");

        // Client A saves from "no preset".
        let (status, first) = call(&ws, "PUT", Some(save(&id, 0, appearance())), false).await;
        assert_eq!(status, StatusCode::OK, "{first}");
        assert_eq!(first["preset"]["revision"], 1);
        assert_eq!(first["preset"]["version"], VERSION);
        assert_eq!(first["preset"]["savedVia"], "local");
        assert_eq!(first["preset"]["appearance"], appearance());

        // Client B, which also read "no preset", is refused and told what is there now.
        let (status, refused) = call(&ws, "PUT", Some(save(&id, 0, json!({"theme":"light"}))), true).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(refused["code"], "preset_changed");
        assert_eq!(refused["preset"]["revision"], 1);
        assert_eq!(call(&ws, "GET", None, false).await.1["preset"], first["preset"], "A's preset stands");

        // B reads again (revision 1) and saves through the phone entry.
        let (status, second) = call(&ws, "PUT", Some(save(&id, 1, json!({"theme":"light"}))), true).await;
        assert_eq!(status, StatusCode::OK, "{second}");
        assert_eq!(second["preset"]["revision"], 2);
        assert_eq!(second["preset"]["savedVia"], "remote");
        assert_eq!(second["preset"]["appearance"], json!({"theme":"light"}), "a save replaces, never merges");

        // A, still at revision 1, is refused.
        let (status, stale) = call(&ws, "PUT", Some(save(&id, 1, appearance())), false).await;
        assert_eq!((status, stale["code"].as_str()), (StatusCode::CONFLICT, Some("preset_changed")));

        // Read from another Workspace: refused, whatever its revision.
        let (status, other) = call(&ws, "PUT", Some(save("another-workspace", 2, appearance())), false).await;
        assert_eq!((status, other["code"].as_str()), (StatusCode::CONFLICT, Some("other_workspace")));
        assert_eq!(call(&ws, "GET", None, false).await.1["preset"], second["preset"], "nothing else was kept");
    }

    #[tokio::test]
    async fn a_save_of_another_version_or_with_fields_it_does_not_know_is_refused_whole() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
        let id = call(&ws, "GET", None, false).await.1["workspaceId"].as_str().unwrap().to_owned();
        let mut later = save(&id, 0, appearance());
        later["version"] = json!(2);
        let mut extra = save(&id, 0, appearance());
        extra["sending"] = json!({"sendKey":"enter"});
        for (body, expected) in [
            (later, "version 1, not 2"),
            (extra, "unknown field `sending`"),
            (save(&id, 0, json!({"palette":"yuzu","token":"x"})), "token is not an Appearance setting"),
            (save(&id, 0, json!({"fontSize":"20"})), "fontSize is not an Appearance value"),
            (save(&id, 0, json!({"theme":"x".repeat(MAX_WORD + 1)})), "theme is not an Appearance value"),
        ] {
            let (status, refused) = call(&ws, "PUT", Some(body), false).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
            assert!(refused["error"].as_str().unwrap().contains(expected), "{refused}");
        }
        assert_eq!(call(&ws, "GET", None, false).await.1["preset"], Value::Null, "nothing was kept");
    }
}
