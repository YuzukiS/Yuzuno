use super::*;
use std::path::Path;

const GPU0: &str = "GPU-00000000-1111-2222-3333-444444444444";

/// A stand-in nvidia-smi: a burst of two rows every `-l` seconds or `-lms`
/// milliseconds, each saying there are two, 30 ms apart (so a reading kept
/// row by row would be seen half), the second device's name holding a comma
/// and its values unknown; each start noted in `starts` beside it, and its own
/// time as the creation time of the `times/<n>` file it makes first. `mode` beside it: `once`
/// prints once and exits, `silent` exits at once with nothing, `truncated` loses the first
/// burst's first row and gives the second device's total as 16000 + the burst's number, `hang`
/// prints once and then neither prints nor exits.
fn stub(dir: &Path) -> PathBuf {
    let path = dir.join("nvidia-smi");
    std::fs::write(&path, format!(r#"#!/bin/sh
here=$(dirname "$0")
n=0
# BSD wc pads its count; strip it before $(( )).
[ -f "$here/starts" ] && n=$(wc -l < "$here/starts" | tr -d ' ')
mkdir -p "$here/times"
: > "$here/times/$((n + 1))"
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

/// When each start happened, as the stand-in recorded it: every start creates
/// `times/<n>` first thing, so its creation time is the start's own, not the
/// moment a reader noticed it. A reader's poll is late by up to its whole
/// `latest` wait, and two starts can fall in one poll (Linux CI 43642940734:
/// the second gap measured 42 ms where the backoff was 100 ms).
fn start_times(dir: &Path) -> Vec<std::time::SystemTime> {
    (1..).map_while(|n| std::fs::metadata(dir.join("times").join(n.to_string())).ok().and_then(|m| m.modified().ok())).collect()
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
/// backoff that doubles, never at once. Each gap is between the two starts
/// themselves, as the stand-in recorded them, so a runner that is slow to
/// notice a start still measures the sampler's backoff (plus the stand-in's
/// own exit, which only makes the gap longer).
#[tokio::test]
async fn a_child_that_exits_is_started_again_after_a_backoff() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("mode"), "once").unwrap();
    let sampler = GpuSampler::new(config(dir.path()));
    let until = Instant::now() + Duration::from_secs(30);
    while start_times(dir.path()).len() < 3 && Instant::now() < until {
        // A read starts the next session once its backoff has passed, and
        // keeps the idle stop from ending it meanwhile.
        let _ = sampler.latest(Duration::from_millis(100)).await;
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let times = start_times(dir.path());
    assert!(times.len() >= 3, "started again after a backoff: {} starts", times.len());
    let (first, second) = (
        times[1].duration_since(times[0]).unwrap_or_default(),
        times[2].duration_since(times[1]).unwrap_or_default(),
    );
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

/// What the T-58 guard finds under a source root: files that talk to
/// nvidia-smi or NVML where they may not, and Core code that asks the host
/// helper for GPUs. Allowed: gpu_sampler.rs, and the remote program
/// (remote_service/program.py, the user's one exception, YN-83 S2 PR5),
/// which may name nvidia-smi exactly once, inside its `def gpu_child`, and
/// never NVML. Tests are not runtime sources and are not read.
fn gpu_talkers(root: &Path) -> (Vec<String>, Vec<String>, usize) {
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
    let mut all = Vec::new();
    files(root, &mut all);
    let test = |path: &Path| {
        let name = path.file_name().unwrap().to_string_lossy();
        name.ends_with("_tests.rs") || name == "tests.rs" || name.ends_with("_tests.py") || name.ends_with("_test.py")
            || path.components().any(|c| matches!(c.as_os_str().to_str(), Some("tests" | "run_tests")))
    };
    let program = root.join("remote_service").join("program.py");
    let mut offenders = Vec::new();
    let mut helper_asked = Vec::new();
    for path in all.iter().filter(|p| !test(p) && p.file_name().is_some_and(|n| n != "gpu_sampler.rs")) {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        let shown = path.strip_prefix(root).unwrap().display().to_string();
        let lines: Vec<&str> = text.lines().collect();
        for needle in ["nvidia-smi", "nvmlInit", "libnvidia-ml"] {
            let at: Vec<usize> = lines.iter().enumerate().filter(|(_, line)| line.contains(needle)).map(|(n, _)| n).collect();
            if at.is_empty() {
                continue;
            }
            if *path == program && needle == "nvidia-smi" {
                // One line, inside the body of `def gpu_child`: from its def
                // to the next line that is not indented (or blank).
                let def = lines.iter().position(|line| line.starts_with("def gpu_child("));
                let body = def.map(|def| {
                    let end = lines[def + 1..].iter().position(|line| !line.is_empty() && !line.starts_with(char::is_whitespace)).map_or(lines.len(), |n| def + 1 + n);
                    def + 1..end
                });
                let once = at.len() == 1 && lines[at[0]].matches(needle).count() == 1;
                if once && body.is_some_and(|body| body.contains(&at[0])) {
                    continue;
                }
                offenders.push(format!("{shown} names {needle} outside one line of def gpu_child (lines {at:?})"));
                continue;
            }
            offenders.push(format!("{shown} names {needle}"));
        }
        if text.lines().any(|line| line.contains("invoke(") && line.contains("\"gpus\"")) || text.contains("mode == 'gpus'") {
            helper_asked.push(shown);
        }
    }
    (offenders, helper_asked, all.len())
}

/// Nothing in Core but this module talks to nvidia-smi or NVML (T-58, the
/// user's rule), except the remote program's one `gpu_child` (the user's
/// exception, YN-83 S2 PR5): no other runtime source names them, and no Core
/// code asks the host helper for GPUs.
#[test]
fn only_the_sampler_talks_to_nvidia_smi_or_nvml() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let (offenders, helper_asked, files) = gpu_talkers(&root);
    assert!(files > 50, "the source tree was read: {files} files");
    assert!(root.join("remote_service/program.py").exists());
    assert_eq!(offenders, Vec::<String>::new(), "only gpu_sampler.rs and program.py's gpu_child talk to nvidia-smi or NVML");
    assert_eq!(helper_asked, Vec::<String>::new(), "no Core code asks the host helper for gpus");
}

/// The guard itself, over a small tree: it lets the exception through as it
/// is and fails on a second mention in program.py, one outside gpu_child,
/// NVML there, or any other file.
#[test]
fn the_gpu_guard_allows_only_one_line_of_gpu_child() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("remote_service")).unwrap();
    std::fs::write(root.join("gpu_sampler.rs"), "// nvidia-smi nvmlInit libnvidia-ml\n").unwrap();
    std::fs::write(root.join("remote_service/program_tests.py"), "nvidia-smi\n").unwrap();
    let allowed = "import os\n\n\ndef gpu_child():\n    \"\"\"The one place.\"\"\"\n\n    tool = \"nvidia-smi\"\n    return [tool]\n\n\ndef other():\n    return None\n";
    let check = |program: &str, other: Option<&str>| {
        std::fs::write(root.join("remote_service/program.py"), program).unwrap();
        match other {
            Some(text) => std::fs::write(root.join("remote_service/link.rs"), text).unwrap(),
            None => {
                let _ = std::fs::remove_file(root.join("remote_service/link.rs"));
            }
        }
        gpu_talkers(root).0
    };
    assert_eq!(check(allowed, None), Vec::<String>::new());
    for (name, program) in [
        ("twice in gpu_child", allowed.replace("return [tool]", "return [tool, \"nvidia-smi\"]")),
        ("twice on its line", allowed.replace("tool = \"nvidia-smi\"", "tool = \"nvidia-smi\" or \"nvidia-smi\"")),
        ("outside gpu_child", allowed.replace("return None", "return \"nvidia-smi\"")),
        ("at the top", format!("# nvidia-smi\n{}", allowed.replace("tool = \"nvidia-smi\"", "tool = None"))),
        ("NVML", allowed.replace("return None", "return \"libnvidia-ml.so.1\"")),
        ("no gpu_child", allowed.replace("def gpu_child", "def reader")),
    ] {
        assert_eq!(check(&program, None).len(), 1, "{name}");
    }
    assert_eq!(check(allowed, Some("// nvidia-smi\n")), vec!["remote_service/link.rs names nvidia-smi".to_owned()]);
}
