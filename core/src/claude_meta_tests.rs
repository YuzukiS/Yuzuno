//! Claude's permission requests, their cancellation, answer and resolution,
//! and the effort a Turn ran at (T-140): on a held record they are committed
//! as its metadata, without copying or reading the record whole; a record
//! not held, and a request whose Turn is to be opened, are committed as
//! before. Each case runs in two Workspaces, one with the record held and
//! one without, and both must write the same.
use super::*;

/// Claude Agent `id`, connected, with these Turns and pending requests.
fn record(id: &str, status: &str, turns: &[(&str, &str)], pending: Vec<PendingRequest>) -> AgentDetail {
    let mut d: AgentDetail = serde_json::from_value(json!({"agent": {
        "id":id,"name":"Claude","goal":"test","cwd":"/tmp","model":"haiku","color":"sage",
        "harness":"claude","threadId":null,"status":status,"createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastMessage":null,"lastSeq":0,"reviewedSeq":0,"error":null,"connectionState":"connected"
    },"turns":[],"pending":[],"artifacts":[]})).unwrap();
    d.agent.claude_session_id = Some("s".into());
    for (turn, status) in turns {
        d.turns.push(json!({"id":turn,"status":status,"items":[{"id":format!("{turn}:input"),"type":"userMessage",
            "content":[{"type":"text","text":"task"}]}]}));
    }
    d.agent.pending_count = pending.len() as u64;
    d.pending = pending;
    d
}

/// A permission request already pending, as Core records one.
fn pending(agent: &str, id: &str, native: &str, generation: u64, stale: bool, sent: bool) -> PendingRequest {
    PendingRequest {
        id: id.into(),
        agent_id: agent.into(),
        method: "claude/canUseTool".into(),
        params: json!({"requestId":native,"turnId":"t","_runtimeGeneration":generation,"_responseSent":sent,
            "input":{"command":"pwd"}}),
        created_at: now(),
        stale,
    }
}

/// A bridge connected as generation 7; its commands are read by the test.
struct Fake {
    bridge: Arc<Bridge>,
    commands: mpsc::Receiver<Value>,
    _shutdown: watch::Receiver<bool>,
    _stopped: watch::Sender<Option<bool>>,
}

fn connect(ws: &Workspace, id: &str) -> Fake {
    let (tx, commands) = mpsc::channel(8);
    let (shutdown, shutdown_rx) = watch::channel(false);
    let (stopped_tx, stopped) = watch::channel(None);
    let bridge = Arc::new(Bridge {
        tx,
        pending: Arc::new(Mutex::new(HashMap::new())),
        next: AtomicU64::new(1),
        shutdown,
        stopped,
        diagnostics: Default::default(),
        stderr_closed: watch::channel(true).1, pid: None,
    });
    ws.claudes.lock().unwrap().insert(id.into(), Connection { remote_instance: None, generation: 7, bridge: bridge.clone(), events: None });
    Fake { bridge, commands, _shutdown: shutdown_rx, _stopped: stopped_tx }
}

/// A Workspace with `d` stored, held in memory or not.
fn workspace(d: &AgentDetail, held: bool) -> (tempfile::TempDir, Arc<Workspace>) {
    let temp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(temp.path().join("data"), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(d).unwrap();
    // Held as a streaming Agent's is; the other Workspace journals the same.
    ws.store.record_event(&d.agent.id, "test/hold", &json!({}), |_| {}).unwrap();
    if !held {
        ws.store.release_for_test(&d.agent.id);
    }
    (temp, ws)
}

/// Whether the record is held by the same copy as `before`: a commit in place
/// keeps it, one that copies the record replaces it.
fn same_copy(ws: &Workspace, id: &str, before: &Arc<parking_lot::RwLock<AgentDetail>>) -> bool {
    ws.store.held_for_test(id).is_some_and(|now| Arc::ptr_eq(&now, before))
}

/// Nulls what a commit stamps with the clock or a random ID.
fn unclocked(value: &mut Value) {
    match value {
        Value::Object(members) => {
            for (key, member) in members.iter_mut() {
                if key.ends_with("At") || key == "rev" || key == "id" && member.as_str().is_some_and(|id| id.len() == 36) {
                    *member = Value::Null;
                } else {
                    unclocked(member);
                }
            }
        }
        Value::Array(members) => members.iter_mut().for_each(unclocked),
        _ => {}
    }
}

/// The record as its rows have it once released, and its journal.
fn written(ws: &Workspace, id: &str) -> (Value, Vec<(String, Value)>) {
    ws.store.release_for_test(id);
    let mut record = serde_json::to_value(ws.store.detail(id).unwrap()).unwrap();
    unclocked(&mut record);
    let db = ws.store.db.read().unwrap();
    let mut query = db.prepare("SELECT kind, data FROM journal WHERE agent_id=?1 ORDER BY seq").unwrap();
    let journal = query.query_map([id], |r| Ok((r.get::<_, String>(0)?, serde_json::from_str(&r.get::<_, String>(1)?).unwrap())))
        .unwrap().map(Result::unwrap).collect();
    (record, journal)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requests_and_cancellations_write_what_the_whole_record_commit_wrote() {
    let id = "meta-requests";
    // The request is for `turn`; whether it copies the record. One for a
    // Turn no longer running is not shown (nothing is written); one opening
    // a native Turn the record lacks is committed as before, copying it.
    let setups: [(&[(&str, &str)], &str, bool); 4] = [
        (&[("t", "inProgress")], "t", false),
        (&[("t", "completed")], "t", false),
        (&[("t", "completed")], "native-x", true),
        (&[("t", "completed"), ("native-x", "inProgress")], "native-x", false),
    ];
    let pendings = || vec![
        vec![],
        vec![pending(id, "same", "r", 7, false, false)],
        vec![pending(id, "same", "r", 7, true, false)],
        vec![pending(id, "same", "r", 6, false, false)],
        vec![pending(id, "other", "o", 7, false, true)],
    ];
    let request = |turn: &str| json!({"type":"permission","turnId":turn,"requestId":"r","toolName":"Bash",
        "input":{"command":"pwd"},"toolUseId":"call","sessionPermissions":[]});
    let cancel = json!({"type":"permission_cancelled","requestId":"r"});
    let mut checked = 0;
    for status in ["working", "waiting", "idle", "error", "uncertain"] {
        for (turns, turn, copies) in setups {
            for pending in pendings() {
                let d = record(id, status, turns, pending);
                let case = format!("{status} {turns:?} request for {turn} pending {:?}", d.pending.iter().map(|p| &p.params).collect::<Vec<_>>());
                let (_held_dir, held) = workspace(&d, true);
                let (_rows_dir, rows) = workspace(&d, false);
                let (_held_bridge, _rows_bridge) = (connect(&held, id), connect(&rows, id));
                let copy = held.store.held_for_test(id).unwrap();
                held.claude_event(id, 7, request(turn));
                assert_eq!(same_copy(&held, id, &copy), !copies, "{case}: request");
                rows.claude_event(id, 7, request(turn));
                rows.store.release_for_test(id);
                let copy = held.store.held_for_test(id).unwrap();
                held.claude_event(id, 7, cancel.clone());
                assert!(same_copy(&held, id, &copy), "{case}: the cancellation copied the record");
                rows.claude_event(id, 7, cancel.clone());
                assert_eq!(written(&held, id), written(&rows, id), "{case}");
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 5 * 4 * 5);
}

/// Answers the next command the fake bridge gets with `reply`; the
/// command it answered.
fn answer(mut fake: Fake, reply: Result<Value>) -> tokio::task::JoinHandle<Value> {
    tokio::spawn(async move {
        let command = timeout(Duration::from_secs(10), fake.commands.recv()).await.unwrap().unwrap();
        let n = command["id"].as_str().unwrap().parse().unwrap();
        fake.bridge.pending.lock().await.remove(&n).unwrap().send(reply).unwrap();
        command
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answer_reads_and_copies_no_record_and_writes_what_it_did() {
    let id = "meta-answer";
    for (turn, refused) in [("inProgress", false), ("completed", false), ("inProgress", true)] {
        let d = record(id, "waiting", &[("t", turn)], vec![pending(id, "action", "r", 7, false, false)]);
        let mut results = Vec::new();
        for held in [true, false] {
            let (_dir, ws) = workspace(&d, held);
            let answered = answer(connect(&ws, id), if refused { Err(anyhow!("refused")) } else { Ok(json!({})) });
            let copy = ws.store.held_for_test(id);
            let reads = crate::store::detail_reads_of(id);
            let result = ws.claude_respond(id, "action", &json!({"decision":"allow"})).await;
            assert_eq!(crate::store::detail_reads_of(id), reads, "{turn} refused={refused}: the answer read the record whole");
            if let Some(copy) = &copy {
                assert!(same_copy(&ws, id, copy), "{turn} refused={refused}: the answer copied the record");
            }
            let command = answered.await.unwrap();
            assert_eq!((command["op"].as_str(), command["requestId"].as_str(), command["decision"].as_str()),
                (Some("respond"), Some("r"), Some("allow")));
            assert_eq!(result.is_err(), refused);
            let (record, journal) = written(&ws, id);
            let kinds: Vec<&str> = journal.iter().map(|(kind, _)| kind.as_str()).collect();
            let last = if refused { "claude/permissionResponseFailed" } else { "claude/permissionResolved" };
            assert_eq!(kinds, ["test/hold", "request/replied", last]);
            if refused {
                assert_eq!((record["pending"][0]["stale"].clone(), record["agent"]["error"].clone()), (json!(true), json!("refused")));
            } else {
                assert_eq!(record["pending"], json!([]));
                assert_eq!(record["agent"]["status"], if turn == "inProgress" { "working" } else { "idle" });
            }
            results.push((record, journal));
        }
        assert_eq!(results[0], results[1], "{turn} refused={refused}: held and not held differ");
    }
}

/// What the answer checks before it sends anything is unchanged.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answer_still_refuses_what_it_refused() {
    let id = "meta-refusals";
    let answer = json!({"decision":"allow"});
    let cases: [(&str, PendingRequest, bool, bool); 4] = [
        ("an older connection's", pending(id, "action", "r", 6, false, false), false, true),
        ("a stale one", pending(id, "action", "r", 7, true, false), false, true),
        ("one answered already", pending(id, "action", "r", 7, false, true), false, true),
        ("a closed Agent's", pending(id, "action", "r", 7, false, false), true, true),
    ];
    // What a refusal could have written: the journal and the pending requests.
    let kept = |ws: &Workspace| {
        let rows: i64 = ws.store.db.read().unwrap().query_row("SELECT count(*) FROM journal WHERE agent_id=?1", [id], |r| r.get(0)).unwrap();
        (rows, serde_json::to_value(ws.store.pending(id).unwrap()).unwrap())
    };
    for (case, request, closed, connected) in cases {
        let mut d = record(id, "waiting", &[("t", "inProgress")], vec![request]);
        if closed {
            d.agent.closed_at = Some(now());
        }
        let (_dir, ws) = workspace(&d, true);
        let _fake = connected.then(|| connect(&ws, id));
        let before = kept(&ws);
        assert!(ws.claude_respond(id, "action", &answer).await.is_err(), "{case}");
        assert_eq!(kept(&ws), before, "{case} changed the record");
    }
    let (_dir, ws) = workspace(&record(id, "waiting", &[("t", "inProgress")], vec![pending(id, "action", "r", 7, false, false)]), true);
    let error = ws.claude_respond(id, "action", &answer).await.unwrap_err();
    assert!(error.to_string().contains("已断开"), "{error}");
    assert!(!ws.claude_respond(id, "missing", &answer).await.unwrap(), "an unknown request is not this Agent's");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_effort_a_turn_ran_at_is_written_as_metadata() {
    let id = "meta-effort";
    let d = record(id, "working", &[("t", "inProgress")], vec![]);
    let mut results = Vec::new();
    for held in [true, false] {
        let (_dir, ws) = workspace(&d, held);
        let _fake = connect(&ws, id);
        let copy = ws.store.held_for_test(id);
        ws.claude_event(id, 7, json!({"type":"effort","turnId":"t","level":"high"}));
        if let Some(copy) = &copy {
            assert!(same_copy(&ws, id, copy), "the effort copied the record");
        }
        let (record, journal) = written(&ws, id);
        assert_eq!(record["claudeRuntime"]["effort"], json!({"level":"high","turnId":"t"}));
        assert_eq!(journal.last().unwrap().0, "claude/effortApplied");
        results.push((record, journal));
    }
    assert_eq!(results[0], results[1], "held and not held differ");
}
