//! YN-208: what a card's task delivered, as a request shows it. The result's
//! author names each deliverable (a report of the Project's Home, a pull
//! request the task links, a release of the Project's repository, a short
//! answer); Core checks it when the result is submitted, pins a report as its
//! identity on Home and version, and says where each stands each time the
//! request is read. Done, readable and confirmed stay three facts. Every
//! name, repository and report here is synthetic.
use super::*;

impl Lab {
    /// `agent` submits a result on `key` with `extra` (deliverables, status),
    /// with the dispatch a card's route made, as its Agent was given it.
    fn submit(&self, agent: &str, key: &str, id: &str, extra: Value) -> Result<Value> {
        let task = self.task(key);
        let mut input = json!({"requestId":id,"taskId":key,"expectedVersion":task["version"],"summary":"交付","status":"review"});
        if let Some(dispatch) = task["dispatch"]["id"].as_str() {
            input["dispatchId"] = json!(dispatch);
        }
        for (field, value) in extra.as_object().unwrap() {
            input[field] = value.clone();
        }
        self.ws.store.collaboration_call(Some(agent), "task_submit_result", input)
    }

    /// The card of request R-n whose task is `key`.
    fn card(&self, n: i64, key: &str) -> Value {
        self.request(n)["cards"].as_array().unwrap().iter().find(|card| card["task"]["id"] == key).cloned().unwrap()
    }

    /// The deliverables R-n's card for `key` shows, as listed.
    fn delivered(&self, n: i64, key: &str) -> Value {
        self.card(n, key)["deliverables"]["items"].clone()
    }

    /// A report `key` the lead puts (a new one, or its next version).
    async fn report(&self, key: &str, title: &str) {
        self.brief("lead", json!({"op":"put","key":key,"kind":"report","title":title,"markdown":"六项改进，按证据与验收排序。"})).await;
    }

    /// The user marks the report `key` seen at its current version, on Home.
    async fn see(&self, key: &str) {
        let version = self.section(key).await.unwrap()["version"].clone();
        let app = crate::project_brief::router().with_state(self.ws.clone());
        let request = HttpRequest::builder().method("POST").uri(format!("/api/projects/{}/brief/seen", self.project))
            .header("content-type", "application/json")
            .body(Body::from(json!({"sections":[{"key":key,"version":version}]}).to_string())).unwrap();
        assert_eq!(app.oneshot(request).await.unwrap().status(), StatusCode::OK);
    }

    /// Pull request o/r#`number`, as Core last read it from GitHub; linked to the task `key` when `linked`.
    fn pull(&self, key: Option<&str>, number: i64, state: &str) {
        let db = self.ws.store.db.write().unwrap();
        let object = format!("pull-{number}");
        db.execute("INSERT INTO github_objects(id,repo_id,kind,number,data) VALUES(?1,123,'pull',?2,?3)", params![object, number,
            json!({"snapshot":{"title":format!("[YN-1] 导出 #{number}"),"state":state,"observedAt":"2026-11-17T20:00:00Z"},
                "syncedAt":"2026-11-17T20:00:00Z","error":null}).to_string()]).unwrap();
        if let Some(key) = key {
            let (task, _) = crate::collaboration_store::task_key(&db, key).unwrap();
            db.execute("INSERT INTO github_task_links(task_id,object_id) VALUES(?1,?2)", params![task, object]).unwrap();
        }
    }

    /// The live section `key`'s identity on Home.
    fn identity(&self, key: &str) -> i64 {
        self.ws.store.db.read().unwrap().query_row(
            "SELECT COALESCE(lineage,seq) FROM project_brief_sections WHERE project_id=?1 AND key=?2 AND live=1",
            params![self.project, key], |r| r.get(0)).unwrap()
    }

    /// How many results the task `key` has had.
    fn results(&self, key: &str) -> i64 {
        let db = self.ws.store.db.read().unwrap();
        let (task, _) = crate::collaboration_store::task_key(&db, key).unwrap();
        db.query_row("SELECT COUNT(*) FROM collaboration_task_activity WHERE task_id=?1 AND json_extract(data,'$.kind')='result'",
            [task], |r| r.get(0)).unwrap()
    }
}

/// R-n routed to two cards, as R-18 was: a review of the lead's and a
/// release of the member's. Their tasks' keys.
async fn review_and_release(lab: &Lab, n: i64) -> (String, String) {
    let made = lab.route("desk", n, "审查并发布", "好，两件。", vec![to_agent("审查", "lead", "研究"), to_agent("发布", "member", "发布")])
        .await.unwrap();
    (made["routes"][0]["task"].as_str().unwrap().to_owned(), made["routes"][1]["task"].as_str().unwrap().to_owned())
}

// R-18's shape: the review delivered its report while the release goes on.
// The request is still in progress, and its review's card names the report
// by its identity and version, live: one click away. Marked seen, the very
// version stays readable in History, preferred even once a newer version of
// the same report is on Home. The request, confirmed done, keeps it; reading
// the request never confirms it.
#[tokio::test]
async fn a_review_s_report_opens_from_its_request_while_the_release_goes_on() {
    let lab = lab();
    let n = lab.say("审查架构、性能与界面可读性，之后发布下一版", "m1").await;
    let (review, release) = review_and_release(&lab, n).await;
    lab.report("audit-review", "深度审查").await;
    let identity = lab.identity("audit-review");
    lab.submit("lead", &review, "r1", json!({"status":"done",
        "deliverables":[{"kind":"report","key":"audit-review","note":"六项改进，按证据与验收排序"}]})).unwrap();

    let request = lab.request(n);
    assert_eq!((request["state"].clone(), request["progress"].clone(), request["confirmedAt"].clone()),
        (json!("doing"), json!({"cards":2,"ended":1}), Value::Null));
    let card = lab.card(n, &review);
    assert_eq!(card["result"]["status"], "done");
    assert_eq!(card["deliverables"]["items"], json!([{"kind":"report","title":"深度审查","note":"六项改进，按证据与验收排序",
        "key":"audit-review","version":1,"sectionId":identity,"state":"live","currentVersion":1}]));
    assert_eq!(card["deliverables"]["resultId"], card["result"]["id"]);
    let going = lab.card(n, &release);
    assert_eq!((going["result"].clone(), going["deliverables"].clone()), (Value::Null, Value::Null), "nothing yet, nothing guessed");

    lab.see("audit-review").await;
    assert_eq!(lab.delivered(n, &review)[0]["state"], "history");
    lab.report("audit-review", "深度审查（修订）").await;
    let item = lab.delivered(n, &review)[0].clone();
    assert_eq!((item["state"].clone(), item["version"].clone(), item["currentVersion"].clone(), item["sectionId"].clone()),
        (json!("history"), json!(1), json!(2), json!(identity)), "version 1, kept in History, is still the one named");

    lab.end(&release, "done");
    assert_eq!(lab.request(n)["state"], "ended", "read twice, still the user's to confirm");
    let done = lab.ws.store.db.write().unwrap()
        .execute("UPDATE project_requests SET confirmed_at=?2 WHERE project_id=?1", params![lab.project, crate::model::now()]).unwrap();
    assert_eq!(done, 1);
    assert_eq!(lab.request(n)["state"], "done");
    assert_eq!(lab.delivered(n, &review)[0]["state"], "history", "a done request keeps what it delivered");
}

// A version no longer kept: the same report's other version is offered,
// never another report that took its key since. Gone from Home altogether,
// it says so.
#[tokio::test]
async fn a_replaced_or_gone_report_is_said_so_and_a_reused_key_is_never_taken_for_it() {
    let lab = lab();
    let n = lab.say("比较三种导出格式", "m1").await;
    let (review, _) = review_and_release(&lab, n).await;
    lab.report("export-formats", "导出格式比较").await;
    let first = json!(lab.identity("export-formats"));
    lab.submit("lead", &review, "r1", json!({"deliverables":[{"kind":"report","key":"export-formats"}]})).unwrap();
    lab.report("export-formats", "导出格式比较 v2").await;
    let item = lab.delivered(n, &review)[0].clone();
    assert_eq!((item["state"].clone(), item["version"].clone(), item["currentVersion"].clone(), item["title"].clone()),
        (json!("replaced"), json!(1), json!(2), json!("导出格式比较")), "the title as named");

    lab.brief("lead", json!({"op":"remove","key":"export-formats"})).await;
    lab.report("export-formats", "另一份报告").await;
    assert_ne!(json!(lab.identity("export-formats")), first, "a new report under the same key");
    let item = lab.delivered(n, &review)[0].clone();
    assert_eq!((item["state"].clone(), item["currentVersion"].clone(), item["sectionId"].clone()), (json!("replaced"), json!(2), first.clone()));

    lab.ws.store.db.write().unwrap().execute("UPDATE project_brief_sections SET history_at='2000-01-01T00:00:00Z' WHERE live=0", []).unwrap();
    let item = lab.delivered(n, &review)[0].clone();
    assert_eq!((item["state"].clone(), item["currentVersion"].clone()), (json!("gone"), Value::Null), "never the live report under its key");
}

// A pull request must be one the task links, a release one of the Project's
// repositories: anything else refuses the whole result, written nowhere. A
// pull request shows GitHub's state as Core last read it, and when; a
// release only its link and tag, never checked.
#[tokio::test]
async fn pull_requests_and_releases_are_checked_against_the_task_and_its_project() {
    let lab = lab();
    let n = lab.say("导出 Markdown", "m1").await;
    let (review, _) = review_and_release(&lab, n).await;
    lab.pull(Some(&review), 7, "merged");
    lab.pull(None, 8, "open");
    let before = lab.task(&review)["version"].clone();
    for (deliverables, code) in [
        (json!([{"kind":"pr","url":"https://github.com/o/r/pull/8"}]), "deliverable_not_found"),
        (json!([{"kind":"pr","url":"https://github.com/o/r/issues/7"}]), "deliverable_invalid"),
        (json!([{"kind":"release","url":"https://github.com/o/other/releases/tag/v1.0"}]), "deliverable_not_found"),
        (json!([{"kind":"release","url":"https://github.com/o/r/releases/v1.0"}]), "deliverable_invalid"),
        (json!([{"kind":"release","url":"https://github.com/o/r/releases/tag/../x"}]), "deliverable_invalid"),
        (json!([{"kind":"pr","url":"https://github.com/o/r/pull/7"},{"kind":"report","key":"nowhere"}]), "deliverable_not_found"),
    ] {
        let refused = lab.submit("lead", &review, &format!("bad {deliverables}"), json!({"deliverables":deliverables})).unwrap_err();
        assert!(refused.to_string().starts_with(code), "{deliverables}: {refused}");
    }
    assert_eq!((lab.task(&review)["version"].clone(), lab.results(&review)), (before, 0), "nothing written");

    lab.submit("lead", &review, "r1", json!({"deliverables":[
        {"kind":"pr","url":"https://github.com/O/R/pull/7/","note":"表格和代码块都保留"},
        {"kind":"release","url":"https://github.com/o/r/releases/tag/v1.0","title":"Atlas 1.0"}]})).unwrap();
    assert_eq!(lab.delivered(n, &review), json!([
        {"kind":"pr","title":"[YN-1] 导出 #7","note":"表格和代码块都保留","url":"https://github.com/o/r/pull/7","repository":"o/r","number":7,
         "state":"merged","observedAt":"2026-11-17T20:00:00Z"},
        {"kind":"release","title":"Atlas 1.0","note":null,"url":"https://github.com/o/r/releases/tag/v1.0","repository":"o/r","tag":"v1.0"}]));
}

// deliverables is a result's whole list: left out, the earlier list stays;
// a new list takes its place, adding nothing; [] clears it. An entry that
// fails refuses the whole result. A result from before names nothing, and
// nothing is guessed for it.
#[tokio::test]
async fn a_result_s_list_replaces_the_earlier_one_and_an_old_result_names_nothing() {
    let lab = lab();
    let n = lab.say("导出 Markdown", "m1").await;
    let (review, release) = review_and_release(&lab, n).await;
    lab.submit("member", &release, "old", json!({})).unwrap();
    let old = lab.card(n, &release);
    assert_eq!((old["result"]["status"].clone(), old["deliverables"].clone()), (json!("review"), Value::Null));

    lab.report("export-md", "导出 Markdown 说明").await;
    let first = lab.submit("lead", &review, "r1", json!({"status":"doing","deliverables":[{"kind":"report","key":"export-md"}]})).unwrap();
    lab.submit("lead", &review, "r2", json!({})).unwrap();
    let card = lab.card(n, &review);
    assert_eq!((card["deliverables"]["resultId"].clone(), card["deliverables"]["items"][0]["kind"].clone()),
        (first["task"]["result"]["id"].clone(), json!("report")), "left out: the earlier list stays");
    assert_ne!(card["result"]["id"], card["deliverables"]["resultId"], "the newest result is another");

    lab.submit("lead", &review, "r3", json!({"deliverables":[{"kind":"answer","text":"默认是 JSON。"}]})).unwrap();
    assert_eq!(lab.delivered(n, &review), json!([{"kind":"answer","title":null,"text":"默认是 JSON。"}]), "replaced, not added to");

    let long = "长".repeat(121);
    for (deliverables, what) in [
        (json!((0..7).map(|_| json!({"kind":"answer","text":"是"})).collect::<Vec<_>>()), "seven"),
        (json!([{"kind":"answer","text":"是","title":long}]), "a title over 120"),
        (json!([{"kind":"answer","text":"是","note":"一句"}]), "an answer takes no note"),
        (json!([{"kind":"link","url":"https://example.invalid"}]), "an unknown kind"),
        (json!({"kind":"answer","text":"是"}), "not a list"),
    ] {
        let refused = lab.submit("lead", &review, what, json!({"deliverables":deliverables})).unwrap_err();
        assert!(refused.to_string().starts_with("deliverable_invalid"), "{what}: {refused}");
    }
    assert_eq!(lab.delivered(n, &review)[0]["kind"], "answer", "a refused result changes nothing");

    lab.submit("lead", &review, "r4", json!({"deliverables":[]})).unwrap();
    assert_eq!(lab.delivered(n, &review), json!([]), "cleared");
}

// A task in no Project has no Home and no repositories: a report or a
// release it names is refused; an answer is not.
#[test]
fn a_task_in_no_project_delivers_no_report() {
    let lab = lab();
    let task = lab.ws.store.collaboration_call(Some("lead"), "task_create", json!({"requestId":"t","title":"零散","projectId":null})).unwrap();
    let key = task["task"]["id"].as_str().unwrap().to_owned();
    let refused = lab.submit("lead", &key, "r1", json!({"deliverables":[{"kind":"report","key":"audit-review"}]})).unwrap_err();
    assert!(refused.to_string().contains("is in no Project"), "{refused}");
    lab.submit("lead", &key, "r2", json!({"deliverables":[{"kind":"answer","text":"好了"}]})).unwrap();
}

// task_submit_result says what deliverables is within what a harness keeps
// of a tool's description, and its parameter carries the rules.
#[test]
fn task_submit_result_says_what_deliverables_is() {
    let tools = crate::collaboration_store::tool_definitions();
    let tool = tools.iter().find(|tool| tool["name"] == "task_submit_result").unwrap();
    let description = tool["description"].as_str().unwrap();
    assert!(description.encode_utf16().count() <= crate::results::max_description_length(), "{}", description.encode_utf16().count());
    assert!(description.contains("the whole list, replacing an earlier result's"));
    let schema = &tool["inputSchema"]["properties"]["deliverables"];
    assert_eq!(schema["maxItems"], 6);
    assert!(schema["description"].as_str().unwrap().contains("never adds to it"));
}
