//! Where a result came from, as Core recorded it (T-168): one Job, or every
//! attempt of a run, as a versioned JSON manifest and a short report written
//! from that manifest, so the two always say the same.
//!
//! It only restates records. No working file is read or hashed again and no
//! machine is asked, so the Jobs of a machine that is offline export too; of
//! a local attempt only the headers of Core's own log ring are read, to tell
//! whether early output was overwritten. Fields leave by an explicit list:
//! command arguments, environment values, absolute paths, logs, chat and file
//! contents never do. A recorded string that may still hold a known absolute
//! path (a reason, a scope note) has it replaced by what it stands for.
use super::{resource_summary, runs, store};
use crate::{model::now, store::Store};
use anyhow::{ensure, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::fmt::Write as _;
use std::path::Path;

pub(super) const SCHEMA: &str = "yuzuno.provenance";
pub(super) const VERSION: u64 = 1;
const LOG_LIMIT: u64 = 2 * 1024 * 1024;
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const BASIS: &str = "Restates what Core recorded while each attempt ran. Nothing was read or hashed again for this export: files may have changed since, so it does not show that the result can be reproduced.";
const LABELS: &str = "Labels such as C1, S1 and I1 stand for Core's digests of the command, of the frozen code and of an attempt's whole identity: equal labels mean equal digests, within this export only. The digests are not exported: one of a command could confirm a guessed secret in it.";
const OMITTED: [&str; 6] = [
    "command arguments and environment values (only their number), and Core's digests of the command, code and identity (only labels)",
    "absolute paths: the working directory, the Git root and inputs outside them",
    "output and logs",
    "chat and Agent sessions",
    "file contents: artifacts stay where they were checked",
    "GPU device IDs and process or control-group details",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    job_id: Option<String>,
    run_id: Option<String>,
}
pub(super) enum Scope {
    Job(String),
    Run(String),
}
impl Request {
    pub(super) fn scope(self) -> Result<Scope> {
        match (self.job_id, self.run_id) {
            (Some(id), None) => Ok(Scope::Job(id)),
            (None, Some(id)) => Ok(Scope::Run(id)),
            _ => anyhow::bail!("Give exactly one of jobId or runId"),
        }
    }
}

impl Store {
    /// The run (if any) and the Jobs an export restates, read at one moment:
    /// a run's attempts in stage order, each stage's oldest first.
    pub(super) fn provenance_records(&self, scope: &Scope) -> Result<(Option<Value>, Vec<Value>)> {
        let db = self.db.read()?;
        match scope {
            Scope::Job(id) => Ok((None, vec![store::get(&db, id)?])),
            Scope::Run(id) => {
                let run = runs::run_view(&db, id)?;
                let mut all = runs::attempts(&db, id)?;
                let mut jobs = Vec::new();
                for stage in run["stages"].as_array().into_iter().flatten() {
                    jobs.extend(all.remove(stage["key"].as_str().unwrap_or("")).unwrap_or_default());
                }
                ensure!(all.is_empty(), "The run's attempts name a stage it does not have");
                Ok((Some(run), jobs))
            }
        }
    }
}

/// Absolute paths this export knows, longest first, with what each stands for.
pub(super) struct Known(Vec<(String, String)>);

impl Known {
    /// Of this Core's host: its data folder and the home folder.
    pub(super) fn host(data: &Path, home: Option<String>) -> Self {
        let mut known = vec![(data.to_string_lossy().into_owned(), "<Core data folder>".to_owned())];
        known.extend(home.filter(|h| h.len() > 1).map(|home| (home, "~".to_owned())));
        Known(known)
    }
    fn add(&mut self, path: &Value, label: &str) {
        if let Some(path) = path.as_str().filter(|p| p.len() > 1 && absolute(p)) {
            self.0.push((path.to_owned(), label.to_owned()));
        }
    }
    fn scrub(&self, text: &str) -> String {
        let mut text = text.to_owned();
        for (path, label) in &self.0 {
            let mut out = String::with_capacity(text.len());
            let mut rest = text.as_str();
            while let Some(at) = rest.find(path.as_str()) {
                let after = &rest[at + path.len()..];
                // A whole path or its prefix, never part of a longer name; a
                // full stop after it ends the sentence, not the name.
                let mut next = after.chars();
                let ends = match next.next() {
                    None => true,
                    Some('.') => !next.next().is_some_and(|c| c.is_alphanumeric() || "-_~".contains(c)),
                    Some(c) => !(c.is_alphanumeric() || "-_~".contains(c)),
                };
                out.push_str(&rest[..at]);
                out.push_str(if ends { label } else { path });
                rest = after;
            }
            out.push_str(rest);
            text = out;
        }
        text
    }
    fn scrub_all(&self, value: &mut Value) {
        match value {
            Value::String(text) => *text = self.scrub(text),
            Value::Array(items) => items.iter_mut().for_each(|v| self.scrub_all(v)),
            Value::Object(map) => map.values_mut().for_each(|v| self.scrub_all(v)),
            _ => {}
        }
    }
}

fn absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/') || path.starts_with('\\') || path.starts_with('~')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
}

/// A path that names something below where it is relative to, as recorded.
fn relative(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split(['/', '\\']).collect();
    (!path.is_empty() && path.len() <= 4096 && !absolute(path) && !path.chars().any(char::is_control)
        && parts.iter().all(|part| *part != ".."))
        .then(|| path.to_owned())
}

/// path below base, relative to it, by its recorded text alone.
fn below(path: &str, base: &str) -> Option<String> {
    let base = base.trim_end_matches(['/', '\\']);
    let rest = path.strip_prefix(base).filter(|_| !base.is_empty())?;
    let rest = rest.strip_prefix(['/', '\\'])?;
    relative(rest)
}

/// Export-local names for digests: an unsalted digest of a command (argv,
/// cwd, env) lets anyone who can guess the rest of it confirm a guessed
/// secret, and one of the code covers withheld paths, so only equality leaves.
#[derive(Default)]
struct Labels(std::collections::HashMap<String, String>);

impl Labels {
    fn of(&mut self, kind: &str, digest: &Value) -> Value {
        let Some(digest) = digest.as_str() else { return Value::Null };
        let next = self.0.keys().filter(|k| k.starts_with(&format!("{kind}:"))).count() + 1;
        json!(self.0.entry(format!("{kind}:{digest}")).or_insert_with(|| format!("{kind}{next}")))
    }
}

fn non_null(pairs: &[(&str, &Value)]) -> Value {
    let map: Map<String, Value> = pairs
        .iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| ((*k).to_owned(), (*v).clone()))
        .collect();
    Value::Object(map)
}

fn remote(job: &Value) -> bool {
    job["executor"].is_object()
}

fn target(job: &Value) -> Value {
    let (kind, id, name) = if remote(job) {
        (job["executor"]["kind"].clone(), job["executor"]["machineId"].clone(), job["executor"]["machineName"].clone())
    } else {
        (json!("local"), job["machine"]["id"].clone(), job["machine"]["name"].clone())
    };
    // T-162 kept the name the submission used (agent, local): older Jobs have none.
    let requested = job["target"]["requested"].clone();
    json!({"kind": kind, "machineId": id, "machineName": name,
        "hostId": job["remote"]["hostId"], "requested": requested,
        "coreHost": !remote(job) || job["executor"]["kind"] == "windows",
        "submittingAgentMachine": job["agentMachine"],
        "note": if remote(job) { "Ran on that machine; Core records what its helper reported" }
            else { "Ran on this Core's host in its own systemd scope" }})
}

fn exit(job: &Value) -> Value {
    let result = &job["result"];
    let number = |v: &Value| v.as_i64().or_else(|| v.as_str()?.parse().ok());
    if remote(job) {
        let r = &result["evidence"]["result"];
        if r["exitCode"].is_i64() || r["signal"].is_i64() {
            return json!({"code": r["exitCode"], "signal": r["signal"], "state": "verified",
                "by": "the attempt's supervisor on that machine"});
        }
    } else if let Some(status) = number(&result["evidence"]["systemd"]["ExecMainStatus"]) {
        let systemd = &result["evidence"]["systemd"];
        let signalled = match systemd["ExecMainCode"].as_str() {
            Some(code) => code == "2" || code == "3",
            None => matches!(systemd["Result"].as_str(), Some("signal" | "core-dump")),
        };
        return json!({"code": if signalled { Value::Null } else { json!(status) },
            "signal": if signalled { json!(status) } else { Value::Null },
            "systemdResult": systemd["Result"], "state": "verified", "by": "systemd"});
    }
    json!({"state": if job["status"] == "unknown" { "unknown" } else { "notRecorded" }})
}

fn code(job: &Value) -> Value {
    let snapshot = &job["snapshot"];
    let git = &snapshot["git"];
    if let Some(head) = git["head"].as_str() {
        let status = &git["statusSha256"];
        return json!({"git": {"head": head, "statusSha256": status,
                "trackedChanges": if status == EMPTY_SHA256 { "none" } else { "present: their files are among the inputs" }},
            "state": "verified", "when": "At submission, and checked again before the command started"});
    }
    let note = if snapshot["remote"] == true {
        "Core does not see files on that machine: no Git state was recorded"
    } else {
        "No Git state was recorded: guardGit was off, or the working directory is not in a Git work tree"
    };
    json!({"git": null, "state": "notRecorded", "note": note})
}

fn inputs(job: &Value, known: &mut Known) -> Value {
    let snapshot = &job["snapshot"];
    let cwd = snapshot["cwd"].as_str().unwrap_or("");
    let root = snapshot["git"]["root"].as_str().unwrap_or("");
    let mut withheld = 0;
    let files: Vec<Value> = snapshot["files"].as_array().into_iter().flatten().map(|file| {
        let recorded = file["absolutePath"].as_str().or(file["path"].as_str()).unwrap_or("");
        // On a machine, the path as given may already be relative to cwd.
        let given = file["path"].as_str().filter(|_| file["absolutePath"].is_string()).and_then(relative);
        let (path, base) = match (given, below(recorded, cwd), below(recorded, root)) {
            (Some(path), _, _) | (None, Some(path), _) => (Some(path), Some("cwd")),
            (None, None, Some(path)) => (Some(path), Some("gitRoot")),
            _ => (None, None),
        };
        match (&path, base) {
            (Some(path), Some("gitRoot")) => known.add(&json!(recorded), &format!("<git root>/{path}")),
            (Some(path), _) => known.add(&json!(recorded), &format!("<cwd>/{path}")),
            _ => {
                withheld += 1;
                known.add(&json!(recorded), "<input outside the working directory>");
            }
        }
        let sha = &file["sha256"];
        non_null(&[("path", &json!(path)), ("base", &json!(base)), ("sha256", sha), ("bytes", &file["bytes"]),
            ("state", &json!(if sha.is_string() { "verified" } else { "notRecorded" })),
            ("missingAtSubmit", &if sha.is_null() { json!(true) } else { Value::Null })])
    }).collect();
    json!({"files": files, "withheld": withheld, "scope": snapshot["scope"],
        "frozenOn": if snapshot["remote"] == true { target(job)["machineName"].clone() } else { Value::Null },
        "note": "Only these files were frozen, by SHA-256 at submission, and checked again before the command could start; anything else it read was not"})
}

fn artifact_file(a: &Value, remote: bool, machine: &Value) -> Value {
    let ok = a["ok"] == true;
    let fetch = if remote {
        json!({"available": false, "reason": format!("It stays on {}: Core checked it there and does not copy it", machine.as_str().unwrap_or("that machine"))})
    } else if ok {
        json!({"available": true, "how": "Download it from this Job in Core, which checks it against this record first and refuses a file that changed"})
    } else {
        json!({"available": false, "reason": "It did not pass its check"})
    };
    non_null(&[("path", &json!(a["path"].as_str().and_then(relative))), ("format", &a["format"]), ("minBytes", &a["minBytes"]),
        ("ok", &json!(ok)), ("problem", &a["problem"]), ("bytes", &a["bytes"]), ("sha256", &a["sha256"]), ("hash", &a["hash"]),
        // Without a digest (over 1 GiB) size and modification time identify it.
        ("mtimeNs", if a["sha256"].is_string() { &Value::Null } else { &a["mtimeNs"] }),
        ("lines", &a["lines"]), ("preExisting", &a["preExisting"]), ("unchangedSinceStart", &a["unchangedSinceStart"]),
        ("state", &json!("verified")), ("fetch", &fetch)])
}

fn artifacts(job: &Value) -> Value {
    let on = target(job);
    let checked = &job["result"]["artifacts"];
    let files: Vec<Value> = match checked.as_array() {
        Some(all) => all.iter().map(|a| artifact_file(a, remote(job), &on["machineName"])).collect(),
        None => job["artifacts"].as_array().into_iter().flatten().map(|a| {
            json!({"path": a["path"].as_str().and_then(relative), "format": a["format"], "minBytes": a["minBytes"],
                "state": "declared"})
        }).collect(),
    };
    let note = if checked.is_array() {
        "Checked where the attempt ran, after it exited 0"
    } else if job["result"]["reportProblem"].is_string() {
        "The attempt's reports could not be read: declared only"
    } else {
        "Declared only: artifacts are checked only after a clean exit"
    };
    json!({"on": {"kind": on["kind"], "machineId": on["machineId"], "machineName": on["machineName"], "hostId": on["hostId"]},
        "checked": checked.is_array(), "files": files, "note": note})
}

fn upstream(job: &Value) -> Value {
    let list: Vec<Value> = job["upstream"].as_array().into_iter().flatten().map(|u| {
        let artifacts: Vec<Value> = u["artifacts"].as_array().into_iter().flatten()
            .map(|a| json!({"path": a["path"].as_str().and_then(relative), "bytes": a["bytes"], "sha256": a["sha256"]}))
            .collect();
        json!({"stage": u["stage"], "jobId": u["jobId"], "attempt": u["attempt"], "reused": u["reused"] == true,
            "artifacts": artifacts})
    }).collect();
    json!(list)
}

fn resources(job: &Value) -> Value {
    let measured = resource_summary::attempt(job);
    let gpu = &job["gpu"];
    let started = &job["result"]["started"];
    let held = &started["limits"];
    json!({"declared": job["resources"],
        "gpu": if gpu.is_object() { json!({"count": gpu["count"], "memoryMiB": gpu["memoryMiB"], "mode": gpu["mode"]}) } else { Value::Null },
        "held": if held.is_null() { json!({"state": "notRecorded"}) }
            else { json!({"limits": held, "state": "verified", "by": if remote(job) { "the machine's helper" } else { "the worker, before the command started" }}) },
        "measured": {"measurement": measured["measurement"], "reason": measured["reason"], "actual": measured["actual"],
            "state": if measured["measurement"] == "unavailable" { "notRecorded" } else { "verified" }, "scope": measured["scope"]}})
}

fn cost(job: &Value) -> Value {
    let cost = &job["result"]["cost"];
    if !cost.is_object() {
        return json!({"state": "notRecorded"});
    }
    // Numbers only: the command writes this file, its source names included.
    json!({"knownUsd": cost["knownUsd"], "unknownEntries": cost["unknownEntries"], "invalidLines": cost["invalidLines"],
        "incompleteLines": cost["incompleteLines"], "truncated": cost["truncated"], "complete": cost["complete"],
        "state": "declared", "by": "the command's own usage report"})
}

fn logs(job: &Value, extent: &Result<Value, String>) -> Value {
    if remote(job) {
        return json!({"exported": false, "state": "unknown", "retainedBytesLimit": LOG_LIMIT,
            "reason": "Its output ring is on that machine: read job_logs while it answers"});
    }
    match extent {
        Ok(e) if e["segments"].as_u64().unwrap_or(0) > 0 => json!({"exported": false, "state": "verified",
            "retainedBytesLimit": LOG_LIMIT, "totalBytes": e["totalBytes"], "oldestOffset": e["oldestOffset"],
            "truncated": e["truncated"]}),
        Ok(_) => json!({"exported": false, "state": "notRecorded", "reason": "No output ring was kept for this attempt"}),
        Err(error) => json!({"exported": false, "state": "unknown", "reason": format!("Its output ring could not be read: {error}")}),
    }
}

fn attempt(job: &Value, extent: &Result<Value, String>, known: &mut Known, labels: &mut Labels) -> Value {
    known.add(&job["cwd"], "<cwd>");
    known.add(&job["snapshot"]["cwd"], "<cwd>");
    known.add(&job["snapshot"]["git"]["root"], "<git root>");
    let inputs = inputs(job, known);
    for u in job["upstream"].as_array().into_iter().flatten() {
        known.add(&u["cwd"], &format!("<cwd of stage {}>", u["stage"].as_str().unwrap_or("?")));
    }
    let count = |v: &Value| v.as_array().map(|a| a.len()).or(v.as_object().map(|o| o.len())).unwrap_or(0);
    let run = &job["run"];
    json!({
        "jobId": job["id"], "attempt": job["attempt"], "name": job["name"], "taskRef": job["taskRef"],
        "run": if run.is_object() { json!({"id": run["id"], "stage": run["stage"], "attempt": run["attempt"]}) } else { Value::Null },
        "retryOf": job["retryOf"], "retriedBy": job["retriedBy"], "resumeOf": job["checkpointFrom"]["jobId"],
        "requestedBy": job["requestedBy"], "turnId": job["source"]["turnId"],
        "status": job["status"], "reason": job["reason"], "exit": exit(job),
        "times": {"createdAt": job["createdAt"], "startedAt": job["startedAt"], "finishedAt": job["finishedAt"]},
        "target": target(job),
        "executor": {"kind": target(job)["kind"], "capabilities": job["capabilities"]},
        "command": {"argv": {"exported": false, "count": count(&job["argv"])},
            "env": {"exported": false, "count": count(&job["env"])}, "cwd": {"exported": false},
            "timeoutSeconds": job["timeoutSeconds"], "guardGit": job["guardGit"]},
        "identity": if job["identity"].is_object() {
            let i = &job["identity"];
            json!({"command": labels.of("C", &i["parts"]["command"]), "code": labels.of("S", &i["parts"]["code"]),
                "attempt": labels.of("I", &i["sha256"]), "codeKnown": i["codeKnown"], "version": i["version"]})
        } else { json!({"state": "notRecorded"}) },
        "code": code(job),
        "inputs": inputs,
        "upstream": upstream(job),
        "artifacts": artifacts(job),
        "resources": resources(job),
        "cost": cost(job),
        "logs": logs(job, extent),
    })
}

fn run(run: &Value, labels: &mut Labels) -> Value {
    let stages: Vec<Value> = run["stages"].as_array().into_iter().flatten().map(|s| {
        let reused = &s["reusedFrom"];
        let attempts: Vec<Value> = s["attempts"].as_array().into_iter().flatten().map(|a| a["id"].clone()).collect();
        json!({"key": s["key"], "name": s["name"], "needs": s["needs"], "status": s["status"], "retry": s["retry"],
            "reusedFrom": if reused.is_object() { json!({"jobId": reused["jobId"], "attempt": reused["attempt"],
                "runId": reused["runId"], "identity": labels.of("I", &reused["identity"]), "verifiedAt": reused["verifiedAt"],
                "note": "An earlier attempt's verified result, not run again here"}) } else { Value::Null },
            "attempts": attempts})
    }).collect();
    let c = &run["cost"];
    json!({"id": run["id"], "name": run["name"], "experiment": run["experiment"], "status": run["status"],
        "taskRef": run["taskRef"], "requestedBy": run["requestedBy"], "createdAt": run["createdAt"],
        "costLimitUsd": run["costLimitUsd"], "stages": stages,
        "cost": {"knownUsd": c["knownUsd"], "unknownEntries": c["unknownEntries"], "invalidLines": c["invalidLines"],
            "truncated": c["truncated"], "attemptsReporting": c["attemptsReporting"], "complete": c["complete"],
            "state": "declared", "by": "each attempt's own usage report"}})
}

/// The manifest and its report. extents holds, per Job, what its log ring
/// headers say (local attempts only).
pub(super) fn export(run_view: Option<&Value>, jobs: &[Value], extents: &[Result<Value, String>], mut known: Known) -> Value {
    let mut labels = Labels::default();
    let attempts: Vec<Value> = jobs.iter().zip(extents).map(|(job, extent)| attempt(job, extent, &mut known, &mut labels)).collect();
    known.0.sort_by_key(|(path, _)| std::cmp::Reverse(path.len()));
    let (kind, id, task) = match run_view {
        Some(r) => ("run", r["id"].clone(), r["taskRef"].clone()),
        None => ("job", jobs[0]["id"].clone(), jobs[0]["taskRef"].clone()),
    };
    let mut manifest = json!({
        "schema": SCHEMA, "version": VERSION, "exportedAt": now(), "exportedBy": crate::guide::release(),
        "basis": BASIS,
        "scope": {"kind": kind, "id": id, "taskRef": task, "attempts": attempts.len()},
        "run": run_view.map(|r| run(r, &mut labels)),
        "attempts": attempts,
        "states": {"verified": "Checked by Core or the machine's helper when it was recorded",
            "declared": "Stated by the submission or reported by the command itself; not checked",
            "notRecorded": "Not recorded for this attempt, executor or version",
            "unknown": "Core could not establish it"},
        "labels": LABELS,
        "omitted": OMITTED,
    });
    known.scrub_all(&mut manifest);
    let report = report(&manifest);
    json!({"manifest": manifest, "report": report})
}

/// Recorded text, inert in Markdown: one line, nothing that formats.
fn md(value: &Value) -> String {
    let text = match value {
        Value::String(s) => s.clone(),
        Value::Null => return "unknown".to_owned(),
        other => other.to_string(),
    };
    let mut out = String::with_capacity(text.len());
    for c in text.chars().take(2000) {
        if c.is_control() {
            out.push(' ');
        } else {
            if "\\`*_{}[]<>|~#!".contains(c) {
                out.push('\\');
            }
            out.push(c);
        }
    }
    out
}

fn hex(value: &Value) -> String {
    match value.as_str() {
        Some(s) if !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_hexdigit()) => format!("`{s}`"),
        _ => md(value),
    }
}

fn bytes(value: &Value) -> String {
    match value.as_u64() {
        Some(n) if n >= 1024 * 1024 => format!("{:.1} MiB", n as f64 / 1_048_576.0),
        Some(n) if n >= 1024 => format!("{:.1} KiB", n as f64 / 1024.0),
        Some(n) => format!("{n} bytes"),
        None => "unknown size".to_owned(),
    }
}

fn where_ran(t: &Value) -> String {
    let name = md(&t["machineName"]);
    match t["kind"].as_str() {
        Some("local") => format!("this Core's host {name} (machine {})", md(&t["machineId"])),
        Some("windows") => format!("Windows on this Core's PC, {name}"),
        _ => format!("SSH machine {name} ({}{})", md(&t["machineId"]),
            t["hostId"].as_str().map(|h| format!(", host {}", hex(&json!(h.chars().take(12).collect::<String>())))).unwrap_or_default()),
    }
}

fn report(m: &Value) -> String {
    let mut out = String::new();
    let scope = &m["scope"];
    let title = match &m["run"] {
        Value::Object(_) => format!("run {}", md(&m["run"]["name"])),
        _ => format!("job {}", md(&m["attempts"][0]["name"])),
    };
    let _ = writeln!(out, "# Provenance of {title}\n");
    let _ = writeln!(out, "{} {}, task {}. Exported {} by Yuzuno Core {} (schema {} version {}).\n",
        if scope["kind"] == "run" { "Run" } else { "Job" }, md(&scope["id"]), md(&scope["taskRef"]),
        md(&m["exportedAt"]), md(&m["exportedBy"]["version"]), SCHEMA, VERSION);
    let _ = writeln!(out, "{BASIS}\n");
    let _ = writeln!(out, "Not included: {}.\n", OMITTED.join("; "));
    let _ = writeln!(out, "{LABELS}\n");
    if let Some(run) = m["run"].as_object() {
        let _ = writeln!(out, "## Run\n\nStatus {}. Recorded cost {} USD known{}.\n", md(&run["status"]),
            md(&run["cost"]["knownUsd"]),
            if run["cost"]["complete"] == true { "".to_owned() } else { format!(", incomplete ({} unknown entries)", md(&run["cost"]["unknownEntries"])) });
        for stage in run["stages"].as_array().into_iter().flatten() {
            let needs: Vec<String> = stage["needs"].as_array().into_iter().flatten().map(md).collect();
            let attempts = stage["attempts"].as_array().map_or(0, |a| a.len());
            let _ = writeln!(out, "- Stage {}: {}{}{}", md(&stage["key"]), md(&stage["status"]),
                if stage["reusedFrom"].is_object() { format!(", reused job {} (not run again here)", md(&stage["reusedFrom"]["jobId"])) }
                else { format!(", {attempts} attempt{}", if attempts == 1 { "" } else { "s" }) },
                if needs.is_empty() { String::new() } else { format!("; needs {}", needs.join(", ")) });
        }
        out.push('\n');
    }
    for a in m["attempts"].as_array().into_iter().flatten() {
        let heading = match a["run"]["stage"].as_str() {
            Some(_) => format!("Stage {} attempt {}", md(&a["run"]["stage"]), md(&a["run"]["attempt"])),
            None => format!("Job {}", md(&a["name"])),
        };
        let _ = writeln!(out, "## {heading}: {}\n", md(&a["status"]));
        let mut links = vec![format!("Job {}, attempt {}", md(&a["jobId"]), md(&a["attempt"]))];
        for (key, label) in [("retryOf", "retry of"), ("retriedBy", "retried by"), ("resumeOf", "resumed from")] {
            if a[key].is_string() {
                links.push(format!("{label} {}", md(&a[key])));
            }
        }
        let _ = writeln!(out, "- {}", links.join("; "));
        let _ = writeln!(out, "- Ran on {}", where_ran(&a["target"]));
        let t = &a["times"];
        let _ = writeln!(out, "- Submitted {} by {}; started {}; finished {}", md(&t["createdAt"]),
            md(&a["requestedBy"]["name"]), md(&t["startedAt"]), md(&t["finishedAt"]));
        let exit = &a["exit"];
        let ended = match (exit["code"].as_i64(), exit["signal"].as_i64()) {
            (Some(code), _) => format!("exit code {code} ({}, by {})", md(&exit["state"]), md(&exit["by"])),
            (None, Some(signal)) => format!("ended by signal {signal} ({}, by {})", md(&exit["state"]), md(&exit["by"])),
            _ => format!("exit status {}", md(&exit["state"])),
        };
        let _ = writeln!(out, "- Outcome: {}; {ended}", md(&a["reason"]));
        let code = &a["code"];
        let _ = match code["git"]["head"].as_str() {
            Some(_) => writeln!(out, "- Code: Git {}, tracked changes {} ({}: {})", hex(&code["git"]["head"]),
                md(&code["git"]["trackedChanges"]), md(&code["state"]), md(&code["when"])),
            None => writeln!(out, "- Code: {} ({})", md(&code["note"]), md(&code["state"])),
        };
        let inputs = &a["inputs"];
        let files = inputs["files"].as_array().cloned().unwrap_or_default();
        let _ = writeln!(out, "- Inputs: {} file{} frozen by SHA-256{}{}", files.len(), if files.len() == 1 { "" } else { "s" },
            inputs["frozenOn"].as_str().map(|m| format!(" on {}", md(&json!(m)))).unwrap_or_default(),
            match inputs["withheld"].as_u64() { Some(n) if n > 0 => format!("; {n} path{} withheld (outside the working directory)", if n == 1 { "" } else { "s" }), _ => String::new() });
        for f in &files {
            let _ = writeln!(out, "  - {}{}: {}", if f["base"] == "gitRoot" { "Git root/" } else { "" },
                f["path"].as_str().map_or("(path withheld)".to_owned(), |p| md(&json!(p))),
                if f["sha256"].is_string() { hex(&f["sha256"]) } else { "missing at submission".to_owned() });
        }
        for u in a["upstream"].as_array().into_iter().flatten() {
            let list: Vec<String> = u["artifacts"].as_array().into_iter().flatten()
                .map(|x| format!("{} {}", md(&x["path"]), hex(&x["sha256"]))).collect();
            let _ = writeln!(out, "- Read from stage {} (job {}{}): {}", md(&u["stage"]), md(&u["jobId"]),
                if u["reused"] == true { ", reused" } else { "" }, list.join(", "));
        }
        let c = &a["command"];
        let i = &a["identity"];
        let _ = writeln!(out, "- Command: not exported ({} arguments, {} environment variables); command {}, code {}, identity {}",
            md(&c["argv"]["count"]), md(&c["env"]["count"]), md(&i["command"]), md(&i["code"]), md(&i["attempt"]));
        let r = &a["resources"];
        let actual = &r["measured"]["actual"];
        let _ = writeln!(out, "- Resources: declared {} mCPU, {} MiB memory, {} MiB swap; held {}; measured {}{}",
            md(&r["declared"]["cpuMillis"]), md(&r["declared"]["memoryMiB"]), md(&r["declared"]["swapMiB"]), md(&r["held"]["state"]),
            md(&r["measured"]["measurement"]),
            if actual["memoryPeakMiB"].is_number() || actual["averageCpuCores"].is_number() {
                format!(" (peak {} MiB, average {} cores)", md(&json!(actual["memoryPeakMiB"].as_f64().map(|n| format!("{n:.1}")))),
                    md(&json!(actual["averageCpuCores"].as_f64().map(|n| format!("{n:.2}")))))
            } else { r["measured"]["reason"].as_str().map(|why| format!(": {}", md(&json!(why)))).unwrap_or_default() });
        if a["cost"]["state"] != "notRecorded" {
            let _ = writeln!(out, "- Cost: {} USD known, {} unknown entries (reported by the command, not checked)",
                md(&a["cost"]["knownUsd"]), md(&a["cost"]["unknownEntries"]));
        }
        let art = &a["artifacts"];
        let _ = writeln!(out, "- Artifacts on {}: {}", md(&art["on"]["machineName"]), md(&art["note"]));
        for f in art["files"].as_array().into_iter().flatten() {
            let path = f["path"].as_str().map_or("(path withheld)".to_owned(), |p| md(&json!(p)));
            let _ = match f["state"].as_str() {
                Some("verified") if f["ok"] == true => writeln!(out, "  - {path}: {}, {}, verified; {}", bytes(&f["bytes"]),
                    if f["sha256"].is_string() { format!("SHA-256 {}", hex(&f["sha256"])) }
                    else { "not hashed (over 1 GiB): identified by size and modification time".to_owned() },
                    if f["fetch"]["available"] == true { "downloadable from Core after a fresh check".to_owned() }
                    else { md(&f["fetch"]["reason"]) }),
                Some("verified") => writeln!(out, "  - {path}: failed its check: {}", md(&f["problem"])),
                _ => writeln!(out, "  - {path}: declared, not checked"),
            };
        }
        let l = &a["logs"];
        let _ = match l["state"].as_str() {
            Some("verified") => writeln!(out, "- Output: not exported; {} written, {}", bytes(&l["totalBytes"]),
                if l["truncated"] == true { format!("the first {} were overwritten (2 MiB ring)", bytes(&l["oldestOffset"])) } else { "all of it retained".to_owned() }),
            _ => writeln!(out, "- Output: not exported; {}", md(&l["reason"])),
        };
        out.push('\n');
    }
    out
}
