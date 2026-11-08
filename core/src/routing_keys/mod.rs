//! Routing keys (YN-34 S1a; docs/executor-routing.md): the API keys executor
//! routing may start an executor with, and the token of the 1Password service
//! account some of them are read through. This module and its `op.rs` and
//! `routes.rs` are all of Core's code that holds a key's value.
//!
//! Each key chooses its source, as the user decided:
//! - **local**: the value is kept here, in one file of the Workspace folder,
//!   `secrets/routing-keys.json`, mode 0600 in a 0700 folder, owned by Core's
//!   user. It is created with those permissions (never wider for a moment,
//!   whatever the umask) and replaced atomically. A file that another user
//!   owns, or whose mode gives the group or others any access, is refused
//!   with the reason, never read.
//! - **1password**: only an `op://vault/item/field` reference is kept; the
//!   value is read through `op` with the service account's token, itself a
//!   local secret here (`op.rs`).
//!
//! The 0600 file protects a key from the computer's other users, not from
//! programs running as you, the Agents' own shell tools included: the same as
//! the Claude and Codex login files.
//!
//! A key's value is written only through the write-only routes (`routes.rs`):
//! nothing reads one back. It goes into no backup (workspace_backup::EXCLUDED),
//! journal row, task, Brief, log or error text: errors name the key's id,
//! never its value (`Secret` prints as `[redacted]`).
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub mod op;
pub mod routes;

/// The folder in the Workspace folder that holds the file.
pub const DIR: &str = "secrets";
const FILE: &str = "routing-keys.json";
const VERSION: u32 = 1;
/// The longest key, token or reference taken.
const MAX_VALUE: usize = 8 * 1024;

/// One read-modify-write of the file at a time in this Core.
static WRITE: Mutex<()> = Mutex::new(());

/// A key's or token's value. It prints as `[redacted]` and is shown to
/// nothing but the one process it is handed to.
pub struct Secret(String);

impl Secret {
    pub fn new(value: String) -> Self {
        Self(value)
    }
    /// The value, for the one process that gets it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

/// Whose API a key is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Anthropic,
    Openai,
    Deepseek,
}

/// A key as the file keeps it.
#[derive(Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "lowercase", deny_unknown_fields)]
enum Stored {
    Local {
        provider: Provider,
        value: String,
        #[serde(rename = "setAt")]
        set_at: String,
    },
    #[serde(rename = "1password")]
    OnePassword {
        provider: Provider,
        reference: String,
        #[serde(rename = "setAt")]
        set_at: String,
    },
}

#[derive(Serialize, Deserialize)]
struct Token {
    value: String,
    #[serde(rename = "setAt")]
    set_at: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contents {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    keys: BTreeMap<String, Stored>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    one_password_token: Option<Token>,
}

/// What a read shows of a key: never its value. A reference names a
/// 1Password item, not its value, so it is shown to edit.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyView {
    pub id: String,
    pub provider: Provider,
    pub source: &'static str,
    pub set: bool,
    pub set_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
}

/// What a read shows of the service account's token: whether it is set.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenView {
    pub set: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_at: Option<String>,
}

/// Where a key comes from when it is needed.
pub enum Source {
    Local(Secret),
    OnePassword { reference: String },
}

/// The key file of one Workspace folder.
pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn of(data_dir: &Path) -> Self {
        Self { dir: data_dir.join(DIR) }
    }

    fn path(&self) -> PathBuf {
        self.dir.join(FILE)
    }

    /// Every key, without values.
    pub fn keys(&self) -> Result<Vec<KeyView>> {
        Ok(self.read()?.keys.iter().map(|(id, stored)| view(id, stored)).collect())
    }

    /// Whether the service account's token is set.
    pub fn token(&self) -> Result<TokenView> {
        let contents = self.read()?;
        Ok(TokenView { set: contents.one_password_token.is_some(), set_at: contents.one_password_token.map(|t| t.set_at) })
    }

    /// Keeps `value` as key `id`, replacing whatever `id` was.
    pub fn put_local(&self, id: &str, provider: Provider, value: Secret) -> Result<KeyView> {
        check_id(id)?;
        let value = checked_value(value, "The key")?;
        self.change(|contents| {
            contents.keys.insert(id.into(), Stored::Local { provider, value, set_at: now() });
            Ok(view(id, &contents.keys[id]))
        })
    }

    /// Makes key `id` a 1Password reference, replacing whatever `id` was.
    pub fn put_reference(&self, id: &str, provider: Provider, reference: &str) -> Result<KeyView> {
        check_id(id)?;
        let reference = op::check_reference(reference)?;
        self.change(|contents| {
            contents.keys.insert(id.into(), Stored::OnePassword { provider, reference, set_at: now() });
            Ok(view(id, &contents.keys[id]))
        })
    }

    /// Forgets key `id`; whether it was there.
    pub fn remove(&self, id: &str) -> Result<bool> {
        check_id(id)?;
        self.change(|contents| Ok(contents.keys.remove(id).is_some()))
    }

    /// Keeps the service account's token, replacing any earlier one.
    pub fn put_token(&self, value: Secret) -> Result<TokenView> {
        let value = checked_value(value, "The token")?;
        self.change(|contents| {
            let set_at = now();
            contents.one_password_token = Some(Token { value, set_at: set_at.clone() });
            Ok(TokenView { set: true, set_at: Some(set_at) })
        })
    }

    /// Forgets the service account's token; whether it was set.
    pub fn remove_token(&self) -> Result<bool> {
        self.change(|contents| Ok(contents.one_password_token.take().is_some()))
    }

    /// Where key `id` comes from: its value, or its reference. None when
    /// there is no such key.
    pub fn source(&self, id: &str) -> Result<Option<(Provider, Source)>> {
        let mut contents = self.read()?;
        Ok(contents.keys.remove(id).map(|stored| match stored {
            Stored::Local { provider, value, .. } => (provider, Source::Local(Secret(value))),
            Stored::OnePassword { provider, reference, .. } => (provider, Source::OnePassword { reference }),
        }))
    }

    /// The service account's token, for `op` only.
    pub(crate) fn token_value(&self) -> Result<Option<Secret>> {
        Ok(self.read()?.one_password_token.map(|t| Secret(t.value)))
    }

    fn change<T>(&self, apply: impl FnOnce(&mut Contents) -> Result<T>) -> Result<T> {
        let _held = WRITE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut contents = self.read()?;
        let answer = apply(&mut contents)?;
        contents.version = VERSION;
        self.write(&contents)?;
        Ok(answer)
    }

    /// The file's contents; none yet is empty. Refuses a file another user
    /// owns or that the group or others may access, a link, or a later
    /// version's.
    fn read(&self) -> Result<Contents> {
        let path = self.path();
        let mut file = match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Contents::default()),
            Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
                bail!("The routing key file {} is a link: Core will not use it", path.display())
            }
            Err(error) => return Err(error).with_context(|| format!("Cannot read the routing key file {}", path.display())),
        };
        let meta = file.metadata().with_context(|| format!("Cannot read the routing key file {}", path.display()))?;
        trusted(&path, &meta)?;
        let mut text = String::new();
        file.read_to_string(&mut text).with_context(|| format!("Cannot read the routing key file {}", path.display()))?;
        // serde's message could quote the file: say only where it broke.
        let contents: Contents = serde_json::from_str(&text).map_err(|error| {
            anyhow::anyhow!("The routing key file {} is not readable (line {}, column {})", path.display(), error.line(), error.column())
        })?;
        ensure!(contents.version <= VERSION,
            "The routing key file {} is from a later Core (version {}): this one does not change it", path.display(), contents.version);
        Ok(contents)
    }

    /// Writes a new file beside the old one, 0600 from its creation, and
    /// renames it over: a reader sees the old file or the new one, whole.
    fn write(&self, contents: &Contents) -> Result<()> {
        private_dir(&self.dir)?;
        let path = self.path();
        let temp = self.dir.join(format!(".{FILE}.{}", uuid::Uuid::new_v4()));
        let result = (|| -> Result<()> {
            // create_new: O_EXCL, so nothing already there is written into;
            // mode 0600 & !umask, never wider; then exactly 0600.
            let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&temp)?;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
            file.write_all(&serde_json::to_vec_pretty(contents)?)?;
            file.sync_all()?;
            fs::rename(&temp, &path)?;
            File::open(&self.dir)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result.with_context(|| format!("Cannot write the routing key file {}", path.display()))
    }
}

/// The folder, made 0700 when missing; refused like the file when another
/// user owns it or the group or others may write into it.
fn private_dir(dir: &Path) -> Result<()> {
    match fs::symlink_metadata(dir) {
        Ok(meta) => {
            ensure!(meta.is_dir(), "{} is not a folder: Core will not keep routing keys there", dir.display());
            ensure!(meta.uid() == rustix::process::geteuid().as_raw(),
                "{} belongs to another user: Core will not keep routing keys there", dir.display());
            ensure!(meta.mode() & 0o022 == 0,
                "{} can be written by other users (mode {:o}): Core will not keep routing keys there; make it 0700", dir.display(), meta.mode() & 0o777);
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::DirBuilder::new().mode(0o700).create(dir).with_context(|| format!("Cannot create {}", dir.display()))?;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).with_context(|| format!("Cannot set {} to 0700", dir.display()))
        }
        Err(error) => Err(error).with_context(|| format!("Cannot read {}", dir.display())),
    }
}

/// Core uses the file only when it owns it and no one else may access it.
fn trusted(path: &Path, meta: &fs::Metadata) -> Result<()> {
    ensure!(meta.is_file(), "The routing key file {} is not a regular file: Core will not use it", path.display());
    let uid = rustix::process::geteuid().as_raw();
    ensure!(meta.uid() == uid,
        "The routing key file {} belongs to user {}, not to Core's user {}: Core will not use it", path.display(), meta.uid(), uid);
    let mode = meta.mode() & 0o777;
    ensure!(mode & 0o077 == 0,
        "The routing key file {} can be read or changed by other users (mode {:o}): Core will not use it until it is 0600 (chmod 600)", path.display(), mode);
    Ok(())
}

fn view(id: &str, stored: &Stored) -> KeyView {
    match stored {
        Stored::Local { provider, set_at, .. } => KeyView {
            id: id.into(), provider: *provider, source: "local", set: true, set_at: set_at.clone(), reference: None,
        },
        Stored::OnePassword { provider, reference, set_at } => KeyView {
            id: id.into(), provider: *provider, source: "1password", set: true, set_at: set_at.clone(), reference: Some(reference.clone()),
        },
    }
}

/// A key's id: a-z, 0-9 and -, at most 48 characters, as Brief keys.
pub fn check_id(id: &str) -> Result<()> {
    ensure!(!id.is_empty() && id.len() <= 48 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !id.starts_with('-'),
        "A routing key's id is 1 to 48 of a-z, 0-9 and -, not starting with -");
    Ok(())
}

fn checked_value(value: Secret, what: &str) -> Result<String> {
    let text = value.0.trim();
    ensure!(!text.is_empty(), "{what} is empty");
    ensure!(text.len() <= MAX_VALUE, "{what} is longer than {MAX_VALUE} bytes");
    ensure!(!text.chars().any(char::is_control), "{what} has a line break or another control character");
    Ok(text.to_string())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests;
