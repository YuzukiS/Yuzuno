//! What a plan's items may be (design 2.2) and each item's checks when the
//! plan is registered: its root, its kind, what Core judges it to be, and its
//! state then (dev, inode, mtime, size; a worktree's HEAD, branch and Git
//! status). Every check that cannot be made refuses the item.
use super::*;
use crate::build_output::{cargo_target, foreign_entries, git, git_limited, inside, is_dir, is_file, mtime_ns, CACHEDIR_SIGNATURE, REMOVING};

/// What Core never removes whatever the settings say (design 2.2 A, 6.1).
const FIXED: [(&str, &str); 8] = [
    ("Core's data folder", "Core's own state"),
    ("$HOME itself, its first-level folders, and any folder holding $HOME", "losing them is a disaster; the first level is mostly the user's own"),
    ("$XDG_CACHE_HOME, or ~/.cache when it is unset", "XDG Base Directory: non-essential data of every application, with its own cleaners"),
    ("~/Library on macOS", "Apple: the system uses its standard folders; each app cleans its own caches"),
    ("another Project's folder", "it is that Project's"),
    ("this Project's folder and its main worktree", "they hold the sources"),
    ("a path reached through a link, or with a filesystem mounted at or inside it", "so nothing outside its root is reached"),
    ("anything another user owns", "someone else's files"),
];

pub(crate) fn forbidden() -> Value {
    json!(FIXED.iter().map(|(what, why)| json!({"what": what, "why": why})).collect::<Vec<_>>())
}

/// Bounds of one item's walk, and of all of one plan's checks.
const WALK_ENTRIES: usize = 2_000_000;
const WALK_TIME: Duration = Duration::from_secs(20);
pub(super) const PLAN_TIME: Duration = Duration::from_secs(90);
/// Room for `git worktree list` of a repository with many worktrees.
const LIST_BYTES: usize = 4 << 20;
const STATUS_BYTES: usize = 1 << 20;
const TAG_BYTES: u64 = 64 * 1024;

/// What the hard-coded limits are made of on this host (design 2.2 A).
#[derive(Clone, Debug)]
pub(crate) struct HostEnv {
    pub home: Option<PathBuf>,
    /// $XDG_CACHE_HOME when it is an absolute path, else $HOME/.cache (XDG
    /// Base Directory: a relative path there is invalid and ignored).
    pub cache: Option<PathBuf>,
    /// ~/Library, on macOS only.
    pub library: Option<PathBuf>,
    pub uid: u32,
}

impl HostEnv {
    pub(crate) fn of_process() -> Self {
        let absolute = |name: &str| std::env::var_os(name).map(PathBuf::from).filter(|p| p.is_absolute());
        let home = absolute("HOME");
        let cache = absolute("XDG_CACHE_HOME").or_else(|| home.as_ref().map(|h| h.join(".cache")));
        let library = home.as_ref().filter(|_| cfg!(target_os = "macos")).map(|h| h.join("Library"));
        HostEnv { home, cache, library, uid: rustix::process::getuid().as_raw() }
    }
}

/// path as this host resolves it, or as given where it does not resolve.
fn real(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// One worktree of `git worktree list --porcelain`; the first is the main one.
#[derive(Clone, Debug, Default)]
pub(crate) struct Listed {
    pub path: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub main: bool,
    pub locked: bool,
    pub prunable: bool,
}

pub(crate) fn parse_worktrees(text: &str) -> Vec<Listed> {
    let mut out: Vec<Listed> = Vec::new();
    for block in text.split("\n\n") {
        let mut listed = Listed::default();
        for line in block.lines() {
            if let Some(path) = line.strip_prefix("worktree ") {
                listed.path = real(Path::new(path));
            } else if let Some(head) = line.strip_prefix("HEAD ") {
                listed.head = Some(head.to_owned());
            } else if let Some(branch) = line.strip_prefix("branch ") {
                listed.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).to_owned());
            } else if line == "locked" || line.starts_with("locked ") {
                listed.locked = true;
            } else if line == "prunable" || line.starts_with("prunable ") {
                listed.prunable = true;
            }
        }
        if !listed.path.as_os_str().is_empty() {
            listed.main = out.is_empty();
            out.push(listed);
        }
    }
    out
}

/// Everything one plan's checks compare against, read once.
#[derive(Clone)]
pub(crate) struct Context {
    pub env: HostEnv,
    pub data: PathBuf,
    pub project: PathBuf,
    /// The Git working tree the Project's folder is in: the folder itself, or
    /// its repository's top when the Project is a folder of a larger one.
    pub top: PathBuf,
    pub common: String,
    pub others: Vec<PathBuf>,
    pub protected: Vec<PathBuf>,
    /// Every root Core keeps for its executors' temporary directories: each
    /// is never removed, nor anything above or below it (YN-78 S2b-1).
    pub runtime: Vec<PathBuf>,
    pub scratch: Vec<PathBuf>,
    pub worktrees: Vec<Listed>,
    /// A remote's default branch (`refs/remotes/<remote>/HEAD`), for "merged".
    pub upstream: Option<String>,
    pub mounts: Option<Vec<PathBuf>>,
    pub settings: Settings,
    /// The rules on for this Project (rules.rs `enabled`).
    pub on: BTreeSet<&'static str>,
    pub deadline: Instant,
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn context(env: HostEnv, mounts: Option<Vec<PathBuf>>, data: &Path, project: &str, project_id: Option<&str>, others: &[String],
    runtime: Vec<PathBuf>, settings: Settings) -> Result<Context> {
    let project = std::fs::canonicalize(project)
        .map_err(|e| anyhow::anyhow!("project_folder_missing: its task's Project folder {project} cannot be read on this host: {e}"))?;
    let common = match git(&project, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await? {
        Ok(text) => text.trim().to_owned(),
        Err(why) => bail!("project_not_git: its task's Project folder is not a Git checkout: {why}"),
    };
    let top = match git(&project, &["rev-parse", "--show-toplevel"]).await? {
        Ok(text) => real(Path::new(text.trim())),
        Err(why) => bail!("project_not_git: its task's Project folder is not a Git checkout: {why}"),
    };
    let worktrees = match git_limited(&project, &["worktree", "list", "--porcelain"], LIST_BYTES).await? {
        Ok(text) => parse_worktrees(&text),
        Err(why) => bail!("project_not_git: git worktree list failed: {why}"),
    };
    let upstream = match git(&project, &["for-each-ref", "--format=%(symref)", "refs/remotes/*/HEAD"]).await? {
        Ok(text) => text.lines().map(str::trim).find(|r| !r.is_empty()).map(str::to_owned),
        Err(_) => None,
    };
    let canonical = |list: &[String]| list.iter().map(|p| real(Path::new(p))).collect::<Vec<_>>();
    let env = HostEnv {
        home: env.home.as_deref().map(real),
        cache: env.cache.as_deref().map(real),
        library: env.library.as_deref().map(real),
        uid: env.uid,
    };
    Ok(Context {
        env,
        data: real(data),
        others: canonical(others).into_iter().filter(|p| p != &project).collect(),
        protected: canonical(&settings.protected_paths),
        runtime: runtime.iter().map(|p| real(p)).collect(),
        scratch: canonical(&settings.scratch_roots).into_iter().filter(|p| is_dir(p)).collect(),
        project,
        top,
        common,
        worktrees,
        upstream,
        mounts,
        on: super::rules::enabled(&settings, project_id),
        settings,
        deadline: Instant::now() + PLAN_TIME,
    })
}

/// An item of a plan as its author gave it.
#[derive(Clone, Debug)]
pub(crate) struct Item {
    pub id: String,
    pub group: String,
    pub kind: String,
    pub rule: Option<String>,
    pub path: String,
    pub save_diff: bool,
}

/// An item's checks: refused with a code and why, or pending with its state.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Checked {
    pub refusal: Option<(&'static str, String)>,
    pub pre: Value,
}

impl Checked {
    fn refused(code: &'static str, why: impl Into<String>, mut pre: Value) -> Self {
        pre["category"] = json!("refused");
        Checked { refusal: Some((code, why.into())), pre }
    }
}

/// The path as given, made plain: absolute, without `.` or `..`, without a
/// trailing slash. None when it is not such a path.
fn plain(path: &str) -> Option<PathBuf> {
    let given = Path::new(path);
    if !given.is_absolute() || path.contains('\0') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in given.components() {
        match part {
            std::path::Component::RootDir | std::path::Component::Normal(_) => out.push(part),
            _ => return None,
        }
    }
    (out.parent().is_some()).then_some(out)
}

/// Why `path` is never removed whatever the settings say, or is protected
/// by them: it is, is inside or holds one of those folders.
pub(super) fn fixed(ctx: &Context, path: &Path) -> Option<(&'static str, String)> {
    let within = |root: &Path| inside(path, root);
    let holds = |root: &Path| inside(root, path);
    if within(&ctx.data) || holds(&ctx.data) {
        return Some(("forbidden", "Core's data folder: never removed".into()));
    }
    if let Some(root) = ctx.runtime.iter().find(|root| within(root) || holds(root)) {
        return Some(("forbidden", format!(
            "A temporary root Core keeps for its executors ({}): itself, anything below it and anything holding it are never removed",
            root.display())));
    }
    let Some(home) = &ctx.env.home else {
        return Some(("forbidden", "HOME is not set, so Core cannot tell the home folder: nothing is removed".into()));
    };
    if holds(home) || path.parent() == Some(home.as_path()) {
        return Some(("forbidden", "The home folder or one of its first-level folders: never removed".into()));
    }
    for (root, what) in [(&ctx.env.cache, "$XDG_CACHE_HOME"), (&ctx.env.library, "~/Library")] {
        if let Some(root) = root.as_deref().filter(|r| within(r) || holds(r)) {
            return Some(("forbidden", format!("{what} ({}) is every application's: never removed", root.display())));
        }
    }
    if let Some(other) = ctx.others.iter().find(|o| within(o) || holds(o)) {
        return Some(("forbidden", format!("Another Project's folder ({}): never removed", other.display())));
    }
    if holds(&ctx.project) {
        return Some(("forbidden", "This Project's folder: never removed".into()));
    }
    if let Some(main) = ctx.worktrees.iter().find(|w| w.main && holds(&w.path)) {
        return Some(("forbidden", format!("The main worktree ({}): never removed", main.path.display())));
    }
    if let Some(root) = ctx.protected.iter().find(|p| within(p) || holds(p)) {
        return Some(("protected", format!("A protected path (Settings): {}", root.display())));
    }
    None
}

/// A cache directory by the Cache Directory Tagging Specification
/// (bford.info/cachedir): its CACHEDIR.TAG begins with the signature. Who
/// made it, as the tag's next line says.
fn cachedir_tag(dir: &Path) -> Option<String> {
    let tag = dir.join("CACHEDIR.TAG");
    std::fs::symlink_metadata(&tag).ok().filter(|m| m.is_file() && m.len() <= TAG_BYTES)?;
    let text = std::fs::read_to_string(&tag).ok()?;
    text.starts_with(CACHEDIR_SIGNATURE).then(|| text.lines().nth(1).unwrap_or("").trim().chars().take(160).collect())
}

/// The rule that recognizes dir as rebuildable, and what it went by; Err
/// names the rule that would but is off for this Project. A CACHEDIR.TAG
/// first: Cargo's goes by the cargo rule, since people put other things in
/// target/ and only what Cargo makes there goes; any other valid tag by
/// cachedir-tag. Then each ecosystem's rule (rules.rs). `in_git`: inside a
/// Git working tree; `in_scratch`: inside a scratch root. No file in a
/// repository adds a rule, and a folder holding `.git` is no rule's.
pub(crate) fn recognize(dir: &Path, on: &BTreeSet<&'static str>, in_git: bool, in_scratch: bool)
    -> std::result::Result<Option<(&'static str, String)>, &'static str> {
    use super::rules::{CACHEDIR_TAG, CARGO};
    // A Git working tree or repository is never a cache, wherever it is: a
    // scratch root's clone included, where no Git check applies (review 939ed865).
    if std::fs::symlink_metadata(dir.join(".git")).is_ok() {
        return Ok(None);
    }
    if cargo_target(dir) {
        let basis = match cachedir_tag(dir) {
            Some(who) => format!("CACHEDIR.TAG written by Cargo ({who})"),
            None => "Cargo's .rustc_info.json".to_owned(),
        };
        return if on.contains(CARGO) { Ok(Some((CARGO, basis))) } else { Err(CARGO) };
    }
    if let Some(who) = cachedir_tag(dir) {
        let basis = if who.is_empty() { "CACHEDIR.TAG".to_owned() } else { format!("CACHEDIR.TAG ({who})") };
        return if on.contains(CACHEDIR_TAG) { Ok(Some((CACHEDIR_TAG, basis))) } else { Err(CACHEDIR_TAG) };
    }
    super::rules::ecosystem(dir, on, in_git, in_scratch)
}

/// Cargo's own files at a target folder's top, which stay with it.
pub(super) const CARGO_FILES: [&str; 5] = ["CACHEDIR.TAG", ".rustc_info.json", ".future-incompat-report.json", ".package-cache", ".package-cache-mutate"];
/// What Cargo makes at a target folder's top besides its profiles and the
/// folders of each target triple (Build Cache): its docs, packaged crates,
/// scratch files and, from Cargo 1.91, its separate build-dir. Cargo says
/// this layout is no stable interface, so a name it doesn't list stays.
const CARGO_NAMED: [&str; 4] = ["doc", "package", "tmp", "build"];

/// A profile folder: Cargo's fingerprints or its build lock in it, and
/// nothing Cargo does not make. One left half removed (its lock gone, or
/// only some of its folders) is one still.
fn cargo_profile(path: &Path) -> bool {
    is_dir(path) && (is_dir(&path.join(".fingerprint")) || is_file(&path.join(".cargo-lock"))) && foreign_entries(path).is_empty()
}

/// A target triple's folder (`x86_64-unknown-linux-gnu`): only profiles in it.
fn cargo_triple(path: &Path, name: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(path) else { return false };
    let entries: Vec<_> = entries.flatten().collect();
    name.matches('-').count() >= 2 && !entries.is_empty()
        && entries.iter().all(|e| e.file_type().is_ok_and(|t| t.is_dir()) && cargo_profile(&e.path()))
}

/// The subtrees of a target folder that Cargo makes, each with its identity
/// and kind (profile, triple, named), and the names beside them that stay.
pub(super) fn cargo_profiles(target: &Path) -> (Vec<Value>, Vec<String>) {
    let (mut profiles, mut kept) = (Vec::new(), Vec::new());
    let Ok(entries) = std::fs::read_dir(target) else { return (profiles, kept) };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if CARGO_FILES.contains(&name.as_str()) || name.starts_with(REMOVING) {
            continue;
        }
        let kind = if cargo_profile(&path) {
            Some("profile")
        } else if is_dir(&path) && cargo_triple(&path, &name) {
            Some("triple")
        } else if is_dir(&path) && CARGO_NAMED.contains(&name.as_str()) && std::fs::symlink_metadata(path.join(".git")).is_err() {
            // A named subtree holding a Git working tree or repository
            // (a .git folder or file) stays, as recognize keeps any such
            // folder (Lead activity 8080 P2-2). Profiles and triples hold
            // only Cargo's names, so a .git there already keeps them.
            Some("named")
        } else {
            None
        };
        match (kind, std::fs::symlink_metadata(&path)) {
            (Some(kind), Ok(meta)) if !meta.file_type().is_symlink() => {
                profiles.push(json!({"name": name, "kind": kind, "dev": meta.dev(), "ino": meta.ino(), "mtimeNs": mtime_ns(&meta).to_string()}));
            }
            _ => kept.push(name),
        }
    }
    profiles.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    kept.sort();
    (profiles, kept)
}

/// What a bounded walk of a folder found, never following links.
#[derive(Debug, Default)]
struct Walked {
    bytes: u64,
    files: u64,
    newest_ns: i128,
    complete: bool,
    other_user: bool,
    other_device: bool,
    snapshot_files: u64,
    snapshot_bytes: u64,
}

/// Allocated bytes below root (each hard-linked file once), its newest
/// write, and for an entry the evidence files its snapshot would keep.
fn walk(root: &Path, uid: u32, evidence: Option<(&[String], u64)>, seen: &mut HashSet<(u64, u64)>) -> Walked {
    let (mut budget, deadline) = (WALK_ENTRIES, Instant::now() + WALK_TIME);
    let mut found = Walked { complete: true, ..Default::default() };
    let Ok(top) = std::fs::symlink_metadata(root) else { return Walked::default() };
    found.newest_ns = mtime_ns(&top);
    let mut count = |found: &mut Walked, path: &Path, meta: &std::fs::Metadata| {
        found.newest_ns = found.newest_ns.max(mtime_ns(meta));
        found.other_user |= meta.uid() != uid;
        if meta.is_dir() {
            return;
        }
        found.files += 1;
        if meta.nlink() <= 1 || seen.insert((meta.dev(), meta.ino())) {
            found.bytes += meta.blocks() * 512;
        }
        if let Some((suffixes, limit)) = evidence {
            let suffix = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
            if meta.is_file() && meta.len() <= limit && suffix.is_some_and(|s| suffixes.iter().any(|k| *k == s)) {
                found.snapshot_files += 1;
                found.snapshot_bytes += meta.len();
            }
        }
    };
    count(&mut found, root, &top);
    if !top.is_dir() {
        return found;
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            found.complete = false;
            break;
        };
        for entry in entries.flatten() {
            if budget == 0 || Instant::now() > deadline {
                found.complete = false;
                return found;
            }
            budget -= 1;
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
            if meta.dev() != top.dev() {
                found.other_device = true;
                continue;
            }
            count(&mut found, &entry.path(), &meta);
            if meta.is_dir() {
                stack.push(entry.path());
            }
        }
    }
    found
}

fn age_days(newest_ns: i128) -> f64 {
    let now = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(i64::MAX) as i128;
    (now - newest_ns) as f64 / 86_400e9
}

fn mib(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / (1u64 << 20) as f64)
}

/// The Git working tree a cache folder is in, when it is inside this
/// Project's folder or one of its registered worktrees.
fn tree_of<'a>(ctx: &'a Context, path: &Path) -> Option<&'a Path> {
    let worktree = ctx.worktrees.iter().filter(|w| !w.main && inside(path, &w.path)).max_by_key(|w| w.path.as_os_str().len());
    match worktree {
        Some(w) => Some(&w.path),
        None if inside(path, &ctx.project) => Some(&ctx.top),
        None => None,
    }
}

/// A worktree's facts from Git: tracked changes and untracked files that
/// are not ignored, commits found on no remote branch, merged into a remote's
/// default branch.
async fn worktree_facts(ctx: &Context, path: &Path) -> std::result::Result<Value, String> {
    let theirs = git(path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await.map_err(|e| e.to_string())??;
    if theirs.trim() != ctx.common {
        return Err("It belongs to another repository".into());
    }
    let status = git_limited(path, &["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignored=no"], STATUS_BYTES)
        .await
        .map_err(|e| e.to_string())??;
    let (mut tracked, mut untracked, mut parts) = (0u64, 0u64, status.split('\0').filter(|p| !p.is_empty()));
    while let Some(entry) = parts.next() {
        if entry.starts_with("??") {
            untracked += 1;
        } else {
            tracked += 1;
            // A rename or copy names its source next.
            if entry.starts_with('R') || entry.starts_with('C') {
                parts.next();
            }
        }
    }
    let unique = git(path, &["rev-list", "--count", "HEAD", "--not", "--remotes"]).await.map_err(|e| e.to_string())??;
    let unique: u64 = unique.trim().parse().map_err(|_| "Git did not count its commits".to_owned())?;
    // Three states (Lead mail 10772): its HEAD is in the default branch,
    // isn't (exit 1), or Git could not say, which is never taken as either.
    let merged = match &ctx.upstream {
        Some(upstream) => match crate::build_output::git_status(path, &["merge-base", "--is-ancestor", "HEAD", upstream]).await {
            Ok(Some(0)) => json!(true),
            Ok(Some(1)) => json!(false),
            _ => Value::Null,
        },
        None => Value::Null,
    };
    Ok(json!({"trackedChanges": tracked, "untrackedFiles": untracked, "uniqueCommits": unique, "merged": merged,
        "upstream": ctx.upstream}))
}

/// One item's checks when its plan is registered.
pub(crate) async fn preflight(ctx: &Context, item: &Item) -> Checked {
    let mut pre = json!({"category": "refused"});
    if Instant::now() > ctx.deadline {
        return Checked::refused("timeout", format!("Not checked: the plan's checks ran out of time ({} s); register a smaller plan", PLAN_TIME.as_secs()), pre);
    }
    let Some(path) = plain(&item.path) else {
        return Checked::refused("path", "Not an absolute path without . or .. on this host", pre);
    };
    // What a removal renamed aside (build_output REMOVING) is never an item
    // again, nor anything inside it: a stopped removal leaves it to be read.
    if path.components().any(|c| c.as_os_str().to_string_lossy().starts_with(REMOVING)) {
        return Checked::refused("removing", "A removal renamed it aside, or it is inside such a folder: it is never an item", pre);
    }
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return Checked::refused("missing", "It does not exist", pre);
    };
    if meta.file_type().is_symlink() || std::fs::canonicalize(&path).ok().as_deref() != Some(path.as_path()) {
        return Checked::refused("link", "It is reached through a link", pre);
    }
    pre["dev"] = json!(meta.dev());
    pre["ino"] = json!(meta.ino());
    pre["mtimeNs"] = json!(mtime_ns(&meta).to_string());
    if meta.uid() != ctx.env.uid {
        return Checked::refused("owner", "Another user owns it", pre);
    }
    if let Some((code, why)) = fixed(ctx, &path) {
        return Checked::refused(code, why, pre);
    }
    match &ctx.mounts {
        None => return Checked::refused("unchecked", "Mounts cannot be checked on this host", pre),
        Some(mounts) if mounts.iter().any(|m| inside(m, &path)) => {
            return Checked::refused("mount", "A filesystem is mounted at or inside it", pre);
        }
        Some(_) => {}
    }
    if let Some(tree) = ctx.worktrees.iter().find(|w| w.path != path && inside(&w.path, &path)) {
        return Checked::refused("holdsWorktree", format!("It holds the worktree {}: reclaim that as a worktree item", tree.path.display()), pre);
    }
    let settings = &ctx.settings;
    let evidence = (item.kind == "entry").then(|| (settings.evidence_suffixes.clone(), u64::from(settings.evidence_file_mib) << 20));
    // What the walk covers: the item, or a Cargo target folder's profiles.
    let mut roots = vec![path.clone()];
    match item.kind.as_str() {
        "entry" => {
            if !ctx.scratch.iter().any(|root| path.parent() == Some(root.as_path())) {
                return Checked::refused("notScratch", "Not a first-level entry of a scratch root (Settings)", pre);
            }
        }
        "worktree" => {
            let Some(listed) = ctx.worktrees.iter().find(|w| w.path == path && !w.main) else {
                return Checked::refused("notWorktree", "Not a worktree this Project's repository lists (git worktree list)", pre);
            };
            if listed.locked {
                return Checked::refused("locked", "Its worktree is locked (git worktree lock)", pre);
            }
            pre["worktree"] = match worktree_facts(ctx, &path).await {
                Ok(mut facts) => {
                    facts["head"] = json!(listed.head);
                    facts["branch"] = json!(listed.branch);
                    facts
                }
                Err(why) => return Checked::refused("git", format!("Git could not check it: {why}"), pre),
            };
            if let Some((code, why)) = super::worktrees::preflight(&path, item.save_diff, &ctx.settings, &ctx.on, &mut pre).await {
                return Checked::refused(code, why, pre);
            }
        }
        "cache-dir" => {
            if !meta.is_dir() {
                return Checked::refused("noRule", "Not a folder", pre);
            }
            if let Some(tree) = tree_of(ctx, &path) {
                if tree == path {
                    return Checked::refused("kind", "A worktree itself is a worktree item, not a cache folder", pre);
                }
                let relative = path.strip_prefix(tree).unwrap_or(&path).to_string_lossy().into_owned();
                let top = git(&path, &["rev-parse", "--show-toplevel"]).await;
                if !matches!(&top, Ok(Ok(t)) if real(Path::new(t.trim())) == tree) {
                    return Checked::refused("otherTree", "It is inside another Git working tree", pre);
                }
                // `git worktree list` can still name a path that now holds
                // another repository: only this Project's repository counts,
                // and a Git that cannot say is never taken as yes.
                match git(&path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await {
                    Ok(Ok(theirs)) if theirs.trim() == ctx.common => {}
                    _ => return Checked::refused("otherTree", "Its working tree is not this Project's repository now, or Git could not say", pre),
                }
                match git(tree, &["check-ignore", "-q", "--", &relative]).await {
                    Ok(Ok(_)) => {}
                    Ok(Err(why)) if why.is_empty() => return Checked::refused("notIgnored", "Git does not ignore it", pre),
                    Ok(Err(why)) => return Checked::refused("git", format!("Git could not check it: {why}"), pre),
                    Err(error) => return Checked::refused("git", format!("Git could not check it: {error}"), pre),
                }
                match git(tree, &["ls-files", "-z", "--", &relative]).await {
                    Ok(Ok(text)) if text.is_empty() => {}
                    Ok(Ok(_)) => return Checked::refused("tracked", "Git tracks files in it", pre),
                    Ok(Err(why)) => return Checked::refused("git", format!("Git could not list it: {why}"), pre),
                    Err(error) => return Checked::refused("git", format!("Git could not list it: {error}"), pre),
                }
                pre["tree"] = json!(tree);
            } else if !ctx.scratch.iter().any(|root| path.starts_with(root) && path != *root) {
                return Checked::refused("notInRoot", "Not inside this Project's folder, one of its worktrees or a scratch root", pre);
            }
            let in_git = tree_of(ctx, &path).is_some();
            let in_scratch = ctx.scratch.iter().any(|root| path.starts_with(root) && path != *root);
            let (rule, basis) = match recognize(&path, &ctx.on, in_git, in_scratch) {
                Ok(Some(found)) => found,
                Ok(None) => return Checked::refused("noRule",
                    "No cleanup rule recognizes it: a CACHEDIR.TAG, Cargo's target folder, or an ecosystem's folder beside its manifest (Settings lists the rules)", pre),
                Err(off) => return Checked::refused("ruleOff", format!("Only the rule {off} would recognize it, and it is off for this Project (Settings)"), pre),
            };
            if let Some(given) = item.rule.as_deref().filter(|given| *given != rule) {
                return Checked::refused("ruleMismatch", format!("Core recognizes it by the rule {rule}, not {given}"), pre);
            }
            pre["rule"] = json!(rule);
            pre["basis"] = json!(basis);
            if rule == "cargo" {
                let (profiles, kept) = cargo_profiles(&path);
                if profiles.is_empty() {
                    return Checked::refused("noRule", "It holds nothing Cargo makes that Core can tell apart: no profile, target triple, doc, package, tmp or build folder of Cargo's alone", pre);
                }
                roots = profiles.iter().map(|p| path.join(p["name"].as_str().unwrap_or_default())).collect();
                pre["profiles"] = json!(profiles);
                pre["kept"] = json!(kept.into_iter().take(20).collect::<Vec<_>>());
            }
        }
        other => return Checked::refused("kind", format!("Unknown kind {other}"), pre),
    }
    let walked = tokio::task::spawn_blocking({
        let uid = ctx.env.uid;
        move || {
            let mut seen = HashSet::new();
            let mut total = Walked { complete: true, ..Default::default() };
            for root in &roots {
                let found = walk(root, uid, evidence.as_ref().map(|(s, l)| (s.as_slice(), *l)), &mut seen);
                total.bytes += found.bytes;
                total.files += found.files;
                total.newest_ns = total.newest_ns.max(found.newest_ns);
                total.complete &= found.complete;
                total.other_user |= found.other_user;
                total.other_device |= found.other_device;
                total.snapshot_files += found.snapshot_files;
                total.snapshot_bytes += found.snapshot_bytes;
            }
            total
        }
    })
    .await
    .unwrap_or_default();
    pre["bytes"] = json!(walked.bytes);
    pre["files"] = json!(walked.files);
    pre["complete"] = json!(walked.complete);
    pre["newestNs"] = json!(walked.newest_ns.to_string());
    if walked.other_user {
        return Checked::refused("owner", "It holds files another user owns", pre);
    }
    if walked.other_device {
        return Checked::refused("mount", "Part of it is on another filesystem", pre);
    }
    if !walked.complete {
        return Checked::refused("tooLarge", "Too large to check within the bounds of a plan", pre);
    }
    if item.kind == "entry" && age_days(walked.newest_ns) < f64::from(settings.evidence_days) {
        return Checked::refused("evidenceWindow", format!("Written within the last {} days (the evidence window, Settings)", settings.evidence_days), pre);
    }
    if item.kind != "entry" && age_days(walked.newest_ns) < f64::from(settings.fresh_days) {
        return Checked::refused("fresh", format!("Written within the last {} day(s) (Settings)", settings.fresh_days), pre);
    }
    let category = match item.kind.as_str() {
        "entry" => {
            pre["snapshot"] = json!({"files": walked.snapshot_files, "bytes": walked.snapshot_bytes});
            if walked.snapshot_bytes > u64::from(settings.snapshot_max_mib) << 20 {
                return Checked::refused("snapshotTooLarge", format!("Its snapshot would be {}, over the limit of {} MiB (Settings)",
                    mib(walked.snapshot_bytes), settings.snapshot_max_mib), pre);
            }
            "scratch-entry"
        }
        "cache-dir" => "rebuildable",
        _ => {
            let facts = &pre["worktree"];
            if facts["uniqueCommits"].as_u64().unwrap_or(0) > 0 {
                "worktree-unique-commits"
            } else if facts["trackedChanges"] == 0 && facts["untrackedFiles"] == 0 && facts["merged"] == true {
                "clean-merged-worktree"
            } else {
                "other"
            }
        }
    };
    pre["category"] = json!(category);
    if item.save_diff {
        pre["saveDiff"] = json!(true);
    }
    Checked { refusal: None, pre }
}
