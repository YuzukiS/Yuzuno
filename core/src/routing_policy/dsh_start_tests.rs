//! YN-119 S3: an executor routing gives dsh, dispatched, started from the slot queue and
//! running its first Turn, the task's own mail, on the stand-in dsh (tests/fixtures/dsh_acp.py,
//! S1) with a stand-in model address: its DeepSeek key, its level and its effort reach that
//! one dsh, and Core refuses what goes past its sandbox at Auto-approve. Synthetic values only;
//! no model is asked anything.
use crate::{model::AgentDetail, routing_keys::{Provider, Secret, Store as KeyStore}, workspace::Workspace};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/dsh_acp.py");
const KEY: &str = "sk-yuzuno-test-placeholder-yn158";

struct Lab {
    _dir: tempfile::TempDir,
    root: PathBuf,
    ws: Arc<Workspace>,
}

impl Lab {
    /// A Project ("Lab", its folder on this host) with a lead that is never started, the
    /// template "auto" (follows routing, at Auto-approve), a DeepSeek key, and routing on
    /// with one candidate: dsh on that key, its strong model at effort high.
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let folder = root.join("project");
        std::fs::create_dir_all(&folder).unwrap();
        // A link to the stand-in, as dsh_tests.rs links it (no ETXTBSY).
        let program = root.join("dsh");
        std::os::unix::fs::symlink(FIXTURE, &program).unwrap();
        let ws = Workspace::new(root.join("data"), root.to_string_lossy().into(), "unused-codex".into()).unwrap();
        *ws.dsh_test.lock().unwrap() = Some((program, Some("http://127.0.0.1:9/v1".into())));
        // As a started Core has it, for its mail (nothing listens there: S2a's dsh is given no MCP).
        ws.collaboration_url.set("http://127.0.0.1:4999".into()).unwrap();
        KeyStore::of(&ws.data_dir).put_local("deepseek", Provider::Deepseek, Secret::new(KEY.into())).unwrap();
        let project = ws.store.create_project("Lab", BTreeMap::from([("local".into(), folder.to_string_lossy().into_owned())])).unwrap().id;
        let lead: AgentDetail = serde_json::from_value(json!({"agent":{"id":"lead","name":"Lead","cwd":"/synthetic/work","model":"",
            "harness":"claude","color":"sage","status":"offline","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,
            "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&lead).unwrap();
        ws.store.set_agent_project("lead", Some(&project)).unwrap();
        crate::agent_roles::save(&ws.store, &project, 0, vec!["lead".into()]).unwrap();
        ws.store.db.write().unwrap().execute("INSERT INTO workspace_meta(key,value) VALUES('executors.templates',?1)",
            [json!({"version": 1, "templates": [{"id": "auto", "label": "Auto", "permissionLevel": "auto"}]}).to_string()]).unwrap();
        ws.store.save_routing_policy(0, json!({"enabled": true, "whenNone": "wait", "candidates": [
            {"id": "c-dsh", "enabled": true, "harness": "dsh", "model": "deepseek-v4-pro", "reasoningEffort": "high", "tiers": ["strong"],
             "credential": {"kind": "apiKey", "keyId": "deepseek"}, "conditions": []}]})).unwrap().unwrap();
        Lab { _dir: dir, root, ws }
    }

    /// What the stand-in logged for executor `id`.
    fn log(&self, id: &str) -> Vec<Value> {
        let text = std::fs::read_to_string(self.root.join("data/dsh").join(id).join("home/fixture-log.jsonl")).unwrap_or_default();
        text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    /// Executor `id`'s record once `check` holds, within 30 s.
    async fn until(&self, id: &str, what: &str, check: impl Fn(&AgentDetail) -> bool) -> AgentDetail {
        for _ in 0..1500 {
            let d = self.ws.store.detail(id).unwrap();
            if check(&d) {
                return d;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("{what} within 30 s: {:#}", serde_json::to_value(self.ws.store.detail(id).unwrap()).unwrap());
    }
}

fn sha256(text: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
async fn a_routed_dsh_executor_starts_from_the_queue_on_its_key_and_level_and_runs_its_tasks_mail() {
    let lab = Lab::new();
    let project = lab.ws.store.projects().unwrap()[0].id.clone();
    let task = lab.ws.collaboration_call(None, "task_create", json!({"requestId": "create", "title": "Write the parser", "projectId": project}))
        .await.unwrap()["task"]["id"].as_str().unwrap().to_owned();
    let dispatched = lab.ws.collaboration_call(Some("lead"), "task_dispatch", json!({"requestId": "dispatch", "taskId": task, "expectedVersion": 1,
        "executor": {"templateId": "auto", "tier": "strong"}})).await.unwrap();
    let id = dispatched["agentId"].as_str().unwrap().to_owned();

    // Routed as dsh, on its key, at Auto-approve, kept for each start to read.
    assert_eq!(lab.ws.store.routing_route(&id).unwrap().unwrap()["chosen"], "c-dsh");
    assert_eq!(lab.ws.store.runtime_profile(&id).unwrap(), Some(crate::routing_launch::RuntimeProfile::ApiKey { key_id: "deepseek".into() }));
    assert_eq!(lab.ws.store.permission_level(&id).unwrap().as_deref(), Some("auto"));

    // Its slot starts it; the task's mail, delivered to it idle as Core's mail loop
    // delivers it, is its first Turn, which the stand-in answers.
    lab.until(&id, "its slot starts it", |d| d.agent.connection_state == "connected" && d.agent.status == "idle").await;
    let batch = lab.ws.store.pending_peer_deliveries().unwrap().into_iter().find(|b| b["agentId"] == id.as_str())
        .unwrap_or_else(|| panic!("the task's mail waits for it: {:#?}", lab.ws.store.pending_peer_deliveries().unwrap()));
    lab.ws.deliver_peer_batch(&batch).await.unwrap();
    let started = lab.until(&id, "its first Turn ends", |d| d.turns.iter().any(|t| t["status"] == "completed")).await;
    assert_eq!((started.agent.harness.as_str(), started.agent.model.as_str()), ("dsh", "deepseek-v4-pro"));
    assert_eq!((started.agent.settings.permission_level.as_deref(), started.agent.settings.reasoning_effort.as_deref()), (Some("auto"), Some("high")));
    assert!(started.agent.remote.is_none(), "on this Core host");
    let turn = started.turns.iter().find(|t| t["status"] == "completed").unwrap();
    let replies: Vec<&str> = turn["items"].as_array().unwrap().iter().filter(|i| i["type"] == "agentMessage").filter_map(|i| i["text"].as_str()).collect();
    assert!(replies.iter().any(|text| text.starts_with("reply: ") && text.contains("mailbox delivery")), "the stand-in answered the task's mail: {turn:#}");

    let log = lab.log(&id);
    let runs: Vec<&Value> = log.iter().filter(|r| r["kind"] == "start" && r["argv"].as_array().is_some_and(|a| a.len() == 4)).collect();
    assert_eq!(runs.len(), 1, "one dsh for it: {log:#?}");
    assert_eq!(runs[0]["env"]["DSH_PERMISSION_MODE"], "workspace-write", "Auto-approve is dsh's sandbox");
    assert_eq!(runs[0]["keySha256"], sha256(KEY), "its routing key, as DEEPSEEK_API_KEY of its own dsh");
    let set: Vec<(String, String)> = log.iter().filter(|r| r["kind"] == "set")
        .map(|r| (r["configId"].as_str().unwrap().into(), r["value"].as_str().unwrap().into())).collect();
    assert_eq!(set, [("model".into(), "[\"deepseek-official\",\"deepseek-v4-pro\"]".into()), ("reasoning_effort".into(), "high".into())]);

    // Past its sandbox at Auto-approve: refused by Core, asking no one (YN-119 §3.6).
    let receipt = lab.ws.send_message(&id, serde_json::from_value(json!({"clientMessageId": "c-ask", "text": "ASK"})).unwrap()).await.unwrap();
    assert_eq!(receipt.status, "accepted");
    let after = lab.until(&id, "the ASK Turn ends", |d| d.turns.iter().filter(|t| t["status"] == "completed").count() == 2).await;
    assert!(after.pending.is_empty(), "no request waits for anyone");
    let asked = after.turns.iter().rev().find(|t| t["status"] == "completed").unwrap();
    let text = asked["items"].as_array().unwrap().iter().filter(|i| i["type"] == "agentMessage").filter_map(|i| i["text"].as_str()).collect::<String>();
    assert!(text.contains("reject"), "the stand-in quotes Core's answer, a refusal: {asked:#}");
    lab.ws.close_agent(&id).await.unwrap();
}
