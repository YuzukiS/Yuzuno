//! T-9 opt-in browser acceptance: an Agent writes Home cards through the real
//! MCP brief_update of an isolated Core, and Home shows them at both
//! densities. The native Codex transport is deterministic; no paid model or
//! daily Core.
#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use serde_json::{json, Value};
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, path::PathBuf};
use yuzuno_workspace::{collaboration_mcp, model::AgentDetail, server, workspace::Workspace};

#[tokio::test]
#[ignore = "managed Job: requires isolated YUZUNO_UI_DIST and Chromium"]
async fn home_cards_at_both_densities_in_real_core_and_browser() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned();
    let dist = PathBuf::from(std::env::var("YUZUNO_UI_DIST").expect("isolated UI build"));
    assert!(dist.is_absolute() && dist != root.join("web/dist"));
    let output = root.join("target/t9-browser");
    std::fs::create_dir_all(&output).unwrap();
    let lab = tempfile::tempdir_in(&output).unwrap();
    let script = lab.path().join("native.py");
    std::fs::write(&script, r#"#!/usr/bin/python3
import json, sys, os
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
    if 'id' not in request or 'method' not in request: continue
    method = request['method']
    if method=='thread/turns/list': sys.stdout.ids.add(request['id']); method='thread/read'
    result = {}
    if method == 'config/read': result = {'config':{}}
    if method in ['thread/start','thread/resume','thread/read']:
        result = {'thread':{'id':'lab-'+str(os.getpid()),'status':{'type':'idle'},'turns':[]}}
    if method == 'turn/steer': result = {'turnId':'seed-turn'}
    if method == 'turn/start': result = {'turn':{'id':'reply-turn','status':'inProgress','items':[]}}
    print(json.dumps({'id':request['id'],'result':result}), flush=True)
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ws = Workspace::new(lab.path().join("data"), lab.path().to_string_lossy().into(), script.to_string_lossy().into()).unwrap();
    let project = ws.store.create_project("Density lab", BTreeMap::new()).unwrap().id;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    assert_ne!(port, 4317);
    ws.start_collaboration(port);
    ws.set_runtime(json!({"connected":true})).await;
    let mut clients = serde_json::Map::new();
    for (id, name) in [("writer", "Writer fixture")] {
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{
            "id":id,"name":name,"cwd":lab.path(),"model":"","color":"sage","status":"offline",
            "threadId":null,"createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&detail).unwrap();
        ws.store.set_agent_project(id, Some(&project)).unwrap();
        ws.reconnect(id).await.unwrap();
        ws.store.update(id, "lab/running", &json!({}), |d| {
            d.agent.status = "working".into();
            d.agent.connection_state = "connected".into();
            d.turns = vec![json!({"id":"seed-turn","status":"inProgress","items":[]})];
        }).unwrap();
        clients.insert(id.into(), collaboration_mcp::agent_http_config(&ws, id, &format!("http://127.0.0.1:{port}")).unwrap());
    }
    // Files the Agent registers as attachments, on this host.
    let files = lab.path().join("files");
    std::fs::create_dir_all(&files).unwrap();
    let config = lab.path().join("client.json");
    std::fs::write(&config, json!({"url":format!("http://127.0.0.1:{port}"),"project":project,"clients":clients,"output":output,"files":files}).to_string()).unwrap();
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
    let app = server::router_on_port(ws.clone(), dist, port);
    let serving = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let result = tokio::process::Command::new(std::env::var("YUZUNO_NODE").unwrap_or_else(|_| "node".into()))
        .arg(root.join("acceptance/t9-home-density/browser.mjs")).arg(&config)
        .current_dir(&root).output().await.unwrap();
    let _ = ws.close_agent("writer").await;
    serving.abort();
    assert!(result.status.success(), "browser failed:\n{}\n{}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
    let report: Value = serde_json::from_slice(&std::fs::read(output.join("report.json")).unwrap()).unwrap();
    assert!(report["checks"].as_array().unwrap().len() >= 8);
    assert_eq!(report["passed"], json!(true));
}
