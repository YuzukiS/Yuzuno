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

/// OpenCode on DeepSeek's key, which is set.
fn deepseek() -> Value {
    json!({"id": "c-deepseek", "enabled": true, "harness": "opencode", "model": "deepseek/deepseek-flash",
        "credential": {"kind": "apiKey", "keyId": "deepseek"}, "conditions": []})
}

/// Codex on the host's login, with a model (no effort: its check would read a Codex catalog).
fn codex() -> Value {
    json!({"id": "c-codex", "enabled": true, "harness": "codex", "model": "gpt-test", "credential": {"kind": "login"}, "conditions": []})
}

fn claude() -> Value {
    json!({"id": "c-claude", "enabled": true, "harness": "claude", "model": "opus", "credential": {"kind": "login"}, "conditions": []})
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

    fn routing_off(&self) {
        let mut stored = self.ws.store.routing_policy().unwrap();
        stored.policy["enabled"] = json!(false);
        self.ws.store.save_routing_policy(stored.version, stored.policy).unwrap().unwrap();
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

    fn slot_state(&self, agent: &str) -> String {
        self.ws.store.db.read().unwrap().query_row("SELECT state FROM executor_slots WHERE agent_id=?1", [agent], |r| r.get(0)).unwrap()
    }

    /// The next executor a slot pass would take.
    fn next(&self) -> Option<String> {
        self.ws.store.executor_slot_next(&std::sync::Mutex::new(HashSet::new())).unwrap()
    }

    /// The test's meeting point for the next pass routing at `at` (`route_meet`).
    fn meet(&self, at: &'static str) -> Arc<tokio::sync::Barrier> {
        let meet = Arc::new(tokio::sync::Barrier::new(2));
        *self.ws.executor_slots.route_meet.lock().unwrap() = Some((at, meet.clone()));
        meet
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

/// The Lead's rule for YN-66 (mail 10254): an executor given a candidate at its
/// start is made exactly as a dispatch choosing that candidate makes one: its Agent
/// record, its account or key, and its permission level, for each harness.
#[tokio::test]
async fn an_executor_given_another_harness_at_its_start_is_made_as_a_dispatch_choosing_that_candidate_makes_it() {
    let lab = Lab::new();
    // What differs between any two executors whatever their harness: who and when.
    let kept = |mut data: Value| {
        for field in ["id", "name", "createdAt", "updatedAt", "color", "rev", "lastSeq", "reviewedSeq"] {
            data["agent"].as_object_mut().unwrap().remove(field);
        }
        data
    };
    let mut made = Vec::new();
    for (target, stand) in [(codex(), "opencode"), (claude(), "opencode"), (deepseek(), "codex")] {
        let id = target["id"].as_str().unwrap().to_owned();
        lab.policy(vec![target.clone()]);
        let at_dispatch = lab.dispatch(&format!("At dispatch {id}"), "auto").await;
        assert_eq!(lab.route(&at_dispatch)["chosen"], json!(id));

        lab.policy(vec![stand_in(stand), off(target.clone())]);
        let at_start = lab.dispatch(&format!("At start {id}"), "auto").await;
        assert_eq!(lab.harness(&at_start), json!(stand));
        lab.policy(vec![stand_in(stand), target.clone()]);
        lab.ws.route_waiting().await;
        assert_eq!(lab.route(&at_start)["chosen"], json!(id), "{}", lab.route(&at_start));

        assert_eq!(kept(lab.data(&at_start)), kept(lab.data(&at_dispatch)), "{id}: the same Agent record");
        assert_eq!(lab.rows(&at_start), lab.rows(&at_dispatch), "{id}: the same account or key, and permission level");
        made.extend([(target["harness"].as_str().unwrap().to_owned(), at_dispatch), (target["harness"].as_str().unwrap().to_owned(), at_start)]);
    }
    // What those records are, so the comparison above compares something.
    for (harness, agent) in made {
        let data = lab.data(&agent);
        let (profile, level) = lab.rows(&agent);
        assert_eq!(data["agent"]["harness"], json!(harness));
        match harness.as_str() {
            "codex" => assert_eq!((data["agent"]["settings"]["permissionPreset"].clone(), data["agent"]["model"].clone(), level),
                (json!("auto"), json!("gpt-test"), None), "the level auto, as Codex's own"),
            "claude" => assert_eq!((data["agent"]["settings"]["permissionMode"].clone(), data["agent"]["model"].clone(), level),
                (json!("auto"), json!("opus"), None), "the level auto, as Claude Code's own"),
            _ => {
                assert_eq!((data["agent"]["model"].clone(), level.as_deref()), (json!("deepseek/deepseek-flash"), Some("auto")),
                    "OpenCode's level is its own row");
                assert!(profile.is_some_and(|p| p.contains("deepseek")), "and DeepSeek's key is its profile");
            }
        }
    }
}

/// A start that the template's request and the routed one make alike: what goes into
/// settling the record (harness, model, effort, permission) is the candidate's and the
/// level's alone, so a reasoning effort, which only a Codex catalog can check, is given
/// the same way at a dispatch and at a start.
#[test]
fn the_template_a_start_settles_with_asks_what_the_dispatchs_template_asks() {
    let candidate = json!({"id": "c-codex", "harness": "codex", "model": "gpt-test", "reasoningEffort": "high", "credential": {"kind": "login"}});
    let dispatched = Template { id: "auto".into(), label: "Auto".into(), permission_level: Some("auto".into()),
        instructions: Some("Write it.".into()), ..Template::general() };
    let at_start = Template { permission_level: Some("auto".into()), ..Template::general() };
    let asks = |t: &Template| (t.harness.clone(), t.model.clone(), t.reasoning_effort.clone(), t.permission_preset.clone(), t.permission_mode.clone());
    assert_eq!(asks(&apply(&at_start, &candidate)), asks(&apply(&dispatched, &candidate)));
    assert_eq!(asks(&apply(&at_start, &candidate)).2.as_deref(), Some("high"));
}

/// The Lead's rule for YN-66 (mail 10254), one way round: a pass that read the
/// executor as waiting, before it was released and started on its stand-in's
/// harness, changes nothing of it: it reads it again under its gate.
#[tokio::test]
async fn a_pass_that_read_an_executor_waiting_before_it_was_released_and_started_changes_nothing_of_it() {
    let lab = Lab::new();
    lab.policy(vec![stand_in("opencode"), off(codex())]);
    let agent = lab.dispatch("Write the parser", "writer").await;
    lab.policy(vec![stand_in("opencode"), codex()]);
    let meet = lab.meet("unlocked");
    let ws = lab.ws.clone();
    let first = tokio::spawn(async move { ws.route_waiting().await });
    meet.wait().await;
    // It has the list and the policy with Codex on. Meanwhile routing is turned off: it is released and taken.
    lab.routing_off();
    assert_eq!(lab.ws.store.release_routing_waiting().unwrap(), [agent.clone()]);
    assert_eq!(lab.next(), Some(agent.clone()), "taken to start, as its stand-in's harness says");
    meet.wait().await;
    first.await.unwrap();
    assert_eq!((lab.harness(&agent), lab.slot_state(&agent)), (json!("opencode"), "starting".to_owned()));
    let route = lab.route(&agent);
    assert_eq!((route["released"]["code"].clone(), route.get("changedAtStart")), (json!("routingOff"), None));
}

/// The other way round: while a pass changes its harness, under its gate, no slot
/// pass takes it, for its route still says it waits; a second pass that read it as
/// waiting meanwhile finds it routed under the gate, so what the first made of it stands.
#[tokio::test]
async fn a_start_waits_for_the_pass_changing_its_harness_and_a_second_pass_leaves_it_as_the_first_made_it() {
    let lab = Lab::new();
    lab.policy(vec![stand_in("opencode"), off(codex())]);
    let agent = lab.dispatch("Write the parser", "writer").await;
    lab.policy(vec![stand_in("opencode"), codex()]);
    let locked = lab.meet("locked");
    let ws = lab.ws.clone();
    let first = tokio::spawn(async move { ws.route_waiting().await });
    locked.wait().await;
    assert_eq!(lab.next(), None, "not taken while its harness changes");
    // A second pass, which would give it Claude Code now: it reads it as waiting, then goes for its gate.
    lab.policy(vec![stand_in("opencode"), off(codex()), claude()]);
    let unlocked = lab.meet("unlocked");
    let ws = lab.ws.clone();
    let second = tokio::spawn(async move { ws.route_waiting().await });
    unlocked.wait().await;
    unlocked.wait().await;
    locked.wait().await;
    first.await.unwrap();
    second.await.unwrap();
    assert_eq!((lab.harness(&agent), lab.route(&agent)["chosen"].clone()), (json!("codex"), json!("c-codex")), "the first pass's");
    assert_eq!(lab.next(), Some(agent), "and it starts in turn");
}
