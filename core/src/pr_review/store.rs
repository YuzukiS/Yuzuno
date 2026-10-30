//! Review runs are independent records, never task transitions or Agent rewrites.
use crate::{model::now, store::Store};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS pr_reviews (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES collaboration_tasks(id),
      link_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, report TEXT);
      CREATE INDEX IF NOT EXISTS pr_reviews_task ON pr_reviews(task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS pr_reviews_active ON pr_reviews(task_id,link_id)
      WHERE status IN ('preparing','running');",
    )?;
    super::evidence::migrate(db)
}

/// Why a new round of this exact base/head can't be complete: the latest
/// completed round of it under this coverage policy recorded a scope (only
/// such records count, never older or unknown ones) whose unsupported,
/// too-large or policy-excluded paths no round of the same candidate can
/// cover. The same base also means the same policy file.
fn known_unreviewable(tx: &Connection, task: &str, link: &str, base: &str, head: &str) -> Result<Option<String>> {
    let mut q = tx.prepare("SELECT data FROM pr_reviews WHERE task_id=?1 AND link_id=?2 AND status='completed' ORDER BY rowid DESC")?;
    let rows = q.query_map(params![task, link], |r| r.get::<_, String>(0))?;
    for row in rows {
        let run: Value = serde_json::from_str(&row?)?;
        if run["baseSha"] != base || run["headSha"] != head {
            continue;
        }
        let scope = &run["scope"];
        if run["coveragePolicyVersion"] != super::source::COVERAGE_VERSION
            || run["actualHarness"].is_null()
            || scope["version"].is_null()
            || scope["baseSha"] != base
            || scope["headSha"] != head
        {
            return Ok(None);
        }
        let gaps = super::source::scope::permanent_gaps(scope);
        if gaps.is_empty() {
            return Ok(None);
        }
        let named: Vec<_> = gaps
            .iter()
            .take(10)
            .map(|g| format!("{} ({}{})", g["path"].as_str().unwrap_or_default(), g["state"].as_str().unwrap_or_default(),
                g["reason"].as_str().map(|r| format!(", {r}")).unwrap_or_default()))
            .collect();
        return Ok(Some(format!(
            "Round {} ({}) of this exact base and head already found {} changed path{} no review of it can cover under the base's scope policy: {}{}. Another round would end incomplete for the same reason, so none was started. Report the gap and any independent evidence to whoever decides, or pass acknowledgeUnreviewable: true to review the other paths anyway. That only acknowledges these paths stay unreviewed: it is not an approval, doesn't lift any round limit and doesn't change how the result is judged.",
            run["round"], run["id"].as_str().unwrap_or_default(), gaps.len(), if gaps.len() == 1 { "" } else { "s" },
            named.join(", "), if gaps.len() > 10 { ", …" } else { "" }
        )));
    }
    Ok(None)
}

/// Started review rounds of one PR across tasks. Only a round recorded with
/// a ledger that failed before its native start was recorded provably started
/// nothing; every other one, older history and unknown ones included, counts.
fn started_rounds(tx: &Connection, linked: &Value) -> Result<i64> {
    Ok(tx.query_row(
        "SELECT COUNT(*) FROM pr_reviews WHERE json_extract(data,'$.repositoryId')=?1 AND json_extract(data,'$.number')=?2
           AND NOT (status='failed' AND json_extract(data,'$.ledger.version') IS ?3 AND json_extract(data,'$.nativeStartedAt') IS NULL)",
        params![linked["repositoryId"].as_i64(), linked["number"].as_i64(), super::continuation::LEDGER_VERSION as i64],
        |r| r.get(0),
    )?)
}

impl Store {
    pub(crate) fn recover_pr_reviews(&self) -> Result<()> {
        let pending = {
            let db = self.db.read()?;
            let mut q =
                db.prepare("SELECT data FROM pr_reviews WHERE status IN ('preparing','running')")?;
            let values = q
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            values
        };
        for raw in pending {
            let mut run: Value = serde_json::from_str(&raw)?;
            // Its native run had completed and shut down, and its report was
            // stored first: only the check after the review was interrupted.
            if run["ledger"]["nativeCompletion"] == "confirmed" && run["conclusion"].is_string() {
                run["status"] = json!("completed");
                if run["scope"].is_object() {
                    run["scope"]["checkAfterReview"] = json!("interrupted");
                }
                run["finishedAt"] = json!(now());
                run["phase"] = json!("completed");
                self.save_pr_review(&run, None)?;
                continue;
            }
            run["status"] = json!("unknown");
            run["conclusion"] = json!("unknown");
            run["error"] = json!("Core restarted before review completion was confirmed");
            super::policy::execution_reason(&mut run, "execution_unconfirmed");
            run["finishedAt"] = json!(now());
            self.save_pr_review(&run, None)?;
        }
        Ok(())
    }
    pub(crate) fn previous_pr_review(
        &self,
        actor: Option<&str>,
        input: &super::Start,
    ) -> Result<Option<Value>> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let answer = previous(self, &tx, actor, input)?;
        tx.commit()?;
        Ok(answer)
    }
    pub(crate) fn create_pr_review(
        &self,
        actor: Option<&str>,
        input: &super::Start,
        id: &str,
    ) -> Result<(Value, bool)> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        if let Some(run) = previous(self, &tx, actor, input)? {
            return Ok((run, false));
        }
        let (author, source) = crate::collaboration_store::actor_context(self, &tx, actor)?;
        let task = crate::collaboration_store::task_key(&tx, &input.task_id)?.0;
        let link = &input.link_id;
        let linked = crate::github::store::task_links(&tx, &task)?
            .into_iter()
            .find(|v| v["id"] == link.as_str())
            .context("PR is no longer linked to this task")?;
        ensure!(
            linked["kind"] == "pull",
            "Only pull requests can be reviewed"
        );
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM pr_reviews WHERE task_id=?1",
            [&task],
            |r| r.get(0),
        )?;
        ensure!(
            count < 1000,
            "This task has reached its review history limit"
        );
        let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pr_reviews WHERE task_id=?1 AND link_id=?2 AND status IN ('preparing','running'))", params![task,link], |r| r.get(0))?;
        ensure!(!busy, "A review for this PR is already running");
        // Before a new paid round exists: an earlier completed round of this
        // exact candidate already found paths no round can cover.
        if input.acknowledge_unreviewable != Some(true) {
            let base = input.base_sha.as_deref().or(linked["snapshot"]["baseSha"].as_str());
            let head = input.head_sha.as_deref().or(linked["snapshot"]["headSha"].as_str());
            if let (Some(base), Some(head)) = (base, head) {
                if let Some(message) = known_unreviewable(&tx, &task, link, base, head)? {
                    anyhow::bail!(message);
                }
            }
        }
        // An incremental round relies on one completed full round of this PR
        // at another head, admitted from its stored record, and counts toward
        // the PR's started rounds shared with continuations.
        let incremental = match input.previous_review_id.as_deref() {
            None => None,
            Some(earlier) => {
                let stored: Option<String> = tx
                    .query_row("SELECT data FROM pr_reviews WHERE id=?1 AND task_id=?2 AND link_id=?3", params![earlier, task, link], |r| r.get(0))
                    .optional()?;
                let previous: Value = serde_json::from_str(&stored.context("No review with this previousReviewId belongs to this task's PR")?)?;
                let head = input.head_sha.as_deref().or(linked["snapshot"]["headSha"].as_str());
                let config = serde_json::to_value(super::settings::for_task(&tx, &task)?)?;
                super::incremental::admit(&previous, head, &config).map_err(|refusal| anyhow::anyhow!("{refusal} No review was started."))?;
                let started = started_rounds(&tx, &linked)?;
                ensure!(
                    started < super::continuation::MAX_STARTED_ROUNDS,
                    "This PR already has {started} review rounds that started or may have started, across tasks; an incremental round would be one more than the {} it may use. Report the result to whoever decides. No review was started.",
                    super::continuation::MAX_STARTED_ROUNDS
                );
                Some(previous)
            }
        };
        let round: i64 = tx.query_row(
            "SELECT COUNT(*)+1 FROM pr_reviews WHERE task_id=?1 AND link_id=?2",
            params![task, link],
            |r| r.get(0),
        )?;
        ensure!(
            actor.is_none()
                || input
                    .notify_agent_id
                    .as_deref()
                    .is_none_or(|id| Some(id) == actor),
            "MCP review results are sent to the requesting Agent"
        );
        let recipient = input
            .notify_agent_id
            .as_deref()
            .or(actor)
            .map(|id| crate::collaboration_store::agent_actor(self, &tx, id))
            .transpose()?;
        // This task's reviewer (its project's, the Workspace's or the built-in), fixed now.
        let settings = super::settings::for_task(&tx, &task)?;
        crate::delivery::store::attach_review(&tx,&task,link,input.base_sha.as_deref(),input.head_sha.as_deref(),&serde_json::to_value(&settings)?,&input.request_id,id)?;
        let mut data = json!({"requestId":input.request_id,"notificationRecipient":recipient,"requestedHarness":settings.harness,"actualHarness":null,"reviewId":id,"round":round,"requestedBy":author,"source":source,"id":id,"taskId":task,"linkId":link,"repository":linked["repository"],"repositoryId":linked["repositoryId"],"number":linked["number"],"url":linked["url"],"status":"preparing","phase":"Fetching fixed PR revision","requestedModel":settings.model,"actualModel":null,"requestedBaseSha":input.base_sha,"requestedHeadSha":input.head_sha,"baseSha":null,"headSha":null,"mergeBaseSha":null,"createdAt":now(),"finishedAt":null,"conclusion":"unknown","findings":[],"error":null,"policyVersion":super::policy::VERSION,"coveragePolicyVersion":super::source::COVERAGE_VERSION,"reasonCodes":[],"acknowledgedUnreviewable":input.acknowledge_unreviewable == Some(true),"ledger":{"version":super::continuation::LEDGER_VERSION}});
        let mut body = format!("Requested code review round {round} · {id}.");
        if let Some(previous) = &incremental {
            data["kind"] = json!("incremental");
            data["previousReviewId"] = previous["id"].clone();
            data["incremental"] = super::incremental::record(previous);
            body = format!("Requested code review round {round} · {id}: an incremental review of a new head after round {}, reading what changed since, with its own budget and cost.", previous["round"]);
        }
        tx.execute("INSERT INTO pr_reviews(id,task_id,link_id,status,data) VALUES(?1,?2,?3,'preparing',?4)", params![id,task,link,data.to_string()])?;
        let mut payload = serde_json::to_value(input)?;
        payload["taskId"] = json!(task);
        tx.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,'review_start',?2,?3,?4)",params![actor_key(actor),input.request_id,payload.to_string(),json!({"reviewId":id}).to_string()])?;
        crate::collaboration_store::activity(
            &tx,
            &task,
            "comment",
            &author,
            &source,
            json!({"body":format!("{body} Review execution and task acceptance remain separate."),"reviewId":id}),
        )?;
        tx.commit()?;
        Ok((data, true))
    }

    pub(crate) fn previous_pr_review_continuation(
        &self,
        actor: Option<&str>,
        input: &super::continuation::Continue,
    ) -> Result<Option<Value>> {
        let db = self.db.read()?;
        previous_continuation(self, &db, actor, input)
    }
    /// A continuation exists only once its parent is admitted from its own
    /// stored record, in the same transaction that reserves the budget, so
    /// two requests can never both reserve it. Returns the child, the
    /// parent it continues, and whether it was created now.
    pub(crate) fn create_pr_review_continuation(
        &self,
        actor: Option<&str>,
        input: &super::continuation::Continue,
        id: &str,
    ) -> Result<(Value, Option<Value>, bool)> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        if let Some(run) = previous_continuation(self, &tx, actor, input)? {
            return Ok((run, None, false));
        }
        let (author, source) = crate::collaboration_store::actor_context(self, &tx, actor)?;
        let task = crate::collaboration_store::task_key(&tx, &input.task_id)?.0;
        let stored: Option<(String, String)> = tx
            .query_row("SELECT link_id,data FROM pr_reviews WHERE id=?1 AND task_id=?2", params![input.review_id, task], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let (link, parent) = stored.context("No review with this reviewId belongs to this task")?;
        let parent: Value = serde_json::from_str(&parent)?;
        let linked = crate::github::store::task_links(&tx, &task)?
            .into_iter()
            .find(|v| v["id"] == link.as_str())
            .context("PR is no longer linked to this task")?;
        let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pr_reviews WHERE task_id=?1 AND link_id=?2 AND status IN ('preparing','running'))", params![task,link], |r| r.get(0))?;
        ensure!(!busy, "A review for this PR is already running");
        // One continuation per parent. Only a child that provably started no
        // model (it failed before its native start was recorded) leaves it.
        let used: Option<String> = tx
            .query_row("SELECT data FROM pr_reviews WHERE task_id=?1 AND json_extract(data,'$.parentReviewId')=?2 AND NOT (status='failed' AND json_extract(data,'$.nativeStartedAt') IS NULL) ORDER BY rowid LIMIT 1", params![task, input.review_id], |r| r.get(0))
            .optional()?;
        if let Some(used) = used {
            let used: Value = serde_json::from_str(&used)?;
            anyhow::bail!(
                "Round {} already has continuation round {} ({}, {}); a review chain gets at most one, and its budget isn't refilled. Report the result to whoever decides; a new full round needs their authorization.",
                parent["round"], used["round"], used["id"].as_str().unwrap_or_default(), used["status"].as_str().unwrap_or("unknown")
            );
        }
        let settings = super::settings::for_task(&tx, &task)?;
        let config = serde_json::to_value(&settings)?;
        let admitted = super::continuation::admit(&parent, input, &config).map_err(|refusal| anyhow::anyhow!("{refusal} No continuation was started."))?;
        // At most two started rounds of this PR, the continuation included,
        // whichever task they belong to. Only a round recorded with a ledger
        // that failed before its native start was recorded provably started
        // nothing; every other one, older history and unknown ones included,
        // counts.
        let started = started_rounds(&tx, &linked)?;
        ensure!(
            started < super::continuation::MAX_STARTED_ROUNDS,
            "This PR already has {started} review rounds that started or may have started, across tasks; a continuation would be one more than the {} it may use. Report the result to whoever decides. No continuation was started.",
            super::continuation::MAX_STARTED_ROUNDS
        );
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM pr_reviews WHERE task_id=?1", [&task], |r| r.get(0))?;
        ensure!(count < 1000, "This task has reached its review history limit");
        let round: i64 = tx.query_row("SELECT COUNT(*)+1 FROM pr_reviews WHERE task_id=?1 AND link_id=?2", params![task, link], |r| r.get(0))?;
        let recipient = actor
            .map(|id| crate::collaboration_store::agent_actor(self, &tx, id))
            .transpose()?;
        // A delivery of this exact candidate counts the continuation as one
        // of its authorized attempts, never as an extra one.
        crate::delivery::store::attach_review(&tx, &task, &link, Some(&input.base_sha), Some(&input.head_sha), &config, &input.request_id, id).map_err(|error| {
            if error.to_string() == "Registered review already exists" {
                anyhow::anyhow!("This candidate's delivery round already has its review. A continuation is another attempt: authorize it within the delivery's limit with delivery_continue first. No continuation was started.")
            } else {
                error
            }
        })?;
        let data = json!({"requestId":input.request_id,"notificationRecipient":recipient,"requestedHarness":settings.harness,"actualHarness":null,"reviewId":id,"round":round,"requestedBy":author,"source":source,"id":id,"taskId":task,"linkId":link,"repository":linked["repository"],"repositoryId":linked["repositoryId"],"number":linked["number"],"url":linked["url"],"status":"preparing","phase":"Fetching fixed PR revision","requestedModel":settings.model,"actualModel":null,"requestedBaseSha":input.base_sha,"requestedHeadSha":input.head_sha,"baseSha":null,"headSha":null,"mergeBaseSha":null,"createdAt":now(),"finishedAt":null,"conclusion":"unknown","findings":[],"error":null,"policyVersion":super::policy::VERSION,"coveragePolicyVersion":super::source::COVERAGE_VERSION,"reasonCodes":[],"acknowledgedUnreviewable":input.acknowledge_unreviewable == Some(true),"ledger":{"version":super::continuation::LEDGER_VERSION},
            "kind":"continuation","parentReviewId":parent["id"],"continuation":super::continuation::record(&parent, &admitted)});
        tx.execute("INSERT INTO pr_reviews(id,task_id,link_id,status,data) VALUES(?1,?2,?3,'preparing',?4)", params![id, task, link, data.to_string()])?;
        let mut payload = serde_json::to_value(input)?;
        payload["taskId"] = json!(task);
        tx.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,'review_continue',?2,?3,?4)", params![actor_key(actor), input.request_id, payload.to_string(), json!({"reviewId":id}).to_string()])?;
        let targets = admitted["targets"].as_array().map_or(0, Vec::len);
        crate::collaboration_store::activity(
            &tx,
            &task,
            "comment",
            &author,
            &source,
            json!({"body":format!("Requested code review round {round} · {id}: a continuation of round {} for {targets} unread path{}, within that round's remaining budget. It is a new reviewer run with its own cost. Review execution and task acceptance remain separate.", parent["round"], if targets == 1 { "" } else { "s" }),"reviewId":id}),
        )?;
        tx.commit()?;
        Ok((data, Some(parent), true))
    }

    pub(crate) fn save_pr_review(&self, data: &Value, report: Option<&str>) -> Result<()> {
        let status = data["status"].as_str().context("Review status missing")?;
        let id = data["id"].as_str().context("Review id missing")?;
        let mut stored_data = data.clone();
        let notification_id = if !matches!(status, "preparing" | "running")
            && data["notificationRecipient"]["id"].is_string()
        {
            Some(uuid::Uuid::new_v4().to_string())
        } else {
            None
        };
        stored_data["notificationId"] = json!(notification_id);
        // A terminal run is immutable. A retry always gets a new record.
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let n = tx.execute("UPDATE pr_reviews SET status=?2,data=?3,report=COALESCE(?4,report) WHERE id=?1 AND status IN ('preparing','running')",params![id,status,stored_data.to_string(),report])?;
        ensure!(n == 1, "Review has already ended");
        if !matches!(status, "preparing" | "running") {
            let actor = crate::collaboration_store::TaskActor {
                kind: "system".into(),
                id: "core".into(),
                name: "Yuzuno Core".into(),
            };
            if let Some(message_id) = notification_id {
                let task = data["taskId"].as_str().context("Missing review task")?;
                let public_task =
                    format!("T-{}", crate::collaboration_store::task_key(&tx, task)?.1);
                let mut body = format!("Code review {} has ended: {status}. Model conclusion: {}. Task {public_task}; PR {}. Fixed base {}, head {}, merge base {}. Read the retained report with review_get(taskId={public_task}, reviewId={id}). Findings, CI, task acceptance and merging are separate; this notification does not authorize another review or automatic rework.{}", data["round"], data["conclusion"].as_str().unwrap_or("unknown"), data["url"].as_str().unwrap_or("unknown"), data["baseSha"].as_str().unwrap_or("not resolved"), data["headSha"].as_str().unwrap_or("not resolved"), data["mergeBaseSha"].as_str().unwrap_or("not resolved"), data["error"].as_str().map(|e|format!(" Error: {e}")).unwrap_or_default());
                if data["kind"] == "continuation" {
                    body.push_str(&format!(" It continued round {} within what that round left of its budget, as a new reviewer run; its coverage and conclusion are over both rounds.", data["continuation"]["parentRound"]));
                }
                if data["kind"] == "incremental" {
                    body.push_str(&format!(" It reviewed a new head after round {}, reading what changed since; that round's findings stay unless this one shows them fixed ({} settled).", data["incremental"]["previousRound"], data["settledFindings"].as_array().map_or(0, Vec::len)));
                }
                if let Some(codes) = data["reasonCodes"].as_array().filter(|codes| !codes.is_empty()) {
                    body.push_str(&format!(" Review reasons: {}.", codes.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")));
                }
                // Typed so the mailbox notice reads "PR #n · Code review: …"
                // rather than a bare System notice (mailbox_notice.rs).
                let pr = data["url"]
                    .as_str()
                    .and_then(|url| url.split_once("/pull/"))
                    .map(|(_, rest)| rest.split('/').next().unwrap_or(rest))
                    .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
                    .map(|n| format!("PR #{n}"));
                crate::collaboration_store::insert_message(
                    &tx,
                    json!({"id":message_id,"seq":0,"sender":actor,"recipient":data["notificationRecipient"],"body":body,"taskId":task,"replyTo":null,"threadId":message_id,"createdAt":now(),"source":{"reviewId":id},"priority":"normal","reviewId":id,
                        "metadata":{"kind":"review","reviewId":id,"status":status,"conclusion":data["conclusion"],"policyVersion":data["policyVersion"],"reasonCodes":data["reasonCodes"],"name":pr}}),
                )?;
            }
            crate::collaboration_store::activity(
                &tx,
                data["taskId"].as_str().context("Missing task")?,
                "comment",
                &actor,
                &Value::Null,
                json!({"body":format!("Code review round {} · {}: {}. Model conclusion: {}. Open PR reviews for the fixed revision, findings and original report.{}",data["round"],id,status,data["conclusion"].as_str().unwrap_or("unknown"),data["error"].as_str().map(|s|format!(" {s}")).unwrap_or_default()),"reviewId":id}),
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn list_pr_reviews(&self, task: &str, before: Option<i64>) -> Result<Value> {
        self.pr_reviews_page(task, before, false)
    }

    /// Agent discovery reads compact rows; the GUI keeps its original records.
    pub(crate) fn list_pr_review_summaries(&self, task: &str, before: Option<i64>) -> Result<Value> {
        self.pr_reviews_page(task, before, true)
    }

    fn pr_reviews_page(&self, task: &str, before: Option<i64>, compact: bool) -> Result<Value> {
        let db = self.db.read()?;
        let task = crate::collaboration_store::task_key(&db, task)?.0;
        let links = crate::github::store::task_links(&db, &task)?;
        let mut q = db.prepare("SELECT rowid,data FROM pr_reviews WHERE task_id=?1 AND rowid<?2 ORDER BY rowid DESC LIMIT 21")?;
        let rows = q.query_map(params![task, before.unwrap_or(i64::MAX)], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut records = Vec::new();
        for row in rows {
            let (seq, raw) = row?;
            let mut data: Value = serde_json::from_str(&raw)?;
            data["cursor"] = json!(seq);
            data["outdated"] = links
                .iter()
                .find(|l| l["id"] == data["linkId"])
                .map_or(Value::Null, |link| outdated(&data, &link["snapshot"]));
            if compact {
                // Do not read or attach per-path evidence only to discard it.
                data = super::mcp::list_row(&data);
            } else {
                super::evidence::attach(&db, &task, &mut data)?;
            }
            records.push(data);
        }
        let has_more = records.len() > 20;
        records.truncate(20);
        // What a new review of this task would use, and where it comes from (T-190).
        let (settings, source) = super::settings::resolve(&db, &task)?;
        let settings = super::settings::sourced(settings, source)?;
        let mut page = json!({"settings":settings,"reviews":records,"hasMore":has_more,"nextBefore":records.last().map(|r|r["cursor"].clone())});
        if compact {
            page["more"] = json!(super::mcp::LIST_MORE);
        }
        Ok(page)
    }

    /// One page of every review in the Workspace, newest first, for the Jobs
    /// list. It can be limited to one task, or to the reviews an Agent itself
    /// requested (its recorded `requestedBy`, never a recipient or assignee).
    /// A link to one review reads just that row, however old.
    /// Rows are summaries: the report, findings and source evidence stay with
    /// the task and are read only when opened there. `outdated` comes from
    /// the page's own task links, read once per task on the page.
    pub(crate) fn index_pr_reviews(
        &self,
        agent: Option<&str>,
        task: Option<&str>,
        review: Option<&str>,
        before: Option<i64>,
    ) -> Result<Value> {
        let db = self.db.read()?;
        let task = task
            .map(|task| crate::collaboration_store::task_key(&db, task).map(|key| key.0))
            .transpose()?;
        let mut q = db.prepare(
            "SELECT r.rowid, r.data, t.seq, json_extract(t.data,'$.title') FROM pr_reviews r
             JOIN collaboration_tasks t ON t.id=r.task_id
             WHERE r.rowid<?1 AND (?2 IS NULL OR r.task_id=?2)
               AND (?3 IS NULL OR (json_extract(r.data,'$.requestedBy.kind')='agent'
                                   AND json_extract(r.data,'$.requestedBy.id')=?3))
               AND (?4 IS NULL OR r.id=?4)
             ORDER BY r.rowid DESC LIMIT 21",
        )?;
        let rows = q
            .query_map(
                params![before.unwrap_or(i64::MAX), task, agent, review],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more = rows.len() > 20;
        let mut links = std::collections::HashMap::<String, Vec<Value>>::new();
        let mut reviews = Vec::new();
        for (cursor, raw, seq, title) in rows.into_iter().take(20) {
            let data: Value = serde_json::from_str(&raw)?;
            let task_id = data["taskId"].as_str().unwrap_or_default().to_owned();
            if !links.contains_key(&task_id) {
                let read = crate::github::store::task_links(&db, &task_id)?;
                links.insert(task_id.clone(), read);
            }
            let outdated = links[&task_id]
                .iter()
                .find(|l| l["id"] == data["linkId"])
                .map_or(Value::Null, |link| outdated(&data, &link["snapshot"]));
            let mut row = super::mcp::index_row(&data);
            row.insert("taskRef".into(), json!(format!("T-{seq}")));
            row.insert("taskTitle".into(), json!(title));
            row.insert(
                "findingsCount".into(),
                json!(data["findings"].as_array().map_or(0, Vec::len)),
            );
            row.insert("outdated".into(), outdated);
            row.insert("cursor".into(), json!(cursor));
            reviews.push(Value::Object(row));
        }
        Ok(json!({
            "reviews": reviews,
            "hasMore": has_more,
            "nextBefore": reviews.last().map(|r| r["cursor"].clone()),
        }))
    }

    pub(crate) fn pr_review_report(&self, task: &str, id: &str) -> Result<Value> {
        let db = self.db.read()?;
        let task = crate::collaboration_store::task_key(&db, task)?.0;
        let (cursor, data, report): (i64, String, Option<String>) = db.query_row(
            "SELECT rowid,data,report FROM pr_reviews WHERE id=?1 AND task_id=?2",
            params![id, task],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let mut data: Value = serde_json::from_str(&data)?;
        data["cursor"] = json!(cursor);
        data["rawReport"] = json!(report);
        data["outdated"] = crate::github::store::task_links(&db, &task)?
            .iter()
            .find(|l| l["id"] == data["linkId"])
            .map_or(Value::Null, |l| outdated(&data, &l["snapshot"]));
        super::evidence::attach(&db, &task, &mut data)?;
        Ok(data)
    }
}

pub(super) fn outdated(run: &Value, snapshot: &Value) -> Value {
    match (
        run["baseSha"].as_str(),
        run["headSha"].as_str(),
        snapshot["baseSha"].as_str(),
        snapshot["headSha"].as_str(),
    ) {
        (Some(b), Some(h), Some(nb), Some(nh)) => json!(b != nb || h != nh),
        _ => Value::Null,
    }
}

fn actor_key(actor: Option<&str>) -> String {
    actor
        .map(|a| format!("agent:{a}"))
        .unwrap_or_else(|| "user".into())
}
/// The same requestId returns the same continuation and never starts
/// another model; another payload under it is refused.
fn previous_continuation(
    store: &Store,
    db: &Connection,
    actor: Option<&str>,
    input: &super::continuation::Continue,
) -> Result<Option<Value>> {
    crate::collaboration_store::actor_context(store, db, actor)?;
    let task = crate::collaboration_store::task_key(db, &input.task_id)?.0;
    let mut expected = serde_json::to_value(input)?;
    expected["taskId"] = json!(task);
    let receipt: Option<(String, String)> = db.query_row("SELECT input_json,response_json FROM collaboration_requests WHERE actor=?1 AND operation='review_continue' AND request_id=?2", params![actor_key(actor), input.request_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let Some((payload, response)) = receipt else {
        return Ok(None);
    };
    ensure!(
        serde_json::from_str::<Value>(&payload)? == expected,
        "idempotency_conflict: requestId already has a different continuation payload"
    );
    let response: Value = serde_json::from_str(&response)?;
    let raw: String = db.query_row("SELECT data FROM pr_reviews WHERE id=?1", [response["reviewId"].as_str().context("Invalid review receipt")?], |r| r.get(0))?;
    Ok(Some(serde_json::from_str(&raw)?))
}
fn previous(
    store: &Store,
    db: &Connection,
    actor: Option<&str>,
    input: &super::Start,
) -> Result<Option<Value>> {
    crate::collaboration_store::actor_context(store, db, actor)?;
    let task = crate::collaboration_store::task_key(db, &input.task_id)?.0;
    let mut expected = serde_json::to_value(input)?;
    expected["taskId"] = json!(task);
    let receipt: Option<(String,String)> = db.query_row("SELECT input_json,response_json FROM collaboration_requests WHERE actor=?1 AND operation='review_start' AND request_id=?2",params![actor_key(actor),input.request_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((payload, response)) = receipt else {
        let registered = crate::delivery::store::registered_review(db,&task,&input.link_id,input.base_sha.as_deref(),input.head_sha.as_deref())?;
        if let Some(run) = &registered {
            db.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,'review_start',?2,?3,?4)",params![actor_key(actor),input.request_id,expected.to_string(),json!({"reviewId":run["id"]}).to_string()])?;
        }
        return Ok(registered);
    };
    ensure!(
        serde_json::from_str::<Value>(&payload)? == expected,
        "idempotency_conflict: requestId already has a different review payload"
    );
    let response: Value = serde_json::from_str(&response)?;
    let raw: String = db.query_row(
        "SELECT data FROM pr_reviews WHERE id=?1",
        [response["reviewId"]
            .as_str()
            .context("Invalid review receipt")?],
        |r| r.get(0),
    )?;
    Ok(Some(serde_json::from_str(&raw)?))
}
