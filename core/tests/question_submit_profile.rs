//! Opt-in, bounded, isolated production API/browser timings. Never runs in CI.
#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use axum::{extract::Request, middleware::{self, Next}, response::Response};
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use yuzuno_workspace::{model::AgentDetail, server, workspace::Workspace};

fn ms() -> f64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0 }
fn record(id: &str, long: bool, cwd: &Path) -> AgentDetail {
    let turns = (0..if long { 156 } else { 1 }).map(|t| json!({
        "id":format!("history-{t}"), "status":"completed", "items":(0..if long { 40 } else { 4 }).map(|i| json!({
            "id":format!("item-{t}-{i}"), "type":"agentMessage", "text":format!("Synthetic history {t}/{i} {}", "x".repeat(1800))
        })).collect::<Vec<_>>()
    })).chain(std::iter::once(json!({"id":"active","status":"inProgress","items":[
        {"id":"async-question","type":"agentMessage","text":"Please answer the timing question.","delivery":"async","questions":[{"title":"Async timing question"}]}
    ]}))).collect::<Vec<_>>();
    serde_json::from_value(json!({"agent":{"id":id,"name":id,"goal":"isolated timing fixture","cwd":cwd,
        "model":"test-model","color":"sage","threadId":if id=="a" {"thread"} else {id},"status":"working",
        "createdAt":"2026-10-16T00:00:00Z","updatedAt":"2026-10-16T00:00:00Z","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":turns,"pending":[],"artifacts":[]})).unwrap()
}

#[tokio::test(flavor="multi_thread", worker_threads=2)]
#[ignore = "T-67 opt-in isolated profile; requires browser and production assets"]
async fn profile_question_submission() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned();
    let out = PathBuf::from(std::env::var_os("T67_OUT").expect("explicit T67_OUT"));
    let assets = PathBuf::from(std::env::var_os("YUZUNO_UI_DIST").expect("production assets"));
    std::fs::create_dir_all(&out).unwrap();
    for (label, long, background, delay_ms) in [("short",false,0,0), ("long",true,8,0), ("delayed",false,0,250)] {
        let case = out.join(label);
        std::fs::create_dir(&case).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("native.py");
        std::fs::copy(root.join("acceptance/question-submit/native-mock.py"), &script).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(temp.path().join("config.json"), json!({"delayMs":delay_ms}).to_string()).unwrap();
        let initial = record("a", long, temp.path());
        let body_bytes = serde_json::to_vec(&initial).unwrap().len();
        std::fs::write(temp.path().join("thread.json"), json!({"id":"thread","status":{"type":"active"},"turns":initial.turns}).to_string()).unwrap();
        let ws = Workspace::new(temp.path().join("data"),temp.path().to_string_lossy().into(),script.to_string_lossy().into()).unwrap();
        ws.store.insert(&initial).unwrap();
        for index in 0..background { ws.store.insert(&record(&format!("background-{index}"),true,temp.path())).unwrap(); }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_ne!(port,4317);
        let timing = Arc::new(Mutex::new(Vec::<Value>::new()));
        let copy = timing.clone();
        let router = server::router_on_port(ws.clone(),assets.clone(),port).layer(middleware::from_fn(move |request:Request,next:Next| {
            let copy=copy.clone();
            async move {
                let path=request.uri().to_string(); let method=request.method().to_string(); let start=ms();
                let response:Response=next.run(request).await;
                if path.starts_with("/api/") { copy.lock().unwrap().push(json!({"path":path,"method":method,"start":start,"end":ms(),"status":response.status().as_u16()})); }
                response
            }
        }));
        let serving=tokio::spawn(async move { axum::serve(listener,router).await.unwrap(); });
        ws.reconnect("a").await.unwrap();
        let deadline=tokio::time::Instant::now()+Duration::from_secs(10);
        loop {
            if !ws.store.detail("a").unwrap().pending.is_empty() { break; }
            assert!(tokio::time::Instant::now()<deadline,"native question not received");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        ws.result_publish("a",json!({"requestId":"profile-form","expectedTurnId":"active","spec":{
            "root":"root","elements":{
                "root":{"type":"Result","props":{"title":"Timing form","summary":"Isolated form submission"},"children":["form"]},
                "form":{"type":"Clarification","props":{"id":"timing","title":"Timing form","fields":[{"id":"answer","type":"text","label":"Form timing answer","required":true}]}}
            }
        }})).await.unwrap().unwrap();
        std::fs::write(case.join("fixture.json"),json!({"label":label,"long":long,"backgroundAgents":background,"nativeDelayMs":delay_ms,"selectedFullBytes":body_bytes,"selectedTurns":initial.turns.len(),"port":port}).to_string()).unwrap();
        let output=tokio::process::Command::new("/usr/bin/node").arg(root.join("acceptance/question-submit/browser.mjs"))
            .env("T67_BASE",format!("http://127.0.0.1:{port}")).env("T67_CASE",&case).current_dir(&root).output().await.unwrap();
        std::fs::write(case.join("browser.log"),[output.stdout,output.stderr].concat()).unwrap();
        std::fs::write(case.join("http.json"),serde_json::to_vec_pretty(&*timing.lock().unwrap()).unwrap()).unwrap();
        std::fs::copy(temp.path().join("native.jsonl"),case.join("native.jsonl")).unwrap();
        let db=rusqlite::Connection::open_with_flags(temp.path().join("data/workspace.sqlite"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut query=db.prepare("SELECT kind,at FROM journal WHERE agent_id='a' ORDER BY seq").unwrap();
        let events=query.query_map([],|row|Ok(json!({"kind":row.get::<_,String>(0)?,"at":row.get::<_,String>(1)?}))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        std::fs::write(case.join("journal.json"),serde_json::to_vec_pretty(&events).unwrap()).unwrap();
        serving.abort();
        assert!(output.status.success(),"{label}: see browser.log");
        let final_detail=ws.store.detail("a").unwrap();
        assert_eq!(final_detail.message_receipts.len(),2);
        assert!(final_detail.message_receipts.iter().all(|r|r.status=="accepted"));
        assert!(final_detail.pending.is_empty());
        // Same completed fixture, one local contrast of old/new read paths.
        // These must be no-ops; do not warm the browser's measured submissions.
        let before = ws.store.agent("a").unwrap().last_seq;
        let start = std::time::Instant::now();
        let mut old_holders = Vec::new();
        for agent in ws.store.agents().unwrap() {
            if agent.closed_at.is_none() && ws.store.detail(&agent.id).unwrap().pending.iter().any(|p|p.id=="absent") {
                old_holders.push(agent.id);
            }
        }
        let old_lookup = start.elapsed().as_secs_f64()*1000.0;
        let start = std::time::Instant::now();
        let new_holders = ws.store.request_holders("absent").unwrap();
        let new_lookup = start.elapsed().as_secs_f64()*1000.0;
        assert!(old_holders.is_empty() && new_holders.is_empty());
        let start = std::time::Instant::now();
        for turn in &final_detail.turns {
            if matches!(turn["status"].as_str(), Some("completed" | "failed" | "interrupted")) {
                ws.store.record_recovered_completion("a",turn).unwrap();
            }
        }
        let old_recovery = start.elapsed().as_secs_f64()*1000.0;
        let start = std::time::Instant::now();
        ws.store.record_recovered_completions("a",&final_detail.turns).unwrap();
        let new_recovery = start.elapsed().as_secs_f64()*1000.0;
        assert_eq!(ws.store.agent("a").unwrap().last_seq,before);
        std::fs::write(case.join("store-costs.json"),json!({"legacyLookupMs":old_lookup,"briefLookupMs":new_lookup,
            "legacyRecoveryMs":old_recovery,"batchRecoveryMs":new_recovery,"unchangedLastSeq":before}).to_string()).unwrap();
    }
}
