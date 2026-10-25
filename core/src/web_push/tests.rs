//! Push notifications end to end, with synthetic device keys and a push
//! service that only records what it is sent: nothing leaves the machine.
use super::*;
use axum::body::Body;
use ring::{agreement, rand::SystemRandom, signature};
use std::{collections::VecDeque, sync::atomic::Ordering};
use tower::ServiceExt;

const ORIGIN: &str = "https://core.example.ts.net:8444";
const ENDPOINT: &str = "https://web.push.apple.com/QSyntheticDevice1";
const OTHER: &str = "https://web.push.apple.com/QSyntheticDevice2";

/// A Workspace on disk next to the build (/tmp is memory here).
fn workspace() -> (tempfile::TempDir, Arc<Workspace>) {
    let parent = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
    std::fs::create_dir_all(parent).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused-harness".into()).unwrap();
    (dir, ws)
}

async fn call_from(ws: &Arc<Workspace>, origin: Option<&str>, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut request = axum::http::Request::builder().method(method).uri(path);
    if let Some(origin) = origin {
        request = request.header(header::ORIGIN, origin);
    }
    let body = match body {
        Some(value) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = router().with_state(ws.clone()).oneshot(request.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn call(ws: &Arc<Workspace>, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    call_from(ws, Some(ORIGIN), method, path, body).await
}

/// A device's push keys, as a browser makes them; the private key opens
/// one message.
struct Device {
    private: Option<agreement::EphemeralPrivateKey>,
    public: Vec<u8>,
    auth: [u8; 16],
}

fn device() -> Device {
    let private = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &SystemRandom::new()).unwrap();
    let public = private.compute_public_key().unwrap().as_ref().to_vec();
    Device { private: Some(private), public, auth: [7; 16] }
}

fn subscription(device: &Device, endpoint: &str, kinds: Value) -> Value {
    json!({"endpoint":endpoint,"expirationTime":null,
        "keys":{"p256dh":crypto::b64(&device.public),"auth":crypto::b64(&device.auth)},"kinds":kinds})
}

async fn refusal(ws: &Arc<Workspace>, body: Value) -> String {
    let (status, said) = call(ws, "POST", "/api/push/subscriptions", Some(body)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
    said["code"].as_str().unwrap().to_owned()
}

async fn state(ws: &Arc<Workspace>, endpoint: &str) -> Value {
    call(ws, "POST", "/api/push/subscriptions/state", Some(json!({"endpoint":endpoint}))).await.1
}

#[tokio::test]
async fn a_device_subscribes_with_the_key_core_made_and_removes_only_its_own_subscription() {
    let (_dir, ws) = workspace();
    assert_eq!(call(&ws, "GET", "/api/push", None).await, (StatusCode::OK, json!({"publicKey":null})));
    let mine = device();
    assert_eq!(refusal(&ws, subscription(&mine, ENDPOINT, json!(["finished"]))).await, "push_key_missing");
    let (status, made) = call(&ws, "POST", "/api/push/key", None).await;
    assert_eq!(status, StatusCode::OK);
    let key = made["publicKey"].as_str().unwrap().to_owned();
    assert_eq!(crypto::unb64(&key).unwrap().len(), 65);
    assert_eq!(call(&ws, "POST", "/api/push/key", None).await.1, json!({"publicKey":key}), "made once");
    assert_eq!(call(&ws, "GET", "/api/push", None).await.1, json!({"publicKey":key}));

    let (status, subscribed) = call(&ws, "POST", "/api/push/subscriptions",
        Some(subscription(&mine, ENDPOINT, json!(["finished", "needsYou", "finished"])))).await;
    assert_eq!((status, subscribed), (StatusCode::OK, json!({"state":"active","kinds":["finished","needsYou"]})));
    let theirs = device();
    call(&ws, "POST", "/api/push/subscriptions", Some(subscription(&theirs, OTHER, json!(["failed"])))).await;
    let mine_now = state(&ws, ENDPOINT).await;
    assert_eq!((mine_now["state"].as_str(), &mine_now["kinds"]), (Some("active"), &json!(["finished","needsYou"])));
    // Subscribing again changes the kinds of the same subscription.
    call(&ws, "POST", "/api/push/subscriptions", Some(subscription(&mine, ENDPOINT, json!(["needsYou"])))).await;
    assert_eq!(state(&ws, ENDPOINT).await["kinds"], json!(["needsYou"]));
    assert_eq!(load(&ws).unwrap().subscriptions.len(), 2);

    let remove = |endpoint: &str| json!({"endpoint":endpoint});
    assert_eq!(call(&ws, "POST", "/api/push/subscriptions/remove", Some(remove(ENDPOINT))).await.1, json!({"removed":true}));
    assert_eq!(call(&ws, "POST", "/api/push/subscriptions/remove", Some(remove(ENDPOINT))).await.1, json!({"removed":false}));
    assert_eq!(state(&ws, ENDPOINT).await, json!({"state":"none"}));
    assert_eq!(state(&ws, OTHER).await["state"], "active", "the other device still gets its notifications");

    // The private key stays in the data folder, readable only by Core.
    let saved = std::fs::read_to_string(ws.data_dir.join(FILE)).unwrap();
    let pkcs8 = load(&ws).unwrap().key.unwrap().pkcs8;
    assert!(saved.contains(&pkcs8) && !made.to_string().contains(&pkcs8));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(ws.data_dir.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
}

#[tokio::test]
async fn only_apples_push_service_usable_keys_known_kinds_and_a_page_origin_are_accepted() {
    let (_dir, ws) = workspace();
    call(&ws, "POST", "/api/push/key", None).await;
    let mine = device();
    let long = format!("https://web.push.apple.com/{}", "x".repeat(ENDPOINT_CHARS));
    for endpoint in ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x",
        "http://web.push.apple.com/x", "https://web.push.apple.com:8443/x", "https://user@web.push.apple.com/x",
        "https://web.push.apple.com.example.com/x", "https://push.apple.com/x", "https://.push.apple.com/x",
        "https://17.253.0.1/x", "https://web.push.apple.com/x#here", "file:///etc/passwd", "not a url", &long] {
        assert_eq!(refusal(&ws, subscription(&mine, endpoint, json!(["finished"]))).await, "push_service_unsupported", "{endpoint}");
    }
    assert_eq!(push_service("https://WEB.push.apple.com/x"), Some("https://web.push.apple.com".into()));
    assert_eq!(push_service("https://web.push.apple.com:443/x"), Some("https://web.push.apple.com".into()));

    let mut bad = subscription(&mine, ENDPOINT, json!(["finished"]));
    bad["keys"]["p256dh"] = json!(crypto::b64(&[4; 65]));
    assert_eq!(refusal(&ws, bad).await, "push_subscription_invalid", "not a point on P-256");
    let mut bad = subscription(&mine, ENDPOINT, json!(["finished"]));
    bad["keys"]["auth"] = json!(crypto::b64(&[1; 15]));
    assert_eq!(refusal(&ws, bad).await, "push_subscription_invalid");
    let mut bad = subscription(&mine, ENDPOINT, json!(["finished"]));
    bad["keys"] = json!({});
    assert_eq!(refusal(&ws, bad).await, "push_subscription_invalid");
    assert_eq!(refusal(&ws, subscription(&mine, ENDPOINT, json!(["backupFailed"]))).await, "push_kind_unknown");
    let mut bad = subscription(&mine, ENDPOINT, json!([]));
    bad.as_object_mut().unwrap().remove("kinds");
    assert_eq!(refusal(&ws, bad).await, "push_kind_unknown");
    let (status, said) = call_from(&ws, None, "POST", "/api/push/subscriptions", Some(subscription(&mine, ENDPOINT, json!(["finished"])))).await;
    assert_eq!((status, said["code"].as_str()), (StatusCode::BAD_REQUEST, Some("push_subscription_invalid")));
    assert!(load(&ws).unwrap().subscriptions.is_empty());

    // A bounded number of devices: a stopped subscription makes room, an active one never.
    for n in 0..DEVICES {
        let (status, _) = call(&ws, "POST", "/api/push/subscriptions",
            Some(subscription(&mine, &format!("https://web.push.apple.com/QDevice{n}"), json!(["finished"])))).await;
        assert_eq!(status, StatusCode::OK);
    }
    let one_more = subscription(&mine, "https://web.push.apple.com/QDeviceMore", json!(["finished"]));
    assert_eq!(refusal(&ws, one_more.clone()).await, "push_devices_full");
    update(&ws, |saved| {
        saved.subscriptions[3].state = Standing::Expired;
        Ok(())
    }).unwrap();
    assert_eq!(call(&ws, "POST", "/api/push/subscriptions", Some(one_more)).await.0, StatusCode::OK);
    assert_eq!(state(&ws, "https://web.push.apple.com/QDevice3").await["state"], "none");
    assert_eq!(load(&ws).unwrap().subscriptions.len(), DEVICES);
}

/// The push service as these tests see it: what it was sent, and the
/// answers it gives in turn (then Accepted).
#[derive(Clone, Default)]
struct Service {
    sent: Arc<Mutex<Vec<Outgoing>>>,
    answers: Arc<Mutex<VecDeque<Answer>>>,
}

impl Service {
    fn install(&self, ws: &Workspace) {
        let me = self.clone();
        let _ = ws.web_push.test_post.set(Arc::new(move |out: &Outgoing| {
            me.sent.lock().unwrap().push(out.clone());
            me.answers.lock().unwrap().pop_front().unwrap_or(Answer::Accepted)
        }));
    }
    fn count(&self) -> usize {
        self.sent.lock().unwrap().len()
    }
}

async fn until(what: &str, mut done: impl FnMut() -> bool) {
    for _ in 0..200 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

fn reads(ws: &Workspace) -> usize {
    ws.web_push.reads.load(Ordering::SeqCst)
}

/// Waits until the watcher has read the Workspace after this point.
async fn read_after(ws: &Arc<Workspace>, change: impl FnOnce()) {
    let before = reads(ws);
    change();
    until("a read", || reads(ws) > before).await;
}

fn builder(ws: &Workspace) {
    let detail: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"Builder","cwd":"/tmp",
        "model":"test","color":"sage","threadId":"session-a","status":"idle","createdAt":"","updatedAt":"",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&detail).unwrap();
}

fn working(ws: &Workspace, turn: &str) {
    ws.store.update("a", "test/working", &json!({}), |d| {
        d.turns.push(json!({"id":turn,"status":"inProgress","items":[
            {"type":"userMessage","id":format!("{turn}-u"),"content":[{"type":"text","text":"SECRET PROMPT TEXT"}]}]}));
        d.agent.status = "working".into();
    }).unwrap();
    ws.changed("a");
}

fn finished(ws: &Workspace) {
    ws.store.update("a", "test/finished", &json!({}), |d| {
        let turn = d.turns.last_mut().unwrap();
        turn["status"] = json!("completed");
        turn["items"].as_array_mut().unwrap().push(json!({"type":"agentMessage","id":"answer","text":"SECRET ANSWER TEXT"}));
        d.agent.status = "idle".into();
    }).unwrap();
    ws.changed("a");
}

async fn subscribed(ws: &Arc<Workspace>, device: &Device, kinds: Value) -> String {
    let key = call(ws, "POST", "/api/push/key", None).await.1["publicKey"].as_str().unwrap().to_owned();
    let (status, said) = call(ws, "POST", "/api/push/subscriptions", Some(subscription(device, ENDPOINT, kinds))).await;
    assert_eq!(status, StatusCode::OK, "{said}");
    key
}

#[tokio::test]
async fn a_finished_turn_is_pushed_once_encrypted_signed_and_without_conversation_text() {
    let (_dir, ws) = workspace();
    builder(&ws);
    working(&ws, "t1");
    let service = Service::default();
    service.install(&ws);
    let mut mine = device();
    let key = subscribed(&ws, &mine, json!(["needsYou", "finished", "failed"])).await;
    ws.start_web_push();
    until("the first read", || reads(&ws) >= 1).await;
    assert_eq!(service.count(), 0, "the first read is only compared with");

    finished(&ws);
    until("a push", || service.count() == 1).await;
    let out = service.sent.lock().unwrap()[0].clone();
    assert_eq!((out.endpoint.as_str(), out.ttl, out.urgency), (ENDPOINT, TTL, "normal"));
    assert_eq!(out.topic, topic("yuzuno:finished:a"));
    assert_eq!(out.topic.len(), 22);

    // Signed by the key the device subscribed with, for Apple's service, naming this Core's page.
    let (token, named) = out.authorization.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
    assert_eq!(named, key);
    let (input, signed) = token.rsplit_once('.').unwrap();
    signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, crypto::unb64(&key).unwrap())
        .verify(input.as_bytes(), &crypto::unb64(signed).unwrap())
        .unwrap();
    let claims: Value = serde_json::from_slice(&crypto::unb64(input.split_once('.').unwrap().1).unwrap()).unwrap();
    assert_eq!((claims["aud"].as_str(), claims["sub"].as_str()), (Some("https://web.push.apple.com"), Some(ORIGIN)));
    let left = claims["exp"].as_i64().unwrap() - chrono::Utc::now().timestamp();
    assert!(left > 0 && left <= 24 * 60 * 60, "{left}");

    // Only the device opens it, and it says no more than T-188 does without a preview.
    let opened = crypto::open(mine.private.take().unwrap(), &mine.public, &mine.auth, &out.body);
    let workspace = ws.store.workspace_id().unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&opened).unwrap(), json!({"v":1,"kind":"finished","workspaceId":workspace,
        "open":"agent","agentId":"a","title":"Builder finished","body":"The Turn finished.","tag":"yuzuno:finished:a"}));
    assert!(!String::from_utf8_lossy(&opened).contains("SECRET"));
    until("the delivery recorded", || load(&ws).unwrap().subscriptions[0].delivered_at.is_some()).await;

    // Read again with nothing new, or the same Turn's end again: nothing more.
    read_after(&ws, || ws.changed("a")).await;
    read_after(&ws, || {
        ws.store.update("a", "test/again", &json!({}), |d| d.agent.status = "working".into()).unwrap();
        ws.changed("a");
    }).await;
    read_after(&ws, || finished(&ws)).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(service.count(), 1, "the same Turn's end is pushed once");

    // A device that chose only requests is not told of finished Turns.
    call(&ws, "POST", "/api/push/subscriptions", Some(subscription(&device(), ENDPOINT, json!(["needsYou"])))).await;
    read_after(&ws, || working(&ws, "t2")).await;
    read_after(&ws, || finished(&ws)).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(service.count(), 1);
}

#[tokio::test]
async fn a_gone_subscription_stops_and_unanswered_sends_stop_it_after_five() {
    let (_dir, ws) = workspace();
    builder(&ws);
    let service = Service::default();
    service.install(&ws);
    service.answers.lock().unwrap().push_back(Answer::Gone(410));
    let mine = device();
    subscribed(&ws, &mine, json!(["finished"])).await;
    ws.start_web_push();
    until("the first read", || reads(&ws) >= 1).await;

    read_after(&ws, || working(&ws, "t1")).await;
    finished(&ws);
    until("a push", || service.count() == 1).await;
    until("the subscription stopped", || state_now(&ws)["state"] == "expired").await;
    assert!(state_now(&ws)["reason"].as_str().unwrap().contains("HTTP 410"));
    // Nothing more is sent to it.
    working(&ws, "t2");
    tokio::time::sleep(SETTLE * 2).await;
    finished(&ws);
    tokio::time::sleep(SETTLE * 2).await;
    assert_eq!(service.count(), 1);

    // Subscribed again, a push service that never answers: counted, not retried, then stopped.
    for _ in 0..UNANSWERED {
        service.answers.lock().unwrap().push_back(Answer::Unanswered("no answer within 15 s".into()));
    }
    let before = reads(&ws);
    subscribed(&ws, &mine, json!(["finished"])).await;
    until("a read with the new subscription", || reads(&ws) > before).await;
    for n in 0..UNANSWERED {
        read_after(&ws, || working(&ws, &format!("u{n}"))).await;
        finished(&ws);
        until("a push", || service.count() == 2 + n as usize).await;
        until("its answer recorded", || state_now(&ws)["unanswered"].as_u64() == Some(n as u64 + 1) || state_now(&ws)["state"] != "active").await;
    }
    assert_eq!(state_now(&ws)["state"], "failed");
    assert!(state_now(&ws)["reason"].as_str().unwrap().starts_with("5 sends in a row were not delivered"));
    assert_eq!(service.count(), 1 + UNANSWERED as usize, "one send per Turn's end, none retried");
}

/// The saved subscription, as push.json holds it.
fn state_now(ws: &Workspace) -> Value {
    serde_json::to_value(&load(ws).unwrap().subscriptions[0]).unwrap()
}

#[tokio::test]
async fn a_refused_send_stops_the_subscription_and_says_why() {
    let (_dir, ws) = workspace();
    let to = Subscription {
        endpoint: ENDPOINT.into(), p256dh: String::new(), auth: String::new(), kinds: vec![Kind::Finished], origin: ORIGIN.into(),
        id: "s1".into(), state: Standing::Active, subscribed_at: now(), stopped_at: None, reason: None, unanswered: 0,
        last_error: None, delivered_at: None,
    };
    update(&ws, |saved| {
        saved.subscriptions.push(to.clone());
        Ok(())
    }).unwrap();
    // An answer about an older subscription of the same device changes nothing.
    let older = Subscription { id: "s0".into(), ..to.clone() };
    assert!(record(&ws, &older, &Answer::Refused(403, "BadJwtToken".into())).unwrap());
    assert_eq!(state_now(&ws)["state"], "active");
    assert!(record(&ws, &to, &Answer::Refused(403, "BadJwtToken".into())).unwrap());
    let stopped = state_now(&ws);
    assert_eq!((stopped["state"].as_str(), stopped["reason"].as_str()), (Some("failed"), Some("The push service refused it (HTTP 403): BadJwtToken.")));
    assert!(stopped["stoppedAt"].is_string());
}
