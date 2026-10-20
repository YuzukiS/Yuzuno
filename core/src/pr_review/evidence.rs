//! Evidence for a changed path that a review could not cover, registered by
//! an Agent or the user, kept apart from the review. Each record is bound to
//! one review's frozen candidate: base, head and merge base, the path, and its
//! blob and mode on each side. It is shown with a review only as "bound to
//! this candidate" when every one of those matches; otherwise as another
//! candidate's. A reference is recorded to be followed, never fetched or
//! checked here, and the note is the author's. Nothing in it changes a
//! review's conclusion, reasons, scope or whether it passes.
use crate::{model::now, store::Store};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

pub(super) const KINDS: [&str; 5] = ["source_review", "build_provenance", "artifact_hash", "signature", "behaviour_test"];
const PER_TASK: i64 = 500;

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS pr_review_evidence (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES collaboration_tasks(id),
      actor TEXT NOT NULL, request_id TEXT NOT NULL, input TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS pr_review_evidence_request ON pr_review_evidence(task_id, actor, request_id);",
    )?;
    Ok(())
}

#[derive(Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Add {
    request_id: String,
    task_id: String,
    review_id: String,
    path: String,
    kind: String,
    reference: Reference,
    artifact_sha256: Option<String>,
    note: Option<String>,
    previous_evidence_id: Option<String>,
}
/// Exactly one: another review of this task, a Job of this task, a CI run of
/// the reviewed repository, or an https link.
#[derive(Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    review_id: Option<String>,
    job_id: Option<String>,
    ci_run_key: Option<String>,
    url: Option<String>,
}

fn reference(db: &Connection, task: &str, run: &Value, r: &Reference) -> Result<Value> {
    let given = [&r.review_id, &r.job_id, &r.ci_run_key, &r.url].iter().filter(|v| v.is_some()).count();
    ensure!(given == 1, "reference needs exactly one of reviewId, jobId, ciRunKey or url");
    if let Some(id) = &r.review_id {
        let found: Option<String> = db
            .query_row("SELECT id FROM pr_reviews WHERE id=?1 AND task_id=?2", params![id, task], |row| row.get(0))
            .optional()?;
        ensure!(found.is_some(), "reference.reviewId is not a review of this task");
        return Ok(json!({"reviewId":id}));
    }
    if let Some(id) = &r.job_id {
        let data: Option<String> =
            db.query_row("SELECT data FROM local_jobs WHERE id=?1", [id], |row| row.get(0)).optional()?;
        let job: Value = data.as_deref().map(serde_json::from_str).transpose()?.unwrap_or(Value::Null);
        ensure!(job["taskId"] == task, "reference.jobId is not a Job of this task");
        return Ok(json!({"jobId":id}));
    }
    if let Some(key) = &r.ci_run_key {
        let parts: Vec<_> = key.split(':').collect();
        let numeric = |s: &str| !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit());
        ensure!(
            parts.len() == 4 && parts[0] == "github" && parts[1..].iter().all(|p| numeric(p)),
            "reference.ciRunKey must look like github:<repositoryId>:<runId>:<attempt>, as ci_list shows it"
        );
        ensure!(
            run["repositoryId"].as_i64().map(|id| id.to_string()).as_deref() == Some(parts[1]),
            "reference.ciRunKey is a run of another repository than the reviewed one"
        );
        return Ok(json!({"ciRunKey":key}));
    }
    let url = r.url.as_deref().unwrap_or_default();
    let rest = url.strip_prefix("https://").unwrap_or_default();
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    ensure!(
        !authority.is_empty() && !authority.contains('@') && url.len() <= 500
            && !url.chars().any(|c| c.is_whitespace() || c.is_control()),
        "reference.url must be an https link of at most 500 characters, without credentials"
    );
    Ok(json!({"url":url}))
}

impl Store {
    pub(crate) fn add_review_evidence(&self, actor: Option<&str>, input: Value) -> Result<Value> {
        let input: Add = serde_json::from_value(input)?;
        ensure!(!input.request_id.trim().is_empty() && input.request_id.len() <= 128, "requestId must contain 1–128 bytes");
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let (author, _) = crate::collaboration_store::actor_context(self, &tx, actor)?;
        let task = crate::collaboration_store::task_key(&tx, &input.task_id)?.0;
        let who = actor.map_or_else(|| "user".to_owned(), |a| format!("agent:{a}"));
        let mut expected = serde_json::to_value(&input)?;
        expected["taskId"] = json!(task);
        let earlier: Option<(String, String)> = tx
            .query_row(
                "SELECT input,data FROM pr_review_evidence WHERE task_id=?1 AND actor=?2 AND request_id=?3",
                params![task, who, input.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((payload, data)) = earlier {
            ensure!(serde_json::from_str::<Value>(&payload)? == expected, "requestId was already used for different evidence");
            return Ok(serde_json::from_str(&data)?);
        }
        let run: Value = serde_json::from_str(
            &tx.query_row("SELECT data FROM pr_reviews WHERE id=?1 AND task_id=?2", params![input.review_id, task], |r| r.get::<_, String>(0))
                .optional()?
                .context("reviewId is not a review of this task")?,
        )?;
        let scoped = run["scope"]["paths"]
            .as_array()
            .context("This review has no recorded scope (coverage policy 3 or later), so evidence can't be bound to it")?
            .iter()
            .find(|p| p["path"] == input.path.as_str())
            .cloned()
            .context("path is not one of this review's changed paths")?;
        ensure!(KINDS.contains(&input.kind.as_str()), "kind must be one of {}", KINDS.join(", "));
        let artifact = input.artifact_sha256.as_deref();
        ensure!(
            artifact.is_none_or(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))),
            "artifactSha256 must be 64 lowercase hexadecimal characters"
        );
        ensure!(input.kind != "artifact_hash" || artifact.is_some(), "artifact_hash evidence needs artifactSha256");
        ensure!(input.note.as_deref().is_none_or(|n| n.len() <= 500), "note is at most 500 bytes");
        if let Some(previous) = &input.previous_evidence_id {
            let found: Option<String> = tx
                .query_row("SELECT id FROM pr_review_evidence WHERE id=?1 AND task_id=?2", params![previous, task], |r| r.get(0))
                .optional()?;
            ensure!(found.is_some(), "previousEvidenceId is not evidence of this task");
        }
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM pr_review_evidence WHERE task_id=?1", [&task], |r| r.get(0))?;
        ensure!(count < PER_TASK, "This task has reached its evidence limit");
        let reference = reference(&tx, &task, &run, &input.reference)?;
        // What the review itself read of the head side, when it is a regular
        // file it couldn't deliver as text: the content's SHA-256.
        let head_content = scoped["facts"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|f| f["kind"] == "unsupported" && f["side"] == "head")
            .and_then(|f| f["contentSha256"].as_str());
        let id = uuid::Uuid::new_v4().to_string();
        let data = json!({"id":id,"taskId":task,"reviewId":input.review_id,"path":input.path,"kind":input.kind,"reference":reference,
            "artifactSha256":artifact,"note":input.note,"reassociatedFrom":input.previous_evidence_id,
            "registeredBy":author,"registeredAt":now(),
            "candidate":{"repositoryId":run["repositoryId"],"linkId":run["linkId"],"baseSha":run["baseSha"],"headSha":run["headSha"],
                "mergeBaseSha":run["mergeBaseSha"],"mergeBase":scoped["mergeBase"],"head":scoped["head"],"state":scoped["state"]},
            "artifactMatchesHeadContent":artifact.zip(head_content).map(|(a, c)| a == c)});
        tx.execute(
            "INSERT INTO pr_review_evidence(id,task_id,actor,request_id,input,data) VALUES(?1,?2,?3,?4,?5,?6)",
            params![id, task, who, input.request_id, expected.to_string(), data.to_string()],
        )?;
        tx.commit()?;
        Ok(data)
    }
}

/// The task's evidence for the same PR's changed paths, each marked
/// `this_candidate` only when its bound base, head, merge base and that
/// path's blobs and modes all equal this review's; otherwise
/// `other_candidate`. Reviews without a scope get none.
pub(super) fn attach(db: &Connection, task: &str, run: &mut Value) -> Result<()> {
    let Some(paths) = run["scope"]["paths"].as_array().cloned() else {
        return Ok(());
    };
    let mut q = db.prepare("SELECT data FROM pr_review_evidence WHERE task_id=?1 ORDER BY rowid")?;
    let rows = q.query_map([task], |r| r.get::<_, String>(0))?;
    let mut shown = Vec::new();
    for row in rows {
        let mut item: Value = serde_json::from_str(&row?)?;
        if item["candidate"]["linkId"] != run["linkId"] {
            continue;
        }
        let Some(path) = paths.iter().find(|p| p["path"] == item["path"]) else {
            continue;
        };
        let c = &item["candidate"];
        let same = c["baseSha"] == run["baseSha"]
            && c["headSha"] == run["headSha"]
            && c["mergeBaseSha"] == run["mergeBaseSha"]
            && c["mergeBase"] == path["mergeBase"]
            && c["head"] == path["head"];
        item["binding"] = json!(if same { "this_candidate" } else { "other_candidate" });
        shown.push(item);
    }
    run["evidence"] = json!(shown);
    Ok(())
}
