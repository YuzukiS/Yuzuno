//! T-29: the commands a Claude Agent's composer offers are the ones Claude
//! Code lists (`supportedCommands()`), from the Agent's running session, or
//! from a catalogue-only start in its folder when none runs. Core keeps them
//! to a small closed shape. Reading sends no prompt, and a folder start is
//! reused for a minute. Core runs the real bridge over a scripted SDK
//! (tests/fixtures/claude_commands_bridge.mjs).
use serde_json::{json, Value};
use std::time::Duration;
use yuzuno_workspace::workspace::Workspace;

fn lines(dir: &std::path::Path, name: &str) -> Vec<String> {
    std::fs::read_to_string(dir.join(name))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

#[tokio::test]
async fn commands_come_from_the_session_or_its_folder_and_never_send_a_prompt() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let path = dir.path();
    std::env::set_var(
        "YUZUNO_CLAUDE_BRIDGE",
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/claude_commands_bridge.mjs"
        ),
    );
    std::fs::write(path.join("commands.json"), serde_json::to_vec(&json!([
        {"name":"compact","description":"Clear history\nkeep a summary","argumentHint":"<instructions>","builtin":true,"aliases":["c"]},
        {"name":"yuzuno","description":"Work in a Yuzuno Workspace","argumentHint":""},
        {"name":"bad name","description":"two words","argumentHint":""},
        {"name":"/slashed","description":"leading slash","argumentHint":""},
        {"name":"https://evil.test","description":"a URL","argumentHint":""},
    ])).unwrap()).unwrap();
    let ws = Workspace::new(
        path.join("data"),
        path.to_string_lossy().into(),
        "unused".into(),
    )
    .unwrap();
    let agent = ws
        .claude_create(
            "C".into(),
            String::new(),
            path.to_string_lossy().into(),
            "m".into(),
            None,
        )
        .await
        .unwrap();
    let id = agent.id.clone();
    for _ in 0..400 {
        if ws.store.agent(&id).unwrap().connection_state == "connected" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(ws.store.agent(&id).unwrap().connection_state, "connected");

    let view: Value = serde_json::to_value(ws.claude_commands(&id).await.unwrap()).unwrap();
    assert_eq!(
        (view["state"].as_str(), view["source"].as_str()),
        (Some("ready"), Some("session"))
    );
    assert_eq!(
        view["commands"],
        json!([
            {"name":"compact","description":"Clear history keep a summary","argumentHint":"<instructions>","aliases":["c"],"source":"builtin"},
            {"name":"yuzuno","description":"Work in a Yuzuno Workspace","argumentHint":"","aliases":[],"source":"custom"},
        ])
    );
    // Before a turn's init, a Skill cannot be told from another custom command.
    assert_eq!(view["skillsKnown"], false);
    // The session named itself on an early hook event Core does not keep as
    // the Agent's session: still this Agent's list.
    assert_eq!(view["sessionId"], "e0e0e0e0-0000-4000-8000-000000000029");
    assert_eq!(ws.store.agent(&id).unwrap().claude_session_id, None);
    assert_eq!(lines(path, "reads"), ["session"]);
    assert_eq!(lines(path, "starts"), ["session"], "reading starts nothing");

    // The session ends (as after Core restarts, until the Agent is used):
    // its folder's list comes from a catalogue-only start, reused after.
    std::fs::write(path.join("end-session"), "").unwrap();
    for _ in 0..400 {
        if ws.store.agent(&id).unwrap().connection_state != "connected" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_ne!(ws.store.agent(&id).unwrap().connection_state, "connected");
    let folder: Value = serde_json::to_value(ws.claude_commands(&id).await.unwrap()).unwrap();
    assert_eq!(
        (folder["state"].as_str(), folder["source"].as_str()),
        (Some("ready"), Some("folder"))
    );
    assert_eq!(folder["commands"], view["commands"]);
    assert_eq!(folder["sessionId"], Value::Null);
    let again: Value = serde_json::to_value(ws.claude_commands(&id).await.unwrap()).unwrap();
    assert_eq!(again["commands"], view["commands"]);
    assert_eq!(
        lines(path, "starts"),
        ["session", "folder"],
        "one folder start, reused"
    );
    assert_eq!(lines(path, "reads"), ["session", "folder"]);

    // A closed Agent lists nothing.
    ws.close_agent(&id).await.unwrap();
    let closed: Value = serde_json::to_value(ws.claude_commands(&id).await.unwrap()).unwrap();
    assert_eq!(
        (closed["state"].as_str(), closed["reason"].as_str()),
        (Some("unavailable"), Some("closed"))
    );
    assert!(lines(path, "prompts").is_empty(), "no prompt was ever sent");
}
