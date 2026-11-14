use super::*;

#[test]
fn each_level_dsh_keeps_maps_to_its_sandbox_and_read_only_is_not_kept() {
    let kept: Vec<_> = ["ask", "auto", "full"].iter().map(|id| level_of(id).map(|l| (l.id(), l.access()))).collect();
    assert_eq!(kept, [Some(("ask", Access::Workspace)), Some(("auto", Access::Workspace)), Some(("full", Access::Full))]);
    for other in [crate::permission_levels::READ_ONLY, "", "Ask", "config"] {
        assert_eq!(level_of(other), None, "{other:?}");
    }
    assert!(not_kept("read-only").contains("不支持「read-only」"));
}

#[test]
fn a_model_is_chosen_by_its_value_or_its_name_and_an_effort_by_its_value() {
    let options = json!([
        {"id": "model", "options": [{"group": "deepseek-official", "options": [
            {"value": "[\"deepseek-official\",\"deepseek-flash\"]"}, {"value": "[\"deepseek-official\",\"deepseek-v4-pro\"]"}]}]},
        {"id": "reasoning_effort", "options": [{"value": "off"}, {"value": "low"}]},
    ]);
    let pro = "[\"deepseek-official\",\"deepseek-v4-pro\"]";
    assert_eq!(option_value(&options, "model", pro).as_deref(), Some(pro));
    assert_eq!(option_value(&options, "model", "deepseek-v4-pro").as_deref(), Some(pro));
    assert_eq!(option_value(&options, "model", "deepseek-r9"), None);
    assert_eq!(option_value(&options, "reasoning_effort", "low").as_deref(), Some("low"));
    assert_eq!(option_value(&options, "reasoning_effort", "ultra"), None);
    assert_eq!(option_value(&options, "sandbox", "low"), None);
}

#[test]
fn a_prompts_end_follows_its_stop_reason_or_why_it_has_none() {
    let end = |params: Value| end_of(&params).0;
    assert_eq!(end(json!({"stopReason": "end_turn"})), "completed");
    assert_eq!(end(json!({"stopReason": "max_tokens"})), "completed");
    assert_eq!(end(json!({"stopReason": "cancelled"})), "interrupted");
    assert_eq!(end(json!({"stopReason": "refusal"})), "failed");
    assert_eq!(end_of(&json!({"error": {"code": -32603, "message": "the model failed"}})), ("failed", Some("the model failed".into())));
    let (status, message) = end_of(&json!({"unknown": "dsh has ended"}));
    assert_eq!(status, "outcomeUnknown");
    assert!(message.unwrap().contains("dsh has ended"));
}

#[cfg(unix)]
#[test]
fn only_the_agents_own_folder_is_removed_never_what_a_link_names() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let (data, elsewhere) = (root.join("data"), root.join("elsewhere"));
    std::fs::create_dir_all(elsewhere.join("agent-1")).unwrap();
    std::fs::write(elsewhere.join("agent-1/kept"), "kept").unwrap();
    std::fs::create_dir_all(&data).unwrap();
    assert!(remove_folder(&data, "agent-1").is_ok(), "nothing to remove");
    // <data>/dsh a link elsewhere: refused, and what it names stays.
    std::os::unix::fs::symlink(&elsewhere, data.join("dsh")).unwrap();
    assert!(remove_folder(&data, "agent-1").unwrap_err().to_string().contains("is not Core's own folder"));
    assert!(elsewhere.join("agent-1/kept").exists());
    std::fs::remove_file(data.join("dsh")).unwrap();
    // The Agent's own name a link: the link alone goes.
    std::fs::create_dir(data.join("dsh")).unwrap();
    std::os::unix::fs::symlink(elsewhere.join("agent-1"), data.join("dsh/agent-1")).unwrap();
    remove_folder(&data, "agent-1").unwrap();
    assert!(!data.join("dsh/agent-1").exists() && elsewhere.join("agent-1/kept").exists());
    // Its own folder, whole.
    std::fs::create_dir_all(data.join("dsh/agent-2/home/sessions")).unwrap();
    std::fs::write(data.join("dsh/agent-2/overlay.yml"), "x").unwrap();
    remove_folder(&data, "agent-2").unwrap();
    assert!(!data.join("dsh/agent-2").exists() && data.join("dsh").is_dir());
    for name in ["..", ".", "a/b", ""] {
        assert!(remove_folder(&data, name).is_err(), "{name:?}");
    }
}

// ---------------------------------------------------------------- with the stand-in dsh

#[cfg(unix)]
const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/dsh_acp.py");
#[cfg(unix)]
const KEY: &str = "sk-yuzuno-test-placeholder";
#[cfg(unix)]
const ID: &str = "dsh-agent";

/// A Workspace whose dsh is the stand-in (tests/fixtures/dsh_acp.py), with a
/// DeepSeek key `deepseek` and an Anthropic key `anthropic`.
#[cfg(unix)]
struct Lab {
    dir: tempfile::TempDir,
    root: PathBuf,
    ws: Arc<Workspace>,
}

#[cfg(unix)]
impl Lab {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir(root.join("work")).unwrap();
        let ws = Self::open(&root);
        let keys = crate::routing_keys::Store::of(&root.join("data"));
        keys.put_local("deepseek", crate::routing_keys::Provider::Deepseek, crate::routing_keys::Secret::new(KEY.into())).unwrap();
        keys.put_local("anthropic", crate::routing_keys::Provider::Anthropic, crate::routing_keys::Secret::new("sk-ant-placeholder".into())).unwrap();
        Self { dir, root, ws }
    }

    /// The Workspace, as a Core starting on this folder opens it.
    fn open(root: &Path) -> Arc<Workspace> {
        // A link to the stand-in, as dsh_tests.rs links it (no ETXTBSY).
        let program = root.join("dsh");
        if !program.exists() {
            std::os::unix::fs::symlink(FIXTURE, &program).unwrap();
        }
        // Opened again, the Workspace lock may still be held a moment by
        // another test's fork, which has the old descriptor until its exec.
        let mut tries = 0;
        let ws = loop {
            match Workspace::new(root.join("data"), root.join("work").to_string_lossy().into(), "unused".into()) {
                Ok(ws) => break ws,
                Err(error) if tries < 250 && format!("{error:#}").contains("lock acquisition failed") => {
                    tries += 1;
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("{error:#}"),
            }
        };
        *ws.dsh_test.lock().unwrap() = Some((program, Some("http://127.0.0.1:9/v1".into())));
        ws
    }

    /// Agent ID as the store holds it, at `level`, with key `key`, its
    /// stand-in told `control`; not started.
    fn agent(&self, id: &str, level: Option<&str>, key: Option<&str>, control: Value, settings: Value) {
        let mut agent = json!({"id": id, "name": "dsh", "cwd": self.root.join("work"),
            "model": "", "color": "sage", "harness": "dsh", "threadId": null, "status": "offline",
            "createdAt": now(), "updatedAt": now(), "unreadCount": 0, "pendingCount": 0, "lastSeq": 0, "reviewedSeq": 0});
        if settings != json!({}) {
            agent["settings"] = settings;
        }
        let detail: AgentDetail = serde_json::from_value(json!({"agent": agent, "turns": [], "pending": [], "artifacts": []})).unwrap();
        self.ws.store.insert(&detail).unwrap();
        self.ws.store.set_permission_level(id, level).unwrap();
        if let Some(key) = key {
            self.ws.store.set_runtime_profile(id, Some(&RuntimeProfile::ApiKey { key_id: key.into() })).unwrap();
        }
        let home = self.root.join("data/dsh").join(id).join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("fixture.json"), control.to_string()).unwrap();
    }

    /// What the stand-in logged for Agent `id`.
    fn log(&self, id: &str) -> Vec<Value> {
        let text = std::fs::read_to_string(self.root.join("data/dsh").join(id).join("home/fixture-log.jsonl")).unwrap_or_default();
        text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn acp_runs(&self, id: &str) -> Vec<Value> {
        self.log(id).into_iter().filter(|r| r["kind"] == "start" && r["argv"].as_array().unwrap().len() == 4).collect()
    }

    async fn send(&self, client: &str, text: &str) -> Result<crate::model::MessageReceipt> {
        self.ws.send_message(ID, serde_json::from_value(json!({"clientMessageId": client, "text": text})).unwrap()).await
    }

    /// The record once `check` holds, within 30 s.
    async fn until(&self, what: &str, check: impl Fn(&AgentDetail) -> bool) -> AgentDetail {
        for _ in 0..1500 {
            let d = self.ws.store.detail(ID).unwrap();
            if check(&d) {
                return d;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("{what} within 30 s: {:#}", serde_json::to_value(self.ws.store.detail(ID).unwrap()).unwrap());
    }

    async fn turn_ended(&self, turn: &str) -> Value {
        let d = self.until("the Turn ends", |d| d.turns.iter().any(|t| t["id"] == turn && t["status"] != "inProgress")).await;
        d.turns.iter().find(|t| t["id"] == turn).unwrap().clone()
    }
}

#[cfg(unix)]
fn item<'a>(turn: &'a Value, kind: &str) -> Vec<&'a Value> {
    turn["items"].as_array().unwrap().iter().filter(|i| i["type"] == kind).collect()
}

#[cfg(unix)]
fn sha256(text: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// A dsh Agent made as POST /api/agents makes one: its level and key kept
/// beside its record, its model and effort set on the session it starts,
/// its key given to dsh alone; and what it cannot have refused before it exists.
#[cfg(unix)]
#[tokio::test]
async fn a_new_dsh_agent_keeps_its_level_and_key_and_starts_with_its_model_and_effort() {
    let lab = Lab::new();
    let work = lab.root.join("work").to_string_lossy().into_owned();
    let key = || Some(RuntimeProfile::ApiKey { key_id: "deepseek".into() });
    let create = |model: &str, effort: Option<&str>, machine: Option<&str>, level: Option<&str>, profile: Option<RuntimeProfile>| {
        lab.ws.dsh_create_on("dsh".into(), work.clone(), model.into(), effort.map(str::to_owned), machine.map(str::to_owned), None, None,
            level.map(str::to_owned), profile)
    };
    for (refused, why) in [
        (create("", None, None, Some("read-only"), key()).await, "不支持「read-only」"),
        (create("", None, None, None, None).await, "DeepSeek 密钥"),
        (create("", None, None, None, Some(RuntimeProfile::ApiKey { key_id: "anthropic".into() })).await, "not a DeepSeek key"),
        (create("", None, None, None, Some(RuntimeProfile::ApiKey { key_id: "missing".into() })).await, "not a DeepSeek key"),
        (create("", None, None, None, Some(RuntimeProfile::CodexHome { id: "h".into() })).await, "DeepSeek routing key only"),
        (create("", None, Some("mac-mini"), None, key()).await, "本机"),
        (create("", Some("ultra"), None, None, key()).await, "off、low、high 或 max"),
    ] {
        assert!(refused.as_ref().unwrap_err().to_string().contains(why), "{why}: {:?}", refused.err());
    }
    assert!(lab.ws.store.agents().unwrap().is_empty(), "nothing refused was made");

    let agent = create("deepseek-v4-pro", Some("low"), Some("local"), Some("auto"), key()).await.unwrap();
    assert_eq!((agent.harness.as_str(), agent.settings.permission_level.as_deref(), agent.settings.reasoning_effort.as_deref()),
        ("dsh", Some("auto"), Some("low")));
    assert_eq!(lab.ws.store.permission_level(&agent.id).unwrap().as_deref(), Some("auto"));
    assert_eq!(lab.ws.store.runtime_profile(&agent.id).unwrap(), key());
    let started = loop {
        let d = lab.ws.store.detail(&agent.id).unwrap();
        if d.agent.connection_state == "connected" {
            break d;
        }
        assert!(d.agent.error.is_none(), "{:?}", d.agent.error);
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!((started.agent.dsh_session_id.as_deref(), started.agent.dsh_version.as_deref()), (Some("ses-1"), Some("0.2.2-rc.3")));
    let log = lab.log(&agent.id);
    let set: Vec<(String, String)> = log.iter().filter(|r| r["kind"] == "set")
        .map(|r| (r["configId"].as_str().unwrap().into(), r["value"].as_str().unwrap().into())).collect();
    assert_eq!(set, [("model".into(), "[\"deepseek-official\",\"deepseek-v4-pro\"]".into()), ("reasoning_effort".into(), "low".into())]);
    let run = &lab.acp_runs(&agent.id)[0];
    assert_eq!(run["env"]["DSH_PERMISSION_MODE"], "workspace-write", "Auto-approve is dsh's sandbox");
    assert_eq!(run["keySha256"], sha256(KEY), "the Agent's own key, as DEEPSEEK_API_KEY");
    assert_eq!(run["cwd"], lab.root.join("work").to_string_lossy().as_ref());
    lab.ws.close_agent(&agent.id).await.unwrap();
}

/// A message is one prompt (§3.4): its Turn recorded first, dsh's updates
/// read into Codex-shaped Items, its end dsh's answer; tools as commands,
/// MCP calls and dsh's own; the context dsh reports kept.
#[cfg(unix)]
#[tokio::test]
async fn a_turn_reads_dshs_updates_into_items_and_ends_with_its_answer() {
    let lab = Lab::new();
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    let receipt = lab.send("c1", "hello").await.unwrap();
    assert_eq!(receipt.status, "accepted");
    let turn = lab.turn_ended(receipt.turn_id.as_deref().unwrap()).await;
    assert_eq!(turn["status"], "completed");
    assert_eq!(turn["stopReason"], "end_turn");
    assert_eq!(item(&turn, "userMessage")[0]["content"][0]["text"], "hello");
    assert_eq!(item(&turn, "reasoning")[0]["summary"], json!(["thinking"]));
    assert_eq!(item(&turn, "agentMessage")[0]["text"], "reply: hello");
    let d = lab.ws.store.detail(ID).unwrap();
    assert_eq!(d.agent.status, "idle");
    let usage = d.context_usage.unwrap();
    assert_eq!((usage.used_tokens, usage.window_tokens, usage.turn_id.as_str()), (1234, 1_000_000, receipt.turn_id.as_deref().unwrap()));

    let tools = lab.send("c2", "TOOL").await.unwrap();
    let turn = lab.turn_ended(tools.turn_id.as_deref().unwrap()).await;
    assert_eq!(turn["status"], "completed");
    let command = item(&turn, "commandExecution")[0];
    assert_eq!((&command["command"], &command["aggregatedOutput"], &command["exitCode"], &command["status"]),
        (&json!("ls"), &json!("a.txt\n"), &json!(0), &json!("completed")));
    let mcp = item(&turn, "mcpToolCall")[0];
    assert_eq!((&mcp["server"], &mcp["tool"], &mcp["result"], &mcp["status"]),
        (&json!("yuzuno"), &json!("peers_list"), &json!("{\"peers\":[]}"), &json!("completed")));
    let read = item(&turn, "dshTool")[0];
    assert_eq!((&read["name"], &read["input"], &read["output"], &read["status"]),
        (&json!("read"), &json!({"path": "a.txt"}), &json!("no such file"), &json!("failed")));
    assert_eq!(item(&turn, "agentMessage")[0]["text"], "done");
    lab.ws.close_agent(ID).await.unwrap();
}

/// A request past dsh's sandbox is refused by Core (§3.6, S2a), at Ask too:
/// dsh gets reject-once, the user nothing to answer, and the Turn goes on.
#[cfg(unix)]
#[tokio::test]
async fn a_request_past_the_sandbox_is_refused_by_core_and_never_reaches_the_user() {
    let lab = Lab::new();
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    let receipt = lab.send("c1", "ASK").await.unwrap();
    let turn = lab.turn_ended(receipt.turn_id.as_deref().unwrap()).await;
    assert_eq!(turn["status"], "completed");
    let answer: Value = serde_json::from_str(item(&turn, "agentMessage")[0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(answer, json!({"outcome": {"outcome": "selected", "optionId": "reject-once"}}), "what dsh was answered");
    assert_eq!(item(&turn, "commandExecution")[0]["permission"], json!({"answer": "refused", "by": "core"}));
    let d = lab.ws.store.detail(ID).unwrap();
    assert!(d.pending.is_empty(), "nothing waits for the user");
    lab.ws.close_agent(ID).await.unwrap();
}

/// One prompt at a time (§3.5): while a Turn runs, neither a new message nor
/// one added to it is sent; an interrupt ends it with dsh's `cancelled`.
#[cfg(unix)]
#[tokio::test]
async fn an_interrupt_ends_the_turn_and_no_message_goes_while_it_runs() {
    let lab = Lab::new();
    lab.agent(ID, Some("full"), Some("deepseek"), json!({}), json!({}));
    let receipt = lab.send("c1", "SLEEP").await.unwrap();
    let running = receipt.turn_id.unwrap();
    assert_eq!(lab.ws.store.detail(ID).unwrap().agent.status, "working");
    let refused = lab.send("c2", "more").await.unwrap_err();
    assert!(refused.to_string().contains("一轮结束前不能追加"), "{refused}");
    let added: crate::model::MessageInput = serde_json::from_value(json!({"clientMessageId": "c3", "text": "more", "expectedTurnId": running})).unwrap();
    assert!(lab.ws.send_message(ID, added).await.unwrap_err().to_string().contains("一轮结束前不能追加"));
    lab.ws.interrupt(ID).await.unwrap();
    let turn = lab.turn_ended(&running).await;
    assert_eq!((&turn["status"], &turn["interruptRequested"]), (&json!("interrupted"), &json!(true)));
    let prompts = lab.log(ID).iter().filter(|r| r["method"] == "session/prompt").count();
    assert_eq!(prompts, 1, "nothing was sent while it ran");
    assert_eq!(lab.acp_runs(ID)[0]["env"]["DSH_PERMISSION_MODE"], "danger-full-access", "Full access");
    let next = lab.send("c4", "after").await.unwrap();
    assert_eq!(lab.turn_ended(next.turn_id.as_deref().unwrap()).await["status"], "completed");
    lab.ws.close_agent(ID).await.unwrap();
}

/// A Core that starts again resumes the Agent's session in a new dsh (§3.8),
/// its effort set again, and what the earlier dsh ran and never answered is
/// unknown, never sent again.
#[cfg(unix)]
#[tokio::test]
async fn a_new_core_resumes_the_session_and_what_ran_before_is_unknown() {
    let lab = Lab::new();
    lab.agent(ID, None, Some("deepseek"), json!({}), json!({"reasoningEffort": "max", "approvalPolicy": "on-request", "sandbox": "workspace-write"}));
    let running = lab.send("c1", "SLEEP").await.unwrap().turn_id.unwrap();
    let Lab { dir, root, ws } = lab;
    // As when Core stops: its dsh stopped, and the Workspace gone, which an
    // event still being applied holds a moment longer.
    ws.dsh_stop_all().await;
    let gone = (Arc::downgrade(&ws), Arc::downgrade(&ws.store));
    drop(ws);
    for _ in 0..500 {
        if gone.0.strong_count() == 0 && gone.1.strong_count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let lab = Lab { dir, ws: Lab::open(&root), root };
    let d = lab.ws.reconnect(ID).await.unwrap();
    assert_eq!((d.agent.connection_state.as_str(), d.agent.dsh_session_id.as_deref()), ("connected", Some("ses-1")));
    let turn = d.turns.iter().find(|t| t["id"] == running.as_str()).unwrap();
    assert_eq!(turn["status"], "outcomeUnknown");
    let log = lab.log(ID);
    assert!(log.iter().any(|r| r["kind"] == "resumed" && r["sessionId"] == "ses-1"), "resumed, not made anew");
    assert_eq!(log.iter().filter(|r| r["kind"] == "set" && r["configId"] == "reasoning_effort" && r["value"] == "max").count(), 2,
        "its effort, set at each start");
    assert_eq!(log.iter().filter(|r| r["method"] == "session/prompt").count(), 1, "nothing sent again");
    let next = lab.send("c2", "again").await.unwrap();
    assert_eq!(lab.turn_ended(next.turn_id.as_deref().unwrap()).await["status"], "completed");
    lab.ws.close_agent(ID).await.unwrap();
}

/// dsh ending by itself (§3.1): its Turn unknown, the Agent saying why with
/// dsh's last words; a reconnect resumes the same session.
#[cfg(unix)]
#[tokio::test]
async fn dsh_ending_by_itself_leaves_its_turn_unknown_and_says_why() {
    let lab = Lab::new();
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    let running = lab.send("c1", "EXIT").await.unwrap().turn_id.unwrap();
    let d = lab.until("the Agent is disconnected", |d| d.agent.connection_state == "disconnected").await;
    assert_eq!(d.turns.iter().find(|t| t["id"] == running.as_str()).unwrap()["status"], "outcomeUnknown");
    assert_eq!(d.agent.status, "uncertain");
    assert!(d.agent.error.as_deref().unwrap().contains("fixture: exiting"), "{:?}", d.agent.error);
    assert!(lab.ws.dshs.lock().unwrap().get(ID).is_none());
    let d = lab.ws.reconnect(ID).await.unwrap();
    assert_eq!((d.agent.connection_state.as_str(), d.agent.status.as_str()), ("connected", "idle"));
    assert!(lab.log(ID).iter().any(|r| r["kind"] == "resumed"));
    lab.ws.close_agent(ID).await.unwrap();
}

/// Without a DeepSeek key dsh does not start (§3.10), and a key of another
/// provider is never given to it.
#[cfg(unix)]
#[tokio::test]
async fn without_a_deepseek_key_dsh_does_not_start() {
    let lab = Lab::new();
    lab.agent(ID, Some("ask"), None, json!({}), json!({}));
    assert!(lab.ws.reconnect(ID).await.unwrap_err().to_string().contains("dsh 需要一个 DeepSeek 密钥"));
    lab.ws.store.set_runtime_profile(ID, Some(&RuntimeProfile::ApiKey { key_id: "anthropic".into() })).unwrap();
    assert!(lab.ws.reconnect(ID).await.unwrap_err().to_string().contains("not a DeepSeek key"));
    lab.ws.store.set_permission_level(ID, Some(crate::permission_levels::READ_ONLY)).unwrap();
    lab.ws.store.set_runtime_profile(ID, Some(&RuntimeProfile::ApiKey { key_id: "deepseek".into() })).unwrap();
    assert!(lab.ws.reconnect(ID).await.unwrap_err().to_string().contains("不支持「read-only」"));
    assert!(lab.log(ID).is_empty(), "dsh never ran");
    assert_eq!(lab.ws.store.detail(ID).unwrap().agent.connection_state, "disconnected");
}

/// A close stops dsh, its group with it (§3.1); a delete removes the Agent's
/// dsh folder with it (§3.8).
#[cfg(unix)]
#[tokio::test]
async fn closing_stops_dsh_and_deleting_removes_its_folder() {
    let lab = Lab::new();
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    let running = lab.send("c1", "SLEEP").await.unwrap().turn_id.unwrap();
    let pid = lab.ws.dshs.lock().unwrap().get(ID).unwrap().dsh.pid().unwrap();
    let d = lab.ws.close_agent(ID).await.unwrap();
    assert!(d.agent.closed_at.is_some());
    assert_eq!(d.turns.iter().find(|t| t["id"] == running.as_str()).unwrap()["status"], "interrupted", "interrupted before dsh stopped");
    assert!(lab.ws.dshs.lock().unwrap().get(ID).is_none());
    assert!(rustix::process::test_kill_process(rustix::process::Pid::from_raw(pid as i32).unwrap()).is_err(), "dsh ended and was reaped");
    let folder = lab.root.join("data/dsh").join(ID);
    assert!(folder.join("overlay.yml").exists());
    lab.ws.delete_agent(ID).await.unwrap();
    assert!(!folder.exists() && lab.root.join("data/dsh").is_dir());
    assert!(lab.ws.store.agents().unwrap().is_empty());
}

/// What `/api/workspace` says of dsh (§6 S2a): its version and note when it
/// can start, and that it can't when there is none.
#[cfg(unix)]
#[tokio::test]
async fn the_workspace_says_whether_dsh_can_start_and_which() {
    let lab = Lab::new();
    let program = lab.root.join("dsh");
    let home = lab.root.join("data/dsh-version");
    assert_eq!(installed(&program, &home).await, json!({"available": true, "version": "0.2.2-rc.3", "label": null}));
    std::fs::write(home.join("fixture.json"), json!({"version": "0.2.2-rc.9"}).to_string()).unwrap();
    let newer = installed(&program, &home).await;
    assert_eq!((&newer["available"], &newer["version"]), (&json!(true), &json!("0.2.2-rc.9")));
    assert!(newer["label"].as_str().unwrap().contains("newer than the verified"));
    std::fs::write(home.join("fixture.json"), json!({"version": "0.2.1"}).to_string()).unwrap();
    assert_eq!(installed(&program, &home).await["available"], false, "older than MIN");
    assert_eq!(installed(&lab.root.join("missing"), &home).await, json!({"available": false, "version": null, "label": null}));
}
