//! YN-209: brief_update tells how each report or status card it writes
//! shows on Home (faces.rs). Read from the section as Core keeps it, after
//! every check before the write, in a check and a write alike; never a check
//! itself, never more than six, never past one MCP answer, never a path; and
//! an update with no such card asks for nothing.
use super::{
    attachments, faces, sections,
    tests::lab,
    update::{self, Checker},
    *,
};
use crate::model::{MessageInput, MessageReceipt};

fn accept(section: &Value) -> Result<Value, Value> {
    Ok(section.clone())
}
const FAKE: Checker = Checker::Fake(accept);

/// A report naming its lead and, when given, its visual; `files` registered and shown in a block `files`.
fn report(key: &str, title: &str, visual: Option<&str>, files: &[(&str, &std::path::Path)]) -> Value {
    let mut summary = json!({"lead":"lead","size":"wide"});
    if let Some(visual) = visual {
        summary["visual"] = json!(visual);
    }
    let mut children = vec![json!("lead")];
    let mut elements = json!({"lead":{"type":"Markdown","props":{"text":"What changed, in a sentence."}}});
    if !files.is_empty() {
        children.push(json!("files"));
        elements["files"] = json!({"type":"Attachments","props":{"items":files.iter().map(|(name, _)| json!({"name":name})).collect::<Vec<_>>()}});
    }
    elements["body"] = json!({"type":"BriefBody","props":{"summary":summary},"children":children});
    let mut change = json!({"op":"put","key":key,"kind":"report","title":title,"body":{"root":"body","elements":elements}});
    if !files.is_empty() {
        change["attachments"] = json!(files.iter().map(|(name, path)| json!({"name":name,"path":path})).collect::<Vec<_>>());
    }
    change
}

fn ask(key: &str) -> Value {
    json!({"op":"put","key":key,"kind":"ask","title":"Which way?",
        "body":{"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["note"]},"note":{"type":"Markdown","props":{"text":"Pick one."}}}},
        "ask":{"question":"Which way?","reply":{"options":[{"id":"left","label":"Left"},{"id":"right","label":"Right"}]}}})
}

fn input(request: &str, version: i64, changes: Vec<Value>) -> Value {
    json!({"requestId":request,"expectedVersion":version,"changes":changes})
}

fn only(mut input: Value) -> Value {
    input["validateOnly"] = json!(true);
    input
}

/// What a check may not change: the Brief, receipts, requests, snapshots, the attachment cache, the change
/// feed, and what the user has read (Seen, a report opened whole).
fn footprint(ws: &Workspace, project: &str) -> Value {
    let db = ws.store.db.read().unwrap();
    let count = |table: &str| -> i64 { db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap() };
    json!({"version":sections::brief_version(&db, project).unwrap(),
        "receipts":count("project_brief_receipts"),"requests":count("collaboration_requests"),
        "snapshots":count("project_brief_snapshots"),"sections":count("project_brief_sections"),
        "writes":count("project_brief_writes"),"seen":count("project_brief_seen"),"opened":count("project_brief_opened"),
        "cache":attachments::dir(&ws.data_dir).exists(),"events":ws.changes.head()})
}

const CARD_FIELDS: [&str; 4] = ["cards", "cardsNote", "moreCards", "cardsUnavailable"];

#[tokio::test]
async fn a_check_and_a_write_tell_each_cards_face_from_the_section_as_core_keeps_it() {
    let (dir, ws, project) = lab();
    let plot = dir.path().join("plot.png");
    std::fs::write(&plot, b"synthetic image bytes").unwrap();
    let change = report("plan", "Plan", Some("files"), &[("plot.png", &plot)]);
    let before = footprint(&ws, &project);
    let checked = update::update(&ws, &FAKE, "a", only(input("r1", 0, vec![change.clone()]))).await.unwrap().unwrap();
    assert_eq!(footprint(&ws, &project), before, "a check writes nothing, and reads nothing for the user");
    assert_eq!((checked["valid"].clone(), checked["cardsNote"].clone()), (json!(true), json!("fake note")));
    let asked = &checked["cards"][0]["asked"];
    assert_eq!(asked["section"]["kind"], "report");
    assert_eq!(asked["section"]["body"], change["body"], "the body as the validator normalized it");
    // The file as staging would take it, judged and not copied.
    assert_eq!(asked["section"]["attachments"], json!([{"name":"plot.png","kind":"image","snapshot":true,"size":21,"mime":"image/png",
        "takenAt":asked["section"]["attachments"][0]["takenAt"]}]));
    assert_eq!((asked["refreshes"].clone(), asked["requested"].clone()), (json!(false), json!({"lead":"lead","visual":"files"})));
    assert!(!checked.to_string().contains(dir.path().to_str().unwrap()), "never a path");

    let written = update::update(&ws, &FAKE, "a", input("r1", 0, vec![change.clone()])).await.unwrap().unwrap();
    let asked = &written["cards"][0]["asked"];
    assert_eq!(written["receipt"]["kind"], "updated");
    assert_eq!(asked["section"]["attachments"][0]["snapshot"], true, "kept, as the write took it");
    assert!(asked["section"]["attachments"][0].get("sha256").is_none() && !written.to_string().contains(dir.path().to_str().unwrap()));
    // Kept with the answer: a retry reads the same, faces included.
    let again = update::update(&ws, &FAKE, "a", input("r1", 0, vec![change])).await.unwrap().unwrap();
    assert_eq!(again, written);
}

#[tokio::test]
async fn an_update_with_no_report_or_status_card_has_no_card_fields() {
    let (_dir, ws, project) = lab();
    let checked = update::update(&ws, &FAKE, "a", only(input("q0", 0, vec![ask("pick")]))).await.unwrap().unwrap();
    let written = update::update(&ws, &FAKE, "a", input("q1", 0, vec![ask("pick")])).await.unwrap().unwrap();
    let resolved = update::update(&ws, &FAKE, "a", input("q2", 1, vec![json!({"op":"resolve","key":"pick"})])).await.unwrap().unwrap();
    let nothing = update::update(&ws, &FAKE, "b", json!({"requestId":"n","expectedVersion":2,"noChange":true})).await.unwrap().unwrap();
    for answer in [&checked, &written, &resolved, &nothing] {
        for field in CARD_FIELDS {
            assert!(answer.get(field).is_none(), "{field} in {answer}");
        }
    }
    assert_eq!(sections::brief_version(&ws.store.db.read().unwrap(), &project).unwrap(), 2);
}

#[tokio::test]
async fn faces_are_asked_for_six_cards_at_most_and_the_rest_are_counted() {
    let (_dir, ws, _project) = lab();
    let changes: Vec<Value> = (0..8).map(|n| report(&format!("r{n}"), "Report", None, &[])).chain([ask("pick")]).collect();
    let written = update::update(&ws, &FAKE, "a", input("eight", 0, changes)).await.unwrap().unwrap();
    let told: Vec<&str> = written["cards"].as_array().unwrap().iter().map(|card| card["key"].as_str().unwrap()).collect();
    assert_eq!(told, ["r0", "r1", "r2", "r3", "r4", "r5"], "the first six, in the changes' order; never asked for the rest");
    assert_eq!(written["moreCards"], 2);
    assert!(written["cardsUnavailable"].as_str().unwrap().contains(&format!("first {}", faces::MAX_CARDS)));
    assert_eq!(written["sections"].as_array().unwrap().len(), 9, "every change written");
}

#[tokio::test]
async fn a_validator_that_tells_no_face_leaves_the_update_as_it_was() {
    let (_dir, ws, project) = lab();
    let change = report("plan", "CARDS DOWN", None, &[]);
    let checked = update::update(&ws, &FAKE, "a", only(input("d0", 0, vec![change.clone()]))).await.unwrap().unwrap();
    assert_eq!((checked["valid"].clone(), checked["cards"].clone()), (json!(true), json!([])));
    let written = update::update(&ws, &FAKE, "a", input("d1", 0, vec![change])).await.unwrap().unwrap();
    assert_eq!((written["accepted"].clone(), written["version"].clone(), written["cards"].clone()), (json!(true), json!(1), json!([])));
    assert_eq!(written["cardsUnavailable"], "1 of 1 were not computed: the validator was busy for 2 s. The update itself is as the rest of this answer says.");
    assert!(written.get("cardsNote").is_none());
    assert!(sections::live_key(&ws.store.db.read().unwrap(), &project, "plan").unwrap().is_some());
}

#[tokio::test]
async fn a_refused_or_conflicting_update_tells_no_face() {
    let (_dir, ws, _project) = lab();
    update::update(&ws, &FAKE, "a", input("w", 0, vec![report("plan", "Plan", None, &[])])).await.unwrap().unwrap();
    // Stale: refused by the checks before the write, in a check as in a write.
    let stale = input("s", 0, vec![report("plan", "Plan again", None, &[])]);
    let checked = update::update(&ws, &FAKE, "a", only(stale.clone())).await.unwrap().unwrap();
    let refused = update::update(&ws, &FAKE, "a", stale).await.unwrap().unwrap_err();
    // An attachment that cannot be read: refused after the validator, before any face.
    let missing = report("other", "Other", None, &[("gone.png", std::path::Path::new("relative/gone.png"))]);
    let unreadable = update::update(&ws, &FAKE, "a", only(input("m", 1, vec![missing]))).await.unwrap().unwrap();
    assert_eq!((checked["valid"].clone(), unreadable["valid"].clone()), (json!(false), json!(false)));
    for answer in [&checked, &refused, &unreadable] {
        for field in CARD_FIELDS {
            assert!(answer.get(field).is_none(), "{field} in {answer}");
        }
    }
}

#[tokio::test]
async fn an_edit_tells_the_face_with_the_attachments_as_stored() {
    let (dir, ws, _project) = lab();
    let plot = dir.path().join("plot.png");
    std::fs::write(&plot, b"synthetic image bytes").unwrap();
    update::update(&ws, &FAKE, "a", input("p", 0, vec![report("plan", "Plan", None, &[("plot.png", &plot)])])).await.unwrap().unwrap();
    let edit = json!({"op":"edit","key":"plan","elements":{"lead":{"type":"Markdown","props":{"text":"Edited."}}}});
    let edited = update::update(&ws, &FAKE, "a", input("e", 1, vec![edit])).await.unwrap().unwrap();
    let asked = &edited["cards"][0]["asked"];
    assert_eq!(asked["section"]["body"]["elements"]["lead"]["props"]["text"], "Edited.");
    assert_eq!((asked["section"]["attachments"][0]["name"].clone(), asked["section"]["attachments"][0]["snapshot"].clone()), (json!("plot.png"), json!(true)));
    assert_eq!(asked["requested"], json!({"lead":"lead"}));
    assert!(!edited.to_string().contains(dir.path().to_str().unwrap()));
}

#[tokio::test]
async fn the_summarys_for_you_checklist_is_told_as_requested() {
    // R-27: summary.forYou names the Checklist of what the user is asked to do; the face's request names it too.
    let (_dir, ws, _project) = lab();
    let mut change = report("development", "Development", None, &[]);
    let body = &mut change["body"]["elements"];
    body["todo"] = json!({"type":"Checklist","props":{"title":"For you","items":[{"id":"try","text":"Try the new page","done":false}]}});
    body["body"]["children"] = json!(["lead", "todo"]);
    body["body"]["props"]["summary"]["forYou"] = json!("todo");
    let written = update::update(&ws, &FAKE, "a", input("y", 0, vec![change])).await.unwrap().unwrap();
    assert_eq!(written["cards"][0]["asked"]["requested"], json!({"lead":"lead","forYou":"todo"}));
}

/// `agent` starts Turn `turn` from the user's own message (a refresh is made only in one, YN-113).
fn user_turn(ws: &Workspace, agent: &str, turn: &str) {
    let input = MessageInput { client_message_id: format!("{agent}-{turn}"), text: "Synthetic request.".into(), text_blocks: None,
        images: vec![], expected_turn_id: None, question: None, clarification: None };
    let receipt = serde_json::from_value::<MessageReceipt>(json!({"input":input,"origin":{"kind":"client"},"status":"accepted","turnId":turn})).unwrap();
    let id = turn.to_owned();
    ws.store.update(agent, "test/turn", &json!({}), move |d| {
        for t in &mut d.turns {
            t["status"] = json!("completed");
        }
        d.turns.push(json!({"id":id,"status":"inProgress","items":[]}));
        d.message_receipts.push(receipt);
        d.agent.status = "working".into();
        d.agent.connection_state = "connected".into();
    }).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_card_that_refreshes_itself_is_told_so_until_its_refresh_is_removed() {
    let (_dir, ws, _project) = lab();
    user_turn(&ws, "a", "u1");
    let mut daily = report("digest", "Digest", None, &[]);
    daily["refresh"] = json!({"every":"day","at":"08:00","zone":"UTC","instruction":"Summarize the synthetic headlines of the day."});
    let made = update::update(&ws, &FAKE, "a", input("f1", 0, vec![daily])).await.unwrap().unwrap();
    assert_eq!(made["cards"][0]["asked"]["refreshes"], true);
    // A put or edit naming no refresh keeps the card's.
    let kept = update::update(&ws, &FAKE, "a", input("f2", 1, vec![report("digest", "Digest 2", None, &[])])).await.unwrap().unwrap();
    assert_eq!(kept["cards"][0]["asked"]["refreshes"], true);
    let mut removed = report("digest", "Digest 3", None, &[]);
    removed["refresh"] = Value::Null;
    let removed = update::update(&ws, &FAKE, "a", input("f3", 2, vec![removed])).await.unwrap().unwrap();
    assert_eq!(removed["cards"][0]["asked"]["refreshes"], false);
}

#[tokio::test]
async fn faces_never_grow_an_answer_past_one_mcp_answer() {
    let (_dir, ws, _project) = lab();
    let changes: Vec<Value> = (0..6).map(|n| report(&format!("big{n}"), "BIG", None, &[])).collect();
    let written = update::update(&ws, &FAKE, "a", input("big", 0, changes)).await.unwrap().unwrap();
    // As collaboration_mcp sends it, in UTF-8 compact JSON.
    let bytes = serde_json::to_vec(&written).unwrap().len();
    assert!(bytes <= crate::mcp_views::BUDGET, "{bytes} bytes");
    let told = written["cards"].as_array().unwrap().len();
    assert!((1..6).contains(&told), "{told} faces fit");
    assert_eq!(written["moreCards"], 6 - told);
    assert!(written["cardsUnavailable"].as_str().unwrap().contains(&format!("within {} bytes", crate::mcp_views::BUDGET)));
    // The receipt and every section written are kept whole.
    assert_eq!((written["accepted"].clone(), written["sections"].as_array().unwrap().len()), (json!(true), 6));
    assert!(written["receipt"]["id"].is_string());
}

/// The generated validator, as Core runs it, on the shapes R-18 replayed: a visual naming a PDF is no picture, so
/// Core's repair drops it (the repairs say so) and the face names the slot it named and the first kept image the card
/// falls back to; a lead whose limit falls past the clamp is told cut, with where.
#[tokio::test]
async fn the_generated_validator_tells_the_fallback_and_the_cut_lead() {
    let (dir, ws, _project) = lab();
    let checker = Checker::Node(Arc::new(crate::results::Validator::from_env()));
    let (pdf, png) = (dir.path().join("review.pdf"), dir.path().join("comparison.png"));
    std::fs::write(&pdf, b"%PDF-1.4 synthetic").unwrap();
    std::fs::write(&png, b"synthetic image bytes").unwrap();
    let lead = "日用 Core 在合成的 20 分钟窗口里平均 0.33 核、峰值 1.8 核；隔离 Core 在同类负载下为 0.09–0.17 核。两组数字来自不同负载，不能相减当作安装收益。根因未定：需要日用窗口内的系统读数才能区分。";
    let body = json!({"root":"body","elements":{
        "body":{"type":"BriefBody","props":{"summary":{"lead":"lead","visual":"pdf","size":"wide"}},"children":["lead","pdf","pictures"]},
        "lead":{"type":"Markdown","props":{"text":lead}},
        "pdf":{"type":"Attachments","props":{"items":[{"name":"review.pdf"}]}},
        "pictures":{"type":"Attachments","props":{"items":[{"name":"comparison.png"}]}}}});
    let change = json!({"op":"put","key":"review","kind":"report","title":"审查与对照图","body":body,
        "attachments":[{"name":"review.pdf","path":pdf},{"name":"comparison.png","path":png}]});
    for validate in [true, false] {
        let sent = input(&format!("real-{validate}"), 0, vec![change.clone()]);
        let answer = update::update(&ws, &checker, "a", if validate { only(sent) } else { sent }).await.unwrap().unwrap();
        let card = &answer["cards"][0];
        assert_eq!(card["key"], "review", "{answer}");
        assert_eq!(card["dropped"], json!([{"slot":"visual","block":"pdf","reason":"Core removed summary.visual to accept the section (its repairs say why)"}]));
        assert!(answer["repairs"].as_array().unwrap().iter().any(|repair| repair["code"] == "dropped_layout"
            && repair["path"] == "changes[0].body.elements.body.props.summary"
            && repair["reason"].as_str().is_some_and(|why| why.contains("removed visual"))), "{answer}");
        assert_eq!((card["visual"]["from"].clone(), card["visual"]["file"].clone()), (json!("file"), json!("comparison.png")));
        for width in ["wide", "phone"] {
            let cut = &card[width]["estimate"]["lead"];
            assert_eq!(cut["cut"], true, "{width}: {cut}");
            assert!(!cut["endsWith"].as_str().unwrap().contains("根因未定"), "{width}: {cut}");
        }
        assert!(answer["cardsNote"].as_str().unwrap().starts_with("cards: "));
        assert!(!answer.to_string().contains(dir.path().to_str().unwrap()), "never a path");
    }
}

#[test]
fn the_contract_states_cores_card_limit() {
    assert_eq!(brief_contract().unwrap()["limits"]["cards"].as_u64(), Some(faces::MAX_CARDS as u64));
}
