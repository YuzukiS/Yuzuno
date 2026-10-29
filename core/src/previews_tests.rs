use super::*;
use crate::model::AgentDetail;

const PAGE: &str = "<!doctype html><title>Proto</title><button onclick=\"this.textContent='clicked'\">Try</button>";
const CORE: &str = "http://localhost:4317";

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    first: u16,
    /// Last, so it is released after the Workspace (its listener).
    _ports: std::fs::File,
}

/// A block of 4 ports for one lab alone, and the lock that holds it, as
/// services_tests' labs hold theirs (in a range of its own).
fn ports(uid: u32) -> (std::fs::File, u16) {
    let locks = std::path::PathBuf::from(format!("/tmp/yuzuno-preview-test-ports-{uid}"));
    std::fs::create_dir_all(&locks).unwrap();
    for first in (25000..26000).step_by(4) {
        let file = std::fs::File::create(locks.join(first.to_string())).unwrap();
        if file.try_lock().is_ok() {
            return (file, first);
        }
    }
    panic!("every block of preview test ports is held");
}

/// A Core with one Agent "a" whose working directory is `work`.
fn lab() -> Lab {
    use std::os::unix::fs::MetadataExt;
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let (ports, first) = ports(std::fs::metadata(dir.path()).unwrap().uid());
    ws.services.use_ports(first..=first + 3);
    let work = dir.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"Mori","cwd":work,"model":"test","color":"sage",
        "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    Lab { dir, ws, first, _ports: ports }
}

impl Lab {
    fn write(&self, name: &str, bytes: &[u8]) {
        std::fs::write(self.dir.path().join("work").join(name), bytes).unwrap();
    }
    async fn open(&self, path: &str, origin: Option<&str>) -> Result<Value> {
        self.ws.open_preview(Source::Artifact { agent_id: "a".into(), path: path.into() }, origin).await
    }
}

/// One request on the previews' port as a browser would send it: status,
/// head and body.
async fn ask(port: u16, method: &str, path: &str, host: Option<&str>, origin: Option<&str>) -> (u16, String, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let host = host.map(str::to_owned).unwrap_or_else(|| format!("127.0.0.1:{port}"));
    let origin = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
    stream.write_all(format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\n{origin}Connection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut text = String::new();
    let _ = timeout(Duration::from_secs(3), stream.read_to_string(&mut text)).await;
    let status = text.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    (status, head.to_owned(), body.to_owned())
}

fn has(head: &str, name: &str, value: &str) -> bool {
    head.split("\r\n").any(|line| line.split_once(':').is_some_and(|(n, v)| n.eq_ignore_ascii_case(name) && v.trim() == value))
}

fn path_of(url: &Value) -> String {
    let url = url.as_str().unwrap();
    url[url.find("/v/").unwrap()..].to_owned()
}

#[tokio::test]
async fn a_file_opens_working_from_its_own_origin_with_scripts_only_and_stays_as_it_was() {
    let lab = lab();
    lab.write("proto.html", PAGE.as_bytes());
    let view = lab.open("proto.html", Some(CORE)).await.unwrap();
    let port = view["port"].as_u64().unwrap() as u16;
    assert!((lab.first..=lab.first + 3).contains(&port), "a port of the services' range: {view}");
    assert_eq!((view["name"].as_str(), view["size"].as_u64()), (Some("proto.html"), Some(PAGE.len() as u64)));
    assert_eq!(view["sha256"], format!("{:x}", Sha256::digest(PAGE.as_bytes())));
    assert!(view["url"].as_str().unwrap().starts_with(&format!("http://127.0.0.1:{port}/v/")));

    // The page's proof: once, to its own origin only.
    let challenge = format!("{PROOF_PATH}{}", view["proof"]["challenge"].as_str().unwrap());
    assert_eq!(ask(port, "GET", &challenge, None, Some("http://elsewhere.test")).await.0, 404, "another origin gets nothing");
    let (status, head, body) = ask(port, "GET", &challenge, None, Some(CORE)).await;
    assert_eq!((status, body.as_str()), (200, view["proof"]["answer"].as_str().unwrap()));
    assert!(has(&head, "Access-Control-Allow-Origin", CORE), "{head}");
    assert_eq!(ask(port, "GET", &challenge, None, Some(CORE)).await.0, 404, "answered once");

    // The page: HTML, its sandbox and policy, from this snapshot.
    let page = path_of(&view["url"]);
    let (status, head, body) = ask(port, "GET", &page, None, None).await;
    assert_eq!((status, body.as_str()), (200, PAGE));
    assert!(has(&head, "Content-Type", "text/html; charset=utf-8"), "{head}");
    assert!(has(&head, "Content-Security-Policy", &page_policy(Some(CORE))), "{head}");
    for (name, value) in [("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"), ("Cache-Control", "no-store"),
        ("Cross-Origin-Opener-Policy", "same-origin"), ("Cross-Origin-Resource-Policy", "same-origin"), ("Permissions-Policy", PERMISSIONS)] {
        assert!(has(&head, name, value), "{name}: {head}");
    }
    let policy = page_policy(Some(CORE));
    for part in ["sandbox allow-scripts;", "default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'",
        "worker-src 'none'", "base-uri 'none'", "frame-ancestors http://localhost:4317"] {
        assert!(policy.contains(part), "{part}");
    }
    for never in ["allow-same-origin", "allow-forms", "allow-popups", "allow-top-navigation", "allow-modals", "unsafe-eval"] {
        assert!(!policy.contains(never), "{never}");
    }
    // HEAD: the same head, no body.
    let (status, head_only, body) = ask(port, "HEAD", &page, None, None).await;
    assert_eq!((status, body.as_str()), (200, ""));
    assert!(has(&head_only, "Content-Security-Policy", &policy));

    // The file changes; the snapshot does not.
    lab.write("proto.html", b"<p>changed</p>");
    assert_eq!(ask(port, "GET", &page, None, None).await.2, PAGE);
    // A second preview is a new snapshot on the same port.
    let again = lab.open("proto.html", Some(CORE)).await.unwrap();
    assert_eq!(again["port"], view["port"]);
    assert_ne!(again["url"], view["url"]);
    assert_eq!(ask(port, "GET", &path_of(&again["url"]), None, None).await.2, "<p>changed</p>");
}

#[tokio::test]
async fn anything_else_on_the_port_is_refused() {
    let lab = lab();
    lab.write("proto.html", PAGE.as_bytes());
    let view = lab.open("proto.html", Some(CORE)).await.unwrap();
    let port = view["port"].as_u64().unwrap() as u16;
    let page = path_of(&view["url"]);
    // Another name for the address (DNS rebinding) gets no page.
    let (status, head, body) = ask(port, "GET", &page, Some(&format!("rebound.example:{port}")), None).await;
    assert_eq!(status, 421);
    assert!(!body.contains("button") && has(&head, "Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'"));
    assert_eq!(ask(port, "GET", &page, Some(&format!("localhost:{port}")), None).await.0, 200, "localhost is this address too");
    let (status, head, _) = ask(port, "POST", &page, None, None).await;
    assert_eq!(status, 405);
    assert!(has(&head, "Allow", "GET, HEAD"));
    assert_eq!(ask(port, "GET", "/v/0000", None, None).await.0, 404);
    assert_eq!(ask(port, "GET", "/", None, None).await.0, 404);
    assert_eq!(ask(port, "GET", "/api/workspace", None, None).await.0, 404, "never Core's API");
    assert_eq!(ask(port, "GET", &format!("{PROOF_PATH}nope"), None, Some(CORE)).await.0, 404);
    // A snapshot ends with its lifetime (3 s in tests).
    tokio::time::sleep(LIFETIME + Duration::from_millis(200)).await;
    assert_eq!(ask(port, "GET", &page, None, None).await.0, 404);
}

#[tokio::test]
async fn without_a_plain_origin_no_page_may_frame_it() {
    let lab = lab();
    lab.write("proto.html", PAGE.as_bytes());
    for origin in [None, Some("null"), Some("http://evil.test\r\nX-Injected: 1"), Some("javascript://x")] {
        let view = lab.open("proto.html", origin).await.unwrap();
        let port = view["port"].as_u64().unwrap() as u16;
        let (status, head, _) = ask(port, "GET", &path_of(&view["url"]), None, None).await;
        assert_eq!(status, 200);
        assert!(has(&head, "Content-Security-Policy", &page_policy(None)), "{origin:?}: {head}");
        assert!(!head.contains("X-Injected"));
    }
    // The proof of a page that sent no origin is answered without one.
    let view = lab.open("proto.html", None).await.unwrap();
    let port = view["port"].as_u64().unwrap() as u16;
    let (status, head, _) = ask(port, "GET", &format!("{PROOF_PATH}{}", view["proof"]["challenge"].as_str().unwrap()), None, None).await;
    assert_eq!(status, 200);
    assert!(!head.contains("Access-Control-Allow-Origin"));
}

#[tokio::test]
async fn only_one_html_file_of_this_agent_up_to_the_limit_is_previewed() {
    let lab = lab();
    lab.write("notes.txt", b"<b>not html</b>");
    lab.write("binary.html", &[0xff, 0xfe, 0x00]);
    lab.write("big.html", &vec![b'a'; MAX_BYTES + 1]);
    lab.write("edge.html", &vec![b'a'; MAX_BYTES]);
    let error = |result: Result<Value>| result.unwrap_err().to_string();
    assert!(error(lab.open("notes.txt", Some(CORE)).await).starts_with("preview_unsupported"));
    assert!(error(lab.open("binary.html", Some(CORE)).await).starts_with("preview_unsupported"));
    assert!(error(lab.open("big.html", Some(CORE)).await).starts_with("preview_too_large"));
    assert!(lab.open("edge.html", Some(CORE)).await.is_ok(), "exactly the limit is a page");
    std::fs::write(lab.dir.path().join("outside.html"), PAGE).unwrap();
    assert!(lab.open("../outside.html", Some(CORE)).await.is_err(), "outside the Agent's working directory");
    assert!(lab.open("missing.html", Some(CORE)).await.is_err());
    assert!(lab.ws.open_preview(Source::Artifact { agent_id: "nobody".into(), path: "proto.html".into() }, None).await.is_err());
    // The page names its sources in camelCase.
    assert!(serde_json::from_value::<Source>(json!({"kind":"artifact","agentId":"a","path":"p.html"})).is_ok());
    assert!(serde_json::from_value::<Source>(json!({"kind":"briefAttachment","projectId":"p","section":"s","name":"n.html","version":2})).is_ok());
    // A source of no known kind is not read at all.
    assert!(serde_json::from_value::<Source>(json!({"kind":"url","url":"http://x"})).is_err());
    assert!(serde_json::from_value::<Source>(json!({"kind":"artifact","agentId":"a","path":"p.html","extra":1})).is_err());
}

#[tokio::test]
async fn the_oldest_snapshots_go_first_and_kept_bytes_stay_bounded() {
    let lab = lab();
    lab.write("proto.html", PAGE.as_bytes());
    let first = lab.open("proto.html", Some(CORE)).await.unwrap();
    let port = first["port"].as_u64().unwrap() as u16;
    for _ in 0..MAX_KEPT {
        lab.open("proto.html", Some(CORE)).await.unwrap();
    }
    assert_eq!(ask(port, "GET", &path_of(&first["url"]), None, None).await.0, 404, "the oldest of {} went", MAX_KEPT + 1);
    // Large ones: never more than MAX_KEPT_BYTES kept.
    lab.write("big.html", &vec![b'a'; MAX_BYTES]);
    for _ in 0..(MAX_KEPT_BYTES / MAX_BYTES + 2) {
        lab.open("big.html", Some(CORE)).await.unwrap();
    }
    let kept = lab.ws.previews.kept.lock().unwrap();
    assert!(kept.bytes() <= MAX_KEPT_BYTES && kept.snapshots.len() <= MAX_KEPT, "{} bytes in {}", kept.bytes(), kept.snapshots.len());
}
