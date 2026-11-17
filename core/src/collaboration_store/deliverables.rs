//! A result's deliverables (YN-208): what the user opens from the original
//! request, named by the result's author and checked when the result is
//! submitted, never guessed from a title, a time or the summary's words.
//!
//! `deliverables` is the result's whole list. Left out, the list an earlier
//! result named stays the task's; an empty list clears it; any other list
//! takes its place, adding nothing to it. Each entry is one of:
//! - `report`: a report on the Home of the task's Project, live or in its
//!   History, by its key and version (its current one by default); kept as
//!   its identity on Home and version, so another report later under the
//!   same key is never taken for it;
//! - `pr`: a pull request this task links (github_links);
//! - `release`: a GitHub release page of a repository linked to the
//!   Project; Core keeps the link and its tag, and never reads the page;
//! - `answer`: a short answer.
//!
//! One that fails refuses the whole result, before anything is written.
//! Where each stands now is read when a request shows it (`shown`): the
//! report's version kept or not, the pull request's state as Core last read
//! it from GitHub, with when.
use super::*;

/// At most this many deliverables in a result, as routes in a request.
pub(super) const MAX: usize = 6;
/// A title and a note: one line each, in UTF-16 units, as a route's title.
const MAX_LINE: usize = 120;
/// An answer, in UTF-16 units.
const MAX_ANSWER: usize = 300;

const KINDS: [&str; 4] = ["report", "pr", "release", "answer"];

/// The parameter's schema, for task_submit_result.
pub(super) fn schema() -> Value {
    let string = |description: &str| json!({"type":"string","description":description});
    json!({"type":"array","maxItems":MAX,
        "description":"The main deliverables of this task, which the user opens from the original request. The whole list: \
            it replaces the list an earlier result named and never adds to it, so name every one still meant (a report \
            delivered earlier as well as the PR now). Omit it to keep the earlier list; [] clears it. Each is checked now, \
            and one that fails refuses the whole result.",
        "items":{"type":"object","additionalProperties":false,"required":["kind"],"properties":{
            "kind":{"type":"string","enum":KINDS},
            "key":string("report: its section key on the Home of this task's Project; a report there, live or in History."),
            "version":{"type":"integer","minimum":1,"description":"report: the version delivered; its current one by default."},
            "url":string("pr: a pull request this task links (github_links). release: https://github.com/<owner>/<repo>/releases/tag/<tag> \
                of a repository linked to the Project; Core does not read the page."),
            "text":string("answer: the answer, at most 300 characters."),
            "title":string("At most 120 characters, one line; by default the report's or the PR's title, or the release's tag."),
            "note":string("report, pr, release: what it gives the user, one line of at most 120 characters.")}}})
}

/// `deliverables` as the result keeps it: None when left out (or null), the
/// list as checked otherwise.
pub(super) fn validate(db: &Connection, task: &SharedTask, value: Option<&Value>) -> Result<Option<Value>> {
    let entries = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(entries)) => entries,
        Some(_) => bail!("deliverable_invalid: deliverables is a list; give [] to clear the list an earlier result named"),
    };
    ensure!(entries.len() <= MAX, "deliverable_invalid: {} deliverables; at most {MAX}, the task's main ones", entries.len());
    let project: Option<String> = db
        .query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [&task.id], |r| r.get(0))
        .optional()?;
    let mut kept = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let at = format!("deliverables[{index}]");
        kept.push(entry_kept(db, task, project.as_deref(), entry, &at)?);
    }
    Ok(Some(Value::Array(kept)))
}

fn entry_kept(db: &Connection, task: &SharedTask, project: Option<&str>, entry: &Value, at: &str) -> Result<Value> {
    let kind = entry.get("kind").and_then(Value::as_str).unwrap_or_default();
    ensure!(KINDS.contains(&kind), "deliverable_invalid: {at}.kind is report, pr, release or answer");
    let fields: &[&str] = match kind {
        "report" => &["kind", "key", "version", "title", "note"],
        "pr" | "release" => &["kind", "url", "title", "note"],
        _ => &["kind", "text", "title"],
    };
    if let Some(field) = entry.as_object().into_iter().flat_map(|map| map.keys()).find(|field| !fields.contains(&field.as_str())) {
        bail!("deliverable_invalid: {at} ({kind}) takes {}, not {field}", fields.join(", "));
    }
    let title = line(entry, "title", MAX_LINE, at)?;
    let note = line(entry, "note", MAX_LINE, at)?;
    let in_project = |what: &str| {
        project.with_context(|| format!("deliverable_invalid: {at}: {} is in no Project, so it has no {what}", task_shown(db, &task.id)))
    };
    match kind {
        "report" => {
            let project = in_project("Home")?;
            let key = entry.get("key").and_then(Value::as_str).map(str::trim).unwrap_or_default();
            ensure!(!key.is_empty(), "deliverable_invalid: {at}.key is the report's section key on Home");
            let version = match entry.get("version") {
                None | Some(Value::Null) => None,
                Some(value) => Some(value.as_i64().filter(|n| *n >= 1).with_context(|| format!("deliverable_invalid: {at}.version is a number from 1"))?),
            };
            let named = crate::project_brief::named_report(db, project, key, version)?.with_context(|| {
                let which = version.map(|v| format!(" version {v}")).unwrap_or_default();
                format!("deliverable_not_found: {at}: the Home of this task's Project keeps no report {key}{which}, live or in History; \
                    give the key (and version) of a report brief_get lists, not a status or an ask")
            })?;
            Ok(json!({"kind":"report","title":title.unwrap_or(named.title),"note":note,"key":key,"version":named.version,
                "sectionId":named.identity}))
        }
        "pr" => {
            let url = required_url(entry, at)?;
            let target = crate::github::client::parse(url, true)
                .ok()
                .filter(|target| target.kind.as_deref() == Some("pull"))
                .with_context(|| format!("deliverable_invalid: {at}.url is a pull request's https://github.com/<owner>/<repo>/pull/<n>"))?;
            let number = target.number.unwrap_or_default();
            let (repo, name, snapshot_title) = crate::github::store::task_pull(db, &task.id, &target.repo, number)?.with_context(|| {
                format!("deliverable_not_found: {at}: {} does not link {}#{number}; link the pull request with github_links first",
                    task_shown(db, &task.id), target.repo)
            })?;
            let title = title.or(snapshot_title).unwrap_or_else(|| format!("{name}#{number}"));
            Ok(json!({"kind":"pr","title":title,"note":note,"url":format!("https://github.com/{name}/pull/{number}"),
                "repositoryId":repo,"repository":name,"number":number}))
        }
        "release" => {
            let project = in_project("repositories")?;
            let url = required_url(entry, at)?;
            let (owner_repo, tag) = release(url).with_context(|| {
                format!("deliverable_invalid: {at}.url is a release page, https://github.com/<owner>/<repo>/releases/tag/<tag>")
            })?;
            let (repo, name) = crate::github::store::project_repository(db, project, &owner_repo)?.with_context(|| {
                format!("deliverable_not_found: {at}: {owner_repo} is not a repository of this task's Project; \
                    a release is one of the Project's repositories")
            })?;
            Ok(json!({"kind":"release","title":title.unwrap_or_else(|| tag.clone()),"note":note,
                "url":format!("https://github.com/{name}/releases/tag/{tag}"),"repositoryId":repo,"repository":name,"tag":tag}))
        }
        _ => {
            let text = line(entry, "text", MAX_ANSWER, at)?.with_context(|| format!("deliverable_invalid: {at}.text is the answer"))?;
            Ok(json!({"kind":"answer","title":title,"text":text}))
        }
    }
}

/// An optional one-line text: trimmed, not only blank, at most `max` UTF-16 units.
fn line(entry: &Value, field: &str, max: usize, at: &str) -> Result<Option<String>> {
    match entry.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            let text = text.trim();
            ensure!(!text.is_empty(), "deliverable_invalid: {at}.{field} is empty; leave it out instead");
            ensure!(!text.contains(['\n', '\r']), "deliverable_invalid: {at}.{field} is one line");
            let length = text.encode_utf16().count();
            ensure!(length <= max, "deliverable_invalid: {at}.{field} is {length} characters; at most {max}");
            Ok(Some(text.to_owned()))
        }
        Some(_) => bail!("deliverable_invalid: {at}.{field} is text"),
    }
}

fn required_url<'a>(entry: &'a Value, at: &str) -> Result<&'a str> {
    let url = entry.get("url").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    ensure!(!url.is_empty() && url.len() <= 300, "deliverable_invalid: {at}.url is a https://github.com link of at most 300 bytes");
    Ok(url)
}

/// `https://github.com/<owner>/<repo>/releases/tag/<tag>`: owner/repo and
/// the tag. The tag keeps GitHub's plain tag characters, `/` included.
fn release(url: &str) -> Option<(String, String)> {
    let path = url.strip_prefix("https://github.com/")?.trim_end_matches('/');
    let mut parts = path.splitn(5, '/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    (parts.next()? == "releases" && parts.next()? == "tag").then_some(())?;
    let tag = parts.next()?;
    let name = |s: &str| {
        !s.is_empty() && s.len() <= 100 && !s.starts_with(['-', '.']) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    };
    let tag_ok = !tag.is_empty()
        && tag.len() <= 200
        && tag.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.+/".contains(&b))
        && tag.split('/').all(|part| !part.is_empty() && part != "." && part != "..");
    (name(owner) && name(repo) && tag_ok).then(|| (format!("{owner}/{repo}"), tag.to_owned()))
}

/// What a request shows of the task's deliverables (progress.rs): the list
/// the newest result that named one named, each as it stands now; None when
/// no result named one.
pub(crate) fn shown(db: &Connection, project: &str, task: &str) -> Result<Option<Value>> {
    // Read through collaboration_activity_deliverables.
    let raw: Option<String> = db
        .query_row(
            "SELECT json_extract(data,'$.result') FROM collaboration_task_activity
             WHERE task_id=?1 AND json_extract(data,'$.kind')='result' AND json_type(data,'$.result.deliverables')='array'
             ORDER BY seq DESC LIMIT 1",
            [task],
            |r| r.get(0),
        )
        .optional()?;
    let Some(result) = raw.map(|raw| serde_json::from_str::<Value>(&raw)).transpose()? else { return Ok(None) };
    let mut items = Vec::new();
    for item in result["deliverables"].as_array().into_iter().flatten() {
        let mut item = item.clone();
        match item["kind"].as_str() {
            Some("report") => {
                let (identity, version) = (item["sectionId"].as_i64().unwrap_or_default(), item["version"].as_i64().unwrap_or_default());
                let (state, newest) = crate::project_brief::report_now(db, project, identity, version)?;
                item["state"] = json!(state);
                item["currentVersion"] = json!(newest);
            }
            Some("pr") => {
                let (repo, number) = (item["repositoryId"].as_i64().unwrap_or_default(), item["number"].as_u64().unwrap_or_default());
                let (state, at) = crate::github::store::pull_state(db, repo, number)?.unwrap_or_else(|| ("unknown".into(), None));
                let state = if matches!(state.as_str(), "open" | "merged" | "closed") { state } else { "unknown".into() };
                item["state"] = json!(state);
                item["observedAt"] = json!(at);
            }
            _ => {}
        }
        if let Some(fields) = item.as_object_mut() {
            fields.remove("repositoryId");
        }
        items.push(item);
    }
    Ok(Some(json!({"resultId":result["id"],"reportedAt":result["reportedAt"],"items":items})))
}
