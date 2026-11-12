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
//! No level is each harness's own default for new Agents, as before.
//!
//! - `read-only` (YN-74 ④b; design YN-72 v3 4.1): no shell but one in a
//!   read-only sandbox, no tool that writes a file, no Job and no network. Of
//!   Yuzuno's tools only `READ_ONLY_TOOLS`: Core lists no other to that Agent
//!   and refuses any other call (collaboration_mcp.rs), whatever its harness
//!   was told. Codex: its `read-only` preset (sandbox readOnly without
//!   network, approval never), only those tools enabled on yuzuno and every
//!   other MCP server off, read back from the thread it starts. Claude Code:
//!   `default` mode with `claude_read_only`, which the bridge applies as
//!   disallowedTools, a PreToolUse hook allowing only its list, and no
//!   permission request. OpenCode: rules that deny all but reading and those
//!   tools, read back as every level (`opencode_check`). Kept with the Agent
//!   on every harness (`agent_permission_levels`), and its harness's own
//!   permission can't be changed while it is.
//!
//! OpenCode keeps each level as rules of its own (`opencode_config`), given to
//! that executor's `opencode serve` alone in OPENCODE_CONFIG_CONTENT. OpenCode
//! 2.2.5 appends a top-level `permission` from there to every agent's rules,
//! after its defaults and the user's and the project's configuration, and
//! decides by the last rule that matches (YN-56 S3, lab Jobs 07d33af5 and
//! ae58aecc). Its default agent allows everything but reading `.env`. A start
//! reads every agent's rules back and refuses one that doesn't keep the level
//! (`opencode_check`): a configuration read after Yuzuno's, such as a managed
//! one, can override it.
use crate::store::Store;
use anyhow::{bail, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// The rules Core gives an OpenCode executor whose permission requests it
/// answers itself (YN-78 S3a; Auto-approve from S4b-2).
pub(crate) mod opencode_policy;

/// Each level, with what it is on Codex (its permission preset) and on Claude
/// Code (its permission mode); None where that harness doesn't keep it.
static LEVELS: [Level; 4] = [
    Level { id: "ask", label: "Ask you first", label_zh: "先问你", codex: Some("ask"), claude: Some("default") },
    Level { id: "auto", label: "Auto-approve", label_zh: "自动审批", codex: Some("auto"), claude: Some("auto") },
    Level { id: "full", label: "Full access", label_zh: "完全放开", codex: Some("full"), claude: None },
    Level { id: READ_ONLY, label: "Read only", label_zh: "只读", codex: Some(READ_ONLY), claude: Some("default") },
];

/// The level of an executor that reads and proposes, and changes nothing
/// itself: a workspace cleanup's (YN-74).
pub(crate) const READ_ONLY: &str = "read-only";

/// The Yuzuno tools a read-only Agent may call (design YN-72 v3 4.1, as the
/// Lead approved in mail 10781): its cleanup's, reading and reporting on its
/// own task, the Brief for its Ask, its mail, and reading the inventory's Job
/// (job_get has the attempt and sha256 a plan names). No other: not
/// job_submit or any other Job, run, merge, PR, review, CI, delivery or
/// service tool, not task_create, task_dispatch or task_claim, and not
/// cleanup_restore (a lead's). A tool added later is outside it until named here.
pub(crate) const READ_ONLY_TOOLS: [&str; 19] = [
    "cleanup_inventory", "cleanup_plan_submit", "cleanup_plan_get", "cleanup_apply",
    "task_get", "task_list", "task_update", "task_comment", "task_submit_result", "task_result_get",
    "brief_get", "brief_update", "brief_guide",
    "peer_read", "peer_send", "peers_list",
    "job_get", "job_logs",
    "yuzuno_guide",
];

/// Whether a read-only Agent may call Yuzuno's tool `tool`.
pub(crate) fn read_only_allows(tool: &str) -> bool {
    READ_ONLY_TOOLS.contains(&tool)
}

/// Claude Code's own tools a read-only Agent keeps: reading, finding and
/// searching files, and ToolSearch, which only loads the schemas of tools it
/// already has (Yuzuno's are deferred).
const CLAUDE_READ_ONLY_KEPT: [&str; 4] = ["Read", "Glob", "Grep", "ToolSearch"];
/// And those it is started without (design 4.1), named so a model never
/// sees them: the shell, every file write, the web, and sub-agents. The
/// bridge's hook refuses whatever else is not kept, these included.
const CLAUDE_READ_ONLY_REMOVED: [&str; 11] =
    ["Bash", "BashOutput", "KillShell", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task"];

/// What the Claude bridge starts a read-only Agent with: `disallowedTools`,
/// Claude Code's tools above and every Yuzuno tool outside READ_ONLY_TOOLS;
/// `allowedTools`, the only tools its PreToolUse hook lets run.
pub(crate) fn claude_read_only() -> Value {
    let yuzuno = |name: &str| format!("mcp__yuzuno__{name}");
    let names: Vec<String> = crate::collaboration_store::tool_definitions().iter()
        .filter_map(|t| t["name"].as_str().map(str::to_owned)).collect();
    let removed: Vec<String> = CLAUDE_READ_ONLY_REMOVED.iter().map(|t| (*t).to_owned())
        .chain(names.iter().filter(|n| !read_only_allows(n)).map(|n| yuzuno(n))).collect();
    let kept: Vec<String> = CLAUDE_READ_ONLY_KEPT.iter().map(|t| (*t).to_owned())
        .chain(READ_ONLY_TOOLS.iter().map(|n| yuzuno(n))).collect();
    json!({"disallowedTools": removed, "allowedTools": kept})
}

/// Refuses a Codex thread a read-only Agent was given that doesn't keep the
/// level, as Codex answered thread/start or thread/resume: its sandbox must
/// be readOnly without network, and it must never ask for approval.
pub(crate) fn codex_check(answer: &Value) -> Result<()> {
    let sandbox = &answer["sandbox"];
    ensure!(sandbox["type"] == "readOnly" && sandbox["networkAccess"] == false && answer["approvalPolicy"] == "never",
        "Codex didn't keep the permission level Read only: its thread runs with sandbox {} and approval {}, not readOnly without network and never. The executor was not started",
        sandbox, answer["approvalPolicy"]);
    Ok(())
}

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
    ensure!(level(id).is_some(), "A permission level is ask, auto, full or read-only, not {id}");
    Ok(())
}

/// What `id` is on `harness`: a Codex permission preset (`agent_defaults::CODEX_PRESETS`),
/// a Claude Code permission mode (`agent_defaults::CLAUDE_MODES`), or for OpenCode the
/// level itself, which its rules say (`opencode_config`); None when that harness
/// doesn't keep it, or `id` is no level.
pub(crate) fn native(id: &str, harness: &str) -> Option<&'static str> {
    let level = level(id)?;
    match harness {
        "codex" => level.codex,
        "claude" => level.claude,
        "opencode" => opencode_rules(level.id).map(|_| level.id),
        _ => None,
    }
}

/// One entry of OpenCode's `permission` configuration: an action's effect, or
/// its effect by resource pattern, in order.
enum Rule {
    Effect(&'static str),
    Patterns(&'static [(&'static str, &'static str)]),
}

/// Reading a file: allowed, but `.env` files ask, as OpenCode's own default.
const READS: &[(&str, &str)] = &[("*", "allow"), ("*.env", "ask"), ("*.env.*", "ask"), ("*.env.example", "allow")];
static OPENCODE_ASK: [(&str, Rule); 8] = [("*", Rule::Effect("ask")), ("read", Rule::Patterns(READS)), ("grep", Rule::Effect("allow")),
    ("glob", Rule::Effect("allow")), ("list", Rule::Effect("allow")), ("question", Rule::Effect("allow")),
    ("todowrite", Rule::Effect("allow")), ("todoread", Rule::Effect("allow"))];
static OPENCODE_AUTO: [(&str, Rule); 4] = [("*", Rule::Effect("allow")), ("external_directory", Rule::Effect("ask")),
    ("doom_loop", Rule::Effect("ask")), ("read", Rule::Patterns(READS))];
static OPENCODE_FULL: [(&str, Rule); 1] = [("*", Rule::Effect("allow"))];
/// Read-only reads no `.env` file either: it can ask nobody.
const READ_ONLY_READS: &[(&str, &str)] = &[("*", "allow"), ("*.env", "deny"), ("*.env.*", "deny"), ("*.env.example", "allow")];
const ALLOW: Rule = Rule::Effect("allow");
/// Everything denied, then reading, searching, listing and READ_ONLY_TOOLS
/// as OpenCode names Yuzuno's tools (`yuzuno_<tool>`, opencode_agent.rs).
static OPENCODE_READ_ONLY: [(&str, Rule); 24] = [("*", Rule::Effect("deny")), ("read", Rule::Patterns(READ_ONLY_READS)),
    ("grep", ALLOW), ("glob", ALLOW), ("list", ALLOW),
    ("yuzuno_cleanup_inventory", ALLOW), ("yuzuno_cleanup_plan_submit", ALLOW), ("yuzuno_cleanup_plan_get", ALLOW), ("yuzuno_cleanup_apply", ALLOW),
    ("yuzuno_task_get", ALLOW), ("yuzuno_task_list", ALLOW), ("yuzuno_task_update", ALLOW), ("yuzuno_task_comment", ALLOW),
    ("yuzuno_task_submit_result", ALLOW), ("yuzuno_task_result_get", ALLOW),
    ("yuzuno_brief_get", ALLOW), ("yuzuno_brief_update", ALLOW), ("yuzuno_brief_guide", ALLOW),
    ("yuzuno_peer_read", ALLOW), ("yuzuno_peer_send", ALLOW), ("yuzuno_peers_list", ALLOW),
    ("yuzuno_job_get", ALLOW), ("yuzuno_job_logs", ALLOW), ("yuzuno_yuzuno_guide", ALLOW)];

/// OpenCode's rules for level `id`, in order:
/// - `ask`: everything asks but reading, searching, listing, asking the user and its to-do list;
/// - `auto`: everything is allowed but a folder outside its own and a loop of the same failing call;
/// - `full`: everything is allowed;
/// - `read-only`: everything is denied but reading (no `.env`), searching, listing and READ_ONLY_TOOLS.
///
/// No sandbox confines OpenCode's commands, at any level: read-only has none.
fn opencode_rules(id: &str) -> Option<&'static [(&'static str, Rule)]> {
    match id {
        "ask" => Some(&OPENCODE_ASK),
        "auto" => Some(&OPENCODE_AUTO),
        "full" => Some(&OPENCODE_FULL),
        READ_ONLY => Some(&OPENCODE_READ_ONLY),
        _ => None,
    }
}

/// The configuration an OpenCode executor of level `id` starts with
/// (OPENCODE_CONFIG_CONTENT), its rules in their order: OpenCode decides by
/// the last that matches.
pub(crate) fn opencode_config(id: &str) -> Option<String> {
    let rules = opencode_rules(id)?;
    let quoted = |text: &str| serde_json::to_string(text).expect("a string is JSON");
    let entries: Vec<String> = rules.iter().map(|(action, rule)| match rule {
        Rule::Effect(effect) => format!("{}:{}", quoted(action), quoted(effect)),
        Rule::Patterns(patterns) => format!("{}:{{{}}}", quoted(action),
            patterns.iter().map(|(pattern, effect)| format!("{}:{}", quoted(pattern), quoted(effect))).collect::<Vec<_>>().join(",")),
    }).collect();
    Some(format!("{{\"permission\":{{{}}}}}", entries.join(",")))
}

/// Level `id`'s rules as OpenCode holds them: (action, resource pattern, effect).
fn opencode_ruleset(id: &str) -> Vec<(&'static str, &'static str, &'static str)> {
    opencode_rules(id).into_iter().flatten().flat_map(|(action, rule)| match rule {
        Rule::Effect(effect) => vec![(*action, "*", *effect)],
        Rule::Patterns(patterns) => patterns.iter().map(|(pattern, effect)| (*action, *pattern, *effect)).collect(),
    }).collect()
}

/// Whether `text` matches OpenCode's wildcard `pattern`: `*` is any run of
/// characters, `?` any one.
fn wildcard(pattern: &str, text: &str) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    let (mut i, mut j, mut star, mut mark) = (0, 0, None, 0);
    while j < t.len() {
        if i < p.len() && (p[i] == '?' || p[i] == t[j]) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == '*' {
            star = Some(i);
            mark = j;
            i += 1;
        } else if let Some(at) = star {
            i = at + 1;
            mark += 1;
            j = mark;
        } else {
            return false;
        }
    }
    p[i..].iter().all(|c| *c == '*')
}

/// OpenCode's decision for `action` on `resource`: the last rule that matches,
/// else ask.
fn decided<'a>(rules: impl DoubleEndedIterator<Item = (&'a str, &'a str, &'a str)>, action: &str, resource: &str) -> &'a str {
    rules.rev().find(|(a, r, _)| wildcard(a, action) && wildcard(r, resource)).map_or("ask", |(_, _, effect)| effect)
}

/// What a start checks each OpenCode agent decides as the level does: for
/// read-only also a Yuzuno tool it keeps and one it doesn't.
const PROBES: [(&str, &str); 9] = [("edit", "src/main.rs"), ("shell", "cargo test"), ("bash", "rm -rf src"), ("webfetch", "https://example.com/"),
    ("external_directory", "/elsewhere/*"), ("read", "project/.env"), ("read", "project/README.md"),
    ("yuzuno_job_submit", "*"), ("yuzuno_cleanup_plan_submit", "*")];

/// OpenCode's managed configuration on this host (2.2.5 `Ux`: /etc/opencode on
/// Linux), which it reads after Yuzuno's: named when a start check fails.
pub(crate) const OPENCODE_MANAGED: &str = if cfg!(target_os = "macos") { "/Library/Application Support/opencode" } else { "/etc/opencode" };

/// Refuses an OpenCode server whose agents (`GET /api/agent`'s data) don't
/// keep level `id`: for each probe, each agent's own rules must decide what
/// the level's rules alone do. A configuration OpenCode reads after Yuzuno's,
/// such as a managed one, is what can make them differ: `managed` names the
/// managed one when it is there.
pub(crate) fn opencode_check(id: &str, agents: &Value, managed: Option<&str>) -> Result<()> {
    let ours = opencode_ruleset(id);
    ensure!(!ours.is_empty(), "OpenCode keeps no permission level {id}");
    check_rules(id, &ours, PROBES.iter().copied(), agents, managed)
}

/// `opencode_check` against any rules (`ours`) and probes: each agent must
/// decide each probe as `ours` alone do.
fn check_rules<'p>(id: &str, ours: &[(&str, &str, &str)], probes: impl Iterator<Item = (&'p str, &'p str)> + Clone, agents: &Value,
    managed: Option<&str>) -> Result<()> {
    let agents = agents.as_array().filter(|a| !a.is_empty())
        .ok_or_else(|| anyhow::anyhow!("OpenCode listed no agent, so its permission level {id} can't be checked"))?;
    for agent in agents {
        let name = agent["id"].as_str().unwrap_or("?");
        let Some(rules) = agent["permissions"].as_array() else {
            bail!("OpenCode's agent {name} lists no permission rules, so its permission level {id} can't be checked");
        };
        let rules: Vec<(&str, &str, &str)> = rules.iter()
            .map(|r| (r["action"].as_str().unwrap_or(""), r["resource"].as_str().unwrap_or(""), r["effect"].as_str().unwrap_or("")))
            .collect();
        for (action, resource) in probes.clone() {
            let (got, want) = (decided(rules.iter().copied(), action, resource), decided(ours.iter().copied(), action, resource));
            if got != want {
                let why = match managed {
                    Some(path) => format!("OpenCode's managed configuration in {path}, which it reads after Yuzuno's, overrides it"),
                    None => "A configuration OpenCode reads after Yuzuno's, such as a managed one, overrides it".to_owned(),
                };
                bail!("OpenCode's agent {name} doesn't keep the permission level {id}: for {action} on {resource} it decides {got}, the level {want}. {why}");
            }
        }
    }
    Ok(())
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
        "opencode": opencode_config(l.id).and_then(|text| serde_json::from_str::<Value>(&text).ok()),
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

/// An OpenCode executor's level, which each start of its `opencode serve`
/// reads again: kept in its own table, as the runtime profile is
/// (routing_launch.rs), since older Cores rewrite the Agent's record and drop
/// what they don't know. Runs on every open, idempotent; older Cores never
/// create or read it.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_permission_levels(
            agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
            level TEXT NOT NULL,
            updated_at TEXT NOT NULL);
        DELETE FROM agent_permission_levels WHERE agent_id NOT IN (SELECT id FROM agents);",
    )?;
    Ok(())
}

impl Store {
    /// Agent `agent`'s permission level, if a dispatch gave it one.
    pub(crate) fn permission_level(&self, agent: &str) -> Result<Option<String>> {
        Ok(self.db.read()?.query_row("SELECT level FROM agent_permission_levels WHERE agent_id=?1", [agent], |r| r.get(0)).optional()?)
    }

    /// Sets (or with None clears) an Agent's level; it takes effect at its next start.
    pub(crate) fn set_permission_level(&self, agent: &str, level: Option<&str>) -> Result<()> {
        let db = self.db.write()?;
        match level {
            Some(level) => {
                check(level)?;
                db.execute("INSERT INTO agent_permission_levels(agent_id,level,updated_at) VALUES(?1,?2,?3)
                    ON CONFLICT(agent_id) DO UPDATE SET level=excluded.level, updated_at=excluded.updated_at",
                    params![agent, level, chrono::Utc::now().to_rfc3339()])?
            }
            None => db.execute("DELETE FROM agent_permission_levels WHERE agent_id=?1", [agent])?,
        };
        Ok(())
    }
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
            assert_eq!(native(id, "opencode"), Some(id), "OpenCode keeps each, as its own rules");
        }
        assert_eq!(native("readonly", "codex"), None);
        assert_eq!([native(READ_ONLY, "codex"), native(READ_ONLY, "claude"), native(READ_ONLY, "opencode")],
            [Some("read-only"), Some("default"), Some("read-only")]);
        assert!(CODEX_PRESETS.contains(&"read-only") && keeps(Some(READ_ONLY), "codex") && keeps(Some(READ_ONLY), "claude"));
    }

    #[test]
    fn no_level_is_kept_everywhere_opencode_keeps_each_and_an_unknown_harness_none() {
        for harness in ["codex", "claude", "opencode", "later"] {
            assert!(keeps(None, harness), "{harness}");
        }
        assert!(["ask", "auto", "full"].into_iter().all(|id| keeps(Some(id), "codex")));
        assert!(keeps(Some("ask"), "claude") && keeps(Some("auto"), "claude") && !keeps(Some("full"), "claude"));
        assert!(["ask", "auto", "full"].into_iter().all(|id| keeps(Some(id), "opencode")));
        assert!(["ask", "auto", "full"].into_iter().all(|id| !keeps(Some(id), "later")));
        assert!(!keeps(Some("readonly"), "codex"), "not a level");
        assert!(check("readonly").unwrap_err().to_string().contains("ask, auto, full or read-only"));
        assert!(!keeps(Some(READ_ONLY), "later"), "a harness Core can't make read-only is passed over");
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
        assert_eq!(ids, ["ask", "auto", "full", "read-only"]);
        assert_eq!(table[3]["codex"], json!({"permissionPreset": "read-only"}));
        assert_eq!(table[3]["opencode"]["permission"]["*"], "deny");
        assert_eq!(table[0]["codex"], json!({"permissionPreset": "ask"}));
        assert_eq!(table[0]["claude"], json!({"permissionMode": "default"}));
        assert_eq!((table[2]["claude"].clone(), table[2]["labelZh"].clone()), (Value::Null, json!("完全放开")));
        assert_eq!(table[2]["opencode"], json!({"permission": {"*": "allow"}}));
        assert!(table.as_array().unwrap().iter().all(|l| l["opencode"]["permission"]["*"].is_string()));
        assert_eq!(label("auto"), ("Auto-approve", "自动审批"));
    }

    #[test]
    fn levels_not_kept_say_which_level_and_harness_in_both_languages() {
        let why = not_kept("full", "claude");
        assert_eq!(why["code"], "levelNotKept");
        assert_eq!(why["params"], json!({"level": "full", "harness": "claude"}));
        assert_eq!(why["message"], "Its permission level is Full access, which Claude Code doesn't keep");
        assert_eq!(why["messageZh"], "它的权限等级是「完全放开」，Claude Code 不支持这个等级");
        assert_eq!(not_kept("auto", "later")["message"], "Its permission level is Auto-approve, which later doesn't keep");
    }

    #[test]
    fn opencodes_rules_for_each_level_are_written_in_their_order() {
        assert_eq!(opencode_config("ask").unwrap(), concat!(r#"{"permission":{"*":"ask","read":{"*":"allow","*.env":"ask","*.env.*":"ask","#,
            r#""*.env.example":"allow"},"grep":"allow","glob":"allow","list":"allow","question":"allow","todowrite":"allow","todoread":"allow"}}"#));
        assert_eq!(opencode_config("auto").unwrap(), concat!(r#"{"permission":{"*":"allow","external_directory":"ask","doom_loop":"ask","#,
            r#""read":{"*":"allow","*.env":"ask","*.env.*":"ask","*.env.example":"allow"}}}"#));
        assert_eq!(opencode_config("full").unwrap(), r#"{"permission":{"*":"allow"}}"#);
        assert_eq!(opencode_config("readonly"), None);
        let text = opencode_config(READ_ONLY).unwrap();
        assert!(text.starts_with(r#"{"permission":{"*":"deny","read":{"*":"allow","*.env":"deny","#), "denied first; the rest decide after it: {text}");
        let read_only: Value = serde_json::from_str(&text).unwrap();
        let rules = read_only["permission"].as_object().unwrap();
        let mut yuzuno: Vec<&str> = rules.keys().filter_map(|k| k.strip_prefix("yuzuno_")).collect();
        let mut listed = READ_ONLY_TOOLS.to_vec();
        yuzuno.sort_unstable();
        listed.sort_unstable();
        assert_eq!(yuzuno, listed, "OpenCode keeps exactly the tools Core lists");
        assert!(rules.iter().filter(|(k, _)| k.as_str() != "*" && k.as_str() != "read").all(|(_, effect)| effect == "allow"));
        for id in ["ask", "auto", "full"] {
            serde_json::from_str::<Value>(&opencode_config(id).unwrap()).unwrap();
        }
    }

    #[test]
    fn opencodes_wildcards_and_last_matching_rule() {
        assert!(wildcard("*", "") && wildcard("*", "a/b c") && wildcard("*.env", "project/.env") && wildcard("*.env.*", "x/.env.local"));
        assert!(!wildcard("*.env", "x/.env.local") && !wildcard("read", "reader") && wildcard("re?d", "read") && wildcard("*plan/*", "/h/.opencode/plan/a.md"));
        let ask = opencode_ruleset("ask");
        let on = |action: &str, resource: &str| decided(ask.iter().copied(), action, resource);
        assert_eq!((on("edit", "src/a.rs"), on("read", "README.md"), on("read", "app/.env"), on("read", "app/.env.example"), on("grep", "*")),
            ("ask", "allow", "ask", "allow", "allow"));
        let auto = opencode_ruleset("auto");
        let on = |action: &str, resource: &str| decided(auto.iter().copied(), action, resource);
        assert_eq!((on("edit", "src/a.rs"), on("shell", "cargo test"), on("external_directory", "/elsewhere/*"), on("read", "app/.env")),
            ("allow", "allow", "ask", "ask"));
        assert_eq!(decided(std::iter::empty(), "edit", "x"), "ask", "no rule: OpenCode asks");
    }

    /// Agents as OpenCode 2.2.5's GET /api/agent lists them (lab Job ae58aecc, a synthetic path):
    /// its own rules, then the configuration's, then its browser denies.
    fn agents(level: Option<&str>, after: &[(&str, &str, &str)]) -> Value {
        let defaults = [("*", "*", "allow"), ("read", "*.env", "ask"), ("read", "*.env.*", "ask"), ("read", "*.env.example", "allow")];
        let own: [(&str, Vec<(&str, &str, &str)>); 3] = [
            ("build", vec![("question", "*", "allow")]),
            ("plan", vec![("question", "*", "allow"), ("edit", "*", "deny"), ("edit", "/synthetic/home/.opencode/plan/*", "allow")]),
            ("title", vec![("*", "*", "deny")]),
        ];
        let tail = [("browser", "*", "deny"), ("skill", "browser", "deny")];
        Value::Array(own.iter().map(|(id, rules)| {
            let all: Vec<Value> = defaults.iter().chain(rules).copied().chain(level.map(opencode_ruleset).unwrap_or_default())
                .chain(after.iter().copied()).chain(tail).map(|(a, r, e)| json!({"action": a, "resource": r, "effect": e})).collect();
            json!({"id": id, "mode": "primary", "permissions": all})
        }).collect())
    }

    #[test]
    fn an_opencode_start_is_checked_to_keep_its_level_in_every_agent() {
        for id in ["ask", "auto", "full"] {
            opencode_check(id, &agents(Some(id), &[]), None).unwrap_or_else(|e| panic!("{id}: {e:#}"));
        }
        let without = opencode_check("ask", &agents(None, &[]), None).unwrap_err().to_string();
        assert!(without.starts_with("OpenCode's agent build doesn't keep the permission level ask: for edit on src/main.rs it decides allow, the level ask"),
            "{without}");
        let overridden = opencode_check("auto", &agents(Some("auto"), &[("external_directory", "*", "allow")]), None).unwrap_err().to_string();
        assert!(overridden.contains("for external_directory on /elsewhere/* it decides allow, the level ask")
            && overridden.ends_with("A configuration OpenCode reads after Yuzuno's, such as a managed one, overrides it"), "{overridden}");
        let managed = opencode_check("auto", &agents(Some("auto"), &[("external_directory", "*", "allow")]), Some("/etc/opencode"))
            .unwrap_err().to_string();
        assert!(managed.ends_with("OpenCode's managed configuration in /etc/opencode, which it reads after Yuzuno's, overrides it"), "{managed}");
        assert!(opencode_check("ask", &json!([]), None).unwrap_err().to_string().contains("listed no agent"));
        assert!(opencode_check("ask", &json!([{"id": "build"}]), None).unwrap_err().to_string().contains("lists no permission rules"));
        assert!(opencode_check("readonly", &agents(Some("ask"), &[]), None).is_err());
        opencode_check(READ_ONLY, &agents(Some(READ_ONLY), &[]), None).unwrap();
        // A user's rule read after Yuzuno's that lets the shell run is caught.
        let shell = opencode_check(READ_ONLY, &agents(Some(READ_ONLY), &[("bash", "*", "allow")]), Some("/etc/opencode")).unwrap_err().to_string();
        assert!(shell.contains("for bash on rm -rf src it decides allow, the level deny"), "{shell}");
        let job = opencode_check(READ_ONLY, &agents(Some(READ_ONLY), &[("yuzuno_*", "*", "allow")]), None).unwrap_err().to_string();
        assert!(job.contains("for yuzuno_job_submit on * it decides allow, the level deny"), "{job}");
    }

    #[test]
    fn read_only_keeps_only_its_tools_on_every_harness() {
        let ruleset = opencode_ruleset(READ_ONLY);
        let on = |action: &str, resource: &str| decided(ruleset.iter().copied(), action, resource);
        assert_eq!((on("edit", "src/a.rs"), on("bash", "rm -rf src"), on("webfetch", "https://example.com/"), on("external_directory", "/x/*")),
            ("deny", "deny", "deny", "deny"));
        assert_eq!((on("read", "src/a.rs"), on("read", "app/.env"), on("grep", "*"), on("list", "*")), ("allow", "deny", "allow", "allow"));
        assert_eq!((on("yuzuno_cleanup_plan_submit", "*"), on("yuzuno_job_get", "*"), on("yuzuno_job_submit", "*"), on("yuzuno_task_dispatch", "*")),
            ("allow", "allow", "deny", "deny"));
        // Every listed tool exists; the ones that start or change other work are out.
        let names: Vec<String> = crate::collaboration_store::tool_definitions().iter().map(|t| t["name"].as_str().unwrap().to_owned()).collect();
        for tool in READ_ONLY_TOOLS {
            assert!(names.iter().any(|n| n == tool), "{tool} is a Yuzuno tool");
        }
        for tool in ["job_submit", "job_run_submit", "job_run_retry", "job_cancel", "merge_enqueue", "github_pr_submit", "review_start",
            "ci_subscribe", "delivery_enable", "task_create", "task_dispatch", "task_claim", "cleanup_restore", "service_register"] {
            assert!(!read_only_allows(tool), "{tool}");
        }
        let claude = claude_read_only();
        let removed: Vec<&str> = claude["disallowedTools"].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
        let kept: Vec<&str> = claude["allowedTools"].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
        for tool in ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "mcp__yuzuno__job_submit", "mcp__yuzuno__job_run_submit",
            "mcp__yuzuno__job_run_retry", "mcp__yuzuno__job_cancel", "mcp__yuzuno__merge_enqueue", "mcp__yuzuno__github_pr_submit"] {
            assert!(removed.contains(&tool), "{tool} is removed");
        }
        assert_eq!(&kept[..4], ["Read", "Glob", "Grep", "ToolSearch"]);
        assert!(kept.contains(&"mcp__yuzuno__cleanup_plan_submit") && !kept.contains(&"mcp__yuzuno__job_submit"));
        assert!(removed.iter().all(|t| !kept.contains(t)), "nothing is both");
        assert_eq!(removed.len() - 11 + READ_ONLY_TOOLS.len(), names.len(), "each Yuzuno tool is kept or removed");
        codex_check(&json!({"sandbox": {"type": "readOnly", "networkAccess": false}, "approvalPolicy": "never"})).unwrap();
        for answer in [json!({"sandbox": {"type": "workspaceWrite", "networkAccess": false}, "approvalPolicy": "never"}),
            json!({"sandbox": {"type": "readOnly", "networkAccess": true}, "approvalPolicy": "never"}),
            json!({"sandbox": {"type": "readOnly", "networkAccess": false}, "approvalPolicy": "on-request"}), json!({})] {
            assert!(codex_check(&answer).unwrap_err().to_string().contains("didn't keep the permission level Read only"), "{answer}");
        }
    }
}
