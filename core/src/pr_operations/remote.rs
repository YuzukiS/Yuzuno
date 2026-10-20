use super::{Submit, progress};
use crate::{
    github::client::{Client, Repository},
    model::now,
    workspace::Workspace,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

fn encoded(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn sha(v: &Value) -> Result<&str> {
    v.as_str()
        .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .context("GitHub returned an invalid commit identity")
}
fn matches(v: &Value, repo: &Repository, input: &Submit) -> bool {
    v["base"]["repo"]["id"] == repo.id
        && v["head"]["repo"]["id"] == repo.id
        && v["base"]["ref"] == input.base
        && v["head"]["ref"] == input.head
}
fn normalize(v: &Value, repo: &Repository, input: &Submit) -> Result<Value> {
    ensure!(
        matches(v, repo, input),
        "PR repository or base/head does not match the explicit request; nothing was changed"
    );
    let number = v["number"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= i32::MAX as u64)
        .context("Invalid PR number")?;
    ensure!(
        v["id"].as_u64().is_some_and(|id| id > 0) && v["draft"].is_boolean(),
        "Missing GitHub PR identity or draft state"
    );
    let title = v["title"].as_str().context("Missing PR title")?;
    let body = v["body"].as_str().unwrap_or("");
    ensure!(
        title.len() <= 1024 && body.len() <= 100_000,
        "PR content exceeds the retained evidence limit"
    );
    ensure!(
        matches!(v["state"].as_str(), Some("open" | "closed")),
        "Unrecognized PR state"
    );
    Ok(
        json!({"id":v["id"],"number":number,"url":format!("https://github.com/{}/pull/{number}",repo.full_name),
        "repositoryId":repo.id,"repository":repo.full_name,"title":title,"body":body,
        "draft":v["draft"],"state":if v["merged_at"].is_string(){"merged"}else{v["state"].as_str().unwrap()},
        "base":input.base,"head":input.head,"baseSha":sha(&v["base"]["sha"])? ,"headSha":sha(&v["head"]["sha"])? ,
        "author":v["user"]["login"],"updatedAt":v["updated_at"],"observedAt":now()}),
    )
}
async fn get(client: &Client, repo: &Repository, input: &Submit, number: u64) -> Result<Value> {
    let value = client
        .get(&format!("repos/{}/pulls/{number}", repo.full_name))
        .await?;
    ensure!(
        value["number"].as_u64() == Some(number),
        "PR number changed in GitHub response"
    );
    normalize(&value, repo, input)
}
async fn candidates(
    client: &Client,
    repo: &Repository,
    input: &Submit,
    all: bool,
) -> Result<Vec<Value>> {
    let owner = repo
        .full_name
        .split('/')
        .next()
        .context("Missing repository owner")?;
    let value = client
        .get(&format!(
            "repos/{}/pulls?state={}&head={}&base={}&per_page=100",
            repo.full_name,
            if all { "all" } else { "open" },
            encoded(&format!("{owner}:{}", input.head)),
            encoded(&input.base)
        ))
        .await?;
    let rows = value
        .as_array()
        .context("GitHub PR search returned an incomplete result")?;
    ensure!(
        rows.len() < 100,
        "PR search reached its limit; explicitly select a PR number instead"
    );
    rows.iter()
        .filter(|v| matches(v, repo, input))
        .map(|v| normalize(v, repo, input))
        .collect()
}
fn choose(record: &mut Value, choices: Vec<Value>) -> Option<Value> {
    if choices.len() == 1 {
        return choices.into_iter().next();
    }
    if choices.len() > 1 {
        record["status"] = json!("needs_selection");
        record["error"] = json!(
            "More than one matching PR exists. Select its number and check again; no PR was modified."
        );
        record["candidates"] = json!(
            choices
                .into_iter()
                .map(|mut p| {
                    p.as_object_mut().unwrap().remove("body");
                    p
                })
                .collect::<Vec<_>>()
        );
    }
    None
}
fn desired(remote: &Value, input: &Submit) -> bool {
    remote["title"].as_str() == Some(&input.title) && remote["body"].as_str() == Some(&input.body)
}
async fn reconcile(
    client: &Client,
    repo: &Repository,
    input: &Submit,
    record: &mut Value,
    selected: Option<u64>,
) -> Result<()> {
    if let (Some(number), Some(original)) = (selected, input.number) {
        ensure!(
            number == original,
            "The originally selected PR number cannot be changed during recovery"
        );
    }
    let number = input
        .number
        .or(record["remote"]["number"].as_u64())
        .or(selected);
    let remote = if let Some(number) = number {
        Some(get(client, repo, input, number).await?)
    } else {
        choose(record, candidates(client, repo, input, true).await?)
    };
    let Some(remote) = remote else {
        if record["status"] != "needs_selection" {
            record["status"] = json!("unknown");
            record["error"] = json!(
                "No matching remote PR was found. No create/update was repeated; inspect GitHub before an explicit new request."
            );
        }
        return Ok(());
    };
    let matched = input.action == "create" || desired(&remote, input);
    record["remote"] = remote;
    record["candidates"] = json!([]);
    record["outcome"] = json!("checked");
    record["status"] = json!(if matched { "completed" } else { "unknown" });
    record["error"] = if matched {
        Value::Null
    } else {
        json!(
            "The PR exists, but its current title/body differ from this request. No update was replayed."
        )
    };
    Ok(())
}

pub(super) async fn execute(
    ws: &Workspace,
    record: &mut Value,
    check_only: bool,
    selected: Option<u64>,
) -> Result<()> {
    let input: Submit = serde_json::from_value(record["input"].clone())?;
    record["status"] = json!("running");
    progress(ws, record).await?;
    let client = &ws.github.client;
    let repo = client.repository(&input.repository_id.to_string()).await?;
    ensure!(
        repo.id == input.repository_id,
        "GitHub repository identity changed"
    );
    record["repository"] = json!(repo.full_name);
    if check_only {
        return reconcile(client, &repo, &input, record, selected).await;
    }

    // Verify both branches exist remotely. No checkout, push or local Git inference.
    let base = client
        .get(&format!(
            "repos/{}/branches/{}",
            repo.full_name,
            encoded(&input.base)
        ))
        .await?;
    let head = client
        .get(&format!(
            "repos/{}/branches/{}",
            repo.full_name,
            encoded(&input.head)
        ))
        .await?;
    record["observedRevisions"] = json!({"baseSha":sha(&base["commit"]["sha"])? ,"headSha":sha(&head["commit"]["sha"])? ,"observedAt":now()});
    let existing = if let Some(number) = input.number {
        Some(get(client, &repo, &input, number).await?)
    } else {
        choose(record, candidates(client, &repo, &input, false).await?)
    };
    if record["status"] == "needs_selection" {
        return Ok(());
    }
    if let Some(remote) = existing {
        ensure!(
            remote["state"] == "open",
            "Only an open PR can be selected for create/update; no PR was modified"
        );
        if input.action == "create" || desired(&remote, &input) {
            record["remote"] = remote;
            record["status"] = json!("completed");
            record["outcome"] = json!(if input.action == "create" {
                "reused"
            } else {
                "unchanged"
            });
            return Ok(());
        }
        record["remoteBefore"] = remote;
    }
    let (method, endpoint, body) = if input.action == "create" {
        (
            "POST",
            format!("repos/{}/pulls", repo.full_name),
            json!({"base":input.base,"head":input.head,"title":input.title,"body":input.body,"draft":input.draft}),
        )
    } else {
        (
            "PATCH",
            format!(
                "repos/{}/pulls/{}",
                repo.full_name,
                input.number.context("Missing explicit update target")?
            ),
            json!({"title":input.title,"body":input.body}),
        )
    };
    record["writeStarted"] = json!(true);
    record["phase"] = json!(if input.action == "create" {
        "Creating the PR on GitHub"
    } else {
        "Updating the selected PR title/body"
    });
    progress(ws, record).await?;
    match client.write_json(method, &endpoint, &body).await {
        Ok(value) => {
            let remote = normalize(&value, &repo, &input)?;
            ensure!(
                input
                    .number
                    .is_none_or(|number| remote["number"].as_u64() == Some(number)),
                "GitHub returned another PR identity"
            );
            let applied = desired(&remote, &input)
                && (input.action != "create" || remote["draft"].as_bool() == input.draft);
            record["remote"] = remote;
            record["status"] = json!(if applied { "completed" } else { "unknown" });
            record["outcome"] = json!(if input.action == "create" {
                "created"
            } else {
                "updated"
            });
            if !applied {
                record["error"] = json!(
                    "GitHub's returned values do not confirm the requested change. Check the retained result before retrying."
                );
            }
            Ok(())
        }
        Err(error) => {
            record["writeError"] = json!(error.to_string());
            record["phase"] =
                json!("Write reply unconfirmed; checking GitHub without repeating it");
            progress(ws, record).await?;
            reconcile(client, &repo, &input, record, input.number).await
        }
    }
}

pub(super) fn snapshot(remote: &Value) -> Value {
    json!({"title":remote["title"],"state":if remote["state"]=="open" && remote["draft"]==true {json!("draft")}else{remote["state"].clone()},
        "observedAt":remote["observedAt"],"baseSha":remote["baseSha"],"headSha":remote["headSha"],"baseBranch":remote["base"],"headBranch":remote["head"],
        "ci":{"state":"unknown","headSha":remote["headSha"],"observedAt":remote["observedAt"],"complete":false,"checks":[]}})
}
