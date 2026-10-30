//! `task_list` with `compact: true` (T-201): short rows to find work by, the
//! whole task from `task_get`. A row is read without the task's description,
//! result and dispatch, and its GitHub links are counted, not loaded: what a
//! row leaves out is never built, rather than removed from a built row.
//! Filters, counts and paging are task_list's own; only the rows differ.
use super::TaskActor;
use serde::Deserialize;
use serde_json::{json, Value};

/// The most of a row's progress or blocker it shows.
const SUMMARY: usize = 200;
/// What compact rows leave out, and where to read it (in the response).
pub(super) const NOTE: &str = "Compact rows leave out description, result, dispatch and GitHub snapshots \
    (githubLinks counts the links); progress and blocker show their first 200 characters. \
    task_get reads one task whole.";

/// What a compact row is made of. Serde skips every other field of the stored
/// task while it reads it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Row {
    pub id: String,
    pub seq: i64,
    pub title: String,
    pub status: String,
    #[serde(default)]
    pub assignee: Option<TaskActor>,
    pub progress: String,
    pub blocker: String,
    #[serde(default)]
    pub archived_at: Option<String>,
    pub version: i64,
    pub updated_at: String,
}

/// `text`, or its first SUMMARY characters and how many more there are.
fn summary(text: &str) -> Value {
    match text.char_indices().nth(SUMMARY) {
        None => json!(text),
        Some((cut, _)) => json!(format!("{}… [{} more characters: task_get]", &text[..cut], text[cut..].chars().count())),
    }
}

impl Row {
    /// What a Live Reference to the task shows (T-9): its title, status,
    /// assignee, last update and whether it is archived, nothing else.
    pub(super) fn live(&self) -> Value {
        json!({"title":self.title,"status":self.status,"assignee":self.assignee,"updatedAt":self.updated_at,
            "archived":self.archived_at.is_some()})
    }

    pub(super) fn value(&self) -> Value {
        json!({"id":self.id,"seq":self.seq,"title":self.title,"status":self.status,"version":self.version,
            "assignee":self.assignee,"updatedAt":self.updated_at,"progress":summary(&self.progress),
            "blocker":summary(&self.blocker),"archivedAt":self.archived_at})
    }
}

#[cfg(test)]
#[path = "compact_tests.rs"]
mod tests;
