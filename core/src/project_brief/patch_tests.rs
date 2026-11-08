//! brief_update's patch op (YN-14 A2), through the generated validator as
//! Core runs it: RFC 6902 operations on a section's body, kept and checked
//! as an edit is.
use super::*;

fn checker() -> Checker {
    Checker::Node(Arc::new(crate::results::Validator::from_env()))
}

/// A status with a task list, as a lead keeps one.
fn work() -> Value {
    json!({"op":"put","key":"work","kind":"status","title":"Who has what",
        "status":{"asOf":"2026-11-07T08:00:00Z","validFor":86400},
        "body":{"root":"body","elements":{
            "body":{"type":"BriefBody","props":{},"children":["summary","tasks"]},
            "summary":{"type":"Markdown","props":{"text":"Two slices in review."}},
            "tasks":{"type":"LiveRefs","props":{"layout":"list","items":[
                {"kind":"task","id":"T-12","note":"In review."},
                {"kind":"task","id":"T-13","note":"Waiting for CI."},
                {"kind":"task","id":"T-14"}]}}}}})
}

fn patch(key: &str, ops: Value) -> Value {
    json!({"op":"patch","key":key,"patch":ops})
}

async fn send(ws: &Arc<Workspace>, actor: &str, input: Value) -> Result<Value, Value> {
    update::update(ws, &checker(), actor, input).await.unwrap()
}

#[tokio::test]
async fn a_patch_changes_one_value_and_keeps_the_rest_as_an_edit_does() {
    let (_dir, ws, project) = lab();
    send(&ws, "a", input("w1", 0, vec![work()])).await.unwrap();
    let before = section(&brief(&ws, "a"), "work").clone();
    let mut change = patch("work", json!([{"op":"replace","path":"/elements/tasks/props/items/1/note","value":"Merged."}]));
    change["status"] = json!({"asOf":"2026-11-07T09:00:00Z","validFor":86400});
    let accepted = send(&ws, "a", input("w2", 1, vec![change])).await.unwrap();
    assert_eq!(accepted["sections"], json!([{"key":"work","version":2}]));
    let after = section(&brief(&ws, "a"), "work").clone();
    let mut expected = before["body"].clone();
    expected["elements"]["tasks"]["props"]["items"][1]["note"] = json!("Merged.");
    assert_eq!(after["body"], expected, "only that note changed");
    assert_eq!((after["title"].clone(), after["status"]["asOf"].clone()), (before["title"].clone(), json!("2026-11-07T09:00:00Z")));
    assert_eq!(version(&ws, &project), 2);

    // A block added and named under the root in the same patch.
    let added = patch("work", json!([
        {"op":"add","path":"/elements/next","value":{"type":"Markdown","props":{"text":"Next: S3."}}},
        {"op":"add","path":"/elements/body/children/-","value":"next"}]));
    send(&ws, "a", input("w3", 2, vec![added])).await.unwrap();
    let read = brief(&ws, "a");
    let body = &section(&read, "work")["body"];
    assert_eq!((body["elements"]["body"]["children"].clone(), body["elements"]["next"]["props"]["text"].clone()),
        (json!(["summary", "tasks", "next"]), json!("Next: S3.")));
}

#[tokio::test]
async fn a_patch_keeps_a_replied_ask_replied() {
    let (_dir, ws, project) = lab();
    send(&ws, "a", input("q1", 0, vec![put("next-run", "ask")])).await.unwrap();
    assert!(sections::mark_replied_live(&ws.store, &project, "next-run", "Left").unwrap());
    let note = patch("next-run", json!([{"op":"replace","path":"/elements/note/props/text","value":"Running it now."}]));
    send(&ws, "a", input("q2", 1, vec![note])).await.unwrap();
    let ask = section(&brief(&ws, "a"), "next-run").clone();
    assert_eq!((ask["ask"]["state"].clone(), ask["body"]["elements"]["note"]["props"]["text"].clone()), (json!("replied"), json!("Running it now.")));
}

#[tokio::test]
async fn a_patch_that_cannot_apply_is_refused_by_its_operation_and_changes_nothing() {
    let (_dir, ws, project) = lab();
    send(&ws, "a", input("w1", 0, vec![work()])).await.unwrap();
    let before = section(&brief(&ws, "a"), "work").clone();
    let refused = |rejected: Value| (codes(&rejected), rejected["problems"][0]["path"].clone(), rejected["problems"][0]["reason"].clone());

    let missing = patch("work", json!([{"op":"test","path":"/elements/tasks/props/items/0/note","value":"In review."},
        {"op":"replace","path":"/elements/tasks/props/items/3/note","value":"x"}]));
    let (code, path, reason) = refused(send(&ws, "a", input("m", 1, vec![missing])).await.unwrap_err());
    assert_eq!((code, path), (vec!["patch_path".to_owned()], json!("changes[0].patch[1].path")));
    assert!(reason.as_str().unwrap().starts_with("/elements/tasks/props/items has 3 entries (0-2)"), "{reason}");

    let stale = patch("work", json!([{"op":"test","path":"/elements/summary/props/text","value":"Something else."},
        {"op":"replace","path":"/elements/summary/props/text","value":"x"}]));
    let (code, path, _) = refused(send(&ws, "a", input("t", 1, vec![stale])).await.unwrap_err());
    assert_eq!((code, path), (vec!["patch_test".to_owned()], json!("changes[0].patch[0].path")));

    // Its shape is checked before anything is read.
    for (ops, at) in [
        (json!([{"op":"replace","path":"/elements/summary/props/text"}]), "changes[0].patch[0].value"),
        (json!([{"op":"merge","path":"/elements"}]), "changes[0].patch[0].op"),
        (json!([{"op":"remove","path":"/elements/summary","value":1}]), "changes[0].patch[0].value"),
        (json!([]), "changes[0].patch"),
    ] {
        let rejected = send(&ws, "a", input("s", 1, vec![patch("work", ops)])).await.unwrap_err();
        assert_eq!((codes(&rejected), rejected["problems"][0]["path"].clone()), (vec!["invalid_change".to_owned()], json!(at)));
    }
    let mut extra = patch("work", json!([{"op":"remove","path":"/elements/summary"}]));
    extra["title"] = json!("New title");
    assert_eq!(codes(&send(&ws, "a", input("e", 1, vec![extra])).await.unwrap_err()), ["invalid_change"]);
    assert_eq!(section(&brief(&ws, "a"), "work"), &before);
    assert_eq!(version(&ws, &project), 1);
}

/// #718 R1: a patch that would build a body far over the limit is refused by
/// its operation before the validator, and nothing is written.
#[tokio::test]
async fn a_patch_that_keeps_copying_a_part_into_itself_is_refused_and_writes_nothing() {
    let (_dir, ws, project) = lab();
    send(&ws, "a", input("w1", 0, vec![work()])).await.unwrap();
    let before = section(&brief(&ws, "a"), "work").clone();
    let ops: Vec<Value> = (0..patch::MAX_OPS).map(|n| json!({"op":"copy","from":"/elements","path":format!("/elements/c{n}")})).collect();
    let rejected = send(&ws, "a", input("grow", 1, vec![patch("work", json!(ops))])).await.unwrap_err();
    assert_eq!(codes(&rejected), ["too_large"], "{rejected}");
    assert!(rejected["problems"][0]["path"].as_str().unwrap().starts_with("changes[0].patch["));
    assert_eq!((section(&brief(&ws, "a"), "work"), version(&ws, &project)), (&before, 1));
}

#[tokio::test]
async fn a_patched_body_is_checked_whole_repaired_where_it_can_be_and_refused_where_not() {
    let (_dir, ws, _project) = lab();
    send(&ws, "a", input("w1", 0, vec![work()])).await.unwrap();
    // A slip Core can fix is repaired as for an edit; the paths name the patched body.
    let unknown = patch("work", json!([{"op":"replace","path":"/elements/summary","value":{"type":"Code","props":{"code":"FAIL x"}}}]));
    let repaired = send(&ws, "a", input("w2", 1, vec![unknown])).await.unwrap();
    assert_eq!((repaired["repairs"][0]["code"].clone(), repaired["repairs"][0]["path"].clone()),
        (json!("component_to_markdown"), json!("changes[0].body.elements.summary")), "{repaired}");
    let wrong = patch("work", json!([{"op":"replace","path":"/elements/tasks/props/items/0/kind","value":42}]));
    let rejected = send(&ws, "a", input("w3", 2, vec![wrong])).await.unwrap_err();
    assert_eq!((codes(&rejected), rejected["problems"][0]["path"].clone()),
        (vec!["invalid_field".to_owned()], json!("changes[0].body.elements.tasks.props.items.0.kind")), "{rejected}");
}

#[tokio::test]
async fn a_patch_follows_the_owner_ask_only_and_version_rules() {
    let (_dir, ws, project) = lab();
    send(&ws, "a", input("w1", 0, vec![work()])).await.unwrap();
    let note = || patch("work", json!([{"op":"replace","path":"/elements/summary/props/text","value":"Mine now."}]));
    assert_eq!(codes(&send(&ws, "b", input("b1", 1, vec![note()])).await.unwrap_err()), ["not_owner"]);
    send(&ws, "a", input("w2", 1, vec![note()])).await.unwrap();
    // Read at 1, the section written at 2: a conflict by its own key.
    let stale = send(&ws, "a", input("w3", 1, vec![note()])).await.unwrap_err();
    assert_eq!((codes(&stale), stale["problems"][0]["path"].clone()), (vec!["version_conflict".to_owned()], json!("changes[0].key")));
    // An Ask-only member patches its own ask, never its report.
    send(&ws, "c", input("c1", 2, vec![put("c-ask", "ask"), put("c-notes", "report")])).await.unwrap();
    set_leads(&ws, &project, &["a", "b"]);
    let text = |key: &str| patch(key, json!([{"op":"replace","path":"/elements/note/props/text","value":"Updated."}]));
    send(&ws, "c", input("c2", 3, vec![text("c-ask")])).await.unwrap();
    assert_eq!(codes(&send(&ws, "c", input("c3", 4, vec![text("c-notes")])).await.unwrap_err()), ["ask_only"]);
}

/// YN-14 A3: a put with markdown is stored with the body Core builds for it,
/// and a later patch reaches its text.
#[tokio::test]
async fn a_markdown_put_is_stored_as_its_built_body_and_patched_like_any_other() {
    let (dir, ws, _project) = lab();
    let file = dir.path().join("preview.png");
    std::fs::write(&file, b"fixture image bytes").unwrap();
    let change = json!({"op":"put","key":"release","kind":"report","title":"core.25","size":"wide",
        "markdown":"**core.25** is out.","attachments":[{"name":"preview.png","path":file}]});
    let accepted = send(&ws, "a", input("m1", 0, vec![change])).await.unwrap();
    assert_eq!(accepted["repairs"], Value::Null, "a markdown put needs no repair: {accepted}");
    let stored = section(&brief(&ws, "a"), "release").clone();
    assert_eq!(stored["body"], json!({"root":"body","elements":{
        "body":{"type":"BriefBody","props":{"summary":{"lead":"text","size":"wide"}},"children":["text","files"]},
        "text":{"type":"Markdown","props":{"text":"**core.25** is out."}},
        "files":{"type":"Attachments","props":{"items":[{"name":"preview.png"}]}}}}));
    let note = patch("release", json!([{"op":"replace","path":"/elements/text/props/text","value":"**core.25** is out and installed."}]));
    send(&ws, "a", input("m2", 1, vec![note])).await.unwrap();
    assert_eq!(section(&brief(&ws, "a"), "release")["body"]["elements"]["text"]["props"]["text"], "**core.25** is out and installed.");
    let both = json!({"op":"put","key":"other","kind":"report","title":"Both","markdown":"x","body":stored["body"]});
    let rejected = send(&ws, "a", input("m3", 2, vec![both])).await.unwrap_err();
    assert_eq!((codes(&rejected), rejected["problems"][0]["path"].clone()), (vec!["invalid_field".to_owned()], json!("changes[0].markdown")));
}

/// YN-31: a table's rows by id, as elasticLM keeps them (r1…r14): a row
/// added above r8 leaves @r8 naming r8, and an id that names no row, or two,
/// refuses the patch by its operation and writes nothing.
#[tokio::test]
async fn a_patch_names_a_table_row_by_its_id() {
    let (_dir, ws, project) = lab();
    let rows: Vec<Value> = (1..=14).map(|n| json!({"id":format!("r{n}"),"cells":{"run":format!("run {n}"),"status":"queued"}})).collect();
    let runs = json!({"op":"put","key":"runs","kind":"status","title":"Runs",
        "status":{"asOf":"2026-11-07T08:00:00Z","validFor":86400},
        "body":{"root":"body","elements":{
            "body":{"type":"BriefBody","props":{},"children":["summary","table"]},
            "summary":{"type":"Markdown","props":{"text":"Fourteen runs queued."}},
            "table":{"type":"Table","props":{"id":"runs","title":"Runs",
                "columns":[{"key":"run","label":"Run"},{"key":"status","label":"Status"}],"rows":rows}}}}});
    send(&ws, "a", input("r1", 0, vec![runs])).await.unwrap();
    let before = section(&brief(&ws, "a"), "runs").clone();

    let changed = patch("runs", json!([
        {"op":"add","path":"/elements/table/props/rows/0","value":{"id":"r0","cells":{"run":"run 0","status":"done"}}},
        {"op":"replace","path":"/elements/table/props/rows/@r8/cells/status","value":"done"}]));
    send(&ws, "a", input("r2", 1, vec![changed])).await.unwrap();
    let after = section(&brief(&ws, "a"), "runs").clone();
    let mut expected = before["body"].clone();
    let table = expected["elements"]["table"]["props"]["rows"].as_array_mut().unwrap();
    table[7]["cells"]["status"] = json!("done");
    table.insert(0, json!({"id":"r0","cells":{"run":"run 0","status":"done"}}));
    assert_eq!(after["body"], expected, "r8, now the ninth row, is done; nothing else changed");

    let refused = |rejected: Value| (codes(&rejected), rejected["problems"][0]["path"].clone(), rejected["problems"][0]["reason"].clone());
    let unknown = patch("runs", json!([{"op":"replace","path":"/elements/table/props/rows/@r15/cells/status","value":"done"}]));
    let (code, path, reason) = refused(send(&ws, "a", input("r3", 2, vec![unknown])).await.unwrap_err());
    assert_eq!((code, path), (vec!["patch_path".to_owned()], json!("changes[0].patch[0].path")));
    assert_eq!(reason, "/elements/table/props/rows has no item whose id is \"r15\"; its ids are r0, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, ….");
    let twice = patch("runs", json!([{"op":"copy","from":"/elements/table/props/rows/@r8","path":"/elements/table/props/rows/-"},
        {"op":"replace","path":"/elements/table/props/rows/@r8/cells/status","value":"failed"}]));
    let (code, path, reason) = refused(send(&ws, "a", input("r4", 2, vec![twice])).await.unwrap_err());
    assert_eq!((code, path), (vec!["patch_path".to_owned()], json!("changes[0].patch[1].path")));
    assert_eq!(reason, "/elements/table/props/rows has 2 items whose id is \"r8\" (at 8, 15): name one by its index.");
    assert_eq!((section(&brief(&ws, "a"), "runs"), version(&ws, &project)), (&after, 2));
}
