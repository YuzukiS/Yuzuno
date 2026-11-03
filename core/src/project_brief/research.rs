//! The research desk (T-9): a ResearchDesk block of a Brief section.
//!
//! The contract (brief-contract.ts) checks a desk's ids and references with
//! every brief_update. Here is what only Core can do with it: read the
//! numbers it takes from this section's JSON snapshots, say what Core knows
//! of each source's snapshot, for one version of the section; and keep a
//! definition version to one content across the section's versions.
//!
//! None of it is a check of the research. A number read from a snapshot is
//! only in that file; a stated SHA-256 equal to the snapshot's is only the
//! same file content. Core reads nothing but this section's own snapshots
//! and the Task research records a desk names (T-17): no source location,
//! path or URL.
//!
//! A source may name a Task research record (`task: {taskId, activitySeq}`)
//! instead of a snapshot. The record holds its own identity, fixed when it
//! was written, so a definition version may cite a Task method record as it
//! cites a saved file; the desk reads it through the collaboration store's
//! resolver, as the task's own view does. Nothing is copied into the Brief,
//! and removing the section leaves the record where it is.

use std::collections::HashMap;
use std::path::Path;

use anyhow::Result;
use axum::http::StatusCode;
use rusqlite::Connection;
use serde_json::{json, Map, Value};

use super::attachments::{self, Missing};
use super::sections::Row;
use crate::store::Store;

/// Numbers one desk may read from snapshots, as the contract's research.values.
const READS: usize = 400;

/// Where each number of a desk that names a snapshot sits: (`${row or part
/// id}.value|low|high`, attachment, JSON Pointer), as the contract's
/// researchReads lists them.
fn reads(props: &Value) -> Vec<(String, String, String)> {
    let mut found = vec![];
    let mut add = |owner: &Value, estimate: &Value| {
        let Some(owner) = owner.as_str() else { return };
        for field in ["value", "low", "high"] {
            let number = &estimate[field];
            if let (Some(from), Some(pointer)) = (number["from"].as_str(), number["pointer"].as_str()) {
                found.push((format!("{owner}.{field}"), from.to_owned(), pointer.to_owned()));
            }
        }
    };
    for plot in props["plots"].as_array().into_iter().flatten() {
        for row in plot["rows"].as_array().into_iter().flatten() {
            add(&row["id"], &row["estimate"]);
            for part in row["parts"].as_array().into_iter().flatten() {
                add(&part["id"], &part["estimate"]);
            }
        }
    }
    found
}

fn attachment<'a>(row: &'a Row, name: &str) -> Option<&'a Value> {
    row.data["attachments"].as_array().into_iter().flatten().find(|a| a["name"] == name)
}

/// One snapshot's JSON, or why it cannot be read: only an attachment of
/// this section version that Core kept a copy of, with a .json path.
fn parse(cache: &Path, row: &Row, name: &str) -> Result<Value, &'static str> {
    let (path, attachment) = attachments::snapshot_of(cache, row, name).map_err(|missing| missing.code)?;
    if !attachment["path"].as_str().is_some_and(|path| path.to_ascii_lowercase().ends_with(".json")) {
        return Err("not_json");
    }
    // Snapshots are at most 25 MB (staging) and a section has at most 12.
    let bytes = std::fs::read(path).map_err(|_| "unreadable")?;
    serde_json::from_slice(&bytes).map_err(|_| "not_json")
}

/// What Core knows of one source's snapshot. The Agent's sha256 is compared
/// with the snapshot's as file identity only.
fn snapshot(cache: &Path, row: &Row, name: &str, stated: Option<&str>) -> Value {
    let Some(found) = attachment(row, name) else {
        return json!({"attachment":name,"available":false,"reason":"attachment_not_found"});
    };
    let mut shown = json!({"attachment":name,"takenAt":found["takenAt"],"size":found["size"]});
    let sha = found["sha256"].as_str().filter(|_| found["snapshot"] == true);
    match sha {
        Some(sha) => {
            let kept = cache.join(sha).is_file();
            shown["sha256"] = json!(sha);
            shown["available"] = json!(kept);
            if !kept {
                shown["reason"] = json!("snapshot_missing");
            }
        }
        None => {
            shown["available"] = json!(false);
            shown["reason"] = json!("not_snapshot");
        }
    }
    if let Some(stated) = stated {
        shown["stated"] = json!(match sha {
            Some(sha) if sha == stated => "same",
            Some(_) => "different",
            None => "unknown",
        });
    }
    shown
}

/// One desk of one section version: each number it reads from a snapshot,
/// each source's snapshot.
pub(super) fn desk(store: &Store, cache: &Path, project: &str, key: &str, element: &str, version: Option<i64>)
    -> Result<Result<Value, Missing>> {
    let row = match attachments::find_section(store, project, key, version)? {
        Ok(row) => row,
        Err(missing) => return Ok(Err(missing)),
    };
    let Some(node) = row.data["body"]["elements"].get(element).filter(|node| node["type"] == "ResearchDesk") else {
        return Ok(Err(attachments::missing(StatusCode::NOT_FOUND, "element_not_found", "The section has no research desk with this id")));
    };
    let props = &node["props"];
    // Each snapshot parsed once per read.
    let mut parsed: HashMap<String, Result<Value, &'static str>> = HashMap::new();
    let mut values = Map::new();
    for (at, from, pointer) in reads(props).into_iter().take(READS) {
        let file = parsed.entry(from.clone()).or_insert_with(|| parse(cache, &row, &from));
        let read = match file {
            Ok(json) => match json.pointer(&pointer) {
                Some(found) => match found.as_f64().filter(|n| n.is_finite()) {
                    Some(number) => json!({"status":"read","value":number}),
                    None => json!({"status":"not_number"}),
                },
                None => json!({"status":"missing"}),
            },
            Err(reason) => json!({"status":"unavailable","reason":reason}),
        };
        let mut read = read;
        read["from"] = json!(from);
        values.insert(at, read);
    }
    let mut sources = Map::new();
    let mut db = None;
    for source in props["sources"].as_array().into_iter().flatten() {
        if let (Some(id), Some(name)) = (source["id"].as_str(), source["snapshot"].as_str()) {
            sources.insert(id.to_owned(), snapshot(cache, &row, name, source["sha256"].as_str()));
        } else if let (Some(id), Some((task, seq))) = (source["id"].as_str(), task_record(source)) {
            if db.is_none() {
                db = Some(store.db.read()?);
            }
            let db: &Connection = db.as_deref().expect("opened above");
            sources.insert(id.to_owned(), crate::collaboration_store::research_desk_source(db, task, seq)?);
        }
    }
    Ok(Ok(json!({"key":row.key,"version":row.version,"elementId":element,"values":values,"sources":sources})))
}

/// The Task research record a source names, if it names one.
fn task_record(source: &Value) -> Option<(&str, i64)> {
    Some((source["task"]["taskId"].as_str()?, source["task"]["activitySeq"].as_i64()?))
}

/// A definition version as a section keeps it: its text, citation and the
/// SHA-256 of the snapshot it cites (or the Task method record), with where
/// it is in the body.
struct Kept {
    path: String,
    content: Value,
}

/// A definition version's identity: its desk (the element), the definition's
/// id within that desk, and the version. A desk's definitions are its own: two
/// desks of one section may each have a definition "d" version 1.
type DefinitionKey = (String, String, i64);

/// What a definition version cites: a file by name, or a Task record.
enum Cited {
    File(Option<String>),
    Record(Value),
}

/// Every definition version of every desk in a section's data, by desk,
/// definition id and version. A Task record is named as the store names it
/// (T-n), so the same record cited as T-n or by UUID is one content.
fn definitions(db: &Connection, data: &Value) -> Result<Vec<(DefinitionKey, Kept, Cited)>> {
    let attachments: HashMap<&str, &Value> = data["attachments"].as_array().into_iter().flatten()
        .filter_map(|a| Some((a["name"].as_str()?, a)))
        .collect();
    let mut found = vec![];
    for (key, node) in data["body"]["elements"].as_object().into_iter().flatten() {
        if node["type"] != "ResearchDesk" {
            continue;
        }
        let props = &node["props"];
        let snapshots: HashMap<&str, &str> = props["sources"].as_array().into_iter().flatten()
            .filter_map(|s| Some((s["id"].as_str()?, s["snapshot"].as_str()?)))
            .collect();
        let records: HashMap<&str, (&str, i64)> = props["sources"].as_array().into_iter().flatten()
            .filter_map(|s| Some((s["id"].as_str()?, task_record(s)?)))
            .collect();
        for (d, definition) in props["definitions"].as_array().into_iter().flatten().enumerate() {
            let Some(id) = definition["id"].as_str() else { continue };
            for (v, version) in definition["versions"].as_array().into_iter().flatten().enumerate() {
                let Some(number) = version["version"].as_i64() else { continue };
                let cite = &version["cite"];
                let path = format!("body.elements.{key}.props.definitions.{d}.versions.{v}");
                // A Task record holds its identity: the record, as it was written.
                if let Some((task, seq)) = cite["source"].as_str().and_then(|source| records.get(source)).copied() {
                    let record = crate::collaboration_store::research_desk_source(db, task, seq)?;
                    let content = json!({"text":version["text"],"cite":cite,"sha256":null,
                        "task":{"taskId":record["taskId"],"activitySeq":seq}});
                    found.push(((key.clone(), id.to_owned(), number), Kept { path, content }, Cited::Record(record)));
                    continue;
                }
                let file = cite["source"].as_str().and_then(|source| snapshots.get(source)).copied();
                // Only a file Core kept a copy of names one content.
                let sha = file.and_then(|name| attachments.get(name))
                    .and_then(|a| a["sha256"].as_str().filter(|_| a["snapshot"] == true))
                    .map(str::to_owned);
                let content = json!({"text":version["text"],"cite":cite,"sha256":sha});
                found.push(((key.clone(), id.to_owned(), number), Kept { path, content }, Cited::File(file.map(str::to_owned))));
            }
        }
    }
    Ok(found)
}

/// One problem a write has: (path in the section, code, reason).
pub(super) type Problem = (String, &'static str, String);

/// The rule only Core can check, with the attachments as it took them: each
/// definition version cites a file Core kept a snapshot of or a Task method
/// record (T-17), and keeps the text, citation and cited file or record it had
/// in the section's previous version. A changed definition is a new version.
pub(super) fn kept(db: &Connection, previous: Option<&Value>, next: &Value) -> Result<Vec<Problem>> {
    let mut problems = vec![];
    let before: HashMap<DefinitionKey, Value> = match previous {
        Some(previous) => definitions(db, previous)?,
        None => vec![],
    }
    .into_iter()
    .map(|(key, kept, _)| (key, kept.content))
    .collect();
    let mut now: HashMap<DefinitionKey, Value> = HashMap::new();
    for ((desk, id, version), kept, cited) in definitions(db, next)? {
        match cited {
            Cited::Record(record) => {
                let method = record["available"] == true && record["record"]["kind"] == "research"
                    && record["record"]["type"] == "method";
                if !method {
                    problems.push((format!("{}.cite", kept.path), "unsaved_definition", format!(
                        "Definition \"{id}\" version {version} cites a Task record that is not a method record Core can read \
                         ({}): a definition version must point to a saved file or a Task method record.",
                        record["reason"].as_str().unwrap_or("not a method"))));
                    continue;
                }
            }
            Cited::File(file) if kept.content["sha256"].is_null() => {
                let file = file.unwrap_or_default();
                problems.push((format!("{}.cite", kept.path), "unsaved_definition", format!(
                    "Definition \"{id}\" version {version} cites a file Core kept no snapshot of (\"{file}\": over 25 MB, missing or not a file): \
                     a definition version must point to a saved file or a Task method record. Attach the file the definition is written in.")));
                continue;
            }
            Cited::File(_) => {}
        }
        let changed = |earlier: &Value| earlier != &kept.content;
        let at = (desk, id.clone(), version);
        if before.get(&at).is_some_and(changed) || now.get(&at).is_some_and(changed) {
            problems.push((kept.path.clone(), "definition_changed", format!(
                "Definition \"{id}\" version {version} already names other content (its text, citation or cited file); \
                 a changed definition is a new version: add version {} and keep {version} as it was.", version + 1)));
        }
        now.insert(at, kept.content);
    }
    Ok(problems)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule for sections citing files: no Task record is read.
    fn k(previous: Option<&Value>, next: &Value) -> Vec<Problem> {
        kept(&Connection::open_in_memory().unwrap(), previous, next).unwrap()
    }

    fn data(text: &str, sha: Option<&str>) -> Value {
        let attachment = match sha {
            Some(sha) => json!({"name":"defs.md","path":"/r/defs.md","snapshot":true,"sha256":sha,"takenAt":"2026-10-31T00:00:00Z"}),
            None => json!({"name":"defs.md","path":"/r/defs.md","snapshot":false,"mayChange":true}),
        };
        json!({"attachments":[attachment],"body":{"root":"body","elements":{
            "body":{"type":"BriefBody","props":{},"children":["desk"]},
            "desk":{"type":"ResearchDesk","props":{"schema":"research/1","claims":[],"plots":[],
                "sources":[{"id":"defs","label":"Definitions","kind":"notes","snapshot":"defs.md"}],
                "definitions":[{"id":"static","title":"Static rule","versions":[
                    {"version":1,"text":text,"cite":{"source":"defs","lines":"178-190"}}]}]}}}}})
    }

    #[test]
    fn a_definition_version_keeps_one_content() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        assert!(k(None, &data("Per sub-menu.", Some(&a))).is_empty());
        assert!(k(Some(&data("Per sub-menu.", Some(&a))), &data("Per sub-menu.", Some(&a))).is_empty(), "unchanged");
        let text = k(Some(&data("Per sub-menu.", Some(&a))), &data("Per menu.", Some(&a)));
        assert_eq!((text.len(), text[0].1), (1, "definition_changed"));
        assert_eq!(text[0].0, "body.elements.desk.props.definitions.0.versions.0");
        let file = k(Some(&data("Per sub-menu.", Some(&a))), &data("Per sub-menu.", Some(&b)));
        assert_eq!(file[0].1, "definition_changed", "the cited file changed under the same version");
        let unsaved = k(None, &data("Per sub-menu.", None));
        assert_eq!((unsaved[0].1, unsaved[0].0.as_str()), ("unsaved_definition", "body.elements.desk.props.definitions.0.versions.0.cite"));
    }

    #[test]
    fn each_desk_keeps_its_own_definitions() {
        let a = "a".repeat(64);
        let two = |second: &str| {
            let mut both = data("Per sub-menu.", Some(&a));
            let mut other = both["body"]["elements"]["desk"].clone();
            other["props"]["definitions"][0]["versions"][0]["text"] = json!(second);
            both["body"]["elements"]["other"] = other;
            both["body"]["elements"]["body"]["children"] = json!(["desk", "other"]);
            both
        };
        // Two desks may each have a "static" version 1 of their own, from the first write on.
        assert!(k(None, &two("Per menu.")).is_empty());
        // Each still keeps its own: the second desk changing its version 1 is refused there.
        let changed = k(Some(&two("Per menu.")), &two("Per whole menu."));
        assert_eq!((changed.len(), changed[0].1), (1, "definition_changed"));
        assert_eq!(changed[0].0, "body.elements.other.props.definitions.0.versions.0");
    }

    #[test]
    fn reads_list_every_number_named_by_a_snapshot() {
        let props = json!({"plots":[{"rows":[
            {"id":"r1","estimate":{"value":{"from":"a.json","pointer":"/m"},"low":1.0,"high":{"from":"a.json","pointer":"/h"}},
             "parts":[{"id":"p1","estimate":{"value":{"from":"b.json","pointer":"/x/0"}}}]}]}]});
        assert_eq!(reads(&props), vec![
            ("r1.value".to_owned(), "a.json".to_owned(), "/m".to_owned()),
            ("r1.high".to_owned(), "a.json".to_owned(), "/h".to_owned()),
            ("p1.value".to_owned(), "b.json".to_owned(), "/x/0".to_owned()),
        ]);
    }
}
