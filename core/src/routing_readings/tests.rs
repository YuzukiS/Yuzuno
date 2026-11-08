//! Routing readings (YN-34 S2a): schedules, the daily spend ledger and its
//! read-only route. Synthetic values only.
use super::*;
use crate::{routing_launch::RuntimeProfile, workspace::Workspace};
use chrono::TimeZone;
use serde_json::json;

fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
}

#[test]
fn the_deepseek_peak_is_utc_weekdays_one_to_four_and_six_to_ten() {
    let peak = builtin("deepseek-peak").unwrap();
    peak.check().unwrap();
    // 2026-11-09 is a Monday.
    for (at, inside) in [
        (utc(2026, 11, 9, 0, 59), false), (utc(2026, 11, 9, 1, 0), true), (utc(2026, 11, 9, 3, 59), true),
        (utc(2026, 11, 9, 4, 0), false), (utc(2026, 11, 9, 6, 0), true), (utc(2026, 11, 9, 9, 59), true),
        (utc(2026, 11, 9, 10, 0), false), (utc(2026, 11, 13, 2, 0), true), (utc(2026, 11, 14, 2, 0), false),
        (utc(2026, 11, 15, 7, 0), false),
    ] {
        assert_eq!(peak.inside(at), inside, "{at}");
    }
    assert_eq!(peak.changes_at(utc(2026, 11, 9, 2, 30)), Some(utc(2026, 11, 9, 4, 0)), "the peak ends at 04:00");
    assert_eq!(peak.changes_at(utc(2026, 11, 9, 4, 0)), Some(utc(2026, 11, 9, 6, 0)), "and starts again at 06:00");
    assert_eq!(peak.changes_at(utc(2026, 11, 13, 12, 0)), Some(utc(2026, 11, 16, 1, 0)), "after Friday, next Monday");
    let now = schedule_now(&peak, utc(2026, 11, 14, 12, 0));
    assert_eq!((&now["inside"], &now["changesAt"]), (&json!(false), &json!("2026-11-16T01:00:00+00:00")));
    assert_eq!(serde_json::from_value::<Schedule>(now["schedule"].clone()).unwrap(), peak, "the preset's schedule, to copy");
}

#[test]
fn a_slot_past_midnight_runs_into_the_next_day_and_a_schedule_is_checked() {
    let night: Schedule = serde_json::from_value(json!({"timeZone": "UTC", "slots": [{"days": [7], "from": "22:00", "to": "02:00"}]})).unwrap();
    night.check().unwrap();
    assert!(night.inside(utc(2026, 11, 15, 23, 0)), "Sunday night");
    assert!(night.inside(utc(2026, 11, 16, 1, 59)), "into Monday");
    assert!(!night.inside(utc(2026, 11, 16, 2, 0)));
    assert!(!night.inside(utc(2026, 11, 16, 23, 0)), "not Monday night");
    let always: Schedule = serde_json::from_value(json!({"timeZone": "local", "slots": [{"days": [1,2,3,4,5,6,7], "from": "00:00", "to": "24:00"}]})).unwrap();
    always.check().unwrap();
    assert!(always.inside(Utc::now()) && always.changes_at(Utc::now()).is_none(), "always inside never changes");
    for (bad, said) in [
        (json!({"timeZone": "UTC", "slots": []}), "1 to 16 slots"),
        (json!({"timeZone": "UTC", "slots": [{"days": [0], "from": "01:00", "to": "02:00"}]}), "1 (Monday) to 7 (Sunday)"),
        (json!({"timeZone": "UTC", "slots": [{"days": [1, 1], "from": "01:00", "to": "02:00"}]}), "each day once"),
        (json!({"timeZone": "UTC", "slots": [{"days": [1], "from": "1:00", "to": "02:00"}]}), "HH:MM"),
        (json!({"timeZone": "UTC", "slots": [{"days": [1], "from": "24:00", "to": "02:00"}]}), "HH:MM"),
        (json!({"timeZone": "UTC", "slots": [{"days": [1], "from": "02:00", "to": "02:00"}]}), "differ"),
    ] {
        let schedule: Schedule = serde_json::from_value(bad.clone()).unwrap();
        let error = format!("{:#}", schedule.check().unwrap_err());
        assert!(error.contains(said), "{bad}: {error}");
    }
    assert!(serde_json::from_value::<Schedule>(json!({"timeZone": "Asia/Somewhere", "slots": []})).is_err(), "UTC or local only");
}

fn agent(id: &str) -> crate::model::AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":id, "name":id, "cwd":"/tmp", "model":"", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

#[test]
fn spend_is_counted_once_per_entry_only_for_executors_on_a_routing_key() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    for id in ["on-key", "on-login", "on-home"] {
        ws.store.insert(&agent(id)).unwrap();
    }
    ws.store.set_runtime_profile("on-key", Some(&RuntimeProfile::ApiKey { key_id: "deepseek".into() })).unwrap();
    ws.store.set_runtime_profile("on-home", Some(&RuntimeProfile::CodexHome { id: "work".into() })).unwrap();
    let day = NaiveDate::from_ymd_opt(2026, 11, 8).unwrap();
    assert!(ws.store.record_spend("on-key", "opencode:msg_1", 0.25, "opencode", day).unwrap());
    assert!(!ws.store.record_spend("on-key", "opencode:msg_1", 0.25, "opencode", day).unwrap(), "the same entry again counts nothing");
    assert!(ws.store.record_spend("on-key", "opencode:msg_2", 0.5, "opencode", day).unwrap());
    assert!(!ws.store.record_spend("on-login", "claude:r1", 9.0, "claude", day).unwrap(), "a host login spends no key");
    assert!(!ws.store.record_spend("on-home", "claude:r2", 9.0, "claude", day).unwrap(), "nor a Codex home");
    let spend = ws.store.spend_on(day).unwrap();
    assert_eq!((spend.total_usd, spend.by_key.get("deepseek").copied()), (0.75, Some(0.75)));
    let empty = ws.store.spend_on(day.succ_opt().unwrap()).unwrap().total_usd;
    assert!(empty == 0.0 && empty.is_sign_positive(), "each day on its own, and nothing is 0, not -0: {empty}");
    // Days older than 40 are dropped when a newer one is counted.
    let later = day + Duration::days(41);
    assert!(ws.store.record_spend("on-key", "opencode:msg_3", 0.1, "opencode", later).unwrap());
    assert!(!ws.store.spend_counted("on-key", "opencode:msg_1").unwrap());
    // Taking the profile away keeps what was spent.
    ws.store.set_runtime_profile("on-key", None).unwrap();
    assert_eq!(ws.store.spend_on(later).unwrap().total_usd, 0.1);
}

/// Claude Code's `total_cost_usd` is the running total of its session (#798 R1 P2).
#[test]
fn a_running_total_counts_its_increase_once_across_a_restart_and_a_lower_one_counts_from_zero() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let day = NaiveDate::from_ymd_opt(2026, 11, 8).unwrap();
    {
        let store = Store::open(&path).unwrap();
        store.insert(&agent("on-key")).unwrap();
        store.insert(&agent("on-login")).unwrap();
        store.set_runtime_profile("on-key", Some(&RuntimeProfile::ApiKey { key_id: "anthropic".into() })).unwrap();
        assert_eq!(store.record_running_spend("on-key", "claude:r1", 0.25, "claude", day).unwrap(), Some(0.25), "the first total counts whole");
        assert_eq!(store.record_running_spend("on-key", "claude:r2", 0.5, "claude", day).unwrap(), Some(0.25), "then only its increase");
        assert_eq!(store.record_running_spend("on-key", "claude:r2", 0.5, "claude", day).unwrap(), None, "the same entry again counts nothing");
        assert_eq!(store.record_running_spend("on-login", "claude:r9", 9.0, "claude", day).unwrap(), None, "a host login spends no key");
    }
    // After a restart the session is resumed: its first total already holds the earlier turns.
    let store = Store::open(&path).unwrap();
    assert_eq!(store.record_running_spend("on-key", "claude:r3", 0.75, "claude", day).unwrap(), Some(0.25));
    // A total below the last (a /clear, or a new session) counts from zero.
    assert_eq!(store.record_running_spend("on-key", "claude:r4", 0.125, "claude", day).unwrap(), Some(0.125));
    assert_eq!(store.spend_on(day).unwrap().by_key.get("anthropic").copied(), Some(0.875));
}

#[test]
fn only_a_finished_answers_plausible_cost_is_read() {
    let info = |extra: Value| {
        let mut v = json!({"id": "msg_a", "role": "assistant", "time": {"created": 1, "completed": 2}, "cost": 0.0123});
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    };
    assert_eq!(opencode_spend(&info(json!({}))), Some(("opencode:msg_a".into(), 0.0123)));
    for extra in [json!({"role": "user"}), json!({"time": {"created": 1}}), json!({"cost": 0}), json!({"cost": -1}),
        json!({"cost": "0.5"}), json!({"cost": 1e9})] {
        assert_eq!(opencode_spend(&info(extra.clone())), None, "{extra}");
    }
    let result = json!({"type": "result", "uuid": "r-1", "total_cost_usd": 0.4});
    assert_eq!(claude_spend(&result, Some("t")), Some(("claude:r-1".into(), 0.4)));
    assert_eq!(claude_spend(&json!({"type": "result", "total_cost_usd": 0.4}), Some("t")), Some(("claude:t".into(), 0.4)));
    assert_eq!(claude_spend(&json!({"type": "result", "uuid": "r-2"}), None), None, "no cost, nothing counted");
}

#[tokio::test]
async fn the_readings_route_is_the_users_own_browsers_only_and_shows_spend_and_schedules() {
    use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}};
    use tower::ServiceExt;
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), "/tmp".into(), "unused-codex".into()).unwrap();
    ws.store.insert(&agent("on-key")).unwrap();
    ws.store.set_runtime_profile("on-key", Some(&RuntimeProfile::ApiKey { key_id: "deepseek".into() })).unwrap();
    ws.store.record_spend("on-key", "opencode:msg_1", 0.3, "opencode", today()).unwrap();
    let local = crate::server::router(ws.clone(), tmp.path().join("assets"));
    let remote = crate::server::remote_router(ws.clone(), tmp.path().join("assets"), None,
        crate::server::RemoteEntry::new("https://core.example-tailnet.ts.net:8444", "person@example.com").unwrap());
    let call = |app: axum::Router, extra: Vec<(&'static str, String)>| {
        let mut builder = Request::builder().method("GET").uri("/api/routing/readings").header("x-yuzuno-client", "desktop");
        builder = if extra.iter().any(|(n, _)| *n == "tailscale-user-login") { builder } else { builder.header("host", "127.0.0.1:4317") };
        for (name, value) in extra {
            builder = builder.header(name, value);
        }
        async move {
            let response = app.oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
            let status = response.status();
            (status, String::from_utf8_lossy(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).into_owned())
        }
    };
    let (status, body) = call(local.clone(), vec![]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let read: Value = serde_json::from_str(&body).unwrap();
    assert_eq!((read["spend"]["totalUsd"].clone(), read["spend"]["byKey"]["deepseek"].clone()), (json!(0.3), json!(0.3)));
    assert_eq!((read["spend"]["day"].clone(), read["spend"]["zone"].clone(), read["staleAfterSeconds"].clone()),
        (json!(today().to_string()), json!("local"), json!(600)));
    assert_eq!(read["spend"]["resetsAt"], json!(day_ends(today()).unwrap().to_rfc3339()), "the next local midnight");
    assert!(read["presets"]["deepseek-peak"]["inside"].is_boolean() && read["presets"]["deepseek-peak"]["schedule"]["timeZone"] == "UTC", "{read}");
    let (status, _) = call(local.clone(), vec![("authorization", "Bearer an-agents-token".into())]).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "an Agent's credential is refused");
    let (status, body) = call(remote, vec![("host", "core.example-tailnet.ts.net:8444".into()),
        ("tailscale-user-login", "person@example.com".into()), ("origin", "https://core.example-tailnet.ts.net:8444".into())]).await;
    assert!(!body.contains("totalUsd"), "not on the phone entry: {status} {body}");
}
