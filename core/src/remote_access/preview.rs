//! What an older Core's phone previews left (T-5).
//!
//! Before previews went through the phone entry itself (`previews`), they
//! had a loopback listener and a Serve entry of their own, on another HTTPS
//! port of the same tailnet name, recorded in `remote-preview.json`. That
//! record is read, never served again: whether they were on (the choice
//! phone access keeps until it saves one of its own) and the Serve entry
//! Core set for them. The next change of phone access removes that entry
//! (`clear`), only while it is still exactly what Core set: HTTPS, one
//! handler for "/" proxying to its target, no Funnel (`host::serve_entry`).
//! Serve is never reset, and nothing else there is touched. The record is
//! kept as it is. Once that entry is gone or is no longer Core's, the record
//! moves it to `formerOwned`, with what became of it (`disposition`): never
//! taken for Core's again, and never forgotten. While it is still held, a
//! change that could not remove it says why in `lastAttempt`.
use super::*;

const FILE: &str = "remote-preview.json";

fn path(ws: &Workspace) -> PathBuf {
    ws.data_dir.join(FILE)
}

/// The record as it is on disk, or none.
fn record(ws: &Workspace) -> Result<Option<Value>> {
    match std::fs::read(path(ws)) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).with_context(|| format!("{} is not a readable phone previews record", path(ws).display()))?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// The Serve entry `record` says Core set for them, if it still says one.
fn owned(record: &Value) -> Result<Option<Owned>> {
    match &record["owned"] {
        Value::Null => Ok(None),
        owned => Ok(Some(serde_json::from_value(owned.clone()).context("its Serve entry cannot be read")?)),
    }
}

/// The record, and the Serve entry it still says is Core's.
fn left(ws: &Workspace) -> Result<Option<(Value, Owned)>> {
    let Some(record) = record(ws)? else { return Ok(None) };
    Ok(owned(&record)?.map(|owned| (record, owned)))
}

/// The Serve entry an older Core's record still says it set for its phone
/// previews; none without a record or an entry in it; an error when the
/// record cannot be read (missing access, not JSON, an entry not as Core
/// writes it), which never reads as none.
pub(super) fn held(ws: &Workspace) -> Result<Option<Owned>> {
    Ok(left(ws)?.map(|(_, owned)| owned))
}

/// Where that record is, for the page to name.
pub(super) fn record_path(ws: &Workspace) -> PathBuf {
    path(ws)
}

/// Whether a change has anything of an older Core's phone previews to look at:
/// an entry its record still holds, or a record it cannot read.
pub(super) fn pending(ws: &Workspace) -> bool {
    !matches!(left(ws), Ok(None))
}

/// Whether an older Core's phone previews were turned on.
pub(super) fn legacy_on(ws: &Workspace) -> bool {
    record(ws).ok().flatten().is_some_and(|record| record["desired"]["enabled"] == true)
}

/// The page's view, read only: the Serve entry still to remove (with the
/// last change's try at it, if one could not), or what became of the one
/// they had (`state`, `formerOwned`), or why the record cannot be read;
/// none without a record of theirs.
pub(super) fn view(ws: &Workspace) -> Value {
    match left(ws) {
        Ok(Some((record, owned))) => json!({"servePort": owned.serve_port, "host": owned.host, "target": owned.target,
            "lastAttempt": record.get("lastAttempt").cloned().unwrap_or(Value::Null)}),
        Ok(None) => match record(ws) {
            Ok(Some(record)) if record["formerOwned"].is_object() => json!({
                "state": record["disposition"]["state"], "detail": record["disposition"]["detail"], "at": record["disposition"]["at"],
                "formerOwned": record["formerOwned"],
            }),
            _ => Value::Null,
        },
        Err(error) => json!({"error": format!("{error:#}")}),
    }
}

fn timed_out(error: &anyhow::Error) -> bool {
    error.chain().any(|e| e.downcast_ref::<host::TimedOut>().is_some())
}

/// Remove an older Core's Serve entry for phone previews, as a change of
/// phone access does (the change holds the one-change lock). Never the one on
/// `phone`, the Serve port phone access holds as its own now. Says what
/// became of it, none when nothing was left: `removed`, or `absent` (gone
/// already), or `foreign` (changed outside Yuzuno, or phone access's port:
/// left as it is) — each of which makes it a former entry of theirs, never
/// Core's again — or `partial` (refused, or not readable) and `uncertain`
/// (no answer), which keep it held for the next change to look again.
pub(super) async fn clear(ws: &Workspace, host: &Host, phone: Option<u16>) -> Option<Value> {
    let said = |state: &str, detail: String| Some(json!({"state": state, "detail": detail}));
    let owned = match left(ws) {
        Ok(Some((_, owned))) => owned,
        Ok(None) => return None,
        Err(error) => return said("partial", format!("The older phone previews' record could not be read ({error:#}); it is kept as it is")),
    };
    let port = owned.serve_port;
    if phone == Some(port) {
        // Phone access serves there now (refused while theirs is held, so only
        // records from before can meet): never removed for them.
        let detail = format!("Phone access serves on Serve port {port} now; nothing of the older phone previews there was removed");
        return settled(ws, &owned, "foreign", detail);
    }
    if !host.supported {
        return tried(ws, &owned, "partial", format!("Serve could not be changed on this host; the older phone previews' port {port} may still be served"));
    }
    let found = match host::serve_status(host).await {
        Ok(config) => host::serve_entry(&config, &owned.host, port, &owned.target).0,
        Err(error) => {
            let state = if timed_out(&error) { "uncertain" } else { "partial" };
            return tried(ws, &owned, state, format!("Serve's configuration could not be read for the older phone previews' port {port}: {error:#}; it is kept for the next change"));
        }
    };
    let (state, detail) = match found {
        "match" => match host::serve_off(host, port).await {
            Ok(()) => ("removed", format!("The older phone previews' own Serve port {port} was removed")),
            Err(error) => {
                let state = if timed_out(&error) { "uncertain" } else { "partial" };
                return tried(ws, &owned, state, format!("The older phone previews' own Serve port {port} was not removed: {error:#}; it is kept for the next change"));
            }
        },
        "absent" => ("absent", format!("The older phone previews' own Serve port {port} was already gone")),
        _ => ("foreign", format!("The older phone previews' Serve port {port} was changed outside Yuzuno; it is left as it is")),
    };
    settled(ws, &owned, state, detail)
}

/// `owned` no longer held for them, with what became of it: the record's
/// `formerOwned` and `disposition`, all else in it as it was. Says so, or
/// `partial` when the record could not be written (it then still holds it).
fn settled(ws: &Workspace, owned: &Owned, state: &str, detail: String) -> Option<Value> {
    let change = |record: &mut Value| {
        record["owned"] = Value::Null;
        record["formerOwned"] = json!({"servePort": owned.serve_port, "host": owned.host, "target": owned.target});
        record["disposition"] = json!({"state": state, "detail": detail, "at": crate::model::now()});
    };
    match rewrite(ws, owned, change) {
        Ok(()) => Some(json!({"state": state, "detail": detail})),
        Err(error) => Some(json!({"state": "partial", "detail": format!("{detail}, but their record could not be updated: {error:#}")})),
    }
}

/// `owned` still held for them, with why this change could not remove it
/// (`lastAttempt`). Says so; a record that could not be written changes
/// nothing of what this change says.
fn tried(ws: &Workspace, owned: &Owned, state: &str, detail: String) -> Option<Value> {
    let change = |record: &mut Value| record["lastAttempt"] = json!({"state": state, "detail": detail, "at": crate::model::now()});
    if let Err(error) = rewrite(ws, owned, change) {
        eprintln!("Older phone previews record: {error:#}");
    }
    Some(json!({"state": state, "detail": detail}))
}

/// The record changed by `change` while it still holds `owned`, written whole.
fn rewrite(ws: &Workspace, owned: &Owned, change: impl FnOnce(&mut Value)) -> Result<()> {
    let _held = ws.remote_access.file.lock().unwrap();
    let Some(mut record) = record(ws)? else { return Ok(()) };
    if self::owned(&record)?.as_ref() == Some(owned) {
        change(&mut record);
        crate::updates::package::atomic_json(&path(ws), &record)?;
    }
    Ok(())
}
