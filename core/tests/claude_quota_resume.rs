//! T-94: automatic continue after a Claude usage limit resets. Core runs the
//! real bridge over a scripted SDK that runs into the limit on request
//! (tests/fixtures/claude_quota_bridge.mjs). Off by default; when an Agent
//! turns it on, a turn the limit stopped is continued once, after the reset,
//! with one fixed message and nothing replayed; new input, turning it off or
//! cancelling stop it; other failures and a limit without a reset arm
//! nothing; Agents of one account go one after another; a "Continue now"
//! that Claude refuses before the reset leaves the automatic continue
//! waiting. No model is called.
#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use serde_json::Value;
use std::time::Duration;
use yuzuno_workspace::{claude_quota, model::AgentDetail, workspace::Workspace};

async fn until(ws: &Workspace, id: &str, what: &str, done: impl Fn(&AgentDetail) -> bool) -> AgentDetail {
    for _ in 0..800 {
        let d = ws.store.detail(id).unwrap();
        if done(&d) {
            return d;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let d = ws.store.detail(id).unwrap();
    panic!("timed out waiting for {what}: status {} turns {:#?}", d.agent.status, d.turns);
}

fn prompts(path: &std::path::Path, session: &str) -> Vec<String> {
    std::fs::read_to_string(path).unwrap_or_default().lines().map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|l| l["session"] == session).map(|l| l["text"].as_str().unwrap().to_owned()).collect()
}

async fn agent(ws: &std::sync::Arc<Workspace>, cwd: &str) -> String {
    let id = ws.claude_create("C".into(), String::new(), cwd.into(), "m".into(), None).await.unwrap().id;
    until(ws, &id, "the bridge", |d| d.agent.connection_state == "connected").await;
    id
}

/// Sends `text` and waits for its turn to end.
async fn send(ws: &std::sync::Arc<Workspace>, id: &str, text: &str) -> AgentDetail {
    let turn = ws.claude_send(id, text.into()).await.unwrap()["turnId"].as_str().unwrap().to_owned();
    until(ws, id, text, |d| d.turns.iter().any(|t| t["id"] == turn.as_str() && t["status"] != "inProgress")).await
}

async fn view(ws: &std::sync::Arc<Workspace>, id: &str) -> Value {
    serde_json::to_value(ws.claude_auto_continue(id).await.unwrap()).unwrap()
}

/// A reset whose continue is due 8 seconds from now (reset plus grace).
fn soon() -> i64 {
    chrono::Utc::now().timestamp() - claude_quota::GRACE_SECS + 8
}

/// The newest intent once it is in `state`.
async fn intent(ws: &std::sync::Arc<Workspace>, id: &str, state: &str) -> Value {
    for _ in 0..1200 {
        let v = view(ws, id).await;
        if v["intent"]["state"] == state {
            return v["intent"].clone();
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("no {state} intent: {:#}", view(ws, id).await);
}

#[tokio::test]
async fn a_turn_the_usage_limit_stopped_continues_once_after_the_reset_and_only_when_asked() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let log = dir.path().join("prompts.jsonl");
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude_quota_bridge.mjs"));
    std::env::set_var("YUZUNO_TEST_CLAUDE_PROMPTS", &log);
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let cwd = dir.path().to_string_lossy().into_owned();
    let later = chrono::Utc::now().timestamp() + 3600;

    // Off by default: the limit stops the turn and nothing is armed.
    let a = agent(&ws, &cwd).await;
    let soon_a = soon();
    let d = send(&ws, &a, &format!("limit {soon_a}")).await;
    assert_eq!((d.turns.last().unwrap()["status"].as_str(), d.agent.status.as_str()), (Some("failed"), "error"));
    let v = view(&ws, &a).await;
    assert_eq!((v["enabled"].clone(), v["intent"].clone(), v["stopped"]["resetsAt"].as_i64()), (false.into(), Value::Null, Some(soon_a)),
        "the stop is shown, nothing waits");

    // Turned on for this Agent: the stop is armed, waits, then one fixed message goes.
    ws.set_claude_auto_continue(Some(&a), Some(true)).await.unwrap();
    let waiting = intent(&ws, &a, "waiting").await;
    assert_eq!((waiting["resetsAt"].as_i64(), waiting["dueAt"].as_i64(), waiting["attempt"].as_i64()),
        (Some(soon_a), Some(claude_quota::due_at(soon_a, 0)), Some(1)));
    let session = ws.store.detail(&a).unwrap().agent.claude_session_id.unwrap();
    let sent = intent(&ws, &a, "sent").await;
    let d = until(&ws, &a, "the continuation", |d| d.turns.last().is_some_and(|t| t["status"] == "completed")).await;
    assert_eq!(prompts(&log, &session), [format!("limit {soon_a}"), claude_quota::CONTINUE_TEXT.to_owned()],
        "the stopped prompt is never sent again");
    assert_eq!(d.agent.claude_session_id.as_deref(), Some(session.as_str()), "the same session");
    assert_eq!(sent["sentTurn"], d.turns.last().unwrap()["id"]);
    // A second timer, or a Core restart, sends nothing more.
    ws.fire_claude_quota_resume(sent["id"].as_str().unwrap(), false).await.unwrap();
    ws.start_claude_quota_resume();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(prompts(&log, &session).len(), 2);

    // The continuation stopped again: one more attempt, for Claude's later reset.
    let d = send(&ws, &a, &format!("limit {later}")).await;
    assert_eq!(d.turns.last().unwrap()["status"], "failed");
    let again = intent(&ws, &a, "waiting").await;
    assert_eq!((again["attempt"].as_i64(), again["resetsAt"].as_i64()), (Some(1), Some(later)),
        "a new stop the user sent is a first attempt");
    // The user chose not to: cancelled, and the stop stays shown.
    ws.cancel_claude_quota_resume(&a, again["id"].as_str().unwrap(), "You chose not to continue automatically").await.unwrap();
    let v = view(&ws, &a).await;
    assert_eq!((v["intent"]["state"].as_str(), v["stopped"]["resetsAt"].as_i64()), (Some("cancelled"), Some(later)));

    // New input before the reset: cancelled when due, nothing sent.
    let b = agent(&ws, &cwd).await;
    ws.set_claude_auto_continue(Some(&b), Some(true)).await.unwrap();
    let soon_b = soon();
    send(&ws, &b, &format!("limit {soon_b}")).await;
    let waiting = intent(&ws, &b, "waiting").await;
    send(&ws, &b, "never mind, do this instead").await;
    let cancelled = view(&ws, &b).await;
    assert_eq!(cancelled["intent"], Value::Null, "the newer turn is not the stopped one: nothing is shown waiting");
    // Past its due time: nothing was sent.
    tokio::time::sleep(Duration::from_secs((claude_quota::due_at(soon_b, 0) - chrono::Utc::now().timestamp()).max(0) as u64 + 2)).await;
    let i = ws.store.quota_resume(waiting["id"].as_str().unwrap()).unwrap().unwrap();
    assert_eq!((i.state.as_str(), i.reason.as_deref()), ("cancelled", Some("Something newer was sent to the agent")));
    let b_session = ws.store.detail(&b).unwrap().agent.claude_session_id.unwrap();
    assert_eq!(prompts(&log, &b_session), [format!("limit {soon_b}"), "never mind, do this instead".to_owned()]);

    // Turning it off cancels what waits; other failures and a limit without
    // a reset arm nothing.
    let c = agent(&ws, &cwd).await;
    ws.set_claude_auto_continue(Some(&c), Some(true)).await.unwrap();
    send(&ws, &c, &format!("limit {later}")).await;
    intent(&ws, &c, "waiting").await;
    ws.set_claude_auto_continue(Some(&c), Some(false)).await.unwrap();
    assert_eq!(view(&ws, &c).await["intent"]["reason"], "Automatic continue was turned off");
    ws.set_claude_auto_continue(Some(&c), Some(true)).await.unwrap();
    send(&ws, &c, "fail").await;
    send(&ws, &c, "limit").await;
    let v = view(&ws, &c).await;
    assert_eq!((v["stopped"].clone(), v["intent"].clone()), (Value::Null, Value::Null), "not a usage limit with a reset: nothing armed");

    // The workspace default, overridden per Agent; one account's Agents are staggered.
    ws.set_claude_auto_continue(None, Some(true)).await.unwrap();
    let (e, f) = (agent(&ws, &cwd).await, agent(&ws, &cwd).await);
    ws.set_claude_auto_continue(Some(&f), None).await.unwrap();
    send(&ws, &e, &format!("limit {later}")).await;
    send(&ws, &f, &format!("limit {later}")).await;
    let (ie, i_f) = (intent(&ws, &e, "waiting").await, intent(&ws, &f, "waiting").await);
    assert_eq!(i_f["dueAt"].as_i64().unwrap() - ie["dueAt"].as_i64().unwrap(), claude_quota::STAGGER_SECS);
    let g = agent(&ws, &cwd).await;
    ws.set_claude_auto_continue(Some(&g), Some(false)).await.unwrap();
    send(&ws, &g, &format!("limit {later}")).await;
    assert_eq!(view(&ws, &g).await["intent"], Value::Null, "an Agent turned off stays off under the default");
    // A stop whose reset passed long ago: turning automatic continue on later
    // (here, already on by the default) resumes nothing by itself.
    let h = agent(&ws, &cwd).await;
    let old = chrono::Utc::now().timestamp() - 3600;
    send(&ws, &h, &format!("limit {old}")).await;
    ws.set_claude_auto_continue(Some(&h), Some(true)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let v = view(&ws, &h).await;
    assert_eq!((v["intent"].clone(), v["stopped"].clone()), (Value::Null, Value::Null), "an old stop is not armed or shown");
    let h_session = ws.store.detail(&h).unwrap().agent.claude_session_id.unwrap();
    assert_eq!(prompts(&log, &h_session), [format!("limit {old}")], "nothing was sent");

    // "Continue now" before the reset, which Claude refuses with the same
    // reset: that was the user's try, so the automatic continue still stands
    // for the reset, as the same attempt.
    let k = agent(&ws, &cwd).await;
    send(&ws, &k, &format!("hold {later}")).await;
    let first = intent(&ws, &k, "waiting").await;
    let early = ws.fire_claude_quota_resume(first["id"].as_str().unwrap(), true).await.unwrap();
    assert_eq!(early.state, "sent");
    until(&ws, &k, "the early continue", |d| d.turns.last()
        .is_some_and(|t| t["id"].as_str() == early.sent_turn.as_deref() && t["status"] == "failed")).await;
    let again = intent(&ws, &k, "waiting").await;
    assert_eq!((again["turnId"].as_str(), again["resetsAt"].as_i64(), again["attempt"].as_i64()),
        (early.sent_turn.as_deref(), Some(later), Some(1)), "still continues after the reset");
    let k_session = ws.store.detail(&k).unwrap().agent.claude_session_id.unwrap();
    assert_eq!(prompts(&log, &k_session), [format!("hold {later}"), claude_quota::CONTINUE_TEXT.to_owned()]);
    for id in [a, b, c, e, f, g, h, k] {
        ws.close_agent(&id).await.unwrap();
    }
}
