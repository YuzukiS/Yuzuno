//! A narrowly scoped control mailbox: one original Turn per update recipient.
//! The operation journal is authority at delivery AND at peer_read. A late
//! native hook contains only a fetch instruction, never a stale pause command.
use super::state::{Operation, Phase, ProcessIdentity};
use crate::{model::AgentDetail, workspace::Workspace};
use anyhow::{Context, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::Arc;

mod store;
#[cfg(all(test, unix))]
mod tests;

fn active_turn(detail: &AgentDetail) -> Option<&str> {
    detail
        .turns
        .iter()
        .find(|turn| turn["status"] == "inProgress")?["id"]
        .as_str()
}
fn session(detail: &AgentDetail) -> Option<&str> {
    match detail.agent.harness.as_str() {
        "claude" => detail.agent.claude_session_id.as_deref(),
        "opencode" => detail.agent.opencode_session_id.as_deref(),
        _ => detail.agent.thread_id.as_deref(),
    }
}
fn same_turn(message: &Value, detail: &AgentDetail) -> bool {
    let target = &message["metadata"];
    detail.agent.closed_at.is_none()
        && detail.agent.harness == target["harness"]
        && session(detail) == target["sessionId"].as_str()
        && active_turn(detail) == target["turnId"].as_str()
        && active_turn(detail).is_some()
}

impl Workspace {
    fn current_update_wait(&self) -> Result<Option<Operation>> {
        let Some(layout) = self.update_notice_layout.get() else {
            return Ok(None);
        };
        let Some(op) = layout.journal()?.operation else {
            return Ok(None);
        };
        let admission = self.admission.snapshot();
        Ok((op.phase == Phase::Waiting
            && !admission.sealed
            && admission.operation_id.as_deref() == Some(&op.id)
            && chrono::DateTime::parse_from_rfc3339(&op.deadline)? > chrono::Utc::now()
            && op.old_process == ProcessIdentity::read(std::process::id())?)
        .then_some(op))
    }

    /// Called on the blocking store path, also for a delayed native doorbell.
    /// Persisted history remains intact; expired instructions are not executable.
    pub(crate) fn project_update_notices(&self, output: &mut Value) -> Result<()> {
        let Some(messages) = output["messages"].as_array_mut() else {
            return Ok(());
        };
        if !messages
            .iter()
            .any(|m| m["metadata"]["kind"] == "update_wait")
        {
            return Ok(());
        }
        let current = self.current_update_wait().ok().flatten();
        for message in messages
            .iter_mut()
            .filter(|m| m["metadata"]["kind"] == "update_wait")
        {
            let active = current
                .as_ref()
                .is_some_and(|op| message["metadata"]["operationId"] == op.id)
                && message["recipient"]["id"]
                    .as_str()
                    .and_then(|id| self.store.detail(id).ok())
                    .is_some_and(|d| same_turn(message, &d));
            message["updateWait"] =
                json!({"active":active,"operationId":message["metadata"]["operationId"]});
            if !active {
                message["body"] = json!("This update pause request has expired or its original Turn has ended. Do not pause for it. It does not resume or replay any previous work; follow the user's current instructions. No reply is needed.");
            }
        }
        Ok(())
    }

    pub(crate) fn update_pause_status(&self, operation: &Operation) -> Result<Value> {
        let current = self.current_update_wait().ok().flatten();
        let mut rows = vec![];
        for message in self.store.update_pause_messages(&operation.id)? {
            let id = message["recipient"]["id"].as_str().unwrap_or_default();
            let detail = self.store.detail(id).ok();
            let idle = detail.as_ref().is_some_and(|d| {
                d.agent.closed_at.is_none()
                    && d.agent.status == "idle"
                    && active_turn(d).is_none()
                    && d.agent.pending_count == 0
            });
            rows.push(json!({"agentId":id,"name":message["recipient"]["name"],
                "messageId":message["id"],"turnId":message["metadata"]["turnId"],
                "delivery":message["delivery"]["state"],"readAt":message["firstReadAt"],
                "idle":idle,"active":current.as_ref().is_some_and(|op| op.id == operation.id)
                    && detail.as_ref().is_some_and(|d| same_turn(&message,d))}));
        }
        Ok(json!(rows))
    }

    /// Reuses the collaboration worker; no additional watcher or model polling.
    pub(crate) async fn deliver_update_notices(self: &Arc<Self>) -> Result<()> {
        let ws = self.clone();
        let Some(op) = crate::db::blocking(move || ws.current_update_wait()).await? else {
            return Ok(());
        };
        let operation = op.clone();
        // Covers a crash/error between persisting Waiting and capturing targets.
        // A replacement Core cannot capture new targets for the old process.
        let messages = self
            .stored(move |store| {
                store.queue_update_pause(&operation)?;
                store.update_pause_messages(&operation.id)
            })
            .await?;
        futures_util::stream::iter(
            messages
                .into_iter()
                .filter(|m| m["delivery"]["state"] == "pending" && m["firstReadAt"].is_null()),
        )
        .for_each_concurrent(2, |message| {
            let op = &op;
            async move {
                if let Err(error) = self.deliver_update_notice(op, message).await {
                    eprintln!("Update recipient notification: {error:#}");
                }
            }
        })
        .await;
        Ok(())
    }

    async fn deliver_update_notice(self: &Arc<Self>, op: &Operation, message: Value) -> Result<()> {
        let Ok(_permit) = self.admission.enter_update_notice(&op.id) else {
            return Ok(());
        };
        let id = message["recipient"]["id"]
            .as_str()
            .context("Update recipient missing")?;
        let gate = self.gate(id).await;
        let Ok(_held) = gate.try_lock() else {
            return Ok(());
        };
        let detail = match self.detail(id).await {
            Ok(d) => d,
            Err(_) => return Ok(()),
        };
        if !same_turn(&message, &detail) {
            let m = message.clone();
            self.stored(move |store| {
                store.set_update_pause_delivery(
                    &m,
                    "pending",
                    "error",
                    json!({"reason":"original_turn_ended"}),
                )
            })
            .await?;
            return Ok(());
        }
        if detail.agent.harness == "opencode" {
            // OpenCode takes no message into a running Turn (yet).
            let m = message.clone();
            self.stored(move |store| store.set_update_pause_delivery(&m, "pending", "error",
                json!({"reason":"harness_unsupported"}))).await?;
            return Ok(());
        }
        if detail.agent.connection_state != "connected"
            || !matches!(detail.agent.status.as_str(), "working" | "waiting")
            || detail
                .message_receipts
                .iter()
                .any(|r| matches!(r.status.as_str(), "sending" | "uncertain"))
        {
            return Ok(());
        }
        let agent = id.to_owned();
        if self
            .stored(move |store| store.codex_handoff_pending(&agent))
            .await?
        {
            return Ok(());
        }
        if self.require_collaboration(id).await.is_err() {
            return Ok(());
        }
        let (ws, operation_id) = (self.clone(), op.id.clone());
        if !crate::db::blocking(move || {
            Ok(ws
                .current_update_wait()?
                .is_some_and(|o| o.id == operation_id))
        })
        .await?
        {
            return Ok(());
        }
        let turn = message["metadata"]["turnId"]
            .as_str()
            .context("Update Turn missing")?;
        let seq = message["seq"].as_i64().context("Update sequence missing")?;
        let client = format!("update-doorbell-{}", message["id"].as_str().unwrap());
        let mode = if detail.agent.harness == "claude" {
            "hook"
        } else {
            "steer"
        };
        let delivery = json!({"agentId":id,"mode":mode,"clientMessageId":client,"turnId":turn,
            "sessionId":session(&detail),"afterSeq":seq-1,"priority":"urgent",
            "mailbox":{"version":1,"recipientId":id,"priority":"urgent","afterSeq":seq-1,
                "throughSeq":seq,"messageCount":1,"count":1,"remainingCount":0,
                "groups":[{"kind":"system","name":"Yuzuno Core","status":"","count":1}]}});
        let m = message.clone();
        if !self
            .stored(move |store| {
                store.set_update_pause_delivery(&m, "pending", "sending", delivery)
            })
            .await?
        {
            return Ok(());
        }
        // Do not embed a pause directive: cancellation may precede a late hook.
        // Fetch exactly this system control message, not unrelated urgent work.
        let text = format!("[Workspace update control — Yuzuno Core]\nAt the next native opportunity call yuzuno peer_read with priority=\"urgent\", afterSeq={} and limit=1 to read this one system message (sequence {}). This workspace read is authorized. Follow a pause request only if the returned updateWait.active is true. An expired request requires no action. Do not page into other mail for this control reminder. Do not reply just to acknowledge it.",seq-1,seq);
        let result = if mode == "hook" {
            self.claude_notify_mailbox_locked(id, &text, turn, &client)
                .await
        } else {
            self.steer_locked(id, &text, turn, &client).await
        };
        let (state, extra) = match result {
            Ok(value) if mode == "hook" && value["queued"] != false => return Ok(()),
            Ok(_) if mode == "hook" => ("pending", json!({"reason":"native_hook_busy"})),
            Ok(_) => ("delivered", json!({})),
            Err(error) if error.downcast_ref::<crate::rpc::OutcomeUnknown>().is_some() => {
                ("uncertain", json!({"error":error.to_string()}))
            }
            Err(error)
                if error.downcast_ref::<crate::rpc::RpcError>().is_some()
                    || error.downcast_ref::<crate::claude::Rejected>().is_some() =>
            {
                ("error", json!({"error":error.to_string()}))
            }
            Err(error) => ("uncertain", json!({"error":error.to_string()})),
        };
        let m = message.clone();
        self.stored(move |store| store.set_update_pause_delivery(&m, "sending", state, extra))
            .await?;
        self.announce_changed(id);
        Ok(())
    }
}
