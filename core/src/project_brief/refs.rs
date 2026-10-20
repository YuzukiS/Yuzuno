//! Live References: the items a section's LiveRefs blocks name, with their
//! current state as Core's own stores hold it. Agents only name an item;
//! nothing here calls GitHub or a machine, and an item Core does not know
//! is shown as not found, never guessed.
use super::*;
use std::collections::HashMap;

/// How the state reads at a glance (LiveRefState.tone).
fn tone(state: &str) -> &'static str {
    match state {
        "failed" | "changes_requested" | "error" | "rejected" | "interrupted" | "unreachable" | "waiting" | "blocked" => {
            "attention"
        }
        "running" | "doing" | "working" | "queued" | "starting" | "preparing" | "pending" | "cancelling" | "review" => {
            "active"
        }
        "passed" | "merged" | "done" | "succeeded" | "no_findings" | "approved_with_notes" | "reachable" => "ok",
        _ => "neutral",
    }
}

fn state(mut found: Value, state: &str) -> Value {
    found["state"] = json!(state);
    found["tone"] = json!(tone(state));
    found
}

fn data(db: &Connection, sql: &str, id: &str) -> Result<Option<Value>> {
    let raw: Option<String> = db.query_row(sql, [id], |r| r.get(0)).optional()?;
    Ok(match raw {
        Some(raw) => Some(serde_json::from_str(&raw)?),
        None => None,
    })
}

/// Resolves and remembers references for one read.
pub(super) struct Refs<'a> {
    store: &'a Store,
    db: &'a Connection,
    known: HashMap<String, Value>,
}

impl<'a> Refs<'a> {
    pub fn new(store: &'a Store, db: &'a Connection) -> Self {
        Self { store, db, known: HashMap::new() }
    }

    /// `${kind}:${id}` to LiveRefState, for every LiveRefs item in `body`.
    pub fn of(&mut self, body: &Value) -> Value {
        let mut refs = serde_json::Map::new();
        let blocks = body["elements"].as_object().into_iter().flat_map(|elements| elements.values());
        for block in blocks.filter(|block| block["type"] == "LiveRefs") {
            for item in block["props"]["items"].as_array().into_iter().flatten() {
                let (Some(kind), Some(id)) = (item["kind"].as_str(), item["id"].as_str()) else { continue };
                let key = format!("{kind}:{id}");
                if !self.known.contains_key(&key) {
                    let resolved = self.resolve(kind, id).unwrap_or_else(|error| {
                        eprintln!("Brief reference {key} unresolved: {error:#}");
                        None
                    });
                    let mut shown = resolved.unwrap_or_else(|| json!({"found":false}));
                    shown["kind"] = json!(kind);
                    shown["id"] = json!(id);
                    self.known.insert(key.clone(), shown);
                }
                refs.insert(key.clone(), self.known[&key].clone());
            }
        }
        Value::Object(refs)
    }

    fn resolve(&self, kind: &str, id: &str) -> Result<Option<Value>> {
        let db = self.db;
        Ok(match kind {
            "task" => {
                let Ok((task, _)) = crate::collaboration_store::task_key(db, id) else { return Ok(None) };
                data(db, "SELECT data FROM collaboration_tasks WHERE id=?1", &task)?.map(|task| {
                    state(json!({"found":true,"title":task["title"]}), task["status"].as_str().unwrap_or("unknown"))
                })
            }
            "job" => data(db, "SELECT data FROM local_jobs WHERE id=?1", id)?.map(|job| {
                let mut shown = state(json!({"found":true,"title":job["name"]}), job["status"].as_str().unwrap_or("unknown"));
                shown["taskId"] = job["taskRef"].clone();
                shown
            }),
            "review" => match data(db, "SELECT data FROM pr_reviews WHERE id=?1", id)? {
                Some(run) => {
                    let status = run["status"].as_str().unwrap_or("unknown");
                    let conclusion = run["conclusion"].as_str().filter(|c| !matches!(*c, "unknown" | ""));
                    let task: Option<i64> = db.query_row(
                        "SELECT t.seq FROM pr_reviews r JOIN collaboration_tasks t ON t.id=r.task_id WHERE r.id=?1",
                        [id], |r| r.get(0)).optional()?;
                    let mut shown = state(json!({"found":true,"title":run["title"]}), conclusion.unwrap_or(status));
                    if let Some(seq) = task {
                        shown["taskId"] = json!(format!("T-{seq}"));
                    }
                    for (field, from) in [("url", "url"), ("observedAt", "finishedAt")] {
                        if run[from].is_string() {
                            shown[field] = run[from].clone();
                        }
                    }
                    Some(shown)
                }
                None => None,
            },
            "ci" => {
                let run = match data(db, "SELECT data FROM ci_runs WHERE id=?1", id)? {
                    Some(run) => Some(run),
                    None => data(db, "SELECT data FROM ci_runs WHERE json_extract(data,'$.runId')=?1 ORDER BY seq DESC LIMIT 1", id)?,
                };
                run.map(|run| {
                    let mut shown = state(json!({"found":true,"title":run["name"],"url":run["url"]}), run["status"].as_str().unwrap_or("unknown"));
                    if run["observedAt"].is_string() {
                        shown["observedAt"] = run["observedAt"].clone();
                    }
                    shown
                })
            }
            "pr" => {
                // owner/repo#12, or the linked object's own ID.
                let object = match id.rsplit_once('#') {
                    Some((repo, number)) if number.parse::<i64>().is_ok() => db.query_row(
                        "SELECT o.data,json_extract(r.data,'$.fullName'),o.number FROM github_objects o
                         JOIN github_repositories r ON r.id=o.repo_id
                         WHERE lower(json_extract(r.data,'$.fullName'))=lower(?1) AND o.kind='pull' AND o.number=?2",
                        params![repo, number.parse::<i64>()?],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?)),
                    ).optional()?,
                    _ => db.query_row(
                        "SELECT o.data,json_extract(r.data,'$.fullName'),o.number FROM github_objects o
                         JOIN github_repositories r ON r.id=o.repo_id WHERE o.id=?1 AND o.kind='pull'",
                        [id],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?)),
                    ).optional()?,
                };
                match object {
                    Some((raw, repo, number)) => {
                        let object: Value = serde_json::from_str(&raw)?;
                        let snapshot = &object["snapshot"];
                        let mut shown = state(json!({"found":true,"title":snapshot["title"]}), snapshot["state"].as_str().unwrap_or("unknown"));
                        if let Some(repo) = repo {
                            shown["url"] = json!(format!("https://github.com/{repo}/pull/{number}"));
                        }
                        if object["syncedAt"].is_string() {
                            shown["observedAt"] = object["syncedAt"].clone();
                        }
                        Some(shown)
                    }
                    None => None,
                }
            }
            "agent" => self.store.brief_in(db, id)?.map(|brief| {
                let agent = brief.agent;
                let status = if agent.closed_at.is_some() { "closed" } else { agent.status.as_str() };
                state(json!({"found":true,"title":agent.name}), status)
            }),
            "machine" => {
                let name = if id == "local" {
                    Some(json!("Core host"))
                } else {
                    data(db, "SELECT data FROM machines WHERE id=?1", id)?.map(|machine| machine["name"].clone())
                };
                match name {
                    Some(name) => {
                        let check = data(db, "SELECT data FROM machine_checks WHERE machine_id=?1", id)?;
                        let mut shown = json!({"found":true,"title":name});
                        if let Some(check) = check {
                            shown = state(shown, if check["reachable"] == true { "reachable" } else { "unreachable" });
                            shown["observedAt"] = check["checkedAt"].clone();
                        }
                        Some(shown)
                    }
                    None => None,
                }
            }
            _ => None,
        })
    }
}
