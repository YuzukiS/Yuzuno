//! Read-only resource projections. They neither resize requests nor admit jobs.
use super::{Resources, COLLECTOR_CPU, COLLECTOR_MEMORY};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub(super) const SCOPE: &str = "Per attempt, local worker cgroup including its wrapper, excluding the collector. Worker wall time uses monotonic start/exit and includes pauses. Unknown measurements are null. Memory peaks are not additive; reused jobs did not execute in this run.";

// systemd uses UINT64_MAX for unavailable counters. Its textual sentinels,
// negative/fractional values and missing fields must not become zero.
fn counter(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|v| *v != u64::MAX)
}

fn same_nonempty(left: &Value, right: &Value) -> bool {
    left.as_str()
        .is_some_and(|s| !s.is_empty() && right.as_str() == Some(s))
}

fn evidence_problem(job: &Value) -> Option<&'static str> {
    if !job["executor"].is_null() {
        return Some("Remote execution is not metered by this local worker summary");
    }
    if !matches!(
        job["status"].as_str(),
        Some("succeeded" | "failed" | "cancelled" | "interrupted" | "rejected")
    ) {
        return Some("No final worker measurement is available yet");
    }
    let result = &job["result"];
    let started = &result["started"];
    let systemd = &result["evidence"]["systemd"];
    if !same_nonempty(&job["id"], &result["jobId"])
        || !same_nonempty(&job["attempt"], &result["attempt"])
        || !same_nonempty(&job["attempt"], &started["attempt"])
        || !same_nonempty(&job["bootId"], &result["bootId"])
        || !same_nonempty(&job["bootId"], &started["bootId"])
        || !same_nonempty(&started["invocationId"], &systemd["InvocationID"])
    {
        return Some("Final evidence does not identify this attempt's worker invocation");
    }
    if counter(&systemd["MainPID"]) != Some(0)
        || !matches!(
            systemd["SubState"].as_str(),
            Some("exited" | "failed" | "dead")
        )
    {
        return Some("The worker's final exit measurement is unavailable");
    }
    None
}

pub(super) fn attempt(job: &Value) -> Value {
    let mut problem = evidence_problem(job);
    let systemd = &job["result"]["evidence"]["systemd"];
    let measured = problem.is_none();
    let memory = measured.then(|| counter(&systemd["MemoryPeak"])).flatten();
    let cpu = measured
        .then(|| counter(&systemd["CPUUsageNSec"]))
        .flatten();
    let wall = measured
        .then(|| {
            let start = counter(&systemd["ExecMainStartTimestampMonotonic"])?;
            let end = counter(&systemd["ExecMainExitTimestampMonotonic"])?;
            (start > 0 && end > start).then(|| end - start)
        })
        .flatten();
    let complete = memory.is_some() && cpu.is_some() && wall.is_some();
    let any = memory.is_some() || cpu.is_some() || wall.is_some();
    if measured && !complete {
        problem = Some("Some final worker counters or monotonic timestamps are missing or invalid");
    }
    json!({
        "measurement":if complete { "complete" } else if any { "partial" } else { "unavailable" },
        "reason":problem,
        "declared":{"memoryMiB":counter(&job["resources"]["memoryMiB"]),
            "cpuCores":counter(&job["resources"]["cpuMillis"]).map(|n| n as f64 / 1000.0)},
        "actual":{"memoryPeakMiB":memory.map(|n| n as f64 / 1_048_576.0),
            "cpuSeconds":cpu.map(|n| n as f64 / 1_000_000_000.0),
            "workerWallSeconds":wall.map(|n| n as f64 / 1_000_000.0),
            "averageCpuCores":cpu.zip(wall).map(|(cpu, wall)| cpu as f64 / (wall as f64 * 1000.0))},
        "scope":SCOPE
    })
}

fn number(value: &Value) -> String {
    value
        .as_f64()
        .map(|n| format!("{n:.2}"))
        .unwrap_or_else(|| "unknown".into())
}

fn line(job: &Value) -> String {
    let summary = attempt(job);
    let actual = &summary["actual"];
    let declared = &summary["declared"];
    format!(
        "peak memory {}/{} MiB; average CPU {}/{} cores (CPU {} s / worker wall {} s){}",
        number(&actual["memoryPeakMiB"]),
        number(&declared["memoryMiB"]),
        number(&actual["averageCpuCores"]),
        number(&declared["cpuCores"]),
        number(&actual["cpuSeconds"]),
        number(&actual["workerWallSeconds"]),
        summary["reason"]
            .as_str()
            .map(|why| format!("; {why}"))
            .unwrap_or_default()
    )
}

pub(super) fn mail(job: &Value) -> String {
    format!(" Resources: {}. {SCOPE}", line(job))
}

pub(super) fn run_mail(all: &BTreeMap<String, Vec<Value>>) -> String {
    let mut attempts: Vec<_> = all.values().flatten().collect();
    // Keep completion mail bounded even after many explicit retries. The run
    // view retains every attempt; no reused producer is in this collection.
    attempts.sort_by_key(|job| job["finishedAt"].as_str().unwrap_or(""));
    let count = attempts.len();
    let shown = count.min(12);
    let lines: Vec<_> = attempts
        .into_iter()
        .skip(count - shown)
        .map(|job| {
            format!(
                "{} attempt {} ({}): {}",
                job["run"]["stage"].as_str().unwrap_or(""),
                job["run"]["attempt"],
                job["id"].as_str().unwrap_or(""),
                line(job)
            )
        })
        .collect();
    format!(
        " Resources ({shown}/{count} attempts shown; job_run_get retains all): {}. {SCOPE}",
        lines.join("; ")
    )
}

fn request_max(remaining: &Resources) -> Resources {
    Resources {
        cpu_millis: remaining
            .cpu_millis
            .saturating_sub(COLLECTOR_CPU)
            .min(256_000),
        memory_mi_b: remaining
            .memory_mi_b
            .saturating_sub(COLLECTOR_MEMORY)
            .min(1_048_576),
        swap_mi_b: remaining.swap_mi_b.min(1_048_576),
    }
}

pub(super) fn capacity(limit: &Resources, available: &Resources, machine: &Value) -> Value {
    let maximum = request_max(limit);
    let snapshot = request_max(available);
    // Match the existing local admission check. MemAvailable already reflects
    // physical use; do not subtract active reservations from it a second time.
    let headroom = machine["hostHeadroomMiB"].as_u64().unwrap_or(2048);
    let memory = machine["memoryAvailableMiB"].as_u64().map(|n| {
        n.saturating_sub(headroom)
            .saturating_sub(COLLECTOR_MEMORY)
            .min(snapshot.memory_mi_b)
    });
    let fits =
        if snapshot.cpu_millis < 100 || snapshot.memory_mi_b < 64 || memory.is_some_and(|n| n < 64)
        {
            Some(false)
        } else {
            memory.map(|_| true)
        };
    json!({
        "minimumRequest":{"cpuMillis":100,"memoryMiB":64,"swapMiB":0},
        "submission":{"maxRequest":maximum,"meetsMinimum":maximum.cpu_millis >= 100 && maximum.memory_mi_b >= 64},
        "snapshot":{"maxRequest":{"cpuMillis":snapshot.cpu_millis,"memoryMiB":memory,"swapMiB":snapshot.swap_mi_b},
            "meetsMinimum":fits,"hostMemoryKnown":memory.is_some(),"hostHeadroomMiB":headroom},
        "scope":"Local requests only. A new collector is subtracted once; existing collectors are already reserved. Submission is the total budget ceiling; snapshot also accounts for current reservations and host RAM/headroom. false meetsMinimum means no request meets the schema minimum; null means unknown. Queue order, slots, exclusive jobs, GPU, disk and changing host availability can still delay admission. This is not an immediate-start guarantee or a resource recommendation."
    })
}
