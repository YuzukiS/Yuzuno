//! Opt-in, replaceable windows of saved conversation bodies. This is a client
//! projection, never a storage truncation. The lightweight Turn index remains
//! available for direct navigation; a cursor names stable IDs, not an offset.
use crate::{client_view::Missing, model::AgentDetail};
use serde::Deserialize;
use serde_json::{json, Value};

pub const MAX_ITEMS: usize = 96;
pub const MAX_BODY_BYTES: usize = 256 * 1024;
pub const MAX_ITEM_BYTES: usize = 32 * 1024;
/// At most this many running sub-agents, and apart this many running
/// background tasks, outside the window are listed, the newest of each; the
/// docks show fewer.
const MAX_RUNNING: usize = 32;
/// At most this many inputs a page of them lists (T-6), each with at most
/// this many bytes of its text.
pub const MAX_INPUTS: usize = 100;
const INPUT_PREVIEW: usize = 160;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub view: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
}

impl Query {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.view.as_deref().is_some_and(|v| v != "window") { return Err("Unknown conversation view"); }
        if usize::from(self.before.is_some()) + usize::from(self.after.is_some()) + usize::from(self.turn_id.is_some()) > 1 {
            return Err("Choose one conversation destination");
        }
        if self.item_id.is_some() && self.turn_id.is_none() { return Err("itemId needs turnId"); }
        for value in [&self.before, &self.after].into_iter().flatten() {
            if serde_json::from_str::<(String, Option<String>)>(value).is_err() { return Err("Invalid conversation cursor"); }
        }
        if self.view.is_none() && (self.before.is_some() || self.after.is_some() || self.turn_id.is_some()) {
            return Err("A conversation destination needs view=window");
        }
        Ok(())
    }
}

fn head(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) { end -= 1; }
    &text[..end]
}

/// Bounded plain text for previews and navigation, without copying a huge
/// string just to take its prefix. Message search below uses the same fields.
fn message_parts(item: &Value) -> Vec<&str> {
    if item["type"] == "userMessage" {
        if let Some(original) = item["_yuzunoInputText"].as_str() { return vec![original]; }
        item["content"].as_array().into_iter().flatten().filter_map(|v| v["text"].as_str()).collect()
    } else if item["type"] == "exitedReviewMode" {
        item["review"].as_str().into_iter().collect()
    } else {
        item["text"].as_str().into_iter().collect()
    }
}
fn excerpt(item: &Value, limit: usize) -> String {
    let mut text = String::new();
    for part in message_parts(item) {
        if !text.is_empty() && text.len() < limit { text.push('\n'); }
        text.push_str(head(part, limit.saturating_sub(text.len())));
        if text.len() >= limit { break; }
    }
    text
}

/// One explicit original-text entry also bounds pathological Markdown or one
/// huge structured item. The full saved item is available from /original.
pub fn bounded_item(item: &Value) -> Value {
    let bytes = serde_json::to_vec(item).map_or(0, |v| v.len());
    if bytes <= MAX_ITEM_BYTES { return item.clone(); }
    let mut out = preview(item);
    out["text"] = excerpt(item, 4096).into();
    out["_yuzunoWindowPreview"]["bytes"] = bytes.into();
    out
}

/// An Item whose body is not sent: what it is, and the facts that place it.
fn preview(item: &Value) -> Value {
    let mut out = json!({"id":item["id"],"type":"historyPreview","status":item["status"],"_yuzunoWindowPreview":{"type":item["type"]}});
    keep_task_facts(item, &mut out);
    out
}

/// A Claude sub-agent's call and its own calls stay where they belong, and
/// so does a background task's call; a goal and result are read with the
/// original.
fn keep_task_facts(item: &Value, out: &mut Value) {
    if let Some(parent) = item.get("parentToolUseId") {
        out["parentToolUseId"] = parent.clone();
    }
    for record in crate::claude::TASK_RECORDS {
        if let Some(sub) = item[record].as_object() {
            out["name"] = item["name"].clone();
            out[record] = sub.iter().filter(|(key, _)| !matches!(key.as_str(), "prompt" | "result" | "progress"))
                .map(|(key, value)| (key.clone(), value.clone())).collect::<serde_json::Map<_, _>>().into();
        }
    }
}

/// A page of `inputs`: the newest, or those before an input's cursor.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputsQuery {
    pub before: Option<String>,
    pub limit: Option<usize>,
}

/// The inputs a person wrote or may have, to read the conversation by them
/// (T-6): each user message `input_origin` marked one of its `HUMAN` or
/// `unconfirmed`, oldest first, by Turn and Item ID (as a cursor names it),
/// `[Turn, Item]` position and the start of its text. A page of at most
/// `MAX_INPUTS` ending before the input `before` names, or at the newest;
/// `total` counts them all. `turns` is a sparse index (`record_rows::window::
/// sparse`): only its listed Items, at positions `ords`, are read.
pub(crate) fn inputs(turns: &[Value], ords: &[Vec<usize>], query: &InputsQuery) -> Result<Value, Missing> {
    let listed: Vec<(usize, usize, &Value)> = turns.iter().enumerate()
        .flat_map(|(t, turn)| turn["items"].as_array().into_iter().flatten().zip(&ords[t]).map(move |(item, &i)| (t, i, item)))
        .filter(|(_, _, item)| item["type"] == "userMessage" && item["_yuzunoInput"].as_str().is_some_and(crate::input_origin::navigable))
        .collect();
    let end = match &query.before {
        None => listed.len(),
        Some(cursor) => {
            let (turn, item): (String, Option<String>) = serde_json::from_str(cursor).map_err(|_| Missing::Item)?;
            listed.iter().position(|(t, _, entry)| turns[*t]["id"] == turn && entry["id"].as_str() == item.as_deref())
                .ok_or(Missing::Item)?
        }
    };
    let start = end.saturating_sub(query.limit.unwrap_or(MAX_INPUTS).clamp(1, MAX_INPUTS));
    let page: Vec<Value> = listed[start..end].iter().map(|(t, i, item)| json!({"turnId":turns[*t]["id"],"itemId":item["id"],
        "position":[t, i],"by":item["_yuzunoInput"],"preview":excerpt(item, INPUT_PREVIEW)})).collect();
    Ok(json!({"inputs":page,"hasBefore":start > 0,"total":listed.len()}))
}

pub(crate) fn turn_shell(turn: &Value) -> Value {
    let mut out = Value::Object(turn.as_object().into_iter().flatten()
        .filter(|(key, _)| key.as_str() != "items").map(|(key, value)| (key.clone(), value.clone())).collect());
    out["items"] = json!([]);
    out
}

/// Only the fields used by the complete navigation/attention index. The text
/// markers on assistant items are for choosing the rail's source, not bodies.
pub(crate) fn item_index(item: &Value) -> Value {
    let mut out = json!({"id":item["id"], "type":item["type"]});
    if item["type"] == "userMessage" {
        for key in ["clientId", "_yuzunoSource"] {
            if let Some(value) = item.get(key) { out[key] = value.clone(); }
        }
        out["content"] = json!([{"type":"text", "text":excerpt(item, 256)}]);
    } else if item["type"] == "agentMessage" {
        for key in ["text", "_yuzunoCompletedText"] {
            if item[key].as_str().is_some_and(|s| !s.trim().is_empty()) { out[key] = "present".into(); }
        }
        if item["delivery"] == "async" && item["questions"].as_array().is_some_and(|q| !q.is_empty()) {
            for key in ["delivery", "status", "questions"] { out[key] = item[key].clone(); }
        }
    } else {
        // A sub-agent's or a background task's call: listed while it runs,
        // wherever the window is.
        for record in crate::claude::TASK_RECORDS {
            if let Some(status) = item[record].get("status") { out[record] = json!({"status":status}); }
        }
    }
    out
}

pub(crate) fn header(detail: &AgentDetail) -> AgentDetail {
    // Exhaustive: adding a record field must also preserve it here.
    let AgentDetail { agent, turns: _, history, pending, artifacts, context_usage,
        message_receipts, claude_runtime, codex_handoff, opencode_usage_seen } = detail;
    AgentDetail { agent:agent.clone(), turns:Vec::new(), history:history.clone(),
        pending:pending.clone(), artifacts:artifacts.clone(), context_usage:context_usage.clone(),
        message_receipts:message_receipts.clone(), claude_runtime:claude_runtime.clone(), codex_handoff:codex_handoff.clone(),
        opencode_usage_seen:opencode_usage_seen.clone() }
}

pub fn project(detail: &mut AgentDetail, query: &Query) -> Result<Value, Missing> {
    let (turns, metadata) = project_from(&detail.turns, query, |t, i| Ok(detail.turns[t]["items"][i].clone()))
        .expect("in-memory body read cannot fail")?;
    detail.turns = turns;
    Ok(metadata)
}

/// The same projection for borrowed records and persisted indexes. Only the
/// body candidates are loaded; all navigation and attention metadata stays.
pub(crate) fn project_from(
    turns: &[Value], query: &Query,
    mut read: impl FnMut(usize, usize) -> anyhow::Result<Value>,
) -> anyhow::Result<Result<(Vec<Value>, Value), Missing>> {
    let index: Vec<Value> = turns.iter().enumerate().map(|(number, turn)| {
        let users: Vec<_> = turn["items"].as_array().into_iter().flatten().filter(|item| item["type"] == "userMessage").collect();
        let mut previews: Vec<_> = users.first().copied().into_iter().collect();
        if users.len() > 1 { previews.push(users[users.len()-1]); }
        json!({"id":turn["id"],"status":turn["status"],"_yuzunoSource":turn["_yuzunoSource"],
            "number":number + 1,"_yuzunoIndex":true,"_yuzunoRequestCount":users.len(),"itemCount":turn["items"].as_array().map_or(0, Vec::len),
            "items":previews.into_iter().map(|item| json!({"id":item["id"],"type":"userMessage","_yuzunoSource":item["_yuzunoSource"],
                "content":[{"type":"text","text":excerpt(item,256)}]})).collect::<Vec<_>>()})
    }).collect();
    // Attention and delivery state is independent of the body page, just as
    // RPC approvals are. Keep question definitions, never their reply bodies.
    let questions: Vec<Value> = turns.iter().filter_map(|turn| {
        let items: Vec<Value> = turn["items"].as_array().into_iter().flatten()
            .filter(|i| i["type"] == "agentMessage" && i["delivery"] == "async" && i["questions"].as_array().is_some_and(|q|!q.is_empty()))
            .map(|i| json!({"id":i["id"],"type":"agentMessage","delivery":"async","status":i["status"],"questions":i["questions"]})).collect();
        (!items.is_empty()).then(||json!({"id":turn["id"],"status":turn["status"],"_yuzunoImportedQuestions":turn["_yuzunoImportedQuestions"],"items":items}))
    }).collect();
    let native_client_ids: Vec<&str> = turns.iter().flat_map(|t|t["items"].as_array().into_iter().flatten())
        .filter(|i|i["type"] == "userMessage").filter_map(|i|i["clientId"].as_str()).collect();
    // Empty turns have a position too, so error/compaction-only turns remain
    // reachable and paging can always make progress.
    let positions: Vec<(usize, Option<usize>)> = turns.iter().enumerate().flat_map(|(t, turn)| {
        let n = turn["items"].as_array().map_or(0, Vec::len);
        (0..n.max(1)).map(move |i| (t, (n > 0).then_some(i)))
    }).collect();
    let cursor = |position: usize| {
        let (t, i) = positions[position];
        serde_json::to_string(&(turns[t]["id"].as_str().unwrap_or_default(), i.and_then(|i| turns[t]["items"][i]["id"].as_str()))).unwrap()
    };
    let find_cursor = |value: &str| -> Result<usize, Missing> {
        let (turn_id, item_id): (String, Option<String>) = serde_json::from_str(value).map_err(|_| Missing::Item)?;
        positions.iter().position(|&(t, i)| turns[t]["id"] == turn_id
            && i.and_then(|i| turns[t]["items"][i]["id"].as_str()) == item_id.as_deref()).ok_or(Missing::Item)
    };
    let destination = || -> Result<(usize, bool), Missing> { Ok(if let Some(before) = &query.before {
        // One overlapping item provides a stable reading anchor on page change.
        (find_cursor(before)?, true)
    } else if let Some(after) = &query.after {
        (find_cursor(after)?, false)
    } else if let Some(turn_id) = &query.turn_id {
        let t = turns.iter().position(|t| t["id"] == *turn_id).ok_or(Missing::Turn)?;
        let at = positions.iter().position(|&(n, i)| n == t && query.item_id.as_ref().is_none_or(|id|
            i.is_some_and(|i| turns[t]["items"][i]["id"] == *id))).ok_or(Missing::Item)?;
        (at, false)
    } else { (positions.len().saturating_sub(1), true) }) };
    let (anchor, reverse) = match destination() { Ok(at) => at, Err(missing) => return Ok(Err(missing)) };
    let mut chosen = Vec::new();
    let mut bytes = 0;
    for offset in 0..MAX_ITEMS {
        let at = if reverse { anchor.checked_sub(offset) } else { anchor.checked_add(offset) };
        let Some(at) = at.filter(|&at| at < positions.len()) else { break };
        let (t, i) = positions[at];
        let item = i.map(|i| read(t, i).map(|item| bounded_item(&item))).transpose()?;
        let size = item.as_ref().map_or(0, |i| serde_json::to_vec(i).unwrap().len());
        if !chosen.is_empty() && bytes + size > MAX_BODY_BYTES { break; }
        bytes += size;
        chosen.push((at, item));
    }
    chosen.sort_unstable_by_key(|(at, _)| *at);
    let start = chosen.first().map(|(at, _)| *at);
    let end = chosen.last().map(|(at, _)| *at);
    // A Claude sub-agent or background task (a shell, a monitor) still
    // running is attention state too: either outlives the Items after its
    // call, and the window holds the newest only. Each call's preview, from
    // its body as sent, in order; one pass lists both, apart.
    let shown: std::collections::HashSet<usize> = chosen.iter().map(|(at, _)| *at).collect();
    let (mut sub_agents, mut background) = (Vec::new(), Vec::new());
    for (at, &(t, i)) in positions.iter().enumerate().rev() {
        if sub_agents.len() == MAX_RUNNING && background.len() == MAX_RUNNING { break; }
        let Some(i) = i.filter(|_| !shown.contains(&at)) else { continue };
        let item = &turns[t]["items"][i];
        let list = if crate::claude::subagent_running(&item["subAgent"]) {
            &mut sub_agents
        } else if crate::claude::subagent_running(&item["backgroundTask"]) {
            &mut background
        } else {
            continue;
        };
        if list.len() < MAX_RUNNING {
            list.push(json!({"turnId":turns[t]["id"],"position":[t, i],"item":preview(&read(t, i)?)}));
        }
    }
    sub_agents.reverse();
    background.reverse();
    let metadata = json!({"index":index,"questions":questions,"runningSubAgents":sub_agents,"runningBackgroundTasks":background,
        "nativeClientIds":native_client_ids,"start":start.map(cursor),"end":end.map(cursor),
        "hasBefore":start.is_some_and(|i| i > 0),"hasAfter":end.is_some_and(|i| i + 1 < positions.len()),
        "totalItems":turns.iter().map(|t| t["items"].as_array().map_or(0, Vec::len)).sum::<usize>()});
    let mut selected: Vec<Value> = Vec::new();
    let mut previous = None;
    for (at, item) in chosen {
        let (t, i) = positions[at];
        if previous != Some(t) {
            let mut turn = turn_shell(&turns[t]);
            turn["_yuzunoSlice"] = json!({"start":i.unwrap_or(0),"total":turns[t]["items"].as_array().map_or(0,Vec::len),"index":t});
            selected.push(turn);
            previous = Some(t);
        }
        if let Some(item) = item { selected.last_mut().unwrap()["items"].as_array_mut().unwrap().push(item); }
    }
    Ok(Ok((selected, metadata)))
}

/// `project_from` of a stored conversation without all its Items (T-140):
/// `turns` hold as Items only those every window lists (user messages,
/// async questions, running tasks), `ords` their positions and `counts`
/// each Turn's Items. `id_at` gives the ID of the Item at a position (for a
/// cursor), `position` that of an Item by ID in a Turn, `read` an Item's
/// body; only the Items shown and their neighbours are read. The same
/// window and metadata as `project_from` of the whole conversation.
#[allow(clippy::too_many_arguments)]
pub(crate) fn project_marked(
    turns: &[Value], ords: &[Vec<usize>], counts: &[usize], query: &Query,
    mut position: impl FnMut(usize, &str) -> anyhow::Result<Option<usize>>,
    mut read: impl FnMut(usize, usize) -> anyhow::Result<Value>,
) -> anyhow::Result<Result<(Vec<Value>, Value), Missing>> {
    let listed = |t: usize| turns[t]["items"].as_array().map(Vec::as_slice).unwrap_or_default();
    let index: Vec<Value> = turns.iter().enumerate().map(|(number, turn)| {
        let users: Vec<_> = listed(number).iter().filter(|item| item["type"] == "userMessage").collect();
        let mut previews: Vec<_> = users.first().copied().into_iter().collect();
        if users.len() > 1 { previews.push(users[users.len()-1]); }
        json!({"id":turn["id"],"status":turn["status"],"_yuzunoSource":turn["_yuzunoSource"],
            "number":number + 1,"_yuzunoIndex":true,"_yuzunoRequestCount":users.len(),"itemCount":counts[number],
            "items":previews.into_iter().map(|item| json!({"id":item["id"],"type":"userMessage","_yuzunoSource":item["_yuzunoSource"],
                "content":[{"type":"text","text":excerpt(item,256)}]})).collect::<Vec<_>>()})
    }).collect();
    let questions: Vec<Value> = turns.iter().enumerate().filter_map(|(t, turn)| {
        let items: Vec<Value> = listed(t).iter()
            .filter(|i| i["type"] == "agentMessage" && i["delivery"] == "async" && i["questions"].as_array().is_some_and(|q|!q.is_empty()))
            .map(|i| json!({"id":i["id"],"type":"agentMessage","delivery":"async","status":i["status"],"questions":i["questions"]})).collect();
        (!items.is_empty()).then(||json!({"id":turn["id"],"status":turn["status"],"_yuzunoImportedQuestions":turn["_yuzunoImportedQuestions"],"items":items}))
    }).collect();
    let native_client_ids: Vec<&str> = (0..turns.len()).flat_map(|t| listed(t).iter())
        .filter(|i|i["type"] == "userMessage").filter_map(|i|i["clientId"].as_str()).collect();
    // Positions as `project_from` numbers them, from the Item counts: an
    // empty Turn takes one.
    let mut starts = Vec::with_capacity(turns.len());
    let mut total = 0;
    for n in counts {
        starts.push(total);
        total += (*n).max(1);
    }
    let at = |position: usize| -> (usize, Option<usize>) {
        let t = starts.partition_point(|start| *start <= position) - 1;
        (t, (counts[t] > 0).then(|| position - starts[t]))
    };
    let start_of = |t: usize, i: Option<usize>| starts[t] + i.unwrap_or(0);
    let mut find_cursor = |value: &str| -> anyhow::Result<Result<usize, Missing>> {
        let Ok((turn_id, item_id)) = serde_json::from_str::<(String, Option<String>)>(value) else { return Ok(Err(Missing::Item)) };
        let Some(t) = turns.iter().position(|t| t["id"] == turn_id) else { return Ok(Err(Missing::Item)) };
        Ok(match item_id {
            Some(item) => match position(t, &item)? { Some(i) => Ok(start_of(t, Some(i))), None => Err(Missing::Item) },
            None if counts[t] == 0 => Ok(start_of(t, None)),
            None => Err(Missing::Item),
        })
    };
    let destination = if let Some(before) = &query.before {
        // One overlapping item provides a stable reading anchor on page change.
        find_cursor(before)?.map(|at| (at, true))
    } else if let Some(after) = &query.after {
        find_cursor(after)?.map(|at| (at, false))
    } else if let Some(turn_id) = &query.turn_id {
        match turns.iter().position(|t| t["id"] == *turn_id) {
            None => Err(Missing::Turn),
            Some(t) => match &query.item_id {
                None => Ok((start_of(t, None), false)),
                Some(item) => match position(t, item)? { Some(i) => Ok((start_of(t, Some(i)), false)), None => Err(Missing::Item) },
            },
        }
    } else { Ok((total.saturating_sub(1), true)) };
    let (anchor, reverse) = match destination { Ok(found) => found, Err(missing) => return Ok(Err(missing)) };
    let mut chosen = Vec::new();
    let mut ids = std::collections::HashMap::new();
    let mut bytes = 0;
    for offset in 0..MAX_ITEMS {
        let place = if reverse { anchor.checked_sub(offset) } else { anchor.checked_add(offset) };
        let Some(place) = place.filter(|&place| place < total) else { break };
        let (t, i) = at(place);
        let item = match i {
            Some(i) => {
                let body = read(t, i)?;
                ids.insert(place, body["id"].clone());
                Some(bounded_item(&body))
            }
            None => None,
        };
        let size = item.as_ref().map_or(0, |i| serde_json::to_vec(i).unwrap().len());
        if !chosen.is_empty() && bytes + size > MAX_BODY_BYTES { break; }
        bytes += size;
        chosen.push((place, item));
    }
    chosen.sort_unstable_by_key(|(place, _)| *place);
    let cursor = |place: usize| {
        let (t, _) = at(place);
        serde_json::to_string(&(turns[t]["id"].as_str().unwrap_or_default(), ids.get(&place).and_then(Value::as_str))).unwrap()
    };
    let start = chosen.first().map(|(place, _)| *place);
    let end = chosen.last().map(|(place, _)| *place);
    // Running sub-agents and background tasks outside the window, newest
    // first, as `project_from` lists them.
    let shown: std::collections::HashSet<usize> = chosen.iter().map(|(place, _)| *place).collect();
    let (mut sub_agents, mut background) = (Vec::new(), Vec::new());
    'turns: for t in (0..turns.len()).rev() {
        for (k, entry) in listed(t).iter().enumerate().rev() {
            if sub_agents.len() == MAX_RUNNING && background.len() == MAX_RUNNING { break 'turns; }
            let i = ords[t][k];
            if shown.contains(&start_of(t, Some(i))) { continue; }
            let list = if crate::claude::subagent_running(&entry["subAgent"]) {
                &mut sub_agents
            } else if crate::claude::subagent_running(&entry["backgroundTask"]) {
                &mut background
            } else {
                continue;
            };
            if list.len() < MAX_RUNNING {
                list.push(json!({"turnId":turns[t]["id"],"position":[t, i],"item":preview(&read(t, i)?)}));
            }
        }
    }
    sub_agents.reverse();
    background.reverse();
    let metadata = json!({"index":index,"questions":questions,"runningSubAgents":sub_agents,"runningBackgroundTasks":background,
        "nativeClientIds":native_client_ids,"start":start.map(&cursor),"end":end.map(&cursor),
        "hasBefore":start.is_some_and(|i| i > 0),"hasAfter":end.is_some_and(|i| i + 1 < total),
        "totalItems":counts.iter().sum::<usize>()});
    let mut selected: Vec<Value> = Vec::new();
    let mut previous = None;
    for (place, item) in chosen {
        let (t, i) = at(place);
        if previous != Some(t) {
            let mut turn = turn_shell(&turns[t]);
            turn["_yuzunoSlice"] = json!({"start":i.unwrap_or(0),"total":counts[t],"index":t});
            selected.push(turn);
            previous = Some(t);
        }
        if let Some(item) = item { selected.last_mut().unwrap()["items"].as_array_mut().unwrap().push(item); }
    }
    Ok(Ok((selected, metadata)))
}

pub fn original_turn(detail: &AgentDetail, turn_id: &str) -> Result<Value, Missing> {
    detail.turns.iter().find(|t| t["id"] == turn_id).cloned().ok_or(Missing::Turn)
}
pub fn original_item(detail: &AgentDetail, turn_id: Option<&str>, item_id: &str) -> Result<Value, Missing> {
    detail.turns.iter().rev().filter(|t| turn_id.is_none_or(|id| t["id"] == id))
        .find_map(|t| t["items"].as_array()?.iter().find(|i| i["id"] == item_id)).cloned().ok_or(Missing::Item)
}

/// Saved message search is independent of loaded/mounted windows. Literal
/// matching, 50 results and bounded snippets; tool output is excluded.
pub fn search(detail: &AgentDetail, query: &str) -> Vec<Value> {
    let Some(mut search) = Search::new(query) else { return Vec::new() };
    for (number, turn) in detail.turns.iter().enumerate() {
        for item in turn["items"].as_array().into_iter().flatten() {
            if Search::reads(item) && !search.item(number, &turn["id"], item) { return search.results; }
        }
    }
    search.results
}

/// `search`, an Item at a time, for a caller that reads Items one by one
/// (`Store::conversation_search`).
pub(crate) struct Search {
    needle: String,
    pub(crate) results: Vec<Value>,
}

impl Search {
    /// None for a query `search` finds nothing for (blank, or over 256 bytes).
    pub(crate) fn new(query: &str) -> Option<Self> {
        let query = query.trim();
        if query.is_empty() || query.len() > 256 { return None; }
        Some(Self { needle: query.to_lowercase(), results: Vec::new() })
    }

    /// Whether `search` reads this Item: a user or assistant message.
    pub(crate) fn reads(item: &Value) -> bool {
        matches!(item["type"].as_str(), Some("userMessage" | "agentMessage"))
    }

    /// Searches message `item` of the Turn at `number` (from 0) with ID
    /// `turn`. False once there are 50 results.
    pub(crate) fn item(&mut self, number: usize, turn: &Value, item: &Value) -> bool {
        for part in message_parts(item) {
            // Lowercasing may change byte lengths. Build offsets back into
            // the original only for the first match, never slice with an
            // offset from the folded string.
            let folded = part.to_lowercase();
            let Some(at) = folded.find(&self.needle) else { continue };
            let mut folded_at = 0;
            let mut start = 0;
            let mut end = part.len();
            for (byte, ch) in part.char_indices() {
                if folded_at <= at { start = byte; }
                if folded_at >= at + self.needle.len() { end = byte; break; }
                folded_at += ch.to_lowercase().map(char::len_utf8).sum::<usize>();
            }
            let before: String = part[..start].chars().rev().take(70).collect::<Vec<_>>().into_iter().rev().collect();
            let after: String = part[end..].chars().take(110).collect();
            self.results.push(json!({"turnId":turn,"itemId":item["id"],"turnNumber":number + 1,
                "role":if item["type"] == "userMessage" { "user" } else if item["phase"] == "commentary" { "progress" } else { "assistant" },
                "before":before,"match":&part[start..end],"after":after}));
            break;
        }
        self.results.len() < 50
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(turns: Vec<Value>) -> AgentDetail {
        serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage",
            "status":"idle","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":turns,"pending":[],"artifacts":[]})).unwrap()
    }
    fn giant(n: usize) -> AgentDetail {
        record(vec![json!({"id":"giant","status":"completed","items":(0..n).map(|i|
            json!({"id":format!("i{i}"),"type":"agentMessage","text":format!("message {i}")})).collect::<Vec<_>>()})])
    }
    #[test]
    fn pages_cover_a_giant_turn_and_direct_target_without_truncating_storage() {
        let saved = giant(1001);
        let mut page = saved.clone();
        let mut meta = project(&mut page, &Query::default()).unwrap();
        assert_eq!(page.turns[0]["items"].as_array().unwrap().len(), MAX_ITEMS);
        assert_eq!(page.turns[0]["items"][MAX_ITEMS-1]["id"], "i1000");
        assert_eq!(page.turns[0]["_yuzunoSlice"]["start"], 905);
        let mut found = std::collections::HashSet::new();
        loop {
            for item in page.turns[0]["items"].as_array().unwrap() { found.insert(item["id"].as_str().unwrap().to_owned()); }
            if meta["hasBefore"] != true { break; }
            let cursor = meta["start"].as_str().unwrap().to_owned();
            page = saved.clone();
            meta = project(&mut page, &Query {before:Some(cursor),..Default::default()}).unwrap();
        }
        assert_eq!(found.len(),1001);
        let mut target = saved.clone();
        let meta = project(&mut target, &Query {turn_id:Some("giant".into()),item_id:Some("i500".into()),..Default::default()}).unwrap();
        assert_eq!(target.turns[0]["items"][0]["id"],"i500");
        assert_eq!(meta["hasAfter"],true);
        assert_eq!(original_turn(&saved,"giant").unwrap()["items"].as_array().unwrap().len(),1001);
    }
    #[test]
    fn size_limit_and_huge_single_item_have_explicit_originals() {
        let original = json!({"id":"large","type":"agentMessage","text":"🐈 heading\n".repeat(100_000)});
        let saved = record(vec![json!({"id":"t","items":[original.clone()]})]);
        let mut view = saved.clone();
        project(&mut view,&Query::default()).unwrap();
        let item = &view.turns[0]["items"][0];
        assert_eq!(item["type"],"historyPreview");
        assert!(serde_json::to_vec(item).unwrap().len()<8192);
        assert_eq!(original_item(&saved,Some("t"),"large").unwrap(),original);
        let mut many = record(vec![json!({"id":"t","items":(0..100).map(|i|json!({"id":format!("i{i}"),"type":"agentMessage","text":"x".repeat(20000)})).collect::<Vec<_>>()})]);
        let meta = project(&mut many,&Query::default()).unwrap();
        assert!(serde_json::to_vec(&many.turns[0]["items"]).unwrap().len()<MAX_BODY_BYTES);
        assert_eq!(meta["hasBefore"],true);
    }
    #[test]
    fn a_huge_subagent_call_keeps_who_it_belongs_to() {
        let huge = "x".repeat(40_000);
        let call = json!({"id":"agent","type":"claudeToolUse","name":"Agent","status":"completed","input":{"prompt":huge},
            "subAgent":{"status":"completed","taskId":"task","prompt":huge,"result":"done"}});
        let child = json!({"id":"read","type":"claudeToolUse","name":"Read","status":"completed","parentToolUseId":"agent","output":huge});
        let (call, child) = (bounded_item(&call), bounded_item(&child));
        assert_eq!((call["type"].clone(), call["name"].clone(), call["subAgent"].clone()),
            (json!("historyPreview"), json!("Agent"), json!({"status":"completed","taskId":"task"})));
        assert_eq!((child["type"].clone(), child["parentToolUseId"].clone()), (json!("historyPreview"), json!("agent")));
        let shell = bounded_item(&json!({"id":"bash","type":"claudeToolUse","name":"Bash","status":"completed","input":{"command":huge},
            "backgroundTask":{"status":"stopped","taskId":"b1","type":"local_bash","result":"done"}}));
        assert_eq!((shell["name"].clone(), shell["backgroundTask"].clone()),
            (json!("Bash"), json!({"status":"stopped","taskId":"b1","type":"local_bash"})));
    }
    #[test]
    fn empty_turns_ids_and_errors_remain_reachable() {
        let mut detail = record(vec![json!({"id":"empty","status":"failed","error":{"message":"failed"},"items":[]}),json!({"id":"t","items":[]})]);
        let meta = project(&mut detail,&Query {turn_id:Some("empty".into()),..Default::default()}).unwrap();
        assert_eq!(detail.turns.len(),2);
        assert_eq!(detail.turns[0]["error"]["message"],"failed");
        assert_eq!(meta["index"].as_array().unwrap().len(),2);
        assert!(Query {view:Some("window".into()),before:Some("bad".into()),..Default::default()}.validate().is_err());
        assert_eq!(project(&mut detail,&Query {turn_id:Some("missing".into()),..Default::default()}),Err(Missing::Turn));
    }
    #[test]
    fn search_finds_unloaded_text_and_keeps_unicode_offsets() {
        let mut saved = giant(1001);
        saved.turns[0]["items"][0]["text"] = json!("İ猫 hello 🐈 WORLD final");
        let matches = search(&saved,"world");
        assert_eq!(matches.len(),1);
        assert_eq!(matches[0]["itemId"],"i0");
        assert_eq!(matches[0]["match"],"WORLD");
        assert_eq!(matches[0]["before"],"İ猫 hello 🐈 ");
        assert_eq!(search(&saved,"message").len(),50);
        assert_eq!(search(&saved,"İ")[0]["match"],"İ");
        saved.turns[0]["items"][0] = json!({"id":"pasted","type":"userMessage",
            "content":[{"type":"text","text":"Native transformed body"}],
            "_yuzunoInputText":"Exact submitted paste with original source"});
        assert_eq!(search(&saved,"submitted paste")[0]["itemId"],"pasted");
        assert!(search(&saved,"transformed body").is_empty());
    }
    #[test]
    fn questions_and_delivery_identity_survive_body_eviction() {
        let mut saved = giant(400);
        saved.turns[0]["items"][0] = json!({"id":"question","type":"agentMessage","delivery":"async","text":"large body".repeat(10000),"questions":[{"title":"Pick a path","options":["A","B"]}]});
        saved.turns[0]["items"][1] = json!({"id":"user","type":"userMessage","clientId":"confirmed","_yuzunoSource":"peer","content":[{"type":"text","text":"reminder"}]});
        let metadata = project(&mut saved,&Query::default()).unwrap();
        assert!(!saved.turns[0]["items"].as_array().unwrap().iter().any(|i|i["id"] == "question"));
        assert_eq!(metadata["questions"][0]["items"][0]["questions"][0]["title"],"Pick a path");
        assert!(metadata["questions"][0]["items"][0].get("text").is_none());
        assert_eq!(metadata["nativeClientIds"],json!(["confirmed"]));
        assert_eq!(metadata["index"][0]["items"][0]["_yuzunoSource"],"peer");
    }
    /// T-26: a background sub-agent outlives the Items after its call, and a
    /// window holds the newest only. One still running stays listed, as its
    /// call's preview, wherever the window is; one that ended or whose end
    /// is unknown is history like any other Item.
    #[test]
    fn running_subagents_outside_the_window_stay_listed() {
        let mut saved = giant(200);
        let call = |id: &str, status: &str| json!({"id":id,"type":"claudeToolUse","name":"Agent","status":"completed",
            "input":{"description":id,"prompt":"Do: the goal","run_in_background":true},"output":[{"type":"text","text":"Async agent launched"}],
            "subAgent":{"status":status,"background":true,"description":id,"prompt":"Do: the goal","progress":"p","result":"r","taskId":format!("task-{id}")}});
        let items = saved.turns[0]["items"].as_array_mut().unwrap();
        items[1] = call("early", "running");
        items[2] = call("done", "completed");
        items[3] = call("lost", "unknown");
        items[150] = call("later", "running");
        let listed = |id: &str, at: usize| json!({"turnId":"giant","position":[0,at],"item":{"id":id,"type":"historyPreview","status":"completed",
            "name":"Agent","_yuzunoWindowPreview":{"type":"claudeToolUse"},"subAgent":{"status":"running","background":true,"description":id,"taskId":format!("task-{id}")}}});
        let mut latest = saved.clone();
        let metadata = project(&mut latest, &Query::default()).unwrap();
        let loaded = |d: &AgentDetail, id: &str| d.turns[0]["items"].as_array().unwrap().iter().any(|i| i["id"] == id);
        assert!(!loaded(&latest, "early") && loaded(&latest, "later"));
        assert_eq!(metadata["runningSubAgents"], json!([listed("early", 1)]));
        // Reading from the first: the later one is outside it now.
        let mut first = saved.clone();
        let metadata = project(&mut first, &Query {turn_id:Some("giant".into()),item_id:Some("early".into()),..Default::default()}).unwrap();
        assert!(loaded(&first, "early") && !loaded(&first, "later"));
        assert_eq!(metadata["runningSubAgents"], json!([listed("later", 150)]));
    }
    /// T-25: a background shell or monitor outlives the Items after its call
    /// as a sub-agent does. One still running, starting or paused stays
    /// listed, apart from sub-agents, as its call's preview, wherever the
    /// window is; one that ended or whose end is unknown is history.
    #[test]
    fn running_background_tasks_outside_the_window_stay_listed() {
        let mut saved = giant(200);
        let call = |id: &str, name: &str, status: &str| json!({"id":id,"type":"claudeToolUse","name":name,"status":"completed",
            "input":{"command":format!("watch {id}"),"run_in_background":true},"output":[{"type":"text","text":"Running in the background"}],
            "backgroundTask":{"status":status,"background":true,"type":"local_bash","description":id,"result":"r","progress":"p","taskId":format!("task-{id}")}});
        let items = saved.turns[0]["items"].as_array_mut().unwrap();
        items[1] = call("shell", "Bash", "running");
        items[2] = call("watch", "Monitor", "paused");
        items[3] = call("done", "Bash", "completed");
        items[4] = call("lost", "Bash", "unknown");
        items[5] = call("halted", "Bash", "stopped");
        items[150] = call("later", "Bash", "running");
        let listed = |id: &str, name: &str, status: &str, at: usize| json!({"turnId":"giant","position":[0,at],"item":{"id":id,
            "type":"historyPreview","status":"completed","name":name,"_yuzunoWindowPreview":{"type":"claudeToolUse"},
            "backgroundTask":{"status":status,"background":true,"type":"local_bash","description":id,"taskId":format!("task-{id}")}}});
        let mut latest = saved.clone();
        let metadata = project(&mut latest, &Query::default()).unwrap();
        let loaded = |d: &AgentDetail, id: &str| d.turns[0]["items"].as_array().unwrap().iter().any(|i| i["id"] == id);
        assert!(!loaded(&latest, "shell") && loaded(&latest, "later"));
        assert_eq!(metadata["runningBackgroundTasks"], json!([listed("shell", "Bash", "running", 1), listed("watch", "Monitor", "paused", 2)]));
        assert_eq!(metadata["runningSubAgents"], json!([]));
        // Reading from the first: the later one is outside it now.
        let mut first = saved.clone();
        let metadata = project(&mut first, &Query {turn_id:Some("giant".into()),item_id:Some("shell".into()),..Default::default()}).unwrap();
        assert!(loaded(&first, "shell") && !loaded(&first, "later"));
        assert_eq!(metadata["runningBackgroundTasks"], json!([listed("later", "Bash", "running", 150)]));
    }
}
