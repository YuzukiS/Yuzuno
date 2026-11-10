//! The S3a rules, checked as OpenCode reads them: from the JSON text, by
//! JSON.parse's and Object.entries's order, deciding by the last match.
use super::*;
use crate::permission_levels::{decided, wildcard, READ_ONLY};
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::path::PathBuf;

// Synthetic paths, as a Linux Core lays them out (opencode_agent.rs, executor_temp.rs).
const D: &str = "/synthetic/home/u/.local/share/yuzuno/workspace";
const O1: &str = "/synthetic/home/u/.local/share/yuzuno/workspace/opencode/a1b2c3d4/xdg/data/opencode/shell";
const O2: &str = "/synthetic/home/u/.local/share/yuzuno/workspace/opencode/a1b2c3d4/xdg/data/opencode/tool-output";
const T: &str = "/synthetic/home/u/.local/share/yuzuno/workspace/t/a1b2c3d4";
const RULES: &str = "/synthetic/home/u/.local/share/yuzuno/workspace/opencode/a1b2c3d4/yuzuno-rules.md";
const SSH: &str = "/synthetic/home/u/.ssh";
const AWS: &str = "/synthetic/home/u/.aws";
const NETRC: &str = "/synthetic/home/u/.netrc";

/// An executor's inputs, owned so a test can change one.
#[derive(Clone)]
struct Given {
    level: Option<&'static str>,
    platform: Platform,
    data: PathBuf,
    outputs: [PathBuf; 2],
    temp: Option<PathBuf>,
    dirs: Vec<PathBuf>,
    files: Vec<PathBuf>,
    instructions: PathBuf,
}

impl Given {
    fn auto() -> Self {
        Self { level: Some("auto"), platform: Platform::Unix, data: D.into(), outputs: [O1.into(), O2.into()], temp: Some(T.into()),
            dirs: vec![SSH.into(), AWS.into()], files: vec![NETRC.into()], instructions: RULES.into() }
    }
    fn with(mut self, change: impl FnOnce(&mut Self)) -> Self {
        change(&mut self);
        self
    }
    fn policy(&self) -> Result<Option<Policy>> {
        let dirs: Vec<&Path> = self.dirs.iter().map(PathBuf::as_path).collect();
        let files: Vec<&Path> = self.files.iter().map(PathBuf::as_path).collect();
        policy(&Inputs { level: self.level, platform: self.platform, data_dir: &self.data, outputs: [&self.outputs[0], &self.outputs[1]],
            temp: self.temp.as_deref(), protected_dirs: &dirs, protected_files: &files, instructions: &self.instructions })
    }
    fn made(&self) -> Policy {
        self.policy().unwrap().expect("a policy")
    }
}

/// A JSON value as JavaScript gives it to OpenCode: JSON.parse keeps a
/// repeated key at its first place with its last value, and Object.entries
/// lists array-index keys first, ascending, then the rest in that order.
#[derive(Debug)]
enum Js {
    Text(String),
    List(Vec<Js>),
    Object(Vec<(String, Js)>),
}

fn array_index(key: &str) -> Option<u32> {
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == key)
}

impl<'de> Deserialize<'de> for Js {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Read;
        impl<'de> Visitor<'de> for Read {
            type Value = Js;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a string, a list or an object")
            }
            fn visit_str<E>(self, text: &str) -> std::result::Result<Js, E> {
                Ok(Js::Text(text.to_owned()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Js, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Js::List(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Js, A::Error> {
                let mut entries: Vec<(String, Js)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Js>()? {
                    match entries.iter_mut().find(|(k, _)| *k == key) {
                        Some(entry) => entry.1 = value,
                        None => entries.push((key, value)),
                    }
                }
                let (mut index, rest): (Vec<_>, Vec<_>) = entries.into_iter().partition(|(k, _)| array_index(k).is_some());
                index.sort_by_key(|(k, _)| array_index(k));
                index.extend(rest);
                Ok(Js::Object(index))
            }
        }
        deserializer.deserialize_any(Read)
    }
}

/// The rules OpenCode builds from configuration `text`, in its order, and its instructions.
fn read_back(text: &str) -> (Vec<(String, String, String)>, Vec<String>) {
    let Js::Object(top) = serde_json::from_str::<Js>(text).unwrap() else { panic!("not an object: {text}") };
    let mut rules = Vec::new();
    let mut instructions = Vec::new();
    for (key, value) in top {
        match (key.as_str(), value) {
            ("permission", Js::Object(actions)) => for (action, rule) in actions {
                match rule {
                    Js::Text(effect) => rules.push((action, "*".to_owned(), effect)),
                    Js::Object(patterns) => for (pattern, effect) in patterns {
                        let Js::Text(effect) = effect else { panic!("{action} {pattern}: not an effect") };
                        rules.push((action.clone(), pattern, effect));
                    },
                    Js::List(_) => panic!("{action}: a list"),
                }
            },
            ("instructions", Js::List(paths)) => instructions = paths.into_iter().map(|p| match p {
                Js::Text(path) => path,
                other => panic!("not a path: {other:?}"),
            }).collect(),
            (other, _) => panic!("unexpected key {other}"),
        }
    }
    (rules, instructions)
}

fn ours(policy: &Policy) -> Vec<(String, String, String)> {
    policy.rules.iter().map(|(a, p, e)| (a.clone(), p.clone(), (*e).to_owned())).collect()
}

fn on<'a>(rules: &'a [(String, String, String)], action: &str, resource: &str) -> &'a str {
    decided(rules.iter().map(|(a, p, e)| (a.as_str(), p.as_str(), e.as_str())), action, resource)
}

/// `policy` read back from its own text: exactly its rules, and its probes and
/// `resources` decided alike by both.
fn read_back_as_made(policy: &Policy) -> Vec<(String, String, String)> {
    let (back, _) = read_back(&policy.config);
    assert_eq!(back, ours(policy), "OpenCode reads back exactly the rules made, in their order");
    back
}

/// Each (action, resource, effect), decided by `policy` as OpenCode reads it back.
fn assert_decides(policy: &Policy, table: &[(&str, &str, &str)]) {
    let back = read_back_as_made(policy);
    for (action, resource, want) in table {
        assert_eq!(on(&back, action, resource), *want, "{action} on {resource}");
    }
}

#[test]
fn auto_rules_are_written_in_their_order_and_read_back_as_written() {
    let policy = Given::auto().made();
    let rules: Vec<(&str, &str, &str)> = policy.rules.iter().map(|(a, p, e)| (a.as_str(), p.as_str(), *e)).collect();
    let (d, o1, o2, t, ssh, aws) = (format!("{D}/*"), format!("{O1}/*"), format!("{O2}/*"), format!("{T}/*"), format!("{SSH}/*"), format!("{AWS}/*"));
    let want: [(&str, &str, &str); 26] = [
        ("*", "*", "allow"),
        ("external_directory", "*", "ask"), ("external_directory", &d, "deny"), ("external_directory", &o1, "ask"),
        ("external_directory", &o2, "ask"), ("external_directory", &t, "ask"), ("external_directory", &ssh, "deny"),
        ("external_directory", &aws, "deny"),
        ("read", "*", "ask"), ("read", &d, "deny"), ("read", &o1, "ask"), ("read", &o2, "ask"), ("read", &t, "ask"),
        ("read", &ssh, "deny"), ("read", &aws, "deny"), ("read", NETRC, "deny"), ("read", "*.env", "deny"),
        ("grep", "*", "ask"), ("glob", "*", "ask"), ("list", "*", "ask"),
        ("edit", "*", "allow"), ("edit", "/*", "deny"), ("edit", &t, "allow"), ("edit", &ssh, "deny"), ("edit", &aws, "deny"),
        ("edit", NETRC, "deny"),
    ];
    assert_eq!(rules, want);
    let (back, instructions) = read_back(&policy.config);
    assert_eq!(back, ours(&policy));
    assert_eq!(instructions, [RULES], "its instructions file, loaded by the configuration");
    assert!(policy.config.starts_with(r#"{"permission":{"*":"allow","external_directory":{"*":"ask","#), "{}", policy.config);
    assert!(!policy.config.contains("doom_loop"), "2.2.5 never raises doom_loop");
}

#[test]
fn auto_decides_by_the_last_matching_rule_as_the_design_says() {
    let policy = Given::auto().made();
    let at = |dir: &str, rest: &str| format!("{dir}/{rest}");
    let rows: Vec<(&str, String, &str)> = vec![
        // A folder outside the executor's own: handed to Core, but D and protected ones.
        ("external_directory", "/elsewhere/*".into(), "ask"), ("external_directory", at(D, "*"), "deny"),
        ("external_directory", at(D, "opencode/*"), "deny"), ("external_directory", at(O1, "*"), "ask"),
        ("external_directory", at(O2, "sub/*"), "ask"), ("external_directory", at(T, "*"), "ask"), ("external_directory", at(T, "k/*"), "ask"),
        ("external_directory", at(SSH, "*"), "deny"), ("external_directory", at(AWS, "cli/*"), "deny"),
        ("external_directory", "/synthetic/home/u/.sshx/*".into(), "ask"),
        // Reading: Core decides, but D, protected locations and `.env` files.
        ("read", "src/main.rs".into(), "ask"), ("read", ".env".into(), "deny"), ("read", "app/.env".into(), "deny"),
        ("read", "app/.env.local".into(), "ask"), ("read", "app/.env.example".into(), "ask"), ("read", "/elsewhere/a".into(), "ask"),
        ("read", at(D, "workspace.db"), "deny"), ("read", at(O1, "out"), "ask"), ("read", at(O2, "x.env"), "deny"),
        ("read", at(T, "x"), "ask"), ("read", at(T, "a.env"), "deny"), ("read", at(T, ".env.example"), "ask"),
        ("read", at(SSH, "id_rsa"), "deny"), ("read", at(AWS, "x.env.example"), "deny"), ("read", NETRC.into(), "deny"),
        ("read", "/synthetic/home/u/.netrc.bak".into(), "ask"),
        ("grep", "*".into(), "ask"), ("grep", "TODO".into(), "ask"), ("glob", "**/*.rs".into(), "ask"), ("list", "*".into(), "ask"),
        // Writing: in the folder, and outside it only in T.
        ("edit", "src/main.rs".into(), "allow"), ("edit", "/elsewhere/a".into(), "deny"), ("edit", at(T, "a"), "allow"),
        ("edit", at(T, "sub/b"), "allow"), ("edit", at(D, "a"), "deny"), ("edit", at(O1, "a"), "deny"), ("edit", NETRC.into(), "deny"),
        // The rest is allowed, as today; doom_loop is gone.
        ("shell", "cargo test".into(), "allow"), ("bash", "rm -rf src".into(), "allow"), ("webfetch", "https://example.com/".into(), "allow"),
        ("doom_loop", "*".into(), "allow"), ("question", "*".into(), "allow"), ("yuzuno_job_submit", "*".into(), "allow"),
    ];
    let table: Vec<(&str, &str, &str)> = rows.iter().map(|(a, r, e)| (*a, r.as_str(), *e)).collect();
    assert_decides(&policy, &table);
    // Today's rules ask the user for YN-77's folder and for OpenCode's own
    // output; these hand both to Core instead, which answers from S4 on.
    let today = opencode_ruleset("auto");
    let old = |action: &str, resource: &str| decided(today.iter().copied(), action, resource);
    assert_eq!((old("external_directory", "/tmp/opencode/yn77/*"), old("external_directory", &at(O2, "*"))), ("ask", "ask"));
    assert_eq!((old("read", "src/main.rs"), old("doom_loop", "*"), old("read", "app/.env")), ("allow", "ask", "ask"));
    assert_decides(&policy, &[("external_directory", "/tmp/opencode/yn77/*", "ask"), ("read", "/tmp/opencode/yn77/x", "ask")]);
}

/// Each probe and a few more: what a rule set is checked against.
fn resources(policy: &Policy) -> Vec<(String, String)> {
    let mut all = policy.probes.clone();
    for action in ["external_directory", "read", "grep", "glob", "list", "edit"] {
        for resource in ["*", "/", "/*", "src/a.rs", ".env", "x/.env.example", "/elsewhere/a/*", "/tmp/x"] {
            all.push((action.to_owned(), resource.to_owned()));
        }
    }
    all
}

#[test]
fn no_file_tool_is_ever_allowed_statically_at_auto_or_ask() {
    let variants = [Given::auto(), Given::auto().with(|g| g.temp = None), Given::auto().with(|g| g.dirs = vec![format!("{D}/t").into()]),
        Given::auto().with(|g| { g.dirs.clear(); g.files.clear(); }), Given::auto().with(|g| g.level = Some("ask"))];
    for given in variants {
        let policy = given.made();
        let back = read_back_as_made(&policy);
        for action in ["external_directory", "read", "grep", "glob", "list"] {
            // A later rule for every resource that isn't allow, and no allow after it.
            let cover = back.iter().rposition(|(a, p, e)| wildcard(a, action) && p == "*" && e != "allow")
                .unwrap_or_else(|| panic!("{action}: no rule covers every resource"));
            assert!(back[cover..].iter().all(|(a, _, e)| !wildcard(a, action) || e != "allow"), "{action}: an allow after {:?}", back[cover]);
            for (_, resource) in resources(&policy) {
                assert_ne!(on(&back, action, &resource), "allow", "{action} on {resource}");
            }
        }
    }
}

/// The design's order, as v4 2.2 writes it, with no pattern folded: what the
/// rules made must decide as this does.
fn design_order(given: &Given) -> Vec<(String, String, String)> {
    let s = |p: &Path| p.to_str().unwrap().to_owned();
    let under = |p: &Path| format!("{}/*", s(p));
    let rule = |a: &str, p: String, e: &str| (a.to_owned(), p, e.to_owned());
    let (dirs, files) = (given.dirs.iter().map(|p| under(p)).collect::<Vec<_>>(), given.files.iter().map(|p| s(p)).collect::<Vec<_>>());
    let back: Vec<String> = given.outputs.iter().chain(given.temp.iter()).map(|p| under(p)).collect();
    let mut all = vec![rule("*", "*".into(), "allow"), rule("external_directory", "*".into(), "ask"),
        rule("external_directory", under(&given.data), "deny")];
    all.extend(dirs.iter().map(|d| rule("external_directory", d.clone(), "deny")));
    all.extend(back.iter().map(|b| rule("external_directory", b.clone(), "ask")));
    all.extend(dirs.iter().map(|d| rule("external_directory", d.clone(), "deny")));
    all.extend([rule("read", "*".into(), "ask"), rule("read", under(&given.data), "deny")]);
    all.extend(back.iter().map(|b| rule("read", b.clone(), "ask")));
    all.extend(dirs.iter().map(|d| rule("read", d.clone(), "deny")));
    all.extend(files.iter().map(|f| rule("read", f.clone(), "deny")));
    all.extend([rule("read", "*.env".into(), "deny"), rule("grep", "*".into(), "ask"), rule("glob", "*".into(), "ask"),
        rule("list", "*".into(), "ask"), rule("edit", "*".into(), "allow"), rule("edit", "/*".into(), "deny")]);
    if let Some(temp) = &given.temp {
        all.push(rule("edit", under(temp), "allow"));
        // Not in v4's table: a protected location under T stays denied (S3a).
        all.extend(dirs.iter().chain(files.iter()).map(|p| rule("edit", p.clone(), "deny")));
    }
    all
}

#[test]
fn protected_locations_win_over_env_example_and_every_folder_handed_back() {
    let t_in = |rest: &str| format!("{T}/{rest}");
    let cases: Vec<(&str, Given, Vec<(&str, String, &str)>)> = vec![
        ("a protected folder that is T", Given::auto().with(|g| g.dirs.push(T.into())),
            vec![("external_directory", format!("{T}/*"), "deny"), ("read", t_in("x"), "deny"), ("edit", t_in("x"), "deny"),
                ("read", format!("{O1}/x"), "ask")]),
        ("a protected folder holding T", Given::auto().with(|g| g.dirs.push(format!("{D}/t").into())),
            vec![("external_directory", format!("{T}/*"), "deny"), ("read", t_in("x"), "deny"), ("edit", t_in("x"), "deny")]),
        ("a protected folder under T", Given::auto().with(|g| g.dirs.push(t_in("keys").into())),
            vec![("external_directory", format!("{T}/*"), "ask"), ("external_directory", t_in("keys/*"), "deny"),
                ("read", t_in("keys/a"), "deny"), ("read", t_in("keys/a.env.example"), "deny"), ("edit", t_in("keys/a"), "deny"),
                ("edit", t_in("a"), "allow"), ("read", t_in("a"), "ask")]),
        ("a protected file in T", Given::auto().with(|g| g.files.push(t_in("token").into())),
            vec![("read", t_in("token"), "deny"), ("edit", t_in("token"), "deny"), ("edit", t_in("other"), "allow")]),
        ("a protected folder that is an output folder", Given::auto().with(|g| g.dirs.push(O1.into())),
            vec![("external_directory", format!("{O1}/*"), "deny"), ("read", format!("{O1}/x"), "deny"), ("read", format!("{O2}/x"), "ask")]),
        ("a protected folder that is D", Given::auto().with(|g| g.dirs.push(D.into())),
            vec![("external_directory", format!("{O1}/*"), "deny"), ("external_directory", format!("{T}/*"), "deny"),
                ("read", t_in("x"), "deny"), ("read", format!("{O2}/x"), "deny"), ("edit", t_in("x"), "deny")]),
        ("a protected location given twice", Given::auto().with(|g| { g.dirs.push(SSH.into()); g.files.push(NETRC.into()); }),
            vec![("read", format!("{SSH}/id_rsa"), "deny"), ("read", NETRC.into(), "deny")]),
        ("T is an output folder", Given::auto().with(|g| g.temp = Some(O1.into())),
            vec![("external_directory", format!("{O1}/*"), "ask"), ("edit", format!("{O1}/a"), "allow"), ("edit", format!("{O2}/a"), "deny")]),
    ];
    for (name, given, table) in cases {
        let policy = given.made();
        let back = read_back_as_made(&policy);
        for (action, resource, want) in &table {
            assert_eq!(on(&back, action, resource), *want, "{name}: {action} on {resource}");
        }
        // Folding each pattern to its last place decides as the design's order does.
        let design = design_order(&given);
        let mut probes = resources(&policy);
        probes.extend(table.iter().map(|(a, r, _)| ((*a).to_owned(), r.clone())));
        for (action, resource) in probes {
            assert_eq!(on(&back, &action, &resource), on(&design, &action, &resource), "{name}: {action} on {resource}");
        }
        // No pattern is written twice under one action, and no action twice.
        let mut keys: Vec<(&str, &str)> = back.iter().map(|(a, p, _)| (a.as_str(), p.as_str())).collect();
        let written = keys.len();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), written, "{name}: a repeated pattern");
    }
}

#[test]
fn a_sorted_map_or_a_repeated_key_would_change_what_decides() {
    // A protected folder holding T: written in its order, T is denied.
    let policy = Given::auto().with(|g| g.dirs = vec![format!("{D}/t").into()]).made();
    let resource = format!("{T}/*");
    assert_eq!(on(&read_back_as_made(&policy), "external_directory", &resource), "deny");
    // Read through serde_json's sorted map, `<D>/t/*` sorts before T's own
    // pattern, so T's ask would decide: this is why nothing here goes through one.
    let sorted: serde_json::Value = serde_json::from_str(&policy.config).unwrap();
    let sorted: Vec<(String, String, String)> = sorted["permission"]["external_directory"].as_object().unwrap().iter()
        .map(|(p, e)| ("external_directory".to_owned(), p.clone(), e.as_str().unwrap().to_owned())).collect();
    assert_eq!(on(&sorted, "external_directory", &resource), "ask");
    // The design's order written as is repeats the protected folder; JSON.parse
    // keeps it at its first place, before T, so T's ask would decide.
    let repeated = format!(r#"{{"permission":{{"external_directory":{{"*":"ask","{D}/*":"deny","{D}/t/*":"deny","{T}/*":"ask","{D}/t/*":"deny"}}}}}}"#);
    let (back, _) = read_back(&repeated);
    assert_eq!(back.len(), 4, "the repeated key is folded: {back:?}");
    assert_eq!(on(&back, "external_directory", &resource), "ask");
    // Object.entries lists an array-index key first, whatever its place.
    let (indexed, _) = read_back(r#"{"permission":{"read":{"*":"deny","7":"allow","x":"ask"}}}"#);
    assert_eq!(indexed.iter().map(|(_, p, _)| p.as_str()).collect::<Vec<_>>(), ["7", "*", "x"]);
}

#[test]
fn without_a_temporary_directory_nothing_names_one() {
    let policy = Given::auto().with(|g| g.temp = None).made();
    let t_dir = format!("{D}/t/");
    assert!(!policy.config.contains(&t_dir), "{}", policy.config);
    assert!(policy.rules.iter().all(|(_, p, _)| !p.contains(&t_dir)));
    assert!(policy.probes.iter().all(|(_, r)| !r.contains(&t_dir)), "{:?}", policy.probes);
    // T's folder is then only a part of D, and writing outside is denied everywhere.
    assert_decides(&policy, &[("external_directory", &format!("{T}/*"), "deny"), ("read", &format!("{T}/x"), "deny"),
        ("edit", &format!("{T}/x"), "deny"), ("edit", "/elsewhere/a", "deny"), ("edit", "src/main.rs", "allow"),
        ("read", &format!("{O1}/x"), "ask"), ("read", &format!("{SSH}/id_rsa"), "deny")]);
    let edits: Vec<&str> = policy.rules.iter().filter(|(a, _, _)| a == "edit").map(|(_, p, _)| p.as_str()).collect();
    assert_eq!(edits, ["*", "/*"], "no protected location needs a second deny: `/*` denies every write outside");
    let text = policy.instructions.as_deref().unwrap();
    assert!(!text.contains("TMPDIR") && !text.contains(&t_dir), "{text}");
    assert!(text.contains("you have no temporary directory of your own"), "{text}");
}

#[test]
fn the_instructions_say_the_rules_and_name_each_location() {
    let text = Given::auto().made().instructions.unwrap();
    assert!(text.starts_with("# Rules for this OpenCode executor\n\nYour permission level is Auto-approve:"), "{text}");
    for named in [D, O1, O2, T, "`$TMPDIR`", "Unable to …", "not in /tmp", "`*.env.example`", "a Job's artifacts"] {
        assert!(text.contains(named), "{named}: {text}");
    }
    assert!(text.ends_with(&format!("Protected locations:\n- `{SSH}/`, and everything in it\n- `{AWS}/`, and everything in it\n- `{NETRC}`\n")),
        "{text}");
    let bare = Given::auto().with(|g| { g.dirs.clear(); g.files.clear(); }).made().instructions.unwrap();
    assert!(!bare.contains("protected location (listed below)") && !bare.contains("Protected locations:"), "{bare}");
    assert!(Given::auto().with(|g| g.level = Some("ask")).made().instructions.is_none(), "Ask you first has none: the user decides");
}

#[test]
fn spaces_quotes_and_non_ascii_are_named_exactly() {
    let data = "/synthetic/Users/ü 用户/Library/Application Support/yuzuno \"q\" 'r'";
    let given = Given::auto().with(|g| {
        g.data = data.into();
        g.temp = Some(format!("{data}/t/a1b2c3d4").into());
        g.outputs = [format!("{data}/opencode/a1/xdg/data/opencode/shell").into(), format!("{data}/opencode/a1/xdg/data/opencode/tool-output").into()];
        g.dirs = vec!["/synthetic/Users/ü 用户/.ssh".into()];
        g.instructions = format!("{data}/opencode/a1/yuzuno-rules.md").into();
    });
    let policy = given.made();
    assert!(policy.config.contains("ü 用户") && policy.config.contains(r#"yuzuno \"q\" 'r'/*"#), "UTF-8 as is, quotes escaped: {}", policy.config);
    let (_, instructions) = read_back(&policy.config);
    assert_eq!(instructions, [format!("{data}/opencode/a1/yuzuno-rules.md")]);
    assert_decides(&policy, &[("external_directory", &format!("{data}/x/*"), "deny"), ("read", &format!("{data}/t/a1b2c3d4/x"), "ask"),
        ("edit", &format!("{data}/t/a1b2c3d4/x"), "allow"), ("read", "/synthetic/Users/ü 用户/.ssh/id_ed25519", "deny"),
        // A sibling whose name only starts like D is not D.
        ("external_directory", &format!("{data}-other/*"), "ask"), ("external_directory", &format!("{data} x/*"), "ask")]);
}

#[test]
fn a_path_the_rules_cannot_name_exactly_is_refused() {
    let refused = |given: Given, why: &str| {
        let error = given.policy().unwrap_err().to_string();
        assert!(error.contains(why), "{why}: {error}");
    };
    refused(Given::auto().with(|g| g.data = "workspace".into()), "Core's data directory \"workspace\" is not an absolute path");
    refused(Given::auto().with(|g| g.data = "/".into()), "not an absolute path below /");
    refused(Given::auto().with(|g| g.data = format!("{D}/").into()), "not canonical");
    refused(Given::auto().with(|g| g.data = "/a//b".into()), "not canonical");
    refused(Given::auto().with(|g| g.data = "/a/./b".into()), "not canonical");
    refused(Given::auto().with(|g| g.data = "/a/../b".into()), "not canonical");
    refused(Given::auto().with(|g| g.data = "/a/*/b".into()), "has '*'");
    refused(Given::auto().with(|g| g.temp = Some(format!("{D}/t/a?").into())), "The executor's temporary directory");
    refused(Given::auto().with(|g| g.dirs.push("/synthetic/home/u/a\\b".into())), "A protected folder \"/synthetic/home/u/a\\\\b\" has '\\\\'");
    refused(Given::auto().with(|g| g.files.push("/synthetic/home/u/a\nb".into())), "A protected file");
    refused(Given::auto().with(|g| g.outputs[1] = "~/.local/out".into()), "OpenCode's output folder");
    refused(Given::auto().with(|g| g.instructions = format!("{D}/rules[1].md").into()), "might take as a pattern");
    refused(Given::auto().with(|g| g.instructions = format!("{D}/rules*.md").into()), "The instructions file");
    // A folder handed back to Core may not hold D.
    refused(Given::auto().with(|g| g.temp = Some(D.into())), "would undo D's deny");
    refused(Given::auto().with(|g| g.temp = Some("/synthetic/home/u".into())), "would undo D's deny");
    refused(Given::auto().with(|g| g.outputs[0] = D.into()), "would undo D's deny");
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let odd = PathBuf::from(std::ffi::OsStr::from_bytes(b"/synthetic/\xff"));
        refused(Given::auto().with(|g| g.files.push(odd)), "is not UTF-8");
    }
    // Ask you first names no path, and another platform keeps today's rules.
    assert!(Given::auto().with(|g| { g.level = Some("ask"); g.data = "workspace".into(); }).policy().unwrap().is_some());
    assert!(Given::auto().with(|g| { g.platform = Platform::Other; g.data = r"C:\Users\u\yuzuno".into(); }).policy().unwrap().is_some());
}

#[test]
fn ask_asks_for_every_read_and_search_and_allows_no_folder() {
    let policy = Given::auto().with(|g| g.level = Some("ask")).made();
    assert_eq!(policy.config, concat!(r#"{"permission":{"*":"ask","read":"ask","grep":"ask","glob":"ask","list":"ask","question":"allow","#,
        r#""todowrite":"allow","todoread":"allow","external_directory":"ask"}}"#));
    assert_decides(&policy, &[("read", "src/main.rs", "ask"), ("read", "app/.env", "ask"), ("grep", "*", "ask"), ("glob", "*", "ask"),
        ("list", "*", "ask"), ("external_directory", &format!("{T}/*"), "ask"), ("external_directory", "/elsewhere/*", "ask"),
        ("edit", "src/main.rs", "ask"), ("shell", "cargo test", "ask"), ("question", "*", "allow"), ("todowrite", "*", "allow"),
        ("todoread", "*", "allow")]);
    // Today's Ask you first allows reading, searching and listing; this hands them to Core.
    let today = opencode_ruleset("ask");
    assert_eq!(["read", "grep", "glob", "list"].map(|a| decided(today.iter().copied(), a, "src/main.rs")), ["allow"; 4]);
}

#[test]
fn full_read_only_no_level_and_another_platform_keep_todays_rules_byte_for_byte() {
    for id in ["ask", "auto", "full", READ_ONLY] {
        for platform in [Platform::Unix, Platform::Other] {
            if platform == Platform::Unix && (id == "ask" || id == "auto") {
                continue;
            }
            let policy = Given::auto().with(|g| { g.level = Some(id); g.platform = platform; }).made();
            assert_eq!(policy.config, opencode_config(id).unwrap(), "{id} on {platform:?}");
            assert_eq!(ours(&policy), opencode_ruleset(id).iter().map(|(a, p, e)| ((*a).to_owned(), (*p).to_owned(), (*e).to_owned())).collect::<Vec<_>>());
            assert_eq!(policy.probes, owned(&PROBES), "{id} on {platform:?}: today's probes");
            assert_eq!(policy.instructions, None);
        }
    }
    // read-only, byte for byte as today (design: unchanged by YN-78).
    assert_eq!(opencode_config(READ_ONLY).unwrap(), concat!(r#"{"permission":{"*":"deny","read":{"*":"allow","*.env":"deny","*.env.*":"deny","#,
        r#""*.env.example":"allow"},"grep":"allow","glob":"allow","list":"allow","yuzuno_cleanup_inventory":"allow","#,
        r#""yuzuno_cleanup_plan_submit":"allow","yuzuno_cleanup_plan_get":"allow","yuzuno_cleanup_apply":"allow","yuzuno_task_get":"allow","#,
        r#""yuzuno_task_list":"allow","yuzuno_task_update":"allow","yuzuno_task_comment":"allow","yuzuno_task_submit_result":"allow","#,
        r#""yuzuno_task_result_get":"allow","yuzuno_brief_get":"allow","yuzuno_brief_update":"allow","yuzuno_brief_guide":"allow","#,
        r#""yuzuno_peer_read":"allow","yuzuno_peer_send":"allow","yuzuno_peers_list":"allow","yuzuno_job_get":"allow","yuzuno_job_logs":"allow","#,
        r#""yuzuno_yuzuno_guide":"allow"}}"#));
    assert_eq!(Given::auto().with(|g| g.level = None).policy().unwrap(), None, "no level: no rules, as today");
    assert_eq!(Given::auto().with(|g| g.level = Some("readonly")).policy().unwrap(), None, "not a level");
}

/// Agents as OpenCode lists them (as in permission_levels' tests): their own
/// rules, then the configuration's as read back from its text, then `after`
/// (a later configuration), then its browser denies.
fn agents_with(config: &str, after: &[(&str, &str, &str)]) -> Vec<(String, Vec<(String, String, String)>)> {
    let defaults = [("*", "*", "allow"), ("read", "*.env", "ask"), ("read", "*.env.*", "ask"), ("read", "*.env.example", "allow")];
    let own: [(&str, &[(&str, &str, &str)]); 3] = [("build", &[("question", "*", "allow")]),
        ("plan", &[("question", "*", "allow"), ("edit", "*", "deny"), ("edit", "/synthetic/home/.opencode/plan/*", "allow")]),
        ("title", &[("*", "*", "deny")])];
    let (configured, _) = read_back(config);
    let owned3 = |r: &[(&str, &str, &str)]| r.iter().map(|(a, p, e)| ((*a).to_owned(), (*p).to_owned(), (*e).to_owned())).collect::<Vec<_>>();
    own.iter().map(|(id, rules)| {
        let mut all = owned3(&defaults);
        all.extend(owned3(rules));
        all.extend(configured.iter().cloned());
        all.extend(owned3(after));
        all.extend(owned3(&[("browser", "*", "deny"), ("skill", "browser", "deny")]));
        ((*id).to_owned(), all)
    }).collect()
}

/// The first probe some agent decides unlike `policy`, as a start would refuse it.
fn refused_by_probes(policy: &Policy, after: &[(&str, &str, &str)]) -> Option<String> {
    let rules = ours(policy);
    agents_with(&policy.config, after).iter().find_map(|(id, theirs)| policy.probes.iter().find_map(|(action, resource)| {
        let (got, want) = (on(theirs, action, resource), on(&rules, action, resource));
        (got != want).then(|| format!("{id}: {action} on {resource} decides {got}, the level {want}"))
    }))
}

#[test]
fn the_probes_pass_as_written_and_catch_a_later_rule_that_undoes_any_part() {
    let variants = [Given::auto(), Given::auto().with(|g| g.temp = None), Given::auto().with(|g| g.dirs.push(format!("{D}/t").into())),
        Given::auto().with(|g| g.level = Some("ask"))];
    for given in &variants {
        let policy = given.made();
        assert_eq!(refused_by_probes(&policy, &[]), None, "{:?}", given.level);
    }
    let auto = Given::auto().made();
    let (d, o1, o2, t, ssh) = (format!("{D}/*"), format!("{O1}/*"), format!("{O2}/*"), format!("{T}/*"), format!("{SSH}/*"));
    let undone: [(&str, &str, &str); 16] = [("external_directory", "*", "allow"), ("read", "*", "allow"), ("grep", "*", "allow"),
        ("glob", "*", "allow"), ("list", "*", "allow"), ("edit", "*", "allow"), ("read", "*.env", "ask"), ("*", "*", "allow"),
        ("external_directory", &d, "ask"), ("read", &d, "ask"), ("external_directory", &o1, "allow"), ("read", &o2, "allow"),
        ("edit", &t, "deny"), ("external_directory", &t, "allow"), ("read", &ssh, "ask"), ("read", NETRC, "allow")];
    for rule in undone {
        assert!(refused_by_probes(&auto, &[rule]).is_some(), "a later {rule:?} goes unnoticed");
    }
    // A protected folder in T: its edit deny is probed too.
    let in_t = Given::auto().with(|g| g.dirs.push(format!("{T}/keys").into())).made();
    assert!(refused_by_probes(&in_t, &[("edit", &format!("{T}/keys/*"), "allow")]).is_some());
    let ask = Given::auto().with(|g| g.level = Some("ask")).made();
    for rule in [("read", "*", "allow"), ("grep", "*", "allow"), ("list", "*", "allow"), ("external_directory", "*", "allow"), ("question", "*", "deny")] {
        assert!(refused_by_probes(&ask, &[rule]).is_some(), "ask: a later {rule:?} goes unnoticed");
    }
}
