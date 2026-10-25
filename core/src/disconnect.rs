//! Disconnect (T-184): the user stops this open Agent's native session, and
//! nothing starts it again until their Reconnect (or Close and Reopen). The
//! Agent stays open: its identity, native session, settings, tasks and
//! history are kept, so are the drafts the browser keeps, and Core Jobs go
//! on. Close is different: it also ends the Agent (`closedAt`).
//!
//! Only a local Codex or Claude Agent that is provably idle is disconnected,
//! under its gate, so no send, mail Start or reconnect runs in between. Core's
//! record must show no Turn, request, unconfirmed message or missing Turn;
//! the native runtime must confirm idle; and background work must be known
//! to be none. Anything unknown refuses, and a refusal changes nothing. The
//! transport is closed as the update detach closes it, for this generation
//! only, so a late event of the old connection changes nothing.
use crate::{
    model::{now, Agent, AgentDetail},
    store::Activity,
    workspace::{Connection, Workspace},
};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

/// At most this many Codex sub-agents are read before a disconnect; more
/// than that refuses rather than reading without end.
const MAX_CHILDREN: usize = 20;
const CHILD_READ: Duration = Duration::from_secs(10);

/// Why Core's own record says this Agent can't be disconnected now; None
/// leaves only the native checks.
pub(crate) fn refusal(detail: &AgentDetail) -> Option<String> {
    let agent = &detail.agent;
    if agent.closed_at.is_some() {
        return Some("this Agent is closed".into());
    }
    if agent.disconnected_at.is_some() {
        return Some("you already disconnected this Agent".into());
    }
    if agent.remote.is_some() {
        return Some("an Agent on an SSH machine can't be disconnected yet: its native runtime there outlives this connection".into());
    }
    if !matches!(agent.harness.as_str(), "codex" | "claude") {
        return Some("only Codex and Claude Code Agents can be disconnected in this version: processes an OpenCode tool started can outlive OpenCode".into());
    }
    if agent.connection_state != "connected" {
        return Some("this Agent isn't connected, so there is no native session to stop".into());
    }
    if let Some(reason) = crate::updates::lifecycle::blocked_activity(agent, Activity::of(detail)) {
        return Some(reason.to_lowercase());
    }
    if !detail.pending.is_empty() {
        return Some("a request from this Agent is still shown; answer it or let it end first".into());
    }
    if agent.status != "idle" {
        return Some(format!("this Agent isn't idle ({})", agent.status));
    }
    if detail.codex_handoff.as_ref().is_some_and(|handoff| handoff.missing_turns.is_some()) {
        return Some("a Turn missing from Codex's own history must be ended first".into());
    }
    if agent.harness == "claude" && detail.turns.iter().any(claude_task_running) {
        return Some("a Claude sub-agent or background task is still running".into());
    }
    None
}

/// A Turn of a Claude Agent with a sub-agent or background task still able
/// to report (crate::claude::subagent_running).
fn claude_task_running(turn: &Value) -> bool {
    turn["items"].as_array().into_iter().flatten().any(|item| {
        crate::claude::TASK_RECORDS.iter().any(|key| crate::claude::subagent_running(&item[*key]))
    })
}

/// The Codex sub-agents this Agent's stored Turns name, each once.
fn codex_children(detail: &AgentDetail) -> Vec<String> {
    let mut children: Vec<String> = Vec::new();
    for turn in &detail.turns {
        for item in turn["items"].as_array().into_iter().flatten() {
            if item["type"] != "subAgentActivity" {
                continue;
            }
            if let Some(child) = item["agentThreadId"].as_str() {
                if !children.iter().any(|known| known == child) {
                    children.push(child.to_owned());
                }
            }
        }
    }
    children
}

/// A Codex thread status that is not work: loaded and idle, not loaded at
/// all, or stopped by an error. Anything else, `active` or one this Core
/// doesn't know, counts as running.
fn codex_thread_at_rest(status: &Value) -> bool {
    matches!(status.as_str(), Some("idle" | "notLoaded" | "systemError"))
}

impl Workspace {
    /// Disconnects this Agent as the user asked, or refuses with why. On
    /// success its native session is stopped, it is offline and disconnected,
    /// and `disconnectedAt` records the user's choice.
    pub async fn disconnect_agent(self: &Arc<Self>, id: &str) -> Result<Agent> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let detail = self.detail(id).await?;
        if let Some(reason) = refusal(&detail) {
            bail!("Not disconnected: {reason}. Nothing changed.");
        }
        match detail.agent.harness.as_str() {
            "codex" => {
                let connection = self
                    .rpcs
                    .lock()
                    .unwrap()
                    .get(id)
                    .cloned()
                    .filter(|c| !c.closing)
                    .context("Not disconnected: this Agent has no live Codex connection. Nothing changed.")?;
                let thread = detail
                    .agent
                    .thread_id
                    .clone()
                    .context("Not disconnected: this Agent has no Codex thread yet. Nothing changed.")?;
                match crate::background_shells::codex_count_now(self, id, &thread).await {
                    Some(0) => {}
                    Some(count) => bail!("Not disconnected: {count} background terminal(s) are still running. Nothing changed."),
                    None => bail!("Not disconnected: Codex didn't say whether background terminals are running. Nothing changed."),
                }
                self.codex_children_at_rest(&connection, &detail).await?;
                self.detach_idle_codex(id, &connection)
                    .await
                    .map_err(|error| anyhow!("Not disconnected: {error}. The connection was kept if it could be."))?;
            }
            "claude" => {
                let connection = self
                    .claudes
                    .lock()
                    .unwrap()
                    .get(id)
                    .cloned()
                    .context("Not disconnected: this Agent has no live Claude connection. Nothing changed.")?;
                if let Some(count) = self.background_shells.claude_active(id, connection.generation).filter(|count| *count > 0) {
                    bail!("Not disconnected: {count} Claude background task(s) are still running. Nothing changed.");
                }
                self.detach_idle_claude(id, &connection)
                    .await
                    .map_err(|error| anyhow!("Not disconnected: {error}. The connection was kept if it could be."))?;
            }
            other => bail!("Not disconnected: {other} Agents can't be disconnected. Nothing changed."),
        }
        let at = now();
        let stamp = at.clone();
        self.record_meta(id, "agent/disconnected", json!({"at": at}), move |m| {
            m.agent.disconnected_at = Some(stamp);
            m.agent.status = "offline".into();
            m.agent.connection_state = "disconnected".into();
        })
        .await
        .map_err(|error| anyhow!("The native session stopped, but your choice to keep it disconnected wasn't saved ({error}); something may start it again"))?;
        self.changed(id);
        self.listed(id).await
    }

    /// The user's Reconnect: an Agent they disconnected may be started again
    /// from now on. Only this, Close and Reopen clear their choice.
    pub(crate) async fn clear_disconnect(&self, id: &str) -> Result<()> {
        if self.listed(id).await?.disconnected_at.is_none() {
            return Ok(());
        }
        self.record_meta(id, "agent/reconnectChosen", json!({}), |m| {
            m.agent.disconnected_at = None;
        })
        .await?;
        self.changed(id);
        Ok(())
    }

    /// Every sub-agent this Codex Agent started is at rest, read from Codex
    /// now on its own connection; one that is running, or that Codex doesn't
    /// answer for, refuses.
    async fn codex_children_at_rest(&self, connection: &Connection, detail: &AgentDetail) -> Result<()> {
        let children = codex_children(detail);
        if children.len() > MAX_CHILDREN {
            bail!("Not disconnected: this Agent started {} sub-agents, more than this check reads. Nothing changed.", children.len());
        }
        for child in children {
            let read = connection
                .rpc
                .request_within("thread/read", json!({"threadId": child, "includeTurns": false}), CHILD_READ)
                .await;
            let status = match read {
                Ok(read) => read["thread"]["status"]["type"].clone(),
                Err(error) => bail!("Not disconnected: Codex didn't say whether sub-agent {child} is running ({error}). Nothing changed."),
            };
            if !codex_thread_at_rest(&status) {
                bail!("Not disconnected: Codex sub-agent {child} is {status}. Nothing changed.");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CodexHandoff, MessageReceipt, MissingTurns, PendingRequest};

    /// A local, connected, idle Agent with one finished Turn, as the
    /// update probe's fixture has it (updates/storage.rs).
    fn detail(harness: &str) -> AgentDetail {
        let mut detail: AgentDetail = serde_json::from_value(json!({
            "agent": {"id": "a", "name": "a", "cwd": "/fixture", "model": "m", "color": "sage",
                "threadId": "thread", "status": "idle", "createdAt": "", "updatedAt": "",
                "unreadCount": 0, "pendingCount": 0, "lastSeq": 0, "reviewedSeq": 0},
            "turns": [{"id": "t1", "status": "completed", "items": []}],
            "pending": [], "artifacts": []
        }))
        .unwrap();
        detail.agent.harness = harness.into();
        detail.agent.connection_state = "connected".into();
        detail
    }

    #[test]
    fn only_an_open_connected_idle_local_codex_or_claude_agent_with_nothing_open_may_go_on_to_the_native_checks() {
        for harness in ["codex", "claude"] {
            assert_eq!(refusal(&detail(harness)), None, "{harness}");
        }
        let cases: Vec<(&str, Box<dyn Fn(&mut AgentDetail)>)> = vec![
            ("closed", Box::new(|d| d.agent.closed_at = Some("x".into()))),
            ("already disconnected", Box::new(|d| d.agent.disconnected_at = Some("x".into()))),
            ("ssh", Box::new(|d| d.agent.remote = Some(crate::model::RemoteAgent::new(crate::remote::RemoteMachine { name: "lab".into(), ..Default::default() })))),
            ("opencode", Box::new(|d| d.agent.harness = "opencode".into())),
            ("not connected", Box::new(|d| d.agent.connection_state = "disconnected".into())),
            ("connecting", Box::new(|d| d.agent.connection_state = "connecting".into())),
            ("working", Box::new(|d| d.agent.status = "working".into())),
            ("uncertain", Box::new(|d| d.agent.status = "uncertain".into())),
            ("turn in progress", Box::new(|d| d.turns.push(json!({"id": "t2", "status": "inProgress", "items": []})))),
            ("pending", Box::new(|d| d.pending.push(pending(false)))),
            ("stale pending", Box::new(|d| d.pending.push(pending(true)))),
            ("sending", Box::new(|d| d.message_receipts.push(receipt("sending")))),
            ("unconfirmed message", Box::new(|d| d.message_receipts.push(receipt("uncertain")))),
            ("missing turn", Box::new(|d| d.codex_handoff = Some(missing()))),
        ];
        for (what, change) in cases {
            let mut d = detail("codex");
            change(&mut d);
            assert!(refusal(&d).is_some(), "{what} must refuse");
        }
        let mut claude = detail("claude");
        claude.turns[0]["items"] = json!([{"id": "call", "subAgent": {"status": "running"}}]);
        assert!(refusal(&claude).is_some(), "a Claude sub-agent still running refuses");
        claude.turns[0]["items"] = json!([{"id": "call", "backgroundTask": {"status": "running"}}]);
        assert!(refusal(&claude).is_some(), "a Claude background task still running refuses");
        claude.turns[0]["items"] = json!([{"id": "call", "subAgent": {"status": "completed"}}, {"id": "b", "backgroundTask": {"status": "unknown"}}]);
        assert_eq!(refusal(&claude), None, "ended ones, or ones a gone runtime left unknown, don't");
    }

    #[test]
    fn codex_sub_agents_are_named_once_and_only_a_thread_at_rest_allows_it() {
        let mut d = detail("codex");
        d.turns[0]["items"] = json!([
            {"type": "subAgentActivity", "kind": "started", "agentThreadId": "c1"},
            {"type": "subAgentActivity", "kind": "completed", "agentThreadId": "c1"},
            {"type": "subAgentActivity", "kind": "started", "agentThreadId": "c2"},
            {"type": "agentMessage", "text": "c3"}
        ]);
        assert_eq!(codex_children(&d), vec!["c1".to_owned(), "c2".to_owned()]);
        for at_rest in ["idle", "notLoaded", "systemError"] {
            assert!(codex_thread_at_rest(&json!(at_rest)), "{at_rest}");
        }
        for running in [json!("active"), json!("somethingNew"), Value::Null] {
            assert!(!codex_thread_at_rest(&running), "{running}");
        }
    }

    fn pending(stale: bool) -> PendingRequest {
        PendingRequest { id: "r".into(), agent_id: "a".into(), method: "m".into(), params: json!({}), created_at: "".into(), stale }
    }

    fn receipt(status: &str) -> MessageReceipt {
        serde_json::from_value(json!({
            "input": {"clientMessageId": "c", "text": "hi"}, "status": status, "turnId": null, "error": null
        }))
        .unwrap()
    }

    fn missing() -> CodexHandoff {
        let mut handoff: CodexHandoff = serde_json::from_value(json!({})).unwrap();
        handoff.missing_turns = Some(serde_json::from_value::<MissingTurns>(json!({
            "turnIds": ["t9"], "threadId": "t", "generation": 1, "nativeStatus": "idle", "checkedAt": ""
        })).unwrap());
        handoff
    }
}
