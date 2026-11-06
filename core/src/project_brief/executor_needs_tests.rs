use super::*;
use crate::executor_lifecycle::tests::{role, task, task_is};

/// T-36 S3: Home's Needs you lists an executor the user dispatched whose
/// result waits for the user's release, or whose start failed. A lead's
/// executor in the same state never shows there: it is that lead's to follow.
#[tokio::test]
async fn needs_you_lists_the_executors_the_user_dispatched_and_never_a_leads() {
    let (_dir, ws, _project) = lab();
    let s = &ws.store;
    let (mine_public, mine) = task(s, "Mine to release");
    let (_, leads) = task(s, "The lead's to release");
    let (failed_public, failed) = task(s, "A start that failed");
    role(s, "b", &mine, "user", "d1", "running", None);
    task_is(s, &mine, "review", "", Some("d1"));
    role(s, "c", &leads, "agent:a", "d2", "running", None);
    task_is(s, &leads, "review", "", Some("d2"));
    role(s, "d", &failed, "user", "d3", "starting", Some("The runtime may still be running there: held for you"));
    let home = home::build(s).unwrap();
    let executors: Vec<_> = home["needsYou"].as_array().unwrap().iter().filter(|item| item["kind"] == "executor").collect();
    let shown: Vec<_> = executors.iter().map(|item| (item["agentId"].as_str().unwrap(), item["state"].as_str().unwrap())).collect();
    assert_eq!(shown, vec![("b", "delivering"), ("d", "failed")], "the user's two, its Project's first: {executors:?}");
    assert_eq!((executors[0]["taskId"].as_str(), executors[0]["title"].as_str()), (Some(mine_public.as_str()), Some("Mine to release")));
    assert_eq!(executors[1]["taskId"].as_str(), Some(failed_public.as_str()));
    assert_eq!(executors[1]["reason"], "The runtime may still be running there: held for you");
    // In the same build: the lead's executor, its result in too.
    let leads_shown = home["needsYou"].as_array().unwrap().iter().any(|item| item["agentId"] == "c");
    assert!(!leads_shown, "a lead's executor is never in Needs you");
}
