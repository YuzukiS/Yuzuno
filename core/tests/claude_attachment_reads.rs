//! YN-145 F3a: a local Claude session starts with the Agent's own folder of
//! attached files as an additional directory, and a rule forbidding edits
//! there; the folder exists (0700) before the rules name it. The real bridge
//! over a scripted SDK (tests/fixtures/claude_quota_bridge.mjs), which logs
//! the options a query was given; no model is called.
#![cfg(target_os = "linux")]

#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use serde_json::Value;
use std::{os::unix::fs::PermissionsExt, sync::Arc, time::Duration};
use yuzuno_workspace::{model::AgentDetail, workspace::Workspace};

async fn until(ws: &Arc<Workspace>, id: &str, what: &str, done: impl Fn(&AgentDetail) -> bool) -> AgentDetail {
    for _ in 0..800 {
        let d = ws.store.detail(id).unwrap();
        if done(&d) {
            return d;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

fn starts(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path).unwrap_or_default().lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap()).collect()
}

#[tokio::test]
async fn a_local_claude_session_reads_its_own_attachment_folder_and_cannot_edit_it() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let log = dir.path().join("starts.jsonl");
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude_quota_bridge.mjs"));
    std::env::set_var("YUZUNO_TEST_CLAUDE_OPTIONS", &log);
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let id = ws.claude_create("C".into(), String::new(), dir.path().to_string_lossy().into(), "m".into(), None).await.unwrap().id;
    until(&ws, &id, "the bridge", |d| d.agent.connection_state == "connected").await;
    // The folder exists, private, before any rule names it.
    let folder = dir.path().join("data/input-files").join(&id);
    assert_eq!(std::fs::symlink_metadata(&folder).unwrap().permissions().mode() & 0o777, 0o700);
    let at = std::fs::canonicalize(&folder).unwrap().display().to_string();
    let start = starts(&log).pop().expect("the session was started");
    assert_eq!(start["additionalDirectories"], serde_json::json!([at]));
    assert_eq!(start["disallowedTools"], serde_json::json!([format!("Edit(/{at}/**)")]),
        "readable, and no built-in edit tool may write there");
}
