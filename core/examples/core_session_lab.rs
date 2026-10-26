#[cfg(all(target_os = "linux", target_env = "gnu"))]
mod supported {
    // T-140 session store A/B lab: the same synthetic Codex workload on any
    // Core build, with a scripted app-server only. No Core connection, user
    // record, native Agent or model. Built the same on both sides.
    //
    //   core_session_lab <out dir> <agents> <turns per agent> <payload KiB> <rounds>
    //
    // It seeds the store by running itself as `seed` first, so the measured
    // process holds nothing of writing the history.
    //
    // Each Agent starts with `turns` stored Turns of ITEMS command Items, each
    // with `payload` KiB of output (a payload row above 8 KiB), a user and an
    // agent message; every Turn's completion is journaled, as live Turns
    // leave it. Two hold the same bytes otherwise: lab-0 all its Items in one
    // long Turn, lab-1 all its output in one Item. In the busy rounds lab-1's
    // first command streams 32 MiB. Phases, in order: the Workspace opens (a restart), every Agent
    // reconnects at once, `rounds` rounds in which BUSY Agents each run a
    // streamed Turn at once (deltas, Items, completion; the first one asks an
    // approval, answered here) while their client windows are read, a second
    // reconnect while connected, and a quiet tail of QUIET seconds. A sampler
    // reads VmRSS every SAMPLE ms into a buffer reserved before the run.
    use anyhow::{Context, Result};
    use serde_json::{json, Value};
    use std::{
        os::unix::fs::PermissionsExt,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed},
            Arc, Mutex,
        },
        time::{Duration, Instant},
    };
    use yuzuno_workspace::{model::AgentDetail, store::Store, workspace::Workspace};

    const ITEMS: usize = 40;
    const BUSY: usize = 3;
    const QUIET: u64 = 120;
    const SAMPLE: u64 = 50;
    const PHASES: [&str; 6] = ["open", "reconnect", "busy", "reconnect2", "quiet", "done"];

    static PHASE: AtomicUsize = AtomicUsize::new(0);
    static STOP: AtomicBool = AtomicBool::new(false);

    fn status_kib(proc: &str, key: &str) -> u64 {
        proc.lines().find_map(|s| s.strip_prefix(key)).and_then(|s| s.split_whitespace().next())
            .and_then(|s| s.parse().ok()).unwrap_or(0)
    }

    fn cpu_seconds() -> f64 {
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
        let t = |v: libc::timeval| v.tv_sec as f64 + v.tv_usec as f64 / 1e6;
        t(usage.ru_utime) + t(usage.ru_stime)
    }

    /// (milliseconds since start, VmRSS KiB, phase), into a buffer reserved
    /// up front: the sampler allocates nothing while it runs.
    fn sampler(start: Instant, samples: Arc<Mutex<Vec<(u64, u64, usize)>>>) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            while !STOP.load(Relaxed) {
                let rss = std::fs::File::open("/proc/self/status").ok().and_then(|mut f| {
                    use std::io::Read;
                    let n = f.read(&mut buffer).ok()?;
                    let text = std::str::from_utf8(&buffer[..n]).ok()?;
                    Some(status_kib(text, "VmRSS:"))
                }).unwrap_or(0);
                if let Ok(mut s) = samples.lock() {
                    if s.len() < s.capacity() {
                        s.push((start.elapsed().as_millis() as u64, rss, PHASE.load(Relaxed)));
                    }
                }
                std::thread::sleep(Duration::from_millis(SAMPLE));
            }
        })
    }

    fn turn(t: usize, kib: usize) -> Value {
        let output = format!("{}\n", "o".repeat(kib * 1024 - 1));
        let mut items = vec![json!({"id":format!("u-{t}"),"type":"userMessage","content":[{"type":"text","text":format!("synthetic request {t}")}]})];
        items.extend((0..ITEMS).map(|i| json!({"id":format!("c-{t}-{i}"),"type":"commandExecution","status":"completed",
            "command":"synthetic command","aggregatedOutput":output,"exitCode":0})));
        items.push(json!({"id":format!("m-{t}"),"type":"agentMessage","text":format!("synthetic answer {t}")}));
        json!({"id":format!("turn-{t}"),"status":"completed","items":items})
    }

    /// An Agent's history: `turns` Turns as `turn` makes them, or the same
    /// Items in one Turn (`lab-0`), or the same output in one Item (`lab-1`).
    fn history(index: usize, turns: usize, kib: usize) -> Vec<Value> {
        match index {
            0 => {
                let mut items = Vec::with_capacity(turns * (ITEMS + 2));
                for t in 0..turns {
                    items.extend(turn(t, kib)["items"].as_array().unwrap().iter().cloned());
                }
                vec![json!({"id":"turn-0","status":"completed","items":items})]
            }
            1 => {
                let output = format!("{}\n", "o".repeat(turns * ITEMS * kib * 1024 - 1));
                vec![json!({"id":"turn-0","status":"completed","items":[
                    json!({"id":"u-0","type":"userMessage","content":[{"type":"text","text":"synthetic request 0"}]}),
                    json!({"id":"c-0","type":"commandExecution","status":"completed","command":"synthetic command","aggregatedOutput":output,"exitCode":0}),
                    json!({"id":"m-0","type":"agentMessage","text":"synthetic answer 0"})]})]
            }
            _ => (0..turns).map(|t| turn(t, kib)).collect(),
        }
    }

    /// The bytes an Agent's record in memory holds, counted by walking it
    /// (strings by length), so measuring allocates and serializes nothing.
    fn held_bytes(d: &AgentDetail) -> usize {
        fn size(v: &Value) -> usize {
            match v {
                Value::String(s) => s.len(),
                Value::Array(a) => a.iter().map(size).sum::<usize>() + 8,
                Value::Object(o) => o.iter().map(|(k, v)| k.len() + size(v)).sum::<usize>() + 8,
                _ => 8,
            }
        }
        d.turns.iter().map(size).sum::<usize>() + d.pending.iter().map(|p| size(&p.params)).sum::<usize>()
            + d.message_receipts.iter().map(|r| r.input.text.len()).sum::<usize>()
    }

    fn record(id: &str, turns: Vec<Value>) -> Result<AgentDetail> {
        Ok(serde_json::from_value(json!({"agent":{"id":id,"name":id,"cwd":"/tmp","model":"m","color":"sage",
            "threadId":format!("thread-{id}"),"status":"idle","createdAt":"2026-10-26T00:00:00Z","updatedAt":"2026-10-26T00:00:00Z",
            "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":turns,"pending":[],"artifacts":[]}))?)
    }

    // Answers as Codex 0.162 does: thread/resume and thread/read with the
    // history (none with excludeTurns / includeTurns:false), thread/turns/list
    // pages newest first, turn/start runs a streamed Turn (the Agent whose
    // thread ends in -0 asks one command approval in it) and keeps it.
    const APP_SERVER: &str = r#"#!/usr/bin/python3
import json, os, sys, threading, time
root = os.path.dirname(os.path.abspath(__file__))
lock = threading.Lock()
history = {}
answers = {}
active = {}
asked = {}
sent = [0]
# Beside the run's report, not in its temporary directory, which goes with the run.
requests = open(os.path.join(os.path.dirname(root), 'requests-%d.jsonl' % os.getpid()), 'a', buffering=1)
def emit(v):
    line = json.dumps(v) + '\n'
    with lock:
        sys.stdout.write(line); sys.stdout.flush()
        sent[0] += len(line)
        if 'id' in v and 'method' not in v:
            m, view = asked.pop(v['id'], (None, None))
            requests.write(json.dumps({'m': m, 'view': view, 'b': len(line), 'total': sent[0]}) + '\n')
def note(method, **p): emit({'method':method,'params':p})
def turns_of(thread):
    if thread not in history:
        with open(os.path.join(root, 'history', thread + '.json')) as f: history[thread] = json.load(f)
    return history[thread]
def light(t): return {'id':t['id'],'status':t['status'],'items':[],'itemsView':'notLoaded'}
def run(thread, tid, n):
    kib = int(os.environ.get('LAB_DELTA_KIB', '4'))
    items, out = [], 'd' * (kib * 1024 - 1) + '\n'
    big = thread.endswith('-1')
    for i in range(int(os.environ.get('LAB_TURN_ITEMS', '10'))):
        iid = f'{tid}-c{i}'
        note('item/started', threadId=thread, turnId=tid, item={'id':iid,'type':'commandExecution','command':'synthetic','status':'inProgress'})
        if i == 2 and thread.endswith('-0'):
            rid = f'approval-{tid}'
            done = threading.Event(); answers[rid] = done
            emit({'id':rid,'method':'item/commandExecution/requestApproval','params':{'threadId':thread,'turnId':tid,'itemId':iid,
                'command':'synthetic','reason':'synthetic approval'}})
            done.wait(60)
            note('serverRequest/resolved', threadId=thread, requestId=rid)
        deltas = int(os.environ.get('LAB_DELTAS', '50'))
        # lab-1's first command streams 32 MiB.
        streams = big and i == 0
        if streams: deltas = (32 << 20) // len(out)
        for _ in range(deltas):
            note('item/commandExecution/outputDelta', threadId=thread, turnId=tid, itemId=iid, delta=out)
            if not streams: time.sleep(0.002)
        item = {'id':iid,'type':'commandExecution','command':'synthetic','status':'completed','aggregatedOutput':out * deltas,'exitCode':0}
        note('item/completed', threadId=thread, turnId=tid, item=item)
        items.append(item)
        note('thread/tokenUsage/updated', threadId=thread, turnId=tid, tokenUsage={'last':{'totalTokens':1000+i},'modelContextWindow':200000})
    mid = f'{tid}-m'
    note('item/started', threadId=thread, turnId=tid, item={'id':mid,'type':'agentMessage','text':''})
    text = ''
    for w in range(40):
        d = f'word{w} '; text += d
        note('item/agentMessage/delta', threadId=thread, turnId=tid, itemId=mid, delta=d)
        time.sleep(0.002)
    msg = {'id':mid,'type':'agentMessage','text':text}
    note('item/completed', threadId=thread, turnId=tid, item=msg)
    items.append(msg)
    done = {'id':tid,'status':'completed','error':None,'items':items}
    turns_of(thread).append(done)
    active.pop(thread, None)
    note('turn/completed', threadId=thread, turn={'id':tid,'status':'completed','error':None,'items':[]})
    with lock: requests.write(json.dumps({'m': '#turn', 'total': sent[0]}) + '\n')
count = [0]
for line in sys.stdin:
    r = json.loads(line)
    if 'id' in r and 'method' not in r:
        e = answers.pop(r['id'], None)
        if e: e.set()
        continue
    if 'id' not in r: continue
    m, p = r.get('method'), r.get('params', {})
    with lock: asked[r['id']] = (m, p.get('itemsView'))
    thread = p.get('threadId', 'thread')
    status = {'type':'active' if thread in active else 'idle'}
    if m == 'thread/resume':
        turns = [] if p.get('excludeTurns') else turns_of(thread)
        emit({'id':r['id'],'result':{'thread':{'id':thread,'status':status,'turns':turns},'model':'m'}}); continue
    if m == 'thread/read':
        turns = turns_of(thread) if p.get('includeTurns') else []
        emit({'id':r['id'],'result':{'thread':{'id':thread,'status':status,'turns':turns}}}); continue
    if m == 'thread/turns/list':
        all_turns = list(reversed(turns_of(thread)))
        start = int(p.get('cursor') or 0); limit = int(p.get('limit') or 25)
        page = all_turns[start:start+limit]
        if p.get('itemsView') == 'notLoaded': page = [light(t) for t in page]
        nxt = str(start+limit) if start + limit < len(all_turns) else None
        emit({'id':r['id'],'result':{'data':page,'nextCursor':nxt}}); continue
    if m == 'turn/start':
        count[0] += 1
        tid = f'live-{os.getpid()}-{count[0]}'
        active[thread] = tid
        t = {'id':tid,'status':'inProgress','error':None,'items':[]}
        emit({'id':r['id'],'result':{'turn':t}})
        note('turn/started', threadId=thread, turn=t)
        threading.Thread(target=run, args=(thread, tid, count[0]), daemon=True).start(); continue
    result = {}
    if m == 'model/list':
        result = {'data':[{'id':'m','model':'m','defaultReasoningEffort':'low','supportedReasoningEfforts':[{'reasoningEffort':'low'}]}],'nextCursor':None}
    elif m == 'config/read':
        result = {'config':{}}
    emit({'id':r['id'],'result':result})
"#;

    /// What differs by run, as the window comparison leaves it out: times,
    /// revs, journal sequence numbers.
    const VOLATILE: [&str; 17] = ["rev", "lastSeq", "reviewedSeq", "updatedAt", "createdAt", "at", "startedAt", "completedAt",
        "_yuzunoTime", "connectedAt", "lastEventAt", "lastActivityAt", "checkedAt", "durationMs", "_yuzunoStartedAt",
        "_yuzunoCompletedAt", "_yuzunoCompactionStartedAt"];

    /// `text` with the app-server's pid in live Turn IDs (`live-<pid>-`) left out.
    fn without_pid(text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(at) = rest.find("live-") {
            out.push_str(&rest[..at + 5]);
            rest = &rest[at + 5..];
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            if digits > 0 && rest[digits..].starts_with('-') {
                out.push_str("PID");
                rest = &rest[digits..];
            }
        }
        out.push_str(rest);
        out
    }

    fn normal(value: &Value) -> Value {
        match value {
            Value::Object(fields) => Value::Object(fields.iter().filter(|(k, _)| !VOLATILE.contains(&k.as_str()))
                .map(|(k, v)| (without_pid(k), normal(v))).collect()),
            Value::Array(values) => Value::Array(values.iter().map(normal).collect()),
            Value::String(text) => Value::String(without_pid(text)),
            other => other.clone(),
        }
    }

    fn hash(value: &Value) -> String {
        use sha2::Digest;
        let digest = sha2::Sha256::digest(serde_json::to_vec(&normal(value)).unwrap_or_default());
        digest.iter().take(12).map(|b| format!("{b:02x}")).collect()
    }

    /// A Turn's fields but its Items (`_turn`), and each Item's fields, each
    /// as a hash of its normal form.
    fn field_hashes(turn: &Value) -> Value {
        let mut shell = turn.clone();
        let items = shell.as_object_mut().and_then(|t| t.remove("items")).unwrap_or(Value::Null);
        let mut out = serde_json::Map::new();
        out.insert("_turn".into(), Value::String(hash(&shell)));
        for item in items.as_array().into_iter().flatten() {
            let id = without_pid(item["id"].as_str().unwrap_or_default());
            let fields: serde_json::Map<String, Value> = item.as_object().into_iter().flatten()
                .filter(|(k, _)| !VOLATILE.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), Value::String(hash(v)))).collect();
            out.insert(id, Value::Object(fields));
        }
        Value::Object(out)
    }

    fn percentile(values: &mut [f64], p: f64) -> f64 {
        if values.is_empty() { return 0.0; }
        values.sort_by(|a, b| a.partial_cmp(b).unwrap());
        values[((values.len() - 1) as f64 * p).round() as usize]
    }

    async fn wait_idle(ws: &Arc<Workspace>, id: &str, deadline: Duration) -> Result<()> {
        let until = Instant::now() + deadline;
        loop {
            let (store, agent) = (ws.store.clone(), id.to_owned());
            let a = tokio::task::spawn_blocking(move || store.agent(&agent)).await??;
            if a.status == "idle" { return Ok(()); }
            if Instant::now() >= until {
                let held = ws.store.held_agents().into_iter().map(|h| format!("{}{}", h.id, if h.unwritten { "*" } else { "" }))
                    .collect::<Vec<_>>().join(",");
                anyhow::bail!("Agent {id} did not finish its Turn: {} (connection {}, held {held}, backlog {})", a.status,
                    a.connection_state, ws.backlog()["agents"][id]);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// `seed <dir> <agents> <turns> <payload KiB>`: the stored Agents, their
    /// native histories for the app-server, and each Turn's journaled
    /// completion, as live Turns leave it.
    fn seed(mut args: impl Iterator<Item = String>) -> Result<()> {
        let dir = std::path::PathBuf::from(args.next().context("dir")?);
        let agents: usize = args.next().context("agents")?.parse()?;
        let turns: usize = args.next().context("turns per agent")?.parse()?;
        let kib: usize = args.next().context("payload KiB")?.parse()?;
        let data = dir.join("data");
        std::fs::create_dir_all(&data)?;
        std::fs::create_dir_all(dir.join("history"))?;
        let ids: Vec<String> = (0..agents).map(|n| format!("lab-{n}")).collect();
        {
            let store = Store::open(&data.join("workspace.sqlite"))?;
            for (n, id) in ids.iter().enumerate() {
                let history = history(n, turns, kib);
                std::fs::write(dir.join("history").join(format!("thread-{id}.json")), serde_json::to_vec(&history)?)?;
                store.insert(&record(id, history)?)?;
            }
        }
        let db = rusqlite::Connection::open(data.join("workspace.sqlite"))?;
        let tx = db.unchecked_transaction()?;
        for (n, id) in ids.iter().enumerate() {
            for t in 0..if n < 2 { 1 } else { turns } {
                tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,'turn/completed',?2,'2026-10-26T00:00:00Z')",
                    rusqlite::params![id, json!({"turn":{"id":format!("turn-{t}"),"status":"completed"}}).to_string()])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    async fn experiment() -> Result<()> {
        let mut args = std::env::args().skip(1);
        let out = std::path::PathBuf::from(args.next().context("out dir")?);
        let agents: usize = args.next().context("agents")?.parse()?;
        let turns: usize = args.next().context("turns per agent")?.parse()?;
        let kib: usize = args.next().context("payload KiB")?.parse()?;
        let rounds: usize = args.next().context("rounds")?.parse()?;
        std::fs::create_dir_all(&out)?;
        let dir = tempfile::tempdir_in(&out)?;
        let data = dir.path().join("data");
        let ids: Vec<String> = (0..agents).map(|n| format!("lab-{n}")).collect();
        // Seeded by another process, so what writing the history allocated
        // is not in this one.
        let seeded = std::process::Command::new(std::env::current_exe()?)
            .args(["seed".into(), dir.path().to_string_lossy().into_owned(), agents.to_string(), turns.to_string(), kib.to_string()])
            .status()?;
        anyhow::ensure!(seeded.success(), "seeding failed: {seeded}");
        let script = dir.path().join("codex.py");
        std::fs::write(&script, APP_SERVER)?;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
        let proc = std::fs::read_to_string("/proc/self/status")?;
        let seeded_rss = status_kib(&proc, "VmRSS:");

        let start = Instant::now();
        let start_epoch_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as u64;
        let samples = Arc::new(Mutex::new(Vec::with_capacity(200_000)));
        let sampling = sampler(start, samples.clone());
        let mut phases = vec![];
        let mut mark = |name: &str, cpu: f64, at: Instant| {
            let ms = at.duration_since(start).as_millis() as u64;
            eprintln!("lab: phase {name} at {ms} ms");
            phases.push(json!({"phase":name,"startMs":ms,"cpuSecondsAtStart":cpu}));
        };

        PHASE.store(0, Relaxed);
        mark("open", cpu_seconds(), Instant::now());
        let ws = Workspace::new(data.clone(), "/tmp".into(), script.to_string_lossy().into_owned())?;
        // What each Agent's record in memory holds, every 250 ms: the most of
        // each and of all together.
        let held = Arc::new(Mutex::new((std::collections::BTreeMap::<String, usize>::new(), 0usize)));
        let holding = {
            let (store, held) = (ws.store.clone(), held.clone());
            tokio::spawn(async move {
                while !STOP.load(Relaxed) {
                    let mut total = 0;
                    let mut each = Vec::new();
                    for h in store.held_agents() {
                        if let Some(bytes) = store.peek(&h.id, held_bytes) {
                            total += bytes;
                            each.push((h.id, bytes));
                        }
                    }
                    {
                        let mut max = held.lock().unwrap();
                        for (id, bytes) in each {
                            let most = max.0.entry(id).or_default();
                            *most = (*most).max(bytes);
                        }
                        max.1 = max.1.max(total);
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            })
        };

        PHASE.store(1, Relaxed);
        mark("reconnect", cpu_seconds(), Instant::now());
        let mut reconnect_ms = vec![];
        let started: Vec<_> = ids.iter().map(|id| {
            let (ws, id) = (ws.clone(), id.clone());
            tokio::spawn(async move {
                let at = Instant::now();
                ws.reconnect(&id).await.map(|_| at.elapsed().as_secs_f64() * 1000.0)
            })
        }).collect();
        for done in futures_util::future::join_all(started).await { reconnect_ms.push(done??); }

        PHASE.store(2, Relaxed);
        mark("busy", cpu_seconds(), Instant::now());
        let (mut send_ms, mut turn_ms, mut respond_ms, mut window_ms) = (vec![], vec![], vec![], vec![]);
        let mut turn_detail = vec![];
        let mut busy_turns: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        let busy: Vec<String> = ids.iter().take(BUSY.min(agents)).cloned().collect();
        let window_bytes = Arc::new(AtomicUsize::new(0));
        for round in 0..rounds {
            let running = Arc::new(AtomicBool::new(true));
            // A client reading each busy Agent's window twice a second.
            let readers: Vec<_> = busy.iter().map(|id| {
                let (store, id, running, bytes) = (ws.store.clone(), id.clone(), running.clone(), window_bytes.clone());
                tokio::spawn(async move {
                    let mut times = vec![];
                    while running.load(Relaxed) {
                        let (store, id) = (store.clone(), id.clone());
                        let at = Instant::now();
                        let read = tokio::task::spawn_blocking(move || -> Result<usize> {
                            let query = yuzuno_workspace::conversation_window::Query { view: Some("window".into()), ..Default::default() };
                            let window = store.client_window(&id, &query)?.map_err(|_| anyhow::anyhow!("no window"))?;
                            Ok(serde_json::to_vec(&json!({"detail":window.detail,"conversation":window.conversation}))?.len())
                        }).await;
                        if let Ok(Ok(n)) = read { bytes.fetch_add(n, Relaxed); times.push(at.elapsed().as_secs_f64() * 1000.0); }
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                    times
                })
            }).collect();
            let sends: Vec<_> = busy.iter().map(|id| {
                let (ws, id) = (ws.clone(), id.clone());
                tokio::spawn(async move {
                    let at = Instant::now();
                    let reply = ws.send(&id, "synthetic turn".into()).await?;
                    let sent = at.elapsed().as_secs_f64() * 1000.0;
                    let turn = reply["turnId"].as_str().unwrap_or_default().to_owned();
                    let mut respond = None;
                    // The first Agent's Turn asks an approval: answered once it shows.
                    if id.ends_with("-0") {
                        let until = Instant::now() + Duration::from_secs(60);
                        loop {
                            let (store, agent) = (ws.store.clone(), id.clone());
                            let pending = tokio::task::spawn_blocking(move || store.pending(&agent)).await??;
                            if let Some(p) = pending.into_iter().find(|p| !p.stale) {
                                let answered = Instant::now();
                                ws.respond(&p.id, json!({"decision":"accept"})).await?;
                                respond = Some(answered.elapsed().as_secs_f64() * 1000.0);
                                break;
                            }
                            anyhow::ensure!(Instant::now() < until, "no approval asked");
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                    }
                    wait_idle(&ws, &id, Duration::from_secs(180)).await?;
                    Ok::<_, anyhow::Error>((id, turn, sent, at.elapsed().as_secs_f64() * 1000.0, respond))
                })
            }).collect();
            for done in futures_util::future::join_all(sends).await {
                let (id, turn, sent, whole, respond) = done??;
                turn_detail.push(json!({"agent":id,"round":round,"sendMs":sent,"turnMs":whole}));
                busy_turns.entry(id.clone()).or_default().push(turn);
                send_ms.push(sent);
                turn_ms.push(whole);
                respond_ms.extend(respond);
            }
            running.store(false, Relaxed);
            for done in futures_util::future::join_all(readers).await { window_ms.extend(done?); }
        }

        PHASE.store(3, Relaxed);
        mark("reconnect2", cpu_seconds(), Instant::now());
        let mut reconnect2_ms = vec![];
        for id in &ids {
            let at = Instant::now();
            ws.reconnect(id).await?;
            reconnect2_ms.push(at.elapsed().as_secs_f64() * 1000.0);
        }

        PHASE.store(4, Relaxed);
        mark("quiet", cpu_seconds(), Instant::now());
        tokio::time::sleep(Duration::from_secs(QUIET)).await;

        PHASE.store(5, Relaxed);
        mark("done", cpu_seconds(), Instant::now());
        // The final windows, kept for comparing builds (times differ).
        for id in &ids {
            let (store, agent) = (ws.store.clone(), id.clone());
            let window = tokio::task::spawn_blocking(move || -> Result<Value> {
                let query = yuzuno_workspace::conversation_window::Query { view: Some("window".into()), ..Default::default() };
                let window = store.client_window(&agent, &query)?.map_err(|_| anyhow::anyhow!("no window"))?;
                Ok(json!({"detail":window.detail,"conversation":window.conversation}))
            }).await??;
            std::fs::write(out.join(format!("window-{id}.json")), serde_json::to_vec_pretty(&window)?)?;
        }
        STOP.store(true, Relaxed);
        let _ = sampling.join();
        let _ = holding.await;
        let (held_max, held_total_max) = held.lock().unwrap().clone();
        let proc = std::fs::read_to_string("/proc/self/status")?;
        let samples = samples.lock().unwrap().clone();
        // Time-weighted RSS per phase: each sample stands for SAMPLE ms.
        let summary: Vec<Value> = PHASES.iter().enumerate().map(|(n, name)| {
            let of: Vec<u64> = samples.iter().filter(|s| s.2 == n).map(|s| s.1).collect();
            let mean = if of.is_empty() { 0.0 } else { of.iter().sum::<u64>() as f64 / of.len() as f64 / 1024.0 };
            json!({"phase":name,"samples":of.len(),"meanRssMiB":mean,"maxRssMiB":of.iter().max().copied().unwrap_or(0) as f64 / 1024.0,
                "lastRssMiB":of.last().copied().unwrap_or(0) as f64 / 1024.0})
        }).collect();
        let quiet: Vec<u64> = samples.iter().filter(|s| s.2 == 4).map(|s| s.1).collect();
        let before_trim = quiet.iter().take((55_000 / SAMPLE) as usize).copied().collect::<Vec<_>>();
        let report = json!({
            "synthetic":true,"startEpochMs":start_epoch_ms,"agents":agents,"turnsPerAgent":turns,"itemsPerTurn":ITEMS,"payloadKiB":kib,"rounds":rounds,"busyAgents":busy.len(),
            "seededRssMiB":seeded_rss as f64 / 1024.0,
            "vmHwmMiB":status_kib(&proc, "VmHWM:") as f64 / 1024.0,"finalRssMiB":status_kib(&proc, "VmRSS:") as f64 / 1024.0,
            "cpuSeconds":cpu_seconds(),"phases":phases,"rss":summary,
            "quietBeforeTrimMeanMiB": if before_trim.is_empty() { 0.0 } else { before_trim.iter().sum::<u64>() as f64 / before_trim.len() as f64 / 1024.0 },
            "latencyMs":{
                "reconnectP50":percentile(&mut reconnect_ms.clone(), 0.5),"reconnectP95":percentile(&mut reconnect_ms, 0.95),
                "reconnect2P95":percentile(&mut reconnect2_ms, 0.95),
                "sendP50":percentile(&mut send_ms.clone(), 0.5),"sendP95":percentile(&mut send_ms, 0.95),
                "turnP95":percentile(&mut turn_ms, 0.95),"respondP95":percentile(&mut respond_ms, 0.95),
                "windowP50":percentile(&mut window_ms.clone(), 0.5),"windowP95":percentile(&mut window_ms, 0.95)},
            "turns":turn_detail,
            "windowReadBytes":window_bytes.load(Relaxed),
            "heldMaxBytes":held_max,"heldMaxTotalBytes":held_total_max,
            "samples":samples.iter().map(|s| [s.0, s.1, s.2 as u64]).collect::<Vec<_>>(),
            "notes":["No user database, Core connection, native Agent or model","glibc arena maximum 2, as Core's main sets",
                "History seeded by a child process; seededRssMiB is this process before the Workspace opens",
                "lab-0 holds its history in one long Turn and lab-1 in one Item, of the same bytes; lab-1's first busy command streams 32 MiB",
                "heldMaxBytes: the most each Agent's record in memory held (a walk of its strings by length, every 250 ms)",
                "VmRSS sampled every 50 ms by a thread that allocates nothing while it runs","quietBeforeTrimMeanMiB: the first 55 s of the quiet tail, before Core's 60 s idle trim"]});
        std::fs::write(out.join("report.json"), serde_json::to_vec_pretty(&report)?)?;
        // Every Turn read whole with its payloads, after the last sample
        // (outside every measured phase), one at a time: a hash of each
        // Item's every field, as both sides compare them.
        let mut payloads = serde_json::Map::new();
        for (n, id) in ids.iter().enumerate() {
            let mut names: Vec<String> = (0..if n < 2 { 1 } else { turns }).map(|t| format!("turn-{t}")).collect();
            names.extend(busy_turns.get(id).cloned().unwrap_or_default());
            let mut of = serde_json::Map::new();
            for tid in names {
                let read = ws.store.payload_view(id, Some(&tid), None, |d| d.turns.iter().find(|t| t["id"] == tid.as_str()).cloned())?;
                of.insert(without_pid(&tid), match read.flatten() {
                    Some(turn) => field_hashes(&turn),
                    None => json!({"missing": true}),
                });
            }
            payloads.insert(id.clone(), Value::Object(of));
        }
        std::fs::write(out.join("payloads.json"), serde_json::to_vec(&Value::Object(payloads))?)?;
        drop(ws);
        Ok(())
    }

    pub fn run() -> Result<()> {
        // As Core's main sets before any other thread exists.
        unsafe { libc::mallopt(libc::M_ARENA_MAX, 2); }
        let mut args = std::env::args().skip(1).peekable();
        if args.peek().map(String::as_str) == Some("seed") {
            return seed(args.skip(1));
        }
        let result = tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(experiment());
        if let Err(error) = &result {
            eprintln!("lab failed: {error:#}");
        }
        // Never waits for the runtime to wind down: after an error a Workspace
        // left mid-operation may not finish dropping.
        std::process::exit(i32::from(result.is_err()))
    }
}

fn main() -> anyhow::Result<()> {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        supported::run()
    }
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    {
        anyhow::bail!("This experiment measures the Linux/glibc allocator")
    }
}
