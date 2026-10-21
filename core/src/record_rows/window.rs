//! Rebuildable item metadata for saved-body windows. The authoritative rows
//! and original/payload APIs are unchanged. Triggers invalidate this cache for
//! writes from older Core builds and manual edits as well as this build.
use super::*;
use crate::conversation_window;
use serde::{Deserialize, Serialize};

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

pub(crate) struct Fill {
    row: ItemRow,
    data: String,
}

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
                let data = serde_json::to_string(&Entry {
                    version: INDEX_VERSION,
                    item: item.clone(),
                })?;
                fills.push(Fill { row: raw, data });
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

/// Publish a prepared cache only if the source row is still exactly the one
/// read. The writer never parses/serializes history; concurrent rewrites are
/// left for the next read. Triggers remove entries on subsequent changes.
pub(crate) fn fill(db: &Connection, id: &str, fills: Vec<Fill>) -> Result<()> {
    let mut query = db.prepare_cached("INSERT INTO agent_window_items(agent_id,turn_id,item_id,data)
        SELECT agent_id,turn_id,item_id,?4 FROM agent_items
        WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3 AND data IS ?5 AND previews IS ?6 AND payloads=?7
        ON CONFLICT(agent_id,turn_id,item_id) DO UPDATE SET data=excluded.data WHERE data IS NOT excluded.data")?;
    for Fill { row, data } in fills {
        query.execute(params![
            id,
            row.turn,
            row.key,
            data,
            row.data,
            row.previews,
            row.payloads as i64
        ])?;
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
            super::fill(&mut value, fields, row.payloads)?;
        } else {
            preview_fields(&mut value, row.previews.as_deref(), row.payloads)?;
        }
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
