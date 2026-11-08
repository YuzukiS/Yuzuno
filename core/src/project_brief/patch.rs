//! RFC 6902 JSON Patch on a section body (YN-14 A2): what brief_update's
//! `patch` op applies to the stored body before Core checks the whole
//! section again, as it checks an edit. Paths are JSON Pointers (RFC 6901)
//! into the body, e.g. /elements/refs/props/items/3/note, so an Agent
//! changes one value without sending the block it is in.
//!
//! YN-31: on an array, a token @<id> names its one item whose "id" is <id>,
//! e.g. /elements/table/props/rows/@r8/cells/status, so a row stays named
//! when rows are inserted or reordered. JSON Pointer has no such token (an
//! array's are indices, or - for the end), so none of its paths changes
//! meaning; on an object @x is still the key "@x". No item, or two, with
//! that id refuses the operation as any path not in the body does.
use serde_json::{Map, Value};

/// At most this many operations in one patch change.
pub(super) const MAX_OPS: usize = 64;
/// The most compact-JSON bytes a body may reach while a patch applies
/// (#718 R1): four times the contract's 64000-byte body, which the
/// validator checks exactly afterwards. It only stops a patch from building
/// a large body first, e.g. by copying a part into itself again and again.
pub(super) const MAX_BUILT_BYTES: usize = 4 * 64_000;
/// The operations RFC 6902 has.
pub(super) const OPS: [&str; 6] = ["add", "remove", "replace", "move", "copy", "test"];

/// Why operation `index` could not be applied: which of its fields
/// (path or from), a problem code and a reason the Agent can act on.
#[derive(Debug, PartialEq)]
pub(super) struct Failed {
    pub index: usize,
    pub field: &'static str,
    pub code: &'static str,
    pub reason: String,
}

/// The operations in order on `body`; the first that fails stops them, and
/// `body` may then be half changed (the caller patches a copy).
pub(super) fn apply(body: &mut Value, ops: &[Value]) -> Result<(), Failed> {
    for (index, op) in ops.iter().enumerate() {
        let name = op["op"].as_str().unwrap_or_default();
        let fail = |field: &'static str, code: &'static str, reason: String| Failed { index, field, code, reason };
        let path = pointer(op["path"].as_str().unwrap_or_default()).map_err(|reason| fail("path", "patch_path", reason))?;
        if path.is_empty() {
            return Err(fail("path", "patch_path", "path \"\" is the whole body: patch its parts, or put the section to replace it.".into()));
        }
        let from = || match pointer(op["from"].as_str().unwrap_or_default()) {
            Ok(tokens) if tokens.is_empty() => Err(fail("from", "patch_path", "from \"\" is the whole body: name the part to move or copy.".into())),
            found => found.map_err(|reason| fail("from", "patch_path", reason)),
        };
        match name {
            "add" => add(body, &path, op["value"].clone()).map_err(|reason| fail("path", "patch_path", reason))?,
            "remove" => {
                remove(body, &path).map_err(|reason| fail("path", "patch_path", reason))?;
            }
            "replace" => {
                find(body, &path).map_err(|reason| fail("path", "patch_path", reason))?;
                *find_mut(body, &path) = op["value"].clone();
            }
            "move" => {
                let from = from()?;
                // Compared as locations, with each @id as the index it names
                // before the move, so /rows/@r3 and /rows/2 are the same item.
                let (at, to) = (located(body, &from), located(body, &path));
                if to.len() > at.len() && to.starts_with(&at) {
                    return Err(fail("path", "patch_path", format!("{} is inside {}: a value can't be moved into itself.", shown(&path), shown(&from))));
                }
                if to == at {
                    // A move to where the value is changes nothing (RFC 6902
                    // 4.4), also when @id would no longer find it once removed.
                    find(body, &from).map_err(|reason| fail("from", "patch_path", reason))?;
                    continue;
                }
                let value = remove(body, &from).map_err(|reason| fail("from", "patch_path", reason))?;
                add(body, &path, value).map_err(|reason| fail("path", "patch_path", reason))?;
            }
            "copy" => {
                let from = from()?;
                let value = find(body, &from).map_err(|reason| fail("from", "patch_path", reason))?.clone();
                add(body, &path, value).map_err(|reason| fail("path", "patch_path", reason))?;
            }
            "test" => {
                let found = find(body, &path).map_err(|reason| fail("path", "patch_path", reason))?;
                if !same(found, &op["value"]) {
                    return Err(fail("path", "patch_test", format!("{} is {}, not the value the test gives; nothing was changed.", shown(&path), brief(found))));
                }
            }
            _ => return Err(fail("path", "patch_path", format!("op is one of {}.", OPS.join(", ")))),
        }
        // What may grow the body is measured at once, before the next operation.
        if matches!(name, "add" | "copy" | "replace") {
            let bytes = serde_json::to_vec(&*body).map(|bytes| bytes.len()).unwrap_or(usize::MAX);
            if bytes > MAX_BUILT_BYTES {
                return Err(fail("path", "too_large", format!(
                    "After this operation the body is {bytes} bytes of compact JSON, far over the 64000 a section may have; nothing was changed.")));
            }
        }
    }
    Ok(())
}

/// A JSON Pointer's reference tokens, unescaped (~1 is /, ~0 is ~).
fn pointer(text: &str) -> Result<Vec<String>, String> {
    if text.is_empty() {
        return Ok(vec![]);
    }
    let Some(rest) = text.strip_prefix('/') else {
        return Err(format!("\"{text}\" is not a JSON Pointer: start it with /, e.g. /elements/notes/props/text."));
    };
    rest.split('/')
        .map(|token| {
            let mut chars = token.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '~' && !matches!(chars.next(), Some('0' | '1')) {
                    return Err(format!("\"{text}\" has a ~ that is not ~0 or ~1."));
                }
            }
            Ok(token.replace("~1", "/").replace("~0", "~"))
        })
        .collect()
}

/// A pointer as written, for reasons; the body itself for "".
fn shown(tokens: &[String]) -> String {
    if tokens.is_empty() {
        return "the body".into();
    }
    tokens.iter().map(|token| format!("/{}", escaped(token))).collect()
}

/// One token as a pointer writes it.
fn escaped(token: &str) -> String {
    token.replace('~', "~0").replace('/', "~1")
}

/// Where `token` is in `list`: an index, or @id, the one item whose "id" is
/// id (YN-31), which where a value is added is the place before it. None
/// when there is no such entry or two items have that id; `missing` says
/// which.
fn position(token: &str, list: &[Value], adding: bool) -> Option<usize> {
    let Some(id) = token.strip_prefix('@') else {
        return index(token, list.len(), adding);
    };
    let mut found = with_id(list, id);
    match (found.next(), found.next()) {
        (Some(at), None) if !id.is_empty() => Some(at),
        _ => None,
    }
}

/// The indices of the items of `list` whose "id" is `id`.
fn with_id<'a>(list: &'a [Value], id: &'a str) -> impl Iterator<Item = usize> + 'a {
    list.iter().enumerate().filter(move |(_, item)| item["id"].as_str() == Some(id)).map(|(at, _)| at)
}

/// Why @id names no single item of `list`, the array at `at`.
fn missing_id(at: &str, id: &str, list: &[Value]) -> String {
    if id.is_empty() {
        return format!("{at}: @ names an item by its id, e.g. @r8; give the id after it.");
    }
    let found: Vec<String> = with_id(list, id).map(|i| i.to_string()).collect();
    if found.len() > 1 {
        return format!("{at} has {} items whose id is \"{id}\" (at {}): name one by its index.", found.len(), found.join(", "));
    }
    let ids: Vec<&str> = list.iter().filter_map(|item| item["id"].as_str()).collect();
    if ids.is_empty() {
        return format!("{at} has no item with an id, so there is no @{}: name an entry by its index.", escaped(id));
    }
    let more = if ids.len() > 12 { ", …" } else { "" };
    format!("{at} has no item whose id is \"{id}\"; its ids are {}{more}.", ids[..ids.len().min(12)].join(", "))
}

/// `tokens` with each @id that names an item replaced by that item's index,
/// as far as the body has them: two paths to the same place are then equal.
fn located(body: &Value, tokens: &[String]) -> Vec<String> {
    let mut node = Some(body);
    tokens
        .iter()
        .map(|token| {
            let (written, next) = match node {
                Some(Value::Array(list)) => match position(token, list, false) {
                    Some(at) => (at.to_string(), list.get(at)),
                    None => (token.clone(), None),
                },
                Some(Value::Object(map)) => (token.clone(), map.get(token)),
                _ => (token.clone(), None),
            };
            node = next;
            written
        })
        .collect()
}

/// An array index: digits without a leading zero, below `len`, or `len`
/// itself and "-" (the end) where a value is added.
fn index(token: &str, len: usize, adding: bool) -> Option<usize> {
    if adding && token == "-" {
        return Some(len);
    }
    if token.is_empty() || (token.len() > 1 && token.starts_with('0')) || !token.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    token.parse::<usize>().ok().filter(|i| if adding { *i <= len } else { *i < len })
}

/// Why `tokens[depth]` is not in `node`, the value at `tokens[..depth]`.
fn missing(tokens: &[String], depth: usize, node: &Value) -> String {
    let (at, token) = (shown(&tokens[..depth]), &tokens[depth]);
    match node {
        Value::Array(list) if token.starts_with('@') => missing_id(&at, &token[1..], list),
        Value::Array(list) if list.is_empty() => format!("{at} has no entries, so there is no {token}."),
        // A row named by its bare id, as an object's key would be.
        Value::Array(list) if with_id(list, token).next().is_some() => format!(
            "{at} has {} entries (0-{}), so there is no {token}; to name the item whose id is \"{token}\", write @{}.",
            list.len(), list.len() - 1, escaped(token)),
        Value::Array(list) => format!("{at} has {} entries (0-{}), so there is no {token}.", list.len(), list.len() - 1),
        Value::Object(map) => {
            let keys: Vec<&str> = map.keys().take(12).map(String::as_str).collect();
            let more = if map.len() > keys.len() { ", …" } else { "" };
            format!("{at} has no \"{token}\"; it has {}{more}.", if keys.is_empty() { "nothing".into() } else { keys.join(", ") })
        }
        other => format!("{at} is {} and has no parts.", brief(other)),
    }
}

/// The value at `tokens`, or why it is not there.
fn find<'a>(body: &'a Value, tokens: &[String]) -> Result<&'a Value, String> {
    let mut node = body;
    for (depth, token) in tokens.iter().enumerate() {
        let next = match node {
            Value::Object(map) => map.get(token),
            Value::Array(list) => position(token, list, false).and_then(|i| list.get(i)),
            _ => None,
        };
        node = next.ok_or_else(|| missing(tokens, depth, node))?;
    }
    Ok(node)
}

/// The value at `tokens`, which `find` found.
fn find_mut<'a>(body: &'a mut Value, tokens: &[String]) -> &'a mut Value {
    let mut node = body;
    for token in tokens {
        node = match node {
            Value::Object(map) => map.get_mut(token).expect("found before"),
            Value::Array(list) => {
                let at = position(token, list, false).expect("found before");
                &mut list[at]
            }
            _ => unreachable!("found before"),
        };
    }
    node
}

/// The object or array a value is added to or removed from, and the last token.
fn parent<'a>(body: &'a mut Value, tokens: &'a [String]) -> Result<(&'a mut Value, &'a String), String> {
    let (last, above) = tokens.split_last().expect("a path below the body");
    find(body, above)?;
    let node = find_mut(body, above);
    if !matches!(node, Value::Object(_) | Value::Array(_)) {
        let kind = brief(node);
        return Err(format!("{} is {kind} and has no parts.", shown(above)));
    }
    Ok((node, last))
}

fn add(body: &mut Value, tokens: &[String], value: Value) -> Result<(), String> {
    let (node, last) = parent(body, tokens)?;
    match node {
        Value::Object(map) => {
            map.insert(last.clone(), value);
            Ok(())
        }
        Value::Array(list) => {
            let len = list.len();
            let Some(at) = position(last, list, true) else {
                let above = shown(&tokens[..tokens.len() - 1]);
                return Err(match last.strip_prefix('@') {
                    Some(id) => missing_id(&above, id, list),
                    None => format!("{above} has {len} entries: add at an index 0-{len}, at - for the end or at @<id> before that item."),
                });
            };
            list.insert(at, value);
            Ok(())
        }
        _ => unreachable!("parent is an object or an array"),
    }
}

fn remove(body: &mut Value, tokens: &[String]) -> Result<Value, String> {
    find(body, tokens)?;
    let (node, last) = parent(body, tokens)?;
    Ok(match node {
        Value::Object(map) => map.remove(last).expect("found before"),
        Value::Array(list) => list.remove(position(last, list, false).expect("found before")),
        _ => unreachable!("parent is an object or an array"),
    })
}

/// RFC 6902 test equality: numbers by value, objects regardless of key order.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x == y || x.as_f64().zip(y.as_f64()).is_some_and(|(x, y)| x == y),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y)),
        (Value::Object(x), Value::Object(y)) => same_objects(x, y),
        _ => a == b,
    }
}

fn same_objects(x: &Map<String, Value>, y: &Map<String, Value>) -> bool {
    x.len() == y.len() && x.iter().all(|(key, value)| y.get(key).is_some_and(|other| same(value, other)))
}

/// A value in a few words, for reasons.
fn brief(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) if s.chars().count() <= 40 => format!("\"{s}\""),
        Value::String(s) => format!("\"{}…\"", s.chars().take(40).collect::<String>()),
        Value::Array(list) => format!("a list of {}", list.len()),
        Value::Object(_) => "an object".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patched(body: Value, ops: Value) -> Result<Value, Failed> {
        let mut body = body;
        apply(&mut body, ops.as_array().unwrap()).map(|()| body)
    }

    /// RFC 6902 Appendix A, the cases a section body can meet.
    #[test]
    fn the_rfc_examples_apply_as_the_rfc_says() {
        assert_eq!(patched(json!({"foo":"bar"}), json!([{"op":"add","path":"/baz","value":"qux"}])).unwrap(), json!({"baz":"qux","foo":"bar"}));
        assert_eq!(patched(json!({"foo":["bar","baz"]}), json!([{"op":"add","path":"/foo/1","value":"qux"}])).unwrap(), json!({"foo":["bar","qux","baz"]}));
        assert_eq!(patched(json!({"baz":"qux","foo":"bar"}), json!([{"op":"remove","path":"/baz"}])).unwrap(), json!({"foo":"bar"}));
        assert_eq!(patched(json!({"foo":["bar","qux","baz"]}), json!([{"op":"remove","path":"/foo/1"}])).unwrap(), json!({"foo":["bar","baz"]}));
        assert_eq!(patched(json!({"baz":"qux","foo":"bar"}), json!([{"op":"replace","path":"/baz","value":"boo"}])).unwrap(), json!({"baz":"boo","foo":"bar"}));
        assert_eq!(patched(json!({"foo":{"bar":"baz","waldo":"fred"},"qux":{"corge":"grault"}}), json!([{"op":"move","from":"/foo/waldo","path":"/qux/thud"}])).unwrap(),
            json!({"foo":{"bar":"baz"},"qux":{"corge":"grault","thud":"fred"}}));
        assert_eq!(patched(json!({"foo":["all","grass","cows","eat"]}), json!([{"op":"move","from":"/foo/1","path":"/foo/3"}])).unwrap(), json!({"foo":["all","cows","eat","grass"]}));
        assert_eq!(patched(json!({"baz":"qux","foo":["a",2,"c"]}), json!([{"op":"test","path":"/baz","value":"qux"},{"op":"test","path":"/foo/1","value":2}])).unwrap(),
            json!({"baz":"qux","foo":["a",2,"c"]}));
        assert_eq!(patched(json!({"foo":["bar"]}), json!([{"op":"add","path":"/foo/-","value":["abc","def"]}])).unwrap(), json!({"foo":["bar",["abc","def"]]}));
        assert_eq!(patched(json!({"/":9,"~1":10}), json!([{"op":"test","path":"/~01","value":10}])).unwrap(), json!({"/":9,"~1":10}));
        assert_eq!(patched(json!({"foo":1}), json!([{"op":"copy","from":"/foo","path":"/bar"}])).unwrap(), json!({"foo":1,"bar":1}));
        assert!(patched(json!({"foo":1}), json!([{"op":"test","path":"/foo","value":1.0}])).is_ok(), "numbers by value");
    }

    #[test]
    fn a_path_that_is_not_there_says_what_is() {
        let body = json!({"elements":{"refs":{"props":{"items":[{"note":"a"},{"note":"b"}]}},"summary":{}}});
        let failed = patched(body.clone(), json!([{"op":"replace","path":"/elements/refs/props/items/1/note","value":"ok"},
            {"op":"replace","path":"/elements/refs/props/items/2/note","value":"x"}])).unwrap_err();
        assert_eq!((failed.index, failed.field, failed.code), (1, "path", "patch_path"));
        assert_eq!(failed.reason, "/elements/refs/props/items has 2 entries (0-1), so there is no 2.");
        let typo = patched(body.clone(), json!([{"op":"replace","path":"/elements/ref/props","value":{}}])).unwrap_err();
        assert_eq!(typo.reason, "/elements has no \"ref\"; it has refs, summary.");
        assert_eq!(patched(body.clone(), json!([{"op":"remove","path":""}])).unwrap_err().code, "patch_path");
        assert_eq!(patched(body.clone(), json!([{"op":"add","path":"elements/x","value":1}])).unwrap_err().code, "patch_path");
        assert_eq!(patched(body.clone(), json!([{"op":"add","path":"/elements/summary/x~2","value":1}])).unwrap_err().code, "patch_path");
        let into = patched(body.clone(), json!([{"op":"move","from":"/elements","path":"/elements/refs/x"}])).unwrap_err();
        assert!(into.reason.contains("can't be moved into itself"), "{}", into.reason);
        let from = patched(body.clone(), json!([{"op":"copy","from":"/elements/nope","path":"/elements/x"}])).unwrap_err();
        assert_eq!((from.field, from.code), ("from", "patch_path"));
        let leading = patched(body, json!([{"op":"remove","path":"/elements/refs/props/items/01"}])).unwrap_err();
        assert_eq!(leading.code, "patch_path", "no leading zeros");
    }

    /// #718 R1: copying a part into itself again and again would double the
    /// body each time; it is refused once the body passes MAX_BUILT_BYTES.
    #[test]
    fn a_patch_cannot_build_a_body_far_over_the_limit() {
        let body = json!({"elements":{"text":{"type":"Markdown","props":{"text":"x".repeat(2_000)}}}});
        let ops: Vec<Value> = (0..MAX_OPS).map(|n| json!({"op":"copy","from":"/elements","path":format!("/elements/c{n}")})).collect();
        let failed = patched(body.clone(), json!(ops)).unwrap_err();
        assert_eq!((failed.field, failed.code), ("path", "too_large"));
        assert!(failed.index < 10, "stopped as soon as it passed the bound, at {}", failed.index);
        let whole = patched(body.clone(), json!([{"op":"copy","from":"","path":"/elements/all"}])).unwrap_err();
        assert_eq!((whole.field, whole.code), ("from", "patch_path"));
        let moved = patched(body.clone(), json!([{"op":"move","from":"","path":"/elements/all"}])).unwrap_err();
        assert_eq!((moved.field, moved.code), ("from", "patch_path"));
        let large = json!([{"op":"add","path":"/elements/big","value":"y".repeat(MAX_BUILT_BYTES)}]);
        assert_eq!(patched(body.clone(), large).unwrap_err().code, "too_large", "a large value is measured too");
        assert!(patched(body, json!([{"op":"copy","from":"/elements/text","path":"/elements/again"}])).is_ok(), "a copy within the bound applies");
    }

    /// A table's rows r1, r2, r8, r9, each with a status.
    fn rows() -> Value {
        let rows: Vec<Value> = ["r1", "r2", "r8", "r9"].iter().map(|id| json!({"id":id,"cells":{"status":"todo"}})).collect();
        json!({"elements":{"t":{"type":"Table","props":{"rows":rows}},"body":{"children":["t"]}}})
    }

    fn ids(body: &Value) -> Vec<&str> {
        body["elements"]["t"]["props"]["rows"].as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap()).collect()
    }

    /// YN-31: @id names the item whose id it is, wherever an index can go,
    /// and the rest of the path goes on inside it.
    #[test]
    fn an_array_item_is_named_by_its_id() {
        let done = patched(rows(), json!([{"op":"test","path":"/elements/t/props/rows/@r8/id","value":"r8"},
            {"op":"replace","path":"/elements/t/props/rows/@r8/cells/status","value":"done"},
            {"op":"add","path":"/elements/t/props/rows/@r8/cells/note","value":"Merged."}])).unwrap();
        assert_eq!(done["elements"]["t"]["props"]["rows"][2]["cells"], json!({"status":"done","note":"Merged."}));
        let mut expected = rows();
        expected["elements"]["t"]["props"]["rows"][2]["cells"] = json!({"status":"done","note":"Merged."});
        assert_eq!(done, expected, "nothing else changed");

        // After rows are inserted and reordered, @r8 still names r8.
        let moved = patched(rows(), json!([{"op":"add","path":"/elements/t/props/rows/0","value":{"id":"r0","cells":{}}},
            {"op":"move","from":"/elements/t/props/rows/@r9","path":"/elements/t/props/rows/1"},
            {"op":"replace","path":"/elements/t/props/rows/@r8/cells/status","value":"done"}])).unwrap();
        assert_eq!(ids(&moved), ["r0", "r9", "r1", "r2", "r8"]);
        assert_eq!(moved["elements"]["t"]["props"]["rows"][4]["cells"]["status"], "done");

        // Where a value is added, @id is the place before that item; remove, move and copy take it too.
        let added = patched(rows(), json!([{"op":"add","path":"/elements/t/props/rows/@r8","value":{"id":"r5"}}])).unwrap();
        assert_eq!(ids(&added), ["r1", "r2", "r5", "r8", "r9"]);
        let removed = patched(rows(), json!([{"op":"remove","path":"/elements/t/props/rows/@r2"}])).unwrap();
        assert_eq!(ids(&removed), ["r1", "r8", "r9"]);
        let up = patched(rows(), json!([{"op":"move","from":"/elements/t/props/rows/@r9","path":"/elements/t/props/rows/@r1"}])).unwrap();
        assert_eq!(ids(&up), ["r9", "r1", "r2", "r8"]);
        let down = patched(rows(), json!([{"op":"move","from":"/elements/t/props/rows/@r1","path":"/elements/t/props/rows/@r9"}])).unwrap();
        assert_eq!(ids(&down), ["r2", "r8", "r1", "r9"], "the path is read once the row is removed, as RFC 6902 reads a move");
        let same = patched(rows(), json!([{"op":"move","from":"/elements/t/props/rows/@r8","path":"/elements/t/props/rows/@r8"}])).unwrap();
        assert_eq!(same, rows(), "a move to where it is changes nothing");
        let copied = patched(rows(), json!([{"op":"replace","path":"/elements/t/props/rows/@r2/cells/status","value":"done"},
            {"op":"copy","from":"/elements/t/props/rows/@r2/cells","path":"/elements/t/props/rows/@r9/cells"}])).unwrap();
        assert_eq!(copied["elements"]["t"]["props"]["rows"][3]["cells"], json!({"status":"done"}));

        // An id is unescaped like any token: ~1 is /.
        let refs = json!({"items":[{"kind":"pr","id":"YuzukiS/Yuzuno#12"},{"kind":"task","id":"T-3"}]});
        let noted = patched(refs, json!([{"op":"add","path":"/items/@YuzukiS~1Yuzuno#12/note","value":"Green."}])).unwrap();
        assert_eq!(noted["items"][0]["note"], "Green.");
    }

    #[test]
    fn an_id_that_names_no_item_or_two_is_refused() {
        let missing = patched(rows(), json!([{"op":"replace","path":"/elements/t/props/rows/@r7/cells/status","value":"done"}])).unwrap_err();
        assert_eq!((missing.index, missing.field, missing.code), (0, "path", "patch_path"));
        assert_eq!(missing.reason, "/elements/t/props/rows has no item whose id is \"r7\"; its ids are r1, r2, r8, r9.");
        let into = patched(rows(), json!([{"op":"add","path":"/elements/t/props/rows/@r7","value":{"id":"r7"}}])).unwrap_err();
        assert_eq!((into.code, into.reason.as_str()), ("patch_path", missing.reason.as_str()), "nor is it a place to add at");
        let from = patched(rows(), json!([{"op":"move","from":"/elements/t/props/rows/@r7","path":"/elements/t/props/rows/0"}])).unwrap_err();
        assert_eq!((from.field, from.code), ("from", "patch_path"));

        // A copy makes a second r8: from then on @r8 names no single row.
        let twice = patched(rows(), json!([{"op":"copy","from":"/elements/t/props/rows/@r8","path":"/elements/t/props/rows/-"},
            {"op":"replace","path":"/elements/t/props/rows/@r8/cells/status","value":"done"}])).unwrap_err();
        assert_eq!((twice.index, twice.field, twice.code), (1, "path", "patch_path"));
        assert_eq!(twice.reason, "/elements/t/props/rows has 2 items whose id is \"r8\" (at 2, 4): name one by its index.");
        let mut doubled = rows();
        doubled["elements"]["t"]["props"]["rows"][3]["id"] = json!("r8");
        for op in [json!({"op":"remove","path":"/elements/t/props/rows/@r8"}), json!({"op":"add","path":"/elements/t/props/rows/@r8","value":{}}),
            json!({"op":"test","path":"/elements/t/props/rows/@r8/id","value":"r8"})] {
            assert_eq!(patched(doubled.clone(), json!([op])).unwrap_err().code, "patch_path", "{op}");
        }

        let empty = patched(rows(), json!([{"op":"remove","path":"/elements/t/props/rows/@"}])).unwrap_err();
        assert_eq!(empty.reason, "/elements/t/props/rows: @ names an item by its id, e.g. @r8; give the id after it.");
        let no_ids = patched(rows(), json!([{"op":"remove","path":"/elements/body/children/@t"}])).unwrap_err();
        assert_eq!(no_ids.reason, "/elements/body/children has no item with an id, so there is no @t: name an entry by its index.");
        let moved_in = patched(rows(), json!([{"op":"move","from":"/elements/t/props/rows/@r8","path":"/elements/t/props/rows/2/cells/r8"}])).unwrap_err();
        assert!(moved_in.reason.contains("can't be moved into itself"), "the same row by index: {}", moved_in.reason);
        let moved_in = patched(rows(), json!([{"op":"move","from":"/elements/t/props/rows/2","path":"/elements/t/props/rows/@r8/cells/r8"}])).unwrap_err();
        assert!(moved_in.reason.contains("can't be moved into itself"), "the same row by id: {}", moved_in.reason);
    }

    /// Paths without @ mean what they meant: indices, - and object keys,
    /// a key "@x" included.
    #[test]
    fn plain_pointers_keep_their_meaning() {
        let done = patched(rows(), json!([{"op":"replace","path":"/elements/t/props/rows/2/cells/status","value":"done"},
            {"op":"add","path":"/elements/t/props/rows/-","value":{"id":"r10"}},
            {"op":"add","path":"/elements/@x","value":1}])).unwrap();
        assert_eq!((done["elements"]["t"]["props"]["rows"][2]["cells"]["status"].clone(), done["elements"]["@x"].clone()), (json!("done"), json!(1)));
        assert_eq!(ids(&done), ["r1", "r2", "r8", "r9", "r10"]);
        assert_eq!(patched(done, json!([{"op":"remove","path":"/elements/@x"}])).unwrap()["elements"].get("@x"), None);
        // A bare id is not an index: refused, with the way to name that row.
        let bare = patched(rows(), json!([{"op":"replace","path":"/elements/t/props/rows/r8/cells/status","value":"done"}])).unwrap_err();
        assert_eq!((bare.code, bare.reason.as_str()), ("patch_path",
            "/elements/t/props/rows has 4 entries (0-3), so there is no r8; to name the item whose id is \"r8\", write @r8."));
        let far = patched(rows(), json!([{"op":"add","path":"/elements/t/props/rows/9","value":{}}])).unwrap_err();
        assert_eq!(far.reason, "/elements/t/props/rows has 4 entries: add at an index 0-4, at - for the end or at @<id> before that item.");
    }

    #[test]
    fn a_failed_test_stops_the_patch() {
        let failed = patched(json!({"a":"now"}), json!([{"op":"test","path":"/a","value":"then"},{"op":"replace","path":"/a","value":"x"}])).unwrap_err();
        assert_eq!((failed.index, failed.code), (0, "patch_test"));
        assert_eq!(failed.reason, "/a is \"now\", not the value the test gives; nothing was changed.");
    }
}
