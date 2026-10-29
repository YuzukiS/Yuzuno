//! The detail API ships bounded previews of large tool fields; the payload
//! routes return the full values, for finished and still-running Items.
#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}, Router};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;
use yuzuno_workspace::{client_view::{PREVIEW, TRIM_ABOVE}, model::AgentDetail, server, store::route, workspace::Workspace};

fn numbered(prefix: &str, lines: usize) -> String {
    (0..lines).map(|n| format!("{prefix} line {n:06}\n")).collect()
}

struct Lab { _dir: tempfile::TempDir, ws: Arc<Workspace>, router: Router, data: std::path::PathBuf }

impl Lab {
    fn new() -> Self {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let data = dir.path().join("data");
        let ws = Workspace::new(data.clone(), dir.path().to_string_lossy().into_owned(), "unused-harness".into()).unwrap();
        let record: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage",
            "threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[
                {"id":"done","status":"completed","items":[
                    {"id":"ask","type":"userMessage","content":[{"type":"text","text":"build it"}]},
                    {"id":"build","type":"commandExecution","command":"cargo build","aggregatedOutput":numbered("build",4000),"status":"completed","exitCode":0},
                    {"id":"edit","type":"fileChange","changes":[{"path":"src/a.rs","kind":{"type":"update"},"diff":numbered("+a",1500)},
                        {"path":"src/b.rs","kind":{"type":"add"},"diff":numbered("+b",1500)}],"status":"completed"},
                    {"id":"ls","type":"commandExecution","command":"ls","aggregatedOutput":"Cargo.toml\n","status":"completed","exitCode":0},
                    {"id":"reply","type":"agentMessage","text":"Built.","phase":"final_answer"}]},
                {"id":"live","status":"inProgress","items":[
                    {"id":"run","type":"commandExecution","command":"cargo test","aggregatedOutput":"","status":"inProgress"}]}],
            "pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&record).unwrap();
        let router = server::router_on_port(ws.clone(), dir.path().join("assets"), 4317);
        Self { _dir: dir, ws, router, data }
    }
    async fn get(&self, uri: &str) -> (StatusCode, Value, usize) {
        let response = self.router.clone().oneshot(Request::builder().uri(uri).header("host", "localhost:4317")
            .body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 64 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap(), bytes.len())
    }
    /// Live command output, routed as runtime deltas are: held in memory,
    /// written to the Agent's rows on the cadence or before a read.
    fn stream_output(&self, text: &str) {
        let kind = "item/commandExecution/outputDelta";
        let p = json!({"turnId":"live","itemId":"run","delta":text});
        self.ws.store.record_stream("a", route(kind, &p), kind, &p).unwrap();
    }
    /// The Agent row as written, through a separate connection.
    fn row(&self) -> AgentDetail {
        let db = rusqlite::Connection::open(self.data.join("workspace.sqlite")).unwrap();
        let mut d = yuzuno_workspace::record_rows::load_meta(&db, "a").unwrap().unwrap();
        yuzuno_workspace::record_rows::scan(&db, "a", true, |turn| { d.turns.push(turn); Ok(true) }).unwrap();
        d
    }
}

fn find<'a>(detail: &'a Value, turn: &str, item: &str) -> &'a Value {
    detail["turns"].as_array().unwrap().iter().find(|t| t["id"] == turn).unwrap()["items"]
        .as_array().unwrap().iter().find(|i| i["id"] == item).unwrap()
}

#[tokio::test]
async fn detail_ships_previews_and_the_payload_route_returns_full_completed_items() {
    let lab = Lab::new();
    // The record as written.
    let full = lab.row();
    let full_size = serde_json::to_vec(&full).unwrap().len();
    let (status, detail, size) = lab.get("/api/agents/a").await;
    assert_eq!(status, StatusCode::OK);
    assert!(size * 4 < full_size, "{size} of {full_size}");

    let build = find(&detail, "done", "build");
    let output = numbered("build", 4000);
    assert!(build["aggregatedOutput"].as_str().unwrap().len() <= PREVIEW);
    assert!(output.ends_with(build["aggregatedOutput"].as_str().unwrap()));
    assert_eq!(build["_yuzunoTruncated"]["aggregatedOutput"], json!({"bytes":output.len(),"lines":4000,"keep":"tail"}));
    assert_eq!(build["command"], "cargo build");
    let edit = find(&detail, "done", "edit");
    assert_eq!(edit["changes"][1]["path"], "src/b.rs");
    assert!(edit["_yuzunoTruncated"]["changes"]["bytes"].as_u64().unwrap() > TRIM_ABOVE as u64);
    // Small Items and conversation arrive exactly as recorded.
    assert_eq!(find(&detail, "done", "ls"), &full.turns[0]["items"][3]);
    assert_eq!(find(&detail, "done", "reply")["text"], "Built.");

    let (status, payload, _) = lab.get("/api/agents/a/items/build/payload").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["fields"], json!({"aggregatedOutput":output}));
    assert_eq!((payload["turnId"].as_str(), payload["turnStatus"].as_str(), payload["itemStatus"].as_str()),
        (Some("done"), Some("completed"), Some("completed")));
    let (_, payload, _) = lab.get("/api/agents/a/items/edit/payload?field=changes&turnId=done").await;
    assert_eq!(payload["fields"]["changes"], full.turns[0]["items"][2]["changes"]);
    let (_, payload, _) = lab.get("/api/agents/a/items/ls/payload").await;
    assert_eq!(payload["fields"], json!({}), "nothing is trimmed from a small Item");

    let (status, turn, _) = lab.get("/api/agents/a/turns/done/payload").await;
    assert_eq!(status, StatusCode::OK);
    let items = turn["items"].as_object().unwrap();
    assert_eq!(items.keys().collect::<Vec<_>>(), ["build", "edit"]);
    assert_eq!(items["build"]["fields"]["aggregatedOutput"], output);
    assert_eq!(items["edit"]["fields"]["changes"], full.turns[0]["items"][2]["changes"]);

    // Trimming happened only on the way out.
    assert_eq!(lab.row().turns, full.turns);
    // A read adds only who each input came from (T-6), never stored.
    let mut read = lab.ws.store.detail("a").unwrap().turns;
    assert_eq!(read[0]["items"][0].as_object_mut().unwrap().remove("_yuzunoInput"), Some(json!("unconfirmed")));
    assert_eq!(read, full.turns);
}

#[tokio::test]
async fn running_items_are_served_from_the_newest_output() {
    let lab = Lab::new();
    lab.stream_output(&numbered("test", 1000));
    let (_, detail, _) = lab.get("/api/agents/a").await;
    let run = find(&detail, "live", "run");
    assert_eq!(run["status"], "inProgress");
    let first = run["_yuzunoTruncated"]["aggregatedOutput"]["bytes"].as_u64().unwrap();
    assert_eq!(first, numbered("test", 1000).len() as u64);

    let (status, payload, _) = lab.get("/api/agents/a/items/run/payload?field=aggregatedOutput").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["itemStatus"], "inProgress");
    assert_eq!(payload["turnStatus"], "inProgress");
    assert_eq!(payload["fields"]["aggregatedOutput"], numbered("test", 1000));
    assert_eq!(lab.row().turns[1]["items"][0]["aggregatedOutput"], numbered("test", 1000), "a read writes held output first");

    lab.stream_output("test finished\n");
    let (_, payload, _) = lab.get("/api/agents/a/items/run/payload").await;
    assert_eq!(payload["fields"]["aggregatedOutput"], numbered("test", 1000) + "test finished\n");
    let (_, detail, _) = lab.get("/api/agents/a").await;
    let run = find(&detail, "live", "run");
    assert!(run["aggregatedOutput"].as_str().unwrap().ends_with("test finished\n"));
    assert!(run["_yuzunoTruncated"]["aggregatedOutput"]["bytes"].as_u64().unwrap() > first);
    let (_, turn, _) = lab.get("/api/agents/a/turns/live/payload").await;
    assert_eq!(turn["turnStatus"], "inProgress");
    assert_eq!(turn["items"]["run"]["fields"]["aggregatedOutput"], numbered("test", 1000) + "test finished\n");
}

#[tokio::test]
async fn unknown_agents_turns_items_and_fields_are_named_404s() {
    let lab = Lab::new();
    for (uri, code) in [
        ("/api/agents/nobody/items/build/payload", "agent_not_found"),
        ("/api/agents/nobody/turns/done/payload", "agent_not_found"),
        ("/api/agents/a/items/nothing/payload", "item_not_found"),
        ("/api/agents/a/items/build/payload?turnId=live", "item_not_found"),
        ("/api/agents/a/items/build/payload?turnId=gone", "turn_not_found"),
        ("/api/agents/a/turns/gone/payload", "turn_not_found"),
        ("/api/agents/a/items/build/payload?field=diff", "field_not_found"),
    ] {
        let (status, body, _) = lab.get(uri).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(body["code"], code, "{uri}");
        assert!(body["error"].as_str().is_some_and(|e| !e.is_empty()), "{uri}");
    }
}

#[tokio::test]
async fn an_item_awaiting_approval_arrives_whole() {
    let lab = Lab::new();
    // The file change Codex asks about, as the approval card links to it.
    let request = json!({"id":"approve-edit","agentId":"a","method":"item/fileChange/requestApproval",
        "params":{"turnId":"done","itemId":"edit","reason":"write files"},"createdAt":""});
    lab.ws.store.update("a", "request", &request, |d| d.pending.push(serde_json::from_value(request.clone()).unwrap())).unwrap();
    let full = lab.ws.store.detail("a").unwrap();
    // The detail is the window (T-140): an Item past the window's Item size
    // is its preview there, and arrives whole as its original.
    let (_, detail, _) = lab.get("/api/agents/a").await;
    assert!(find(&detail, "done", "edit")["_yuzunoWindowPreview"].is_object());
    let (status, edit, _) = lab.get("/api/agents/a/items/edit/original?turnId=done").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edit["changes"], full.turns[0]["items"][2]["changes"]);
    assert!(find(&detail, "done", "build")["_yuzunoTruncated"].is_object(), "other Items are still trimmed");
    let (_, turn, _) = lab.get("/api/agents/a/turns/done/payload").await;
    assert_eq!(turn["items"].as_object().unwrap().keys().collect::<Vec<_>>(), ["build"]);
    let (status, payload, _) = lab.get("/api/agents/a/items/build/payload?field=command,aggregatedOutput").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["fields"], json!({"command":"cargo build","aggregatedOutput":numbered("build",4000)}));
}
