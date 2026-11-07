use super::*;
use crate::{model::AgentDetail, store::Store};
use axum::http::StatusCode;
use std::collections::BTreeMap;
use tower::ServiceExt;

fn agent(store: &Store, id: &str) {
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),
        "cwd":"/synthetic/work","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&agent).unwrap();
}

fn project(store: &Store, name: &str, members: &[&str]) -> String {
    let id = store.create_project(name, BTreeMap::from([("local".into(), "/synthetic/project".into())])).unwrap().id;
    for member in members {
        store.set_agent_project(member, Some(&id)).unwrap();
    }
    id
}

fn close(store: &Store, id: &str) {
    store.update(id, "agent/closed", &json!({}), |d| d.agent.closed_at = Some("then".into())).unwrap();
}

/// An executor as phase 1 will make one: here only its row.
fn executor(store: &Store, id: &str) {
    store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,template_id,created_by,state,created_at,updated_at)
         VALUES(?1,'executor','template','lead','created','now','now')", [id]).unwrap();
}

fn kind_of(store: &Store, id: &str) -> &'static str {
    kind(&store.db.read().unwrap(), id).unwrap()
}

/// The Agent JSON as the database holds it.
fn record(store: &Store, id: &str) -> Value {
    let raw: String = store.db.read().unwrap().query_row("SELECT data FROM agents WHERE id=?1", [id], |r| r.get(0)).unwrap();
    serde_json::from_str(&raw).unwrap()
}

/// T-33: a lead mark is a row of its own, never in the Agent's JSON, so an
/// older Core that rewrites the JSON with only the fields it knows (and so
/// drops any it does not) cannot lose it; nor can a field of that name in the
/// JSON change it. Deleting the Agent removes its row.
#[test]
fn a_lead_mark_lives_beside_the_agent_record_and_survives_an_older_cores_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let store = Store::open(&path).unwrap();
    for id in ["a", "b"] {
        agent(&store, id);
    }
    let p = project(&store, "Lab", &["a", "b"]);
    assert_eq!(save(&store, &p, 0, vec!["a".into()]).unwrap(), Leads { version: 1, lead_agent_ids: vec!["a".into()] });
    assert_eq!((kind_of(&store, "a"), kind_of(&store, "b")), (LEAD, STANDING));
    let listed: Vec<_> = store.agents().unwrap().into_iter().map(|a| (a.id, a.kind)).collect();
    assert_eq!(listed, [("a".to_owned(), Some("lead".to_owned())), ("b".to_owned(), None)]);
    assert!(record(&store, "a")["agent"].get("kind").is_none(), "the mark is not in the Agent's JSON");

    // An older Core writes the Agent back with only the fields it knows,
    // here without `goal`, and a stray `kind` this Core does not read.
    let mut old = record(&store, "a");
    old["agent"].as_object_mut().unwrap().remove("goal");
    old["agent"]["kind"] = json!("standing");
    store.db.write().unwrap().execute("UPDATE agents SET data=?1 WHERE id='a'", [old.to_string()]).unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(kind_of(&store, "a"), LEAD);
    assert_eq!(store.agents().unwrap()[0].kind.as_deref(), Some("lead"), "the JSON's kind is never read");
    assert_eq!(get(&store, &p).unwrap(), Leads { version: 1, lead_agent_ids: vec!["a".into()] });

    // This Core's own write of the record keeps it too, and writes no kind.
    store.update("a", "agent/renamed", &json!({}), |d| d.agent.name = "Renamed".into()).unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(kind_of(&store, "a"), LEAD);
    assert!(record(&store, "a")["agent"].get("kind").is_none());
    let peers = store.collaboration_call(None, "peers_list", json!({})).unwrap();
    assert_eq!(peers["peers"][0]["kind"], "lead");

    // Deleting the Agent removes its mark with it.
    close(&store, "a");
    store.delete_closed_agent("a").unwrap();
    let rows: i64 = store.db.read().unwrap().query_row("SELECT COUNT(*) FROM agent_roles", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0);
    assert_eq!(get(&store, &p).unwrap().lead_agent_ids, Vec::<String>::new());
}

async fn call(ws: &Arc<Workspace>, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut request = axum::http::Request::builder().method(method).uri(path);
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    let request = request.body(body.map_or_else(axum::body::Body::empty, |b| axum::body::Body::from(b.to_string()))).unwrap();
    let response = router().with_state(ws.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

/// T-33: the user sets a Project's leads through its own route, as Home
/// content editors are set: open members only, never an executor, each once,
/// against the version read. Those left out lose the mark; executor rows
/// stay. A kept save is announced; an Agent has no operation for it.
#[tokio::test]
async fn the_user_sets_a_projects_leads_from_its_open_members_against_the_version_read() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let store = &ws.store;
    for id in ["a", "b", "c", "d", "x"] {
        agent(store, id);
    }
    let p = project(store, "Lab", &["a", "b", "d", "x"]);
    project(store, "Other", &["c"]);
    close(store, "d");
    executor(store, "x");
    let path = format!("/api/projects/{p}/leads");
    let (status, none) = call(&ws, "GET", &path, None).await;
    assert_eq!((status, none), (StatusCode::OK, json!({"version":0,"leadAgentIds":[]})));

    let mut events = ws.changes.subscribe(None);
    let (status, saved) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":0,"leadAgentIds":["a","b"]}))).await;
    assert_eq!((status, saved), (StatusCode::OK, json!({"version":1,"leadAgentIds":["a","b"]})));
    let announced: Value = serde_json::from_str(&events.try_next().expect("a kept save is announced").data).unwrap();
    assert_eq!((announced["type"].clone(), announced["scope"].clone(), announced["projectId"].clone()),
        (json!("workspace.changed"), json!("projects"), json!(p)));

    for (body, says) in [
        (json!({"expectedVersion":0,"leadAgentIds":["a"]}), "version_conflict: this Project's leads changed"),
        (json!({"expectedVersion":1,"leadAgentIds":["c"]}), "invalid_lead: select an open Agent in this Project"),
        (json!({"expectedVersion":1,"leadAgentIds":["d"]}), "invalid_lead: select an open Agent in this Project"),
        (json!({"expectedVersion":1,"leadAgentIds":["nobody"]}), "invalid_lead: select an open Agent in this Project"),
        (json!({"expectedVersion":1,"leadAgentIds":["x"]}), "invalid_lead: an executor cannot lead a Project"),
        (json!({"expectedVersion":1,"leadAgentIds":["a","a"]}), "Each lead must be listed once"),
    ] {
        let (status, refused) = call(&ws, "PUT", &path, Some(body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(refused["error"].as_str().unwrap().starts_with(says), "{body}: {refused}");
    }
    // Without the list, or with a field it does not take, nothing is read as a save.
    for body in [json!({"expectedVersion":1}), json!({"expectedVersion":1,"leadAgentIds":[],"kind":"lead"})] {
        let (status, _) = call(&ws, "PUT", &path, Some(body.clone())).await;
        assert!(status.is_client_error(), "{body}");
    }
    assert!(events.try_next().is_none(), "refused saves are not announced");
    assert_eq!(get(store, &p).unwrap(), Leads { version: 1, lead_agent_ids: vec!["a".into(), "b".into()] });

    // A new list replaces the old: a loses the mark, the executor keeps its own.
    let (status, saved) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":1,"leadAgentIds":["b"]}))).await;
    assert_eq!((status, saved), (StatusCode::OK, json!({"version":2,"leadAgentIds":["b"]})));
    assert_eq!([kind_of(store, "a"), kind_of(store, "b"), kind_of(store, "x")], [STANDING, LEAD, EXECUTOR]);
    let (status, cleared) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":2,"leadAgentIds":[]}))).await;
    assert_eq!((status, cleared), (StatusCode::OK, json!({"version":3,"leadAgentIds":[]})));
    assert_eq!(kind_of(store, "b"), STANDING);

    let (status, _) = call(&ws, "GET", "/api/projects/nowhere/leads", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // No collaboration operation sets leads.
    assert!(store.collaboration_call(Some("a"), "project_leads_set", json!({"projectId":p,"leadAgentIds":["a"]})).is_err());
}

/// T-33: peers_list says each Agent's kind and filters by it.
#[test]
fn peers_list_names_each_agents_kind_and_filters_by_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    for id in ["a", "b", "x"] {
        agent(&store, id);
    }
    let p = project(&store, "Lab", &["a", "b", "x"]);
    executor(&store, "x");
    save(&store, &p, 0, vec!["b".into()]).unwrap();
    let list = |input: Value| -> Vec<(String, String)> {
        store.collaboration_call(None, "peers_list", input).unwrap()["peers"].as_array().unwrap().iter()
            .map(|p| (p["id"].as_str().unwrap().to_owned(), p["kind"].as_str().unwrap().to_owned())).collect()
    };
    let pair = |id: &str, kind: &str| (id.to_owned(), kind.to_owned());
    assert_eq!(list(json!({})), [pair("a", "standing"), pair("b", "lead"), pair("x", "executor")]);
    assert_eq!(list(json!({"kind":"lead"})), [pair("b", "lead")]);
    assert_eq!(list(json!({"kind":"executor"})), [pair("x", "executor")]);
    assert_eq!(list(json!({"kind":"standing"})), [pair("a", "standing")]);
    let wrong = store.collaboration_call(None, "peers_list", json!({"kind":"boss"})).unwrap_err().to_string();
    assert_eq!(wrong, "invalid_input: kind must be lead, executor or standing");
}

/// T-33: the check phase 1's template dispatch will use. The user always
/// may; an Agent only as a lead of the task's own Project; a task in no
/// Project is the user's alone. A lead moved to another Project no longer
/// leads the first.
#[test]
fn only_a_lead_of_the_tasks_project_or_the_user_may_dispatch_it_from_a_template() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    for id in ["lead", "member", "x", "other"] {
        agent(&store, id);
    }
    let p = project(&store, "Lab", &["lead", "member", "x"]);
    let q = project(&store, "Other", &["other"]);
    executor(&store, "x");
    save(&store, &p, 0, vec!["lead".into()]).unwrap();
    save(&store, &q, 0, vec!["other".into()]).unwrap();
    let task = |request: &str, project: Option<&str>| -> String {
        let mut input = json!({"requestId":request,"title":request});
        if let Some(project) = project {
            input["projectId"] = json!(project);
        }
        // Its key (T-n, or its Project's key and number, T-56) names its row.
        let key = store.collaboration_call(None, "task_create", input).unwrap()["task"]["id"].as_str().unwrap().to_owned();
        crate::collaboration_store::task_key(&store.db.read().unwrap(), &key).unwrap().0
    };
    let (in_p, in_q, loose) = (task("p", Some(&p)), task("q", Some(&q)), task("loose", None));
    let actor = |kind: &str, id: &str| TaskActor { kind: kind.into(), id: id.into(), name: id.into() };
    let check = |who: &TaskActor, task: &str| {
        may_dispatch_from_template(&store.db.read().unwrap(), who, task).map_err(|e| e.to_string())
    };
    let user = actor("user", "user");
    for task in [&in_p, &in_q, &loose] {
        assert_eq!(check(&user, task), Ok(()));
    }
    assert_eq!(check(&actor("agent", "lead"), &in_p), Ok(()));
    assert_eq!(check(&actor("agent", "other"), &in_q), Ok(()));
    let not_lead = Err("not_lead: only a lead of this task's Project, or the user, can dispatch it from an executor template".to_owned());
    for (who, task) in [("lead", &in_q), ("other", &in_p), ("member", &in_p), ("x", &in_p)] {
        assert_eq!(check(&actor("agent", who), task), not_lead, "{who}");
    }
    assert_eq!(check(&actor("agent", "lead"), &loose),
        Err("not_lead: this task is in no Project, so only the user can dispatch it from an executor template".to_owned()));
    store.set_agent_project("lead", Some(&q)).unwrap();
    assert_eq!(check(&actor("agent", "lead"), &in_p), not_lead, "a lead moved away no longer leads the Project");
    assert_eq!(get(&store, &p).unwrap().lead_agent_ids, Vec::<String>::new());
    // Nor does it lead where it went (R1 55e2e216): the user chose it for p only.
    assert_eq!(check(&actor("agent", "lead"), &in_q), not_lead, "moved in, it does not lead");
    assert_eq!(get(&store, &q).unwrap().lead_agent_ids, ["other"]);
    assert_eq!(kind_of(&store, "lead"), STANDING);
    assert_eq!(get(&store, &p).unwrap().version, 2, "the list it left changed version");
}

/// R1 55e2e216: a lead leads the Project it was chosen for and no other.
/// Moved by an older Core, which keeps no marks, it leads nowhere until it is
/// back in that Project; a save for its new Project names that one instead.
/// Moved by this Core, even out of every Project, its mark ends.
#[test]
fn a_lead_leads_only_the_project_it_was_chosen_for_wherever_it_is_moved() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    for id in ["a", "b"] {
        agent(&store, id);
    }
    let p = project(&store, "Lab", &["a", "b"]);
    let q = project(&store, "Other", &[]);
    save(&store, &p, 0, vec!["a".into(), "b".into()]).unwrap();
    let older_core_moves = |id: &str, to: &str| {
        store.db.write().unwrap().execute("UPDATE project_agents SET project_id=?1 WHERE agent_id=?2", params![to, id]).unwrap();
    };
    let leads_of = |id: &str, project: &str| leads(&store.db.read().unwrap(), id, project).unwrap();

    older_core_moves("a", &q);
    assert_eq!(kind_of(&store, "a"), STANDING);
    assert!(!leads_of("a", &q), "moved in, it does not lead");
    assert!(!leads_of("a", &p), "moved away, it does not lead");
    assert_eq!(get(&store, &q).unwrap().lead_agent_ids, Vec::<String>::new());
    assert_eq!(get(&store, &p).unwrap().lead_agent_ids, ["b"]);
    let marked = store.collaboration_call(None, "peers_list", json!({"kind":"lead"})).unwrap();
    assert_eq!(marked["peers"].as_array().unwrap().iter().map(|peer| peer["id"].clone()).collect::<Vec<_>>(), [json!("b")]);
    assert!(store.agents().unwrap().iter().find(|listed| listed.id == "a").unwrap().kind.is_none());
    // Back in p, the user's choice for p holds again.
    older_core_moves("a", &p);
    assert_eq!(kind_of(&store, "a"), LEAD);
    // In q again, the user makes it a lead of q: its row names q now.
    older_core_moves("a", &q);
    save(&store, &q, 0, vec!["a".into()]).unwrap();
    assert!(leads_of("a", &q));
    assert_eq!(get(&store, &p).unwrap().lead_agent_ids, ["b"]);

    // This Core moving b out of every Project ends the mark: back in p, b is
    // standing until chosen again, and p's list changed version.
    let version = get(&store, &p).unwrap().version;
    store.set_agent_project("b", None).unwrap();
    assert_eq!(kind_of(&store, "b"), STANDING);
    store.set_agent_project("b", Some(&p)).unwrap();
    assert_eq!(kind_of(&store, "b"), STANDING, "moved back, it is not a lead until chosen again");
    assert_eq!(get(&store, &p).unwrap(), Leads { version: version + 1, lead_agent_ids: vec![] });
}

/// YN-2 S4, the user's rule: an Agent the user moves into a Project leads it
/// (`user_moves_agent`, the move route's call). A saved list keeps the leads
/// the user chose and gains it; a member the user did not choose stays as it
/// was. An executor never leads, wherever the user moves it, nor does a
/// closed Agent; a move into the Project it is in changes nothing.
#[test]
fn an_agent_the_user_moves_in_leads_and_an_executor_never_does() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    for id in ["a", "b", "c", "e", "x"] {
        agent(&store, id);
    }
    let p = project(&store, "Lab", &["a", "b"]);
    save(&store, &p, 0, vec!["a".into()]).unwrap();
    store.user_moves_agent("c", Some(&p)).unwrap();
    assert_eq!(get(&store, &p).unwrap(), Leads { version: 2, lead_agent_ids: vec!["a".into(), "c".into()] },
        "an Agent the user moves in leads; the saved choice stays");
    assert_eq!(kind_of(&store, "b"), STANDING, "a member the user did not choose stays as it was");
    executor(&store, "e");
    store.user_moves_agent("e", Some(&p)).unwrap();
    assert_eq!(kind_of(&store, "e"), EXECUTOR, "an executor never leads, wherever the user moves it");
    close(&store, "x");
    store.user_moves_agent("x", Some(&p)).unwrap();
    assert!(!leads(&store.db.read().unwrap(), "x", &p).unwrap(), "nor does a closed Agent");
    assert_eq!(get(&store, &p).unwrap(), Leads { version: 2, lead_agent_ids: vec!["a".into(), "c".into()] });
    store.user_moves_agent("c", Some(&p)).unwrap();
    assert_eq!(get(&store, &p).unwrap().version, 2, "a move into the Project it is in changes nothing");
    // The user removes c; it stays removed while it stays there.
    save(&store, &p, 2, vec!["a".into()]).unwrap();
    store.user_moves_agent("c", Some(&p)).unwrap();
    assert_eq!(kind_of(&store, "c"), STANDING);
    // Moved out and in again by the user, it leads again.
    store.user_moves_agent("c", None).unwrap();
    store.user_moves_agent("c", Some(&p)).unwrap();
    assert_eq!(kind_of(&store, "c"), LEAD);
}

/// YN-2 S4, at upgrade: a Project whose leads were never saved gets every
/// open member that is not an executor as its lead, once, and its version
/// moves on; a Project with a saved list keeps it. Opening again changes
/// nothing more.
#[test]
fn at_upgrade_a_project_with_no_saved_leads_gets_its_open_members_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let (fresh, chosen) = {
        let store = Store::open(&path).unwrap();
        for id in ["a", "b", "e", "x", "y", "z"] {
            agent(&store, id);
        }
        let fresh = project(&store, "Fresh", &["a", "b", "e", "x"]);
        executor(&store, "e");
        close(&store, "x");
        let chosen = project(&store, "Chosen", &["y", "z"]);
        save(&store, &chosen, 0, vec!["y".into()]).unwrap();
        (fresh, chosen)
    };
    let store = Store::open(&path).unwrap();
    assert_eq!(get(&store, &fresh).unwrap(), Leads { version: 1, lead_agent_ids: vec!["a".into(), "b".into()] },
        "a Project with no saved leads gets its open members that are not executors, once");
    assert_eq!(kind_of(&store, "e"), EXECUTOR);
    assert_eq!(get(&store, &chosen).unwrap(), Leads { version: 1, lead_agent_ids: vec!["y".into()] }, "a saved list is kept");
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(get(&store, &fresh).unwrap().version, 1, "opening again writes nothing more");
    assert_eq!(get(&store, &chosen).unwrap().lead_agent_ids, ["y"]);
}
