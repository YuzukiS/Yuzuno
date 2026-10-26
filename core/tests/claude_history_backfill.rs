//! T-22: reconnecting to a Claude session fills in what Claude saved while
//! Core was not reading it. Core runs the real bridge
//! (runtimes/claude/bridge.mjs) over a scripted SDK that saves its session
//! (tests/fixtures/claude_history_bridge.mjs): a turn cut off mid-reply when
//! the process ends, then a turn the user sent from a terminal resuming the
//! same session, with a denied tool call and meta, system and local-command
//! entries. No model is called.
#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use serde_json::{json, Value};
use std::io::Write;
use std::time::Duration;
use yuzuno_workspace::{model::AgentDetail, workspace::Workspace};

async fn until(ws: &Workspace, id: &str, what: &str, done: impl Fn(&AgentDetail) -> bool) -> AgentDetail {
    for _ in 0..600 {
        let d = ws.store.detail(id).unwrap();
        if done(&d) {
            return d;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let d = ws.store.detail(id).unwrap();
    panic!("timed out waiting for {what}: status {} turns {:#?}", d.agent.status, d.turns);
}

fn turn<'a>(d: &'a AgentDetail, id: &str) -> &'a Value {
    d.turns.iter().find(|t| t["id"] == id).unwrap_or_else(|| panic!("no turn {id}: {:#?}", d.turns))
}

fn ids(turn: &Value) -> Vec<String> {
    turn["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_owned()).collect()
}

/// The latest conversation window as the web reads it (T81: from the held
/// record, else saved rows through the window cache), by turn: its items' ids.
fn window(ws: &Workspace, id: &str) -> (Vec<(String, Vec<String>)>, &'static str) {
    let query = yuzuno_workspace::conversation_window::Query { view: Some("window".into()), ..Default::default() };
    let read = ws.store.client_window(id, &query).unwrap().unwrap();
    (read.detail.turns.iter().map(|t| (t["id"].as_str().unwrap().to_owned(), ids(t))).collect(), read.stats.source)
}

const SESSION: &str = "5e55a0ee-0000-4000-8000-000000000022";
const TERMINAL: &str = "7e2a1a11-0000-4000-8000-000000000001";

#[tokio::test]
async fn reconnecting_fills_in_what_claude_saved_once_and_keeps_every_source_its_own() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let history = dir.path().join("session.jsonl");
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude_history_bridge.mjs"));
    std::env::set_var("YUZUNO_TEST_CLAUDE_HISTORY", &history);
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let agent = ws.claude_create("C".into(), String::new(), dir.path().to_string_lossy().into(), "m".into(), None).await.unwrap();
    let id = agent.id.as_str();
    let d = until(&ws, id, "the bridge", |d| d.agent.connection_state == "connected").await;
    // What the real bridge reported starting with (T-87): the fixture's CLI
    // and its probed version, the pinned SDK and the CLI that SDK ships (as
    // the fixture states them: no SDK is installed for Core's tests), and the
    // bridge's own check of the two.
    let provenance = json!({"cli":{"path":"/fixture/claude","version":"2.1.280","versionSource":"--version"},
        "sdk":{"version":"0.3.296","builtInCli":"2.1.296"},"compatibility":"verified"});
    assert_eq!(d.claude_runtime.and_then(|r| r.provenance), Some(provenance.clone()));

    let first = ws.claude_send(id, "first".into()).await.unwrap()["turnId"].as_str().unwrap().to_owned();
    until(&ws, id, "the first reply", |d| d.turns.iter().any(|t| t["id"] == first.as_str() && t["status"] == "completed")).await;
    // Claude saves what it does after Core stopped reading: the call's result and the reply.
    let cut = ws.claude_send(id, "cut".into()).await.unwrap()["turnId"].as_str().unwrap().to_owned();
    let d = until(&ws, id, "the cut turn", |d| d.agent.connection_state == "disconnected"
        && d.turns.iter().any(|t| t["id"] == cut.as_str() && t["status"] == "outcomeUnknown")).await;
    assert_eq!(d.agent.claude_session_id.as_deref(), Some(SESSION));
    assert_eq!(ids(turn(&d, &cut)), [format!("{cut}:input"), format!("tool-{cut}")], "Core saw only the call");
    let (before, source) = window(&ws, id);
    println!("window before reconnecting read from {source}");
    assert_eq!(before.last().unwrap().1, [format!("{cut}:input"), format!("tool-{cut}")]);

    // The user goes on in a terminal (`claude --resume`): Claude saves that turn too.
    let mut file = std::fs::OpenOptions::new().append(true).open(&history).unwrap();
    let saved = |m: Value| json!({"session_id":SESSION,"parent_tool_use_id":null,"parent_agent_id":null,"timestamp":"2026-10-17T01:00:00Z"}).as_object().unwrap()
        .clone().into_iter().chain(m.as_object().unwrap().clone()).collect::<serde_json::Map<_, _>>();
    for entry in [
        json!({"type":"user","uuid":TERMINAL,"message":{"role":"user","content":"From the terminal: run ls"}}),
        json!({"type":"user","uuid":"meta-1","is_meta":true,"message":{"role":"user","content":"<system-reminder>context</system-reminder>"}}),
        json!({"type":"assistant","uuid":"t-call","message":{"id":"msg-t-call","role":"assistant","stop_reason":"tool_use",
            "content":[{"type":"tool_use","id":"tool-terminal","name":"Bash","input":{"command":"ls"}}]}}),
        json!({"type":"user","uuid":"t-denied","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-terminal",
            "content":"Permission to use Bash has been denied.","is_error":true}]}}),
        json!({"type":"assistant","uuid":"t-reply","message":{"id":"msg-t-reply","role":"assistant","stop_reason":"end_turn",
            "content":[{"type":"text","text":"I was not allowed to run it."}]}}),
        json!({"type":"system","uuid":"t-stop"}),
        json!({"type":"user","uuid":"local-1","isCompletedLocalCommand":true,"message":{"role":"user","content":"<command-name>/cost</command-name>"}}),
    ] {
        writeln!(file, "{}", Value::Object(saved(entry))).unwrap();
    }
    drop(file);

    let d = ws.claude_reconnect(id).await.unwrap();
    assert_eq!(d.agent.connection_state, "connected");
    // The terminal's turn below ended before the reconnect: nothing runs, so
    // the Agent is idle and mail can start a Turn (T-184).
    assert_eq!(d.agent.status, "idle");
    assert_eq!(d.claude_runtime.as_ref().and_then(|r| r.provenance.clone()), Some(provenance.clone()));
    assert_eq!(d.turns.iter().map(|t| t["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>(),
        vec![first.clone(), cut.clone(), format!("native-{TERMINAL}")]);
    // The cut turn: what Claude saved, once; still unknown, saying so.
    let t = turn(&d, &cut);
    assert_eq!(ids(t), [format!("{cut}:input"), format!("tool-{cut}"), format!("msg-reply-{cut}")]);
    let call = &t["items"][1];
    assert_eq!((call["status"].as_str(), call["output"].as_str()), (Some("completed"), Some("a.txt")));
    assert_eq!(t["items"][2]["text"], "The file is a.txt.");
    assert_eq!(t["status"], "outcomeUnknown");
    assert!(t["error"]["message"].as_str().unwrap().contains("已补回"));
    // The terminal's turn: its own, shown as sent outside Yuzuno.
    let t = turn(&d, &format!("native-{TERMINAL}"));
    assert_eq!((t["_yuzunoSource"].as_str(), t["_yuzunoOrigin"].as_str(), t["status"].as_str()), (Some("native"), Some("outside"), Some("completed")));
    assert_eq!(ids(t), [format!("native-{TERMINAL}:input"), "tool-terminal".into(), "msg-t-reply".into()]);
    assert_eq!(t["items"][0]["content"], json!([{"type":"text","text":"From the terminal: run ls"}]));
    let denied = &t["items"][1];
    assert_eq!((denied["status"].as_str(), denied["output"].as_str()), (Some("failed"), Some("Permission to use Bash has been denied.")));
    // Only real prompts are user messages: never a tool result, meta, system or local command.
    let prompts: Vec<_> = d.turns.iter().flat_map(|t| t["items"].as_array().unwrap().iter()).filter(|i| i["type"] == "userMessage").collect();
    assert_eq!(prompts.len(), 3);
    assert_eq!(turn(&d, &first)["items"].as_array().unwrap().len(), 2, "the first turn is untouched");
    // The conversation window shows it too (its index cache is not stale).
    let (filled, source) = window(&ws, id);
    println!("window after filling in read from {source}");
    assert_eq!(filled, vec![
        (first.clone(), vec![format!("{first}:input"), format!("msg-reply-{first}")]),
        (cut.clone(), vec![format!("{cut}:input"), format!("tool-{cut}"), format!("msg-reply-{cut}")]),
        (format!("native-{TERMINAL}"), vec![format!("native-{TERMINAL}:input"), "tool-terminal".into(), "msg-t-reply".into()]),
    ]);

    // Reconnecting again adds nothing, to the record or its window.
    let before = serde_json::to_value(&d.turns).unwrap();
    std::fs::write(format!("{}.exit", history.display()), "").unwrap();
    until(&ws, id, "the bridge to end", |d| d.agent.connection_state == "disconnected").await;
    let d = ws.claude_reconnect(id).await.unwrap();
    assert_eq!(serde_json::to_value(&d.turns).unwrap(), before);
    let (again, source) = window(&ws, id);
    println!("window after reconnecting again read from {source}");
    assert_eq!(again, filled);
    // And the session is still Yuzuno's: the next prompt is its own turn.
    let next = ws.claude_send(id, "next".into()).await.unwrap()["turnId"].as_str().unwrap().to_owned();
    let d = until(&ws, id, "the next reply", |d| d.turns.iter().any(|t| t["id"] == next.as_str() && t["status"] == "completed")).await;
    assert_eq!(d.turns.len(), 4);
    ws.close_agent(id).await.unwrap();
}
