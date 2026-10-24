//! Fixed Git objects are inert evidence. Model tools never accept commands,
//! arbitrary revisions, URLs or worktree paths.
mod added_source;
mod arguments;
mod git;
pub(super) mod scope;
mod search_recovery;
#[cfg(test)]
mod continuation_tests;
#[cfg(test)]
mod incremental_tests;
#[cfg(test)]
mod tests;
use crate::github::client::Client;
use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path};

const MAX_RESPONSE: usize = 64_000;
const PAGE_BYTES: usize = 12_000; // Raw page target; serialized envelopes are checked below.
const MAX_LINES: usize = 500;
pub(super) const MAX_CONTEXT: usize = 1_500_000;
pub(super) const MAX_CALLS: usize = 160;
const PAGE_ITEMS: usize = 20;
const MAX_IDENTICAL_FAILURES: usize = 3;

// Separate from verdict policy: absent/older versions keep diff-only coverage.
// 2 accepts complete added-source reads; 3 also reports each path's scope.
pub(super) const COVERAGE_VERSION: u64 = 3;

pub(super) const TOOL_NAMES: &[&str] = &[
    "review_changes",
    "source_diff",
    "source_paths",
    "source_search",
    "source_read",
];

pub(super) fn sha(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .context("GitHub did not provide a fixed commit SHA")
}
fn path_check(path: &str) -> Result<()> {
    ensure!(
        !path.is_empty()
            && path.len() <= 1000
            && !path.contains(['\\', '\0'])
            && path
                .split('/')
                .all(|p| !p.is_empty() && p != "." && p != ".."),
        "Use a repository-relative source path"
    );
    Ok(())
}
fn revision<'a>(run: &'a Value, name: &str) -> Result<&'a str> {
    match name {
        "head" => sha(&run["headSha"]),
        "mergeBase" => sha(&run["mergeBaseSha"]),
        _ => anyhow::bail!("Only frozen head or mergeBase can be read"),
    }
}

#[derive(Clone)]
struct Entry {
    path: String,
    blob: String,
    mode: String,
}
#[derive(Clone)]
struct Failure {
    kind: &'static str,
    receipt: usize,
    tool: String,
    input: Value,
    revision: Option<String>,
    ranges: Vec<(usize, usize)>,
    resolved: bool,
    correction_scope: Option<Value>,
    resolved_by: Option<usize>,
    recovery_source: Option<Value>,
    /// The blob of the source a read failure is bound to, and the receipts
    /// whose delivered ranges of that blob count toward its recovery.
    recovery_blob: Option<String>,
    recovery_receipts: Vec<usize>,
    search_recovery: Option<search_recovery::Recovery>,
}

/// A source no tool can deliver as text: its message, and the reason code
/// the review scope records for it (scope.rs).
#[derive(Debug)]
struct UnsupportedSource(&'static str, &'static str);
impl std::fmt::Display for UnsupportedSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for UnsupportedSource {}

fn text_of(raw: Vec<u8>) -> Result<String> {
    if raw.contains(&0) {
        return Err(UnsupportedSource("Binary source cannot be inspected as text", "binary").into());
    }
    String::from_utf8(raw).map_err(|_| UnsupportedSource("Source is not UTF-8 text", "not_utf8").into())
}

pub(super) struct ContextStore {
    git: git::Git,
    trees: HashMap<String, Vec<Entry>>,
    search_path_sets: HashMap<(String, String), search_recovery::PathSet>,
    patches: HashMap<String, String>,
    patch_bytes: usize,
    delivered: HashMap<String, Vec<(usize, usize)>>,
    added_sources: added_source::AddedSources,
    failures: Vec<Failure>,
    receipts: Vec<Value>,
    bytes: usize,
    terminal: Option<String>,
    repeated_failure_limit: bool,
    scope: scope::Preflight,
    /// The calls and bytes this run may use: the whole review budget, or
    /// what a continuation reserved from its parent's remainder.
    max_calls: usize,
    max_bytes: usize,
    reserved: bool,
    /// A continuation's parent proofs of paths whose fixed identity this
    /// run verified, and the parent's unresolved requests on changed paths.
    inherited: Vec<Value>,
    inherited_failures: Vec<Value>,
}
impl ContextStore {
    fn new(git: git::Git) -> Self {
        Self {
            git,
            trees: HashMap::new(),
            search_path_sets: HashMap::new(),
            patches: HashMap::new(),
            patch_bytes: 0,
            delivered: HashMap::new(),
            added_sources: added_source::AddedSources::default(),
            failures: Vec::new(),
            receipts: Vec::new(),
            bytes: 0,
            terminal: None,
            repeated_failure_limit: false,
            scope: scope::Preflight::default(),
            max_calls: MAX_CALLS,
            max_bytes: MAX_CONTEXT,
            reserved: false,
            inherited: Vec::new(),
            inherited_failures: Vec::new(),
        }
    }
    /// A continuation runs only within what it reserved from its parent's
    /// remaining budget; nothing here is refilled.
    pub(super) fn reserve(&mut self, calls: usize, bytes: usize) {
        self.max_calls = calls.min(MAX_CALLS);
        self.max_bytes = bytes.min(MAX_CONTEXT);
        self.reserved = true;
    }
    /// The parent's covered proofs and unresolved requests, kept with their
    /// review identity. Only proofs of the same path and blob ever count.
    pub(super) fn inherit(&mut self, proofs: Vec<Value>, failures: Vec<Value>) {
        self.inherited = proofs;
        self.inherited_failures = failures;
    }
    pub(super) fn refresh(&self, run: &mut Value) {
        self.coverage(run);
    }
    pub(super) fn bytes(&self) -> usize {
        self.bytes
    }
    pub(super) fn set_evidence_bytes(&mut self, bytes: usize) {
        self.bytes = bytes;
    }
    fn exhausted(&self) -> String {
        if self.reserved {
            format!("Continuation budget exhausted ({} calls / {} bytes reserved from the parent round's remainder); remaining coverage is incomplete", self.max_calls, self.max_bytes)
        } else {
            "Review context budget exhausted (160 calls / 1.5 MB); remaining coverage is incomplete".into()
        }
    }
    async fn tree(&mut self, revision: &str) -> Result<&[Entry]> {
        if !self.trees.contains_key(revision) {
            let raw = self
                .git
                .metadata(&["ls-tree", "-r", "-z", revision])
                .await?;
            let mut entries = Vec::new();
            for row in raw.split(|b| *b == 0).filter(|b| !b.is_empty()) {
                let row = std::str::from_utf8(row)
                    .context("Non-UTF8 path cannot be represented in review tools")?;
                let (meta, path) = row.split_once('\t').context("Invalid Git tree entry")?;
                let parts: Vec<_> = meta.split(' ').collect();
                ensure!(parts.len() == 3, "Invalid Git tree metadata");
                entries.push(Entry {
                    path: path.into(),
                    blob: parts[2].into(),
                    mode: parts[0].into(),
                });
            }
            self.trees.insert(revision.into(), entries);
        }
        Ok(&self.trees[revision])
    }
    async fn entry(&mut self, revision: &str, path: &str) -> Result<Entry> {
        path_check(path)?;
        self.tree(revision)
            .await?
            .iter()
            .find(|e| e.path == path)
            .cloned()
            .context("Source path does not exist at the frozen revision")
    }
    async fn text(&self, entry: &Entry) -> Result<String> {
        text_of(self.raw(entry).await?)
    }
    /// A regular file's bytes; links and submodules are refused unread.
    async fn raw(&self, entry: &Entry) -> Result<Vec<u8>> {
        if !matches!(entry.mode.as_str(), "100644" | "100755") {
            return Err(UnsupportedSource(
                "Source is not a regular file; links and submodules are never followed",
                match entry.mode.as_str() {
                    "120000" => "symlink",
                    "160000" => "submodule",
                    _ => "special_file",
                },
            )
            .into());
        }
        // Git verifies fetched object identity; blob bytes never enter a checkout.
        self.git
            .run(
                &["cat-file", "blob", &entry.blob],
                git::DISK_BUDGET as usize,
            )
            .await
    }
    async fn prepare(&mut self, run: &mut Value) -> Result<()> {
        let base = sha(&run["mergeBaseSha"])?.to_owned();
        let head = sha(&run["headSha"])?.to_owned();
        // No rename heuristics: a rename is a deletion + addition, preserving
        // every change without fetching unrelated blobs for similarity scoring.
        let raw = self
            .git
            .metadata(&[
                "diff-tree",
                "--no-commit-id",
                "--raw",
                "-r",
                "-z",
                "--no-abbrev",
                "--no-renames",
                &base,
                &head,
            ])
            .await?;
        let mut records = raw.split(|b| *b == 0).filter(|b| !b.is_empty());
        let mut files = Vec::new();
        while let Some(meta) = records.next() {
            let path = std::str::from_utf8(records.next().context("Missing changed path")?)?;
            let meta = std::str::from_utf8(meta)?;
            let parts: Vec<_> = meta.split(' ').collect();
            ensure!(parts.len() == 5, "Invalid Git change metadata");
            let removed = parts[4] == "D";
            self.scope.sides.insert(path.into(), [parts[2].into(), parts[3].into()]);
            files.push(json!({"path":path,"status":match parts[4] {"D"=>"removed","A"=>"added",_=>"modified"},
                "sourceBlob":if removed {parts[2]} else {parts[3]},"sourceRevision":if removed {&base} else {&head},
                "oldMode":parts[0].trim_start_matches(':'),"modeAtHead":parts[1],"lines":null}));
        }
        ensure!(!files.is_empty(), "PR has no changes to review");
        run["files"] = json!(files);
        run["fileCount"] = json!(files.len());
        if scope::applies(run) {
            self.preflight(run).await;
        }
        self.coverage(run);
        Ok(())
    }
    fn changes(&self, run: &Value, cursor: usize) -> Result<Value> {
        let files = run["files"].as_array().context("Missing change manifest")?;
        arguments::check(
            cursor <= files.len(),
            "cursor",
            "Change cursor is past the end; start at 0 or use the returned nextCursor",
        )?;
        let mut end = (cursor + PAGE_ITEMS).min(files.len());
        loop {
            let page = json!({"files":&files[cursor..end],"totalFiles":files.len(),"nextCursor":if end<files.len() {Some(end)} else {None},"comparison":run["comparison"]});
            if serde_json::to_vec(&page)?.len() <= MAX_RESPONSE {
                return Ok(page);
            }
            ensure!(
                end - cursor > 1,
                "A changed-file metadata entry cannot fit the response budget"
            );
            end = cursor + (end - cursor) / 2;
        }
    }
    async fn diff(&mut self, run: &mut Value, path: &str, offset: usize) -> Result<Value> {
        path_check(path)?;
        let index = run["files"]
            .as_array()
            .context("Missing changes")?
            .iter()
            .position(|f| f["path"] == path)
            .context("Path is outside this PR's changed files")?;
        self.patch(run, index).await?;
        let patch = &self.patches[path];
        if patch.len() > MAX_CONTEXT && scope::applies(run) {
            self.scope.exceeds_context.entry(path.into()).or_insert((Some(patch.len()), "during_review"));
        }
        arguments::check(
            offset < patch.len() && patch.is_char_boundary(offset),
            "offset",
            "Diff offset must be an existing UTF-8 byte boundary; start at zero or returned nextOffset",
        )?;
        let mut end = (offset + PAGE_BYTES).min(patch.len());
        loop {
            while !patch.is_char_boundary(end) {
                end -= 1;
            }
            ensure!(end > offset, "Diff metadata cannot fit the response budget");
            let page = json!({"path":path,"revision":run["files"][index]["sourceRevision"],"blobSha":run["files"][index]["sourceBlob"],
                "offset":offset,"endOffset":end,"totalBytes":patch.len(),"nextOffset":if end<patch.len() {Some(end)} else {None},"patch":&patch[offset..end]});
            if serde_json::to_vec(&page)?.len() <= MAX_RESPONSE {
                return Ok(page);
            }
            // Control characters can expand sixfold. Shrink the actual JSON
            // envelope, preserving UTF-8 boundaries and a gap-free cursor.
            end = offset + (end - offset) / 2;
        }
    }
    /// A continuation's target, checked by Core before any model starts: the
    /// bytes every source_diff page of it delivers, envelopes included, as
    /// they will count against the budget; or why no tool can deliver it as
    /// text. A diff larger than `limit` can't fit and isn't paged.
    pub(super) async fn measure(&mut self, run: &mut Value, path: &str, limit: usize) -> Result<usize> {
        let index = run["files"]
            .as_array()
            .context("Missing changes")?
            .iter()
            .position(|f| f["path"] == path)
            .context("Path is outside this PR's changed files")?;
        self.patch(run, index).await?;
        let size = self.patches[path].len();
        if size > limit {
            return Ok(size);
        }
        let (mut total, mut offset) = (0, 0);
        loop {
            let page = self.diff(run, path, offset).await?;
            total += serde_json::to_vec(&page)?.len();
            match page["nextOffset"].as_u64() {
                Some(next) => offset = next as usize,
                None => return Ok(total),
            }
        }
    }
    /// One changed file's complete patch, kept for paging.
    async fn patch(&mut self, run: &mut Value, index: usize) -> Result<()> {
        let path = run["files"][index]["path"].as_str().context("Missing changed path")?.to_owned();
        let path = path.as_str();
        if !self.patches.contains_key(path) {
            let base = sha(&run["mergeBaseSha"])?.to_owned();
            let head = sha(&run["headSha"])?.to_owned();
            let file = &run["files"][index];
            let rev = file["sourceRevision"]
                .as_str()
                .context("Missing source revision")?
                .to_owned();
            let entry = self.entry(&rev, path).await?;
            let text = self.text(&entry).await?;
            // Check both sides so Git's binary marker is never mistaken for a
            // delivered textual diff. Mode-only regular-file changes are valid.
            if file["status"] == "modified" {
                let old = self.entry(&base, path).await?;
                self.text(&old).await?;
            }
            run["files"][index]["lines"] = json!(text.lines().count());
            let remaining = 16_000_000usize.saturating_sub(self.patch_bytes);
            ensure!(remaining > 0, "Local diff cache budget exhausted (16 MB)");
            let raw = self
                .git
                .run(
                    &[
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--text",
                        "--no-renames",
                        "--no-color",
                        "--unified=3",
                        &base,
                        &head,
                        "--",
                        path,
                    ],
                    remaining,
                )
                .await?;
            let patch = String::from_utf8(raw).context("Diff is not UTF-8 text")?;
            ensure!(!patch.is_empty(), "Changed file has no inspectable diff");
            self.patch_bytes += patch.len();
            self.patches.insert(path.into(), patch);
        }
        Ok(())
    }
    /// What tree metadata says before any reviewer starts (coverage policy
    /// 3): links, submodules and other special entries on either side, and
    /// the base's scope policy. No changed blob is fetched for this: they
    /// stay lazy, as the reviewer's own reads need them.
    async fn preflight(&mut self, run: &mut Value) {
        let Ok(base) = sha(&run["baseSha"]).map(str::to_owned) else {
            return;
        };
        let files = run["files"].as_array().cloned().unwrap_or_default();
        // The policy as it is at base: what this PR changes in it applies to
        // later reviews only.
        let found = match self.tree(&base).await.map(|t| t.iter().find(|e| e.path == scope::POLICY_PATH).cloned()) {
            Ok(None) => None,
            Ok(Some(entry)) => Some((entry.blob.clone(), self.raw(&entry).await.map_err(|e| e.to_string()))),
            Err(error) => Some((String::new(), Err(error.to_string()))),
        };
        self.scope.set_policy(found, &base, &files);
        for file in &files {
            let path = file["path"].as_str().unwrap_or_default().to_owned();
            let [old, new] = self.scope.sides.get(&path).cloned().unwrap_or_default();
            let mut unsupported = Vec::new();
            for (side, mode, blob, present) in [
                ("mergeBase", &file["oldMode"], old, file["status"] != "added"),
                ("head", &file["modeAtHead"], new, file["status"] != "removed"),
            ] {
                let reason = match mode.as_str() {
                    Some("100644" | "100755") => None,
                    Some("120000") => Some("symlink"),
                    Some("160000") => Some("submodule"),
                    _ => Some("special_file"),
                };
                if let (true, Some(reason)) = (present, reason) {
                    unsupported.push(json!({"side":side,"reason":reason,"blobSha":blob,"mode":mode,"found":"before_review"}));
                }
            }
            if !unsupported.is_empty() {
                self.scope.unsupported.insert(path, unsupported);
            }
        }
    }
    /// After the reviewer has finished, outside its deadline (the caller
    /// bounds and can stop this; a stop never changes the review's result):
    /// what the fixed objects say about each changed path it left uncovered,
    /// starting no path after `deadline`. Each regular
    /// side is fetched and classified (binary or not UTF-8, with the
    /// content's SHA-256), and a readable path's complete diff is measured.
    /// It never sets the review's terminal limit and can't take budget or
    /// time from the review; whatever it can't check is recorded as such.
    pub async fn postflight(&mut self, run: &mut Value, deadline: std::time::Instant) {
        if !scope::applies(run) {
            return;
        }
        let (Ok(merge), Ok(head)) = (sha(&run["mergeBaseSha"]).map(str::to_owned), sha(&run["headSha"]).map(str::to_owned)) else {
            return;
        };
        self.coverage(run);
        let files = run["files"].as_array().cloned().unwrap_or_default();
        let paths = run["scope"]["paths"].as_array().cloned().unwrap_or_default();
        let mut stopped: Option<String> = self
            .terminal
            .as_deref()
            .filter(|t| t.starts_with("Review object storage budget"))
            .map(str::to_owned);
        for (index, file) in files.iter().enumerate() {
            let path = file["path"].as_str().unwrap_or_default().to_owned();
            let state = paths.iter().find(|p| p["path"] == path.as_str()).map(|p| p["state"].clone());
            let checked_before = self.scope.unsupported.get(&path).is_some_and(|f| f.iter().all(|f| f["found"] == "before_review"));
            if state.as_ref().is_none_or(|s| s == "covered") || checked_before || self.scope.exceeds_context.contains_key(&path) {
                continue;
            }
            // A path starts only with one fixed operation's time (45 s) left;
            // the caller's own hard limit stops a path that needs more.
            if stopped.is_none() && std::time::Instant::now() + std::time::Duration::from_secs(45) > deadline {
                stopped = Some("Not checked: the review's time ran short".into());
            }
            if let Some(reason) = &stopped {
                self.scope.unchecked.insert(path, reason.clone());
                continue;
            }
            let mut unsupported = Vec::new();
            let mut failed = None;
            for (side, revision, present) in [("mergeBase", &merge, file["status"] != "added"), ("head", &head, file["status"] != "removed")] {
                if !present {
                    continue;
                }
                let checked = match self.entry(revision, &path).await {
                    Ok(entry) => self.raw(&entry).await.map(|raw| (entry, raw)),
                    Err(error) => Err(error),
                };
                match checked {
                    Ok((entry, raw)) => {
                        let digest = format!("{:x}", Sha256::digest(&raw));
                        if let Err(error) = text_of(raw) {
                            let reason = error.downcast_ref::<UnsupportedSource>().map_or("binary", |u| u.1);
                            unsupported.push(json!({"side":side,"reason":reason,"blobSha":entry.blob,"mode":entry.mode,
                                "contentSha256":digest,"found":"after_review"}));
                        }
                    }
                    Err(error) => {
                        failed = Some(error.to_string());
                        break;
                    }
                }
            }
            if !unsupported.is_empty() {
                self.scope.unsupported.insert(path, unsupported);
                continue;
            }
            if let Some(message) = failed {
                if message.starts_with("Review object storage budget") {
                    stopped = Some(message.clone());
                }
                self.scope.unchecked.insert(path, message);
                continue;
            }
            let cached = self.patches.contains_key(&path);
            match self.patch(run, index).await {
                Ok(()) => {
                    let size = self.patches[&path].len();
                    if !cached {
                        self.patches.remove(&path);
                        self.patch_bytes -= size;
                    }
                    if size > MAX_CONTEXT {
                        self.scope.exceeds_context.insert(path, (Some(size), "after_review"));
                    }
                }
                Err(error) => {
                    let message = error.to_string();
                    if message.starts_with("Fixed source operation exceeded its byte budget") {
                        // Larger than the whole local diff cache (16 MB).
                        self.scope.exceeds_context.insert(path, (None, "after_review"));
                    } else {
                        if message.starts_with("Review object storage budget") {
                            stopped = Some(message.clone());
                        }
                        self.scope.unchecked.insert(path, message);
                    }
                }
            }
        }
        self.coverage(run);
    }
    async fn read(&mut self, run: &mut Value, request: Read) -> Result<Value> {
        arguments::check(
            request.start_line > 0,
            "startLine",
            "startLine must be a positive 1-based line",
        )?;
        arguments::check(
            request.end_line >= request.start_line,
            "endLine",
            "endLine must be at least startLine",
        )?;
        arguments::check(
            request.end_line - request.start_line < MAX_LINES,
            "endLine",
            "Request an inclusive 1-based range of at most 500 lines; split larger ranges",
        )?;
        let rev = revision(run, &request.revision)?.to_owned();
        let entry = self.entry(&rev, &request.path).await?;
        let text = self.text(&entry).await?;
        let total = text.lines().count();
        ensure!(
            request.start_line <= total || (total == 0 && request.start_line == 1),
            "Requested start line is past end of source"
        );
        let end = request.end_line.min(total);
        let start_byte: usize = text
            .split_inclusive('\n')
            .take(request.start_line - 1)
            .map(str::len)
            .sum();
        let excerpt: String = text
            .split_inclusive('\n')
            .skip(request.start_line - 1)
            .take(end.saturating_sub(request.start_line - 1))
            .collect();
        let change = run["files"].as_array_mut().and_then(|files| {
            files
                .iter_mut()
                .find(|file| {
                    file["path"] == entry.path
                        && file["sourceRevision"] == rev
                        && file["sourceBlob"] == entry.blob
                })
                .map(|file| {
                    file["lines"] = json!(total);
                    file.clone()
                })
        });
        Ok(
            json!({"path":entry.path,"revision":rev,"blobSha":entry.blob,"startLine":request.start_line,"endLine":end,
            "totalLines":total,"sourceBytes":text.len(),"startByte":start_byte,"endByte":start_byte+excerpt.len(),
            "source":excerpt,"mode":entry.mode,"change":change}),
        )
    }
    async fn paths(&mut self, run: &Value, request: Paths) -> Result<Value> {
        arguments::check(
            request.query.len() <= 200,
            "query",
            "Path query exceeds 200 bytes",
        )?;
        let rev = revision(run, &request.revision)?;
        let entries = self.tree(rev).await?;
        arguments::check(
            request.cursor <= entries.len(),
            "cursor",
            "Path cursor is past the end; start at 0 or use the returned nextCursor",
        )?;
        let mut paths = Vec::new();
        let mut next = request.cursor;
        while next < entries.len() && paths.len() < PAGE_ITEMS {
            let e = &entries[next];
            if e.path.contains(&request.query) {
                paths.push(json!({"path":e.path,"blobSha":e.blob,"mode":e.mode}));
                let page = json!({"revision":rev,"paths":paths,"nextCursor":next+1});
                if serde_json::to_vec(&page)?.len() > MAX_RESPONSE {
                    paths.pop();
                    ensure!(
                        !paths.is_empty(),
                        "A path entry cannot fit the response budget"
                    );
                    break; // next still points at the undelivered entry.
                }
            }
            next += 1;
        }
        Ok(
            json!({"revision":rev,"paths":paths,"nextCursor":if next<entries.len() {Some(next)} else {None}}),
        )
    }
    async fn search(&mut self, run: &Value, request: Search) -> Result<Value> {
        arguments::check(
            !request.query.is_empty()
                && request.query.len() <= 200
                && !request.query.contains(['\n', '\r', '\0']),
            "query",
            "Search needs 1–200 bytes of literal text on one line",
        )?;
        arguments::check(
            request.path_prefix.len() <= 1000,
            "pathPrefix",
            "Path prefix is too long (maximum 1000 bytes)",
        )?;
        let rev = revision(run, &request.revision)?;
        let (mut index, mut line) = arguments::search_cursor(&request.cursor)?;
        let entries = self.tree(rev).await?.to_vec();
        arguments::check(
            index <= entries.len(),
            "cursor",
            "Search cursor is past the end; start at 0:1 or use the returned nextCursor",
        )?;
        let mut matches = Vec::new();
        let mut skipped = Vec::new();
        let mut scanned = 0;
        let mut returned = 0;
        while index < entries.len()
            && scanned < 8
            && matches.len() < PAGE_ITEMS
            && returned < PAGE_BYTES
        {
            let entry = &entries[index];
            if !entry.path.starts_with(&request.path_prefix) {
                index += 1;
                line = 1;
                continue;
            }
            scanned += 1;
            if !matches!(entry.mode.as_str(), "100644" | "100755") {
                let item = json!({"path":entry.path,"reason":"not a regular file"});
                returned += serde_json::to_vec(&item)?.len();
                skipped.push(item);
                index += 1;
                line = 1;
                continue;
            }
            let raw = self
                .git
                .run(
                    &["cat-file", "blob", &entry.blob],
                    git::DISK_BUDGET as usize,
                )
                .await?;
            let text = if !raw.contains(&0) {
                String::from_utf8(raw).ok()
            } else {
                None
            };
            let Some(text) = text else {
                let item = json!({"path":entry.path,"reason":"binary or non-UTF8 source excluded from text search"});
                returned += serde_json::to_vec(&item)?.len();
                skipped.push(item);
                index += 1;
                line = 1;
                continue;
            };
            let mut paused = false;
            for (n, content) in text.lines().enumerate().skip(line - 1) {
                if content.contains(&request.query) {
                    // Keep whole line locations while bounding the preview.
                    let mut end = content.len().min(500);
                    while !content.is_char_boundary(end) {
                        end -= 1;
                    }
                    let found = json!({"path":entry.path,"blobSha":entry.blob,"line":n+1,"preview":&content[..end],"previewTruncated":end<content.len()});
                    returned += serde_json::to_vec(&found)?.len();
                    matches.push(found);
                }
                line = n + 2;
                if matches.len() == PAGE_ITEMS || returned >= PAGE_BYTES {
                    paused = true;
                    break;
                }
            }
            if paused {
                break;
            }
            index += 1;
            line = 1;
        }
        Ok(
            json!({"revision":rev,"query":request.query,"pathPrefix":request.path_prefix,"matches":matches,"skipped":skipped,
            "nextCursor":if index<entries.len() {Some(format!("{index}:{line}"))} else {None},"searchedFilesThisPage":scanned}),
        )
    }
    async fn execute(&mut self, run: &mut Value, tool: &str, input: Value) -> Result<Value> {
        match tool {
            "review_changes" => {
                let r: Cursor = arguments::parse(input)?;
                self.changes(run, r.cursor)
            }
            "source_diff" => {
                let r: Diff = arguments::parse(input)?;
                self.diff(run, &r.path, r.offset).await
            }
            "source_read" => self.read(run, arguments::parse(input)?).await,
            "source_paths" => self.paths(run, arguments::parse(input)?).await,
            "source_search" => self.search(run, arguments::parse(input)?).await,
            _ => anyhow::bail!("Unknown source tool"),
        }
    }
    pub async fn response(&mut self, run: &mut Value, tool: &str, mut input: Value) -> Value {
        if serde_json::to_vec(&input).map_or(true, |v| v.len() > 16_000) {
            input = json!({"rejected":"Tool arguments exceed 16 KB"});
        }
        let result = async {
            ensure!(self.terminal.is_none(), "{}", self.terminal.as_deref().unwrap_or(""));
            if self.receipts.len() >= self.max_calls || self.bytes >= self.max_bytes {
                self.terminal = Some(self.exhausted());
                anyhow::bail!(self.terminal.clone().unwrap());
            }
            let value = self.execute(run,tool,input.clone()).await?;
            let size = serde_json::to_vec(&value)?.len();
            ensure!(size <= MAX_RESPONSE, "Tool response exceeds 64 KB; request a smaller range");
            if size + self.bytes > self.max_bytes {
                self.terminal = Some(if self.reserved {
                    format!("Continuation byte budget exhausted ({} bytes reserved); response was not delivered", self.max_bytes)
                } else {
                    "Review context byte budget exhausted (1.5 MB); response was not delivered".into()
                });
                anyhow::bail!(self.terminal.clone().unwrap());
            }
            self.bytes += size;
            Ok::<Value,anyhow::Error>(value)
        }.await;
        let value = match result {
            Ok(value) => {
                self.accept(run, tool, &input, &value);
                value
            }
            Err(error) => {
                let message = error.to_string();
                if message.starts_with("Review object storage budget")
                    || message.starts_with("Local diff cache budget")
                    || message.starts_with("Fixed source operation exceeded its byte budget")
                {
                    self.terminal = Some(message.clone());
                }
                let fixed = input["revision"]
                    .as_str()
                    .and_then(|s| revision(run, s).ok())
                    .map(str::to_owned);
                let correction_scope = if self.terminal.is_none() {
                    error
                        .downcast_ref::<arguments::InvalidArguments>()
                        .map(|e| e.correction_scope(tool, &input))
                } else {
                    None
                };
                let identical_failures = 1 + self
                    .failures
                    .iter()
                    .filter(|f| f.tool == tool && f.input == input)
                    .count();
                if identical_failures >= MAX_IDENTICAL_FAILURES && self.terminal.is_none() {
                    self.repeated_failure_limit = true;
                    self.terminal = Some(format!(
                        "Repeated source tool failure: {tool} received identical unsuccessful arguments {identical_failures} times; review stopped with incomplete coverage"
                    ));
                }
                // A changed path the reviewer's own request found no tool can
                // deliver: recorded in the scope as found during the review.
                if let (Some(unsupported), Some(path)) = (error.downcast_ref::<UnsupportedSource>(), input["path"].as_str()) {
                    if scope::applies(run) && run["files"].as_array().is_some_and(|f| f.iter().any(|f| f["path"] == path)) {
                        self.scope.found_during_review(path, unsupported.1);
                    }
                }
                let kind = if error.is::<UnsupportedSource>() {
                    "unsupported_source"
                } else if self.terminal.is_some() {
                    "terminal_limit"
                } else if correction_scope.is_some() {
                    "invalid_arguments"
                } else {
                    "source_unavailable"
                };
                self.failures.push(Failure {
                    kind,
                    receipt: self.receipts.len() + 1,
                    tool: tool.into(),
                    input: input.clone(),
                    revision: fixed,
                    ranges: Vec::new(),
                    resolved: false,
                    correction_scope,
                    resolved_by: None,
                    recovery_source: None,
                    recovery_blob: None,
                    recovery_receipts: Vec::new(),
                    search_recovery: None,
                });
                let schema = context_tools().into_iter().find(|s| s["name"] == tool);
                let failure = json!({"error":message,"kind":kind,"tool":tool,"requested":input,"coverageIncomplete":true,
                    "correction":{"instruction":"Correct the arguments using the tool schema and error; do not repeat the unchanged failing request. A successful correction must preserve valid supplied source scope. Split oversized source_read ranges and actually read every requested line.",
                        "toolSchema":schema,"identicalFailures":identical_failures,"maxIdenticalFailures":MAX_IDENTICAL_FAILURES},
                    "terminalLimit":self.terminal});
                self.bytes += serde_json::to_vec(&failure).map_or(MAX_RESPONSE, |v| v.len());
                if self.bytes >= self.max_bytes && self.terminal.is_none() {
                    self.terminal = Some(if self.reserved {
                        format!("Continuation budget exhausted, including failed tool responses ({} bytes reserved)", self.max_bytes)
                    } else {
                        "Review context budget exhausted, including failed tool responses (1.5 MB)".into()
                    });
                }
                failure
            }
        };
        let mut receipt = value.clone();
        for field in ["source", "patch", "matches", "paths", "files"] {
            receipt.as_object_mut().unwrap().remove(field);
        }
        receipt["tool"] = json!(tool);
        receipt["requested"] = input;
        receipt["number"] = json!(self.receipts.len() + 1);
        self.receipts.push(receipt);
        self.coverage(run);
        value
    }
    fn accept(&mut self, run: &Value, tool: &str, input: &Value, value: &Value) {
        if tool == "source_read" && run["coveragePolicyVersion"].as_u64().is_some_and(|v| v >= 2) {
            self.added_sources.accept(value, self.receipts.len() + 1);
        }
        if tool == "source_diff" {
            let path = value["path"].as_str().unwrap();
            self.delivered.entry(path.into()).or_default().push((
                value["offset"].as_u64().unwrap() as usize,
                value["endOffset"].as_u64().unwrap() as usize,
            ));
        }
        for failure in &mut self.failures {
            if failure.resolved || failure.tool != tool {
                continue;
            }
            if let Some(scope) = &mut failure.correction_scope {
                // Parse errors may hide several semantic mistakes. Once a
                // corrected request succeeds, fixed metadata proves which
                // previously supplied pagination values were actually valid.
                arguments::refine_scope(
                    tool,
                    scope,
                    failure.revision.as_deref(),
                    value,
                    &self.trees,
                    &self.patches,
                );
            }
            let valid_range = failure.input["startLine"]
                .as_u64()
                .zip(failure.input["endLine"].as_u64())
                .is_some_and(|(start, end)| start > 0 && end >= start);
            if tool == "source_read" && valid_range {
                if let Some(scope) = &failure.correction_scope {
                    let mut source_scope = scope.clone();
                    source_scope.as_object_mut().unwrap().remove("startLine");
                    source_scope.as_object_mut().unwrap().remove("endLine");
                    if !arguments::corrected(tool, &source_scope, input) {
                        continue;
                    }
                } else if failure.input["path"] != value["path"]
                    || failure.revision.as_deref() != value["revision"].as_str()
                {
                    continue;
                }
                let source = json!({"path":value["path"],"revision":value["revision"]});
                // Missing path/revision arguments acquire an identity on the
                // first successful correction. Never combine different blobs.
                if failure
                    .recovery_source
                    .as_ref()
                    .is_some_and(|bound| *bound != source)
                    || failure
                        .recovery_blob
                        .as_deref()
                        .is_some_and(|blob| value["blobSha"] != blob)
                {
                    continue;
                }
                if failure.recovery_source.is_none() {
                    // What this same blob delivered before the failure counts
                    // as well: only successful receipts, by their own ranges.
                    for receipt in self.receipts.iter().take(failure.receipt - 1) {
                        let delivered = receipt["tool"] == "source_read"
                            && receipt["error"].is_null()
                            && receipt["path"] == value["path"]
                            && receipt["revision"] == value["revision"]
                            && receipt["blobSha"] == value["blobSha"];
                        if let (true, Some(a), Some(b), Some(n)) = (
                            delivered,
                            receipt["startLine"].as_u64(),
                            receipt["endLine"].as_u64(),
                            receipt["number"].as_u64(),
                        ) {
                            failure.ranges.push((a as usize, b as usize + 1));
                            failure.recovery_receipts.push(n as usize);
                        }
                    }
                }
                failure.recovery_source = Some(source);
                failure.recovery_blob = value["blobSha"].as_str().map(str::to_owned);
                let (Some(start), Some(end)) = (
                    failure.input["startLine"].as_u64(),
                    failure.input["endLine"].as_u64(),
                ) else {
                    continue;
                };
                if start == 0 || end < start {
                    continue;
                }
                failure.ranges.push((
                    value["startLine"].as_u64().unwrap() as usize,
                    value["endLine"].as_u64().unwrap() as usize + 1,
                ));
                failure.recovery_receipts.push(self.receipts.len() + 1);
                let target_end = end.min(value["totalLines"].as_u64().unwrap());
                failure.resolved =
                    (start == 1 && value["totalLines"] == 0 && value["sourceBytes"] == 0)
                        || (start <= target_end
                            && missing(start as usize, target_end as usize + 1, &failure.ranges)
                                .is_empty());
            } else if let Some(scope) = &failure.correction_scope {
                failure.resolved = arguments::corrected(tool, scope, input);
            } else if tool == "source_search" {
                failure.resolved = search_recovery::advance(
                    failure,
                    input,
                    value,
                    &self.trees,
                    &mut self.search_path_sets,
                    self.receipts.len() + 1,
                );
            } else if failure.input == *input {
                failure.resolved = true;
            }
            if failure.resolved {
                failure.resolved_by = Some(self.receipts.len() + 1);
            }
        }
    }
    fn coverage(&self, run: &mut Value) {
        let mut uninspected = Vec::new();
        let mut covered_files = Vec::new();
        let mut complete_diffs = 0;
        let mut inherited = 0;
        let added_policy = run["coveragePolicyVersion"].as_u64().is_some_and(|v| v >= 2);
        let files = run["files"].as_array().cloned().unwrap_or_default();
        for file in &files {
            let path = file["path"].as_str().unwrap();
            let size = self.patches.get(path).map(String::len);
            let ranges = self.delivered.get(path).map(Vec::as_slice).unwrap_or(&[]);
            let remaining = size.map(|n| missing(0, n, ranges));
            if remaining.as_ref().is_some_and(Vec::is_empty) {
                complete_diffs += 1;
                covered_files.push(json!({"path":path,"revision":file["sourceRevision"],"blobSha":file["sourceBlob"],
                    "deliveredVia":"source_diff","evidenceKind":"complete_diff"}));
            } else if let Some(proof) = added_policy
                .then(|| self.added_sources.complete(file))
                .flatten()
            {
                covered_files.push(proof);
            } else if let Some(proof) = self.inherited.iter().find(|p| {
                p["path"] == path && p["blobSha"] == file["sourceBlob"] && p["revision"] == file["sourceRevision"]
            }) {
                inherited += 1;
                covered_files.push(proof.clone());
            } else {
                uninspected.push(
                    json!({"path":path,"totalDiffBytes":size,"remainingByteRanges":remaining}),
                );
            }
        }
        let mut failures: Vec<_> = self.failures.iter().map(|f|json!({"receipt":f.receipt,"kind":f.kind,"tool":f.tool,"requested":f.input,"revision":f.revision,"resolved":f.resolved,"resolvedByReceipt":f.resolved_by,"correctionScope":f.correction_scope,"recoverySource":f.recovery_source,"recoveryReceipts":f.recovery_receipts,"searchRecovery":f.search_recovery})).collect();
        // A continuation's union, or an incremental round relying on
        // another's proofs, names the review behind every proof.
        if self.reserved || !self.inherited.is_empty() {
            for proof in &mut covered_files {
                if proof.get("byReview").is_none() {
                    proof["byReview"] = run["id"].clone();
                }
            }
        }
        // A parent's unresolved request stays unresolved, unless this run
        // covered the changed path it was for; it is never marked resolved.
        let mut carried = Vec::new();
        for failure in &self.inherited_failures {
            let mut failure = failure.clone();
            let path = failure["requested"]["path"].clone();
            let superseded = covered_files.iter().any(|c| c["path"] == path && c["byReview"] == run["id"]);
            failure["coveredByThisRun"] = json!(superseded);
            if !superseded {
                failures.push(failure.clone());
            }
            carried.push(failure);
        }
        let unresolved = failures.iter().filter(|f| f["resolved"] != true).count();
        run["contextIncomplete"] =
            json!(!uninspected.is_empty() || unresolved > 0 || self.terminal.is_some());
        run["coverage"] = json!({"fileCount":files.len(),"deliveredCompleteDiffs":complete_diffs,"uninspected":uninspected,
            "failedRequests":failures,"unresolvedRequests":unresolved,"terminalLimit":self.terminal});
        if added_policy {
            run["coverage"]["version"] = run["coveragePolicyVersion"].clone();
            run["coverage"]["coveredFileCount"] = json!(covered_files.len());
            run["coverage"]["fullAddedSourceCount"] = json!(covered_files.len() - complete_diffs - inherited);
            run["coverage"]["coveredFiles"] = json!(covered_files);
        }
        if !self.inherited.is_empty() || !carried.is_empty() {
            run["coverage"]["inheritedCoveredCount"] = json!(inherited);
            run["coverage"]["inheritedFailedRequests"] = json!(carried);
        }
        if scope::applies(run) {
            run["scope"] = self.scope.report(run, &files, &covered_files, &uninspected, &failures, self.terminal.as_deref());
        }
        run["contextReads"] = json!(self.receipts);
        run["contextBytes"] = json!(self.bytes);
    }
}
// Half-open intervals, derived solely from responses actually delivered.
fn missing(start: usize, end: usize, ranges: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut ranges = ranges.to_vec();
    ranges.sort_unstable();
    let mut at = start;
    let mut gaps = Vec::new();
    for (a, b) in ranges {
        if b <= at || a >= end {
            continue;
        }
        if a > at {
            gaps.push((at, a.min(end)));
        }
        at = at.max(b).min(end);
    }
    if at < end {
        gaps.push((at, end));
    }
    gaps
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    cursor: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Diff {
    path: String,
    offset: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Read {
    path: String,
    revision: String,
    start_line: usize,
    end_line: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Paths {
    revision: String,
    query: String,
    cursor: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Search {
    revision: String,
    query: String,
    path_prefix: String,
    #[serde(default = "arguments::initial_search_cursor")]
    cursor: String,
}

/// Why a requested base or head is not the PR's, saying both commits and
/// what to read: a caller may have taken a branch tip for the PR's own base.
pub(super) fn moved_revision(expected_base: Option<&str>, expected_head: Option<&str>, base: &str, head: &str) -> Option<String> {
    [("baseSha", "base", expected_base, base), ("headSha", "head", expected_head, head)]
        .into_iter()
        .find_map(|(field, name, expected, current)| expected.filter(|expected| *expected != current).map(|expected| format!(
            "The PR's {name} is {current}, not the requested {field} {expected}; no reviewer ran. {field} is the PR's own \
             commit as github_links shows it (snapshot.{field}), not the current tip of a branch. Read github_links \
             (github_refresh updates it) and start again with those values; omitting baseSha alone reviews your headSha against the PR's current base."
        )))
}

pub(super) async fn collect(
    client: &Client,
    run: &mut Value,
    directory: &Path,
    expected_base: Option<&str>,
    expected_head: Option<&str>,
) -> Result<(String, ContextStore)> {
    let repo = client.repository(&run["repositoryId"].to_string()).await?;
    ensure!(
        repo.id == run["repositoryId"].as_i64().context("Invalid repository")?,
        "Repository identity changed"
    );
    let number = run["number"].as_u64().context("Invalid PR number")?;
    let pr = client
        .get(&format!("repos/{}/pulls/{number}", repo.full_name))
        .await?;
    ensure!(
        pr["number"] == number && pr["base"]["repo"]["id"] == repo.id,
        "PR identity changed"
    );
    let base = sha(&pr["base"]["sha"])?;
    let head = sha(&pr["head"]["sha"])?;
    if let Some(problem) = moved_revision(expected_base, expected_head, base, head) {
        bail!(problem);
    }
    let comparison = client
        .comparison_identity(&repo.full_name, base, head)
        .await?;
    ensure!(
        sha(&comparison["base"])? == base,
        "Comparison base differs from the frozen revision"
    );
    let merge = sha(&comparison["mergeBase"])?;
    run["repository"] = json!(repo.full_name);
    run["baseSha"] = json!(base);
    run["headSha"] = json!(head);
    run["mergeBaseSha"] = json!(merge);
    run["baseBranch"] = pr["base"]["ref"].clone();
    run["headBranch"] = pr["head"]["ref"].clone();
    run["comparison"] = json!(format!("{merge}..{head}"));
    run["commitCount"] = comparison["commits"].clone();
    let git = git::Git::create(directory, &repo.full_name, &[base, head, merge]).await?;
    let mut context = ContextStore::new(git);
    context.prepare(run).await?;
    // Paths no tool can deliver, or that the base's policy excludes, known
    // before the reviewer starts: it is told so instead of spending calls on
    // them. They keep the review incomplete.
    let outside = scope::permanent_gaps(&run["scope"]);
    let evidence = serde_json::to_string(
        &json!({"baseSha":base,"headSha":head,"mergeBaseSha":merge,"changes":context.changes(run,0)?,"coveragePolicyVersion":run["coveragePolicyVersion"],
        "knownOutsideScope":outside,
        "sourceAccess":"fixed Git objects; no checkout; rename represented as delete/add",
        "budgets":{"maxResponseBytes":MAX_RESPONSE,"maxLines":MAX_LINES,"maxContextBytes":MAX_CONTEXT,"maxCalls":MAX_CALLS,"maxIdenticalFailures":MAX_IDENTICAL_FAILURES,"deadlineSeconds":900,"objectStorageBytes":git::DISK_BUDGET}}),
    )?;
    context.bytes = evidence.len();
    run["evidenceBytes"] = json!(evidence.len());
    Ok((evidence, context))
}

pub(super) fn context_tools() -> Vec<Value> {
    let path = json!({"type":"string","minLength":1,"maxLength":1000});
    let revision = json!({"type":"string","enum":["head","mergeBase"]});
    let cursor = json!({"type":"integer","minimum":0});
    let schemas = [
        (
            "review_changes",
            "Page the complete fixed PR change manifest, 20 files at a time. Begin at cursor 0 and follow nextCursor. Cover every changed file using source_diff or an alternative explicitly allowed by the review's coverage policy.",
            json!({"cursor":cursor}),
        ),
        (
            "source_diff",
            "Read a UTF-8 byte page of one changed file's complete diff. Start offset 0; follow nextOffset until null. Returned offsets prove coverage. Rename is delete/add.",
            json!({"path":path,"offset":cursor}),
        ),
        (
            "source_paths",
            "Find repository paths containing literal query at a frozen revision. Begin cursor 0 and follow nextCursor. Empty query lists all paths in pages.",
            json!({"revision":revision,"query":{"type":"string","maxLength":200},"cursor":cursor}),
        ),
        (
            "source_search",
            "Search literal text or symbol names in regular files at a frozen revision, optionally restricted by pathPrefix. Omit cursor for the first page (default 0:1); pass each returned nextCursor explicitly for subsequent pages; each page scans at most 8 files and returns 20 matches. Preview can be truncated; read lines for full context. No regex, command or code execution.",
            json!({"revision":revision,"query":{"type":"string","minLength":1,"maxLength":200},"pathPrefix":{"type":"string","maxLength":1000},"cursor":{"type":"string","default":"0:1"}}),
        ),
        (
            "source_read",
            "Read inclusive 1-based lines from a fixed revision, including unchanged callers and tests. Maximum 500 lines and 64 KB per response. End clamps to EOF; an empty file read at line 1 returns endLine 0 and totalLines 0. Split oversized ranges. Returned revision/blob/mode/range and change metadata prove which source was delivered. Coverage policy 2 accepts complete added regular text from this tool; other changes still require their complete diff.",
            json!({"path":path,"revision":revision,"startLine":{"type":"integer","minimum":1},"endLine":{"type":"integer","minimum":1}}),
        ),
    ];
    schemas.into_iter().map(|(name,description,properties)|{
        let required:Vec<_> = properties.as_object().unwrap().keys().filter(|key| !(name == "source_search" && key.as_str() == "cursor")).cloned().collect();
        json!({"type":"function","name":name,"description":description,"inputSchema":{"type":"object","additionalProperties":false,"required":required,"properties":properties}})
    }).collect()
}

pub(super) async fn context_response(
    ws: &crate::workspace::Workspace,
    run: &mut Value,
    directory: &Path,
    context: &mut ContextStore,
    tool: &str,
    input: Value,
) -> Result<Value> {
    ensure!(
        context.receipts.len() < context.max_calls + 4,
        "Reviewer continued after the context budget was exhausted"
    );
    let value = context.response(run, tool, input).await;
    let body = serde_json::to_vec_pretty(&value)?;
    let number = context.receipts.len();
    tokio::fs::write(directory.join(format!("context-{number}.json")), &body).await?;
    // The ledger's proof of what was delivered: the retained response's
    // hash, recorded only once the file is written.
    if super::continuation::ledger(run) {
        let digest = json!(format!("{:x}", Sha256::digest(&body)));
        if let Some(receipt) = context.receipts.last_mut() {
            receipt["responseSha256"] = digest.clone();
        }
        run["contextReads"][number - 1]["responseSha256"] = digest;
    }
    super::persist(ws, run, None).await?;
    ensure!(
        !context.repeated_failure_limit,
        "{}",
        context
            .terminal
            .as_deref()
            .unwrap_or("Repeated source tool failure")
    );
    Ok(value)
}
