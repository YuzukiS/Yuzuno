//! T-27: importing a Claude Code session saved on the Core host. Core runs
//! the real bridge (runtimes/claude/bridge.mjs) over a scripted SDK whose
//! sessions are files (tests/fixtures/claude_sessions_bridge.mjs). Listing,
//! previewing and importing start no query; one session gives one Agent,
//! however often or concurrently it is imported; and the user's first
//! message resumes that same session without sending a saved prompt again.
//! No model is called.
#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;
use yuzuno_workspace::{
    claude_sessions::{ImportSession, ListSessions},
    model::AgentDetail,
    workspace::Workspace,
};

const A: &str = "5e55a0ee-0000-4000-8000-0000000000a1";
const B: &str = "5e55a0ee-0000-4000-8000-0000000000b2";
const C: &str = "5e55a0ee-0000-4000-8000-0000000000c3";
const D: &str = "5e55a0ee-0000-4000-8000-0000000000d4";

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

fn lines(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn ids(d: &AgentDetail) -> Vec<String> {
    d.turns.iter().map(|t| t["id"].as_str().unwrap().to_owned()).collect()
}

fn saved(session: &str, entries: &[Value]) -> String {
    entries.iter().map(|m| {
        let mut m = m.clone();
        m["session_id"] = session.into();
        m["parent_tool_use_id"] = m.get("parent_tool_use_id").cloned().unwrap_or(Value::Null);
        m["timestamp"] = "2026-10-16T09:00:00Z".into();
        format!("{m}\n")
    }).collect()
}

fn import(session: &str, name: &str, project: Option<&str>, cwd: &str) -> ImportSession {
    serde_json::from_value(json!({"sessionId":session,"name":name,"projectId":project,"cwd":cwd})).unwrap()
}

#[tokio::test]
async fn a_saved_session_is_imported_once_and_goes_on_as_itself() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let store = dir.path().join("sessions");
    std::fs::create_dir(&store).unwrap();
    std::fs::create_dir(dir.path().join("app")).unwrap();
    std::fs::create_dir(dir.path().join("other")).unwrap();
    let cwd = std::fs::canonicalize(dir.path().join("app")).unwrap().to_string_lossy().into_owned();
    let other = dir.path().join("other").to_string_lossy().into_owned();
    let gone = dir.path().join("gone").to_string_lossy().into_owned();
    let at = |n: i64| 1_760_000_000_000i64 - n * 1000;
    std::fs::write(store.join("sessions.json"), json!([
        {"sessionId":A,"summary":"Fix the build","firstPrompt":"Hi","cwd":cwd,"gitBranch":"main","lastModified":at(0)},
        {"sessionId":B,"summary":"A script's session","cwd":cwd,"lastModified":at(1),"programmatic":true},
        {"sessionId":C,"summary":"Moved away","cwd":gone,"lastModified":at(2)},
        {"sessionId":D,"summary":"Imported twice at once","cwd":cwd,"lastModified":at(3)},
    ]).to_string()).unwrap();
    std::fs::write(store.join(format!("{A}.jsonl")), saved(A, &[
        json!({"type":"system","uuid":"s0"}),
        json!({"type":"user","uuid":"p1","message":{"role":"user","content":[{"type":"text","text":"Hi"},
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}}),
        json!({"type":"assistant","uuid":"a1","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"Hello."}]}}),
        json!({"type":"user","uuid":"p2","message":{"role":"user","content":"Run ls"}}),
        json!({"type":"assistant","uuid":"a2","message":{"id":"m2","role":"assistant","stop_reason":"tool_use",
            "content":[{"type":"tool_use","id":"c2","name":"Bash","input":{"command":"ls"}}]}}),
        json!({"type":"user","uuid":"r2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c2","content":"a.txt","is_error":false}]}}),
        json!({"type":"assistant","uuid":"a3","message":{"id":"m3","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"There is a.txt."}]}}),
        json!({"type":"system","uuid":"s1"}),
    ])).unwrap();
    std::fs::write(store.join(format!("{D}.jsonl")), saved(D, &[
        json!({"type":"user","uuid":"d1","message":{"role":"user","content":"Once"}}),
        json!({"type":"assistant","uuid":"d2","message":{"id":"md","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"Once."}]}}),
    ])).unwrap();
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude_sessions_bridge.mjs"));
    std::env::set_var("YUZUNO_TEST_CLAUDE_SESSIONS", &store);
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let started = || lines(&store.join("calls.jsonl")).iter().filter(|c| c["fn"] == "query").count();

    // A bounded page, newest first; sessions a person started unless asked.
    let listed = |page: &Value| page["sessions"].as_array().unwrap().iter().map(|s| s["sessionId"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    let page = ws.claude_sessions(ListSessions { limit: Some(2), ..Default::default() }).await.unwrap();
    assert_eq!((listed(&page), page["next"].clone()), (vec![A.to_owned(), C.to_owned()], json!(2)));
    assert_eq!((page["sessions"][0]["cwd"].as_str(), page["sessions"][0]["existingAgentId"].clone()), (Some(cwd.as_str()), Value::Null));
    let rest = ws.claude_sessions(ListSessions { offset: 2, limit: Some(2), ..Default::default() }).await.unwrap();
    assert_eq!((listed(&rest), rest["next"].clone()), (vec![D.to_owned()], Value::Null));
    let all = ws.claude_sessions(ListSessions { programmatic: true, ..Default::default() }).await.unwrap();
    assert_eq!(listed(&all), [A, B, C, D]);
    let here = ws.claude_sessions(ListSessions { dir: Some(gone.clone()), ..Default::default() }).await.unwrap();
    assert_eq!(listed(&here), [C], "one folder's sessions");
    assert!(ws.claude_sessions(ListSessions { dir: Some("app".into()), ..Default::default() }).await.is_err());

    // The preview: what was saved, the newest messages, honest about what is unknown.
    let preview = ws.claude_session_preview(A).await.unwrap();
    assert_eq!((preview["prompts"].as_u64(), preview["images"].as_u64(), preview["compacted"].as_bool()), (Some(2), Some(1), Some(false)));
    assert_eq!(preview["recent"].as_array().unwrap().last().unwrap()["text"], "There is a.txt.");
    assert_eq!((preview["folderExists"].as_bool(), preview["existingAgentId"].clone(), preview["occupancy"].as_str()),
        (Some(true), Value::Null, Some("unknown")));
    assert_eq!(ws.claude_session_preview(C).await.unwrap()["folderExists"], false);
    let missing = ws.claude_session_preview("00000000-0000-4000-8000-000000000000").await.unwrap_err().to_string();
    assert!(missing.contains("找不到"), "{missing}");
    assert!(ws.claude_session_preview("../a").await.is_err());

    // Refused before anything is created: another folder than the session's, a folder that is gone.
    let error = ws.claude_session_import(import(A, "Build fix", None, &other)).await.unwrap_err().to_string();
    assert!(error.contains("与确认的目录不同"), "{error}");
    let error = ws.claude_session_import(import(C, "Moved", None, &cwd)).await.unwrap_err().to_string();
    assert!(error.contains("已不存在"), "{error}");
    let error = ws.claude_session_import(import(A, " ", None, &cwd)).await.unwrap_err().to_string();
    assert!(error.contains("名称"), "{error}");
    assert!(ws.store.agents().unwrap().is_empty());

    // The import: the session's saved conversation, in the chosen Project, not connected.
    let project = ws.store.create_project("App", BTreeMap::new()).unwrap();
    let imported = ws.claude_session_import(import(A, "Build fix", Some(&project.id), &cwd)).await.unwrap();
    assert_eq!((imported.existing, imported.turns, imported.left_out, imported.compacted), (false, 2, 0, false));
    let id = imported.agent.id.clone();
    let d = ws.store.detail(&id).unwrap();
    assert_eq!((d.agent.harness.as_str(), d.agent.claude_session_id.as_deref(), d.agent.cwd.as_str()), ("claude", Some(A), cwd.as_str()));
    assert_eq!((d.agent.connection_state.as_str(), d.agent.status.as_str(), d.agent.name.as_str()), ("disconnected", "offline", "Build fix"));
    assert_eq!(ws.store.agent_project(&id).unwrap().as_deref(), Some(project.id.as_str()));
    assert_eq!(ids(&d), ["native-p1", "native-p2"]);
    assert!(d.turns.iter().all(|t| t["status"] == "completed" && t["_yuzunoOrigin"] == "outside"));
    assert_eq!(d.turns[0]["items"][0]["content"], json!([{"type":"text","text":"Hi"},{"type":"text","text":"[1 image saved by Claude, not shown]"}]));
    assert_eq!(d.turns[1]["items"][1]["output"], "a.txt");
    assert_eq!(d.agent.last_message.as_deref(), Some("There is a.txt."));
    assert_eq!(started(), 0, "listing, previewing and importing start no query");

    // Again (a retry, a double click, another name): that same Agent.
    let again = ws.claude_session_import(import(A, "Another name", None, &other)).await.unwrap();
    assert_eq!((again.existing, again.agent.id.as_str()), (true, id.as_str()));
    assert_eq!(ws.store.agents().unwrap().len(), 1);
    let page = ws.claude_sessions(ListSessions::default()).await.unwrap();
    assert_eq!(page["sessions"][0]["existingAgentId"], id.as_str());
    assert_eq!(ws.claude_session_preview(A).await.unwrap()["existingAgentId"], id.as_str());

    // Two imports of one session at once: one Agent.
    let (x, y) = tokio::join!(ws.claude_session_import(import(D, "Once", None, &cwd)), ws.claude_session_import(import(D, "Twice", None, &cwd)));
    let (x, y) = (x.unwrap(), y.unwrap());
    assert_eq!(x.agent.id, y.agent.id);
    assert_eq!([x.existing, y.existing].iter().filter(|e| !**e).count(), 1);
    assert_eq!(ws.store.agents().unwrap().len(), 2);
    assert_eq!(started(), 0);

    // The user's first message resumes the same session; nothing saved is sent again.
    let sent = ws.claude_send(&id, "Thanks".into()).await.unwrap()["turnId"].as_str().unwrap().to_owned();
    let d = until(&ws, &id, "the reply", |d| d.turns.iter().any(|t| t["id"] == sent.as_str() && t["status"] == "completed")).await;
    assert_eq!(lines(&store.join("starts.jsonl")), [json!({"resume":A,"cwd":cwd})]);
    assert_eq!(lines(&store.join("prompts.jsonl")), [json!({"session":A,"text":"Thanks"})]);
    assert_eq!(ids(&d), ["native-p1".to_owned(), "native-p2".to_owned(), sent.clone()], "the resume's backfill added nothing");
    assert_eq!(d.agent.claude_session_id.as_deref(), Some(A));
    ws.close_agent(&id).await.unwrap();
}
