//! YN-74 ①a2 (design 7, ①a): approval Core reads itself, removal after
//! every check again, snapshots, and what keeps an item at that moment.
use super::*;

/// The cleanup template's steps (design 4.2): its gate is step 4.
fn gated(lab: &Lab) {
    let steps = json!([{"kind":"materials"},{"kind":"job"},{"kind":"work"},{"kind":"result"},{"kind":"gate","approver":"user"},
        {"kind":"work"},{"kind":"job"},{"kind":"result"}]);
    let db = lab.ws.store.db.write().unwrap();
    let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
    let project: String = db.query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [&task], |r| r.get(0)).unwrap();
    db.execute(
        "INSERT INTO executor_dispatches(actor,request_id,input_json,task_id,template_id,project_id,machine_id,template_json,agent_id,state,created_at,updated_at)
         VALUES('agent:lead','r1','{}',?1,'workspace-cleanup',?2,'local',?3,'ex','dispatched','now','now')",
        params![task, project, json!({"id":"workspace-cleanup","label":"Workspace cleanup","steps":steps}).to_string()],
    ).unwrap();
}

fn project_id(lab: &Lab) -> String {
    lab.ws.store.db.read().unwrap().query_row("SELECT id FROM projects WHERE json_extract(data,'$.name')='Demo'", [], |r| r.get(0)).unwrap()
}

/// The gate Ask `key` by `owner` at `step`, naming what `question` says,
/// whose form's `groups` field offers `options`.
fn ask(lab: &Lab, key: &str, owner: &str, step: u64, question: &str, options: &[&str]) {
    let options: Vec<Value> = options.iter().map(|id| json!({"id": id, "label": format!("Group {id}")})).collect();
    let data = json!({"title": "Approve the cleanup", "body": {"root": "text", "elements": {"text": {"type": "Markdown", "props": {"text": "plan.md"}}}},
        "ask": {"question": question, "gate": {"taskId": "T-1", "step": step},
            "reply": {"freeText": true, "form": {"id": "approve", "title": "Cleanup", "fields": [
                {"id": "groups", "type": "multi", "label": "Groups", "required": true, "options": options},
                {"id": "except", "type": "text", "label": "Exceptions", "required": false}]}}}, "attachments": []});
    lab.ws.store.db.write().unwrap().execute(
        "INSERT INTO project_brief_sections(project_id,key,live,kind,version,owner_id,owner_name,data,ask_state,ask_since,updated_at)
         VALUES(?1,?2,1,'ask',1,?3,'Owner',?4,'open',?5,?5)",
        params![project_id(lab), key, owner, data.to_string(), now()],
    ).unwrap();
}

/// The user's reply on Home, as Home keeps it: its form answers by id.
fn reply(lab: &Lab, key: &str, groups: &[&str], at: Option<&str>) {
    let form = json!({"version": 1, "formId": "approve", "answers": {"groups": groups, "except": ""}});
    lab.ws.store.db.write().unwrap().execute(
        "UPDATE project_brief_sections SET ask_state='replied',replied_at=?3,reply_text='answered',reply_form=?4 WHERE project_id=?1 AND key=?2 AND live=1",
        params![project_id(lab), key, at.map(str::to_owned).unwrap_or_else(now), form.to_string()],
    ).unwrap();
}

fn naming(plan: &Value) -> String {
    format!("Approve plan {} (sha256 {})?", plan["planId"].as_str().unwrap(), plan["sha256"].as_str().unwrap())
}

async fn apply_as(lab: &Lab, actor: &str, request: &str, plan: &Value, key: &str, exclude: &[&str]) -> Result<Value> {
    lab.ws.collaboration_call(Some(actor), "cleanup_apply",
        json!({"requestId": request, "taskId": "T-1", "planId": plan["planId"], "askKey": key, "excludeItems": exclude})).await
}

/// Waits for Core to finish applying a plan; its state then.
async fn applied(lab: &Lab, plan: &Value) -> Value {
    for _ in 0..400 {
        let read = lab.ws.collaboration_call(None, "cleanup_plan_get", json!({"planId": plan["planId"]})).await.unwrap();
        if read["state"] == "applied" {
            return read;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the plan was not applied in time");
}

fn old_entry(lab: &Lab, name: &str) -> PathBuf {
    let entry = lab.scratch.join(name);
    std::fs::create_dir_all(entry.join("out")).unwrap();
    std::fs::write(entry.join("out/shot.png"), vec![3u8; 1000]).unwrap();
    std::fs::write(entry.join("out/report.json"), "{\"ok\":true}").unwrap();
    std::fs::write(entry.join("main.rs"), "fn main() {}").unwrap();
    entry
}

#[tokio::test]
async fn an_approved_plan_removes_only_its_chosen_groups_after_checking_each_again() {
    let lab = lab();
    gated(&lab);
    let gone = old_entry(&lab, "job-old");
    let excluded = old_entry(&lab, "job-excluded");
    let kept = old_entry(&lab, "job-kept");
    let pytest = lab.scratch.join("job-3/.pytest_cache");
    std::fs::create_dir_all(pytest.join("v/cache")).unwrap();
    std::fs::write(pytest.join("CACHEDIR.TAG"), TAG_PYTEST).unwrap();
    let target = lab.project.join("target");
    cargo_target(&target, &["debug", "release"]);
    std::fs::write(target.join("release/report.html"), "evidence").unwrap();
    let plan = submit(&lab, "apply", vec![group("d", "delete"), group("r", "rebuildable"), group("k", "keep")], vec![
        item("gone", "d", "entry", &gone), item("excluded", "d", "entry", &excluded),
        item("pytest", "r", "cache-dir", &pytest), item("target", "r", "cache-dir", &target),
        item("kept", "k", "entry", &kept),
    ]).await;
    assert_eq!(plan["refused"], 0, "{plan:#}");
    ask(&lab, "gates/cleanup", "ex", 4, &naming(&plan), &["d", "r", "k"]);
    reply(&lab, "gates/cleanup", &["d", "r"], None);
    let started = apply_as(&lab, "ex", "go", &plan, "gates/cleanup", &["excluded"]).await.unwrap();
    assert_eq!(started["state"], "applying");
    assert_eq!(started["excluded"], json!(["excluded"]));
    let done = applied(&lab, &plan).await;
    assert_eq!(done["applied"]["removed"], 3, "{done:#}");
    assert!(!gone.exists() && !pytest.exists());
    assert!(excluded.exists() && kept.exists(), "excluded and keep-group items stay");
    assert!(!target.join("debug").exists(), "the Cargo-only profile went");
    assert!(target.join("release/report.html").exists() && target.join("CACHEDIR.TAG").exists(), "what Cargo did not make stays");
    let states = item_states(&lab, &plan).await;
    assert_eq!(states["excluded"], ("kept".to_owned(), Some("excluded".to_owned())));
    assert_eq!(states["kept"], ("kept".to_owned(), Some("notApproved".to_owned())));
    // The entry's evidence is in its snapshot, and it is what its sha256 says.
    let items = items_of(&lab, &plan).await;
    let snapshot = items.iter().find(|i| i["item"] == "gone").unwrap()["snapshotKept"].clone();
    let file = PathBuf::from(snapshot["path"].as_str().unwrap());
    assert!(file.starts_with(lab.root().join("data/cleanup-snapshots")), "{file:?}");
    let bytes = std::fs::read(&file).unwrap();
    use sha2::Digest as _;
    assert_eq!(snapshot["sha256"], format!("{:x}", sha2::Sha256::digest(&bytes)));
    let mut names: Vec<String> = tar::Archive::new(flate2::read::GzDecoder::new(&bytes[..])).entries().unwrap()
        .map(|e| e.unwrap().path().unwrap().display().to_string()).collect();
    names.sort();
    assert_eq!(names, ["job-old/out/report.json", "job-old/out/shot.png"], "evidence only, not sources");
    // One line on the task, one mail to the executor; a retry is the same call.
    let db = lab.ws.store.db.read().unwrap();
    let body: String = db.query_row("SELECT json_extract(data,'$.body') FROM collaboration_task_activity WHERE json_extract(data,'$.body') LIKE 'Cleanup plan % applied:%'",
        [], |r| r.get(0)).unwrap();
    assert!(body.contains("3 item(s) removed"), "{body}");
    let mail: String = db.query_row("SELECT json_extract(data,'$.body') FROM collaboration_messages WHERE recipient_id='ex' AND json_extract(data,'$.metadata.kind')='cleanup'",
        [], |r| r.get(0)).unwrap();
    assert!(mail.contains("cleanup_plan_get"), "{mail}");
    drop(db);
    let again = apply_as(&lab, "ex", "go", &plan, "gates/cleanup", &["excluded"]).await.unwrap();
    assert_eq!(again["state"], "applied");
    let other = apply_as(&lab, "ex", "go-again", &plan, "gates/cleanup", &[]).await.unwrap_err().to_string();
    assert!(other.starts_with("plan_applied:"), "{other}");
}

#[tokio::test]
async fn approvals_core_cannot_take_remove_nothing() {
    let lab = lab();
    gated(&lab);
    let entry = old_entry(&lab, "job-a");
    let plan = submit(&lab, "a1", vec![group("d", "delete"), group("k", "keep")],
        vec![item("e", "d", "entry", &entry), item("e2", "k", "entry", &old_entry(&lab, "job-b"))]).await;
    let refused = |error: anyhow::Error, code: &str| {
        let text = error.to_string();
        assert!(text.starts_with(code) && text.ends_with("Nothing was removed."), "{code}: {text}");
    };
    refused(apply_as(&lab, "ex", "x0", &plan, "gates/none", &[]).await.unwrap_err(), "approval_missing");
    ask(&lab, "open", "ex", 4, &naming(&plan), &["d", "k"]);
    refused(apply_as(&lab, "ex", "x1", &plan, "open", &[]).await.unwrap_err(), "approval_missing");
    ask(&lab, "theirs", "lead", 4, &naming(&plan), &["d", "k"]);
    reply(&lab, "theirs", &["d"], None);
    refused(apply_as(&lab, "ex", "x2", &plan, "theirs", &[]).await.unwrap_err(), "approval_not_yours");
    ask(&lab, "not-gate", "ex", 2, &naming(&plan), &["d", "k"]);
    reply(&lab, "not-gate", &["d"], None);
    refused(apply_as(&lab, "ex", "x3", &plan, "not-gate", &[]).await.unwrap_err(), "approval_not_gate");
    ask(&lab, "early", "ex", 4, &naming(&plan), &["d", "k"]);
    reply(&lab, "early", &["d"], Some("2000-01-01T00:00:00+00:00"));
    refused(apply_as(&lab, "ex", "x4", &plan, "early", &[]).await.unwrap_err(), "approval_stale");
    ask(&lab, "no-sha", "ex", 4, &format!("Approve plan {}?", plan["planId"].as_str().unwrap()), &["d", "k"]);
    reply(&lab, "no-sha", &["d"], None);
    refused(apply_as(&lab, "ex", "x5", &plan, "no-sha", &[]).await.unwrap_err(), "approval_mismatch");
    ask(&lab, "none", "ex", 4, &naming(&plan), &["d", "k"]);
    reply(&lab, "none", &[], None);
    refused(apply_as(&lab, "ex", "x6", &plan, "none", &[]).await.unwrap_err(), "approval_empty");
    ask(&lab, "keep", "ex", 4, &naming(&plan), &["d", "k"]);
    reply(&lab, "keep", &["d", "k"], None);
    refused(apply_as(&lab, "ex", "x7", &plan, "keep", &[]).await.unwrap_err(), "approval_keep");
    ask(&lab, "options", "ex", 4, &naming(&plan), &["d", "x"]);
    reply(&lab, "options", &["d"], None);
    refused(apply_as(&lab, "ex", "x8", &plan, "options", &[]).await.unwrap_err(), "approval_form");
    // The ask changed after the reply: its answers were to another version.
    ask(&lab, "edited", "ex", 4, &naming(&plan), &["d", "k"]);
    reply(&lab, "edited", &["d"], None);
    lab.ws.store.db.write().unwrap().execute("UPDATE project_brief_sections SET version=2 WHERE key='edited'", []).unwrap();
    refused(apply_as(&lab, "ex", "x9", &plan, "edited", &[]).await.unwrap_err(), "approval_form");
    // Only its executor applies it.
    ask(&lab, "good", "ex", 4, &naming(&plan), &["d", "k"]);
    reply(&lab, "good", &["d"], None);
    refused(apply_as(&lab, "lead", "x10", &plan, "good", &[]).await.unwrap_err(), "not_executor");
    // A newer plan's registration voids the approval of the older one.
    let newer = submit(&lab, "a2", vec![group("d", "delete")], vec![item("e", "d", "entry", &entry)]).await;
    refused(apply_as(&lab, "ex", "x11", &plan, "good", &[]).await.unwrap_err(), "plan_superseded");
    assert!(entry.exists());
    let read = lab.ws.collaboration_call(None, "cleanup_plan_get", json!({"planId": newer["planId"]})).await.unwrap();
    assert_eq!(read["state"], "submitted", "nothing started");
}

#[tokio::test]
async fn at_apply_what_changed_is_in_use_or_cannot_be_checked_stays() {
    let lab = lab();
    gated(&lab);
    let changed = old_entry(&lab, "changed");
    let busy = old_entry(&lab, "busy");
    let named = old_entry(&lab, "named");
    let tree = worktree(&lab, &lab.project.join(".worktrees/w"), "feat/w");
    let plan = submit(&lab, "kept", vec![group("d", "delete")], vec![
        item("changed", "d", "entry", &changed), item("busy", "d", "entry", &busy), item("named", "d", "entry", &named),
        item("tree", "d", "worktree", &tree),
    ]).await;
    std::fs::write(changed.join("late.txt"), "written after the plan").unwrap();
    let mut sleeper = std::process::Command::new("sleep").arg("30").current_dir(&busy).spawn().unwrap();
    {
        let db = lab.ws.store.db.write().unwrap();
        let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
        db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('j-named',?1,'ex','succeeded',?2)",
            params![task, json!({"id": "j-named", "cwd": named.join("out"), "target": {"kind": "local"}}).to_string()]).unwrap();
    }
    ask(&lab, "gate", "ex", 4, &naming(&plan), &["d"]);
    reply(&lab, "gate", &["d"], None);
    apply_as(&lab, "ex", "go", &plan, "gate", &[]).await.unwrap();
    applied(&lab, &plan).await;
    let _ = sleeper.kill();
    let _ = sleeper.wait();
    let states = item_states(&lab, &plan).await;
    assert_eq!(refused(&states, "changed"), "changed");
    assert_eq!(refused(&states, "busy"), "inUse");
    assert_eq!(refused(&states, "named"), "inUse");
    assert_eq!(refused(&states, "tree"), "unsupported", "this Core removes no worktree");
    assert!(changed.exists() && busy.exists() && named.exists() && tree.exists());
    // Where the processes cannot be read, nothing goes.
    let other = old_entry(&lab, "other");
    let plan = submit(&lab, "unchecked", vec![group("d", "delete")], vec![item("other", "d", "entry", &other)]).await;
    lab.ws.cleanup.processes_unavailable.store(true, std::sync::atomic::Ordering::SeqCst);
    ask(&lab, "gate2", "ex", 4, &naming(&plan), &["d"]);
    reply(&lab, "gate2", &["d"], None);
    apply_as(&lab, "ex", "go2", &plan, "gate2", &[]).await.unwrap();
    applied(&lab, &plan).await;
    assert_eq!(refused(&item_states(&lab, &plan).await, "other"), "unchecked");
    assert!(other.exists());
}

/// Design 7's red test: an item listed in the plan that is outside every
/// root when it is applied is refused then, whatever the plan said.
#[tokio::test]
async fn an_item_outside_the_roots_when_it_is_applied_is_refused() {
    let lab = lab();
    gated(&lab);
    let entry = old_entry(&lab, "job-r");
    let protected = old_entry(&lab, "job-p");
    let plan = submit(&lab, "red", vec![group("d", "delete")],
        vec![item("outside", "d", "entry", &entry), item("protected", "d", "entry", &protected)]).await;
    assert_eq!(plan["refused"], 0);
    // After the plan: the scratch root is gone from settings, and one entry is protected.
    let moved = lab.scratch.with_file_name("scratch-2");
    std::fs::create_dir_all(&moved).unwrap();
    settings_change(&lab, |c| {
        c.scratch_roots = vec![moved.display().to_string()];
        c.protected_paths = vec![protected.display().to_string()];
    });
    ask(&lab, "gate", "ex", 4, &naming(&plan), &["d"]);
    reply(&lab, "gate", &["d"], None);
    apply_as(&lab, "ex", "go", &plan, "gate", &[]).await.unwrap();
    applied(&lab, &plan).await;
    let states = item_states(&lab, &plan).await;
    assert_eq!(refused(&states, "outside"), "notScratch");
    assert_eq!(refused(&states, "protected"), "protected");
    assert!(entry.exists() && protected.exists());
}

#[tokio::test]
async fn a_plan_a_stopped_core_left_applying_is_finished_without_retrying() {
    let lab = lab();
    let entry = old_entry(&lab, "job-s");
    let plan = submit(&lab, "stopped", vec![group("d", "delete")], vec![item("e", "d", "entry", &entry)]).await;
    lab.ws.store.db.write().unwrap().execute("UPDATE cleanup_plans SET state='applying', approval='{\"groups\":[\"d\"]}' WHERE id=?1",
        [plan["planId"].as_str()]).unwrap();
    assert_eq!(lab.ws.stored(apply::recover).await.unwrap(), 1);
    let read = lab.ws.collaboration_call(None, "cleanup_plan_get", json!({"planId": plan["planId"]})).await.unwrap();
    assert_eq!(read["state"], "applied");
    assert_eq!(item_states(&lab, &plan).await["e"], ("kept".to_owned(), Some("stopped".to_owned())));
    assert!(entry.exists(), "nothing is retried");
    let mails: i64 = lab.ws.store.db.read().unwrap().query_row(
        "SELECT COUNT(*) FROM collaboration_messages WHERE recipient_id='ex' AND json_extract(data,'$.metadata.kind')='cleanup'", [], |r| r.get(0)).unwrap();
    assert_eq!(mails, 1);
}
