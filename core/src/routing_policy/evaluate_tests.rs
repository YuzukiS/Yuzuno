//! Choosing a candidate (YN-34 S3b1), on synthetic readings. Pure: nothing is read or started.
use super::*;
use chrono::TimeZone;

fn utc(d: u32, h: u32, m: u32) -> DateTime<Utc> {
    // 2026-11-09 is a Monday.
    Utc.with_ymd_and_hms(2026, 11, d, h, m, 0).unwrap()
}

/// claude-swap's accounts, by the share of the week each has left: weeks only,
/// as claude-swap reads them since Claude's 5-hour quota went (YN-60).
fn cswap(weeks: &[f64]) -> Value {
    let weeks: Vec<(f64, Option<&str>)> = weeks.iter().map(|w| (*w, Some("2026-11-09T12:00:00+00:00"))).collect();
    cswap_resets(&weeks)
}

/// claude-swap's accounts, each with its own week: the share left and when it
/// resets (`None`: the reading has no reset time).
fn cswap_resets(weeks: &[(f64, Option<&str>)]) -> Value {
    let accounts: Vec<Value> = weeks.iter().zip(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"]).enumerate()
        .map(|(n, ((left, resets), fingerprint))| {
            let mut week = json!({"leftPct": left});
            if let Some(at) = resets {
                week["resetsAt"] = json!(at);
            }
            json!({"number": n + 1, "fingerprint": fingerprint, "active": n == 0, "source": "cswap", "week": week})
        }).collect();
    json!({"observedAt": "x", "stale": false, "accounts": accounts})
}

/// A policy of one pool: its `pick` when named, and a weekly quota condition
/// when `week_left_pct` is (YN-150).
fn pool_pick(pick: Option<&str>, week_left_pct: Option<f64>) -> Value {
    let mut credential = json!({"kind": "pool", "manager": "cswap", "accounts": "all"});
    if let Some(pick) = pick {
        credential["pick"] = json!(pick);
    }
    let conditions = match week_left_pct {
        Some(pct) => json!([{"kind": "quota", "weekLeftPct": pct}]),
        None => json!([]),
    };
    json!({"enabled": true, "whenNone": "wait", "dailyApiCapUsd": 5, "candidates": [
        {"id": "c-pool", "enabled": true, "harness": "claude", "model": "opus", "credential": credential, "conditions": conditions}]})
}

/// The first candidate's account rows.
fn account_rows(route: &Route) -> Vec<Value> {
    route.record["candidates"][0]["accounts"].as_array().cloned().unwrap_or_default()
}

fn policy() -> Value {
    json!({"enabled": true, "whenNone": "wait", "dailyApiCapUsd": 5, "candidates": [
        {"id": "c-pool", "enabled": true, "harness": "claude", "model": "opus",
         "credential": {"kind": "pool", "manager": "cswap", "accounts": "all"},
         "conditions": [{"kind": "quota", "weekLeftPct": 30}]},
        {"id": "c-deepseek", "enabled": true, "harness": "opencode", "model": "deepseek/deepseek-flash",
         "credential": {"kind": "apiKey", "keyId": "deepseek"},
         "conditions": [
            {"kind": "timeWindow", "inside": false, "minMinutesLeft": 30, "schedule": serde_json::to_value(crate::routing_readings::builtin("deepseek-peak").unwrap()).unwrap()},
            {"kind": "dailyApiCap", "usd": 2}]},
        {"id": "c-codex", "enabled": true, "harness": "codex", "model": "gpt-test", "credential": {"kind": "login"}, "conditions": []}]})
}

struct Fixture {
    keys: Vec<(String, Provider, &'static str)>,
    homes: Vec<String>,
    spend: DaySpend,
    cswap: Value,
    codex: Vec<Value>,
    machines: Vec<Value>,
}

impl Fixture {
    fn new() -> Self {
        Self { keys: vec![("deepseek".into(), Provider::Deepseek, "local")], homes: vec!["work".into()],
            spend: DaySpend { day: "2026-11-09".into(), total_usd: 0.0, by_key: Default::default() },
            cswap: cswap(&[20.0, 40.0]), codex: vec![], machines: vec![] }
    }

    fn run(&self, policy: &Value, now: DateTime<Utc>, machine: Option<&str>, exclude: &[String], assume: &Assume) -> Route {
        evaluate(3, policy, "dispatch", &Inputs { now, keys: &self.keys, codex_homes: &self.homes, spend: &self.spend,
            cswap: &self.cswap, codex: &self.codex, machines: &self.machines, machine, exclude, harness: None, unavailable: &[], level: None, tier: None, tier_source: None, assume })
    }

    /// At a waiting executor's start (YN-66): among one harness, or any but those its machine can't run.
    fn run_start(&self, policy: &Value, now: DateTime<Utc>, harness: Option<&str>, unavailable: &[&str]) -> Route {
        evaluate(3, policy, "start", &Inputs { now, keys: &self.keys, codex_homes: &self.homes, spend: &self.spend,
            cswap: &self.cswap, codex: &self.codex, machines: &self.machines, machine: Some("local"), exclude: &[], harness, unavailable, level: None, tier: None, tier_source: None, assume: &Assume::default() })
    }

    /// At the executor's first start (`harness`) or dispatch, for a permission level (YN-56).
    fn run_level(&self, policy: &Value, now: DateTime<Utc>, harness: Option<&str>, level: Option<&str>) -> Route {
        evaluate(3, policy, "dispatch", &Inputs { now, keys: &self.keys, codex_homes: &self.homes, spend: &self.spend,
            cswap: &self.cswap, codex: &self.codex, machines: &self.machines, machine: Some("local"), exclude: &[], harness, unavailable: &[], level, tier: None, tier_source: None, assume: &Assume::default() })
    }
}

impl Fixture {
    /// At a dispatch for a tier (YN-70), whose it is beside it.
    fn run_tier(&self, policy: &Value, now: DateTime<Utc>, tier: Option<&str>, source: Option<&str>) -> Route {
        evaluate(3, policy, "dispatch", &Inputs { now, keys: &self.keys, codex_homes: &self.homes, spend: &self.spend,
            cswap: &self.cswap, codex: &self.codex, machines: &self.machines, machine: Some("local"), exclude: &[], harness: None, unavailable: &[], level: None,
            tier, tier_source: source, assume: &Assume::default() })
    }
}

fn states(route: &Route) -> Vec<(String, String)> {
    route.record["candidates"].as_array().unwrap().iter()
        .map(|c| (c["id"].as_str().unwrap().to_owned(), c["state"].as_str().unwrap().to_owned())).collect()
}

fn codes(route: &Route, id: &str) -> Vec<String> {
    let c = route.record["candidates"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap();
    c["reasons"].as_array().unwrap().iter().map(|r| r["code"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn the_first_candidate_whose_conditions_hold_is_chosen_and_a_pool_picks_its_fullest_account() {
    let f = Fixture::new();
    let none = Assume::default();
    let route = f.run(&policy(), utc(9, 12, 0), Some("local"), &[], &none);
    assert_eq!(states(&route), [("c-pool".into(), "chosen".into()), ("c-deepseek".into(), "notTried".into()), ("c-codex".into(), "notTried".into())]);
    // Account 1 has 20% of its week left, under 30%; account 2 has 40%.
    assert_eq!(route.record["account"], json!({"number": 2, "fingerprint": "bbbbbbbbbbbbbbbb"}));
    assert_eq!(route.profile, Some(RuntimeProfile::ClaudeAccount { fingerprint: "bbbbbbbbbbbbbbbb".into() }));
    let accounts = &route.record["candidates"][0]["accounts"];
    assert_eq!((accounts[0]["state"].clone(), accounts[1]["state"].clone()), (json!("low"), json!("pick")));
    assert_eq!((route.record["policyVersion"].clone(), route.record["at"].clone(), route.record["chosen"].clone()), (json!(3), json!("dispatch"), json!("c-pool")));
    assert!(route.record.get("earliest").is_none());
}

#[test]
fn a_time_window_its_minutes_left_and_the_daily_caps_each_skip_with_their_reason() {
    let mut f = Fixture::new();
    f.cswap = cswap(&[10.0, 20.0]);
    let none = Assume::default();
    // Monday 02:00 UTC is DeepSeek's peak: the pool is low, DeepSeek outside its window, Codex chosen.
    let route = f.run(&policy(), utc(9, 2, 0), Some("local"), &[], &none);
    assert_eq!(states(&route)[..2], [("c-pool".into(), "skipped".into()), ("c-deepseek".into(), "skipped".into())]);
    assert_eq!((codes(&route, "c-pool"), codes(&route, "c-deepseek")), (vec!["quotaLow".to_owned()], vec!["outsideWindow".to_owned()]));
    assert_eq!(route.record["chosen"], "c-codex");
    assert_eq!(route.profile, None, "a login starts on the host's own login");
    // 00:45 is off-peak, but only 15 minutes before the peak, under 30.
    assert_eq!(codes(&f.run(&policy(), utc(9, 0, 45), Some("local"), &[], &none), "c-deepseek"), ["windowEndsSoon"]);
    // 12:00 is off-peak: DeepSeek, on its key.
    let route = f.run(&policy(), utc(9, 12, 0), Some("local"), &[], &none);
    assert_eq!((route.record["chosen"].clone(), route.profile.clone()), (json!("c-deepseek"), Some(RuntimeProfile::ApiKey { key_id: "deepseek".into() })));
    // Its own cap: $2.50 spent on its key today.
    f.spend.by_key.insert("deepseek".into(), 2.5);
    f.spend.total_usd = 2.5;
    assert_eq!(codes(&f.run(&policy(), utc(9, 12, 0), Some("local"), &[], &none), "c-deepseek"), ["dailyCapReached"]);
    // The Workspace's cap: $6 spent today on all keys.
    f.spend.by_key.insert("deepseek".into(), 1.0);
    f.spend.total_usd = 6.0;
    assert_eq!(codes(&f.run(&policy(), utc(9, 12, 0), Some("local"), &[], &none), "c-deepseek"), ["workspaceCapReached"]);
}

#[test]
fn off_failed_host_only_and_missing_credentials_are_never_chosen() {
    let f = Fixture::new();
    let none = Assume::default();
    let mut p = policy();
    p["candidates"][0]["enabled"] = json!(false);
    p["candidates"][1]["credential"]["keyId"] = json!("gone");
    let route = f.run(&p, utc(9, 12, 0), Some("local"), &["c-codex".into()], &none);
    assert_eq!(states(&route), [("c-pool".into(), "off".into()), ("c-deepseek".into(), "skipped".into()), ("c-codex".into(), "failed".into())]);
    assert_eq!(codes(&route, "c-deepseek"), ["keyMissing"]);
    assert_eq!(route.record["chosen"], Value::Null);
    // On another machine only a login candidate (not OpenCode) can run.
    let route = f.run(&policy(), utc(9, 12, 0), Some("lab-mac"), &[], &none);
    assert_eq!((codes(&route, "c-pool"), codes(&route, "c-deepseek"), route.record["chosen"].clone()),
        (vec!["hostOnly".to_owned()], vec!["hostOnly".to_owned()], json!("c-codex")));
    let mut p = policy();
    p["candidates"] = json!([{"id": "c-home", "enabled": true, "harness": "codex", "model": "", "credential": {"kind": "codexHome", "id": "old"}, "conditions": []}]);
    assert_eq!(codes(&f.run(&p, utc(9, 12, 0), Some("local"), &[], &none), "c-home"), ["homeMissing"]);
}

#[test]
fn an_unknown_reading_skips_unless_the_candidate_says_pass_and_none_chosen_says_when_one_may_be() {
    let mut f = Fixture::new();
    f.cswap["stale"] = json!(true);
    let none = Assume::default();
    let mut p = policy();
    p["candidates"] = json!([p["candidates"][0].clone(), p["candidates"][1].clone()]);
    let route = f.run(&p, utc(9, 2, 0), Some("local"), &[], &none);
    assert_eq!(states(&route), [("c-pool".into(), "unknown".into()), ("c-deepseek".into(), "skipped".into())], "a stale reading is unknown");
    assert_eq!(route.record["earliest"], json!({"at": "2026-11-09T04:00:00+00:00", "candidate": "c-deepseek"}), "when the peak ends");
    // A login quota condition with no reading passes only for a candidate that says so.
    let login = |unknown: &str| json!({"enabled": true, "candidates": [{"id": "c-login", "enabled": true, "harness": "codex", "model": "",
        "credential": {"kind": "login"}, "conditions": [{"kind": "quota", "weekLeftPct": 10}], "unknown": unknown}]});
    assert_eq!(states(&f.run(&login("skip"), utc(9, 12, 0), None, &[], &none)), [("c-login".into(), "unknown".into())]);
    let passed = f.run(&login("pass"), utc(9, 12, 0), None, &[], &none);
    assert_eq!((passed.record["chosen"].clone(), codes(&passed, "c-login")), (json!("c-login"), vec!["quotaUnknown".to_owned()]));
    // A kind a later Core added is unknown.
    let later = json!({"enabled": true, "candidates": [{"id": "c-later", "enabled": true, "harness": "claude", "model": "",
        "credential": {"kind": "vault"}, "conditions": []}]});
    assert_eq!(codes(&f.run(&later, utc(9, 12, 0), None, &[], &none), "c-later"), ["unknownCredential"]);
}

#[test]
fn a_preview_can_assume_accounts_used_up_and_the_spend_cap_reached() {
    let f = Fixture::new();
    let assume = Assume::from_json(&json!({"accountsUsedUp": ["bbbbbbbbbbbbbbbb"], "spendCapReached": true}));
    let route = f.run(&policy(), utc(9, 12, 0), None, &[], &assume);
    assert_eq!(states(&route), [("c-pool".into(), "skipped".into()), ("c-deepseek".into(), "skipped".into()), ("c-codex".into(), "chosen".into())]);
    assert_eq!(codes(&route, "c-deepseek"), ["dailyCapReached", "workspaceCapReached"]);
    // A Claude login runs on claude-swap's active account, so its fingerprint counts too (#801 R1 P3).
    let login = json!({"enabled": true, "whenNone": "wait", "candidates": [
        {"id": "c-login", "enabled": true, "harness": "claude", "model": "opus", "credential": {"kind": "login"},
         "conditions": [{"kind": "quota", "weekLeftPct": 10}]}]});
    assert_eq!(states(&f.run(&login, utc(9, 12, 0), None, &[], &Assume::default())), [("c-login".into(), "chosen".into())]);
    let active_used_up = Assume::from_json(&json!({"accountsUsedUp": ["aaaaaaaaaaaaaaaa"]}));
    let route = f.run(&login, utc(9, 12, 0), None, &[], &active_used_up);
    assert_eq!((states(&route), codes(&route, "c-login")), (vec![("c-login".to_owned(), "skipped".to_owned())], vec!["quotaLow".to_owned()]));
    // A Codex account Core has no reading of yet can be assumed used up too, by its home (YN-49, from a lab Core).
    let codex = json!({"enabled": true, "whenNone": "wait", "candidates": [
        {"id": "c-codex", "enabled": true, "harness": "codex", "model": "gpt-test", "credential": {"kind": "login"}, "unknown": "pass",
         "conditions": [{"kind": "quota", "weekLeftPct": 10}]}]});
    assert!(f.codex.is_empty(), "no Codex reading");
    assert_eq!(states(&f.run(&codex, utc(9, 12, 0), None, &[], &Assume::default())), [("c-codex".into(), "chosen".into())],
        "unknown, and it says pass");
    let route = f.run(&codex, utc(9, 12, 0), None, &[], &Assume::from_json(&json!({"codexUsedUp": ["login"]})));
    assert_eq!((states(&route), codes(&route, "c-codex")), (vec![("c-codex".to_owned(), "skipped".to_owned())], vec!["quotaLow".to_owned()]));
}

#[test]
fn a_candidate_whose_harness_does_not_keep_the_permission_level_is_skipped_with_level_not_kept() {
    let f = Fixture::new();
    // 12:00 UTC on a Monday: off-peak, so DeepSeek would hold; account 2 holds the pool's quota.
    let at = utc(9, 12, 0);
    let full = f.run_level(&policy(), at, None, Some("full"));
    assert_eq!(states(&full), [("c-pool".into(), "skipped".into()), ("c-deepseek".into(), "chosen".into()), ("c-codex".into(), "notTried".into())],
        "OpenCode keeps Full access as its own rules (S3)");
    assert_eq!(codes(&full, "c-pool"), vec!["levelNotKept".to_owned()]);
    let why = &full.record["candidates"][0]["reasons"][0];
    assert_eq!((why["params"].clone(), why["messageZh"].clone()),
        (json!({"level": "full", "harness": "claude"}), json!("它的权限等级是「完全放开」，Claude Code 不支持这个等级")));
    assert_eq!(full.record["level"], "full");
    assert_eq!(full.profile, Some(RuntimeProfile::ApiKey { key_id: "deepseek".into() }));
    // Claude Code keeps auto: the pool is chosen as it is with no level.
    let auto = f.run_level(&policy(), at, None, Some("auto"));
    assert_eq!((auto.record["chosen"].clone(), auto.record["level"].clone()), (json!("c-pool"), json!("auto")));
    // No level: as before, and no level in the record.
    let none = f.run_level(&policy(), at, None, None);
    assert_eq!(none.record["chosen"], "c-pool");
    assert!(none.record.get("level").is_none());
    // At a first start, among one harness: OpenCode keeps each level.
    let start = f.run_level(&policy(), at, Some("opencode"), Some("ask"));
    assert_eq!(start.record["chosen"], "c-deepseek");
    assert_eq!(codes(&start, "c-pool"), vec!["otherHarness".to_owned()]);
    // Full access at a first start among Claude Code's candidates: none keeps it.
    let claude = f.run_level(&policy(), at, Some("claude"), Some("full"));
    assert_eq!((claude.record["chosen"].clone(), codes(&claude, "c-pool")), (Value::Null, vec!["levelNotKept".to_owned()]));
}

/// YN-119 S3: a dsh candidate starts on its DeepSeek key, on this Core host only, at
/// the levels dsh keeps (not read-only); dsh reports no spend, so a spend cap is
/// unknown for it and its `unknown` rule decides (design §4), as for Codex.
#[test]
fn a_dsh_candidate_runs_here_on_its_key_at_the_levels_dsh_keeps_and_its_spend_is_unknown() {
    let f = Fixture::new();
    let at = utc(9, 12, 0);
    let none = Assume::default();
    let dsh = |cap: Option<f64>, unknown: &str, conditions: Value| json!({"enabled": true, "whenNone": "wait", "dailyApiCapUsd": cap, "candidates": [
        {"id": "c-dsh", "enabled": true, "harness": "dsh", "model": "deepseek-v4-pro", "reasoningEffort": "high", "unknown": unknown,
         "credential": {"kind": "apiKey", "keyId": "deepseek"}, "conditions": conditions},
        {"id": "c-codex", "enabled": true, "harness": "codex", "model": "gpt-test", "credential": {"kind": "login"}, "conditions": []}]});
    let plain = dsh(None, "skip", json!([]));
    let route = f.run(&plain, at, Some("local"), &[], &none);
    assert_eq!((route.record["chosen"].clone(), route.profile.clone()), (json!("c-dsh"), Some(RuntimeProfile::ApiKey { key_id: "deepseek".into() })));
    assert!(codes(&route, "c-dsh").is_empty());
    // Not on another machine: its key stays on this Core host, and dsh runs only here.
    let elsewhere = f.run(&plain, at, Some("lab-mac"), &[], &none);
    assert_eq!((codes(&elsewhere, "c-dsh"), elsewhere.record["chosen"].clone()), (vec!["hostOnly".to_owned()], json!("c-codex")));
    // Read only is not a level dsh keeps; the others are.
    let read_only = f.run_level(&plain, at, None, Some(crate::permission_levels::READ_ONLY));
    assert_eq!((codes(&read_only, "c-dsh"), read_only.record["chosen"].clone()), (vec!["levelNotKept".to_owned()], json!("c-codex")));
    assert_eq!(read_only.record["candidates"][0]["reasons"][0]["params"], json!({"level": "read-only", "harness": "dsh"}));
    for level in ["ask", "auto", "full"] {
        assert_eq!(f.run_level(&plain, at, Some("dsh"), Some(level)).record["chosen"], "c-dsh", "{level}");
    }
    // The Workspace's cap and its own: spend not counted, so unknown, skipped by default and chosen with pass.
    for policy in [dsh(Some(5.0), "skip", json!([])), dsh(None, "skip", json!([{"kind": "dailyApiCap", "usd": 2}]))] {
        let route = f.run(&policy, at, Some("local"), &[], &none);
        assert_eq!((states(&route)[0].1.as_str(), codes(&route, "c-dsh"), route.record["chosen"].clone()),
            ("unknown", vec!["spendNotCounted".to_owned()], json!("c-codex")), "{policy}");
    }
    let mut spent = Fixture::new();
    spent.spend.total_usd = 9.0;
    spent.spend.by_key.insert("deepseek".into(), 9.0);
    let pass = spent.run(&dsh(Some(5.0), "pass", json!([{"kind": "dailyApiCap", "usd": 2}])), at, Some("local"), &[], &none);
    assert_eq!((pass.record["chosen"].clone(), codes(&pass, "c-dsh")), (json!("c-dsh"), vec!["spendNotCounted".to_owned(), "spendNotCounted".to_owned()]),
        "never judged by a spend it doesn't report");
    let why = &pass.record["candidates"][0]["reasons"][0];
    assert_eq!(why["messageZh"], "DeepSeek Harness 不报告 API 花费，所以不计入");
}

/// The host's Codex login with what is left of its week (YN-60: Codex reads weeks only).
fn codex_login(week: f64) -> Value {
    json!({"home": "login", "source": "codex", "stale": false, "observedAt": "x",
        "week": {"leftPct": week, "resetsAt": "2026-11-09T16:54:00+00:00"}})
}

#[test]
fn a_quota_condition_reads_only_the_week_so_a_saved_five_hour_share_no_longer_makes_it_unknown() {
    let mut f = Fixture::new();
    // As the user's Core read them on 2026-11-09 (YN-60): weeks only, no 5-hour window.
    f.cswap = cswap(&[0.0, 0.0, 98.0]);
    f.codex = vec![codex_login(0.0)];
    // A policy saved before YN-60: each quota condition still names a 5-hour share.
    let saved = json!({"kind": "quota", "fiveHourLeftPct": 15, "weekLeftPct": 10});
    let mut p = json!({"enabled": true, "whenNone": "wait", "candidates": [
        {"id": "c-pool", "enabled": true, "harness": "claude", "model": "opus",
         "credential": {"kind": "pool", "manager": "cswap", "accounts": "all"}, "conditions": [saved]},
        {"id": "c-codex", "enabled": true, "harness": "codex", "model": "gpt-test", "credential": {"kind": "login"}, "conditions": [saved]}]});
    let route = f.run(&p, utc(9, 1, 0), Some("local"), &[], &Assume::default());
    assert_eq!(states(&route), [("c-pool".into(), "chosen".into()), ("c-codex".into(), "notTried".into())], "{}", route.record);
    assert_eq!(route.record["account"], json!({"number": 3, "fingerprint": "cccccccccccccccc"}));
    let accounts: Vec<Value> = route.record["candidates"][0]["accounts"].as_array().unwrap().iter().map(|a| a["state"].clone()).collect();
    assert_eq!(accounts, [json!("low"), json!("low"), json!("pick")], "a week reading is a reading: {}", route.record);
    // With the pool off, Codex has 0% of its week left: low until its week resets, not unknown.
    p["candidates"][0]["enabled"] = json!(false);
    let route = f.run(&p, utc(9, 1, 0), Some("local"), &[], &Assume::default());
    assert_eq!((states(&route)[1].1.clone(), codes(&route, "c-codex")), ("skipped".to_owned(), vec!["quotaLow".to_owned()]), "{}", route.record);
    assert_eq!(route.record["earliest"], json!({"at": "2026-11-09T16:54:00+00:00", "candidate": "c-codex"}));
}

#[test]
fn a_quota_condition_that_named_only_the_five_hour_share_limits_nothing_and_its_row_says_so() {
    let mut f = Fixture::new();
    f.cswap = cswap(&[0.0, 0.0, 98.0]);
    f.codex = vec![codex_login(0.0)];
    let only_five_hour = json!([{"kind": "timeWindow", "inside": false, "schedule": {"timeZone": "UTC", "slots": [{"days": [6], "from": "00:00", "to": "01:00"}]}},
        {"kind": "quota", "fiveHourLeftPct": 15}]);
    for (candidate, account) in [
        (json!({"id": "c-codex", "enabled": true, "harness": "codex", "model": "gpt-test", "credential": {"kind": "login"}, "conditions": only_five_hour}), Value::Null),
        (json!({"id": "c-pool", "enabled": true, "harness": "claude", "model": "opus",
            "credential": {"kind": "pool", "manager": "cswap", "accounts": "all"}, "conditions": only_five_hour}),
            json!({"number": 3, "fingerprint": "cccccccccccccccc"})),
    ] {
        let id = candidate["id"].as_str().unwrap().to_owned();
        let route = f.run(&json!({"enabled": true, "whenNone": "wait", "candidates": [candidate]}), utc(9, 12, 0), Some("local"), &[], &Assume::default());
        assert_eq!((states(&route), route.record.get("account").cloned().unwrap_or(Value::Null)), (vec![(id.clone(), "chosen".to_owned())], account),
            "{id}: no quota condition is left to hold it back: {}", route.record);
        // Not silently: its row says the condition limits nothing now, and which one.
        let why = &route.record["candidates"][0]["reasons"];
        assert_eq!((codes(&route, &id), why[0]["condition"].clone()), (vec!["quotaRetired".to_owned()], json!(1)), "{id}: {why}");
        assert!(why[0]["message"].as_str().unwrap().contains("5-hour") && why[0]["messageZh"].as_str().unwrap().contains("5 小时"), "{why}");
    }
}

#[test]
fn a_window_that_ends_soon_waits_for_the_next_window_long_enough_to_use() {
    let f = Fixture::new();
    // DeepSeek off-peak, at least 30 minutes left: outside UTC Monday to Friday 01:00–04:00 and 06:00–10:00.
    let mut p = policy();
    p["candidates"] = json!([p["candidates"][1].clone()]);
    // 00:58 on a Monday is off-peak with 2 minutes left; the next off-peak, 04:00–06:00, has 120.
    let route = f.run(&p, utc(9, 0, 58), Some("local"), &[], &Assume::default());
    let why = &route.record["candidates"][0]["reasons"][0];
    assert_eq!((why["code"].clone(), why["params"]["until"].clone()), (json!("windowEndsSoon"), json!("2026-11-09T04:00:00+00:00")), "{}", route.record);
    assert_eq!(route.record["earliest"], json!({"at": "2026-11-09T04:00:00+00:00", "candidate": "c-deepseek"}));
    // Wanting 150 minutes, 04:00–06:00 is too short too: the next is 10:00, off-peak until 01:00 on Tuesday.
    p["candidates"][0]["conditions"][0]["minMinutesLeft"] = json!(150);
    let route = f.run(&p, utc(9, 0, 58), Some("local"), &[], &Assume::default());
    assert_eq!(route.record["earliest"]["at"], "2026-11-09T10:00:00+00:00", "{}", route.record);
    // So for a candidate outside its window: at 02:00 (peak) it is usable from 10:00, not 04:00.
    let route = f.run(&p, utc(9, 2, 0), Some("local"), &[], &Assume::default());
    let why = &route.record["candidates"][0]["reasons"][0];
    assert_eq!((why["code"].clone(), why["params"]["until"].clone()), (json!("outsideWindow"), json!("2026-11-09T10:00:00+00:00")), "{}", route.record);
}

/// YN-66: at a waiting executor's start every harness its machine runs is read, so the
/// soonest time a reason gives is any of theirs, not only its stand-in's; a harness its
/// machine can't run is passed over, and gives no time.
#[test]
fn at_a_start_every_harness_its_machine_runs_counts_and_one_it_cant_is_passed_over() {
    let mut f = Fixture::new();
    // Both pool accounts below the 30% the pool wants, until the week resets at 03:00.
    f.cswap = cswap(&[10.0, 20.0]);
    for account in f.cswap["accounts"].as_array_mut().unwrap() {
        account["week"]["resetsAt"] = json!("2026-11-09T03:00:00+00:00");
    }
    let mut p = policy();
    p["candidates"] = json!([p["candidates"][0].clone(), p["candidates"][1].clone()]);
    // 02:00 on a Monday: DeepSeek's peak, until 04:00.
    let at = utc(9, 2, 0);
    let stand_in = f.run_start(&p, at, Some("opencode"), &[]);
    assert_eq!((codes(&stand_in, "c-pool"), stand_in.record["earliest"].clone()),
        (vec!["otherHarness".to_owned()], json!({"at": "2026-11-09T04:00:00+00:00", "candidate": "c-deepseek"})),
        "among its stand-in's harness only, as before");
    let any = f.run_start(&p, at, None, &[]);
    assert_eq!((codes(&any, "c-pool"), any.record["chosen"].clone(), any.record["earliest"].clone()),
        (vec!["quotaLow".to_owned()], Value::Null, json!({"at": "2026-11-09T03:00:00+00:00", "candidate": "c-pool"})),
        "the pool's week resets first");
    let off = f.run_start(&p, at, None, &["opencode"]);
    assert_eq!(codes(&off, "c-deepseek"), ["harnessUnavailable"]);
    let why = &off.record["candidates"][1]["reasons"][0];
    assert_eq!((why["params"].clone(), why["messageZh"].clone()),
        (json!({"harness": "opencode", "machine": "local"}), json!("它所在的机器现在跑不了 OpenCode")));
    assert_eq!(off.record["earliest"], json!({"at": "2026-11-09T03:00:00+00:00", "candidate": "c-pool"}));
}

/// YN-70: a candidate serves the tiers it names, and one that names none serves
/// both, as every candidate saved before did. A tier passes over a candidate that
/// doesn't serve it, saying why in both languages, and the record keeps the tier
/// and whose it is; no tier passes over none and records none.
#[test]
fn a_tier_passes_over_a_candidate_that_does_not_serve_it() {
    let f = Fixture::new();
    let mut p = policy();
    // Outside DeepSeek's peak, so each of the three would hold on its own.
    let now = utc(9, 20, 0);
    p["candidates"][0]["tiers"] = json!(["strong"]);
    p["candidates"][1]["tiers"] = json!(["fast"]);
    let fast = f.run_tier(&p, now, Some("fast"), Some("template"));
    assert_eq!(states(&fast), [("c-pool".into(), "skipped".into()), ("c-deepseek".into(), "chosen".into()), ("c-codex".into(), "notTried".into())]);
    let why = &fast.record["candidates"][0]["reasons"][0];
    assert_eq!((why["code"].clone(), why["params"]["tier"].clone()), (json!("tierNotServed"), json!("fast")), "{why}");
    assert_eq!(why["message"], "It doesn't serve the fast tier this executor wants");
    assert_eq!(why["messageZh"], "它不接这个执行者要的「快」档");
    assert_eq!((fast.record["tier"].clone(), fast.record["tierSource"].clone()), (json!("fast"), json!("template")));

    let strong = f.run_tier(&p, now, Some("strong"), Some("lead"));
    assert_eq!(strong.record["chosen"], "c-pool", "the pool serves strong: {}", strong.record);
    assert_eq!(strong.record["tierSource"], "lead");
    // The pool used up: DeepSeek serves only fast, so Codex, which names no tiers, serves strong.
    let assume = Assume { accounts_used_up: vec!["aaaaaaaaaaaaaaaa".into(), "bbbbbbbbbbbbbbbb".into()], ..Assume::default() };
    let used = evaluate(3, &p, "dispatch", &Inputs { now, keys: &f.keys, codex_homes: &f.homes, spend: &f.spend, cswap: &f.cswap,
        codex: &f.codex, machines: &f.machines, machine: Some("local"), exclude: &[], harness: None, unavailable: &[], level: None, tier: Some("strong"),
        tier_source: Some("template"), assume: &assume });
    assert_eq!(states(&used), [("c-pool".into(), "skipped".into()), ("c-deepseek".into(), "skipped".into()), ("c-codex".into(), "chosen".into())]);
    assert_eq!(codes(&used, "c-deepseek"), ["tierNotServed"]);

    let any = f.run_tier(&p, now, None, None);
    assert_eq!(any.record["chosen"], "c-pool", "no tier: the first that holds");
    assert!(any.record.get("tier").is_none() && any.record.get("tierSource").is_none(), "{}", any.record);
    assert!(serves(&json!({}), Some("fast")) && serves(&json!({"tiers": ["strong", "fast"]}), Some("fast")));
    assert!(!serves(&json!({"tiers": ["strong"]}), Some("fast")) && serves(&json!({"tiers": ["strong"]}), None));
}

/// YN-139: a machine condition names the machines a candidate may run on, this Core host
/// as `local`; no machine (a preview, `auto`) is this Core host. A pool still runs on this
/// Core host only, whatever its conditions, and the condition itself is never unknown.
#[test]
fn a_machine_condition_lets_a_login_run_only_on_the_machines_it_names() {
    let f = Fixture::new();
    let none = Assume::default();
    let only = |machines: Value| json!({"enabled": true, "whenNone": "wait", "candidates": [
        {"id": "c-pool", "enabled": true, "harness": "claude", "model": "opus",
         "credential": {"kind": "pool", "manager": "cswap", "accounts": "all"}, "conditions": []},
        {"id": "c-mac", "enabled": true, "harness": "claude", "model": "opus", "credential": {"kind": "login"},
         "conditions": [{"kind": "machine", "machines": machines}]}]});
    let p = only(json!(["lab-mac"]));
    // On the Mac: the pool is this Core host's only, so the Mac's own login.
    let mac = f.run(&p, utc(9, 12, 0), Some("lab-mac"), &[], &none);
    assert_eq!(states(&mac), [("c-pool".into(), "skipped".into()), ("c-mac".into(), "chosen".into())], "{}", mac.record);
    assert_eq!((codes(&mac, "c-pool"), codes(&mac, "c-mac")), (vec!["hostOnly".to_owned()], vec![]));
    assert_eq!(mac.profile, None, "the Mac's own login");
    // Here, named or not: the pool, as before; with it off, the Mac's login is passed over, saying why.
    for machine in [Some("local"), None] {
        assert_eq!(f.run(&p, utc(9, 12, 0), machine, &[], &none).record["chosen"], "c-pool", "{machine:?}");
        let mut off = p.clone();
        off["candidates"][0]["enabled"] = json!(false);
        let route = f.run(&off, utc(9, 12, 0), machine, &[], &none);
        assert_eq!((route.record["chosen"].clone(), codes(&route, "c-mac")), (Value::Null, vec!["otherMachine".to_owned()]), "{machine:?}");
        let why = &route.record["candidates"][1]["reasons"][0];
        assert_eq!((why["message"].clone(), why["messageZh"].clone(), why["params"]["machine"].clone()),
            (json!("It runs only on the machines its condition names"), json!("它只在条件里选的机器上跑"), json!(machine)));
    }
    // Another machine it doesn't name.
    let mut off = p.clone();
    off["candidates"][0]["enabled"] = json!(false);
    assert_eq!(codes(&f.run(&off, utc(9, 12, 0), Some("lab-linux"), &[], &none), "c-mac"), ["otherMachine"]);
    // Naming this Core host too: chosen with no machine named, so never `unknownCondition`.
    let mut both = only(json!(["local", "lab-mac"]));
    both["candidates"][0]["enabled"] = json!(false);
    let route = f.run(&both, utc(9, 12, 0), None, &[], &none);
    assert_eq!((route.record["chosen"].clone(), codes(&route, "c-mac")), (json!("c-mac"), vec![]), "{}", route.record);
    // A pool that names the Mac still runs here only: the condition widens nothing.
    let mut pool = p.clone();
    pool["candidates"][0]["conditions"] = json!([{"kind": "machine", "machines": ["lab-mac"]}]);
    pool["candidates"][1]["enabled"] = json!(false);
    assert_eq!(codes(&f.run(&pool, utc(9, 12, 0), Some("lab-mac"), &[], &none), "c-pool"), ["hostOnly"]);
    assert_eq!(codes(&f.run(&pool, utc(9, 12, 0), Some("local"), &[], &none), "c-pool"), ["otherMachine"]);
    assert!(machine_allows(&json!({"conditions": []}), Some("lab-mac")) && machine_allows(&json!({}), None), "no machine condition: anywhere");
}

/// YN-150: `soonestReset` takes the account whose week resets first, even with
/// less of the week left; a reset that is not known, or has already passed,
/// comes after one that is ahead.
#[test]
fn soonest_reset_takes_the_earliest_reset_even_with_less_left() {
    let mut f = Fixture::new();
    f.cswap = cswap_resets(&[(80.0, Some("2026-11-09T11:00:00+00:00")), (30.0, Some("2026-11-09T10:00:00+00:00"))]);
    let route = f.run(&pool_pick(Some("soonestReset"), None), utc(9, 9, 0), Some("local"), &[], &Assume::default());
    assert_eq!(route.record["account"], json!({"number": 2, "fingerprint": "bbbbbbbbbbbbbbbb"}), "{}", route.record);
    // Each row says what the choice read: the week left and when it resets.
    assert_eq!(account_rows(&route), [
        json!({"number": 1, "fingerprint": "aaaaaaaaaaaaaaaa", "state": "ok", "weekLeftPct": 80.0, "resetsAt": "2026-11-09T11:00:00+00:00"}),
        json!({"number": 2, "fingerprint": "bbbbbbbbbbbbbbbb", "state": "pick", "weekLeftPct": 30.0, "resetsAt": "2026-11-09T10:00:00+00:00"}),
    ]);
}

/// YN-150: a quota condition still comes first: an account below it is passed
/// over even when its week resets first.
#[test]
fn soonest_reset_passes_over_an_account_below_the_week_it_wants() {
    let mut f = Fixture::new();
    f.cswap = cswap_resets(&[(80.0, Some("2026-11-09T11:00:00+00:00")), (20.0, Some("2026-11-09T10:00:00+00:00"))]);
    let route = f.run(&pool_pick(Some("soonestReset"), Some(30.0)), utc(9, 9, 0), Some("local"), &[], &Assume::default());
    assert_eq!(route.record["account"], json!({"number": 1, "fingerprint": "aaaaaaaaaaaaaaaa"}), "{}", route.record);
    let rows = account_rows(&route);
    assert_eq!((rows[0]["state"].clone(), rows[1]["state"].clone()), (json!("pick"), json!("low")), "{}", route.record);
}

/// YN-150: a reset that has passed (the reading is not refreshed yet) or that
/// the reading does not know comes after one still ahead; those two are ordered
/// by the week left, then the lower number, as `mostRemaining` orders.
#[test]
fn soonest_reset_puts_unknown_and_passed_resets_last_then_by_week_left() {
    let mut f = Fixture::new();
    // #1's reset was at 09:00, an hour before now; #2's is ahead but it is below
    // the week the pool wants; #3's reading knows no reset time.
    f.cswap = cswap_resets(&[(70.0, Some("2026-11-09T09:00:00+00:00")), (5.0, Some("2026-11-09T11:00:00+00:00")), (60.0, None)]);
    let route = f.run(&pool_pick(Some("soonestReset"), Some(20.0)), utc(9, 10, 0), Some("local"), &[], &Assume::default());
    assert_eq!(route.record["account"], json!({"number": 1, "fingerprint": "aaaaaaaaaaaaaaaa"}), "{}", route.record);
    // A row keeps the week left it read, and a reset time only when there is one.
    let rows = account_rows(&route);
    assert_eq!((rows[2]["weekLeftPct"].clone(), rows[2].get("resetsAt").cloned()), (json!(60.0), None), "{}", route.record);
}

/// YN-150: a stale reading is read as before: a quota condition makes the
/// accounts unknown, and without one the lowest number is taken. No reset time
/// is taken from a reading that is not fresh.
#[test]
fn a_stale_reading_picks_as_before_under_soonest_reset() {
    let mut f = Fixture::new();
    f.cswap = cswap_resets(&[(80.0, Some("2026-11-09T11:00:00+00:00")), (30.0, Some("2026-11-09T10:00:00+00:00"))]);
    f.cswap["stale"] = json!(true);
    let route = f.run(&pool_pick(Some("soonestReset"), Some(30.0)), utc(9, 9, 0), Some("local"), &[], &Assume::default());
    assert_eq!((states(&route), codes(&route, "c-pool")), (vec![("c-pool".into(), "unknown".to_owned())], vec!["quotaUnknown".to_owned()]), "{}", route.record);
    assert!(account_rows(&route).iter().all(|r| r.get("weekLeftPct").is_none() && r.get("resetsAt").is_none()), "{}", route.record);
    let route = f.run(&pool_pick(Some("soonestReset"), None), utc(9, 9, 0), Some("local"), &[], &Assume::default());
    assert_eq!(route.record["account"], json!({"number": 1, "fingerprint": "aaaaaaaaaaaaaaaa"}), "{}", route.record);
}

/// YN-150: under `soonestReset` a reading that shows nothing left is used up,
/// even with no quota condition, so the pool moves to the next account.
/// `mostRemaining` is unchanged: the fullest is taken anyway, and a 0% reading
/// is only marked.
#[test]
fn soonest_reset_counts_an_account_whose_reading_shows_nothing_left_as_used_up() {
    let mut f = Fixture::new();
    f.cswap = cswap_resets(&[(0.0, Some("2026-11-09T10:00:00+00:00")), (50.0, Some("2026-11-09T11:00:00+00:00"))]);
    let now = utc(9, 9, 0);
    let route = f.run(&pool_pick(Some("soonestReset"), None), now, Some("local"), &[], &Assume::default());
    let rows = account_rows(&route);
    assert_eq!((rows[0]["state"].clone(), rows[1]["state"].clone()), (json!("low"), json!("pick")), "{}", route.record);
    let route = f.run(&pool_pick(Some("mostRemaining"), None), now, Some("local"), &[], &Assume::default());
    assert_eq!(account_rows(&route)[0]["state"], "ok", "{}", route.record);
}

/// YN-150: no `pick`, `mostRemaining`, and a value a later Core wrote read the
/// same: the account with the most of its week left.
#[test]
fn no_pick_and_a_pick_this_core_does_not_know_read_as_most_remaining() {
    let mut f = Fixture::new();
    f.cswap = cswap_resets(&[(80.0, Some("2026-11-09T11:00:00+00:00")), (30.0, Some("2026-11-09T10:00:00+00:00"))]);
    let now = utc(9, 9, 0);
    let none = Assume::default();
    let most = f.run(&pool_pick(Some("mostRemaining"), None), now, Some("local"), &[], &none);
    assert_eq!(most.record["account"]["number"], 1, "the most left, as before");
    for pick in [None, Some("laterPickValue")] {
        let route = f.run(&pool_pick(pick, None), now, Some("local"), &[], &none);
        assert_eq!(route.record, most.record, "{pick:?} is read as mostRemaining");
    }
}

/// YN-150 with YN-138: an account that left the pool is replaced by the same
/// rule — the earliest reset of those left, not the fullest.
#[test]
fn pick_other_uses_the_pool_pick_rule_too() {
    let mut f = Fixture::new();
    f.cswap = cswap_resets(&[(80.0, Some("2026-11-09T11:00:00+00:00")), (30.0, Some("2026-11-09T10:00:00+00:00")),
        (90.0, Some("2026-11-09T12:00:00+00:00"))]);
    let none = Assume::default();
    let now = utc(9, 9, 0);
    let inputs = Inputs { now, keys: &f.keys, codex_homes: &f.homes, spend: &f.spend, cswap: &f.cswap, codex: &f.codex, machines: &f.machines,
        machine: Some("local"), exclude: &[], harness: None, unavailable: &[], level: None, tier: None, tier_source: None, assume: &none };
    let p = pool_pick(Some("soonestReset"), None);
    // Account 2's week resets first, but it left; account 1 is next, not the fullest (3).
    assert_eq!(pick_other(&p["candidates"][0], &inputs, "bbbbbbbbbbbbbbbb"), Some(("aaaaaaaaaaaaaaaa".into(), 1)));
}

/// A machine's own logins as the readings keep them (YN-175): the share of the
/// week its Claude Code login (claude-swap's default account there) and its
/// Codex login have left; `None` for one not read there.
fn machine_row(id: &str, claude: Option<f64>, codex: Option<f64>) -> Value {
    let part = |left: f64, source: &str| json!({"week": {"leftPct": left, "resetsAt": "2026-11-12T09:00:00+00:00"}, "source": source});
    let mut row = json!({"machine": id, "name": "Mac mini", "observedAt": "2026-11-09T11:58:00+00:00", "stale": false});
    if let Some(left) = claude {
        row["claude"] = part(left, "cswap");
    }
    if let Some(left) = codex {
        row["codex"] = part(left, "codex");
    }
    row
}

/// One login of `harness` that wants 20% of its week left, with its `unknown` rule.
fn login_with_quota(harness: &str, unknown: &str) -> Value {
    json!({"enabled": true, "whenNone": "wait", "candidates": [{"id": "c-login", "enabled": true, "harness": harness, "model": "",
        "credential": {"kind": "login"}, "conditions": [{"kind": "quota", "weekLeftPct": 20}], "unknown": unknown}]})
}

impl Fixture {
    /// This host's own logins, Claude Code's (claude-swap's active account) and Codex's, with `left` of their week.
    fn host_left(&mut self, left: f64) {
        self.cswap = cswap(&[left]);
        self.codex = vec![codex_login(left)];
    }

    /// The Settings page's preview: no machine named, this Core host.
    fn preview(&self, policy: &Value, now: DateTime<Utc>) -> Route {
        evaluate(3, policy, "preview", &Inputs { now, keys: &self.keys, codex_homes: &self.homes, spend: &self.spend,
            cswap: &self.cswap, codex: &self.codex, machines: &self.machines, machine: None, exclude: &[], harness: None, unavailable: &[],
            level: None, tier: None, tier_source: None, assume: &Assume::default() })
    }
}

/// YN-175 (the user's decision of 2026-11-16): a login on another machine is
/// that machine's own, so its quota condition reads that machine's reading and
/// never this Core host's, Claude Code's and Codex's alike.
#[test]
fn a_login_on_another_machine_is_judged_by_that_machines_own_quota_never_this_hosts() {
    let none = Assume::default();
    for harness in ["claude", "codex"] {
        let mut f = Fixture::new();
        let p = login_with_quota(harness, "skip");
        // This host has plenty, the Mac mini nothing read yet: unknown there, not this host's 90%.
        f.host_left(90.0);
        let route = f.run(&p, utc(9, 12, 0), Some("mac-mini"), &[], &none);
        assert_eq!((states(&route)[0].1.as_str(), codes(&route, "c-login")), ("unknown", vec!["quotaUnknown".to_owned()]), "{harness}: {}", route.record);
        let why = &route.record["candidates"][0]["reasons"][0];
        assert_eq!((why["params"].clone(), why["messageZh"].clone()), (json!({"machine": "mac-mini", "cause": "noReading"}), json!("还没有 mac-mini 的额度读数")));
        // This host is used up, the Mac mini's own login has 80% left: chosen there, by that reading.
        f.host_left(0.0);
        f.machines = vec![machine_row("mac-mini", Some(80.0), Some(80.0))];
        let route = f.run(&p, utc(9, 12, 0), Some("mac-mini"), &[], &none);
        assert_eq!(route.record["chosen"], json!("c-login"), "{harness}: {}", route.record);
        assert_eq!(route.record["candidates"][0]["readings"], json!([{"what": "weekLeft", "value": 80.0, "observedAt": "2026-11-09T11:58:00+00:00",
            "source": if harness == "claude" { "cswap" } else { "codex" }, "machine": "mac-mini"}]));
        // Here the same candidate reads this host's own, used up.
        let route = f.run(&p, utc(9, 12, 0), Some("local"), &[], &none);
        assert_eq!(codes(&route, "c-login"), ["quotaLow"], "{harness}: {}", route.record);
        assert_eq!(route.record["candidates"][0]["readings"][0]["value"], json!(0.0));
        // This host has plenty, the Mac mini 5%: low there, said with the machine's name, until its week resets.
        f.host_left(90.0);
        f.machines = vec![machine_row("mac-mini", Some(5.0), Some(5.0))];
        let route = f.run(&p, utc(9, 12, 0), Some("mac-mini"), &[], &none);
        let why = &route.record["candidates"][0]["reasons"][0];
        assert_eq!((why["code"].clone(), why["message"].clone(), why["messageZh"].clone(), why["params"]["machine"].clone()),
            (json!("quotaLow"), json!("On Mac mini, 5% of the weekly quota is left, below 20%"), json!("Mac mini 上本周额度只剩 5%，低于 20%"),
                json!("mac-mini")), "{harness}: {}", route.record);
        assert_eq!(route.record["earliest"], json!({"at": "2026-11-12T09:00:00+00:00", "candidate": "c-login"}));
        // Another machine's reading is that machine's only.
        f.machines = vec![machine_row("lab-linux", Some(80.0), Some(80.0))];
        assert_eq!(codes(&f.run(&p, utc(9, 12, 0), Some("mac-mini"), &[], &none), "c-login"), ["quotaUnknown"]);
    }
}

/// YN-175: a machine's reading that is stale, or says why it isn't known, is
/// unknown; the candidate's own rule decides, `skip` or `pass`, as for this host.
#[test]
fn a_machines_quota_not_known_is_unknown_and_the_candidates_rule_decides() {
    let mut f = Fixture::new();
    f.host_left(90.0);
    let none = Assume::default();
    let mut stale = machine_row("mac-mini", Some(80.0), Some(80.0));
    stale["stale"] = json!(true);
    let mut contained = machine_row("mac-mini", None, None);
    contained["claude"] = json!({"unknown": {"code": "containedLogin", "message": "On Mac mini, Claude keeps its own folders; that login's quota isn't read",
        "messageZh": "Mac mini 上的 Claude 用自己的会话目录，读不到那份登录的额度"}, "source": "cswap"});
    let no_week = {
        let mut row = machine_row("mac-mini", None, None);
        row["codex"] = json!({"source": "codex"});
        row
    };
    for (row, harness, cause, zh) in [
        (stale.clone(), "codex", "stale", "Mac mini 的额度读数已超过 10 分钟"),
        (stale, "claude", "stale", "Mac mini 的额度读数已超过 10 分钟"),
        (contained.clone(), "claude", "containedLogin", "Mac mini 上的 Claude 用自己的会话目录，读不到那份登录的额度"),
        // No Codex read there (a contained machine runs none): no reading.
        (contained, "codex", "noReading", "还没有 Mac mini 的额度读数"),
        (no_week, "codex", "noWeek", "Mac mini 上的本周额度此刻不清楚"),
    ] {
        f.machines = vec![row];
        let skip = f.run(&login_with_quota(harness, "skip"), utc(9, 12, 0), Some("mac-mini"), &[], &none);
        assert_eq!((skip.record["chosen"].clone(), states(&skip)[0].1.clone()), (Value::Null, "unknown".to_owned()), "{harness} {cause}: {}", skip.record);
        let pass = f.run(&login_with_quota(harness, "pass"), utc(9, 12, 0), Some("mac-mini"), &[], &none);
        let why = &pass.record["candidates"][0]["reasons"][0];
        assert_eq!((pass.record["chosen"].clone(), why["code"].clone(), why["params"]["cause"].clone(), why["messageZh"].clone()),
            (json!("c-login"), json!("quotaUnknown"), json!(cause), json!(zh)), "{harness} {cause}: {}", pass.record);
        assert_eq!(pass.record["candidates"][0]["readings"], json!([]), "nothing known is shown as read");
    }
}

/// YN-175: the Settings page's preview judges this Core host, and lists under a
/// login with a quota condition its quota on each machine it may run on.
#[test]
fn a_preview_lists_a_logins_quota_on_each_machine_it_may_run_on() {
    let mut f = Fixture::new();
    f.codex = vec![codex_login(40.0)];
    let mut down = json!({"machine": "lab-linux", "name": "lab-linux", "observedAt": "2026-11-09T11:58:00+00:00", "stale": false,
        "codex": {"unknown": {"code": "machineUnreachable", "message": "Couldn't reach lab-linux to read its quota",
            "messageZh": "连不上 lab-linux，读不到它的额度"}, "source": "codex"}});
    // A machine with only a Claude reading (Codex runs on no contained machine) isn't listed for Codex.
    f.machines = vec![machine_row("mac-mini", None, Some(12.0)), down.take(), machine_row("boxed", Some(50.0), None)];
    let route = f.preview(&login_with_quota("codex", "skip"), utc(9, 12, 0));
    assert_eq!(route.record["chosen"], json!("c-login"), "this host has 40%: {}", route.record);
    let rows = route.record["candidates"][0]["machines"].as_array().unwrap().clone();
    let brief: Vec<(Value, Value, Value)> = rows.iter().map(|r| (r["machine"].clone(), r["state"].clone(), r["weekLeftPct"].clone())).collect();
    assert_eq!(brief, [(json!("local"), json!("ok"), json!(40.0)), (json!("mac-mini"), json!("low"), json!(12.0)), (json!("lab-linux"), json!("unknown"), Value::Null)],
        "{}", route.record);
    assert_eq!((rows[0].get("name"), rows[1]["name"].clone(), rows[1]["resetsAt"].clone()), (None, json!("Mac mini"), json!("2026-11-12T09:00:00+00:00")));
    assert_eq!((rows[1]["reason"]["code"].clone(), rows[2]["reason"]["code"].clone(), rows[2]["reason"]["params"]["cause"].clone()),
        (json!("quotaLow"), json!("quotaUnknown"), json!("machineUnreachable")));
    assert!(rows[0].get("reason").is_none());
    // A machine condition: only the machines it names.
    let mut p = login_with_quota("codex", "skip");
    p["candidates"][0]["conditions"].as_array_mut().unwrap().push(json!({"kind": "machine", "machines": ["mac-mini"]}));
    let rows = f.preview(&p, utc(9, 12, 0)).record["candidates"][0]["machines"].clone();
    assert_eq!(rows.as_array().unwrap().iter().map(|r| r["machine"].clone()).collect::<Vec<_>>(), [json!("mac-mini")]);
    // A dispatch's record has no such list.
    assert!(f.run(&login_with_quota("codex", "skip"), utc(9, 12, 0), Some("local"), &[], &Assume::default()).record["candidates"][0].get("machines").is_none());
}
