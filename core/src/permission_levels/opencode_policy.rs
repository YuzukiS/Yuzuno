//! The rules Core gives an OpenCode executor whose permission requests Core
//! itself answers (YN-78 S3a; design v4 2.2 and 2.5, with the Dev Lead's
//! activation rule, activity 8121).
//!
//! **Who gets them.** Only a local OpenCode executor at Auto-approve on Unix
//! (opencode_auto.rs), and only together with Core's answers to its
//! requests (opencode_responder.rs), the instructions file and a start that
//! reads them back from every agent (`check`): these rules hand each read and
//! search to Core, so without its answers they would ask the user more, not
//! less. Ask you first keeps today's rules until its answerer (S5); every
//! other level starts with `opencode_config`, checked with `opencode_check`.
//!
//! What it makes on Unix (design 2.2):
//! - `auto`. Nothing statically allows a folder outside the executor's own
//!   (`external_directory`), a read, a search or a listing. Each is ask,
//!   which hands the request to Core, or deny. The order:
//!   - Core's data directory D is denied.
//!   - OpenCode's two output folders O and the executor's own temporary
//!     directory T are handed back to Core.
//!   - Each protected location is denied last. So it wins over D's
//!     exceptions and over a file name exception such as `.env.example`,
//!     which no static rule allows.
//!   - A `.env` file is denied.
//!   - Writing outside the folder is denied, except in T. OpenCode asks for
//!     the folder first, as for every tool, so T's allow is a second fence
//!     after Core's answer, not a way past it. A protected location under T
//!     stays denied.
//!   - No `doom_loop`: 2.2.5 never raises it.
//! - `ask`. Everything asks, reading, searching and listing too, except
//!   asking the user and its to-do list. No folder is allowed.
//! - `full` and `read-only`, and every level on another platform: today's
//!   rules, byte for byte, with no instructions.
//!
//! **Paths.** Every path is an input: trusted, absolute and canonical, as a
//! caller has just checked it. T in particular is given only as the
//! executor's current directory, and None when it has none. Nothing here
//! reads or writes the disk, derives T from D or from history, or adds a
//! protected location of its own. A path that OpenCode's patterns can't say
//! exactly is refused, never said more loosely:
//! - `*` and `?` are its wildcards, with no escape.
//! - A `\`, a control character, or a path that isn't absolute, canonical
//!   and UTF-8 might be read as another path.
//!
//! An absolute path is also never one OpenCode would expand (`~`, `$HOME`).
//!
//! **Order.** OpenCode reads the rules from the JSON objects in their order
//! and decides by the last that matches. A JSON object names a key once, and
//! JSON.parse keeps a repeated key at its first place. So each pattern is
//! written once, where it last appears; an earlier rule with the same pattern
//! never decides anyway.
//!
//! **Probes.** They are what a start is to check each agent decides as these
//! rules do: each part of the order, so a configuration read after Yuzuno's,
//! or an order OpenCode reads differently, is caught.

use super::{check_rules, label, opencode_config, opencode_ruleset, PROBES};
use anyhow::{bail, ensure, Result};
use std::path::Path;

const ALLOW: &str = "allow";
const ASK: &str = "ask";
const DENY: &str = "deny";

/// The platform an executor's OpenCode runs on. Only Unix gets the new rules
/// (design 2.2); another keeps today's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Platform {
    Unix,
    Other,
}

/// What an executor's rules are made from.
pub(crate) struct Inputs<'a> {
    /// Its permission level; None for an Agent with none.
    pub level: Option<&'a str>,
    pub platform: Platform,
    /// D: Core's data directory.
    pub data_dir: &'a Path,
    /// O: its OpenCode's two output folders,
    /// `<Agent folder>/xdg/data/opencode/{shell,tool-output}`.
    pub outputs: [&'a Path; 2],
    /// T: its own temporary directory, only as a trusted caller has just
    /// checked it to be its current one; None when it has none.
    pub temp: Option<&'a Path>,
    /// Protected folders and files, as given: none is added here.
    pub protected_dirs: &'a [&'a Path],
    pub protected_files: &'a [&'a Path],
    /// Where its instructions file is to be (`<Agent folder>/yuzuno-rules.md`).
    pub instructions: &'a Path,
}

/// An executor's rules, as its `opencode serve` is to get them.
#[derive(Debug, PartialEq)]
pub(crate) struct Policy {
    /// (action, resource pattern, effect), in OpenCode's order: the last that
    /// matches decides. Exactly what OpenCode reads back from `config`.
    pub rules: Vec<(String, String, &'static str)>,
    /// OPENCODE_CONFIG_CONTENT.
    pub config: String,
    /// The instructions file's text, for a level whose rules have one.
    pub instructions: Option<String>,
    /// (action, resource) pairs a start checks each agent decides as `rules` do.
    pub probes: Vec<(String, String)>,
}

/// The rules for `inputs`. None where an executor gets no rules: no level, or
/// one OpenCode doesn't keep.
pub(crate) fn policy(inputs: &Inputs<'_>) -> Result<Option<Policy>> {
    let Some(id) = inputs.level else { return Ok(None) };
    match (inputs.platform, id) {
        (Platform::Unix, "auto") => auto(inputs).map(Some),
        (Platform::Unix, "ask") => Ok(Some(ask())),
        _ => Ok(today(id)),
    }
}

/// Refuses an OpenCode server whose agents (`GET /api/agent`'s data) don't
/// decide each of `policy`'s probes as its rules alone do: a configuration
/// OpenCode reads after Yuzuno's can override them (`opencode_check`).
pub(crate) fn check(policy: &Policy, id: &str, agents: &serde_json::Value, managed: Option<&str>) -> Result<()> {
    let ours: Vec<(&str, &str, &str)> = policy.rules.iter().map(|(action, pattern, effect)| (action.as_str(), pattern.as_str(), *effect)).collect();
    ensure!(!ours.is_empty(), "No rules were made for the permission level {id}");
    check_rules(id, &ours, policy.probes.iter().map(|(action, resource)| (action.as_str(), resource.as_str())), agents, managed)
}

/// Today's rules for level `id`, unchanged.
fn today(id: &str) -> Option<Policy> {
    let config = opencode_config(id)?;
    Some(Policy {
        rules: opencode_ruleset(id).into_iter().map(|(action, pattern, effect)| (action.to_owned(), pattern.to_owned(), effect)).collect(),
        config,
        instructions: None,
        probes: PROBES.iter().map(|(action, resource)| ((*action).to_owned(), (*resource).to_owned())).collect(),
    })
}

/// One entry of OpenCode's `permission` configuration: an action's effect,
/// or its effects by resource pattern, in order.
enum Rule {
    Effect(&'static str),
    Patterns(Vec<(String, &'static str)>),
}

/// Ask you first (design 2.2): no static allow but asking the user and its to-do list.
fn ask() -> Policy {
    let rules = vec![("*", Rule::Effect(ASK)), ("read", Rule::Effect(ASK)), ("grep", Rule::Effect(ASK)), ("glob", Rule::Effect(ASK)),
        ("list", Rule::Effect(ASK)), ("question", Rule::Effect(ALLOW)), ("todowrite", Rule::Effect(ALLOW)), ("todoread", Rule::Effect(ALLOW)),
        ("external_directory", Rule::Effect(ASK))];
    let mut probes = owned(&PROBES);
    probes.extend(owned(&[("read", "/elsewhere/probe"), ("grep", "*"), ("glob", "*"), ("list", "*"), ("question", "*"), ("todowrite", "*")]));
    made(rules, None, probes)
}

/// Auto-approve (design 2.2), for paths checked by `exact`.
fn auto(inputs: &Inputs<'_>) -> Result<Policy> {
    let data = exact(inputs.data_dir, "Core's data directory")?;
    let outputs = [exact(inputs.outputs[0], "OpenCode's output folder")?, exact(inputs.outputs[1], "OpenCode's output folder")?];
    let temp = inputs.temp.map(|t| exact(t, "The executor's temporary directory")).transpose()?;
    let dirs = inputs.protected_dirs.iter().map(|p| exact(p, "A protected folder")).collect::<Result<Vec<_>>>()?;
    let files = inputs.protected_files.iter().map(|p| exact(p, "A protected file")).collect::<Result<Vec<_>>>()?;
    let instructions = exact(inputs.instructions, "The instructions file")?;
    // OpenCode may take an `instructions` entry as a pattern of file names.
    if let Some(c) = instructions.chars().find(|c| "[]{}!".contains(*c)) {
        bail!("The instructions file {instructions:?} has {c:?}, which OpenCode might take as a pattern of file names");
    }
    // A folder handed back to Core that holds D would hand back D as well.
    for folder in outputs.iter().chain(temp.iter()) {
        ensure!(!within(data, folder), "{folder:?} holds Core's data directory {data:?}, so handing it back to Core would undo D's deny");
    }

    let under = |dir: &str| format!("{dir}/*");
    // Handed back to Core after D's deny: O, then T.
    let back: Vec<(String, &'static str)> = outputs.iter().chain(temp.iter()).map(|dir| (under(dir), ASK)).collect();
    // Denied last: each protected folder, then each protected file.
    let denied_dirs: Vec<(String, &'static str)> = dirs.iter().map(|dir| (under(dir), DENY)).collect();
    let denied_files: Vec<(String, &'static str)> = files.iter().map(|file| ((*file).to_owned(), DENY)).collect();
    let first = |rules: &[(&str, &'static str)]| rules.iter().map(|(pattern, effect)| ((*pattern).to_owned(), *effect)).collect::<Vec<_>>();

    let mut outside = first(&[("*", ASK), (under(data).as_str(), DENY)]);
    outside.extend(back.iter().cloned());
    outside.extend(denied_dirs.iter().cloned());
    let mut read = first(&[("*", ASK), (under(data).as_str(), DENY)]);
    read.extend(back.iter().cloned());
    read.extend(denied_dirs.iter().cloned());
    read.extend(denied_files.iter().cloned());
    read.push(("*.env".to_owned(), DENY));
    // Inside the project folder an edit's path is relative, outside it
    // absolute: `/*` is every write outside the folder.
    let mut edit = first(&[("*", ALLOW), ("/*", DENY)]);
    if let Some(temp) = temp {
        edit.push((under(temp), ALLOW));
        edit.extend(denied_dirs.iter().cloned());
        edit.extend(denied_files.iter().cloned());
    }
    let rules = vec![("*", Rule::Effect(ALLOW)), ("external_directory", Rule::Patterns(outside)), ("read", Rule::Patterns(read)),
        ("grep", Rule::Effect(ASK)), ("glob", Rule::Effect(ASK)), ("list", Rule::Effect(ASK)), ("edit", Rule::Patterns(edit))];

    let probe = |action: &str, resource: String| (action.to_owned(), resource);
    let mut probes = owned(&PROBES);
    probes.extend(owned(&[("edit", "/elsewhere/probe"), ("read", "/elsewhere/probe"), ("read", "/elsewhere/probe.env.example"),
        ("grep", "*"), ("glob", "*"), ("list", "*")]));
    probes.extend([probe("external_directory", format!("{data}/probe/*")), probe("read", format!("{data}/probe"))]);
    for dir in outputs.iter().chain(temp.iter()) {
        probes.extend([probe("external_directory", under(dir)), probe("read", format!("{dir}/probe")), probe("read", format!("{dir}/probe.env"))]);
    }
    if let Some(temp) = temp {
        probes.push(probe("edit", format!("{temp}/probe")));
    }
    for dir in &dirs {
        probes.extend([probe("external_directory", under(dir)), probe("read", format!("{dir}/probe"))]);
        if temp.is_some() {
            probes.push(probe("edit", format!("{dir}/probe")));
        }
    }
    for file in &files {
        probes.push(probe("read", (*file).to_owned()));
        if temp.is_some() {
            probes.push(probe("edit", (*file).to_owned()));
        }
    }
    Ok(made(rules, Some((instructions, auto_instructions(data, outputs, temp, &dirs, &files))), probes))
}

/// The policy of `rules` in their order, each pattern kept once where it last
/// appears (`last_of_each`), with its instructions file and text.
fn made(rules: Vec<(&'static str, Rule)>, instructions: Option<(&str, String)>, mut probes: Vec<(String, String)>) -> Policy {
    let rules: Vec<(&str, Rule)> = rules.into_iter().map(|(action, rule)| match rule {
        Rule::Patterns(patterns) => (action, Rule::Patterns(last_of_each(patterns))),
        effect => (action, effect),
    }).collect();
    debug_assert!(rules.iter().enumerate().all(|(i, (action, _))| rules[..i].iter().all(|(other, _)| other != action)), "each action once");
    let quoted = |text: &str| serde_json::to_string(text).expect("a string is JSON");
    let entries: Vec<String> = rules.iter().map(|(action, rule)| match rule {
        Rule::Effect(effect) => format!("{}:{}", quoted(action), quoted(effect)),
        Rule::Patterns(patterns) => format!("{}:{{{}}}", quoted(action),
            patterns.iter().map(|(pattern, effect)| format!("{}:{}", quoted(pattern), quoted(effect))).collect::<Vec<_>>().join(",")),
    }).collect();
    let permission = entries.join(",");
    let config = match &instructions {
        Some((path, _)) => format!("{{\"permission\":{{{permission}}},\"instructions\":[{}]}}", quoted(path)),
        None => format!("{{\"permission\":{{{permission}}}}}"),
    };
    let flat: Vec<(String, String, &'static str)> = rules.iter().flat_map(|(action, rule)| match rule {
        Rule::Effect(effect) => vec![((*action).to_owned(), "*".to_owned(), *effect)],
        Rule::Patterns(patterns) => patterns.iter().map(|(pattern, effect)| ((*action).to_owned(), pattern.clone(), *effect)).collect(),
    }).collect();
    let mut seen = std::collections::HashSet::new();
    probes.retain(|probe| seen.insert(probe.clone()));
    Policy { rules: flat, config, instructions: instructions.map(|(_, text)| text), probes }
}

/// `patterns` with each pattern once, where it last appears. Under the last
/// matching rule an earlier one with the same pattern never decides, so no
/// decision changes.
fn last_of_each(patterns: Vec<(String, &'static str)>) -> Vec<(String, &'static str)> {
    let mut kept: Vec<(String, &'static str)> = Vec::new();
    for (pattern, effect) in patterns.into_iter().rev() {
        if !kept.iter().any(|(other, _)| *other == pattern) {
            kept.push((pattern, effect));
        }
    }
    kept.reverse();
    kept
}

fn owned(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().map(|(action, resource)| ((*action).to_owned(), (*resource).to_owned())).collect()
}

/// `path` as OpenCode's patterns can name it exactly: UTF-8, absolute, not
/// `/`, with no empty, `.` or `..` part, and no wildcard, `\` or control
/// character. `what` names it in the refusal.
fn exact<'p>(path: &'p Path, what: &str) -> Result<&'p str> {
    let Some(text) = path.to_str() else {
        bail!("{what} {} is not UTF-8, so OpenCode's rules can't name it exactly", path.display());
    };
    ensure!(text.len() > 1 && text.starts_with('/'), "{what} {text:?} is not an absolute path below /");
    ensure!(text.split('/').skip(1).all(|part| !part.is_empty() && part != "." && part != ".."),
        "{what} {text:?} is not canonical: it has an empty, . or .. part");
    if let Some(c) = text.chars().find(|c| matches!(c, '*' | '?' | '\\') || c.is_control()) {
        bail!("{what} {text:?} has {c:?}, so OpenCode's rules can't name it exactly");
    }
    Ok(text)
}

/// Whether canonical `path` is `dir` or under it.
fn within(path: &str, dir: &str) -> bool {
    path == dir || path.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
}

/// What the model is told at Auto-approve (design 2.5): OpenCode's own tools
/// tell it only `Unable to …` when a rule refuses.
fn auto_instructions(data: &str, outputs: [&str; 2], temp: Option<&str>, dirs: &[&str], files: &[&str]) -> String {
    let (level, _) = label("auto");
    let protected = !(dirs.is_empty() && files.is_empty());
    let mut text = format!("# Rules for this OpenCode executor\n\n\
        Your permission level is {level}: nobody approves your actions one by one. Yuzuno Core answers each permission request by these rules. \
        A refusal fails only that tool call, so do it another way instead of trying it again. \
        When a tool reports `Unable to …` for a path outside your project folder, these rules refused it.\n\n\
        - In your project folder you may read, write and run commands.\n\
        - Outside it you may only read, search and list. Not in Yuzuno Core's data directory, `{data}`, except the folders named here{}.\n\
        - Reading a `.env` file (`*.env`, `*.env.*`) is refused anywhere. A `*.env.example` file may be read{}.\n\
        - A search outside your project folder (grep, glob) is answered only when no protected location is under its folder and, for grep, \
        no `.env` file is. Otherwise search a narrower folder, or find files with glob and read them.\n\
        - OpenCode keeps the whole output of a long command or tool in `{}` and `{}`. You may read it there.\n",
        if protected { ", and not in a protected location (listed below)" } else { "" },
        if protected { ", but not in a protected location" } else { "" }, outputs[0], outputs[1]);
    match temp {
        Some(temp) => text.push_str(&format!("- Write files and run commands only in your project folder or in your own temporary directory, \
            `$TMPDIR` (`{temp}`), not in /tmp.\n\
            - `$TMPDIR` is scratch. Before you finish, put what should last in your project folder, a pull request, a Job's artifacts or your \
            task's result.\n")),
        None => text.push_str("- Write files and run commands only in your project folder, not in /tmp: you have no temporary directory of your own.\n"),
    }
    if protected {
        text.push_str("\nProtected locations:\n");
        for dir in dirs {
            text.push_str(&format!("- `{dir}/`, and everything in it\n"));
        }
        for file in files {
            text.push_str(&format!("- `{file}`\n"));
        }
    }
    text
}

#[cfg(test)]
mod tests;
