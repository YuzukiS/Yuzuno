//! Starting one executor with its routing account or key (YN-34 S1c;
//! docs/executor-routing.md). This is all of Core's code that hands a key
//! or an account to a harness process; the values come from routing_keys.
//!
//! - An Agent's **runtime profile** lives in its own table,
//!   `agent_runtime_profiles`, never in the Agent's record: older Cores
//!   rewrite that record and drop fields they do not know. No profile is the
//!   host's own login, as every Agent had before.
//! - Each start of the Agent's harness reads the profile again (a reconnect
//!   too), and what it gives goes into the environment of that one process
//!   only: the Claude bridge Core spawns for this Agent, or this Agent's
//!   `opencode serve`. Core's own environment never holds it, so no other
//!   Agent, Job, review run or catalog read sees it.
//! - **A claude-swap account** is resolved from a fresh `cswap list` at each
//!   start (routing_accounts::resolve): the host's current default login
//!   starts on the plain host login; another listed account starts through
//!   runtimes/claude/cswap-claude; one no longer listed does not start, and
//!   never as another account.
//! - **An API key**, local or from 1Password (read once, here, per start):
//!   Claude Code gets ANTHROPIC_API_KEY with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1,
//!   so its Bash commands, hooks and stdio MCP servers don't inherit it.
//!   OpenCode gets its provider's variable; its shell tool does inherit the
//!   server's environment (a known limit, docs/executor-routing.md).
//! - **Codex**: a named CODEX_HOME (routing_accounts) is that process's
//!   `CODEX_HOME`. An OpenAI key: `codex app-server` reads no CODEX_API_KEY,
//!   so the process runs in a home of Core's own (`codex-api-home`) with
//!   `-c cli_auth_credentials_store="ephemeral"`, and Core logs it in over its
//!   own connection (`account/login/start`, type apiKey) once it is
//!   initialized: the key is in no environment and on no disk.
//! - Profiles are for executors on this Core host: one on another machine is
//!   refused rather than started there.
use crate::{
    routing_accounts::{self, Launch as AccountLaunch},
    routing_keys::{op, Provider, Secret, Source, Store as KeyStore},
    store::Store,
    workspace::Workspace,
};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Which account or key an Agent's harness starts with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum RuntimeProfile {
    /// A claude-swap account, by its fingerprint (routing_accounts::fingerprint).
    #[serde(rename_all = "camelCase")]
    ClaudeAccount { fingerprint: String },
    /// A routing key, by its id (routing_keys).
    #[serde(rename_all = "camelCase")]
    ApiKey { key_id: String },
    /// A Codex account: a named CODEX_HOME, by its id (routing_accounts).
    #[serde(rename_all = "camelCase")]
    CodexHome { id: String },
}

/// What one Codex app-server process gets.
#[derive(Debug, Default)]
pub(crate) struct CodexLaunch {
    pub env: Vec<(String, Secret)>,
    /// Config overrides (`-c key=value`) for that process alone.
    pub args: Vec<String>,
    /// Logged in over the connection once it is initialized (`codex_login`).
    pub api_key: Option<Secret>,
}

/// The CODEX_HOME of Core's own that Codex executors with an OpenAI key run
/// in: credentials stay ephemeral there, so it holds their sessions only.
const CODEX_API_HOME: &str = "codex-api-home";

/// Logs a just-initialized app-server in with `key` (apiKey). What Codex
/// answers on a refusal is not passed on: it could quote the request.
pub(crate) async fn codex_login(rpc: &crate::rpc::Rpc, key: &Secret) -> Result<()> {
    rpc.request("account/login/start", serde_json::json!({"type": "apiKey", "apiKey": key.expose()})).await
        .map(|_| ())
        .map_err(|_| anyhow::anyhow!("Codex did not accept the routing key's login"))
}

/// What one Claude harness process gets.
#[derive(Debug, Default)]
pub(crate) struct ClaudeLaunch {
    pub env: Vec<(String, Secret)>,
    /// The Claude executable the bridge runs instead of `claude` on PATH.
    pub executable: Option<PathBuf>,
}

/// Runs on every open, idempotent: older Cores never create or read it.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_runtime_profiles(
            agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
            profile TEXT NOT NULL,
            updated_at TEXT NOT NULL);
        DELETE FROM agent_runtime_profiles WHERE agent_id NOT IN (SELECT id FROM agents);",
    )?;
    Ok(())
}

impl Store {
    pub(crate) fn runtime_profile(&self, agent: &str) -> Result<Option<RuntimeProfile>> {
        let raw: Option<String> = self.db.read()?
            .query_row("SELECT profile FROM agent_runtime_profiles WHERE agent_id=?1", [agent], |r| r.get(0)).optional()?;
        raw.map(|raw| serde_json::from_str(&raw).context("An Agent's runtime profile is not readable")).transpose()
    }

    /// Sets (or with None clears) an Agent's profile. Routing (S3) is its
    /// caller; it takes effect at the harness's next start.
    pub(crate) fn set_runtime_profile(&self, agent: &str, profile: Option<&RuntimeProfile>) -> Result<()> {
        let db = self.db.write()?;
        match profile {
            Some(profile) => db.execute(
                "INSERT INTO agent_runtime_profiles(agent_id,profile,updated_at) VALUES(?1,?2,?3)
                 ON CONFLICT(agent_id) DO UPDATE SET profile=excluded.profile, updated_at=excluded.updated_at",
                params![agent, serde_json::to_string(profile)?, chrono::Utc::now().to_rfc3339()],
            )?,
            None => db.execute("DELETE FROM agent_runtime_profiles WHERE agent_id=?1", [agent])?,
        };
        Ok(())
    }
}

impl Workspace {
    async fn profile_of(&self, id: &str) -> Result<Option<RuntimeProfile>> {
        let agent = id.to_owned();
        self.stored(move |store| store.runtime_profile(&agent)).await
    }

    /// Refuses a profile on an executor of another machine (v1: keys and
    /// accounts stay on this Core host).
    pub(crate) async fn refuse_remote_profile(&self, id: &str) -> Result<()> {
        if self.profile_of(id).await?.is_some() {
            bail!("This executor has a routing account or key, which is for executors on this Core host only: it does not start on another machine");
        }
        Ok(())
    }

    /// Refuses to fork an executor with a profile: its session lives in that
    /// account's home, and the fork, a new Agent, would start on another one.
    pub(crate) async fn refuse_profiled_fork(&self, id: &str) -> Result<()> {
        if self.profile_of(id).await?.is_some() {
            bail!("This executor runs with a routing account or key, and a fork of it would start on another: it cannot be forked");
        }
        Ok(())
    }

    /// What Agent `id`'s Claude bridge starts with: nothing without a profile.
    pub(crate) async fn claude_launch(&self, id: &str) -> Result<ClaudeLaunch> {
        match self.profile_of(id).await? {
            None => Ok(ClaudeLaunch::default()),
            Some(RuntimeProfile::ClaudeAccount { fingerprint }) => {
                let settings = self.stored(|store| store.cswap_settings()).await?;
                let accounts = routing_accounts::cswap_accounts(&settings.command).await
                    .map_err(|why| anyhow::anyhow!("{} / {}", why.message, why.message_zh))?;
                match routing_accounts::resolve(&accounts, &fingerprint) {
                    AccountLaunch::HostLogin => Ok(ClaudeLaunch::default()),
                    AccountLaunch::Session { number } => {
                        let python = routing_accounts::cswap_python(&settings.command)?;
                        let bridge = crate::claude_sdk::bridge_script(std::env::var_os("YUZUNO_CLAUDE_BRIDGE")).await?;
                        let executable = bridge.parent().context("The Claude runtime has no folder")?.join("cswap-claude");
                        anyhow::ensure!(executable.is_file(), "The claude-swap launcher {} is missing from the Claude runtime", executable.display());
                        Ok(ClaudeLaunch {
                            env: vec![
                                ("YUZUNO_CSWAP_PYTHON".into(), Secret::new(python.display().to_string())),
                                ("YUZUNO_CSWAP_ACCOUNT".into(), Secret::new(number.to_string())),
                            ],
                            executable: Some(executable),
                        })
                    }
                    AccountLaunch::Gone => bail!("The claude-swap account this executor is bound to is no longer listed: it does not start, and never as another account"),
                }
            }
            Some(RuntimeProfile::CodexHome { .. }) => bail!("A Codex home is a Codex executor's, not a Claude executor's"),
            Some(RuntimeProfile::ApiKey { key_id }) => {
                let (provider, key) = self.routing_key(&key_id).await?;
                anyhow::ensure!(provider == Provider::Anthropic, "Routing key {key_id} is not an Anthropic key, so a Claude executor cannot start with it");
                Ok(ClaudeLaunch {
                    env: vec![
                        ("ANTHROPIC_API_KEY".into(), key),
                        // Claude Code strips credentials from its Bash commands', hooks' and
                        // stdio MCP servers' environment (code.claude.com/docs/en/env-vars).
                        ("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB".into(), Secret::new("1".into())),
                    ],
                    executable: None,
                })
            }
        }
    }

    /// What Agent `id`'s `opencode serve` starts with: its provider's key
    /// variable, or nothing.
    pub(crate) async fn opencode_launch(&self, id: &str) -> Result<Vec<(String, Secret)>> {
        match self.profile_of(id).await? {
            None => Ok(Vec::new()),
            Some(RuntimeProfile::ClaudeAccount { .. }) => bail!("A claude-swap account is a Claude executor's, not an OpenCode executor's"),
            Some(RuntimeProfile::CodexHome { .. }) => bail!("A Codex home is a Codex executor's, not an OpenCode executor's"),
            Some(RuntimeProfile::ApiKey { key_id }) => {
                let (provider, key) = self.routing_key(&key_id).await?;
                // The variables OpenCode's providers read (models.dev).
                let name = match provider {
                    Provider::Deepseek => "DEEPSEEK_API_KEY",
                    Provider::Anthropic => "ANTHROPIC_API_KEY",
                    Provider::Openai => "OPENAI_API_KEY",
                };
                Ok(vec![(name.into(), key)])
            }
        }
    }

    /// What Agent `id`'s Codex app-server starts with: nothing without a profile.
    pub(crate) async fn codex_launch(&self, id: &str) -> Result<CodexLaunch> {
        match self.profile_of(id).await? {
            None => Ok(CodexLaunch::default()),
            Some(RuntimeProfile::ClaudeAccount { .. }) => bail!("A claude-swap account is a Claude executor's, not a Codex executor's"),
            Some(RuntimeProfile::CodexHome { .. }) => Ok(CodexLaunch { env: self.codex_home_env(id).await?, ..Default::default() }),
            Some(RuntimeProfile::ApiKey { key_id }) => {
                let (provider, key) = self.routing_key(&key_id).await?;
                anyhow::ensure!(provider == Provider::Openai, "Routing key {key_id} is not an OpenAI key, so a Codex executor cannot start with it");
                Ok(CodexLaunch {
                    env: self.codex_home_env(id).await?,
                    args: vec!["-c".into(), "cli_auth_credentials_store=\"ephemeral\"".into()],
                    api_key: Some(key),
                })
            }
        }
    }

    /// The CODEX_HOME Agent `id`'s own Codex runs in, also for reading its
    /// history and sub-agents with no connection: nothing for the host's own.
    /// A named home no longer listed refuses, never another home.
    pub(crate) async fn codex_home_env(&self, id: &str) -> Result<Vec<(String, Secret)>> {
        let home = match self.profile_of(id).await? {
            Some(RuntimeProfile::CodexHome { id: home }) => {
                let homes = self.stored(|store| store.codex_homes()).await?;
                homes.into_iter().find(|h| h.id == home).map(|h| PathBuf::from(h.home))
                    .with_context(|| format!("The Codex home {home} this executor is bound to is no longer listed: it does not start, and never in another home"))?
            }
            Some(RuntimeProfile::ApiKey { .. }) => {
                let home = self.data_dir.join(CODEX_API_HOME);
                if !home.is_dir() {
                    use std::os::unix::fs::DirBuilderExt;
                    std::fs::DirBuilder::new().mode(0o700).create(&home).with_context(|| format!("Cannot create {}", home.display()))?;
                }
                home
            }
            _ => return Ok(Vec::new()),
        };
        Ok(vec![("CODEX_HOME".into(), Secret::new(home.display().to_string()))])
    }

    /// A routing key's value: the local one, or read from 1Password once.
    /// Why it cannot be had is the error, never the value.
    async fn routing_key(&self, key_id: &str) -> Result<(Provider, Secret)> {
        let (dir, id) = (self.data_dir.clone(), key_id.to_owned());
        let source = tokio::task::spawn_blocking(move || KeyStore::of(&dir).source(&id)).await??;
        match source {
            None => bail!("Routing key {key_id} is not set"),
            Some((provider, Source::Local(secret))) => Ok((provider, secret)),
            Some((provider, Source::OnePassword { reference })) => {
                let key = op::read(&KeyStore::of(&self.data_dir), &reference).await
                    .map_err(|why| anyhow::anyhow!("Routing key {key_id}: {} / {}", why.message, why.message_zh))?;
                Ok((provider, key))
            }
        }
    }
}

#[cfg(test)]
#[path = "routing_launch_tests.rs"]
mod tests;
