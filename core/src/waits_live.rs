//! What each Agent left running that the rail's ring says it waits on
//! (YN-51), besides its Jobs (/api/jobs/live) and CI (/api/ci/live): the
//! review rounds whose result is mailed to it, and the background shells and
//! sub-agents its harness reports now. One small Workspace-wide read of
//! local records and memory, as /api/ci/live is: it never asks GitHub or a
//! harness. The web reads it again when an Agent or the board changes: a
//! review starting or ending announces a board change (pr_review/mod.rs), a
//! changed background count an Agent change (background_shells.rs).
use crate::{server::ApiError, store::Store, workspace::Workspace};
use anyhow::Result;
use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Map, Value};
use std::sync::Arc;

impl Store {
    /// By recipient Agent: the review rounds preparing or running whose
    /// result is mailed to it (`notificationRecipient`: review_start's
    /// notifyAgentId, else whoever started it), how many, and the newest's
    /// PR number and round.
    pub(crate) fn live_reviews(&self) -> Result<Map<String, Value>> {
        let db = self.db.read()?;
        let mut query = db.prepare(
            "SELECT data ->> '$.notificationRecipient.id', data ->> '$.number', data ->> '$.round' FROM pr_reviews
             WHERE status IN ('preparing','running') AND data ->> '$.notificationRecipient.kind'='agent' ORDER BY rowid",
        )?;
        let rows = query.query_map([], |r| {
            Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, Option<i64>>(2)?))
        })?;
        let mut agents = Map::new();
        for row in rows {
            let (Some(agent), pr, round) = row? else { continue };
            let entry = agents.entry(agent).or_insert_with(|| json!({"running":0}));
            entry["running"] = json!(entry["running"].as_u64().unwrap_or(0) + 1);
            entry["pr"] = json!(pr);
            entry["round"] = json!(round);
        }
        Ok(agents)
    }
}

/// `{agents: {id: {reviews?: {running, pr, round}, shells?, subAgents?}}}`:
/// only Agents with something running, only the parts that are.
fn waits(reviews: Map<String, Value>, background: std::collections::BTreeMap<String, (usize, usize)>) -> Value {
    let mut agents = Map::new();
    for (id, review) in reviews {
        agents.insert(id, json!({"reviews":review}));
    }
    for (id, (shells, sub_agents)) in background {
        if shells == 0 && sub_agents == 0 {
            continue;
        }
        let entry = agents.entry(id).or_insert_with(|| json!({}));
        if shells > 0 {
            entry["shells"] = json!(shells);
        }
        if sub_agents > 0 {
            entry["subAgents"] = json!(sub_agents);
        }
    }
    json!({"agents":agents})
}

async fn get_live(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    let reviews = ws.stored(|s| s.live_reviews()).await?;
    Ok(Json(waits(reviews, crate::background_shells::live(&ws))))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/waits/live", get(get_live))
}

#[cfg(test)]
#[path = "waits_live_tests.rs"]
mod tests;
