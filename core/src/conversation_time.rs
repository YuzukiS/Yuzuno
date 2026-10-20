//! Conversation time records kept by Core.
//!
//! `_yuzuno*` fields are Core records, never Harness fields. A message's
//! `_yuzunoTime` is written once, when Core first sees the message live, and
//! later bodies of the same item never move it. Turn completion records are
//! written only from live terminal events; a snapshot that reveals an old
//! completion is not evidence of when it happened.
//!
//! Times come from the event being applied (its journal time, see
//! store::route), never from the clock here, so replaying the journal
//! rebuilds the same record.

use serde_json::{json, Value};

pub const ITEM_TIME: &str = "_yuzunoTime";
const TURN_RECORDS: [&str; 3] = ["_yuzunoStartedAt", "_yuzunoCompletedAt", "_yuzunoDurationMs"];
const NATIVE_TURN_TIMES: [&str; 3] = ["startedAt", "completedAt", "durationMs"];

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn is_message(item: &Value) -> bool {
    matches!(item["type"].as_str(), Some("userMessage" | "agentMessage"))
}

fn terminal(turn: &Value) -> bool {
    matches!(turn["status"].as_str(), Some("completed" | "failed" | "interrupted"))
}

/// Records when a conversation message first appeared. `source` is "codex"
/// for the Harness's own item timestamp, "core" for the time Core received it.
pub fn stamp_message(item: &mut Value, at: Option<i64>, source: &str) {
    let Some(at) = at.filter(|t| *t > 0) else { return };
    if !is_message(item) {
        return;
    }
    if let Some(item) = item.as_object_mut() {
        item.entry(ITEM_TIME).or_insert_with(|| json!({"at": at, "source": source}));
    }
}

/// Replaces an item body while keeping Core's first-seen time.
pub fn replace_item(old: &mut Value, new: &Value) {
    let time = old.get(ITEM_TIME).cloned();
    *old = new.clone();
    if let (Some(time), Some(item)) = (time, old.as_object_mut()) {
        item.entry(ITEM_TIME).or_insert(time);
    }
}

/// Copies native Codex turn times. Absent or null values never erase saved ones.
pub fn merge_native_turn_times(existing: &mut Value, incoming: &Value) {
    for key in NATIVE_TURN_TIMES {
        let valid = if key == "durationMs" {
            incoming[key].as_i64().is_some_and(|t| t >= 0)
        } else {
            incoming[key].as_f64().is_some_and(|t| t > 0.0)
        };
        if valid {
            existing[key] = incoming[key].clone();
        }
    }
}

/// Records `at`, when Core saw a live turn reach a terminal status, once.
pub fn mark_turn_completed(turn: &mut Value, at: i64) {
    if terminal(turn) && turn["_yuzunoCompletedAt"].is_null() {
        turn["_yuzunoCompletedAt"] = at.into();
    }
}

/// `stamp_message` for the Turn's item with this ID, if there is one.
pub fn stamp_item(turn: &mut Value, id: &str, at: i64, source: &str) {
    if let Some(item) = turn["items"].as_array_mut().and_then(|items| items.iter_mut().find(|i| i["id"] == id)) {
        stamp_message(item, Some(at), source);
    }
}

/// Time records of a turn that is about to be replaced wholesale.
pub fn turn_times(turn: &Value) -> Value {
    let mut saved = json!({});
    for key in TURN_RECORDS.iter().chain(NATIVE_TURN_TIMES.iter()) {
        if !turn[*key].is_null() {
            saved[*key] = turn[*key].clone();
        }
    }
    saved
}

/// Restores Core records, and native times a partial snapshot omitted.
pub fn restore_turn_times(turn: &mut Value, saved: Value) {
    let Value::Object(saved) = saved else { return };
    for (key, value) in saved {
        if TURN_RECORDS.contains(&key.as_str()) || turn[&key].is_null() {
            turn[&key] = value;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_seen_message_time_survives_later_bodies() {
        let mut item = json!({"id":"m","type":"agentMessage","text":""});
        stamp_message(&mut item, Some(1_000), "codex");
        stamp_message(&mut item, Some(9_000), "core");
        replace_item(&mut item, &json!({"id":"m","type":"agentMessage","text":"done"}));
        assert_eq!(item["text"], "done");
        assert_eq!(item[ITEM_TIME], json!({"at":1_000,"source":"codex"}));
    }

    #[test]
    fn only_messages_with_a_real_time_are_stamped() {
        let mut tool = json!({"id":"t","type":"commandExecution"});
        stamp_message(&mut tool, Some(1_000), "core");
        assert!(tool.get(ITEM_TIME).is_none());
        let mut message = json!({"id":"m","type":"userMessage"});
        stamp_message(&mut message, None, "codex");
        stamp_message(&mut message, Some(0), "codex");
        assert!(message.get(ITEM_TIME).is_none());
    }

    #[test]
    fn native_turn_times_never_erase_saved_values() {
        let mut turn = json!({"startedAt":10,"completedAt":20,"durationMs":10_000});
        merge_native_turn_times(&mut turn, &json!({"startedAt":null,"completedAt":0}));
        assert_eq!(turn, json!({"startedAt":10,"completedAt":20,"durationMs":10_000}));
        merge_native_turn_times(&mut turn, &json!({"completedAt":21,"durationMs":0}));
        assert_eq!(turn["completedAt"], 21);
        assert_eq!(turn["durationMs"], 0);
    }

    #[test]
    fn completion_is_recorded_once_and_only_for_terminal_turns() {
        let mut turn = json!({"status":"inProgress"});
        mark_turn_completed(&mut turn, 7);
        assert!(turn["_yuzunoCompletedAt"].is_null());
        turn["status"] = "interrupted".into();
        mark_turn_completed(&mut turn, 7);
        assert_eq!(turn["_yuzunoCompletedAt"], 7);
        mark_turn_completed(&mut turn, 9);
        assert_eq!(turn["_yuzunoCompletedAt"], 7);
    }

    #[test]
    fn stamping_by_id_reaches_only_that_message() {
        let mut turn = json!({"items":[{"id":"a","type":"agentMessage"},{"id":"b","type":"agentMessage"}]});
        stamp_item(&mut turn, "b", 3, "core");
        stamp_item(&mut turn, "missing", 4, "core");
        assert!(turn["items"][0].get(ITEM_TIME).is_none());
        assert_eq!(turn["items"][1][ITEM_TIME], json!({"at":3,"source":"core"}));
    }

    #[test]
    fn whole_turn_replacement_keeps_core_records_and_omitted_native_times() {
        let old = json!({"startedAt":10,"completedAt":20,"durationMs":9_000,
            "_yuzunoStartedAt":10_100,"_yuzunoCompletedAt":20_100});
        let saved = turn_times(&old);
        let mut new = json!({"id":"t","startedAt":11,"completedAt":null,"_yuzunoCompletedAt":1});
        restore_turn_times(&mut new, saved);
        assert_eq!(new["startedAt"], 11);
        assert_eq!(new["completedAt"], 20);
        assert_eq!(new["durationMs"], 9_000);
        assert_eq!(new["_yuzunoStartedAt"], 10_100);
        assert_eq!(new["_yuzunoCompletedAt"], 20_100);
    }
}
