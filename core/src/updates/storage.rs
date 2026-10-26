//! Release compatibility includes the record format, not just user_version.
//! These probes never migrate, revert, or restore the Workspace database.
use super::package::Manifest;
use anyhow::{ensure, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The record format this Core writes and the only one it reads: the
/// session store of T-140 (rows only, receipts apart from the metadata).
/// 0 was whole AgentDetail JSON, 1 the rows of earlier Cores.
pub const RECORD_LAYOUT: u32 = 2;

/// Runs only in the release's disposable verification process. Each invocation
/// opens a new read-only SQLite snapshot; no result is reused for a later phase,
/// process or database. The parent imposes a hard deadline, including JSON work.
pub fn verify_at(data: &Path, workspace_id: &str) -> Result<serde_json::Value> {
    let db = Connection::open_with_flags(
        data.join("workspace.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    db.busy_timeout(std::time::Duration::from_secs(3))?;
    db.execute_batch("BEGIN")?;
    let identity: String = db.query_row(
        "SELECT value FROM workspace_meta WHERE key='workspaceId'",
        [],
        |r| r.get(0),
    )?;
    ensure!(
        identity == workspace_id,
        "Verifier Workspace identity differs"
    );
    let storage = Storage::read(&db)?;
    ensure!(
        storage.schema == super::package::STORAGE,
        "Verifier schema differs"
    );
    ensure!(
        storage.record_layouts.iter().all(|n| *n == RECORD_LAYOUT),
        "Unknown record layout"
    );
    let records = verify_records(&db)?;
    let data_version: i64 = db.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    Ok(
        serde_json::json!({"recordsReady":true,"workspaceId":identity,
        "schema":storage.schema,"recordLayouts":storage.record_layouts,
        "recordsChecked":records,"snapshotDataVersion":data_version}),
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    pub schema: u32,
    pub record_layouts: Vec<u32>,
}

impl Storage {
    pub fn read(db: &Connection) -> Result<Self> {
        let schema = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let has_layout: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name='layout')",
            [],
            |r| r.get(0),
        )?;
        // A Workspace of the session store holds its Agents' records in its
        // layout (none without Agents).
        let (store, agents): (bool, bool) = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspace_meta WHERE key=?1 AND value=?2), EXISTS(SELECT 1 FROM agents)",
            [crate::record_rows::STORE_KEY, crate::record_rows::STORE_VERSION],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap_or((false, true));
        let record_layouts = if store {
            if agents { vec![RECORD_LAYOUT] } else { Vec::new() }
        } else if has_layout {
            db.prepare("SELECT DISTINCT layout FROM agents ORDER BY layout")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<u32>>>()?
        } else {
            // The original record format is whole AgentDetail JSON.
            vec![0]
        };
        Ok(Self {
            schema,
            record_layouts,
        })
    }

    pub fn at(data_dir: &Path) -> Result<Self> {
        let db = Connection::open_with_flags(
            data_dir.join("workspace.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        db.execute_batch("BEGIN")?;
        Self::read(&db)
    }

    pub fn readable_by(&self, manifest: &Manifest) -> Result<()> {
        ensure!(
            manifest.schema.reads(self.schema),
            "Release {} cannot read Workspace schema {}",
            manifest.release_id,
            self.schema
        );
        for layout in &self.record_layouts {
            ensure!(manifest.records.reads(*layout),
                "Release {} cannot read Workspace records.layout={layout}; automatic conversion or backup restore is forbidden", manifest.release_id);
        }
        Ok(())
    }
}

/// Strictly assemble actual persisted history, Items and full payloads, one
/// Turn at a time (T-140): only one Turn is held.
pub fn verify_records(db: &Connection) -> Result<usize> {
    let ids = db
        .prepare("SELECT id FROM agents ORDER BY id")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Resolve the new tables even for an empty Workspace.
    for table in ["agent_turns", "agent_items", "agent_payloads"] {
        let _: i64 = db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
    }
    for id in &ids {
        ensure!(
            crate::record_rows::rows_fit(db, id)?,
            "Agent {id} history/Item/payload rows are incomplete"
        );
        crate::record_rows::load_meta(db, id)
            .with_context(|| format!("Agent {id} persisted metadata cannot be read"))?
            .context("Agent disappeared from storage snapshot")?;
        crate::record_rows::scan(db, id, true, |_| Ok(true))
            .with_context(|| format!("Agent {id} persisted history/Item/payload cannot be read"))?;
    }
    Ok(ids.len())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::{model::AgentDetail, store::Store};
    use serde_json::json;

    pub(crate) fn record() -> AgentDetail {
        serde_json::from_value(json!({
            "agent":{"id":"a","name":"a","cwd":"/fixture","model":"m","color":"sage",
                "threadId":"thread","status":"idle","createdAt":"","updatedAt":"",
                "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[{"id":"turn","status":"completed","items":[
                {"id":"cmd","type":"commandExecution","status":"completed","aggregatedOutput":"payload\n".repeat(2000)}]}],
            "pending":[],"artifacts":[]
        })).unwrap()
    }

    #[test]
    fn same_schema_does_not_make_legacy_record_readers_compatible() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        store.insert(&record()).unwrap();
        let storage = Storage::read(&store.db.read().unwrap()).unwrap();
        assert_eq!(storage.schema, 2);
        assert_eq!(storage.record_layouts, [RECORD_LAYOUT]);
        let bundle = crate::updates::package::fixture(&dir.path().join("candidate"), "candidate");
        storage.readable_by(&bundle.manifest).unwrap();
        let mut old = bundle.manifest.clone();
        old.records.writes = 0;
        old.records.reads_max = 0;
        assert!(storage
            .readable_by(&old)
            .unwrap_err()
            .to_string()
            .contains(&format!("records.layout={RECORD_LAYOUT}")));
        assert!(
            bundle.compatible_with(&old, 2).is_err(),
            "candidate migration cannot strand fallback"
        );
        let mut legacy = serde_json::to_value(&old).unwrap();
        legacy.as_object_mut().unwrap().remove("records");
        assert!(
            serde_json::from_value::<Manifest>(legacy).is_err(),
            "missing capabilities fail closed"
        );
    }

    #[test]
    fn health_assembles_full_payloads_and_refuses_missing_history() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        store.insert(&record()).unwrap();
        assert_eq!(verify_records(&store.db.read().unwrap()).unwrap(), 1);
        {
            let db = store.db.write().unwrap();
            assert!(
                db.execute("UPDATE agent_payloads SET data='invalid json'", [])
                    .unwrap()
                    > 0
            );
        }
        assert!(verify_records(&store.db.read().unwrap()).is_err());
        store
            .db
            .write()
            .unwrap()
            .execute("DELETE FROM agent_items", [])
            .unwrap();
        assert!(verify_records(&store.db.read().unwrap()).is_err());
    }
}
