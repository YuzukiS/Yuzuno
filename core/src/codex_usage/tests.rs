use super::*;
use crate::{model::AgentDetail, rpc::Rpc, workspace::Connection};

fn limits() -> Value {
    json!({"accountId":"account-a","ordinaryUsageAllowed":true,"rateLimits":{"limitId":"codex"},
        "rateLimitsByLimitId":{"codex":{"limitName":"Codex","planType":"pro",
            "primary":{"usedPercent":27,"windowDurationMins":300,"resetsAt":1900000000},
            "secondary":{"usedPercent":51,"windowDurationMins":10080,"resetsAt":1900100000},
            "credits":{"hasCredits":true,"unlimited":false,"balance":"12"}},
            "other":{"limitName":"Other models","primary":{"usedPercent":3,"windowDurationMins":15}}}})
}
fn ready() -> Snapshot {
    let mut s = Snapshot::default();
    s.reset(1, json!({"generation":"1"}), "unknown");
    s.value["account"] = json!({"type":"chatgpt","label":"fixture","planType":"pro"});
    s.value["status"] = "ready".into();
    s.value["accountId"] = "account-a".into();
    s.value["buckets"] = json!(buckets(&limits(), "2026-01-01T00:00:00Z"));
    s
}
#[test]
fn multiple_buckets_nulls_and_window_units_are_not_invented() {
    let b = buckets(&limits(), "time");
    assert_eq!(b.len(), 2);
    assert_eq!(b[0]["primary"]["usedPercent"].as_f64(), Some(27.0));
    assert_eq!(b[0]["secondary"]["windowDurationMins"], 10080);
    assert!(b[1]["primary"]["resetsAt"].is_null());
    assert!(b[1]["secondary"].is_null());
    assert!(buckets(&json!({}), "time").is_empty());
    assert!(window(&json!({"usedPercent":-1}), "time")["usedPercent"].is_null());
    assert_eq!(
        window(&json!({"usedPercent":125}), "time")["usedPercent"],
        125.0
    );
}
#[test]
fn sparse_updates_keep_identity_metadata_and_untouched_windows_age() {
    let mut s = ready();
    assert!(rolling(
        &mut s,
        &json!({"rateLimits":{"limitId":"codex","limitName":null,"planType":null,
        "primary":{"usedPercent":42},"secondary":null,"credits":{"balance":null,"hasCredits":false}}})
    ));
    let b = &s.value["buckets"][0];
    assert_eq!(b["limitName"], "Codex");
    assert_eq!(b["planType"], "pro");
    assert_eq!(b["credits"]["balance"], "12");
    assert_eq!(b["credits"]["hasCredits"], false);
    assert_eq!(b["primary"]["usedPercent"], 42.0);
    assert!(b["primary"]["resetsAt"].is_null());
    assert_eq!(b["secondary"]["observedAt"], "2026-01-01T00:00:00Z");
    assert_eq!(s.value["accountId"], "account-a");
    assert_eq!(
        s.value["buckets"][1]["primary"]["usedPercent"].as_f64(),
        Some(3.0)
    );
    assert!(s.value["ordinaryUsageAllowed"].is_null());
}
#[test]
fn unverified_or_ambiguous_notifications_never_become_account_usage() {
    let mut s = ready();
    assert!(!rolling(
        &mut s,
        &json!({"rateLimits":{"primary":{"usedPercent":99}}})
    ));
    s.reset(2, json!({"generation":"2"}), "unknown");
    assert!(!rolling(
        &mut s,
        &json!({"rateLimits":{"limitId":"codex","primary":{"usedPercent":99}}})
    ));
    assert!(s.value["buckets"].as_array().unwrap().is_empty());
    assert!(s.value["accountId"].is_null());
}

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    rpc: Arc<Rpc>,
}
impl Drop for Lab {
    fn drop(&mut self) {
        self.rpc.close();
    }
}
impl Lab {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage","status":"working","createdAt":"","updatedAt":"","unreadCount":3,"pendingCount":0,"lastSeq":8,"reviewedSeq":5,"connectionState":"connected"},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&detail).unwrap();
        std::fs::write(dir.path().join("limits.json"), limits().to_string()).unwrap();
        std::fs::write(
            dir.path().join("account.json"),
            json!({"type":"chatgpt","email":"fixture@example.invalid","planType":"pro"})
                .to_string(),
        )
        .unwrap();
        let script = r#"import json,sys,pathlib,time
root=pathlib.Path(sys.argv[1])
for line in sys.stdin:
 r=json.loads(line);m=r.get('method','');i=r.get('id')
 if i is None:continue
 with (root/'methods').open('a') as f:f.write(m+'\n')
 if m=='account/read':result={'account':json.loads((root/'account.json').read_text())}
 elif m=='account/rateLimits/read':
  (root/'reading').touch()
  if (root/'slow').exists():time.sleep(.2)
  if (root/'error').exists():
   print(json.dumps({'id':i,'error':{'code':int((root/'error').read_text()),'message':'private native diagnostic'}}),flush=True);continue
  result=json.loads((root/'limits.json').read_text())
 else:raise RuntimeError('Unexpected non-account request: '+m)
 print(json.dumps({'id':i,'result':result}),flush=True)
"#;
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let rpc = Rpc::spawn(
            "python3",
            &["-c".into(), script.into(), dir.path().display().to_string()],
            tx,
        )
        .await
        .unwrap();
        ws.rpcs.lock().unwrap().insert(
            "a".into(),
            Connection {
                generation: 1,
                rpc: rpc.clone(),
                closing: false,
                events: None,
                attachment: Default::default(),
            },
        );
        Self { dir, ws, rpc }
    }
    fn invalidate_cooldown(&self) {
        self.ws.codex_usage.slot("a").state.lock().unwrap().checked = None;
    }
    fn methods(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("methods")).unwrap_or_default()
    }
    async fn reading(&self) {
        for _ in 0..100 {
            if self.dir.path().join("reading").exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("fixture never received read");
    }
}
#[tokio::test]
async fn native_reads_coalesce_and_do_not_touch_conversation_or_read_state() {
    let lab = Lab::new().await;
    let before = lab.ws.store.detail("a").unwrap();
    let (a, b, c) = tokio::join!(
        lab.ws.read_codex_usage("a", false),
        lab.ws.read_codex_usage("a", true),
        lab.ws.read_codex_usage("a", true)
    );
    assert_eq!(a.unwrap(), b.unwrap());
    assert_eq!(c.unwrap()["status"], "ready");
    assert_eq!(
        lab.methods().lines().collect::<Vec<_>>(),
        vec!["account/read", "account/rateLimits/read"]
    );
    let after = lab.ws.store.detail("a").unwrap();
    assert_eq!(after.agent.rev, before.agent.rev);
    assert_eq!(after.agent.last_seq, before.agent.last_seq);
    assert_eq!(after.agent.unread_count, before.agent.unread_count);
    assert_eq!(after.agent.reviewed_seq, before.agent.reviewed_seq);
    assert_eq!(after.turns, before.turns);
}
#[tokio::test]
async fn refresh_errors_keep_dated_facts_and_unsupported_is_not_zero() {
    let lab = Lab::new().await;
    let good = lab.ws.read_codex_usage("a", false).await.unwrap();
    for (code, status) in [(500, "error"), (-32601, "unsupported")] {
        lab.invalidate_cooldown();
        std::fs::write(lab.dir.path().join("error"), code.to_string()).unwrap();
        let bad = lab.ws.read_codex_usage("a", true).await.unwrap();
        assert_eq!(bad["status"], status);
        assert_eq!(bad["observedAt"], good["observedAt"]);
        assert_eq!(bad["buckets"], good["buckets"]);
        assert!(bad["ordinaryUsageAllowed"].is_null());
        assert!(!bad.to_string().contains("private native diagnostic"));
    }
    std::fs::remove_file(lab.dir.path().join("error")).unwrap();
    lab.invalidate_cooldown();
    assert_eq!(
        lab.ws.read_codex_usage("a", true).await.unwrap()["status"],
        "ready"
    );
}
#[tokio::test]
async fn api_key_logged_out_and_changed_account_cannot_reuse_old_limits() {
    let lab = Lab::new().await;
    lab.ws.read_codex_usage("a", false).await.unwrap();
    for account in [json!({"type":"apiKey"}), Value::Null] {
        lab.invalidate_cooldown();
        std::fs::write(lab.dir.path().join("account.json"), account.to_string()).unwrap();
        let v = lab.ws.read_codex_usage("a", true).await.unwrap();
        assert_eq!(v["status"], "unavailable");
        assert_eq!(v["buckets"], json!([]));
        assert!(v["accountId"].is_null());
    }
    assert_eq!(
        lab.methods()
            .lines()
            .filter(|m| *m == "account/rateLimits/read")
            .count(),
        1
    );
    lab.invalidate_cooldown();
    std::fs::write(
        lab.dir.path().join("account.json"),
        json!({"type":"chatgpt","email":"new"}).to_string(),
    )
    .unwrap();
    std::fs::write(lab.dir.path().join("error"), "500").unwrap();
    let v = lab.ws.read_codex_usage("a", true).await.unwrap();
    assert_eq!(v["buckets"], json!([]));
    assert!(v["observedAt"].is_null());
}
#[tokio::test]
async fn auth_change_and_connection_replacement_discard_inflight_answers() {
    for replace in [false, true] {
        let lab = Lab::new().await;
        std::fs::write(lab.dir.path().join("slow"), "").unwrap();
        let ws = lab.ws.clone();
        let read = tokio::spawn(async move { ws.read_codex_usage("a", false).await.unwrap() });
        lab.reading().await;
        let _owned = lab.ws.owner("a").await;
        if replace {
            lab.ws.rpcs.lock().unwrap().get_mut("a").unwrap().generation = 2;
            lab.ws.codex_usage_reconnected("a", 2).await;
        } else {
            lab.ws.codex_usage_event(
                "a",
                1,
                &json!({"method":"account/updated","params":{"authMode":"chatgpt"}}),
            );
        }
        drop(_owned);
        let v = read.await.unwrap();
        assert_eq!(v["status"], "unknown");
        assert_eq!(v["buckets"], json!([]));
        assert!(v["accountId"].is_null());
    }
}
#[tokio::test]
async fn closing_or_removed_connection_clears_cached_usage_during_refresh() {
    for remove in [false, true] {
        let lab = Lab::new().await;
        lab.ws.read_codex_usage("a", false).await.unwrap();
        lab.invalidate_cooldown();
        std::fs::remove_file(lab.dir.path().join("reading")).unwrap();
        std::fs::write(lab.dir.path().join("slow"), "").unwrap();
        let ws = lab.ws.clone();
        let read = tokio::spawn(async move { ws.read_codex_usage("a", true).await.unwrap() });
        lab.reading().await;
        let _owned = lab.ws.owner("a").await;
        if remove {
            lab.ws.rpcs.lock().unwrap().remove("a");
        } else {
            lab.ws.rpcs.lock().unwrap().get_mut("a").unwrap().closing = true;
        }
        drop(_owned);
        let v = read.await.unwrap();
        assert_eq!(v["status"], "disconnected");
        assert_eq!(v["buckets"], json!([]));
        assert!(v["accountId"].is_null());
    }
}
#[tokio::test]
async fn rolling_update_during_refresh_preserves_cooldown_for_queued_reads() {
    for fail in [false, true] {
        let lab = Lab::new().await;
        let before = lab.ws.read_codex_usage("a", false).await.unwrap();
        lab.invalidate_cooldown();
        std::fs::remove_file(lab.dir.path().join("reading")).unwrap();
        std::fs::write(lab.dir.path().join("slow"), "").unwrap();
        if fail {
            std::fs::write(lab.dir.path().join("error"), "500").unwrap();
        }
        let ws = lab.ws.clone();
        let first = tokio::spawn(async move { ws.read_codex_usage("a", true).await.unwrap() });
        lab.reading().await;
        let ws = lab.ws.clone();
        let queued = tokio::spawn(async move { ws.read_codex_usage("a", true).await.unwrap() });
        let _owned = lab.ws.owner("a").await;
        lab.ws.codex_usage_event(
            "a",
            1,
            &json!({"method":"account/rateLimits/updated",
            "params":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":88}}}}),
        );
        let observed =
            lab.ws.codex_usage.slot("a").state.lock().unwrap().value["observedAt"].clone();
        drop(_owned);
        let got = first.await.unwrap();
        assert_eq!(got, queued.await.unwrap());
        assert_eq!(got, lab.ws.read_codex_usage("a", true).await.unwrap());
        assert_eq!(
            got["buckets"][0]["primary"]["usedPercent"].as_f64(),
            Some(88.0)
        );
        assert_eq!(got["observedAt"], observed);
        assert_ne!(got["checkedAt"], before["checkedAt"]);
        assert_eq!(got["status"], "ready");
        assert!(lab
            .ws
            .codex_usage
            .slot("a")
            .state
            .lock()
            .unwrap()
            .checked
            .is_some());
        assert_eq!(
            lab.methods().lines().count(),
            4,
            "only initial and one refresh RPC pair"
        );
    }
}
#[tokio::test]
async fn replacement_rebuilds_remote_source_before_and_after_read() {
    let lab = Lab::new().await;
    lab.ws.store.update("a", "fixture", &json!({}), |d| {
        d.agent.remote = Some(serde_json::from_value(json!({
            "machine":{"id":"remote-x","name":"Remote X","target":"host","codex":"codex","defaultCwd":"/tmp"},
            "runtime":{"root":"/tmp/old","socket":"old.sock","pid":1,"codex":"codex","instanceId":"old-runtime"}
        })).unwrap());
    }).unwrap();
    assert_eq!(
        lab.ws.read_codex_usage("a", false).await.unwrap()["source"]["runtimeId"],
        "old-runtime"
    );
    lab.ws
        .store
        .update("a", "runtime/located", &json!({}), |d| {
            d.agent
                .remote
                .as_mut()
                .unwrap()
                .runtime
                .as_mut()
                .unwrap()
                .instance_id = "new-runtime".into();
        })
        .unwrap();
    let _owned = lab.ws.owner("a").await;
    lab.ws.rpcs.lock().unwrap().get_mut("a").unwrap().generation = 2;
    lab.ws.codex_usage_reconnected("a", 2).await;
    let reset = lab
        .ws
        .codex_usage
        .slot("a")
        .state
        .lock()
        .unwrap()
        .value
        .clone();
    drop(_owned);
    assert_eq!(reset["source"]["runtimeId"], "new-runtime");
    assert_eq!(reset["source"]["generation"], "2");
    assert_eq!(reset["buckets"], json!([]));
    let refreshed = lab.ws.read_codex_usage("a", false).await.unwrap();
    assert_eq!(refreshed["status"], "ready");
    assert_eq!(refreshed["source"], reset["source"]);
}
#[tokio::test]
async fn remote_source_and_disconnection_never_fall_back_to_catalog() {
    let lab = Lab::new().await;
    lab.ws.store.update("a","fixture",&json!({}),|d|{
        d.agent.remote=Some(serde_json::from_value(json!({"machine":{"id":"remote-x","name":"Remote X","target":"host","codex":"codex","defaultCwd":"/tmp"},"runtime":null})).unwrap());
    }).unwrap();
    let good = lab.ws.read_codex_usage("a", false).await.unwrap();
    assert_eq!(good["source"]["machineId"], "remote-x");
    lab.ws.rpcs.lock().unwrap().remove("a");
    let offline = lab.ws.read_codex_usage("a", true).await.unwrap();
    assert_eq!(offline["status"], "disconnected");
    assert_eq!(offline["buckets"], json!([]));
    assert_eq!(lab.methods().lines().count(), 2);
    assert!(lab.ws.rpcs.lock().unwrap().get("_catalog").is_none());
}
