//! Regression for the shared thread-parameter boundary after the two slices merge.
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use yuzuno_workspace::{model::AgentDetail, workspace::Workspace};

#[tokio::test]
async fn native_permissions_and_collaboration_config_survive_start_resume_and_next_turn() {
    for existing_thread in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("native.py");
        std::fs::write(&script, r#"#!/usr/bin/python3
import json, pathlib, sys
root = pathlib.Path(__file__).parent
state = root / 'thread.json'
def emit(value): print(json.dumps(value), flush=True)
def thread():
    return json.loads(state.read_text()) if state.exists() else {'id':'thread','status':{'type':'idle'},'turns':[]}
class _TurnsList:
    """thread/turns/list answered as this fake's thread/read (T-140)."""
    def __init__(self, raw): self.raw, self.ids, self.buf = raw, set(), ''
    def write(self, text):
        self.buf += text
        while '\n' in self.buf:
            line, self.buf = self.buf.split('\n', 1)
            try:
                v = json.loads(line)
                if isinstance(v, dict) and v.get('id') in self.ids and 'result' in v:
                    self.ids.discard(v['id'])
                    turns = ((v['result'] or {}).get('thread') or {}).get('turns') or []
                    v['result'] = {'data': list(reversed(turns)), 'nextCursor': None}
                    line = json.dumps(v)
            except ValueError: pass
            self.raw.write(line + '\n')
        return len(text)
    def flush(self): self.raw.flush()
sys.stdout = _TurnsList(sys.stdout)
for line in sys.stdin:
    request = json.loads(line)
    with (root / 'calls.jsonl').open('a') as log: log.write(json.dumps(request)+'\n')
    if 'id' not in request: continue
    method, params = request['method'], request.get('params', {})
    if method=='thread/turns/list': sys.stdout.ids.add(request['id']); method='thread/read'
    result = {}
    if method == 'config/read':
        result = {'config':json.loads((root / 'config.json').read_text())}
    elif method == 'configRequirements/read': result = {'requirements':None}
    elif method in ['thread/start','thread/resume','thread/read']:
        result = {'thread':thread()}
    elif method in ['turn/start','turn/steer']:
        t = thread()
        if method == 'turn/start':
            turn = {'id':'turn-'+str(len(t['turns'])+1),'status':'inProgress','items':[]}
            t['turns'].append(turn)
        else: turn = t['turns'][-1]
        item = {'id':'item-'+str(len(turn['items'])),'clientId':params.get('clientUserMessageId'),'type':'userMessage','content':params['input']}
        turn['items'].append(item)
        t['status'] = {'type':'active'}
        state.write_text(json.dumps(t))
        result = {'turn':turn} if method == 'turn/start' else {'turnId':turn['id']}
    emit({'id':request['id'],'result':result})
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config_file = dir.path().join("config.json");
        std::fs::write(
            &config_file,
            json!({
                "approvals_reviewer":"auto_review", "approval_policy":"on-request",
                "sandbox_mode":"workspace-write", "developer_instructions":"Keep replies short."
            })
            .to_string(),
        )
        .unwrap();
        let ws = Workspace::new(
            dir.path().join("data"),
            "/tmp".into(),
            script.to_string_lossy().into(),
        )
        .unwrap();
        let detail: AgentDetail = serde_json::from_value(json!({
            "agent":{"id":"a","name":"A","goal":"","cwd":"/tmp","model":"",
                "color":"sage","threadId":if existing_thread {json!("thread")} else {Value::Null},
                "status":"idle","createdAt":"","updatedAt":"","unreadCount":0,
                "pendingCount":0,"lastSeq":0,"reviewedSeq":0,
                "settings":{"permissionPreset":"config","reasoningEffort":"high",
                    "approvalPolicy":"on-request","sandbox":"workspace-write"}},
            "turns":[],"pending":[],"artifacts":[]
        }))
        .unwrap();
        ws.store.insert(&detail).unwrap();
        // The fake native client records config only; no server or model is started.
        ws.start_collaboration(4399);
        ws.reconnect("a").await.unwrap();
        let calls = || -> Vec<Value> {
            std::fs::read_to_string(dir.path().join("calls.jsonl"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        };
        let requests = calls();
        let method = if existing_thread {
            "thread/resume"
        } else {
            "thread/start"
        };
        let initial = &requests.iter().find(|r| r["method"] == method).unwrap()["params"];
        assert_eq!(initial["approvalsReviewer"], "auto_review");
        assert_eq!(initial["sandbox"], "workspace-write");
        assert_eq!(initial["config"]["model_reasoning_effort"], "high");
        let mcp = &initial["config"]["mcp_servers.yuzuno"];
        assert_eq!(mcp["url"], "http://127.0.0.1:4399/mcp/a");
        assert_eq!(mcp["required"], true);
        assert!(mcp["enabled_tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "peer_read"));
        assert!(mcp["http_headers"]["Authorization"]
            .as_str()
            .unwrap()
            .starts_with("Bearer "));
        // The result and guide notice follows the configured developer
        // instructions, on start and on resume alike (T-85): a resumed thread
        // is rebuilt from the current configuration when it compacts, so the
        // rules must be sent again. This Agent has no Project, so no Brief rules.
        let notice = yuzuno_workspace::guide::session_notice();
        assert_eq!(initial["developerInstructions"], format!("Keep replies short.\n\n{notice}"));

        ws.send_message(
            "a",
            serde_json::from_value(json!({
                "clientMessageId":"first","text":"first"
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        std::fs::write(
            &config_file,
            json!({
                "approvals_reviewer":"user", "approval_policy":"never", "sandbox_mode":"read-only"
            })
            .to_string(),
        )
        .unwrap();
        let steered = ws
            .send_message(
                "a",
                serde_json::from_value(json!({
                    "clientMessageId":"extra","text":"extra","expectedTurnId":"turn-1"
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(steered.status, "accepted");
        let requests = calls();
        let steer = &requests
            .iter()
            .find(|r| r["method"] == "turn/steer")
            .unwrap()["params"];
        for field in [
            "approvalsReviewer",
            "approvalPolicy",
            "sandboxPolicy",
            "permissions",
            "config",
        ] {
            assert!(
                steer.get(field).is_none(),
                "steer must keep current permissions: {field}"
            );
        }
        let finish = || {
            let state = dir.path().join("thread.json");
            let mut thread: Value =
                serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
            thread["turns"].as_array_mut().unwrap().last_mut().unwrap()["status"] =
                "completed".into();
            thread["status"]["type"] = "idle".into();
            std::fs::write(state, thread.to_string()).unwrap();
        };
        finish();
        ws.reconnect("a").await.unwrap();
        ws.send_message(
            "a",
            serde_json::from_value(json!({
                "clientMessageId":"second","text":"second"
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        let requests = calls();
        let starts: Vec<_> = requests
            .iter()
            .filter(|r| r["method"] == "turn/start")
            .collect();
        assert_eq!(starts.len(), 2);
        assert_eq!(starts[0]["params"]["approvalsReviewer"], "auto_review");
        assert_eq!(starts[1]["params"]["approvalsReviewer"], "user");
        assert_eq!(starts[1]["params"]["approvalPolicy"], "never");
        assert_eq!(starts[1]["params"]["sandboxPolicy"]["type"], "readOnly");
        assert_eq!(starts[1]["params"]["effort"], "high");
        assert_eq!(requests.iter().filter(|r| r["method"] == method).count(), 1);
        assert!(!requests.iter().any(|r| r["method"] == "config/batchWrite"));
        finish();
        ws.reconnect("a").await.unwrap();
        ws.close_agent("a").await.unwrap();
    }
}
