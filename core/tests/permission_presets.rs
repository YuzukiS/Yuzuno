use serde_json::{json, Value};
use yuzuno_workspace::{
    model::AgentSettings,
    permissions::{self, Permissions},
};

fn settings(mode: &str) -> AgentSettings {
    AgentSettings {
        permission_preset: Some(mode.into()),
        ..Default::default()
    }
}

#[test]
fn explicit_modes_route_to_native_reviewers_and_keep_their_boundaries() {
    for (mode, reviewer, policy, sandbox) in [
        ("ask", "user", "on-request", "workspaceWrite"),
        ("auto", "auto_review", "on-request", "workspaceWrite"),
        ("full", "user", "never", "dangerFullAccess"),
    ] {
        let p = permissions::resolve(&settings(mode), &Value::Null, "/workspace").unwrap();
        let mut turn = json!({"threadId":"same-thread","input":[{"text":"Keep working"}]});
        p.apply(&mut turn, true);
        assert_eq!(turn["approvalsReviewer"], reviewer);
        assert_eq!(turn["approvalPolicy"], policy);
        assert_eq!(turn["sandboxPolicy"]["type"], sandbox);
        assert_eq!(turn["threadId"], "same-thread");
        if mode != "full" {
            assert_eq!(turn["sandboxPolicy"]["networkAccess"], false);
        }
    }
}

#[test]
fn legacy_agents_keep_their_permissions_and_config_is_explicitly_selected() {
    let old: AgentSettings = serde_json::from_value(
        json!({"reasoningEffort":"high","approvalPolicy":"never","sandbox":"read-only"}),
    )
    .unwrap();
    assert!(old.permission_preset.is_none());
    let p = permissions::resolve(
        &old,
        &json!({"approvals_reviewer":"auto_review"}),
        "/workspace",
    )
    .unwrap();
    assert_eq!(p.approvals_reviewer, "user");
    assert_eq!(p.approval_policy, "never");
    assert_eq!(p.sandbox, "read-only");
    assert!(permissions::resolve(&settings("config"), &Value::Null, "/workspace").is_err());
    assert!(permissions::resolve(&settings("invented"), &json!({}), "/workspace").is_err());
}

#[test]
fn follows_config_including_review_policy_network_roots_and_named_profiles() {
    let config = json!({"approvals_reviewer":"auto_review","approval_policy":"on-request","sandbox_mode":"workspace-write",
        "sandbox_workspace_write":{"network_access":true,"writable_roots":["/shared"],"exclude_slash_tmp":true}});
    let p = permissions::resolve(&settings("config"), &config, "/workspace").unwrap();
    assert_eq!(p.approvals_reviewer, "auto_review");
    assert_eq!(p.sandbox_policy["networkAccess"], true);
    assert_eq!(p.sandbox_policy["excludeSlashTmp"], true);
    assert_eq!(
        p.sandbox_policy["writableRoots"],
        json!(["/shared", "/workspace"])
    );
    let p = permissions::resolve(
        &settings("config"),
        &json!({"default_permissions":"team-profile"}),
        "/workspace",
    )
    .unwrap();
    let mut params =
        json!({"sandboxPolicy":{"type":"dangerFullAccess"},"sandbox":"danger-full-access"});
    p.apply(&mut params, true);
    assert_eq!(params["permissions"], "team-profile");
    assert!(params.get("sandboxPolicy").is_none() && params.get("sandbox").is_none());
}

#[test]
fn defaults_distinguish_project_trust_and_never_match_a_sibling_prefix() {
    let config = json!({"projects":{"/workspace":{"trust_level":"trusted"},"/workspace/restricted":{"trust_level":"untrusted"}}});
    for (cwd, expected) in [
        ("/workspace", "workspace-write"),
        ("/workspace/sub", "workspace-write"),
        ("/workspace/restricted", "read-only"),
        ("/workspace-other", "read-only"),
    ] {
        assert_eq!(
            permissions::resolve(&settings("config"), &config, cwd)
                .unwrap()
                .sandbox,
            expected
        );
    }
}

#[test]
fn managed_restrictions_disable_unavailable_presets() {
    let requirements =
        json!({"allowedApprovalPolicies":["on-request"],"allowedSandboxModes":["workspace-write"]});
    let auto = permissions::resolve(&settings("auto"), &Value::Null, "/w").unwrap();
    assert!(auto.check_requirements(&requirements).is_ok());
    let full = permissions::resolve(&settings("full"), &Value::Null, "/w").unwrap();
    assert!(full.check_requirements(&requirements).is_err());
    assert!(auto
        .check_requirements(&json!({"allowedPermissionProfiles":{":workspace":false}}))
        .is_err());
    assert!(auto
        .check_requirements(&json!({"allowedApprovalsReviewers":["user"]}))
        .is_err());
}

#[test]
fn permission_config_does_not_expose_other_configuration_or_credentials() {
    let filtered = permissions::config_from_response(&json!({"config":{
        "approvals_reviewer":"auto_review","model_providers":{"private":{"http_headers":{"Authorization":"fixture-secret"}}},
        "mcp_servers":{"private":{"env":{"TOKEN":"fixture-secret"}}}
    }})).unwrap();
    assert_eq!(filtered, json!({"approvals_reviewer":"auto_review"}));
}

#[tokio::test]
#[ignore = "requires installed Codex; uses temporary CODEX_HOME, no login or model turn"]
async fn defaults_match_installed_codex_in_a_trusted_workspace() {
    use std::os::unix::fs::PermissionsExt;
    use yuzuno_workspace::rpc::Rpc;
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("work");
    let codex_home = tmp.path().join("codex");
    std::fs::create_dir(&cwd).unwrap();
    std::fs::create_dir(&codex_home).unwrap();
    std::fs::write(
        codex_home.join("config.toml"),
        format!(
            "approvals_reviewer = \"auto_review\"\n[projects.{}]\ntrust_level = \"trusted\"\n",
            json!(cwd)
        ),
    )
    .unwrap();
    let launcher = tmp.path().join("native.py");
    std::fs::write(&launcher, format!("#!/usr/bin/python3\nimport os,sys\nos.environ['CODEX_HOME']={}\nos.execvp('codex',['codex']+sys.argv[1:])\n", json!(codex_home.to_string_lossy()))).unwrap();
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::channel(256);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let rpc = Rpc::spawn(launcher.to_str().unwrap(), &[], tx)
        .await
        .unwrap();
    rpc.initialize().await.unwrap();
    let response = rpc
        .request("config/read", json!({"cwd":cwd}))
        .await
        .unwrap();
    let config = permissions::config_from_response(&response).unwrap();
    let p: Permissions =
        permissions::resolve(&settings("config"), &config, cwd.to_str().unwrap()).unwrap();
    let native = rpc
        .request("thread/start", json!({"cwd":cwd,"ephemeral":true}))
        .await
        .unwrap();
    for mode in ["ask", "auto", "full", "config"] {
        let expected =
            permissions::resolve(&settings(mode), &config, cwd.to_str().unwrap()).unwrap();
        let mut params = json!({"cwd":cwd,"ephemeral":true});
        expected.apply(&mut params, false);
        let started = rpc.request("thread/start", params).await.unwrap();
        assert_eq!(
            started["approvalsReviewer"], expected.approvals_reviewer,
            "{mode}"
        );
        assert_eq!(
            started["approvalPolicy"], expected.approval_policy,
            "{mode}"
        );
        assert_eq!(
            started["sandbox"]["type"], expected.sandbox_policy["type"],
            "{mode}"
        );
    }
    let error = rpc.request("turn/steer", json!({"threadId":native["thread"]["id"],"expectedTurnId":"finished","input":[{"type":"text","text":"fixture"}]})).await.unwrap_err();
    rpc.close();
    let error = error
        .downcast_ref::<yuzuno_workspace::rpc::RpcError>()
        .unwrap();
    assert_eq!(error.code, -32600);
    assert_eq!(error.message, "no active turn to steer");
    assert_eq!(p.approvals_reviewer, native["approvalsReviewer"]);
    assert_eq!(p.approval_policy, native["approvalPolicy"]);
    assert_eq!(p.sandbox_policy["type"], native["sandbox"]["type"]);
}
