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
//! Nothing is deleted: keeping and removing old backups is a later slice.
//!
//! The schedule is kept in `backup-schedule.json` in the Workspace folder,
//! which a backup never holds: a restored Workspace starts with none.
use super::online::{Backups, Operation, Refusal};
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

pub struct Planner {
    file: PathBuf,
    schedule: Mutex<Schedule>,
    pub(crate) started: OnceLock<()>,
    pub(crate) wake: tokio::sync::Notify,
}

impl Planner {
    /// Reads the schedule in `data`; none there is the default, which is off.
    pub fn open(data: &Path) -> Self {
        let file = data.join(FILE);
        let schedule = std::fs::read(&file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        Self { file, schedule: Mutex::new(schedule), started: OnceLock::new(), wake: tokio::sync::Notify::new() }
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

    /// One look at the clock. The last run's outcome is taken from its
    /// operation once that ends; then the slot due, if any, is started with
    /// `start` unless a backup, check or restore is running. True when the
    /// last run changed: one started, or its outcome is now known.
    pub fn tick(
        &self,
        backups: &Backups,
        now: DateTime<Utc>,
        start: impl FnOnce(&str, &Path) -> Result<Operation, Refusal>,
    ) -> Result<bool> {
        let mut schedule = self.schedule.lock().unwrap();
        let mut next = schedule.clone();
        if let Some(run) = next.last_run.as_mut().filter(|run| run.state == "running") {
            if let Some(op) = run.operation_id.as_deref().and_then(|id| backups.get(id)).filter(|op| op.state != "running") {
                run.state = op.state;
                run.error = op.error;
                run.finished_at = op.finished_at;
            }
        }
        if let Some((slot, missed)) = due(&next, now) {
            if backups.current().is_none() {
                let to = run_folder(next.folder.as_deref().unwrap_or(Path::new("/")), slot);
                let mut run = Run { slot, missed, started_at: now, to: to.clone(), operation_id: None, state: "running".into(), error: None, finished_at: None };
                match start(&request_id(slot), &to) {
                    Ok(op) => {
                        run.operation_id = Some(op.id);
                        if op.state != "running" {
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
        planner.tick(&backups, at("2026-10-25T03:00:00Z"), start).unwrap();
        assert!(started.lock().unwrap().is_empty());
        assert_eq!(planner.view(at("2026-10-25T03:00:00Z"))["enabled"], json!(false));
        // Turned on at 10:00 for 03:00: the next run is tomorrow's, not now.
        planner.set(true, "03:00", Some(folder.path().into()), at("2026-10-25T10:00:00Z")).unwrap();
        planner.tick(&backups, at("2026-10-25T10:00:30Z"), start).unwrap();
        assert!(started.lock().unwrap().is_empty(), "turning it on does not back up now");
        assert_eq!(planner.view(at("2026-10-25T10:00:30Z"))["nextRunAt"], json!("2026-10-26T03:00:00Z"));
        // The slot comes: one run, recorded as running, not as a success.
        planner.tick(&backups, at("2026-10-26T03:00:10Z"), start).unwrap();
        planner.tick(&backups, at("2026-10-26T03:00:40Z"), start).unwrap();
        assert_eq!(started.lock().unwrap().len(), 1, "one run per slot");
        let (request, to) = started.lock().unwrap()[0].clone();
        assert_eq!((request.as_str(), to), ("schedule-20261026T0300Z", folder.path().join("yuzuno-backup-20261026T0300Z")));
        let run = planner.get().last_run.unwrap();
        let id = run.operation_id.clone().unwrap();
        assert!(["running", "succeeded"].contains(&run.state.as_str()));
        ended(&backups, &id).await;
        planner.tick(&backups, at("2026-10-26T03:01:10Z"), start).unwrap();
        assert_eq!(planner.get().last_run.unwrap().state, "succeeded", "its outcome, once the operation ended");
        // Core restarts: the schedule is read back and the slot is not run again.
        let backups = Arc::new(Backups::open(data.path()));
        let planner = Planner::open(data.path());
        let start = |request: &str, to: &Path| {
            started.lock().unwrap().push((request.into(), to.into()));
            backups.start("backup", request, json!({"to": to}), |_| None, |_| Ok(json!({"ok": true})))
        };
        planner.tick(&backups, at("2026-10-26T12:00:00Z"), start).unwrap();
        assert_eq!(started.lock().unwrap().len(), 1);
        // Stopped (or asleep) for four days: one run, for the latest slot.
        planner.tick(&backups, at("2026-10-30T08:00:00Z"), start).unwrap();
        assert_eq!(started.lock().unwrap().len(), 2);
        let run = planner.get().last_run.unwrap();
        assert_eq!((run.slot, run.missed), (at("2026-10-30T03:00:00Z"), 3));
        // Turned off: nothing more.
        ended(&backups, run.operation_id.as_deref().unwrap()).await;
        planner.set(false, "03:00", Some(folder.path().into()), at("2026-10-30T09:00:00Z")).unwrap();
        planner.tick(&backups, at("2026-11-02T09:00:00Z"), start).unwrap();
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
        assert!(!planner.tick(&backups, at("2026-10-25T03:00:05Z"), fail).unwrap());
        assert_eq!(planner.get().last_run, None, "no run beside a running operation");
        release.send(()).unwrap();
        ended(&backups, &manual.id).await;
        assert!(planner.tick(&backups, at("2026-10-25T03:00:35Z"), fail).unwrap(), "a run started");
        let id = planner.get().last_run.unwrap().operation_id.unwrap();
        ended(&backups, &id).await;
        assert!(planner.tick(&backups, at("2026-10-25T03:01:05Z"), fail).unwrap(), "its outcome is known");
        let run = planner.get().last_run.unwrap();
        assert_eq!(run.state, "failed");
        assert!(run.error.unwrap().contains("Not enough space"), "the reason, as the backup gave it");
        // The failed slot is not retried every half minute.
        assert!(!planner.tick(&backups, at("2026-10-25T03:01:35Z"), |_, _| panic!("not again")).unwrap(), "told once");
        // A folder gone by the next slot: recorded as not started.
        let gone = folder.path().join("gone");
        std::fs::create_dir(&gone).unwrap();
        planner.set(true, "03:00", Some(gone.clone()), at("2026-10-25T04:00:00Z")).unwrap();
        std::fs::remove_dir(&gone).unwrap();
        assert!(planner.tick(&backups, at("2026-10-26T03:00:00Z"), |_, to| {
            Err(Refusal::Invalid(anyhow::anyhow!("Cannot back up to {}: its folder does not exist", to.display())))
        }).unwrap());
        let run = planner.get().last_run.unwrap();
        assert_eq!(run.state, "not_started");
        assert!(run.error.unwrap().contains("does not exist"));
        // Refusals: a time that is not HH:MM, or turning it on without a folder.
        assert!(planner.set(true, "3am", Some(folder.path().into()), at("2026-10-26T04:00:00Z")).is_err());
        assert!(planner.set(true, "03:00", None, at("2026-10-26T04:00:00Z")).is_err());
        assert!(planner.set(true, "03:00", Some("relative".into()), at("2026-10-26T04:00:00Z")).is_err());
        assert_eq!(planner.get().folder, Some(gone), "a refused change writes nothing");
    }
}
