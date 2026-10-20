//! Durable local jobs. Core owns admission/reservations; systemd owns processes.
pub(crate) mod disk;
mod gpu;
#[cfg(test)]
mod gpu_tests;
mod checkpoint;
mod host;
mod list;
#[cfg(test)]
mod list_tests;
mod pause;
mod queue;
mod remote;
pub(crate) use remote::WINDOWS_LEGACY_ROOT;
mod resource_summary;
#[cfg(test)]
mod resource_tests;
#[cfg(test)]
mod remote_tests;
mod runs;
pub(crate) mod store;
#[cfg(test)]
mod pause_tests;
#[cfg(test)]
mod checkpoint_tests;
#[cfg(test)]
mod run_tests;
#[cfg(test)]
mod tests;

use crate::{server::ApiError, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
use axum::{
    extract::{Path, Query, State as AppState},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::{Mutex, Notify};

pub(crate) const COLLECTOR_MEMORY: u64 = 64;
pub(crate) const COLLECTOR_CPU: u64 = 100;
pub(crate) const MAX_ACTIVE: usize = 4;
#[derive(Default)]
pub(crate) struct State {
    started: OnceLock<()>,
    gate: Mutex<()>,
    wake: Arc<Notify>,
    /// When the GPUs were last sampled; at most one sample per interval.
    gpu_sampled: std::sync::Mutex<Option<std::time::Instant>>,
    /// The remote executor's own loop (remote.rs): its gate, its wake-up and
    /// when each remote attempt was last checked.
    remote_gate: Mutex<()>,
    remote_wake: Arc<Notify>,
    remote_seen: std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Resources {
    pub cpu_millis: u64,
    pub memory_mi_b: u64,
    pub swap_mi_b: u64,
}
impl Resources {
    fn reservation(&self) -> Self {
        Self {
            cpu_millis: self.cpu_millis + COLLECTOR_CPU,
            memory_mi_b: self.memory_mi_b + COLLECTOR_MEMORY,
            swap_mi_b: self.swap_mi_b,
        }
    }
    fn fits(&self, available: &Self) -> bool {
        self.cpu_millis <= available.cpu_millis
            && self.memory_mi_b <= available.memory_mi_b
            && self.swap_mi_b <= available.swap_mi_b
    }
    fn add(&mut self, other: &Self) {
        self.cpu_millis += other.cpu_millis;
        self.memory_mi_b += other.memory_mi_b;
        self.swap_mi_b += other.swap_mi_b;
    }
    fn available(&self, used: &Self) -> Self {
        Self {
            cpu_millis: self.cpu_millis.saturating_sub(used.cpu_millis),
            memory_mi_b: self.memory_mi_b.saturating_sub(used.memory_mi_b),
            swap_mi_b: self.swap_mi_b.saturating_sub(used.swap_mi_b),
        }
    }
}

/// The free-space verdict for the queued Job that starts next.
pub(crate) struct DiskCheck {
    pub job_id: String,
    pub verdict: disk::Verdict,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiskReserve {
    /// GiB; null returns to the default.
    reserve_gi_b: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowsJobs {
    /// The most Windows attempts at once, 1–64; null returns to the default (2).
    max_jobs: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Submit {
    request_id: String,
    task_id: String,
    agent_id: Option<String>,
    name: String,
    cwd: String,
    argv: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    resources: Resources,
    #[serde(default)]
    exclusive: bool,
    #[serde(default = "default_timeout")]
    timeout_seconds: u64,
    #[serde(default = "yes")]
    guard_git: bool,
    #[serde(default)]
    inputs: Vec<String>,
    #[serde(default)]
    outputs: Vec<String>,
    /// Files a clean exit must leave behind, verified before it counts as success.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    artifacts: Vec<Artifact>,
    /// Local NVIDIA GPUs the command needs, admitted with its CPU and RAM.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gpu: Option<gpu::GpuRequest>,
    /// A registered SSH machine (Linux) to run on instead of this host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    machine_id: Option<String>,
    /// How the command saves and exits when the user stops it at a
    /// checkpoint (T-109). This host's standalone Jobs only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    checkpoint: Option<Checkpoint>,
    /// The verified checkpoint a resumed Job continues from: set only by the
    /// user's resume (checkpoint.rs), never accepted in a submission.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    checkpoint_from: Option<Value>,
}

/// A command's own stop protocol: on the user's stop its wrapper sends it
/// `signal`; it saves into the attempt's checkpoint folder, writes the
/// manifest last and exits `stoppedExitCode` within `graceSeconds`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Checkpoint {
    #[serde(default = "default_checkpoint_signal")]
    signal: String,
    grace_seconds: u64,
    stopped_exit_code: i32,
}
fn default_checkpoint_signal() -> String {
    "SIGTERM".into()
}

/// A file a command must produce. Only its structure is checked (a complete
/// regular file inside cwd, at least `minBytes`, whole JSON or JSON lines);
/// whether its content is valid for the experiment is the project's call.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Artifact {
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    format: Option<ArtifactFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    min_bytes: Option<u64>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ArtifactFormat {
    Bytes,
    Json,
    Jsonl,
}

/// A path below cwd: not absolute and never through a parent directory.
fn relative_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains('\0')
        && !std::path::Path::new(path).is_absolute()
        && !std::path::Path::new(path)
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
}
/// A drive path on Windows, such as C:\work or C:/work, without control
/// characters. Network and device paths are not accepted.
fn windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
        && !path.chars().any(char::is_control)
}
/// A path below a Windows cwd: no drive, not rooted (\ or /), no stream or
/// drive colon, never through a parent directory with either separator.
fn windows_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.chars().any(char::is_control)
        && !path.starts_with(['\\', '/'])
        && !path.contains(':')
        && !path.split(['\\', '/']).any(|part| part == "..")
}
fn default_timeout() -> u64 {
    86400
}
fn yes() -> bool {
    true
}
impl Submit {
    /// Linux defaults for a command on this host or a Linux machine; a
    /// Windows command keeps its own environment.
    fn default_env(&mut self) {
        if self.machine_id.as_deref() == Some(remote::WINDOWS) {
            return;
        }
        self.env.entry("PATH".into()).or_insert_with(|| "/usr/local/bin:/usr/bin:/bin".into());
        self.env.entry("LANG".into()).or_insert_with(|| "C.UTF-8".into());
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            !self.request_id.trim().is_empty() && self.request_id.len() <= 128,
            "requestId must contain 1–128 bytes"
        );
        if let Some(checkpoint) = &self.checkpoint {
            ensure!(
                self.machine_id.is_none(),
                "Stop at a checkpoint is available for Jobs on this Core's host only; omit checkpoint with machineId"
            );
            ensure!(
                matches!(checkpoint.signal.as_str(), "SIGTERM" | "SIGINT" | "SIGUSR1"),
                "checkpoint.signal must be SIGTERM, SIGINT or SIGUSR1"
            );
            ensure!(
                (10..=900).contains(&checkpoint.grace_seconds) && checkpoint.grace_seconds < self.timeout_seconds,
                "checkpoint.graceSeconds must be 10–900 and shorter than timeoutSeconds"
            );
            ensure!(
                (1..=125).contains(&checkpoint.stopped_exit_code),
                "checkpoint.stoppedExitCode must be 1–125, never 0: a stop must not look like a finished run"
            );
        }
        if let Some(machine) = &self.machine_id {
            // What Core can enforce or see on this host does not exist there.
            ensure!(!machine.trim().is_empty() && machine.len() <= 128, "machineId must contain 1–128 bytes");
            ensure!(self.gpu.is_none(), "GPU admission is not available on a remote machine in this version; omit gpu");
            ensure!(!self.exclusive, "exclusive applies to this host's jobs only; omit it for a remote machine");
            ensure!(!self.guard_git, "guardGit reads the working tree on this host; set guardGit to false for a remote machine (its files are not visible to Core)");
            ensure!(
                self.outputs.is_empty(),
                "outputs are downloaded from this host; on a remote machine they stay there, so declare them as artifacts instead"
            );
            // On Windows, files of that PC: inputs on a drive or below cwd,
            // artifacts below cwd, with Windows' separators.
            ensure!(
                machine != remote::WINDOWS
                    || self.inputs.iter().all(|p| windows_absolute(p) || windows_relative(p)),
                "inputs on Windows are drive paths such as C:\\data\\a.txt or paths relative to cwd, never through .."
            );
            ensure!(
                machine != remote::WINDOWS || self.artifacts.iter().all(|a| windows_relative(&a.path)),
                "artifacts on Windows are paths relative to cwd, such as out\\result.json, never through .. and without a drive or :"
            );
        }
        self.validate_command()
    }
    /// Everything but the request identity, which a run's stage takes from its run.
    fn validate_command(&self) -> Result<()> {
        ensure!(
            !self.name.trim().is_empty() && self.name.len() <= 160,
            "Job name must contain 1–160 bytes"
        );
        if self.machine_id.as_deref() == Some(remote::WINDOWS) {
            ensure!(
                windows_absolute(&self.cwd) && self.cwd.len() <= 4096,
                "cwd must be an absolute Windows directory such as C:\\work for machineId windows"
            );
        } else {
            ensure!(
                std::path::Path::new(&self.cwd).is_absolute() && self.cwd.len() <= 4096,
                "cwd must be an absolute local directory"
            );
        }
        ensure!(
            !self.argv.is_empty()
                && self.argv.len() <= 128
                && !self.argv[0].is_empty()
                && self.argv.iter().all(|s| !s.contains('\0'))
                && self.argv.iter().map(String::len).sum::<usize>() <= 16384,
            "argv must have 1–128 entries, at most 16 KiB, without NUL"
        );
        ensure!(
            self.env.len() <= 64
                && self
                    .env
                    .iter()
                    .all(|(k, v)| !k.is_empty() && !k.contains(['=', '\0']) && !v.contains('\0'))
                && self
                    .env
                    .iter()
                    .map(|(k, v)| k.len() + v.len())
                    .sum::<usize>()
                    <= 16384,
            "env must contain at most 64 valid entries / 16 KiB"
        );
        ensure!(
            (100..=256000).contains(&self.resources.cpu_millis)
                && (64..=1_048_576).contains(&self.resources.memory_mi_b)
                && self.resources.swap_mi_b <= 1_048_576,
            "CPU must be 100–256000 millicores, memory 64–1048576 MiB, swap 0–1048576 MiB"
        );
        ensure!(
            (1..=604800).contains(&self.timeout_seconds),
            "timeoutSeconds must be 1–604800"
        );
        ensure!(
            self.inputs.len() <= 128
                && self
                    .inputs
                    .iter()
                    .all(|p| !p.is_empty() && p.len() <= 4096 && !p.contains('\0')),
            "At most 128 explicit small input paths are supported"
        );
        ensure!(self.outputs.len() <= 20 && self.outputs.iter().all(|p| !p.is_empty() && p.len() <= 4096 && !p.contains('\0') && !std::path::Path::new(p).is_absolute() && !std::path::Path::new(p).components().any(|c|matches!(c,std::path::Component::ParentDir))),"At most 20 output paths relative to cwd are supported; parent traversal is not allowed");
        ensure!(
            self.artifacts.len() <= 20
                && self.artifacts.iter().all(|a| relative_path(&a.path)
                    && a.min_bytes.is_none_or(|n| n <= 1 << 40))
                && self
                    .artifacts
                    .iter()
                    .map(|a| &a.path)
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    == self.artifacts.len(),
            "At most 20 distinct artifact paths relative to cwd are supported; parent traversal is not allowed"
        );
        if let Some(gpu) = &self.gpu {
            gpu.validate()?;
        }
        Ok(())
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct List {
    agent_id: Option<String>,
    task_id: Option<String>,
    before: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    job_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Log {
    job_id: String,
    offset: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GpuAdmission {
    uuid: String,
    open: bool,
    reason: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunReference {
    run_id: String,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunList {
    awaiting_analysis: Option<bool>,
    agent_id: Option<String>,
    task_id: Option<String>,
    experiment: Option<String>,
    before: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunRetry {
    request_id: String,
    run_id: String,
    stage: String,
}

pub(crate) fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/jobs", get(list).post(submit))
        .route("/api/jobs/budget", get(budget).post(set_budget))
        .route("/api/jobs/disk", post(set_disk_reserve))
        .route("/api/jobs/windows", post(set_windows_jobs))
        .route("/api/jobs/live", get(live))
        .route("/api/jobs/gpus", get(gpus))
        .route("/api/jobs/gpus/{uuid}/admission", post(gpu_admission))
        .route("/api/jobs/gpus/{uuid}/settings", post(gpu_settings))
        .route("/api/jobs/runs", get(list_runs).post(submit_run))
        .route("/api/jobs/runs/{id}", get(run_report))
        .route("/api/jobs/runs/{id}/cancel", post(cancel_run))
        .route("/api/jobs/runs/{id}/retry", post(retry_run))
        .route("/api/jobs/runs/{id}/decide", post(decide_run))
        .route("/api/jobs/{id}", get(report))
        .route("/api/jobs/{id}/cancel", post(cancel))
        .route("/api/jobs/{id}/pause", post(pause_job))
        .route("/api/jobs/{id}/resume", post(resume_job))
        .route("/api/jobs/{id}/checkpoint", post(checkpoint_stop))
        .route("/api/jobs/{id}/resume-checkpoint", post(checkpoint_resume))
        .route("/api/jobs/gpus/{uuid}/pause", post(pause_gpu))
        .route("/api/jobs/gpus/{uuid}/resume", post(resume_gpu))
        .route("/api/jobs/{id}/logs", get(logs))
        .route("/api/jobs/{id}/outputs/{index}", get(output))
        .route("/api/jobs/{id}/artifacts/{index}", get(artifact))
}
async fn list(
    AppState(ws): AppState<Arc<Workspace>>,
    Query(input): Query<List>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(
            ws,
            None,
            "job_list".into(),
            json!({"agentId":input.agent_id,"taskId":input.task_id,"before":input.before}),
        )
        .await?,
    ))
}
async fn submit(
    AppState(ws): AppState<Arc<Workspace>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(call(ws, None, "job_submit".into(), input).await?))
}
async fn report(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(ws, None, "job_get".into(), json!({"jobId":id})).await?,
    ))
}
async fn cancel(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(ws, None, "job_cancel".into(), json!({"jobId":id})).await?,
    ))
}
async fn pause_job(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(ws, None, "job_pause".into(), json!({"jobId":id})).await?,
    ))
}
async fn pause_gpu(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(uuid): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(ws, None, "job_gpu_pause".into(), json!({"uuid":uuid})).await?,
    ))
}
async fn resume_gpu(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(uuid): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(ws, None, "job_gpu_resume".into(), json!({"uuid":uuid})).await?,
    ))
}
async fn resume_job(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(ws, None, "job_resume".into(), json!({"jobId":id})).await?,
    ))
}
async fn checkpoint_stop(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(ws, None, "job_checkpoint_stop".into(), json!({"jobId":id})).await?,
    ))
}
async fn checkpoint_resume(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(ws, None, "job_checkpoint_resume".into(), json!({"jobId":id})).await?,
    ))
}
#[derive(Deserialize)]
struct LogQuery {
    offset: Option<u64>,
}
async fn logs(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
    Query(q): Query<LogQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(
            ws,
            None,
            "job_logs".into(),
            json!({"jobId":id,"offset":q.offset}),
        )
        .await?,
    ))
}
async fn list_runs(
    AppState(ws): AppState<Arc<Workspace>>,
    Query(input): Query<RunList>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(
            ws,
            None,
            "job_run_list".into(),
            json!({"agentId":input.agent_id,"taskId":input.task_id,"experiment":input.experiment,"before":input.before,"awaitingAnalysis":input.awaiting_analysis}),
        )
        .await?,
    ))
}
async fn submit_run(
    AppState(ws): AppState<Arc<Workspace>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(call(ws, None, "job_run_submit".into(), input).await?))
}
async fn run_report(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(ws, None, "job_run_get".into(), json!({"runId":id})).await?,
    ))
}
async fn cancel_run(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(ws, None, "job_run_cancel".into(), json!({"runId":id})).await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetryBody {
    request_id: String,
    stage: String,
}
async fn retry_run(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(input): Json<RetryBody>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(
            ws,
            None,
            "job_run_retry".into(),
            json!({"requestId":input.request_id,"runId":id,"stage":input.stage}),
        )
        .await?,
    ))
}
async fn decide_run(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(mut input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if !input.is_object() {
        return Err(anyhow::anyhow!("Expected an analysis decision object").into());
    }
    input["runId"] = json!(id);
    Ok(Json(call(ws, None, "job_run_decide".into(), input).await?))
}
async fn gpus(AppState(ws): AppState<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(call(ws, None, "job_gpus".into(), json!({})).await?))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdmissionBody {
    open: bool,
    reason: Option<String>,
}
async fn gpu_admission(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(uuid): Path<String>,
    Json(input): Json<AdmissionBody>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(ws, None, "job_gpu_admission".into(), json!({"uuid":uuid,"open":input.open,"reason":input.reason})).await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GpuSettings {
    sharing: Option<bool>,
    headroom_mi_b: Option<u64>,
}
/// The user's own choices for a device: sharing among managed jobs and the
/// memory kept free. Not an Agent tool.
async fn gpu_settings(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(uuid): Path<String>,
    Json(input): Json<GpuSettings>,
) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_completion()?;
    let value = ws
        .stored(move |s| s.set_gpu_sharing(&uuid, input.sharing, input.headroom_mi_b))
        .await?;
    ws.jobs.wake.notify_one();
    changed(&ws);
    Ok(Json(value))
}
/// Unfinished jobs per Agent, for the Agent list.
async fn live(AppState(ws): AppState<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(call(ws, None, "job_live".into(), json!({})).await?))
}
async fn budget(AppState(ws): AppState<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(call(ws, None, "job_budget".into(), json!({})).await?))
}
async fn output(
    AppState(ws): AppState<Arc<Workspace>>,
    Path((id, index)): Path<(String, usize)>,
    request: axum::extract::Request,
) -> Result<axum::response::Response, ApiError> {
    let job = ws.stored(move |s| s.job(&id)).await?;
    let path = host::output_path(&job, index).await?;
    Ok(attachment(path, request).await)
}
/// A verified artifact of one attempt, served only while the file on disk is
/// still the one that attempt produced: a later overwrite is not its result.
async fn artifact(
    AppState(ws): AppState<Arc<Workspace>>,
    Path((id, index)): Path<(String, usize)>,
    request: axum::extract::Request,
) -> Result<axum::response::Response, ApiError> {
    let job = ws.stored(move |s| s.job(&id)).await?;
    if let Some(refusal) = remote_artifact_refusal(&job) {
        return Err(anyhow::anyhow!(refusal).into());
    }
    let path = host::artifact_path(&ws.data_dir, &job, index).await?;
    Ok(attachment(path, request).await)
}
/// A remote Job's artifacts are files on its machine: their paths name
/// nothing on this host, so none is served from here.
pub(super) fn remote_artifact_refusal(job: &Value) -> Option<String> {
    job["executor"]["kind"].as_str().filter(|kind| *kind != "local").map(|_| {
        format!("This artifact is on {}; Core checks it there and does not copy it, so it cannot be downloaded here",
            job["machine"]["name"].as_str().unwrap_or("the remote machine"))
    })
}
async fn attachment(path: std::path::PathBuf, request: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    use tower::ServiceExt;
    let mut response = tower_http::services::ServeFile::new(path)
        .oneshot(request)
        .await
        .unwrap()
        .into_response();
    response.headers_mut().insert(
        axum::http::header::CONTENT_DISPOSITION,
        axum::http::HeaderValue::from_static("attachment"),
    );
    response
}
async fn set_budget(
    AppState(ws): AppState<Arc<Workspace>>,
    Json(input): Json<Resources>,
) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let machine = host::machine_info().await?;
    let limits: Resources = serde_json::from_value(machine["maximumBudget"].clone())?;
    validate_budget(&input, &limits)?;
    let value = ws.stored(move |s| s.set_job_budget(input)).await?;
    ws.start_jobs();
    ws.jobs.wake.notify_one();
    changed(&ws);
    Ok(Json(value))
}

/// The most Windows attempts at once on this PC. Only a ceiling: they keep
/// sharing this host's budget. Lowering it stops nothing that holds a slot.
async fn set_windows_jobs(
    AppState(ws): AppState<Arc<Workspace>>,
    Json(input): Json<WindowsJobs>,
) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let max_jobs = ws.stored(move |s| s.set_windows_max_jobs(input.max_jobs)).await?;
    ws.jobs.remote_wake.notify_one();
    changed(&ws);
    Ok(Json(json!({"maxJobs": max_jobs.map_or(remote::SLOTS, i64::from), "set": max_jobs.is_some(), "defaultMaxJobs": remote::SLOTS})))
}

async fn set_disk_reserve(
    AppState(ws): AppState<Arc<Workspace>>,
    Json(input): Json<DiskReserve>,
) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let reserve = ws.stored(move |s| s.set_job_disk_reserve(input.reserve_gi_b)).await?;
    ws.start_jobs();
    ws.jobs.wake.notify_one();
    changed(&ws);
    Ok(Json(json!({"reserveGiB":reserve})))
}

/// `YUZUNO_WINDOWS_JOBS_HELPER` and `YUZUNO_WINDOWS_JOBS_HELPER_SHA256` for
/// a managed release: its own verified copy of the Windows Jobs helper and
/// the digest from its signed manifest, or both empty when it has none.
pub fn release_windows_helper(release: &crate::updates::package::Bundle) -> (std::path::PathBuf, String) {
    remote::release_windows_helper(release)
}

/// Free space of Core's data folder and of every queued or running Job's
/// working directory, as the Jobs panel and job_budget show it.
async fn disk_view(ws: &Arc<Workspace>) -> Result<Value> {
    let configured = ws.stored(|s| s.job_disk_reserve()).await?;
    let cwds = ws.stored(|s| s.live_job_cwds()).await?;
    // Read together, so one hung mount costs one timeout, not one per path.
    let mut reads = vec![disk::sample(ws.data_dir.to_string_lossy().into_owned(), disk::DATA)];
    reads.extend(cwds.into_iter().map(|cwd| disk::sample(cwd, disk::WORKDIR)));
    let samples = futures_util::future::join_all(reads).await;
    Ok(disk::view(&samples, configured, &crate::model::now()))
}

fn validate_budget(input: &Resources, limits: &Resources) -> Result<()> {
    ensure!(input.cpu_millis >= 200 && input.memory_mi_b >= 128 && input.fits(limits),
        "Budget must be at least 200 mCPU / 128 MiB RAM and within this host's ceiling: {} mCPU / {} MiB RAM / {} MiB swap (including collectors)",
        limits.cpu_millis, limits.memory_mi_b, limits.swap_mi_b);
    Ok(())
}

pub async fn call(
    ws: Arc<Workspace>,
    actor: Option<String>,
    operation: String,
    input: Value,
) -> Result<Value> {
    let identity = actor.clone();
    ws.stored(move |s| s.collaboration_call(identity.as_deref(), "projects_list", json!({})))
        .await?;
    let decision = if operation == "job_run_decide" {
        Some(serde_json::from_value::<runs::AnalysisDecision>(input.clone())?)
    } else { None };
    // Continuing a frozen DAG admits new work, including while update drain is active.
    // A resume from a checkpoint queues a new Job, as a submit does.
    let _permit = if matches!(operation.as_str(), "job_submit" | "job_run_submit" | "job_run_retry" | "job_checkpoint_resume")
        || decision.as_ref().is_some_and(|d| d.continues()) {
        ws.admission.enter_work()?
    } else {
        ws.admission.enter_completion()?
    };
    ws.start_jobs();
    match operation.as_str() {
        "job_submit" => {
            let mut input: Submit = serde_json::from_value(input)?;
            input.validate()?;
            input.default_env();
            let windows = input.machine_id.as_deref() == Some(remote::WINDOWS);
            let prior = input.clone();
            let author = actor.clone();
            if let Some(job) = ws
                .stored(move |s| s.previous_job(author.as_deref(), &prior))
                .await?
            {
                return Ok(job);
            }
            if input.machine_id.is_some() {
                if windows {
                    // Windows on this PC holds this host's budget: make sure
                    // there is one, as a first local job would.
                    let host = host::machine_info().await?;
                    ws.stored(move |s| s.init_job_budget(&host["suggestedBudget"])).await?;
                }
                // Inputs are files on that machine, frozen there now; nothing of
                // this host is read for them (on Windows, nothing through /mnt).
                let machine_id = input.machine_id.clone().unwrap_or_default();
                let helper = if windows { remote::windows_helper() } else { None };
                let programs = remote::Programs { ssh: remote::SSH, windows: helper.as_ref() };
                let snapshot = remote::remote_snapshot(&ws, &programs, &machine_id, &input.cwd, &input.inputs).await?;
                let author = actor.clone();
                let capabilities = if windows { remote::windows_capabilities() } else { remote::capabilities() };
                // The machine is read in the Job's own insert transaction.
                let job = ws
                    .stored(move |s| {
                        // Until it ends, a Core before data roots would start it in its own
                        // folder, without this Core's limits (older_cores.rs).
                        let _kept_out = s.keep_older_cores_out(if windows { "a Job is queued for Windows" } else { "a Job is queued for a remote machine" })?;
                        s.create_job(author.as_deref(), input, snapshot, Value::Null, capabilities)
                    })
                    .await?;
                changed(&ws);
                ws.jobs.remote_wake.notify_one();
                return Ok(job);
            }
            let helper = host::helper(&ws.data_dir).await?;
            let capability = host::invoke(&helper, "capabilities", None, None).await?;
            let machine = host::machine_info().await?;
            // Capture an explicit safe baseline instead of copying Core credentials.
            let snapshot = host::invoke(
                &helper,
                "snapshot",
                None,
                Some(serde_json::to_value(&input)?),
            )
            .await?;
            let author = actor.clone();
            let job = ws
                .stored(move |s| {
                    s.create_job(author.as_deref(), input, snapshot, machine, capability)
                })
                .await?;
            changed(&ws);
            ws.jobs.wake.notify_one();
            Ok(job)
        }
        "job_list" => {
            ws.stored(move |s| s.list_jobs_for(actor.as_deref(), input)).await
        }
        "job_get" => {
            let q: Reference = serde_json::from_value(input)?;
            let mut job = ws.stored(move |s| s.job(&q.job_id)).await?;
            if actor.as_deref().is_some_and(|a| job["agentId"] != a) {
                job["env"] = json!({"redacted":"Another Agent's explicit environment is private"});
            }
            if job["executor"].is_null() {
                job["usage"] = host::usage(&ws.data_dir, &job).await.unwrap_or(Value::Null);
                // What a live attempt has reported so far; a finished one keeps it in its result.
                job["reports"] = host::reports(&ws.data_dir, &job).await.unwrap_or(Value::Null);
            }
            job["resourceSummary"] = resource_summary::attempt(&job);
            Ok(job)
        }
        "job_cancel" => {
            let q: Reference = serde_json::from_value(input)?;
            let id = q.job_id;
            let job = ws
                .stored(move |s| s.request_job_cancel(actor.as_deref(), &id))
                .await?;
            changed(&ws);
            ws.jobs.wake.notify_one();
            ws.jobs.remote_wake.notify_one();
            Ok(job)
        }
        "job_pause" | "job_resume" => {
            let q: Reference = serde_json::from_value(input)?;
            pause::control(&ws, actor, q.job_id, operation == "job_resume").await
        }
        "job_checkpoint_stop" => {
            let q: Reference = serde_json::from_value(input)?;
            checkpoint::stop(&ws, actor, q.job_id).await
        }
        "job_checkpoint_resume" => {
            let q: Reference = serde_json::from_value(input)?;
            checkpoint::resume(&ws, actor, q.job_id).await
        }
        "job_gpu_pause" | "job_gpu_resume" => {
            let uuid = input["uuid"].as_str().context("uuid is required")?.to_owned();
            let value = pause::device(&ws, actor, uuid, operation == "job_gpu_resume").await?;
            ws.jobs.wake.notify_one();
            Ok(value)
        }
        "job_logs" => {
            let q: Log = serde_json::from_value(input)?;
            let id = q.job_id;
            let job = ws.stored(move |s| s.job(&id)).await?;
            if job["executor"].is_object() {
                return remote::logs(&ws, &job, q.offset).await;
            }
            host::logs(&ws.data_dir, &job, q.offset).await
        }
        "job_live" => ws.stored(|s| s.live_job_counts()).await,
        "job_run_submit" => {
            let mut input: runs::RunSubmit = serde_json::from_value(input)?;
            for stage in &mut input.stages {
                stage
                    .env
                    .entry("PATH".into())
                    .or_insert_with(|| "/usr/local/bin:/usr/bin:/bin".into());
                stage.env.entry("LANG".into()).or_insert_with(|| "C.UTF-8".into());
            }
            input.validate()?;
            let prior = input.clone();
            let author = actor.clone();
            if let Some(run) = ws
                .stored(move |s| s.previous_run(author.as_deref(), &prior))
                .await?
            {
                return Ok(run);
            }
            let helper = host::helper(&ws.data_dir).await?;
            let capability = host::invoke(&helper, "capabilities", None, None).await?;
            let machine = host::machine_info().await?;
            let mut prepared = Vec::new();
            let mut reused = std::collections::HashMap::new();
            // Artifacts each stage and its ancestors declare, by stage.
            let mut produced: std::collections::HashMap<String, std::collections::BTreeSet<String>> =
                std::collections::HashMap::new();
            for stage in &input.stages {
                let submit = input.submit(stage);
                let key = stage.key().to_owned();
                let mut exclude = std::collections::BTreeSet::new();
                for need in stage.needs() {
                    exclude.extend(produced.get(need).into_iter().flatten().cloned());
                }
                // Each stage freezes its own inputs now, as a submitted job does,
                // except the artifacts its earlier stages will write.
                let mut request = serde_json::to_value(&submit)?;
                if !exclude.is_empty() {
                    request["guardExclude"] = json!(exclude);
                }
                let snapshot = host::invoke(&helper, "snapshot", None, Some(request))
                    .await
                    .map_err(|error| anyhow::anyhow!("Stage {key}: {error:#}"))?;
                let mut own = exclude.clone();
                own.extend(submit.artifacts.iter().map(|a| {
                    format!("{}/{}", submit.cwd.trim_end_matches('/'), a.path)
                }));
                produced.insert(key.clone(), own);
                let identity = runs::spec_identity(&submit, &snapshot, stage.needs());
                let reuse = if stage.reuses() {
                    let checked = runs::check_reuse(&ws, &helper, &machine, stage, &identity, &reused).await?;
                    reused.insert(key, checked.clone());
                    Some(checked)
                } else {
                    None
                };
                prepared.push(runs::Prepared {
                    submit,
                    snapshot,
                    identity,
                    reuse,
                    guard_exclude: exclude.into_iter().collect(),
                });
            }
            let author = actor.clone();
            let run = ws
                .stored(move |s| s.create_run(author.as_deref(), input, prepared, machine, capability))
                .await?;
            changed(&ws);
            ws.jobs.wake.notify_one();
            Ok(run)
        }
        "job_run_get" => {
            let q: RunReference = serde_json::from_value(input)?;
            ws.stored(move |s| s.run(&q.run_id)).await
        }
        "job_run_list" => {
            let q: RunList = serde_json::from_value(input)?;
            ws.stored(move |s| {
                s.list_runs(q.agent_id.as_deref(), q.task_id.as_deref(), q.experiment.as_deref(), q.before, q.awaiting_analysis.unwrap_or(false))
            })
            .await
        }
        "job_run_decide" => {
            let decision = decision.context("Missing analysis decision")?;
            let value = ws.stored(move |s| s.decide_run(actor.as_deref(), &decision)).await?;
            changed(&ws);
            ws.jobs.wake.notify_one();
            Ok(value)
        }
        "job_run_retry" => {
            let q: RunRetry = serde_json::from_value(input)?;
            let run = ws
                .stored(move |s| s.retry_stage(actor.as_deref(), &q.request_id, &q.run_id, &q.stage))
                .await?;
            changed(&ws);
            ws.jobs.wake.notify_one();
            Ok(run)
        }
        "job_run_cancel" => {
            let q: RunReference = serde_json::from_value(input)?;
            let run = ws
                .stored(move |s| s.request_run_cancel(actor.as_deref(), &q.run_id))
                .await?;
            changed(&ws);
            ws.jobs.wake.notify_one();
            Ok(run)
        }
        "job_budget" => {
            ensure!(
                input.as_object().is_some_and(|m| m.is_empty()),
                "job_budget takes no arguments"
            );
            sample_gpus(&ws, false).await;
            let machine = host::machine_info().await?;
            let mut view = ws.stored(move |s| s.job_budget_view(machine)).await?;
            view["disk"] = disk_view(&ws).await?;
            // Whether machineId "windows" exists here at all (WSL with interop on).
            view["windows"]["available"] = json!(remote::windows_available());
            Ok(view)
        }
        "job_gpus" => {
            sample_gpus(&ws, false).await;
            ws.stored(|s| s.gpu_devices()).await
        }
        "job_gpu_admission" => {
            let q: GpuAdmission = serde_json::from_value(input)?;
            let by = actor.clone();
            let value = ws
                .stored(move |s| s.set_gpu_admission(&q.uuid, q.open, q.reason, by.as_deref()))
                .await?;
            changed(&ws);
            ws.jobs.wake.notify_one();
            Ok(value)
        }
        _ => bail!("Unknown job operation"),
    }
}

fn changed(ws: &Workspace) {
    ws.changes
        .publish(&json!({"type":"workspace.changed","scope":"jobs"}));
    ws.collaboration_wakeup.notify_one();
}

impl Workspace {
    pub(crate) fn start_jobs(self: &Arc<Self>) {
        if self.jobs.started.set(()).is_err() {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(ws) = weak.upgrade() else {
                    break;
                };
                if let Err(error) = tick(&ws).await {
                    eprintln!("Local jobs reconciliation: {error:#}");
                }
                // No strong Workspace reference while sleeping: Core shutdown owns its lifetime.
                let wake = ws.jobs.wake.clone();
                drop(ws);
                tokio::select! { _ = tokio::time::sleep(Duration::from_secs(2)) => {}, _ = wake.notified() => {} }
            }
        });
        remote::start(self);
    }
}

async fn tick(ws: &Arc<Workspace>) -> Result<()> {
    let _gate = ws.jobs.gate.lock().await;
    let Ok(_completion) = ws.admission.enter_completion() else {
        return Ok(());
    };
    // A stop at a checkpoint past its grace period becomes a cancel first.
    if checkpoint::expire(ws).await? {
        changed(ws);
    }
    let active = ws.stored(|s| s.active_jobs()).await?;
    for job in active {
        let evidence = host::observe(&ws.data_dir, &job).await;
        match evidence {
            Ok(Some(value)) => {
                let id = job["id"]
                    .as_str()
                    .context("Missing job identity")?
                    .to_owned();
                // A paused worker still runs as far as systemd is concerned;
                // its cgroup tells whether it is frozen (pause.rs).
                let freezer = (value["status"] == "running").then(|| value["freezer"].clone());
                let (attempt, pause_id) = (job["attempt"].clone(), id.clone());
                if ws
                    .stored(move |s| s.update_job_evidence(&id, value))
                    .await?
                {
                    changed(ws);
                }
                if let Some(freezer) = freezer {
                    if ws
                        .stored(move |s| s.reconcile_job_pause(&pause_id, &attempt, &freezer))
                        .await?
                    {
                        changed(ws);
                    }
                }
            }
            Ok(None) => {}
            Err(error) => {
                let id = job["id"].as_str().unwrap().to_owned();
                let detail = error.to_string();
                if ws.stored(move |s| s.job_unknown(&id, &detail)).await? {
                    changed(ws);
                }
            }
        }
    }
    // Queued work cannot start during Core update drain; running services remain independent.
    let Ok(_work) = ws.admission.enter_work() else {
        return Ok(());
    };
    if ws.stored(|s| s.advance_runs()).await? {
        changed(ws);
    }
    let candidates = ws.stored(|s| s.queued_candidates()).await?;
    if candidates.is_empty() {
        return Ok(());
    }
    if ws.stored(|s| s.gpu_jobs_live()).await? {
        sample_gpus(ws, false).await;
    }
    // Free space where each candidate writes, each path on its own
    // filesystem, read together: the scan binds each verdict to its job.
    let configured = ws.stored(|s| s.job_disk_reserve()).await?;
    let data_dir = ws.data_dir.to_string_lossy().into_owned();
    let cwds: std::collections::BTreeSet<String> = candidates.iter().map(|c| c.1.clone()).collect();
    let mut reads = vec![disk::sample(data_dir.clone(), disk::DATA)];
    reads.extend(cwds.iter().map(|cwd| disk::sample(cwd.clone(), disk::WORKDIR)));
    let samples = futures_util::future::join_all(reads).await;
    let observed = crate::model::now();
    let checks: Vec<DiskCheck> = candidates
        .iter()
        .map(|(id, cwd)| {
            let own: Vec<disk::Sample> = samples
                .iter()
                .filter(|s| s.role == disk::DATA || (s.role == disk::WORKDIR && &s.path == cwd))
                .cloned()
                .collect();
            DiskCheck { job_id: id.clone(), verdict: disk::verdict(&own, configured, &observed) }
        })
        .collect();
    let machine = host::machine_info().await?;
    let available = machine["memoryAvailableMiB"]
        .as_u64()
        .context("Host memory availability is unknown; queue retained")?
        .saturating_sub(machine["hostHeadroomMiB"].as_u64().unwrap_or(2048));
    let (job, reasons) = ws
        .stored(move |s| s.reserve_next(Some(available), Some(machine), Some(&checks)))
        .await?;
    let Some(job) = job else {
        // A changed waiting reason (low disk, a busy GPU) is news for the panel.
        if reasons {
            changed(ws);
        }
        return Ok(());
    };
    changed(ws);
    let id = job["id"].as_str().unwrap().to_owned();
    match host::launch(&ws.data_dir, &job).await {
        Ok(()) => {}
        Err(host::LaunchError::NotStarted(error)) => {
            let reason = not_started_reason(&error);
            ws.stored(move |s| s.job_not_started(&id, &reason)).await?;
            changed(ws);
        }
        Err(host::LaunchError::Unconfirmed(error)) => {
            let reason = format!(
                "Launch acknowledgement unavailable: {error:#}. Reconciliation required; not retried."
            );
            ws.stored(move |s| s.job_unknown(&id, &reason)).await?;
            changed(ws);
        }
    }
    Ok(())
}

/// Sample the GPUs through the helper, at most once per ten seconds unless
/// forced, and keep the result (or its error) for admission and views.
async fn sample_gpus(ws: &Arc<Workspace>, force: bool) {
    {
        let mut last = ws.jobs.gpu_sampled.lock().unwrap();
        if !force && last.is_some_and(|at| at.elapsed() < Duration::from_secs(10)) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    let sample = match host::helper(&ws.data_dir).await {
        Ok(script) => host::invoke(&script, "gpus", None, None)
            .await
            .unwrap_or_else(|error| json!({"error":format!("{error:#}"),"devices":[]})),
        Err(error) => json!({"error":format!("{error:#}"),"devices":[]}),
    };
    if let Err(error) = ws.stored(move |s| s.record_gpu_sample(sample)).await {
        eprintln!("GPU sample not recorded: {error:#}");
    }
}

/// A launch that failed before systemd-run: what happened, and that nothing ran.
fn not_started_reason(error: &anyhow::Error) -> String {
    let full = error
        .chain()
        .filter_map(|e| e.downcast_ref::<std::io::Error>())
        .any(|e| e.raw_os_error() == Some(28));
    format!(
        "Not started: {error:#}.{} No process was created and the reservation is released; submit again with a new requestId to retry.",
        if full { " The disk holding Core's data folder is full." } else { "" }
    )
}

/// What a Job's inputs are, wherever it runs. Remote specifics are in
/// REMOTE_INPUTS and, at length, in the guide's jobs topic.
const INPUTS: &str = "Small files the command reads (at most 2 MiB each, 16 MiB together), relative to cwd: their SHA-256 is \
    frozen at submit and checked again just before the command starts, and a change rejects the job before it runs. This is a check \
    before the start, not a read-only snapshot while it runs. An input missing at submit is recorded as missing.";
const REMOTE_INPUTS: &str = "With machineId they are files on that machine, read there at submit (on windows by its native \
    helper, never through /mnt): one that is missing, unreadable or too large refuses the submit, and nothing of this host is read for them.";
const ARTIFACTS: &str = "Files a clean exit must leave behind, relative to cwd. After exit 0 each must be a regular file inside cwd \
    of at least minBytes (default 1); json must be one complete JSON document, jsonl complete newline-terminated JSON lines. Size and \
    SHA-256 are recorded. Any failure makes the job failed; a non-zero exit, a timeout or a cancel is reported as such, with no artifact \
    check. Structure only: whether the content is valid is the project's call. A file left there earlier passes if it meets the rules \
    (preExisting and unchangedSinceStart record it): for an output only this attempt can have written, give it a path of its own.";
const REMOTE_ARTIFACTS: &str = "With machineId they are checked on that machine by the same rules and stay there: the job \
    records the machine, each file's path there, size and SHA-256, and nothing is copied to this host or offered for download.";
/// machineId in short; how each kind of machine runs a job, holds its limits
/// and checks its files is the guide's jobs topic (references/jobs.md).
const MACHINE: &str = "Run on a registered machine from the Machines list instead of this Core's host: an SSH machine \
    (Linux), or \"windows\", Windows on the PC this Core's WSL runs on (cwd a Windows drive path such as C:\\work). Without machineId \
    the job runs on this Core's host, never on the machine your Agent itself runs on. cwd and every path are on that machine; pass the \
    environment the command needs in env. That machine's own admission (its maxJobs and budget) decides when it starts, and its limit \
    mode whether the declared CPU, RAM and swap are held there or only recorded. Not available with machineId: gpu, exclusive, outputs \
    (declare artifacts), runs of stages, and guardGit (set it to false); pause only where the job's capabilities.pause allows it, never \
    on windows. Cancel and timeouts stop the attempt's process group (on windows its Job Object), not processes that leave it. A lost \
    connection leaves the job unknown with its slot held: Core checks the same attempt again and never starts it twice, so do not \
    resubmit it. How each machine runs, limits and checks a job: yuzuno_guide topic jobs.";

/// checkpoint in short; the guide's jobs topic has the whole protocol.
const CHECKPOINT: &str = "For a command that can save and exit at a safe point when the user asks (Stop at checkpoint), on this \
    Core's host only: not with machineId, not in a run's stages. On the user's stop the attempt's wrapper sends signal to the command \
    itself (not through a shell around it). It saves into $YUZUNO_CHECKPOINT_DIR (new for each attempt), writes manifest.json there \
    last ({\"attempt\": $YUZUNO_JOB_ATTEMPT, \"nonce\": the nonce in the JSON file at $YUZUNO_CHECKPOINT_REQUEST, \"files\": [{\"path\"}]}) \
    and exits stoppedExitCode within graceSeconds. Only then, with Core's own SHA-256 of every file, is it resumable; otherwise it is \
    stopped like a cancel and is not. Resuming is the user's choice: a new attempt of the same command with $YUZUNO_RESUME_FROM set to \
    that manifest. Unlike pause, this frees the job's memory.";

pub(crate) fn tool_definitions() -> Vec<Value> {
    let string = json!({"type":"string"});
    let task_reference = json!({"type":"string","description":crate::collaboration_store::TASK_ID});
    let properties = json!({"requestId":string,"taskId":task_reference,"name":string,"cwd":string,
        "argv":{"type":"array","items":string,"minItems":1,"maxItems":128},
        "env":{"type":"object","additionalProperties":{"type":"string"}},
        "resources":{"type":"object","properties":{"cpuMillis":{"type":"integer","minimum":100},"memoryMiB":{"type":"integer","minimum":64},"swapMiB":{"type":"integer","minimum":0}},"required":["cpuMillis","memoryMiB","swapMiB"],"additionalProperties":false},
        "exclusive":{"type":"boolean","default":false,"description":"Run alone among this Core's managed local jobs. FIFO waits for existing jobs and their process-group cleanup; later jobs remain queued until this reservation releases. Does not stop other applications or reserve the whole host. Request actual CPU/RAM/swap limits as usual."},
        "timeoutSeconds":{"type":"integer","minimum":1,"maximum":604800,"default":86400},
        "guardGit":{"type":"boolean","default":true},"inputs":{"type":"array","items":string,"maxItems":128,"description":INPUTS},"outputs":{"type":"array","items":string,"maxItems":20,"description":"Declared output file paths relative to cwd, available for download from the job panel. Not with machineId: declare artifacts there."}});
    let artifacts = json!({"type":"array","maxItems":20,"description":ARTIFACTS,
        "items":{"type":"object","properties":{"path":string,"format":{"type":"string","enum":["bytes","json","jsonl"],"default":"bytes"},"minBytes":{"type":"integer","minimum":0}},"required":["path"],"additionalProperties":false}});
    let mut properties = properties;
    properties["artifacts"] = artifacts.clone();
    properties["machineId"] = json!({"type":"string","description":MACHINE});
    properties["gpu"] = json!({"type":"object","description":"Local NVIDIA GPUs the command needs, admitted with its CPU and RAM: devices by UUID (any device when omitted), the GPU memory it needs in MiB, and mode exclusive (default: the only managed GPU job on the device) or shared (only on a device the user opened for sharing). The job gets CUDA_VISIBLE_DEVICES set to the reserved UUIDs. It waits, with the device and the shortfall named, while the device is busy, closed to new jobs, short of memory or not freshly sampled. Free memory is the whole card's, other programs included; this is admission, not memory isolation or a compute share.",
        "properties":{"count":{"type":"integer","minimum":1,"maximum":8,"default":1},"devices":{"type":"array","items":{"type":"string"},"maxItems":8},"memoryMiB":{"type":"integer","minimum":64},"mode":{"type":"string","enum":["exclusive","shared"],"default":"exclusive"}},
        "required":["memoryMiB"],"additionalProperties":false});
    properties["checkpoint"] = json!({"type":"object","description":CHECKPOINT,
        "properties":{"signal":{"type":"string","enum":["SIGTERM","SIGINT","SIGUSR1"],"default":"SIGTERM"},
            "graceSeconds":{"type":"integer","minimum":10,"maximum":900},"stoppedExitCode":{"type":"integer","minimum":1,"maximum":125}},
        "required":["graceSeconds","stoppedExitCode"],"additionalProperties":false});
    let mut stage = properties.clone();
    if let Some(map) = stage.as_object_mut() {
        map.remove("requestId");
        map.remove("taskId");
        // A run's stages run on this host in this version.
        map.remove("machineId");
        // A stage's retry repeats its command; it never resumes one.
        map.remove("checkpoint");
    }
    // Only job_submit takes machineId; a run's stages keep the host-only text.
    properties["inputs"]["description"] = format!("{INPUTS} {REMOTE_INPUTS}").into();
    properties["artifacts"]["description"] = format!("{ARTIFACTS} {REMOTE_ARTIFACTS}").into();
    stage["key"] = json!({"type":"string","description":"Stage key, unique in the run: 1-32 letters, digits, '.', '_' or '-'."});
    stage["name"] = json!({"type":"string","description":"Optional; defaults to the run name and stage key."});
    stage["needs"] = json!({"type":"array","items":string,"description":"Keys of earlier stages that must succeed, with their artifacts verified, before this stage starts. Success dependencies only."});
    stage["waitForAnalysis"] = json!({"type":"boolean","default":false,"description":"After success, persist a run gate until its owner Agent or the user explicitly continues or cancels using job_run_decide. The succeeded Job releases all resources. Only dependants wait; independent stages proceed. The final stage also needs a decision. Reused results get a fresh gate. False preserves automatic chaining."});
    stage["retry"] = json!({"type":"object","description":"Automatic retries for outcomes the project declares to be retryable infrastructure failures, never by default. attempts counts every attempt (2-5). exitCodes: the command's exit codes that mean such a failure (for example an API disconnect); interrupted: the host restarted under it. Out-of-memory, timeout, cancellation, unknown outcomes, rejected inputs, failed artifact checks and other exit codes are never retried automatically.",
        "properties":{"attempts":{"type":"integer","minimum":2,"maximum":5},"exitCodes":{"type":"array","items":{"type":"integer","minimum":1,"maximum":255},"maxItems":16},"interrupted":{"type":"boolean","default":false}},"required":["attempts"],"additionalProperties":false});
    stage["reuse"] = json!({"type":"string","description":"Job ID of an earlier succeeded attempt to use instead of running this stage. Accepted only if its command, env, code identity, artifact contract and upstream artifacts equal this stage's and its artifacts verify unchanged now; otherwise the submission is refused with the reason."});
    let stage_required = json!(["key","cwd","argv","resources"]);
    let make = |name: &str, description: &str, p: Value, required: Vec<&str>| json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":p,"required":required,"additionalProperties":false}});
    let run_id = json!({"runId":string});
    vec![
        make("job_submit", "Submit an authorized long-running command on this Core's Linux/WSL host, tied to an existing task and your Agent. Returns a durable Job ID without waiting. Core queues within the shared machine budget; system mailbox reports completion. Ending your Turn does not cancel the job or complete the task. argv/env/resources are captured; optional Git/small-input checks reject changes before launch, not an immutable filesystem snapshot. No automatic rerun. Use a stable requestId for lost-reply retries. Runs as the Core OS user outside the native agent sandbox; submit only user-authorized local work.", properties, vec!["requestId","taskId","name","cwd","argv","resources"]),
        make("job_list", list::DESCRIPTION, list::schema(), vec![]),
        make("job_get", "Read a job's command snapshot, retained evidence and outcome, plus resourceSummary: actual peak memory and average CPU cores versus declared resources. Average cores = worker CPU time / monotonic start-to-exit wall time, including pauses and the wrapper, excluding the collector. Missing/invalid/remote measurements are null, never zero; valid failures can be measured. Unknown is not success; task status is independent.", json!({"jobId":string}), vec!["jobId"]),
        make("job_logs", "Read a bounded log page (32 KiB) from the job's two-MiB disk ring. Omit offset for tail; older overwritten bytes are marked truncated.", json!({"jobId":string,"offset":{"type":"integer","minimum":0}}), vec!["jobId"]),
        make("job_cancel", "Persist cancellation intent for your job. Resources release only after launcher/worker process groups are confirmed stopped; this does not cancel its business task.", json!({"jobId":string}), vec!["jobId"]),
        make("job_run_submit", "Submit a run: a few stages of one experiment on this Core's host, each stage attempt an ordinary local Job in the shared queue and budget. A stage starts only after every stage it needs has exited 0 with its declared artifacts verified, and its worker checks those artifacts are unchanged before the command starts; a failure or cancellation leaves the stages that need it waiting, never started, with the reason visible. Every stage freezes its inputs at submission. Each attempt keeps its own log, evidence and usage file: the command may append JSON lines {\"usd\": number or null, \"source\": \"...\"} to $YUZUNO_JOB_USAGE_FILE (failed attempts count too; null stays unknown) and replace $YUZUNO_JOB_PROGRESS_FILE with small JSON progress. costLimitUsd is a soft limit on recorded cost: no new stage attempt starts beyond it, but calls in flight or unrecorded can exceed it; it is no provider cap. requestId only prevents a duplicate submission; it does not make remote API calls or charges happen exactly once. A waitForAnalysis stage sends one durable gate notification with its Job, attempt and artifact evidence; call job_run_decide after analyzing it. One mail when the run succeeds or its cancellation completes; a stage that ends without success and without a declared retry mails on its own.",
            json!({"requestId":string,"taskId":task_reference,"name":string,
                "experiment":{"type":"string","description":"Optional label grouping runs of one experiment."},
                "costLimitUsd":{"type":"number","exclusiveMinimum":0},
                "stages":{"type":"array","minItems":1,"maxItems":16,"description":"In dependency order: a stage may need only earlier stages.","items":{"type":"object","properties":stage,"required":stage_required,"additionalProperties":false}}}),
            vec!["requestId","taskId","name","stages"]),
        make("job_run_get", "Read a run: each stage's attempts (job IDs, status, reasons, verified artifacts with SHA-256, identity), its upstream, retries and recorded cost across all attempts. Each attempt has resourceSummary (actual peak memory and CPU time / worker monotonic wall time versus declared resources); missing/invalid/remote values are null. Includes worker wrapper and pauses in wall time, excludes collector. Retries stay separate, reused producers do not execute in this run, and memory peaks are not additive. Unknown cost is reported apart, never as zero.", run_id.clone(), vec!["runId"]),
        make("job_run_list", "List runs with their status, stages and recorded cost, newest first, 20 per page; follow nextBefore as before while hasMore. Unlike job_list it does not default to your own Agent: without filters it lists every Agent's runs, so pass agentId, taskId or experiment to narrow it.", json!({"agentId":string,"taskId":task_reference,"experiment":string,"before":{"type":"integer","description":"nextBefore from the previous page; keep the same filters."},"awaitingAnalysis":{"type":"boolean","description":"Only runs with a pending analysis gate, including when independent stages are still running."}}), vec![]),
        make("job_run_decide", "Record your analysis decision for one successful stage. Read job_run_get first and pass its exact gateId and attemptId. Continue releases only the frozen DAG, subject to update drain, budget, Git/input and artifact checks; it neither authorizes additional work nor accepts command changes. Cancel stops the run without changing successful Jobs. Only the owner Agent or user may decide. A stable requestId makes lost-reply retries idempotent; stale gates and cancelled runs cannot be reopened. For changed commands/inputs submit a new run with explicit reuse.", json!({"requestId":string,"runId":string,"stage":string,"gateId":string,"attemptId":string,"decision":{"type":"string","enum":["continue","cancel"]},"reason":{"type":"string","maxLength":4000}}), vec!["requestId","runId","stage","gateId","attemptId","decision"]),
        make("job_run_retry", "Start a new attempt of a stage whose latest attempt failed, was cancelled, rejected or interrupted: the same command and frozen inputs (a changed input rejects it), its own job, log and usage file; earlier attempts and their cost are kept. Stages waiting on it start after it succeeds. An unknown outcome must be cancelled first. Use a stable requestId.", json!({"requestId":string,"runId":string,"stage":string}), vec!["requestId","runId","stage"]),
        make("job_run_cancel", "Cancel your run: stages that have not started never will; running stages are cancelled as any job, their reservation released only when their process groups are gone. Succeeded attempts and their artifacts are kept for an explicit reuse in a new run. Does not cancel the business task.", run_id, vec!["runId"]),
        make("job_budget", "Read this host's shared job budget, reservations, collector overhead and real host availability, plus the free space of the filesystems jobs write to (Core's data folder and each live job's working directory) and the reserve below which no new job starts, and the local NVIDIA GPUs: their latest memory sample, what managed jobs reserve on them and whether each takes new jobs. available remains budget minus reservations. requestCapacity.submission.maxRequest subtracts a new collector from total budget; requestCapacity.snapshot also accounts for active reservations and host RAM/headroom, with observedAt and meetsMinimum (false = no valid request; null = unknown). These local request bounds do not guarantee immediate start: queue, slots, exclusive jobs, GPU and disk can still delay it. CPU quota is not reserved physical cores; the disk reserve is a check before each start, not a quota; GPU figures are the whole card's. windows: whether machineId \"windows\" exists here (available), its attempts at once (activeCount) and their ceiling (maxJobs, the user's setting or defaultMaxJobs), inside this same budget.", json!({}), vec![]),
        make("job_gpu_admission", "Open or close one local GPU (by UUID, from job_budget) to new managed jobs. Closing only stops new admission there; jobs already running or paused on it keep their reservation. Queued jobs that need it wait with this reason. A device the user closed stays closed until the user opens it.", json!({"uuid":string,"open":{"type":"boolean"},"reason":string}), vec!["uuid","open"]),
    ]
}
