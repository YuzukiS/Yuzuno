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
    /// Install a signed release, unpacked at --bundle, as a new managed
    /// installation (as `register --initialize`), and allow its updates from
    /// --repository signed with --public-key (release-source.json). Prints
    /// one JSON result. Starts nothing. Run by the unpacked release's helper.
    Install {
        #[arg(long)]
        install_dir: PathBuf,
        #[arg(long)]
        bundle: PathBuf,
        #[arg(long)]
        manifest_sha256: String,
        #[arg(long)]
        reviewed_source: String,
        /// GitHub owner/repo of the releases.
        #[arg(long)]
        repository: String,
        /// The publisher's minisign public key.
        #[arg(long)]
        public_key: String,
    },
    /// Start a new installation's Core for the first time, before it has
    /// recorded how it starts, with the environment of your login shell.
    /// Prints one JSON result; in WSL it then stays while that Core runs, as
    /// `start` does. It supervises nothing.
    FirstStart {
        #[arg(long)]
        install_dir: PathBuf,
        #[arg(long)]
        port: u16,
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        cwd: PathBuf,
        #[arg(long)]
        codex: Option<String>,
    },
    /// Start this installation's Core as it last started, unless it already
    /// answers on its port. Prints one JSON result; in WSL, after starting
    /// Core it stays while that Core runs, so WSL keeps the distribution
    /// running. It supervises nothing.
    Start {
        #[arg(long)]
        install_dir: PathBuf,
        #[arg(long)]
        port: u16,
        #[arg(long)]
        workspace_id: String,
        /// The phone's remote entry for Tailscale Serve: its loopback port,
        /// with --remote-origin and --remote-login. Checked as Core checks
        /// them; refused while Core runs.
        #[arg(long, requires_all = ["remote_origin", "remote_login"], conflicts_with = "no_remote")]
        remote_port: Option<u16>,
        #[arg(long, requires_all = ["remote_port", "remote_login"])]
        remote_origin: Option<String>,
        #[arg(long, requires_all = ["remote_port", "remote_origin"])]
        remote_login: Option<String>,
        /// Start without a remote entry, whatever was recorded.
        #[arg(long)]
        no_remote: bool,
    },
    /// Stop this installation's Core on its port (SIGINT on Linux, SIGTERM
    /// on macOS), only when it is the one process of this installation and
    /// was started with that port (and, on Linux, holds it). Prints one JSON
    /// result. Never kills.
    Stop {
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
        Command::Install {
            install_dir,
            bundle,
            manifest_sha256,
            reviewed_source,
            repository,
            public_key,
        } => {
            let outcome = yuzuno_workspace::updates::setup::install(
                &install_dir,
                &bundle,
                &manifest_sha256,
                &reviewed_source,
                &repository,
                &public_key,
            );
            println!("{outcome}");
            match outcome["state"].as_str() {
                Some("installed") => Ok(()),
                _ => std::process::exit(3),
            }
        }
        Command::FirstStart {
            install_dir,
            port,
            data_dir,
            cwd,
            codex,
        } => {
            use yuzuno_workspace::updates::{setup, start};
            let request = setup::FirstStart {
                root: install_dir,
                port,
                data_dir,
                cwd,
                codex,
            };
            let outcome = setup::first_start(&request, setup::FirstBudget::default());
            println!("{outcome}");
            match outcome["state"].as_str() {
                Some("started" | "starting") => start::stay(
                    &request.root,
                    port,
                    outcome["workspaceId"].as_str(),
                    std::env::var_os("WSL_DISTRO_NAME").as_deref(),
                    start::Keep::default(),
                ),
                _ => std::process::exit(3),
            }
        }
        Command::Start {
            install_dir,
            port,
            workspace_id,
            remote_port,
            remote_origin,
            remote_login,
            no_remote,
        } => {
            use yuzuno_workspace::updates::start;
            let remote = match (remote_port, remote_origin, remote_login) {
                (Some(port), Some(origin), Some(login)) => start::Remote::Set { port, origin, login },
                _ if no_remote => start::Remote::Off,
                _ => start::Remote::Recorded,
            };
            let outcome = start::start_with(&install_dir, port, &workspace_id, &remote, start::Budget::default());
            println!("{outcome}");
            match outcome["state"].as_str() {
                Some("started" | "starting") => start::stay(
                    &install_dir,
                    port,
                    Some(&workspace_id),
                    std::env::var_os("WSL_DISTRO_NAME").as_deref(),
                    start::Keep::default(),
                ),
                Some("running") => Ok(()),
                _ => std::process::exit(3),
            }
        }
        Command::Stop {
            install_dir,
            port,
            workspace_id,
        } => {
            use yuzuno_workspace::updates::start;
            let outcome = start::stop(&install_dir, port, &workspace_id, start::StopBudget::default());
            println!("{outcome}");
            match outcome["state"].as_str() {
                Some("stopped" | "notRunning") => Ok(()),
                _ => std::process::exit(3),
            }
        }
    }
}
