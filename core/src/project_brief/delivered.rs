//! A report a task's result names as delivered (YN-208): found once when the
//! result is submitted, by its key on its Project's Home, and pinned as its
//! identity on Home and its version; read again each time a request shows
//! it, by that identity and version, never by its key alone, which another
//! report may take later.
use super::{sections, *};

/// The report a result names: its identity on Home, version and title.
pub(crate) struct Named {
    pub identity: i64,
    pub version: i64,
    pub title: String,
}

/// The report `key` of `project` that Home keeps (live, or in its History),
/// at `version`, else as it is now: none when there is no such report, or
/// the section with that key is not a report.
pub(crate) fn named_report(db: &Connection, project: &str, key: &str, version: Option<i64>) -> Result<Option<Named>> {
    if !update::valid_key(key) {
        return Ok(None);
    }
    Ok(sections::find(db, project, key, version)?.filter(|row| row.kind == "report").map(|row| Named {
        identity: row.identity,
        version: row.version,
        title: row.data["title"].as_str().unwrap_or_default().to_owned(),
    }))
}

/// Where a named report stands now: `live` or `history` when Home still
/// keeps that very version of it (in History, possibly with a newer version
/// of the same report), `replaced` when only another version of the same
/// report is kept, `gone` when Home keeps none. With the newest version Home
/// keeps of the same report, if any.
/// Only the versions are read, never a body.
pub(crate) fn report_now(db: &Connection, project: &str, identity: i64, version: i64) -> Result<(&'static str, Option<i64>)> {
    let kept = db
        .prepare_cached(
            "SELECT version,live FROM project_brief_sections WHERE project_id=?1 AND COALESCE(lineage,seq)=?2 AND kind='report'
             AND (live=1 OR history_at>=?3)",
        )?
        .query_map(params![project, identity, sections::history_cutoff()], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let newest = kept.iter().map(|(version, _)| *version).max();
    let state = match kept.iter().find(|(kept, _)| *kept == version) {
        Some((_, true)) => "live",
        Some(_) => "history",
        None if newest.is_some() => "replaced",
        None => "gone",
    };
    Ok((state, newest))
}
