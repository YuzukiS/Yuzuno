//! What tests see of the platform they run on, the same on Linux and macOS
//! (YN-108).

use std::ffi::OsString;
use std::path::Path;

/// Process `pid` exists and is not a zombie: the kernel says whether it
/// exists (ESRCH when not), and `ps` whether it is a zombie its parent has
/// yet to reap. /proc, which macOS does not have, is not read.
pub(crate) fn running(pid: i64) -> bool {
    let Some(id) = i32::try_from(pid).ok().and_then(rustix::process::Pid::from_raw) else {
        return false;
    };
    if rustix::process::test_kill_process(id) == Err(rustix::io::Errno::SRCH) {
        return false;
    }
    // EPERM (another account's) is a process too. `ps` prints nothing for
    // one that has gone since.
    let state = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .unwrap_or_default();
    !state.is_empty() && !state.starts_with(['Z', 'X'])
}

/// The names in a test's home folder, sorted, leaving out only what macOS's
/// own Python writes there: Apple's `/usr/bin/python3` keeps its bytecode
/// cache in `~/Library/Caches/com.apple.python`, so a helper it runs leaves
/// that on any Mac. A `Library` holding anything else is kept.
pub(crate) fn home_entries(home: &Path) -> Vec<OsString> {
    let names = |dir: &Path| -> Vec<OsString> {
        let mut names: Vec<_> = std::fs::read_dir(dir).map(|entries| entries.flatten().map(|e| e.file_name()).collect()).unwrap_or_default();
        names.sort();
        names
    };
    let mut found = names(home);
    let library = home.join("Library");
    if cfg!(target_os = "macos") && names(&library) == ["Caches"] && names(&library.join("Caches")) == ["com.apple.python"] {
        found.retain(|name| name != "Library");
    }
    found
}
