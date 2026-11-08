//! A run: a few stages of one experiment, each stage attempt an ordinary local
//! Job in the one queue. A stage is released only after every stage it needs
//! has truly succeeded with verified artifacts; the worker checks those
//! artifacts again before its command starts. Jobs own lifecycle, attempts and
//! evidence; seeds, scientific criteria and resumability stay the project's.
use super::{
    host,
    store::{get, insert_job, new_job, notify_message, save, summary, QueueState},
    Artifact, Requested, Submit,
};
use crate::{collaboration_store as collaboration, model::now, store::Store, workspace::Workspace};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
    sync::Arc,
};

mod after;
mod analysis;
mod queued;
pub(super) use analysis::Decision as AnalysisDecision;
#[cfg(test)]
pub(super) use queued::waiting_for;

const MAX_STAGES: usize = 16;
/// Every attempt of one stage, automatic and explicit retries together.
const MAX_ATTEMPTS: i64 = 20;
const TERMINAL: [&str; 5] = [
    "succeeded",
    "failed",
    "cancelled",
    "rejected",
    "interrupted",
];
const RETRYABLE: [&str; 4] = ["failed", "cancelled", "rejected", "interrupted"];

/// A stage attempt the user stopped at a verified checkpoint, not resumed
/// yet: only the user resumes it (YN-30).
pub(super) fn checkpointed(job: &Value) -> bool {
    job["status"] == "cancelled"
        && job["checkpointStop"]["state"] == "checkpointed"
        && job["checkpointStop"]["resumedAs"].is_null()
}

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS local_job_runs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        task_id TEXT NOT NULL, agent_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS local_job_runs_agent ON local_job_runs(agent_id,seq);
        CREATE INDEX IF NOT EXISTS local_job_runs_task ON local_job_runs(task_id,seq);
        CREATE TABLE IF NOT EXISTS local_job_run_attempts (
        run_id TEXT NOT NULL, stage TEXT NOT NULL, attempt INTEGER NOT NULL,
        job_id TEXT UNIQUE NOT NULL, PRIMARY KEY(run_id,stage,attempt));",
    )?;
    Ok(())
}

/// A research record of the run's task, named by its activity (T-17).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResearchRef {
    pub activity_seq: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RunSubmit {
    request_id: String,
    task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    experiment: Option<String>,
    /// A soft limit on recorded cost: no new stage attempt starts beyond it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cost_limit_usd: Option<f64>,
    /// The task's method record this run follows (T-17), fixed by activity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    method: Option<ResearchRef>,
    /// Earlier runs of the same Agent this one starts after (YN-30).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    after_runs: Vec<after::AfterRun>,
    pub(super) stages: Vec<Stage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Stage {
    key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default)]
    needs: Vec<String>,
    cwd: String,
    argv: Vec<String>,
    #[serde(default)]
    pub(super) env: BTreeMap<String, String>,
    resources: Requested,
    #[serde(default)]
    exclusive: bool,
    #[serde(default = "super::default_timeout")]
    timeout_seconds: u64,
    #[serde(default = "super::yes")]
    guard_git: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    guard_paths: Vec<String>,
    #[serde(default)]
    inputs: Vec<String>,
    #[serde(default)]
    outputs: Vec<String>,
    #[serde(default)]
    artifacts: Vec<Artifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retry: Option<Retry>,
    /// Keep a successful result for analysis before releasing its dependants.
    #[serde(default, skip_serializing_if = "is_false")]
    wait_for_analysis: bool,
    /// An earlier succeeded attempt to use instead of running this stage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reuse: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gpu: Option<super::gpu::GpuRequest>,
    /// How its command saves and exits when the user stops it at a
    /// checkpoint, as a Job's (YN-30). Not part of its identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    checkpoint: Option<super::Checkpoint>,
    /// Not available for stages; accepted only to be refused with the reason.
    #[serde(default, skip_serializing)]
    machine_id: Option<String>,
}

fn is_false(value: &bool) -> bool { !value }

impl Stage {
    pub(super) fn key(&self) -> &str {
        &self.key
    }
    pub(super) fn needs(&self) -> &[String] {
        &self.needs
    }
    pub(super) fn reuses(&self) -> bool {
        self.reuse.is_some()
    }
}

/// Which failures are infrastructure the project declared safe to run again,
/// and how many attempts in all. Nothing else is retried automatically.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Retry {
    attempts: i64,
    #[serde(default)]
    exit_codes: Vec<i64>,
    #[serde(default)]
    interrupted: bool,
}

fn valid_key(key: &str) -> bool {
    (1..=32).contains(&key.len())
        && key
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// At most `limit` bytes of `text`, on a character boundary.
fn clip(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

impl RunSubmit {
    pub(super) fn validate(&self) -> Result<()> {
        ensure!(
            !self.request_id.trim().is_empty() && self.request_id.len() <= 128,
            "requestId must contain 1–128 bytes"
        );
        ensure!(
            !self.name.trim().is_empty() && self.name.len() <= 160,
            "Run name must contain 1–160 bytes"
        );
        ensure!(
            self.experiment
                .as_ref()
                .is_none_or(|e| !e.trim().is_empty() && e.len() <= 160),
            "experiment must contain 1–160 bytes"
        );
        ensure!(
            self.cost_limit_usd
                .is_none_or(|usd| usd.is_finite() && usd > 0.0 && usd <= 1e6),
            "costLimitUsd must be a positive amount of at most 1000000"
        );
        ensure!(
            (1..=MAX_STAGES).contains(&self.stages.len()),
            "A run has 1–{MAX_STAGES} stages"
        );
        ensure!(
            self.after_runs.len() <= after::MAX_AFTER,
            "afterRuns names at most {} runs",
            after::MAX_AFTER
        );
        let mut earlier = BTreeSet::new();
        for stage in &self.stages {
            let key = &stage.key;
            ensure!(
                valid_key(key),
                "Stage keys are 1–32 letters, digits, '.', '_' or '-', starting with a letter or digit: {key:?}"
            );
            ensure!(
                stage.needs.iter().collect::<BTreeSet<_>>().len() == stage.needs.len(),
                "Stage {key} lists a need twice"
            );
            for need in &stage.needs {
                ensure!(
                    earlier.contains(need.as_str()),
                    "Stage {key} needs {need:?}, which is not an earlier stage of this run; list stages in dependency order"
                );
            }
            ensure!(
                earlier.insert(key.as_str()),
                "Stage key {key} is used twice"
            );
            if let Some(retry) = &stage.retry {
                ensure!(
                    (2..=5).contains(&retry.attempts),
                    "Stage {key}: retry.attempts counts every attempt, the first included, and must be 2–5"
                );
                ensure!(
                    retry.exit_codes.len() <= 16
                        && retry.exit_codes.iter().all(|c| (1..=255).contains(c)),
                    "Stage {key}: retry.exitCodes are at most 16 codes of 1–255"
                );
                ensure!(
                    !retry.exit_codes.is_empty() || retry.interrupted,
                    "Stage {key}: name the retryable outcomes with retry.exitCodes or retry.interrupted"
                );
            }
            ensure!(
                stage.machine_id.is_none(),
                "Stage {key}: stages run on this Core's host; machineId (a remote machine) is not available for runs of stages in this version"
            );
            if let Some(reuse) = &stage.reuse {
                ensure!(
                    uuid::Uuid::parse_str(reuse).is_ok(),
                    "Stage {key}: reuse names the job ID of an earlier attempt"
                );
            }
            // The stage named with the reason: tool errors show one message.
            let submit = self.submit(stage);
            submit
                .validate_command()
                .and_then(|()| submit.validate_checkpoint())
                .map_err(|error| anyhow::anyhow!("Stage {key}: {error:#}"))?;
        }
        Ok(())
    }
    /// The Job a stage's attempts run.
    pub(super) fn submit(&self, stage: &Stage) -> Submit {
        Submit {
            request_id: format!("{}#{}", self.request_id, stage.key),
            task_id: self.task_id.clone(),
            agent_id: self.agent_id.clone(),
            name: stage
                .name
                .clone()
                .unwrap_or_else(|| format!("{} · {}", clip(&self.name, 120), stage.key)),
            cwd: stage.cwd.clone(),
            argv: stage.argv.clone(),
            env: stage.env.clone(),
            resources: stage.resources.clone(),
            exclusive: stage.exclusive,
            timeout_seconds: stage.timeout_seconds,
            guard_git: stage.guard_git,
            guard_paths: stage.guard_paths.clone(),
            inputs: stage.inputs.clone(),
            outputs: stage.outputs.clone(),
            artifacts: stage.artifacts.clone(),
            gpu: stage.gpu.clone(),
            machine_id: None,
            requested_machine: None,
            checkpoint: stage.checkpoint.clone(),
            checkpoint_from: None,
            service: None,
            service_link: None,
            service_control: None,
        }
    }
}

fn sha(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

/// What a stage's result depends on apart from its upstream artifacts: its
/// command and configuration, frozen code and inputs, artifact contract and
/// the stages it needs. Resources, timeout, name and retry policy are
/// lifecycle, not inputs.
pub(super) fn spec_identity(submit: &Submit, snapshot: &Value, needs: &[String]) -> Value {
    let mut command = json!({"argv":submit.argv,"cwd":snapshot["cwd"],"env":submit.env,"guardGit":submit.guard_git});
    // With guardPaths (T-50) the code is what they guard, not the HEAD commit;
    // without them both parts stay as every earlier attempt recorded them.
    let code = if submit.guard_paths.is_empty() {
        json!({"gitHead":snapshot["git"]["head"],"files":snapshot["files"]})
    } else {
        command["guardPaths"] = json!(submit.guard_paths);
        json!({"guardPaths":snapshot["git"]["guardPaths"],"files":snapshot["files"]})
    };
    let parts = json!({
        "command": sha(&command),
        "code": sha(&code),
        "artifacts": sha(&json!(submit.artifacts)),
        "needs": sha(&json!(needs)),
    });
    let code_known = snapshot["git"]["head"].is_string()
        || snapshot["files"]
            .as_array()
            .is_some_and(|files| !files.is_empty());
    json!({"version":1,"specSha256":sha(&parts),"parts":parts,"codeKnown":code_known,"sha256":null})
}

/// A standalone job's identity: no upstream, so complete at submission.
pub(super) fn job_identity(submit: &Submit, snapshot: &Value) -> Value {
    let mut identity = spec_identity(submit, snapshot, &[]);
    identity["sha256"] = json!(full_identity(
        identity["specSha256"].as_str().unwrap_or(""),
        &[]
    ));
    identity
}

/// The identity of an attempt: its spec and the exact upstream artifacts it read.
fn full_identity(spec: &str, upstream: &[Value]) -> String {
    let upstream: Vec<Value> = upstream
        .iter()
        .map(|u| {
            let artifacts: Vec<Value> = u["artifacts"]
                .as_array()
                .map(|all| {
                    all.iter()
                        .map(|a| {
                            json!({"path":a["path"],"bytes":a["bytes"],"sha256":a["sha256"],
                                "mtimeNs": if a["sha256"].is_string() { Value::Null } else { a["mtimeNs"].clone() }})
                        })
                        .collect()
                })
                .unwrap_or_default();
            json!({"stage":u["stage"],"artifacts":artifacts})
        })
        .collect();
    sha(&json!({"spec":spec,"upstream":upstream}))
}

/// The artifact an attempt succeeded with is still the one on disk.
pub(super) fn same_artifact(recorded: &Value, now: &Value) -> bool {
    now["ok"] == true
        && now["bytes"] == recorded["bytes"]
        && if recorded["sha256"].is_string() {
            now["sha256"] == recorded["sha256"]
        } else {
            now["mtimeNs"] == recorded["mtimeNs"]
        }
}

/// A stage ready for its run: its Job, frozen inputs, identity, or the
/// verified earlier attempt it reuses instead.
pub(super) struct Prepared {
    pub submit: Submit,
    pub snapshot: Value,
    pub identity: Value,
    pub reuse: Option<Value>,
    /// Artifacts of earlier stages, left out of this stage's Git guard.
    pub guard_exclude: Vec<String>,
}

/// An explicit reuse is accepted only for a succeeded attempt with a complete
/// artifact contract and known code, whose identity equals this stage's, and
/// whose artifacts verify unchanged now. Anything else is refused, never
/// silently run fresh or treated as a cache hit.
pub(super) async fn check_reuse(
    ws: &Arc<Workspace>,
    helper: &Path,
    machine: &Value,
    stage: &Stage,
    identity: &Value,
    reused: &HashMap<String, Value>,
) -> Result<Value> {
    let key = &stage.key;
    let job_id = stage.reuse.clone().unwrap_or_default();
    let id = job_id.clone();
    let old = ws
        .stored(move |s| s.job(&id))
        .await
        .map_err(|error| anyhow::anyhow!("Stage {key}: reuse {job_id}: {error:#}"))?;
    ensure!(
        old["status"] == "succeeded",
        "Stage {key}: job {job_id} is {}; only a succeeded attempt can be reused",
        old["status"].as_str().unwrap_or("unknown")
    );
    ensure!(
        old["machine"]["id"] == machine["id"],
        "Stage {key}: job {job_id} ran on a different machine"
    );
    let declared = old["artifacts"].as_array().filter(|a| !a.is_empty()).with_context(|| {
        format!("Stage {key}: job {job_id} declared no artifacts, so nothing it produced was verified")
    })?;
    let verified = old["result"]["artifacts"]
        .as_array()
        .filter(|a| a.len() == declared.len() && a.iter().all(|x| x["ok"] == true))
        .with_context(|| {
            format!("Stage {key}: job {job_id} has no complete artifact verification")
        })?;
    let previous = &old["identity"];
    ensure!(
        previous["codeKnown"] == true && identity["codeKnown"] == true,
        "Stage {key}: reuse needs a frozen code identity on both sides (a Git repository under guardGit, or declared inputs); job {job_id} or this stage has none"
    );
    let differs: Vec<&str> = ["command", "code", "artifacts", "needs"]
        .into_iter()
        .filter(|part| previous["parts"][part] != identity["parts"][part])
        .collect();
    ensure!(
        differs.is_empty(),
        "Stage {key}: job {job_id} cannot be reused: its {} {} from this stage (command means argv, cwd and env; code means the Git commit, changed tracked files and declared inputs)",
        differs.join(", "),
        if differs.len() == 1 { "differs" } else { "differ" }
    );
    let mut upstream = Vec::new();
    for need in &stage.needs {
        let earlier = reused.get(need).with_context(|| {
            format!("Stage {key}: its upstream stage {need} runs fresh in this run, so what {key} would read is not known yet; reuse {need} too, or run {key} fresh")
        })?;
        upstream.push(upstream_from_reuse(need, earlier));
    }
    let full = full_identity(identity["specSha256"].as_str().unwrap_or(""), &upstream);
    ensure!(
        previous["sha256"] == full.as_str(),
        "Stage {key}: job {job_id} read different upstream artifacts than this run provides"
    );
    let now_value = host::invoke(
        helper,
        "verify",
        None,
        Some(json!({"cwd":old["cwd"],"artifacts":verified})),
    )
    .await?;
    let now_list = now_value
        .as_array()
        .context("Artifact verification returned no list")?;
    ensure!(
        now_list.len() == verified.len(),
        "Artifact verification was incomplete"
    );
    for (recorded, current) in verified.iter().zip(now_list) {
        ensure!(
            same_artifact(recorded, current),
            "Stage {key}: artifact {} of job {job_id} is no longer the verified one ({})",
            recorded["path"].as_str().unwrap_or(""),
            current["problem"].as_str().unwrap_or("its content changed")
        );
    }
    Ok(
        json!({"jobId":old["id"],"attempt":old["attempt"],"runId":old["run"]["id"],
        "stage":old["run"]["stage"],"cwd":old["cwd"],"artifacts":verified,
        "identity":full,"verifiedAt":now()}),
    )
}

fn upstream_from_reuse(stage: &str, reused: &Value) -> Value {
    json!({"stage":stage,"jobId":reused["jobId"],"attempt":reused["attempt"],"cwd":reused["cwd"],
        "artifacts":reused["artifacts"],"reused":true})
}

fn get_run(db: &Connection, id: &str) -> Result<Value> {
    let (seq, raw): (i64, String) = db
        .query_row(
            "SELECT seq,data FROM local_job_runs WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .context("Run not found")?;
    let mut run: Value = serde_json::from_str(&raw)?;
    run["cursor"] = json!(seq);
    Ok(run)
}
fn save_run(db: &Connection, run: &Value) -> Result<()> {
    let mut stored = run.clone();
    if let Some(map) = stored.as_object_mut() {
        map.remove("cursor");
    }
    db.execute(
        "UPDATE local_job_runs SET data=?2 WHERE id=?1",
        params![run["id"].as_str(), stored.to_string()],
    )?;
    Ok(())
}

/// Every attempt of every stage, oldest first.
pub(super) fn attempts(db: &Connection, run: &str) -> Result<BTreeMap<String, Vec<Value>>> {
    let mut q = db.prepare(
        "SELECT stage,job_id FROM local_job_run_attempts WHERE run_id=?1 ORDER BY attempt",
    )?;
    let rows = q
        .query_map([run], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut all: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for (stage, job) in rows {
        all.entry(stage).or_default().push(get(db, &job)?);
    }
    Ok(all)
}

/// Known USD recorded by the run's attempts, read as job_cost reads a task's
/// (T-17): only a readable entry records spending, an empty or blank usage
/// file recorded none, and unreadable lines alone, or a summary without an
/// entry count, are an unknown amount. Unknown cost is not zero; it is
/// reported apart, and calls still in flight are not in it. knownUsd adds what
/// each summary says, as before, so the soft cost limit reads the same.
fn cost(all: &BTreeMap<String, Vec<Value>>) -> Value {
    let (mut known, mut unknown, mut invalid, mut reporting, mut live) = (0.0, 0, 0, 0, 0);
    let (mut not_recorded, mut unknown_attempts) = (0, 0);
    let mut truncated = false;
    let mut sources = BTreeSet::new();
    for job in all.values().flatten() {
        let cost = &job["result"]["cost"];
        if job["reserved"] == true {
            live += 1;
        }
        let entries = cost["entries"].as_i64();
        let (unknown_here, bad) = (
            cost["unknownEntries"].as_i64().unwrap_or(0),
            cost["invalidLines"].as_i64().unwrap_or(0) + cost["incompleteLines"].as_i64().unwrap_or(0),
        );
        let partial = entries.is_none() || unknown_here > 0 || bad > 0 || cost["truncated"] == true || cost["complete"] == false;
        if !cost.is_object() || (entries == Some(0) && !partial) {
            if TERMINAL.contains(&job["status"].as_str().unwrap_or_default()) {
                not_recorded += 1;
            }
            continue;
        }
        if entries.unwrap_or(0) > 0 {
            reporting += 1;
        }
        if partial {
            unknown_attempts += 1;
        }
        known += cost["knownUsd"].as_f64().unwrap_or(0.0);
        unknown += unknown_here;
        invalid += bad;
        truncated |= cost["truncated"] == true;
        for source in cost["sources"].as_array().into_iter().flatten() {
            if let Some(source) = source.as_str() {
                sources.insert(source.to_owned());
            }
        }
    }
    json!({"knownUsd":(known * 1e6).round() / 1e6,"unknownEntries":unknown,"invalidLines":invalid,
        "truncated":truncated,"attemptsReporting":reporting,"attemptsNotRecorded":not_recorded,
        "attemptsWithUnknown":unknown_attempts,"attemptsRunning":live,
        "sources":sources.into_iter().take(20).collect::<Vec<_>>(),
        "complete": unknown == 0 && invalid == 0 && !truncated && live == 0 && not_recorded == 0 && unknown_attempts == 0,
        "scope":"Recorded by each attempt in its own usage file, failed and cancelled attempts included. An attempt whose file is missing, empty or blank recorded none, and one with unknown or unreadable entries an unknown amount: both are said apart and never as zero, while an entry of usd 0 is a known $0. Not a provider bill: calls in flight are missing."})
}

fn limit_reached(run: &Value, all: &BTreeMap<String, Vec<Value>>) -> Option<String> {
    let limit = run["costLimitUsd"].as_f64()?;
    let spent = cost(all)["knownUsd"].as_f64().unwrap_or(0.0);
    (spent >= limit).then(|| {
        format!("Not started: the run's recorded cost ${spent:.4} reached its soft limit ${limit:.4}. Calls in flight and unrecorded or unknown costs may exceed it")
    })
}

/// The upstream a waiting stage would read, or why it cannot start yet.
enum Upstream {
    Ready(Vec<Value>),
    Pending(String),
    Blocked(String),
}
fn upstream(
    run: &Value,
    stage: &Value,
    latest: &HashMap<String, Value>,
    after: &HashMap<String, after::State>,
) -> Upstream {
    let mut ready = Vec::new();
    // Inspect every need before reporting an ordinary wait: a failed sibling
    // needs attention even when an earlier dependency is awaiting analysis.
    let mut pending = None;
    for need in stage["needs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        // Another run this one waits for (YN-30). Without its state, as a
        // Core without afterRuns (core.26 and older) reads it, it is a stage
        // with no attempt below.
        if let Some(state) = after::run_of(need).and_then(|id| Some((id, after.get(id)?))) {
            match after::gate(state.0, state.1) {
                Upstream::Ready(list) => ready.extend(list),
                Upstream::Pending(reason) => {
                    pending.get_or_insert(reason);
                }
                blocked @ Upstream::Blocked(_) => return blocked,
            }
            continue;
        }
        let info = run["stages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| s["key"] == need);
        if info.is_some_and(|s| analysis::pending(s)
            && (s["reusedFrom"].is_object() || latest.get(need).is_some_and(|j| j["status"] == "succeeded"))) {
            pending.get_or_insert_with(|| format!("Upstream stage {need} succeeded; waiting for analysis and an explicit decision"));
            continue;
        }
        if let Some(reused) = info.map(|s| &s["reusedFrom"]).filter(|r| r.is_object()) {
            ready.push(upstream_from_reuse(need, reused));
            continue;
        }
        let Some(job) = latest.get(need) else {
            return Upstream::Blocked(format!("Upstream stage {need} has no attempt"));
        };
        let n = &job["run"]["attempt"];
        let status = job["status"].as_str().unwrap_or("unknown");
        match status {
            "succeeded" => ready.push(json!({"stage":need,"jobId":job["id"],"attempt":job["attempt"],
                "cwd":job["cwd"],"artifacts":job["result"]["artifacts"].as_array().cloned().unwrap_or_default()})),
            _ if checkpointed(job) => return Upstream::Blocked(format!(
                "Upstream stage {need} attempt {n} was stopped at a checkpoint by the user. This stage starts once the user resumes {need} from it and {need} succeeds, or cancel the run")),
            "unknown" => return Upstream::Blocked(format!(
                "Upstream stage {need} attempt {n} has an unknown outcome. This stage starts only after {need} succeeds: cancel that job to confirm its processes stopped, then retry {need} with job_run_retry, or cancel the run")),
            s if RETRYABLE.contains(&s) => return Upstream::Blocked(format!(
                "Upstream stage {need} attempt {n} {status}. This stage starts only after {need} succeeds: retry {need} with job_run_retry, or cancel the run")),
            _ => { pending.get_or_insert_with(|| format!("Waiting for upstream stage {need} ({status})")); }
        }
    }
    pending.map_or(Upstream::Ready(ready), Upstream::Pending)
}

/// How many of this host's own Jobs wait for an earlier stage of their run, or
/// for its analysis, that can still let them start (T-69). A stage behind a
/// stage that ended without success or with an unknown outcome, directly or
/// through another waiting stage, or held back by the run's cost limit, stays
/// "waiting" until someone retries or cancels: the run shows it as failed,
/// unknown or blocked, and it is not counted here.
pub(super) fn waiting_count(db: &Connection) -> Result<i64> {
    let mut q = db.prepare(
        "SELECT json_extract(data,'$.run.id'), json_extract(data,'$.run.stage') FROM local_jobs
         WHERE status IN ('waiting','waiting_analysis') AND json_extract(data,'$.executor') IS NULL
         AND json_extract(data,'$.cancelRequestedAt') IS NULL",
    )?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut stalled: HashMap<String, BTreeSet<String>> = HashMap::new();
    let mut count = 0;
    for (run, stage) in rows {
        let (Some(run), Some(stage)) = (run, stage) else {
            count += 1;
            continue;
        };
        let stages = match stalled.entry(run) {
            std::collections::hash_map::Entry::Occupied(known) => known.into_mut(),
            std::collections::hash_map::Entry::Vacant(new) => {
                let stages = stalled_stages(db, new.key())?;
                new.insert(stages)
            }
        };
        if !stages.contains(&stage) {
            count += 1;
        }
    }
    Ok(count)
}

/// The waiting stages of a run that cannot start without a retry or a
/// cancellation: those `upstream` finds blocked, those behind one of them,
/// and, once the run's recorded cost reached its limit (it never goes down),
/// every one.
fn stalled_stages(db: &Connection, id: &str) -> Result<BTreeSet<String>> {
    let run = get_run(db, id)?;
    let all = attempts(db, id)?;
    let latest = latest(&all);
    let after = after::states(db, &run)?;
    let limited = limit_reached(&run, &all).is_some();
    let mut stalled = BTreeSet::new();
    // Run order is dependency order: a stage needs only earlier ones.
    for stage in run["stages"].as_array().into_iter().flatten() {
        let key = stage["key"].as_str().unwrap_or("");
        if latest.get(key).is_none_or(|job| job["status"] != "waiting") {
            continue;
        }
        let behind = stage["needs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .any(|need| stalled.contains(need));
        if limited || behind || matches!(upstream(&run, stage, &latest, &after), Upstream::Blocked(_)) {
            stalled.insert(key.to_owned());
        }
    }
    Ok(stalled)
}

/// What a released stage checks before its command starts: every artifact of
/// every stage it depends on, directly or through others, against the attempt
/// that last declared that file in run order. Its Git guard leaves exactly
/// these files out, so each one left out is checked by digest instead.
fn guard_checks(
    run: &Value,
    stage: &Value,
    latest: &HashMap<String, Value>,
    after: &HashMap<String, after::State>,
) -> Vec<Value> {
    let stages = run["stages"].as_array().cloned().unwrap_or_default();
    let needs_of = |key: &str| -> Vec<String> {
        stages
            .iter()
            .find(|s| s["key"] == key)
            .and_then(|s| s["needs"].as_array())
            .into_iter()
            .flatten()
            .filter_map(|n| n.as_str().map(str::to_owned))
            .collect()
    };
    let mut ancestors = BTreeSet::new();
    let mut pending: Vec<String> = stage["needs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|n| n.as_str().map(str::to_owned))
        .collect();
    while let Some(key) = pending.pop() {
        if ancestors.insert(key.clone()) {
            pending.extend(needs_of(&key));
        }
    }
    // Run order is dependency order: a later stage that declares the same
    // file is the one whose digest the file must still have. The runs this
    // one waits for come first (YN-30): each settled before it started.
    let mut by_file: BTreeMap<String, (String, Value, Value)> = BTreeMap::new();
    let runs = ancestors.iter().filter_map(|need| after::run_of(need)).filter_map(|id| Some((id, after.get(id)?)));
    for (id, state) in runs {
        let Upstream::Ready(producers) = after::gate(id, state) else { continue };
        for producer in producers {
            let key = producer["stage"].as_str().unwrap_or("").to_owned();
            for artifact in producer["artifacts"].as_array().cloned().unwrap_or_default() {
                let file = format!(
                    "{}/{}",
                    producer["cwd"].as_str().unwrap_or("").trim_end_matches('/'),
                    artifact["path"].as_str().unwrap_or("")
                );
                by_file.insert(file, (key.clone(), producer.clone(), artifact));
            }
        }
    }
    for info in stages
        .iter()
        .filter(|s| ancestors.contains(s["key"].as_str().unwrap_or("")))
    {
        let key = info["key"].as_str().unwrap_or("").to_owned();
        let producer = if info["reusedFrom"].is_object() {
            upstream_from_reuse(&key, &info["reusedFrom"])
        } else {
            match latest.get(&key).filter(|j| j["status"] == "succeeded") {
                Some(job) => {
                    json!({"stage":key,"jobId":job["id"],"attempt":job["attempt"],"cwd":job["cwd"],
                    "artifacts":job["result"]["artifacts"].as_array().cloned().unwrap_or_default()})
                }
                None => continue,
            }
        };
        for artifact in producer["artifacts"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            let file = format!(
                "{}/{}",
                producer["cwd"].as_str().unwrap_or("").trim_end_matches('/'),
                artifact["path"].as_str().unwrap_or("")
            );
            by_file.insert(file, (key.clone(), producer.clone(), artifact));
        }
    }
    let mut checks: Vec<Value> = Vec::new();
    for (key, producer, artifact) in by_file.into_values() {
        match checks.iter_mut().find(|c| c["stage"] == key.as_str()) {
            Some(check) => {
                if let Some(list) = check["artifacts"].as_array_mut() {
                    list.push(artifact);
                }
            }
            None => checks.push(
                json!({"stage":key,"jobId":producer["jobId"],"attempt":producer["attempt"],
                "cwd":producer["cwd"],"artifacts":[artifact]}),
            ),
        }
    }
    checks
}

fn latest(all: &BTreeMap<String, Vec<Value>>) -> HashMap<String, Value> {
    all.iter()
        .filter_map(|(stage, jobs)| jobs.last().map(|job| (stage.clone(), job.clone())))
        .collect()
}

/// Release every waiting stage whose upstream truly succeeded, keep the reason
/// of the others current, then tell the Agent once if the run is over.
pub(super) fn advance(store: &Store, db: &Connection, id: &str) -> Result<bool> {
    advance_at(store, db, id, 0)
}
/// How many runs deep a change goes on to the runs waiting for it (YN-30).
const DEPENDANT_DEPTH: u32 = 16;
fn advance_at(store: &Store, db: &Connection, id: &str, depth: u32) -> Result<bool> {
    let mut run = get_run(db, id)?;
    if run["settledAt"].is_string() {
        return Ok(false);
    }
    let mut changed = false;
    if run["cancelRequestedAt"].is_null() {
        let all = attempts(db, id)?;
        let latest = latest(&all);
        let after = after::states(db, &run)?;
        changed |= analysis::open(db, &mut run, &latest)?;
        let stages = run["stages"].as_array().cloned().unwrap_or_default();
        for stage in &stages {
            let key = stage["key"].as_str().unwrap_or("");
            let Some(mut job) = latest
                .get(key)
                .cloned()
                .filter(|j| j["status"] == "waiting")
            else {
                continue;
            };
            let reason = match upstream(&run, stage, &latest, &after) {
                Upstream::Pending(reason) | Upstream::Blocked(reason) => reason,
                Upstream::Ready(upstream) => match limit_reached(&run, &all) {
                    Some(reason) => reason,
                    None => {
                        let spec = job["identity"]["specSha256"]
                            .as_str()
                            .unwrap_or("")
                            .to_owned();
                        job["identity"]["sha256"] = json!(full_identity(&spec, &upstream));
                        job["upstream"] = json!(upstream);
                        job["guardChecks"] = json!(guard_checks(&run, stage, &latest, &after));
                        job["status"] = json!("queued");
                        job["reason"] = json!("Waiting for shared machine capacity");
                        save(db, &job)?;
                        changed = true;
                        continue;
                    }
                },
            };
            if job["reason"].as_str() != Some(reason.as_str()) {
                job["reason"] = json!(reason);
                save(db, &job)?;
                changed = true;
            }
        }
        // A run it waits for that holds it is told once (YN-30).
        if after::notice(db, &mut run, &after)? {
            save_run(db, &run)?;
            changed = true;
        }
    }
    changed |= settle(store, db, &mut run)?;
    // A run waiting on a stage that ended without success, an unknown outcome
    // or its cost limit changes only through a recorded outcome, a retry or a
    // cancellation, each of which advances it itself: the safety net skips it.
    if run["settledAt"].is_null() {
        let idle = matches!(
            run_status(&run, &attempts(db, id)?),
            "failed" | "unknown" | "checkpointed" | "blocked_by_run" | "blocked" | "waiting_analysis"
        );
        if run["idleAt"].is_string() != idle {
            run["idleAt"] = if idle { json!(now()) } else { Value::Null };
            save_run(db, &run)?;
        }
    }
    // The runs waiting for this one read it again, in this transaction: a
    // success releases them, a failure holds them, a retry frees them.
    if depth < DEPENDANT_DEPTH {
        for dependant in after::dependants(db, id)? {
            changed |= advance_at(store, db, &dependant, depth + 1)?;
        }
    }
    Ok(changed)
}

/// One mail when the whole run succeeded or its cancellation is complete. A
/// failed stage tells its own outcome; the run then waits for a retry or a
/// cancellation, so it is not settled.
fn settle(_store: &Store, db: &Connection, run: &mut Value) -> Result<bool> {
    let id = run["id"]
        .as_str()
        .context("Missing run identity")?
        .to_owned();
    let all = attempts(db, &id)?;
    let latest = latest(&all);
    let stages = run["stages"].as_array().cloned().unwrap_or_default();
    let succeeded = stages.iter().all(|s| !analysis::pending(s) && (
        s["reusedFrom"].is_object()
            || latest
                .get(s["key"].as_str().unwrap_or(""))
                .is_some_and(|j| j["status"] == "succeeded")
    ));
    let over = all
        .values()
        .flatten()
        .all(|j| TERMINAL.contains(&j["status"].as_str().unwrap_or("")));
    let status = if run["cancelRequestedAt"].is_string() && over {
        "cancelled"
    } else if succeeded {
        "succeeded"
    } else {
        return Ok(false);
    };
    run["settledAt"] = json!(now());
    // A gate on a reused result can finish after submission too; use its
    // retained attempt as evidence without pretending this run executed it.
    let mut last = all
        .values()
        .flatten()
        .filter(|j| j["finishedAt"].is_string())
        .max_by(|a, b| a["finishedAt"].as_str().cmp(&b["finishedAt"].as_str()))
        .cloned();
    if last.is_none() {
        if let Some(job_id) = stages.iter().find_map(|s| s["analysis"]["jobId"].as_str()) {
            last = Some(get(db, job_id)?);
        }
    }
    if let Some(last) = last {
        let parts: Vec<String> = stages
            .iter()
            .map(|s| {
                let key = s["key"].as_str().unwrap_or("");
                if s["reusedFrom"].is_object() {
                    format!(
                        "{key} reused job {}",
                        s["reusedFrom"]["jobId"].as_str().unwrap_or("")
                    )
                } else if let Some(job) = latest.get(key) {
                    let status = job["status"].as_str().unwrap_or("");
                    let note = if job["startedAt"].is_null() && status == "cancelled" {
                        " before it started"
                    } else {
                        ""
                    };
                    format!("{key} attempt {} {status}{note}", job["run"]["attempt"])
                } else {
                    format!("{key} has no attempt")
                }
            })
            .collect();
        let spent = cost(&all);
        let unknown = spent["unknownEntries"].as_i64().unwrap_or(0)
            + spent["invalidLines"].as_i64().unwrap_or(0);
        // As the run reads it: what no attempt recorded is said, never $0, and
        // every reason its cost is partial is named, as its card and export do.
        let count = |key: &str| spent[key].as_i64().unwrap_or(0);
        let attempts = |n: i64, what: &str| format!("{n} attempt{} {what}", if n == 1 { "" } else { "s" });
        let mut why = Vec::new();
        if count("attemptsWithUnknown") > 0 {
            why.push(attempts(count("attemptsWithUnknown"), "with an unknown amount"));
        }
        if count("attemptsNotRecorded") > 0 {
            why.push(attempts(count("attemptsNotRecorded"), "recorded none"));
        }
        if spent["truncated"] == true {
            why.push("a usage file too long to read whole".to_owned());
        }
        if count("attemptsRunning") > 0 {
            why.push(attempts(count("attemptsRunning"), "still running"));
        }
        let money = if count("attemptsReporting") == 0 && count("attemptsWithUnknown") == 0 {
            "No usage was recorded.".to_owned()
        } else {
            format!(
                "Recorded cost ${:.4}{}{}.",
                spent["knownUsd"].as_f64().unwrap_or(0.0),
                if unknown > 0 {
                    format!(" plus {unknown} entries of unknown cost")
                } else {
                    String::new()
                },
                if why.is_empty() {
                    String::new()
                } else {
                    format!(", incomplete: {}", why.join(", "))
                }
            )
        };
        let task = collaboration::task_number(db, &collaboration::task_key(db, run["taskId"].as_str().unwrap_or(""))?.0)?;
        let resources = super::resource_summary::run_mail(&all);
        let body = format!(
            "Run {} ({id}) {status}: {}. {money} Task {task}.{resources} Read job_run_get(runId={id}) for each attempt's evidence and artifacts. A run's result does not complete the business task.",
            run["name"].as_str().unwrap_or(""),
            parts.join("; ")
        );
        let mail = notify_message(
            db,
            &run["agent"],
            run["taskId"].as_str().unwrap_or(""),
            &last,
            status,
            run["name"].as_str().unwrap_or(""),
            &id,
            body,
        )?;
        run["notifications"][status] = json!(mail);
    }
    save_run(db, run)?;
    Ok(true)
}

/// A new attempt of a stage: the same command and frozen inputs, its own
/// identity, folder, log and usage file. It waits until `advance` releases it.
fn new_attempt(db: &Connection, previous: &Value, number: i64) -> Result<Value> {
    let count: i64 = db.query_row("SELECT COUNT(*) FROM local_jobs", [], |r| r.get(0))?;
    ensure!(count < 5000, "Local job history limit reached (5000)");
    let queued: i64 = db.query_row(
        "SELECT COUNT(*) FROM local_jobs WHERE status IN ('queued','waiting')",
        [],
        |r| r.get(0),
    )?;
    ensure!(queued < 200, "Local job queue is full (200)");
    let mut job = previous.clone();
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(map) = job.as_object_mut() {
        map.remove("cursor");
        map.remove("retriedBy");
        // A new reservation: marked only if it passes a head itself (T-38).
        map.remove("admission");
        // The user's stop belongs to the attempt it stopped (YN-30); a
        // checkpoint it resumes from, if any, is kept.
        map.remove("checkpointStop");
    }
    job["id"] = json!(id);
    job["attempt"] = json!(uuid::Uuid::new_v4().to_string());
    job["requestId"] = json!(format!(
        "{}/{number}",
        previous["requestId"]
            .as_str()
            .unwrap_or("")
            .split('/')
            .next()
            .unwrap_or("")
    ));
    job["run"]["attempt"] = json!(number);
    job["retryOf"] = previous["id"].clone();
    job["upstream"] = Value::Null;
    job["guardChecks"] = Value::Null;
    job["identity"]["sha256"] = Value::Null;
    job["status"] = json!("waiting");
    job["reserved"] = json!(false);
    job["reason"] = json!("Waiting for its upstream stages");
    job["createdAt"] = json!(now());
    job["startedAt"] = Value::Null;
    job["finishedAt"] = Value::Null;
    job["cancelRequestedAt"] = Value::Null;
    job["notifications"] = json!({});
    job["result"] = Value::Null;
    job["unit"] = json!(format!("yuzuno-job-{id}.service"));
    job["supervisorUnit"] = json!(format!("yuzuno-job-{id}-collector.service"));
    let job = insert_job(db, job)?;
    db.execute(
        "INSERT INTO local_job_run_attempts(run_id,stage,attempt,job_id) VALUES(?1,?2,?3,?4)",
        params![
            job["run"]["id"].as_str(),
            job["run"]["stage"].as_str(),
            number,
            id
        ],
    )?;
    Ok(job)
}

/// After a stage attempt ends: a new attempt only for an outcome the stage
/// declared retryable, within its attempts and the run's cost limit. Runs in
/// the transaction that records the outcome, so a restart never retries twice.
pub(super) fn auto_retry(db: &Connection, job: &mut Value) -> Result<()> {
    let Ok(retry) = serde_json::from_value::<Retry>(job["run"]["retry"].clone()) else {
        return Ok(());
    };
    // An attempt the user asked to stop at a checkpoint is never retried
    // automatically, whatever its exit (YN-30).
    if job["checkpointStop"].is_object() {
        return Ok(());
    }
    let run = get_run(db, job["run"]["id"].as_str().unwrap_or(""))?;
    let number = job["run"]["attempt"].as_i64().unwrap_or(1);
    let systemd = &job["result"]["evidence"]["systemd"];
    let retryable = match job["status"].as_str() {
        Some("interrupted") => retry.interrupted,
        Some("failed") => {
            systemd["Result"] == "exit-code"
                && systemd["ExecMainStatus"]
                    .as_str()
                    .and_then(|code| code.parse::<i64>().ok())
                    .is_some_and(|code| retry.exit_codes.contains(&code))
        }
        _ => false,
    };
    if !retryable || run["cancelRequestedAt"].is_string() || number >= retry.attempts {
        return Ok(());
    }
    let reason = job["reason"].as_str().unwrap_or("").to_owned();
    let mut all = attempts(db, run["id"].as_str().unwrap_or(""))?;
    // This outcome, with its recorded cost, is not saved yet.
    for attempt in all.values_mut().flatten() {
        if attempt["id"] == job["id"] {
            *attempt = job.clone();
        }
    }
    if let Some(limit) = limit_reached(&run, &all) {
        job["reason"] = json!(format!(
            "{reason}. Not retried automatically: {}",
            limit.trim_start_matches("Not started: ")
        ));
        return Ok(());
    }
    match new_attempt(db, job, number + 1) {
        Ok(next) => {
            job["retriedBy"] = next["id"].clone();
            job["reason"] = json!(format!(
                "{reason}. Declared retryable: attempt {} of {} is job {}",
                number + 1,
                retry.attempts,
                next["id"].as_str().unwrap_or("")
            ));
        }
        Err(error) => {
            job["reason"] = json!(format!("{reason}. Not retried automatically: {error}"));
        }
    }
    Ok(())
}

/// A run stage's own mail: a success and an automatically retried failure
/// are told by the run; during run cancellation the run tells it once.
pub(super) fn stage_notice(
    db: &Connection,
    job: &Value,
    status: &str,
) -> Result<Option<&'static str>> {
    if status == "succeeded" {
        return Ok(Some("run"));
    }
    if job["retriedBy"].is_string() {
        return Ok(Some("retried"));
    }
    let run = get_run(db, job["run"]["id"].as_str().unwrap_or(""))?;
    Ok(run["cancelRequestedAt"].is_string().then_some("run"))
}

/// What a stage's failure mail adds: which stages wait for it and what to do.
pub(super) fn mail_context(db: &Connection, job: &Value) -> Result<String> {
    let id = job["run"]["id"].as_str().unwrap_or("");
    let run = get_run(db, id)?;
    let key = job["run"]["stage"].as_str().unwrap_or("");
    let latest = latest(&attempts(db, id)?);
    let waiting: Vec<&str> = run["stages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["key"].as_str())
        .filter(|k| latest.get(*k).is_some_and(|j| j["status"] == "waiting"))
        .collect();
    let mut text = format!(
        " Run {} ({id}), stage {key}, attempt {}.",
        run["name"].as_str().unwrap_or(""),
        job["run"]["attempt"]
    );
    if checkpointed(job) {
        text.push_str(&format!(
            " The user stopped it at a verified checkpoint; only the user resumes it (job_checkpoint_resume makes the stage's next attempt), and job_run_retry is refused for it.{} Nothing that needs {key} starts until it is resumed and succeeds; job_run_cancel stops the run.",
            if waiting.is_empty() { String::new() } else { format!(" Not started and waiting: {}.", waiting.join(", ")) }
        ));
        return Ok(text);
    }
    if !waiting.is_empty() {
        text.push_str(&format!(
            " Not started and waiting: {}. Nothing that needs {key} starts until it succeeds: retry it with job_run_retry(runId={id}, stage={key}) or stop the run with job_run_cancel.",
            waiting.join(", ")
        ));
    }
    Ok(text)
}

/// Rerun the run's housekeeping for a job that changed outside the paths that
/// already did (cancellation, a launch that was refused).
pub(super) fn job_changed(store: &Store, db: &Connection, job: &Value) -> Result<()> {
    if let Some(id) = job["run"]["id"].as_str() {
        advance(store, db, id)?;
    }
    Ok(())
}

fn run_status(run: &Value, all: &BTreeMap<String, Vec<Value>>) -> &'static str {
    let latest = latest(all);
    let (mut active, mut queued, mut unknown, mut failed, mut stopped, mut blocked, mut done) =
        (false, false, false, false, false, false, true);
    // A run it waits for holds it (YN-30), as told in its mail.
    let held = run["afterRunsNoticed"].as_object().is_some_and(|told| !told.is_empty());
    let waiting_analysis = run["stages"].as_array().into_iter().flatten().any(analysis::waiting);
    for stage in run["stages"].as_array().into_iter().flatten() {
        done &= !analysis::pending(stage);
        if stage["reusedFrom"].is_object() {
            continue;
        }
        let Some(job) = latest.get(stage["key"].as_str().unwrap_or("")) else {
            continue;
        };
        match job["status"].as_str().unwrap_or("") {
            "succeeded" => continue,
            "starting" | "running" | "cancelling" => active = true,
            // Waiting in the shared queue: nothing of it runs yet (YN-30).
            "queued" => queued = true,
            "unknown" => unknown = true,
            // Stopped by the user at a verified checkpoint (YN-30).
            _ if checkpointed(job) => stopped = true,
            "waiting" => {
                blocked |= job["reason"]
                    .as_str()
                    .is_some_and(|r| r.contains("soft limit"))
            }
            _ => failed = true,
        }
        done = false;
    }
    if run["cancelRequestedAt"].is_string() {
        return if active || queued || unknown {
            "cancelling"
        } else {
            "cancelled"
        };
    }
    if done && !waiting_analysis {
        "succeeded"
    } else if active {
        "running"
    } else if queued {
        "queued"
    } else if unknown {
        "unknown"
    } else if failed {
        "failed"
    } else if stopped {
        "checkpointed"
    } else if held {
        "blocked_by_run"
    } else if blocked {
        "blocked"
    } else if waiting_analysis {
        "waiting_analysis"
    } else {
        "waiting"
    }
}

/// A run as a Brief's Live Reference shows it (YN-7): its name, its status as
/// run_view says it, how many of its stages are done (a reused stage counts as
/// done; one held for an analysis does not), its task's key as the task has it
/// now, and the Job of its newest attempt, where the Jobs panel shows the run
/// with every stage. None for an id no run has.
pub(super) fn live_ref(db: &Connection, id: &str) -> Result<Option<Value>> {
    let raw: Option<String> = db.query_row("SELECT data FROM local_job_runs WHERE id=?1", [id], |r| r.get(0)).optional()?;
    let Some(raw) = raw else { return Ok(None) };
    let mut run: Value = serde_json::from_str(&raw)?;
    crate::task_keys::refresh(db, &mut run);
    let all = attempts(db, id)?;
    let latest = latest(&all);
    let stages = run["stages"].as_array().cloned().unwrap_or_default();
    let done = stages
        .iter()
        .filter(|stage| {
            stage["reusedFrom"].is_object()
                || (!analysis::pending(stage)
                    && latest.get(stage["key"].as_str().unwrap_or("")).is_some_and(|job| job["status"] == "succeeded"))
        })
        .count();
    let newest = all.values().flatten().max_by_key(|job| job["cursor"].as_i64().unwrap_or(0)).map(|job| job["id"].clone());
    let status = run_status(&run, &all);
    let mut shown = json!({"name":run["name"],"status":status,"stagesDone":done,"stages":stages.len(),
        "taskRef":run["taskRef"],"jobId":newest});
    // What a queued run waits for (YN-30), only when it is queued.
    if status == "queued" {
        if let Some(first) = queued::first(&run, &latest, &QueueState::read(db)?) {
            shown["waitingFor"] = first["waitingFor"].clone();
        }
    }
    Ok(Some(shown))
}

pub(super) fn run_view(db: &Connection, id: &str) -> Result<Value> {
    let mut run = get_run(db, id)?;
    let queue = QueueState::read(db)?;
    let all = attempts(db, id)?;
    let status = run_status(&run, &all);
    let stages: Vec<Value> = run["stages"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut stage| {
            let key = stage["key"].as_str().unwrap_or("").to_owned();
            let list: Vec<Value> = all
                .get(&key)
                .into_iter()
                .flatten()
                .map(|job| {
                    let mut attempt = summary(queue.view(super::store::current_ref(db, job.clone())));
                    for field in ["retryOf", "retriedBy", "cwd"] {
                        attempt[field] = job[field].clone();
                    }
                    attempt["artifacts"] = job["result"]["artifacts"].clone();
                    attempt["cost"] = job["result"]["cost"].clone();
                    attempt["identity"] = job["identity"]["sha256"].clone();
                    attempt["resourceSummary"] = super::resource_summary::attempt(job);
                    attempt
                })
                .collect();
            stage["status"] = if analysis::waiting(&stage) {
                json!("waiting_analysis")
            } else if stage["reusedFrom"].is_object() {
                json!("reused")
            } else if all.get(&key).and_then(|jobs| jobs.last()).is_some_and(checkpointed) {
                json!("checkpointed")
            } else {
                list.last()
                    .map(|j| j["status"].clone())
                    .unwrap_or(json!("unknown"))
            };
            stage["attempts"] = json!(list);
            stage
        })
        .collect();
    run["stages"] = json!(stages);
    // Where each cited research record's line stands now, beside the version
    // the run or its decision cites (T-17).
    let task = run["taskId"].as_str().unwrap_or_default().to_owned();
    if let Some(seq) = run["method"]["activitySeq"].as_i64() {
        run["methodNow"] = collaboration::research_line_now(db, &task, seq)?;
    }
    for stage in run["stages"].as_array_mut().into_iter().flatten() {
        if let Some(seq) = stage["analysis"]["record"]["activitySeq"].as_i64() {
            stage["analysis"]["recordNow"] = collaboration::research_line_now(db, &task, seq)?;
        }
    }
    run["awaitingAnalysis"] = json!(run["stages"].as_array().into_iter().flatten().any(analysis::waiting));
    // A queued run says which stage is first in the queue and what it waits
    // for (YN-30); other runs have no queue field.
    if status == "queued" {
        if let Some(first) = queued::first(&run, &latest(&all), &queue) {
            run["queue"] = first;
        }
    }
    run["status"] = json!(status);
    run["cost"] = cost(&all);
    // The runs it waits for, with their status now (YN-30).
    if run["afterRuns"].is_array() {
        let states = after::states(db, &run)?;
        after::view(&mut run, &states);
    }
    Ok(run)
}

/// Cancelling the run invalidates every pending decision in the same transaction.
fn cancel_waiting(db: &Connection, run: &mut Value) -> Result<()> {
    if run["cancelRequestedAt"].is_null() {
        run["cancelRequestedAt"] = json!(now());
    }
    for mut job in attempts(db, run["id"].as_str().context("Missing run ID")?)?.into_values().flatten() {
        match job["status"].as_str().unwrap_or("") {
            "waiting" | "queued" => {
                job["status"] = json!("cancelled");
                job["reason"] =
                    json!("Run cancelled before this stage started; no process was created");
                job["finishedAt"] = json!(now());
                job["cancelRequestedAt"] = json!(now());
                job["notifications"]["cancelled"] = json!("run");
            }
            _ if job["reserved"] == true && job["status"] != "cancelling" => {
                if job["cancelRequestedAt"].is_null() {
                    job["cancelRequestedAt"] = json!(now());
                }
                job["status"] = json!("cancelling");
                job["reason"] =
                    json!("Run cancelled; reservation held until process groups have exited");
            }
            _ => continue,
        }
        save(db, &job)?;
    }
    for stage in run["stages"].as_array_mut().into_iter().flatten() {
        if analysis::waiting(stage) {
            stage["analysis"]["state"] = json!("cancelled");
            stage["analysis"]["cancelledAt"] = json!(now());
        }
    }
    save_run(db, run)?;
    Ok(())
}

fn previous_run(
    store: &Store,
    db: &Connection,
    actor: Option<&str>,
    input: &RunSubmit,
) -> Result<Option<Value>> {
    collaboration::actor_context(store, db, actor)?;
    let task = collaboration::task_key(db, &input.task_id)?.0;
    let mut expected = serde_json::to_value(input)?;
    expected["taskId"] = json!(task);
    let row: Option<(String, String)> = db
        .query_row(
            "SELECT input_json,response_json FROM collaboration_requests WHERE actor=?1 AND operation='job_run_submit' AND request_id=?2",
            params![super::store::actor_key(actor), input.request_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((old, response)) = row else {
        return Ok(None);
    };
    ensure!(
        serde_json::from_str::<Value>(&old)? == expected,
        "idempotency_conflict: requestId already names a different run submission"
    );
    let response: Value = serde_json::from_str(&response)?;
    Ok(Some(run_view(
        db,
        response["runId"].as_str().context("Invalid run receipt")?,
    )?))
}

impl Store {
    pub(super) fn previous_run(
        &self,
        actor: Option<&str>,
        input: &RunSubmit,
    ) -> Result<Option<Value>> {
        previous_run(self, &*self.db.read()?, actor, input)
    }
    pub(super) fn create_run(
        &self,
        actor: Option<&str>,
        input: RunSubmit,
        stages: Vec<Prepared>,
        machine: Value,
        capability: Value,
    ) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        if let Some(run) = previous_run(self, &tx, actor, &input)? {
            return Ok(run);
        }
        let (author, source) = collaboration::actor_context(self, &tx, actor)?;
        let (task, _) = collaboration::task_key(&tx, &input.task_id)?;
        let number = collaboration::task_number(&tx, &task)?;
        // Checked before anything is written: a run follows a method record
        // of its own task, as that record reads now.
        let method = input
            .method
            .as_ref()
            .map(|method| collaboration::research_run_method(&tx, &task, method.activity_seq))
            .transpose()?;
        let mut payload = serde_json::to_value(&input)?;
        payload["taskId"] = json!(task);
        // The runs it waits for: its own Agent's, resolved and checked (YN-30).
        let owner_id = actor.or(input.agent_id.as_deref()).context("A job must be associated with an Agent")?;
        let after_runs = after::check(&tx, owner_id, &input.after_runs)?;
        let root_needs: Vec<String> = after_runs.iter().filter_map(|a| a["runId"].as_str()).map(after::need).collect();
        let id = uuid::Uuid::new_v4().to_string();
        let mut owner = Value::Null;
        let mut list = Vec::new();
        for (stage, prepared) in input.stages.iter().zip(stages) {
            // Every stage passes a job submission's checks, reused ones too.
            let mut job = new_job(
                self,
                &tx,
                actor,
                &prepared.submit,
                prepared.snapshot,
                machine.clone(),
                capability.clone(),
            )?;
            owner = json!({"agentId":job["agentId"],"agent":job["agent"]});
            // A root stage also needs each run this one waits for (YN-30).
            let needs = if stage.needs.is_empty() { root_needs.clone() } else { stage.needs.clone() };
            list.push(
                json!({"key":stage.key,"name":prepared.submit.name,"needs":needs,
                "retry":stage.retry,"reusedFrom":prepared.reuse,"waitForAnalysis":stage.wait_for_analysis}),
            );
            if prepared.reuse.is_some() {
                continue;
            }
            // What earlier runs of the same Job suggest for this stage, kept
            // on the run and on its Job (YN-6 S2).
            let query = super::suggestion::Query {
                task_id: prepared.submit.task_id.clone(),
                name: prepared.submit.name.clone(),
                argv: prepared.submit.argv.clone(),
            };
            let suggestion = super::suggestion::for_job(&tx, &query, actor, prepared.submit.resources.memory_mi_b)?;
            if let Some(entry) = list.last_mut() {
                entry["suggestion"] = suggestion.clone();
            }
            job["suggestion"] = suggestion;
            job["status"] = json!("waiting");
            job["reason"] = json!("Waiting for its upstream stages");
            job["run"] = json!({"id":id,"stage":stage.key,"attempt":1,"needs":stage.needs,"retry":stage.retry});
            job["identity"] = prepared.identity;
            if !prepared.guard_exclude.is_empty() {
                job["guardExclude"] = json!(prepared.guard_exclude);
            }
            job["upstream"] = Value::Null;
            job["retryOf"] = Value::Null;
            let job = insert_job(&tx, job)?;
            tx.execute(
                "INSERT INTO local_job_run_attempts(run_id,stage,attempt,job_id) VALUES(?1,?2,1,?3)",
                params![id, stage.key, job["id"].as_str()],
            )?;
        }
        let mut run = json!({"id":id,"requestId":input.request_id,"taskId":task,"taskRef":number,
            "agentId":owner["agentId"],"agent":owner["agent"],"requestedBy":author,"source":source,
            "name":input.name,"experiment":input.experiment,"costLimitUsd":input.cost_limit_usd,
            "stages":list,"createdAt":now(),"cancelRequestedAt":null,"notifications":{},"settledAt":null});
        if let Some(method) = method {
            run["method"] = method;
        }
        if !after_runs.is_empty() {
            run["afterRuns"] = json!(after_runs);
        }
        tx.execute(
            "INSERT INTO local_job_runs(id,task_id,agent_id,data) VALUES(?1,?2,?3,?4)",
            params![id, task, run["agentId"].as_str(), run.to_string()],
        )?;
        tx.execute(
            "INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,'job_run_submit',?2,?3,?4)",
            params![super::store::actor_key(actor), input.request_id, payload.to_string(), json!({"runId":id}).to_string()],
        )?;
        advance(self, &tx, &id)?;
        let view = run_view(&tx, &id)?;
        tx.commit()?;
        Ok(view)
    }
    pub(super) fn run(&self, id: &str) -> Result<Value> {
        run_view(&*self.db.read()?, id)
    }
    pub(super) fn list_runs(
        &self,
        agent: Option<&str>,
        task: Option<&str>,
        experiment: Option<&str>,
        before: Option<i64>,
        awaiting_analysis: bool,
    ) -> Result<Value> {
        let db = self.db.read()?;
        let task = task
            .map(|t| collaboration::task_key(&db, t).map(|v| v.0))
            .transpose()?;
        let mut q = db.prepare(
            "SELECT id FROM local_job_runs WHERE (?1 IS NULL OR agent_id=?1) AND (?2 IS NULL OR task_id=?2)
             AND (?3 IS NULL OR json_extract(data,'$.experiment')=?3) AND seq<?4
             AND (?5=0 OR EXISTS(SELECT 1 FROM json_each(data,'$.stages') s
                 WHERE json_extract(s.value,'$.analysis.state')='waiting')) ORDER BY seq DESC LIMIT 21",
        )?;
        let ids = q
            .query_map(
                params![agent, task, experiment, before.unwrap_or(i64::MAX), awaiting_analysis],
                |r| r.get::<_, String>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = ids.len() > 20;
        let runs = ids
            .iter()
            .take(20)
            .map(|id| {
                let run = run_view(&db, id)?;
                let stages: Vec<Value> = run["stages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|s| json!({"key":s["key"],"status":s["status"],"attempts":s["attempts"].as_array().map_or(0, Vec::len)}))
                    .collect();
                let mut row = json!({"id":run["id"],"name":run["name"],"experiment":run["experiment"],"status":run["status"],
                    "taskRef":run["taskRef"],"agentId":run["agentId"],"agent":run["agent"],"createdAt":run["createdAt"],
                    "cursor":run["cursor"],"stages":stages,"cost":run["cost"],"awaitingAnalysis":run["awaitingAnalysis"]});
                if run["queue"].is_object() {
                    row["queue"] = run["queue"].clone();
                }
                Ok(row)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(
            json!({"runs":runs,"hasMore":more,"nextBefore":runs.last().map(|r| r["cursor"].clone())}),
        )
    }
    /// An explicit new attempt of a stage whose latest attempt ended without success.
    pub(super) fn retry_stage(
        &self,
        actor: Option<&str>,
        request_id: &str,
        run_id: &str,
        stage: &str,
    ) -> Result<Value> {
        ensure!(
            !request_id.trim().is_empty() && request_id.len() <= 128,
            "requestId must contain 1–128 bytes"
        );
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let key = super::store::actor_key(actor);
        let input = json!({"runId":run_id,"stage":stage});
        let previous: Option<String> = tx
            .query_row(
                "SELECT input_json FROM collaboration_requests WHERE actor=?1 AND operation='job_run_retry' AND request_id=?2",
                params![key, request_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            ensure!(
                serde_json::from_str::<Value>(&previous)? == input,
                "idempotency_conflict: requestId already names a different retry"
            );
            return run_view(&tx, run_id);
        }
        let run = get_run(&tx, run_id)?;
        ensure!(
            actor.is_none_or(|a| run["agentId"] == a),
            "An Agent can retry only its own runs"
        );
        ensure!(
            run["cancelRequestedAt"].is_null(),
            "This run was cancelled; submit a new run, reusing its succeeded stages explicitly"
        );
        let info = run["stages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| s["key"] == stage)
            .with_context(|| format!("Run {run_id} has no stage {stage}"))?;
        ensure!(
            info["reusedFrom"].is_null(),
            "Stage {stage} reused an earlier attempt; it has nothing to retry"
        );
        let all = attempts(&tx, run_id)?;
        let last = all
            .get(stage)
            .and_then(|jobs| jobs.last())
            .context("Stage has no attempt")?;
        let status = last["status"].as_str().unwrap_or("unknown");
        ensure!(
            actor.is_none() || !checkpointed(last),
            "Stage {stage}'s latest attempt was stopped at a checkpoint by the user; only the user resumes it (job_checkpoint_resume), or cancel the run with job_run_cancel"
        );
        ensure!(
            RETRYABLE.contains(&status),
            "Stage {stage}'s latest attempt is {status}; only a failed, cancelled, rejected or interrupted attempt can be retried{}",
            if status == "unknown" { " (cancel it first, so its process groups are confirmed stopped)" } else { "" }
        );
        let number = last["run"]["attempt"].as_i64().unwrap_or(1);
        ensure!(
            number < MAX_ATTEMPTS,
            "Stage {stage} already has {MAX_ATTEMPTS} attempts"
        );
        if let Some(limit) = limit_reached(&run, &all) {
            anyhow::bail!("{}", limit.replacen("Not started", "Not retried", 1));
        }
        new_attempt(&tx, last, number + 1)?;
        tx.execute(
            "INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,'job_run_retry',?2,?3,?4)",
            params![key, request_id, input.to_string(), json!({"runId":run_id}).to_string()],
        )?;
        advance(self, &tx, run_id)?;
        let view = run_view(&tx, run_id)?;
        tx.commit()?;
        Ok(view)
    }
    /// A submission's afterRuns by whole run ID (YN-30), before its repeat
    /// is compared: a prefix and the whole ID name the same submission.
    pub(super) fn resolve_after_runs(&self, mut input: RunSubmit) -> Result<RunSubmit> {
        for after in &mut input.after_runs {
            after.run_id = self.resolve_id(super::ids::Kind::Run, &after.run_id)?;
        }
        Ok(input)
    }
    /// The artifact paths the runs a submission waits for declare: its root
    /// stages' guards leave them out (YN-30).
    pub(super) fn after_run_artifacts(&self, input: &RunSubmit) -> Result<BTreeSet<String>> {
        let ids: Vec<String> = input.after_runs.iter().map(|a| a.run_id.clone()).collect();
        after::declared(&*self.db.read()?, &ids)
    }
    /// The user's resume of a stage attempt stopped at a verified checkpoint
    /// (YN-30): the stage's next attempt, made as a retry makes one, with the
    /// same frozen inputs, continuing from `from`. Stages that need it start
    /// after it succeeds. A repeat returns the same attempt.
    pub(super) fn resume_stage(&self, id: &str, from: Value) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut stopped = get(&tx, id)?;
        if let Some(next) = stopped["checkpointStop"]["resumedAs"].as_str().map(str::to_owned) {
            drop(tx);
            drop(db);
            return self.job(&next);
        }
        let run_id = stopped["run"]["id"].as_str().context("Missing run identity")?.to_owned();
        let key = stopped["run"]["stage"].as_str().context("Missing run stage")?.to_owned();
        let run = get_run(&tx, &run_id)?;
        ensure!(
            run["cancelRequestedAt"].is_null(),
            "This run was cancelled; its stage {key} can no longer be resumed. Submit a new run, reusing its succeeded stages explicitly"
        );
        ensure!(checkpointed(&stopped), "Only an attempt stopped at a verified checkpoint resumes from it");
        let all = attempts(&tx, &run_id)?;
        ensure!(
            all.get(&key).and_then(|jobs| jobs.last()).is_some_and(|job| job["id"] == stopped["id"]),
            "Stage {key} has a newer attempt; only its latest attempt resumes"
        );
        let number = stopped["run"]["attempt"].as_i64().unwrap_or(1);
        ensure!(number < MAX_ATTEMPTS, "Stage {key} already has {MAX_ATTEMPTS} attempts");
        if let Some(limit) = limit_reached(&run, &all) {
            anyhow::bail!("{}", limit.replacen("Not started", "Not resumed", 1));
        }
        let mut next = new_attempt(&tx, &stopped, number + 1)?;
        // It continues the stopped attempt; it is not a retry of it.
        next["checkpointFrom"] = from;
        next["retryOf"] = Value::Null;
        save(&tx, &next)?;
        let next_id = next["id"].as_str().context("Missing job identity")?.to_owned();
        stopped["checkpointStop"]["resumedAs"] = json!(next_id);
        stopped["checkpointStop"]["resumedAt"] = json!(now());
        save(&tx, &stopped)?;
        let task = stopped["taskId"].as_str().context("Missing task")?.to_owned();
        let public = collaboration::task_number(&tx, &collaboration::task_key(&tx, &task)?.0)?;
        let body = format!(
            "The user resumed stage {key} of run {} ({run_id}) from its checkpoint: attempt {} (job {next_id}) is the stage's next attempt, with the same frozen inputs, queued like any other; its command gets YUZUNO_RESUME_FROM. Stages that need {key} start after it succeeds. Task {public}. job_run_get(runId={run_id}) follows it.",
            run["name"].as_str().unwrap_or(""),
            number + 1,
        );
        let name = stopped["name"].as_str().unwrap_or("").to_owned();
        notify_message(&tx, &stopped["agent"], &task, &stopped, "checkpointResumed", &name, &run_id, body)?;
        advance(self, &tx, &run_id)?;
        tx.commit()?;
        drop(db);
        self.job(&next_id)
    }
    /// Stop a run: stages that have not started never will; running ones are
    /// cancelled as any Job is, released only when their groups are gone.
    pub(super) fn request_run_cancel(&self, actor: Option<&str>, run_id: &str) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut run = get_run(&tx, run_id)?;
        ensure!(
            actor.is_none_or(|a| run["agentId"] == a),
            "An Agent can cancel only its own runs"
        );
        // A run that already succeeded or was cancelled keeps its outcome.
        if run["settledAt"].is_string() {
            return run_view(&tx, run_id);
        }
        cancel_waiting(&tx, &mut run)?;
        advance(self, &tx, run_id)?;
        let view = run_view(&tx, run_id)?;
        tx.commit()?;
        Ok(view)
    }
    /// The safety net of the reconciliation loop: every run still in flight
    /// is advanced, as each change already did in its own transaction.
    pub(super) fn advance_runs(&self) -> Result<bool> {
        let ids: Vec<String> = {
            let db = self.db.read()?;
            let mut q = db.prepare(
                "SELECT id FROM local_job_runs WHERE json_extract(data,'$.settledAt') IS NULL
                 AND json_extract(data,'$.idleAt') IS NULL ORDER BY seq DESC LIMIT 64",
            )?;
            let ids = q
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids
        };
        if ids.is_empty() {
            return Ok(false);
        }
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut changed = false;
        for id in ids {
            changed |= advance(self, &tx, &id)?;
        }
        tx.commit()?;
        Ok(changed)
    }
}
