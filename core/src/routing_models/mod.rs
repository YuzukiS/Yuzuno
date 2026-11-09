//! The models executor routing's model picker offers for OpenCode (YN-57 S2a):
//! what a new executor's OpenCode would list.
//!
//! Claude Code's and Codex's are their existing catalogs (`/api/models`). An
//! OpenCode Agent's is its own running OpenCode's (`/api/agents/:id/models`),
//! with its own logins. A routed executor's OpenCode starts with a database
//! of its own (no login), the user's OpenCode config, Core's environment and,
//! when its candidate has one, an API key's variable; and OpenCode lists only
//! the providers it can reach. So the catalog is read from an OpenCode
//! started the same way, once, for this read only:
//!
//! - a throwaway database and XDG folders under `opencode/catalogs/` in the
//!   Workspace folder, and the cache Core's Agents share;
//! - Core's default folder as its folder, with models.dev fetching off, as
//!   every OpenCode Core starts;
//! - in place of a key, [`PLACEHOLDER`] in each variable routing gives an
//!   OpenCode executor a key by (routing_launch.rs), so that it lists those
//!   providers' models. It holds no key at all: never a routing key, and not
//!   Core's own variable of that name either. OpenCode lists models without
//!   asking a provider (`OPENCODE_DISABLE_MODELS_FETCH`).
//!
//! It runs at most [`LIMIT`]; then, on an error, or when the request that
//! started it goes away, its process group is killed and its folder removed.
//! One runs at a time: a request that comes while one runs waits for it and
//! takes its answer.
pub mod routes;
#[cfg(test)]
mod tests;

use crate::{
    opencode::{Launch, Server},
    opencode_agent::catalog_of,
    routing_keys::Secret,
    workspace::Workspace,
};
use anyhow::{anyhow, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

/// What the catalog's OpenCode has in place of a key: plainly not one.
pub(crate) const PLACEHOLDER: &str = "yuzuno-catalog-only-not-a-key";
/// The variables an OpenCode executor gets its routing key by, per provider
/// (routing_launch.rs `opencode_launch`).
pub(crate) const KEY_VARIABLES: [(&str, &str); 3] =
    [("deepseek", "DEEPSEEK_API_KEY"), ("anthropic", "ANTHROPIC_API_KEY"), ("openai", "OPENAI_API_KEY")];
/// How long one read may take, its OpenCode's start included.
pub(crate) const LIMIT: Duration = Duration::from_secs(20);
/// How long its OpenCode may take to end once the catalog is read.
const TEARDOWN: Duration = Duration::from_secs(3);

/// How a read's OpenCode runs: the Workspace's, or a test's.
pub(crate) struct Run {
    pub program: PathBuf,
    /// The folder it serves.
    pub directory: PathBuf,
    /// Where its throwaway folder is made, one per read.
    pub catalogs: PathBuf,
    /// The cache Core's Agents share.
    pub cache: PathBuf,
    pub limit: Duration,
    /// Whether Core's own environment has a variable (never its value).
    pub present: fn(&str) -> bool,
}

/// The newest answer per Workspace folder, and when it was ready: a request
/// that waited behind a read takes the answer that read gave.
static LAST: LazyLock<Mutex<HashMap<PathBuf, (Instant, Result<Value, String>)>>> = LazyLock::new(Default::default);

impl Workspace {
    /// `GET /api/routing/models?harness=opencode`.
    pub async fn routing_opencode_catalog(self: &Arc<Self>) -> Result<Value> {
        ensure!(crate::opencode_agent::enabled(), "This Core was started with OpenCode Agents off (YUZUNO_EXPERIMENTAL_OPENCODE=0)");
        let _permit = self.admission.enter_work()?;
        let folder = Path::new(&self.default_cwd);
        let run = Run {
            program: crate::opencode_agent::program(),
            directory: if folder.is_absolute() && folder.is_dir() { folder.into() } else { self.data_dir.clone() },
            catalogs: self.data_dir.join("opencode").join("catalogs"),
            cache: self.data_dir.join("opencode").join("cache"),
            limit: LIMIT,
            present: |name| std::env::var_os(name).is_some(),
        };
        let asked = Instant::now();
        let gate = self.gate("_routing_opencode_catalog").await;
        let _held = gate.lock().await;
        // One that finished while this request waited answers it too.
        if let Some((at, answer)) = LAST.lock().unwrap().get(&self.data_dir) {
            if *at >= asked {
                return answer.clone().map_err(|error| anyhow!(error));
            }
        }
        let answer = read(&run).await.map_err(|error| format!("{error:#}"));
        LAST.lock().unwrap().insert(self.data_dir.clone(), (Instant::now(), answer.clone()));
        answer.map_err(|error| anyhow!(error))
    }
}

/// A read's folder, removed when it is dropped: after its read, or when the
/// read is cut short. Declared after the server it holds, so it is removed
/// once that is ended.
struct Throwaway(PathBuf);

impl Drop for Throwaway {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A read's OpenCode and its folder, in the order they are dropped: the
/// server first (its process group killed), then the folder.
struct Reading {
    server: Option<Server>,
    _folder: Throwaway,
}

/// One catalog, read from an OpenCode started for it, within `run.limit`.
pub(crate) async fn read(run: &Run) -> Result<Value> {
    // Only one read runs at a time, so a folder already there is one a read
    // cut short by a stop left behind.
    if let Ok(entries) = std::fs::read_dir(&run.catalogs) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let folder = run.catalogs.join(uuid::Uuid::new_v4().simple().to_string());
    for made in [&folder, &run.cache] {
        std::fs::create_dir_all(made).with_context(|| format!("Could not make {}", made.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(made, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    let mut reading = Reading { server: None, _folder: Throwaway(folder.clone()) };
    let mut launch = Launch::new(run.program.clone(), run.directory.clone(), &folder, run.cache.clone());
    // A placeholder in every key variable, Core's own included: no key reaches it.
    launch.extra = KEY_VARIABLES.iter().map(|(_, name)| ((*name).to_owned(), Secret::new(PLACEHOLDER.into()))).collect();
    let listed = tokio::time::timeout(run.limit, async {
        reading.server = Some(Server::start(&launch).await?);
        let server = reading.server.as_ref().expect("just started");
        let models = server.models().await?;
        Ok::<_, anyhow::Error>(catalog_of(server, &models).await)
    })
    .await;
    let mut catalog = match listed {
        Ok(listed) => listed?,
        Err(_) => return Err(anyhow!("OpenCode did not list its models within {} s", run.limit.as_secs())),
    };
    // Ended in good order, briefly: it holds no session, so one slower than
    // that is killed when its shutdown is dropped. On any other way out,
    // `reading` is dropped, which kills its group.
    if let Some(server) = reading.server.take() {
        let _ = tokio::time::timeout(TEARDOWN, server.shutdown()).await;
    }
    drop(reading);
    mark_key_providers(&mut catalog, run.present);
    Ok(catalog)
}

/// A provider OpenCode reaches only through a placeholder is one an executor
/// reaches only with a routing key of it: `routingKey`, with that provider.
/// One Core's own environment gives every executor stays `env`.
fn mark_key_providers(catalog: &mut Value, present: fn(&str) -> bool) {
    let Some(providers) = catalog["providers"].as_array_mut() else { return };
    for provider in providers {
        let Some((id, variable)) = KEY_VARIABLES.iter().find(|(id, _)| provider["id"] == *id) else { continue };
        if provider["source"] == "env" && !present(variable) {
            provider["source"] = json!("routingKey");
            provider["keyProvider"] = json!(id);
        }
    }
}
