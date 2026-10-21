//! A Codex Agent's native sub-agents, read only (T-60).
//!
//! When the Agent starts a sub-agent, Codex records `subAgentActivity` Items
//! in the parent Turn: kind started, interacted, interrupted or completed,
//! each with the child's thread. Core stores those Items like any other. A
//! child's details are read from Codex only when someone asks: its metadata
//! (`thread/read`) and its latest Turn in summary form (`thread/turns/list`).
//! Nothing is written, polled or copied per delta.
//!
//! The relationship is Codex's own record, never inferred from text: a
//! thread is read only if Codex names this Agent's thread as its parent.
//! That holds for children in this Agent's stored Turns and for those shown
//! from earlier native history pages, which Core does not store. Codex
//! 0.162.1 does not expose the goal the parent gave a child.
use crate::{codex_sessions::ReadSession, model::AgentDetail, rpc::Rpc, workspace::Workspace};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

const READ_TIMEOUT: Duration = Duration::from_secs(20);

/// What a direct sub-agent may ask through its parent Agent (T-63): approval
/// of a command or file change. Codex sends these, and their resolution, on
/// the parent's connection with the child's thread. Questions, MCP
/// elicitation and permission requests from a child are still refused.
pub(crate) const CHILD_REQUESTS: [&str; 2] = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
];

/// A sub-agent's proposed file changes, held only until its approval request
/// arrives: Codex 0.162.1 sends them in the child's `item/started`, about
/// 100 ms before a request that names only the Item. Kept in memory, out of
/// the parent's record, a few at a time and bounded in size.
#[derive(Default)]
pub(crate) struct ChildChanges(std::sync::Mutex<std::collections::VecDeque<(String, Value)>>);

const CHANGES_KEPT: usize = 32;
/// Shared by the diffs of one request, the size other long fields keep.
const DIFF_BYTES: usize = 64 * 1024;

impl ChildChanges {
    pub(crate) fn keep(&self, agent: &str, thread: &str, item: &Value) {
        let Some(id) = item["id"].as_str() else { return };
        let key = format!("{agent}\n{thread}\n{id}");
        let changes = bounded(&item["changes"]);
        let mut kept = self.0.lock().unwrap();
        kept.retain(|(k, _)| *k != key);
        if kept.len() >= CHANGES_KEPT {
            kept.pop_front();
        }
        kept.push_back((key, changes));
    }

    pub(crate) fn take(&self, agent: &str, thread: &str, item: &str) -> Option<Value> {
        let key = format!("{agent}\n{thread}\n{item}");
        let mut kept = self.0.lock().unwrap();
        let at = kept.iter().position(|(k, _)| *k == key)?;
        kept.remove(at).map(|(_, changes)| changes)
    }
}

fn bounded(changes: &Value) -> Value {
    let mut left = DIFF_BYTES;
    let all = changes.as_array().map(Vec::as_slice).unwrap_or_default();
    let shown: Vec<Value> = all
        .iter()
        .take(100)
        .map(|change| {
            let diff = change["diff"].as_str().unwrap_or_default();
            let mut end = diff.len().min(left);
            while !diff.is_char_boundary(end) {
                end -= 1;
            }
            left -= end;
            json!({"path": change["path"], "kind": change["kind"], "diff": &diff[..end],
                "truncated": end < diff.len()})
        })
        .collect();
    json!({"changes": shown, "omitted": all.len().saturating_sub(shown.len())})
}

/// `thread` as a direct sub-agent of this Agent, if Codex records it so on
/// the Agent's own thread: a `subAgentActivity` Item in one of its stored
/// Turns names the thread (Codex sends it before the child starts work). A
/// child's own sub-agents are on the child's thread, so never match; nothing
/// is inferred from a path, a nickname or text. The path is only a label.
pub(crate) fn recorded_child(detail: &AgentDetail, thread: &str) -> Option<Value> {
    detail
        .turns
        .iter()
        .rev()
        .filter_map(|turn| turn["items"].as_array())
        .flatten()
        .find(|item| item["type"] == "subAgentActivity" && item["agentThreadId"] == thread)
        .map(|item| json!({"threadId": thread, "path": item["agentPath"], "model": item["model"]}))
}

/// A long answer is cut to the same preview size as other long fields.
fn result_text(text: &str) -> Value {
    if text.len() <= crate::client_view::TRIM_ABOVE {
        return json!({"text": text, "truncated": false});
    }
    let mut end = crate::client_view::PREVIEW;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    json!({"text": &text[..end], "truncated": true})
}

async fn read(rpc: &Rpc, child: &str, parent: &str) -> Result<Value> {
    let response = rpc
        .request(
            "thread/read",
            json!({"threadId": child, "includeTurns": false}),
        )
        .await?;
    let thread = &response["thread"];
    anyhow::ensure!(thread["id"] == child, "Codex returned a different thread");
    anyhow::ensure!(
        thread["parentThreadId"] == parent,
        "Codex does not record this thread as a sub-agent of this Agent"
    );
    let spawn = &thread["source"]["subAgent"]["thread_spawn"];
    let turns = rpc
        .request(
            "thread/turns/list",
            json!({"threadId": child, "limit": 1, "sortDirection": "desc", "itemsView": "summary"}),
        )
        .await?;
    let latest = turns["data"].as_array().and_then(|turns| turns.first());
    let answer = latest.and_then(|turn| {
        turn["items"]
            .as_array()?
            .iter()
            .rev()
            .find(|item| item["type"] == "agentMessage")?["text"]
            .as_str()
    });
    Ok(json!({
        "threadId": child,
        "parentThreadId": parent,
        "nickname": spawn["agent_nickname"],
        "role": spawn["agent_role"],
        "path": spawn["agent_path"],
        "depth": spawn["depth"],
        "model": thread["model"],
        "status": thread["status"]["type"],
        "turn": latest.map(|turn| json!({
            "id": turn["id"],
            "status": turn["status"],
            "error": turn["error"]["message"],
        })),
        "result": answer.map(result_text),
    }))
}

const ENDED: [&str; 3] = ["completed", "failed", "interrupted"];

impl Workspace {
    /// After a reconnect or reconcile: a sub-agent's stale request whose Turn
    /// Codex now records as ended is dropped, as an ended Turn supersedes the
    /// parent's own stale approvals (`apply_snapshot`). The child's Turn is
    /// not in the parent's record, so it is read from Codex. A child that
    /// cannot be read, or whose Turn still runs, keeps its request: stale,
    /// unanswerable, and visible until Codex resolves or asks again.
    pub(crate) async fn settle_child_requests(&self, id: &str, rpc: &Rpc, generation: u64) {
        // Pending requests only: the send view has them without the Items.
        let Ok(detail) = self.send_view(id).await else { return };
        let stale: Vec<(String, String, Value)> = detail
            .pending
            .iter()
            .filter(|r| r.stale && r.params["isBlocking"] != false)
            .filter_map(|r| {
                let thread = r.params["_subAgent"]["threadId"].as_str()?;
                Some((r.id.clone(), thread.to_owned(), r.params["turnId"].clone()))
            })
            .collect();
        let mut ended = Vec::new();
        for (request, thread, turn) in stale {
            let read = tokio::time::timeout(
                READ_TIMEOUT,
                rpc.request(
                    "thread/turns/list",
                    json!({"threadId": thread, "limit": 20, "sortDirection": "desc", "itemsView": "summary"}),
                ),
            )
            .await;
            let Ok(Ok(page)) = read else { continue };
            let over = page["data"].as_array().into_iter().flatten().any(|t| {
                t["id"] == turn && t["status"].as_str().is_some_and(|s| ENDED.contains(&s))
            });
            if over {
                ended.push(request);
            }
        }
        if ended.is_empty() {
            return;
        }
        let owned = self.owner(id).await;
        if self.codex_connection(id).is_none_or(|(current, _)| current != generation) {
            return;
        }
        let agent = id.to_owned();
        let saved = self
            .stored_owned(owned, move |store| {
                store.update(&agent, "request/subAgentEnded", &json!({"requests": ended.clone()}), |d| {
                    d.pending.retain(|r| !(r.stale && ended.contains(&r.id)));
                    // Re-derives the pending count and waiting status.
                    d.apply("request/subAgentEnded", &json!({}));
                })
            })
            .await;
        if saved.is_ok() {
            self.changed(id);
        }
    }

    /// One sub-agent's current state and latest answer, read from Codex now:
    /// through the Agent's own connection, or a read-only session when the
    /// Agent is not connected.
    pub async fn codex_subagent(&self, id: &str, child: &str) -> Result<Value> {
        let _admission = self.admission.enter_completion()?;
        anyhow::ensure!(
            uuid::Uuid::parse_str(child).is_ok(),
            "Not a Codex thread ID"
        );
        let detail = self.detail(id).await?;
        anyhow::ensure!(
            detail.agent.harness == "codex",
            "Only Codex sub-agents are shown"
        );
        anyhow::ensure!(
            detail.agent.remote.is_none(),
            "Sub-agents of remote Codex Agents are not shown yet"
        );
        let parent = detail
            .agent
            .thread_id
            .clone()
            .context("This Agent has no Codex thread yet")?;
        let reading = async {
            if let Some((_, rpc)) = self.codex_connection(id) {
                return read(&rpc, child, &parent)
                    .await
                    .map(|snapshot| (snapshot, "live"));
            }
            let _permit = self
                .session_reads
                .try_acquire()
                .context("Another native history read is in progress; try again shortly")?;
            let session = ReadSession::open(&self.program).await?;
            let snapshot = read(&session.0, child, &parent).await;
            let _ = session.close().await;
            snapshot.map(|snapshot| (snapshot, "history"))
        };
        let (mut snapshot, from) = tokio::time::timeout(READ_TIMEOUT, reading)
            .await
            .context("Codex did not answer in time")??;
        snapshot["readFrom"] = from.into();
        snapshot["readAt"] = chrono::Utc::now().to_rfc3339().into();
        Ok(snapshot)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::model::AgentDetail;
    use std::os::unix::fs::PermissionsExt;

    const PARENT: &str = "00000000-0000-4000-8000-000000000000";
    const ALPHA: &str = "11111111-1111-4111-8111-111111111111";
    const BETA: &str = "22222222-2222-4222-8222-222222222222";
    const STRANGER: &str = "33333333-3333-4333-8333-333333333333";
    const UNRECORDED: &str = "44444444-4444-4444-8444-444444444444";
    /// A child of this Agent that only an earlier history page shows.
    const EARLIER: &str = "55555555-5555-4555-8555-555555555555";

    /// Codex as the probes saw it (0.162.1): ALPHA has answered, BETA is still
    /// running, an earlier child is only in history, STRANGER belongs to
    /// another parent. `<dir>/long` makes ALPHA's
    /// answer long.
    const CODEX: &str = r#"#!/usr/bin/python3
import json, os, sys
root = os.path.dirname(os.path.abspath(__file__))
P, A, B, S = "00000000-0000-4000-8000-000000000000", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"
def spawn(path, nick): return {"subAgent": {"thread_spawn": {"parent_thread_id": P, "depth": 1, "agent_path": path, "agent_nickname": nick, "agent_role": None}}}
children = {
  A: {"parentThreadId": P, "status": {"type": "idle"}, "source": spawn("/root/alpha", "Sartre"), "model": "m",
      "turn": {"id": "ta", "status": "completed", "error": None, "items": [{"type": "agentMessage", "id": "x", "text": "ALPHA"}]}},
  B: {"parentThreadId": P, "status": {"type": "active", "activeFlags": []}, "source": spawn("/root/beta", "Kant"), "model": "m",
      "turn": {"id": "tb", "status": "inProgress", "error": None, "items": []}},
  "55555555-5555-4555-8555-555555555555": {"parentThreadId": P, "status": {"type": "notLoaded"}, "source": spawn("/root/old", "Hume"), "model": "m",
      "turn": {"id": "to", "status": "completed", "error": None, "items": [{"type": "agentMessage", "id": "y", "text": "OLD"}]}},
  S: {"parentThreadId": "99999999-9999-4999-8999-999999999999", "status": {"type": "idle"}, "source": spawn("/root/s", "X"), "model": "m",
      "turn": {"id": "ts", "status": "completed", "error": None, "items": []}},
}
for line in sys.stdin:
    r = json.loads(line)
    if "id" not in r: continue
    m, p = r.get("method"), r.get("params") or {}
    result = {}
    if m in ["thread/start", "thread/resume"]:
        result = {"thread": {"id": P, "status": {"type": "idle"}, "turns": []}, "model": "m"}
    elif m == "thread/read" and p["threadId"] == P:
        result = {"thread": {"id": P, "status": {"type": "idle"}, "turns": [], "parentThreadId": None}}
    elif m == "thread/read":
        c = children.get(p["threadId"])
        if c is None:
            print(json.dumps({"id": r["id"], "error": {"code": -32600, "message": "thread not found"}}), flush=True); continue
        result = {"thread": {"id": p["threadId"], "parentThreadId": c["parentThreadId"], "status": c["status"], "source": c["source"], "model": c["model"], "preview": ""}}
    elif m == "thread/turns/list":
        turn = dict(children[p["threadId"]]["turn"])
        if p["threadId"] == A and os.path.exists(os.path.join(root, "long")):
            turn["items"] = [{"type": "agentMessage", "id": "x", "text": "é" * 9000}]
        result = {"data": [turn], "nextCursor": None}
    print(json.dumps({"id": r["id"], "result": result}), flush=True)
"#;

    fn activity(kind: &str, child: &str, path: &str) -> Value {
        json!({"type": "subAgentActivity", "id": format!("{kind}-{child}"), "kind": kind,
            "agentThreadId": child, "agentPath": path, "model": null, "reasoningEffort": null})
    }

    async fn workspace() -> (tempfile::TempDir, std::sync::Arc<Workspace>) {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("codex.py");
        std::fs::write(&script, CODEX).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let ws = Workspace::new(
            dir.path().join("data"),
            "/".into(),
            script.to_string_lossy().into(),
        )
        .unwrap();
        let detail: AgentDetail = serde_json::from_value(json!({
            "agent": {"id": "a", "name": "A", "cwd": "/", "model": "m", "color": "sage", "threadId": PARENT,
                "status": "idle", "createdAt": "", "updatedAt": "", "unreadCount": 0, "pendingCount": 0,
                "lastSeq": 0, "reviewedSeq": 0},
            "turns": [{"id": "t1", "status": "completed", "items": [
                {"type": "userMessage", "id": "u", "content": []},
                activity("started", ALPHA, "/root/alpha"), activity("started", BETA, "/root/beta"),
                activity("started", STRANGER, "/root/s"), activity("completed", ALPHA, "/root/alpha")]}],
            "pending": [], "artifacts": []})).unwrap();
        ws.store.insert(&detail).unwrap();
        (dir, ws)
    }

    #[tokio::test]
    async fn a_recorded_child_is_read_from_codex_with_its_state_and_answer() {
        let (_dir, ws) = workspace().await;
        ws.reconnect("a").await.unwrap();
        let alpha = ws.codex_subagent("a", ALPHA).await.unwrap();
        assert_eq!(alpha["readFrom"], "live");
        assert_eq!(
            (alpha["status"].as_str(), alpha["turn"]["status"].as_str()),
            (Some("idle"), Some("completed"))
        );
        assert_eq!(alpha["result"]["text"], "ALPHA");
        assert_eq!(
            (
                alpha["nickname"].as_str(),
                alpha["path"].as_str(),
                alpha["depth"].as_u64()
            ),
            (Some("Sartre"), Some("/root/alpha"), Some(1))
        );
        let beta = ws.codex_subagent("a", BETA).await.unwrap();
        assert_eq!(
            (beta["status"].as_str(), beta["turn"]["status"].as_str()),
            (Some("active"), Some("inProgress"))
        );
        assert!(
            beta["result"].is_null(),
            "a running child has no answer yet"
        );
    }

    #[tokio::test]
    async fn only_threads_codex_records_as_this_agents_children_are_read() {
        let (_dir, ws) = workspace().await;
        ws.reconnect("a").await.unwrap();
        // A child shown from an earlier native history page is not in the
        // stored Turns; Codex's own record of its parent is what counts.
        let earlier = ws.codex_subagent("a", EARLIER).await.unwrap();
        assert_eq!(
            (earlier["path"].as_str(), earlier["result"]["text"].as_str()),
            (Some("/root/old"), Some("OLD"))
        );
        let unknown = ws
            .codex_subagent("a", UNRECORDED)
            .await
            .unwrap_err()
            .to_string();
        assert!(unknown.contains("thread not found"), "{unknown}");
        let stranger = ws
            .codex_subagent("a", STRANGER)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            stranger.contains("does not record this thread as a sub-agent"),
            "{stranger}"
        );
        let not_an_id = ws
            .codex_subagent("a", "../etc/passwd")
            .await
            .unwrap_err()
            .to_string();
        assert!(not_an_id.contains("Not a Codex thread ID"), "{not_an_id}");
    }

    #[tokio::test]
    async fn without_a_connection_the_child_is_read_from_history_and_long_answers_are_cut() {
        let (dir, ws) = workspace().await;
        assert!(ws.codex_connection("a").is_none());
        std::fs::write(dir.path().join("long"), "").unwrap();
        let alpha = ws.codex_subagent("a", ALPHA).await.unwrap();
        assert_eq!(alpha["readFrom"], "history");
        assert_eq!(alpha["result"]["truncated"], true);
        let text = alpha["result"]["text"].as_str().unwrap();
        assert!(text.len() <= crate::client_view::PREVIEW && text.chars().all(|c| c == 'é'));
    }
}
