//! Choosing a candidate (YN-34 S3b1), on synthetic readings. Pure: nothing is read or started.
use super::*;
use chrono::TimeZone;

fn utc(d: u32, h: u32, m: u32) -> DateTime<Utc> {
    // 2026-11-09 is a Monday.
    Utc.with_ymd_and_hms(2026, 11, d, h, m, 0).unwrap()
}

fn window(left: f64) -> Value {
    json!({"leftPct": left, "resetsAt": "2026-11-09T12:00:00+00:00"})
}

fn cswap(a1: (f64, f64), a2: (f64, f64)) -> Value {
    json!({"observedAt": "x", "stale": false, "accounts": [
        {"number": 1, "fingerprint": "aaaaaaaaaaaaaaaa", "active": true, "source": "cswap", "fiveHour": window(a1.0), "week": window(a1.1)},
        {"number": 2, "fingerprint": "bbbbbbbbbbbbbbbb", "active": false, "source": "cswap", "fiveHour": window(a2.0), "week": window(a2.1)}]})
}

fn policy() -> Value {
    json!({"enabled": true, "whenNone": "wait", "dailyApiCapUsd": 5, "candidates": [
        {"id": "c-pool", "enabled": true, "harness": "claude", "model": "opus",
         "credential": {"kind": "pool", "manager": "cswap", "accounts": "all"},
         "conditions": [{"kind": "quota", "fiveHourLeftPct": 30}]},
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
}

impl Fixture {
    fn new() -> Self {
        Self { keys: vec![("deepseek".into(), Provider::Deepseek, "local")], homes: vec!["work".into()],
            spend: DaySpend { day: "2026-11-09".into(), total_usd: 0.0, by_key: Default::default() },
            cswap: cswap((20.0, 90.0), (50.0, 40.0)), codex: vec![] }
    }

    fn run(&self, policy: &Value, now: DateTime<Utc>, machine: Option<&str>, exclude: &[String], assume: &Assume) -> Route {
        evaluate(3, policy, "dispatch", &Inputs { now, keys: &self.keys, codex_homes: &self.homes, spend: &self.spend,
            cswap: &self.cswap, codex: &self.codex, machine, exclude, harness: None, level: None, assume })
    }

    /// At the executor's first start (`harness`) or dispatch, for a permission level (YN-56).
    fn run_level(&self, policy: &Value, now: DateTime<Utc>, harness: Option<&str>, level: Option<&str>) -> Route {
        evaluate(3, policy, "dispatch", &Inputs { now, keys: &self.keys, codex_homes: &self.homes, spend: &self.spend,
            cswap: &self.cswap, codex: &self.codex, machine: Some("local"), exclude: &[], harness, level, assume: &Assume::default() })
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
    // Account 1 has 20% of its 5 hours left, under 30%; account 2 has min(50, 40) = 40.
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
    f.cswap = cswap((10.0, 90.0), (20.0, 90.0));
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
        "credential": {"kind": "login"}, "conditions": [{"kind": "quota", "fiveHourLeftPct": 10}], "unknown": unknown}]});
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
         "conditions": [{"kind": "quota", "fiveHourLeftPct": 10}]}]});
    assert_eq!(states(&f.run(&login, utc(9, 12, 0), None, &[], &Assume::default())), [("c-login".into(), "chosen".into())]);
    let active_used_up = Assume::from_json(&json!({"accountsUsedUp": ["aaaaaaaaaaaaaaaa"]}));
    let route = f.run(&login, utc(9, 12, 0), None, &[], &active_used_up);
    assert_eq!((states(&route), codes(&route, "c-login")), (vec![("c-login".to_owned(), "skipped".to_owned())], vec!["quotaLow".to_owned()]));
    // A Codex account Core has no reading of yet can be assumed used up too, by its home (YN-49, from a lab Core).
    let codex = json!({"enabled": true, "whenNone": "wait", "candidates": [
        {"id": "c-codex", "enabled": true, "harness": "codex", "model": "gpt-test", "credential": {"kind": "login"}, "unknown": "pass",
         "conditions": [{"kind": "quota", "fiveHourLeftPct": 10}]}]});
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
    assert_eq!(states(&full), [("c-pool".into(), "skipped".into()), ("c-deepseek".into(), "skipped".into()), ("c-codex".into(), "chosen".into())]);
    assert_eq!((codes(&full, "c-pool"), codes(&full, "c-deepseek")), (vec!["levelNotKept".to_owned()], vec!["levelNotKept".to_owned()]));
    let why = &full.record["candidates"][0]["reasons"][0];
    assert_eq!((why["params"].clone(), why["messageZh"].clone()),
        (json!({"level": "full", "harness": "claude"}), json!("它的权限等级是「完全放开」，Claude Code 不支持这个等级")));
    assert_eq!(full.record["level"], "full");
    assert!(full.profile.is_none() && full.record.get("account").is_none(), "Codex on the host's login");
    // Claude Code keeps auto: the pool is chosen as it is with no level.
    let auto = f.run_level(&policy(), at, None, Some("auto"));
    assert_eq!((auto.record["chosen"].clone(), auto.record["level"].clone()), (json!("c-pool"), json!("auto")));
    // No level: as before, and no level in the record.
    let none = f.run_level(&policy(), at, None, None);
    assert_eq!(none.record["chosen"], "c-pool");
    assert!(none.record.get("level").is_none());
    // At a first start, among one harness: OpenCode keeps no level yet, so none can be chosen.
    let start = f.run_level(&policy(), at, Some("opencode"), Some("ask"));
    assert_eq!(start.record["chosen"], Value::Null);
    assert_eq!((codes(&start, "c-pool"), codes(&start, "c-deepseek")), (vec!["otherHarness".to_owned()], vec!["levelNotKept".to_owned()]));
}
