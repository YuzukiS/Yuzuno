//! Which review rounds of one PR count toward its started rounds (YN-67).
//!
//! A PR gets at most `continuation::MAX_STARTED_ROUNDS` started rounds for
//! its continuations and incremental reviews, across tasks. A round counts
//! unless its stored record shows that it reached no verdict:
//!
//! - it failed before its native start was recorded, so it started nothing;
//! - its native harness itself reported a failure before any report: its
//!   only reason is `execution_failed`, and it has no conclusion, findings
//!   or correctness verdict (Claude ends such a round `failed`, Codex
//!   `unknown`). One that read nothing but the change manifest never counts.
//!   Of those that read source first, only the PR's first doesn't count: it
//!   had no verdict to retry away from, but it spent its budget, so a
//!   reviewer that keeps failing is counted from its second such round on.
//!
//! Every other round counts: a report of any kind, a cancellation, a
//! deadline, a restart, an unconfirmed shutdown, one still running, and an
//! older round without a ledger.
//!
//! A round that ended without a report is stamped with the decision when it
//! ends (`roundLimit`), so its record and its task say whether it counted
//! and why. Counting reads the stamps, and judges an older round without one
//! by the same rule, in the order the rounds were created.
use super::continuation::LEDGER_VERSION;
use serde_json::{Value, json};
#[cfg(test)]
mod tests;

/// What a stored round's ending shows.
#[derive(Debug, PartialEq)]
pub(super) enum Ending {
    /// It failed before its native start was recorded.
    NotStarted,
    /// Its native harness reported a failure before any report; `read`:
    /// whether it read any source, beyond the change manifest, first.
    NoReport { read: bool },
    /// Any other ending, or none yet.
    Other,
}

pub(super) fn ending(run: &Value) -> Ending {
    if run["ledger"]["version"] != LEDGER_VERSION {
        return Ending::Other;
    }
    if run["status"] == "failed" && run["nativeStartedAt"].is_null() {
        return Ending::NotStarted;
    }
    let no_report = matches!(run["status"].as_str(), Some("failed" | "unknown"))
        && run["nativeStartedAt"].is_string()
        && run["reasonCodes"] == json!(["execution_failed"])
        && run["conclusion"] == "unknown"
        && run["nativeCorrectness"].is_null()
        && run["findings"].as_array().is_some_and(Vec::is_empty);
    if !no_report {
        return Ending::Other;
    }
    let read = run["contextReads"].as_array().into_iter().flatten().any(|r| r["tool"] != "review_changes");
    Ending::NoReport { read }
}

fn stamped_uncounted_after_reads(run: &Value) -> bool {
    run["roundLimit"]["counts"] == false && run["roundLimit"]["read"] == "some"
}

/// The round that took the PR's one uncounted failure after reads: a round
/// stamped so, else the first older unstamped one the rule leaves uncounted.
fn uncounted_after_reads(rounds: &[Value]) -> Option<&Value> {
    rounds.iter().find(|r| stamped_uncounted_after_reads(r)).or_else(|| {
        rounds.iter().find(|r| r["roundLimit"].is_null() && ending(r) == Ending::NoReport { read: true })
    })
}

/// Whether each of a PR's rounds counts, given in the order they were
/// created: as its stamp says, or by the rule for an older round without one.
pub(super) fn counts(rounds: &[Value]) -> Vec<bool> {
    let mut taken = rounds.iter().any(stamped_uncounted_after_reads);
    rounds
        .iter()
        .map(|r| match r["roundLimit"]["counts"].as_bool() {
            Some(counts) => counts,
            None => match ending(r) {
                Ending::NotStarted | Ending::NoReport { read: false } => false,
                Ending::NoReport { read: true } if !taken => {
                    taken = true;
                    false
                }
                _ => true,
            },
        })
        .collect()
}

/// What a round that ended without a report records when it ends, given
/// the PR's other rounds in the order they were created; None for any other.
pub(super) fn stamp(run: &Value, others: &[Value]) -> Option<Value> {
    let Ending::NoReport { read } = ending(run) else {
        return None;
    };
    if !read {
        return Some(json!({"counts":false,"read":"nothing",
            "why":"It ended without a report and read no source, so it doesn't count toward this PR's two started rounds."}));
    }
    Some(match uncounted_after_reads(others) {
        None => json!({"counts":false,"read":"some",
            "why":"It ended without a report after reading source. It doesn't count toward this PR's two started rounds: it is the one such round a PR gets uncounted, and any later one counts."}),
        Some(earlier) => json!({"counts":true,"read":"some","uncountedRound":{"reviewId":earlier["id"],"round":earlier["round"]},
            "why":format!("It ended without a report after reading source, and counts toward this PR's two started rounds: round {} ({}) was already the PR's one such round left uncounted.",
                earlier["round"], earlier["id"].as_str().unwrap_or("?"))}),
    })
}
