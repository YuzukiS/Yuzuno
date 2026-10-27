//! T-29: a Codex Agent's skills through the HTTP API, with a fake app-server
//! that lists skills for the Agent's folder and records each message's
//! native input. No account, model or real session is used.
use super::*;
use std::os::unix::fs::PermissionsExt;

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    base: String,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Lab {
    fn drop(&mut self) {
        self.server.abort();
        for c in self.ws.rpcs.lock().unwrap().values() { c.rpc.close(); }
    }
}

const REPO: &str = "/tmp/.codex/skills/deploy/SKILL.md";
const USER: &str = "C:\\Users\\me\\.codex\\skills\\deploy\\SKILL.md";

impl Lab {
    /// `active`: the thread has a Turn in progress, for a follow-up.
    async fn new(active: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("native.py");
        std::fs::write(&script, r#"#!/usr/bin/python3
import json,sys,pathlib
root=pathlib.Path(__file__).parent
state=root/'thread.json'
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
 r=json.loads(line); m=r.get('method','response'); p=r.get('params',{})
 if 'method' not in r or 'id' not in r:continue
 if m=='thread/turns/list': sys.stdout.ids.add(r['id']); m='thread/read'
 result={}
 if m in ['thread/start','thread/resume','thread/read']:
  result={'thread':json.loads(state.read_text()),'model':'m'}
 elif m=='skills/list':
  with (root/'listed').open('a') as f:f.write(json.dumps(p)+'\n')
  mode=(root/'skills-mode').read_text() if (root/'skills-mode').exists() else ''
  if mode=='missing':
   print(json.dumps({'id':r['id'],'error':{'code':-32601,'message':'Method not found'}}),flush=True)
   continue
  result=json.loads((root/'skills.json').read_text())
 elif m in ['turn/start','turn/steer']:
  with (root/'sent').open('a') as f:f.write(json.dumps({'method':m,'input':p['input']})+'\n')
  t=json.loads(state.read_text())
  if m=='turn/start':t['turns'].append({'id':'new-turn','status':'inProgress','items':[]})
  turn=t['turns'][-1]
  t['status']={'type':'active'}
  state.write_text(json.dumps(t))
  result={'turn':turn} if m=='turn/start' else {'turnId':turn['id']}
 print(json.dumps({'id':r['id'],'result':result}),flush=True)
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let turns = json!([{"id":"old-turn","status":if active {"inProgress"} else {"completed"},"items":[]}]);
        std::fs::write(dir.path().join("thread.json"), json!({"id":"thread-a","status":{"type":if active {"active"} else {"idle"}},"turns":turns}).to_string()).unwrap();
        std::fs::write(dir.path().join("skills.json"), json!({"data":[{"cwd":"/tmp","errors":[],"skills":[
            {"name":"deploy","description":"Deploy from this repo","path":REPO,"scope":"repo","enabled":true},
            {"name":"deploy","description":"My own deploy","path":USER,"scope":"user","enabled":true},
            {"name":"off","description":"Turned off","path":"/tmp/off/SKILL.md","scope":"repo","enabled":false}]}]}).to_string()).unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), script.display().to_string()).unwrap();
        let d: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage",
            "threadId":"thread-a","status":if active {"working"} else {"offline"},"createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":turns,"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&d).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = crate::server::router_on_port(ws.clone(), dir.path().join("web"), addr.port());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        Self { dir, ws, base: format!("http://{addr}/api"), server }
    }

    async fn connect(&self) {
        self.ws.reconnect("a").await.unwrap();
        let generation = self.ws.rpcs.lock().unwrap()["a"].generation;
        self.ws.collaboration_started("a", generation).await;
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let response = reqwest::Client::new().get(format!("{}{path}", self.base)).header("X-Yuzuno-Client", "desktop").send().await.unwrap();
        (response.status().as_u16(), response.json().await.unwrap())
    }

    async fn post(&self, path: &str, body: &Value) -> (u16, Value) {
        let response = reqwest::Client::new().post(format!("{}{path}", self.base))
            .header("X-Yuzuno-Client", "desktop").json(body).send().await.unwrap();
        (response.status().as_u16(), response.json().await.unwrap())
    }

    fn lines(&self, file: &str) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join(file)).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }
}

fn message(id: &str, text: &str, turn: Option<&str>, skills: Value) -> Value {
    let mut body = json!({"clientMessageId":id,"text":text,"expectedTurnId":turn});
    if !skills.is_null() { body["skills"] = skills; }
    body
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn skills_are_listed_by_the_agents_own_codex_only_while_it_is_connected() {
    let lab = Lab::new(false).await;
    let (status, view) = lab.get("/agents/a/codex/skills").await;
    assert_eq!((status, view["state"].as_str(), view["reason"].as_str()), (200, Some("unavailable"), Some("not_connected")));
    assert!(lab.lines("listed").is_empty(), "nothing is started to list skills");
    lab.connect().await;
    let (_, view) = lab.get("/agents/a/codex/skills").await;
    assert_eq!((view["state"].as_str(), view["disabled"].as_u64(), view["total"].as_u64()), (Some("ready"), Some(1), Some(2)));
    assert_eq!(view["commands"].as_array().unwrap().iter().map(|c| (c["name"].as_str().unwrap(), c["path"].as_str().unwrap(), c["scope"].as_str().unwrap(),
        c["source"].as_str().unwrap())).collect::<Vec<_>>(), [("deploy", REPO, "repo", "skill"), ("deploy", USER, "user", "skill")]);
    assert_eq!(lab.lines("listed"), [json!({"cwds":["/tmp"]})], "for the Agent's own folder");
    std::fs::write(lab.dir.path().join("skills-mode"), "missing").unwrap();
    let (_, view) = lab.get("/agents/a/codex/skills").await;
    assert_eq!((view["state"].as_str(), view["reason"].as_str()), (Some("unsupported"), Some("old_protocol")));
    assert!(lab.lines("sent").is_empty(), "listing sends nothing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_invokes_exactly_the_listed_skills_it_names_as_typed_items_after_its_text() {
    for active in [false, true] {
        let lab = Lab::new(active).await;
        lab.connect().await;
        let turn = active.then_some("old-turn");
        let chosen = json!([{"name":"deploy","path":USER}]);
        let (status, receipt) = lab.post("/agents/a/messages", &message("m1", "$deploy now", turn, chosen.clone())).await;
        assert_eq!((status, receipt["status"].as_str()), (200, Some("accepted")), "{receipt}");
        assert_eq!(receipt["skills"], chosen, "kept on the receipt");
        assert!(receipt["input"].get("skills").is_none(), "beside the input, which an older Core reads strictly");
        let sent = lab.lines("sent");
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["method"], if active { "turn/steer" } else { "turn/start" });
        assert_eq!(sent[0]["input"], json!([{"type":"text","text":"$deploy now"},{"type":"skill","name":"deploy","path":USER}]));
        // The same message again is the same receipt; other skills under its id are refused.
        let (status, again) = lab.post("/agents/a/messages", &message("m1", "$deploy now", turn, chosen)).await;
        assert_eq!((status, again["status"].as_str()), (200, Some("accepted")));
        let (status, other) = lab.post("/agents/a/messages", &message("m1", "$deploy now", turn, json!([{"name":"deploy","path":REPO}]))).await;
        assert_eq!(status, 400, "{other}");
        assert_eq!(lab.lines("sent").len(), 1, "nothing sent twice");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_skill_not_listed_or_turned_off_or_malformed_sends_nothing_and_keeps_the_draft() {
    let lab = Lab::new(false).await;
    lab.connect().await;
    for skills in [json!([{"name":"deploy","path":"/elsewhere/SKILL.md"}]), json!([{"name":"off","path":"/tmp/off/SKILL.md"}]),
                   json!([{"name":"deploy","path":REPO,"extra":true}]), json!([{"name":"deploy","path":REPO},{"name":"deploy","path":REPO}]),
                   json!("deploy")] {
        let (status, error) = lab.post("/agents/a/messages", &message("m", "$deploy", None, skills.clone())).await;
        assert_eq!((status, error["code"].as_str()), (400, Some("message_not_submitted")), "{skills}: {error}");
    }
    std::fs::write(lab.dir.path().join("skills-mode"), "missing").unwrap();
    let (status, error) = lab.post("/agents/a/messages", &message("m", "$deploy", None, json!([{"name":"deploy","path":REPO}]))).await;
    assert_eq!((status, error["code"].as_str()), (400, Some("message_not_submitted")));
    assert!(error["error"].as_str().unwrap().contains("does not list skills"));
    assert!(lab.ws.detail("a").await.unwrap().message_receipts.is_empty(), "no receipt: never submitted");
    assert!(lab.lines("sent").is_empty(), "never sent as a plain prompt instead");
    // A message without skills is as before.
    let (status, receipt) = lab.post("/agents/a/messages", &message("plain", "hello", None, Value::Null)).await;
    assert_eq!((status, receipt["status"].as_str()), (200, Some("accepted")));
    assert!(receipt.get("skills").is_none());
    assert_eq!(lab.lines("sent")[0]["input"], json!([{"type":"text","text":"hello"}]));
}

#[test]
fn a_receipt_with_skills_reads_in_a_core_that_predates_them() {
    let receipt = MessageReceipt { binding: None, input: serde_json::from_value(json!({"clientMessageId":"m","text":"$deploy"})).unwrap(),
        skills: vec![SkillRef { name: "deploy".into(), path: REPO.into() }], status: "accepted".into(), turn_id: Some("t".into()), error: None };
    let saved = serde_json::to_value(&receipt).unwrap();
    // What an older Core reads: the same receipt shape without `skills`,
    // and a strict input.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)]
    struct Older { input: MessageInput, status: String, turn_id: Option<String>, error: Option<String> }
    serde_json::from_value::<Older>(saved.clone()).expect("an older Core reads it");
    assert_eq!(serde_json::from_value::<MessageReceipt>(saved).unwrap().skills, receipt.skills);
    let plain: MessageReceipt = serde_json::from_value(json!({"input":{"clientMessageId":"m","text":"hi"},"status":"accepted","turnId":null,"error":null})).unwrap();
    assert!(serde_json::to_value(&plain).unwrap().get("skills").is_none(), "no skills, the bytes as before");
}
