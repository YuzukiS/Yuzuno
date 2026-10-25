//! What Core pushes (T-200): the notices of T-188 (web/src/notification-events.ts),
//! from comparing one read of the Agent list and Home's Asks with the next,
//! as a page compares them, with their texts as a page shows them without a
//! preview. No conversation text is ever in one.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

/// The kinds a device chooses (T-188's categories, but the daily backup's).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    NeedsYou,
    Failed,
    Finished,
}

impl Kind {
    pub const ALL: [Kind; 3] = [Kind::NeedsYou, Kind::Failed, Kind::Finished];

    fn name(self) -> &'static str {
        match self {
            Kind::NeedsYou => "needsYou",
            Kind::Failed => "failed",
            Kind::Finished => "finished",
        }
    }

    /// T-188's order: requests first, then failures, then finished Turns.
    fn priority(self) -> u8 {
        match self {
            Kind::NeedsYou => 0,
            Kind::Failed => 1,
            Kind::Finished => 2,
        }
    }
}

/// What a notice is read from about one Agent.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgentState {
    pub id: String,
    pub name: String,
    pub status: String,
    pub pending: u64,
    pub closed: bool,
    /// The work summary's kind, and the Turn and request it is about.
    pub summary: Option<String>,
    pub turn: Option<String>,
    pub request: Option<String>,
}

/// An Ask in Home's Needs you.
#[derive(Clone, Debug, PartialEq)]
pub struct AskState {
    pub project: String,
    pub key: String,
    pub agent_name: String,
    /// When it was asked: asked again, it is another Ask.
    pub since: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Read {
    pub agents: Vec<AgentState>,
    pub asks: Vec<AskState>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub kind: Kind,
    /// The system shows one notification per tag (T-188's tags).
    pub tag: String,
    pub title: String,
    pub body: String,
    /// The Agent a click opens; none opens Home.
    pub agent: Option<String>,
    /// One notification for a burst.
    pub summary: bool,
    /// What makes it the same event again (see `Recent`).
    pub event: String,
}

/// More at once than this become one notification (T-188's BURST).
pub const BURST: usize = 3;
const PREVIEW_CHARS: usize = 140;
/// Room for the names a notification holds (the desktop app's limits).
const TITLE_CHARS: usize = 120;
const BODY_CHARS: usize = 400;

fn clip(text: &str, chars: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= chars {
        return line;
    }
    line.chars().take(chars - 1).chain(['…']).collect()
}

fn tag(kind: Kind, id: &str) -> String {
    format!("yuzuno:{}:{id}", kind.name())
}

fn agent_notice(before: &AgentState, after: &AgentState) -> Option<Notice> {
    if after.closed {
        return None;
    }
    let notice = |kind: Kind, title: String, body: &str, event: String| Notice {
        kind, tag: tag(kind, &after.id), title, body: body.into(), agent: Some(after.id.clone()), summary: false, event,
    };
    if after.pending > before.pending || (after.status == "waiting" && before.status != "waiting") {
        // A request replayed after a reconnect is the same request again.
        let event = format!("needsYou:{}:{}:{}", after.id, after.pending, after.request.as_deref().unwrap_or(""));
        return Some(notice(Kind::NeedsYou, format!("{} needs you", after.name), "Waiting for your response.", event));
    }
    // A Turn's end: from working to anything but working or waiting.
    if before.status != "working" || after.status == "working" || after.status == "waiting" {
        return None;
    }
    let turn = after.turn.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if after.status == "error" || after.summary.as_deref() == Some("error") {
        let event = format!("failed:{}:{turn}", after.id);
        return Some(notice(Kind::Failed, format!("{}: the Turn failed", after.name), "Open the conversation to see why.", event));
    }
    // Stopped by someone, or the Agent went offline: not a result to report.
    if after.status != "idle" || after.summary.as_deref() == Some("interrupted") {
        return None;
    }
    Some(notice(Kind::Finished, format!("{} finished", after.name), "The Turn finished.", format!("finished:{}:{turn}", after.id)))
}

/// The notices between two reads: at most one per Agent, none for an
/// Agent new to the list, and one per Ask new in Needs you.
pub fn notices(before: &Read, after: &Read) -> Vec<Notice> {
    let earlier: HashMap<&str, &AgentState> = before.agents.iter().map(|a| (a.id.as_str(), a)).collect();
    let mut found: Vec<Notice> = after.agents.iter()
        .filter_map(|agent| earlier.get(agent.id.as_str()).and_then(|was| agent_notice(was, agent)))
        .collect();
    let seen: HashSet<(&str, &str)> = before.asks.iter().map(|a| (a.project.as_str(), a.key.as_str())).collect();
    for ask in after.asks.iter().filter(|a| !seen.contains(&(a.project.as_str(), a.key.as_str()))) {
        let key = format!("{}/{}", ask.project, ask.key);
        found.push(Notice {
            kind: Kind::NeedsYou,
            tag: tag(Kind::NeedsYou, &format!("ask:{key}")),
            title: format!("{} asks you", ask.agent_name),
            body: "An Ask is waiting for your answer on Home.".into(),
            agent: None,
            summary: false,
            event: format!("ask:{key}:{}", ask.since),
        });
    }
    found
}

/// One device's notifications of one read: the most urgent first, and a
/// burst as one (T-188's `merged`).
pub fn merged(mut notices: Vec<Notice>) -> Vec<Notice> {
    notices.sort_by_key(|n| n.kind.priority());
    if notices.len() <= BURST {
        return notices;
    }
    let mut names: Vec<&str> = Vec::new();
    for notice in &notices {
        if !names.contains(&notice.title.as_str()) {
            names.push(&notice.title);
        }
    }
    vec![Notice {
        kind: notices[0].kind,
        tag: "yuzuno:summary".into(),
        title: format!("{} updates in your Workspace", notices.len()),
        body: clip(&names.join(" · "), PREVIEW_CHARS),
        agent: None,
        summary: true,
        event: String::new(),
    }]
}

/// The message a device's service worker reads: no URL, only what names
/// the place a click opens within its own page.
pub fn payload(notice: &Notice, workspace: &str) -> Value {
    let mut value = json!({
        "v": 1,
        "kind": if notice.summary { "summary" } else { notice.kind.name() },
        "workspaceId": workspace,
        "open": if notice.agent.is_some() { "agent" } else { "home" },
        "title": clip(&notice.title, TITLE_CHARS),
        "body": clip(&notice.body, BODY_CHARS),
        "tag": notice.tag,
    });
    if let Some(agent) = &notice.agent {
        value["agentId"] = json!(agent);
    }
    value
}

/// The events pushed lately, so the same one is not pushed twice; bounded.
#[derive(Default)]
pub struct Recent {
    order: VecDeque<String>,
    known: HashSet<String>,
}

impl Recent {
    pub const KEPT: usize = 512;

    /// The notices not pushed before, now remembered.
    pub fn fresh(&mut self, notices: Vec<Notice>) -> Vec<Notice> {
        notices.into_iter().filter(|notice| {
            if !self.known.insert(notice.event.clone()) {
                return false;
            }
            self.order.push_back(notice.event.clone());
            while self.order.len() > Self::KEPT {
                if let Some(old) = self.order.pop_front() {
                    self.known.remove(&old);
                }
            }
            true
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str, status: &str) -> AgentState {
        AgentState { id: id.into(), name: format!("Agent {id}"), status: status.into(), turn: Some("t1".into()), ..Default::default() }
    }
    fn read(agents: Vec<AgentState>) -> Read {
        Read { agents, asks: vec![] }
    }
    fn kinds(notices: &[Notice]) -> Vec<(Kind, &str)> {
        notices.iter().map(|n| (n.kind, n.title.as_str())).collect()
    }

    #[test]
    fn turn_ends_and_requests_give_t188_notices() {
        let before = read(vec![agent("a", "working"), agent("b", "working"), agent("c", "idle"), agent("d", "working"), agent("e", "working")]);
        let mut failed = agent("b", "idle");
        failed.summary = Some("error".into());
        let mut waiting = agent("c", "waiting");
        waiting.pending = 1;
        waiting.request = Some("r1".into());
        let mut interrupted = agent("e", "idle");
        interrupted.summary = Some("interrupted".into());
        let after = read(vec![agent("a", "idle"), failed, waiting, agent("d", "offline"), interrupted, agent("new", "idle")]);
        let found = notices(&before, &after);
        assert_eq!(kinds(&found), vec![
            (Kind::Finished, "Agent a finished"),
            (Kind::Failed, "Agent b: the Turn failed"),
            (Kind::NeedsYou, "Agent c needs you"),
        ]);
        assert_eq!(found[0].body, "The Turn finished.");
        assert_eq!(found[0].tag, "yuzuno:finished:a");
        assert_eq!(found[1].body, "Open the conversation to see why.");
        assert_eq!(found[2].body, "Waiting for your response.");
        assert_eq!(found[2].event, "needsYou:c:1:r1");
        // Unchanged, closed or first seen: nothing.
        assert!(notices(&after, &after).is_empty());
        let mut closed = agent("a", "idle");
        closed.closed = true;
        assert!(notices(&read(vec![agent("a", "working")]), &read(vec![closed])).is_empty());
    }

    #[test]
    fn a_new_ask_needs_you_and_opens_home() {
        let ask = |key: &str| AskState { project: "p1".into(), key: key.into(), agent_name: "Lead".into(), since: "2026-10-25T00:00:00Z".into() };
        let before = Read { agents: vec![], asks: vec![ask("old")] };
        let after = Read { agents: vec![], asks: vec![ask("old"), ask("new")] };
        let found = notices(&before, &after);
        assert_eq!(kinds(&found), vec![(Kind::NeedsYou, "Lead asks you")]);
        assert_eq!(found[0].tag, "yuzuno:needsYou:ask:p1/new");
        assert_eq!(found[0].agent, None);
        let sent = payload(&found[0], "w1");
        assert_eq!(sent, json!({"v":1,"kind":"needsYou","workspaceId":"w1","open":"home","title":"Lead asks you",
            "body":"An Ask is waiting for your answer on Home.","tag":"yuzuno:needsYou:ask:p1/new"}));
    }

    #[test]
    fn a_burst_is_one_summary_and_the_most_urgent_leads() {
        let before = read((0..5).map(|i| agent(&i.to_string(), "working")).collect());
        let mut after: Vec<AgentState> = (0..5).map(|i| agent(&i.to_string(), "idle")).collect();
        after[4].status = "waiting".into();
        let all = notices(&before, &read(after));
        assert_eq!(merged(all[..3].to_vec()).len(), 3);
        assert_eq!(merged(all[1..4].to_vec())[0].kind, Kind::Finished);
        let one = merged(all);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].kind, Kind::NeedsYou);
        assert_eq!(one[0].title, "5 updates in your Workspace");
        assert!(one[0].body.starts_with("Agent 4 needs you · Agent 0 finished"));
        let sent = payload(&one[0], "w1");
        assert_eq!((sent["kind"].as_str(), sent["open"].as_str(), sent.get("agentId")), (Some("summary"), Some("home"), None));
    }

    #[test]
    fn the_same_event_is_pushed_once_and_memory_is_bounded() {
        let before = read(vec![agent("a", "working")]);
        let after = read(vec![agent("a", "idle")]);
        let mut recent = Recent::default();
        assert_eq!(recent.fresh(notices(&before, &after)).len(), 1);
        assert!(recent.fresh(notices(&before, &after)).is_empty(), "the same Turn's end again");
        let mut next = agent("a", "idle");
        next.turn = Some("t2".into());
        assert_eq!(recent.fresh(notices(&before, &read(vec![next]))).len(), 1, "another Turn");
        for i in 0..Recent::KEPT {
            let mut other = agent("a", "idle");
            other.turn = Some(format!("x{i}"));
            recent.fresh(notices(&before, &read(vec![other])));
        }
        assert_eq!(recent.order.len(), Recent::KEPT);
        assert_eq!(recent.known.len(), Recent::KEPT);
        assert_eq!(recent.fresh(notices(&before, &after)).len(), 1, "forgotten once out of the window");
    }

    #[test]
    fn long_names_are_clipped() {
        let mut long = agent("a", "idle");
        long.name = "n".repeat(300);
        let found = notices(&read(vec![agent("a", "working")]), &read(vec![long]));
        let title = payload(&found[0], "w")["title"].as_str().unwrap().to_owned();
        assert_eq!(title.chars().count(), TITLE_CHARS);
        assert!(title.ends_with('…'));
    }
}
