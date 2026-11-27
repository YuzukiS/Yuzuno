//! Stored sections, as Agents and Home read them, and the user's own marks
//! on them (seen, opened, deferred, replied). Those marks are the user's
//! state: they never change a section's or the Brief's version.
use super::*;
use chrono::{DateTime, Utc};
use std::collections::HashMap;

// Who wrote a row's version (YN-212 C1): its author, recorded with the
// version it wrote (author_version); a row an older Core wrote, or edited in
// place since (a new version, the author left as it was), is its owner's.
const COLUMNS: &str = "seq,project_id,key,live,kind,version,owner_id,owner_name,data,ask_state,ask_since,\
replied_at,reply_text,deferred_until,updated_at,updated_turn_id,history_reason,history_at,COALESCE(lineage,seq),task_id,reply_images,reply_files,\
CASE WHEN author_version IS version AND author_id IS NOT NULL THEN author_id ELSE owner_id END,CASE WHEN author_version IS version AND author_id IS NOT NULL THEN author_name ELSE owner_name END";

#[derive(Clone, Debug)]
pub(super) struct Row {
    pub seq: i64,
    pub project_id: String,
    pub key: String,
    pub live: bool,
    pub kind: String,
    pub version: i64,
    pub owner_id: String,
    pub owner_name: String,
    /// {title, body, ask?, status?, time?, attachments}, as validated.
    pub data: Value,
    pub ask_state: Option<String>,
    pub ask_since: Option<String>,
    pub replied_at: Option<String>,
    pub reply_text: Option<String>,
    pub deferred_until: Option<String>,
    pub updated_at: String,
    pub updated_turn_id: Option<String>,
    /// Why a section is history: seen, removed, resolved, archived,
    /// refreshed (a past issue of a card that refreshes itself, YN-113), or
    /// revised (an earlier version of a task's card, YN-212 C2).
    pub history_reason: Option<String>,
    /// When it became history.
    pub history_at: Option<String>,
    /// The section's identity on Home: the row's own seq, or the seq of the
    /// report it continues (see update.rs, put after a Seen).
    pub identity: i64,
    /// The task this section is the card of, by its own `task` (YN-86 S2a):
    /// its internal ID. See cards.rs for the bindings read from elsewhere.
    pub task_id: Option<String>,
    /// The images the user's reply to this version of an ask carried
    /// (YN-134), by ID; none for any other section or reply.
    pub reply_images: Vec<String>,
    /// The files the user's reply to this version of an ask carried
    /// (YN-145); none for any other section or reply.
    pub reply_files: Vec<crate::input_files::FileRef>,
    /// Who wrote this version's content (YN-212 C1): its owner, or a lead or
    /// the one who answers for the task writing a task's card it does not own.
    /// A row an older Core wrote names its owner.
    pub author_id: String,
    pub author_name: String,
}

impl Row {
    /// An ask its owner has not resolved: it counts against the owner's
    /// limit and leaves the Brief only by `resolve`.
    pub fn unresolved_ask(&self) -> bool {
        self.kind == "ask" && self.ask_state.as_deref() != Some("resolved")
    }
    /// An ask the user has answered and its owner has not resolved yet: it
    /// is out of Needs you and waits for its owner to act on the answer.
    pub fn replied_ask(&self) -> bool {
        self.kind == "ask" && self.ask_state.as_deref() == Some("replied")
    }
}

fn read(db: &Connection, condition: &str, values: impl rusqlite::Params) -> Result<Vec<Row>> {
    read_columns(db, COLUMNS, condition, values)
}

/// A section's data without its body and attachments: what an index needs.
/// SQLite extracts these, so a large body is never read into Core.
const INDEX_COLUMNS: &str = "seq,project_id,key,live,kind,version,owner_id,owner_name,\
json_object('title',data->>'$.title','status',data->'$.status','time',data->'$.time'),ask_state,ask_since,\
replied_at,reply_text,deferred_until,updated_at,updated_turn_id,history_reason,history_at,COALESCE(lineage,seq),task_id,reply_images,reply_files,\
CASE WHEN author_version IS version AND author_id IS NOT NULL THEN author_id ELSE owner_id END,CASE WHEN author_version IS version AND author_id IS NOT NULL THEN author_name ELSE owner_name END";

fn read_columns(db: &Connection, columns: &str, condition: &str, values: impl rusqlite::Params) -> Result<Vec<Row>> {
    let mut query = db.prepare(&format!("SELECT {columns} FROM project_brief_sections WHERE {condition}"))?;
    let rows = query.query_map(values, |r| {
        Ok((
            Row {
                seq: r.get(0)?,
                project_id: r.get(1)?,
                key: r.get(2)?,
                live: r.get(3)?,
                kind: r.get(4)?,
                version: r.get(5)?,
                owner_id: r.get(6)?,
                owner_name: r.get(7)?,
                data: Value::Null,
                ask_state: r.get(9)?,
                ask_since: r.get(10)?,
                replied_at: r.get(11)?,
                reply_text: r.get(12)?,
                deferred_until: r.get(13)?,
                updated_at: r.get(14)?,
                updated_turn_id: r.get(15)?,
                history_reason: r.get(16)?,
                history_at: r.get(17)?,
                identity: r.get(18)?,
                task_id: r.get(19)?,
                // As kept by mark_replied_form; a value Core cannot read shows none.
                reply_images: r.get::<_, Option<String>>(20)?.and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default(),
                reply_files: r.get::<_, Option<String>>(21)?.and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default(),
                author_id: r.get(22)?,
                author_name: r.get(23)?,
            },
            r.get::<_, String>(8)?,
        ))
    })?;
    rows.map(|row| {
        let (mut row, data) = row?;
        row.data = serde_json::from_str(&data)?;
        Ok(row)
    })
    .collect()
}

pub(super) fn history_cutoff() -> String {
    (Utc::now() - chrono::Duration::days(HISTORY_DAYS)).to_rfc3339()
}

/// The live Brief, in the order its sections first appeared: a section that
/// changes keeps its place.
pub(super) fn live(db: &Connection, project: &str) -> Result<Vec<Row>> {
    read(db, "project_id=?1 AND live=1 ORDER BY seq", [project])
}

/// The live sections without their bodies (see INDEX_COLUMNS).
pub(super) fn live_index(db: &Connection, project: &str) -> Result<Vec<Row>> {
    read_columns(db, INDEX_COLUMNS, "project_id=?1 AND live=1 ORDER BY seq", [project])
}

/// The live sections with these keys, in full.
pub(super) fn live_keys(db: &Connection, project: &str, keys: &[String]) -> Result<Vec<Row>> {
    read(db, "project_id=?1 AND live=1 AND key IN (SELECT value FROM json_each(?2)) ORDER BY seq",
        params![project, serde_json::to_string(keys)?])
}

pub(super) fn live_key(db: &Connection, project: &str, key: &str) -> Result<Option<Row>> {
    Ok(read(db, "project_id=?1 AND key=?2 AND live=1", params![project, key])?.pop())
}

/// The live sections bound to `task` (internal ID) by their own `task`,
/// and the sub-topics with none of their own under a live section that is
/// (YN-86 S2a): what its end archives (cards::task_closed).
pub(super) fn bound_to(db: &Connection, task: &str) -> Result<Vec<Row>> {
    read(
        db,
        "live=1 AND (task_id=?1 OR (task_id IS NULL AND instr(key,'/')>0 AND EXISTS(
            SELECT 1 FROM project_brief_sections p WHERE p.project_id=project_brief_sections.project_id
            AND p.key=substr(project_brief_sections.key,1,instr(project_brief_sections.key,'/')-1) AND p.live=1 AND p.task_id=?1)))
         ORDER BY seq",
        [task],
    )
}

/// Seen reports, removed and resolved sections of the last 30 days, newest
/// first: Home's history. Not a card's past issues (`refreshed`, YN-113 §3.4):
/// a card refreshed every 2 hours would put 360 of them here in 30 days; they
/// are read by the card's identity (`of_identity`). Nor a task's card's
/// earlier versions (`revised`, YN-212 C2), which its card lists (`revisions`).
pub(super) fn history(db: &Connection, project: &str) -> Result<Vec<Row>> {
    read(db, &format!("{HISTORY} ORDER BY history_at DESC, seq DESC"), params![project, history_cutoff()])
}

/// Home's history condition (`history`), for the queries that read the same
/// entries another way.
const HISTORY: &str = "project_id=?1 AND live=0 AND history_at>=?2 AND COALESCE(history_reason,'') NOT IN ('refreshed','revised')";

/// A history entry's data without its body and attachments, with how many
/// attachments it has (`attachmentCount`) (YN-221 S1): SQLite takes them out,
/// so no body is read into Core.
const HISTORY_INDEX_COLUMNS: &str = "seq,project_id,key,live,kind,version,owner_id,owner_name,\
json_set(json_remove(data,'$.body','$.attachments'),'$.attachmentCount',COALESCE(json_array_length(data,'$.attachments'),0)),\
ask_state,ask_since,replied_at,reply_text,deferred_until,updated_at,updated_turn_id,history_reason,history_at,COALESCE(lineage,seq),task_id,reply_images,reply_files,\
CASE WHEN author_version IS version AND author_id IS NOT NULL THEN author_id ELSE owner_id END,CASE WHEN author_version IS version AND author_id IS NOT NULL THEN author_name ELSE owner_name END";

/// Home's history (`history`) without the entries' bodies and attachments
/// (HISTORY_INDEX_COLUMNS): the same entries in the same order.
pub(super) fn history_index(db: &Connection, project: &str) -> Result<Vec<Row>> {
    read_columns(db, HISTORY_INDEX_COLUMNS, &format!("{HISTORY} ORDER BY history_at DESC, seq DESC"), params![project, history_cutoff()])
}

/// The entries of Home's history (`history`) with these identities and
/// versions, in full and in its order. A pair that is no entry of it (live,
/// expired, a past issue, an earlier version of a card, another Project's)
/// is not among them.
pub(super) fn history_entries(db: &Connection, project: &str, wanted: &[(i64, i64)]) -> Result<Vec<Row>> {
    read(
        db,
        &format!("{HISTORY} AND EXISTS(SELECT 1 FROM json_each(?3) w
                  WHERE json_extract(w.value,'$[0]')=COALESCE(lineage,seq) AND json_extract(w.value,'$[1]')=version)
                  ORDER BY history_at DESC, seq DESC"),
        params![project, history_cutoff(), serde_json::to_string(wanted)?],
    )
}

/// The identity of each entry of Home's history, in its order, by seq.
pub(super) fn history_order(db: &Connection, project: &str) -> Result<Vec<(i64, i64)>> {
    let mut query = db.prepare(&format!("SELECT seq,COALESCE(lineage,seq) FROM project_brief_sections WHERE {HISTORY} ORDER BY history_at DESC, seq DESC"))?;
    let rows = query.query_map(params![project, history_cutoff()], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The identities of the live sections.
pub(super) fn live_identities(db: &Connection, project: &str) -> Result<std::collections::HashSet<i64>> {
    let mut query = db.prepare_cached("SELECT COALESCE(lineage,seq) FROM project_brief_sections WHERE project_id=?1 AND live=1")?;
    let rows = query.query_map([project], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The live open asks, in the live Brief's order, with only their title and
/// gate of their data (`{title, ask: {gate}}`): what Needs you shows of them.
pub(super) fn open_asks(db: &Connection, project: &str) -> Result<Vec<Row>> {
    let columns = COLUMNS.replacen(",data,", ",json_object('title',data->'$.title','ask',json_object('gate',data->'$.ask.gate')),", 1);
    read_columns(db, &columns, "project_id=?1 AND live=1 AND kind='ask' AND ask_state='open' ORDER BY seq", [project])
}

/// The body of the section row `seq`.
pub(super) fn body_of(db: &Connection, seq: i64) -> Result<Value> {
    let raw: Option<String> = db.query_row("SELECT data->'$.body' FROM project_brief_sections WHERE seq=?1", [seq], |r| r.get(0))?;
    Ok(match raw {
        Some(raw) => serde_json::from_str(&raw)?,
        None => Value::Null,
    })
}

/// At most this many of a card's earlier versions in its `revisions`: each
/// write of a task's card keeps the one it replaces for 30 days, and a status
/// written every hour would list 720. The rest stay readable by version.
pub(super) const REVISIONS_SHOWN: usize = 20;

/// The earlier versions of the task's card with this identity on Home that
/// history keeps (YN-212 C2), newest first, at most REVISIONS_SHOWN: each
/// one's version, who wrote it and when.
pub(super) fn revisions(db: &Connection, project: &str, identity: i64) -> Result<Vec<Value>> {
    let mut query = db.prepare_cached(
        "SELECT version,CASE WHEN author_version IS version AND author_id IS NOT NULL THEN author_id ELSE owner_id END,
                CASE WHEN author_version IS version AND author_id IS NOT NULL THEN author_name ELSE owner_name END,updated_at
         FROM project_brief_sections
         WHERE project_id=?1 AND COALESCE(lineage,seq)=?2 AND live=0 AND history_reason='revised' AND history_at>=?3
         ORDER BY version DESC LIMIT ?4",
    )?;
    let rows = query.query_map(params![project, identity, history_cutoff(), REVISIONS_SHOWN as i64], |r| {
        Ok(json!({"version":r.get::<_, i64>(0)?,"author":{"agentId":r.get::<_, String>(1)?,"name":r.get::<_, String>(2)?},
            "at":r.get::<_, String>(3)?}))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Every version of the section with this identity on Home that is live or
/// that history still keeps, newest first (YN-113 §3.4, a card's issues).
pub(super) fn of_identity(db: &Connection, project: &str, identity: i64) -> Result<Vec<Row>> {
    read(
        db,
        "project_id=?1 AND COALESCE(lineage,seq)=?2 AND (live=1 OR history_at>=?3) ORDER BY version DESC, seq DESC",
        params![project, identity, history_cutoff()],
    )
}

/// At most this many entries in brief_get's you.recentlyLeft (YN-7).
pub(super) const RECENTLY_LEFT: usize = 20;

/// `owner`'s sections that left the live Brief within history's days and
/// are not live again, newest first, without their bodies: the history
/// rows that are their key's newest row. A key written again since, or
/// last left under another owner, is not among them (YN-7).
pub(super) fn recently_left(db: &Connection, project: &str, owner: &str) -> Result<Vec<Row>> {
    read_columns(
        db,
        INDEX_COLUMNS,
        "project_id=?1 AND live=0 AND history_at>=?2 AND owner_id=?3
         AND seq=(SELECT MAX(t.seq) FROM project_brief_sections t
                  WHERE t.project_id=project_brief_sections.project_id AND t.key=project_brief_sections.key)
         ORDER BY history_at DESC, seq DESC",
        params![project, history_cutoff(), owner],
    )
}

/// One entry of you.recentlyLeft: which section left, as which version,
/// why and when. seen: the user marked that version seen; removed: its
/// owner removed it; resolved: its owner resolved the ask.
pub(super) fn left_json(row: &Row) -> Value {
    json!({"key":row.key,"kind":row.kind,"title":row.data["title"],"version":row.version,
        "reason":row.history_reason,"at":row.history_at})
}

/// A section as Home shows it: the live one with this key, else its latest
/// history entry; or exactly `version` of it.
pub(super) fn find(db: &Connection, project: &str, key: &str, version: Option<i64>) -> Result<Option<Row>> {
    let kept = "(live=1 OR history_at>=?3)";
    Ok(match version {
        Some(version) => read(
            db,
            &format!("project_id=?1 AND key=?2 AND {kept} AND version=?4 ORDER BY live DESC, seq DESC LIMIT 1"),
            params![project, key, history_cutoff(), version],
        )?,
        None => read(
            db,
            &format!("project_id=?1 AND key=?2 AND {kept} ORDER BY live DESC, seq DESC LIMIT 1"),
            params![project, key, history_cutoff()],
        )?,
    }
    .pop())
}

/// The section with this identity on Home (`Row::identity`): the live one,
/// else its newest entry history still keeps.
pub(super) fn by_identity(db: &Connection, project: &str, identity: i64) -> Result<Option<Row>> {
    Ok(read(
        db,
        "project_id=?1 AND COALESCE(lineage,seq)=?2 AND (live=1 OR history_at>=?3) ORDER BY live DESC, seq DESC LIMIT 1",
        params![project, identity, history_cutoff()],
    )?
    .pop())
}

/// The section under `key` bound to `task` (internal ID) by its own `task`
/// (YN-212 C3): the live one, else its newest entry history still keeps.
pub(super) fn bound_key(db: &Connection, project: &str, key: &str, task: &str) -> Result<Option<Row>> {
    Ok(read(
        db,
        "project_id=?1 AND key=?2 AND task_id=?3 AND (live=1 OR history_at>=?4) ORDER BY live DESC, seq DESC LIMIT 1",
        params![project, key, task, history_cutoff()],
    )?
    .pop())
}

/// The Brief's version: how many accepted updates changed it (0 before any).
pub(super) fn brief_version(db: &Connection, project: &str) -> Result<i64> {
    Ok(db
        .query_row("SELECT version FROM project_briefs WHERE project_id=?1", [project], |r| r.get(0))
        .optional()?
        .unwrap_or(0))
}

/// Per key, the version the user explicitly marked seen and when.
pub(super) fn seen(db: &Connection, project: &str) -> Result<HashMap<String, (i64, String)>> {
    let mut query = db.prepare("SELECT key,version,at FROM project_brief_seen WHERE project_id=?1")?;
    let rows = query.query_map([project], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
    rows.map(|row| Ok(row?)).collect()
}

/// Per section identity on Home, the newest version the user's browser showed
/// whole while it was live, and when (YN-86). Never a Seen mark.
pub(super) fn opened(db: &Connection, project: &str) -> Result<HashMap<i64, (i64, String)>> {
    let mut query = db.prepare("SELECT section_id,version,at FROM project_brief_opened WHERE project_id=?1")?;
    let rows = query.query_map([project], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
    rows.map(|row| Ok(row?)).collect()
}

/// The newest version of `row` the user has read: marked seen (by key) or
/// opened whole (by identity), whichever is later (YN-86).
pub(super) fn read_version(row: &Row, seen: &HashMap<String, (i64, String)>, opened: &HashMap<i64, (i64, String)>) -> Option<i64> {
    let seen = seen.get(&row.key).map(|(version, _)| *version);
    let opened = opened.get(&row.identity).map(|(version, _)| *version);
    seen.max(opened)
}

/// Sections changed since the user last read them (read_version).
pub(super) fn unseen(rows: &[Row], seen: &HashMap<String, (i64, String)>, opened: &HashMap<i64, (i64, String)>) -> usize {
    rows.iter().filter(|row| read_version(row, seen, opened).is_none_or(|version| version < row.version)).count()
}

/// What a browser sends once it has shown a live report whole (YN-86): the
/// Workspace whose Home showed it, the section's identity and key there, and
/// the version it showed.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Opened {
    pub workspace_id: String,
    pub section_id: i64,
    pub key: String,
    pub version: i64,
}

/// Records that the user's browser showed exactly `opened.version` of a live
/// report (YN-86). Only that very section and version is recorded: another
/// Workspace's, a key written anew since, an older or a newer version, or a
/// section that is no longer a live report records nothing, and is never
/// recorded as the version that is live. The same version again changes
/// nothing. It changes no section, version, Seen mark, ask, task or the
/// Brief's version, and puts nothing into history, but for a report whose
/// card's task has ended (YN-86 S2a): that one goes into history as
/// archived, and the answer says `archived: true`. `recorded` says whether
/// this call recorded a newer version.
pub(super) fn mark_opened(store: &Store, project: &str, opened: &Opened) -> Result<Value> {
    // Read before the writer is held: it reads the database itself.
    let workspace = store.workspace_id()?;
    ensure!(
        opened.workspace_id == workspace,
        "workspace_changed: this report was shown on another Workspace's Home. Nothing was recorded."
    );
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    ensure_project(&tx, project)?;
    let row = live_key(&tx, project, &opened.key)?
        .context("section_not_found: no live section has this key now. Nothing was recorded.")?;
    ensure!(
        row.identity == opened.section_id,
        "section_changed: the section under this key is another one now. Nothing was recorded."
    );
    ensure!(row.kind == "report", "not_report: only a report is recorded as opened. Nothing was recorded.");
    ensure!(
        row.version == opened.version,
        "version_changed: version {} is live, not version {}. Nothing was recorded.",
        row.version,
        opened.version
    );
    let changed = tx.execute(
        "INSERT INTO project_brief_opened(project_id,section_id,key,version,at) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(project_id,section_id) DO UPDATE SET key=excluded.key,version=excluded.version,at=excluded.at
         WHERE excluded.version>project_brief_opened.version",
        params![project, row.identity, row.key, row.version, now()],
    )?;
    let (version, at): (i64, String) = tx.query_row(
        "SELECT version,at FROM project_brief_opened WHERE project_id=?1 AND section_id=?2",
        params![project, row.identity],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    // A report its task's end left for the user to read (YN-86 S2a): read
    // now, it goes into history as that end archived the rest of its card.
    let ended = match super::cards::explicit(&tx, &row)? {
        Some(task) => super::cards::task_ended(&tx, &task)?,
        None => false,
    };
    if ended {
        super::cards::archive(&tx, &row, &now())?;
    }
    tx.commit()?;
    let mut answer = json!({"projectId":project,"sectionId":row.identity,"key":row.key,"version":version,"at":at,"recorded":changed == 1});
    if ended {
        answer["archived"] = json!(true);
    }
    Ok(answer)
}

/// A section's owner as it is now; the name from when it last wrote if the
/// Agent is gone. Closed, deleted and moved (no longer in the section's
/// Project) owners have left: another Agent of the Project may claim their
/// sections. A moved owner moved back before that owns them again.
#[derive(Clone)]
pub(super) struct Owner {
    pub state: &'static str,
    pub name: String,
}

impl Owner {
    pub fn orphaned(&self) -> bool {
        self.state != "active"
    }
}

/// An Agent as owner checks see it: closed, name and Project.
pub(super) struct OwnerAgent<'a> {
    pub closed: bool,
    pub name: &'a str,
    pub project: Option<&'a str>,
}

/// Owners looked up once per call, through the caller's connection.
#[derive(Default)]
pub(super) struct Owners(HashMap<String, Option<(bool, String, Option<String>)>>);

impl Owners {
    pub fn get(&mut self, store: &Store, db: &Connection, row: &Row) -> Result<Owner> {
        if !self.0.contains_key(&row.owner_id) {
            let found = match store.brief_in(db, &row.owner_id)? {
                Some(brief) => Some((
                    brief.agent.closed_at.is_some(),
                    brief.agent.name,
                    crate::projects::agent_project(db, &row.owner_id)?,
                )),
                None => None,
            };
            self.0.insert(row.owner_id.clone(), found);
        }
        let found = self.0[&row.owner_id].as_ref();
        Ok(owner(found.map(|(closed, name, project)| OwnerAgent { closed: *closed, name, project: project.as_deref() }), row))
    }
}

/// The owner's state; `agent` is None if it no longer exists.
pub(super) fn owner(agent: Option<OwnerAgent>, row: &Row) -> Owner {
    let Some(agent) = agent else { return Owner { state: "deleted", name: row.owner_name.clone() } };
    let state = if agent.closed {
        "closed"
    } else if agent.project != Some(row.project_id.as_str()) {
        "moved"
    } else {
        "active"
    };
    Owner { state, name: agent.name.into() }
}

/// What Home and Agents see of an attachment. A reference shows the path it
/// names; a snapshot's origin and file name stay Core's. Only a snapshot has
/// a width and height: Core read them from the bytes it keeps (T-19 HM:B14).
fn public_attachment(stored: &Value) -> Value {
    let mut shown = json!({});
    for field in ["name", "kind", "mime", "size", "snapshot", "mayChange", "takenAt", "caption", "url", "path", "width", "height"] {
        if field == "path" && stored["snapshot"] == true {
            continue;
        }
        if matches!(field, "width" | "height") && stored["snapshot"] != true {
            continue;
        }
        if let Some(value) = stored.get(field).filter(|value| !value.is_null()) {
            shown[field] = value.clone();
        }
    }
    shown
}

pub(super) fn stale(status: &Value, now: DateTime<Utc>) -> bool {
    let as_of = status["asOf"].as_str().and_then(|at| DateTime::parse_from_rfc3339(at).ok());
    match (as_of, status["validFor"].as_i64()) {
        (Some(as_of), Some(valid)) => as_of.with_timezone(&Utc) + chrono::Duration::seconds(valid) < now,
        _ => true,
    }
}

/// One section in brief_get's index: what it is and its state, no body.
pub(super) fn index_json(row: &Row, owner: &Owner, seen: Option<&(i64, String)>, now: DateTime<Utc>) -> Value {
    let mut entry = json!({"key":row.key,"kind":row.kind,"title":row.data["title"],"version":row.version,
        "owner":{"agentId":row.owner_id,"name":owner.name,"state":owner.state},"updatedAt":row.updated_at,
        "seen":seen.map(|(version, at)| json!({"version":version,"at":at}))});
    if row.kind == "ask" {
        entry["ask"] = json!({"state":row.ask_state.as_deref().unwrap_or("open"),"repliedAt":row.replied_at});
    }
    if row.kind == "status" {
        let status = &row.data["status"];
        entry["status"] = json!({"asOf":status["asOf"],"validFor":status["validFor"],"stale":stale(status, now)});
    }
    if row.data["time"].is_object() {
        entry["time"] = row.data["time"].clone();
    }
    entry
}

/// The Section shape of web/src/home/types.ts. `refs` are its Live
/// References as they are now (see refs::Refs).
pub(super) fn section_json(row: &Row, owner: &Owner, seen: Option<&(i64, String)>, refs: Value, now: DateTime<Utc>) -> Value {
    let data = &row.data;
    let attachments: Vec<Value> = data["attachments"].as_array().into_iter().flatten().map(public_attachment).collect();
    let mut section = json!({
        "key":row.key,"kind":row.kind,"title":data["title"],"version":row.version,
        "owner":{"agentId":row.owner_id,"name":owner.name,"state":owner.state},
        "author":{"agentId":row.author_id,"name":row.author_name},
        "updatedAt":row.updated_at,"updatedTurnId":row.updated_turn_id,"body":data["body"],
        "attachments":attachments,
        "refs":refs,
        "seen":seen.map(|(version, at)| json!({"version":version,"at":at})),
        "history":!row.live,
    });
    if row.kind == "ask" {
        let mut ask = json!({"question":data["ask"]["question"],"reply":data["ask"]["reply"],
            "state":row.ask_state.as_deref().unwrap_or("open")});
        for (field, value) in [("repliedAt", &row.replied_at), ("replyText", &row.reply_text), ("deferredUntil", &row.deferred_until)] {
            if let Some(value) = value {
                ask[field] = json!(value);
            }
        }
        if !row.reply_images.is_empty() {
            ask["replyImages"] = json!(row.reply_images);
        }
        if !row.reply_files.is_empty() {
            ask["replyFiles"] = json!(row.reply_files);
        }
        // An executor's gate (T-43 S4), only when it names one.
        if data["ask"]["gate"].is_object() {
            ask["gate"] = data["ask"]["gate"].clone();
        }
        // A lead's proposal of a new request (YN-237 ④), only when it is one.
        if data["ask"]["proposal"].is_object() {
            ask["proposal"] = data["ask"]["proposal"].clone();
        }
        section["ask"] = ask;
    }
    if row.kind == "status" {
        let status = &data["status"];
        section["status"] = json!({"asOf":status["asOf"],"validFor":status["validFor"],"stale":stale(status, now)});
    }
    if data["time"].is_object() {
        section["time"] = data["time"].clone();
    }
    // What Core repaired to accept this version (YN-14); Home marks the section.
    if data["repairs"].as_array().is_some_and(|repairs| !repairs.is_empty()) {
        section["repairs"] = data["repairs"].clone();
    }
    section
}

/// Records how a key's section left the live Brief (seen, removed or
/// resolved) at `version`, replacing the key's previous ending. Only this
/// metadata outlives history's expiry; the body and attachments do not.
pub(super) fn record_ending(db: &Connection, row: &Row, version: i64, reason: &str, at: &str) -> Result<()> {
    db.execute(
        "INSERT INTO project_brief_endings(project_id,key,owner_id,identity,version,reason,at) VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(project_id,key) DO UPDATE SET owner_id=excluded.owner_id,identity=excluded.identity,
         version=excluded.version,reason=excluded.reason,at=excluded.at",
        params![row.project_id, row.key, row.owner_id, row.identity, version, reason, at],
    )?;
    Ok(())
}

/// The identity a new section under `key` by `owner` continues: the key's
/// last section was a report of this owner's that the user marked seen.
/// None after a removal or resolution, or for another owner.
pub(super) fn continued_identity(db: &Connection, project: &str, key: &str, owner: &str) -> Result<Option<i64>> {
    Ok(db
        .query_row(
            "SELECT identity FROM project_brief_endings WHERE project_id=?1 AND key=?2 AND owner_id=?3 AND reason='seen'",
            params![project, key, owner],
            |r| r.get(0),
        )
        .optional()?)
}

/// Why `owner`'s section under `key` is no longer live, said to its owner
/// when a change names it (YN-7): the key's last ending, if it was theirs.
/// Endings outlive history, so it is said however long ago.
pub(super) fn ending_note(db: &Connection, project: &str, key: &str, owner: &str) -> Result<Option<String>> {
    let ending: Option<(String, String)> = db
        .query_row(
            "SELECT reason,at FROM project_brief_endings WHERE project_id=?1 AND key=?2 AND owner_id=?3",
            params![project, key, owner],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(ending.and_then(|(reason, at)| match reason.as_str() {
        "seen" => Some(format!(
            " The user marked your report seen at {at}, so it left the live Brief; put it again under this key to continue it on Home."
        )),
        "removed" => Some(format!(" You removed it at {at}.")),
        "resolved" => Some(format!(" You resolved this ask at {at}.")),
        "archived" => Some(format!(
            " The task this section is the card of ended (done, cancelled or archived), so it left the live Brief at {at}; \
             put it again under this key to write a new section."
        )),
        "lead-left" => Some(format!(" You stopped leading this Project, so it left the live Brief at {at}.")),
        _ => None,
    }))
}

/// Old history goes, with its snapshot index (the files go with garbage
/// collection, see attachments::collect_garbage).
pub(super) fn expire_history(db: &Connection) -> Result<()> {
    let cutoff = history_cutoff();
    db.execute(
        "DELETE FROM project_brief_snapshots WHERE section_seq IN
         (SELECT seq FROM project_brief_sections WHERE live=0 AND history_at<?1)",
        [&cutoff],
    )?;
    db.execute("DELETE FROM project_brief_sections WHERE live=0 AND history_at<?1", [&cutoff])?;
    // And the notes on asks that are no longer kept (YN-213).
    super::ask_notes::expire(db)?;
    Ok(())
}

fn ensure_project(db: &Connection, project: &str) -> Result<()> {
    crate::projects::ensure_exists(db, project)
}

/// The user saw these versions. Each is recorded no higher than the version
/// that exists (a newer one stays unseen); a report seen at its current
/// version moves to history. Keys no longer live are ignored.
pub(super) fn mark_seen(store: &Store, project: &str, items: &[(String, i64)]) -> Result<Value> {
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    ensure_project(&tx, project)?;
    let at = now();
    let (mut recorded, mut archived) = (vec![], vec![]);
    for (key, version) in items {
        let Some(row) = live_key(&tx, project, key)? else { continue };
        let version = (*version).min(row.version);
        if version < 1 {
            continue;
        }
        tx.execute(
            "INSERT INTO project_brief_seen(project_id,key,version,at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(project_id,key) DO UPDATE SET
             at=CASE WHEN excluded.version>version THEN excluded.at ELSE at END,
             version=max(version,excluded.version)",
            params![project, key, version, at],
        )?;
        recorded.push(json!({"key":key,"version":version}));
        if row.kind == "report" && version == row.version {
            tx.execute(
                "UPDATE project_brief_sections SET live=0,history_reason='seen',history_at=?2 WHERE seq=?1",
                params![row.seq, at],
            )?;
            record_ending(&tx, &row, row.version, "seen", &at)?;
            archived.push(key.clone());
        }
    }
    expire_history(&tx)?;
    let unseen = unseen(&live(&tx, project)?, &seen(&tx, project)?, &opened(&tx, project)?);
    tx.commit()?;
    Ok(json!({"projectId":project,"seen":recorded,"archived":archived,"unseen":unseen}))
}

/// Defers an unresolved ask until `until` (None ends the deferral).
pub(super) fn defer(store: &Store, project: &str, key: &str, until: Option<&str>) -> Result<Value> {
    let until = until
        .map(|until| {
            DateTime::parse_from_rfc3339(until)
                .map(|at| at.with_timezone(&Utc).to_rfc3339())
                .context("until must be an ISO 8601 time with a time zone, or null")
        })
        .transpose()?;
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    ensure_project(&tx, project)?;
    let row = live_key(&tx, project, key)?.context("section_not_found: no live section has this key")?;
    ensure!(row.unresolved_ask(), "not_ask: only an unresolved ask can be deferred");
    tx.execute("UPDATE project_brief_sections SET deferred_until=?2 WHERE seq=?1", params![row.seq, until])?;
    tx.commit()?;
    Ok(json!({"projectId":project,"key":key,"deferredUntil":until}))
}

/// The user's reply to `version` of an ask reached its owner: it shows as
/// replied until the owner updates or resolves it. False if that version is
/// no longer the live unresolved ask: a reply to it never marks a newer ask
/// under the same key (T-9), as when its owner asked again meanwhile.
pub(super) fn mark_replied(store: &Store, project: &str, key: &str, version: i64, text: &str) -> Result<bool> {
    mark_replied_form(store, project, key, version, text, Marked::default())
}

/// What a reply marks on the version it answers, besides its text.
#[derive(Default)]
pub(super) struct Marked<'a> {
    /// The form answers Home checked (form_answers), kept with the version they answer (YN-74).
    pub form: Option<&'a Value>,
    /// The images (YN-134) and files (YN-145) the reply carried.
    pub images: &'a [String],
    pub files: &'a [crate::input_files::FileRef],
    /// The reply as the user gave it to that version (YN-223): its receipt's snapshot, which Home's answered ask is
    /// drawn from.
    pub snapshot: Option<&'a Value>,
    /// The delivered message the reply is (YN-223), which places it among the user's other replies to that version.
    /// None for a mark that names no message (tests), which marks only a version no such reply marked.
    pub sent: Option<Sent<'a>>,
}

/// A reply's delivered message (Marked::sent): the Agent it went to, its clientMessageId, and whether this send made
/// it (`fresh`) rather than finding it sent before (a retry).
pub(super) struct Sent<'a> {
    pub agent: &'a str,
    pub client: &'a str,
    pub fresh: bool,
}

/// `mark_replied` with what else the reply kept (Marked); a reply without one of them clears it. A replied version
/// shows the user's newest delivered reply to it (YN-223), in the order Core accepted their messages (their receipts'
/// rows, each written under its Agent's send lock as it was accepted): a reply marks it only if the reply it shows
/// was not accepted after it. So neither a late retry of an earlier reply nor two windows' marks landing in the other
/// order overwrite the newer answer, and a newer reply whose mark was interrupted marks it when retried. Its text,
/// form, snapshot, images and files are that one reply's, written together.
pub(super) fn mark_replied_form(store: &Store, project: &str, key: &str, version: i64, text: &str, marked: Marked) -> Result<bool> {
    let form = marked.form.map(|form| json!({"version": version, "formId": form["formId"], "answers": form["answers"]}).to_string());
    let images = (!marked.images.is_empty()).then(|| json!(marked.images).to_string());
    let files = (!marked.files.is_empty()).then(|| json!(marked.files).to_string());
    let snapshot = marked.snapshot.map(Value::to_string);
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    type Shown = (i64, String, Option<String>, Option<String>);
    let row: Option<Shown> = tx.query_row(
        "SELECT seq,ask_state,reply_agent,reply_client FROM project_brief_sections
         WHERE project_id=?1 AND key=?2 AND version=?3 AND live=1 AND kind='ask' AND ask_state IN ('open','replied')",
        params![project, key, version], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).optional()?;
    let Some((seq, state, agent, client)) = row else { return Ok(false) };
    let shown = agent.zip(client);
    let takes = state == "open" || match &marked.sent {
        Some(sent) => newest(&tx, project, key, version, sent, shown.as_ref())?,
        None => shown.is_none(),
    };
    if !takes {
        return Ok(false);
    }
    let (agent, client) = marked.sent.as_ref().map(|sent| (sent.agent, sent.client)).unzip();
    tx.execute(
        "UPDATE project_brief_sections SET ask_state='replied',replied_at=?2,reply_text=?3,reply_form=?4,reply_images=?5,reply_files=?6,
         reply_snapshot=?7,reply_agent=?8,reply_client=?9 WHERE seq=?1",
        params![seq, now(), text, form, images, files, snapshot, agent, client],
    )?;
    tx.commit()?;
    Ok(true)
}

/// Whether `sent` was accepted no earlier than the reply a replied version shows (`shown`, by its message), as the
/// receipts read in the mark's own transaction tell. A version replied before Core kept which message it shows is
/// placed by its newest other delivered reply among the receipts of the Agent `sent` went to. Where the receipts
/// place nothing (the shown reply's went with its Agent, or none is found), only a reply this send made marks it:
/// accepted just now, it is the newest, while a retry can't be placed and the answer shown is kept.
fn newest(db: &Connection, project: &str, key: &str, version: i64, sent: &Sent, shown: Option<&(String, String)>) -> Result<bool> {
    let order = |agent: &str, client: &str| -> Result<Option<i64>> {
        Ok(db.prepare_cached("SELECT rowid FROM agent_receipts WHERE agent_id=?1 AND client_id=?2")?
            .query_row(params![agent, client], |r| r.get(0)).optional()?)
    };
    let Some(mine) = order(sent.agent, sent.client)? else { return Ok(false) };
    let before = match shown {
        Some((agent, client)) => order(agent, client)?,
        None => db.prepare_cached(
            "SELECT MAX(rowid) FROM agent_receipts WHERE agent_id=?1 AND client_id!=?2
             AND json_extract(data,'$.origin.kind')='home' AND json_extract(data,'$.origin.projectId')=?3
             AND json_extract(data,'$.origin.key')=?4 AND json_extract(data,'$.origin.version')=?5
             AND json_extract(data,'$.origin.intent') IS NULL AND json_extract(data,'$.status') IN ('accepted','queued')",
        )?.query_row(params![sent.agent, sent.client, project, key, version], |r| r.get(0))?,
    };
    Ok(before.map_or(sent.fresh, |before| mine >= before))
}

/// What Core kept of an answered ask's reply, by its row (YN-223): the reply as the user gave it (`snapshot`), and
/// the form answers by id (`form`, YN-74) that a reply from before snapshots may still be read by. An ask replied
/// or resolved, live or in History. A value Core cannot read shows none.
pub(super) struct KeptReply {
    pub snapshot: Option<Value>,
    pub form: Option<Value>,
}

/// Which rows' kept replies a read takes: every answered ask's, live and in History (Home read whole); the live
/// ones' (Home with its History as an index, whose entries are read on their own); or these rows' (those entries).
pub(super) enum KeptRows<'a> {
    Every,
    Live,
    Rows(&'a [i64]),
}

pub(super) fn kept_replies(db: &Connection, project: &str, which: KeptRows) -> Result<HashMap<i64, KeptReply>> {
    const ANSWERED: &str = "SELECT seq,reply_snapshot,reply_form FROM project_brief_sections
         WHERE project_id=?1 AND kind='ask' AND ask_state IN ('replied','resolved') AND (reply_snapshot IS NOT NULL OR reply_form IS NOT NULL)";
    type Kept = (i64, Option<String>, Option<String>);
    let row = |r: &rusqlite::Row| -> rusqlite::Result<Kept> { Ok((r.get(0)?, r.get(1)?, r.get(2)?)) };
    let rows: Vec<Kept> = match which {
        KeptRows::Every => db.prepare_cached(ANSWERED)?.query_map([project], row)?.collect::<rusqlite::Result<_>>()?,
        KeptRows::Live => db.prepare_cached(&format!("{ANSWERED} AND live=1"))?.query_map([project], row)?.collect::<rusqlite::Result<_>>()?,
        KeptRows::Rows(seqs) => db.prepare_cached(&format!("{ANSWERED} AND seq IN (SELECT value FROM json_each(?2))"))?
            .query_map(params![project, serde_json::to_string(seqs)?], row)?.collect::<rusqlite::Result<_>>()?,
    };
    let read = |raw: Option<String>| raw.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).filter(Value::is_object);
    Ok(rows.into_iter().map(|(seq, snapshot, form)| (seq, KeptReply { snapshot: read(snapshot), form: read(form) })).collect())
}

/// `mark_replied` of whatever version is live now: for tests that only set
/// up a replied ask.
#[cfg(test)]
pub(super) fn mark_replied_live(store: &Store, project: &str, key: &str, text: &str) -> Result<bool> {
    let version = live_key(&*store.db.read()?, project, key)?.map_or(0, |row| row.version);
    mark_replied(store, project, key, version, text)
}
