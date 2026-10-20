//! Private bare object store. No checkout, worktree discovery or repository
//! programs. Every caller supplies structured arguments and fixed object IDs.
use anyhow::{Context, Result, ensure};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};

pub(super) const DISK_BUDGET: u64 = 256 * 1024 * 1024;
const METADATA_BUDGET: usize = 16 * 1024 * 1024;

pub(super) struct Git {
    pub path: PathBuf,
}

// A lazy blob fetch can spawn git-remote-https and credential helpers. Killing
// only the parent on cancellation would leave these running outside the review.
struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = rustix::process::Pid::from_raw(self.0 as i32) {
            let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
        }
    }
}

impl Git {
    fn command(&self) -> Command {
        let mut cmd = Command::new("git");
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                cmd.env_remove(key);
            }
        }
        cmd.env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .env("GH_PROMPT_DISABLED", "1")
            .env_remove("GH_DEBUG")
            .env("LC_ALL", "C")
            .args(["--no-pager", "--literal-pathspecs"])
            .arg(format!("--git-dir={}", self.path.display()))
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.attributesFile=/dev/null",
                "-c",
                "credential.helper=",
                "-c",
                "credential.helper=!gh auth git-credential",
                "-c",
                "protocol.allow=never",
                "-c",
                "protocol.https.allow=always",
                "-c",
                "http.followRedirects=false",
                "-c",
                "maintenance.auto=false",
                "-c",
                "gc.auto=0",
                "-c",
                "pack.threads=1",
                "-c",
                "fetch.fsckObjects=true",
            ])
            .current_dir(self.path.parent().unwrap())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);
        cmd
    }

    pub async fn create(directory: &Path, repo: &str, commits: &[&str]) -> Result<Self> {
        // Only an API-verified canonical GitHub repository can become a remote.
        crate::github::client::parse(repo, false)?;
        let git = Self {
            path: directory.join("objects.git"),
        };
        ensure!(!git.path.exists(), "Review object store already exists");
        git.run(
            &["init", "--bare", "--template=", "--quiet"],
            METADATA_BUDGET,
        )
        .await?;
        git.run(
            &[
                "config",
                "remote.origin.url",
                &format!("https://github.com/{repo}.git"),
            ],
            4096,
        )
        .await?;
        git.run(&["config", "remote.origin.promisor", "true"], 4096)
            .await?;
        git.run(
            &["config", "remote.origin.partialclonefilter", "blob:none"],
            4096,
        )
        .await?;
        let mut args = vec![
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-recurse-submodules",
            "--depth=1",
            "--filter=blob:none",
            "origin",
        ];
        args.extend_from_slice(commits);
        git.run(&args, METADATA_BUDGET).await?;
        for commit in commits {
            let identity = git
                .run(
                    &["rev-parse", "--verify", &format!("{commit}^{{commit}}")],
                    4096,
                )
                .await?;
            ensure!(
                String::from_utf8(identity)?.trim() == *commit,
                "Fetched commit identity differs from the frozen revision"
            );
        }
        Ok(git)
    }

    pub async fn metadata(&self, args: &[&str]) -> Result<Vec<u8>> {
        self.run(args, METADATA_BUDGET).await
    }

    pub async fn run(&self, args: &[&str], limit: usize) -> Result<Vec<u8>> {
        let used = disk_usage(&self.path)?;
        ensure!(
            used < DISK_BUDGET,
            "Review object storage budget exhausted (256 MiB)"
        );
        let limit = limit.min((DISK_BUDGET - used) as usize);
        let mut child = self
            .command()
            .args(args)
            .spawn()
            .context("Git is required for fixed-revision source access")?;
        let _group = ProcessGroup(child.id().context("Missing source process id")?);
        let mut stdout = child
            .stdout
            .take()
            .context("Missing git stdout")?
            .take(limit as u64 + 1);
        let mut stderr = child
            .stderr
            .take()
            .context("Missing git stderr")?
            .take(65537);
        let operation = async {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            // Reject each pipe as soon as it fills. Waiting for both EOFs first
            // deadlocks when Git blocks writing the already-full stdout pipe.
            tokio::try_join!(
                async {
                    stdout.read_to_end(&mut out).await?;
                    ensure!(
                        out.len() <= limit,
                        "Fixed source operation exceeded its byte budget; coverage is incomplete"
                    );
                    Ok::<_, anyhow::Error>(())
                },
                async {
                    stderr.read_to_end(&mut err).await?;
                    ensure!(
                        err.len() <= 65536,
                        "Fixed source diagnostics exceeded their byte budget; coverage is incomplete"
                    );
                    Ok::<_, anyhow::Error>(())
                }
            )?;
            let status = child.wait().await?;
            // Never publish Git diagnostics: credential/transport output may
            // contain host details. Repository text is returned only as data.
            ensure!(
                status.success(),
                "Fixed Git objects are unavailable or this source operation failed"
            );
            ensure!(
                disk_usage(&self.path)? <= DISK_BUDGET,
                "Review object storage budget exhausted (256 MiB)"
            );
            Ok::<_, anyhow::Error>(out)
        };
        let monitor = async {
            loop {
                tokio::time::sleep(Duration::from_millis(250)).await;
                ensure!(
                    disk_usage(&self.path)? <= DISK_BUDGET,
                    "Review object storage budget exhausted (256 MiB)"
                );
            }
            #[allow(unreachable_code)]
            Ok::<Vec<u8>, anyhow::Error>(Vec::new())
        };
        // This future owns the process group, including on outer review timeout
        // or cancellation. Each network/object operation has its own deadline.
        tokio::select! {
            value = operation => value,
            value = monitor => value,
            _ = tokio::time::sleep(Duration::from_secs(45)) => anyhow::bail!("Fixed source operation exceeded 45 seconds; coverage is incomplete"),
        }
    }
}

fn disk_usage(path: &Path) -> Result<u64> {
    if !path.exists() {
        return Ok(0);
    }
    let mut sum = 0u64;
    let mut dirs = vec![path.to_owned()];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let meta = entry.metadata()?;
            if meta.is_dir() {
                dirs.push(entry.path());
            } else {
                sum = sum.saturating_add(meta.len());
            }
            if sum > DISK_BUDGET {
                return Ok(sum);
            }
        }
    }
    Ok(sum)
}
