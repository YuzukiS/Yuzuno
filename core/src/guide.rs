//! The Yuzuno working guide (T-131): the `yuzuno` skill, compiled into Core
//! and served by topic as the `yuzuno_guide` MCP tool. An Agent in any
//! project connected to this Core reads the guide of this Core's own release,
//! without a checkout of this repository or a skill installed anywhere.
//!
//! `.agents/skills/yuzuno/` stays the only source: each top-level section of
//! SKILL.md and each reference file is one topic (tests check every heading
//! and file has its topic). Links between them are rewritten into topic
//! pointers, since a tool answer has no files to follow.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

pub const TOOL: &str = "yuzuno_guide";

const SKILL: &str = include_str!("../../.agents/skills/yuzuno/SKILL.md");
/// The skill's reference files, as SKILL.md links them.
const REFERENCES: [(&str, &str); 4] = [
    ("jobs.md", include_str!("../../.agents/skills/yuzuno/references/jobs.md")),
    ("delivery.md", include_str!("../../.agents/skills/yuzuno/references/delivery.md")),
    ("rewind.md", include_str!("../../.agents/skills/yuzuno/references/rewind.md")),
    ("maintenance.md", include_str!("../../.agents/skills/yuzuno/references/maintenance.md")),
];

struct Topic {
    name: &'static str,
    covers: &'static str,
    /// The SKILL.md section it starts with; the overview is the text before them.
    section: Option<&'static str>,
    /// The reference file that follows it.
    reference: Option<&'static str>,
}

const TOPICS: [Topic; 9] = [
    Topic { name: "overview", covers: "What Core enforces and what this guide is for; the topics.", section: None, reference: None },
    Topic { name: "tasks", covers: "Taking a task: dispatchId, what is a task and what is execution.", section: Some("Taking a task"), reference: None },
    Topic { name: "jobs", covers: "Direct command or Job: Jobs, GPUs, pauses, checkpoint stops, remote machines, runs of stages and provenance exports.", section: Some("Direct command or Job"), reference: Some("jobs.md") },
    Topic { name: "async", covers: "Asynchronous operations: identifiers, mailbox notifications, retries with the same requestId.", section: Some("Asynchronous operations"), reference: None },
    Topic { name: "delivery", covers: "Delivering a code change: candidate, delivery flow, CI, independent review and the result.", section: Some("Delivering"), reference: Some("delivery.md") },
    Topic { name: "results", covers: "Showing a table, chart, form or task status proposal with result_publish.", section: Some("Showing a result"), reference: None },
    Topic { name: "brief", covers: "Keeping the Project Brief: capabilities, sections, layout, attachments and asks.", section: Some("Keeping the Project Brief"), reference: None },
    Topic { name: "rewind", covers: "Conversation rewind and file restore.", section: None, reference: Some("rewind.md") },
    Topic { name: "maintenance", covers: "When tools and instructions disagree, when changes reach a session, and changing this guide.", section: Some("When the tools disagree with your instructions"), reference: Some("maintenance.md") },
];

/// Told to every Agent with the Yuzuno MCP, once per session, after the
/// result notice: Claude's system prompt append, Codex's developer
/// instructions. Only a pointer; the guide itself is read on demand.
pub const NOTICE: &str = "How to work in this Yuzuno Workspace (tasks, Jobs and runs of stages, asynchronous results, delivery, \
    the Project Brief) is the yuzuno_guide tool, written for this Core's release: read its overview or one topic when you need it.";

/// The sentence the MCP server instructions carry (collaboration_mcp).
pub const INSTRUCTION: &str = "yuzuno_guide has the working guide for this Core by topic.";

const NOTE: &str = "This guide says when to use which tool and how the steps connect. Each tool's schema in your session \
    is the authority for its parameters. A tool or parameter named here but missing from your session is not available to it now.";

/// The notice each native session gets once (see NOTICE), after the result
/// notice it shares a paragraph with.
pub fn session_notice() -> &'static str {
    static TEXT: OnceLock<String> = OnceLock::new();
    TEXT.get_or_init(|| format!("{} {NOTICE}", crate::results::capability_notice()))
}

static RELEASE: OnceLock<Value> = OnceLock::new();

/// The managed release this Core runs, set once at start (main.rs); later
/// calls change nothing. Without it, Core runs from a development checkout.
/// Tested in tests/guide_release.rs, a process of its own.
pub fn set_release(release_id: &str, version: &str, git_sha: &str) {
    let _ = RELEASE.set(json!({"releaseId":release_id,"version":version,"gitSha":git_sha,"managed":true}));
}

pub(crate) fn release() -> Value {
    RELEASE.get().cloned().unwrap_or_else(|| {
        json!({"releaseId":"development","version":env!("CARGO_PKG_VERSION"),"gitSha":null,"managed":false})
    })
}

/// The SHA-256 of the guide's sources, as compiled into this Core.
pub fn revision() -> &'static str {
    static REVISION: OnceLock<String> = OnceLock::new();
    REVISION.get_or_init(|| {
        let mut digest = Sha256::new();
        for (name, text) in std::iter::once(("SKILL.md", SKILL)).chain(REFERENCES) {
            digest.update(name.as_bytes());
            digest.update([0]);
            digest.update(text.as_bytes());
            digest.update([0]);
        }
        format!("{:x}", digest.finalize())
    })
}

pub fn tool_definition() -> Value {
    let names: Vec<&str> = TOPICS.iter().map(|topic| topic.name).collect();
    json!({"name":TOOL,
        "description":"How to work in this Yuzuno Workspace, written for the connected Core's release: tasks, Jobs and runs of stages, \
            asynchronous results, delivery, results, the Project Brief, rewind and maintenance. Omit topic for the overview and the list \
            of topics. The answer names this Core's release and the guide's revision. Each tool's own schema stays the authority for its parameters.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":[],"properties":{
            "topic":{"type":"string","enum":names,"description":"One topic of the guide; omit for the overview."}}}})
}

/// The tool's answer, or what is wrong with the input.
pub fn answer(input: &Value) -> Result<Value, Value> {
    let index = || TOPICS.iter().map(|topic| json!({"topic":topic.name,"covers":topic.covers})).collect::<Vec<_>>();
    let name = match input.get("topic") {
        None | Some(Value::Null) => "overview",
        Some(Value::String(name)) => name.as_str(),
        Some(_) => return Err(json!({"error":"topic is a string; omit it for the overview.","topics":index()})),
    };
    let Some(topic) = TOPICS.iter().find(|topic| topic.name == name) else {
        let names: Vec<&str> = TOPICS.iter().map(|topic| topic.name).collect();
        return Err(json!({"error":format!("Unknown topic {name:?}. topic is one of: {}.", names.join(", ")),"topics":index()}));
    };
    let mut answer = json!({"topic":topic.name,"core":release(),"revision":revision(),"note":NOTE,"guide":text(topic)});
    if topic.name == "overview" {
        answer["topics"] = json!(index());
    }
    Ok(answer)
}

/// A topic's text: its SKILL.md part, then its reference file, links rewritten.
fn text(topic: &Topic) -> String {
    let skill = Skill::parse();
    let mut parts = vec![];
    match topic.section {
        Some(heading) => parts.push(rewrite(skill.section(heading).unwrap_or_default(), None)),
        None if topic.reference.is_none() => parts.push(rewrite(skill.intro, None)),
        None => {}
    }
    if let Some(file) = topic.reference {
        parts.push(rewrite(reference(file).unwrap_or_default(), Some(file)));
    }
    parts.join("\n\n")
}

fn reference(file: &str) -> Option<&'static str> {
    REFERENCES.iter().find(|(name, _)| *name == file).map(|(_, text)| *text)
}

/// SKILL.md without its front matter: the text before the first `## `
/// heading, then each `## ` section with its heading.
struct Skill {
    intro: &'static str,
    sections: Vec<(&'static str, &'static str)>,
}

impl Skill {
    fn parse() -> Skill {
        let body = SKILL
            .strip_prefix("---\n")
            .and_then(|rest| rest.split_once("\n---\n").map(|(_, body)| body))
            .unwrap_or(SKILL);
        let mut starts: Vec<usize> = body.match_indices("\n## ").map(|(at, _)| at + 1).collect();
        if body.starts_with("## ") {
            starts.insert(0, 0);
        }
        let intro = body[..starts.first().copied().unwrap_or(body.len())].trim();
        let sections = starts
            .iter()
            .enumerate()
            .map(|(i, &start)| {
                let end = starts.get(i + 1).copied().unwrap_or(body.len());
                let section = body[start..end].trim();
                let heading = section.lines().next().unwrap_or_default().trim_start_matches("## ").trim();
                (heading, section)
            })
            .collect();
        Skill { intro, sections }
    }

    fn section(&self, heading: &str) -> Option<&'static str> {
        self.sections.iter().find(|(name, _)| *name == heading).map(|(_, text)| *text)
    }
}

/// GitHub's anchor for a heading.
fn slug(heading: &str) -> String {
    heading
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .map(|c| if c == ' ' { '-' } else { c })
        .collect()
}

/// Headings of a source text (`#` to `####`), outside code blocks.
fn headings(text: &str) -> Vec<&str> {
    let mut fenced = false;
    text.lines()
        .filter(|line| {
            if line.trim_start().starts_with("```") {
                fenced = !fenced;
                return false;
            }
            !fenced && line.starts_with('#')
        })
        .map(|line| line.trim_start_matches('#').trim())
        .collect()
}

/// The topic a source file (None: SKILL.md) and anchor belong to, and the
/// heading the anchor names.
fn locate(file: Option<&str>, anchor: Option<&str>) -> Option<(&'static str, Option<String>)> {
    match file {
        Some(file) => {
            let topic = TOPICS.iter().find(|topic| topic.reference == Some(file))?.name;
            let Some(anchor) = anchor else { return Some((topic, None)) };
            let heading = headings(reference(file)?).into_iter().find(|heading| slug(heading) == anchor)?;
            Some((topic, Some(heading.to_owned())))
        }
        None => {
            let anchor = anchor?;
            let skill = Skill::parse();
            skill.sections.iter().find_map(|(name, text)| {
                let heading = headings(text).into_iter().find(|heading| slug(heading) == anchor)?;
                let topic = TOPICS.iter().find(|topic| topic.section == Some(*name))?.name;
                Some((topic, Some(heading.to_owned())))
            })
        }
    }
}

/// Rewrites a source's links for a tool answer. `own` is the reference file
/// the text comes from (None: SKILL.md). Links to the web stay as they are.
fn rewrite(text: &str, own: Option<&str>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let Some((label, target, after)) = link(&rest[open..]) else {
            out.push_str(&rest[..=open]);
            rest = &rest[open + 1..];
            continue;
        };
        out.push_str(&rest[..open]);
        out.push_str(&pointer(label, target, own));
        rest = after;
    }
    out.push_str(rest);
    out
}

/// `[label](target)` at the start of `text`: label, target and what follows.
fn link(text: &str) -> Option<(&str, &str, &str)> {
    let close = text.find("](")?;
    let label = &text[1..close];
    if label.contains(['[', '\n']) {
        return None;
    }
    let tail = &text[close + 2..];
    let end = tail.find(')')?;
    let target = &tail[..end];
    (!target.contains([' ', '\n'])).then_some((label, target, &tail[end + 1..]))
}

fn pointer(label: &str, target: &str, own: Option<&str>) -> String {
    if target.starts_with("https://") || target.starts_with("http://") {
        return format!("[{label}]({target})");
    }
    let (path, anchor) = match target.split_once('#') {
        Some((path, anchor)) => (path, Some(anchor)),
        None => (target, None),
    };
    // A file of the skill: SKILL.md links `references/x.md`, a reference
    // links its siblings as `x.md` and itself as `#anchor`.
    let file = match (path, own) {
        ("", own) => Ok(own),
        (path, None) => path.strip_prefix("references/").map(Some).ok_or(path),
        (path, Some(_)) if !path.contains('/') => Ok(Some(path)),
        (path, Some(_)) => Err(path),
    };
    let file = match file {
        Ok(file) => file,
        // Outside the skill: a file of the source repository.
        Err(path) => {
            let path = repository_path(path, own.is_some());
            return format!("{label} ({path} in the Yuzuno source repository)");
        }
    };
    let Some((topic, heading)) = locate(file, anchor) else {
        return label.to_owned();
    };
    let place = match heading {
        Some(heading) => format!("{TOOL} topic \"{topic}\", section \"{heading}\""),
        None => format!("{TOOL} topic \"{topic}\""),
    };
    if label.ends_with(".md") || label == target {
        place
    } else {
        format!("{label} ({place})")
    }
}

/// A relative path from SKILL.md (`.agents/skills/yuzuno/`) or a reference
/// file (`…/references/`), as a path from the repository root.
fn repository_path(path: &str, in_references: bool) -> String {
    let mut parts: Vec<&str> = if in_references {
        vec![".agents", "skills", "yuzuno", "references"]
    } else {
        vec![".agents", "skills", "yuzuno"]
    };
    for part in path.split('/') {
        match part {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            part => parts.push(part),
        }
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../.agents/skills/yuzuno");

    #[test]
    fn every_section_and_reference_of_the_skill_is_a_topic() {
        let skill = Skill::parse();
        assert!(skill.intro.starts_with("# Working in a Yuzuno Workspace"), "{}", skill.intro);
        let sections: Vec<&str> = skill.sections.iter().map(|(name, _)| *name).collect();
        let mapped: Vec<&str> = TOPICS.iter().filter_map(|topic| topic.section).collect();
        assert_eq!(sections, mapped, "each `## ` section of SKILL.md needs its topic in guide::TOPICS, in order");
        let mut files: Vec<String> = std::fs::read_dir(format!("{SOURCE}/references"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        files.sort();
        let mut compiled: Vec<String> = REFERENCES.iter().map(|(name, _)| name.to_string()).collect();
        compiled.sort();
        assert_eq!(files, compiled, "each reference file is compiled into Core");
        for (name, text) in REFERENCES {
            assert_eq!(std::fs::read_to_string(format!("{SOURCE}/references/{name}")).unwrap(), text);
            assert_eq!(TOPICS.iter().filter(|topic| topic.reference == Some(name)).count(), 1, "{name}");
        }
        assert_eq!(std::fs::read_to_string(format!("{SOURCE}/SKILL.md")).unwrap(), SKILL);
    }

    #[test]
    fn each_topic_answers_with_its_own_text_and_this_cores_identity() {
        let overview = answer(&json!({})).unwrap();
        assert_eq!(overview["topic"], "overview");
        assert_eq!(overview["core"], json!({"releaseId":"development","version":env!("CARGO_PKG_VERSION"),"gitSha":null,"managed":false}));
        assert_eq!(overview["revision"].as_str().unwrap().len(), 64);
        assert_eq!(overview["topics"].as_array().unwrap().len(), TOPICS.len());
        let guide = overview["guide"].as_str().unwrap();
        assert!(guide.starts_with("# Working in a Yuzuno Workspace") && !guide.contains("## Taking a task"), "{guide}");
        assert!(!guide.contains("name: yuzuno"), "front matter stays out");
        assert!(overview["note"].as_str().unwrap().contains("schema"));
        for (topic, starts, contains) in [
            ("tasks", "## Taking a task", "dispatchId"),
            ("jobs", "## Direct command or Job", "# Jobs"),
            ("async", "## Asynchronous operations", "Do not poll, sleep or watch."),
            ("delivery", "## Delivering", "# Delivering a code change"),
            ("results", "## Showing a result", "result_guide"),
            ("brief", "## Keeping the Project Brief", "brief_guide"),
            ("rewind", "# ", "rewind"),
            ("maintenance", "## When the tools disagree", "## When changes take effect"),
        ] {
            let answer = answer(&json!({"topic":topic})).unwrap();
            let text = answer["guide"].as_str().unwrap();
            assert_eq!(answer["topic"], topic);
            assert!(text.starts_with(starts) && text.contains(contains), "{topic}: {text}");
            assert!(answer.get("topics").is_none());
            assert_eq!(answer["revision"], overview["revision"]);
        }
        // Each SKILL.md section is in exactly one topic.
        let jobs = answer(&json!({"topic":"jobs"})).unwrap()["guide"].as_str().unwrap().to_owned();
        assert!(!jobs.contains("## Asynchronous operations") && !jobs.contains("## Taking a task"));
    }

    #[test]
    fn an_unknown_or_malformed_topic_names_the_topics() {
        for input in [json!({"topic":"Jobs"}), json!({"topic":""}), json!({"topic":"stages"})] {
            let problem = answer(&input).unwrap_err();
            let error = problem["error"].as_str().unwrap();
            assert!(error.starts_with("Unknown topic") && error.contains("overview, tasks, jobs"), "{error}");
            assert_eq!(problem["topics"].as_array().unwrap().len(), TOPICS.len());
        }
        for input in [json!({"topic":3}), json!({"topic":["jobs"]})] {
            assert!(answer(&input).unwrap_err()["error"].as_str().unwrap().starts_with("topic is a string"));
        }
        assert_eq!(answer(&json!({"topic":null})).unwrap()["topic"], "overview");
    }

    #[test]
    fn links_become_topic_pointers_and_every_anchor_resolves() {
        for topic in &TOPICS {
            let text = text(topic);
            for line in text.lines() {
                // Only web links keep markdown link syntax.
                let mut rest = line;
                while let Some(at) = rest.find("](") {
                    let target = &rest[at + 2..];
                    assert!(target.starts_with("http"), "{}: unresolved link in {line}", topic.name);
                    rest = &rest[at + 2..];
                }
            }
        }
        let tasks = answer(&json!({"topic":"tasks"})).unwrap()["guide"].as_str().unwrap().to_owned();
        assert!(tasks.contains("follow yuzuno_guide topic \"rewind\":"), "{tasks}");
        let jobs = answer(&json!({"topic":"jobs"})).unwrap()["guide"].as_str().unwrap().to_owned();
        assert!(jobs.contains("yuzuno_guide topic \"jobs\", section \"Runs of stages\""), "{jobs}");
        assert!(jobs.contains("Context window settings (yuzuno_guide topic \"maintenance\", section \"Codex context window settings\")"), "{jobs}");
        let rewind = answer(&json!({"topic":"rewind"})).unwrap()["guide"].as_str().unwrap().to_owned();
        assert!(rewind.contains("(docs/rewind.md in the Yuzuno source repository)"), "{rewind}");
        let maintenance = answer(&json!({"topic":"maintenance"})).unwrap()["guide"].as_str().unwrap().to_owned();
        assert!(maintenance.contains("When changes take effect (yuzuno_guide topic \"maintenance\", section \"When changes take effect\")"), "{maintenance}");
    }

    #[test]
    fn rewriting_handles_each_kind_of_link() {
        assert_eq!(rewrite("[a](https://x.example/b)", None), "[a](https://x.example/b)");
        assert_eq!(rewrite("see [references/jobs.md](references/jobs.md).", None), "see yuzuno_guide topic \"jobs\".");
        assert_eq!(rewrite("[x](delivery.md#ci)", Some("jobs.md")), "x (yuzuno_guide topic \"delivery\", section \"CI\")");
        assert_eq!(rewrite("[x](#gpus)", Some("jobs.md")), "x (yuzuno_guide topic \"jobs\", section \"GPUs\")");
        assert_eq!(rewrite("[x](#no-such-heading)", Some("jobs.md")), "x");
        assert_eq!(rewrite("[x](../../../../docs/a.md)", Some("rewind.md")), "x (docs/a.md in the Yuzuno source repository)");
        assert_eq!(rewrite("a [b] c and [d] (e)", None), "a [b] c and [d] (e)");
        assert_eq!(repository_path("../../../README.md", false), "README.md");
    }

    #[test]
    fn the_notices_fit_where_they_are_shown() {
        assert!(NOTICE.contains(TOOL) && INSTRUCTION.contains(TOOL));
        let limit = crate::results::max_description_length();
        assert!(tool_definition()["description"].as_str().unwrap().encode_utf16().count() <= limit);
        // The Claude bridge accepts a capability notice of at most 2000 characters.
        assert!(session_notice().chars().count() <= 2000);
        assert!(session_notice().starts_with(crate::results::capability_notice()) && session_notice().ends_with(NOTICE));
    }
}
