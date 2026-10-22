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
            let Some(meta) = unless_gone(entry.metadata())? else {
                continue;
            };
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

/// A lazy blob fetch writes its pack, index and reverse index in objects/pack
/// under temporary names and renames them once complete, while the monitor
/// walks the store. An entry listed and gone when its metadata is read holds
/// nothing under that name; the check after Git exits counts its new name.
/// Every other error still fails, as does a directory gone before its listing.
fn unless_gone<T>(read: std::io::Result<T>) -> std::io::Result<Option<T>> {
    match read {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        read => read.map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::ErrorKind, process::Command};

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().into()
    }

    /// A shallow blob:none store like `Git::create`'s, whose promisor is a
    /// local fixture instead of GitHub, and the blob IDs it still lacks.
    fn partial_store(files: usize) -> (tempfile::TempDir, Git, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir(&work).unwrap();
        git(&work, &["init", "--quiet"]);
        for n in 0..files {
            fs::write(
                work.join(format!("m{n:03}.rs")),
                format!("fn f{n}() {{}}\n"),
            )
            .unwrap();
        }
        git(&work, &["add", "."]);
        git(&work, &["commit", "-qm", "fixture"]);
        git(&work, &["config", "uploadpack.allowFilter", "true"]);
        let url = format!("file://{}", work.display());
        let store = Git {
            path: dir.path().join("objects.git"),
        };
        let path = store.path.to_str().unwrap();
        git(
            dir.path(),
            &[
                "clone",
                "--bare",
                "--quiet",
                "--no-tags",
                "--depth=1",
                "--filter=blob:none",
                &url,
                path,
            ],
        );
        let tree = git(dir.path(), &["--git-dir", path, "ls-tree", "-r", "HEAD"]);
        let blobs = tree
            .lines()
            .map(|l| l.split([' ', '\t']).nth(2).unwrap().to_owned())
            .collect();
        (dir, store, blobs)
    }

    #[test]
    fn a_name_renamed_after_its_listing_is_counted_once_under_its_new_name() {
        let dir = tempfile::tempdir().unwrap();
        let pack = dir.path().join("objects/pack");
        fs::create_dir_all(&pack).unwrap();
        fs::write(pack.join("tmp_pack_fixture"), b"pack").unwrap();
        let listed = fs::read_dir(&pack).unwrap().next().unwrap().unwrap();
        fs::rename(
            pack.join("tmp_pack_fixture"),
            pack.join("pack-fixture.pack"),
        )
        .unwrap();
        // What the walk met during a lazy fetch: No such file or directory.
        assert_eq!(listed.metadata().unwrap_err().kind(), ErrorKind::NotFound);
        assert!(unless_gone(listed.metadata()).unwrap().is_none());
        assert_eq!(disk_usage(dir.path()).unwrap(), 4);
        let denied = std::io::Error::from(ErrorKind::PermissionDenied);
        assert_eq!(
            unless_gone::<()>(Err(denied)).unwrap_err().kind(),
            ErrorKind::PermissionDenied
        );
    }

    #[tokio::test]
    async fn lazy_blob_fetches_run_while_the_store_is_measured() {
        let (dir, store, blobs) = partial_store(120);
        let list = dir.path().join("blobs");
        fs::write(&list, blobs.join("\n") + "\n").unwrap();
        // A fixed test-only alias fetches each blob from the local promisor in
        // its own Git process: for seconds, the 250 ms storage check walks
        // objects/pack while packs arrive under temporary names.
        let alias = format!(
            "alias.lazy-fixture=!while read blob; do git cat-file blob $blob >/dev/null || exit 1; done < {}",
            list.display()
        );
        for blob in [&blobs[0], &blobs[blobs.len() - 1]] {
            let offline = [
                "-c",
                "protocol.file.allow=never",
                "cat-file",
                "blob",
                blob.as_str(),
            ];
            assert!(store.run(&offline, 100).await.is_err(), "not fetched yet");
        }
        let cmd = [
            "-c",
            "protocol.file.allow=always",
            "-c",
            alias.as_str(),
            "lazy-fixture",
        ];
        store.run(&cmd, 100).await.unwrap();
        for blob in &blobs {
            let offline = [
                "-c",
                "protocol.file.allow=never",
                "cat-file",
                "blob",
                blob.as_str(),
            ];
            assert!(store.run(&offline, 100).await.is_ok());
        }
    }

    #[tokio::test]
    async fn a_blob_its_promisor_no_longer_has_is_still_unavailable() {
        let (dir, store, blobs) = partial_store(2);
        fs::remove_dir_all(dir.path().join("work")).unwrap();
        let cmd = [
            "-c",
            "protocol.file.allow=always",
            "cat-file",
            "blob",
            blobs[0].as_str(),
        ];
        let error = store.run(&cmd, 100).await.unwrap_err().to_string();
        assert_eq!(
            error,
            "Fixed Git objects are unavailable or this source operation failed"
        );
    }
}
