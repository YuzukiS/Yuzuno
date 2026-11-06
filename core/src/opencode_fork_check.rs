//! What a fork of an OpenCode session must be, checked without a request
//! (T-10 Fork, contract on T-10 #3527, Lead 3525): where it ends, how its
//! copy pairs with what it copies, and what its durable events must be.
//! Everything here reads values already read; `opencode_fork` asks.
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// The native messages a Turn is the owner of (Lead 3528, as the adapter
/// writes them, `opencode_agent`): a prompt's or command's own ID, the
/// inputs added to it once confirmed, the newest of them, what answered it
/// and what each answer answered, and the newest message OpenCode wrote
/// itself after it (`_opencodeFollowed`, which names only the newest); for
/// `/compact`, whose own ID is Core's (`compact_<UUID>`), the compaction
/// message it was bound to and its summary. Not ownership: a compaction's
/// `known` (compaction messages there before it began) and `candidates`
/// (what it looked at), an input's `previous` (a way back), and part IDs.
pub(crate) fn owned(turn: &Value) -> Vec<String> {
    let mut held = Vec::new();
    let mut take = |value: &Value| {
        if let Some(id) = value.as_str() {
            held.push(id.to_owned());
        }
    };
    if let Some(compact) = turn.get("_opencodeCompact") {
        take(&compact["message"]);
        take(&compact["summary"]["id"]);
        return held;
    }
    take(&turn["id"]);
    for (id, input) in turn["_opencodeInputs"].as_object().into_iter().flatten() {
        if input["confirmed"] == true {
            take(&json!(id));
        }
    }
    take(&turn["_opencodeLastInput"]);
    for (id, answer) in turn["_opencodeAnswers"].as_object().into_iter().flatten() {
        take(&json!(id));
        take(&answer["parent"]);
    }
    take(&turn["_opencodeFollowed"]);
    held
}

/// The message a Turn starts with natively: a prompt's or command's own ID,
/// or the compaction message a `/compact` was bound to.
fn anchor(turn: &Value) -> Option<&str> {
    match turn.get("_opencodeCompact") {
        Some(compact) => compact["message"].as_str(),
        None => turn["id"].as_str(),
    }
}

/// Where a fork through `through` ends (contract 2): the native message the
/// next Turn starts with, which OpenCode copies up to and not including
/// (None: `through` is the newest Turn there, so every message is copied),
/// and how many of `list`'s messages that keeps. `turns` are the Agent's
/// Turns in order, whole up to and including `through`; `list` the session's
/// messages as read. Refused, saying why, unless that boundary is proven:
/// every native message the kept Turns hold is in what is kept, none of a
/// later Turn's is, and nothing kept is of unknown owner or unfinished.
pub(crate) fn boundary(turns: &[Value], list: &[Value], through: &str) -> Result<(Option<String>, usize)> {
    let at = |id: &str| list.iter().position(|m| m["info"]["id"] == id);
    let index = turns.iter().position(|t| t["id"] == through).context("这个 Agent 没有这个 Turn；没有 fork")?;
    ensure!(turns[index]["status"] == "completed", "只能从已完成的 Turn fork；没有 fork");
    let kept = &turns[..=index];
    for turn in kept {
        let id = turn["id"].as_str().unwrap_or_default();
        ensure!(turn["status"] != "inProgress", "Turn {id} 还没有结束；没有 fork");
        ensure!(turn.get("missingNative").is_none(), "Turn {id} 在 OpenCode 里找不到；没有 fork");
        match turn.get("_opencodeCompact") {
            Some(compact) => {
                ensure!(compact["state"] == "completed" && compact["message"].is_string() && compact.get("ambiguous").is_none(),
                    "Turn {id} 的压缩没有确认完成；没有 fork");
                compacted(compact, list).with_context(|| format!("Turn {id} 的压缩与 OpenCode 会话对不上；没有 fork"))?;
            }
            None => ensure!(turn["_opencodeConfirmed"] == true, "Turn {id} 没有确认送到 OpenCode；没有 fork"),
        }
        for (input, state) in turn["_opencodeInputs"].as_object().into_iter().flatten() {
            ensure!(state["confirmed"] == true && state.get("deliveryUnconfirmed").is_none(),
                "Turn {id} 追加的输入 {input} 没有确认送到 OpenCode；没有 fork");
        }
        for held in owned(turn) {
            ensure!(at(&held).is_some(), "Turn {id} 记下的消息 {held} 不在 OpenCode 会话里；没有 fork");
        }
    }
    // The first later Turn OpenCode holds anything of starts what is not kept.
    let mut cutoff = None;
    for turn in &turns[index + 1..] {
        let id = turn["id"].as_str().unwrap_or_default();
        let present: Vec<usize> = owned(turn).iter().filter_map(|held| at(held)).collect();
        if present.is_empty() {
            // Never reached OpenCode: nothing of it is in the session.
            ensure!(turn["_opencodeConfirmed"] != true && turn["status"] != "inProgress",
                "Turn {id} 在 OpenCode 里的位置无法确定；没有 fork");
            continue;
        }
        let start = anchor(turn).and_then(at).with_context(|| format!("Turn {id} 在 OpenCode 里的起点无法确定；没有 fork"))?;
        let cut = cutoff.get_or_insert_with(|| (start, list[start]["info"]["id"].as_str().unwrap_or_default().to_owned())).0;
        ensure!(present.iter().all(|p| *p >= cut), "Turn {id} 的消息在 fork 的边界之前；没有 fork");
    }
    let end = cutoff.as_ref().map(|c| c.0).unwrap_or(list.len());
    for turn in kept {
        let id = turn["id"].as_str().unwrap_or_default();
        ensure!(owned(turn).iter().all(|held| at(held).is_some_and(|p| p < end)), "Turn {id} 的消息越过了 fork 的边界；没有 fork");
    }
    // Every message kept then follows a kept Turn's own start.
    let first = kept.iter().filter_map(|t| anchor(t).and_then(at)).min().context("没有可以 fork 的消息")?;
    ensure!(first == 0, "OpenCode 会话开头有不属于任何 Turn 的消息；没有 fork");
    let users: BTreeSet<&str> = list[..end].iter().filter(|m| m["info"]["role"] == "user").filter_map(|m| m["info"]["id"].as_str()).collect();
    for message in &list[..end] {
        let info = &message["info"];
        let id = info["id"].as_str().context("OpenCode 的消息没有 ID")?;
        match info["role"].as_str() {
            // A user message no Turn names is OpenCode's own (a follow-up,
            // an automatic compaction, a continue): it stays in the range
            // of the Turn it follows, which is kept.
            Some("user") => {}
            Some("assistant") => {
                let parent = info["parentID"].as_str().unwrap_or_default();
                ensure!(users.contains(parent), "OpenCode 的回答 {id} 答的消息不在 fork 里；没有 fork");
                ensure!(info["time"]["completed"].is_number(), "OpenCode 的回答 {id} 还没有结束；没有 fork");
            }
            _ => bail!("OpenCode 的消息 {id} 的角色无法确定；没有 fork"),
        }
    }
    Ok((cutoff.map(|c| c.1), end))
}

/// A completed `/compact` as the session holds it: its summary an answer to
/// its own compaction message, its part one of that message's, the text it
/// kept of its summary's own parts.
fn compacted(compact: &Value, list: &[Value]) -> Result<()> {
    let find = |id: &Value| list.iter().find(|m| m["info"]["id"] == *id);
    let has = |message: &Value, part: &Value| message["parts"].as_array().into_iter().flatten().any(|p| p["id"] == *part);
    let message = find(&compact["message"]).context("压缩消息不在会话里")?;
    let summary = find(&compact["summary"]["id"]).context("压缩的总结不在会话里")?;
    ensure!(summary["info"]["role"] == "assistant" && summary["info"]["parentID"] == compact["message"], "压缩的总结不是它的回答");
    if !compact["part"].is_null() {
        ensure!(has(message, &compact["part"]), "压缩部分不是压缩消息的");
    }
    for part in compact["text"].as_object().into_iter().flatten().map(|(id, _)| json!(id)) {
        ensure!(has(summary, &part), "压缩记下的文字不是总结的");
    }
    Ok(())
}

/// A digest of messages as read: what a fork must be a copy of.
pub(crate) fn digest(value: &Value) -> Result<String> {
    use sha2::{Digest, Sha256};
    Ok(Sha256::digest(serde_json::to_vec(value)?).iter().map(|b| format!("{b:02x}")).collect())
}

/// Each source message and part ID, and the ID of its copy in the fork.
pub(crate) type Ids = BTreeMap<String, String>;

/// The fork's messages paired with `prefix`, the messages it copies (contract
/// 4): the map from each source message and part ID to its copy's. Refused
/// unless the fork is exactly OpenCode's copy of `prefix` under `session`:
/// as many messages, in order, each its source with a new ID and session, an
/// answer's `parentID` its parent's copy (OpenCode keeps an old one it did
/// not map: a reference out of the fork), each part its source with a new ID,
/// message and session, a compaction part's `tail_start_id` its copy; and no
/// new ID one of the source's.
pub(crate) fn pair(prefix: &[Value], fork: &[Value], session: &str) -> Result<Ids> {
    ensure!(fork.len() == prefix.len(), "fork 里有 {} 条消息，应为 {} 条；没有登记", fork.len(), prefix.len());
    let mut ids = Ids::new();
    let old: BTreeSet<&str> = prefix.iter().flat_map(|m| {
        std::iter::once(m["info"]["id"].as_str()).chain(m["parts"].as_array().into_iter().flatten().map(|p| p["id"].as_str()))
    }).flatten().collect();
    let fresh = |from: &Value, to: &Value, ids: &mut Ids| -> Result<String> {
        let (from, to) = (from.as_str().context("没有 ID")?, to.as_str().context("fork 的消息没有 ID")?);
        ensure!(!old.contains(to) && !ids.values().any(|v| v == to), "fork 用了已有的 ID {to}；没有登记");
        ids.insert(from.to_owned(), to.to_owned());
        Ok(to.to_owned())
    };
    for (source, copy) in prefix.iter().zip(fork) {
        let id = fresh(&source["info"]["id"], &copy["info"]["id"], &mut ids)?;
        let mut expected = source["info"].clone();
        expected["id"] = json!(id);
        expected["sessionID"] = json!(session);
        if expected["role"] == "assistant" {
            let parent = source["info"]["parentID"].as_str().unwrap_or_default();
            expected["parentID"] = json!(ids.get(parent).with_context(|| format!("回答 {} 答的消息不在 fork 里；没有登记", source["info"]["id"]))?);
        }
        ensure!(copy["info"] == expected, "fork 的消息 {id} 不是原消息 {} 的副本；没有登记", source["info"]["id"]);
        let (from, to) = (source["parts"].as_array().cloned().unwrap_or_default(), copy["parts"].as_array().cloned().unwrap_or_default());
        ensure!(from.len() == to.len(), "fork 的消息 {id} 少了或多了部分；没有登记");
        for (part, copied) in from.iter().zip(&to) {
            let new = fresh(&part["id"], &copied["id"], &mut ids)?;
            let mut expected = part.clone();
            expected["id"] = json!(new);
            expected["messageID"] = json!(id);
            expected["sessionID"] = json!(session);
            if part["type"] == "compaction" && part["tail_start_id"].is_string() {
                let tail = part["tail_start_id"].as_str().unwrap_or_default();
                expected["tail_start_id"] = json!(ids.get(tail).with_context(|| format!("压缩部分 {} 指向的消息不在 fork 里；没有登记", part["id"]))?);
            }
            ensure!(*copied == expected, "fork 的部分 {new} 不是原部分 {} 的副本；没有登记", part["id"]);
        }
    }
    Ok(ids)
}

/// The fork's own durable events, as `/sync/history` listed them, checked
/// to be exactly the fork read (contract 5): numbered 0 on with no gap, the
/// first its `session.created` under its own ID, then only its messages and
/// parts as `message.updated` and `message.part.updated`, which together make
/// `fork` (its messages as read) and nothing else. As they are replayed.
pub(crate) fn chain(events: &[Value], session: &str, info: &Value, fork: &[Value]) -> Result<Vec<Value>> {
    ensure!(!events.is_empty(), "OpenCode 没有这个 fork 的事件；没有登记");
    let mut ordered = events.to_vec();
    ordered.sort_by_key(|e| e["seq"].as_u64().unwrap_or(u64::MAX));
    for (index, event) in ordered.iter().enumerate() {
        ensure!(event["aggregate_id"] == session && event["seq"].as_u64() == Some(index as u64),
            "fork 的事件不是从 0 起连续编号的；没有登记");
        ensure!(event["id"].is_string() && event["data"]["sessionID"] == session, "fork 的事件 {index} 不属于这个 fork；没有登记");
    }
    let created = &ordered[0];
    ensure!(created["type"] == "session.created.1" && created["data"]["info"]["id"] == session,
        "fork 的第一个事件不是它的创建；没有登记");
    for name in ["directory", "projectID", "title"] {
        ensure!(created["data"]["info"][name] == info[name], "fork 创建时的 {name} 与读到的不同；没有登记");
    }
    ensure!(created["data"]["info"]["workspaceID"].as_str().unwrap_or_default().is_empty(), "fork 属于一个 OpenCode workspace；没有登记");
    let mut made: Vec<(String, Value, Vec<Value>)> = Vec::new();
    for event in &ordered[1..] {
        match event["type"].as_str() {
            Some("message.updated.1") => {
                let message = &event["data"]["info"];
                let id = message["id"].as_str().context("fork 的消息事件没有 ID")?;
                match made.iter_mut().find(|m| m.0 == id) {
                    Some(m) => m.1 = message.clone(),
                    None => made.push((id.to_owned(), message.clone(), Vec::new())),
                }
            }
            Some("message.part.updated.1") => {
                let part = &event["data"]["part"];
                let message = part["messageID"].as_str().context("fork 的部分事件没有消息")?;
                let m = made.iter_mut().find(|m| m.0 == message).context("fork 的部分事件早于它的消息；没有登记")?;
                match m.2.iter_mut().find(|p| p["id"] == part["id"]) {
                    Some(p) => *p = part.clone(),
                    None => m.2.push(part.clone()),
                }
            }
            _ => bail!("fork 的事件里有 {} ，不是 fork 写的；没有登记", event["type"]),
        }
    }
    let made: Vec<Value> = made.into_iter().map(|(_, info, parts)| json!({"info":info,"parts":parts})).collect();
    ensure!(made.len() == fork.len() && made.iter().zip(fork).all(|(m, f)| m["info"] == f["info"] && m["parts"] == f["parts"]),
        "fork 的事件与读到的 fork 不同；没有登记");
    Ok(ordered.into_iter().map(|e| json!({"id":e["id"],"aggregateID":e["aggregate_id"],"seq":e["seq"],"type":e["type"],"data":e["data"]})).collect())
}

/// What `/sync/history` is told it may leave out: every aggregate Core
/// knows besides the fork, up to the highest sequence number there is.
pub(crate) fn known(sessions: impl IntoIterator<Item = String>) -> Map<String, Value> {
    const SAFE: u64 = 9_007_199_254_740_991;
    sessions.into_iter().map(|s| (s, json!(SAFE))).collect()
}

/// Two folder answers (`GET /path`) and project IDs naming the same place:
/// a fork's target must keep its snapshots where its source does. Not its
/// state: each Agent's OpenCode keeps its data and state in the Agent's own
/// folder (T-32 slice 3a), so a fork's target has its own; where it finds its
/// source's snapshots on 2.x is the fork slice's to decide.
pub(crate) fn same_place(source: &(Value, String), target: &(Value, String)) -> Result<()> {
    for name in ["home", "config", "worktree", "directory"] {
        ensure!(source.0[name].is_string() && source.0[name] == target.0[name], "新 Agent 的 OpenCode 的 {name} 与原 Agent 的不同；没有登记");
    }
    ensure!(!source.1.is_empty() && source.1 == target.1, "新 Agent 的 OpenCode 的项目与原 Agent 的不同；没有登记");
    Ok(())
}
