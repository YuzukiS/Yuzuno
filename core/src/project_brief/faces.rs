//! Card faces in brief_update's answer (YN-209): how each report or status
//! card the update writes shows on Home, read by Home's own rules
//! (web/src/home/card-face.ts, through the validator's `briefCard`) on the
//! section as Core keeps it: its normalized body, and its attachments as Core
//! takes them (staged by a write, judged by validateOnly, as stored for an
//! edit or patch). An accepted update and a validateOnly check that passes
//! both carry them.
//!
//! A face is never a check: it is read only once every check before the
//! write has passed, and its absence (the validator busy, slow or older)
//! changes nothing else in the answer, which says why. At most MAX_CARDS are
//! asked for, in the order of the changes; the rest are counted. The answer
//! stays within one MCP answer (mcp_views::BUDGET) by leaving faces out,
//! never anything else. An update with no report or status card asks for
//! nothing and its answer has no card fields.
use super::{
    sections::Row,
    update::{Change, Checker, Op},
    *,
};
use crate::results::BriefCards;

/// Card faces one answer asks for: more is rarely read, and each costs a validator call.
pub(super) const MAX_CARDS: usize = 6;
/// Of a summary's ids as the Agent sent them, the bytes a face is told.
const MAX_ID: usize = 64;

/// What a card's face is read with besides the section (set by update::start).
#[derive(Clone, Debug)]
pub(crate) struct Input {
    /// The card refreshes itself (YN-113): the put or edit's refresh where it
    /// gives one, else the one the live card keeps.
    pub refreshes: bool,
    /// An edit or patch's attachments as stored: it stages nothing.
    pub stored: Option<Value>,
}

/// The faces of one update, as `attach` adds them to its answer.
#[derive(Clone, Debug, Default)]
pub(crate) struct Faces {
    /// Report and status cards the update writes; faces were asked for the first MAX_CARDS.
    pub cards: usize,
    pub told: BriefCards,
}

/// Whether a section of this kind shows as a card with a face: a report or a status, never an Ask.
pub(super) fn shown(kind: &str) -> bool {
    matches!(kind, "report" | "status")
}

/// A put, edit or patch's Input, from the live section it writes over (if any).
pub(super) fn input(db: &Connection, project: &str, change: &Change, live: Option<&Row>) -> Result<Input> {
    let refreshes = match &change.refresh {
        Some(given) => given.is_some(),
        None => match live {
            Some(row) => super::refresh::one(db, project, row.identity)?.is_some(),
            None => false,
        },
    };
    let stored = (change.op != Op::Put).then(|| live.map(|row| row.data["attachments"].clone()).unwrap_or(Value::Null));
    Ok(Input { refreshes, stored })
}

/// An attachment as a face reads it: its name, kind, whether Core keeps it,
/// its size, caption and time. Never its path, URL or digest.
fn attachment(entry: &Value) -> Value {
    let mut kept = json!({"name":entry["name"],"kind":entry["kind"],"snapshot":entry["snapshot"] == true});
    for field in ["size", "caption", "takenAt", "mime"] {
        if !entry[field].is_null() {
            kept[field] = entry[field].clone();
        }
    }
    kept
}

/// The summary's ids as the Agent sent them, before Core normalized or repaired the section; null when it named none.
fn requested(section: &Value) -> Value {
    let body = &section["body"];
    let summary = body["root"].as_str().map(|root| &body["elements"][root]["props"]["summary"]);
    let mut ids = serde_json::Map::new();
    for slot in ["lead", "visual", "conditions"] {
        if let Some(id) = summary.and_then(|summary| summary[slot].as_str()) {
            ids.insert(slot.into(), json!(id.chars().take(MAX_ID).collect::<String>()));
        }
    }
    if ids.is_empty() { Value::Null } else { Value::Object(ids) }
}

/// The faces of `changes` checked into `normalized`, each put's attachments
/// as `taken` (by change). One wait for all of them (Validator::brief_cards);
/// none asked for past MAX_CARDS.
pub(super) async fn read(checker: &Checker, changes: &[Change], normalized: &[Value], taken: &[Vec<Value>]) -> Faces {
    let mut requests = vec![];
    let mut cards = 0;
    for (index, change) in changes.iter().enumerate() {
        let (Some(card), Some(section)) = (&change.card, normalized.get(index).filter(|section| section.is_object())) else { continue };
        cards += 1;
        if requests.len() == MAX_CARDS {
            continue;
        }
        let entries: Vec<Value> = match &card.stored {
            Some(stored) => stored.as_array().cloned().unwrap_or_default(),
            None => taken.get(index).cloned().unwrap_or_default(),
        };
        let kind = section.get("kind").filter(|kind| kind.is_string()).unwrap_or(&change.section["kind"]);
        let title = section.get("title").filter(|title| title.is_string()).unwrap_or(&change.section["title"]);
        requests.push(json!({
            "section": {"key": change.key, "kind": kind, "title": title, "body": section["body"],
                "attachments": entries.iter().map(attachment).collect::<Vec<_>>()},
            "refreshes": card.refreshes,
            "requested": requested(&change.section),
        }));
    }
    if requests.is_empty() {
        return Faces::default();
    }
    Faces { cards, told: checker.cards(requests).await }
}

/// Adds `faces` to an answer: `cards`, the note told with them (`cardsNote`),
/// how many were not told (`moreCards`) and, when some were not computed,
/// why (`cardsUnavailable`). Within mcp_views::BUDGET bytes of compact JSON,
/// faces are left out from the last; the rest of the answer is never cut.
pub(super) fn attach(answer: &mut Value, faces: &Faces) {
    if faces.cards == 0 {
        return;
    }
    let mut told: Vec<Value> = faces.told.cards.iter().filter(|card| card.is_object()).cloned().collect();
    let asked = faces.cards.min(MAX_CARDS);
    let mut fitted = false;
    loop {
        answer["cards"] = json!(told);
        match &faces.told.note {
            Some(note) => answer["cardsNote"] = json!(note),
            None => {
                if let Some(object) = answer.as_object_mut() {
                    object.remove("cardsNote");
                }
            }
        }
        let more = faces.cards - told.len();
        if more > 0 {
            answer["moreCards"] = json!(more);
        }
        let mut why = vec![];
        if faces.cards > MAX_CARDS {
            why.push(format!("faces are told for the first {MAX_CARDS} report or status cards an update writes"));
        }
        if let Some(missing) = &faces.told.missing {
            why.push(format!("{} of {asked} were not computed: {missing}", asked - faces.told.cards.len().min(asked)));
        }
        if fitted {
            why.push(format!("some were left out to keep the answer within {} bytes", crate::mcp_views::BUDGET));
        }
        if !why.is_empty() {
            answer["cardsUnavailable"] = json!(format!("{}. The update itself is as the rest of this answer says.", why.join("; ")));
        }
        if told.is_empty() || answer.to_string().len() <= crate::mcp_views::BUDGET {
            return;
        }
        told.pop();
        fitted = true;
    }
}

/// A stand-in validator's faces, for tests: each request back, so a test
/// reads what Core asked with; none at all when a section is titled
/// "CARDS DOWN"; a section titled "BIG" gets a face of about 12 KB.
#[cfg(test)]
pub(super) fn fake(requests: Vec<Value>) -> BriefCards {
    if requests.iter().any(|request| request["section"]["title"] == "CARDS DOWN") {
        return BriefCards { cards: vec![], note: None, missing: Some("the validator was busy for 2 s".into()) };
    }
    let cards = requests.into_iter().map(|request| {
        let mut card = json!({"key":request["section"]["key"],"asked":request});
        if request["section"]["title"] == "BIG" {
            card["pad"] = json!("x".repeat(12_000));
        }
        card
    }).collect();
    BriefCards { cards, note: Some("fake note".into()), missing: None }
}
