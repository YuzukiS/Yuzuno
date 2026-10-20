//! Versioned conclusions for newly completed reviews. Persisted reports are
//! never reclassified when they are read, and passing is not merge permission.
use serde_json::{Value, json};

/// 3 adds the review scope's reasons for incomplete coverage: a changed path
/// no tool can deliver is `unsupported_source` even when the reviewer never
/// asked for it, one whose complete diff no round can hold is
/// `diff_too_large`, one the base's policy excludes is `scope_excluded`, and
/// a policy file that can't be used is `scope_policy_invalid` (it excludes
/// nothing, so it explains a gap but never blocks a review that covered
/// every path). None of them is ever a pass.
pub(super) const VERSION: u64 = 3;

/// Why coverage is incomplete, as far as the scope shows it.
pub(super) fn scope_reasons(run: &Value) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if run["contextIncomplete"] != true {
        return reasons;
    }
    let paths = run["scope"]["paths"].as_array().map(Vec::as_slice).unwrap_or_default();
    if run["coverage"]["failedRequests"]
        .as_array()
        .is_some_and(|failures| {
            failures
                .iter()
                .any(|f| f["resolved"] != true && f["kind"] == "unsupported_source")
        })
        || paths.iter().any(|p| p["state"] == "unsupported")
    {
        reasons.push("unsupported_source");
    }
    if paths.iter().any(|p| p["state"] == "budget_exhausted" && p["reason"] == "diff_exceeds_context") {
        reasons.push("diff_too_large");
    }
    if paths.iter().any(|p| p["state"] == "excluded") {
        reasons.push("scope_excluded");
    }
    if run["scope"]["policy"]["state"] == "invalid" {
        reasons.push("scope_policy_invalid");
    }
    reasons
}

pub(super) fn reasons(output: &Value, run: &Value) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if run["contextIncomplete"] == true {
        reasons.push("coverage_incomplete");
        reasons.extend(scope_reasons(run));
    }
    match output["overall_correctness"].as_str() {
        Some("unknown") => reasons.push("model_unknown"),
        Some("patch is correct")
            if output["findings"].as_array().is_some_and(|findings| {
                findings
                    .iter()
                    .any(|finding| finding["priority"].as_u64().is_some_and(|p| p < 3))
            }) =>
        {
            reasons.push("verdict_conflict")
        }
        _ => {}
    }
    reasons
}

/// Preserve execution failures independently of the model's raw report.
pub(super) fn execution_reason(run: &mut Value, reason: &str) {
    // A pre-upgrade in-flight review retains its original policy identity.
    if run["policyVersion"] == VERSION {
        let reasons = run["reasonCodes"].as_array().cloned().unwrap_or_default();
        let mut reasons = reasons;
        if !reasons.iter().any(|value| value == reason) {
            reasons.push(json!(reason));
        }
        run["reasonCodes"] = json!(reasons);
    }
}

/// Delivery consumes the stored, versioned verdict; it never reinterprets an
/// older unknown report using today's policy. Candidate/CI/authority checks
/// remain the caller's responsibility.
pub(crate) fn passes(run: &Value) -> bool {
    if run["status"] != "completed" {
        return false;
    }
    match run["conclusion"].as_str() {
        Some("no_findings") => true,
        Some("approved_with_notes") => {
            // A stored policy-2 approval still passes exactly as it did.
            matches!(run["policyVersion"].as_u64(), Some(2 | VERSION))
                && run["nativeCorrectness"] == "patch is correct"
                && run["contextIncomplete"] != true
                && run["reasonCodes"].as_array().is_some_and(Vec::is_empty)
                && run["findings"].as_array().is_some_and(|findings| {
                    !findings.is_empty() && findings.iter().all(|f| f["priority"] == 3)
                })
        }
        _ => false,
    }
}
