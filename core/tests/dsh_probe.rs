//! A lab probe of a real dsh through the Workspace (YN-119 S2a, design v1
//! §6), ignored unless asked for: `YUZUNO_DSH_BIN` names a dsh installed for
//! the probe only, and whoever runs it gives it a synthetic HOME. The model is
//! tests/fixtures/stub_anthropic.py on loopback (`YUZUNO_DSH_BASE_URL`), the
//! key a placeholder: no real model, no request leaves the host. One Agent,
//! through Core's own paths: made as POST /api/agents makes it, a Turn, an
//! interrupt, Core starting again and resuming its session, a close and a
//! delete. And (S2b) the Workspace MCP Core serves, reached by dsh with the
//! Agent's credential, and a request past dsh's sandbox the user allows once
//! and then declines, and whether dsh keeps the Workspace MCP's credential
//! on disk. And (S2b-2) its models, listed by a dsh of Core's
//! own and by the Agent's, a model, effort and level set, and an image sent.
//! Run as opencode_probe.rs is:
//! `cargo test --test dsh_probe -- --ignored --test-threads=1 --nocapture`.
#![cfg(target_os = "linux")]

use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, process::Stdio, sync::Arc, time::Duration};
use yuzuno_workspace::{model::{AgentDetail, MessageInput}, routing_keys, routing_launch::RuntimeProfile, store::whole::WholeRecord, workspace::Workspace};

const STUB: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/stub_anthropic.py");

struct Model {
    child: std::process::Child,
    port: u16,
    log: PathBuf,
}

impl Model {
    fn start(dir: &Path) -> Self {
        let (port_file, log) = (dir.join("model.port"), dir.join("model.jsonl"));
        let child = std::process::Command::new("/usr/bin/python3").arg(STUB).arg(&port_file).arg(&log).arg("YUZUNO-PROBE-MARKER")
            .stdin(Stdio::null()).spawn().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let port = loop {
            if let Ok(port) = std::fs::read_to_string(&port_file) {
                break port.trim().parse().unwrap();
            }
            assert!(std::time::Instant::now() < deadline, "the stand-in model listens");
            std::thread::sleep(Duration::from_millis(20));
        };
        Self { child, port, log }
    }

    /// What each tool result the model was given said.
    fn results(&self) -> Vec<Value> {
        self.requests().into_iter().filter_map(|r| Some(r["toolResult"].clone()).filter(|t| t.is_object())).collect()
    }

    fn requests(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log).unwrap_or_default().lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()).filter(|r| r["kind"] == "post").collect()
    }
}

impl Drop for Model {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The Workspace on `data`, waiting for an earlier one's lock to be let go.
fn open(data: &Path, work: &Path) -> Arc<Workspace> {
    for _ in 0..250 {
        match Workspace::new(data.into(), work.to_string_lossy().into(), "unused".into()) {
            Ok(ws) => return ws,
            Err(error) if format!("{error:#}").contains("lock acquisition failed") => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => panic!("{error:#}"),
        }
    }
    panic!("the Workspace lock was not let go within 5 s");
}

async fn until(ws: &Workspace, id: &str, what: &str, secs: u64, check: impl Fn(&AgentDetail) -> bool) -> AgentDetail {
    for _ in 0..secs * 20 {
        let d = ws.store.detail(id).unwrap();
        if check(&d) {
            return d;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{what} within {secs} s: {}", serde_json::to_string(&ws.store.detail(id).unwrap()).unwrap());
}

fn turn<'a>(d: &'a AgentDetail, id: &str) -> &'a Value {
    d.turns.iter().find(|t| t["id"] == id).expect("the Turn")
}

fn types(turn: &Value) -> Vec<String> {
    turn["items"].as_array().unwrap().iter().map(|i| i["type"].as_str().unwrap_or_default().to_owned()).collect()
}

/// Processes whose environment names `home` as their DSH_HOME: a dsh of this Agent, or what it started.
fn holding(home: &Path) -> Vec<u32> {
    let wanted = format!("DSH_HOME={}", home.display());
    std::fs::read_dir("/proc").unwrap().filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .filter(|pid| std::fs::read(format!("/proc/{pid}/environ")).is_ok_and(|env| env.split(|b| *b == 0).any(|var| var == wanted.as_bytes())))
        .collect()
}

#[tokio::test]
#[ignore = "needs a real dsh, named by YUZUNO_DSH_BIN, python3, and no network"]
async fn a_real_dsh_agent_talks_stops_resumes_after_a_restart_and_goes() {
    assert!(std::env::var_os("YUZUNO_DSH_BIN").is_some(), "YUZUNO_DSH_BIN names the dsh to probe");
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let (data, work) = (root.join("data"), root.join("work"));
    std::fs::create_dir(&work).unwrap();
    let model = Model::start(&root);
    std::env::set_var("YUZUNO_DSH_BASE_URL", format!("http://127.0.0.1:{}/v1", model.port));
    let ws = open(&data, &work);
    routing_keys::Store::of(&data).put_local("deepseek", routing_keys::Provider::Deepseek,
        routing_keys::Secret::new("sk-placeholder-not-a-key".into())).unwrap();
    let send = |ws: &Arc<Workspace>, id: &str, client: &str, text: &str| {
        let (ws, id) = (ws.clone(), id.to_owned());
        let input = serde_json::from_value::<MessageInput>(json!({"clientMessageId": client, "text": text})).unwrap();
        async move { ws.send_message(&id, input).await.unwrap_or_else(|refused| panic!("refused: {refused:#}")) }
    };

    // 1. Made as POST /api/agents makes it, at Ask you first with the DeepSeek key; it starts by itself.
    let agent = ws.dsh_create_on("Probe".into(), work.to_string_lossy().into(), String::new(), None, None, None, None,
        Some("ask".into()), Some(RuntimeProfile::ApiKey { key_id: "deepseek".into() })).await.unwrap();
    let id = agent.id.clone();
    let d = until(&ws, &id, "connected", 60, |d| d.agent.connection_state == "connected" || d.agent.error.is_some()).await;
    assert_eq!(d.agent.connection_state, "connected", "{:?}", d.agent.error);
    let session = d.agent.dsh_session_id.clone().expect("its session");
    println!("probe: connected, dsh {:?}, session {session}", d.agent.dsh_version);
    let home = data.join("dsh").join(&id).join("home");
    let first = holding(&home);
    assert!(!first.is_empty(), "its dsh runs with its own DSH_HOME");

    // 2. A Turn: the stand-in's thinking and reply read into Items; the context dsh reports kept.
    let receipt = send(&ws, &id, "p1", "Say hello.").await;
    assert_eq!(receipt.status, "accepted");
    let hello = receipt.turn_id.unwrap();
    let d = until(&ws, &id, "the Turn ends", 60, |d| turn(d, &hello)["status"] != "inProgress").await;
    let t = turn(&d, &hello);
    println!("probe: turn 1 {} items {:?}, context {:?}", t["status"], types(t), d.context_usage.as_ref().map(|u| (u.used_tokens, u.window_tokens)));
    assert_eq!(t["status"], "completed");
    assert!(t["items"].as_array().unwrap().iter().any(|i| i["type"] == "agentMessage" && i["text"].as_str().unwrap_or_default().contains("stub-reply")));
    for request in model.requests() {
        assert_eq!((request["hasSessionLog"].as_bool(), request["hasPluginPackages"].as_bool()), (Some(false), Some(false)), "{request}");
        assert_eq!(request["apiKeyPresent"], true);
    }

    // 3. An interrupt while its command runs: dsh's `cancelled` ends the Turn.
    let sleeping = send(&ws, &id, "p2", "YUZUNO-SLEEP").await.turn_id.unwrap();
    let d = until(&ws, &id, "its command starts", 60, |d| types(turn(d, &sleeping)).iter().any(|t| t == "commandExecution")).await;
    println!("probe: the command as dsh started it: {}", turn(&d, &sleeping)["items"].as_array().unwrap().iter()
        .find(|i| i["type"] == "commandExecution").unwrap());
    ws.interrupt(&id).await.unwrap();
    let d = until(&ws, &id, "the interrupt ends the Turn", 15, |d| turn(d, &sleeping)["status"] != "inProgress").await;
    let t = turn(&d, &sleeping);
    println!("probe: turn 2 {} items {}", t["status"], t["items"]);
    assert_eq!(t["status"], "interrupted");

    // 4. Core starts again: a new dsh resumes the same session, and the next Turn carries what came before.
    let before = model.requests().last().unwrap()["messages"].as_u64().unwrap();
    ws.dsh_stop_all().await;
    assert!(holding(&home).is_empty(), "its dsh stopped with Core");
    let gone = (Arc::downgrade(&ws), Arc::downgrade(&ws.store));
    drop(ws);
    for _ in 0..500 {
        if gone.0.strong_count() == 0 && gone.1.strong_count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let ws = open(&data, &work);
    let d = ws.reconnect(&id).await.unwrap();
    assert_eq!((d.agent.connection_state.as_str(), d.agent.dsh_session_id.as_deref()), ("connected", Some(session.as_str())), "the same session");
    let again = send(&ws, &id, "p3", "Say hello again.").await.turn_id.unwrap();
    let d = until(&ws, &id, "the resumed Turn ends", 60, |d| turn(d, &again)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &again)["status"], "completed");
    let after = model.requests().last().unwrap()["messages"].as_u64().unwrap();
    println!("probe: resumed; the model got {after} messages, {before} before the restart");
    assert!(after > before, "the resumed session carries its history");

    // No Turn but those sent: what dsh says as a session opens makes none.
    let shown: Vec<String> = d.turns.iter().map(|t| t["id"].as_str().unwrap_or_default().to_owned()).collect();
    println!("probe: Turns {shown:?}");
    assert_eq!(shown, [hello.clone(), sleeping.clone(), again.clone()]);
    assert!(d.turns.iter().filter_map(|t| t["items"][0]["clientId"].as_str()).eq(["p1", "p2", "p3"]), "each bound to its receipt");

    // 5. Closed: dsh and what it started end. Deleted: its folder goes.
    ws.close_agent(&id).await.unwrap();
    assert!(holding(&home).is_empty(), "nothing of its dsh is left");
    ws.delete_agent(&id).await.unwrap();
    assert!(!data.join("dsh").join(&id).exists(), "its dsh folder went with it");
    println!("probe: closed and deleted; first dsh pids {first:?}");
}

#[tokio::test]
#[ignore = "needs a real dsh, named by YUZUNO_DSH_BIN, python3, and no network"]
async fn a_real_dsh_agent_reaches_the_workspace_mcp_and_asks_past_its_sandbox() {
    assert!(std::env::var_os("YUZUNO_DSH_BIN").is_some(), "YUZUNO_DSH_BIN names the dsh to probe");
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let (data, work, outside) = (root.join("data"), root.join("work"), root.join("outside"));
    std::fs::create_dir(&work).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let model = Model::start(&root);
    std::env::set_var("YUZUNO_DSH_BASE_URL", format!("http://127.0.0.1:{}/v1", model.port));
    let ws = open(&data, &work);
    routing_keys::Store::of(&data).put_local("deepseek", routing_keys::Provider::Deepseek,
        routing_keys::Secret::new("sk-placeholder-not-a-key".into())).unwrap();
    // The Workspace MCP as Core serves it, on loopback.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mcp = yuzuno_workspace::collaboration_mcp::router(ws.clone(), port);
    tokio::spawn(async move { axum::serve(listener, mcp).await.unwrap() });
    ws.start_collaboration(port);
    let project = ws.store.create_project("Probe", Default::default()).unwrap();
    let send = |ws: &Arc<Workspace>, id: &str, client: &str, text: &str| {
        let (ws, id) = (ws.clone(), id.to_owned());
        let input = serde_json::from_value::<MessageInput>(json!({"clientMessageId": client, "text": text})).unwrap();
        async move { ws.send_message(&id, input).await.unwrap_or_else(|refused| panic!("refused: {refused:#}")) }
    };
    let agent = ws.dsh_create_on("Probe".into(), work.to_string_lossy().into(), String::new(), None, None, Some(project.id.clone()), None,
        Some("ask".into()), Some(RuntimeProfile::ApiKey { key_id: "deepseek".into() })).await.unwrap();
    let id = agent.id.clone();
    let d = until(&ws, &id, "connected", 60, |d| d.agent.connection_state == "connected" || d.agent.error.is_some()).await;
    assert_eq!(d.agent.connection_state, "connected", "{:?}", d.agent.error);
    assert!(ws.collaboration_status(&id).await.is_some_and(|s| s.ready), "the Workspace MCP is ready");
    let notice = std::fs::read_to_string(data.join("dsh").join(&id).join("home/AGENTS.md")).unwrap();
    println!("probe: connected, dsh {:?}; AGENTS.md {} bytes", d.agent.dsh_version, notice.len());
    assert!(!notice.is_empty(), "the session notice");

    // 1. The Workspace MCP: dsh lists its tools with the Agent's credential, and brief_get answers.
    let asked = send(&ws, &id, "m1", "YUZUNO-MCP").await.turn_id.unwrap();
    let d = until(&ws, &id, "the MCP Turn ends", 60, |d| turn(d, &asked)["status"] != "inProgress").await;
    let t = turn(&d, &asked);
    println!("probe: MCP turn {} items {}", t["status"], t["items"]);
    assert_eq!(t["status"], "completed");
    let call = t["items"].as_array().unwrap().iter().find(|i| i["type"] == "mcpToolCall").expect("the MCP call");
    assert_eq!((&call["server"], &call["tool"], &call["status"]), (&json!("yuzuno"), &json!("brief_get"), &json!("completed")), "{call}");
    let answered = model.results().into_iter().find(|r| r["id"] == "call-mcp").expect("brief_get's answer reached the model");
    println!("probe: brief_get answered {answered}");
    assert_eq!(answered["isError"], false, "{answered}");
    assert!(answered["text"].as_str().unwrap_or_default().contains("version"), "{answered}");

    // 2. A request past dsh's sandbox at Ask you first: a card; allowed once, the command runs.
    for (client, decision, file, wrote) in [("m2", "accept", "allowed.txt", true), ("m3", "decline", "declined.txt", false)] {
        let path = outside.join(file);
        let running = send(&ws, &id, client, &format!("YUZUNO-OUTSIDE {}", path.display())).await.turn_id.unwrap();
        let d = until(&ws, &id, "the card", 60, |d| !d.pending.is_empty() || turn(d, &running)["status"] != "inProgress").await;
        assert_eq!(d.pending.len(), 1, "a card: {}", turn(&d, &running));
        let card = d.pending[0].clone();
        println!("probe: card {} {}", card.method, serde_json::to_string(&card.params).unwrap());
        assert_eq!((card.method.as_str(), d.agent.status.as_str()), ("dsh/permission", "waiting"));
        assert!(card.params["command"].as_str().unwrap_or_default().contains(file), "{}", card.params);
        assert_eq!(card.params["sandboxPermissions"], "danger-full-access");
        ws.respond(&card.id, json!({"decision": decision})).await.unwrap();
        let d = until(&ws, &id, "the Turn ends", 60, |d| turn(d, &running)["status"] != "inProgress").await;
        let t = turn(&d, &running);
        let command = t["items"].as_array().unwrap().iter().find(|i| i["type"] == "commandExecution").expect("the command");
        println!("probe: {decision}: turn {} command {}", t["status"], command);
        assert_eq!(t["status"], "completed");
        assert_eq!(command["permission"]["by"], "user");
        assert_eq!(path.exists(), wrote, "{decision}: {} {}", path.display(), if wrote { "written" } else { "not written" });
        assert!(d.pending.is_empty());
    }

    // 3. What dsh keeps on disk (the Lead's question on #988): every file of the Agent's dsh folder, after
    // a restart that resumed the session with the Workspace MCP named again and its close, searched for
    // the credential as written and inside dsh's zstd session files, with each file's mode.
    ws.dsh_stop_all().await;
    ws.reconnect(&id).await.unwrap();
    // Read before the close, which may end the credential.
    let config = ws.collaboration_http_config(&ws.store.agent(&id).unwrap()).await.unwrap().expect("the Workspace MCP");
    let token = config["headers"]["Authorization"].as_str().unwrap().trim_start_matches("Bearer ").to_owned();
    assert!(token.len() > 16);
    ws.close_agent(&id).await.unwrap();
    let folder = data.join("dsh").join(&id);
    let (files, holding) = kept_on_disk(&folder, &token);
    for (path, mode, bytes) in &files {
        println!("probe: on disk {:o} {bytes} {}", mode, path.strip_prefix(&folder).unwrap().display());
    }
    println!("probe: the credential on disk: {holding:?} (folder {:o}, home {:o})", mode_of(&folder), mode_of(&folder.join("home")));
    ws.delete_agent(&id).await.unwrap();
    assert!(!folder.exists(), "its dsh folder went with it");
    println!("probe: closed and deleted");
}

/// Each file under `dir`, its mode and size, and those holding `secret`: as
/// written, or once decompressed when it is zstd (dsh's sessions are
/// `session.v4.jsonl.zstd`, design §1), with zstd's own decoder.
fn kept_on_disk(dir: &Path, secret: &str) -> (Vec<(PathBuf, u32, u64)>, Vec<String>) {
    use std::os::unix::fs::PermissionsExt;
    let (mut files, mut holding, mut todo) = (Vec::new(), Vec::new(), vec![dir.to_path_buf()]);
    while let Some(at) = todo.pop() {
        for entry in std::fs::read_dir(&at).unwrap().flatten() {
            let (path, meta) = (entry.path(), entry.metadata().unwrap());
            if meta.is_dir() {
                todo.push(path);
                continue;
            }
            files.push((path.clone(), meta.permissions().mode() & 0o7777, meta.len()));
            let raw = std::fs::read(&path).unwrap_or_default();
            let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).contains(secret);
            let unpacked = path.extension().is_some_and(|e| e == "zstd" || e == "zst")
                .then(|| std::process::Command::new("zstd").args(["-dc", "--"]).arg(&path).output().ok())
                .flatten().filter(|out| out.status.success()).map(|out| out.stdout);
            if text(&raw) || unpacked.as_deref().is_some_and(text) {
                holding.push(path.strip_prefix(dir).unwrap().display().to_string());
            }
            // That the search read what dsh wrote: the session's own words are in it once unpacked.
            if let Some(unpacked) = &unpacked {
                println!("probe: unpacked {} to {} bytes, holding this session's prompt: {}", path.strip_prefix(dir).unwrap().display(),
                    unpacked.len(), String::from_utf8_lossy(unpacked).contains("YUZUNO-MCP"));
            }
        }
    }
    files.sort();
    (files, holding)
}

fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).map_or(0, |m| m.permissions().mode() & 0o7777)
}

#[tokio::test]
#[ignore = "needs a real dsh, named by YUZUNO_DSH_BIN, python3, and no network"]
async fn a_real_dsh_lists_its_models_takes_settings_and_an_image() {
    assert!(std::env::var_os("YUZUNO_DSH_BIN").is_some(), "YUZUNO_DSH_BIN names the dsh to probe");
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let (data, work) = (root.join("data"), root.join("work"));
    std::fs::create_dir(&work).unwrap();
    let model = Model::start(&root);
    std::env::set_var("YUZUNO_DSH_BASE_URL", format!("http://127.0.0.1:{}/v1", model.port));
    let ws = open(&data, &work);
    routing_keys::Store::of(&data).put_local("deepseek", routing_keys::Provider::Deepseek,
        routing_keys::Secret::new("sk-placeholder-not-a-key".into())).unwrap();
    let names = |listed: &Value| -> Vec<String> { listed["models"].as_array().unwrap().iter().map(|m| m["model"].as_str().unwrap().to_owned()).collect() };

    // 1. A new Agent's list: a dsh of Core's own, its folder gone after.
    let catalog = ws.dsh_catalog().await.unwrap();
    println!("probe: catalog {catalog}");
    let listed = names(&catalog);
    assert!(listed.contains(&"deepseek-flash".to_owned()) && listed.contains(&"deepseek-v4-pro".to_owned()), "{listed:?}");
    assert!(std::fs::read_dir(data.join("dsh-catalog")).unwrap().next().is_none(), "the catalog's folder is removed");

    let agent = ws.dsh_create_on("Probe".into(), work.to_string_lossy().into(), String::new(), None, None, None, None,
        Some("ask".into()), Some(RuntimeProfile::ApiKey { key_id: "deepseek".into() })).await.unwrap();
    let id = agent.id.clone();
    let d = until(&ws, &id, "connected", 60, |d| d.agent.connection_state == "connected" || d.agent.error.is_some()).await;
    assert_eq!(d.agent.connection_state, "connected", "{:?}", d.agent.error);
    let home = data.join("dsh").join(&id).join("home");
    let live = ws.dsh_agent_models(&id).await.unwrap();
    println!("probe: its dsh's models {live}");
    assert_eq!(names(&live), listed, "its own dsh lists the same");
    let send = |ws: &Arc<Workspace>, id: &str, client: &str, text: &str, images: Vec<String>| {
        let (ws, id) = (ws.clone(), id.to_owned());
        let input = serde_json::from_value::<MessageInput>(json!({"clientMessageId": client, "text": text, "images": images})).unwrap();
        async move { ws.send_message(&id, input).await.unwrap_or_else(|refused| panic!("refused: {refused:#}")) }
    };
    let ended = |ws: Arc<Workspace>, id: String, turn: String| async move {
        let d = until(&ws, &id, "the Turn ends", 60, |d| turn_status(d, &turn) != "inProgress").await;
        turn_status(&d, &turn)
    };

    // 2. A model and an effort, set on its live session: its next request asks for that model.
    ws.dsh_settings(&id, "deepseek-v4-pro".into(), Some(Some("low".into())), None).await.unwrap();
    let pro = send(&ws, &id, "s1", "Say hello.", vec![]).await.turn_id.unwrap();
    assert_eq!(ended(ws.clone(), id.clone(), pro).await, "completed");
    let asked = model.requests().last().unwrap()["model"].clone();
    println!("probe: after the model was set, the request asked for {asked}");
    assert!(asked.as_str().unwrap_or_default().contains("v4-pro"), "{asked}");

    // 3. A level: a new dsh in the new sandbox, the same session.
    let before = holding(&home);
    let session = ws.store.detail(&id).unwrap().agent.dsh_session_id.clone();
    ws.dsh_settings(&id, "deepseek-flash".into(), None, Some("full".into())).await.unwrap();
    let after = holding(&home);
    let d = ws.store.detail(&id).unwrap();
    println!("probe: level full: dsh pids {before:?} -> {after:?}, session {:?}", d.agent.dsh_session_id);
    assert!(!after.is_empty() && before.iter().all(|pid| !after.contains(pid)), "a new dsh");
    assert_eq!((d.agent.connection_state.as_str(), &d.agent.dsh_session_id), ("connected", &session), "resumed");
    let flash = send(&ws, &id, "s2", "Say hello again.", vec![]).await.turn_id.unwrap();
    assert_eq!(ended(ws.clone(), id.clone(), flash).await, "completed");

    // 4. An image, as dsh's model takes it: uploaded first, then named in the request.
    let saved = data.join("input-images").join(&id);
    std::fs::create_dir_all(&saved).unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(8, 6).write_to(&mut png, image::ImageFormat::Png).unwrap();
    let png = png.into_inner();
    use sha2::Digest;
    let picture = format!("{}.png", sha2::Sha256::digest(&png).iter().map(|b| format!("{b:02x}")).collect::<String>());
    std::fs::write(saved.join(&picture), &png).unwrap();
    let looked = send(&ws, &id, "s3", "What is in this image?", vec![picture]).await.turn_id.unwrap();
    let status = ended(ws.clone(), id.clone(), looked.clone()).await;
    let d = ws.store.detail(&id).unwrap();
    let last = model.requests().last().unwrap().clone();
    let uploads: Vec<Value> = std::fs::read_to_string(&model.log).unwrap().lines().map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|r| r["kind"] == "upload").collect();
    println!("probe: image turn {status}: {}; uploads {uploads:?}; last request images {} files {}",
        d.turns.iter().find(|t| t["id"] == looked.as_str()).unwrap()["items"], last["imageBlocks"], last["fileRefs"]);
    assert_eq!(status, "completed");
    assert!(last["imageBlocks"].as_u64().unwrap_or(0) + last["fileRefs"].as_u64().unwrap_or(0) > 0, "the image reached the model: {last}");

    ws.close_agent(&id).await.unwrap();
    ws.delete_agent(&id).await.unwrap();
    println!("probe: closed and deleted");
}

fn turn_status(d: &AgentDetail, id: &str) -> String {
    d.turns.iter().find(|t| t["id"] == id).map_or_else(String::new, |t| t["status"].as_str().unwrap_or_default().to_owned())
}
