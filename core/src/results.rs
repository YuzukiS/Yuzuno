//! Interactive results an Agent publishes with `result_publish` (T-37).
//!
//! The format, its checks and the tool's description are defined once, in
//! web/src/intelligent-ui/contract.ts. Core compiles in the description
//! generated from it (runtimes/result-validator/contract.json), so listing
//! tools needs no Node, and checks a submission by running the generated
//! bundle beside it in one lazily started Node process. Nothing here restates
//! the format. Without Node or the bundle only this tool is unavailable.
//!
//! Who published a result, and in which session and Turn, is what Core
//! records for the authenticated Agent when the call arrives. The Agent's
//! `expectedTurnId` only says which Turn it means: a mismatch is refused,
//! never attached to another Turn. This checks the call against Core's own
//! state; it does not prove which native tool call sent it.
use crate::{model::now, store::Store, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::Instant,
};

pub const TOOL: &str = "result_publish";
/// The read-only tool whose answer is the full guide to `TOOL`.
pub const GUIDE_TOOL: &str = "result_guide";

/// Waiting for the validator, starting it and checking, all together; well
/// under the 30 s Harnesses allow a tool call.
const DEADLINE: Duration = Duration::from_secs(10);
/// Calls queued for the one validator before more are turned away.
const MAX_WAITING: usize = 8;
/// One request line. MCP bodies are at most 128 KiB, so a submission that
/// arrived always fits; the contract's own limit is far below.
const MAX_REQUEST: usize = 192 * 1024;
/// One answer line: the submission with display defaults filled in.
const MAX_ANSWER: u64 = 512 * 1024;
const MAX_BUNDLE: u64 = 4 * 1024 * 1024;
/// A validator unused this long is stopped; the next call starts another.
const IDLE: Duration = Duration::from_secs(300);
const HEAP: &str = "--max-old-space-size=64";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    name: String,
    schema_version: u64,
    limits: Limits,
    capability: String,
    description: String,
    input_schema: Value,
    guide: Guide,
    guide_tool: Value,
    max_description_length: usize,
    validator: BundleFile,
}

/// The full guide in the parts contract.ts joins (joinGuide): Core answers
/// the guide tool by joining the same parts, never by restating them.
#[derive(Deserialize)]
struct Guide {
    header: String,
    usage: String,
    components: Vec<GuidePart>,
    rules: String,
    text: String,
}

#[derive(Deserialize)]
struct GuidePart {
    #[serde(rename = "type")]
    component: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    chains_per_turn: i64,
    versions_per_chain: i64,
    rejected_per_turn: i64,
}

#[derive(Deserialize)]
struct BundleFile {
    file: String,
    sha256: String,
}

fn contract() -> &'static Contract {
    static CONTRACT: OnceLock<Contract> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!("../../runtimes/result-validator/contract.json"))
            .expect("generated result contract")
    })
}

/// The tool as Agents see it; Codex's enabled_tools names the same entry.
pub fn tool_definition() -> Value {
    let contract = contract();
    json!({"name":contract.name,"description":contract.description,"inputSchema":contract.input_schema})
}

/// The guide tool as Agents see it.
pub fn guide_tool_definition() -> Value {
    contract().guide_tool.clone()
}

/// The longest description a supported native client shows whole, in UTF-16
/// code units (Claude Code 2.1.280 cuts the rest); the contract's own value.
pub fn max_description_length() -> usize {
    contract().max_description_length
}

/// The guide tool's answer: the whole guide, or the usage, the named
/// components and the rules. Ok(Err(..)) names what is wrong with the input.
pub fn guide(input: &Value) -> Result<Value, Value> {
    let guide = &contract().guide;
    let known = |name: &str| guide.components.iter().any(|part| part.component == name);
    let not_a_list = || json!({"error":"components is a non-empty list of component names; omit it for the whole guide."});
    let wanted = match input.get("components") {
        None | Some(Value::Null) => None,
        Some(Value::Array(names)) if !names.is_empty() => {
            let Some(names) = names.iter().map(Value::as_str).collect::<Option<Vec<&str>>>() else {
                return Err(not_a_list());
            };
            let unknown: Vec<&str> = names.iter().copied().filter(|name| !known(name)).collect();
            if !unknown.is_empty() {
                return Err(json!({"error":format!(
                    "Unknown component: {}. Components: {}.",
                    unknown.join(", "),
                    guide.components.iter().map(|part| part.component.as_str()).collect::<Vec<_>>().join(", ")
                )}));
            }
            Some(names)
        }
        Some(_) => return Err(not_a_list()),
    };
    let chosen: Vec<&GuidePart> = guide.components.iter()
        .filter(|part| wanted.as_ref().is_none_or(|names| names.contains(&part.component.as_str())))
        .collect();
    let text = if wanted.is_none() {
        guide.text.clone()
    } else {
        let mut lines = vec![guide.header.as_str(), guide.usage.as_str(), "Components:"];
        lines.extend(chosen.iter().map(|part| part.text.as_str()));
        lines.extend(["Rules:", guide.rules.as_str()]);
        lines.join("\n")
    };
    Ok(json!({
        "schemaVersion": contract().schema_version,
        "components": chosen.iter().map(|part| part.component.as_str()).collect::<Vec<_>>(),
        "guide": text,
    }))
}

/// Where a rejection's problems are explained: the guide tool, and the
/// components the problems are in (from their `elements.<key>` paths).
fn guide_hint(problems: &Value, spec: &Value) -> Value {
    let mut components: Vec<&str> = Vec::new();
    for problem in problems.as_array().into_iter().flatten() {
        let key = problem["path"].as_str()
            .and_then(|path| path.strip_prefix("elements."))
            .and_then(|rest| rest.split('.').next());
        let component = key.and_then(|key| spec["elements"][key]["type"].as_str())
            .filter(|component| contract().guide.components.iter().any(|part| part.component == *component));
        if let Some(component) = component.filter(|component| !components.contains(component)) {
            components.push(component);
        }
    }
    json!({"tool":GUIDE_TOOL,"components":components})
}

/// One short paragraph telling an Agent with the Yuzuno MCP that it can show
/// results, generated with the tool's description. Given once per session:
/// Claude's system prompt append, Codex's developer instructions at start.
pub fn capability_notice() -> &'static str {
    &contract().capability
}

/// `thread/start` and `thread/resume` params with the notice, and the
/// working guide's after it (guide::session_notice), in
/// `developerInstructions`, when the Agent has the Yuzuno MCP. The installed
/// app-server (0.162.1) replaces a configured `developer_instructions` with
/// this field rather than adding to it, so the configured value for this cwd
/// comes first; if it cannot be read, nothing is added. Resume sends it too
/// (workspace::ensure composes both): a compaction rebuilds the thread's
/// opening context from its current developer instructions, so a resume
/// without them would lose the notice and the Brief rules
/// (brief_turns::with_hard_rules) at the next compaction.
pub(crate) async fn with_capability_notice(rpc: &crate::rpc::Rpc, cwd: &str, mut params: Value) -> Value {
    if params["config"]["mcp_servers.yuzuno"].is_null() || params.get("developerInstructions").is_some() {
        return params;
    }
    match rpc.request("config/read", json!({"cwd":cwd,"includeLayers":false})).await {
        Ok(read) => {
            let configured = read["config"]["developer_instructions"].as_str();
            params["developerInstructions"] = compose(configured, crate::guide::session_notice()).into();
        }
        Err(error) => eprintln!("Codex config is unreadable; starting without the result notice: {error:#}"),
    }
    params
}

fn compose(configured: Option<&str>, notice: &str) -> String {
    match configured.map(str::trim_end).filter(|text| !text.trim().is_empty()) {
        Some(configured) => format!("{configured}\n\n{notice}"),
        None => notice.to_owned(),
    }
}

/// The bundle this Core runs. A managed release names its own copy, or none
/// (`YUZUNO_RESULT_VALIDATOR` empty): it never falls back to a checkout. A
/// development build uses the one in its source tree, like the Claude bridge.
fn bundle_path() -> Option<PathBuf> {
    resolve(std::env::var_os("YUZUNO_RESULT_VALIDATOR"))
}

fn resolve(configured: Option<std::ffi::OsString>) -> Option<PathBuf> {
    crate::runtime_paths::resolve(configured, &format!("result-validator/{}", contract().validator.file))
}

const RELEASE_FILE: &str = "runtimes/result-validator/validator.mjs";

/// `YUZUNO_RESULT_VALIDATOR` for a managed release: its own verified copy,
/// or empty when it has none (an older release), which only leaves
/// result_publish without a validator.
pub fn release_validator(release: &crate::updates::package::Bundle) -> PathBuf {
    if release.manifest.files.contains_key(RELEASE_FILE) {
        release.path.join(RELEASE_FILE)
    } else {
        PathBuf::new()
    }
}

/// What the validator said about one submission.
pub(crate) enum Checked {
    Accepted { spec: Value, defaults: Value, schema_version: u64 },
    Rejected { problems: Value },
    Answers { text: String },
}

/// One stateless Node process per Core, started on first use. A failure,
/// a timeout or a confused answer stops it; the next call starts another.
pub struct Validator {
    process: tokio::sync::Mutex<Option<Process>>,
    waiting: AtomicUsize,
    uses: AtomicU64,
    bundle: Option<PathBuf>,
    node: String,
}

struct Process {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    sent: u64,
}

struct Waiting<'a>(&'a AtomicUsize);
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Validator {
    pub fn from_env() -> Self {
        Self::new(bundle_path(), std::env::var("YUZUNO_NODE").unwrap_or_else(|_| "node".into()))
    }

    pub(crate) fn new(bundle: Option<PathBuf>, node: String) -> Self {
        Self {
            process: tokio::sync::Mutex::new(None),
            waiting: AtomicUsize::new(0),
            uses: AtomicU64::new(0),
            bundle,
            node,
        }
    }

    /// Err says why the validator could not answer: never the Agent's fault.
    pub(crate) async fn check(self: &Arc<Self>, spec: &Value) -> Result<Checked, String> {
        self.check_request(spec, None).await
    }

    pub(crate) async fn check_answers(self: &Arc<Self>, spec: &Value, answer: &Value) -> Result<String> {
        match self.check_request(spec, Some(answer)).await.map_err(anyhow::Error::msg)? {
            Checked::Answers { text } => Ok(text),
            Checked::Rejected { problems } => bail!("Invalid form answers: {problems}"),
            _ => bail!("The validator did not check these form answers"),
        }
    }

    async fn check_request(self: &Arc<Self>, spec: &Value, clarification: Option<&Value>) -> Result<Checked, String> {
        let deadline = Instant::now() + DEADLINE;
        let queued = Waiting(&self.waiting);
        if self.waiting.fetch_add(1, Ordering::SeqCst) >= MAX_WAITING {
            return Err("too many results are waiting to be checked".into());
        }
        let Ok(mut process) = tokio::time::timeout_at(deadline, self.process.lock()).await else {
            return Err("other results took too long to check".into());
        };
        drop(queued);
        let answer = match tokio::time::timeout_at(deadline, exchange(&mut process, self, spec, clarification)).await {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(error)) => Err(format!("{error:#}")),
            Err(_) => Err(format!("no answer within {} s", DEADLINE.as_secs())),
        };
        if answer.is_err() {
            // Its state is unknown: stop it (kill_on_drop) rather than reuse it.
            *process = None;
        }
        drop(process);
        self.stop_when_idle();
        answer
    }

    fn stop_when_idle(self: &Arc<Self>) {
        let used = self.uses.fetch_add(1, Ordering::SeqCst) + 1;
        let validator = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(IDLE).await;
            let Some(validator) = validator.upgrade() else { return };
            if validator.uses.load(Ordering::SeqCst) == used {
                if let Ok(mut process) = validator.process.try_lock() {
                    *process = None;
                }
            }
        });
    }

    async fn start(&self) -> Result<Process> {
        let path = self.bundle.as_ref().context("this Core release has no result validator")?;
        let size = tokio::fs::metadata(path)
            .await
            .with_context(|| format!("cannot read {}", path.display()))?
            .len();
        ensure!(size <= MAX_BUNDLE, "the result validator is too large");
        let bundle = tokio::fs::read(path).await?;
        ensure!(
            format!("{:x}", Sha256::digest(&bundle)) == contract().validator.sha256,
            "{} is not the validator this Core was built with",
            path.display()
        );
        let mut child = Command::new(&self.node)
            .arg(HEAP)
            .arg(path)
            // The host's options must not load other code into it.
            .env_remove("NODE_OPTIONS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("cannot start Node ({}) for the result validator", self.node))?;
        let input = child.stdin.take().context("validator input unavailable")?;
        let output = BufReader::new(child.stdout.take().context("validator output unavailable")?);
        Ok(Process { child, input, output, sent: 0 })
    }
}

async fn exchange(slot: &mut Option<Process>, validator: &Validator, spec: &Value, clarification: Option<&Value>) -> Result<Checked> {
    if let Some(process) = slot {
        if process.child.try_wait()?.is_some() {
            *slot = None;
        }
    }
    if slot.is_none() {
        *slot = Some(validator.start().await?);
    }
    let process = slot.as_mut().unwrap();
    process.sent += 1;
    let id = process.sent;
    let mut request = serde_json::to_vec(&json!({"id":id,"spec":spec,"clarification":clarification}))?;
    ensure!(request.len() <= MAX_REQUEST, "the result is too large to check");
    request.push(b'\n');
    process.input.write_all(&request).await?;
    process.input.flush().await?;
    let mut line = Vec::new();
    (&mut process.output).take(MAX_ANSWER).read_until(b'\n', &mut line).await?;
    ensure!(line.ends_with(b"\n"), "the validator stopped, or its answer was too large");
    let mut answer: Value = serde_json::from_slice(&line).context("unreadable validator answer")?;
    ensure!(answer["id"] == id, "the validator answered another request");
    if let Some(error) = answer.get("error") {
        bail!("the validator failed: {error}");
    }
    ensure!(
        answer["schemaVersion"] == contract().schema_version,
        "the validator speaks another schema version"
    );
    match answer["ok"].as_bool() {
        Some(true) if clarification.is_some() && answer["text"].as_str().is_some_and(|s| s.len() <= 100_000) =>
            Ok(Checked::Answers { text: answer["text"].as_str().unwrap().into() }),
        Some(true) if answer["spec"].is_object() && answer["defaults"].is_array() => Ok(Checked::Accepted {
            spec: answer["spec"].take(),
            defaults: answer["defaults"].take(),
            schema_version: contract().schema_version,
        }),
        Some(false) if answer["problems"].as_array().is_some_and(|p| !p.is_empty()) => {
            Ok(Checked::Rejected { problems: answer["problems"].take() })
        }
        _ => bail!("unreadable validator answer"),
    }
}

impl Validator {
    /// One Project Brief section `put`, without its op (see project_brief):
    /// Ok(Ok(normalized)) or Ok(Err(problems)) for the Agent to fix. Err
    /// says why the validator could not answer, as for `check`.
    /// Only block edits supply previous_body, read from the stored row at
    /// the guarded Brief version; attachment registrations cannot change.
    pub(crate) async fn check_brief_section(self: &Arc<Self>, section: &Value, previous_body: Option<&Value>) -> Result<Result<Value, Value>, String> {
        let deadline = Instant::now() + DEADLINE;
        let queued = Waiting(&self.waiting);
        if self.waiting.fetch_add(1, Ordering::SeqCst) >= MAX_WAITING {
            return Err("too many sections are waiting to be checked".into());
        }
        let Ok(mut process) = tokio::time::timeout_at(deadline, self.process.lock()).await else {
            return Err("other checks took too long".into());
        };
        drop(queued);
        let mut request = json!({"op":"briefSection","section":section});
        if let Some(body) = previous_body {
            request["previousBody"] = body.clone();
        }
        let answer = match tokio::time::timeout_at(deadline, exchange_value(&mut process, self, request)).await {
            Ok(Ok(mut answer)) => match answer["ok"].as_bool() {
                _ if answer["schemaVersion"].as_u64() != crate::project_brief::brief_schema_version() => {
                    Err("the validator speaks another Brief schema version".to_owned())
                }
                Some(true) if answer["normalized"].is_object() => Ok(Ok(answer["normalized"].take())),
                Some(false) if answer["problems"].as_array().is_some_and(|p| !p.is_empty()) => Ok(Err(answer["problems"].take())),
                _ => Err("unreadable validator answer".to_owned()),
            },
            Ok(Err(error)) => Err(format!("{error:#}")),
            Err(_) => Err(format!("no answer within {} s", DEADLINE.as_secs())),
        };
        if answer.is_err() {
            *process = None;
        }
        drop(process);
        self.stop_when_idle();
        answer
    }
}

/// One request line with an `op`, and its answer as sent.
async fn exchange_value(slot: &mut Option<Process>, validator: &Validator, mut request: Value) -> Result<Value> {
    if let Some(process) = slot {
        if process.child.try_wait()?.is_some() {
            *slot = None;
        }
    }
    if slot.is_none() {
        *slot = Some(validator.start().await?);
    }
    let process = slot.as_mut().unwrap();
    process.sent += 1;
    let id = process.sent;
    request["id"] = json!(id);
    let mut line = serde_json::to_vec(&request)?;
    ensure!(line.len() <= MAX_REQUEST, "the request is too large to check");
    line.push(b'\n');
    process.input.write_all(&line).await?;
    process.input.flush().await?;
    let mut answer = Vec::new();
    (&mut process.output).take(MAX_ANSWER).read_until(b'\n', &mut answer).await?;
    ensure!(answer.ends_with(b"\n"), "the validator stopped, or its answer was too large");
    let answer: Value = serde_json::from_slice(&answer).context("unreadable validator answer")?;
    ensure!(answer["id"] == id, "the validator answered another request");
    if let Some(error) = answer.get("error") {
        bail!("the validator failed: {error}");
    }
    Ok(answer)
}

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    // One row per accepted version. A chain is named by its first version;
    // UNIQUE(chain_id, version) keeps a chain from ever forking.
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS interactive_results(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        chain_id TEXT NOT NULL, version INTEGER NOT NULL,
        agent_id TEXT NOT NULL, session_id TEXT, turn_id TEXT NOT NULL,
        request_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
        spec_json TEXT NOT NULL, defaults_json TEXT NOT NULL, raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(chain_id, version));
        CREATE INDEX IF NOT EXISTS interactive_results_agent ON interactive_results(agent_id, turn_id, seq);
        CREATE TABLE IF NOT EXISTS interactive_result_rejections(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, session_id TEXT,
        turn_id TEXT NOT NULL, request_id TEXT NOT NULL, problems_json TEXT NOT NULL,
        created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS interactive_result_rejections_turn
        ON interactive_result_rejections(agent_id, turn_id);",
    )?;
    crate::task_proposals::migrate(db)

}

pub(crate) fn delete_agent(db: &Connection, id: &str) -> Result<()> {
    crate::task_proposals::delete_agent(db, id)?;
    db.execute("DELETE FROM interactive_results WHERE agent_id=?1", [id])?;
    db.execute("DELETE FROM interactive_result_rejections WHERE agent_id=?1", [id])?;
    Ok(())
}

/// A running Turn as Core records it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Pinned {
    agent: String,
    session: Option<String>,
    pub(crate) turn: String,
}

impl Pinned {
    /// The native session the Turn runs in, as Core records it.
    pub(crate) fn session(&self) -> Option<&str> {
        self.session.as_deref()
    }
}

/// The Agent's running Turn, when Core can vouch for it: connected, working,
/// with a Turn in progress whose owner is known. None while it is offline,
/// disconnected or its execution unconfirmed (after a restart, a lost
/// connection, a reconnect), and while that Turn is output Claude has not
/// yet said is its own: a result is never pinned to a guess.
pub(crate) fn reliable_turn(store: &Store, db: &Connection, agent: &str) -> Result<Option<Pinned>> {
    let Some(brief) = store.brief_in(db, agent)? else { return Ok(None) };
    let a = &brief.agent;
    if a.closed_at.is_some()
        || a.connection_state != "connected"
        || !matches!(a.status.as_str(), "working" | "waiting")
        || brief.active_turn_unmatched
    {
        return Ok(None);
    }
    let Some(turn) = brief.active_turn else { return Ok(None) };
    let session = match a.harness.as_str() {
        "claude" => a.claude_session_id.clone(),
        "opencode" => a.opencode_session_id.clone(),
        _ => a.thread_id.clone(),
    };
    Ok(Some(Pinned { agent: agent.into(), session, turn }))
}

struct Request {
    id: String,
    expected_turn: String,
    revises: Option<String>,
}

fn text(input: &Value, field: &str, max: usize) -> Result<String> {
    let value = input[field].as_str().filter(|s| !s.is_empty() && s.len() <= max);
    Ok(value.with_context(|| format!("invalid_input: {field} must be a string of 1-{max} bytes"))?.into())
}

fn parse(input: &Value) -> Result<Request> {
    let object = input.as_object().context("invalid_input: expected an object")?;
    if let Some(key) = object
        .keys()
        .find(|key| !matches!(key.as_str(), "requestId" | "expectedTurnId" | "spec" | "revisesResultId"))
    {
        bail!("invalid_input: unknown argument {key}");
    }
    ensure!(object.contains_key("spec"), "invalid_input: spec is required");
    let revises = match &input["revisesResultId"] {
        Value::Null => None,
        Value::String(id) if !id.is_empty() && id.len() <= 200 => Some(id.clone()),
        _ => bail!("invalid_input: revisesResultId must be a resultId or null"),
    };
    Ok(Request { id: text(input, "requestId", 128)?, expected_turn: text(input, "expectedTurnId", 200)?, revises })
}

/// The first answer to this requestId, if there was one. Ok is an accepted
/// result, Err a rejection; both are replayed exactly as first given.
fn receipt(db: &Connection, actor: &str, id: &str, input: &Value) -> Result<Option<Result<Value, Value>>> {
    let previous: Option<(String, String)> = db
        .query_row(
            "SELECT input_json,response_json FROM collaboration_requests WHERE actor=?1 AND operation=?2 AND request_id=?3",
            params![format!("agent:{actor}"), TOOL, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((payload, response)) = previous else { return Ok(None) };
    ensure!(
        serde_json::from_str::<Value>(&payload)? == *input,
        "idempotency_conflict: requestId already has a different payload"
    );
    let response: Value = serde_json::from_str(&response)?;
    Ok(Some(if response["accepted"] == true { Ok(response) } else { Err(response) }))
}

fn pin(store: &Store, db: &Connection, actor: &str, request: &Request) -> Result<Pinned> {
    let turn = reliable_turn(store, db, actor)?.context(
        "no_active_turn: Core has no confirmed running Turn for you, so nothing can be shown; answer in text",
    )?;
    ensure!(
        turn.turn == request.expected_turn,
        "stale_turn: expectedTurnId is not your current Turn; a result is never moved to another Turn. \
         To show it in your current Turn, read peers_list again and publish it anew"
    );
    Ok(turn)
}

fn count(db: &Connection, sql: &str, turn: &Pinned) -> Result<i64> {
    Ok(db.query_row(sql, params![turn.agent, turn.turn], |r| r.get(0))?)
}

fn rejections(db: &Connection, turn: &Pinned) -> Result<i64> {
    count(db, "SELECT COUNT(*) FROM interactive_result_rejections WHERE agent_id=?1 AND turn_id=?2", turn)
}

/// Limits that do not depend on the result itself; checked before and again
/// when it is stored. Neither counts as a rejection.
fn within_limits(db: &Connection, turn: &Pinned, request: &Request) -> Result<()> {
    let limits = &contract().limits;
    ensure!(
        rejections(db, turn)? < limits.rejected_per_turn,
        "attempts_exhausted: {} results were rejected in this Turn; answer in text",
        limits.rejected_per_turn
    );
    if request.revises.is_none() {
        ensure!(
            count(db, "SELECT COUNT(*) FROM interactive_results WHERE agent_id=?1 AND turn_id=?2 AND version=1", turn)?
                < limits.chains_per_turn,
            "result_limit: this Turn already has {} results; revise one or answer in text",
            limits.chains_per_turn
        );
    }
    Ok(())
}

/// The chain and version a revision extends (None for a new result), or,
/// as Err, why revisesResultId cannot be revised: a problem the Agent can
/// fix, counted as a rejection.
fn revision(db: &Connection, turn: &Pinned, request: &Request) -> Result<Result<Option<(String, i64)>, Value>> {
    let Some(target) = &request.revises else { return Ok(Ok(None)) };
    let problem = |reason: String| Ok(Err(json!({"code":"invalid_revision","path":"revisesResultId","reason":reason})));
    let row: Option<(String, Option<String>, String, String)> = db
        .query_row(
            "SELECT agent_id,session_id,turn_id,chain_id FROM interactive_results WHERE id=?1",
            [target],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((_, session, turn_id, chain)) = row.filter(|(agent, ..)| *agent == turn.agent) else {
        return problem("You have published no result with this resultId.".into());
    };
    if session != turn.session || turn_id != turn.turn {
        return problem("Only a result published in this Turn can be revised; publish a new one instead.".into());
    }
    let (latest, version): (String, i64) = db.query_row(
        "SELECT id,version FROM interactive_results WHERE chain_id=?1 ORDER BY version DESC LIMIT 1",
        [&chain],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if latest != *target {
        return problem(format!("This is not the latest version of the result; revise {latest}."));
    }
    let limit = contract().limits.versions_per_chain;
    ensure!(
        version < limit,
        "result_limit: this result already has {limit} versions; publish a new one or answer in text"
    );
    Ok(Ok(Some((chain, version + 1))))
}

enum Start {
    Replay(Result<Value, Value>),
    Check(Pinned, Option<Value>),
}

impl Workspace {
    /// `result_publish` for the authenticated Agent `actor`. Ok(Err(..)) is a
    /// rejection the Agent can fix; Err covers everything that is not its
    /// result's fault (no Turn, a changed Turn, limits, an unavailable
    /// validator), none of which is counted.
    pub async fn result_publish(self: &Arc<Self>, actor: &str, input: Value) -> Result<Result<Value, Value>> {
        let permit = self.admission.enter_completion()?;
        let (ws, actor) = (self.clone(), actor.to_owned());
        // MCP requests can be dropped mid-call. The result, its receipt and
        // its announcement still complete together.
        tokio::spawn(async move {
            let _permit = permit;
            let validator = ws.results.clone();
            publish(&ws, &validator, &actor, input).await
        })
        .await?
    }
}

pub(crate) async fn publish(
    ws: &Arc<Workspace>,
    validator: &Arc<Validator>,
    actor: &str,
    input: Value,
) -> Result<Result<Value, Value>> {
    let id = text(&input, "requestId", 128)?;
    let (store, who, payload, key) = (ws.store.clone(), actor.to_owned(), input.clone(), id.clone());
    // A receipt answers before anything about the Turn, the validator or
    // the counts: a retry gets its first answer, even after the Turn ended.
    let start = crate::db::blocking(move || {
        let db = store.db.read()?;
        if let Some(answer) = receipt(&db, &who, &key, &payload)? {
            return Ok(Start::Replay(answer));
        }
        let request = parse(&payload)?;
        let turn = pin(&store, &db, &who, &request)?;
        within_limits(&db, &turn, &request)?;
        Ok(Start::Check(turn.clone(), revision(&db, &turn, &request)?.err()))
    })
    .await?;
    let (turn, revision_problem) = match start {
        Start::Replay(answer) => return Ok(answer),
        Start::Check(turn, problem) => (turn, problem),
    };
    // Checked outside any database lock.
    let checked = match revision_problem {
        Some(problem) => Checked::Rejected { problems: json!([problem]) },
        None => validator.check(&input["spec"]).await.map_err(|reason| {
            anyhow::anyhow!(
                "validator_unavailable: {reason}. Not counted as a rejection; answer in text, or try again later"
            )
        })?,
    };
    let (store, who) = (ws.store.clone(), actor.to_owned());
    let answer = crate::db::blocking(move || {
        let mut writer = store.db.write()?;
        let tx = writer.transaction()?;
        // The same requestId may have finished meanwhile.
        if let Some(answer) = receipt(&tx, &who, &id, &input)? {
            return Ok((answer, false));
        }
        let request = parse(&input)?;
        let now = reliable_turn(&store, &tx, &who)?;
        ensure!(
            now.as_ref() == Some(&turn),
            "stale_turn: your Turn ended or changed while the result was checked; it was not shown"
        );
        within_limits(&tx, &turn, &request)?;
        let answer = match (revision(&tx, &turn, &request)?, checked) {
            (Err(problem), _) => reject(&tx, &turn, &request, json!([problem]), &input["spec"])?,
            (Ok(_), Checked::Rejected { problems }) => reject(&tx, &turn, &request, problems, &input["spec"])?,
            (Ok(extends), Checked::Accepted { spec, defaults, schema_version }) => {
                // A proposed task change names a task only Core can look up.
                match crate::task_proposals::publish_problems(&tx, &spec)? {
                    Some(problems) => reject(&tx, &turn, &request, problems, &input["spec"])?,
                    None => accept(&tx, &turn, &request, extends, spec, defaults, schema_version, &input["spec"])?,
                }
            }
            (_, Checked::Answers { .. }) => bail!("The validator answered another operation"),
        };
        let stored = match &answer { Ok(value) | Err(value) => value.to_string() };
        tx.execute(
            "INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,?2,?3,?4,?5)",
            params![format!("agent:{who}"), TOOL, request.id, input.to_string(), stored],
        )?;
        tx.commit()?;
        Ok((answer, true))
    })
    .await?;
    let (answer, changed) = answer;
    if changed && answer.is_ok() {
        let _ = ws.changes.send(json!({"agentId":actor}));
    }
    Ok(answer)
}

fn reject(db: &Connection, turn: &Pinned, request: &Request, problems: Value, spec: &Value) -> Result<Result<Value, Value>> {
    db.execute(
        "INSERT INTO interactive_result_rejections(agent_id,session_id,turn_id,request_id,problems_json,created_at)
         VALUES(?1,?2,?3,?4,?5,?6)",
        params![turn.agent, turn.session, turn.turn, request.id, problems.to_string(), now()],
    )?;
    let left = (contract().limits.rejected_per_turn - rejections(db, turn)?).max(0);
    let error = if left > 0 {
        "result_rejected: nothing was shown. Fix these problems and call again with a new requestId; result_guide has every component's exact props and rules"
    } else {
        "result_rejected: nothing was shown and no attempts are left in this Turn; answer in text"
    };
    let guide = guide_hint(&problems, spec);
    Ok(Err(json!({"accepted":false,"error":error,"problems":problems,"rejectionsLeft":left,
        "guide":guide,"schemaVersion":contract().schema_version})))
}

#[allow(clippy::too_many_arguments)]
fn accept(
    db: &Connection,
    turn: &Pinned,
    request: &Request,
    extends: Option<(String, i64)>,
    spec: Value,
    defaults: Value,
    schema_version: u64,
    raw: &Value,
) -> Result<Result<Value, Value>> {
    let id = uuid::Uuid::new_v4().to_string();
    let (chain, version) = extends.unwrap_or_else(|| (id.clone(), 1));
    db.execute(
        "INSERT INTO interactive_results(id,chain_id,version,agent_id,session_id,turn_id,request_id,
         schema_version,spec_json,defaults_json,raw_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            id, chain, version, turn.agent, turn.session, turn.turn, request.id,
            schema_version as i64, spec.to_string(), defaults.to_string(), raw.to_string(), now()
        ],
    )?;
    Ok(Ok(json!({"accepted":true,"resultId":id,"chainId":chain,"version":version,"turnId":turn.turn,
        "schemaVersion":schema_version,"defaultsApplied":defaults,
        "shown":"Displayed to the user at the end of this Turn, below your reply. Do not repeat it in your reply."})))
}

/// Each Turn's results, the latest version of each in publication order,
/// on the Turns of a detail sent to clients.
pub(crate) fn attach(db: &Connection, detail: &mut crate::model::AgentDetail) -> Result<()> {
    let mut query = db.prepare(
        "SELECT id,chain_id,version,turn_id,created_at FROM interactive_results WHERE agent_id=?1 ORDER BY seq",
    )?;
    let rows = query.query_map([&detail.agent.id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))
    })?;
    let mut turns: HashMap<String, Vec<Value>> = HashMap::new();
    for row in rows {
        let (id, chain, version, turn, at) = row?;
        let shown = json!({"id":id,"chainId":chain,"version":version,"createdAt":at});
        let list = turns.entry(turn).or_default();
        match list.iter_mut().find(|entry| entry["chainId"] == chain) {
            Some(entry) => *entry = shown,
            None => list.push(shown),
        }
    }
    if turns.is_empty() {
        return Ok(());
    }
    for turn in &mut detail.turns {
        if let Some(list) = turn["id"].as_str().and_then(|id| turns.remove(id)) {
            turn["_yuzunoResults"] = json!(list);
        }
    }
    Ok(())
}

/// One accepted version, as validated and stored; never checked again.
pub(crate) fn get(db: &Connection, agent: &str, id: &str) -> Result<Option<Value>> {
    let row: Option<(String, i64, String, i64, String, String, String)> = db
        .query_row(
            "SELECT chain_id,version,turn_id,schema_version,spec_json,defaults_json,created_at
             FROM interactive_results WHERE id=?1 AND agent_id=?2",
            [id, agent],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?;
    let Some((chain, version, turn, schema_version, spec, defaults, at)) = row else { return Ok(None) };
    Ok(Some(json!({"id":id,"agentId":agent,"chainId":chain,"version":version,"turnId":turn,
        "schemaVersion":schema_version,"spec":serde_json::from_str::<Value>(&spec)?,
        "defaults":serde_json::from_str::<Value>(&defaults)?,"createdAt":at})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AgentDetail;
    use std::os::unix::fs::PermissionsExt;

    fn node() -> String {
        std::env::var("YUZUNO_NODE").unwrap_or_else(|_| "node".into())
    }

    fn validator() -> Arc<Validator> {
        Arc::new(Validator::new(bundle_path(), node()))
    }

    fn agent(id: &str) -> AgentDetail {
        serde_json::from_value(json!({"agent":{"id":id,"name":id,"cwd":"/tmp","model":"test","color":"sage",
            "threadId":format!("session-{id}"),"status":"idle","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]}))
        .unwrap()
    }

    fn fixture() -> (tempfile::TempDir, Arc<Workspace>) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused-harness".into()).unwrap();
        for id in ["a", "b"] {
            ws.store.insert(&agent(id)).unwrap();
            running(&ws, id, "t1");
        }
        (dir, ws)
    }

    /// Connected and working on `turn`, every earlier Turn completed.
    fn running(ws: &Workspace, id: &str, turn: &str) {
        ws.store
            .update(id, "test/running", &json!({}), |d| {
                for t in &mut d.turns {
                    t["status"] = json!("completed");
                }
                d.turns.push(json!({"id":turn,"status":"inProgress","items":[]}));
                d.agent.status = "working".into();
                d.agent.connection_state = "connected".into();
            })
            .unwrap();
    }

    fn idle(ws: &Workspace, id: &str) {
        ws.store
            .update(id, "test/idle", &json!({}), |d| {
                for t in &mut d.turns {
                    t["status"] = json!("completed");
                }
                d.agent.status = "idle".into();
            })
            .unwrap();
    }

    fn spec(title: Option<&str>) -> Value {
        let mut table = json!({"id":"options","columns":[{"key":"name","label":"Name"}],"rows":[{"id":"r1","cells":{"name":"Rows"}}]});
        if let Some(title) = title {
            table["title"] = json!(title);
        }
        json!({"root":"result","elements":{
            "result":{"type":"Result","props":{"title":"Options","summary":"One option."},"children":["table"]},
            "table":{"type":"Table","props":table}}})
    }

    fn invalid() -> Value {
        json!({"root":"result","elements":{"result":{"type":"Html","props":{"html":"<b>no</b>"}}}})
    }

    fn input(request: &str, turn: &str, spec: Value) -> Value {
        json!({"requestId":request,"expectedTurnId":turn,"spec":spec})
    }

    fn revise(request: &str, turn: &str, spec: Value, of: &Value) -> Value {
        json!({"requestId":request,"expectedTurnId":turn,"spec":spec,"revisesResultId":of})
    }

    fn rows(ws: &Workspace, table: &str) -> i64 {
        ws.store.db.read().unwrap().query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
    }

    fn receipts(ws: &Workspace) -> i64 {
        ws.store
            .db
            .read()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM collaboration_requests WHERE operation=?1", [TOOL], |r| r.get(0))
            .unwrap()
    }

    async fn publish_as(ws: &Arc<Workspace>, actor: &str, input: Value) -> Result<Result<Value, Value>> {
        publish(ws, &validator(), actor, input).await
    }

    fn code(error: anyhow::Error) -> String {
        error.to_string().split(':').next().unwrap().to_owned()
    }

    #[test]
    fn the_notice_follows_configured_developer_instructions_and_stands_alone_otherwise() {
        let notice = capability_notice();
        assert!(notice.contains(TOOL) && notice.len() < 500);
        assert_eq!(compose(None, notice), notice);
        assert_eq!(compose(Some("  \n"), notice), notice);
        assert_eq!(compose(Some("Keep replies short.\n"), notice), format!("Keep replies short.\n\n{notice}"));
    }

    #[test]
    fn the_listed_tool_is_the_generated_contract_and_names_no_identity() {
        let tools = crate::collaboration_store::tool_definitions();
        let tool = tools.iter().find(|t| t["name"] == TOOL).expect("listed with the other tools");
        assert_eq!(tool, &tool_definition());
        let schema = &tool["inputSchema"];
        assert_eq!(schema["required"], json!(["requestId", "expectedTurnId", "spec"]));
        assert_eq!(schema["additionalProperties"], false);
        let properties: Vec<_> = schema["properties"].as_object().unwrap().keys().cloned().collect();
        for key in &properties {
            assert!(!key.contains("agent") && !key.contains("session") && key != "turnId", "{key}");
        }
        assert!(tool["description"].as_str().unwrap().contains("plain text"));
        // Codex is granted exactly the listed catalog.
        let rmcp_tool: rmcp::model::Tool = serde_json::from_value(tool.clone()).unwrap();
        assert_eq!(rmcp_tool.name, TOOL);
    }

    #[test]
    fn the_guide_tool_joins_the_contracts_parts_whole_or_for_some_components() {
        let tools = crate::collaboration_store::tool_definitions();
        let listed = tools.iter().find(|t| t["name"] == GUIDE_TOOL).expect("listed with the other tools");
        assert_eq!(listed, &guide_tool_definition());
        let rmcp_tool: rmcp::model::Tool = serde_json::from_value(listed.clone()).unwrap();
        assert_eq!(rmcp_tool.name, GUIDE_TOOL);
        let whole = guide(&json!({})).unwrap();
        assert_eq!(whole["guide"], contract().guide.text);
        assert_eq!(whole["schemaVersion"], contract().schema_version);
        let all: Vec<&str> = contract().guide.components.iter().map(|part| part.component.as_str()).collect();
        assert_eq!(whole["components"], json!(all));
        let text = whole["guide"].as_str().unwrap();
        for needed in ["- Table {", "- BarChart {", "- Sources {", "- Continue {", "- Clarification {", "- TaskStatus {",
            "at most one Continue, Clarification or TaskStatus", "does not authorize any action or permission request",
            "TaskStatus is available through result_publish"] {
            assert!(text.contains(needed), "{needed}");
        }
        assert_eq!(guide(&json!({"components":null})).unwrap(), whole);
        // Some components: the usage and rules stay, in catalog order.
        let some = guide(&json!({"components":["Continue","Table"]})).unwrap();
        assert_eq!(some["components"], json!(["Table","Continue"]));
        let text = some["guide"].as_str().unwrap();
        assert!(text.contains("- Table {") && text.contains("- Continue {") && !text.contains("- BarChart {"));
        assert!(text.contains(&contract().guide.rules) && text.contains(&contract().guide.usage));
        let unknown = guide(&json!({"components":["Chart"]})).unwrap_err();
        assert!(unknown["error"].as_str().unwrap().contains("Unknown component: Chart. Components: Clarification"), "{unknown}");
        // Anything but a list of names says what components must be.
        for bad in [json!({"components":[]}), json!({"components":"Table"}), json!({"components":[1]}),
            json!({"components":["Table", 1]})] {
            let error = guide(&bad).unwrap_err();
            assert!(error["error"].as_str().unwrap().contains("list of component names"), "{bad}: {error}");
        }
    }

    #[test]
    fn every_listed_description_fits_the_shortest_supported_client() {
        let limit = max_description_length();
        assert_eq!(limit, 2048, "Claude Code 2.1.280 keeps 2048 UTF-16 code units");
        for tool in crate::collaboration_store::tool_definitions() {
            let length = tool["description"].as_str().unwrap().encode_utf16().count();
            assert!(length <= limit, "{}: {length}", tool["name"]);
        }
        assert!(capability_notice().encode_utf16().count() <= limit);
        let entry = tool_definition()["description"].as_str().unwrap().to_owned();
        assert!(entry.find(GUIDE_TOOL).is_some_and(|at| at < 256), "the entry names the guide in its first sentences");
        // The full guide does not fit: it is a tool answer, never a description.
        assert!(contract().guide.text.encode_utf16().count() > limit);
    }

    #[tokio::test]
    async fn a_rejection_names_the_guide_and_the_components_its_problems_are_in() {
        let (_dir, ws) = fixture();
        let mut mismatched = spec(Some("Options"));
        mismatched["elements"]["table"]["props"]["rows"][0]["cells"] = json!({"other":"x"});
        let rejected = publish_as(&ws, "a", input("bad-table", "t1", mismatched)).await.unwrap().unwrap_err();
        assert_eq!(rejected["problems"][0]["code"], "row_mismatch");
        assert_eq!(rejected["guide"], json!({"tool":GUIDE_TOOL,"components":["Table"]}));
        assert!(rejected["error"].as_str().unwrap().contains(GUIDE_TOOL));
        // An unknown type is in no component's guide; the guide is still named.
        let unknown = publish_as(&ws, "a", input("bad-type", "t1", invalid())).await.unwrap().unwrap_err();
        assert_eq!(unknown["guide"], json!({"tool":GUIDE_TOOL,"components":[]}));
        // The last attempt says to answer in text, and still names the guide.
        let last = publish_as(&ws, "a", input("bad-3", "t1", invalid())).await.unwrap().unwrap_err();
        assert_eq!(last["rejectionsLeft"], 0);
        assert_eq!(last["guide"]["tool"], GUIDE_TOOL);
    }

    #[tokio::test]
    async fn a_task_status_proposal_is_published_only_for_an_existing_task_and_changes_nothing() {
        let (_dir, ws) = fixture();
        let created = ws.store.collaboration_call(None, "task_create", json!({"requestId":"t","title":"Slice"})).unwrap();
        let proposal = |task: &str, status: &str| json!({"root":"r","elements":{
            "r":{"type":"Result","props":{"title":"Status","summary":"Ready for review."},"children":["p"]},
            "p":{"type":"TaskStatus","props":{"taskId":task,"status":status,"reason":"PR open, CI green"}}}});
        let missing = publish_as(&ws, "a", input("p1", "t1", proposal("T-9", "review"))).await.unwrap().unwrap_err();
        assert_eq!((missing["problems"][0]["code"].as_str(), missing["problems"][0]["path"].as_str()),
            (Some("missing_task"), Some("elements.p.props.taskId")));
        let same = publish_as(&ws, "a", input("p2", "t1", proposal("T-1", "todo"))).await.unwrap().unwrap_err();
        assert_eq!(same["problems"][0]["code"], "no_change");
        let shown = publish_as(&ws, "a", input("p3", "t1", proposal("T-1", "review"))).await.unwrap().unwrap();
        assert_eq!(shown["accepted"], true);
        let task = ws.store.collaboration_call(None, "task_get", json!({"taskId":"T-1"})).unwrap();
        assert_eq!((task["task"]["status"].as_str(), task["task"]["version"].clone()), (Some("todo"), created["task"]["version"].clone()),
            "publishing changes nothing");
        // One action per result, and the format is the contract's.
        let mut two = proposal("T-1", "review");
        two["elements"]["r"]["children"] = json!(["p", "c"]);
        two["elements"]["c"] = json!({"type":"Continue","props":{"label":"Go","instruction":"Continue"}});
        let rejected = publish_as(&ws, "a", input("p4", "t1", two)).await.unwrap().unwrap_err();
        assert_eq!(rejected["problems"][0]["code"], "extra_action");
    }

    #[tokio::test]
    async fn an_accepted_result_is_stored_as_validated_and_shown_with_its_turn() {
        let (_dir, ws) = fixture();
        let submitted = spec(None);
        let answer = publish_as(&ws, "a", input("r1", "t1", submitted.clone())).await.unwrap().unwrap();
        assert_eq!(answer["accepted"], true);
        assert_eq!(answer["version"], 1);
        assert_eq!(answer["turnId"], "t1");
        assert_eq!(answer["chainId"], answer["resultId"]);
        assert_eq!(answer["defaultsApplied"], json!(["elements.table.props.title"]));
        assert!(answer["shown"].as_str().unwrap().contains("Do not repeat"));
        let id = answer["resultId"].as_str().unwrap();
        let db = ws.store.db.read().unwrap();
        let stored = get(&db, "a", id).unwrap().unwrap();
        assert_eq!(stored["spec"]["elements"]["table"]["props"]["title"], "Table");
        assert_eq!(stored["defaults"], json!(["elements.table.props.title"]));
        assert_eq!(stored["schemaVersion"], contract().schema_version);
        assert!(get(&db, "b", id).unwrap().is_none(), "another Agent's result is not found");
        let raw: String = db.query_row("SELECT raw_json FROM interactive_results WHERE id=?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), submitted, "the submission is kept as sent");
        let mut detail = ws.store.client_detail("a").unwrap();
        attach(&db, &mut detail).unwrap();
        assert_eq!(detail.turns[0]["_yuzunoResults"], json!([{"id":id,"chainId":id,"version":1,"createdAt":stored["createdAt"]}]));
        // Shown with the Turn whatever its outcome; it is not a completion.
        drop(db);
        ws.store.update("a", "test/failed", &json!({}), |d| { d.turns[0]["status"] = json!("failed"); d.agent.status = "idle".into(); }).unwrap();
        let mut detail = ws.store.client_detail("a").unwrap();
        attach(&ws.store.db.read().unwrap(), &mut detail).unwrap();
        assert_eq!(detail.turns[0]["status"], "failed");
        assert_eq!(detail.turns[0]["_yuzunoResults"][0]["id"], id);
    }

    #[tokio::test]
    async fn a_retry_gets_its_first_answer_even_after_the_turn_and_never_publishes_twice() {
        let (_dir, ws) = fixture();
        let first = publish_as(&ws, "a", input("same", "t1", spec(Some("T")))).await.unwrap().unwrap();
        let again = publish_as(&ws, "a", input("same", "t1", spec(Some("T")))).await.unwrap().unwrap();
        assert_eq!(first, again);
        assert_eq!(rows(&ws, "interactive_results"), 1);
        let conflict = publish_as(&ws, "a", input("same", "t1", spec(Some("Other")))).await.unwrap_err();
        assert_eq!(code(conflict), "idempotency_conflict");
        let rejected = publish_as(&ws, "a", input("bad", "t1", invalid())).await.unwrap().unwrap_err();
        idle(&ws, "a");
        // The Turn ended: the receipts still answer, unchanged and uncounted.
        assert_eq!(publish_as(&ws, "a", input("same", "t1", spec(Some("T")))).await.unwrap().unwrap(), first);
        assert_eq!(publish_as(&ws, "a", input("bad", "t1", invalid())).await.unwrap().unwrap_err(), rejected);
        assert_eq!(rows(&ws, "interactive_result_rejections"), 1);
        // Receipts belong to their Agent.
        let other = publish_as(&ws, "b", input("same", "t1", spec(Some("T")))).await.unwrap().unwrap();
        assert_ne!(other["resultId"], first["resultId"]);
        assert_eq!(code(publish_as(&ws, "a", input("new", "t1", spec(None))).await.unwrap_err()), "no_active_turn");
    }

    #[tokio::test]
    async fn rejections_say_what_to_fix_count_once_and_then_end_in_text() {
        let (_dir, ws) = fixture();
        let mut left = vec![];
        for n in 0..3 {
            let rejected = publish_as(&ws, "a", input(&format!("bad-{n}"), "t1", invalid())).await.unwrap().unwrap_err();
            assert_eq!(rejected["accepted"], false);
            assert_eq!(rejected["problems"][0]["code"], "unknown_component");
            assert_eq!(rejected["problems"][0]["path"], "elements.result.type");
            left.push(rejected["rejectionsLeft"].as_i64().unwrap());
        }
        assert_eq!(left, [2, 1, 0]);
        // Replaying one is not another rejection.
        publish_as(&ws, "a", input("bad-0", "t1", invalid())).await.unwrap().unwrap_err();
        assert_eq!(rows(&ws, "interactive_result_rejections"), 3);
        let exhausted = publish_as(&ws, "a", input("good", "t1", spec(None))).await.unwrap_err();
        assert_eq!(code(exhausted), "attempts_exhausted");
        assert_eq!(rows(&ws, "interactive_results"), 0);
        // A new Turn starts afresh.
        running(&ws, "a", "t2");
        assert!(publish_as(&ws, "a", input("good", "t2", spec(None))).await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn validator_failures_are_never_the_agents_and_use_no_attempt() {
        let (dir, ws) = fixture();
        let missing_node = Arc::new(Validator::new(bundle_path(), "/nonexistent/node".into()));
        let tampered = dir.path().join("validator.mjs");
        std::fs::write(&tampered, std::fs::read_to_string(bundle_path().unwrap()).unwrap() + "\n// edited").unwrap();
        let hang = dir.path().join("hang");
        std::fs::write(&hang, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&hang, std::fs::Permissions::from_mode(0o700)).unwrap();
        for validator in [
            missing_node,
            Arc::new(Validator::new(None, node())),
            Arc::new(Validator::new(Some(tampered), node())),
            Arc::new(Validator::new(bundle_path(), hang.to_string_lossy().into())),
        ] {
            let started = std::time::Instant::now();
            let error = publish(&ws, &validator, "a", input("first", "t1", invalid())).await.unwrap_err();
            assert_eq!(code(error), "validator_unavailable");
            assert!(started.elapsed() < DEADLINE + Duration::from_secs(2));
        }
        assert_eq!((rows(&ws, "interactive_result_rejections"), receipts(&ws)), (0, 0));
        // The same requestId then works: nothing was recorded for it.
        let rejected = publish_as(&ws, "a", input("first", "t1", invalid())).await.unwrap().unwrap_err();
        assert_eq!(rejected["rejectionsLeft"], 2);
    }

    #[tokio::test]
    async fn a_result_belongs_to_the_turn_core_records_and_is_never_moved() {
        let (dir, ws) = fixture();
        assert_eq!(code(publish_as(&ws, "a", input("old", "t0", spec(None))).await.unwrap_err()), "stale_turn");
        for (field, value) in [("connection_state", "disconnected"), ("status", "uncertain"), ("status", "offline")] {
            ws.store.update("a", "test/unconfirmed", &json!({}), |d| match field {
                "status" => d.agent.status = value.into(),
                _ => d.agent.connection_state = value.into(),
            }).unwrap();
            let db = ws.store.db.read().unwrap();
            assert!(reliable_turn(&ws.store, &db, "a").unwrap().is_none(), "{field}={value}");
            drop(db);
            assert_eq!(code(publish_as(&ws, "a", input("unconfirmed", "t1", spec(None))).await.unwrap_err()), "no_active_turn");
            running(&ws, "a", "t1b");
            ws.store.update("a", "test/again", &json!({}), |d| { d.turns.pop(); d.turns.last_mut().unwrap()["status"] = json!("inProgress"); }).unwrap();
        }
        assert_eq!(rows(&ws, "interactive_results") + rows(&ws, "interactive_result_rejections") + receipts(&ws), 0);
        // The Turn ends while the result is being checked: it is not shown,
        // and not attached to the next Turn.
        let slow = dir.path().join("slow-node");
        std::fs::write(&slow, format!("#!/bin/sh\nsleep 1\nexec '{}' \"$@\"\n", node())).unwrap();
        std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o700)).unwrap();
        let validator = Arc::new(Validator::new(bundle_path(), slow.to_string_lossy().into()));
        let late = {
            let (ws, validator) = (ws.clone(), validator.clone());
            tokio::spawn(async move { publish(&ws, &validator, "a", input("late", "t1", spec(None))).await })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        running(&ws, "a", "t2");
        assert_eq!(code(late.await.unwrap().unwrap_err()), "stale_turn");
        assert_eq!((rows(&ws, "interactive_results"), receipts(&ws)), (0, 0));
        let db = ws.store.db.read().unwrap();
        assert_eq!(reliable_turn(&ws.store, &db, "a").unwrap().unwrap().turn, "t2");
    }

    #[tokio::test]
    async fn revisions_extend_only_the_latest_version_from_the_same_turn() {
        let (_dir, ws) = fixture();
        let first = publish_as(&ws, "a", input("v1", "t1", spec(Some("One")))).await.unwrap().unwrap();
        let second = publish_as(&ws, "a", revise("v2", "t1", spec(Some("Two")), &first["resultId"])).await.unwrap().unwrap();
        assert_eq!((second["chainId"].clone(), second["version"].clone()), (first["resultId"].clone(), json!(2)));
        assert_ne!(second["resultId"], first["resultId"]);
        // No fork from an older version; counted, with the version to use.
        let fork = publish_as(&ws, "a", revise("fork", "t1", spec(None), &first["resultId"])).await.unwrap().unwrap_err();
        assert_eq!(fork["problems"][0]["code"], "invalid_revision");
        assert!(fork["problems"][0]["reason"].as_str().unwrap().contains(second["resultId"].as_str().unwrap()));
        // Another Agent's result does not exist for this one.
        let theirs = publish_as(&ws, "b", input("b1", "t1", spec(None))).await.unwrap().unwrap();
        let foreign = publish_as(&ws, "a", revise("foreign", "t1", spec(None), &theirs["resultId"])).await.unwrap().unwrap_err();
        assert!(foreign["problems"][0]["reason"].as_str().unwrap().contains("no result"));
        assert_eq!(rows(&ws, "interactive_result_rejections"), 2);
        // Five versions in all, then a limit that is not a rejection.
        let mut latest = second["resultId"].clone();
        for n in 3..=5 {
            latest = publish_as(&ws, "a", revise(&format!("v{n}"), "t1", spec(None), &latest)).await.unwrap().unwrap()["resultId"].clone();
        }
        assert_eq!(code(publish_as(&ws, "a", revise("v6", "t1", spec(None), &latest)).await.unwrap_err()), "result_limit");
        // The UI shows the latest version of the chain only.
        let mut detail = ws.store.client_detail("a").unwrap();
        attach(&ws.store.db.read().unwrap(), &mut detail).unwrap();
        assert_eq!(detail.turns[0]["_yuzunoResults"].as_array().unwrap().len(), 1);
        assert_eq!(detail.turns[0]["_yuzunoResults"][0]["id"], latest);
        assert_eq!(detail.turns[0]["_yuzunoResults"][0]["version"], 5);
        // Three results per Turn.
        for n in 2..=3 {
            publish_as(&ws, "a", input(&format!("chain-{n}"), "t1", spec(None))).await.unwrap().unwrap();
        }
        assert_eq!(code(publish_as(&ws, "a", input("chain-4", "t1", spec(None))).await.unwrap_err()), "result_limit");
        // A later Turn cannot rewrite an earlier one's result.
        running(&ws, "a", "t2");
        let history = publish_as(&ws, "a", revise("history", "t2", spec(None), &latest)).await.unwrap().unwrap_err();
        assert!(history["problems"][0]["reason"].as_str().unwrap().contains("this Turn"));
    }

    #[tokio::test]
    async fn a_release_runs_only_its_own_validator_and_older_releases_still_verify() {
        use crate::updates::package::{self, Asset, Bundle};
        let dir = tempfile::tempdir().unwrap();
        let older = package::fixture(&dir.path().join("older"), "older");
        assert_eq!(release_validator(&older), PathBuf::new());
        assert_eq!(resolve(Some(release_validator(&older).into())), None, "never a checkout");
        let mut release = package::fixture(&dir.path().join("release"), "release");
        let source = bundle_path().unwrap();
        for name in ["validator.mjs", "contract.json"] {
            let path = release.path.join("runtimes/result-validator").join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::copy(source.with_file_name(name), &path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
            release.manifest.files.insert(format!("runtimes/result-validator/{name}"), Asset {
                sha256: package::sha256(&path).unwrap(), bytes: std::fs::metadata(&path).unwrap().len(), executable: false,
            });
        }
        package::atomic_json(&release.path.join("manifest.json"), &release.manifest).unwrap();
        let release = Bundle::verify(&release.path, &package::sha256(&release.path.join("manifest.json")).unwrap()).unwrap();
        let path = resolve(Some(release_validator(&release).into())).unwrap();
        assert!(path.starts_with(dir.path()));
        // It runs from the release, away from this checkout.
        let validator = Arc::new(Validator::new(Some(path), node()));
        assert!(matches!(validator.check(&spec(None)).await, Ok(Checked::Accepted { .. })));
        assert!(Bundle::verify(&older.path, &older.manifest_sha256).is_ok());
    }

    #[tokio::test]
    async fn deleting_an_agent_deletes_its_results() {
        let (_dir, ws) = fixture();
        publish_as(&ws, "a", input("r", "t1", spec(None))).await.unwrap().unwrap();
        publish_as(&ws, "a", input("bad", "t1", invalid())).await.unwrap().unwrap_err();
        publish_as(&ws, "b", input("r", "t1", spec(None))).await.unwrap().unwrap();
        ws.store.update("a", "workspace/closed", &json!({}), |d| d.agent.closed_at = Some("now".into())).unwrap();
        ws.store.delete_closed_agent("a").unwrap();
        assert_eq!((rows(&ws, "interactive_results"), rows(&ws, "interactive_result_rejections")), (1, 0));
    }
}
