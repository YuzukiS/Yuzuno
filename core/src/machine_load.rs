//! Machine Load of the Core host, for Home's Machines Widget (T-85 slice 1;
//! remote Machines are slice 2). `GET /api/machine-load`, polled while Home
//! is open.
//!
//! CPU parts are compared only within one window: two samples of the same
//! counters about a second apart (or the previous sample, when a client asks
//! again soon). The machine total is /proc/stat; each Job is its units'
//! cgroups (`cpu.stat`); each Agent is its runtime's process tree (the Codex
//! app-server, or the Claude bridge with its CLI) from /proc. All of them are
//! CPU time in that window, so the rest is "other" — only when every part is
//! known for the whole window, otherwise it is unknown (null). Memory parts
//! are different measures (a cgroup's charge, resident pages, MemAvailable),
//! so no "other" memory is derived from them. The GPU is reported as a whole:
//! what uses it is unknown.
use crate::{server::ApiError, store::Store, workspace::Workspace};
use anyhow::{Context, Result};
use axum::{extract::State as AppState, routing::get, Json, Router};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

/// The window of a fresh pair of samples.
const WINDOW: Duration = Duration::from_secs(1);
/// A previous sample at least this old starts the window of the next answer;
/// a younger one's answer is given again.
const REUSE_AFTER: Duration = Duration::from_millis(500);
/// A previous sample older than this is not used: the window would be stale.
const REUSE_UNTIL: Duration = Duration::from_secs(5);
const GPU_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a missing or failing nvidia-smi is not asked again.
const GPU_RETRY: Duration = Duration::from_secs(60);
const KIB_PER_MIB: f64 = 1024.0;

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/machine-load", get(load))
}

async fn load(AppState(ws): AppState<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.machine_load().await?))
}

/// The previous sample and its answer, and when nvidia-smi may be asked again.
#[derive(Default)]
pub(crate) struct State {
    last: tokio::sync::Mutex<Option<(Sample, Value)>>,
    gpu_retry_at: std::sync::Mutex<Option<Instant>>,
}

/// /proc/stat's aggregate line, in clock ticks of all CPUs.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Cpu {
    total: u64,
    idle: u64,
}

/// One cgroup's counters.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Usage {
    cpu_usec: u64,
    memory_bytes: Option<u64>,
}

/// One runtime's process tree.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Tree {
    root: u32,
    /// The root's start time: a PID reused between samples is another process.
    started: u64,
    /// utime+stime of every member, plus what members reaped from children
    /// that ended (cutime+cstime), so a short-lived command still counts.
    ticks: u64,
    rss_kib: Option<u64>,
}

#[derive(Clone, Debug)]
struct Sample {
    at: Instant,
    wall: String,
    cpu: Cpu,
    cores: u32,
    /// MemTotal and MemAvailable, KiB.
    memory: Option<(u64, u64)>,
    /// Each reserved Job's existing cgroups, by path.
    jobs: HashMap<String, HashMap<String, Usage>>,
    /// Each local runtime's tree, None when its process is gone.
    agents: HashMap<String, Option<Tree>>,
}

/// A reserved Job, as Home names it.
#[derive(Clone, Debug, PartialEq)]
struct Job {
    id: String,
    name: String,
    agent_id: Option<String>,
    agent_name: Option<String>,
    project_id: Option<String>,
    /// Its worker unit's cgroup and its collector's, relative to the cgroup root.
    groups: Vec<String>,
}

impl Workspace {
    pub(crate) async fn machine_load(self: &Arc<Self>) -> Result<Value> {
        let mut last = self.machine_load.last.lock().await;
        if let Some((sample, value)) = &*last {
            if sample.at.elapsed() < REUSE_AFTER {
                return Ok(value.clone());
            }
        }
        let gpus = tokio::spawn(gpus(self.clone()));
        let first = match last.take() {
            Some((sample, _)) if sample.at.elapsed() <= REUSE_UNTIL => sample,
            _ => {
                let (sample, _) = self.sample().await?;
                tokio::time::sleep(WINDOW).await;
                sample
            }
        };
        let (second, jobs) = self.sample().await?;
        let gpus = gpus.await.unwrap_or(None);
        let value = compute(&first, &second, &jobs, gpus, clock_ticks());
        *last = Some((second, value.clone()));
        Ok(value)
    }

    /// Local runtimes' processes: remote runtimes are other Machines' load.
    fn runtime_pids(&self) -> Vec<(String, u32)> {
        let mut pids: Vec<(String, u32)> = self.rpcs.lock().unwrap().iter()
            .filter(|(id, _)| !id.starts_with('_'))
            .filter_map(|(id, c)| Some((id.clone(), c.rpc.pid()?)))
            .collect();
        pids.extend(self.claudes.lock().unwrap().iter().filter_map(|(id, c)| Some((id.clone(), c.bridge.pid()?))));
        pids
    }

    async fn sample(&self) -> Result<(Sample, Vec<Job>)> {
        let jobs = self.stored(|store| jobs(store, &default_group_base())).await?;
        let agents = self.runtime_pids();
        let groups: Vec<(String, Vec<String>)> = jobs.iter().map(|job| (job.id.clone(), job.groups.clone())).collect();
        let sample = tokio::task::spawn_blocking(move || read_sample(Path::new("/proc"), Path::new("/sys/fs/cgroup"), &groups, &agents))
            .await
            .context("Machine Load sample ended unexpectedly")??;
        Ok((sample, jobs))
    }
}

/// The user manager's app.slice, where Jobs' transient units live.
fn default_group_base() -> String {
    let uid = rustix::process::getuid().as_raw();
    format!("user.slice/user-{uid}.slice/user@{uid}.service/app.slice")
}

fn unit_name(unit: &str) -> bool {
    unit.starts_with("yuzuno-job-") && unit.ends_with(".service") && !unit.contains(['/', '\0']) && unit.len() <= 128
}

/// A cgroup path the Job's collector recorded, relative to the cgroup root.
fn group_path(group: &str) -> Option<String> {
    let relative = group.strip_prefix('/')?;
    (!relative.is_empty() && !relative.contains('\0') && relative.split('/').all(|part| !part.is_empty() && part != "." && part != ".."))
        .then(|| relative.to_owned())
}

/// Reserved Jobs with their Agent, their Project (their task's, else their
/// Agent's) and their cgroups: the worker's as its collector recorded it when
/// it started, else where the user manager puts it, and the collector's next
/// to it.
fn jobs(store: &Store, base: &str) -> Result<Vec<Job>> {
    let rows = {
        let db = store.db.read()?;
        let mut query = db.prepare(
            "SELECT j.id, COALESCE(json_extract(j.data,'$.name'),''), j.agent_id, json_extract(j.data,'$.agent.name'),
                json_extract(j.data,'$.unit'), json_extract(j.data,'$.supervisorUnit'),
                json_extract(j.data,'$.result.started.controlGroup'),
                COALESCE((SELECT project_id FROM project_tasks WHERE task_id=j.task_id),
                         (SELECT project_id FROM project_agents WHERE agent_id=j.agent_id))
             FROM local_jobs j WHERE j.reserved=1 AND json_extract(j.data,'$.executor') IS NULL ORDER BY j.seq",
        )?;
        let rows = query.query_map(params![], |r| {
            Ok((
                r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?, r.get::<_, Option<String>>(5)?, r.get::<_, Option<String>>(6)?, r.get::<_, Option<String>>(7)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows.into_iter().map(|(id, name, agent_id, saved_name, unit, collector, started, project_id)| {
        let worker = started.as_deref().and_then(group_path)
            .or_else(|| unit.as_deref().filter(|u| unit_name(u)).map(|u| format!("{base}/{u}")));
        let collector = collector.as_deref().filter(|u| unit_name(u)).and_then(|u| {
            let parent = worker.as_deref().and_then(|w| w.rsplit_once('/')).map_or(base, |(parent, _)| parent);
            Some(format!("{parent}/{u}"))
        });
        let agent_name = agent_id.as_deref().and_then(|agent| store.agent(agent).ok()).map(|agent| agent.name).or(saved_name);
        Job { id, name, agent_id, agent_name, project_id, groups: worker.into_iter().chain(collector).collect() }
    }).collect())
}

fn read_sample(proc: &Path, cgroups: &Path, jobs: &[(String, Vec<String>)], agents: &[(String, u32)]) -> Result<Sample> {
    let at = Instant::now();
    let wall = crate::model::now();
    let (cpu, cores) = parse_proc_stat(&std::fs::read_to_string(proc.join("stat"))?).context("/proc/stat has no CPU line")?;
    let jobs = jobs.iter().map(|(id, groups)| {
        let found = groups.iter().filter_map(|group| Some((group.clone(), read_group(&cgroups.join(group))?))).collect();
        (id.clone(), found)
    }).collect();
    let processes = if agents.is_empty() { HashMap::new() } else { processes(proc) };
    let agents = agents.iter().map(|(id, root)| (id.clone(), tree(proc, &processes, *root))).collect();
    let memory = std::fs::read_to_string(proc.join("meminfo")).ok().as_deref().and_then(parse_meminfo);
    Ok(Sample { at, wall, cpu, cores, memory, jobs, agents })
}

fn read_group(path: &Path) -> Option<Usage> {
    let cpu_usec = parse_cpu_stat(&std::fs::read_to_string(path.join("cpu.stat")).ok()?)?;
    let memory_bytes = std::fs::read_to_string(path.join("memory.current")).ok().and_then(|m| m.trim().parse().ok());
    Some(Usage { cpu_usec, memory_bytes })
}

/// A process from /proc/<pid>/stat.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Process {
    ppid: u32,
    ticks: u64,
    started: u64,
}

fn processes(proc: &Path) -> HashMap<u32, Process> {
    let Ok(entries) = std::fs::read_dir(proc) else { return HashMap::new() };
    entries.filter_map(|entry| {
        let pid: u32 = entry.ok()?.file_name().to_str()?.parse().ok()?;
        let process = parse_pid_stat(&std::fs::read_to_string(proc.join(pid.to_string()).join("stat")).ok()?)?;
        Some((pid, process))
    }).collect()
}

/// The root and everything under it, as one /proc scan saw them.
fn tree(proc: &Path, processes: &HashMap<u32, Process>, root: u32) -> Option<Tree> {
    let first = processes.get(&root)?;
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, process) in processes {
        children.entry(process.ppid).or_default().push(*pid);
    }
    let (mut members, mut queue, mut seen) = (Vec::new(), VecDeque::from([root]), HashSet::new());
    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        members.push(pid);
        queue.extend(children.get(&pid).into_iter().flatten().copied());
    }
    let ticks = members.iter().filter_map(|pid| processes.get(pid)).map(|p| p.ticks).sum();
    let rss_kib = members.iter().try_fold(0u64, |sum, pid| {
        // One that ended since the scan holds nothing now.
        match std::fs::read_to_string(proc.join(pid.to_string()).join("status")) {
            Ok(status) => Some(sum + parse_status_rss(&status)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(sum),
            Err(_) => None,
        }
    });
    Some(Tree { root, started: first.started, ticks, rss_kib })
}

/// The aggregate `cpu` line (user nice system idle iowait irq softirq steal;
/// guest time is already in user) and the number of `cpuN` lines.
fn parse_proc_stat(text: &str) -> Option<(Cpu, u32)> {
    let mut cpu = None;
    let mut cores = 0;
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        match fields.next() {
            Some("cpu") => {
                let values: Vec<u64> = fields.take(8).map(|v| v.parse().ok()).collect::<Option<_>>()?;
                if values.len() < 4 {
                    return None;
                }
                let idle = values[3] + values.get(4).copied().unwrap_or(0);
                cpu = Some(Cpu { total: values.iter().sum(), idle });
            }
            Some(name) if name.starts_with("cpu") && name[3..].chars().all(|c| c.is_ascii_digit()) && name.len() > 3 => cores += 1,
            _ => {}
        }
    }
    Some((cpu?, cores))
}

/// MemTotal and MemAvailable, KiB.
fn parse_meminfo(text: &str) -> Option<(u64, u64)> {
    let value = |key: &str| text.lines().find_map(|line| line.strip_prefix(key)?.split_whitespace().next()?.parse::<u64>().ok());
    Some((value("MemTotal:")?, value("MemAvailable:")?))
}

/// ppid, utime+stime+cutime+cstime and starttime. The command name is in
/// parentheses and may hold spaces or parentheses itself: fields count from
/// the last `)`.
fn parse_pid_stat(text: &str) -> Option<Process> {
    let rest = &text[text.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // fields[0] is the state (field 3 of the line).
    let field = |n: usize| -> Option<u64> { fields.get(n - 3)?.parse().ok() };
    let ticks = field(14)? + field(15)? + field(16).unwrap_or(0) + field(17).unwrap_or(0);
    Some(Process { ppid: field(4)? as u32, ticks, started: field(22)? })
}

/// VmRSS, KiB; a kernel thread has none.
fn parse_status_rss(text: &str) -> Option<u64> {
    Some(text.lines().find_map(|line| line.strip_prefix("VmRSS:")?.split_whitespace().next()?.parse().ok()).unwrap_or(0))
}

fn parse_cpu_stat(text: &str) -> Option<u64> {
    text.lines().find_map(|line| line.strip_prefix("usage_usec ")?.trim().parse().ok())
}

/// `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total
/// --format=csv,noheader,nounits` rows. A row with a value the driver does not
/// report (`[N/A]`) is left out: unknown is not zero.
fn parse_nvidia(text: &str) -> Vec<Value> {
    text.lines().filter_map(|line| {
        let mut fields = line.rsplitn(4, ',').map(str::trim);
        let total: f64 = fields.next()?.parse().ok()?;
        let used: f64 = fields.next()?.parse().ok()?;
        let util: f64 = fields.next()?.parse().ok()?;
        let name = fields.next()?.to_owned();
        (!name.is_empty()).then(|| json!({"name":name,"utilPct":util,"memUsedMiB":used,"memTotalMiB":total,"attribution":"unknown"}))
    }).collect()
}

/// The host's GPUs, or None when nvidia-smi is missing, slow or fails.
async fn gpus(ws: Arc<Workspace>) -> Option<Vec<Value>> {
    if ws.machine_load.gpu_retry_at.lock().unwrap().is_some_and(|at| Instant::now() < at) {
        return None;
    }
    // WSL puts it outside the usual PATH.
    for program in ["nvidia-smi", "/usr/lib/wsl/lib/nvidia-smi"] {
        let mut command = tokio::process::Command::new(program);
        command.args(["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"])
            .stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
        let Ok(Ok(output)) = tokio::time::timeout(GPU_TIMEOUT, command.output()).await else { continue };
        if output.status.success() {
            let gpus = parse_nvidia(&String::from_utf8_lossy(&output.stdout));
            if !gpus.is_empty() {
                return Some(gpus);
            }
        }
    }
    *ws.machine_load.gpu_retry_at.lock().unwrap() = Some(Instant::now() + GPU_RETRY);
    None
}

fn clock_ticks() -> f64 {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // SAFETY: sysconf only reads a system constant.
        let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if ticks > 0 {
            return ticks as f64;
        }
    }
    100.0
}

fn round(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// The answer for the window between two samples. `hz` is the clock ticks
/// per second /proc counts in.
fn compute(first: &Sample, second: &Sample, jobs: &[Job], gpus: Option<Vec<Value>>, hz: f64) -> Value {
    // CPU time of all CPUs in the window, in ticks: every share's denominator.
    let window = second.cpu.total.saturating_sub(first.cpu.total) as f64;
    let share = |ticks: f64| if window > 0.0 { ticks / window * 100.0 } else { 0.0 };
    let busy = (second.cpu.total - second.cpu.idle.min(second.cpu.total))
        .saturating_sub(first.cpu.total - first.cpu.idle.min(first.cpu.total)) as f64;
    let total = share(busy);
    let usec_ticks = hz / 1_000_000.0;
    // Whether every Job's CPU in the window is known.
    let mut jobs_known = window > 0.0;
    let mut jobs_ticks = 0.0;
    let mut jobs_bytes = 0u64;
    let none = HashMap::new();
    let rows: Vec<Value> = jobs.iter().map(|job| {
        let before = first.jobs.get(&job.id).unwrap_or(&none);
        let after = second.jobs.get(&job.id).unwrap_or(&none);
        // A group present only in the second sample started in the window; one
        // gone by then took CPU time no sample shows.
        let gone = before.keys().any(|group| !after.contains_key(group));
        let ticks: f64 = after.iter().map(|(group, usage)| {
            let start = before.get(group).map_or(0, |b| b.cpu_usec);
            usage.cpu_usec.saturating_sub(start) as f64 * usec_ticks
        }).sum();
        let cpu = (!gone && !after.is_empty() && window > 0.0).then(|| round(share(ticks)));
        if gone {
            jobs_known = false;
        } else {
            jobs_ticks += ticks;
        }
        let memory: Option<u64> = if after.is_empty() { None } else { after.values().map(|usage| usage.memory_bytes).sum() };
        jobs_bytes += memory.unwrap_or(0);
        json!({"id":job.id,"name":job.name,"agentId":job.agent_id,"agentName":job.agent_name,"projectId":job.project_id,
            "cpuPct":cpu,"memMiB":memory.map(|bytes| round(bytes as f64 / 1_048_576.0))})
    }).collect();
    // A Job that stopped being reserved in the window took time it no longer shows.
    if first.jobs.iter().any(|(id, groups)| !groups.is_empty() && !second.jobs.contains_key(id)) {
        jobs_known = false;
    }
    let mut agents_ticks = 0.0;
    let mut agents_known = window > 0.0;
    let mut agents_kib = Some(0u64);
    for id in first.agents.keys().chain(second.agents.keys()).collect::<HashSet<_>>() {
        match (first.agents.get(id), second.agents.get(id)) {
            (Some(Some(a)), Some(Some(b))) if (a.root, a.started) == (b.root, b.started) => {
                agents_ticks += b.ticks.saturating_sub(a.ticks) as f64;
            }
            // Gone at both: nothing ran.
            (Some(None) | None, Some(None) | None) => {}
            // Started, ended or replaced within the window.
            _ => agents_known = false,
        }
        if let Some(entry) = second.agents.get(id) {
            agents_kib = match (agents_kib, entry) {
                (Some(sum), Some(tree)) => tree.rss_kib.map(|kib| sum + kib),
                (sum, None) => sum,
                (None, _) => None,
            };
        }
    }
    let agents = agents_known.then(|| share(agents_ticks));
    let jobs_share = share(jobs_ticks);
    let other = agents.filter(|_| jobs_known).map(|agents| round((total - jobs_share - agents).max(0.0)));
    let (total_kib, available_kib) = second.memory.unwrap_or((0, 0));
    json!({
        "at": second.wall,
        "cpu": {"cores": second.cores, "totalPct": round(total), "jobsPct": round(jobs_share),
            "agentsPct": agents.map(round), "otherPct": other},
        "memory": {"totalMiB": round(total_kib as f64 / KIB_PER_MIB), "usedMiB": round(total_kib.saturating_sub(available_kib) as f64 / KIB_PER_MIB),
            "availableMiB": round(available_kib as f64 / KIB_PER_MIB), "jobsMiB": round(jobs_bytes as f64 / 1_048_576.0),
            "agentsMiB": agents_kib.map(|kib| round(kib as f64 / KIB_PER_MIB))},
        "gpus": gpus,
        "jobs": rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAT: &str = "cpu  1000 50 400 8000 100 10 20 5 30 0\ncpu0 500 25 200 4000 50 5 10 2 15 0\ncpu1 500 25 200 4000 50 5 10 3 15 0\nintr 12345\nctxt 999\n";
    const STAT_LATER: &str = "cpu  1050 50 415 8130 105 10 20 5 30 0\ncpu0 525 25 207 4065 52 5 10 2 15 0\ncpu1 525 25 208 4065 53 5 10 3 15 0\n";
    const MEMINFO: &str = "MemTotal:       65536000 kB\nMemFree:         1000000 kB\nMemAvailable:   49152000 kB\nSwapTotal:             0 kB\n";

    #[test]
    fn proc_fixtures_parse() {
        let (cpu, cores) = parse_proc_stat(STAT).unwrap();
        assert_eq!(cores, 2);
        // user..steal; guest is inside user already.
        assert_eq!(cpu, Cpu { total: 1000 + 50 + 400 + 8000 + 100 + 10 + 20 + 5, idle: 8100 });
        assert_eq!(parse_meminfo(MEMINFO), Some((65_536_000, 49_152_000)));
        assert_eq!(parse_meminfo("MemTotal: 1 kB\n"), None);
        // A command name with spaces and parentheses.
        let stat = "4242 (node (bridge) x) S 4000 4242 4242 0 -1 4194560 100 0 0 0 120 30 7 3 20 0 11 0 987654 1000000 5000 18446744073709551615";
        assert_eq!(parse_pid_stat(stat), Some(Process { ppid: 4000, ticks: 120 + 30 + 7 + 3, started: 987654 }));
        assert_eq!(parse_pid_stat("1 (init"), None);
        assert_eq!(parse_status_rss("Name:\tnode\nVmRSS:\t  20480 kB\n"), Some(20480));
        assert_eq!(parse_status_rss("Name:\tkthreadd\n"), Some(0));
        assert_eq!(parse_cpu_stat("usage_usec 2500000\nuser_usec 2000000\nsystem_usec 500000\n"), Some(2_500_000));
        let gpus = parse_nvidia("NVIDIA GeForce RTX 5090, 37, 4096, 32607\nOdd, [N/A], 1, 2\n");
        assert_eq!(gpus, vec![json!({"name":"NVIDIA GeForce RTX 5090","utilPct":37.0,"memUsedMiB":4096.0,"memTotalMiB":32607.0,"attribution":"unknown"})]);
        assert!(group_path("/user.slice/user-1000.slice/user@1000.service/app.slice/yuzuno-job-x.service").is_some());
        for bad in ["relative", "/a/../b", "/", "/a//b"] {
            assert_eq!(group_path(bad), None, "{bad}");
        }
        assert!(unit_name("yuzuno-job-1-collector.service") && !unit_name("../x.service") && !unit_name("other.service"));
    }

    #[test]
    fn trees_follow_children_and_count_reaped_ones() {
        let dir = tempfile::tempdir().unwrap();
        let write = |pid: u32, ppid: u32, utime: u64, cutime: u64, rss: Option<u64>| {
            let path = dir.path().join(pid.to_string());
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("stat"), format!("{pid} (p {pid}) S {ppid} 1 1 0 -1 0 0 0 0 0 {utime} 1 {cutime} 0 20 0 1 0 {} 0 0", 1000 + pid)).unwrap();
            if let Some(rss) = rss {
                std::fs::write(path.join("status"), format!("VmRSS:\t{rss} kB\n")).unwrap();
            }
        };
        write(10, 1, 100, 50, Some(1000));
        write(11, 10, 20, 0, Some(200));
        write(12, 11, 5, 0, Some(30));
        write(13, 1, 999, 0, Some(9999));
        let found = processes(dir.path());
        assert_eq!(found.len(), 4);
        let tree = tree(dir.path(), &found, 10).unwrap();
        assert_eq!((tree.root, tree.started, tree.ticks, tree.rss_kib), (10, 1010, (100 + 1 + 50) + (20 + 1) + (5 + 1), Some(1230)));
        assert_eq!(super::tree(dir.path(), &found, 99), None);
    }

    fn sample(stat: &str, jobs: &[(&str, &[(&str, u64)])], agents: &[(&str, Option<(u32, u64, u64)>)]) -> Sample {
        let (cpu, cores) = parse_proc_stat(stat).unwrap();
        Sample {
            at: Instant::now(), wall: "now".into(), cpu, cores, memory: parse_meminfo(MEMINFO),
            jobs: jobs.iter().map(|(id, groups)| (id.to_string(), groups.iter().map(|(g, usec)| (g.to_string(), Usage { cpu_usec: *usec, memory_bytes: Some(512 * 1_048_576) })).collect())).collect(),
            agents: agents.iter().map(|(id, tree)| (id.to_string(), tree.map(|(root, started, ticks)| Tree { root, started, ticks, rss_kib: Some(2048) }))).collect(),
        }
    }

    fn job(id: &str) -> Job {
        Job { id: id.into(), name: format!("{id} build"), agent_id: Some("a".into()), agent_name: Some("Dev".into()), project_id: Some("p".into()), groups: vec![] }
    }

    #[test]
    fn shares_come_from_one_window_and_other_only_when_every_part_is_known() {
        // 200 ticks of CPU time in the window (2 cores, 1 s at 100 Hz), 65 busy.
        let first = sample(STAT, &[("j1", &[("w1", 1_000_000), ("c1", 10_000)])], &[("a", Some((10, 5, 1000)))]);
        let second = sample(STAT_LATER, &[("j1", &[("w1", 1_200_000), ("c1", 20_000)])], &[("a", Some((10, 5, 1030)))]);
        let value = compute(&first, &second, &[job("j1")], None, 100.0);
        assert_eq!(value["cpu"], json!({"cores":2,"totalPct":32.5,"jobsPct":10.5,"agentsPct":15.0,"otherPct":7.0}));
        assert_eq!(value["memory"], json!({"totalMiB":64000.0,"usedMiB":16000.0,"availableMiB":48000.0,"jobsMiB":1024.0,"agentsMiB":2.0}));
        assert_eq!(value["jobs"][0], json!({"id":"j1","name":"j1 build","agentId":"a","agentName":"Dev","projectId":"p","cpuPct":10.5,"memMiB":1024.0}));
        assert_eq!(value["gpus"], Value::Null);

        // A runtime replaced within the window (same PID, another process).
        let replaced = sample(STAT_LATER, &[("j1", &[("w1", 1_200_000), ("c1", 20_000)])], &[("a", Some((10, 6, 10)))]);
        let value = compute(&first, &replaced, &[job("j1")], None, 100.0);
        assert_eq!((value["cpu"]["agentsPct"].clone(), value["cpu"]["otherPct"].clone()), (Value::Null, Value::Null));
        assert_eq!(value["cpu"]["jobsPct"], 10.5);

        // A Job's worker cgroup gone by the second sample: that Job is unknown, so is other.
        let ended = sample(STAT_LATER, &[("j1", &[("c1", 20_000)])], &[("a", Some((10, 5, 1030)))]);
        let value = compute(&first, &ended, &[job("j1")], None, 100.0);
        assert_eq!(value["jobs"][0]["cpuPct"], Value::Null);
        assert_eq!((value["cpu"]["agentsPct"].clone(), value["cpu"]["otherPct"].clone()), (json!(15.0), Value::Null));

        // A Job no longer reserved at the second sample.
        let finished = sample(STAT_LATER, &[], &[("a", Some((10, 5, 1030)))]);
        assert_eq!(compute(&first, &finished, &[], None, 100.0)["cpu"]["otherPct"], Value::Null);

        // A Job started in the window, and a reserved one not running: both known.
        let started = sample(STAT_LATER, &[("j1", &[("w1", 1_200_000), ("c1", 20_000)]), ("j2", &[("w2", 100_000)]), ("j3", &[])], &[("a", Some((10, 5, 1030)))]);
        let value = compute(&first, &started, &[job("j1"), job("j2"), job("j3")], None, 100.0);
        assert_eq!(value["cpu"]["jobsPct"], 15.5);
        assert_eq!(value["cpu"]["otherPct"], 2.0);
        assert_eq!((value["jobs"][1]["cpuPct"].clone(), value["jobs"][2]["cpuPct"].clone(), value["jobs"][2]["memMiB"].clone()), (json!(5.0), Value::Null, Value::Null));

        // The same counters twice: no window, nothing derived.
        let value = compute(&second, &second, &[job("j1")], None, 100.0);
        assert_eq!(value["cpu"]["totalPct"], 0.0);
        assert_eq!((value["cpu"]["agentsPct"].clone(), value["cpu"]["otherPct"].clone()), (Value::Null, Value::Null));
    }

    #[tokio::test]
    async fn endpoint_answers_in_the_shape_home_reads() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
        let value = ws.machine_load().await.unwrap();
        for key in ["at", "cpu", "memory", "gpus", "jobs"] {
            assert!(value.get(key).is_some(), "{key}: {value}");
        }
        assert!(value["cpu"]["cores"].as_u64().unwrap() >= 1);
        assert!(value["memory"]["totalMiB"].as_f64().unwrap() > 0.0);
        // No Agents or Jobs: their shares are known zeros, so other is known.
        assert_eq!((value["cpu"]["jobsPct"].as_f64(), value["cpu"]["agentsPct"].as_f64()), (Some(0.0), Some(0.0)));
        assert!(value["cpu"]["otherPct"].is_number());
        // Asked again at once: the same answer, not a second window.
        assert_eq!(ws.machine_load().await.unwrap(), value);
    }
}
