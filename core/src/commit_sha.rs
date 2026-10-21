//! Commit SHAs in tool input (T-131). Core stores and compares full SHAs
//! only. Schemas name the forms each tool takes, and a rejection says how to
//! get the full SHA.
//!
//! Where the input names its repository, an abbreviated SHA is resolved there
//! first (T-164): task materials with their repositoryId, and review_start in
//! its link's repository. Only hexadecimal abbreviations are, never a branch,
//! tag or other revision expression, and only one GitHub says is exactly one
//! commit that starts with it. The full SHA is what is saved and compared.

use crate::workspace::Workspace;
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::sync::Arc;

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

/// The rejection of `sha` given as `key` where an abbreviation would have been
/// resolved (schema_resolved), so it is neither form.
pub fn problem_resolved(key: &str, sha: &str, form: Form) -> String {
    let got = match sha.chars().count() {
        0 => "it is empty".to_owned(),
        n if sha.chars().all(|c| c.is_ascii_hexdigit()) => format!("got {n} characters"),
        n => format!("got {n} characters, not all hexadecimal"),
    };
    format!("{key} must be a full commit SHA, {}, or an abbreviation of 4 to 39 hexadecimal characters; {got}. {HOW}", form.words())
}

/// A string property for a full SHA. `purpose` comes first in its description.
pub fn schema(form: Form, nullable: bool, purpose: &str) -> Value {
    let kind = if nullable { json!(["string", "null"]) } else { json!("string") };
    json!({"type":kind,"pattern":form.pattern(),
        "description":format!("{purpose} A full commit SHA: {}. {HOW}", form.words())})
}

/// An abbreviation Core may resolve: 4 to 39 hexadecimal characters, as git
/// abbreviates a commit. Nothing else is resolved.
pub fn abbreviated(value: &str) -> bool {
    (4..40).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A string property for a full SHA or an abbreviation Core resolves `where_`.
pub fn schema_resolved(form: Form, nullable: bool, purpose: &str, where_: &str) -> Value {
    let mut value = schema(form, nullable, purpose);
    value["pattern"] = json!(match form {
        Form::GitHub => "^[0-9a-fA-F]{4,40}$",
        Form::Any => "^([0-9a-fA-F]{4,40}|[0-9a-fA-F]{64})$",
    });
    value["description"] = json!(format!(
        "{purpose} A full commit SHA ({}), or an abbreviation of 4 to 39 hexadecimal characters that is exactly \
         one commit {where_}: Core resolves it on GitHub and saves and compares the full SHA. A branch, tag or other \
         revision is not resolved. {HOW}", form.words()));
    value
}

/// The full commit SHA `short` abbreviates in `repo`, as GitHub resolves it.
/// Refused unless GitHub finds exactly one commit and its SHA starts with
/// `short`; nothing is guessed, truncated or padded.
pub async fn resolve(ws: &Workspace, repo: &str, key: &str, short: &str) -> Result<String> {
    if !abbreviated(short) {
        bail!("invalid_input: {key} {short:?} is neither a full commit SHA nor an abbreviation of 4 to 39 hexadecimal characters. {HOW}");
    }
    // Only the SHA is asked for, so a large commit's patches are never read.
    let (code, answer) = ws.github.client.commit_sha(repo, short).await
        .map_err(|error| anyhow::anyhow!("{key} {short} could not be resolved in {repo}: {error:#}; nothing was saved. {HOW}"))?;
    let sha = answer.to_ascii_lowercase();
    match code {
        200 if Form::GitHub.accepts(&sha) && sha.starts_with(&short.to_ascii_lowercase()) => Ok(sha),
        200 => bail!("invalid_input: {key} {short} is not the start of the commit {repo} gives for it; give the full SHA. {HOW}"),
        422 => bail!("invalid_input: {key} {short} is not exactly one commit of {repo}: no commit starts with it, \
            more than one object does, or it names a tree, blob or tag. Give more characters or the full SHA. {HOW}"),
        404 => bail!("invalid_input: {repo} could not be read to resolve {key} {short}; give the full SHA. {HOW}"),
        code => bail!("{key} {short} could not be resolved in {repo} (HTTP {code}: {answer}); nothing was saved. {HOW}"),
    }
}

/// A task's materials with each abbreviated baseSha or headSha replaced by the
/// full SHA, resolved in the materials' repositoryId. On a dispatch that names
/// none, the task's registered materials' repository is used, as the dispatch
/// itself would be. Without a saved repository nothing is resolved or guessed.
pub async fn resolve_materials(ws: &Arc<Workspace>, operation: &str, mut input: Value) -> Result<Value> {
    // task_update carries them in its patch; task_create and task_dispatch at the top.
    let at = if operation == "task_update" { "/patch/materials" } else { "/materials" };
    let Some(materials) = input.pointer(at).filter(|m| m.is_object()) else { return Ok(input) };
    let short: Vec<(&str, String)> = ["baseSha", "headSha"].into_iter()
        .filter_map(|key| materials[key].as_str().filter(|v| abbreviated(v)).map(|v| (key, v.to_owned())))
        .collect();
    let Some((first_key, first)) = short.first().cloned() else { return Ok(input) };
    let repository = match materials.get("repositoryId") {
        Some(id) if !id.is_null() => id.as_i64(),
        None if operation == "task_dispatch" => {
            let task = input["taskId"].as_str().unwrap_or_default().to_owned();
            ws.stored(move |s| s.registered_materials_repository(&task)).await?
        }
        _ => None,
    };
    let name = match repository {
        Some(id) => ws.stored(move |s| s.github_repository_name(id)).await?,
        None => None,
    };
    let Some(repo) = name else {
        bail!("invalid_input: {first_key} {first} is abbreviated, and Core resolves it only in the materials' \
            repositoryId, a saved repository{}. Give that repositoryId or the full SHA. {HOW}",
            repository.map_or_else(|| ", which is not given".to_owned(), |id| format!("; {id} is not one")));
    };
    for (key, value) in short {
        let full = resolve(ws, &repo, key, &value).await?;
        if let Some(materials) = input.pointer_mut(at) {
            materials[key] = json!(full);
        }
    }
    Ok(input)
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

    #[test]
    fn only_four_to_thirty_nine_hexadecimal_characters_are_an_abbreviation() {
        for short in ["e44b", "E44B942", "e635e5e", &"a".repeat(39)] {
            assert!(abbreviated(short), "{short}");
        }
        for not in ["", "e44", &"a".repeat(40), &"a".repeat(64), "main", "HEAD", "e44b~1", "v0.2.0", "e44b942^{commit}", "g44b942"] {
            assert!(!abbreviated(not), "{not}");
        }
        let schema = schema_resolved(Form::Any, true, "The base.", "of the materials' repositoryId");
        assert_eq!(schema["pattern"], "^([0-9a-fA-F]{4,40}|[0-9a-fA-F]{64})$");
        let text = schema["description"].as_str().unwrap();
        assert!(text.starts_with("The base. A full commit SHA (40 hexadecimal characters, or 64"), "{text}");
        assert!(text.contains("exactly one commit of the materials' repositoryId") && text.contains("A branch, tag or other revision is not resolved"), "{text}");
        let wrong = problem_resolved("baseSha", "e44", Form::Any);
        assert!(wrong.contains("or an abbreviation of 4 to 39 hexadecimal characters; got 3 characters.") && !wrong.contains("not resolved"), "{wrong}");
    }

    const FULL: &str = "abc1234ddddddddddddddddddddddddddddddddd";

    /// A Workspace whose GitHub is a fixture: repository 123 is o/r, where
    /// abc1234 is one commit, abcd is ambiguous (GitHub's 422), deadbee is a
    /// ref that resolves to another commit, and 1111111 meets a server error.
    fn lab(dir: &std::path::Path) -> Arc<Workspace> {
        use std::os::unix::fs::PermissionsExt;
        let program = dir.join("gh-fixture");
        std::fs::write(&program, format!(r##"#!/usr/bin/python3
import json,sys,pathlib
root=pathlib.Path(__file__).parent
ep=next(v for v in sys.argv if v.startswith('repos/'))
with (root/'requests').open('a') as f:f.write(ep+'\n')
answers={{'repos/o/r/commits/abc1234':(200,{{'sha':'{FULL}'}}),'repos/o/r/commits/ABC1234':(200,{{'sha':'{FULL}'}}),
 'repos/o/r/commits/deadbee':(200,{{'sha':'f'*40}}),'repos/o/r/commits/1111111':(503,None)}}
code,data=answers.get(ep,(422,None))
assert 'Accept: application/vnd.github.sha' in sys.argv, 'asks for the SHA only'
if code==200:print('HTTP/2.0 200 OK\r\n\r\n'+data['sha']);sys.exit(0)
print('HTTP/2.0 %d Error\r\n\r\n' % code);print('HTTP %d' % code,file=sys.stderr);sys.exit(1)
"##)).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut ws = Workspace::new(dir.join("data"), "/tmp".into(), "unused".into()).unwrap();
        Arc::get_mut(&mut ws).unwrap().github.client.program = program.to_string_lossy().into();
        ws.store.db.write().unwrap().execute("INSERT INTO github_repositories(id,data) VALUES(123,?1)",
            [json!({"id":123,"fullName":"o/r"}).to_string()]).unwrap();
        ws
    }
    fn requests(dir: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("requests")).unwrap_or_default().lines().map(str::to_owned).collect()
    }

    #[tokio::test]
    async fn task_materials_save_the_full_sha_an_abbreviation_names_in_their_repository() {
        let dir = tempfile::tempdir().unwrap();
        let ws = lab(dir.path());
        let full = "e".repeat(40);
        let created = ws.collaboration_call(None, "task_create", json!({"requestId":"c","title":"Short SHAs",
            "materials":{"repositoryId":123,"baseSha":"abc1234","headSha":full}})).await.unwrap();
        // The answer shows what was saved: the full SHA; a full one is not looked up.
        assert_eq!(created["task"]["materials"]["baseSha"], FULL);
        assert_eq!(created["task"]["materials"]["headSha"], full);
        assert_eq!(requests(dir.path()), ["repos/o/r/commits/abc1234"]);
        // A retry of the same request replays it.
        let again = ws.collaboration_call(None, "task_create", json!({"requestId":"c","title":"Short SHAs",
            "materials":{"repositoryId":123,"baseSha":"ABC1234","headSha":full}})).await.unwrap();
        assert_eq!(again["task"]["id"], created["task"]["id"]);
        let task = created["task"]["id"].as_str().unwrap().to_owned();
        let version = |ws: &Workspace| ws.store.collaboration_call(None, "task_get", json!({"taskId":task})).unwrap()["task"]["version"].clone();
        // task_update carries materials in its patch; they are resolved there too.
        let updated = ws.collaboration_call(None, "task_update", json!({"requestId":"update","taskId":task,
            "expectedVersion":version(&ws),"patch":{"materials":{"repositoryId":123,"headSha":"abc1234"}}})).await.unwrap();
        assert_eq!(updated["task"]["materials"]["headSha"], FULL, "{updated}");
        for (request, materials, says) in [
            ("ambiguous", json!({"repositoryId":123,"baseSha":"abcd"}), "is not exactly one commit of o/r"),
            ("another", json!({"repositoryId":123,"baseSha":"deadbee"}), "is not the start of the commit o/r gives for it"),
            ("server", json!({"repositoryId":123,"headSha":"1111111"}), "could not be resolved in o/r (HTTP 503"),
            ("no-repository", json!({"baseSha":"abc1234"}), "Core resolves it only in the materials' repositoryId"),
            ("unsaved", json!({"repositoryId":999,"baseSha":"abc1234"}), "; 999 is not one"),
            ("too-short", json!({"repositoryId":123,"baseSha":"abc"}), "or an abbreviation of 4 to 39 hexadecimal characters; got 3"),
            ("branch", json!({"repositoryId":123,"baseSha":"main"}), "not all hexadecimal"),
        ] {
            let before = ws.store.collaboration_call(None, "task_get", json!({"taskId":task})).unwrap();
            let asked = requests(dir.path()).len();
            let error = ws.collaboration_call(None, "task_update", json!({"requestId":request,"taskId":task,
                "expectedVersion":version(&ws),"patch":{"materials":materials}})).await.unwrap_err().to_string();
            assert!(error.contains(says) && error.contains("git rev-parse"), "{request}: {error}");
            assert_eq!(ws.store.collaboration_call(None, "task_get", json!({"taskId":task})).unwrap()["task"], before["task"], "{request}");
            // Without a saved repository or a resolvable form, GitHub is not asked.
            if ["no-repository", "unsaved", "too-short", "branch"].contains(&request) {
                assert_eq!(requests(dir.path()).len(), asked, "{request}");
            }
        }
    }

    /// A dispatch that names no repositoryId resolves in the registered one, as
    /// the dispatch itself would take it.
    #[tokio::test]
    async fn a_dispatch_resolves_in_the_registered_repository() {
        let dir = tempfile::tempdir().unwrap();
        let ws = lab(dir.path());
        ws.collaboration_call(None, "task_create", json!({"requestId":"c","title":"Dispatch",
            "materials":{"repositoryId":123}})).await.unwrap();
        let resolved = resolve_materials(&ws, "task_dispatch", json!({"taskId":"T-1","materials":{"headSha":"abc1234"}})).await.unwrap();
        assert_eq!(resolved["materials"]["headSha"], FULL);
        // An explicit null repositoryId names none: nothing is guessed.
        let error = resolve_materials(&ws, "task_dispatch", json!({"taskId":"T-1","materials":{"repositoryId":null,"headSha":"abc1234"}}))
            .await.unwrap_err().to_string();
        assert!(error.contains("which is not given"), "{error}");
    }

    /// review_start resolves in the link's repository before it looks for the
    /// round a requestId started, so a retry with the abbreviation finds it.
    #[tokio::test]
    async fn review_start_resolves_in_the_link_repository_before_a_retry_is_matched() {
        let dir = tempfile::tempdir().unwrap();
        let ws = lab(dir.path());
        let task = ws.store.collaboration_call(None, "task_create", json!({"requestId":"c","title":"Review"})).unwrap()["task"]["id"]
            .as_str().unwrap().to_owned();
        ws.store.github_link_object(&task, &crate::github::client::Repository { id: 123, full_name: "o/r".into() }, "pull", 1,
            json!({"baseSha":"b".repeat(40),"headSha":FULL})).unwrap();
        let full: crate::pr_review::Start = serde_json::from_value(json!({"requestId":"r1","taskId":task,"linkId":"123:pull:1",
            "baseSha":"b".repeat(40),"headSha":FULL})).unwrap();
        let (round, created) = ws.store.create_pr_review(None, &full, "round-1").unwrap();
        assert!(created);
        let retry = ws.collaboration_call(None, "review_start", json!({"requestId":"r1","taskId":task,"linkId":"123:pull:1",
            "baseSha":"b".repeat(40),"headSha":"abc1234"})).await.unwrap();
        assert_eq!(retry["id"], round["id"]);
        let error = ws.collaboration_call(None, "review_start", json!({"requestId":"r2","taskId":task,"linkId":"123:pull:1",
            "headSha":"abcd"})).await.unwrap_err().to_string();
        assert!(error.contains("is not exactly one commit of o/r"), "{error}");
        let error = ws.collaboration_call(None, "review_start", json!({"requestId":"r3","taskId":task,"linkId":"9:pull:1",
            "headSha":"abc1234"})).await.unwrap_err().to_string();
        assert!(error.contains("names no saved repository") && error.contains("No review was started."), "{error}");
    }
}
