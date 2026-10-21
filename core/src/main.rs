use anyhow::Context;
use clap::Parser;
use std::{future::IntoFuture, path::PathBuf, sync::Arc};
use yuzuno_workspace::{
    server,
    updates::{
        self,
        controller::Controller,
        lifecycle::WorkspaceRuntime,
        state::{Launch, Layout},
    },
    workspace::Workspace,
};

/// Yuzuno Core. Runs independently of any desktop or browser client.
#[derive(Parser)]
#[command(version, about)]
struct Options {
    /// Managed, owner-controlled release root. Packaged Core/UI/bridge assets
    /// must all belong to this running executable's verified release.
    #[arg(long, env = "YUZUNO_INSTALL_DIR")]
    install_dir: Option<PathBuf>,
    /// Loopback port; Windows clients can use WSL localhost forwarding.
    #[arg(long, env="YUZUNO_CORE_PORT", default_value_t=4317, value_parser=clap::value_parser!(u16).range(1..))]
    port: u16,
    /// Workspace identity, event history and read-state storage on the Core host.
    #[arg(long, env = "YUZUNO_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// Production UI assets served to all clients.
    #[arg(long, env = "YUZUNO_WEB_DIR", default_value = "web/dist")]
    web_dir: PathBuf,
    /// Default task directory on the Core host, not on the desktop client.
    #[arg(long, env = "YUZUNO_DEFAULT_CWD")]
    cwd: Option<PathBuf>,
    /// Official Codex executable installed and authenticated on the Core host.
    #[arg(long, env = "YUZUNO_CODEX_BIN", default_value = "codex")]
    codex: String,
    /// Store every Agent record whole again, as Core builds before record
    /// rows read them, then exit. Core must not be running.
    #[arg(long)]
    revert_record_rows: bool,
    /// Move a Workspace that builds before this one kept in the old default
    /// folder (yuzuno-next) to the new one, leaving a link at the old path,
    /// then exit. Core must not be running; see README, Data.
    #[arg(long)]
    move_workspace: bool,
}

/// Store work runs on Tokio's blocking pool (see `db`). It never needs more
/// than a few threads at once; the bound keeps a burst of GUI reads from
/// starting hundreds of threads, each with its own allocator state.
const MAX_BLOCKING_THREADS: usize = 32;

fn main() -> anyhow::Result<()> {
    limit_malloc_arenas();
    let mut options = Options::parse();
    if options.move_workspace {
        return move_workspace(&options);
    }
    let (layout, bundle) = if let Some(root) = &options.install_dir {
        let layout = Layout::open(root)?;
        let bundle = updates::helper::running_bundle(&layout)?;
        options.web_dir = bundle.path.join("web");
        // Set once before any runtime threads exist. A managed release must
        // never resolve bridge assets through its build machine's checkout.
        std::env::set_var(
            "YUZUNO_CLAUDE_BRIDGE",
            bundle.path.join("runtimes/claude/bridge.mjs"),
        );
        // Optional: an older release without it only lacks the validator.
        std::env::set_var(
            "YUZUNO_RESULT_VALIDATOR",
            yuzuno_workspace::results::release_validator(&bundle),
        );
        // Only the release's own Windows Jobs helper, checked against its
        // signed digest before each run; none in an older release.
        let (helper, sha256) = yuzuno_workspace::jobs::release_windows_helper(&bundle);
        std::env::set_var("YUZUNO_WINDOWS_JOBS_HELPER", helper);
        std::env::set_var("YUZUNO_WINDOWS_JOBS_HELPER_SHA256", sha256);
        // yuzuno_guide names the release whose guide it serves.
        let manifest = &bundle.manifest;
        yuzuno_workspace::guide::set_release(&manifest.release_id, &manifest.version, &manifest.git_sha);
        (Some(layout), Some(bundle))
    } else {
        (None, None)
    };
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .max_blocking_threads(MAX_BLOCKING_THREADS)
        .build()?
        .block_on(run(options, layout, bundle))
}

/// glibc gives each new thread its own malloc arena (up to 8 per core), and
/// freed multi-megabyte records stay cached in each. Two arenas keep peak
/// memory near what one thread would use. Must run before any thread starts.
fn limit_malloc_arenas() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: mallopt only adjusts allocator tuning; no other thread exists yet.
    unsafe {
        libc::mallopt(libc::M_ARENA_MAX, 2);
    }
}

async fn run(
    options: Options,
    layout: Option<Layout>,
    bundle: Option<updates::package::Bundle>,
) -> anyhow::Result<()> {
    // Not told: the platform's data folder, classified before anything is
    // made there (see data_dir).
    let data = match options.data_dir {
        Some(data) => data,
        None => {
            let base = dirs::data_local_dir().context("Cannot determine the workspace data directory; set --data-dir")?;
            let chosen = yuzuno_workspace::data_dir::resolve(&base)?;
            if chosen.legacy {
                eprintln!(
                    "Workspace: {}, where builds before this one kept it; it stays there unless you move it with Core stopped: yuzuno-workspace --move-workspace (see README, Data).",
                    chosen.path.display()
                );
            }
            chosen.path
        }
    };
    if options.revert_record_rows {
        return revert_record_rows(&data.join("workspace.sqlite"));
    }
    let remote = remote_entry(options.port)?;
    // Bind before touching the database: another process must not mark a live
    // workspace offline. Windows-to-WSL uses localhost, without LAN exposure.
    let listener=tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,options.port))
        .await.context("Cannot bind Core's loopback port; check permissions or whether Core is already running")?;
    let remote = match remote {
        Some((port, entry)) => Some((
            tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
                .await.context("Cannot bind the remote entry's loopback port (YUZUNO_REMOTE_PORT)")?,
            port,
            entry,
        )),
        None => None,
    };
    let cwd = options.cwd.unwrap_or(std::env::current_dir()?);
    if let Some(layout) = &layout {
        let absolute = std::path::absolute(&data)?;
        anyhow::ensure!(
            !absolute.starts_with(layout.root.join("releases"))
                && !absolute.starts_with(layout.root.join("incoming")),
            "Workspace data must live outside release packages"
        );
    }
    let (workspace_data, workspace_cwd, program) = (data.clone(), cwd.to_string_lossy().into_owned(), options.codex.clone());
    let ws = yuzuno_workspace::db::blocking(move || Workspace::new(workspace_data, workspace_cwd, program)).await?;
    let launch = Launch {
        port: options.port,
        data_dir: std::fs::canonicalize(&data)?,
        cwd: std::fs::canonicalize(&cwd)?,
        codex: options.codex,
    };
    let updates = Controller::new(
        layout,
        bundle,
        launch,
        Arc::new(WorkspaceRuntime(ws.clone())),
        ws.admission.clone(),
    )?;
    if updates.layout.is_some() {
        updates::control::listen(updates.clone())?;
        updates.monitor();
    }
    ws.start_remote_recovery();
    ws.start_claude_quota_resume();
    let probe = Arc::clone(&ws);
    let check = updates.clone();
    tokio::spawn(async move {
        while probe.admission.snapshot().operation_id.is_some() {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        // A replacement must restore native sessions before background bundle
        // hashing can own the transition lock needed by Restore and Finish.
        if check.layout.is_some() {
            tokio::spawn(async move {
                if let Err(error) = check.check().await {
                    eprintln!("Local release catalog: {error:#}");
                }
            });
        }
        if let Err(e) = probe.catalog().await {
            probe.set_runtime(serde_json::json!({"connected":false,"error":e.to_string()})).await;
        }
    });
    eprintln!(
        "Yuzuno Core: http://127.0.0.1:{} (desktop clients connect independently)",
        options.port
    );
    let events = ws.changes.clone();
    let signal = updates.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        signal.shutdown.send_replace(true);
    });
    let mut shutdown = updates.shutdown.subscribe();
    // Leaving the Workspace, older Cores may open it again if nothing in it is
    // what they would mishandle (older_cores.rs).
    let store = ws.store.clone();
    if let Some((listener, port, entry)) = remote {
        eprintln!("Remote entry: http://127.0.0.1:{port} for Tailscale Serve, as {}", entry.origin());
        let app = server::remote_router(ws.clone(), options.web_dir.clone(), Some(updates.clone()), entry);
        let mut stop = updates.shutdown.subscribe();
        tokio::spawn(async move {
            let served = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    while !*stop.borrow_and_update() {
                        if stop.changed().await.is_err() {
                            break;
                        }
                    }
                })
                .await;
            if let Err(error) = served {
                eprintln!("Remote entry stopped: {error}");
            }
        });
    }
    let graceful = axum::serve(
        listener,
        server::router_with_updates(ws, options.web_dir, options.port, Some(updates.clone())),
    )
    .with_graceful_shutdown(async move {
        while !*shutdown.borrow_and_update() {
            if shutdown.changed().await.is_err() {
                break;
            }
        }
        events.close();
    })
    .into_future();
    let mut shutdown_deadline = updates.shutdown.subscribe();
    tokio::select! {
        result = graceful => result?,
        _ = async {
            while !*shutdown_deadline.borrow_and_update() { if shutdown_deadline.changed().await.is_err() { break; } }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        } => eprintln!("Core shutdown: closing remaining client streams after native work and events drained"),
    }
    yuzuno_workspace::db::blocking(move || { store.settle_older_cores(); Ok(()) }).await?;
    Ok(())
}

/// The phone entry through Tailscale Serve (T-170; docs/independent-core.md),
/// a second loopback port that only Serve is pointed at. It is read from the
/// environment, not from options: a Core update starts the new Core with only
/// its own options but the same environment, so the entry stays.
fn remote_entry(core_port: u16) -> anyhow::Result<Option<(u16, server::RemoteEntry)>> {
    let var = |name: &str| match std::env::var(name) {
        Ok(value) if value.is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(anyhow::anyhow!("{name}: {error}")),
    };
    server::RemoteEntry::from_settings(var("YUZUNO_REMOTE_PORT")?, var("YUZUNO_REMOTE_ORIGIN")?, var("YUZUNO_REMOTE_LOGIN")?, core_port)
}

/// `--move-workspace` (data_dir::move_legacy). A development build can be
/// held at a step (YUZUNO_MOVE_PAUSE names it; it waits in
/// YUZUNO_MOVE_PAUSE_DIR for a `go` file) for the interruption tests.
fn move_workspace(options: &Options) -> anyhow::Result<()> {
    anyhow::ensure!(options.data_dir.is_none(),
        "--move-workspace moves only the default Workspace folder; it takes no --data-dir or YUZUNO_DATA_DIR");
    let base = dirs::data_local_dir().context("Cannot determine the platform's data folder")?;
    let mut step = |name: &str| -> anyhow::Result<()> {
        if cfg!(debug_assertions) && std::env::var("YUZUNO_MOVE_PAUSE").is_ok_and(|at| at == name) {
            let dir = std::path::PathBuf::from(std::env::var("YUZUNO_MOVE_PAUSE_DIR")?);
            std::fs::write(dir.join("paused"), format!("{name} {}", std::process::id()))?;
            while !dir.join("go").exists() {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        Ok(())
    };
    match yuzuno_workspace::data_dir::move_legacy(&base, options.install_dir.as_deref(), &mut step)? {
        yuzuno_workspace::data_dir::Moved::Moved(path) => println!(
            "Moved the Workspace to {}; {} links to it.", path.display(), base.join(yuzuno_workspace::data_dir::LEGACY).display()),
        yuzuno_workspace::data_dir::Moved::AlreadyMoved(path) => println!("The Workspace already is in {}.", path.display()),
    }
    Ok(())
}

/// `--revert-record-rows`: for going back to a Core build from before record
/// rows. Takes the Workspace lock, so it refuses while a Core runs.
fn revert_record_rows(path: &std::path::Path) -> anyhow::Result<()> {
    anyhow::ensure!(path.exists(), "No Workspace database at {}", path.display());
    let done = yuzuno_workspace::record_rows::revert_workspace(path)?;
    println!("Stored {} Agent records whole again in {}.", done.agents.len() + done.salvaged.len(), path.display());
    for (id, s) in &done.salvaged {
        println!("  Agent {id}: its rows did not fit together. Given back: {} Turns, {} Items{}. Marked _yuzunoSalvage: {} Turns, {} Items, {} payloads (preview kept) lost; {} payload rows belonged to no Item. All {} rows it had are kept in agent_salvage.",
            s.turns, s.items, if s.metadata_from_original { " (metadata from before the conversion)" } else { "" },
            s.lost_turns, s.lost_items, s.lost_payloads, s.stray_payloads, s.rows_kept);
    }
    for (id, error) in &done.failed {
        println!("  Agent {id}: left as it was: {error}");
    }
    anyhow::ensure!(done.failed.is_empty(), "Some records could not be stored whole; an older Core cannot open this Workspace yet.");
    Ok(())
}
