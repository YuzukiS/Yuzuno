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

/// A Core with one Agent "a" whose working directory is `work`, on disk
/// next to the build (/tmp is memory here, and pages can be large).
fn lab() -> Lab {
    use std::os::unix::fs::MetadataExt;
    let parent = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
    std::fs::create_dir_all(parent).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
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
        self.ws.open_preview(Source::Artifact { agent_id: "a".into(), path: path.into() }, Asker::Local(origin)).await
    }
    /// A snapshot of PAGE as another route would have taken it.
    fn snapshot(&self, ancestor: Option<&str>, via: Via) -> Snapshot {
        let file = self.dir.path().join("taken.html");
        std::fs::write(&file, PAGE).unwrap();
        Snapshot {
            file, size: PAGE.len() as u64, ancestor: ancestor.map(str::to_owned), until: Instant::now() + LIFETIME, via,
            place: Place::Portal, card: None, shown: json!({}), _keep: Keep::default(),
        }
    }
}

/// Core's copies of conversation files, on disk now.
fn copies(lab: &Lab) -> Vec<std::path::PathBuf> {
    match std::fs::read_dir(lab.ws.data_dir.join(COPIES)) {
        Ok(entries) => entries.map(|entry| entry.unwrap().path()).collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => vec![],
        Err(error) => panic!("{error}"),
    }
}

/// One request on the previews' port as a browser would send it: status,
/// head and body.
async fn ask(port: u16, method: &str, path: &str, host: Option<&str>, origin: Option<&str>) -> (u16, String, String) {
    let host = host.map(str::to_owned).unwrap_or_else(|| format!("127.0.0.1:{port}"));
    let origin = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
    ask_with(port, method, path, &format!("Host: {host}\r\n{origin}")).await
}

/// The same with the request's header lines as given (each ending in CRLF).
async fn ask_with(port: u16, method: &str, path: &str, headers: &str) -> (u16, String, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(format!("{method} {path} HTTP/1.1\r\n{headers}Connection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut text = String::new();
    let _ = timeout(Duration::from_secs(3), stream.read_to_string(&mut text)).await;
    let status = text.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    (status, head.to_owned(), body.to_owned())
}

/// A GET of `path` on the previews' port, its body as bytes, however long.
async fn ask_bytes(port: u16, path: &str) -> (u16, String, Vec<u8>) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    let _ = timeout(Duration::from_secs(20), stream.read_to_end(&mut bytes)).await;
    let end = bytes.windows(4).position(|w| w == b"\r\n\r\n").map_or(bytes.len(), |end| end + 4);
    let head = String::from_utf8_lossy(&bytes[..end]).into_owned();
    let status = head.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    (status, head, bytes[end..].to_vec())
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
    lab.write("big.html", &vec![b'a'; MAX_BYTES as usize + 1]);
    lab.write("edge.html", &vec![b'a'; MAX_BYTES as usize]);
    let error = |result: Result<Value>| result.unwrap_err().to_string();
    assert!(error(lab.open("notes.txt", Some(CORE)).await).starts_with("preview_unsupported"));
    assert!(error(lab.open("binary.html", Some(CORE)).await).starts_with("preview_unsupported"));
    assert!(error(lab.open("big.html", Some(CORE)).await).starts_with("preview_too_large"));
    assert!(lab.open("edge.html", Some(CORE)).await.is_ok(), "exactly the limit is a page");
    std::fs::write(lab.dir.path().join("outside.html"), PAGE).unwrap();
    assert!(lab.open("../outside.html", Some(CORE)).await.is_err(), "outside the Agent's working directory");
    assert!(lab.open("missing.html", Some(CORE)).await.is_err());
    assert!(lab.ws.open_preview(Source::Artifact { agent_id: "nobody".into(), path: "proto.html".into() }, Asker::Local(None)).await.is_err());
    // The page names its sources in camelCase.
    assert!(serde_json::from_value::<Source>(json!({"kind":"artifact","agentId":"a","path":"p.html"})).is_ok());
    assert!(serde_json::from_value::<Source>(json!({"kind":"briefAttachment","projectId":"p","section":"s","name":"n.html","version":2})).is_ok());
    // A source of no known kind is not read at all.
    assert!(serde_json::from_value::<Source>(json!({"kind":"url","url":"http://x"})).is_err());
    assert!(serde_json::from_value::<Source>(json!({"kind":"artifact","agentId":"a","path":"p.html","extra":1})).is_err());
}

/// The size of the page that would not open on Home (YN-10), in bytes.
const LARGE: usize = 6_606_144;

#[tokio::test]
async fn a_6_6_mb_home_attachment_opens_whole_on_the_previews_port() {
    let lab = lab();
    let file = lab.dir.path().join("large.html");
    let page = synthetic_page(LARGE);
    std::fs::write(&file, &page).unwrap();
    let kept = crate::project_brief::attach_for_test(&lab.ws, "a", "designs", &file).await;
    let sha = format!("{:x}", Sha256::digest(&page));
    assert_eq!((&kept["snapshot"], &kept["sha256"]), (&json!(true), &json!(sha)), "kept as a snapshot: {kept}");
    let source: Source = serde_json::from_value(json!({"kind":"briefAttachment","projectId":kept["projectId"],
        "section":"designs","name":"large.html"})).unwrap();
    let view = lab.ws.open_preview(source, Asker::Local(Some(CORE))).await;
    assert!(view.is_ok(), "a 6.6 MB Home attachment opens as a preview: {view:?}");
    let view = view.unwrap();
    assert_eq!((view["size"].as_u64(), view["sha256"].as_str()), (Some(LARGE as u64), Some(sha.as_str())), "{view}");
    let port = view["port"].as_u64().unwrap() as u16;
    let (status, head, body) = ask_bytes(port, &path_of(&view["url"])).await;
    assert_eq!(status, 200, "{head}");
    assert!(has(&head, "Content-Length", &LARGE.to_string()), "{head}");
    assert!(has(&head, "Content-Security-Policy", &page_policy(Some(CORE))), "{head}");
    assert_eq!(format!("{:x}", Sha256::digest(&body)), sha, "the page as it was kept, whole ({} bytes came)", body.len());
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
    lab.write("big.html", &vec![b'a'; MAX_BYTES as usize]);
    for _ in 0..(MAX_KEPT_BYTES / MAX_BYTES + 2) {
        lab.open("big.html", Some(CORE)).await.unwrap();
    }
    let kept = lab.ws.previews.kept.lock().unwrap();
    let bytes = kept.bytes(Place::Portal);
    assert!(bytes <= MAX_KEPT_BYTES && kept.snapshots.len() <= MAX_KEPT, "{bytes} bytes in {}", kept.snapshots.len());
    // And on disk, the copies of the ones kept alone.
    assert_eq!(copies(&lab).len(), kept.snapshots.len());
}

#[tokio::test]
async fn the_port_never_serves_through_a_proxy_or_a_doubled_name() {
    let lab = lab();
    lab.write("proto.html", PAGE.as_bytes());
    let view = lab.open("proto.html", Some(CORE)).await.unwrap();
    let port = view["port"].as_u64().unwrap() as u16;
    let page = path_of(&view["url"]);
    let host = format!("Host: 127.0.0.1:{port}\r\n");
    assert_eq!(ask_with(port, "GET", &page, &host).await.0, 200);
    // A proxy pointed at P (Serve, say) adds one of these; a phone uses the previews' own entry.
    for proxied in ["Tailscale-User-Login: owner@github", "Tailscale-Headers-Info: x", "Tailscale-Funnel-Request: ?1", "X-Forwarded-For: 100.64.0.2"] {
        let (status, _, body) = ask_with(port, "GET", &page, &format!("{host}{proxied}\r\n")).await;
        assert_eq!(status, 403, "{proxied}");
        assert!(body.contains("Proxied request") && !body.contains("button"), "{proxied}: {body}");
    }
    // Two names, one of them this port's: not a request for this port.
    assert_eq!(ask_with(port, "GET", &page, &format!("{host}Host: rebound.example:{port}\r\n")).await.0, 421);
    assert_eq!(ask_with(port, "GET", &page, &format!("{host}{host}")).await.0, 421);
    // The proof: two Origins are none of them.
    let challenge = format!("{PROOF_PATH}{}", view["proof"]["challenge"].as_str().unwrap());
    let doubled = format!("{host}Origin: {CORE}\r\nOrigin: {CORE}\r\n");
    assert_eq!(ask_with(port, "GET", &challenge, &doubled).await.0, 404);
    assert_eq!(ask(port, "GET", &challenge, None, Some(CORE)).await.0, 200, "still unused");
}

#[tokio::test]
async fn a_snapshot_taken_for_the_phone_entry_never_opens_on_this_port() {
    let lab = lab();
    lab.write("proto.html", PAGE.as_bytes());
    let view = lab.open("proto.html", Some(CORE)).await.unwrap();
    let port = view["port"].as_u64().unwrap() as u16;
    // As the phone entry would have taken it (remote_access's tests take it so).
    let origin = "https://pc.tail0.ts.net:8444";
    {
        let mut kept = lab.ws.previews.kept.lock().unwrap();
        kept.snapshots.insert("phone".into(), lab.snapshot(Some(origin), Via::Phone(7)));
        kept.proofs.insert("phone".into(), Proof {
            answer: "a".into(), origin: Some(origin.into()), until: Instant::now() + PROOF_TTL, used: false, via: Via::Phone(7),
        });
    }
    assert_eq!(ask(port, "GET", "/v/phone", None, None).await.0, 404);
    assert_eq!(ask(port, "GET", &format!("{PROOF_PATH}phone"), None, Some(origin)).await.0, 404);
    // This port's own snapshot still opens.
    assert_eq!(ask(port, "GET", &path_of(&view["url"]), None, None).await.0, 200);
}

#[tokio::test]
async fn revoking_the_phones_previews_keeps_this_ports_and_another_runs_only_when_asked() {
    let lab = lab();
    lab.write("proto.html", PAGE.as_bytes());
    let view = lab.open("proto.html", Some(CORE)).await.unwrap();
    let local = path_of(&view["url"]).trim_start_matches(PAGE_PATH).to_owned();
    {
        let mut kept = lab.ws.previews.kept.lock().unwrap();
        for (token, run) in [("one", 1), ("two", 2)] {
            kept.snapshots.insert(token.into(), lab.snapshot(None, Via::Phone(run)));
            kept.order.push_back(token.into());
            kept.proofs.insert(token.into(), Proof { answer: "a".into(), origin: None, until: Instant::now() + PROOF_TTL, used: false, via: Via::Phone(run) });
        }
    }
    let left = |lab: &Lab| {
        let kept = lab.ws.previews.kept.lock().unwrap();
        let mut snapshots: Vec<String> = kept.snapshots.keys().cloned().collect();
        snapshots.sort();
        let mut proofs: Vec<String> = kept.proofs.keys().filter(|k| ["one", "two"].contains(&k.as_str())).cloned().collect();
        proofs.sort();
        (snapshots, proofs, kept.order.len())
    };
    lab.ws.previews.revoke_phone(Some(2));
    let mut want = vec![local.clone(), "two".to_owned()];
    want.sort();
    assert_eq!(left(&lab), (want, vec!["two".to_owned()], 2));
    lab.ws.previews.revoke_phone(None);
    assert_eq!(left(&lab), (vec![local], vec![], 1));
}

#[test]
fn the_phone_entrys_reserved_path_is_reached_only_as_it_was_sent() {
    for plain in ["/__yuzuno", "/__yuzuno/", "/__yuzuno/preview/v/abc", "/__yuzuno/preview/proof/abc", "/__yuzuno/anything/else"] {
        assert!(aims_at_reserved(plain) && plainly_reserved(plain), "{plain}");
    }
    for odd in [
        "/%5F%5Fyuzuno/preview/v/a", "/%5f_yuzuno/preview", "/%255F%255Fyuzuno/x", "//__yuzuno/preview", "/./__yuzuno/", "/x/../__yuzuno/preview",
        "/__yuzuno/./preview", "/__yuzuno/preview/../preview/v/a", "/__YUZUNO/preview", "/__Yuzuno", "\\__yuzuno/preview", "/\\__yuzuno",
        "/__yuzuno%2Fpreview", "/__yuzuno/preview/v/%61", "/__yuzuno//preview",
    ] {
        assert!(aims_at_reserved(odd) && !plainly_reserved(odd), "{odd}");
    }
    for other in ["/", "/api/health", "/__yuzunox/a", "/__yuzuno-not", "/assets/__yuzuno", "/x/__yuzuno", "/%5F%5Fyuzunox", "/__yuzuno/../api"] {
        assert!(!aims_at_reserved(other), "{other}");
    }
}

#[test]
fn a_phone_preview_is_named_by_its_token_alone_as_it_was_sent() {
    let token = "0123456789abcdef".repeat(4);
    assert_eq!(named(&format!("{PHONE_PAGE}{token}"), PHONE_PAGE), Some(token.as_str()));
    for odd in [String::new(), token.to_uppercase(), format!("%30{}", &token[1..]), format!("{token}/x"), format!("{token}?"), "zz".into(), "1".repeat(129)] {
        assert_eq!(named(&format!("{PHONE_PAGE}{odd}"), PHONE_PAGE), None, "{odd:?}");
    }
    assert_eq!(named(&format!("{PHONE_PROOF}{token}"), PHONE_PAGE), None, "a proof is not a page");
}

/// Bytes sent as they are, in one write: status, head and body of the answer.
async fn send(port: u16, bytes: &str) -> (u16, String, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(bytes.as_bytes()).await.unwrap();
    let mut text = String::new();
    let _ = timeout(Duration::from_secs(3), stream.read_to_string(&mut text)).await;
    let status = text.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    (status, head.to_owned(), body.to_owned())
}

#[test]
fn headers_are_the_lines_before_the_blank_line_and_nothing_after() {
    let head = "GET /v/x HTTP/1.1\r\nHost: 127.0.0.1:1\r\nTailscale-User-Login: a\r\n\r\nTailscale-User-Login: b\r\nHost: other\r\n";
    assert_eq!(values(head, "tailscale-user-login"), ["a"]);
    assert_eq!(values(head, "host"), ["127.0.0.1:1"]);
    assert!(values("GET / HTTP/1.1\r\n\r\nOrigin: http://x\r\n", "origin").is_empty());
    // A name with spaces around it is no header's.
    assert!(values("GET / HTTP/1.1\r\n Host: x\r\nHost : y\r\n\r\n", "host").is_empty());
    // Doubled real headers stay doubled.
    assert_eq!(values("GET / HTTP/1.1\r\nHost: a\r\nhost: b\r\n\r\n", "host"), ["a", "b"]);
}

#[tokio::test]
async fn what_follows_the_head_is_never_read_as_its_headers() {
    let lab = lab();
    lab.write("proto.html", PAGE.as_bytes());
    let view = lab.open("proto.html", Some(CORE)).await.unwrap();
    let port = view["port"].as_u64().unwrap() as u16;
    let page = path_of(&view["url"]);
    let host = format!("Host: 127.0.0.1:{port}\r\n");
    // A body whose lines look like headers: the page as it is.
    let body = "Tailscale-User-Login: owner@github\r\nX-Forwarded-For: 100.64.0.2\r\nHost: other\r\n";
    let (status, _, got) = send(port, &format!("GET {page} HTTP/1.1\r\n{host}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())).await;
    assert_eq!((status, got.as_str()), (200, PAGE));
    // A second request in the same write: only the first is answered, by its own headers.
    let (status, _, got) = send(port, &format!("GET {page} HTTP/1.1\r\n{host}\r\nGET {page} HTTP/1.1\r\nTailscale-User-Login: x\r\n\r\n")).await;
    assert_eq!((status, got.as_str()), (200, PAGE));
    // A head over the limit gets no answer at all.
    let (status, head, _) = send(port, &format!("GET {page} HTTP/1.1\r\n{host}X-Pad: {}\r\n\r\n", "a".repeat(HEAD_LIMIT))).await;
    assert_eq!(status, 0, "{head}");
}

/// The preview of `kept`'s attachment (`attach_for_test`): from a card, with
/// the version it shows, or (no place) from the Portal.
fn attachment(kept: &Value, place: Option<&str>) -> Source {
    let mut source = json!({"kind":"briefAttachment","projectId":kept["projectId"],"section":kept["section"],"name":kept["name"]});
    if let Some(place) = place {
        source["place"] = json!(place);
        source["version"] = kept["version"].clone();
    }
    serde_json::from_value(source).unwrap()
}

/// A Home card's preview of `kept`'s attachment, asked for by the page at `origin`.
async fn card(lab: &Lab, kept: &Value, origin: &str) -> Value {
    lab.ws.open_preview(attachment(kept, Some("card")), Asker::Local(Some(origin))).await.unwrap()
}

#[tokio::test]
async fn a_large_snapshot_stays_while_it_is_shown_and_goes_when_its_hour_is_up() {
    let lab = lab();
    let page = synthetic_page(3 << 20);
    lab.write("copied.html", &page);
    let file = lab.dir.path().join("held.html");
    std::fs::write(&file, &page).unwrap();
    let kept = crate::project_brief::attach_for_test(&lab.ws, "a", "designs", &file).await;
    let held = lab.ws.data_dir.join("brief-attachments").join(kept["sha256"].as_str().unwrap());
    let copied = lab.open("copied.html", Some(CORE)).await.unwrap();
    let shown = lab.ws.open_preview(attachment(&kept, None), Asker::Local(Some(CORE))).await.unwrap();
    let port = shown["port"].as_u64().unwrap() as u16;
    assert_eq!((copies(&lab).len(), crate::project_brief::attachment_held(&held)), (1, true));
    // No section keeps the attachment now, and the cache is cleared: the preview still has it.
    lab.ws.store.db.write().unwrap().execute("DELETE FROM project_brief_snapshots", []).unwrap();
    crate::project_brief::collect_attachment_garbage(&lab.ws.store, held.parent().unwrap()).unwrap();
    let (status, _, body) = ask_bytes(port, &path_of(&shown["url"])).await;
    assert_eq!((status, body.len()), (200, page.len()), "held through Clear cache");
    // Its hour (LIFETIME here) is up, and nothing else was asked meanwhile.
    tokio::time::sleep(LIFETIME + Duration::from_millis(500)).await;
    assert!(lab.ws.previews.kept.lock().unwrap().snapshots.is_empty());
    assert!(copies(&lab).is_empty(), "{:?}", copies(&lab));
    assert!(!crate::project_brief::attachment_held(&held));
    crate::project_brief::collect_attachment_garbage(&lab.ws.store, held.parent().unwrap()).unwrap();
    assert!(!held.exists(), "collected once no preview holds it");
    for view in [&copied, &shown] {
        assert_eq!(ask(port, "GET", &path_of(&view["url"]), None, None).await.0, 404);
    }
}

#[tokio::test]
async fn a_range_request_gets_the_whole_page_with_the_same_headers() {
    let lab = lab();
    lab.write("proto.html", PAGE.as_bytes());
    let view = lab.open("proto.html", Some(CORE)).await.unwrap();
    let port = view["port"].as_u64().unwrap() as u16;
    let headers = format!("Host: 127.0.0.1:{port}\r\nRange: bytes=0-9\r\n");
    let (status, head, body) = ask_with(port, "GET", &path_of(&view["url"]), &headers).await;
    assert_eq!((status, body.as_str()), (200, PAGE), "{head}");
    assert!(has(&head, "Content-Security-Policy", &page_policy(Some(CORE))) && has(&head, "Content-Length", &PAGE.len().to_string()), "{head}");
    let lower = head.to_ascii_lowercase();
    assert!(!lower.contains("content-range") && !lower.contains("accept-ranges"), "{head}");
}

#[tokio::test]
async fn copies_an_earlier_core_left_are_removed_at_the_first_copy() {
    use std::os::unix::fs::PermissionsExt;
    let lab = lab();
    let left = lab.ws.data_dir.join(COPIES).join("left.html");
    std::fs::create_dir_all(left.parent().unwrap()).unwrap();
    std::fs::write(&left, PAGE).unwrap();
    lab.write("proto.html", PAGE.as_bytes());
    lab.open("proto.html", Some(CORE)).await.unwrap();
    let now = copies(&lab);
    assert!(!left.exists() && now.len() == 1, "{now:?}");
    // Core's alone to read.
    let mode = |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!((mode(&lab.ws.data_dir.join(COPIES)), mode(&now[0])), (0o700, 0o600));
}

#[tokio::test]
async fn a_card_is_given_its_live_snapshot_again_with_a_proof_of_its_own() {
    let lab = lab();
    let file = lab.dir.path().join("card.html");
    std::fs::write(&file, PAGE).unwrap();
    let kept = crate::project_brief::attach_for_test(&lab.ws, "a", "designs", &file).await;
    let first = card(&lab, &kept, CORE).await;
    let again = card(&lab, &kept, CORE).await;
    assert_eq!((&first["place"], &first["reused"], &again["reused"]), (&json!("card"), &json!(false), &json!(true)), "{first}");
    assert_eq!(first["version"], kept["version"]);
    for field in ["url", "takenAt", "expiresAt", "sha256", "size", "version"] {
        assert_eq!(again[field], first[field], "{field}: never given more time");
    }
    assert_ne!(again["proof"]["challenge"], first["proof"]["challenge"]);
    // Each viewer's proof, once.
    let port = first["port"].as_u64().unwrap() as u16;
    for view in [&first, &again] {
        let challenge = format!("{PROOF_PATH}{}", view["proof"]["challenge"].as_str().unwrap());
        assert_eq!(ask(port, "GET", &challenge, None, Some(CORE)).await.2, view["proof"]["answer"].as_str().unwrap());
        assert_eq!(ask(port, "GET", &challenge, None, Some(CORE)).await.0, 404, "answered once");
    }
    // Another asking page gets a snapshot of its own, and the Portal a new one each time.
    let elsewhere = card(&lab, &kept, "http://127.0.0.1:4317").await;
    let portal = lab.ws.open_preview(attachment(&kept, None), Asker::Local(Some(CORE))).await.unwrap();
    let portal_again = lab.ws.open_preview(attachment(&kept, None), Asker::Local(Some(CORE))).await.unwrap();
    assert!(elsewhere["url"] != first["url"] && portal["url"] != first["url"] && portal_again["url"] != portal["url"]);
    assert_eq!((&portal["place"], &portal_again["reused"]), (&json!("portal"), &json!(false)));
    // A card names its version, and gets that one or none.
    let error = |result: Result<Value>| result.unwrap_err().to_string();
    let versioned = |version: Value| -> Source {
        serde_json::from_value(json!({"kind":"briefAttachment","projectId":kept["projectId"],"section":"designs","name":"card.html",
            "version":version,"place":"card"})).unwrap()
    };
    assert!(error(lab.ws.open_preview(versioned(Value::Null), Asker::Local(Some(CORE))).await).starts_with("invalid_input"));
    assert!(error(lab.ws.open_preview(versioned(json!(99)), Asker::Local(Some(CORE))).await).starts_with("section_not_found"));
    // Only a Home attachment has a place.
    assert!(serde_json::from_value::<Source>(json!({"kind":"artifact","agentId":"a","path":"p.html","place":"card"})).is_err());
    // With less than REUSE_LEFT left, a new one.
    tokio::time::sleep(LIFETIME - REUSE_LEFT + Duration::from_millis(200)).await;
    let late = card(&lab, &kept, CORE).await;
    assert!(late["reused"] == json!(false) && late["url"] != first["url"], "{late}");
}

#[tokio::test]
async fn cards_never_take_the_place_of_a_snapshot_the_portal_opened() {
    let lab = lab();
    let file = lab.dir.path().join("card.html");
    std::fs::write(&file, PAGE).unwrap();
    let kept = crate::project_brief::attach_for_test(&lab.ws, "a", "designs", &file).await;
    let portal = lab.ws.open_preview(attachment(&kept, None), Asker::Local(Some(CORE))).await.unwrap();
    let port = portal["port"].as_u64().unwrap() as u16;
    for n in 0..=MAX_CARDS {
        card(&lab, &kept, &format!("http://localhost:{}", 5000 + n)).await;
    }
    assert_eq!(ask(port, "GET", &path_of(&portal["url"]), None, None).await.0, 200, "the Portal's snapshot stays");
    {
        let kept = lab.ws.previews.kept.lock().unwrap();
        assert_eq!(kept.snapshots.values().filter(|s| s.place == Place::Card).count(), MAX_CARDS);
    }
    // One card shown over and over: a proof each time, at most MAX_PROOFS kept, the newest good.
    let mut last = Value::Null;
    for _ in 0..=MAX_PROOFS {
        last = card(&lab, &kept, CORE).await;
    }
    assert_eq!(last["reused"], json!(true));
    assert!(lab.ws.previews.kept.lock().unwrap().proofs.len() <= MAX_PROOFS);
    let challenge = format!("{PROOF_PATH}{}", last["proof"]["challenge"].as_str().unwrap());
    assert_eq!(ask(port, "GET", &challenge, None, Some(CORE)).await.2, last["proof"]["answer"].as_str().unwrap());
}

#[test]
fn utf8_is_checked_across_chunk_boundaries() {
    let text = "a é 中 🙂 z".as_bytes();
    for cut in 0..=text.len() {
        let mut check = Utf8::default();
        assert!(check.feed(&text[..cut]) && check.feed(&text[cut..]) && check.whole(), "cut at {cut}");
    }
    let mut check = Utf8::default();
    assert!(text.iter().all(|byte| check.feed(std::slice::from_ref(byte))) && check.whole(), "a byte at a time");
    // A stray continuation byte, an overlong form, a surrogate, a character cut off at the end.
    for bad in [&b"a\x80"[..], b"\xC0\xAF", b"\xED\xA0\x80", b"\xE4\xB8"] {
        for cut in 0..=bad.len() {
            let mut check = Utf8::default();
            assert!(!(check.feed(&bad[..cut]) && check.feed(&bad[cut..]) && check.whole()), "{bad:?} cut at {cut}");
        }
    }
}
