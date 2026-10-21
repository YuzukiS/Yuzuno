use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::conversation_time;
use crate::remote::{RemoteMachine, RuntimeRef};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgent {
    /// The machine as it was when the Agent was created, with the data root
    /// its runtime and image copies live in. A copy from before machines had
    /// one reads as the legacy root, where that Agent's runtime still is.
    #[serde(deserialize_with = "agent_machine")]
    pub machine: RemoteMachine,
    pub runtime: Option<RuntimeRef>,
}

impl RemoteAgent {
    /// A new Agent on `machine`, fixed to the data root the machine names now.
    pub fn new(mut machine: RemoteMachine) -> Self {
        machine.data_root = Some(machine.root().to_owned());
        Self { machine, runtime: None }
    }
}

fn agent_machine<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<RemoteMachine, D::Error> {
    let mut machine = RemoteMachine::deserialize(deserializer)?;
    machine.data_root.get_or_insert_with(|| crate::remote::LEGACY_ROOT.to_owned());
    Ok(machine)
}

fn codex() -> String { "codex".into() }

fn disconnected() -> String { "disconnected".into() }

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSettings {
    /// Per-Agent Codex overrides. None inherits the native configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compact_token_limit: Option<u64>,
    pub reasoning_effort: Option<String>,
    pub approval_policy: String,
    pub sandbox: String,
    /// Codex permission preset. Missing keeps legacy per-Agent settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_preset: Option<String>,
    /// Claude Code permission mode the user chose; sessions start and resume
    /// in it. What the live session reports is ClaudeRuntime::permission_mode.
    /// Codex Agents never carry one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
}
impl Default for AgentSettings {
    fn default() -> Self {
        Self { context_window: None, auto_compact_token_limit: None, reasoning_effort: None, approval_policy: "on-request".into(), sandbox: "workspace-write".into(), permission_preset: None, permission_mode: None }
    }
}

pub fn ensure_agent_open(agent: &Agent) -> anyhow::Result<()> {
    anyhow::ensure!(agent.closed_at.is_none(), "Agent 已关闭；请先重新打开，再继续对话");
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub used_tokens: u64,
    pub window_tokens: u64,
    pub used_percent: f64,
    pub turn_id: String,
    pub updated_at: String,
    pub stale: bool,
}

impl ContextUsage {
    /// Usage as reported at `at`, the time of the native event reporting it.
    pub fn measured(used: u64, window: u64, turn_id: &str, at: DateTime<Utc>) -> Option<Self> {
        (window > 0).then(|| Self {
            used_tokens: used, window_tokens: window,
            used_percent: ((used as f64 / window as f64) * 100.0).clamp(0.0, 100.0),
            turn_id: turn_id.into(), updated_at: at.to_rfc3339(), stale: false,
        })
    }
}

/// Facts the native Claude runtime reported, kept for display. Account
/// labels come from initialization; no credential or key source is stored.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRuntime {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// What this session's bridge started with, as it reported it: the CLI's
    /// path, how it was found and its version; the Agent SDK's version and
    /// the CLI it ships; and how the two stand. Replaced on every start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Value>,
    /// Main model as named by system/init, which keys result.modelUsage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Mode the live session reports. It may differ from the user's choice
    /// in AgentSettings (e.g. accept edits granted for this session only) and
    /// is never used to start or resume a session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Latest native rate_limit_info, verbatim, and when it arrived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limits_at: Option<String>,
    /// The reasoning effort Claude reported for a turn, after its own
    /// downgrades: `{level, turnId}`. Not the choice in AgentSettings; a model
    /// that takes no effort reports none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionSource { pub turn_id: String, pub item_id: String }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClarificationAnswer {
    pub result_id: String,
    pub form_id: String,
    pub answers: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageInput {
    pub client_message_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_blocks: Option<Vec<crate::message_content::TextBlock>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    #[serde(default)]
    pub expected_turn_id: Option<String>,
    #[serde(default)]
    pub question: Option<QuestionSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clarification: Option<ClarificationAnswer>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageReceipt {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<crate::message_content::MessageBinding>,
    pub input: MessageInput,
    pub status: String,
    pub turn_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_parts: Option<Vec<Value>>,
    pub text: String,
    pub kind: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub goal: String,
    // Derived only for API responses; never deserialize a stale projection.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub work_summary: Option<WorkSummary>,
    /// Projected from `project_agents` for API responses. Older builds rewrite
    /// Agent JSON, so membership never lives in the record itself.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub cwd: String,
    pub model: String,
    #[serde(default)]
    pub settings: AgentSettings,
    pub color: String,
    #[serde(default = "codex")]
    pub harness: String,
    #[serde(default)]
    pub claude_session_id: Option<String>,
    /// The OpenCode session (`ses_…`) in this Agent's own OpenCode database.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_session_id: Option<String>,
    pub thread_id: Option<String>,
    pub status: String,
    #[serde(default)]
    pub closed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub unread_count: u64,
    pub pending_count: u64,
    pub last_message: Option<String>,
    /// Journal position of the last event in this record, for read receipts
    /// and unread counts. Durable; streamed output (no journal row) leaves it.
    pub last_seq: i64,
    pub reviewed_seq: i64,
    /// This record already contains change `rev` (see store::Store::rev):
    /// every change to any Agent, streamed output included, takes the next
    /// value of one counter in this Core process. Unlike `last_seq` it means
    /// nothing across restarts and is never read back from disk.
    #[serde(default, skip_deserializing)]
    pub rev: u64,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<RemoteAgent>,
    #[serde(default = "disconnected")]
    pub connection_state: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub id: String,
    pub agent_id: String,
    pub method: String,
    pub params: Value,
    pub created_at: String,
    #[serde(default)]
    pub stale: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub source_item_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryWindow {
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub loaded_count: usize,
}

/// One side of an explicit official Codex fork between two Workspace Agents.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForkLink {
    pub agent_id: String,
    pub thread_id: String,
    /// Last source Turn the fork includes.
    pub through_turn_id: String,
    pub turn_count: usize,
    pub at: String,
}

/// Local Codex ownership facts. Another client's writer can refuse a resume;
/// Yuzuno then only offers an explicit fork and never takes the session over.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHandoff {
    /// When Codex last refused to resume because another client writes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writer_conflict_at: Option<String>,
    /// The Agent that continues this session from a fork.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_to: Option<ForkLink>,
    /// The Agent and session this fork was created from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from: Option<ForkLink>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentDetail {
    pub agent: Agent,
    pub turns: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<HistoryWindow>,
    pub pending: Vec<PendingRequest>,
    pub artifacts: Vec<Artifact>,
    #[serde(default, rename = "contextUsage")]
    pub context_usage: Option<ContextUsage>,
    #[serde(default, rename = "messageReceipts")]
    pub message_receipts: Vec<MessageReceipt>,
    #[serde(default, rename = "claudeRuntime", skip_serializing_if = "Option::is_none")]
    pub claude_runtime: Option<ClaudeRuntime>,
    #[serde(default, rename = "codexHandoff", skip_serializing_if = "Option::is_none")]
    pub codex_handoff: Option<CodexHandoff>,
}

impl AgentDetail {
    pub fn turn_mut(&mut self, id: &str) -> &mut Value {
        self.turn_at(id, Utc::now())
    }

    /// The Turn with this ID. One seen first here is recorded as in progress,
    /// started locally at `at`.
    pub fn turn_at(&mut self, id: &str, at: DateTime<Utc>) -> &mut Value {
        let index = self
            .turns
            .iter()
            .position(|t| t["id"] == id)
            .unwrap_or_else(|| {
                self.turns
                    .push(json!({"id":id,"status":"inProgress","items":[],
                        "_yuzunoStartedAt":at.timestamp_millis()}));
                self.turns.len() - 1
            });
        &mut self.turns[index]
    }

    pub fn apply(&mut self, method: &str, p: &Value) {
        self.apply_at(method, p, Utc::now());
    }

    /// The native events `apply_at` changes a record for. Every other kind
    /// only refreshes `updatedAt` and re-derives status, which a normalized
    /// record already has; store::route never applies those. Keep this list
    /// in step with the arms of `apply_at` below.
    pub fn acts_on(method: &str) -> bool {
        matches!(method, "thread/tokenUsage/updated" | "thread/compacted" | "turn/started" | "turn/completed"
            | "item/started" | "item/completed" | "turn/plan/updated"
            | "item/reasoning/summaryPartAdded" | "item/reasoning/summaryTextDelta"
            | "item/agentMessage/delta" | "item/plan/delta" | "item/commandExecution/outputDelta"
            | "serverRequest/resolved" | "error" | "thread/status/changed")
    }

    /// Applies a native event as of `at`, the time it was journaled. Nothing
    /// here reads the clock, so replaying the journal (see store::restore)
    /// rebuilds exactly the record the live event produced.
    pub fn apply_at(&mut self, method: &str, p: &Value, at: DateTime<Utc>) {
        let turn_id = p["turnId"].as_str().or_else(|| p["turn"]["id"].as_str());
        match method {
            "thread/tokenUsage/updated" => {
                // last is the most recent model request; total is cumulative
                // consumption and must never be used as context occupancy.
                self.context_usage = p["tokenUsage"]["last"]["totalTokens"].as_u64()
                    .zip(p["tokenUsage"]["modelContextWindow"].as_u64())
                    .and_then(|(used, window)| ContextUsage::measured(used, window, turn_id.unwrap_or_default(), at));
            }
            "thread/compacted" => {
                if let Some(usage) = &mut self.context_usage { usage.stale = true; }
                for turn in &mut self.turns {
                    if turn_id.is_none_or(|id| turn["id"] == id) {
                        turn.as_object_mut().unwrap().remove("_yuzunoCompactionId");
                        turn.as_object_mut().unwrap().remove("_yuzunoCompactionStartedAt");
                    }
                }
            }
            "turn/started" | "turn/completed" => {
                if let Some(id) = turn_id {
                    let incoming = &p["turn"];
                    let existing = self.turn_at(id, at);
                    // The RPC response can be scheduled after completion events.
                    // A terminal turn must never become inProgress again.
                    if method == "turn/started"
                        && existing["status"]
                            .as_str()
                            .is_some_and(|s| ["completed", "failed", "interrupted"].contains(&s))
                    {
                        return;
                    }
                    // Native completion payloads can contain only the final
                    // message. Merge by ID so earlier input and tool evidence
                    // survive partial snapshots, while final item bodies win.
                    if let Some(items) = incoming["items"].as_array() {
                        let saved = existing["items"].as_array_mut().unwrap();
                        for item in items {
                            if let Some(old) = saved.iter_mut().find(|i| i["id"] == item["id"]) {
                                conversation_time::replace_item(old, item);
                            } else {
                                saved.push(item.clone());
                            }
                        }
                    }
                    existing["status"] = incoming["status"].clone();
                    existing["error"] = incoming["error"].clone();
                    // Native timestamps are seconds. Retain them through partial
                    // lifecycle payloads; the local fallback is recorded only once.
                    conversation_time::merge_native_turn_times(existing, incoming);
                    if method == "turn/completed" {
                        existing.as_object_mut().unwrap().remove("_yuzunoCompactionId");
                        existing.as_object_mut().unwrap().remove("_yuzunoCompactionStartedAt");
                        conversation_time::mark_turn_completed(existing, at.timestamp_millis());
                    }
                    self.agent.status = if method == "turn/started" {
                        "working"
                    } else if incoming["status"] == "failed" {
                        "error"
                    } else {
                        "idle"
                    }
                    .into();
                    if method == "turn/completed" {
                        // Async questions may outlive their originating Turn.
                        // Only the harness's resolved event dismisses them.
                        self.pending.retain(|r| {
                            r.params["turnId"].as_str() != Some(id)
                                || (r.method == "item/tool/requestUserInput"
                                    && r.params["isBlocking"] == false)
                        });
                        self.agent.error = incoming["error"]["message"].as_str().map(str::to_owned);
                    } else {
                        self.agent.error = None;
                    }
                }
            }
            "item/started" | "item/completed" => {
                if let Some(tid) = turn_id {
                    let mut item = p["item"].clone();
                    if item["type"] == "contextCompaction" {
                        if let Some(usage) = &mut self.context_usage { usage.stale = true; }
                        // Native compaction Items have no status. Preserve the
                        // event phase separately without changing their body.
                        let turn = self.turn_at(tid, at);
                        if method == "item/started" && turn["status"] == "inProgress" {
                            if turn["_yuzunoCompactionId"] != item["id"] {
                                turn["_yuzunoCompactionStartedAt"] = at.timestamp_millis().into();
                            }
                            turn["_yuzunoCompactionId"] = item["id"].clone();
                        } else if turn["_yuzunoCompactionId"] == item["id"] {
                            turn.as_object_mut().unwrap().remove("_yuzunoCompactionId");
                            turn.as_object_mut().unwrap().remove("_yuzunoCompactionStartedAt");
                        }
                    }
                    if method == "item/completed" && item["type"] == "agentMessage" {
                        item["_yuzunoCompletedText"] = item["text"].clone();
                    }
                    let items = self.turn_at(tid, at)["items"].as_array_mut().unwrap();
                    let index = match items.iter().position(|x| x["id"] == item["id"]) {
                        Some(index) => {
                            conversation_time::replace_item(&mut items[index], &item);
                            index
                        }
                        None => {
                            items.push(item.clone());
                            items.len() - 1
                        }
                    };
                    // Prefer the Harness's own item time; otherwise the time
                    // this event was journaled, so a journal replay agrees.
                    let native = p[if method == "item/started" { "startedAtMs" } else { "completedAtMs" }]
                        .as_i64().filter(|t| *t > 0);
                    conversation_time::stamp_message(
                        &mut items[index],
                        native.or(Some(at.timestamp_millis())),
                        if native.is_some() { "codex" } else { "core" },
                    );
                    if item["type"] == "agentMessage" {
                        self.agent.last_message = item["text"].as_str().map(str::to_owned);
                    }
                    if item["type"] == "fileChange" {
                        for change in item["changes"].as_array().into_iter().flatten() {
                            if let Some(path) = change["path"].as_str() {
                                self.add_artifact(path, item["id"].as_str());
                            }
                        }
                    }
                }
            }
            "turn/plan/updated" => {
                if let Some(tid) = turn_id {
                    self.turn_at(tid, at)["_yuzunoPlan"] = p["plan"].clone();
                }
            }
            "item/reasoning/summaryPartAdded" | "item/reasoning/summaryTextDelta" => {
                if let (Some(tid), Some(item_id), Some(index)) = (
                    turn_id,
                    p["itemId"].as_str(),
                    p["summaryIndex"].as_u64().and_then(|n| usize::try_from(n).ok()),
                ) {
                    let items = self.turn_at(tid, at)["items"].as_array_mut().unwrap();
                    let idx = items.iter().position(|i| i["id"] == item_id).unwrap_or_else(|| {
                        items.push(json!({"id":item_id,"type":"reasoning","summary":[],"content":[]}));
                        items.len() - 1
                    });
                    let item = &mut items[idx];
                    if item["type"] == "reasoning" {
                        if !item["summary"].is_array() { item["summary"] = json!([]); }
                        let summary = item["summary"].as_array_mut().unwrap();
                        // A reconnect may start with a later section. Repeated
                        // part boundaries must not erase text already received.
                        while summary.len() <= index { summary.push(json!("")); }
                        if method == "item/reasoning/summaryTextDelta" {
                            let mut text = summary[index].as_str().unwrap_or_default().to_owned();
                            text.push_str(p["delta"].as_str().unwrap_or_default());
                            summary[index] = text.into();
                        }
                    }
                }
            }
            "item/agentMessage/delta" | "item/plan/delta" | "item/commandExecution/outputDelta" => {
                if let Some(tid) = turn_id {
                    let key = if method.contains("commandExecution") {
                        "aggregatedOutput"
                    } else {
                        "text"
                    };
                    let typ = if method.contains("commandExecution") {
                        "commandExecution"
                    } else if method.contains("plan") {
                        "plan"
                    } else {
                        "agentMessage"
                    };
                    let items = self.turn_at(tid, at)["items"].as_array_mut().unwrap();
                    let idx = items
                        .iter()
                        .position(|i| i["id"] == p["itemId"])
                        .unwrap_or_else(|| {
                            items.push(json!({"id":p["itemId"],"type":typ,key:""}));
                            items.len() - 1
                        });
                    let mut value = items[idx][key].as_str().unwrap_or_default().to_owned();
                    value.push_str(p["delta"].as_str().unwrap_or_default());
                    items[idx][key] = value.into();
                }
            }
            "serverRequest/resolved" => resolve_request(&mut self.pending, p),
            "error" => {
                self.agent.error = p["error"]["message"]
                    .as_str()
                    .or_else(|| p["message"].as_str())
                    .map(str::to_owned);
                if !p["willRetry"].as_bool().unwrap_or(false) {
                    self.agent.status = "error".into();
                }
            }
            "thread/status/changed" => thread_status_changed(&mut self.agent, p),
            _ => {}
        }
        self.agent.pending_count = self.pending.len() as u64;
        let turns = &self.turns;
        settle_status(&mut self.agent, &self.pending, || turns.iter().any(|t| t["status"] == "inProgress"));
        self.agent.updated_at = at.to_rfc3339();
        self.confirm_message_receipts();
    }

    pub fn confirm_message_receipts(&mut self) {
        crate::message_content::bind(&mut self.turns, &mut self.message_receipts);
        for receipt in &mut self.message_receipts {
            if receipt.status == "accepted" || receipt.status == "rejected" { continue; }
            for turn in &self.turns {
                if turn["items"].as_array().is_some_and(|items| items.iter().any(|item|
                    // Native item IDs are generated independently. clientId
                    // echoes turn/start or turn/steer's clientUserMessageId.
                    item["type"] == "userMessage" && item["clientId"].as_str() == Some(&receipt.input.client_message_id))) {
                    receipt.status = "accepted".into();
                    receipt.turn_id = turn["id"].as_str().map(str::to_owned);
                    receipt.error = None;
                    break;
                }
            }
        }
    }

    pub fn refresh_snapshot_evidence(&mut self) {
        let items: Vec<Value> = self.turns.iter().flat_map(|t|
            t["items"].as_array().into_iter().flatten().cloned()).collect();
        for item in items {
            if item["type"] == "agentMessage" {
                self.agent.last_message = item["text"].as_str().map(str::to_owned);
            }
            if item["type"] == "fileChange" {
                for change in item["changes"].as_array().into_iter().flatten() {
                    if let Some(path) = change["path"].as_str() {
                        self.add_artifact(path, item["id"].as_str());
                    }
                }
            }
        }
    }

    pub(crate) fn add_artifact(&mut self, path: &str, item: Option<&str>) {
        if self.artifacts.iter().any(|a| a.path == path) {
            return;
        }
        let name = std::path::Path::new(path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let extension = std::path::Path::new(path)
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let kind = if ["png", "jpg", "jpeg", "webp", "gif"].contains(&extension.as_str()) {
            "image"
        } else {
            "text"
        };
        self.artifacts.push(Artifact {
            path: path.into(),
            name,
            kind: kind.into(),
            source_item_id: item.map(str::to_owned),
        });
    }
}

/// `serverRequest/resolved`: the request it names is no longer pending.
/// Resolution names its request and, since 0.162, the thread it was asked
/// on: a sub-agent's resolution never clears another thread's request.
pub(crate) fn resolve_request(pending: &mut Vec<PendingRequest>, p: &Value) {
    let wire_id = &p["requestId"];
    pending.retain(|r| r.params.get("_rpcId") != Some(wire_id)
        || (p.get("_runtimeGeneration").is_some()
            && r.params.get("_runtimeGeneration") != p.get("_runtimeGeneration"))
        || (p["threadId"].is_string()
            && r.params["threadId"].is_string()
            && r.params["threadId"] != p["threadId"]));
}

/// `thread/status/changed`: of its statuses only a system error changes the
/// Agent.
pub(crate) fn thread_status_changed(agent: &mut Agent, p: &Value) {
    if p["status"]["type"] == "systemError" {
        agent.status = "error".into();
    }
}

/// The status every applied event leaves: waiting while a request blocks,
/// unless offline or uncertain; out of waiting, working while a Turn is in
/// progress (`running`, asked only then), else idle.
pub(crate) fn settle_status(agent: &mut Agent, pending: &[PendingRequest], running: impl FnOnce() -> bool) {
    if pending.iter().any(|r| {
        !r.stale
            && (r.method != "item/tool/requestUserInput" || r.params["isBlocking"] != false)
    }) && !["offline", "uncertain"].contains(&agent.status.as_str())
    {
        agent.status = "waiting".into();
    } else if agent.status == "waiting" {
        agent.status = if running() { "working" } else { "idle" }.into();
    }
}
