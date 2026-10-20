//! Source failures recover from delivered search pages, not spelling changes.
//! Fingerprints use the already bounded, frozen tree; no extra Git reads or
//! path lists are exposed. The call budget bounds cached prefixes and receipts.
use super::*;
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PathSet {
    sha256: String,
    path_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Recovery {
    revision: String,
    query: String,
    path_set: PathSet,
    start_cursor: (usize, usize),
    next_cursor: Option<(usize, usize)>,
    successful_receipts: Vec<usize>,
}

fn path_set(
    cache: &mut HashMap<(String, String), PathSet>,
    revision: &str,
    prefix: &str,
    tree: &[Entry],
) -> PathSet {
    cache
        .entry((revision.into(), prefix.into()))
        .or_insert_with(|| {
            let mut hash = Sha256::new();
            let mut path_count = 0;
            // Exactly the predicate and ordering used by search, including
            // excluded non-regular entries. No trailing-slash normalization.
            for entry in tree.iter().filter(|e| e.path.starts_with(prefix)) {
                for field in [&entry.path, &entry.blob, &entry.mode] {
                    hash.update((field.len() as u64).to_be_bytes());
                    hash.update(field.as_bytes());
                }
                path_count += 1;
            }
            PathSet {
                sha256: format!("{:x}", hash.finalize()),
                path_count,
            }
        })
        .clone()
}

pub(super) fn advance(
    failure: &mut Failure,
    input: &Value,
    value: &Value,
    trees: &HashMap<String, Vec<Entry>>,
    cache: &mut HashMap<(String, String), PathSet>,
    receipt: usize,
) -> bool {
    advance_checked(failure, input, value, trees, cache, receipt).unwrap_or(false)
}

fn advance_checked(
    failure: &mut Failure,
    input: &Value,
    value: &Value,
    trees: &HashMap<String, Vec<Entry>>,
    cache: &mut HashMap<(String, String), PathSet>,
    receipt: usize,
) -> Option<bool> {
    let revision = failure.revision.as_deref()?;
    if value["revision"].as_str()? != revision {
        return None;
    }
    let original: Search = serde_json::from_value(failure.input.clone()).ok()?;
    let current: Search = serde_json::from_value(input.clone()).ok()?;
    let tree = trees.get(revision)?;
    let start = arguments::search_cursor(&original.cursor).ok()?;
    let cursor = arguments::search_cursor(&current.cursor).ok()?;
    if original.query != current.query
        || original.path_prefix.len() > 1000
        || start.0 > tree.len()
        || cursor.0 > tree.len()
        || !value["skipped"].as_array()?.is_empty()
    {
        return None;
    }
    let expected = failure
        .search_recovery
        .as_ref()
        .map_or(Some(start), |r| r.next_cursor);
    if expected != Some(cursor) {
        return None; // A later page cannot bridge a missing or failed page.
    }
    let next = match value.get("nextCursor")? {
        Value::Null => None,
        Value::String(next) => {
            let next = arguments::search_cursor(next).ok()?;
            if next <= cursor || next.0 > tree.len() {
                return None;
            }
            Some(next)
        }
        _ => return None,
    };
    let original_set = path_set(cache, revision, &original.path_prefix, tree);
    if original_set != path_set(cache, revision, &current.path_prefix, tree) {
        return None;
    }
    let recovery = failure.search_recovery.get_or_insert_with(|| Recovery {
        revision: revision.into(),
        query: original.query,
        path_set: original_set,
        start_cursor: start,
        next_cursor: Some(start),
        successful_receipts: Vec::new(),
    });
    recovery.successful_receipts.push(receipt);
    recovery.next_cursor = next;
    // A successful page is only partial evidence until its continuation chain
    // ends. Never resolve unrelated failures or grant diff coverage here.
    Some(next.is_none())
}
