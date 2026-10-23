//! Display-only paste boundaries on the existing message receipt. Native
//! requests continue to carry the original text, never labels or markers.
use crate::model::{MessageInput, MessageReceipt};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use unicode_segmentation::UnicodeSegmentation;

pub const BLOCKS: &str = "_yuzunoTextBlocks";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextBlock {
    pub id: String,
    /// UTF-16 offsets into MessageInput.text, as used by the composer.
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageBinding {
    pub turn_id: String,
    pub item_id: String,
    pub user_index: usize,
}

pub fn validate(input: &MessageInput) -> Result<()> {
    let Some(blocks) = &input.text_blocks else {
        return Ok(());
    };
    ensure!(
        blocks.len() <= 128,
        "Too many pasted text blocks (maximum 128)"
    );
    let mut boundaries = HashSet::from([0]);
    let mut offset = 0;
    for c in input.text.chars() {
        offset += c.len_utf16();
        boundaries.insert(offset);
    }
    let mut previous = 0;
    let mut ids = HashSet::new();
    for block in blocks {
        ensure!(
            !block.id.is_empty()
                && block.id.len() <= 100
                && ids.insert(&block.id)
                && block.start >= previous
                && block.end >= block.start
                && boundaries.contains(&block.start)
                && boundaries.contains(&block.end),
            "Invalid pasted text boundaries"
        );
        previous = block.end;
    }
    Ok(())
}

pub fn text(item: &Value) -> String {
    item["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["type"] == "text" || p["type"] == "inputText")
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn synthetic(item: &Value) -> bool {
    item["id"]
        .as_str()
        .and_then(|id| id.strip_prefix("item-"))
        .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
}

/// An Item `restore` changed: its Turn, its ID after the change, and whether
/// that ID is new (a synthetic ID replaced by the bound one).
pub(crate) type Restored = (String, String, bool);

thread_local! {
    /// The Items `restore` changes on this thread while `collect_restored` runs.
    static RESTORED: std::cell::RefCell<Option<Vec<Restored>>> = const { std::cell::RefCell::new(None) };
}

/// Runs `f` and returns, with its result, every Item `restore` changed on
/// this thread meanwhile: for a commit that names what it wrote instead of
/// comparing the whole record (`Store::commit`'s scopes). Not reentrant; an
/// unwind ends the collection too.
pub(crate) fn collect_restored<T>(f: impl FnOnce() -> T) -> (T, Vec<Restored>) {
    struct Collecting;
    impl Drop for Collecting {
        fn drop(&mut self) { RESTORED.with(|r| *r.borrow_mut() = None); }
    }
    RESTORED.with(|r| {
        let mut r = r.borrow_mut();
        assert!(r.is_none(), "collect_restored is not reentrant");
        *r = Some(Vec::new());
    });
    let collecting = Collecting;
    let value = f();
    let restored = RESTORED.with(|r| r.borrow_mut().take()).unwrap_or_default();
    drop(collecting);
    (value, restored)
}

fn note_restored(turn: &str, item: &Value, renamed: bool) {
    RESTORED.with(|r| if let Some(r) = r.borrow_mut().as_mut() {
        r.push((turn.to_owned(), item["id"].as_str().unwrap_or_default().to_owned(), renamed));
    });
}

/// Attach display metadata only through explicit message identity. Full native
/// history reconstructs item-N IDs; the recorded turn/user position addresses
/// that occurrence. Exact text is an integrity check, never a body search.
pub fn restore(turns: &mut [Value], receipts: &[MessageReceipt], full_history: bool) {
    let restorer = Restorer::new(receipts);
    for turn in turns {
        restorer.restore(turn, full_history);
    }
}

/// `restore` one Turn at a time, the receipts' lookups built once: for a
/// snapshot whose Turns are copied as they merge (T-140).
pub(crate) struct Restorer<'a>(Shown<'a>);

impl<'a> Restorer<'a> {
    pub(crate) fn new(receipts: &'a [MessageReceipt]) -> Self {
        Self(Shown::of(receipts))
    }

    pub(crate) fn restore(&self, turn: &mut Value, full_history: bool) {
        let shown = &self.0;
        let tid = turn["id"].as_str().unwrap_or_default().to_owned();
        let Some(items) = turn["items"].as_array_mut() else {
            return;
        };
        for (index, item) in items
            .iter_mut()
            .filter(|i| i["type"] == "userMessage")
            .enumerate()
        {
            let Some(receipt) = shown.receipt(&tid, index, item, full_history) else { continue };
            let (mut changed, mut renamed) = (false, false);
            if item["clientId"] != receipt.input.client_message_id {
                item["clientId"] = receipt.input.client_message_id.clone().into();
                changed = true;
            }
            if renames(item, receipt, &tid) {
                item["id"] = receipt.binding.as_ref().expect("renames").item_id.clone().into();
                renamed = true;
            }
            if let Some(blocks) = receipt
                .input
                .text_blocks
                .as_ref()
                .filter(|_| item.get(BLOCKS).is_none())
            {
                // Do not apply offsets to a transformed body. Native text is
                // retained, while the exact submitted source is shown/copied.
                if text(item) != receipt.input.text {
                    item["_yuzunoInputText"] = receipt.input.text.clone().into();
                }
                item[BLOCKS] = serde_json::to_value(blocks).expect("text boundaries");
                changed = true;
            }
            if changed || renamed {
                note_restored(&tid, item, renamed);
            }
        }
    }
}

/// Whether `restore(turns, receipts, full_history)` would change an Item,
/// found without changing one (the same lookups and tests as `restore`).
pub fn restoring(turns: &[Value], receipts: &[MessageReceipt], full_history: bool) -> bool {
    let shown = Shown::of(receipts);
    turns.iter().any(|turn| {
        let tid = turn["id"].as_str().unwrap_or_default();
        turn["items"].as_array().into_iter().flatten().filter(|i| i["type"] == "userMessage").enumerate()
            .any(|(index, item)| shown.receipt(tid, index, item, full_history).is_some_and(|receipt|
                item["clientId"] != receipt.input.client_message_id
                    || renames(item, receipt, tid)
                    || (receipt.input.text_blocks.is_some() && item.get(BLOCKS).is_none())))
    })
}

/// Whether `restore` gives this user message of Turn `tid` its receipt's
/// bound ID (a synthetic ID replaced).
fn renames(item: &Value, receipt: &MessageReceipt, tid: &str) -> bool {
    receipt.binding.as_ref().is_some_and(|b| b.turn_id == tid && synthetic(item) && item["id"] != b.item_id.as_str())
}

/// The receipts by the identities `restore` looks user messages up with.
struct Shown<'a> {
    clients: HashMap<&'a str, &'a MessageReceipt>,
    identities: HashMap<(&'a str, &'a str), &'a MessageReceipt>,
    positions: HashMap<(&'a str, usize), &'a MessageReceipt>,
}

impl<'a> Shown<'a> {
    fn of(receipts: &'a [MessageReceipt]) -> Self {
        Self {
            clients: receipts.iter().map(|r| (r.input.client_message_id.as_str(), r)).collect(),
            identities: receipts.iter()
                .filter_map(|r| r.binding.as_ref().map(|b| ((b.turn_id.as_str(), b.item_id.as_str()), r)))
                .collect(),
            positions: receipts.iter()
                .filter_map(|r| r.binding.as_ref().map(|b| ((b.turn_id.as_str(), b.user_index), r)))
                .collect(),
        }
    }

    /// The receipt the `index`th user message of Turn `tid` shows.
    fn receipt(&self, tid: &str, index: usize, item: &Value, full_history: bool) -> Option<&'a MessageReceipt> {
        if let Some(client) = item["clientId"].as_str() {
            self.clients.get(client).copied()
        } else {
            self.identities
                .get(&(tid, item["id"].as_str().unwrap_or_default()))
                .copied()
                .or_else(|| {
                    (full_history && synthetic(item))
                        .then(|| self.positions.get(&(tid, index)).copied())
                        .flatten()
                        .filter(|r| text(item) == r.input.text)
                })
        }
    }
}

/// Record identity without treating Claude's optimistic/queued input as proof
/// of delivery. Receipt confirmation remains owned by the Harness paths.
pub fn bind(turns: &mut [Value], receipts: &mut [MessageReceipt]) {
    bind_receipts(turns, receipts);
    restore(turns, receipts, false);
}

/// `bind`'s binding of each receipt to the native user message naming its
/// client ID, which only reads the Turns; `restore` then changes them.
pub fn bind_receipts(turns: &[Value], receipts: &mut [MessageReceipt]) {
    let clients: HashMap<_, _> = receipts
        .iter()
        .enumerate()
        .map(|(i, r)| (r.input.client_message_id.clone(), i))
        .collect();
    for turn in turns.iter() {
        let Some(tid) = turn["id"].as_str() else {
            continue;
        };
        for (index, item) in turn["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|i| i["type"] == "userMessage")
            .enumerate()
        {
            let (Some(client), Some(id)) = (item["clientId"].as_str(), item["id"].as_str()) else {
                continue;
            };
            if let Some(&r) = clients.get(client) {
                let receipt = &mut receipts[r];
                if !receipt
                    .binding
                    .as_ref()
                    .is_some_and(|b| b.turn_id == tid && b.item_id == id && b.user_index == index)
                {
                    receipt.binding = Some(MessageBinding {
                        turn_id: tid.into(),
                        item_id: id.into(),
                        user_index: index,
                    });
                }
            }
        }
    }
}

fn slice(text: &str, start: usize, end: usize) -> &str {
    let mut offset = 0;
    let mut from = None;
    let mut to = None;
    for (byte, c) in text
        .char_indices()
        .chain(std::iter::once((text.len(), '\0')))
    {
        if offset == start {
            from = Some(byte);
        }
        if offset == end {
            to = Some(byte);
            break;
        }
        offset += c.len_utf16();
    }
    from.zip(to)
        .and_then(|(a, b)| text.get(a..b))
        .unwrap_or_default()
}

fn long(text: &str) -> bool {
    text.encode_utf16().count() >= 2000
        || text
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .split('\n')
            .count()
            >= 12
}

/// A bounded rail projection, with source IDs kept on WorkSummary. It carries
/// no full message body; opening a block uses the existing item payload route.
pub fn summary_parts(item: &Value) -> Option<Vec<Value>> {
    let text = item["_yuzunoInputText"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| text(item));
    let stored: Option<Vec<TextBlock>> = item
        .get(BLOCKS)
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let legacy = stored.is_none();
    let blocks = stored.unwrap_or_else(|| {
        if long(&text) {
            vec![TextBlock {
                id: "legacy".into(),
                start: 0,
                end: text.encode_utf16().count(),
            }]
        } else {
            vec![]
        }
    });
    if blocks.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    let mut at = 0;
    for block in blocks.iter().take(16) {
        if block.start > at {
            parts.push(json!({"kind":"text","text":slice(&text, at, block.start).chars().take(80).collect::<String>()}));
        }
        let body = slice(&text, block.start, block.end);
        let label: String = body.graphemes(true).take(10).collect();
        parts.push(
            json!({"kind":if legacy {"long"} else {"paste"},"id":block.id,
            "start":block.start,"end":block.end,"label":label,"truncated":label.len() < body.len(),
            "preview":body.chars().take(160).collect::<String>()}),
        );
        at = block.end;
    }
    if blocks.len() > 16 {
        parts.push(json!({"kind":"text","text":"…"}));
    } else if at < text.encode_utf16().count() {
        parts.push(json!({"kind":"text","text":slice(&text, at, text.encode_utf16().count()).chars().take(80).collect::<String>()}));
    }
    Some(parts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model::AgentDetail, workspace::Workspace};

    fn fixture() -> AgentDetail {
        let body = format!("👨‍👩‍👧‍👦e\u{301}中文123456{}", "\r\n  source".repeat(300));
        let text = format!("before {body} between {body} after\r\n");
        let start = "before ".encode_utf16().count();
        let length = body.encode_utf16().count();
        let blocks = json!([{ "id":"one","start":start,"end":start+length },
            {"id":"two","start":start+length+9,"end":start+length*2+9}]);
        serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage",
            "status":"working","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[{"id":"t","status":"inProgress","items":[
                {"id":"u1","clientId":"c1","type":"userMessage","content":[{"type":"text","text":text}]},
                {"id":"u2","clientId":"c2","type":"userMessage","content":[{"type":"text","text":text}]}]}],
            "pending":[],"artifacts":[],"messageReceipts":[
                {"input":{"clientMessageId":"c1","text":text,"textBlocks":blocks},"status":"sending"},
                {"input":{"clientMessageId":"c2","text":text,"textBlocks":[]},"status":"sending"}]})).unwrap()
    }

    #[test]
    fn boundaries_validate_utf16_and_preserve_empty_edited_blocks() {
        let mut input = fixture().message_receipts.remove(0).input;
        validate(&input).unwrap();
        input.text_blocks.as_mut().unwrap()[0].start += 1; // inside emoji's surrogate pair
        assert!(validate(&input).is_err());
        input.text_blocks = Some(vec![TextBlock {
            id: "empty".into(),
            start: 0,
            end: 0,
        }]);
        validate(&input).unwrap();
        input.text_blocks.as_mut().unwrap().push(TextBlock {
            id: "empty".into(),
            start: 0,
            end: 0,
        });
        assert!(validate(&input).is_err());
    }

    #[test]
    fn receipt_identity_and_boundaries_survive_rows_restart_and_native_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core-data");
        let mut detail = fixture();
        detail.confirm_message_receipts();
        let source = detail.message_receipts[0].input.text.clone();
        let blocks = serde_json::to_value(&detail.message_receipts[0].input.text_blocks).unwrap();
        let core = Workspace::new(path.clone(), "/tmp".into(), "unused".into()).unwrap();
        core.store.insert(&detail).unwrap();
        drop(core);
        let core = Workspace::new(path, "/tmp".into(), "unused".into()).unwrap();
        let saved = core.store.detail("a").unwrap();
        assert_eq!(
            saved.message_receipts[0].binding.as_ref().unwrap().item_id,
            "u1"
        );
        let mut history = vec![json!({"id":"t","items":[
            {"id":"item-1","type":"userMessage","content":[{"type":"text","text":source}]},
            {"id":"item-2","type":"userMessage","content":[{"type":"inputText","text":source}]}]})];
        restore(&mut history, &saved.message_receipts, true);
        assert_eq!(history[0]["items"][0]["id"], "u1");
        assert_eq!(history[0]["items"][0][BLOCKS], blocks);
        assert_eq!(history[0]["items"][1]["id"], "u2");
        assert_eq!(
            history[0]["items"][1][BLOCKS],
            json!([]),
            "identical prose keeps distinct message identity"
        );
        let parts = summary_parts(&history[0]["items"][0]).unwrap();
        assert_eq!(parts[1]["label"], "👨‍👩‍👧‍👦e\u{301}中文123456");
        assert_eq!(parts[1]["id"], "one");
        assert_eq!(parts[3]["id"], "two");
        assert!(serde_json::to_string(&parts).unwrap().len() < 2500);
        assert!(!serde_json::to_string(&parts).unwrap().contains(&source));
        assert_eq!(text(&history[0]["items"][0]), source);
    }

    /// A snapshot's Turns restored one at a time, as a merge from a kept
    /// reply does (T-140), come out as restoring them together does, and note
    /// the same Items in the same order.
    #[test]
    fn restoring_turn_by_turn_is_restoring_them_together() {
        let mut d = fixture();
        d.confirm_message_receipts();
        let source = d.message_receipts[0].input.text.clone();
        let user = |id: &str, client: Option<&str>| {
            let mut item = json!({"id":id,"type":"userMessage","content":[{"type":"text","text":source}]});
            if let Some(client) = client { item["clientId"] = client.into(); }
            item
        };
        let turns = vec![
            json!({"id":"t","items":[user("item-1", None), user("item-2", None)]}),
            json!({"id":"other","items":[user("x", Some("c2")), {"id":"a","type":"agentMessage"}]}),
            json!({"items":[user("item-1", Some("c1"))]}),
            json!({"id":"t","items":[user("item-1", None)]}),
            json!({"id":"empty"}),
        ];
        let (together, noted_together) = collect_restored(|| {
            let mut turns = turns.clone();
            restore(&mut turns, &d.message_receipts, true);
            turns
        });
        let (each, noted_each) = collect_restored(|| {
            let mut turns = turns.clone();
            let restorer = Restorer::new(&d.message_receipts);
            for turn in &mut turns {
                restorer.restore(turn, true);
            }
            turns
        });
        assert_ne!(together, turns, "the fixture restores something");
        assert_eq!(each, together);
        assert_eq!(noted_each, noted_together);
    }

    #[test]
    fn metadata_never_matches_prose_in_another_turn_or_conflicting_identity() {
        let mut d = fixture();
        d.confirm_message_receipts();
        let mut turn = d.turns[0].clone();
        for item in turn["items"].as_array_mut().unwrap() {
            item.as_object_mut().unwrap().remove(BLOCKS);
            item.as_object_mut().unwrap().remove("clientId");
            item["id"] = "item-1".into();
        }
        turn["id"] = "other-turn".into();
        restore(std::slice::from_mut(&mut turn), &d.message_receipts, true);
        assert!(turn["items"][0].get(BLOCKS).is_none());
        turn["id"] = "t".into();
        turn["items"][0]["clientId"] = "other-client".into();
        restore(std::slice::from_mut(&mut turn), &d.message_receipts, true);
        assert!(turn["items"][0].get(BLOCKS).is_none());
    }

    #[test]
    fn old_long_user_text_is_generic_and_agent_progress_is_not_projected_as_paste() {
        let mut d = fixture();
        d.turns[0]["items"][0]
            .as_object_mut()
            .unwrap()
            .remove(BLOCKS);
        assert_eq!(
            summary_parts(&d.turns[0]["items"][0]).unwrap()[0]["kind"],
            "long"
        );
        d.turns[0]["items"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"a","type":"agentMessage","_yuzunoCompletedText":"An agent update"}));
        let summary = crate::rail::project(&d).unwrap();
        assert_eq!(summary.source, "agent");
        assert!(summary.request_parts.is_none());
    }
}
