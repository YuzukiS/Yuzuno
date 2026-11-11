//! The locations an OpenCode executor at Auto-approve is refused because
//! they keep keys or credentials (YN-78 S4b-2; the Dev Lead's resolver,
//! activity 8632). What its static rules deny and Core's answers refuse.
//!
//! **Inputs.** A bounded, explicit snapshot (`PathEnv`), never the whole
//! environment: the platform, the variables in VARIABLES as Core has them
//! (its OpenCode inherits them), the user's account home for an unset HOME,
//! and of what Core sets for that server alone only its path overlay's names
//! and values and the other names (a routing key's value is never read).
//! Resolving reads path strings, and then each location's canonical
//! identity: no credential's contents, no directory listing, no command and
//! nothing created.
//!
//! **Homes.** Three, kept apart. The credential home is HOME, or the account
//! database's when HOME is unset: every default below is under it.
//! OpenCode's own home (`~` in a tool's path) is OPENCODE_TEST_HOME, else
//! the same os.homedir(); its configuration folder OPENCODE_CONFIG_DIR, else
//! `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` from os.homedir().
//! OPENCODE_TEST_HOME moves no default protection. The configuration folder
//! is checked as an input here and protects nothing new.
//!
//! **What is protected.** Each default stays protected when it is missing;
//! a variable adds to the defaults and never replaces one. Folders under
//! the credential home: `.ssh`, `.gnupg`, `.aws`, `.config/gcloud`, `.azure`,
//! `.kube`, `.docker`, `.config/gh`, `.password-store`, `.local/share/opencode`;
//! on Linux `.local/share/keyrings`, on macOS `Library/Keychains`. Files under
//! it: `.netrc`, `.git-credentials`, `.config/git/credentials`, `.npmrc`,
//! `.pypirc`, `.cargo/credentials`, `.cargo/credentials.toml`,
//! `.codex/auth.json`; on Linux `.claude/.credentials.json`. Whole folders
//! from GNUPGHOME, AZURE_CONFIG_DIR, GH_CONFIG_DIR, CLOUDSDK_CONFIG,
//! DOCKER_CONFIG and PASSWORD_STORE_DIR; `auth.json` in CODEX_HOME;
//! `credentials` and `credentials.toml` in CARGO_HOME; `gcloud`, `gh` and
//! `git/credentials` in XDG_CONFIG_HOME; `opencode` (and on Linux
//! `keyrings`) in the host's XDG_DATA_HOME, never the executor's own
//! overlay; the files AWS_CONFIG_FILE, AWS_SHARED_CREDENTIALS_FILE,
//! NPM_CONFIG_USERCONFIG, NPM_CONFIG_GLOBALCONFIG and npm's lowercase
//! spellings; and each file KUBECONFIG lists (colon-separated, empty items
//! ignored), not the folders they are in. The executor's own OpenCode data
//! folder is not one: Core's data directory, its output folders and its
//! temporary directory already govern it (opencode_policy).
//!
//! **Refused, never weakened.** An unset variable leaves its defaults; an
//! empty XDG_CONFIG_HOME or XDG_DATA_HOME means its documented default, an
//! empty KUBECONFIG lists nothing. Any other empty value (HOME,
//! OPENCODE_TEST_HOME, OPENCODE_CONFIG_DIR, an override), a relative one, a
//! value that isn't UTF-8 or that OpenCode's patterns can't name exactly, a
//! variable a routing key would set, and a value over a bound fail the whole
//! resolution: the executor does not start, rather than start protected
//! less. A value is never trimmed. The bounds are a defensive parser's, not
//! a claim about what a platform allows: VARIABLE_BYTES per variable,
//! VARIABLES_BYTES in all, KUBECONFIG_ENTRIES files, ITEMS protected paths
//! and PATH_BYTES per path.
//!
//! **Identities.** Each location is protected as its normal path, and, when
//! it exists, also as its canonical path at start, which a later decision
//! adds to with the real path it finds then: a protection only grows. A
//! location that does not exist keeps its normal path; one that can't be
//! read or loops is not missing, and fails the resolution.
use anyhow::{bail, ensure, Result};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;

/// The variables a protected location or a home may come from.
pub(crate) const VARIABLES: [&str; 20] = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "GNUPGHOME", "AZURE_CONFIG_DIR", "GH_CONFIG_DIR",
    "CLOUDSDK_CONFIG", "DOCKER_CONFIG", "PASSWORD_STORE_DIR", "CODEX_HOME", "CARGO_HOME", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
    "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG", "npm_config_userconfig", "npm_config_globalconfig", "KUBECONFIG",
    "OPENCODE_TEST_HOME", "OPENCODE_CONFIG_DIR"];
/// At most this many bytes in one variable's value ...
pub(crate) const VARIABLE_BYTES: usize = 16 << 10;
/// ... and in all of them.
pub(crate) const VARIABLES_BYTES: usize = 64 << 10;
/// At most this many files listed in KUBECONFIG.
pub(crate) const KUBECONFIG_ENTRIES: usize = 64;
/// At most this many protected paths, normal and canonical together.
pub(crate) const ITEMS: usize = 256;
/// At most this many UTF-8 bytes in one protected path.
pub(crate) const PATH_BYTES: usize = 4096;

/// Folders protected under the credential home on every platform.
const HOME_DIRS: [&str; 10] = [".ssh", ".gnupg", ".aws", ".config/gcloud", ".azure", ".kube", ".docker", ".config/gh", ".password-store",
    ".local/share/opencode"];
/// Files protected under it on every platform.
const HOME_FILES: [&str; 8] = [".netrc", ".git-credentials", ".config/git/credentials", ".npmrc", ".pypirc", ".cargo/credentials",
    ".cargo/credentials.toml", ".codex/auth.json"];
/// Whole folders a variable names.
const OVERRIDE_DIRS: [&str; 6] = ["GNUPGHOME", "AZURE_CONFIG_DIR", "GH_CONFIG_DIR", "CLOUDSDK_CONFIG", "DOCKER_CONFIG", "PASSWORD_STORE_DIR"];
/// Files a variable names one by one.
const OVERRIDE_FILES: [&str; 6] = ["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG",
    "npm_config_userconfig", "npm_config_globalconfig"];

/// The platform OpenCode runs on, for its own credential stores.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Os {
    Linux,
    Mac,
    /// Another Unix: the common defaults only.
    Unix,
}

impl Os {
    pub(crate) fn current() -> Self {
        if cfg!(target_os = "linux") {
            Self::Linux
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Unix
        }
    }
}

/// The bounded snapshot a resolution reads, and nothing else.
#[derive(Clone, Debug, Default)]
pub(crate) struct PathEnv {
    pub os: Option<Os>,
    /// Core's own value of each variable in VARIABLES that is set.
    pub vars: BTreeMap<&'static str, OsString>,
    /// The account database's home, read only when HOME is unset.
    pub account_home: Option<PathBuf>,
    /// The names of what Core gives the executor's server alone besides
    /// its path overlay (a routing key): never their values.
    pub extra: Vec<String>,
}

impl PathEnv {
    /// Core's environment, read by name for VARIABLES only, with the names
    /// of `extra`.
    pub(crate) fn of_core(extra: Vec<String>) -> Self {
        let vars: BTreeMap<&'static str, OsString> = VARIABLES.iter().filter_map(|name| std::env::var_os(name).map(|value| (*name, value))).collect();
        let account_home = if vars.contains_key("HOME") { None } else { dirs::home_dir() };
        Self { os: Some(Os::current()), vars, account_home, extra }
    }
}

/// A protected location: its normal path, and the path as given, from
/// which its canonical identity is read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Location {
    pub normal: String,
    pub given: String,
}

/// What a resolution found before any file system is read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Planned {
    pub credential_home: String,
    pub native_home: String,
    pub native_config: String,
    pub dirs: Vec<Location>,
    pub files: Vec<Location>,
}

/// The protected folders and files, each as its normal path and, where it
/// exists, its canonical path at start, without repeats.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Protection {
    pub dirs: Vec<String>,
    pub files: Vec<String>,
}

impl Protection {
    pub(crate) fn len(&self) -> usize {
        self.dirs.len() + self.files.len()
    }
}

/// What a variable's value is to a resolution.
enum Value<'a> {
    Unset,
    Empty,
    Path(&'a str),
}

/// Reads the snapshot's paths and plans what to protect (no file system).
pub(crate) fn plan(env: &PathEnv) -> Result<Planned> {
    let os = env.os.unwrap_or_else(Os::current);
    if let Some(name) = env.extra.iter().find(|name| VARIABLES.contains(&name.as_str())) {
        bail!("{name} is set for this executor alone, so where it points can't be checked without reading it");
    }
    let mut total = 0usize;
    for (name, value) in &env.vars {
        ensure!(value.len() <= VARIABLE_BYTES, "{name} is {} bytes, more than the {VARIABLE_BYTES} a protected path's variable may be", value.len());
        total += value.len();
    }
    ensure!(total <= VARIABLES_BYTES, "The path variables are {total} bytes in all, more than {VARIABLES_BYTES}");
    let value = |name: &str| -> Result<Value<'_>> {
        match env.vars.get(name) {
            None => Ok(Value::Unset),
            Some(value) if value.is_empty() => Ok(Value::Empty),
            Some(value) => {
                let Some(text) = value.to_str() else { bail!("{name} is not UTF-8, so OpenCode's rules can't name it exactly") };
                Ok(Value::Path(text))
            }
        }
    };
    // An absolute path, given as it is, never trimmed.
    let absolute = |name: &str, text: &str| -> Result<String> {
        ensure!(text.starts_with('/'), "{name} is {text:?}, not an absolute path");
        Ok(text.to_owned())
    };
    let required = |name: &str| -> Result<Option<String>> {
        match value(name)? {
            Value::Unset => Ok(None),
            Value::Empty => bail!("{name} is set but empty, which has no proven meaning here"),
            Value::Path(text) => absolute(name, text).map(Some),
        }
    };
    let xdg = |name: &str| -> Result<Option<String>> {
        match value(name)? {
            // Empty is the XDG specification's default.
            Value::Unset | Value::Empty => Ok(None),
            Value::Path(text) => absolute(name, text).map(Some),
        }
    };

    let os_home = match required("HOME")? {
        Some(home) => home,
        None => {
            let account = env.account_home.as_ref().and_then(|home| home.to_str()).map(str::to_owned);
            let Some(home) = account else { bail!("HOME is unset and the account database has no home for this user") };
            absolute("The account home", &home)?
        }
    };
    let credential_home = os_home.clone();
    let native_home = required("OPENCODE_TEST_HOME")?.unwrap_or_else(|| os_home.clone());
    let config_home = xdg("XDG_CONFIG_HOME")?;
    let data_home = xdg("XDG_DATA_HOME")?;
    let native_config = match required("OPENCODE_CONFIG_DIR")? {
        Some(dir) => dir,
        None => format!("{}/opencode", config_home.clone().unwrap_or_else(|| format!("{os_home}/.config"))),
    };

    let mut dirs: Vec<String> = HOME_DIRS.iter().map(|dir| format!("{credential_home}/{dir}")).collect();
    let mut files: Vec<String> = HOME_FILES.iter().map(|file| format!("{credential_home}/{file}")).collect();
    match os {
        Os::Linux => {
            dirs.push(format!("{credential_home}/.local/share/keyrings"));
            files.push(format!("{credential_home}/.claude/.credentials.json"));
        }
        Os::Mac => dirs.push(format!("{credential_home}/Library/Keychains")),
        Os::Unix => {}
    }
    for name in OVERRIDE_DIRS {
        dirs.extend(required(name)?);
    }
    if let Some(codex) = required("CODEX_HOME")? {
        files.push(format!("{codex}/auth.json"));
    }
    if let Some(cargo) = required("CARGO_HOME")? {
        files.extend([format!("{cargo}/credentials"), format!("{cargo}/credentials.toml")]);
    }
    if let Some(config) = &config_home {
        dirs.extend([format!("{config}/gcloud"), format!("{config}/gh")]);
        files.push(format!("{config}/git/credentials"));
    }
    if let Some(data) = &data_home {
        dirs.push(format!("{data}/opencode"));
        if os == Os::Linux {
            dirs.push(format!("{data}/keyrings"));
        }
    }
    for name in OVERRIDE_FILES {
        files.extend(required(name)?);
    }
    if let Value::Path(list) = value("KUBECONFIG")? {
        let listed: Vec<&str> = list.split(':').filter(|item| !item.is_empty()).collect();
        ensure!(listed.len() <= KUBECONFIG_ENTRIES, "KUBECONFIG lists {} files, more than {KUBECONFIG_ENTRIES}", listed.len());
        for item in listed {
            files.push(absolute("A file KUBECONFIG lists", item)?);
        }
    }

    let located = |given: Vec<String>| -> Result<Vec<Location>> {
        let mut kept: Vec<Location> = Vec::new();
        for given in given {
            let normal = representable(&given)?;
            if !kept.iter().any(|known| known.normal == normal && known.given == given) {
                kept.push(Location { normal, given });
            }
        }
        Ok(kept)
    };
    let (dirs, files) = (located(dirs)?, located(files)?);
    ensure!(dirs.len() + files.len() <= ITEMS, "{} protected locations, more than {ITEMS}", dirs.len() + files.len());
    for (what, home) in [("HOME", &credential_home), ("OPENCODE_TEST_HOME", &native_home), ("OPENCODE_CONFIG_DIR", &native_config)] {
        representable(home).map_err(|error| error.context(format!("{what} can't be used")))?;
    }
    Ok(Planned { credential_home: normal(&credential_home), native_home: normal(&native_home), native_config: normal(&native_config), dirs, files })
}

/// Each planned location's canonical identity, where it exists, added to
/// its normal path. Reads metadata only; run it on a bounded worker.
pub(crate) fn identify(planned: &Planned) -> Result<Protection> {
    let mut protection = Protection::default();
    for (locations, kept) in [(&planned.dirs, &mut protection.dirs), (&planned.files, &mut protection.files)] {
        for location in locations {
            push(kept, location.normal.clone());
            match std::fs::canonicalize(&location.given) {
                Ok(real) => {
                    let Some(real) = real.to_str() else { bail!("{} is really at a path that isn't UTF-8", location.normal) };
                    push(kept, representable(real).map_err(|error| error.context(format!("{} is really elsewhere", location.normal)))?);
                }
                // Missing, or a link to nothing: its normal path is kept.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => bail!("Core can't tell where {} is ({error}), so it can't be protected", location.normal),
            }
        }
    }
    ensure!(protection.len() <= ITEMS, "{} protected paths, more than {ITEMS}", protection.len());
    Ok(protection)
}

fn push(kept: &mut Vec<String>, path: String) {
    if !kept.contains(&path) {
        kept.push(path);
    }
}

/// `path` made normal, as OpenCode's patterns can name it exactly: UTF-8,
/// absolute, below `/`, at most PATH_BYTES, with no wildcard, `\` or
/// control character (opencode_policy's `exact`).
fn representable(path: &str) -> Result<String> {
    ensure!(path.starts_with('/'), "{path:?} is not an absolute path");
    let normal = normal(path);
    ensure!(normal.len() <= PATH_BYTES, "A protected path is {} bytes, more than {PATH_BYTES}", normal.len());
    ensure!(normal != "/", "{path:?} is the whole file system");
    if let Some(c) = normal.chars().find(|c| matches!(c, '*' | '?' | '\\') || c.is_control()) {
        bail!("{normal:?} has {c:?}, so OpenCode's rules can't name it exactly");
    }
    Ok(normal)
}

/// `path` with its empty, `.` and `..` parts taken out, as Node's POSIX
/// `path.resolve` normalizes an absolute path.
fn normal(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

#[cfg(test)]
mod tests;
