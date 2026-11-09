//! Permission levels (YN-56): a permission said once for every harness, which
//! Core maps to each harness's own setting (docs/executor-routing.md,
//! "Permission levels"). An executor that follows routing runs on whichever
//! harness routing chooses, so its permission can't be one harness's own
//! value; a level is, and routing passes over a candidate whose harness
//! doesn't keep it (`levelNotKept`, routing_policy::evaluate).
//!
//! - `ask`: what isn't already allowed asks the user. Codex's `ask` preset
//!   (its workspace-write sandbox; leaving it asks the user), Claude Code's
//!   `default` mode.
//! - `auto`: an automatic reviewer decides instead of the user. Codex's `auto`
//!   preset (the same sandbox; `auto_review` decides leaving it), Claude
//!   Code's `auto` mode (its classifier).
//! - `full`: nothing asks. Codex's `full` preset. Claude Code doesn't keep it:
//!   Yuzuno never starts it in a mode that skips its checks
//!   (`claude::SELECTABLE_PERMISSION_MODES`).
//!
//! No level is each harness's own default for new Agents, as before. OpenCode
//! keeps no level: Core adds no permission rule of its own to it
//! (opencode_agent.rs), so only its own configuration applies there.
use anyhow::{ensure, Result};
use serde_json::{json, Value};

/// Each level, with what it is on Codex (its permission preset) and on Claude
/// Code (its permission mode); None where that harness doesn't keep it.
static LEVELS: [Level; 3] = [
    Level { id: "ask", label: "Ask you first", label_zh: "先问你", codex: Some("ask"), claude: Some("default") },
    Level { id: "auto", label: "Auto-approve", label_zh: "自动审批", codex: Some("auto"), claude: Some("auto") },
    Level { id: "full", label: "Full access", label_zh: "完全放开", codex: Some("full"), claude: None },
];

struct Level {
    id: &'static str,
    label: &'static str,
    label_zh: &'static str,
    codex: Option<&'static str>,
    claude: Option<&'static str>,
}

fn level(id: &str) -> Option<&'static Level> {
    LEVELS.iter().find(|l| l.id == id)
}

pub(crate) fn harness_name(harness: &str) -> &str {
    match harness {
        "codex" => "Codex",
        "claude" => "Claude Code",
        "opencode" => "OpenCode",
        other => other,
    }
}

/// Refuses what is not a level.
pub(crate) fn check(id: &str) -> Result<()> {
    ensure!(level(id).is_some(), "A permission level is ask, auto or full, not {id}");
    Ok(())
}

/// What `id` is on `harness`: a Codex permission preset (`agent_defaults::CODEX_PRESETS`)
/// or a Claude Code permission mode (`agent_defaults::CLAUDE_MODES`); None when that
/// harness doesn't keep it, or `id` is no level.
pub(crate) fn native(id: &str, harness: &str) -> Option<&'static str> {
    let level = level(id)?;
    match harness {
        "codex" => level.codex,
        "claude" => level.claude,
        _ => None,
    }
}

/// Whether `harness` keeps `id`. No level is kept everywhere: each harness's own default.
pub(crate) fn keeps(id: Option<&str>, harness: &str) -> bool {
    id.is_none_or(|id| native(id, harness).is_some())
}

/// The level a harness's own permission is: a Codex preset or a Claude Code
/// mode, as a template before YN-56 named it. None for one no level is, such
/// as Codex's `config`, which follows the machine's own Codex configuration.
pub(crate) fn of_native(harness: &str, preset: Option<&str>, mode: Option<&str>) -> Option<&'static str> {
    let found = match harness {
        "codex" => LEVELS.iter().find(|l| preset.is_some() && l.codex == preset),
        "claude" => LEVELS.iter().find(|l| mode.is_some() && l.claude == mode),
        _ => None,
    };
    found.map(|l| l.id)
}

/// `id`'s name, in English and Chinese, as the Settings page shows it.
pub(crate) fn label(id: &str) -> (&str, &str) {
    level(id).map_or((id, id), |l| (l.label, l.label_zh))
}

/// Each level and what it is on each harness, null where that harness doesn't keep it.
pub(crate) fn table() -> Value {
    LEVELS.iter().map(|l| json!({
        "level": l.id, "label": l.label, "labelZh": l.label_zh,
        "codex": l.codex.map(|p| json!({"permissionPreset": p})),
        "claude": l.claude.map(|m| json!({"permissionMode": m})),
        "opencode": null,
    })).collect()
}

/// Why routing passes over a candidate of `harness` for an executor of level `id`.
pub(crate) fn not_kept(id: &str, harness: &str) -> Value {
    let (label, label_zh) = label(id);
    let name = harness_name(harness);
    json!({"code": "levelNotKept",
        "message": format!("Its permission level is {label}, which {name} doesn't keep"),
        "messageZh": format!("它的权限等级是「{label_zh}」，{name} 不支持这个等级"),
        "params": {"level": id, "harness": harness}})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_defaults::{CLAUDE_MODES, CODEX_PRESETS};

    #[test]
    fn each_level_is_a_preset_codex_offers_and_a_mode_claude_code_starts_in_except_full() {
        assert_eq!(["ask", "auto", "full"].map(|id| native(id, "codex")), [Some("ask"), Some("auto"), Some("full")]);
        assert_eq!(["ask", "auto", "full"].map(|id| native(id, "claude")), [Some("default"), Some("auto"), None], "Claude Code never skips its checks");
        for id in ["ask", "auto", "full"] {
            check(id).unwrap();
            assert!(native(id, "codex").is_some_and(|preset| CODEX_PRESETS.contains(&preset)), "{id}");
            assert!(native(id, "claude").is_none_or(|mode| CLAUDE_MODES.contains(&mode)), "{id}");
            assert_eq!(native(id, "opencode"), None);
        }
        assert_eq!(native("readonly", "codex"), None);
    }

    #[test]
    fn no_level_is_kept_everywhere_and_opencode_or_an_unknown_harness_keeps_none_of_them() {
        for harness in ["codex", "claude", "opencode", "later"] {
            assert!(keeps(None, harness), "{harness}");
        }
        assert!(["ask", "auto", "full"].into_iter().all(|id| keeps(Some(id), "codex")));
        assert!(keeps(Some("ask"), "claude") && keeps(Some("auto"), "claude") && !keeps(Some("full"), "claude"));
        for harness in ["opencode", "later"] {
            assert!(["ask", "auto", "full"].into_iter().all(|id| !keeps(Some(id), harness)), "{harness}");
        }
        assert!(!keeps(Some("readonly"), "codex"), "not a level");
        assert!(check("readonly").unwrap_err().to_string().contains("ask, auto or full"));
        assert!(check("").is_err() && check("Ask").is_err());
    }

    #[test]
    fn a_native_permission_reads_back_as_its_level_and_one_no_level_is_reads_as_none() {
        for id in ["ask", "auto", "full"] {
            assert_eq!(native(id, "codex").and_then(|p| of_native("codex", Some(p), None)), Some(id));
            if let Some(mode) = native(id, "claude") {
                assert_eq!(of_native("claude", None, Some(mode)), Some(id));
            }
        }
        assert_eq!(of_native("codex", Some("config"), None), None, "the machine's own Codex configuration");
        assert_eq!(of_native("codex", None, None), None);
        assert_eq!(of_native("codex", None, Some("default")), None, "a Claude mode is not a Codex permission");
        assert_eq!(of_native("claude", Some("ask"), None), None, "a Codex preset is not a Claude permission");
        for legacy in ["acceptEdits", "plan", "bypassPermissions", "dontAsk"] {
            assert_eq!(of_native("claude", None, Some(legacy)), None, "{legacy}");
        }
        assert_eq!(of_native("opencode", Some("ask"), Some("default")), None);
    }

    #[test]
    fn the_table_lists_each_level_in_order_with_null_where_a_harness_does_not_keep_it() {
        let table = table();
        let ids: Vec<&str> = table.as_array().unwrap().iter().map(|l| l["level"].as_str().unwrap()).collect();
        assert_eq!(ids, ["ask", "auto", "full"]);
        assert_eq!(table[0]["codex"], json!({"permissionPreset": "ask"}));
        assert_eq!(table[0]["claude"], json!({"permissionMode": "default"}));
        assert_eq!((table[2]["claude"].clone(), table[2]["labelZh"].clone()), (Value::Null, json!("完全放开")));
        assert!(table.as_array().unwrap().iter().all(|l| l["opencode"].is_null()));
        assert_eq!(label("auto"), ("Auto-approve", "自动审批"));
    }

    #[test]
    fn levels_not_kept_say_which_level_and_harness_in_both_languages() {
        let why = not_kept("full", "claude");
        assert_eq!(why["code"], "levelNotKept");
        assert_eq!(why["params"], json!({"level": "full", "harness": "claude"}));
        assert_eq!(why["message"], "Its permission level is Full access, which Claude Code doesn't keep");
        assert_eq!(why["messageZh"], "它的权限等级是「完全放开」，Claude Code 不支持这个等级");
        assert_eq!(not_kept("auto", "opencode")["message"], "Its permission level is Auto-approve, which OpenCode doesn't keep");
    }
}
