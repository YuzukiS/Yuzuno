//! Where an Agent's conversation was last read on any of the user's browsers
//! (T-170), so another one can offer to continue there. One record per
//! Agent: the latest shared position, and the highest write number Core
//! accepted from each of the few most recent sources (browsers), so a late
//! duplicate of an older write never replaces a newer one. It holds
//! navigation identities only (Turn, Item, native session, how far into the
//! message), never text, titles or anything about the device. Reading it
//! navigates nothing; only the user's Continue does, in the browser.
use crate::{store::Store, workspace::Workspace};
use anyhow::{bail, ensure, Result};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

const KEY_PREFIX: &str = "reading.handoff.v1:";
/// The record as stored, all of it, in bytes.
pub const MAX_BYTES: usize = 8 * 1024;
/// Sources whose highest write number is kept.
pub const SOURCES: usize = 8;
/// Older than this, by Core's clock, a record reads as absent.
pub const TTL_SECONDS: i64 = 14 * 24 * 3600;
/// JavaScript's largest exact integer: write numbers come from browsers.
const MAX_SEQ: u64 = (1 << 53) - 1;

pub fn key(agent_id: &str) -> String {
    format!("{KEY_PREFIX}{agent_id}")
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Position {
    /// `anchor` (at a message) or `latest` (following the newest).
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    /// The Agent's native session when it was read there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// How far into the message the reader was, 0..1; never pixels, which
    /// mean something else on another screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mark {
    source: String,
    seq: u64,
    at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    version: u64,
    updated_at: DateTime<Utc>,
    position: Position,
    source: String,
    label: String,
    /// Most recent first; at most SOURCES.
    sources: Vec<Mark>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Write {
    pub position: Position,
    pub source: String,
    pub label: String,
    pub client_seq: u64,
}

/// What a browser sees: the shared position and its own highest number.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Seen {
    pub handoff: Option<serde_json::Value>,
    pub source_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted: Option<bool>,
}

fn id(value: &str, what: &str) -> Result<()> {
    ensure!(
        (1..=256).contains(&value.chars().count()) && !value.chars().any(|c| c.is_whitespace() || c.is_control()),
        "{what} must be 1-256 characters without spaces or control characters"
    );
    Ok(())
}

fn valid_source(source: &str) -> Result<()> {
    ensure!(
        (1..=64).contains(&source.len()) && source.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "source must be 1-64 letters, digits, '-' or '_'"
    );
    Ok(())
}

fn validate(write: &Write) -> Result<()> {
    valid_source(&write.source)?;
    ensure!(matches!(write.label.as_str(), "desktop" | "browser"), "label must be desktop or browser");
    ensure!((1..=MAX_SEQ).contains(&write.client_seq), "clientSeq must be a whole number from 1 to 2^53-1");
    let p = &write.position;
    match p.mode.as_str() {
        "latest" => ensure!(
            p.turn_id.is_none() && p.item_id.is_none() && p.progress.is_none(),
            "a latest position names no message"
        ),
        "anchor" => {
            let Some(turn) = &p.turn_id else { bail!("an anchor names its Turn") };
            id(turn, "turnId")?;
        }
        _ => bail!("mode must be anchor or latest"),
    }
    if let Some(item) = &p.item_id {
        id(item, "itemId")?;
    }
    if let Some(thread) = &p.thread_id {
        id(thread, "threadId")?;
    }
    if let Some(progress) = p.progress {
        ensure!(progress.is_finite() && (0.0..=1.0).contains(&progress), "progress must be from 0 to 1");
    }
    Ok(())
}

fn agent_exists(db: &rusqlite::Connection, agent_id: &str) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1)", [agent_id], |r| r.get(0))?)
}

fn load(db: &rusqlite::Connection, agent_id: &str) -> Result<Option<Stored>> {
    let raw: Option<String> = db
        .query_row("SELECT value FROM workspace_meta WHERE key=?1", [key(agent_id)], |r| r.get(0))
        .optional()?;
    // A record this version cannot read is treated as none and replaced.
    Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
}

fn current(stored: Option<Stored>, now: DateTime<Utc>) -> Option<Stored> {
    stored.filter(|s| (now - s.updated_at).num_seconds() <= TTL_SECONDS)
}

fn view(stored: &Stored, now: DateTime<Utc>) -> serde_json::Value {
    let mut value = serde_json::to_value(&stored.position).unwrap_or_default();
    value["source"] = stored.source.clone().into();
    value["label"] = stored.label.clone().into();
    value["version"] = stored.version.into();
    value["updatedAt"] = stored.updated_at.to_rfc3339().into();
    value["ageSeconds"] = (now - stored.updated_at).num_seconds().max(0).into();
    value
}

fn source_seq(stored: Option<&Stored>, source: Option<&str>) -> u64 {
    match (stored, source) {
        (Some(stored), Some(source)) => stored.sources.iter().find(|m| m.source == source).map_or(0, |m| m.seq),
        _ => 0,
    }
}

/// The shared position, or None for an unknown Agent.
pub fn read(store: &Store, agent_id: &str, source: Option<&str>, now: DateTime<Utc>) -> Result<Option<Seen>> {
    if let Some(source) = source {
        valid_source(source)?;
    }
    let db = store.db.read()?;
    if !agent_exists(&db, agent_id)? {
        return Ok(None);
    }
    let stored = current(load(&db, agent_id)?, now);
    Ok(Some(Seen {
        handoff: stored.as_ref().map(|s| view(s, now)),
        source_seq: source_seq(stored.as_ref(), source),
        accepted: None,
    }))
}

/// Applies one browser's write in one transaction, or keeps the record when
/// that browser already wrote a higher number. None for an unknown Agent.
pub fn write(store: &Store, agent_id: &str, input: &Write, now: DateTime<Utc>) -> Result<Option<Seen>> {
    validate(input)?;
    let mut db = store.db.write()?;
    let tx = db.transaction()?;
    if !agent_exists(&tx, agent_id)? {
        return Ok(None);
    }
    let stored = current(load(&tx, agent_id)?, now);
    let seen = source_seq(stored.as_ref(), Some(&input.source));
    if input.client_seq <= seen {
        let stored = stored.expect("a mark comes from a stored record");
        return Ok(Some(Seen { handoff: Some(view(&stored, now)), source_seq: seen, accepted: Some(false) }));
    }
    let mut sources: Vec<Mark> = stored.as_ref().map(|s| s.sources.clone()).unwrap_or_default();
    sources.retain(|m| m.source != input.source);
    sources.insert(0, Mark { source: input.source.clone(), seq: input.client_seq, at: now });
    sources.truncate(SOURCES);
    let next = Stored {
        version: stored.as_ref().map_or(0, |s| s.version) + 1,
        updated_at: now,
        position: input.position.clone(),
        source: input.source.clone(),
        label: input.label.clone(),
        sources,
    };
    let text = serde_json::to_string(&next)?;
    ensure!(text.len() <= MAX_BYTES, "the reading position is larger than {MAX_BYTES} bytes");
    tx.execute(
        "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key(agent_id), text],
    )?;
    tx.commit()?;
    Ok(Some(Seen { handoff: Some(view(&next, now)), source_seq: input.client_seq, accepted: Some(true) }))
}

/// Removed with its Agent, in the same transaction.
pub(crate) fn delete_agent(db: &rusqlite::Connection, agent_id: &str) -> Result<()> {
    db.execute("DELETE FROM workspace_meta WHERE key=?1", [key(agent_id)])?;
    Ok(())
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/agents/{id}/reading", get(get_reading).put(put_reading))
}

#[derive(Deserialize)]
struct SourceQuery {
    source: Option<String>,
}

fn answer(result: Result<Option<Seen>>) -> Response {
    match result {
        Ok(Some(seen)) => Json(seen).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({"error":"No such Agent","code":"agent_not_found"}))).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error":error.to_string()}))).into_response(),
    }
}

async fn get_reading(State(ws): State<Arc<Workspace>>, Path(agent): Path<String>, Query(query): Query<SourceQuery>) -> Response {
    answer(ws.stored(move |store| read(store, &agent, query.source.as_deref(), Utc::now())).await)
}

async fn put_reading(State(ws): State<Arc<Workspace>>, Path(agent): Path<String>, Json(input): Json<Write>) -> Response {
    answer(ws.stored(move |store| write(store, &agent, &input, Utc::now())).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        (tmp, store)
    }

    fn agent(store: &Store, id: &str) {
        store.db.write().unwrap()
            .execute("INSERT INTO agents(id,data) VALUES(?1,'{}')", [id]).unwrap();
    }

    fn anchor(turn: &str, progress: Option<f64>) -> Position {
        Position { mode: "anchor".into(), turn_id: Some(turn.into()), item_id: Some(format!("{turn}-reply")), thread_id: Some("thread-1".into()), progress }
    }

    fn put(store: &Store, source: &str, seq: u64, position: Position, now: DateTime<Utc>) -> Seen {
        write(store, "a", &Write { position, source: source.into(), label: "browser".into(), client_seq: seq }, now).unwrap().unwrap()
    }

    #[test]
    fn a_write_is_kept_and_read_with_its_version_and_core_time() {
        let (_tmp, store) = store();
        agent(&store, "a");
        let now = Utc::now();
        assert!(read(&store, "a", Some("phone"), now).unwrap().unwrap().handoff.is_none());
        let seen = put(&store, "desk", 5, anchor("t1", Some(0.25)), now);
        assert_eq!(seen.accepted, Some(true));
        let later = read(&store, "a", Some("desk"), now + chrono::Duration::seconds(30)).unwrap().unwrap();
        let handoff = later.handoff.unwrap();
        assert_eq!((handoff["turnId"].as_str(), handoff["progress"].as_f64(), handoff["version"].as_u64()), (Some("t1"), Some(0.25), Some(1)));
        assert_eq!(handoff["ageSeconds"], 30);
        assert_eq!(later.source_seq, 5);
        assert!(handoff.get("sources").is_none(), "other browsers' marks are not shown");
    }

    #[test]
    fn a_late_older_write_from_one_source_never_replaces_a_newer_one() {
        let (_tmp, store) = store();
        agent(&store, "a");
        let now = Utc::now();
        put(&store, "desk", 10, anchor("t1", None), now);
        put(&store, "phone", 3, anchor("t2", None), now);
        // The desk's older duplicate arrives last: kept out, and says why.
        let late = put(&store, "desk", 9, anchor("t0", None), now);
        assert_eq!(late.accepted, Some(false));
        assert_eq!(late.source_seq, 10);
        assert_eq!(late.handoff.unwrap()["turnId"], "t2");
        let same = put(&store, "desk", 10, anchor("t0", None), now);
        assert_eq!(same.accepted, Some(false), "a repeated number is not applied twice");
        // Another source's write is taken in Core's order.
        let newer = put(&store, "desk", 11, anchor("t3", None), now);
        assert_eq!((newer.accepted, newer.handoff.unwrap()["version"].as_u64()), (Some(true), Some(3)));
    }

    #[test]
    fn at_most_eight_sources_are_remembered_and_an_evicted_one_is_taken_again() {
        let (_tmp, store) = store();
        agent(&store, "a");
        let now = Utc::now();
        put(&store, "first", 100, anchor("t1", None), now);
        for n in 0..SOURCES {
            put(&store, &format!("s{n}"), 1, anchor("t1", None), now);
        }
        let raw: String = store.db.read().unwrap()
            .query_row("SELECT value FROM workspace_meta WHERE key=?1", [key("a")], |r| r.get(0)).unwrap();
        let stored: Stored = serde_json::from_str(&raw).unwrap();
        assert_eq!(stored.sources.len(), SOURCES);
        assert!(stored.sources.iter().all(|m| m.source != "first"));
        // Best effort past eight: the evicted source's lower number is taken.
        assert_eq!(put(&store, "first", 50, anchor("t9", None), now).accepted, Some(true));
    }

    #[test]
    fn a_record_older_than_fourteen_days_reads_as_absent_and_marks_restart() {
        let (_tmp, store) = store();
        agent(&store, "a");
        let then = Utc::now() - chrono::Duration::seconds(TTL_SECONDS + 60);
        put(&store, "desk", 10, anchor("t1", None), then);
        let now = Utc::now();
        let seen = read(&store, "a", Some("desk"), now).unwrap().unwrap();
        assert!(seen.handoff.is_none());
        assert_eq!(seen.source_seq, 0);
        assert_eq!(put(&store, "desk", 1, anchor("t2", None), now).handoff.unwrap()["version"], 1);
    }

    #[test]
    fn bad_input_is_refused_and_the_record_stays_small() {
        let (_tmp, store) = store();
        agent(&store, "a");
        let now = Utc::now();
        let long = "x".repeat(257);
        let bad = [
            Write { position: anchor("t1", Some(1.5)), source: "desk".into(), label: "browser".into(), client_seq: 1 },
            Write { position: anchor("t1", Some(f64::NAN)), source: "desk".into(), label: "browser".into(), client_seq: 1 },
            Write { position: anchor(&long, None), source: "desk".into(), label: "browser".into(), client_seq: 1 },
            Write { position: anchor("t 1", None), source: "desk".into(), label: "browser".into(), client_seq: 1 },
            Write { position: anchor("t1", None), source: "desk id".into(), label: "browser".into(), client_seq: 1 },
            Write { position: anchor("t1", None), source: "x".repeat(65), label: "browser".into(), client_seq: 1 },
            Write { position: anchor("t1", None), source: "desk".into(), label: "iPhone 17".into(), client_seq: 1 },
            Write { position: anchor("t1", None), source: "desk".into(), label: "browser".into(), client_seq: 0 },
            Write { position: anchor("t1", None), source: "desk".into(), label: "browser".into(), client_seq: MAX_SEQ + 1 },
            Write { position: Position { mode: "latest".into(), turn_id: Some("t1".into()), item_id: None, thread_id: None, progress: None },
                source: "desk".into(), label: "browser".into(), client_seq: 1 },
            Write { position: Position { mode: "anchor".into(), turn_id: None, item_id: None, thread_id: None, progress: None },
                source: "desk".into(), label: "browser".into(), client_seq: 1 },
        ];
        for input in bad {
            assert!(write(&store, "a", &input, now).is_err(), "{input:?}");
        }
        assert!(read(&store, "a", Some("bad source"), now).is_err());
        // The largest valid record, with every source, still fits.
        let max = "x".repeat(256);
        for n in 0..SOURCES {
            let position = Position { mode: "anchor".into(), turn_id: Some(max.clone()), item_id: Some(max.clone()), thread_id: Some(max.clone()), progress: Some(0.123456789) };
            put(&store, &format!("{n}{}", "s".repeat(63)), MAX_SEQ, position, now);
        }
        let raw: String = store.db.read().unwrap()
            .query_row("SELECT value FROM workspace_meta WHERE key=?1", [key("a")], |r| r.get(0)).unwrap();
        assert!(raw.len() <= MAX_BYTES, "{} bytes", raw.len());
    }

    #[test]
    fn an_unknown_agent_has_none() {
        let (_tmp, store) = store();
        let now = Utc::now();
        assert!(read(&store, "missing", None, now).unwrap().is_none());
        let input = Write { position: anchor("t1", None), source: "desk".into(), label: "browser".into(), client_seq: 1 };
        assert!(write(&store, "missing", &input, now).unwrap().is_none());
    }
}
