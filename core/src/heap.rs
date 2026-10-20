//! Return large, freed allocator pages from long-history bursts to the OS.
//! This never drops records or changes a cache's lifetime. Call only from
//! background blocking maintenance, after Store locks have been released.

/// Keep freed pages warm through short thinking/typing pauses. Cold records
/// need to fault these pages in again, so reclaim is for a longer idle gap.
pub const IDLE_GRACE: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Debug, serde::Serialize)]
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
    }
    // Process-wide; a competing maintenance tick never waits for a trim.
    static GATE: Mutex<Gate> = Mutex::new(Gate {
        empty_since: None,
        last_check: None,
        last_reclaimed_rss: None,
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
        // Rate-limit checks too, including below-threshold/no-release checks.
        // SAFETY: glibc's allocator introspection and trim are thread-safe.
        // Only free chunks are returned; no pointer into a live object changes.
        let free = unsafe { libc::mallinfo2() }.fordblks;
        if free < MIN_FREE {
            return None;
        }
        let rss_before_bytes = rss();
        // madvise can leave the virtual free arena size unchanged. Avoid
        // repeatedly scanning already-reclaimed pages while nothing grows.
        if let (Some(current), Some(previous)) = (rss_before_bytes, gate.last_reclaimed_rss) {
            if current.saturating_sub(previous) < MIN_FREE as u64 {
                return None;
            }
        }
        let started_at = chrono::Utc::now();
        let started = Instant::now();
        let released = unsafe { libc::malloc_trim(0) } != 0;
        let elapsed_micros = started.elapsed().as_micros();
        let rss_after_bytes = rss();
        gate.last_reclaimed_rss = rss_after_bytes;
        Some(Reclaim {
            started_at: started_at.to_rfc3339(),
            in_flight: activity.in_flight,
            free_arena_bytes: free,
            released_pages: released,
            elapsed_micros,
            rss_before_bytes,
            rss_after_bytes,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;
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
