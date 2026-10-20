//! Parameter mistakes are retained separately from requests for unavailable
//! source. A successful correction must preserve every valid supplied field,
//! especially path and revision; it never grants diff or line coverage itself.
use super::*;
use serde::de::DeserializeOwned;

#[derive(Debug)]
pub(super) struct InvalidArguments {
    message: String,
    field: Option<&'static str>,
}
impl std::fmt::Display for InvalidArguments {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for InvalidArguments {}

pub(super) fn parse<T: DeserializeOwned>(input: Value) -> Result<T> {
    serde_json::from_value(input).map_err(|error| {
        InvalidArguments {
            message: error.to_string(),
            field: None,
        }
        .into()
    })
}

pub(super) fn check(valid: bool, field: &'static str, message: &str) -> Result<()> {
    if !valid {
        return Err(InvalidArguments {
            message: message.into(),
            field: Some(field),
        }
        .into());
    }
    Ok(())
}

pub(super) fn search_cursor(cursor: &str) -> Result<(usize, usize)> {
    let parsed = cursor
        .split_once(':')
        .and_then(|(index, line)| Some((index.parse::<usize>().ok()?, line.parse::<usize>().ok()?)))
        .filter(|(_, line)| *line > 0);
    check(
        parsed.is_some(),
        "cursor",
        "Search cursor must be 0:1 or a returned nextCursor (file index:positive line); omit cursor only for the first page",
    )?;
    Ok(parsed.unwrap())
}

pub(super) fn initial_search_cursor() -> String {
    "0:1".into()
}

impl InvalidArguments {
    pub(super) fn correction_scope(&self, tool: &str, input: &Value) -> Value {
        let schema = context_tools()
            .into_iter()
            .find(|s| s["name"] == tool)
            .unwrap();
        let mut scope = serde_json::Map::new();
        for (key, property) in schema["inputSchema"]["properties"].as_object().unwrap() {
            let Some(value) = input.get(key) else {
                continue;
            };
            // An invalid explicit source identity must never be cleared by a
            // successful request for a different path/revision.
            if key == "path" || key == "revision" {
                scope.insert(key.clone(), value.clone());
                continue;
            }
            if self.field == Some(key.as_str()) {
                continue;
            }
            // These are our closed tool schemas, not a general JSON Schema validator.
            let valid = match property["type"].as_str() {
                Some("integer") => value
                    .as_u64()
                    .is_some_and(|n| n >= property["minimum"].as_u64().unwrap_or(0)),
                Some("string") => value.as_str().is_some_and(|s| {
                    s.len() >= property["minLength"].as_u64().unwrap_or(0) as usize
                        && s.len() <= property["maxLength"].as_u64().unwrap_or(u64::MAX) as usize
                        && (tool != "source_search"
                            || key != "query"
                            || !s.contains(['\n', '\r', '\0']))
                        && (tool != "source_search" || key != "cursor" || search_cursor(s).is_ok())
                }),
                _ => false,
            };
            if valid {
                scope.insert(key.clone(), value.clone());
            }
        }
        Value::Object(scope)
    }
}

pub(super) fn corrected(tool: &str, scope: &Value, input: &Value) -> bool {
    scope.as_object().unwrap().iter().all(|(key, value)| {
        if tool == "source_search" && key == "cursor" && input.get(key).is_none() {
            value == "0:1"
        } else {
            input.get(key) == Some(value)
        }
    })
}

// Refine only pagination parameters, using metadata already obtained by a
// successful fixed-source request. This needs no additional Git I/O on an
// invalid call and never changes an explicit path, revision or query.
pub(super) fn refine_scope(
    tool: &str,
    scope: &mut Value,
    fixed_revision: Option<&str>,
    value: &Value,
    trees: &HashMap<String, Vec<Entry>>,
    patches: &HashMap<String, String>,
) {
    let scope = scope.as_object_mut().unwrap();
    let tree = fixed_revision
        .or_else(|| value["revision"].as_str())
        .and_then(|rev| trees.get(rev));
    let bad_cursor = match tool {
        "source_search" => scope
            .get("cursor")
            .and_then(Value::as_str)
            .and_then(|c| search_cursor(c).ok())
            .zip(tree)
            .is_some_and(|((index, _), entries)| index > entries.len()),
        "source_paths" => scope
            .get("cursor")
            .and_then(Value::as_u64)
            .zip(tree)
            .is_some_and(|(index, entries)| index > entries.len() as u64),
        "review_changes" => scope
            .get("cursor")
            .and_then(Value::as_u64)
            .zip(value["totalFiles"].as_u64())
            .is_some_and(|(index, total)| index > total),
        _ => false,
    };
    if bad_cursor {
        scope.remove("cursor");
    }
    if tool == "source_diff" {
        let path = scope
            .get("path")
            .and_then(Value::as_str)
            .or_else(|| value["path"].as_str());
        let bad_offset = scope
            .get("offset")
            .and_then(Value::as_u64)
            .zip(path.and_then(|p| patches.get(p)))
            .is_some_and(|(offset, patch)| {
                offset >= patch.len() as u64 || !patch.is_char_boundary(offset as usize)
            });
        if bad_offset {
            scope.remove("offset");
        }
    }
    if tool == "source_read"
        && scope
            .get("startLine")
            .and_then(Value::as_u64)
            .zip(scope.get("endLine").and_then(Value::as_u64))
            .is_some_and(|(start, end)| end < start)
    {
        scope.remove("endLine");
    }
}
