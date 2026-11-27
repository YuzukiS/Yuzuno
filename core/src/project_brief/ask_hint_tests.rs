//! YN-237 ③: Core's advice on an ask its owner makes longer after the user
//! replied to it: what goes on now belongs in its Task's status, which Home
//! shows as its request's now. Advice only: the edit is accepted.
use super::*;

// YN-237 ③: an ask the user replied to that its owner then makes longer is advised, never refused: what goes on now
// belongs in its Task's status. Before a reply, or an edit that shortens it, says nothing.
#[tokio::test]
async fn an_ask_made_longer_after_its_reply_is_advised_and_accepted() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("q1", 0, vec![put("decide", "ask")])).await;
    let edit = |text: &str| json!({"op":"edit","key":"decide","elements":{"note":{"type":"Markdown","props":{"text":text}}}});
    let codes = |answer: &Value| answer["advice"].as_array().map(|all| all.iter().map(|a| a["code"].as_str().unwrap().to_owned()).collect::<Vec<_>>())
        .unwrap_or_default();
    let before = accept(&ws, "a", input("q2", version(&ws, &project), vec![edit("Hello, and more before any reply.")])).await;
    assert!(!codes(&before).contains(&"ask_grows_after_reply".to_owned()), "{before}");
    assert!(sections::mark_replied_live(&ws.store, &project, "decide", "Left").unwrap());
    let grown = accept(&ws, "a", input("q3", version(&ws, &project), vec![edit("Hello, and more before any reply. Now also: S2 merged, S3 going on.")])).await;
    let advice = grown["advice"].as_array().unwrap().iter().find(|a| a["code"] == "ask_grows_after_reply").expect("advised");
    assert_eq!(advice["path"], "changes[0].elements");
    assert_eq!(section(&brief(&ws, "a"), "decide")["ask"]["state"], "replied", "accepted, still replied");
    let shorter = accept(&ws, "a", input("q4", version(&ws, &project), vec![edit("Hello.")])).await;
    assert!(!codes(&shorter).contains(&"ask_grows_after_reply".to_owned()), "{shorter}");
}
