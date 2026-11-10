//! S4a's binding and decisions, on synthetic trees in a temporary folder and
//! a reader that counts its reads. No OpenCode, no network, no answer sent.
use super::*;
use serde_json::json;
use std::collections::HashMap;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A synthetic home with a project, Core's data directory D (holding T and
/// O), protected locations, and a tree to search outside.
struct Lab {
    _dir: tempfile::TempDir,
    root: String,
    setup: Setup,
}

/// What a decision is checked against, owned so a test can change one part.
#[derive(Clone)]
struct Setup {
    directory: String,
    worktree: Option<String>,
    home: String,
    data: String,
    outputs: [String; 2],
    temp: Option<String>,
    dirs: Vec<String>,
    files: Vec<String>,
}

impl Lab {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap().to_str().unwrap().to_owned();
        let at = |rel: &str| format!("{root}/{rel}");
        let file = |rel: &str| {
            let path = at(rel);
            std::fs::create_dir_all(paths::parent(&path)).unwrap();
            std::fs::write(&path, "synthetic\n").unwrap();
        };
        let link = |target: &str, rel: &str| symlink(at(target), at(rel)).unwrap();
        for rel in ["home/.ssh/id_rsa", "home/.aws/credentials", "home/.aws/x.env.example", "home/.netrc", "home/notes/a.txt",
            "home/notes/x.env.example", "home/notes/prod.env", "home/proj/src/main.rs", "home/proj/.env", "home/proj/.env.example",
            "home/data/secret.db", "home/data/t/a1b2/x.txt", "home/data/t/a1b2/a.env", "home/data/t/a1b2/sub/y.txt",
            "home/data/agents/a1b2/xdg/data/opencode/tool-output/out.txt", "home/data/agents/a1b2/xdg/data/opencode/shell/s.txt",
            "ext/clean/a.txt", "ext/clean/b/c.txt", "ext/withenv/a.txt", "ext/withenv/deep/prod.env"] {
            file(rel);
        }
        link("home/.ssh", "home/proj/k");
        link("home/proj/src", "home/proj/inner");
        link("home/.ssh/id_rsa", "home/data/t/a1b2/k");
        link("home/.aws", "home/data/t/a1b2/aws");
        std::fs::create_dir_all(at("ext/linked")).unwrap();
        link("home/.ssh/id_rsa", "ext/linked/k");
        let setup = Setup {
            directory: at("home/proj"),
            worktree: None,
            home: at("home"),
            data: at("home/data"),
            outputs: [at("home/data/agents/a1b2/xdg/data/opencode/shell"), at("home/data/agents/a1b2/xdg/data/opencode/tool-output")],
            temp: Some(at("home/data/t/a1b2")),
            dirs: vec![at("home/.ssh"), at("home/.aws")],
            files: vec![at("home/.netrc")],
        };
        Self { _dir: dir, root, setup }
    }

    fn at(&self, rel: &str) -> String {
        format!("{}/{rel}", self.root)
    }

    fn temp(&self) -> String {
        self.setup.temp.clone().unwrap()
    }
}

impl Setup {
    fn decide_within(&self, action: &str, resources: &[String], tool: Tool, input: Value, budget: &Budget, clock: &dyn Clock) -> Decision {
        let dirs: Vec<&Path> = self.dirs.iter().map(path).collect();
        let files: Vec<&Path> = self.files.iter().map(path).collect();
        let rules = Rules {
            directory: path(&self.directory),
            worktree: self.worktree.as_ref().map(path),
            home: path(&self.home),
            data_dir: path(&self.data),
            outputs: [path(&self.outputs[0]), path(&self.outputs[1])],
            temp: self.temp.as_ref().map(path),
            protected_dirs: &dirs,
            protected_files: &files,
        };
        decide(&asked(action, resources), &call(tool, input), &rules, budget, clock)
    }

    fn decide(&self, action: &str, resources: &[String], tool: Tool, input: Value) -> Decision {
        self.decide_within(action, resources, tool, input, &BUDGET, &Wall)
    }

    fn answer(&self, action: &str, resources: &[String], tool: Tool, input: Value) -> Answer {
        self.decide(action, resources, tool, input).answer
    }
}

/// A trusted path, as `Rules` takes it.
fn path(text: &String) -> &Path {
    Path::new(text.as_str())
}

fn asked(action: &str, resources: &[String]) -> Asked {
    Asked { id: "per_1".into(), session: "ses_main".into(), action: action.into(), resources: Some(resources.to_vec()),
        source: Some(Source { message: "msg_1".into(), call: "call_1".into() }) }
}

fn call(tool: Tool, input: Value) -> Call {
    Call { generation: 7, session: "ses_main".into(), message: "msg_1".into(), call: "call_1".into(), tool, input, read: false }
}

fn star(dir: &str) -> Vec<String> {
    vec![format!("{dir}/*")]
}

fn one(text: &str) -> Vec<String> {
    vec![text.to_owned()]
}

fn reject(reason: Reason) -> Answer {
    Answer::Reject(reason)
}

/// A clock that moves on by `step` each time it is read.
struct Ticking {
    start: Instant,
    step: Duration,
    reads: AtomicU32,
}

impl Clock for Ticking {
    fn now(&self) -> Instant {
        self.start + self.step * self.reads.fetch_add(1, Ordering::SeqCst)
    }
}

/// A reader of stored messages by ID that counts its reads, and can end the
/// connection's generation while it reads.
#[derive(Default)]
struct Reader {
    messages: HashMap<String, Value>,
    failing: bool,
    reads: AtomicUsize,
    ends: Option<Arc<AtomicBool>>,
}

impl MessageReader for Reader {
    async fn message(&self, _session: &str, message: &str) -> anyhow::Result<Option<Value>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if let Some(current) = &self.ends {
            current.store(false, Ordering::SeqCst);
        }
        anyhow::ensure!(!self.failing, "the read failed");
        Ok(self.messages.get(message).cloned())
    }
}

fn tool_entry(id: &str, name: &str, status: &str, input: Value) -> Value {
    json!({"type": "tool", "id": id, "name": name, "state": {"status": status, "input": input}})
}

fn answer_message(id: &str, content: Vec<Value>) -> Value {
    json!({"id": id, "type": "assistant", "content": content})
}

fn request(session: &str, action: &str, message: &str, call: &str) -> Asked {
    Asked::read(&json!({"id": "per_1", "sessionID": session, "action": action, "resources": ["/*"],
        "source": {"type": "tool", "messageID": message, "id": call}})).unwrap()
}

fn tool_event(kind: &str, message: &str, call: &str, extra: Value) -> Value {
    let mut data = json!({"sessionID": "ses_main", "assistantMessageID": message, "id": call});
    data.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({"type": kind, "data": data})
}

async fn bound(asked: &Asked, calls: &Calls, reader: &Reader, current: &AtomicBool) -> Result<Call, Unbound> {
    let children = vec!["ses_child".to_owned()];
    let on = Connection { generation: 7, session: "ses_main", children: &children };
    bind(asked, &on, calls, reader, &|| current.load(Ordering::SeqCst)).await
}

/// 2.3.1: what OpenCode reported on the connection binds with no read; a
/// call not seen, with one; and a request that can't be proven one running
/// call of a known tool, matching its action, with whole input, is refused.
#[tokio::test]
async fn a_request_binds_only_to_one_running_call_it_can_name() {
    let calls = Calls::default();
    let current = AtomicBool::new(true);
    calls.ingest_event(7, &tool_event("session.tool.input.started", "msg_1", "call_1", json!({"name": "read"})));
    calls.ingest_event(7, &tool_event("session.tool.called", "msg_1", "call_1", json!({"input": {"path": "a.txt"}})));
    let reader = Reader::default();
    let hit = bound(&request("ses_main", "read", "msg_1", "call_1"), &calls, &reader, &current).await.unwrap();
    assert_eq!((hit.tool, &hit.input, hit.read), (Tool::Read, &json!({"path": "a.txt"}), false));
    assert_eq!(reader.reads.load(Ordering::SeqCst), 0, "a call seen running takes no read");

    // Refused before any read.
    let mut no_source = request("ses_main", "read", "msg_1", "call_1");
    no_source.source = None;
    assert_eq!(bound(&no_source, &calls, &reader, &current).await, Err(Unbound::NotATool));
    assert_eq!(bound(&request("ses_other", "read", "msg_1", "call_1"), &calls, &reader, &current).await, Err(Unbound::NotThisConnection));
    current.store(false, Ordering::SeqCst);
    assert_eq!(bound(&request("ses_main", "read", "msg_1", "call_1"), &calls, &reader, &current).await, Err(Unbound::Stale));
    current.store(true, Ordering::SeqCst);
    assert_eq!(bound(&request("ses_main", "grep", "msg_1", "call_1"), &calls, &reader, &current).await, Err(Unbound::Mismatch));
    calls.ingest_event(7, &tool_event("session.tool.success", "msg_1", "call_1", json!({})));
    assert_eq!(bound(&request("ses_main", "read", "msg_1", "call_1"), &calls, &reader, &current).await, Err(Unbound::Ended));
    // Two inputs for one call can't both be it: neither is chosen.
    calls.ingest_event(7, &tool_event("session.tool.input.started", "msg_1", "call_2", json!({"name": "read"})));
    calls.ingest_event(7, &tool_event("session.tool.called", "msg_1", "call_2", json!({"input": {"path": "a"}})));
    calls.ingest_event(7, &tool_event("session.tool.called", "msg_1", "call_2", json!({"input": {"path": "b"}})));
    assert_eq!(bound(&request("ses_main", "read", "msg_1", "call_2"), &calls, &reader, &current).await, Err(Unbound::NotOne(None)));
    // An older generation's report is not this one's evidence.
    calls.ingest_event(6, &tool_event("session.tool.called", "msg_1", "call_3", json!({"input": {"path": "a"}})));
    assert_eq!(reader.reads.load(Ordering::SeqCst), 0);

    // Each of these takes exactly one read.
    let messages = HashMap::from([
        ("msg_a".to_owned(), answer_message("msg_a", vec![tool_entry("call_1", "read", "running", json!({"path": "/a"}))])),
        ("msg_b".to_owned(), answer_message("msg_b", vec![tool_entry("call_1", "read", "running", json!({"path": "/b"}))])),
        ("msg_done".to_owned(), answer_message("msg_done", vec![tool_entry("call_1", "read", "completed", json!({"path": "/a"}))])),
        ("msg_stream".to_owned(), answer_message("msg_stream", vec![tool_entry("call_1", "read", "streaming", json!("{\"pa"))])),
        ("msg_half".to_owned(), answer_message("msg_half", vec![tool_entry("call_1", "read", "running", json!({"offset": 1}))])),
        ("msg_twice".to_owned(), answer_message("msg_twice", vec![tool_entry("call_1", "read", "running", json!({"path": "/a"})),
            tool_entry("call_1", "read", "running", json!({"path": "/b"}))])),
        ("msg_web".to_owned(), answer_message("msg_web", vec![tool_entry("call_1", "webfetch", "running", json!({"url": "x"}))])),
        ("msg_user".to_owned(), json!({"id": "msg_user", "type": "user", "content": [tool_entry("call_1", "read", "running", json!({"path": "/a"}))]})),
        ("msg_wrong".to_owned(), answer_message("msg_other", vec![tool_entry("call_1", "read", "running", json!({"path": "/a"}))])),
    ]);
    let cases: [(&str, &str, &str, Result<&str, Unbound>); 12] = [
        ("ses_child", "msg_a", "call_1", Ok("/a")),
        // The same call ID in another message is another call.
        ("ses_main", "msg_b", "call_1", Ok("/b")),
        ("ses_main", "msg_1", "call_3", Err(Unbound::Gone)),
        ("ses_main", "msg_done", "call_1", Err(Unbound::Ended)),
        ("ses_main", "msg_stream", "call_1", Err(Unbound::Incomplete)),
        ("ses_main", "msg_half", "call_1", Err(Unbound::Incomplete)),
        ("ses_main", "msg_twice", "call_1", Err(Unbound::NotOne(Some(2)))),
        ("ses_main", "msg_a", "call_9", Err(Unbound::NotOne(Some(0)))),
        ("ses_main", "msg_web", "call_1", Err(Unbound::UnknownTool)),
        ("ses_main", "msg_user", "call_1", Err(Unbound::NotOne(Some(0)))),
        ("ses_main", "msg_wrong", "call_1", Err(Unbound::Unread)),
        ("ses_main", "msg_gone", "call_1", Err(Unbound::Gone)),
    ];
    for (session, message, call, expected) in cases {
        let reader = Reader { messages: messages.clone(), ..Reader::default() };
        let got = bound(&request(session, "external_directory", message, call), &Calls::default(), &reader, &current).await;
        assert_eq!(got.map(|call| call.input["path"].as_str().unwrap().to_owned()), expected.map(str::to_owned), "{session} {message} {call}");
        assert_eq!(reader.reads.load(Ordering::SeqCst), 1, "{message}: one read");
    }

    // A read that contradicts what OpenCode reported of the call can't be either.
    let seen_as_grep = Calls::default();
    seen_as_grep.ingest_event(7, &tool_event("session.tool.input.started", "msg_a", "call_1", json!({"name": "grep"})));
    let reader = Reader { messages: messages.clone(), ..Reader::default() };
    assert_eq!(bound(&request("ses_main", "external_directory", "msg_a", "call_1"), &seen_as_grep, &reader, &current).await,
        Err(Unbound::NotOne(None)));

    // A failed read, and a generation that changes while it reads.
    let failing = Reader { messages: messages.clone(), failing: true, ..Reader::default() };
    assert_eq!(bound(&request("ses_main", "read", "msg_a", "call_1"), &Calls::default(), &failing, &current).await, Err(Unbound::Unread));
    let ends = Arc::new(AtomicBool::new(true));
    let changing = Reader { messages, ends: Some(ends.clone()), ..Reader::default() };
    assert_eq!(bound(&request("ses_main", "read", "msg_a", "call_1"), &Calls::default(), &changing, &ends).await, Err(Unbound::Stale));
    assert_eq!(changing.reads.load(Ordering::SeqCst), 1);
}

/// A newer generation forgets the older's calls, and an older one's late
/// report changes nothing.
#[test]
fn calls_hold_one_generation() {
    let calls = Calls::default();
    let key = ("ses_main".to_owned(), "msg_1".to_owned(), "call_1".to_owned());
    calls.ingest_event(7, &tool_event("session.tool.called", "msg_1", "call_1", json!({"input": {"path": "a"}})));
    assert!(calls.seen(7, &key).is_some());
    calls.ingest_event(8, &tool_event("session.tool.progress", "msg_1", "call_2", json!({})));
    assert_eq!(calls.seen(7, &key), None);
    assert_eq!(calls.seen(8, &key), None);
    calls.ingest_event(7, &tool_event("session.tool.called", "msg_1", "call_1", json!({"input": {"path": "a"}})));
    assert_eq!(calls.seen(8, &key), None, "a late report of generation 7 is not generation 8's");
    // A state going back is two calls under one ID.
    calls.ingest_event(8, &tool_event("session.tool.called", "msg_1", "call_1", json!({"input": {"path": "a"}})));
    calls.ingest_event(8, &tool_event("session.tool.input.started", "msg_1", "call_1", json!({"name": "read"})));
    assert!(calls.seen(8, &key).unwrap().ambiguous);
}

/// Rule 1 comes first: an action nobody can approve is refused before any
/// read, and with it no call is bound.
#[tokio::test]
async fn an_action_nobody_approves_is_refused_before_any_read() {
    let lab = Lab::new();
    let s = &lab.setup;
    let reader = Reader::default();
    let children: Vec<String> = Vec::new();
    let on = Connection { generation: 7, session: "ses_main", children: &children };
    let rules = Rules { directory: path(&s.directory), worktree: None, home: path(&s.home), data_dir: path(&s.data),
        outputs: [path(&s.outputs[0]), path(&s.outputs[1])], temp: s.temp.as_ref().map(path), protected_dirs: &[], protected_files: &[] };
    for action in ["edit", "shell", "doom_loop", "webfetch", "task"] {
        let decision = answer(&request("ses_main", action, "msg_1", "call_1"), &on, &Calls::default(), &reader, &|| true, &rules, &BUDGET, &Wall).await;
        assert_eq!(decision, Decision { answer: reject(Reason::Action(action.into())), call: None, targets: vec![] });
    }
    assert_eq!(reader.reads.load(Ordering::SeqCst), 0);
    let unbound = answer(&request("ses_main", "read", "msg_1", "call_1"), &on, &Calls::default(), &reader, &|| true, &rules, &BUDGET, &Wall).await;
    assert_eq!(unbound.answer, reject(Reason::Unbound(Unbound::Gone)));
    assert_eq!(reader.reads.load(Ordering::SeqCst), 1);
}

/// Rule 6: a real target in the project keeps the internal policy. Only a
/// `.env` file's read is refused; a search of the project is allowed with
/// no scan (R1); a link inside to inside is inside.
#[test]
fn inside_the_project_the_internal_policy_holds() {
    let lab = Lab::new();
    let s = &lab.setup;
    let read = |path: &str| s.answer("read", &one(path), Tool::Read, json!({"path": path}));
    assert_eq!(read("src/main.rs"), Answer::Once);
    assert_eq!(read("inner/main.rs"), Answer::Once, "a link inside to inside");
    assert_eq!(read(".env"), reject(Reason::EnvFile));
    assert_eq!(read(".env.example"), Answer::Once);
    assert_eq!(read("src"), Answer::Once);
    assert_eq!(s.answer("read", &one("src/main.rs"), Tool::Read, json!({"path": lab.at("home/proj/src/main.rs")})), Answer::Once,
        "an absolute path inside is named relative to the folder");
    assert_eq!(s.answer("grep", &one("SECRET"), Tool::Grep, json!({"pattern": "SECRET"})), Answer::Once, "R1: no scan of the project");
    assert_eq!(s.answer("glob", &one("**/*"), Tool::Glob, json!({"pattern": "**/*", "path": "undefined"})), Answer::Once);
    // The worktree counts as inside when it isn't `/`.
    let wide = Setup { directory: lab.at("home/proj/src"), worktree: Some(lab.at("home/proj")), ..s.clone() };
    assert_eq!(wide.answer("read", &one("../.env.example"), Tool::Read, json!({"path": "../.env.example"})), Answer::Once);
    assert_eq!(wide.answer("read", &one("../.env"), Tool::Read, json!({"path": "../.env"})), reject(Reason::EnvFile));
    let root = Setup { worktree: Some("/".into()), ..s.clone() };
    assert_eq!(root.answer("external_directory", &star(&lab.at("home/notes")), Tool::Read, json!({"path": lab.at("home/notes/a.txt")})),
        Answer::Once, "a worktree of / makes nothing inside");
}

/// R2: data a link in the project points to outside is outside. A read of a
/// file, a grep of a file or folder, and a glob through `repo/k → ~/.ssh` are
/// refused, though OpenCode calls their paths inside.
#[test]
fn a_link_in_the_project_to_a_protected_location_is_outside() {
    let lab = Lab::new();
    let s = &lab.setup;
    assert_eq!(s.answer("read", &one("k/id_rsa"), Tool::Read, json!({"path": "k/id_rsa"})), reject(Reason::Protected));
    assert_eq!(s.answer("grep", &one("BEGIN"), Tool::Grep, json!({"pattern": "BEGIN", "path": "k/id_rsa"})), reject(Reason::Protected));
    assert_eq!(s.answer("grep", &one("BEGIN"), Tool::Grep, json!({"pattern": "BEGIN", "path": "k"})), reject(Reason::Protected));
    assert_eq!(s.answer("glob", &one("*"), Tool::Glob, json!({"pattern": "*", "path": "k"})), reject(Reason::Protected));
    let decision = s.decide("read", &one("k/id_rsa"), Tool::Read, json!({"path": "k/id_rsa"}));
    assert_eq!(decision.targets, vec![Target { literal: lab.at("home/proj/k/id_rsa"), real: Some(lab.at("home/.ssh/id_rsa")) }]);
}

/// Rule 7 for reads outside: by real location, a protected location before
/// any file name exception; D refused but for O and T; `.env` refused.
#[test]
fn outside_a_read_is_judged_by_where_it_really_is() {
    let lab = Lab::new();
    let s = &lab.setup;
    let t = lab.temp();
    let both = |path: &str, folder: &str| {
        let folder_answer = s.answer("external_directory", &star(folder), Tool::Read, json!({"path": path}));
        let read_answer = s.answer("read", &one(path), Tool::Read, json!({"path": path}));
        assert_eq!(folder_answer, read_answer, "{path}: the two requests of one call are judged alike");
        read_answer
    };
    assert_eq!(both(&lab.at("home/notes/a.txt"), &lab.at("home/notes")), Answer::Once);
    assert_eq!(both(&lab.at("home/notes/x.env.example"), &lab.at("home/notes")), Answer::Once);
    assert_eq!(both(&lab.at("home/notes/prod.env"), &lab.at("home/notes")), reject(Reason::EnvFile));
    assert_eq!(both(&lab.at("home/.ssh/id_rsa"), &lab.at("home/.ssh")), reject(Reason::Protected));
    assert_eq!(both(&lab.at("home/.aws/x.env.example"), &lab.at("home/.aws")), reject(Reason::Protected), "protected before the exception");
    assert_eq!(both(&lab.at("home/.netrc"), &lab.at("home")), reject(Reason::Protected));
    assert_eq!(both(&lab.at("home/data/secret.db"), &lab.at("home/data")), reject(Reason::CoreData));
    let output = lab.at("home/data/agents/a1b2/xdg/data/opencode/tool-output");
    assert_eq!(both(&format!("{output}/out.txt"), &output), Answer::Once, "O is read though in D");
    assert_eq!(both(&format!("{t}/x.txt"), &t), Answer::Once, "T is read though in D");
    assert_eq!(both(&format!("{t}/a.env"), &t), reject(Reason::EnvFile));
    assert_eq!(both(&format!("{t}/k"), &t), reject(Reason::Protected), "T/k → ~/.ssh/id_rsa");
    assert_eq!(both(&format!("{t}/aws/credentials"), &format!("{t}/aws")), reject(Reason::Protected), "T/aws → ~/.aws");
    // A folder's read lists one level of names: judged by where it is.
    assert_eq!(both(&lab.at("home"), &lab.at("home")), Answer::Once);
    assert_eq!(both(&lab.at("home/.ssh"), &lab.at("home/.ssh")), reject(Reason::Protected));
    assert_eq!(both(&lab.at("home/data"), &lab.at("home/data")), reject(Reason::CoreData));
    assert_eq!(both(&lab.at("home/missing.txt"), &lab.at("home")), reject(Reason::Unchecked));
    assert_eq!(s.answer("read", &one(&lab.at("home/notes/a.txt")), Tool::Read, json!({"path": "~/notes/a.txt"})), Answer::Once, "~ is the home");
    // Without T, T is only a part of D.
    let none = Setup { temp: None, ..s.clone() };
    assert_eq!(none.answer("read", &one(&format!("{t}/x.txt")), Tool::Read, json!({"path": format!("{t}/x.txt")})), reject(Reason::CoreData));
    // A protected location inside T stays protected.
    let inner = Setup { dirs: vec![format!("{t}/sub")], ..s.clone() };
    assert_eq!(inner.answer("read", &one(&format!("{t}/sub/y.txt")), Tool::Read, json!({"path": format!("{t}/sub/y.txt")})),
        reject(Reason::Protected));
}

/// Rule 7 for searches outside: a glob's root may not be in or above a
/// protected location or D, or be `/`; a grep of a folder must also be
/// proven free of `.env` files within the budget, without following links.
#[test]
fn outside_a_search_must_prove_it_reaches_nothing_protected() {
    let lab = Lab::new();
    let s = &lab.setup;
    let t = lab.temp();
    let glob = |path: &str| s.answer("glob", &one("**/*"), Tool::Glob, json!({"pattern": "**/*", "path": path}));
    let grep = |path: &str| s.answer("grep", &one("key"), Tool::Grep, json!({"pattern": "key", "path": path}));
    assert_eq!(glob(&lab.at("home/notes")), Answer::Once);
    assert_eq!(glob("~"), reject(Reason::SearchRoot), "the home holds .ssh and D");
    assert_eq!(glob("/"), reject(Reason::SearchRoot));
    assert_eq!(glob(&lab.at("home/.aws")), reject(Reason::Protected));
    assert_eq!(glob(&lab.at("home/data")), reject(Reason::CoreData));
    assert_eq!(glob(&t), Answer::Once, "names only: T/k is listed, not followed");
    assert_eq!(s.answer("external_directory", &star(&lab.at("home/notes")), Tool::Glob, json!({"pattern": "*", "path": lab.at("home/notes")})),
        Answer::Once);

    assert_eq!(grep(&lab.at("ext/clean")), Answer::Once);
    assert_eq!(grep(&lab.at("ext/withenv")), reject(Reason::SearchScan), ".env at depth");
    assert_eq!(grep(&lab.at("ext/withenv/a.txt")), Answer::Once, "a file is a read");
    assert_eq!(grep(&lab.at("ext/withenv/deep/prod.env")), reject(Reason::EnvFile));
    assert_eq!(grep(&lab.at("home/.netrc")), reject(Reason::Protected));
    assert_eq!(grep("~"), reject(Reason::SearchRoot));
    assert_eq!(grep(&t), reject(Reason::SearchScan), "T holds a.env, and T/k names ~/.ssh/id_rsa");
    assert_eq!(grep(&lab.at("ext/linked")), reject(Reason::SearchScan), "a link to a protected file");
    assert_eq!(s.answer("external_directory", &star(&lab.at("ext/clean")), Tool::Grep, json!({"pattern": "x", "path": lab.at("ext/clean")})),
        Answer::Once);

    // The budget: entries, and time read from a clock the test moves.
    let clean = || (one("key"), json!({"pattern": "key", "path": lab.at("ext/clean")}));
    let (resources, input) = clean();
    let few = Budget { entries: 2, time: Duration::from_secs(2) };
    assert_eq!(s.decide_within("grep", &resources, Tool::Grep, input.clone(), &few, &Wall).answer, reject(Reason::SearchScan));
    let slow = Ticking { start: Instant::now(), step: Duration::from_millis(400), reads: AtomicU32::new(0) };
    assert_eq!(s.decide_within("grep", &resources, Tool::Grep, input.clone(), &BUDGET, &slow).answer, reject(Reason::SearchScan));
    let enough = Budget { entries: 8, time: Duration::from_secs(2) };
    assert_eq!(s.decide_within("grep", &resources, Tool::Grep, input, &enough, &Wall).answer, Answer::Once);
}

/// What a folder question, a read and a grep of file `path` outside the
/// project are answered.
fn three(s: &Setup, path: &str) -> [Answer; 3] {
    [s.answer("external_directory", &star(paths::parent(path)), Tool::Read, json!({"path": path})),
        s.answer("read", &one(path), Tool::Read, json!({"path": path})),
        s.answer("grep", &one("key"), Tool::Grep, json!({"pattern": "key", "path": path}))]
}

/// Replaces folder `path` with a link to `target`, as a shell in the
/// executor could before a request.
fn relink(path: &str, target: &str) {
    std::fs::remove_dir_all(path).unwrap();
    symlink(target, path).unwrap();
}

/// An output folder counts only as given: replaced by a link into D or into
/// another Agent's folder there, given through a linked folder, or holding
/// D, it grants nothing; a target is made real, a root is not. One that is
/// its own real path still does.
#[test]
fn an_output_folder_replaced_by_a_link_grants_nothing() {
    let once = [Answer::Once, Answer::Once, Answer::Once];
    let core_data = [reject(Reason::CoreData), reject(Reason::CoreData), reject(Reason::CoreData)];
    let lab = Lab::new();
    let s = &lab.setup;
    let [o1, o2] = s.outputs.clone();
    assert_eq!(three(s, &format!("{o2}/out.txt")), once, "O as given");
    relink(&o2, &s.data);
    assert_eq!(three(s, &format!("{o2}/secret.db")), core_data, "O → D");
    assert_eq!(three(s, &format!("{o1}/s.txt")), once, "the other O as given");

    let lab = Lab::new();
    let s = &lab.setup;
    let other = lab.at("home/data/agents/zz99/private");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(format!("{other}/key.txt"), "synthetic\n").unwrap();
    relink(&s.outputs[1], &other);
    assert_eq!(three(s, &format!("{}/key.txt", s.outputs[1])), core_data, "O → another Agent's folder in D");

    // Given through a linked folder, or holding D: no exception either.
    let lab = Lab::new();
    let s = &lab.setup;
    symlink(paths::parent(&s.outputs[1]), lab.at("home/olink")).unwrap();
    let linked = Setup { outputs: [s.outputs[0].clone(), lab.at("home/olink/tool-output")], ..s.clone() };
    assert_eq!(three(&linked, &lab.at("home/olink/tool-output/out.txt")), core_data, "O given through a link");
    let wide = Setup { outputs: [s.outputs[0].clone(), s.home.clone()], ..s.clone() };
    assert_eq!(three(&wide, &lab.at("home/data/secret.db")), core_data, "O holding D");
}

/// T counts only as given too: replaced by a link into D, or into another
/// Agent's folder there, nothing may be read, written or run in it.
#[test]
fn a_temporary_directory_replaced_by_a_link_grants_nothing() {
    let lab = Lab::new();
    let s = &lab.setup;
    let t = lab.temp();
    relink(&t, &s.data);
    assert_eq!(three(s, &format!("{t}/secret.db")), [reject(Reason::CoreData), reject(Reason::CoreData), reject(Reason::CoreData)], "T → D");
    assert_eq!(s.answer("external_directory", &star(&t), Tool::Write, json!({"path": format!("{t}/new.txt"), "content": "x"})),
        reject(Reason::WriteOutside));
    assert_eq!(s.answer("external_directory", &star(&t), Tool::Shell, json!({"command": "ls", "workdir": t})), reject(Reason::ShellOutside));
    assert_eq!(s.answer("external_directory", &star(&t), Tool::Patch,
        json!({"patchText": format!("*** Begin Patch\n*** Add File: {t}/p.txt\n+p\n*** End Patch")})), reject(Reason::WriteOutside));

    let lab = Lab::new();
    let s = &lab.setup;
    let t = lab.temp();
    let other = lab.at("home/data/agents/zz99/private");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(format!("{other}/key.txt"), "synthetic\n").unwrap();
    relink(&t, &other);
    assert_eq!(s.answer("read", &one(&format!("{t}/key.txt")), Tool::Read, json!({"path": format!("{t}/key.txt")})),
        reject(Reason::CoreData), "T → another Agent's folder in D");
    assert_eq!(s.answer("external_directory", &star(&t), Tool::Write, json!({"path": format!("{t}/key.txt"), "content": "x"})),
        reject(Reason::WriteOutside));
}

/// The project's roots count only as given: a folder or worktree replaced by
/// a link into D doesn't make D inside.
#[test]
fn a_project_root_replaced_by_a_link_is_not_inside() {
    let lab = Lab::new();
    let s = &lab.setup;
    symlink(&s.data, lab.at("home/proj2")).unwrap();
    let folder = Setup { directory: lab.at("home/proj2"), ..s.clone() };
    assert_eq!(folder.answer("read", &one("secret.db"), Tool::Read, json!({"path": "secret.db"})), reject(Reason::CoreData), "folder → D");
    assert_eq!(folder.answer("grep", &one("key"), Tool::Grep, json!({"pattern": "key"})), reject(Reason::CoreData));
    symlink(&s.data, lab.at("home/wt")).unwrap();
    let worktree = Setup { worktree: Some(lab.at("home/wt")), ..s.clone() };
    assert_eq!(worktree.answer("read", &one("../wt/secret.db"), Tool::Read, json!({"path": "../wt/secret.db"})), reject(Reason::CoreData),
        "worktree → D");
    assert_eq!(s.answer("read", &one("src/main.rs"), Tool::Read, json!({"path": "src/main.rs"})), Answer::Once, "the folder as given");
}

/// Rules 3 and 4: a write outside the folder is allowed only when its real
/// target is in T and not protected, a link followed; a patch's targets
/// aren't parsed, so it is refused.
#[test]
fn a_write_outside_is_allowed_only_really_in_temp() {
    let lab = Lab::new();
    let s = &lab.setup;
    let t = lab.temp();
    let write = |path: &str, folder: &str| s.answer("external_directory", &star(folder), Tool::Write, json!({"path": path, "content": "x"}));
    assert_eq!(write(&format!("{t}/x.txt"), &t), Answer::Once);
    assert_eq!(write(&format!("{t}/new/deeper/file.txt"), &format!("{t}/new/deeper")), Answer::Once, "a new file under its nearest folder");
    assert_eq!(write(&format!("{t}/k"), &t), reject(Reason::WriteOutside), "T/k → ~/.ssh/id_rsa");
    assert_eq!(write(&format!("{t}/aws/x"), &format!("{t}/aws")), reject(Reason::WriteOutside), "T/aws → ~/.aws");
    assert_eq!(write(&lab.at("home/notes/b.txt"), &lab.at("home/notes")), reject(Reason::WriteOutside));
    assert_eq!(write("/tmp/opencode/yn77/x", "/tmp/opencode/yn77"), reject(Reason::WriteOutside));
    assert_eq!(s.answer("external_directory", &star(&t), Tool::Edit, json!({"path": format!("{t}/x.txt"), "oldString": "a", "newString": "b"})),
        Answer::Once);
    assert_eq!(s.answer("external_directory", &star(&t), Tool::ImageGenerate, json!({})), reject(Reason::WriteOutside));
    let none = Setup { temp: None, ..s.clone() };
    assert_eq!(none.answer("external_directory", &star(&t), Tool::Write, json!({"path": format!("{t}/x.txt"), "content": "x"})),
        reject(Reason::WriteOutside));
    let inner = Setup { dirs: vec![format!("{t}/sub")], ..s.clone() };
    assert_eq!(inner.answer("external_directory", &star(&format!("{t}/sub")), Tool::Write, json!({"path": format!("{t}/sub/y.txt"), "content": "x"})),
        reject(Reason::WriteOutside), "a protected location in T");
}

/// Rules 3 and 4 for a patch: every file it names as OpenCode's parser reads
/// it, and both sides of a move, must really be in T; each of the patch's
/// folder requests is judged by all of them.
#[test]
fn a_patch_outside_is_allowed_only_with_every_file_in_temp() {
    let lab = Lab::new();
    let s = &lab.setup;
    let t = lab.temp();
    let sub = format!("{t}/sub");
    let patch = |body: &str| json!({"patchText": format!("*** Begin Patch\n{body}\n*** End Patch")});
    let ask = |folder: &str, body: &str| s.answer("external_directory", &star(folder), Tool::Patch, patch(body));
    let all_in_t = format!("*** Add File: {t}/new.txt\n+new\n*** Update File: {t}/x.txt\n@@\n-synthetic\n+changed\n\
        *** Delete File: {sub}/y.txt\n*** Update File: {t}/x.txt\n*** Move to: {sub}/z.txt\n@@\n-changed\n+moved");
    assert_eq!(ask(&t, &all_in_t), Answer::Once);
    assert_eq!(ask(&sub, &all_in_t), Answer::Once, "each folder request of the call");
    let decision = s.decide("external_directory", &star(&t), Tool::Patch, patch(&all_in_t));
    assert_eq!(decision.targets.iter().map(|target| target.literal.as_str()).collect::<Vec<_>>(),
        [format!("{t}/new.txt"), format!("{t}/x.txt"), format!("{sub}/y.txt"), format!("{t}/x.txt"), format!("{sub}/z.txt")]);
    // As OpenCode reads it: a heredoc wrapper, CRLF lines, an environment line.
    let wrapped = format!("cat <<'EOF'\r\n*** Begin Patch\r\n*** Environment ID: lab\r\n*** Add File: {t}/w.txt\r\n+w\r\n*** End Patch\r\nEOF");
    assert_eq!(s.answer("external_directory", &star(&t), Tool::Patch, json!({"patchText": wrapped})), Answer::Once);
    // An indented header in an update's body is its context, not a file it names.
    let context = format!("*** Update File: {t}/x.txt\n@@\n-synthetic\n *** Update File: /etc/passwd\n+changed");
    assert_eq!(ask(&t, &context), Answer::Once);
    assert_eq!(ask("/etc", &context), reject(Reason::Unbound(Unbound::Resources)), "/etc is no file of this patch");

    let notes = lab.at("home/notes");
    let refused = [
        (t.clone(), format!("*** Add File: {t}/a.txt\n+a\n*** Add File: {notes}/b.txt\n+b")),
        (t.clone(), format!("*** Add File: {t}/a.txt\n+a\n*** Add File: src/new.rs\n+b")),
        (t.clone(), format!("*** Update File: {t}/k\n@@\n-synthetic\n+x")),
        (t.clone(), format!("*** Delete File: {t}/k")),
        (format!("{t}/aws"), format!("*** Add File: {t}/aws/new\n+x")),
        (t.clone(), format!("*** Update File: {t}/x.txt\n*** Move to: {notes}/x.txt\n@@\n-synthetic\n+x")),
        (notes.clone(), format!("*** Update File: {notes}/a.txt\n*** Move to: {t}/a.txt\n@@\n-synthetic\n+x")),
        ("/tmp/opencode/yn77".to_owned(), "*** Add File: /tmp/opencode/yn77/x\n+x".to_owned()),
    ];
    for (folder, body) in &refused {
        assert_eq!(ask(folder, body), reject(Reason::WriteOutside), "{body}");
    }
    let inner = Setup { dirs: vec![sub.clone()], ..s.clone() };
    assert_eq!(inner.answer("external_directory", &star(&sub), Tool::Patch, patch(&format!("*** Add File: {sub}/n.txt\n+n"))),
        reject(Reason::WriteOutside), "a protected location in T");
    let none = Setup { temp: None, ..s.clone() };
    assert_eq!(none.answer("external_directory", &star(&t), Tool::Patch, patch(&format!("*** Add File: {t}/n.txt\n+n"))),
        reject(Reason::WriteOutside));
    for unreadable in ["*** Begin Patch".to_owned(), "*** Begin Patch\n*** End Patch".to_owned(),
        format!("*** Begin Patch\n*** Add File: {t}/n.txt\nnot a + line\n*** End Patch"),
        format!("*** Begin Patch\n*** Update File: {t}/x.txt\n*** Move to: \n@@\n-a\n+b\n*** End Patch")] {
        assert_eq!(s.answer("external_directory", &star(&t), Tool::Patch, json!({"patchText": unreadable})), reject(Reason::PatchUnchecked),
            "{unreadable}");
    }
}

/// Rules 3 and 5: a shell call outside the folder is allowed only when its
/// working folder and every directory it states it changes to are really in
/// T; a mixed set, or one Core can't read whole, is refused.
#[test]
fn a_shell_outside_is_allowed_only_with_every_directory_in_temp() {
    let lab = Lab::new();
    let s = &lab.setup;
    let t = lab.temp();
    let shell = |workdir: &str, command: &str, resources: Vec<String>| {
        s.answer("external_directory", &resources, Tool::Shell, json!({"command": command, "workdir": workdir}))
    };
    let sub = format!("{t}/sub");
    let in_t = || star(&t);
    assert_eq!(shell(&t, "ls -la && make test 2>&1 > out.txt", in_t()), Answer::Once);
    assert_eq!(shell(&t, &format!("cd {sub} && ls"), vec![format!("{t}/*"), format!("{sub}/*")]), Answer::Once);
    assert_eq!(shell(&t, &format!("cd '{sub}' | cat"), in_t()), Answer::Once, "a quoted absolute change");
    assert_eq!(shell(&t, "cd ./sub && ls", in_t()), Answer::Once, "a relative change first");
    assert_eq!(shell(&format!("{t}/aws"), "ls", star(&format!("{t}/aws"))), reject(Reason::ShellOutside), "T/aws → ~/.aws");
    assert_eq!(shell(&t, &format!("cd {}", lab.at("home/notes")), in_t()), reject(Reason::ShellOutside));
    assert_eq!(shell(&t, "cd ~", in_t()), reject(Reason::ShellOutside));
    assert_eq!(shell(&t, "cd ./aws", in_t()), reject(Reason::ShellOutside), "a relative change through a link");
    assert_eq!(shell(&s.directory, &format!("cd {sub}"), star(&sub)), reject(Reason::ShellOutside), "a folder inside and one in T");
    for unreadable in ["cd $HOME", "cd `pwd`", "ls; cd ./sub", "echo cd /x", "builtin cd /x", "if true; then cd /x; fi", "cd", "cd -",
        "popd", "cd a b", "cd sub", "(cd /x)", "cat <<EOF", "ls # cd /x", "cd ~root", "cd \"~\"", "X=1 cd ./sub", "cd /x*"] {
        assert_eq!(shell(&t, unreadable, in_t()), reject(Reason::ShellUnchecked), "{unreadable}");
    }
    assert_eq!(shell(&t, "ls", star("/etc")), reject(Reason::Unbound(Unbound::Resources)), "a folder the call doesn't name");
    let none = Setup { temp: None, ..s.clone() };
    assert_eq!(none.answer("external_directory", &in_t(), Tool::Shell, json!({"command": "ls", "workdir": t})), reject(Reason::ShellOutside));
}

/// The directory changes the shell subset names, and what it refuses.
#[test]
fn the_shell_subset_names_every_directory_change() {
    use shell::Change::{Absolute, Home, Relative};
    let changes = shell::changes;
    assert_eq!(changes("ls -la"), Some(vec![]));
    assert_eq!(changes("cd /a && cd /b; pushd '/c d' | chdir \"/e\""),
        Some(vec![Absolute("/a".into()), Absolute("/b".into()), Absolute("/c d".into()), Absolute("/e".into())]));
    assert_eq!(changes("cd ~/x && ls"), Some(vec![Home("x".into())]));
    assert_eq!(changes("cd ~"), Some(vec![Home(String::new())]));
    assert_eq!(changes("cd ../x"), Some(vec![Relative("../x".into())]));
    assert_eq!(changes("Set-Location /a"), Some(vec![Absolute("/a".into())]), "in any case");
    assert_eq!(changes("make 2> err.log >> out.log >&2"), Some(vec![]));
    assert_eq!(changes("FOO=1 make"), Some(vec![]));
    for refused in ["ls ~/cd", "sl", "cd ~/x; cd ~/y", "ls; cd ../x", "cd -P /x", "pushd +1", "cd \"/a\"'b'", "cd =ls", "ls &> x",
        "ls >", "ls > ; cd /x", "cd 'unterminated", "printf \"$x\"", "a\u{7}b", "cd /x\\ y", "alias cd='cd /etc'", "noglob cd /x"] {
        assert_eq!(changes(refused), None, "{refused}");
    }
}

/// The request must be its call's: its resources are what OpenCode makes of
/// the call's input, else it is refused as not that call's.
#[test]
fn a_request_naming_other_paths_than_its_call_is_refused() {
    let lab = Lab::new();
    let s = &lab.setup;
    let t = lab.temp();
    let resources = reject(Reason::Unbound(Unbound::Resources));
    let a = lab.at("home/notes/a.txt");
    assert_eq!(s.answer("external_directory", &star(&lab.at("home")), Tool::Read, json!({"path": a})), resources);
    assert_eq!(s.answer("read", &one(&lab.at("home/notes/x.env.example")), Tool::Read, json!({"path": a})), resources, "a sibling");
    assert_eq!(s.answer("read", &one("src/main.rs"), Tool::Read, json!({"path": a})), resources);
    assert_eq!(s.answer("grep", &one("other"), Tool::Grep, json!({"pattern": "key", "path": a})), resources);
    assert_eq!(s.answer("external_directory", &star(&s.directory), Tool::Read, json!({"path": "src/main.rs"})), resources,
        "OpenCode asks no folder question inside");
    assert_eq!(s.answer("external_directory", &[], Tool::Write, json!({"path": format!("{t}/x.txt"), "content": "x"})), resources);
    let mut none = asked("read", &[]);
    none.resources = None;
    let rules = Rules { directory: path(&s.directory), worktree: None, home: path(&s.home), data_dir: path(&s.data),
        outputs: [path(&s.outputs[0]), path(&s.outputs[1])], temp: None, protected_dirs: &[], protected_files: &[] };
    assert_eq!(decide(&none, &call(Tool::Read, json!({"path": a})), &rules, &BUDGET, &Wall).answer, resources);
}

/// The trusted inputs must be absolute and normal, and the folder real and
/// not `/`: otherwise nothing is answered once.
#[test]
fn rules_that_are_not_absolute_and_normal_answer_nothing_once() {
    let lab = Lab::new();
    let s = &lab.setup;
    let a = lab.at("home/notes/a.txt");
    let read = |setup: &Setup| setup.answer("read", &one(&a), Tool::Read, json!({"path": a}));
    assert_eq!(read(s), Answer::Once);
    for broken in [Setup { data: "data".into(), ..s.clone() }, Setup { dirs: vec![lab.at("home/./.ssh")], ..s.clone() },
        Setup { files: vec![format!("{}/", lab.at("home/.netrc"))], ..s.clone() }, Setup { temp: Some(lab.at("home/data/t/../t")), ..s.clone() },
        Setup { directory: "/".into(), ..s.clone() }, Setup { directory: lab.at("home/missing"), ..s.clone() },
        Setup { home: "~".into(), ..s.clone() }] {
        assert_eq!(read(&broken), reject(Reason::RulesInvalid));
    }
    // Paths OpenCode might read as Windows paths are not checked.
    assert_eq!(s.answer("read", &one("C:\\x"), Tool::Read, json!({"path": "C:\\x"})), reject(Reason::Unchecked));
}

/// Each refusal has a stable code and tells the model what to do instead.
#[test]
fn each_refusal_has_a_code_and_a_sentence() {
    let reasons = [Reason::Action("edit".into()), Reason::Unbound(Unbound::Gone), Reason::WriteOutside, Reason::PatchUnchecked,
        Reason::ShellOutside, Reason::ShellUnchecked, Reason::EnvFile, Reason::Protected, Reason::CoreData, Reason::Unchecked,
        Reason::SearchRoot, Reason::SearchScan, Reason::RulesInvalid];
    let codes: std::collections::HashSet<&str> = reasons.iter().map(Reason::code).collect();
    assert_eq!(codes.len(), reasons.len());
    for reason in &reasons {
        let message = reason.message();
        assert!(message.starts_with("Yuzuno Core refused this: ") && message.ends_with('.'), "{message}");
    }
    assert!(Reason::Action("edit".into()).message().contains("`edit`"));
}
