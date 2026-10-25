//! A daily backup a running Core makes on its own (T-196, slice 1).
//!
//! It is off until the user turns it on in Settings, choosing a time of day
//! in UTC and a folder. Each run is an ordinary backup operation
//! (`online::begin_backup`) into a new folder inside that one, checked as
//! every backup is; nothing here copies data itself. Turning it on, or
//! changing the time, schedules the next slot: it does not back up now.
//!
//! Core looks at the clock every half minute, so a slot passed while Core was
//! stopped or the machine slept is made up once when it next looks, however
//! many slots were missed. A slot that finds a backup, check or restore
//! running waits for it to end. A run is recorded when it starts; its outcome
//! only once the operation ends, so starting is never reported as success.
//!
//! Removing old backups automatically (slice 6) is off until the user turns
//! it on for the schedule's folder, after a preview: keep the latest N, and
//! optionally only as many as fit a space budget by the sizes their
//! manifests declare. It runs once per run, only when Core sees that run's
//! backup succeed, as one removal operation (`retention::prune`) started
//! once the backup has ended. A failed, stopped or interrupted backup, a page
//! read and a Core start remove nothing. What it did is that run's cleanup,
//! shown apart from its backup: a cleanup that fails leaves the backup's
//! success as it was. A cleanup cut off by Core stopping stays interrupted,
//! and one decided but not started when Core stopped is not started later;
//! neither is finished or tried again on its own. Changing the folder turns
//! automatic removal off; changing its settings before a decided cleanup
//! begins stops that one from running under the old settings.
//!
//! The schedule is kept in `backup-schedule.json` in the Workspace folder,
//! which a backup never holds: a restored Workspace starts with none.
use super::online::{Backups, Operation, Refusal};
use super::retention::{Rule, MAX_BUDGET, MAX_KEEP};
use anyhow::{ensure, Context, Result};
use chrono::{DateTime, Duration, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

/// The schedule's name in the Workspace folder.
pub const FILE: &str = "backup-schedule.json";
/// How often Core looks at the clock.
pub const LOOK: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub enabled: bool,
    /// The time of day of each run, "HH:MM" in UTC.
    pub time_utc: String,
    /// Each run writes a new folder in this one.
    pub folder: Option<PathBuf>,
    /// The last slot handled: started, or recorded as not started.
    pub last_slot: Option<DateTime<Utc>>,
    pub last_run: Option<Run>,
    /// Removing old backups after each run that succeeds; none is off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention: Option<AutoRetention>,
    /// Why automatic removal was turned off by Core (the folder changed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retention_note: Option<String>,
}

/// Automatic removal as the user confirmed it, for one folder.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoRetention {
    pub keep: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_bytes: Option<u64>,
    /// The schedule's folder it was previewed and confirmed for.
    pub folder: PathBuf,
    pub confirmed_at: DateTime<Utc>,
}

impl AutoRetention {
    pub fn rule(&self) -> Rule {
        Rule { keep: self.keep, budget_bytes: self.budget_bytes }
    }
}

/// What automatic removal did after one run: its own outcome, apart from the
/// backup's, under the settings it was decided with.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cleanup {
    /// due (decided, waiting for no other operation to run), running, then
    /// the removal operation's state (succeeded, failed, stopped,
    /// interrupted); not_run when it was not started, with the reason.
    pub state: String,
    pub keep: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_bytes: Option<u64>,
    pub folder: PathBuf,
    pub decided_at: DateTime<Utc>,
    pub operation_id: Option<String>,
    pub reason: Option<String>,
    pub error: Option<String>,
    /// The removal operation's result: what it removed and skipped.
    pub result: Option<Value>,
    pub finished_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub slot: DateTime<Utc>,
    /// Earlier slots this run made up for, missed while Core was not looking.
    pub missed: u32,
    pub started_at: DateTime<Utc>,
    pub to: PathBuf,
    pub operation_id: Option<String>,
    /// "running" until the operation ends, then its state; "not_started"
    /// when the backup could not begin.
    pub state: String,
    pub error: Option<String>,
    pub finished_at: Option<String>,
    /// Automatic removal after this run, when it applied (slice 6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup: Option<Cleanup>,
}

pub fn parse_time(value: &str) -> Result<NaiveTime> {
    ensure!(value.len() == 5, "The time must be HH:MM, in UTC");
    NaiveTime::parse_from_str(value, "%H:%M").context("The time must be HH:MM, in UTC")
}

/// The latest slot at or before `now`.
pub fn latest_slot(time: NaiveTime, now: DateTime<Utc>) -> DateTime<Utc> {
    let today = now.date_naive().and_time(time).and_utc();
    if today <= now {
        today
    } else {
        today - Duration::days(1)
    }
}

/// The first slot after `now`.
pub fn next_slot(time: NaiveTime, now: DateTime<Utc>) -> DateTime<Utc> {
    latest_slot(time, now) + Duration::days(1)
}

/// The slot due at `now`, if one is, and how many earlier slots it makes up for.
pub fn due(schedule: &Schedule, now: DateTime<Utc>) -> Option<(DateTime<Utc>, u32)> {
    if !schedule.enabled || schedule.folder.is_none() {
        return None;
    }
    let latest = latest_slot(parse_time(&schedule.time_utc).ok()?, now);
    match schedule.last_slot {
        Some(last) if last >= latest => None,
        Some(last) => Some((latest, (latest - last).num_days().saturating_sub(1).clamp(0, u32::MAX as i64) as u32)),
        None => Some((latest, 0)),
    }
}

/// The folder a run for `slot` writes, inside `folder`.
pub fn run_folder(folder: &Path, slot: DateTime<Utc>) -> PathBuf {
    folder.join(format!("yuzuno-backup-{}", slot.format("%Y%m%dT%H%MZ")))
}

/// The requestId a run for `slot` starts its operation with: the same slot is
/// the same operation, also after Core restarts in between.
pub fn request_id(slot: DateTime<Utc>) -> String {
    format!("schedule-{}", slot.format("%Y%m%dT%H%MZ"))
}

/// The requestId of the cleanup after the run for `slot`: one per run.
pub fn cleanup_request_id(slot: DateTime<Utc>) -> String {
    format!("retention-{}", slot.format("%Y%m%dT%H%MZ"))
}

fn not_run(policy: &AutoRetention, now: DateTime<Utc>, reason: &str) -> Cleanup {
    Cleanup { state: "not_run".into(), reason: Some(reason.into()), ..decided(policy, now) }
}

fn decided(policy: &AutoRetention, now: DateTime<Utc>) -> Cleanup {
    Cleanup {
        state: "due".into(),
        keep: policy.keep,
        budget_bytes: policy.budget_bytes,
        folder: policy.folder.clone(),
        decided_at: now,
        operation_id: None,
        reason: None,
        error: None,
        result: None,
        finished_at: None,
    }
}

/// The cleanup a run gets once its backup is seen to have succeeded: due
/// under the settings on now, if they are for the folder it backed up into
/// and its backup ended while this Core was running; else none, or not run.
fn decide(policy: Option<&AutoRetention>, run: &Run, ended: Option<&str>, opened_at: DateTime<Utc>, now: DateTime<Utc>) -> Option<Cleanup> {
    let policy = policy?;
    if run.to.parent() != Some(policy.folder.as_path()) {
        return Some(not_run(policy, now, "This run backed up into another folder than the one automatic removal was turned on for; nothing was removed"));
    }
    let ended = ended.and_then(|at| DateTime::parse_from_rfc3339(at).ok()).map(|at| at.with_timezone(&Utc));
    if ended.is_none_or(|at| at < opened_at) {
        return Some(not_run(policy, now, "Core started again after this backup ended, before removing old backups; nothing was removed. The next daily backup that succeeds removes them"));
    }
    Some(decided(policy, now))
}

pub struct Planner {
    file: PathBuf,
    schedule: Mutex<Schedule>,
    /// When this Core read the schedule: a backup that ended before it gets no cleanup.
    opened_at: DateTime<Utc>,
    pub(crate) started: OnceLock<()>,
    pub(crate) wake: tokio::sync::Notify,
}

impl Planner {
    /// Reads the schedule in `data`; none there is the default, which is off.
    /// A cleanup decided but not started when Core stopped is not started.
    pub fn open(data: &Path) -> Self {
        let file = data.join(FILE);
        let mut schedule: Schedule = std::fs::read(&file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        let now = Utc::now();
        let cleanup = schedule.last_run.as_mut().and_then(|run| run.cleanup.as_mut()).filter(|c| c.state == "due");
        let changed = cleanup.map(|cleanup| {
            cleanup.state = "not_run".into();
            cleanup.reason = Some("Core stopped before removing old backups after this run; nothing was removed, and it is not started again. The next daily backup that succeeds removes them".into());
        }).is_some();
        let planner = Self { file, schedule: Mutex::new(schedule), opened_at: now, started: OnceLock::new(), wake: tokio::sync::Notify::new() };
        if changed {
            let _ = planner.save(&planner.get());
        }
        planner
    }

    pub fn get(&self) -> Schedule {
        self.schedule.lock().unwrap().clone()
    }

    fn save(&self, schedule: &Schedule) -> Result<()> {
        crate::updates::package::atomic_json(&self.file, schedule)
    }

    /// Turns the schedule on or off, at `time_utc` into `folder`. Turning it on
    /// or changing the time schedules the next slot, not one already passed;
    /// days it was off are not made up. Nothing is written when refused.
    pub fn set(&self, enabled: bool, time_utc: &str, folder: Option<PathBuf>, now: DateTime<Utc>) -> Result<Schedule> {
        let time = parse_time(time_utc)?;
        if enabled {
            let folder = folder.as_deref().context("Choose a folder for the daily backups")?;
            ensure!(folder.is_absolute(), "The folder must be an absolute path on the computer that runs Core");
            ensure!(std::fs::metadata(folder).is_ok_and(|m| m.is_dir()), "{} is not a folder on the computer that runs Core", folder.display());
        }
        let mut schedule = self.schedule.lock().unwrap();
        let mut next = schedule.clone();
        let restarts = enabled && (!schedule.enabled || schedule.time_utc != time_utc);
        next.enabled = enabled;
        next.time_utc = time_utc.into();
        // Automatic removal was previewed for the folder it was turned on for.
        if next.retention.is_some() && folder != schedule.folder {
            next.retention = None;
            next.retention_note = Some(format!(
                "Automatic removal was turned off on {} because the daily backup's folder changed; preview and turn it on again for the new folder",
                now.format("%Y-%m-%d %H:%M UTC")));
        }
        next.folder = folder;
        if restarts {
            next.last_slot = Some(latest_slot(time, now));
        }
        self.save(&next).with_context(|| format!("Cannot save the schedule in {}", self.file.display()))?;
        *schedule = next.clone();
        drop(schedule);
        self.wake.notify_one();
        Ok(next)
    }

    /// Turns automatic removal on (with `keep` and an optional budget) or off.
    /// On is for the schedule's folder, which the request names as the page
    /// previewed it: a folder changed since then is refused. Turning it on or
    /// changing it removes nothing now; nothing is written when refused.
    pub fn set_retention(&self, enabled: bool, keep: usize, budget_bytes: Option<u64>, folder: Option<&Path>, now: DateTime<Utc>) -> Result<Schedule> {
        let mut schedule = self.schedule.lock().unwrap();
        let mut next = schedule.clone();
        if enabled {
            ensure!((1..=MAX_KEEP).contains(&keep), "Keep at least 1 and at most {MAX_KEEP} backups");
            ensure!(budget_bytes.is_none_or(|bytes| (1..=MAX_BUDGET).contains(&bytes)), "A space budget must be more than 0 and at most 1 PiB");
            let saved = schedule.folder.clone().context("Choose and save the daily backup's folder first")?;
            ensure!(folder == Some(saved.as_path()), "The daily backup's folder is {} now, not the one previewed; preview again", saved.display());
            next.retention = Some(AutoRetention { keep, budget_bytes, folder: saved, confirmed_at: now });
        } else {
            next.retention = None;
        }
        next.retention_note = None;
        self.save(&next).with_context(|| format!("Cannot save the schedule in {}", self.file.display()))?;
        *schedule = next.clone();
        Ok(next)
    }

    /// One look at the clock. The last run's outcome is taken from its
    /// operation once that ends; a run whose backup succeeded gets its
    /// cleanup decided then, once (`decide`). A decided cleanup starts with
    /// `prune` when no backup, check, restore or removal is running, under the
    /// settings it was decided with, if they are still the ones on; its
    /// outcome is taken from its operation. Then the slot due, if any, is
    /// started with `start` unless an operation is running. True when the
    /// last run changed: one started, an outcome is now known, or its cleanup
    /// moved on.
    pub fn tick(
        &self,
        backups: &Backups,
        now: DateTime<Utc>,
        start: impl FnOnce(&str, &Path) -> Result<Operation, Refusal>,
        prune: impl FnOnce(&str, &Path, Rule) -> Result<Operation, Refusal>,
    ) -> Result<bool> {
        let mut schedule = self.schedule.lock().unwrap();
        let mut next = schedule.clone();
        let policy = next.retention.clone();
        if let Some(run) = next.last_run.as_mut().filter(|run| run.state == "running") {
            if let Some(op) = run.operation_id.as_deref().and_then(|id| backups.get(id)).filter(|op| op.state != "running") {
                if op.state == "succeeded" {
                    run.cleanup = decide(policy.as_ref(), run, op.finished_at.as_deref(), self.opened_at, now);
                }
                run.state = op.state;
                run.error = op.error;
                run.finished_at = op.finished_at;
            }
        }
        if let Some(run) = next.last_run.as_mut() {
            if let Some(cleanup) = run.cleanup.as_mut().filter(|c| c.state == "running") {
                if let Some(op) = cleanup.operation_id.as_deref().and_then(|id| backups.get(id)).filter(|op| op.state != "running") {
                    (cleanup.state, cleanup.error, cleanup.result, cleanup.finished_at) = (op.state, op.error, op.result, op.finished_at);
                }
            }
            let slot = run.slot;
            if let Some(cleanup) = run.cleanup.as_mut().filter(|c| c.state == "due") {
                let same = policy.as_ref().is_some_and(|p| p.keep == cleanup.keep && p.budget_bytes == cleanup.budget_bytes && p.folder == cleanup.folder);
                if !same {
                    cleanup.state = "not_run".into();
                    cleanup.reason = Some("Automatic removal was turned off or changed before it began; nothing was removed under the earlier settings".into());
                } else if backups.current().is_none() {
                    match prune(&cleanup_request_id(slot), &cleanup.folder, Rule { keep: cleanup.keep, budget_bytes: cleanup.budget_bytes }) {
                        Ok(op) => {
                            cleanup.operation_id = Some(op.id);
                            cleanup.state = "running".into();
                            if op.state != "running" {
                                (cleanup.state, cleanup.error, cleanup.result, cleanup.finished_at) = (op.state, op.error, op.result, op.finished_at);
                            }
                        }
                        // Another operation began in between: the cleanup waits for it.
                        Err(Refusal::Busy(_)) => {}
                        Err(Refusal::Conflict) => {
                            cleanup.state = "not_run".into();
                            cleanup.reason = Some("This run's cleanup request was used for a different operation; nothing was removed".into());
                        }
                        Err(Refusal::Invalid(error)) => {
                            cleanup.state = "not_run".into();
                            cleanup.reason = Some(format!("{error:#}; nothing was removed"));
                        }
                    }
                }
            }
        }
        if let Some((slot, missed)) = due(&next, now) {
            if backups.current().is_none() {
                let to = run_folder(next.folder.as_deref().unwrap_or(Path::new("/")), slot);
                let mut run = Run { slot, missed, started_at: now, to: to.clone(), operation_id: None, state: "running".into(), error: None, finished_at: None, cleanup: None };
                match start(&request_id(slot), &to) {
                    Ok(op) => {
                        run.operation_id = Some(op.id);
                        if op.state != "running" {
                            if op.state == "succeeded" {
                                run.cleanup = decide(policy.as_ref(), &run, op.finished_at.as_deref(), self.opened_at, now);
                            }
                            (run.state, run.error, run.finished_at) = (op.state, op.error, op.finished_at);
                        }
                    }
                    // Another one began in between: this slot waits for it.
                    Err(Refusal::Busy(_)) => run.state = String::new(),
                    Err(Refusal::Conflict) => {
                        (run.state, run.error) = ("not_started".into(), Some("This slot's request was used for a different backup".into()));
                    }
                    Err(Refusal::Invalid(error)) => (run.state, run.error) = ("not_started".into(), Some(format!("{error:#}"))),
                }
                if !run.state.is_empty() {
                    next.last_slot = Some(slot);
                    next.last_run = Some(run);
                }
            }
        }
        let run_changed = next.last_run != schedule.last_run;
        if next != *schedule {
            self.save(&next)?;
            *schedule = next;
        }
        Ok(run_changed)
    }

    /// The schedule as Settings shows it: on or off, when (UTC), where, the
    /// next slot and the last run's outcome.
    pub fn view(&self, now: DateTime<Utc>) -> Value {
        let schedule = self.get();
        let next = schedule.enabled.then(|| parse_time(&schedule.time_utc).ok()).flatten().map(|time| {
            due(&schedule, now).map(|(slot, _)| slot).unwrap_or_else(|| next_slot(time, now))
        });
        json!({
            "enabled": schedule.enabled,
            "timeUtc": schedule.time_utc,
            "folder": schedule.folder,
            "nextRunAt": next,
            "lastRun": schedule.last_run,
            "retention": schedule.retention,
            "retentionNote": schedule.retention_note,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&Utc)
    }

    /// Automatic removal off: never asked to remove anything.
    fn never(_: &str, _: &Path, _: Rule) -> Result<Operation, Refusal> {
        panic!("no cleanup while automatic removal is off")
    }

    #[test]
    fn slots_are_daily_utc_times_and_missed_ones_are_counted_once() {
        let three = parse_time("03:00").unwrap();
        assert_eq!(latest_slot(three, at("2026-10-25T02:59:59Z")), at("2026-10-24T03:00:00Z"));
        assert_eq!(latest_slot(three, at("2026-10-25T03:00:00Z")), at("2026-10-25T03:00:00Z"));
        assert_eq!(next_slot(three, at("2026-10-25T03:00:00Z")), at("2026-10-26T03:00:00Z"));
        for bad in ["3:00", "24:00", "03:60", "03-00", "", "03:00Z"] {
            assert!(parse_time(bad).is_err(), "{bad}");
        }
        let mut schedule = Schedule { enabled: true, time_utc: "03:00".into(), folder: Some("/backups".into()), ..Default::default() };
        schedule.last_slot = Some(at("2026-10-24T03:00:00Z"));
        assert_eq!(due(&schedule, at("2026-10-25T02:00:00Z")), None);
        assert_eq!(due(&schedule, at("2026-10-25T03:00:01Z")), Some((at("2026-10-25T03:00:00Z"), 0)));
        // Four days later: one run, for the latest slot, making up three.
        assert_eq!(due(&schedule, at("2026-10-28T09:00:00Z")), Some((at("2026-10-28T03:00:00Z"), 3)));
        // A clock set back does not run a slot again.
        assert_eq!(due(&schedule, at("2026-10-23T12:00:00Z")), None);
        schedule.enabled = false;
        assert_eq!(due(&schedule, at("2026-10-28T09:00:00Z")), None);
        assert_eq!(run_folder(Path::new("/backups"), at("2026-10-25T03:00:00Z")), PathBuf::from("/backups/yuzuno-backup-20261025T0300Z"));
    }

    async fn ended(backups: &Backups, id: &str) -> Operation {
        for _ in 0..500 {
            let op = backups.get(id).unwrap();
            if op.state != "running" {
                return op;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("operation {id} did not end");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_schedule_is_off_until_turned_on_runs_each_slot_once_and_survives_a_restart() {
        let data = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let backups = Arc::new(Backups::open(data.path()));
        let planner = Planner::open(data.path());
        let started = Mutex::new(Vec::<(String, PathBuf)>::new());
        let start = |request: &str, to: &Path| {
            started.lock().unwrap().push((request.into(), to.into()));
            backups.start("backup", request, json!({"to": to}), |_| None, |_| Ok(json!({"ok": true})))
        };
        // Off by default: nothing runs, whatever the time.
        planner.tick(&backups, at("2026-10-25T03:00:00Z"), start, never).unwrap();
        assert!(started.lock().unwrap().is_empty());
        assert_eq!(planner.view(at("2026-10-25T03:00:00Z"))["enabled"], json!(false));
        // Turned on at 10:00 for 03:00: the next run is tomorrow's, not now.
        planner.set(true, "03:00", Some(folder.path().into()), at("2026-10-25T10:00:00Z")).unwrap();
        planner.tick(&backups, at("2026-10-25T10:00:30Z"), start, never).unwrap();
        assert!(started.lock().unwrap().is_empty(), "turning it on does not back up now");
        assert_eq!(planner.view(at("2026-10-25T10:00:30Z"))["nextRunAt"], json!("2026-10-26T03:00:00Z"));
        // The slot comes: one run, recorded as running, not as a success.
        planner.tick(&backups, at("2026-10-26T03:00:10Z"), start, never).unwrap();
        planner.tick(&backups, at("2026-10-26T03:00:40Z"), start, never).unwrap();
        assert_eq!(started.lock().unwrap().len(), 1, "one run per slot");
        let (request, to) = started.lock().unwrap()[0].clone();
        assert_eq!((request.as_str(), to), ("schedule-20261026T0300Z", folder.path().join("yuzuno-backup-20261026T0300Z")));
        let run = planner.get().last_run.unwrap();
        let id = run.operation_id.clone().unwrap();
        assert!(["running", "succeeded"].contains(&run.state.as_str()));
        ended(&backups, &id).await;
        planner.tick(&backups, at("2026-10-26T03:01:10Z"), start, never).unwrap();
        assert_eq!(planner.get().last_run.unwrap().state, "succeeded", "its outcome, once the operation ended");
        // Core restarts: the schedule is read back and the slot is not run again.
        let backups = Arc::new(Backups::open(data.path()));
        let planner = Planner::open(data.path());
        let start = |request: &str, to: &Path| {
            started.lock().unwrap().push((request.into(), to.into()));
            backups.start("backup", request, json!({"to": to}), |_| None, |_| Ok(json!({"ok": true})))
        };
        planner.tick(&backups, at("2026-10-26T12:00:00Z"), start, never).unwrap();
        assert_eq!(started.lock().unwrap().len(), 1);
        // Stopped (or asleep) for four days: one run, for the latest slot.
        planner.tick(&backups, at("2026-10-30T08:00:00Z"), start, never).unwrap();
        assert_eq!(started.lock().unwrap().len(), 2);
        let run = planner.get().last_run.unwrap();
        assert_eq!((run.slot, run.missed), (at("2026-10-30T03:00:00Z"), 3));
        // Turned off: nothing more.
        ended(&backups, run.operation_id.as_deref().unwrap()).await;
        planner.set(false, "03:00", Some(folder.path().into()), at("2026-10-30T09:00:00Z")).unwrap();
        planner.tick(&backups, at("2026-11-02T09:00:00Z"), start, never).unwrap();
        assert_eq!(started.lock().unwrap().len(), 2);
        assert_eq!(Planner::open(data.path()).get().enabled, false, "off, as saved");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_slot_waits_for_a_running_operation_and_a_failure_is_recorded_as_it_was() {
        let data = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let backups = Arc::new(Backups::open(data.path()));
        let planner = Planner::open(data.path());
        planner.set(true, "03:00", Some(folder.path().into()), at("2026-10-25T00:00:00Z")).unwrap();
        // A manual check is running when the slot comes: the slot waits.
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let manual = backups.start("check", "manual", json!({"path":"/b"}), |_| None, move |_| {
            gate.recv().unwrap();
            Ok(json!({}))
        }).unwrap();
        let fail = |request: &str, to: &Path| {
            backups.start("backup", request, json!({"to": to}), |_| None, |_| {
                anyhow::bail!("Not enough space for the backup: needs 2 GiB more. Nothing was written")
            })
        };
        // The returned flag is what pages are told: the last run changed (T-196, slice 4).
        assert!(!planner.tick(&backups, at("2026-10-25T03:00:05Z"), fail, never).unwrap());
        assert_eq!(planner.get().last_run, None, "no run beside a running operation");
        release.send(()).unwrap();
        ended(&backups, &manual.id).await;
        assert!(planner.tick(&backups, at("2026-10-25T03:00:35Z"), fail, never).unwrap(), "a run started");
        let id = planner.get().last_run.unwrap().operation_id.unwrap();
        ended(&backups, &id).await;
        assert!(planner.tick(&backups, at("2026-10-25T03:01:05Z"), fail, never).unwrap(), "its outcome is known");
        let run = planner.get().last_run.unwrap();
        assert_eq!(run.state, "failed");
        assert!(run.error.unwrap().contains("Not enough space"), "the reason, as the backup gave it");
        // The failed slot is not retried every half minute.
        assert!(!planner.tick(&backups, at("2026-10-25T03:01:35Z"), |_, _| panic!("not again"), never).unwrap(), "told once");
        // A folder gone by the next slot: recorded as not started.
        let gone = folder.path().join("gone");
        std::fs::create_dir(&gone).unwrap();
        planner.set(true, "03:00", Some(gone.clone()), at("2026-10-25T04:00:00Z")).unwrap();
        std::fs::remove_dir(&gone).unwrap();
        assert!(planner.tick(&backups, at("2026-10-26T03:00:00Z"), |_, to| {
            Err(Refusal::Invalid(anyhow::anyhow!("Cannot back up to {}: its folder does not exist", to.display())))
        }, never).unwrap());
        let run = planner.get().last_run.unwrap();
        assert_eq!(run.state, "not_started");
        assert!(run.error.unwrap().contains("does not exist"));
        // Refusals: a time that is not HH:MM, or turning it on without a folder.
        assert!(planner.set(true, "3am", Some(folder.path().into()), at("2026-10-26T04:00:00Z")).is_err());
        assert!(planner.set(true, "03:00", None, at("2026-10-26T04:00:00Z")).is_err());
        assert!(planner.set(true, "03:00", Some("relative".into()), at("2026-10-26T04:00:00Z")).is_err());
        assert_eq!(planner.get().folder, Some(gone), "a refused change writes nothing");
    }

    /// Until no operation runs: one that ended may hold its place a moment longer.
    async fn idle(backups: &Backups) {
        for _ in 0..500 {
            if backups.current().is_none() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("an operation is still running");
    }

    fn quick(backups: &Arc<Backups>, kind: &str, request: &str, outcome: Result<Value, &'static str>) -> Result<Operation, Refusal> {
        backups.start(kind, request, json!({"kind": kind}), |_| None, move |_| outcome.map_err(|e| anyhow::anyhow!(e)))
    }

    #[test]
    fn automatic_removal_is_off_until_turned_on_for_the_schedules_folder_and_a_folder_change_turns_it_off() {
        let data = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let planner = Planner::open(data.path());
        assert_eq!(planner.view(at("2026-10-25T04:00:00Z"))["retention"], Value::Null, "off by default");
        let now = at("2026-10-25T04:00:00Z");
        assert!(planner.set_retention(true, 3, None, Some(folder.path()), now).unwrap_err().to_string().contains("save the daily backup's folder first"));
        planner.set(true, "03:00", Some(folder.path().into()), now).unwrap();
        // Refused, writing nothing: counts and budgets out of range, a folder not the schedule's (as previewed).
        for (keep, budget, at_folder) in [(0, None, Some(folder.path())), (101, None, Some(folder.path())), (3, Some(0), Some(folder.path())), (3, None, None), (3, None, Some(other.path()))] {
            assert!(planner.set_retention(true, keep, budget, at_folder, now).is_err(), "{keep} {budget:?} {at_folder:?}");
        }
        assert_eq!(planner.get().retention, None);
        let set = planner.set_retention(true, 3, Some(5 << 30), Some(folder.path()), now).unwrap();
        assert_eq!(set.retention, Some(AutoRetention { keep: 3, budget_bytes: Some(5 << 30), folder: folder.path().into(), confirmed_at: now }));
        assert_eq!(Planner::open(data.path()).get().retention, set.retention, "kept as saved");
        let shown = planner.view(now);
        assert_eq!((shown["retention"]["keep"].clone(), shown["retention"]["budgetBytes"].clone()), (json!(3), json!(5u64 << 30)));
        // A new time keeps it; a new folder turns it off, and says why.
        planner.set(true, "04:00", Some(folder.path().into()), now).unwrap();
        assert!(planner.get().retention.is_some());
        let moved = planner.set(true, "04:00", Some(other.path().into()), now).unwrap();
        assert_eq!(moved.retention, None);
        assert!(moved.retention_note.unwrap().contains("folder changed"));
        assert!(planner.view(now)["retentionNote"].as_str().unwrap().contains("preview and turn it on again"));
        planner.set_retention(false, 0, None, None, now).unwrap();
        assert_eq!((planner.get().retention, planner.get().retention_note), (None, None));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cleanup_runs_once_only_after_its_backup_succeeds_and_its_failure_leaves_the_backup_succeeded() {
        let data = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let backups = Arc::new(Backups::open(data.path()));
        let planner = Planner::open(data.path());
        planner.set(true, "03:00", Some(folder.path().into()), at("2026-10-25T04:00:00Z")).unwrap();
        planner.set_retention(true, 2, None, Some(folder.path()), at("2026-10-25T04:00:00Z")).unwrap();
        let backup_ok = |request: &str, _: &Path| quick(&backups, "backup", request, Ok(json!({})));
        let backup_fails = |request: &str, _: &Path| quick(&backups, "backup", request, Err("Not enough space"));
        let asked = Mutex::new(Vec::<(String, PathBuf, Rule)>::new());
        let prune_ok = |request: &str, to: &Path, rule: Rule| {
            asked.lock().unwrap().push((request.into(), to.into(), rule));
            quick(&backups, "remove", request, Ok(json!({"removed": [{"name": "old"}]})))
        };
        let prune_fails = |request: &str, to: &Path, rule: Rule| {
            asked.lock().unwrap().push((request.into(), to.into(), rule));
            quick(&backups, "remove", request, Err("Cannot move old aside to remove it"))
        };
        let cleanup = || planner.get().last_run.unwrap().cleanup;
        // Day 1: the backup runs; nothing is removed while it does.
        planner.tick(&backups, at("2026-10-26T03:00:10Z"), backup_ok, never).unwrap();
        assert_eq!(cleanup(), None);
        idle(&backups).await;
        // Its success is seen: the cleanup is decided and started once, under the settings on.
        assert!(planner.tick(&backups, at("2026-10-26T03:00:40Z"), never_backup, prune_ok).unwrap());
        assert_eq!(asked.lock().unwrap().clone(), vec![("retention-20261026T0300Z".to_string(), folder.path().to_path_buf(), Rule { keep: 2, budget_bytes: None })]);
        idle(&backups).await;
        planner.tick(&backups, at("2026-10-26T03:01:10Z"), never_backup, never).unwrap();
        let done = cleanup().unwrap();
        assert_eq!((done.state.as_str(), done.keep, done.result.unwrap()["removed"][0]["name"].clone()), ("succeeded", 2, json!("old")));
        // Looked at again (pages, more ticks): never a second cleanup for the run.
        for minute in ["03:02", "03:30", "12:00"] {
            assert!(!planner.tick(&backups, at(&format!("2026-10-26T{minute}:00Z")), never_backup, never).unwrap());
        }
        // Day 2: the backup fails; nothing is removed.
        planner.tick(&backups, at("2026-10-27T03:00:10Z"), backup_fails, never).unwrap();
        idle(&backups).await;
        planner.tick(&backups, at("2026-10-27T03:00:40Z"), never_backup, never).unwrap();
        let run = planner.get().last_run.unwrap();
        assert_eq!((run.state.as_str(), run.cleanup), ("failed", None));
        // Day 3: the backup succeeds, its cleanup fails: said apart, the backup's success stands.
        planner.tick(&backups, at("2026-10-28T03:00:10Z"), backup_ok, never).unwrap();
        idle(&backups).await;
        planner.tick(&backups, at("2026-10-28T03:00:40Z"), never_backup, prune_fails).unwrap();
        idle(&backups).await;
        planner.tick(&backups, at("2026-10-28T03:01:10Z"), never_backup, never).unwrap();
        let run = planner.get().last_run.unwrap();
        let failed = run.cleanup.clone().unwrap();
        assert_eq!((run.state.as_str(), failed.state.as_str()), ("succeeded", "failed"));
        assert!(failed.error.unwrap().contains("Cannot move old aside"));
        assert!(!planner.tick(&backups, at("2026-10-28T04:00:00Z"), never_backup, never).unwrap(), "a failed cleanup is not tried again");
        // Day 4: another operation runs when the backup's success is seen: the cleanup waits for it.
        planner.tick(&backups, at("2026-10-29T03:00:10Z"), backup_ok, never).unwrap();
        idle(&backups).await;
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let manual = backups.start("check", "manual", json!({"path": "/b"}), |_| None, move |_| {
            let _ = gate.recv();
            Ok(json!({}))
        }).unwrap();
        planner.tick(&backups, at("2026-10-29T03:00:40Z"), never_backup, never).unwrap();
        assert_eq!(cleanup().unwrap().state, "due");
        release.send(()).unwrap();
        ended(&backups, &manual.id).await;
        idle(&backups).await;
        planner.tick(&backups, at("2026-10-29T03:01:10Z"), never_backup, prune_ok).unwrap();
        assert_eq!(asked.lock().unwrap().len(), 3, "once per run that succeeded: days 1, 3 and 4");
    }

    fn never_backup(_: &str, _: &Path) -> Result<Operation, Refusal> {
        panic!("no backup is due")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_restart_never_starts_or_resumes_a_cleanup_and_changed_settings_stop_a_decided_one() {
        let data = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let backups = Arc::new(Backups::open(data.path()));
        let planner = Planner::open(data.path());
        planner.set(true, "03:00", Some(folder.path().into()), at("2026-10-25T04:00:00Z")).unwrap();
        planner.set_retention(true, 2, None, Some(folder.path()), at("2026-10-25T04:00:00Z")).unwrap();
        let backup_ok = |request: &str, _: &Path| quick(&backups, "backup", request, Ok(json!({})));
        let hold = |backups: &Arc<Backups>| {
            let (release, gate) = std::sync::mpsc::channel::<()>();
            let op = backups.start("check", &uuid::Uuid::new_v4().to_string(), json!({"path": "/b"}), |_| None, move |_| {
                let _ = gate.recv();
                Ok(json!({}))
            }).unwrap();
            (release, op.id)
        };
        // Decided but not started when Core stops: not started after.
        planner.tick(&backups, at("2026-10-26T03:00:10Z"), backup_ok, never).unwrap();
        idle(&backups).await;
        let (release, held) = hold(&backups);
        planner.tick(&backups, at("2026-10-26T03:00:40Z"), never_backup, never).unwrap();
        assert_eq!(planner.get().last_run.unwrap().cleanup.unwrap().state, "due");
        let planner = Planner::open(data.path());
        let after = planner.get().last_run.unwrap().cleanup.unwrap();
        assert_eq!(after.state, "not_run");
        assert!(after.reason.unwrap().contains("Core stopped before removing old backups"));
        release.send(()).unwrap();
        ended(&backups, &held).await;
        idle(&backups).await;
        assert!(!planner.tick(&backups, at("2026-10-26T04:00:00Z"), never_backup, never).unwrap());
        // A backup that ended while Core was stopping: seen after the start, and removes nothing.
        planner.tick(&backups, at("2026-10-27T03:00:10Z"), backup_ok, never).unwrap();
        idle(&backups).await;
        let backups = Arc::new(Backups::open(data.path()));
        let planner = Planner::open(data.path());
        planner.tick(&backups, at("2026-10-27T03:00:40Z"), never_backup, never).unwrap();
        let run = planner.get().last_run.unwrap();
        assert_eq!(run.state, "succeeded");
        let skipped = run.cleanup.unwrap();
        assert_eq!(skipped.state, "not_run");
        assert!(skipped.reason.unwrap().contains("Core started again after this backup ended"));
        // A cleanup cut off by Core stopping: interrupted, and not run again.
        let backup_ok = |request: &str, _: &Path| quick(&backups, "backup", request, Ok(json!({})));
        planner.tick(&backups, at("2026-10-28T03:00:10Z"), backup_ok, never).unwrap();
        idle(&backups).await;
        let (_cut, gate) = std::sync::mpsc::channel::<()>();
        let gate = Mutex::new(Some(gate));
        planner.tick(&backups, at("2026-10-28T03:00:40Z"), never_backup, |request: &str, _: &Path, _: Rule| {
            let gate = gate.lock().unwrap().take().unwrap();
            backups.start("remove", request, json!({"automatic": true}), |_| None, move |_| {
                let _ = gate.recv();
                Ok(json!({}))
            })
        }).unwrap();
        assert_eq!(planner.get().last_run.unwrap().cleanup.unwrap().state, "running");
        let backups = Arc::new(Backups::open(data.path()));
        let planner = Planner::open(data.path());
        planner.tick(&backups, at("2026-10-28T03:01:10Z"), never_backup, never).unwrap();
        let cut = planner.get().last_run.unwrap().cleanup.unwrap();
        assert_eq!(cut.state, "interrupted");
        assert!(cut.error.unwrap().contains("may be partly removed"));
        assert!(!planner.tick(&backups, at("2026-10-28T09:00:00Z"), never_backup, never).unwrap());
        // Settings changed, or turned off, before a decided cleanup begins: it does not run under the old ones.
        for change in [Some(5), None] {
            let day = if change.is_some() { "29" } else { "30" };
            let backup_ok = |request: &str, _: &Path| quick(&backups, "backup", request, Ok(json!({})));
            planner.set_retention(true, 2, None, Some(folder.path()), at("2026-10-28T10:00:00Z")).unwrap();
            planner.tick(&backups, at(&format!("2026-10-{day}T03:00:10Z")), backup_ok, never).unwrap();
            idle(&backups).await;
            let (release, held) = hold(&backups);
            planner.tick(&backups, at(&format!("2026-10-{day}T03:00:40Z")), never_backup, never).unwrap();
            assert_eq!(planner.get().last_run.unwrap().cleanup.unwrap().state, "due");
            match change {
                Some(keep) => planner.set_retention(true, keep, None, Some(folder.path()), at(&format!("2026-10-{day}T03:00:50Z"))).unwrap(),
                None => planner.set_retention(false, 0, None, None, at(&format!("2026-10-{day}T03:00:50Z"))).unwrap(),
            };
            release.send(()).unwrap();
            ended(&backups, &held).await;
            idle(&backups).await;
            planner.tick(&backups, at(&format!("2026-10-{day}T03:01:10Z")), never_backup, never).unwrap();
            let stopped = planner.get().last_run.unwrap().cleanup.unwrap();
            assert_eq!((stopped.state.as_str(), stopped.keep), ("not_run", 2));
            assert!(stopped.reason.unwrap().contains("turned off or changed before it began"));
        }
    }
}
