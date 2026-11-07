//! RFC 6902 JSON Patch on a section body (YN-14 A2): what brief_update's
//! `patch` op applies to the stored body before Core checks the whole
//! section again, as it checks an edit. Paths are JSON Pointers (RFC 6901)
//! into the body, e.g. /elements/refs/props/items/3/note, so an Agent
//! changes one value without sending the block it is in.
use serde_json::{Map, Value};

/// At most this many operations in one patch change.
pub(super) const MAX_OPS: usize = 64;
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
        let from = || pointer(op["from"].as_str().unwrap_or_default()).map_err(|reason| fail("from", "patch_path", reason));
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
                if path.len() > from.len() && path.starts_with(&from) {
                    return Err(fail("path", "patch_path", format!("{} is inside {}: a value can't be moved into itself.", shown(&path), shown(&from))));
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
    tokens.iter().map(|token| format!("/{}", token.replace('~', "~0").replace('/', "~1"))).collect()
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
        Value::Array(list) if list.is_empty() => format!("{at} has no entries, so there is no {token}."),
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
            Value::Array(list) => index(token, list.len(), false).and_then(|i| list.get(i)),
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
                let at = index(token, list.len(), false).expect("found before");
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
            let at = index(last, len, true)
                .ok_or_else(|| format!("{} has {len} entries: add at an index 0-{len} or at - for the end.", shown(&tokens[..tokens.len() - 1])))?;
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
        Value::Array(list) => list.remove(index(last, list.len(), false).expect("found before")),
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

    #[test]
    fn a_failed_test_stops_the_patch() {
        let failed = patched(json!({"a":"now"}), json!([{"op":"test","path":"/a","value":"then"},{"op":"replace","path":"/a","value":"x"}])).unwrap_err();
        assert_eq!((failed.index, failed.code), (0, "patch_test"));
        assert_eq!(failed.reason, "/a is \"now\", not the value the test gives; nothing was changed.");
    }
}
