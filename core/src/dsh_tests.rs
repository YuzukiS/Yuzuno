use super::*;
#[cfg(unix)]
use std::future::Future;

fn version(text: &str) -> Version {
    Version::parse(text).unwrap_or_else(|| panic!("{text} is a version"))
}

fn error_of<T>(result: Result<T>) -> String {
    match result {
        Ok(_) => panic!("refused"),
        Err(error) => format!("{error:#}"),
    }
}

fn contains_all(text: &str, parts: &[&str]) {
    for part in parts {
        assert!(text.contains(part), "{part:?} in {text:?}");
    }
}

// ---------------------------------------------------------------- versions

/// semver 2.0.0 §11's own order, then dsh's tags (39 pre-releases so far).
#[test]
fn versions_rank_as_semver_2_including_their_pre_releases() {
    let semver = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    let dsh = ["0.1.0-rc.7", "0.2.2-alpha.3", "0.2.2-rc.1", "0.2.2-rc.3", "0.2.2-rc.10", "0.2.2", "0.2.3-rc.1", "0.10.0", "1.0.0"];
    for order in [&semver[..], &dsh[..]] {
        for pair in order.windows(2) {
            assert!(version(pair[0]) < version(pair[1]), "{} < {}", pair[0], pair[1]);
        }
    }
    assert_eq!(version("0.2.2-rc.3+build.7"), version("0.2.2-rc.3"), "build metadata does not count");
    assert_eq!(version("v0.2.2-rc.3"), version("0.2.2-rc.3"));
    assert_eq!(version(" 0.2.2-rc.3\n").to_string(), "0.2.2-rc.3", "shown as printed, trimmed");
}

#[test]
fn text_that_is_not_semver_is_no_version() {
    for text in ["", "dsh", "0.2", "0.2.2.1", "01.2.3", "0.02.3", "0.2.2-", "0.2.2-rc..1", "0.2.2-rc.01", "0.2.2+",
        "0.2.2-rc$1", "0.2.2 rc.3", "-1.0.0", "0.2.x"] {
        assert!(Version::parse(text).is_none(), "{text:?}");
    }
}

/// §5.1: older than MIN or unreadable is refused; LINE up to VERIFIED is
/// verified; newer in LINE, and a later line, start and say so.
#[test]
fn a_version_older_than_min_or_unreadable_is_refused_and_a_newer_one_noted() {
    for verified in [MIN, "0.2.2-rc.2", VERIFIED] {
        let (_, standing) = standing(verified).unwrap();
        assert_eq!(standing, Standing::Verified, "{verified}");
        assert_eq!(standing.note(), None);
    }
    for newer in ["0.2.2-rc.4", "0.2.2", "0.2.9"] {
        let (version, standing) = standing(newer).unwrap();
        assert_eq!((version.to_string().as_str(), standing), (newer, Standing::Newer));
        assert!(standing.note().unwrap().contains(VERIFIED));
    }
    for line in ["0.3.0-rc.1", "0.3.0", "1.0.0", "2.1.0"] {
        let (_, standing) = standing(line).unwrap();
        assert_eq!(standing, Standing::NewLine, "{line}");
        assert!(standing.note().unwrap().contains("not verified"));
    }
    for older in ["0.2.2-rc.0", "0.2.2-alpha.3", "0.2.1", "0.1.9"] {
        contains_all(&error_of(standing(older)), &[format!("older than {MIN}").as_str(), "npm i -g @deepseek-ai/dsh@latest"]);
    }
    for unreadable in ["", "dsh dev build"] {
        contains_all(&error_of(standing(unreadable)), &["not a version", "npm i -g @deepseek-ai/dsh@latest"]);
    }
    assert_eq!([Standing::Verified, Standing::Newer, Standing::NewLine].map(Standing::label), ["verified", "newer", "newLine"]);
}

// ---------------------------------------------------------------- the overlay

fn launch(directory: PathBuf, folder: PathBuf, access: Access, writable: Vec<PathBuf>) -> Launch {
    Launch {
        program: "dsh".into(),
        folder,
        directory,
        access,
        writable,
        instructions: "YUZUNO-NOTICE".into(),
        key: None,
        endpoint: None,
    }
}

/// The rows the lead reads (§3.2): no session log or plugin list to
/// DeepSeek, no telemetry, the model, the sandbox and the approval policy,
/// each a literal, in OVERLAY_ROWS' order.
#[test]
fn the_overlay_writes_each_row_as_a_literal() {
    let ask = launch("/work/agent".into(), "/data/dsh/a".into(), Access::Workspace, vec!["/work/repo/.git".into()]);
    let rows = ask.rows("/work/agent").unwrap();
    assert_eq!(rows.iter().map(|row| row.id).collect::<Vec<_>>(), OVERLAY_ROWS);
    assert_eq!(overlay_text(&rows), concat!(
        "# Yuzuno Core's overlay for this Agent (YN-119 \u{a7}3.2): rewritten at each start, then read back.\n",
        "- id: session-log-deepseek\n",
        "  config:\n",
        "    enabled: false\n",
        "- id: plugin-package-inventory-deepseek\n",
        "  config:\n",
        "    enabled: false\n",
        "- id: session-telemetry-otel\n",
        "  disabled: true\n",
        "- id: acp\n",
        "  config:\n",
        "    provider: deepseek-official\n",
        "    model: deepseek-flash\n",
        "- id: sandbox-policy\n",
        "  config:\n",
        "    mode: workspace-write\n",
        "    workspaceRoot: \"/work/agent\"\n",
        "    additionalWritableRoots:\n",
        "      - \"/work/repo/.git\"\n",
        "- id: approval\n",
        "  config:\n",
        "    policy: ask\n",
    ));
    let full = launch("/work/agent".into(), "/data/dsh/a".into(), Access::Full, vec![]);
    let text = overlay_text(&full.rows("/w/\"quoted\" \\ folder").unwrap());
    contains_all(&text, &[
        "    mode: danger-full-access\n    workspaceRoot: \"/w/\\\"quoted\\\" \\\\ folder\"\n    additionalWritableRoots: []\n",
        "- id: approval\n  config:\n    policy: never\n",
    ]);
    assert_eq!((Access::Workspace.mode(), Access::Workspace.policy()), ("workspace-write", "ask"));
    assert_eq!((Access::Full.mode(), Access::Full.policy()), ("danger-full-access", "never"));
}

#[test]
fn an_agents_dsh_folder_is_one_name_under_data() {
    assert_eq!(folder(Path::new("/data"), "agent-1").unwrap(), PathBuf::from("/data/dsh/agent-1"));
    for bad in ["", ".", "..", "a/b", "a\\b", "a\0b"] {
        assert!(folder(Path::new("/data"), bad).is_err(), "{bad:?}");
    }
}

#[cfg(unix)]
#[test]
fn a_start_writes_the_folder_privately_and_replaces_its_files_whole() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let work = root.join("work");
    std::fs::create_dir(&work).unwrap();
    let mut launch = launch(work.clone(), root.join("data/dsh/agent-1"), Access::Workspace, vec![]);
    launch.instructions = "first notice".into();
    let prepared = prepare(&launch).unwrap();
    assert_eq!(prepared.home, root.join("data/dsh/agent-1/home"));
    assert_eq!(prepared.overlay, root.join("data/dsh/agent-1/overlay.yml"));
    let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!([mode(&launch.folder), mode(&prepared.home)], [0o700, 0o700]);
    assert_eq!([mode(&prepared.overlay), mode(&prepared.home.join("AGENTS.md"))], [0o600, 0o600]);
    let expected = overlay_text(&launch.rows(work.to_str().unwrap()).unwrap());
    assert_eq!(std::fs::read_to_string(&prepared.overlay).unwrap(), expected);
    assert_eq!(std::fs::read_to_string(prepared.home.join("AGENTS.md")).unwrap(), "first notice");

    std::fs::write(&prepared.overlay, "stale").unwrap();
    launch.instructions = "second notice".into();
    launch.access = Access::Full;
    let again = prepare(&launch).unwrap();
    assert!(std::fs::read_to_string(&again.overlay).unwrap().contains("    mode: danger-full-access\n"));
    assert_eq!(std::fs::read_to_string(again.home.join("AGENTS.md")).unwrap(), "second notice");

    for directory in [PathBuf::from("relative/work"), root.join("missing")] {
        launch.directory = directory;
        assert!(prepare(&launch).is_err());
    }
}

// ---------------------------------------------------------------- read back

const OVERLAY: &str = "/data/dsh/agent-1/overlay.yml";

/// `--dump-config` as dsh 0.2.2-rc.3 printed it with Core's overlay (YN-124
/// capture, its rows cut down and its paths made synthetic), the approval
/// row also patched by a cordis.patch.yml in DSH_HOME, as dsh lists a home
/// patch before `--patch`.
const DUMP: &str = "\
# == @deepseek-ai/dsh-base
- id: tool-plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager/tools'
  disabled: true
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
# == @deepseek-ai/dsh-base, patched by /data/dsh/agent-1/overlay.yml
- id: session-log-deepseek
  name: '@deepseek-ai/dsh-session-log-deepseek'
  config:
    enabled: false
# == @deepseek-ai/dsh-base
- id: typert
  name: '@deepseek-ai/dsh-typert-registry'
# == @deepseek-ai/dsh-base, patched by /data/dsh/agent-1/overlay.yml
- id: plugin-package-inventory-deepseek
  name: '@deepseek-ai/dsh-plugin-package-inventory-deepseek'
  config:
    enabled: false
# == @deepseek-ai/dsh-base
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-flash
# == @deepseek-ai/dsh-base, patched by /data/dsh/agent-1/overlay.yml
- id: session-telemetry-otel
  name: '@deepseek-ai/dsh-session-telemetry-otel'
  config:
    mode: !!js process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'
    shutdownTimeoutMillis: 3000
    exporter:
      url: !!js >-
        process.env.DSH_TELEMETRY_OTLP_URL ??
        'https://dsh-otel-collector.deepseeksvc.com/v1/logs'
      compression: gzip
  disabled: true
# == @deepseek-ai/dsh-base, patched by /data/dsh/agent-1/overlay.yml
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: >-
      /work/a-folder-whose-name-is-long-enough-for-dsh-to-fold-it/agent
    additionalWritableRoots:
      - >-
        /work/a-folder-whose-name-is-long-enough-for-dsh-to-fold-it/.git
# == @deepseek-ai/dsh-base
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: !!js process.platform === 'win32'
  config:
    timeoutMs: 60000
# == @deepseek-ai/dsh-base, patched by /data/dsh/agent-1/home/cordis.patch.yml, /data/dsh/agent-1/overlay.yml
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: ask
# == @deepseek-ai/dsh-base
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      workspace-write:
        sandbox: workspace-write
        approval: ask
# == @deepseek-ai/dsh-acp-app, patched by /data/dsh/agent-1/overlay.yml
- id: acp
  name: '@deepseek-ai/dsh-acp'
  inject:
    - acpAppStartup
  config:
    provider: deepseek-official
    model: deepseek-flash
";

fn ask_rows() -> Vec<Row> {
    launch("/work/agent".into(), "/data/dsh/agent-1".into(), Access::Workspace, vec!["/work/.git".into()])
        .rows("/work/agent").unwrap()
}

#[test]
fn what_dsh_printed_reads_back_and_names_each_rows_package() {
    let names = check_dump(DUMP, OVERLAY, &ask_rows()).unwrap();
    assert_eq!(names["sandbox-policy"], "@deepseek-ai/dsh-sandbox-policy");
    assert_eq!(names["approval"], "@deepseek-ai/dsh-user-approval");
    assert_eq!(names["acp"], "@deepseek-ai/dsh-acp");
    assert_eq!(names.len(), OVERLAY_ROWS.len());
    // js-yaml prints a short path plain, an empty list inline.
    let short = DUMP.replace("workspaceRoot: >-\n      /work/a-folder-whose-name-is-long-enough-for-dsh-to-fold-it/agent", "workspaceRoot: /w")
        .replace("additionalWritableRoots:\n      - >-\n        /work/a-folder-whose-name-is-long-enough-for-dsh-to-fold-it/.git", "additionalWritableRoots: []");
    check_dump(&short, OVERLAY, &ask_rows()).unwrap();
    // The rows of a Full start: the same dump with its words.
    let full = launch("/w".into(), "/d".into(), Access::Full, vec![]).rows("/w").unwrap();
    let dump = DUMP.replace("mode: workspace-write\n    workspaceRoot", "mode: danger-full-access\n    workspaceRoot").replace("policy: ask", "policy: never");
    check_dump(&dump, OVERLAY, &full).unwrap();
}

/// What `check_dump` refuses: a row that is gone, or there twice; set last
/// by another patch, or by none; a word that reads back otherwise; no
/// `disabled: true`; a key that is not there; no package.
#[test]
fn read_back_refuses_a_row_that_is_not_as_core_wrote_it() {
    let cases: [(&str, &str, &str); 11] = [
        ("- id: approval\n", "- id: approval-v2\n", "has no row \u{201c}approval\u{201d}"),
        ("# == @deepseek-ai/dsh-base\n- id: permission", "- id: sandbox-policy\n  name: x\n# == @deepseek-ai/dsh-base\n- id: permission",
            "lists the row \u{201c}sandbox-policy\u{201d} 2 times"),
        ("/data/dsh/agent-1/home/cordis.patch.yml, /data/dsh/agent-1/overlay.yml", "/data/dsh/agent-1/overlay.yml, /home/someone/.dsh/cordis.patch.yml",
            "\u{201c}approval\u{201d} is not set last by Yuzuno's overlay"),
        ("/data/dsh/agent-1/home/cordis.patch.yml, /data/dsh/agent-1/overlay.yml", "/data/dsh/agent-1/overlay.yml.old",
            "\u{201c}approval\u{201d} is not set last"),
        ("# == @deepseek-ai/dsh-acp-app, patched by /data/dsh/agent-1/overlay.yml", "# == @deepseek-ai/dsh-acp-app",
            "\u{201c}acp\u{201d} is not set last"),
        ("    policy: ask", "    policy: never", "\u{201c}approval\u{201d} does not read back policy: ask"),
        ("    mode: workspace-write\n    workspaceRoot", "    mode: read-only\n    workspaceRoot", "does not read back mode: workspace-write"),
        ("      compression: gzip\n  disabled: true", "      compression: gzip\n  disabled: false",
            "\u{201c}session-telemetry-otel\u{201d} does not read back as disabled: true"),
        ("    workspaceRoot: >-\n      /work/a-folder-whose-name-is-long-enough-for-dsh-to-fold-it/agent\n", "",
            "\u{201c}sandbox-policy\u{201d} does not read back its workspaceRoot"),
        ("  name: '@deepseek-ai/dsh-user-approval'\n", "", "dsh names no package for the row \u{201c}approval\u{201d}"),
        // A key further in is another key's, not the row's.
        ("  config:\n    enabled: false\n# == @deepseek-ai/dsh-base\n- id: typert", "  config:\n    nested:\n      enabled: false\n# == @deepseek-ai/dsh-base\n- id: typert",
            "\u{201c}session-log-deepseek\u{201d} does not read back enabled: false"),
    ];
    for (from, to, expected) in cases {
        assert!(DUMP.contains(from), "{from:?}");
        contains_all(&error_of(check_dump(&DUMP.replacen(from, to, 1), OVERLAY, &ask_rows())), &[expected]);
    }
}

// ---------------------------------------------------------------- the schema

fn loader() -> Value {
    json!({"$ref": "#/$defs/loaderExpression"})
}

fn typed(kind: &str) -> Value {
    json!({"anyOf": [{"type": [kind, "null"]}, loader()]})
}

/// A property taking one of `values`, nested as dsh's schema nests it.
fn choice(values: &[&str]) -> Value {
    let values: Vec<Value> = values.iter().map(|value| json!({"const": value, "not": {"type": "null"}})).collect();
    json!({"x-cordis": {"branchSelection": "first-success"}, "anyOf": [{"anyOf": [{"anyOf": values}, {"type": "null"}]}, loader()]})
}

fn config(properties: Value) -> Value {
    json!({"default": {}, "anyOf": [{"type": ["object", "null"], "properties": properties}, loader()]})
}

fn branch(name: &str, reference: &str) -> Value {
    json!({"if": {"properties": {"name": {"const": name}}}, "then": {"properties": {"config": {"anyOf": [{"$ref": reference}]}}}})
}

/// `--dump-config-schema` in dsh 0.2.2-rc.3's shape (YN-124 capture), cut
/// down to the rows Core writes and one without a config schema.
fn schema_json() -> Value {
    json!({"$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": {
        "loaderExpression": {"type": "object", "properties": {"__jsExpr": {"type": "string"}}},
        "entryMetadata": {"type": "object", "properties": {"id": {}, "name": {}, "config": {}, "group": {}, "disabled": {}, "inject": {}}},
        "unknownConfig": {},
        "config2": config(json!({"enabled": typed("boolean"), "maxBytes": typed("integer")})),
        "config8": config(json!({"enabled": typed("boolean")})),
        "config22": config(json!({"mode": choice(&["FEEDBACK_ONLY", "DISABLED"]), "shutdownTimeoutMillis": typed("number")})),
        "config24": config(json!({"mode": choice(&["read-only", "workspace-write", "danger-full-access"]), "workspaceRoot": typed("string"),
            "additionalWritableRoots": {"default": [], "anyOf": [{"type": ["array", "null"], "items": {"type": "string"}}, loader()]}})),
        "config27": config(json!({"policy": choice(&["ask", "never"])})),
        "config70": config(json!({"provider": typed("string"), "model": typed("string"), "sessionListPageSize": typed("integer")})),
        "entry": {"allOf": [
            branch("@deepseek-ai/dsh-plugin-manager", "#/$defs/unknownConfig"),
            branch("@deepseek-ai/dsh-session-log-deepseek", "#/$defs/config2"),
            branch("@deepseek-ai/dsh-plugin-package-inventory-deepseek", "#/$defs/config8"),
            branch("@deepseek-ai/dsh-session-telemetry-otel", "#/$defs/config22"),
            branch("@deepseek-ai/dsh-sandbox-policy", "#/$defs/config24"),
            branch("@deepseek-ai/dsh-user-approval", "#/$defs/config27"),
            branch("@deepseek-ai/dsh-acp", "#/$defs/config70"),
        ]},
    }})
}

fn names() -> HashMap<&'static str, String> {
    check_dump(DUMP, OVERLAY, &ask_rows()).unwrap()
}

fn schema_check(schema: &Value, rows: &[Row]) -> Result<()> {
    check_schema(&read_schema(&serde_json::to_vec(schema).unwrap())?, rows, &names())
}

#[test]
fn each_key_and_word_core_writes_is_one_dshs_schema_takes() {
    schema_check(&schema_json(), &ask_rows()).unwrap();
    schema_check(&schema_json(), &launch("/w".into(), "/d".into(), Access::Full, vec![]).rows("/w").unwrap()).unwrap();
    let schema = read_schema(&serde_json::to_vec(&schema_json()).unwrap()).unwrap();
    assert_eq!(schema.packages["@deepseek-ai/dsh-plugin-manager"], None, "no config schema");
    let sandbox = schema.packages["@deepseek-ai/dsh-sandbox-policy"].as_ref().unwrap();
    assert_eq!(sandbox["mode"], ["read-only", "workspace-write", "danger-full-access"]);
    assert!(sandbox["workspaceRoot"].is_empty(), "any string");
}

#[test]
fn the_schema_check_refuses_what_dsh_would_take_without_a_word() {
    let mut cases: Vec<(Value, &str)> = Vec::new();
    let mut schema = schema_json();
    schema["$defs"]["config24"]["anyOf"][0]["properties"].as_object_mut().unwrap().remove("additionalWritableRoots");
    cases.push((schema, "dsh's schema for @deepseek-ai/dsh-sandbox-policy (row \u{201c}sandbox-policy\u{201d}) has no key additionalWritableRoots"));
    let mut schema = schema_json();
    schema["$defs"]["config24"]["anyOf"][0]["properties"]["mode"] = choice(&["read-only", "danger-full-access"]);
    cases.push((schema, "does not take mode: workspace-write (it takes read-only, danger-full-access)"));
    let mut schema = schema_json();
    schema["$defs"]["config27"]["anyOf"][0]["properties"]["policy"] = choice(&["never"]);
    cases.push((schema, "does not take policy: ask"));
    let mut schema = schema_json();
    schema["$defs"]["entry"]["allOf"].as_array_mut().unwrap().retain(|b| b["if"]["properties"]["name"]["const"] != "@deepseek-ai/dsh-user-approval");
    cases.push((schema, "dsh's schema has no entry for @deepseek-ai/dsh-user-approval (row \u{201c}approval\u{201d})"));
    let mut schema = schema_json();
    schema["$defs"]["entryMetadata"]["properties"].as_object_mut().unwrap().remove("disabled");
    cases.push((schema, "no longer takes disabled on a row (row \u{201c}session-telemetry-otel\u{201d})"));
    for (schema, expected) in cases {
        contains_all(&error_of(schema_check(&schema, &ask_rows())), &[expected]);
    }
    // A key Core does not write (probe ea68fd90: dsh starts all the same).
    let mut rows = ask_rows();
    rows[5].config.push(("polciy", Scalar::Word("ask")));
    contains_all(&error_of(schema_check(&schema_json(), &rows)), &["has no key polciy"]);
    for (bytes, expected) in [(&b"not json"[..], "not JSON"), (&b"{}"[..], "no $defs"), (&br#"{"$defs":{"entryMetadata":{"properties":{}}}}"#[..], "no $defs.entry.allOf")] {
        contains_all(&error_of(read_schema(bytes)), &[expected]);
    }
    let mut schema = schema_json();
    schema["$defs"].as_object_mut().unwrap().remove("config27");
    contains_all(&error_of(read_schema(&serde_json::to_vec(&schema).unwrap())), &["refers to #/$defs/config27, which it does not define"]);
}

/// A package without a config schema is left to the read-back (§3.3 step
/// 3); two branches of one package take the keys of both.
#[test]
fn a_package_without_a_config_schema_is_left_to_the_read_back() {
    let mut schema = schema_json();
    let branches = schema["$defs"]["entry"]["allOf"].as_array_mut().unwrap();
    for each in branches.iter_mut() {
        if each["if"]["properties"]["name"]["const"] == "@deepseek-ai/dsh-user-approval" {
            *each = branch("@deepseek-ai/dsh-user-approval", "#/$defs/unknownConfig");
        }
    }
    schema["$defs"]["config71"] = config(json!({"extra": typed("string")}));
    branches_push(&mut schema, branch("@deepseek-ai/dsh-acp", "#/$defs/config71"));
    let read = read_schema(&serde_json::to_vec(&schema).unwrap()).unwrap();
    assert_eq!(read.packages["@deepseek-ai/dsh-user-approval"], None);
    let acp = read.packages["@deepseek-ai/dsh-acp"].as_ref().unwrap();
    assert!(acp.contains_key("provider") && acp.contains_key("extra"));
    let mut rows = ask_rows();
    rows[5].config.push(("anything", Scalar::Word("goes")));
    check_schema(&read, &rows, &names()).unwrap();
}

fn branches_push(schema: &mut Value, branch: Value) {
    schema["$defs"]["entry"]["allOf"].as_array_mut().unwrap().push(branch);
}

// ---------------------------------------------------------------- answers

/// dsh 0.2.2-rc.3's answer to initialize (YN-124 capture).
fn initialized() -> Value {
    json!({"protocolVersion": 1, "agentInfo": {"name": "deepseek-harness-acp", "version": "0.0.1"},
        "agentCapabilities": {"mcpCapabilities": {"http": true}, "promptCapabilities": {"image": true, "audio": false, "embeddedContext": false},
            "sessionCapabilities": {"close": {}, "list": {}, "resume": {}}}, "authMethods": []})
}

#[test]
fn initialize_needs_acp_1_http_mcp_and_sessions_that_resume_and_close() {
    check_initialize(&initialized()).unwrap();
    let cases: [(&str, Value, &str); 5] = [
        ("/protocolVersion", json!(2), "dsh speaks ACP 2, not 1"),
        ("/agentCapabilities/mcpCapabilities/http", json!(false), "HTTP MCP servers"),
        ("/agentCapabilities/sessionCapabilities/resume", Value::Null, "dsh cannot resume a session"),
        ("/agentCapabilities/sessionCapabilities/close", Value::Null, "dsh cannot close a session"),
        ("/agentCapabilities", json!({}), "HTTP MCP servers"),
    ];
    for (pointer, value, expected) in cases {
        let mut answer = initialized();
        *answer.pointer_mut(pointer).unwrap() = value;
        contains_all(&error_of(check_initialize(&answer)), &[expected]);
    }
}

#[test]
fn a_session_needs_a_model_and_a_reasoning_effort_option() {
    let session = json!({"sessionId": "s", "configOptions": [{"id": "model", "currentValue": "[\"deepseek-official\",\"deepseek-flash\"]"},
        {"id": "reasoning_effort", "currentValue": "high"}]});
    check_session(&session).unwrap();
    let mut without = session.clone();
    without["configOptions"].as_array_mut().unwrap().pop();
    contains_all(&error_of(check_session(&without)), &["no reasoning_effort option"]);
    contains_all(&error_of(check_session(&json!({"sessionId": "s"}))), &["no configOptions"]);
}

#[test]
fn what_dsh_said_is_quoted_plain_on_one_line_and_clipped() {
    assert_eq!(said(b"\x1b[31merror\x1b[0m: bad\tthing\r\n\n  second\x07 line\n"), "error: bad thing / second line");
    let long = said("x".repeat(700).as_bytes());
    assert_eq!(long.chars().count(), REASON_CHARS + 1);
    assert!(long.ends_with('…'));
    assert_eq!(said(b""), "");
}

// ---------------------------------------------------------------- writable roots

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main"])
        .args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// §3.2: a linked worktree's sandbox may also write the Git common
/// directory, outside it; a main checkout's is inside it already.
#[tokio::test]
async fn a_linked_worktree_may_also_write_its_git_common_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let repo = root.join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "first"]);
    git(&repo, &["worktree", "add", "-q", "--detach", "../linked"]);
    assert_eq!(writable_roots(&root.join("linked")).await, [repo.join(".git")]);
    assert_eq!(writable_roots(&repo).await, Vec::<PathBuf>::new(), "inside the checkout already");
    std::fs::create_dir(repo.join("sub")).unwrap();
    assert_eq!(writable_roots(&repo.join("sub")).await, [repo.join(".git")], "outside a folder within it");
    let plain = root.join("plain");
    std::fs::create_dir(&plain).unwrap();
    // A temporary folder may itself be within a checkout (a Job's TMPDIR).
    let in_git = std::process::Command::new("git").args(["rev-parse", "--git-dir"]).current_dir(&plain)
        .stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success();
    if !in_git {
        assert_eq!(writable_roots(&plain).await, Vec::<PathBuf>::new(), "not in Git");
    }
    assert_eq!(writable_roots(&root.join("missing")).await, Vec::<PathBuf>::new());
}

// ---------------------------------------------------------------- the stand-in

#[cfg(unix)]
const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/dsh_acp.py");
#[cfg(unix)]
const KEY: &str = "sk-yuzuno-test-placeholder";
#[cfg(unix)]
const LIMIT: Duration = Duration::from_secs(30);

/// Variables of Core's own that dsh must not be given (§3.1), set once for
/// the test process under names nothing else reads.
#[cfg(unix)]
fn core_has_its_own_dsh_variables() {
    static SET: std::sync::Once = std::sync::Once::new();
    SET.call_once(|| {
        std::env::set_var("DSH_YUZUNO_TEST_OF_CORE", "1");
        std::env::set_var("DEEPSEEK_YUZUNO_TEST_OF_CORE", "1");
    });
}

#[cfg(unix)]
async fn within<T>(future: impl Future<Output = T>) -> T {
    timeout(Duration::from_secs(60), future).await.expect("within 60 s")
}

/// An Agent's dsh folder and its own stand-in `dsh`: each rig's program is
/// its own path, so no two share a schema read (`SCHEMAS`).
#[cfg(unix)]
struct Rig {
    _dir: tempfile::TempDir,
    launch: Launch,
}

#[cfg(unix)]
impl Rig {
    fn new(control: Value) -> Self {
        use std::os::unix::fs::PermissionsExt;
        core_has_its_own_dsh_variables();
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let program = root.join("dsh");
        std::fs::write(&program, format!("#!/bin/sh\nexec /usr/bin/python3 {FIXTURE} \"$@\"\n")).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let directory = root.join("work");
        std::fs::create_dir(&directory).unwrap();
        let folder = root.join("data/dsh/agent-1");
        std::fs::create_dir_all(folder.join("home")).unwrap();
        std::fs::write(folder.join("home/fixture.json"), control.to_string()).unwrap();
        let launch = Launch {
            program,
            folder,
            directory,
            access: Access::Workspace,
            writable: vec![],
            instructions: "YUZUNO-NOTICE".into(),
            key: Some(Secret::new(KEY.into())),
            endpoint: Some("http://127.0.0.1:9/v1".into()),
        };
        Self { _dir: dir, launch }
    }

    fn overlay(&self) -> String {
        self.launch.folder.join("overlay.yml").to_str().unwrap().to_owned()
    }

    fn log(&self) -> Vec<Value> {
        let text = std::fs::read_to_string(self.launch.folder.join("home/fixture-log.jsonl")).unwrap_or_default();
        text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    /// Each run of the stand-in: its arguments, and the rest it saw.
    fn runs(&self) -> Vec<Value> {
        self.log().into_iter().filter(|record| record["kind"] == "start").collect()
    }

    fn acp_runs(&self) -> usize {
        self.runs().iter().filter(|run| run["argv"].as_array().unwrap().len() == 4).count()
    }

    async fn start(&self) -> (Dsh, mpsc::Receiver<Value>) {
        let (tx, rx) = mpsc::channel(64);
        (within(Dsh::start(&self.launch, tx)).await.unwrap(), rx)
    }

    async fn refused(&self) -> String {
        let (tx, _events) = mpsc::channel(8);
        error_of(within(Dsh::start(&self.launch, tx)).await)
    }
}

/// The next event of `method`, those before it passed over.
#[cfg(unix)]
async fn event(events: &mut mpsc::Receiver<Value>, method: &str) -> Value {
    loop {
        let event = within(events.recv()).await.expect("dsh's events go on");
        if event["method"] == method {
            return event;
        }
    }
}

#[cfg(unix)]
fn prompt(session: &Value, text: &str) -> Value {
    json!({"sessionId": session["sessionId"], "prompt": [{"type": "text", "text": text}]})
}

#[cfg(unix)]
async fn session(dsh: &Dsh, directory: &Path) -> Value {
    let session = dsh.request("session/new", json!({"cwd": directory, "mcpServers": []}), LIMIT).await.unwrap();
    check_session(&session).unwrap();
    session
}

/// Whether a process is gone, or left only as a zombie for its parent.
#[cfg(unix)]
fn ended(pid: u64) -> bool {
    let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    stat.trim().is_empty() || stat.trim_start().starts_with('Z')
}

#[cfg(unix)]
async fn ends(pid: u64) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ended(pid) {
        assert!(Instant::now() < deadline, "process {pid} still runs");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// §3.1 and §3.3: a start runs `--version`, `--dump-config` with the
/// overlay and `--dump-config-schema`, then dsh itself; each in the Agent's
/// folder, with DSH_HOME, the preset and no telemetry, none of Core's own
/// DSH_*/DEEPSEEK_* variables, and the key only in DEEPSEEK_API_KEY of the
/// two that talk to DeepSeek, never in an argument.
#[cfg(unix)]
#[tokio::test]
async fn a_start_runs_each_check_and_gives_dsh_only_its_own_environment() {
    use sha2::Digest;
    let rig = Rig::new(json!({}));
    let (dsh, _events) = rig.start().await;
    assert_eq!((dsh.version().to_string().as_str(), dsh.standing()), (VERIFIED, Standing::Verified));
    assert_eq!(dsh.initialized()["protocolVersion"], 1);
    assert!(dsh.is_running() && dsh.pid().is_some());
    let overlay = rig.overlay();
    let runs = rig.runs();
    let argv: Vec<Value> = runs.iter().map(|run| run["argv"].clone()).collect();
    assert_eq!(argv, [json!(["--version"]), json!(["--profile", "acp", "--patch", overlay, "--dump-config"]),
        json!(["--profile", "acp", "--dump-config-schema"]), json!(["--profile", "acp", "--patch", overlay])]);
    let key = format!("{:x}", sha2::Sha256::digest(KEY.as_bytes()));
    for (run, with_key) in runs.iter().zip([false, true, false, true]) {
        assert_eq!(run["cwd"], rig.launch.directory.to_str().unwrap());
        assert_eq!(run["env"], json!({"DSH_HOME": rig.launch.folder.join("home"), "DSH_PERMISSION_MODE": "workspace-write",
            "DSH_TELEMETRY_DISABLED": "1", "DEEPSEEK_BASE_URL": "http://127.0.0.1:9/v1"}));
        let names: Vec<&str> = run["names"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
        assert!(!names.iter().any(|name| name.contains("YUZUNO_TEST_OF_CORE")), "{names:?}");
        assert_eq!(names.contains(&"DEEPSEEK_API_KEY"), with_key, "{:?}", run["argv"]);
        assert_eq!(run["keySha256"].as_str(), with_key.then_some(key.as_str()));
        assert!(!run["argv"].to_string().contains(KEY));
    }
    assert_eq!(std::fs::read_to_string(rig.launch.folder.join("home/AGENTS.md")).unwrap(), "YUZUNO-NOTICE");
    let (ending, status) = within(dsh.shutdown()).await.unwrap();
    assert_eq!(ending, Ending::Input);
    assert!(status.success(), "{status}");
    assert!(!dsh.is_running() && dsh.pid().is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn full_access_starts_dsh_with_its_preset() {
    let mut rig = Rig::new(json!({}));
    rig.launch.access = Access::Full;
    rig.launch.key = None;
    let (dsh, _events) = rig.start().await;
    for run in rig.runs() {
        assert_eq!(run["env"]["DSH_PERMISSION_MODE"], "danger-full-access");
        assert_eq!(run["keySha256"], Value::Null);
    }
    assert!(std::fs::read_to_string(rig.overlay()).unwrap().contains("    policy: never\n"));
    within(dsh.shutdown()).await.unwrap();
}

/// dsh's notifications and its own requests reach the events as it sent
/// them; Core's answer goes back under dsh's ID; dsh's errors keep their
/// code.
#[cfg(unix)]
#[tokio::test]
async fn dshs_messages_reach_the_events_and_answers_go_back() {
    let rig = Rig::new(json!({}));
    let (dsh, mut events) = rig.start().await;
    let session = session(&dsh, &rig.launch.directory).await;
    let answer = dsh.request("session/prompt", prompt(&session, "hello"), LIMIT).await.unwrap();
    assert_eq!(answer["stopReason"], "end_turn");
    let mut kinds = Vec::new();
    for _ in 0..3 {
        let update = event(&mut events, "session/update").await;
        assert_eq!(update["params"]["sessionId"], session["sessionId"]);
        kinds.push(update["params"]["update"]["sessionUpdate"].as_str().unwrap().to_owned());
    }
    assert_eq!(kinds, ["agent_thought_chunk", "agent_message_chunk", "usage_update"]);

    let call = dsh.call("session/prompt", prompt(&session, "ASK")).await.unwrap();
    let asked = event(&mut events, "session/request_permission").await;
    assert_eq!(asked["params"]["toolCall"]["toolCallId"], "call-1");
    let outcome = json!({"outcome": {"outcome": "selected", "optionId": "reject-once"}});
    dsh.respond(asked["id"].clone(), outcome.clone()).await.unwrap();
    assert_eq!(within(call.answer()).await.unwrap()["stopReason"], "end_turn");
    let quoted = loop {
        let update = event(&mut events, "session/update").await;
        if update["params"]["update"]["messageId"] == "m-ask" {
            break update;
        }
    };
    let text = quoted["params"]["update"]["content"]["text"].as_str().unwrap();
    assert_eq!(serde_json::from_str::<Value>(text).unwrap(), outcome);

    let error = dsh.request("session/load", json!({}), LIMIT).await.unwrap_err();
    let rpc = error.downcast_ref::<RpcError>().expect("dsh's own error");
    assert_eq!((rpc.code, rpc.data.as_ref().unwrap()["method"].as_str()), (-32601, Some("session/load")));
    within(dsh.shutdown()).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn a_cancel_notification_ends_a_prompt() {
    let rig = Rig::new(json!({}));
    let (dsh, _events) = rig.start().await;
    let session = session(&dsh, &rig.launch.directory).await;
    let call = dsh.call("session/prompt", prompt(&session, "SLEEP")).await.unwrap();
    dsh.notify("session/cancel", json!({"sessionId": session["sessionId"]})).await.unwrap();
    assert_eq!(within(call.answer()).await.unwrap()["stopReason"], "cancelled");
    let cancel: Vec<Value> = rig.log().into_iter().filter(|r| r["method"] == "session/cancel").collect();
    assert_eq!(cancel.len(), 1);
    assert_eq!(cancel[0]["id"], Value::Null, "a notification has no ID");
    within(dsh.shutdown()).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn a_request_unanswered_in_time_is_of_unknown_outcome_and_dsh_goes_on() {
    let rig = Rig::new(json!({}));
    let (dsh, _events) = rig.start().await;
    let error = dsh.request("fixture/hang", json!({}), Duration::from_millis(200)).await.unwrap_err();
    assert!(error.downcast_ref::<OutcomeUnknown>().is_some(), "{error:#}");
    contains_all(&format!("{error:#}"), &["dsh did not answer fixture/hang within 200ms"]);
    assert!(dsh.waiting.lock().unwrap().replies.is_empty());
    session(&dsh, &rig.launch.directory).await;
    within(dsh.shutdown()).await.unwrap();
}

/// When dsh ends, what waits fails as of unknown outcome, the events say
/// why, and nothing more is sent: no request can wait forever.
#[cfg(unix)]
#[tokio::test]
async fn when_dsh_ends_what_waits_is_unknown_and_the_events_say_why() {
    let rig = Rig::new(json!({}));
    let (dsh, mut events) = rig.start().await;
    let session = session(&dsh, &rig.launch.directory).await;
    let error = within(dsh.call("session/prompt", prompt(&session, "EXIT")).await.unwrap().answer()).await.unwrap_err();
    assert!(error.downcast_ref::<OutcomeUnknown>().is_some(), "{error:#}");
    contains_all(&format!("{error:#}"), &["dsh has ended; the outcome is not known"]);
    assert_eq!(event(&mut events, "yuzuno/disconnected").await["params"]["message"], "dsh has ended");
    within(dsh.stopped.clone().wait_for(|stopped| *stopped)).await.unwrap();
    assert!(!dsh.is_running());
    contains_all(&error_of(dsh.call("session/new", json!({})).await), &["dsh has ended; nothing more is sent to it"]);
    contains_all(&error_of(dsh.notify("session/cancel", json!({})).await), &["nothing more is sent to it"]);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !dsh.stderr_tail().contains("fixture: exiting") {
        assert!(Instant::now() < deadline, "stderr kept: {:?}", dsh.stderr_tail());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (ending, status) = within(dsh.shutdown()).await.unwrap();
    assert_eq!((ending, status.code()), (Ending::Input, Some(3)));
}

#[cfg(unix)]
#[tokio::test]
async fn output_that_is_not_acp_ends_the_connection() {
    let rig = Rig::new(json!({}));
    let (dsh, mut events) = rig.start().await;
    let session = session(&dsh, &rig.launch.directory).await;
    let error = within(dsh.call("session/prompt", prompt(&session, "NOISE")).await.unwrap().answer()).await.unwrap_err();
    assert!(error.downcast_ref::<OutcomeUnknown>().is_some());
    let said = event(&mut events, "yuzuno/disconnected").await["params"]["message"].as_str().unwrap().to_owned();
    assert!(said.starts_with("dsh wrote something that is not an ACP message"), "{said}");
    // dsh itself still runs, and still ends when its stdin closes.
    let (ending, status) = within(dsh.shutdown()).await.unwrap();
    assert_eq!(ending, Ending::Input);
    assert!(status.success());
}

/// §3.1: stdin closed, then SIGTERM to dsh's group, then SIGKILL; what dsh
/// started in its group ends with it.
#[cfg(unix)]
#[tokio::test]
async fn shutdown_signals_dshs_group_when_dsh_stays() {
    use std::os::unix::process::ExitStatusExt;
    let rig = Rig::new(json!({"ignoreStdin": true}));
    let (dsh, _events) = rig.start().await;
    let (ending, status) = within(dsh.shutdown_within(Duration::from_millis(300))).await.unwrap();
    assert_eq!((ending, status.signal()), (Ending::Term, Some(15)));

    let rig = Rig::new(json!({"ignoreStdin": true, "ignoreTerm": true, "child": true}));
    let (dsh, _events) = rig.start().await;
    let child = rig.log().iter().find(|r| r["kind"] == "child").expect("its child")["pid"].as_u64().unwrap();
    assert!(!ended(child));
    let (ending, status) = within(dsh.shutdown_within(Duration::from_millis(300))).await.unwrap();
    assert_eq!((ending, status.signal()), (Ending::Kill, Some(9)));
    ends(child).await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_dsh_dropped_ends_its_group() {
    let rig = Rig::new(json!({"ignoreStdin": true, "ignoreTerm": true, "child": true}));
    let (dsh, _events) = rig.start().await;
    let pid = u64::from(dsh.pid().unwrap());
    let child = rig.log().iter().find(|r| r["kind"] == "child").expect("its child")["pid"].as_u64().unwrap();
    drop(dsh);
    ends(pid).await;
    ends(child).await;
}

/// §3.3 and §5.1: each check that fails refuses the start, naming its step;
/// dsh itself starts only once steps 1–3 pass, and is ended when step 4
/// fails.
#[cfg(unix)]
#[tokio::test]
async fn each_check_of_a_start_refuses_it_naming_its_step() {
    let cases: Vec<(Value, Vec<&str>)> = vec![
        (json!({"version": "0.2.1"}), vec!["dsh start check 1 of 5 (its version)", "older than 0.2.2-rc.1", "npm i -g @deepseek-ai/dsh@latest"]),
        (json!({"version": "dsh dev build"}), vec!["check 1 of 5", "not a version"]),
        (json!({"versionExit": 2}), vec!["check 1 of 5", "`dsh --version` failed", "fixture: --version failed"]),
        (json!({"dropRow": ["approval"]}), vec!["dsh start check 2 of 5 (its configuration, read back)", "wrote on stderr",
            "patch: entry \"approval\" not found"]),
        (json!({"dumpStderr": "fixture: a warning"}), vec!["check 2 of 5", "fixture: a warning"]),
        (json!({"laterPatch": "/elsewhere/cordis.patch.yml"}), vec!["check 2 of 5", "is not set last by Yuzuno's overlay"]),
        (json!({"readBack": {"approval": {"policy": "never"}}}), vec!["check 2 of 5", "does not read back policy: ask"]),
        (json!({"readBack": {"session-log-deepseek": {"enabled": "true"}}}), vec!["check 2 of 5", "does not read back enabled: false"]),
        (json!({"schemaDrop": {"sandbox-policy": "additionalWritableRoots"}}), vec!["dsh start check 3 of 5 (its configuration schema)",
            "has no key additionalWritableRoots"]),
        (json!({"schemaModes": ["read-only", "danger-full-access"]}), vec!["check 3 of 5", "does not take mode: workspace-write"]),
        (json!({"schemaNoDisabled": true}), vec!["check 3 of 5", "no longer takes disabled"]),
        (json!({"initialize": {"protocolVersion": 2}}), vec!["dsh start check 4 of 5 (initialize)", "dsh speaks ACP 2, not 1"]),
        (json!({"initialize": {"agentCapabilities": {"sessionCapabilities": {"resume": null}}}}), vec!["check 4 of 5", "cannot resume"]),
        (json!({"initializeExit": true}), vec!["check 4 of 5", "dsh said: fixture: initialize failed"]),
    ];
    for (control, expected) in cases {
        let rig = Rig::new(control.clone());
        contains_all(&rig.refused().await, &expected);
        let step4 = expected.iter().any(|part| part.contains("check 4 of 5"));
        assert_eq!(rig.acp_runs(), usize::from(step4), "{control}");
        if step4 {
            let run = rig.runs().pop().unwrap();
            ends(run["pid"].as_u64().unwrap()).await;
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_newer_release_or_line_starts_and_says_so() {
    for (printed, expected) in [("0.2.3", Standing::Newer), ("0.3.0-rc.1", Standing::NewLine), ("1.0.0", Standing::NewLine)] {
        let rig = Rig::new(json!({"version": printed}));
        let (dsh, _events) = rig.start().await;
        assert_eq!((dsh.version().to_string().as_str(), dsh.standing()), (printed, expected));
        within(dsh.shutdown()).await.unwrap();
    }
}

/// §3.3 step 3: dsh's schema (630 KiB) is read once per program and version.
#[cfg(unix)]
#[tokio::test]
async fn dshs_schema_is_read_once_per_program_and_version() {
    let rig = Rig::new(json!({}));
    for _ in 0..2 {
        let (dsh, _events) = rig.start().await;
        within(dsh.shutdown()).await.unwrap();
    }
    let count = |what: &str| rig.runs().iter().filter(|run| run["argv"].as_array().unwrap().last().unwrap() == what).count();
    assert_eq!((count("--dump-config"), count("--dump-config-schema")), (2, 1));
}

#[cfg(unix)]
#[tokio::test]
async fn a_step_past_its_limit_is_ended_and_more_output_than_it_takes_refused() {
    let step = |script: &str| {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .kill_on_drop(true).process_group(0);
        command
    };
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let script = format!("echo $$ > '{}'; exec sleep 30", pid_file.display());
    let error = error_of(within(run(step(&script), Duration::from_millis(300), 1024, "a test")).await);
    assert_eq!(error, "dsh did not finish a test within 300ms");
    let pid: u64 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    ends(pid).await;
    let error = error_of(within(run(step("printf '%05000d' 0"), LIMIT, 1024, "a test")).await);
    assert_eq!(error, "dsh printed more than 1024 bytes for a test");
    let output = within(run(step("printf ok; printf oops >&2; exit 4"), LIMIT, 1024, "a test")).await.unwrap();
    assert_eq!((output.status.code(), &output.stdout[..], &output.stderr[..]), (Some(4), &b"ok"[..], &b"oops"[..]));
}

// ---------------------------------------------------------------- a real dsh
//
// Ignored: run by the YN-124 Job (`cargo test --lib dsh::tests::real_dsh --
// --ignored --test-threads=1`) with YUZUNO_DSH_BIN naming a dsh installed
// under W/.tmp only, a synthetic HOME, and stub_anthropic.py as its model:
// no real model and a placeholder key.

#[cfg(unix)]
const STUB: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/stub_anthropic.py");
#[cfg(unix)]
const MARKER: &str = "YUZUNO-AGENTS-MARKER";

#[cfg(unix)]
struct Model {
    child: std::process::Child,
    port: u16,
    log: PathBuf,
}

#[cfg(unix)]
impl Model {
    fn start(dir: &Path) -> Self {
        let (port_file, log) = (dir.join("model.port"), dir.join("model.jsonl"));
        let child = std::process::Command::new("/usr/bin/python3").arg(STUB).arg(&port_file).arg(&log).arg(MARKER)
            .stdin(Stdio::null()).spawn().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let port = loop {
            if let Ok(port) = std::fs::read_to_string(&port_file) {
                break port.trim().parse().unwrap();
            }
            assert!(std::time::Instant::now() < deadline, "the stand-in model listens");
            std::thread::sleep(Duration::from_millis(20));
        };
        Self { child, port, log }
    }

    fn requests(&self) -> Vec<Value> {
        let text = std::fs::read_to_string(&self.log).unwrap_or_default();
        text.lines().map(|line| serde_json::from_str::<Value>(line).unwrap()).filter(|r| r["kind"] == "post").collect()
    }
}

#[cfg(unix)]
impl Drop for Model {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A real dsh for an Agent working in a linked worktree, as executors do.
#[cfg(unix)]
async fn real_launch(dir: &Path, access: Access, model: &Model) -> Launch {
    let program = std::env::var_os("YUZUNO_DSH_BIN").map(PathBuf::from).expect("YUZUNO_DSH_BIN names a real dsh");
    let root = std::fs::canonicalize(dir).unwrap();
    let repo = root.join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "first"]);
    git(&repo, &["worktree", "add", "-q", "--detach", "../agent"]);
    let directory = root.join("agent");
    let writable = writable_roots(&directory).await;
    assert_eq!(writable, [repo.join(".git")]);
    Launch {
        program,
        folder: root.join("data/dsh/agent-1"),
        directory,
        access,
        writable,
        instructions: format!("{MARKER}: the session notice."),
        key: Some(Secret::new("sk-placeholder-not-a-key".into())),
        endpoint: Some(format!("http://127.0.0.1:{}/v1", model.port)),
    }
}

/// §3.3 against the real dsh, then a Turn with the stand-in model: no
/// session log or plugin list goes with any request (§3.2), and
/// $DSH_HOME/AGENTS.md reaches the model.
#[cfg(unix)]
#[tokio::test]
#[ignore = "needs a real dsh (YUZUNO_DSH_BIN)"]
async fn real_dsh_passes_each_check_and_sends_no_session_log() {
    let dir = tempfile::tempdir().unwrap();
    let model = Model::start(dir.path());
    let launch = real_launch(dir.path(), Access::Workspace, &model).await;
    let (tx, mut events) = mpsc::channel(256);
    let dsh = within(Dsh::start(&launch, tx)).await.unwrap();
    eprintln!("dsh {} ({:?})", dsh.version(), dsh.standing());
    let session = session(&dsh, &launch.directory).await;
    let answer = within(dsh.request("session/prompt", prompt(&session, "Say hello."), LIMIT)).await.unwrap();
    assert_eq!(answer["stopReason"], "end_turn");
    let reply = loop {
        let update = event(&mut events, "session/update").await;
        if update["params"]["update"]["sessionUpdate"] == "agent_message_chunk" {
            break update;
        }
    };
    assert!(reply.to_string().contains("stub-reply"), "{reply}");
    let requests = model.requests();
    assert!(!requests.is_empty());
    for request in &requests {
        assert_eq!((request["hasSessionLog"].as_bool(), request["hasPluginPackages"].as_bool()), (Some(false), Some(false)), "{request}");
        assert_eq!(request["apiKeyPresent"], true);
    }
    assert!(requests.iter().any(|request| request["marker"] == true), "AGENTS.md reached the model");
    let (ending, status) = within(dsh.shutdown()).await.unwrap();
    assert_eq!(ending, Ending::Input);
    assert!(status.success(), "{status}");
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "needs a real dsh (YUZUNO_DSH_BIN)"]
async fn real_dsh_passes_each_check_with_full_access() {
    let dir = tempfile::tempdir().unwrap();
    let model = Model::start(dir.path());
    let launch = real_launch(dir.path(), Access::Full, &model).await;
    // Its events are kept: a connection whose events nobody reads ends.
    let (tx, _events) = mpsc::channel(256);
    let dsh = within(Dsh::start(&launch, tx)).await.unwrap();
    session(&dsh, &launch.directory).await;
    within(dsh.shutdown()).await.unwrap();
}

/// What probe ea68fd90 found a real dsh takes without a word: a row that is
/// not there, a value it cannot use and a key it does not know. Each is
/// refused, at the step that finds it.
#[cfg(unix)]
#[tokio::test]
#[ignore = "needs a real dsh (YUZUNO_DSH_BIN)"]
async fn real_dsh_read_back_refuses_what_dsh_takes_without_a_word() {
    let dir = tempfile::tempdir().unwrap();
    let model = Model::start(dir.path());
    let launch = real_launch(dir.path(), Access::Workspace, &model).await;
    let prepared = prepare(&launch).unwrap();
    let overlay = prepared.overlay.to_str().unwrap().to_owned();
    let (version, _) = within(read_version(&launch, &prepared)).await.unwrap();
    let schema = within(schema(&launch, &prepared, &version)).await.unwrap();
    let names = check_dump(&within(read_dump(&launch, &prepared)).await.unwrap(), &overlay, &prepared.rows).unwrap();
    check_schema(&schema, &prepared.rows, &names).unwrap();

    let write = |rows: &[Row]| std::fs::write(&prepared.overlay, overlay_text(rows)).unwrap();
    let mut rows = launch.rows(launch.directory.to_str().unwrap()).unwrap();
    rows[5].id = "approval-renamed";
    write(&rows);
    contains_all(&error_of(within(read_dump(&launch, &prepared)).await), &["wrote on stderr", "approval-renamed", "not found"]);

    let mut rows = launch.rows(launch.directory.to_str().unwrap()).unwrap();
    rows[4].config[0] = ("mode", Scalar::Word("workspace-writ"));
    rows[5].config.push(("polciy", Scalar::Word("ask")));
    write(&rows);
    let dump = within(read_dump(&launch, &prepared)).await.unwrap();
    let names = check_dump(&dump, &overlay, &rows).unwrap();
    let refused = error_of(check_schema(&schema, &rows, &names));
    contains_all(&refused, &["does not take mode: workspace-writ"]);
    rows[4].config[0] = ("mode", Scalar::Word("workspace-write"));
    contains_all(&error_of(check_schema(&schema, &rows, &names)), &["has no key polciy"]);
}

/// §3.5: session/cancel ends a Turn whose command is still running.
#[cfg(unix)]
#[tokio::test]
#[ignore = "needs a real dsh (YUZUNO_DSH_BIN)"]
async fn real_dsh_cancel_ends_a_turn() {
    let dir = tempfile::tempdir().unwrap();
    let model = Model::start(dir.path());
    let launch = real_launch(dir.path(), Access::Workspace, &model).await;
    let (tx, mut events) = mpsc::channel(256);
    let dsh = within(Dsh::start(&launch, tx)).await.unwrap();
    let session = session(&dsh, &launch.directory).await;
    let call = dsh.call("session/prompt", prompt(&session, "YUZUNO-SLEEP")).await.unwrap();
    loop {
        let update = event(&mut events, "session/update").await;
        if update["params"]["update"]["sessionUpdate"] == "tool_call" {
            break;
        }
    }
    dsh.notify("session/cancel", json!({"sessionId": session["sessionId"]})).await.unwrap();
    let answer = timeout(Duration::from_secs(10), call.answer()).await.expect("cancelled within 10 s").unwrap();
    assert_eq!(answer["stopReason"], "cancelled");
    within(dsh.shutdown()).await.unwrap();
}
