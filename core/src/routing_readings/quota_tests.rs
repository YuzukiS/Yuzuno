//! Subscription quotas (YN-34 S2b), against a stub `cswap` and a stub Codex.
//! Synthetic accounts only; nothing here asks a real service.
use super::*;
use crate::routing_accounts::CodexHome;
use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}};
use std::{fs, os::unix::fs::PermissionsExt, path::Path};
use tower::ServiceExt;

fn script(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn python3() -> Option<std::path::PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).map(|dir| dir.join("python3")).find(|p| p.is_file())
}

#[test]
fn only_an_enabled_policy_that_reads_quotas_needs_them() {
    let claude_pool = json!({"enabled": true, "harness": "claude", "credential": {"kind": "pool"}, "conditions": []});
    let claude_login_quota = json!({"enabled": true, "harness": "claude", "credential": {"kind": "login"}, "conditions": [{"kind": "quota"}]});
    let codex_home_quota = json!({"enabled": true, "harness": "codex", "credential": {"kind": "codexHome"}, "conditions": [{"kind": "quota"}]});
    let codex_home_plain = json!({"enabled": true, "harness": "codex", "credential": {"kind": "codexHome"}, "conditions": []});
    let off = |mut c: Value| { c["enabled"] = json!(false); c };
    for (enabled, candidates, want) in [
        (true, vec![claude_pool.clone()], Needs { cswap: true, codex: false }),
        (true, vec![claude_login_quota.clone(), codex_home_quota.clone()], Needs { cswap: true, codex: true }),
        (true, vec![codex_home_plain.clone()], Needs::default()),
        (true, vec![off(claude_pool.clone()), off(codex_home_quota.clone())], Needs::default()),
        (false, vec![claude_pool, codex_home_quota], Needs::default()),
    ] {
        assert_eq!(needs(&json!({"enabled": enabled, "candidates": candidates})), want, "{enabled} {candidates:?}");
    }
}

#[test]
fn codex_windows_are_taken_by_their_length_and_say_what_is_left() {
    let limits = json!({"rateLimits": {"limitId": "codex",
        "primary": {"usedPercent": 30, "windowDurationMins": 300, "resetsAt": 1794120000},
        "secondary": {"usedPercent": 85.5, "windowDurationMins": 10080, "resetsAt": 1794500000}}});
    assert_eq!(codex_windows(&limits), json!({
        "fiveHour": {"leftPct": 70.0, "resetsAt": "2026-11-08T06:40:00+00:00"},
        "week": {"leftPct": 14.5, "resetsAt": "2026-11-12T16:13:20+00:00"}}));
    let by_id = json!({"rateLimitsByLimitId": {"other": {"primary": {"usedPercent": 1}},
        "codex": {"secondary": {"usedPercent": 120, "windowDurationMins": 10080}}}});
    assert_eq!(codex_windows(&by_id), json!({"week": {"leftPct": 0.0, "resetsAt": null}}), "the codex limit, and never below 0");
}

#[tokio::test]
async fn a_refresh_keeps_each_accounts_quota_and_the_readings_show_it_without_emails() {
    let Some(python) = python3() else { eprintln!("skipped: no python3 on PATH"); return };
    let dir = tempfile::tempdir().unwrap();
    // A stub Codex: the host's login has 30%/85% used, the listed home 50%/10%.
    let codex = dir.path().join("codex");
    script(&codex, &format!(r#"#!{}
import json, os, sys
home = os.environ.get("CODEX_HOME")
used = (50, 10) if home else (30, 85)
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    m = msg.get("method")
    if m == "account/read":
        result = {{"account": {{"type": "chatgpt", "email": "person@example.com", "planType": "plus"}}}}
    elif m == "account/rateLimits/read":
        result = {{"rateLimits": {{"limitId": "codex",
            "primary": {{"usedPercent": used[0], "windowDurationMins": 300, "resetsAt": 1794120000}},
            "secondary": {{"usedPercent": used[1], "windowDurationMins": 10080, "resetsAt": 1794500000}}}}}}
    else:
        result = {{}}
    print(json.dumps({{"id": msg["id"], "result": result}}), flush=True)
"#, python.display()));
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), codex.display().to_string()).unwrap();
    let home = dir.path().join("codex-work");
    fs::create_dir(&home).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    ws.store.save_codex_homes(&[CodexHome { id: "work".into(), label: "Work".into(), home: home.display().to_string() }]).unwrap();
    // A stub cswap: account 1 at 25% and 16% used, account 2 with no usage.
    fs::write(dir.path().join("list.json"), r#"{"schemaVersion":1,"activeAccountNumber":1,"accounts":[
 {"number":1,"email":"person@example.com","organizationUuid":null,"active":true,"usageStatus":"ok",
  "usage":{"fiveHour":{"pct":25.0,"resetsAt":"2026-11-08T10:00:00Z"},"sevenDay":{"pct":16.0,"resetsAt":"2026-11-12T18:00:00Z"}}},
 {"number":2,"email":"other@example.com","organizationUuid":"org-1","active":false,"usageStatus":"token_expired","usage":null}]}"#).unwrap();
    let cswap = dir.path().join("cswap");
    script(&cswap, &format!("#!/bin/sh\ncat '{}'\n", dir.path().join("list.json").display()));
    ws.store.save_cswap_settings(&crate::routing_accounts::CswapSettings { command: cswap.display().to_string() }).unwrap();

    ws.refresh_quotas(&Needs { cswap: true, codex: true }).await.unwrap();

    let app = crate::server::router(ws.clone(), dir.path().join("assets"));
    let request = Request::builder().uri("/api/routing/readings").header("host", "127.0.0.1:4317").header("x-yuzuno-client", "desktop")
        .body(Body::empty()).unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = String::from_utf8(to_bytes(response.into_body(), 1 << 20).await.unwrap().to_vec()).unwrap();
    assert!(!body.contains('@'), "no email anywhere: {body}");
    let read: Value = serde_json::from_str(&body).unwrap();
    let accounts = read["cswap"]["accounts"].as_array().unwrap();
    assert_eq!((accounts[0]["number"].clone(), accounts[0]["fiveHour"]["leftPct"].clone(), accounts[0]["week"]["leftPct"].clone()),
        (json!(1), json!(75.0), json!(84.0)), "what is left, not what is used: {read}");
    assert_eq!(accounts[0]["fiveHour"]["resetsAt"], "2026-11-08T10:00:00Z");
    assert!(accounts[0].get("unknown").is_none() && accounts[1]["unknown"]["code"] == "usage:token_expired", "{read}");
    assert_eq!((read["cswap"]["stale"].clone(), read["cswap"]["observedAt"].is_string()), (json!(false), true));
    let codex = read["codex"].as_array().unwrap();
    let left = |home: &str| codex.iter().find(|c| c["home"] == home).map(|c| (c["fiveHour"]["leftPct"].clone(), c["week"]["leftPct"].clone()));
    assert_eq!(left("login"), Some((json!(70.0), json!(15.0))), "the host's own login: {read}");
    assert_eq!(left("work"), Some((json!(50.0), json!(90.0))), "the listed home, read in that home: {read}");
    assert!(codex.iter().all(|c| c["source"] == "codex" && c["stale"] == false));

    // claude-swap that cannot be read is kept as unavailable, with its reason.
    ws.store.save_cswap_settings(&crate::routing_accounts::CswapSettings { command: dir.path().join("missing-cswap").display().to_string() }).unwrap();
    ws.refresh_quotas(&Needs { cswap: true, codex: false }).await.unwrap();
    let kept = ws.store.quotas().unwrap();
    let (cswap, _) = view(&kept, Utc::now());
    assert_eq!((cswap["unavailable"]["code"].clone(), cswap["accounts"].clone()), (json!("cswapMissing"), json!([])), "{cswap}");
    assert!(stale(&(Utc::now() - chrono::Duration::seconds(601)).to_rfc3339(), Utc::now()), "over 10 minutes is stale");
}
