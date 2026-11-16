//! YN-184: a request is done only once the user confirms it. Its cards'
//! tasks all ended (or the front desk answered it) it waits for the user;
//! the user's page confirms it, and it is done until something changes
//! after: a follow-up, a new route or note, a card's task that ends again.
//! Only the user's page confirms (an Agent's credential is refused), and
//! only a request that waits for the user.
use super::*;

/// The user's confirmation through the page's route.
async fn confirm_on_page(lab: &Lab, n: i64, body: Value, credential: bool) -> (StatusCode, Value) {
    let app = crate::project_requests::router().with_state(lab.ws.clone());
    let mut request = HttpRequest::builder().method("POST").uri(format!("/api/projects/{}/requests/{n}/confirm", lab.project))
        .header("content-type", "application/json");
    if credential {
        request = request.header("authorization", "Bearer agent-token");
    }
    let answer = app.oneshot(request.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = answer.status();
    let bytes = axum::body::to_bytes(answer.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

impl Lab {
    /// The user confirms R-n on the page: its request as the answer shows it.
    async fn confirm(&self, n: i64) -> Value {
        let (status, answer) = confirm_on_page(self, n, json!({"workspaceId":self.workspace}), false).await;
        assert_eq!(status, StatusCode::OK, "{answer}");
        answer["request"].clone()
    }

    /// The user sets the task's status, each time a new write.
    fn set_status(&self, key: &str, status: &str, id: &str) {
        let version = self.task(key)["version"].clone();
        self.ws.store.collaboration_call(None, "task_update", json!({"requestId":id,"taskId":key,
            "expectedVersion":version,"patch":{"status":status}})).unwrap();
    }

    fn confirmed_at(&self, n: i64) -> Option<String> {
        self.ws.store.db.read().unwrap()
            .query_row("SELECT confirmed_at FROM project_requests WHERE project_id=?1 AND n=?2", params![self.project, n], |r| r.get(0))
            .unwrap()
    }
}

/// R-n routed to one card of Lead's: its task's key.
async fn one_card(lab: &Lab, n: i64) -> String {
    let made = lab.route("desk", n, "导出", "好。", vec![to_agent("导出代码", "lead", "开发协调")]).await.unwrap();
    made["routes"][0]["task"].as_str().unwrap().to_owned()
}

// Every card's task ended: the request waits for the user (ended), never
// done by itself. Confirmed on the page, it is done, with the time kept;
// again, nothing changes. An Agent's credential, or another Workspace's
// page, confirms nothing.
#[tokio::test]
async fn a_request_whose_cards_ended_is_done_only_once_the_user_confirms_it() {
    let lab = lab();
    let n = lab.say("导出 CSV", "m1").await;
    let code = one_card(&lab, n).await;
    lab.end(&code, "done");
    for _ in 0..2 {
        assert_eq!((lab.request(n)["state"].clone(), lab.request(n)["confirmedAt"].clone()), (json!("ended"), Value::Null));
    }
    let (status, _) = confirm_on_page(&lab, n, json!({"workspaceId":lab.workspace}), true).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "an Agent's credential");
    let (status, answer) = confirm_on_page(&lab, n, json!({"workspaceId":"another"}), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(answer["error"].as_str().unwrap().starts_with("workspace_changed"), "{answer}");
    assert_eq!((lab.confirmed_at(n), lab.request(n)["state"].clone()), (None, json!("ended")), "nothing confirmed");

    let done = lab.confirm(n).await;
    let at = lab.confirmed_at(n).unwrap();
    assert_eq!((done["state"].clone(), done["confirmedAt"].clone()), (json!("done"), json!(at)));
    assert_eq!(lab.request(n)["state"], "done");
    let again = lab.confirm(n).await;
    assert_eq!((again["state"].clone(), lab.confirmed_at(n)), (json!("done"), Some(at)), "the same confirmation");
}

// Only a request waiting for the user is confirmed: not one nothing was
// done for yet, nor one with a card going on. Nothing is kept.
#[tokio::test]
async fn confirming_is_refused_until_the_request_waits_for_the_user() {
    let lab = lab();
    let n = lab.say("导出 CSV", "m1").await;
    let body = json!({"workspaceId":lab.workspace});
    let (status, answer) = confirm_on_page(&lab, n, body.clone(), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(answer["error"].as_str().unwrap().starts_with("request_not_ready: R-1 has no card or answer yet"), "{answer}");
    one_card(&lab, n).await;
    let (status, answer) = confirm_on_page(&lab, n, body.clone(), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(answer["error"].as_str().unwrap().starts_with("request_not_ready: R-1 still has a card going on"), "{answer}");
    let (status, answer) = confirm_on_page(&lab, 9, body, false).await;
    assert!(status == StatusCode::BAD_REQUEST && answer["error"].as_str().unwrap().starts_with("request_not_found"), "{answer}");
    assert_eq!((lab.confirmed_at(n), lab.request(n)["state"].clone()), (None, json!("doing")));
}

// After the confirmation the user follows the request up: it waits for them
// again (its cards still ended). A card the front desk then adds is in
// progress, and once it ends the request waits for the user once more.
#[tokio::test]
async fn a_follow_up_or_a_new_card_after_the_confirmation_brings_the_request_back() {
    let lab = lab();
    let n = lab.say("导出 CSV", "m1").await;
    let first = to_agent("导出代码", "lead", "开发协调");
    let made = lab.route("desk", n, "导出", "好。", vec![first.clone()]).await.unwrap();
    let code = made["routes"][0]["task"].as_str().unwrap().to_owned();
    lab.end(&code, "done");
    assert_eq!(lab.confirm(n).await["state"], "done");

    follow_up(&lab.ws, &lab.project, n, lab.words("还要 JSON", "f1")).await.unwrap();
    assert_eq!(lab.request(n)["state"], "ended", "the user said more");
    let made = lab.route("desk", n, "导出", "再开一张。", vec![first, to_agent("导出 JSON", "member", "新的一件")]).await.unwrap();
    let json_task = made["routes"][1]["task"].as_str().unwrap().to_owned();
    assert_eq!((lab.request(n)["state"].clone(), lab.request(n)["progress"].clone()), (json!("doing"), json!({"cards":2,"ended":1})));
    lab.end(&json_task, "done");
    assert_eq!(lab.request(n)["state"], "ended", "its new card ended after the confirmation");
    assert_eq!(lab.confirm(n).await["state"], "done");
}

// A confirmed request's card opened again is in progress; once its task
// ends again the request waits for the user: the confirmation was of what
// they saw before.
#[tokio::test]
async fn a_card_opened_again_brings_a_confirmed_request_back() {
    let lab = lab();
    let n = lab.say("导出 CSV", "m1").await;
    let code = one_card(&lab, n).await;
    lab.end(&code, "done");
    lab.confirm(n).await;
    lab.set_status(&code, "doing", "reopen");
    assert_eq!(lab.request(n)["state"], "doing");
    lab.set_status(&code, "done", "done again");
    assert_eq!(lab.request(n)["state"], "ended");
    assert_eq!(lab.confirm(n).await["state"], "done");
}

// Two requests joined to one card: when its task ends, each waits for the
// user, and each is confirmed on its own.
#[tokio::test]
async fn requests_joined_to_one_card_are_each_confirmed() {
    let lab = lab();
    let first = lab.say("导出 CSV", "m1").await;
    let code = one_card(&lab, first).await;
    let second = lab.say("导出也要 JSON", "m2").await;
    lab.route("desk", second, "导出 JSON", "并进去。", vec![join(&code.to_lowercase(), "同一件事")]).await.unwrap();
    lab.end(&code, "done");
    assert_eq!((lab.request(first)["state"].clone(), lab.request(second)["state"].clone()), (json!("ended"), json!("ended")));
    lab.confirm(first).await;
    assert_eq!((lab.request(first)["state"].clone(), lab.request(second)["state"].clone()), (json!("done"), json!("ended")));
    lab.confirm(second).await;
    assert_eq!(lab.request(second)["state"], "done");
}

// An answer waits for the user too (answered). Confirmed, it is done; a
// follow-up reopens it for the front desk, and the front desk's new answer
// waits for the user again.
#[tokio::test]
async fn an_answered_request_waits_for_the_users_confirmation_too() {
    let lab = lab();
    let n = lab.say("README 做完了吗", "m1").await;
    lab.route("desk", n, "README 进度", "做完了。", vec![answer("只问进度")]).await.unwrap();
    assert_eq!(lab.request(n)["state"], "answered");
    assert_eq!(lab.confirm(n).await["state"], "done");
    follow_up(&lab.ws, &lab.project, n, lab.words("英文版呢？", "f1")).await.unwrap();
    assert_eq!(lab.request(n)["state"], "waiting");
    lab.route("desk", n, "README 进度", "英文版也做完了。", vec![answer("只问进度")]).await.unwrap();
    assert_eq!(lab.request(n)["state"], "answered", "a new answer, after the confirmation");
    assert_eq!(lab.confirm(n).await["state"], "done");
}

// A request settled before this Core first asked for confirmations stays
// done as the rule then made it, with no confirmation in the user's name;
// anything after brings it back to the user.
#[tokio::test]
async fn a_request_settled_before_confirmations_began_stays_done() {
    let lab = lab();
    let n = lab.say("导出 CSV", "m1").await;
    let code = one_card(&lab, n).await;
    lab.end(&code, "done");
    lab.ws.store.db.write().unwrap()
        .execute("UPDATE workspace_meta SET value=?2 WHERE key=?1", params![crate::project_requests::progress::CONFIRM_FROM, crate::model::now()]).unwrap();
    let request = lab.request(n);
    assert_eq!((request["state"].clone(), request["confirmedAt"].clone(), lab.confirmed_at(n)), (json!("done"), Value::Null, None));
    follow_up(&lab.ws, &lab.project, n, lab.words("还有一点", "f1")).await.unwrap();
    assert_eq!(lab.request(n)["state"], "ended");
}
