//! The commands an OpenCode Agent can be sent (T-10), as its own OpenCode's
//! configuration defines them now (`GET /config`'s `command`), read from the
//! running connection, in the shape the slash menu reads for Claude
//! (`claude_commands`). Only a command's name, a single-line description,
//! whether it takes arguments and whether it runs as a sub-agent pass:
//! never its template, model or agent, nor anything else of `/config`,
//! which holds provider keys and options. Reading starts no OpenCode and
//! runs nothing a command does; a message runs one (`opencode_agent`).
use crate::{opencode::CommandChoice, server::ApiError, workspace::Workspace};
use anyhow::{ensure, Result};
use axum::{
    extract::{Path, State as ApiState},
    routing::get,
    Json, Router,
};
use serde::Serialize;
use std::sync::Arc;

const MAX_COMMANDS: usize = 512;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Command {
    name: String,
    description: String,
    argument_hint: String,
    aliases: Vec<String>,
    /// Always `custom`: OpenCode's configuration defines every one.
    source: &'static str,
    subtask: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// ready, unavailable or failed.
    state: &'static str,
    reason: &'static str,
    source: Option<&'static str>,
    session_id: Option<String>,
    observed_at: Option<String>,
    commands: Vec<Command>,
    total: usize,
    truncated: bool,
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

/// OpenCode's commands, held to the closed shape `claude_commands` gives:
/// a name is one token as typed after "/", a description single-line and
/// bounded.
fn listed(commands: Vec<CommandChoice>, session: String) -> View {
    let token = |name: &str| {
        !name.is_empty()
            && name.len() <= 128
            && !name.starts_with('/')
            && !name.chars().any(|c| c.is_whitespace() || c.is_control())
            && !name.contains("://")
    };
    let mut commands: Vec<Command> = commands
        .into_iter()
        .filter(|c| token(&c.name))
        .map(|c| Command {
            description: c
                .description
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect::<String>()
                .trim()
                .chars()
                .take(300)
                .collect(),
            argument_hint: if c.takes_arguments { "<arguments>".into() } else { String::new() },
            aliases: vec![],
            source: "custom",
            subtask: c.subtask,
            name: c.name,
        })
        .collect();
    let total = commands.len();
    commands.truncate(MAX_COMMANDS);
    View {
        state: "ready",
        reason: "listed",
        source: Some("session"),
        session_id: Some(session),
        observed_at: Some(crate::model::now()),
        commands,
        total,
        truncated: total > MAX_COMMANDS,
        // Every command is OpenCode's configured one: none is a Skill.
        skills_known: true,
    }
}

impl Workspace {
    pub async fn opencode_commands(&self, id: &str) -> Result<View> {
        let _permit = self.admission.enter_work()?;
        let agent = self.listed(id).await?;
        ensure!(agent.harness == "opencode", "Commands are only listed here for OpenCode Agents");
        if agent.closed_at.is_some() {
            return Ok(View::not("unavailable", "closed"));
        }
        let Some(c) = self.opencodes.lock().unwrap().get(id).cloned() else {
            return Ok(View::not("unavailable", "disconnected"));
        };
        let Ok(commands) = c.server.commands().await else {
            return Ok(View::not("failed", "read_failed"));
        };
        // The list belongs to the OpenCode process behind the connection:
        // one read from a connection this Agent no longer has is not its list.
        let current = self.opencodes.lock().unwrap().get(id).map(|now| now.generation);
        if current != Some(c.generation) {
            return Ok(View::not("unavailable", "changed"));
        }
        Ok(listed(commands, c.session))
    }
}

async fn read(
    ApiState(ws): ApiState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.opencode_commands(&id).await?))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/agents/{id}/opencode/commands", get(read))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn choice(name: &str, description: &str) -> CommandChoice {
        CommandChoice { name: name.into(), description: description.into(), takes_arguments: false, subtask: false, model: None }
    }

    #[test]
    fn a_listed_view_has_the_command_list_shape_and_nothing_else() {
        let mut review = choice("review", "Review\nthe change");
        review.takes_arguments = true;
        review.subtask = true;
        review.model = Some("example/model-a".into());
        let view = serde_json::to_value(listed(vec![review, choice("bad name", ""), choice("/x", ""), choice("a://b", "")], "ses_1".into())).unwrap();
        let observed = view["observedAt"].clone();
        assert!(observed.is_string());
        assert_eq!(view, json!({"state":"ready","reason":"listed","source":"session","sessionId":"ses_1","observedAt":observed,
            "commands":[{"name":"review","description":"Review the change","argumentHint":"<arguments>","aliases":[],"source":"custom","subtask":true}],
            "total":1,"truncated":false,"skillsKnown":true}));
    }

    #[test]
    fn a_view_that_is_not_ready_keeps_the_shape_and_lists_nothing() {
        assert_eq!(serde_json::to_value(View::not("unavailable", "disconnected")).unwrap(), json!({"state":"unavailable","reason":"disconnected",
            "source":null,"sessionId":null,"observedAt":null,"commands":[],"total":0,"truncated":false,"skillsKnown":false}));
    }

    #[test]
    fn a_long_list_is_cut_and_says_so() {
        let many = (0..MAX_COMMANDS + 3).map(|n| choice(&format!("c{n:04}"), &"d".repeat(400))).collect();
        let view = listed(many, "ses_1".into());
        assert_eq!((view.commands.len(), view.total, view.truncated), (MAX_COMMANDS, MAX_COMMANDS + 3, true));
        assert_eq!(view.commands[0].description.chars().count(), 300);
    }
}
