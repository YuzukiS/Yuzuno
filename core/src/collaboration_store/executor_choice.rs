//! The machine a template dispatch chooses for its executor when it says
//! `auto` (T-35 S3b; Lead 2, mails 5775 and 5898; docs/executor-model.md).
//! Chosen in the dispatch's own transaction, from what it reads there:
//! machines, executor slots and Jobs' reservations share the Workspace's one
//! database.
//!
//! The candidates are this Core host and every registered machine where the
//! template's harness may run (OpenCode on this Core host only, Codex on no
//! machine that keeps its Agents contained) and the task has a folder: its
//! Project's there, or on this Core host its worktree. A dispatch carrying a
//! worktree, a path on this Core host, has this Core host only. Each one left
//! out is named with why.
//!
//! In order: a free executor slot first (the machine's limit not reached:
//! its own, else the default; YN-2 S5, the only limit), then the most spare memory, then the most spare CPU of
//! its Jobs budget (the budget less what Jobs reserve now; a machine with no
//! budget comes after every one with one), then this Core host, then the name.
//! The choice and every candidate's numbers are recorded on the dispatch, so
//! the order can be read again from them alone.
use crate::{executor_templates::Template, jobs::Resources, remote::RemoteMachine};
use anyhow::{bail, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::cmp::Reverse;

/// What `auto` says, in a template or a dispatch.
pub(crate) const AUTO: &str = "auto";

/// One machine `auto` could choose, with the numbers it is ranked by.
struct Candidate {
    machine: String,
    name: String,
    held: i64,
    limit: i64,
    /// Its Jobs budget and what Jobs reserve of it; none without a budget.
    headroom: Option<(Resources, Resources)>,
}

impl Candidate {
    fn free_slot(&self) -> bool {
        self.held < self.limit
    }

    fn spare(&self) -> Option<(u64, u64)> {
        self.headroom.as_ref().map(|(budget, reserved)| {
            (budget.memory_mi_b.saturating_sub(reserved.memory_mi_b), budget.cpu_millis.saturating_sub(reserved.cpu_millis))
        })
    }

    /// Smallest first: a free slot, a budget, spare memory, spare CPU, this
    /// Core host, the name, the id.
    fn rank(&self) -> (bool, bool, Reverse<u64>, Reverse<u64>, bool, String, String) {
        let (memory, cpu) = self.spare().unwrap_or((0, 0));
        (!self.free_slot(), self.headroom.is_none(), Reverse(memory), Reverse(cpu), self.machine != "local", self.name.clone(), self.machine.clone())
    }

    fn record(&self) -> Value {
        let resources = |r: &Resources| json!({"cpuMillis": r.cpu_millis, "memoryMiB": r.memory_mi_b});
        let mut record = json!({"machine": self.machine, "name": self.name, "freeSlot": self.free_slot(),
            "executors": self.held, "limit": self.limit, "budget": null});
        if let Some((budget, reserved)) = &self.headroom {
            let (memory, cpu) = self.spare().unwrap_or_default();
            record["budget"] = resources(budget);
            record["reserved"] = resources(reserved);
            record["spare"] = json!({"cpuMillis": cpu, "memoryMiB": memory});
        }
        record
    }
}

/// The machine for this dispatch, and the record of the choice:
/// `{requested, chosen, candidates}`, the candidates in their order, each
/// left out one with why. Refused, naming every machine and why, when none
/// can run it. `default_local`: this Core host's Jobs budget while none is
/// saved (jobs `local_budget_default`).
pub(super) fn choose(db: &Connection, template: &Template, project: Option<&str>, worktree: Option<&str>,
    default_local: Option<&Value>) -> Result<(String, Value)> {
    let mut machines: Vec<(String, String, Option<RemoteMachine>)> = vec![("local".into(), "this Core host".into(), None)];
    let mut q = db.prepare("SELECT data FROM machines ORDER BY id")?;
    for raw in q.query_map([], |r| r.get::<_, String>(0))? {
        let machine: RemoteMachine = serde_json::from_str(&raw?)?;
        machines.push((machine.id.clone(), machine.name.clone(), Some(machine)));
    }
    let mut candidates = Vec::new();
    let mut excluded = Vec::new();
    for (id, name, remote) in machines {
        let why = left_out(db, template, project, worktree, &id, remote.as_ref())?;
        if let Some(why) = why {
            excluded.push(json!({"machine": id, "name": name, "excluded": why}));
            continue;
        }
        let (held, limit) = crate::executor_slots::machine_slots(db, &id)?;
        let headroom = crate::jobs::machine_headroom(db, &id, default_local)?;
        candidates.push(Candidate { machine: id, name, held, limit, headroom });
    }
    candidates.sort_by_key(Candidate::rank);
    let Some(chosen) = candidates.first().map(|c| c.machine.clone()) else {
        let reasons: Vec<String> = excluded.iter().map(|e| format!("{}: {}", e["name"].as_str().unwrap_or_default(), e["excluded"].as_str().unwrap_or_default())).collect();
        bail!("no_machine: no machine can run this executor ({})", reasons.join("; "));
    };
    let listed: Vec<Value> = candidates.iter().map(Candidate::record).chain(excluded).collect();
    let record = json!({"requested": AUTO, "chosen": chosen, "candidates": listed});
    Ok((chosen, record))
}

/// Why `machine` can't run this dispatch's executor, if it can't.
fn left_out(db: &Connection, template: &Template, project: Option<&str>, worktree: Option<&str>, machine: &str,
    remote: Option<&RemoteMachine>) -> Result<Option<String>> {
    let Some(remote) = remote else {
        let folder = match project {
            Some(project) => crate::projects::default_dir(db, project, machine)?.is_some(),
            None => false,
        };
        return Ok((worktree.is_none() && !folder).then(|| "this dispatch has no worktree, and its Project no folder here".into()));
    };
    if template.harness() == "opencode" {
        return Ok(Some("OpenCode executors run on this Core host only".into()));
    }
    if template.harness() == "codex" && remote.contained {
        return Ok(Some("it keeps its Agents contained, and runs no Codex Agent there".into()));
    }
    if let Some(path) = worktree {
        return Ok(Some(format!("this dispatch carries the worktree {path}, a path on this Core host")));
    }
    let Some(project) = project else { return Ok(Some("this task is in no Project, so it has no folder there".into())) };
    if crate::projects::default_dir(db, project, machine)?.is_none() {
        return Ok(Some("its Project has no folder there".into()));
    }
    Ok(None)
}

#[cfg(test)]
#[path = "executor_choice_tests.rs"]
mod tests;
