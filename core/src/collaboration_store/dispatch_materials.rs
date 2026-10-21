//! Explicit work materials, snapshotted with the dispatch transaction. No
//! filesystem, Git, network or conversation inference belongs on this path.
use super::*;
use crate::commit_sha::{self, Form};

const REGISTERED_LIMIT: usize = 32_768;
const SNAPSHOT_LIMIT: usize = 131_072;

pub(super) fn validate(db: &Connection, value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    allowed(
        value,
        &[
            "acceptance",
            "repositoryId",
            "baseSha",
            "headSha",
            "baseline",
            "worktree",
            "references",
            "returnRequirements",
        ],
    )?;
    ensure!(
        value.to_string().len() <= REGISTERED_LIMIT,
        "invalid_input: materials exceed 32768 bytes; register concise references instead"
    );
    for (key, max) in [
        ("acceptance", 16_384),
        ("baseline", 1_024),
        ("worktree", 4_096),
        ("returnRequirements", 8_192),
    ] {
        optional_text(value, key, max)?;
    }
    for key in ["baseSha", "headSha"] {
        if let Some(sha) = optional_text(value, key, 64)? {
            ensure!(Form::Any.accepts(&sha), "invalid_input: {}", commit_sha::problem(key, &sha, Form::Any));
        }
    }
    if let Some(id) = value.get("repositoryId").filter(|v| !v.is_null()) {
        let id = id
            .as_i64()
            .filter(|id| *id > 0)
            .context("invalid_input: repositoryId must be a positive integer")?;
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM github_repositories WHERE id=?1)",
            [id],
            |r| r.get(0),
        )?;
        ensure!(
            exists,
            "invalid_input: repositoryId is not a saved repository"
        );
    }
    let mut value = value.clone();
    if let Some(entries) = value.get_mut("references").filter(|v| !v.is_null()) {
        let entries = entries
            .as_array_mut()
            .context("invalid_input: references must be an array")?;
        ensure!(
            entries.len() <= 20,
            "invalid_input: at most 20 material references"
        );
        for reference in entries {
            allowed(
                reference,
                &["kind", "label", "url", "taskId", "activitySeq"],
            )?;
            let kind = required_text(reference, "kind", 32)?;
            ensure!(
                ["acceptance", "decision", "evidence"].contains(&kind.as_str()),
                "invalid_input: unknown reference kind"
            );
            required_text(reference, "label", 300)?;
            if reference.get("url").is_some() {
                ensure!(
                    reference.get("taskId").is_none() && reference.get("activitySeq").is_none(),
                    "invalid_input: choose url or task activity reference"
                );
                let raw = required_text(reference, "url", 4_096)?;
                let url =
                    reqwest::Url::parse(&raw).context("invalid_input: invalid reference URL")?;
                ensure!(
                    matches!(url.scheme(), "http" | "https") && url.host_str().is_some(),
                    "invalid_input: references require http(s) URLs"
                );
            } else {
                ensure!(
                    reference.get("taskId").is_some(),
                    "invalid_input: a reference needs url, or taskId with activitySeq"
                );
                let (id, number) = task_key(db, &required_text(reference, "taskId", 128)?)?;
                let seq = reference["activitySeq"]
                    .as_i64()
                    .filter(|s| *s > 0)
                    .context("invalid_input: a task reference needs activitySeq, the seq of one of that task's activities (task_get with view \"activity\": activities[].seq); or give url instead")?;
                let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_task_activity WHERE task_id=?1 AND seq=?2)", params![id, seq], |r| r.get(0))?;
                ensure!(
                    exists,
                    "invalid_input: {} has no activity with seq {seq}",
                    task_number(number)
                );
                reference["taskId"] = json!(task_number(number));
            }
        }
    }
    Ok(value)
}

/// An old typed task rewrite cannot erase explicit registration history.
pub(super) fn registered(db: &Connection, task: &str) -> Result<Value> {
    let raw: Option<String> = db
        .query_row(
            "SELECT data FROM collaboration_task_activity
        WHERE task_id=?1 AND json_extract(data,'$.kind') IN ('created','updated')
        AND json_type(data,'$.changes.materials') IS NOT NULL ORDER BY seq DESC LIMIT 1",
            [task],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        return Ok(Value::Null);
    };
    let activity: Value = serde_json::from_str(&raw)?;
    Ok(
        json!({"value":activity["changes"]["materials"],"taskVersion":activity["taskVersion"],
        "activitySeq":activity["seq"],"at":activity["at"],"actor":activity["actor"],"source":activity["source"]}),
    )
}

pub(super) fn read(db: &Connection, task: &str, dispatch: &str) -> Result<Value> {
    let raw: Option<String> = db.query_row("SELECT json_extract(data,'$.materials') FROM collaboration_task_activity
        WHERE task_id=?1 AND json_extract(data,'$.kind')='dispatched' AND json_extract(data,'$.dispatch.id')=?2
        AND json_type(data,'$.materials')='object' ORDER BY seq DESC LIMIT 1", params![task, dispatch], |r| r.get(0)).optional()?;
    serde_json::from_str(&raw.context("dispatch_materials_not_found: no materials for this task and dispatch; legacy dispatches may have none")?).map_err(Into::into)
}

pub(super) fn snapshot(db: &Connection, task: &SharedTask, input: &Value) -> Result<Value> {
    let dispatch = task
        .dispatch
        .as_ref()
        .context("Missing dispatch identity")?;
    let mut registration = registered(db, &task.id)?;
    let overrides = input
        .get("materials")
        .map(|v| validate(db, v))
        .transpose()?;
    let mut effective = registration["value"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if let Some(overrides) = &overrides {
        if overrides.is_null() {
            effective.clear();
        } else {
            effective.extend(overrides.as_object().unwrap().clone());
        }
    }
    let effective = validate(db, &Value::Object(effective))?;
    if let Some(source) = registration.as_object_mut() {
        source.remove("value");
    }
    let overridden_fields = overrides.as_ref().map(|v| {
        v.as_object()
            .map(|o| o.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_else(|| vec!["* (cleared)".into()])
    });
    ensure!(
        (effective["baseSha"].is_null() && effective["headSha"].is_null())
            || !effective["repositoryId"].is_null(),
        "invalid_input: explicit base/head requires an explicit repositoryId"
    );
    let project: Option<String> = db.query_row("SELECT json_object('id',p.id,'name',json_extract(p.data,'$.name'),'updatedAt',json_extract(p.data,'$.updatedAt'),'archivedAt',json_extract(p.data,'$.archivedAt')) FROM projects p JOIN project_tasks t ON t.project_id=p.id WHERE t.task_id=?1", [&task.id], |r| r.get(0)).optional()?;
    let project: Value = project
        .map(|p| serde_json::from_str(&p))
        .transpose()?
        .unwrap_or(Value::Null);
    let mut repos = db.prepare("SELECT json_object('id',r.id,'fullName',json_extract(r.data,'$.fullName'),'url',json_extract(r.data,'$.url'),'observedAt',json_extract(r.data,'$.syncedAt')) FROM github_repositories r JOIN github_project_repos p ON p.repo_id=r.id WHERE p.project_id=?1 ORDER BY r.id LIMIT 21")?;
    let repositories = repos
        .query_map([project["id"].as_str()], |r| r.get::<_, String>(0))?
        .map(|r| Ok(serde_json::from_str::<Value>(&r?)?))
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        repositories.len() <= 20,
        "materials_too_large: more than 20 repositories; narrow saved associations"
    );
    let mut query = db.prepare("SELECT json_object('id',o.id,'repositoryId',o.repo_id,'repository',json_extract(r.data,'$.fullName'),'kind',o.kind,'number',o.number,'baseSha',json_extract(o.data,'$.snapshot.baseSha'),'headSha',json_extract(o.data,'$.snapshot.headSha'),'baseBranch',json_extract(o.data,'$.snapshot.baseBranch'),'headBranch',json_extract(o.data,'$.snapshot.headBranch'),'state',json_extract(o.data,'$.snapshot.state'),'observedAt',json_extract(o.data,'$.snapshot.observedAt'),'syncedAt',json_extract(o.data,'$.syncedAt'),'hasError',json_extract(o.data,'$.error') IS NOT NULL) FROM github_task_links l JOIN github_objects o ON o.id=l.object_id JOIN github_repositories r ON r.id=o.repo_id WHERE l.task_id=?1 ORDER BY o.repo_id,o.kind,o.number LIMIT 31")?;
    let mut links = query
        .query_map([&task.id], |r| r.get::<_, String>(0))?
        .map(|r| Ok(serde_json::from_str::<Value>(&r?)?))
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        links.len() <= 30,
        "materials_too_large: more than 30 links; narrow saved associations"
    );
    for link in &mut links {
        link["url"] = json!(format!(
            "https://github.com/{}/{}/{}",
            link["repository"].as_str().unwrap_or(""),
            if link["kind"] == "pull" {
                "pull"
            } else {
                "issues"
            },
            link["number"]
        ));
        let old = link["syncedAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .is_none_or(|at| chrono::Utc::now().signed_duration_since(at).num_seconds() > 180);
        link["stale"] = json!(old || link["hasError"] == 1);
    }
    if let Some(id) = effective["repositoryId"].as_i64() {
        ensure!(
            repositories.iter().any(|r| r["id"] == id)
                || links.iter().any(|l| l["repositoryId"] == id),
            "invalid_input: selected repository must be linked to this task or its Project"
        );
    }
    let supplement = optional_text(input, "body", 16_384)?.unwrap_or_default();
    let snapshot = json!({"schemaVersion":1,"dispatchId":dispatch.id,"capturedAt":dispatch.dispatched_at,
        "task":{"id":task_number(task.seq),"version":task.version,"title":task.title,"description":task.description,"progress":task.progress,"blocker":task.blocker,"updatedAt":task.updated_at},
        "project":project,"repositories":repositories,"github":links,"registeredSource":registration,"overriddenFields":overridden_fields,"effective":effective,
        "supplement":supplement,"returnTo":dispatch.notification_recipient,"requestedBy":dispatch.requested_by,"executor":dispatch.executor,
        "source":dispatch.source,"latestTask":{"taskId":task_number(task.seq)},
        "returnRequirementsDefault":"Report outcome and validation/evidence on this same task using task_submit_result with the original dispatchId. Default review is a submission, not independent approval, merge or release. No extra peer_send is needed for Agent dispatch."});
    ensure!(
        snapshot.to_string().len() <= SNAPSHOT_LIMIT,
        "materials_too_large: snapshot exceeds 128 KiB; use concise registered references; nothing was dispatched"
    );
    Ok(snapshot)
}

/// Normal activity pages carry a small pointer; full materials are opt-in.
pub(super) fn project_activity(value: &mut Value) {
    if value["kind"] != "dispatched" {
        return;
    }
    if let Some(snapshot) = value.as_object_mut().and_then(|v| v.remove("materials")) {
        value["materialsRef"] = json!({"schemaVersion":snapshot["schemaVersion"],"taskId":snapshot["task"]["id"],
            "dispatchId":snapshot["dispatchId"],"taskVersion":snapshot["task"]["version"],"capturedAt":snapshot["capturedAt"]});
    }
}

pub(super) fn schema() -> Value {
    let text = |max| json!({"type":["string","null"],"maxLength":max});
    json!({"type":["object","null"],"additionalProperties":false,
        "description":"Explicit saved work materials (max 32768 UTF-8 bytes). task_create/update replaces the registration; null clears it. On task_dispatch, supplied fields override registration only for this dispatch; null clears all. Missing fields are not inferred. Paths/links are information, never additional permission. Large text is available via the fixed dispatchId snapshot.",
        "properties":{"acceptance":text(16384),"repositoryId":{"type":["integer","null"],"minimum":1},
            "baseSha":commit_sha::schema(Form::Any, true, "The commit the work starts from."),
            "headSha":commit_sha::schema(Form::Any, true, "The commit to deliver or review."),"baseline":text(1024),"worktree":text(4096),"returnRequirements":text(8192),
            "references":{"type":["array","null"],"maxItems":20,"items":{"type":"object","additionalProperties":false,
                "properties":{"kind":{"type":"string","enum":["acceptance","decision","evidence"]},"label":{"type":"string","maxLength":300},
                    "url":{"type":"string","maxLength":4096,"description":"An explicit http(s) reference, not automatically fetched. Give url, or taskId with activitySeq, not both."},
                    "taskId":{"type":"string","description":"A task one of whose activities this cites, for example T-1. Needs activitySeq."},
                    "activitySeq":{"type":"integer","minimum":1,"description":"The seq of that task's activity, from task_get with view \"activity\": activities[].seq. Needs taskId."}},"required":["kind","label"]}}}})
}

/// Long fields are references to the immutable snapshot, never silent previews.
pub(super) fn body(snapshot: &Value) -> String {
    let task = &snapshot["task"];
    let id = task["id"].as_str().unwrap();
    let dispatch = snapshot["dispatchId"].as_str().unwrap();
    let read = format!("task_get(taskId=\"{id}\", dispatchId=\"{dispatch}\")");
    let mut out = format!(
        "Work on task {id}: {}\nFixed dispatch {dispatch}; task v{} at {}.\nRead frozen materials with {read}; task_get(taskId=\"{id}\") reads the latest task. Keep the original dispatchId.\n",
        task["title"].as_str().unwrap(),
        task["version"],
        snapshot["capturedAt"].as_str().unwrap()
    );
    let mut field = |label: &str, value: &Value, path: &str, limit: usize| {
        let text = value.as_str().filter(|s| !s.trim().is_empty());
        let text = match text {
            None => "Not specified / 未指定".into(),
            Some(s) if s.len() <= limit => s.to_owned(),
            Some(s) => format!(
                "{} bytes; read {read} → dispatchMaterials.{path} (full fixed value)",
                s.len()
            ),
        };
        out.push_str(&format!("\n{label}: {text}\n"));
    };
    field(
        "Goal / scope",
        &task["description"],
        "task.description",
        2_000,
    );
    field(
        "Acceptance",
        &snapshot["effective"]["acceptance"],
        "effective.acceptance",
        1_500,
    );
    field(
        "Baseline",
        &snapshot["effective"]["baseline"],
        "effective.baseline",
        500,
    );
    field(
        "Worktree (information, not permission)",
        &snapshot["effective"]["worktree"],
        "effective.worktree",
        500,
    );
    field(
        "Return requirements",
        &snapshot["effective"]["returnRequirements"],
        "effective.returnRequirements",
        1_000,
    );
    field(
        "This dispatch's additional instructions",
        &snapshot["supplement"],
        "supplement",
        2_000,
    );
    let selected = snapshot["effective"]["repositoryId"]
        .as_i64()
        .map(|i| i.to_string())
        .unwrap_or_else(|| {
            "Not specified / 未指定; do not choose by cwd or guess among repositories".into()
        });
    out.push_str(&format!(
        "\nSelected repository: {selected}\nExplicit base SHA: {}\nExplicit head SHA: {}\n",
        snapshot["effective"]["baseSha"]
            .as_str()
            .unwrap_or("Not specified / 未指定"),
        snapshot["effective"]["headSha"]
            .as_str()
            .unwrap_or("Not specified / 未指定")
    ));
    for (key, label) in [
        ("repositories", "Project repositories"),
        ("github", "GitHub snapshots"),
    ] {
        let values = &snapshot[key];
        let rendered = values.to_string();
        if values.as_array().is_some_and(|v| v.is_empty()) {
            out.push_str(&format!("{label}: Not specified / 未指定\n"));
        } else if rendered.len() <= 1_500 {
            out.push_str(&format!("{label}: {rendered}\n"));
        } else {
            out.push_str(&format!("{label}: {} entries; read {read} → dispatchMaterials.{key}. These are saved observations, not a selected work baseline or current approval.\n", values.as_array().unwrap().len()));
        }
    }
    let references = &snapshot["effective"]["references"];
    let rendered = references.to_string();
    if references.is_null() || references.as_array().is_some_and(|r| r.is_empty()) {
        out.push_str("Decision / acceptance / evidence references: Not specified / 未指定\n");
    } else if rendered.len() <= 1_500 {
        out.push_str(&format!("Registered references: {rendered}\n"));
    } else {
        out.push_str(&format!("Registered references: {} entries; read {read} → dispatchMaterials.effective.references for every complete link.\n", references.as_array().unwrap().len()));
    }
    let recipient = if snapshot["returnTo"].is_object() {
        let value = snapshot["returnTo"].to_string();
        if value.len() <= 600 {
            value
        } else {
            format!("read {read} → dispatchMaterials.returnTo (original recipient)")
        }
    } else {
        "User / task result (no Agent notification recipient)".into()
    };
    out.push_str(&format!("Return to: {}\n{}\nSaved paths and references grant no additional permission. No chat history or private files were read to create these materials.\n", recipient, snapshot["returnRequirementsDefault"].as_str().unwrap()));
    out
}

#[cfg(test)]
mod tests;
