use super::tests::{detail, lab, stream};
use super::*;
use crate::conversation_window::{self, Query};

fn assert_equivalent(store: &Store, query: &Query) -> ConversationWindow {
    let mut full = store.client_detail("a").unwrap();
    let expected = conversation_window::project(&mut full, query).unwrap();
    let window = store.client_window("a", query).unwrap().unwrap();
    assert_eq!(window.conversation, expected);
    let actual = serde_json::to_value(&window.detail).unwrap();
    let full = serde_json::to_value(full).unwrap();
    assert!(
        actual == full,
        "window differs from full projection (source={})",
        window.stats.source
    );
    window
}

fn history() -> AgentDetail {
    let mut d = detail("a");
    d.turns = vec![
        json!({"id":"empty","status":"failed","error":{"message":"failure"},"items":[]}),
        json!({"id":"t","status":"inProgress","_claudeScratch":"private","items":[
            {"id":"u","type":"userMessage","clientId":"receipt","_yuzunoInputText":"🦊 original paste".repeat(300),
                "content":[{"type":"text","text":"transformed"}]},
            {"id":"q","type":"agentMessage","delivery":"async","status":"completed","text":"outside body",
                "questions":[{"title":"Choose","options":["A","B"]}]}
        ]}),
    ];
    d.turns[1]["items"].as_array_mut().unwrap().extend((0..350).map(|i| json!({"id":format!("i{i}"),"type":"agentMessage",
        "text":format!("body {i} {}", "x".repeat(4096)),"_yuzunoCompletedText":format!("completed {i}")})));
    d
}

#[test]
fn windows_keep_full_metadata_while_body_reads_are_bounded_in_rows_and_held() {
    let (_dir, store) = lab();
    store.insert(&history()).unwrap();
    store
        .db
        .write()
        .unwrap()
        .execute(
            "INSERT INTO codex_imports(agent_id,thread_id,awaiting_handoff) VALUES('a','thread',0)",
            [],
        )
        .unwrap();
    store
        .db
        .write()
        .unwrap()
        .execute(
            "INSERT INTO codex_import_turns(agent_id,turn_id) VALUES('a','t')",
            [],
        )
        .unwrap();
    let first = assert_equivalent(&store, &Query::default());
    assert_eq!(first.stats.source, "rows");
    assert_eq!(first.stats.index_build_items, 352);
    let page = assert_equivalent(&store, &Query::default());
    assert_eq!(page.stats.index_build_items, 0);
    assert!(page.stats.body_items <= conversation_window::MAX_ITEMS + 3);
    assert!(page.stats.body_json_bytes < 500_000);
    assert_eq!(page.conversation["nativeClientIds"], json!(["receipt"]));
    assert_eq!(
        page.conversation["questions"][0]["_yuzunoImportedQuestions"],
        true
    );
    for query in [
        Query {
            before: page.conversation["start"].as_str().map(str::to_owned),
            ..Default::default()
        },
        Query {
            after: page.conversation["start"].as_str().map(str::to_owned),
            ..Default::default()
        },
        Query {
            turn_id: Some("t".into()),
            item_id: Some("i100".into()),
            ..Default::default()
        },
        Query {
            turn_id: Some("empty".into()),
            ..Default::default()
        },
    ] {
        assert_equivalent(&store, &query);
    }
    stream(
        &store,
        "a",
        "item/agentMessage/delta",
        &json!({"turnId":"t","itemId":"i349","delta":" live"}),
    );
    let held = assert_equivalent(&store, &Query::default());
    assert_eq!(held.stats.source, "held");
    assert_eq!(held.stats.body_json_bytes, 0);
}

#[test]
fn window_rows_rebuild_only_changed_entries_and_keep_duplicate_ids_and_pending_payloads() {
    let (_dir, store) = lab();
    let mut d = detail("a");
    d.turns[0]["items"] = json!([
        {"id":"dup","type":"claudeToolUse","name":"Read","input":{"text":"x".repeat(15000)},"output":"first"},
        {"id":"dup","type":"claudeToolUse","name":"Read","input":{"text":"y".repeat(15000)},"output":"second"},
        {"type":"agentMessage","text":"no id"},
        {"id":"~literal","type":"agentMessage","text":"literal position-like id"}
    ]);
    d.pending.push(
        serde_json::from_value(json!({"id":"p","agentId":"a","method":"claude/canUseTool",
        "params":{"toolUseId":"dup"},"createdAt":""}))
        .unwrap(),
    );
    store.insert(&d).unwrap();
    let ambiguous = assert_equivalent(&store, &Query::default());
    assert_eq!(
        ambiguous.stats.source, "fallback",
        "preserve legacy Pending resolution for repeated IDs"
    );
    // A separate new record exercises Rows without update/restart recovery
    // holding it. Pending compatibility above is an independent fixture.
    let (_rows_dir, store) = lab();
    d.pending.clear();
    store.insert(&d).unwrap();
    assert_eq!(store.streamed_records(), 0);
    assert_equivalent(&store, &Query::default());
    let query = Query {
        turn_id: Some("t".into()),
        item_id: Some("dup".into()),
        ..Default::default()
    };
    let page = assert_equivalent(&store, &query);
    assert_eq!(page.stats.source, "rows");
    assert_eq!(page.detail.turns[0]["items"][0]["output"], "first");
    assert_eq!(page.detail.turns[0]["items"][1]["output"], "second");
    assert_eq!(page.stats.index_build_items, 0);
    // A direct edit, like an older Core, cannot leave a stale entry usable.
    store.db.write().unwrap().execute("UPDATE agent_items SET data=json_set(data,'$.text','changed') WHERE agent_id='a' AND item_id='~literal'", []).unwrap();
    // The literal native ID itself has a positional row key.
    store.db.write().unwrap().execute("UPDATE agent_items SET data=json_set(data,'$.text','changed') WHERE agent_id='a' AND ord=3", []).unwrap();
    let changed = assert_equivalent(&store, &Query::default());
    assert_eq!(changed.stats.index_build_items, 1);
    assert_eq!(changed.detail.turns[0]["items"][3]["text"], "changed");
    store
        .db
        .write()
        .unwrap()
        .execute(
            "UPDATE agent_window_items SET data='broken' WHERE agent_id='a' AND item_id='~3'",
            [],
        )
        .unwrap();
    assert_eq!(
        assert_equivalent(&store, &Query::default())
            .stats
            .index_build_items,
        1
    );
}

#[test]
fn window_rows_load_pending_payloads_without_losing_off_page_requests() {
    let (_dir, store) = lab();
    let mut d = history();
    d.turns[1]["items"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"review-tool","type":"claudeToolUse",
        "name":"Read","input":{"text":"x".repeat(15000)}}));
    d.pending.push(
        serde_json::from_value(json!({"id":"p","agentId":"a","method":"claude/canUseTool",
        "params":{"toolUseId":"review-tool"},"createdAt":""}))
        .unwrap(),
    );
    store.insert(&d).unwrap();
    let page = assert_equivalent(&store, &Query::default());
    assert_eq!(page.stats.source, "rows");
    assert_eq!(
        page.detail.turns.last().unwrap()["items"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["input"]["text"],
        "x".repeat(15000)
    );
    let old = assert_equivalent(
        &store,
        &Query {
            turn_id: Some("t".into()),
            item_id: Some("i1".into()),
            ..Default::default()
        },
    );
    assert_eq!(old.detail.pending[0].id, "p");
    assert_eq!(
        old.detail.agent.work_summary.as_ref().unwrap().kind,
        "pending"
    );
}

#[test]
fn window_reads_retry_racing_rewrites_and_streams_without_publishing_stale_indexes() {
    for held in [false, true] {
        let (_dir, store) = lab();
        store.insert(&history()).unwrap();
        let mut once = true;
        let window = store
            .client_window_racing("a", &Query::default(), || {
                if !std::mem::take(&mut once) {
                    return;
                }
                if held {
                    stream(
                        &store,
                        "a",
                        "item/agentMessage/delta",
                        &json!({"turnId":"t","itemId":"i349","delta":" new"}),
                    );
                } else {
                    store
                        .update("a", "test/rewrite", &json!({}), |d| {
                            d.turns[1]["items"][351]["text"] = "rewritten".into()
                        })
                        .unwrap();
                }
            })
            .unwrap()
            .unwrap();
        let expected = assert_equivalent(&store, &Query::default());
        assert_eq!(
            serde_json::to_value(window.detail).unwrap(),
            serde_json::to_value(expected.detail).unwrap()
        );
        assert_eq!(window.conversation, expected.conversation);
    }
}

#[test]
fn window_fallback_keeps_replay_and_damage_behavior() {
    let (_dir, store) = lab();
    store.insert(&detail("a")).unwrap();
    store.db.write().unwrap().execute("INSERT INTO journal(agent_id,kind,data,at) VALUES('a','item/agentMessage/delta',?1,?2)",
        params![json!({"turnId":"t","itemId":"reply","delta":"replayed"}).to_string(), now()]).unwrap();
    let replay = assert_equivalent(&store, &Query::default());
    assert_eq!(replay.stats.source, "fallback");
    assert_eq!(replay.detail.turns[0]["items"][0]["text"], "replayed");

    let (_dir, store) = lab();
    store.insert(&history()).unwrap();
    assert_equivalent(&store, &Query::default());
    store
        .db
        .write()
        .unwrap()
        .execute(
            "UPDATE agent_items SET data='{' WHERE agent_id='a' AND item_id='i1'",
            [],
        )
        .unwrap();
    let damaged = store
        .client_window("a", &Query::default())
        .unwrap()
        .unwrap();
    assert_eq!(damaged.stats.source, "fallback");
    assert!(damaged.detail.agent.error.is_some());
    assert_equivalent(&store, &Query::default());
}
