//! Projects group long-running work inside one Workspace. Membership is an
//! explicit fact in link tables: it is never inferred from folders and never
//! stored inside Agent or task JSON, which older Core builds deserialize into
//! typed records and rewrite without unknown fields.
use crate::{model::now, store::Store};
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// Machine ID (`local` or a registered SSH machine) to the folder that
    /// pre-fills new Agents. It is not a boundary for Agent folders.
    #[serde(default)]
    pub default_dirs: BTreeMap<String, String>,
    #[serde(default)]
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Runs on every open. Older builds set the same `user_version`, so this must
/// be idempotent instead of gated on a schema number.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS project_agents(
            agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES projects(id), assigned_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS project_agents_project ON project_agents(project_id);
        CREATE TABLE IF NOT EXISTS project_tasks(
            task_id TEXT PRIMARY KEY REFERENCES collaboration_tasks(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES projects(id), assigned_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS project_tasks_project ON project_tasks(project_id);
        -- Every Core enables foreign keys, so deletions cascade even in older
        -- builds. A manual edit with foreign keys off can still leave orphans.
        DELETE FROM project_agents WHERE agent_id NOT IN (SELECT id FROM agents)
            OR project_id NOT IN (SELECT id FROM projects);
        DELETE FROM project_tasks WHERE task_id NOT IN (SELECT id FROM collaboration_tasks)
            OR project_id NOT IN (SELECT id FROM projects);",
    )?;
    Ok(())
}

fn validate_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 100 || name.chars().any(char::is_control) {
        bail!("Project name must be 1–100 bytes without control characters");
    }
    Ok(name.into())
}

fn load(db: &Connection, id: &str) -> Result<Project> {
    let raw: Option<String> = db
        .query_row("SELECT data FROM projects WHERE id=?1", [id], |r| r.get(0))
        .optional()?;
    Ok(serde_json::from_str(&raw.context("project_not_found: Project does not exist")?)?)
}

fn all(db: &Connection) -> Result<Vec<Project>> {
    let mut query = db.prepare("SELECT data FROM projects ORDER BY rowid")?;
    let rows = query.query_map([], |r| r.get::<_, String>(0))?;
    rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
}

fn ensure_unique_name(db: &Connection, name: &str, except: Option<&str>) -> Result<()> {
    let taken = all(db)?.into_iter().any(|p| {
        p.archived_at.is_none() && Some(p.id.as_str()) != except && p.name.to_lowercase() == name.to_lowercase()
    });
    ensure!(!taken, "Another active project is already called {name}");
    Ok(())
}

fn save(db: &Connection, project: &Project) -> Result<()> {
    db.execute(
        "UPDATE projects SET data=?1 WHERE id=?2",
        params![serde_json::to_string(project)?, project.id],
    )?;
    Ok(())
}

pub(crate) fn ensure_exists(db: &Connection, id: &str) -> Result<()> {
    load(db, id).map(|_| ())
}

pub(crate) fn is_archived(db: &Connection, id: &str) -> Result<bool> {
    Ok(load(db, id)?.archived_at.is_some())
}

/// What an Agent needs to address a project: every project, archived ones marked.
pub(crate) fn summaries(db: &Connection) -> Result<Vec<serde_json::Value>> {
    Ok(all(db)?
        .into_iter()
        .map(|p| serde_json::json!({"id":p.id,"name":p.name,"archived":p.archived_at.is_some()}))
        .collect())
}

/// A project accepts new members only while it is active.
pub(crate) fn ensure_assignable(db: &Connection, id: &str) -> Result<()> {
    let project = load(db, id)?;
    ensure!(
        project.archived_at.is_none(),
        "project_archived: unarchive {} before adding to it",
        project.name
    );
    Ok(())
}

pub(crate) fn agent_project(db: &Connection, agent_id: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT project_id FROM project_agents WHERE agent_id=?1",
            [agent_id],
            |r| r.get(0),
        )
        .optional()?)
}

pub(crate) fn agent_projects(db: &Connection) -> Result<HashMap<String, String>> {
    let mut query = db.prepare("SELECT agent_id,project_id FROM project_agents")?;
    let rows = query.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.map(|r| Ok(r?)).collect()
}

/// Project ID to (name, archived).
pub(crate) fn project_labels(db: &Connection) -> Result<HashMap<String, (String, bool)>> {
    Ok(all(db)?.into_iter().map(|p| (p.id, (p.name, p.archived_at.is_some()))).collect())
}

pub(crate) fn set_agent_project_in(db: &Connection, agent_id: &str, project_id: Option<&str>) -> Result<()> {
    match project_id {
        None => {
            db.execute("DELETE FROM project_agents WHERE agent_id=?1", [agent_id])?;
        }
        Some(project_id) => {
            ensure_assignable(db, project_id)?;
            db.execute(
                "INSERT INTO project_agents(agent_id,project_id,assigned_at) VALUES(?1,?2,?3)
                 ON CONFLICT(agent_id) DO UPDATE SET project_id=excluded.project_id, assigned_at=excluded.assigned_at
                 WHERE project_id!=excluded.project_id",
                params![agent_id, project_id, now()],
            )?;
        }
    }
    Ok(())
}

pub(crate) fn task_projects(db: &Connection, task_ids: &[&str]) -> Result<HashMap<String, String>> {
    if task_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = vec!["?"; task_ids.len()].join(",");
    let mut query = db.prepare(&format!(
        "SELECT task_id,project_id FROM project_tasks WHERE task_id IN ({placeholders})"
    ))?;
    let rows = query.query_map(rusqlite::params_from_iter(task_ids), |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.map(|r| Ok(r?)).collect()
}

pub(crate) fn set_task_project(db: &Connection, task_id: &str, project_id: Option<&str>) -> Result<()> {
    match project_id {
        None => {
            db.execute("DELETE FROM project_tasks WHERE task_id=?1", [task_id])?;
        }
        Some(project_id) => {
            db.execute(
                "INSERT INTO project_tasks(task_id,project_id,assigned_at) VALUES(?1,?2,?3)
                 ON CONFLICT(task_id) DO UPDATE SET project_id=excluded.project_id, assigned_at=excluded.assigned_at
                 WHERE project_id!=excluded.project_id",
                params![task_id, project_id, now()],
            )?;
        }
    }
    Ok(())
}

/// Folder changes are validated on their machine by the caller. `None` removes
/// that machine's default; existing Agents keep their own folders either way.
pub struct ProjectChange {
    pub name: Option<String>,
    pub default_dirs: BTreeMap<String, Option<String>>,
    pub archived: Option<bool>,
}

impl Store {
    pub fn projects(&self) -> Result<Vec<Project>> {
        all(&*self.db.read()?)
    }

    pub fn project(&self, id: &str) -> Result<Project> {
        load(&*self.db.read()?, id)
    }

    pub fn create_project(&self, name: &str, default_dirs: BTreeMap<String, String>) -> Result<Project> {
        let name = validate_name(name)?;
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        ensure_unique_name(&tx, &name, None)?;
        let at = now();
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            default_dirs,
            archived_at: None,
            created_at: at.clone(),
            updated_at: at,
        };
        tx.execute(
            "INSERT INTO projects(id,data) VALUES(?1,?2)",
            params![project.id, serde_json::to_string(&project)?],
        )?;
        tx.commit()?;
        Ok(project)
    }

    pub fn update_project(&self, id: &str, change: ProjectChange) -> Result<Project> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut project = load(&tx, id)?;
        if let Some(archived) = change.archived {
            project.archived_at = match (archived, project.archived_at.take()) {
                (true, Some(at)) => Some(at),
                (true, None) => Some(now()),
                (false, _) => None,
            };
        }
        if let Some(name) = change.name {
            project.name = validate_name(&name)?;
        }
        if project.archived_at.is_none() {
            ensure_unique_name(&tx, &project.name, Some(id))?;
        }
        for (machine, folder) in change.default_dirs {
            match folder {
                Some(folder) => project.default_dirs.insert(machine, folder),
                None => project.default_dirs.remove(&machine),
            };
        }
        project.updated_at = now();
        save(&tx, &project)?;
        tx.commit()?;
        Ok(project)
    }

    /// Only an unused project can be deleted; anything still linked is archived instead.
    pub fn delete_project(&self, id: &str) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let project = load(&tx, id)?;
        let agents: i64 = tx.query_row(
            "SELECT COUNT(*) FROM project_agents WHERE project_id=?1", [id], |r| r.get(0))?;
        let tasks: i64 = tx.query_row(
            "SELECT COUNT(*) FROM project_tasks WHERE project_id=?1", [id], |r| r.get(0))?;
        ensure!(
            agents == 0 && tasks == 0,
            "project_in_use: {} still has {agents} agent(s) and {tasks} task(s); archive it instead",
            project.name
        );
        tx.execute("DELETE FROM projects WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_project_default_dir(&self, id: &str, machine: &str, folder: &str) -> Result<Project> {
        self.update_project(id, ProjectChange {
            name: None,
            default_dirs: BTreeMap::from([(machine.to_owned(), Some(folder.to_owned()))]),
            archived: None,
        })
    }

    /// Changing membership never touches the Agent record, its folder or read state.
    pub fn set_agent_project(&self, agent_id: &str, project_id: Option<&str>) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1)", [agent_id], |r| r.get(0))?;
        ensure!(exists, "Agent does not exist");
        set_agent_project_in(&tx, agent_id, project_id)?;
        tx.commit()?;
        Ok(())
    }

    /// Agents and tasks linked to each project; a project with either can only be archived.
    pub fn project_usage(&self) -> Result<HashMap<String, serde_json::Value>> {
        let db = self.db.read()?;
        let mut usage: HashMap<String, serde_json::Value> = HashMap::new();
        for (table, key) in [("project_agents", "agents"), ("project_tasks", "tasks")] {
            let mut query = db.prepare(&format!("SELECT project_id,COUNT(*) FROM {table} GROUP BY project_id"))?;
            let rows = query.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
            for row in rows {
                let (project, count) = row?;
                let entry = usage.entry(project).or_insert_with(|| serde_json::json!({"agents":0,"tasks":0}));
                entry[key] = count.into();
            }
        }
        Ok(usage)
    }

    pub fn ensure_project_assignable(&self, id: &str) -> Result<()> {
        ensure_assignable(&*self.db.read()?, id)
    }

    pub fn agent_project(&self, agent_id: &str) -> Result<Option<String>> {
        agent_project(&*self.db.read()?, agent_id)
    }
}
