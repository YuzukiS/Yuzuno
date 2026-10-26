//! The skills a Codex Agent can be sent (T-29), as the Agent's own Codex
//! app-server lists them for the Agent's folder (`skills/list`), and the
//! typed `skill` input items a message carries for the ones the user chose
//! (`{type:"skill", name, path}`, beside the text naming it as `$name`).
//!
//! Nothing here reads a disk or starts anything: an Agent's skills come from
//! its connection, which for an Agent on another machine is the Codex there,
//! and only while it is connected. A skill's path is an identifier on that
//! machine, compared as given and never interpreted as a path here.
use crate::{model::SkillRef, rpc::{Rpc, RpcError}, server::ApiError, workspace::Workspace};
use anyhow::{bail, ensure, Result};
use axum::{
    extract::{Path, State as ApiState},
    routing::get,
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc};

/// Skills one message can invoke.
pub const MAX_CHOSEN: usize = 16;
/// Skills one list shows; Codex's order otherwise.
const MAX_LISTED: usize = 500;
const MAX_NAME: usize = 200;
const MAX_PATH: usize = 4096;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Skill {
    name: String,
    description: String,
    argument_hint: &'static str,
    aliases: [&'static str; 0],
    source: &'static str,
    path: String,
    /// user, repo, system or admin, as Codex says.
    scope: String,
}

/// The list as the composer's slash list reads it (web `CommandList`).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// ready, unavailable, unsupported or failed.
    state: &'static str,
    reason: String,
    source: Option<&'static str>,
    commands: Vec<Skill>,
    total: usize,
    truncated: bool,
    skills_known: bool,
    /// Listed but turned off in Codex's configuration: not offered.
    disabled: usize,
    /// Skill files Codex could not read.
    errors: usize,
}

impl View {
    fn not(state: &'static str, reason: impl Into<String>) -> Self {
        View { state, reason: reason.into(), source: None, commands: vec![], total: 0, truncated: false, skills_known: true, disabled: 0, errors: 0 }
    }
}

fn token(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_NAME && !name.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn identifier(path: &str) -> bool {
    !path.is_empty() && path.len() <= MAX_PATH && !path.contains('\0')
}

fn clean(text: &str, max: usize) -> String {
    text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().chars().take(max).collect()
}

/// What Codex listed, each skill once (by name and path), in its order.
struct Listed {
    enabled: Vec<Skill>,
    disabled: usize,
    errors: usize,
}

fn listed(response: &Value) -> Result<Listed> {
    let entries = response["data"].as_array().ok_or_else(|| anyhow::anyhow!("Codex returned an invalid skills list"))?;
    let (mut enabled, mut disabled, mut errors, mut seen) = (vec![], 0, 0, HashSet::new());
    for entry in entries {
        errors += entry["errors"].as_array().map_or(0, Vec::len);
        for skill in entry["skills"].as_array().into_iter().flatten() {
            let (Some(name), Some(path)) = (skill["name"].as_str(), skill["path"].as_str()) else { continue };
            if !token(name) || !identifier(path) || !seen.insert((name.to_owned(), path.to_owned())) {
                continue;
            }
            if skill["enabled"] != true {
                disabled += 1;
                continue;
            }
            let interface = &skill["interface"];
            let description = [&interface["shortDescription"], &skill["shortDescription"], &skill["description"]]
                .into_iter().filter_map(Value::as_str).find(|d| !d.trim().is_empty()).unwrap_or("");
            enabled.push(Skill {
                name: name.into(),
                description: clean(description, 300),
                argument_hint: "",
                aliases: [],
                source: "skill",
                path: path.into(),
                scope: clean(skill["scope"].as_str().unwrap_or(""), 16),
            });
        }
    }
    Ok(Listed { enabled, disabled, errors })
}

/// Why Codex gave no list: its version has no `skills/list` (refused before
/// anything ran), or the request failed.
fn refusal(error: &anyhow::Error) -> (&'static str, String) {
    match error.downcast_ref::<RpcError>() {
        Some(refused) if refused.code == -32601 => ("unsupported", "old_protocol".into()),
        _ => ("failed", error.to_string()),
    }
}

async fn read(rpc: &Rpc, cwd: &str) -> Result<Listed> {
    listed(&rpc.request("skills/list", json!({"cwds":[cwd]})).await?)
}

/// A message's skills, held to a small closed shape before anything else.
pub(crate) fn check(skills: &[SkillRef]) -> Result<()> {
    ensure!(skills.len() <= MAX_CHOSEN, "A message can invoke at most {MAX_CHOSEN} skills");
    let mut seen = HashSet::new();
    for skill in skills {
        ensure!(token(&skill.name) && identifier(&skill.path) && seen.insert(skill), "Invalid skill reference");
    }
    Ok(())
}

/// The chosen skills, each still listed and on by this Agent's Codex for its
/// folder, exactly as chosen. Nothing is sent otherwise.
pub(crate) async fn verify(rpc: &Rpc, cwd: &str, skills: &[SkillRef]) -> Result<()> {
    if skills.is_empty() {
        return Ok(());
    }
    let listed = match read(rpc, cwd).await {
        Ok(listed) => listed,
        Err(error) => match refusal(&error) {
            ("unsupported", _) => bail!("This Agent's Codex does not list skills (skills/list); the message was not sent"),
            (_, reason) => bail!("Could not check this Agent's skills ({reason}); the message was not sent"),
        },
    };
    for skill in skills {
        if !listed.enabled.iter().any(|s| s.name == skill.name && s.path == skill.path) {
            bail!("Skill “{}” is not available to this Agent's Codex any more; the message was not sent", skill.name);
        }
    }
    Ok(())
}

/// The typed input items for a message's skills, after its text.
pub(crate) fn input_items(skills: &[SkillRef]) -> impl Iterator<Item = Value> + '_ {
    skills.iter().map(|skill| json!({"type":"skill","name":skill.name,"path":skill.path}))
}

impl Workspace {
    /// The skills this Codex Agent's own Codex lists for its folder, read on
    /// its current connection only: nothing is started or resumed for this.
    pub async fn codex_skills(self: &Arc<Self>, id: &str) -> Result<View> {
        let agent = self.listed(id).await?;
        if agent.harness != "codex" {
            return Ok(View::not("unsupported", "harness"));
        }
        if agent.closed_at.is_some() {
            return Ok(View::not("unavailable", "closed"));
        }
        let connection = self.rpcs.lock().unwrap().get(id).cloned().filter(|c| !c.closing && agent.connection_state == "connected");
        let Some(connection) = connection else {
            return Ok(View::not("unavailable", "not_connected"));
        };
        Ok(match read(&connection.rpc, &agent.cwd).await {
            Ok(Listed { mut enabled, disabled, errors }) => {
                let total = enabled.len();
                enabled.truncate(MAX_LISTED);
                View { state: "ready", reason: "listed".into(), source: Some("session"), truncated: total > enabled.len(), commands: enabled,
                    total, skills_known: true, disabled, errors }
            }
            Err(error) => {
                let (state, reason) = refusal(&error);
                View::not(state, reason)
            }
        })
    }
}

async fn read_route(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.codex_skills(&id).await?))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/agents/{id}/codex/skills", get(read_route))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_list_keeps_enabled_skills_once_with_their_own_path_and_counts_the_rest() {
        let response = json!({"data":[{"cwd":"/w","errors":[{"path":"/w/.codex/skills/bad/SKILL.md","message":"no front matter"}],"skills":[
            {"name":"deploy","description":"Long","shortDescription":"Short","interface":{"shortDescription":"Shortest"},
                "path":"/w/.codex/skills/deploy/SKILL.md","scope":"repo","enabled":true,"pluginId":null},
            {"name":"deploy","description":"Same name, another scope","path":"C:\\Users\\me\\.codex\\skills\\deploy\\SKILL.md","scope":"user","enabled":true},
            {"name":"deploy","description":"Repeated","path":"/w/.codex/skills/deploy/SKILL.md","scope":"repo","enabled":true},
            {"name":"off","description":"Off","path":"/w/off/SKILL.md","scope":"repo","enabled":false},
            {"name":"has space","description":"x","path":"/x","scope":"user","enabled":true},
            {"name":"nopath","description":"x","scope":"user","enabled":true}]}]});
        let listed = listed(&response).unwrap();
        assert_eq!(listed.enabled.iter().map(|s| (s.name.as_str(), s.path.as_str(), s.description.as_str(), s.scope.as_str())).collect::<Vec<_>>(), [
            ("deploy", "/w/.codex/skills/deploy/SKILL.md", "Shortest", "repo"),
            ("deploy", "C:\\Users\\me\\.codex\\skills\\deploy\\SKILL.md", "Same name, another scope", "user"),
        ]);
        assert_eq!((listed.disabled, listed.errors), (1, 1));
        assert!(super::listed(&json!({"skills":[]})).is_err(), "no data is no list");
    }

    #[test]
    fn a_message_names_each_skill_once_by_name_and_its_own_path() {
        let skill = |name: &str, path: &str| SkillRef { name: name.into(), path: path.into() };
        assert!(check(&[skill("deploy", "C:\\skills\\deploy\\SKILL.md"), skill("deploy", "/w/deploy/SKILL.md")]).is_ok(),
            "a Windows path on another machine is that machine's identifier");
        assert!(check(&[skill("deploy", "/w/SKILL.md"), skill("deploy", "/w/SKILL.md")]).is_err());
        assert!(check(&[skill("", "/w")]).is_err() && check(&[skill("a b", "/w")]).is_err() && check(&[skill("a", "")]).is_err()
            && check(&[skill("a", "/w\0")]).is_err());
        assert!(check(&(0..=MAX_CHOSEN).map(|i| skill(&format!("s{i}"), "/w")).collect::<Vec<_>>()).is_err());
        assert_eq!(input_items(&[skill("deploy", "/w/SKILL.md")]).collect::<Vec<_>>(),
            [json!({"type":"skill","name":"deploy","path":"/w/SKILL.md"})]);
    }
}
