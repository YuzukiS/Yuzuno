//! Core answering a local OpenCode executor's permission requests at
//! Auto-approve, for real (YN-78 S4b-2; design v4 2 with the Dev Lead's
//! activities 8121 and 8632). Part of `opencode_agent`.
//!
//! **Who.** A local OpenCode executor (agent_roles) whose level is `auto`, on
//! Unix, served by the OpenCode release the binding was checked against
//! (VERIFIED). Every other Agent and level starts exactly as before:
//! ask, full, read-only, a standing Agent, another platform, another
//! harness, a remote machine.
//!
//! **One activation.** Before its server starts: the protected locations
//! (opencode_protection), the static rules and the instructions file they
//! load (opencode_policy), written and read back. Once it runs: its version,
//! its agents' rules read back against every probe, and the folder and Git
//! top it actually works in (`GET /api/location`), whose real paths are fixed
//! then as the project's roots. Only then is the connection given its engine,
//! from its first event and its first snapshot on. Any part that fails fails
//! the start, with its reason; nothing starts with the old wider Auto-approve
//! rules, and no request of it ever reaches the user's queue meanwhile.
//!
//! **Routing.** Each `permission.asked` event of the Agent's session or a
//! known sub-agent's, and each request a snapshot of the connection finds
//! pending, is submitted to the engine instead of being kept as the user's
//! request. The event's thread never waits for a file system or HTTP: the
//! report is awaited on a task of its own. Each tool event of those sessions
//! is taken in as binding evidence (`Calls`).
//!
//! **Records.** A Once delivered is counted, never logged one by one. Any
//! other outcome is journaled once (`opencode/autoAnswer`) with its codes,
//! its counts so far, and the reason sentence only when its delivery or the
//! request's disappearance is a fact. A record is written only while its
//! generation is still the current one. OpenCode's own tools still tell the
//! model only `Unable to …`: the instructions file says why (design 2.5).
use super::{CapturedRuntime, Connection};
use crate::opencode::{Launch, Server, VERIFIED};
use crate::opencode_permissions::{decide, Answer, Asked, Call, Calls, Decision, Rules, Wall, BUDGET};
use crate::opencode_protection::{self, PathEnv, Planned, Protection};
use crate::opencode_responder::{bounded_fs, Engine, Judge, Outcome, Report, Submission, PREPARE_LIMIT};
use crate::permission_levels::opencode_policy::{self, Inputs, Platform, Policy};
use crate::workspace::Workspace;
use anyhow::{bail, ensure, Context as _, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use tokio::time::Instant;

/// The level whose requests Core answers here.
pub(crate) const LEVEL: &str = "auto";
/// The instructions file in the Agent's folder (design 2.5).
const INSTRUCTIONS: &str = "yuzuno-rules.md";

pub(crate) type AutoEngine = Engine<Server, AutoJudge, Server>;

/// Whether an Agent of `level` and agent_roles `kind` starts with Core's
/// own answers.
pub(crate) fn eligible(level: Option<&str>, kind: &str) -> bool {
    cfg!(unix) && level == Some(LEVEL) && kind == crate::agent_roles::EXECUTOR
}

/// What a start has made ready before its server runs.
pub(crate) struct Prepared {
    /// OPENCODE_CONFIG_CONTENT, with the instructions file.
    pub config: String,
    policy: Policy,
    planned: Planned,
    protection: Protection,
    data_dir: String,
    outputs: [String; 2],
    temp: Option<String>,
}

/// Everything a decision reads, fixed when the server started.
#[derive(Clone, Debug)]
pub(crate) struct Context {
    /// The folder and Git top OpenCode works in, as it names them.
    directory: String,
    worktree: Option<String>,
    /// Their real paths at start: what is really inside.
    internal: Vec<String>,
    /// The home OpenCode expands `~` to.
    home: String,
    data_dir: String,
    outputs: [String; 2],
    temp: Option<String>,
    dirs: Vec<String>,
    files: Vec<String>,
}

/// Prepares an executor's start: protected locations, rules and their
/// instructions file in `folder` (its own under Core's data directory
/// `data_dir`), for `launch` as it will start. Its file-system work runs
/// under Core's bounded file-system permits within PREPARE_LIMIT.
pub(crate) async fn prepare(folder: &Path, data_dir: &Path, launch: &Launch) -> Result<Prepared> {
    let deadline = Instant::now() + PREPARE_LIMIT;
    // The names, never the values, of what this server alone gets.
    let env = path_env(data_dir, launch.extra.iter().map(|(name, _)| name.clone()).collect());
    let planned = opencode_protection::plan(&env)?;
    let (folder, data, temp) = (folder.to_owned(), data_dir.to_owned(), launch.temp_dir.clone());
    let (planned, protection, data, folder, temp) = bounded_fs(deadline, move || -> Result<_> {
        let protection = opencode_protection::identify(&planned)?;
        Ok((planned, protection, canonical(&data)?, canonical(&folder)?, temp.map(|temp| text(&temp)).transpose()?))
    }).await.context("the protected locations could not be read in time")??;
    let outputs = [format!("{folder}/xdg/data/opencode/shell"), format!("{folder}/xdg/data/opencode/tool-output")];
    let instructions = format!("{folder}/{INSTRUCTIONS}");
    let dirs: Vec<&Path> = protection.dirs.iter().map(Path::new).collect();
    let files: Vec<&Path> = protection.files.iter().map(Path::new).collect();
    let policy = opencode_policy::policy(&Inputs {
        level: Some(LEVEL), platform: Platform::Unix, data_dir: Path::new(&data), outputs: [Path::new(&outputs[0]), Path::new(&outputs[1])],
        temp: temp.as_deref().map(Path::new), protected_dirs: &dirs, protected_files: &files, instructions: Path::new(&instructions),
    })?.context("no rules were made")?;
    let text = policy.instructions.clone().context("no instructions were made")?;
    let path = PathBuf::from(&instructions);
    bounded_fs(deadline, move || write_instructions(&path, &text)).await.context("the instructions file could not be written in time")??;
    Ok(Prepared { config: policy.config.clone(), policy, planned, protection, data_dir: data, outputs, temp })
}

/// Core's environment for the resolver. A test's Workspace never reads the
/// real one: it reads what the test set for its data directory, else a
/// synthetic home under it that does not exist.
fn path_env(data_dir: &Path, extra: Vec<String>) -> PathEnv {
    #[cfg(test)]
    {
        let set = TEST_ENVS.lock().unwrap().iter().find(|(dir, _)| dir == data_dir).map(|(_, env)| env.clone());
        let mut env = set.unwrap_or_else(|| PathEnv {
            vars: [("HOME", data_dir.join("synthetic-home").into_os_string())].into_iter().collect(),
            ..PathEnv::default()
        });
        env.extra = extra;
        env
    }
    #[cfg(not(test))]
    {
        let _ = data_dir;
        PathEnv::of_core(extra)
    }
}

/// The environments tests give the resolver, by data directory.
#[cfg(test)]
pub(crate) static TEST_ENVS: Mutex<Vec<(PathBuf, PathEnv)>> = Mutex::new(Vec::new());

/// The instructions file, written whole and read back: what OpenCode loads
/// is what was made.
fn write_instructions(path: &Path, text: &str) -> Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let partial = path.with_extension("md.partial");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&partial)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&partial, path)?;
    ensure!(std::fs::read_to_string(path)? == text, "{} does not read back as written", path.display());
    Ok(())
}

/// Checks the started `server` against what was prepared and fixes the
/// folder it works in for `cwd`: its version, its agents' rules, its
/// location and the real paths of its project roots.
pub(crate) async fn started(prepared: Prepared, server: &Server, cwd: &str) -> Result<Context> {
    ensure!(server.version() == VERIFIED,
        "OpenCode {} is not {VERIFIED}, the release Core's answers to its permission requests were checked against", server.version());
    let managed = crate::permission_levels::OPENCODE_MANAGED;
    let managed = Path::new(managed).exists().then_some(managed);
    opencode_policy::check(&prepared.policy, LEVEL, &server.agent_rules(cwd).await?, managed)?;
    let location = server.location(cwd).await?;
    let Some(directory) = location["directory"].as_str().filter(|path| normal(path)) else {
        bail!("OpenCode named no absolute folder it works in for {cwd}");
    };
    let worktree = match location["project"]["directory"].as_str() {
        None | Some("/") => None,
        Some(top) if normal(top) => Some(top.to_owned()),
        Some(top) => bail!("OpenCode named {top:?} as the project's top, not an absolute path"),
    };
    let (directory, roots) = (directory.to_owned(), std::iter::once(directory.to_owned()).chain(worktree.clone()).collect::<Vec<_>>());
    let deadline = Instant::now() + PREPARE_LIMIT;
    let internal = bounded_fs(deadline, move || roots.iter().map(|root| canonical(Path::new(root))).collect::<Result<Vec<_>>>()).await
        .context("the project's folders could not be read in time")??;
    let Prepared { planned, protection, data_dir, outputs, temp, .. } = prepared;
    Ok(Context { directory, worktree, internal, home: planned.native_home, data_dir, outputs, temp, dirs: protection.dirs, files: protection.files })
}

fn canonical(path: &Path) -> Result<String> {
    text(&std::fs::canonicalize(path).with_context(|| format!("{} can't be read", path.display()))?)
}

fn text(path: &Path) -> Result<String> {
    path.to_str().map(str::to_owned).with_context(|| format!("{} is not UTF-8", path.display()))
}

/// An absolute path with no empty, `.` or `..` part.
fn normal(path: &str) -> bool {
    path.starts_with('/') && (path == "/" || path[1..].split('/').all(|part| !part.is_empty() && part != "." && part != ".."))
}

/// S4a's decision against the context fixed at start.
pub(crate) struct AutoJudge(Context);

impl Judge for AutoJudge {
    fn decide(&self, asked: &Asked, call: &Call) -> Decision {
        fn paths(list: &[String]) -> Vec<&Path> {
            list.iter().map(Path::new).collect()
        }
        let c = &self.0;
        let (internal, dirs, files) = (paths(&c.internal), paths(&c.dirs), paths(&c.files));
        let rules = Rules {
            directory: Path::new(&c.directory), worktree: c.worktree.as_deref().map(Path::new), internal: &internal, home: Path::new(&c.home),
            data_dir: Path::new(&c.data_dir), outputs: [Path::new(&c.outputs[0]), Path::new(&c.outputs[1])], temp: c.temp.as_deref().map(Path::new),
            protected_dirs: &dirs, protected_files: &files,
        };
        decide(asked, call, &rules, &BUDGET, &Wall)
    }
}

/// What a connection's Core answers came to so far: counts only.
#[derive(Clone, Copy, Debug, Default)]
struct Tally {
    once: u64,
    rejected: u64,
    other: u64,
}

/// One connection's Core answers: its engine, and what they came to.
pub(crate) struct Auto {
    pub(crate) engine: Arc<AutoEngine>,
    workspace: Weak<Workspace>,
    agent: String,
    tally: Mutex<Tally>,
}

impl Auto {
    /// The engine of connection `c` of Agent `agent`: its generation, its
    /// sessions as `c` knows them when a request is bound, its captured
    /// runtime, and the decisions of `context`.
    pub(crate) fn new(workspace: &Arc<Workspace>, agent: &str, c: &Connection, context: Context) -> Arc<Self> {
        let children = c.children.clone();
        let (weak, owner, generation) = (Arc::downgrade(workspace), agent.to_owned(), c.generation);
        let server = Arc::as_ptr(&c.server) as usize;
        let current: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || weak.upgrade().is_some_and(|ws| {
            ws.opencode_current(&owner, generation).is_some_and(|now| Arc::as_ptr(&now.server) as usize == server)
        }));
        let engine = Arc::new(Engine::new(generation, c.session.clone(), Arc::new(move || children.lock().unwrap().keys().cloned().collect()),
            Arc::new(Calls::default()), c.server.clone(), Arc::new(AutoJudge(context)), c.server.clone(), current,
            Arc::new(CapturedRuntime::of(workspace, agent, c))));
        Arc::new(Self { engine, workspace: Arc::downgrade(workspace), agent: agent.to_owned(), tally: Mutex::default() })
    }

    /// A tool event of one of the connection's sessions: binding evidence.
    pub(crate) fn tool_event(&self, generation: u64, event: &Value) {
        self.engine.calls().ingest_event(generation, event);
    }

    /// A permission request of the connection (an event's data, or an item a
    /// snapshot found pending), submitted to Core instead of the user. Never
    /// waits: its report is awaited on a task of its own.
    pub(crate) fn asked(self: &Arc<Self>, generation: u64, request: &Value) {
        let Some(asked) = Asked::read(request) else {
            eprintln!("OpenCode sent Agent {} a permission request with no id, session or action; nothing can answer it", self.agent);
            return;
        };
        if let Submission::Accepted(mut receiver) = self.engine.submit(&asked) {
            let auto = self.clone();
            tokio::spawn(async move {
                let report = loop {
                    if let Some(report) = receiver.borrow_and_update().clone() {
                        break report;
                    }
                    if receiver.changed().await.is_err() {
                        return;
                    }
                };
                auto.reported(generation, report).await;
            });
        }
    }

    /// Every request a snapshot of the connection found pending.
    pub(crate) fn snapshot(self: &Arc<Self>, generation: u64, requests: &[Value]) {
        for request in requests {
            self.asked(generation, request);
        }
    }

    /// One `permission.replied` event, for the collateral ledger.
    pub(crate) fn replied(&self, session: &str, data: &Value) {
        if let (Some(request), Some(reply)) = (data["requestID"].as_str(), data["reply"].as_str()) {
            self.engine.replied(session, request, reply);
        }
    }

    async fn reported(&self, generation: u64, report: Report) {
        let tally = {
            let mut tally = self.tally.lock().unwrap();
            match (&report.answer, report.outcome) {
                (Some(Answer::Once), Outcome::Delivered) => tally.once += 1,
                (Some(Answer::Reject(_)), Outcome::Delivered | Outcome::Gone) => tally.rejected += 1,
                _ => tally.other += 1,
            }
            *tally
        };
        if matches!((&report.answer, report.outcome), (Some(Answer::Once), Outcome::Delivered) | (_, Outcome::Discarded)) {
            return;
        }
        let Some(ws) = self.workspace.upgrade() else { return };
        let owned = ws.owner(&self.agent).await;
        if ws.opencode_current(&self.agent, generation).is_none() {
            return;
        }
        let (decision, reason) = match &report.answer {
            Some(Answer::Once) => (Some("once"), None),
            Some(Answer::Reject(reason)) => (Some("reject"), Some(reason.code())),
            None => (None, None),
        };
        let data = json!({"requestId": report.request, "sessionId": report.session, "generation": report.generation,
            "decision": decision, "reason": reason, "notice": report.notice, "outcome": report.outcome.code(), "rounds": report.rounds,
            "collateral": report.collateral, "ownReject": report.own_reject,
            "counts": {"once": tally.once, "rejected": tally.rejected, "other": tally.other}});
        let agent = self.agent.clone();
        if let Err(error) = ws.stored_owned(owned, move |store| store.update_meta(&agent, "opencode/autoAnswer", &data, |_| {}).map(drop)).await {
            eprintln!("Workspace OpenCode Auto-approve answer not recorded: {error:#}");
        }
    }
}

#[cfg(test)]
#[path = "opencode_auto_tests.rs"]
mod tests;
