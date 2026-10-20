//! Bounded Agent-facing discovery. The GUI retains store::list_jobs's contract.
use super::store::{get, summary, QueueState};
use crate::{collaboration_store, projects, store::Store};
use anyhow::{ensure, Result};
use rusqlite::params;
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Scope {
    #[serde(rename = "self")]
    Own,
    Project,
    Workspace,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Input {
    scope: Option<Scope>,
    agent_id: Option<String>,
    task_id: Option<String>,
    // Missing means no Project filter; explicit null means tasks without one.
    #[serde(default, deserialize_with = "project_filter")]
    project_id: Option<Option<String>>,
    before: Option<i64>,
    live_before: Option<i64>,
    limit: Option<u64>,
    compact: Option<bool>,
}

fn project_filter<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

impl Store {
    pub(super) fn list_jobs_for(&self, actor: Option<&str>, input: Value) -> Result<Value> {
        if let Some(actor) = actor {
            self.list_jobs_mcp(actor, serde_json::from_value(input)?)
        } else {
            // The GUI keeps its Workspace history and independent live set.
            let q: super::List = serde_json::from_value(input)?;
            self.list_jobs(q.agent_id.as_deref(), q.task_id.as_deref(), q.before)
        }
    }

    fn list_jobs_mcp(&self, actor: &str, input: Input) -> Result<Value> {
        let limit = input.limit.unwrap_or(10);
        ensure!((1..=50).contains(&limit), "limit must be between 1 and 50");
        for (key, value) in [("agentId", &input.agent_id), ("taskId", &input.task_id)] {
            if let Some(value) = value {
                ensure!(
                    !value.trim().is_empty() && value.len() <= 128,
                    "{key} must contain 1–128 bytes"
                );
            }
        }
        let scope = input.scope.unwrap_or_else(|| {
            if input.project_id.is_some() {
                Scope::Project
            } else if input.agent_id.is_some() || input.task_id.is_some() {
                Scope::Workspace
            } else {
                Scope::Own
            }
        });
        let mut agent = input.agent_id;
        let scope_name = match scope {
            Scope::Own => {
                ensure!(
                    input.project_id.is_none(),
                    "projectId requires scope project"
                );
                ensure!(
                    agent.as_deref().is_none_or(|id| id == actor),
                    "scope self cannot select another agentId"
                );
                agent = Some(actor.into());
                "self"
            }
            Scope::Project => {
                ensure!(
                    input.project_id.is_some(),
                    "scope project requires projectId (null for tasks without a Project)"
                );
                "project"
            }
            Scope::Workspace => {
                ensure!(
                    input.project_id.is_none(),
                    "projectId requires scope project"
                );
                "workspace"
            }
        };
        let db = self.db.read()?;
        let (project_mode, project) = match input.project_id {
            None => (0, None),
            Some(None) => (1, None),
            Some(Some(id)) => {
                projects::ensure_exists(&db, &id)?;
                (2, Some(id))
            }
        };
        let task = input
            .task_id
            .as_deref()
            .map(|id| collaboration_store::task_key(&db, id).map(|v| v.0))
            .transpose()?;
        let queue = QueueState::read(&db)?;
        let compact = input.compact.unwrap_or(true);
        // Project membership belongs to the task, including archived tasks. Do
        // not fall back to the Agent's current Project for unassigned tasks.
        let mut query = db.prepare(
            "SELECT j.id, p.project_id FROM local_jobs j
             LEFT JOIN project_tasks p ON p.task_id=j.task_id
             WHERE (?1 IS NULL OR j.agent_id=?1) AND (?2 IS NULL OR j.task_id=?2)
               AND (?3=0 OR (?3=1 AND p.project_id IS NULL) OR (?3=2 AND p.project_id=?4))
               AND j.seq<?5 AND (?6=0 OR j.reserved=1 OR j.status IN ('queued','waiting'))
             ORDER BY j.seq DESC LIMIT ?7",
        )?;
        let mut page = |before: Option<i64>, live: bool| -> Result<(Vec<Value>, bool, Value)> {
            let rows = query
                .query_map(
                    params![
                        agent,
                        task,
                        project_mode,
                        project,
                        before.unwrap_or(i64::MAX),
                        live,
                        limit as i64 + 1
                    ],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let more = rows.len() > limit as usize;
            let jobs = rows
                .into_iter()
                .take(limit as usize)
                .map(|(id, project)| {
                    let job = queue.view(get(&db, &id)?);
                    let mut job = if compact {
                        compact_job(&job)
                    } else {
                        summary(job)
                    };
                    job["projectId"] = json!(project);
                    Ok(job)
                })
                .collect::<Result<Vec<_>>>()?;
            let next = jobs
                .last()
                .map(|j| j["cursor"].clone())
                .unwrap_or(Value::Null);
            Ok((jobs, more, next))
        };
        let (jobs, more, next) = page(input.before, false)?;
        let (mut live, live_more, live_next) = page(input.live_before, true)?;
        let live_ids: Vec<_> = live.iter().map(|j| j["id"].clone()).collect();
        let history_ids: HashSet<_> = jobs.iter().filter_map(|j| j["id"].as_str()).collect();
        // A live row already on this history page is referenced by liveJobIds,
        // not serialized twice. Compute the live cursor before deduplication.
        live.retain(|j| !history_ids.contains(j["id"].as_str().unwrap_or_default()));
        Ok(json!({
            "jobs":jobs, "hasMore":more, "nextBefore":next,
            "liveJobs":live, "liveJobIds":live_ids,
            "liveHasMore":live_more, "nextLiveBefore":live_next,
            "limit":limit, "compact":compact,
            "scope":{"kind":scope_name,"agentId":agent,"taskId":input.task_id,"projectId":project}
        }))
    }
}

/// No argv, env, paths, source context, machine inventory, or nested evidence.
/// Only the reason can contain arbitrary runner text; cap it in this view.
fn compact_job(job: &Value) -> Value {
    let mut out = json!({});
    for field in [
        "id",
        "cursor",
        "name",
        "status",
        "agentId",
        "taskRef",
        "reserved",
        "resources",
        "reservation",
        "createdAt",
        "startedAt",
        "finishedAt",
    ] {
        if !job[field].is_null() {
            out[field] = job[field].clone();
        }
    }
    if let Some(reason) = job["reason"].as_str() {
        let end = reason
            .char_indices()
            .nth(512)
            .map(|(i, _)| i)
            .unwrap_or(reason.len());
        out["reason"] = json!(&reason[..end]);
        if end < reason.len() {
            out["reasonTruncated"] = json!(true);
        }
    }
    if !job["pause"]["state"].is_null() {
        out["pauseState"] = job["pause"]["state"].clone();
    }
    if !job["executor"]["machineId"].is_null() {
        out["machineId"] = job["executor"]["machineId"].clone();
    }
    if !job["run"]["id"].is_null() {
        out["run"] = json!({"id":job["run"]["id"],"stage":job["run"]["stage"],"attempt":job["run"]["attempt"]});
    }
    out
}

pub(super) const DESCRIPTION: &str = "List managed jobs, defaulting to your own Agent with compact rows. Explicit agentId/taskId filters select across Agents without adding self. Use scope workspace for all projects, or projectId (null for tasks without a Project); Project membership follows the task, not the Agent. Filters are discovery, not authorization. Each history and live page has at most limit entries (default 10, max 50), newest first. Follow nextBefore while hasMore and independently nextLiveBefore as liveBefore while liveHasMore, keeping filters. jobs contains history including live jobs; liveJobIds identifies the current live page, and liveJobs supplies only rows not already in jobs. Each response serializes a job once; pages are live observations, not frozen snapshots. job_get has full details. GUI global history/live behavior is unchanged.";

pub(super) fn schema() -> Value {
    json!({
        "scope":{"type":"string","enum":["self","project","workspace"],"description":"Omit for self unless agentId/taskId/projectId is explicit. project requires projectId; self/workspace cannot combine with projectId."},
        "agentId":{"type":"string","description":"Explicit Agent filter; does not implicitly add your own Agent."},
        "taskId":{"type":"string","description":"Existing task ID, e.g. T-1 (legacy UUID accepted). Includes its jobs from all Agents unless agentId or scope self is explicit."},
        "projectId":{"type":["string","null"],"description":"Select by the job task's current Project. null selects tasks without a Project. Implies scope project; an unknown Project ID is an error."},
        "limit":{"type":"integer","minimum":1,"maximum":50,"default":10,"description":"Maximum rows in each history/live page; at most twice this many distinct jobs in one response."},
        "compact":{"type":"boolean","default":true,"description":"Short rows with state, resources, times and capped reason. false returns the prior list projection, still without env; full details use job_get."},
        "before":{"type":"integer","description":"History cursor from nextBefore; retain filters. Existing integer cursors remain valid."},
        "liveBefore":{"type":"integer","description":"Independent live cursor from nextLiveBefore; omit for the newest live page, including jobs older than history. Consult liveJobIds even when liveJobs is empty due to overlap."}
    })
}
