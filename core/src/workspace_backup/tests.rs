use super::*;
use crate::{model::AgentDetail, store::Store};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;

const IMAGE: &str = "input-images/agent-a/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png";
const JOB: &str = "jobs/6f9d1c2e-3b4a-4c5d-8e7f-0a1b2c3d4e5f";

fn record(id: &str) -> AgentDetail {
    serde_json::from_value(json!({
        "agent":{"id":id,"name":id,"cwd":"/synthetic/project","model":"m","color":"sage",
            "threadId":format!("thread-{id}"),"status":"idle","createdAt":"","updatedAt":"",
            "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[{"id":"turn","status":"completed","items":[
            {"id":"cmd","type":"commandExecution","status":"completed","aggregatedOutput":"payload\n".repeat(2000)}]}],
        "pending":[],"artifacts":[]
    }))
    .unwrap()
}

/// A synthetic Workspace no Core is using: two Agents, an MCP credential,
/// the folders a backup copies, and names it leaves out.
fn workspace(root: &Path) -> PathBuf {
    let data = root.join("source");
    fs::create_dir_all(&data).unwrap();
    {
        let store = Store::open(&data.join(DATABASE)).unwrap();
        store.insert(&record("agent-a")).unwrap();
        store.insert(&record("agent-b")).unwrap();
        store.db.write().unwrap().execute(
            "INSERT INTO workspace_meta(key,value) VALUES('collaboration.mcp.agent.agent-a','synthetic-credential-0123456789')",
            [],
        ).unwrap();
    }
    let write = |path: &str, bytes: &[u8]| {
        let path = data.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    };
    write(IMAGE, b"\x89PNG synthetic image");
    write("brief-attachments/section/notes.txt", b"synthetic attachment");
    write("pr-reviews/review-1/context-1.json", br#"{"synthetic":true}"#);
    write(&format!("{JOB}/spec.json"), br#"{"id":"synthetic"}"#);
    write(&format!("{JOB}/stdout.log"), b"synthetic log\n");
    write("claude-runtime/cache.bin", b"cache");
    write("opencode/agent-a/opencode.db", b"native session");
    write("notes-from-elsewhere.txt", b"not Core's");
    std::os::unix::fs::symlink("/synthetic/outside", data.join("input-images/agent-a/link.png")).unwrap();
    data
}

fn backed_up(root: &Path) -> (PathBuf, PathBuf, Manifest) {
    let data = workspace(root);
    let out = root.join("backup");
    let manifest = backup(&data, &out).unwrap();
    (data, out, manifest)
}

/// A copy of a backup folder a test may break.
fn copy_of(from: &Path, to: &Path) -> PathBuf {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_of(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
    to.to_owned()
}

fn rewrite_manifest(dir: &Path, change: impl FnOnce(&mut Value)) {
    let mut manifest: Value = serde_json::from_slice(&fs::read(dir.join(MANIFEST)).unwrap()).unwrap();
    change(&mut manifest);
    fs::write(dir.join(MANIFEST), serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
}

/// After changing a backup's database, make its manifest entry match again,
/// so only the database's own checks can refuse it.
fn rehash_database(dir: &Path) {
    let (bytes, sha256) = hash_file(&dir.join(DATABASE)).unwrap();
    rewrite_manifest(dir, |m| {
        m["database"]["bytes"] = json!(bytes);
        m["database"]["sha256"] = json!(sha256);
    });
}

fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

fn error(result: Result<impl std::fmt::Debug>) -> String {
    format!("{:#}", result.unwrap_err())
}

#[test]
fn a_backup_restores_into_a_new_folder_where_core_reads_every_agent() {
    let root = tempfile::tempdir().unwrap();
    let (data, out, manifest) = backed_up(root.path());
    assert_eq!((manifest.format.as_str(), manifest.version), (FORMAT, VERSION));
    assert_eq!(manifest.database.agents, 2);
    assert_eq!(manifest.database.schema, STORAGE);
    let paths: Vec<_> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, [
        "brief-attachments/section/notes.txt",
        IMAGE,
        format!("{JOB}/spec.json").as_str(),
        format!("{JOB}/stdout.log").as_str(),
        "pr-reviews/review-1/context-1.json",
    ]);
    // Everything left out is named, with its reason.
    let left: BTreeMap<_, _> = manifest.excluded.iter().map(|e| (e.path.as_str(), e.reason.as_str())).collect();
    assert!(left["workspace.sqlite: workspace_meta collaboration.mcp.agent.*"].contains("1 removed"));
    assert_eq!(left["workspace.lock"], "The lock of the Core using the Workspace");
    assert!(left["claude-runtime"].contains("cache"));
    assert!(left["opencode"].contains("native session"));
    assert_eq!(left["notes-from-elsewhere.txt"], OTHER);
    assert_eq!(left["input-images/agent-a/link.png"], SPECIAL);
    assert!(manifest.not_covered.iter().any(|n| n.contains("Native CLI accounts")));
    // The backup is a folder of regular files, readable by its owner only.
    assert_eq!(entries(&out), ["files", MANIFEST, DATABASE]);
    assert_eq!(fs::metadata(out.join(DATABASE)).unwrap().permissions().mode() & 0o777, 0o600);
    assert!(!fs::read(out.join(DATABASE)).unwrap().windows(21).any(|w| w == b"synthetic-credential-"),
        "the credential is not left in the copy's free pages");
    assert_eq!(entries(root.path()), ["backup", "source"], "nothing else is left beside it");

    let target = root.path().join("restored");
    let restored = restore(&out, &target).unwrap();
    assert_eq!((restored.agents, restored.files), (2, 5));
    assert_eq!(restored.workspace_id, manifest.workspace_id);
    assert!(restored.notes.iter().any(|n| n.contains("keeps the identity")));
    assert_eq!(entries(root.path()), ["backup", "restored", "source"], "no staging folder is left");
    for file in &manifest.files {
        assert_eq!(fs::read(target.join(&file.path)).unwrap(), fs::read(data.join(&file.path)).unwrap(), "{}", file.path);
    }
    assert!(!target.join("claude-runtime").exists() && !target.join("opencode").exists());
    // Every Agent's whole record reads as it was, before any Core opens either.
    let read = |path: &Path, id: &str| {
        let db = crate::data_dir::read_only(&path.join(DATABASE)).unwrap();
        serde_json::to_value(crate::record_rows::load(&db, id, true).unwrap().unwrap()).unwrap()
    };
    for id in ["agent-a", "agent-b"] {
        assert_eq!(read(&target, id), read(&data, id), "{id}");
    }
    // Core opens the restored Workspace as the same Workspace with both Agents.
    let copy = Store::open(&target.join(DATABASE)).unwrap();
    assert_eq!(copy.workspace_id().unwrap(), manifest.workspace_id);
    let ids: Vec<_> = copy.agents().unwrap().into_iter().map(|agent| agent.id).collect();
    assert_eq!(ids, ["agent-a", "agent-b"]);
    let credentials: i64 = copy.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM workspace_meta WHERE key GLOB 'collaboration.mcp.agent.*'", [], |r| r.get(0)).unwrap();
    assert_eq!(credentials, 0);
}

#[test]
fn a_damaged_or_altered_backup_is_refused_and_nothing_is_restored() {
    let root = tempfile::tempdir().unwrap();
    let (_, out, _) = backed_up(root.path());
    let cases: Vec<(&str, Box<dyn Fn(&Path)>, &str)> = vec![
        ("a changed byte", Box::new(|dir: &Path| {
            let path = dir.join(FILES).join(IMAGE);
            let mut bytes = fs::read(&path).unwrap();
            bytes[0] ^= 1;
            fs::write(path, bytes).unwrap();
        }), "differs from its manifest entry"),
        ("a missing file", Box::new(|dir: &Path| fs::remove_file(dir.join(FILES).join("pr-reviews/review-1/context-1.json")).unwrap()),
            "is missing from the backup"),
        ("an extra file", Box::new(|dir: &Path| fs::write(dir.join(FILES).join("jobs/extra.log"), "x").unwrap()),
            "which its manifest does not list"),
        ("a link instead of a file", Box::new(|dir: &Path| {
            let path = dir.join(FILES).join("brief-attachments/section/notes.txt");
            fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink("/synthetic/outside", path).unwrap();
        }), "not a regular file"),
        ("a path outside the folders", Box::new(|dir: &Path| rewrite_manifest(dir, |m| m["files"][0]["path"] = json!("jobs/../../escape"))),
            "a path a backup cannot hold"),
        ("a newer format", Box::new(|dir: &Path| rewrite_manifest(dir, |m| m["version"] = json!(2))), "format version 2"),
        ("a damaged database", Box::new(|dir: &Path| {
            let path = dir.join(DATABASE);
            let mut bytes = fs::read(&path).unwrap();
            // The schema table's page header and cell pointers, after the file header.
            bytes[100..612].fill(0xa5);
            fs::write(&path, bytes).unwrap();
            rehash_database(dir);
        }), "database"),
        ("a newer schema", Box::new(|dir: &Path| {
            Connection::open(dir.join(DATABASE)).unwrap().execute_batch("PRAGMA user_version=3").unwrap();
            rehash_database(dir);
        }), "schema 3"),
        ("missing history rows", Box::new(|dir: &Path| {
            Connection::open(dir.join(DATABASE)).unwrap().execute_batch("DELETE FROM agent_items").unwrap();
            rehash_database(dir);
        }), "history/Item/payload"),
    ];
    for (n, (case, damage, expected)) in cases.into_iter().enumerate() {
        let broken = copy_of(&out, &root.path().join(format!("broken-{n}")));
        damage(&broken);
        let refused = |result: Result<String>| result.err().map(|e| format!("{e:#}")).unwrap_or_else(|| "accepted".into());
        let checked = refused(verify(&broken).map(|m| m.workspace_id));
        assert!(checked.contains(expected), "{case}: {checked}");
        let target = root.path().join(format!("target-{n}"));
        let restored = refused(restore(&broken, &target).map(|r| r.workspace_id));
        assert!(restored.contains(expected), "{case}: {restored}");
        assert!(!target.exists(), "{case}: nothing is restored");
    }
    assert!(entries(root.path()).iter().all(|n| !n.contains("restoring")), "no staging folder is left");
}

#[test]
fn a_backup_is_refused_while_a_core_or_a_job_uses_the_workspace_and_leaves_nothing() {
    let root = tempfile::tempdir().unwrap();
    let data = workspace(root.path());
    let out = root.path().join("backup");
    let held = Store::open(&data.join(DATABASE)).unwrap();
    assert!(error(backup(&data, &out)).contains("Stop the Core using this Workspace"));
    drop(held);
    // A queued Job of a task, in the Workspace's own tables.
    Connection::open(data.join(DATABASE)).unwrap().execute_batch(
        "INSERT INTO collaboration_tasks(id,version,data) VALUES('task',1,'{}');
         INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('job','task','agent-a','queued','{}');").unwrap();
    assert!(error(backup(&data, &out)).contains("1 Job(s) have not ended"));
    Connection::open(data.join(DATABASE)).unwrap().execute_batch("UPDATE local_jobs SET status='succeeded'").unwrap();
    // A file the backup cannot read: refused, and its partial folder removed.
    let image = data.join(IMAGE);
    fs::set_permissions(&image, fs::Permissions::from_mode(0o000)).unwrap();
    if File::open(&image).is_err() {
        assert!(error(backup(&data, &out)).contains("Cannot read"));
    }
    fs::set_permissions(&image, fs::Permissions::from_mode(0o600)).unwrap();
    // Not enough space: refused before anything is written.
    AVAILABLE.with(|a| a.set(Some(1024)));
    let full = error(backup(&data, &out));
    AVAILABLE.with(|a| a.set(None));
    assert!(full.contains("Not enough space") && full.contains("Nothing was written"), "{full}");
    // Never into an existing folder, or inside the Workspace.
    assert!(error(backup(&data, &data.join("jobs"))).contains("exists"));
    assert!(error(backup(&data, &data.join("inside"))).contains("inside the Workspace"));
    assert_eq!(entries(root.path()), ["source"], "no backup or partial folder is left");
    backup(&data, &out).unwrap();
}

#[test]
fn a_restore_goes_only_into_a_new_or_empty_folder_and_changes_nothing_else_when_refused() {
    let root = tempfile::tempdir().unwrap();
    let (data, out, _) = backed_up(root.path());
    let before = fs::read(data.join(DATABASE)).unwrap();
    assert!(error(restore(&out, &data)).contains("holds a Workspace"));
    let occupied = root.path().join("occupied");
    fs::create_dir(&occupied).unwrap();
    fs::write(occupied.join("keep.txt"), "mine").unwrap();
    assert!(error(restore(&out, &occupied)).contains("is not empty"));
    assert_eq!(fs::read_to_string(occupied.join("keep.txt")).unwrap(), "mine");
    assert!(error(restore(&out, &out.join("inside"))).contains("inside each other"));
    AVAILABLE.with(|a| a.set(Some(1024)));
    let full = error(restore(&out, &root.path().join("new")));
    AVAILABLE.with(|a| a.set(None));
    assert!(full.contains("Not enough space") && full.contains("Nothing was changed"), "{full}");
    assert_eq!(fs::read(data.join(DATABASE)).unwrap(), before, "the Workspace backed up is unchanged");
    assert_eq!(entries(root.path()), ["backup", "occupied", "source"]);
    // An empty folder is used.
    let empty = root.path().join("empty");
    fs::create_dir(&empty).unwrap();
    assert_eq!(restore(&out, &empty).unwrap().agents, 2);
    assert!(empty.join(DATABASE).is_file());
}

/// Writes the synthetic Workspace these tests use to `$T192_FIXTURE/source`,
/// for the run of the Core binary in acceptance/workspace-backup.
#[test]
#[ignore = "writes a fixture Workspace for acceptance/workspace-backup/smoke.py"]
fn write_fixture_workspace() {
    let root = PathBuf::from(std::env::var_os("T192_FIXTURE").expect("T192_FIXTURE names a new folder"));
    fs::create_dir(&root).unwrap();
    workspace(&root);
}
