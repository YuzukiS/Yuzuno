//! Claude Code's own file checkpoints (T-32): preview, then restore, the
//! files Claude changed after one of the user's messages.
//!
//! - A checkpoint is named by that message's native uuid (`nativeUuid` on
//!   its userMessage item), never by a Turn or tool call id.
//! - Claude Code keeps checkpoints only in sessions started with file
//!   checkpointing, and only for files changed with Write, Edit and
//!   NotebookEdit. Shell commands and sub-agents are not part of them
//!   (checked with CLI 2.1.280, acceptance/t32/probe).
//! - A restore needs a preview the user confirmed. Core keeps what the
//!   preview showed (each file's content hash, the session and the runtime)
//!   and refuses the restore if any of it changed: the native rewind would
//!   overwrite a change made after the preview without a word.
//! - Only files change; the conversation stays as it is.

use crate::{
    model::{ensure_agent_open, now, AgentDetail},
    server::ApiError,
    workspace::Workspace,
};
use anyhow::{bail, Context, Result};
use axum::{
    extract::{Path, State},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

/// A preview is confirmed within this time, or shown again.
const PREVIEW_FOR: Duration = Duration::from_secs(10 * 60);
/// A preview lists at most this many files.
const MAX_FILES: usize = 500;

struct Preview {
    agent: String,
    session: Option<String>,
    generation: u64,
    message: String,
    native: Value,
    /// Each listed file and the hash of its content when previewed (None:
    /// it did not exist).
    files: Vec<(String, Option<String>)>,
    at: Instant,
}

static PREVIEWS: LazyLock<Mutex<HashMap<String, Preview>>> = LazyLock::new(Default::default);

/// The file's sha256, read in pieces; None when it does not exist. A file
/// that cannot be read is marked with why, so it still compares.
fn fingerprint(path: &str) -> Option<String> {
    match crate::updates::package::sha256(std::path::Path::new(path)) {
        Ok(hash) => Some(hash),
        Err(error) => match error.downcast_ref::<std::io::Error>().map(std::io::Error::kind) {
            Some(std::io::ErrorKind::NotFound) => None,
            kind => Some(format!("unreadable: {kind:?}")),
        },
    }
}

async fn fingerprints(paths: Vec<String>) -> Result<Vec<(String, Option<String>)>> {
    Ok(tokio::task::spawn_blocking(move || paths.into_iter().map(|p| { let f = fingerprint(&p); (p, f) }).collect()).await?)
}

/// The Turn whose userMessage carries this native uuid.
fn message_turn(d: &AgentDetail, message: &str) -> Option<String> {
    d.turns.iter().find_map(|turn| {
        turn["items"].as_array()?.iter().any(|item| item["type"] == "userMessage" && item["nativeUuid"] == message)
            .then(|| turn["id"].as_str().map(str::to_owned)).flatten()
    })
}

fn ensure_between_turns(d: &AgentDetail) -> Result<()> {
    if d.turns.iter().any(|t| t["status"] == "inProgress") || d.pending.iter().any(|p| !p.stale) {
        bail!("Claude is working or waiting for an answer; files can be restored between turns");
    }
    Ok(())
}

fn changed_files(native: &Value) -> Vec<String> {
    native["filesChanged"].as_array().map(|files| files.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()
}

/// Why Claude Code cannot rewind, for the explanation shown with its own
/// message: never enabled for the session, or no checkpoint at that message.
fn unavailable(native: &Value) -> Option<&'static str> {
    if native["canRewind"].as_bool() == Some(true) {
        return None;
    }
    let error = native["error"].as_str().unwrap_or_default();
    Some(if error.contains("not enabled") {
        "notEnabled"
    } else if error.contains("No file checkpoint") {
        "noCheckpoint"
    } else {
        "unavailable"
    })
}

/// What a preview and a later check must agree on.
fn summary(native: &Value) -> (Option<bool>, Vec<String>, Value, Value) {
    let mut files = changed_files(native);
    files.sort();
    (native["canRewind"].as_bool(), files, native["insertions"].clone(), native["deletions"].clone())
}

fn shown(cwd: &str, path: &str) -> String {
    let base = cwd.trim_end_matches('/');
    path.strip_prefix(base).and_then(|rest| rest.strip_prefix('/')).unwrap_or(path).to_owned()
}

/// What still differs after a restore, by Claude Code's own dry run. Only
/// an answer that could rewind and names each file it lists confirms
/// anything; otherwise the reason it gives (or the failed request's).
fn checked(cwd: &str, after: Result<Value>) -> Result<Vec<String>, String> {
    let after = after.map_err(|error| format!("{error:#}"))?;
    if after["canRewind"].as_bool() != Some(true) {
        return Err(after["error"].as_str().unwrap_or("Claude Code could not check the files").to_owned());
    }
    let listed = after["filesChanged"].as_array().ok_or_else(|| "Claude Code's check listed no files".to_owned())?;
    listed.iter()
        .map(|file| file.as_str().map(|file| shown(cwd, file)).ok_or_else(|| "Claude Code's check listed a file without a path".to_owned()))
        .collect()
}

fn stale(reason: &str, changed: Vec<String>) -> Value {
    json!({"status":"stale","reason":reason,"changed":changed})
}

impl Workspace {
    /// Claude Code's dry run of a rewind to before `message`: the files it
    /// would change, which this Core then fingerprints. Nothing is written.
    pub async fn claude_checkpoint_preview(self: &Arc<Self>, id: &str, message: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        // The Turn of the message, found by its native uuid (T-140).
        let (agent, uuid) = (id.to_owned(), message.to_owned());
        let holding = self.stored(move |store| store.keyed_turns(&agent, "uuid", Some(&uuid))).await?;
        let d = self.view(id, crate::store::Sel::Turns(holding)).await?;
        ensure_agent_open(&d.agent)?;
        if d.agent.harness != "claude" || d.agent.remote.is_some() {
            bail!("File checkpoints are available for Claude Agents on this machine");
        }
        let turn = message_turn(&d, message).context("This is not one of this Agent's messages to Claude")?;
        ensure_between_turns(&d)?;
        let c = self.claude_ensure(id).await?;
        let native = c.bridge.request(json!({"op":"rewind_files","userMessageId":message,"dryRun":true})).await?;
        let session = self.listed(id).await?.claude_session_id;
        let mut paths = changed_files(&native);
        let truncated = paths.len() > MAX_FILES;
        paths.truncate(MAX_FILES);
        let files = fingerprints(paths).await?;
        let reason = unavailable(&native);
        let restorable = reason.is_none() && !files.is_empty() && !truncated;
        let preview_id = restorable.then(|| uuid::Uuid::new_v4().to_string());
        let listed: Vec<Value> = files.iter().map(|(path, hash)| json!({"path":path,"shown":shown(&d.agent.cwd, path),"exists":hash.is_some()})).collect();
        if let Some(preview_id) = &preview_id {
            let mut previews = PREVIEWS.lock().unwrap();
            previews.retain(|_, p| p.at.elapsed() < PREVIEW_FOR && p.agent != id);
            previews.insert(preview_id.clone(), Preview {
                agent: id.to_owned(), session: session.clone(), generation: c.generation, message: message.to_owned(),
                native: native.clone(), files, at: Instant::now(),
            });
        }
        Ok(json!({
            "userMessageId":message, "turnId":turn, "previewId":preview_id, "previewedAt":now(),
            "expiresInSeconds":PREVIEW_FOR.as_secs(), "canRewind":native["canRewind"], "reason":reason,
            "error":native["error"], "files":listed, "truncated":truncated,
            "insertions":native["insertions"], "deletions":native["deletions"],
        }))
    }

    /// Restores exactly what `preview` showed, if nothing it relied on has
    /// changed since; otherwise answers `stale` and writes nothing. The
    /// result is Claude Code's own, confirmed only by a readable dry run
    /// afterwards (else `unconfirmed`, with `checkError`).
    pub async fn claude_checkpoint_restore(self: &Arc<Self>, id: &str, preview: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        // One confirmation per preview, whatever its outcome.
        let preview = PREVIEWS.lock().unwrap().remove(preview).filter(|p| p.agent == id)
            .context("This preview is no longer valid; preview the restore again")?;
        if preview.at.elapsed() > PREVIEW_FOR {
            return Ok(stale("expired", vec![]));
        }
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        ensure_between_turns(&d)?;
        let current = self.claudes.lock().unwrap().get(id).cloned();
        let Some(c) = current.filter(|c| c.generation == preview.generation) else {
            return Ok(stale("runtime", vec![]));
        };
        if d.agent.claude_session_id != preview.session {
            return Ok(stale("session", vec![]));
        }
        let paths: Vec<String> = preview.files.iter().map(|(path, _)| path.clone()).collect();
        let now_files = fingerprints(paths).await?;
        let changed: Vec<String> = preview.files.iter().zip(&now_files)
            .filter(|((_, before), (_, after))| before != after).map(|((path, _), _)| shown(&d.agent.cwd, path)).collect();
        if !changed.is_empty() {
            return Ok(stale("files", changed));
        }
        let again = c.bridge.request(json!({"op":"rewind_files","userMessageId":preview.message,"dryRun":true})).await?;
        if summary(&again) != summary(&preview.native) {
            return Ok(stale("checkpoint", vec![]));
        }
        let native = c.bridge.request(json!({"op":"rewind_files","userMessageId":preview.message})).await?;
        // Sent once; whatever the check says, the restore is not sent again.
        let check = checked(&d.agent.cwd,
            c.bridge.request(json!({"op":"rewind_files","userMessageId":preview.message,"dryRun":true})).await);
        let (remaining, check_error) = match check {
            Ok(remaining) => (remaining, None),
            Err(reason) => (vec![], Some(reason)),
        };
        let status = if native["canRewind"].as_bool() != Some(true) {
            "failed"
        } else if check_error.is_some() {
            "unconfirmed"
        } else if remaining.is_empty() {
            "restored"
        } else {
            "partial"
        };
        let files: Vec<String> = preview.files.iter().map(|(path, _)| shown(&d.agent.cwd, path)).collect();
        let result = json!({
            "status":status, "userMessageId":preview.message, "files":files, "remaining":remaining,
            "skippedLinks":native["skippedLinks"], "error":native["error"], "checkError":check_error, "restoredAt":now(),
        });
        self.record_meta(id, "claude/filesRestored", result.clone(), |_| {}).await?;
        self.changed(id);
        Ok(result)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewInput {
    user_message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreInput {
    preview_id: String,
}

async fn preview(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<PreviewInput>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.claude_checkpoint_preview(&id, &input.user_message_id).await?))
}

async fn restore(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<RestoreInput>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.claude_checkpoint_restore(&id, &input.preview_id).await?))
}

pub(crate) fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/agents/{id}/claude/checkpoints/preview", post(preview))
        .route("/api/agents/{id}/claude/checkpoints/restore", post(restore))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn until(done: impl Fn() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(done(), "fixture condition timed out");
    }

    const U1: &str = "11111111-1111-4111-8111-111111111111";
    const U2: &str = "22222222-2222-4222-8222-222222222222";

    #[tokio::test]
    async fn a_restore_needs_a_current_preview_and_changes_only_what_it_showed() {
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore {
            fn drop(&mut self) {
                match &self.0 {
                    Some(value) => std::env::set_var("YUZUNO_CLAUDE_BRIDGE", value),
                    None => std::env::remove_var("YUZUNO_CLAUDE_BRIDGE"),
                }
            }
        }
        let _env = crate::claude::BRIDGE_ENV.lock().await;
        let _restore = Restore(std::env::var_os("YUZUNO_CLAUDE_BRIDGE"));
        std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude_checkpoint_bridge.mjs"));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let file = |name: &str| std::fs::read_to_string(path.join(name)).ok();
        let ws = Workspace::new(path.join("data"), path.to_string_lossy().into(), "unused".into()).unwrap();
        let agent = ws.claude_create("Checkpoints".into(), String::new(), path.to_string_lossy().into(), "fixture".into(), None).await.unwrap();
        let id = agent.id.as_str();
        until(|| ws.store.agent(id).unwrap().connection_state == "connected").await;
        // Claude's session was started with file checkpointing.
        assert_eq!(file("options.json").unwrap(), r#"{"enableFileCheckpointing":true}"#);
        // Two prompts as Core records them; the files Claude changed after U1.
        ws.update_record(id, "test/turns", json!({}), |d| {
            for (turn, uuid) in [("t1", U1), ("t2", U2)] {
                let t = d.turn_mut(turn);
                t["status"] = "completed".into();
                t["items"] = json!([{"id":format!("{turn}:input"),"type":"userMessage","content":[],"nativeUuid":uuid}]);
            }
        }).await.unwrap();
        std::fs::write(path.join("checkpoints.json"), json!({U1:{"a.txt":null,"b.txt":"beta 1\n"}}).to_string()).unwrap();
        std::fs::write(path.join("a.txt"), "alpha 1\n").unwrap();
        std::fs::write(path.join("b.txt"), "beta 2\n").unwrap();

        // A preview lists what Claude Code would change and writes nothing.
        let shown = ws.claude_checkpoint_preview(id, U1).await.unwrap();
        assert_eq!(shown["canRewind"], true);
        assert_eq!(shown["turnId"], "t1");
        assert_eq!(shown["files"].as_array().unwrap().iter().map(|f| f["shown"].as_str().unwrap()).collect::<Vec<_>>(), ["a.txt", "b.txt"]);
        let first = shown["previewId"].as_str().unwrap().to_owned();
        assert_eq!(file("b.txt").unwrap(), "beta 2\n");

        // A change after the preview: refused, nothing written, preview used up.
        std::fs::write(path.join("b.txt"), "beta 2 edited by hand\n").unwrap();
        let refused = ws.claude_checkpoint_restore(id, &first).await.unwrap();
        assert_eq!(refused, json!({"status":"stale","reason":"files","changed":["b.txt"]}));
        assert_eq!(file("b.txt").unwrap(), "beta 2 edited by hand\n");
        assert!(file("a.txt").is_some());
        assert!(file("rewinds").unwrap().lines().all(|l| l.ends_with(" dry")), "no real rewind was asked for");
        assert!(ws.claude_checkpoint_restore(id, &first).await.unwrap_err().to_string().contains("no longer valid"));

        // A new preview of the current files restores exactly them.
        let again = ws.claude_checkpoint_preview(id, U1).await.unwrap();
        let restored = ws.claude_checkpoint_restore(id, again["previewId"].as_str().unwrap()).await.unwrap();
        assert_eq!(restored["status"], "restored");
        assert_eq!(restored["files"], json!(["a.txt", "b.txt"]));
        assert_eq!(restored["remaining"], json!([]));
        assert!(file("a.txt").is_none(), "a file Claude created is removed");
        assert_eq!(file("b.txt").unwrap(), "beta 1\n");
        // The conversation is untouched.
        assert_eq!(ws.detail(id).await.unwrap().turns.len(), 2);

        // Nothing to restore, no checkpoint, not one of this Agent's messages.
        let nothing = ws.claude_checkpoint_preview(id, U1).await.unwrap();
        assert_eq!((nothing["canRewind"].clone(), nothing["previewId"].clone()), (json!(true), Value::Null));
        let missing = ws.claude_checkpoint_preview(id, U2).await.unwrap();
        assert_eq!((missing["reason"].clone(), missing["previewId"].clone()), (json!("noCheckpoint"), Value::Null));
        assert_eq!(missing["error"], "No file checkpoint found for this message.");
        let unknown = ws.claude_checkpoint_preview(id, "33333333-3333-4333-8333-333333333333").await.unwrap_err();
        assert!(unknown.to_string().contains("not one of this Agent's messages"), "{unknown}");
        std::fs::write(path.join("not-enabled"), "").unwrap();
        assert_eq!(ws.claude_checkpoint_preview(id, U1).await.unwrap()["reason"], "notEnabled");
        std::fs::remove_file(path.join("not-enabled")).unwrap();

        // A preview goes stale when the runtime or the session changes.
        std::fs::write(path.join("a.txt"), "alpha 2\n").unwrap();
        let runtime = ws.claude_checkpoint_preview(id, U1).await.unwrap();
        {
            let mut claudes = ws.claudes.lock().unwrap();
            let c = claudes.get_mut(id).unwrap();
            c.generation += 1000;
        }
        assert_eq!(ws.claude_checkpoint_restore(id, runtime["previewId"].as_str().unwrap()).await.unwrap()["reason"], "runtime");
        let session = ws.claude_checkpoint_preview(id, U1).await.unwrap();
        ws.update_record(id, "test/session", json!({}), |d| d.agent.claude_session_id = Some("another".into())).await.unwrap();
        assert_eq!(ws.claude_checkpoint_restore(id, session["previewId"].as_str().unwrap()).await.unwrap()["reason"], "session");
        assert_eq!(file("a.txt").unwrap(), "alpha 2\n", "a stale preview never writes");

        // Never during a turn.
        ws.update_record(id, "test/working", json!({}), |d| d.turn_mut("t3")["status"] = "inProgress".into()).await.unwrap();
        assert!(ws.claude_checkpoint_preview(id, U1).await.unwrap_err().to_string().contains("between turns"));
    }

    /// After the real rewind, only a readable check (Claude Code could
    /// rewind and listed what still differs) confirms a restore. A check
    /// that says no, leaves out its file list or fails is "unconfirmed",
    /// with its reason; nothing is sent again.
    #[tokio::test]
    async fn a_restore_is_confirmed_only_by_a_readable_check_afterwards() {
        let _env = crate::claude::BRIDGE_ENV.lock().await;
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore {
            fn drop(&mut self) {
                match &self.0 {
                    Some(value) => std::env::set_var("YUZUNO_CLAUDE_BRIDGE", value),
                    None => std::env::remove_var("YUZUNO_CLAUDE_BRIDGE"),
                }
            }
        }
        let _restore = Restore(std::env::var_os("YUZUNO_CLAUDE_BRIDGE"));
        std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude_checkpoint_bridge.mjs"));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let file = |name: &str| std::fs::read_to_string(path.join(name)).ok();
        let ws = Workspace::new(path.join("data"), path.to_string_lossy().into(), "unused".into()).unwrap();
        let agent = ws.claude_create("Checkpoints".into(), String::new(), path.to_string_lossy().into(), "fixture".into(), None).await.unwrap();
        let id = agent.id.as_str();
        until(|| ws.store.agent(id).unwrap().connection_state == "connected").await;
        ws.update_record(id, "test/turns", json!({}), |d| {
            let t = d.turn_mut("t1");
            t["status"] = "completed".into();
            t["items"] = json!([{"id":"t1:input","type":"userMessage","content":[],"nativeUuid":U1}]);
        }).await.unwrap();
        std::fs::write(path.join("checkpoints.json"), json!({U1:{"a.txt":null,"b.txt":"beta 1\n"}}).to_string()).unwrap();
        let changed = || {
            std::fs::write(path.join("a.txt"), "alpha 1\n").unwrap();
            std::fs::write(path.join("b.txt"), "beta 2\n").unwrap();
        };
        async fn restore(ws: &Arc<Workspace>, id: &str) -> Value {
            let shown = ws.claude_checkpoint_preview(id, U1).await.unwrap();
            ws.claude_checkpoint_restore(id, shown["previewId"].as_str().unwrap()).await.unwrap()
        }
        let reals = || file("rewinds").unwrap().lines().filter(|l| l.ends_with(" real")).count();

        // The rewind itself succeeds each time; only the check afterwards differs.
        for (after, reason) in [
            ("negative", "Checkpoint state could not be read."),
            ("missing", "Claude Code's check listed no files"),
            ("throw", "Claude Code exited while checking"),
        ] {
            std::fs::write(path.join("postcheck.json"), json!({"after":after}).to_string()).unwrap();
            changed();
            let before = file("rewinds").map_or(0, |_| reals());
            let result = restore(&ws, id).await;
            assert_eq!(result["status"], "unconfirmed", "{after}: {result}");
            assert!(result["checkError"].as_str().unwrap_or_default().contains(reason), "{after}: {result}");
            assert_eq!(result["remaining"], json!([]), "{after}");
            assert_eq!(result["error"], Value::Null, "{after}: Claude Code's rewind itself reported no error");
            assert_eq!(reals(), before + 1, "{after}: the restore is never sent again");
            assert!(file("a.txt").is_none() && file("b.txt").as_deref() == Some("beta 1\n"), "{after}");
        }
        std::fs::remove_file(path.join("postcheck.json")).unwrap();

        // A rewind that leaves a file as it was is partial, with its links.
        std::fs::write(path.join("partial.json"), json!({"keep":["b.txt"],"skippedLinks":1}).to_string()).unwrap();
        changed();
        let partial = restore(&ws, id).await;
        assert_eq!((partial["status"].clone(), partial["remaining"].clone(), partial["skippedLinks"].clone()),
            (json!("partial"), json!(["b.txt"]), json!(1)), "{partial}");
        assert_eq!(partial["checkError"], Value::Null);

        // A full restore, still reporting Claude Code's skipped links.
        std::fs::write(path.join("partial.json"), json!({"keep":[],"skippedLinks":2}).to_string()).unwrap();
        changed();
        let restored = restore(&ws, id).await;
        assert_eq!((restored["status"].clone(), restored["remaining"].clone(), restored["skippedLinks"].clone()),
            (json!("restored"), json!([]), json!(2)), "{restored}");
        assert_eq!(restored["checkError"], Value::Null);
        assert!(file("a.txt").is_none() && file("b.txt").as_deref() == Some("beta 1\n"));
    }

    #[tokio::test]
    async fn the_prompt_core_sent_names_its_checkpoint() {
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore {
            fn drop(&mut self) {
                match &self.0 {
                    Some(value) => std::env::set_var("YUZUNO_CLAUDE_BRIDGE", value),
                    None => std::env::remove_var("YUZUNO_CLAUDE_BRIDGE"),
                }
            }
        }
        let _env = crate::claude::BRIDGE_ENV.lock().await;
        let _restore = Restore(std::env::var_os("YUZUNO_CLAUDE_BRIDGE"));
        std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude_checkpoint_bridge.mjs"));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let ws = Workspace::new(path.join("data"), path.to_string_lossy().into(), "unused".into()).unwrap();
        let agent = ws.claude_create("Checkpoints".into(), String::new(), path.to_string_lossy().into(), "fixture".into(), None).await.unwrap();
        let id = agent.id.as_str();
        until(|| ws.store.agent(id).unwrap().connection_state == "connected").await;
        std::fs::write(path.join("b.txt"), "beta 1\n").unwrap();
        ws.claude_send(id, "write a.txt: alpha 1\nwrite b.txt: beta 2".into()).await.unwrap();
        let mut native = None;
        for _ in 0..400 {
            let d = ws.detail(id).await.unwrap();
            if d.turns.last().is_some_and(|t| t["status"] == "completed") {
                native = d.turns[0]["items"].as_array().unwrap().iter()
                    .find(|item| item["type"] == "userMessage").and_then(|item| item["nativeUuid"].as_str()).map(str::to_owned);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let native = native.expect("the prompt completed with its native uuid");
        assert_eq!(std::fs::read_to_string(path.join("b.txt")).unwrap(), "beta 2\n");
        let shown = ws.claude_checkpoint_preview(id, &native).await.unwrap();
        assert_eq!(shown["files"].as_array().unwrap().iter().map(|f| f["shown"].as_str().unwrap()).collect::<Vec<_>>(), ["a.txt", "b.txt"]);
        let restored = ws.claude_checkpoint_restore(id, shown["previewId"].as_str().unwrap()).await.unwrap();
        assert_eq!(restored["status"], "restored", "{restored}");
        assert!(!path.join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(path.join("b.txt")).unwrap(), "beta 1\n");
        // The conversation is unchanged.
        let d = ws.detail(id).await.unwrap();
        assert_eq!(d.turns.len(), 1);
        assert_eq!(d.turns[0]["status"], "completed");
    }
}
