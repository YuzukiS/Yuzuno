//! What clients receive of an Agent record.
//!
//! Tool output, diffs and tool results are most of a long-lived record (often
//! megabytes) but are shown collapsed. The detail API sends each record
//! through `detail`; Items and Turns pushed to clients one at a time go
//! through `item` and `turn`. A field over TRIM_ABOVE becomes a preview of
//! the same shape within PREVIEW bytes, and `_yuzunoTruncated` records its
//! full size. `item_payload` and `turn_payload` return the full values.
//!
//! Codex history pages (/api/agents/{id}/history) are not projected: their
//! Items come from Codex rather than the record, so their full values could
//! not be served later.
//!
//! The stored record is never changed. Server-side readers (rail, Catch-up,
//! collaboration) keep reading it in full; only the client boundary trims.
use crate::model::{AgentDetail, PendingRequest};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

/// A field larger than this is trimmed. Smaller fields ship whole, so most
/// tool rows never need a second request.
pub const TRIM_ABOVE: usize = 8 * 1024;
/// The most a preview keeps: about 90 lines of command output in real
/// records, enough for a test summary or a compiler error.
pub const PREVIEW: usize = 4 * 1024;
/// Item annotation: each trimmed field, its full size and which end the
/// preview keeps, e.g. {"aggregatedOutput":{"bytes":69025,"lines":812,"keep":"tail"}}.
/// `bytes` is a string's UTF-8 length; for an array or object it is its
/// compact JSON size without escapes. `lines` is given for strings. A file
/// change preview adds `omitted` (changes left out) and `cutDiffs` (indexes
/// of kept changes whose diff is shortened or empty in the preview).
pub const TRUNCATED: &str = "_yuzunoTruncated";
/// Inside a structured preview, members up to this size stay whole when they
/// fit (a path, a kind, a flag, a short description).
const SMALL: usize = 512;

#[derive(Clone, Copy)]
enum Keep {
    Head,
    Tail,
}

impl Keep {
    fn name(self) -> &'static str {
        match self {
            Keep::Head => "head",
            Keep::Tail => "tail",
        }
    }
}

/// Items always sent whole: conversation text (search, copy, the reply view
/// and Catch-up read it, and it is a small share of a record), Codex's
/// review result (its Turn's reply), and a file change still in progress,
/// which is what a Codex approval asks the user to review. Stored records
/// keep these whole too (`record_rows`); one stored trimmed before is read
/// back by its annotation as ever.
pub(crate) fn whole(item: &Value) -> bool {
    matches!(item["type"].as_str(), Some("userMessage" | "agentMessage" | "reasoning" | "plan" | "exitedReviewMode"))
        || (item["type"] == "fileChange" && item["status"] == "inProgress")
}

/// Items a pending request refers to. The user reviews them before
/// answering, so they are never trimmed.
pub(crate) fn referenced(pending: &[PendingRequest]) -> HashSet<&str> {
    pending.iter().flat_map(|r| [&r.params["itemId"], &r.params["toolUseId"]]).filter_map(Value::as_str).collect()
}

/// The Item as clients receive it, given the Agent's pending requests.
/// Items with no large field come back unchanged, and projecting a
/// projected Item changes nothing.
pub fn item(item: &Value, pending: &[PendingRequest]) -> Value {
    item_owned(item.clone(), pending)
}

pub(crate) fn item_owned(mut item: Value, pending: &[PendingRequest]) -> Value {
    project_item(&mut item, &referenced(pending));
    item
}

/// The Turn as clients receive it: Items projected, and Core's per-Turn
/// Claude scratch (`_claude*`, never read by clients) left out.
pub fn turn(turn: &Value, pending: &[PendingRequest]) -> Value {
    let mut out = turn.clone();
    project_turn(&mut out, &referenced(pending));
    out
}

/// The detail API's view of a record. It owns its copy, so nothing that
/// stays whole is copied again.
pub fn detail(mut detail: AgentDetail) -> AgentDetail {
    let keep = referenced(&detail.pending);
    for turn in &mut detail.turns {
        project_turn(turn, &keep);
    }
    detail
}

fn project_turn(turn: &mut Value, keep: &HashSet<&str>) {
    if let Some(fields) = turn.as_object_mut() {
        fields.retain(|key, _| !key.starts_with("_claude"));
    }
    for item in turn.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
        project_item(item, keep);
    }
}

fn kept_whole(item: &Value, keep: &HashSet<&str>) -> bool {
    whole(item) || item["id"].as_str().is_some_and(|id| keep.contains(id))
}

fn project_item(item: &mut Value, keep: &HashSet<&str>) {
    if kept_whole(item, keep) {
        return;
    }
    let Some(fields) = item.as_object() else { return };
    let trimmed: Vec<(String, Value, Value)> = fields
        .iter()
        .filter_map(|(key, value)| trim(item, key, value).map(|(preview, meta)| (key.clone(), preview, meta)))
        .collect();
    if trimmed.is_empty() {
        return;
    }
    let mut truncated = item[TRUNCATED].as_object().cloned().unwrap_or_default();
    for (key, preview, meta) in trimmed {
        item[&key] = preview;
        truncated.insert(key, meta);
    }
    item[TRUNCATED] = Value::Object(truncated);
}

/// The preview of one field and its annotation, when the field is trimmed.
/// Stored records keep exactly these fields out of their Item rows, with
/// these previews (`record_rows`), so a record loaded without payloads is
/// this view.
pub(crate) fn trim(item: &Value, key: &str, value: &Value) -> Option<(Value, Value)> {
    if key == TRUNCATED || item[TRUNCATED].get(key).is_some() {
        return None;
    }
    let large = match value {
        Value::String(text) => text.len() > TRIM_ABOVE,
        Value::Array(_) | Value::Object(_) => weight(value, TRIM_ABOVE).is_none(),
        _ => false,
    };
    if !large {
        return None;
    }
    let (preview, keep, mut meta) = preview(item, key, value);
    // A second request is worth it only when the preview leaves out at least half.
    if weight_of(&preview) * 2 > weight_of(value) {
        return None;
    }
    meta.insert("bytes".into(), size(value).into());
    meta.insert("keep".into(), keep.name().into());
    if let Value::String(text) = value {
        meta.insert("lines".into(), lines(text).into());
    }
    Some((preview, Value::Object(meta)))
}

/// A field's preview, which end of it the preview keeps, and extra notes.
fn preview(item: &Value, key: &str, value: &Value) -> (Value, Keep, Map<String, Value>) {
    let plain = |preview: Value, keep| (preview, keep, Map::new());
    match (item["type"].as_str().unwrap_or_default(), key, value) {
        // A command's result and errors are at the end of its output.
        ("commandExecution", "aggregatedOutput", Value::String(text)) => plain(cut(text, PREVIEW, Keep::Tail).into(), Keep::Tail),
        ("claudeToolUse", "output", Value::String(text)) => {
            let keep = if item["name"] == "Bash" { Keep::Tail } else { Keep::Head };
            plain(cut(text, PREVIEW, keep).into(), keep)
        }
        ("claudeToolUse", "output", Value::Array(blocks)) => {
            let blocks = blocks.iter().map(|block| part_preview(block, PREVIEW)).collect();
            plain(shrink(&Value::Array(blocks), PREVIEW), Keep::Head)
        }
        ("fileChange", "changes", Value::Array(changes)) => file_changes(changes),
        ("mcpToolCall", "result", Value::Object(result)) => plain(mcp_result(result), Keep::Head),
        (_, _, Value::String(text)) => plain(cut(text, PREVIEW, Keep::Head).into(), Keep::Head),
        _ => plain(shrink(value, PREVIEW), Keep::Head),
    }
}

/// Paths and kinds come first, since they name what was touched (up to three
/// quarters of the preview); the diffs share what is left, in order.
fn file_changes(changes: &[Value]) -> (Value, Keep, Map<String, Value>) {
    // The array's brackets, then up to three quarters for skeletons.
    let mut left = PREVIEW * 3 / 4 - 2;
    let mut kept = Vec::new();
    for change in changes {
        let skeleton = match change.as_object() {
            Some(members) => Value::Object(members.iter()
                .filter(|(key, value)| !(*key == "diff" && value.is_string()))
                .map(|(key, value)| (key.clone(), shrink(value, SMALL))).collect()),
            None => shrink(change, SMALL),
        };
        // The skeleton, a comma, and an empty "diff" member.
        let cost = weight_of(&skeleton) + 1 + 10;
        if cost > left {
            break;
        }
        left -= cost;
        kept.push(skeleton);
    }
    let mut budget = left + PREVIEW / 4;
    let mut cut_diffs = Vec::new();
    for (index, skeleton) in kept.iter_mut().enumerate() {
        if let (Some(members), Some(diff)) = (skeleton.as_object_mut(), changes[index]["diff"].as_str()) {
            let part = cut(diff, budget, Keep::Head);
            budget -= part.len();
            if part.len() < diff.len() {
                cut_diffs.push(index);
            }
            members.insert("diff".into(), part.into());
        }
    }
    let mut meta = Map::new();
    if kept.len() < changes.len() {
        meta.insert("omitted".into(), (changes.len() - kept.len()).into());
    }
    if !cut_diffs.is_empty() {
        meta.insert("cutDiffs".into(), cut_diffs.into());
    }
    (Value::Array(kept), Keep::Head, meta)
}

/// An MCP result keeps its content and small members such as isError.
/// structuredContent repeats text content and _meta is transport detail, so
/// a large one is left out of the preview.
fn mcp_result(result: &Map<String, Value>) -> Value {
    let has_text = result.get("content").and_then(Value::as_array)
        .is_some_and(|parts| parts.iter().any(|part| part["text"].is_string()));
    let reduced = result.iter().filter_map(|(key, value)| {
        let large = weight(value, SMALL).is_none();
        let value = match (key.as_str(), value) {
            ("structuredContent", _) if has_text && large => return None,
            ("_meta", _) if large => return None,
            ("content", Value::Array(parts)) => Value::Array(parts.iter().map(|part| part_preview(part, PREVIEW)).collect()),
            _ => shrink(value, PREVIEW),
        };
        Some((key.clone(), value))
    }).collect();
    shrink(&Value::Object(reduced), PREVIEW)
}

/// A content part within `budget`. Image and audio parts keep their type
/// and media type but not their base64 data.
fn part_preview(part: &Value, budget: usize) -> Value {
    let Some(members) = part.as_object().filter(|_| matches!(part["type"].as_str(), Some("image" | "audio"))) else {
        return shrink(part, budget);
    };
    let without_data = |members: &Map<String, Value>| -> Map<String, Value> {
        members.iter().filter(|(key, _)| !matches!(key.as_str(), "data" | "source"))
            .map(|(key, value)| (key.clone(), value.clone())).collect()
    };
    let mut out = without_data(members);
    if let Some(source) = part["source"].as_object() {
        out.insert("source".into(), Value::Object(without_data(source)));
    }
    shrink(&Value::Object(out), budget)
}

/// `value` within `budget` bytes of compact JSON (escapes not counted),
/// keeping its shape: strings keep their start, arrays their leading
/// elements, objects their small members whole and a share of the rest.
fn shrink(value: &Value, budget: usize) -> Value {
    match value {
        Value::String(text) => cut(text, budget.saturating_sub(2), Keep::Head).into(),
        Value::Array(items) => {
            // Small elements are kept first, in order, then the large ones share
            // what is left, so one long element cannot crowd out the rest.
            let mut left = budget.saturating_sub(2);
            let mut out: Vec<Option<Value>> = vec![None; items.len()];
            let mut large = Vec::new();
            for (index, item) in items.iter().enumerate() {
                match weight(item, SMALL) {
                    // Each element is followed by a comma.
                    Some(cost) if cost < left => {
                        left -= cost + 1;
                        out[index] = Some(item.clone());
                    }
                    Some(_) => {}
                    None => large.push(index),
                }
            }
            let mut sharing = large.len();
            for index in large {
                let share = left / sharing;
                sharing -= 1;
                if share < SMALL / 4 {
                    continue;
                }
                let kept = shrink(&items[index], share - 1);
                left -= (weight_of(&kept) + 1).min(left);
                out[index] = Some(kept);
            }
            Value::Array(out.into_iter().flatten().collect())
        }
        Value::Object(members) => {
            let mut left = budget.saturating_sub(2);
            let mut out = Map::new();
            let (small, large): (Vec<_>, Vec<_>) = members.iter().partition(|(_, member)| weight(member, SMALL).is_some());
            for (key, member) in small {
                // Quotes, colon and comma around the key.
                let cost = key.len() + 4 + weight_of(member);
                if cost <= left {
                    left -= cost;
                    out.insert(key.clone(), member.clone());
                }
            }
            let mut sharing = large.len();
            for (key, member) in large {
                let share = left / sharing;
                sharing -= 1;
                let overhead = key.len() + 4;
                if share < overhead + SMALL / 4 {
                    continue;
                }
                let kept = shrink(member, share - overhead);
                left -= (overhead + weight_of(&kept)).min(left);
                out.insert(key.clone(), kept);
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Why a payload request names nothing in the record.
#[derive(Debug, PartialEq)]
pub enum Missing {
    Turn,
    Item,
    Field(String),
}

impl Missing {
    pub fn code(&self) -> &'static str {
        match self {
            Missing::Turn => "turn_not_found",
            Missing::Item => "item_not_found",
            Missing::Field(_) => "field_not_found",
        }
    }
    pub fn message(&self) -> String {
        match self {
            Missing::Turn => "This Agent has no Turn with that ID".into(),
            Missing::Item => "This Agent has no Item with that ID".into(),
            Missing::Field(name) => format!("This Item has no field named {name:?}"),
        }
    }
}

/// Full values of one Item's fields: those named in `fields` (comma
/// separated, any field the Item has), or by default every field the detail
/// API trims now. Without a Turn ID the newest Item with this ID is used.
pub fn item_payload(detail: &AgentDetail, turn_id: Option<&str>, item_id: &str, fields: Option<&str>) -> Result<Value, Missing> {
    let mut turns = detail.turns.iter().rev().filter(|t| turn_id.is_none_or(|id| t["id"] == id)).peekable();
    if turn_id.is_some() && turns.peek().is_none() {
        return Err(Missing::Turn);
    }
    let (turn, found) = turns
        .find_map(|t| t["items"].as_array()?.iter().rev().find(|i| i["id"] == item_id).map(|i| (t, i)))
        .ok_or(Missing::Item)?;
    let fields = match fields {
        Some(names) => names.split(',').filter(|name| !name.is_empty()).map(|name| {
            let value = found.get(name).ok_or_else(|| Missing::Field(name.into()))?;
            Ok((name.to_owned(), value.clone()))
        }).collect::<Result<Map<_, _>, _>>()?,
        None if found["type"] == "userMessage" => ["content", crate::message_content::BLOCKS, "_yuzunoInputText"].into_iter()
            .filter_map(|key| found.get(key).map(|v| (key.to_owned(), v.clone()))).collect(),
        None => full_fields(found, &referenced(&detail.pending)),
    };
    Ok(json!({"agentId":detail.agent.id,"turnId":turn["id"],"turnStatus":turn["status"],
        "itemId":found["id"],"itemStatus":found["status"],"fields":fields}))
}

/// Full values of every trimmed field in one Turn, by Item ID. One request
/// serves copying a whole Turn.
pub fn turn_payload(detail: &AgentDetail, turn_id: &str) -> Result<Value, Missing> {
    let turn = detail.turns.iter().rev().find(|t| t["id"] == turn_id).ok_or(Missing::Turn)?;
    let keep = referenced(&detail.pending);
    let mut items = Map::new();
    for found in turn["items"].as_array().into_iter().flatten() {
        let fields = full_fields(found, &keep);
        if let (false, Some(id)) = (fields.is_empty(), found["id"].as_str()) {
            items.insert(id.to_owned(), json!({"itemStatus":found["status"],"fields":fields}));
        }
    }
    Ok(json!({"agentId":detail.agent.id,"turnId":turn["id"],"turnStatus":turn["status"],"items":items}))
}

fn full_fields(item: &Value, keep: &HashSet<&str>) -> Map<String, Value> {
    if kept_whole(item, keep) {
        return Map::new();
    }
    item.as_object()
        .into_iter()
        .flatten()
        .filter(|(key, value)| trim(item, key, value).is_some())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// At most `limit` bytes from one end of `text`, on a character boundary,
/// and on a line boundary when one is near.
fn cut(text: &str, limit: usize, keep: Keep) -> &str {
    if text.len() <= limit {
        return text;
    }
    let near = limit / 4;
    match keep {
        Keep::Head => {
            let mut end = limit;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            let head = &text[..end];
            match head.rfind('\n') {
                Some(i) if i + 1 >= end.saturating_sub(near) => &head[..=i],
                _ => head,
            }
        }
        Keep::Tail => {
            let mut start = text.len() - limit;
            while !text.is_char_boundary(start) {
                start += 1;
            }
            let tail = &text[start..];
            match tail.find('\n') {
                Some(i) if i < near => &tail[i + 1..],
                _ => tail,
            }
        }
    }
}

fn lines(text: &str) -> usize {
    text.matches('\n').count() + usize::from(!text.is_empty() && !text.ends_with('\n'))
}

/// The full size clients are told: a string's UTF-8 length, else its JSON size.
fn size(value: &Value) -> usize {
    match value {
        Value::String(text) => text.len(),
        _ => weight_of(value),
    }
}

fn weight_of(value: &Value) -> usize {
    weight(value, usize::MAX).unwrap_or(usize::MAX)
}

/// Compact JSON size of `value` without escapes, or None once past `limit`.
/// Strings count by length, so no text is scanned.
fn weight(value: &Value, limit: usize) -> Option<usize> {
    fn add(value: &Value, total: &mut usize, limit: usize) -> bool {
        match value {
            Value::Null | Value::Bool(true) => *total += 4,
            Value::Bool(false) => *total += 5,
            Value::Number(n) => *total += n.as_u64().map_or(20, |n| n.checked_ilog10().unwrap_or(0) as usize + 1),
            Value::String(text) => *total += text.len() + 2,
            Value::Array(items) => {
                *total += 1 + items.len().max(1);
                for item in items {
                    if !add(item, total, limit) { return false; }
                }
            }
            Value::Object(members) => {
                *total += 1 + members.len().max(1);
                for (key, member) in members {
                    *total += key.len() + 3;
                    if !add(member, total, limit) { return false; }
                }
            }
        }
        *total <= limit
    }
    let mut total = 0;
    add(value, &mut total, limit).then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(turns: Vec<Value>, pending: Value) -> AgentDetail {
        serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage",
            "status":"idle","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":turns,"pending":pending,"artifacts":[]})).unwrap()
    }
    fn json_size(value: &Value) -> usize {
        serde_json::to_vec(value).unwrap().len()
    }
    /// Numbered lines, so cuts can be checked against line boundaries.
    fn numbered(lines: usize) -> String {
        (0..lines).map(|n| format!("line {n:06} of the output\n")).collect()
    }
    /// One field's preview (with no pending requests).
    fn project(original: &Value) -> Value {
        item(original, &[])
    }

    #[test]
    fn sizes_are_compact_json_without_escapes() {
        let plain = json!({"a":[1,22,333,null,true,false,"text",{"k":"v"}],"b":{},"c":[],"d":12345678901u64});
        assert_eq!(size(&plain), json_size(&plain));
        assert_eq!(weight(&plain, json_size(&plain)), Some(json_size(&plain)));
        assert_eq!(weight(&plain, json_size(&plain) - 1), None);
        let escaped = json!(["two\nlines", "\"quoted\""]);
        assert_eq!(size(&escaped), json_size(&escaped) - 3);
        assert_eq!(size(&json!("柚\n")), 4, "strings are their UTF-8 length");
    }

    #[test]
    fn small_items_and_conversation_text_are_unchanged() {
        let small = json!({"id":"c","type":"commandExecution","command":"ls","aggregatedOutput":"a\nb\n","status":"completed","exitCode":0});
        assert_eq!(project(&small), small);
        let at_limit = json!({"id":"c","type":"commandExecution","aggregatedOutput":"x".repeat(TRIM_ABOVE)});
        assert_eq!(project(&at_limit), at_limit);
        let huge = "word ".repeat(100_000);
        for conversation in [
            json!({"id":"m","type":"agentMessage","text":huge,"_yuzunoCompletedText":huge}),
            json!({"id":"u","type":"userMessage","content":[{"type":"text","text":huge}]}),
            json!({"id":"r","type":"reasoning","summary":[huge],"content":[]}),
            json!({"id":"p","type":"plan","text":huge}),
        ] {
            assert_eq!(project(&conversation), conversation);
        }
    }

    #[test]
    fn a_preview_that_would_not_halve_the_field_is_not_made() {
        let barely = json!({"id":"c","type":"commandExecution","aggregatedOutput":"x".repeat(TRIM_ABOVE + 1)});
        assert_eq!(project(&barely), barely);
        let clearly = json!({"id":"c","type":"commandExecution","aggregatedOutput":"x".repeat(TRIM_ABOVE + 200)});
        assert!(project(&clearly)[TRUNCATED]["aggregatedOutput"].is_object());
    }

    #[test]
    fn command_output_keeps_its_last_lines_and_full_size() {
        let output = numbered(5000);
        let original = json!({"id":"c","type":"commandExecution","command":"cargo test","aggregatedOutput":output,"status":"completed","exitCode":1});
        let projected = project(&original);
        let kept = projected["aggregatedOutput"].as_str().unwrap();
        assert!(kept.len() <= PREVIEW && kept.len() > PREVIEW / 2, "{}", kept.len());
        assert!(output.ends_with(kept));
        assert!(kept.starts_with("line "), "a tail preview starts on a line boundary");
        assert_eq!(projected[TRUNCATED], json!({"aggregatedOutput":{"bytes":output.len(),"lines":5000,"keep":"tail"}}));
        for key in ["id", "type", "command", "status", "exitCode"] {
            assert_eq!(projected[key], original[key]);
        }
        assert_eq!(project(&projected), projected, "projection is idempotent");
    }

    #[test]
    fn cuts_respect_multibyte_characters() {
        let text = "柚".repeat(10_000);
        for keep in [Keep::Head, Keep::Tail] {
            let kept = cut(&text, PREVIEW, keep);
            assert!(kept.len() <= PREVIEW && kept.len() >= PREVIEW - 3);
            assert!(kept.chars().all(|c| c == '柚'));
        }
        let projected = project(&json!({"id":"c","type":"commandExecution","aggregatedOutput":text}));
        assert_eq!(projected[TRUNCATED]["aggregatedOutput"]["lines"], 1);
    }

    #[test]
    fn file_changes_keep_paths_and_say_which_diffs_are_cut() {
        let mut changes: Vec<Value> = (0..6).map(|n| json!({"path":format!("src/file{n}.rs"),"kind":{"type":"update","move_path":null},"diff":numbered(200)})).collect();
        changes.push(json!({"path":"assets/logo.png","kind":{"type":"update","move_path":null},"diff":""}));
        let original = json!({"id":"f","type":"fileChange","changes":changes,"status":"completed"});
        let projected = project(&original);
        let kept = projected["changes"].as_array().unwrap();
        assert_eq!(kept.len(), 7);
        for (n, change) in kept.iter().enumerate() {
            assert_eq!(change["path"], original["changes"][n]["path"]);
            assert_eq!(change["kind"], original["changes"][n]["kind"]);
            assert!(original["changes"][n]["diff"].as_str().unwrap().starts_with(change["diff"].as_str().unwrap()));
        }
        assert!(!kept[0]["diff"].as_str().unwrap().is_empty());
        assert!(weight_of(&projected["changes"]) <= PREVIEW);
        // Every real diff is cut; the binary file's empty diff was never there.
        assert_eq!(projected[TRUNCATED]["changes"], json!({"bytes":size(&original["changes"]),"keep":"head","cutDiffs":[0,1,2,3,4,5]}));
    }

    #[test]
    fn rename_heavy_file_changes_are_bounded_and_count_what_is_left_out() {
        let changes: Vec<Value> = (0..2000).map(|n| json!({"path":format!("{}/renamed-{n:05}.rs", "deeply/nested/module/path".repeat(4)),
            "kind":{"type":"update","move_path":format!("old/{n}.rs")},"diff":""})).collect();
        let original = json!({"id":"f","type":"fileChange","changes":changes,"status":"completed"});
        assert!(json_size(&original["changes"]) > 300_000);
        let projected = project(&original);
        let kept = projected["changes"].as_array().unwrap();
        assert!(weight_of(&projected["changes"]) <= PREVIEW, "{}", weight_of(&projected["changes"]));
        assert!(!kept.is_empty());
        assert_eq!(projected[TRUNCATED]["changes"]["omitted"], 2000 - kept.len());
        assert!(projected[TRUNCATED]["changes"].get("cutDiffs").is_none(), "no diff was cut");
        assert_eq!(kept[0], original["changes"][0]);
    }

    #[test]
    fn mcp_results_keep_text_start_media_metadata_and_small_members() {
        let text = numbered(2000);
        let original = json!({"id":"m","type":"mcpToolCall","server":"yuzuno","tool":"task_get","arguments":{"taskId":"T-1"},
            "result":{"content":[{"type":"text","text":text},{"type":"image","mimeType":"image/png","data":"A".repeat(50_000)}],
                "structuredContent":{"rows":vec!["x".repeat(100); 500]},"_meta":null,"isError":false},
            "status":"completed"});
        let projected = project(&original);
        let result = &projected["result"];
        assert!(text.starts_with(result["content"][0]["text"].as_str().unwrap()));
        assert_eq!(result["content"][1], json!({"type":"image","mimeType":"image/png"}));
        assert_eq!(result["isError"], false);
        assert!(result["_meta"].is_null() && result.get("_meta").is_some());
        assert!(result.get("structuredContent").is_none());
        assert!(weight_of(result) <= PREVIEW);
        assert_eq!(projected["arguments"], original["arguments"]);
        assert_eq!(projected[TRUNCATED]["result"]["bytes"], size(&original["result"]));

        // No content is invented; structured data alone keeps its shape.
        let structured = json!({"id":"s","type":"mcpToolCall","result":{"structuredContent":{"rows":vec!["y".repeat(100); 200]}}});
        let result = &project(&structured)["result"];
        assert!(result.get("content").is_none());
        assert!(!result["structuredContent"]["rows"].as_array().unwrap().is_empty());
    }

    #[test]
    fn claude_tools_keep_paths_shapes_and_drop_image_data() {
        let read = json!({"id":"t1","type":"claudeToolUse","name":"Read","status":"completed",
            "input":{"file_path":"/repo/src/main.rs"},"output":numbered(3000)});
        let projected = project(&read);
        assert_eq!(projected["input"], read["input"]);
        assert!(read["output"].as_str().unwrap().starts_with(projected["output"].as_str().unwrap()));
        assert_eq!(projected[TRUNCATED]["output"]["keep"], "head");

        let bash = json!({"id":"t2","type":"claudeToolUse","name":"Bash","input":{"command":"make"},"output":numbered(3000)});
        assert_eq!(project(&bash)[TRUNCATED]["output"]["keep"], "tail");

        let write = json!({"id":"t3","type":"claudeToolUse","name":"Write","status":"completed",
            "input":{"file_path":"/repo/notes.md","content":"y".repeat(30_000)},"output":"Written"});
        let projected = project(&write);
        assert_eq!(projected["input"]["file_path"], "/repo/notes.md");
        assert!(projected["input"]["content"].as_str().unwrap().len() > PREVIEW / 2);
        assert!(weight_of(&projected["input"]) <= PREVIEW);
        assert_eq!(projected["output"], "Written");
        assert_eq!(projected[TRUNCATED], json!({"input":{"bytes":size(&write["input"]),"keep":"head"}}));

        // MultiEdit's edits stay a list of edits, not a JSON string.
        let edits: Vec<Value> = (0..4).map(|n| json!({"old_string":format!("old {n}").repeat(500),"new_string":format!("new {n}").repeat(500)})).collect();
        let multi = json!({"id":"t5","type":"claudeToolUse","name":"MultiEdit","input":{"file_path":"/repo/a.rs","edits":edits}});
        let input = &project(&multi)["input"];
        assert_eq!(input["file_path"], "/repo/a.rs");
        let kept = input["edits"].as_array().expect("edits keep their shape");
        assert!(!kept.is_empty() && kept[0]["old_string"].is_string());

        let image = json!({"id":"t4","type":"claudeToolUse","name":"Read","input":{"file_path":"/repo/shot.png"},
            "output":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"A".repeat(400_000)}}]});
        let projected = project(&image);
        assert_eq!(projected["output"], json!([{"type":"image","source":{"type":"base64","media_type":"image/png"}}]));
        assert!(json_size(&projected) < 1024);
    }

    #[test]
    fn every_large_tool_field_is_bounded_and_keeps_its_shape() {
        let huge = numbered(40_000);
        let blob = json!({"rows": vec![huge.clone(); 3]});
        let items = [
            json!({"id":"1","type":"commandExecution","command":huge,"commandActions":[{"type":"unknown","command":huge}],"aggregatedOutput":huge}),
            json!({"id":"2","type":"fileChange","changes":vec![json!({"path":"a","kind":{"type":"add"},"diff":huge}); 50]}),
            json!({"id":"3","type":"mcpToolCall","arguments":blob,"result":{"content":[{"type":"text","text":huge}],"structuredContent":blob,"_meta":blob}}),
            json!({"id":"4","type":"claudeToolUse","name":"Edit","input":{"file_path":"a","old_string":huge,"new_string":huge},"output":[{"type":"text","text":huge},{"type":"text","text":huge}]}),
            json!({"id":"5","type":"imageGeneration","result":huge,"revisedPrompt":"p"}),
            json!({"id":"6","type":"webSearch","query":"q","results":vec![json!({"title":"t","snippet":huge}); 4]}),
            json!({"id":"7","type":"dynamicToolCall","contentItems":vec![json!({"type":"inputText","text":"z".repeat(300)}); 400]}),
        ];
        for original in items {
            let projected = project(&original);
            for (key, meta) in projected[TRUNCATED].as_object().unwrap() {
                assert!(weight_of(&projected[key]) <= PREVIEW + 2, "{}.{key}: {}", original["type"], weight_of(&projected[key]));
                let same_shape = std::mem::discriminant(&projected[key]) == std::mem::discriminant(&original[key]);
                assert!(same_shape, "{}.{key} keeps its JSON type", original["type"]);
                assert!(meta.get("asText").is_none());
            }
            assert!(json_size(&projected) * 10 < json_size(&original));
            assert_eq!(project(&projected), projected, "idempotent for {}", original["type"]);
        }
    }

    #[test]
    fn approvals_and_in_progress_file_changes_are_never_trimmed() {
        let diff = numbered(3000);
        let change = |status: &str| json!({"id":"edit","type":"fileChange","status":status,"changes":[{"path":"src/a.rs","kind":{"type":"update"},"diff":diff}]});
        // A Codex approval shows the change while it is still in progress.
        assert_eq!(project(&change("inProgress")), change("inProgress"));
        assert!(project(&change("completed"))[TRUNCATED].is_object());

        let tool = json!({"id":"toolu_1","type":"claudeToolUse","name":"Write","status":"inProgress","input":{"file_path":"/a","content":diff}});
        let pending = json!([
            {"id":"r1","agentId":"a","method":"item/fileChange/requestApproval","params":{"turnId":"t","itemId":"edit"},"createdAt":""},
            {"id":"r2","agentId":"a","method":"claude/canUseTool","params":{"turnId":"t","toolUseId":"toolu_1","toolName":"Write"},"createdAt":""}]);
        let d = record(vec![json!({"id":"t","status":"inProgress","items":[change("completed"), tool.clone()]})], pending);
        let projected = detail(d.clone());
        assert_eq!(projected.turns[0]["items"][0], change("completed"), "a pending request's Item stays whole");
        assert_eq!(projected.turns[0]["items"][1], tool);
        assert_eq!(item(&change("completed"), &d.pending), change("completed"));
        assert_eq!(turn_payload(&d, "t").unwrap()["items"], json!({}), "nothing was trimmed, so nothing is listed");
    }

    #[test]
    fn projection_leaves_the_record_untouched_and_turn_scratch_out() {
        let output = numbered(3000);
        let turns = vec![json!({"id":"t","status":"completed","_yuzunoPlan":[{"step":"x","status":"completed"}],
            "_claudeTextBlocks":{"m":["text"]},"_claudeThinking":{"m":{"0":"think"}},
            "items":[{"id":"u","type":"userMessage","content":[{"type":"text","text":"run it"}]},
                     {"id":"c","type":"commandExecution","aggregatedOutput":output}]})];
        let original = record(turns.clone(), json!([]));
        let projected = detail(original.clone());
        assert_eq!(original.turns, turns, "the source record is unchanged");
        let turn = &projected.turns[0];
        assert!(turn.get("_claudeTextBlocks").is_none() && turn.get("_claudeThinking").is_none());
        assert_eq!(turn["_yuzunoPlan"], turns[0]["_yuzunoPlan"]);
        assert_eq!(turn["items"][0], turns[0]["items"][0]);
        assert_eq!(turn["items"][1][TRUNCATED]["aggregatedOutput"]["bytes"], output.len());
        assert_eq!(super::turn(&turns[0], &[]), *turn);
    }

    #[test]
    fn payloads_return_full_values_and_name_what_is_missing() {
        let output = numbered(3000);
        let d = record(vec![
            json!({"id":"t1","status":"completed","items":[{"id":"c","type":"commandExecution","command":"ls","aggregatedOutput":"old","status":"completed"}]}),
            json!({"id":"t2","status":"inProgress","items":[{"id":"c","type":"commandExecution","command":"ls","aggregatedOutput":output,"status":"inProgress"},
                {"id":"small","type":"commandExecution","aggregatedOutput":"ok","status":"completed"}]}),
        ], json!([]));
        let newest = item_payload(&d, None, "c", None).unwrap();
        assert_eq!(newest["turnId"], "t2");
        assert_eq!(newest["itemStatus"], "inProgress");
        assert_eq!(newest["fields"], json!({"aggregatedOutput":output}));
        let older = item_payload(&d, Some("t1"), "c", Some("aggregatedOutput")).unwrap();
        assert_eq!(older["fields"]["aggregatedOutput"], "old");
        let both = item_payload(&d, Some("t2"), "c", Some("command,aggregatedOutput")).unwrap();
        assert_eq!(both["fields"], json!({"command":"ls","aggregatedOutput":output}));
        assert_eq!(item_payload(&d, None, "small", None).unwrap()["fields"], json!({}));
        assert_eq!(item_payload(&d, None, "nope", None), Err(Missing::Item));
        assert_eq!(item_payload(&d, Some("t9"), "c", None), Err(Missing::Turn));
        assert_eq!(item_payload(&d, Some("t1"), "small", None), Err(Missing::Item));
        assert_eq!(item_payload(&d, None, "c", Some("command,diff")), Err(Missing::Field("diff".into())));

        let turn = turn_payload(&d, "t2").unwrap();
        assert_eq!(turn["turnStatus"], "inProgress");
        assert_eq!(turn["items"], json!({"c":{"itemStatus":"inProgress","fields":{"aggregatedOutput":output}}}));
        assert_eq!(turn_payload(&d, "t9"), Err(Missing::Turn));
    }
}
