use super::*;

fn earlier(edit: impl Fn(&mut BTreeMap<String, Digests>)) -> BTreeMap<String, Digests> {
    let mut before = baseline();
    edit(&mut before);
    before
}

#[test]
fn the_current_catalog_has_no_changes_and_no_notice() {
    let none = changes(&baseline());
    assert!(none.is_empty(), "{none:?}");
    assert_eq!(notice(&none, None), None);
}

#[test]
fn changes_are_told_tool_by_tool_and_part_by_part() {
    let before = earlier(|before| {
        let dispatch = before.get_mut("task_dispatch").unwrap();
        dispatch.description = "earlier".into();
        dispatch.parameters.insert("executor".into(), "earlier".into());
        dispatch.parameters.remove("body");
        dispatch.parameters.insert("gone".into(), "earlier".into());
        before.remove("peers_list");
        before.insert("old_tool".into(), Digests::default());
    });
    let found = changes(&before);
    assert_eq!(found.added, ["peers_list"]);
    assert_eq!(found.removed, ["old_tool"]);
    assert_eq!(found.changed, [("task_dispatch".to_owned(), Change {
        description: true,
        // By name: an added parameter is told as a changed one.
        parameters: vec!["body".into(), "executor".into()],
        removed: vec!["gone".into()],
        required: false,
    })]);
    let text = notice(&found, None).unwrap();
    for part in ["- changed: task_dispatch", "- added: peers_list", "- removed: old_tool", "  description: \"Assign",
        "  parameter executor: {", "  parameter body: {", "  removed parameters: gone"] {
        assert!(text.contains(part), "{part}: {text}");
    }
    assert!(!text.contains("parameter materials") && !text.contains("  required:"), "{text}");
    assert!(!text.contains("Project Brief rules"), "the start text did not change: {text}");
}

#[test]
fn at_most_four_tools_are_shown_within_the_cap_and_the_rest_named() {
    let small = ["peer_read", "task_get", "task_claim", "task_comment", "task_list"];
    let before = earlier(|before| for name in small {
        before.get_mut(name).unwrap().required = "earlier".into();
    });
    let text = notice(&changes(&before), None).unwrap();
    let shown: Vec<_> = small.iter().filter(|name| text.contains(&format!("\n{name}:\n  required: "))).collect();
    assert_eq!(shown.len(), TOOLS_SHOWN, "{text}");
    assert!(text.contains("Not shown here (more than 4 tools or 6000 UTF-16 units): "), "{text}");
    // A change larger than the cap by itself: the tool's description and the
    // names of what changed; a smaller tool after it is still shown whole.
    let before = earlier(|before| {
        for value in before.get_mut("job_submit").unwrap().parameters.values_mut() {
            *value = "earlier".into();
        }
        before.get_mut("job_get").unwrap().required = "earlier".into();
    });
    let text = notice(&changes(&before), None).unwrap();
    assert!(text.contains("\njob_submit:\n  description: \"Submit"), "{text}");
    assert!(text.contains("  changed parameters (definitions not shown): argv, artifacts, "), "{text}");
    assert!(!text.contains("  parameter argv:") && !text.contains("Not shown here"), "{text}");
    assert!(text.contains("\njob_get:\n  required: "), "{text}");
    let shown = text.split("(JSON):\n").nth(1).unwrap();
    assert!(units(shown) <= UNITS);
}

#[test]
fn a_changed_start_text_is_carried_within_the_cap() {
    let long = "x".repeat(UNITS + 500);
    let text = notice(&Changes::default(), Some(&long)).unwrap();
    let carried = text.split("Now it reads:\n").nth(1).unwrap();
    assert!(units(carried) <= UNITS && carried.ends_with("… (cut)"), "{}", units(carried));
    assert!(!text.contains("Yuzuno tools:"), "{text}");
    assert_eq!(capped("short", UNITS), "short");
}

#[test]
fn a_digest_does_not_depend_on_key_order() {
    let a: Value = serde_json::from_str(r#"{"b":1,"a":{"d":2,"c":[{"f":3,"e":4}]}}"#).unwrap();
    let b: Value = serde_json::from_str(r#"{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}"#).unwrap();
    assert_eq!(canonical(&a), canonical(&b));
    assert_eq!(catalog_digest().len(), 64);
}

/// A Claude session is recorded before it has an ID; once its first Turn
/// names it, the record still describes it. Another session's record is
/// replaced silently; the same session is told once.
#[test]
fn the_record_follows_one_session_and_tells_it_once() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let detail: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{
        "id":"a","name":"A","cwd":"/tmp","model":"","color":"sage","harness":"claude",
        "status":"idle","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
        "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&detail).unwrap();
    let mut agent = store.agent("a").unwrap();
    let db = store.db.write().unwrap();
    let mails = || db.query_row("SELECT COUNT(*) FROM collaboration_messages WHERE recipient_id='a'", [], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(attach(&db, &agent, Some("start")).unwrap(), None, "a new session");
    agent.claude_session_id = Some("s1".into());
    assert_eq!(attach(&db, &agent, Some("start")).unwrap(), None, "the same session, named now, unchanged");
    assert_eq!(attach(&db, &agent, Some("start, changed")).unwrap().is_some(), true, "its start text changed");
    assert_eq!(attach(&db, &agent, Some("start, changed")).unwrap(), None, "told once");
    db.execute("UPDATE session_baselines SET start_text='earlier' WHERE agent_id='a'", []).unwrap();
    agent.claude_session_id = Some("s2".into());
    assert_eq!(attach(&db, &agent, Some("start, changed")).unwrap(), None, "another session: nothing said");
    assert_eq!(mails(), 1);
    let native: Option<String> = db.query_row("SELECT native_id FROM session_baselines", [], |r| r.get(0)).unwrap();
    assert_eq!(native.as_deref(), Some("s2"));
}

/// YN-5 R1: an unknown start text (its read failed) is compared with
/// nothing and leaves the record's as it was; a record made while it was
/// unknown says nothing of the next known one. The tools are still compared.
#[test]
fn an_unknown_start_text_is_never_taken_for_a_change() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let detail: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{
        "id":"a","name":"A","cwd":"/tmp","model":"","color":"sage","harness":"codex","threadId":"t1",
        "status":"idle","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
        "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&detail).unwrap();
    let mut agent = store.agent("a").unwrap();
    let db = store.db.write().unwrap();
    let start = || db.query_row("SELECT start_text FROM session_baselines", [], |r| r.get::<_, String>(0)).unwrap();
    assert_eq!(attach(&db, &agent, Some("with rules")).unwrap(), None);
    let known = start();
    assert_eq!(attach(&db, &agent, None).unwrap(), None, "unknown: nothing said");
    assert_eq!(start(), known, "and the record kept");
    assert_eq!(attach(&db, &agent, Some("with rules")).unwrap(), None, "the same as before");
    db.execute("UPDATE session_baselines SET tools=json_set(tools,'$.task_dispatch.required','earlier')", []).unwrap();
    assert!(attach(&db, &agent, None).unwrap().is_some(), "the tools are compared all the same");
    // Unknown for another session: recorded as unknown, then taken as it is.
    agent.thread_id = Some("t2".into());
    assert_eq!(attach(&db, &agent, None).unwrap(), None);
    assert_eq!(start(), "");
    assert_eq!(attach(&db, &agent, Some("without rules")).unwrap(), None, "unknown before: no change to tell");
    assert_eq!(start(), sha256("without rules"));
}
