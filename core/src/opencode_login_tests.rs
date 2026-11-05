use super::*;

fn holds(path: &std::path::Path, text: &[u8]) -> bool {
    std::fs::read(path).is_ok_and(|bytes| bytes.windows(text.len()).any(|w| w == text))
}

/// An integration as the login section shows it (T-32 slice 4b): its
/// methods as Yuzuno offers them, a form of text and choice fields shown
/// (D8), any other method signed in from OpenCode itself, and its
/// connections, from named fields only: its metadata is never passed on.
#[test]
fn an_integration_is_read_from_named_fields_only_and_a_form_of_other_kinds_is_signed_in_elsewhere() {
    let copilot = json!([
        {"type": "string", "key": "deploymentType", "title": "Select GitHub deployment type", "required": true,
            "options": [{"label": "GitHub.com", "value": "github.com", "description": "Public"},
                {"label": "GitHub Enterprise", "value": "enterprise"}]},
        {"type": "string", "key": "enterpriseUrl", "title": "Enter your GitHub Enterprise URL", "placeholder": "company.ghe.com",
            "required": true, "when": [{"key": "deploymentType", "op": "eq", "value": "enterprise"}]},
        {"type": "string", "key": "region", "hidden": true, "default": "us"},
    ]);
    let listed = json!({"id": "github-copilot", "name": "GitHub Copilot", "metadata": {"token": "fixture-meta-secret"},
        "methods": [
            {"type": "oauth", "id": "github-copilot/device", "label": "Login with GitHub Copilot", "form": copilot},
            {"type": "key", "label": "Manually enter API Key"},
            {"type": "oauth", "id": "x/flag", "label": "Flagged", "form": [{"type": "boolean", "key": "k"}]},
            {"type": "command", "id": "x/cli", "label": "With its CLI", "command": ["x", "login"]},
            {"type": "env", "names": ["GITHUB_TOKEN"]},
            {"type": "external", "id": "x/external", "label": "Elsewhere"},
        ],
        "connections": [
            {"type": "credential", "id": "crd_1", "label": "work", "method": "oauth", "status": {"status": "needs_auth", "message": "expired"}},
            {"type": "env", "name": "GITHUB_TOKEN"},
        ]});
    let read = integration(&listed).unwrap();
    let kinds: Vec<&str> = read.methods.iter().map(|m| m.kind).collect();
    assert_eq!(kinds, ["oauth", "key", "elsewhere", "elsewhere", "env", "elsewhere"], "text and choice forms offered, others elsewhere");
    let form = &read.methods[0].fields;
    assert_eq!(form.iter().map(|f| f.key.as_str()).collect::<Vec<_>>(), ["deploymentType", "enterpriseUrl"], "a hidden field keeps its default");
    assert_eq!((form[0].options.len(), &form[1].when), (2, &vec![json!({"key": "deploymentType", "op": "eq", "value": "enterprise"})]));
    assert_eq!(read.methods[4].names, ["GITHUB_TOKEN"]);
    assert_eq!(read.connections, vec![
        Connection { kind: "credential", id: Some("crd_1".into()), label: "work".into(), method: Some("oauth".into()), needs_auth: Some("expired".into()) },
        Connection { kind: "env", id: None, label: "GITHUB_TOKEN".into(), method: None, needs_auth: None },
    ]);
    assert!(!serde_json::to_string(&read).unwrap().contains("fixture-meta-secret"), "its metadata is never passed on");
}

/// A sign-in whose page sends the browser back to this computer is told
/// from a device or code one by its link (D7): the link's host or its
/// `redirect_uri`'s is a loopback address.
#[test]
fn a_sign_in_that_sends_the_browser_back_here_is_told_from_a_device_one() {
    for link in ["https://auth.example.com/authorize?client_id=a&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
        "https://auth.example.com/authorize?redirect_uri=http://127.0.0.1:8080/cb", "https://auth.example.com/a?redirect_uri=http://[::1]:9/cb",
        "http://localhost:1455/start", "http://127.0.0.2/x", "https://auth.example.com/a?redirect_uri=http://app.localhost/cb"] {
        assert!(loopback(link), "sends the browser back here: {link}");
    }
    for link in ["https://github.com/login/device", "https://auth.example.com/authorize?redirect_uri=https://app.example.com/cb",
        "https://auth.example.com/device?user_code=ABCD", "not a link"] {
        assert!(!loopback(link), "a device or code sign-in: {link}");
    }
}

/// Logging in needs 2.0.20 or newer (D4), ranked as versions are; the note
/// for an older one names both.
#[test]
fn the_login_floor_is_2_0_20_and_its_note_names_both_versions() {
    for (version, taken) in [("2.0.16", false), ("2.0.19", false), ("2.0.20-rc1", false), ("2.0.20", true), ("2.0.20+build", true),
        ("2.2.5", true), ("2.1", false)] {
        assert_eq!(crate::opencode::login_supported(version), taken, "{version}");
    }
    assert_eq!(crate::opencode::login_update_note("2.0.16"),
        "update OpenCode to log in here: this Agent runs 2.0.16; logging in needs 2.0.20 or newer");
}

/// The scrub before an Agent's database is kept or moved (D6): no
/// credential's bytes are left in the file, its WAL or index, and its other
/// rows are kept. A database with no `credential` table, or none at all,
/// holds none; a WAL left without its database, and a file that is not a
/// database, are refused.
#[test]
fn a_scrub_leaves_no_credential_bytes_and_keeps_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("opencode.db");
    {
        let made = rusqlite::Connection::open(&db).unwrap();
        made.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE session (id TEXT); INSERT INTO session VALUES ('ses_kept');
            CREATE TABLE credential (id TEXT, value TEXT);
            INSERT INTO credential VALUES ('crd_1', '{\"type\":\"api\",\"key\":\"fixture-scrubbed-key-1\"}');
            INSERT INTO credential VALUES ('crd_2', '{\"type\":\"oauth\",\"access\":\"fixture-scrubbed-key-2\"}');").unwrap();
    }
    assert!(holds(&db, b"fixture-scrubbed-key-1"), "the fixture holds a credential");
    scrub(&db).unwrap();
    for name in ["opencode.db", "opencode.db-wal", "opencode.db-shm"] {
        for key in [&b"fixture-scrubbed-key-1"[..], b"fixture-scrubbed-key-2"] {
            assert!(!holds(&dir.path().join(name), key), "no credential's bytes left in {name}");
        }
    }
    let kept = rusqlite::Connection::open(&db).unwrap();
    assert_eq!(kept.query_row("SELECT id FROM session", [], |r| r.get::<_, String>(0)).unwrap(), "ses_kept", "its other rows kept");
    assert_eq!(kept.query_row("SELECT count(*) FROM credential", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    drop(kept);

    let plain = dir.path().join("plain.db");
    rusqlite::Connection::open(&plain).unwrap().execute_batch("CREATE TABLE session (id TEXT);").unwrap();
    scrub(&plain).expect("no credential table: nothing to remove");
    scrub(&dir.path().join("none.db")).expect("no database: nothing to remove");
    std::fs::write(dir.path().join("orphan.db-wal"), b"pages of fixture-scrubbed-key-3").unwrap();
    assert!(scrub(&dir.path().join("orphan.db")).is_err(), "a WAL without its database is refused");
    let text = dir.path().join("text.db");
    std::fs::write(&text, b"not a database").unwrap();
    assert!(scrub(&text).is_err(), "a file that is not a database is refused");
}

/// No Workspace tool an Agent can call reaches a login (the user's decision
/// 4142): logging an Agent in is the user's, from Core's own page.
#[test]
fn no_workspace_tool_reaches_a_login() {
    let tools = crate::collaboration_store::tool_definitions();
    assert!(tools.len() > 10, "the Workspace's tools are listed");
    for tool in tools {
        let name = tool["name"].as_str().unwrap().to_lowercase();
        assert!(["login", "logout", "credential", "integration", "opencode"].iter().all(|word| !name.contains(word)),
            "no Workspace tool reaches a login: {name}");
    }
}
