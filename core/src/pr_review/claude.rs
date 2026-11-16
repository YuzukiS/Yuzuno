use super::{persist, reviewer, source};
use crate::{claude::Bridge, workspace::Workspace};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};
use tokio::sync::mpsc;

/// What a review whose Claude run ended without a report says. The SDK
/// reports a usage limit or an API error as subtype "success" with is_error
/// true, which read "failed (success)" (YN-193); its text is said as text,
/// not as JSON in quotes.
fn failure_text(result: &Value) -> String {
    let text = |v: &Value| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string());
    let said = match result.get("errors") {
        Some(Value::Array(errors)) => errors.iter().map(text).collect::<Vec<_>>().join("; "),
        Some(errors) => text(errors),
        None => text(&result["result"]),
    };
    match result["subtype"].as_str() {
        Some("success") => format!("Claude review failed: Claude reported an error before any report: {said}"),
        subtype => format!("Claude review failed ({}): {said}", subtype.unwrap_or("unknown")),
    }
}

pub(super) async fn review(
    ws: &Workspace,
    directory: &Path,
    evidence: &str,
    run: &mut Value,
    raw: &mut String,
    owned: &mut Option<Arc<Bridge>>,
    context: &mut source::ContextStore,
) -> Result<()> {
    let (tx, mut events) = mpsc::channel(128);
    let bridge = Bridge::spawn_review(tx, directory).await?;
    *owned = Some(bridge.clone());
    let model = run["requestedModel"]
        .as_str()
        .context("Missing frozen Claude model")?
        .to_owned();
    let started = bridge.request(json!({"op":"review_start","cwd":directory,"model":model,"prompt":reviewer::prompt(evidence),"schema":reviewer::schema(evidence)})).await?;
    run["resolvedModel"] = started["resolvedModel"].clone();
    // Which CLI and SDK ran this review, and where the CLI was found.
    if started["provenance"].is_object() {
        run["provenance"] = started["provenance"].clone();
    }
    run["status"] = json!("running");
    run["phase"] = json!("Claude Code is reviewing the fixed PR revision");
    persist(ws, run, None).await?;
    while let Some(message) = events.recv().await {
        match message["type"].as_str() {
            Some("review_init") => {
                let init = &message["event"];
                let expected: Vec<_> = source::TOOL_NAMES
                    .iter()
                    .map(|name| format!("mcp__review__{name}"))
                    .collect();
                ensure!(
                    init["tools"].as_array().is_some_and(|actual| {
                        actual.iter().all(|v| {
                            v == "StructuredOutput" || expected.iter().any(|name| v == name)
                        }) && expected.iter().all(|name| actual.iter().any(|v| v == name))
                    }),
                    "Claude exposed unexpected review tools"
                );
                run["nativeTools"] = init["tools"].clone();
                run["actualHarness"] = json!("claude");
                run["actualModel"] = init["model"].clone();
                run["sessionId"] = init["session_id"].clone();
                run["cliVersion"] = init["claude_code_version"].clone();
                ensure!(
                    run["actualModel"].as_str().is_some_and(|s| !s.is_empty()),
                    "Claude did not report its actual model"
                );
                persist(ws, run, None).await?;
            }
            Some("source_tool") => {
                let tool = message["tool"]
                    .as_str()
                    .context("Missing source tool name")?;
                ensure!(
                    source::TOOL_NAMES.contains(&tool),
                    "Claude requested an unexpected review tool"
                );
                let value = source::context_response(
                    ws,
                    run,
                    directory,
                    context,
                    tool,
                    message["arguments"].clone(),
                )
                .await?;
                bridge
                    .request(json!({"op":"source_result","callId":message["callId"],"value":value}))
                    .await?;
            }
            Some("review_result") => {
                let result = &message["event"];
                let original = serde_json::to_string_pretty(result)?;
                ensure!(
                    original.len() <= 256_000,
                    "Claude review report exceeds its size limit"
                );
                *raw = original;
                if result["subtype"] != "success" || result["is_error"] == true {
                    run["status"] = json!("failed");
                    super::policy::execution_reason(run, "execution_failed");
                    run["error"] = json!(failure_text(result));
                    return Ok(());
                }
                ensure!(
                    run["actualHarness"] == "claude"
                        && run["actualModel"].as_str().is_some_and(|m| !m.is_empty()),
                    "Claude result has no confirmed native model"
                );
                reviewer::complete_report(&result["structured_output"], run);
                return Ok(());
            }
            Some("review_error" | "disconnected") => bail!(
                "Claude review ended without confirmed completion: {}",
                message["error"].as_str().unwrap_or("Connection closed")
            ),
            _ => {}
        }
    }
    bail!("Claude review stream ended without a result")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// YN-193: a usage-limit failure read "Claude review failed (success): \"…\"".
    #[test]
    fn a_usage_limit_failure_says_claude_reported_an_error_not_failed_success() {
        let limit = json!({"type":"result","subtype":"success","is_error":true,"result":"Credit balance is too low"});
        assert_eq!(failure_text(&limit), "Claude review failed: Claude reported an error before any report: Credit balance is too low");
        let turns = json!({"type":"result","subtype":"error_max_turns","errors":["Reached the turn limit","No report"]});
        assert_eq!(failure_text(&turns), "Claude review failed (error_max_turns): Reached the turn limit; No report");
        assert_eq!(failure_text(&json!({"is_error":true,"result":{"code":7}})), "Claude review failed (unknown): {\"code\":7}");
    }
}
