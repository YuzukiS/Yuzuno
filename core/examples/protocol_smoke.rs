//! A real Workspace -> Codex stdio -> SQLite smoke probe, without an HTTP listener.
//!
//! Run only with a newly created, empty CODEX_HOME under the system temporary
//! directory and a clean subprocess environment. No existing authentication or
//! workspace is loaded. The optional first argument is the JSON report path.
//! A successful probe proves native protocol handling and persistence, not a
//! successful model response (the test deliberately has no credentials).

#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{path::Path, path::PathBuf, sync::Arc, time::Duration};
use tokio::time::{sleep, Instant};
use yuzuno_workspace::{model::AgentDetail, store::Store, workspace::Workspace};

const MESSAGE: &str = "YUZUNO_CORE_PROTOCOL_SMOKE: reply with OK only; do not run tools.";

fn has_user_message(detail: &AgentDetail) -> bool {
    detail.turns.iter().any(|turn| {
        turn["items"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["type"] == "userMessage"
                    && item["content"]
                        .as_array()
                        .is_some_and(|content| content.iter().any(|part| part["text"] == MESSAGE))
            })
        })
    })
}

fn journal_kinds(path: &Path, agent_id: &str) -> Result<Vec<String>> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query = db.prepare("SELECT kind FROM journal WHERE agent_id=?1 ORDER BY seq")?;
    let rows = query.query_map([agent_id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

async fn wait_for(
    workspace: &Arc<Workspace>,
    agent_id: &str,
    label: &str,
    predicate: impl Fn(&AgentDetail) -> bool,
) -> Result<AgentDetail> {
    let deadline = Instant::now() + Duration::from_secs(55);
    loop {
        let detail = workspace.store.detail(agent_id)?;
        if predicate(&detail) {
            return Ok(detail);
        }
        if detail.agent.status == "error" && detail.agent.thread_id.is_none() {
            bail!(
                "{label}: native runtime failed: {}",
                detail.agent.error.as_deref().unwrap_or("unknown error")
            );
        }
        if Instant::now() >= deadline {
            bail!(
                "{label}: timeout; status={}, error={:?}",
                detail.agent.status,
                detail.agent.error
            );
        }
        sleep(Duration::from_millis(50)).await;
    }
}

async fn exercise(root: &Path, report: &mut Value) -> Result<AgentDetail> {
    let work_dir = root.join("task");
    std::fs::create_dir_all(&work_dir)?;
    let workspace = Workspace::new(
        root.join("workspace"),
        work_dir.to_string_lossy().into_owned(),
        "codex".into(),
    )?;
    let created = workspace
        .create(
            "Protocol smoke".into(),
            "Verify the real native event path and preserve this identity".into(),
            work_dir.to_string_lossy().into_owned(),
            String::new(),
        )
        .await?;
    report["agentId"] = created.id.clone().into();
    let ready = wait_for(&workspace, &created.id, "create -> ready", |detail| {
        detail.agent.thread_id.is_some() && detail.agent.status == "idle"
    })
    .await?;
    report["threadId"] = json!(ready.agent.thread_id);
    report["ready"] = true.into();
    println!("Real Codex thread is ready");

    let accepted = workspace.send(&created.id, MESSAGE.into()).await?;
    let turn_id = accepted["turnId"]
        .as_str()
        .context("Workspace.send did not return a native turn ID")?
        .to_owned();
    report["turnId"] = turn_id.clone().into();
    let native = wait_for(&workspace, &created.id, "native user item", |detail| {
        has_user_message(detail)
            && detail
                .turns
                .iter()
                .any(|turn| turn["id"] == turn_id && turn["status"] == "inProgress")
    })
    .await?;
    report["nativeUserMessageObserved"] = has_user_message(&native).into();
    println!("Native user item reached Workspace storage");

    workspace.interrupt(&created.id).await?;
    report["interruptAcknowledged"] = true.into();
    let terminal = wait_for(&workspace, &created.id, "native turn/completed", |detail| {
        detail
            .turns
            .iter()
            .any(|turn| turn["id"] == turn_id && turn["status"] == "interrupted")
    })
    .await?;
    let kinds = journal_kinds(&root.join("workspace/workspace.sqlite"), &created.id)?;
    ensure!(
        kinds.iter().any(|kind| kind == "turn/completed"),
        "No native turn/completed event was journaled"
    );
    ensure!(
        has_user_message(&terminal),
        "Interrupt lost the user message"
    );
    report["turnCompletedJournaled"] = true.into();
    report["journalKindsBeforeRestart"] = json!(kinds);
    report["beforeRestart"] = serde_json::to_value(&terminal)?;
    println!("Native interrupted completion is journaled; user message remains");
    drop(workspace);
    Ok(terminal)
}

fn main() -> Result<()> {
    let profile = PathBuf::from(std::env::var_os("CODEX_HOME").context(
        "Set CODEX_HOME to a freshly created empty temporary profile; default auth is forbidden",
    )?)
    .canonicalize()?;
    ensure!(
        profile.starts_with(std::env::temp_dir().canonicalize()?),
        "Refusing to use a profile outside the system temporary directory"
    );
    ensure!(
        !profile.join("auth.json").exists(),
        "Refusing a profile containing existing credentials"
    );
    ensure!(
        std::fs::read_to_string(profile.join("config.toml"))?
            .contains("cli_auth_credentials_store = \"file\""),
        "Use file credential storage in the empty temporary profile"
    );
    for name in ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY"] {
        ensure!(
            std::env::var_os(name).is_none(),
            "Refusing inherited credential variable {name}; use a clean subprocess environment"
        );
    }
    let root = tempfile::Builder::new()
        .prefix("yuzuno-core-smoke-")
        .tempdir()?
        .keep();
    let output = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("core-observations.json"));
    let mut report = json!({
        "kind": "real-workspace-native-protocol-smoke",
        "timestamp": yuzuno_workspace::model::now(),
        "root": root,
        "codexHome": profile,
        "authenticated": false,
        "successfulInferenceClaimed": false,
        "httpListenerUsed": false,
    });
    let runtime = tokio::runtime::Runtime::new()?;
    let run = runtime.block_on(exercise(&root, &mut report));
    // Dropping just the caller's Arc would leave spawned tasks alive. Shutting
    // down this dedicated runtime drops them and their owned Codex subprocess.
    drop(runtime);
    let outcome = run.and_then(|before| {
        let reopened = Store::open(&root.join("workspace/workspace.sqlite"))?;
        let after = reopened.detail(&before.agent.id)?;
        let checks = json!({
            "agentIdentityPreserved": after.agent.id == before.agent.id && after.agent.name == before.agent.name && after.agent.goal == before.agent.goal,
            "nativeThreadPreserved": after.agent.thread_id == before.agent.thread_id,
            "turnsPreserved": after.turns == before.turns,
            "userMessagePreserved": has_user_message(&after),
            "restartDoesNotClaimRuntimeAlive": after.agent.status == "offline",
        });
        report["checks"] = checks.clone();
        report["afterStoreReopen"] = serde_json::to_value(after)?;
        ensure!(
            checks.as_object().unwrap().values().all(|check| check == true),
            "One or more persistence checks failed"
        );
        println!("Agent identity, native thread, interrupted Turn, and user message survive Store reopen");
        Ok(())
    });
    report["passed"] = outcome.is_ok().into();
    if let Err(error) = &outcome {
        report["error"] = format!("{error:#}").into();
    }
    if let Some(parent) = output.parent().filter(|path| !path.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&output, serde_json::to_string_pretty(&report)? + "\n")?;
    println!("Report: {}", output.display());
    outcome
}
