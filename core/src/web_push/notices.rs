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

/// An executor the user dispatched, in Home's Needs you (T-43 S4a): its
/// result waits for release, its start failed, or its task is blocked.
#[derive(Clone, Debug, PartialEq)]
pub struct ExecutorNeed {
    pub agent: String,
    pub name: String,
    /// delivering, failed or blocked.
    pub state: String,
    /// Since when: in that state again later, it is another need.
    pub since: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Read {
    pub agents: Vec<AgentState>,
    pub asks: Vec<AskState>,
    pub executors: Vec<ExecutorNeed>,
    /// Home cards that refresh themselves (YN-113 R4): their last run and
    /// how they are paused.
    pub refreshes: Vec<RefreshState>,
}

/// One refresh as a notice reads it (project_brief::refresh::notice_states).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RefreshState {
    pub project: String,
    pub project_name: String,
    pub identity: i64,
    pub key: String,
    pub title: String,
    pub enabled: bool,
    pub version: i64,
    /// The last run: sent, refreshed, failed or skipped; absent before one.
    pub state: Option<String>,
    pub slot: Option<String>,
    pub missed: u32,
    /// Why a failed or skipped run ended.
    pub reason: Option<String>,
    /// A pause's code and why: `paused` and `paused_by_owner` are the user's
    /// or the owner's own choice, and tell of nothing.
    pub paused: Option<String>,
    pub paused_message: Option<String>,
    /// The owner a run was sent to, and its Turn.
    pub owner: Option<String>,
    pub turn: Option<String>,
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
    /// The kinds it tells of: a device must still want each of them.
    pub covers: Vec<Kind>,
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

fn agent_notice(before: &AgentState, after: &AgentState, refresh_turns: &HashSet<&str>) -> Option<Notice> {
    if after.closed {
        return None;
    }
    let notice = |kind: Kind, title: String, body: &str, event: String| Notice {
        kind, tag: tag(kind, &after.id), title, body: body.into(), agent: Some(after.id.clone()), summary: false, covers: vec![kind], event,
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
    // A refresh Turn's own notice (below) says how it went: its generic end
    // would be a second notice of one event (YN-113 design §4).
    if after.turn.as_deref().is_some_and(|turn| refresh_turns.contains(turn)) {
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

/// A refresh's notices (YN-113 design §4, R4): one when a run ends as
/// refreshed, failed or skipped, and one when it is paused by something other
/// than the user or its owner. A run still going or waiting tells of nothing;
/// the same run read again tells of nothing either. A pause after failures in
/// a row and the failed run that caused it are one notice.
fn refresh_notices(before: &[RefreshState], after: &[RefreshState]) -> Vec<Notice> {
    let earlier: HashMap<(&str, i64), &RefreshState> =
        before.iter().map(|refresh| ((refresh.project.as_str(), refresh.identity), refresh)).collect();
    let mut found = vec![];
    for refresh in after {
        let was = earlier.get(&(refresh.project.as_str(), refresh.identity));
        let named = if refresh.title.trim().is_empty() { refresh.key.as_str() } else { refresh.title.as_str() };
        let project = if refresh.project_name.trim().is_empty() { "Home" } else { refresh.project_name.as_str() };
        let mut reported = false;
        if let (Some(state), Some(slot)) = (refresh.state.as_deref(), refresh.slot.as_deref()) {
            if matches!(state, "refreshed" | "failed" | "skipped") {
                let same = was.is_some_and(|was| was.state.as_deref() == Some(state) && was.slot.as_deref() == Some(slot));
                if !same {
                    let (kind, title, body) = if state == "refreshed" {
                        (Kind::Finished, format!("“{named}” refreshed"),
                            if refresh.missed > 0 { format!("{project} · caught up, {} missed", refresh.missed) } else { project.to_owned() })
                    } else {
                        let why = refresh.reason.as_deref().unwrap_or("The refresh didn’t finish.");
                        (Kind::Failed, format!("“{named}” didn’t refresh"), format!("{project} · {why}"))
                    };
                    found.push(Notice {
                        kind,
                        tag: tag(kind, &format!("refresh:{}:{}", refresh.project, refresh.identity)),
                        title,
                        body,
                        agent: refresh.owner.clone(),
                        summary: false,
                        covers: vec![kind],
                        event: format!("refresh:{}:{}:{slot}:{state}", refresh.project, refresh.identity),
                    });
                    reported = true;
                }
            }
        }
        // A pause the user or the owner chose asks for nothing; one that came
        // from Core says so, once.
        let intentional = matches!(refresh.paused.as_deref(), Some("paused" | "paused_by_owner" | "restored"));
        let same_pause = was.is_some_and(|was| was.paused == refresh.paused);
        if let Some(code) = refresh.paused.as_deref().filter(|_| !intentional && !same_pause) {
            // The failed run that reached the limit is already the notice.
            if !(code == "failures" && reported) {
                let why = refresh.paused_message.as_deref().unwrap_or("The refresh is paused.");
                found.push(Notice {
                    kind: Kind::Failed,
                    tag: tag(Kind::Failed, &format!("refresh-paused:{}:{}", refresh.project, refresh.identity)),
                    title: format!("“{named}” paused"),
                    body: format!("{project} · {why}"),
                    agent: refresh.owner.clone(),
                    summary: false,
                    covers: vec![Kind::Failed],
                    event: format!("refresh-paused:{}:{}:{}", refresh.project, refresh.identity, refresh.version),
                });
            }
        }
    }
    found
}

/// The notices between two reads: at most one per Agent, none for an
/// Agent new to the list, one per Ask new in Needs you, one per executor the
/// user dispatched that is new there (T-43 S4a), and one per refresh run that
/// ended (YN-113 R4). Like an Ask, an executor's opens Home, where it is; its
/// words are Core's own, never what the executor wrote. A refresh Turn's end
/// is its refresh's notice, not an Agent's.
pub fn notices(before: &Read, after: &Read) -> Vec<Notice> {
    let earlier: HashMap<&str, &AgentState> = before.agents.iter().map(|a| (a.id.as_str(), a)).collect();
    let refresh_turns: HashSet<&str> = after.refreshes.iter().filter_map(|refresh| refresh.turn.as_deref()).collect();
    let mut found: Vec<Notice> = after.agents.iter()
        .filter_map(|agent| earlier.get(agent.id.as_str()).and_then(|was| agent_notice(was, agent, &refresh_turns)))
        .collect();
    found.extend(refresh_notices(&before.refreshes, &after.refreshes));
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
            covers: vec![Kind::NeedsYou],
            event: format!("ask:{key}:{}", ask.since),
        });
    }
    let waiting: HashSet<(&str, &str)> = before.executors.iter().map(|e| (e.agent.as_str(), e.state.as_str())).collect();
    for need in after.executors.iter().filter(|e| !waiting.contains(&(e.agent.as_str(), e.state.as_str()))) {
        let (kind, title, body) = match need.state.as_str() {
            "failed" => (Kind::Failed, format!("{}: its start failed", need.name), "Open Home to see why."),
            "blocked" => (Kind::NeedsYou, format!("{} needs you", need.name), "Its task is blocked."),
            _ => (Kind::NeedsYou, format!("{} needs you", need.name), "Its result is in, waiting for your release."),
        };
        found.push(Notice {
            kind,
            tag: tag(kind, &format!("executor:{}", need.agent)),
            title,
            body: body.into(),
            agent: None,
            summary: false,
            covers: vec![kind],
            event: format!("executor:{}:{}:{}", need.agent, need.state, need.since),
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
    let (mut names, mut covers): (Vec<&str>, Vec<Kind>) = (Vec::new(), Vec::new());
    for notice in &notices {
        if !names.contains(&notice.title.as_str()) {
            names.push(&notice.title);
        }
        if !covers.contains(&notice.kind) {
            covers.push(notice.kind);
        }
    }
    vec![Notice {
        kind: notices[0].kind,
        tag: "yuzuno:summary".into(),
        title: format!("{} updates in your Workspace", notices.len()),
        body: clip(&names.join(" · "), PREVIEW_CHARS),
        agent: None,
        summary: true,
        covers,
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
        Read { agents, ..Read::default() }
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
        let before = Read { asks: vec![ask("old")], ..Read::default() };
        let after = Read { asks: vec![ask("old"), ask("new")], ..Read::default() };
        let found = notices(&before, &after);
        assert_eq!(kinds(&found), vec![(Kind::NeedsYou, "Lead asks you")]);
        assert_eq!(found[0].tag, "yuzuno:needsYou:ask:p1/new");
        assert_eq!(found[0].agent, None);
        let sent = payload(&found[0], "w1");
        assert_eq!(sent, json!({"v":1,"kind":"needsYou","workspaceId":"w1","open":"home","title":"Lead asks you",
            "body":"An Ask is waiting for your answer on Home.","tag":"yuzuno:needsYou:ask:p1/new"}));
    }

    /// T-43 S4a: an executor the user dispatched, new in Home's Needs you,
    /// is one notice that opens Home; the same need again is none, and the
    /// same state from a later time is another.
    #[test]
    fn an_executor_new_in_needs_you_is_one_notice_that_opens_home() {
        let need = |agent: &str, state: &str, since: &str| ExecutorNeed { agent: agent.into(), name: format!("YN-{agent} · Design first"), state: state.into(), since: since.into() };
        let before = Read { executors: vec![need("1", "delivering", "t1")], ..Read::default() };
        let after = Read { executors: vec![need("1", "delivering", "t1"), need("2", "delivering", "t2"), need("3", "failed", "t3"), need("4", "blocked", "t4")], ..Read::default() };
        let found = notices(&before, &after);
        assert_eq!(found.iter().map(|n| (n.kind, n.title.as_str(), n.body.as_str())).collect::<Vec<_>>(), [
            (Kind::NeedsYou, "YN-2 · Design first needs you", "Its result is in, waiting for your release."),
            (Kind::Failed, "YN-3 · Design first: its start failed", "Open Home to see why."),
            (Kind::NeedsYou, "YN-4 · Design first needs you", "Its task is blocked."),
        ]);
        assert!(found.iter().all(|n| n.agent.is_none() && n.covers == vec![n.kind]), "each opens Home");
        assert_eq!(found[0].tag, "yuzuno:needsYou:executor:2");
        assert_eq!(found[0].event, "executor:2:delivering:t2");
        // Its state changed: a need of its own; the one before is gone.
        let later = Read { executors: vec![need("1", "blocked", "t5")], ..Read::default() };
        assert_eq!(notices(&before, &later).len(), 1);
        assert!(notices(&after, &after).is_empty(), "nothing new: nothing");
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
        assert_eq!(one[0].covers, vec![Kind::NeedsYou, Kind::Finished]);
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

    fn refresh(state: Option<&str>, slot: Option<&str>, turn: Option<&str>) -> RefreshState {
        RefreshState {
            project: "p1".into(), project_name: "Digest".into(), identity: 7, key: "digest/news".into(),
            title: "Daily news".into(), enabled: true, version: 1, state: state.map(str::to_owned),
            slot: slot.map(str::to_owned), missed: 0, reason: None, paused: None, paused_message: None,
            owner: Some("a".into()), turn: turn.map(str::to_owned),
        }
    }

    /// YN-113 R4: a refresh run's end is one notice of its own, and the
    /// Agent's generic Turn end is not sent beside it; the same run read
    /// again is none; a missed run says how many it made up.
    #[test]
    fn a_refresh_run_ends_as_one_notice_not_the_turns() {
        let before = Read { agents: vec![agent("a", "working")],
            refreshes: vec![refresh(Some("sent"), Some("2026-11-14T00:00:00Z"), Some("t1"))], ..Read::default() };
        let mut after = Read { agents: vec![agent("a", "idle")],
            refreshes: vec![refresh(Some("refreshed"), Some("2026-11-14T00:00:00Z"), Some("t1"))], ..Read::default() };
        let found = notices(&before, &after);
        assert_eq!(found.len(), 1, "{found:#?}");
        assert_eq!((found[0].kind, found[0].title.as_str(), found[0].body.as_str()), (Kind::Finished, "“Daily news” refreshed", "Digest"));
        assert_eq!((found[0].tag.as_str(), found[0].agent.as_deref()), ("yuzuno:finished:refresh:p1:7", Some("a")));
        assert!(notices(&after, &after).is_empty(), "the same run again");

        after.refreshes[0].missed = 2;
        assert_eq!(notices(&before, &after)[0].body, "Digest · caught up, 2 missed");

        after.refreshes[0].state = Some("failed".into());
        after.refreshes[0].reason = Some("The Turn failed: it stopped".into());
        let failed = notices(&before, &after);
        assert_eq!(failed.len(), 1, "{failed:#?}");
        assert_eq!((failed[0].kind, failed[0].title.as_str(), failed[0].body.as_str()),
            (Kind::Failed, "“Daily news” didn’t refresh", "Digest · The Turn failed: it stopped"));

        // Running, or waiting: nothing yet.
        let running = Read { agents: vec![agent("a", "working")],
            refreshes: vec![refresh(Some("sent"), Some("2026-11-14T00:00:00Z"), Some("t1"))], ..Read::default() };
        assert!(notices(&Read::default(), &running).is_empty());
    }

    /// YN-113 R4: a pause Core made is one notice, also when the failed run
    /// that reached the limit was told of before; the user's or the owner's
    /// own pause is none.
    #[test]
    fn a_pause_core_made_is_one_notice_and_a_chosen_pause_is_none() {
        let mut before = refresh(Some("failed"), Some("2026-11-14T00:00:00Z"), Some("t1"));
        before.reason = Some("The Turn failed".into());
        let after = Read { refreshes: vec![RefreshState {
            enabled: false, version: 2, paused: Some("failures".into()),
            paused_message: Some("Paused after 3 failures in a row".into()), ..before.clone() }], ..Read::default() };
        let found = notices(&Read { refreshes: vec![before.clone()], ..Read::default() }, &after);
        assert_eq!(found.len(), 1, "{found:#?}");
        assert_eq!((found[0].kind, found[0].title.as_str(), found[0].body.as_str()),
            (Kind::Failed, "“Daily news” paused", "Digest · Paused after 3 failures in a row"));
        assert_eq!(found[0].event, "refresh-paused:p1:7:2");
        assert!(notices(&after, &after).is_empty(), "the same pause again");

        // The run and the pause found together are one notice: the run's.
        let before_run = RefreshState { state: Some("sent".into()), reason: None, ..before.clone() };
        let together = Read { refreshes: vec![RefreshState {
            state: Some("failed".into()), reason: Some("The Turn failed".into()), enabled: false, version: 2,
            paused: Some("failures".into()), ..before.clone() }], ..Read::default() };
        assert_eq!(notices(&Read { refreshes: vec![before_run], ..Read::default() }, &together).len(), 1);

        // Paused by the user or by its owner: no notice.
        for code in ["paused", "paused_by_owner", "restored"] {
            let chosen = Read { refreshes: vec![RefreshState {
                enabled: false, version: 3, paused: Some(code.into()), ..before.clone() }], ..Read::default() };
            assert!(notices(&Read { refreshes: vec![before.clone()], ..Read::default() }, &chosen).is_empty(), "{code}");
        }
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
