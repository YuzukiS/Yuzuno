//! T-29 `/diff` through the HTTP API, with a fake app-server whose
//! `command/exec` behaves as Codex 0.162.1's was measured to (probe 109dae93):
//! - Output is streamed as base64 deltas, capped per stream.
//! - `capReached` is set when the cap is reached.
//! - A process whose output goes past the cap keeps running until it is
//!   terminated; it then answers with exit 137.
//! - A timeout answers 124.
//! It answers each Git command from files a test writes, and records every
//! request with its own process ID. No Git, account, model or real session
//! is used.
use super::*;
use crate::codex_diff::{Limits, SMALL};
use std::{os::unix::fs::PermissionsExt, time::Duration};

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    base: String,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Lab {
    fn drop(&mut self) {
        self.server.abort();
        for c in self.ws.rpcs.lock().unwrap().values() { c.rpc.close(); }
    }
}

const SCRIPT: &str = r#"#!/usr/bin/python3
import base64,json,os,sys,time,pathlib
root=pathlib.Path(__file__).parent
held={}
def out(v):print(json.dumps(v),flush=True)
def log(v):
 with (root/'sent').open('a') as f:f.write(json.dumps(v|{'pid':os.getpid()})+'\n')
def file(name,default=''):
 p=root/name
 return p.read_text() if p.exists() else default
for line in sys.stdin:
 r=json.loads(line); m=r.get('method',''); p=r.get('params',{})
 if 'method' not in r or 'id' not in r:continue
 i=r['id']; flags=file('flags').split()
 if m=='command/exec/terminate':
  log({'method':m,'params':p})
  h=held.pop(p['processId'],None)
  if h is not None: out({'id':h,'result':{'exitCode':137,'stdout':'','stderr':''}})
  out({'id':i,'result':{}}); continue
 if m!='command/exec':
  out({'id':i,'result':{'thread':{'id':'thread-a','status':{'type':'idle'},'turns':[]},'model':'m'} if m.startswith('thread/') else {}}); continue
 log({'method':m,'params':p})
 argv=p['command']; args=argv[7:]; pid=p.get('processId'); cap=p.get('outputBytesCap')
 if 'old' in flags: out({'id':i,'error':{'code':-32601,'message':'Method not found'}}); continue
 if 'windows' in flags: out({'id':i,'error':{'code':-32600,'message':'custom outputBytesCap is not supported with windows sandbox'}}); continue
 if 'slow' in flags: time.sleep(float(file('slow','0.5')))
 code,so,se=0,'',''
 if args[:1]==['rev-parse']:
  so='true\n'
  if 'notrepo' in flags: code,so,se=128,'','fatal: not a git repository (or any of the parent directories): .git\n'
  if 'dubious' in flags: code,so,se=128,'',"fatal: detected dubious ownership in repository at '/w'\n"
  if 'missing' in flags: code,so,se=101,'',"\nthread 'main' panicked at linux-sandbox/src/linux_run_main.rs:1602:5:\nFailed to execvp git: No such file or directory (os error 2)\n"
 elif args[:1]==['config']:
  so=file('filters'); code=0 if so else 1
 elif args[:2]==['diff','--cached']: so=file('staged')
 elif args[:2]==['diff','--no-index']:
  name=args[-1]; so=json.loads(file('untracked_content','{}')).get(name,'+'+name+'\n'); code=1
  if 'hang-untracked' in flags: held[pid]=i; continue
 elif args[:1]==['diff']:
  so=file('tracked')
  if 'hang' in flags: held[pid]=i; continue
 elif args[:1]==['ls-files']: so=file('untracked')
 data=so.encode()
 if cap is not None and len(data)>=cap:
  out({'method':'command/exec/outputDelta','params':{'processId':pid,'stream':'stdout','deltaBase64':base64.b64encode(data[:cap]).decode(),'capReached':True}})
  if len(data)>cap: held[pid]=i; continue
 elif data:
  out({'method':'command/exec/outputDelta','params':{'processId':pid,'stream':'stdout','deltaBase64':base64.b64encode(data).decode(),'capReached':False}})
 if se: out({'method':'command/exec/outputDelta','params':{'processId':pid,'stream':'stderr','deltaBase64':base64.b64encode(se.encode()).decode(),'capReached':False}})
 out({'id':i,'result':{'exitCode':code,'stdout':'','stderr':''}})
"#;

impl Lab {
    async fn new(flags: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("native.py");
        std::fs::write(&script, SCRIPT).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(dir.path().join("flags"), flags).unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), script.display().to_string()).unwrap();
        let d: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/w/app","model":"m","color":"sage",
            "threadId":"thread-a","status":"offline","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&d).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = crate::server::router_on_port(ws.clone(), dir.path().join("web"), addr.port());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        Self { dir, ws, base: format!("http://{addr}/api"), server }
    }

    fn write(&self, name: &str, content: &str) {
        std::fs::write(self.dir.path().join(name), content).unwrap();
    }

    async fn connect(&self) -> u64 {
        self.ws.reconnect("a").await.unwrap();
        self.ws.rpcs.lock().unwrap()["a"].generation
    }

    async fn read(&self, token: &str) -> Value {
        let response = reqwest::Client::new().post(format!("{}/agents/a/codex/diff", self.base))
            .header("X-Yuzuno-Client", "desktop").json(&json!({"token":token})).send().await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        response.json().await.unwrap()
    }

    async fn cancel(&self, token: &str) -> Value {
        reqwest::Client::new().delete(format!("{}/agents/a/codex/diff?token={token}", self.base))
            .header("X-Yuzuno-Client", "desktop").send().await.unwrap().json().await.unwrap()
    }

    /// The command/exec and terminate requests, in order.
    fn sent(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("sent")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn commands(&self) -> Vec<Vec<String>> {
        self.sent().iter().filter(|r| r["method"] == "command/exec")
            .map(|r| r["params"]["command"].as_array().unwrap()[7..].iter().map(|a| a.as_str().unwrap().to_owned()).collect()).collect()
    }

    async fn until(&self, what: &str, done: impl Fn(&[Value]) -> bool) {
        for _ in 0..300 {
            if done(&self.sent()) { return; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("never {what}: {:?}", self.sent());
    }
}

fn strs(v: &Value) -> Vec<&str> {
    v.as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_runs_only_the_fixed_commands_read_only_in_the_agents_folder_and_reports_each_part() {
    let lab = Lab::new("").await;
    lab.write("tracked", "diff --git a/a.rs b/a.rs\n@@ -1 +1 @@\n-a\n+b\n");
    lab.write("staged", "M\0x.rs\0R100\0old.rs\0new.rs\0");
    lab.write("untracked", "u.txt\0-dash.txt\0sub/\0new\nline.txt\0");
    lab.write("filters", "filter.lfs.clean\0filter.lfs.process\0filter.evil.clean\0");
    let generation = lab.connect().await;
    assert!(lab.sent().is_empty(), "connecting reads nothing");
    let report = lab.read("t1").await;
    assert_eq!((report["state"].as_str(), report["generation"].as_u64(), report["cwd"].as_str()), (Some("read"), Some(generation), Some("/w/app")));
    assert_eq!(report["tracked"], json!({"text":"diff --git a/a.rs b/a.rs\n@@ -1 +1 @@\n-a\n+b\n","complete":true,"notUtf8":false}));
    assert_eq!(report["staged"], json!({"entries":[{"status":"M","path":"x.rs","from":null},{"status":"R100","path":"new.rs","from":"old.rs"}],"complete":true}));
    let files = report["untracked"]["files"].as_array().unwrap();
    assert_eq!(files.iter().map(|f| (f["path"].as_str().unwrap(), f["diff"]["text"].as_str(), f["notRead"].as_str())).collect::<Vec<_>>(), [
        ("u.txt", Some("+u.txt\n"), None), ("-dash.txt", Some("+-dash.txt\n"), None), ("sub/", None, Some("nested_repository")),
        ("new\nline.txt", Some("+new\nline.txt\n"), None)]);
    assert_eq!(report["untracked"]["listedAll"], true);
    assert_eq!(report["complete"], false, "a nested repository is listed, not read");
    let flags = ["--no-textconv", "--no-ext-diff", "--submodule=short", "--ignore-submodules=dirty", "--no-color"];
    let with = |head: &[&str], tail: &[&str]| -> Vec<String> { head.iter().chain(flags.iter()).chain(tail.iter()).map(|s| s.to_string()).collect() };
    assert_eq!(lab.commands(), vec![
        vec!["rev-parse".to_owned(), "--is-inside-work-tree".to_owned()],
        ["config", "--null", "--name-only", "--get-regexp", r"^filter\..*\.(clean|process)$"].map(String::from).to_vec(),
        with(&["diff"], &[]),
        with(&["diff", "--cached", "--name-status", "-z"], &[]),
        ["ls-files", "--others", "--exclude-standard", "-z"].map(String::from).to_vec(),
        with(&["diff", "--no-index"], &["--", "/dev/null", "u.txt"]),
        with(&["diff", "--no-index"], &["--", "/dev/null", "-dash.txt"]),
        with(&["diff", "--no-index"], &["--", "/dev/null", "new\nline.txt"]),
    ], "the fixed sequence; a name always after --");
    let sent = lab.sent();
    let limits = Limits::default();
    for (n, request) in sent.iter().enumerate() {
        let p = &request["params"];
        assert_eq!(strs(&p["command"])[..7], ["git", "-c", "safe.bareRepository=explicit", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]);
        assert_eq!((p["cwd"].as_str(), &p["sandboxPolicy"], p["streamStdoutStderr"].as_bool()), (Some("/w/app"), &json!({"type":"readOnly","networkAccess":false}), Some(true)));
        assert_eq!(p["processId"], format!("yuzuno-diff-t1-{}", n + 1));
        assert!(p["timeoutMs"].as_u64().unwrap() <= 30_000);
        assert_eq!((&p["env"]["GIT_OPTIONAL_LOCKS"], &p["env"]["GIT_TERMINAL_PROMPT"], &p["env"]["GIT_DIR"], &p["env"]["GIT_CONFIG_PARAMETERS"], &p["env"]["GIT_EXTERNAL_DIFF"]),
            (&json!("0"), &json!("0"), &Value::Null, &Value::Null, &Value::Null));
        assert!(p["env"].as_object().unwrap().contains_key("GIT_DIR"), "unset explicitly, not left to inheritance");
        let cap = p["outputBytesCap"].as_u64().unwrap() as usize;
        let expected = match n { 0 | 1 => SMALL, 2 => limits.tracked, 3 | 4 => limits.list, _ => limits.untracked_each };
        assert_eq!(cap, expected + 1, "the cap is one byte above the limit: {n}");
    }
    assert_eq!(sent[0]["params"]["env"]["GIT_CONFIG_COUNT"], "0", "before the drivers are known, inherited configuration is still off");
    let env = &sent[2]["params"]["env"];
    assert_eq!(env["GIT_CONFIG_COUNT"], "6");
    let overrides: Vec<(String, String)> = (0..6).map(|i| (env[format!("GIT_CONFIG_KEY_{i}")].as_str().unwrap().into(), env[format!("GIT_CONFIG_VALUE_{i}")].as_str().unwrap().into())).collect();
    assert_eq!(overrides, [("filter.evil.clean", ""), ("filter.evil.process", ""), ("filter.evil.required", "false"),
        ("filter.lfs.clean", ""), ("filter.lfs.process", ""), ("filter.lfs.required", "false")].map(|(k, v)| (k.to_owned(), v.to_owned())));
    assert!(!sent.iter().any(|r| r["method"] == "command/exec/terminate"), "nothing to stop");
    assert_eq!((report["commands"].as_u64(), report["stopped"].as_str()), (Some(8), None));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_reason_it_cannot_read_is_said_and_ends_the_read() {
    let lab = Lab::new("").await;
    assert_eq!(lab.read("t1").await["reason"], "not_connected");
    assert!(lab.sent().is_empty(), "nothing connected or started to read it");
    lab.connect().await;
    for (flags, state, reason) in [("notrepo", "not_repository", "not_work_tree"), ("dubious", "failed", "dubious_ownership"),
            ("missing", "unavailable", "git_missing"), ("old", "unavailable", "old_protocol"), ("windows", "unavailable", "platform")] {
        lab.write("flags", flags);
        let before = lab.sent().len();
        let report = lab.read(&format!("t-{flags}")).await;
        assert_eq!((report["state"].as_str(), report["reason"].as_str()), (Some(state), Some(reason)), "{flags}: {report}");
        assert_eq!(lab.sent().len() - before, 1, "{flags}: nothing after the first command");
        assert!(report["tracked"].is_null() && report["untracked"].is_null(), "{flags}");
    }
    lab.write("flags", "dubious");
    assert!(lab.read("t-d").await["detail"].as_str().unwrap().contains("dubious ownership"), "Git's own words");
    for token in ["", "has space", &"x".repeat(65)] {
        let response = reqwest::Client::new().post(format!("{}/agents/a/codex/diff", lab.base))
            .header("X-Yuzuno-Client", "desktop").json(&json!({"token":token})).send().await.unwrap();
        assert!(response.status().is_client_error(), "{token:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn limits_are_exact_and_a_process_past_its_cap_is_stopped() {
    let lab = Lab::new("").await;
    lab.connect().await;
    *lab.ws.codex_diff.limits.lock().unwrap() = Limits { tracked: 10, untracked_each: 6, untracked_files: 2, names: 3, list: 1000, total: 100_000, budget: Duration::from_secs(30) };
    // Ten bytes is the limit: whole. "あ" is 3 bytes: 9 + 3 = 12 is over, cut inside the character.
    lab.write("tracked", "0123456789");
    let report = lab.read("t1").await;
    assert_eq!(report["tracked"], json!({"text":"0123456789","complete":true,"notUtf8":false}));
    lab.write("tracked", "012345678あ");
    lab.write("untracked", "a\0b\0c\0d\0e\0");
    lab.write("untracked_content", r#"{"a":"+abc\n","b":"+longer than six\n"}"#);
    let before = lab.sent().len();
    let report = lab.read("t2").await;
    assert_eq!(report["tracked"], json!({"text":"012345678","complete":false,"notUtf8":false}), "the cut character is left out");
    let files = report["untracked"]["files"].as_array().unwrap();
    assert_eq!(files.iter().map(|f| (f["path"].as_str().unwrap(), f["diff"]["text"].as_str(), f["diff"]["complete"].as_bool(), f["notRead"].as_str())).collect::<Vec<_>>(),
        [("a", Some("+abc\n"), Some(true), None), ("b", Some("+longe"), Some(false), None), ("c", None, None, Some("limit"))]);
    assert_eq!(report["untracked"]["listedAll"], false, "three names of five");
    assert_eq!(report["complete"], false);
    let sent = &lab.sent()[before..];
    let stopped: Vec<&str> = sent.iter().filter(|r| r["method"] == "command/exec/terminate").map(|r| r["params"]["processId"].as_str().unwrap()).collect();
    assert_eq!(stopped, ["yuzuno-diff-t2-3", "yuzuno-diff-t2-7"], "each process past its cap was stopped, nothing else");
    // The total counts what was kept: once it is reached nothing more is read.
    *lab.ws.codex_diff.limits.lock().unwrap() = Limits { tracked: 10, untracked_each: 6, untracked_files: 100, names: 100, list: 1000, total: 30, budget: Duration::from_secs(30) };
    lab.write("tracked", "0123456789");
    let report = lab.read("t3").await;
    assert_eq!(report["untracked"]["files"].as_array().unwrap().iter().filter(|f| f["notRead"] == "total").count() > 0, true, "{report}");
    assert!(report["bytes"].as_u64().unwrap() <= 30 + 7, "within the total, give or take one file's limit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_budget_for_the_whole_read_and_what_was_read_stays() {
    let lab = Lab::new("slow").await;
    lab.write("slow", "0.4");
    lab.write("untracked", "a\0b\0c\0d\0e\0f\0g\0h\0");
    lab.connect().await;
    lab.ws.codex_diff.limits.lock().unwrap().budget = Duration::from_millis(2500);
    let started = std::time::Instant::now();
    let report = lab.read("t1").await;
    assert!(started.elapsed() < Duration::from_millis(2500 + 1500), "the budget holds: {:?}", started.elapsed());
    assert_eq!((report["state"].as_str(), report["stopped"].as_str(), report["complete"].as_bool()), (Some("read"), Some("budget"), Some(false)), "{report}");
    assert!(report["tracked"]["complete"] == true, "what was read stays");
    let timeouts: Vec<u64> = lab.sent().iter().map(|r| r["params"]["timeoutMs"].as_u64().unwrap()).collect();
    assert!(timeouts.windows(2).all(|w| w[1] < w[0]) && timeouts[0] <= 2500, "each command gets what is left of one budget: {timeouts:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_is_cancelled_only_by_its_own_token_and_one_runs_at_a_time() {
    let lab = Lab::new("hang").await;
    lab.connect().await;
    let ws = lab.ws.clone();
    let read = tokio::spawn(async move { ws.codex_diff("a", "t1".into()).await.unwrap() });
    lab.until("the tracked diff hangs", |sent| sent.len() >= 3).await;
    assert_eq!(lab.read("t2").await["state"], "busy", "one read per Agent");
    assert_eq!(lab.cancel("other").await, json!({"cancelled":false}));
    assert_eq!(lab.cancel("t1").await, json!({"cancelled":true}));
    let report = serde_json::to_value(read.await.unwrap()).unwrap();
    assert_eq!(report["state"], "cancelled", "{report}");
    let sent = lab.sent();
    assert_eq!(sent.iter().filter(|r| r["method"] == "command/exec/terminate").map(|r| r["params"]["processId"].as_str().unwrap()).collect::<Vec<_>>(),
        ["yuzuno-diff-t1-3"], "the running command is stopped");
    assert_eq!(sent.iter().filter(|r| r["method"] == "command/exec").count(), 3, "nothing after the cancel");
    lab.write("flags", "");
    assert_eq!(lab.read("t3").await["state"], "read", "the next read runs");
    // Cancelled among the untracked files: what was read stays, and it says cancelled.
    lab.write("flags", "hang-untracked");
    lab.write("tracked", "+t\n");
    lab.write("untracked", "a\0b\0");
    let ws = lab.ws.clone();
    let read = tokio::spawn(async move { ws.codex_diff("a", "t4".into()).await.unwrap() });
    lab.until("the first untracked file hangs", |sent| sent.iter().any(|r| r["params"]["processId"] == "yuzuno-diff-t4-6")).await;
    assert_eq!(lab.cancel("t4").await, json!({"cancelled":true}));
    let report = serde_json::to_value(read.await.unwrap()).unwrap();
    assert_eq!((report["state"].as_str(), report["stopped"].as_str(), report["complete"].as_bool()), (Some("cancelled"), Some("cancelled"), Some(false)), "{report}");
    assert_eq!(report["tracked"]["text"], "+t\n");
    assert_eq!(report["untracked"]["files"], json!([{"path":"a","diff":null,"notRead":"stopped"},{"path":"b","diff":null,"notRead":"stopped"}]));
    assert_eq!(lab.sent().iter().filter(|r| r["params"]["processId"].as_str().is_some_and(|p| p.starts_with("yuzuno-diff-t4-"))).count(), 7,
        "six commands and one terminate; b never ran");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_ends_with_its_connection_and_never_acts_on_the_next() {
    let lab = Lab::new("hang").await;
    let first = lab.connect().await;
    let ws = lab.ws.clone();
    let read = tokio::spawn(async move { ws.codex_diff("a", "t1".into()).await.unwrap() });
    lab.until("the tracked diff hangs", |sent| sent.len() >= 3).await;
    let old_pid = lab.sent()[2]["pid"].clone();
    lab.ws.remove_connection("a", first).await;
    let report = serde_json::to_value(read.await.unwrap()).unwrap();
    assert_eq!((report["state"].as_str(), report["reason"].as_str()), (Some("failed"), Some("connection")), "{report}");
    assert!(lab.sent().iter().all(|r| r["pid"] == old_pid), "nothing reached another app-server");
    // A delta of the old connection, arriving late, finds no read.
    lab.write("flags", "");
    let second = lab.connect().await;
    assert_ne!(first, second);
    lab.ws.codex_diff.deliver("a", first, &json!({"processId":"yuzuno-diff-t1-3","stream":"stdout","deltaBase64":"eA==","capReached":false}));
    let report = lab.read("t2").await;
    assert_eq!((report["state"].as_str(), report["generation"].as_u64()), (Some("read"), Some(second)));
}
