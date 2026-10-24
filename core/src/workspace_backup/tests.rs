use super::*;
use crate::{model::AgentDetail, store::Store};
use serde_json::json;
use std::{os::unix::fs::PermissionsExt, sync::Arc};

const IMAGE: &str = "input-images/agent-a/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png";
const JOB_ID: &str = "6f9d1c2e-3b4a-4c5d-8e7f-0a1b2c3d4e5f";
const JOB: &str = "jobs/6f9d1c2e-3b4a-4c5d-8e7f-0a1b2c3d4e5f";
/// A Brief attachment file the database names, and one it does not.
const ATTACHMENT: &str = "brief-attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNNAMED: &str = "brief-attachments/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_JOB: &str = "jobs/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

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

/// A synthetic Workspace no Core is using: two Agents, an MCP credential, a
/// finished Job, a finished and a running review, a Brief attachment, the
/// files they name, and names a backup leaves out.
fn workspace(root: &Path) -> PathBuf {
    let data = root.join("source");
    fs::create_dir_all(&data).unwrap();
    {
        let store = Store::open(&data.join(DATABASE)).unwrap();
        store.insert(&record("agent-a")).unwrap();
        store.insert(&record("agent-b")).unwrap();
        store.db.write().unwrap().execute_batch(&format!(
            "INSERT INTO workspace_meta(key,value) VALUES('collaboration.mcp.agent.agent-a','synthetic-credential-0123456789');
             INSERT INTO collaboration_tasks(id,version,data) VALUES('task',1,'{{}}');
             INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('{JOB_ID}','task','agent-a','succeeded','{{\"name\":\"synthetic\"}}');
             INSERT INTO pr_reviews(id,task_id,link_id,status,data) VALUES('review-1','task','link-1','completed',
               '{{\"id\":\"review-1\",\"taskId\":\"task\",\"linkId\":\"link-1\",\"status\":\"completed\",\"conclusion\":\"no_findings\"}}');
             INSERT INTO pr_reviews(id,task_id,link_id,status,data) VALUES('review-running','task','link-2','running',
               '{{\"id\":\"review-running\",\"taskId\":\"task\",\"linkId\":\"link-2\",\"status\":\"running\",\"conclusion\":\"unknown\"}}');
             INSERT INTO project_brief_snapshots(section_seq,project_id,sha256,size) VALUES(1,'project','{}',20);",
            ATTACHMENT.trim_start_matches("brief-attachments/"))).unwrap();
    }
    let write = |path: &str, bytes: &[u8]| {
        let path = data.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    };
    write(IMAGE, b"\x89PNG synthetic image");
    write("input-images/agent-a/.tmp-image", b"half an image");
    write("input-images/agent-gone/0.png", b"an Agent the database no longer names");
    write(ATTACHMENT, b"synthetic attachment");
    write(UNNAMED, b"no section keeps this");
    write("brief-attachments/.tmp-upload", b"an upload in progress");
    write("pr-reviews/review-1/context-1.json", br#"{"synthetic":true}"#);
    write("pr-reviews/review-1/objects.git/HEAD", b"ref: refs/heads/main\n");
    write("pr-reviews/review-running/context-1.json", br#"{"partial":true}"#);
    write(&format!("{JOB}/spec.json"), br#"{"id":"synthetic"}"#);
    write(&format!("{JOB}/stdout.log"), b"synthetic log\n");
    write(&format!("{OTHER_JOB}/spec.json"), br#"{"id":"not in the database"}"#);
    write("jobs/host-0123abcd.py", b"# the Jobs host helper\n");
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
        ATTACHMENT,
        IMAGE,
        format!("{JOB}/spec.json").as_str(),
        format!("{JOB}/stdout.log").as_str(),
        "jobs/host-0123abcd.py",
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
    // Chosen by the database copy, and no temporary file or cache.
    for (path, reason) in [
        ("input-images/agent-a/.tmp-image", TEMPORARY),
        ("input-images/agent-gone", NOT_IN_COPY),
        (UNNAMED, NOT_IN_COPY),
        ("brief-attachments/.tmp-upload", TEMPORARY),
        ("pr-reviews/review-1/objects.git", REVIEW_CACHE),
        ("pr-reviews/review-running", RUNNING_REVIEW),
        (OTHER_JOB, NOT_IN_COPY),
    ] {
        assert_eq!(left[path], reason, "{path}");
    }
    assert!(manifest.not_covered.iter().any(|n| n.contains("Native CLI accounts")));
    // The backup is a folder of regular files, readable by its owner only.
    assert_eq!(entries(&out), ["files", MANIFEST, DATABASE]);
    assert_eq!(fs::metadata(out.join(DATABASE)).unwrap().permissions().mode() & 0o777, 0o600);
    assert!(!fs::read(out.join(DATABASE)).unwrap().windows(21).any(|w| w == b"synthetic-credential-"),
        "the credential is not left in the copy's free pages");
    assert_eq!(entries(root.path()), ["backup", "source"], "nothing else is left beside it");

    let target = root.path().join("restored");
    let restored = restore(&out, &target).unwrap();
    assert_eq!((restored.agents, restored.files), (2, 6));
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
            let path = dir.join(FILES).join(ATTACHMENT);
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
        ("a file the database copy does not name", Box::new(|dir: &Path| {
            let path = format!("{OTHER_JOB}/stdout.log");
            let file = dir.join(FILES).join(&path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, "added").unwrap();
            let (bytes, sha256) = hash_file(&file).unwrap();
            rewrite_manifest(dir, |m| m["files"].as_array_mut().unwrap().push(json!({"path":path,"bytes":bytes,"sha256":sha256})));
        }), "which its database copy does not name"),
        ("a named attachment left out", Box::new(|dir: &Path| {
            fs::remove_file(dir.join(FILES).join(ATTACHMENT)).unwrap();
            rewrite_manifest(dir, |m| m["files"].as_array_mut().unwrap().retain(|f| f["path"] != ATTACHMENT));
        }), "which the backup does not hold"),
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
    // A queued Job of the fixture's task, in the Workspace's own tables.
    Connection::open(data.join(DATABASE)).unwrap().execute(
        "INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('job','task','agent-a','queued','{}')", []).unwrap();
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
    // A Workspace at an older schema: the advice is one this Core can follow.
    Connection::open(data.join(DATABASE)).unwrap().execute_batch("PRAGMA user_version=1").unwrap();
    let older = error(backup(&data, &out));
    assert!(older.contains("older than this Core reads") && older.contains("Start this Core on it once"), "{older}");
    Connection::open(data.join(DATABASE)).unwrap().execute_batch(&format!("PRAGMA user_version={STORAGE}")).unwrap();
    // A Brief attachment file the database names is missing: refused.
    let attachment = fs::read(data.join(ATTACHMENT)).unwrap();
    fs::remove_file(data.join(ATTACHMENT)).unwrap();
    assert!(error(backup(&data, &out)).contains("does not hold what its database names"));
    fs::write(data.join(ATTACHMENT), attachment).unwrap();
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

/// A Store open on the Workspace, as a running Core holds it.
fn running_core(data: &Path) -> Arc<Store> {
    Arc::new(Store::open(&data.join(DATABASE)).unwrap())
}

/// Runs `hook` the first time a backup reaches `step`.
fn once_at(ctl: &Control, step: &'static str, hook: impl FnOnce() + Send + 'static) {
    let hook = Mutex::new(Some(hook));
    *ctl.at_step.lock().unwrap() = Some(Box::new(move |at| {
        if at == step {
            if let Some(hook) = hook.lock().unwrap().take() {
                hook();
            }
        }
    }));
}

#[test]
fn a_running_core_backs_up_one_snapshot_while_its_writer_commits() {
    let root = tempfile::tempdir().unwrap();
    let data = workspace(root.path());
    let store = running_core(&data);
    let done = Arc::new(AtomicBool::new(false));
    let writer = {
        let (store, done) = (store.clone(), done.clone());
        std::thread::spawn(move || {
            let (mut commits, mut errors) = (0u64, Vec::new());
            while !done.load(Ordering::SeqCst) {
                // Two rows per transaction: a snapshot holds both or neither.
                let sql = format!("BEGIN IMMEDIATE; INSERT INTO workspace_meta(key,value) VALUES('pair.{commits}.a','x');
                    INSERT INTO workspace_meta(key,value) VALUES('pair.{commits}.b','x'); COMMIT;");
                match store.db.write().map_err(|e| e.to_string()).and_then(|db| db.execute_batch(&sql).map_err(|e| e.to_string())) {
                    Ok(()) => commits += 1,
                    Err(error) => errors.push(error),
                }
            }
            (commits, errors)
        })
    };
    while store.db.read().unwrap().query_row("SELECT COUNT(*) FROM workspace_meta WHERE key GLOB 'pair.*'", [], |r| r.get::<_, i64>(0)).unwrap() < 20 {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let out = root.path().join("backup");
    let manifest = running(&data, &store, &out, &Control::default()).unwrap();
    done.store(true, Ordering::SeqCst);
    let (commits, errors) = writer.join().unwrap();
    assert!(errors.is_empty(), "no commit was refused or held up: {errors:?}");
    let copy = crate::data_dir::read_only(&out.join(DATABASE)).unwrap();
    let count = |glob: &str| copy.query_row("SELECT COUNT(*) FROM workspace_meta WHERE key GLOB ?1", [glob], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(count("pair.*.a"), count("pair.*.b"), "the copy is one committed snapshot");
    assert!(count("pair.*.a") >= 10 && (count("pair.*.a") as u64) <= commits);
    assert_eq!((manifest.database.agents, manifest.files.len()), (2, 6));
    verify(&out).unwrap();
}

#[test]
fn a_running_backup_refuses_unfinished_jobs_and_a_database_not_in_wal_mode() {
    let root = tempfile::tempdir().unwrap();
    let data = workspace(root.path());
    let store = running_core(&data);
    store.db.write().unwrap().execute(
        "INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('job-queued','task','agent-a','queued','{\"name\":\"synthetic queued\"}')", []).unwrap();
    let out = root.path().join("backup");
    let refused = error(running(&data, &store, &out, &Control::default()));
    assert!(refused.contains("1 Job(s) have not ended: synthetic queued (job-queued)"), "{refused}");
    assert_eq!(entries(root.path()), ["source"], "nothing is left behind");
    // Store::open always turns WAL on, so the gate is checked on a copy in rollback mode.
    let plain = root.path().join("plain.sqlite");
    Connection::open(&plain).unwrap().execute_batch("PRAGMA journal_mode=DELETE; CREATE TABLE t(x);").unwrap();
    assert!(wal_only(&Connection::open(&plain).unwrap()).unwrap_err().to_string().contains("not in WAL mode"));
    wal_only(&store.db.read().unwrap()).unwrap();
}

#[test]
fn attachments_the_snapshot_names_survive_a_cleanup_during_the_copy() {
    let root = tempfile::tempdir().unwrap();
    let data = workspace(root.path());
    let store = running_core(&data);
    let blob = data.join(ATTACHMENT);
    let before = fs::read(&blob).unwrap();
    let ctl = Control::default();
    let (live, cache) = (store.clone(), data.join("brief-attachments"));
    once_at(&ctl, "files", move || {
        // After the snapshot: the live Workspace drops the section and collects garbage.
        live.db.write().unwrap().execute("DELETE FROM project_brief_snapshots", []).unwrap();
        let (_, removed) = crate::project_brief::collect_attachment_garbage(&live, &cache).unwrap();
        assert_eq!(removed, 0, "every file was held");
    });
    let out = root.path().join("backup");
    let manifest = running(&data, &store, &out, &ctl).unwrap();
    assert!(manifest.files.iter().any(|f| f.path == ATTACHMENT));
    assert_eq!(fs::read(out.join(FILES).join(ATTACHMENT)).unwrap(), before);
    assert!(!crate::project_brief::attachment_held(&blob), "the hold ends with the backup");
    // Nothing names it any more: the next collection removes it.
    crate::project_brief::collect_attachment_garbage(&store, &data.join("brief-attachments")).unwrap();
    assert!(!blob.exists());
}

#[test]
fn a_stopped_backup_leaves_nothing_and_releases_its_hold() {
    let root = tempfile::tempdir().unwrap();
    let data = workspace(root.path());
    let store = running_core(&data);
    let ctl = Arc::new(Control::named("stopped-op"));
    let weak = Arc::downgrade(&ctl);
    once_at(&ctl, "files", move || weak.upgrade().unwrap().stop());
    let out = root.path().join("backup");
    let stopped = running(&data, &store, &out, &ctl).unwrap_err();
    assert!(stopped.chain().any(|e| e.is::<Stopped>()), "{stopped:#}");
    assert_eq!(entries(root.path()), ["source"], "no backup or partial folder is left");
    assert!(ctl.scratch().is_none());
    assert!(!crate::project_brief::attachment_held(&data.join(ATTACHMENT)));
}

#[test]
fn a_job_made_after_the_snapshot_is_not_in_the_backup() {
    let root = tempfile::tempdir().unwrap();
    let data = workspace(root.path());
    let store = running_core(&data);
    let late = "jobs/0f1e2d3c-4b5a-4968-8776-655443322110";
    let ctl = Control::default();
    let (live, folder) = (store.clone(), data.join(late));
    once_at(&ctl, "files", move || {
        live.db.write().unwrap().execute(
            "INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('0f1e2d3c-4b5a-4968-8776-655443322110','task','agent-a','queued','{}')", []).unwrap();
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("spec.json"), "{}").unwrap();
    });
    let out = root.path().join("backup");
    let manifest = running(&data, &store, &out, &ctl).unwrap();
    assert!(!manifest.files.iter().any(|f| f.path.starts_with(late)));
    assert!(manifest.excluded.iter().any(|e| e.path == late && e.reason == NOT_IN_COPY));
    verify(&out).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn operations_are_idempotent_one_at_a_time_and_a_restart_interrupts_them() {
    use online::{Backups, Refusal};
    let root = tempfile::tempdir().unwrap();
    let backups = Arc::new(Backups::open(root.path()));
    let wait = |id: String| {
        let backups = backups.clone();
        async move {
            for _ in 0..500 {
                let op = backups.get(&id).unwrap();
                if op.state != "running" {
                    return op;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            panic!("operation {id} did not finish");
        }
    };
    let (release, gate) = std::sync::mpsc::channel::<()>();
    let first = backups.start("check", "r1", json!({"path":"/a"}), |_| None, move |_| {
        gate.recv().unwrap();
        Ok(json!({"checked":true}))
    }).unwrap();
    let again = backups.start("check", "r1", json!({"path":"/a"}), |_| None, |_| Ok(json!({}))).unwrap();
    assert_eq!(again.id, first.id, "the same request is the same operation");
    assert!(matches!(backups.start("check", "r1", json!({"path":"/b"}), |_| None, |_| Ok(json!({}))), Err(Refusal::Conflict)));
    assert!(matches!(backups.start("backup", "r2", json!({"to":"/c"}), |_| None, |_| Ok(json!({}))), Err(Refusal::Busy(id)) if id == first.id));
    release.send(()).unwrap();
    let done = wait(first.id.clone()).await;
    assert_eq!((done.state.as_str(), done.result), ("succeeded", Some(json!({"checked":true}))));
    let looping = backups.start("check", "r3", json!({}), |_| None, |ctl| loop {
        ctl.at("files")?;
        std::thread::sleep(std::time::Duration::from_millis(5));
    }).unwrap();
    assert!(backups.stop(&looping.id));
    assert_eq!(wait(looping.id.clone()).await.state, "stopped");
    assert!(!backups.stop(&looping.id), "only a running operation stops");
    let failing = backups.start("check", "r4", json!({}), |_| None, |_| anyhow::bail!("synthetic failure")).unwrap();
    let failed = wait(failing.id.clone()).await;
    assert_eq!((failed.state.as_str(), failed.error.as_deref()), ("failed", Some("synthetic failure")));
    // A Core stopped mid-operation: on the next start it is interrupted and
    // the folder it was writing is removed.
    let scratch = root.path().join(".target.partial-cafe0123");
    fs::create_dir(&scratch).unwrap();
    fs::write(scratch.join(DATABASE), "half").unwrap();
    let mut journal: Vec<Value> = serde_json::from_slice(&fs::read(root.path().join(online::JOURNAL)).unwrap()).unwrap();
    journal.push(json!({"id":"cafe0123","requestId":"r9","kind":"backup","state":"running","step":"files","request":{"to":"/t"},
        "startedAt":"2026-01-01T00:00:00Z","finishedAt":null,"error":null,"result":null,"scratch":scratch}));
    fs::write(root.path().join(online::JOURNAL), serde_json::to_vec(&journal).unwrap()).unwrap();
    let reopened = Backups::open(root.path());
    let interrupted = reopened.get("cafe0123").unwrap();
    assert_eq!(interrupted.state, "interrupted");
    assert!(interrupted.error.unwrap().contains("Core stopped"));
    assert!(!scratch.exists());
    assert_eq!(reopened.get(&first.id).unwrap().state, "succeeded", "finished operations are kept");
}
