//! Research records on a task (T-17): a method, a claim or an observation an
//! Agent or the user appends to the task's activity with `task_comment`.
//! A record is a comment: it never changes the task's status, version or
//! result and sends no mail; a formal outcome is still `task_submit_result`.
//! No Home permission is involved, and removing a Home card removes nothing
//! here.
//!
//! A record is fixed once written. A revision is a new record with the same
//! type and id that names the one it revises and why; a claim or observation
//! cites a method by its activity, so a later method version never changes
//! what an earlier claim was made with.
//!
//! Each source keeps the identity it had when it was recorded, and a read
//! shows its state now beside it, never instead of it:
//! - job: an artifact of this task's own Job attempt, which must be a recorded
//!   match at writing (the check results use, `result_outcome::matched`);
//! - task: a research record or result on a task, with its original producer;
//! - external: material from elsewhere, as its author stated it, never checked.
use super::*;
use anyhow::anyhow;

const MAX_BYTES: usize = 32_768;
const TYPES: &[&str] = &["method", "claim", "observation"];
const FIELDS: &[&str] = &["theory", "systems", "ml", "robotics", "other"];
const STANDING: &[&str] = &["supported", "conditional", "unsupported", "open"];
const MAX_SOURCES: usize = 20;
const MAX_NOTES: usize = 12;
/// How far a read follows a revision chain; a longer chain reads as unknown.
const CHAIN: usize = 200;

/// One activity of one task, by its key: no history is read (see
/// current_tests.rs, which checks every query here goes through an index).
pub(super) const ONE_ACTIVITY: &str =
    "SELECT data FROM collaboration_task_activity WHERE seq=?2 AND task_id=?1";
/// The first record of a task with this research id.
pub(super) const RECORD_BY_ID: &str = "SELECT seq FROM collaboration_task_activity WHERE task_id=?1 \
    AND json_extract(data,'$.research.id')=?2 AND json_extract(data,'$.research.id') IS NOT NULL ORDER BY seq LIMIT 1";
/// The record that revises this one, if any.
pub(super) const REVISED_BY: &str = "SELECT seq FROM collaboration_task_activity WHERE task_id=?1 \
    AND json_extract(data,'$.research.revises.activitySeq')=?2 \
    AND json_extract(data,'$.research.revises.activitySeq') IS NOT NULL ORDER BY seq LIMIT 1";
pub(super) const SCHEMA: &str = "CREATE INDEX IF NOT EXISTS collaboration_activity_research_id
    ON collaboration_task_activity(task_id,json_extract(data,'$.research.id'))
    WHERE json_extract(data,'$.research.id') IS NOT NULL;
    CREATE INDEX IF NOT EXISTS collaboration_activity_research_revises
    ON collaboration_task_activity(task_id,json_extract(data,'$.research.revises.activitySeq'))
    WHERE json_extract(data,'$.research.revises.activitySeq') IS NOT NULL;";

const NOTE: &str = "A research record is its author's statement, fixed when it was written; a claim's status is the author's judgement, not a verdict, independent verification or acceptance. Each source shows the identity recorded with it and, separately, its state now. A Job source was a recorded match of this task's exact Job attempt when written; its state now compares retained Job records only, no file is read. A task source keeps its original producer and is not this task's artifact. An external source is as its author stated it and is never checked.";

pub(super) fn schema() -> Value {
    let text = |max: usize| json!({"type":"string","maxLength":max});
    let notes = json!({"type":"array","maxItems":MAX_NOTES,"items":text(600)});
    let seq = json!({"type":"integer","minimum":1});
    let source = json!({"type":"object","additionalProperties":false,
        "description":"job: an artifact of this task's own Job attempt (jobId, attempt, path, sha256); it must match the retained check. task: a research record or result on a task (taskId, activitySeq); its producer is kept. external: material from elsewhere (label; url, version, observedAt, sha256, coverage), recorded as stated and never checked.",
        "properties":{"kind":{"type":"string","enum":["job","task","external"]},"label":text(300),
            "jobId":text(128),"attempt":{"type":"string","format":"uuid"},"path":text(4096),
            "sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},
            "taskId":{"type":"string","description":TASK_ID},"activitySeq":seq.clone(),
            "url":text(2000),"version":text(300),"observedAt":text(64),"coverage":text(1000)},
        "required":["kind"]});
    json!({"type":"object","additionalProperties":false,
        "description":"Optional research record, at most 32768 UTF-8 bytes, fixed once written. A revision is a new record with the same type and id and revises {activitySeq, reason}; an id already in this task must be revised, not reused. Claims and observations may cite a method record of this task by activitySeq. Materials may be incomplete: say so in limits.",
        "properties":{
            "type":{"type":"string","enum":TYPES},
            "id":{"type":"string","pattern":"^[a-z0-9][a-z0-9-]{0,63}$","description":"The record's name in this task, for example timing-protocol."},
            "title":text(300),
            "text":{"type":"string","maxLength":8000,"description":"The method, the claim's statement or what was observed."},
            "field":{"type":"string","enum":FIELDS},
            "status":{"type":"string","enum":STANDING,"description":"Claims only: the author's judgement of support."},
            "conditions":notes.clone(),"limits":notes,
            "method":{"type":"object","additionalProperties":false,"properties":{"activitySeq":seq.clone()},"required":["activitySeq"]},
            "sources":{"type":"array","maxItems":MAX_SOURCES,"items":source},
            "revises":{"type":"object","additionalProperties":false,"properties":{"activitySeq":seq,"reason":text(2000)},"required":["activitySeq","reason"]}},
        "required":["type","id","title","text"]})
}

fn choice(input: &Value, field: &str, values: &[&str]) -> Result<Option<String>> {
    match input.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if values.contains(&value.as_str()) => Ok(Some(value.clone())),
        _ => bail!("invalid_input: research.{field} must be one of {}", values.join(", ")),
    }
}

fn positive(input: &Value, field: &str) -> Result<i64> {
    input[field]
        .as_i64()
        .filter(|seq| *seq > 0)
        .with_context(|| format!("invalid_input: {field} must be a positive activity sequence"))
}

fn notes(input: &Value, field: &str) -> Result<Option<Value>> {
    let Some(value) = input.get(field).filter(|v| !v.is_null()) else { return Ok(None) };
    let items = value
        .as_array()
        .with_context(|| format!("invalid_input: research.{field} must be an array of text"))?;
    ensure!(items.len() <= MAX_NOTES, "invalid_input: at most {MAX_NOTES} research.{field}");
    for item in items {
        let text = item
            .as_str()
            .with_context(|| format!("invalid_input: research.{field} must be an array of text"))?;
        ensure!(
            !text.trim().is_empty() && text.len() <= 600,
            "invalid_input: each of research.{field} is 1 to 600 bytes"
        );
    }
    Ok((!items.is_empty()).then(|| value.clone()))
}

fn valid_id(id: &str) -> bool {
    id.len() <= 64
        && id.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The activity `seq` of task `task`, by its key; None when this task has none.
pub(super) fn one_activity(db: &Connection, task: &str, seq: i64) -> Result<Option<Value>> {
    let raw: Option<String> = db.query_row(ONE_ACTIVITY, params![task, seq], |r| r.get(0)).optional()?;
    raw.map(|raw| Ok(serde_json::from_str(&raw)?)).transpose()
}

/// The research record `seq` of task `task`; None when it is not one.
fn record_in(db: &Connection, task: &str, seq: i64) -> Result<Option<Value>> {
    Ok(one_activity(db, task, seq)?.filter(|row| row["research"].is_object()))
}

fn first_with_id(db: &Connection, task: &str, id: &str) -> Result<Option<i64>> {
    Ok(db.query_row(RECORD_BY_ID, params![task, id], |r| r.get(0)).optional()?)
}

fn revised_by(db: &Connection, task: &str, seq: i64) -> Result<Option<i64>> {
    Ok(db.query_row(REVISED_BY, params![task, seq], |r| r.get(0)).optional()?)
}

/// The record a comment carries, checked and with each source's identity
/// fixed; None without one. Anything refused writes nothing.
pub(super) fn validate(db: &Connection, task: &SharedTask, input: Option<&Value>) -> Result<Option<Value>> {
    let Some(input) = input.filter(|v| !v.is_null()) else { return Ok(None) };
    ensure!(input.is_object(), "invalid_input: research must be an object");
    ensure!(
        serde_json::to_vec(input)?.len() <= MAX_BYTES,
        "invalid_input: research exceeds {MAX_BYTES} bytes"
    );
    allowed(
        input,
        &["type", "id", "title", "text", "field", "status", "conditions", "limits", "method", "sources", "revises"],
    )?;
    let kind = choice(input, "type", TYPES)?.context("invalid_input: research.type is required")?;
    let id = required_text(input, "id", 64)?;
    ensure!(
        valid_id(&id),
        "invalid_input: research.id is 1 to 64 lowercase letters, digits and hyphens, starting with a letter or digit"
    );
    let mut out = json!({"schema":"research/1","type":kind,"id":id,
        "title":required_text(input, "title", 300)?,"text":required_text(input, "text", 8000)?});
    if let Some(field) = choice(input, "field", FIELDS)? {
        out["field"] = json!(field);
    }
    match (kind.as_str(), choice(input, "status", STANDING)?) {
        ("claim", Some(status)) => out["status"] = json!(status),
        ("claim", None) => bail!("invalid_input: a claim needs research.status, its author's judgement of support"),
        (_, Some(_)) => bail!("invalid_input: research.status is for claims only"),
        (_, None) => {}
    }
    for field in ["conditions", "limits"] {
        if let Some(value) = notes(input, field)? {
            out[field] = value;
        }
    }
    if let Some(method) = input.get("method").filter(|v| !v.is_null()) {
        ensure!(kind != "method", "invalid_input: a method does not cite a method; revise it instead");
        allowed(method, &["activitySeq"])?;
        let seq = positive(method, "activitySeq")?;
        let cited = record_in(db, &task.id, seq)?
            .filter(|row| row["research"]["type"] == "method")
            .with_context(|| format!("invalid_input: research.method: activity {seq} is not a method record of this task"))?;
        // The activity fixes the version: a later revision of the method does
        // not change what this record was made with.
        out["method"] = json!({"activitySeq":seq,"id":cited["research"]["id"],"title":cited["research"]["title"]});
    }
    match input.get("revises").filter(|v| !v.is_null()) {
        Some(revises) => {
            allowed(revises, &["activitySeq", "reason"])?;
            let seq = positive(revises, "activitySeq")?;
            let reason = required_text(revises, "reason", 2000)?;
            let previous = record_in(db, &task.id, seq)?
                .with_context(|| format!("invalid_input: research.revises: activity {seq} is not a research record of this task"))?;
            ensure!(
                previous["research"]["type"] == out["type"] && previous["research"]["id"] == out["id"],
                "invalid_input: research.revises: activity {seq} is the {} {}; a revision keeps its type and id",
                previous["research"]["type"].as_str().unwrap_or_default(),
                previous["research"]["id"].as_str().unwrap_or_default()
            );
            // One line of versions: a record already revised is not revised again.
            if let Some(later) = revised_by(db, &task.id, seq)? {
                bail!("invalid_input: research.revises: activity {seq} was already revised by activity {later}; revise the latest version");
            }
            out["revises"] = json!({"activitySeq":seq,"reason":reason});
        }
        None => {
            if let Some(first) = first_with_id(db, &task.id, &id)? {
                bail!("invalid_input: research.id {id} is already used in this task (activity {first}); revise its latest version with research.revises");
            }
        }
    }
    if let Some(sources) = input.get("sources").filter(|v| !v.is_null()) {
        let sources = sources.as_array().context("invalid_input: research.sources must be an array")?;
        ensure!(sources.len() <= MAX_SOURCES, "invalid_input: at most {MAX_SOURCES} research.sources");
        let fixed = sources
            .iter()
            .enumerate()
            .map(|(n, source)| {
                fix_source(db, task, source)
                    .map_err(|error| anyhow!("{error} (research.sources[{n}])"))
            })
            .collect::<Result<Vec<_>>>()?;
        if !fixed.is_empty() {
            out["sources"] = json!(fixed);
        }
    }
    Ok(Some(out))
}

/// A source with the identity it has now, kept as it is written.
fn fix_source(db: &Connection, task: &SharedTask, source: &Value) -> Result<Value> {
    ensure!(source.is_object(), "invalid_input: a research source is an object");
    let label = optional_text(source, "label", 300)?.filter(|label| !label.trim().is_empty());
    let mut out = match source["kind"].as_str() {
        Some("job") => {
            allowed(source, &["kind", "label", "jobId", "attempt", "path", "sha256"])?;
            let reference = json!({"jobId":source["jobId"],"attempt":source["attempt"],
                "path":source["path"],"sha256":source["sha256"]});
            let binding = result_outcome::matched(db, &task.id, "", &reference)?;
            json!({"kind":"job","jobId":reference["jobId"],"attempt":reference["attempt"],
                "path":reference["path"],"sha256":reference["sha256"],"bytes":binding["bytes"],
                "recorded":"recorded_match"})
        }
        Some("task") => {
            allowed(source, &["kind", "label", "taskId", "activitySeq"])?;
            let (cited, number) = task_key(db, &required_text(source, "taskId", 128)?)?;
            let seq = positive(source, "activitySeq")?;
            let row = one_activity(db, &cited, seq)?
                .with_context(|| format!("invalid_input: {} has no activity {seq}", task_number(number)))?;
            let record = cited_record(&row).with_context(|| {
                format!("invalid_input: activity {seq} of {} is neither a research record nor a result", task_number(number))
            })?;
            json!({"kind":"task","taskId":cited,"activitySeq":seq,"record":record,
                "producer":row["actor"],"at":row["at"]})
        }
        Some("external") => {
            allowed(source, &["kind", "label", "url", "version", "observedAt", "sha256", "coverage"])?;
            let mut out = json!({"kind":"external","checked":false});
            ensure!(label.is_some(), "invalid_input: an external source needs a label");
            if let Some(url) = optional_text(source, "url", 2000)?.filter(|url| !url.is_empty()) {
                ensure!(
                    url.starts_with("https://") || url.starts_with("http://"),
                    "invalid_input: an external source's url is http or https"
                );
                out["url"] = json!(url);
            }
            for (field, max) in [("version", 300), ("observedAt", 64), ("coverage", 1000)] {
                if let Some(value) = optional_text(source, field, max)?.filter(|value| !value.trim().is_empty()) {
                    out[field] = json!(value);
                }
            }
            if let Some(sha) = optional_text(source, "sha256", 64)?.filter(|sha| !sha.is_empty()) {
                ensure!(
                    sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                    "invalid_input: an external source's sha256 is 64 lowercase hexadecimal characters"
                );
                out["sha256"] = json!(sha);
            }
            out
        }
        _ => bail!("invalid_input: a research source's kind is job, task or external"),
    };
    if let Some(label) = label {
        out["label"] = json!(label);
    }
    Ok(out)
}

/// What a task source names, as written: a research record or a result.
fn cited_record(row: &Value) -> Option<Value> {
    if let Some(research) = row["research"].as_object() {
        let mut record = json!({"kind":"research","type":research.get("type"),"id":research.get("id"),
            "title":research.get("title")});
        if let Some(status) = research.get("status") {
            record["status"] = status.clone();
        }
        return Some(record);
    }
    (row["kind"] == "result").then(|| {
        let summary: String = row["result"]["summary"].as_str().unwrap_or_default().chars().take(300).collect();
        json!({"kind":"result","resultId":row["result"]["id"],"summary":summary})
    })
}

/// Stored task references are UUIDs; answers name tasks as T-n.
pub(super) fn project(db: &Connection, activity: &mut Value) -> Result<()> {
    if let Some(sources) = activity["research"]["sources"].as_array_mut() {
        for source in sources {
            if source["kind"] == "task" {
                if let Some(reference) = source["taskId"].as_str() {
                    if let Ok((_, number)) = task_key(db, reference) {
                        source["taskId"] = json!(task_number(number));
                    }
                }
            }
        }
    }
    Ok(())
}

/// Retries name tasks either way; compare them as the stored UUID.
pub(super) fn normalize(db: &Connection, input: &mut Value) {
    if let Some(sources) = input["research"]["sources"].as_array_mut() {
        for source in sources {
            if source["kind"] == "task" {
                if let Some(reference) = source["taskId"].as_str() {
                    if let Ok((id, _)) = task_key(db, reference) {
                        source["taskId"] = json!(id);
                    }
                }
            }
        }
    }
}

/// The version of a record in its id's line (1 for the first), by following
/// what each revises; None past CHAIN steps.
fn version_of(db: &Connection, task: &str, row: &Value) -> Result<Option<usize>> {
    let mut at = row["research"]["revises"]["activitySeq"].as_i64();
    for steps in 0..CHAIN {
        let Some(seq) = at else { return Ok(Some(steps + 1)) };
        at = record_in(db, task, seq)?.and_then(|previous| previous["research"]["revises"]["activitySeq"].as_i64());
    }
    Ok(None)
}

/// The record that revises `seq` and the newest version of its line.
fn newer(db: &Connection, task: &str, seq: i64) -> Result<(Option<i64>, Option<i64>)> {
    let next = revised_by(db, task, seq)?;
    let mut latest = seq;
    for _ in 0..CHAIN {
        match revised_by(db, task, latest)? {
            Some(later) => latest = later,
            None => return Ok((next, Some(latest))),
        }
    }
    Ok((next, None))
}

/// A source's state now, beside the identity it was recorded with.
fn now(db: &Connection, task: &str, source: &Value) -> Result<Value> {
    Ok(match source["kind"].as_str() {
        Some("job") => {
            let binding = result_outcome::resolve(db, task, "", source)?;
            json!({"state":binding["state"],"jobStatus":binding["jobStatus"],
                "downloadable":binding["downloadable"],"index":binding["index"]})
        }
        Some("task") => {
            let readable = match source["taskId"].as_str().map(|reference| task_key(db, reference)) {
                Some(Ok((cited, _))) => one_activity(db, &cited, source["activitySeq"].as_i64().unwrap_or(0))?.is_some(),
                _ => false,
            };
            json!({"state": if readable { "readable" } else { "missing" }})
        }
        _ => json!({"state":"stated"}),
    })
}

/// A record as a reader needs it: as written, where it stands in its line,
/// the method version it cites, and each source's fixed identity with its
/// state now.
fn view(db: &Connection, task: &SharedTask, seq: i64, row: Value) -> Result<Value> {
    let mut research = row["research"].clone();
    if let Some(sources) = research["sources"].as_array_mut() {
        for source in sources {
            source["now"] = now(db, &task.id, source)?;
        }
    }
    let (revised_by, latest) = newer(db, &task.id, seq)?;
    let mut out = json!({"taskId":task.id,"activitySeq":seq,"actor":row["actor"],"at":row["at"],
        "source":row["source"],"body":row["body"],"research":research,
        "version":version_of(db, &task.id, &row)?,"revisedBy":revised_by,"latestActivitySeq":latest});
    project(db, &mut out)?;
    out["taskId"] = json!(task_number(task.seq));
    Ok(out)
}

/// `task_research_get`: one record by its activity, read by key.
pub(super) fn get(db: &Connection, input: &Value) -> Result<Value> {
    allowed(input, &["taskId", "activitySeq"])?;
    let task = load_task(db, &required_text(input, "taskId", 128)?)?;
    let seq = positive(input, "activitySeq")?;
    let row = record_in(db, &task.id, seq)?.with_context(|| {
        format!("not_found: activity {seq} is not a research record of {}", task_number(task.seq))
    })?;
    let method = match row["research"]["method"]["activitySeq"].as_i64() {
        Some(cited) => match record_in(db, &task.id, cited)? {
            Some(method) => view(db, &task, cited, method)?,
            None => Value::Null,
        },
        None => Value::Null,
    };
    let mut out = view(db, &task, seq, row)?;
    out["method"] = method;
    out["note"] = json!(NOTE);
    Ok(out)
}

/// A Task record as a Home ResearchDesk source names it (T-17): what it is,
/// who produced it, and whether it can be read now. The desk reads it through
/// this, as the task's own view does; nothing is copied into the Brief.
pub(crate) fn desk_source(db: &Connection, reference: &str, seq: i64) -> Result<Value> {
    let Ok((task, number)) = task_key(db, reference) else {
        return Ok(json!({"available":false,"reason":"task_not_found"}));
    };
    let Some(row) = one_activity(db, &task, seq)? else {
        return Ok(json!({"taskId":task_number(number),"activitySeq":seq,"available":false,"reason":"activity_not_found"}));
    };
    let Some(record) = cited_record(&row) else {
        return Ok(json!({"taskId":task_number(number),"activitySeq":seq,"available":false,"reason":"not_research"}));
    };
    let mut out = json!({"taskId":task_number(number),"activitySeq":seq,"available":true,
        "record":record,"producer":row["actor"],"at":row["at"]});
    if row["research"].is_object() {
        let (_, latest) = newer(db, &task, seq)?;
        out["version"] = json!(version_of(db, &task, &row)?);
        out["latestActivitySeq"] = json!(latest);
    }
    Ok(out)
}

#[cfg(test)]
#[path = "research_tests.rs"]
mod tests;
