//! Each machine's Job environment (YN-194, memo item 4): variables the user
//! sets in Settings → Machines for every managed Job on that machine, such as
//! HOME or a PATH with their toolchains. Core never guesses them: a machine
//! without one gets nothing more than before.
//!
//! A Job's own env wins, then the machine's, then Core's defaults (PATH and
//! LANG on this host and Linux machines, `Submit::default_env`). A PATH or
//! LANG equal to Core's default counts as that default, so the machine's
//! value replaces it; any other value a Job gives is its own. Values are
//! used as written: `$PATH` is not expanded. The variables are merged into
//! the Job's record when it is created, so the record says what it ran with
//! and a later change of the setting changes only new Jobs.
//!
//! Kept in a table of its own, not in a machine's registration, which older
//! Cores read strictly.
use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// This Core's host (also This Mac on a macOS Core).
pub(super) const HOST: &str = super::CORE_HOST;
/// What one machine's environment may hold: half of what a Job's own may
/// (64 entries / 16 KiB, `Submit::validate_command`), so the two fit together.
const MAX_ENTRIES: usize = 32;
const MAX_BYTES: usize = 8192;
/// Core's own variables, set for each attempt: never from a setting.
const RESERVED_PREFIX: &str = "YUZUNO_";
/// Core's defaults (`Submit::default_env`), which a machine's value replaces.
pub(super) const DEFAULT_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
pub(super) const DEFAULT_LANG: &str = "C.UTF-8";

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS job_machine_env(
            machine TEXT PRIMARY KEY, env TEXT NOT NULL, updated_at TEXT NOT NULL);",
    )?;
    Ok(())
}

/// The setting's key for the machine a Job runs on: `local` for this host
/// (This Mac included), `windows`, or a registered machine's ID.
pub(super) fn key_of(machine_id: Option<&str>) -> &str {
    match machine_id {
        None | Some(super::remote::MAC) => HOST,
        Some(id) => id,
    }
}

/// A name a shell and every platform take: letters, digits and `_`, not
/// starting with a digit.
fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// A setting as the user saved it, checked: names, Core's own prefix, NUL
/// and the size it may have.
pub(super) fn validate(env: &BTreeMap<String, String>) -> Result<()> {
    ensure!(env.len() <= MAX_ENTRIES, "A machine's Job environment holds at most {MAX_ENTRIES} variables");
    for (name, value) in env {
        ensure!(valid_name(name), "{name:?} is not a variable name: use letters, digits and _, not starting with a digit");
        ensure!(
            !name.to_ascii_uppercase().starts_with(RESERVED_PREFIX),
            "{name} is Core's own: variables starting with {RESERVED_PREFIX} are set by Core for each attempt"
        );
        ensure!(!value.contains('\0'), "The value of {name} contains NUL");
    }
    let bytes: usize = env.iter().map(|(k, v)| k.len() + v.len()).sum();
    ensure!(bytes <= MAX_BYTES, "A machine's Job environment holds at most {MAX_BYTES} bytes of names and values");
    Ok(())
}

/// The machine's saved environment, empty when it has none.
pub(super) fn get(db: &Connection, machine: &str) -> Result<BTreeMap<String, String>> {
    let raw: Option<String> = db
        .query_row("SELECT env FROM job_machine_env WHERE machine=?1", [machine], |r| r.get(0))
        .optional()?;
    Ok(match raw {
        Some(raw) => serde_json::from_str(&raw)?,
        None => BTreeMap::new(),
    })
}

/// Every saved environment, by machine, with when it was saved.
pub(super) fn all(db: &Connection) -> Result<Value> {
    let mut q = db.prepare("SELECT machine, env, updated_at FROM job_machine_env ORDER BY machine")?;
    let mut machines = serde_json::Map::new();
    for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))? {
        let (machine, env, at) = row?;
        machines.insert(machine, json!({"env": serde_json::from_str::<Value>(&env)?, "updatedAt": at}));
    }
    Ok(json!({"machines": machines, "defaults": {"PATH": DEFAULT_PATH, "LANG": DEFAULT_LANG}}))
}

/// Save (an empty map clears) a machine's environment: `local`, `windows`
/// or a registered machine.
pub(super) fn set(db: &Connection, machine: &str, env: &BTreeMap<String, String>) -> Result<Value> {
    validate(env)?;
    if machine != HOST && machine != super::remote::WINDOWS {
        let known: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM machines WHERE id=?1)", [machine], |r| r.get(0))?;
        ensure!(known, "No machine {machine:?} is registered in Machines");
    }
    if env.is_empty() {
        db.execute("DELETE FROM job_machine_env WHERE machine=?1", [machine])?;
    } else {
        db.execute(
            "INSERT INTO job_machine_env(machine,env,updated_at) VALUES(?1,?2,?3)
             ON CONFLICT(machine) DO UPDATE SET env=excluded.env, updated_at=excluded.updated_at",
            params![machine, serde_json::to_string(env)?, crate::model::now()],
        )?;
    }
    Ok(json!({"machine": machine, "env": env}))
}

/// Whether a Job's value of `name` is Core's default rather than its own.
fn is_default(name: &str, value: &str) -> bool {
    (name == "PATH" && value == DEFAULT_PATH) || (name == "LANG" && value == DEFAULT_LANG)
}

/// The Job's env with its machine's environment under it, and the names it
/// took from the machine (`envFromMachine`). The merged env still has to fit
/// a Job's limits; the refusal names the machine's setting.
pub(super) fn merged(
    job_env: &BTreeMap<String, String>,
    machine: &str,
    from: &BTreeMap<String, String>,
) -> Result<(BTreeMap<String, String>, Vec<String>)> {
    let mut env = job_env.clone();
    let mut taken = Vec::new();
    for (name, value) in from {
        if job_env.get(name).is_none_or(|own| is_default(name, own)) {
            env.insert(name.clone(), value.clone());
            taken.push(name.clone());
        }
    }
    let bytes: usize = env.iter().map(|(k, v)| k.len() + v.len()).sum();
    ensure!(
        env.len() <= 64 && bytes <= 16384,
        "With the Job environment of machine {machine} (Settings → Machines), env has {} entries / {bytes} bytes; a Job may have at most 64 entries / 16 KiB. Give fewer variables in env, or shorten that setting",
        env.len()
    );
    Ok((env, taken))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn the_jobs_own_value_wins_the_machines_replaces_cores_default() {
        let job = map(&[("PATH", DEFAULT_PATH), ("LANG", DEFAULT_LANG), ("RUST_LOG", "debug"), ("HOME", "/srv/own")]);
        let machine = map(&[("PATH", "/opt/tool/bin:/usr/bin:/bin"), ("HOME", "/home/example"), ("FONTCONFIG_FILE", "/etc/f.conf")]);
        let (env, taken) = merged(&job, "local", &machine).unwrap();
        assert_eq!(env["PATH"], "/opt/tool/bin:/usr/bin:/bin", "the default PATH is replaced");
        assert_eq!(env["HOME"], "/srv/own", "the Job's own HOME stays");
        assert_eq!(env["FONTCONFIG_FILE"], "/etc/f.conf");
        assert_eq!(env["LANG"], DEFAULT_LANG);
        assert_eq!(env["RUST_LOG"], "debug");
        assert_eq!(taken, vec!["FONTCONFIG_FILE".to_owned(), "PATH".to_owned()]);
        // A PATH of the Job's own is never replaced.
        let own = map(&[("PATH", "/x/bin:/usr/bin")]);
        let (env, taken) = merged(&own, "local", &machine).unwrap();
        assert_eq!(env["PATH"], "/x/bin:/usr/bin");
        assert!(!taken.contains(&"PATH".to_owned()));
    }

    #[test]
    fn a_merged_env_past_a_jobs_limits_is_refused_naming_the_setting() {
        let job: BTreeMap<String, String> = (0..40).map(|n| (format!("J{n}"), "v".into())).collect();
        let machine: BTreeMap<String, String> = (0..30).map(|n| (format!("M{n}"), "v".into())).collect();
        let error = merged(&job, "m1", &machine).unwrap_err().to_string();
        assert!(error.contains("machine m1") && error.contains("70 entries"), "{error}");
    }

    #[test]
    fn names_cores_prefix_nul_and_size_are_checked() {
        assert!(validate(&map(&[("HOME", "/home/example"), ("_X1", "")])).is_ok());
        for bad in [map(&[("1A", "v")]), map(&[("A-B", "v")]), map(&[("", "v")]), map(&[("A B", "v")])] {
            assert!(validate(&bad).unwrap_err().to_string().contains("not a variable name"), "{bad:?}");
        }
        assert!(validate(&map(&[("YUZUNO_JOB_ID", "x")])).unwrap_err().to_string().contains("Core's own"));
        assert!(validate(&map(&[("yuzuno_x", "x")])).unwrap_err().to_string().contains("Core's own"));
        assert!(validate(&map(&[("A", "a\0b")])).unwrap_err().to_string().contains("NUL"));
        let many: BTreeMap<String, String> = (0..33).map(|n| (format!("V{n}"), String::new())).collect();
        assert!(validate(&many).is_err());
        assert!(validate(&map(&[("BIG", &"x".repeat(9000))])).is_err());
    }

    #[test]
    fn this_mac_is_this_hosts_setting_and_other_machines_have_their_own() {
        assert_eq!(key_of(None), "local");
        assert_eq!(key_of(Some("mac")), "local");
        assert_eq!(key_of(Some("windows")), "windows");
        assert_eq!(key_of(Some("m1")), "m1");
    }
}
