//! A decision about a successful stage belongs to this run, not to its Job.
//! The Job stays finished and holds no reservation while the Agent is away.
use super::*;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Choice {
    Continue,
    Cancel,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Decision {
    pub request_id: String,
    pub run_id: String,
    pub stage: String,
    pub gate_id: String,
    pub attempt_id: String,
    pub decision: Choice,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Decision {
    pub fn continues(&self) -> bool {
        self.decision == Choice::Continue
    }
}

pub(super) fn waiting(stage: &Value) -> bool {
    stage["analysis"]["state"] == "waiting"
}

pub(super) fn pending(stage: &Value) -> bool {
    stage["waitForAnalysis"] == true && stage["analysis"]["state"] != "continued"
}

/// Called in the same transaction as an outcome or submission (including
/// reuse). Saving the gate and its mail together makes restart/lost replies
/// safe. Reuse creates a new gate; it never copies an earlier decision.
pub(super) fn open(
    db: &Connection,
    run: &mut Value,
    latest: &HashMap<String, Value>,
) -> Result<bool> {
    let mut changed = false;
    let stages = run["stages"].as_array().cloned().unwrap_or_default();
    for (index, stage) in stages.iter().enumerate() {
        if stage["waitForAnalysis"] != true || stage["analysis"].is_object() {
            continue;
        }
        let key = stage["key"].as_str().context("Missing stage key")?;
        let reused = stage["reusedFrom"].is_object();
        let job = if reused {
            get(
                db,
                stage["reusedFrom"]["jobId"]
                    .as_str()
                    .context("Missing reused job")?,
            )?
        } else {
            let Some(job) = latest.get(key) else {
                continue;
            };
            job.clone()
        };
        if job["status"] != "succeeded" || job["reserved"] == true {
            continue;
        }
        let gate_id = uuid::Uuid::new_v4().to_string();
        let artifacts = job["result"]["artifacts"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut gate = json!({"id":gate_id,"state":"waiting","jobId":job["id"],
            "attemptId":job["attempt"],"createdAt":now(),"execution":if reused {"reused"} else {"succeeded"},
            "artifacts":artifacts});
        let id = uuid::Uuid::new_v4().to_string();
        let body = format!(
            "Run {} ({}), stage {key} succeeded{} and is waiting for analysis. Job {} attempt {} is finished and holds no compute reservation. Read job_run_get(runId={}) and job_get/job_logs for the retained output and verified artifacts. Decide with job_run_decide(requestId=NEW_STABLE_ID, runId={}, stage={key}, gateId={gate_id}, attemptId={}, decision=continue or cancel). Nothing that needs this stage starts until it is continued; cancel stops the run. A different command/input requires a new run with explicit reuse. This result grants no additional execution permission.",
            run["name"].as_str().unwrap_or(""), run["id"].as_str().unwrap_or(""),
            if reused {" (reused result; this run needs its own decision)"} else {""},
            job["id"].as_str().unwrap_or(""), job["attempt"].as_str().unwrap_or(""),
            run["id"].as_str().unwrap_or(""), run["id"].as_str().unwrap_or(""), job["attempt"].as_str().unwrap_or(""),
        );
        collaboration::insert_message(
            db,
            json!({"id":id,"seq":0,
            "sender":{"kind":"system","id":"core","name":"Yuzuno Core"},"recipient":run["agent"],
            "body":body,"taskId":run["taskId"],"replyTo":null,"threadId":id,"createdAt":now(),
            "source":{"runId":run["id"],"stage":key,"gateId":gate_id,"jobId":job["id"],"attempt":job["attempt"]},
            "priority":"normal","jobId":job["id"],
            "metadata":{"kind":"job","status":"waiting_analysis","name":format!("{} · {key}",run["name"].as_str().unwrap_or("")),
                "runId":run["id"],"stage":key,"gateId":gate_id,"jobId":job["id"],"attempt":job["attempt"],"artifacts":artifacts}}),
        )?;
        gate["notificationId"] = json!(id);
        run["stages"][index]["analysis"] = gate;
        changed = true;
    }
    if changed {
        save_run(db, run)?;
    }
    Ok(changed)
}

impl Store {
    pub(crate) fn decide_run(&self, actor: Option<&str>, input: &Decision) -> Result<Value> {
        ensure!(
            !input.request_id.trim().is_empty() && input.request_id.len() <= 128,
            "requestId must contain 1–128 bytes"
        );
        ensure!(
            input.reason.as_ref().is_none_or(|r| r.len() <= 4000),
            "reason must be at most 4000 bytes"
        );
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut run = get_run(&tx, &input.run_id)?;
        ensure!(
            actor.is_none_or(|a| run["agentId"] == a),
            "An Agent can decide only its own runs"
        );
        let (author, source) = collaboration::actor_context(self, &tx, actor)?;
        let owner = super::super::store::actor_key(actor);
        let payload = serde_json::to_value(input)?;
        let prior: Option<String> = tx.query_row(
            "SELECT input_json FROM collaboration_requests WHERE actor=?1 AND operation='job_run_decide' AND request_id=?2",
            params![owner,input.request_id], |r| r.get(0)).optional()?;
        if let Some(prior) = prior {
            ensure!(
                serde_json::from_str::<Value>(&prior)? == payload,
                "idempotency_conflict: requestId already names a different analysis decision"
            );
            // Return the current run, including a cancellation that arrived
            // after this decision. A replay never reopens or advances it.
            return run_view(&tx, &input.run_id);
        }
        ensure!(
            run["cancelRequestedAt"].is_null() && run["settledAt"].is_null(),
            "This run has finished or was cancelled; an analysis decision cannot reopen it"
        );
        let index = run["stages"]
            .as_array()
            .context("Missing stages")?
            .iter()
            .position(|s| s["key"] == input.stage)
            .context("Unknown run stage")?;
        let stage = run["stages"][index].clone();
        let gate = &stage["analysis"];
        ensure!(
            gate["id"] == input.gate_id && gate["attemptId"] == input.attempt_id,
            "stale_analysis_gate: read job_run_get and decide the current gate and attempt"
        );
        ensure!(waiting(&stage), "This analysis gate already has a decision");
        let job = get(&tx, gate["jobId"].as_str().context("Missing gate job")?)?;
        ensure!(
            job["attempt"] == input.attempt_id
                && job["status"] == "succeeded"
                && job["reserved"] != true,
            "The gate's successful, released attempt no longer matches"
        );
        if stage["reusedFrom"].is_null() {
            let all = attempts(&tx, &input.run_id)?;
            ensure!(
                all.get(&input.stage)
                    .and_then(|a| a.last())
                    .is_some_and(|j| j["id"] == job["id"]),
                "stale_analysis_gate: a newer stage attempt exists"
            );
        }
        let gate = &mut run["stages"][index]["analysis"];
        gate["state"] = json!(if input.continues() {
            "continued"
        } else {
            "cancelled"
        });
        gate["decidedAt"] = json!(now());
        gate["decidedBy"] = json!(author);
        gate["source"] = source;
        gate["requestId"] = json!(input.request_id);
        gate["reason"] = json!(input.reason);
        if input.continues() {
            run["idleAt"] = Value::Null;
            save_run(&tx, &run)?;
        } else {
            cancel_waiting(&tx, &mut run)?;
        }
        tx.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,'job_run_decide',?2,?3,?4)",
            params![owner,input.request_id,payload.to_string(),json!({"runId":input.run_id,"gateId":input.gate_id}).to_string()])?;
        advance(self, &tx, &input.run_id)?;
        let view = run_view(&tx, &input.run_id)?;
        tx.commit()?;
        Ok(view)
    }
}
