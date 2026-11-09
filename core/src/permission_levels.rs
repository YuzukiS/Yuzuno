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

/// OpenCode's rules for level `id`, in order:
/// - `ask`: everything asks but reading, searching, listing, asking the user and its to-do list;
/// - `auto`: everything is allowed but a folder outside its own and a loop of the same failing call;
/// - `full`: everything is allowed.
///
/// No sandbox confines OpenCode's commands, at any level.
fn opencode_rules(id: &str) -> Option<&'static [(&'static str, Rule)]> {
    match id {
        "ask" => Some(&OPENCODE_ASK),
        "auto" => Some(&OPENCODE_AUTO),
        "full" => Some(&OPENCODE_FULL),
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

/// What a start checks each OpenCode agent decides as the level does.
const PROBES: [(&str, &str); 6] = [("edit", "src/main.rs"), ("shell", "cargo test"), ("webfetch", "https://example.com/"),
    ("external_directory", "/elsewhere/*"), ("read", "project/.env"), ("read", "project/README.md")];

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
        for (action, resource) in PROBES {
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
    }
}
