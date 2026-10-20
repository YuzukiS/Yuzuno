//! Credential readiness is separate from native execution state. A failed MCP
//! reconnect must not prevent reading, approving, interrupting or closing a Turn.
use crate::{rpc::{OutcomeUnknown, Rpc, RpcError}, workspace::Workspace};
use anyhow::{bail, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

/// Only returned before a new message receipt or native submission exists.
#[derive(Debug)]
pub(crate) struct MessageNotSubmitted(pub anyhow::Error);
impl std::fmt::Display for MessageNotSubmitted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { self.0.fmt(f) }
}
impl std::error::Error for MessageNotSubmitted {}

#[derive(Clone)]
pub(crate) struct Readiness {
    generation: u64,
    epoch: String,
    status: CollaborationStatus,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationStatus {
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

fn unconfirmed(reason: &'static str, detail: &str) -> CollaborationStatus {
    CollaborationStatus {
        ready: false,
        reason: Some(reason),
        error: Some(format!("Workspace 协作连接未确认：{detail}。新消息尚未发送；原任务与审批仍可核对或停止。请点击重连并核对；若原任务结束后仍失败，可手动关闭再重新打开此 Agent 以恢复同一会话。")),
    }
}

fn probe_status(result: Result<Value>, workspace: &str, agent: &str, epoch: &str) -> CollaborationStatus {
    match result {
        Ok(result) if result["isError"] != true
            && result["structuredContent"]["peers"].is_array()
            && result["structuredContent"]["yuzuno"]["workspaceId"] == workspace
            && result["structuredContent"]["yuzuno"]["agentId"] == agent
            && result["structuredContent"]["yuzuno"]["credentialEpoch"] == epoch => {
                CollaborationStatus { ready: true, error: None, reason: None }
            }
        Ok(result) if result["isError"] == true => {
            if result.to_string().contains("401") {
                unconfirmed("unauthorized", "原生 MCP 调用返回 HTTP 401，旧运行时可能仍使用轮换前的凭证")
            } else {
                unconfirmed("toolError", "原生 MCP peers_list 调用失败")
            }
        }
        Ok(_) => unconfirmed("invalidResult", "原生 MCP 回应未证明当前 Workspace、Agent 与凭证轮换版本"),
        Err(error) if error.downcast_ref::<OutcomeUnknown>().is_some() => unconfirmed("timeout", "只读 MCP 检查超时或连接中断"),
        Err(error) if error.downcast_ref::<RpcError>().is_some_and(|e| e.code == -32601) => unconfirmed("unsupported", "当前 Codex 版本不支持只读 MCP 连接检查"),
        Err(error) if error.to_string().contains("401") => unconfirmed("unauthorized", "原生 MCP 调用返回 HTTP 401，旧运行时可能仍使用轮换前的凭证"),
        Err(_) => unconfirmed("nativeError", "原生运行时拒绝了只读 MCP 连接检查"),
    }
}

impl Workspace {
    pub async fn collaboration_status(&self, id: &str) -> Option<CollaborationStatus> {
        self.collaboration_url.get()?;
        let state = self.collaboration_attached.lock().await.get(id).cloned();
        match state {
            Some(state) if Some(state.generation) == self.collaboration_generation(id)
                && state.epoch == self.collaboration_epoch => Some(state.status),
            // Before native attach, the ordinary connection UI owns recovery.
            _ => None,
        }
    }

    pub(crate) async fn require_collaboration(&self, id: &str) -> Result<()> {
        if self.collaboration_url.get().is_none() { return Ok(()); }
        match self.collaboration_status(id).await {
            Some(status) if status.ready => Ok(()),
            status => bail!("{}", status.and_then(|s| s.error)
                .unwrap_or_else(|| "Workspace 协作连接尚未确认；请先重连并核对，新消息未发送".into())),
        }
    }

    async fn record_collaboration_status(&self, id: &str, generation: u64, status: CollaborationStatus) {
        let _owned = self.owner(id).await;
        // The probe may finish after disconnect/reconnect. Never publish its
        // result to a replacement transport or another Workspace token epoch.
        if self.collaboration_generation(id) != Some(generation) { return; }
        self.collaboration_attached.lock().await.insert(id.into(), Readiness {
            generation, epoch: self.collaboration_epoch.clone(), status,
        });
        // agent.changed invalidates detail even with the same record revision.
        // Readiness is live transport state, not a journal/unread event.
        self.changed(id);
    }

    /// A runtime that reports its own MCP connection (OpenCode) reported it
    /// not connected: not ready, saying what it reported.
    pub(crate) async fn collaboration_refused(&self, id: &str, generation: u64, native: &Value) {
        if self.collaboration_url.get().is_some() {
            let status = native["status"].as_str().unwrap_or("unknown");
            let detail = match native["error"].as_str() {
                Some(error) => format!("OpenCode 报告 MCP 状态 {status}：{error}"),
                None => format!("OpenCode 报告 MCP 状态 {status}"),
            };
            self.record_collaboration_status(id, generation, unconfirmed("notConnected", &detail)).await;
        }
    }

    pub(crate) async fn collaboration_started(&self, id: &str, generation: u64) {
        if self.collaboration_url.get().is_some() {
            self.record_collaboration_status(id, generation,
                CollaborationStatus { ready: true, error: None, reason: None }).await;
        }
    }

    pub(crate) async fn verify_remote_collaboration(&self, id: &str, thread: &str, generation: u64, rpc: &Rpc) {
        if self.collaboration_url.get().is_none() { return; }
        let workspace = self.stored(|store| store.workspace_id()).await;
        let status = match workspace {
            Ok(workspace) => {
                // A host RPC to an existing read-only tool; no model request,
                // prompt, mail-read receipt or replay of previous work.
                let result = rpc.request_within("mcpServer/tool/call", json!({
                    "threadId": thread, "server": "yuzuno", "tool": "peers_list", "arguments": {},
                }), Duration::from_secs(8)).await;
                probe_status(result, &workspace, id, &self.collaboration_epoch)
            }
            Err(_) => unconfirmed("workspaceError", "无法读取 Workspace 身份"),
        };
        self.record_collaboration_status(id, generation, status).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_requires_tool_success_and_current_workspace_agent_epoch() {
        let good = json!({"structuredContent":{"peers":[],"yuzuno":{
            "workspaceId":"w", "agentId":"a", "credentialEpoch":"new"}}});
        assert!(probe_status(Ok(good.clone()), "w", "a", "new").ready);
        for result in [json!({}), json!({"isError":true,"structuredContent":good["structuredContent"]}),
            json!({"structuredContent":{"peers":[]}})] {
            assert!(!probe_status(Ok(result), "w", "a", "new").ready);
        }
        for (workspace, agent, epoch) in [("other", "a", "new"), ("w", "other", "new"), ("w", "a", "old")] {
            assert!(!probe_status(Ok(good.clone()), workspace, agent, epoch).ready);
        }
        assert_eq!(probe_status(Err(OutcomeUnknown("timeout".into()).into()), "w", "a", "new").reason, Some("timeout"));
        assert_eq!(probe_status(Ok(json!({"isError":true,"content":[{"text":"HTTP 401"}]})), "w", "a", "new").reason, Some("unauthorized"));
    }
}
