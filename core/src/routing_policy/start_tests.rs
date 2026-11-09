//! A waiting executor's harness, given at its first start (YN-66), in a Workspace of
//! the test's own whose scheduler runs no pass but the test's. Synthetic values only.
use super::*;
use crate::{model::AgentDetail, routing_keys::{Provider, Secret, Store as KeyStore}, store::Store, workspace::Workspace};
use std::{collections::{BTreeMap, HashSet}, sync::Arc};

struct Lab {
    _dir: tempfile::TempDir,
    ws: Arc<Workspace>,
}

fn agent(store: &Store, id: &str, harness: &str) {
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work",
        "model":"","harness":harness,"color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&detail).unwrap();
}

/// Codex on the host's login, with a model (no effort: its check would read a Codex catalog).
fn codex() -> Value {
    json!({"id": "c-codex", "enabled": true, "harness": "codex", "model": "gpt-test", "credential": {"kind": "login"}, "conditions": []})
}

/// A stand-in that never holds: OpenCode on a key that isn't set, or Codex in a home that isn't listed.
fn stand_in(harness: &str) -> Value {
    match harness {
        "opencode" => json!({"id": "c-stand-in", "enabled": true, "harness": "opencode", "model": "deepseek/deepseek-flash",
            "credential": {"kind": "apiKey", "keyId": "unset"}, "conditions": []}),
        _ => json!({"id": "c-stand-in", "enabled": true, "harness": "codex", "model": "gpt-test",
            "credential": {"kind": "codexHome", "id": "unlisted"}, "conditions": []}),
    }
}

fn off(mut candidate: Value) -> Value {
    candidate["enabled"] = json!(false);
    candidate
}

impl Lab {
    /// A Project ("Lab", its folder on this host) with a lead ("lead", never started),
    /// the templates "writer" (follows routing) and "auto" (follows it, at the level auto).
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("project");
        std::fs::create_dir_all(&folder).unwrap();
        let folder = std::fs::canonicalize(folder).unwrap().to_string_lossy().into_owned();
        let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused-codex".into()).unwrap();
        ws.executor_slots.quiet.store(true, std::sync::atomic::Ordering::Relaxed);
        KeyStore::of(&ws.data_dir).put_local("deepseek", Provider::Deepseek, Secret::new("sk-test-yn66-start-0000".into())).unwrap();
        let project = ws.store.create_project("Lab", BTreeMap::from([("local".into(), folder)])).unwrap().id;
        agent(&ws.store, "lead", "claude");
        ws.store.set_agent_project("lead", Some(&project)).unwrap();
        crate::agent_roles::save(&ws.store, &project, 0, vec!["lead".into()]).unwrap();
        ws.store.db.write().unwrap().execute("INSERT INTO workspace_meta(key,value) VALUES('executors.templates',?1)",
            [json!({"version": 1, "templates": [{"id": "writer", "label": "Writer"},
                {"id": "auto", "label": "Auto", "permissionLevel": "auto"}]}).to_string()]).unwrap();
        Lab { _dir: dir, ws }
    }

    fn policy(&self, candidates: Vec<Value>) {
        let version = self.ws.store.routing_policy().unwrap().version;
        self.ws.store.save_routing_policy(version, json!({"enabled": true, "whenNone": "wait", "candidates": candidates})).unwrap().unwrap();
    }

    /// A new task of the Project, dispatched by the lead from `template`: its executor's id.
    async fn dispatch(&self, title: &str, template: &str) -> String {
        let project = self.ws.store.projects().unwrap()[0].id.clone();
        let task = self.ws.collaboration_call(None, "task_create", json!({"requestId": format!("create {title}"), "title": title, "projectId": project}))
            .await.unwrap()["task"]["id"].as_str().unwrap().to_owned();
        let input = json!({"requestId": format!("dispatch {title}"), "taskId": task, "expectedVersion": 1, "executor": {"templateId": template}});
        self.ws.collaboration_call(Some("lead"), "task_dispatch", input).await.unwrap()["agentId"].as_str().unwrap().to_owned()
    }

    fn data(&self, agent: &str) -> Value {
        let raw: String = self.ws.store.db.read().unwrap().query_row("SELECT data FROM agents WHERE id=?1", [agent], |r| r.get(0)).unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    fn harness(&self, agent: &str) -> Value {
        self.data(agent)["agent"]["harness"].clone()
    }

    fn route(&self, agent: &str) -> Value {
        let raw: String = self.ws.store.db.read().unwrap()
            .query_row("SELECT route_json FROM executor_dispatches WHERE agent_id=?1", [agent], |r| r.get(0)).unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    /// Its runtime profile's row and its permission level's row, as stored.
    fn rows(&self, agent: &str) -> (Option<String>, Option<String>) {
        let db = self.ws.store.db.read().unwrap();
        let profile = db.query_row("SELECT profile FROM agent_runtime_profiles WHERE agent_id=?1", [agent], |r| r.get(0)).optional().unwrap();
        let level = db.query_row("SELECT level FROM agent_permission_levels WHERE agent_id=?1", [agent], |r| r.get(0)).optional().unwrap();
        (profile, level)
    }

    /// The next executor a slot pass would take.
    fn next(&self) -> Option<String> {
        self.ws.store.executor_slot_next(&std::sync::Mutex::new(HashSet::new())).unwrap()
    }
}

/// YN-59's case: dispatched while no candidate held, it was made with the first
/// candidate's harness, OpenCode. Codex holds later: the pass gives it Codex, in
/// place, and it starts in turn.
#[tokio::test]
async fn a_waiting_executor_takes_the_first_candidate_that_holds_whatever_its_harness() {
    let lab = Lab::new();
    lab.policy(vec![stand_in("opencode"), off(codex())]);
    let agent = lab.dispatch("Write the parser", "writer").await;
    assert_eq!((lab.harness(&agent), lab.route(&agent)["waiting"].clone()), (json!("opencode"), json!(true)), "made with its stand-in's harness");
    assert_eq!(lab.next(), None, "it waits");

    lab.policy(vec![stand_in("opencode"), codex()]);
    lab.ws.route_waiting().await;
    let data = lab.data(&agent);
    assert_eq!((data["agent"]["harness"].clone(), data["agent"]["model"].clone()), (json!("codex"), json!("gpt-test")));
    let route = lab.route(&agent);
    assert_eq!((route["chosen"].clone(), route["at"].clone(), route.get("waiting").cloned()), (json!("c-codex"), json!("start"), None));
    assert_eq!(route["changedAtStart"], json!({"from": null, "reason": "It waited for a candidate, and this one holds now", "harnessFrom": "opencode"}));
    assert_eq!(lab.rows(&agent), (None, None), "the host's login, and no OpenCode level");
    assert_eq!(lab.next(), Some(agent.clone()), "it starts in turn");
}
