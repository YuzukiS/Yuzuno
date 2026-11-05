//! What an executor that starts cold is told of its task's past (T-34,
//! executor model phase 1): the latest result, the newest comments' first
//! lines, and each linked pull request as last observed with the P0–P2
//! findings of its latest completed review, in that order, so a cut keeps
//! the first.
//! Core writes it from what it holds, at most 4 KiB of Markdown, into a
//! template dispatch's materials; nothing in it is read again from GitHub or
//! a model.
use super::SharedTask;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::Value;

pub(super) const LIMIT: usize = 4 * 1024;
const RESULT: usize = 800;
const FINDINGS: usize = 5;
const COMMENTS: i64 = 3;
const LINE: usize = 200;

/// `text` cut to `max` bytes on a character boundary, marked when cut.
fn cut(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max.saturating_sub(3);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

fn first_line(text: &str) -> String {
    cut(text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim(), LINE)
}

/// The summary, or an empty string when the task has nothing to tell.
pub(super) fn build(db: &Connection, task: &SharedTask) -> Result<String> {
    let mut parts = Vec::new();
    if let Some(result) = &task.result {
        if let Some(summary) = result["summary"].as_str().filter(|s| !s.trim().is_empty()) {
            let by = result["reportedBy"]["name"].as_str().unwrap_or("someone");
            parts.push(format!("**Latest result** ({by}, {}):\n{}", result["reportedAt"].as_str().unwrap_or("unknown time"), cut(summary.trim(), RESULT)));
        }
    }
    let mut comments = db.prepare(
        "SELECT json_extract(data,'$.actor.name'), json_extract(data,'$.body'), json_extract(data,'$.at') FROM collaboration_task_activity
         WHERE task_id=?1 AND json_extract(data,'$.kind')='comment' ORDER BY seq DESC LIMIT ?2")?;
    let newest: Vec<String> = comments
        .query_map(params![task.id, COMMENTS], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?)))?
        .map(|row| row.map(|(who, body, at)| format!("- {} ({}): {}", who.unwrap_or_default(), at.unwrap_or_default(), first_line(&body.unwrap_or_default()))))
        .collect::<rusqlite::Result<_>>()?;
    if !newest.is_empty() {
        parts.push(format!("**Newest comments**:\n{}", newest.join("\n")));
    }
    let mut prs = db.prepare(
        "SELECT o.id, o.number, json_extract(r.data,'$.fullName'), json_extract(o.data,'$.snapshot.state'),
                json_extract(o.data,'$.snapshot.headSha'), json_extract(o.data,'$.snapshot.ci.state'), json_extract(o.data,'$.syncedAt')
         FROM github_task_links l JOIN github_objects o ON o.id=l.object_id JOIN github_repositories r ON r.id=o.repo_id
         WHERE l.task_id=?1 AND o.kind='pull' ORDER BY o.repo_id, o.number LIMIT 10")?;
    let rows = prs.query_map([&task.id], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?,
        r.get::<_, Option<String>>(4)?, r.get::<_, Option<String>>(5)?, r.get::<_, Option<String>>(6)?)))?;
    for row in rows {
        let (link, number, repo, state, head, ci, synced) = row?;
        let head = head.map(|h| h.chars().take(12).collect::<String>()).unwrap_or_else(|| "unknown".into());
        let mut line = format!("**{} #{number}**: {}, head {head}, CI {}, as last observed {}",
            repo.unwrap_or_default(), state.unwrap_or_else(|| "unknown".into()), ci.unwrap_or_else(|| "unknown".into()),
            synced.unwrap_or_else(|| "at an unknown time".into()));
        // The latest completed review of this PR for this task, and what it found at P0–P2.
        let review: Option<String> = db.query_row(
            "SELECT data FROM pr_reviews WHERE task_id=?1 AND link_id=?2 AND status='completed' ORDER BY rowid DESC LIMIT 1",
            params![task.id, link], |r| r.get(0)).ok();
        if let Some(review) = review.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) {
            let blocking: Vec<&Value> = review["findings"].as_array().into_iter().flatten()
                .filter(|f| f["priority"].as_i64().is_some_and(|p| p <= 2)).collect();
            line.push_str(&format!("; latest review {} at {}: {}", review["id"].as_str().unwrap_or("?"),
                review["headSha"].as_str().map(|h| h.chars().take(12).collect::<String>()).unwrap_or_default(),
                review["conclusion"].as_str().unwrap_or("unknown")));
            for finding in blocking.iter().take(FINDINGS) {
                line.push_str(&format!("\n- P{} {} ({})", finding["priority"], first_line(finding["title"].as_str().unwrap_or("")),
                    finding["path"].as_str().unwrap_or("")));
            }
            if blocking.len() > FINDINGS {
                line.push_str(&format!("\n- and {} more", blocking.len() - FINDINGS));
            }
        }
        parts.push(line);
    }
    Ok(cut(&parts.join("\n\n"), LIMIT))
}
