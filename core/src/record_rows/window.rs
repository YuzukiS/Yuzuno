//! Rebuildable item metadata for saved-body windows. The authoritative rows
//! and original/payload APIs are unchanged. Triggers invalidate this cache for
//! writes from older Core builds and manual edits as well as this build.
use super::*;
use crate::conversation_window;
use rusqlite::types::ValueRef;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_window_items(
            agent_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY(agent_id,turn_id,item_id),
            FOREIGN KEY(agent_id,turn_id,item_id) REFERENCES agent_items(agent_id,turn_id,item_id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS agent_items_window_order ON agent_items(agent_id,turn_id,ord,item_id,payloads);
        CREATE TRIGGER IF NOT EXISTS agent_window_insert AFTER INSERT ON agent_items BEGIN
            DELETE FROM agent_window_items WHERE agent_id=NEW.agent_id AND turn_id=NEW.turn_id AND item_id=NEW.item_id;
        END;
        CREATE TRIGGER IF NOT EXISTS agent_window_update AFTER UPDATE OF data,previews,payloads,agent_id,turn_id,item_id ON agent_items BEGIN
            DELETE FROM agent_window_items WHERE agent_id=OLD.agent_id AND turn_id=OLD.turn_id AND item_id=OLD.item_id;
            DELETE FROM agent_window_items WHERE agent_id=NEW.agent_id AND turn_id=NEW.turn_id AND item_id=NEW.item_id;
        END;
        CREATE TRIGGER IF NOT EXISTS agent_window_delete AFTER DELETE ON agent_items BEGIN
            DELETE FROM agent_window_items WHERE agent_id=OLD.agent_id AND turn_id=OLD.turn_id AND item_id=OLD.item_id;
        END;
        DELETE FROM agent_window_items WHERE NOT EXISTS (SELECT 1 FROM agent_items i
            WHERE i.agent_id=agent_window_items.agent_id AND i.turn_id=agent_window_items.turn_id AND i.item_id=agent_window_items.item_id);"
    )?;
    Ok(())
}

/// JSON bytes returned by SQLite, not physical disk IO or SQLite allocations.
/// Cache construction is reported separately from steady-state window reads.
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadStats {
    pub source: &'static str,
    pub metadata_json_bytes: usize,
    pub body_json_bytes: usize,
    pub body_items: usize,
    pub index_build_json_bytes: usize,
    pub index_build_items: usize,
}

/// The shape of a cached entry (`conversation_window::item_index`). An entry
/// of another version is rebuilt when read: 2 keeps a sub-agent call's status,
/// 3 a background task's too.
const INDEX_VERSION: u8 = 3;

#[derive(Serialize, Deserialize)]
struct Entry {
    version: u8,
    item: Value,
}

/// A cache entry to publish, and what it was built from: the row's identity
/// and payload count, and the length and SHA-256 of its `data` and `previews`
/// (`None` stays apart from an empty preview), not the text itself. A first
/// read after a cache version change builds an entry for every Item; holding
/// each row's text until the writer published them kept about the record's
/// whole Item text alive through that read.
pub(crate) struct Fill {
    turn: String,
    key: String,
    payloads: usize,
    data: Seen,
    previews: Option<Seen>,
    entry: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Seen {
    len: usize,
    sha256: [u8; 32],
}

impl Seen {
    fn of(text: &[u8]) -> Self {
        Self {
            len: text.len(),
            sha256: Sha256::digest(text).into(),
        }
    }
}

/// The index of every Item: only tests build it (production reads the
/// sparse one, `sparse`).
#[cfg(test)]
pub(crate) struct Index {
    pub detail: AgentDetail,
    pub keys: Vec<(String, Vec<String>)>,
    pub fills: Vec<Fill>,
    pub stats: ReadStats,
}

/// All light metadata, plus bodies only for missing/stale cache entries. The
/// caller holds one WAL snapshot through this and all selected-body reads.
/// Initial construction after an upgrade is deliberately lazy, not an
/// unbounded startup migration. It does not change the record's revision.
#[cfg(test)]
pub(crate) fn index(db: &Connection, id: &str) -> Result<Index> {
    let build = || -> Result<Index> {
        ensure!(rows_fit(db, id)?, "rows do not fit");
        let meta: String =
            db.query_row("SELECT data FROM agents WHERE id=?1", [id], |r| r.get(0))?;
        let mut detail = from_meta(&meta)?;
        let mut stats = ReadStats {
            source: "rows",
            metadata_json_bytes: meta.len(),
            ..ReadStats::default()
        };
        let mut keys = Vec::new();
        let mut expected = Vec::new();
        let mut turn_at = HashMap::new();
        let mut turns = db.prepare_cached(
            "SELECT turn_id, ord, items, data FROM agent_turns WHERE agent_id=?1 ORDER BY ord",
        )?;
        for row in turns.query_map([id], |r| {
            Ok(TurnRow {
                key: r.get(0)?,
                ord: count(r.get(1)?)?,
                items: r.get::<_, Option<i64>>(2)?.map(count).transpose()?,
                data: r.get(3)?,
            })
        })? {
            let row = row?;
            ensure!(row.ord == detail.turns.len(), "Turn rows are not in order");
            stats.metadata_json_bytes += row.data.len();
            let mut turn: Value = serde_json::from_str(&row.data)?;
            if let Some(n) = row.items {
                ensure!(
                    turn.is_object() && turn["items"] == n,
                    "Turn row has another Item count"
                );
                turn["items"] = json!([]);
            }
            expected.push(row.items.unwrap_or(0));
            turn_at.insert(row.key.clone(), row.ord);
            keys.push((row.key, Vec::new()));
            detail.turns.push(turn);
        }
        let mut fills = Vec::new();
        let mut query = db.prepare_cached(
            "SELECT i.turn_id,i.item_id,i.ord,i.payloads,w.data,
            CASE WHEN w.data IS NULL THEN i.data END,
            CASE WHEN w.data IS NULL THEN i.previews END
            FROM agent_items i LEFT JOIN agent_window_items w
            ON w.agent_id=i.agent_id AND w.turn_id=i.turn_id AND w.item_id=i.item_id
            WHERE i.agent_id=?1 ORDER BY i.turn_id,i.ord",
        )?;
        let mut rows = query.query([id])?;
        while let Some(row) = rows.next()? {
            let turn: String = row.get(0)?;
            let key: String = row.get(1)?;
            let ord = count(row.get(2)?)?;
            let payloads = count(row.get(3)?)?;
            let cached: Option<String> = row.get(4)?;
            stats.metadata_json_bytes += cached.as_ref().map_or(0, String::len);
            let entry = cached
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Entry>(raw).ok())
                .filter(|entry| entry.version == INDEX_VERSION && entry.item.is_object());
            let item = if let Some(entry) = entry {
                entry.item
            } else {
                // A malformed cache is also rebuildable. Do not confuse it
                // with corruption of the authoritative body.
                let raw = if cached.is_none() {
                    ItemRow {
                        turn: turn.clone(),
                        key: key.clone(),
                        ord,
                        payloads,
                        data: row.get(5)?,
                        previews: row.get(6)?,
                    }
                } else {
                    item_row_at(db, id, &turn, &key)?
                };
                stats.index_build_json_bytes +=
                    raw.data.len() + raw.previews.as_ref().map_or(0, String::len);
                stats.index_build_items += 1;
                let value = decode(db, id, &raw, false, None)?;
                let item = conversation_window::item_index(&value);
                let entry = serde_json::to_string(&Entry {
                    version: INDEX_VERSION,
                    item: item.clone(),
                })?;
                fills.push(Fill {
                    data: Seen::of(raw.data.as_bytes()),
                    previews: raw.previews.as_deref().map(|p| Seen::of(p.as_bytes())),
                    turn: raw.turn,
                    key: raw.key,
                    payloads: raw.payloads,
                    entry,
                });
                item
            };
            let t = *turn_at.get(&turn).context("Item without Turn")?;
            ensure!(keys[t].1.len() == ord, "Item rows are not in order");
            keys[t].1.push(key);
            detail.turns[t]["items"]
                .as_array_mut()
                .context("Item in whole Turn")?
                .push(item);
        }
        ensure!(
            keys.iter()
                .zip(expected)
                .all(|((_, keys), n)| keys.len() == n),
            "Item count differs"
        );
        Ok(Index {
            detail,
            keys,
            fills,
            stats,
        })
    };
    build().map_err(|error| damaged(id, error))
}

/// A window's index without every Item (T-140): the metadata, each Turn's
/// row with, as its Items, only the light entries (`item_index`) of those a
/// window lists whatever it shows (user messages, async questions, running
/// tasks: found by their keys, never by reading every Item), and for each
/// Turn its Item count and its key, and each entry's stored position.
pub(crate) struct Sparse {
    pub detail: AgentDetail,
    pub counts: Vec<usize>,
    pub keys: Vec<String>,
    pub ords: Vec<Vec<usize>>,
    pub fills: Vec<Fill>,
    pub stats: ReadStats,
}

pub(crate) fn sparse(db: &Connection, id: &str) -> Result<Sparse> {
    let build = || -> Result<Sparse> {
        ensure!(rows_fit(db, id)?, "rows do not fit");
        let meta: String = db.query_row("SELECT data FROM agents WHERE id=?1", [id], |r| r.get(0))?;
        let mut detail = from_meta(&meta)?;
        let mut stats = ReadStats { source: "rows", metadata_json_bytes: meta.len(), ..ReadStats::default() };
        let (mut counts, mut keys) = (Vec::new(), Vec::new());
        let mut turn_at = HashMap::new();
        let mut turns = db.prepare_cached("SELECT turn_id, ord, items, data FROM agent_turns WHERE agent_id=?1 ORDER BY ord")?;
        for row in turns.query_map([id], |r| Ok(TurnRow { key: r.get(0)?, ord: count(r.get(1)?)?,
            items: r.get::<_, Option<i64>>(2)?.map(count).transpose()?, data: r.get(3)? }))? {
            let row = row?;
            ensure!(row.ord == detail.turns.len(), "Turn rows are not in order");
            stats.metadata_json_bytes += row.data.len();
            let mut turn: Value = serde_json::from_str(&row.data)?;
            if let Some(n) = row.items {
                ensure!(turn.is_object() && turn["items"] == n, "Turn row has another Item count");
                turn["items"] = json!([]);
            }
            counts.push(row.items.unwrap_or(0));
            turn_at.insert(row.key.clone(), row.ord);
            keys.push(row.key);
            detail.turns.push(turn);
        }
        let mut listed: Vec<Vec<(usize, Value)>> = vec![Vec::new(); detail.turns.len()];
        let mut fills = Vec::new();
        let mut marked = db.prepare_cached("SELECT DISTINCT turn_id, item_id FROM agent_item_keys
            WHERE agent_id=?1 AND kind IN ('user','question','running')")?;
        let found: Vec<(String, String)> = marked.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        for (turn, key) in found {
            let t = *turn_at.get(&turn).context("Item without Turn")?;
            let (ord, entry) = light(db, id, &turn, &key, &mut fills, &mut stats)?;
            listed[t].push((ord, entry));
        }
        let mut ords = Vec::with_capacity(listed.len());
        for (t, mut entries) in listed.into_iter().enumerate() {
            entries.sort_by_key(|(ord, _)| *ord);
            ords.push(entries.iter().map(|(ord, _)| *ord).collect());
            detail.turns[t]["items"] = Value::Array(entries.into_iter().map(|(_, entry)| entry).collect());
        }
        Ok(Sparse { detail, counts, keys, ords, fills, stats })
    };
    build().map_err(|error| damaged(id, error))
}

/// One Item's light entry (`item_index`) and stored position: its cached
/// entry, or one built from its row (to cache, `fill`).
fn light(db: &Connection, id: &str, turn: &str, key: &str, fills: &mut Vec<Fill>, stats: &mut ReadStats) -> Result<(usize, Value)> {
    let (ord, payloads, cached, data, previews): (usize, usize, Option<String>, Option<String>, Option<String>) = db.prepare_cached(
        "SELECT i.ord, i.payloads, w.data, CASE WHEN w.data IS NULL THEN i.data END, CASE WHEN w.data IS NULL THEN i.previews END
        FROM agent_items i LEFT JOIN agent_window_items w ON w.agent_id=i.agent_id AND w.turn_id=i.turn_id AND w.item_id=i.item_id
        WHERE i.agent_id=?1 AND i.turn_id=?2 AND i.item_id=?3")?
        .query_row(params![id, turn, key], |r| Ok((count(r.get(0)?)?, count(r.get(1)?)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
    stats.metadata_json_bytes += cached.as_ref().map_or(0, String::len);
    if let Some(entry) = cached.as_deref().and_then(|raw| serde_json::from_str::<Entry>(raw).ok())
        .filter(|entry| entry.version == INDEX_VERSION && entry.item.is_object()) {
        return Ok((ord, entry.item));
    }
    let raw = match data {
        Some(data) => ItemRow { turn: turn.into(), key: key.into(), ord, payloads, data, previews },
        None => item_row_at(db, id, turn, key)?,
    };
    stats.index_build_json_bytes += raw.data.len() + raw.previews.as_ref().map_or(0, String::len);
    stats.index_build_items += 1;
    let value = decode(db, id, &raw, false, None)?;
    let item = conversation_window::item_index(&value);
    let entry = serde_json::to_string(&Entry { version: INDEX_VERSION, item: item.clone() })?;
    fills.push(Fill { data: Seen::of(raw.data.as_bytes()), previews: raw.previews.as_deref().map(|p| Seen::of(p.as_bytes())),
        turn: raw.turn, key: raw.key, payloads: raw.payloads, entry });
    Ok((ord, item))
}

/// The key of the Item at a stored position of a Turn, and its ID (one
/// keyed by position holds it only in its data).
pub(crate) fn key_at(db: &Connection, id: &str, turn: &str, ord: usize) -> Result<Option<(String, Option<String>)>> {
    Ok(db.prepare_cached("SELECT item_id, CASE WHEN item_id>='~' AND item_id<char(127) AND json_type(data,'$.id')='text'
            THEN json_extract(data,'$.id') WHEN item_id>='~' AND item_id<char(127) THEN NULL ELSE item_id END
        FROM agent_items WHERE agent_id=?1 AND turn_id=?2 AND ord=?3")?
        .query_row(params![id, turn, ord as i64], |r| Ok((r.get(0)?, r.get(1)?))).optional()?)
}

/// The first position of an Item with this ID in a Turn, as a window finds
/// a cursor or destination (an ID may repeat, its rows then keyed by place).
pub(crate) fn first_position(db: &Connection, id: &str, turn: &str, item: &str) -> Result<Option<usize>> {
    let found: Option<i64> = db.prepare_cached("SELECT MIN(ord) FROM (
            SELECT ord FROM agent_items WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3
            UNION ALL SELECT ord FROM agent_items WHERE agent_id=?1 AND turn_id=?2 AND item_id>='~' AND item_id<char(127)
                AND json_extract(data,'$.id')=?3)")?
        .query_row(params![id, turn, item], |r| r.get(0))?;
    found.map(count).transpose().map_err(Into::into)
}

/// The position of a Turn's last assistant message whose `field` holds text
/// (what the rail reads, as `item_index` marks it present).
pub(crate) fn last_message(db: &Connection, id: &str, turn: &str, field: &str) -> Result<Option<usize>> {
    Ok(db.prepare_cached("SELECT ord FROM agent_items WHERE agent_id=?1 AND turn_id=?2
        AND json_extract(data,'$.type')='agentMessage' AND json_type(data,?3)='text'
        AND trim(json_extract(data,?3),' '||char(9)||char(10)||char(13))!='' ORDER BY ord DESC LIMIT 1")?
        .query_row(params![id, turn, format!("$.{field}")], |r| count(r.get(0)?)).optional()?)
}

/// Each message Item (user or assistant) of a Turn in order, read without
/// payloads one at a time, until `each` says to stop: what a search reads.
pub(crate) fn messages(db: &Connection, id: &str, turn: &str, mut each: impl FnMut(Value) -> Result<bool>) -> Result<bool> {
    let mut query = db.prepare_cached("SELECT turn_id,item_id,ord,payloads,data,previews FROM agent_items
        WHERE agent_id=?1 AND turn_id=?2 AND json_extract(data,'$.type') IN ('userMessage','agentMessage') ORDER BY ord")?;
    let mut rows = query.query(params![id, turn])?;
    while let Some(row) = rows.next()? {
        let row = item_from_row(row)?;
        if !each(decode(db, id, &row, false, None).map_err(|error| damaged(id, error))?)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Publish a prepared cache only if the source row is still exactly the one
/// read: in the caller's write transaction, each row is read again and its
/// data, previews (absent or text) and payload count compared with what the
/// entry was built from. The writer never parses/serializes history;
/// concurrent rewrites are left for the next read. Triggers remove entries on
/// subsequent changes.
pub(crate) fn fill(db: &Connection, id: &str, fills: Vec<Fill>) -> Result<()> {
    let mut current = db.prepare_cached(
        "SELECT data,previews,payloads FROM agent_items WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3",
    )?;
    let mut publish = db.prepare_cached("INSERT INTO agent_window_items(agent_id,turn_id,item_id,data) VALUES(?1,?2,?3,?4)
        ON CONFLICT(agent_id,turn_id,item_id) DO UPDATE SET data=excluded.data WHERE data IS NOT excluded.data")?;
    for fill in fills {
        let unchanged = current
            .query_row(params![id, fill.turn, fill.key], |r| {
                let data = match r.get_ref(0)? {
                    ValueRef::Text(text) => Some(Seen::of(text)),
                    _ => None,
                };
                let previews = match r.get_ref(1)? {
                    ValueRef::Null => Some(None),
                    ValueRef::Text(text) => Some(Some(Seen::of(text))),
                    _ => None,
                };
                Ok(data == Some(fill.data)
                    && previews == Some(fill.previews)
                    && r.get::<_, i64>(2)? == fill.payloads as i64)
            })
            .optional()?
            .unwrap_or(false);
        if unchanged {
            publish.execute(params![id, fill.turn, fill.key, fill.entry])?;
        }
    }
    Ok(())
}

fn item_row_at(db: &Connection, id: &str, turn: &str, item: &str) -> Result<ItemRow> {
    Ok(db
        .prepare_cached(
            "SELECT turn_id,item_id,ord,payloads,data,previews FROM agent_items
        WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3",
        )?
        .query_row(params![id, turn, item], item_from_row)?)
}

fn decode(
    db: &Connection,
    id: &str,
    row: &ItemRow,
    whole: bool,
    mut stats: Option<&mut ReadStats>,
) -> Result<Value> {
    let mut value = serde_json::from_str(&row.data)?;
    if row.payloads > 0 {
        if whole {
            let fields: Vec<(String, String)> = db
                .prepare_cached(
                    "SELECT field,data FROM agent_payloads
                WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3",
                )?
                .query_map(params![id, row.turn, row.key], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?
                .collect::<rusqlite::Result<_>>()?;
            if let Some(stats) = stats.as_mut() {
                stats.body_json_bytes += fields.iter().map(|(_, data)| data.len()).sum::<usize>();
            }
            // A window reads one Item's payloads at a time; parsed here as
            // `fill` used to parse them.
            let fields = fields.into_iter().map(|(field, data)| (field, serde_json::from_str(&data))).collect();
            super::fill(&mut value, fields, row.payloads)?;
        } else {
            preview_fields(&mut value, row.previews.as_deref(), row.payloads)?;
        }
    }
    if whole {
        super::unspill(db, id, &row.turn, &mut value)?;
    }
    Ok(value)
}

pub(crate) fn item(
    db: &Connection,
    id: &str,
    turn: &str,
    item: &str,
    whole: bool,
    stats: &mut ReadStats,
) -> Result<Value> {
    let mut read = || -> Result<Value> {
        let row = item_row_at(db, id, turn, item)?;
        stats.body_json_bytes += row.data.len() + row.previews.as_ref().map_or(0, String::len);
        stats.body_items += 1;
        decode(db, id, &row, whole, Some(stats))
    };
    read().map_err(|error| damaged(id, error))
}
