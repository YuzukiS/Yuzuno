use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;
use yuzuno_workspace::{
    model::{AgentDetail, PendingRequest},
    server,
    store::Store,
    workspace::{validate_response, Workspace},
};

fn detail(cwd: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":"agent-a","name":"小柚","goal":"检查真实结果","cwd":cwd,"model":"","color":"yuzu","threadId":"native-thread","status":"idle","createdAt":"2026-10-12","updatedAt":"2026-10-12","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()
}
fn completion(id: &str, phase: &str) -> Value {
    json!({"turn":{"id":id,"status":"completed","items":[{"id":format!("reply-{id}"),"type":"agentMessage","phase":phase,"text":"完成了局部检查"}]}})
}
fn approval() -> PendingRequest {
    serde_json::from_value(json!({"id":"request-a","agentId":"agent-a","method":"item/commandExecution/requestApproval","params":{"_rpcId":7,"turnId":"turn-a","command":"git status","availableDecisions":["accept","decline"]},"createdAt":"2026-10-12","stale":false})).unwrap()
}

#[test]
fn delayed_turn_start_cannot_resurrect_completed_turn() {
    let mut d = detail("/tmp");
    d.apply(
        "turn/started",
        &json!({"turn":{"id":"turn-a","status":"inProgress","items":[]}}),
    );
    d.apply("turn/completed", &completion("turn-a", "final_answer"));
    d.apply(
        "turn/started",
        &json!({"turn":{"id":"turn-a","status":"inProgress","items":[]}}),
    );
    assert_eq!(d.agent.status, "idle");
    assert_eq!(d.turns[0]["status"], "completed");
    assert_eq!(d.turns[0]["items"][0]["text"], "完成了局部检查");
}

#[test]
fn async_question_survives_turn_end_without_marking_agent_busy() {
    let mut d = detail("/tmp");
    let mut p = approval();
    p.method = "item/tool/requestUserInput".into();
    p.params["isBlocking"] = false.into();
    d.pending.push(p);
    d.apply("turn/completed", &completion("turn-a", "final_answer"));
    assert_eq!(d.agent.status, "idle");
    assert_eq!(d.agent.pending_count, 1);
    d.apply("serverRequest/resolved", &json!({"requestId":999}));
    assert_eq!(d.pending.len(), 1);
    d.apply("serverRequest/resolved", &json!({"requestId":7}));
    assert!(d.pending.is_empty());
}

#[test]
fn streamed_items_survive_empty_completion_payload() {
    let mut d = detail("/tmp");
    d.apply(
        "item/agentMessage/delta",
        &json!({"turnId":"turn-a","itemId":"item-a","delta":"hello"}),
    );
    d.apply(
        "item/agentMessage/delta",
        &json!({"turnId":"turn-a","itemId":"item-a","delta":" world"}),
    );
    d.apply(
        "turn/completed",
        &json!({"turn":{"id":"turn-a","status":"completed","items":[]}}),
    );
    assert_eq!(d.turns[0]["items"][0]["text"], "hello world");
}

#[test]
fn partial_completion_keeps_input_and_tool_evidence_without_duplicating_final() {
    let mut d = detail("/tmp");
    for item in [
        json!({"id":"input","type":"userMessage","content":[{"type":"text","text":"Create the report"}]}),
        json!({"id":"write","type":"fileChange","changes":[{"path":"report.md"}]}),
        json!({"id":"command","type":"commandExecution","exitCode":7,"aggregatedOutput":"expected error"}),
        json!({"id":"final","type":"agentMessage","phase":"final_answer","text":"partial"}),
    ] {
        d.apply("item/completed", &json!({"turnId":"turn-a","item":item}));
    }
    let completed = json!({"turn":{"id":"turn-a","status":"completed","items":[
        {"id":"final","type":"agentMessage","phase":"final_answer","text":"Report ready"}
    ]}});
    d.apply("turn/completed", &completed);
    d.apply("turn/completed", &completed);
    let items = d.turns[0]["items"].as_array().unwrap();
    assert_eq!(items.len(), 4);
    assert_eq!(items[0]["content"][0]["text"], "Create the report");
    assert_eq!(items[1]["changes"][0]["path"], "report.md");
    assert_eq!(items[2]["exitCode"], 7);
    assert_eq!(items[3]["text"], "Report ready");
    assert_eq!(d.agent.status, "idle");
}

#[test]
fn reviewing_rendered_sequence_does_not_read_later_updates_or_resolve_pending() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    s.insert(&detail("/tmp")).unwrap();
    let c = completion("turn-a", "final_answer");
    let rendered = s
        .update("agent-a", "turn/completed", &c, |d| {
            d.apply("turn/completed", &c)
        })
        .unwrap()
        .agent
        .last_seq;
    s.update("agent-a", "request", &json!({}), |d| {
        d.pending.push(approval())
    })
    .unwrap();
    s.review("agent-a", rendered).unwrap();
    let d = s.detail("agent-a").unwrap();
    assert_eq!(d.agent.unread_count, 1);
    assert_eq!(d.pending.len(), 1);
    let items = s.catchup().unwrap()["items"].as_array().unwrap().clone();
    assert!(
        !items.iter().any(|i| i["kind"] == "result"),
        "old final must not reappear because a new approval arrived"
    );
    assert!(items.iter().any(|i| i["kind"] == "pending"));
}

#[test]
fn repeated_auto_read_is_idempotent_and_never_generates_more_content() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    s.insert(&detail("/tmp")).unwrap();
    let c = completion("turn-a", "final_answer");
    let before = s.update("agent-a", "turn/completed", &c, |d| d.apply("turn/completed", &c)).unwrap().agent;
    assert!(s.review("agent-a", before.last_seq).unwrap());
    for through in [before.last_seq, i64::MAX, -1] { assert!(!s.review("agent-a", through).unwrap()); }
    let after = s.detail("agent-a").unwrap().agent;
    assert_eq!(after.last_seq, before.last_seq);
    assert_eq!(after.updated_at, before.updated_at);
    assert_eq!(after.reviewed_seq, before.last_seq);
    assert_eq!(after.unread_count, 0);
    let new = completion("turn-b", "final_answer");
    s.update("agent-a", "turn/completed", &new, |d| d.apply("turn/completed", &new)).unwrap();
    assert!(!s.review("agent-a", before.last_seq).unwrap());
    assert_eq!(s.detail("agent-a").unwrap().agent.unread_count, 1);
}

#[test]
fn catchup_titles_belong_to_the_result_turn_not_the_latest_task_or_legacy_goal() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    let mut d = detail("/tmp");
    d.turns.push(json!({"id":"turn-a","status":"inProgress","items":[{"id":"input-a","type":"userMessage","content":[{"type":"text","text":"检查旧任务"}]}]}));
    s.insert(&d).unwrap();
    let c = completion("turn-a", "final_answer");
    s.update("agent-a", "turn/completed", &c, |d| d.apply("turn/completed", &c)).unwrap();
    let new = json!({"turn":{"id":"turn-b","status":"inProgress","items":[{"id":"input-b","type":"userMessage","content":[{"type":"text","text":"正在做的新任务"}]}]}});
    s.update("agent-a", "turn/started", &new, |d| d.apply("turn/started", &new)).unwrap();
    let catchup = s.catchup().unwrap();
    let result = catchup["items"].as_array().unwrap().iter().find(|i| i["kind"] == "result").unwrap();
    assert_eq!(result["title"], "检查旧任务");
    let rail = s.agents().unwrap()[0].work_summary.clone().unwrap();
    assert_eq!(rail.text,"正在做的新任务");
    assert!(!catchup.to_string().contains("检查真实结果"));
}

#[test]
fn catchup_never_labels_commentary_as_final() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    s.insert(&detail("/tmp")).unwrap();
    let c = completion("turn-a", "commentary");
    s.update("agent-a", "turn/completed", &c, |d| {
        d.apply("turn/completed", &c)
    })
    .unwrap();
    let data = s.catchup().unwrap();
    assert_eq!(data["items"][0]["kind"], "progress");
    assert_eq!(data["items"][0]["turnId"], "turn-a");
}

#[test]
fn restart_preserves_identity_and_evidence_but_invalidates_live_approvals() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("workspace.sqlite");
    {
        let s = Store::open(&path).unwrap();
        s.insert(&detail("/tmp")).unwrap();
        s.update("agent-a", "request", &json!({}), |d| {
            d.pending.push(approval());
            d.agent.status = "waiting".into();
        })
        .unwrap();
    }
    let s = Store::open(&path).unwrap();
    let d = s.detail("agent-a").unwrap();
    assert_eq!(d.agent.thread_id.as_deref(), Some("native-thread"));
    assert_eq!(d.agent.status, "offline");
    assert!(d.pending[0].stale);
    assert_eq!(d.agent.unread_count, 1);
}

#[test]
fn unknown_start_outcome_survives_service_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("workspace.sqlite");
    {
        let s = Store::open(&path).unwrap();
        let mut d = detail("/tmp");
        d.agent.thread_id = None;
        d.agent.status = "uncertain".into();
        s.insert(&d).unwrap();
    }
    let s = Store::open(&path).unwrap();
    assert_eq!(s.detail("agent-a").unwrap().agent.status, "uncertain");
}

#[test]
fn approvals_can_only_use_choices_offered_by_the_harness() {
    let p = approval();
    assert!(validate_response(&p, &json!({"decision":"accept"})).is_ok());
    for response in [
        json!({"decision":"acceptForSession"}),
        json!({"decision":"acceptWithExecpolicyAmendment"}),
        json!({"decision":null}),
    ] {
        assert!(validate_response(&p, &response).is_err());
    }
}

#[test]
fn artifact_rejects_traversal_and_symlink_escape() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(tmp.path().join("private.txt"), "outside").unwrap();
    std::fs::write(root.join("report.txt"), "inside").unwrap();
    assert!(server::artifact_path(root.to_str().unwrap(), "report.txt").is_ok());
    assert!(server::artifact_path(root.to_str().unwrap(), "../private.txt").is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(tmp.path().join("private.txt"), root.join("link.txt")).unwrap();
        assert!(server::artifact_path(root.to_str().unwrap(), "link.txt").is_err());
    }
}

#[tokio::test]
async fn api_enforces_browser_boundary_and_returns_native_records_without_a_socket() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(
        tmp.path().join("data"),
        "/tmp".into(),
        "unused-codex".into(),
    )
    .unwrap();
    ws.store.insert(&detail("/tmp")).unwrap();
    let app = server::router(ws, tmp.path().join("assets"));
    let normal = Request::builder()
        .uri("/api/workspace")
        .header("host", "127.0.0.1:4317")
        .body(Body::empty())
        .unwrap();
    let r = app.clone().oneshot(normal).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let v: Value =
        serde_json::from_slice(&to_bytes(r.into_body(), 1_000_000).await.unwrap()).unwrap();
    assert_eq!(v["agents"][0]["name"], "小柚");
    for (host, origin) in [
        ("evil.example:4317", "http://127.0.0.1:4317"),
        ("127.0.0.1:4317", "https://evil.example"),
    ] {
        let r = Request::builder()
            .uri("/api/workspace")
            .header("host", host)
            .header("origin", origin)
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(r).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    let r = Request::builder()
        .method("POST")
        .uri("/api/agents/agent-a/review")
        .header("host", "127.0.0.1:4317")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"throughSeq":0}"#))
        .unwrap();
    assert_eq!(
        app.oneshot(r).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
}

/// A browser on another computer reaches Core through an SSH tunnel, whose
/// local port is its own. Any loopback host and port is accepted, never a
/// domain (DNS rebinding), and a page's Origin must be that same host and port.
#[tokio::test]
async fn tunnel_ports_are_accepted_but_only_loopback_hosts_and_same_origin_pages() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(
        tmp.path().join("data"),
        "/tmp".into(),
        "unused-codex".into(),
    )
    .unwrap();
    let app = server::router_on_port(ws, tmp.path().join("assets"), 9321);
    let ok = StatusCode::OK;
    let no = StatusCode::FORBIDDEN;
    for (host, origin, expected) in [
        ("localhost:9321", Some("http://localhost:9321"), ok),
        ("127.0.0.1:9321", Some("http://127.0.0.1:9321"), ok),
        // An SSH tunnel's local port, on either loopback name or IPv6.
        ("localhost:5480", Some("http://localhost:5480"), ok),
        ("127.0.0.1:4317", Some("http://127.0.0.1:4317"), ok),
        ("[::1]:5480", Some("http://[::1]:5480"), ok),
        ("127.0.0.1:5480", None, ok),
        // The development server proxies with its own origin.
        ("127.0.0.1:9321", Some("http://localhost:5173"), ok),
        // Another page, even on this computer, is not this one.
        ("localhost:9321", Some("http://localhost:9322"), no),
        ("127.0.0.1:9321", Some("http://127.0.0.1:8080"), no),
        ("localhost:9321", Some("http://127.0.0.1:9321"), no),
        ("127.0.0.1:5480", Some("https://127.0.0.1:5480"), no),
        // Only loopback names: never a domain or a malformed port.
        ("evil.example:9321", Some("http://evil.example:9321"), no),
        ("evil.example:9321", None, no),
        ("localhost.evil.example:9321", None, no),
        ("127.0.0.1.nip.io:9321", None, no),
        ("127.0.0.1:0", None, no),
        ("127.0.0.1:+80", None, no),
        ("127.0.0.1:", None, no),
        ("[::1", None, no),
        ("[::1]x", None, no),
        ("", None, no),
    ] {
        let mut req = Request::builder().uri("/api/health").header("host", host);
        if let Some(origin) = origin {
            req = req.header("origin", origin);
        }
        let status = app.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap().status();
        assert_eq!(status, expected, "host {host:?} origin {origin:?}");
    }
    // Mutations through a tunnel still need the client header.
    let post = |client: Option<&str>| {
        let mut req = Request::builder()
            .method("POST")
            .uri("/api/agents/agent-a/review")
            .header("host", "127.0.0.1:5480")
            .header("origin", "http://127.0.0.1:5480")
            .header("content-type", "application/json");
        if let Some(client) = client {
            req = req.header("x-yuzuno-client", client);
        }
        req.body(Body::from(r#"{"throughSeq":0}"#)).unwrap()
    };
    assert_eq!(app.clone().oneshot(post(None)).await.unwrap().status(), no);
    assert_ne!(app.oneshot(post(Some("desktop"))).await.unwrap().status(), no);
}
