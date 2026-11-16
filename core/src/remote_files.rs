//! Private, immutable copies of a message's attached files on the Agent's
//! existing SSH destination (YN-145 F4). Installation is idempotent and
//! content-addressed: `file-cache/<key>/<sha256>/<name>`. It never submits a
//! native message; the send receipt still owns unknown delivery. The same
//! queue, SSH exchange and cleanup marker as the image copies are shared
//! (`remote_images`); deleting an Agent removes both kinds of copy.
use crate::{
    input_files::{self, FileRef},
    model::Agent,
    remote_images,
};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

/// The folder the Agent's harness may read its remote copies in: the data
/// root Core names, then `file-cache/<key>`. A remote Claude gets it as a
/// readable folder at start; the bridge resolves it as the helper does.
pub(crate) fn readable_dir(workspace: &str, agent: &Agent) -> Result<String> {
    let owner = remote_images::owner(workspace, agent)?;
    let key = remote_images::cache_key(&owner)?;
    let root = agent
        .remote
        .as_ref()
        .context("File destination is not remote")?
        .machine
        .root();
    Ok(format!("{}/file-cache/{key}", root.trim_end_matches('/')))
}

fn obligation_path(root: &Path, owner: &Value) -> Result<PathBuf> {
    let agent = owner["agent"].as_str().context("Missing file owner")?;
    Ok(remote_images::marker_path(&input_files::agent_dir(
        root, agent,
    )?))
}

/// Whether a file copy may be on the machine for this exact owner: the
/// marker `transfer` leaves before SSH starts.
pub(crate) fn has_obligation(root: &Path, owner: &Value) -> Result<bool> {
    remote_images::has_marker(&obligation_path(root, owner)?, owner)
}

/// Copies `files` to the remote Agent, returning each file's path there, in
/// order. The files are read and checked again first; the marker is durable
/// before SSH starts, so even an unclear outcome can be cleaned up with the
/// Agent. Blocking reads hold the shared transfer slot like an image copy.
pub(crate) async fn transfer(
    root: PathBuf,
    workspace: &str,
    agent: &Agent,
    instance: &str,
    files: &[FileRef],
) -> Result<Vec<String>> {
    let slot = tokio::time::timeout(
        remote_images::QUEUE_WAIT,
        remote_images::TRANSFERS
            .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
            .clone()
            .acquire_owned(),
    )
    .await
    .context("File transfer queue timed out; retry this draft")?
    .context("File transfer queue is unavailable; retry this draft")?;
    let owner = remote_images::owner(workspace, agent)?;
    let obligation = owner.clone();
    let (id, refs) = (agent.id.clone(), files.to_vec());
    let prepared = tokio::task::spawn_blocking(move || -> Result<_> {
        // Keep the permit in this worker even if the HTTP future is cancelled.
        let dir = input_files::agent_dir(&root, &id)?;
        let bodies = input_files::message_bytes(&dir, &refs)?;
        remote_images::remember_marker(&obligation_path(&root, &obligation)?, &root, &obligation)?;
        Ok((bodies, slot))
    })
    .await??;
    let (bodies, _slot) = prepared;
    let mut request = owner.clone();
    request["op"] = "install-files".into();
    request["instance"] = instance.into();
    request["files"] = serde_json::to_value(files)?;
    let machine = &agent
        .remote
        .as_ref()
        .context("File destination is not remote")?
        .machine;
    // Beside the owner, not in it: the cleanup record names only the owner.
    request["root"] = machine.root().into();
    let slices: Vec<&[u8]> = bodies.iter().map(Vec::as_slice).collect();
    let response = remote_images::exchange(machine, &request, &slices).await.context(
        "Remote file transfer failed; message was not submitted and the draft is preserved",
    )?;
    checked_response(&owner, machine.root(), instance, files, response)
}

/// The paths the helper returned, each required to end in
/// `[root, "file-cache", key, id, name]` as the manifest named them: a reply
/// cannot point an Agent outside its own managed destination.
fn checked_response(
    owner: &Value,
    data_root: &str,
    instance: &str,
    files: &[FileRef],
    response: Value,
) -> Result<Vec<String>> {
    ensure!(
        response["owner"] == *owner && response["instance"] == instance,
        "Remote file destination changed"
    );
    let received = response["files"]
        .as_array()
        .context("Missing remote file manifest")?;
    ensure!(
        received.len() == files.len(),
        "Incomplete remote file manifest"
    );
    let key = remote_images::cache_key(owner)?;
    // The data root itself is the private folder the helper checked; what is
    // above it differs by machine and home.
    let root = data_root.rsplit('/').next().unwrap_or_default();
    let mut cache: Option<String> = None;
    let mut paths = Vec::with_capacity(received.len());
    for (entry, file) in received.iter().zip(files) {
        let mut metadata = entry.clone();
        let path = metadata
            .as_object_mut()
            .context("Invalid remote file manifest")?
            .remove("path")
            .context("Missing remote file path")?;
        ensure!(
            metadata == serde_json::to_value(file)?,
            "Remote file digest or owner mismatch"
        );
        let path = path.as_str().context("Invalid remote file path")?;
        ensure!(
            path.starts_with('/') && !path.chars().any(char::is_control),
            "Invalid remote file path"
        );
        let parts: Vec<_> = path.split('/').collect();
        ensure!(
            parts.len() >= 7
                && parts[1..]
                    .iter()
                    .all(|p| !p.is_empty() && *p != "." && *p != ".."),
            "Invalid remote file path"
        );
        let tail = &parts[parts.len() - 5..];
        ensure!(
            tail[0] == root
                && tail[1] == "file-cache"
                && tail[2] == key
                && tail[3] == file.id
                && tail[4] == file.name
                && input_files::safe_name(&file.name) == file.name,
            "Remote file path is outside its managed destination"
        );
        // Every copy of one transfer belongs to one owner cache on one home.
        let parent = parts[..parts.len() - 2].join("/");
        ensure!(
            cache.as_deref().is_none_or(|previous| previous == parent),
            "Remote file caches differ"
        );
        cache = Some(parent);
        paths.push(path.to_owned());
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::Digest;

    fn remote_agent(harness: &str, root: &str) -> Agent {
        let remote: crate::model::RemoteAgent = serde_json::from_value(json!({"machine": {
            "id":"mac-a", "name":"Mac", "target":"test@machine",
            "codex":"codex", "defaultCwd":"/tmp", "dataRoot":root
        }}))
        .unwrap();
        let mut agent: Agent = serde_json::from_value(json!({"id":"agent-a","name":"A",
            "cwd":"/tmp","model":"test","color":"sage","status":"offline",
            "createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
            "lastSeq":0,"reviewedSeq":0,"harness":harness}))
        .unwrap();
        agent.remote = Some(remote);
        agent
    }

    fn file(name: &str, data: &[u8]) -> FileRef {
        FileRef {
            id: format!("{:x}", sha2::Sha256::digest(data)),
            name: name.into(),
            bytes: data.len() as u64,
        }
    }

    fn entry(file: &FileRef, path: String) -> Value {
        let mut entry = serde_json::to_value(file).unwrap();
        entry["path"] = path.into();
        entry
    }

    #[test]
    fn file_reply_path_must_end_in_its_managed_destination() {
        let agent = remote_agent("claude", "~/.yuzuno");
        let owner = remote_images::owner("w", &agent).unwrap();
        let key = remote_images::cache_key(&owner).unwrap();
        let files = vec![file("q3 report.pdf", b"one"), file("notes.txt", b"two")];
        let path = |file: &FileRef| {
            format!("/home/user/.yuzuno/file-cache/{key}/{}/{}", file.id, file.name)
        };
        let reply = json!({"owner":owner,"instance":"instance","files":[
            entry(&files[0], path(&files[0])), entry(&files[1], path(&files[1]))]});
        let root = crate::remote::DEFAULT_ROOT;
        assert_eq!(
            checked_response(&owner, root, "instance", &files, reply.clone()).unwrap(),
            vec![path(&files[0]), path(&files[1])]
        );
        // An Agent from before data roots keeps its copies where they were.
        let legacy_root = crate::remote::LEGACY_ROOT;
        let mut legacy = reply.clone();
        for (index, file) in files.iter().enumerate() {
            legacy["files"][index]["path"] = path(file).replace(".yuzuno/", ".yuzuno-next/").into();
        }
        assert!(checked_response(&owner, legacy_root, "instance", &files, legacy.clone()).is_ok());
        assert!(checked_response(&owner, root, "instance", &files, legacy).is_err());
        for (index, bad) in [
            "/home/user/.yuzuno/file-cache/other/".to_string() + &files[0].id + "/q3 report.pdf",
            format!("/home/user/../file-cache/{key}/{}/q3 report.pdf", files[0].id),
            format!("/home/user/.yuzuno/image-cache/{key}/{}/q3 report.pdf", files[0].id),
            format!("/home/user/.yuzuno/file-cache/{key}/{}/other.pdf", files[0].id),
            "/etc/passwd".into(),
        ]
        .into_iter()
        .enumerate()
        {
            let mut changed = reply.clone();
            changed["files"][index % 2]["path"] = bad.into();
            assert!(
                checked_response(&owner, root, "instance", &files, changed).is_err(),
                "entry {}",
                index % 2
            );
        }
        for changed in [
            {
                let mut changed = reply.clone();
                changed["owner"]["machine"] = "other".into();
                changed
            },
            {
                let mut changed = reply.clone();
                changed["instance"] = "old-instance".into();
                changed
            },
            {
                let mut changed = reply.clone();
                changed["files"][0]["bytes"] = 99.into();
                changed
            },
            {
                let mut changed = reply.clone();
                changed["files"].as_array_mut().unwrap().pop();
                changed
            },
        ] {
            assert!(checked_response(&owner, root, "instance", &files, changed).is_err());
        }
    }

    #[test]
    fn a_readable_folder_is_the_agents_own_cache_below_its_root() {
        for (harness, root) in [
            ("claude", crate::remote::DEFAULT_ROOT),
            ("claude", crate::remote::LEGACY_ROOT),
            ("claude", "~/jobs-lab/.yuzuno"),
        ] {
            let agent = remote_agent(harness, root);
            let owner = remote_images::owner("w", &agent).unwrap();
            let key = remote_images::cache_key(&owner).unwrap();
            assert_eq!(
                readable_dir("w", &agent).unwrap(),
                format!("{root}/file-cache/{key}")
            );
        }
        // Each Agent and harness has its own folder.
        let first = remote_agent("claude", "~/.yuzuno");
        let mut other = remote_agent("codex", "~/.yuzuno");
        other.id = "agent-b".into();
        assert_ne!(
            readable_dir("w", &first).unwrap(),
            readable_dir("w", &other).unwrap()
        );
    }

    #[test]
    fn file_transfer_marker_is_per_owner_and_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let agent = remote_agent("codex", "~/.yuzuno");
        let owner = remote_images::owner("workspace-a", &agent).unwrap();
        input_files::agent_dir(dir.path(), &agent.id)
            .map(|dir| std::fs::create_dir_all(dir).unwrap())
            .unwrap();
        let path = obligation_path(dir.path(), &owner).unwrap();
        remote_images::remember_marker(&path, dir.path(), &owner).unwrap();
        remote_images::remember_marker(&path, dir.path(), &owner).unwrap();
        assert!(has_obligation(dir.path(), &owner).unwrap());
        let mut foreign = owner.clone();
        foreign["target"] = "another-host".into();
        assert!(has_obligation(dir.path(), &foreign).is_err());
        std::fs::write(&path, b"incomplete").unwrap();
        assert!(has_obligation(dir.path(), &owner).is_err());
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(dir.path().join("missing"), &path).unwrap();
        assert!(has_obligation(dir.path(), &owner).is_err());
    }

    #[test]
    fn remote_file_transfer_filesystem_boundaries() {
        let result = std::process::Command::new("python3")
            .args(["-c", include_str!("../tests/remote_files_test.py")])
            .env("YUZUNO_FILE_HELPER", include_str!("remote_images.py"))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
