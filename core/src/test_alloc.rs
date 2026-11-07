//! The test binary's allocator: the system's, watched. Only a test process
//! of its own arms or counts it, since every test in a process shares it.
//!
//! Armed, it refuses any one allocation past ARMED_LIMIT and keeps the
//! largest asked for: it shows what Core asks of memory to keep an image
//! whose header lies, without the machine being asked for it (T-19 HM:B14,
//! project_brief's `kept_apart`). Counting, it keeps how far the bytes in use
//! grew past where counting began, at most, and the largest allocation: what
//! serving a preview costs (YN-10, remote_access's tests).
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicUsize, Ordering::{Relaxed, SeqCst}};

pub(crate) static ARMED: AtomicBool = AtomicBool::new(false);
pub(crate) static LARGEST: AtomicUsize = AtomicUsize::new(0);
pub(crate) const ARMED_LIMIT: usize = 16 << 20;

static COUNTING: AtomicBool = AtomicBool::new(false);
/// Bytes allocated less bytes freed since counting began, and its highest.
static GROWN: AtomicIsize = AtomicIsize::new(0);
static PEAK: AtomicIsize = AtomicIsize::new(0);
static BIGGEST: AtomicUsize = AtomicUsize::new(0);

fn refused(size: usize) -> bool {
    if !ARMED.load(Relaxed) {
        return false;
    }
    LARGEST.fetch_max(size, Relaxed);
    size > ARMED_LIMIT
}

/// `change` more bytes in use, by an allocation of `size`.
fn counted(change: isize, size: usize) {
    if COUNTING.load(Relaxed) {
        let now = GROWN.fetch_add(change, Relaxed) + change;
        PEAK.fetch_max(now, Relaxed);
        BIGGEST.fetch_max(size, Relaxed);
    }
}

struct Watched;
unsafe impl GlobalAlloc for Watched {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if refused(layout.size()) {
            return std::ptr::null_mut();
        }
        counted(layout.size() as isize, layout.size());
        System.alloc(layout)
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if refused(layout.size()) {
            return std::ptr::null_mut();
        }
        counted(layout.size() as isize, layout.size());
        System.alloc_zeroed(layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if refused(size) {
            return std::ptr::null_mut();
        }
        counted(size as isize - layout.size() as isize, size);
        System.realloc(ptr, layout, size)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        counted(-(layout.size() as isize), 0);
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static WATCHED: Watched = Watched;

/// Counting from now, from zero.
pub(crate) fn count() {
    GROWN.store(0, SeqCst);
    PEAK.store(0, SeqCst);
    BIGGEST.store(0, SeqCst);
    COUNTING.store(true, SeqCst);
}

/// Counting stopped: how far the bytes in use grew at most, and the largest
/// allocation, since `count`.
pub(crate) fn counted_so_far() -> (isize, usize) {
    COUNTING.store(false, SeqCst);
    (PEAK.load(SeqCst), BIGGEST.load(SeqCst))
}
