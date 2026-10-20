#[cfg(all(target_os = "linux", target_env = "gnu"))]
mod supported {
    // Isolated T-140 memory diagnosis using synthetic histories only.
    // Does not connect to a Core, load user records, or launch native Agents.
    //
    //   core_memory_paths <report.json> <synthetic MiB> paths
    //   core_memory_paths <report.json> <synthetic MiB> cycles-current|cycles-light <cycles>
    //
    // `paths` measures one call of each Store read/write path a Claude send
    // or Turn end uses, cold and held. `cycles-*` repeats a send and a Turn
    // end on four worker threads (two glibc arenas, as Core sets) and samples
    // what the allocator keeps without any trim: `current` makes the calls
    // claude.rs makes today, `light` the lighter Store calls that exist.
    use anyhow::{Context, Result};
    use serde_json::{json, Value};
    use std::{
        alloc::{GlobalAlloc, Layout, System},
        sync::{
            atomic::{AtomicUsize, Ordering::Relaxed},
            mpsc, Arc,
        },
        time::{Duration, Instant},
    };
    use yuzuno_workspace::{model::AgentDetail, store::Store};
    struct Counting;
    static LIVE: AtomicUsize = AtomicUsize::new(0);
    static PEAK: AtomicUsize = AtomicUsize::new(0);
    static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let p = System.alloc(layout);
            if !p.is_null() {
                ALLOCATED.fetch_add(layout.size(), Relaxed);
                CALLS.fetch_add(1, Relaxed);
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
                CALLS.fetch_add(1, Relaxed);
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

    fn sample(label: &str, elapsed: f64) -> Value {
        let proc = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        let kb = |key: &str| -> u64 {
            proc.lines()
                .find_map(|s| s.strip_prefix(key))
                .and_then(|s| s.split_whitespace().next())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0)
        };
        let heap = unsafe { libc::mallinfo2() };
        let v = json!({"phase":label,"elapsedSeconds":elapsed,"rustLiveBytes":LIVE.load(Relaxed),"rustPeakBytes":PEAK.load(Relaxed),
            "rustAllocatedBytes":ALLOCATED.load(Relaxed),"rssKiB":kb("VmRSS:"),"peakRssKiB":kb("VmHWM:"),
            "glibc":{"arenaBytes":heap.arena,"allocatedArenaBytes":heap.uordblks,"freeArenaBytes":heap.fordblks,"mappedBytes":heap.hblkhd}});
        println!("{}", v);
        v
    }
    fn trim_fixture_only() {
        unsafe {
            libc::malloc_trim(0);
        }
    }
    fn synthetic(id: &str, mib: usize, count: usize) -> Result<AgentDetail> {
        let per_item = mib * 1024 * 1024 / count;
        let turns: Vec<Value> = (0..count.div_ceil(100))
            .map(|t| {
                let items: Vec<Value> = (t * 100..((t + 1) * 100).min(count))
                    .map(|i| json!({"id":format!("item-{i}"),"type":"commandExecution","status":"completed","command":"synthetic output only","aggregatedOutput":"x".repeat(per_item),"exitCode":0}))
                    .collect();
                json!({"id":format!("turn-{t}"),"status":"completed","items":items})
            })
            .collect();
        Ok(serde_json::from_value(
            json!({"agent":{"id":id,"name":id,"cwd":"/tmp","model":"fixture","color":"sage","status":"idle","createdAt":"2026-10-19T00:00:00Z","updatedAt":"2026-10-19T00:00:00Z","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":turns,"pending":[],"artifacts":[]}),
        )?)
    }
    fn measured(label: &str, action: impl FnOnce() -> Result<()>) -> Result<Value> {
        let live_before = LIVE.load(Relaxed);
        let allocated_before = ALLOCATED.load(Relaxed);
        let calls_before = CALLS.load(Relaxed);
        PEAK.store(live_before, Relaxed);
        let start = Instant::now();
        action()?;
        let elapsed = start.elapsed().as_micros();
        let peak = PEAK.load(Relaxed);
        let live_after = LIVE.load(Relaxed);
        let allocated = ALLOCATED.load(Relaxed) - allocated_before;
        let calls = CALLS.load(Relaxed) - calls_before;
        let mut point = sample(label, start.elapsed().as_secs_f64());
        point["operation"] = json!({"elapsedMicros":elapsed,"liveBeforeBytes":live_before,
            "liveAfterBytes":live_after,"peakLiveBytes":peak,
            "peakAddedBytes":peak.saturating_sub(live_before),
            "allocatedBytes":allocated,"allocationCalls":calls});
        Ok(point)
    }

    // The calls a Claude send and a Turn end make on the Store today
    // (claude.rs claude_send_input_locked, claude_ensure, claude_images, the
    // bridge's `result`, `brief` and `mailbox_delivery` frames), or the
    // lighter Store calls that exist for the same reads and writes.
    fn send(store: &Store, id: &str, turn: &str, light: bool) -> Result<()> {
        if light {
            for _ in 0..4 {
                let view = store.send_view(id)?;
                anyhow::ensure!(!view.turns.is_empty(), "turns missing");
            }
        } else {
            for _ in 0..4 {
                let d = store.detail(id)?;
                anyhow::ensure!(!d.turns.is_empty(), "turns missing");
            }
        }
        let turn = turn.to_owned();
        store.record_event(id, "claude/turnRequested", &json!({"turnId":turn}), move |d| {
            let t = d.turn_mut(&turn);
            t["status"] = "inProgress".into();
            t["items"] = json!([{"id":format!("{turn}:input"),"type":"userMessage","content":[{"type":"text","text":"synthetic"}]}]);
        })?;
        Ok(())
    }
    fn stream(store: &Store, id: &str, turn: &str, deltas: usize) -> Result<()> {
        for n in 0..deltas {
            store.record_stream(id, yuzuno_workspace::store::Route::Ephemeral, "item/agentMessage/delta",
                &json!({"turnId":turn,"itemId":format!("{turn}:reply"),"delta":format!("synthetic delta {n} ")}))?;
        }
        Ok(())
    }
    fn turn_end(store: &Store, id: &str, turn: &str, light: bool) -> Result<()> {
        let done = turn.to_owned();
        let finish = move |d: &mut AgentDetail| {
            d.turn_mut(&done)["status"] = "completed".into();
            d.agent.status = "idle".into();
        };
        if light {
            let wanted = turn.to_owned();
            let ended = store.update_picking(id, "claude/result", &json!({}), finish, |d| {
                d.turns.iter().find(|t| t["id"] == wanted.as_str()).cloned()
            })?;
            anyhow::ensure!(ended.is_some(), "turn missing");
            store.update_meta(id, "claude/brief", &json!({}), |_| {})?;
            let view = store.send_view(id)?;
            anyhow::ensure!(view.agent.id == id, "agent missing");
            store.update_meta(id, "peer/hookDelivery", &json!({}), |_| {})?;
        } else {
            let d = store.update(id, "claude/result", &json!({}), finish)?;
            anyhow::ensure!(d.turns.iter().any(|t| t["id"] == turn), "turn missing");
            store.update(id, "claude/brief", &json!({}), |_| {})?;
            let d = store.detail(id)?;
            anyhow::ensure!(d.agent.id == id, "agent missing");
            store.update(id, "peer/hookDelivery", &json!({}), |_| {})?;
        }
        Ok(())
    }

    /// Store calls run on these threads in turn, as Core's blocking pool
    /// spreads them over its threads (and glibc over its two arenas).
    struct Pool {
        workers: Vec<mpsc::Sender<Box<dyn FnOnce() + Send>>>,
        next: AtomicUsize,
    }
    impl Pool {
        fn new(threads: usize) -> Self {
            let workers = (0..threads)
                .map(|_| {
                    let (tx, rx) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
                    std::thread::spawn(move || {
                        for job in rx {
                            job();
                        }
                    });
                    tx
                })
                .collect();
            Self {
                workers,
                next: AtomicUsize::new(0),
            }
        }
        fn run<T: Send + 'static>(&self, job: impl FnOnce() -> T + Send + 'static) -> T {
            let (tx, rx) = mpsc::channel();
            let n = self.next.fetch_add(1, Relaxed) % self.workers.len();
            self.workers[n]
                .send(Box::new(move || {
                    let _ = tx.send(job());
                }))
                .expect("worker");
            rx.recv().expect("worker result")
        }
    }

    fn paths(store: &Store, id: &str, count: usize) -> Result<Vec<Value>> {
        let mut samples = vec![sample("seeded_fixture_after_diagnostic_trim", 0.)];
        let query = yuzuno_workspace::conversation_window::Query {
            view: Some("window".into()),
            ..Default::default()
        };
        let items = |d: &AgentDetail| {
            d.turns
                .iter()
                .map(|t| t["items"].as_array().map_or(0, Vec::len))
                .sum::<usize>()
        };
        samples.push(measured("cold_full_detail_read", || {
            let d = store.detail(id)?;
            anyhow::ensure!(items(&d) == count, "history missing");
            Ok(())
        })?);
        samples.push(measured("cold_send_view", || {
            let d = store.send_view(id)?;
            anyhow::ensure!(d.turns.len() == count.div_ceil(100), "turn index missing");
            Ok(())
        })?);
        samples.push(measured("cold_client_window", || {
            anyhow::ensure!(store.client_window(id, &query)?.is_ok(), "window missing");
            Ok(())
        })?);
        samples.push(measured("cold_metadata_only_write", || {
            store.update_meta(id, "agent/configured", &json!({}), |d| {
                d.agent.goal = "metadata-only".into()
            })?;
            Ok(())
        })?);
        // This write loads the record and keeps it held, as a Turn's first event does.
        samples.push(measured("cold_generic_compare_write", || {
            store.record_event(id, "agent/configured", &json!({}), |d| {
                d.agent.goal = "generic-cold".into()
            })?;
            Ok(())
        })?);
        samples.push(measured("held_full_detail_read", || {
            let d = store.detail(id)?;
            anyhow::ensure!(items(&d) == count, "history missing");
            Ok(())
        })?);
        samples.push(measured("held_send_view", || {
            drop(store.send_view(id)?);
            Ok(())
        })?);
        samples.push(measured("held_client_window", || {
            anyhow::ensure!(store.client_window(id, &query)?.is_ok(), "window missing");
            Ok(())
        })?);
        samples.push(measured("held_metadata_only_write", || {
            store.update_meta(id, "claude/brief", &json!({}), |_| {})?;
            Ok(())
        })?);
        samples.push(measured("held_generic_compare_write", || {
            store.record_event(id, "agent/configured", &json!({}), |d| {
                d.agent.goal = "generic-compare".into()
            })?;
            Ok(())
        })?);
        samples.push(measured("held_update_returning_record", || {
            drop(store.update(id, "claude/brief", &json!({}), |_| {})?);
            Ok(())
        })?);
        samples.push(measured("held_update_picking_one_turn", || {
            let turn = store.update_picking(
                id,
                "claude/result",
                &json!({}),
                |d| d.turns[0]["status"] = "completed".into(),
                |d| d.turns[0].clone(),
            )?;
            anyhow::ensure!(turn["id"] == "turn-0", "turn missing");
            Ok(())
        })?);
        samples.push(measured("held_native_boundary_record_applied", || {
            store.record_applied(
                id,
                "turn/completed",
                "turn/completed",
                &json!({"turn":{"id":"turn-0","status":"completed"}}),
            )?;
            Ok(())
        })?);
        samples.push(measured("held_stream_delta", || {
            store.record_stream(
                id,
                yuzuno_workspace::store::Route::Ephemeral,
                "item/commandExecution/outputDelta",
                &json!({"turnId":"turn-0","itemId":"item-0","delta":"synthetic-delta"}),
            )?;
            Ok(())
        })?);
        samples.push(measured("held_claude_send_current", || {
            send(store, id, "send-current", false)
        })?);
        samples.push(measured("held_claude_send_light", || {
            send(store, id, "send-light", true)
        })?);
        samples.push(measured("held_claude_turn_end_current", || {
            turn_end(store, id, "send-current", false)
        })?);
        samples.push(measured("held_claude_turn_end_light", || {
            turn_end(store, id, "send-light", true)
        })?);
        Ok(samples)
    }

    fn cycles(store: Arc<Store>, id: &str, cycles: usize, light: bool) -> Result<Vec<Value>> {
        let pool = Pool::new(4);
        let mut samples = vec![sample("seeded_fixture_after_diagnostic_trim", 0.)];
        let started = Instant::now();
        for n in 0..cycles {
            let turn = format!("cycle-{n}");
            let allocated = ALLOCATED.load(Relaxed);
            let begin = Instant::now();
            // Every fourth Turn starts after the record went idle, so its
            // send reads it from its rows as after a pause (STREAM_IDLE).
            if n % 4 == 3 {
                // Controlled cache-expiry interval, not a completion poll.
                std::thread::sleep(Duration::from_millis(5_500));
                let s = store.clone();
                pool.run(move || s.stream_tick(Duration::ZERO))
                    .failed
                    .is_empty()
                    .then_some(())
                    .context("tick failed")?;
            }
            let (s, i, t) = (store.clone(), id.to_owned(), turn.clone());
            pool.run(move || send(&s, &i, &t, light))?;
            for _ in 0..4 {
                let (s, i, t) = (store.clone(), id.to_owned(), turn.clone());
                pool.run(move || stream(&s, &i, &t, 5))?;
            }
            let (s, i, t) = (store.clone(), id.to_owned(), turn.clone());
            pool.run(move || turn_end(&s, &i, &t, light))?;
            let mut point = sample(&format!("after_cycle_{n}"), started.elapsed().as_secs_f64());
            point["cycle"] = json!({"index":n,"cold":n % 4 == 3,"allocatedBytes":ALLOCATED.load(Relaxed) - allocated,
                "elapsedMicros":begin.elapsed().as_micros()});
            samples.push(point);
        }
        Ok(samples)
    }

    fn experiment() -> Result<()> {
        // This is a separate bounded diagnostic, never a production trim.
        unsafe {
            libc::mallopt(libc::M_ARENA_MAX, 2);
        }
        let output = std::path::PathBuf::from(std::env::args().nth(1).context("report path")?);
        let mib: usize = std::env::args().nth(2).context("synthetic MiB")?.parse()?;
        anyhow::ensure!(
            (1..=192).contains(&mib),
            "synthetic size must be 1..192 MiB"
        );
        let mode = std::env::args()
            .nth(3)
            .context("mode: paths, cycles-current or cycles-light")?;
        let count = if mib <= 64 { 8000 } else { 23308 };
        let dir = tempfile::tempdir()?;
        let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite"))?);
        let id = "fixture-memory-path";
        let detail = synthetic(id, mib, count)?;
        store.insert(&detail)?;
        drop(detail);
        trim_fixture_only();
        let samples = match mode.as_str() {
            "paths" => paths(&store, id, count)?,
            "cycles-current" | "cycles-light" => {
                let n: usize = std::env::args().nth(4).context("cycles")?.parse()?;
                anyhow::ensure!((1..=200).contains(&n), "cycles must be 1..200");
                cycles(store.clone(), id, n, mode == "cycles-light")?
            }
            other => anyhow::bail!("unknown mode {other}"),
        };
        // Controlled cache-expiry interval, not a job-completion polling loop.
        std::thread::sleep(Duration::from_secs(6));
        anyhow::ensure!(store.flush().failed.is_empty(), "flush failed");
        anyhow::ensure!(
            store.stream_tick(Duration::ZERO).failed.is_empty(),
            "tick failed"
        );
        let mut tail = vec![sample("after_cache_expiry", 0.)];
        let held_after_idle = store.streamed_records();
        trim_fixture_only();
        tail.push(sample("after_fixture_diagnostic_trim", 0.));
        let d = store.detail(id)?;
        let items: usize = d
            .turns
            .iter()
            .map(|t| t["items"].as_array().map_or(0, Vec::len))
            .sum();
        anyhow::ensure!(items >= count, "history count changed");
        let report = json!({"synthetic":true,"mib":mib,"itemCount":count,"mode":mode,"pid":std::process::id(),
            "heldAfterIdle":held_after_idle,"historyIntact":true,"samples":samples,"tail":tail,
            "notes":["No user database, Core connection or native Agent",
                "One process per size and mode; labels distinguish cold and held paths",
                "Rust allocation counters omit SQLite C allocations; glibc/RSS are sampled separately",
                "Peak counter resets for each measured operation; allocated bytes count allocations and positive realloc growth",
                "Cycles run on four worker threads with M_ARENA_MAX=2 and no trim until the diagnostic one at the end",
                "Diagnostic trims occur only in this isolated fixture; they are not a proposed production policy"]});
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(output, serde_json::to_vec_pretty(&report)?)?;
        Ok(())
    }

    pub fn run() -> Result<()> {
        experiment()
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
