//! A Codex Agent's collaboration mode (T-29): Codex's own Plan and Default
//! modes of the Agent's thread, which the Codex CLI's `/plan` switches. In
//! Codex 0.162.1 both methods are experimental (`collaborationMode/list`,
//! and `thread/settings/update` with `collaborationMode`); Yuzuno opts in to
//! experimental methods when it initializes a connection. Another Codex may
//! lack them or behave differently, so each connection is asked and nothing
//! is assumed.
//!
//! The mode shown is only what Codex reported on the Agent's current
//! connection: `collaborationMode` in its `thread/resume` answer, or its
//! `thread/settings/updated` notification. It is kept in memory for that
//! connection and forgotten with it. Reading lists Codex's modes on that
//! connection and changes nothing; nothing is connected or resumed for it.
//!
//! A switch is the user's own and happens between turns, as Codex's CLI
//! allows it. It changes the mode only:
//! - The model and effort sent with it are the ones Yuzuno sends with every
//!   turn. Codex's Plan preset would also set medium effort; that is not
//!   taken.
//! - Its instructions are Codex's built-in ones for the mode
//!   (`developer_instructions: null`). Codex adds them to the thread's own;
//!   Yuzuno adds nothing.
//!
//! Codex's empty answer only accepts the update; the mode is confirmed by
//! Codex's next settings report. Nothing is retried and no turn is started:
//! planning begins with the user's next message, and leaving Plan mode never
//! asks Codex to implement the plan.
use crate::{model::now, rpc::{Rpc, RpcError}, server::ApiError, workspace::{same_generation, Workspace}};
use anyhow::{anyhow, bail, ensure, Context, Result};
use axum::{
    extract::{Path, State as ApiState},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex}, time::Duration};

/// How long listing the modes may take. Codex's CLI gives it 2 s.
const LIST_WITHIN: Duration = Duration::from_secs(10);
const MAX_MODE: usize = 40;

/// The two of Codex's `ModeKind`s that its CLI switches between.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Plan,
    Default,
}

impl Mode {
    fn wire(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Default => "default",
        }
    }

    fn of(word: &str) -> Option<Self> {
        match word {
            "plan" => Some(Self::Plan),
            "default" => Some(Self::Default),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Plan => "Plan 模式",
            Self::Default => "Default 模式",
        }
    }
}

/// The mode as Codex last reported it on this connection. A mode other than
/// plan or default (a later Codex's) is kept as Codex said it.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reported {
    mode: String,
    /// resume (its `thread/resume` answer) or settings (`thread/settings/updated`).
    source: &'static str,
    observed_at: String,
}

/// The user's switch, until Codex reports the mode it asked for.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Switch {
    to: Mode,
    /// sending: not answered yet. accepted: Codex accepted the update and has
    /// not reported the mode since. unknown: no answer came back, or the
    /// request asking for it went away first (`Abandoned`).
    state: &'static str,
    requested_at: String,
    #[serde(skip)]
    token: u64,
}

#[derive(Default)]
struct Observed {
    generation: u64,
    reported: Option<Reported>,
    switch: Option<Switch>,
}

/// Per Agent: what its current connection's Codex reported of the mode,
/// and the user's switch that Codex has not reported yet.
#[derive(Default)]
pub(crate) struct State {
    agents: Mutex<HashMap<String, Observed>>,
    next: AtomicU64,
}

fn clip(word: &str) -> String {
    word.chars().map(|c| if c.is_control() { ' ' } else { c }).take(MAX_MODE).collect()
}

impl State {
    /// What connection `generation` observed. A newer connection starts
    /// afresh; an older one's report, arriving late, is not this one's.
    fn of<'a>(agents: &'a mut HashMap<String, Observed>, id: &str, generation: u64) -> Option<&'a mut Observed> {
        let observed = agents.entry(id.to_owned()).or_default();
        if generation < observed.generation {
            return None;
        }
        if observed.generation != generation {
            *observed = Observed { generation, ..Default::default() };
        }
        Some(observed)
    }

    /// Codex's report of the thread's mode on connection `generation`: a
    /// `CollaborationMode`, or null from a Codex that reports none. A report
    /// of the mode a switch asked for settles that switch. Returns whether
    /// anything was recorded.
    pub(crate) fn report(&self, id: &str, generation: u64, mode: &Value, source: &'static str) -> bool {
        let Some(word) = mode["mode"].as_str().filter(|w| !w.is_empty()) else { return false };
        let word = clip(word);
        let mut agents = self.agents.lock().unwrap();
        let Some(observed) = Self::of(&mut agents, id, generation) else { return false };
        if observed.switch.as_ref().is_some_and(|s| s.to.wire() == word) {
            observed.switch = None;
        }
        observed.reported = Some(Reported { mode: word, source, observed_at: now() });
        true
    }

    /// A switch the user asked for, recorded before it is sent. Its token
    /// identifies it to `answered`.
    fn begin(&self, id: &str, generation: u64, to: Mode) -> Option<u64> {
        let token = self.next.fetch_add(1, Ordering::Relaxed);
        let mut agents = self.agents.lock().unwrap();
        let observed = Self::of(&mut agents, id, generation)?;
        observed.switch = Some(Switch { to, state: "sending", requested_at: now(), token });
        Some(token)
    }

    /// Codex's answer to switch `token`: `Some(state)` if it stays
    /// (accepted, or unknown when no answer came back), or `None` when
    /// Codex refused it and nothing changed. A report of the new mode may
    /// already have settled it; then nothing is left to answer.
    fn answered(&self, id: &str, generation: u64, token: u64, outcome: Option<&'static str>) {
        let mut agents = self.agents.lock().unwrap();
        let Some(observed) = agents.get_mut(id).filter(|o| o.generation == generation) else { return };
        if !observed.switch.as_ref().is_some_and(|s| s.token == token) {
            return;
        }
        match outcome {
            Some(state) => observed.switch.as_mut().unwrap().state = state,
            None => observed.switch = None,
        }
    }

    /// The Agent's connection was replaced or ended: what it reported goes.
    pub(crate) fn forget(&self, id: &str) {
        self.agents.lock().unwrap().remove(id);
    }

    fn shown(&self, id: &str, generation: u64) -> (Option<Reported>, Option<Switch>) {
        let agents = self.agents.lock().unwrap();
        agents.get(id).filter(|o| o.generation == generation)
            .map_or((None, None), |o| (o.reported.clone(), o.switch.clone()))
    }
}

/// The mode as the Agent's detail carries it, for the composer: only what
/// its live connection's Codex reported, and a switch not yet reported.
pub fn shown(ws: &Workspace, id: &str) -> Option<Value> {
    let (generation, _) = ws.codex_connection(id)?;
    let (reported, switch) = ws.codex_plan.shown(id, generation);
    (reported.is_some() || switch.is_some()).then(|| json!({"generation":generation,"reported":reported,"switch":switch}))
}

/// The /plan dialog's read.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// ready, unavailable, unsupported or failed.
    state: &'static str,
    reason: String,
    generation: Option<u64>,
    /// The modes this connection's Codex lists, of the two its CLI switches.
    modes: Vec<Mode>,
    reported: Option<Reported>,
    switch: Option<Switch>,
}

impl View {
    fn not(state: &'static str, reason: &str) -> Self {
        Self { state, reason: reason.into(), generation: None, modes: vec![], reported: None, switch: None }
    }
}

/// What the user asks: switch the thread to `mode`, on connection
/// `generation`, the one whose state the dialog showed.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    mode: Mode,
    generation: u64,
}

/// The modes Codex lists, of plan and default; its presets' model and
/// effort are not used.
async fn list(rpc: &Rpc) -> Result<Vec<Mode>> {
    let response = rpc.request_within("collaborationMode/list", json!({}), LIST_WITHIN).await?;
    let presets = response["data"].as_array().context("Codex returned an invalid mode list")?;
    let mut modes = vec![];
    for mode in presets.iter().filter_map(|preset| preset["mode"].as_str().and_then(Mode::of)) {
        if !modes.contains(&mode) {
            modes.push(mode);
        }
    }
    Ok(modes)
}

impl Workspace {
    /// This Codex Agent's mode as its current connection reported it, and
    /// the modes that connection's Codex lists. Nothing is connected,
    /// resumed or changed for this.
    pub async fn codex_plan(self: &Arc<Self>, id: &str) -> Result<View> {
        // The Agent as listed, never its history (T-140).
        let agent = self.listed(id).await?;
        if agent.harness != "codex" {
            return Ok(View::not("unsupported", "harness"));
        }
        if agent.closed_at.is_some() {
            return Ok(View::not("unavailable", "closed"));
        }
        if agent.thread_id.is_none() {
            return Ok(View::not("unavailable", "no_thread"));
        }
        let connection = self.rpcs.lock().unwrap().get(id).cloned()
            .filter(|c| !c.closing && agent.connection_state == "connected");
        let Some(connection) = connection else {
            return Ok(View::not("unavailable", "not_connected"));
        };
        let listed = list(&connection.rpc).await;
        let (reported, switch) = self.codex_plan.shown(id, connection.generation);
        let (state, reason, modes) = match listed {
            Ok(modes) => ("ready", "listed".to_owned(), modes),
            Err(error) => match error.downcast_ref::<RpcError>() {
                Some(refused) if refused.code == -32601 => ("unsupported", "old_protocol".to_owned(), vec![]),
                Some(refused) => ("failed", refused.message.clone(), vec![]),
                None => ("failed", error.to_string(), vec![]),
            },
        };
        Ok(View { state, reason, generation: Some(connection.generation), modes, reported, switch })
    }

    /// The user's switch of this Codex Agent's mode. As `/compact`, only
    /// between turns, on the connection already serving the thread (see
    /// `idle_codex_thread`), and only on the connection whose mode the
    /// user saw. A refusal is Codex's own: its handler rejects the update
    /// before submitting it (0.162.1), so nothing changed. A lost answer is
    /// left unknown, to be read again, and never sent again.
    pub async fn codex_plan_switch(self: &Arc<Self>, id: &str, change: Change) -> Result<View> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let (detail, thread, connection) = self.idle_codex_thread(id, "/plan").await?;
        let generation = connection.generation;
        ensure!(generation == change.generation, "连接已变化；请重新打开 /plan 查看这次连接上 Codex 报告的模式，模式没有改变");
        let to = change.mode;
        // What Yuzuno sends with every turn: the switch changes neither.
        let model = detail.agent.model.clone();
        ensure!(!model.is_empty(), "这个会话的模型尚未确认；请先重新连接，模式没有改变");
        let modes = list(&connection.rpc).await.map_err(|error| match error.downcast_ref::<RpcError>() {
            Some(refused) if refused.code == -32601 => anyhow!("这台机器上的 Codex 不提供协作模式（collaborationMode/list）；模式没有改变"),
            Some(refused) => anyhow!("Codex 没有列出协作模式：{}；模式没有改变", refused.message),
            None => anyhow!("Codex 没有列出协作模式：{error}；模式没有改变"),
        })?;
        ensure!(modes.contains(&to), "这台机器上的 Codex 没有列出{}；模式没有改变", to.label());
        let token = self.codex_plan.begin(id, generation, to).context("连接已变化；模式没有改变")?;
        self.changed(id);
        let mode = json!({"mode":to.wire(),"settings":{"model":model,
            "reasoning_effort":detail.agent.settings.reasoning_effort,"developer_instructions":null}});
        let mut abandoned = Abandoned { ws: self, id, generation, token, armed: true };
        let result = connection.rpc.request("thread/settings/update", json!({"threadId":thread,"collaborationMode":mode})).await;
        abandoned.armed = false;
        let refused = result.as_ref().err().and_then(|error| error.downcast_ref::<RpcError>()).cloned();
        let outcome = match (&result, &refused) {
            (Ok(_), _) => Some("accepted"),
            (Err(_), Some(_)) => None,
            (Err(_), None) => Some("unknown"),
        };
        self.codex_plan.answered(id, generation, token, outcome);
        self.changed(id);
        if let Err(error) = result {
            bail!(match refused {
                Some(refused) if refused.code == -32601 => "这台机器上的 Codex 不提供协作模式切换（thread/settings/update）；模式没有改变".to_owned(),
                Some(refused) => format!("Codex 拒绝了切换到{}：{}；模式没有改变", to.label(), refused.message),
                None => format!("切换到{}的结果无法确认：{error}；请重新打开 /plan 查看 Codex 报告的模式，不要重复", to.label()),
            });
        }
        ensure!(same_generation(self.rpcs.lock().unwrap().get(id), generation),
            "Codex 接受了切换到{}，但连接随后已变化；请重新打开 /plan 查看 Codex 报告的模式，不要重复", to.label());
        let (reported, switch) = self.codex_plan.shown(id, generation);
        Ok(View { state: "ready", reason: "switched".into(), generation: Some(generation), modes, reported, switch })
    }
}

/// A switch whose request is dropped before Codex answers (the HTTP request
/// that asked for it went away mid-wait): it was sent, or may have been, so
/// it is left unknown rather than sending forever. Codex's report of the
/// mode still settles it.
struct Abandoned<'a> {
    ws: &'a Workspace,
    id: &'a str,
    generation: u64,
    token: u64,
    armed: bool,
}

impl Drop for Abandoned<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.ws.codex_plan.answered(self.id, self.generation, self.token, Some("unknown"));
            self.ws.changed(self.id);
        }
    }
}

async fn read_route(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.codex_plan(&id).await?))
}

async fn switch_route(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>, Json(change): Json<Change>) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.codex_plan_switch(&id, change).await?))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/agents/{id}/codex/plan", get(read_route).post(switch_route))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> Value {
        json!({"mode":"plan","settings":{"model":"m","reasoning_effort":null,"developer_instructions":null}})
    }

    #[test]
    fn a_report_belongs_to_its_own_connection_and_settles_only_the_switch_it_confirms() {
        let state = State::default();
        assert!(!state.report("a", 3, &Value::Null, "resume"), "a Codex that reports no mode leaves it unknown");
        assert_eq!(state.shown("a", 3), (None, None));
        assert!(state.report("a", 3, &json!({"mode":"default","settings":{}}), "resume"));
        assert_eq!(state.shown("a", 3).0.unwrap().mode, "default");
        // A switch stays until Codex reports the mode it asked for.
        let token = state.begin("a", 3, Mode::Plan).unwrap();
        state.answered("a", 3, token, Some("accepted"));
        assert_eq!(state.shown("a", 3).1.as_ref().map(|s| (s.to, s.state)), Some((Mode::Plan, "accepted")));
        state.report("a", 3, &json!({"mode":"default"}), "settings");
        assert!(state.shown("a", 3).1.is_some(), "another report does not settle it");
        state.report("a", 3, &plan(), "settings");
        let (reported, switch) = state.shown("a", 3);
        assert_eq!((reported.unwrap().source, switch), ("settings", None));
        // Codex reported the new mode before its answer came back: the
        // answer finds nothing left to settle.
        let token = state.begin("a", 3, Mode::Default).unwrap();
        state.report("a", 3, &json!({"mode":"default"}), "settings");
        state.answered("a", 3, token, Some("accepted"));
        assert_eq!(state.shown("a", 3).1, None);
        // A refusal changed nothing: the switch goes. A lost answer stays unknown.
        let token = state.begin("a", 3, Mode::Plan).unwrap();
        state.answered("a", 3, token, None);
        assert_eq!((state.shown("a", 3).0.unwrap().mode.as_str(), state.shown("a", 3).1), ("default", None));
        let token = state.begin("a", 3, Mode::Plan).unwrap();
        state.answered("a", 3, token, Some("unknown"));
        assert_eq!(state.shown("a", 3).1.unwrap().state, "unknown");
        // A newer connection starts afresh; the older one's late report and
        // late answer are not mixed in.
        assert!(state.report("a", 4, &plan(), "resume"));
        assert!(!state.report("a", 3, &json!({"mode":"default"}), "settings"));
        state.answered("a", 3, token, Some("accepted"));
        let (reported, switch) = state.shown("a", 4);
        assert_eq!((reported.unwrap().mode.as_str(), switch), ("plan", None));
        assert_eq!(state.shown("a", 3), (None, None));
        assert!(state.begin("a", 3, Mode::Default).is_none(), "nothing begins on an old connection");
        state.forget("a");
        assert_eq!(state.shown("a", 4), (None, None));
        // A later Codex's own mode is shown as it said it, clipped.
        state.report("b", 1, &json!({"mode":format!("review\u{7}{}", "x".repeat(80))}), "settings");
        assert_eq!(state.shown("b", 1).0.unwrap().mode, format!("review {}", "x".repeat(MAX_MODE - 7)));
    }

    #[test]
    fn only_plan_or_default_on_a_named_connection_is_read_as_a_switch() {
        let read = |v: Value| serde_json::from_value::<Change>(v);
        assert_eq!(read(json!({"mode":"plan","generation":2})).unwrap(), Change { mode: Mode::Plan, generation: 2 });
        assert_eq!(read(json!({"mode":"default","generation":2})).unwrap(), Change { mode: Mode::Default, generation: 2 });
        for wrong in [json!({"mode":"plan"}), json!({"mode":"review","generation":2}), json!({"mode":"Plan","generation":2}),
                      json!({"mode":"plan","generation":2,"model":"other"}), json!({"mode":"plan","generation":2,"developerInstructions":"x"})] {
            assert!(read(wrong.clone()).is_err(), "{wrong}");
        }
    }
}
