//! `brief_update`: an Agent's changes to its Project's Brief, or its
//! explicit "no change", bound to the Turn Core vouches for.
//!
//! Checked twice: once on a reader, so most rejections cost no validator
//! run and no write; then again in the write transaction, against the state
//! that is actually changed. Sections are checked by the validator between
//! the two, outside any database lock, and attachment files are copied
//! there too (see attachments::stage).
use super::{
    attachments,
    sections::{self, Owners, Row},
    writes, *,
};
use crate::results::{reliable_turn, Pinned, Validator};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const TOOL: &str = "brief_update";
pub(super) const MAX_CHANGES: usize = 24;
/// Blocks one edit may replace: a body's component limit.
const MAX_EDITED: usize = 32;
/// The problems a rejection lists, as the contract's limits.callProblems.
pub(super) const MAX_PROBLEMS: usize = 10;
/// Advice an answer carries at most (T-176), as the contract's limits.advice.items.
pub(super) const MAX_ADVICE: usize = 3;

/// What checks a section `put`: the generated validator, or in tests a
/// stand-in for it.
pub(crate) enum Checker {
    Node(Arc<Validator>),
    #[cfg(test)]
    Fake(fn(&Value) -> Result<Value, Value>),
    /// A stand-in that also gives advice.
    #[cfg(test)]
    Advising(fn(&Value) -> Result<(Value, Vec<Value>), Value>),
}

impl Checker {
    /// The normalized section and the validator's advice on it, or its problems.
    async fn check(&self, section: &Value, previous_body: Option<&Value>) -> Result<Result<(Value, Vec<Value>), Value>, String> {
        match self {
            Checker::Node(validator) => {
                if brief_schema_version().is_none() {
                    return Err("this Core's validator predates Project Briefs".into());
                }
                validator.check_brief_section(section, previous_body).await
            }
            #[cfg(test)]
            Checker::Fake(check) => Ok(check(section).map(|section| (section, vec![]))),
            #[cfg(test)]
            Checker::Advising(check) => Ok(check(section)),
        }
    }
}

pub(super) fn problem(code: &str, path: impl Into<String>, reason: impl Into<String>, guide: &str) -> Value {
    json!({"code":code,"path":path.into(),"reason":reason.into(),"guide":format!("brief_guide {guide}")})
}

/// A rejection the Agent can fix, in result_publish's form. Nothing was
/// changed and no receipt was given. Past MAX_PROBLEMS, `moreProblems` says
/// how many were left out (T-176).
pub(super) fn rejection(mut problems: Vec<Value>, latest: Option<Value>) -> Value {
    let more = problems.len().saturating_sub(MAX_PROBLEMS);
    problems.truncate(MAX_PROBLEMS);
    let mut codes: Vec<String> = vec![];
    for code in problems.iter().filter_map(|p| p["code"].as_str()) {
        if !codes.iter().any(|known| known == code) {
            codes.push(code.into());
        }
    }
    let mut answer = json!({"accepted":false,
        "error":format!("brief_rejected: {}. Nothing was changed and this call does not count as the Turn's Brief update; \
            fix the problems and call brief_update again with a new requestId", codes.join(", ")),
        "problems":problems});
    if more > 0 {
        answer["moreProblems"] = json!(more);
    }
    if let Some(latest) = latest {
        answer["latest"] = latest;
    }
    answer
}

/// A `validateOnly` answer (T-176): the pre-check, every check brief_update
/// makes before its write, with nothing written or reserved. A rejection's
/// problems, `moreProblems` and `latest` are kept as the update would give
/// them for those checks. `valid` says the pre-check passed; `checkedAll`
/// only that it ran all its steps. Checking stops at the first step with
/// problems, so false means later steps did not run and the problems listed
/// may not be all; it says nothing of how many more there are. What only the
/// write checks is outside it: the write checks version, Turn and
/// permissions again and can still refuse, e.g. with snapshot_limit for the
/// Brief's snapshot total. Advice comes only with a valid answer.
fn preview(rejected: Option<Value>, checked_all: bool, advice: Vec<Value>) -> Value {
    let Some(mut rejected) = rejected else {
        return json!({"validateOnly":true,"valid":true,"checkedAll":true,"problems":[],"advice":advice,
            "note":"validateOnly: the pre-check passed against the Brief as it is now. Nothing was written or reserved, and \
                this is not the Turn's Brief update. Sending it checks version, Turn and permissions again, and checks made \
                only on writing, such as the Brief's snapshot total, can still refuse it."});
    };
    let note = if checked_all {
        "validateOnly: nothing was written. The pre-check ran all its steps; checks made only on writing did not run."
    } else {
        "validateOnly: nothing was written. The pre-check stopped at the first step with problems: later steps did not \
            run and this list may be incomplete. Fix these and check again."
    };
    let answer = rejected.as_object_mut().expect("a rejection is an object");
    answer.remove("accepted");
    answer.remove("error");
    answer.insert("validateOnly".into(), json!(true));
    answer.insert("valid".into(), json!(false));
    answer.insert("checkedAll".into(), json!(checked_all));
    answer.insert("note".into(), json!(note));
    rejected
}

/// The validator's advice on change `index` (T-176), added to `advice`
/// once each and at most MAX_ADVICE in all. A block edit is advised only
/// on the blocks it replaced, never again on the rest of the section.
fn advise(change: &Change, index: usize, found: Vec<Value>, advice: &mut Vec<Value>) {
    for mut one in found.into_iter().filter(Value::is_object) {
        let path = one["path"].as_str().unwrap_or_default().to_owned();
        if change.op == Op::Edit && !edited_block(change, &path) {
            continue;
        }
        one["path"] = json!(change_path(change, index, &path));
        if advice.len() < MAX_ADVICE && !advice.iter().any(|known| known["code"] == one["code"] && known["path"] == one["path"]) {
            advice.push(one);
        }
    }
}

/// Whether `path` (body.elements.<id>…) is in a block the edit replaced.
fn edited_block(change: &Change, path: &str) -> bool {
    let Some(rest) = path.strip_prefix("body.elements.") else { return false };
    let id = rest.split('.').next().unwrap_or_default();
    change.edit["elements"].as_object().is_some_and(|elements| elements.contains_key(id))
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum Op {
    Put,
    /// Replaces blocks of an existing section by element id; see `edited`.
    Edit,
    Resolve,
    Remove,
    Claim,
}

pub(super) struct Change {
    pub op: Op,
    pub key: String,
    /// put only.
    pub kind: String,
    /// put: the envelope without its op, as the validator checks it. edit:
    /// the stored section with the edited blocks in place, built by `start`
    /// from the row the edit reads, and checked the same way.
    pub section: Value,
    /// edit only: {elements, status?} as sent.
    pub edit: Value,
    /// Stored body for an edit's legacy unused-attachment compatibility.
    /// Set by start, never accepted from the Agent's request.
    pub previous_body: Option<Value>,
}

pub(super) struct Request {
    pub project: Option<String>,
    pub expected: i64,
    pub no_change: bool,
    pub changes: Vec<Change>,
    /// validateOnly: checked as an update is, nothing written (T-176).
    pub validate_only: bool,
    /// The validator's advice on the checked sections, set once they pass;
    /// an accepted answer carries it.
    pub advice: Vec<Value>,
}

/// Whether `input` asks only to be checked (validateOnly: true).
fn validate_only(input: &Value) -> bool {
    input.get("validateOnly") == Some(&Value::Bool(true))
}

pub(super) fn valid_key(key: &str) -> bool {
    let parts: Vec<&str> = key.split('/').collect();
    parts.len() <= 2
        && parts.iter().all(|part| {
            let bytes = part.as_bytes();
            !bytes.is_empty()
                && bytes.len() <= 48
                && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
                && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        })
}

pub(super) fn topic(key: &str) -> &str {
    key.split('/').next().unwrap_or(key)
}

pub(super) fn valid_attachment_name(name: &str) -> bool {
    (1..=80).contains(&name.len())
        && name != "."
        && name != ".."
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

fn parse(input: &Value) -> Result<Request, Vec<Value>> {
    let mut problems = vec![];
    let object = input.as_object().cloned().unwrap_or_default();
    for key in object.keys() {
        if !matches!(key.as_str(), "requestId" | "projectId" | "expectedVersion" | "changes" | "noChange" | "validateOnly") {
            problems.push(problem("invalid_input", key.as_str(), format!("Unknown argument {key}."), "sections"));
        }
    }
    let project = match input.get("projectId") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if !id.is_empty() && id.len() <= 200 => Some(id.clone()),
        _ => {
            problems.push(problem("invalid_input", "projectId", "projectId is a Project ID from projects_list.", "sections"));
            None
        }
    };
    let expected = input["expectedVersion"].as_i64().filter(|version| *version >= 0);
    if expected.is_none() {
        problems.push(problem("invalid_input", "expectedVersion",
            "expectedVersion is required: the version brief_get returned.", "sections"));
    }
    let no_change = match input.get("noChange") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        _ => {
            problems.push(problem("invalid_input", "noChange", "noChange is true or false.", "sections"));
            false
        }
    };
    if !matches!(input.get("validateOnly"), None | Some(Value::Null) | Some(Value::Bool(_))) {
        problems.push(problem("invalid_input", "validateOnly", "validateOnly is true or false.", "sections"));
    }
    let listed = match input.get("changes") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(changes)) => changes.clone(),
        _ => {
            problems.push(problem("invalid_input", "changes", "changes is a list of changes.", "sections"));
            vec![]
        }
    };
    if no_change && !listed.is_empty() {
        problems.push(problem("invalid_input", "noChange",
            "noChange:true takes no changes; send either changes or noChange:true.", "sections"));
    }
    if !no_change && listed.is_empty() {
        problems.push(problem("empty_update", "changes",
            "Send at least one change, or noChange:true when nothing of yours changed in this Turn.", "sections"));
    }
    if listed.len() > MAX_CHANGES {
        problems.push(problem("invalid_input", "changes", format!("At most {MAX_CHANGES} changes per update."), "limits"));
    }
    let mut changes = vec![];
    let mut keys = BTreeMap::new();
    for (index, change) in listed.iter().take(MAX_CHANGES).enumerate() {
        if let Some(change) = parse_change(index, change, &mut problems) {
            if let Some(first) = keys.insert(change.key.clone(), change.op) {
                let reason = if first == Op::Claim || change.op == Op::Claim {
                    format!("{} is claimed and changed in one update: send the claim alone, then change the section in a second brief_update.", change.key)
                } else {
                    format!("{} is changed twice in this update; send one change per key.", change.key)
                };
                problems.push(problem("duplicate_key", format!("changes[{index}].key"), reason, "sections"));
            }
            changes.push(change);
        }
    }
    match expected {
        Some(expected) if problems.is_empty() => Ok(Request { project, expected, no_change, changes, validate_only: validate_only(input), advice: vec![] }),
        _ => Err(problems),
    }
}

fn parse_change(index: usize, change: &Value, problems: &mut Vec<Value>) -> Option<Change> {
    let at = format!("changes[{index}]");
    let Some(object) = change.as_object() else {
        problems.push(problem("invalid_change", at, "Each change is an object with op and key.", "sections"));
        return None;
    };
    let op = match object.get("op").and_then(Value::as_str) {
        Some("put") => Op::Put,
        Some("edit") => Op::Edit,
        Some("resolve") => Op::Resolve,
        Some("remove") => Op::Remove,
        Some("claim") => Op::Claim,
        _ => {
            problems.push(problem("invalid_change", format!("{at}.op"), "op is one of put, edit, resolve, remove or claim.", "sections"));
            return None;
        }
    };
    let Some(key) = object.get("key").and_then(Value::as_str).filter(|key| valid_key(key)) else {
        problems.push(problem("invalid_key", format!("{at}.key"),
            "key is topic or topic/sub: each part 1-48 of a-z, 0-9 and -, starting with a letter or digit, e.g. round-12/review.",
            "sections"));
        return None;
    };
    if op == Op::Edit {
        if let Some(extra) = object.keys().find(|field| !matches!(field.as_str(), "op" | "key" | "elements" | "status")) {
            problems.push(problem("invalid_change", format!("{at}.{extra}"),
                "edit takes op, key, elements and, for a status section, status; put the section to change anything else.", "sections"));
            return None;
        }
        let elements = object.get("elements").and_then(Value::as_object).filter(|blocks| !blocks.is_empty());
        let Some(elements) = elements.filter(|blocks| blocks.len() <= MAX_EDITED) else {
            problems.push(problem("invalid_change", format!("{at}.elements"),
                format!("elements maps 1-{MAX_EDITED} block ids to their new {{type, props, children?}}."), "sections"));
            return None;
        };
        if let Some((id, _)) = elements.iter().find(|(_, block)| !block.is_object()) {
            problems.push(problem("invalid_change", format!("{at}.elements.{id}"), "Each block is {type, props, children?}.", "content"));
            return None;
        }
        let edit = json!({"elements":elements,"status":object.get("status").cloned().unwrap_or(Value::Null)});
        return Some(Change { op, key: key.into(), kind: String::new(), section: Value::Null, edit, previous_body: None });
    }
    if op != Op::Put {
        if let Some(extra) = object.keys().find(|field| !matches!(field.as_str(), "op" | "key")) {
            problems.push(problem("invalid_change", format!("{at}.{extra}"), "resolve, remove and claim take only op and key.", "sections"));
            return None;
        }
        return Some(Change { op, key: key.into(), kind: String::new(), section: Value::Null, edit: Value::Null, previous_body: None });
    }
    let kind = object.get("kind").and_then(Value::as_str).filter(|kind| matches!(*kind, "ask" | "report" | "status"));
    let Some(kind) = kind else {
        problems.push(problem("invalid_change", format!("{at}.kind"), "kind is ask, report or status.", "sections"));
        return None;
    };
    // Core's own limits and what it relies on in names; the validator
    // checks the rest of the attachment entries.
    let attachments = object.get("attachments").and_then(Value::as_array).cloned().unwrap_or_default();
    if attachments.len() > MAX_ATTACHMENTS {
        problems.push(problem("attachment_limit", format!("{at}.attachments"),
            format!("A section has at most {MAX_ATTACHMENTS} attachments; this one has {}.", attachments.len()), "attachments"));
        return None;
    }
    for (number, attachment) in attachments.iter().enumerate() {
        if !attachment["name"].as_str().is_some_and(valid_attachment_name) {
            problems.push(problem("attachment_name", format!("{at}.attachments[{number}].name"),
                "An attachment name is 1-80 letters, digits, _, . or - (not . or ..).", "attachments"));
            return None;
        }
    }
    let mut section = Value::Object(object.clone());
    section.as_object_mut().unwrap().remove("op");
    Some(Change { op, key: key.into(), kind: kind.into(), section, edit: Value::Null, previous_body: None })
}

pub(super) struct Caller {
    pub agent: String,
    pub agent_name: String,
    pub remote: bool,
    pub project: String,
    pub turn: Pinned,
}

/// Who writes to which Brief, and in which Turn. Err is a plain failure;
/// Ok(Err) the problems the Agent is told.
fn context(store: &Store, db: &Connection, actor: &str, requested: Option<&str>) -> Result<Result<Caller, Vec<Value>>> {
    let brief = store.brief_in(db, actor)?.context("agent_not_found: calling Agent does not exist")?;
    ensure!(brief.agent.closed_at.is_none(), "agent_closed: calling Agent is closed");
    let own = crate::projects::agent_project(db, actor)?;
    let refuse = |code: &str, reason: &str| -> Result<Result<Caller, Vec<Value>>> {
        Ok(Err(vec![problem(code, "projectId", reason, "sections")]))
    };
    let Some(project) = requested.map(str::to_owned).or(own.clone()) else {
        return refuse("not_in_project", "You belong to no Project, so you keep no Brief and need no brief_update.");
    };
    let labels = crate::projects::project_labels(db)?;
    let Some((_, archived)) = labels.get(&project) else {
        return refuse("not_in_project", "No Project has this ID.");
    };
    if own.as_deref() != Some(project.as_str()) {
        // An owner moved out of the Project keeps none of its sections there.
        let owned: i64 = db.query_row(
            "SELECT COUNT(*) FROM project_brief_sections WHERE project_id=?1 AND live=1 AND owner_id=?2",
            params![project, actor],
            |r| r.get(0),
        )?;
        if owned > 0 {
            return refuse("not_owner",
                "You left this Project, so you no longer own its sections; its Agents can claim them. Write to your own Project's Brief.");
        }
        return refuse("not_in_project", "You can only change the Brief of your own Project; omit projectId.");
    }
    if *archived {
        return refuse("project_archived", "Your Project is archived; its Brief no longer changes.");
    }
    let Some(turn) = reliable_turn(store, db, actor)? else {
        return Ok(Err(vec![problem("no_active_turn", "",
            "Core has no confirmed running Turn for you, so an update cannot be bound to one. Nothing was changed.",
            "errors")]));
    };
    Ok(Ok(Caller {
        agent: actor.into(),
        agent_name: brief.agent.name,
        remote: brief.agent.remote.is_some(),
        project,
        turn,
    }))
}

/// The live Brief, as a version conflict returns it.
fn latest(store: &Store, db: &Connection, project: &str) -> Result<Value> {
    let rows = sections::live(db, project)?;
    let seen = sections::seen(db, project)?;
    let mut owners = Owners::default();
    let mut refs = super::refs::Refs::new(store, db);
    let at = chrono::Utc::now();
    let mut listed = vec![];
    for row in &rows {
        let owner = owners.get(store, db, row)?;
        listed.push(sections::section_json(row, &owner, seen.get(&row.key), refs.of(&row.data["body"]), at));
    }
    Ok(json!({"version":sections::brief_version(db, project)?,"sections":listed}))
}

/// Whether the update was based on a version too old for what it changes
/// (T-9): a section it changes was written after `expectedVersion`. Other
/// sections' writes don't make it stale, and a noChange changes none. A
/// version the Brief never had yet is always refused, and where Core's
/// record of writes can't tell (writes.rs), the whole Brief must be as read.
fn conflict(store: &Store, db: &Connection, ctx: &Caller, request: &Request) -> Result<Option<Value>> {
    let (current, expected) = (sections::brief_version(db, &ctx.project)?, request.expected);
    if current == expected || (expected < current && request.no_change) {
        return Ok(None);
    }
    let whole = || vec![problem("version_conflict", "expectedVersion",
        format!("The Brief is at version {current}, not {expected}: it changed since you read it. \
            latest holds it now; merge your changes into it and send them with expectedVersion {current}."),
        "errors")];
    let problems = if expected > current {
        whole()
    } else {
        let keys: Vec<&str> = request.changes.iter().map(|change| change.key.as_str()).collect();
        match writes::stale(db, &ctx.project, current, expected, &keys)? {
            None => whole(),
            Some(stale) if stale.is_empty() => return Ok(None),
            Some(stale) => stale.into_iter().map(|(index, written)| {
                let key = keys[index];
                let changed = match written {
                    Some(version) => format!("{key} was written at Brief version {version}, after version {expected} that you read."),
                    None => format!("Core's record of {key}'s writes doesn't go back to version {expected} that you read, so it may have changed since."),
                };
                problem("version_conflict", format!("changes[{index}].key"),
                    format!("{changed} latest holds the Brief now; merge your change into that section and send it with expectedVersion {current}."),
                    "errors")
            }).collect(),
        }
    };
    Ok(Some(rejection(problems, Some(latest(store, db, &ctx.project)?))))
}

/// How an owner left, as rejections say it.
fn departed(state: &str) -> &'static str {
    match state {
        "closed" => "was closed",
        "deleted" => "was deleted",
        _ => "left this Project",
    }
}

#[derive(Clone)]
struct Planned {
    owner: String,
    open_ask: bool,
}

/// The owner, sub-topic, claim and per-Brief limit rules, applied to the
/// changes in order over the live Brief.
fn rules(store: &Store, db: &Connection, ctx: &Caller, request: &Request) -> Result<Vec<Value>> {
    // Runs before validation AND inside commit's write transaction, so a
    // revocation during validation cannot authorize a stale write.
    let can_edit = editors::can_edit(store, db, &ctx.project, &ctx.agent)?;
    let live = sections::live(db, &ctx.project)?;
    let mut planned: BTreeMap<String, Planned> = live
        .iter()
        .map(|row| (row.key.clone(), Planned { owner: row.owner_id.clone(), open_ask: row.unresolved_ask() }))
        .collect();
    let rows: BTreeMap<&str, &Row> = live.iter().map(|row| (row.key.as_str(), row)).collect();
    let mut owners = Owners::default();
    let mut problems = vec![];
    let open_asks = |planned: &BTreeMap<String, Planned>| {
        planned.values().filter(|p| p.owner == ctx.agent && p.open_ask).count()
    };
    let ask_limit = |at: &str| problem("ask_limit", at,
        format!("You already have {MAX_OPEN_ASKS} unresolved asks; resolve one before asking more."), "ask");
    for (index, change) in request.changes.iter().enumerate() {
        let at = format!("changes[{index}]");
        let key = change.key.as_str();
        let existing = planned.get(key).cloned();
        if !can_edit {
            let own_ask = rows.get(key).is_some_and(|row| row.owner_id == ctx.agent && row.kind == "ask");
            let permitted = match change.op {
                Op::Put => change.kind == "ask" && (existing.is_none() || own_ask),
                // An edit keeps the stored kind: an Ask-only member edits
                // only its own ask, never a report or status it wrote before.
                Op::Resolve | Op::Remove | Op::Edit => own_ask,
                Op::Claim => false,
            };
            if !permitted {
                problems.push(problem("ask_only", format!("{at}.op"),
                    "You are Ask-only in this Project. You may submit and update your own valid asks, resolve them, or send noChange:true. Only the user can select Home content editors. Keep internal progress in tasks and mail; no per-turn Brief update is required.", "sections"));
                continue;
            }
        }
        // Another Agent's section, as it is now (each key is changed once).
        let other = match (&existing, rows.get(key)) {
            (Some(p), Some(row)) if p.owner != ctx.agent => Some(owners.get(store, db, row)?),
            _ => None,
        };
        let orphaned = other.as_ref().filter(|owner| owner.orphaned()).map(|owner| owner.state);
        let not_owner = |_: &Planned| {
            let reason = match &other {
                Some(owner) if owner.orphaned() => format!(
                    "{key} belongs to {}, whose Agent {}. Claim it first with {{op:\"claim\", key:\"{key}\"}}.",
                    owner.name, departed(owner.state)
                ),
                owner => format!(
                    "{key} is {}'s section; only its owner changes it. Add to it with a sub-topic of your own, e.g. {}/your-part.",
                    owner.as_ref().map_or("another Agent", |owner| owner.name.as_str()), topic(key)
                ),
            };
            problem("not_owner", format!("{at}.key"), reason, "sections")
        };
        let missing = || problem("not_found", format!("{at}.key"), format!("No live section has key {key}."), "sections");
        match change.op {
            Op::Put => {
                match &existing {
                    Some(p) if p.owner != ctx.agent => {
                        problems.push(not_owner(p));
                        continue;
                    }
                    Some(p) if p.open_ask && change.kind != "ask" => {
                        problems.push(problem("ask_unresolved", format!("{at}.kind"),
                            format!("{key} is an unresolved ask; resolve it before putting another kind under this key."), "ask"));
                        continue;
                    }
                    Some(_) => {}
                    None => {
                        let top = topic(key);
                        let topics: BTreeSet<&str> = planned.keys().map(|k| topic(k)).collect();
                        if !topics.contains(top) && topics.len() >= MAX_TOPICS {
                            problems.push(problem("topic_limit", format!("{at}.key"),
                                format!("The Brief already has {MAX_TOPICS} topics; put this under an existing topic, or remove one."), "limits"));
                            continue;
                        }
                        let prefix = format!("{top}/");
                        if key.contains('/') && planned.keys().filter(|k| k.starts_with(&prefix)).count() >= MAX_SUBTOPICS {
                            problems.push(problem("topic_limit", format!("{at}.key"),
                                format!("{top} already has {MAX_SUBTOPICS} sub-topics."), "limits"));
                            continue;
                        }
                    }
                }
                let was_open = existing.as_ref().is_some_and(|p| p.open_ask);
                planned.insert(key.into(), Planned { owner: ctx.agent.clone(), open_ask: change.kind == "ask" });
                if change.kind == "ask" && !was_open && open_asks(&planned) > MAX_OPEN_ASKS {
                    problems.push(ask_limit(&format!("{at}.kind")));
                }
            }
            // Changes no owner, kind or ask state; the blocks are `edited`'s.
            Op::Edit => match &existing {
                None => problems.push(problem("not_found", format!("{at}.key"),
                    format!("No live section has key {key}; create it with put."), "sections")),
                Some(p) if p.owner != ctx.agent => problems.push(not_owner(p)),
                Some(_) => {}
            },
            Op::Resolve => match &existing {
                None => problems.push(missing()),
                Some(p) if p.owner != ctx.agent => problems.push(not_owner(p)),
                Some(p) if !p.open_ask => problems.push(problem("not_ask", format!("{at}.key"),
                    format!("{key} is not an unresolved ask; remove a report or status instead."), "sections")),
                Some(_) => {
                    planned.remove(key);
                }
            },
            Op::Remove => match &existing {
                None => problems.push(missing()),
                Some(p) if p.owner != ctx.agent => problems.push(not_owner(p)),
                Some(p) if p.open_ask => problems.push(problem("ask_unresolved", format!("{at}.op"),
                    format!("{key} is an unresolved ask; it leaves the Brief when you resolve it."), "ask")),
                Some(_) => {
                    planned.remove(key);
                }
            },
            Op::Claim => match &existing {
                None => problems.push(missing()),
                Some(p) if p.owner == ctx.agent => problems.push(problem("not_orphan", format!("{at}.key"),
                    format!("{key} is already yours."), "sections")),
                Some(_) if orphaned.is_none() => problems.push(problem("not_orphan", format!("{at}.key"),
                    format!("{key} has an active owner; only a section whose owner was closed, deleted or left the Project can be claimed."), "sections")),
                Some(p) => {
                    let open = p.open_ask;
                    planned.insert(key.into(), Planned { owner: ctx.agent.clone(), ..p.clone() });
                    if open && open_asks(&planned) > MAX_OPEN_ASKS {
                        problems.push(ask_limit(&format!("{at}.key")));
                    }
                }
            },
        }
    }
    Ok(problems)
}

enum Start {
    Replay(Value),
    Reject(Value),
    /// The request, whether its Agent runs on another machine, and the
    /// Turn it was made in.
    Check(Request, bool, Pinned),
}

/// The first accepted answer to this requestId, replayed exactly. Only
/// accepted updates are kept: a rejection changed nothing, so the same call
/// is simply checked again.
fn replay(db: &Connection, actor: &str, id: &str, input: &Value) -> Result<Option<Value>> {
    let previous: Option<(String, String)> = db
        .query_row(
            "SELECT input_json,response_json FROM collaboration_requests WHERE actor=?1 AND operation=?2 AND request_id=?3",
            params![format!("agent:{actor}"), TOOL, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((payload, response)) = previous else { return Ok(None) };
    ensure!(
        serde_json::from_str::<Value>(&payload)? == *input,
        "idempotency_conflict: requestId already has a different payload"
    );
    Ok(Some(serde_json::from_str(&response)?))
}

/// Everything up to the validator, on a reader.
fn start(store: &Store, actor: &str, id: &str, input: &Value) -> Result<Start> {
    let db = store.db.read()?;
    // A check only is answered afresh: its requestId is neither replayed nor kept.
    if !validate_only(input) {
        if let Some(answer) = replay(&db, actor, id, input)? {
            return Ok(Start::Replay(answer));
        }
    }
    let request = match parse(input) {
        Ok(request) => request,
        Err(problems) => return Ok(Start::Reject(rejection(problems, None))),
    };
    let ctx = match context(store, &db, actor, request.project.as_deref())? {
        Ok(ctx) => ctx,
        Err(problems) => return Ok(Start::Reject(rejection(problems, None))),
    };
    if let Some(rejected) = conflict(store, &db, &ctx, &request)? {
        return Ok(Start::Reject(rejected));
    }
    let problems = rules(store, &db, &ctx, &request)?;
    if !problems.is_empty() {
        return Ok(Start::Reject(rejection(problems, None)));
    }
    let mut request = request;
    let mut problems = vec![];
    for (index, change) in request.changes.iter_mut().enumerate() {
        if change.op != Op::Edit {
            continue;
        }
        // rules found it live and the caller's. The commit only goes ahead
        // while no write to this key came after expectedVersion (conflict),
        // so this row is the one it changes.
        let row = sections::live_key(&db, &ctx.project, &change.key)?.context("the section changed while it was being read")?;
        match edited(&row, &change.edit, index) {
            Ok(section) => {
                change.section = section;
                change.previous_body = Some(row.data["body"].clone());
            }
            Err(found) => problems.extend(found),
        }
    }
    if !problems.is_empty() {
        return Ok(Start::Reject(rejection(problems, None)));
    }
    Ok(Start::Check(request, ctx.remote, ctx.turn))
}

#[cfg(test)]
#[test]
fn revoked_during_validation_cannot_commit_or_leave_a_receipt() {
    let (_dir, ws, project) = super::tests::lab();
    let input = json!({"requestId":"race","expectedVersion":0,"changes":[{
        "op":"put","key":"race","kind":"report","title":"Validated result",
        "body":{"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":[]}}}}]});
    let Start::Check(request, _, turn) = start(&ws.store, "a", "race", &input).unwrap() else { panic!("initially permitted") };
    // This is the lock-free validator/attachment-staging interval. Policy
    // versions are separate from Brief versions, so only the commit rules
    // (not the ordinary optimistic Brief check) can reject this write.
    editors::save(&ws.store, &project, 0, Some(vec![])).unwrap();
    let (answer, changed) = commit(&ws.store, "a", "race", &input, &turn, &request, &[request.changes[0].section.clone()], &[vec![]]).unwrap();
    assert_eq!(answer.unwrap_err()["problems"][0]["code"], "ask_only");
    assert!(changed.is_none());
    assert_eq!(sections::brief_version(&ws.store.db.read().unwrap(), &project).unwrap(), 0);
    assert_eq!(turn_receipt(&ws.store, "a", "t1").unwrap(), None);
    assert!(replay(&ws.store.db.read().unwrap(), "a", "race", &input).unwrap().is_none());
}

#[cfg(test)]
#[test]
fn an_edit_revoked_during_validation_cannot_commit() {
    let (_dir, ws, project) = super::tests::lab();
    let body = |text: &str| json!({"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["note"]},
        "note":{"type":"Markdown","props":{"text":text}}}});
    let put = json!({"requestId":"put","expectedVersion":0,"changes":[{"op":"put","key":"plan","kind":"report","title":"Plan","body":body("First.")}]});
    let Start::Check(request, _, turn) = start(&ws.store, "a", "put", &put).unwrap() else { panic!("a may write") };
    let (answer, _) = commit(&ws.store, "a", "put", &put, &turn, &request, &[request.changes[0].section.clone()], &[vec![]]).unwrap();
    assert!(answer.is_ok(), "{answer:?}");
    let edit = json!({"requestId":"edit","expectedVersion":1,"changes":[{"op":"edit","key":"plan",
        "elements":{"note":{"type":"Markdown","props":{"text":"Second."}}}}]});
    let Start::Check(request, _, turn) = start(&ws.store, "a", "edit", &edit).unwrap() else { panic!("initially permitted") };
    // Revoked while the edited section is checked: the write's own rules refuse it.
    editors::save(&ws.store, &project, 0, Some(vec![])).unwrap();
    let (answer, changed) = commit(&ws.store, "a", "edit", &edit, &turn, &request, &[request.changes[0].section.clone()], &[vec![]]).unwrap();
    assert_eq!(answer.unwrap_err()["problems"][0]["code"], "ask_only");
    assert!(changed.is_none());
    let db = ws.store.db.read().unwrap();
    assert_eq!(sections::brief_version(&db, &project).unwrap(), 1);
    assert_eq!(sections::live_key(&db, &project, "plan").unwrap().unwrap().data["body"], body("First."));
    assert!(replay(&db, "a", "edit", &edit).unwrap().is_none());
}

#[cfg(test)]
#[test]
fn an_edit_checked_before_its_section_is_written_again_cannot_commit_but_another_sections_write_does_not_stop_it() {
    let (_dir, ws, project) = super::tests::lab();
    let body = |text: &str| json!({"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["note"]},
        "note":{"type":"Markdown","props":{"text":text}}}});
    let put = |id: &str, version: i64, key: &str, text: &str| json!({"requestId":id,"expectedVersion":version,
        "changes":[{"op":"put","key":key,"kind":"report","title":"Plan","body":body(text)}]});
    let edit = |id: &str, version: i64, text: &str| json!({"requestId":id,"expectedVersion":version,
        "changes":[{"op":"edit","key":"plan","elements":{"note":{"type":"Markdown","props":{"text":text}}}}]});
    let check = |actor: &str, id: &str, input: &Value| {
        let Start::Check(request, _, turn) = start(&ws.store, actor, id, input).unwrap() else { panic!("{id} passes the check") };
        (request, turn)
    };
    let write = |actor: &str, id: &str, input: &Value, (request, turn): (Request, Pinned)| {
        let normalized: Vec<Value> = request.changes.iter().map(|change| change.section.clone()).collect();
        commit(&ws.store, actor, id, input, &turn, &request, &normalized, &[vec![]]).unwrap()
    };
    let stored = || sections::live_key(&ws.store.db.read().unwrap(), &project, "plan").unwrap().unwrap().data["body"].clone();
    let first = put("p1", 0, "plan", "First.");
    assert!(write("a", "p1", &first, check("a", "p1", &first)).0.is_ok());

    // Checked at 1, composed from "First."; plan is written again before the commit.
    let late = edit("e1", 1, "Edited.");
    let checked = check("a", "e1", &late);
    let second = put("p2", 1, "plan", "Second.");
    assert!(write("a", "p2", &second, check("a", "p2", &second)).0.is_ok());
    let (answer, changed) = write("a", "e1", &late, checked);
    let rejected = answer.unwrap_err();
    assert_eq!((rejected["problems"][0]["code"].clone(), rejected["problems"][0]["path"].clone()),
        (json!("version_conflict"), json!("changes[0].key")));
    assert!(changed.is_none());
    assert_eq!(stored(), body("Second."));

    // Checked at 2; another section is written before the commit: it goes through.
    let edit2 = edit("e2", 2, "Edited.");
    let checked = check("a", "e2", &edit2);
    let notes = put("n1", 2, "notes", "Notes.");
    assert!(write("b", "n1", &notes, check("b", "n1", &notes)).0.is_ok());
    let (answer, _) = write("a", "e2", &edit2, checked);
    assert_eq!(answer.unwrap()["version"], 4);
    assert_eq!(stored(), body("Edited."));
}

/// An edit's section: the stored one with the edited blocks in place, in
/// the form a put sends, for the validator to check whole. Everything not
/// edited is as stored; attachments are as sent then, without their
/// snapshots, which the edit keeps (it stages nothing).
fn edited(row: &Row, edit: &Value, index: usize) -> Result<Value, Vec<Value>> {
    let at = format!("changes[{index}].elements");
    let mut body = row.data["body"].clone();
    let root = body["root"].as_str().unwrap_or_default().to_owned();
    let blocks = edit["elements"].as_object().cloned().unwrap_or_default();
    // A new id is only a new child of a block this edit replaces.
    let named: BTreeSet<&str> = blocks.values()
        .flat_map(|block| block["children"].as_array().into_iter().flatten().filter_map(Value::as_str))
        .collect();
    let mut problems = vec![];
    for id in blocks.keys() {
        if *id == root {
            problems.push(problem("edit_root", format!("{at}.{id}"),
                format!("\"{id}\" is the section's root; edit the blocks under it, or put the section to rearrange it."), "sections"));
        } else if body["elements"].get(id).is_none() && !named.contains(id.as_str()) {
            problems.push(problem("unknown_element", format!("{at}.{id}"),
                format!("{} has no block \"{id}\". Edit a block it has (brief_get shows them), name a new one as a child of a block you edit, or put the section.", row.key),
                "sections"));
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    for (id, block) in blocks {
        body["elements"][id] = block;
    }
    let data = &row.data;
    let mut section = json!({"key":row.key,"kind":row.kind,"title":data["title"],"body":body});
    for name in ["ask", "status", "time"] {
        if !data[name].is_null() {
            section[name] = data[name].clone();
        }
    }
    if !edit["status"].is_null() {
        section["status"] = edit["status"].clone();
    }
    let attachments: Vec<Value> = data["attachments"].as_array().into_iter().flatten().map(|entry| {
        let mut sent = json!({"name":entry["name"]});
        for field in ["caption", "path", "url"] {
            if !entry[field].is_null() {
                sent[field] = entry[field].clone();
            }
        }
        sent
    }).collect();
    if !attachments.is_empty() {
        section["attachments"] = json!(attachments);
    }
    Ok(section)
}

/// Where a validator problem is in the change: an edit sends blocks, not a
/// body, so body.elements.<id> is reported as elements.<id>.
fn change_path(change: &Change, index: usize, path: &str) -> String {
    let path = match change.op {
        Op::Edit if path == "body" || path == "body.elements" => "elements".to_owned(),
        Op::Edit => path.strip_prefix("body.").unwrap_or(path).to_owned(),
        _ => path.to_owned(),
    };
    if path.is_empty() { format!("changes[{index}]") } else { format!("changes[{index}].{path}") }
}

pub(super) async fn update(ws: &Arc<Workspace>, checker: &Checker, actor: &str, input: Value) -> Result<Result<Value, Value>> {
    let only = validate_only(&input);
    let id = match input["requestId"].as_str().filter(|id| !id.trim().is_empty() && id.len() <= 128) {
        Some(id) => id.to_owned(),
        None if only => String::new(),
        None => bail!("invalid_input: requestId must be a string of 1-128 bytes"),
    };
    let (store, who, payload, key) = (ws.store.clone(), actor.to_owned(), input.clone(), id.clone());
    let (mut request, remote, turn) = match crate::db::blocking(move || start(&store, &who, &key, &payload)).await? {
        Start::Replay(answer) => return Ok(Ok(answer)),
        Start::Reject(rejected) if only => return Ok(Ok(preview(Some(rejected), false, vec![]))),
        Start::Reject(rejected) => return Ok(Err(rejected)),
        Start::Check(request, remote, turn) => (request, remote, turn),
    };
    // Each section put, checked outside any database lock.
    let mut normalized = Vec::with_capacity(request.changes.len());
    let (mut problems, mut advice) = (vec![], vec![]);
    for (index, change) in request.changes.iter().enumerate() {
        if !matches!(change.op, Op::Put | Op::Edit) {
            normalized.push(Value::Null);
            continue;
        }
        let checked = checker.check(&change.section, change.previous_body.as_ref()).await.map_err(|reason| {
            anyhow::anyhow!("validator_unavailable: {reason}. Not counted against you; try again later")
        })?;
        match checked {
            Ok((section, found)) => {
                advise(change, index, found, &mut advice);
                normalized.push(section);
            }
            Err(found) => {
                for mut found in found.as_array().cloned().unwrap_or_default() {
                    found["path"] = json!(change_path(change, index, found["path"].as_str().unwrap_or_default()));
                    problems.push(found);
                }
                normalized.push(Value::Null);
            }
        }
    }
    if !problems.is_empty() {
        let rejected = rejection(problems, None);
        return Ok(if request.validate_only { Ok(preview(Some(rejected), false, vec![])) } else { Err(rejected) });
    }
    if request.validate_only {
        // The attachments are judged as staging judges them; nothing is copied.
        let sections: Vec<Value> = request.changes.iter()
            .map(|c| if c.op == Op::Put { c.section.clone() } else { Value::Null })
            .collect();
        let (cache, data_dir) = (attachments::dir(&ws.data_dir), ws.data_dir.clone());
        let problems = crate::db::blocking(move || attachments::inspect(&cache, &data_dir, remote, &sections)).await?;
        return Ok(Ok(preview((!problems.is_empty()).then(|| rejection(problems, None)), true, advice)));
    }
    request.advice = advice;
    // Attachment files are copied before the write; one the write then
    // does not keep is collected afterwards.
    let (cache, data_dir) = (attachments::dir(&ws.data_dir), ws.data_dir.clone());
    // An edit keeps the section's snapshots: nothing of it is staged again.
    let section_inputs: Vec<Value> = request.changes.iter()
        .map(|c| if c.op == Op::Put { c.section.clone() } else { Value::Null })
        .collect();
    let (staged, problems, hold) = crate::db::blocking(move || attachments::stage(&cache, &data_dir, remote, &section_inputs)).await?;
    if !problems.is_empty() {
        drop(hold);
        collect(ws).await;
        return Ok(Err(rejection(problems, None)));
    }
    let (store, who) = (ws.store.clone(), actor.to_owned());
    let answer = crate::db::blocking(move || commit(&store, &who, &id, &input, &turn, &request, &normalized, &staged)).await;
    drop(hold);
    collect(ws).await;
    let (answer, project) = answer?;
    if let (Ok(_), Some(project)) = (&answer, project) {
        announce(ws, Some(&project));
    }
    Ok(answer)
}

/// Unreferenced snapshot files go after every write that may have left some.
async fn collect(ws: &Arc<Workspace>) {
    let (store, cache) = (ws.store.clone(), attachments::dir(&ws.data_dir));
    if let Err(error) = crate::db::blocking(move || attachments::collect_garbage(&store, &cache)).await {
        eprintln!("Brief snapshots not collected: {error:#}");
    }
}

/// The write: every rule again, on the state it changes. Ok((answer,
/// Some(project))) when the Brief changed.
#[allow(clippy::type_complexity, clippy::too_many_arguments)]
fn commit(
    store: &Store,
    actor: &str,
    id: &str,
    input: &Value,
    turn: &Pinned,
    request: &Request,
    normalized: &[Value],
    staged: &[Vec<attachments::Staged>],
) -> Result<(Result<Value, Value>, Option<String>)> {
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    // The same requestId may have finished meanwhile.
    if let Some(answer) = replay(&tx, actor, id, input)? {
        return Ok((Ok(answer), None));
    }
    let ctx = match context(store, &tx, actor, request.project.as_deref())? {
        Ok(ctx) => ctx,
        Err(problems) => return Ok((Err(rejection(problems, None)), None)),
    };
    // Never moved to another Turn, as with results.
    if ctx.turn != *turn {
        return Ok((Err(rejection(vec![problem("stale_turn", "",
            "Your Turn ended or changed while the update was checked; nothing was changed. Read the Brief again in your current Turn.",
            "errors")], None)), None));
    }
    if let Some(rejected) = conflict(store, &tx, &ctx, request)? {
        return Ok((Err(rejected), None));
    }
    let problems = rules(store, &tx, &ctx, request)?;
    if !problems.is_empty() {
        return Ok((Err(rejection(problems, None)), None));
    }
    sections::expire_history(&tx)?;
    let changed = apply(&tx, &ctx, request, normalized, staged)?;
    if !request.no_change && !attachments::prune(&tx, &ctx.project, SNAPSHOT_BRIEF_BYTES)? {
        // Dropping the transaction undoes the whole update.
        return Ok((Err(rejection(vec![problem("snapshot_limit", "changes",
            format!("This Brief's snapshots would exceed {} MB even without its history. Remove sections with large attachments, \
                or reference large files by a path above 25 MB.", SNAPSHOT_BRIEF_BYTES / 1024 / 1024),
            "attachments")], None)), None));
    }
    let before = sections::brief_version(&tx, &ctx.project)?;
    let version = if request.no_change {
        before
    } else {
        tx.execute(
            "INSERT INTO project_briefs(project_id,version,updated_at) VALUES(?1,1,?2)
             ON CONFLICT(project_id) DO UPDATE SET version=version+1,updated_at=excluded.updated_at",
            params![ctx.project, now()],
        )?;
        let version = sections::brief_version(&tx, &ctx.project)?;
        // The keys `apply` changed: each change writes its own key, and no
        // op changes another section.
        let keys: Vec<&str> = request.changes.iter().map(|change| change.key.as_str()).collect();
        writes::record(&tx, &ctx.project, before, version, &keys)?;
        version
    };
    let receipt = uuid::Uuid::new_v4().to_string();
    let kind = if request.no_change { "noChange" } else { "updated" };
    tx.execute(
        "INSERT INTO project_brief_receipts(id,agent_id,project_id,turn_id,session_id,kind,request_id,version,created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![receipt, actor, ctx.project, ctx.turn.turn, ctx.turn.session(), kind, id, version, now()],
    )?;
    let mut answer = json!({"accepted":true,
        "receipt":{"id":receipt,"agentId":actor,"projectId":ctx.project,"turnId":ctx.turn.turn,"kind":kind},
        "version":version,"sections":changed});
    // Advice never changes what was accepted; a retry gets it again.
    if !request.advice.is_empty() {
        answer["advice"] = json!(request.advice);
    }
    tx.execute(
        "INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,?2,?3,?4,?5)",
        params![format!("agent:{actor}"), TOOL, id, input.to_string(), answer.to_string()],
    )?;
    tx.commit()?;
    // A "no change" changes nothing Home shows.
    Ok((Ok(answer), (!request.no_change).then_some(ctx.project)))
}

/// A put's stored data: the validator's normalized section with the
/// attachments as Core took them.
fn section_data(normalized: &Value, submitted: &Value, staged: &[attachments::Staged]) -> Value {
    let field = |name: &str| {
        normalized.get(name).filter(|value| !value.is_null()).or_else(|| submitted.get(name)).cloned().unwrap_or(Value::Null)
    };
    let mut data = json!({"title":field("title"),"body":field("body"),
        "attachments":staged.iter().map(|s| s.entry.clone()).collect::<Vec<_>>()});
    for name in ["ask", "status", "time"] {
        let value = field(name);
        if !value.is_null() {
            data[name] = value;
        }
    }
    data
}

fn apply(
    tx: &Connection,
    ctx: &Caller,
    request: &Request,
    normalized: &[Value],
    staged: &[Vec<attachments::Staged>],
) -> Result<Vec<Value>> {
    let at = now();
    let mut changed = vec![];
    for (index, change) in request.changes.iter().enumerate() {
        let current = sections::live_key(tx, &ctx.project, &change.key)?;
        let row = || current.as_ref().context("the section changed while it was being written");
        match change.op {
            Op::Put => {
                let data = section_data(&normalized[index], &change.section, &staged[index]);
                // A reply shows as replied until the owner changes the ask
                // (docs/home-v1.md; brief_guide): a new version after a reply
                // is the owner's next question, open for the user again.
                let (state, since, replied_at, reply_text, deferred) = match (change.kind.as_str(), current.as_ref()) {
                    ("ask", Some(row)) if row.unresolved_ask() && row.ask_state.as_deref() == Some("replied") => {
                        (Some("open".into()), Some(at.clone()), None, None, row.deferred_until.clone())
                    }
                    ("ask", Some(row)) if row.unresolved_ask() => (
                        row.ask_state.clone().or(Some("open".into())),
                        row.ask_since.clone().or(Some(at.clone())),
                        row.replied_at.clone(),
                        row.reply_text.clone(),
                        row.deferred_until.clone(),
                    ),
                    ("ask", _) => (Some("open".into()), Some(at.clone()), None, None, None),
                    _ => (None, None, None, None, None),
                };
                let (seq, version) = match &current {
                    Some(row) => {
                        tx.execute(
                            "UPDATE project_brief_sections SET kind=?2,version=?3,owner_name=?4,data=?5,ask_state=?6,ask_since=?7,
                             replied_at=?8,reply_text=?9,deferred_until=?10,updated_at=?11,updated_turn_id=?12 WHERE seq=?1",
                            params![row.seq, change.kind, row.version + 1, ctx.agent_name, data.to_string(), state, since,
                                replied_at, reply_text, deferred, at, ctx.turn.turn],
                        )?;
                        (row.seq, row.version + 1)
                    }
                    None => {
                        // Versions keep rising across history and its expiry
                        // (the key's ending keeps its last version, and the
                        // seen version stays for keys whose history went
                        // before endings existed), so a version the user once
                        // saw never names newer content.
                        let previous: i64 = tx.query_row(
                            "SELECT MAX(COALESCE((SELECT MAX(version) FROM project_brief_sections WHERE project_id=?1 AND key=?2),0),
                             COALESCE((SELECT version FROM project_brief_endings WHERE project_id=?1 AND key=?2),0),
                             COALESCE((SELECT version FROM project_brief_seen WHERE project_id=?1 AND key=?2),0))",
                            params![ctx.project, change.key],
                            |r| r.get(0),
                        )?;
                        // A report the user marked seen leaves the live Brief
                        // until its owner writes it again: that next version
                        // is the same section on Home (a widget pinned to it
                        // follows it). Removed or resolved sections, and a key
                        // written by another Agent, start anew.
                        let lineage = sections::continued_identity(tx, &ctx.project, &change.key, &ctx.agent)?;
                        tx.execute(
                            "INSERT INTO project_brief_sections(project_id,key,live,kind,version,owner_id,owner_name,data,
                             ask_state,ask_since,replied_at,reply_text,deferred_until,updated_at,updated_turn_id,lineage)
                             VALUES(?1,?2,1,?3,?4,?5,?6,?7,?8,?9,NULL,NULL,NULL,?10,?11,?12)",
                            params![ctx.project, change.key, change.kind, previous + 1, ctx.agent, ctx.agent_name,
                                data.to_string(), state, since, at, ctx.turn.turn, lineage],
                        )?;
                        (tx.last_insert_rowid(), previous + 1)
                    }
                };
                attachments::index(tx, seq, &ctx.project, &staged[index])?;
                changed.push(json!({"key":change.key,"version":version}));
            }
            Op::Edit => {
                let row = row()?;
                // Only the blocks (and a status section's status) change:
                // title, time, attachments and the ask's state stay as they
                // are, so an edit never reopens a replied ask.
                let mut data = row.data.clone();
                data["body"] = normalized[index]["body"].clone();
                if !change.edit["status"].is_null() {
                    data["status"] = normalized[index]["status"].clone();
                }
                tx.execute(
                    "UPDATE project_brief_sections SET version=?2,owner_name=?3,data=?4,updated_at=?5,updated_turn_id=?6 WHERE seq=?1",
                    params![row.seq, row.version + 1, ctx.agent_name, data.to_string(), at, ctx.turn.turn],
                )?;
                changed.push(json!({"key":change.key,"version":row.version + 1}));
            }
            Op::Resolve => {
                let row = row()?;
                tx.execute(
                    "UPDATE project_brief_sections SET ask_state='resolved',version=version+1,live=0,history_reason='resolved',
                     history_at=?2,updated_at=?2,updated_turn_id=?3 WHERE seq=?1",
                    params![row.seq, at, ctx.turn.turn],
                )?;
                sections::record_ending(tx, row, row.version + 1, "resolved", &at)?;
                changed.push(json!({"key":change.key,"version":row.version + 1}));
            }
            Op::Remove => {
                let row = row()?;
                tx.execute(
                    "UPDATE project_brief_sections SET live=0,history_reason='removed',history_at=?2 WHERE seq=?1",
                    params![row.seq, at],
                )?;
                sections::record_ending(tx, row, row.version, "removed", &at)?;
                changed.push(json!({"key":change.key,"version":row.version}));
            }
            Op::Claim => {
                let row = row()?;
                // Content and seen state are unchanged; only who owns it.
                tx.execute(
                    "UPDATE project_brief_sections SET owner_id=?2,owner_name=?3 WHERE seq=?1",
                    params![row.seq, ctx.agent, ctx.agent_name],
                )?;
                changed.push(json!({"key":change.key,"version":row.version}));
            }
        }
    }
    Ok(changed)
}
