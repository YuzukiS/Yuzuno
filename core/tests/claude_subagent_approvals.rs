//! T-26, review 54aeb60f: a background Claude sub-agent asks for permission
//! after the turn that started it ended. Core runs the real bridge
//! (runtimes/claude/bridge.mjs) over a scripted SDK
//! (tests/fixtures/claude_subagent_bridge.mjs), so the whole path from the
//! bridge's frames to Core's record is exercised without a model.
#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use serde_json::{json, Value};
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
    panic!("timed out waiting for {what}: status {} pending {:?} turns {:#?}", d.agent.status, d.pending, d.turns);
}

fn item<'a>(d: &'a AgentDetail, id: &str) -> Vec<(&'a str, &'a Value)> {
    d.turns.iter().flat_map(|t| t["items"].as_array().into_iter().flatten().map(move |i| (t["id"].as_str().unwrap(), i)))
        .filter(|(_, i)| i["id"] == id).collect()
}

fn sub_agent(d: &AgentDetail) -> Value {
    item(d, "agent-1").first().map(|(_, i)| i["subAgent"].clone()).unwrap_or(Value::Null)
}

#[tokio::test]
async fn a_background_subagents_late_permission_leaves_no_turn_running_and_the_next_prompt_its_own() {
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude_subagent_bridge.mjs"));
    for (decision, outcome) in [("allow", "completed"), ("deny", "failed"), ("cancel", "stopped")] {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
        let agent = ws.claude_create("C".into(), String::new(), dir.path().to_string_lossy().into(), "m".into(), None).await.unwrap();
        let id = agent.id.as_str();
        until(&ws, id, "the bridge", |d| d.agent.connection_state == "connected").await;

        let first = ws.claude_send(id, format!("start-{decision}")).await.unwrap()["turnId"].as_str().unwrap().to_owned();
        // The prompt's turn ends while the sub-agent runs; its own call asks.
        let d = until(&ws, id, "the request", |d| !d.pending.is_empty()).await;
        assert_eq!(d.turns.len(), 1, "{decision}: no turn is opened for the request");
        assert_eq!((d.turns[0]["id"].as_str(), d.turns[0]["status"].as_str()), (Some(first.as_str()), Some("completed")));
        assert_eq!(d.pending[0].params["turnId"], first.as_str(), "{decision}: shown with the turn of the sub-agent's call");
        assert_eq!(d.pending[0].params["toolUseId"], "sub-make");
        assert_eq!(d.agent.status, "waiting");
        assert_eq!(sub_agent(&d)["status"], "running", "{decision}: the turn's end did not end the sub-agent");
        assert_eq!(item(&d, "sub-make").iter().map(|(t, i)| (*t, i["parentToolUseId"].clone())).collect::<Vec<_>>(),
            vec![(first.as_str(), json!("agent-1"))]);

        if decision != "cancel" {
            ws.respond(&d.pending[0].id, json!({"decision":decision})).await.unwrap();
        }
        let d = until(&ws, id, "the sub-agent's end", |d| sub_agent(d)["status"] == outcome).await;
        let d = until(&ws, id, "nothing running", |d| d.pending.is_empty() && d.agent.status == "idle").await;
        assert!(d.turns.iter().all(|t| t["status"] != "inProgress"), "{decision}: no turn left running {:#?}", d.turns);
        assert_eq!(d.turns.len(), 1);
        let call = item(&d, "sub-make");
        assert_eq!((call.len(), call[0].0, call[0].1["status"].as_str()),
            (1, first.as_str(), Some(if decision == "allow" { "completed" } else { "failed" })));

        // The next prompt is accepted, and stays its own.
        let second = ws.claude_send(id, "next".into()).await.unwrap()["turnId"].as_str().unwrap().to_owned();
        let d = until(&ws, id, "the next reply", |d| d.turns.iter().any(|t| t["id"] == second.as_str() && t["status"] == "completed")).await;
        assert_eq!(d.turns.len(), 2, "{decision}: {:#?}", d.turns);
        let next = d.turns.iter().find(|t| t["id"] == second.as_str()).unwrap();
        let texts: Vec<_> = next["items"].as_array().unwrap().iter().filter(|i| i["type"] == "agentMessage").map(|i| i["text"].clone()).collect();
        assert_eq!(texts, vec![json!("Second answer.")]);
        assert!(next["items"].as_array().unwrap().iter().all(|i| i["parentToolUseId"].is_null() && i["subAgent"].is_null()));
        for once in ["agent-1", "sub-make"] {
            assert_eq!(item(&d, once).len(), 1, "{decision}: {once} only in its own turn");
        }
        ws.close_agent(id).await.unwrap();
    }
}
