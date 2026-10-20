//! Read-only account facts from the Agent's own native connection. No catalog
//! fallback, credential reads, thread reads, durable history or quota enforcement.
use crate::{model::Agent, rpc::RpcError, workspace::Workspace};
use anyhow::Result;
use axum::{
    extract::{Path, State as AxumState},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const COOLDOWN: Duration = Duration::from_secs(5);
const CACHE_AGE: Duration = Duration::from_secs(60);

#[derive(Default)]
pub(crate) struct State(Mutex<HashMap<String, Arc<Slot>>>);
#[derive(Default)]
struct Slot {
    read: tokio::sync::Mutex<()>,
    state: Mutex<Snapshot>,
}
#[derive(Default)]
struct Snapshot {
    generation: u64,
    epoch: u64,
    revision: u64,
    checked: Option<Instant>,
    value: Value,
}
impl State {
    fn slot(&self, id: &str) -> Arc<Slot> {
        self.0.lock().unwrap().entry(id.into()).or_default().clone()
    }
    fn existing(&self, id: &str) -> Option<Arc<Slot>> {
        self.0.lock().unwrap().get(id).cloned()
    }
}
impl Snapshot {
    fn reset(&mut self, generation: u64, source: Value, status: &str) {
        self.generation = generation;
        self.epoch += 1;
        self.checked = None;
        self.value = json!({"status":status,"source":source,"account":null,"accountId":null,
            "buckets":[],"observedAt":null,"checkedAt":null,"error":null,"ordinaryUsageAllowed":null});
        self.bump();
    }
    fn bump(&mut self) {
        self.revision += 1;
        self.value["revision"] = self.revision.into();
    }
}

fn source(agent: &Agent, generation: u64) -> Value {
    json!({"generation":generation.to_string(), "machineId":agent.remote.as_ref().map(|r| &r.machine.id),
        "label":agent.remote.as_ref().map(|r| r.machine.name.as_str()).unwrap_or("Core host"),
        "runtimeId":agent.remote.as_ref().and_then(|r| r.runtime.as_ref()).map(|r| &r.instance_id),
        "kind":"agent_connection"})
}
fn text(v: &Value) -> Value {
    v.as_str()
        .filter(|s| !s.is_empty())
        .map(|s| Value::String(s.chars().take(256).collect()))
        .unwrap_or(Value::Null)
}
fn window(v: &Value, at: &str) -> Value {
    if !v.is_object() {
        return Value::Null;
    }
    json!({"usedPercent":v["usedPercent"].as_f64().filter(|n| n.is_finite() && *n >= 0.0),
        "windowDurationMins":v["windowDurationMins"].as_i64().filter(|n| *n > 0),
        "resetsAt":v["resetsAt"].as_i64().filter(|n| *n > 0),"observedAt":at})
}
fn bucket(v: &Value, id: &str, at: &str) -> Value {
    let credits = &v["credits"];
    json!({"limitId":id,"limitName":text(&v["limitName"]),"planType":text(&v["planType"]),
        "primary":window(&v["primary"], at),"secondary":window(&v["secondary"], at),
        "credits":if credits.is_object() {json!({"hasCredits":credits["hasCredits"].as_bool(),
            "unlimited":credits["unlimited"].as_bool(),"balance":text(&credits["balance"])})} else {Value::Null},
        "observedAt":at})
}
fn buckets(v: &Value, at: &str) -> Vec<Value> {
    if let Some(map) = v["rateLimitsByLimitId"]
        .as_object()
        .filter(|m| !m.is_empty())
    {
        return map
            .iter()
            .take(64)
            .filter(|(_, b)| b.is_object())
            .map(|(id, b)| bucket(b, id, at))
            .collect();
    }
    let b = &v["rateLimits"];
    if b.is_object() {
        vec![bucket(b, b["limitId"].as_str().unwrap_or("codex"), at)]
    } else {
        vec![]
    }
}
fn rolling(state: &mut Snapshot, params: &Value) -> bool {
    // Notifications have no accountId. Only a prior read on this same native
    // generation/auth epoch can establish their account provenance.
    if state.value["account"]["type"] != "chatgpt" || state.value["status"] != "ready" {
        return false;
    }
    let incoming = &params["rateLimits"];
    let Some(id) = incoming["limitId"].as_str().filter(|s| !s.is_empty()) else {
        return false;
    };
    let at = crate::model::now();
    let next = bucket(incoming, id, &at);
    let list = state.value["buckets"].as_array_mut().unwrap();
    if let Some(old) = list.iter_mut().find(|b| b["limitId"] == id) {
        // Nullable rolling metadata is not a deletion. Replace each reported
        // window whole, so a new percentage never borrows an old reset time.
        for key in ["limitName", "planType", "primary", "secondary"] {
            if !next[key].is_null() {
                old[key] = next[key].clone();
            }
        }
        if next["credits"].is_object() {
            if !old["credits"].is_object() {
                old["credits"] = json!({});
            }
            for key in ["hasCredits", "unlimited", "balance"] {
                if !next["credits"][key].is_null() {
                    old["credits"][key] = next["credits"][key].clone();
                }
            }
        }
        old["observedAt"] = at.clone().into();
    } else if list.len() < 64 {
        list.push(next);
    }
    state.value["observedAt"] = at.into();
    state.value["ordinaryUsageAllowed"] = Value::Null;
    state.bump();
    true
}

impl Workspace {
    fn publish_codex_usage(&self, id: &str, value: &Value) {
        self.changes
            .publish(&json!({"type":"agent.codexUsage","agentId":id,"usage":value}));
    }

    /// Called under the connection owner lock; never waits for native I/O.
    pub(crate) fn codex_usage_event(&self, id: &str, generation: u64, message: &Value) -> bool {
        let method = message["method"].as_str().unwrap_or("");
        if !matches!(
            method,
            "account/updated" | "account/rateLimits/updated" | "yuzuno/disconnected"
        ) {
            return false;
        }
        if let Some(slot) = self.codex_usage.existing(id) {
            let mut state = slot.state.lock().unwrap();
            if state.generation == generation {
                let changed = if method == "account/rateLimits/updated" {
                    rolling(&mut state, &message["params"])
                } else {
                    let source = state.value["source"].clone();
                    state.reset(
                        generation,
                        source,
                        if method == "yuzuno/disconnected" {
                            "disconnected"
                        } else {
                            "unknown"
                        },
                    );
                    true
                };
                if changed {
                    self.publish_codex_usage(id, &state.value);
                }
            }
        }
        method != "yuzuno/disconnected" && message.get("id").is_none()
    }

    pub(crate) async fn codex_usage_reconnected(self: &Arc<Self>, id: &str, generation: u64) {
        if let Some(slot) = self.codex_usage.existing(id) {
            // connect has already stored runtime/located. Read its compact
            // Agent metadata while the caller holds connection ownership.
            let key = id.to_owned();
            let located = self.stored(move |s| s.agent(&key)).await;
            let source = located
                .as_ref()
                .map(|a| source(a, generation))
                .unwrap_or_else(|_| {
                    json!({"generation":generation.to_string(),"label":"Unknown source",
                    "machineId":null,"runtimeId":null,"kind":"agent_connection"})
                });
            let mut state = slot.state.lock().unwrap();
            state.reset(generation, source, "unknown");
            self.publish_codex_usage(id, &state.value);
        }
    }

    pub(crate) async fn read_codex_usage(
        self: &Arc<Self>,
        id: &str,
        refresh: bool,
    ) -> Result<Value> {
        let key = id.to_owned();
        let agent = self.stored(move |s| s.agent(&key)).await?;
        anyhow::ensure!(
            agent.harness == "codex",
            "Plan usage requires a Codex Agent"
        );
        let slot = self.codex_usage.slot(id);
        let _reading = slot.read.lock().await;
        let connection = self
            .rpcs
            .lock()
            .unwrap()
            .get(id)
            .filter(|c| !c.closing)
            .cloned();
        let Some(connection) = connection.filter(|_| agent.closed_at.is_none()) else {
            let mut state = slot.state.lock().unwrap();
            state.reset(0, source(&agent, 0), "disconnected");
            return Ok(state.value.clone());
        };
        let (epoch, revision) = {
            let mut state = slot.state.lock().unwrap();
            if state.generation != connection.generation || state.value.is_null() {
                state.reset(
                    connection.generation,
                    source(&agent, connection.generation),
                    "unknown",
                );
            }
            if state
                .checked
                .is_some_and(|at| at.elapsed() < if refresh { COOLDOWN } else { CACHE_AGE })
            {
                return Ok(state.value.clone());
            }
            (state.epoch, state.revision)
        };
        let result: Result<(Value, Result<Option<Value>>)> = async {
            let a = connection.rpc.request_within("account/read", json!({"refreshToken":false}), Duration::from_secs(10)).await?;
            let a = &a["account"];
            let account = if a.is_object() { json!({"type":text(&a["type"]),"label":text(&a["email"]),"planType":text(&a["planType"])}) } else {Value::Null};
            let limits = if a["type"] == "chatgpt" {
                connection.rpc.request_within("account/rateLimits/read", Value::Null, Duration::from_secs(10)).await.map(Some)
            } else {Ok(None)};
            Ok((account, limits))
        }.await;
        let _owned = self.owner(id).await;
        let current = self
            .rpcs
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|c| c.generation == connection.generation && !c.closing);
        let mut state = slot.state.lock().unwrap();
        // Closing can precede the disconnect event. Clear this generation's
        // cache immediately, but never clear a replacement connection's facts.
        if !current && state.generation == connection.generation {
            state.reset(0, source(&agent, 0), "disconnected");
            self.publish_codex_usage(id, &state.value);
        }
        // An old connection/auth epoch must not throttle the new source.
        if !current || state.generation != connection.generation || state.epoch != epoch {
            return Ok(state.value.clone());
        }
        state.checked = Some(Instant::now());
        let at = crate::model::now();
        state.value["checkedAt"] = at.clone().into();
        // A newer rolling report wins over this response, including an error,
        // but the completed read still counts toward request throttling.
        if state.revision != revision {
            state.bump();
            self.publish_codex_usage(id, &state.value);
            return Ok(state.value.clone());
        }
        let limits = result.and_then(|(account, limits)| {
            if state.value["account"] != account {
                state.value["buckets"] = json!([]);
                state.value["accountId"] = Value::Null;
                state.value["observedAt"] = Value::Null;
            }
            state.value["account"] = account;
            limits
        });
        match limits {
            Ok(limits) => {
                state.value["accountId"] = limits
                    .as_ref()
                    .map(|v| text(&v["accountId"]))
                    .unwrap_or(Value::Null);
                state.value["buckets"] = limits
                    .as_ref()
                    .map(|v| json!(buckets(v, &at)))
                    .unwrap_or(json!([]));
                state.value["ordinaryUsageAllowed"] = limits
                    .as_ref()
                    .and_then(|v| v["ordinaryUsageAllowed"].as_bool())
                    .into();
                state.value["observedAt"] = at.into();
                state.value["error"] = Value::Null;
                state.value["status"] = if limits.is_some() {
                    "ready"
                } else {
                    "unavailable"
                }
                .into();
            }
            Err(error) => {
                state.value["ordinaryUsageAllowed"] = Value::Null;
                let unsupported = error
                    .downcast_ref::<RpcError>()
                    .is_some_and(|e| e.code == -32601);
                state.value["status"] = if unsupported { "unsupported" } else { "error" }.into();
                // Native errors can contain account/server diagnostics: expose
                // a safe explanation, retain the dated previous observation.
                state.value["error"] = if unsupported {"This Codex version does not provide account usage."}
                    else {"Could not refresh from this native connection. Previous observations may be outdated."}.into();
            }
        }
        state.bump();
        self.publish_codex_usage(id, &state.value);
        Ok(state.value.clone())
    }
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/agents/{id}/codex/usage", get(read).post(refresh))
}
async fn read(
    AxumState(ws): AxumState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> std::result::Result<Json<Value>, crate::server::ApiError> {
    Ok(Json(ws.read_codex_usage(&id, false).await?))
}
async fn refresh(
    AxumState(ws): AxumState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> std::result::Result<Json<Value>, crate::server::ApiError> {
    Ok(Json(ws.read_codex_usage(&id, true).await?))
}

#[cfg(test)]
mod tests;
