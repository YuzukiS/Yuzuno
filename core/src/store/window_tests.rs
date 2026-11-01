use super::tests::{detail, lab, stream};
use super::*;
use crate::conversation_window::{self, Query};

/// What clients were sent of the whole record, as the window is checked
/// against: the record with its payloads in client form (T-140: no client
/// reads one; only this test builds it).
fn full_view(store: &Store) -> AgentDetail {
    let mut d = store.detail("a").unwrap();
    crate::codex_sessions::annotate_imported_questions_in(&store.db.read().unwrap(), &mut d).unwrap();
    crate::client_view::detail(d)
}

fn assert_equivalent(store: &Store, query: &Query) -> ConversationWindow {
    let mut full = full_view(store);
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
    // Only the Items every window lists have index entries (T-140): its
    // user messages here.
    assert_eq!(first.stats.index_build_items, 2);
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
    // Streamed output only in memory is written first: read from the rows.
    let held = assert_equivalent(&store, &Query::default());
    assert_eq!(held.stats.source, "rows");
}

/// T-26: the stored index lists a running sub-agent whose call is outside the
/// window, as the full record does; an entry an older Core cached without the
/// call's facts is rebuilt.
#[test]
fn window_rows_list_running_subagents_outside_the_window() {
    let (_dir, store) = lab();
    let mut d = history();
    d.turns[1]["items"].as_array_mut().unwrap().insert(2, json!({"id":"agent-bg","type":"claudeToolUse","name":"Agent",
        "status":"completed","input":{"description":"Survey","prompt":"Do: survey","run_in_background":true},
        "subAgent":{"status":"running","background":true,"description":"Survey","prompt":"Do: survey","taskId":"task-bg"}}));
    store.insert(&d).unwrap();
    let listed = json!([{"turnId":"t","position":[1,2],"item":{"id":"agent-bg","type":"historyPreview","status":"completed","name":"Agent",
        "_yuzunoWindowPreview":{"type":"claudeToolUse"},"subAgent":{"status":"running","background":true,"description":"Survey","taskId":"task-bg"}}}]);
    let page = assert_equivalent(&store, &Query::default());
    assert_eq!(page.stats.source, "rows");
    assert_eq!(page.conversation["runningSubAgents"], listed);
    store.db.write().unwrap().execute(
        "UPDATE agent_window_items SET data='{\"version\":1,\"item\":{\"id\":\"agent-bg\",\"type\":\"claudeToolUse\"}}' WHERE agent_id='a' AND item_id='agent-bg'",
        [],
    ).unwrap();
    let rebuilt = assert_equivalent(&store, &Query::default());
    assert_eq!(rebuilt.stats.index_build_items, 1);
    assert_eq!(rebuilt.conversation["runningSubAgents"], listed);
}

/// T-25: the stored index lists a running background shell whose call is
/// outside the window, as the full record does; an entry cached before it
/// kept a background task's status (version 2) is rebuilt.
#[test]
fn window_rows_list_running_background_tasks_outside_the_window() {
    let (_dir, store) = lab();
    let mut d = history();
    d.turns[1]["items"].as_array_mut().unwrap().insert(2, json!({"id":"shell-bg","type":"claudeToolUse","name":"Bash",
        "status":"completed","input":{"command":"tail -f build.log","run_in_background":true},
        "backgroundTask":{"status":"running","background":true,"type":"local_bash","description":"tail -f build.log","taskId":"task-sh"}}));
    store.insert(&d).unwrap();
    let listed = json!([{"turnId":"t","position":[1,2],"item":{"id":"shell-bg","type":"historyPreview","status":"completed","name":"Bash",
        "_yuzunoWindowPreview":{"type":"claudeToolUse"},
        "backgroundTask":{"status":"running","background":true,"type":"local_bash","description":"tail -f build.log","taskId":"task-sh"}}}]);
    let page = assert_equivalent(&store, &Query::default());
    assert_eq!(page.stats.source, "rows");
    assert_eq!(page.conversation["runningBackgroundTasks"], listed);
    store.db.write().unwrap().execute(
        "UPDATE agent_window_items SET data='{\"version\":2,\"item\":{\"id\":\"shell-bg\",\"type\":\"claudeToolUse\"}}' WHERE agent_id='a' AND item_id='shell-bg'",
        [],
    ).unwrap();
    let rebuilt = assert_equivalent(&store, &Query::default());
    assert_eq!(rebuilt.stats.index_build_items, 1);
    assert_eq!(rebuilt.conversation["runningBackgroundTasks"], listed);
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
        ambiguous.stats.source, "rows",
        "repeated IDs and the Pending resolution of the client view, from rows"
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
    // No index entry of its own (only the Items every window lists have
    // one, T-140): its body is read from its row, as edited.
    let changed = assert_equivalent(&store, &Query::default());
    assert_eq!(changed.stats.index_build_items, 0);
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
        0
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
fn the_rail_skips_a_last_message_that_is_blank_in_any_white_space() {
    let (_dir, store) = lab();
    let mut d = detail("a");
    d.turns = vec![json!({"id":"t","status":"completed","items":[
        {"id":"u","type":"userMessage","content":[{"type":"text","text":"Ask"}]},
        {"id":"real","type":"agentMessage","text":"The real answer"},
        {"id":"blank","type":"agentMessage","text":"\u{3000}\u{a0}\u{2003}"}
    ]})];
    store.insert(&d).unwrap();
    let page = assert_equivalent(&store, &Query::default());
    let summary = page.detail.agent.work_summary.unwrap();
    assert_eq!((summary.text.as_str(), summary.kind.as_str()), ("The real answer", "result"));
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
fn windows_read_rows_only_and_a_damaged_record_is_shown_with_why() {
    let (_dir, store) = lab();
    store.insert(&detail("a")).unwrap();
    // The journal is no record (T-140): an event only there is not shown.
    store.db.write().unwrap().execute("INSERT INTO journal(agent_id,kind,data,at) VALUES('a','item/agentMessage/delta',?1,?2)",
        params![json!({"turnId":"t","itemId":"reply","delta":"replayed"}).to_string(), now()]).unwrap();
    let rows = assert_equivalent(&store, &Query::default());
    assert_eq!(rows.stats.source, "rows");
    assert!(rows.detail.turns[0]["items"].as_array().unwrap().iter().all(|i| i["text"] != "replayed"));

    let (_dir, store) = lab();
    store.insert(&history()).unwrap();
    assert_equivalent(&store, &Query::default());
    store
        .db
        .write()
        .unwrap()
        // Every Item: a window reads only some of them.
        .execute(
            "UPDATE agent_items SET data='{' WHERE agent_id='a'",
            [],
        )
        .unwrap();
    let damaged = store
        .client_window("a", &Query::default())
        .unwrap()
        .unwrap();
    assert_eq!(damaged.stats.source, "damaged");
    assert!(damaged.detail.agent.error.is_some());
    assert!(damaged.detail.turns.is_empty());
    assert!(store.detail("a").is_err(), "a whole read finds the damage too");
}

#[test]
fn window_cache_is_published_only_for_rows_unchanged_since_it_was_built() {
    let (_dir, store) = lab();
    let mut d = detail("a");
    d.turns[0]["items"] = json!([
        {"id":"same","type":"agentMessage","text":"kept"},
        {"id":"big","type":"commandExecution","command":"ls","aggregatedOutput":"x".repeat(20000)},
        {"id":"text","type":"agentMessage","text":"before"},
        {"id":"none","type":"agentMessage","text":"no previews"},
        {"id":"count","type":"agentMessage","text":"payload count"},
        {"id":"gone","type":"agentMessage","text":"deleted"}
    ]);
    store.insert(&d).unwrap();
    let sql = |q: &str| store.db.write().unwrap().execute(q, []).unwrap();
    sql("DELETE FROM agent_window_items WHERE agent_id='a'");
    let previews: Vec<(String, bool)> = store.db.read().unwrap()
        .prepare("SELECT item_id, previews IS NOT NULL FROM agent_items WHERE agent_id='a' ORDER BY ord").unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert_eq!(previews.iter().filter(|(_, some)| *some).map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["big"],
        "one row has previews, the others none");
    let index = record_rows::window::index(&store.db.read().unwrap(), "a").unwrap();
    assert_eq!(index.fills.len(), 6);
    // Between the read and the write, as another writer or an older Core could.
    sql("UPDATE agent_items SET data=replace(data,'before','beforX') WHERE agent_id='a' AND item_id='text'");
    sql("UPDATE agent_items SET previews='' WHERE agent_id='a' AND item_id='none'");
    sql("UPDATE agent_items SET payloads=1 WHERE agent_id='a' AND item_id='count'");
    sql("DELETE FROM agent_items WHERE agent_id='a' AND item_id='gone'");
    {
        let mut writer = store.db.write().unwrap();
        let tx = writer.transaction().unwrap();
        record_rows::window::fill(&tx, "a", index.fills).unwrap();
        tx.commit().unwrap();
    }
    let published: Vec<(String, i64)> = store.db.read().unwrap()
        .prepare("SELECT item_id, json_extract(data,'$.version') FROM agent_window_items WHERE agent_id='a' ORDER BY item_id").unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert_eq!(published, [("big".to_string(), 3), ("same".to_string(), 3)],
        "same-length data, an empty preview where there was none, a payload count and a deleted row are not published");
}

/// Forty Turns of a user message, a tool output (a payload row), a reasoning
/// Item and two assistant messages, all with "needle" in them; the search
/// reads the three messages of each. A last Turn holds the only "zephyr".
fn messages() -> AgentDetail {
    let mut d = detail("a");
    d.turns = (0..40).map(|t| json!({"id":format!("t{t}"),"status":"completed","items":[
        {"id":format!("u{t}"),"type":"userMessage","clientId":format!("c{t}"),"content":[
            {"type":"text","text":format!("Needle question {t}")},{"type":"image","url":"data:image/png;base64,AAAA"}]},
        {"id":format!("run{t}"),"type":"commandExecution","command":"ls","aggregatedOutput":format!("needle {}", "x".repeat(9000))},
        {"id":format!("think{t}"),"type":"reasoning","summary":["needle thought"],"text":"needle"},
        {"id":format!("p{t}"),"type":"agentMessage","phase":"commentary","text":format!("Working on the NEEDLE {t}")},
        {"id":format!("f{t}"),"type":"agentMessage","text":format!("École {t}: the needle is here {}", "y".repeat(t * 50))}
    ]})).collect();
    d.turns[3]["items"][0]["_yuzunoInputText"] = "the original needle paste".into();
    d.turns.push(json!({"id":"last","status":"completed","items":[{"id":"rare","type":"agentMessage","text":"a unique Zephyr word"}]}));
    d
}

fn searches_agree(store: &Store) {
    let long = "n".repeat(257);
    for query in ["needle", "NEEDLE 3", "zephyr", "école", "ÉCOLE 7", "original NEEDLE", "absent", "", "   ", &long] {
        let expected = conversation_window::search(&full_view(&store), query);
        assert_eq!(store.conversation_search("a", query).unwrap(), expected, "{query:?}");
    }
}

#[test]
fn a_search_finds_what_a_search_of_the_client_detail_finds() {
    let (_dir, store) = lab();
    store.insert(&messages()).unwrap();
    assert_eq!(store.conversation_search("a", "needle").unwrap().len(), 50);
    // From rows: the window's index built by the first search, then kept.
    searches_agree(&store);
    searches_agree(&store);
    // A journaled change the rows lack is no part of the record (T-140).
    store.db.write().unwrap().execute("INSERT INTO journal(agent_id,kind,data,at) VALUES('a','item/agentMessage/delta',?1,?2)",
        params![json!({"turnId":"last","itemId":"rare","delta":" replayed needle"}).to_string(), now()]).unwrap();
    searches_agree(&store);
    assert!(store.conversation_search("a", "replayed").unwrap().is_empty());
    // Held.
    stream(&store, "a", "item/agentMessage/delta", &json!({"turnId":"last","itemId":"rare","delta":" streamed"}));
    assert_eq!(store.streamed_records(), 1);
    searches_agree(&store);
    assert_eq!(store.conversation_search("a", "streamed").unwrap().len(), 1);
    assert!(store.conversation_search("missing", "needle").is_err());
    assert!(store.conversation_search("missing", "").is_err());
}


/// T-6: the inputs a person wrote, or may have, by page from the light
/// index. Confirmed ones and unconfirmed ones apart; mail and automatic
/// continues left out; the middle of a Turn kept; an unanswered question
/// still listed; the same after the store is opened again.
#[test]
fn inputs_list_the_persons_own_by_page_from_the_light_index() {
    let (dir, store) = lab();
    let user = |id: &str, client: Option<&str>, text: &str| {
        let mut item = json!({"id":id,"type":"userMessage","content":[{"type":"text","text":text}]});
        if let Some(client) = client { item["clientId"] = client.into(); }
        item
    };
    let reply = |id: &str| json!({"id":id,"type":"agentMessage","text":format!("reply {id} {}", "x".repeat(4096))});
    let mut d = detail("a");
    d.turns = vec![
        json!({"id":"old","status":"completed","items":[user("u0", None, "before receipts"), reply("a0")]}),
        // Claude Turns no Yuzuno client started: a prompt typed in a terminal,
        // and one Claude says it started itself.
        json!({"id":"term","status":"completed","_yuzunoSource":"native","_yuzunoOrigin":"outside",
            "items":[user("t1", None, "typed in a terminal")]}),
        json!({"id":"note","status":"completed","_yuzunoSource":"native","_yuzunoOrigin":"task-notification",
            "items":[user("n1", None, "a background task finished")]}),
        json!({"id":"work","status":"inProgress","items":[
            user("u1", Some("c1"), "first of mine"), reply("a1"),
            {"id":"p1","type":"userMessage","clientId":"mail-1","_yuzunoSource":"peer","content":[{"type":"text","text":"mail"}]},
            user("u2", Some("c2"), "second of mine"),
            user("r1", Some("quota-resume-q1"), "automatic continue"),
            user("r0", Some("quota-resume-q0"), "an earlier automatic continue"),
            user("h1", Some("home-1"), "Reply from the user on Home"),
            user("f1", Some("form-1"), "form answers"),
            user("o1", Some("older-1"), "sent before origins"),
            {"id":"q","type":"agentMessage","delivery":"async","status":"completed","text":"Which?",
                "questions":[{"title":"Choose","options":["A","B"]}]},
            user("u3", Some("c3"), "third of mine"),
        ]}),
    ];
    d.turns[3]["items"].as_array_mut().unwrap().extend((0..150).map(|i| reply(&format!("b{i}"))));
    let receipt = |client: &str, origin: Value| {
        let mut r = json!({"input":{"clientMessageId":client,"text":"t"},"status":"accepted","turnId":"work","error":null});
        if !origin.is_null() { r["origin"] = origin; }
        if client.starts_with("form") { r["input"]["clarification"] = json!({"resultId":"r","formId":"f","answers":{}}); }
        serde_json::from_value(r).unwrap()
    };
    let typed = json!({"kind":"client"});
    d.message_receipts = vec![receipt("c1", typed.clone()), receipt("c2", typed.clone()), receipt("c3", typed.clone()),
        receipt("quota-resume-q1", json!({"kind":"resume"})), receipt("quota-resume-q0", Value::Null),
        receipt("home-1", json!({"kind":"home","projectId":"p","key":"decide","version":1})),
        receipt("form-1", typed), receipt("older-1", Value::Null)];
    store.insert(&d).unwrap();
    // An automatic continue from before origins: its own row says so.
    store.db.write().unwrap().execute("INSERT INTO claude_quota_resumes(id,agent_id,turn_id,session_id,resets_at,account,attempt,
        due_at,state,created_at,updated_at) VALUES('q0','a','old','s',0,'acct',1,0,'sent',0,0)", []).unwrap();
    let input = |turn: &str, item: &str, at: [usize; 2], by: &str, text: &str|
        json!({"turnId":turn,"itemId":item,"position":at,"by":by,"preview":text});
    let all = vec![input("old", "u0", [0, 0], "unconfirmed", "before receipts"),
        input("term", "t1", [1, 0], "unconfirmed", "typed in a terminal"), input("work", "u1", [3, 0], "you", "first of mine"),
        input("work", "u2", [3, 3], "you", "second of mine"), input("work", "h1", [3, 6], "home", "Reply from the user on Home"),
        input("work", "f1", [3, 7], "form", "form answers"), input("work", "o1", [3, 8], "unconfirmed", "sent before origins"),
        input("work", "u3", [3, 10], "you", "third of mine")];
    let page = |store: &Store, before: Option<&str>, limit: Option<usize>| store.conversation_inputs("a",
        &conversation_window::InputsQuery { before: before.map(str::to_owned), limit }).unwrap();
    let pages = |store: &Store| {
        assert_eq!(page(store, None, None).unwrap(), json!({"inputs":all,"hasBefore":false,"total":8}));
        assert_eq!(page(store, None, Some(3)).unwrap(), json!({"inputs":all[5..],"hasBefore":true,"total":8}));
        assert_eq!(page(store, Some(r#"["work","f1"]"#), Some(3)).unwrap(), json!({"inputs":all[2..5],"hasBefore":true,"total":8}));
        assert_eq!(page(store, Some(r#"["work","u1"]"#), Some(3)).unwrap(), json!({"inputs":all[..2],"hasBefore":false,"total":8}));
        // Not an input of this list: mail, Claude's own, or no such Item.
        assert!(page(store, Some(r#"["work","p1"]"#), None).is_err());
        assert!(page(store, Some(r#"["note","n1"]"#), None).is_err());
        assert!(page(store, Some(r#"["work","nope"]"#), None).is_err());
    };
    pages(&store);
    // Each body says who it came from, and the question stays listed, on
    // whichever page shows it.
    let tail = assert_equivalent(&store, &Query::default());
    assert!(tail.conversation["hasBefore"] == true, "the inputs are not on the newest page");
    let start = Query { turn_id: Some("work".into()), item_id: Some("u1".into()), ..Default::default() };
    let shown = assert_equivalent(&store, &start);
    for window in [&tail, &shown] {
        assert_eq!(window.conversation["questions"][0]["items"][0]["id"], "q");
    }
    let native = assert_equivalent(&store, &Query { turn_id: Some("term".into()), ..Default::default() });
    let first_input = |turn: &str| native.detail.turns.iter().find(|t| t["id"] == turn).unwrap()["items"][0]["_yuzunoInput"].clone();
    assert_eq!((first_input("term"), first_input("note")), (json!("unconfirmed"), json!("native")));
    let by: Vec<_> = shown.detail.turns.iter().flat_map(|turn| turn["items"].as_array().unwrap())
        .filter(|item| item["type"] == "userMessage").map(|item| (item["id"].as_str().unwrap(), item["_yuzunoInput"].as_str().unwrap())).collect();
    assert_eq!(by, [("u1", "you"), ("p1", "peer"), ("u2", "you"), ("r1", "resume"), ("r0", "resume"), ("h1", "home"),
        ("f1", "form"), ("o1", "unconfirmed"), ("u3", "you")]);
    drop(store);
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    pages(&store);
}

/// T-9: a Home reply's `_yuzunoHome` comes from Core's receipt only: where
/// it came from always, its snapshot only in the format and shape Core
/// writes, and whole however long, in the window as in the whole record.
/// A receipt from before snapshots has none, and neither has one of an
/// unknown format, another shape or a size Core never writes; text typed in
/// the composer, or a body that names one itself, gets no `_yuzunoHome`.
#[test]
fn a_home_reply_shows_its_snapshot_only_from_cores_receipt() {
    let (dir, store) = lab();
    let snapshot = |text: &str| json!({"format":1,"projectName":"Code","sectionKind":"ask","title":"About decide","question":"Which way?",
        "options":[{"id":"left","label":"Left"},{"id":"right","label":"Right"}],"choice":{"id":"left","label":"Left"},"text":text,
        "form":{"id":"prefs","title":"Setup","fields":[{"id":"theme","label":"Theme","type":"single","answer":"Dark"},
            {"id":"checks","label":"Checks","type":"multi","answer":["Keyboard"]}]}});
    let with = |key: &str, value: Value| {
        let mut changed = snapshot("Go");
        if value.is_null() { changed.as_object_mut().unwrap().remove(key); } else { changed[key] = value; }
        changed
    };
    let origin = |home: Value| {
        let mut origin = json!({"kind":"home","projectId":"p","key":"decide","version":1,"workspaceId":"w"});
        if !home.is_null() { origin["home"] = home; }
        origin
    };
    // Longer than the 8 KiB a field is trimmed above.
    let long = format!("{}end", "word ".repeat(4000));
    let receipts = [
        ("h1", origin(snapshot("Go"))),
        ("h2", origin(snapshot(&long))),
        ("h3", origin(Value::Null)),
        ("h4", origin(with("format", json!(2)))),
        ("h5", origin(with("more", json!(1)))),
        ("h6", origin(with("form", Value::Null))),
        ("h7", origin(with("text", json!(["Go"])))),
        ("h8", origin(with("sectionKind", json!("note")))),
        ("h9", origin(with("choice", json!({"id":"left"})))),
        ("h10", origin(with("text", json!("x".repeat(130 * 1024))))),
        ("h11", json!({"kind":"home","version":1,"home":snapshot("Go")})),
        ("t1", json!({"kind":"client","home":snapshot("Go")})),
    ];
    let user = |id: &str, client: &str| json!({"id":id,"type":"userMessage","clientId":client,
        "content":[{"type":"text","text":"Reply from the user on Home, to version 1 of the Project Brief section `decide`"}]});
    let mut forged = user("x1", "nobody");
    forged["_yuzunoHome"] = json!({"projectId":"p","key":"decide","version":1,"workspaceId":"w","snapshot":snapshot("Forged")});
    let mut d = detail("a");
    let mut items: Vec<Value> = receipts.iter().map(|(client, _)| user(&format!("i-{client}"), *client)).collect();
    items.push(forged);
    d.turns = vec![json!({"id":"work","status":"completed","items":items})];
    d.message_receipts = receipts.iter().map(|(client, origin)| serde_json::from_value(json!({"input":{"clientMessageId":client,"text":"t"},
        "status":"accepted","turnId":"work","error":null,"origin":origin})).unwrap()).collect();
    store.insert(&d).unwrap();
    let identity = json!({"projectId":"p","key":"decide","version":1,"workspaceId":"w"});
    let whole = |text: &str| { let mut home = identity.clone(); home["snapshot"] = snapshot(text); home };
    let check = |store: &Store| {
        for query in [Query::default(), Query { turn_id: Some("work".into()), item_id: Some("i-h2".into()), ..Default::default() }] {
            let window = assert_equivalent(store, &query);
            let item = |id: &str| window.detail.turns[0]["items"].as_array().unwrap().iter().find(|item| item["id"] == id).unwrap().clone();
            let shown = |id: &str| (item(id)["_yuzunoInput"].clone(), item(id)["_yuzunoHome"].clone());
            assert_eq!(shown("i-h1"), (json!("home"), whole("Go")));
            assert_eq!(shown("i-h2"), (json!("home"), whole(&long)), "whole, however long");
            for id in ["i-h3", "i-h4", "i-h5", "i-h6", "i-h7", "i-h8", "i-h9", "i-h10"] {
                assert_eq!(shown(id), (json!("home"), identity.clone()), "{id}");
            }
            assert_eq!(shown("i-h11"), (json!("home"), Value::Null));
            assert_eq!(shown("i-t1"), (json!("you"), Value::Null));
            assert_eq!(shown("x1"), (json!("unconfirmed"), Value::Null));
        }
    };
    check(&store);
    drop(store);
    check(&Store::open(&dir.path().join("workspace.sqlite")).unwrap());
}
