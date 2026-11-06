//! Per-Project task keys (T-56). A Project has a short key, made from its name
//! and editable; a task created in a Project, or moved into one, gets
//! `<KEY>-<n>`, that Project's next number. A task in no Project, and every task
//! that had its number before this, keeps `T-<seq>`. `seq` stays the global,
//! stable internal number, so `T-<seq>` resolves every task forever.
//!
//! Every key a task or a Project ever had resolves forever: a Project's old keys
//! stay in project_key_history (and stay reserved), a task's old numbers in
//! task_key_history. All of it is additive: a nullable `projects.key` column and
//! new tables. Older Core builds keep reading and writing `projects.data` and
//! `project_tasks` as before; a task they move keeps its history and shows
//! `T-<seq>` until it is moved again here. A Project they delete takes its
//! `projects` row and so its key with it; every key given is also in
//! project_keys_given, which they never touch, and the next open here retires
//! that key into project_key_history.
use crate::model::now;
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// Runs on every open after projects::migrate, like every migration here:
/// idempotent, never gated on `user_version`.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    let has_key = db.prepare("SELECT 1 FROM pragma_table_info('projects') WHERE name='key'")?.exists([])?;
    if !has_key {
        db.execute_batch("ALTER TABLE projects ADD COLUMN key TEXT")?;
    }
    db.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS projects_key ON projects(key) WHERE key IS NOT NULL;
        CREATE TABLE IF NOT EXISTS project_counters(project_id TEXT PRIMARY KEY, last INTEGER NOT NULL);
        -- No foreign keys: a deleted Project's keys stay reserved and resolvable.
        CREATE TABLE IF NOT EXISTS project_key_history(
            key TEXT PRIMARY KEY, project_id TEXT NOT NULL, retired_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS project_key_history_project ON project_key_history(project_id, retired_at);
        -- Every key ever given to a Project, kept where an older Core never writes.
        CREATE TABLE IF NOT EXISTS project_keys_given(
            key TEXT PRIMARY KEY, project_id TEXT NOT NULL, given_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS task_key_history(
            project_id TEXT NOT NULL, number INTEGER NOT NULL, task_id TEXT NOT NULL,
            assigned_at TEXT NOT NULL, retired_at TEXT, PRIMARY KEY(project_id, number));
        CREATE INDEX IF NOT EXISTS task_key_history_task ON task_key_history(task_id);
        CREATE UNIQUE INDEX IF NOT EXISTS task_key_history_current ON task_key_history(task_id) WHERE retired_at IS NULL;",
    )?;
    // Before any key is filled, so none of them can take a deleted Project's.
    retire_deleted(db)?;
    fill_missing(db)
}

/// A Project an older Core deleted (its `projects` row gone, nothing more):
/// each key it was given and not yet retired is retired now, so it stays
/// reserved and keeps naming the tasks it had, as after a delete here.
fn retire_deleted(db: &Connection) -> Result<()> {
    db.execute(
        "INSERT INTO project_key_history(key,project_id,retired_at)
         SELECT g.key, g.project_id, ?1 FROM project_keys_given g
         WHERE NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=g.project_id)
           AND NOT EXISTS(SELECT 1 FROM project_key_history h WHERE h.key=g.key)",
        [now()],
    )?;
    Ok(())
}

/// Records `key` as given to `project_id`, beside every write of `projects.key`.
fn given(db: &Connection, project_id: &str, key: &str) -> Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO project_keys_given(key,project_id,given_at) VALUES(?1,?2,?3)",
        params![key, project_id, now()],
    )?;
    Ok(())
}

/// Every Project without a key gets one, in creation order, each checked
/// against the keys already taken (those filled earlier in this pass included),
/// so two Cores opening the same database pick the same keys.
fn fill_missing(db: &Connection) -> Result<()> {
    let tx = db.unchecked_transaction()?;
    let missing: Vec<(String, String)> = {
        let mut query = tx.prepare(
            "SELECT id, COALESCE(json_extract(data,'$.name'),'') FROM projects WHERE key IS NULL ORDER BY rowid",
        )?;
        let rows = query.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (id, name) in missing {
        let key = generate(&name, |key| taken(&tx, key))?;
        tx.execute("UPDATE projects SET key=?1 WHERE id=?2 AND key IS NULL", params![key, id])?;
        given(&tx, &id, &key)?;
    }
    tx.commit()?;
    Ok(())
}

/// A key: an uppercase letter, then 1–9 uppercase letters or digits. `T` alone
/// can never be one, so `T-<n>` always means the global number.
pub(crate) fn valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars.next().is_some_and(|c| c.is_ascii_uppercase())
        && (2..=10).contains(&key.len())
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// Taken by any Project now or ever: Project keys are unique in the Workspace
/// and an old key is never handed to another Project.
pub(crate) fn taken(db: &Connection, key: &str) -> Result<bool> {
    Ok(key == "T"
        || db.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE key=?1) OR EXISTS(SELECT 1 FROM project_key_history WHERE key=?1)",
            [key],
            |r| r.get(0),
        )?)
}

/// A key made from a Project's name. Two or more ASCII words give their
/// initials (`yuzuno-next` → `YN`); one word its first three characters
/// (`Northstar` → `NOR`). Words split at anything that is not an ASCII letter or
/// digit, and at a lowercase-to-uppercase step. A name without an ASCII letter
/// gets `P<n>`, the smallest number free. A key already taken gets the smallest
/// suffix 2, 3, … that is free, its base cut to keep 10 characters.
pub(crate) fn generate(name: &str, mut taken: impl FnMut(&str) -> Result<bool>) -> Result<String> {
    let Some(base) = base(name) else {
        for n in 1u64.. {
            let key = format!("P{n}");
            if !taken(&key)? {
                return Ok(key);
            }
        }
        unreachable!("an unbounded range yields a free key")
    };
    if !taken(&base)? {
        return Ok(base);
    }
    for n in 2u64.. {
        let suffix = n.to_string();
        let key = format!("{}{suffix}", &base[..base.len().min(10 - suffix.len())]);
        if !taken(&key)? {
            return Ok(key);
        }
    }
    unreachable!("an unbounded range yields a free key")
}

fn base(name: &str) -> Option<String> {
    if !name.chars().any(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut previous_lower = false;
    for c in name.chars() {
        if !c.is_ascii_alphanumeric() {
            words.extend((!word.is_empty()).then(|| std::mem::take(&mut word)));
            previous_lower = false;
            continue;
        }
        if c.is_ascii_uppercase() && previous_lower {
            words.push(std::mem::take(&mut word));
        }
        previous_lower = c.is_ascii_lowercase();
        word.push(c.to_ascii_uppercase());
    }
    words.extend((!word.is_empty()).then_some(word));
    let mut key: String = match words.as_slice() {
        [one] => one.chars().take(3).collect(),
        many => many.iter().filter_map(|w| w.chars().next()).collect(),
    };
    if !key.starts_with(|c: char| c.is_ascii_uppercase()) {
        key.insert(0, 'P');
    }
    key.truncate(10);
    valid_key(&key).then_some(key)
}

/// A Project's current key, None for one an older Core created since the last open.
pub(crate) fn project_key(db: &Connection, project_id: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT key FROM projects WHERE id=?1", [project_id], |r| r.get::<_, Option<String>>(0))
        .optional()?
        .flatten())
}

/// The key a new Project starts with.
pub(crate) fn assign(db: &Connection, project_id: &str, name: &str) -> Result<String> {
    let key = generate(name, |key| taken(db, key))?;
    db.execute("UPDATE projects SET key=?1 WHERE id=?2", params![key, project_id])?;
    given(db, project_id, &key)?;
    Ok(key)
}

/// The user's new key for a Project. Its current key goes to history, where it
/// keeps resolving and stays reserved; a Project may take back its own old key.
pub(crate) fn set(db: &Connection, project_id: &str, key: &str) -> Result<()> {
    ensure!(
        valid_key(key),
        "invalid_input: a Project key is an uppercase letter followed by 1–9 uppercase letters or digits, for example YN"
    );
    let current = project_key(db, project_id)?;
    if current.as_deref() == Some(key) {
        return Ok(());
    }
    let owner: Option<String> = db
        .query_row("SELECT id FROM projects WHERE key=?1", [key], |r| r.get(0))
        .optional()?
        .or(db.query_row("SELECT project_id FROM project_key_history WHERE key=?1", [key], |r| r.get(0)).optional()?);
    ensure!(
        owner.as_deref().is_none_or(|owner| owner == project_id),
        "project_key_taken: {key} is or was another Project's key, and keys are never reused"
    );
    if let Some(current) = current {
        retire(db, project_id, &current)?;
    }
    db.execute("DELETE FROM project_key_history WHERE key=?1", [key])?;
    db.execute("UPDATE projects SET key=?1 WHERE id=?2", params![key, project_id])?;
    given(db, project_id, key)?;
    Ok(())
}

fn retire(db: &Connection, project_id: &str, key: &str) -> Result<()> {
    db.execute(
        "INSERT INTO project_key_history(key,project_id,retired_at) VALUES(?1,?2,?3)
         ON CONFLICT(key) DO UPDATE SET retired_at=excluded.retired_at",
        params![key, project_id, now()],
    )?;
    Ok(())
}

/// A deleted Project's key stays reserved and keeps resolving its tasks' old keys.
pub(crate) fn project_deleted(db: &Connection, project_id: &str) -> Result<()> {
    if let Some(key) = project_key(db, project_id)? {
        retire(db, project_id, &key)?;
    }
    Ok(())
}

/// A task's Project changed (projects::set_task_project, only on a real
/// change). Its current number retires and stays resolvable; in a Project it
/// gets that Project's next number, which is never given again.
pub(crate) fn moved(db: &Connection, task_id: &str, to: Option<&str>) -> Result<()> {
    let at = now();
    db.execute(
        "UPDATE task_key_history SET retired_at=?2 WHERE task_id=?1 AND retired_at IS NULL",
        params![task_id, at],
    )?;
    if let Some(project) = to {
        let number: i64 = db.query_row(
            "INSERT INTO project_counters(project_id,last) VALUES(?1,1)
             ON CONFLICT(project_id) DO UPDATE SET last=last+1 RETURNING last",
            [project],
            |r| r.get(0),
        )?;
        db.execute(
            "INSERT INTO task_key_history(project_id,number,task_id,assigned_at) VALUES(?1,?2,?3,?4)",
            params![project, number, task_id, at],
        )?;
    }
    Ok(())
}

// The current key of the collaboration_tasks row `c`.
const CURRENT: &str = "COALESCE((SELECT p.key||'-'||h.number FROM task_key_history h
      JOIN project_tasks m ON m.task_id=h.task_id AND m.project_id=h.project_id
      JOIN projects p ON p.id=h.project_id
      WHERE h.task_id=c.id AND h.retired_at IS NULL AND p.key IS NOT NULL), 'T-'||c.seq)";

/// A task's current key from its internal ID: `<its Project's key>-<n>` while
/// the number it got there is current and it is still in that Project, else
/// `T-<seq>`. None for a task that does not exist.
pub(crate) fn current(db: &Connection, task_id: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(&format!("SELECT {CURRENT} FROM collaboration_tasks c WHERE c.id=?1"), [task_id], |r| r.get(0))
        .optional()?)
}

/// The task a `<KEY>-<n>` names, by a Project's current or old key and any
/// number the task ever had there. None if no task had it.
pub(crate) fn resolve(db: &Connection, key: &str, number: i64) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT h.task_id FROM task_key_history h WHERE h.number=?2 AND h.project_id=COALESCE(
               (SELECT id FROM projects WHERE key=?1), (SELECT project_id FROM project_key_history WHERE key=?1))",
            params![key, number],
            |r| r.get(0),
        )
        .optional()?)
}

/// Every form that names this task (task_get's `keys`): its global `T-<seq>`
/// and the Project numbers it had before, each with its Project's key now (or
/// the last one it had, for a deleted Project).
pub(crate) fn keys(db: &Connection, task_id: &str) -> Result<Value> {
    let (seq, current): (i64, String) = db
        .query_row(&format!("SELECT c.seq, {CURRENT} FROM collaboration_tasks c WHERE c.id=?1"), [task_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .context("task_not_found: Task does not exist")?;
    let mut query = db.prepare(
        "SELECT COALESCE((SELECT key FROM projects WHERE id=h.project_id),
            (SELECT key FROM project_key_history WHERE project_id=h.project_id ORDER BY retired_at DESC LIMIT 1))
            ||'-'||h.number
         FROM task_key_history h WHERE h.task_id=?1 ORDER BY h.assigned_at, h.rowid",
    )?;
    let history = query
        .query_map([task_id], |r| r.get::<_, Option<String>>(0))?
        .filter_map(|key| key.transpose())
        .collect::<rusqlite::Result<Vec<String>>>()?
        .into_iter()
        .filter(|key| *key != current)
        .collect::<Vec<_>>();
    Ok(json!({"global":format!("T-{seq}"),"history":history}))
}

/// A response's stored task references as they read now. Records keep the key
/// they were written with (`taskRef`, `taskReference`); a read shows the task's
/// current key, found by the `taskId` beside it. A reference that no longer
/// resolves is left as it was written.
pub(crate) fn refresh(db: &Connection, value: &mut Value) {
    let mut seen = std::collections::HashMap::new();
    refresh_in(db, value, &mut seen);
}

fn refresh_in(db: &Connection, value: &mut Value, seen: &mut std::collections::HashMap<String, Option<String>>) {
    match value {
        Value::Object(map) => {
            let fields = ["taskRef", "taskReference"];
            if let Some(task) = map.get("taskId").and_then(Value::as_str).map(str::to_owned) {
                if fields.iter().any(|field| map.get(*field).is_some_and(Value::is_string)) {
                    let key = seen.entry(task.clone()).or_insert_with(|| {
                        let (id, _) = crate::collaboration_store::task_key(db, &task).ok()?;
                        current(db, &id).ok().flatten()
                    });
                    if let Some(key) = key {
                        for field in fields {
                            if map.get(field).is_some_and(Value::is_string) {
                                map.insert(field.into(), json!(key));
                            }
                        }
                    }
                }
            }
            for value in map.values_mut() {
                refresh_in(db, value, seen);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|value| refresh_in(db, value, seen)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn made(name: &str, taken: &[&str]) -> String {
        generate(name, |key| Ok(taken.contains(&key))).unwrap()
    }

    #[test]
    fn a_projects_key_is_made_from_its_name() {
        // Two or more words: their initials; one word: its first three characters.
        assert_eq!(made("yuzuno-next", &[]), "YN");
        assert_eq!(made("Home v1 redesign", &[]), "HVR");
        assert_eq!(made("Northstar", &[]), "NOR");
        assert_eq!(made("ab", &[]), "AB");
        // A lowercase-to-uppercase step starts a word.
        assert_eq!(made("yuzunoNext", &[]), "YN");
        // A key starts with a letter.
        assert_eq!(made("2024 plan", &[]), "P2P");
        // At most ten characters.
        assert_eq!(made("a b c d e f g h i j k l", &[]), "ABCDEFGHIJ");
        // ASCII words in a mixed name are its words.
        assert_eq!(made("Atlas 研究", &[]), "ATL");
    }

    #[test]
    fn a_name_without_an_ascii_letter_gets_the_smallest_free_p_number() {
        assert_eq!(made("研究プロジェクト", &[]), "P1");
        assert_eq!(made("研究", &["P1"]), "P2");
        assert_eq!(made("2024", &["P1", "P2"]), "P3");
        // One letter is not enough for a key.
        assert_eq!(made("x", &[]), "P1");
    }

    #[test]
    fn a_taken_key_gets_the_smallest_free_suffix_within_ten_characters() {
        assert_eq!(made("yuzuno-next", &["YN"]), "YN2");
        assert_eq!(made("yuzuno-next", &["YN", "YN2", "YN3"]), "YN4");
        assert_eq!(made("a b c d e f g h i j", &["ABCDEFGHIJ"]), "ABCDEFGHI2");
        let many: Vec<String> = std::iter::once("ABCDEFGHIJ".to_owned()).chain((2..10).map(|n| format!("ABCDEFGHI{n}"))).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert_eq!(made("a b c d e f g h i j", &many), "ABCDEFGH10");
    }

    #[test]
    fn t_alone_is_never_a_key_and_keys_are_canonical_uppercase() {
        assert!(!valid_key("T"));
        assert!(valid_key("T1"));
        assert!(valid_key("YN"));
        assert!(valid_key("ABCDEFGHIJ"));
        for bad in ["", "Y", "yn", "Yn", "1N", "ABCDEFGHIJK", "Y-N", "YÑ"] {
            assert!(!valid_key(bad), "{bad:?} is no key");
        }
    }

    #[test]
    fn refresh_shows_a_stored_reference_by_the_tasks_key_now() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        let db = store.db.write().unwrap();
        db.execute("INSERT INTO collaboration_tasks(id,version,data) VALUES('t',1,'{}')", []).unwrap();
        db.execute("INSERT INTO projects(id,data,key) VALUES('p','{}','YN')", []).unwrap();
        db.execute("INSERT INTO project_tasks(task_id,project_id,assigned_at) VALUES('t','p','x')", []).unwrap();
        moved(&db, "t", Some("p")).unwrap();
        let mut stored = json!({"jobs":[{"taskId":"t","taskRef":"T-1"},{"taskId":"T-1","taskReference":"T-1"},
            {"taskId":"gone","taskRef":"T-9"},{"taskRef":"T-1"}]});
        refresh(&db, &mut stored);
        assert_eq!(stored, json!({"jobs":[{"taskId":"t","taskRef":"YN-1"},{"taskId":"T-1","taskReference":"YN-1"},
            {"taskId":"gone","taskRef":"T-9"},{"taskRef":"T-1"}]}));
    }
}
