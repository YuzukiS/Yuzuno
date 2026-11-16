//! Importing an OpenCode 2.x session as a new Agent (T-61 slice 8, D-38
//! I-A). The user runs `opencode session export` and uploads the file; Core
//! never reads the user's own OpenCode database or runs its CLI, which would
//! attach to the user's own service.
//!
//! The file is checked whole (`classify`) and kept in Core's own folder
//! (0600) while it waits to be confirmed, its preview answered. On confirm,
//! a new Agent's OpenCode is started once on its own empty database in the
//! chosen folder, the session is written there through 2.x's import under a
//! new session ID Core chooses with a marker naming the request
//! (`opencode_transfer::write_once`), read back whole (`read_copy`), and only
//! then is the Agent registered, its Turns built from the session's own
//! messages by the code that reads a session live (`imported_turns`), and
//! attached to that same process.
//!
//! The same file again is the Agent it made, while that Agent exists; the
//! same session exported again after more work is a new copy, and its
//! preview names the earlier one (D-42 (a)). An import whose answer was lost
//! goes on with the same request and never writes twice, as a fork does.
//! The new Agent has no login of the file's (none is in it), starts on
//! OpenCode's default model (a model is chosen in its settings, as for any
//! new OpenCode Agent), and its imported Turns cannot be rewound: their
//! snapshots are in the store of the OpenCode that made them.
use super::*;
use crate::opencode_transfer::{self as transfer, Payload, Written};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;

/// At most this much of a file is taken (D-42).
pub(crate) const CAP: usize = 64 << 20;
/// How long the import is waited for before the attempt is left uncertain.
const WATCH: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 120 });
/// An upload never confirmed is removed, with its file, after this long.
const KEPT: chrono::Duration = chrono::Duration::hours(24);
/// States an import holds its file in: one live import per file.
const LIVE: &str = "('sending','uncertain','forked','verified','completed')";

const NOT_EXPORT: &str = "这个文件不是 OpenCode 2.x 导出的会话（应为 `opencode session export` 写出的 {info, messages}）；没有导入";
const ONE_X: &str = "这个文件来自 OpenCode 1.x；请用 OpenCode 2.x 导出：`opencode session export`；没有导入";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    request_id: String,
    name: String,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Which {
    request_id: String,
}

/// One import as kept.
#[derive(Clone, Debug)]
struct Row {
    request_id: String,
    source_session: String,
    digest: String,
    target_agent_id: String,
    name: Option<String>,
    cwd: Option<String>,
    state: String,
    error: Option<String>,
}

/// What a confirmed import fixed before it wrote: the copy, and the project
/// the new Agent's OpenCode holds its folder for.
#[derive(serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixed {
    payload: Payload,
    project: String,
    source_session: String,
    /// The new Agent's model (`provider/model`, empty for OpenCode's
    /// default) and variant, as `kept_model` says, and its notice if any.
    model: String,
    variant: Option<String>,
    notice: Option<String>,
}

/// A file read whole, and what it is (`classify`).
pub(crate) struct Classified {
    pub info: Value,
    pub messages: Vec<Value>,
}

/// The file's whole as one value, refused unless it is an export of a 2.x
/// session Core can import as it is (I4):
/// - `{info, messages}`, of 2.x's shape, not 1.x's (D-41 (a));
/// - not sanitized (`--sanitize` replaces its content);
/// - not a child session, and holding no revert;
/// - every message of a type 2.x keeps, settled, none moving the session to
///   another folder; at least one; and its last run ended.
pub(crate) fn classify(file: &Value) -> Result<Classified> {
    let info = file.get("info").filter(|i| i.is_object()).context(NOT_EXPORT)?;
    let messages = file.get("messages").and_then(Value::as_array).context(NOT_EXPORT)?;
    ensure!(info.get("directory").is_none() && !messages.iter().any(|m| m.get("info").is_some() && m.get("parts").is_some()), ONE_X);
    ensure!(info["id"].as_str().is_some_and(|id| id.starts_with("ses")), NOT_EXPORT);
    ensure!(!messages.is_empty(), "这个会话没有消息，没有可以导入的内容；没有导入");
    ensure!(!sanitized(file), "这个文件是用 --sanitize 导出的，它的内容已被替换；请不带 --sanitize 重新导出；没有导入");
    ensure!(info["parentID"].is_null(), "这是另一个会话的子会话；请导入它的父会话；没有导入");
    ensure!(info["revert"].is_null(), "这个会话里有一次尚未处理的回退；请先在 OpenCode 里处理它再导出；没有导入");
    for message in messages {
        let id = message["id"].as_str().filter(|id| id.starts_with("msg")).context(NOT_EXPORT)?;
        let kind = message["type"].as_str().unwrap_or_default();
        ensure!(transfer::KNOWN_TYPES.contains(&kind), "消息 {id} 的类型 {kind} 不认识，可能来自更新的 OpenCode；没有导入");
        ensure!(kind != "location-switched", "这个会话换过目录；没有导入");
        ensure!(transfer::settled(message), "消息 {id} 还没有结束（文件可能被改过）；没有导入");
    }
    let read = crate::opencode_v2::read_messages(&Value::Array(messages.clone()));
    ensure!(read.open.is_none() && read.steps.is_empty() && read.compaction.is_none() && read.shells.is_empty(),
        "这个会话的最后一轮还没有结束；请等它结束后重新导出；没有导入");
    Ok(Classified { info: info.clone(), messages: messages.clone() })
}

/// Whether `--sanitize` wrote this file: every string it hid reads
/// `[redacted:…]`, and metadata it hid is `{redacted}` (2.2.5
/// core/src/session/transfer.ts `sanitize`).
fn sanitized(value: &Value) -> bool {
    match value {
        Value::String(text) => text.starts_with("[redacted:") || text.starts_with("/[redacted:"),
        Value::Array(items) => items.iter().any(sanitized),
        Value::Object(object) => (object.len() == 1 && object.contains_key("redacted")) || object.values().any(sanitized),
        _ => false,
    }
}

/// The file's digest: the same session, however its keys are ordered or
/// spaced, is the same file (I6).
pub(crate) fn digest(file: &Value) -> String {
    fn canonical(value: &Value, out: &mut Vec<u8>) {
        match value {
            Value::Object(object) => {
                let mut keys: Vec<&String> = object.keys().collect();
                keys.sort();
                out.push(b'{');
                for (index, key) in keys.into_iter().enumerate() {
                    if index > 0 {
                        out.push(b',');
                    }
                    out.extend(serde_json::to_vec(key).unwrap_or_default());
                    out.push(b':');
                    canonical(&object[key], out);
                }
                out.push(b'}');
            }
            Value::Array(items) => {
                out.push(b'[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(b',');
                    }
                    canonical(item, out);
                }
                out.push(b']');
            }
            other => out.extend(serde_json::to_vec(other).unwrap_or_default()),
        }
    }
    use sha2::{Digest, Sha256};
    let mut bytes = Vec::new();
    canonical(file, &mut bytes);
    Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The model a session ran with at its end: its own, else its last switch's,
/// else its last answer's; `Null` if it names none.
fn file_model(info: &Value, messages: &[Value]) -> Value {
    Some(&info["model"]).filter(|m| m.is_object()).cloned()
        .or_else(|| messages.iter().rev().find(|m| m["type"] == "model-switched").map(|m| m["model"].clone()))
        .or_else(|| messages.iter().rev().find(|m| m["type"] == "assistant").map(|m| m["model"].clone()))
        .unwrap_or(Value::Null)
}

/// `file_model` as `provider/model`, as the preview shows it.
fn model_of(info: &Value, messages: &[Value]) -> Option<String> {
    let model = file_model(info, messages);
    Some(format!("{}/{}", model["providerID"].as_str()?, model["id"].as_str()?))
}

/// The file's model, kept for the new Agent when its OpenCode lists it, as
/// Fork keeps the source's: the session's model in the copy, the Agent's
/// model, and its variant if that model lists it. Otherwise OpenCode's
/// default, with a notice: (the copy's model or `Null`, the Agent's model,
/// its variant, the notice).
fn kept_model(model: &Value, listed: &[crate::opencode::ModelChoice]) -> (Value, String, Option<String>, Option<String>) {
    let (Some(provider), Some(id)) = (model["providerID"].as_str(), model["id"].as_str()) else { return (Value::Null, String::new(), None, None) };
    let Some(found) = listed.iter().find(|m| m.provider == provider && m.model == id) else {
        let notice = format!("文件用的模型 {provider}/{id} 不在这台机器的 OpenCode 里；新 Agent 用 OpenCode 的默认模型，可以在设置里另选");
        return (Value::Null, String::new(), None, Some(notice));
    };
    let named = model["variant"].as_str().filter(|v| !v.is_empty() && *v != "default");
    let variant = named.filter(|v| found.variants.iter().any(|x| x == v)).map(str::to_owned);
    let notice = named.filter(|_| variant.is_none())
        .map(|v| format!("文件用的变体 {v} 不在这台机器的 OpenCode 为 {provider}/{id} 列出的变体里；新 Agent 用这个模型自己的"));
    let mut kept = json!({"providerID": provider, "id": id});
    if let Some(variant) = &variant {
        kept["variant"] = json!(variant);
    }
    (kept, found.id(), variant, notice)
}

/// The file's agent, kept only if the new Agent's OpenCode lists it as a
/// primary agent one can choose (D-39 (a)); none if the file names none.
/// Another is refused: left out, the session would run as the default agent,
/// which may do more than the one it ran as.
fn kept_agent(agent: &Value, listed: &[(String, String, bool)]) -> Result<Option<String>> {
    let Some(agent) = agent.as_str() else { return Ok(None) };
    match listed.iter().find(|(id, _, _)| id == agent) {
        Some((_, mode, hidden)) if !hidden && matches!(mode.as_str(), "primary" | "all") => Ok(Some(agent.to_owned())),
        _ => bail!("这个会话用的 agent「{agent}」不是这台机器的 OpenCode 里可以选的主 agent；没有导入"),
    }
}

/// The session as it is written into the new Agent's OpenCode: its own
/// messages and usage (D-34, import keeps them), under a new ID with this
/// request's marker, titled as the Agent, in the chosen folder; without the
/// file's permissions or metadata (D-40 (a)), and its agent and model as
/// `kept_agent` and `kept_model` say.
fn import_payload(file: &Classified, request: &str, name: &str, cwd: &str, project: &str, agent: Option<String>, model: Value) -> Payload {
    let info = &file.info;
    let created = &info["time"]["created"];
    let mut sent = json!({
        "id": transfer::session_id(), "projectID": project, "title": name, "location": {"directory": cwd},
        "metadata": {"yuzuno": {"import": request}},
        "cost": if info["cost"].is_number() { info["cost"].clone() } else { json!(0) },
        "tokens": if info["tokens"].is_object() { info["tokens"].clone() } else { transfer::no_tokens() },
        "time": {"created": created, "updated": if info["time"]["updated"].is_number() { &info["time"]["updated"] } else { created },
            "idle": info["time"]["idle"], "archived": info["time"]["archived"]},
        "outcome": info["outcome"], "agent": agent, "model": model,
    });
    transfer::without_nulls(&mut sent);
    Payload { info: sent, messages: file.messages.clone(), directory: cwd.to_owned() }
}

/// The Turns of an imported session (I5): each user prompt as Core would
/// have recorded it had it sent it and watched it, by the very code that
/// reads a session live: its answers, tools and shells attached, and ended
/// at its idle as that idle says; a compaction asked for (`manual`) as a
/// `/compact` Turn. Each is marked `_yuzunoImported` (`mark`), which Rewind
/// refuses. Refused if a prompt's run is left going.
pub(super) fn imported_turns(messages: &[Value], mark: &Value) -> Result<Vec<Value>> {
    let read = crate::opencode_v2::read_messages(&Value::Array(messages.to_vec()));
    let entries: HashMap<String, Value> = read.messages.iter()
        .filter_map(|e| Some((e["info"]["id"].as_str()?.to_owned(), e.clone()))).collect();
    let mut ended = read.ended.into_iter();
    let mut d: AgentDetail = serde_json::from_value(json!({"agent": {
        "id": "import", "name": "import", "cwd": "", "model": "", "color": "sage", "harness": "opencode", "threadId": null,
        "status": "idle", "createdAt": "", "updatedAt": "", "unreadCount": 0, "pendingCount": 0, "lastSeq": 0, "reviewedSeq": 0
    }, "turns": [], "pending": [], "artifacts": []}))?;
    // A user's or synthetic message since the last idle: the idle that follows ends its run.
    let mut waiting = false;
    for message in messages {
        let id = message["id"].as_str().context("OpenCode 的消息没有 ID")?;
        let created = message["time"]["created"].as_i64();
        match message["type"].as_str() {
            Some("user") => {
                let text = message["text"].as_str().unwrap_or_default();
                let mut turn = json!({"id": id, "status": "inProgress", "_yuzunoStartedAt": created,
                    "items": [{"id": format!("{id}:input"), "type": "userMessage", "content": [{"type": "text", "text": text}], "nativeMessageId": id}]});
                crate::conversation_time::stamp_message(&mut turn["items"][0], created, "core");
                d.turns.push(turn);
            }
            Some("compaction") if message["reason"] == "manual" => {
                let failed = message["status"] == "failed";
                let turn = format!("compact_{id}");
                let mut entry = json!({"id": turn, "status": if failed { "failed" } else { "completed" }, "_yuzunoStartedAt": created,
                    "items": [{"id": format!("{turn}:compaction"), "type": "contextCompaction", "trigger": "manual", "text": message["summary"]}],
                    "_opencodeCompact": {"state": if failed { "failed" } else { "completed" }, "input": id}});
                if failed {
                    entry["error"] = json!({"message": message["error"]["message"]});
                }
                d.turns.push(entry);
            }
            _ => {}
        }
        if let Some(entry) = entries.get(id) {
            super::message(&mut d, &entry["info"]);
            for part in entry["parts"].as_array().into_iter().flatten() {
                super::part(&mut d, part);
            }
        }
        if matches!(message["type"].as_str(), Some("user" | "synthetic")) {
            waiting = true;
        }
        if message["type"] == "idle" {
            if std::mem::take(&mut waiting) {
                // How the run ended, as its idle says (the same order `read_messages` read them in).
                if let Some(end) = ended.next() {
                    if let (Some(error), Some(turn)) = (end.error, d.turns.iter_mut().rev()
                        .find(|t| t["status"] == "inProgress" && super::answers_to(t, &end.user))) {
                        turn["_opencodeSessionError"] = error;
                    }
                }
            }
            super::status(&mut d, &json!({"type": "idle"}));
        }
    }
    ensure!(!d.turns.iter().any(|t| t["status"] == "inProgress"), "这个会话里有一轮还没有结束；没有导入");
    for turn in &mut d.turns {
        turn["_yuzunoImported"] = mark.clone();
    }
    Ok(d.turns)
}

impl Workspace {
    /// An uploaded export, kept until it is confirmed (I1): checked whole
    /// first (`classify`), then kept in Core's own folder (0600), its preview
    /// answered under a new request ID. The same file whose import made an
    /// Agent that still exists says so; an earlier copy of the same session
    /// is named. Refused, keeping nothing, if it is not an export Core can
    /// import, or is larger than CAP.
    pub async fn opencode_import_upload(self: &Arc<Self>, bytes: Vec<u8>) -> Result<Value> {
        ensure!(enabled(), "此 Core 启动时关闭了 OpenCode Agent（YUZUNO_EXPERIMENTAL_OPENCODE=0）；没有导入");
        ensure!(bytes.len() <= CAP, "文件超过 {} MiB；没有导入", CAP >> 20);
        let (file, classified) = tokio::task::spawn_blocking(move || -> Result<(Value, Classified)> {
            let file: Value = serde_json::from_slice(&bytes).context(NOT_EXPORT)?;
            let classified = classify(&file)?;
            Ok((file, classified))
        }).await??;
        self.opencode_import_sweep().await;
        let (request, digest) = (uuid::Uuid::new_v4().to_string(), digest(&file));
        let source = classified.info["id"].as_str().unwrap_or_default().to_owned();
        let folder = self.opencode_import_folder(&request)?;
        let bytes = serde_json::to_vec(&file)?;
        tokio::task::spawn_blocking(move || write_private(&folder.join("source.json"), &bytes)).await??;
        let row = Row { request_id: request.clone(), source_session: source.clone(), digest: digest.clone(), target_agent_id: uuid::Uuid::new_v4().to_string(),
            name: None, cwd: None, state: "uploaded".into(), error: None };
        let kept = row.clone();
        self.stored(move |s| s.opencode_begin_import(&kept)).await?;
        // The same file's import, and another copy of the same session, as they stand.
        let (same, source_) = (digest.clone(), source.clone());
        let (live, earlier) = self.stored(move |s| Ok((s.opencode_live_import(&source_, &same)?, s.opencode_imports_of(&source_)?))).await?;
        let existing = match &live {
            Some(live) if live.state == "completed" => self.listed(&live.target_agent_id).await.ok(),
            _ => None,
        };
        let mut copies = Vec::new();
        for other in earlier.iter().filter(|r| r.state == "completed" && r.digest != digest) {
            if let Ok(agent) = self.listed(&other.target_agent_id).await {
                copies.push(json!({"agentId": agent.id, "name": agent.name}));
            }
        }
        let info = &classified.info;
        let turns = classified.messages.iter().filter(|m| m["type"] == "user").count();
        Ok(json!({
            "requestId": request, "sourceSession": source, "title": info["title"], "cwd": info["location"]["directory"],
            "turns": turns, "messages": classified.messages.len(), "model": model_of(info, &classified.messages), "agent": info["agent"],
            "droppedPermissions": info["permissions"].as_array().is_some_and(|p| !p.is_empty()),
            "droppedMetadata": info["metadata"].as_object().is_some_and(|m| !m.is_empty()),
            "cost": info["cost"], "existing": existing, "pending": live.filter(|l| l.state != "completed").map(|l| l.request_id),
            "earlierCopies": copies,
        }))
    }

    /// An import, as `create` asks (see the module): in a task of its own,
    /// so that a client that goes away drops only its wait. Asked again
    /// with the same request, it goes on from where that import is, and
    /// never writes twice.
    pub async fn opencode_import_create(self: &Arc<Self>, create: Create) -> Result<Value> {
        let name = crate::model::agent_name(&create.name)?;
        let permit = self.admission.enter_work()?;
        ensure!(enabled(), "此 Core 启动时关闭了 OpenCode Agent（YUZUNO_EXPERIMENTAL_OPENCODE=0）；没有导入");
        ensure!(uuid::Uuid::parse_str(&create.request_id).is_ok(), "导入请求编号无效");
        let ws = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            ws.opencode_import_run(Create { name, ..create }).await
        })
        .await?
    }

    async fn opencode_import_run(self: &Arc<Self>, create: Create) -> Result<Value> {
        let key = create.request_id.clone();
        let row = self.stored(move |s| s.opencode_import_row(&key)).await?.context("这个导入已过期或不存在，请重新上传文件")?;
        let gate = self.gate(&row.target_agent_id).await;
        let _held = gate.lock().await;
        let key = row.request_id.clone();
        let mut row = self.stored(move |s| s.opencode_import_row(&key)).await?.context("导入记录不见了")?;
        let mut started = None;
        let mut warnings = Vec::new();
        loop {
            match row.state.as_str() {
                "uploaded" => {
                    if let Some(answer) = self.opencode_import_begin(&mut row, &create).await? {
                        return Ok(answer);
                    }
                }
                "sending" | "uncertain" => {
                    self.opencode_import_write(&mut row, &mut started).await?;
                    if row.state == "uncertain" {
                        return Ok(outcome(&row, "uncertain", row.error.clone().unwrap_or_default()));
                    }
                }
                "forked" => self.opencode_import_verify(&mut row, &mut started).await?,
                "verified" => self.opencode_import_target(&mut row, &mut started, &mut warnings).await?,
                "failed" | "released" => return Ok(outcome(&row, "failed", row.error.clone().unwrap_or_else(|| "导入没有完成".into()))),
                "completed" => break,
                other => bail!("未知的导入状态 {other}"),
            }
        }
        let agent = self.listed(&row.target_agent_id).await?;
        let connected = agent.connection_state == "connected";
        Ok(json!({"state": "completed", "requestId": row.request_id, "agent": agent, "connected": connected, "importOutcome": "created",
            "warnings": warnings}))
    }

    /// An import as it stands, read without a write.
    pub(crate) async fn opencode_import_seen(self: &Arc<Self>, which: Which) -> Result<Value> {
        let key = which.request_id.clone();
        let Some(row) = self.stored(move |s| s.opencode_import_row(&key)).await? else { return Ok(json!({"state": "none"})) };
        Ok(match row.state.as_str() {
            "uploaded" => outcome(&row, "uploaded", String::new()),
            "sending" | "uncertain" => outcome(&row, "uncertain", row.error.clone().unwrap_or_default()),
            "failed" | "released" => outcome(&row, "failed", row.error.clone().unwrap_or_else(|| "导入没有完成".into())),
            "completed" => match self.listed(&row.target_agent_id).await {
                Ok(agent) => json!({"state": "completed", "requestId": row.request_id, "agent": agent, "importOutcome": "created", "warnings": []}),
                Err(_) => outcome(&row, "failed", "导入出的 Agent 已删除".into()),
            },
            _ => outcome(&row, "pending", "这次导入还没有登记完；继续会接着核对和登记，不会再写一次".into()),
        })
    }

    /// The confirm: the folder checked, and the one live import for this
    /// file taken for this one; another live one, or the Agent one made, is
    /// answered instead (`Some`).
    async fn opencode_import_begin(self: &Arc<Self>, row: &mut Row, create: &Create) -> Result<Option<Value>> {
        let cwd = create.cwd.clone();
        let folder = tokio::task::spawn_blocking(move || std::fs::canonicalize(&cwd).ok().filter(|p| p.is_dir())).await?
            .context("这个目录不存在或无法读取；没有导入")?
            .to_str().context("这个目录不是 UTF-8；没有导入")?.to_owned();
        let (source, digest) = (row.source_session.clone(), row.digest.clone());
        if let Some(live) = self.stored(move |s| s.opencode_live_import(&source, &digest)).await? {
            let gone = live.state == "completed" && self.listed(&live.target_agent_id).await.is_err();
            if !gone {
                return Ok(Some(match live.state.as_str() {
                    "completed" => json!({"state": "completed", "requestId": live.request_id, "importOutcome": "existing",
                        "agent": self.listed(&live.target_agent_id).await?, "warnings": []}),
                    _ => outcome(&live, "pending", "这个文件已有一次导入在进行；请继续那一次".into()),
                }));
            }
            // Its Agent deleted, the file can be imported anew.
            let key = live.request_id.clone();
            self.stored(move |s| s.opencode_set_import(&key, "released", Some("导入出的 Agent 已删除"))).await?;
        }
        let (key, name, cwd) = (row.request_id.clone(), create.name.clone(), folder.clone());
        if !self.stored(move |s| s.opencode_send_import(&key, &name, &cwd)).await? {
            return Ok(Some(outcome(row, "pending", "这个文件已有一次导入在进行；请继续那一次".into())));
        }
        row.state = "sending".into();
        row.name = Some(create.name.clone());
        row.cwd = Some(folder);
        Ok(None)
    }

    /// What the import writes, fixed once (again, the same, if Core stopped
    /// before it was kept): the new Agent's folder reserved, its OpenCode
    /// started, the agent rule applied, and the copy made for the folder and
    /// project that OpenCode holds. `None`: it failed, as the row now says.
    async fn opencode_import_fix(self: &Arc<Self>, row: &mut Row, started: &mut Option<Started>) -> Result<Option<Fixed>> {
        let kept = self.opencode_import_folder(&row.request_id)?.join("fixed.json");
        if kept.is_file() {
            return Ok(Some(read_private(&kept)?));
        }
        let target = self.data_dir.join("opencode").join(&row.target_agent_id);
        if !target.exists() {
            transfer::reserve(&target, "import.json", &json!({"requestId": row.request_id, "database": target.join("opencode.db")}))
                .context("没有导入")?;
        }
        let server = self.opencode_import_server(row, started).await?;
        let folder = row.cwd.clone().context("导入记录缺少目录")?;
        let file: Value = read_private(&self.opencode_import_folder(&row.request_id)?.join("source.json"))?;
        let classified = classify(&file)?;
        let unread = "读不到新 Agent 的 OpenCode 认定的目录；重试会接着进行，不会写第二次";
        let project = server.location(&folder).await.context(unread)?["project"]["id"].as_str().context(unread)?.to_owned();
        let agents = server.agents(&folder).await.context("读不到新 Agent 的 OpenCode 的 agent；重试会接着进行，不会写第二次")?;
        let agent = match kept_agent(&classified.info["agent"], &agents) {
            Ok(agent) => agent,
            Err(error) => {
                self.opencode_import_state(row, "failed", Some(format!("{error:#}"))).await?;
                return Ok(None);
            }
        };
        let listed = server.models().await.context("读不到新 Agent 的 OpenCode 的模型；重试会接着进行，不会写第二次")?;
        let (sent, model, variant, notice) = kept_model(&file_model(&classified.info, &classified.messages), &listed);
        let name = row.name.clone().unwrap_or_default();
        let fixed = Fixed { payload: import_payload(&classified, &row.request_id, &name, &folder, &project, agent, sent), project,
            source_session: row.source_session.clone(), model, variant, notice };
        write_private(&kept, &serde_json::to_vec(&fixed)?)?;
        Ok(Some(fixed))
    }

    /// The copy written once into the new Agent's OpenCode (rule R5,
    /// `opencode_transfer::write_once`).
    async fn opencode_import_write(self: &Arc<Self>, row: &mut Row, started: &mut Option<Started>) -> Result<()> {
        let Some(fixed) = self.opencode_import_fix(row, started).await? else { return Ok(()) };
        let server = self.opencode_import_server(row, started).await?;
        if let Err(error) = transfer::place(&server, &fixed.payload, &fixed.project).await {
            return self.opencode_import_state(row, "failed", Some(format!("{error:#}"))).await;
        }
        let (anew, again) = ("可以重新导入，新的一次会写进它自己的目录", "重试会接着核对新 Agent 的 OpenCode，不会写第二次");
        match transfer::write_once(&server, &fixed.payload, WATCH, row.state == "uncertain", anew, again).await? {
            Written::Held => self.opencode_import_state(row, "forked", None).await,
            Written::Failed(why) => self.opencode_import_state(row, "failed", Some(why)).await,
            Written::Uncertain(why) => self.opencode_import_state(row, "uncertain", Some(why)).await,
        }
    }

    /// The copy read back whole and compared with what was fixed (rule R6).
    async fn opencode_import_verify(self: &Arc<Self>, row: &mut Row, started: &mut Option<Started>) -> Result<()> {
        let fixed = self.opencode_import_fixed(row)?;
        let server = self.opencode_import_server(row, started).await?;
        match transfer::read_copy(&server, &fixed.payload, &fixed.project).await? {
            Ok(()) => self.opencode_import_state(row, "verified", None).await,
            Err(error) => self.opencode_import_state(row, "failed", Some(format!("{error:#}；没有登记，新 Agent 的目录留着"))).await,
        }
    }

    /// The new Agent registered with the Turns built from the copy, and
    /// attached to the very process the copy was read back from.
    async fn opencode_import_target(self: &Arc<Self>, row: &mut Row, started: &mut Option<Started>, warnings: &mut Vec<String>) -> Result<()> {
        let fixed = self.opencode_import_fixed(row)?;
        let mark = json!({"requestId": row.request_id, "sessionId": fixed.source_session});
        let turns = imported_turns(&fixed.payload.messages, &mark)?;
        let server = self.opencode_import_server(row, started).await?;
        let version = server.version().to_owned();
        let at = now();
        let detail = AgentDetail {
            agent: crate::model::Agent {
                id: row.target_agent_id.clone(), name: row.name.clone().unwrap_or_default(), goal: String::new(), work_summary: None, turn_wait: None, project_id: None,
                kind: None, released_at: None, released_by: None, executor: None,
                cwd: row.cwd.clone().unwrap_or_default(), model: fixed.model.clone(),
                settings: crate::model::AgentSettings { reasoning_effort: fixed.variant.clone(), ..Default::default() }, color: "sage".into(),
                harness: "opencode".into(), claude_session_id: None, opencode_session_id: Some(fixed.payload.id().to_owned()),
                opencode_version: Some(version.clone()), opencode_major: crate::opencode::major(&version), dsh_session_id: None, dsh_version: None, thread_id: None,
                status: "offline".into(), closed_at: None, disconnected_at: None, disconnect_unconfirmed: false,
                created_at: at.clone(), updated_at: at, unread_count: 0, pending_count: 0, open_questions: 0, last_turn_end: None, last_message: None,
                last_seq: 0, reviewed_seq: 0, rev: 0, error: None, remote: None, connection_state: "disconnected".into(),
            },
            history: None, turns, pending: vec![], artifacts: vec![], context_usage: None, message_receipts: vec![],
            claude_runtime: None, codex_handoff: None, opencode_usage_seen: None,
        };
        let (request, source) = (row.request_id.clone(), fixed.source_session.clone());
        let agent = self.stored(move |s| s.opencode_insert_import(&detail, &request, &source)).await?;
        row.state = "completed".into();
        warnings.extend(fixed.notice.clone());
        self.changed(&agent.id);
        // Attached to the very process the copy was read back from. A failed
        // attach leaves the registered Agent offline; nothing is retried here.
        if let Err(error) = self.opencode_ensure_on(&agent.id, started.take()).await {
            warnings.push(format!("已导入，但连接失败：{error}"));
        }
        Ok(())
    }

    /// The new Agent's OpenCode for this run: the one it started, or one
    /// started now on its own folder.
    async fn opencode_import_server(self: &Arc<Self>, row: &Row, started: &mut Option<Started>) -> Result<Arc<opencode::Server>> {
        let marker = transfer::reserved(&self.data_dir.join("opencode").join(&row.target_agent_id), "import.json")?;
        ensure!(marker["requestId"] == row.request_id.as_str(), "新 Agent 的目录不是为这次导入预留的；没有登记");
        if started.is_none() {
            let cwd = row.cwd.clone().context("导入记录缺少目录")?;
            *started = Some(self.opencode_start(&row.target_agent_id, &cwd).await
                .context("新 Agent 的 OpenCode 没有启动；重试会接着进行，不会写第二次")?);
        }
        started.as_ref().map(|started| started.server.clone()).context("新 Agent 的 OpenCode 没有启动")
    }

    async fn opencode_import_state(&self, row: &mut Row, state: &str, error: Option<String>) -> Result<()> {
        let (key, kept, message) = (row.request_id.clone(), state.to_owned(), error.clone());
        self.stored(move |s| s.opencode_set_import(&key, &kept, message.as_deref())).await?;
        row.state = state.into();
        row.error = error;
        Ok(())
    }

    fn opencode_import_fixed(&self, row: &Row) -> Result<Fixed> {
        read_private(&self.opencode_import_folder(&row.request_id)?.join("fixed.json"))
    }

    /// Where an import keeps its file and what it fixed: Core's own (0700).
    fn opencode_import_folder(&self, request: &str) -> Result<PathBuf> {
        ensure!(uuid::Uuid::parse_str(request).is_ok(), "导入请求编号无效");
        let folder = self.data_dir.join("opencode").join("imports").join(request);
        std::fs::create_dir_all(&folder)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(folder)
    }

    /// Uploads never confirmed within KEPT go, with their files.
    async fn opencode_import_sweep(&self) {
        let before = (chrono::Utc::now() - KEPT).to_rfc3339();
        let stale = match self.stored(move |s| s.opencode_stale_imports(&before)).await {
            Ok(stale) => stale,
            Err(error) => {
                eprintln!("Workspace OpenCode imports not swept: {error:#}");
                return;
            }
        };
        for request in stale {
            if uuid::Uuid::parse_str(&request).is_err() {
                continue;
            }
            let folder = self.data_dir.join("opencode").join("imports").join(&request);
            if let Err(error) = std::fs::remove_dir_all(&folder) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("Workspace OpenCode import {} not removed: {error}", folder.display());
                    continue;
                }
            }
            let key = request.clone();
            let _ = self.stored(move |s| s.opencode_drop_import(&key)).await;
        }
    }
}

fn outcome(row: &Row, state: &str, message: String) -> Value {
    json!({"state": state, "requestId": row.request_id, "message": message, "warnings": []})
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn read_private<T: serde::de::DeserializeOwned>(path: &std::path::Path) -> Result<T> {
    Ok(serde_json::from_slice(&std::fs::read(path).with_context(|| format!("读不到导入记下的 {}", path.display()))?)?)
}

/// The routes: the upload (a raw body up to CAP, past the JSON limit), the
/// confirm, and a read of one import.
pub(crate) fn router() -> axum::Router<Arc<Workspace>> {
    use axum::{extract::{Query, Request, State}, routing::post, Json};
    async fn upload(State(ws): State<Arc<Workspace>>, request: Request) -> Result<Json<Value>, crate::server::ApiError> {
        let _permit = ws.admission.enter_work()?;
        static UPLOAD: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
        let _slot = UPLOAD.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1))).clone().try_acquire_owned()
            .map_err(|_| anyhow!("另一个文件正在上传，请稍后重试；没有导入"))?;
        let bytes = axum::body::to_bytes(request.into_body(), CAP).await
            .map_err(|_| anyhow!("文件超过 {} MiB；没有导入", CAP >> 20))?;
        Ok(Json(ws.opencode_import_upload(bytes.to_vec()).await?))
    }
    async fn create(State(ws): State<Arc<Workspace>>, Json(p): Json<Create>) -> Result<Json<Value>, crate::server::ApiError> {
        Ok(Json(ws.opencode_import_create(p).await?))
    }
    async fn seen(State(ws): State<Arc<Workspace>>, Query(which): Query<Which>) -> Result<Json<Value>, crate::server::ApiError> {
        Ok(Json(ws.opencode_import_seen(which).await?))
    }
    axum::Router::new()
        .route("/api/opencode/sessions/import/file", post(upload))
        .route("/api/opencode/sessions/import", post(create).get(seen))
}

pub(crate) fn migrate(db: &rusqlite::Connection) -> Result<()> {
    db.execute_batch(&format!("CREATE TABLE IF NOT EXISTS opencode_imports(
        request_id TEXT PRIMARY KEY, source_session TEXT NOT NULL, digest TEXT NOT NULL, target_agent_id TEXT NOT NULL UNIQUE,
        name TEXT, cwd TEXT, state TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS opencode_imports_one_live ON opencode_imports(source_session,digest) WHERE state IN {LIVE};"))?;
    Ok(())
}

const COLUMNS: &str = "request_id,source_session,digest,target_agent_id,name,cwd,state,error";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok(Row {
        request_id: r.get(0)?, source_session: r.get(1)?, digest: r.get(2)?, target_agent_id: r.get(3)?,
        name: r.get(4)?, cwd: r.get(5)?, state: r.get(6)?, error: r.get(7)?,
    })
}

impl crate::store::Store {
    fn opencode_import_row(&self, request: &str) -> Result<Option<Row>> {
        use rusqlite::OptionalExtension;
        Ok(self.db.read()?.query_row(&format!("SELECT {COLUMNS} FROM opencode_imports WHERE request_id=?1"), [request], row).optional()?)
    }
    fn opencode_live_import(&self, source: &str, digest: &str) -> Result<Option<Row>> {
        use rusqlite::OptionalExtension;
        Ok(self.db.read()?.query_row(&format!("SELECT {COLUMNS} FROM opencode_imports WHERE source_session=?1 AND digest=?2 AND state IN {LIVE}"),
            [source, digest], row).optional()?)
    }
    fn opencode_imports_of(&self, source: &str) -> Result<Vec<Row>> {
        let db = self.db.read()?;
        let mut query = db.prepare(&format!("SELECT {COLUMNS} FROM opencode_imports WHERE source_session=?1 ORDER BY created_at"))?;
        let rows = query.query_map([source], row)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }
    fn opencode_begin_import(&self, row: &Row) -> Result<()> {
        let at = now();
        self.db.write()?.execute(&format!("INSERT INTO opencode_imports({COLUMNS},created_at,updated_at) VALUES(?1,?2,?3,?4,NULL,NULL,'uploaded',NULL,?5,?5)"),
            rusqlite::params![row.request_id, row.source_session, row.digest, row.target_agent_id, at])?;
        Ok(())
    }
    /// Takes the one live import of its file for this one, from `uploaded`:
    /// whether it took it (another went live first: not).
    fn opencode_send_import(&self, request: &str, name: &str, cwd: &str) -> Result<bool> {
        let changed = self.db.write()?.execute("UPDATE opencode_imports SET state='sending', name=?2, cwd=?3, updated_at=?4 WHERE request_id=?1 AND state='uploaded'",
            rusqlite::params![request, name, cwd, now()]);
        match changed {
            Ok(changed) => Ok(changed == 1),
            Err(rusqlite::Error::SqliteFailure(error, _)) if error.code == rusqlite::ErrorCode::ConstraintViolation => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
    fn opencode_set_import(&self, request: &str, state: &str, error: Option<&str>) -> Result<()> {
        self.db.write()?.execute("UPDATE opencode_imports SET state=?2, error=?3, updated_at=?4 WHERE request_id=?1",
            rusqlite::params![request, state, error, now()])?;
        Ok(())
    }
    fn opencode_stale_imports(&self, before: &str) -> Result<Vec<String>> {
        let db = self.db.read()?;
        let mut query = db.prepare("SELECT request_id FROM opencode_imports WHERE state='uploaded' AND updated_at < ?1")?;
        let rows = query.query_map([before], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }
    fn opencode_drop_import(&self, request: &str) -> Result<()> {
        self.db.write()?.execute("DELETE FROM opencode_imports WHERE request_id=?1 AND state='uploaded'", [request])?;
        Ok(())
    }
    /// Registers a verified import in one transaction: the Agent with its
    /// Turns, a record of where it came from, and the completed import.
    fn opencode_insert_import(&self, detail: &AgentDetail, request: &str, source: &str) -> Result<crate::model::Agent> {
        let rows = crate::record_rows::split(detail)?;
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let current: String = tx.query_row("SELECT state FROM opencode_imports WHERE request_id=?1", [request], |r| r.get(0))?;
        ensure!(current == "verified", "导入已不在等待登记；没有登记第二次");
        crate::record_rows::insert(&tx, &detail.agent.id, &rows)?;
        let session = detail.agent.opencode_session_id.clone().unwrap_or_default();
        tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,'opencode/imported',?2,?3)",
            rusqlite::params![detail.agent.id, json!({"sessionId": session, "sourceSession": source, "requestId": request, "turns": detail.turns.len()}).to_string(), now()])?;
        tx.execute("UPDATE opencode_imports SET state='completed', error=NULL, updated_at=?2 WHERE request_id=?1", rusqlite::params![request, now()])?;
        tx.commit()?;
        Ok(detail.agent.clone())
    }
}

#[cfg(test)]
#[path = "opencode_import_tests.rs"]
mod tests;
