//! GitHub.com requests through the installed official gh. No shell, stored
//! tokens or cwd inference. Errors are classified, never echoed verbatim.
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::Path,
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: i64,
    pub full_name: String,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub repo: String,
    pub kind: Option<String>,
    pub number: Option<u64>,
}

pub fn parse(input: &str, object: bool) -> Result<Target> {
    let input = input.trim();
    ensure!(
        input.len() <= 300,
        "Use a GitHub.com repository or Issue/PR URL"
    );
    let path = input.strip_prefix("https://github.com/").unwrap_or(input);
    ensure!(
        !path.contains(['?', '#', '%', '\\', ':', '@']),
        "Use a plain https://github.com URL without query or fragment"
    );
    let parts: Vec<_> = path.trim_end_matches('/').split('/').collect();
    ensure!(
        parts.len() == if object { 4 } else { 2 },
        "Use owner/repo or https://github.com/owner/repo; tasks need the full Issue/PR URL"
    );
    if object {
        ensure!(
            input.starts_with("https://github.com/"),
            "Paste the full GitHub.com Issue/PR URL"
        );
    }
    let owner = parts[0];
    let repo = if object {
        parts[1]
    } else {
        parts[1].strip_suffix(".git").unwrap_or(parts[1])
    };
    let valid = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            && s != "."
            && s != ".."
            && !s.starts_with('-')
    };
    ensure!(
        valid(owner) && valid(repo),
        "Invalid GitHub owner/repository"
    );
    let (kind, number) = if object {
        ensure!(
            matches!(parts[2], "pull" | "issues"),
            "Link an Issue or pull request, not a repository page"
        );
        let n = parts[3]
            .parse::<u64>()
            .context("Invalid GitHub object number")?;
        ensure!(
            n > 0 && n <= i32::MAX as u64 && parts[3] == n.to_string(),
            "Invalid GitHub object number"
        );
        (
            Some(if parts[2] == "pull" { "pull" } else { "issue" }.into()),
            Some(n),
        )
    } else {
        (None, None)
    };
    Ok(Target {
        repo: format!("{owner}/{repo}"),
        kind,
        number,
    })
}

pub(super) fn failure(stderr: &[u8], code: Option<i32>) -> anyhow::Error {
    let text = String::from_utf8_lossy(stderr).to_lowercase();
    let message = if text.contains("rate limit") || text.contains("http 429") {
        "rate_limited: GitHub rate limit reached; retry later"
    } else if code == Some(4)
        || text.contains("gh auth login")
        || text.contains("http 401")
        || text.contains("authentication")
    {
        "not_authenticated: Sign in with gh on the Core host"
    } else if text.contains("http 404") || text.contains("could not resolve to a repository") {
        "not_found: GitHub object was not found or this account cannot access it"
    } else if text.contains("http 403") {
        "forbidden: The Core host's gh account cannot access this GitHub resource"
    } else if text.contains("http 422") {
        "rejected: GitHub rejected the request parameters or an equivalent PR already exists"
    } else {
        "unavailable: GitHub is unreachable or gh could not complete the request"
    };
    anyhow::anyhow!(message)
}

pub struct Client {
    pub(crate) program: String,
    pub(crate) deadline: Duration,
}
impl Default for Client {
    fn default() -> Self {
        Self {
            program: "gh".into(),
            deadline: Duration::from_secs(12),
        }
    }
}
impl Client {
    fn spawn(&self, endpoint: &str, accept: &str) -> Result<Child> {
        self.spawn_request(endpoint, accept, "GET", false)
    }

    fn spawn_request(
        &self,
        endpoint: &str,
        accept: &str,
        method: &str,
        input: bool,
    ) -> Result<Child> {
        self.spawn_with_headers(endpoint, accept, method, input, &[])
    }

    fn spawn_with_headers(
        &self,
        endpoint: &str,
        accept: &str,
        method: &str,
        input: bool,
        extra: &[String],
    ) -> Result<Child> {
        let mut command = Command::new(&self.program);
        command.args([
            "api",
            "--hostname",
            "github.com",
            "--method",
            method,
            "-H",
            accept,
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
            endpoint,
        ]);
        if input {
            command.args(["--input", "-"]);
        }
        command.args(extra);
        command
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_PAGER", "cat")
            .env_remove("GH_DEBUG")
            .stdin(if input { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    anyhow::anyhow!("gh_missing: Install GitHub CLI on the Core host")
                } else {
                    anyhow::anyhow!("gh_unavailable: GitHub CLI could not start on the Core host")
                }
            })
    }

    /// Release assets use the same official gh authentication and bounded IO.
    /// The caller supplies a fixed-repository asset endpoint, never a remote URL.
    pub async fn download(
        &self,
        endpoint: &str,
        path: &Path,
        limit: u64,
        timeout: Duration,
        progress: &AtomicU64,
    ) -> Result<()> {
        let mut child = self.spawn(endpoint, "Accept: application/octet-stream")?;
        let mut stdout = child.stdout.take().context("gh stdout unavailable")?;
        let mut stderr = child
            .stderr
            .take()
            .context("gh stderr unavailable")?
            .take(64 * 1024 + 1);
        let transfer = async {
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .await?;
            let mut buffer = [0; 64 * 1024];
            let mut total = 0u64;
            loop {
                let n = stdout.read(&mut buffer).await?;
                if n == 0 {
                    break;
                }
                total = total
                    .checked_add(n as u64)
                    .context("Release size overflow")?;
                ensure!(total <= limit, "Release download exceeded its size limit");
                file.write_all(&buffer[..n]).await?;
                progress.store(total, Ordering::Relaxed);
            }
            file.sync_all().await?;
            Ok::<_, anyhow::Error>(())
        };
        let operation = async {
            let mut err = Vec::new();
            tokio::try_join!(transfer, async {
                stderr.read_to_end(&mut err).await?;
                Ok::<_, anyhow::Error>(())
            })?;
            ensure!(
                err.len() <= 64 * 1024,
                "GitHub diagnostics exceeded the read limit"
            );
            let status = child.wait().await?;
            if !status.success() {
                return Err(failure(&err, status.code()));
            }
            Ok(())
        };
        match tokio::time::timeout(timeout, operation).await {
            Ok(Ok(())) => Ok(()),
            result => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                match result {
                    Ok(Err(error)) => Err(error),
                    _ => bail!("timeout: GitHub release download timed out"),
                }
            }
        }
    }

    pub async fn get(&self, endpoint: &str) -> Result<Value> {
        self.json_request("GET", endpoint, None).await
    }

    /// Compare's file list is capped and can dwarf the metadata. It is never
    /// used as review evidence: Git supplies the fixed objects and full diff.
    pub(crate) async fn comparison_identity(
        &self,
        repo: &str,
        base: &str,
        head: &str,
    ) -> Result<Value> {
        let endpoint = format!("repos/{repo}/compare/{base}...{head}?per_page=1");
        let mut child = self.spawn_with_headers(
            &endpoint, "Accept: application/vnd.github+json", "GET", false,
            &["--jq".into(), "{base: .base_commit.sha, mergeBase: .merge_base_commit.sha, commits: .total_commits}".into()],
        )?;
        let mut out = child
            .stdout
            .take()
            .context("gh stdout unavailable")?
            .take(4097);
        let mut err = child
            .stderr
            .take()
            .context("gh stderr unavailable")?
            .take(65537);
        let result = tokio::time::timeout(self.deadline, async {
            let (mut bytes, mut diagnostic) = (Vec::new(), Vec::new());
            tokio::try_join!(
                async {
                    out.read_to_end(&mut bytes).await?;
                    ensure!(
                        bytes.len() <= 4096,
                        "Comparison identity exceeds its transport budget"
                    );
                    Ok::<_, anyhow::Error>(())
                },
                async {
                    err.read_to_end(&mut diagnostic).await?;
                    ensure!(
                        diagnostic.len() <= 65536,
                        "Comparison diagnostics exceed their transport budget"
                    );
                    Ok::<_, anyhow::Error>(())
                }
            )?;
            let status = child.wait().await?;
            ensure!(
                status.success(),
                "GitHub comparison identity is unavailable"
            );
            Ok::<Value, anyhow::Error>(serde_json::from_slice(&bytes)?)
        })
        .await;
        match result {
            Ok(Ok(value)) => Ok(value),
            failure => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                match failure {
                    Ok(Err(e)) => Err(e),
                    _ => bail!("GitHub comparison identity timed out"),
                }
            }
        }
    }

    /// The commit SHA GitHub resolves `reference` to in `repo`, with GitHub's
    /// status (T-164). Only the SHA is asked for (application/vnd.github.sha),
    /// so a large commit's files and patches are never read.
    pub(crate) async fn commit_sha(&self, repo: &str, reference: &str) -> Result<(u16, String)> {
        let endpoint = format!("repos/{repo}/commits/{reference}");
        let mut child = self.spawn_with_headers(
            &endpoint, "Accept: application/vnd.github.sha", "GET", false, &["--include".into()])?;
        let mut stdout = child.stdout.take().context("gh stdout unavailable")?.take(64 * 1024 + 1);
        let mut stderr = child.stderr.take().context("gh stderr unavailable")?.take(64 * 1024 + 1);
        let result = tokio::time::timeout(self.deadline, async {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))?;
            ensure!(
                out.len() <= 64 * 1024 && err.len() <= 64 * 1024,
                "response_too_large: GitHub response exceeded the read limit"
            );
            let status = child.wait().await?;
            let text = String::from_utf8(out).context("invalid_response: Invalid GitHub response")?;
            let (head, body) = text
                .split_once("\r\n\r\n")
                .or_else(|| text.split_once("\n\n"))
                .context("invalid_response: Missing GitHub response headers")?;
            let code = head
                .lines()
                .next()
                .and_then(|s| s.split_whitespace().nth(1))
                .and_then(|s| s.parse::<u16>().ok())
                .context("invalid_response: Missing GitHub response status")?;
            Ok::<_, anyhow::Error>(if code == 200 && status.success() {
                (code, body.trim().to_owned())
            } else {
                (code, failure(&err, status.code()).to_string())
            })
        })
        .await;
        match result {
            Ok(Ok(v)) => Ok(v),
            other => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                match other {
                    Ok(Err(e)) => Err(e),
                    _ => bail!("timeout: GitHub commit read timed out"),
                }
            }
        }
    }

    /// Bounded authenticated conditional read. Headers are retained only for
    /// cache/pagination/backoff; diagnostics and credentials never enter storage.
    pub(crate) async fn conditional(&self, endpoint: &str, etag: Option<&str>) -> Result<Value> {
        let mut extra = vec!["--include".to_owned()];
        if let Some(etag) = etag.filter(|s| s.len() <= 512 && !s.contains(['\r', '\n'])) {
            extra.extend(["-H".into(), format!("If-None-Match: {etag}")]);
        }
        let mut child = self.spawn_with_headers(
            endpoint,
            "Accept: application/vnd.github+json",
            "GET",
            false,
            &extra,
        )?;
        let mut stdout = child
            .stdout
            .take()
            .context("gh stdout unavailable")?
            .take(2 * 1024 * 1024 + 1);
        let mut stderr = child
            .stderr
            .take()
            .context("gh stderr unavailable")?
            .take(64 * 1024 + 1);
        let result = tokio::time::timeout(self.deadline, async {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))?;
            ensure!(
                out.len() <= 2 * 1024 * 1024 && err.len() <= 64 * 1024,
                "response_too_large: GitHub response exceeded the read limit"
            );
            let status = child.wait().await?;
            let text =
                String::from_utf8(out).context("invalid_response: Invalid GitHub response")?;
            let (head, body) = text
                .split_once("\r\n\r\n")
                .or_else(|| text.split_once("\n\n"))
                .context("invalid_response: Missing GitHub response headers")?;
            let code = head
                .lines()
                .next()
                .and_then(|s| s.split_whitespace().nth(1))
                .and_then(|s| s.parse::<u16>().ok())
                .context("invalid_response: Missing GitHub response status")?;
            let mut headers = std::collections::BTreeMap::new();
            for line in head.lines().skip(1) {
                if let Some((key, value)) = line.split_once(':') {
                    let key = key.trim().to_ascii_lowercase();
                    if matches!(
                        key.as_str(),
                        "etag"
                            | "link"
                            | "retry-after"
                            | "x-ratelimit-reset"
                            | "x-ratelimit-remaining"
                            | "x-poll-interval"
                    ) {
                        headers.insert(key, value.trim().to_owned());
                    }
                }
            }
            let error = if code == 304 || (code == 200 && status.success()) {
                Value::Null
            } else {
                json!(failure(&err, status.code()).to_string())
            };
            let value = if code == 200 && error.is_null() {
                serde_json::from_str::<Value>(body)
                    .context("invalid_response: GitHub returned unreadable JSON")?
            } else {
                Value::Null
            };
            Ok::<_, anyhow::Error>(
                json!({"code":code,"headers":headers,"value":value,"error":error}),
            )
        })
        .await;
        match result {
            Ok(Ok(v)) => Ok(v),
            other => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                match other {
                    Ok(Err(e)) => Err(e),
                    _ => bail!("timeout: GitHub conditional read timed out"),
                }
            }
        }
    }

    /// Explicit PR writes only; JSON is streamed to stdin, never shell or argv text.
    /// Any error after submission requires remote reconciliation by the caller.
    pub(crate) async fn write_json(
        &self,
        method: &str,
        endpoint: &str,
        body: &Value,
    ) -> Result<Value> {
        ensure!(
            matches!(method, "POST" | "PATCH"),
            "Unsupported GitHub write method"
        );
        let body = serde_json::to_vec(body)?;
        ensure!(body.len() <= 128 * 1024, "GitHub request body is too large");
        self.json_request(method, endpoint, Some(body)).await
    }

    /// A fixed read-only GraphQL query from Core's own code, never a mutation.
    /// Query and variables travel in the stdin JSON body, not argv or shell
    /// text. Returns the response's `data`.
    pub(crate) async fn graphql(&self, query: &str, variables: Value) -> Result<Value> {
        ensure!(
            query.starts_with("query") && !query.contains("mutation"),
            "Only GraphQL queries are read here"
        );
        let body = serde_json::to_vec(&json!({"query":query,"variables":variables}))?;
        ensure!(body.len() <= 16 * 1024, "GitHub query is too large");
        let value = self.json_request("POST", "graphql", Some(body)).await?;
        if let Some(error) = value["errors"].as_array().and_then(|e| e.first()) {
            bail!(match error["type"].as_str() {
                Some("RATE_LIMITED") => "rate_limited: GitHub rate limit reached; retry later",
                Some("NOT_FOUND") =>
                    "not_found: GitHub object was not found or this account cannot access it",
                Some("FORBIDDEN") =>
                    "forbidden: The Core host's gh account cannot access this GitHub resource",
                _ => "unavailable: GitHub is unreachable or gh could not complete the request",
            });
        }
        value
            .get("data")
            .filter(|d| d.is_object())
            .cloned()
            .context("invalid_response: GitHub returned no data")
    }

    async fn json_request(
        &self,
        method: &str,
        endpoint: &str,
        body: Option<Vec<u8>>,
    ) -> Result<Value> {
        let mut child = self.spawn_request(
            endpoint,
            "Accept: application/vnd.github+json",
            method,
            body.is_some(),
        )?;
        let mut stdin = child.stdin.take();
        let mut stdout = child
            .stdout
            .take()
            .context("gh stdout unavailable")?
            .take(2 * 1024 * 1024 + 1);
        let mut stderr = child
            .stderr
            .take()
            .context("gh stderr unavailable")?
            .take(64 * 1024 + 1);
        let operation = async {
            let mut out = Vec::new();
            let mut err = Vec::new();
            tokio::try_join!(
                async {
                    stdout
                        .read_to_end(&mut out)
                        .await
                        .context("Cannot read gh response")
                },
                async {
                    stderr
                        .read_to_end(&mut err)
                        .await
                        .context("Cannot read gh diagnostics")
                },
                async {
                    if let Some(body) = &body {
                        let mut stdin = stdin.take().context("gh stdin unavailable")?;
                        stdin.write_all(body).await?;
                        stdin.shutdown().await?;
                        drop(stdin);
                    }
                    Ok::<_, anyhow::Error>(())
                }
            )?;
            ensure!(
                out.len() <= 2 * 1024 * 1024 && err.len() <= 64 * 1024,
                "response_too_large: GitHub response exceeded the read limit"
            );
            let status = child.wait().await?;
            if !status.success() {
                return Err(failure(&err, status.code()));
            }
            serde_json::from_slice(&out)
                .context("invalid_response: GitHub returned an unreadable response")
        };
        let result = tokio::time::timeout(self.deadline, operation).await;
        match result {
            Ok(Ok(v)) => Ok(v),
            other => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                match other {
                    Ok(Err(e)) => Err(e),
                    _ => bail!(
                        "timeout: GitHub {method} timed out; a write result must be checked before retrying"
                    ),
                }
            }
        }
    }
    pub async fn repository(&self, name_or_id: &str) -> Result<Repository> {
        let endpoint = if name_or_id.bytes().all(|b| b.is_ascii_digit()) {
            format!("repositories/{name_or_id}")
        } else {
            format!("repos/{name_or_id}")
        };
        let value = self.get(&endpoint).await?;
        let id = value["id"]
            .as_i64()
            .filter(|id| *id > 0)
            .context("Invalid GitHub repository identity")?;
        let full_name = parse(
            value["full_name"]
                .as_str()
                .context("Missing repository name")?,
            false,
        )?
        .repo;
        Ok(Repository { id, full_name })
    }
    pub async fn object(&self, repo: &Repository, kind: &str, number: u64) -> Result<Value> {
        let path = if kind == "pull" { "pulls" } else { "issues" };
        let v = self
            .get(&format!("repos/{}/{path}/{number}", repo.full_name))
            .await?;
        ensure!(
            v["number"].as_u64() == Some(number),
            "GitHub object identity changed"
        );
        ensure!(
            kind == "pull" || v.get("pull_request").is_none(),
            "This is a pull request; use its /pull/ URL"
        );
        let title = v["title"].as_str().context("GitHub object has no title")?;
        let mut state = v["state"]
            .as_str()
            .filter(|s| matches!(*s, "open" | "closed"))
            .context("Unknown GitHub object state")?;
        if kind == "pull" && v["merged_at"].is_string() {
            state = "merged";
        } else if kind == "pull" && v["draft"] == true && state == "open" {
            state = "draft";
        }
        let mut snapshot = json!({"title":title,"state":state,"observedAt":crate::model::now()});
        if kind == "pull" {
            let sha = v["head"]["sha"]
                .as_str()
                .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                .context("Missing PR head commit")?;
            let checks_path = format!(
                "repos/{}/commits/{sha}/check-runs?per_page=100&filter=latest",
                repo.full_name
            );
            let status_path = format!("repos/{}/commits/{sha}/status?per_page=100", repo.full_name);
            let (checks, statuses) =
                tokio::try_join!(self.get(&checks_path), self.get(&status_path))?;
            snapshot["headSha"] = json!(sha);
            snapshot["baseSha"] = v["base"]["sha"].clone();
            snapshot["headBranch"] = v["head"]["ref"].clone();
            snapshot["baseBranch"] = v["base"]["ref"].clone();
            snapshot["ci"] = checks_summary(sha, &checks, &statuses)?;
        }
        Ok(snapshot)
    }
}

pub fn checks_summary(sha: &str, checks: &Value, statuses: &Value) -> Result<Value> {
    let runs = checks["check_runs"]
        .as_array()
        .context("GitHub checks response is incomplete")?;
    let contexts = statuses["statuses"]
        .as_array()
        .context("GitHub statuses response is incomplete")?;
    let complete = checks["total_count"].as_u64() == Some(runs.len() as u64)
        && statuses["total_count"].as_u64() == Some(contexts.len() as u64)
        && statuses["sha"].as_str() == Some(sha)
        && runs.iter().all(|r| r["head_sha"].as_str() == Some(sha));
    let mut states = Vec::new();
    let mut items = Vec::new();
    for r in runs {
        let state = if r["status"] != "completed" {
            "pending"
        } else {
            match r["conclusion"].as_str() {
                Some("success") => "success",
                Some("failure" | "timed_out" | "action_required" | "startup_failure") => "failure",
                Some("cancelled") => "cancelled",
                Some("neutral" | "skipped") => "neutral",
                _ => "unknown",
            }
        };
        states.push(state);
        items.push(json!({"name":r["name"],"state":state}));
    }
    for r in contexts {
        let state = match r["state"].as_str() {
            Some("success") => "success",
            Some("failure" | "error") => "failure",
            Some("pending") => "pending",
            _ => "unknown",
        };
        states.push(state);
        items.push(json!({"name":r["context"],"state":state}));
    }
    let state = if !complete {
        "unknown"
    } else if states.contains(&"failure") {
        "failure"
    } else if states.contains(&"pending") {
        "pending"
    } else if states.contains(&"cancelled") {
        "cancelled"
    } else if states.contains(&"unknown") {
        "unknown"
    } else if states.is_empty() {
        "none"
    } else if states.contains(&"success") {
        "success"
    } else {
        "neutral"
    };
    Ok(
        json!({"state":state,"headSha":sha,"observedAt":crate::model::now(),"complete":complete,"checks":items}),
    )
}
