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

    const INTERVAL: Duration = Duration::from_secs(30);
    const MIN_FREE: usize = 128 * 1024 * 1024;
    #[derive(Default)]
    struct Gate {
        empty_since: Option<Instant>,
        last_check: Option<Instant>,
        last_reclaimed_rss: Option<u64>,
        /// What the last check that got past the time gate found.
        last_outcome: Option<Value>,
    }
    // Process-wide; a competing maintenance tick never waits for a trim.
    static GATE: Mutex<Gate> = Mutex::new(Gate {
        empty_since: None,
        last_check: None,
        last_reclaimed_rss: None,
        last_outcome: None,
    });

    impl Gate {
        fn due(&mut self, now: Instant, empty: bool, quiet: bool) -> bool {
            if !empty {
                self.empty_since = None;
                return false;
            }
            let since = *self.empty_since.get_or_insert(now);
            if !quiet
                || now.saturating_duration_since(since) < IDLE_GRACE
                || self
                    .last_check
                    .is_some_and(|last| now.saturating_duration_since(last) < INTERVAL)
            {
                return false;
            }
            self.last_check = Some(now);
            true
        }

        /// Which of the checks `due` and `reclaim` make would hold a trim
        /// back now, without recording anything: `others` counts permits
        /// other than the maintenance tick's own.
        fn waiting_for(&self, now: Instant, held: usize, others: usize, activity: &crate::updates::admission::AdmissionState,
            free: Option<usize>, rss: Option<u64>) -> Vec<&'static str> {
            let mut waiting = Vec::new();
            if held > 0 {
                waiting.push("heldRecords");
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
            if held == 0 && self.empty_since.is_none_or(|since| now.saturating_duration_since(since) < IDLE_GRACE) {
                waiting.push("idleGrace");
            }
            if self.last_check.is_some_and(|last| now.saturating_duration_since(last) < INTERVAL) {
                waiting.push("interval");
            }
            if free.is_some_and(|free| free < MIN_FREE) {
                waiting.push("freeBelowThreshold");
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
        empty: bool,
        activity: &crate::updates::admission::AdmissionState,
    ) -> Option<Reclaim> {
        let mut gate = GATE.try_lock().ok()?;
        let quiet = activity.in_flight == 1 && activity.operation_id.is_none() && !activity.sealed;
        if !gate.due(Instant::now(), empty, quiet) {
            return None;
        }
        let checked_at = chrono::Utc::now().to_rfc3339();
        // Rate-limit checks too, including below-threshold/no-release checks.
        // SAFETY: glibc's allocator introspection and trim are thread-safe.
        // Only free chunks are returned; no pointer into a live object changes.
        let free = unsafe { libc::mallinfo2() }.fordblks;
        if free < MIN_FREE {
            gate.last_outcome = Some(json!({"at":checked_at,"result":"freeBelowThreshold","fordblks":free}));
            return None;
        }
        let rss_before_bytes = rss();
        // madvise can leave the virtual free arena size unchanged. Avoid
        // repeatedly scanning already-reclaimed pages while nothing grows.
        if let (Some(current), Some(previous)) = (rss_before_bytes, gate.last_reclaimed_rss) {
            if current.saturating_sub(previous) < MIN_FREE as u64 {
                gate.last_outcome = Some(json!({"at":checked_at,"result":"rssGrowthBelowThreshold","fordblks":free,
                    "rssBytes":current,"lastReclaimedRssBytes":previous}));
                return None;
            }
        }
        let started_at = chrono::Utc::now();
        let started = Instant::now();
        let released = unsafe { libc::malloc_trim(0) } != 0;
        let elapsed_micros = started.elapsed().as_micros();
        let rss_after_bytes = rss();
        gate.last_reclaimed_rss = rss_after_bytes;
        let reclaim = Reclaim {
            started_at: started_at.to_rfc3339(),
            in_flight: activity.in_flight,
            free_arena_bytes: free,
            released_pages: released,
            elapsed_micros,
            rss_before_bytes,
            rss_after_bytes,
        };
        gate.last_outcome = Some(json!({"at":checked_at,"result":"trimmed","reclaim":reclaim}));
        Some(reclaim)
    }

    /// The policy and what holds it back now. A trim in progress holds the
    /// gate; this never waits for it.
    pub(super) fn status(held: usize, others: usize, activity: &crate::updates::admission::AdmissionState,
        free: Option<usize>, rss: Option<u64>) -> Value {
        let policy = json!({"idleGraceSeconds":IDLE_GRACE.as_secs(),"intervalSeconds":INTERVAL.as_secs(),
            "minFordblks":MIN_FREE,"minRssGrowthBytes":MIN_FREE});
        let Ok(gate) = GATE.try_lock() else {
            return json!({"available":true,"policy":policy,"gate":null,"gateBusy":true});
        };
        let now = Instant::now();
        let seconds = |at: Option<Instant>| at.map(|at| now.saturating_duration_since(at).as_secs_f64());
        json!({"available":true,"policy":policy,"gateBusy":false,"gate":{
            "heldEmptyForSeconds":if held == 0 { seconds(gate.empty_since) } else { None },
            "sinceLastCheckSeconds":seconds(gate.last_check),
            "lastReclaimedRssBytes":gate.last_reclaimed_rss,
            "waitingFor":gate.waiting_for(now, held, others, activity, free, rss),
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
        #[test]
        fn short_pauses_and_busy_requests_do_not_consume_the_next_quiet_check() {
            let now = Instant::now();
            let mut gate = Gate::default();
            assert!(!gate.due(now, true, true));
            assert!(!gate.due(now + IDLE_GRACE - Duration::from_millis(1), true, true));
            assert!(!gate.due(now + IDLE_GRACE, true, false));
            assert!(gate.due(now + IDLE_GRACE, true, true));
            assert!(!gate.due(now + IDLE_GRACE, true, true));
            assert!(gate.due(now + IDLE_GRACE + INTERVAL, true, true));
            assert!(!gate.due(now + IDLE_GRACE + INTERVAL, false, true));
            assert!(!gate.due(now + IDLE_GRACE + INTERVAL, true, true));
            assert!(gate.due(now + IDLE_GRACE * 2 + INTERVAL, true, true));
        }

        #[test]
        fn waiting_for_names_each_check_that_would_hold_a_trim_back_and_changes_nothing() {
            let now = Instant::now();
            let quiet = AdmissionState::default();
            let draining = AdmissionState { operation_id: Some("update".into()), in_flight: 0, sealed: true };
            let mut gate = Gate::default();
            // Never seen empty by the tick: the grace has not started.
            assert_eq!(gate.waiting_for(now, 0, 0, &quiet, None, None), ["idleGrace"]);
            assert_eq!(gate.waiting_for(now, 2, 1, &draining, Some(1), None),
                ["heldRecords", "requestsInFlight", "updateOperation", "sealed", "freeBelowThreshold"]);
            gate.empty_since = Some(now);
            gate.last_check = Some(now);
            gate.last_reclaimed_rss = Some(500 << 20);
            let later = now + IDLE_GRACE;
            assert_eq!(gate.waiting_for(later, 0, 0, &quiet, Some(MIN_FREE), Some(600 << 20)), ["rssGrowthBelowThreshold"]);
            assert_eq!(gate.waiting_for(now + Duration::from_secs(1), 0, 0, &quiet, Some(MIN_FREE), Some(700 << 20)),
                ["idleGrace", "interval"]);
            assert!(gate.waiting_for(later, 0, 0, &quiet, Some(MIN_FREE), Some(700 << 20)).is_empty());
            // Reading it took nothing from the next real check.
            assert_eq!((gate.empty_since, gate.last_check), (Some(now), Some(now)));
            assert!(gate.due(later, true, true));
        }
    }
}

/// Only after the Store's recent records have remained retired for a minute.
/// Checking is advisory: a new request can arrive while trim is in progress.
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
        platform::reclaim(store.streamed_records() == 0, &admission.snapshot())
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
