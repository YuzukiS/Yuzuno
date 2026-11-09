//! Choosing a candidate (YN-34 S3b). This is pure: it takes the policy, the
//! readings and the time, and answers the route record (`route_json`, as
//! agreed with YN-49 in docs/executor-routing.md) and the profile the chosen
//! candidate starts with.
//!
//! The first enabled candidate whose harness can run on the machine and keeps
//! the executor's permission level (YN-56), whose credential is available and
//! whose conditions all hold is chosen. A reading
//! that is missing, stale or unknown makes its condition unknown, and the
//! candidate's `unknown` rule decides: `skip` (the default) or `pass`.
use crate::{routing_keys::Provider, routing_launch::RuntimeProfile, routing_readings::{DaySpend, Schedule}};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

/// What the evaluation reads, as Core last observed it.
pub struct Inputs<'a> {
    pub now: DateTime<Utc>,
    /// Each routing key: its id, provider and source ("local" or "1password").
    pub keys: &'a [(String, Provider, &'static str)],
    pub codex_homes: &'a [String],
    pub spend: &'a DaySpend,
    /// The readings' `cswap` (null before the first read).
    pub cswap: &'a Value,
    /// The readings' `codex` list.
    pub codex: &'a [Value],
    /// Where the executor would run: "local", a machine id, or None for a preview.
    pub machine: Option<&'a str>,
    /// Candidates this request already failed to start with: each is tried once.
    pub exclude: &'a [String],
    /// Only candidates of this harness (the check at an executor's first start).
    pub harness: Option<&'a str>,
    /// The executor's permission level (permission_levels): only candidates whose harness keeps it.
    pub level: Option<&'a str>,
    pub assume: &'a Assume,
}

/// What a preview assumes instead of what was read (`POST /api/routing/evaluate`).
#[derive(Clone, Debug, Default)]
pub struct Assume {
    pub accounts_used_up: Vec<String>,
    pub codex_used_up: Vec<String>,
    pub spend_cap_reached: bool,
    pub one_password_down: bool,
}

impl Assume {
    pub fn from_json(value: &Value) -> Self {
        let list = |name: &str| value[name].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        Self {
            accounts_used_up: list("accountsUsedUp"),
            codex_used_up: list("codexUsedUp"),
            spend_cap_reached: value["spendCapReached"] == true,
            one_password_down: value["onePasswordDown"] == true,
        }
    }
}

/// What an evaluation chose: the record, the chosen candidate (as saved) and its profile.
pub struct Route {
    pub record: Value,
    pub chosen: Option<Value>,
    pub profile: Option<RuntimeProfile>,
}

enum Check {
    Holds,
    Fails(Value),
    Unknown(Value),
}

fn reason(code: &str, message: impl Into<String>, message_zh: impl Into<String>) -> Value {
    json!({"code": code, "message": message.into(), "messageZh": message_zh.into()})
}

fn with(mut reason: Value, extra: Value) -> Value {
    if let (Some(r), Some(e)) = (reason.as_object_mut(), extra.as_object()) {
        r.extend(e.clone());
    }
    reason
}

/// The share left of one window, when known and fresh.
fn left(window: &Value) -> Option<f64> {
    window["leftPct"].as_f64()
}

/// Whether a quota condition holds for one account's reading.
fn quota_holds(condition: &Value, reading: &Value) -> Check {
    if reading.is_null() || reading["stale"] == true || reading.get("unknown").is_some_and(|u| !u.is_null()) {
        return Check::Unknown(reason("quotaUnknown", "This account's quota is not known now", "这个账号此刻的额度不清楚"));
    }
    for (field, window, name, name_zh) in [("fiveHourLeftPct", "fiveHour", "5-hour", "5 小时"), ("weekLeftPct", "week", "weekly", "本周")] {
        let Some(want) = condition[field].as_f64() else { continue };
        match left(&reading[window]) {
            None => return Check::Unknown(reason("quotaUnknown", format!("The {name} quota is not known now"), format!("{name_zh}额度此刻不清楚"))),
            Some(have) if have < want => {
                return Check::Fails(with(reason("quotaLow", format!("{have:.0}% of the {name} quota is left, below {want:.0}%"),
                    format!("{name_zh}额度只剩 {have:.0}%，低于 {want:.0}%")), json!({"params": {"left": have, "want": want,
                    "until": reading[window]["resetsAt"]}})));
            }
            Some(_) => {}
        }
    }
    Check::Holds
}

fn time_window(condition: &Value, now: DateTime<Utc>) -> Check {
    let Ok(schedule) = serde_json::from_value::<Schedule>(condition["schedule"].clone()) else {
        return Check::Unknown(reason("scheduleUnreadable", "The schedule cannot be read", "无法读这个时间表"));
    };
    let want = condition["inside"] == true;
    let changes = schedule.changes_at(now);
    if schedule.inside(now) != want {
        return Check::Fails(with(reason("outsideWindow", "Not in its time window now", "此刻不在它的时间窗口内"),
            json!({"params": {"until": changes.map(|t| t.to_rfc3339())}})));
    }
    if let (Some(minutes), Some(changes)) = (condition["minMinutesLeft"].as_i64(), changes) {
        let left = (changes - now).num_minutes();
        if left < minutes {
            return Check::Fails(with(reason("windowEndsSoon", format!("Its time window ends in {left} minutes, under {minutes}"),
                format!("时间窗口 {left} 分钟后结束，不到 {minutes} 分钟")), json!({"params": {"until": changes.to_rfc3339()}})));
        }
    }
    Check::Holds
}

/// The Codex home a Codex candidate runs in: `login` for the host's own, else its Codex home's id.
fn codex_home(candidate: &Value) -> Option<&str> {
    match (candidate["harness"].as_str(), candidate["credential"]["kind"].as_str()) {
        (Some("codex"), Some("login")) => Some("login"),
        (Some("codex"), Some("codexHome")) => candidate["credential"]["id"].as_str(),
        _ => None,
    }
}

/// The reading of the account a non-pool candidate runs on, for a quota condition.
fn account_reading<'a>(candidate: &Value, inputs: &'a Inputs) -> Option<&'a Value> {
    let kind = candidate["credential"]["kind"].as_str().unwrap_or_default();
    match (candidate["harness"].as_str(), kind) {
        (Some("codex"), "login") => inputs.codex.iter().find(|c| c["home"] == "login"),
        (Some("codex"), "codexHome") => inputs.codex.iter().find(|c| c["home"] == candidate["credential"]["id"]),
        // The host's own Claude login is claude-swap's active account.
        (Some("claude"), "login") => inputs.cswap["accounts"].as_array()?.iter().find(|a| a["active"] == true),
        _ => None,
    }
}

/// Whether the preview assumes this account used up: a Codex reading by its home,
/// a claude-swap account (a Claude login's active one) by its fingerprint.
fn assumed_used_up(reading: &Value, inputs: &Inputs) -> bool {
    reading["home"].as_str().is_some_and(|h| inputs.assume.codex_used_up.iter().any(|u| u == h))
        || reading["fingerprint"].as_str().is_some_and(|f| inputs.assume.accounts_used_up.iter().any(|u| u == f))
}

fn check_condition(candidate: &Value, condition: &Value, inputs: &Inputs) -> Check {
    match condition["kind"].as_str().unwrap_or_default() {
        "timeWindow" => time_window(condition, inputs.now),
        "quota" => {
            // A Codex account is named by the candidate itself, so a preview can assume it used
            // up before Core has a reading of it (YN-49, from a lab Core). A Claude login's account
            // is claude-swap's active one, known only from a reading.
            if codex_home(candidate).is_some_and(|home| inputs.assume.codex_used_up.iter().any(|u| u == home)) {
                return Check::Fails(reason("quotaLow", "Assumed used up", "假设已用完"));
            }
            let Some(reading) = account_reading(candidate, inputs) else {
                return Check::Unknown(reason("quotaUnknown", "No quota reading for this account yet", "这个账号还没有额度读数"));
            };
            if assumed_used_up(reading, inputs) {
                return Check::Fails(reason("quotaLow", "Assumed used up", "假设已用完"));
            }
            quota_holds(condition, reading)
        }
        "dailyApiCap" => {
            if candidate["harness"] == "codex" {
                return Check::Unknown(reason("spendNotCounted", "Codex API spend is not counted yet", "Codex 的 API 花费暂不计入"));
            }
            let key = candidate["credential"]["keyId"].as_str().unwrap_or_default();
            let spent = inputs.spend.by_key.get(key).copied().unwrap_or(0.0);
            let cap = condition["usd"].as_f64().unwrap_or(0.0);
            if inputs.assume.spend_cap_reached || spent >= cap {
                Check::Fails(with(reason("dailyCapReached", format!("${spent:.2} spent today on this key, at its ${cap:.2} cap"),
                    format!("这把密钥今天已花 ${spent:.2}，达到上限 ${cap:.2}")), json!({"params": {"spentUsd": spent, "capUsd": cap}})))
            } else {
                Check::Holds
            }
        }
        _ => Check::Unknown(reason("unknownCondition", "A condition this Core does not know", "这个 Core 不认识的条件")),
    }
}

/// Evaluates `policy` (version `version`) now. `at` is "dispatch", "start" or "preview".
pub fn evaluate(version: i64, policy: &Value, at: &str, inputs: &Inputs) -> Route {
    let mut rows = Vec::new();
    let mut chosen: Option<(Value, Option<RuntimeProfile>, Option<Value>)> = None;
    let mut earliest: Option<(String, String)> = None;
    let cap = policy["dailyApiCapUsd"].as_f64();
    for candidate in policy["candidates"].as_array().into_iter().flatten() {
        let id = candidate["id"].as_str().unwrap_or_default().to_owned();
        let mut row = json!({"id": id, "label": candidate["label"], "harness": candidate["harness"], "model": candidate["model"],
            "reasons": [], "readings": []});
        let (state, reasons, accounts, profile, account) = if chosen.is_some() {
            ("notTried", vec![], None, None, None)
        } else {
            decide(candidate, inputs, cap)
        };
        row["state"] = state.into();
        for r in &reasons {
            if let Some(until) = r["params"]["until"].as_str() {
                if earliest.as_ref().is_none_or(|(at, _)| until < at.as_str()) {
                    earliest = Some((until.to_owned(), id.clone()));
                }
            }
        }
        row["reasons"] = Value::Array(reasons);
        if let Some(accounts) = accounts {
            row["accounts"] = accounts;
        }
        if state == "chosen" {
            chosen = Some((candidate.clone(), profile, account));
        }
        rows.push(row);
    }
    let mut record = json!({"policyVersion": version, "evaluatedAt": inputs.now.to_rfc3339(), "at": at,
        "chosen": chosen.as_ref().map(|(c, _, _)| c["id"].clone()), "candidates": rows});
    if let Some(level) = inputs.level {
        record["level"] = level.into();
    }
    if let Some((_, _, Some(account))) = &chosen {
        record["account"] = account.clone();
    }
    if chosen.is_none() {
        if let Some((at, candidate)) = earliest {
            record["earliest"] = json!({"at": at, "candidate": candidate});
        }
    }
    let (chosen, profile) = match chosen {
        Some((c, p, _)) => (Some(c), p),
        None => (None, None),
    };
    Route { record, chosen, profile }
}

type Decision = (&'static str, Vec<Value>, Option<Value>, Option<RuntimeProfile>, Option<Value>);

/// One candidate's state, its reasons, its pool's accounts, and the profile and account it would start with.
fn decide(candidate: &Value, inputs: &Inputs, cap: Option<f64>) -> Decision {
    let id = candidate["id"].as_str().unwrap_or_default();
    let harness = candidate["harness"].as_str().unwrap_or_default();
    let credential = &candidate["credential"];
    let kind = credential["kind"].as_str().unwrap_or_default();
    if candidate["enabled"] != true {
        return ("off", vec![], None, None, None);
    }
    if inputs.exclude.iter().any(|e| e == id) {
        return ("failed", vec![reason("failedBefore", "It already failed to start this executor", "它已经没能启动这个执行者")], None, None, None);
    }
    if inputs.harness.is_some_and(|h| h != harness) {
        return ("skipped", vec![reason("otherHarness", "The executor was made for another harness", "这个执行者是为另一个工具建的")], None, None, None);
    }
    if let Some(level) = inputs.level.filter(|level| !crate::permission_levels::keeps(Some(*level), harness)) {
        return ("skipped", vec![crate::permission_levels::not_kept(level, harness)], None, None, None);
    }
    let host_only = kind != "login" || harness == "opencode";
    if host_only && inputs.machine.is_some_and(|m| m != "local") {
        return ("skipped", vec![reason("hostOnly", "It runs on this Core host only", "它只能在 Core 所在的这台主机上跑")], None, None, None);
    }
    let unknown_pass = candidate["unknown"] == "pass";
    let mut unknowns = Vec::new();
    // The credential: available, and for a pool, which account.
    let (profile, account, accounts) = match kind {
        "login" => (None, None, None),
        "apiKey" => {
            let key = credential["keyId"].as_str().unwrap_or_default();
            match inputs.keys.iter().find(|(k, _, _)| k == key) {
                None => return ("skipped", vec![reason("keyMissing", format!("The routing key {key} is not set"), format!("路由密钥 {key} 没有设置"))], None, None, None),
                Some((_, _, "1password")) if inputs.assume.one_password_down => {
                    unknowns.push(reason("onePasswordDown", "1Password is assumed unreachable", "假设 1Password 连不上"));
                }
                Some(_) => {}
            }
            (Some(RuntimeProfile::ApiKey { key_id: key.into() }), None, None)
        }
        "codexHome" => {
            let home = credential["id"].as_str().unwrap_or_default();
            if !inputs.codex_homes.iter().any(|h| h == home) {
                return ("skipped", vec![reason("homeMissing", format!("The Codex home {home} is no longer listed"), format!("Codex 目录 {home} 已不在列表里"))], None, None, None);
            }
            (Some(RuntimeProfile::CodexHome { id: home.into() }), Some(json!({"home": home})), None)
        }
        "pool" => match pick(candidate, inputs) {
            Ok((fingerprint, number, accounts)) => (Some(RuntimeProfile::ClaudeAccount { fingerprint: fingerprint.clone() }),
                Some(json!({"number": number, "fingerprint": fingerprint})), Some(accounts)),
            Err((check, accounts)) => match check {
                Check::Unknown(why) => return ("unknown", vec![why], Some(accounts), None, None),
                Check::Fails(why) => return ("skipped", vec![why], Some(accounts), None, None),
                Check::Holds => unreachable!(),
            },
        },
        _ => return ("unknown", vec![reason("unknownCredential", "A credential this Core does not know", "这个 Core 不认识的凭据")], None, None, None),
    };
    let mut fails = Vec::new();
    for (n, condition) in candidate["conditions"].as_array().into_iter().flatten().enumerate() {
        // A pool's quota conditions were each account's, in `pick`.
        if kind == "pool" && condition["kind"] == "quota" {
            continue;
        }
        match check_condition(candidate, condition, inputs) {
            Check::Holds => {}
            Check::Fails(why) => fails.push(with(why, json!({"condition": n}))),
            Check::Unknown(why) => unknowns.push(with(why, json!({"condition": n}))),
        }
    }
    // The Workspace's daily API cap, on every API-key candidate.
    if kind == "apiKey" {
        if let Some(cap) = cap {
            if harness == "codex" {
                unknowns.push(reason("spendNotCounted", "Codex API spend is not counted yet", "Codex 的 API 花费暂不计入"));
            } else if inputs.assume.spend_cap_reached || inputs.spend.total_usd >= cap {
                fails.push(with(reason("workspaceCapReached", format!("${:.2} spent today, at the Workspace's ${cap:.2} cap", inputs.spend.total_usd),
                    format!("今天已花 ${:.2}，达到工作区上限 ${cap:.2}", inputs.spend.total_usd)), json!({"params": {"spentUsd": inputs.spend.total_usd, "capUsd": cap}})));
            }
        }
    }
    if !fails.is_empty() {
        return ("skipped", fails.into_iter().chain(unknowns).collect(), accounts, None, None);
    }
    if !unknowns.is_empty() && !unknown_pass {
        return ("unknown", unknowns, accounts, None, None);
    }
    ("chosen", unknowns, accounts, profile, account)
}

/// A pool's account: among its listed accounts, those for which each quota
/// condition holds; the one with the most of min(5-hour, week) left, ties to
/// the lower number. Answers each account's state too.
fn pick(candidate: &Value, inputs: &Inputs) -> Result<(String, u64, Value), (Check, Value)> {
    let wanted = &candidate["credential"]["accounts"];
    let accounts: Vec<&Value> = inputs.cswap["accounts"].as_array().into_iter().flatten()
        .filter(|a| wanted == "all" || wanted.as_array().is_some_and(|l| l.iter().any(|f| *f == a["fingerprint"])))
        .collect();
    let quotas: Vec<&Value> = candidate["conditions"].as_array().into_iter().flatten().filter(|c| c["kind"] == "quota").collect();
    let stale = inputs.cswap.is_null() || inputs.cswap["stale"] == true;
    let mut states = Vec::new();
    let mut best: Option<(f64, u64, String)> = None;
    let mut any_unknown = stale || accounts.is_empty();
    for a in &accounts {
        let fingerprint = a["fingerprint"].as_str().unwrap_or_default().to_owned();
        let number = a["number"].as_u64().unwrap_or(u64::MAX);
        let reading = if stale { Value::Null } else { (*a).clone() };
        let used_up = inputs.assume.accounts_used_up.iter().any(|u| *u == fingerprint);
        let mut state = "ok";
        for q in &quotas {
            match if used_up { Check::Fails(Value::Null) } else { quota_holds(q, &reading) } {
                Check::Holds => {}
                Check::Fails(_) => state = "low",
                Check::Unknown(_) if state == "ok" => state = "unknown",
                Check::Unknown(_) => {}
            }
        }
        if used_up {
            state = "low";
        }
        let score = match (left(&reading["fiveHour"]), left(&reading["week"])) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => if state == "ok" && quotas.is_empty() { 0.0 } else { -1.0 },
        };
        if state == "unknown" {
            any_unknown = true;
        }
        if state == "ok" && best.as_ref().is_none_or(|(s, n, _)| score > *s || (score == *s && number < *n)) {
            best = Some((score, number, fingerprint.clone()));
        }
        states.push(json!({"number": number, "fingerprint": fingerprint, "state": state}));
    }
    if let Some((_, number, fingerprint)) = best {
        for s in &mut states {
            if s["fingerprint"] == fingerprint.as_str() {
                s["state"] = "pick".into();
            }
        }
        return Ok((fingerprint, number, Value::Array(states)));
    }
    let why = if any_unknown {
        Check::Unknown(reason("quotaUnknown", "No account of the pool is known to have quota now", "此刻不知道池里哪个账号还有额度"))
    } else {
        let until = accounts.iter().filter_map(|a| a["fiveHour"]["resetsAt"].as_str()).min().map(str::to_owned);
        Check::Fails(with(reason("quotaLow", "Every account of the pool is below its quota", "池里每个账号都低于额度要求"),
            json!({"params": {"until": until}})))
    };
    Err((why, Value::Array(states)))
}

/// What an evaluation reads, gathered once from the store, the key file and the readings.
pub(crate) struct Gathered {
    pub keys: Vec<(String, Provider, &'static str)>,
    pub codex_homes: Vec<String>,
    pub spend: DaySpend,
    pub cswap: Value,
    pub codex: Vec<Value>,
}

impl Gathered {
    pub fn inputs<'a>(&'a self, now: DateTime<Utc>, machine: Option<&'a str>, exclude: &'a [String], harness: Option<&'a str>,
        level: Option<&'a str>, assume: &'a Assume) -> Inputs<'a> {
        Inputs { now, keys: &self.keys, codex_homes: &self.codex_homes, spend: &self.spend, cswap: &self.cswap, codex: &self.codex,
            machine, exclude, harness, level, assume }
    }
}

impl crate::workspace::Workspace {
    pub(crate) async fn routing_gathered(&self) -> anyhow::Result<Gathered> {
        let dir = self.data_dir.clone();
        let keys = tokio::task::spawn_blocking(move || crate::routing_keys::Store::of(&dir).keys()).await??
            .into_iter().map(|k| (k.id, k.provider, k.source)).collect();
        let day = crate::routing_readings::today();
        let (homes, spend, kept) = self.stored(move |store| Ok((store.codex_homes()?, store.spend_on(day)?, store.quotas()?))).await?;
        let (cswap, codex) = crate::routing_readings::quota::view(&kept, Utc::now());
        Ok(Gathered { keys, codex_homes: homes.into_iter().map(|h| h.id).collect(), spend, cswap,
            codex: codex.as_array().cloned().unwrap_or_default() })
    }
}

#[cfg(test)]
#[path = "evaluate_tests.rs"]
mod tests;
