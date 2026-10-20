//! Commit SHAs in tool input (T-131). Core stores and compares full SHAs
//! only, and never resolves an abbreviated one: it cannot know which checkout
//! or repository an Agent means. Schemas name the forms each tool takes, and
//! a rejection says how to get the full SHA.

use serde_json::{json, Value};

/// Where an Agent gets a full SHA.
pub const HOW: &str = "Get it with `git rev-parse <commit>` in a checkout of that repository, \
    or read a linked PR's full headSha and baseSha with github_links (github_refresh updates them).";

/// The forms a tool takes.
#[derive(Clone, Copy)]
pub enum Form {
    /// 40 hexadecimal characters, as GitHub shows a commit.
    GitHub,
    /// 40 hexadecimal characters, or 64 for a SHA-256 repository.
    Any,
}

impl Form {
    fn words(self) -> &'static str {
        match self {
            Form::GitHub => "40 hexadecimal characters, as GitHub shows it",
            Form::Any => "40 hexadecimal characters, or 64 in a SHA-256 repository",
        }
    }

    fn pattern(self) -> &'static str {
        match self {
            Form::GitHub => "^[0-9a-fA-F]{40}$",
            Form::Any => "^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$",
        }
    }

    pub fn accepts(self, sha: &str) -> bool {
        let lengths: &[usize] = match self {
            Form::GitHub => &[40],
            Form::Any => &[40, 64],
        };
        lengths.contains(&sha.len()) && sha.bytes().all(|b| b.is_ascii_hexdigit())
    }
}

/// The rejection of `sha` given as `key`.
pub fn problem(key: &str, sha: &str, form: Form) -> String {
    let got = match sha.chars().count() {
        0 => "it is empty".to_owned(),
        n if sha.chars().all(|c| c.is_ascii_hexdigit()) => format!("got {n} characters"),
        n => format!("got {n} characters, not all hexadecimal"),
    };
    format!("{key} must be a full commit SHA, {}; {got}. Abbreviated SHAs are not resolved. {HOW}", form.words())
}

/// A string property for a full SHA. `purpose` comes first in its description.
pub fn schema(form: Form, nullable: bool, purpose: &str) -> Value {
    let kind = if nullable { json!(["string", "null"]) } else { json!("string") };
    json!({"type":kind,"pattern":form.pattern(),
        "description":format!("{purpose} A full commit SHA: {}. {HOW}", form.words())})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_form_takes_only_full_shas_and_a_rejection_says_how_to_get_one() {
        let (sha1, sha256) = ("a".repeat(40), "b".repeat(64));
        assert!(Form::GitHub.accepts(&sha1) && Form::GitHub.accepts(&sha1.to_uppercase()));
        assert!(!Form::GitHub.accepts(&sha256));
        assert!(Form::Any.accepts(&sha1) && Form::Any.accepts(&sha256));
        for wrong in ["", "e635e5e", &"a".repeat(39), &"a".repeat(41), &"g".repeat(40), &"a".repeat(63)] {
            assert!(!Form::GitHub.accepts(wrong) && !Form::Any.accepts(wrong), "{wrong}");
        }
        let short = problem("baseSha", "e635e5e", Form::GitHub);
        assert!(short.starts_with("baseSha must be a full commit SHA, 40 hexadecimal characters"), "{short}");
        assert!(short.contains("got 7 characters.") && short.contains("git rev-parse") && short.contains("github_links"), "{short}");
        assert!(problem("headSha", "main", Form::Any).contains("got 4 characters, not all hexadecimal"));
        assert!(problem("headSha", "", Form::Any).contains("it is empty"));
        let schema = schema(Form::Any, true, "The base.");
        assert_eq!(schema["type"], json!(["string", "null"]));
        let pattern = schema["pattern"].as_str().unwrap();
        assert_eq!(pattern, "^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$");
        assert!(schema["description"].as_str().unwrap().starts_with("The base. A full commit SHA: 40 hexadecimal characters, or 64"));
    }
}
