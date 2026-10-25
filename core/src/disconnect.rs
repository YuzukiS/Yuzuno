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
//!
//! A Claude Agent on an SSH machine is checked the same way, through its
//! host there. Ending SSH proves only that SSH ended, so the host is asked to
//! stop the native runtime and answers once it has exited
//! (runtimes/claude/remote-host.mjs `host_stop`). The user's choice is
//! recorded before asking, marked unconfirmed: a host that refuses, or is too
//! old to know the request, withdraws it and changes nothing; a confirmed
//! stop makes it an ordinary Disconnect; anything else (no answer, SSH lost,
//! a stop the host can't confirm, a Core restart) leaves it held, unconfirmed,
//! until the user's Reconnect.
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
    if !matches!(agent.harness.as_str(), "codex" | "claude") {
        return Some("only Codex and Claude Code Agents can be disconnected in this version: processes an OpenCode tool started can outlive OpenCode".into());
    }
    if agent.remote.is_some() && agent.harness != "claude" {
        return Some("a Codex Agent on an SSH machine can't be disconnected yet: its runtime there is stopped another way".into());
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
                match &detail.agent.remote {
                    Some(remote) => self.detach_idle_remote_claude(id, &connection, &remote.machine.name).await?,
                    None => self
                        .detach_idle_claude(id, &connection)
                        .await
                        .map_err(|error| anyhow!("Not disconnected: {error}. The connection was kept if it could be."))?,
                }
            }
            other => bail!("Not disconnected: {other} Agents can't be disconnected. Nothing changed."),
        }
        let at = now();
        let stamp = at.clone();
        self.record_meta(id, "agent/disconnected", json!({"at": at}), move |m| {
            m.agent.disconnected_at = Some(stamp);
            m.agent.disconnect_unconfirmed = false;
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
        let agent = self.listed(id).await?;
        if agent.disconnected_at.is_none() && !agent.disconnect_unconfirmed {
            return Ok(());
        }
        self.record_meta(id, "agent/reconnectChosen", json!({}), |m| {
            m.agent.disconnected_at = None;
            m.agent.disconnect_unconfirmed = false;
        })
        .await?;
        self.changed(id);
        Ok(())
    }

    /// As detach_idle_claude (updates/lifecycle.rs), for a Claude Agent on an
    /// SSH machine: idle by the bridge there and by what this generation has
    /// reported, then its host stops the bridge and says whether it exited
    /// cleanly. The user's choice is recorded first, unconfirmed. Only a
    /// refusal withdraws it (nothing changed); only a confirmed stop returns
    /// Ok. Otherwise this end is closed and the choice stays, unconfirmed.
    async fn detach_idle_remote_claude(self: &Arc<Self>, id: &str, connection: &crate::claude::Connection, machine: &str) -> Result<()> {
        let kept = |error: anyhow::Error| anyhow!("Not disconnected: {error}. Nothing changed.");
        let status = connection.bridge.request(json!({"op": "status"})).await.map_err(kept)?;
        if !crate::updates::lifecycle::claude_idle(&status) {
            bail!("Not disconnected: Claude on {machine} hasn't confirmed it is idle. Nothing changed.");
        }
        let events = connection.events.as_ref().context("Not disconnected: the native event barrier is missing. Nothing changed.")?;
        events.drain().await.map_err(kept)?;
        // What this generation reported meanwhile: the record and its
        // background tasks (the bridge's status doesn't count those).
        if let Some(reason) = refusal(&self.detail(id).await?) {
            bail!("Not disconnected: {reason}. Nothing changed.");
        }
        if let Some(count) = self.background_shells.claude_active(id, connection.generation).filter(|count| *count > 0) {
            bail!("Not disconnected: {count} Claude background task(s) are still running. Nothing changed.");
        }
        let at = now();
        self.record_meta(id, "agent/disconnectRequested", json!({"at": at}), move |m| {
            m.agent.disconnected_at = Some(at);
            m.agent.disconnect_unconfirmed = true;
        })
        .await
        .map_err(kept)?;
        self.changed(id);
        let reason = |answer: &Value| answer["reason"].as_str().unwrap_or("no reason given").to_owned();
        // None: it stopped. Some(Ok(why)): it refused, and nothing stopped.
        // Some(Err(why)): whether it stopped isn't known.
        let outcome = match connection.bridge.request(json!({"op": "host_stop"})).await {
            Ok(answer) if answer["stopped"] == true => None,
            Ok(answer) if answer["stopped"] == false => Some(Ok(format!("Claude's host on {machine} refused: {}", reason(&answer)))),
            Ok(answer) => Some(Err(reason(&answer))),
            // Answered by the bridge itself: a host from an earlier Core
            // passed the request on, and nothing stopped.
            Err(error) if error.downcast_ref::<crate::claude::Rejected>().is_some() => Some(Ok(format!(
                "the Claude host on {machine} is from an earlier version and can't confirm a stop ({error})"
            ))),
            Err(error) => Some(Err(error.to_string())),
        };
        let unknown = match outcome {
            None => None,
            Some(Err(why)) => Some(why),
            Some(Ok(why)) => {
                self.record_meta(id, "agent/disconnectRefused", json!({}), |m| {
                    m.agent.disconnected_at = None;
                    m.agent.disconnect_unconfirmed = false;
                })
                .await
                .map_err(|error| anyhow!("Not disconnected: {why}, but your choice couldn't be withdrawn ({error}); it stays disconnected until you press Reconnect"))?;
                self.changed(id);
                bail!("Not disconnected: {why}. Nothing changed.");
            }
        };
        // The host is stopping, or its answer was lost: this generation ends.
        events.mark_closing();
        let _ = connection.bridge.close_and_wait().await;
        let _ = events.drain().await;
        {
            let _owned = self.owner(id).await;
            let mut connections = self.claudes.lock().unwrap();
            if connections.get(id).is_some_and(|c| c.generation == connection.generation) {
                connections.remove(id);
            }
        }
        if let Some(why) = unknown {
            self.changed(id);
            bail!(
                "Not confirmed: Claude on {machine} didn't confirm it stopped ({why}). Yuzuno closed its connection and keeps this Agent disconnected: nothing starts it until you press Reconnect."
            );
        }
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
    use crate::workspace::Workspace;

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
        let mut ssh_claude = detail("claude");
        ssh_claude.agent.remote = Some(crate::model::RemoteAgent::new(crate::remote::RemoteMachine { name: "lab".into(), ..Default::default() }));
        assert_eq!(refusal(&ssh_claude), None, "a Claude Agent on an SSH machine goes on to its host's checks");
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

    /// Stands in for SSH and a machine's Claude host (remote-host.mjs) behind
    /// it: answers as an idle bridge, and `host_stop` as `mode` says: `ok`,
    /// `busy`, `older` (an earlier host passes it on and its bridge refuses),
    /// `unconfirmed`, or `lost` (SSH ends with no answer). Logs every op.
    const HOST: &str = r#"
const [log, mode] = process.argv.slice(2);
const fs = require('node:fs');
const out = v => process.stdout.write(JSON.stringify(v) + '\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const c = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify(c) + '\n');
  const reply = result => out({ type: 'response', id: c.id, result });
  if (c.op === 'start') return reply({ started: true, sessionId: c.sessionId });
  if (c.op === 'status') return reply({ ready: true, turnId: null, pendingCount: 0, configuring: false, interrupting: false });
  if (c.op !== 'host_stop') return reply({});
  if (mode === 'ok') return reply({ stopped: true, exit: { code: 0, signal: null } });
  if (mode === 'busy') return reply({ stopped: false, reason: 'Claude on this machine is not idle' });
  if (mode === 'older') return out({ type: 'response', id: c.id, error: 'Unknown operation' });
  if (mode === 'unconfirmed') return reply({ stopped: null, reason: 'the Claude bridge on this machine only ended after SIGTERM' });
  process.exit(0);
});
process.stdin.on('end', () => process.exit(0));
"#;

    /// A connected, idle Claude Agent on machine `machine` whose session is
    /// `session-1`, over HOST in `mode`; None where Node is missing.
    async fn ssh_claude(dir: &std::path::Path, machine: &str, mode: &str) -> Option<Arc<Workspace>> {
        if std::process::Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is not installed; skipped");
            return None;
        }
        let script = dir.join("host.cjs");
        std::fs::write(&script, HOST).unwrap();
        let argv = ["node".to_owned(), script.to_string_lossy().into_owned(), dir.join("ops.jsonl").to_string_lossy().into_owned(), mode.to_owned()];
        crate::claude::REMOTE_ATTACH.lock().unwrap().push((machine.to_owned(), argv.into()));
        let ws = Workspace::new(dir.join("data"), dir.to_string_lossy().into(), "unused".into()).unwrap();
        let mut d = detail("claude");
        d.agent.thread_id = None;
        d.agent.claude_session_id = Some("session-1".into());
        d.agent.connection_state = "disconnected".into();
        d.agent.status = "offline".into();
        d.agent.remote = Some(crate::model::RemoteAgent::new(crate::remote::RemoteMachine { id: machine.into(), name: "Mac mini".into(), target: "tester@192.0.2.10".into(), ..Default::default() }));
        ws.store.insert(&d).unwrap();
        ws.claude_ensure("a").await.unwrap();
        assert_eq!(ws.store.detail("a").unwrap().agent.connection_state, "connected");
        Some(ws)
    }

    fn ops(dir: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("ops.jsonl")).unwrap_or_default().lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["op"].as_str().unwrap_or_default().to_owned())
            .filter(|op| ["start", "status", "host_stop", "send", "append"].contains(&op.as_str()))
            .collect()
    }

    /// Ends the stand-in's process, if this generation is still open.
    async fn close(ws: &Workspace) {
        let open = ws.claudes.lock().unwrap().remove("a");
        if let Some(connection) = open {
            let _ = connection.bridge.close_and_wait().await;
        }
    }

    async fn until(what: &str, done: impl Fn() -> bool) {
        for _ in 0..200 {
            if done() { return; }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("{what}");
    }

    /// T-184: an SSH Claude Agent is disconnected only once its host says the
    /// native runtime exited; then it is an ordinary Disconnect.
    #[tokio::test]
    async fn an_ssh_claude_agent_is_disconnected_once_its_host_confirms_the_stop() {
        let dir = tempfile::tempdir().unwrap();
        let Some(ws) = ssh_claude(dir.path(), "t184-ssh-ok", "ok").await else { return };
        let agent = ws.disconnect_agent("a").await.unwrap();
        assert!(agent.disconnected_at.is_some());
        assert!(!agent.disconnect_unconfirmed);
        assert_eq!((agent.status.as_str(), agent.connection_state.as_str()), ("offline", "disconnected"));
        assert!(ws.claudes.lock().unwrap().get("a").is_none(), "this generation is closed");
        assert_eq!(ops(dir.path()), ["start", "status", "host_stop"]);
        let error = ws.send("a", "not now".into()).await.unwrap_err().to_string();
        assert!(error.contains("disconnected"), "{error}");
        assert_eq!(ops(dir.path()).iter().filter(|op| *op == "start").count(), 1, "nothing started it again");
    }

    /// A host that refuses, or one from an earlier Core that passes the
    /// request to its bridge, withdraws the choice: nothing changed.
    #[tokio::test]
    async fn an_ssh_claude_host_that_refuses_or_is_older_changes_nothing() {
        for (machine, mode, said) in [("t184-ssh-busy", "busy", "refused: Claude on this machine is not idle"), ("t184-ssh-older", "older", "earlier version")] {
            let dir = tempfile::tempdir().unwrap();
            let Some(ws) = ssh_claude(dir.path(), machine, mode).await else { return };
            let error = ws.disconnect_agent("a").await.unwrap_err().to_string();
            assert!(error.contains(said) && error.ends_with("Nothing changed."), "{mode}: {error}");
            let agent = ws.store.detail("a").unwrap().agent;
            assert!(agent.disconnected_at.is_none() && !agent.disconnect_unconfirmed, "{mode}");
            assert_eq!(agent.connection_state, "connected", "{mode}");
            assert!(ws.claudes.lock().unwrap().get("a").is_some(), "{mode}: the connection is kept");
            assert_eq!(ops(dir.path()), ["start", "status", "host_stop"], "{mode}");
            close(&ws).await;
        }
    }

    /// A stop the host can't confirm, or an answer SSH lost, is not called a
    /// Disconnect, yet nothing starts the Agent again: not a send, a mail
    /// Start or recovery (claude_ensure), nor a Core restart. The user's
    /// Reconnect resumes the same session.
    #[tokio::test]
    async fn an_unconfirmed_ssh_claude_stop_holds_the_agent_until_the_users_reconnect() {
        for (machine, mode) in [("t184-ssh-unconfirmed", "unconfirmed"), ("t184-ssh-lost", "lost")] {
            let dir = tempfile::tempdir().unwrap();
            let Some(ws) = ssh_claude(dir.path(), machine, mode).await else { return };
            let error = ws.disconnect_agent("a").await.unwrap_err().to_string();
            assert!(error.starts_with("Not confirmed: Claude on Mac mini didn't confirm it stopped"), "{mode}: {error}");
            until("this generation to close", || ws.claudes.lock().unwrap().get("a").is_none()).await;
            let agent = ws.store.detail("a").unwrap().agent;
            assert!(agent.disconnected_at.is_some() && agent.disconnect_unconfirmed, "{mode}: held, unconfirmed");
            assert!(ws.send("a", "not now".into()).await.is_err(), "{mode}: a send");
            assert!(ws.claude_ensure("a").await.is_err(), "{mode}: a mail Start or recovery");
            drop(ws);
            let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
            let restarted = ws.store.detail("a").unwrap().agent;
            assert!(restarted.disconnected_at.is_some() && restarted.disconnect_unconfirmed, "{mode}: after a restart");
            assert!(ws.claude_ensure("a").await.is_err(), "{mode}: after a restart");
            assert_eq!(ops(dir.path()).iter().filter(|op| *op == "start").count(), 1, "{mode}: nothing started it again");
            let reconnected = ws.reconnect("a").await.unwrap().agent;
            assert!(reconnected.disconnected_at.is_none() && !reconnected.disconnect_unconfirmed, "{mode}");
            assert_eq!(reconnected.connection_state, "connected", "{mode}");
            let starts: Vec<Value> = std::fs::read_to_string(dir.path().join("ops.jsonl")).unwrap().lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap()).filter(|c| c["op"] == "start").collect();
            assert_eq!(starts.len(), 2, "{mode}");
            assert_eq!(starts[1]["sessionId"], "session-1", "{mode}: the same session resumes");
            close(&ws).await;
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
