//! Starting one executor with its routing account or key (YN-34 S1c),
//! against stand-ins: the OpenCode fixture server, a stub `node` in place of
//! the Claude bridge that records its environment, and a stub `cswap`. The
//! routed Agent's process gets its key; a sibling Agent's does not, and
//! neither does Core's own environment, which Jobs, review runs and catalog
//! reads start from. Synthetic values only.
use super::*;
use crate::{model::AgentDetail, routing_keys::Store as KeyStore};
use serde_json::{json, Value};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, time::Duration};

const KEY: &str = "sk-test-yn34-launch-0123456789";
const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/opencode_server.py");

fn agent(id: &str, harness: &str, cwd: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":id, "name":id, "cwd":cwd, "model":"", "color":"sage", "harness":harness,
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

fn script(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn python3() -> Option<std::path::PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).map(|dir| dir.join("python3")).find(|p| p.is_file())
}

/// The same stand-in program opencode_agent_tests uses: YUZUNO_OPENCODE_BIN is the process's.
fn opencode_program() {
    static PROGRAM: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    PROGRAM.get_or_init(|| {
        let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        let program = dir.path().join("opencode");
        script(&program, &format!("#!/bin/sh\nexec /usr/bin/python3 {FIXTURE} \"$@\"\n"));
        std::env::set_var("YUZUNO_OPENCODE_BIN", &program);
        program
    });
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn only_the_routed_opencode_server_gets_its_key() {
    opencode_program();
    let before: Vec<_> = std::env::vars_os().collect();
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().into_owned();
    let ws = Workspace::new(dir.path().join("data"), cwd.clone(), "unused".into()).unwrap();
    for id in ["oc-a", "oc-b"] {
        ws.store.insert(&agent(id, "opencode", &cwd)).unwrap();
    }
    KeyStore::of(&ws.data_dir).put_local("deepseek", Provider::Deepseek, Secret::new(KEY.into())).unwrap();
    ws.store.set_runtime_profile("oc-a", Some(&RuntimeProfile::ApiKey { key_id: "deepseek".into() })).unwrap();
    ws.reconnect("oc-a").await.unwrap();
    ws.reconnect("oc-b").await.unwrap();
    let seen = |id: &str| -> Value {
        serde_json::from_str(&fs::read_to_string(ws.data_dir.join("opencode").join(id).join("start.json")).unwrap()).unwrap()
    };
    assert_eq!(seen("oc-a")["routingKeys"]["DEEPSEEK_API_KEY"], KEY, "the routed Agent's server has its key");
    assert!(seen("oc-b")["routingKeys"]["DEEPSEEK_API_KEY"].is_null(), "a sibling Agent's server does not");
    let after: Vec<_> = std::env::vars_os().collect();
    assert_eq!(before, after, "nor Core's own environment, which Jobs, review runs and catalog reads start from");
    for id in ["oc-a", "oc-b"] {
        ws.close_agent(id).await.unwrap();
    }
}

/// A stub `node`: each bridge it is asked to run writes its environment to a
/// file of its own and stays up until it is dropped.
fn stub_bridge(dir: &Path) {
    script(&dir.join("node"), &format!("#!/bin/sh\nenv | sort > \"$(mktemp -p '{}' bridge.XXXXXX)\"\nexec sleep 30\n", dir.join("seen").display()));
    fs::create_dir(dir.join("seen")).unwrap();
    fs::create_dir_all(dir.join("runtime")).unwrap();
    script(&dir.join("runtime").join("bridge.mjs"), "// stand-in\n");
    std::env::set_var("YUZUNO_NODE", dir.join("node"));
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", dir.join("runtime").join("bridge.mjs"));
}

async fn next_seen(dir: &Path, count: usize) -> String {
    for _ in 0..200 {
        let mut files: Vec<_> = fs::read_dir(dir.join("seen")).unwrap().map(|e| e.unwrap().path()).collect();
        files.sort_by_key(|p| fs::metadata(p).unwrap().modified().unwrap());
        if files.len() >= count {
            let text = fs::read_to_string(&files[count - 1]).unwrap();
            if !text.is_empty() {
                return text;
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("bridge {count} did not start");
}

#[tokio::test]
async fn only_the_routed_claude_bridge_gets_its_key_and_its_tools_are_told_to_drop_it() {
    let _env = crate::claude::BRIDGE_ENV.lock().await;
    let before: Vec<_> = std::env::vars_os().filter(|(n, _)| n != "YUZUNO_NODE" && n != "YUZUNO_CLAUDE_BRIDGE").collect();
    let dir = tempfile::tempdir().unwrap();
    stub_bridge(dir.path());
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    for id in ["cl-a", "cl-b"] {
        ws.store.insert(&agent(id, "claude", "/tmp")).unwrap();
    }
    KeyStore::of(&ws.data_dir).put_local("anthropic", Provider::Anthropic, Secret::new(KEY.into())).unwrap();
    ws.store.set_runtime_profile("cl-a", Some(&RuntimeProfile::ApiKey { key_id: "anthropic".into() })).unwrap();

    let launch = ws.claude_launch("cl-a").await.unwrap();
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    let routed = crate::claude::Bridge::spawn_with(tx, &launch.env).await.unwrap();
    let env = next_seen(dir.path(), 1).await;
    assert!(env.contains(&format!("ANTHROPIC_API_KEY={KEY}")), "the routed Agent's bridge has its key");
    assert!(env.contains("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1"), "and Claude Code is told to keep it from its tools");

    let sibling = ws.claude_launch("cl-b").await.unwrap();
    assert!(sibling.env.is_empty() && sibling.executable.is_none(), "no profile, nothing added");
    let (tx, _rx2) = tokio::sync::mpsc::channel(8);
    let other = crate::claude::Bridge::spawn_with(tx, &sibling.env).await.unwrap();
    let env = next_seen(dir.path(), 2).await;
    assert!(!env.contains(KEY) && !env.contains("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"), "a sibling Agent's bridge has neither");

    let after: Vec<_> = std::env::vars_os().filter(|(n, _)| n != "YUZUNO_NODE" && n != "YUZUNO_CLAUDE_BRIDGE").collect();
    assert_eq!(before, after, "Core's own environment is as it was");
    // A key of another provider is refused for a Claude executor; a missing one says so.
    KeyStore::of(&ws.data_dir).put_local("deepseek", Provider::Deepseek, Secret::new(KEY.into())).unwrap();
    ws.store.set_runtime_profile("cl-b", Some(&RuntimeProfile::ApiKey { key_id: "deepseek".into() })).unwrap();
    let error = format!("{:#}", ws.claude_launch("cl-b").await.unwrap_err());
    assert!(error.contains("not an Anthropic key") && !error.contains(KEY), "{error}");
    ws.store.set_runtime_profile("cl-b", Some(&RuntimeProfile::ApiKey { key_id: "gone".into() })).unwrap();
    assert!(format!("{:#}", ws.claude_launch("cl-b").await.unwrap_err()).contains("Routing key gone is not set"));
    drop((routed, other));
    std::env::remove_var("YUZUNO_NODE");
    std::env::remove_var("YUZUNO_CLAUDE_BRIDGE");
}

#[tokio::test]
async fn a_claude_swap_binding_resolves_at_each_start_and_never_to_another_account() {
    let Some(python) = python3() else {
        eprintln!("skipped: no python3 on PATH");
        return;
    };
    let _env = crate::claude::BRIDGE_ENV.lock().await;
    let dir = tempfile::tempdir().unwrap();
    stub_bridge(dir.path());
    script(&dir.path().join("runtime").join("cswap-claude"), "#!/bin/sh\n");
    let list = |active: u32, team_org: &str| format!(r#"{{"schemaVersion":1,"activeAccountNumber":{active},"accounts":[
        {{"number":1,"email":"person@example.com","organizationUuid":null,"active":{a1}}},
        {{"number":2,"email":"person@example.com","organizationUuid":"{team_org}","active":{a2}}}]}}"#,
        a1 = active == 1, a2 = active == 2);
    let cswap = dir.path().join("cswap");
    let set_list = |text: String| script(&cswap, &format!("#!{}\nprint({:?})\n", python.display(), text));
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    ws.store.insert(&agent("cl", "claude", "/tmp")).unwrap();
    ws.store.save_cswap_settings(&routing_accounts::CswapSettings { command: cswap.display().to_string() }).unwrap();
    let team = routing_accounts::fingerprint("person@example.com", Some("org-1"));
    ws.store.set_runtime_profile("cl", Some(&RuntimeProfile::ClaudeAccount { fingerprint: team })).unwrap();

    set_list(list(1, "org-1"));
    let launch = ws.claude_launch("cl").await.unwrap();
    assert_eq!(launch.env.iter().map(|(n, v)| (n.as_str(), v.expose().to_string())).collect::<Vec<_>>(),
        [("YUZUNO_CSWAP_PYTHON", python.display().to_string()), ("YUZUNO_CSWAP_ACCOUNT", "2".to_string())]);
    assert_eq!(launch.executable.as_deref(), Some(dir.path().join("runtime").join("cswap-claude").as_path()));
    // The same account is now the host's default login: the plain host login, not cswap run.
    set_list(list(2, "org-1"));
    let launch = ws.claude_launch("cl").await.unwrap();
    assert!(launch.env.is_empty() && launch.executable.is_none());
    // No longer listed: it does not start, and never as account 1.
    set_list(list(1, "org-2"));
    let error = format!("{:#}", ws.claude_launch("cl").await.unwrap_err());
    assert!(error.contains("no longer listed") && error.contains("never as another account"), "{error}");
    std::env::remove_var("YUZUNO_NODE");
    std::env::remove_var("YUZUNO_CLAUDE_BRIDGE");
}

#[tokio::test]
async fn a_profile_is_kept_apart_from_the_agent_and_refused_on_another_machine() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    ws.store.insert(&agent("x", "claude", "/tmp")).unwrap();
    assert_eq!(ws.store.runtime_profile("x").unwrap(), None);
    ws.refuse_remote_profile("x").await.unwrap();
    let profile = RuntimeProfile::ApiKey { key_id: "anthropic".into() };
    ws.store.set_runtime_profile("x", Some(&profile)).unwrap();
    assert_eq!(ws.store.runtime_profile("x").unwrap(), Some(profile));
    assert!(format!("{:#}", ws.refuse_remote_profile("x").await.unwrap_err()).contains("this Core host only"));
    // The Agent's own record never holds it, so an older Core's rewrite cannot drop it.
    assert!(!serde_json::to_string(&ws.store.detail("x").unwrap().agent).unwrap().contains("anthropic"));
    ws.store.set_runtime_profile("x", None).unwrap();
    assert_eq!(ws.store.runtime_profile("x").unwrap(), None);
}

/// A stub `codex app-server --stdio`: it records its arguments, three of its
/// environment variables and every request it gets, in a file of its own,
/// and answers each request (a thread for thread/start and thread/resume).
fn stub_codex(dir: &Path, python: &Path) -> std::path::PathBuf {
    let runs = dir.join("runs");
    fs::create_dir_all(&runs).unwrap();
    let source = r#"#!@PY@
import json, os, sys
D = "@D@"
rec = {"argv": sys.argv[1:], "env": {k: os.environ.get(k) for k in ("CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY")}, "requests": []}
path = os.path.join(D, "run.%d.json" % os.getpid())
def save():
    with open(path + ".tmp", "w") as f:
        json.dump(rec, f)
    os.replace(path + ".tmp", path)
save()
for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    m = msg.get("method")
    if m:
        rec["requests"].append({"method": m, "params": msg.get("params")})
        save()
    if m and "id" in msg:
        thread = {"id": "t-1", "turns": [], "status": {"type": "idle"}, "preview": "", "cwd": "/tmp"}
        if m == "account/login/start":
            result = {"type": "apiKey"}
        elif m in ("thread/start", "thread/resume"):
            result = {"thread": thread}
        else:
            result = {}
        print(json.dumps({"id": msg["id"], "result": result}), flush=True)
"#;
    let path = dir.join("codex");
    script(&path, &source.replace("@PY@", &python.display().to_string()).replace("@D@", &runs.display().to_string()));
    path
}

fn runs(dir: &Path) -> Vec<Value> {
    fs::read_dir(dir.join("runs")).unwrap().map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()).collect()
}

#[tokio::test]
async fn only_the_routed_codex_app_server_gets_its_home_or_its_key_login() {
    let Some(python) = python3() else {
        eprintln!("skipped: no python3 on PATH");
        return;
    };
    let before: Vec<_> = std::env::vars_os().collect();
    let dir = tempfile::tempdir().unwrap();
    let program = stub_codex(dir.path(), &python);
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), program.display().to_string()).unwrap();
    for id in ["cx-home", "cx-key", "cx-none"] {
        ws.store.insert(&agent(id, "codex", "/tmp")).unwrap();
    }
    let home = dir.path().join("work-home");
    fs::create_dir(&home).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    let home_text = home.display().to_string();
    ws.store.save_codex_homes(&[routing_accounts::CodexHome { id: "work".into(), label: "Work".into(), home: home_text.clone() }]).unwrap();
    KeyStore::of(&ws.data_dir).put_local("openai", Provider::Openai, Secret::new(KEY.into())).unwrap();
    ws.store.set_runtime_profile("cx-home", Some(&RuntimeProfile::CodexHome { id: "work".into() })).unwrap();
    ws.store.set_runtime_profile("cx-key", Some(&RuntimeProfile::ApiKey { key_id: "openai".into() })).unwrap();
    for id in ["cx-home", "cx-key", "cx-none"] {
        ws.ensure(id).await.unwrap();
    }
    let runs = runs(dir.path());
    let api_home = ws.data_dir.join("codex-api-home").display().to_string();
    let logins = |run: &Value| run["requests"].as_array().unwrap().iter().filter(|r| r["method"] == "account/login/start").count();

    let home_run = runs.iter().find(|r| r["env"]["CODEX_HOME"] == home_text.as_str());
    assert!(home_run.is_some(), "the routed Codex home's app-server runs in that home: {runs:?}");
    assert_eq!(logins(home_run.unwrap()), 0, "a home's own login is used");

    let key_run = runs.iter().find(|r| r["env"]["CODEX_HOME"] == api_home.as_str());
    assert!(key_run.is_some(), "the routed key's app-server runs in Core's own Codex home: {runs:?}");
    let key_run = key_run.unwrap();
    assert!(key_run["requests"].as_array().unwrap().iter().any(|r| r["method"] == "account/login/start"
        && r["params"] == json!({"type": "apiKey", "apiKey": KEY})), "the key is logged in over the connection: {key_run}");
    let argv: Vec<&str> = key_run["argv"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(argv.windows(2).any(|w| w == ["-c", "cli_auth_credentials_store=\"ephemeral\""]), "its credentials stay ephemeral: {argv:?}");
    assert!(key_run["env"]["CODEX_API_KEY"].as_str() != Some(KEY) && key_run["env"]["OPENAI_API_KEY"].as_str() != Some(KEY), "and the key is in no environment");
    assert_eq!(fs::metadata(&api_home).unwrap().permissions().mode() & 0o777, 0o700);

    // Every other app-server (the plain Agent's, and any catalog read) sees neither.
    for run in runs.iter().filter(|r| r["env"]["CODEX_HOME"] != home_text.as_str() && r["env"]["CODEX_HOME"] != api_home.as_str()) {
        assert!(!run.to_string().contains(KEY) && logins(run) == 0, "a sibling's app-server has no key: {run}");
        assert_eq!(run["env"]["CODEX_HOME"].as_str().map(str::to_owned), std::env::var("CODEX_HOME").ok(), "and Core's own CODEX_HOME, as before");
    }
    let after: Vec<_> = std::env::vars_os().collect();
    assert_eq!(before, after, "Core's own environment is as it was");
    // A home no longer listed refuses, never another home.
    ws.store.save_codex_homes(&[]).unwrap();
    let error = format!("{:#}", ws.codex_launch("cx-home").await.unwrap_err());
    assert!(error.contains("no longer listed") && error.contains("never in another home"), "{error}");
    for id in ["cx-home", "cx-key", "cx-none"] {
        let _ = ws.close_agent(id).await;
    }
}

#[test]
fn an_opencode_model_is_named_provider_slash_model() {
    for good in ["deepseek/deepseek-flash", "openrouter/anthropic/claude-x"] {
        crate::opencode_agent::check_model_id(good).unwrap();
    }
    for bad in ["", "deepseek", "/flash", "deepseek/", "deep seek/flash"] {
        assert!(crate::opencode_agent::check_model_id(bad).is_err(), "{bad:?}");
    }
}

#[tokio::test]
async fn a_profiled_executor_is_not_forked_onto_another_account() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    ws.store.insert(&agent("cx", "codex", "/tmp")).unwrap();
    ws.store.insert(&agent("oc", "opencode", "/tmp")).unwrap();
    for id in ["cx", "oc"] {
        ws.store.set_runtime_profile(id, Some(&RuntimeProfile::ApiKey { key_id: "k".into() })).unwrap();
    }
    let refused = |e: anyhow::Error| {
        let text = format!("{e:#}");
        assert!(text.contains("a fork of it would start on another: it cannot be forked"), "{text}");
    };
    refused(ws.preview_codex_fork("cx").await.unwrap_err());
    let fork = serde_json::from_value(json!({"requestId": uuid::Uuid::new_v4().to_string(), "throughTurnId": "t", "name": "f"})).unwrap();
    refused(ws.fork_codex_session("cx", fork).await.map(|_| ()).unwrap_err());
    refused(ws.opencode_fork_preview("oc", "t").await.unwrap_err());
    let fork = serde_json::from_value(json!({"requestId": uuid::Uuid::new_v4().to_string(), "turnId": "t", "name": "f"})).unwrap();
    refused(ws.opencode_fork("oc", fork).await.unwrap_err());
}
