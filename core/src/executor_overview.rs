//! An executor's Overview for its session's Overview tab (T-43 S3):
//! `GET /api/agents/{id}/executor`, one read of Core's records
//! (`collaboration_store::executor_overview`). For executors only: another
//! Agent, or none, is not found. Whether it waits for an answer comes from
//! its listing, where requests are live.
use crate::{server::ApiError, workspace::Workspace};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use std::sync::Arc;

async fn get_overview(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> Response {
    let Ok(agent) = ws.listed(&id).await else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"No such Agent","code":"agent_not_found"}))).into_response();
    };
    let waiting = agent.pending_count > 0 || agent.status == "waiting";
    match ws
        .stored(move |store| crate::collaboration_store::executor_overview::overview(&*store.db.read()?, &id, waiting))
        .await
    {
        Ok(Some(overview)) => Json(overview).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({"error":"This Agent is no executor","code":"not_executor"}))).into_response(),
        Err(error) => ApiError::from(error).into_response(),
    }
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/agents/{id}/executor", get(get_overview))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{executor_lifecycle::tests::{role, task}, model::AgentDetail};
    use serde_json::Value;
    use tower::ServiceExt;

    fn agent(ws: &Workspace, id: &str, status: &str) {
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work",
            "model":"","harness":"codex","color":"sage","status":status,"createdAt":"now","updatedAt":"now",
            "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&detail).unwrap();
    }

    async fn get(ws: &Arc<Workspace>, id: &str) -> (StatusCode, Value) {
        let request = axum::http::Request::builder().uri(format!("/api/agents/{id}/executor")).body(axum::body::Body::empty()).unwrap();
        let response = router().with_state(ws.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    /// T-43 S3: the route answers for an executor only, and whether one
    /// waits for an answer is its listing's (its work isn't going on then).
    #[tokio::test]
    async fn only_an_executor_has_an_overview_and_its_listing_says_whether_it_waits() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
        let (status, body) = get(&ws, "missing").await;
        assert_eq!((status, body["code"].clone()), (StatusCode::NOT_FOUND, json!("agent_not_found")));
        agent(&ws, "plain", "idle");
        let (status, body) = get(&ws, "plain").await;
        assert_eq!((status, body["code"].clone()), (StatusCode::NOT_FOUND, json!("not_executor")));

        for (id, status) in [("e1", "working"), ("e2", "waiting")] {
            let (_, internal) = task(&ws.store, &format!("Overview of {id}"));
            agent(&ws, id, status);
            role(&ws.store, id, &internal, "user", &format!("d-{id}"), "running", None);
        }
        let work = |body: &Value| body["steps"].as_array().unwrap().iter().find(|s| s["kind"] == "work").unwrap()["state"].clone();
        let (status, working) = get(&ws, "e1").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!((working["agentId"].clone(), working["task"]["title"].clone()), (json!("e1"), json!("Overview of e1")));
        assert_eq!(work(&working), "doing");
        let (_, waiting) = get(&ws, "e2").await;
        assert_eq!(work(&waiting), "todo", "it waits for you");
    }
}
