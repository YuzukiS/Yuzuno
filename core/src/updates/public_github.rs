//! Release reads without gh (YN-110). A release check or download goes
//! through gh as always; only when gh says it is missing on the Core host or
//! not signed in does that one operation read GitHub's public endpoints
//! itself. That reader is read-only, carries no token or any other credential,
//! and knows two endpoint shapes: a repository's release list and one release
//! asset. Nothing it reads is trusted for coming from it: a Core release is
//! still verified by its minisign signature, its signed sha256 and
//! `Bundle::verify`, and a desktop installer by the desktop's own updater key.
use crate::github::client::Client as Gh;
use anyhow::{anyhow, bail, ensure, Context, Result};
use axum::{
    body::{Bytes, HttpBody},
    http::{header, HeaderMap, Request, Response, StatusCode, Uri},
};
use http_body_util::{BodyExt, Empty, LengthLimitError, Limited};
use hyper_util::client::proxy::matcher::Matcher;
use serde_json::Value;
use std::{
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::io::AsyncWriteExt;

/// The only address Core reads without gh. Production code never changes it:
/// no environment variable or setting does; only a test's reader can.
pub(crate) const API: &str = "https://api.github.com";
const MAX_JSON: usize = 8 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const USER_AGENT: &str = concat!("yuzuno-core/", env!("CARGO_PKG_VERSION"));

/// Which way one check or download reached GitHub.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    Gh,
    Public,
}
impl Via {
    pub fn name(self) -> &'static str {
        match self {
            Via::Gh => "gh",
            Via::Public => "public",
        }
    }
}

/// One check's or download's way to GitHub: gh until gh answers that it is
/// missing (`gh_missing`) or not signed in (`not_authenticated`); from then
/// on, for the rest of this operation, the public reader. Every other gh
/// error (`not_found`, `forbidden`, `rate_limited`, `unavailable`, a timeout)
/// is reported as gh gave it. Each read is boxed: gh's and the reader's
/// futures are large, and a caller may run on a small (test) thread stack.
pub(crate) struct Route<'a> {
    gh: &'a Gh,
    public: &'a PublicGithub,
    via: Via,
}
impl<'a> Route<'a> {
    pub fn new(gh: &'a Gh, public: &'a PublicGithub) -> Self {
        Self { gh, public, via: Via::Gh }
    }
    pub fn via(&self) -> Via {
        self.via
    }
    pub async fn get(&mut self, endpoint: &str) -> Result<Value> {
        if self.via == Via::Gh {
            match Box::pin(self.gh.get(endpoint)).await {
                Err(error) if gh_unusable(&error) => self.via = Via::Public,
                answer => return answer,
            }
        }
        Box::pin(self.public.get_json(endpoint)).await
    }
    pub async fn download(&mut self, endpoint: &str, path: &Path, limit: u64, timeout: Duration, progress: &AtomicU64) -> Result<()> {
        if self.via == Via::Gh {
            match Box::pin(self.gh.download(endpoint, path, limit, timeout, progress)).await {
                Err(error) if gh_unusable(&error) => {
                    // gh ran and was refused: the file is the one its download
                    // just created (create_new), empty or partial. A gh that
                    // never started (gh_missing) created nothing.
                    if error.to_string().starts_with("not_authenticated:") {
                        match tokio::fs::remove_file(path).await {
                            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                            _ => {}
                        }
                    }
                    progress.store(0, Ordering::Relaxed);
                    self.via = Via::Public;
                }
                answer => return answer,
            }
        }
        Box::pin(self.public.download(endpoint, path, limit, timeout, progress)).await
    }
}

fn gh_unusable(error: &anyhow::Error) -> bool {
    let text = error.to_string();
    text.starts_with("gh_missing:") || text.starts_with("not_authenticated:")
}

pub struct PublicGithub {
    /// How long a release list may take (gh's read deadline).
    pub(crate) deadline: Duration,
    #[cfg(test)]
    pub(crate) test: Option<stand_in::Host>,
}
impl Default for PublicGithub {
    fn default() -> Self {
        Self {
            deadline: Duration::from_secs(12),
            #[cfg(test)]
            test: None,
        }
    }
}

#[derive(Clone, Copy)]
enum Shape {
    List,
    Asset,
}

/// `repos/<owner>/<repo>/releases?per_page=100` or
/// `repos/<owner>/<repo>/releases/assets/<id>`, nothing else.
fn check_shape(endpoint: &str, shape: Shape) -> Result<()> {
    let parts = endpoint.strip_prefix("repos/").and_then(|rest| match shape {
        Shape::List => rest.strip_suffix("/releases?per_page=100").map(|repo| (repo, true)),
        Shape::Asset => rest.split_once("/releases/assets/").map(|(repo, id)| {
            (repo, !id.is_empty() && id.len() <= 19 && !id.starts_with('0') && id.bytes().all(|b| b.is_ascii_digit()))
        }),
    });
    let valid = parts.is_some_and(|(repo, id)| {
        id && crate::github::client::parse(repo, false).is_ok_and(|target| target.repo == repo)
    });
    ensure!(valid, "Only a release list or a release asset is read without gh");
    Ok(())
}

/// Where a redirect leads: an https address, or a path on the same host.
/// Never another scheme, and never an address that carries a sign-in.
fn redirect(from: &Uri, location: &str) -> Result<Uri> {
    let to: Uri = if location.starts_with('/') && !location.starts_with("//") {
        let authority = from.authority().context("unavailable: GitHub's redirect has no host")?;
        format!("https://{authority}{location}").parse()
    } else {
        location.parse()
    }
    .map_err(|_| anyhow!("unavailable: GitHub redirected to an unreadable address"))?;
    ensure!(
        to.scheme_str() == Some("https") && to.host().is_some_and(|h| !h.is_empty()) && !to.authority().is_some_and(|a| a.as_str().contains('@')),
        "unavailable: GitHub redirected to an address that is not plain HTTPS; it was not followed"
    );
    Ok(to)
}

const RATE_LIMITED: &str = "rate_limited: GitHub's limit for reads without a gh sign-in (60 an hour per address) was reached; retry later or sign in with gh on the Core host";

/// GitHub's refusal, in the kinds gh's errors use.
fn refusal(status: StatusCode, headers: &HeaderMap) -> anyhow::Error {
    let spent = headers.get("x-ratelimit-remaining").is_some_and(|v| v.as_bytes() == b"0");
    anyhow!(match status.as_u16() {
        429 => RATE_LIMITED.to_owned(),
        403 if spent => RATE_LIMITED.to_owned(),
        404 => "not_found: GitHub release or asset was not found; if the repository is not public, sign in with gh on the Core host".to_owned(),
        401 | 403 => "forbidden: GitHub refused a read without a gh sign-in; sign in with gh on the Core host".to_owned(),
        code => format!("unavailable: GitHub answered HTTP {code}"),
    })
}

/// An error's chain as one short line of plain text.
fn said(error: &(dyn std::error::Error + 'static)) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text.chars().filter(|c| !c.is_control()).take(300).collect()
}

impl PublicGithub {
    fn base(&self) -> &str {
        #[cfg(test)]
        if let Some(host) = &self.test {
            return &host.base;
        }
        API
    }

    fn roots(&self) -> rustls::RootCertStore {
        #[allow(unused_mut)]
        let mut roots = crate::https::roots();
        #[cfg(test)]
        if let Some(host) = &self.test {
            roots.add(host.root.clone()).expect("the stand-in's certificate");
        }
        roots
    }

    fn var(&self, name: &str) -> Option<String> {
        #[cfg(test)]
        if let Some(host) = &self.test {
            return host.env.iter().find(|(key, _)| *key == name).map(|(_, value)| value.clone());
        }
        std::env::var(name).ok()
    }

    /// The proxy, as gh takes it: `HTTPS_PROXY` (or `https_proxy`) except for
    /// hosts `NO_PROXY` (or `no_proxy`) names. No other variable, setting or
    /// system proxy. One that is set but unusable stops the read; it never
    /// means going around it.
    fn proxy(&self) -> Result<Matcher> {
        let read = |upper: &str, lower: &str| self.var(upper).or_else(|| self.var(lower)).unwrap_or_default();
        let (https, no) = (read("HTTPS_PROXY", "https_proxy"), read("NO_PROXY", "no_proxy"));
        if !https.trim().is_empty() {
            let usable = Matcher::builder().https(https.as_str()).build().intercept(&Uri::from_static(API));
            ensure!(
                usable.is_some_and(|proxy| proxy.uri().scheme_str() == Some("http")),
                "unavailable: HTTPS_PROXY is not an http:// proxy address that Core can use for reads without gh"
            );
        }
        Ok(Matcher::builder().https(https).no(no).build())
    }

    /// One request to `url`, as it was answered, redirects included.
    async fn send(&self, url: &Uri, accept: &'static str) -> Result<Response<impl HttpBody<Data = Bytes, Error = impl std::error::Error + Send + Sync + 'static> + Unpin>> {
        let request = Request::get(url.clone())
            .header(header::ACCEPT, accept)
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header(header::USER_AGENT, USER_AGENT)
            .body(Empty::<Bytes>::new())?;
        let sent = match self.proxy()?.intercept(url) {
            None => crate::https::direct(self.roots())?.request(request).await,
            Some(proxy) => {
                crate::https::tunnelled(self.roots(), proxy.uri().clone(), proxy.basic_auth().cloned())?.request(request).await
            }
        };
        sent.map_err(|error| anyhow!("unavailable: GitHub could not be reached without gh: {}", said(&error)))
    }

    /// GitHub's 200 answer to `endpoint`, after at most five redirects.
    async fn open(&self, endpoint: &str, accept: &'static str) -> Result<Response<impl HttpBody<Data = Bytes, Error = impl std::error::Error + Send + Sync + 'static> + Unpin>> {
        let mut url: Uri = format!("{}/{endpoint}", self.base()).parse().context("Invalid GitHub endpoint")?;
        let mut redirects = 0;
        loop {
            let response = self.send(&url, accept).await?;
            let status = response.status();
            if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
                ensure!(redirects < MAX_REDIRECTS, "unavailable: GitHub redirected more than {MAX_REDIRECTS} times; the read stopped");
                redirects += 1;
                let location = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .context("unavailable: GitHub redirected without an address")?;
                url = redirect(&url, location)?;
                continue;
            }
            if status != StatusCode::OK {
                return Err(refusal(status, response.headers()));
            }
            return Ok(response);
        }
    }

    /// A release list, as JSON (at most 8 MiB, within `deadline`).
    pub async fn get_json(&self, endpoint: &str) -> Result<Value> {
        check_shape(endpoint, Shape::List)?;
        let read = async {
            let response = self.open(endpoint, "application/vnd.github+json").await?;
            let body = Limited::new(response.into_body(), MAX_JSON).collect().await.map_err(|error| {
                if error.is::<LengthLimitError>() {
                    anyhow!("response_too_large: GitHub response exceeded the read limit")
                } else {
                    anyhow!("unavailable: GitHub's answer was cut off: {}", said(error.as_ref()))
                }
            })?;
            serde_json::from_slice(&body.to_bytes()).context("invalid_response: GitHub returned unreadable JSON")
        };
        match tokio::time::timeout(self.deadline, read).await {
            Ok(answer) => answer,
            Err(_) => bail!("timeout: GitHub read timed out"),
        }
    }

    /// One release asset into a new file at `path`, as gh's download does:
    /// at most `limit` bytes, within `timeout`, counting into `progress`.
    pub async fn download(&self, endpoint: &str, path: &Path, limit: u64, timeout: Duration, progress: &AtomicU64) -> Result<()> {
        check_shape(endpoint, Shape::Asset)?;
        let transfer = async {
            let response = self.open(endpoint, "application/octet-stream").await?;
            let announced = response
                .headers()
                .get(header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok()?.parse::<u64>().ok());
            ensure!(announced.is_none_or(|n| n <= limit), "Release download exceeded its size limit");
            let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(path).await?;
            let mut body = response.into_body();
            let mut total = 0u64;
            while let Some(frame) = body.frame().await {
                let frame = frame.map_err(|error| anyhow!("unavailable: GitHub's download was cut off: {}", said(&error)))?;
                let Ok(data) = frame.into_data() else { continue };
                total = total.checked_add(data.len() as u64).context("Release size overflow")?;
                ensure!(total <= limit, "Release download exceeded its size limit");
                file.write_all(&data).await?;
                progress.store(total, Ordering::Relaxed);
            }
            file.sync_all().await?;
            Ok(())
        };
        match tokio::time::timeout(timeout, transfer).await {
            Ok(result) => result,
            Err(_) => bail!("timeout: GitHub release download timed out"),
        }
    }
}

#[cfg(test)]
pub(crate) mod stand_in;
#[cfg(all(test, unix))]
mod tests;
