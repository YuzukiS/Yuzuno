//! A started Claude executor moved off a claude-swap account that left its pool
//! (YN-138), against stand-ins: the real bridge with a scripted SDK
//! (tests/fixtures/claude_account_bridge.mjs, loaded from a runtime folder of the
//! test's own beside a stand-in launcher) and a stub `cswap`. No claude-swap, no
//! account and no model is used. Synthetic values only.
use super::*;
use crate::{model::AgentDetail, routing_accounts};
use serde_json::json;
use std::{fs, os::unix::fs::PermissionsExt, path::{Path, PathBuf}};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude_account_bridge.mjs");
const SESSION: &str = "e0e0e0e0-0000-4000-8000-0000000000aa";
const ID: &str = "ex";

struct Restore(Option<std::ffi::OsString>);

impl Drop for Restore {
    fn drop(&mut self) {
        match &self.0 {
            Some(value) => std::env::set_var("YUZUNO_CLAUDE_BRIDGE", value),
            None => std::env::remove_var("YUZUNO_CLAUDE_BRIDGE"),
        }
    }
}

fn script(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn python3() -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).map(|dir| dir.join("python3")).find(|p| p.is_file())
}

/// Account `n`'s fingerprint: n@example.com, no organization.
fn fp(n: u32) -> String {
    routing_accounts::fingerprint(&format!("account{n}@example.com"), None)
}

struct Lab {
    ws: Arc<Workspace>,
    dir: tempfile::TempDir,
    _restore: Restore,
    _env: tokio::sync::MutexGuard<'static, ()>,
}

impl Lab {
    /// Executor "ex" on account 2 of a pool of 2 and 3, its session SESSION,
    /// routed and started; claude-swap lists 1 (the host's login), 2 and 3.
    async fn new() -> Option<Self> {
        let python = python3()?;
        let env = crate::claude::BRIDGE_ENV.lock().await;
        let restore = Restore(std::env::var_os("YUZUNO_CLAUDE_BRIDGE"));
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir.path().join("runtime");
        fs::create_dir_all(&runtime).unwrap();
        fs::write(runtime.join("bridge.mjs"), format!("import \"file://{FIXTURE}\";\n")).unwrap();
        // claude_launch needs the launcher beside the bridge; the scripted SDK never runs it.
        script(&runtime.join("cswap-claude"), "#!/bin/sh\nexit 1\n");
        std::env::set_var("YUZUNO_CLAUDE_BRIDGE", runtime.join("bridge.mjs"));
        let cswap = dir.path().join("cswap");
        script(&cswap, &format!("#!{}\nprint(open({:?}).read())\n", python.display(), dir.path().join("accounts.json").display().to_string()));
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
        // No pass but the test's own.
        ws.executor_slots.quiet.store(true, std::sync::atomic::Ordering::Relaxed);
        let lab = Lab { ws, dir, _restore: restore, _env: env };
        lab.list(&[1, 2, 3]);
        lab.ws.store.save_cswap_settings(&routing_accounts::CswapSettings { command: cswap.display().to_string() }).unwrap();
        let detail: AgentDetail = serde_json::from_value(json!({"agent": {"id": ID, "name": "Executor", "cwd": work.to_string_lossy(),
            "model": "opus", "color": "sage", "harness": "claude", "claudeSessionId": SESSION, "status": "offline", "createdAt": "now",
            "updatedAt": "now", "unreadCount": 0, "pendingCount": 0, "lastSeq": 0, "reviewedSeq": 0}, "turns": [], "pending": [], "artifacts": []})).unwrap();
        lab.ws.store.insert(&detail).unwrap();
        let route = json!({"at": "dispatch", "chosen": "c-claude", "account": {"number": 2, "fingerprint": fp(2)}, "candidates": []});
        lab.ws.store.db.write().unwrap().execute(
            "INSERT INTO executor_dispatches(actor,request_id,input_json,task_id,template_id,project_id,machine_id,template_json,agent_id,state,created_at,updated_at,route_json)
             VALUES('user','r-ex','{}','T-1','writer',NULL,'local','{}',?1,'dispatched','now','now',?2)", rusqlite::params![ID, route.to_string()]).unwrap();
        lab.ws.store.set_runtime_profile(ID, Some(&RuntimeProfile::ClaudeAccount { fingerprint: fp(2) })).unwrap();
        lab.pool(&[2, 3]);
        lab.readings(&[1, 2, 3]);
        lab.ws.claude_ensure(ID).await.unwrap();
        assert_eq!(lab.starts(), [json!({"resume": SESSION, "account": "2"})]);
        Some(lab)
    }

    /// What claude-swap lists now: accounts `numbers`, 1 the host's own login.
    fn list(&self, numbers: &[u32]) {
        let accounts: Vec<Value> = numbers.iter().map(|n| json!({"number": n, "email": format!("account{n}@example.com"),
            "organizationUuid": null, "active": *n == 1})).collect();
        fs::write(self.dir.path().join("accounts.json"), json!({"schemaVersion": 1, "activeAccountNumber": 1, "accounts": accounts}).to_string()).unwrap();
    }

    /// The routing policy: Claude Code on a pool of accounts `numbers`.
    fn pool(&self, numbers: &[u32]) {
        let version = self.ws.store.routing_policy().unwrap().version;
        let accounts: Vec<String> = numbers.iter().map(|n| fp(*n)).collect();
        self.ws.store.save_routing_policy(version, json!({"enabled": true, "whenNone": "wait", "candidates": [
            {"id": "c-claude", "enabled": true, "harness": "claude", "model": "opus",
             "credential": {"kind": "pool", "manager": "cswap", "accounts": accounts}, "conditions": []}]})).unwrap().unwrap();
    }

    /// A fresh claude-swap reading of accounts `numbers`, each with half its week left.
    fn readings(&self, numbers: &[u32]) {
        let accounts: Vec<Value> = numbers.iter().map(|n| json!({"number": n, "fingerprint": fp(*n), "active": *n == 1, "source": "cswap",
            "week": {"leftPct": 50.0, "resetsAt": "2026-11-21T00:00:00+00:00"}})).collect();
        self.ws.store.db.write().unwrap().execute(
            "INSERT INTO routing_quotas(source, reading, observed_at) VALUES('cswap', ?1, ?2)
             ON CONFLICT(source) DO UPDATE SET reading=excluded.reading, observed_at=excluded.observed_at",
            [json!({"accounts": accounts}).to_string(), Utc::now().to_rfc3339()]).unwrap();
    }

    /// Each start of its bridge: the session it resumed and the account it was given.
    fn starts(&self) -> Vec<Value> {
        let text = fs::read_to_string(self.dir.path().join("work").join("starts.jsonl")).unwrap_or_default();
        text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn profile(&self) -> Option<RuntimeProfile> {
        self.ws.store.runtime_profile(ID).unwrap()
    }

    fn route(&self) -> Value {
        self.ws.store.routing_route(ID).unwrap().unwrap()
    }

    fn agent(&self) -> crate::model::Agent {
        self.ws.store.agent(ID).unwrap()
    }

    /// The pass's moves, and their tasks to their end.
    async fn pass(&self) {
        for task in self.ws.move_off_left_accounts().await {
            task.await.unwrap();
        }
    }

    fn set_status(&self, status: &str) {
        let status = status.to_owned();
        self.ws.store.update(ID, "test/status", &json!({}), move |d| d.agent.status = status).unwrap();
    }
}

/// The case of 11-14, started: account 2 is taken out of the pool. Idle, it is
/// moved to account 3 and resumes its session there; idle again, with no error.
#[tokio::test]
async fn an_idle_executor_whose_account_left_its_pool_resumes_its_session_on_another_account_of_it() {
    let Some(lab) = Lab::new().await else { return eprintln!("skipped: no python3 on PATH") };
    lab.pool(&[3]);
    // A Turn that failed on the account that left leaves it in error: that is idle enough.
    lab.set_status("error");
    lab.pass().await;
    assert_eq!(lab.starts(), [json!({"resume": SESSION, "account": "2"}), json!({"resume": SESSION, "account": "3"})]);
    let agent = lab.agent();
    assert_eq!((agent.connection_state.as_str(), agent.status.as_str(), agent.claude_session_id.as_deref()), ("connected", "idle", Some(SESSION)));
    assert_eq!(lab.profile(), Some(RuntimeProfile::ClaudeAccount { fingerprint: fp(3) }));
    let route = lab.route();
    assert_eq!(route["account"], json!({"number": 3, "fingerprint": fp(3)}));
    let changed = route["accountChanged"].as_array().unwrap();
    assert_eq!(changed.len(), 1, "{route}");
    assert_eq!((changed[0]["code"].clone(), changed[0]["from"]["number"].clone(), changed[0]["to"]["number"].clone()),
        (json!("accountLeftPool"), json!(2), json!(3)));
    lab.pass().await;
    assert_eq!(lab.starts().len(), 2, "on an account of its pool now: not moved again");
}

/// A Turn under way is not cut short: the pass leaves it, and once the Turn has
/// ended, the next pass moves it.
#[tokio::test]
async fn an_executor_with_a_turn_under_way_is_moved_only_once_it_has_ended() {
    let Some(lab) = Lab::new().await else { return eprintln!("skipped: no python3 on PATH") };
    lab.pool(&[3]);
    lab.set_status("working");
    lab.pass().await;
    assert_eq!(lab.starts().len(), 1, "not while its Turn runs");
    assert_eq!((lab.agent().connection_state, lab.profile()), ("connected".to_owned(), Some(RuntimeProfile::ClaudeAccount { fingerprint: fp(2) })));
    lab.set_status("idle");
    lab.pass().await;
    assert_eq!(lab.starts().last().unwrap(), &json!({"resume": SESSION, "account": "3"}));
}

/// No other account of the pool has a reading that lists it: the executor is not
/// stopped for a move its start could not make, and stays connected as it is.
#[tokio::test]
async fn an_executor_whose_pool_has_no_other_account_now_keeps_its_connection() {
    let Some(lab) = Lab::new().await else { return eprintln!("skipped: no python3 on PATH") };
    lab.pool(&[3]);
    lab.readings(&[1, 2]);
    lab.set_status("idle");
    lab.pass().await;
    assert_eq!(lab.starts().len(), 1);
    assert_eq!(lab.agent().connection_state, "connected");
    assert_eq!(lab.profile(), Some(RuntimeProfile::ClaudeAccount { fingerprint: fp(2) }));
    assert!(lab.route().get("accountChanged").is_none());
}

/// One the user disconnected waits for their Reconnect; one on another machine,
/// or with routing off, is not judged.
#[tokio::test]
async fn an_executor_the_user_disconnected_on_another_machine_or_with_routing_off_is_not_moved() {
    let Some(lab) = Lab::new().await else { return eprintln!("skipped: no python3 on PATH") };
    lab.set_status("idle");
    let mut off = lab.ws.store.routing_policy().unwrap();
    off.policy["enabled"] = json!(false);
    off.policy["candidates"][0]["credential"]["accounts"] = json!([fp(3)]);
    lab.ws.store.save_routing_policy(off.version, off.policy).unwrap().unwrap();
    lab.pass().await;
    assert_eq!(lab.starts().len(), 1, "routing off");

    lab.pool(&[3]);
    let marked = |remote: bool| {
        let raw: String = lab.ws.store.db.read().unwrap().query_row("SELECT data FROM agents WHERE id=?1", [ID], |r| r.get(0)).unwrap();
        let mut data: Value = serde_json::from_str(&raw).unwrap();
        data["agent"]["remote"] = if remote { json!({"machine": {"id": "m-1"}}) } else { Value::Null };
        data
    };
    // As the store reads it, an Agent recorded on another machine is not listed.
    lab.ws.store.db.write().unwrap().execute("UPDATE agents SET data=?2 WHERE id=?1", rusqlite::params![ID, marked(true).to_string()]).unwrap();
    assert!(lab.ws.store.routing_on_accounts(None).unwrap().is_empty(), "on another machine");
    lab.ws.store.db.write().unwrap().execute("UPDATE agents SET data=?2 WHERE id=?1", rusqlite::params![ID, marked(false).to_string()]).unwrap();
    assert_eq!(lab.ws.store.routing_on_accounts(None).unwrap().len(), 1);

    lab.ws.disconnect_agent(ID).await.unwrap();
    lab.pass().await;
    assert_eq!(lab.starts().len(), 1, "disconnected by the user");
    assert_eq!(lab.profile(), Some(RuntimeProfile::ClaudeAccount { fingerprint: fp(2) }));
    // Their Reconnect starts it, and that start moves it (routing_launch.rs `move_account`).
    lab.ws.reconnect(ID).await.unwrap();
    assert_eq!(lab.starts().last().unwrap(), &json!({"resume": SESSION, "account": "3"}));
}

/// #966 R1 P2: a move runs in a task of its own, so a restart that does not end
/// holds no pass, and a later pass starts no second move of it; the Workspace's
/// start time limit cuts it off, its failure shown, its connection kept. Here the
/// test holds the executor's gate, as a move that never finishes would.
#[tokio::test]
async fn a_move_that_does_not_finish_holds_no_pass_and_is_cut_off_by_the_start_limit() {
    let Some(lab) = Lab::new().await else { return eprintln!("skipped: no python3 on PATH") };
    lab.pool(&[3]);
    lab.set_status("idle");
    *lab.ws.executor_slots.start_limit.lock().unwrap() = Some(std::time::Duration::from_secs(1));
    let gate = lab.ws.gate(ID).await;
    let held = gate.lock().await;
    let moving = tokio::time::timeout(std::time::Duration::from_secs(5), lab.ws.move_off_left_accounts()).await
        .expect("the pass does not wait for the move");
    assert_eq!(moving.len(), 1);
    assert!(lab.ws.move_off_left_accounts().await.is_empty(), "one being moved is left to its task");
    for task in moving {
        task.await.unwrap();
    }
    let agent = lab.agent();
    assert_eq!((agent.status.as_str(), agent.connection_state.as_str()), ("error", "connected"));
    assert!(agent.error.as_deref().is_some_and(|e| e.contains("did not finish within 1 s") && e.contains("已中止")), "{:?}", agent.error);
    assert_eq!((lab.starts().len(), lab.profile()), (1, Some(RuntimeProfile::ClaudeAccount { fingerprint: fp(2) })));
    assert!(lab.ws.executor_slots.moving.lock().unwrap().is_empty());
    drop(held);
    // In error, it is idle enough: the next pass moves it.
    lab.pass().await;
    assert_eq!(lab.starts().last().unwrap(), &json!({"resume": SESSION, "account": "3"}));
    assert_eq!(lab.agent().status, "idle");
}
