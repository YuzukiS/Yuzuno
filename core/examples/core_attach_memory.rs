#[cfg(all(target_os = "linux", target_env = "gnu"))]
mod supported {
    // Isolated T-140 diagnosis of a Codex Agent's reconnect after a Core
    // restart, using a synthetic history and a scripted app-server only.
    // Does not connect to a Core, load user records, or run a model.
    //
    //   core_attach_memory <report.json> <payload KiB per Item> <agents>
    //
    // Each Agent has 100 Turns of 80 commandExecution Items, every Item with
    // the same synthetic output; the scripted app-server answers
    // thread/resume with that same history, as Codex does for a thread whose
    // record Core already has, and as after live Turns, each Turn's
    // turn/completed is in the journal. Phases, in this order: the Workspace reopens
    // (Store::open marks each open Agent restarted), the Agents reconnect
    // (at once), their records go idle, a
    // doorbell metadata write and a native turn/completed reach each idle
    // record, a second turn/completed reaches it held, and a second
    // reconnect finds it connected. Then, for the reconnect the UI asks for
    // (POST /api/agents/{id}/reconnect), its parts once each on an idle
    // record: the record read it returns, the handler turning that record
    // into a JSON tree and bytes, and the whole request through the router:
    // as the UI sent it before (no view) and as it sends it now
    // (view=summary, which a Core from before it ignores).
    use anyhow::{Context, Result};
    use serde_json::{json, Value};
    use std::{
        alloc::{GlobalAlloc, Layout, System},
        cell::Cell,
        collections::HashMap,
        os::unix::fs::PermissionsExt,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed},
            Mutex,
        },
        time::{Duration, Instant},
    };
    use yuzuno_workspace::{model::AgentDetail, store::Store, workspace::Workspace};
    struct Counting;
    static LIVE: AtomicUsize = AtomicUsize::new(0);
    static PEAK: AtomicUsize = AtomicUsize::new(0);
    static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
    // With YUZUNO_ALLOC_SITES=1, one backtrace per 8 MiB allocated during a
    // sampled phase, grouped by where in core/src it was made.
    static SITES_ON: AtomicBool = AtomicBool::new(false);
    static SITE_BYTES: AtomicUsize = AtomicUsize::new(0);
    const SITE_EVERY: usize = 8 << 20;
    static SITES: Mutex<Option<HashMap<String, usize>>> = Mutex::new(None);
    thread_local! { static IN_SITE: Cell<bool> = const { Cell::new(false) }; }
    fn site(size: usize) {
        if !SITES_ON.load(Relaxed) {
            return;
        }
        let before = SITE_BYTES.fetch_add(size, Relaxed);
        if (before + size) / SITE_EVERY == before / SITE_EVERY {
            return;
        }
        let _ = IN_SITE.try_with(|guard| {
            if guard.replace(true) {
                return;
            }
            // Grouped by the first source lines in this crate's src/, which
            // name the caller even where inlined frames print without paths.
            let text = format!("{}", std::backtrace::Backtrace::force_capture());
            let frames: Vec<&str> = text
                .lines()
                .map(str::trim)
                .filter_map(|l| l.strip_prefix("at "))
                .filter_map(|l| l.find("/core/src/").map(|at| &l[at + 1..]))
                .take(8)
                .collect();
            let key = frames.join("  <-  ");
            *SITES.lock().unwrap().get_or_insert_with(HashMap::new).entry(key).or_insert(0) += 1;
            guard.set(false);
        });
    }
    fn sites(label: &str) -> Value {
        let mut all: Vec<(String, usize)> = SITES.lock().unwrap().take().unwrap_or_default().into_iter().collect();
        all.sort_by(|a, b| b.1.cmp(&a.1));
        let total: usize = all.iter().map(|s| s.1).sum();
        json!({"phase":label,"sampleEveryBytes":SITE_EVERY,"samples":total,
            "sites":all.into_iter().take(30).map(|(frames, n)| json!({"samples":n,"estimatedBytes":n * SITE_EVERY,"frames":frames})).collect::<Vec<_>>()})
    }
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let p = System.alloc(layout);
            if !p.is_null() {
                site(layout.size());
                ALLOCATED.fetch_add(layout.size(), Relaxed);
                let n = LIVE.fetch_add(layout.size(), Relaxed) + layout.size();
                PEAK.fetch_max(n, Relaxed);
            }
            p
        }
        unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
            System.dealloc(p, layout);
            LIVE.fetch_sub(layout.size(), Relaxed);
        }
        unsafe fn realloc(&self, p: *mut u8, old: Layout, size: usize) -> *mut u8 {
            let next = System.realloc(p, old, size);
            if !next.is_null() {
                site(size.saturating_sub(old.size()));
                ALLOCATED.fetch_add(size.saturating_sub(old.size()), Relaxed);
                if size >= old.size() {
                    let n = LIVE.fetch_add(size - old.size(), Relaxed) + size - old.size();
                    PEAK.fetch_max(n, Relaxed);
                } else {
                    LIVE.fetch_sub(old.size() - size, Relaxed);
                }
            }
            next
        }
    }
    #[global_allocator]
    static ALLOC: Counting = Counting;

    const TURNS: usize = 100;
    const ITEMS: usize = 80;

    fn cpu_seconds() -> f64 {
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
        let t = |v: libc::timeval| v.tv_sec as f64 + v.tv_usec as f64 / 1e6;
        t(usage.ru_utime) + t(usage.ru_stime)
    }
    fn sample(label: &str, store: &Store) -> Value {
        let proc = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        let kb = |key: &str| -> u64 {
            proc.lines()
                .find_map(|s| s.strip_prefix(key))
                .and_then(|s| s.split_whitespace().next())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0)
        };
        // mallinfo2 sums every arena (in use, free) plus mmapped chunks.
        let heap = unsafe { libc::mallinfo2() };
        let sqlite = unsafe { rusqlite::ffi::sqlite3_memory_used() };
        let v = json!({"phase":label,"rustLiveBytes":LIVE.load(Relaxed),"rssKiB":kb("VmRSS:"),"peakRssKiB":kb("VmHWM:"),
            "held":store.streamed_records(),
            "glibc":{"arenaBytes":heap.arena,"inUseArenaBytes":heap.uordblks,"freeArenaBytes":heap.fordblks,
                "mmappedBytes":heap.hblkhd,"mmappedChunks":heap.hblks,"topReleasableBytes":heap.keepcost},
            "sqliteMemoryUsedBytes":sqlite});
        println!("{}", v);
        v
    }
    async fn measured<F: std::future::Future<Output = Result<()>>>(label: &str, store: &Store, action: F) -> Result<Value> {
        let live_before = LIVE.load(Relaxed);
        let allocated_before = ALLOCATED.load(Relaxed);
        PEAK.store(live_before, Relaxed);
        let cpu = cpu_seconds();
        let start = Instant::now();
        action.await?;
        let elapsed = start.elapsed().as_micros();
        let cpu = cpu_seconds() - cpu;
        let peak = PEAK.load(Relaxed);
        let mut point = sample(label, store);
        point["operation"] = json!({"elapsedMicros":elapsed,"processCpuSeconds":cpu,"liveBeforeBytes":live_before,
            "liveAfterBytes":LIVE.load(Relaxed),"peakLiveBytes":peak,"peakAddedBytes":peak.saturating_sub(live_before),
            "allocatedBytes":ALLOCATED.load(Relaxed) - allocated_before});
        Ok(point)
    }
    fn trim_fixture_only() {
        unsafe {
            libc::malloc_trim(0);
        }
    }

    fn turns(payload: usize) -> Value {
        let output = "x".repeat(payload);
        (0..TURNS)
            .map(|t| {
                let items: Vec<Value> = (0..ITEMS)
                    .map(|i| json!({"id":format!("item-{t}-{i}"),"type":"commandExecution","status":"completed",
                        "command":"synthetic output only","aggregatedOutput":output,"exitCode":0}))
                    .collect();
                json!({"id":format!("turn-{t}"),"status":"completed","items":items})
            })
            .collect::<Vec<_>>()
            .into()
    }
    fn record(id: &str, turns: &Value) -> Result<AgentDetail> {
        Ok(serde_json::from_value(json!({"agent":{"id":id,"name":id,"cwd":"/tmp","model":"m","color":"sage",
            "threadId":format!("thread-{id}"),"status":"idle","createdAt":"2026-10-21T00:00:00Z","updatedAt":"2026-10-21T00:00:00Z",
            "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":turns,"pending":[],"artifacts":[]}))?)
    }
    // Answers thread/resume with the history file it was given, written
    // through as text; records each call's method and reply size.
    const APP_SERVER: &str = r#"#!/usr/bin/python3
import json, os, sys
root = os.path.dirname(os.path.abspath(__file__))
def log(method, size):
    with open(os.path.join(root, 'calls.jsonl'), 'a') as f: f.write(json.dumps({'method':method,'replyBytes':size,'pid':os.getpid()}) + '\n')
for line in sys.stdin:
    r = json.loads(line)
    if 'id' not in r: continue
    m, p = r.get('method'), r.get('params', {})
    if m in ['thread/resume', 'thread/read']:
        thread = p.get('threadId', 'thread')
        with open(os.path.join(root, 'history.json')) as f: turns = f.read()
        out = '{"id":%s,"result":{"thread":{"id":%s,"status":{"type":"idle"},"turns":%s},"model":"m"}}\n' % (json.dumps(r['id']), json.dumps(thread), turns)
        sys.stdout.write(out); sys.stdout.flush(); log(m, len(out)); continue
    result = {}
    if m == 'model/list':
        result = {'data':[{'id':'m','model':'m','defaultReasoningEffort':'low','supportedReasoningEfforts':[{'reasoningEffort':'low'}]}],'nextCursor':None}
    elif m == 'config/read':
        result = {'config':{}}
    out = json.dumps({'id':r['id'],'result':result})
    print(out, flush=True); log(m, len(out))
"#;

    async fn idle(ws: &Workspace) -> Result<()> {
        // Controlled cache-expiry interval (STREAM_IDLE is 5 s), not a poll.
        tokio::time::sleep(Duration::from_millis(5_500)).await;
        let store = ws.store.clone();
        let tick = tokio::task::spawn_blocking(move || store.stream_tick(Duration::ZERO)).await?;
        anyhow::ensure!(tick.failed.is_empty(), "tick failed");
        Ok(())
    }

    async fn experiment() -> Result<()> {
        let output = std::path::PathBuf::from(std::env::args().nth(1).context("report path")?);
        let kib: usize = std::env::args().nth(2).context("payload KiB per Item")?.parse()?;
        anyhow::ensure!((1..=32).contains(&kib), "payload must be 1..32 KiB per Item");
        let agents: usize = std::env::args().nth(3).context("agents")?.parse()?;
        anyhow::ensure!((1..=8).contains(&agents), "agents must be 1..8");
        let ids: Vec<String> = (0..agents).map(|n| format!("fixture-{n}")).collect();
        let dir = tempfile::tempdir()?;
        let data = dir.path().join("data");
        let history = turns(kib * 1024);
        std::fs::write(dir.path().join("history.json"), serde_json::to_vec(&history)?)?;
        let history_bytes = std::fs::metadata(dir.path().join("history.json"))?.len();
        {
            std::fs::create_dir_all(&data)?;
            let store = Store::open(&data.join("workspace.sqlite"))?;
            // As a live Turn leaves it: each Turn's turn/completed is in the
            // journal (written while the record is still small), then its Items.
            let skeleton: Value = (0..TURNS)
                .map(|t| json!({"id":format!("turn-{t}"),"status":"inProgress","items":[]}))
                .collect::<Vec<_>>()
                .into();
            for id in &ids {
                store.insert(&record(id, &skeleton)?)?;
                for t in 0..TURNS {
                    let event = json!({"threadId":format!("thread-{id}"),"turn":{"id":format!("turn-{t}"),"status":"completed","items":[]}});
                    store.record_event(id, "turn/completed", &event, |d| d.apply("turn/completed", &event))?;
                }
                let full = history.as_array().context("history")?.clone();
                store.record_event(id, "fixture/history", &json!({}), move |d| d.turns = full)?;
            }
        }
        drop(history);
        let script = dir.path().join("codex.py");
        std::fs::write(&script, APP_SERVER)?;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
        // The Workspace opens the seeded records as after a Core restart:
        // Store::open marks every open Agent restarted.
        trim_fixture_only();
        let sampling = std::env::var_os("YUZUNO_ALLOC_SITES").is_some_and(|v| v == "1");
        let mut allocation_sites = vec![];
        let seeded = Store::open(&dir.path().join("empty.sqlite"))?;
        let mut samples = vec![sample("seeded_after_diagnostic_trim", &seeded)];
        drop(seeded);
        let mut opened = None;
        SITES_ON.store(sampling, Relaxed);
        let program = script.to_string_lossy().into_owned();
        samples.push(measured("workspace_open_after_restart", &Store::open(&dir.path().join("empty.sqlite"))?, async {
            opened = Some(Workspace::new(data, "/tmp".into(), program)?);
            Ok(())
        }).await?);
        SITES_ON.store(false, Relaxed);
        // Its store is only a stand-in for the sample; "opened" counts held records.
        samples.last_mut().context("sample")?["held"] = Value::Null;
        if sampling { allocation_sites.push(sites("workspace_open_after_restart")); }
        let ws = opened.context("workspace")?;
        samples.push(sample("opened", &ws.store));
        idle(&ws).await?;
        samples.push(sample("opened_idle", &ws.store));

        let reconnects = ids.iter().map(|id| {
            let (ws, id) = (ws.clone(), id.clone());
            tokio::spawn(async move { ws.reconnect(&id).await.map(drop) })
        });
        SITES_ON.store(sampling, Relaxed);
        samples.push(measured("reconnect_after_restart", &ws.store, async {
            for done in futures_util::future::join_all(reconnects).await { done??; }
            Ok(())
        }).await?);
        SITES_ON.store(false, Relaxed);
        if sampling { allocation_sites.push(sites("reconnect_after_restart")); }
        idle(&ws).await?;
        samples.push(sample("after_reconnect_idle", &ws.store));

        samples.push(measured("idle_doorbell_metadata_write", &ws.store, async {
            for id in &ids {
                let (store, id) = (ws.store.clone(), id.clone());
                tokio::task::spawn_blocking(move || store.update_meta(&id, "peer/doorbell", &json!({"throughSeq":1}), |_| {})).await??;
            }
            Ok(())
        }).await?);
        idle(&ws).await?;
        let completed = |turn: &str| json!({"turn":{"id":turn,"status":"completed","items":[]}});
        samples.push(measured("idle_native_turn_completed", &ws.store, async {
            for id in &ids {
                let (store, id, event) = (ws.store.clone(), id.clone(), completed("turn-0"));
                tokio::task::spawn_blocking(move || store.record_event(&id, "turn/completed", &event, |d| d.apply("turn/completed", &event))).await??;
            }
            Ok(())
        }).await?);
        samples.push(measured("held_native_turn_completed", &ws.store, async {
            for id in &ids {
                let (store, id, event) = (ws.store.clone(), id.clone(), completed("turn-1"));
                tokio::task::spawn_blocking(move || store.record_event(&id, "turn/completed", &event, |d| d.apply("turn/completed", &event))).await??;
            }
            Ok(())
        }).await?);
        idle(&ws).await?;
        SITES_ON.store(sampling, Relaxed);
        samples.push(measured("reconnect_while_connected", &ws.store, async {
            for id in &ids { ws.reconnect(id).await?; }
            Ok(())
        }).await?);
        SITES_ON.store(false, Relaxed);
        if sampling { allocation_sites.push(sites("reconnect_while_connected")); }
        idle(&ws).await?;
        samples.push(measured("detail_read_after_reconnect", &ws.store, async {
            for id in &ids {
                let (store, id) = (ws.store.clone(), id.clone());
                tokio::task::spawn_blocking(move || store.detail(&id).map(drop)).await??;
            }
            Ok(())
        }).await?);
        idle(&ws).await?;
        let read: Vec<AgentDetail> = ids.iter().map(|id| ws.store.detail(id)).collect::<Result<_>>()?;
        let mut body_bytes = 0;
        samples.push(measured("http_body_from_detail", &ws.store, async {
            // As the handler does: the record as a JSON tree, then as bytes.
            for d in &read { body_bytes += serde_json::to_vec(&serde_json::to_value(d)?)?.len(); }
            Ok(())
        }).await?);
        samples.last_mut().context("sample")?["bodyBytes"] = body_bytes.into();
        drop(read);
        idle(&ws).await?;
        let router = yuzuno_workspace::server::router_on_port(ws.clone(), dir.path().join("assets"), 4317);
        let reconnect = |id: &str, query: &str| -> Result<axum::http::Request<axum::body::Body>> {
            Ok(axum::http::Request::post(format!("/api/agents/{id}/reconnect{query}"))
                .header("host", "localhost:4317").header("x-yuzuno-client", "desktop")
                .header("content-type", "application/json").body(axum::body::Body::from("{}"))?)
        };
        let mut http = vec![];
        SITES_ON.store(sampling, Relaxed);
        samples.push(measured("reconnect_http_while_connected", &ws.store, async {
            use tower::ServiceExt;
            for id in &ids {
                let response = router.clone().oneshot(reconnect(id, "")?).await?;
                let status = response.status().as_u16();
                let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
                http.push(json!({"status":status,"bodyBytes":body.len()}));
            }
            Ok(())
        }).await?);
        SITES_ON.store(false, Relaxed);
        samples.last_mut().context("sample")?["responses"] = http.into();
        if sampling { allocation_sites.push(sites("reconnect_http_while_connected")); }
        idle(&ws).await?;
        let mut answers = vec![];
        samples.push(measured("reconnect_http_summary_while_connected", &ws.store, async {
            use tower::ServiceExt;
            for id in &ids {
                let response = router.clone().oneshot(reconnect(id, "?view=summary")?).await?;
                let status = response.status().as_u16();
                answers.push((status, axum::body::to_bytes(response.into_body(), usize::MAX).await?));
            }
            Ok(())
        }).await?);
        // Read after the measured phase, so its parsing is not counted.
        let summary: Vec<Value> = answers.drain(..).map(|(status, body)| {
            let keys: Vec<String> = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v.as_object()
                .map(|o| o.keys().cloned().collect())).unwrap_or_default();
            json!({"status":status,"bodyBytes":body.len(),"keys":keys})
        }).collect();
        samples.last_mut().context("sample")?["responses"] = summary.into();
        drop(router);
        idle(&ws).await?;
        let mut tail = vec![sample("after_idle", &ws.store)];
        trim_fixture_only();
        tail.push(sample("after_fixture_diagnostic_trim", &ws.store));
        for id in &ids {
            let d = ws.store.detail(id)?;
            let items: usize = d.turns.iter().map(|t| t["items"].as_array().map_or(0, Vec::len)).sum();
            anyhow::ensure!(d.turns.len() == TURNS && items == TURNS * ITEMS, "history changed");
            anyhow::ensure!(d.agent.connection_state == "connected", "not connected");
        }
        let calls: Vec<Value> = std::fs::read_to_string(dir.path().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        let report = json!({"synthetic":true,"payloadKiBPerItem":kib,"agents":agents,"turnsPerAgent":TURNS,"itemsPerTurn":ITEMS,
            "historyJsonBytesPerAgent":history_bytes,"pid":std::process::id(),"historyIntact":true,
            "appServerCalls":calls,"samples":samples,"tail":tail,"allocationSites":allocation_sites,
            "notes":["No user database, Core connection, native Agent or model",
                "One process per configuration; glibc arena maximum 2, as Core's main sets",
                "Rust counters omit C allocations (SQLite); mallinfo2 counts every arena and mmapped chunk",
                "Peak counter resets for each measured phase and includes background threads",
                "Allocation sites (YUZUNO_ALLOC_SITES=1) are byte-sampled backtraces; sampling slows the sampled phases",
                "Diagnostic trims occur only in this isolated fixture; they are not a proposed production policy"]});
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(output, serde_json::to_vec_pretty(&report)?)?;
        Ok(())
    }

    pub fn run() -> Result<()> {
        // As Core's main sets before any other thread exists.
        unsafe {
            libc::mallopt(libc::M_ARENA_MAX, 2);
        }
        tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(experiment())
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
