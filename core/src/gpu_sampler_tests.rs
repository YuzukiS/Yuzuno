use super::*;
use std::path::Path;

const GPU0: &str = "GPU-00000000-1111-2222-3333-444444444444";

/// A stand-in nvidia-smi: a burst of two rows every `-l` seconds or `-lms`
/// milliseconds, each saying there are two, 30 ms apart (so a reading kept
/// row by row would be seen half), the second device's name holding a comma
/// and its values unknown; each start noted in `starts` beside it. `mode` beside it: `once`
/// prints once and exits, `silent` exits at once with nothing, `truncated` loses the first
/// burst's first row and gives the second device's total as 16000 + the burst's number, `hang`
/// prints once and then neither prints nor exits.
fn stub(dir: &Path) -> PathBuf {
    let path = dir.join("nvidia-smi");
    std::fs::write(&path, format!(r#"#!/bin/sh
here=$(dirname "$0")
echo $$ >> "$here/starts"
every=1
while [ $# -gt 0 ]; do
  case "$1" in -l) every=$2; shift ;; -lms) every=$(awk "BEGIN {{ print $2 / 1000 }}"); shift ;; esac
  shift
done
mode=$(cat "$here/mode" 2>/dev/null)
[ "$mode" = silent ] && exit 3
n=0
while :; do
  if [ "$mode" != truncated ] || [ $n -gt 0 ]; then
    printf '2, 0, {GPU0}, Stub GPU, 32607, 16000, 16607, %s\n' $((n % 100))
  fi
  sleep 0.03
  second=16376
  [ "$mode" = truncated ] && second=$((16000 + n))
  printf '2, 1, GPU-55555555-6666-7777-8888-999999999999, Stub, Second, %s, [N/A], [N/A], [N/A]\n' $second
  n=$((n + 1))
  [ "$mode" = once ] && exit 0
  [ "$mode" = hang ] && exec sleep 1000
  sleep "$every"
done
"#)).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn config(dir: &Path) -> Config {
    Config { nvml: vec![], smi: vec![stub(dir)], interval: Duration::from_millis(50), idle: Duration::from_millis(400),
        retry: Duration::from_secs(60), backoff: Duration::from_millis(50) }
}

fn starts(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("starts")).unwrap_or_default().lines().map(str::to_owned).collect()
}

fn alive(pid: &str) -> bool {
    pid.parse().is_ok_and(crate::test_platform::running)
}

const WAIT: Duration = Duration::from_secs(2);

/// `config` without its 400 ms idle stop, for a test whose reads must all
/// fall in one session: a read that starts a session waits for its first
/// reading without reading again, and on a loaded runner the stand-in's
/// first whole burst can come later than 400 ms (macOS CI 43544818577: the
/// session stopped idle before it, YN-122).
fn without_idle_stop(dir: &Path) -> Config {
    Config { idle: Duration::from_secs(60), ..config(dir) }
}

/// How long a test waits for a session's first reading where how soon it
/// comes is not what the test checks: a bound for a run that hangs, not a
/// time the stand-in must keep (YN-122).
const FIRST: Duration = Duration::from_secs(30);

/// nvidia-smi's rows, read from both ends: how many devices the burst has,
/// a name that may hold a comma, and `[N/A]` as unknown, not zero.
#[test]
fn a_row_is_read_from_both_ends_and_n_a_is_unknown() {
    assert_eq!(parse_row(&format!("1, 0, {GPU0}, NVIDIA GeForce RTX 5090, 32607, 16972, 15215, 15")), Some((1, Device {
        index: 0, uuid: GPU0.into(), name: "NVIDIA GeForce RTX 5090".into(), memory_total_mib: Some(32607),
        memory_free_mib: Some(16972), memory_used_mib: Some(15215), utilization_percent: Some(15) })));
    let (count, odd) = parse_row("2, 1, GPU-5, Stub, Second, 16376, [N/A], [N/A], [N/A]").unwrap();
    assert_eq!(count, 2);
    assert_eq!(odd.name, "Stub, Second");
    assert_eq!((odd.memory_total_mib, odd.memory_free_mib, odd.memory_used_mib, odd.utilization_percent),
        (Some(16376), None, None, None), "[N/A] is unknown, not zero");
    for bad in ["", "x, y", "1, 0, GPU-0, 1, 2, 3, 4", "0, GPU-0, Name, 1, 2, 3, 4"] {
        assert_eq!(parse_row(bad), None, "{bad:?}");
    }
}

/// Every read, however many and from whichever reader, shares one session
/// and its one nvidia-smi child (T-58): no new process per read. Each reading
/// is a whole burst, every device in it (PR CI 42171082428 found readings
/// kept row by row).
#[tokio::test]
async fn every_read_shares_one_session_and_one_child() {
    let dir = tempfile::tempdir().unwrap();
    let sampler = GpuSampler::new(without_idle_stop(dir.path()));
    let mut seen = std::collections::BTreeSet::new();
    // At least 60 reads, 20 ms apart, and on until it has sampled on its own
    // six times: how fast the stand-in prints is the runner's, not the
    // sampler's (a loaded macOS runner printed 5 bursts in 60 reads, YN-122).
    let (mut reads, until) = (0, Instant::now() + FIRST);
    while reads < 60 || (seen.len() <= 5 && Instant::now() < until) {
        let sample = sampler.latest(FIRST).await.expect("a reading");
        assert_eq!((sample.source, sample.devices.len()), ("nvidia-smi", 2), "each reading is a whole burst, every device in it");
        seen.insert(sample.observed_at);
        reads += 1;
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(seen.len() > 5, "it samples on its own between reads: {}", seen.len());
    assert_eq!(starts(dir.path()).len(), 1, "one nvidia-smi child across every read: {:?}", starts(dir.path()));
    assert_eq!((sampler.sessions(), sampler.children(), sampler.attempts()), (1, 1, 1));
    let pid = starts(dir.path()).remove(0);
    drop(sampler);
    for _ in 0..100 {
        if !alive(&pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!alive(&pid), "the child ends with its sampler");
}

/// A burst that lost a row is dropped, not completed with the next burst's
/// rows: every reading is one burst (R1 3183117d's note).
#[tokio::test]
async fn a_burst_missing_a_row_is_dropped_not_completed_with_the_next() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("mode"), "truncated").unwrap();
    // Its first whole reading is the stand-in's second burst.
    let sampler = GpuSampler::new(without_idle_stop(dir.path()));
    let first = sampler.latest(FIRST).await.expect("a reading");
    assert_eq!(first.devices.len(), 2, "{first:?}");
    let burst = |sample: &Sample| (sample.devices[0].utilization_percent, sample.devices[1].memory_total_mib.map(|total| total - 16000));
    assert_eq!(burst(&first), (Some(1), Some(1)), "a reading never mixes two bursts");
    for _ in 0..10 {
        let sample = sampler.latest(WAIT).await.expect("a reading");
        let (utilization, second) = burst(&sample);
        assert_eq!(utilization.map(u64::from), second, "a reading never mixes two bursts");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A child that neither prints nor exits (stuck in the driver) is ended once
/// it has given no reading for three intervals and a second, and the next
/// read starts a new session (R1 b075ef6f).
#[tokio::test]
async fn a_child_that_stops_printing_is_ended_and_started_again() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("mode"), "hang").unwrap();
    let sampler = GpuSampler::new(Config { idle: Duration::from_secs(60), ..config(dir.path()) });
    let first = sampler.latest(WAIT).await.expect("a reading");
    let until = Instant::now() + Duration::from_secs(10);
    while (sampler.sessions() < 2 || starts(dir.path()).len() < 2) && Instant::now() < until {
        let _ = sampler.latest(Duration::from_millis(100)).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let pids = starts(dir.path());
    assert_eq!((sampler.sessions(), pids.len()), (2, 2), "a hung child is ended and a new session started");
    assert!(!alive(&pids[0]), "the hung child is gone");
    // Session 2 may have started without its first reading published yet:
    // `latest` returns the cache then, so read until the reading changes.
    let until = Instant::now() + WAIT;
    let mut again = sampler.latest(WAIT).await.expect("a reading");
    while again.observed_at == first.observed_at && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
        again = sampler.latest(WAIT).await.expect("a reading");
    }
    assert_ne!(again.observed_at, first.observed_at, "readers get a new reading");
}

/// With nothing reading it, a hung child is ended at the idle stop: the
/// session does not wait for a line to look.
#[tokio::test]
async fn with_no_readers_a_hung_child_is_ended_at_the_idle_stop() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("mode"), "hang").unwrap();
    let sampler = GpuSampler::new(Config { interval: Duration::from_millis(200), idle: Duration::from_millis(300), ..config(dir.path()) });
    let read_at = Instant::now();
    assert!(sampler.latest(WAIT).await.is_some());
    let pid = starts(dir.path()).remove(0);
    while alive(&pid) && read_at.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let gone = read_at.elapsed();
    assert!(!alive(&pid) && gone < Duration::from_millis(1200), "a hung child is ended at the idle stop with no readers: {gone:?}");
    for _ in 0..50 {
        if !sampler.running() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!sampler.running(), "its session stopped");
}

/// With nothing reading it, a session stops, its child ended; the next
/// read starts one again.
#[tokio::test]
async fn an_idle_sampler_stops_and_starts_again_on_the_next_read() {
    let dir = tempfile::tempdir().unwrap();
    let sampler = GpuSampler::new(config(dir.path()));
    assert!(sampler.latest(WAIT).await.is_some());
    let first = starts(dir.path()).remove(0);
    for _ in 0..100 {
        if !sampler.running() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!sampler.running(), "stopped after nothing read it");
    for _ in 0..100 {
        if !alive(&first) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!alive(&first), "its child ended");
    let again = sampler.latest(WAIT).await.expect("a reading");
    assert_eq!((again.source, starts(dir.path()).len(), sampler.sessions()), ("nvidia-smi", 2, 2),
        "a read after the idle stop starts it again");
}

/// A child that exits after giving readings is started again after a
/// backoff that doubles, never at once. When each start is recorded, not a
/// time the runner must keep: the stand-in appends its pid first thing, so
/// the gaps below are the sampler's backoff (plus the stand-in's own exit),
/// and a loaded runner only makes them longer.
#[tokio::test]
async fn a_child_that_exits_is_started_again_after_a_backoff() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("mode"), "once").unwrap();
    let sampler = GpuSampler::new(config(dir.path()));
    let mut at: Vec<Instant> = Vec::new();
    let until = Instant::now() + Duration::from_secs(30);
    while at.len() < 3 && Instant::now() < until {
        // Whole lines only: a poll can catch a pid mid-append.
        let seen = std::fs::read_to_string(dir.path().join("starts")).unwrap_or_default().matches('\n').count();
        while at.len() < seen {
            at.push(Instant::now());
        }
        let _ = sampler.latest(Duration::from_millis(100)).await;
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert!(at.len() >= 3, "started again after a backoff: {} starts", at.len());
    let (first, second) = (at[1] - at[0], at[2] - at[1]);
    // 50 ms, then 100 ms after the stand-in has ended (it takes a few ms to
    // exit after its reading, which only lengthens the gap).
    assert!(first >= Duration::from_millis(40), "the second start came at once: {first:?}");
    assert!(second >= Duration::from_millis(90), "the backoff did not double: {second:?}");
}

/// With neither NVML nor nvidia-smi, the sampler says why and is not tried
/// again within its retry; a child that gives no reading counts the same.
#[tokio::test]
async fn with_no_nvml_and_no_nvidia_smi_nothing_is_tried_again_for_a_minute() {
    let dir = tempfile::tempdir().unwrap();
    let none = GpuSampler::new(Config { nvml: vec![dir.path().join("libnvidia-ml.so.1")], smi: vec![dir.path().join("no-such-smi")],
        ..config(dir.path()) });
    let sample = none.latest(WAIT).await.expect("a reading that says why");
    assert!(sample.devices.is_empty() && sample.error.as_deref().is_some_and(|e| e.contains("NVML") && e.contains("nvidia-smi")), "{sample:?}");
    for _ in 0..20 {
        let _ = none.latest(WAIT).await;
    }
    assert_eq!((none.attempts(), none.sessions()), (1, 0), "not tried again within the retry");

    std::fs::write(dir.path().join("mode"), "silent").unwrap();
    let silent = GpuSampler::new(config(dir.path()));
    assert!(silent.latest(WAIT).await.is_some_and(|s| s.devices.is_empty() && s.error.is_some()));
    for _ in 0..20 {
        let _ = silent.latest(WAIT).await;
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(starts(dir.path()).len(), 1, "a child that gives no reading is not started again within the retry");
}

/// The load and Jobs read the same sample: /api/machine-load's GPUs and the
/// Jobs GPU view report one reading and its observedAt (T-58, D3), and both
/// come from one child.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_load_and_jobs_report_one_sample_and_its_observed_at() {
    let dir = tempfile::tempdir().unwrap();
    let ws = crate::workspace::Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.gpus.configure(Config { interval: Duration::from_secs(5), idle: Duration::from_secs(60), ..config(dir.path()) });
    let load = ws.machine_load().await.unwrap();
    // Two Jobs reads at once, the first to keep this reading: each finds it kept.
    let (gpus, beside) = tokio::join!(crate::jobs::call(ws.clone(), None, "job_gpus".into(), json!({})),
        crate::jobs::call(ws.clone(), None, "job_gpus".into(), json!({})));
    let (gpus, beside) = (gpus.unwrap(), beside.unwrap());
    assert_eq!((&gpus["problem"], &beside["problem"]), (&Value::Null, &Value::Null), "a read alongside finds the reading kept");
    let loaded = &load["gpus"][0];
    assert_eq!((&loaded["name"], &loaded["utilPct"], &loaded["source"]), (&json!("Stub GPU"), &json!(0), &json!("nvidia-smi")));
    assert_eq!(load["gpus"].as_array().map(Vec::len), Some(1), "a device with unknown values is left out of the load");
    assert_eq!((&gpus["source"], &gpus["read"]), (&json!("nvidia-smi"), &json!("latest")));
    assert_eq!(gpus["devices"][0]["uuid"], GPU0);
    assert_eq!(gpus["observedAt"], loaded["observedAt"], "the load and Jobs report one sample and its observedAt");
    assert_eq!(starts(dir.path()).len(), 1, "from one child");
}

/// Nothing in Core but this module talks to nvidia-smi or NVML (T-58, the
/// user's rule): no other runtime source names them, and no Core code asks
/// the host helper for GPUs.
#[test]
fn only_the_sampler_talks_to_nvidia_smi_or_nvml() {
    fn files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files(&path, out);
            } else {
                out.push(path);
            }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut all = Vec::new();
    files(&root, &mut all);
    let test = |path: &Path| {
        let name = path.file_name().unwrap().to_string_lossy();
        name.ends_with("_tests.rs") || name == "tests.rs" || name.ends_with("_tests.py") || name.ends_with("_test.py")
            || path.components().any(|c| matches!(c.as_os_str().to_str(), Some("tests" | "run_tests")))
    };
    let mut offenders = Vec::new();
    let mut helper_asked = Vec::new();
    for path in all.iter().filter(|p| !test(p) && p.file_name().is_some_and(|n| n != "gpu_sampler.rs")) {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        for needle in ["nvidia-smi", "nvmlInit", "libnvidia-ml"] {
            if text.contains(needle) {
                offenders.push(format!("{} names {needle}", path.strip_prefix(&root).unwrap().display()));
            }
        }
        if text.lines().any(|line| line.contains("invoke(") && line.contains("\"gpus\"")) || text.contains("mode == 'gpus'") {
            helper_asked.push(path.strip_prefix(&root).unwrap().display().to_string());
        }
    }
    assert!(all.len() > 50, "the source tree was read: {} files", all.len());
    assert_eq!(offenders, Vec::<String>::new(), "only gpu_sampler.rs talks to nvidia-smi or NVML");
    assert_eq!(helper_asked, Vec::<String>::new(), "no Core code asks the host helper for gpus");
}
