//! What the sidebar shows of each open executor's delivery (T-43 S2): its
//! task's pull request, the CI on that PR's head and the review rounds on
//! that head, as Core last recorded them. One small Workspace-wide read of
//! local records, as /api/ci/live is: it never asks GitHub. The web reads it
//! again on each collaboration change, which a GitHub refresh, a link and a
//! review each announce (github/mod.rs, pr_review/mod.rs).
//!
//! Only open executors: not released and closed for good (`archived_at`),
//! their Agent not closed. Their PR is the open or draft one with the
//! highest number, else the highest-numbered one: a sliced task's next PR
//! comes after its merged ones.
use crate::{server::ApiError, store::Store, workspace::Workspace};
use anyhow::Result;
use axum::{extract::State, routing::get, Json, Router};
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use std::sync::Arc;

/// The review rounds on `head` of a task's PR link, oldest first: how many
/// approved it since the newest that asked for changes (no_findings or
/// approved_with_notes), whether the newest asked for changes, and whether
/// one is under way. A review whose reviewer never started is no round, as
/// the task's delivery view counts them (collaboration_store/current.rs).
fn rounds(db: &Connection, task: &str, link: &str, head: &str) -> Result<Value> {
    let mut query = db.prepare(
        "SELECT status, data ->> '$.headSha', data ->> '$.conclusion', data ->> '$.actualHarness' IS NOT NULL
         FROM pr_reviews WHERE task_id=?1 AND link_id=?2 ORDER BY rowid",
    )?;
    let rows = query.query_map(params![task, link], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, bool>(3)?))
    })?;
    let (mut approved, mut changes, mut running) = (0, false, false);
    for row in rows {
        let (status, at, conclusion, reviewed) = row?;
        if at.as_deref() != Some(head) {
            continue;
        }
        match (status.as_str(), conclusion.as_deref()) {
            ("preparing" | "running", _) => running = true,
            ("completed", Some("no_findings" | "approved_with_notes")) if reviewed => {
                approved += 1;
                changes = false;
            }
            ("completed", Some("changes_requested")) if reviewed => {
                approved = 0;
                changes = true;
            }
            _ => {}
        }
    }
    Ok(json!({"approved":approved,"changesRequested":changes,"running":running}))
}

/// The PR a task's executor delivers on, from the task's GitHub links (see
/// the module's note): its number, state and head, the CI state on that
/// head (unknown when Core last saw CI for another commit) and its rounds.
fn pull(db: &Connection, task: &str, links: &[Value]) -> Result<Option<Value>> {
    let pulls = || links.iter().filter(|l| l["kind"] == "pull");
    let number = |l: &&Value| l["number"].as_u64().unwrap_or(0);
    let open = |l: &&Value| matches!(l["snapshot"]["state"].as_str(), Some("open" | "draft"));
    let Some(link) = pulls().filter(open).max_by_key(number).or_else(|| pulls().max_by_key(number)) else {
        return Ok(None);
    };
    let snapshot = &link["snapshot"];
    let head = snapshot["headSha"].as_str();
    let ci = match head {
        Some(head) if snapshot["ci"]["headSha"] == head => snapshot["ci"]["state"].as_str().unwrap_or("unknown"),
        _ => "unknown",
    };
    let reviews = match head {
        Some(head) => rounds(db, task, link["id"].as_str().unwrap_or_default(), head)?,
        None => json!({"approved":0,"changesRequested":false,"running":false}),
    };
    Ok(Some(json!({"number":link["number"],"url":link["url"],"state":snapshot["state"],"headSha":head,"ci":ci,"reviews":reviews})))
}

impl Store {
    /// By executor Agent ID: `{pr}` for each open executor whose task links a PR.
    pub(crate) fn executors_live(&self) -> Result<Value> {
        let db = self.db.read()?;
        let mut query = db.prepare(
            "SELECT r.agent_id, r.task_id FROM agent_roles r JOIN agents a ON a.id=r.agent_id
             WHERE r.kind='executor' AND r.archived_at IS NULL AND r.task_id IS NOT NULL
             AND a.data ->> '$.agent.closedAt' IS NULL",
        )?;
        let open = query.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let tasks: Vec<&str> = open.iter().map(|(_, task)| task.as_str()).collect();
        let links = crate::github::store::task_summaries(&db, &tasks)?;
        let mut executors = Map::new();
        for (agent, task) in &open {
            if let Some(pr) = pull(&db, task, links.get(task).map(Vec::as_slice).unwrap_or_default())? {
                executors.insert(agent.clone(), json!({"pr":pr}));
            }
        }
        Ok(json!({"executors":executors}))
    }
}

async fn get_live(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.stored(|s| s.executors_live()).await?))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/executors/live", get(get_live))
}

#[cfg(test)]
#[path = "executor_live_tests.rs"]
mod tests;
