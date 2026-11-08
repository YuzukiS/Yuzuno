//! A run whose work is only queued (YN-30): no stage attempt is starting,
//! running or being cancelled, and at least one waits in the shared queue
//! for admission. The run then reads "queued", not "running", and says what
//! its first stage in the queue waits for, as admission gives that attempt's
//! reason now.
//!
//! `waitingFor` is the reason's kind, read from the reason Core itself wrote
//! for the attempt; nothing new is stored. A reason this list does not know
//! reads as `capacity`, which the UI shows as plainly queued.
use super::*;

/// Each admission reason a local queued Job can have, by how it starts, and
/// its kind. Every reason starts "Waiting for"; the first match wins.
const KINDS: &[(&str, &str)] = &[
    ("Waiting for a GPU", "gpu"),
    ("Waiting for GPU ", "gpu"),
    ("Waiting for a current GPU sample", "gpu"),
    ("Waiting for shared RAM reservation", "memory"),
    ("Waiting for shared swap reservation", "memory"),
    ("Waiting for host memory", "memory"),
    ("Waiting for shared CPU quota", "cpu"),
    ("Waiting for an execution/collector slot", "slot"),
    ("Waiting for disk space", "disk"),
    ("Waiting for the exclusive job", "exclusive"),
    ("Waiting for an earlier exclusive job", "exclusive"),
    ("Waiting for running jobs to finish", "exclusive"),
    ("Waiting for outstanding reservations to fit the lowered budget", "budget"),
];

/// The kind of what a queued Job waits for, from its reason.
pub(crate) fn waiting_for(reason: &str) -> &'static str {
    KINDS
        .iter()
        .find(|(start, _)| reason.starts_with(start))
        .map_or("capacity", |(_, kind)| kind)
}

/// For a run whose status is "queued": its first stage, in the run's order,
/// whose newest attempt is queued, that attempt, the reason admission gives it
/// now and that reason's kind. None for a run with no queued attempt.
pub(super) fn first(run: &Value, latest: &HashMap<String, Value>, queue: &QueueState) -> Option<Value> {
    run["stages"]
        .as_array()?
        .iter()
        .filter(|stage| stage["reusedFrom"].is_null())
        .find_map(|stage| {
            let job = latest.get(stage["key"].as_str()?)?;
            if job["status"] != "queued" {
                return None;
            }
            let job = queue.view(job.clone());
            let reason = job["reason"].as_str().unwrap_or_default();
            Some(json!({"stage":stage["key"],"jobId":job["id"],"waitingFor":waiting_for(reason),"reason":reason}))
        })
}
