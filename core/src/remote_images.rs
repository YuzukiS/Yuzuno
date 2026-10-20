//! Private, immutable send copies on the Agent's existing SSH destination.
//! Installation is idempotent; it never submits a native message. Native send
//! receipts retain responsibility for unknown delivery and duplicate requests.
use crate::{input_images, model::Agent, remote::RemoteMachine};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Semaphore,
    time::{Duration, timeout},
};

const HELPER: &str = include_str!("remote_images.py");
// Acquired before reading/decoding images, so buffering is bounded across Agents.
static TRANSFERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
#[cfg(not(test))]
const QUEUE_WAIT: Duration = Duration::from_secs(75);
// Exercise the same pre-I/O timeout path without a 75-second test delay.
#[cfg(test)]
const QUEUE_WAIT: Duration = Duration::from_secs(1);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Image {
    id: String,
    sha256: String,
    media_type: &'static str,
    bytes: usize,
    #[serde(skip)]
    data: Vec<u8>,
}

impl Image {
    pub(crate) fn new(id: &str, data: Vec<u8>) -> Result<Self> {
        let media_type = match image::guess_format(&data)? {
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::WebP => "image/webp",
            _ => anyhow::bail!("Unsupported image format"),
        };
        Ok(Self {
            id: id.into(),
            sha256: format!("{:x}", Sha256::digest(&data)),
            media_type,
            bytes: data.len(),
            data,
        })
    }
}

/// Only identity that must stay fixed across the SSH await, not changing UI
/// status, timestamps or usage. The caller also fences its live connection.
pub(crate) fn destination(agent: &Agent) -> Value {
    json!({"agent":agent.id,"harness":agent.harness,"cwd":agent.cwd,
        "session":if agent.harness == "claude" { &agent.claude_session_id } else { &agent.thread_id },
        "remote":agent.remote})
}

fn owner(workspace: &str, agent: &Agent) -> Result<Value> {
    let remote = agent
        .remote
        .as_ref()
        .context("Image destination is not remote")?;
    Ok(
        json!({"workspace":workspace,"agent":agent.id,"harness":agent.harness,
        "machine":remote.machine.id,"target":remote.machine.target}),
    )
}

fn cache_key(owner: &Value) -> Result<String> {
    let parts = ["workspace", "agent", "machine", "target", "harness"]
        .map(|k| owner[k].as_str().context("Invalid image destination"));
    let parts = parts.into_iter().collect::<Result<Vec<_>>>()?;
    Ok(format!("{:x}", Sha256::digest(parts.join("\0").as_bytes())))
}

fn obligation_path(root: &Path, owner: &Value) -> Result<PathBuf> {
    // Reuse the original-image owner validation; no caller-supplied paths.
    Ok(input_images::image_path(
        root,
        owner["agent"].as_str().context("Missing image owner")?,
        &format!("{}.png", "0".repeat(64)),
    )?
    .with_file_name(".remote-transfer.json"))
}

fn has_obligation(root: &Path, owner: &Value) -> Result<bool> {
    use rustix::fs::{Mode, OFlags, open};
    let fd = match open(
        obligation_path(root, owner)?,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let file = File::from(fd);
    let meta = file.metadata()?;
    ensure!(
        meta.is_file() && meta.len() <= 4096,
        "Invalid remote image cleanup obligation"
    );
    let mut bytes = vec![];
    file.take(4097).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 4096 && serde_json::from_slice::<Value>(&bytes)? == *owner,
        "Remote image cleanup destination changed; retain the Agent for cleanup"
    );
    Ok(true)
}

fn remember_transfer(root: &Path, owner: &Value) -> Result<()> {
    use rustix::fs::{Mode, OFlags, open};
    let path = obligation_path(root, owner)?;
    let parent = path.parent().context("Missing image directory")?;
    // Preparation already verified originals in this directory. Never erase
    // this record on timeout, cancellation or lost acknowledgement: even a
    // partially completed SSH request can have left remote copies behind.
    if !has_obligation(root, owner)? {
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(&serde_json::to_vec(owner)?)?;
        temporary.as_file().sync_all()?;
        temporary.persist_noclobber(&path)?;
    }
    // Persist the name and its containing directories before starting SSH.
    // Repeat syncs even for an existing record (a prior write may have failed
    // between persisting the name and syncing its directory).
    File::from(open(
        &path,
        OFlags::RDONLY | OFlags::NOFOLLOW,
        Mode::empty(),
    )?)
    .sync_all()?;
    File::open(parent)?.sync_all()?;
    File::open(parent.parent().context("Missing image root")?)?.sync_all()?;
    File::open(root)?.sync_all()?;
    Ok(())
}

pub(crate) async fn transfer(
    root: PathBuf,
    workspace: &str,
    agent: &Agent,
    generation: u64,
    instance: &str,
    images: &[String],
) -> Result<Vec<Value>> {
    // Queue before reading or decoding any image bytes. Cancellation removes
    // the waiter; a bounded wait avoids immediate failures across Agents while
    // retaining the single-transfer memory bound.
    let slot = timeout(
        QUEUE_WAIT,
        TRANSFERS
            .get_or_init(|| Arc::new(Semaphore::new(1)))
            .clone()
            .acquire_owned(),
    )
    .await
    .context("Image transfer queue timed out; retry this draft")?
    .context("Image transfer queue is unavailable; retry this draft")?;
    let owner = owner(workspace, agent)?;
    let obligation = owner.clone();
    let (id, images, claude) = (agent.id.clone(), images.to_vec(), agent.harness == "claude");
    let prepared = tokio::task::spawn_blocking(move || {
        // Keep the permit in this worker even if the HTTP future is cancelled.
        let prepared = input_images::remote_copies(&root, &id, &images, claude)?;
        remember_transfer(&root, &obligation)?;
        Result::<_>::Ok((prepared, slot))
    })
    .await??;
    let (files, _slot) = prepared;
    let mut request = owner.clone();
    request["op"] = "install".into();
    request["instance"] = instance.into();
    request["scope"] = json!({"session":if claude { &agent.claude_session_id } else { &agent.thread_id },
        "cwd":agent.cwd,"generation":generation});
    request["files"] = serde_json::to_value(&files)?;
    let machine = &agent.remote.as_ref().unwrap().machine;
    // Beside the owner, not in it: cleanup records name only the owner.
    request["root"] = machine.root().into();
    let response = exchange(machine, &request, &files)
        .await
        .context(
            "Remote image transfer failed; message was not submitted and the draft is preserved",
        )?;
    checked_response(&owner, machine.root(), instance, &files, response)
}

fn checked_response(
    owner: &Value,
    data_root: &str,
    instance: &str,
    files: &[Image],
    response: Value,
) -> Result<Vec<Value>> {
    ensure!(
        response["owner"] == *owner && response["instance"] == instance,
        "Remote image destination changed"
    );
    let received = response["files"]
        .as_array()
        .context("Missing remote image manifest")?;
    ensure!(
        received.len() == files.len(),
        "Incomplete remote image manifest"
    );
    let key = cache_key(owner)?;
    let agent = owner["agent"].as_str().context("Missing image owner")?;
    // The data root itself is the private folder the helper checked; what is
    // above it differs by machine and home.
    let root = data_root.rsplit('/').next().unwrap_or_default();
    let mut cache: Option<String> = None;
    for (entry, file) in received.iter().zip(files) {
        let mut metadata = entry.clone();
        let path = metadata
            .as_object_mut()
            .context("Invalid remote image manifest")?
            .remove("path")
            .context("Missing remote image path")?;
        ensure!(
            metadata == serde_json::to_value(file)?,
            "Remote image digest or owner mismatch"
        );
        let path = path.as_str().context("Invalid remote image path")?;
        ensure!(
            path.starts_with('/') && !path.chars().any(char::is_control),
            "Invalid remote image path"
        );
        let parts: Vec<_> = path.split('/').collect();
        ensure!(
            parts.len() >= 8
                && parts[1..]
                    .iter()
                    .all(|p| !p.is_empty() && *p != "." && *p != ".."),
            "Invalid remote image path"
        );
        let tail = &parts[parts.len() - 7..];
        ensure!(
            tail[0] == root
                && tail[1] == "image-cache"
                && tail[2] == key
                && tail[3].len() == 64
                && tail[3]
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                && tail[4] == "input-images"
                && tail[5] == agent
                && tail[6] == file.id,
            "Remote image path is outside its managed destination"
        );
        // Each image can reuse a different content or legacy scope directory;
        // all must still belong to the same owner cache on the same host home.
        let parent = parts[..parts.len() - 4].join("/");
        ensure!(
            cache.as_deref().is_none_or(|previous| previous == parent),
            "Remote image caches differ"
        );
        cache = Some(parent);
    }
    Ok(received.clone())
}

/// Closing keeps copies for resume/history. Only explicit Agent deletion
/// removes them, and the helper refuses while any owning runtime may live.
pub(crate) async fn cleanup(
    root: &std::path::Path,
    workspace: &str,
    agent: &Agent,
    image_attempted: bool,
) -> Result<()> {
    let Some(remote) = agent.remote.as_ref() else {
        return Ok(());
    };
    let mut request = owner(workspace, agent)?;
    let (root, obligation) = (root.to_owned(), request.clone());
    // The receipt fallback covers pre-marker builds, including partial
    // transfers rejected before native submission. Read errors still fail.
    if !tokio::task::spawn_blocking(move || has_obligation(&root, &obligation)).await??
        && !image_attempted
    {
        return Ok(());
    }
    request["op"] = "delete".into();
    request["root"] = remote.machine.root().into();
    let result = exchange(&remote.machine, &request, &[]).await?;
    ensure!(
        result["deleted"] == true,
        "Remote image cleanup was not confirmed"
    );
    Ok(())
}

async fn exchange(machine: &RemoteMachine, request: &Value, images: &[Image]) -> Result<Value> {
    crate::remote::validate_machine(machine)?;
    let mut header = serde_json::to_vec(request)?;
    header.push(b'\n');
    ensure!(
        header.len() <= 16384,
        "Image transfer header exceeds its limit"
    );
    timeout(Duration::from_secs(75), async {
        let mut child = crate::remote::ssh()
            .args(["-o", "ClearAllForwardings=yes"])
            .arg(&machine.target)
            .arg(format!("python3 -c {}", crate::remote::shell_quote(HELPER)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let mut stdin = child.stdin.take().context("Missing SSH stdin")?;
        let mut stdout = child
            .stdout
            .take()
            .context("Missing SSH stdout")?
            .take(32769);
        let mut stderr = child
            .stderr
            .take()
            .context("Missing SSH stderr")?
            .take(8193);
        let write = async {
            stdin.write_all(&header).await?;
            for image in images {
                stdin.write_all(&image.data).await?;
            }
            stdin.shutdown().await?;
            drop(stdin);
            Result::<_>::Ok(())
        };
        let read = async {
            let mut bytes = vec![];
            stdout.read_to_end(&mut bytes).await?;
            Result::<_>::Ok(bytes)
        };
        let errors = async {
            let mut bytes = vec![];
            stderr.read_to_end(&mut bytes).await?;
            Result::<_>::Ok(bytes)
        };
        let (_, bytes, errors) = tokio::try_join!(write, read, errors)?;
        ensure!(
            bytes.len() <= 32768 && errors.len() <= 8192,
            "Oversized image transfer response"
        );
        ensure!(
            child.wait().await?.success(),
            "Image transfer failed: {}",
            String::from_utf8_lossy(&errors).trim()
        );
        Ok(serde_json::from_slice(&bytes)?)
    })
    .await
    .context("Image transfer timed out; native message was not submitted")?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote_agent() -> Agent {
        serde_json::from_value(json!({"id":"a","name":"A","cwd":"/tmp","model":"test",
            "color":"sage","status":"offline","createdAt":"","updatedAt":"",
            "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0,
            "remote":{"machine":{"id":"offline","name":"offline","target":"-must-not-run-ssh",
                "codex":"codex","defaultCwd":"/tmp"}}}))
        .unwrap()
    }

    #[tokio::test]
    async fn remote_image_concurrent_transfer_waits_before_preparation_and_can_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let agent = remote_agent();
        let owner = owner("workspace-a", &agent).unwrap();
        let data = b"\x89PNG\r\n\x1a\nfixture";
        let id = format!("{:x}.png", Sha256::digest(data));
        let path = input_images::image_path(dir.path(), &agent.id, &id).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let images = vec![id];
        let held = TRANSFERS
            .get_or_init(|| Arc::new(Semaphore::new(1)))
            .clone()
            .acquire_owned()
            .await
            .unwrap();
        {
            let cancelled = transfer(
                dir.path().into(),
                "workspace-a",
                &agent,
                1,
                "instance-a",
                &images,
            );
            tokio::pin!(cancelled);
            tokio::select! {
                result = &mut cancelled => panic!("Concurrent transfer must wait before reading: {result:?}"),
                _ = tokio::time::sleep(Duration::from_millis(25)) => {}
            }
            // Dropping a queued transfer must not create a cleanup obligation.
        }
        assert!(!has_obligation(dir.path(), &owner).unwrap());
        let pending = transfer(
            dir.path().into(),
            "workspace-a",
            &agent,
            1,
            "instance-a",
            &images,
        );
        tokio::pin!(pending);
        tokio::select! {
            result = &mut pending => panic!("Concurrent transfer must wait before reading: {result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(25)) => {}
        }
        // The original becomes available only after queueing: preparation
        // must not have read/decoded it while another transfer held the slot.
        std::fs::write(path, data).unwrap();
        drop(held);
        assert!(pending.await.is_err()); // Fixture target refuses SSH.
        assert!(has_obligation(dir.path(), &owner).unwrap());
    }

    #[tokio::test]
    async fn remote_image_queue_timeout_preserves_original_without_starting_transfer() {
        let dir = tempfile::tempdir().unwrap();
        let agent = remote_agent();
        let owner = owner("workspace-a", &agent).unwrap();
        let data = b"\x89PNG\r\n\x1a\nfixture";
        let id = format!("{:x}.png", Sha256::digest(data));
        let path = input_images::image_path(dir.path(), &agent.id, &id).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, data).unwrap();
        let _held = TRANSFERS
            .get_or_init(|| Arc::new(Semaphore::new(1)))
            .clone()
            .acquire_owned()
            .await
            .unwrap();
        let error = transfer(
            dir.path().into(),
            "workspace-a",
            &agent,
            1,
            "instance-a",
            &[id],
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("queue timed out"));
        assert!(!has_obligation(dir.path(), &owner).unwrap());
        assert_eq!(std::fs::read(path).unwrap(), data);
    }

    #[tokio::test]
    async fn remote_image_transfer_failure_retains_durable_cleanup_obligation() {
        let dir = tempfile::tempdir().unwrap();
        let agent = remote_agent();
        let owner = owner("workspace-a", &agent).unwrap();
        let data = b"\x89PNG\r\n\x1a\nfixture";
        let id = format!("{:x}.png", Sha256::digest(data));
        let path = input_images::image_path(dir.path(), &agent.id, &id).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, data).unwrap();
        assert!(!has_obligation(dir.path(), &owner).unwrap());
        assert!(
            transfer(
                dir.path().into(),
                "workspace-a",
                &agent,
                1,
                "instance-a",
                &[format!("{}.png", "f".repeat(64))]
            )
            .await
            .is_err()
        );
        assert!(!has_obligation(dir.path(), &owner).unwrap());
        assert!(
            transfer(
                dir.path().into(),
                "workspace-a",
                &agent,
                1,
                "instance-a",
                &[id]
            )
            .await
            .is_err()
        );
        // Failure even before SSH starts leaves a conservative durable record.
        assert!(has_obligation(dir.path(), &owner).unwrap());
        assert!(
            cleanup(dir.path(), "workspace-a", &agent, false)
                .await
                .is_err()
        );
        assert!(has_obligation(dir.path(), &owner).unwrap());
        assert_eq!(std::fs::read(path).unwrap(), data);
    }

    #[test]
    fn remote_image_obligation_rejects_changed_owner_and_unsafe_record() {
        let dir = tempfile::tempdir().unwrap();
        let owner = owner("workspace-a", &remote_agent()).unwrap();
        let path = obligation_path(dir.path(), &owner).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        remember_transfer(dir.path(), &owner).unwrap();
        remember_transfer(dir.path(), &owner).unwrap();
        let mut foreign = owner.clone();
        foreign["target"] = "another-host".into();
        assert!(has_obligation(dir.path(), &foreign).is_err());
        assert!(remember_transfer(dir.path(), &foreign).is_err());
        std::fs::write(&path, b"incomplete").unwrap();
        assert!(has_obligation(dir.path(), &owner).is_err());
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(dir.path().join("missing"), &path).unwrap();
        assert!(has_obligation(dir.path(), &owner).is_err());
        assert!(remember_transfer(dir.path(), &owner).is_err());
    }

    #[test]
    fn remote_image_transfer_filesystem_boundaries() {
        let result = std::process::Command::new("python3")
            .args(["-c", include_str!("../tests/remote_images_test.py")])
            .env("YUZUNO_IMAGE_HELPER", HELPER)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    fn image_reply_cannot_change_owner_content_or_native_path() {
        let owner =
            json!({"workspace":"w","agent":"a","machine":"m","target":"u@host","harness":"codex"});
        let image = Image::new(
            &format!("{}.png", "a".repeat(64)),
            b"\x89PNG\r\n\x1a\nfixture".to_vec(),
        )
        .unwrap();
        let mut entry = serde_json::to_value(&image).unwrap();
        let id = image.id.clone();
        let path = |root: &str| format!(
            "/home/user/{root}/image-cache/{}/{}/input-images/a/{id}",
            cache_key(&owner).unwrap(),
            "b".repeat(64),
        );
        entry["path"] = path(".yuzuno").into();
        let reply = json!({"owner":owner,"instance":"instance","files":[entry]});
        let files = vec![image];
        let root = crate::remote::DEFAULT_ROOT;
        assert!(checked_response(&owner, root, "instance", &files, reply.clone()).is_ok());
        // An Agent from before data roots keeps its copies where they were.
        let mut legacy = reply.clone();
        legacy["files"][0]["path"] = path(".yuzuno-next").into();
        assert!(checked_response(&owner, crate::remote::LEGACY_ROOT, "instance", &files, legacy.clone()).is_ok());
        assert!(checked_response(&owner, root, "instance", &files, legacy).is_err(), "only in the Agent's own root");
        assert!(checked_response(&owner, crate::remote::LEGACY_ROOT, "instance", &files, reply.clone()).is_err());
        for bad in [
            json!("/core/input-images/a/wrong.png"),
            json!("/home/user/../input-images/a/wrong.png"),
            json!("/etc/passwd"),
        ] {
            let mut changed = reply.clone();
            changed["files"][0]["path"] = bad;
            assert!(checked_response(&owner, root, "instance", &files, changed).is_err());
        }
        let mut changed = reply.clone();
        changed["owner"]["machine"] = "other".into();
        assert!(checked_response(&owner, root, "instance", &files, changed).is_err());
        let mut changed = reply.clone();
        changed["files"][0]["sha256"] = "f".repeat(64).into();
        assert!(checked_response(&owner, root, "instance", &files, changed).is_err());
        assert!(checked_response(&owner, root, "old-instance", &files, reply).is_err());
    }

    #[test]
    fn image_reply_can_reuse_different_content_scopes_only_in_one_owner_cache() {
        let owner = owner("w", &remote_agent()).unwrap();
        let files = vec![
            Image::new(
                &format!("{}.png", "a".repeat(64)),
                b"\x89PNG\r\n\x1a\nfirst".to_vec(),
            )
            .unwrap(),
            Image::new(
                &format!("{}.png", "b".repeat(64)),
                b"\x89PNG\r\n\x1a\nsecond".to_vec(),
            )
            .unwrap(),
        ];
        let entries: Vec<_> = files
            .iter()
            .map(|file| {
                let mut entry = serde_json::to_value(file).unwrap();
                entry["path"] = format!(
                    "/home/user/jobs-lab/.yuzuno/image-cache/{}/{}/input-images/a/{}",
                    cache_key(&owner).unwrap(),
                    file.sha256,
                    file.id
                )
                .into();
                entry
            })
            .collect();
        let mut reply = json!({"owner":owner,"instance":"new-instance","files":entries});
        assert!(checked_response(&owner, "~/jobs-lab/.yuzuno", "new-instance", &files, reply.clone()).is_ok());
        reply["files"][1]["path"] = reply["files"][1]["path"]
            .as_str()
            .unwrap()
            .replace("/home/user/", "/home/other/")
            .into();
        assert!(checked_response(&owner, "~/jobs-lab/.yuzuno", "new-instance", &files, reply).is_err());
    }
}
