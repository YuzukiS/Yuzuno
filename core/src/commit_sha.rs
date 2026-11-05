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

/// A string property for a task materials' baseSha or headSha (T-164, T-31),
/// every one of which Core asks GitHub about.
pub fn schema_materials(purpose: &str) -> Value {
    let mut value = schema_resolved(Form::Any, true, purpose, "");
    value["description"] = json!(format!(
        "{purpose} A full commit SHA ({}), or an abbreviation of 4 to 39 hexadecimal characters, of a commit in the \
         materials' repositoryId (on task_dispatch without one, the registered materials'). Core asks GitHub there: an \
         abbreviation must be exactly one commit and is saved as its full SHA, and a full SHA must be a commit there; one \
         GitHub says is not is refused. When GitHub cannot answer, an abbreviation is refused and a full SHA is saved, the \
         receipt's shaCheck saying it is unverified and why, and each dispatch asks again. A branch, tag or other revision \
         is not resolved. {HOW}", Form::Any.words()));
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

/// What GitHub says of the full SHA `sha`, given as `key`, in `repo` (T-31),
/// as a materials shaCheck entry: verified when it is a commit there, and
/// unverified, with why, when GitHub could not answer. Refused when GitHub
/// says no commit has it, so nothing is saved.
pub async fn check(ws: &Workspace, repo: &str, repository: i64, key: &str, sha: &str) -> Result<Value> {
    let at = crate::model::now();
    let unverified = |reason: String| -> Result<Value> {
        Ok(json!({"state":"unverified","repositoryId":repository,"at":at,"reason":clip(&reason)}))
    };
    // Only the SHA is asked for, as for an abbreviation.
    let (code, answer) = match ws.github.client.commit_sha(repo, sha).await {
        Ok(answer) => answer,
        Err(error) => return unverified(format!("GitHub could not be asked about {repo}: {error:#}")),
    };
    match code {
        200 if answer.trim().eq_ignore_ascii_case(sha) => Ok(json!({"state":"verified","repositoryId":repository,"at":at})),
        200 => bail!("invalid_input: {key} {sha} is not the commit {repo} gives for it; give that commit's full SHA. {HOW}"),
        422 => bail!("invalid_input: {key} {sha} is not a commit of {repo}: GitHub has no commit with that SHA. Nothing was saved. {HOW}"),
        404 => unverified(format!("GitHub could not read {repo} (HTTP 404): it is missing, renamed, or not readable with this Core's GitHub sign-in")),
        code => unverified(format!("GitHub answered HTTP {code}: {answer}")),
    }
}

/// The most bytes a shaCheck reason takes, as the store checks its shape.
pub const REASON_BYTES: usize = 1_024;

/// A reason short enough to save beside the SHA: at most REASON_BYTES bytes,
/// cut at a character boundary, so that no text GitHub or gh gives can make
/// the entry one the store refuses.
fn clip(reason: &str) -> String {
    let mut end = reason.len().min(REASON_BYTES);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    reason[..end].to_owned()
}

/// Whether the registered materials say `key` was verified in `repository`.
fn verified_in(registered: &Value, key: &str, repository: Option<i64>) -> bool {
    let entry = &registered["shaCheck"][key];
    entry["state"] == "verified" && entry["repositoryId"].as_i64().is_some_and(|id| Some(id) == repository)
}

/// A task's materials as Core saves them (T-164, T-31): each abbreviated
/// baseSha or headSha becomes the full SHA it names, and each full one is
/// asked of GitHub, in the materials' repositoryId; on a dispatch that names
/// none, the registered materials', as the dispatch itself takes it. What
/// GitHub said goes to the store as `shaCheck` beside the input, never from
/// the caller. A dispatch asks again of a registered SHA not verified in that
/// repository. Without a saved repository nothing is resolved or asked. A
/// retry of a call already answered asks nothing: the store replays it.
pub async fn resolve_materials(ws: &Arc<Workspace>, actor: Option<&str>, operation: &str, mut input: Value) -> Result<Value> {
    // task_update carries them in its patch; task_create and task_dispatch at the top.
    let at = if operation == "task_update" { "/patch/materials" } else { "/materials" };
    // Only Core says what GitHub answered.
    if let Some(object) = input.as_object_mut() {
        object.remove("shaCheck");
    }
    if let Some(given) = input.pointer_mut(at).and_then(Value::as_object_mut) {
        given.remove("shaCheck");
    }
    // A retry of a call Core already answered replays that answer (review
    // b58a5ca1): nothing is asked of GitHub, so what it says now cannot turn a
    // saved receipt into a refusal. An abbreviation the first call resolved
    // takes the full SHA that call saved, so the store finds the same request.
    if let Some(request) = input["requestId"].as_str().map(str::to_owned) {
        let (actor, call) = (actor.map(str::to_owned), operation.to_owned());
        if let Some(first) = ws.stored(move |s| s.answered_input(actor.as_deref(), &call, &request)).await? {
            if let (Some(saved), Some(given)) = (first.pointer(at), input.pointer_mut(at).and_then(Value::as_object_mut)) {
                for key in ["baseSha", "headSha"] {
                    let full = saved[key].as_str().filter(|full| {
                        given.get(key).and_then(Value::as_str).is_some_and(|short| {
                            abbreviated(short) && full.to_ascii_lowercase().starts_with(&short.to_ascii_lowercase())
                        })
                    });
                    if let Some(full) = full {
                        given.insert(key.into(), json!(full));
                    }
                }
            }
            return Ok(input);
        }
    }
    let given = input.pointer(at).cloned();
    let registered = if operation == "task_dispatch" && !given.as_ref().is_some_and(Value::is_null) {
        let task = input["taskId"].as_str().unwrap_or_default().to_owned();
        ws.stored(move |s| s.registered_materials(&task)).await?
    } else {
        Value::Null
    };
    // The SHAs the call leaves the materials with, and whether the caller gave each.
    let mut shas: Vec<(&str, String, bool)> = Vec::new();
    for key in ["baseSha", "headSha"] {
        match given.as_ref().filter(|g| g.get(key).is_some()) {
            Some(g) => shas.extend(g[key].as_str().map(|v| (key, v.to_owned(), true))),
            None => shas.extend(registered[key].as_str().map(|v| (key, v.to_owned(), false))),
        }
    }
    let repository = match given.as_ref().and_then(|g| g.get("repositoryId")) {
        Some(id) => id.as_i64(),
        None => registered["repositoryId"].as_i64(),
    };
    let asks = |key: &str, value: &str, given: bool| {
        (given && abbreviated(value)) || (Form::Any.accepts(value) && (given || !verified_in(&registered, key, repository)))
    };
    if !shas.iter().any(|(key, value, given)| asks(key, value, *given)) {
        return Ok(input);
    }
    let name = match repository {
        Some(id) => ws.stored(move |s| s.github_repository_name(id)).await?,
        None => None,
    };
    let (Some(repo), Some(repository)) = (name, repository) else {
        if let Some((key, value, _)) = shas.iter().find(|(_, value, given)| *given && abbreviated(value)) {
            bail!("invalid_input: {key} {value} is abbreviated, and Core resolves it only in the materials' \
                repositoryId, a saved repository{}. Give that repositoryId or the full SHA. {HOW}",
                repository.map_or_else(|| ", which is not given".to_owned(), |id| format!("; {id} is not one")));
        }
        // A full SHA without a saved repository: the store says what is missing.
        return Ok(input);
    };
    let mut checked = serde_json::Map::new();
    for (key, value, given) in shas {
        if !asks(key, &value, given) {
            continue;
        }
        let entry = if abbreviated(&value) {
            let full = resolve(ws, &repo, key, &value).await?;
            if let Some(materials) = input.pointer_mut(at) {
                materials[key] = json!(full);
            }
            json!({"state":"verified","repositoryId":repository,"at":crate::model::now()})
        } else {
            check(ws, &repo, repository, key, &value).await?
        };
        checked.insert(key.into(), entry);
    }
    input["shaCheck"] = Value::Object(checked);
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
    /// Of full SHAs there, FULL and e…e are commits, c…c is rate limited, 9…9
    /// gets no answer at all, 5…5 meets a server error until `up` says it is
    /// a commit or `gone` says it is not, and any other is no commit (422).
    /// Repository 124 is o/private, which GitHub does not show (404), as it
    /// does not any repository whose name is not ASCII.
    fn lab(dir: &std::path::Path) -> Arc<Workspace> {
        use std::os::unix::fs::PermissionsExt;
        let program = dir.join("gh-fixture");
        std::fs::write(&program, format!(r##"#!/usr/bin/python3
import sys,pathlib
root=pathlib.Path(__file__).parent
ep=next(v for v in sys.argv if v.startswith('repos/'))
with (root/'requests').open('a',encoding='utf-8',errors='surrogateescape') as f:f.write(ep+'\n')
c='repos/o/r/commits/'
five=(200,'5'*40) if (root/'up').exists() else (422,None) if (root/'gone').exists() else (503,None)
answers={{c+'abc1234':(200,'{FULL}'),c+'ABC1234':(200,'{FULL}'),c+'deadbee':(200,'f'*40),c+'1111111':(503,None),
 c+'{FULL}':(200,'{FULL}'),c+'e'*40:(200,'e'*40),c+'c'*40:(403,None),c+'5'*40:five}}
assert 'Accept: application/vnd.github.sha' in sys.argv, 'asks for the SHA only'
if ep==c+'9'*40:sys.exit(1)
code,data=(404,None) if ep.startswith('repos/o/private/') or not ep.isascii() else answers.get(ep,(422,None))
if code==200:print('HTTP/2.0 200 OK\r\n\r\n'+data);sys.exit(0)
print('HTTP/2.0 %d Error\r\n\r\n' % code);print('HTTP %d' % code,file=sys.stderr);sys.exit(1)
"##)).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut ws = Workspace::new(dir.join("data"), "/tmp".into(), "unused".into()).unwrap();
        Arc::get_mut(&mut ws).unwrap().github.client.program = program.to_string_lossy().into();
        for (id, name) in [(123, "o/r"), (124, "o/private")] {
            ws.store.db.write().unwrap().execute("INSERT INTO github_repositories(id,data) VALUES(?1,?2)",
                rusqlite::params![id, json!({"id":id,"fullName":name}).to_string()]).unwrap();
        }
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
        // Explicit SHAs need their repository linked to the task or its Project (T-29).
        let project = ws.store.create_project("Short SHAs", Default::default()).unwrap().id;
        ws.store.github_link_repo(&project, &crate::github::client::Repository { id: 123, full_name: "o/r".into() }).unwrap();
        let created = ws.collaboration_call(None, "task_create", json!({"requestId":"c","title":"Short SHAs","projectId":project,
            "materials":{"repositoryId":123,"baseSha":"abc1234","headSha":full}})).await.unwrap();
        // The answer shows what was saved: the full SHA, and a full one asked of GitHub too (T-31).
        assert_eq!(created["task"]["materials"]["baseSha"], FULL);
        assert_eq!(created["task"]["materials"]["headSha"], full);
        assert_eq!(requests(dir.path()), ["repos/o/r/commits/abc1234".to_owned(), format!("repos/o/r/commits/{full}")]);
        assert_eq!((created["shaCheck"]["baseSha"]["state"].as_str(), created["shaCheck"]["headSha"]["state"].as_str()),
            (Some("verified"), Some("verified")), "{created}");
        // A retry of the same request replays it.
        let again = ws.collaboration_call(None, "task_create", json!({"requestId":"c","title":"Short SHAs","projectId":project,
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
        let resolved = resolve_materials(&ws, None, "task_dispatch", json!({"taskId":"T-1","materials":{"headSha":"abc1234"}})).await.unwrap();
        assert_eq!(resolved["materials"]["headSha"], FULL);
        // An explicit null repositoryId names none: nothing is guessed.
        let error = resolve_materials(&ws, None, "task_dispatch", json!({"taskId":"T-1","materials":{"repositoryId":null,"headSha":"abc1234"}}))
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

    /// A Project linking o/r and o/private, an Agent to dispatch to, and a
    /// task_create call in that Project with these materials.
    async fn project(ws: &Arc<Workspace>) -> String {
        let project = ws.store.create_project("Full SHAs", Default::default()).unwrap().id;
        for (id, name) in [(123, "o/r"), (124, "o/private")] {
            ws.store.github_link_repo(&project, &crate::github::client::Repository { id, full_name: name.into() }).unwrap();
        }
        let agent: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{"id":"dev","name":"Dev","cwd":"/tmp",
            "model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,
            "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&agent).unwrap();
        project
    }
    async fn create(ws: &Arc<Workspace>, project: &str, request: &str, materials: Value) -> Result<Value> {
        ws.collaboration_call(None, "task_create", json!({"requestId":request,"title":"Full SHAs","projectId":project,"materials":materials})).await
    }

    /// T-31: a full SHA is asked of GitHub in the materials' repository, as an
    /// abbreviation is. A commit there is saved verified; one GitHub says is not
    /// there is refused; one GitHub cannot answer for is saved unverified, with
    /// why. The receipt says which.
    #[tokio::test]
    async fn a_full_sha_is_asked_of_github_and_saved_with_what_it_said() {
        let dir = tempfile::tempdir().unwrap();
        let ws = lab(dir.path());
        let project = project(&ws).await;
        let found = create(&ws, &project, "found", json!({"repositoryId":123,"baseSha":FULL,"headSha":"e".repeat(40)})).await.unwrap();
        for key in ["baseSha", "headSha"] {
            let entry = &found["shaCheck"][key];
            assert_eq!((entry["state"].as_str(), entry["repositoryId"].as_i64()), (Some("verified"), Some(123)), "{found}");
            assert!(entry["at"].as_str().is_some() && entry.get("reason").is_none(), "{entry}");
            assert_eq!(&found["task"]["materials"]["shaCheck"][key], entry, "the registration keeps what the receipt says");
        }
        assert_eq!(requests(dir.path()), [format!("repos/o/r/commits/{FULL}"), format!("repos/o/r/commits/{}", "e".repeat(40))]);

        let tasks = |ws: &Workspace| ws.store.collaboration_call(None, "task_list", json!({})).unwrap()["tasks"].as_array().unwrap().len();
        let count = tasks(&ws);
        let missing = "0".repeat(40);
        let error = create(&ws, &project, "missing", json!({"repositoryId":123,"headSha":missing})).await.unwrap_err().to_string();
        assert!(error.starts_with(&format!("invalid_input: headSha {missing} is not a commit of o/r: GitHub has no commit with that SHA. Nothing was saved.")), "{error}");
        assert!(error.contains("git rev-parse"), "{error}");
        assert_eq!(tasks(&ws), count, "a refused create makes no task");

        for (request, repository, sha, says) in [
            ("down", 123, "5".repeat(40), "GitHub answered HTTP 503"),
            ("limited", 123, "c".repeat(40), "GitHub answered HTTP 403"),
            ("no-answer", 123, "9".repeat(40), "GitHub could not be asked about o/r: "),
            ("unreadable", 124, "a".repeat(40), "GitHub could not read o/private (HTTP 404)"),
        ] {
            let saved = create(&ws, &project, request, json!({"repositoryId":repository,"baseSha":sha})).await.unwrap();
            let entry = &saved["shaCheck"]["baseSha"];
            assert_eq!((entry["state"].as_str(), entry["repositoryId"].as_i64()), (Some("unverified"), Some(repository)), "{request}: {saved}");
            assert!(entry["reason"].as_str().unwrap().starts_with(says), "{request}: {entry}");
            assert_eq!(saved["task"]["materials"]["baseSha"], sha, "{request}: saved as given");
        }

        // task_update asks too, and an update that names no SHA asks nothing.
        let task = found["task"]["id"].as_str().unwrap().to_owned();
        let version = |ws: &Workspace| ws.store.collaboration_call(None, "task_get", json!({"taskId":task})).unwrap()["task"]["version"].clone();
        let error = ws.collaboration_call(None, "task_update", json!({"requestId":"update-missing","taskId":task,"expectedVersion":version(&ws),
            "patch":{"materials":{"repositoryId":123,"baseSha":missing}}})).await.unwrap_err().to_string();
        assert!(error.contains("is not a commit of o/r"), "{error}");
        let asked = requests(dir.path()).len();
        let titled = ws.collaboration_call(None, "task_update", json!({"requestId":"title","taskId":task,"expectedVersion":version(&ws),
            "patch":{"title":"Renamed"}})).await.unwrap();
        assert!(titled.get("shaCheck").is_none(), "{titled}");
        assert_eq!(requests(dir.path()).len(), asked);
        // A full SHA without a repositoryId asks nothing; the store says what is missing.
        let error = create(&ws, &project, "no-repository", json!({"headSha":FULL})).await.unwrap_err().to_string();
        assert!(error.contains("requires an explicit repositoryId"), "{error}");
        assert_eq!(requests(dir.path()).len(), asked);
    }

    /// Only Core says what GitHub answered, and a requestId retry replays the
    /// first answer without asking GitHub again.
    #[tokio::test]
    async fn a_caller_cannot_say_what_github_answered_and_a_retry_replays() {
        let dir = tempfile::tempdir().unwrap();
        let ws = lab(dir.path());
        let project = project(&ws).await;
        let forged = json!({"baseSha":{"state":"verified","repositoryId":123,"at":"2020-01-01T00:00:00Z"}});
        let input = json!({"requestId":"forged","title":"Forged","projectId":project,"shaCheck":forged,
            "materials":{"repositoryId":123,"baseSha":"5".repeat(40),"shaCheck":forged}});
        let saved = ws.collaboration_call(None, "task_create", input.clone()).await.unwrap();
        assert_eq!(saved["shaCheck"]["baseSha"]["state"], "unverified", "{saved}");
        assert_eq!(saved["task"]["materials"]["shaCheck"]["baseSha"]["state"], "unverified");
        let again = ws.collaboration_call(None, "task_create", input).await.unwrap();
        assert_eq!((&again["task"]["id"], &again["shaCheck"]), (&saved["task"]["id"], &saved["shaCheck"]), "the first answer, replayed");
        assert_eq!(requests(dir.path()).len(), 1, "the retry asked GitHub nothing");
    }

    /// A dispatch asks again of a registered SHA GitHub has not yet confirmed
    /// in that repository: found, it is verified in the frozen materials; not
    /// there, the dispatch is refused; still unanswered, it goes ahead and says
    /// so. A verified one is not asked again.
    #[tokio::test]
    async fn a_dispatch_asks_again_of_a_registered_sha_not_yet_found() {
        let dir = tempfile::tempdir().unwrap();
        let ws = lab(dir.path());
        let project = project(&ws).await;
        let five = "5".repeat(40);
        let task = create(&ws, &project, "down", json!({"repositoryId":123,"headSha":five})).await.unwrap()["task"]["id"]
            .as_str().unwrap().to_owned();
        let dispatch = |request: &str| {
            let version = ws.store.collaboration_call(None, "task_get", json!({"taskId":task})).unwrap()["task"]["version"].clone();
            ws.collaboration_call(None, "task_dispatch", json!({"requestId":request,"taskId":task,"expectedVersion":version,"toAgentId":"dev"}))
        };
        let asked = || requests(dir.path()).iter().filter(|r| r.ends_with(&five)).count();
        assert_eq!(asked(), 1);
        let still = dispatch("still-down").await.unwrap();
        assert_eq!(still["shaCheck"]["headSha"]["state"], "unverified", "{still}");
        assert!(still["message"]["body"].as_str().unwrap().contains(&format!("Explicit head SHA: {five} (not checked on GitHub: GitHub answered HTTP 503")),
            "{}", still["message"]["body"]);
        assert_eq!(asked(), 2);
        std::fs::write(dir.path().join("up"), "").unwrap();
        let found = dispatch("found").await.unwrap();
        assert_eq!(found["shaCheck"]["headSha"]["state"], "verified", "{found}");
        assert!(found["message"]["body"].as_str().unwrap().contains(&format!("Explicit head SHA: {five} (found on GitHub at ")));
        assert_eq!(asked(), 3);
        std::fs::remove_file(dir.path().join("up")).unwrap();
        std::fs::write(dir.path().join("gone"), "").unwrap();
        let before = ws.store.collaboration_call(None, "task_get", json!({"taskId":task})).unwrap();
        let error = dispatch("gone").await.unwrap_err().to_string();
        assert!(error.contains(&format!("headSha {five} is not a commit of o/r")), "{error}");
        assert_eq!(ws.store.collaboration_call(None, "task_get", json!({"taskId":task})).unwrap()["task"], before["task"], "nothing was dispatched");

        // Registered verified: a dispatch asks nothing and keeps what it said.
        let verified = create(&ws, &project, "verified", json!({"repositoryId":123,"headSha":FULL})).await.unwrap();
        let (id, registered) = (verified["task"]["id"].as_str().unwrap().to_owned(), verified["shaCheck"]["headSha"].clone());
        let total = requests(dir.path()).len();
        let version = ws.store.collaboration_call(None, "task_get", json!({"taskId":id})).unwrap()["task"]["version"].clone();
        let sent = ws.collaboration_call(None, "task_dispatch", json!({"requestId":"v","taskId":id,"expectedVersion":version,"toAgentId":"dev"})).await.unwrap();
        assert_eq!(sent["shaCheck"]["headSha"], registered);
        assert_eq!(requests(dir.path()).len(), total);
    }

    #[test]
    fn the_materials_schema_says_every_sha_is_asked_of_github() {
        let text = schema_materials("The base.")["description"].as_str().unwrap().to_owned();
        assert!(text.starts_with("The base. A full commit SHA (40 hexadecimal characters, or 64 in a SHA-256 repository)"), "{text}");
        for words in ["a full SHA must be a commit there", "is refused", "shaCheck saying it is unverified and why",
            "each dispatch asks again", "A branch, tag or other revision is not resolved", "git rev-parse"] {
            assert!(text.contains(words), "{words}: {text}");
        }
    }

    /// Dispatches `task` to dev as it is now.
    async fn dispatch(ws: &Arc<Workspace>, request: &str, task: &str) -> Result<Value> {
        let version = ws.store.collaboration_call(None, "task_get", json!({"taskId":task})).unwrap()["task"]["version"].clone();
        ws.collaboration_call(None, "task_dispatch", json!({"requestId":request,"taskId":task,"expectedVersion":version,"toAgentId":"dev"})).await
    }

    /// R1 b19659c2: the check Core attaches does not count toward the 32768
    /// bytes a registration may take, so materials at the limit still dispatch.
    #[tokio::test]
    async fn a_check_on_materials_at_the_byte_limit_still_dispatches() {
        let dir = tempfile::tempdir().unwrap();
        let ws = lab(dir.path());
        let project = project(&ws).await;
        let mut materials = json!({"repositoryId":123,"headSha":"5".repeat(40),"acceptance":"a".repeat(16_384),
            "returnRequirements":"r".repeat(8_192),"worktree":"w".repeat(4_096),"baseline":"b".repeat(1_024),
            "references":[{"kind":"evidence","label":"padding","url":"https://example.com/"}]});
        let pad = 32_768 - materials.to_string().len();
        materials["references"][0]["url"] = json!(format!("https://example.com/{}", "p".repeat(pad)));
        assert_eq!(materials.to_string().len(), 32_768);
        let full = create(&ws, &project, "at-limit", materials).await.unwrap();
        assert_eq!(full["shaCheck"]["headSha"]["state"], "unverified", "{}", full["shaCheck"]);
        let sent = dispatch(&ws, "at-limit", full["task"]["id"].as_str().unwrap()).await.unwrap();
        assert_eq!(sent["shaCheck"]["headSha"]["state"], "unverified", "{}", sent["shaCheck"]);
    }

    /// R1 b19659c2: a reason that GitHub's or gh's text makes long in bytes is
    /// cut at a character boundary within what the store takes, not refused.
    #[tokio::test]
    async fn a_reason_long_in_bytes_is_clipped_not_refused() {
        let dir = tempfile::tempdir().unwrap();
        let ws = lab(dir.path());
        let project = project(&ws).await;
        // A repository whose name makes the 404 reason long in bytes.
        let wide = format!("o/{}", "😀".repeat(400));
        ws.store.db.write().unwrap().execute("INSERT INTO github_repositories(id,data) VALUES(125,?1)",
            [json!({"id":125,"fullName":wide}).to_string()]).unwrap();
        ws.store.github_link_repo(&project, &crate::github::client::Repository { id: 125, full_name: wide.clone() }).unwrap();
        let saved = create(&ws, &project, "wide", json!({"repositoryId":125,"headSha":FULL})).await.unwrap();
        let reason = saved["shaCheck"]["headSha"]["reason"].as_str().unwrap().to_owned();
        assert!(reason.starts_with("GitHub could not read o/😀") && reason.len() <= REASON_BYTES && reason.len() > REASON_BYTES - 4,
            "clipped by bytes at a character boundary: {} bytes", reason.len());
        let sent = dispatch(&ws, "wide", saved["task"]["id"].as_str().unwrap()).await.unwrap();
        assert_eq!(sent["shaCheck"]["headSha"]["state"], "unverified", "{}", sent["shaCheck"]);
        assert!(sent["shaCheck"]["headSha"]["reason"].as_str().unwrap().len() <= REASON_BYTES);
    }

    /// R1 b19659c2: a dispatch whose override names the repository already
    /// registered keeps what GitHub said of the registered SHAs there, and asks
    /// nothing again.
    #[tokio::test]
    async fn a_dispatch_naming_the_same_repository_keeps_the_registered_check() {
        let dir = tempfile::tempdir().unwrap();
        let ws = lab(dir.path());
        let project = project(&ws).await;
        let verified = create(&ws, &project, "verified", json!({"repositoryId":123,"headSha":FULL})).await.unwrap();
        let task = verified["task"]["id"].as_str().unwrap().to_owned();
        let asked = requests(dir.path()).len();
        let version = ws.store.collaboration_call(None, "task_get", json!({"taskId":task})).unwrap()["task"]["version"].clone();
        let sent = ws.collaboration_call(None, "task_dispatch", json!({"requestId":"same","taskId":task,"expectedVersion":version,
            "toAgentId":"dev","materials":{"repositoryId":123}})).await.unwrap();
        assert_eq!(sent["shaCheck"]["headSha"], verified["shaCheck"]["headSha"], "{}", sent["shaCheck"]);
        assert!(sent["message"]["body"].as_str().unwrap().contains(&format!("Explicit head SHA: {FULL} (found on GitHub at ")),
            "{}", sent["message"]["body"]);
        assert_eq!(requests(dir.path()).len(), asked);
    }

    /// R2 b58a5ca1: a retry of a call Core already answered replays that
    /// answer, task_create's and task_update's alike, though GitHub now says
    /// the commit is not there; GitHub is not asked, and nothing new is
    /// recorded. A new request is refused as GitHub now says.
    #[tokio::test]
    async fn a_retry_replays_its_receipt_though_github_now_refuses_the_sha() {
        let dir = tempfile::tempdir().unwrap();
        let ws = lab(dir.path());
        let project = project(&ws).await;
        let five = "5".repeat(40);
        let create = json!({"requestId":"first","title":"Retry","projectId":project,"materials":{"repositoryId":123,"headSha":five}});
        let created = ws.collaboration_call(None, "task_create", create.clone()).await.unwrap();
        assert_eq!(created["shaCheck"]["headSha"]["state"], "unverified", "{created}");
        let task = created["task"]["id"].as_str().unwrap().to_owned();
        let update = json!({"requestId":"edit","taskId":task,"expectedVersion":created["task"]["version"],
            "patch":{"materials":{"repositoryId":123,"baseSha":five,"headSha":five}}});
        let updated = ws.collaboration_call(None, "task_update", update.clone()).await.unwrap();
        assert_eq!(updated["shaCheck"]["baseSha"]["state"], "unverified", "{updated}");
        let read = |ws: &Workspace| ws.store.collaboration_call(None, "task_get", json!({"taskId":task,"view":"full"})).unwrap();
        let before = read(&ws);

        std::fs::write(dir.path().join("gone"), "").unwrap();
        let asked = requests(dir.path()).len();
        let again = ws.collaboration_call(None, "task_create", create).await.unwrap();
        assert_eq!((&again["task"]["id"], &again["task"]["version"], &again["shaCheck"]),
            (&created["task"]["id"], &created["task"]["version"], &created["shaCheck"]), "task_create's first receipt");
        let again = ws.collaboration_call(None, "task_update", update).await.unwrap();
        assert_eq!((&again["task"]["version"], &again["shaCheck"]), (&updated["task"]["version"], &updated["shaCheck"]),
            "task_update's first receipt");
        assert_eq!(requests(dir.path()).len(), asked, "the retries asked GitHub nothing");
        let after = read(&ws);
        assert_eq!((&after["task"]["version"], &after["activities"]), (&before["task"]["version"], &before["activities"]), "nothing new recorded");

        let error = ws.collaboration_call(None, "task_create", json!({"requestId":"second","title":"Retry","projectId":project,
            "materials":{"repositoryId":123,"headSha":five}})).await.unwrap_err().to_string();
        assert!(error.contains(&format!("headSha {five} is not a commit of o/r")), "{error}");
    }
}
