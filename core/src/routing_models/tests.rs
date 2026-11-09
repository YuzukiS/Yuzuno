//! Executor routing's OpenCode catalog (YN-57 S2a) against the stand-in
//! `opencode serve` (tests/fixtures/opencode_server.py): what it is started
//! with, what it lists, and that it ends and leaves nothing behind however a
//! read ends. Synthetic values only; no OpenCode, key or provider is used.
use super::*;
use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}};
use std::{fs, os::unix::fs::PermissionsExt};
use tower::ServiceExt;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/opencode_server.py");

fn script(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// The stand-in as a program of its own.
fn program(dir: &Path) -> PathBuf {
    let program = dir.join("opencode");
    script(&program, &format!("#!/bin/sh\nexec /usr/bin/python3 {FIXTURE} \"$@\"\n"));
    program
}

/// The same stand-in for the process's YUZUNO_OPENCODE_BIN, as opencode_agent_tests sets it: a Workspace's reads start it.
fn process_program() {
    static PROGRAM: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    PROGRAM.get_or_init(|| {
        let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        let program = program(dir.path());
        std::env::set_var("YUZUNO_OPENCODE_BIN", &program);
        program
    });
}

/// What the stand-in lists for a new database: OpenCode's own provider, which
/// needs no login, and two that need a key variable, as 2.2.5 lists them.
fn plan(catalogs: &Path, report: &Path, switches: Value) {
    fs::create_dir_all(catalogs).unwrap();
    let model = |name: &str| json!({"name": name, "limit": {"context": 128000, "output": 8000}});
    fs::write(catalogs.join("fixture-new.json"), json!({
        "reportTo": report,
        "switches": switches,
        "providers": {"providers": [
            {"id": "opencode", "name": "OpenCode", "models": {"big-pickle": model("Big Pickle")}},
            {"id": "deepseek", "name": "DeepSeek", "needsEnv": "DEEPSEEK_API_KEY",
             "models": {"deepseek-flash": model("DeepSeek Flash"), "deepseek-v4-pro": model("DeepSeek V4 Pro")}},
            {"id": "anthropic", "name": "Anthropic", "needsEnv": "ANTHROPIC_API_KEY", "models": {"claude-x": model("Claude X")}},
        ], "default": {}},
    }).to_string()).unwrap();
}

fn run(dir: &Path, limit: Duration) -> Run {
    let work = dir.join("work");
    fs::create_dir_all(&work).unwrap();
    Run { program: program(dir), directory: work, catalogs: dir.join("catalogs"), cache: dir.join("cache"), limit, present: |_| false }
}

/// What each start of the stand-in saw, in order.
fn starts(report: &Path) -> Vec<Value> {
    fs::read_to_string(report).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

/// A process that has ended: gone, or a zombie no one has reaped yet.
fn ended(pid: i64) -> bool {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat.rsplit(')').next().is_some_and(|rest| rest.trim_start().starts_with('Z')),
    }
}

async fn until(what: &str, check: impl Fn() -> bool) {
    for _ in 0..100 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

/// Nothing a read made is left: only the plan the test wrote beside them.
fn left(catalogs: &Path) -> Vec<String> {
    fs::read_dir(catalogs).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n != "fixture-new.json").collect()
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn it_lists_what_a_new_executor_would_with_a_placeholder_in_each_key_variable() {
    let dir = tempfile::tempdir().unwrap();
    let report = dir.path().join("starts.jsonl");
    let run = run(dir.path(), LIMIT);
    plan(&run.catalogs, &report, json!({}));
    // A folder a stopped read left behind is cleared first.
    fs::create_dir_all(run.catalogs.join("left-by-a-stop")).unwrap();
    let catalog = read(&run).await.unwrap();

    let ids: Vec<&str> = catalog["models"].as_array().unwrap().iter().map(|m| m["model"].as_str().unwrap()).collect();
    assert_eq!(ids, ["anthropic/claude-x", "deepseek/deepseek-flash", "deepseek/deepseek-v4-pro", "opencode/big-pickle"], "every provider a key would reach");
    let providers: HashMap<&str, &Value> = catalog["providers"].as_array().unwrap().iter().map(|p| (p["id"].as_str().unwrap(), p)).collect();
    assert_eq!(providers["deepseek"]["source"], "routingKey");
    assert_eq!(providers["deepseek"]["keyProvider"], "deepseek");
    assert_eq!(providers["anthropic"]["source"], "routingKey");
    assert_eq!(providers["opencode"]["source"], "ready", "its own needs nothing");
    assert!(providers["opencode"].get("keyProvider").is_none());
    assert_eq!(catalog["opencode"]["verified"], crate::opencode::VERIFIED);
    assert_eq!(catalog["models"][1]["providerName"], "DeepSeek", "YN-47's shape");

    let seen = starts(&report);
    assert_eq!(seen.len(), 1, "one start");
    let start = &seen[0];
    assert_eq!(start["routingKeys"], json!({"DEEPSEEK_API_KEY": PLACEHOLDER, "ANTHROPIC_API_KEY": PLACEHOLDER, "OPENAI_API_KEY": PLACEHOLDER}),
        "a placeholder in every key variable, nothing else");
    assert_eq!(start["env"]["OPENCODE_DISABLE_MODELS_FETCH"], "1", "it fetches no catalog of its own");
    assert_eq!(start["cwd"], run.directory.to_str().unwrap());
    let database = PathBuf::from(start["database"].as_str().unwrap());
    assert!(database.starts_with(&run.catalogs), "a throwaway database: {}", database.display());
    assert!(!database.exists(), "removed once read");
    assert_eq!(left(&run.catalogs), Vec::<String>::new(), "its folder, and the one a stop left, removed");
    until("its process group to end", || ended(start["pid"].as_i64().unwrap()) && ended(start["child"].as_i64().unwrap())).await;
    assert!(std::env::vars().all(|(_, value)| value != PLACEHOLDER), "Core's own environment never holds it");
}

#[test]
fn a_key_variable_cores_own_environment_has_stays_env() {
    let mut catalog = json!({"providers": [
        {"id": "deepseek", "name": "DeepSeek", "source": "env"},
        {"id": "anthropic", "name": "Anthropic", "source": "env"},
        {"id": "openai", "name": "OpenAI", "source": "ready"},
        {"id": "openrouter", "name": "OpenRouter", "source": "env"},
    ]});
    mark_key_providers(&mut catalog, |name| name == "DEEPSEEK_API_KEY");
    let source = |n: usize| (catalog["providers"][n]["source"].clone(), catalog["providers"][n].get("keyProvider").cloned());
    assert_eq!(source(0), (json!("env"), None), "every executor has Core's own variable");
    assert_eq!(source(1), (json!("routingKey"), Some(json!("anthropic"))), "only a routing key reaches it");
    assert_eq!(source(2), (json!("ready"), None), "reached through the user's config");
    assert_eq!(source(3), (json!("env"), None), "not a provider routing gives a key to");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_read_past_its_limit_ends_its_opencode_and_removes_its_folder() {
    let dir = tempfile::tempdir().unwrap();
    let report = dir.path().join("starts.jsonl");
    let run = run(dir.path(), Duration::from_secs(2));
    plan(&run.catalogs, &report, json!({"hangBeforeListening": 60}));
    let error = read(&run).await.unwrap_err();
    assert_eq!(format!("{error:#}"), "OpenCode did not list its models within 2 s");
    let seen = starts(&report);
    assert_eq!(seen.len(), 1);
    until("its process group to end", || ended(seen[0]["pid"].as_i64().unwrap()) && ended(seen[0]["child"].as_i64().unwrap())).await;
    assert_eq!(left(&run.catalogs), Vec::<String>::new(), "its folder removed");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_failed_start_removes_its_folder() {
    let dir = tempfile::tempdir().unwrap();
    let report = dir.path().join("starts.jsonl");
    let run = run(dir.path(), LIMIT);
    plan(&run.catalogs, &report, json!({"exit": 1, "exitStderr": "Error: not a real OpenCode"}));
    let error = format!("{:#}", read(&run).await.unwrap_err());
    assert!(error.contains("OpenCode exited before it was listening"), "{error}");
    assert_eq!(starts(&report).len(), 1);
    assert_eq!(left(&run.catalogs), Vec::<String>::new(), "its folder removed");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_read_whose_request_goes_away_ends_its_opencode_and_removes_its_folder() {
    let dir = tempfile::tempdir().unwrap();
    let report = dir.path().join("starts.jsonl");
    let run = Arc::new(run(dir.path(), LIMIT));
    plan(&run.catalogs, &report, json!({"hangBeforeListening": 60}));
    let reading = tokio::spawn({
        let run = run.clone();
        async move { read(&run).await }
    });
    until("its OpenCode to start", || starts(&report).len() == 1).await;
    reading.abort();
    assert!(reading.await.unwrap_err().is_cancelled());
    let seen = starts(&report);
    until("its process group to end", || ended(seen[0]["pid"].as_i64().unwrap()) && ended(seen[0]["child"].as_i64().unwrap())).await;
    assert_eq!(left(&run.catalogs), Vec::<String>::new(), "its folder removed");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn one_read_at_a_time_and_a_request_that_waited_takes_its_answer() {
    process_program();
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("work");
    fs::create_dir_all(&cwd).unwrap();
    let ws = Workspace::new(dir.path().join("data"), cwd.to_string_lossy().into_owned(), "unused".into()).unwrap();
    let report = dir.path().join("starts.jsonl");
    // Ready a second after it listens, so the second request comes while the first reads.
    plan(&ws.data_dir.join("opencode").join("catalogs"), &report, json!({"starting": 1}));
    let (first, second) = tokio::join!(ws.routing_opencode_catalog(), async {
        until("the first read to start", || starts(&report).len() == 1).await;
        ws.routing_opencode_catalog().await
    });
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_eq!(starts(&report).len(), 1, "the second waited for the first and started none");
    assert_eq!(first, second, "and took its answer");
    // One asked after it ended reads again.
    ws.routing_opencode_catalog().await.unwrap();
    assert_eq!(starts(&report).len(), 2);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_route_reads_opencodes_only_on_cores_own_port() {
    process_program();
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    plan(&ws.data_dir.join("opencode").join("catalogs"), &dir.path().join("starts.jsonl"), json!({}));
    let local = crate::server::router(ws.clone(), dir.path().join("assets"));
    let remote = crate::server::remote_router(ws.clone(), dir.path().join("assets"), None,
        crate::server::RemoteEntry::new("https://core.example-tailnet.ts.net:8444", "person@example.com").unwrap());
    let get = |app: axum::Router, uri: &'static str, phone: bool| async move {
        let mut request = Request::builder().uri(uri).header("x-yuzuno-client", "desktop");
        request = if phone { request.header("tailscale-user-login", "person@example.com") } else { request.header("host", "127.0.0.1:4317") };
        let response = app.oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status();
        (status, serde_json::from_slice::<Value>(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap_or(Value::Null))
    };
    let (status, catalog) = get(local.clone(), "/api/routing/models?harness=opencode", false).await;
    assert_eq!(status, StatusCode::OK, "{catalog}");
    assert!(catalog["models"].as_array().is_some_and(|m| m.len() == 4), "{catalog}");
    let (status, refused) = get(local.clone(), "/api/routing/models?harness=codex", false).await;
    assert_eq!((status, refused["code"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid")));
    let (status, _) = get(remote, "/api/routing/models?harness=opencode", true).await;
    assert_ne!(status, StatusCode::OK, "never through the phone entry");
}
