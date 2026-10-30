//! T-9 section-level checks of brief_update (writes.rs, update::conflict):
//! an update is stale only when a section it changes was written after the
//! version it read. A batch is refused whole; nothing of a refused update is
//! kept; a noChange is never stale, a version the Brief never had always is;
//! and where Core's record of writes can't tell, the whole Brief decides.
use super::*;

fn stale(rejected: &Value) -> Vec<(String, String)> {
    rejected["problems"].as_array().unwrap().iter()
        .map(|p| (p["code"].as_str().unwrap().to_owned(), p["path"].as_str().unwrap().to_owned()))
        .collect()
}

fn conflict_at(path: &str) -> Vec<(String, String)> {
    vec![("version_conflict".into(), path.into())]
}

fn record(ws: &Workspace, project: &str) -> Vec<(String, i64)> {
    let db = ws.store.db.read().unwrap();
    let mut query = db.prepare("SELECT key,version FROM project_brief_writes WHERE project_id=?1 ORDER BY key").unwrap();
    query.query_map([project], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
}

#[tokio::test]
async fn another_sections_write_never_makes_an_update_stale_but_its_own_does() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("plan", "report")])).await;
    // Read at 0 and at 1: other sections, not stale.
    accept(&ws, "b", input("b1", 0, vec![put("notes", "report")])).await;
    accept(&ws, "c", input("c1", 1, vec![put("c-log", "status")])).await;
    assert_eq!(version(&ws, &project), 3);
    // plan, read at 0, was written at 1: refused with the Brief as it is.
    let rejected = reject(&ws, "a", input("a2", 0, vec![put("plan", "status")])).await;
    assert_eq!(stale(&rejected), conflict_at("changes[0].key"));
    let reason = rejected["problems"][0]["reason"].as_str().unwrap();
    assert!(reason.contains("plan was written at Brief version 1, after version 0") && reason.contains("expectedVersion 3"), "{reason}");
    assert_eq!(rejected["latest"]["version"], 3);
    assert_eq!((version(&ws, &project), section(&brief(&ws, "a"), "plan")["kind"].clone()), (3, json!("report")));
    // Read at 1, when plan was written: not stale, whatever came after.
    assert_eq!(accept(&ws, "a", input("a3", 1, vec![put("plan", "status")])).await["version"], 4);
    // notes, written at 2, is stale for a read at 1.
    assert_eq!(stale(&reject(&ws, "b", input("b2", 1, vec![op("remove", "notes")])).await), conflict_at("changes[0].key"));
    assert_eq!(record(&ws, &project), [("".into(), 0), ("c-log".into(), 3), ("notes".into(), 2), ("plan".into(), 4)]);
}

#[tokio::test]
async fn every_op_on_a_section_written_since_the_read_is_refused_and_changes_nothing() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("rep", "report"), put("ask", "ask"), put("doc", "report")])).await;
    accept(&ws, "c", input("c1", 1, vec![put("orphan", "report")])).await;
    close(&ws, "c", true);
    accept(&ws, "a", input("a2", 2, vec![put("rep", "status"), put("ask", "ask"), put("doc", "status")])).await;
    let before = (version(&ws, &project), brief(&ws, "a")["sections"].clone(), record(&ws, &project));
    // Each read at 2, before a2 wrote these sections; the claim read at 1, before c1 wrote it.
    for (n, (actor, read, change)) in [
        ("a", 2, put("rep", "report")),
        ("a", 2, edit("doc", json!({"note":markdown("Late.")}))),
        ("a", 2, op("resolve", "ask")),
        ("a", 2, op("remove", "rep")),
        ("b", 1, op("claim", "orphan")),
    ].into_iter().enumerate() {
        let rejected = reject(&ws, actor, input(&format!("stale{n}"), read, vec![change])).await;
        assert_eq!(stale(&rejected), conflict_at("changes[0].key"), "{rejected}");
        assert_eq!((version(&ws, &project), brief(&ws, "a")["sections"].clone(), record(&ws, &project)), before);
    }
    // Read after those writes, the same changes go through.
    accept(&ws, "a", input("fresh", 3, vec![edit("doc", json!({"note":markdown("Now.")})), op("resolve", "ask")])).await;
    accept(&ws, "b", input("claim", 3, vec![op("claim", "orphan")])).await;
}

#[tokio::test]
async fn a_batch_with_one_stale_section_changes_nothing_and_keeps_nothing() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("plan", "report")])).await;
    accept(&ws, "b", input("b1", 1, vec![put("mine", "report")])).await;
    let receipts = rows(&ws, "SELECT COUNT(*) FROM project_brief_receipts");
    let before = record(&ws, &project);
    // Read at 1: "notes" is new, "mine" was written at 2.
    let batch = input("batch", 1, vec![put("notes", "report"), put("mine", "status")]);
    assert_eq!(stale(&reject(&ws, "b", batch).await), conflict_at("changes[1].key"));
    assert!(section(&brief(&ws, "b"), "notes").is_null());
    assert_eq!((version(&ws, &project), record(&ws, &project)), (2, before));
    assert_eq!(rows(&ws, "SELECT COUNT(*) FROM project_brief_receipts"), receipts);
    // Nothing of it was kept: the same requestId, read anew, is a new update.
    accept(&ws, "b", input("batch", 2, vec![put("notes", "report"), put("mine", "status")])).await;
    assert_eq!(section(&brief(&ws, "b"), "mine")["kind"], "status");
}

#[tokio::test]
async fn a_section_removed_or_written_again_after_the_read_is_stale() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("x", "report"), put("y", "report")])).await;
    accept(&ws, "a", input("a2", 1, vec![op("remove", "x")])).await;
    accept(&ws, "a", input("a3", 2, vec![put("x", "report")])).await;
    // x was removed at 2 and written again at 3.
    for read in [1, 2] {
        assert_eq!(stale(&reject(&ws, "a", input(&format!("x{read}"), read, vec![put("x", "status")])).await), conflict_at("changes[0].key"));
    }
    // y removed at 4: putting it again from a read before the removal is stale.
    accept(&ws, "a", input("a4", 3, vec![op("remove", "y")])).await;
    assert_eq!(stale(&reject(&ws, "a", input("y3", 3, vec![put("y", "report")])).await), conflict_at("changes[0].key"));
    // Read after both, they go through, the removed one continuing its versions.
    accept(&ws, "a", input("a5", 4, vec![put("x", "status"), put("y", "report")])).await;
    assert_eq!(section(&brief(&ws, "a"), "y")["version"], 2);
    assert_eq!(version(&ws, &project), 5);
}

#[tokio::test]
async fn a_no_change_from_a_stale_read_is_accepted_and_a_version_never_had_is_refused() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("plan", "report")])).await;
    let before = record(&ws, &project);
    // noChange changes no section: read at 0, it counts and moves nothing.
    let quiet = accept(&ws, "c", json!({"requestId":"c1","expectedVersion":0,"noChange":true})).await;
    assert_eq!((quiet["receipt"]["kind"].clone(), quiet["version"].clone()), (json!("noChange"), json!(1)));
    assert_eq!((version(&ws, &project), record(&ws, &project)), (1, before.clone()));
    assert_eq!(turn_receipt(&ws.store, "c", "t1").unwrap().as_deref(), Some("noChange"));
    // A version the Brief never had, for any request.
    for (n, request) in [json!({"requestId":"f1","expectedVersion":2,"noChange":true}),
        input("f2", 2, vec![put("fresh", "report")]), input("f3", 9, vec![op("remove", "plan")])].into_iter().enumerate() {
        let rejected = reject(&ws, "a", request).await;
        assert_eq!(stale(&rejected), conflict_at("expectedVersion"), "{n}: {rejected}");
        assert_eq!(rejected["latest"]["version"], 1);
    }
    assert_eq!((version(&ws, &project), record(&ws, &project)), (1, before));
}

#[tokio::test]
async fn a_replay_answers_as_before_after_other_sections_change() {
    let (_dir, ws, _project) = lab();
    let first = accept(&ws, "b", input("b1", 0, vec![put("notes", "report")])).await;
    accept(&ws, "a", input("a1", 1, vec![put("plan", "report")])).await;
    accept(&ws, "b", input("b2", 2, vec![put("notes", "status")])).await;
    // b1 is answered as it was, though notes was written since.
    assert_eq!(accept(&ws, "b", input("b1", 0, vec![put("notes", "report")])).await, first);
    let other = call(&ws, "b", input("b1", 0, vec![put("notes", "status")])).await.unwrap_err();
    assert!(other.to_string().starts_with("idempotency_conflict"), "{other}");
}

#[tokio::test]
async fn without_a_trusted_record_the_whole_brief_decides_and_a_write_starts_it_afresh() {
    let (_dir, ws, project) = lab();
    let sql = |statement: &str| { ws.store.db.write().unwrap().execute(statement, [&project]).unwrap(); };
    // A Brief written before writes were recorded: at version 3, no record.
    sql("INSERT INTO project_briefs(project_id,version,updated_at) VALUES(?1,3,'2026-10-30T00:00:00Z')");
    assert_eq!(stale(&reject(&ws, "a", input("a0", 2, vec![put("plan", "report")])).await), conflict_at("expectedVersion"));
    accept(&ws, "a", input("a1", 3, vec![put("plan", "report")])).await;
    assert_eq!(record(&ws, &project), [("".into(), 3), ("plan".into(), 4)]);
    // From then on, another section from a read at 3 is not stale...
    accept(&ws, "b", input("b1", 3, vec![put("notes", "report")])).await;
    // ...but a key without a row, from a read before the record began, is.
    let rejected = reject(&ws, "c", input("c1", 2, vec![put("c-log", "status")])).await;
    assert_eq!(stale(&rejected), conflict_at("changes[0].key"));
    assert!(rejected["problems"][0]["reason"].as_str().unwrap().contains("doesn't go back to version 2"), "{rejected}");
    // The Brief moved on without a record (as an older Core would write):
    // untrusted, so the whole Brief decides until a write starts it afresh.
    sql("UPDATE project_briefs SET version=version+1 WHERE project_id=?1");
    assert_eq!(stale(&reject(&ws, "c", input("c2", 5, vec![put("c-log", "status")])).await), conflict_at("expectedVersion"));
    accept(&ws, "c", input("c3", 6, vec![put("c-log", "status")])).await;
    assert_eq!(record(&ws, &project), [("".into(), 6), ("c-log".into(), 7)]);
    accept(&ws, "a", input("a2", 6, vec![put("plan", "status")])).await;
}
