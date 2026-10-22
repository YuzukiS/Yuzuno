//! T-29 `/diff` against real Git, run by the installed Codex's own
//! `command/exec` and read-only sandbox, in temporary repositories built so
//! that Git runs a marker program wherever it is allowed to: external diff
//! (configured, per attribute and inherited), textconv, clean and process
//! filters, an fsmonitor hook, index hooks, a pager; with Git configuration
//! injected through the variables Codex's own environment passes on.
//!
//! Ignored: run in a limited Job with `YUZUNO_DIFF_FIXTURE_CODEX` naming the
//! Codex launcher (its folder must hold `node`). Codex runs with a private
//! HOME and CODEX_HOME in the temporary folder. No thread, session or model
//! is used: a proxy answers the thread calls itself and passes only
//! `initialize` and `command/exec` (with its terminate) to Codex.
use super::*;
use crate::codex_diff::{Limits, Request};
use std::{
    os::unix::{ffi::OsStringExt, fs::{MetadataExt, PermissionsExt}},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

const PROXY: &str = r#"#!/usr/bin/python3
import json,os,subprocess,sys,threading,pathlib
lab=pathlib.Path(__file__).parent
home=lab.parent/'home'
env={'HOME':str(home),'CODEX_HOME':str(home/'.codex'),'XDG_CONFIG_HOME':str(home/'xdg'),'XDG_DATA_HOME':str(home/'xdg-data'),
 'XDG_CACHE_HOME':str(home/'xdg-cache'),'XDG_STATE_HOME':str(home/'xdg-state'),'LANG':'C.UTF-8','PATH':(lab/'path').read_text()}
env.update(json.loads((lab/'inherited.json').read_text()))
codex=subprocess.Popen([(lab/'codex').read_text(),'app-server','--stdio'],cwd=str(lab),env=env,
 stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(lab/'codex-stderr','ab'))
out=sys.stdout.buffer
lock=threading.Lock()
def send(b):
 with lock: out.write(b); out.flush()
def pump():
 for line in codex.stdout: send(line)
threading.Thread(target=pump,daemon=True).start()
for line in sys.stdin.buffer:
 r=json.loads(line); m=r.get('method')
 if m in ('command/exec','command/exec/terminate'):
  with (lab/'sent').open('a') as f: f.write(json.dumps({'method':m,'params':r['params'],'pid':os.getpid()})+'\n')
 if m in ('initialize','initialized','command/exec','command/exec/terminate') or m is None:
  codex.stdin.write(line); codex.stdin.flush(); continue
 if 'id' in r:
  send((json.dumps({'id':r['id'],'result':{'thread':{'id':'thread-a','status':{'type':'idle'},'turns':[]},'model':'m'} if m.startswith('thread/') else {}})+'\n').encode())
"#;

/// The temporary root: markers, a private HOME, a folder outside the repositories.
struct Root {
    dir: tempfile::TempDir,
    codex: PathBuf,
}

impl Root {
    fn new() -> Self {
        let codex = PathBuf::from(std::env::var_os("YUZUNO_DIFF_FIXTURE_CODEX").expect("YUZUNO_DIFF_FIXTURE_CODEX names the Codex launcher"));
        let dir = tempfile::Builder::new().prefix("t29-diff-fixture-").tempdir().unwrap();
        for sub in ["bin", "home/.codex", "home/xdg", "outside", "hooks"] {
            std::fs::create_dir_all(dir.path().join(sub)).unwrap();
        }
        std::fs::write(dir.path().join("marks"), "").unwrap();
        std::fs::write(dir.path().join("outside/secret.txt"), "OUTSIDE-SECRET-CONTENT\n").unwrap();
        let root = Self { dir, codex };
        for name in ["extdiff", "diffcmd", "textconv", "filter-clean", "filter-smudge", "filter-process", "fsmonitor", "pager",
                "envdiff", "envparams", "envcount"] {
            root.marker(&root.path().join("bin").join(name), name);
        }
        for hook in ["post-index-change", "reference-transaction", "post-checkout"] {
            root.marker(&root.path().join("hooks").join(hook), "hook");
        }
        root
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    /// A program that says it ran: on stdout and stderr, and in `marks` where it may write.
    fn marker(&self, path: &Path, name: &str) {
        let read = if name.starts_with("filter-clean") || name.starts_with("filter-smudge") { "cat >/dev/null\n" } else { "" };
        std::fs::write(path, format!("#!/bin/sh\n{read}echo {name} >> '{}' 2>/dev/null\necho MARKER-{name}-RAN\necho MARKER-{name}-RAN >&2\nexit 0\n",
            self.path().join("marks").display())).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn marks(&self) -> String {
        std::fs::read_to_string(self.path().join("marks")).unwrap()
    }

    fn bin(&self, name: &str) -> String {
        self.path().join("bin").join(name).display().to_string()
    }

    /// Git outside any sandbox, with a plain environment: to build the fixtures, and as the control.
    fn git(&self, dir: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git").args(args).current_dir(dir).env_clear()
            .env("PATH", "/usr/bin:/bin").env("HOME", self.path().join("home")).env("LANG", "C.UTF-8")
            .env("GIT_AUTHOR_NAME", "T").env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "T").env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .output().unwrap()
    }

    fn ok(&self, dir: &Path, args: &[&str]) {
        let out = self.git(dir, args);
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn repo(&self, name: &str) -> PathBuf {
        let work = self.path().join(name);
        std::fs::create_dir_all(&work).unwrap();
        self.ok(&work, &["init", "-q", "-b", "main"]);
        self.ok(&work, &["config", "commit.gpgsign", "false"]);
        work
    }

    fn default_path(&self) -> String {
        format!("{}:/usr/bin:/bin", self.codex.parent().unwrap().display())
    }
}

struct Lab {
    dir: PathBuf,
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

impl Lab {
    /// A Workspace whose Agent "a" works in `cwd`, its Codex started with `path` and `inherited` variables.
    async fn new(root: &Root, name: &str, cwd: &Path, path: &str, inherited: Value) -> Self {
        let dir = root.path().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("proxy.py");
        std::fs::write(&script, PROXY).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(dir.join("codex"), root.codex.display().to_string()).unwrap();
        std::fs::write(dir.join("path"), path).unwrap();
        std::fs::write(dir.join("inherited.json"), inherited.to_string()).unwrap();
        let ws = Workspace::new(dir.join("data"), root.path().display().to_string(), script.display().to_string()).unwrap();
        let d: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":cwd.display().to_string(),"model":"m","color":"sage",
            "threadId":"thread-a","status":"offline","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&d).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = crate::server::router_on_port(ws.clone(), dir.join("web"), addr.port());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        let lab = Self { dir, ws, base: format!("http://{addr}/api"), server };
        lab.ws.reconnect("a").await.unwrap();
        lab
    }

    fn generation(&self) -> u64 {
        self.ws.rpcs.lock().unwrap()["a"].generation
    }

    /// A read of the target as the dialog shows it now.
    async fn read(&self, token: &str) -> Value {
        let target: Value = reqwest::Client::new().get(format!("{}/agents/a/codex/diff", self.base))
            .header("X-Yuzuno-Client", "desktop").send().await.unwrap().json().await.unwrap();
        let response = reqwest::Client::new().post(format!("{}/agents/a/codex/diff", self.base)).header("X-Yuzuno-Client", "desktop")
            .json(&json!({"token":token,"generation":target["generation"],"cwd":target["cwd"]})).send().await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        response.json().await.unwrap()
    }

    async fn cancel(&self, token: &str) -> Value {
        reqwest::Client::new().delete(format!("{}/agents/a/codex/diff?token={token}", self.base))
            .header("X-Yuzuno-Client", "desktop").send().await.unwrap().json().await.unwrap()
    }

    /// A command outside Yuzuno's read, on the same connection and sandbox: the control.
    async fn raw(&self, command: &[&str], cwd: &Path, env: Value) -> Value {
        let rpc = self.ws.rpcs.lock().unwrap()["a"].rpc.clone();
        rpc.request_within("command/exec", json!({"command":command,"cwd":cwd,"env":env,"timeoutMs":10_000,
            "outputBytesCap":1 << 20,"sandboxPolicy":{"type":"readOnly","networkAccess":false}}), Duration::from_secs(20)).await.unwrap()
    }

    fn sent(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.join("sent")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    /// The read's own requests: its commands and terminates.
    fn of(&self, token: &str) -> Vec<Value> {
        let prefix = format!("yuzuno-diff-{token}-");
        self.sent().into_iter().filter(|r| r["params"]["processId"].as_str().is_some_and(|p| p.starts_with(&prefix))).collect()
    }

    async fn until(&self, what: &str, done: impl Fn(&Lab) -> bool) {
        for _ in 0..1000 {
            if done(self) { return; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("never {what}");
    }

    fn pid(&self) -> u32 {
        self.ws.rpcs.lock().unwrap()["a"].rpc.pid().unwrap()
    }
}

/// Every file under `dir` as it is: path, mode, mtime, content or link target.
fn manifest(dir: &Path) -> Vec<(PathBuf, u32, i64, i64, Vec<u8>)> {
    let mut out = vec![];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).unwrap().flatten() {
            let path = entry.path();
            let m = std::fs::symlink_metadata(&path).unwrap();
            let content = if m.file_type().is_symlink() {
                std::fs::read_link(&path).unwrap().into_os_string().into_vec()
            } else if m.is_file() {
                std::fs::read(&path).unwrap()
            } else {
                stack.push(path.clone());
                vec![]
            };
            out.push((path, m.mode(), m.mtime(), m.mtime_nsec(), content));
        }
    }
    out.sort();
    out
}

/// Live processes under `pid`: "pid state parent: command line" (zombies left out).
fn descendants(pid: u32) -> Vec<String> {
    let mut out = vec![];
    let mut stack = vec![pid];
    while let Some(p) = stack.pop() {
        let Ok(tasks) = std::fs::read_dir(format!("/proc/{p}/task")) else { continue };
        for task in tasks.flatten() {
            for child in std::fs::read_to_string(task.path().join("children")).unwrap_or_default().split_whitespace().filter_map(|c| c.parse::<u32>().ok()) {
                let stat = std::fs::read_to_string(format!("/proc/{child}/stat")).unwrap_or_default();
                let state = stat.rsplit_once(") ").map(|(_, rest)| rest.chars().next().unwrap_or('?')).unwrap_or('?');
                if state == 'Z' { continue; }
                let line = std::fs::read(format!("/proc/{child}/cmdline")).unwrap_or_default();
                let line = String::from_utf8_lossy(&line).replace('\0', " ");
                out.push(format!("{child} {state} {p}: {}", line.trim()));
                stack.push(child);
            }
        }
    }
    out
}

fn file<'a>(report: &'a Value, path: &str) -> &'a Value {
    report["untracked"]["files"].as_array().unwrap().iter().find(|f| f["path"] == path).unwrap_or_else(|| panic!("{path:?} not listed: {report}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "real Git and the installed Codex in a temporary folder; run in a limited Job with YUZUNO_DIFF_FIXTURE_CODEX"]
async fn real_git_runs_none_of_the_repositorys_programs_and_the_folder_is_left_as_it_was() {
    let root = Root::new();
    let work = root.repo("work");
    std::fs::write(work.join(".gitattributes"), "*.txt diff=evil filter=evil\n*.md filter=evilp\n").unwrap();
    std::fs::write(work.join(".gitignore"), "ignored.log\n").unwrap();
    std::fs::write(work.join("a.txt"), "line one\nあいう\n").unwrap();
    std::fs::write(work.join("b.rs"), "fn a() {}\n").unwrap();
    std::fs::write(work.join("c.md"), "# c\n").unwrap();
    std::fs::write(work.join("old.rs"), "fn old() {}\n").unwrap();
    root.ok(&work, &["add", "."]);
    root.ok(&work, &["commit", "-q", "-m", "base"]);
    root.ok(&work, &["mv", "old.rs", "new.rs"]);
    std::fs::write(work.join("staged-new.txt"), "staged\n").unwrap();
    root.ok(&work, &["add", "staged-new.txt"]);
    std::fs::write(work.join("a.txt"), "line one\nchanged あ line\n").unwrap();
    std::fs::write(work.join("b.rs"), "fn b() {}\n").unwrap();
    std::fs::write(work.join("c.md"), "# c changed\n").unwrap();
    // The repository's own configuration, set after the commits so none of it ran yet.
    for (key, value) in [("diff.external", root.bin("extdiff")), ("diff.evil.command", root.bin("diffcmd")),
            ("diff.evil.textconv", root.bin("textconv")), ("filter.evil.clean", root.bin("filter-clean")),
            ("filter.evil.smudge", root.bin("filter-smudge")), ("filter.evil.required", "true".into()),
            ("filter.evilp.process", root.bin("filter-process")), ("filter.evilp.required", "true".into()),
            ("core.fsmonitor", root.bin("fsmonitor")), ("core.hooksPath", root.path().join("hooks").display().to_string()),
            ("core.pager", root.bin("pager")), ("pager.diff", root.bin("pager")), ("color.ui", "always".into())] {
        root.ok(&work, &["config", key, &value]);
    }
    std::fs::copy(root.path().join("hooks/post-index-change"), work.join(".git/hooks/post-index-change")).unwrap();
    // Untracked: names Git must be handed as they are, a binary, links out of the folder, a nested repository.
    for (name, content) in [("u.txt", &b"plain untracked\n"[..]), ("-dash.txt", b"dash content\n"), ("space name.txt", b"space\n"),
            ("new\nline.txt", b"newline name\n"), ("ユニコード.txt", "日本語\n".as_bytes()), ("bin.dat", b"\0\x01\x02\xff\0"),
            ("empty.txt", b""), ("ignored.log", b"ignored\n")] {
        std::fs::write(work.join(name), content).unwrap();
    }
    std::fs::write(work.join("large.txt"), "あいうえお\n".repeat(300 * 1024 / 16)).unwrap();
    std::os::unix::fs::symlink("../outside/secret.txt", work.join("link-out")).unwrap();
    std::os::unix::fs::symlink("../outside", work.join("link-dir")).unwrap();
    let nested = root.repo("work/nested");
    std::fs::write(nested.join("inner.txt"), "inner\n").unwrap();

    // Control 1, outside any sandbox and without the read's settings: the
    // same Git runs every one of these programs. A process filter that
    // breaks its protocol stops Git whatever `required` says, so the later
    // controls set it aside to reach the rest; `git diff` writes no index and
    // runs no hook, `git status` does.
    let past_process = ["-c", "filter.evilp.process=", "-c", "filter.evilp.required=false"];
    for args in [vec!["diff"], [&past_process[..], &["diff"]].concat(), [&past_process[..], &["diff", "--no-ext-diff"]].concat(),
            [&past_process[..], &["status", "--short"]].concat()] {
        root.git(&work, &args);
    }
    let ran: std::collections::BTreeSet<String> = root.marks().lines().map(str::to_owned).collect();
    println!("control outside the sandbox ran: {ran:?}");
    for armed in ["extdiff", "diffcmd", "textconv", "filter-clean", "filter-smudge", "filter-process", "fsmonitor", "hook"] {
        assert!(ran.contains(armed), "{armed} did not run in the control, so its absence later would prove nothing: {ran:?}");
    }

    // Codex's own environment, as the proxy starts it, with Git
    // configuration injected the ways an inherited environment can.
    let inherited = json!({"GIT_EXTERNAL_DIFF":root.bin("envdiff"),"GIT_CONFIG_PARAMETERS":format!("'filter.evil.clean'='{}'", root.bin("envparams")),
        "GIT_CONFIG_COUNT":"1","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":root.bin("envcount"),"GIT_TRACE":"1"});
    let lab = Lab::new(&root, "lab", &work, &root.default_path(), inherited.clone()).await;
    // Control 2, through the same connection and read-only sandbox: what
    // Codex's environment passes on reaches Git, and the fsmonitor hook and
    // filters run there and are seen in the output.
    let inside = lab.raw(&["git", "diff"], &work, json!({})).await;
    println!("control in the sandbox, inherited environment: {inside}");
    for said in ["trace: built-in: git diff", "MARKER-envcount-RAN", "MARKER-envparams-RAN", "MARKER-filter-process-RAN"] {
        assert!(inside["stderr"].as_str().unwrap().contains(said), "{said}: {inside}");
    }
    let without = json!({"GIT_EXTERNAL_DIFF":null,"GIT_CONFIG_PARAMETERS":null,"GIT_CONFIG_COUNT":null,"GIT_TRACE":null});
    let inside = lab.raw(&["git", "diff"], &work, without.clone()).await;
    println!("control in the sandbox, the repository's configuration: {inside}");
    for said in ["MARKER-fsmonitor-RAN", "MARKER-filter-clean-RAN", "MARKER-filter-process-RAN"] {
        assert!(inside["stderr"].as_str().unwrap().contains(said), "{said}: {inside}");
    }
    // External diff and textconv: recorded, not required; Git writes a
    // temporary file for them first, which a read-only sandbox may refuse.
    for args in [&[&["git"][..], &past_process, &["diff"]].concat(), &[&["git"][..], &past_process, &["diff", "--no-ext-diff"]].concat()] {
        println!("control in the sandbox, {args:?}: {}", lab.raw(args, &work, without.clone()).await);
    }

    let marks = root.marks();
    let before = manifest(&work);
    let report = lab.read("t1").await;
    let again = lab.read("t2").await;
    assert_eq!(manifest(&work), before, "nothing in the folder, .git included, was written or touched");
    assert_eq!(root.marks(), marks);
    let text = report.to_string();
    assert!(!text.contains("MARKER-"), "none of the repository's programs ran: {report}");
    assert!(!text.contains("OUTSIDE-SECRET"), "a link is shown as a link, not followed: {report}");
    assert!(!text.contains("\\u001b["), "no color: {report}");
    assert_eq!((report["state"].as_str(), report["generation"].as_u64(), report["cwd"].as_str()), (Some("read"), Some(lab.generation()), work.to_str()));
    let tracked = report["tracked"]["text"].as_str().unwrap();
    for line in ["+changed あ line", "-あいう", "diff --git a/b.rs b/b.rs", "+fn b() {}", "+# c changed"] {
        assert!(tracked.contains(line), "{line:?} in the tracked diff, as Git read the files: {tracked}");
    }
    assert_eq!(report["tracked"]["complete"], true);
    assert_eq!(report["staged"], json!({"entries":[{"status":"R100","path":"new.rs","from":"old.rs"},{"status":"A","path":"staged-new.txt","from":null}],"complete":true,"error":null}));
    let names: Vec<&str> = report["untracked"]["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    println!("untracked as listed: {names:?}");
    assert!(!names.contains(&"ignored.log") && !names.contains(&"staged-new.txt"), "{names:?}");
    for (name, has) in [("u.txt", "+plain untracked"), ("-dash.txt", "+dash content"), ("space name.txt", "+space"),
            ("new\nline.txt", "+newline name"), ("ユニコード.txt", "+日本語"), ("bin.dat", "Binary files /dev/null and b/bin.dat differ"),
            ("empty.txt", "new file mode 100644"), ("link-out", "+../outside/secret.txt")] {
        let diff = &file(&report, name)["diff"];
        assert!(diff["text"].as_str().is_some_and(|t| t.contains(has)) && diff["complete"] == true, "{name:?} should show {has:?}: {diff}");
    }
    assert!(file(&report, "link-out")["diff"]["text"].as_str().unwrap().contains("new file mode 120000"), "a link to a file is shown as a link");
    // Git follows a link to a folder as a folder and cannot read it as a file: said, not shown as an empty file.
    let link_dir = file(&report, "link-dir");
    assert!(link_dir["diff"].is_null() && link_dir["notRead"].as_str().is_some_and(|n| n.contains("Could not access")), "{link_dir}");
    assert_eq!(file(&report, "nested/")["notRead"], "nested_repository");
    let large = &file(&report, "large.txt")["diff"];
    assert_eq!((large["complete"].as_bool(), large["notUtf8"].as_bool()), (Some(false), Some(false)), "cut at its limit, whole characters only");
    assert!(large["text"].as_str().unwrap().len() <= Limits::default().untracked_each);
    assert_eq!((report["complete"].as_bool(), report["stopped"].as_str(), report["untracked"]["listedAll"].as_bool()), (Some(false), None, Some(true)));
    // A file Git was asked about: read, or not read with Git's words (not skipped by Yuzuno).
    let skipped = ["nested_repository", "limit", "total", "stopped"];
    let read = report["untracked"]["files"].as_array().unwrap().iter()
        .filter(|f| f["notRead"].as_str().is_none_or(|n| !skipped.contains(&n))).count();
    let requests = lab.of("t1");
    let commands = requests.iter().filter(|r| r["method"] == "command/exec").count();
    assert_eq!((report["commands"].as_u64(), commands), (Some(5 + read as u64), 5 + read), "one command per step and per file read");
    assert_eq!(requests.iter().filter(|r| r["method"] == "command/exec/terminate").count(), 1, "only the capped file was stopped");
    assert!(report["bytes"].as_u64().unwrap() <= Limits::default().total as u64);
    assert_eq!((again["state"].as_str(), &again["tracked"], &again["staged"]), (Some("read"), &report["tracked"], &report["staged"]), "the same again");

    // The read's own commands again, outside any sandbox, in Codex's
    // environment with each request's variables: its settings alone run none
    // of the programs and write nothing.
    let mut replayed = 0;
    for request in lab.of("t1").iter().filter(|r| r["method"] == "command/exec") {
        let p = &request["params"];
        let argv: Vec<&str> = p["command"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
        let mut command = Command::new(argv[0]);
        command.args(&argv[1..]).current_dir(p["cwd"].as_str().unwrap()).env_clear()
            .env("HOME", root.path().join("home")).env("CODEX_HOME", root.path().join("home/.codex")).env("LANG", "C.UTF-8").env("PATH", root.default_path());
        for (key, value) in inherited.as_object().unwrap().iter().chain(p["env"].as_object().unwrap()) {
            match value.as_str() {
                Some(value) => command.env(key, value),
                None => command.env_remove(key),
            };
        }
        let out = command.output().unwrap();
        let said = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        assert!(!said.contains("MARKER-"), "{argv:?} ran a program outside the sandbox: {said}");
        replayed += 1;
    }
    println!("replayed outside the sandbox: {replayed} commands");
    assert_eq!(replayed as u64, report["commands"].as_u64().unwrap());
    assert_eq!(root.marks(), marks, "no program ran");
    assert_eq!(manifest(&work), before, "nothing was written");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "real Git and the installed Codex in a temporary folder; run in a limited Job with YUZUNO_DIFF_FIXTURE_CODEX"]
async fn real_limits_budget_cancel_and_connection_end_hold_with_codexs_own_streaming() {
    let root = Root::new();
    let work = root.repo("work");
    let lines: String = (0..400).map(|i| format!("{i} 一行目のテキスト\n")).collect();
    std::fs::write(work.join("m.txt"), &lines).unwrap();
    root.ok(&work, &["add", "."]);
    root.ok(&work, &["commit", "-q", "-m", "base"]);
    std::fs::write(work.join("m.txt"), lines.replace("一行目", "二行目")).unwrap();
    for i in 0..120 {
        std::fs::write(work.join(format!("f{i:03}.txt")), format!("file {i}\n")).unwrap();
    }
    let lab = Lab::new(&root, "lab", &work, &root.default_path(), json!({})).await;

    // Default limits: 100 of 120 files read; one command each.
    let started = Instant::now();
    let full = lab.read("t1").await;
    let whole = started.elapsed();
    println!("whole read: {:?}, {} commands", whole, full["commands"]);
    assert_eq!((full["state"].as_str(), full["stopped"].as_str(), full["tracked"]["complete"].as_bool()), (Some("read"), None, Some(true)), "{full}");
    let files = full["untracked"]["files"].as_array().unwrap();
    assert_eq!((files.len(), files.iter().filter(|f| f["diff"].is_object()).count(), files.iter().filter(|f| f["notRead"] == "limit").count()), (120, 100, 20));
    assert_eq!((full["commands"].as_u64(), lab.of("t1").len()), (Some(105), 105));

    // A cap one byte above each limit, with Codex's own streaming: exact at the
    // limit, one byte over is cut, and a cut inside a character leaves it out.
    let tracked = full["tracked"]["text"].as_str().unwrap().to_owned();
    let bytes = tracked.as_bytes();
    let inside = (bytes.len() / 2..bytes.len()).find(|&k| bytes[k] & 0xc0 == 0x80).unwrap();
    for (limit, complete) in [(bytes.len(), true), (bytes.len() - 1, false), (inside, false)] {
        *lab.ws.codex_diff.limits.lock().unwrap() = Limits { tracked: limit, untracked_files: 1, ..Limits::default() };
        let report = lab.read(&format!("cap{limit}")).await;
        let mut kept = limit;
        while !tracked.is_char_boundary(kept) { kept -= 1; }
        assert_eq!((report["tracked"]["text"].as_str(), report["tracked"]["complete"].as_bool(), report["tracked"]["notUtf8"].as_bool()),
            (Some(&tracked[..kept]), Some(complete), Some(false)), "limit {limit} of {}", bytes.len());
    }

    // One budget for the whole read: it stops among the files, and keeps what it read.
    let budget = (whole / 2).max(Duration::from_millis(800));
    *lab.ws.codex_diff.limits.lock().unwrap() = Limits { budget, ..Limits::default() };
    let started = Instant::now();
    let report = lab.read("budget").await;
    println!("budget {budget:?}: {:?}, {} commands", started.elapsed(), report["commands"]);
    assert_eq!((report["state"].as_str(), report["stopped"].as_str(), report["tracked"]["complete"].as_bool()), (Some("read"), Some("budget"), Some(true)), "{report}");
    assert!(started.elapsed() < budget + Duration::from_secs(4), "{:?}", started.elapsed());
    let timeouts: Vec<u64> = lab.of("budget").iter().filter(|r| r["method"] == "command/exec").map(|r| r["params"]["timeoutMs"].as_u64().unwrap()).collect();
    assert!(timeouts[0] <= budget.as_millis() as u64 && timeouts.windows(2).all(|w| w[1] <= w[0]), "{timeouts:?}");
    assert_eq!(report["commands"].as_u64(), Some(timeouts.len() as u64));
    *lab.ws.codex_diff.limits.lock().unwrap() = Limits::default();

    // Cancelled by its token: no command after it, none left running.
    let ws = lab.ws.clone();
    let request = Request { token: "cancel".into(), generation: lab.generation(), cwd: work.display().to_string() };
    let read = tokio::spawn(async move { ws.codex_diff("a", request).await.unwrap() });
    lab.until("twenty commands", |lab| lab.of("cancel").len() >= 20).await;
    assert_eq!(lab.cancel("cancel").await, json!({"cancelled":true}));
    let report = serde_json::to_value(read.await.unwrap()).unwrap();
    assert_eq!((report["state"].as_str(), report["stopped"].as_str()), (Some("cancelled"), Some("cancelled")), "{report}");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let commands = lab.of("cancel").iter().filter(|r| r["method"] == "command/exec").count();
    assert_eq!(report["commands"].as_u64(), Some(commands as u64), "nothing ran after the cancel");
    assert!(commands < 105);
    // Codex stops what it was running: no Git left under it, within 5 s.
    let mut left = vec![];
    for wait in 0..50 {
        left = descendants(lab.pid()).into_iter().filter(|p| p.contains(" git")).collect();
        if left.is_empty() {
            println!("cancel: no Git under Codex after {} ms more", wait * 100);
            break;
        }
        if wait == 0 { println!("cancel: still running 500 ms after: {left:?}"); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(left.is_empty(), "Git left running 5.5 s after the cancel: {left:?}");

    // The connection ends mid-read: the read ends; the next connection's read is its own.
    let first = lab.generation();
    let ws = lab.ws.clone();
    let request = Request { token: "gone".into(), generation: first, cwd: work.display().to_string() };
    let read = tokio::spawn(async move { ws.codex_diff("a", request).await.unwrap() });
    lab.until("twenty commands", |lab| lab.of("gone").len() >= 20).await;
    let old = lab.pid();
    lab.ws.remove_connection("a", first).await;
    let report = serde_json::to_value(read.await.unwrap()).unwrap();
    assert_eq!((report["stopped"].as_str(), report["complete"].as_bool(), report["generation"].as_u64()), (Some("connection"), Some(false), Some(first)), "{report}");
    let gone = lab.of("gone").len();
    lab.ws.reconnect("a").await.unwrap();
    let second = lab.generation();
    assert_ne!(first, second);
    let report = lab.read("next").await;
    assert_eq!((report["state"].as_str(), report["generation"].as_u64(), report["stopped"].as_str()), (Some("read"), Some(second), None), "{report}");
    assert_eq!(lab.of("gone").len(), gone, "nothing of the old read reached the new connection");
    assert!(lab.of("next").iter().all(|r| r["pid"] != old as u64 && r["pid"] == lab.pid() as u64));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "real Git and the installed Codex in a temporary folder; run in a limited Job with YUZUNO_DIFF_FIXTURE_CODEX"]
async fn real_reasons_a_folder_cannot_be_read_are_told_apart() {
    let root = Root::new();
    // Not a repository.
    let plain = root.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let lab = Lab::new(&root, "lab-plain", &plain, &root.default_path(), json!({})).await;
    let report = lab.read("plain").await;
    assert_eq!((report["state"].as_str(), report["reason"].as_str(), report["commands"].as_u64()), (Some("not_repository"), Some("not_work_tree"), Some(1)), "{report}");
    drop(lab);
    // A bare repository is refused by safe.bareRepository=explicit.
    let bare = root.path().join("bare.git");
    root.ok(root.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
    let lab = Lab::new(&root, "lab-bare", &bare, &root.default_path(), json!({})).await;
    let report = lab.read("bare").await;
    println!("bare: {report}");
    assert_eq!((report["state"].as_str(), report["commands"].as_u64()), (Some("failed"), Some(1)), "{report}");
    assert!(report["detail"].as_str().is_some_and(|d| d.contains("bare")), "{report}");
    drop(lab);
    // No Git where Codex runs.
    let farm = root.path().join("no-git-bin");
    std::fs::create_dir_all(&farm).unwrap();
    for entry in std::fs::read_dir("/usr/bin").unwrap().flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("git") {
            let _ = std::os::unix::fs::symlink(entry.path(), farm.join(&name));
        }
    }
    let node = root.codex.parent().unwrap().join("node");
    let _ = std::fs::remove_file(farm.join("node"));
    std::os::unix::fs::symlink(node, farm.join("node")).unwrap();
    let work = root.repo("work");
    let lab = Lab::new(&root, "lab-nogit", &work, &farm.display().to_string(), json!({})).await;
    let report = lab.read("nogit").await;
    println!("no git: {report}");
    assert_eq!((report["state"].as_str(), report["reason"].as_str(), report["commands"].as_u64()), (Some("unavailable"), Some("git_missing"), Some(1)), "{report}");
}
