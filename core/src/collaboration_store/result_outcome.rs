//! An author's result and its artifact references stay with that submission.
//! Reads compare retained Job records only: no file, machine or approval is read.
use super::*;
use std::collections::BTreeSet;

const MAX_BYTES: usize = 32_768;
const NOTE: &str = "Criteria, remaining work and the suggested next Agent are the result author's report. Artifact states compare this result's references with retained Job attempt checks only; no file was read again and current availability is unknown. A recorded match checks identity and structure, not criterion satisfaction, independent verification or acceptance. Task status and result acknowledgment do not establish acceptance.";

pub(super) fn schema() -> Value {
    let text = |max| json!({"type":"string","maxLength":max});
    let artifact = json!({"type":"object","additionalProperties":false,
        "properties":{"jobId":text(128),"attempt":{"type":"string","format":"uuid"},
            "path":text(4096),"sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},
        "required":["jobId","attempt","path","sha256"]});
    json!({"type":"object","additionalProperties":false,
        "description":"Optional author report, at most 32768 UTF-8 bytes, 20 criteria and 40 artifact references in total. References must match checked artifacts of this task's exact Job attempt. Reported criterion status is not independent verification or acceptance. nextAgentId is a suggestion, never assignment or mail.",
        "properties":{"criteria":{"type":"array","maxItems":20,"items":{"type":"object","additionalProperties":false,
            "properties":{"id":text(128),"label":text(300),"report":text(4000),
                "reportedStatus":{"type":"string","enum":["met","not_met","unknown"]},
                "artifacts":{"type":"array","maxItems":10,"items":artifact}},
            "required":["id","label","report","reportedStatus","artifacts"]}},
            "remaining":text(8000),"nextAgentId":text(128),"nextStep":text(4000)},
        "required":["criteria"]})
}

fn relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.chars().any(char::is_control)
        && !path.starts_with(['/', '\\', '~'])
        && !path.contains(':')
        && !path.split(['/', '\\']).any(|part| part == "..")
}

pub(super) fn validate(
    store: &Store,
    db: &Connection,
    task: &SharedTask,
    input: Option<&Value>,
) -> Result<Option<Value>> {
    let Some(input) = input else { return Ok(None) };
    allowed(input, &["criteria", "remaining", "nextAgentId", "nextStep"])?;
    ensure!(
        serde_json::to_vec(input)?.len() <= MAX_BYTES,
        "invalid_input: outcome exceeds 32768 bytes"
    );
    let criteria = input["criteria"]
        .as_array()
        .context("invalid_input: outcome.criteria must be an array")?;
    ensure!(criteria.len() <= 20, "invalid_input: at most 20 criteria");
    let mut ids = BTreeSet::new();
    let mut total = 0;
    for criterion in criteria {
        allowed(
            criterion,
            &["id", "label", "report", "reportedStatus", "artifacts"],
        )?;
        let id = required_text(criterion, "id", 128)?;
        ensure!(
            ids.insert(id.clone()),
            "invalid_input: criterion IDs must be unique within the result"
        );
        required_text(criterion, "label", 300)?;
        required_text(criterion, "report", 4000)?;
        let status = required_text(criterion, "reportedStatus", 32)?;
        ensure!(
            matches!(status.as_str(), "met" | "not_met" | "unknown"),
            "invalid_input: reportedStatus is met, not_met or unknown"
        );
        let artifacts = criterion["artifacts"]
            .as_array()
            .context("invalid_input: criterion.artifacts must be an array")?;
        total += artifacts.len();
        ensure!(
            artifacts.len() <= 10 && total <= 40,
            "invalid_input: at most 10 artifacts per criterion and 40 per outcome"
        );
        for artifact in artifacts {
            allowed(artifact, &["jobId", "attempt", "path", "sha256"])?;
            required_text(artifact, "jobId", 128)?;
            let attempt = required_text(artifact, "attempt", 128)?;
            ensure!(
                uuid::Uuid::parse_str(&attempt).is_ok(),
                "invalid_input: artifact attempt must be the Job's UUID, not a stage attempt number"
            );
            ensure!(
                relative(&required_text(artifact, "path", 4096)?),
                "invalid_input: artifact path must be relative without parent traversal"
            );
            let sha = required_text(artifact, "sha256", 64)?;
            ensure!(
                sha.len() == 64
                    && sha
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "invalid_input: artifact sha256 must be 64 lowercase hexadecimal characters"
            );
            let binding = resolve(db, &task.id, &id, artifact)?;
            ensure!(
                binding["state"] == "recorded_match",
                "invalid_input: artifact {} does not match this task's retained checked Job attempt ({})",
                artifact["path"].as_str().unwrap_or_default(),
                binding["state"].as_str().unwrap_or_default()
            );
        }
    }
    for (key, max) in [("remaining", 8000), ("nextStep", 4000)] {
        optional_text(input, key, max)?;
    }
    let mut value = input.clone();
    if input.get("nextAgentId").is_some() {
        let id = required_text(input, "nextAgentId", 128)?;
        value["nextAgent"] = serde_json::to_value(agent_actor(store, db, &id)?)?;
    }
    Ok(Some(value))
}

/// Keep the assignment's frozen acceptance, even if the current registration
/// changed later. Legacy dispatches without materials remain unspecified.
pub(super) fn acceptance_context(
    db: &Connection,
    task: &SharedTask,
    dispatch: Option<&TaskDispatch>,
) -> Result<Value> {
    if let Some(dispatch) = dispatch {
        let raw: Option<String> = db.query_row("SELECT json_extract(data,'$.materials') FROM collaboration_task_activity
            WHERE task_id=?1 AND json_extract(data,'$.kind')='dispatched' AND json_extract(data,'$.dispatch.id')=?2
            AND json_type(data,'$.materials')='object' ORDER BY seq DESC LIMIT 1", params![task.id, dispatch.id], |r| r.get(0)).optional()?;
        let snapshot: Value = raw
            .map(|raw| serde_json::from_str(&raw))
            .transpose()?
            .unwrap_or(Value::Null);
        return Ok(json!({"text":snapshot["effective"]["acceptance"],
            "source":if snapshot.is_null() { "not_recorded" } else { "dispatch" },
            "dispatchId":dispatch.id,"taskVersion":snapshot["task"]["version"],
            "activitySeq":null,"capturedAt":snapshot["capturedAt"]}));
    }
    let registration = dispatch_materials::registered(db, &task.id)?;
    Ok(json!({"text":registration["value"]["acceptance"],
        "source":if registration.is_null() { "not_recorded" } else { "registration" },
        "dispatchId":null,"taskVersion":registration["taskVersion"],
        "activitySeq":registration["activitySeq"],"capturedAt":registration["at"]}))
}

fn resolve(db: &Connection, task: &str, criterion: &str, reference: &Value) -> Result<Value> {
    let mut out = json!({"criterionId":criterion,"jobId":reference["jobId"],"attempt":reference["attempt"],
        "path":reference["path"],"sha256":reference["sha256"],"state":"job_missing",
        "jobStatus":null,"checkedAt":null,"finishedAt":null,"bytes":null,"index":null,
        "downloadable":false,"machineName":null});
    // The relational task key is authoritative; a different task's Job does
    // not resolve here, even if its data happens to claim this task's identity.
    let raw: Option<String> = db
        .query_row(
            "SELECT data FROM local_jobs WHERE id=?1 AND task_id=?2",
            params![reference["jobId"].as_str(), task],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else { return Ok(out) };
    let job: Value = serde_json::from_str(&raw)?;
    out["jobStatus"] = job["status"].clone();
    out["finishedAt"] = job["finishedAt"].clone();
    out["machineName"] = job["executor"]["machineName"]
        .as_str()
        .or(job["machine"]["name"].as_str())
        .map_or(Value::Null, |name| json!(name));
    if job["attempt"] != reference["attempt"] || job["result"]["attempt"] != reference["attempt"] {
        out["state"] = json!("attempt_mismatch");
        return Ok(out);
    }
    let recorded = job["result"]["artifacts"].as_array().and_then(|artifacts| {
        artifacts
            .iter()
            .enumerate()
            .find(|(_, artifact)| artifact["path"] == reference["path"])
    });
    let Some((index, artifact)) = recorded else {
        out["state"] = json!("artifact_missing");
        return Ok(out);
    };
    out["index"] = json!(index);
    out["bytes"] = artifact["bytes"].clone();
    // Helpers retain the check but not its timestamp in the Job's artifact
    // row. Do not present the Job's finish time as a measured check time.
    let matches = artifact["ok"] == true
        && artifact["sha256"].is_string()
        && artifact["sha256"] == reference["sha256"];
    out["state"] = json!(if matches {
        "recorded_match"
    } else {
        "artifact_mismatch"
    });
    out["downloadable"] =
        json!(matches && (job["executor"].is_null() || job["executor"]["kind"] == "local"));
    Ok(out)
}

fn short(value: &Value) -> Value {
    match value.as_str() {
        Some(text) if text.chars().count() > 600 => {
            json!(format!("{}…", text.chars().take(600).collect::<String>()))
        }
        _ => value.clone(),
    }
}

pub(super) fn get(db: &Connection, input: &Value) -> Result<Value> {
    allowed(input, &["taskId", "resultId", "before", "limit"])?;
    let task = load_task(db, &required_text(input, "taskId", 128)?)?;
    let before = match input.get("before") {
        None => i64::MAX,
        Some(value) => value
            .as_i64()
            .filter(|n| *n > 0)
            .context("invalid_input: before must be a positive integer")?,
    };
    let limit = match input.get("limit") {
        None => 10,
        Some(value) => value
            .as_i64()
            .filter(|n| (1..=20).contains(n))
            .context("invalid_input: limit must be 1..20")?,
    };
    let result = if input.get("resultId").is_some() {
        let id = required_text(input, "resultId", 128)?;
        let raw: Option<String> = db.query_row("SELECT json_extract(data,'$.result') FROM collaboration_task_activity
            WHERE task_id=?1 AND json_extract(data,'$.kind')='result' AND json_extract(data,'$.result.id')=?2 ORDER BY seq DESC LIMIT 1",
            params![task.id, id], |r| r.get(0)).optional()?;
        match raw {
            Some(raw) => serde_json::from_str(&raw)?,
            None => task
                .result
                .as_ref()
                .filter(|r| r["id"] == id)
                .cloned()
                .context("result_not_found: this task has no result with that resultId")?,
        }
    } else {
        task.result.clone().unwrap_or(Value::Null)
    };
    let mut query = db.prepare("SELECT seq,json_extract(data,'$.result') FROM collaboration_task_activity
        WHERE task_id=?1 AND seq<?2 AND json_extract(data,'$.kind')='result' ORDER BY seq DESC LIMIT ?3")?;
    let rows = query
        .query_map(params![task.id, before, limit + 1], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = rows.len() > limit as usize;
    let mut history = Vec::new();
    for (seq, raw) in rows.into_iter().take(limit as usize) {
        let r: Value = serde_json::from_str(&raw)?;
        history.push(json!({"resultId":r["id"],"seq":seq,"taskVersion":r["taskVersion"],"summary":short(&r["summary"]),
            "reportedAt":r["reportedAt"],"reportedBy":r["reportedBy"],"status":r["status"]}));
    }
    let mut artifacts = Vec::new();
    for criterion in result["outcome"]["criteria"]
        .as_array()
        .into_iter()
        .flatten()
        .take(20)
    {
        for reference in criterion["artifacts"]
            .as_array()
            .into_iter()
            .flatten()
            .take(10)
        {
            if artifacts.len() == 40 {
                break;
            }
            artifacts.push(resolve(
                db,
                &task.id,
                criterion["id"].as_str().unwrap_or_default(),
                reference,
            )?);
        }
    }
    Ok(
        json!({"taskId":task_number(task.seq),"taskVersion":task.version,
        "currentResultId":task.result.as_ref().map(|r| &r["id"]),"result":result,
        "nextBefore":history.last().map(|r| &r["seq"]),"history":history,"hasMore":has_more,
        "artifacts":artifacts,"note":NOTE}),
    )
}

#[cfg(test)]
#[path = "result_outcome_tests.rs"]
mod tests;
