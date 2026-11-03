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
//!
//! A comparison (slice 2) is a record too: a fixed set of entries compared
//! for one question. Each entry is included, excluded, missing or not done,
//! and only an included one goes without a reason, so what was left out stays
//! in view. An entry states its source (the same fixed identities), method
//! record, definition, unit, sample level and value as its author gives them.
//! A read says which of unit, definition, level and method the included
//! entries share; Yuzuno never computes a difference.
//!
//! A formal result (slice 3) may cite this task's records under a criterion,
//! each by a citation summary fixed when the result was submitted; the text,
//! method and sources stay with the record. A cited claim's status
//! is its author's scientific judgement; the criterion's reported status is
//! the result author's against the fixed acceptance, and neither is derived
//! from the other.
//!
//! The research loop (slice 4) runs on the existing Agent and Jobs: a run may
//! name the method record it follows, an analysis decision may cite the
//! record that explains it, and a record may say the next check it proposes
//! or why to stop. A record never starts, retries or stops anything itself.
//!
//! Slice 5: a record may keep what its kind of study keeps apart (`details`,
//! by field, never required): a theory result and how it was checked, the
//! levels of a systems evaluation, an ML baseline, selection and budget, a
//! robot's episode counts, which may overlap. A claim's new version may say
//! what it does to the earlier scope (narrows, withdraws, or applicability
//! not checked yet); without that, the earlier scope stands as written, and
//! no version revokes another by itself.
use super::*;
use anyhow::anyhow;
use serde_json::Map;

const MAX_BYTES: usize = 32_768;
const TYPES: &[&str] = &["method", "claim", "observation", "comparison"];
const ENTRY_STATES: &[&str] = &["included", "excluded", "missing", "not_done"];
const MAX_ENTRIES: usize = 40;
/// What included entries must share before they are more than side by side.
const ALIGNED: &[&str] = &["unit", "definition", "level", "method"];
const FIELDS: &[&str] = &["theory", "systems", "ml", "robotics", "other"];
const STANDING: &[&str] = &["supported", "conditional", "unsupported", "open"];
/// What a record proposes next: a check that could tell explanations apart,
/// or a stop with its reason. A proposal; it runs nothing.
const NEXT: &[&str] = &["check", "stop"];
/// What a claim's new version does to the earlier version's scope. Without
/// one the earlier scope stands as written: a new version never revokes it.
const SCOPES: &[&str] = &["narrows", "withdraws", "unchecked"];
/// What each kind of study may keep apart in `details`; nothing is required.
const DETAILS: &[(&str, &[&str])] = &[
    ("theory", &["result", "checked", "bound", "obligations"]),
    ("systems", &["machines", "builds", "processes", "iterations", "warmup"]),
    ("ml", &["baseline", "selection", "budget", "seeds", "split"]),
    ("robotics", &["planned", "executed", "completed", "intervened", "stopped", "excluded", "protocol"]),
];
/// Counts, kept as the whole numbers their author gave; robot episode counts
/// overlap (an intervened episode may also be completed).
const COUNTS: &[&str] = &["machines", "builds", "processes", "iterations", "seeds",
    "planned", "executed", "completed", "intervened", "stopped", "excluded"];
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

const NOTE: &str = "A research record is its author's statement, fixed when it was written; a claim's status is the author's judgement, not a verdict, independent verification or acceptance. Each source shows the identity recorded with it and, separately, its state now. A Job source was a recorded match of this task's exact Job attempt when written; its state now compares retained Job records only: no file is read, so whether the file can still be read is unknown, and nothing here keeps it. A file deleted or replaced at the same path never changes the recorded identity. A task source keeps its original producer and is not this task's artifact. An external source is as its author stated it and is never checked.";

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
    // Built apart: one json! for the whole schema runs past the macro's recursion limit.
    let entry = json!({"type":"object","additionalProperties":false,
        "properties":{"id":{"type":"string","pattern":"^[a-z0-9][a-z0-9-]{0,63}$"},"label":text(300),
            "status":{"type":"string","enum":ENTRY_STATES},"reason":text(600),"source":source.clone(),
            "method":{"type":"object","additionalProperties":false,"properties":{"activitySeq":seq.clone()},"required":["activitySeq"]},
            "definition":text(300),"unit":text(40),"level":text(60),"n":{"type":"integer","minimum":0},
            "value":{"type":"object","additionalProperties":false,"properties":{"value":{"type":"number"},"low":{"type":"number"},"high":{"type":"number"}},"required":["value"]}},
        "required":["id","label","status"]});
    let next = json!({"type":"object","additionalProperties":false,
        "description":"Not for methods: what this record proposes next, a check that could tell the explanations apart or a stop and why. A proposal only: nothing runs, retries or stops because of it, and a hardware run stays the user's or the lab's decision.",
        "properties":{"action":{"type":"string","enum":NEXT},"text":text(2000)},"required":["action","text"]});
    let count = json!({"type":"integer","minimum":0});
    let details = json!({"type":"object","additionalProperties":false,
        "description":"Optional, by research.field, never required: theory {result: proof|counterexample|conjecture|partial, checked: by_hand|formal|enumeration|none, bound (required for an enumeration: a finite enumeration is no general proof), obligations}; systems {machines, builds, processes, iterations, warmup}: iterations in one process are not independent runs; ml {baseline, selection, budget, seeds, split}; robotics {planned, executed, completed, intervened, stopped, excluded, protocol}: counts overlap and the denominator is the protocol's. Counts are whole numbers as given.",
        "properties":{"result":{"type":"string","enum":["proof","counterexample","conjecture","partial"]},
            "checked":{"type":"string","enum":["by_hand","formal","enumeration","none"]},"bound":text(200),"obligations":notes.clone(),
            "machines":count.clone(),"builds":count.clone(),"processes":count.clone(),"iterations":count.clone(),"warmup":text(300),
            "baseline":text(300),"selection":text(600),"budget":text(300),"seeds":count.clone(),"split":text(300),
            "planned":count.clone(),"executed":count.clone(),"completed":count.clone(),"intervened":count.clone(),
            "stopped":count.clone(),"excluded":count,"protocol":text(300)}});
    let revises = json!({"type":"object","additionalProperties":false,
        "properties":{"activitySeq":seq.clone(),"reason":text(2000),
            "scope":{"type":"string","enum":SCOPES,"description":"Claims only: what this version does to the earlier one's scope. narrows or withdraws it, with the reason; unchecked: the data, device or definition changed and whether the earlier scope still holds is not checked yet. Without it, the earlier scope stands as written."}},
        "required":["activitySeq","reason"]});
    let entries = json!({"type":"array","maxItems":MAX_ENTRIES,"items":entry,
        "description":"Comparisons only: what is compared. Every entry is included, excluded, missing or not_done; all but included need a reason, and missing or not_done carry no value. Values are as their author states them."});
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
            "next":next,
            "method":{"type":"object","additionalProperties":false,"properties":{"activitySeq":seq.clone()},"required":["activitySeq"]},
            "sources":{"type":"array","maxItems":MAX_SOURCES,"items":source.clone()},
            "revises":revises,
            "details":details,
            "entries":entries},
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
        &["type", "id", "title", "text", "field", "status", "conditions", "limits", "method", "sources", "revises", "entries", "next", "details"],
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
    if let Some(details) = input.get("details").filter(|v| !v.is_null()) {
        out["details"] = fix_details(out["field"].as_str(), details)?;
    }
    if let Some(next) = input.get("next").filter(|v| !v.is_null()) {
        ensure!(kind != "method", "invalid_input: research.next is for claims, observations and comparisons; a method is revised instead");
        ensure!(next.is_object(), "invalid_input: research.next is an object");
        allowed(next, &["action", "text"])?;
        let action = choice(next, "action", NEXT)?.context("invalid_input: research.next.action is check or stop")?;
        out["next"] = json!({"action":action,"text":required_text(next, "text", 2000)?});
    }
    if let Some(method) = input.get("method").filter(|v| !v.is_null()) {
        ensure!(kind != "method", "invalid_input: a method does not cite a method; revise it instead");
        ensure!(kind != "comparison", "invalid_input: a comparison names each entry's method");
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
            allowed(revises, &["activitySeq", "reason", "scope"])?;
            let seq = positive(revises, "activitySeq")?;
            let reason = required_text(revises, "reason", 2000)?;
            let scope = choice(revises, "scope", SCOPES)?;
            ensure!(scope.is_none() || kind == "claim", "invalid_input: research.revises.scope is for claims");
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
            if let Some(scope) = scope {
                out["revises"]["scope"] = json!(scope);
            }
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
    match (kind.as_str(), input.get("entries").filter(|v| !v.is_null())) {
        ("comparison", Some(entries)) => {
            let entries = entries.as_array().context("invalid_input: research.entries must be an array")?;
            ensure!(
                !entries.is_empty() && entries.len() <= MAX_ENTRIES,
                "invalid_input: a comparison has 1 to {MAX_ENTRIES} research.entries"
            );
            let mut ids = std::collections::BTreeSet::new();
            let fixed = entries
                .iter()
                .enumerate()
                .map(|(n, entry)| {
                    fix_entry(db, task, entry, &mut ids).map_err(|error| anyhow!("{error} (research.entries[{n}])"))
                })
                .collect::<Result<Vec<_>>>()?;
            // Entries are fixed, so what they share is too: kept with them.
            out["comparability"] = comparability(&fixed);
            out["entries"] = json!(fixed);
        }
        ("comparison", None) => bail!("invalid_input: a comparison needs research.entries"),
        (_, Some(_)) => bail!("invalid_input: research.entries is for comparisons only"),
        (_, None) => {}
    }
    Ok(Some(out))
}

/// What a record's kind of study keeps apart, checked against its field:
/// only that field's keys, counts as whole numbers kept as given, and an
/// enumeration with its bound. Nothing here is required or judged.
fn fix_details(field: Option<&str>, details: &Value) -> Result<Value> {
    ensure!(details.is_object(), "invalid_input: research.details is an object");
    let field = field.context("invalid_input: research.details needs research.field")?;
    let keys = DETAILS
        .iter()
        .find(|(name, _)| *name == field)
        .map(|(_, keys)| *keys)
        .with_context(|| format!("invalid_input: research.details is for theory, systems, ml or robotics, not {field}"))?;
    allowed(details, keys)?;
    let mut out = json!({});
    for (key, value) in details.as_object().into_iter().flatten().filter(|(_, value)| !value.is_null()) {
        out[key] = match key.as_str() {
            count if COUNTS.contains(&count) => {
                ensure!(value.as_u64().is_some(), "invalid_input: research.details.{count} is a whole number");
                value.clone()
            }
            "result" => json!(choice(details, "result", &["proof", "counterexample", "conjecture", "partial"])?),
            "checked" => json!(choice(details, "checked", &["by_hand", "formal", "enumeration", "none"])?),
            "obligations" => notes(details, "obligations")?.unwrap_or_else(|| json!([])),
            text => json!(required_text(details, text, match text { "selection" => 600, "bound" => 200, _ => 300 })?),
        };
    }
    ensure!(out.as_object().is_some_and(|kept| !kept.is_empty()), "invalid_input: research.details is empty");
    ensure!(
        out["checked"] != "enumeration" || out["bound"].is_string(),
        "invalid_input: research.details: an enumeration says how far it went (bound); a finite enumeration is no general proof"
    );
    Ok(out)
}

/// One entry of a comparison, checked and with its source's identity fixed.
fn fix_entry(db: &Connection, task: &SharedTask, entry: &Value, ids: &mut std::collections::BTreeSet<String>) -> Result<Value> {
    ensure!(entry.is_object(), "invalid_input: a comparison entry is an object");
    allowed(entry, &["id", "label", "status", "reason", "source", "method", "definition", "unit", "level", "n", "value"])?;
    let id = required_text(entry, "id", 64)?;
    ensure!(valid_id(&id), "invalid_input: an entry id is 1 to 64 lowercase letters, digits and hyphens");
    ensure!(ids.insert(id.clone()), "invalid_input: entry id {id} is used twice in this comparison");
    let state = match entry.get("status") {
        Some(Value::String(state)) if ENTRY_STATES.contains(&state.as_str()) => state.clone(),
        _ => bail!("invalid_input: an entry's status is one of {}", ENTRY_STATES.join(", ")),
    };
    let mut out = json!({"id":id,"label":required_text(entry, "label", 300)?,"status":state});
    match optional_text(entry, "reason", 600)?.filter(|reason| !reason.trim().is_empty()) {
        Some(reason) => out["reason"] = json!(reason),
        // What was left out says why: the reader sees it beside what was kept.
        None => ensure!(state == "included", "invalid_input: a {state} entry needs a reason"),
    }
    if let Some(value) = entry.get("value").filter(|v| !v.is_null()) {
        ensure!(
            !matches!(state.as_str(), "missing" | "not_done"),
            "invalid_input: a {state} entry has no value"
        );
        allowed(value, &["value", "low", "high"])?;
        let mut kept = json!({});
        for field in ["value", "low", "high"] {
            match value.get(field) {
                None | Some(Value::Null) => ensure!(field != "value", "invalid_input: an entry's value needs value"),
                // Kept as written: checked to be a finite number, never
                // converted, so an integer past 2^53 stays exact (#479 R1).
                Some(number @ Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => {
                    kept[field] = number.clone();
                }
                Some(_) => bail!("invalid_input: an entry's {field} is a finite number"),
            }
        }
        out["value"] = kept;
    }
    if let Some(source) = entry.get("source").filter(|v| !v.is_null()) {
        out["source"] = fix_source(db, task, source)?;
    }
    if let Some(method) = entry.get("method").filter(|v| !v.is_null()) {
        allowed(method, &["activitySeq"])?;
        let seq = positive(method, "activitySeq")?;
        let cited = record_in(db, &task.id, seq)?
            .filter(|row| row["research"]["type"] == "method")
            .with_context(|| format!("invalid_input: an entry's method: activity {seq} is not a method record of this task"))?;
        out["method"] = json!({"activitySeq":seq,"id":cited["research"]["id"],"title":cited["research"]["title"]});
    }
    for (field, max) in [("definition", 300), ("unit", 40), ("level", 60)] {
        if let Some(text) = optional_text(entry, field, max)?.filter(|text| !text.trim().is_empty()) {
            out[field] = json!(text);
        }
    }
    if let Some(n) = entry.get("n").filter(|v| !v.is_null()) {
        out["n"] = json!(n.as_u64().context("invalid_input: an entry's n is a whole number")?);
    }
    Ok(out)
}

/// Which of unit, definition, level and method the included entries share,
/// differ in, or leave unknown (missing on some). A field can both differ
/// among the entries that give it and be missing on others: each is said,
/// and a field missing anywhere is never shared. Nothing is computed from
/// their values.
fn comparability(entries: &[Value]) -> Value {
    let included: Vec<&Value> = entries.iter().filter(|entry| entry["status"] == "included").collect();
    let (mut shared, mut differs, mut unknown) = (Map::new(), vec![], vec![]);
    for field in ALIGNED {
        let known: Vec<&Value> = included
            .iter()
            .map(|entry| if *field == "method" { &entry["method"]["activitySeq"] } else { &entry[*field] })
            .filter(|value| !value.is_null())
            .collect();
        let missing = known.len() < included.len();
        if missing {
            unknown.push(*field);
        }
        if known.windows(2).any(|pair| pair[0] != pair[1]) {
            differs.push(*field);
        } else if let Some(value) = known.first().filter(|_| !missing) {
            shared.insert((*field).to_owned(), (*value).clone());
        }
    }
    let count = |state: &str| entries.iter().filter(|entry| entry["status"] == state).count();
    json!({"aligned": included.len() > 1 && differs.is_empty() && unknown.is_empty(),
        "shared":shared,"differs":differs,"unknown":unknown,
        "counts":{"included":count("included"),"excluded":count("excluded"),"missing":count("missing"),"not_done":count("not_done")}})
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
        if let Some(entries) = research.get("entries").and_then(Value::as_array) {
            record["counts"] = comparability(entries)["counts"].clone();
        }
        return Some(record);
    }
    (row["kind"] == "result").then(|| {
        let summary: String = row["result"]["summary"].as_str().unwrap_or_default().chars().take(300).collect();
        json!({"kind":"result","resultId":row["result"]["id"],"summary":summary})
    })
}

/// A record's sources, its entries' sources included; never adds a field
/// to anything else.
fn sources_mut(value: &mut Value) -> Vec<&mut Value> {
    let Some(research) = value.get_mut("research").and_then(Value::as_object_mut) else { return vec![] };
    let mut found = vec![];
    for (key, field) in research.iter_mut() {
        match (key.as_str(), field) {
            ("sources", Value::Array(sources)) => found.extend(sources.iter_mut()),
            ("entries", Value::Array(entries)) => {
                found.extend(entries.iter_mut().filter_map(|entry| entry.get_mut("source")).filter(|source| source.is_object()));
            }
            _ => {}
        }
    }
    found
}

/// Stored task references are UUIDs; answers name tasks as T-n.
pub(super) fn project(db: &Connection, activity: &mut Value) -> Result<()> {
    {
        for source in sources_mut(activity) {
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
    {
        for source in sources_mut(input) {
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
            // Only the Job's record is read: the file's availability is unknown.
            json!({"state":binding["state"],"jobStatus":binding["jobStatus"],"file":"not_read",
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
    if let Some(sources) = research.get_mut("sources").and_then(Value::as_array_mut) {
        for source in sources {
            source["now"] = now(db, &task.id, source)?;
        }
    }
    if let Some(entries) = research.get_mut("entries").and_then(Value::as_array_mut) {
        for entry in entries.iter_mut() {
            if let Some(source) = entry.get_mut("source").filter(|source| source.is_object()) {
                source["now"] = now(db, &task.id, source)?;
            }
        }
    }
    let (revised_by, latest) = newer(db, &task.id, seq)?;
    let mut out = json!({"taskId":task.id,"activitySeq":seq,"actor":row["actor"],"at":row["at"],
        "source":row["source"],"body":row["body"],"research":research,
        "version":version_of(db, &task.id, &row)?,"revisedBy":revised_by,"latestActivitySeq":latest});
    // How the next version revised this one: its reason, and for a claim what
    // it did to this scope, if it said. Unsaid, this scope stands as written.
    if let Some(next) = revised_by {
        if let Some(row) = record_in(db, &task.id, next)? {
            out["revision"] = json!({"activitySeq":next,"scope":row["research"]["revises"]["scope"],
                "reason":row["research"]["revises"]["reason"]});
        }
    }
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

/// A result criterion's research record (T-17): one of this task's own
/// records by its activity, as a citation summary fixed when the result is
/// submitted: its type, id, title, status or counts, version, author and
/// time. Its text, method and sources are not copied. A later version never
/// changes which version a result cites.
pub(super) fn criterion_record(db: &Connection, task: &SharedTask, reference: &Value) -> Result<Value> {
    ensure!(reference.is_object(), "invalid_input: a criterion's research record is an object");
    allowed(reference, &["activitySeq"])?;
    let seq = positive(reference, "activitySeq")?;
    let row = record_in(db, &task.id, seq)?.with_context(|| {
        format!("invalid_input: activity {seq} is not a research record of {}", task_number(task.seq))
    })?;
    let record = cited_record(&row).context("invalid_input: not a research record")?;
    Ok(json!({"activitySeq":seq,"record":record,"version":version_of(db, &task.id, &row)?,
        "producer":row["actor"],"at":row["at"]}))
}

/// The method record a run follows (T-17 slice 4): one of the run's task's
/// own method records, fixed by its activity. A later method version leaves
/// the run as it was; only a changed command or input needs a new run.
pub(crate) fn run_method(db: &Connection, task: &str, seq: i64) -> Result<Value> {
    let number = task_seq(db, task)?;
    let row = record_in(db, task, seq)?
        .filter(|row| row["research"]["type"] == "method")
        .with_context(|| format!("invalid_input: method: activity {seq} is not a method record of {}", task_number(number)))?;
    Ok(json!({"activitySeq":seq,"id":row["research"]["id"],"title":row["research"]["title"],
        "version":version_of(db, task, &row)?}))
}

/// The research record an analysis decision cites (T-17 slice 4): any record
/// of the run's task, fixed as it reads when the decision is made.
pub(crate) fn decision_record(db: &Connection, task: &str, seq: i64) -> Result<Value> {
    let number = task_seq(db, task)?;
    let row = record_in(db, task, seq)?
        .with_context(|| format!("invalid_input: record: activity {seq} is not a research record of {}", task_number(number)))?;
    let mut out = json!({"activitySeq":seq,"record":cited_record(&row),"version":version_of(db, task, &row)?,
        "producer":row["actor"],"at":row["at"]});
    if let Some(next) = row["research"].get("next") {
        out["next"] = next.clone();
    }
    Ok(out)
}

/// Where a record's line stands now, for a run or a decision that cites it.
pub(crate) fn line_now(db: &Connection, task: &str, seq: i64) -> Result<Value> {
    if record_in(db, task, seq)?.is_none() {
        return Ok(json!({"state":"missing"}));
    }
    let (next, latest) = newer(db, task, seq)?;
    Ok(json!({"state":"readable","revisedBy":next,"latestActivitySeq":latest}))
}

fn task_seq(db: &Connection, task: &str) -> Result<i64> {
    Ok(db.query_row("SELECT seq FROM collaboration_tasks WHERE id=?1", params![task], |r| r.get(0))?)
}

/// Where a criterion's research record stands now: whether it can be read,
/// and the newest version of its line, beside the version the result cites.
pub(super) fn criterion_record_now(db: &Connection, task: &str, criterion: &str, seq: i64) -> Result<Value> {
    if record_in(db, task, seq)?.is_none() {
        return Ok(json!({"criterionId":criterion,"activitySeq":seq,"state":"missing"}));
    }
    let (next, latest) = newer(db, task, seq)?;
    Ok(json!({"criterionId":criterion,"activitySeq":seq,"state":"readable",
        "revisedBy":next,"latestActivitySeq":latest}))
}

#[cfg(test)]
#[path = "research_tests.rs"]
mod tests;
