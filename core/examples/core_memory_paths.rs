#[cfg(all(target_os = "linux", target_env = "gnu"))]
mod supported {
    // Isolated T-140 memory diagnosis using synthetic histories only.
    // Does not connect to a Core, load user records, or launch native Agents.
    use anyhow::{Context, Result};
    use serde_json::{json, Value};
    use std::{
        alloc::{GlobalAlloc, Layout, System},
        sync::atomic::{AtomicUsize, Ordering::Relaxed},
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
        let v = json!({"phase":label,"elapsedSeconds":elapsed,"rustLiveBytes":LIVE.load(Relaxed),"rustPeakBytes":PEAK.load(Relaxed),"rssKiB":kb("VmRSS:"),"peakRssKiB":kb("VmHWM:"),"glibc":{"arenaBytes":heap.arena,"allocatedArenaBytes":heap.uordblks,"freeArenaBytes":heap.fordblks,"mappedBytes":heap.hblkhd}});
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
        let turns: Vec<Value>=(0..count.div_ceil(100)).map(|t| {
        let items: Vec<Value>=(t*100..((t+1)*100).min(count)).map(|i| json!({"id":format!("item-{i}"),"type":"commandExecution","status":"completed","command":"synthetic output only","aggregatedOutput":"x".repeat(per_item),"exitCode":0})).collect();
        json!({"id":format!("turn-{t}"),"status":"completed","items":items})
    }).collect();
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

    fn experiment() -> Result<()> {
        // This is a separate bounded diagnostic, never a production trim.
        unsafe { libc::mallopt(libc::M_ARENA_MAX, 2); }
        let output = std::path::PathBuf::from(std::env::args().nth(1).context("report path")?);
        let mib: usize = std::env::args().nth(2).context("synthetic MiB")?.parse()?;
        anyhow::ensure!((1..=192).contains(&mib), "synthetic size must be 1..192 MiB");
        let count = if mib <= 64 { 8000 } else { 23308 };
        let dir = tempfile::tempdir()?;
        let store = Store::open(&dir.path().join("workspace.sqlite"))?;
        let id = "fixture-memory-path";
        let detail = synthetic(id, mib, count)?;
        store.insert(&detail)?;
        drop(detail);
        trim_fixture_only();
        let mut samples = vec![sample("seeded_fixture_after_diagnostic_trim", 0.)];
        let query = yuzuno_workspace::conversation_window::Query { view: Some("window".into()), ..Default::default() };
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
            store.update_meta(id, "agent/configured", &json!({}), |d| d.agent.goal = "metadata-only".into())?;
            Ok(())
        })?);
        samples.push(measured("native_boundary_record_applied", || {
            store.record_applied(id, "turn/completed", "turn/completed", &json!({"turn":{"id":"turn-0","status":"completed"}}))?;
            Ok(())
        })?);
        samples.push(measured("held_full_detail_read", || {
            let d = store.detail(id)?;
            anyhow::ensure!(d.turns.iter().map(|t| t["items"].as_array().unwrap().len()).sum::<usize>() == count, "history missing");
            Ok(())
        })?);
        samples.push(measured("held_send_view", || { drop(store.send_view(id)?); Ok(()) })?);
        samples.push(measured("held_metadata_only_write", || {
            store.update_meta(id, "agent/configured", &json!({}), |d| d.agent.goal = "metadata-again".into())?;
            Ok(())
        })?);
        samples.push(measured("held_generic_compare_write", || {
            store.record_event(id, "agent/configured", &json!({}), |d| d.agent.goal = "generic-compare".into())?;
            Ok(())
        })?);
        samples.push(measured("held_native_boundary_record_applied", || {
            store.record_applied(id, "turn/completed", "turn/completed", &json!({"turn":{"id":"turn-0","status":"completed"}}))?;
            Ok(())
        })?);
        samples.push(measured("held_stream_delta", || {
            store.record_stream(id, yuzuno_workspace::store::Route::Ephemeral,
                "item/commandExecution/outputDelta", &json!({"turnId":"turn-0","itemId":"item-0","delta":"synthetic-delta"}))?;
            Ok(())
        })?);
        // Controlled cache-expiry interval, not a job-completion polling loop.
        std::thread::sleep(Duration::from_secs(6));
        anyhow::ensure!(store.flush().failed.is_empty(), "flush failed");
        anyhow::ensure!(store.stream_tick(Duration::ZERO).failed.is_empty(), "tick failed");
        samples.push(sample("after_cache_expiry", 0.));
        let held_after_idle = store.streamed_records();
        trim_fixture_only();
        samples.push(sample("after_fixture_diagnostic_trim", 0.));
        let d = store.detail(id)?;
        let items: usize = d.turns.iter().map(|t| t["items"].as_array().unwrap().len()).sum();
        anyhow::ensure!(items == count, "history count changed");
        anyhow::ensure!(d.turns[0]["items"][0]["aggregatedOutput"].as_str().unwrap().ends_with("synthetic-delta"), "delta was not applied");
        let report = json!({"synthetic":true,"mib":mib,"itemCount":count,"pid":std::process::id(),
            "heldAfterIdle":held_after_idle,"historyIntact":true,"samples":samples,
            "notes":["No user database, Core connection or native Agent",
                "One process per history size; operations are sequential, labels distinguish cold and held paths",
                "Rust allocation counters omit SQLite C allocations; glibc/RSS are sampled separately",
                "Peak counter resets for each measured operation; allocated bytes count allocations and positive realloc growth",
                "Diagnostic trims occur only in this isolated fixture; they are not a proposed production policy"]});
        if let Some(parent)=output.parent() { std::fs::create_dir_all(parent)?; }
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
