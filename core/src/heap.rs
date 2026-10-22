//! Return large, freed allocator pages from long-history bursts to the OS.
//! This never drops records or changes a cache's lifetime. Call only from
//! background blocking maintenance, after Store locks have been released.
//! `diagnostics` reports the process's memory and this policy's state on
//! request (T-140); it reads counters only and changes nothing.

use serde_json::{json, Value};

/// Keep freed pages warm through short thinking/typing pauses. Cold records
/// need to fault these pages in again, so reclaim is for a longer idle gap.
pub const IDLE_GRACE: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reclaim {
    /// "idle" (no held record for a minute) or "held" (the slower check while
    /// records stay held).
    pub path: &'static str,
    pub started_at: String,
    pub in_flight: usize,
    pub free_arena_bytes: usize,
    pub released_pages: bool,
    pub elapsed_micros: u128,
    pub rss_before_bytes: Option<u64>,
    pub rss_after_bytes: Option<u64>,
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
mod platform {
    use super::{Reclaim, IDLE_GRACE};
    use serde_json::{json, Value};
    use std::{
        sync::Mutex,
        time::{Duration, Instant},
    };

    /// The least time between two checks, of either path.
    const INTERVAL: Duration = Duration::from_secs(30);
    const MIN_FREE: usize = 128 * 1024 * 1024;
    /// While records stay held, as one Agent streams on (T-140), the freed
    /// pages of another Agent's released record would otherwise stay resident
    /// for as long as it streams. After this long busy, a slower check comes.
    const HELD_GRACE: Duration = Duration::from_secs(300);
    /// At most one check of that slower path in this long.
    const HELD_INTERVAL: Duration = Duration::from_secs(300);

    /// Which policy a check runs under.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Path {
        /// No record held for IDLE_GRACE: as before T-140's held path.
        Idle,
        /// Records held for HELD_GRACE: only when free arena space is at least
        /// what is in use.
        Held,
    }

    impl Path {
        fn name(self) -> &'static str {
            match self {
                Path::Idle => "idle",
                Path::Held => "held",
            }
        }
    }

    #[derive(Default)]
    struct Gate {
        empty_since: Option<Instant>,
        /// When this busy period began: the first tick that saw a held record
        /// since the last idle check (or since the start). A short gap with no
        /// record held keeps it, so alternating never starves the held path.
        busy_since: Option<Instant>,
        /// The last check of either path.
        last_check: Option<Instant>,
        /// The last check of the held path.
        last_held_check: Option<Instant>,
        last_reclaimed_rss: Option<u64>,
        /// What the last check that got past the time gate found.
        last_outcome: Option<Value>,
    }
    // Process-wide; a competing maintenance tick never waits for a trim.
    static GATE: Mutex<Gate> = Mutex::new(Gate {
        empty_since: None,
        busy_since: None,
        last_check: None,
        last_held_check: None,
        last_reclaimed_rss: None,
        last_outcome: None,
    });

    /// No request but the maintenance tick's own, no update operation, not sealed.
    fn quiet(activity: &crate::updates::admission::AdmissionState) -> bool {
        activity.in_flight == 1 && activity.operation_id.is_none() && !activity.sealed
    }

    /// What holds back a trim once a check has read the allocator, or None to
    /// trim. The ratio is the held path's only: free arena space at least what
    /// is in use. It says nothing of how large the held records are, and
    /// covers neither mmapped chunks nor all of RSS.
    fn verdict(path: Path, free: usize, used: usize, rss: Option<u64>, reclaimed: Option<u64>) -> Option<&'static str> {
        if free < MIN_FREE {
            return Some("freeBelowThreshold");
        }
        if path == Path::Held && free < used {
            return Some("freeNotDominant");
        }
        // madvise can leave the virtual free arena size unchanged. Avoid
        // repeatedly scanning already-reclaimed pages while nothing grows.
        if let (Some(current), Some(previous)) = (rss, reclaimed) {
            if current.saturating_sub(previous) < MIN_FREE as u64 {
                return Some("rssGrowthBelowThreshold");
            }
        }
        None
    }

    impl Gate {
        /// Whether a check is due now, and under which path. With no record
        /// held, the idle path is as before; the held path needs the busy
        /// period to have lasted HELD_GRACE and HELD_INTERVAL since its last
        /// check, whatever is held this tick. Both need quiet and INTERVAL
        /// since the last check of either, and the idle path comes first.
        /// Only an idle check ends the busy period, whatever it found.
        fn due(&mut self, now: Instant, held: usize, quiet: bool) -> Option<Path> {
            if held > 0 {
                self.empty_since = None;
                self.busy_since.get_or_insert(now);
            } else {
                self.empty_since.get_or_insert(now);
                if quiet && self.idle_time(now, held) && self.spaced(now) {
                    self.last_check = Some(now);
                    self.busy_since = None;
                    return Some(Path::Idle);
                }
            }
            if quiet && self.held_time(now) && self.spaced(now) {
                self.last_check = Some(now);
                self.last_held_check = Some(now);
                return Some(Path::Held);
            }
            None
        }

        /// No record held, for IDLE_GRACE since the tick first saw none.
        fn idle_time(&self, now: Instant, held: usize) -> bool {
            held == 0 && self.empty_since.is_some_and(|since| now.saturating_duration_since(since) >= IDLE_GRACE)
        }

        /// Busy for HELD_GRACE, and HELD_INTERVAL since the last held check.
        fn held_time(&self, now: Instant) -> bool {
            self.busy_since.is_some_and(|since| now.saturating_duration_since(since) >= HELD_GRACE)
                && self.last_held_check.is_none_or(|last| now.saturating_duration_since(last) >= HELD_INTERVAL)
        }

        /// INTERVAL since the last check of either path.
        fn spaced(&self, now: Instant) -> bool {
            self.last_check.is_none_or(|last| now.saturating_duration_since(last) >= INTERVAL)
        }

        /// The path a check would take now by time alone, as `due` orders them.
        fn next_path(&self, now: Instant, held: usize) -> Option<Path> {
            if self.idle_time(now, held) {
                Some(Path::Idle)
            } else if self.held_time(now) {
                Some(Path::Held)
            } else {
                None
            }
        }

        /// Which of the checks `due` and `reclaim` make would hold a trim
        /// back now, without recording anything: `others` counts permits
        /// other than the maintenance tick's own.
        fn waiting_for(&self, now: Instant, held: usize, others: usize, activity: &crate::updates::admission::AdmissionState,
            free: Option<usize>, used: Option<usize>, rss: Option<u64>) -> Vec<&'static str> {
            let mut waiting = Vec::new();
            let path = self.next_path(now, held);
            // Held records hold a trim back only until the held path is due.
            if held > 0 && path.is_none() {
                waiting.push("heldRecords");
                let busy = self.busy_since.is_some_and(|since| now.saturating_duration_since(since) >= HELD_GRACE);
                waiting.push(if busy { "heldInterval" } else { "heldGrace" });
            }
            if others > 0 {
                waiting.push("requestsInFlight");
            }
            if activity.operation_id.is_some() {
                waiting.push("updateOperation");
            }
            if activity.sealed {
                waiting.push("sealed");
            }
            // The tick records when it first saw no held record; until then
            // the grace has not started.
            if held == 0 && path.is_none() {
                waiting.push("idleGrace");
            }
            if !self.spaced(now) {
                waiting.push("interval");
            }
            if free.is_some_and(|free| free < MIN_FREE) {
                waiting.push("freeBelowThreshold");
            }
            let held_next = path == Some(Path::Held) || (path.is_none() && held > 0);
            if let (true, Some(free), Some(used)) = (held_next, free, used) {
                if free < used {
                    waiting.push("freeNotDominant");
                }
            }
            if let (Some(current), Some(previous)) = (rss, self.last_reclaimed_rss) {
                if current.saturating_sub(previous) < MIN_FREE as u64 {
                    waiting.push("rssGrowthBelowThreshold");
                }
            }
            waiting
        }
    }

    // A process-wide observation, not an exact count of bytes trim released:
    // other threads can allocate or release memory between the two reads.
    fn rss() -> Option<u64> {
        let pages = std::fs::read_to_string("/proc/self/statm")
            .ok()?
            .split_whitespace()
            .nth(1)?
            .parse::<u64>()
            .ok()?;
        // SAFETY: sysconf has no pointer arguments.
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        u64::try_from(page)
            .ok()
            .filter(|page| *page > 0)?
            .checked_mul(pages)
    }

    pub(super) fn reclaim(
        held: usize,
        activity: &crate::updates::admission::AdmissionState,
    ) -> Option<Reclaim> {
        let mut gate = GATE.try_lock().ok()?;
        let path = gate.due(Instant::now(), held, quiet(activity))?;
        let checked_at = chrono::Utc::now().to_rfc3339();
        // Rate-limit checks too, including below-threshold/no-release checks.
        // One allocator reading per check, after the time gate.
        // SAFETY: glibc's allocator introspection and trim are thread-safe.
        // Only free chunks are returned; no pointer into a live object changes.
        let counts = unsafe { libc::mallinfo2() };
        let (free, used) = (counts.fordblks, counts.uordblks);
        let rss_before_bytes = if free < MIN_FREE { None } else { rss() };
        if let Some(result) = verdict(path, free, used, rss_before_bytes, gate.last_reclaimed_rss) {
            gate.last_outcome = Some(json!({"at":checked_at,"path":path.name(),"result":result,"fordblks":free,"uordblks":used,
                "rssBytes":rss_before_bytes,"lastReclaimedRssBytes":gate.last_reclaimed_rss}));
            return None;
        }
        let started_at = chrono::Utc::now();
        let started = Instant::now();
        let released = unsafe { libc::malloc_trim(0) } != 0;
        let elapsed_micros = started.elapsed().as_micros();
        let rss_after_bytes = rss();
        gate.last_reclaimed_rss = rss_after_bytes;
        let reclaim = Reclaim {
            path: path.name(),
            started_at: started_at.to_rfc3339(),
            in_flight: activity.in_flight,
            free_arena_bytes: free,
            released_pages: released,
            elapsed_micros,
            rss_before_bytes,
            rss_after_bytes,
        };
        gate.last_outcome = Some(json!({"at":checked_at,"path":path.name(),"result":"trimmed","reclaim":reclaim}));
        Some(reclaim)
    }

    /// The policy and what holds it back now. A trim in progress holds the
    /// gate; this never waits for it.
    pub(super) fn status(held: usize, others: usize, activity: &crate::updates::admission::AdmissionState,
        free: Option<usize>, used: Option<usize>, rss: Option<u64>) -> Value {
        let policy = json!({"idleGraceSeconds":IDLE_GRACE.as_secs(),"intervalSeconds":INTERVAL.as_secs(),
            "minFordblks":MIN_FREE,"minRssGrowthBytes":MIN_FREE,
            "heldGraceSeconds":HELD_GRACE.as_secs(),"heldIntervalSeconds":HELD_INTERVAL.as_secs(),
            "heldRatio":"fordblks >= uordblks"});
        let Ok(gate) = GATE.try_lock() else {
            return json!({"available":true,"policy":policy,"gate":null,"gateBusy":true});
        };
        let now = Instant::now();
        let seconds = |at: Option<Instant>| at.map(|at| now.saturating_duration_since(at).as_secs_f64());
        json!({"available":true,"policy":policy,"gateBusy":false,"gate":{
            "heldEmptyForSeconds":if held == 0 { seconds(gate.empty_since) } else { None },
            "busyForSeconds":seconds(gate.busy_since),
            "sinceLastCheckSeconds":seconds(gate.last_check),
            "sinceLastHeldCheckSeconds":seconds(gate.last_held_check),
            "nextPath":gate.next_path(now, held).map(Path::name),
            "lastReclaimedRssBytes":gate.last_reclaimed_rss,
            "waitingFor":gate.waiting_for(now, held, others, activity, free, used, rss),
            "lastCheck":gate.last_outcome}})
    }

    pub(super) fn allocator() -> Value {
        // SAFETY: glibc introspection only. It sums every arena (as glibc
        // 2.44's malloc.c does), whatever older manual pages say.
        let m = unsafe { libc::mallinfo2() };
        json!({"available":true,"kind":"glibc malloc","counts":"mallinfo2 over all arenas",
            "arena":m.arena,"uordblks":m.uordblks,"fordblks":m.fordblks,"hblkhd":m.hblkhd,"hblks":m.hblks})
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::updates::admission::AdmissionState;

        /// The idle path as before the held path: a record held or none. The
        /// times here are too short for a held check.
        fn idle(gate: &mut Gate, now: Instant, empty: bool, quiet: bool) -> bool {
            match gate.due(now, usize::from(!empty), quiet) {
                Some(Path::Held) => panic!("no held check within five minutes of being busy"),
                found => found == Some(Path::Idle),
            }
        }

        fn clock() -> impl Fn(u64) -> Instant {
            let start = Instant::now();
            move |seconds| start + Duration::from_secs(seconds)
        }

        #[test]
        fn short_pauses_and_busy_requests_do_not_consume_the_next_quiet_check() {
            let now = Instant::now();
            let mut gate = Gate::default();
            assert!(!idle(&mut gate, now, true, true));
            assert!(!idle(&mut gate, now + IDLE_GRACE - Duration::from_millis(1), true, true));
            assert!(!idle(&mut gate, now + IDLE_GRACE, true, false));
            assert!(idle(&mut gate, now + IDLE_GRACE, true, true));
            assert!(!idle(&mut gate, now + IDLE_GRACE, true, true));
            assert!(idle(&mut gate, now + IDLE_GRACE + INTERVAL, true, true));
            assert!(!idle(&mut gate, now + IDLE_GRACE + INTERVAL, false, true));
            assert!(!idle(&mut gate, now + IDLE_GRACE + INTERVAL, true, true));
            assert!(idle(&mut gate, now + IDLE_GRACE * 2 + INTERVAL, true, true));
        }

        #[test]
        fn a_record_held_on_gets_a_check_after_five_busy_minutes_and_then_every_five() {
            let at = clock();
            let mut gate = Gate::default();
            for s in [0, 60, 299] {
                assert_eq!(gate.due(at(s), 1, true), None, "{s}");
            }
            assert_eq!(gate.due(at(300), 1, true), Some(Path::Held));
            for s in [301, 330, 599] {
                assert_eq!(gate.due(at(s), 1, true), None, "{s}");
            }
            assert_eq!(gate.due(at(600), 1, true), Some(Path::Held));
            // Not quiet: nothing is checked, and nothing is used up.
            assert_eq!(gate.due(at(900), 1, false), None);
            assert_eq!((gate.last_check, gate.last_held_check), (Some(at(600)), Some(at(600))));
            assert_eq!(gate.due(at(901), 1, true), Some(Path::Held));
        }

        #[test]
        fn short_gaps_keep_the_busy_period_and_only_an_idle_check_ends_it() {
            let at = clock();
            let mut gate = Gate::default();
            // Held for 30 s, then none for 30 s, over and over: never a minute without.
            for s in (0..300).step_by(10) {
                let held = usize::from((s / 30) % 2 == 0);
                assert_eq!(gate.due(at(s), held, true), None, "{s}");
            }
            assert_eq!(gate.busy_since, Some(at(0)));
            assert_eq!(gate.due(at(300), 1, true), Some(Path::Held));
            // A whole minute with none held: the idle check runs, whatever it
            // finds, and ends the busy period; the next held record starts another.
            assert_eq!(gate.due(at(310), 0, true), None);
            assert_eq!(gate.due(at(369), 0, true), None);
            assert_eq!(gate.due(at(370), 0, true), Some(Path::Idle));
            assert_eq!(gate.busy_since, None);
            assert_eq!(gate.due(at(380), 1, true), None);
            assert_eq!(gate.busy_since, Some(at(380)));
            assert_eq!(gate.due(at(679), 1, true), None);
            assert_eq!(gate.due(at(680), 1, true), Some(Path::Held));
        }

        #[test]
        fn both_paths_keep_the_interval_between_any_two_checks() {
            let at = clock();
            let mut gate = Gate::default();
            assert_eq!(gate.due(at(0), 1, true), None);
            // None held for 50 s, after 300 s busy: the held path is due in the gap.
            assert_eq!(gate.due(at(250), 0, true), None);
            assert_eq!(gate.due(at(300), 0, true), Some(Path::Held));
            // A minute without held records, but only 10 s after that check.
            assert_eq!(gate.due(at(310), 0, true), None);
            assert_eq!(gate.due(at(330), 0, true), Some(Path::Idle));
        }

        #[test]
        fn requests_an_update_or_sealing_keep_both_paths_from_checking() {
            let at = clock();
            assert!(quiet(&AdmissionState { in_flight: 1, ..AdmissionState::default() }));
            for busy in [
                AdmissionState { in_flight: 2, ..AdmissionState::default() },
                AdmissionState { in_flight: 1, operation_id: Some("update".into()), sealed: false },
                AdmissionState { in_flight: 1, operation_id: None, sealed: true },
            ] {
                assert!(!quiet(&busy));
                let mut gate = Gate::default();
                assert_eq!(gate.due(at(0), 1, true), None);
                assert_eq!(gate.due(at(300), 1, quiet(&busy)), None);
                assert_eq!(gate.due(at(400), 0, quiet(&busy)), None);
                assert_eq!(gate.due(at(460), 0, quiet(&busy)), None);
                assert_eq!((gate.last_check, gate.last_held_check), (None, None));
            }
        }

        #[test]
        fn free_not_dominant_holds_back_only_the_held_path() {
            let mib = |n: usize| n << 20;
            let rss = Some(1u64 << 30);
            assert_eq!(verdict(Path::Held, mib(200), mib(300), rss, None), Some("freeNotDominant"));
            assert_eq!(verdict(Path::Idle, mib(200), mib(300), rss, None), None);
            assert_eq!(verdict(Path::Held, mib(300), mib(300), rss, None), None);
            for path in [Path::Idle, Path::Held] {
                assert_eq!(verdict(path, MIN_FREE - 1, 0, None, None), Some("freeBelowThreshold"));
                assert_eq!(verdict(path, MIN_FREE, 0, Some(600 << 20), Some(500 << 20)), Some("rssGrowthBelowThreshold"));
                assert_eq!(verdict(path, MIN_FREE, 0, Some(700 << 20), Some(500 << 20)), None);
            }
        }

        #[test]
        fn waiting_for_names_each_check_that_would_hold_a_trim_back_and_changes_nothing() {
            let now = Instant::now();
            let quiet = AdmissionState::default();
            let draining = AdmissionState { operation_id: Some("update".into()), in_flight: 0, sealed: true };
            let mut gate = Gate::default();
            // Never seen empty by the tick: the grace has not started.
            assert_eq!(gate.waiting_for(now, 0, 0, &quiet, None, None, None), ["idleGrace"]);
            assert_eq!(gate.waiting_for(now, 2, 1, &draining, Some(1), None, None),
                ["heldRecords", "heldGrace", "requestsInFlight", "updateOperation", "sealed", "freeBelowThreshold"]);
            gate.empty_since = Some(now);
            gate.last_check = Some(now);
            gate.last_reclaimed_rss = Some(500 << 20);
            let later = now + IDLE_GRACE;
            assert_eq!(gate.waiting_for(later, 0, 0, &quiet, Some(MIN_FREE), None, Some(600 << 20)), ["rssGrowthBelowThreshold"]);
            assert_eq!(gate.waiting_for(now + Duration::from_secs(1), 0, 0, &quiet, Some(MIN_FREE), None, Some(700 << 20)),
                ["idleGrace", "interval"]);
            assert!(gate.waiting_for(later, 0, 0, &quiet, Some(MIN_FREE), None, Some(700 << 20)).is_empty());
            // Reading it took nothing from the next real check.
            assert_eq!((gate.empty_since, gate.last_check), (Some(now), Some(now)));
            assert!(idle(&mut gate, later, true, true));
        }

        #[test]
        fn once_the_held_path_is_due_held_records_no_longer_hold_a_trim_back() {
            let at = clock();
            let quiet = AdmissionState::default();
            let mut gate = Gate::default();
            assert_eq!(gate.due(at(0), 1, true), None);
            assert_eq!(gate.waiting_for(at(10), 1, 0, &quiet, Some(MIN_FREE), Some(0), None), ["heldRecords", "heldGrace"]);
            assert_eq!(gate.next_path(at(300), 1), Some(Path::Held));
            assert!(gate.waiting_for(at(300), 1, 0, &quiet, Some(MIN_FREE), Some(0), None).is_empty());
            assert_eq!(gate.waiting_for(at(300), 1, 0, &quiet, Some(MIN_FREE), Some(MIN_FREE + 1), None), ["freeNotDominant"]);
            // Reading changed nothing; the tick's own check still comes.
            assert_eq!((gate.busy_since, gate.last_check, gate.last_held_check), (Some(at(0)), None, None));
            assert_eq!(gate.due(at(300), 1, true), Some(Path::Held));
            assert_eq!(gate.waiting_for(at(310), 1, 0, &quiet, Some(MIN_FREE), Some(0), None),
                ["heldRecords", "heldInterval", "interval"]);
        }
    }
}

/// Only after the Store's recent records have remained retired for a minute,
/// or, while records stay held, once every five minutes of being busy when
/// free arena space is at least what is in use (T-140). Checking is
/// advisory: quiet is a snapshot, and a new request or a streamed event can
/// arrive while trim is in progress and wait for an arena it is trimming.
/// It never waits for a busy record, delays admission, or drops data to force
/// an idle window. glibc can retain virtual arenas after returning their pages.
pub fn reclaim_if_idle(
    store: &crate::store::Store,
    admission: &crate::updates::admission::Admission,
) -> Option<Reclaim> {
    // The maintenance tick owns one completion permit. A cold Store read
    // can still be in progress before it puts any record in the cache.
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        platform::reclaim(store.streamed_records(), &admission.snapshot())
    }
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    {
        let _ = (store, admission);
        None
    }
}

/// The kernel's page counts for this process, in bytes; a count the kernel
/// does not give is null, never 0.
fn os_memory() -> Value {
    #[cfg(target_os = "linux")]
    {
        let Ok(status) = std::fs::read_to_string("/proc/self/status") else {
            return json!({"available":false,"reason":"The kernel's process status could not be read"});
        };
        let field = |key: &str| {
            status.lines().find_map(|line| line.strip_prefix(key)).and_then(|rest| rest.split_whitespace().next())
                .and_then(|value| value.parse::<u64>().ok())
        };
        let bytes = |key: &str| field(key).and_then(|kib| kib.checked_mul(1024));
        json!({"available":true,"counts":"kernel process status","rssBytes":bytes("VmRSS:"),"hwmBytes":bytes("VmHWM:"),
            "anonBytes":bytes("RssAnon:"),"fileBytes":bytes("RssFile:"),"shmemBytes":bytes("RssShmem:"),
            "swapBytes":bytes("VmSwap:"),"threads":field("Threads:")})
    }
    #[cfg(not(target_os = "linux"))]
    {
        json!({"available":false,"reason":"Read only on Linux"})
    }
}

/// What GET /api/diagnostics/memory reports. Each part is read in turn, so
/// together they are not one snapshot; nothing here clones or scans a
/// record, and nothing is written. `own_permit` says whether `in_flight`
/// counts this request's own admission permit.
pub fn diagnostics(
    store: &crate::store::Store,
    admission: &crate::updates::admission::Admission,
    own_permit: bool,
    tick_running: bool,
) -> Value {
    let read_at = chrono::Utc::now().to_rfc3339();
    let os = os_memory();
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    let allocator = platform::allocator();
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    let allocator = json!({"available":false,"reason":"Core reads allocator counts only from glibc malloc"});
    let held = store.streamed_records();
    let activity = admission.snapshot();
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    let mut reclaim = platform::status(
        held,
        activity.in_flight.saturating_sub(own_permit as usize),
        &activity,
        allocator["fordblks"].as_u64().and_then(|free| usize::try_from(free).ok()),
        allocator["uordblks"].as_u64().and_then(|used| usize::try_from(used).ok()),
        os["rssBytes"].as_u64(),
    );
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    let mut reclaim = json!({"available":false,"reason":"Core trims only glibc malloc, on Linux"});
    reclaim["maintenanceTickRunning"] = json!(tick_running);
    json!({"format":1,"readAt":read_at,
        "note":"Read on request, one part after another: not one atomic snapshot. The OS counts are the kernel's pages for this process; the allocator counts are glibc malloc's own, which include free space that need not be resident. Neither says how much could be returned.",
        "os":os,"allocator":allocator,
        "store":{"heldRecords":held,"maxHeldRecords":crate::store::MAX_STREAMS},
        "admission":{"inFlight":activity.in_flight,"includesThisRequest":own_permit,
            "updateOperation":activity.operation_id.is_some(),"sealed":activity.sealed},
        "reclaim":reclaim})
}

#[cfg(all(test, target_os = "linux", target_env = "gnu"))]
mod tests {
    use super::*;

    fn waiting(report: &Value) -> Option<Vec<String>> {
        // A trim in progress elsewhere in this process holds the gate.
        (report["reclaim"]["gateBusy"] == false).then(|| {
            report["reclaim"]["gate"]["waitingFor"].as_array().unwrap().iter().map(|w| w.as_str().unwrap().to_owned()).collect()
        })
    }

    #[test]
    fn its_own_permit_is_counted_but_is_not_another_request_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        let admission = std::sync::Arc::new(crate::updates::admission::Admission::default());
        let report = diagnostics(&store, &admission, false, false);
        assert_eq!(report["admission"]["inFlight"], 0);
        assert_eq!(report["allocator"]["available"], true);
        assert_eq!(report["reclaim"]["maintenanceTickRunning"], false);
        let own = admission.enter_completion().unwrap();
        let report = diagnostics(&store, &admission, true, true);
        assert_eq!((report["admission"]["inFlight"].clone(), report["admission"]["includesThisRequest"].clone()), (json!(1), json!(true)));
        assert_eq!(report["reclaim"]["maintenanceTickRunning"], true);
        if let Some(waiting) = waiting(&report) {
            assert!(!waiting.contains(&"requestsInFlight".to_owned()), "{waiting:?}");
        }
        let other = admission.enter_completion().unwrap();
        let report = diagnostics(&store, &admission, true, true);
        assert_eq!(report["admission"]["inFlight"], 2);
        if let Some(waiting) = waiting(&report) {
            assert!(waiting.contains(&"requestsInFlight".to_owned()), "{waiting:?}");
        }
        drop((own, other));
    }
}
