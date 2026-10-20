//! Which changed paths a review covered, and why each other path is outside
//! its scope (coverage policy 3). What tree metadata already shows is found
//! before the reviewer starts; the rest comes from Core's own records during
//! and after the review, never from the model's claims. A path outside the scope keeps the review
//! incomplete whatever its reason: unsupported is never excluded, and neither
//! is ever covered. Each path keeps every fact found for it; its `state` only
//! names the first of them in a fixed order.
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The shape of `run.scope`.
pub(crate) const VERSION: u64 = 1;
/// The repository's explicit scope policy, read only at the PR's frozen base,
/// so a head can't add or widen an exclusion for itself.
pub(super) const POLICY_PATH: &str = ".yuzuno/review-scope.json";
const POLICY_BYTES: usize = 8 * 1024;
const POLICY_RULES: usize = 50;

/// Reviews started under coverage policy 3 or later report their scope.
pub(super) fn applies(run: &Value) -> bool {
    run["coveragePolicyVersion"].as_u64().is_some_and(|v| v >= 3)
}

/// What Core found about each changed path, and when: `before_review` from
/// tree metadata alone (modes, the base's policy; no blob is fetched),
/// `during_review` from the reviewer's own requests, and `after_review` from
/// Core's bounded check of what was left uncovered once the reviewer had
/// finished, so that check can never take budget or time from the review.
#[derive(Default)]
pub(super) struct Preflight {
    /// Each changed path's blob on the merge-base side and the head side.
    pub sides: BTreeMap<String, [String; 2]>,
    /// No tool can deliver this side as text: one fact per side, with its
    /// blob, mode, reason, when it was found and, for a regular file read
    /// after the review, its content's SHA-256.
    pub unsupported: BTreeMap<String, Vec<Value>>,
    /// Its complete diff is larger than the whole review context, so no round
    /// can deliver it (bytes, when Git could produce it within its budget),
    /// and when that was found.
    pub exceeds_context: BTreeMap<String, (Option<usize>, &'static str)>,
    /// Not checked after the review, and why; known neither way.
    pub unchecked: BTreeMap<String, String>,
    /// The policy as read at base: absent, valid with its rules, or invalid.
    pub policy: Value,
    /// Changed paths a valid policy rule excludes, with that rule.
    pub excluded: BTreeMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyFile {
    version: u64,
    exclude: Vec<Rule>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rule {
    path: String,
    reason: String,
}

/// A rule's path: an exact repository path, or `dir/**` for everything under
/// a directory. Nothing else: no globs, negation, `.`/`..`, absolute paths
/// or backslashes.
fn rule_path(path: &str) -> Result<(), String> {
    let exact = path.strip_suffix("/**").unwrap_or(path);
    let segments: Vec<_> = exact.split('/').collect();
    if path.is_empty() || path.len() > 300 || path.starts_with('/') || path.contains('\\')
        || segments.iter().any(|s| s.is_empty() || *s == "." || *s == ".." || s.contains('*'))
    {
        return Err(format!("rule path {path:?} must be an exact repository path or dir/**"));
    }
    Ok(())
}

impl Preflight {
    /// Reads the policy file's bytes as found at base (`None`: no file).
    /// Invalid content excludes nothing: the default full scope applies.
    pub(super) fn set_policy(&mut self, found: Option<(String, Result<Vec<u8>, String>)>, base: &str, files: &[Value]) {
        let Some((blob, bytes)) = found else {
            self.policy = json!({"state":"absent","path":POLICY_PATH,"revision":base});
            return;
        };
        let parsed = bytes.and_then(|bytes| {
            if bytes.len() > POLICY_BYTES {
                return Err(format!("larger than {POLICY_BYTES} bytes"));
            }
            let file: PolicyFile = serde_json::from_slice(&bytes).map_err(|e| format!("not a version 1 policy: {e}"))?;
            if file.version != 1 {
                return Err(format!("version {} is not supported; use 1", file.version));
            }
            if file.exclude.len() > POLICY_RULES {
                return Err(format!("more than {POLICY_RULES} rules"));
            }
            let mut rules = Vec::new();
            for rule in &file.exclude {
                rule_path(&rule.path)?;
                if rule.reason.trim().is_empty() || rule.reason.len() > 200 || rule.reason.chars().any(char::is_control) {
                    return Err(format!("rule {:?} needs a reason of 1–200 printable characters", rule.path));
                }
                if rules.iter().any(|r: &Value| r["path"] == rule.path.as_str()) {
                    return Err(format!("rule {:?} appears twice", rule.path));
                }
                rules.push(json!({"path":rule.path,"reason":rule.reason}));
            }
            Ok(rules)
        });
        let changed = files.iter().any(|f| f["path"] == POLICY_PATH);
        match parsed {
            Ok(rules) => {
                for file in files {
                    let path = file["path"].as_str().unwrap_or_default();
                    // The policy file itself is always reviewed.
                    if path == POLICY_PATH {
                        continue;
                    }
                    if let Some(rule) = rules.iter().find(|r| {
                        let rule = r["path"].as_str().unwrap_or_default();
                        rule.strip_suffix("/**").map_or(rule == path, |dir| path.starts_with(&format!("{dir}/")))
                    }) {
                        self.excluded.insert(path.into(), rule.clone());
                    }
                }
                self.policy = json!({"state":"valid","path":POLICY_PATH,"revision":base,"blobSha":blob,"schemaVersion":1,
                    "rules":rules,"changedByThisPr":changed});
            }
            Err(error) => {
                self.policy = json!({"state":"invalid","path":POLICY_PATH,"revision":base,"blobSha":blob,"error":error,"changedByThisPr":changed});
            }
        }
    }

    /// Every changed path with both sides' frozen blob and mode, every fact
    /// found for it, and the first fact's state in this order:
    /// covered, excluded, unsupported, budget_exhausted (diff_exceeds_context),
    /// read_failed, budget_exhausted (context_exhausted), not_read.
    pub(super) fn report(
        &self,
        run: &Value,
        files: &[Value],
        covered: &[Value],
        uninspected: &[Value],
        failures: &[Value],
        terminal: Option<&str>,
    ) -> Value {
        let mut counts: BTreeMap<&str, usize> = STATES.iter().map(|s| (*s, 0)).collect();
        let mut paths = Vec::new();
        for file in files {
            let path = file["path"].as_str().unwrap_or_default();
            let [old_blob, new_blob] = self.sides.get(path).cloned().unwrap_or_default();
            let mut entry = json!({"path":path,"status":file["status"]});
            if file["status"] != "added" {
                entry["mergeBase"] = json!({"blobSha":old_blob,"mode":file["oldMode"]});
            }
            if file["status"] != "removed" {
                entry["head"] = json!({"blobSha":new_blob,"mode":file["modeAtHead"]});
            }
            let mut facts = Vec::new();
            if let Some(proof) = covered.iter().find(|c| c["path"] == path) {
                let mut fact = json!({"kind":"covered","evidenceKind":proof["evidenceKind"]});
                // A continuation's union: the review whose reads proved it.
                if let Some(review) = proof.get("byReview") {
                    fact["byReview"] = review.clone();
                }
                facts.push(fact);
            }
            if let Some(rule) = self.excluded.get(path) {
                facts.push(json!({"kind":"excluded","rule":rule["path"],"reason":rule["reason"],"policyBlobSha":self.policy["blobSha"]}));
            }
            for side in self.unsupported.get(path).into_iter().flatten() {
                let mut fact = side.clone();
                fact["kind"] = json!("unsupported");
                facts.push(fact);
            }
            if let Some((bytes, found)) = self.exceeds_context.get(path) {
                facts.push(json!({"kind":"budget_exhausted","reason":"diff_exceeds_context","totalDiffBytes":bytes,"found":found}));
            }
            // A request refused only because a budget had already run out is
            // the budget's, not a failed read of this path.
            let failed: Vec<_> = failures
                .iter()
                .filter(|f| f["resolved"] != true && f["kind"] != "terminal_limit" && f["requested"]["path"] == path)
                .map(|f| {
                    let mut request = json!({"receipt":f["receipt"],"kind":f["kind"],"tool":f["tool"]});
                    if let Some(review) = f.get("byReview") {
                        request["byReview"] = review.clone();
                    }
                    request
                })
                .collect();
            if !failed.is_empty() {
                facts.push(json!({"kind":"read_failed","requests":failed}));
            }
            if let Some(gap) = uninspected.iter().find(|u| u["path"] == path) {
                if let Some(limit) = terminal.filter(|limit| budget(limit)) {
                    facts.push(json!({"kind":"budget_exhausted","reason":"context_exhausted","limit":limit,"remainingByteRanges":gap["remainingByteRanges"]}));
                }
                facts.push(json!({"kind":"not_read","remainingByteRanges":gap["remainingByteRanges"],"totalDiffBytes":gap["totalDiffBytes"]}));
            }
            if let Some(error) = self.unchecked.get(path) {
                facts.push(json!({"kind":"not_checked_after_review","error":error}));
            }
            let first = facts
                .iter()
                .find(|f| f["kind"] != "not_checked_after_review")
                .cloned()
                .unwrap_or_else(|| json!({"kind":"not_read"}));
            let state = first["kind"].as_str().unwrap_or("not_read");
            let state = STATES.iter().find(|s| **s == state).copied().unwrap_or("not_read");
            entry["state"] = json!(state);
            if let Some(reason) = first.get("reason").filter(|_| state != "excluded") {
                entry["reason"] = reason.clone();
            }
            entry["facts"] = json!(facts);
            *counts.get_mut(state).unwrap() += 1;
            paths.push(entry);
        }
        json!({"version":VERSION,"baseSha":run["baseSha"],"headSha":run["headSha"],"mergeBaseSha":run["mergeBaseSha"],
            "coveragePolicyVersion":run["coveragePolicyVersion"],"policy":self.policy,"paths":paths,"counts":counts})
    }

    /// A path the reviewer's own request found no tool can deliver. The side
    /// isn't known from the request; the check after the review adds it.
    pub(super) fn found_during_review(&mut self, path: &str, reason: &'static str) {
        self.unsupported
            .entry(path.into())
            .or_insert_with(|| vec![json!({"side":null,"reason":reason,"found":"during_review"})]);
    }
}

/// A terminal limit that is a budget, as opposed to a stop for repeated
/// failures: paths left incomplete by it are budget_exhausted too.
fn budget(limit: &str) -> bool {
    [
        "Review context budget exhausted",
        "Review context byte budget exhausted",
        "Continuation budget exhausted",
        "Continuation byte budget exhausted",
        "Review object storage budget",
        "Local diff cache budget",
        "Fixed source operation exceeded its byte budget",
    ]
    .iter()
    .any(|prefix| limit.starts_with(prefix))
}

pub(super) const STATES: [&str; 6] = ["covered", "excluded", "unsupported", "budget_exhausted", "read_failed", "not_read"];

/// Paths no round of this exact candidate can cover under its policy: every
/// unsupported, too-large or excluded path that isn't covered. This only
/// classifies where a gap comes from; it doesn't make any other gap
/// retryable or a review continuable.
pub(crate) fn permanent_gaps(scope: &Value) -> Vec<Value> {
    scope["paths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| {
            matches!(p["state"].as_str(), Some("unsupported" | "excluded"))
                || (p["state"] == "budget_exhausted" && p["reason"] == "diff_exceeds_context")
        })
        .map(|p| json!({"path":p["path"],"state":p["state"],"reason":p["reason"]}))
        .collect()
}
