//! Section attachments. A file on the Core host up to 25 MB is copied when
//! its section is written and kept as it was then: a snapshot, stored once
//! by content in `<data dir>/brief-attachments/<sha256>`. A larger file, a
//! directory, a missing path or a remote Agent's file is only referenced
//! and marked as possibly changed; a URL is a link. Charts read snapshots
//! only, so a chart still matches its conclusion after the data file is
//! overwritten by the next run.
//!
//! `project_brief_snapshots` indexes which section row keeps which
//! snapshot. A Brief keeps at most 1 GB of them: history is pruned oldest
//! first; a snapshot a live section shows is never removed. Files no row
//! keeps are deleted by `collect_garbage`, except those a write is about to
//! index (`Hold`).
use super::{sections, update::problem, *};
use axum::http::StatusCode;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};

/// Points per series a chart is sent, and series per chart.
pub(super) const CHART_POINTS: usize = 5000;
pub(super) const CHART_SERIES: usize = 12;
/// A copy that never became a snapshot (Core stopped mid-write) goes after this.
const STALE_TEMPORARY: Duration = Duration::from_secs(3600);

pub(super) fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("brief-attachments")
}

/// One attachment as a write keeps it: `entry` is stored in the section
/// (with Core's own `path` and `sha256`), `sha` names its snapshot.
pub(super) struct Staged {
    pub entry: Value,
    pub sha: Option<String>,
    pub size: u64,
}

/// Snapshot files a write copied or reuses and has not indexed yet.
static HELD: Mutex<BTreeMap<PathBuf, usize>> = Mutex::new(BTreeMap::new());

#[derive(Default)]
pub(crate) struct Hold(Vec<PathBuf>);

impl Hold {
    fn add(&mut self, path: PathBuf) {
        *HELD.lock().unwrap().entry(path.clone()).or_default() += 1;
        self.0.push(path);
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        let mut held = HELD.lock().unwrap();
        for path in self.0.drain(..) {
            if let Some(count) = held.get_mut(&path) {
                *count -= 1;
                if *count == 0 {
                    held.remove(&path);
                }
            }
        }
    }
}

/// Holds every snapshot file now in the cache until the Hold drops, so that
/// `collect_garbage` removes none of them meanwhile. A Workspace backup
/// (T-192) takes it before copying the database, then copies the files that
/// copy names: none can go between the two.
pub(crate) fn hold_all(data_dir: &Path) -> Result<Hold> {
    let cache = dir(data_dir);
    let mut hold = Hold::default();
    // Under the lock collect_garbage scans with: no removal is half-way.
    let mut held = HELD.lock().unwrap();
    let entries = match std::fs::read_dir(&cache) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(hold),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let path = entry?.path();
        *held.entry(path.clone()).or_default() += 1;
        hold.0.push(path);
    }
    Ok(hold)
}

#[cfg(test)]
pub(crate) fn held(path: &Path) -> bool {
    HELD.lock().unwrap().contains_key(path)
}

/// Kind and MIME type by extension; None for one this does not know.
pub(super) fn classify(name: &str) -> Option<(&'static str, &'static str)> {
    let extension = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "gif" => ("image", "image/gif"),
        "webp" => ("image", "image/webp"),
        "svg" => ("image", "image/svg+xml"),
        "avif" => ("image", "image/avif"),
        "bmp" => ("image", "image/bmp"),
        "csv" => ("data", "text/csv"),
        "tsv" => ("data", "text/tab-separated-values"),
        "json" => ("data", "application/json"),
        "jsonl" | "ndjson" => ("data", "application/x-ndjson"),
        "pdf" => ("pdf", "application/pdf"),
        "md" | "markdown" => ("text", "text/markdown; charset=utf-8"),
        "txt" | "log" | "out" | "err" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf" | "xml" | "html" | "htm"
        | "py" | "rs" | "ts" | "tsx" | "js" | "mjs" | "sh" | "c" | "h" | "cpp" | "go" | "java" | "rb" | "sql"
        | "diff" | "patch" => ("text", "text/plain; charset=utf-8"),
        _ => return None,
    })
}

/// Copies or references each put's attachments. Problems are the Agent's
/// to fix; Err is a failure of this Core (its cache cannot be written).
pub(super) fn stage(cache: &Path, data_dir: &Path, remote: bool, sections: &[Value]) -> Result<(Vec<Vec<Staged>>, Vec<Value>, Hold)> {
    let mut hold = Hold::default();
    let (all, problems) = judge(cache, data_dir, remote, sections, Some(&mut hold))?;
    Ok((all, problems, hold))
}

/// The problems `stage` would find, judged the same way, with nothing
/// copied or held (brief_update validateOnly, T-176).
pub(super) fn inspect(cache: &Path, data_dir: &Path, remote: bool, sections: &[Value]) -> Result<Vec<Value>> {
    Ok(judge(cache, data_dir, remote, sections, None)?.1)
}

/// Each put's attachments; a snapshot is copied only with a `hold`.
fn judge(cache: &Path, data_dir: &Path, remote: bool, sections: &[Value], mut hold: Option<&mut Hold>)
    -> Result<(Vec<Vec<Staged>>, Vec<Value>)> {
    let (mut all, mut problems) = (vec![], vec![]);
    // Yuzuno's own data (its database holds Agent credentials) is never shown.
    let own = std::fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_owned());
    for (index, section) in sections.iter().enumerate() {
        let mut staged = vec![];
        for (number, attachment) in section["attachments"].as_array().into_iter().flatten().enumerate() {
            match stage_one(cache, &own, remote, attachment, hold.as_deref_mut())? {
                Ok(one) => staged.push(one),
                Err(reason) => problems.push(problem("attachment_path",
                    format!("changes[{index}].attachments[{number}].path"), reason, "attachments")),
            }
        }
        all.push(staged);
    }
    Ok((all, problems))
}

fn stage_one(cache: &Path, own: &Path, remote: bool, attachment: &Value, hold: Option<&mut Hold>) -> Result<Result<Staged, String>> {
    let name = attachment["name"].as_str().unwrap_or_default();
    let mut entry = json!({"name":name,"takenAt":now()});
    if let Some(caption) = attachment["caption"].as_str() {
        entry["caption"] = json!(caption);
    }
    if let Some(url) = attachment["url"].as_str() {
        for (field, value) in [("kind", json!("link")), ("mime", json!("text/uri-list")), ("size", json!(0)),
            ("snapshot", json!(false)), ("mayChange", json!(true)), ("url", json!(url))] {
            entry[field] = value;
        }
        return Ok(Ok(Staged { entry, sha: None, size: 0 }));
    }
    let Some(path) = attachment["path"].as_str() else {
        return Ok(Err("An attachment needs a path or a url.".into()));
    };
    let path = Path::new(path);
    if !path.is_absolute() {
        return Ok(Err("path must be an absolute path on the Core host, e.g. /home/me/run/loss.csv.".into()));
    }
    let (kind, mime) = classify(&path.to_string_lossy()).or_else(|| classify(name)).unwrap_or(("data", "application/octet-stream"));
    entry["path"] = json!(path);
    let reference = |mut entry: Value, size: u64| -> Result<Result<Staged, String>> {
        for (field, value) in [("kind", json!(kind)), ("mime", json!(mime)), ("size", json!(size)),
            ("snapshot", json!(false)), ("mayChange", json!(true))] {
            entry[field] = value;
        }
        Ok(Ok(Staged { entry, sha: None, size }))
    };
    // Slice 1 copies nothing from other machines.
    if remote {
        return reference(entry, 0);
    }
    let Some(metadata) = std::fs::metadata(path).ok().filter(|metadata| metadata.is_file()) else {
        return reference(entry, 0);
    };
    if metadata.len() > SNAPSHOT_FILE_BYTES {
        return reference(entry, metadata.len());
    }
    let Ok(real) = std::fs::canonicalize(path) else { return reference(entry, 0) };
    if real.starts_with(own) {
        return Ok(Err("Files inside Yuzuno's own data folder cannot be attached.".into()));
    }
    let Some(hold) = hold else {
        // Only judged: read as a copy reads it, kept nowhere.
        let file = std::fs::File::open(&real);
        return match file.and_then(|file| std::io::copy(&mut file.take(SNAPSHOT_FILE_BYTES + 1), &mut std::io::sink())) {
            Ok(size) => reference(entry, size),
            Err(error) => Ok(Err(format!("{} cannot be read: {error}", path.display()))),
        };
    };
    let mut bytes = Vec::new();
    if let Err(error) = std::fs::File::open(&real).and_then(|file| file.take(SNAPSHOT_FILE_BYTES + 1).read_to_end(&mut bytes)) {
        return Ok(Err(format!("{} cannot be read: {error}", path.display())));
    }
    if bytes.len() as u64 > SNAPSHOT_FILE_BYTES {
        return reference(entry, bytes.len() as u64);
    }
    let sha = format!("{:x}", Sha256::digest(&bytes));
    let target = cache.join(&sha);
    hold.add(target.clone());
    if !target.is_file() {
        write_snapshot(cache, &target, &bytes)?;
    }
    let (kind, mime) = classify(&path.to_string_lossy()).or_else(|| classify(name)).unwrap_or_else(|| {
        if std::str::from_utf8(&bytes).is_ok() { ("text", "text/plain; charset=utf-8") } else { ("data", "application/octet-stream") }
    });
    let size = bytes.len() as u64;
    for (field, value) in [("kind", json!(kind)), ("mime", json!(mime)), ("size", json!(size)),
        ("snapshot", json!(true)), ("mayChange", json!(false)), ("sha256", json!(sha))] {
        entry[field] = value;
    }
    Ok(Ok(Staged { entry, sha: Some(sha), size }))
}

fn write_snapshot(cache: &Path, target: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::create_dir_all(cache).with_context(|| format!("cannot create {}", cache.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(cache, std::fs::Permissions::from_mode(0o700))?;
    }
    let temporary = cache.join(format!(".tmp-{}", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options.open(&temporary).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(error) = written.and_then(|_| std::fs::rename(&temporary, target)) {
        let _ = std::fs::remove_file(&temporary);
        return Err(anyhow::Error::from(error).context("cannot keep an attachment snapshot"));
    }
    Ok(())
}

/// The snapshots section row `seq` keeps, replacing what it kept before.
pub(super) fn index(db: &Connection, seq: i64, project: &str, staged: &[Staged]) -> Result<()> {
    db.execute("DELETE FROM project_brief_snapshots WHERE section_seq=?1", [seq])?;
    for one in staged {
        if let Some(sha) = &one.sha {
            db.execute(
                "INSERT OR IGNORE INTO project_brief_snapshots(section_seq,project_id,sha256,size) VALUES(?1,?2,?3,?4)",
                params![seq, project, sha, one.size as i64],
            )?;
        }
    }
    Ok(())
}

/// Snapshot bytes the Brief keeps, each file counted once.
pub(super) fn snapshot_bytes(db: &Connection, project: &str) -> Result<u64> {
    let bytes: i64 = db.query_row(
        "SELECT COALESCE(SUM(size),0) FROM
         (SELECT MAX(size) AS size FROM project_brief_snapshots WHERE project_id=?1 GROUP BY sha256)",
        [project],
        |r| r.get(0),
    )?;
    Ok(bytes as u64)
}

/// A history entry stops keeping its snapshots: they become references.
fn release(db: &Connection, seq: i64) -> Result<()> {
    db.execute("DELETE FROM project_brief_snapshots WHERE section_seq=?1", [seq])?;
    let data: String = db.query_row("SELECT data FROM project_brief_sections WHERE seq=?1", [seq], |r| r.get(0))?;
    let mut data: Value = serde_json::from_str(&data)?;
    for attachment in data["attachments"].as_array_mut().into_iter().flatten() {
        if attachment["snapshot"] == true {
            attachment["snapshot"] = json!(false);
            attachment["mayChange"] = json!(true);
            attachment.as_object_mut().unwrap().remove("sha256");
        }
    }
    db.execute("UPDATE project_brief_sections SET data=?2 WHERE seq=?1", params![seq, data.to_string()])?;
    Ok(())
}

/// Brings the Brief within `cap` bytes of snapshots by releasing its oldest
/// history first. False if its live sections alone exceed it.
pub(super) fn prune(db: &Connection, project: &str, cap: u64) -> Result<bool> {
    while snapshot_bytes(db, project)? > cap {
        let oldest: Option<i64> = db.query_row(
            "SELECT s.seq FROM project_brief_sections s WHERE s.project_id=?1 AND s.live=0
             AND EXISTS(SELECT 1 FROM project_brief_snapshots r WHERE r.section_seq=s.seq)
             ORDER BY s.history_at, s.seq LIMIT 1",
            [project],
            |r| r.get(0),
        ).optional()?;
        let Some(seq) = oldest else { return Ok(false) };
        release(db, seq)?;
    }
    Ok(true)
}

/// Deletes snapshot files no section keeps and no write holds. Returns the
/// bytes and files removed.
pub(crate) fn collect_garbage(store: &Store, cache: &Path) -> Result<(u64, usize)> {
    let held = HELD.lock().unwrap();
    let kept: HashSet<String> = {
        let db = store.db.read()?;
        let mut query = db.prepare("SELECT DISTINCT sha256 FROM project_brief_snapshots")?;
        let rows = query.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let entries = match std::fs::read_dir(cache) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(error) => return Err(error.into()),
    };
    let (mut bytes, mut files) = (0, 0);
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let metadata = entry.metadata()?;
        let unused = if name.starts_with(".tmp-") {
            metadata.modified().ok().and_then(|at| SystemTime::now().duration_since(at).ok()).is_some_and(|age| age > STALE_TEMPORARY)
        } else {
            name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit()) && !kept.contains(&name) && !held.contains_key(&entry.path())
        };
        if unused && metadata.is_file() && std::fs::remove_file(entry.path()).is_ok() {
            bytes += metadata.len();
            files += 1;
        }
    }
    Ok((bytes, files))
}

/// `POST /api/brief-cache/clear`: history keeps no snapshots, expired
/// history goes, and files nothing keeps are deleted. Live sections keep
/// theirs.
pub(super) fn clear(store: &Store, cache: &Path) -> Result<Value> {
    let released = {
        let mut writer = store.db.write()?;
        let tx = writer.transaction()?;
        sections::expire_history(&tx)?;
        let seqs: Vec<i64> = {
            let mut query = tx.prepare(
                "SELECT DISTINCT s.seq FROM project_brief_sections s JOIN project_brief_snapshots r ON r.section_seq=s.seq
                 WHERE s.live=0",
            )?;
            let rows = query.query_map([], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for seq in &seqs {
            release(&tx, *seq)?;
        }
        tx.commit()?;
        seqs.len()
    };
    let (bytes, files) = collect_garbage(store, cache)?;
    Ok(json!({"historySections":released,"removedFiles":files,"freedBytes":bytes}))
}

/// Why a stored file or chart cannot be served.
pub(super) struct Missing {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

fn missing(status: StatusCode, code: &'static str, message: impl Into<String>) -> Missing {
    Missing { status, code, message: message.into() }
}

fn find_section(store: &Store, project: &str, key: &str, version: Option<i64>) -> Result<Result<sections::Row, Missing>> {
    let row = sections::find(&*store.db.read()?, project, key, version)?;
    Ok(row.ok_or_else(|| missing(StatusCode::NOT_FOUND, "section_not_found", "No such section in this Brief")))
}

fn snapshot_of(cache: &Path, row: &sections::Row, name: &str) -> Result<(PathBuf, Value), Missing> {
    let attachment = row.data["attachments"].as_array().into_iter().flatten().find(|a| a["name"] == name)
        .ok_or_else(|| missing(StatusCode::NOT_FOUND, "attachment_not_found", "The section has no attachment with this name"))?;
    let sha = attachment["sha256"].as_str().filter(|_| attachment["snapshot"] == true).ok_or_else(|| {
        missing(StatusCode::CONFLICT, "not_snapshot", "This attachment is only a reference; Core kept no copy of it")
    })?;
    let path = cache.join(sha);
    if !path.is_file() {
        return Err(missing(StatusCode::GONE, "snapshot_missing", "The snapshot of this attachment is no longer kept"));
    }
    Ok((path, attachment.clone()))
}

/// The snapshot file and its MIME type.
pub(super) fn snapshot_file(store: &Store, cache: &Path, project: &str, key: &str, name: &str, version: Option<i64>)
    -> Result<Result<(PathBuf, String), Missing>> {
    let row = match find_section(store, project, key, version)? {
        Ok(row) => row,
        Err(missing) => return Ok(Err(missing)),
    };
    Ok(snapshot_of(cache, &row, name).map(|(path, attachment)| {
        (path, attachment["mime"].as_str().unwrap_or("application/octet-stream").to_owned())
    }))
}

/// A data file's rows: a CSV (or TSV) with a header row, a JSON array of
/// objects, or JSONL with one object per line.
enum Table {
    Text { header: Vec<String>, rows: Vec<Vec<String>> },
    Objects(Vec<Value>),
}

impl Table {
    fn parse(bytes: &[u8], name: &str) -> Result<Table, String> {
        let text = std::str::from_utf8(bytes).map_err(|_| "The data file is not UTF-8 text".to_owned())?;
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let extension = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
        match extension.as_str() {
            "json" => match serde_json::from_str::<Value>(text) {
                Ok(Value::Array(rows)) => Ok(Table::Objects(rows)),
                Ok(_) => Err("A JSON data file must be an array of objects".into()),
                Err(error) => Err(format!("The JSON data file is unreadable: {error}")),
            },
            "jsonl" | "ndjson" => text
                .lines()
                .filter(|line| !line.trim().is_empty())
                .enumerate()
                .map(|(number, line)| serde_json::from_str(line).map_err(|error| format!("Line {} is not JSON: {error}", number + 1)))
                .collect::<Result<_, _>>()
                .map(Table::Objects),
            _ => {
                let mut rows = delimited(text, if extension == "tsv" { '\t' } else { ',' });
                if rows.is_empty() {
                    return Err("The CSV data file is empty".into());
                }
                let header = rows.remove(0).into_iter().map(|cell| cell.trim().to_owned()).collect();
                Ok(Table::Text { header, rows })
            }
        }
    }

    /// Each row's value in `column`, None where it has none.
    fn column(&self, column: &str) -> Result<Vec<Option<Value>>, String> {
        match self {
            Table::Text { header, rows } => {
                let index = header.iter().position(|name| name == column).ok_or_else(|| format!("The data file has no column {column}"))?;
                Ok(rows.iter().map(|row| row.get(index).map(|cell| json!(cell.trim()))).collect())
            }
            Table::Objects(rows) => {
                if !rows.iter().any(|row| row.get(column).is_some()) {
                    return Err(format!("The data file has no column {column}"));
                }
                Ok(rows.iter().map(|row| row.get(column).filter(|value| !value.is_null()).cloned()).collect())
            }
        }
    }
}

/// RFC 4180 fields: quoted fields may hold separators, quotes ("") and line breaks.
fn delimited(text: &str, separator: char) -> Vec<Vec<String>> {
    let (mut rows, mut row, mut field) = (vec![], vec![], String::new());
    let (mut quoted, mut chars) = (false, text.chars().peekable());
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            '"' if quoted => quoted = false,
            '"' if field.is_empty() => quoted = true,
            c if c == separator && !quoted => row.push(std::mem::take(&mut field)),
            '\r' if !quoted => {}
            '\n' if !quoted => {
                row.push(std::mem::take(&mut field));
                if !(row.len() == 1 && row[0].is_empty()) {
                    rows.push(std::mem::take(&mut row));
                }
                row.clear();
            }
            c => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|n| n.is_finite())
}

/// Largest-Triangle-Three-Buckets: the indices of at most `limit` points
/// that keep a line's shape, first and last included.
pub(super) fn lttb(points: &[(f64, f64)], limit: usize) -> Vec<usize> {
    let n = points.len();
    if limit >= n || limit < 3 {
        return stride(n, limit);
    }
    let every = (n - 2) as f64 / (limit - 2) as f64;
    let mut kept = Vec::with_capacity(limit);
    kept.push(0);
    let mut previous = 0;
    for bucket in 0..limit - 2 {
        let next_start = ((bucket + 1) as f64 * every) as usize + 1;
        let next_end = (((bucket + 2) as f64 * every) as usize + 1).min(n);
        let (next_start, next_end) = if next_start >= next_end { (n - 1, n) } else { (next_start, next_end) };
        let span = (next_end - next_start) as f64;
        let (mut ax, mut ay) = (0.0, 0.0);
        for point in &points[next_start..next_end] {
            ax += point.0;
            ay += point.1;
        }
        let (ax, ay) = (ax / span, ay / span);
        let start = (bucket as f64 * every) as usize + 1;
        let end = (((bucket + 1) as f64 * every) as usize + 1).min(n - 1).max(start + 1);
        let (px, py) = points[previous];
        let mut best = start;
        let mut largest = -1.0;
        for (index, point) in points.iter().enumerate().take(end).skip(start) {
            let area = ((px - ax) * (point.1 - py) - (px - point.0) * (ay - py)).abs();
            if area > largest {
                largest = area;
                best = index;
            }
        }
        kept.push(best);
        previous = best;
    }
    kept.push(n - 1);
    kept
}

/// Evenly spaced indices, first and last included.
fn stride(n: usize, limit: usize) -> Vec<usize> {
    if n <= limit {
        return (0..n).collect();
    }
    if limit < 2 {
        return (0..limit).collect();
    }
    let mut kept: Vec<usize> = (0..limit).map(|i| (i as f64 * (n - 1) as f64 / (limit - 1) as f64).round() as usize).collect();
    kept.dedup();
    kept
}

/// One chart's series from its data attachment, at most `CHART_POINTS` per
/// series and `CHART_SERIES` series.
pub(super) fn chart(store: &Store, cache: &Path, project: &str, key: &str, element: &str, version: Option<i64>)
    -> Result<Result<Value, Missing>> {
    let row = match find_section(store, project, key, version)? {
        Ok(row) => row,
        Err(missing) => return Ok(Err(missing)),
    };
    // `element` is the chart's key in body.elements.
    let Some(node) = row.data["body"]["elements"].get(element).filter(|node| node.is_object()) else {
        return Ok(Err(missing(StatusCode::NOT_FOUND, "element_not_found", "The section has no chart with this id")));
    };
    let kind = node["type"].as_str().unwrap_or_default();
    if !matches!(kind, "LineChart" | "BarChart" | "ScatterChart") {
        return Ok(Err(missing(StatusCode::NOT_FOUND, "element_not_found", "This element is not a chart")));
    }
    let props = &node["props"];
    let data = &props["data"];
    let Some(name) = data["attachment"].as_str() else {
        return Ok(Err(missing(StatusCode::CONFLICT, "inline_chart", "This chart's points are in the section itself")));
    };
    let (path, attachment) = match snapshot_of(cache, &row, name) {
        Ok(found) => found,
        Err(missing) => return Ok(Err(missing)),
    };
    let unreadable = |reason: String| -> Result<Result<Value, Missing>> {
        Ok(Err(missing(StatusCode::UNPROCESSABLE_ENTITY, "unreadable_data", reason)))
    };
    let bytes = std::fs::read(&path)?;
    let source = attachment["path"].as_str().unwrap_or(name);
    let table = match Table::parse(&bytes, if classify(source).is_some() { source } else { name }) {
        Ok(table) => table,
        Err(reason) => return unreadable(reason),
    };
    let column = data["x"].as_str().unwrap_or_default();
    let xs = match table.column(column) {
        Ok(xs) => xs,
        Err(reason) => return unreadable(reason),
    };
    let (mut series, mut source_points, mut downsampled) = (vec![], 0, false);
    for wanted in data["series"].as_array().into_iter().flatten().take(CHART_SERIES) {
        let ys = match table.column(wanted["column"].as_str().unwrap_or_default()) {
            Ok(ys) => ys,
            Err(reason) => return unreadable(reason),
        };
        // (x as sent, x as a number when it is one, y)
        let mut points: Vec<(Value, Option<f64>, f64)> = vec![];
        for (x, y) in xs.iter().zip(&ys) {
            let (Some(x), Some(y)) = (x, y.as_ref().and_then(number)) else { continue };
            match number(x) {
                Some(n) => points.push((json!(n), Some(n), y)),
                // Labels only for line and bar charts; a scatter needs numbers.
                None if kind != "ScatterChart" && x.as_str().is_some_and(|label| !label.is_empty()) => {
                    points.push((x.clone(), None, y))
                }
                None => {}
            }
        }
        source_points += points.len();
        let keep = if points.len() <= CHART_POINTS {
            (0..points.len()).collect()
        } else if kind == "LineChart" && points.iter().all(|p| p.1.is_some()) {
            let line: Vec<(f64, f64)> = points.iter().map(|p| (p.1.unwrap(), p.2)).collect();
            lttb(&line, CHART_POINTS)
        } else {
            stride(points.len(), CHART_POINTS)
        };
        downsampled |= keep.len() < points.len();
        let kept: Vec<Value> = keep.into_iter().map(|i| json!([points[i].0, points[i].2])).collect();
        series.push(json!({"name":wanted["name"],"points":kept}));
    }
    Ok(Ok(json!({"key":row.key,"version":row.version,"elementId":element,"type":kind,"title":props["title"],
        "x":props["x"],"y":props["y"],"attachment":name,"series":series,"downsampled":downsampled,"sourcePoints":source_points})))
}
