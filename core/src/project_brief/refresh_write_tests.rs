//! What writes Home cards' refreshes (YN-113 R2): brief_update's `refresh`
//! and its rules (a lead's report, a Turn the user started for anything that
//! makes it run more or says something new, the user's limits), the past
//! issues every put of such a card keeps, and the user's routes.
use super::{
    refresh::{self, Sender},
    sections,
    tests::{lab, set_leads},
    update::{self, Checker},
    *,
};
use crate::model::{MessageInput, MessageReceipt};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use std::sync::Mutex;
use tower::ServiceExt;

const KEY: &str = "digest/news";
const INSTRUCTION: &str = "Summarize the three most important synthetic headlines of the day.";

fn accept(section: &Value) -> Result<Value, Value> {
    Ok(section.clone())
}

fn body(text: &str) -> Value {
    json!({"root":"body","elements":{"body":{"type":"BriefBody","props":{"summary":{"lead":"lead"}},"children":["lead"]},
        "lead":{"type":"Markdown","props":{"text":text}}}})
}

/// `agent` starts Turn `turn` from a message whose receipt has origin
/// `origin` (None: no receipt, as a terminal's prompt); earlier Turns end.
fn turn(ws: &Workspace, agent: &str, turn: &str, origin: Option<&str>) {
    let receipt = origin.map(|kind| {
        let input = MessageInput { client_message_id: format!("{agent}-{turn}"), text: "Synthetic request.".into(), text_blocks: None,
            images: vec![], expected_turn_id: None, question: None, clarification: None };
        serde_json::from_value::<MessageReceipt>(json!({"input":input,"origin":{"kind":kind},"status":"accepted","turnId":turn})).unwrap()
    });
    let id = turn.to_owned();
    ws.store.update(agent, "test/turn", &json!({}), move |d| {
        for t in &mut d.turns {
            t["status"] = json!("completed");
        }
        d.turns.push(json!({"id":id,"status":"inProgress","items":[]}));
        d.message_receipts.extend(receipt);
        d.agent.status = "working".into();
        d.agent.connection_state = "connected".into();
    }).unwrap();
}

fn version(ws: &Workspace, project: &str) -> i64 {
    sections::brief_version(&ws.store.db.read().unwrap(), project).unwrap()
}

/// One brief_update of `agent` with `changes`, at the Brief's version now.
async fn update(ws: &Arc<Workspace>, agent: &str, project: &str, changes: Vec<Value>) -> Result<Value, Value> {
    let expected = version(ws, project);
    let input = json!({"requestId":format!("u-{expected}-{}", uuid::Uuid::new_v4()),"expectedVersion":expected,"changes":changes});
    update::update(ws, &Checker::Fake(accept), agent, input).await.unwrap()
}

fn put(title: &str, refresh: Option<Value>) -> Value {
    let mut change = json!({"op":"put","key":KEY,"kind":"report","title":title,"body":body(title)});
    if let Some(refresh) = refresh {
        change["refresh"] = refresh;
    }
    change
}

fn daily() -> Value {
    json!({"every":"day","at":"08:00","zone":"UTC","instruction":INSTRUCTION})
}

fn codes(rejected: &Value) -> Vec<String> {
    rejected["problems"].as_array().unwrap().iter().map(|p| p["code"].as_str().unwrap().to_owned()).collect()
}

fn live(ws: &Workspace, project: &str) -> sections::Row {
    sections::live_key(&ws.store.db.read().unwrap(), project, KEY).unwrap().unwrap()
}

fn timer(ws: &Workspace, project: &str, identity: i64) -> Option<refresh::Refresh> {
    refresh::one(&ws.store.db.read().unwrap(), project, identity).unwrap()
}

fn rows(ws: &Workspace, project: &str) -> Vec<(i64, i64, bool, Option<String>)> {
    let db = ws.store.db.read().unwrap();
    let mut query = db.prepare(
        "SELECT version,COALESCE(lineage,seq),live,history_reason FROM project_brief_sections WHERE project_id=?1 AND key=?2 ORDER BY seq").unwrap();
    query.query_map(params![project, KEY], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap()
        .collect::<rusqlite::Result<_>>().unwrap()
}

fn set_limits(ws: &Workspace, min_hours: u32, max_active: u32) {
    let limits = refresh::limits(&ws.store.db.read().unwrap()).unwrap();
    let saved = json!({"version":limits.version + 1,"minHours":min_hours,"maxActive":max_active,"pauseAfterFailures":3});
    ws.store.db.write().unwrap().execute(
        "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![refresh::LIMITS_KEY, saved.to_string()]).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lead_makes_its_report_refresh_itself_and_each_put_keeps_the_last_issue() {
    let (_dir, ws, project) = lab();
    turn(&ws, "a", "u1", Some("client"));
    let answer = update(&ws, "a", &project, vec![put("Digest", Some(daily()))]).await.unwrap();
    let entry = &answer["sections"][0];
    assert_eq!((&entry["refresh"]["version"], &entry["refresh"]["enabled"], &entry["refresh"]["weeklyRuns"]), (&json!(1), &json!(true), &json!(7)));
    assert!(entry["refresh"]["nextAt"].as_str().is_some_and(|at| at.ends_with("08:00:00Z")), "{entry}");
    let first = live(&ws, &project);
    let made = timer(&ws, &project, first.identity).unwrap();
    assert_eq!((made.zone.as_str(), made.instruction.as_str(), made.created_by.as_str(), made.key.as_str()), ("UTC", INSTRUCTION, "a", KEY));
    assert_eq!(made.cadence, json!({"every":"day","at":"08:00"}));
    assert!(first.data.get("refresh").is_none(), "the card keeps no refresh of its own");

    // A put without refresh keeps it, and keeps the issue it replaces as history.
    let answer = update(&ws, "a", &project, vec![put("Digest, Nov 14", None)]).await.unwrap();
    assert!(answer["sections"][0].get("refresh").is_none());
    assert_eq!(timer(&ws, &project, first.identity).unwrap().version, 1);
    let second = live(&ws, &project);
    assert_eq!((second.identity, second.version, second.data["title"].as_str()), (first.identity, first.version + 1, Some("Digest, Nov 14")));
    assert_eq!(rows(&ws, &project), vec![
        (1, first.identity, false, Some("refreshed".into())),
        (2, first.identity, true, None),
    ]);
    // An edit changes it in place.
    let edit = json!({"op":"edit","key":KEY,"elements":{"lead":{"type":"Markdown","props":{"text":"Digest, edited."}}}});
    update(&ws, "a", &project, vec![edit]).await.unwrap();
    assert_eq!(rows(&ws, &project).len(), 2);
    assert_eq!(live(&ws, &project).version, 3);

    // Home: one card, its refresh counting one past issue; history does not list it.
    let home = home::build(&ws.store).unwrap();
    let panel = home["projects"].as_array().unwrap().iter().find(|p| p["project"]["id"] == project.as_str()).unwrap();
    let cards: Vec<&Value> = panel["brief"]["sections"].as_array().unwrap().iter().filter(|s| s["key"] == KEY).collect();
    assert_eq!((cards.len(), &cards[0]["id"], &cards[0]["refresh"]["versions"]), (1, &json!(first.identity), &json!(1)));
    assert_eq!(panel["brief"]["history"], json!([]), "past issues are not Home's history");
    // A seen card is: and it keeps its refresh.
    sections::mark_seen(&ws.store, &project, &[(KEY.to_owned(), 3)]).unwrap();
    let history = sections::history(&ws.store.db.read().unwrap(), &project).unwrap();
    assert_eq!(history.iter().map(|row| row.history_reason.clone().unwrap()).collect::<Vec<_>>(), ["seen"]);
    assert!(timer(&ws, &project, first.identity).is_some());
    // Written again after the Seen: the same card, no second copy of the seen issue.
    update(&ws, "a", &project, vec![put("Digest, Nov 15", None)]).await.unwrap();
    assert_eq!(live(&ws, &project).identity, first.identity);
    assert_eq!(rows(&ws, &project).iter().filter(|row| row.3.as_deref() == Some("refreshed")).count(), 1);

    // Removing the card removes its refresh.
    let answer = update(&ws, "a", &project, vec![json!({"op":"remove","key":KEY})]).await.unwrap();
    assert_eq!(answer["sections"][0]["refresh"], Value::Null);
    assert!(answer["sections"][0].as_object().unwrap().contains_key("refresh"));
    assert!(timer(&ws, &project, first.identity).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_lead_sets_one_only_on_a_report_and_only_as_a_refresh_reads() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    turn(&ws, "b", "u1", Some("client"));
    let rejected = update(&ws, "b", &project, vec![put("Digest", Some(daily()))]).await.unwrap_err();
    assert!(codes(&rejected).contains(&"not_project_lead".to_owned()), "{rejected}");
    let named = rejected["problems"].as_array().unwrap().iter().find(|p| p["code"] == "not_project_lead").unwrap();
    assert!(named["reason"].as_str().unwrap().contains("Agent a"), "{named}");
    assert_eq!(named["path"], "changes[0].refresh");

    turn(&ws, "a", "u2", Some("client"));
    let status = json!({"op":"put","key":KEY,"kind":"status","title":"Now","body":body("Now"),"status":{"asOf":now(),"validFor":3600},
        "refresh":daily()});
    assert_eq!(codes(&update(&ws, "a", &project, vec![status]).await.unwrap_err()), ["refresh_report_only"]);
    for bad in [
        json!({"every":"hours","hours":5,"instruction":INSTRUCTION}),
        json!({"every":"day","at":"8:00","instruction":INSTRUCTION}),
        json!({"every":"day","at":"08:00"}),
        json!({"at":"08:00","instruction":INSTRUCTION}),
        json!({"every":"day","at":"08:00","instruction":" "}),
        json!({"every":"day","at":"08:00","instruction":"x".repeat(2001)}),
        json!({"every":"day","at":"08:00","zone":"Europe/Berlin","instruction":INSTRUCTION}),
        json!({"every":"day","at":"08:00","instruction":INSTRUCTION,"often":true}),
        json!("every day"),
    ] {
        let rejected = update(&ws, "a", &project, vec![put("Digest", Some(bad.clone()))]).await.unwrap_err();
        assert_eq!(codes(&rejected), ["refresh_invalid"], "{bad}: {rejected}");
    }
    // 2000 characters, counted as characters.
    let long = json!({"every":"day","at":"08:00","instruction":"新".repeat(2000)});
    update(&ws, "a", &project, vec![put("Digest", Some(long))]).await.unwrap();
    // The default zone is the Core host's.
    assert_eq!(timer(&ws, &project, live(&ws, &project).identity).unwrap().zone, "local");
    // An edit may send the refresh alone.
    let edit = json!({"op":"edit","key":KEY,"refresh":{"every":"hours","hours":6}});
    let answer = update(&ws, "a", &project, vec![edit]).await.unwrap();
    assert_eq!(answer["sections"][0]["refresh"]["weeklyRuns"], 28);
    let patch = json!({"op":"patch","key":KEY,"refresh":null,"patch":[{"op":"test","path":"/root","value":"body"}]});
    assert_eq!(codes(&update(&ws, "a", &project, vec![patch]).await.unwrap_err()), ["invalid_change"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_the_user_did_not_start_may_only_pause_slow_or_remove_it() {
    let (_dir, ws, project) = lab();
    // Not the user's: a refresh's own Turn, another Agent's mail (no
    // receipt), an automatic continue: none makes one.
    for (origin, n) in [(Some(refresh::ORIGIN), 1), (None, 2), (Some("resume"), 3)] {
        turn(&ws, "a", &format!("n{n}"), origin);
        let rejected = update(&ws, "a", &project, vec![put("Digest", Some(daily()))]).await.unwrap_err();
        assert_eq!(codes(&rejected), ["refresh_needs_user_turn"], "{origin:?}");
    }
    // The user's: their message, a reply from Home, a request from the Project's page.
    turn(&ws, "a", "u1", Some("home"));
    update(&ws, "a", &project, vec![put("Digest", Some(json!({"every":"hours","hours":6,"instruction":INSTRUCTION})))]).await.unwrap();
    let identity = live(&ws, &project).identity;
    turn(&ws, "a", "u2", Some(crate::project_requests::ORIGIN));
    update(&ws, "a", &project, vec![put("Digest", Some(json!({"hours":4})))]).await.unwrap();
    assert_eq!(timer(&ws, &project, identity).unwrap().cadence["hours"], 4);

    // The card's own refresh Turn.
    turn(&ws, "a", "r1", Some(refresh::ORIGIN));
    for faster in [json!({"hours":2}), json!({"every":"hours","hours":1}), json!({"instruction":"Also follow every link."})] {
        let rejected = update(&ws, "a", &project, vec![put("Digest", Some(faster.clone()))]).await.unwrap_err();
        assert_eq!(codes(&rejected), ["refresh_needs_user_turn"], "{faster}");
        assert!(rejected["problems"][0]["reason"].as_str().unwrap().contains("a card's refresh"));
    }
    // Slower, moved and paused are taken; its own content too.
    update(&ws, "a", &project, vec![put("Digest", Some(json!({"hours":8})))]).await.unwrap();
    update(&ws, "a", &project, vec![put("Digest", Some(json!({"at":"01:00"})))]).await.unwrap();
    update(&ws, "a", &project, vec![put("Digest", Some(json!({"paused":true})))]).await.unwrap();
    let paused = timer(&ws, &project, identity).unwrap();
    assert_eq!((paused.enabled, paused.cadence.clone(), paused.paused_reason.unwrap().code), (false, json!({"every":"hours","hours":8,"at":"01:00"}), "paused_by_owner".into()));
    // On again is faster: not here.
    let rejected = update(&ws, "a", &project, vec![put("Digest", Some(json!({"paused":false})))]).await.unwrap_err();
    assert_eq!(codes(&rejected), ["refresh_needs_user_turn"]);
    // Removed.
    update(&ws, "a", &project, vec![put("Digest", Some(Value::Null))]).await.unwrap();
    assert!(timer(&ws, &project, identity).is_none());
    // validateOnly says the same before anything is written.
    let check = json!({"validateOnly":true,"expectedVersion":version(&ws, &project),"changes":[put("Digest", Some(daily()))]});
    let preview = update::update(&ws, &Checker::Fake(accept), "a", check).await.unwrap().unwrap();
    assert_eq!((&preview["valid"], &preview["problems"][0]["code"]), (&json!(false), &json!("refresh_needs_user_turn")));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_users_limits_refuse_making_one_or_making_it_faster_but_stop_none_already_on() {
    let (_dir, ws, project) = lab();
    turn(&ws, "a", "u1", Some("client"));
    update(&ws, "a", &project, vec![put("Digest", Some(json!({"every":"hours","hours":1,"instruction":INSTRUCTION})))]).await.unwrap();
    let identity = live(&ws, &project).identity;
    set_limits(&ws, 2, 1);
    // Already on: its card is still written, and it may be paused.
    update(&ws, "a", &project, vec![put("Digest", None)]).await.unwrap();
    update(&ws, "a", &project, vec![put("Digest", Some(json!({"paused":true})))]).await.unwrap();
    // On again at once an hour: shorter than the user allows now.
    let rejected = update(&ws, "a", &project, vec![put("Digest", Some(json!({"paused":false})))]).await.unwrap_err();
    assert_eq!(codes(&rejected), ["refresh_too_often"]);
    assert!(rejected["problems"][0]["reason"].as_str().unwrap().contains("2 hours"));
    update(&ws, "a", &project, vec![put("Digest", Some(json!({"hours":2,"paused":false})))]).await.unwrap();
    assert!(timer(&ws, &project, identity).unwrap().enabled);
    // One on is the most: a second card is refused, naming the one on.
    let other = json!({"op":"put","key":"digest/papers","kind":"report","title":"Papers","body":body("Papers"),"refresh":daily()});
    let rejected = update(&ws, "a", &project, vec![other.clone()]).await.unwrap_err();
    assert_eq!(codes(&rejected), ["refresh_limit"]);
    assert!(rejected["problems"][0]["reason"].as_str().unwrap().contains("“Digest” (Code)"), "{rejected}");
    // Paused, it may be made; on again it is refused.
    let mut paused = other.clone();
    paused["refresh"]["paused"] = json!(true);
    update(&ws, "a", &project, vec![paused]).await.unwrap();
    let on = json!({"op":"edit","key":"digest/papers","refresh":{"paused":false}});
    assert_eq!(codes(&update(&ws, "a", &project, vec![on]).await.unwrap_err()), ["refresh_limit"]);
}

/// Home's routes, as the browser calls them.
async fn route(ws: &Arc<Workspace>, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut request = axum::http::Request::builder().method(method).uri(path);
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    let request = request.body(body.map_or_else(axum::body::Body::empty, |b| axum::body::Body::from(b.to_string()))).unwrap();
    let response = super::router().with_state(ws.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 22).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))))
}

#[tokio::test(flavor = "multi_thread")]
async fn the_user_changes_pauses_and_removes_a_refresh_against_the_version_read() {
    let (_dir, ws, project) = lab();
    turn(&ws, "a", "u1", Some("client"));
    update(&ws, "a", &project, vec![put("Digest", Some(daily()))]).await.unwrap();
    let identity = live(&ws, &project).identity;
    let path = format!("/api/projects/{project}/brief/refreshes/{identity}");
    let mut events = ws.changes.subscribe(None);
    // An older page's change: refused, with the refresh as it is now.
    let (status, stale) = route(&ws, "PUT", &path, Some(json!({"version":0,"enabled":false}))).await;
    assert_eq!((status, &stale["code"], &stale["current"]["version"]), (StatusCode::CONFLICT, &json!("version_conflict"), &json!(1)));
    assert!(timer(&ws, &project, identity).unwrap().enabled);
    // The user's own change is not bound to a Turn: a new instruction, every 12 hours.
    let change = json!({"version":1,"cadence":{"every":"hours","hours":12,"at":"06:00"},"instruction":"Only papers.","zone":"local"});
    let (status, changed) = route(&ws, "PUT", &path, Some(change)).await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!((&changed["version"], &changed["weeklyRuns"], &changed["instruction"], &changed["zone"]),
        (&json!(2), &json!(14), &json!("Only papers."), &json!("local")));
    assert!(events.try_next().is_some(), "pages are told");
    let (status, invalid) = route(&ws, "PUT", &path, Some(json!({"version":2,"cadence":{"every":"hours","hours":5}}))).await;
    assert_eq!((status, &invalid["code"]), (StatusCode::BAD_REQUEST, &json!("refresh_invalid")));
    // Off, then on: on again makes up for nothing paused.
    let (_, off) = route(&ws, "PUT", &path, Some(json!({"version":2,"enabled":false}))).await;
    assert_eq!((&off["enabled"], &off["pausedReason"]["code"], &off["nextAt"]), (&json!(false), &json!("paused"), &Value::Null));
    ws.store.db.write().unwrap().execute("UPDATE project_brief_refreshes SET last_slot='2026-01-01T06:00:00+00:00',failures=2",
        []).unwrap();
    let (_, on) = route(&ws, "PUT", &path, Some(json!({"version":3,"enabled":true}))).await;
    assert_eq!((&on["enabled"], &on["pausedReason"], &on["failures"]), (&json!(true), &Value::Null, &json!(0)));
    let back = timer(&ws, &project, identity).unwrap();
    assert!(back.last_slot.unwrap() > Utc::now() - chrono::Duration::hours(12), "no slot before now is due");
    // The limits hold for the user too.
    set_limits(&ws, 24, 10);
    let (status, often) = route(&ws, "PUT", &path, Some(json!({"version":4,"cadence":{"every":"hours","hours":6}}))).await;
    assert_eq!((status, &often["code"]), (StatusCode::BAD_REQUEST, &json!("refresh_too_often")));
    // Removed: the card stays.
    let (status, _) = route(&ws, "DELETE", &path, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(timer(&ws, &project, identity).is_none());
    assert_eq!(live(&ws, &project).identity, identity);
    let (status, gone) = route(&ws, "DELETE", &path, None).await;
    assert_eq!((status, &gone["code"]), (StatusCode::NOT_FOUND, &json!("refresh_not_found")));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_user_reads_and_saves_the_limits_against_their_version() {
    let (_dir, ws, _project) = lab();
    let (status, limits) = route(&ws, "GET", "/api/brief-refreshes/limits", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((&limits["version"], &limits["minHours"], &limits["maxActive"], &limits["pauseAfterFailures"], &limits["ranges"]["maxActive"]),
        (&json!(0), &json!(1), &json!(10), &json!(3), &json!([1, 50])));
    let (status, saved) = route(&ws, "PUT", "/api/brief-refreshes/limits",
        Some(json!({"version":0,"minHours":2,"maxActive":5,"pauseAfterFailures":4}))).await;
    assert_eq!((status, &saved["version"], &saved["maxActive"]), (StatusCode::OK, &json!(1), &json!(5)));
    assert_eq!(refresh::limits(&ws.store.db.read().unwrap()).unwrap().pause_after_failures, 4);
    let (status, stale) = route(&ws, "PUT", "/api/brief-refreshes/limits",
        Some(json!({"version":0,"minHours":1,"maxActive":5,"pauseAfterFailures":4}))).await;
    assert_eq!((status, &stale["current"]["minHours"]), (StatusCode::CONFLICT, &json!(2)));
    for (field, value) in [("minHours", 25), ("maxActive", 0), ("maxActive", 51), ("pauseAfterFailures", 11)] {
        let mut input = json!({"version":1,"minHours":2,"maxActive":5,"pauseAfterFailures":4});
        input[field] = json!(value);
        let (status, refused) = route(&ws, "PUT", "/api/brief-refreshes/limits", Some(input)).await;
        assert_eq!((status, &refused["code"]), (StatusCode::BAD_REQUEST, &json!("invalid_input")), "{field} {value}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cards_issues_are_listed_and_read_whole_with_their_attachments_by_version() {
    let (dir, ws, project) = lab();
    turn(&ws, "a", "u1", Some("client"));
    let file = |name: &str, text: &str| {
        let path = dir.path().join(name);
        std::fs::write(&path, text).unwrap();
        path
    };
    let with = |title: &str, path: std::path::PathBuf, refresh: Option<Value>| {
        let mut change = put(title, refresh);
        change["body"]["elements"]["body"]["children"] = json!(["lead", "files"]);
        change["body"]["elements"]["files"] = json!({"type":"Attachments","props":{"items":[{"name":"notes.txt"}]}});
        change["attachments"] = json!([{"name":"notes.txt","path":path}]);
        change
    };
    update(&ws, "a", &project, vec![with("Digest, Nov 13", file("one.txt", "Synthetic notes one."), Some(daily()))]).await.unwrap();
    let identity = live(&ws, &project).identity;
    let mut second = with("Digest, Nov 14", file("two.txt", "Synthetic notes two."), None);
    second["body"]["elements"]["lead"]["props"]["text"] = json!("\n  Two new papers today.\nMore below.");
    update(&ws, "a", &project, vec![second]).await.unwrap();
    let base = format!("/api/projects/{project}/brief/refreshes/{identity}/versions");
    let (status, listed) = route(&ws, "GET", &base, None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    let versions = listed["versions"].as_array().unwrap();
    assert_eq!(versions.iter().map(|v| (v["version"].clone(), v["live"].clone(), v["historyReason"].clone())).collect::<Vec<_>>(),
        [(json!(2), json!(true), Value::Null), (json!(1), json!(false), json!("refreshed"))]);
    assert_eq!((&versions[0]["lead"], &versions[1]["lead"], &versions[1]["title"]),
        (&json!("Two new papers today."), &json!("Digest, Nov 13"), &json!("Digest, Nov 13")));
    assert!(versions[0].get("body").is_none(), "no bodies in the list");
    let (status, old) = route(&ws, "GET", &format!("{base}/1"), None).await;
    assert_eq!((status, &old["title"], &old["id"], &old["history"], &old["historyReason"]),
        (StatusCode::OK, &json!("Digest, Nov 13"), &json!(identity), &json!(true), &json!("refreshed")));
    assert_eq!(old["body"]["elements"]["lead"]["props"]["text"], "Digest, Nov 13");
    let (status, missing) = route(&ws, "GET", &format!("{base}/9"), None).await;
    assert_eq!((status, &missing["code"]), (StatusCode::NOT_FOUND, &json!("version_not_found")));
    // Each issue's attachment, by its version.
    let key = KEY.replace('/', "%2F");
    let attachment = |version: i64| format!("/api/projects/{project}/brief/attachments/{key}/notes.txt?version={version}");
    assert_eq!(route(&ws, "GET", &attachment(1), None).await.1, json!("Synthetic notes one."));
    assert_eq!(route(&ws, "GET", &attachment(2), None).await.1, json!("Synthetic notes two."));
    // History's days: the past issue goes.
    ws.store.db.write().unwrap().execute(
        "UPDATE project_brief_sections SET history_at=?2 WHERE project_id=?1 AND history_reason='refreshed'",
        params![project, (Utc::now() - chrono::Duration::days(HISTORY_DAYS + 1)).to_rfc3339()]).unwrap();
    sections::expire_history(&ws.store.db.write().unwrap()).unwrap();
    assert_eq!(rows(&ws, &project), vec![(2, identity, true, None)]);
    let (_, listed) = route(&ws, "GET", &base, None).await;
    assert_eq!(listed["versions"].as_array().unwrap().len(), 1);
    assert_eq!(route(&ws, "GET", &attachment(1), None).await.0, StatusCode::NOT_FOUND);
}

fn at(text: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&Utc)
}

#[tokio::test(flavor = "multi_thread")]
async fn refresh_now_is_sent_once_when_its_owner_is_free_and_leaves_the_slots_as_they_were() {
    let (_dir, ws, project) = lab();
    turn(&ws, "a", "u1", Some("client"));
    update(&ws, "a", &project, vec![put("Digest", Some(daily()))]).await.unwrap();
    let identity = live(&ws, &project).identity;
    let before = timer(&ws, &project, identity).unwrap();
    let path = format!("/api/projects/{project}/brief/refreshes/{identity}/now");
    let (status, asked) = route(&ws, "POST", &path, Some(json!({"requestId":"now-1"}))).await;
    assert_eq!(status, StatusCode::OK, "{asked}");
    assert_eq!(timer(&ws, &project, identity).unwrap().progress.now.unwrap().request_id, "now-1");
    // Its owner is still in the Turn that made it: the request waits.
    let sent: Arc<Mutex<Vec<(String, Value, String)>>> = Default::default();
    let log = sent.clone();
    let store = ws.clone();
    let sender = Sender::Fake(Box::new(move |agent: &str, input: &MessageInput, origin: &Value| {
        let receipt: MessageReceipt = serde_json::from_value(json!({"input":input,"origin":origin,"status":"accepted","turnId":"r1"}))?;
        let kept = receipt.clone();
        store.store.update(agent, "test/refresh-now", &json!({}), move |d| {
            d.message_receipts.push(kept);
            d.turns.push(json!({"id":"r1","status":"inProgress","items":[]}));
            d.agent.status = "working".into();
        })?;
        log.lock().unwrap().push((input.client_message_id.clone(), origin.clone(), input.text.clone()));
        Ok(receipt)
    }));
    let now = Utc::now();
    refresh::tick(&ws, &sender, now).await.unwrap();
    let waiting = timer(&ws, &project, identity).unwrap().progress.waiting.unwrap();
    assert_eq!((waiting.reason.as_str(), waiting.manual.as_deref()), ("busy", Some("now-1")));
    assert!(sent.lock().unwrap().is_empty());
    // Free: sent, by when it was asked for, and the next slot stays.
    ws.store.update("a", "test/idle", &json!({}), |d| {
        for t in &mut d.turns {
            t["status"] = json!("completed");
        }
        d.agent.status = "idle".into();
    }).unwrap();
    refresh::tick(&ws, &sender, now).await.unwrap();
    let messages = sent.lock().unwrap().clone();
    assert_eq!(messages.len(), 1);
    assert!(messages[0].0.starts_with(&format!("brief-refresh-{project}-{identity}-now-")), "{}", messages[0].0);
    assert_eq!((&messages[0].1["kind"], &messages[0].1["now"]), (&json!("schedule"), &json!("now-1")));
    assert!(messages[0].2.contains("立即刷新") && messages[0].2.ends_with(INSTRUCTION));
    let r = timer(&ws, &project, identity).unwrap();
    assert_eq!((r.last_slot, r.progress.now.clone(), r.progress.waiting.clone()), (before.last_slot, None, None));
    assert_eq!((r.progress.run.as_ref().unwrap().manual.as_deref(), r.progress.run.as_ref().unwrap().state.as_str()), (Some("now-1"), "sent"));
    // The same request again, or another while it runs: nothing more.
    for id in ["now-1", "now-2"] {
        let (status, _) = route(&ws, "POST", &path, Some(json!({"requestId":id}))).await;
        assert_eq!(status, StatusCode::OK);
        assert!(timer(&ws, &project, identity).unwrap().progress.now.is_none(), "{id}");
    }
    // Paused: refused.
    let refresh_path = format!("/api/projects/{project}/brief/refreshes/{identity}");
    let version = timer(&ws, &project, identity).unwrap().version;
    route(&ws, "PUT", &refresh_path, Some(json!({"version":version,"enabled":false}))).await;
    let (status, paused) = route(&ws, "POST", &path, Some(json!({"requestId":"now-3"}))).await;
    assert_eq!((status, &paused["code"]), (StatusCode::CONFLICT, &json!("refresh_paused")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slot_due_answers_a_refresh_now_and_a_waiting_one_gives_way_without_a_failure() {
    let (_dir, ws, project) = lab();
    turn(&ws, "a", "u1", Some("client"));
    update(&ws, "a", &project, vec![put("Digest", Some(daily()))]).await.unwrap();
    let identity = live(&ws, &project).identity;
    // Made long ago, so the day's slot is due; and the user asked to refresh now.
    ws.store.db.write().unwrap().execute(
        "UPDATE project_brief_refreshes SET created_at='2026-11-13T09:00:00+00:00',
         run='{\"now\":{\"requestId\":\"now-1\",\"at\":\"2026-11-14T07:00:00Z\"},\"waiting\":{\"slot\":\"2026-11-14T07:00:00Z\",\"missed\":0,\"reason\":\"busy\",\"agentId\":\"a\",\"since\":\"2026-11-14T07:00:00Z\",\"manual\":\"now-1\"}}'",
        []).unwrap();
    let sender = Sender::Fake(Box::new(|_: &str, _: &MessageInput, _: &Value| -> Result<MessageReceipt> { anyhow::bail!("not sent in this test") }));
    // Its owner is busy: the slot waits in the request's place, with no failure.
    refresh::tick(&ws, &sender, at("2026-11-14T08:00:10Z")).await.unwrap();
    let r = timer(&ws, &project, identity).unwrap();
    let waiting = r.progress.waiting.unwrap();
    assert_eq!((waiting.slot, waiting.manual, r.progress.now, r.failures, r.recent.len()),
        (at("2026-11-14T08:00:00Z"), None, None, 0, 0));
}
