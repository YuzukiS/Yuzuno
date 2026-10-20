//! Isolated acceptance host using the production router and official gh reads.
//! No native Harness is started. --resume accepts only this fixture workspace.
use anyhow::{Context, Result, ensure};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use yuzuno_workspace::{collaboration_mcp, model::AgentDetail, server, workspace::Workspace};
#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    ensure!(
        args.len() == 4 || (args.len() == 5 && args[4] == "--resume"),
        "usage: github_links_acceptance DATA_DIR UI_DIR PORT [--resume]"
    );
    let data = PathBuf::from(&args[1]);
    let assets = PathBuf::from(&args[2]);
    let port: u16 = args[3].parse()?;
    ensure!(
        port != 4317 && data.is_absolute(),
        "Use an isolated port and absolute data directory"
    );
    let resume = args.get(4).is_some();
    ensure!(
        data.exists() == resume,
        "Use a new acceptance directory, or explicitly resume its existing fixture"
    );
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let ws = Workspace::new(
        data.clone(),
        std::env::current_dir()?.to_string_lossy().into(),
        "unused-harness".into(),
    )?;
    let detail: AgentDetail = serde_json::from_value(
        json!({"agent":{"id":"github-fixture","name":"GitHub fixture (no model)","cwd":"/fixture","model":"fixture","color":"sage","threadId":null,"status":"offline","createdAt":"2026-10-14T00:00:00Z","updatedAt":"2026-10-14T00:00:00Z","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]}),
    )?;
    if resume {
        let agents = ws.store.agents()?;
        ensure!(
            agents.len() == 1 && agents[0].id == "github-fixture" && agents[0].thread_id.is_none(),
            "Resume accepts only the no-model GitHub fixture workspace"
        );
    } else {
        ws.store.insert(&detail)?;
    }
    let config = collaboration_mcp::agent_http_config(
        &ws,
        "github-fixture",
        &format!("http://127.0.0.1:{port}"),
    )?;
    let token = config["headers"]["Authorization"]
        .as_str()
        .context("Missing fixture credential")?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(data.join("mcp-auth"))?;
        f.write_all(token.as_bytes())?;
    }
    eprintln!("Isolated GitHub acceptance host on {port}; no Harness/model started");
    let events = Arc::clone(&ws.changes);
    axum::serve(listener, server::router_on_port(ws, assets, port))
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            events.close();
        })
        .await?;
    Ok(())
}
