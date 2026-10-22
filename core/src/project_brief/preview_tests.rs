//! T-176: brief_update with validateOnly answers with the problems the same
//! update would get, and writes nothing.
use super::{
    attachments, editors, sections,
    tests::lab,
    update::{self, Checker},
    *,
};

/// As in tests.rs: a section titled INVALID is the validator's problem.
fn fake(section: &Value) -> Result<Value, Value> {
    if section["title"] == "INVALID" {
        return Err(json!([{"code":"invalid_body","path":"body","reason":"Not a body.","guide":"brief_guide content"}]));
    }
    Ok(section.clone())
}
const FAKE: Checker = Checker::Fake(fake);

fn put(key: &str) -> Value {
    json!({"op":"put","key":key,"kind":"report","title":format!("About {key}"),
        "body":{"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["note"]},
            "note":{"type":"Markdown","props":{"text":"Hello"}}}}})
}

fn invalid(key: &str) -> Value {
    let mut change = put(key);
    change["title"] = json!("INVALID");
    change
}

fn input(request: &str, version: i64, changes: Vec<Value>) -> Value {
    json!({"requestId":request,"expectedVersion":version,"changes":changes})
}

fn only(mut input: Value) -> Value {
    input["validateOnly"] = json!(true);
    input
}

/// A preview is always an answer, never a rejection.
async fn preview(ws: &Arc<Workspace>, actor: &str, input: Value) -> Value {
    let answer = update::update(ws, &FAKE, actor, only(input)).await.unwrap();
    assert!(answer.is_ok(), "{answer:?}");
    let answer = answer.unwrap();
    assert_eq!(answer["validateOnly"], true);
    assert!(answer.get("receipt").is_none() && answer.get("accepted").is_none(), "{answer}");
    answer
}

/// What nothing in a preview may change: the Brief version, receipts,
/// recorded requests, snapshots, the attachment cache and the change feed.
fn footprint(ws: &Workspace, project: &str) -> Value {
    let db = ws.store.db.read().unwrap();
    let count = |table: &str| -> i64 { db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap() };
    json!({"version":sections::brief_version(&db, project).unwrap(),
        "receipts":count("project_brief_receipts"),"requests":count("collaboration_requests"),
        "snapshots":count("project_brief_snapshots"),"sections":count("project_brief_sections"),
        "cache":attachments::dir(&ws.data_dir).exists(),"events":ws.changes.head()})
}

/// The same input, previewed and then sent: the preview names the same
/// problems (and latest Brief), and the update after it is unaffected by it.
async fn same_problems(ws: &Arc<Workspace>, project: &str, actor: &str, input: Value) -> Value {
    let before = footprint(ws, project);
    let previewed = preview(ws, actor, input.clone()).await;
    assert_eq!(footprint(ws, project), before, "a preview changed something");
    assert_eq!(previewed["valid"], false);
    let rejected = update::update(ws, &FAKE, actor, input).await.unwrap().unwrap_err();
    for field in ["problems", "moreProblems", "latest"] {
        assert_eq!(previewed.get(field), rejected.get(field), "{field}");
    }
    rejected
}

fn codes(answer: &Value) -> Vec<String> {
    answer["problems"].as_array().unwrap().iter().map(|p| p["code"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn a_valid_preview_writes_nothing_and_the_update_then_goes_through() {
    let (_dir, ws, project) = lab();
    let before = footprint(&ws, &project);
    let checked = preview(&ws, "a", input("r1", 0, vec![put("plan")])).await;
    assert_eq!((checked["valid"].clone(), checked["problems"].clone()), (json!(true), json!([])));
    assert!(checked["note"].as_str().unwrap().contains("Nothing was written"));
    // Even without a requestId, and with noChange.
    preview(&ws, "a", json!({"expectedVersion":0,"changes":[put("plan")]})).await;
    preview(&ws, "a", json!({"expectedVersion":0,"noChange":true})).await;
    assert_eq!(footprint(&ws, &project), before);
    assert_eq!(turn_receipt(&ws.store, "a", "t1").unwrap(), None, "a preview is not the Turn's update");
    // Its requestId was not kept: the same one may carry another update.
    let sent = update::update(&ws, &FAKE, "a", input("r1", 0, vec![put("other")])).await.unwrap().unwrap();
    assert_eq!(sent["receipt"]["kind"], "updated");
    assert_ne!(footprint(&ws, &project)["events"], before["events"], "the real update is announced");
    // And a requestId already used is checked afresh, not replayed.
    let again = preview(&ws, "a", input("r1", 1, vec![put("third")])).await;
    assert_eq!(again["valid"], true);
    assert_eq!(sections::brief_version(&ws.store.db.read().unwrap(), &project).unwrap(), 1);
}

#[tokio::test]
async fn a_preview_names_the_problems_the_update_gets() {
    let (_dir, ws, project) = lab();
    // The validator's, under each change's path.
    let rejected = same_problems(&ws, &project, "a", input("v", 0, vec![put("fine"), invalid("bad")])).await;
    assert_eq!(rejected["problems"][0]["path"], "changes[1].body");
    // The request's own, and the rules'.
    same_problems(&ws, &project, "a", json!({"requestId":"x","expectedVersion":0,"noChange":true,"changes":[put("p")]})).await;
    same_problems(&ws, &project, "a", json!({"requestId":"y","expectedVersion":0})).await;
    same_problems(&ws, &project, "a", input("k", 0, vec![put("Bad Key")])).await;
    same_problems(&ws, &project, "d", input("d", 0, vec![put("plan")])).await;
    // Anything but true is no check: an update, and this one is refused.
    let wrong = json!({"requestId":"w","expectedVersion":0,"noChange":true,"validateOnly":"yes"});
    let wrong = update::update(&ws, &FAKE, "a", wrong).await.unwrap().unwrap_err();
    assert_eq!(codes(&wrong), ["invalid_input"]);
    assert_eq!(wrong["problems"][0]["path"], "validateOnly");
    assert_eq!(footprint(&ws, &project)["receipts"], 0);
}

#[test]
fn the_guide_states_the_problems_a_rejection_lists() {
    let limits = &brief_contract().unwrap()["limits"];
    assert_eq!(limits["callProblems"].as_u64(), Some(update::MAX_PROBLEMS as u64));
    assert!(limits["problems"].as_u64().is_some_and(|section| section < update::MAX_PROBLEMS as u64));
}

#[tokio::test]
async fn more_problems_than_shown_are_counted_in_both() {
    let (_dir, ws, project) = lab();
    // Twelve topics, the most a Brief has: one validator problem each.
    let changes: Vec<Value> = (0..12).map(|n| invalid(&format!("bad{n}"))).collect();
    let rejected = same_problems(&ws, &project, "a", input("many", 0, changes)).await;
    assert_eq!((rejected["problems"].as_array().unwrap().len(), rejected["moreProblems"].clone()), (10, json!(2)));
    // At the limit, none left out and no count.
    let changes: Vec<Value> = (0..10).map(|n| invalid(&format!("bad{n}"))).collect();
    assert!(same_problems(&ws, &project, "a", input("ten", 0, changes)).await.get("moreProblems").is_none());
}

#[tokio::test]
async fn a_stale_version_previews_as_a_conflict_with_the_latest_brief() {
    let (_dir, ws, project) = lab();
    update::update(&ws, &FAKE, "a", input("a1", 0, vec![put("plan")])).await.unwrap().unwrap();
    let rejected = same_problems(&ws, &project, "b", input("b1", 0, vec![put("notes")])).await;
    assert_eq!(codes(&rejected), ["version_conflict"]);
    assert_eq!(rejected["latest"]["version"], 1);
}

#[tokio::test]
async fn an_ask_only_member_previews_only_what_it_may_write() {
    let (_dir, ws, project) = lab();
    editors::save(&ws.store, &project, 0, Some(vec!["a".into()])).unwrap();
    let rejected = same_problems(&ws, &project, "b", input("b1", 0, vec![put("notes")])).await;
    assert!(!codes(&rejected).is_empty());
    // Its own ask is still fine to check.
    let mut ask = put("decide");
    ask["kind"] = json!("ask");
    ask["ask"] = json!({"question":"Which way?","reply":{"options":[{"id":"left","label":"Left"},{"id":"right","label":"Right"}]}});
    assert_eq!(preview(&ws, "b", input("b2", 0, vec![ask])).await["valid"], true);
}

#[tokio::test]
async fn attachments_are_judged_as_a_write_judges_them_and_nothing_is_copied() {
    let (dir, ws, project) = lab();
    let files = dir.path().join("files");
    std::fs::create_dir_all(files.join("folder")).unwrap();
    std::fs::write(files.join("loss.csv"), "step,loss\n1,0.5\n").unwrap();
    std::fs::File::create(files.join("weights.bin")).unwrap().set_len(SNAPSHOT_FILE_BYTES + 1).unwrap();
    let path = |name: &str| files.join(name).to_string_lossy().into_owned();
    let mut fine = put("run");
    fine["attachments"] = json!([
        {"name":"loss.csv","path":path("loss.csv")},
        {"name":"weights.bin","path":path("weights.bin")},
        {"name":"folder","path":path("folder")},
        {"name":"missing.log","path":path("missing.log")},
        {"name":"paper","url":"https://example.com/paper"},
    ]);
    let before = footprint(&ws, &project);
    assert_eq!(preview(&ws, "a", input("a1", 0, vec![fine.clone()])).await["valid"], true);
    assert_eq!(footprint(&ws, &project), before, "a readable file is not copied");
    // Yuzuno's own data and a relative path, the same two problems.
    let mut own = put("own");
    own["attachments"] = json!([{"name":"db","path":ws.data_dir.join("workspace.sqlite")},{"name":"rel","path":"notes.txt"}]);
    let rejected = same_problems(&ws, &project, "a", input("a2", 0, vec![fine.clone(), own])).await;
    assert_eq!(codes(&rejected), ["attachment_path", "attachment_path"]);
    assert_eq!(rejected["problems"][0]["path"], "changes[1].attachments[0].path");
    // A file the Core cannot read, where permissions apply (not as root).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let locked = files.join("locked.csv");
        std::fs::write(&locked, "a,b\n").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::File::open(&locked).is_err() {
            let mut unreadable = put("locked");
            unreadable["attachments"] = json!([{"name":"locked.csv","path":locked}]);
            let rejected = same_problems(&ws, &project, "a", input("a3", 0, vec![unreadable])).await;
            assert!(rejected["problems"][0]["reason"].as_str().unwrap().contains("cannot be read"), "{rejected}");
        }
    }
    // The update itself still copies its snapshot.
    update::update(&ws, &FAKE, "a", input("a4", 0, vec![fine])).await.unwrap().unwrap();
    assert_eq!(std::fs::read_dir(attachments::dir(&ws.data_dir)).unwrap().count(), 1);
}

/// The generated validator, as brief_update runs it: the same problems.
#[tokio::test]
async fn the_generated_validator_gives_a_preview_the_same_problems() {
    let (dir, ws, project) = lab();
    let checker = Checker::Node(Arc::new(crate::results::Validator::from_env()));
    let file = dir.path().join("preview.png");
    std::fs::write(&file, b"fixture image bytes").unwrap();
    let mut change = put("development");
    change["kind"] = json!("status");
    change["status"] = json!({"asOf":now(),"validFor":3600});
    change["attachments"] = json!([{"name":"preview.png","path":file}]);
    let sent = input("unused", 0, vec![change]);
    let before = footprint(&ws, &project);
    let previewed = update::update(&ws, &checker, "a", only(sent.clone())).await.unwrap().unwrap();
    assert_eq!(footprint(&ws, &project), before);
    let rejected = update::update(&ws, &checker, "a", sent).await.unwrap().unwrap_err();
    assert_eq!(codes(&rejected), ["unused_attachment"]);
    assert_eq!((previewed["valid"].clone(), previewed["problems"].clone()), (json!(false), rejected["problems"].clone()));
}

/// Advice on each Markdown block that says "wordy", in body order, given twice over.
fn advising(section: &Value) -> Result<(Value, Vec<Value>), Value> {
    let mut advice = vec![];
    let elements = &section["body"]["elements"];
    for id in elements["body"]["children"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if elements[id]["props"]["text"].as_str().is_some_and(|text| text.contains("wordy")) {
            let one = json!({"code":"long_markdown","path":format!("body.elements.{id}.props.text"),
                "reason":"A long paragraph.","guide":"brief_guide content"});
            advice.extend([one.clone(), one]);
        }
    }
    Ok((section.clone(), advice))
}
const ADVISING: Checker = Checker::Advising(advising);

/// A report with two Markdown blocks, note and more.
fn two(key: &str, note: &str, more: &str) -> Value {
    let markdown = |text: &str| json!({"type":"Markdown","props":{"text":text}});
    json!({"op":"put","key":key,"kind":"report","title":format!("About {key}"),
        "body":{"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["note","more"]},
            "note":markdown(note),"more":markdown(more)}}})
}

fn edit(key: &str, block: &str, text: &str) -> Value {
    let mut change = json!({"op":"edit","key":key,"elements":{}});
    change["elements"][block] = json!({"type":"Markdown","props":{"text":text}});
    change
}

async fn advised(ws: &Arc<Workspace>, input: Value) -> Value {
    let answer = update::update(ws, &ADVISING, "a", input).await.unwrap();
    assert!(answer.is_ok(), "{answer:?}");
    answer.unwrap()
}

#[tokio::test]
async fn an_accepted_update_carries_at_most_three_pieces_of_advice_each_once() {
    let (_dir, ws, _project) = lab();
    let first = advised(&ws, input("a1", 0, vec![two("plan", "A wordy note.", "Short.")])).await;
    assert_eq!(first["receipt"]["kind"], "updated");
    assert_eq!(first["advice"], json!([{"code":"long_markdown","path":"changes[0].body.elements.note.props.text",
        "reason":"A long paragraph.","guide":"brief_guide content"}]));
    // A retry gets the same answer, advice included.
    assert_eq!(advised(&ws, input("a1", 0, vec![two("plan", "A wordy note.", "Short.")])).await, first);
    let many: Vec<Value> = (0..4).map(|n| two(&format!("s{n}"), "wordy", "wordy")).collect();
    let capped = advised(&ws, input("a2", 1, many)).await;
    let paths: Vec<&str> = capped["advice"].as_array().unwrap().iter().map(|a| a["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["changes[0].body.elements.note.props.text", "changes[0].body.elements.more.props.text",
        "changes[1].body.elements.note.props.text"]);
    // The preview of a valid update gives the advice the update gets.
    let checked = preview_with(&ws, input("a3", 2, vec![two("other", "wordy", "Short.")])).await;
    let sent = advised(&ws, input("a3", 2, vec![two("other", "wordy", "Short.")])).await;
    assert_eq!((checked["valid"].clone(), checked["advice"].clone()), (json!(true), sent["advice"].clone()));
    // Without any, an answer has no advice.
    assert!(advised(&ws, input("a4", 3, vec![two("calm", "Short.", "Short.")])).await.get("advice").is_none());
}

async fn preview_with(ws: &Arc<Workspace>, input: Value) -> Value {
    update::update(ws, &ADVISING, "a", only(input)).await.unwrap().unwrap()
}

#[tokio::test]
async fn advice_is_only_about_what_this_call_changed() {
    let (_dir, ws, _project) = lab();
    let first = advised(&ws, input("a1", 0, vec![two("plan", "A wordy note.", "Short."), put("gone")])).await;
    assert_eq!(first["advice"].as_array().unwrap().len(), 1);
    // An edit of the other block: the wordy note it left alone is not advised again.
    assert!(advised(&ws, input("a2", 1, vec![edit("plan", "more", "Still short.")])).await.get("advice").is_none());
    // An edit of the note is, under the edit's own path.
    let edited = advised(&ws, input("a3", 2, vec![edit("plan", "note", "Now wordy again.")])).await;
    assert_eq!(edited["advice"][0]["path"], "changes[0].elements.note.props.text");
    // Nothing that sends no body is advised on the bodies already there.
    assert!(advised(&ws, json!({"requestId":"a4","expectedVersion":3,"noChange":true})).await.get("advice").is_none());
    assert!(advised(&ws, input("a5", 3, vec![json!({"op":"remove","key":"gone"})])).await.get("advice").is_none());
}

#[tokio::test]
async fn a_preview_says_whether_every_step_was_checked() {
    let (_dir, ws, _project) = lab();
    // Stopped before the validator (the version), and at it (later steps not run).
    update::update(&ws, &FAKE, "a", input("a1", 0, vec![put("plan")])).await.unwrap().unwrap();
    assert_eq!(preview(&ws, "a", input("p1", 0, vec![put("notes")])).await["checkedAll"], false);
    assert_eq!(preview(&ws, "a", input("p2", 1, vec![invalid("notes")])).await["checkedAll"], false);
    // Attachments are the last step: their problems come after every other check.
    let mut own = put("own");
    own["attachments"] = json!([{"name":"db","path":ws.data_dir.join("workspace.sqlite")}]);
    let last = preview(&ws, "a", input("p3", 1, vec![own])).await;
    assert_eq!((last["valid"].clone(), last["checkedAll"].clone()), (json!(false), json!(true)));
    let fine = preview(&ws, "a", input("p4", 1, vec![put("notes")])).await;
    assert_eq!((fine["valid"].clone(), fine["checkedAll"].clone(), fine["advice"].clone()), (json!(true), json!(true), json!([])));
    assert!(fine["note"].as_str().unwrap().contains("checks everything again"));
}

/// The generated validator's advice (T-176) reaches an accepted answer and a
/// preview alike; an ask gets none.
#[tokio::test]
async fn the_generated_validator_advises_a_long_markdown_block() {
    let (_dir, ws, _project) = lab();
    let checker = Checker::Node(Arc::new(crate::results::Validator::from_env()));
    let limit = brief_contract().unwrap()["limits"]["advice"]["markdownChars"].as_u64().unwrap() as usize;
    let mut long = put("notes");
    long["body"]["elements"]["note"]["props"]["text"] = json!("x".repeat(limit + 1));
    let checked = update::update(&ws, &checker, "a", only(input("n1", 0, vec![long.clone()]))).await.unwrap().unwrap();
    let sent = update::update(&ws, &checker, "a", input("n1", 0, vec![long])).await.unwrap().unwrap();
    assert_eq!(sent["receipt"]["kind"], "updated");
    assert_eq!((sent["advice"][0]["code"].clone(), sent["advice"][0]["path"].clone()),
        (json!("long_markdown"), json!("changes[0].body.elements.note.props.text")));
    assert_eq!(checked["advice"], sent["advice"]);
    let mut ask = put("decide");
    ask["kind"] = json!("ask");
    ask["ask"] = json!({"question":"Which way?","reply":{"options":[{"id":"left","label":"Left"},{"id":"right","label":"Right"}]}});
    ask["body"]["elements"]["note"]["props"]["text"] = json!("x".repeat(limit + 1));
    let asked = update::update(&ws, &checker, "a", input("n2", 1, vec![ask])).await.unwrap().unwrap();
    assert!(asked.get("advice").is_none(), "{asked}");
}
