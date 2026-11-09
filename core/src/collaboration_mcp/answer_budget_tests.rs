//! YN-69 S8 through real HTTP MCP: an answer an OpenCode Agent could not see
//! (one line over 51,200 bytes) is refused to it, saying how to read it in
//! parts; a Claude Agent gets it whole; and paging stays within an answer.
use super::*;
use crate::model::AgentDetail;
use rmcp::{
    transport::{streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport},
    ServiceExt as _,
};
use std::time::Duration;

#[tokio::test]
async fn an_answer_opencode_cannot_show_is_refused_to_it_and_whole_for_claude() {
    let directory = tempfile::tempdir().unwrap();
    let ws = Workspace::new(directory.path().to_owned(), directory.path().to_string_lossy().into_owned(), "unused-harness".into())
        .unwrap();
    for (id, harness) in [("oc", "opencode"), ("cc", "claude")] {
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{
            "id":id,"name":id,"cwd":directory.path(),"model":"test","color":"sage","harness":harness,
            "threadId":format!("session-{id}"),"status":"offline","createdAt":"now","updatedAt":"now",
            "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&detail).unwrap();
    }
    for n in 0..4 {
        ws.store.collaboration_call(Some("cc"), "task_create", json!({"requestId":format!("t{n}"),"title":format!("Task {n}"),
            "description":format!("{n} {}", "d".repeat(16_000))})).unwrap();
    }
    for n in 0..30 {
        ws.store.collaboration_call(Some("cc"), "peer_send", json!({"requestId":format!("m{n}"),"toAgentId":"oc",
            "body":format!("{n} {}", "m".repeat(3000))})).unwrap();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = router(ws.clone(), port);
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut clients = Vec::new();
    for id in ["oc", "cc"] {
        let transport = StreamableHttpClientTransport::with_client(
            reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap(),
            StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{port}/mcp/{id}"))
                .auth_header(ws.store.collaboration_mcp_token(id).unwrap()),
        );
        clients.push(tokio::time::timeout(Duration::from_secs(10), ().serve(transport)).await.unwrap().unwrap());
    }
    let request = |name: &str, args: Value| CallToolRequestParams::new(name.to_owned()).with_arguments(args.as_object().unwrap().clone());
    let whole = json!({"compact":false});
    let refused = clients[0].call_tool(request("task_list", whole.clone())).await.unwrap();
    assert_eq!(refused.is_error, Some(true), "{:?}", refused.structured_content);
    let error = refused.structured_content.unwrap()["error"].as_str().unwrap().to_owned();
    assert!(error.starts_with("answer_too_large_for_opencode") && error.contains("51200") && error.contains("compact"), "{error}");
    let text: String = refused.content.iter().filter_map(|c| c.as_text().map(|t| t.text.clone())).collect();
    assert!(text.len() < 2000, "the refusal is short: {}", text.len());
    let listed = clients[1].call_tool(request("task_list", whole)).await.unwrap();
    assert_ne!(listed.is_error, Some(true));
    let listed = listed.structured_content.unwrap();
    assert!(listed.to_string().len() > 51_200 && listed["tasks"].as_array().unwrap().len() == 4, "a Claude Agent reads it whole");
    // Paging stays within an answer, reads every message once, and only what
    // a page holds is marked read.
    let reads = |ws: &Workspace| -> usize {
        ws.store.db.read().unwrap().query_row("SELECT COUNT(*) FROM collaboration_message_reads WHERE reader_id='oc'", [],
            |r| r.get::<_, i64>(0)).unwrap() as usize
    };
    let mut seen = Vec::new();
    let mut after = 0;
    loop {
        let page = clients[0].call_tool(request("peer_read", json!({"afterSeq":after,"limit":50}))).await.unwrap();
        assert_ne!(page.is_error, Some(true), "{:?}", page.structured_content);
        let page = page.structured_content.unwrap();
        assert!(page.to_string().len() <= 49_152, "{}", page.to_string().len());
        seen.extend(page["messages"].as_array().unwrap().iter().map(|m| m["seq"].as_i64().unwrap()));
        assert_eq!(reads(&ws), seen.len(), "only the messages pages held are read");
        after = page["nextAfterSeq"].as_i64().unwrap();
        if page["hasMore"] != true {
            break;
        }
    }
    assert_eq!(seen.len(), 30, "{seen:?}");
    for client in clients {
        let _ = client.cancel().await;
    }
    server.abort();
}

/// YN-69 S8: the store ends a page early for the budget, at a seq, and marks
/// as read only the messages it returns: the rest stay unread, so their
/// wake-up still comes. Without a budget (the GUI over HTTP) a page is as before.
#[tokio::test]
async fn a_mailbox_page_ended_for_the_budget_leaves_the_rest_unread() {
    let directory = tempfile::tempdir().unwrap();
    let ws = Workspace::new(directory.path().to_owned(), directory.path().to_string_lossy().into_owned(), "unused-harness".into())
        .unwrap();
    for id in ["lead", "dev"] {
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{
            "id":id,"name":id,"cwd":directory.path(),"model":"test","color":"sage",
            "threadId":format!("session-{id}"),"status":"offline","createdAt":"now","updatedAt":"now",
            "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&detail).unwrap();
    }
    for n in 0..40 {
        ws.store.collaboration_call(Some("lead"), "peer_send", json!({"requestId":format!("m{n}"),"toAgentId":"dev",
            "body":format!("{n} {}", "m".repeat(3000))})).unwrap();
    }
    let reads = || -> i64 {
        ws.store.db.read().unwrap().query_row("SELECT COUNT(*) FROM collaboration_message_reads WHERE reader_id='dev'", [], |r| r.get(0)).unwrap()
    };
    let page = |after: i64| ws.store.collaboration_call(Some("dev"), "peer_read",
        json!({"afterSeq":after,"limit":50,"byteBudget":crate::mcp_views::BUDGET})).unwrap();
    let first = page(0);
    let shown: Vec<i64> = first["messages"].as_array().unwrap().iter().map(|m| m["seq"].as_i64().unwrap()).collect();
    assert!(!shown.is_empty() && shown.len() < 40 && first["hasMore"] == true, "{}", shown.len());
    assert!(first["more"].as_str().unwrap().contains("nextAfterSeq"));
    assert_eq!(shown.iter().max().copied(), first["nextAfterSeq"].as_i64(), "it ends at a seq");
    assert!(crate::mcp_views::answer("peer_read", first.clone(), None).to_string().len() <= crate::mcp_views::BUDGET);
    assert_eq!(reads(), shown.len() as i64, "the messages after the page stay unread");
    let mut seen = shown;
    let mut after = first["nextAfterSeq"].as_i64().unwrap();
    loop {
        let next = page(after);
        seen.extend(next["messages"].as_array().unwrap().iter().map(|m| m["seq"].as_i64().unwrap()));
        assert_eq!(reads(), seen.len() as i64);
        after = next["nextAfterSeq"].as_i64().unwrap();
        if next["hasMore"] != true {
            break;
        }
    }
    let mut sorted = seen.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!((seen.len(), sorted.len()), (40, 40), "every message once");
    // Without a budget, as the GUI reads it: all of them, in one page, as before.
    let whole = ws.store.collaboration_call(None, "peer_read", json!({"agentId":"dev"})).unwrap();
    assert_eq!((whole["messages"].as_array().unwrap().len(), whole.get("more").is_none()), (40, true));
}
