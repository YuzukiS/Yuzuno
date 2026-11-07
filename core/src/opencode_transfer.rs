//! Moving an OpenCode 2.x session into a new Agent's own OpenCode (T-61
//! slice 7, D-28 F-A): what Fork, and Import after it, share. The session is
//! written whole through 2.x's own import (`POST
//! /api/experimental/session/import`, 2.2.5 core/src/session/transfer.ts),
//! under an ID Core chooses, into an OpenCode whose database holds nothing
//! else; then it is read back and compared, field by field.
//!
//! 2.x's import keeps each message's ID and order, writes only settled
//! messages, takes the project from the folder it is given, and is one
//! transaction: all of it or nothing. A session it already holds under that
//! ID is refused (409, `ConflictError`), so the same request sent again
//! after an answer that never came writes nothing twice.
use crate::opencode::HttpStatus;
use anyhow::{ensure, Result};
use serde_json::{json, Value};

/// The message types 2.x keeps in a session (2.2.5
/// schema/src/session-message.ts `Info`).
pub const KNOWN_TYPES: [&str; 11] = [
    "agent-switched", "model-switched", "location-switched", "user", "synthetic", "system", "skill", "shell", "assistant", "compaction", "idle",
];

/// A new 2.x session ID, made as 2.x makes its own (schema/src/session-id.ts,
/// identifier.ts `descending`): `ses_`, then 12 hex digits of the time in
/// milliseconds times 4096 plus a count, inverted (so newer IDs sort first),
/// then 14 letters and digits at random.
pub fn session_id() -> String {
    static LAST: std::sync::Mutex<(u64, u64)> = std::sync::Mutex::new((0, 0));
    const CHARS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let now = chrono::Utc::now().timestamp_millis().max(0) as u64;
    let n = {
        let mut last = LAST.lock().unwrap();
        if last.0 != now {
            *last = (now, 0);
        }
        last.1 += 1;
        last.1
    };
    let value = !(now.wrapping_mul(0x1000).wrapping_add(n)) & 0xffff_ffff_ffff;
    let random = uuid::Uuid::new_v4().into_bytes();
    let tail: String = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15].iter().map(|&i| CHARS[random[i] as usize % 62] as char).collect();
    format!("ses_{value:012x}{tail}")
}

/// Whether a message is settled, as 2.x's import keeps it (transfer.ts
/// `isSettled`): an answer once completed, a shell or compaction once no
/// longer running, anything else always.
pub fn settled(message: &Value) -> bool {
    match message["type"].as_str() {
        Some("assistant") => message["time"]["completed"].is_number(),
        Some("shell") | Some("compaction") => message["status"] != "running",
        _ => true,
    }
}

/// What 2.x's import answered.
#[derive(Debug)]
pub enum ImportAnswer {
    /// 200: the session as 2.x holds it now.
    Imported(Value),
    /// 409 for this very ID: 2.x holds a session under it already (one an
    /// earlier request wrote, or another; only a read tells).
    Exists,
    /// 2.x refused it before writing anything: a body it could not read
    /// (400 of a request kind), or a parent it does not hold (404).
    Refused(HttpStatus),
    /// Anything else: no answer, or one that says nothing of what it did.
    Unknown(String),
}

/// Whether a 2.x answer to an import of `session` is one of 2.x's own
/// refusals before anything was written, or its conflict for that ID.
pub fn import_answer(status: &HttpStatus, session: &str) -> Option<ImportAnswer> {
    let body: Value = serde_json::from_str(&status.body).ok()?;
    let text = body["message"].is_string();
    match status.code {
        409 if body["_tag"] == "ConflictError" && body["resource"] == session && text => Some(ImportAnswer::Exists),
        404 if body["_tag"] == "SessionNotFoundError" && text => Some(ImportAnswer::Refused(status.clone())),
        400 if body["_tag"] == "InvalidRequestError" && text
            && matches!(body["kind"].as_str(), Some("Params" | "Headers" | "Query" | "Payload")) => Some(ImportAnswer::Refused(status.clone())),
        _ => None,
    }
}

/// The session a transfer writes, as Core makes it.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Payload {
    /// 2.x's `Session.Info`, as sent.
    pub info: Value,
    /// Every message, settled, in order, as read.
    pub messages: Vec<Value>,
    /// The folder 2.x writes it for.
    pub directory: String,
}

impl Payload {
    /// The import's body.
    pub fn body(&self) -> Value {
        json!({"info": self.info, "messages": self.messages, "location": {"directory": self.directory}})
    }

    /// The session's ID.
    pub fn id(&self) -> &str {
        self.info["id"].as_str().unwrap_or_default()
    }
}

/// `value` with no null field at its top level or in its `time`: 2.x reads
/// an optional field as absent, never as null.
pub fn without_nulls(value: &mut Value) {
    if let Some(time) = value.get_mut("time").and_then(Value::as_object_mut) {
        time.retain(|_, v| !v.is_null());
    }
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, v| !v.is_null());
    }
}

/// Zero usage, in 2.x's shape (schema/src/token-usage.ts).
pub fn no_tokens() -> Value {
    json!({"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}})
}

/// The model or agent a session runs with at the end of `messages`: the
/// newest `model-switched` (`agent-switched`) there, else `fallback`.
pub fn selected(messages: &[Value], kind: &str, field: &str, fallback: &Value) -> Value {
    messages.iter().rev().find(|m| m["type"] == kind).map(|m| m[field].clone()).unwrap_or_else(|| fallback.clone())
}

/// A model as 2.x reads it back: one with no variant is its `default`
/// (2.2.5 core/src/session/info.ts).
fn model_read(model: &Value) -> Value {
    let mut model = model.clone();
    if let Some(object) = model.as_object_mut() {
        object.entry("variant").or_insert(json!("default"));
    }
    model
}

/// What a session read back from the OpenCode it was written into must be:
/// what was sent, field by field (2.x sets `time.updated` itself, and the
/// project from the folder: `project`), and every message exactly as sent,
/// in order. Refused, naming the first difference.
pub fn read_back(payload: &Payload, project: &str, info: &Value, messages: &[Value]) -> Result<()> {
    let sent = &payload.info;
    ensure!(info["id"] == sent["id"], "读回的会话不是这次写入的 {}", sent["id"]);
    ensure!(info["projectID"] == project, "读回的会话不属于新 Agent 的 OpenCode 为这个目录认定的项目");
    ensure!(info["location"]["directory"] == payload.directory.as_str(), "读回的会话不在这个目录");
    for name in ["parentID", "fork", "revert"] {
        ensure!(info[name].is_null(), "读回的会话带有 {name}");
    }
    for name in ["title", "metadata", "agent", "permissions", "cost", "tokens", "outcome"] {
        ensure!(info[name] == sent[name], "读回的会话的 {name} 与写入的不同");
    }
    ensure!(model_read(&info["model"]) == model_read(&sent["model"]), "读回的会话的模型与写入的不同");
    for name in ["created", "idle", "archived"] {
        ensure!(info["time"][name] == sent["time"][name], "读回的会话的 time.{name} 与写入的不同");
    }
    ensure!(messages.len() == payload.messages.len(), "读回的会话有 {} 条消息，写入的是 {} 条", messages.len(), payload.messages.len());
    for (index, (got, sent)) in messages.iter().zip(&payload.messages).enumerate() {
        ensure!(got == sent, "读回的第 {} 条消息（{}）与写入的不同", index + 1, sent["id"]);
    }
    Ok(())
}

/// What a fresh OpenCode lists before a transfer writes into it: nothing, or
/// only the very session this transfer writes, with its marker (an earlier
/// request of it that was written though its answer was lost). Whether it is
/// there; refused if anything else is.
pub fn holds_only(listed: &[Value], payload: &Payload) -> Result<bool> {
    match listed {
        [] => Ok(false),
        [one] if one["id"] == payload.info["id"] && one["metadata"] == payload.info["metadata"] => Ok(true),
        _ => {
            let ids: Vec<&str> = listed.iter().filter_map(|s| s["id"].as_str()).collect();
            anyhow::bail!("新 Agent 的 OpenCode 里已有不是这次写入的会话（{}）；没有覆盖", ids.join(", "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_have_2xs_form_sort_newest_first_and_do_not_repeat() {
        let (a, b) = (session_id(), session_id());
        for id in [&a, &b] {
            assert_eq!(id.len(), 30, "{id}");
            assert!(id.starts_with("ses_") && id[4..16].chars().all(|c| c.is_ascii_hexdigit()) && id[16..].chars().all(|c| c.is_ascii_alphanumeric()), "{id}");
        }
        assert_ne!(a, b);
        assert!(b[4..16] < a[4..16], "a newer one sorts first: {a} {b}");
    }

    fn payload() -> Payload {
        Payload {
            info: json!({"id": "ses_x", "projectID": "prj", "title": "F", "location": {"directory": "/w"}, "metadata": {"yuzuno": {"fork": "r"}},
                "cost": 0, "tokens": no_tokens(), "time": {"created": 1, "updated": 3, "idle": 3}, "outcome": "succeeded",
                "model": {"id": "m", "providerID": "p"}}),
            messages: vec![json!({"id": "msg_1", "type": "user", "text": "a", "time": {"created": 1}}),
                json!({"id": "msg_2", "type": "assistant", "native": {"k": 1}, "content": [], "time": {"created": 2, "completed": 3}})],
            directory: "/w".into(),
        }
    }

    /// U5 (rule R6): what is read back is what was written, field by field
    /// and message by message; only `time.updated` and a model's default
    /// variant are 2.x's own.
    #[test]
    fn read_back_must_equal_the_payload_exactly() {
        let p = payload();
        let mut info = p.info.clone();
        info["time"]["updated"] = json!(99);
        info["model"]["variant"] = json!("default");
        read_back(&p, "prj", &info, &p.messages).expect("as written");
        let mut dropped = p.messages.clone();
        dropped[1].as_object_mut().unwrap().remove("native");
        assert!(read_back(&p, "prj", &info, &dropped).unwrap_err().to_string().contains("第 2 条消息"), "one dropped key");
        assert!(read_back(&p, "prj", &info, &p.messages[..1]).unwrap_err().to_string().contains("1 条消息"), "one dropped message");
        assert!(read_back(&p, "other", &info, &p.messages).unwrap_err().to_string().contains("项目"));
        for (field, value) in [("parentID", json!("ses_p")), ("title", json!("x")), ("cost", json!(1)), ("metadata", json!({}))] {
            let mut changed = info.clone();
            changed[field] = value;
            assert!(read_back(&p, "prj", &changed, &p.messages).unwrap_err().to_string().contains(field), "{field}");
        }
        let mut idle = info.clone();
        idle["time"]["idle"] = json!(4);
        assert!(read_back(&p, "prj", &idle, &p.messages).unwrap_err().to_string().contains("time.idle"));
    }

    /// Rule R5: an OpenCode a transfer writes into lists nothing, or only
    /// that very copy with its marker; anything else is refused.
    #[test]
    fn a_target_holds_nothing_or_only_this_copy() {
        let p = payload();
        let ours = json!({"id": "ses_x", "metadata": {"yuzuno": {"fork": "r"}}});
        assert!(!holds_only(&[], &p).unwrap());
        assert!(holds_only(&[ours.clone()], &p).unwrap());
        for listed in [vec![json!({"id": "ses_x"})], vec![json!({"id": "ses_y", "metadata": {"yuzuno": {"fork": "r"}}})], vec![ours.clone(), json!({"id": "ses_y"})]] {
            assert!(holds_only(&listed, &p).unwrap_err().to_string().contains("没有覆盖"), "{listed:?}");
        }
    }

    /// 2.x's own refusals before anything is written, and its conflict for
    /// this very ID; nothing else.
    #[test]
    fn only_2xs_own_answers_say_what_an_import_did() {
        let read = |code: u16, body: Value| import_answer(&HttpStatus { code, body: body.to_string() }, "ses_x");
        assert!(matches!(read(409, json!({"_tag": "ConflictError", "resource": "ses_x", "message": "Session already exists: ses_x"})), Some(ImportAnswer::Exists)));
        assert!(matches!(read(404, json!({"_tag": "SessionNotFoundError", "sessionID": "ses_p", "message": "m"})), Some(ImportAnswer::Refused(_))));
        assert!(matches!(read(400, json!({"_tag": "InvalidRequestError", "kind": "Payload", "message": "m"})), Some(ImportAnswer::Refused(_))));
        for (code, body) in [(409, json!({"_tag": "ConflictError", "resource": "ses_other", "message": "m"})), (400, json!({"_tag": "InvalidRequestError", "kind": "Body", "message": "m"})),
            (500, json!({"_tag": "UnknownError", "message": "m"})), (409, json!({"_tag": "ConflictError", "resource": "ses_x"}))] {
            assert!(read(code, body.clone()).is_none(), "{code} {body}");
        }
    }
}
