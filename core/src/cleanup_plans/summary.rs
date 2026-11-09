//! Core's own summary of each group (design 2.3a): what its items are by
//! Core's checks, never by the names and reasons the plan's author wrote. The
//! user approves groups by it, so an author who labels a worktree with
//! commits of its own "rebuildable" cannot hide it. It is a function of the
//! stored items alone: the same plan always summarizes the same, and the
//! plan's sha256 fixes it.
use super::*;

/// An item as stored: its group, kind and path, and Core's checks of it.
#[derive(Clone, Debug)]
pub(crate) struct Stored {
    pub id: String,
    pub group: String,
    pub kind: String,
    pub path: String,
    /// Refused when the plan was registered: (code, why).
    pub refusal: Option<(String, String)>,
    pub pre: Value,
}

/// Categories Core judges an item to be, in the order the summary lists them.
pub(crate) const CATEGORIES: [&str; 6] =
    ["rebuildable", "clean-merged-worktree", "worktree-unique-commits", "scratch-entry", "other", "refused"];

fn count(n: usize) -> Value {
    json!(n)
}

/// What sets one item apart, as the summary marks it.
fn flags(item: &Stored) -> Vec<String> {
    let facts = &item.pre["worktree"];
    let mut out = Vec::new();
    if let Some(n) = facts["uniqueCommits"].as_u64().filter(|n| *n > 0) {
        out.push(format!("uniqueCommits:{n}"));
    }
    if facts["trackedChanges"].as_u64().is_some_and(|n| n > 0) {
        out.push("trackedChanges".to_owned());
    }
    if facts["untrackedFiles"].as_u64().is_some_and(|n| n > 0) {
        out.push("untrackedFiles".to_owned());
    }
    if item.pre["snapshot"]["files"].as_u64().is_some_and(|n| n > 0) {
        out.push("snapshot".to_owned());
    }
    if let Some((code, _)) = &item.refusal {
        out.push(format!("refused:{code}"));
    }
    out
}

/// One group's summary. `decision` is the group's; labels and reasons are
/// not read.
pub(crate) fn group(id: &str, decision: &str, items: &[&Stored], top: usize) -> Value {
    let pending: Vec<&&Stored> = items.iter().filter(|i| i.refusal.is_none()).collect();
    let worktrees: Vec<&&Stored> = items.iter().filter(|i| i.kind == "worktree").collect();
    let facts = |i: &Stored, key: &str| i.pre["worktree"][key].as_u64().unwrap_or(0);
    let unique: Vec<&&&Stored> = worktrees.iter().filter(|i| facts(i, "uniqueCommits") > 0).collect();
    let mut rules: BTreeMap<String, usize> = BTreeMap::new();
    for item in items.iter().filter(|i| i.kind == "cache-dir") {
        *rules.entry(item.pre["rule"].as_str().unwrap_or("unrecognized").to_owned()).or_default() += 1;
    }
    let mut categories: BTreeMap<&str, usize> = CATEGORIES.iter().map(|c| (*c, 0)).collect();
    for item in items {
        let category = if item.refusal.is_some() { "refused" } else { item.pre["category"].as_str().unwrap_or("other") };
        *categories.entry(CATEGORIES.iter().find(|c| **c == category).copied().unwrap_or("other")).or_default() += 1;
    }
    let mut reasons: BTreeMap<&str, (usize, &str)> = BTreeMap::new();
    for (code, why) in items.iter().filter_map(|i| i.refusal.as_ref()) {
        reasons.entry(code.as_str()).or_insert((0, why.as_str())).0 += 1;
    }
    let mut reasons: Vec<Value> = reasons.into_iter().map(|(code, (n, why))| json!({"code": code, "items": n, "example": why})).collect();
    reasons.sort_by(|a, b| b["items"].as_u64().cmp(&a["items"].as_u64()).then(a["code"].as_str().cmp(&b["code"].as_str())));
    let snapshots: Vec<&&Stored> = pending.iter().copied().filter(|i| i.pre["snapshot"]["files"].as_u64().is_some_and(|n| n > 0)).collect();
    let bytes: u64 = pending.iter().filter_map(|i| i.pre["bytes"].as_u64()).sum();
    let mut warnings = Vec::new();
    if decision == "rebuildable" {
        let not_rule = items.iter().filter(|i| i.kind != "cache-dir").count();
        let unrecognized = items.iter().filter(|i| i.kind == "cache-dir" && i.pre["rule"].as_str().is_none()).count();
        if !worktrees.is_empty() || not_rule > worktrees.len() || unrecognized > 0 {
            warnings.push(json!({"code": "notRebuildable", "text": format!(
                "Marked rebuildable, but Core finds {} worktree(s), {} entr(ies) and {} folder(s) no rule recognizes in it",
                worktrees.len(), not_rule - worktrees.len(), unrecognized)}));
        }
    }
    if matches!(decision, "delete" | "rebuildable") {
        if !unique.is_empty() {
            let commits: u64 = unique.iter().map(|i| facts(i, "uniqueCommits")).sum();
            warnings.push(json!({"code": "uniqueCommits", "text": format!(
                "{} worktree(s) hold {commits} commit(s) found on no remote branch", unique.len())}));
        }
        let changed = worktrees.iter().filter(|i| facts(i, "trackedChanges") > 0 || facts(i, "untrackedFiles") > 0).count();
        if changed > 0 {
            warnings.push(json!({"code": "uncommitted", "text": format!(
                "{changed} worktree(s) have changes Git tracks or untracked files")}));
        }
        // Not known is never taken as merged (Lead mail 10772).
        let unknown = worktrees.iter().filter(|i| i.pre["worktree"]["merged"].is_null()).count();
        if unknown > 0 {
            warnings.push(json!({"code": "mergeUnknown", "text": format!(
                "For {unknown} worktree(s) Git could not tell whether the remote's default branch holds its HEAD")}));
        }
    }
    let mut largest: Vec<&&Stored> = items.iter().collect();
    largest.sort_by(|a, b| b.pre["bytes"].as_u64().cmp(&a.pre["bytes"].as_u64()).then(a.path.cmp(&b.path)));
    let largest: Vec<Value> = largest
        .into_iter()
        .take(top)
        .map(|i| {
            json!({"item": i.id, "path": i.path, "kind": i.kind, "bytes": i.pre["bytes"], "category": i.pre["category"],
                "rule": i.pre["rule"], "basis": i.pre["basis"], "flags": flags(i)})
        })
        .collect();
    json!({
        "group": id,
        "decision": decision,
        "executed": matches!(decision, "delete" | "rebuildable"),
        "items": count(items.len()),
        "pending": count(pending.len()),
        "kinds": {"entry": items.iter().filter(|i| i.kind == "entry").count(), "cacheDir": rules, "worktree": worktrees.len()},
        "bytes": bytes,
        "bytesComplete": pending.iter().all(|i| i.pre["complete"] == true),
        "worktrees": worktrees.len(),
        "uniqueCommits": {"worktrees": unique.len(), "commits": unique.iter().map(|i| facts(i, "uniqueCommits")).sum::<u64>()},
        "trackedChanges": worktrees.iter().filter(|i| facts(i, "trackedChanges") > 0).count(),
        "untrackedFiles": worktrees.iter().filter(|i| facts(i, "untrackedFiles") > 0).count(),
        "snapshots": {"items": snapshots.len(), "bytes": snapshots.iter().filter_map(|i| i.pre["snapshot"]["bytes"].as_u64()).sum::<u64>()},
        "snapshotTooLarge": items.iter().filter(|i| i.refusal.as_ref().is_some_and(|(c, _)| c == "snapshotTooLarge")).count(),
        "refused": {"items": items.iter().filter(|i| i.refusal.is_some()).count(), "reasons": reasons},
        "categories": categories,
        "warnings": warnings,
        "largest": largest,
    })
}

/// Every group's summary, in the plan's order of groups.
pub(crate) fn all(groups: &[(String, String)], items: &[Stored], top: usize) -> Vec<Value> {
    groups
        .iter()
        .map(|(id, decision)| {
            let mine: Vec<&Stored> = items.iter().filter(|i| &i.group == id).collect();
            group(id, decision, &mine, top)
        })
        .collect()
}
