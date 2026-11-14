//! `left` and `account_left`: one case for each code, and what decides nothing (YN-138). Synthetic values only.
use super::*;

const FP2: &str = "fp-account-2";
const FP3: &str = "fp-account-3";

fn pool(accounts: Value) -> Value {
    json!({"id": "c-claude", "enabled": true, "harness": "claude", "model": "opus",
        "credential": {"kind": "pool", "accounts": accounts}, "conditions": []})
}

fn policy(candidates: Vec<Value>) -> Value {
    json!({"enabled": true, "whenNone": "wait", "candidates": candidates})
}

fn route(chosen: &str) -> Value {
    json!({"chosen": chosen, "account": {"number": 2, "fingerprint": FP2}})
}

/// A fresh claude-swap reading listing `numbers`.
fn cswap(listed: &[(u64, &str)]) -> Value {
    json!({"accounts": listed.iter().map(|(n, f)| json!({"number": n, "fingerprint": f})).collect::<Vec<_>>(), "stale": false})
}

fn account(fp: &str) -> RuntimeProfile {
    RuntimeProfile::ClaudeAccount { fingerprint: fp.into() }
}

fn code(left: Option<Left>) -> Option<&'static str> {
    left.map(|l| l.code)
}

#[test]
fn an_account_still_in_its_pool_and_listed_has_not_left() {
    let p = policy(vec![pool(json!([FP2, FP3]))]);
    let both = cswap(&[(2, FP2), (3, FP3)]);
    assert_eq!(left(&p, &route("c-claude"), Some(&account(FP2)), &[], &[], &both), None);
    let all = policy(vec![pool(json!("all"))]);
    assert_eq!(left(&all, &route("c-claude"), Some(&account(FP2)), &[], &[], &both), None, "a pool of all its accounts");
}

#[test]
fn a_removed_or_turned_off_candidate_has_left() {
    let both = cswap(&[(2, FP2), (3, FP3)]);
    let other = json!({"id": "c-codex", "enabled": true, "harness": "codex", "credential": {"kind": "login"}, "conditions": []});
    let gone = left(&policy(vec![other]), &route("c-claude"), Some(&account(FP2)), &[], &[], &both).unwrap();
    assert_eq!((gone.code, gone.message.as_str(), gone.message_zh.as_str()),
        ("candidateRemoved", "Its candidate c-claude was removed from the routing policy", "它的候选 c-claude 已从路由策略里删掉"));
    let mut off = pool(json!([FP2]));
    off["enabled"] = json!(false);
    assert_eq!(code(left(&policy(vec![off]), &route("c-claude"), Some(&account(FP2)), &[], &[], &both)), Some("candidateOff"));
}

#[test]
fn an_account_taken_out_of_its_pool_has_left_whatever_the_readings_say() {
    let p = policy(vec![pool(json!([FP3]))]);
    for readings in [cswap(&[(2, FP2), (3, FP3)]), Value::Null, json!({"accounts": [], "stale": true})] {
        let gone = left(&p, &route("c-claude"), Some(&account(FP2)), &[], &[], &readings).unwrap();
        assert_eq!((gone.code, gone.message_zh.as_str()), ("accountLeftPool", "它绑定的 claude-swap 账号 2 已移出候选的账号池"), "{readings}");
    }
    assert_eq!(account_left(&p, &route("c-claude"), FP2, &Value::Null).map(|l| l.code), Some("accountLeftPool"));
}

#[test]
fn an_account_claude_swap_no_longer_lists_has_left_only_by_a_fresh_available_reading() {
    let p = policy(vec![pool(json!("all"))]);
    let listed_without = cswap(&[(3, FP3)]);
    let gone = account_left(&p, &route("c-claude"), FP2, &listed_without).unwrap();
    assert_eq!((gone.code, gone.message.as_str()), ("accountNotListed", "claude-swap no longer lists its account 2"));
    assert_eq!(code(left(&p, &route("c-claude"), Some(&account(FP2)), &[], &[], &listed_without)), Some("accountNotListed"));
    // Missing, stale or unavailable: not known, so nothing has left.
    let mut stale = listed_without.clone();
    stale["stale"] = json!(true);
    let unavailable = json!({"accounts": [], "unavailable": {"code": "cswapFailed"}, "stale": false});
    for readings in [Value::Null, stale, unavailable] {
        assert_eq!(account_left(&p, &route("c-claude"), FP2, &readings), None, "{readings}");
    }
}

#[test]
fn a_candidate_whose_credential_is_another_now_has_left() {
    let both = cswap(&[(2, FP2), (3, FP3)]);
    let key = |id: &str| json!({"id": "c-claude", "enabled": true, "harness": "claude", "credential": {"kind": "apiKey", "keyId": id}, "conditions": []});
    let home = |id: &str| json!({"id": "c-claude", "enabled": true, "harness": "codex", "credential": {"kind": "codexHome", "id": id}, "conditions": []});
    let login = json!({"id": "c-claude", "enabled": true, "harness": "claude", "credential": {"kind": "login"}, "conditions": []});
    let keys = ["anthropic-a".to_owned(), "anthropic-b".to_owned()];
    let homes = ["work".to_owned(), "home".to_owned()];
    let api = RuntimeProfile::ApiKey { key_id: "anthropic-a".into() };
    let codex = RuntimeProfile::CodexHome { id: "work".into() };
    let cases: Vec<(Value, Option<&RuntimeProfile>, Option<&str>)> = vec![
        (key("anthropic-a"), Some(&api), None),
        (key("anthropic-b"), Some(&api), Some("credentialChanged")),
        (home("work"), Some(&codex), None),
        (home("home"), Some(&codex), Some("credentialChanged")),
        (login.clone(), None, None),
        (login, Some(&api), Some("credentialChanged")),
        (pool(json!([FP2])), Some(&api), Some("credentialChanged")),
        (pool(json!([FP2])), None, Some("credentialChanged")),
        (key("anthropic-a"), Some(&codex), Some("credentialChanged")),
    ];
    for (candidate, profile, want) in cases {
        let got = code(left(&policy(vec![candidate.clone()]), &route("c-claude"), profile, &keys, &homes, &both));
        assert_eq!(got, want, "{candidate} with {profile:?}");
    }
}

#[test]
fn a_key_or_codex_home_that_is_gone_has_left() {
    let key = json!({"id": "c-key", "enabled": true, "harness": "opencode", "credential": {"kind": "apiKey", "keyId": "deepseek"}, "conditions": []});
    let home = json!({"id": "c-home", "enabled": true, "harness": "codex", "credential": {"kind": "codexHome", "id": "work"}, "conditions": []});
    let p = policy(vec![key, home]);
    let gone = left(&p, &json!({"chosen": "c-key"}), Some(&RuntimeProfile::ApiKey { key_id: "deepseek".into() }), &[], &[], &Value::Null).unwrap();
    assert_eq!((gone.code, gone.message.as_str()), ("keyMissing", "The routing key deepseek is not set"));
    let gone = left(&p, &json!({"chosen": "c-home"}), Some(&RuntimeProfile::CodexHome { id: "work".into() }), &[], &[], &Value::Null).unwrap();
    assert_eq!((gone.code, gone.message_zh.as_str()), ("homeMissing", "Codex 目录 work 已不在列表里"));
}

#[test]
fn nothing_has_left_while_routing_is_off_for_a_route_that_chose_none_or_for_a_credential_this_core_does_not_know() {
    let mut off = policy(vec![pool(json!([FP3]))]);
    off["enabled"] = json!(false);
    assert_eq!(left(&off, &route("c-claude"), Some(&account(FP2)), &[], &[], &cswap(&[(3, FP3)])), None);
    assert_eq!(account_left(&off, &route("c-claude"), FP2, &cswap(&[(3, FP3)])), None);
    let p = policy(vec![pool(json!([FP3]))]);
    assert_eq!(left(&p, &json!({"chosen": null}), Some(&account(FP2)), &[], &[], &Value::Null), None);
    let later = json!({"id": "c-claude", "enabled": true, "harness": "claude", "credential": {"kind": "vault"}, "conditions": []});
    assert_eq!(left(&policy(vec![later]), &route("c-claude"), Some(&account(FP2)), &[], &[], &Value::Null), None);
}

#[test]
fn a_reason_reads_as_a_routes_reason() {
    let gone = Left::new("candidateOff", "Its candidate c-claude was turned off", "它的候选 c-claude 已关掉");
    assert_eq!(gone.reason(), json!({"code": "candidateOff", "message": "Its candidate c-claude was turned off", "messageZh": "它的候选 c-claude 已关掉"}));
}
