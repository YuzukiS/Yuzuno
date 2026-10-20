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
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let p = System.alloc(layout);
            if !p.is_null() {
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
    fn experiment() -> Result<()> {
        // Match the deployed Core's startup setting, before starting any thread.
        unsafe {
            libc::mallopt(libc::M_ARENA_MAX, 2);
        }
        let output = std::path::PathBuf::from(
            std::env::args()
                .nth(1)
                .context("report.json path required")?,
        );
        let dir = tempfile::tempdir()?;
        let store = std::sync::Arc::new(Store::open(&dir.path().join("workspace.sqlite"))?);
        let admission =
            std::sync::Arc::new(yuzuno_workspace::updates::admission::Admission::default());
        let _tick = admission.enter_completion()?;
        let mode = std::env::args().nth(2).unwrap_or_else(|| "baseline".into());
        anyhow::ensure!(
            ["baseline", "active", "idle"].contains(&mode.as_str()),
            "unknown experiment mode"
        );
        let mut reclaims = Vec::new();
        let mut points = vec![sample("empty", 0.)];
        // Approximate observed serialized sizes/item counts, but all content is synthetic.
        let shapes = [
            (58, 12050),
            (46, 17388),
            (40, 12254),
            (186, 23308),
            (50, 9229),
            (72, 14942),
            (32, 5082),
            (5, 271),
        ];
        let seed = Instant::now();
        for (i, (mib, count)) in shapes.iter().enumerate() {
            let d = synthetic(&format!("fixture-{i}"), *mib, *count)?;
            store.insert(&d)?;
        }
        points.push(sample(
            "seeded_then_dropped_input",
            seed.elapsed().as_secs_f64(),
        ));
        trim_fixture_only();
        points.push(sample("seed_baseline_after_fixture_trim", 0.));
        let held = Instant::now();
        for i in 0..shapes.len() {
            store.update_picking(
                &format!("fixture-{i}"),
                "agent/configured",
                &json!({}),
                |d| d.agent.goal = "synthetic update".into(),
                |_| (),
            )?;
        }
        points.push(sample(
            "eight_records_after_small_updates",
            held.elapsed().as_secs_f64(),
        ));
        let copies = Instant::now();
        let retained = (0..3)
            .map(|_| store.detail("fixture-3"))
            .collect::<Result<Vec<_>>>()?;
        points.push(sample(
            "three_largest_full_detail_copies",
            copies.elapsed().as_secs_f64(),
        ));
        drop(retained);
        points.push(sample("after_copies_dropped", 0.));
        // Concurrent small reads: the reclaimer must not need a Store lock.
        // This is a bounded synthetic latency check, not an end-to-end UI claim.
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let reader = store.clone();
        let ready = barrier.clone();
        let reads = std::thread::spawn(move || -> Result<Vec<u128>> {
            ready.wait();
            let mut times = Vec::new();
            for _ in 0..100 {
                let started = Instant::now();
                let d = reader.send_view("fixture-3")?;
                anyhow::ensure!(d.turns.len() == 234, "read lost turns");
                drop(d);
                times.push(started.elapsed().as_micros());
            }
            Ok(times)
        });
        barrier.wait();
        if mode == "active" {
            anyhow::ensure!(store.streamed_records() > 0, "expected live records");
            let skipped = yuzuno_workspace::heap::reclaim_if_idle(&store, &admission);
            anyhow::ensure!(skipped.is_none(), "active records must defer reclaim");
            reclaims.push(json!(skipped));
            points.push(sample("runtime_reclaim_skipped_while_active", 0.));
        }
        let read_times = reads.join().expect("read thread")?;
        let mut update_times = Vec::new();
        for n in 0..5 {
            let start = Instant::now();
            store.update_picking(
                "fixture-3",
                "agent/configured",
                &json!({}),
                |d| d.agent.goal = format!("update-{n}"),
                |_| (),
            )?;
            update_times.push(start.elapsed().as_micros());
        }
        points.push(sample("after_following_updates", 0.));
        // A bounded idle interval is part of the memory experiment, not a Job watcher.
        std::thread::sleep(Duration::from_secs(6));
        let tick = store.stream_tick(Duration::ZERO);
        anyhow::ensure!(tick.failed.is_empty(), "fixture writes failed");
        points.push(sample("after_idle_record_eviction", 0.));
        if mode == "idle" || mode == "active" {
            anyhow::ensure!(store.streamed_records() == 0, "idle cache was not retired");
            anyhow::ensure!(
                yuzuno_workspace::heap::reclaim_if_idle(&store, &admission).is_none(),
                "a short pause must keep freed pages warm"
            );
        }
        // Both control and candidate wait the same real quiet interval.
        std::thread::sleep(yuzuno_workspace::heap::IDLE_GRACE + Duration::from_secs(1));
        if mode == "idle" || mode == "active" {
            anyhow::ensure!(store.streamed_records() == 0, "idle cache was not retired");
            // A cold read is in flight before any held record exists.
            let in_flight = admission.enter_completion()?;
            anyhow::ensure!(
                yuzuno_workspace::heap::reclaim_if_idle(&store, &admission).is_none(),
                "in-flight cold read was not protected"
            );
            drop(in_flight);
            admission.begin_drain("fixture-update")?;
            anyhow::ensure!(
                yuzuno_workspace::heap::reclaim_if_idle(&store, &admission).is_none(),
                "update drain was not protected"
            );
            admission.reopen("fixture-update")?;
            let reclaimed = yuzuno_workspace::heap::reclaim_if_idle(&store, &admission);
            anyhow::ensure!(reclaimed.is_some(), "large idle free heap was not checked");
            reclaims.push(json!(reclaimed));
            anyhow::ensure!(
                yuzuno_workspace::heap::reclaim_if_idle(&store, &admission).is_none(),
                "cooldown ignored"
            );
            points.push(sample("after_runtime_reclaim_when_idle", 0.));
        }
        // After the normal recheck interval, unchanged resident memory must
        // not cause another trim just because glibc retained virtual arenas.
        std::thread::sleep(Duration::from_secs(31));
        if mode != "baseline" {
            anyhow::ensure!(
                yuzuno_workspace::heap::reclaim_if_idle(&store, &admission).is_none(),
                "unchanged idle heap was trimmed again"
            );
        }
        // Same paused-then-send Store sequence in every mode. Baseline has
        // not trimmed; candidates have. Do not hide refault costs with a
        // diagnostic trim before this comparison.
        let request = admission.enter_work()?;
        let start = Instant::now();
        drop(store.send_view("fixture-3")?);
        let cold_view_us = start.elapsed().as_micros();
        let start = Instant::now();
        store.update_picking(
            "fixture-3",
            "agent/configured",
            &json!({}),
            |d| d.agent.goal = "cold update".into(),
            |_| (),
        )?;
        let cold_commit_us = start.elapsed().as_micros();
        drop(request);
        points.push(sample("after_first_cold_send_path", 0.));
        trim_fixture_only();
        points.push(sample("after_fixture_only_trim", 0.));
        let d = store.detail("fixture-3")?;
        anyhow::ensure!(
            d.turns
                .iter()
                .map(|t| t["items"].as_array().unwrap().len())
                .sum::<usize>()
                == 23308,
            "history changed"
        );
        drop(d);
        let report = json!({"synthetic":true,"mode":mode,"idleGraceSeconds":yuzuno_workspace::heap::IDLE_GRACE.as_secs(),"reclaims":reclaims,"concurrentReadMicros":read_times,"followingUpdateMicros":update_times,"coldSendViewMicros":cold_view_us,"coldCommitMicros":cold_commit_us,"pid":std::process::id(),"shapes":shapes,"samples":points,"historyIntact":true,"notes":["Core Store library; no daily data or native Agent","Rust live counters exclude SQLite C allocations; mallinfo2 separates glibc live/free arena bytes","Direct diagnostic trims before and after measurement are fixture-only; guarded reclaim uses the production policy","Three simultaneous full-detail copies are a controlled scenario, not a claim about live requests"]});
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
