//! The cleanup settings (YN-74, design 2.1 and 6): one set for this Core's
//! host, changed only by the user (Settings, or PUT /api/cleanup/settings).
//! Protected paths and scratch roots are empty on a new install and on an
//! upgrade: Core never assumes a folder of one machine exists on another.
//! Every number is a setting; its default and where it comes from are beside
//! it.
use super::*;

/// Plans hold at most this many items (design 6.3, its own choice); the
/// setting may only lower it. An MCP request is also at most 128 KiB.
pub(crate) const MAX_ITEMS: u32 = 2000;
/// The default evidence suffixes an entry's snapshot keeps (design 2.6).
pub(crate) const EVIDENCE_SUFFIXES: [&str; 14] =
    ["json", "jsonl", "png", "jpg", "webp", "log", "md", "txt", "csv", "html", "sha256", "sh", "py", "mjs"];
const MAX_PATHS: usize = 50;
const MAX_SUFFIXES: usize = 64;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Settings {
    /// Nothing at or inside these is removed, nor anything holding one.
    pub protected_paths: Vec<String>,
    /// Folders whose first-level entries (`entry` items) a plan may remove.
    /// /var/tmp is such a folder by FHS 3.0, but whether it is used so is the
    /// machine's own choice.
    pub scratch_roots: Vec<String>,
    /// Items one plan may hold (default 2000, design's own choice).
    pub max_items: u32,
    /// Hours a plan stays valid for approval (default 24, design's own choice).
    pub plan_hours: u32,
    /// Largest paths each group's summary names (default 10, design's own choice).
    pub summary_paths: u32,
    /// Nothing written to within this many days is removed (default 1,
    /// design's own choice).
    pub fresh_days: u32,
    /// A scratch entry goes whole only once its newest write is this many
    /// days old (default 7, design's own choice; systemd's tmpfiles keeps
    /// /var/tmp 30 days).
    pub evidence_days: u32,
    /// An item whose snapshot would be larger is never removed (default 256
    /// MiB, design's own choice).
    pub snapshot_max_mib: u32,
    /// Evidence files larger than this are left out of a snapshot (default 4
    /// MiB, design's own choice).
    pub evidence_file_mib: u32,
    /// File suffixes an entry's snapshot keeps (design 2.6).
    pub evidence_suffixes: Vec<String>,
    /// Days a snapshot is kept, then deleted; a worktree's ref stays
    /// (default 30, design's own choice; GitHub keeps Actions artifacts 90).
    pub snapshot_days: u32,
    /// This host's switch for a rule (rules.rs), where it differs from the
    /// rule's default; absent, the default.
    pub rules: BTreeMap<String, bool>,
    /// Each Project's own switches, by its id, over this host's.
    pub project_rules: BTreeMap<String, BTreeMap<String, bool>>,
    pub version: i64,
    pub changed_at: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            protected_paths: Vec::new(),
            scratch_roots: Vec::new(),
            max_items: MAX_ITEMS,
            plan_hours: 24,
            summary_paths: 10,
            fresh_days: 1,
            evidence_days: 7,
            snapshot_max_mib: 256,
            evidence_file_mib: 4,
            evidence_suffixes: EVIDENCE_SUFFIXES.iter().map(|s| (*s).to_owned()).collect(),
            snapshot_days: 30,
            rules: BTreeMap::new(),
            project_rules: BTreeMap::new(),
            version: 0,
            changed_at: None,
        }
    }
}

/// The settings now: this host's, or the defaults when none were saved.
pub(crate) fn read(db: &Connection) -> Result<Settings> {
    let raw: Option<String> = db.query_row("SELECT data FROM cleanup_settings WHERE scope='host'", [], |r| r.get(0)).optional()?;
    Ok(match raw {
        Some(raw) => serde_json::from_str(&raw)?,
        None => Settings::default(),
    })
}

/// A change the user saves, whole, against the version read.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Change {
    pub protected_paths: Vec<String>,
    pub scratch_roots: Vec<String>,
    pub max_items: u32,
    pub plan_hours: u32,
    pub summary_paths: u32,
    pub fresh_days: u32,
    pub evidence_days: u32,
    pub snapshot_max_mib: u32,
    pub evidence_file_mib: u32,
    pub evidence_suffixes: Vec<String>,
    pub snapshot_days: u32,
    /// Absent: as they are.
    #[serde(default)]
    pub rules: Option<BTreeMap<String, bool>>,
    #[serde(default)]
    pub project_rules: Option<BTreeMap<String, BTreeMap<String, bool>>>,
    pub expected_version: i64,
}

/// Switches name known rules only, and a Project by an id of at most 64 bytes.
fn switches(name: &str, rules: &BTreeMap<String, bool>) -> Result<()> {
    if let Some(unknown) = rules.keys().find(|id| !super::rules::known(id)) {
        bail!("invalid_input: {name} names no rule {unknown:?}; the rules are {}",
            super::rules::ids().iter().map(|(id, _)| *id).collect::<Vec<_>>().join(", "));
    }
    Ok(())
}

fn paths(name: &str, list: &[String]) -> Result<Vec<String>> {
    ensure!(list.len() <= MAX_PATHS, "invalid_input: {name} holds at most {MAX_PATHS} paths");
    let mut out: Vec<String> = Vec::new();
    for path in list {
        let trimmed = path.trim();
        ensure!(
            Path::new(trimmed).is_absolute() && trimmed.len() <= 4096 && !trimmed.contains('\0'),
            "invalid_input: each of {name} is an absolute path on this host"
        );
        ensure!(Path::new(trimmed).parent().is_some(), "invalid_input: {name} cannot be the root folder");
        if !out.iter().any(|p| p == trimmed) {
            out.push(trimmed.to_owned());
        }
    }
    Ok(out)
}

pub(crate) fn change(db: &Connection, change: Change) -> Result<Settings> {
    let current = read(db)?;
    ensure!(
        change.expected_version == current.version,
        "version_conflict: the cleanup settings were changed since they were read (now version {}); read them again",
        current.version
    );
    let ranges = [
        ("maxItems", change.max_items, 1, MAX_ITEMS),
        ("planHours", change.plan_hours, 1, 168),
        ("summaryPaths", change.summary_paths, 1, 50),
        ("freshDays", change.fresh_days, 0, 90),
        ("evidenceDays", change.evidence_days, 0, 365),
        ("snapshotMaxMib", change.snapshot_max_mib, 0, 4096),
        ("evidenceFileMib", change.evidence_file_mib, 0, 256),
        ("snapshotDays", change.snapshot_days, 1, 365),
    ];
    for (name, value, low, high) in ranges {
        ensure!((low..=high).contains(&value), "invalid_input: {name} is {low} to {high}");
    }
    ensure!(change.evidence_suffixes.len() <= MAX_SUFFIXES, "invalid_input: evidenceSuffixes holds at most {MAX_SUFFIXES}");
    let mut suffixes: Vec<String> = Vec::new();
    for suffix in &change.evidence_suffixes {
        let suffix = suffix.trim().trim_start_matches('.').to_ascii_lowercase();
        ensure!(
            (1..=16).contains(&suffix.len()) && suffix.bytes().all(|b| b.is_ascii_alphanumeric()),
            "invalid_input: each evidence suffix is 1 to 16 letters or digits, such as png"
        );
        if !suffixes.contains(&suffix) {
            suffixes.push(suffix);
        }
    }
    let rules = change.rules.unwrap_or_else(|| current.rules.clone());
    switches("rules", &rules)?;
    let project_rules = change.project_rules.unwrap_or_else(|| current.project_rules.clone());
    ensure!(project_rules.len() <= 500, "invalid_input: projectRules holds at most 500 Projects");
    for (project, own) in &project_rules {
        ensure!((1..=64).contains(&project.len()), "invalid_input: each Project in projectRules is named by its id");
        switches(&format!("projectRules.{project}"), own)?;
    }
    let next = Settings {
        protected_paths: paths("protectedPaths", &change.protected_paths)?,
        scratch_roots: paths("scratchRoots", &change.scratch_roots)?,
        max_items: change.max_items,
        plan_hours: change.plan_hours,
        summary_paths: change.summary_paths,
        fresh_days: change.fresh_days,
        evidence_days: change.evidence_days,
        snapshot_max_mib: change.snapshot_max_mib,
        evidence_file_mib: change.evidence_file_mib,
        evidence_suffixes: suffixes,
        snapshot_days: change.snapshot_days,
        rules,
        project_rules,
        version: current.version + 1,
        changed_at: Some(now()),
    };
    db.execute(
        "INSERT INTO cleanup_settings(scope,data) VALUES('host',?1) ON CONFLICT(scope) DO UPDATE SET data=excluded.data",
        [serde_json::to_string(&next)?],
    )?;
    Ok(next)
}

/// What Settings shows: the settings, the defaults and what is fixed in Core.
pub(crate) fn overview(db: &Connection) -> Result<Value> {
    Ok(json!({"settings": read(db)?, "defaults": Settings::default(), "maxItems": MAX_ITEMS,
        "fixed": super::check::forbidden(), "rules": super::rules::overview(), "note": SETTINGS_NOTE}))
}

const SETTINGS_NOTE: &str = "Protected paths and scratch roots are empty until you add them: Core assumes no folder of one machine on another. What is fixed in Core is never removed whatever these say.";

pub(super) async fn http_read(AppState(ws): AppState<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.stored(|s| overview(&*s.db.read()?)).await?))
}

pub(super) async fn http_change(AppState(ws): AppState<Arc<Workspace>>, Json(input): Json<Change>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.stored(move |s| {
        let db = s.db.write()?;
        change(&db, input)?;
        overview(&db)
    })
    .await?))
}
