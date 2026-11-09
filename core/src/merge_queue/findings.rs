//! P2 findings the user accepted as intended (YN-67). The queue never admits
//! a round with a P0–P2 finding however it was answered, except a P2 that a
//! release acknowledges here:
//!
//! - only a P2: a P0 or P1 is never acknowledged, by anyone;
//! - by the user releasing, or by the task's dispatching lead citing the
//!   user's reply to a Home ask of the task's Project. Only Home's reply
//!   route records a reply, so it is the user's; the ask must be unchanged
//!   since that reply, so its question is the one they answered; and that
//!   question must name the PR (`#n`) and the finding (its title, or its
//!   round's review id), so a reply accepts only what it was asked about;
//! - bound to that finding (its round, index and title), and so to the head
//!   the round reviewed: a new round or a new head needs a new release.
//!
//! The round's own record stays as it is; only the queue's review gate
//! admits it (`admits`), when every one of its P0–P2 findings is one of
//! these and nothing else keeps it from passing.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// At most this many findings in one release.
pub(super) const FINDINGS: usize = 16;
const NOTE: usize = 500;
const TITLE: usize = 1000;
/// The longest key a Brief section has: topic/sub, 48 characters each.
const KEY: usize = 97;
/// How much of the cited question and reply the release records.
const QUOTE: usize = 2000;

/// One finding as the release acknowledges it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Acknowledged {
    pub review_id: String,
    pub index: u64,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_reply: Option<UserReply>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The Home ask whose reply from the user accepts the finding.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UserReply {
    pub key: String,
}

pub(super) fn validate(listed: &[Acknowledged]) -> Result<()> {
    ensure!(!listed.is_empty() && listed.len() <= FINDINGS, "invalid_input: acknowledgeFindings lists 1–{FINDINGS} findings");
    let mut seen = BTreeSet::new();
    for a in listed {
        ensure!(!a.review_id.is_empty() && a.review_id.len() <= 64, "invalid_input: acknowledgeFindings needs each finding's reviewId");
        ensure!(!a.title.trim().is_empty() && a.title.len() <= TITLE, "invalid_input: acknowledgeFindings needs each finding's title, at most {TITLE} bytes");
        ensure!(a.note.as_ref().is_none_or(|n| n.len() <= NOTE), "invalid_input: the note of finding {} must be at most {NOTE} bytes", a.index);
        if let Some(reply) = &a.user_reply {
            ensure!(
                !reply.key.is_empty() && reply.key.len() <= KEY && reply.key.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'/')),
                "invalid_input: userReply.key {:?} is not a Brief section key",
                reply.key
            );
        }
        ensure!(seen.insert((a.review_id.as_str(), a.index)), "invalid_input: acknowledgeFindings lists finding {} of review {} more than once", a.index, a.review_id);
    }
    Ok(())
}

fn clip(text: &str) -> String {
    let mut out: String = text.chars().take(QUOTE).collect();
    if out.len() < text.len() {
        out.push('…');
    }
    out
}

/// Whether `text` names PR `number` as `#number`, not as the start of a
/// longer number.
fn names_pr(text: &str, number: u64) -> bool {
    let tag = format!("#{number}");
    text.match_indices(&tag).any(|(at, _)| !text[at + tag.len()..].starts_with(|c: char| c.is_ascii_digit()))
}

/// The acknowledged findings as the release records them, or why not. Each
/// names a P2 finding of `round`, the PR's last completed round. A lead
/// (`by_user` false) cites the user's reply to an ask of the task's Project,
/// which `reply` reads by key (project_brief::replied_ask); the user may.
pub(super) fn resolve(listed: &[Acknowledged], round: &Value, number: u64, by_user: bool, reply: &dyn Fn(&str) -> Result<Option<Value>>) -> Result<Result<Vec<Value>, String>> {
    let id = round["id"].as_str().unwrap_or("?");
    let findings = round["findings"].as_array().map(Vec::as_slice).unwrap_or_default();
    let mut items = Vec::new();
    for (n, a) in listed.iter().enumerate() {
        let which = format!("acknowledgement {} (finding {} of review {})", n + 1, a.index, a.review_id);
        if a.review_id != id {
            return Ok(Err(format!("{which} names another round: the last completed review round of PR #{number} is {id} (round {}); acknowledge its findings", round["round"])));
        }
        let Some(finding) = usize::try_from(a.index).ok().and_then(|i| findings.get(i)) else {
            return Ok(Err(format!("{which}: that round has {} finding(s)", findings.len())));
        };
        let title = finding["title"].as_str().unwrap_or_default();
        if title != a.title {
            return Ok(Err(format!("{which}: its title there is “{title}”, not “{}”", a.title)));
        }
        match finding["priority"].as_u64() {
            Some(2) => {}
            Some(p @ (0 | 1)) => return Ok(Err(format!("{which} is a P{p}: only a P2 finding can be acknowledged, and a P0 or P1 never is"))),
            Some(3) => return Ok(Err(format!("{which} is a P3, which doesn't block; release without acknowledging it"))),
            _ => return Ok(Err(format!("{which} has no priority Core can read"))),
        }
        let cited = match (&a.user_reply, by_user) {
            (None, true) => Value::Null,
            (None, false) => {
                return Ok(Err(format!("{which} cites no userReply: a lead acknowledges a finding only by citing the user's Home reply that accepts it")));
            }
            (Some(cited), _) => {
                let key = &cited.key;
                let Some(ask) = reply(key)? else {
                    return Ok(Err(format!("{which} cites `{key}`, which is no ask of this task's Project that the user replied to")));
                };
                if ask["changedSinceReply"] != false {
                    return Ok(Err(format!("{which} cites `{key}`, which changed after the user replied, so its question isn't the one they answered; ask again")));
                }
                let text = ask["text"].as_str().unwrap_or_default();
                let short: String = id.chars().take(8).collect();
                if !names_pr(text, number) || !(text.contains(title) || text.contains(&short)) {
                    return Ok(Err(format!(
                        "{which} cites `{key}`, whose ask doesn't name PR #{number} and this finding (its title “{title}”, or review {short}): a reply accepts only what its question names"
                    )));
                }
                json!({"key":key,"version":ask["version"],"title":ask["title"],"question":clip(ask["question"].as_str().unwrap_or_default()),
                    "reply":clip(ask["reply"].as_str().unwrap_or_default()),"repliedAt":ask["repliedAt"],"askedBy":ask["owner"]})
            }
        };
        items.push(json!({"reviewId":id,"round":round["round"],"index":a.index,"priority":2,"path":finding["path"],
            "startLine":finding["startLine"],"endLine":finding["endLine"],"title":title,"note":a.note,"userReply":cited}));
    }
    Ok(Ok(items))
}

fn acknowledged(items: &[Value], id: &str, index: usize, finding: &Value) -> bool {
    items.iter().any(|i| i["reviewId"] == id && i["index"] == index && i["title"] == finding["title"] && i["priority"] == 2)
}

/// Whether the release's acknowledged findings (`items`, as recorded)
/// admit `round`, the last completed round, which doesn't pass by itself:
/// it is complete and has a verdict, and every P0–P2 finding it has is an
/// acknowledged P2 of it.
pub(super) fn admits(round: &Value, items: &[Value]) -> Result<(), String> {
    let id = round["id"].as_str().unwrap_or("?");
    if round["status"] != "completed" {
        return Err(format!("review round {id} has not completed"));
    }
    if round["policyVersion"] != 3 {
        return Err(format!("review round {id} was judged under another review policy"));
    }
    if round["contextIncomplete"] == true || !round["coverage"]["terminalLimit"].is_null() {
        return Err(format!("review round {id} didn't cover every changed path"));
    }
    if let Some(codes) = round["reasonCodes"].as_array().filter(|codes| !codes.is_empty()) {
        let codes: Vec<&str> = codes.iter().filter_map(Value::as_str).collect();
        return Err(format!("review round {id} has reasons of its own ({})", codes.join(", ")));
    }
    if !matches!(round["nativeCorrectness"].as_str(), Some("patch is correct" | "patch is incorrect")) {
        return Err(format!("the reviewer of round {id} reached no verdict"));
    }
    let findings = round["findings"].as_array().map(Vec::as_slice).unwrap_or_default();
    for (index, finding) in findings.iter().enumerate() {
        let priority = finding["priority"].as_u64();
        if priority.is_some_and(|p| p <= 2) && !acknowledged(items, id, index, finding) {
            let title = finding["title"].as_str().unwrap_or("?");
            return Err(match priority {
                Some(p @ (0 | 1)) => format!("review round {id} found “{title}” (P{p}), and a P0 or P1 is never acknowledged"),
                _ => format!("review round {id} found “{title}” (P2), which the release doesn't acknowledge"),
            });
        }
    }
    for item in items {
        let found = item["index"].as_u64().and_then(|i| findings.get(i as usize)).filter(|f| item["reviewId"] == id && f["title"] == item["title"] && f["priority"] == 2);
        if found.is_none() {
            return Err(format!("the acknowledged “{}” is not a P2 finding of review round {id}", item["title"].as_str().unwrap_or("?")));
        }
    }
    Ok(())
}

/// Whether `finding`, of another completed round at the same head, is one
/// the release acknowledged: a P2 at the same path with the same title.
pub(super) fn covers(finding: &Value, items: &[Value]) -> bool {
    finding["priority"] == 2 && items.iter().any(|i| i["path"] == finding["path"] && i["title"] == finding["title"])
}
