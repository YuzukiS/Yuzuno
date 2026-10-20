//! The slash commands and Skills a Claude Agent can be sent, as Claude Code
//! itself lists them (`supportedCommands()`, bridge op `commands`): from the
//! Agent's running session when it has one, else from a catalogue-only start
//! of Claude Code in the Agent's folder, which sends no prompt and keeps no
//! session, reused for a minute per folder. Never a list read from disk, and
//! never one Claude Code did not give. Reading runs nothing a command does.
use crate::{claude::Bridge, server::ApiError, workspace::Workspace};
use anyhow::Result;
use axum::{
    extract::{Path, State as ApiState},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const FOLDER_FRESH: Duration = Duration::from_secs(60);
const MAX_COMMANDS: usize = 512;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Source {
    /// Claude Code's own.
    Builtin,
    /// A Skill, as the session's latest init lists it.
    Skill,
    /// Defined by a user, project, plugin or MCP server.
    #[serde(other)]
    Custom,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Command {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    argument_hint: String,
    #[serde(default)]
    aliases: Vec<String>,
    source: Source,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Wire {
    state: String,
    session_id: Option<String>,
    #[serde(default)]
    commands: Vec<Command>,
    #[serde(default)]
    total: usize,
    #[serde(default)]
    truncated: bool,
    #[serde(default)]
    skills_known: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// ready, unavailable, unsupported or failed.
    state: &'static str,
    reason: &'static str,
    /// Whose list: the running session's, or the folder's when none runs.
    source: Option<&'static str>,
    session_id: Option<String>,
    observed_at: Option<String>,
    commands: Vec<Command>,
    total: usize,
    truncated: bool,
    /// Whether a Skill can be told from another custom command yet.
    skills_known: bool,
}

impl View {
    fn not(state: &'static str, reason: &'static str) -> Self {
        View {
            state,
            reason,
            source: None,
            session_id: None,
            observed_at: None,
            commands: vec![],
            total: 0,
            truncated: false,
            skills_known: false,
        }
    }
}

/// The bridge's answer, held again to a small closed shape at the Core
/// boundary: a name is one token as typed after "/", text is single-line
/// and bounded, and nothing else passes.
fn listed(wire: Wire, source: &'static str) -> View {
    let clean = |text: String, max: usize| -> String {
        text.chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect::<String>()
            .trim()
            .chars()
            .take(max)
            .collect()
    };
    let token = |name: &str| {
        !name.is_empty()
            && name.len() <= 128
            && !name.starts_with('/')
            && !name.chars().any(|c| c.is_whitespace() || c.is_control())
            && !name.contains("://")
    };
    let mut commands: Vec<Command> = wire
        .commands
        .into_iter()
        .filter(|c| token(&c.name))
        .map(|c| Command {
            description: clean(c.description, 300),
            argument_hint: clean(c.argument_hint, 120),
            aliases: c.aliases.into_iter().filter(|a| token(a)).take(8).collect(),
            ..c
        })
        .collect();
    let truncated = wire.truncated || commands.len() > MAX_COMMANDS;
    commands.truncate(MAX_COMMANDS);
    View {
        state: "ready",
        reason: "listed",
        source: Some(source),
        session_id: wire.session_id,
        observed_at: Some(crate::model::now()),
        total: wire.total.max(commands.len()),
        commands,
        truncated,
        skills_known: wire.skills_known,
    }
}

/// What the bridge said, for one source; failures never carry native text.
fn answer(result: Result<serde_json::Value>, source: &'static str) -> View {
    let Some(wire) = result
        .ok()
        .and_then(|v| serde_json::from_value::<Wire>(v).ok())
    else {
        return View::not("failed", "read_failed");
    };
    match wire.state.as_str() {
        "ready" => listed(wire, source),
        "unsupported" => View::not("unsupported", "unsupported"),
        "unavailable" => View::not("unavailable", "initializing"),
        "changed" => View::not("unavailable", "changed"),
        _ => View::not("failed", "read_failed"),
    }
}

type Folders = Mutex<HashMap<String, (Instant, View)>>;
fn folders() -> &'static (Folders, tokio::sync::Mutex<()>) {
    static FOLDERS: OnceLock<(Folders, tokio::sync::Mutex<()>)> = OnceLock::new();
    FOLDERS.get_or_init(Default::default)
}

impl Workspace {
    pub async fn claude_commands(&self, id: &str) -> Result<View> {
        let _permit = self.admission.enter_work()?;
        let key = id.to_owned();
        let agent = self.stored(move |store| store.agent(&key)).await?;
        anyhow::ensure!(
            agent.harness == "claude",
            "Commands are only listed for Claude Agents"
        );
        if agent.closed_at.is_some() {
            return Ok(View::not("unavailable", "closed"));
        }
        if agent.remote.is_some() {
            return Ok(View::not("unavailable", "remote"));
        }
        let connection = self.claudes.lock().unwrap().get(id).cloned();
        if let Some(connection) = connection.filter(|_| agent.connection_state == "connected") {
            let result = connection.bridge.request(json!({"op":"commands"})).await;
            let view = answer(result, "session");
            // The list belongs to the Claude Code process behind the
            // connection: one from a connection this Agent no longer has is
            // not its list. (A new session inside the same process, as after
            // /clear, lists the same commands; the bridge itself answers
            // `changed` when its session changed during the read.)
            let current = self.claudes.lock().unwrap().get(id).map(|c| c.generation);
            if view.state == "ready" && current != Some(connection.generation) {
                return Ok(View::not("unavailable", "changed"));
            }
            return Ok(view);
        }
        self.folder_commands(&agent.cwd).await
    }

    /// The folder's list from a catalogue-only start, shared by every Agent
    /// in that folder for a minute. One start at a time.
    async fn folder_commands(&self, cwd: &str) -> Result<View> {
        let (cache, starting) = folders();
        let fresh = |cache: &Folders| {
            cache
                .lock()
                .unwrap()
                .get(cwd)
                .filter(|(at, _)| at.elapsed() < FOLDER_FRESH)
                .map(|(_, view)| view.clone())
        };
        if let Some(view) = fresh(cache) {
            return Ok(view);
        }
        let _one = starting.lock().await;
        if let Some(view) = fresh(cache) {
            return Ok(view);
        }
        let (tx, mut rx) = tokio::sync::mpsc::channel(256);
        let Ok(bridge) = Bridge::spawn(tx).await else {
            return Ok(View::not("failed", "read_failed"));
        };
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        let result = async {
            bridge
                .request(json!({"op":"start","cwd":cwd,"catalogOnly":true}))
                .await?;
            bridge.request(json!({"op":"commands"})).await
        }
        .await;
        let _ = bridge.close_and_wait().await;
        let view = answer(result, "folder");
        if view.state == "ready" {
            cache
                .lock()
                .unwrap()
                .insert(cwd.to_owned(), (Instant::now(), view.clone()));
        }
        Ok(view)
    }
}

async fn read(
    ApiState(ws): ApiState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.claude_commands(&id).await?))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/agents/{id}/claude/commands", get(read))
}
