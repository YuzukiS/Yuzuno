use super::*;
use std::path::Path;

const GPU0: &str = "GPU-00000000-1111-2222-3333-444444444444";

/// A stand-in nvidia-smi: its rows every `-l` seconds or `-lms`
/// milliseconds, the second device's name holding a comma and its values
/// unknown; each start noted in `starts` beside it. `mode` beside it: `once`
/// prints once and exits, `silent` exits at once with nothing.
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
  printf '0, {GPU0}, Stub GPU, 32607, 16000, 16607, %s\n' $((n % 100))
  printf '1, GPU-55555555-6666-7777-8888-999999999999, Stub, Second, 16376, [N/A], [N/A], [N/A]\n'
  n=$((n + 1))
  [ "$mode" = once ] && exit 0
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
    Path::new("/proc").join(pid).join("stat").exists()
        && !std::fs::read_to_string(Path::new("/proc").join(pid).join("stat")).unwrap_or_default().contains(") Z ")
}

const WAIT: Duration = Duration::from_secs(2);

/// nvidia-smi's rows, read from both ends: a name may hold a comma, and
/// `[N/A]` is unknown, not zero.
#[test]
fn a_row_is_read_from_both_ends_and_n_a_is_unknown() {
    assert_eq!(parse_row(&format!("0, {GPU0}, NVIDIA GeForce RTX 5090, 32607, 16972, 15215, 15")), Some(Device {
        index: 0, uuid: GPU0.into(), name: "NVIDIA GeForce RTX 5090".into(), memory_total_mib: Some(32607),
        memory_free_mib: Some(16972), memory_used_mib: Some(15215), utilization_percent: Some(15) }));
    let odd = parse_row("1, GPU-5, Stub, Second, 16376, [N/A], [N/A], [N/A]").unwrap();
    assert_eq!(odd.name, "Stub, Second");
    assert_eq!((odd.memory_total_mib, odd.memory_free_mib, odd.memory_used_mib, odd.utilization_percent),
        (Some(16376), None, None, None), "[N/A] is unknown, not zero");
    for bad in ["", "x, y", "0, GPU-0, 1, 2, 3, 4"] {
        assert_eq!(parse_row(bad), None, "{bad:?}");
    }
}

/// Every read, however many and from whichever reader, shares one session
/// and its one nvidia-smi child (T-58): no new process per read.
#[tokio::test]
async fn every_read_shares_one_session_and_one_child() {
    let dir = tempfile::tempdir().unwrap();
    let sampler = GpuSampler::new(config(dir.path()));
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..60 {
        let sample = sampler.latest(WAIT).await.expect("a reading");
        assert!(sample.source == "nvidia-smi" && !sample.devices.is_empty(), "{sample:?}");
        seen.insert(sample.observed_at);
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
/// backoff that doubles, never at once.
#[tokio::test]
async fn a_child_that_exits_is_started_again_after_a_backoff() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("mode"), "once").unwrap();
    let sampler = GpuSampler::new(config(dir.path()));
    let until = Instant::now() + Duration::from_millis(600);
    while Instant::now() < until {
        let _ = sampler.latest(Duration::from_millis(100)).await;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // 50, 100, 200 ms between starts: four starts at most in 600 ms.
    let n = starts(dir.path()).len();
    assert!((2..=5).contains(&n), "started again after a backoff, not at once: {n} starts");
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
#[tokio::test]
async fn the_load_and_jobs_report_one_sample_and_its_observed_at() {
    let dir = tempfile::tempdir().unwrap();
    let ws = crate::workspace::Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.gpus.configure(Config { interval: Duration::from_secs(5), idle: Duration::from_secs(60), ..config(dir.path()) });
    let load = ws.machine_load().await.unwrap();
    let gpus = crate::jobs::call(ws.clone(), None, "job_gpus".into(), json!({})).await.unwrap();
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
