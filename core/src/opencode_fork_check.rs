//! What a fork of an OpenCode 2.x session must be, checked without a request
//! (T-61 slice 7, D-28 F-A): where its copy ends, and how the source's Turns
//! are carried into the new Agent. Everything here reads values already
//! read; `opencode_fork` asks.
//!
//! The copy keeps every message's own ID (2.x's import does, 2.2.5
//! core/src/session/transfer.ts), so a copied Turn names the same messages
//! it did: only what tied it to the source's own process and session is left
//! behind or rewritten.
use crate::opencode_transfer::{settled, KNOWN_TYPES};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Map, Value};

/// The native message a Turn starts with, if 2.x holds one for it: a
/// prompt's own ID; the message 2.x admitted for a command (`native`); the
/// compaction message a `/compact` was admitted under (`input`). None for a
/// command that ran no Turn here (`notice`), one refused before 2.x took it,
/// or a compaction 2.x never admitted.
pub(crate) fn anchor(turn: &Value) -> Option<&str> {
    if let Some(compact) = turn.get("_opencodeCompact") {
        return match compact["state"].as_str() {
            Some("refused" | "absent" | "lost" | "stopped") => None,
            _ => compact["input"].as_str(),
        };
    }
    if let Some(command) = turn.get("_opencodeCommand") {
        return command["native"].as_str();
    }
    if turn.get("notice").is_some() || turn["_opencodeConfirmed"] != true {
        return None;
    }
    turn["id"].as_str()
}

/// The native messages a Turn names (as the adapter writes them,
/// `opencode_agent`): its anchor, the inputs added to it, the newest of
/// them, the answers to it and what each answered, its shells and what
/// each answered, and the newest message 2.x wrote after it that it ran on
/// under (`_opencodeFollowed`).
pub(crate) fn owned(turn: &Value) -> Vec<String> {
    let mut held = Vec::new();
    let mut take = |value: &Value| {
        if let Some(id) = value.as_str() {
            held.push(id.to_owned());
        }
    };
    take(&json!(anchor(turn)));
    for (id, _) in turn["_opencodeInputs"].as_object().into_iter().flatten() {
        take(&json!(id));
    }
    take(&turn["_opencodeLastInput"]);
    for (id, answer) in turn["_opencodeAnswers"].as_object().into_iter().flatten() {
        take(&json!(id));
        take(&answer["parent"]);
    }
    for (id, parent) in turn["_opencodeShells"].as_object().into_iter().flatten() {
        take(&json!(id));
        take(parent);
    }
    take(&turn["_opencodeFollowed"]);
    held
}

/// Why a Turn kept by a fork is not settled, if it is not: one still under
/// way, or whose delivery, command, input, compaction, tool or shell is not
/// known to have ended. A Turn refused before 2.x took it (`failed`, never
/// confirmed) is settled history.
fn unsettled(turn: &Value) -> Option<String> {
    let id = turn["id"].as_str().unwrap_or_default();
    let status = turn["status"].as_str().unwrap_or_default();
    if status == "inProgress" {
        return Some(format!("Turn {id} 还没有结束"));
    }
    if turn.get("missingNative").is_some() || turn.get("itemsView").is_some() {
        return Some(format!("Turn {id} 不是 OpenCode 的记录"));
    }
    if turn.get("_yuzunoCompactionId").is_some() {
        return Some(format!("Turn {id} 的压缩还没有结束"));
    }
    if let Some(compact) = turn.get("_opencodeCompact") {
        if matches!(compact["state"].as_str(), Some("pending" | "unknown") | None) {
            return Some(format!("Turn {id} 的压缩结果还没有确认"));
        }
        if compact["input"].is_null() && compact["state"] != "lost" {
            return Some(format!("Turn {id} 的压缩是 OpenCode 1.19.3 时的记录"));
        }
        return None;
    }
    let refused = status == "failed" && turn["_opencodeConfirmed"] != true;
    if turn["_opencodeConfirmed"] != true && !refused && turn.get("notice").is_none() {
        return Some(format!("Turn {id} 没有确认送到 OpenCode"));
    }
    if turn["_opencodeCommand"]["awaiting"] == true && status != "failed" {
        return Some(format!("Turn {id} 的命令结果还没有确认"));
    }
    for (input, state) in turn["_opencodeInputs"].as_object().into_iter().flatten() {
        if state["confirmed"] != true {
            return Some(format!("Turn {id} 追加的输入 {input} 没有确认送到 OpenCode"));
        }
    }
    for item in turn["items"].as_array().into_iter().flatten() {
        if item["status"] == "inProgress" {
            return Some(format!("Turn {id} 的 {} 还在进行", item["id"]));
        }
    }
    None
}

/// How many of `list`'s messages a fork through `through` copies (D-28
/// rule R2): those up to and including the idle that ended the last run
/// before the next Turn 2.x holds anything of (or before the list's end).
/// `turns` are the Agent's Turns in order; `list` the session's messages
/// as 2.x lists them, oldest first. Refused, saying why, unless that cut is
/// proven:
/// - the Turn and every one before it are settled, and the Turn completed;
/// - every message a kept Turn names is in the copy, and none a later Turn
///   names is;
/// - between the cut and the next Turn there is only what Core sets before
///   a message (the model or the agent);
/// - every message copied is of a type 2.x keeps, settled, and none moves
///   the session to another folder.
pub(crate) fn cut(turns: &[Value], list: &[Value], through: &str) -> Result<usize> {
    let at = |id: &str| list.iter().position(|m| m["id"] == id);
    let index = turns.iter().position(|t| t["id"] == through).context("这个 Agent 没有这个 Turn；没有 fork")?;
    ensure!(turns[index]["status"] == "completed", "只能从已完成的 Turn fork；没有 fork");
    let kept = &turns[..=index];
    for turn in kept {
        if let Some(why) = unsettled(turn) {
            bail!("{why}；没有 fork");
        }
        let id = turn["id"].as_str().unwrap_or_default();
        for held in owned(turn) {
            ensure!(at(&held).is_some(), "Turn {id} 记下的消息 {held} 不在 OpenCode 会话里；没有 fork");
        }
    }
    let start = anchor(&turns[index]).and_then(at).context("这个 Turn 在 OpenCode 里没有自己的消息；没有 fork")?;
    // The first later Turn 2.x holds anything of: what it names starts there or after.
    let mut next = list.len();
    for turn in &turns[index + 1..] {
        let id = turn["id"].as_str().unwrap_or_default();
        let present: Vec<usize> = owned(turn).iter().filter_map(|held| at(held)).collect();
        if present.is_empty() {
            ensure!(anchor(turn).is_none() || turn["status"] == "failed", "Turn {id} 在 OpenCode 里的位置无法确定；没有 fork");
            continue;
        }
        let first = *present.iter().min().unwrap_or(&list.len());
        ensure!(first > start, "Turn {id} 的消息在 fork 的这个 Turn 之前；没有 fork");
        next = next.min(first);
    }
    // The idle that ended the last run before it.
    let end = (start..next).rev().find(|&i| list[i]["type"] == "idle").context("这个 Turn 之后的运行还没有结束；没有 fork")?;
    for message in &list[end + 1..next] {
        ensure!(matches!(message["type"].as_str(), Some("model-switched" | "agent-switched")),
            "这个 Turn 之后、下一个 Turn 之前 OpenCode 还写了 {}（{}），无法确定它属于哪一段；没有 fork", message["type"], message["id"]);
    }
    for turn in kept {
        let id = turn["id"].as_str().unwrap_or_default();
        ensure!(owned(turn).iter().all(|held| at(held).is_some_and(|p| p <= end)), "Turn {id} 的消息越过了 fork 的边界；没有 fork");
    }
    for message in &list[..=end] {
        let id = message["id"].as_str().context("OpenCode 的消息没有 ID")?;
        let kind = message["type"].as_str().unwrap_or_default();
        ensure!(KNOWN_TYPES.contains(&kind), "OpenCode 的消息 {id} 的类型 {kind} 不认识；没有 fork");
        ensure!(kind != "location-switched", "OpenCode 会话在这个 Turn 之前换过目录；没有 fork");
        ensure!(settled(message), "OpenCode 的消息 {id} 还没有结束；没有 fork");
    }
    Ok(end + 1)
}

/// The pasted images a copy shows: each one's path for the new Agent, from
/// the source's own (`opencode_fork::Images`).
pub(crate) trait ImagePaths {
    fn path(&mut self, path: &str) -> Result<String>;
}

/// The source's Turns through the fork's, as the new Agent holds them (rule
/// R7): every native ID they hold as it is (the copy keeps them); what bound
/// them to the source's own process, session or sends left behind; each
/// marked as copied (`_yuzunoCopiedFrom`, which Rewind refuses, D-32). A
/// field this does not know refuses the fork rather than being carried.
pub(crate) fn copy(turns: &[Value], session: &str, from: &Value, images: &mut impl ImagePaths) -> Result<Vec<Value>> {
    let mut kept = Vec::new();
    for turn in turns {
        let object = turn.as_object().context("Turn 记录无法读取")?;
        let id = object.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let mut out = Map::new();
        for (name, value) in object {
            let value = match name.as_str() {
                "id" | "status" | "error" | "notice" | "_opencodeConfirmed" | "_opencodeCommand" | "_opencodeLastInput"
                | "_opencodeFollowed" | "_opencodeAnswers" | "_opencodeShells" | "_opencodeSessionError" | "_yuzunoStartedAt"
                | "_yuzunoCompletedAt" | "_yuzunoDurationMs" | "_yuzunoCompactionStartedAt" => value.clone(),
                // A copy of a copy is marked as the source's, below.
                "_yuzunoCopiedFrom" => continue,
                "items" => {
                    let mut items = Vec::new();
                    for item in value.as_array().into_iter().flatten() {
                        items.push(copy_item(item, &id, images)?);
                    }
                    Value::Array(items)
                }
                "_opencodeInputs" => {
                    let mut inputs = Map::new();
                    for (input, state) in value.as_object().into_iter().flatten() {
                        // Its way back while it was sent, and its sender's ID: the source's sends.
                        inputs.insert(input.clone(), json!({"confirmed": state["confirmed"]}));
                    }
                    Value::Object(inputs)
                }
                "_opencodeCompact" => copy_compact(value, session, &id)?,
                // The source's own run and sends.
                "interruptRequested" | "deliveryUnconfirmed" => continue,
                other => bail!("Turn {id} 里有 fork 还不能带过去的记录 {other}；没有 fork"),
            };
            out.insert(name.clone(), value);
        }
        out.insert("_yuzunoCopiedFrom".into(), from.clone());
        kept.push(Value::Object(out));
    }
    Ok(kept)
}

fn copy_item(item: &Value, turn: &str, images: &mut impl ImagePaths) -> Result<Value> {
    let object = item.as_object().context("Turn 的内容无法读取")?;
    let mut out = Map::new();
    for (name, value) in object {
        let value = match name.as_str() {
            "id" | "type" | "text" | "summary" | "name" | "callId" | "input" | "output" | "status" | "command" | "aggregatedOutput"
            | "exitCode" | "trigger" | "nativeMessageId" | "_yuzunoTime" | "_yuzunoInputText" | "_yuzunoTextBlocks" => value.clone(),
            "content" => {
                let mut content = value.clone();
                for part in content.as_array_mut().into_iter().flatten() {
                    if part["type"] == "localImage" {
                        part["path"] = json!(images.path(part["path"].as_str().context("图片路径无法读取；没有 fork")?)?);
                    }
                }
                content
            }
            // The source's receipts and sends.
            "clientId" | "deliveryUnconfirmed" => continue,
            other => bail!("Turn {turn} 的内容里有 fork 还不能带过去的记录 {other}；没有 fork"),
        };
        out.insert(name.clone(), value);
    }
    Ok(Value::Object(out))
}

fn copy_compact(value: &Value, session: &str, turn: &str) -> Result<Value> {
    let object = value.as_object().context("压缩记录无法读取")?;
    // One from 1.19.3's time that 2.x never held: only that it was lost.
    if object.get("input").is_none() {
        return Ok(json!({"state": object.get("state").cloned().unwrap_or(json!("lost"))}));
    }
    let mut out = Map::new();
    for (name, value) in object {
        let value = match name.as_str() {
            "state" | "input" | "model" | "variant" | "native" | "absent" => value.clone(),
            "session" => json!(session),
            // The source's own process.
            "generation" | "askedBy" | "answered" => continue,
            other => bail!("Turn {turn} 的压缩记录里有 fork 还不能带过去的记录 {other}；没有 fork"),
        };
        out.insert(name.clone(), value);
    }
    Ok(Value::Object(out))
}

/// A digest of what was read: what a fork must copy.
pub(crate) fn digest(value: &Value) -> Result<String> {
    use sha2::{Digest, Sha256};
    Ok(Sha256::digest(serde_json::to_vec(value)?).iter().map(|b| format!("{b:02x}")).collect())
}
