//! Two authenticated Agents through real HTTP MCP; no model or native runtime.
use super::*;
use crate::model::AgentDetail;
use rmcp::{
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt as _,
};
use std::time::Duration;

#[tokio::test]
async fn two_agents_dispatch_submit_and_receive_automatic_result_over_mcp() {
    let directory = tempfile::tempdir().unwrap();
    let ws = Workspace::new(
        directory.path().to_owned(),
        directory.path().to_string_lossy().into_owned(),
        "unused-harness".into(),
    )
    .unwrap();
    for id in ["lead", "dev"] {
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{
            "id":id,"name":id,"cwd":directory.path(),"model":"test","color":"sage",
            "threadId":format!("session-{id}"),"status":"offline","createdAt":"now","updatedAt":"now",
            "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&detail).unwrap();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = router(ws.clone(), port);
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut clients = Vec::new();
    for id in ["lead", "dev"] {
        let transport = StreamableHttpClientTransport::with_client(
            reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
            StreamableHttpClientTransportConfig::with_uri(format!(
                "http://127.0.0.1:{port}/mcp/{id}"
            ))
            .auth_header(ws.store.collaboration_mcp_token(id).unwrap()),
        );
        clients.push(
            tokio::time::timeout(Duration::from_secs(10), ().serve(transport))
                .await
                .unwrap()
                .unwrap(),
        );
    }
    let request = |name: &str, args: Value| {
        CallToolRequestParams::new(name.to_owned())
            .with_arguments(args.as_object().unwrap().clone())
    };
    let tools = clients[1].list_all_tools().await.unwrap();
    assert!(tools
        .iter()
        .find(|t| t.name == "task_submit_result")
        .unwrap()
        .input_schema["properties"]
        .get("dispatchId")
        .is_some());
    let created = clients[0]
        .call_tool(request(
            "task_create",
            json!({"requestId":"create","title":"Single shared goal",
                "description":"Keep the original task and return validation.",
                "materials":{"acceptance":"Original task result reaches the dispatcher.",
                    "references":[{"kind":"evidence","label":"Spec","url":"https://example.test/spec"}]}}),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let task = &created["task"]["id"];
    let dispatched = clients[0]
        .call_tool(request(
            "task_dispatch",
            json!({"requestId":"dispatch","taskId":task,
        "expectedVersion":1,"toAgentId":"dev","body":"Use the existing flow."}),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let read = clients[1]
        .call_tool(request("peer_read", json!({"priority":"normal"})))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let dispatch_id = &read["messages"][0]["dispatchId"];
    assert_eq!(dispatch_id, &dispatched["task"]["dispatch"]["id"]);
    assert!(read["messages"][0]["body"].as_str().unwrap().contains("Original task result reaches"));
    assert!(read["messages"][0]["body"].as_str().unwrap().contains("Use the existing flow."));
    let material = clients[1].call_tool(request("task_get", json!({"taskId":task,"dispatchId":dispatch_id})))
        .await.unwrap().structured_content.unwrap();
    assert_eq!(material["dispatchMaterials"]["task"]["title"], "Single shared goal");
    assert_eq!(material["dispatchMaterials"]["effective"]["references"][0]["url"], "https://example.test/spec");
    let submit = request(
        "task_submit_result",
        json!({"requestId":"submit","taskId":task,"expectedVersion":2,
        "dispatchId":dispatch_id,"summary":"独立通道验证通过","links":[{"label":"Evidence","url":"https://example.test/result"}]}),
    );
    let submitted = clients[1].call_tool(submit.clone()).await.unwrap();
    assert_ne!(submitted.is_error, Some(true));
    let result = submitted.structured_content.unwrap();
    let retried = clients[1]
        .call_tool(submit)
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(result["message"]["id"], retried["message"]["id"]);
    let inbox = clients[0]
        .call_tool(request("peer_read", json!({"priority":"normal"})))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(inbox["messages"].as_array().unwrap().len(), 1);
    assert_eq!(
        inbox["messages"][0]["resultId"],
        result["task"]["result"]["id"]
    );
    assert_eq!(inbox["messages"][0]["reportedBy"]["id"], "dev");
    assert_eq!(inbox["messages"][0]["source"]["sessionId"], "session-dev");
    let detail = clients[0]
        .call_tool(request("task_get", json!({"taskId":task})))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(detail["task"]["status"], "review");
    assert_eq!(detail["task"]["result"]["reportedBy"]["id"], "dev");
    assert_eq!(
        detail["task"]["result"]["links"][0]["url"],
        "https://example.test/result"
    );
    for client in clients {
        let _ = client.cancel().await;
    }
    server.abort();
    let _ = server.await;
}
