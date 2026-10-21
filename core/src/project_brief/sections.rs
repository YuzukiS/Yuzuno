//! Stored sections, as Agents and Home read them, and the user's own marks
//! on them (seen, deferred, replied). Those marks are the user's state: they
//! never change a section's or the Brief's version.
use super::*;
use chrono::{DateTime, Utc};
use std::collections::HashMap;

const COLUMNS: &str = "seq,project_id,key,live,kind,version,owner_id,owner_name,data,ask_state,ask_since,\
replied_at,reply_text,deferred_until,updated_at,updated_turn_id,history_reason,history_at,COALESCE(lineage,seq)";

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
    /// Why a section is history: seen, removed or resolved.
    pub history_reason: Option<String>,
    /// The section's identity on Home: the row's own seq, or the seq of the
    /// report it continues (see update.rs, put after a Seen).
    pub identity: i64,
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
replied_at,reply_text,deferred_until,updated_at,updated_turn_id,history_reason,history_at,COALESCE(lineage,seq)";

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
                identity: r.get(18)?,
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

/// Seen reports, removed and resolved sections of the last 30 days, newest first.
pub(super) fn history(db: &Connection, project: &str) -> Result<Vec<Row>> {
    read(
        db,
        "project_id=?1 AND live=0 AND history_at>=?2 ORDER BY history_at DESC, seq DESC",
        params![project, history_cutoff()],
    )
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

pub(super) fn unseen(rows: &[Row], seen: &HashMap<String, (i64, String)>) -> usize {
    rows.iter().filter(|row| seen.get(&row.key).is_none_or(|(version, _)| *version < row.version)).count()
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
/// names; a snapshot's origin and file name stay Core's.
fn public_attachment(stored: &Value) -> Value {
    let mut shown = json!({});
    for field in ["name", "kind", "mime", "size", "snapshot", "mayChange", "takenAt", "caption", "url", "path"] {
        if field == "path" && stored["snapshot"] == true {
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
        section["ask"] = ask;
    }
    if row.kind == "status" {
        let status = &data["status"];
        section["status"] = json!({"asOf":status["asOf"],"validFor":status["validFor"],"stale":stale(status, now)});
    }
    if data["time"].is_object() {
        section["time"] = data["time"].clone();
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
    let unseen = unseen(&live(&tx, project)?, &seen(&tx, project)?);
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

/// The user's reply reached the ask's owner: it shows as replied until the
/// owner updates or resolves it. False if it is no longer an unresolved live ask.
pub(super) fn mark_replied(store: &Store, project: &str, key: &str, text: &str) -> Result<bool> {
    let changed = store.db.write()?.execute(
        "UPDATE project_brief_sections SET ask_state='replied',replied_at=?3,reply_text=?4
         WHERE project_id=?1 AND key=?2 AND live=1 AND kind='ask' AND ask_state IN ('open','replied')",
        params![project, key, now(), text],
    )?;
    Ok(changed == 1)
}
