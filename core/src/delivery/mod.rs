//! A bounded, explicitly authorized delivery. Native reviews and CI keep owning
//! execution and evidence; this module only composes their durable identities.
pub(crate) mod store;
#[cfg(test)]
mod tests;
use crate::commit_sha::{self, Form};
use crate::workspace::Workspace;
use anyhow::Result;
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};

#[derive(Default)]
pub(crate) struct State {
    started: OnceLock<()>,
    pub wake: Arc<tokio::sync::Notify>,
}
impl Workspace {
    pub(crate) fn start_delivery(self: &Arc<Self>) {
        if self.delivery.started.set(()).is_err() {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(ws) = weak.upgrade() else { break };
                if let Err(error) = tick(&ws).await {
                    eprintln!("Delivery reconciliation: {error:#}");
                }
                let wake = ws.delivery.wake.clone();
                drop(ws);
                // No remote polling: the timer only expires evidence and retries
                // pre-execution setup (three attempts, same operation identity).
                tokio::select! { _ = wake.notified() => {}, _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {} }
            }
        });
    }
}
async fn tick(ws: &Arc<Workspace>) -> Result<()> {
    let tasks = ws.stored(|s| s.delivery_tasks()).await?;
    for task in tasks {
        for kind in ["review", "ci"] {
            let id = task.clone();
            let plan = ws.stored(move |s| s.delivery_claim(&id, kind)).await?;
            let Some(plan) = plan else { continue };
            let actor = Some(plan.owner.clone());
            let answer = if kind == "review" {
                crate::pr_review::call(ws.clone(), actor, "review_start".into(), plan.input.clone())
                    .await
            } else {
                crate::ci_monitor::call(
                    ws.clone(),
                    actor,
                    "ci_subscribe".into(),
                    plan.input.clone(),
                )
                .await
            }
            .map_err(|e| e.to_string());
            let id = task.clone();
            ws.stored(move |s| s.delivery_finish(&id, &plan, answer))
                .await?;
        }
        let changed = ws.stored(move |s| s.delivery_reconcile(&task)).await?;
        if changed {
            ws.changes.send(json!({"collaboration":true}));
            ws.collaboration_wakeup.notify_one();
        }
    }
    Ok(())
}
pub(crate) fn submission_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["flowId","round","baseSha","headSha"],"properties":{"flowId":{"type":"string"},"round":{"type":"integer","minimum":1,"maximum":2},"baseSha":commit_sha::schema(Form::GitHub, false, "Copy it from delivery_get."),"headSha":commit_sha::schema(Form::GitHub, false, "Copy it from delivery_get.")},"description":"Explicitly submit this enabled delivery candidate. Obtain these exact fields from delivery_get. Omit for an ordinary task result; a push alone never authorizes another review."})
}
pub(crate) fn tool_definitions() -> Vec<Value> {
    let string = json!({"type":"string"});
    let base = commit_sha::schema(Form::GitHub, false, "The PR base this delivery is fixed to.");
    let head = commit_sha::schema(Form::GitHub, false, "The PR head this delivery is fixed to.");
    let candidate = json!({"requestId":string,"taskId":string,"linkId":string,"baseSha":base,"headSha":head,"settings":{"type":"object","additionalProperties":false,"required":["harness","model"],"properties":{"harness":string,"model":string}}});
    let mut enable = candidate.clone();
    enable["maxRounds"] = json!({"type":"integer","minimum":1,"maximum":2});
    let mut next = candidate;
    next["flowId"] = string.clone();
    next["expectedRound"] = json!({"type":"integer","minimum":1,"maximum":2});
    [
        ("delivery_get", "Read the explicitly enabled task delivery, original operation IDs, current evidence and next action. Does not launch work.", json!({"taskId":string}), vec!["taskId"]),
        ("delivery_enable", "Explicitly authorize one task/linked PR/fixed base and head using the actual Workspace review settings and a maximum of 1–2 review attempts. Requires an assigned open local Agent. No review starts until task_submit_result includes the matching delivery candidate. Does not merge or publish.", enable, vec!["requestId","taskId","linkId","baseSha","headSha","settings","maxRounds"]),
        ("delivery_continue", "Explicitly authorize the next fixed candidate within the original cap after the previous review ended. A changed head alone is not authorization. This may start another paid review after a matching result submission. Unknown reviews must first be reconciled manually; this operation cannot replace them.", next, vec!["requestId","taskId","flowId","expectedRound","linkId","baseSha","headSha","settings"]),
        ("delivery_stop", "Idempotently stop automatic delivery, including after task closure. Releases only this flow's CI interests; retains manual subscriptions, terminal outcome, evidence and running native work. Does not cancel reviews or remote CI.", json!({"requestId":string,"taskId":string,"flowId":string}), vec!["requestId","taskId","flowId"]),
    ].into_iter().map(|(name,description,mut properties,required)| {
        properties["taskId"]["description"] = json!("Existing task ID returned by Yuzuno, for example T-1. Reuse this task across delivery, review and retries.");
        json!({"name":name,"description":description,"inputSchema":{"type":"object","additionalProperties":false,"properties":properties,"required":required}})
    }).collect()
}
