//! The user's Home presentation preference (T-175): how they like Agents to
//! present results on Home. One per Workspace, kept by Core beside the Home
//! order, so it survives a restart and is the same on every device that opens
//! this Workspace; nothing copies it to another Workspace. Only the user sets
//! it, from Settings (GET/PUT /api/home/presentation); no Agent tool does.
//!
//! An Agent that may write a Project's Home content gets `for_agents` as
//! `homePreference`, beside `homeHint` (see `HomeAdvice`), each time it reads
//! the Brief, submits or receives a task result, or publishes a result. A
//! change reaches running sessions with their next such read; nothing is put
//! in a system prompt. It shapes presentation only and grants nothing.
use super::*;
use serde::{Deserialize, Serialize};

const KEY: &str = "home.presentation";
/// The note, in characters, after its whitespace is collapsed.
pub(crate) const MAX_NOTE: usize = 300;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Style {
    /// No preference: the general rule, a form chosen by the information.
    #[default]
    Default,
    /// A visual summary first where the information suits it; long
    /// explanations after it.
    Visual,
}

/// What the user chose; as the API takes and returns it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Presentation {
    #[serde(default)]
    pub style: Style,
    /// The user's own words, added after the style.
    #[serde(default)]
    pub note: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    style: Style,
    note: String,
    updated_at: String,
}

impl Presentation {
    fn is_default(&self) -> bool {
        self.style == Style::Default && self.note.is_empty()
    }
}

/// What an Agent is given: the preference, labelled as the user's, with what
/// it never outweighs. None without one.
pub(crate) fn agent_text(presentation: &Presentation) -> Option<String> {
    if presentation.is_default() {
        return None;
    }
    let mut text = String::from("The user's Home presentation preference, which the user set for this Workspace:");
    if presentation.style == Style::Visual {
        text.push_str(" lead with a visual summary where the information suits it (a chart of measured values, a real screenshot or a labelled sketch), and put long explanations after it.");
    }
    if !presentation.note.is_empty() {
        text.push_str(&format!(" In the user's words: \"{}\"", presentation.note));
    }
    text.push_str(" It shapes presentation only: exact figures, stated limits and risks, accessibility and the user's current instructions come first, and it changes no permission or Ask.");
    Some(text)
}

fn stored(db: &Connection) -> Result<Option<Stored>> {
    let raw: Option<String> = db
        .query_row("SELECT value FROM workspace_meta WHERE key=?1", [KEY], |r| r.get(0))
        .optional()?;
    Ok(raw.and_then(|raw| match serde_json::from_str(&raw) {
        Ok(stored) => Some(stored),
        Err(error) => {
            // Unreadable: no preference, as if the user had not set one.
            eprintln!("Home presentation preference unreadable: {error}");
            None
        }
    }))
}

/// The text for Agents (`agent_text`) of what the user saved.
pub(crate) fn for_agents(db: &Connection) -> Result<Option<String>> {
    Ok(stored(db)?.and_then(|s| agent_text(&Presentation { style: s.style, note: s.note })))
}

/// The preference as Settings shows it, with exactly what Agents are given.
pub(super) fn view(db: &Connection) -> Result<Value> {
    let saved = stored(db)?;
    let (presentation, updated_at) = match saved {
        Some(s) => (Presentation { style: s.style, note: s.note }, Some(s.updated_at)),
        None => (Presentation::default(), None),
    };
    Ok(json!({"style":presentation.style,"note":presentation.note,"updatedAt":updated_at,
        "scope":"workspace","agentText":agent_text(&presentation)}))
}

/// Saves what the user chose; the default (no style, no note) removes it,
/// which restores the general rule.
pub(super) fn save(store: &Store, input: Presentation) -> Result<Value> {
    let note = input.note.split_whitespace().collect::<Vec<_>>().join(" ");
    ensure!(note.chars().count() <= MAX_NOTE, "invalid_input: the note has {} characters; the limit is {MAX_NOTE}", note.chars().count());
    let presentation = Presentation { style: input.style, note };
    {
        let db = store.db.write()?;
        if presentation.is_default() {
            db.execute("DELETE FROM workspace_meta WHERE key=?1", [KEY])?;
        } else {
            let stored = Stored { style: presentation.style, note: presentation.note, updated_at: now() };
            db.execute(
                "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![KEY, serde_json::to_string(&stored)?],
            )?;
        }
    }
    view(&*store.db.read()?)
}
