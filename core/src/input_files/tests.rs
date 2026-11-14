//! Attached files (YN-145 F1): their names, the streamed upload and its
//! limits, the check before a send, the user's routes and an Agent's delete.
//! Synthetic Agents and files only.
use super::*;
use crate::model::AgentDetail;
use axum::http::{Request as HttpRequest, StatusCode};
use serde_json::{json, Value};
use std::os::unix::fs::symlink;

/// `SAVING` is one slot for the whole process: tests that upload take turns.
static UPLOADING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const MIB: usize = 1024 * 1024;

fn mode(path: &FsPath) -> u32 {
    std::fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
}

/// A body sent in chunks of at most 1 MiB, as a browser streams one.
fn streamed(bytes: usize, fill: u8) -> Body {
    let chunk = Bytes::from(vec![fill; MIB]);
    let mut left = bytes;
    let chunks = std::iter::from_fn(move || {
        let take = left.min(MIB);
        left -= take;
        (take > 0).then(|| Ok::<_, std::io::Error>(chunk.slice(..take)))
    });
    Body::from_stream(futures_util::stream::iter(chunks))
}

fn hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// The names in `dir` and the files in each of its folders, sorted.
fn contents(dir: &FsPath) -> Vec<String> {
    let mut found = vec![];
    for entry in std::fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().unwrap().is_dir() {
            for inner in std::fs::read_dir(entry.path()).unwrap() {
                found.push(format!("{name}/{}", inner.unwrap().file_name().to_string_lossy()));
            }
        } else {
            found.push(name);
        }
    }
    found.sort();
    found
}

#[test]
fn a_saved_name_is_one_path_segment_no_hidden_file_no_option_and_keeps_its_extension() {
    let long_chinese = format!("{}.pdf", "季度报告".repeat(80));
    let long_ascii = format!("{}.tar.gz", "a".repeat(300));
    for (given, saved) in [
        ("q3-report.pdf", "q3-report.pdf"),
        ("../x", "x"),
        ("a/b", "b"),
        ("\\\\x", "x"),
        ("C:\\Users\\someone\\notes.txt", "notes.txt"),
        (".env", "_.env"),
        ("-rf", "_-rf"),
        ("--help.txt", "_--help.txt"),
        ("line\nbreak\u{7}\u{0}.txt", "line_break__.txt"),
        ("what?*:<>|\"`.md", "what________.md"),
        ("trailing. . ", "trailing"),
        ("", "file"),
        (".", "file"),
        ("..", "file"),
        ("a/", "file"),
        ("   ", "file"),
        ("传感器 日志.csv", "传感器 日志.csv"),
    ] {
        assert_eq!(safe_name(given), saved, "{given:?}");
    }
    // A long name is cut before its extension: 200 UTF-16 units, 240 bytes.
    // Each of these characters is 3 bytes: 78 of them and ".pdf" fit in 240.
    assert_eq!(safe_name(&long_chinese), format!("{}季度.pdf", "季度报告".repeat(19)));
    let cut = safe_name(&long_ascii);
    assert_eq!((cut.len(), cut.ends_with("a.gz")), (200, true), "{cut}");
    // Emoji count two UTF-16 units, as the web counts a name.
    let emoji = safe_name(&"😀".repeat(150));
    assert_eq!((emoji.encode_utf16().count(), emoji.len()), (120, 240));
    // A safe name is its own safe name, so a message's names can be checked.
    let spaces = format!("x{}y", " ".repeat(300));
    for given in [long_chinese.as_str(), &long_ascii, &spaces, "\u{1}", "-", ".env", "a. .b. ", &format!(" {}", ".".repeat(300))] {
        let once = safe_name(given);
        assert_eq!(safe_name(&once), once, "{given:?}");
        assert!(!once.is_empty() && !once.starts_with(['.', '-']) && !once.ends_with([' ', '.']), "{once:?}");
    }
}

#[test]
fn only_codex_claude_and_opencode_take_files_and_owners_are_plain_ids() {
    assert!(["codex", "claude", "opencode"].iter().all(|harness| takes_files(harness)));
    assert!(!takes_files("deepseek") && !takes_files(""));
    let root = FsPath::new("/data");
    assert_eq!(agent_dir(root, "agent-1").unwrap(), PathBuf::from("/data/input-files/agent-1"));
    for bad in ["", "..", "a/b", "a.b", &"a".repeat(101)] {
        assert!(agent_dir(root, bad).is_err(), "{bad:?}");
    }
    let id = "a".repeat(64);
    assert!(file_path(root, &id, "x.pdf").is_ok());
    for (id, name) in [(&"A".repeat(64), "x.pdf"), (&"a".repeat(63), "x.pdf"), (&id, "../x"), (&id, ".env"), (&id, ""), (&id, "a/b")] {
        assert!(file_path(root, id, name).is_err(), "{id} {name:?}");
    }
}

#[tokio::test]
async fn an_upload_streams_to_a_private_read_only_file_named_by_its_content() {
    let _turn = UPLOADING.lock().await;
    let tmp = tempfile::tempdir().unwrap();
    let dir = agent_dir(tmp.path(), "a").unwrap();
    let saved = save_stream(dir.clone(), "Q3 report.pdf", None, streamed(3 * MIB + 5, 7)).await.unwrap();
    let expected = vec![7u8; 3 * MIB + 5];
    assert_eq!(saved, FileRef { id: hex(&expected), name: "Q3 report.pdf".into(), bytes: expected.len() as u64 });
    let path = dir.join(&saved.id).join(&saved.name);
    assert_eq!(std::fs::read(&path).unwrap(), expected);
    assert_eq!((mode(&path), mode(path.parent().unwrap()), mode(&dir), mode(&tmp.path().join("input-files"))), (0o400, 0o700, 0o700, 0o700));
    // The same name with the same content is kept once; another name is a second copy.
    assert_eq!(save_stream(dir.clone(), "Q3 report.pdf", None, streamed(3 * MIB + 5, 7)).await.unwrap(), saved);
    let copy = save_stream(dir.clone(), "copy.pdf", None, streamed(3 * MIB + 5, 7)).await.unwrap();
    assert_eq!((copy.id.as_str(), copy.name.as_str()), (saved.id.as_str(), "copy.pdf"));
    assert_eq!(contents(&dir), [format!("{}/Q3 report.pdf", saved.id), format!("{}/copy.pdf", saved.id)]);
    // The user's name is made safe before it is saved.
    assert_eq!(save_stream(dir.clone(), "../.env", None, Body::from("KEY=1")).await.unwrap().name, "_.env");
    // A copy changed since it was saved is replaced by the upload.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(&path, b"changed").unwrap();
    assert_eq!(save_stream(dir.clone(), "Q3 report.pdf", None, streamed(3 * MIB + 5, 7)).await.unwrap(), saved);
    assert_eq!((std::fs::read(&path).unwrap(), mode(&path)), (expected, 0o400));
    assert!(check(&dir, &[saved]).is_ok());
}

#[tokio::test]
async fn an_upload_takes_40_mib_and_refuses_one_byte_more_or_a_body_that_stops_leaving_nothing() {
    let _turn = UPLOADING.lock().await;
    let tmp = tempfile::tempdir().unwrap();
    let dir = agent_dir(tmp.path(), "a").unwrap();
    let full = save_stream(dir.clone(), "full.bin", None, streamed(40 * MIB, 1)).await.unwrap();
    assert_eq!(full.bytes, MAX_TOTAL);
    let over = save_stream(dir.clone(), "over.bin", None, streamed(40 * MIB + 1, 2)).await.unwrap_err();
    assert_eq!(over.to_string(), TOO_LARGE);
    // A declared Content-Length over the limit is refused before anything is read.
    let declared = save_stream(agent_dir(tmp.path(), "b").unwrap(), "x", Some(MAX_TOTAL + 1), Body::from("x")).await.unwrap_err();
    assert_eq!(declared.to_string(), TOO_LARGE);
    assert!(!tmp.path().join("input-files/b").exists());
    assert_eq!(save_stream(dir.clone(), "empty.txt", None, Body::empty()).await.unwrap_err().to_string(), "A file must hold at least 1 byte");
    let broken = futures_util::stream::iter([Ok(Bytes::from_static(b"half")), Err(std::io::Error::other("connection reset"))]);
    let stopped = save_stream(dir.clone(), "half.txt", None, Body::from_stream(broken)).await.unwrap_err();
    assert!(format!("{stopped:#}").contains("stopped before the whole file arrived"), "{stopped:#}");
    // Only the whole file is kept: no temporary file is left behind.
    assert_eq!(contents(&dir), [format!("{}/full.bin", full.id)]);
}

#[tokio::test]
async fn an_agents_folder_holds_at_most_256_mib_and_4096_files() {
    let _turn = UPLOADING.lock().await;
    let tmp = tempfile::tempdir().unwrap();
    let dir = agent_dir(tmp.path(), "a").unwrap();
    // A sparse file stands for 255 MiB already saved.
    let kept = dir.join("b".repeat(64));
    make_private(&kept).unwrap();
    std::fs::File::create(kept.join("big.bin")).unwrap().set_len(MAX_FOLDER - MIB as u64).unwrap();
    const FULL: &str = "This Agent's saved files reached the 256 MiB limit";
    assert_eq!(save_stream(dir.clone(), "x", None, streamed(MIB + 1, 3)).await.unwrap_err().to_string(), FULL);
    assert_eq!(save_stream(dir.clone(), "x", Some(MIB as u64 + 1), Body::from("x")).await.unwrap_err().to_string(), FULL);
    assert!(save_stream(dir.clone(), "fits.bin", None, streamed(MIB, 3)).await.is_ok());
    assert_eq!(save_stream(dir.clone(), "x", None, Body::from("x")).await.unwrap_err().to_string(), FULL);
    // 4096 files, however small, fill a folder too.
    let many = agent_dir(tmp.path(), "many").unwrap();
    for n in 0..MAX_FOLDER_FILES {
        let folder = many.join(format!("{n:064x}"));
        make_private(&folder).unwrap();
        std::fs::write(folder.join("n"), b"n").unwrap();
    }
    let refused = save_stream(many, "one-more", None, Body::from("x")).await.unwrap_err();
    assert_eq!(refused.to_string(), "This Agent's saved files reached the 4096-file limit");
}

#[test]
fn a_message_names_only_this_folders_unchanged_files_within_the_limits() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = agent_dir(tmp.path(), "a").unwrap();
    let save = |name: &str, bytes: &[u8]| {
        let mut saving = Saving::begin(&dir, name.into(), None).unwrap();
        saving.write(bytes).unwrap();
        saving.finish().unwrap()
    };
    let (one, two) = (save("one.txt", b"first"), save("two.csv", b"a,b\n1,2\n"));
    assert_eq!(check(&dir, &[one.clone(), two.clone()]).unwrap(), [dir.join(&one.id).join("one.txt"), dir.join(&two.id).join("two.csv")]);
    assert_eq!(check(&dir, &[]).unwrap(), Vec::<PathBuf>::new());
    let refused = |refs: &[FileRef]| check(&dir, refs).unwrap_err().to_string();
    assert_eq!(refused(&[one.clone(), one.clone()]), "Duplicate file reference");
    assert_eq!(refused(&vec![one.clone(); 9]), "Attach at most 8 files per message");
    assert_eq!(refused(&[FileRef { bytes: MAX_TOTAL + 1, ..one.clone() }]), TOO_LARGE);
    assert_eq!(refused(&[FileRef { bytes: u64::MAX, ..one.clone() }, two.clone()]), TOO_LARGE);
    assert_eq!(refused(&[FileRef { bytes: 4, ..one.clone() }]), "Saved file one.txt changed; attach it again");
    assert_eq!(refused(&[FileRef { name: "other.txt".into(), ..one.clone() }]), "Saved file is missing; attach it again");
    assert_eq!(refused(&[FileRef { name: ".env".into(), ..one.clone() }]), "Invalid file name");
    assert_eq!(refused(&[FileRef { id: "../../x".into(), ..one.clone() }]), "Invalid file reference");
    // Another Agent's folder does not hold this one's files.
    assert!(check(&agent_dir(tmp.path(), "b").unwrap(), &[one.clone()]).is_err());
    // Changed content of the same size.
    let path = dir.join(&two.id).join("two.csv");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(&path, b"a,b\n1,3\n").unwrap();
    assert_eq!(refused(&[two.clone()]), "Saved file two.csv changed; attach it again");
    // A link, as the file or as its folder, is not followed.
    let outside = tmp.path().join("outside.txt");
    std::fs::write(&outside, b"first").unwrap();
    let file = dir.join(&one.id).join("one.txt");
    std::fs::remove_file(&file).unwrap();
    symlink(&outside, &file).unwrap();
    assert_eq!(refused(&[one.clone()]), "Saved file is missing; attach it again");
    std::fs::remove_file(&file).unwrap();
    std::fs::remove_dir(dir.join(&one.id)).unwrap();
    let elsewhere = tmp.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::fs::write(elsewhere.join("one.txt"), b"first").unwrap();
    symlink(&elsewhere, dir.join(&one.id)).unwrap();
    assert_eq!(refused(&[one.clone()]), "Invalid saved file");
    // A pipe in its place is refused without waiting for a writer.
    std::fs::remove_file(dir.join(&one.id)).unwrap();
    make_private(&dir.join(&one.id)).unwrap();
    assert!(std::process::Command::new("mkfifo").arg(&file).status().unwrap().success());
    assert_eq!(refused(&[one]), "Invalid saved file");
}

fn agent(store: &crate::store::Store, id: &str, harness: &str) {
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work",
        "model":"","harness":harness,"color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&detail).unwrap();
}

/// A Workspace whose Agents never start: `a` and `b` Codex, `c` closed.
fn lab() -> (tempfile::TempDir, Arc<Workspace>) {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into(),
        tmp.path().join("no-codex").to_string_lossy().into()).unwrap();
    for id in ["a", "b", "c"] {
        agent(&ws.store, id, "codex");
    }
    (tmp, ws)
}

/// A request as the user's page on Core's port sends it, with `extra` headers.
async fn call(app: &Router, method: &str, uri: &str, body: Body, extra: &[(&str, &str)]) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut builder = HttpRequest::builder().method(method).uri(uri)
        .header("host", "127.0.0.1:4317").header("x-yuzuno-client", "desktop");
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    let response = app.clone().oneshot(builder.body(body).unwrap()).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    (status, headers, axum::body::to_bytes(response.into_body(), 64 * MIB).await.unwrap().to_vec())
}

fn error(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body).unwrap()["error"].as_str().unwrap_or_default().to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_users_page_uploads_and_downloads_an_agents_files_and_an_agents_credential_is_refused() {
    let _turn = UPLOADING.lock().await;
    let (_tmp, ws) = lab();
    let app = crate::server::router(ws.clone(), ws.data_dir.join("assets"));
    let name = "季度 report #1.html";
    let uri = "/api/agents/a/files?name=%E5%AD%A3%E5%BA%A6%20report%20%231.html";
    let page = b"<script>alert(1)</script>".to_vec();
    let (status, _, body) = call(&app, "POST", uri, Body::from(page.clone()), &[("content-type", "application/octet-stream")]).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let saved: FileRef = serde_json::from_slice(&body).unwrap();
    assert_eq!(saved, FileRef { id: hex(&page), name: name.into(), bytes: page.len() as u64 });
    let download = format!("/api/agents/a/files/{}/%E5%AD%A3%E5%BA%A6%20report%20%231.html", saved.id);
    let (status, headers, body) = call(&app, "GET", &download, Body::empty(), &[]).await;
    assert_eq!((status, body), (StatusCode::OK, page.clone()));
    // Always a download, never a page under Core's origin.
    for (header, value) in [
        ("content-type", "application/octet-stream"),
        ("content-disposition", "attachment; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%20report%20#1.html"),
        ("x-content-type-options", "nosniff"),
        ("content-security-policy", "sandbox"),
        ("cache-control", "no-store"),
    ] {
        assert_eq!(headers[header], value, "{header}");
    }
    // An Agent's credential is refused on both routes; nothing is saved.
    let bearer = [("authorization", "Bearer synthetic-agent-token")];
    for (method, uri) in [("POST", "/api/agents/a/files?name=x.txt"), ("GET", download.as_str())] {
        let (status, _, _) = call(&app, method, uri, Body::from("x"), &bearer).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
    }
    // Another Agent's route does not read this Agent's file.
    let other = download.replacen("/agents/a/", "/agents/b/", 1);
    let (status, _, _) = call(&app, "GET", &other, Body::empty(), &[]).await;
    assert_ne!(status, StatusCode::OK);
    for bad in [format!("/api/agents/a/files/{}/..%2Fx", saved.id), "/api/agents/a/files/x/y.txt".to_owned()] {
        let (status, _, body) = call(&app, "GET", &bad, Body::empty(), &[]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {}", String::from_utf8_lossy(&body));
    }
    let (status, _, body) = call(&app, "POST", "/api/agents/missing/files?name=x", Body::from("x"), &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{}", String::from_utf8_lossy(&body));
    // A closed Agent takes no new file; what it was sent still downloads.
    ws.close_agent("a").await.unwrap();
    let (status, _, body) = call(&app, "POST", uri, Body::from("x"), &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{}", error(&body));
    let (status, _, body) = call(&app, "GET", &download, Body::empty(), &[]).await;
    assert_eq!((status, body), (StatusCode::OK, page));
    // A harness that takes no files is refused before anything is read.
    agent(&ws.store, "d", "deepseek");
    let (status, _, body) = call(&app, "POST", "/api/agents/d/files?name=x", Body::from("x"), &[]).await;
    assert_eq!((status, error(&body)), (StatusCode::BAD_REQUEST, "Agent d can't receive files; Codex, Claude and OpenCode Agents can".into()));
    assert!(!ws.data_dir.join("input-files/d").exists());
}

#[tokio::test]
async fn deleting_an_agent_removes_its_own_files_only() {
    let (_tmp, ws) = lab();
    let keep = |agent: &str| {
        let dir = agent_dir(&ws.data_dir, agent).unwrap();
        let mut saving = Saving::begin(&dir, "notes.txt".into(), None).unwrap();
        saving.write(agent.as_bytes()).unwrap();
        saving.finish().unwrap();
        dir
    };
    let (a, b) = (keep("a"), keep("b"));
    ws.delete_agent("a").await.unwrap();
    assert!(!a.exists(), "its read-only files and folders are gone");
    assert_eq!(contents(&b).len(), 1, "another Agent's files stay");
    // An Agent that had none is deleted as before; a link in its place is left.
    ws.delete_agent("c").await.unwrap();
    symlink(&b, agent_dir(&ws.data_dir, "b-link").unwrap()).unwrap();
    assert!(remove_agent_dir(&ws.data_dir, "b-link").is_err());
    assert_eq!(contents(&b).len(), 1);
}
