//! The user's notes on an ask (YN-213, Home's "Wait, what?"): words, images
//! and files sent to the ask's Agent without answering it. A note is kept
//! apart from the ask's reply (reply_text, reply_form and the rest on the
//! section's row): it never marks the ask replied, never chooses one of its
//! options or answers its form, and the ask stays where it was, open in
//! Needs you at the version the note was written on. Home lists an ask's
//! notes with it; the message the note sent is the Agent's record.
use super::*;
use std::collections::HashMap;

/// At most this many of an ask's notes on Home, newest first. Each is one
/// message the user sent; an ask the user keeps writing notes on would
/// otherwise list them all on its card. The messages keep every one.
pub(super) const NOTES_SHOWN: usize = 5;

/// The longest note text Home shows, in characters, as the reply it would
/// have been is kept (home.rs, mark_replied_form's 2000). The message sent
/// has the whole text.
const NOTE_CHARS: usize = 2000;

/// The notes, by the message each sent: the Agent it went to and the
/// message's client ID (as a receipt is found), so a retry of that message
/// keeps one note. `identity` is the ask's identity on Home and `version`
/// the version the note was written on.
pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_brief_ask_notes(
        agent_id TEXT NOT NULL, client_message_id TEXT NOT NULL, project_id TEXT NOT NULL, key TEXT NOT NULL,
        identity INTEGER NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL, images TEXT, files TEXT, at TEXT NOT NULL,
        PRIMARY KEY(agent_id,client_message_id));
        CREATE INDEX IF NOT EXISTS project_brief_ask_notes_section ON project_brief_ask_notes(project_id,identity,at);",
    )?;
    Ok(())
}

/// A note that reached its Agent.
pub(super) struct Note<'a> {
    pub agent: &'a str,
    pub client_message_id: &'a str,
    pub project: &'a str,
    pub key: &'a str,
    pub identity: i64,
    pub version: i64,
    pub text: &'a str,
    pub images: &'a [String],
    pub files: &'a [crate::input_files::FileRef],
}

/// Keeps a delivered note once: the same message again (a retry under its
/// client ID) keeps the note it already kept. True when this kept it.
pub(super) fn record(store: &Store, note: &Note) -> Result<bool> {
    let text: String = note.text.trim().chars().take(NOTE_CHARS).collect();
    let images = (!note.images.is_empty()).then(|| json!(note.images).to_string());
    let files = (!note.files.is_empty()).then(|| json!(note.files).to_string());
    let changed = store.db.write()?.execute(
        "INSERT OR IGNORE INTO project_brief_ask_notes(agent_id,client_message_id,project_id,key,identity,version,text,images,files,at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![note.agent, note.client_message_id, note.project, note.key, note.identity, note.version, text, images, files, now()],
    )?;
    Ok(changed == 1)
}

/// Each ask's notes in `project`, by its identity on Home: newest first, at
/// most NOTES_SHOWN each, as Home shows them ({version, at, text, agentId,
/// images?, files?}).
pub(super) fn of_project(db: &Connection, project: &str) -> Result<HashMap<i64, Vec<Value>>> {
    let mut query = db.prepare_cached(
        "SELECT identity,version,at,text,agent_id,images,files FROM project_brief_ask_notes WHERE project_id=?1
         ORDER BY identity, at DESC, rowid DESC",
    )?;
    let rows = query.query_map([project], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?, r.get::<_, Option<String>>(6)?))
    })?;
    let mut notes: HashMap<i64, Vec<Value>> = HashMap::new();
    for row in rows {
        let (identity, version, at, text, agent, images, files) = row?;
        let shown = notes.entry(identity).or_default();
        if shown.len() == NOTES_SHOWN {
            continue;
        }
        let mut note = json!({"version":version,"at":at,"text":text,"agentId":agent});
        // As kept by record; a value Core cannot read shows none.
        if let Some(images) = images.and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok()).filter(|i| !i.is_empty()) {
            note["images"] = json!(images);
        }
        if let Some(files) = files.and_then(|raw| serde_json::from_str::<Vec<crate::input_files::FileRef>>(&raw).ok()).filter(|f| !f.is_empty()) {
            note["files"] = json!(files);
        }
        shown.push(note);
    }
    Ok(notes)
}

/// The notes of asks that no row keeps any longer: they go once history
/// expired the ask they were written on (sections::expire_history).
pub(super) fn expire(db: &Connection) -> Result<()> {
    db.execute(
        "DELETE FROM project_brief_ask_notes WHERE NOT EXISTS(SELECT 1 FROM project_brief_sections s
         WHERE s.seq=project_brief_ask_notes.identity OR s.lineage=project_brief_ask_notes.identity)",
        [],
    )?;
    Ok(())
}
