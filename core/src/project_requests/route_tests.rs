//! YN-86 S3a-2: project_route, what routing made of a request, follow-ups
//! after it, and the user's reassignment of a card. The lab's Agents run no
//! harness: a message Core admits gets a receipt, whatever the harness then
//! does with it, so a receipt is what "sent" means here (as in tests.rs).
//! An executor a route dispatches is made and waits for its slot: no pass
//! starts it. Cards are written through brief_update and its validator.
use super::*;
use crate::{
    message_content::TextBlock,
    model::{AgentDetail, MessageReceipt, MAX_MESSAGE_TEXT},
    project_brief::MAX_REPLY,
    project_requests::{follow_up, page, submit, Words},
};
use axum::{body::Body, http::{Request as HttpRequest, StatusCode}};
use std::collections::BTreeMap;
use tower::ServiceExt;

fn agent(id: &str, name: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":id,"name":name,"cwd":"/synthetic/work","model":"test","color":"sage",
        "threadId":format!("session-{id}"),"status":"idle","connectionState":"connected","createdAt":"","updatedAt":"",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]}))
    .unwrap()
}

/// Connected and working on a Turn, as an Agent calling a tool is.
fn running(ws: &Workspace, id: &str) {
    ws.store
        .update(id, "test/running", &json!({}), |d| {
            d.turns.push(json!({"id":"t1","status":"inProgress","items":[]}));
            d.agent.status = "working".into();
            d.agent.connection_state = "connected".into();
        })
        .unwrap();
}

struct Lab {
    _dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    project: String,
    workspace: String,
}

/// A Workspace on disk next to the build (/tmp is memory here) with one
/// Project, "Code", whose folder is on this host; its leads Desk (its front
/// desk) and Lead, and Member, all running a Turn; and one executor
/// template, design. No executor it dispatches starts.
fn lab() -> Lab {
    let parent = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
    std::fs::create_dir_all(parent).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
    let folder = dir.path().join("work");
    std::fs::create_dir_all(&folder).unwrap();
    let folder = std::fs::canonicalize(folder).unwrap().to_string_lossy().into_owned();
    let ws = Workspace::new(dir.path().join("data"), folder.clone(), "unused-harness".into()).unwrap();
    ws.executor_slots.quiet.store(true, std::sync::atomic::Ordering::Relaxed);
    let project = ws.store.create_project("Code", BTreeMap::from([("local".into(), folder)])).unwrap().id;
    for (id, name) in [("desk", "Desk"), ("lead", "Lead"), ("member", "Member")] {
        ws.store.insert(&agent(id, name)).unwrap();
        ws.store.set_agent_project(id, Some(&project)).unwrap();
        running(&ws, id);
    }
    let version = crate::agent_roles::get(&ws.store, &project).unwrap().version;
    crate::agent_roles::save(&ws.store, &project, version, vec!["desk".into(), "lead".into()]).unwrap();
    front_desk::save(&ws.store, &project, 0, Some("desk".into())).unwrap();
    ws.store.db.write().unwrap().execute(
        "INSERT INTO workspace_meta(key,value) VALUES('executors.templates',?1)",
        [json!({"version":1,"templates":[{"id":"design","label":"Design","harness":"codex","routing":"fixed"}]}).to_string()],
    ).unwrap();
    let workspace = ws.store.workspace_id().unwrap();
    Lab { _dir: dir, ws, project, workspace }
}

fn design(title: &str, why: &str) -> Value {
    json!({"kind":"card","title":title,"shortName":"设计稿","why":why,"executor":{"templateId":"design"}})
}

fn to_agent(title: &str, agent: &str, why: &str) -> Value {
    json!({"kind":"card","title":title,"shortName":"开发协调","why":why,"agentId":agent})
}

fn join(card: &str, why: &str) -> Value {
    json!({"kind":"existing","cardKey":card,"why":why})
}

impl Lab {
    fn words(&self, text: &str, id: &str) -> Words {
        Words { workspace_id: self.workspace.clone(), text: text.into(), text_blocks: None, client_message_id: id.into() }
    }

    /// The user says `text`: its request number.
    async fn say(&self, text: &str, id: &str) -> i64 {
        self.say_words(self.words(text, id)).await
    }

    async fn say_words(&self, words: Words) -> i64 {
        submit(&self.ws, &self.project, words).await.unwrap()["request"]["n"].as_i64().unwrap()
    }

    async fn route(&self, actor: &str, n: i64, title: &str, note: &str, routes: Vec<Value>) -> Result<Value> {
        self.ws.collaboration_call(Some(actor), TOOL, json!({"request":format!("R-{n}"),"title":title,"note":note,"routes":routes})).await
    }

    fn request(&self, n: i64) -> Value {
        let listed = page(&self.ws.store.db.read().unwrap(), &self.project, None, Some(50)).unwrap();
        listed["requests"].as_array().unwrap().iter().find(|r| r["n"] == n).cloned().unwrap()
    }

    fn task(&self, key: &str) -> Value {
        self.ws.store.collaboration_call(None, "task_get", json!({"taskId":key,"view":"full"})).unwrap()["task"].clone()
    }

    fn count(&self, sql: &str) -> i64 {
        self.ws.store.db.read().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// Messages Core admitted to `agent` (each has a receipt).
    fn sent(&self, agent: &str) -> i64 {
        self.ws.store.db.read().unwrap()
            .query_row("SELECT COUNT(*) FROM agent_receipts WHERE agent_id=?1", [agent], |r| r.get(0)).unwrap()
    }

    fn mail(&self, agent: &str) -> Vec<Value> {
        let rows: Vec<String> = self.ws.store.db.read().unwrap()
            .prepare("SELECT data FROM collaboration_messages WHERE recipient_id=?1 ORDER BY seq").unwrap()
            .query_map([agent], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        rows.iter().map(|raw| serde_json::from_str(raw).unwrap()).collect()
    }

    fn receipt(&self, agent: &str, id: &str) -> Option<MessageReceipt> {
        self.ws.store.receipt(agent, id).unwrap()
    }

    fn route_id(&self, n: i64, index: i64) -> String {
        self.ws.store.db.read().unwrap().query_row(
            "SELECT r.id FROM project_routes r JOIN project_requests q ON q.id=r.request_id WHERE q.project_id=?1 AND q.n=?2 AND r.idx=?3",
            params![self.project, n, index], |r| r.get(0)).unwrap()
    }

    /// A live section of the Brief as brief_get shows it.
    async fn section(&self, key: &str) -> Option<Value> {
        let read = self.ws.collaboration_call(Some("desk"), "brief_get", json!({"keys":[key]})).await.unwrap();
        read["sections"].as_array().unwrap().iter().find(|s| s["key"] == key).cloned()
    }

    async fn brief(&self, agent: &str, change: Value) {
        let version = self.ws.collaboration_call(Some(agent), "brief_get", json!({"keys":[]})).await.unwrap()["version"].as_i64().unwrap();
        self.ws.collaboration_call(Some(agent), "brief_update",
            json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedVersion":version,"changes":[change]})).await.unwrap();
    }

    /// The user sets the task done or cancelled.
    fn end(&self, key: &str, status: &str) {
        let version = self.task(key)["version"].clone();
        self.ws.store.collaboration_call(None, "task_update", json!({"requestId":format!("{status} {key}"),"taskId":key,
            "expectedVersion":version,"patch":{"status":status}})).unwrap();
    }

    fn released_by(&self, agent: &str) -> Option<String> {
        self.ws.store.db.read().unwrap()
            .query_row("SELECT released_by FROM agent_roles WHERE agent_id=?1", [agent], |r| r.get(0)).unwrap()
    }
}

fn utf16(text: &str, start: usize, end: usize) -> String {
    String::from_utf16(&text.encode_utf16().collect::<Vec<_>>()[start..end]).unwrap()
}

fn kept_request(text: &str) -> Request {
    Request {
        id: "r".into(), n: 1, text: text.into(), text_blocks: None, title: None, created_at: String::new(),
        front_agent_id: "desk".into(), message_id: "m".into(), state: "open".into(),
    }
}

// §4.2: only the Project's front desk routes: not another lead, a member or
// the user; not a stored front desk that no longer leads the Project (a
// lead removed before its front desk was cleared, Dev Lead 2 seq 12103),
// nor the lead it used to be once another is the only lead. Nothing is
// recorded or done.
#[tokio::test]
async fn only_the_projects_front_desk_routes() {
    let lab = lab();
    let n = lab.say("把设置页重新排版", "m1").await;
    let routes = vec![design("设置页排版", "先出两版布局")];
    for actor in ["lead", "member"] {
        let error = lab.route(actor, n, "设置页排版", "好", routes.clone()).await.unwrap_err();
        assert!(error.to_string().starts_with("not_front_desk"), "{actor}: {error}");
    }
    let user = lab.ws.collaboration_call(None, TOOL, json!({"request":"R-1","title":"t","note":"n","routes":routes})).await.unwrap_err();
    assert!(user.to_string().starts_with("agent_only"), "{user}");
    // Member is the front desk on record but leads nothing: no one routes.
    lab.ws.store.db.write().unwrap().execute("UPDATE project_front_desk SET agent_id='member'", []).unwrap();
    for actor in ["member", "desk"] {
        let error = lab.route(actor, n, "设置页排版", "好", routes.clone()).await.unwrap_err();
        assert!(error.to_string().starts_with("not_front_desk"), "{actor}: {error}");
    }
    // Desk on record again, then removed from the leads before the record
    // was cleared: Lead, the only lead, is the front desk now.
    lab.ws.store.db.write().unwrap().execute("UPDATE project_front_desk SET agent_id='desk'", []).unwrap();
    lab.ws.store.db.write().unwrap().execute("DELETE FROM agent_roles WHERE agent_id='desk'", []).unwrap();
    let error = lab.route("desk", n, "设置页排版", "好", routes.clone()).await.unwrap_err();
    assert!(error.to_string().starts_with("not_front_desk"), "{error}");
    assert_eq!(lab.count("SELECT COUNT(*) FROM project_routes"), 0);
    assert_eq!(lab.count("SELECT COUNT(*) FROM collaboration_tasks"), 0);
    assert_eq!(lab.request(n)["title"], Value::Null);
    assert_eq!(lab.request(n)["state"], "waiting");
}

// §4.2, §8: refused whole, nothing recorded, when a join has no why, when a
// title, note or why is empty or over 120 characters, a card's title is over
// its task's 300 bytes, or a route is malformed. At the limits it is accepted.
#[tokio::test]
async fn a_call_with_a_missing_or_long_line_is_refused_whole() {
    let lab = lab();
    let n = lab.say("导出要 CSV", "m1").await;
    let long = "长".repeat(MAX_LINE + 1);
    let card = design("导出格式", "要比较格式");
    let mut no_why = join("code-1", "x");
    no_why.as_object_mut().unwrap().remove("why");
    let mut blank_why = card.clone();
    blank_why["why"] = json!("  \n ");
    let mut long_why = card.clone();
    long_why["why"] = json!(long);
    let mut wide = card.clone();
    wide["title"] = json!("长".repeat(101));
    let mut no_short = card.clone();
    no_short.as_object_mut().unwrap().remove("shortName");
    let mut both = card.clone();
    both["agentId"] = json!("lead");
    for (title, note, routes, code, why) in [
        ("导出格式", "好", vec![no_why], "invalid_input: routes[0].why is required", "a join without why"),
        ("导出格式", "好", vec![card.clone(), blank_why], "invalid_input: routes[1].why is empty", "a blank why"),
        ("导出格式", "好", vec![long_why], "invalid_input: routes[0].why is 121 characters", "a long why"),
        ("", "好", vec![card.clone()], "invalid_input: title is empty", "an empty title"),
        ("   ", "好", vec![card.clone()], "invalid_input: title is empty", "a blank title"),
        (long.as_str(), "好", vec![card.clone()], "invalid_input: title is 121 characters", "a long title"),
        ("导出格式", "", vec![card.clone()], "invalid_input: note is empty", "an empty note"),
        ("导出格式", long.as_str(), vec![card.clone()], "invalid_input: note is 121 characters", "a long note"),
        ("导出格式", "好", vec![wide], "invalid_input: routes[0].title is 303 bytes in UTF-8", "a card title longer than a task's"),
        ("导出格式", "好", vec![no_short], "invalid_input: routes[0].shortName is required", "a card without a short name"),
        ("导出格式", "好", vec![both], "invalid_input: routes[0]. a card route gives executor", "executor and agentId"),
        ("导出格式", "好", vec![], "invalid_input: routes has 1 to 6 routes", "no route"),
    ] {
        let error = lab.route("desk", n, title, note, routes).await.unwrap_err();
        assert!(error.to_string().starts_with(code), "{why}: {error}");
    }
    assert_eq!(lab.count("SELECT COUNT(*) FROM project_routes"), 0);
    assert_eq!(lab.count("SELECT COUNT(*) FROM project_request_notes"), 0);
    assert_eq!(lab.request(n)["title"], Value::Null);
    // 120 characters each (a card's title, 300 bytes, its task's limit), with
    // spaces at either end, is accepted as trimmed.
    let most = "长".repeat(MAX_LINE);
    let card_title = "长".repeat(100);
    let mut card = design(&card_title, &most);
    card["title"] = json!(format!("  {card_title} "));
    let answer = lab.route("desk", n, &format!(" {most}"), &most, vec![card]).await.unwrap();
    assert_eq!(answer["routes"][0]["state"], "done", "{answer}");
    assert_eq!(lab.request(n)["title"], most);
}

// §4.2, §4.3: a card route is the front desk's own task_create and
// task_dispatch from the user's template, then a status card the front desk
// owns, bound to the task, keyed by its key in lowercase. The task's
// description is Core's head, a blank line, the user's words byte for byte,
// then why; the card names who it went to and why, never the words, and
// its handoffs name the request. The request has its title, note, card and
// progress; nothing but the front desk's dispatch reached anyone.
#[tokio::test]
async fn a_card_route_creates_the_task_dispatches_its_executor_and_puts_its_card() {
    let lab = lab();
    let words = "  设置页重新排版，文案改口语 😀\r\n第二行  ";
    let n = lab.say(words, "m1").await;
    let answer = lab.route("desk", n, "设置页排版", "好，交给设计。", vec![design("设置页排版", "先出两版布局")]).await.unwrap();
    let route = &answer["routes"][0];
    assert_eq!((route["kind"].clone(), route["state"].clone(), route["by"]["agentId"].clone()), (json!("card"), json!("done"), json!("desk")), "{answer}");
    let key = route["task"].as_str().unwrap().to_owned();
    let executor = route["to"]["agentId"].as_str().unwrap().to_owned();
    // The task, the front desk's.
    let task = lab.task(&key);
    assert_eq!((task["createdBy"]["id"].clone(), task["title"].clone(), task["shortName"].clone()), (json!("desk"), json!("设置页排版"), json!("设计稿")));
    let head = "Request R-1 from the user to the project Code, routed to this task's card by the front desk Desk. \
                The user's words, exactly as written:";
    assert_eq!(task["description"], format!("{head}\n\n{words}\n\nWhy, in the front desk's words (not the user's): 先出两版布局"));
    // Its executor, from the design template, dispatched by the front desk.
    let db = lab.ws.store.db.read().unwrap();
    let (actor, template): (String, String) = db.query_row("SELECT actor,template_id FROM executor_dispatches WHERE agent_id=?1", [&executor], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((actor.as_str(), template.as_str()), ("agent:desk", "design"));
    assert_eq!(crate::agent_roles::kind(&db, &executor).unwrap(), crate::agent_roles::EXECUTOR);
    drop(db);
    assert_eq!(task["assignee"]["id"], executor);
    // Its card.
    let card = lab.section(&key.to_lowercase()).await.expect("the card is live");
    assert_eq!((card["kind"].clone(), card["owner"]["agentId"].clone(), card["title"].clone()), (json!("status"), json!("desk"), json!("设置页排版")));
    assert_eq!(card["card"]["task"]["id"], key);
    assert_eq!(card["card"]["responsible"]["agentId"], executor);
    let name = card["card"]["responsible"]["name"].as_str().unwrap().to_owned();
    assert_eq!(card["body"]["elements"]["lead"]["props"]["text"], format!("→ {name}: 先出两版布局"));
    assert_eq!(card["body"]["elements"]["task"]["props"]["items"], json!([{"kind":"task","id":key}]));
    let handoffs = &card["card"]["handoffs"];
    assert_eq!(handoffs["requests"].as_array().unwrap().len(), 1);
    let from = &handoffs["requests"][0];
    assert_eq!((from["n"].clone(), from["title"].clone(), from["merged"].clone(), from["messageId"].clone()), (json!(1), json!("设置页排版"), json!(false), json!("m1")));
    assert_eq!(handoffs["events"][0]["kind"], "card");
    assert!(!card.to_string().contains("文案改口语"), "the user's words are not on the card: {card}");
    // The request.
    let request = lab.request(n);
    assert_eq!((request["title"].clone(), request["notes"][0]["note"].clone(), request["state"].clone()), (json!("设置页排版"), json!("好，交给设计。"), json!("doing")));
    assert_eq!(request["progress"], json!({"cards":1,"ended":0}));
    assert_eq!((request["cards"][0]["task"]["id"].clone(), request["cards"][0]["key"].clone()), (json!(key), json!(key.to_lowercase())));
    assert_eq!(request["cards"][0]["responsible"]["agentId"], executor);
    assert!(request["cards"][0]["sectionId"].is_i64());
    assert_eq!(request["cards"][0]["sectionId"], request["routes"][0]["sectionId"]);
    // Only the front desk's dispatch: no message from Home to the executor or anyone else.
    assert_eq!((lab.sent(&executor), lab.sent("lead"), lab.sent("member")), (0, 0, 0));
    let mail = lab.mail(&executor);
    assert_eq!(mail.len(), 1, "{mail:?}");
    assert_eq!(mail[0]["sender"]["id"], "desk");
}

// §4.2: each route is done once per (request, index). The same call again
// does nothing twice and sends nothing; a new title is kept, a new note is
// one more note; a different route at a recorded index refuses the call.
#[tokio::test]
async fn routing_again_does_nothing_twice_and_changes_only_the_title() {
    let lab = lab();
    let n = lab.say("比较三种导出格式", "m1").await;
    let routes = vec![design("导出格式比较", "有终点的调研"), to_agent("导出代码", "lead", "开发协调")];
    let first = lab.route("desk", n, "导出格式", "好，拆成两件。", routes.clone()).await.unwrap();
    let (tasks, mail, sent) = (lab.count("SELECT COUNT(*) FROM collaboration_tasks"), lab.count("SELECT COUNT(*) FROM collaboration_messages"),
        lab.count("SELECT COUNT(*) FROM agent_receipts"));
    let executors = lab.count("SELECT COUNT(*) FROM agent_roles WHERE kind='executor'");
    let again = lab.route("desk", n, "导出格式比较和实现", "好，拆成两件。", routes.clone()).await.unwrap();
    assert_eq!(again["routes"], first["routes"], "the same routes, as they were");
    assert_eq!(lab.count("SELECT COUNT(*) FROM collaboration_tasks"), tasks);
    assert_eq!(lab.count("SELECT COUNT(*) FROM collaboration_messages"), mail, "no mail");
    assert_eq!(lab.count("SELECT COUNT(*) FROM agent_receipts"), sent, "no message");
    assert_eq!(lab.count("SELECT COUNT(*) FROM agent_roles WHERE kind='executor'"), executors);
    let request = lab.request(n);
    assert_eq!(request["title"], "导出格式比较和实现");
    assert_eq!(request["notes"].as_array().unwrap().len(), 1, "the same note is not another");
    lab.route("desk", n, "导出格式比较和实现", "补一句：先比较。", routes.clone()).await.unwrap();
    assert_eq!(lab.request(n)["notes"].as_array().unwrap().len(), 2);
    assert_eq!(lab.count("SELECT COUNT(*) FROM collaboration_messages"), mail, "a note sends nothing");
    // Another route where one is recorded: nothing changes.
    let other = lab.route("desk", n, "别的标题", "改一下", vec![design("另一件事", "换个模板")]).await.unwrap_err();
    assert!(other.to_string().starts_with("route_conflict: routes[0]"), "{other}");
    assert_eq!(lab.request(n)["title"], "导出格式比较和实现");
    assert_eq!(lab.count("SELECT COUNT(*) FROM collaboration_tasks"), tasks);
    // A new route after the recorded ones is done.
    let more = [routes.clone(), vec![to_agent("导出文档", "member", "写文档")]].concat();
    let answer = lab.route("desk", n, "导出格式比较和实现", "补一句：先比较。", more).await.unwrap();
    assert_eq!(answer["routes"].as_array().unwrap().len(), 3);
    assert_eq!(answer["routes"][2]["state"], "done", "{answer}");
    assert_eq!(lab.count("SELECT COUNT(*) FROM collaboration_tasks"), tasks + 1);
}

// §4.2, §4.3: card + agentId gives a new card to a member already here, by
// the front desk's dispatch to it (its words in the task's description); to
// the front desk itself, only the task, assigned to it, with nothing sent.
// Not to an executor or an Agent outside the Project.
#[tokio::test]
async fn a_card_for_an_agent_here_is_dispatched_to_it_and_one_for_the_front_desk_sends_nothing() {
    let lab = lab();
    let n = lab.say("合并 #900 以后发 core.33", "m1").await;
    let answer = lab.route("desk", n, "发布 core.33", "好。", vec![to_agent("发布 core.33", "lead", "发布归常驻负责人"),
        to_agent("核对发布说明", "desk", "我自己核对，兼任开发协调")]).await.unwrap();
    let (lead_task, own_task) = (answer["routes"][0]["task"].as_str().unwrap().to_owned(), answer["routes"][1]["task"].as_str().unwrap().to_owned());
    assert_eq!(lab.task(&lead_task)["assignee"]["id"], "lead");
    let mail = lab.mail("lead");
    assert_eq!((mail.len(), mail[0]["sender"]["id"].clone()), (1, json!("desk")), "the dispatch, from the front desk");
    assert!(mail[0]["dispatchId"].is_string());
    assert_eq!(lab.sent("lead"), 0, "its words are in its task, no message from Home");
    let own = lab.task(&own_task);
    assert_eq!((own["assignee"]["id"].clone(), own["status"].clone(), own["dispatch"].clone()), (json!("desk"), json!("doing"), Value::Null));
    assert!(lab.mail("desk").is_empty() && lab.sent("desk") == 1, "only the request itself reached the front desk");
    assert_eq!(lab.section(&own_task.to_lowercase()).await.unwrap()["card"]["responsible"]["agentId"], "desk");
    // An executor, or an Agent of no Project: refused before anything is made.
    let executor = lab.route("desk", n, "发布 core.33", "好。", vec![to_agent("发布 core.33", "lead", "发布归常驻负责人"),
        to_agent("核对发布说明", "desk", "我自己核对，兼任开发协调"), design("设计", "要设计")]).await.unwrap()["routes"][2]["to"]["agentId"]
        .as_str().unwrap().to_owned();
    lab.ws.store.insert(&agent("outsider", "Outsider")).unwrap();
    let tasks = lab.count("SELECT COUNT(*) FROM collaboration_tasks");
    for (index, (target, code)) in [(executor.as_str(), "not_member"), ("outsider", "not_member")].into_iter().enumerate() {
        let n = lab.say(&format!("另一件 {index}"), &format!("x{index}")).await;
        let answer = lab.route("desk", n, "另一件", "好。", vec![to_agent("另一件", target, "试试")]).await.unwrap();
        assert_eq!(answer["routes"][0]["state"], "failed");
        assert!(answer["routes"][0]["error"].as_str().unwrap().starts_with(code), "{answer}");
    }
    assert_eq!(lab.count("SELECT COUNT(*) FROM collaboration_tasks"), tasks, "no task made");
}

// §4.2, §4.3, Dev Lead 2 seq 12103: an existing route sends the user's words
// to who answers for the card now, as a message from Home that holds only
// Core's head and the words (their blocks moved past the head), never an
// Agent's text: the front desk's why goes by its own mail. The card's
// handoffs name both requests, the joined one as merged, without words.
#[tokio::test]
async fn a_join_sends_the_words_to_who_answers_for_the_card_and_why_by_the_front_desks_mail() {
    let lab = lab();
    let first = lab.say("导出要 CSV", "m1").await;
    let made = lab.route("desk", first, "导出功能", "好。", vec![to_agent("导出功能", "lead", "开发协调")]).await.unwrap();
    let key = made["routes"][0]["task"].as_str().unwrap().to_owned();
    let card = key.to_lowercase();
    let text = " 还要 JSON 😀\nPASTED\r\nTWO ";
    let start = " 还要 JSON 😀\n".encode_utf16().count();
    let blocks = vec![TextBlock { id: "p1".into(), start, end: start + "PASTED\r\nTWO".encode_utf16().count() }];
    let second = lab.say_words(Words { text_blocks: Some(blocks.clone()), ..lab.words(text, "m2") }).await;
    let answer = lab.route("desk", second, "导出 JSON", "这是同一件事，并进导出卡。", vec![join(&card, "和导出 CSV 是同一件事的补充")]).await.unwrap();
    let route = &answer["routes"][0];
    assert_eq!((route["kind"].clone(), route["state"].clone(), route["to"]["agentId"].clone(), route["cardKey"].clone()),
        (json!("existing"), json!("done"), json!("lead"), json!(card)), "{answer}");
    let client = format!("route-{}", lab.route_id(second, 0));
    let sent = lab.receipt("lead", &client).expect("the words reached the card's responsible Agent");
    let head = format!("Request R-2 from the user to the project Code (Workspace {}, Project {}), routed by the front desk Desk to task {key}, \
        whose card you answer for; the user's words travel as they are:", lab.workspace, lab.project);
    assert_eq!(sent.input.text, format!("{head}\n\n{text}"), "Core's head and the words, byte for byte");
    for agents_text in ["和导出 CSV 是同一件事的补充", "导出 JSON", "这是同一件事", &card] {
        assert!(!head.contains(agents_text), "no Agent's text in the user's message: {agents_text}");
    }
    let moved = &sent.input.text_blocks.as_ref().unwrap()[0];
    assert_eq!(utf16(&sent.input.text, moved.start, moved.end), "PASTED\r\nTWO");
    assert_eq!(sent.origin, Some(json!({"kind":"project_request","projectId":lab.project,"requestId":lab.request(second)["id"],"request":2,"route":0,
        "workspaceId":lab.workspace})));
    let why = lab.mail("lead").into_iter().filter(|m| m["sender"]["id"] == "desk" && m["dispatchId"].is_null()).collect::<Vec<_>>();
    assert_eq!(why.len(), 1, "why, by the front desk's mail");
    assert!(why[0]["body"].as_str().unwrap().ends_with("Why, in the front desk's words: 和导出 CSV 是同一件事的补充"), "{}", why[0]);
    // The card's handoffs and the request.
    let shown = lab.section(&card).await.unwrap();
    let requests = &shown["card"]["handoffs"]["requests"];
    assert_eq!(requests.as_array().unwrap().iter().map(|r| (r["n"].clone(), r["merged"].clone())).collect::<Vec<_>>(),
        [(json!(1), json!(false)), (json!(2), json!(true))]);
    assert!(!shown.to_string().contains("还要 JSON"), "no words on the card");
    let request = lab.request(second);
    assert_eq!((request["cards"][0]["task"]["id"].clone(), request["state"].clone()), (json!(key), json!("doing")));
    // Again: nothing more is sent.
    lab.route("desk", second, "导出 JSON", "这是同一件事，并进导出卡。", vec![join(&card, "和导出 CSV 是同一件事的补充")]).await.unwrap();
    assert_eq!(lab.sent("lead"), 1);
    // A card the front desk answers for: nothing is sent; one with no task, or none: failed.
    let own = lab.route("desk", first, "导出功能", "好。", vec![to_agent("导出功能", "lead", "开发协调"),
        to_agent("导出说明", "desk", "我来写")]).await.unwrap()["routes"][1]["task"].as_str().unwrap().to_lowercase();
    let third = lab.say("说明里加上 JSON", "m3").await;
    let answer = lab.route("desk", third, "导出说明", "好。", vec![join(&own, "同一件事"), join("nothing-here", "试试")]).await.unwrap();
    assert_eq!(answer["routes"][0]["state"], "done");
    assert_eq!(lab.sent("desk"), 3, "only its three requests");
    assert!(answer["routes"][1]["error"].as_str().unwrap().starts_with("not_a_card"), "{answer}");
}

// R1 5e385a9d: a card whose executor still waits for its slot takes no
// message from Home before it starts, so a join hands it the request in one
// mail from the front desk, which it reads once it starts: Core's head, the
// user's words byte for byte, then why; nothing is sent as the user's. When
// that is more than a mail holds, the join is refused, retryable once the
// executor has started, before the route records the card.
#[tokio::test]
async fn a_join_to_a_card_whose_executor_waits_for_its_slot_goes_by_the_front_desks_mail() {
    let lab = lab();
    let first = lab.say("设置页重新排版", "m1").await;
    let made = lab.route("desk", first, "设置页排版", "好。", vec![design("设置页排版", "要设计")]).await.unwrap();
    let (key, executor) = (made["routes"][0]["task"].as_str().unwrap().to_owned(), made["routes"][0]["to"]["agentId"].as_str().unwrap().to_owned());
    let slot: String = lab.ws.store.db.read().unwrap().query_row("SELECT state FROM executor_slots WHERE agent_id=?1", [&executor], |r| r.get(0)).unwrap();
    assert_eq!(slot, "waiting", "it has not started");
    let words = " 文案也改口语 😀\r\n第二行 ";
    let second = lab.say(words, "m2").await;
    let answer = lab.route("desk", second, "文案口语", "并进设计卡。", vec![join(&key.to_lowercase(), "同一张设置页")]).await.unwrap();
    assert_eq!((answer["routes"][0]["state"].clone(), answer["routes"][0]["to"]["agentId"].clone()), (json!("done"), json!(executor)), "{answer}");
    assert_eq!(lab.sent(&executor), 0, "no message from Home");
    let mail: Vec<_> = lab.mail(&executor).into_iter().filter(|m| m["dispatchId"].is_null()).collect();
    assert_eq!((mail.len(), mail[0]["sender"]["id"].clone()), (1, json!("desk")), "{mail:?}");
    let head = format!("Request R-2 from the user to the project Code (Workspace {}, Project {}), routed by the front desk Desk to task {key}, \
        whose card you answer for. You had not started yet, so it comes by the front desk's mail; the user's words, exactly as written:",
        lab.workspace, lab.project);
    assert_eq!(mail[0]["body"], format!("{head}\n\n{words}\n\nWhy, in the front desk's words (not the user's): 同一张设置页"));
    assert_eq!(lab.request(second)["cards"][0]["task"]["id"], key);
    // More than a mail holds: refused, nothing recorded on the card.
    let third = lab.say(&"长".repeat(crate::collaboration_store::MAX_MAIL_BODY / 3), "m3").await;
    let refused = lab.route("desk", third, "很长的补充", "等它开始。", vec![join(&key.to_lowercase(), "同一张设置页")]).await.unwrap();
    assert_eq!(refused["routes"][0]["state"], "failed");
    assert!(refused["routes"][0]["error"].as_str().unwrap().starts_with("executor_queued"), "{refused}");
    assert_eq!((refused["routes"][0]["task"].clone(), refused["routes"][0]["cardKey"].clone()), (Value::Null, Value::Null));
    assert_eq!(lab.mail(&executor).into_iter().filter(|m| m["dispatchId"].is_null()).count(), 1, "nothing more sent");
}

// Dev Lead 2 seq 12103: a new executor's task must hold the words whole:
// Core's head, a blank line and the words, within a task description's
// limit less the room for the longest why. At the limit the route is done;
// a byte more and it is refused, nothing made. A card for an Agent here
// takes words of any length: they go to it as a message from Home.
#[tokio::test]
async fn a_new_executors_task_holds_the_words_up_to_the_limit_and_one_byte_more_is_refused() {
    let lab = lab();
    let head = "Request R-1 from the user to the project Code, routed to this task's card by the front desk Desk. \
                The user's words, exactly as written:";
    let room = MAX_DESCRIPTION - WHY_ROOM - head.len() - 2;
    let at_limit = "长".repeat(room / 3) + &"a".repeat(room % 3);
    assert_eq!(at_limit.len(), room);
    let n = lab.say(&at_limit, "m1").await;
    let why = "长".repeat(MAX_LINE);
    let done = lab.route("desk", n, "长需求", "好。", vec![design("长需求", &why)]).await.unwrap();
    assert_eq!(done["routes"][0]["state"], "done", "{done}");
    let description = lab.task(done["routes"][0]["task"].as_str().unwrap())["description"].as_str().unwrap().to_owned();
    assert!(description.len() <= MAX_DESCRIPTION, "with the longest why it fits");
    assert!(description.contains(&format!("\n\n{at_limit}\n\n")));
    let tasks = lab.count("SELECT COUNT(*) FROM collaboration_tasks");
    let over = lab.say(&(at_limit.clone() + "a"), "m2").await;
    assert_eq!(over.to_string().len(), 1, "R-2's head is as long as R-1's");
    let refused = lab.route("desk", over, "长需求", "好。", vec![design("长需求", "要设计")]).await.unwrap();
    assert_eq!(refused["routes"][0]["state"], "failed");
    assert!(refused["routes"][0]["error"].as_str().unwrap().starts_with("words_too_long_for_task"), "{refused}");
    assert_eq!(lab.count("SELECT COUNT(*) FROM collaboration_tasks"), tasks, "nothing made");
    // To an Agent here: its task says where the words went, and they went whole.
    let given = lab.route("desk", over, "长需求", "好。", vec![design("长需求", "要设计"), to_agent("长需求", "lead", "交给开发协调")]).await.unwrap();
    let key = given["routes"][1]["task"].as_str().unwrap().to_owned();
    let description = lab.task(&key)["description"].as_str().unwrap().to_owned();
    assert!(description.contains(&format!("The user's words are {} bytes, more than a task description holds", room + 1)), "{description}");
    assert!(!description.contains(&at_limit));
    let sent = lab.receipt("lead", &format!("route-{}", lab.route_id(over, 1))).expect("the words, as a message from Home");
    assert!(sent.input.text.ends_with(&format!("\n\n{at_limit}a")));
    assert!(sent.input.text.len() <= MAX_MESSAGE_TEXT);
}

// §4.2: the head of the words' message to a card's Agent fits beside the
// longest words in one message, at the longest a head has: a Project and a
// front desk named in 100 bytes each (projects.rs, workspace.rs), IDs
// longer than Core's and a long task key. And words_fit counts Core's
// head, the blank line and the words, to the byte.
#[test]
fn the_longest_hand_off_head_fits_and_words_fit_counts_the_head_and_the_blank_line() {
    let ctx = |text: &str| Ctx {
        workspace: "w".repeat(64), project: "p".repeat(64), name: "😀".repeat(25), front: "😀".repeat(25),
        request: Request { n: i64::MAX, ..kept_request(text) }, todo: vec![], given: 0,
    };
    let words = "长".repeat(MAX_REPLY / 3) + &"a".repeat(MAX_REPLY % 3);
    let head = hand_off_head(&ctx(&words), &format!("{}-{}", "K".repeat(16), i64::MAX));
    let sent = message("m", &head, &words, None, None);
    assert!(sent.text.len() <= MAX_MESSAGE_TEXT, "{} bytes", sent.text.len());
    let room = MAX_DESCRIPTION - WHY_ROOM - description_head(&ctx("")).len() - 2;
    assert!(words_fit(&ctx(&"a".repeat(room))));
    assert!(!words_fit(&ctx(&"a".repeat(room + 1))));
    let (text, whole) = description(&ctx(&"a".repeat(room)), &"长".repeat(MAX_LINE));
    assert!(whole && text.len() <= MAX_DESCRIPTION, "{} bytes", text.len());
}

// §4.2: one route failing undoes none of the others, and the same call
// again goes on where it stopped: here a card whose key another lead's
// section takes. Its task and executor stay; once the key is free, the
// retry puts the card without a second task or executor.
#[tokio::test]
async fn a_failed_route_undoes_nothing_and_its_retry_goes_on_where_it_stopped() {
    let lab = lab();
    let n = lab.say("两件事", "m1").await;
    let first = lab.route("desk", n, "两件事", "好。", vec![design("第一件", "要设计")]).await.unwrap();
    let key = first["routes"][0]["task"].as_str().unwrap().to_owned();
    let (prefix, number) = key.rsplit_once('-').unwrap();
    let next = format!("{prefix}-{}", number.parse::<i64>().unwrap() + 1).to_lowercase();
    let body = json!({"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["t"]},"t":{"type":"Markdown","props":{"text":"占位"}}}});
    lab.brief("lead", json!({"op":"put","key":next,"kind":"report","title":"占位","body":body})).await;
    let routes = vec![design("第一件", "要设计"), design("第二件", "也要设计"), join("nothing-here", "试试")];
    let answer = lab.route("desk", n, "两件事", "好。", routes.clone()).await.unwrap();
    let states: Vec<_> = answer["routes"].as_array().unwrap().iter().map(|r| r["state"].clone()).collect();
    assert_eq!(states, [json!("done"), json!("failed"), json!("failed")], "{answer}");
    assert!(answer["routes"][1]["error"].as_str().unwrap().starts_with("card_key_taken"), "{answer}");
    assert_eq!(answer["routes"][1]["task"].as_str().unwrap().to_lowercase(), next, "its task stays");
    let executor = answer["routes"][1]["to"]["agentId"].as_str().unwrap().to_owned();
    let (tasks, executors) = (lab.count("SELECT COUNT(*) FROM collaboration_tasks"), lab.count("SELECT COUNT(*) FROM agent_roles WHERE kind='executor'"));
    assert!(lab.section(&key.to_lowercase()).await.is_some(), "the first card stays");
    lab.brief("lead", json!({"op":"remove","key":next})).await;
    let again = lab.route("desk", n, "两件事", "好。", routes).await.unwrap();
    assert_eq!(again["routes"][1]["state"], "done", "{again}");
    assert_eq!(again["routes"][1]["to"]["agentId"], executor);
    assert_eq!((lab.count("SELECT COUNT(*) FROM collaboration_tasks"), lab.count("SELECT COUNT(*) FROM agent_roles WHERE kind='executor'")), (tasks, executors));
    let card = lab.section(&next).await.unwrap();
    assert_eq!((card["owner"]["agentId"].clone(), card["card"]["responsible"]["agentId"].clone()), (json!("desk"), json!(executor)));
}

// §4.4: a follow-up goes to the front desk until its request is routed,
// then to each open Agent answering for one of its cards, each once, not to
// an executor still waiting for its slot; with none of those, to the front
// desk. The words go as they were written.
#[tokio::test]
async fn a_follow_up_goes_to_who_answers_for_the_requests_cards() {
    let lab = lab();
    let n = lab.say("导出要 CSV", "m1").await;
    let before = follow_up(&lab.ws, &lab.project, n, lab.words("还要 JSON", "f1")).await.unwrap();
    assert_eq!(before["reply"]["deliveredTo"].as_array().unwrap().iter().map(|d| d["agentId"].clone()).collect::<Vec<_>>(), [json!("desk")]);
    lab.route("desk", n, "导出", "好。", vec![to_agent("导出代码", "lead", "开发协调"), to_agent("导出文档", "member", "写文档"),
        to_agent("导出测试", "lead", "也归开发协调"), design("导出格式", "比较格式")]).await.unwrap();
    let text = " 再加 XML \n";
    let after = follow_up(&lab.ws, &lab.project, n, lab.words(text, "f2")).await.unwrap();
    let to: Vec<_> = after["reply"]["deliveredTo"].as_array().unwrap().iter().map(|d| d["agentId"].clone()).collect();
    assert_eq!(to, [json!("lead"), json!("member")], "each once, not the waiting executor");
    for agent in ["lead", "member"] {
        assert!(lab.receipt(agent, "f2").unwrap().input.text.ends_with(&format!("\n\n{text}")));
    }
    assert!(lab.receipt("desk", "f2").is_none());
    // Its cards' Agents closed: the front desk.
    for agent in ["lead", "member"] {
        lab.ws.store.update(agent, "test/closed", &json!({}), |d| d.agent.closed_at = Some(crate::model::now())).unwrap();
    }
    let alone = follow_up(&lab.ws, &lab.project, n, lab.words("还有吗", "f3")).await.unwrap();
    assert_eq!(alone["reply"]["deliveredTo"][0]["agentId"], "desk");
}

// §4.5, §8: a request's progress is read from its cards' tasks only, and
// Core's lines from its cards' Asks and tasks only: one per Ask and one per
// ended task, the same on every read, on the first request a card came from.
#[tokio::test]
async fn progress_and_lines_come_from_the_cards_tasks_and_asks_once_each() {
    let lab = lab();
    let n = lab.say("导出", "m1").await;
    let made = lab.route("desk", n, "导出", "好。", vec![to_agent("导出代码", "lead", "开发协调"), design("导出格式", "比较")]).await.unwrap();
    let (code, format) = (made["routes"][0]["task"].as_str().unwrap().to_owned(), made["routes"][1]["task"].as_str().unwrap().to_owned());
    let second = lab.say("导出也要 JSON", "m2").await;
    lab.route("desk", second, "导出 JSON", "并进去。", vec![join(&code.to_lowercase(), "同一件事")]).await.unwrap();
    assert_eq!((lab.request(n)["progress"].clone(), lab.request(n)["lines"].clone()), (json!({"cards":2,"ended":0}), json!([])));
    // An Ask on the code card, then that task done.
    let body = json!({"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["t"]},"t":{"type":"Markdown","props":{"text":"两种做法"}}}});
    lab.brief("desk", json!({"op":"put","key":format!("{}/pick", code.to_lowercase()),"kind":"ask","title":"选一种","body":body,
        "ask":{"question":"选哪种？","reply":{"options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}}})).await;
    let request = lab.request(n);
    assert_eq!(request["lines"].as_array().unwrap().len(), 1);
    assert_eq!((request["lines"][0]["kind"].clone(), request["lines"][0]["state"].clone(), request["lines"][0]["task"].clone()),
        (json!("ask"), json!("open"), json!(code)));
    lab.end(&code, "done");
    for _ in 0..2 {
        let request = lab.request(n);
        let lines: Vec<_> = request["lines"].as_array().unwrap().iter().map(|l| (l["kind"].clone(), l["task"].clone())).collect();
        assert_eq!(lines, [(json!("ask"), json!(code)), (json!("done"), json!(code))], "each once");
        assert_eq!((request["progress"].clone(), request["state"].clone()), (json!({"cards":2,"ended":1}), json!("doing")));
        assert_eq!(lab.request(second)["lines"], json!([]), "on the first request only");
        assert_eq!((lab.request(second)["progress"].clone(), lab.request(second)["state"].clone()), (json!({"cards":1,"ended":1}), json!("done")));
    }
    lab.end(&format, "cancelled");
    let request = lab.request(n);
    assert_eq!((request["progress"].clone(), request["state"].clone()), (json!({"cards":2,"ended":2}), json!("done")));
    assert_eq!(request["lines"].as_array().unwrap().iter().filter(|l| l["kind"] == "done").count(), 2);
    assert_eq!(request["cards"][1]["task"]["status"], "cancelled");
}

/// The user's reassignment through the page's route.
async fn reassign_on_page(lab: &Lab, section: &Value, body: Value, credential: bool) -> (StatusCode, Value) {
    let app = super::super::router().with_state(lab.ws.clone());
    let mut request = HttpRequest::builder().method("POST").uri(format!("/api/projects/{}/cards/{section}/reassign", lab.project))
        .header("content-type", "application/json");
    if credential {
        request = request.header("authorization", "Bearer agent-token");
    }
    let answer = app.oneshot(request.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = answer.status();
    let bytes = axum::body::to_bytes(answer.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

// §4.2, Dev Lead 2 seq 12103: the user reassigns a card from the page only
// (an Agent's credential is refused): Core first dispatches its task, as
// the user, to the new responsible, then releases the earlier executor as
// the user, in the same request. A dispatch that fails releases nothing.
// The same clientRequestId again is the same reassignment.
#[tokio::test]
async fn a_reassignment_dispatches_the_new_responsible_then_the_user_releases_the_old() {
    let lab = lab();
    let n = lab.say("设置页排版", "m1").await;
    let made = lab.route("desk", n, "设置页排版", "好。", vec![design("设置页排版", "要设计")]).await.unwrap();
    let (old, section) = (made["routes"][0]["to"]["agentId"].as_str().unwrap().to_owned(), made["routes"][0]["sectionId"].clone());
    let body = |to: Value, id: &str| json!({"workspaceId":lab.workspace,"to":to,"why":"换个做法","clientRequestId":id});
    let (status, _) = reassign_on_page(&lab, &section, body(json!({"agentId":"lead"}), "r0"), true).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "an Agent's credential");
    assert_eq!(lab.count("SELECT COUNT(*) FROM project_routes WHERE kind='reassign'"), 0);
    // A dispatch that fails: nothing released.
    let (status, _) = reassign_on_page(&lab, &section, body(json!({"executor":{"templateId":"nope"}}), "r1"), false).await;
    assert_ne!(status, StatusCode::OK);
    assert_eq!(lab.released_by(&old), None, "not released");
    // To a new executor: dispatched by the user, then the old one released by the user.
    let (status, answer) = reassign_on_page(&lab, &section, body(json!({"executor":{"templateId":"design"}}), "r2"), false).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let new = answer["route"]["to"]["agentId"].as_str().unwrap().to_owned();
    assert_ne!(new, old);
    assert_eq!((answer["route"]["kind"].clone(), answer["route"]["by"].clone(), answer["route"]["from"]["agentId"].clone()),
        (json!("reassign"), Value::Null, json!(old)));
    assert_eq!((answer["released"]["agentId"].clone(), answer["released"]["note"].clone()), (json!(old), json!(crate::project_requests::reassign::RELEASE_NOTE)));
    assert_eq!(lab.released_by(&old).as_deref(), Some("user"));
    let db = lab.ws.store.db.read().unwrap();
    let (actor, made_at): (String, String) = db.query_row("SELECT actor,created_at FROM executor_dispatches WHERE agent_id=?1", [&new], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    let released_at: String = db.query_row("SELECT archived_at FROM agent_roles WHERE agent_id=?1", [&old], |r| r.get(0)).unwrap();
    drop(db);
    assert_eq!(actor, "user");
    assert!(made_at <= released_at, "dispatched {made_at}, then released {released_at}");
    let key = made["routes"][0]["task"].as_str().unwrap().to_lowercase();
    let card = lab.section(&key).await.unwrap();
    assert_eq!(card["card"]["responsible"]["agentId"], new);
    let events: Vec<_> = card["card"]["handoffs"]["events"].as_array().unwrap().iter().map(|e| e["kind"].clone()).collect();
    assert_eq!(events, [json!("card"), json!("reassign")]);
    // Again: the same reassignment, nothing more.
    let executors = lab.count("SELECT COUNT(*) FROM agent_roles WHERE kind='executor'");
    let (_, again) = reassign_on_page(&lab, &section, body(json!({"executor":{"templateId":"design"}}), "r2"), false).await;
    assert_eq!(again["route"], answer["route"]);
    assert_eq!(lab.count("SELECT COUNT(*) FROM agent_roles WHERE kind='executor'"), executors);
    // To a member: the task is dispatched to it, and the executor released.
    let (status, answer) = reassign_on_page(&lab, &section, body(json!({"agentId":"lead"}), "r3"), false).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(lab.released_by(&new).as_deref(), Some("user"));
    assert_eq!(lab.section(&key).await.unwrap()["card"]["responsible"]["agentId"], "lead");
    assert!(lab.mail("lead").iter().any(|m| m["body"].as_str().unwrap_or_default().contains("Reassigned to you by the user")));
    // From a standing Agent: nothing to release.
    let (status, answer) = reassign_on_page(&lab, &section, body(json!({"agentId":"member"}), "r4"), false).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(answer["released"], Value::Null);
}
