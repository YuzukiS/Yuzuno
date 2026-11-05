//! Logging an OpenCode Agent in to a provider (T-32 slice 4b: the user's
//! decision 4142, Lead 5358 and 5656), through that Agent's own OpenCode,
//! whose database is the only place a key or token is kept. A key, or a
//! method's form answers, pass through Core in memory to that OpenCode once.
//! Core writes none of it anywhere: its journal keeps the integration,
//! method and label only, it logs nothing of them, and a refusal says its
//! status and kind, never what OpenCode answered (`Server::login`). Core
//! never reads a credential back (`GET /api/credential` answers them).
//!
//! Only the user's own browser, on Core's own port, reaches these routes
//! (`router`, mounted inside `local_browser_boundary` only): no Agent tool
//! does, and a phone's entry does not serve them.
//!
//! Logging in needs the Agent connected (D9: Core starts nothing for it)
//! and its OpenCode at LOGIN_MIN or newer (D4). It is allowed while a Turn
//! runs (D10): OpenCode uses the active credential from its next model
//! call. Keys and device or code sign-ins only (D5): a sign-in whose page
//! sends the browser back to a loopback address is cancelled before its link
//! is shown (D7). A method's form is shown when its fields are all text or
//! choice ones (D8).
use crate::{opencode::LoginRefused, server::ApiError, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
use axum::{
    extract::{Path, State as ApiState},
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

const NOT_CONNECTED: &str = "OpenCode Agent 尚未连接；连接后才能登录";

/// What the login section shows: ready, unavailable (closed or not
/// connected), update (older than LOGIN_MIN) or failed.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    state: &'static str,
    reason: Option<String>,
    version: Option<String>,
    integrations: Vec<Integration>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Integration {
    id: String,
    name: String,
    methods: Vec<LoginMethod>,
    connections: Vec<Connection>,
}

/// One way to log in, as Yuzuno offers it: `key`, `oauth`, `env` (read
/// only, by variable name) or `elsewhere` (sign in from OpenCode itself).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LoginMethod {
    kind: &'static str,
    id: Option<String>,
    label: String,
    fields: Vec<Field>,
    names: Vec<String>,
}

/// A field of a method's form: a choice (it lists options) or text.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Field {
    key: String,
    title: String,
    description: String,
    required: bool,
    placeholder: String,
    default: Option<String>,
    options: Vec<Choice>,
    when: Vec<Value>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Choice {
    value: String,
    label: String,
    description: String,
}

/// A login OpenCode holds: a credential (which can be logged out) or an
/// environment variable it reads. Never its value.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Connection {
    kind: &'static str,
    id: Option<String>,
    label: String,
    method: Option<String>,
    needs_auth: Option<String>,
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().chars().filter(|c| !c.is_control()).take(300).collect()
}

/// A form's fields, when every one is a text or choice field (a `string`
/// one, with options or not); None when one is of another kind. Hidden ones
/// keep their default and are not shown.
fn fields(form: &Value) -> Option<Vec<Field>> {
    let Some(form) = form.as_array() else { return Some(vec![]) };
    let mut out = Vec::new();
    for field in form {
        if field["type"] != "string" || !field["key"].is_string() {
            return None;
        }
        if field["hidden"] == true {
            continue;
        }
        let when: Vec<Value> = field["when"].as_array().cloned().unwrap_or_default();
        if when.iter().any(|w| !w["key"].is_string() || !matches!(w["op"].as_str(), Some("eq" | "neq")) || !w["value"].is_string()) {
            return None;
        }
        out.push(Field {
            key: text(&field["key"]),
            title: text(&field["title"]),
            description: text(&field["description"]),
            required: field["required"] == true,
            placeholder: text(&field["placeholder"]),
            default: field["default"].as_str().map(str::to_owned),
            options: field["options"].as_array().into_iter().flatten().filter_map(|o| Some(Choice {
                value: o["value"].as_str()?.to_owned(), label: text(&o["label"]), description: text(&o["description"]),
            })).collect(),
            when,
        });
    }
    Some(out)
}

/// An integration as the login section shows it, from named fields only:
/// its `metadata` is never passed on.
fn integration(listed: &Value) -> Option<Integration> {
    let id = listed["id"].as_str()?.to_owned();
    let methods = listed["methods"].as_array().into_iter().flatten().map(|m| {
        let label = text(&m["label"]);
        let elsewhere = |label: String| LoginMethod { kind: "elsewhere", id: m["id"].as_str().map(str::to_owned), label, fields: vec![], names: vec![] };
        match (m["type"].as_str(), fields(&m["form"])) {
            (Some("key"), Some(fields)) => LoginMethod { kind: "key", id: None, label, fields, names: vec![] },
            (Some("oauth"), Some(fields)) if m["id"].is_string() =>
                LoginMethod { kind: "oauth", id: m["id"].as_str().map(str::to_owned), label, fields, names: vec![] },
            (Some("env"), _) => LoginMethod { kind: "env", id: None, label, fields: vec![],
                names: m["names"].as_array().into_iter().flatten().map(text).collect() },
            _ => elsewhere(label),
        }
    }).collect();
    let connections = listed["connections"].as_array().into_iter().flatten().filter_map(|c| {
        let needs_auth = (c["status"]["status"] == "needs_auth").then(|| text(&c["status"]["message"]));
        match c["type"].as_str()? {
            "credential" => Some(Connection { kind: "credential", id: Some(c["id"].as_str()?.to_owned()), label: text(&c["label"]),
                method: c["method"].as_str().map(str::to_owned), needs_auth }),
            "env" => Some(Connection { kind: "env", id: None, label: text(&c["name"]), method: None, needs_auth }),
            _ => None,
        }
    }).collect();
    Some(Integration { id, name: text(&listed["name"]), methods, connections })
}

/// Whether a sign-in's link sends the browser back to this computer (D7):
/// the link's own host, or its `redirect_uri`'s, is a loopback address.
pub fn loopback(link: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(link) else { return false };
    let local = |url: &reqwest::Url| {
        let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
        host == "localhost" || host.ends_with(".localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
    };
    local(&url) || url.query_pairs().any(|(name, value)| name == "redirect_uri" && reqwest::Url::parse(&value).is_ok_and(|r| local(&r)))
}

/// A login request's error for the user: OpenCode's status and kind for a
/// refusal, never its answer; anything else as it is (none carries a key).
fn refused(error: anyhow::Error) -> anyhow::Error {
    match error.downcast_ref::<LoginRefused>() {
        Some(refusal) => anyhow::anyhow!("OpenCode 拒绝了登录（HTTP {}{}）", refusal.code,
            refusal.kind.as_deref().map(|kind| format!("，{kind}")).unwrap_or_default()),
        None => error,
    }
}

impl Workspace {
    /// The Agent's connection, when it can log in: open, connected, and its
    /// OpenCode at LOGIN_MIN or newer.
    fn login_connection(&self, id: &str, agent: &crate::model::Agent) -> Result<(Arc<crate::opencode::Server>, u64)> {
        ensure!(agent.harness == "opencode", "Agent 不是 OpenCode");
        crate::model::ensure_agent_open(agent)?;
        let c = self.opencodes.lock().unwrap().get(id).cloned().context(NOT_CONNECTED)?;
        let version = c.server.version();
        ensure!(crate::opencode::login_supported(version), "{}", crate::opencode::login_update_note(version));
        Ok((c.server.clone(), c.generation))
    }

    /// Whether the connection a login request went through is still the Agent's.
    fn login_still(&self, id: &str, generation: u64) -> Result<()> {
        let current = self.opencodes.lock().unwrap().get(id).map(|c| c.generation);
        ensure!(current == Some(generation), "OpenCode 连接已变化；请重新打开登录");
        Ok(())
    }

    /// What the Agent's OpenCode offers to log in to, and holds.
    pub async fn opencode_logins(&self, id: &str) -> Result<View> {
        let _permit = self.admission.enter_work()?;
        let agent = self.listed(id).await?;
        ensure!(agent.harness == "opencode", "Agent 不是 OpenCode");
        let not = |state, reason: &str, version: Option<&str>| View { state, reason: Some(reason.to_owned()), version: version.map(str::to_owned), integrations: vec![] };
        if agent.closed_at.is_some() {
            return Ok(not("unavailable", "closed", None));
        }
        let Some(c) = self.opencodes.lock().unwrap().get(id).cloned() else {
            return Ok(not("unavailable", "disconnected", None));
        };
        let version = c.server.version().to_owned();
        if !crate::opencode::login_supported(&version) {
            return Ok(not("update", &crate::opencode::login_update_note(&version), Some(&version)));
        }
        let Ok(listed) = c.server.integrations().await else {
            return Ok(not("failed", "read_failed", Some(&version)));
        };
        if self.login_still(id, c.generation).is_err() {
            return Ok(not("unavailable", "changed", Some(&version)));
        }
        Ok(View { state: "ready", reason: None, version: Some(version), integrations: listed.iter().filter_map(integration).collect() })
    }

    /// Logs the Agent in to `integration` with `key`. The key and the form's
    /// answer go to its OpenCode only; the journal keeps which integration
    /// and label.
    pub async fn opencode_login_key(&self, id: &str, request: KeyLogin) -> Result<View> {
        {
            let _permit = self.admission.enter_work()?;
            let agent = self.listed(id).await?;
            let (server, generation) = self.login_connection(id, &agent)?;
            ensure!(!request.key.trim().is_empty(), "请填写 API key");
            let label = request.label.as_deref().map(str::trim).filter(|l| !l.is_empty());
            server.connect_key(&request.integration, request.key.trim(), label, request.answer.as_ref()).await.map_err(refused)?;
            self.login_still(id, generation)?;
            self.record_meta(id, "opencode/loggedIn", json!({"integration":request.integration,"method":"key","label":label}), |_| {}).await?;
            self.changed(id);
        }
        self.opencode_logins(id).await
    }

    /// Starts an OAuth sign-in. One whose link sends the browser back to a
    /// loopback address is cancelled before anything of it is shown (D7).
    pub async fn opencode_login_oauth(&self, id: &str, request: OAuthLogin) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let agent = self.listed(id).await?;
        let (server, generation) = self.login_connection(id, &agent)?;
        let attempt = server.oauth_start(&request.integration, &request.method, request.answer.as_ref()).await.map_err(refused)?;
        let attempt_id = attempt["attemptID"].as_str().context("OpenCode started a sign-in with no attempt")?.to_owned();
        let link = attempt["url"].as_str().unwrap_or_default();
        if loopback(link) {
            let _ = server.oauth_cancel(&request.integration, &attempt_id).await;
            self.record_meta(id, "opencode/loginNotOffered", json!({"integration":request.integration,"method":request.method,"why":"loopback"}), |_| {}).await?;
            bail!("这个登录方式需要在运行 Yuzuno 的电脑上用浏览器完成；请在 OpenCode 里登录");
        }
        self.login_still(id, generation)?;
        self.record_meta(id, "opencode/loginStarted", json!({"integration":request.integration,"method":request.method}), |_| {}).await?;
        Ok(json!({"attemptId":attempt_id,"url":link,"instructions":attempt["instructions"],"mode":attempt["mode"],"time":attempt["time"]}))
    }

    /// Where a sign-in is; a complete one is journaled as logged in.
    pub async fn opencode_login_oauth_status(&self, id: &str, integration: &str, attempt: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let agent = self.listed(id).await?;
        let (server, _) = self.login_connection(id, &agent)?;
        let status = server.oauth_status(integration, attempt).await.map_err(refused)?;
        if status["status"] == "complete" {
            self.record_meta(id, "opencode/loggedIn", json!({"integration":integration,"method":"oauth"}), |_| {}).await?;
            self.changed(id);
        }
        Ok(json!({"status":status["status"],"message":status["message"],"time":status["time"]}))
    }

    /// Completes a code-mode sign-in with the code the user was given.
    pub async fn opencode_login_oauth_complete(&self, id: &str, integration: &str, attempt: &str, code: &str) -> Result<()> {
        let _permit = self.admission.enter_work()?;
        let agent = self.listed(id).await?;
        let (server, _) = self.login_connection(id, &agent)?;
        ensure!(!code.trim().is_empty(), "请填写登录页面给出的代码");
        server.oauth_complete(integration, attempt, code.trim()).await.map_err(refused)
    }

    pub async fn opencode_login_oauth_cancel(&self, id: &str, integration: &str, attempt: &str) -> Result<()> {
        let _permit = self.admission.enter_work()?;
        let agent = self.listed(id).await?;
        let (server, _) = self.login_connection(id, &agent)?;
        server.oauth_cancel(integration, attempt).await.map_err(refused)
    }

    /// Logs a credential out: removed from the Agent's OpenCode database.
    pub async fn opencode_logout(&self, id: &str, credential: &str) -> Result<View> {
        {
            let _permit = self.admission.enter_work()?;
            let agent = self.listed(id).await?;
            let (server, generation) = self.login_connection(id, &agent)?;
            server.delete_credential(credential).await.map_err(refused)?;
            self.login_still(id, generation)?;
            self.record_meta(id, "opencode/loggedOut", json!({"credential":credential}), |_| {}).await?;
            self.changed(id);
        }
        self.opencode_logins(id).await
    }
}

/// Removes every credential an Agent's OpenCode database holds (T-32 slice
/// 4b, D6), before Core keeps or moves it, on the closed file with its
/// server stopped: deleted with `secure_delete`, so their pages are
/// overwritten, the WAL checkpointed and truncated, the file vacuumed and
/// its WAL truncated again. A database with no `credential` table holds
/// none, and no database at all holds none. A failure is the caller's to
/// refuse with.
pub fn scrub(db: &std::path::Path) -> Result<()> {
    if db.symlink_metadata().is_err() {
        // A WAL left without its database could hold a credential's pages, and can't be scrubbed.
        let wal = db.with_extension("db-wal");
        ensure!(wal.symlink_metadata().is_err(), "{} 没有它的数据库，无法清除", wal.display());
        return Ok(());
    }
    let conn = rusqlite::Connection::open(db).with_context(|| format!("{} 打不开", db.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "secure_delete", "ON")?;
    let held: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'credential'", [], |r| r.get(0))?;
    if held > 0 {
        conn.execute("DELETE FROM credential", [])?;
    }
    let checkpoint = |conn: &rusqlite::Connection| -> Result<()> {
        let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))?;
        ensure!(busy == 0, "{} 仍被占用，WAL 没有清空", db.display());
        Ok(())
    };
    checkpoint(&conn)?;
    conn.execute_batch("VACUUM")?;
    checkpoint(&conn)?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyLogin {
    pub integration: String,
    pub key: String,
    pub label: Option<String>,
    pub answer: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OAuthLogin {
    pub integration: String,
    pub method: String,
    pub answer: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Code {
    code: String,
}

async fn read(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.opencode_logins(&id).await?))
}

async fn key(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>, Json(request): Json<KeyLogin>) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.opencode_login_key(&id, request).await?))
}

async fn oauth(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>, Json(request): Json<OAuthLogin>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.opencode_login_oauth(&id, request).await?))
}

async fn oauth_status(ApiState(ws): ApiState<Arc<Workspace>>, Path((id, integration, attempt)): Path<(String, String, String)>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.opencode_login_oauth_status(&id, &integration, &attempt).await?))
}

async fn oauth_complete(ApiState(ws): ApiState<Arc<Workspace>>, Path((id, integration, attempt)): Path<(String, String, String)>, Json(code): Json<Code>) -> Result<Json<Value>, ApiError> {
    ws.opencode_login_oauth_complete(&id, &integration, &attempt, &code.code).await?;
    Ok(Json(json!({})))
}

async fn oauth_cancel(ApiState(ws): ApiState<Arc<Workspace>>, Path((id, integration, attempt)): Path<(String, String, String)>) -> Result<Json<Value>, ApiError> {
    ws.opencode_login_oauth_cancel(&id, &integration, &attempt).await?;
    Ok(Json(json!({})))
}

async fn logout(ApiState(ws): ApiState<Arc<Workspace>>, Path((id, credential)): Path<(String, String)>) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.opencode_logout(&id, &credential).await?))
}

/// The login routes: on Core's own port only (`server::router_with_updates`).
pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/agents/{id}/opencode/login", get(read))
        .route("/api/agents/{id}/opencode/login/key", post(key))
        .route("/api/agents/{id}/opencode/login/oauth", post(oauth))
        .route("/api/agents/{id}/opencode/login/oauth/{integration}/{attempt}", get(oauth_status).delete(oauth_cancel))
        .route("/api/agents/{id}/opencode/login/oauth/{integration}/{attempt}/complete", post(oauth_complete))
        .route("/api/agents/{id}/opencode/login/credential/{credential}", delete(logout))
}

#[cfg(test)]
#[path = "opencode_login_tests.rs"]
mod tests;
