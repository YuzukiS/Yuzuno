//! A small, evidence-based projection for the Agent rail. No observer, model
//! call, cached summary, or persisted second source of truth is involved.
use crate::model::{AgentDetail, PendingRequest, WorkSummary};
use serde_json::Value;

pub fn compact(text: &str) -> String {
    // Collapse layout and cap by Unicode scalars, never by byte offsets.
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let line = line.trim_start_matches(['#', '*', '>', '`', ' ']);
    let mut chars = line.chars();
    let mut result: String = chars.by_ref().take(100).collect();
    if chars.next().is_some() { result.push('…'); }
    result
}

fn summary(text: &str, kind: &str, source: &str, turn: Option<&Value>, item: Option<&Value>) -> Option<WorkSummary> {
    let text = compact(text);
    if text.is_empty() { return None; }
    Some(WorkSummary {
        text, kind: kind.into(), source: source.into(),
        turn_id: turn.and_then(|v| v["id"].as_str()).map(str::to_owned),
        item_id: item.and_then(|v| v["id"].as_str()).map(str::to_owned),
        request_id: None, request_parts: None,
    })
}

pub fn task(turn: &Value) -> Option<WorkSummary> {
    let item = turn["items"].as_array()?.iter().find(|i| i["type"] == "userMessage")?;
    let text = item["_yuzunoInputText"].as_str().map(str::to_owned)
        .unwrap_or_else(|| crate::message_content::text(item));
    let mut result = summary(&text, "task", "user", Some(turn), Some(item))?;
    result.request_parts = crate::message_content::summary_parts(item);
    Some(result)
}

fn pending(p: &PendingRequest) -> WorkSummary {
    let params = &p.params;
    let question = params["questions"].as_array()
        .or_else(|| params["input"]["questions"].as_array())
        .and_then(|q| q.first()).and_then(|q| q["question"].as_str());
    let action = params["command"].as_str()
        .or_else(|| params["input"]["command"].as_str())
        .or_else(|| params["input"]["file_path"].as_str())
        .or_else(|| params["reason"].as_str())
        .or_else(|| params["toolName"].as_str());
    let text = if let Some(question) = question {
        format!("等待回答：{question}")
    } else if let Some(action) = action {
        format!("等待批准：{action}")
    } else if p.method.contains("fileChange") {
        "等待批准：文件修改".into()
    } else { "等待你的回应".into() };
    WorkSummary { text: compact(&text), kind: "pending".into(), source: "runtime".into(),
        turn_id: params["turnId"].as_str().map(str::to_owned),
        item_id: params["itemId"].as_str().or_else(|| params["toolUseId"].as_str()).map(str::to_owned),
        request_id: Some(p.id.clone()), request_parts: None,
    }
}

pub fn project(d: &AgentDetail) -> Option<WorkSummary> {
    // Only an actual, current unanswered request is actionable. Unread count,
    // waiting status, or historical approval text cannot manufacture one.
    if let Some(p) = d.pending.iter().find(|p| !p.stale && p.params["_responseSent"] != true) {
        return Some(pending(p));
    }
    let turn = d.turns.last();
    if let Some(error) = &d.agent.error {
        return summary(error, "error", "runtime", turn, None);
    }
    if d.agent.status == "uncertain" {
        return summary("执行状态尚未确认", "error", "runtime", turn, None);
    }
    let turn = turn?;
    if d.agent.status == "offline" && turn["status"] == "inProgress" {
        return summary("连接已断开，执行结果尚未确认", "error", "runtime", Some(turn), None);
    }
    if turn["status"] == "failed" {
        return summary(turn["error"]["message"].as_str().unwrap_or("本轮执行失败"), "error", "runtime", Some(turn), None);
    }
    if turn["status"] == "interrupted" {
        let text = task(turn).map_or_else(|| "本轮已中断".into(), |t| format!("已中断：{}", t.text));
        return summary(&text, "interrupted", "runtime", Some(turn), None);
    }
    let items = turn["items"].as_array();
    if turn["status"] == "completed" {
        // Native assistant text remains attributed to the agent; a claim about
        // successful tests is not an independently verified runtime result.
        if let Some(item) = items.and_then(|items| items.iter().rev().find(|i|
            i["type"] == "agentMessage" && i["text"].as_str().is_some_and(|t| !t.trim().is_empty()))) {
            let kind = if item["phase"] == "commentary" { "progress" } else { "result" };
            return summary(item["text"].as_str().unwrap(), kind, "agent", Some(turn), Some(item));
        }
        return task(turn);
    }
    if let Some(step) = turn["_yuzunoPlan"].as_array().and_then(|plan| plan.iter().find(|s| s["status"] == "inProgress")) {
        if let Some(text) = step["step"].as_str() {
            let mut stage = summary(text, "progress", "agent", Some(turn), None)?;
            // This is a UI evidence anchor, never a fabricated native Item.
            // Turn renders this exact plan record in a dedicated details block.
            stage.item_id = turn["id"].as_str().map(|id| format!("yuzuno-plan-{id}"));
            return Some(stage);
        }
    }
    if let Some(item) = items.and_then(|items| items.iter().rev().find(|i|
        i["type"] == "agentMessage" && i["_yuzunoCompletedText"].as_str().is_some_and(|t| !t.trim().is_empty()))) {
        return summary(item["_yuzunoCompletedText"].as_str().unwrap(), "progress", "agent", Some(turn), Some(item));
    }
    task(turn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn detail() -> AgentDetail {
        serde_json::from_value(json!({"agent":{"id":"a","name":"A","goal":"old purpose must not appear","cwd":"/tmp","model":"","color":"sage","status":"working","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()
    }
    fn user_turn(id: &str, text: &str) -> Value { json!({"id":id,"status":"inProgress","items":[{"id":format!("{id}-user"),"type":"userMessage","content":[{"type":"text","text":text}]}]}) }
    #[test]
    fn empty_agent_has_no_invented_purpose() { assert!(project(&detail()).is_none()); }
    #[test]
    fn latest_task_never_reuses_previous_result() {
        let mut d = detail();
        d.turns = vec![json!({"id":"old","status":"completed","items":[{"id":"final","type":"agentMessage","text":"I verified all tests"}]}), user_turn("new", "调查其他问题")];
        let s = project(&d).unwrap();
        assert_eq!(s.text, "调查其他问题"); assert_eq!(s.kind, "task"); assert_eq!(s.source,"user"); assert_eq!(s.item_id.as_deref(),Some("new-user"));
    }
    #[test]
    fn input_text_paste_projects_a_bounded_user_summary() {
        let body = format!("👨‍👩‍👧‍👦e\u{301}中文123456{}", "\r\n  complete source".repeat(500));
        let mut d = detail();
        d.turns.push(json!({"id":"t","status":"inProgress","items":[{
            "id":"u","type":"userMessage","content":[{"type":"inputText","text":body}],
            "_yuzunoTextBlocks":[{"id":"paste","start":0,"end":body.encode_utf16().count()}]
        }]}));
        let s = project(&d).expect("inputText user task must reach the rail");
        assert_eq!(s.source, "user");
        assert_eq!(s.kind, "task");
        assert_eq!(s.turn_id.as_deref(), Some("t"));
        assert_eq!(s.item_id.as_deref(), Some("u"));
        assert_eq!(s.text, compact(&body));
        let parts = s.request_parts.unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["kind"], "paste");
        assert_eq!(parts[0]["id"], "paste");
        assert_eq!(parts[0]["label"], "👨‍👩‍👧‍👦e\u{301}中文123456");
        assert_eq!(parts[0]["end"], body.encode_utf16().count());
        assert_eq!(parts[0]["preview"].as_str().unwrap().chars().count(), 160);
        assert!(serde_json::to_string(&parts).unwrap().len() < 1000);
        assert!(!serde_json::to_string(&parts).unwrap().contains(&body));
    }
    #[test]
    fn mixed_user_text_and_original_override_preserve_agent_attribution() {
        let body = "pasted source\r\n".repeat(20);
        let raw = format!("before\n{body}\nafter");
        let mut d = detail();
        d.turns.push(json!({"id":"t","status":"inProgress","items":[{
            "id":"u","type":"userMessage","content":[
                {"type":"text","text":"before"},{"type":"image","url":"attachment"},
                {"type":"inputText","text":body},{"type":"text","text":"after"}
            ],"_yuzunoTextBlocks":[{"id":"paste","start":7,"end":7+body.encode_utf16().count()}]
        }]}));
        let s = project(&d).unwrap();
        assert_eq!(s.text, compact(&raw));
        let parts = s.request_parts.unwrap();
        assert_eq!(parts[0]["text"], "before\n");
        assert_eq!(parts[1]["id"], "paste");
        assert_eq!(parts[2]["text"], "\nafter");

        let original = "Original source\r\n".repeat(20);
        d.turns[0]["items"][0]["_yuzunoInputText"] = original.clone().into();
        d.turns[0]["items"][0]["_yuzunoTextBlocks"] = json!([{"id":"original","start":0,"end":original.encode_utf16().count()}]);
        let s = project(&d).unwrap();
        assert_eq!(s.text, compact(&original));
        assert_eq!(s.request_parts.unwrap()[0]["label"], "Original s");

        d.turns[0]["items"].as_array_mut().unwrap().push(json!({
            "id":"update","type":"agentMessage","_yuzunoCompletedText":original
        }));
        let s = project(&d).unwrap();
        assert_eq!(s.source, "agent");
        assert_eq!(s.kind, "progress");
        assert_eq!(s.item_id.as_deref(), Some("update"));
        assert!(s.request_parts.is_none());
    }
    #[test]
    fn completed_agent_claim_is_retained_after_read_and_attributed() {
        let mut d = detail(); d.agent.reviewed_seq=100; d.agent.unread_count=0;
        d.turns.push(json!({"id":"done","status":"completed","items":[{"id":"answer","type":"agentMessage","text":"所有测试通过"}]}));
        let s=project(&d).unwrap(); assert_eq!(s.kind,"result"); assert_eq!(s.source,"agent"); assert_eq!(s.item_id.as_deref(),Some("answer"));
    }
    #[test]
    fn completed_turn_does_not_relabel_explicit_commentary_as_delivery() {
        let mut d=detail(); d.turns.push(json!({"id":"t","status":"completed","items":[{"id":"c","type":"agentMessage","phase":"commentary","text":"I will investigate"}]}));
        assert_eq!(project(&d).unwrap().kind,"progress");
    }
    #[test]
    fn token_deltas_do_not_flicker_rail_and_tools_do_not_replace_stage() {
        let mut d=detail(); d.turns.push(user_turn("t","验证恢复"));
        d.apply("item/agentMessage/delta", &json!({"turnId":"t","itemId":"reply","delta":"I will"}));
        assert_eq!(project(&d).unwrap().text,"验证恢复");
        d.apply("item/completed", &json!({"turnId":"t","item":{"id":"reply","type":"agentMessage","text":"Checking native session recovery"}}));
        d.apply("item/started", &json!({"turnId":"t","item":{"id":"tool","type":"commandExecution","command":"cat a.rs"}}));
        assert_eq!(project(&d).unwrap().text,"Checking native session recovery");
        d.apply("item/agentMessage/delta", &json!({"turnId":"t","itemId":"reply2","delta":"Next"}));
        assert_eq!(project(&d).unwrap().text,"Checking native session recovery");
    }
    #[test]
    fn only_live_unanswered_pending_overrides_work() {
        let mut d=detail(); d.turns.push(user_turn("t","任务"));
        d.pending.push(serde_json::from_value(json!({"id":"p","agentId":"a","method":"claude/canUseTool","params":{"turnId":"t","toolUseId":"tool","toolName":"AskUserQuestion","input":{"questions":[{"question":"使用哪个目录？"}]}},"createdAt":"now"})).unwrap());
        let s=project(&d).unwrap(); assert_eq!(s.text,"等待回答：使用哪个目录？"); assert_eq!(s.request_id.as_deref(),Some("p"));
        d.pending[0].stale=true; assert_eq!(project(&d).unwrap().kind,"task");
        d.pending[0].stale=false; d.pending[0].params["_responseSent"]=true.into(); assert_eq!(project(&d).unwrap().kind,"task");
    }
    #[test]
    fn unknown_status_has_honest_runtime_attribution_and_turn_anchor() {
        let mut d=detail(); d.turns.push(user_turn("t","任务")); d.agent.status="uncertain".into();
        let s=project(&d).unwrap(); assert_eq!(s.source,"runtime"); assert_eq!(s.kind,"error"); assert_eq!(s.turn_id.as_deref(),Some("t")); assert!(!s.text.contains("完成"));
    }
    #[test]
    fn unicode_compaction_is_bounded_and_whitespace_collapsed() {
        let text="柚🦊".repeat(100); let c=compact(&text); assert_eq!(c.chars().count(),101); assert!(c.ends_with('…')); assert_eq!(compact("你好\n  世界"),"你好 世界");
    }
    #[test]
    fn native_active_plan_is_a_stage_not_a_tool_name() {
        let mut d=detail(); d.turns.push(user_turn("t","任务"));
        d.apply("turn/plan/updated", &json!({"turnId":"t","plan":[{"step":"验证中断与恢复","status":"inProgress"}]}));
        let s=project(&d).unwrap(); assert_eq!(s.text,"验证中断与恢复"); assert_eq!(s.kind,"progress"); assert_eq!(s.turn_id.as_deref(),Some("t"));
        assert_eq!(s.item_id.as_deref(),Some("yuzuno-plan-t"));
        assert!(d.turns[0]["items"].as_array().unwrap().iter().all(|item| item["id"] != "yuzuno-plan-t"), "plan evidence must not manufacture a native Item");
    }
}
