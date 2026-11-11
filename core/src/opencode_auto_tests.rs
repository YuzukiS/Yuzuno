//! Who gets Core's answers, and what a snapshot of their connection leaves
//! the user.
use super::*;
use crate::opencode::Snapshot;

#[test]
fn only_a_local_executor_at_auto_approve_gets_cores_answers() {
    assert!(eligible(Some("auto"), crate::agent_roles::EXECUTOR) == cfg!(unix));
    for level in [None, Some("ask"), Some("full"), Some(crate::permission_levels::READ_ONLY)] {
        assert!(!eligible(level, crate::agent_roles::EXECUTOR), "{level:?}");
    }
    assert!(!eligible(Some("auto"), "standing") && !eligible(Some("auto"), "lead"));
}

#[test]
fn a_folder_opencode_names_must_be_absolute_and_normal() {
    assert!(normal("/") && normal("/srv/work") && normal("/srv/a b"));
    for odd in ["", "srv", "/srv/", "/srv//x", "/srv/./x", "/srv/../x"] {
        assert!(!normal(odd), "{odd:?}");
    }
}

/// A snapshot of a connection with Core's answers keeps its forms for the
/// user and none of its permission requests.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_snapshot_of_an_auto_connection_leaves_the_user_no_permission_request() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let server = Arc::new(Server::synthetic(tokio::process::Command::new("sleep").arg("30")));
    let mut c = Connection::new(1, server, "ses_main".into(), Default::default(), Err("synthetic".into()));
    let snapshot = Snapshot { permissions: vec![json!({"id": "per_1", "sessionID": "ses_main", "action": "read"})],
        questions: vec![json!({"id": "frm_1", "sessionID": "ses_main", "fields": []})], ..Snapshot::default() };
    assert_eq!(super::super::user_requests(&snapshot, &c).count(), 2, "without Core's answers, both are the user's");
    let context = Context { directory: "/srv/work".into(), worktree: None, internal: vec!["/srv/work".into()], home: "/home/synthetic".into(),
        data_dir: "/srv/data".into(), outputs: ["/srv/data/o1".into(), "/srv/data/o2".into()], temp: None, dirs: vec![], files: vec![] };
    c.auto = Some(Auto::new(&ws, "oc", &c, context));
    let left: Vec<&Value> = super::super::user_requests(&snapshot, &c).collect();
    assert_eq!(left, [&snapshot.questions[0]], "only the form");
}
