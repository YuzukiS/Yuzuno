//! How Core is to answer an OpenCode executor's permission request at
//! Auto-approve (YN-78 S4a; design v4 2.3.1 to 2.3.3, with the Dev Lead's
//! activity 8121): which tool call asked, and whether what it really
//! reaches is allowed.
//!
//! **Passive.** Nothing calls this yet. No event, snapshot or start feeds
//! it, no answer is sent (no `answer_permission`), and no request leaves
//! the user's queue: every level asks exactly as before. Answering for real,
//! with its delivery checks and the Auto-approve rules it goes with, is S4b;
//! Ask you first is S5.
//!
//! **Binding (2.3.1).** A request is only answered for a tool call Core can
//! name: its `source` is `{type: "tool", messageID, id}`, its session is the
//! connection's own or a sub-agent's it knows, and its connection generation
//! is still the current one. The call is found by (generation, session,
//! message, call ID) in what OpenCode itself reported on that connection
//! (`Calls`); when it isn't there, by one read of its message (`GET
//! /api/session/:s/message/:m`), with the generation the same before and
//! after. Exactly one such call, running, of a tool Core knows, whose input
//! has what that tool needs and whose tool is the request's action's (read,
//! grep, glob, or glob for list; any for `external_directory`). Anything
//! else is refused as a call Core can't name.
//!
//! **Deciding (2.3.2, 2.3.3).** From the bound call's own input, never from
//! the request's resources alone: the path OpenCode resolves (`L`), and the
//! real one (`C`). The request's resources must be what OpenCode makes of
//! that input, or the request isn't that call's. Then the first rule that
//! applies:
//! - An action other than `external_directory`, read, grep, glob or list is
//!   refused (rule 1, before any read).
//! - A write (edit, write) or a shell outside the folder is allowed only
//!   when every real target is in the executor's own temporary directory T
//!   and not protected; a patch's targets are not parsed here, so it is
//!   refused, as is image_generate (rules 3 to 5).
//! - A read, grep or glob whose real target is in the project (the Agent's
//!   folder, or its Git worktree when that isn't `/`) keeps the internal
//!   policy: a `.env` file's read is refused, the rest allowed; a search is
//!   allowed (R1, no scan) (rule 6).
//! - Outside the project, refused for a protected location, Core's data
//!   directory D outside O and T, a `.env` file, a search that reaches a
//!   protected location, D or `/`, and a grep of a folder not proven free of
//!   `.env` files within `paths::BUDGET`. A protected location is checked
//!   before any file name exception (rule 7).
//!
//! **Inputs.** D, O, T and the protected locations are given by a trusted
//! caller (`Rules`), as absolute normal paths; nothing here adds a default
//! list, derives T or reads a setting. A missing protected location still
//! counts as given; one that exists counts also as its real path. Every
//! check reads the file system as it is when it runs: a shell running in
//! the same executor can change it before OpenCode reads (design v4 7).
//!
//! **Locks and logs.** `Calls` is locked only to copy an entry; no lock is
//! held across the read or the file system. Nothing here logs; a decision
//! carries its reason's code and the paths it checked, never a message's or
//! a file's content.
#![cfg_attr(not(test), allow(dead_code))]

mod paths;
mod shell;

pub(crate) use paths::{Budget, Clock, Wall, BUDGET};

use paths::{is_env, is_normal, name, normal, parent, real, real_for_write, relative, resolve, star, within, Places, Scanned, Spend};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::Mutex;

/// A permission request as OpenCode 2.2.5 sends it (`permission.asked`'s
/// data, or an item of `GET /api/session/:s/permission`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Asked {
    pub id: String,
    pub session: String,
    pub action: String,
    /// None when it isn't a list of strings.
    pub resources: Option<Vec<String>>,
    /// The tool call it names (`source: {type: "tool", messageID, id}`).
    pub source: Option<Source>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Source {
    pub message: String,
    pub call: String,
}

impl Asked {
    /// None for something that isn't a request at all (no `id`, `sessionID`
    /// or `action`): there is nothing to answer.
    pub(crate) fn read(request: &Value) -> Option<Self> {
        let text = |key: &str| request[key].as_str().filter(|text| !text.is_empty()).map(str::to_owned);
        let resources = request["resources"].as_array()
            .and_then(|items| items.iter().map(|item| item.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>());
        let source = &request["source"];
        let source = match (source["type"].as_str(), source["messageID"].as_str(), source["id"].as_str()) {
            (Some("tool"), Some(message), Some(call)) if !message.is_empty() && !call.is_empty() =>
                Some(Source { message: message.to_owned(), call: call.to_owned() }),
            _ => None,
        };
        Some(Self { id: text("id")?, session: text("sessionID")?, action: text("action")?, resources, source })
    }
}

/// The connection a request came on: its generation, its own session, and
/// the sub-agent sessions it knows (opencode_agent.rs `Connection`).
pub(crate) struct Connection<'a> {
    pub generation: u64,
    pub session: &'a str,
    pub children: &'a [String],
}

impl Connection<'_> {
    fn owns(&self, session: &str) -> bool {
        session == self.session || self.children.iter().any(|child| child == session)
    }
}

/// The tools of 2.2.5 Core knows, by their native names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tool {
    Read,
    Grep,
    Glob,
    Edit,
    Write,
    Patch,
    Shell,
    ImageGenerate,
}

impl Tool {
    fn named(name: &str) -> Option<Self> {
        Some(match name {
            "read" => Self::Read,
            "grep" => Self::Grep,
            "glob" => Self::Glob,
            "edit" => Self::Edit,
            "write" => Self::Write,
            "patch" => Self::Patch,
            "shell" => Self::Shell,
            "image_generate" => Self::ImageGenerate,
            _ => return None,
        })
    }

    /// Whether this tool's call can ask for `action`: its own typed ask, or
    /// the folder question any tool asks.
    fn asks(self, action: &str) -> bool {
        match action {
            "external_directory" => true,
            "read" => self == Self::Read,
            "grep" => self == Self::Grep,
            "glob" | "list" => self == Self::Glob,
            _ => false,
        }
    }

    /// Whether `input` has what this tool's 2.2.5 schema requires, each as a
    /// string, and its optional strings as strings when given
    /// (core/src/tool/plugin/*.ts).
    fn complete(self, input: &Value) -> bool {
        let Some(input) = input.as_object() else { return false };
        let string = |key: &str| input.get(key).is_some_and(Value::is_string);
        let optional = |key: &str| input.get(key).is_none_or(Value::is_string);
        match self {
            Self::Read => string("path"),
            Self::Grep => string("pattern") && input["pattern"] != "" && optional("path"),
            Self::Glob => string("pattern") && optional("path"),
            Self::Edit => string("path") && string("oldString") && string("newString"),
            Self::Write => string("path") && string("content"),
            Self::Patch => string("patchText"),
            Self::Shell => string("command") && optional("workdir"),
            Self::ImageGenerate => true,
        }
    }
}

/// A tool call a request was bound to.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Call {
    pub generation: u64,
    pub session: String,
    pub message: String,
    pub call: String,
    pub tool: Tool,
    pub input: Value,
    /// Whether its message had to be read to find it.
    pub read: bool,
}

/// Why a request couldn't be bound to a tool call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Unbound {
    /// Its source isn't a tool call.
    NotATool,
    /// Its session is neither the connection's nor a known sub-agent's.
    NotThisConnection,
    /// The connection's generation changed, before or during the read.
    Stale,
    /// OpenCode has no such message (404).
    Gone,
    /// The read failed.
    Unread,
    /// Not exactly one call with that ID in the message (the count, when
    /// read), or OpenCode reported it twice differently.
    NotOne(Option<usize>),
    /// The call has completed or failed.
    Ended,
    /// Its input isn't whole yet, or lacks what its tool needs.
    Incomplete,
    /// A tool Core doesn't know.
    UnknownTool,
    /// The request's action isn't its tool's.
    Mismatch,
    /// The request names other paths than its call's input makes.
    Resources,
}

/// Why Core refuses a request: a stable code, and the sentence the model is
/// told (OpenCode passes it on only for MCP and plugin tools; its own tools
/// say `Unable to …`, design v4 2.5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Reason {
    /// Rule 1.
    Action(String),
    /// Rule 2.
    Unbound(Unbound),
    /// Rule 4.
    WriteOutside,
    PatchUnchecked,
    /// Rule 5.
    ShellOutside,
    ShellUnchecked,
    /// Rules 6 and 7.
    EnvFile,
    Protected,
    CoreData,
    Unchecked,
    SearchRoot,
    SearchScan,
    /// The trusted inputs aren't usable: nothing is answered once.
    RulesInvalid,
}

impl Reason {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Action(_) => "action_not_approvable",
            Self::Unbound(_) => "call_unidentified",
            Self::WriteOutside => "write_outside",
            Self::PatchUnchecked => "patch_unchecked",
            Self::ShellOutside => "shell_outside",
            Self::ShellUnchecked => "shell_unchecked",
            Self::EnvFile => "env_file",
            Self::Protected => "protected_location",
            Self::CoreData => "core_data",
            Self::Unchecked => "path_unchecked",
            Self::SearchRoot => "search_root",
            Self::SearchScan => "search_scan",
            Self::RulesInvalid => "rules_invalid",
        }
    }

    pub(crate) fn message(&self) -> String {
        let why = match self {
            Self::Action(action) => return format!("Yuzuno Core refused this: nobody can approve `{action}` at Auto-approve. Do it another way."),
            Self::Unbound(_) => "it couldn't tell which tool call asked",
            Self::WriteOutside => "files outside the project folder may be written only in $TMPDIR",
            Self::PatchUnchecked => "a patch outside the project folder isn't checked; use write or edit in $TMPDIR",
            Self::ShellOutside => "commands outside the project folder run only in $TMPDIR, as the working directory, with any cd to an absolute path there",
            Self::ShellUnchecked => "the command's directory changes can't be checked ($, `, \\, parentheses, braces, #, <, or a cd that isn't a command of its own); set workdir instead",
            Self::EnvFile => "reading a .env file is refused (a *.env.example file may be read)",
            Self::Protected => "this location keeps keys or credentials",
            Self::CoreData => "this is in Yuzuno Core's data directory",
            Self::Unchecked => "the path can't be checked: it doesn't exist or can't be read",
            Self::SearchRoot => "a search there reaches a protected location; search a narrower folder",
            Self::SearchScan => "the folder is too large to check or holds a .env file; search a narrower folder, or find files with glob and read them",
            Self::RulesInvalid => "its rules for this executor are incomplete",
        };
        format!("Yuzuno Core refused this: {why}.")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Answer {
    Once,
    Reject(Reason),
}

/// A path a decision checked: as OpenCode resolves it (L), and its real
/// path (C) where one could be made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub literal: String,
    pub real: Option<String>,
}

/// What Core would answer, with the call it bound and the paths it checked.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Decision {
    pub answer: Answer,
    pub call: Option<Call>,
    pub targets: Vec<Target>,
}

/// What an executor's decisions are checked against, from a trusted caller:
/// every path absolute and normal, else every request is refused.
pub(crate) struct Rules<'a> {
    /// The Agent's folder (OpenCode's `location.directory`).
    pub directory: &'a Path,
    /// Its Git worktree's top (`location.project.directory`); `/` or None for none.
    pub worktree: Option<&'a Path>,
    /// The home OpenCode expands `~` to.
    pub home: &'a Path,
    /// D, O and T, as for the static rules (permission_levels::opencode_policy).
    pub data_dir: &'a Path,
    pub outputs: [&'a Path; 2],
    pub temp: Option<&'a Path>,
    pub protected_dirs: &'a [&'a Path],
    pub protected_files: &'a [&'a Path],
}

/// Reads one stored message: `None` when OpenCode has none (404).
pub(crate) trait MessageReader {
    fn message(&self, session: &str, message: &str) -> impl Future<Output = anyhow::Result<Option<Value>>> + Send;
}

/// Rule 1: the actions nobody but Core's read-only checks can approve.
fn admissible(action: &str) -> Option<Reason> {
    (!matches!(action, "external_directory" | "read" | "grep" | "glob" | "list")).then(|| Reason::Action(action.to_owned()))
}

/// What Core would answer `asked` at Auto-approve, in design v4 2.3.2's
/// order: its action, its call, then what it reaches. The decision reads
/// the file system on this thread, within `budget`.
pub(crate) async fn answer<R: MessageReader>(asked: &Asked, on: &Connection<'_>, calls: &Calls, reader: &R,
    current: &(dyn Fn() -> bool + Sync), rules: &Rules<'_>, budget: &Budget, clock: &dyn Clock) -> Decision {
    if let Some(reason) = admissible(&asked.action) {
        return Decision { answer: Answer::Reject(reason), call: None, targets: Vec::new() };
    }
    match bind(asked, on, calls, reader, current).await {
        Err(unbound) => Decision { answer: Answer::Reject(Reason::Unbound(unbound)), call: None, targets: Vec::new() },
        Ok(call) => decide(asked, &call, rules, budget, clock),
    }
}

/// The tool call `asked` names (design v4 2.3.1), from `calls` or else one
/// read of its message. `current` says whether `on.generation` is still the
/// connection's.
pub(crate) async fn bind<R: MessageReader>(asked: &Asked, on: &Connection<'_>, calls: &Calls, reader: &R,
    current: &(dyn Fn() -> bool + Sync)) -> Result<Call, Unbound> {
    let source = asked.source.as_ref().ok_or(Unbound::NotATool)?;
    if !on.owns(&asked.session) {
        return Err(Unbound::NotThisConnection);
    }
    if !current() {
        return Err(Unbound::Stale);
    }
    let key = (asked.session.clone(), source.message.clone(), source.call.clone());
    let (seen, read) = match calls.seen(on.generation, &key) {
        Some(seen) if seen.ambiguous => return Err(Unbound::NotOne(None)),
        Some(seen) if seen.status == Status::Ended => return Err(Unbound::Ended),
        Some(seen) if seen.status == Status::Running && seen.name.is_some() && seen.input.is_some() => (seen, false),
        // Not seen, or seen only as its input started: one read.
        _ => {
            let message = reader.message(&asked.session, &source.message).await;
            if !current() {
                return Err(Unbound::Stale);
            }
            let message = message.map_err(|_| Unbound::Unread)?.ok_or(Unbound::Gone)?;
            if message["id"] != source.message.as_str() {
                return Err(Unbound::Unread);
            }
            let count = message["content"].as_array().into_iter().flatten()
                .filter(|entry| entry["type"] == "tool" && entry["id"] == source.call.as_str()).count();
            if count != 1 {
                return Err(Unbound::NotOne(Some(count)));
            }
            // Taken in as this generation's evidence: a read that contradicts what
            // OpenCode reported of the call before can't be either.
            calls.ingest_message(on.generation, &asked.session, &message);
            if calls.seen(on.generation, &key).is_some_and(|seen| seen.ambiguous) {
                return Err(Unbound::NotOne(None));
            }
            // An entry of a message that isn't an answer is no tool call.
            let Some(seen) = tools_of(&message).remove(&source.call) else { return Err(Unbound::NotOne(Some(0))) };
            match seen.status {
                Status::Ended => return Err(Unbound::Ended),
                Status::Streaming => return Err(Unbound::Incomplete),
                Status::Running if seen.ambiguous || seen.name.is_none() || seen.input.is_none() => return Err(Unbound::Incomplete),
                Status::Running => (seen, true),
            }
        }
    };
    let name = seen.name.expect("checked");
    let input = seen.input.expect("checked");
    let tool = Tool::named(&name).ok_or(Unbound::UnknownTool)?;
    if !tool.asks(&asked.action) {
        return Err(Unbound::Mismatch);
    }
    if !tool.complete(&input) {
        return Err(Unbound::Incomplete);
    }
    Ok(Call { generation: on.generation, session: key.0, message: key.1, call: key.2, tool, input, read })
}

/// What Core would answer for `asked`, bound to `call` (design v4 2.3.2
/// rules 3 to 8, and 2.3.3). Reads the file system, within `budget`.
pub(crate) fn decide(asked: &Asked, call: &Call, rules: &Rules<'_>, budget: &Budget, clock: &dyn Clock) -> Decision {
    let mut targets = Vec::new();
    let answer = match Checked::new(rules) {
        None => Answer::Reject(Reason::RulesInvalid),
        Some(checked) => checked.judge(asked, call, &mut Spend::new(budget, clock), &mut targets),
    };
    Decision { answer, call: Some(call.clone()), targets }
}

/// `Rules` checked and made real for one decision.
struct Checked {
    directory: String,
    worktree: Option<String>,
    home: String,
    /// The folder and worktree's real paths (a worktree only when neither is `/`).
    real_directory: String,
    real_worktree: Option<String>,
    temp: Option<String>,
    places: Places,
}

impl Checked {
    fn new(rules: &Rules<'_>) -> Option<Self> {
        let text = |path: &Path| path.to_str().filter(|text| is_normal(text)).map(str::to_owned);
        let given = |path: Option<&Path>| match path {
            Some(path) => text(path).map(Some),
            None => Some(None),
        };
        let directory = text(rules.directory)?;
        let worktree = given(rules.worktree)?.filter(|top| top != "/");
        let home = text(rules.home)?;
        let data = text(rules.data_dir)?;
        let outputs = rules.outputs.iter().map(|&path| text(path)).collect::<Option<Vec<_>>>()?;
        let temp = given(rules.temp)?;
        let dirs = rules.protected_dirs.iter().map(|&path| text(path)).collect::<Option<Vec<_>>>()?;
        let files = rules.protected_files.iter().map(|&path| text(path)).collect::<Option<Vec<_>>>()?;

        let real_directory = real(&directory).filter(|real| real != "/")?;
        let real_worktree = worktree.as_deref().and_then(real).filter(|real| real != "/");
        // Each as given and, when it exists, as its real path.
        let both = |paths: &[String]| paths.iter().flat_map(|path| [Some(path.clone()), real(path)]).flatten().collect::<Vec<_>>();
        let ids = dirs.iter().chain(&files).chain([&data])
            .filter_map(|path| std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))).collect();
        let real_temp = temp.as_deref().and_then(real);
        let kept = outputs.iter().filter_map(|path| real(path)).chain(real_temp.clone()).collect();
        let places = Places { dirs: both(&dirs), files: both(&files), data: both(&[data]), kept, ids };
        Some(Self { directory, worktree, home, real_directory, real_worktree, temp: real_temp, places })
    }

    /// Whether OpenCode calls normal `path` inside (file-access.ts `resolve`).
    fn inside(&self, path: &str) -> bool {
        within(path, &self.directory) || self.worktree.as_deref().is_some_and(|top| within(path, top))
    }

    /// Whether real path `c` is really in the project.
    fn really_inside(&self, c: &str) -> bool {
        within(c, &self.real_directory) || self.real_worktree.as_deref().is_some_and(|top| within(c, top))
    }

    /// Whether real path `c` may be written or worked in at Auto-approve:
    /// in T and not protected.
    fn in_temp(&self, c: &str) -> bool {
        self.temp.as_deref().is_some_and(|temp| within(c, temp)) && self.places.located(c).is_none()
    }

    fn judge(&self, asked: &Asked, call: &Call, spend: &mut Spend<'_>, targets: &mut Vec<Target>) -> Answer {
        let reject = Answer::Reject;
        let Some(resources) = asked.resources.as_deref() else { return reject(Reason::Unbound(Unbound::Resources)) };
        let input = &call.input;
        let path = |key: &str| input[key].as_str();
        match call.tool {
            // Only the folder question reaches here for these (Tool::asks).
            Tool::Patch => reject(Reason::PatchUnchecked),
            Tool::ImageGenerate => reject(Reason::WriteOutside),
            Tool::Edit | Tool::Write => {
                let Some(literal) = resolve(&self.directory, path("path").unwrap_or_default(), &self.home) else {
                    return reject(Reason::Unchecked);
                };
                if self.inside(&literal) || resources != [star(parent(&literal))] {
                    return reject(Reason::Unbound(Unbound::Resources));
                }
                let real = real_for_write(&literal);
                let allowed = real.as_deref().is_some_and(|c| self.in_temp(c));
                targets.push(Target { literal, real });
                if allowed { Answer::Once } else { reject(Reason::WriteOutside) }
            }
            Tool::Shell => self.shell(path("command").unwrap_or_default(), path("workdir").unwrap_or("."), resources, spend, targets),
            Tool::Read | Tool::Grep | Tool::Glob => self.look(asked, call, resources, spend, targets),
        }
    }

    /// Rules 3 and 5 for a shell call: its working folder and each directory
    /// it changes to must really be in T.
    fn shell(&self, command: &str, workdir: &str, resources: &[String], spend: &mut Spend<'_>, targets: &mut Vec<Target>) -> Answer {
        let reject = Answer::Reject;
        let Some(work) = resolve(&self.directory, workdir, &self.home) else { return reject(Reason::Unchecked) };
        let Some(changes) = shell::changes(command) else { return reject(Reason::ShellUnchecked) };
        // As OpenCode resolves each: against the working folder (shell.ts prepare).
        let mut literal = vec![work.clone()];
        for change in &changes {
            literal.push(match change {
                shell::Change::Absolute(path) => normal(path),
                shell::Change::Home(rest) => normal(&format!("{}/{rest}", self.home)),
                shell::Change::Relative(path) => normal(&format!("{work}/{path}")),
            });
        }
        let asked: Vec<String> = literal.iter().filter(|dir| !self.inside(dir)).map(|dir| star(dir)).collect();
        if resources.is_empty() || !resources.iter().all(|resource| asked.contains(resource)) {
            return reject(Reason::Unbound(Unbound::Resources));
        }
        // Where the shell really goes: the working folder as the kernel resolves
        // it, and each change both as `cd -L` makes it (the path normalized, then
        // made real) and as `cd -P` does (made real as written), a relative one
        // from the working folder both as given and as real.
        let real_work = real(&work);
        targets.push(Target { literal: work.clone(), real: real_work.clone() });
        let Some(real_work) = real_work else { return reject(Reason::ShellOutside) };
        let mut allowed = self.in_temp(&real_work);
        for (change, literal) in changes.iter().zip(&literal[1..]) {
            let written = match change {
                shell::Change::Absolute(path) => vec![path.clone()],
                shell::Change::Home(rest) => vec![format!("{}/{rest}", self.home)],
                shell::Change::Relative(path) => vec![format!("{work}/{path}"), format!("{real_work}/{path}")],
            };
            let candidates: Vec<String> = written.iter().flat_map(|path| [normal(path), path.clone()]).collect();
            let mut reals = Vec::new();
            for candidate in &candidates {
                if !spend.take() {
                    return reject(Reason::ShellOutside);
                }
                reals.push(real(candidate));
            }
            allowed &= reals.iter().all(|c| c.as_deref().is_some_and(|c| self.in_temp(c)));
            targets.push(Target { literal: literal.clone(), real: reals.into_iter().next().flatten() });
        }
        if allowed { Answer::Once } else { reject(Reason::ShellOutside) }
    }

    /// Rules 6 and 7 for a read, grep or glob call.
    fn look(&self, asked: &Asked, call: &Call, resources: &[String], spend: &mut Spend<'_>, targets: &mut Vec<Target>) -> Answer {
        let reject = Answer::Reject;
        let input = &call.input;
        // The path each tool resolves (read.ts, grep.ts, glob.ts): glob takes
        // "undefined" and "null" for none.
        let given = match call.tool {
            Tool::Read => input["path"].as_str(),
            Tool::Grep => input["path"].as_str().or(Some(".")),
            _ => input["path"].as_str().filter(|path| !matches!(*path, "undefined" | "null")).or(Some(".")),
        };
        let Some(literal) = given.and_then(|given| resolve(&self.directory, given, &self.home)) else { return reject(Reason::Unchecked) };
        // What OpenCode asks for this call (file-access.ts, grep.ts, glob.ts).
        let expected = if asked.action == "external_directory" {
            if self.inside(&literal) {
                return reject(Reason::Unbound(Unbound::Resources));
            }
            let folder = match (call.tool, std::fs::metadata(&literal)) {
                (Tool::Glob, _) => literal.clone(),
                (_, Ok(metadata)) if metadata.is_dir() => literal.clone(),
                (_, Ok(_)) => parent(&literal).to_owned(),
                (_, Err(error)) if error.kind() == std::io::ErrorKind::NotFound => parent(&literal).to_owned(),
                (_, Err(_)) => return reject(Reason::Unchecked),
            };
            star(&folder)
        } else if call.tool == Tool::Read {
            if self.inside(&literal) { relative(&self.directory, &literal) } else { literal.clone() }
        } else {
            input["pattern"].as_str().unwrap_or_default().to_owned()
        };
        if resources != [expected] {
            return reject(Reason::Unbound(Unbound::Resources));
        }

        let c = real(&literal);
        targets.push(Target { literal: literal.clone(), real: c.clone() });
        let Some(c) = c else { return reject(Reason::Unchecked) };
        let Ok(metadata) = std::fs::metadata(&c) else { return reject(Reason::Unchecked) };
        let env_file = !metadata.is_dir() && (is_env(name(&literal)) || is_env(name(&c)));
        if self.really_inside(&c) {
            // The internal policy: only a .env file's read is refused (R1: a search isn't scanned).
            return if call.tool == Tool::Read && env_file { reject(Reason::EnvFile) } else { Answer::Once };
        }
        if let Some(reason) = self.places.located(&c) {
            return reject(reason);
        }
        match call.tool {
            Tool::Read | Tool::Grep if env_file => reject(Reason::EnvFile),
            Tool::Read => Answer::Once,
            Tool::Grep if !metadata.is_dir() => Answer::Once,
            _ if self.places.holds(&c) => reject(Reason::SearchRoot),
            Tool::Glob => Answer::Once,
            _ => match paths::scan(&c, &self.places, spend) {
                Scanned::Clear => Answer::Once,
                Scanned::Found | Scanned::Unproven => reject(Reason::SearchScan),
            },
        }
    }
}

/// What OpenCode reported of one tool call on a connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Status {
    /// Its input is still streaming.
    Streaming,
    Running,
    /// Completed or failed.
    Ended,
}

#[derive(Clone, Debug, PartialEq)]
struct Seen {
    name: Option<String>,
    input: Option<Value>,
    status: Status,
    /// Reported in two ways that can't both be one call.
    ambiguous: bool,
}

impl Seen {
    /// Takes in a later report of the same call. Two names, two inputs or a
    /// state going back can't be one call.
    fn merge(&mut self, later: Seen) {
        let differ = |a: &Option<_>, b: &Option<_>| a.is_some() && b.is_some() && a != b;
        if later.ambiguous || differ(&self.name, &later.name) || differ(&self.input, &later.input) || later.status < self.status {
            self.ambiguous = true;
            return;
        }
        self.name = self.name.take().or(later.name);
        self.input = self.input.take().or(later.input);
        self.status = later.status;
    }

    fn size(&self) -> usize {
        self.name.as_ref().map_or(0, String::len) + self.input.as_ref().map_or(0, |input| input.to_string().len())
    }
}

/// (session, message, call ID).
type Key = (String, String, String);

/// The tool calls one connection's OpenCode reported, each by session,
/// message and call ID, as evidence a request can be bound by (design v4
/// 2.3.1). Only OpenCode's own reports of that generation go in: its tool
/// events, or a stored message. A newer generation forgets the older's.
/// What it holds stays within EVENT_BUFFER_LIMIT, the most of one event Core
/// reads, the oldest dropped first: a call no longer here is read once.
#[derive(Default)]
pub(crate) struct Calls {
    held: Mutex<Held>,
}

#[derive(Default)]
struct Held {
    generation: Option<u64>,
    calls: HashMap<Key, Seen>,
    order: VecDeque<Key>,
    bytes: usize,
}

impl Calls {
    /// Takes in a 2.x event of connection `generation`: `session.tool.*`
    /// (`sessionID`, `assistantMessageID`, `id`, and `name` or `input`).
    /// Any other event tells nothing.
    pub(crate) fn ingest_event(&self, generation: u64, event: &Value) {
        let data = &event["data"];
        let (Some(session), Some(message), Some(call)) = (data["sessionID"].as_str(), data["assistantMessageID"].as_str(), data["id"].as_str()) else {
            return;
        };
        let seen = match event["type"].as_str() {
            Some("session.tool.input.started") => Seen { name: data["name"].as_str().map(str::to_owned), input: None, status: Status::Streaming, ambiguous: false },
            Some("session.tool.called") => Seen { name: None, input: data["input"].is_object().then(|| data["input"].clone()), status: Status::Running, ambiguous: false },
            Some("session.tool.progress") => Seen { name: None, input: None, status: Status::Running, ambiguous: false },
            Some("session.tool.success" | "session.tool.failed") => Seen { name: None, input: None, status: Status::Ended, ambiguous: false },
            _ => return,
        };
        self.held.lock().unwrap().put(generation, (session.to_owned(), message.to_owned(), call.to_owned()), seen);
    }

    /// Takes in one stored message of `session` on connection `generation`
    /// (`GET …/message/:m`, or a whole read's): each of its tool entries.
    pub(crate) fn ingest_message(&self, generation: u64, session: &str, message: &Value) {
        let Some(id) = message["id"].as_str() else { return };
        let mut held = self.held.lock().unwrap();
        for (call, seen) in tools_of(message) {
            held.put(generation, (session.to_owned(), id.to_owned(), call), seen);
        }
    }

    fn seen(&self, generation: u64, key: &Key) -> Option<Seen> {
        let held = self.held.lock().unwrap();
        (held.generation == Some(generation)).then(|| held.calls.get(key).cloned()).flatten()
    }
}

impl Held {
    fn put(&mut self, generation: u64, key: Key, seen: Seen) {
        match self.generation {
            Some(current) if current > generation => return,
            Some(current) if current == generation => {}
            _ => *self = Held { generation: Some(generation), ..Held::default() },
        }
        let before = self.calls.get(&key).map_or(0, Seen::size);
        match self.calls.get_mut(&key) {
            Some(known) => known.merge(seen),
            None => {
                self.bytes += key.0.len() + key.1.len() + key.2.len();
                self.order.push_back(key.clone());
                self.calls.insert(key.clone(), seen);
            }
        }
        self.bytes = self.bytes - before + self.calls[&key].size();
        while self.bytes > crate::opencode::EVENT_BUFFER_LIMIT {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some(gone) = self.calls.remove(&oldest) {
                self.bytes -= gone.size() + oldest.0.len() + oldest.1.len() + oldest.2.len();
            }
        }
    }
}

/// Each tool entry of a stored assistant message by call ID (2.2.5
/// schema/src/session-message.ts: `content: [{type: "tool", id, name,
/// state: {status, input}}]`). A call ID twice in it is ambiguous.
fn tools_of(message: &Value) -> HashMap<String, Seen> {
    let mut found: HashMap<String, Seen> = HashMap::new();
    if message["type"] != "assistant" {
        return found;
    }
    for entry in message["content"].as_array().into_iter().flatten().filter(|entry| entry["type"] == "tool") {
        let Some(id) = entry["id"].as_str() else { continue };
        let state = &entry["state"];
        let input = state["input"].is_object().then(|| state["input"].clone());
        let (status, ambiguous) = match state["status"].as_str() {
            Some("streaming") => (Status::Streaming, false),
            Some("running") => (Status::Running, false),
            Some("completed" | "error") => (Status::Ended, false),
            _ => (Status::Running, true),
        };
        let seen = Seen { name: entry["name"].as_str().map(str::to_owned), input: if status == Status::Streaming { None } else { input }, status, ambiguous };
        match found.get_mut(id) {
            Some(twice) => twice.ambiguous = true,
            None => {
                found.insert(id.to_owned(), seen);
            }
        }
    }
    found
}

#[cfg(test)]
mod tests;
