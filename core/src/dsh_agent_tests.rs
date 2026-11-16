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

    let project = lab.ws.store.create_project("Lab", Default::default()).unwrap();
    let agent = lab.ws.dsh_create_on("dsh".into(), work.clone(), "deepseek-v4-pro".into(), Some("low".into()), Some("local".into()),
        Some(project.id.clone()), None, Some("auto".into()), key()).await.unwrap();
    assert_eq!((agent.harness.as_str(), agent.settings.permission_level.as_deref(), agent.settings.reasoning_effort.as_deref()),
        ("dsh", Some("auto"), Some("low")));
    assert_eq!(lab.ws.store.agent(&agent.id).unwrap().project_id.as_deref(), Some(project.id.as_str()), "in its Project");
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
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({"commandsUpdate": true}), json!({}));
    let receipt = lab.send("c1", "hello").await.unwrap();
    assert_eq!(receipt.status, "accepted");
    let turn = lab.turn_ended(receipt.turn_id.as_deref().unwrap()).await;
    assert_eq!(turn["status"], "completed");
    assert_eq!(turn["stopReason"], "end_turn");
    assert_eq!(item(&turn, "userMessage")[0]["content"][0]["text"], "hello");
    assert_eq!(item(&turn, "userMessage")[0]["clientId"], "c1", "delivered: bound to its receipt");
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

    // What dsh says with no prompt open is a Turn of its own, done; what makes no Item (the
    // commands it lists as each session opens) makes no Turn.
    let later = lab.send("c3", "LATER").await.unwrap();
    assert_eq!(lab.turn_ended(later.turn_id.as_deref().unwrap()).await["status"], "completed");
    let d = lab.until("its own message", |d| d.turns.iter().any(|t| t["_dshNative"] == true)).await;
    let native: Vec<&Value> = d.turns.iter().filter(|t| t["_dshNative"] == true).collect();
    assert_eq!(native.len(), 1, "{:?}", d.turns.iter().map(|t| &t["id"]).collect::<Vec<_>>());
    assert_eq!((&native[0]["status"], &item(native[0], "agentMessage")[0]["text"]), (&json!("completed"), &json!("on my own")));
    assert_eq!(d.agent.status, "idle");
    assert_eq!(d.turns.len(), 4, "hello, TOOL, LATER and dsh's own");
    lab.ws.close_agent(ID).await.unwrap();
}

/// A request past dsh's sandbox at Auto-approve is refused by Core (§3.6):
/// dsh gets reject-once, the user nothing to answer, and the Turn goes on.
#[cfg(unix)]
#[tokio::test]
async fn a_request_past_the_sandbox_is_refused_by_core_at_auto_approve() {
    let lab = Lab::new();
    lab.agent(ID, Some("auto"), Some("deepseek"), json!({}), json!({}));
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

/// A request past dsh's sandbox at Ask you first is the user's (§3.6): a
/// card with the command, its sandbox permissions and why; the Agent waits;
/// allow once sends dsh's allow-once, decline its reject-once, each once.
#[cfg(unix)]
#[tokio::test]
async fn a_request_past_the_sandbox_at_ask_is_a_card_the_user_allows_or_declines() {
    let lab = Lab::new();
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    for (client, decision, option, answer) in [("c1", "accept", "allow-once", "allowed"), ("c2", "decline", "reject-once", "refused")] {
        let running = lab.send(client, "ASK").await.unwrap().turn_id.unwrap();
        let d = lab.until("the card", |d| !d.pending.is_empty()).await;
        let card = d.pending[0].clone();
        assert_eq!((card.method.as_str(), d.agent.status.as_str()), (PERMISSION, "waiting"));
        assert_eq!((&card.params["command"], &card.params["reason"], &card.params["sandboxPermissions"], &card.params["turnId"]),
            (&json!("touch ../outside"), &json!("The test asks."), &json!("danger-full-access"), &json!(running)));
        assert_eq!(card.params["availableDecisions"], json!(["accept", "decline"]));
        assert!(lab.send("c9", "more").await.unwrap_err().to_string().contains("一轮结束前不能追加"), "busy while it waits");
        let refused = lab.ws.respond(&card.id, json!({"decision": "acceptForSession"})).await.unwrap_err();
        assert!(refused.to_string().contains("accept"), "{refused}");
        lab.ws.respond(&card.id, json!({"decision": decision})).await.unwrap();
        let turn = lab.turn_ended(&running).await;
        assert_eq!(turn["status"], "completed");
        let said: Value = serde_json::from_str(item(&turn, "agentMessage")[0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(said, json!({"outcome": {"outcome": "selected", "optionId": option}}), "what dsh was answered");
        assert_eq!(item(&turn, "commandExecution")[0]["permission"], json!({"answer": answer, "by": "user"}));
        let d = lab.ws.store.detail(ID).unwrap();
        assert!(d.pending.is_empty());
        assert_eq!(d.agent.status, "idle");
        assert!(lab.ws.respond(&card.id, json!({"decision": decision})).await.is_err(), "answered once");
    }
    let answers = lab.log(ID).into_iter().filter(|r| r["kind"] == "answer").count();
    assert_eq!(answers, 2, "each answer went once");
    lab.ws.close_agent(ID).await.unwrap();
}

/// An interrupt while a card waits (§3.5, §3.6): dsh's request is answered
/// `cancelled`, as ACP asks, the card goes, and the Turn ends interrupted.
#[cfg(unix)]
#[tokio::test]
async fn an_interrupt_answers_an_open_request_cancelled() {
    let lab = Lab::new();
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    let running = lab.send("c1", "ASK").await.unwrap().turn_id.unwrap();
    let card = lab.until("the card", |d| !d.pending.is_empty()).await.pending[0].clone();
    lab.ws.interrupt(ID).await.unwrap();
    assert_eq!(lab.turn_ended(&running).await["status"], "interrupted");
    let d = lab.until("the card is gone", |d| d.pending.is_empty()).await;
    assert_eq!(d.agent.status, "idle");
    let answers: Vec<Value> = lab.log(ID).into_iter().filter(|r| r["kind"] == "answer").collect();
    assert_eq!(answers.len(), 1);
    assert_eq!(answers[0]["result"], json!({"outcome": {"outcome": "cancelled"}}));
    assert!(lab.ws.respond(&card.id, json!({"decision": "accept"})).await.is_err(), "nothing more goes");
    lab.ws.close_agent(ID).await.unwrap();
}

/// With the Workspace MCP (§3.7, §3.1): each start names it to dsh, an http
/// server with its credential as a header, never in dsh's argv, environment
/// or files; AGENTS.md holds the session notice; the Agent is ready for mail.
/// A Turn's end is journaled as a completion once (an unread result).
#[cfg(unix)]
#[tokio::test]
async fn a_start_names_the_workspace_mcp_and_writes_the_session_notice() {
    let lab = Lab::new();
    lab.ws.collaboration_url.set("http://127.0.0.1:4999".into()).unwrap();
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    let turn = lab.send("c1", "hello").await.unwrap().turn_id.unwrap();
    assert_eq!(lab.turn_ended(&turn).await["status"], "completed");
    let mcp: Vec<Value> = lab.log(ID).into_iter().filter(|r| r["kind"] == "mcp").collect();
    assert_eq!(mcp.len(), 1);
    assert_eq!(mcp[0]["servers"], json!([{"type": "http", "name": "yuzuno", "url": format!("http://127.0.0.1:4999/mcp/{ID}"),
        "headerNames": ["Authorization"]}]));
    let config = crate::collaboration_mcp::agent_http_config_in(&lab.ws.store, ID, "http://127.0.0.1:4999").unwrap();
    let token = config["headers"]["Authorization"].as_str().unwrap().trim_start_matches("Bearer ").to_owned();
    assert!(token.len() > 16);
    let home = lab.root.join("data/dsh").join(ID);
    let notice = std::fs::read_to_string(home.join("home/AGENTS.md")).unwrap();
    assert_eq!(notice, crate::guide::session_notice());
    let run = &lab.acp_runs(ID)[0];
    for (place, text) in [("argv and environment", run.to_string()), ("overlay", std::fs::read_to_string(home.join("overlay.yml")).unwrap()),
        ("AGENTS.md", notice)] {
        assert!(!text.contains(&token), "the credential in dsh's {place}");
    }
    assert!(lab.ws.collaboration_status(ID).await.is_some_and(|s| s.ready));
    // Journaled just after the Turn's end, as Claude's is.
    lab.until("its result is unread", |d| d.agent.unread_count == 1).await;
    let db = lab.ws.store.db.read().unwrap();
    let ends: i64 = db.query_row("SELECT COUNT(*) FROM journal WHERE agent_id=?1 AND kind='turn/completed' AND json_extract(data,'$.turn.id')=?2",
        rusqlite::params![ID, turn], |r| r.get(0)).unwrap();
    drop(db);
    assert_eq!(ends, 1);
    // A new dsh resumes the session with it named again.
    lab.ws.dsh_stop_all().await;
    lab.ws.reconnect(ID).await.unwrap();
    let mcp: Vec<Value> = lab.log(ID).into_iter().filter(|r| r["kind"] == "mcp").collect();
    assert_eq!((mcp.len(), &mcp[1]["method"], &mcp[1]["servers"][0]["name"]), (2, &json!("session/resume"), &json!("yuzuno")));
    lab.ws.close_agent(ID).await.unwrap();
}

/// dsh has no Stop hook (§3.5): a Project Agent's Turn that ends without a
/// Brief update gets Codex's one reminder Turn, through dsh's own send, and
/// that Turn is never reminded itself. Its session starts with the rules.
#[cfg(unix)]
#[tokio::test]
async fn a_turn_without_a_brief_update_gets_one_reminder_turn() {
    let lab = Lab::new();
    lab.ws.collaboration_url.set("http://127.0.0.1:4999".into()).unwrap();
    let fake = crate::brief_turns::tests::Fake::member(ID);
    lab.ws.brief_turns.set_seam(fake.clone());
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    let missed = lab.send("c1", "hello").await.unwrap().turn_id.unwrap();
    assert_eq!(lab.turn_ended(&missed).await["status"], "completed");
    let notice = std::fs::read_to_string(lab.root.join("data/dsh").join(ID).join("home/AGENTS.md")).unwrap();
    assert!(notice.starts_with(crate::guide::session_notice()) && notice.ends_with("BRIEF HARD RULES: call brief_update every turn."), "{notice}");
    lab.until("its end is journaled", |d| d.agent.unread_count == 1).await;
    lab.ws.check_brief_turns().await.unwrap();
    assert_eq!(fake.recorded(ID, &missed).map(|o| o.0).as_deref(), Some("reminded"));
    let d = lab.until("the reminder Turn ends", |d| d.turns.len() == 2 && d.turns[1]["status"] == "completed" && d.agent.unread_count == 2).await;
    let input = &item(&d.turns[1], "userMessage")[0];
    assert!(input["content"][0]["text"].as_str().unwrap().starts_with("[Yuzuno Brief reminder"), "{input}");
    assert!(input["clientId"].as_str().unwrap().starts_with(crate::brief_turns::REMINDER_CLIENT_PREFIX));
    lab.ws.check_brief_turns().await.unwrap();
    assert_eq!(fake.recorded(ID, &missed).map(|o| o.0).as_deref(), Some("remindFailed"), "its reminder ended without an update");
    assert_eq!(lab.log(ID).iter().filter(|r| r["method"] == "session/prompt").count(), 2, "no reminder of the reminder");
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

/// An interrupt dsh never answers (§3.5): its Turn unknown, and that dsh
/// ended, since ACP's next prompt would wait for its answer; the next message
/// resumes the session in a new dsh (R1 9c3aa8f5).
#[cfg(unix)]
#[tokio::test]
async fn an_unanswered_interrupt_ends_that_dsh_and_the_next_message_resumes_the_session() {
    let lab = Lab::new();
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    let running = lab.send("c1", "HANG").await.unwrap().turn_id.unwrap();
    lab.ws.interrupt(ID).await.unwrap();
    let d = lab.until("that dsh is ended", |d| d.agent.connection_state == "disconnected").await;
    let turn = d.turns.iter().find(|t| t["id"] == running.as_str()).unwrap();
    assert_eq!((&turn["status"], &turn["interruptRequested"]), (&json!("outcomeUnknown"), &json!(true)));
    assert!(turn["error"]["message"].as_str().unwrap().contains("没有确认中断"), "{turn:#}");
    assert_eq!(d.agent.status, "offline");
    assert!(d.agent.error.as_deref().unwrap().contains("Core 已结束这个 dsh"), "{:?}", d.agent.error);
    assert!(lab.ws.dshs.lock().unwrap().get(ID).is_none());
    assert!(lab.log(ID).iter().any(|r| r["kind"] == "stdinEnded"), "that dsh was stopped");
    let next = lab.send("c2", "after").await.unwrap();
    assert_eq!(lab.turn_ended(next.turn_id.as_deref().unwrap()).await["status"], "completed");
    let log = lab.log(ID);
    assert!(log.iter().any(|r| r["kind"] == "resumed" && r["sessionId"] == "ses-1"), "resumed, not made anew");
    assert_eq!(lab.acp_runs(ID).len(), 2);
    assert_eq!(log.iter().filter(|r| r["method"] == "session/prompt").count(), 2, "the hung one not sent again");
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

/// Settings between Turns (§3.9, §3.6): a model and an effort its dsh offers
/// are set on its live session and saved; one it doesn't, or any during a
/// Turn, is refused with nothing saved; a level takes a new dsh, which
/// resumes the session in the new sandbox.
#[cfg(unix)]
#[tokio::test]
async fn settings_go_to_the_live_session_and_a_level_to_a_new_dsh() {
    let lab = Lab::new();
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    let first = lab.send("c1", "hello").await.unwrap().turn_id.unwrap();
    lab.turn_ended(&first).await;
    let agent = lab.ws.dsh_settings(ID, "deepseek-v4-pro".into(), Some(Some("max".into())), None).await.unwrap();
    assert_eq!((agent.model.as_str(), agent.settings.reasoning_effort.as_deref()), ("deepseek-v4-pro", Some("max")));
    let set: Vec<(String, String)> = lab.log(ID).iter().filter(|r| r["kind"] == "set")
        .map(|r| (r["configId"].as_str().unwrap().into(), r["value"].as_str().unwrap().into())).collect();
    assert_eq!(set, [("model".into(), "[\"deepseek-official\",\"deepseek-v4-pro\"]".into()), ("reasoning_effort".into(), "max".into())], "on its live session");
    for (model, effort, why) in [("gpt-9", None, "dsh 不提供模型"), ("deepseek-v4-pro", Some(Some("ultra")), "off、low、high 或 max"),
        ("deepseek-v4-pro", Some(None), "不能回到默认"), ("", None, "不能留空")] {
        let refused = lab.ws.dsh_settings(ID, model.into(), effort.map(|e: Option<&str>| e.map(str::to_owned)), None).await.unwrap_err();
        assert!(refused.to_string().contains(why), "{why}: {refused}");
    }
    let running = lab.send("c2", "SLEEP").await.unwrap().turn_id.unwrap();
    let busy = lab.ws.dsh_settings(ID, "deepseek-flash".into(), None, None).await.unwrap_err();
    assert!(busy.to_string().contains("一轮进行中"), "{busy}");
    lab.ws.interrupt(ID).await.unwrap();
    lab.turn_ended(&running).await;
    let d = lab.ws.store.detail(ID).unwrap();
    assert_eq!((d.agent.model.as_str(), d.agent.settings.reasoning_effort.as_deref()), ("deepseek-v4-pro", Some("max")), "nothing refused was saved");
    let refused = lab.ws.dsh_settings(ID, "deepseek-v4-pro".into(), None, Some("read-only".into())).await.unwrap_err();
    assert!(refused.to_string().contains("read-only"), "{refused}");

    let agent = lab.ws.dsh_settings(ID, "deepseek-v4-pro".into(), None, Some("full".into())).await.unwrap();
    assert_eq!(agent.settings.permission_level.as_deref(), Some("full"));
    assert_eq!(lab.ws.store.permission_level(ID).unwrap().as_deref(), Some("full"));
    let runs = lab.acp_runs(ID);
    assert_eq!(runs.len(), 2, "a new dsh");
    assert_eq!(runs[1]["env"]["DSH_PERMISSION_MODE"], "danger-full-access");
    assert!(lab.log(ID).iter().any(|r| r["kind"] == "resumed" && r["sessionId"] == "ses-1"), "the same session");
    let d = lab.ws.store.detail(ID).unwrap();
    assert_eq!((d.agent.connection_state.as_str(), d.agent.status.as_str()), ("connected", "idle"));
    let after = lab.send("c3", "after").await.unwrap().turn_id.unwrap();
    assert_eq!(lab.turn_ended(&after).await["status"], "completed");
    lab.ws.close_agent(ID).await.unwrap();
}

/// What a dsh Agent may choose (§3.9): its live dsh's models, by name, its
/// current one the default; before it has a dsh, and for a new Agent, a dsh
/// of Core's own lists them, its folder gone after.
#[cfg(unix)]
#[tokio::test]
async fn models_come_from_the_agents_dsh_or_a_dsh_of_cores_own() {
    let lab = Lab::new();
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    let names = |listed: &Value| -> Vec<(String, String, bool)> { listed["models"].as_array().unwrap().iter()
        .map(|m| (m["model"].as_str().unwrap().into(), m["displayName"].as_str().unwrap().into(), m["isDefault"] == true)).collect() };
    let expected = vec![("deepseek-flash".to_owned(), "DeepSeek-V4.1-Flash".to_owned(), true), ("deepseek-v4-pro".into(), "DeepSeek-V4-Pro".into(), false)];
    let catalog = lab.ws.dsh_agent_models(ID).await.unwrap();
    assert_eq!(names(&catalog), expected, "before it has a dsh: Core's own");
    assert_eq!(catalog["version"], "0.2.2-rc.3");
    let left: Vec<_> = std::fs::read_dir(lab.root.join("data/dsh-catalog")).unwrap().collect();
    assert!(left.is_empty(), "the catalog's dsh folder is removed");
    assert!(lab.acp_runs(ID).is_empty(), "the Agent's own dsh did not start");
    let first = lab.send("c1", "hello").await.unwrap().turn_id.unwrap();
    lab.turn_ended(&first).await;
    lab.ws.dsh_settings(ID, "deepseek-v4-pro".into(), None, None).await.unwrap();
    let live = lab.ws.dsh_agent_models(ID).await.unwrap();
    let mut chosen = expected.clone();
    chosen[0].2 = false;
    chosen[1].2 = true;
    assert_eq!(names(&live), chosen, "its live dsh's, the one it set the default");
    assert_eq!(lab.ws.dsh_catalog().await.unwrap()["models"], catalog["models"], "a new Agent's list");
    lab.ws.close_agent(ID).await.unwrap();
}

/// A message's images go to dsh as ACP image blocks after its text (§3.9),
/// shown as Codex's are; a dsh whose initialize says it takes none is sent
/// none, and nothing is recorded.
#[cfg(unix)]
#[tokio::test]
async fn images_go_as_acp_image_blocks_to_a_dsh_that_takes_them() {
    let lab = Lab::new();
    let saved = lab.root.join("data/input-images").join(ID);
    std::fs::create_dir_all(&saved).unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(4, 3).write_to(&mut png, image::ImageFormat::Png).unwrap();
    let png = png.into_inner();
    let picture = format!("{}.png", sha256_bytes(&png));
    std::fs::write(saved.join(&picture), &png).unwrap();
    let with = |client: &str| serde_json::from_value::<crate::model::MessageInput>(json!({"clientMessageId": client, "text": "look", "images": [picture]})).unwrap();

    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    let turn = lab.ws.send_message(ID, with("c1")).await.unwrap().turn_id.unwrap();
    let ended = lab.turn_ended(&turn).await;
    assert_eq!(ended["status"], "completed");
    let prompt = lab.log(ID).into_iter().find(|r| r["kind"] == "prompt").unwrap();
    assert_eq!(prompt["blocks"][0]["type"], "text");
    assert_eq!((&prompt["blocks"][1]["type"], &prompt["blocks"][1]["mimeType"]), (&json!("image"), &json!("image/png")));
    assert!(prompt["blocks"][1]["bytes"].as_u64().unwrap() > 0);
    let shown = &item(&ended, "userMessage")[0]["content"];
    assert_eq!(shown[1], json!({"type": "localImage", "path": saved.canonicalize().unwrap().join(&picture)}));
    lab.ws.close_agent(ID).await.unwrap();

    const OTHER: &str = "dsh-blind";
    let lab = Lab::new();
    let saved = lab.root.join("data/input-images").join(OTHER);
    std::fs::create_dir_all(&saved).unwrap();
    std::fs::write(saved.join(&picture), &png).unwrap();
    lab.agent(OTHER, Some("ask"), Some("deepseek"), json!({"initialize": {"agentCapabilities": {"promptCapabilities": {"image": false}}}}), json!({}));
    let refused = lab.ws.send_message(OTHER, with("c1")).await.unwrap_err();
    assert!(refused.to_string().contains("不接收图片"), "{refused}");
    assert!(!lab.log(OTHER).iter().any(|r| r["kind"] == "prompt"), "nothing was sent");
    let d = lab.ws.store.detail(OTHER).unwrap();
    assert!(d.turns.is_empty() && d.message_receipts.is_empty(), "no Turn or receipt was recorded");
    lab.ws.close_agent(OTHER).await.unwrap();
}

/// YN-173: a hand-off from Home to a running dsh whose initialize said it
/// takes no images is refused them as images (`ImagesRefused`), before any
/// is copied, so the hand-off goes on without them, saying why; a dsh that
/// takes images is given its own copy.
#[cfg(unix)]
#[tokio::test]
async fn a_hand_off_to_a_dsh_that_takes_no_images_is_refused_them_as_images() {
    let lab = Lab::new();
    let project = "synthetic-project";
    let home = crate::input_images::home_dir(&lab.root.join("data"), project).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(4, 3).write_to(&mut png, image::ImageFormat::Png).unwrap();
    let png = png.into_inner();
    let picture = format!("{}.png", sha256_bytes(&png));
    std::fs::write(home.join(&picture), &png).unwrap();
    std::fs::write(home.join(format!("{picture}.thumb.png")), &png).unwrap();
    const BLIND: &str = "dsh-blind";
    lab.agent(BLIND, Some("ask"), Some("deepseek"), json!({"initialize": {"agentCapabilities": {"promptCapabilities": {"image": false}}}}), json!({}));
    lab.ws.dsh_ensure(BLIND).await.unwrap();
    assert_eq!(lab.ws.dsh_takes_images(BLIND), Some(false));
    let refused = crate::project_requests::adopt_images(&lab.ws, project, BLIND, std::slice::from_ref(&picture)).await.unwrap_err();
    assert_eq!(crate::project_requests::images_refused(&refused), Some("dsh can't receive images"), "{refused}");
    assert!(!lab.root.join("data/input-images").join(BLIND).exists(), "nothing copied");
    lab.ws.close_agent(BLIND).await.unwrap();
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    lab.ws.dsh_ensure(ID).await.unwrap();
    assert_eq!(lab.ws.dsh_takes_images(ID), Some(true));
    crate::project_requests::adopt_images(&lab.ws, project, ID, std::slice::from_ref(&picture)).await.unwrap();
    assert!(lab.root.join("data/input-images").join(ID).join(&picture).is_file(), "its own copy");
    lab.ws.close_agent(ID).await.unwrap();
}

/// The user's disconnect (§3.8): only while idle; its dsh stopped, nothing
/// starts it again until they reconnect, and that resumes the session.
#[cfg(unix)]
#[tokio::test]
async fn an_idle_dsh_agent_can_be_disconnected_and_reconnected() {
    let lab = Lab::new();
    lab.agent(ID, Some("ask"), Some("deepseek"), json!({}), json!({}));
    let running = lab.send("c1", "SLEEP").await.unwrap().turn_id.unwrap();
    let refused = lab.ws.disconnect_agent(ID).await.unwrap_err();
    assert!(refused.to_string().contains("Not disconnected"), "{refused}");
    lab.ws.interrupt(ID).await.unwrap();
    lab.turn_ended(&running).await;
    let agent = lab.ws.disconnect_agent(ID).await.unwrap();
    assert!(agent.disconnected_at.is_some());
    assert!(lab.ws.dshs.lock().unwrap().get(ID).is_none());
    assert!(lab.log(ID).iter().any(|r| r["kind"] == "stdinEnded"), "its dsh stopped");
    let refused = lab.send("c2", "hello").await.unwrap_err();
    assert!(refused.to_string().contains("Reconnect"), "{refused}");
    assert_eq!(lab.acp_runs(ID).len(), 1, "nothing started it again");
    let d = lab.ws.reconnect(ID).await.unwrap();
    assert_eq!(d.agent.connection_state, "connected");
    assert!(lab.log(ID).iter().any(|r| r["kind"] == "resumed" && r["sessionId"] == "ses-1"));
    lab.ws.close_agent(ID).await.unwrap();
}

#[cfg(unix)]
fn sha256_bytes(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
