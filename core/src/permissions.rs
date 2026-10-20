//! Codex presets change native approval routing; they never approve a pending request.
use crate::model::AgentSettings;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub approval_policy: Value,
    pub approvals_reviewer: String,
    pub sandbox: String,
    pub sandbox_policy: Value,
    pub profile: Option<String>,
}

pub fn resolve(settings: &AgentSettings, config: &Value, cwd: &str) -> Result<Permissions> {
    let preset = settings.permission_preset.as_deref();
    let follows_config = preset == Some("config");
    let (policy, reviewer, sandbox) = match preset {
        Some("ask") => (json!("on-request"), "user", "workspace-write"),
        Some("auto") => (json!("on-request"), "auto_review", "workspace-write"),
        Some("full") => (json!("never"), "user", "danger-full-access"),
        Some("config") => {
            anyhow::ensure!(
                config.is_object(),
                "Codex 配置尚未读取，不能使用跟随配置模式"
            );
            // Native config/read includes the trusted project layers. When no
            // sandbox is specified, Codex chooses the workspace profile only
            // for a trusted project, otherwise its read-only default.
            let trusted = config["projects"]
                .as_object()
                .and_then(|projects| {
                    projects
                        .iter()
                        .filter(|(path, _)| {
                            cwd == path.as_str()
                                || cwd
                                    .strip_prefix(path.trim_end_matches('/'))
                                    .is_some_and(|rest| rest.starts_with('/'))
                        })
                        .max_by_key(|(path, _)| path.len())
                })
                .is_some_and(|(_, project)| project["trust_level"] == "trusted");
            let sandbox = config["sandbox_mode"].as_str().unwrap_or(if trusted {
                "workspace-write"
            } else {
                "read-only"
            });
            let policy = if config["approval_policy"].is_null() {
                json!("on-request")
            } else {
                config["approval_policy"].clone()
            };
            (
                policy,
                config["approvals_reviewer"].as_str().unwrap_or("user"),
                sandbox,
            )
        }
        None => (
            json!(settings.approval_policy),
            "user",
            settings.sandbox.as_str(),
        ),
        Some(_) => bail!("未知的 Codex 权限模式"),
    };
    anyhow::ensure!(
        ["user", "auto_review", "guardian_subagent"].contains(&reviewer),
        "当前 Codex 审批方式尚不受支持：{reviewer}"
    );
    let profile = if follows_config && config["sandbox_mode"].is_null() {
        config["default_permissions"].as_str().map(str::to_owned)
    } else {
        None
    };
    let policy_fields = if follows_config {
        config["sandbox_workspace_write"].clone()
    } else {
        Value::Null
    };
    let sandbox_policy = match sandbox {
        "read-only" => json!({"type":"readOnly","networkAccess":false}),
        "danger-full-access" => json!({"type":"dangerFullAccess"}),
        "workspace-write" => {
            let mut roots = policy_fields["writable_roots"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if !roots.iter().any(|root| root == cwd) {
                roots.push(json!(cwd));
            }
            json!({"type":"workspaceWrite","writableRoots":roots,
                "networkAccess":policy_fields["network_access"].as_bool().unwrap_or(false),
                "excludeTmpdirEnvVar":policy_fields["exclude_tmpdir_env_var"].as_bool().unwrap_or(false),
                "excludeSlashTmp":policy_fields["exclude_slash_tmp"].as_bool().unwrap_or(false)})
        }
        _ => bail!("当前 Codex 沙箱模式尚不受支持：{sandbox}"),
    };
    Ok(Permissions {
        approval_policy: policy,
        approvals_reviewer: reviewer.into(),
        sandbox: sandbox.into(),
        sandbox_policy,
        profile,
    })
}

impl Permissions {
    pub fn apply(&self, params: &mut Value, turn: bool) {
        params["approvalPolicy"] = self.approval_policy.clone();
        params["approvalsReviewer"] = self.approvals_reviewer.clone().into();
        let fields = params.as_object_mut().unwrap();
        fields.remove("sandbox");
        fields.remove("sandboxPolicy");
        fields.remove("permissions");
        if let Some(profile) = &self.profile {
            params["permissions"] = profile.clone().into();
        } else if turn {
            params["sandboxPolicy"] = self.sandbox_policy.clone();
        } else {
            params["sandbox"] = self.sandbox.clone().into();
        }
    }

    pub fn check_requirements(&self, requirements: &Value) -> Result<()> {
        if let Some(allowed) = requirements["allowedApprovalsReviewers"].as_array() {
            anyhow::ensure!(
                allowed.iter().any(|v| v == &self.approvals_reviewer),
                "执行机器的管理策略不允许此审批方式"
            );
        }
        if let Some(allowed) = requirements["allowedApprovalPolicies"].as_array() {
            anyhow::ensure!(
                allowed.contains(&self.approval_policy),
                "执行机器的管理策略不允许此审批模式"
            );
        }
        if let Some(allowed) = requirements["allowedSandboxModes"].as_array() {
            anyhow::ensure!(
                self.profile.is_some() || allowed.iter().any(|v| v == &self.sandbox),
                "执行机器的管理策略不允许此访问级别"
            );
        }
        if let Some(allowed) = requirements["allowedPermissionProfiles"].as_object() {
            let profile = self
                .profile
                .as_deref()
                .unwrap_or(match self.sandbox.as_str() {
                    "workspace-write" => ":workspace",
                    "danger-full-access" => ":danger-full-access",
                    _ => ":read-only",
                });
            anyhow::ensure!(
                allowed.get(profile).and_then(Value::as_bool) == Some(true),
                "执行机器的管理策略不允许此权限配置"
            );
        }
        Ok(())
    }
}

/// Only permission-related values leave the runtime. Never return config secrets.
pub fn config_from_response(response: &Value) -> Result<Value> {
    let config = response["config"]
        .as_object()
        .context("Codex 返回了无效的权限配置")?;
    let mut selected = serde_json::Map::new();
    for key in [
        "approval_policy",
        "approvals_reviewer",
        "sandbox_mode",
        "sandbox_workspace_write",
        "default_permissions",
        "projects",
    ] {
        if let Some(value) = config.get(key) {
            selected.insert(key.into(), value.clone());
        }
    }
    Ok(selected.into())
}
