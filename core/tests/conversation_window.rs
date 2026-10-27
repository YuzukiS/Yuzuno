//! The saved-body window is opt-in and never changes stored history. All
//! tests use a temporary workspace; no native harness or daily Core runs.
#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}, Router};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;
use yuzuno_workspace::{model::AgentDetail, server, workspace::Workspace};

struct Lab { _dir: tempfile::TempDir, ws: Arc<Workspace>, router: Router }
impl Lab {
    fn new() -> Self {
        let record: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage",
            "status":"idle","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[{"id":"t","status":"completed","items":(0..400).map(|i| json!({"id":format!("i{i}"),"type":"agentMessage","text":format!("saved message {i} {}", "x".repeat(3000))})).collect::<Vec<_>>() }],
            "pending":[],"artifacts":[]})).unwrap();
        Self::from(record)
    }
    fn from(record: AgentDetail) -> Self {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let ws = Workspace::new(dir.path().join("data"),dir.path().to_string_lossy().into_owned(),"unused-harness".into()).unwrap();
        ws.store.insert(&record).unwrap();
        let router = server::router_on_port(ws.clone(),dir.path().join("assets"),4317);
        Self {_dir:dir,ws,router}
    }
    async fn get(&self, uri: &str, window: bool) -> (StatusCode,Value,usize) {
        let mut request = Request::builder().uri(uri).header("host","localhost:4317");
        if window { request = request.header("x-yuzuno-conversation","window"); }
        let response = self.router.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(),64<<20).await.unwrap();
        (status,serde_json::from_slice(&body).unwrap(),body.len())
    }
}

#[tokio::test]
async fn opt_in_is_bounded_and_original_and_search_are_complete() {
    let lab = Lab::new();
    // The whole Turn is its original; the detail is the window either way
    // (T-140), the conversation metadata only when asked for.
    let (_,full,full_bytes) = lab.get("/api/agents/a/turns/t/original",false).await;
    assert_eq!(full["items"].as_array().unwrap().len(),400);
    let (status,page,page_bytes) = lab.get("/api/agents/a",true).await;
    assert_eq!(status,StatusCode::OK);
    assert!(page_bytes * 4 < full_bytes,"{page_bytes} vs {full_bytes}");
    let (_,plain,_) = lab.get("/api/agents/a",false).await;
    assert!(plain.get("conversation").is_none());
    assert_eq!(plain["turns"],page["turns"]);
    assert_eq!(page["conversation"]["totalItems"],400);
    assert_eq!(page["conversation"]["hasBefore"],true);
    assert_eq!(page["turns"][0]["items"].as_array().unwrap().last().unwrap()["id"],"i399");
    let (status,located,_) = lab.get("/api/agents/a?turnId=t&itemId=i0",true).await;
    assert_eq!(status,StatusCode::OK);
    assert_eq!(located["turns"][0]["items"][0]["id"],"i0");
    assert_eq!(located["conversation"]["hasAfter"],true);
    let (_,item,_) = lab.get("/api/agents/a/items/i0/original?turnId=t",false).await;
    assert_eq!(item,full["items"][0]);
    let (_,matches,_) = lab.get("/api/agents/a/conversation/search?q=saved%20message%200",false).await;
    assert_eq!(matches[0]["itemId"],"i0");
    assert_eq!(lab.ws.store.detail("a").unwrap().turns[0]["items"].as_array().unwrap().len(),400);
}

#[tokio::test]
async fn invalid_or_missing_destinations_do_not_return_a_different_page() {
    let lab = Lab::new();
    assert_eq!(lab.get("/api/agents/a?view=window&turnId=missing",false).await.0,StatusCode::NOT_FOUND);
    assert_eq!(lab.get("/api/agents/a?view=window&turnId=t&itemId=missing",false).await.0,StatusCode::NOT_FOUND);
    assert_eq!(lab.get("/api/agents/a?view=window&before=bad",false).await.0,StatusCode::BAD_REQUEST);
    assert_eq!(lab.get("/api/agents/a?view=window&turnId=t&after=bad",false).await.0,StatusCode::BAD_REQUEST);
    assert_eq!(lab.get("/api/agents/a/turns/missing/original",false).await.0,StatusCode::NOT_FOUND);
    assert_eq!(lab.get("/api/agents/missing/turns/t/original",false).await.0,StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn full_original_preserves_mailbox_start_and_steer_provenance_outside_the_page() {
    let mut cases = Vec::new();
    for mode in ["start", "steer"] {
        let lab = Lab::new();
        lab.ws.store.update("a", "test/mailbox-inputs", &json!({}), |detail| {
            let mut inputs = Vec::new();
            if mode == "steer" {
                inputs.push(json!({"id":"human-first","type":"userMessage","content":[{"type":"text","text":"Human request"}]}));
            }
            inputs.push(json!({"id":"mail","type":"userMessage","clientId":"mailbox-client","content":[{"type":"text","text":"Mailbox delivery"}]}));
            inputs.push(json!({"id":"human-later","type":"userMessage","content":[{"type":"text","text":"Human follow-up"}]}));
            inputs.extend(detail.turns[0]["items"].as_array_mut().unwrap().drain(..));
            detail.turns[0]["items"] = json!(inputs);
        }).unwrap();
        lab.ws.store.collaboration_call(None, "peer_send", json!({"requestId":"copy-regression","toAgentId":"a","body":"Synthetic mailbox record"})).unwrap();
        let batch = lab.ws.store.pending_peer_deliveries().unwrap().remove(0);
        let through = batch["throughSeq"].as_i64().unwrap();
        let binding = json!({"agentId":"a","turnId":"t","clientMessageId":"mailbox-client","mode":mode});
        assert_eq!(lab.ws.store.set_peer_delivery("a",through,"sending",binding.clone()).unwrap(),1);
        assert_eq!(lab.ws.store.set_peer_delivery("a",through,"delivered",binding).unwrap(),1);

        let (_,page,_) = lab.get("/api/agents/a",true).await;
        assert!(page["turns"][0]["_yuzunoSlice"].is_object());
        assert!(page["turns"][0]["items"].as_array().unwrap().iter().all(|item|item["type"] != "userMessage"),"provenance cannot be recovered from only loaded items");
        let (status,original,_) = lab.get("/api/agents/a/turns/t/original",false).await;
        assert_eq!(status,StatusCode::OK);
        assert_eq!(original["items"].as_array().unwrap().len(),
            lab.ws.store.detail("a").unwrap().turns[0]["items"].as_array().unwrap().len());
        let items = original["items"].as_array().unwrap();
        let mail = items.iter().find(|item|item["id"] == "mail").unwrap();
        assert_eq!(mail["_yuzunoSource"],"peer");
        assert!(mail["_yuzunoMailbox"].is_object());
        assert_eq!(original["_yuzunoSource"] == "peer",mode == "start");
        assert!(items.iter().filter(|item|item["id"].as_str().is_some_and(|id|id.starts_with("human-"))).all(|item|item.get("_yuzunoSource").is_none()));
        // Annotation belongs to the read view, never the stored native body.
        let raw = lab.ws.store.payload_view("a",Some("t"),None,|detail|detail.turns[0].clone()).unwrap().unwrap();
        assert!(raw.get("_yuzunoSource").is_none());
        assert!(raw["items"].as_array().unwrap().iter().all(|item|item.get("_yuzunoSource").is_none()));
        cases.push(json!({"mode":mode,"page":page,"original":original}));
    }
    // Optional production-router responses for the browser clipboard check.
    if let Ok(path) = std::env::var("T77_MAILBOX_OUTPUT") {
        std::fs::write(path,serde_json::to_vec(&cases).unwrap()).unwrap();
    }
}

/// Export real production-router responses for the masked browser fixture.
/// Explicit acceptance only: no listener, native process or daily workspace.
#[tokio::test]
#[ignore = "needs the private masked T77_FIXTURE and isolated T77_API_OUTPUT"]
async fn export_browser_fixture() {
    use sha2::{Digest, Sha256};
    use std::time::Instant;
    use yuzuno_workspace::conversation_window::{project, Query};
    let raw = std::fs::read(std::env::var("T77_FIXTURE").unwrap()).unwrap();
    assert_eq!(format!("{:x}",Sha256::digest(&raw)),"b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d");
    let fixture: Value = serde_json::from_slice(&raw).unwrap();
    let mut original = fixture["details"]["a"].clone();
    original["agent"]["id"] = json!("a");
    original["agent"]["name"] = json!("T77 Long");
    let first_turn = original["turns"].as_array().unwrap().iter().find(|t| t["items"].as_array().unwrap().iter().any(|i| i["type"] == "commandExecution")).unwrap();
    let first_item = first_turn["items"].as_array().unwrap().iter().find(|i|i["type"] == "commandExecution").unwrap();
    let source = json!({"turnId":first_turn["id"],"itemId":first_item["id"]});
    let record: AgentDetail = serde_json::from_value(original.clone()).unwrap();
    let lab = Lab::from(record.clone());
    let mut giant = record.clone();
    giant.agent.id = "b".into(); giant.agent.name = "T77 Giant".into();
    let items: Vec<Value> = record.turns.iter().enumerate().flat_map(|(t,turn)|turn["items"].as_array().unwrap().iter().map(move |item| {
        let mut item = item.clone(); item["id"] = json!(format!("giant-{t}-{}",item["id"].as_str().unwrap())); item
    })).collect();
    giant.turns = vec![json!({"id":"giant","status":"completed","items":items})];
    // One individual message large enough to defeat merely limiting turn count.
    giant.turns[0]["items"].as_array_mut().unwrap().push(json!({"id":"huge-text","type":"agentMessage","phase":"final_answer","text":"T77 original line\n".repeat(50_000)}));
    lab.ws.store.insert(&giant).unwrap();
    let mut replies = serde_json::Map::new();
    let mut measurements = Vec::new();
    fn url(path: &str, params: &[(&str,&str)]) -> String {
        let mut url = reqwest::Url::parse(&format!("http://fixture{path}")).unwrap();
        url.query_pairs_mut().extend_pairs(params.iter().copied());
        format!("{}{}",url.path(),url.query().map(|q|format!("?{q}")).unwrap_or_default())
    }
    fn visible_cursor(page: &Value, last: bool) -> String {
        let visible: Vec<_> = page["turns"].as_array().unwrap().iter().flat_map(|t|
            t["items"].as_array().unwrap().iter().filter(|i| match i["type"].as_str() {
                Some("reasoning") => i["summary"].as_array().is_some_and(|s|s.iter().any(|s|s.as_str().is_some_and(|s|!s.trim().is_empty()))),
                Some("agentMessage") => i["text"].as_str().is_some_and(|s|!s.trim().is_empty()) || i["questions"].as_array().is_some_and(|s|!s.is_empty()),
                _ => true,
            }).map(|i|json!([t["id"],i["id"]]))).collect();
        let item = if last { visible.last() } else { visible.first() };
        item.map(ToString::to_string).unwrap_or_else(||page["conversation"][if last {"end"} else {"start"}].as_str().unwrap().into())
    }
    for id in ["a","b"] {
        let start = Instant::now();
        let mut detail = lab.ws.store.client_detail(id).unwrap();
        let read_ms = start.elapsed().as_secs_f64()*1000.;
        let full_bytes = serde_json::to_vec(&detail).unwrap().len();
        let start = Instant::now();
        let meta = project(&mut detail,&Query::default()).unwrap();
        let project_ms = start.elapsed().as_secs_f64()*1000.;
        let start = Instant::now();
        let serialized = serde_json::to_vec(&json!({"detail":detail,"conversation":meta})).unwrap();
        let serialize_ms = start.elapsed().as_secs_f64()*1000.;
        let path = format!("/api/agents/{id}");
        let start = Instant::now();
        let (status, page, bytes) = lab.get(&path,true).await;
        let router_ms = start.elapsed().as_secs_f64()*1000.;
        assert_eq!(status,StatusCode::OK);
        let cursor = visible_cursor(&page,false);
        let before = url(&path,&[("before",&cursor)]);
        let (_,older,_) = lab.get(&before,true).await;
        let after_cursor = visible_cursor(&older,true);
        let after = url(&path,&[("after",&after_cursor)]);
        let (_,newer,_) = lab.get(&after,true).await;
        let turn_id = if id == "a" {source["turnId"].as_str().unwrap()} else {"giant"};
        let item_id = if id == "a" {source["itemId"].as_str().unwrap()} else {"huge-text"};
        for params in [vec![("turnId",turn_id)],vec![("turnId",turn_id),("itemId",item_id)]] {
            let target_url = url(&path,&params);
            let (status,target,_) = lab.get(&target_url,true).await;
            assert_eq!(status,StatusCode::OK);
            replies.insert(target_url,target);
        }
        replies.insert(path,page);
        replies.insert(before,older);
        replies.insert(after,newer);
        measurements.push(json!({"id":id,"fullBytes":full_bytes,"windowBytes":bytes,"bodyAndIndexSerializationBytes":serialized.len(),
            "internalReadMs":read_ms,"projectionMs":project_ms,"serializeMs":serialize_ms,"routerReadSerializeAndTestParseMs":router_ms,
            "build":"debug; timings are diagnostic, not release or browser latency"}));
    }
    let original_url = "/api/agents/b/items/huge-text/original?turnId=giant";
    let (_,full,_) = lab.get(original_url,false).await;
    assert_eq!(full["text"],giant.turns[0]["items"].as_array().unwrap().last().unwrap()["text"]);
    replies.insert(original_url.into(),full);
    let copy_url = format!("/api/agents/a/turns/{}/original", source["turnId"].as_str().unwrap());
    let (_,copy,_) = lab.get(&copy_url,false).await;
    let copied_items = copy["items"].as_array().unwrap().len();
    replies.insert(copy_url,copy);
    let search_query: String = record.turns.iter().flat_map(|t|t["items"].as_array().into_iter().flatten())
        .find(|i| i["type"] == "agentMessage" && i["text"].as_str().is_some_and(|s|s.len()>16)).unwrap()["text"].as_str().unwrap().chars().take(10).collect();
    let search_url = url("/api/agents/a/conversation/search",&[("q",&search_query)]);
    let (_,matches,_) = lab.get(&search_url,false).await;
    let hit = &matches[0];
    let target_url = url("/api/agents/a",&[("turnId",hit["turnId"].as_str().unwrap()),("itemId",hit["itemId"].as_str().unwrap())]);
    let (_,target,_) = lab.get(&target_url,true).await;
    replies.insert(target_url,target);
    replies.insert(search_url,matches);
    // A later snapshot with enough new work to evict the initial tail. The
    // pinned reading cursor must still return exactly that older body window.
    let (pin_turn,pin_item): (String,Option<String>) = serde_json::from_str(replies["/api/agents/a"]["conversation"]["start"].as_str().unwrap()).unwrap();
    let pin_url = url("/api/agents/a",&[("turnId",&pin_turn),("itemId",pin_item.as_deref().unwrap())]);
    let (_,pinned,_) = lab.get(&pin_url,true).await;
    replies.insert(pin_url.clone(),pinned);
    let mut grown = record.clone();
    grown.turns.push(json!({"id":"t77-grown","status":"inProgress","items":(0..150).map(|i|
        json!({"id":format!("t77-grown-{i}"),"type":"agentMessage","text":format!("New live message {i}")})).collect::<Vec<_>>() }));
    let growth_lab = Lab::from(grown);
    let (_,grown_latest,_) = growth_lab.get("/api/agents/a",true).await;
    let (_,grown_pinned,_) = growth_lab.get(&pin_url,true).await;
    assert_eq!(grown_pinned["conversation"]["hasAfter"],true);
    let growth = json!({"/api/agents/a":grown_latest, pin_url:grown_pinned});
    let output = std::path::PathBuf::from(std::env::var("T77_API_OUTPUT").unwrap());
    assert!(output.is_absolute() && output.to_string_lossy().contains("/target/t77/"));
    std::fs::write(&output,serde_json::to_vec(&json!({"source":source,"replies":replies,"growth":growth,"measurements":measurements,"searchQuery":search_query,"copiedItems":copied_items})).unwrap()).unwrap();
    std::fs::write(output.with_file_name("core-measurements.json"),serde_json::to_vec_pretty(&measurements).unwrap()).unwrap();
}
