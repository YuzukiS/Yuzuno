//! The routing policy (YN-34 S3a): how it is stored, checked and served. Synthetic values only.
use super::*;
use crate::{routing_accounts::CodexHome, routing_keys::{Secret, Store as KeyStore}, workspace::Workspace};
use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}};
use std::{fs, os::unix::fs::PermissionsExt, sync::Arc};
use tower::ServiceExt;

struct Lab {
    _dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    local: axum::Router,
    remote: axum::Router,
}

fn lab() -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused-codex".into()).unwrap();
    KeyStore::of(&ws.data_dir).put_local("deepseek", Provider::Deepseek, Secret::new("sk-test-yn34-policy-0000".into())).unwrap();
    KeyStore::of(&ws.data_dir).put_local("openai", Provider::Openai, Secret::new("sk-test-yn34-policy-1111".into())).unwrap();
    let home = dir.path().join("codex-work");
    fs::create_dir(&home).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    ws.store.save_codex_homes(&[CodexHome { id: "work".into(), label: "Work".into(), home: home.display().to_string() }]).unwrap();
    let local = crate::server::router(ws.clone(), dir.path().join("assets"));
    let remote = crate::server::remote_router(ws.clone(), dir.path().join("assets"), None,
        crate::server::RemoteEntry::new("https://core.example-tailnet.ts.net:8444", "person@example.com").unwrap());
    Lab { _dir: dir, ws, local, remote }
}

async fn call(app: &axum::Router, method: &str, body: Option<Value>, extra: Vec<(&'static str, String)>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri("/api/routing/policy").header("x-yuzuno-client", "desktop")
        .header("content-type", "application/json");
    builder = if extra.iter().any(|(n, _)| *n == "tailscale-user-login") { builder } else { builder.header("host", "127.0.0.1:4317") };
    for (name, value) in extra {
        builder = builder.header(name, value);
    }
    let response = app.clone().oneshot(builder.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn deepseek() -> Value {
    json!({"id": "c-deepseek", "label": "DeepSeek off-peak", "enabled": true, "harness": "opencode", "model": "deepseek/deepseek-flash",
        "credential": {"kind": "apiKey", "keyId": "deepseek"}, "unknown": "skip",
        "conditions": [
            {"kind": "timeWindow", "inside": false, "minMinutesLeft": 30,
             "schedule": {"timeZone": "UTC", "slots": [{"days": [1,2,3,4,5], "from": "01:00", "to": "04:00"},
                                                      {"days": [1,2,3,4,5], "from": "06:00", "to": "10:00"}]}},
            {"kind": "dailyApiCap", "usd": 2}]})
}

fn policy(candidates: Vec<Value>) -> Value {
    json!({"enabled": true, "whenNone": "wait", "dailyApiCapUsd": 5, "candidates": candidates})
}

#[tokio::test]
async fn a_policy_is_saved_whole_against_its_version_and_keeps_what_a_later_core_added() {
    let lab = lab();
    let (status, read) = call(&lab.local, "GET", None, vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read, json!({"version": 0, "updatedAt": null, "limits": {"candidates": 8}, "policy": empty()}), "never saved: routing off");
    // A later Core's fields: on the policy, a candidate, a condition, and a credential and a condition of kinds it added.
    let mut first = deepseek();
    first["laterField"] = json!({"a": 1});
    first["conditions"][0]["laterToo"] = json!(true);
    let later = json!({"id": "c-later", "enabled": true, "harness": "claude", "model": "",
        "credential": {"kind": "vault", "ref": "x"}, "conditions": [{"kind": "moonPhase", "full": true}]});
    let codex = json!({"id": "c-codex", "enabled": false, "harness": "codex", "model": "gpt-test", "reasoningEffort": "high",
        "credential": {"kind": "codexHome", "id": "work"}, "conditions": [{"kind": "quota", "weekLeftPct": 30}]});
    let claude = json!({"id": "c-pool", "enabled": true, "harness": "claude", "model": "opus",
        "credential": {"kind": "pool", "manager": "cswap", "accounts": "all", "pick": "mostRemaining"},
        "conditions": [{"kind": "quota", "weekLeftPct": 20}], "unknown": "pass"});
    let mut sent = policy(vec![first, codex, claude, later]);
    sent["laterPolicyField"] = json!("kept");
    let (status, saved) = call(&lab.local, "PUT", Some(json!({"expectedVersion": 0, "policy": sent})), vec![]).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!((saved["version"].clone(), saved["policy"].clone()), (json!(1), sent.clone()), "kept as sent");
    assert!(saved["updatedAt"].is_string());
    let (_, read) = call(&lab.local, "GET", None, vec![]).await;
    assert_eq!(read, saved, "read as saved");
    // A save against the version read before is refused with what is there now.
    let (status, conflict) = call(&lab.local, "PUT", Some(json!({"expectedVersion": 0, "policy": policy(vec![])})), vec![]).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!((conflict["code"].clone(), conflict["current"]["version"].clone(), conflict["current"]["policy"].clone()),
        (json!("version_conflict"), json!(1), sent));
    assert_eq!(lab.ws.store.routing_policy().unwrap().version, 1, "nothing saved");
    let (status, saved) = call(&lab.local, "PUT", Some(json!({"expectedVersion": 1, "policy": policy(vec![])})), vec![]).await;
    assert_eq!((status, saved["version"].clone()), (StatusCode::OK, json!(2)));
}

#[tokio::test]
async fn each_refusal_names_its_field_and_saves_nothing() {
    let lab = lab();
    let with = |change: &dyn Fn(&mut Value)| { let mut c = deepseek(); change(&mut c); policy(vec![c]) };
    let nine = policy((0..9).map(|n| { let mut c = deepseek(); c["id"] = json!(format!("c-{n}")); c }).collect());
    let cases: Vec<(Value, &str, &str)> = vec![
        (json!({"candidates": []}), "enabled", "true or false"),
        (json!({"enabled": true, "whenNone": "fixed", "candidates": []}), "whenNone", "wait"),
        (json!({"enabled": true, "dailyApiCapUsd": 0, "candidates": []}), "dailyApiCapUsd", "above 0"),
        (nine, "candidates", "At most 8"),
        (policy(vec![deepseek(), deepseek()]), "candidates[1].id", "used twice"),
        (with(&|c| c["id"] = json!("C_1")), "candidates[0].id", "a-z, 0-9"),
        (with(&|c| c["label"] = json!("x".repeat(61))), "candidates[0].label", "60"),
        (with(&|c| c["harness"] = json!("gemini")), "candidates[0].harness", "claude, codex or opencode"),
        (with(&|c| c["model"] = json!("deepseek-flash")), "candidates[0].model", "<provider>/<model>"),
        (with(&|c| c["reasoningEffort"] = json!("high")), "candidates[0].reasoningEffort", "Only a Codex"),
        (with(&|c| c["unknown"] = json!("wait")), "candidates[0].unknown", "skip"),
        (with(&|c| c["credential"]["keyId"] = json!("missing")), "candidates[0].credential.keyId", "No routing key"),
        (with(&|c| { c["harness"] = json!("codex"); c["model"] = json!("gpt-test"); }), "candidates[0].credential.keyId", "not one a codex"),
        (with(&|c| c["credential"] = json!({"kind": "codexHome", "id": "work"})), "candidates[0].credential.kind", "Codex candidates only"),
        (with(&|c| c["credential"] = json!({"kind": "pool", "manager": "cswap", "accounts": "all"})), "candidates[0].credential.kind", "Claude Code candidates only"),
        (with(&|c| c["credential"] = json!({"kind": "Not a kind"})), "candidates[0].credential.kind", "login, pool"),
        (with(&|c| c["conditions"][0]["schedule"]["slots"][0]["days"] = json!([8])), "candidates[0].conditions[0].schedule", "1 (Monday)"),
        (with(&|c| c["conditions"][0]["schedule"]["timeZone"] = json!("Asia/Somewhere")), "candidates[0].conditions[0].schedule", "UTC or local"),
        (with(&|c| c["conditions"][0]["minMinutesLeft"] = json!(0)), "candidates[0].conditions[0].minMinutesLeft", "1 to 1440"),
        (with(&|c| c["conditions"][1]["usd"] = json!(-1)), "candidates[0].conditions[1].usd", "above 0"),
        (with(&|c| c["conditions"][1] = json!({"kind": "quota", "weekLeftPct": 30})), "candidates[0].conditions[1].kind", "login, a pool"),
        (with(&|c| { c["credential"] = json!({"kind": "login"}); c["conditions"] = json!([{"kind": "quota"}]); }),
            "candidates[0].conditions[0].kind", "names weekLeftPct"),
        (with(&|c| { c["credential"] = json!({"kind": "login"}); c["conditions"] = json!([{"kind": "quota", "weekLeftPct": 101}]); }),
            "candidates[0].conditions[0].weekLeftPct", "0 to 100"),
    ];
    for (sent, path, said) in cases {
        let (status, refused) = call(&lab.local, "PUT", Some(json!({"expectedVersion": 0, "policy": sent.clone()})), vec![]).await;
        assert_eq!((status, refused["code"].clone(), refused["path"].clone()), (StatusCode::BAD_REQUEST, json!("invalid"), json!(path)), "{sent}: {refused}");
        assert!(refused["error"].as_str().unwrap().contains(said), "{path}: {refused}");
    }
    let (status, refused) = call(&lab.local, "PUT", Some(json!({"expectedVersion": 0, "policy": policy(vec![]), "extra": 1})), vec![]).await;
    assert_eq!((status, refused["code"].clone()), (StatusCode::BAD_REQUEST, json!("invalid")), "the body is exactly {{expectedVersion, policy}}");
    assert_eq!(lab.ws.store.routing_policy().unwrap().version, 0, "no refused save changed it");
}

#[tokio::test]
async fn a_saved_five_hour_share_is_not_read_back_and_an_older_pages_save_is_taken_without_it() {
    let lab = lab();
    // As a Core before YN-60 saved it: quota conditions with a 5-hour share, one with nothing else.
    let codex = |id: &str, quota: Value| json!({"id": id, "enabled": true, "harness": "codex", "model": "gpt-test",
        "credential": {"kind": "login"}, "conditions": [quota]});
    let before = policy(vec![codex("c-both", json!({"kind": "quota", "fiveHourLeftPct": 15, "weekLeftPct": 10})),
        codex("c-five", json!({"kind": "quota", "fiveHourLeftPct": 30}))]);
    lab.ws.store.save_routing_policy(0, before.clone()).unwrap().unwrap();
    let (status, read) = call(&lab.local, "GET", None, vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((read["policy"]["candidates"][0]["conditions"].clone(), read["policy"]["candidates"][1]["conditions"].clone()),
        (json!([{"kind": "quota", "weekLeftPct": 10}]), json!([{"kind": "quota"}])),
        "no 5-hour share is read back; the condition left with nothing is shown for the page to mark: {read}");
    // A page from before YN-60 still sends it: taken, not refused, and dropped; a condition that named only it goes.
    let (status, saved) = call(&lab.local, "PUT", Some(json!({"expectedVersion": 1, "policy": before})), vec![]).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!((saved["version"].clone(), saved["policy"]["candidates"][0]["conditions"].clone(), saved["policy"]["candidates"][1]["conditions"].clone()),
        (json!(2), json!([{"kind": "quota", "weekLeftPct": 10}]), json!([])), "{saved}");
    assert!(!lab.ws.store.routing_policy().unwrap().policy.to_string().contains("fiveHour"), "not kept");
    // A condition sent with no share at all is still refused.
    let (status, refused) = call(&lab.local, "PUT", Some(json!({"expectedVersion": 2, "policy": policy(vec![codex("c-none", json!({"kind": "quota"}))])})), vec![]).await;
    assert_eq!((status, refused["path"].clone()), (StatusCode::BAD_REQUEST, json!("candidates[0].conditions[0].kind")), "{refused}");
}

#[tokio::test]
async fn the_policy_is_the_users_own_browsers_only() {
    let lab = lab();
    let body = json!({"expectedVersion": 0, "policy": policy(vec![deepseek()])});
    for method in ["GET", "PUT"] {
        let (status, _) = call(&lab.local, method, Some(body.clone()), vec![("authorization", "Bearer an-agents-token".into())]).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method}: an Agent's credential is refused");
        let (status, answer) = call(&lab.remote, method, Some(body.clone()), vec![("host", "core.example-tailnet.ts.net:8444".into()),
            ("tailscale-user-login", "person@example.com".into()), ("origin", "https://core.example-tailnet.ts.net:8444".into())]).await;
        assert!(answer.get("policy").is_none() && answer.get("version").is_none(), "{method} not on the phone entry: {status} {answer}");
    }
    assert_eq!(lab.ws.store.routing_policy().unwrap().version, 0);
}

async fn post(app: &axum::Router, uri: &str, body: Value, extra: Vec<(&'static str, String)>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method("POST").uri(uri).header("x-yuzuno-client", "desktop").header("content-type", "application/json")
        .header("host", "127.0.0.1:4317");
    for (name, value) in extra {
        builder = builder.header(name, value);
    }
    let response = app.clone().oneshot(builder.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn evaluate_and_simulate_answer_from_cores_own_evaluator_for_a_draft_or_the_saved_policy() {
    let lab = lab();
    let mut deepseek = deepseek();
    deepseek["conditions"] = json!([deepseek["conditions"][0].clone()]);
    let draft = policy(vec![deepseek, json!({"id": "c-codex", "enabled": true, "harness": "codex", "model": "gpt-test",
        "credential": {"kind": "login"}, "conditions": []})]);
    // 2026-11-09 is a Monday; 02:00 UTC is DeepSeek's peak.
    let (status, route) = post(&lab.local, "/api/routing/evaluate", json!({"policy": draft, "at": "2026-11-09T02:00:00Z"}), vec![]).await;
    assert_eq!(status, StatusCode::OK, "{route}");
    assert_eq!((route["at"].clone(), route["chosen"].clone(), route["candidates"][0]["reasons"][0]["code"].clone()),
        (json!("preview"), json!("c-codex"), json!("outsideWindow")));
    let (_, route) = post(&lab.local, "/api/routing/evaluate", json!({"policy": draft, "at": "2026-11-09T12:00:00Z"}), vec![]).await;
    assert_eq!(route["chosen"], "c-deepseek");
    let (_, saved) = post(&lab.local, "/api/routing/evaluate", json!({}), vec![]).await;
    assert_eq!((saved["chosen"].clone(), saved["candidates"].clone()), (Value::Null, json!([])), "the saved policy: none yet");
    let (status, refused) = post(&lab.local, "/api/routing/evaluate", json!({"policy": {"enabled": "yes", "candidates": []}}), vec![]).await;
    assert_eq!((status, refused["path"].clone()), (StatusCode::BAD_REQUEST, json!("enabled")), "a draft is checked as a save is");
    let (status, sim) = post(&lab.local, "/api/routing/simulate",
        json!({"policy": draft, "from": "2026-11-09T00:00:00Z", "to": "2026-11-09T12:00:00Z", "stepMinutes": 30}), vec![]).await;
    assert_eq!(status, StatusCode::OK, "{sim}");
    let segments: Vec<(String, String, Value)> = sim["segments"].as_array().unwrap().iter()
        .map(|s| (s["from"].as_str().unwrap()[11..16].to_owned(), s["to"].as_str().unwrap()[11..16].to_owned(), s["chosen"].clone())).collect();
    assert_eq!(segments, [
        ("00:00".into(), "01:00".into(), json!("c-deepseek")), ("01:00".into(), "04:00".into(), json!("c-codex")),
        ("04:00".into(), "06:00".into(), json!("c-deepseek")), ("06:00".into(), "10:00".into(), json!("c-codex")),
        ("10:00".into(), "12:00".into(), json!("c-deepseek"))], "off-peak around the peaks: {sim}");
    let (status, _) = post(&lab.local, "/api/routing/simulate", json!({"from": "2026-11-09T00:00:00Z", "to": "2026-11-20T00:00:00Z", "stepMinutes": 5}), vec![]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "at most 2016 steps");
    // YN-56: with a permission level, only candidates whose harness keeps it; OpenCode keeps none yet.
    let (status, route) = post(&lab.local, "/api/routing/evaluate",
        json!({"policy": draft, "at": "2026-11-09T12:00:00Z", "permissionLevel": "ask"}), vec![]).await;
    assert_eq!(status, StatusCode::OK, "{route}");
    assert_eq!((route["level"].clone(), route["chosen"].clone(), route["candidates"][0]["state"].clone(), route["candidates"][0]["reasons"][0]["code"].clone()),
        (json!("ask"), json!("c-codex"), json!("skipped"), json!("levelNotKept")), "{route}");
    let (_, sim) = post(&lab.local, "/api/routing/simulate",
        json!({"policy": draft, "from": "2026-11-09T00:00:00Z", "to": "2026-11-09T12:00:00Z", "stepMinutes": 30, "permissionLevel": "full"}), vec![]).await;
    assert_eq!(sim["segments"].as_array().map(|s| s.iter().map(|s| s["chosen"].clone()).collect::<Vec<_>>()), Some(vec![json!("c-codex")]), "{sim}");
    for uri in ["/api/routing/evaluate", "/api/routing/simulate"] {
        let (status, refused) = post(&lab.local, uri, json!({"policy": draft, "from": "2026-11-09T00:00:00Z", "to": "2026-11-09T12:00:00Z",
            "stepMinutes": 30, "permissionLevel": "readonly"}), vec![]).await;
        assert_eq!((status, refused["path"].clone()), (StatusCode::BAD_REQUEST, json!("permissionLevel")), "{uri}: {refused}");
    }
    for uri in ["/api/routing/evaluate", "/api/routing/simulate"] {
        let (status, _) = post(&lab.local, uri, json!({}), vec![("authorization", "Bearer an-agents-token".into())]).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: an Agent's credential is refused");
    }
}
