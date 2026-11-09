//! The cleanup rule table (YN-74 ③a; design YN-72 v3, 3.1 and 6.2): what a
//! cleanup counts as rebuildable, and by what.
//!
//! A folder is rebuildable when a rule recognizes it, never by its name
//! alone. CACHEDIR.TAG comes first (bford.info/cachedir): a tag Cargo wrote
//! goes by the `cargo` rule, which takes only the subtrees Cargo makes in a
//! target folder, since people put other things there; any other valid tag
//! makes the whole folder rebuildable. Then each ecosystem's own rule: the
//! folder's name and the manifest beside it (kondo's and projclean's lists,
//! PEP 3147 for `__pycache__`). Every rule can be turned off for this host
//! and on or off for each Project in Settings; `.venv` and Terraform are off
//! by default. No file in a repository adds or changes a rule: whoever can
//! change the repository could widen what is removed.
//!
//! The same table goes to the inventory script (`table`), which reads it
//! with the same meaning (`scripts/workspace_inventory.py`, `rule_matches`);
//! a test runs both on one tree. Common conditions (Git ignores it, Git
//! tracks nothing in it, every check of `check.rs`) are the plan's, not here.
use super::*;

/// One ecosystem's rule: a folder named as `names` says (`*` is any run of
/// characters), with every group of `siblings` matched by a file or folder
/// beside it (one name of each group; `a/b` is a path from beside it), and
/// with `inside` matched by a file in it, when given.
pub(crate) struct Rule {
    pub id: &'static str,
    pub label: &'static str,
    pub names: &'static [&'static str],
    pub siblings: &'static [&'static [&'static str]],
    pub inside: &'static [&'static str],
    /// A `package.json` beside it whose `scripts` has this one.
    pub package_script: Option<&'static str>,
    /// Holds nothing but regular files ending so (`__pycache__`: `.pyc`).
    pub only_suffix: Option<&'static str>,
    /// Recognized only inside a Git working tree, where Git must ignore it:
    /// the name is also a release folder's (`dist`, `build`).
    pub needs_git: bool,
    /// Recognized only inside a scratch root.
    pub scratch_only: bool,
    pub default_on: bool,
    pub basis: &'static str,
}

const NODE_LOCKS: &[&str] = &["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"];
const NONE: &[&[&str]] = &[];

/// The two rules a CACHEDIR.TAG decides, before every other (check.rs `recognize`).
pub(crate) const CACHEDIR_TAG: &str = "cachedir-tag";
pub(crate) const CARGO: &str = "cargo";

/// Every rule, in the order they are tried after a CACHEDIR.TAG.
pub(crate) static RULES: [Rule; 21] = [
    Rule { id: "node-modules", label: "Node.js node_modules (with a lockfile)", names: &["node_modules"], siblings: &[&["package.json"], NODE_LOCKS],
        inside: &[], package_script: None, only_suffix: None, needs_git: false, scratch_only: false, default_on: true,
        basis: "npm ci rebuilds it from the lockfile only (docs.npmjs.com npm-ci); the outermost one" },
    Rule { id: "node-framework", label: "Node.js framework caches", names: &[".next", ".nuxt", ".svelte-kit", ".angular", ".turbo", ".parcel-cache"],
        siblings: &[&["package.json"]], inside: &[], package_script: None, only_suffix: None, needs_git: false, scratch_only: false, default_on: true,
        basis: "framework build caches beside package.json (kondo, projclean)" },
    Rule { id: "frontend-build", label: "Front-end build output", names: &["dist", "build"], siblings: &[&["package.json"]], inside: &[],
        package_script: Some("build"), only_suffix: None, needs_git: true, scratch_only: false, default_on: true,
        basis: "package.json has a build script; only where Git ignores it, since it may be a release" },
    Rule { id: "python-cache", label: "Python caches", names: &[".pytest_cache", ".ruff_cache", ".mypy_cache", "*.egg-info"], siblings: NONE,
        inside: &[], package_script: None, only_suffix: None, needs_git: false, scratch_only: false, default_on: true,
        basis: "pytest, ruff and mypy caches and setuptools metadata (kondo, projclean)" },
    Rule { id: "python-pycache", label: "Python __pycache__", names: &["__pycache__"], siblings: NONE, inside: &[], package_script: None,
        only_suffix: Some(".pyc"), needs_git: false, scratch_only: false, default_on: true, basis: "PEP 3147: compiled files only" },
    Rule { id: "python-tox", label: "tox and nox environments", names: &[".tox", ".nox"], siblings: &[&["tox.ini", "noxfile.py"]], inside: &[],
        package_script: None, only_suffix: None, needs_git: false, scratch_only: false, default_on: true, basis: "beside tox.ini or noxfile.py" },
    Rule { id: "python-venv", label: "Python virtual environments", names: &[".venv", "venv"],
        siblings: &[&["uv.lock", "poetry.lock", "requirements*.txt", "pdm.lock"]], inside: &["pyvenv.cfg"], package_script: None,
        only_suffix: None, needs_git: false, scratch_only: false, default_on: false,
        basis: "pyvenv.cfg in it and a lock beside it; off by default: packages may have been installed by hand" },
    Rule { id: "maven", label: "Maven target", names: &["target"], siblings: &[&["pom.xml"]], inside: &[], package_script: None, only_suffix: None,
        needs_git: false, scratch_only: false, default_on: true, basis: "beside pom.xml" },
    Rule { id: "gradle", label: "Gradle build", names: &["build", ".gradle"],
        siblings: &[&["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]], inside: &[], package_script: None,
        only_suffix: None, needs_git: false, scratch_only: false, default_on: true, basis: "beside a Gradle build or settings file" },
    Rule { id: "dotnet", label: ".NET bin and obj", names: &["bin", "obj"], siblings: &[&["*.csproj", "*.fsproj", "*.vbproj"]], inside: &[],
        package_script: None, only_suffix: None, needs_git: false, scratch_only: false, default_on: true, basis: "beside a project file" },
    Rule { id: "swiftpm", label: "SwiftPM .build", names: &[".build"], siblings: &[&["Package.swift"]], inside: &[], package_script: None,
        only_suffix: None, needs_git: false, scratch_only: false, default_on: true, basis: "beside Package.swift" },
    Rule { id: "dart", label: "Dart and Flutter", names: &[".dart_tool", "build"], siblings: &[&["pubspec.yaml"]], inside: &[], package_script: None,
        only_suffix: None, needs_git: false, scratch_only: false, default_on: true, basis: "beside pubspec.yaml" },
    Rule { id: "elixir", label: "Elixir _build and deps", names: &["_build", "deps"], siblings: &[&["mix.exs"]], inside: &[], package_script: None,
        only_suffix: None, needs_git: false, scratch_only: false, default_on: true, basis: "beside mix.exs" },
    Rule { id: "haskell", label: "Haskell Stack and Cabal", names: &[".stack-work", "dist-newstyle"], siblings: &[&["stack.yaml", "cabal.project", "*.cabal"]],
        inside: &[], package_script: None, only_suffix: None, needs_git: false, scratch_only: false, default_on: true,
        basis: "beside stack.yaml, cabal.project or a .cabal file" },
    Rule { id: "zig", label: "Zig caches and output", names: &[".zig-cache", "zig-cache", "zig-out"], siblings: &[&["build.zig"]], inside: &[],
        package_script: None, only_suffix: None, needs_git: false, scratch_only: false, default_on: true, basis: "beside build.zig" },
    Rule { id: "cmake", label: "CMake build folders", names: &["*"], siblings: NONE, inside: &["CMakeCache.txt"], package_script: None,
        only_suffix: None, needs_git: false, scratch_only: false, default_on: true, basis: "CMakeCache.txt in it, by no name: build is too common" },
    Rule { id: "unity", label: "Unity Library, Temp and Obj", names: &["Library", "Temp", "Obj"], siblings: &[&["ProjectSettings/ProjectVersion.txt"]],
        inside: &[], package_script: None, only_suffix: None, needs_git: false, scratch_only: false, default_on: true,
        basis: "beside ProjectSettings/ProjectVersion.txt" },
    Rule { id: "unreal", label: "Unreal Intermediate, Binaries and DerivedDataCache", names: &["Intermediate", "Binaries", "DerivedDataCache"],
        siblings: &[&["*.uproject"]], inside: &[], package_script: None, only_suffix: None, needs_git: false, scratch_only: false, default_on: true,
        basis: "beside a .uproject file; Saved holds the user's own and is never one" },
    Rule { id: "godot", label: "Godot .godot", names: &[".godot"], siblings: &[&["project.godot"]], inside: &[], package_script: None,
        only_suffix: None, needs_git: false, scratch_only: false, default_on: true, basis: "beside project.godot" },
    Rule { id: "terraform", label: "Terraform .terraform", names: &[".terraform"], siblings: &[&["*.tf"]], inside: &[], package_script: None,
        only_suffix: None, needs_git: false, scratch_only: false, default_on: false,
        basis: "beside a .tf file; off by default: rebuilding needs the network and sometimes credentials" },
    Rule { id: "node-compile-cache", label: "Node.js compile cache", names: &["node-compile-cache"], siblings: NONE, inside: &[], package_script: None,
        only_suffix: None, needs_git: false, scratch_only: true, default_on: true, basis: "Node's own module compile cache, in a scratch root only" },
];

/// Every rule id with its default, the two CACHEDIR.TAG rules first.
pub(crate) fn ids() -> Vec<(&'static str, bool)> {
    [(CACHEDIR_TAG, true), (CARGO, true)].into_iter().chain(RULES.iter().map(|r| (r.id, r.default_on))).collect()
}

pub(crate) fn known(id: &str) -> bool {
    ids().iter().any(|(rule, _)| *rule == id)
}

/// The rules on for `project` (None: this host's): its own switch, else this
/// host's, else the rule's default.
pub(crate) fn enabled(settings: &Settings, project: Option<&str>) -> BTreeSet<&'static str> {
    let own = project.and_then(|p| settings.project_rules.get(p));
    ids().into_iter()
        .filter(|(id, default)| own.and_then(|r| r.get(*id)).or_else(|| settings.rules.get(*id)).copied().unwrap_or(*default))
        .map(|(id, _)| id)
        .collect()
}

/// The table as the inventory script takes it (`--rules`): the rules on, each as data.
pub(crate) fn table(on: &BTreeSet<&'static str>) -> Value {
    let rules: Vec<Value> = RULES.iter().filter(|r| on.contains(r.id)).map(|r| json!({
        "id": r.id, "names": r.names, "siblings": r.siblings, "inside": r.inside, "packageScript": r.package_script,
        "onlySuffix": r.only_suffix, "needsGit": r.needs_git, "scratchOnly": r.scratch_only})).collect();
    json!({"cachedirTag": on.contains(CACHEDIR_TAG), "cargo": on.contains(CARGO), "rules": rules})
}

/// Each rule, its label, default and basis, as Settings shows them.
pub(crate) fn overview() -> Value {
    let special = [
        json!({"id": CACHEDIR_TAG, "label": "CACHEDIR.TAG (other than Cargo's)", "default": true, "basis": "bford.info/cachedir: the whole folder is a cache"}),
        json!({"id": CARGO, "label": "Cargo target folders", "default": true,
            "basis": "Cargo's tag or .rustc_info.json; only the subtrees Cargo makes, anything else stays"}),
    ];
    Value::Array(special.into_iter().chain(RULES.iter().map(|r| json!({"id": r.id, "label": r.label, "default": r.default_on, "basis": r.basis}))).collect())
}

/// Whether `text` matches `pattern`, where `*` is any run of characters.
pub(crate) fn matches(pattern: &str, text: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == text,
        Some((head, rest)) => {
            let Some(mut tail) = text.strip_prefix(head) else { return false };
            let parts: Vec<&str> = rest.split('*').collect();
            for (i, part) in parts.iter().enumerate() {
                if i == parts.len() - 1 {
                    return tail.len() >= part.len() && tail.ends_with(part);
                }
                match tail.find(part) {
                    Some(at) => tail = &tail[at + part.len()..],
                    None => return false,
                }
            }
            true
        }
    }
}

/// Whether a file or folder named by `pattern` is in `dir` (or at that path from it).
fn present(dir: &Path, pattern: &str) -> bool {
    if !pattern.contains('*') {
        return std::fs::symlink_metadata(dir.join(pattern)).is_ok_and(|m| !m.file_type().is_symlink());
    }
    std::fs::read_dir(dir).into_iter().flatten().flatten()
        .any(|e| matches(pattern, &e.file_name().to_string_lossy()) && e.file_type().is_ok_and(|t| !t.is_symlink()))
}

fn package_has_script(package: &Path, script: &str) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(package) else { return false };
    if !meta.is_file() || meta.len() > 1 << 20 {
        return false;
    }
    std::fs::read_to_string(package).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|p| p["scripts"][script].is_string())
}

fn only_files_ending(dir: &Path, suffix: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    entries.flatten().take(100_000).all(|e| e.file_type().is_ok_and(|t| t.is_file()) && e.file_name().to_string_lossy().ends_with(suffix))
}

/// The first ecosystem rule in `on` that recognizes dir, and what it went
/// by; or the first rule that would but is off. `in_git`: inside a Git
/// working tree; `in_scratch`: inside a scratch root.
pub(crate) fn ecosystem(dir: &Path, on: &BTreeSet<&'static str>, in_git: bool, in_scratch: bool) -> Result<Option<(&'static str, String)>, &'static str> {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // Only the outermost node_modules: one inside another is a package's.
    let nested = dir.parent().is_some_and(|p| p.components().any(|c| c.as_os_str() == "node_modules"));
    let Some(parent) = dir.parent() else { return Ok(None) };
    let mut off = None;
    for rule in &RULES {
        if !rule.names.iter().any(|n| matches(n, &name)) || (rule.needs_git && !in_git) || (rule.scratch_only && !in_scratch)
            || (rule.id == "node-modules" && nested) {
            continue;
        }
        let beside = rule.siblings.iter().all(|group| group.iter().any(|p| present(parent, p)));
        let within = rule.inside.iter().all(|f| std::fs::symlink_metadata(dir.join(f)).is_ok_and(|m| m.is_file()));
        let script = rule.package_script.is_none_or(|s| package_has_script(&parent.join("package.json"), s));
        let only = rule.only_suffix.is_none_or(|s| only_files_ending(dir, s));
        if !(beside && within && script && only) {
            continue;
        }
        if on.contains(rule.id) {
            let mut by: Vec<String> = rule.siblings.iter()
                .filter_map(|group| group.iter().find(|p| present(parent, p)).map(|p| format!("{p} beside it")))
                .chain(rule.inside.iter().map(|f| format!("{f} in it"))).collect();
            if let Some(s) = rule.package_script {
                by.push(format!("a {s} script in package.json"));
            }
            if let Some(s) = rule.only_suffix {
                by.push(format!("only {s} files in it"));
            }
            let basis = if by.is_empty() { rule.label.to_owned() } else { format!("{}: {}", rule.label, by.join(", ")) };
            return Ok(Some((rule.id, basis)));
        }
        off.get_or_insert(rule.id);
    }
    off.map_or(Ok(None), Err)
}
