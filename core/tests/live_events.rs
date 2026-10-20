//! perf-sse: what clients receive on /api/events. Every message has an id; a
//! reconnect resumes after `Last-Event-ID` without loss or duplicates, or is
//! told to refetch; streamed Codex and Claude output arrives as appends and
//! Item upserts carrying the journal position they were applied at.
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, sync::Arc, time::Duration};
use yuzuno_workspace::{events::Subscription, model::{AgentDetail, MessageInput}, server, workspace::Workspace};

fn lab() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

#[derive(Debug, Default, Clone)]
struct Frame {
    id: Option<String>,
    event: Option<String>,
    data: Value,
}

/// A server-sent event stream read frame by frame.
struct Sse {
    body: std::pin::Pin<Box<dyn futures_util::Stream<Item = reqwest::Result<Vec<u8>>> + Send>>,
    buffer: String,
}

impl Sse {
    async fn open(port: u16, last: Option<&str>, query: Option<&str>) -> Sse {
        let mut url = format!("http://127.0.0.1:{port}/api/events");
        if let Some(query) = query {
            url.push_str(&format!("?lastEventId={query}"));
        }
        let mut request = reqwest::Client::new().get(url);
        if let Some(last) = last {
            request = request.header("Last-Event-ID", last);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.headers()["content-type"].to_str().unwrap().starts_with("text/event-stream"));
        Sse { body: Box::pin(response.bytes_stream().map(|chunk| chunk.map(|b| b.to_vec()))), buffer: String::new() }
    }

    async fn next(&mut self) -> Frame {
        loop {
            if let Some(end) = self.buffer.find("\n\n") {
                let block: String = self.buffer.drain(..end + 2).collect();
                let mut frame = Frame::default();
                let mut data = String::new();
                for line in block.lines() {
                    if let Some(v) = line.strip_prefix("id:") { frame.id = Some(v.trim().into()); }
                    if let Some(v) = line.strip_prefix("event:") { frame.event = Some(v.trim().into()); }
                    if let Some(v) = line.strip_prefix("data:") { data.push_str(v.strip_prefix(' ').unwrap_or(v)); }
                }
                if data.is_empty() { continue; }
                frame.data = serde_json::from_str(&data).unwrap();
                return frame;
            }
            let chunk = tokio::time::timeout(Duration::from_secs(5), self.body.next()).await
                .expect("an event within 5 s").expect("stream open").unwrap();
            self.buffer.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    }
}

async fn serve(ws: Arc<Workspace>, dir: &tempfile::TempDir) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = server::router_on_port(ws, dir.path().join("assets"), port);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    port
}

fn number(id: &str) -> u64 {
    id.rsplit_once('-').unwrap().1.parse().unwrap()
}

#[tokio::test]
async fn reconnects_resume_after_their_last_id_once_and_unknown_ids_reset() {
    let dir = lab();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let port = serve(ws.clone(), &dir).await;

    // A fresh connection starts by refetching, at the current position.
    let mut first = Sse::open(port, None, None).await;
    let reset = first.next().await;
    assert_eq!(reset.data["type"], "reset");
    assert_eq!(reset.data["refresh"], true);
    assert_eq!(reset.event, None, "an ordinary message older clients also see");
    let start = number(reset.id.as_deref().unwrap());
    assert_eq!(start, ws.changes.head());
    let epoch = ws.changes.epoch().to_owned();

    for n in 0..3 { ws.changes.send(json!({"collaboration":true,"n":n})); }
    for n in 0..3 {
        let frame = first.next().await;
        assert_eq!(frame.id.as_deref(), Some(format!("{epoch}-{}", start + 1 + n).as_str()));
        assert_eq!(frame.data["type"], "workspace.changed");
        assert_eq!(frame.data["collaboration"], true, "older clients keep their field");
        assert_eq!(frame.data["n"], n);
    }
    // The connection drops; two messages are published meanwhile.
    drop(first);
    ws.changes.send(json!({"projects":true,"n":3}));
    ws.changes.send(json!({"machines":true,"n":4}));

    let last = format!("{epoch}-{}", start + 3);
    let mut resumed = Sse::open(port, Some(&last), None).await;
    let hello = resumed.next().await;
    assert_eq!(hello.data, json!({"type":"resumed","from":last}));
    assert_eq!(hello.id, None, "resuming does not move the client's position");
    let mut seen = vec![];
    ws.changes.send(json!({"collaboration":true,"n":5}));
    for _ in 0..3 {
        let frame = resumed.next().await;
        seen.push((number(frame.id.as_deref().unwrap()), frame.data["n"].as_u64().unwrap()));
    }
    // Exactly the missed messages, then live ones, each once and in order.
    assert_eq!(seen, vec![(start + 4, 3), (start + 5, 4), (start + 6, 5)]);

    // The same works for a client that opened a new connection itself.
    let mut by_query = Sse::open(port, None, Some(&format!("{epoch}-{}", start + 5))).await;
    assert_eq!(by_query.next().await.data["type"], "resumed");
    assert_eq!(by_query.next().await.data["n"], 5);

    // Another Core process (epoch) or an id never sent: refetch everything.
    let mut foreign = Sse::open(port, Some(&format!("0000-{}", start + 5)), None).await;
    let frame = foreign.next().await;
    assert_eq!((frame.data["type"].as_str(), frame.data["reason"].as_str()), (Some("reset"), Some("epoch")));
    assert_eq!(frame.id.as_deref(), Some(format!("{epoch}-{}", start + 6).as_str()));
    let mut ahead = Sse::open(port, Some(&format!("{epoch}-{}", start + 99)), None).await;
    assert_eq!(ahead.next().await.data["reason"], "unknown");
}

#[tokio::test]
async fn closing_ends_open_streams_so_shutdown_can_finish() {
    let dir = lab();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let port = serve(ws.clone(), &dir).await;
    let mut stream = Sse::open(port, None, None).await;
    assert_eq!(stream.next().await.data["type"], "reset");
    ws.changes.close();
    let end = tokio::time::timeout(Duration::from_secs(5), stream.body.next()).await.expect("stream ends");
    assert!(end.is_none());
}

fn drain(s: &mut Subscription) -> Vec<Value> {
    let mut out = vec![];
    while let Some(entry) = s.try_next() {
        out.push(serde_json::from_str(&entry.data).unwrap());
    }
    out
}

async fn collect_until(s: &mut Subscription, out: &mut Vec<Value>, done: impl Fn(&[Value]) -> bool) {
    for _ in 0..200 {
        out.extend(drain(s));
        if done(out) { return; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("not seen in time: {out:#?}");
}

fn for_agent<'a>(events: &'a [Value], kind: &'a str) -> impl Iterator<Item = &'a Value> + 'a {
    events.iter().filter(move |e| e["type"] == kind)
}

/// What a client holds of one Item after applying these messages in order,
/// starting from nothing.
fn replay(events: &[Value], item: &str) -> Value {
    let mut current = Value::Null;
    for e in events.iter().filter(|e| e["itemId"] == item || e["item"]["id"] == item) {
        match e["type"].as_str() {
            Some("agent.item") => current = e["item"].clone(),
            Some("agent.delta") => {
                let field = e["field"].as_str().unwrap();
                let text = e["text"].as_str().unwrap();
                match e["index"].as_u64() {
                    None => {
                        let value = format!("{}{text}", current[field].as_str().unwrap_or(""));
                        current[field] = value.into();
                    }
                    Some(index) => {
                        let index = index as usize;
                        if !current[field].is_array() { current[field] = json!([]); }
                        let parts = current[field].as_array_mut().unwrap();
                        while parts.len() <= index { parts.push("".into()); }
                        parts[index] = format!("{}{text}", parts[index].as_str().unwrap()).into();
                    }
                }
            }
            _ => {}
        }
    }
    current
}

fn item(detail: &AgentDetail, id: &str) -> Value {
    detail.turns.iter().flat_map(|t| t["items"].as_array().unwrap()).find(|i| i["id"] == id).cloned().unwrap()
}

#[tokio::test]
async fn codex_progress_arrives_as_one_append_or_item_per_applied_event_in_revision_order() {
    let dir = lab();
    let script = dir.path().join("codex.py");
    std::fs::write(&script, r#"#!/usr/bin/python3
import json, os, sys, threading, time
root = os.path.dirname(os.path.abspath(__file__))
lock = threading.Lock()
def emit(v):
    with lock: print(json.dumps(v), flush=True)
def note(method, **p): emit({'method':method,'params':dict(p, threadId='thread')})
def turn():
    time.sleep(0.5)  # After Core has recorded the message receipt.
    note('item/started', turnId='t1', item={'id':'m1','type':'agentMessage','text':''})
    for d in ['Hel','lo ','wörld']: note('item/agentMessage/delta', turnId='t1', itemId='m1', delta=d)
    note('item/started', turnId='t1', item={'id':'r1','type':'reasoning','summary':[],'content':[]})
    note('item/reasoning/summaryPartAdded', turnId='t1', itemId='r1', summaryIndex=0)
    note('item/reasoning/summaryTextDelta', turnId='t1', itemId='r1', summaryIndex=0, delta='Think')
    note('item/reasoning/summaryPartAdded', turnId='t1', itemId='r1', summaryIndex=1)
    note('item/reasoning/summaryTextDelta', turnId='t1', itemId='r1', summaryIndex=1, delta='Again')
    note('thread/tokenUsage/updated', turnId='t1', tokenUsage={'last':{'totalTokens':500},'modelContextWindow':1000})
    note('item/started', turnId='t1', item={'id':'c1','type':'commandExecution','command':'make','status':'inProgress'})
    for d in ['out1\n','out2\n']: note('item/commandExecution/outputDelta', turnId='t1', itemId='c1', delta=d)
    note('item/completed', turnId='t1', item={'id':'c1','type':'commandExecution','command':'make','status':'completed','aggregatedOutput':'out1\nout2\n','exitCode':0})
    while not os.path.exists(os.path.join(root, 'release')): time.sleep(0.02)
    note('turn/completed', turn={'id':'t1','status':'completed','items':[]})
for line in sys.stdin:
    r = json.loads(line)
    if 'id' not in r: continue
    m, p = r.get('method'), r.get('params', {})
    result = {}
    if m in ['thread/start','thread/resume','thread/read']:
        result = {'thread':{'id':'thread','status':{'type':'idle'},'turns':[]},'model':'m'}
    elif m == 'model/list':
        result = {'data':[{'id':'m','model':'m','defaultReasoningEffort':'low','supportedReasoningEfforts':[{'reasoningEffort':'low'}]}],'nextCursor':None}
    elif m == 'config/read':
        result = {'config':{}}
    elif m == 'turn/start':
        t = {'id':'t1','status':'inProgress','items':[]}
        emit({'id':r['id'],'result':{'turn':t}})
        note('turn/started', turn=t)
        threading.Thread(target=turn, daemon=True).start()
        continue
    emit({'id':r['id'],'result':result})
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), script.to_string_lossy().into()).unwrap();
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage",
        "threadId":"thread","status":"idle","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&detail).unwrap();
    ws.reconnect("a").await.unwrap();
    let mut live = ws.changes.subscribe(None);
    let input: MessageInput = serde_json::from_value(json!({"clientMessageId":"c","text":"go"})).unwrap();
    ws.send_message("a", input).await.unwrap();

    let mut events = vec![];
    collect_until(&mut live, &mut events, |e| {
        e.iter().any(|e| e["type"] == "agent.item" && e["item"]["id"] == "c1" && e["item"]["status"] == "completed")
            && e.iter().any(|e| e["type"] == "agent.progress")
    }).await;
    let events: Vec<Value> = events.into_iter().filter(|e| e["agentId"] == "a").collect();
    let d = ws.store.detail("a").unwrap();

    // Streamed text: one append per native delta, in order.
    let deltas: Vec<&Value> = for_agent(&events, "agent.delta").filter(|e| e["itemId"] == "m1").collect();
    assert_eq!(deltas.iter().map(|e| e["text"].as_str().unwrap()).collect::<String>(), "Hello wörld");
    assert!(deltas.iter().all(|e| e["field"] == "text" && e["op"] == "append" && e["turnId"] == "t1"));
    for (name, value) in [("m1", "text"), ("r1", "summary"), ("c1", "aggregatedOutput")] {
        assert_eq!(replay(&events, name)[value], item(&d, name)[value], "{name}");
    }
    assert_eq!(replay(&events, "r1")["summary"], json!(["Think", "Again"]));
    assert_eq!(replay(&events, "c1"), item(&d, "c1"), "the completed Item is sent whole");
    let context = for_agent(&events, "agent.context").next().unwrap();
    assert_eq!(context["contextUsage"]["usedTokens"], 500);

    // One message per applied native event, in order, each with a higher
    // revision; a read afterwards carries at least the last one.
    let mut last = 0;
    let mut kinds = vec![];
    for e in events.iter().filter(|e| ["agent.delta", "agent.item", "agent.context"].contains(&e["type"].as_str().unwrap())) {
        let rev = e["rev"].as_u64().unwrap();
        assert!(rev > last, "revisions increase: {e}");
        last = rev;
        kinds.push(match e["type"].as_str().unwrap() {
            "agent.delta" if e["field"] == "summary" && e["text"] == "" => "item/reasoning/summaryPartAdded",
            "agent.delta" if e["field"] == "summary" => "item/reasoning/summaryTextDelta",
            "agent.delta" if e["field"] == "aggregatedOutput" => "item/commandExecution/outputDelta",
            "agent.delta" => "item/agentMessage/delta",
            "agent.context" => "thread/tokenUsage/updated",
            "agent.item" if e["item"]["status"] == "completed" => "item/completed",
            "agent.item" => "item/started",
            other => panic!("{other}"),
        });
    }
    // The scripted runtime's events after its Turn started, in order.
    assert_eq!(kinds, ["item/started", "item/agentMessage/delta", "item/agentMessage/delta", "item/agentMessage/delta",
        "item/started", "item/reasoning/summaryPartAdded", "item/reasoning/summaryTextDelta",
        "item/reasoning/summaryPartAdded", "item/reasoning/summaryTextDelta", "thread/tokenUsage/updated",
        "item/started", "item/commandExecution/outputDelta", "item/commandExecution/outputDelta", "item/completed"]);
    assert!(d.agent.rev >= last, "a read carries at least the last revision");

    // Streaming announces the Agent's listed entry, never a detail refetch.
    let progress = for_agent(&events, "agent.progress").last().unwrap();
    assert_eq!(progress["agent"]["id"], "a");
    assert_eq!(progress["agent"]["status"], "working");
    let first_stream = events.iter().position(|e| e["type"] == "agent.delta").unwrap();
    assert!(events[first_stream..].iter().all(|e| e["type"] != "agent.changed"),
        "no refetch notice while only progress arrives: {events:#?}");

    // The Turn ending is a change clients refetch.
    let before = ws.changes.head();
    std::fs::write(dir.path().join("release"), "").unwrap();
    let mut ended = vec![];
    collect_until(&mut live, &mut ended, |e| e.iter().any(|e| e["type"] == "agent.changed" && e["agentId"] == "a")).await;
    let changed = ended.iter().find(|e| e["type"] == "agent.changed").unwrap();
    assert_eq!(changed["lastSeq"], ws.store.detail("a").unwrap().agent.last_seq);
    assert!(ws.changes.head() > before);
}

#[tokio::test]
async fn claude_partial_text_goes_out_as_appends_and_changed_items_whole() {
    let dir = lab();
    let bridge = dir.path().join("bridge.py");
    std::fs::write(&bridge, r#"import json, sys
def emit(v): print(json.dumps(v), flush=True)
session = 'session-1'
def ev(turn, body): emit({'type':'event','turnId':turn,'event':dict(body, session_id=session)})
def se(turn, e): ev(turn, {'type':'stream_event','event':e})
for line in sys.stdin:
    c = json.loads(line)
    op, rid = c.get('op'), c.get('id')
    if op == 'start':
        emit({'type':'response','id':rid,'result':{'started':True,'sessionId':session}})
        ev(None, {'type':'system','subtype':'init','model':'m','permissionMode':'default'})
        continue
    if op == 'send':
        t = c['turnId']
        emit({'type':'response','id':rid,'result':{'queued':True}})
        se(t, {'type':'message_start','message':{'id':'msg1','usage':{'input_tokens':10}}})
        se(t, {'type':'content_block_start','index':0,'content_block':{'type':'thinking','thinking':''}})
        for d in ['Pondering ', 'this ', 'idea']:
            se(t, {'type':'content_block_delta','index':0,'delta':{'type':'thinking_delta','thinking':d}})
        se(t, {'type':'content_block_start','index':1,'content_block':{'type':'text','text':''}})
        for d in ['Hel', 'lo ', 'wörld']:
            se(t, {'type':'content_block_delta','index':1,'delta':{'type':'text_delta','text':d}})
        se(t, {'type':'content_block_start','index':2,'content_block':{'type':'tool_use','id':'tool1','name':'Write','input':{}}})
        for d in ['{"file_', 'path": "/w/no', 'tes.md"}']:
            se(t, {'type':'content_block_delta','index':2,'delta':{'type':'input_json_delta','partial_json':d}})
        se(t, {'type':'message_delta','usage':{'output_tokens':5}})
        ev(t, {'type':'assistant','uuid':'u1','message':{'id':'msg1','content':[{'type':'thinking','thinking':'Pondering this idea'},{'type':'text','text':'Hello wörld'}]}})
        ev(t, {'type':'assistant','uuid':'u2','message':{'id':'msg2','content':[{'type':'tool_use','id':'tool1','name':'Write','input':{'file_path':'/w/notes.md'}}]}})
        ev(t, {'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'tool1','content':'ok','is_error':False}]}})
        ev(t, {'type':'result','is_error':False,'result':'Hello wörld','subtype':'success','modelUsage':{'m':{'contextWindow':1000}}})
        continue
    emit({'type':'response','id':rid,'result':{}})
"#).unwrap();
    std::env::set_var("YUZUNO_NODE", "python3");
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", &bridge);
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let agent = ws.claude_create("C".into(), String::new(), dir.path().to_string_lossy().into(), "m".into(), None).await.unwrap();
    for _ in 0..200 {
        if ws.store.detail(&agent.id).unwrap().agent.connection_state == "connected" { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let mut live = ws.changes.subscribe(None);
    ws.claude_send(&agent.id, "go".into()).await.unwrap();
    let mut events = vec![];
    // Streamed messages, then the Turn's result as a change to refetch.
    let ended = |e: &[Value]| e.iter().position(|e| e["rev"].is_u64() && e["type"] != "agent.changed")
        .is_some_and(|first| e[first..].iter().any(|e| e["type"] == "agent.changed"));
    collect_until(&mut live, &mut events, ended).await;
    let events: Vec<Value> = events.into_iter().filter(|e| e["agentId"] == agent.id.as_str()).collect();
    let first = events.iter().position(|e| e["rev"].is_u64() && e["type"] != "agent.changed").unwrap();
    let stream: Vec<Value> = events[first..].iter().take_while(|e| e["type"] != "agent.changed")
        .filter(|e| e["type"] != "agent.progress").cloned().collect();
    assert!(stream.iter().all(|e| e["rev"].is_u64()), "{stream:#?}");

    // Text: the Item when it starts and with its first text, then only
    // what each delta added.
    let text: Vec<&Value> = stream.iter().filter(|e| e["itemId"] == "msg1" || e["item"]["id"] == "msg1").collect();
    assert_eq!((text[0]["type"].as_str(), text[0]["item"]["text"].as_str()), (Some("agent.item"), Some("")));
    assert_eq!((text[1]["type"].as_str(), text[1]["item"]["text"].as_str()), (Some("agent.item"), Some("Hel")));
    assert_eq!(text[2..4].iter().map(|e| (e["type"].as_str().unwrap(), e["text"].as_str().unwrap())).collect::<Vec<_>>(),
        vec![("agent.delta", "lo "), ("agent.delta", "wörld")]);
    // Thinking is trimmed per part; the client still ends up with exactly it.
    let thinking = replay(&stream, "msg1:thinking");
    assert_eq!(thinking["summary"], json!(["Pondering this idea"]));
    assert!(stream.iter().filter(|e| e["itemId"] == "msg1:thinking").all(|e| e["type"] == "agent.delta" && e["index"] == 0));
    // Confirmation adds a field: the Item goes out whole once more.
    let confirmed = replay(&stream, "msg1");
    assert_eq!(confirmed["text"], "Hello wörld");
    assert_eq!(confirmed["_yuzunoCompletedText"], "Hello wörld");
    // A tool Item goes out whole when it changes, not for partial input
    // that does not parse yet.
    let tool_items: Vec<&Value> = stream.iter().filter(|e| e["item"]["id"] == "tool1").collect();
    assert_eq!(tool_items.iter().map(|e| e["item"]["input"]["file_path"].as_str()).collect::<Vec<_>>(),
        vec![None, Some("/w/notes.md"), Some("/w/notes.md"), Some("/w/notes.md")], "{tool_items:#?}");
    // A tool result goes out whole, with the artifact it produced.
    let tool = stream.iter().rev().find(|e| e["item"]["id"] == "tool1").unwrap();
    assert_eq!(tool["item"]["status"], "completed");
    assert_eq!(tool["artifacts"][0]["path"], "/w/notes.md");
    assert!(for_agent(&stream, "agent.context").count() >= 1);
    // Revisions never go back; a read afterwards carries at least the last.
    let d = ws.store.detail(&agent.id).unwrap();
    let revs: Vec<u64> = stream.iter().map(|e| e["rev"].as_u64().unwrap()).collect();
    assert!(revs.windows(2).all(|w| w[0] <= w[1]), "{revs:?}");
    assert!(d.agent.rev >= *revs.last().unwrap());
    for name in ["msg1", "msg1:thinking", "tool1"] {
        let held = item(&d, name);
        let got = replay(&stream, name);
        for key in ["text", "summary", "output", "status"] {
            if !held[key].is_null() && name != "msg1" { assert_eq!(got[key], held[key], "{name}.{key}"); }
        }
    }
}
