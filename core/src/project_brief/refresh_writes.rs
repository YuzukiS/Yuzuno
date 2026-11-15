//! What writes Home cards' refreshes (YN-113 design §1.3, §3.3, §3.4, §5,
//! §6.3, §6.4; R2): a lead's `refresh` on brief_update, and the user's own
//! changes from the card and Settings. refresh.rs is the timer that reads them.
//!
//! brief_update: a put or edit of a report may carry `refresh`, as it may
//! carry `task`: left out keeps the card's refresh, null removes it, an object
//! sets it (fields left out keep what the card's refresh has; a new one needs
//! `every` and `instruction`). Only a lead of the Project sets it
//! (`not_project_lead`), only on a report (`refresh_report_only`). Making one,
//! making it run more often (on again after a pause counts) or changing its
//! instruction is taken only in a Turn the user started: the first input of
//! the Turn has a receipt whose origin is a client's composer, a reply from
//! Home or a request from the Project's page (input_origin.rs). A refresh's
//! own Turn, another Agent's mail or an automatic continue may only pause it,
//! make it run less often or remove it (`refresh_needs_user_turn`). The
//! user's limits hold for everyone: every N hours no shorter than the shortest
//! interval (`refresh_too_often`), and no more refreshes on at once than the
//! most allowed (`refresh_limit`); a lower limit stops nothing already on, it
//! only refuses making one or making it faster. Removing a card (`remove`)
//! removes its refresh in the same transaction.
//!
//! Every put of a report that refreshes keeps the version it replaces as
//! history (`refreshed`, update.rs `apply`): its past issues, listed by
//! `versions` and gone with the rest of history after HISTORY_DAYS. They are
//! not among Home's history list (sections::history).
//!
//! The user's routes (http.rs, the same boundary as /brief/seen): change a
//! refresh or turn it off and on, against the version the page read (409 with
//! the refresh as it is now when it changed); remove it; refresh now, once,
//! outside its cadence; read and save the limits. They are not bound by the
//! user-Turn rule: the user makes them.
use super::{
    editors,
    refresh::{self, Cadence, Every, Limits, NowRequest, Refresh, Times},
    sections::{self, Owners},
    update::{problem, Caller, Change, Op},
    *,
};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::Deserialize;

/// At most this many characters of instruction: as a result's Text block
/// (yuzuno_guide results: Text {text≤2000}).
pub(super) const INSTRUCTION_CHARS: usize = 2000;
/// The origins of a Turn the user started (input_origin.rs `annotate`): their
/// words from a client, a reply from Home, a request to the Project from its page.
const USER_ORIGINS: [&str; 3] = ["client", "home", crate::project_requests::ORIGIN];
/// Cards a `refresh_limit` names.
const LISTED: usize = 10;
/// The limits' ranges (design §3.3).
const MIN_HOURS: std::ops::RangeInclusive<u32> = 1..=24;
const MAX_ACTIVE: std::ops::RangeInclusive<u32> = 1..=50;
const PAUSE_AFTER: std::ops::RangeInclusive<u32> = 1..=10;
/// A "refresh now" request's ID, as brief_update's requestId.
const REQUEST_ID_BYTES: usize = 128;

/// A refresh as sent: brief_update's `refresh`, or the user's change. Each
/// field is optional here; what a card needs depends on whether it has one.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Given {
    every: Option<Every>,
    at: Option<String>,
    hours: Option<u32>,
    days: Option<Vec<u8>>,
    zone: Option<String>,
    instruction: Option<String>,
    paused: Option<bool>,
}

/// A refresh as it is to be: what the row keeps of the user's choice.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Spec {
    cadence: Cadence,
    zone: String,
    instruction: String,
    enabled: bool,
}

impl Spec {
    fn weekly(&self) -> u32 {
        if self.enabled { self.cadence.weekly_runs() } else { 0 }
    }
}

/// A put's or edit's `refresh`, as Change keeps it: None when left out,
/// Some(None) for null, Some(Some(value)) for an object whose fields are ones
/// a refresh has, each of its type. What they make is `rules`'.
pub(super) fn parse(at: &str, object: &serde_json::Map<String, Value>, problems: &mut Vec<Value>) -> Result<Option<Option<Value>>, ()> {
    match object.get("refresh") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(value) => match serde_json::from_value::<Given>(value.clone()) {
            Ok(_) => Ok(Some(Some(value.clone()))),
            Err(error) => {
                problems.push(problem("refresh_invalid", format!("{at}.refresh"),
                    format!("refresh is {{every: day|hours|week, at?, hours?, days?, zone?, instruction, paused?}}, or null to remove it: {error}."),
                    "refresh"));
                Err(())
            }
        },
    }
}

fn plain(error: anyhow::Error) -> String {
    let text = format!("{error:#}");
    text.strip_prefix("refresh_invalid: ").map(str::to_owned).unwrap_or(text)
}

/// What `given` makes of the card's refresh `old` (None: it has none), or why
/// it can't. `every` given replaces the cadence; at, hours or days alone
/// change only those of the one it has.
pub(super) fn resolve(given: &Given, old: Option<&Refresh>) -> Result<Spec, String> {
    let kept: Option<Cadence> = old.and_then(|old| serde_json::from_value(old.cadence.clone()).ok());
    let cadence = match (given.every, kept) {
        (Some(every), _) => Cadence { every, at: given.at.clone(), hours: given.hours, days: given.days.clone() },
        (None, Some(mut cadence)) => {
            if given.at.is_some() {
                cadence.at = given.at.clone();
            }
            if given.hours.is_some() {
                cadence.hours = given.hours;
            }
            if given.days.is_some() {
                cadence.days = given.days.clone();
            }
            cadence
        }
        (None, None) => return Err("a card without a refresh needs every: day, hours or week".into()),
    };
    cadence.clock().map_err(plain)?;
    let zone = given.zone.clone().or_else(|| old.map(|old| old.zone.clone())).unwrap_or_else(|| "local".into());
    refresh::parse_zone(&zone).map_err(plain)?;
    let instruction = match given.instruction.as_deref().map(str::trim) {
        Some(text) => text.to_owned(),
        None => match old {
            Some(old) => old.instruction.clone(),
            None => return Err("a card without a refresh needs instruction: what to do each time, as the user agreed to it".into()),
        },
    };
    let chars = instruction.chars().count();
    if !(1..=INSTRUCTION_CHARS).contains(&chars) {
        return Err(format!("instruction is 1-{INSTRUCTION_CHARS} characters; this one has {chars}"));
    }
    let enabled = given.paused.map(|paused| !paused).or(old.map(|old| old.enabled)).unwrap_or(true);
    Ok(Spec { cadence, zone, instruction, enabled })
}

/// How a change moves a refresh: made anew, run more often (on again after a
/// pause too), or a new instruction.
struct Judged {
    created: bool,
    faster: bool,
    instruction: bool,
}

fn judge(old: Option<&Refresh>, spec: &Spec) -> Judged {
    let before = old.map_or(0, |old| if old.enabled { old.weekly_runs() } else { 0 });
    Judged {
        created: old.is_none(),
        faster: old.is_none() || spec.weekly() > before,
        instruction: old.is_some_and(|old| old.instruction != spec.instruction),
    }
}

/// Why the user's limits refuse `spec` (refresh_too_often, refresh_limit):
/// only a refresh made or made faster, never one already on.
fn over_limit(db: &Connection, project: &str, identity: Option<i64>, old: Option<&Refresh>, spec: &Spec, limits: &Limits)
    -> Result<Option<(&'static str, String)>> {
    let judged = judge(old, spec);
    if !spec.enabled || !judged.faster {
        return Ok(None);
    }
    if let (Every::Hours, Some(hours)) = (spec.cadence.every, spec.cadence.hours) {
        if hours < limits.min_hours {
            return Ok(Some(("refresh_too_often", format!(
                "Every {hours} hours is more often than the user allows: the shortest interval is {} hours. Choose every {} hours or less often, \
                 or ask the user to lower it in Settings → Home → Refreshes.", limits.min_hours, limits.min_hours))));
        }
    }
    if old.is_some_and(|old| old.enabled) {
        return Ok(None);
    }
    let on: Vec<Refresh> = refresh::all(db)?.into_iter()
        .filter(|other| other.enabled && !(other.project_id == project && Some(other.identity) == identity))
        .collect();
    if on.len() < limits.max_active as usize {
        return Ok(None);
    }
    let labels = crate::projects::project_labels(db)?;
    let mut named = vec![];
    for other in on.iter().take(LISTED) {
        let title = sections::by_identity(db, &other.project_id, other.identity)?
            .and_then(|row| row.data["title"].as_str().map(str::to_owned))
            .unwrap_or_else(|| other.key.clone());
        let project = labels.get(&other.project_id).map_or("?", |(name, _)| name.as_str());
        named.push(format!("“{title}” ({project})"));
    }
    if on.len() > LISTED {
        named.push(format!("and {} more", on.len() - LISTED));
    }
    Ok(Some(("refresh_limit", format!(
        "{} cards already refresh themselves, the most the user allows: {}. Ask the user to pause or remove one in Settings → Home → \
         Refreshes, or to raise the limit.", on.len(), named.join(", ")))))
}

/// The origin of the first input of `agent`'s Turn `turn`, as Core recorded
/// it on its receipt; None without one (a terminal's prompt, an older record).
fn first_origin(db: &Connection, agent: &str, turn: &str) -> Result<Option<String>> {
    Ok(db.query_row(
        "SELECT json_extract(data,'$.origin.kind') FROM agent_receipts WHERE agent_id=?1 AND turn_id=?2 ORDER BY ord LIMIT 1",
        params![agent, turn],
        |r| r.get::<_, Option<String>>(0),
    ).optional()?.flatten())
}

/// The names of a Project's leads, for not_project_lead.
fn lead_names(store: &Store, db: &Connection, project: &str) -> Result<Vec<String>> {
    let mut names = vec![];
    for id in editors::policy(db, project)?.editor_agent_ids {
        if let Some(brief) = store.brief_in(db, &id)? {
            if brief.agent.closed_at.is_none() {
                names.push(brief.agent.name);
            }
        }
    }
    Ok(names)
}

/// The identity on Home a change's card has, or will have when it continues
/// a report the user marked seen; None for a card not written yet.
fn identity_of(db: &Connection, ctx: &Caller, key: &str) -> Result<Option<i64>> {
    Ok(match sections::live_key(db, &ctx.project, key)? {
        Some(row) => Some(row.identity),
        None => sections::continued_identity(db, &ctx.project, key, &ctx.agent)?,
    })
}

/// The refresh rules on `changes`, after update.rs `rules`: run before the
/// validator and again in the write, against the state it changes. With
/// `checked` false (the other rules found problems) only who may set one.
pub(super) fn rules(store: &Store, db: &Connection, ctx: &Caller, changes: &[Change], checked: bool) -> Result<Vec<Value>> {
    let mut problems = vec![];
    if changes.iter().all(|change| change.refresh.is_none()) {
        return Ok(problems);
    }
    let lead = editors::can_edit(store, db, &ctx.project, &ctx.agent)?;
    let limits = refresh::limits(db)?;
    let mut origin: Option<Option<String>> = None;
    for (index, change) in changes.iter().enumerate() {
        let Some(sent) = &change.refresh else { continue };
        let at = format!("changes[{index}].refresh");
        if !lead {
            let leads = lead_names(store, db, &ctx.project)?;
            let named = if leads.is_empty() { "it has no lead now".to_owned() } else { format!("its leads are {}", leads.join(", ")) };
            problems.push(problem("not_project_lead", at, format!(
                "Only a lead of this Project makes a card refresh itself, and {named}. Tell the user to ask a lead, or to make you one \
                 in the Project's settings. An Agent in no Project keeps no Home: the user makes a Project and an Agent in it, which leads it."),
                "refresh"));
            continue;
        }
        if !checked {
            continue;
        }
        let live = sections::live_key(db, &ctx.project, &change.key)?;
        let kind = match change.op {
            Op::Put => change.kind.as_str(),
            _ => live.as_ref().map_or("", |row| row.kind.as_str()),
        };
        if kind != "report" {
            problems.push(problem("refresh_report_only", at, "Only a report refreshes itself; leave refresh out of an ask or a status.", "refresh"));
            continue;
        }
        let Some(value) = sent else { continue };
        let identity = identity_of(db, ctx, &change.key)?;
        let old = identity.map(|identity| refresh::one(db, &ctx.project, identity)).transpose()?.flatten();
        let given: Given = serde_json::from_value(value.clone()).map_err(|error| anyhow::anyhow!("refresh_invalid: {error}"))?;
        let spec = match resolve(&given, old.as_ref()) {
            Ok(spec) => spec,
            Err(why) => {
                problems.push(problem("refresh_invalid", at, format!("{why}."), "refresh"));
                continue;
            }
        };
        let judged = judge(old.as_ref(), &spec);
        if judged.created || judged.faster || judged.instruction {
            let first = match &origin {
                Some(first) => first.clone(),
                None => {
                    let first = first_origin(db, &ctx.agent, &ctx.turn.turn)?;
                    origin = Some(first.clone());
                    first
                }
            };
            if !first.as_deref().is_some_and(|kind| USER_ORIGINS.contains(&kind)) {
                let started = match first.as_deref() {
                    Some(refresh::ORIGIN) => "a card's refresh",
                    Some("resume") => "an automatic continue",
                    Some(_) => "Core, not the user",
                    None => "nothing Core recorded as the user's",
                };
                problems.push(problem("refresh_needs_user_turn", at, format!(
                    "Making a refresh, making it run more often or changing its instruction is taken only in a Turn the user started \
                     (their message, a reply from Home or a request from the Project's page); this Turn was started by {started}. \
                     Here you may pause it (paused: true), make it run less often or remove it (refresh: null). Tell the user what you \
                     would change: they confirm it in a message of theirs, or change it on the card."),
                    "refresh"));
                continue;
            }
        }
        if let Some((code, why)) = over_limit(db, &ctx.project, identity, old.as_ref(), &spec, &limits)? {
            problems.push(problem(code, at, why, "refresh"));
        }
    }
    Ok(problems)
}

/// Why a refresh is off, when the user (None) or its owner, by name, turned it off.
fn paused_by(owner: Option<&str>) -> refresh::Reason {
    match owner {
        None => refresh::reason("paused", "Paused by you", "你暂停了它"),
        Some(name) => refresh::reason("paused_by_owner", format!("Paused by its owner {name}"), format!("主人 {name} 暂停了它")),
    }
}

/// Writes `spec` as the refresh of card `identity` (key `key`), made by
/// `by` (an Agent's ID, or "user"; `owner` its name, None for the user), over `old`, the row as read in this same
/// transaction. Made: no slot before now is due (refresh.rs `baseline`). Turned
/// on again, or its cadence or zone changed while on: none before now either
/// (no making up for a pause), and its failures in a row start again. Turned
/// off: nothing waits, and a "refresh now" not sent is dropped. A run already
/// sent still settles. The version moves on with every write.
#[allow(clippy::too_many_arguments)]
fn write(db: &Connection, project: &str, identity: i64, key: &str, old: Option<&Refresh>, spec: &Spec, by: &str, owner: Option<&str>,
    now: DateTime<Utc>) -> Result<Refresh> {
    let cadence = serde_json::to_value(&spec.cadence)?;
    let at = now.to_rfc3339();
    let Some(old) = old else {
        let paused = (!spec.enabled).then(|| paused_by(owner));
        db.execute(
            "INSERT INTO project_brief_refreshes(project_id,identity,key,cadence,zone,instruction,enabled,paused_reason,version,
             failures,created_at,created_by,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,0,?9,?10,?9)",
            params![project, identity, key, cadence.to_string(), spec.zone, spec.instruction, spec.enabled,
                paused.as_ref().map(refresh::text), at, by],
        )?;
        return refresh::one(db, project, identity)?.context("the refresh was not written");
    };
    let mut next = old.clone();
    let moved = old.cadence != cadence || old.zone != spec.zone;
    let enabling = spec.enabled && !old.enabled;
    if enabling || (spec.enabled && moved) {
        let latest = Times::new(&spec.cadence, &spec.zone)?.latest(now);
        next.last_slot = latest.max(old.last_slot).or(Some(now));
        next.progress.waiting = None;
    }
    if enabling {
        next.failures = 0;
        next.paused_reason = None;
    }
    if !spec.enabled && old.enabled {
        next.paused_reason = Some(paused_by(owner));
        next.progress.waiting = None;
        next.progress.now = None;
    }
    let changed = db.execute(
        "UPDATE project_brief_refreshes SET key=?4,cadence=?5,zone=?6,instruction=?7,enabled=?8,paused_reason=?9,version=version+1,
         last_slot=?10,run=?11,failures=?12,updated_at=?13 WHERE project_id=?1 AND identity=?2 AND version=?3",
        params![project, identity, old.version, key, cadence.to_string(), spec.zone, spec.instruction, spec.enabled,
            next.paused_reason.as_ref().map(refresh::text), next.last_slot.map(|slot| slot.to_rfc3339()), refresh::text(&next.progress),
            next.failures, at],
    )?;
    ensure!(changed == 1, "the refresh changed while it was being written");
    refresh::one(db, project, identity)?.context("the refresh was not written")
}

/// What an answer says of a refresh it wrote: its version, whether it is on,
/// and when it runs next.
fn written(refresh: &Refresh, now: DateTime<Utc>) -> Value {
    let next = refresh.enabled.then(|| refresh.times().ok().and_then(|times| times.next(now))).flatten();
    json!({"version":refresh.version,"enabled":refresh.enabled,"weeklyRuns":refresh.weekly_runs(),"nextAt":next})
}

/// brief_update's write of a change's refresh to card `identity`, after
/// update.rs wrote the card, in the same transaction. Some(entry) for the
/// answer when it changed one: the refresh written, or null once removed.
pub(super) fn apply(tx: &Connection, ctx: &Caller, change: &Change, identity: i64) -> Result<Option<Value>> {
    let Some(sent) = &change.refresh else { return Ok(None) };
    let old = refresh::one(tx, &ctx.project, identity)?;
    let Some(value) = sent else {
        return Ok(removed(tx, &ctx.project, identity)?.then_some(Value::Null));
    };
    let given: Given = serde_json::from_value(value.clone())?;
    let spec = resolve(&given, old.as_ref()).map_err(|why| anyhow::anyhow!("refresh_invalid: {why}"))?;
    let now = Utc::now();
    let refresh = write(tx, &ctx.project, identity, &change.key, old.as_ref(), &spec, &ctx.agent, Some(&ctx.agent_name), now)?;
    Ok(Some(written(&refresh, now)))
}

/// Removes card `identity`'s refresh; true if it had one.
pub(super) fn removed(tx: &Connection, project: &str, identity: i64) -> Result<bool> {
    Ok(tx.execute("DELETE FROM project_brief_refreshes WHERE project_id=?1 AND identity=?2", params![project, identity])? == 1)
}

/// Whether a put of card `identity` keeps the version it replaces as
/// history (design §3.4): the card refreshes itself, or this put makes it.
pub(super) fn keeps_history(tx: &Connection, project: &str, identity: i64, change: &Change) -> Result<bool> {
    Ok(matches!(change.refresh, Some(Some(_))) || refresh::one(tx, project, identity)?.is_some())
}

/// A user's route refused: its status, a code, what to tell them, and the
/// refresh (or limits) as they are now when the page's copy is out of date.
pub(super) struct Refused {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub current: Option<Value>,
}

fn refused(status: StatusCode, code: &'static str, message: impl Into<String>) -> Refused {
    Refused { status, code, message: message.into(), current: None }
}

type Answer = Result<Result<Value, Refused>>;

/// A refresh as the routes answer with it (refresh.rs `view`).
fn shown(store: &Store, db: &Connection, refresh: &Refresh, now: DateTime<Utc>) -> Result<Value> {
    let versions = of_card(db, &refresh.project_id, refresh.identity)?.iter().filter(|row| row.history_reason.as_deref() == Some("refreshed")).count();
    let name = |id: &str| store.brief_in(db, id).ok().flatten().map(|brief| brief.agent.name);
    let mut view = refresh::view(refresh, versions as i64, &name, now);
    view["identity"] = json!(refresh.identity);
    view["key"] = json!(refresh.key);
    Ok(view)
}

fn found(db: &Connection, project: &str, identity: i64) -> Result<Result<Refresh, Refused>> {
    crate::projects::ensure_exists(db, project)?;
    Ok(refresh::one(db, project, identity)?
        .ok_or_else(|| refused(StatusCode::NOT_FOUND, "refresh_not_found", "This card has no refresh now.")))
}

/// PUT …/refreshes/{identity}: the user's change, against `version`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UserChange {
    version: i64,
    #[serde(default)]
    cadence: Option<Cadence>,
    #[serde(default)]
    zone: Option<String>,
    #[serde(default)]
    instruction: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
}

pub(super) fn change(store: &Store, project: &str, identity: i64, input: UserChange) -> Answer {
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    let old = match found(&tx, project, identity)? {
        Ok(old) => old,
        Err(refused) => return Ok(Err(refused)),
    };
    let now = Utc::now();
    if old.version != input.version {
        let mut conflict = refused(StatusCode::CONFLICT, "version_conflict", format!(
            "This refresh changed since the page read it (version {} now, not {}); here it is as it is now.", old.version, input.version));
        conflict.current = Some(shown(store, &tx, &old, now)?);
        return Ok(Err(conflict));
    }
    let given = Given {
        every: input.cadence.as_ref().map(|cadence| cadence.every),
        at: input.cadence.as_ref().and_then(|cadence| cadence.at.clone()),
        hours: input.cadence.as_ref().and_then(|cadence| cadence.hours),
        days: input.cadence.as_ref().and_then(|cadence| cadence.days.clone()),
        zone: input.zone,
        instruction: input.instruction,
        paused: input.enabled.map(|enabled| !enabled),
    };
    let spec = match resolve(&given, Some(&old)) {
        Ok(spec) => spec,
        Err(why) => return Ok(Err(refused(StatusCode::BAD_REQUEST, "refresh_invalid", format!("{why}.")))),
    };
    if let Some((code, why)) = over_limit(&tx, project, Some(identity), Some(&old), &spec, &refresh::limits(&tx)?)? {
        return Ok(Err(refused(StatusCode::BAD_REQUEST, code, why)));
    }
    let key = sections::by_identity(&tx, project, identity)?.map_or(old.key.clone(), |row| row.key);
    let refresh = write(&tx, project, identity, &key, Some(&old), &spec, "user", None, now)?;
    let view = shown(store, &tx, &refresh, now)?;
    tx.commit()?;
    Ok(Ok(view))
}

/// DELETE …/refreshes/{identity}: the card stays, as a report that does not
/// refresh itself.
pub(super) fn delete(store: &Store, project: &str, identity: i64) -> Answer {
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    if let Err(refused) = found(&tx, project, identity)? {
        return Ok(Err(refused));
    }
    removed(&tx, project, identity)?;
    tx.commit()?;
    Ok(Ok(json!({"projectId":project,"identity":identity,"removed":true})))
}

/// POST …/refreshes/{identity}/now: refresh once now, outside the cadence,
/// as soon as the card's owner can take it; the next slot stays when it was.
/// The same requestId again changes nothing; one request already waiting, or
/// a run still going, is that refresh.
pub(super) fn refresh_now(store: &Store, project: &str, identity: i64, request: &str) -> Answer {
    if request.trim().is_empty() || request.len() > REQUEST_ID_BYTES {
        return Ok(Err(refused(StatusCode::BAD_REQUEST, "invalid_input", format!("requestId is 1-{REQUEST_ID_BYTES} bytes."))));
    }
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    let old = match found(&tx, project, identity)? {
        Ok(old) => old,
        Err(refused) => return Ok(Err(refused)),
    };
    let now = Utc::now();
    if !old.enabled {
        let mut paused = refused(StatusCode::CONFLICT, "refresh_paused", "This refresh is paused: turn it on to refresh now.");
        paused.current = Some(shown(store, &tx, &old, now)?);
        return Ok(Err(paused));
    }
    let progress = &old.progress;
    let asked = progress.now.as_ref().map(|now| now.request_id.as_str()) == Some(request)
        || progress.run.as_ref().and_then(|run| run.manual.as_deref()) == Some(request)
        || progress.waiting.as_ref().and_then(|waiting| waiting.manual.as_deref()) == Some(request);
    let going = progress.now.is_some() || progress.run.as_ref().is_some_and(|run| run.state == refresh::SENT);
    if !asked && !going {
        let mut next = progress.clone();
        next.now = Some(NowRequest { request_id: request.to_owned(), at: now });
        tx.execute(
            "UPDATE project_brief_refreshes SET run=?3,version=version+1,updated_at=?4 WHERE project_id=?1 AND identity=?2",
            params![project, identity, refresh::text(&next), now.to_rfc3339()],
        )?;
    }
    let current = refresh::one(&tx, project, identity)?.context("the refresh was not written")?;
    let view = shown(store, &tx, &current, now)?;
    tx.commit()?;
    Ok(Ok(view))
}

/// Every version of card `identity` history still keeps and the live one,
/// newest first.
fn of_card(db: &Connection, project: &str, identity: i64) -> Result<Vec<sections::Row>> {
    sections::of_identity(db, project, identity)
}

/// A version's lead in one line: the first line of its summary's lead, else
/// of the root's first Markdown block; at most 200 characters.
fn lead(body: &Value) -> Option<String> {
    let elements = &body["elements"];
    let root = &elements[body["root"].as_str().unwrap_or_default()];
    let named = root["props"]["summary"]["lead"].as_str().map(|id| &elements[id]);
    let first = root["children"].as_array().into_iter().flatten().filter_map(Value::as_str)
        .map(|id| &elements[id]).find(|block| block["type"] == "Markdown");
    let text = named.filter(|block| block["type"] == "Markdown").or(first)?["props"]["text"].as_str()?;
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(line.chars().take(200).collect())
}

/// GET …/refreshes/{identity}/versions: the card's issues of the last
/// HISTORY_DAYS days, newest first, without their bodies.
pub(super) fn versions(store: &Store, project: &str, identity: i64) -> Answer {
    let db = store.db.read()?;
    crate::projects::ensure_exists(&db, project)?;
    let rows = of_card(&db, project, identity)?;
    if rows.is_empty() {
        return Ok(Err(refused(StatusCode::NOT_FOUND, "section_not_found", "No card with this identity is kept now.")));
    }
    let items: Vec<Value> = rows.iter().map(|row| json!({"version":row.version,"at":row.updated_at,"title":row.data["title"],
        "lead":lead(&row.data["body"]),"live":row.live,"historyReason":row.history_reason})).collect();
    Ok(Ok(json!({"projectId":project,"identity":identity,"key":rows[0].key,"versions":items})))
}

/// GET …/refreshes/{identity}/versions/{version}: that issue whole, as Home
/// shows a section. Its attachments are read by version, as any section's.
pub(super) fn version(store: &Store, project: &str, identity: i64, version: i64) -> Answer {
    let db = store.db.read()?;
    crate::projects::ensure_exists(&db, project)?;
    let Some(row) = of_card(&db, project, identity)?.into_iter().find(|row| row.version == version) else {
        return Ok(Err(refused(StatusCode::NOT_FOUND, "version_not_found", "This card has no such version kept now.")));
    };
    let owner = Owners::default().get(store, &db, &row)?;
    let seen = sections::seen(&db, project)?;
    let mut refs = super::refs::Refs::new(store, &db);
    let mut section = sections::section_json(&row, &owner, seen.get(&row.key), refs.of(&row.data["body"]), Utc::now());
    section["id"] = json!(row.identity);
    if !row.live {
        section["historyReason"] = json!(row.history_reason);
    }
    Ok(Ok(section))
}

fn limits_view(limits: &Limits) -> Value {
    let mut view = serde_json::to_value(limits).unwrap_or_default();
    view["ranges"] = json!({"minHours":[MIN_HOURS.start(), MIN_HOURS.end()],"maxActive":[MAX_ACTIVE.start(), MAX_ACTIVE.end()],
        "pauseAfterFailures":[PAUSE_AFTER.start(), PAUSE_AFTER.end()]});
    view
}

/// GET /api/brief-refreshes/limits.
pub(super) fn limits(store: &Store) -> Result<Value> {
    Ok(limits_view(&refresh::limits(&*store.db.read()?)?))
}

/// PUT /api/brief-refreshes/limits.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LimitsInput {
    version: i64,
    min_hours: u32,
    max_active: u32,
    pause_after_failures: u32,
}

/// Saves the user's limits against the version Settings read. A lower limit
/// stops no refresh already on (`over_limit`).
pub(super) fn save_limits(store: &Store, input: LimitsInput) -> Answer {
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    let current = refresh::limits(&tx)?;
    if current.version != input.version {
        let mut conflict = refused(StatusCode::CONFLICT, "version_conflict", format!(
            "The limits changed since the page read them (version {} now, not {}).", current.version, input.version));
        conflict.current = Some(limits_view(&current));
        return Ok(Err(conflict));
    }
    for (name, value, range) in [("minHours", input.min_hours, MIN_HOURS), ("maxActive", input.max_active, MAX_ACTIVE),
        ("pauseAfterFailures", input.pause_after_failures, PAUSE_AFTER)] {
        if !range.contains(&value) {
            return Ok(Err(refused(StatusCode::BAD_REQUEST, "invalid_input",
                format!("{name} is a whole number from {} to {}.", range.start(), range.end()))));
        }
    }
    let saved = Limits { version: current.version + 1, min_hours: input.min_hours, max_active: input.max_active,
        pause_after_failures: input.pause_after_failures };
    tx.execute(
        "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![refresh::LIMITS_KEY, refresh::text(&saved)],
    )?;
    tx.commit()?;
    Ok(Ok(limits_view(&saved)))
}
