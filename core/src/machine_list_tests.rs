use super::*;
use crate::{machines::{FolderCheck, HarnessCheck, HostFacts, MachineCheck}, model::AgentDetail, remote::MachineBudget};
use std::collections::BTreeMap;

fn agent_detail(id: &str, extra: Value) -> AgentDetail {
    let mut agent = json!({"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work","model":"","harness":"claude",
        "color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0});
    for (key, value) in extra.as_object().unwrap() {
        agent[key] = value.clone();
    }
    serde_json::from_value(json!({"agent":agent,"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

/// What Core keeps of how it reaches each machine: none of it may be listed.
const SECRETS: [&str; 8] = ["tester@192.0.2.10", "192.0.2.10", "2222", "/opt/synthetic/bin/codex", "/srv/mini/work",
    "/srv/mini/yuzuno-root", "~/.ssh/id_synthetic", "Operation timed out"];

/// Lab with a lead, a member and an executor; Other with its lead; an
/// Agent of no Project. Two machines: Mac mini (Lab has a folder there,
/// its own limit of 2, a check that failed) and Boxed (contained).
async fn fixture() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let mini = RemoteMachine {
        id: "mini".into(), name: "Mac mini".into(), target: "-p 2222 -i ~/.ssh/id_synthetic tester@192.0.2.10".into(),
        codex: "/opt/synthetic/bin/codex".into(), default_cwd: "/srv/mini/work".into(), data_root: Some("/srv/mini/yuzuno-root".into()),
        budget: Some(MachineBudget { cpu_millis: 4000, memory_mib: 8192 }), ..Default::default()
    };
    ws.store.add_machine(&mini).unwrap();
    ws.store.add_machine(&RemoteMachine { id: "boxed".into(), name: "Boxed".into(), target: "tester@192.0.2.10".into(),
        contained: true, ..Default::default() }).unwrap();
    let lab = ws.store.create_project("Lab", BTreeMap::from([("local".into(), "/synthetic/project".into()),
        ("mini".into(), "/srv/mini/work/lab".into())])).unwrap().id;
    let other = ws.store.create_project("Other", BTreeMap::new()).unwrap().id;
    for id in ["lead", "member", "exec", "outsider", "otherlead"] {
        ws.store.insert(&agent_detail(id, json!({}))).unwrap();
    }
    // Connected now on the Mac mini; one on Boxed, closed though it said connected.
    ws.store.insert(&agent_detail("on-mini", json!({"remote":{"machine":mini,"runtime":null},"connectionState":"connected"}))).unwrap();
    ws.store.insert(&agent_detail("was-boxed", json!({"remote":{"machine":{"id":"boxed","name":"Boxed","target":"x","codex":"codex","defaultCwd":"/"},"runtime":null},
        "connectionState":"connected","closedAt":"then"}))).unwrap();
    for id in ["lead", "member", "exec"] {
        ws.store.set_agent_project(id, Some(&lab)).unwrap();
    }
    ws.store.set_agent_project("otherlead", Some(&other)).unwrap();
    crate::agent_roles::save(&ws.store, &lab, 0, vec!["lead".into()]).unwrap();
    crate::agent_roles::save(&ws.store, &other, 0, vec!["otherlead".into()]).unwrap();
    {
        let db = ws.store.db.write().unwrap();
        db.execute("INSERT INTO agent_roles(agent_id, kind, project_id, created_at, updated_at) VALUES('exec','executor',?1,'now','now')", [&lab]).unwrap();
        db.execute("INSERT INTO workspace_meta(key,value) VALUES('executors.slots.machine:mini',?1)",
            [json!({"version":1,"slots":2}).to_string()]).unwrap();
        // Two executors on this Core host (one starting, one running), one waiting there and one on the Mac mini.
        for (agent, machine, state) in [("e1", "local", "starting"), ("e2", "local", "running"), ("e3", "local", "waiting"),
            ("e4", "mini", "waiting"), ("e5", "mini", "released")] {
            db.execute("INSERT INTO executor_slots(agent_id,seq,task_id,project_id,machine_id,template_id,state,since,queued_at)
                VALUES(?1,1,'t',NULL,?2,'dev',?3,'now','now')", rusqlite::params![agent, machine, state]).unwrap();
        }
    }
    let check = MachineCheck {
        machine_id: "mini".into(), started_at: "2026-11-08T01:00:00Z".into(), checked_at: "2026-11-08T01:00:10Z".into(),
        duration_ms: 10_000, reachable: false,
        error: Some("ssh: connect to host 192.0.2.10 port 2222: Operation timed out".into()),
        host: Some(HostFacts { hostname: "mini.synthetic".into(), platform: "Darwin".into(), home: "/srv/mini".into() }),
        harnesses: vec![HarnessCheck { harness: "codex".into(), supported: true, found: true,
            executable: Some("/opt/synthetic/bin/codex".into()), ..Default::default() }],
        default_folder: Some(FolderCheck { path: "/srv/mini/work".into(), resolved: None, error: None }),
    };
    ws.store.record_machine_check(&check, 1).unwrap();
    (dir, ws)
}

/// YN-37: a lead reads each machine a dispatch can name, by id and name,
/// with what it can run, its executor slots, whether an Agent there is
/// connected now and its last check, and never how Core reaches it.
#[tokio::test]
async fn a_lead_lists_the_machines_without_connection_details() {
    let (_dir, ws) = fixture().await;
    let listed = ws.collaboration_call(Some("lead"), TOOL, json!({})).await.unwrap();
    let opencode = crate::opencode_agent::enabled();
    let here: Vec<&str> = if opencode { vec!["codex", "claude", "opencode"] } else { vec!["codex", "claude"] };
    assert_eq!(listed, json!({"machines":[
        {"id":"local","name":"this Core host","kind":"local","harnesses":here,
            "executors":{"limit":3,"running":2,"waiting":1},"connected":true,"lastCheck":null,"projectFolder":true},
        {"id":"mini","name":"Mac mini","kind":"ssh","harnesses":["codex","claude"],
            "executors":{"limit":2,"running":0,"waiting":1},"connected":true,
            "lastCheck":{"checkedAt":"2026-11-08T01:00:10Z","reachable":false},"projectFolder":true},
        {"id":"boxed","name":"Boxed","kind":"ssh","harnesses":["claude"],
            "executors":{"limit":3,"running":0,"waiting":0},"connected":false,"lastCheck":null,"projectFolder":false},
    ]}));
    let text = listed.to_string();
    for secret in SECRETS.iter().chain(&["mini.synthetic", "/srv/mini", "Darwin", "budget", "target", "defaultCwd", "dataRoot"]) {
        assert!(!text.contains(secret), "{secret} is not listed: {text}");
    }

    // Another Project's lead reads its own Project's folders; the user, none.
    let other = ws.collaboration_call(Some("otherlead"), TOOL, json!({})).await.unwrap();
    assert!(other["machines"].as_array().unwrap().iter().all(|m| m["projectFolder"] == false), "{other}");
    let user = ws.collaboration_call(None, TOOL, json!({})).await.unwrap();
    assert!(user["machines"].as_array().unwrap().iter().all(|m| m.get("projectFolder").is_none()), "{user}");
    assert_eq!(user["machines"].as_array().unwrap().len(), 3);
}

/// YN-37: executors and other members are refused, and an Agent of no
/// Project; nothing else is read for them.
#[tokio::test]
async fn executors_and_other_members_are_refused() {
    let (_dir, ws) = fixture().await;
    for actor in ["exec", "member", "outsider", "on-mini"] {
        let refused = ws.collaboration_call(Some(actor), TOOL, json!({})).await.unwrap_err().to_string();
        assert!(refused.starts_with("not_lead:"), "{actor}: {refused}");
        for secret in SECRETS.iter().chain(&["Mac mini", "mini"]) {
            assert!(!refused.contains(secret), "{actor}'s refusal names nothing: {refused}");
        }
    }
    let extra = ws.collaboration_call(Some("lead"), TOOL, json!({"full":true})).await.unwrap_err().to_string();
    assert!(extra.starts_with("invalid_input:"), "{extra}");
}

/// YN-37: the tool is offered to Agents, takes nothing, and its description
/// fits what every supported client shows whole.
#[test]
fn the_tool_is_offered_and_short_enough() {
    let tool = crate::collaboration_store::tool_definitions().into_iter().find(|t| t["name"] == TOOL).expect("offered to Agents");
    assert_eq!(tool["inputSchema"]["properties"], json!({}));
    let units = tool["description"].as_str().unwrap().encode_utf16().count();
    assert!(units <= crate::results::max_description_length(), "{units}");
}

/// YN-37: the machines a refusal names for each harness, by id and name.
#[tokio::test]
async fn a_refusal_names_where_each_harness_could_run() {
    let (_dir, ws) = fixture().await;
    let db = ws.store.db.read().unwrap();
    assert_eq!(usable_for(&db, "claude").unwrap(), "local (this Core host), mini (Mac mini), boxed (Boxed)");
    assert_eq!(usable_for(&db, "codex").unwrap(), "local (this Core host), mini (Mac mini)", "no Codex where Agents are contained");
}
