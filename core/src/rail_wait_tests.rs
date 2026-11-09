//! `turn_wait` (YN-51): what a running Turn is stopped on, read from each
//! harness's own records of its calls.
use super::*;
use serde_json::json;

fn detail(turns: Vec<Value>) -> AgentDetail {
    let mut d: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","goal":"","cwd":"/tmp","model":"","color":"sage",
        "status":"working","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]})).unwrap();
    d.turns = turns;
    d
}
fn running(items: Vec<Value>) -> Value {
    let mut all = vec![json!({"id":"u","type":"userMessage","content":[{"type":"text","text":"Do it"}]})];
    all.extend(items);
    json!({"id":"t","status":"inProgress","items":all})
}
fn wait(items: Vec<Value>) -> Option<(String, String, String)> {
    turn_wait(&detail(vec![running(items)])).map(|w| (w.kind, w.item_id, w.label))
}
fn shell(id: &str, label: &str) -> Option<(String, String, String)> {
    Some(("shell".into(), id.into(), label.into()))
}
fn sub(id: &str, label: &str) -> Option<(String, String, String)> {
    Some(("subAgent".into(), id.into(), label.into()))
}

#[test]
fn claude_a_running_bash_call_is_a_shell_wait() {
    let bash = json!({"id":"b1","type":"claudeToolUse","name":"Bash","input":{"command":"cargo test -p core","description":"Run tests"},"status":"inProgress"});
    assert_eq!(wait(vec![bash.clone()]), shell("b1", "cargo test -p core"));
    let mut done = bash;
    done["status"] = "completed".into();
    assert_eq!(wait(vec![done]), None, "a call that returned is no wait");
}

#[test]
fn claude_a_foreground_sub_agent_is_waited_on_and_its_own_calls_are_its() {
    let agent = json!({"id":"a1","type":"claudeToolUse","name":"Agent","input":{"description":"Survey the notes","prompt":"Read them all"},
        "status":"inProgress","subAgent":{"status":"running","description":"Survey the notes","taskId":"task"}});
    let inner = json!({"id":"b2","type":"claudeToolUse","name":"Bash","input":{"command":"ls"},"status":"inProgress","parentToolUseId":"a1"});
    assert_eq!(wait(vec![agent.clone(), inner.clone()]), sub("a1", "Survey the notes"));
    // Before Claude's task events give it a record, the call says what it is.
    let fresh = json!({"id":"a2","type":"claudeToolUse","name":"Task","input":{"description":"Find the sources"},"status":"inProgress"});
    assert_eq!(wait(vec![fresh]), sub("a2", "Find the sources"));
    // A sub-agent sent to the background does not hold the Turn; a shell of the Turn's own does.
    let mut background = agent;
    background["subAgent"]["background"] = true.into();
    let bash = json!({"id":"b3","type":"claudeToolUse","name":"Bash","input":{"command":"npm run build"},"status":"inProgress"});
    assert_eq!(wait(vec![background.clone()]), None);
    assert_eq!(wait(vec![background, bash]), shell("b3", "npm run build"));
}

#[test]
fn claude_a_sub_agent_that_ended_is_no_wait() {
    for status in ["completed", "failed", "stopped", "unknown"] {
        let agent = json!({"id":"a1","type":"claudeToolUse","name":"Agent","input":{"description":"Survey"},
            "status":"inProgress","subAgent":{"status":status}});
        assert_eq!(wait(vec![agent]), None, "{status}");
    }
}

#[test]
fn codex_a_running_command_is_a_shell_wait() {
    let command = json!({"id":"c1","type":"commandExecution","command":"npm test","status":"inProgress"});
    assert_eq!(wait(vec![command.clone()]), shell("c1", "npm test"));
    let mut done = command;
    done["status"] = "completed".into();
    assert_eq!(wait(vec![done]), None);
}

#[test]
fn codex_a_sub_agent_runs_from_started_until_completed_or_interrupted() {
    let activity = |kind: &str, child: &str| json!({"type":"subAgentActivity","id":format!("{kind}-{child}"),"kind":kind,
        "agentThreadId":child,"agentPath":format!("/root/{child}"),"model":null});
    assert_eq!(wait(vec![activity("started", "c")]), sub("started-c", "/root/c"));
    assert_eq!(wait(vec![activity("started", "c"), activity("interacted", "c")]), sub("interacted-c", "/root/c"));
    assert_eq!(wait(vec![activity("started", "c"), activity("completed", "c")]), None);
    assert_eq!(wait(vec![activity("started", "c"), activity("interrupted", "c")]), None);
    // One child ended, another still runs.
    assert_eq!(wait(vec![activity("started", "c"), activity("started", "d"), activity("completed", "c")]), sub("started-d", "/root/d"));
}

#[test]
fn opencode_bash_task_and_subagent_tools_and_shell_parts() {
    let bash = json!({"id":"o1","type":"opencodeTool","name":"bash","input":{"command":"ls -la","description":"List"},"status":"inProgress"});
    assert_eq!(wait(vec![bash]), shell("o1", "ls -la"));
    let task = json!({"id":"o2","type":"opencodeTool","name":"task","input":{"description":"Find the sources","subagent_type":"general"},"status":"inProgress"});
    assert_eq!(wait(vec![task]), sub("o2", "Find the sources"));
    let subagent = json!({"id":"o3","type":"opencodeTool","name":"subagent","input":{"description":"Check the docs","agent":"explore"},"status":"inProgress"});
    assert_eq!(wait(vec![subagent]), sub("o3", "Check the docs"));
    // A shell part keeps OpenCode's own status.
    let part = json!({"id":"o4","type":"commandExecution","command":"git status","status":"running"});
    assert_eq!(wait(vec![part]), shell("o4", "git status"));
}

#[test]
fn a_sub_agent_comes_before_a_shell_and_the_newest_shell_is_named() {
    let bash = |id: &str, cmd: &str| json!({"id":id,"type":"commandExecution","command":cmd,"status":"inProgress"});
    let child = json!({"type":"subAgentActivity","id":"started-c","kind":"started","agentThreadId":"c","agentPath":"/root/c"});
    assert_eq!(wait(vec![bash("c1", "make"), child]), sub("started-c", "/root/c"));
    assert_eq!(wait(vec![bash("c1", "make"), bash("c2", "make test")]), shell("c2", "make test"));
}

#[test]
fn thinking_writing_and_other_calls_are_no_wait() {
    assert_eq!(wait(vec![]), None);
    assert_eq!(wait(vec![json!({"id":"r","type":"reasoning","summary":[]})]), None);
    assert_eq!(wait(vec![json!({"id":"m","type":"agentMessage","text":"Writ"})]), None);
    assert_eq!(wait(vec![json!({"id":"x","type":"mcpToolCall","server":"yuzuno","tool":"review_start","status":"inProgress"})]), None);
    assert_eq!(wait(vec![json!({"id":"y","type":"claudeToolUse","name":"Read","input":{"file_path":"/tmp/a"},"status":"inProgress"})]), None);
    assert_eq!(wait(vec![json!({"id":"z","type":"opencodeTool","name":"read","input":{},"status":"inProgress"})]), None);
}

#[test]
fn only_a_running_turn_waits() {
    let bash = json!({"id":"c1","type":"commandExecution","command":"npm test","status":"inProgress"});
    let mut ended = running(vec![bash]);
    for status in ["completed", "failed", "interrupted"] {
        ended["status"] = status.into();
        assert_eq!(turn_wait(&detail(vec![ended.clone()])), None, "{status}");
    }
    assert_eq!(turn_wait(&detail(vec![])), None);
}

#[test]
fn the_label_is_one_line_and_bounded() {
    let long = format!("cargo test \\\n  --locked {}", "x".repeat(200));
    let (_, _, label) = wait(vec![json!({"id":"c1","type":"commandExecution","command":long,"status":"inProgress"})]).unwrap();
    assert!(label.starts_with("cargo test \\ --locked xxx"), "{label}");
    assert_eq!(label.chars().count(), LABEL_CHARS + 1);
    assert!(label.ends_with('…'));
    // Codex may give a command as its argv.
    let argv = wait(vec![json!({"id":"c2","type":"commandExecution","command":["bash","-lc","echo hi"],"status":"inProgress"})]);
    assert_eq!(argv, shell("c2", "bash -lc echo hi"));
    // Nothing to say: an empty label, still a wait.
    assert_eq!(wait(vec![json!({"id":"b","type":"claudeToolUse","name":"Bash","status":"inProgress"})]), shell("b", ""));
}

#[test]
fn the_listed_agent_carries_it_and_its_json_is_camel_case() {
    let d = detail(vec![running(vec![json!({"id":"c1","type":"commandExecution","command":"npm test","status":"inProgress"})])]);
    let mut agent = d.agent.clone();
    agent.turn_wait = turn_wait(&d);
    let value = serde_json::to_value(&agent).unwrap();
    assert_eq!(value["turnWait"], json!({"kind":"shell","itemId":"c1","label":"npm test"}));
    // Derived for responses only: a stored record's value is never read back.
    let back: crate::model::Agent = serde_json::from_value(value).unwrap();
    assert_eq!(back.turn_wait, None);
}
