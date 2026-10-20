use super::{
    admission::Admission,
    api, catalog,
    controller::{Blocker, Controller, Runtime},
    package,
    state::{Launch, Layout, Phase, ReleaseRef, SessionRef},
};
use anyhow::Result;
use futures_util::{future::BoxFuture, FutureExt};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use tower::ServiceExt;

#[derive(Default)]
struct FakeRuntime {
    busy: AtomicBool,
    flushed: AtomicUsize,
    detach_failed: AtomicBool,
    detach_hangs: AtomicBool,
    restore_failed: AtomicBool,
    restored: AtomicUsize,
    flush_failed: AtomicBool,
}
impl Runtime for FakeRuntime {
    fn workspace_id(&self) -> Result<String> {
        Ok("same-workspace".into())
    }
    fn blockers(&self) -> Result<Vec<Blocker>> {
        Ok(if self.busy.load(Ordering::SeqCst) {
            vec![Blocker {
                agent_id: Some("agent".into()),
                name: "Mori".into(),
                reason: "Turn is running".into(),
            }]
        } else {
            vec![]
        })
    }
    fn sessions(&self) -> Result<Vec<SessionRef>> {
        Ok(vec![])
    }
    fn health(&self) -> Result<Value> {
        Ok(json!({"storageReady":true,"apiReady":true,"schema":2,"recordsReady":true}))
    }
    fn flush(&self) -> BoxFuture<'_, Result<()>> {
        async {
            self.flushed.fetch_add(1, Ordering::SeqCst);
            anyhow::ensure!(
                !self.flush_failed.load(Ordering::SeqCst),
                "injected pending record write failure"
            );
            Ok(())
        }
        .boxed()
    }
    fn detach(&self) -> BoxFuture<'_, Result<()>> {
        async {
            if self.detach_hangs.load(Ordering::SeqCst) {
                futures_util::future::pending::<()>().await;
            }
            anyhow::ensure!(
                !self.detach_failed.load(Ordering::SeqCst),
                "transport stopped but consumer did not acknowledge"
            );
            Ok(())
        }
        .boxed()
    }
    fn restore<'a>(&'a self, sessions: &'a [SessionRef]) -> BoxFuture<'a, Result<usize>> {
        async move {
            self.restored.fetch_add(1, Ordering::SeqCst);
            anyhow::ensure!(
                !self.restore_failed.load(Ordering::SeqCst),
                "one session is unavailable"
            );
            Ok(sessions.len())
        }
        .boxed()
    }
}

#[tokio::test]
async fn cancelled_helpers_yield_to_a_new_operation_with_a_bounded_wait() {
    let f = fixture();
    let op = waiting(&f).await;
    let held = super::state::private_file(&f.layout.updates().join("helper.lock")).unwrap();
    held.lock().unwrap();
    assert!(
        super::helper::acquire_operation_lock(&f.layout, &op.id, std::time::Duration::ZERO)
            .is_err()
    );
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(75));
        drop(held);
    });
    let acquired =
        super::helper::acquire_operation_lock(&f.layout, &op.id, std::time::Duration::from_secs(2))
            .unwrap();
    release.join().unwrap();
    drop(acquired);
}

#[tokio::test]
async fn failed_final_flush_never_accepts_stop_or_changes_the_old_core_phase() {
    use super::control::{self, Command, Request};
    let f = fixture();
    let op = waiting(&f).await;
    f.layout
        .edit_operation(&op.id, |o| {
            o.phase = Phase::Flushing;
            Ok(())
        })
        .unwrap();
    f.controller.admission.try_seal(&op.id).unwrap();
    f.runtime.flush_failed.store(true, Ordering::SeqCst);
    let error = control::dispatch(
        &f.controller,
        Request {
            operation_id: op.id.clone(),
            token: op.token.clone(),
            command: Command::Stop,
        },
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("pending record write failure"));
    assert_eq!(
        f.layout.journal().unwrap().operation.unwrap().phase,
        Phase::Flushing
    );
    assert!(!*f.controller.shutdown.borrow());
}

struct Fixture {
    _temp: tempfile::TempDir,
    controller: Arc<Controller>,
    layout: Layout,
    runtime: Arc<FakeRuntime>,
}
fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let a = package::fixture(&temp.path().join("source-a"), "a");
    let mut b = package::fixture(&temp.path().join("source-b"), "b");
    b.manifest.built_at = "2026-10-14T00:00:00Z".into();
    package::atomic_json(&b.path.join("manifest.json"), &b.manifest).unwrap();
    b.manifest_sha256 = package::sha256(&b.path.join("manifest.json")).unwrap();
    let root = temp.path().join("managed");
    catalog::register(&root, &a.path, &a.manifest_sha256, "review a", true).unwrap();
    catalog::register(&root, &b.path, &b.manifest_sha256, "review b", false).unwrap();
    let layout = Layout::open(&root).unwrap();
    let a = layout.release(&ReleaseRef::from(&a)).unwrap();
    let data = temp.path().join("data");
    std::fs::create_dir(&data).unwrap();
    drop(crate::store::Store::open(&data.join("workspace.sqlite")).unwrap());
    let runtime = Arc::new(FakeRuntime::default());
    let controller = Controller::new(
        Some(layout.clone()),
        Some(a),
        Launch {
            port: 4399,
            data_dir: data,
            cwd: temp.path().into(),
            codex: "fixture".into(),
        },
        runtime.clone(),
        Arc::new(Admission::default()),
    )
    .unwrap();
    Fixture {
        _temp: temp,
        controller,
        layout,
        runtime,
    }
}

#[tokio::test]
async fn update_probe_socket_timeout_and_verifier_spawn_keep_distinct_evidence() {
    use std::{io::{BufRead, BufReader}, os::unix::{net::UnixListener, process::CommandExt}, time::Duration};
    let f = fixture();
    let op = waiting(&f).await;
    let listener = UnixListener::bind(f.layout.socket()).unwrap();
    let (release, held) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream);
        let mut request = String::new();
        reader.read_line(&mut request).unwrap();
        held.recv_timeout(Duration::from_secs(10)).unwrap();
    });
    let error = super::helper::call(&f.layout, &op, super::control::Command::Inspect, Duration::from_millis(50)).unwrap_err();
    release.send(()).unwrap();
    server.join().unwrap();
    let socket_io = error.downcast_ref::<std::io::Error>().unwrap();
    assert!(matches!(socket_io.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut));
    println!("socket_timeout: {error:#}; kind={:?}; errno={:?}", socket_io.kind(), socket_io.raw_os_error());
    let diagnostic = format!("{error:#}");
    assert!(diagnostic.contains(&op.id) && diagnostic.contains("Inspect") && diagnostic.contains("Timed out reading"));
    assert!(!diagnostic.contains(&op.token));

    // A read timeout does not stop Core. The same operation can still abort
    // its drain and reopen admission, using the real control handler.
    std::fs::remove_file(f.layout.socket()).unwrap();
    super::control::listen(f.controller.clone()).unwrap();
    let layout = f.layout.clone();
    tokio::task::spawn_blocking(move || super::helper::call(&layout, &op, super::control::Command::Abort, Duration::from_secs(5)))
        .await.unwrap().unwrap();
    assert!(f.controller.admission.enter_work().is_ok());
    assert!(!*f.controller.shutdown.borrow());
    let failed = f.layout.journal().unwrap().operation.unwrap();
    assert_eq!(failed.phase, Phase::Failed);
    assert!(failed.new_process.is_none());

    let mut command = std::process::Command::new("/bin/true");
    // Inject only the spawn result, without exhausting the host's process limit.
    unsafe { command.pre_exec(|| Err(std::io::Error::from_raw_os_error(rustix::io::Errno::AGAIN.raw_os_error()))); }
    let error = super::helper::run_verifier(command, Duration::from_secs(1)).unwrap_err();
    assert_eq!(error.downcast_ref::<std::io::Error>().unwrap().raw_os_error(), Some(rustix::io::Errno::AGAIN.raw_os_error()));
    println!("verifier_spawn: {error:#}");
    let diagnostic = format!("{error:#}");
    assert!(diagnostic.contains("spawn workspace records verifier"));
    assert!(!diagnostic.contains("Timed out reading"));
}

#[tokio::test]
async fn preparation_survives_request_end_without_closing_admission() {
    let f = fixture();
    let id = f.controller.prepare("b").await.unwrap();
    assert!(f.controller.admission.enter_work().is_ok());
    let mut prepared = false;
    for _ in 0..200 {
        let op = f.layout.journal().unwrap().operation.unwrap();
        assert_eq!(op.id, id);
        if op.phase == Phase::Prepared {
            prepared = true;
            break;
        }
        assert_eq!(op.phase, Phase::Preparing);
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(prepared);
    assert!(f.layout.root.join("releases/b/manifest.json").is_file());
    assert!(!f.layout.root.join("incoming/b").exists());
    assert!(f.controller.admission.enter_work().is_ok());
    let public = f.controller.status().await.unwrap();
    assert_eq!(public["preparedReleaseId"], "b");
    assert!(public["operation"].get("token").is_none());
    assert!(public["operation"].get("launch").is_none());
}

#[tokio::test]
async fn helper_launch_failure_reopens_admission_and_retry_does_not_repeat_operation() {
    let f = fixture();
    f.controller.prepare("b").await.unwrap();
    for _ in 0..200 {
        if f.layout.journal().unwrap().prepared.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let request = uuid::Uuid::new_v4().to_string();
    // Inject an unambiguous launch failure. Some process launchers execute a
    // text-only fixture through a shell, which is not an ENOENT spawn failure.
    std::fs::remove_file(f.layout.root.join("releases/a/bin/yuzuno-update-helper")).unwrap();
    assert!(f.controller.apply("b", &request).await.is_err());
    let op = f.layout.journal().unwrap().operation.unwrap();
    assert_eq!(op.phase, Phase::Failed);
    assert!(f.controller.admission.enter_work().is_ok());
    assert_eq!(f.controller.apply("b", &request).await.unwrap(), op.id);
    assert_eq!(f.layout.journal().unwrap().requests.len(), 1);
    assert!(f.controller.apply("different", &request).await.is_err());
}

#[tokio::test]
async fn api_rejects_unknown_paths_and_unprepared_apply_without_mutation() {
    let f = fixture();
    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/api/updates/apply")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(
            json!({"releaseId":"../outside","requestId":uuid::Uuid::new_v4().to_string()})
                .to_string(),
        ))
        .unwrap();
    let response = api::router::<()>(f.controller.clone())
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);
    assert!(f.layout.journal().unwrap().operation.is_none());
    assert!(f.controller.admission.enter_work().is_ok());
    assert!(f.controller.prepare("../outside").await.is_err());
}

#[test]
fn catalog_registration_never_replaces_an_existing_release_identity() {
    let f = fixture();
    let mut changed = package::fixture(&f._temp.path().join("changed"), "b");
    changed.manifest.notes = "Different content under the same ID".into();
    package::atomic_json(&changed.path.join("manifest.json"), &changed.manifest).unwrap();
    let hash = package::sha256(&changed.path.join("manifest.json")).unwrap();
    assert!(catalog::register(
        &f.layout.root,
        &changed.path,
        &hash,
        "another review",
        false
    )
    .is_err());
    assert!(
        catalog::register(&f.layout.root, &changed.path, &hash, "another review", true).is_err()
    );
}

#[tokio::test]
async fn accepted_requests_prevent_seal_and_cancel_reopens_work() {
    use super::control::{self, Command, Request};
    let f = fixture();
    f.controller.prepare("b").await.unwrap();
    for _ in 0..200 {
        if f.layout.journal().unwrap().prepared.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let mut op = f.layout.journal().unwrap().operation.unwrap();
    let accepted = f.controller.admission.enter_work().unwrap();
    f.layout
        .edit_operation(&op.id, |o| {
            o.phase = Phase::Waiting;
            Ok(())
        })
        .unwrap();
    f.controller.admission.begin_drain(&op.id).unwrap();
    op.phase = Phase::Waiting;
    let seal = || Request {
        operation_id: op.id.clone(),
        token: op.token.clone(),
        command: Command::Seal,
    };
    assert!(f.controller.admission.enter_work().is_err());
    assert_eq!(
        control::dispatch(&f.controller, seal()).await.unwrap()["sealed"],
        false
    );
    assert!(f.controller.admission.enter_completion().is_ok());
    f.controller.cancel(&op.id).await.unwrap();
    f.controller.cancel(&op.id).await.unwrap();
    assert!(f.controller.admission.enter_work().is_ok());
    assert!(control::dispatch(&f.controller, seal()).await.is_err());
    drop(accepted);
    assert_eq!(f.controller.admission.snapshot().in_flight, 0);
}

#[tokio::test]
async fn private_control_requires_operation_secret_before_any_transition() {
    use super::control::{self, Command, Request};
    let f = fixture();
    f.controller.prepare("b").await.unwrap();
    let op = f.layout.journal().unwrap().operation.unwrap();
    assert!(control::dispatch(
        &f.controller,
        Request {
            operation_id: op.id,
            token: "wrong".into(),
            command: Command::Seal
        }
    )
    .await
    .is_err());
    assert!(!f.controller.admission.snapshot().sealed);
    for _ in 0..200 {
        if f.layout.journal().unwrap().operation.unwrap().phase == Phase::Prepared {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("Preparation did not finish");
}

async fn waiting(f: &Fixture) -> super::state::Operation {
    f.controller.prepare("b").await.unwrap();
    for _ in 0..200 {
        if f.layout.journal().unwrap().prepared.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let op = f.layout.journal().unwrap().operation.unwrap();
    assert_eq!(op.phase, Phase::Prepared);
    f.layout
        .edit_operation(&op.id, |op| {
            op.phase = Phase::Waiting;
            Ok(())
        })
        .unwrap();
    f.controller.admission.begin_drain(&op.id).unwrap();
    f.layout.journal().unwrap().operation.unwrap()
}

#[tokio::test]
async fn partial_detach_and_failed_restore_are_visible_and_reopen_admission() {
    use super::control::{self, Command, Request};
    let f = fixture();
    let op = waiting(&f).await;
    let command = |command| Request {
        operation_id: op.id.clone(),
        token: op.token.clone(),
        command,
    };
    f.runtime.detach_failed.store(true, Ordering::SeqCst);
    assert!(control::dispatch(&f.controller, command(Command::Seal))
        .await
        .unwrap_err()
        .to_string()
        .contains("consumer"));
    assert!(f.controller.admission.snapshot().sealed);
    assert_eq!(
        f.layout.journal().unwrap().operation.unwrap().phase,
        Phase::Flushing
    );
    assert!(!*f.controller.shutdown.borrow());
    f.layout
        .edit_operation(&op.id, |op| {
            op.error = Some("original records verification failed".into());
            Ok(())
        })
        .unwrap();
    f.runtime.restore_failed.store(true, Ordering::SeqCst);
    control::dispatch(&f.controller, command(Command::Abort))
        .await
        .unwrap();
    let failed = f.layout.journal().unwrap().operation.unwrap();
    assert_eq!(failed.phase, Phase::Failed);
    let error = failed.error.unwrap();
    assert!(error.contains("Reconnect affected sessions manually"));
    assert!(error.contains("original records verification failed"));
    assert_eq!(f.runtime.restored.load(Ordering::SeqCst), 1);
    assert!(f.controller.admission.enter_work().is_ok());
    assert!(!f.controller.admission.snapshot().sealed);
}

#[tokio::test]
async fn busy_turns_and_completion_responses_prevent_native_detach() {
    use super::control::{self, Command, Request};
    let f = fixture();
    let op = waiting(&f).await;
    let command = || Request {
        operation_id: op.id.clone(),
        token: op.token.clone(),
        command: Command::Seal,
    };
    f.runtime.busy.store(true, Ordering::SeqCst);
    assert_eq!(
        control::dispatch(&f.controller, command()).await.unwrap()["sealed"],
        false
    );
    assert_eq!(f.runtime.flushed.load(Ordering::SeqCst), 0);
    let approval = f.controller.admission.enter_completion().unwrap();
    f.runtime.busy.store(false, Ordering::SeqCst);
    assert_eq!(
        control::dispatch(&f.controller, command()).await.unwrap()["sealed"],
        false
    );
    drop(approval);
    assert_eq!(
        control::dispatch(&f.controller, command()).await.unwrap()["sealed"],
        true
    );
    assert!(f.controller.admission.enter_completion().is_err());
}

#[tokio::test]
async fn cancelling_a_stalled_seal_releases_transition_and_allows_recovery() {
    use super::control::{self, Command, Request};
    let f = fixture();
    let op = waiting(&f).await;
    let command = |command| Request {
        operation_id: op.id.clone(),
        token: op.token.clone(),
        command,
    };
    f.runtime.detach_hangs.store(true, Ordering::SeqCst);
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(30),
        control::dispatch(&f.controller, command(Command::Seal))
    )
    .await
    .is_err());
    assert_eq!(
        f.layout.journal().unwrap().operation.unwrap().phase,
        Phase::Flushing
    );
    assert!(!*f.controller.shutdown.borrow());
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        control::dispatch(&f.controller, command(Command::Abort)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        f.layout.journal().unwrap().operation.unwrap().phase,
        Phase::Failed
    );
    assert!(f.controller.admission.enter_work().is_ok());
}

#[tokio::test]
async fn expired_wait_reopens_while_busy_turn_keeps_running() {
    let f = fixture();
    let op = waiting(&f).await;
    f.runtime.busy.store(true, Ordering::SeqCst);
    f.layout
        .edit_operation(&op.id, |op| {
            op.deadline = (chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339();
            Ok(())
        })
        .unwrap();
    f.controller.monitor();
    for _ in 0..80 {
        if f.layout.journal().unwrap().operation.unwrap().phase == Phase::Failed {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let failed = f.layout.journal().unwrap().operation.unwrap();
    assert_eq!(failed.phase, Phase::Failed);
    assert!(failed.error.unwrap().contains("timed out"));
    assert!(f.runtime.busy.load(Ordering::SeqCst));
    assert_eq!(f.runtime.flushed.load(Ordering::SeqCst), 0);
    assert!(!*f.controller.shutdown.borrow());
    assert!(f.controller.admission.enter_work().is_ok());
}

#[tokio::test]
async fn preparation_prunes_unused_packages_and_failed_backups_do_not_accumulate() {
    let f = fixture();
    for n in 0..7 {
        std::fs::create_dir(f.layout.root.join("releases").join(format!("old-{n}"))).unwrap();
        std::fs::write(f.layout.updates().join(format!("old-{n}.log")), "old log").unwrap();
    }
    let abandoned = f
        .layout
        .root
        .join("releases")
        .join(format!(".stage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&abandoned).unwrap();
    let op = waiting(&f).await;
    assert!(!abandoned.exists());
    assert_eq!(
        std::fs::read_dir(f.layout.root.join("releases"))
            .unwrap()
            .count(),
        3
    );
    assert!(f.layout.root.join("releases/a/manifest.json").is_file());
    assert!(f.layout.root.join("releases/b/manifest.json").is_file());
    assert_eq!(
        std::fs::read_dir(f.layout.updates())
            .unwrap()
            .filter(|entry| entry
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "log"))
            .count(),
        6
    );
    let source = f.controller.launch.data_dir.join("workspace.sqlite");
    {
        // Discard no WAL pages: make the deliberate corruption the only source.
        let db = rusqlite::Connection::open(&source).unwrap();
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")
            .unwrap();
    }
    std::fs::write(&source, "invalid fixture database").unwrap();
    assert!(super::helper::backup(&f.layout, &op).is_err());
    assert!(std::fs::read_dir(f.layout.root.join("backups"))
        .unwrap()
        .next()
        .is_none());
    assert_eq!(
        std::fs::read_to_string(source).unwrap(),
        "invalid fixture database"
    );
}

#[tokio::test]
async fn locked_backup_has_a_deadline_and_never_replaces_source_records() {
    let f = fixture();
    let op = waiting(&f).await;
    let source = f.controller.launch.data_dir.join("workspace.sqlite");
    let database = rusqlite::Connection::open(&source).unwrap();
    database.execute_batch("PRAGMA journal_mode=DELETE; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('keep'); BEGIN EXCLUSIVE;").unwrap();
    let error =
        super::helper::backup_with_budget(&f.layout, &op, std::time::Duration::from_millis(150))
            .unwrap_err();
    assert!(error.to_string().contains("timed out"), "{error:#}");
    assert!(std::fs::read_dir(f.layout.root.join("backups"))
        .unwrap()
        .next()
        .is_none());
    database.execute_batch("COMMIT;").unwrap();
    assert_eq!(
        database
            .query_row("SELECT value FROM sentinel", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "keep"
    );
}

#[tokio::test]
async fn restarted_core_recovers_stopping_for_old_or_failed_candidate() {
    for candidate_stopped in [false, true] {
        let f = fixture();
        let op = waiting(&f).await;
        f.layout
            .edit_operation(&op.id, |op| {
                op.phase = Phase::Stopping;
                op.started_at = (chrono::Utc::now() - chrono::Duration::seconds(30)).to_rfc3339();
                op.old_process.start_ticks = 0;
                let mut stopped = op.old_process.clone();
                if candidate_stopped {
                    stopped.executable = f.layout.root.join("releases/b/bin/yuzuno-workspace");
                    op.new_process = Some(stopped.clone());
                }
                op.stopping_process = Some(stopped);
                op.helper_process = None;
                op.sessions = vec![SessionRef {
                    agent_id: "a".into(),
                    harness: "codex".into(),
                    native_id: "original".into(),
                }];
                op.total_sessions = 1;
                Ok(())
            })
            .unwrap();
        let restarted = Controller::new(
            Some(f.layout.clone()),
            f.controller.running.clone(),
            f.controller.launch.clone(),
            f.runtime.clone(),
            Arc::new(Admission::default()),
        )
        .unwrap();
        assert!(restarted.admission.enter_work().is_err());
        restarted.recover_abandoned_operation().await.unwrap();
        assert!(restarted.admission.enter_work().is_ok());
        assert_eq!(f.runtime.restored.load(Ordering::SeqCst), 1);
        let failed = f.layout.journal().unwrap().operation.unwrap();
        assert_eq!(failed.phase, Phase::Failed);
        assert_eq!(failed.recovered_sessions, 1);
        assert!(failed.error.unwrap().contains("restarted Core"));
        let pointer: ReleaseRef =
            serde_json::from_slice(&std::fs::read(f.layout.root.join("current.json")).unwrap())
                .unwrap();
        assert_eq!(pointer.release_id, "a");
    }
}

#[tokio::test]
async fn stopping_recovery_never_races_live_helper_or_stopping_process() {
    let f = fixture();
    let op = waiting(&f).await;
    let me = super::state::ProcessIdentity::read(std::process::id()).unwrap();
    f.layout
        .edit_operation(&op.id, |op| {
            op.phase = Phase::Stopping;
            op.started_at = (chrono::Utc::now() - chrono::Duration::seconds(30)).to_rfc3339();
            op.stopping_process = Some(me.clone());
            Ok(())
        })
        .unwrap();
    f.controller.recover_abandoned_operation().await.unwrap();
    assert!(f.controller.admission.enter_work().is_err());
    f.layout
        .edit_operation(&op.id, |op| {
            op.stopping_process.as_mut().unwrap().start_ticks = 0;
            op.helper_process = Some(me);
            Ok(())
        })
        .unwrap();
    f.controller.recover_abandoned_operation().await.unwrap();
    assert_eq!(f.runtime.restored.load(Ordering::SeqCst), 0);
    f.layout
        .edit_operation(&op.id, |op| {
            op.helper_process = None;
            Ok(())
        })
        .unwrap();
    let lease = super::state::private_file(&f.layout.updates().join("helper.lock")).unwrap();
    lease.lock().unwrap();
    f.controller.recover_abandoned_operation().await.unwrap();
    assert_eq!(f.runtime.restored.load(Ordering::SeqCst), 0);
    assert!(f.controller.admission.enter_work().is_err());
    drop(lease);
    f.controller.recover_abandoned_operation().await.unwrap();
    assert!(f.controller.admission.enter_work().is_ok());
}

#[test]
fn records_verifier_has_its_own_budget_and_cannot_return_a_stale_proof() {
    use std::{
        process::Command,
        time::{Duration, Instant},
    };
    let mut slow = Command::new("python3");
    slow.args([
        "-c",
        "import time; time.sleep(3.2); print('{\"recordsReady\":true}')",
    ]);
    let start = Instant::now();
    assert_eq!(
        super::helper::run_verifier(slow, Duration::from_secs(5)).unwrap()["recordsReady"],
        true
    );
    assert!(start.elapsed() > Duration::from_secs(3));
    let mut stalled = Command::new("python3");
    stalled.args(["-c", "import time; time.sleep(60)"]);
    let start = Instant::now();
    let error = super::helper::run_verifier(stalled, Duration::from_millis(100)).unwrap_err();
    assert!(error.to_string().contains("timed out"));
    assert!(start.elapsed() < Duration::from_secs(2));
    let mut invalid = Command::new("python3");
    invalid.args(["-c", "raise SystemExit('damaged payload')"]);
    assert!(super::helper::run_verifier(invalid, Duration::from_secs(2))
        .unwrap_err()
        .to_string()
        .contains("damaged payload"));
}

#[test]
fn interrupted_registration_stage_does_not_poison_the_catalog() {
    let f = fixture();
    let stage = f
        .layout
        .root
        .join("incoming")
        .join(format!(".stage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&stage).unwrap();
    let b = package::fixture(&f._temp.path().join("source-c"), "c");
    catalog::register(
        &f.layout.root,
        &b.path,
        &b.manifest_sha256,
        "review c",
        false,
    )
    .unwrap();
    assert!(!stage.exists());
}

#[tokio::test]
async fn recovery_reopens_even_if_current_pointer_cannot_be_written() {
    let f = fixture();
    let mut op = waiting(&f).await;
    op.phase = Phase::Stopping;
    std::fs::remove_file(f.layout.root.join("current.json")).unwrap();
    std::fs::create_dir(f.layout.root.join("current.json")).unwrap();
    let error = f
        .controller
        .reopen_after_failure(&op, "Interrupted stop", std::time::Duration::from_secs(1))
        .await;
    assert!(error.is_err());
    assert!(f.controller.admission.enter_work().is_ok());
    let failed = f.layout.journal().unwrap().operation.unwrap();
    assert_eq!(failed.phase, Phase::Failed);
    assert!(failed.error.unwrap().contains("Interrupted stop"));
    assert_eq!(f.runtime.restored.load(Ordering::SeqCst), 1);
}
