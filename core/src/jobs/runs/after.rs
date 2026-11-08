//! A run that waits for other runs (YN-30). `afterRuns` names up to eight
//! earlier runs of the same Agent, each with `when`:
//!
//! - `succeeded` (the default): that run must settle succeeded; the
//!   artifacts its stages declared are this run's upstream, left out of its
//!   Git guard and checked by digest before each of its stages starts, as
//!   between the stages of one run;
//! - `settled`: ordering only; that run must settle, succeeded or cancelled.
//!
//! The run's own record holds, in each stage it runs (each one not reused:
//! a reused stage runs nothing, so a stage behind it must still wait), a need
//! `run:<id>` per named run; a stage key cannot hold `:`. A Core without
//! afterRuns (core.26 and older) reads such a need as a stage with no attempt,
//! Blocked, so it never starts the run early. While a named run has failed, is unknown, is held
//! (cost limit, a checkpoint, a run it waits for) or, for `succeeded`, was
//! cancelled, this run is `blocked_by_run` and its owner is told once; once
//! that run is retried the notice clears, and it starts by itself when the
//! named run settles as it waits for. Cycles cannot form: the named runs
//! exist before this one, and nothing adds a dependency afterwards.
use super::*;

const PREFIX: &str = "run:";
/// How many runs one run may wait for.
pub(super) const MAX_AFTER: usize = 8;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum When {
    #[default]
    Succeeded,
    Settled,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AfterRun {
    /// The run's whole ID or a unique prefix; kept whole once resolved.
    pub run_id: String,
    #[serde(default)]
    pub when: When,
}

/// The need each stage a run runs holds for a run it waits for.
pub(super) fn need(id: &str) -> String {
    format!("{PREFIX}{id}")
}
/// The run a need names, if it names one.
pub(super) fn run_of(need: &str) -> Option<&str> {
    need.strip_prefix(PREFIX)
}
fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

/// Where a named run stands now, as the run that waits for it reads it.
pub(super) struct State {
    name: String,
    when: When,
    status: &'static str,
    settled: bool,
    /// Its stages' succeeded attempts and reused results: the upstream of
    /// the waiting run once it settled succeeded.
    producers: Vec<Value>,
}

/// Each run `run` waits for, by ID, as it stands now.
pub(super) fn states(db: &Connection, run: &Value) -> Result<HashMap<String, State>> {
    let mut states = HashMap::new();
    for after in run["afterRuns"].as_array().into_iter().flatten() {
        let Some(id) = after["runId"].as_str() else { continue };
        let up = get_run(db, id)?;
        let all = attempts(db, id)?;
        let latest = latest(&all);
        let mut producers = Vec::new();
        for stage in up["stages"].as_array().into_iter().flatten() {
            let label = format!("{} of run {}", stage["key"].as_str().unwrap_or(""), short(id));
            if stage["reusedFrom"].is_object() {
                producers.push(upstream_from_reuse(&label, &stage["reusedFrom"]));
            } else if let Some(job) = latest.get(stage["key"].as_str().unwrap_or("")).filter(|j| j["status"] == "succeeded") {
                producers.push(json!({"stage":label,"jobId":job["id"],"attempt":job["attempt"],"cwd":job["cwd"],
                    "artifacts":job["result"]["artifacts"].as_array().cloned().unwrap_or_default()}));
            }
        }
        states.insert(id.to_owned(), State {
            name: up["name"].as_str().unwrap_or("").to_owned(),
            when: serde_json::from_value(after["when"].clone()).unwrap_or_default(),
            status: run_status(&up, &all),
            settled: up["settledAt"].is_string(),
            producers,
        });
    }
    Ok(states)
}

/// Whether the stage holding the need for run `id` may start on its account.
pub(super) fn gate(id: &str, state: &State) -> Upstream {
    let named = format!("run {} ({})", state.name, short(id));
    let (verb, done) = match state.when {
        When::Succeeded => ("succeed", state.settled && state.status == "succeeded"),
        When::Settled => ("finish", state.settled),
    };
    if done {
        // Only a success hands on its artifacts; an ordering does not.
        return Upstream::Ready(if state.status == "succeeded" && state.when == When::Succeeded { state.producers.clone() } else { Vec::new() });
    }
    match state.status {
        "cancelled" | "cancelling" if state.when == When::Succeeded => Upstream::Blocked(format!(
            "Waiting for {named} to succeed, but it was cancelled: it never will, so this stage never starts; cancel this run")),
        "failed" | "unknown" | "blocked" | "checkpointed" | "blocked_by_run" => Upstream::Blocked(format!(
            "Waiting for {named} to {verb}, and it is {}: this stage starts by itself once that run is retried or resumed and {verb}s, or cancel this run",
            state.status)),
        status => Upstream::Pending(format!("Waiting for {named} to {verb} ({status})")),
    }
}

/// The named runs this run is held by now, with why, in its `afterRuns` order.
pub(super) fn holding(run: &Value, states: &HashMap<String, State>) -> Vec<(String, String)> {
    run["afterRuns"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|after| {
            let id = after["runId"].as_str()?;
            match gate(id, states.get(id)?) {
                Upstream::Blocked(reason) => Some((id.to_owned(), reason)),
                _ => None,
            }
        })
        .collect()
}

/// Tell the owner once for each named run that holds this one, and forget a
/// notice once that run no longer does, so a later failure is told again.
/// True when the run's record changed; the caller saves it.
pub(super) fn notice(db: &Connection, run: &mut Value, states: &HashMap<String, State>) -> Result<bool> {
    let holding = holding(run, states);
    let mut changed = false;
    let noticed: Vec<String> = run["afterRunsNoticed"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    for id in noticed {
        if !holding.iter().any(|(held, _)| *held == id) {
            if let Some(map) = run["afterRunsNoticed"].as_object_mut() {
                map.remove(&id);
            }
            changed = true;
        }
    }
    for (id, reason) in holding {
        if run["afterRunsNoticed"][&id].is_string() {
            continue;
        }
        let run_id = run["id"].as_str().context("Missing run identity")?.to_owned();
        let all = attempts(db, &run_id)?;
        // The run's own first stage carries the mail, as a stage's mail does.
        let Some(job) = all.values().filter_map(|jobs| jobs.last()).min_by_key(|job| job["cursor"].as_i64().unwrap_or(0)).cloned() else {
            continue;
        };
        let task = run["taskId"].as_str().context("Missing task")?.to_owned();
        let public = collaboration::task_number(db, &collaboration::task_key(db, &task)?.0)?;
        let name = run["name"].as_str().unwrap_or("").to_owned();
        let body = format!(
            "Run {name} ({run_id}) has not started: {reason}. Task {public}. job_run_get(runId={id}) shows that run; job_run_cancel(runId={run_id}) stops this one. Nothing of this run has run, and this mail is sent once until that run changes.",
        );
        let mail = notify_message(db, &run["agent"], &task, &job, "blocked_by_run", &name, &run_id, body)?;
        if !run["afterRunsNoticed"].is_object() {
            run["afterRunsNoticed"] = json!({});
        }
        run["afterRunsNoticed"][&id] = json!(mail);
        changed = true;
    }
    Ok(changed)
}

/// The unsettled runs that wait for run `id`.
pub(super) fn dependants(db: &Connection, id: &str) -> Result<Vec<String>> {
    let mut q = db.prepare_cached(
        "SELECT r.id FROM local_job_runs r WHERE json_extract(r.data,'$.settledAt') IS NULL
         AND EXISTS(SELECT 1 FROM json_each(r.data,'$.afterRuns') a WHERE json_extract(a.value,'$.runId')=?1)
         ORDER BY r.seq",
    )?;
    let ids = q.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(ids)
}

/// The named runs of a submission, resolved, checked and as the run keeps
/// them: the same Agent's runs, each once, none a cancelled one it waits to
/// succeed.
pub(super) fn check(db: &Connection, owner: &str, given: &[AfterRun]) -> Result<Vec<Value>> {
    ensure!(given.len() <= MAX_AFTER, "afterRuns names at most {MAX_AFTER} runs");
    let mut kept: Vec<Value> = Vec::new();
    for after in given {
        let id = super::super::ids::resolve(db, super::super::ids::Kind::Run, &after.run_id)?;
        ensure!(
            !kept.iter().any(|k| k["runId"] == id.as_str()),
            "afterRuns names run {} twice",
            short(&id)
        );
        let up = get_run(db, &id)?;
        ensure!(
            up["agentId"] == owner,
            "Run {} is another Agent's: a run waits only for its own Agent's runs",
            short(&id)
        );
        ensure!(
            after.when == When::Settled || up["cancelRequestedAt"].is_null(),
            "Run {} ({}) was cancelled: it will never succeed. Wait for it with when settled, or leave it out",
            up["name"].as_str().unwrap_or(""),
            short(&id)
        );
        kept.push(json!({"runId":id,"name":up["name"],"when":after.when}));
    }
    Ok(kept)
}

/// Every artifact path the named runs' stages declare, as their stages' own
/// guards leave them out: the waiting run's guard leaves them out too.
pub(super) fn declared(db: &Connection, ids: &[String]) -> Result<BTreeSet<String>> {
    let mut paths = BTreeSet::new();
    for id in ids {
        for job in attempts(db, id)?.values().filter_map(|jobs| jobs.last()) {
            for artifact in job["artifacts"].as_array().into_iter().flatten() {
                paths.insert(format!(
                    "{}/{}",
                    job["cwd"].as_str().unwrap_or("").trim_end_matches('/'),
                    artifact["path"].as_str().unwrap_or("")
                ));
            }
        }
        let run = get_run(db, id)?;
        for stage in run["stages"].as_array().into_iter().flatten() {
            if let Some(job) = stage["reusedFrom"]["jobId"].as_str() {
                let job = get(db, job)?;
                for artifact in job["artifacts"].as_array().into_iter().flatten() {
                    paths.insert(format!(
                        "{}/{}",
                        job["cwd"].as_str().unwrap_or("").trim_end_matches('/'),
                        artifact["path"].as_str().unwrap_or("")
                    ));
                }
            }
        }
    }
    Ok(paths)
}

/// What a view of the run shows of the runs it waits for: each as named,
/// with its status now; stages show only their own needs.
pub(super) fn view(run: &mut Value, states: &HashMap<String, State>) {
    for after in run["afterRuns"].as_array_mut().into_iter().flatten() {
        if let Some(state) = after["runId"].as_str().and_then(|id| states.get(id)) {
            after["status"] = json!(state.status);
        }
    }
    for stage in run["stages"].as_array_mut().into_iter().flatten() {
        if let Some(needs) = stage["needs"].as_array_mut() {
            needs.retain(|need| need.as_str().is_none_or(|n| run_of(n).is_none()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How a Core without afterRuns (core.26 and older) reads a stage's need of a run: as a
    /// stage with no attempt, Blocked, so the stage never starts there. The
    /// same need with the run's state is an ordinary wait.
    #[test]
    fn a_run_need_without_its_runs_state_is_blocked_as_an_older_core_reads_it() {
        let id = "1234abcd-0000-4000-8000-00000000000a";
        let run = json!({"stages":[{"key":"train","needs":[need(id)]}],"afterRuns":[{"runId":id,"when":"succeeded"}]});
        let stage = run["stages"][0].clone();
        match upstream(&run, &stage, &HashMap::new(), &HashMap::new()) {
            Upstream::Blocked(reason) => assert_eq!(reason, format!("Upstream stage run:{id} has no attempt")),
            _ => panic!("not blocked"),
        }
        let mut states = HashMap::new();
        states.insert(id.to_owned(), State { name: "sweep".into(), when: When::Succeeded, status: "running", settled: false, producers: vec![] });
        match upstream(&run, &stage, &HashMap::new(), &states) {
            Upstream::Pending(reason) => assert_eq!(reason, "Waiting for run sweep (1234abcd) to succeed (running)"),
            _ => panic!("not pending"),
        }
        // A stage key cannot hold the prefix's ':'.
        assert!(!valid_key(&need(id)));
    }
}
