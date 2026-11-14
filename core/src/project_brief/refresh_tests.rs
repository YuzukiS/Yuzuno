//! The timer of Home cards that refresh themselves (YN-113 R1): slots and
//! missed counts in UTC and in a zone with summer time; what a look does with
//! a refresh, its card's owner and the message it sends, through a stand-in
//! for Core's message path that keeps the receipt and starts a Turn as Core
//! does; and the backup copy, which holds every refresh paused.
use super::{
    refresh::{self, between_in, latest_in, next_in, Cadence, Clock, Sender},
    tests::{lab, set_leads},
    update::{self, Checker},
    *,
};
use crate::model::{MessageInput, MessageReceipt};
use chrono::{offset::MappedLocalTime, DateTime, Duration, FixedOffset, NaiveDate, NaiveDateTime, TimeZone, Utc};
use std::sync::Mutex;

const KEY: &str = "digest/news";
const INSTRUCTION: &str = "Summarize the three most important synthetic headlines of the day.";

fn at(text: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&Utc)
}

fn clock(cadence: Value) -> Clock {
    serde_json::from_value::<Cadence>(cadence).unwrap().clock().unwrap()
}

#[test]
fn cadences_read_as_the_design_names_them_and_anything_else_is_refused() {
    let read = |cadence: &Value| -> Result<Cadence> {
        let cadence: Cadence = serde_json::from_value(cadence.clone())?;
        cadence.clock()?;
        Ok(cadence)
    };
    for (cadence, weekly) in [
        (json!({"every":"day","at":"08:00"}), 7),
        (json!({"every":"hours","hours":6}), 28),
        (json!({"every":"hours","hours":1,"at":"00:30"}), 168),
        (json!({"every":"hours","hours":12,"at":"07:30"}), 14),
        (json!({"every":"week","days":[1,4],"at":"21:00"}), 2),
    ] {
        assert_eq!(read(&cadence).unwrap_or_else(|e| panic!("{cadence}: {e:#}")).weekly_runs(), weekly, "{cadence}");
    }
    for bad in [
        json!({"every":"day"}),
        json!({"every":"day","at":"8:00"}),
        json!({"every":"day","at":"24:00"}),
        json!({"every":"day","at":"08:60"}),
        json!({"every":"day","at":"08:00","hours":2}),
        json!({"every":"day","at":"08:00","days":[1]}),
        json!({"every":"hours"}),
        json!({"every":"hours","hours":5}),
        json!({"every":"hours","hours":24}),
        json!({"every":"hours","hours":6,"days":[1]}),
        json!({"every":"week","at":"08:00"}),
        json!({"every":"week","at":"08:00","days":[]}),
        json!({"every":"week","at":"08:00","days":[0]}),
        json!({"every":"week","at":"08:00","days":[8]}),
        json!({"every":"week","at":"08:00","days":[2,2]}),
        json!({"every":"week","days":[1],"at":"08:00","hours":1}),
        json!({"every":"month","at":"08:00"}),
        json!({"every":"day","at":"08:00","zone":"UTC"}),
    ] {
        assert!(read(&bad).is_err(), "{bad}");
    }
    assert!(refresh::parse_zone("local").is_ok() && refresh::parse_zone("UTC").is_ok());
    assert!(refresh::parse_zone("utc").is_err() && refresh::parse_zone("Europe/Berlin").is_err());
}

#[test]
fn utc_slots_their_latest_and_next_and_how_many_were_missed() {
    let day = clock(json!({"every":"day","at":"08:00"}));
    assert_eq!(latest_in(&day, &Utc, at("2026-11-14T07:59:59Z")), Some(at("2026-11-13T08:00:00Z")));
    assert_eq!(latest_in(&day, &Utc, at("2026-11-14T08:00:00Z")), Some(at("2026-11-14T08:00:00Z")));
    assert_eq!(next_in(&day, &Utc, at("2026-11-14T08:00:00Z")), Some(at("2026-11-15T08:00:00Z")));
    assert_eq!(between_in(&day, &Utc, at("2026-11-10T08:00:00Z"), at("2026-11-14T08:00:00Z")), 3);
    assert_eq!(between_in(&day, &Utc, at("2026-11-14T08:00:00Z"), at("2026-11-14T08:00:00Z")), 0);
    // Every 6 hours from 01:00: 01, 07, 13 and 19 o'clock.
    let hours = clock(json!({"every":"hours","hours":6,"at":"01:00"}));
    assert_eq!(latest_in(&hours, &Utc, at("2026-11-14T00:30:00Z")), Some(at("2026-11-13T19:00:00Z")));
    assert_eq!(next_in(&hours, &Utc, at("2026-11-14T00:30:00Z")), Some(at("2026-11-14T01:00:00Z")));
    assert_eq!(between_in(&hours, &Utc, at("2026-11-13T01:00:00Z"), at("2026-11-14T01:00:00Z")), 3);
    // Mondays and Thursdays at 21:00 (2026-11-14 is a Saturday).
    let week = clock(json!({"every":"week","days":[1,4],"at":"21:00"}));
    assert_eq!(latest_in(&week, &Utc, at("2026-11-14T12:00:00Z")), Some(at("2026-11-12T21:00:00Z")));
    assert_eq!(next_in(&week, &Utc, at("2026-11-14T12:00:00Z")), Some(at("2026-11-16T21:00:00Z")));
    assert_eq!(between_in(&week, &Utc, at("2026-11-02T21:00:00Z"), at("2026-11-16T21:00:00Z")), 3);
    // A year stopped is counted, at most over COUNT_DAYS.
    assert_eq!(between_in(&day, &Utc, at("2025-11-14T08:00:00Z"), at("2026-11-14T08:00:00Z")), 364);
    assert!(between_in(&day, &Utc, at("2020-01-01T08:00:00Z"), at("2026-11-14T08:00:00Z")) <= 400);
}

/// A synthetic zone with summer time: UTC+1, and UTC+2 from 2026-03-29
/// 01:00 UTC (02:00 local becomes 03:00) to 2026-10-25 01:00 UTC (03:00
/// local becomes 02:00 again).
#[derive(Clone, Copy, Debug)]
struct Summer;

impl Summer {
    fn at(utc: &NaiveDateTime) -> FixedOffset {
        let summer = *utc >= at("2026-03-29T01:00:00Z").naive_utc() && *utc < at("2026-10-25T01:00:00Z").naive_utc();
        FixedOffset::east_opt(if summer { 7200 } else { 3600 }).unwrap()
    }
}

impl TimeZone for Summer {
    type Offset = FixedOffset;
    fn from_offset(_: &FixedOffset) -> Self {
        Summer
    }
    fn offset_from_local_date(&self, _: &NaiveDate) -> MappedLocalTime<FixedOffset> {
        MappedLocalTime::Single(FixedOffset::east_opt(3600).unwrap())
    }
    fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> MappedLocalTime<FixedOffset> {
        let fits: Vec<FixedOffset> = [7200, 3600].into_iter().map(|seconds| FixedOffset::east_opt(seconds).unwrap())
            .filter(|offset| Summer::at(&(*local - Duration::seconds(i64::from(offset.local_minus_utc())))) == *offset)
            .collect();
        match fits.as_slice() {
            [one] => MappedLocalTime::Single(*one),
            [first, second] => MappedLocalTime::Ambiguous(*first, *second),
            _ => MappedLocalTime::None,
        }
    }
    fn offset_from_utc_date(&self, _: &NaiveDate) -> FixedOffset {
        FixedOffset::east_opt(3600).unwrap()
    }
    fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
        Summer::at(utc)
    }
}

#[test]
fn local_time_skips_and_repeats_with_the_hosts_clock() {
    let half_two = clock(json!({"every":"day","at":"02:30"}));
    // The day before: 02:30 at UTC+1.
    assert_eq!(latest_in(&half_two, &Summer, at("2026-03-28T12:00:00Z")), Some(at("2026-03-28T01:30:00Z")));
    // 02:30 does not exist on the day summer time starts: the first instant after it, 03:00 at UTC+2.
    assert_eq!(latest_in(&half_two, &Summer, at("2026-03-29T12:00:00Z")), Some(at("2026-03-29T01:00:00Z")));
    assert_eq!(next_in(&half_two, &Summer, at("2026-03-29T01:00:00Z")), Some(at("2026-03-30T00:30:00Z")));
    // 02:30 comes twice on the day it ends: the first, at UTC+2; the second is no slot.
    assert_eq!(latest_in(&half_two, &Summer, at("2026-10-25T12:00:00Z")), Some(at("2026-10-25T00:30:00Z")));
    assert_eq!(latest_in(&half_two, &Summer, at("2026-10-25T01:45:00Z")), Some(at("2026-10-25T00:30:00Z")));
    assert_eq!(next_in(&half_two, &Summer, at("2026-10-25T00:30:00Z")), Some(at("2026-10-26T01:30:00Z")));
    // Every hour: the skipped 02:00 is the same instant as 03:00, so that
    // day has 23 slots; the day the hour repeats has 24, each once.
    let hourly = clock(json!({"every":"hours","hours":1}));
    assert_eq!(between_in(&hourly, &Summer, at("2026-03-28T23:00:00Z"), at("2026-03-29T22:00:00Z")), 22);
    assert_eq!(between_in(&hourly, &Summer, at("2026-10-24T22:00:00Z"), at("2026-10-25T23:00:00Z")), 23);
    assert_eq!(latest_in(&hourly, &Summer, at("2026-10-25T01:59:00Z")), Some(at("2026-10-25T00:00:00Z")));
    assert_eq!(next_in(&hourly, &Summer, at("2026-10-25T00:00:00Z")), Some(at("2026-10-25T02:00:00Z")));
}

#[test]
fn the_message_is_cores_lead_then_the_instruction_and_its_id_fits() {
    let text = refresh::message("Daily", "Digest", KEY, "11-14 08:00 UTC", 2, Some("The user's Home presentation preference: synthetic."), INSTRUCTION);
    assert!(text.starts_with("[Yuzuno 定时刷新] 刷新你在「Daily」的报告「Digest」（key digest/news）：11-14 08:00 UTC 这一次（错过 2 次）。"), "{text}");
    for part in ["brief_update", "visual first", "The user's Home presentation preference: synthetic.", "不是指令", "不能新建或加快"] {
        assert!(text.contains(part), "{part}: {text}");
    }
    assert!(text.ends_with(&format!("\n{INSTRUCTION}")));
    let plain = refresh::message("Daily", "Digest", KEY, "11-14 08:00 UTC", 0, None, INSTRUCTION);
    assert!(!plain.contains("错过") && !plain.contains("preference"));
    // Core's project IDs are UUIDs; a message ID is at most 100 bytes.
    let id = refresh::client_id("6f9d1c2e-3b4a-4c5d-8e7f-0a1b2c3d4e5f", i64::MAX, at("2026-11-14T08:00:00Z"));
    assert!(id.len() <= 100 && id.ends_with("-20261114T0800Z"), "{id}");
}

fn accept(section: &Value) -> Result<Value, Value> {
    Ok(section.clone())
}

/// `agent` puts the card in the Turn it is running; its identity on Home.
async fn put_card(ws: &Arc<Workspace>, agent: &str, project: &str, title: &str) -> i64 {
    let expected = sections::brief_version(&ws.store.db.read().unwrap(), project).unwrap();
    let body = json!({"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["lead"]},
        "lead":{"type":"Markdown","props":{"text":title}}}});
    let input = json!({"requestId":format!("put-{expected}"),"expectedVersion":expected,
        "changes":[{"op":"put","key":KEY,"kind":"report","title":title,"body":body}]});
    let answer = update::update(ws, &Checker::Fake(accept), agent, input).await.unwrap();
    assert!(answer.is_ok(), "{answer:?}");
    sections::live_key(&ws.store.db.read().unwrap(), project, KEY).unwrap().unwrap().identity
}

/// Every Turn of `id` still running ends as `status`; it is connected, and
/// idle (in error after a failed one).
fn ended(ws: &Workspace, id: &str, status: &str, error: Option<&str>) {
    ws.store.update(id, "test/ended", &json!({}), |d| {
        for turn in d.turns.iter_mut().filter(|t| t["status"] == "inProgress") {
            turn["status"] = json!(status);
            if let Some(error) = error {
                turn["error"] = json!({"message":error});
            }
        }
        d.agent.status = if status == "failed" { "error" } else { "idle" }.into();
        d.agent.connection_state = "connected".into();
    }).unwrap();
}

/// `id` runs a Turn of the user's.
fn working(ws: &Workspace, id: &str, turn: &str) {
    ws.store.update(id, "test/working", &json!({}), |d| {
        d.turns.push(json!({"id":turn,"status":"inProgress","items":[]}));
        d.agent.status = "working".into();
        d.agent.connection_state = "connected".into();
    }).unwrap();
}

/// What the stand-in for Core's message path was given.
#[derive(Clone, Debug)]
struct Sent {
    agent: String,
    client: String,
    text: String,
    origin: Value,
}

/// Takes a message as Core does: its receipt is kept with the Agent, and
/// the Agent starts Turn `r<n>` for it.
fn sender(ws: &Arc<Workspace>, log: &Arc<Mutex<Vec<Sent>>>) -> Sender {
    let (ws, log) = (ws.clone(), log.clone());
    Sender::Fake(Box::new(move |agent: &str, input: &MessageInput, origin: &Value| {
        let turn = format!("r{}", log.lock().unwrap().len() + 1);
        let receipt: MessageReceipt = serde_json::from_value(json!({"input":input,"origin":origin,"status":"accepted","turnId":turn}))?;
        let kept = receipt.clone();
        ws.store.update(agent, "test/refresh-sent", &json!({}), move |d| {
            d.message_receipts.push(kept);
            d.turns.push(json!({"id":turn,"status":"inProgress","items":[]}));
            d.agent.status = "working".into();
        })?;
        log.lock().unwrap().push(Sent { agent: agent.into(), client: input.client_message_id.clone(), text: input.text.clone(), origin: origin.clone() });
        Ok(receipt)
    }))
}

fn make(ws: &Workspace, project: &str, identity: i64, cadence: Value, created: &str) {
    ws.store.db.write().unwrap().execute(
        "INSERT INTO project_brief_refreshes(project_id,identity,key,cadence,zone,instruction,enabled,version,failures,created_at,created_by,updated_at)
         VALUES(?1,?2,?3,?4,'UTC',?5,1,1,0,?6,'a',?6)",
        params![project, identity, KEY, cadence.to_string(), INSTRUCTION, created],
    ).unwrap();
}

fn refresh_of(ws: &Workspace, project: &str, identity: i64) -> refresh::Refresh {
    refresh::one(&ws.store.db.read().unwrap(), project, identity).unwrap().unwrap()
}

/// The user turns it on again, as Settings will (R2).
fn turn_on(ws: &Workspace, project: &str, identity: i64) {
    ws.store.db.write().unwrap().execute(
        "UPDATE project_brief_refreshes SET enabled=1,paused_reason=NULL,failures=0,version=version+1 WHERE project_id=?1 AND identity=?2",
        params![project, identity],
    ).unwrap();
}

/// A Project whose lead `a` put the card in Turn t1, which ended; the card
/// refreshes on `cadence` in UTC from `created`.
async fn card(cadence: Value, created: &str) -> (tempfile::TempDir, Arc<Workspace>, String, i64) {
    let (dir, ws, project) = lab();
    let identity = put_card(&ws, "a", &project, "Synthetic digest").await;
    ended(&ws, "a", "completed", None);
    make(&ws, &project, identity, cadence, created);
    (dir, ws, project, identity)
}

type Log = Arc<Mutex<Vec<Sent>>>;

fn sends(log: &Log) -> Vec<Sent> {
    log.lock().unwrap().clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slot_is_sent_once_to_the_cards_owner_and_its_turn_writing_the_card_refreshes_it() {
    let (_dir, ws, project, identity) = card(json!({"every":"day","at":"08:00"}), "2026-11-13T09:00:00Z").await;
    let log: Log = Default::default();
    let send = sender(&ws, &log);
    // Made after the day's slot: nothing until the next one.
    assert!(refresh::tick(&ws, &send, at("2026-11-14T07:59:59Z")).await.unwrap().is_empty());
    assert!(sends(&log).is_empty());
    assert_eq!(refresh::tick(&ws, &send, at("2026-11-14T08:00:10Z")).await.unwrap(), vec![project.clone()]);
    let sent = sends(&log);
    assert_eq!(sent.len(), 1);
    assert_eq!((sent[0].agent.as_str(), sent[0].client.clone()), ("a", format!("brief-refresh-{project}-{identity}-20261114T0800Z")));
    assert_eq!(sent[0].origin, json!({"kind":"schedule","projectId":project,"key":KEY,"identity":identity,
        "slot":"2026-11-14T08:00:00Z","missed":0}));
    assert!(sent[0].text.starts_with("[Yuzuno 定时刷新]") && sent[0].text.contains("「Synthetic digest」"), "{}", sent[0].text);
    assert!(sent[0].text.contains("11-14 08:00 UTC") && sent[0].text.ends_with(INSTRUCTION) && !sent[0].text.contains("错过"));
    let run = refresh_of(&ws, &project, identity).progress.run.unwrap();
    assert_eq!((run.state.as_str(), run.turn_id.as_deref(), run.agent_id.as_deref()), ("sent", Some("r1"), Some("a")));
    // The conversation names its input a refresh, from its receipt.
    let mut conversation = json!([{"id":"r1","items":[{"type":"userMessage","clientId":sent[0].client}]}]);
    crate::input_origin::annotate(&ws.store.db.read().unwrap(), "a", conversation.as_array_mut().unwrap()).unwrap();
    assert_eq!(conversation[0]["items"][0]["_yuzunoInput"], "schedule");
    // Looked at again while its Turn runs: nothing more is sent or changed.
    assert!(refresh::tick(&ws, &send, at("2026-11-14T08:00:40Z")).await.unwrap().is_empty());
    assert_eq!(sends(&log).len(), 1);
    // The Turn writes the card and ends: refreshed.
    put_card(&ws, "a", &project, "Synthetic digest, Nov 14").await;
    ended(&ws, "a", "completed", None);
    refresh::tick(&ws, &send, at("2026-11-14T08:03:00Z")).await.unwrap();
    let r = refresh_of(&ws, &project, identity);
    let run = r.progress.run.clone().unwrap();
    assert_eq!((run.state.as_str(), run.ended_at), ("refreshed", Some(at("2026-11-14T08:03:00Z"))));
    assert_eq!((r.failures, r.recent.len(), r.recent[0].state.as_str()), (0, 1, "refreshed"));
    assert_eq!(r.version, 1, "the timer's own writes leave the version to the user's changes");
    let shown = refresh::view(&r, 0, &|_: &str| None, at("2026-11-14T08:03:00Z"));
    assert_eq!((&shown["nextAt"], &shown["weeklyRuns"], &shown["utcOffset"], &shown["waiting"]),
        (&json!("2026-11-15T08:00:00Z"), &json!(7), &json!("+00:00"), &Value::Null));
    // Home shows it on the card, once.
    let home = home::build(&ws.store).unwrap();
    let panel = home["projects"].as_array().unwrap().iter().find(|p| p["project"]["id"] == project.as_str()).unwrap();
    let card = panel["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == KEY).unwrap();
    assert_eq!((&card["refresh"]["run"]["state"], &card["refresh"]["instruction"], &card["refresh"]["enabled"]),
        (&json!("refreshed"), &json!(INSTRUCTION), &json!(true)));
    // And Settings lists it.
    let listed = refresh::list(&ws.store).unwrap();
    assert_eq!((&listed["total"], &listed["limits"]["pauseAfterFailures"]), (&json!({"cards":1,"active":1,"weeklyRuns":7}), &json!(3)));
    assert_eq!((&listed["items"][0]["title"], &listed["items"][0]["live"], &listed["items"][0]["identity"]),
        (&json!("Synthetic digest, Nov 14"), &json!(true), &json!(identity)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slot_sent_before_core_stopped_is_not_sent_again() {
    let (_dir, ws, project, identity) = card(json!({"every":"day","at":"08:00"}), "2026-11-13T09:00:00Z").await;
    let log: Log = Default::default();
    let send = sender(&ws, &log);
    refresh::tick(&ws, &send, at("2026-11-14T08:00:10Z")).await.unwrap();
    assert_eq!(sends(&log).len(), 1);
    // Core stopped once the message went, before it wrote the slot down.
    ws.store.db.write().unwrap().execute(
        "UPDATE project_brief_refreshes SET last_slot=NULL,run=NULL WHERE project_id=?1 AND identity=?2", params![project, identity]).unwrap();
    // The next Core's look finds the slot's receipt, and sends nothing.
    refresh::tick(&ws, &send, at("2026-11-14T08:01:00Z")).await.unwrap();
    assert_eq!(sends(&log).len(), 1, "one message per slot");
    let r = refresh_of(&ws, &project, identity);
    assert_eq!((r.last_slot, r.progress.run.unwrap().turn_id), (Some(at("2026-11-14T08:00:00Z")), Some("r1".to_owned())));
}

#[tokio::test(flavor = "multi_thread")]
async fn slots_passed_while_core_was_stopped_are_made_up_once_and_counted() {
    let (_dir, ws, project, identity) = card(json!({"every":"hours","hours":6}), "2026-11-13T00:30:00Z").await;
    let log: Log = Default::default();
    let send = sender(&ws, &log);
    refresh::tick(&ws, &send, at("2026-11-13T06:00:05Z")).await.unwrap();
    put_card(&ws, "a", &project, "Synthetic digest, 06:00").await;
    ended(&ws, "a", "completed", None);
    refresh::tick(&ws, &send, at("2026-11-13T06:05:00Z")).await.unwrap();
    assert_eq!(refresh_of(&ws, &project, identity).progress.run.unwrap().state, "refreshed");
    // Stopped until the next day at 13:00: 12:00, 18:00, 00:00 and 06:00
    // passed; one run, for 12:00, missing four.
    refresh::tick(&ws, &send, at("2026-11-14T13:00:00Z")).await.unwrap();
    let sent = sends(&log);
    assert_eq!(sent.len(), 2);
    assert_eq!((&sent[1].origin["slot"], &sent[1].origin["missed"]), (&json!("2026-11-14T12:00:00Z"), &json!(4)));
    assert!(sent[1].text.contains("（错过 4 次）"), "{}", sent[1].text);
    let run = refresh_of(&ws, &project, identity).progress.run.unwrap();
    assert_eq!((run.slot, run.missed, run.state.as_str()), (at("2026-11-14T12:00:00Z"), 4, "sent"));
    refresh::tick(&ws, &send, at("2026-11-14T13:00:30Z")).await.unwrap();
    assert_eq!(sends(&log).len(), 2, "made up once");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_busy_owner_holds_the_slot_and_a_newer_slot_skips_it_as_a_failure() {
    let (_dir, ws, project, identity) = card(json!({"every":"hours","hours":1}), "2026-11-14T00:30:00Z").await;
    let log: Log = Default::default();
    let send = sender(&ws, &log);
    working(&ws, "a", "chat");
    refresh::tick(&ws, &send, at("2026-11-14T01:00:05Z")).await.unwrap();
    let waiting = refresh_of(&ws, &project, identity).progress.waiting.unwrap();
    assert_eq!((waiting.slot, waiting.reason.as_str(), waiting.agent_id.as_str(), waiting.since),
        (at("2026-11-14T01:00:00Z"), "busy", "a", at("2026-11-14T01:00:05Z")));
    assert!(refresh::tick(&ws, &send, at("2026-11-14T01:30:00Z")).await.unwrap().is_empty(), "still the same wait");
    // Still busy when the next slot comes: the first is skipped, one failure.
    refresh::tick(&ws, &send, at("2026-11-14T02:00:05Z")).await.unwrap();
    let r = refresh_of(&ws, &project, identity);
    assert!(sends(&log).is_empty());
    assert_eq!((r.failures, r.recent.len(), r.recent[0].state.as_str()), (1, 1, "skipped"));
    assert_eq!((r.recent[0].slot, r.recent[0].reason.as_ref().unwrap().code.as_str()), (at("2026-11-14T01:00:00Z"), "waited_busy"));
    assert_eq!(r.progress.run.as_ref().unwrap().state, "skipped", "the card says it was not refreshed on time");
    let waiting = r.progress.waiting.clone().unwrap();
    assert_eq!((waiting.slot, waiting.missed), (at("2026-11-14T02:00:00Z"), 1));
    let shown = refresh::view(&r, 0, &|id: &str| (id == "a").then(|| "Agent a".to_owned()), at("2026-11-14T02:00:05Z"));
    assert_eq!((&shown["waiting"]["reason"], &shown["waiting"]["agentName"]), (&json!("busy"), &json!("Agent a")));
    // Free again: the slot waiting goes, saying what it makes up for.
    ended(&ws, "a", "completed", None);
    refresh::tick(&ws, &send, at("2026-11-14T02:10:00Z")).await.unwrap();
    let sent = sends(&log);
    assert_eq!((sent.len(), &sent[0].origin["slot"], &sent[0].origin["missed"]), (1, &json!("2026-11-14T02:00:00Z"), &json!(1)));
    assert!(sent[0].text.contains("（错过 1 次）"));
    assert_eq!(refresh_of(&ws, &project, identity).progress.waiting, None);
    // Its refresh clears the failure.
    put_card(&ws, "a", &project, "Synthetic digest, 02:00").await;
    ended(&ws, "a", "completed", None);
    refresh::tick(&ws, &send, at("2026-11-14T02:15:00Z")).await.unwrap();
    assert_eq!(refresh_of(&ws, &project, identity).failures, 0);
    // A run still going holds the next slot too.
    refresh::tick(&ws, &send, at("2026-11-14T03:00:05Z")).await.unwrap();
    refresh::tick(&ws, &send, at("2026-11-14T04:00:05Z")).await.unwrap();
    let r = refresh_of(&ws, &project, identity);
    assert_eq!((sends(&log).len(), r.progress.run.as_ref().unwrap().state.as_str()), (2, "sent"));
    assert_eq!(r.progress.waiting.as_ref().map(|w| (w.slot, w.reason.as_str())), Some((at("2026-11-14T04:00:00Z"), "busy")));
    // That run ends (without writing the card: one failure); the slot it held goes.
    ended(&ws, "a", "completed", None);
    refresh::tick(&ws, &send, at("2026-11-14T04:01:00Z")).await.unwrap();
    let r = refresh_of(&ws, &project, identity);
    assert_eq!((sends(&log).len(), r.failures, r.recent.last().unwrap().state.as_str()), (3, 1, "failed"));
    assert_eq!(r.progress.run.as_ref().map(|run| (run.slot, run.state.as_str())), Some((at("2026-11-14T04:00:00Z"), "sent")));
    put_card(&ws, "a", &project, "Synthetic digest, 04:00").await;
    ended(&ws, "a", "completed", None);
    refresh::tick(&ws, &send, at("2026-11-14T04:05:00Z")).await.unwrap();
    // An owner not connected: the slot waits for it to connect.
    ws.store.update("a", "test/offline", &json!({}), |d| d.agent.connection_state = "disconnected".into()).unwrap();
    refresh::tick(&ws, &send, at("2026-11-14T05:00:05Z")).await.unwrap();
    let r = refresh_of(&ws, &project, identity);
    assert_eq!(r.progress.waiting.map(|w| w.reason), Some("offline".to_owned()));
    assert_eq!(sends(&log).len(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn failures_in_a_row_pause_the_refresh() {
    let (_dir, ws, project, identity) = card(json!({"every":"day","at":"08:00"}), "2026-11-10T09:00:00Z").await;
    let log: Log = Default::default();
    let send = sender(&ws, &log);
    let day = |n: u32, time: &str| at(&format!("2026-11-{n}T{time}Z"));
    // Day 1: the Turn ends without writing the card.
    refresh::tick(&ws, &send, day(11, "08:00:05")).await.unwrap();
    ended(&ws, "a", "completed", None);
    refresh::tick(&ws, &send, day(11, "08:05:00")).await.unwrap();
    let r = refresh_of(&ws, &project, identity);
    assert_eq!((r.failures, r.progress.run.unwrap().reason.unwrap().code), (1, "no_update".to_owned()));
    // Day 2: the Turn fails (and the Agent is in error, which does not hold the next slot).
    refresh::tick(&ws, &send, day(12, "08:00:05")).await.unwrap();
    ended(&ws, "a", "failed", Some("Synthetic API error"));
    refresh::tick(&ws, &send, day(12, "08:05:00")).await.unwrap();
    let why = refresh_of(&ws, &project, identity).progress.run.unwrap().reason.unwrap();
    assert_eq!(why.code, "turn_failed");
    assert!(why.message.contains("Synthetic API error") && why.message_zh.contains("Synthetic API error"));
    // Day 3: it is interrupted: the third failure in a row pauses it.
    refresh::tick(&ws, &send, day(13, "08:00:05")).await.unwrap();
    assert_eq!(sends(&log).len(), 3);
    ended(&ws, "a", "interrupted", None);
    refresh::tick(&ws, &send, day(13, "08:05:00")).await.unwrap();
    let r = refresh_of(&ws, &project, identity);
    assert_eq!((r.enabled, r.failures, r.version), (false, 3, 2), "a pause is a change pages are told of");
    assert_eq!(r.paused_reason.as_ref().map(|why| why.code.as_str()), Some("failures"));
    assert_eq!(r.recent.iter().map(|e| e.state.as_str()).collect::<Vec<_>>(), ["failed", "failed", "failed"]);
    // Paused: no more slots.
    refresh::tick(&ws, &send, day(14, "08:00:05")).await.unwrap();
    assert_eq!(sends(&log).len(), 3);
    assert_eq!(refresh::view(&r, 0, &|_: &str| None, day(14, "08:00:05"))["nextAt"], Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_card_whose_owner_no_longer_leads_left_or_was_removed_pauses_and_nothing_is_sent() {
    let (_dir, ws, project, identity) = card(json!({"every":"day","at":"08:00"}), "2026-11-13T09:00:00Z").await;
    let log: Log = Default::default();
    let send = sender(&ws, &log);
    let paused = || refresh_of(&ws, &project, identity).paused_reason.map(|why| why.code);
    set_leads(&ws, &project, &["b", "c"]);
    refresh::tick(&ws, &send, at("2026-11-14T08:00:05Z")).await.unwrap();
    assert_eq!(paused(), Some("owner_not_lead".to_owned()));
    assert!(refresh_of(&ws, &project, identity).paused_reason.unwrap().message_zh.contains("已不是项目负责人"));
    set_leads(&ws, &project, &["a", "b", "c"]);
    // Closed.
    turn_on(&ws, &project, identity);
    ws.store.update("a", "test/closed", &json!({}), |d| d.agent.closed_at = Some(now())).unwrap();
    refresh::tick(&ws, &send, at("2026-11-14T08:01:00Z")).await.unwrap();
    assert_eq!(paused(), Some("owner_closed".to_owned()));
    ws.store.update("a", "test/reopened", &json!({}), |d| d.agent.closed_at = None).unwrap();
    // Moved to another Project.
    turn_on(&ws, &project, identity);
    let other = ws.store.create_project("Elsewhere", Default::default()).unwrap().id;
    ws.store.set_agent_project("a", Some(&other)).unwrap();
    refresh::tick(&ws, &send, at("2026-11-14T08:02:00Z")).await.unwrap();
    assert_eq!(paused(), Some("owner_left".to_owned()));
    ws.store.set_agent_project("a", Some(&project)).unwrap();
    set_leads(&ws, &project, &["a", "b", "c"]);
    // Its owner removes the card.
    turn_on(&ws, &project, identity);
    working(&ws, "a", "t-remove");
    let expected = sections::brief_version(&ws.store.db.read().unwrap(), &project).unwrap();
    let removed = update::update(&ws, &Checker::Fake(accept), "a",
        json!({"requestId":"remove","expectedVersion":expected,"changes":[{"op":"remove","key":KEY}]})).await.unwrap();
    assert!(removed.is_ok(), "{removed:?}");
    ended(&ws, "a", "completed", None);
    refresh::tick(&ws, &send, at("2026-11-14T08:03:00Z")).await.unwrap();
    assert_eq!(paused(), Some("card_removed".to_owned()));
    assert!(sends(&log).is_empty(), "nothing went to an owner that may no longer take it");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_seen_report_keeps_its_refresh() {
    let (_dir, ws, project, identity) = card(json!({"every":"day","at":"08:00"}), "2026-11-13T09:00:00Z").await;
    let log: Log = Default::default();
    let send = sender(&ws, &log);
    let version = sections::live_key(&ws.store.db.read().unwrap(), &project, KEY).unwrap().unwrap().version;
    sections::mark_seen(&ws.store, &project, &[(KEY.to_owned(), version)]).unwrap();
    assert!(sections::live_key(&ws.store.db.read().unwrap(), &project, KEY).unwrap().is_none(), "in history now");
    refresh::tick(&ws, &send, at("2026-11-14T08:00:05Z")).await.unwrap();
    assert_eq!(sends(&log).len(), 1, "its owner is woken to write it again");
    put_card(&ws, "a", &project, "Synthetic digest, Nov 14").await;
    ended(&ws, "a", "completed", None);
    refresh::tick(&ws, &send, at("2026-11-14T08:05:00Z")).await.unwrap();
    let r = refresh_of(&ws, &project, identity);
    assert_eq!((r.enabled, r.progress.run.unwrap().state.as_str()), (true, "refreshed"), "written again under the same identity");
    assert_eq!(sections::live_key(&ws.store.db.read().unwrap(), &project, KEY).unwrap().unwrap().identity, identity);
}

#[test]
fn a_backup_holds_every_refresh_paused_and_the_workspace_backed_up_keeps_its_own() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("source");
    std::fs::create_dir_all(&data).unwrap();
    let waiting = json!({"waiting":{"slot":"2026-11-14T08:00:00Z","missed":0,"reason":"busy","agentId":"a","since":"2026-11-14T08:00:05Z"}});
    let failures = json!({"code":"failures","message":"Paused after 3 failures in a row","messageZh":"连续失败 3 次，已自动暂停"});
    {
        let store = Store::open(&data.join("workspace.sqlite")).unwrap();
        store.db.write().unwrap().execute_batch(&format!(
            "INSERT INTO project_brief_refreshes(project_id,identity,key,cadence,zone,instruction,enabled,paused_reason,version,run,failures,created_at,created_by,updated_at)
             VALUES('p',1,'digest/news','{{\"every\":\"day\",\"at\":\"08:00\"}}','UTC','Synthetic.',1,NULL,1,'{waiting}',0,'2026-11-13T09:00:00Z','a','2026-11-13T09:00:00Z'),
                   ('p',2,'digest/papers','{{\"every\":\"day\",\"at\":\"09:00\"}}','local','Synthetic.',0,'{failures}',4,NULL,3,'2026-11-13T09:00:00Z','a','2026-11-13T09:00:00Z');"
        )).unwrap();
    }
    let out = root.path().join("backup");
    crate::workspace_backup::backup(&data, &out).unwrap();
    let target = root.path().join("restored");
    let restored = crate::workspace_backup::restore(&out, &target).unwrap();
    assert!(restored.notes.iter().any(|note| note.contains("refresh themselves are paused")), "{:?}", restored.notes);
    let copy = Store::open(&target.join("workspace.sqlite")).unwrap();
    let rows = refresh::all(&copy.db.read().unwrap()).unwrap();
    assert_eq!((rows[0].enabled, rows[0].version, rows[0].paused_reason.as_ref().map(|why| why.code.as_str())), (false, 2, Some("restored")));
    assert_eq!(rows[0].progress, refresh::Progress::default(), "nothing waits in the restored Workspace");
    assert_eq!((rows[1].version, rows[1].paused_reason.as_ref().map(|why| why.code.as_str())), (4, Some("failures")), "a pause keeps its reason");
    // The Workspace backed up still refreshes.
    let source = Store::open(&data.join("workspace.sqlite")).unwrap();
    let rows = refresh::all(&source.db.read().unwrap()).unwrap();
    assert!(rows[0].enabled && rows[0].progress.waiting.is_some());
    // A database made before refreshes has none to pause.
    let older = rusqlite::Connection::open_in_memory().unwrap();
    assert_eq!(refresh::pause_for_backup(&older).unwrap(), 0);
}
