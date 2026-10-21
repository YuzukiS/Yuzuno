use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(about = "Yuzuno managed release helper; not a general process supervisor")]
struct Options {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Read-only, single-snapshot validation; the update helper bounds its lifetime.
    VerifyRecords {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        workspace_id: String,
    },
    /// Register a reviewed, already-built local package. Does not start Core.
    Register {
        #[arg(long)]
        install_dir: PathBuf,
        #[arg(long)]
        bundle: PathBuf,
        #[arg(long)]
        manifest_sha256: String,
        #[arg(long)]
        reviewed_source: String,
        /// Initialize a fresh managed root; refuses an existing installation.
        #[arg(long)]
        initialize: bool,
    },
    Run {
        #[arg(long)]
        install_dir: PathBuf,
        #[arg(long)]
        operation: String,
    },
    /// Start this installation's Core as it last started, unless it already
    /// answers on its port. Prints one JSON result; after starting Core it
    /// stays while that Core runs, so WSL keeps the distribution running.
    /// It supervises nothing.
    Start {
        #[arg(long)]
        install_dir: PathBuf,
        #[arg(long)]
        port: u16,
        #[arg(long)]
        workspace_id: String,
    },
}
fn main() -> anyhow::Result<()> {
    match Options::parse().command {
        Command::VerifyRecords {
            data_dir,
            workspace_id,
        } => {
            let proof = yuzuno_workspace::updates::storage::verify_at(&data_dir, &workspace_id)?;
            println!("{}", serde_json::to_string(&proof)?);
            Ok(())
        }
        Command::Register {
            install_dir,
            bundle,
            manifest_sha256,
            reviewed_source,
            initialize,
        } => yuzuno_workspace::updates::catalog::register(
            &install_dir,
            &bundle,
            &manifest_sha256,
            &reviewed_source,
            initialize,
        ),
        Command::Run {
            install_dir,
            operation,
        } => yuzuno_workspace::updates::helper::run(&install_dir, &operation),
        Command::Start {
            install_dir,
            port,
            workspace_id,
        } => {
            use yuzuno_workspace::updates::start;
            let outcome = start::start(&install_dir, port, &workspace_id, start::Budget::default());
            println!("{outcome}");
            match outcome["state"].as_str() {
                Some("started" | "starting") => {
                    start::keep_running(&install_dir, port, &workspace_id, start::Keep::default())
                }
                Some("running") => Ok(()),
                _ => std::process::exit(3),
            }
        }
    }
}
