//! The named Workspaces this iPhone keeps (T-195), in `core.json` in the
//! app's data folder. Each profile is a name the person gave it, the HTTPS
//! address, and the `workspaceId` the Core at that address last answered
//! with, so the next connection can tell the same Workspace from another one
//! that happens to share the name or the address.
//!
//! Saved is not reachable: nothing here reaches a Core. A profile is what was
//! written down; whether it answers is only known once `connect_core` asks.
//!
//! Written whole and renamed over the old record, as `saved_core` did before
//! it (and the desktop app does), so a failed save leaves the old record as
//! it was. Reading tells a record never saved apart from one that cannot be
//! read, so a damaged record is not taken for a first launch. The record one
//! address at a time (`{"coreUrl":...}`) that older versions of this app
//! wrote is still read, as one profile named after its host; the next save
//! writes the newer record. No dependencies but `std`, `serde_json`, `url`
//! and `core_url`.

use std::io::{self, Write};
use std::path::Path;

use url::Url;

/// More than any record this app writes: 16 profiles of this shape fit well
/// inside it.
const LIMIT: u64 = 16_384;
/// How many profiles this app keeps. A phone connects to a few Workspaces,
/// not to a directory of them, and the record stays small enough to write
/// whole.
pub const PROFILE_LIMIT: usize = 16;
/// The longest name this app keeps. Longer is refused rather than cut, so a
/// name is never silently something else than what was typed.
pub const NAME_LIMIT: usize = 60;
/// The longest `workspaceId` this app keeps. A Core's health answer is read
/// up to 64 KiB, far more than a record this app can read back holds.
pub const WORKSPACE_LIMIT: usize = 200;

/// One named Workspace.
#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    /// This app's own identifier for the profile, so a rename does not lose
    /// which one is selected and two profiles may share a name.
    pub id: String,
    /// What the person called it.
    pub name: String,
    /// Its HTTPS address, as `core_url::parse` accepts it.
    pub url: Url,
    /// The `workspaceId` the Core there last answered with, when one has
    /// answered. `None` until it has: a profile may be written down before
    /// it is ever reached.
    pub workspace_id: Option<String>,
}

impl Profile {
    fn to_json(&self) -> serde_json::Value {
        let mut value = serde_json::json!({ "id": self.id, "name": self.name, "url": self.url.as_str() });
        if let Some(workspace) = &self.workspace_id {
            value["workspaceId"] = serde_json::json!(workspace);
        }
        value
    }

    fn from_json(value: &serde_json::Value) -> Option<Profile> {
        let id = value.get("id")?.as_str()?;
        let name = value.get("name")?.as_str()?;
        let url = crate::core_url::parse(value.get("url")?.as_str()?).ok()?;
        if id.is_empty() || id.len() > 64 || name.is_empty() || name.chars().count() > NAME_LIMIT {
            return None;
        }
        Some(Profile {
            id: id.to_owned(),
            name: name.to_owned(),
            url,
            workspace_id: match value.get("workspaceId") {
                None | Some(serde_json::Value::Null) => None,
                Some(workspace) => {
                    let workspace = workspace.as_str()?;
                    if workspace.is_empty() || workspace.len() > WORKSPACE_LIMIT {
                        return None;
                    }
                    Some(workspace.to_owned())
                }
            },
        })
    }
}

/// What the record says.
#[derive(Debug, PartialEq)]
pub enum Saved {
    /// Nothing was ever saved: the page asks for an address.
    Never,
    /// The profiles this app would connect to now, and which was last
    /// opened, when that one is still among them.
    Profiles { profiles: Vec<Profile>, selected: Option<String> },
    /// A record that cannot be used, and why. It is left as it is; the next
    /// successful save replaces it.
    Unreadable(String),
}

impl Saved {
    /// As the connection page reads it. `reachable` is deliberately absent:
    /// this says what is written down, never that any of it answers.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Saved::Never => serde_json::json!({ "state": "never", "profiles": [] }),
            Saved::Profiles { profiles, selected } => serde_json::json!({
                "state": "saved",
                "profiles": profiles.iter().map(Profile::to_json).collect::<Vec<_>>(),
                "selected": selected,
            }),
            Saved::Unreadable(reason) => serde_json::json!({ "state": "unreadable", "reason": reason, "profiles": [] }),
        }
    }

    /// The profiles, when the record has any.
    pub fn profiles(&self) -> &[Profile] {
        match self {
            Saved::Profiles { profiles, .. } => profiles,
            _ => &[],
        }
    }
}

pub fn read(path: &Path) -> Saved {
    let bytes = match std::fs::File::open(path).and_then(|file| {
        let mut bytes = Vec::new();
        io::Read::read_to_end(&mut io::Read::take(file, LIMIT + 1), &mut bytes).map(|_| bytes)
    }) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Saved::Never,
        Err(error) => return Saved::Unreadable(format!("it could not be read ({error})")),
    };
    if bytes.len() as u64 > LIMIT {
        return Saved::Unreadable("it is not a saved Workspace record".into());
    }
    let Ok(record) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Saved::Unreadable("it is not a saved Workspace record".into());
    };
    // The record one address at a time, from before this app kept names.
    if record.get("profiles").is_none() {
        return match record.get("coreUrl").and_then(serde_json::Value::as_str) {
            Some(address) => match crate::core_url::parse(address) {
                Ok(url) => {
                    let profile = Profile { id: "core".into(), name: name_for(&url), url, workspace_id: None };
                    let selected = Some(profile.id.clone());
                    Saved::Profiles { profiles: vec![profile], selected }
                }
                Err(_) => Saved::Unreadable("its address is not one this app opens".into()),
            },
            None => Saved::Unreadable("it is not a saved Workspace record".into()),
        };
    }
    let Some(listed) = record.get("profiles").and_then(serde_json::Value::as_array) else {
        return Saved::Unreadable("it is not a saved Workspace record".into());
    };
    if listed.len() > PROFILE_LIMIT {
        return Saved::Unreadable("it holds more Workspaces than this app keeps".into());
    }
    let mut profiles = Vec::with_capacity(listed.len());
    for value in listed {
        match Profile::from_json(value) {
            Some(profile) if profiles.iter().all(|kept: &Profile| kept.id != profile.id) => profiles.push(profile),
            // One unusable entry makes the record unusable rather than
            // quietly dropping a Workspace someone saved.
            _ => return Saved::Unreadable("one of its Workspaces is not one this app opens".into()),
        }
    }
    if profiles.is_empty() {
        return Saved::Never;
    }
    let selected = record
        .get("selected")
        .and_then(serde_json::Value::as_str)
        .filter(|id| profiles.iter().any(|profile| profile.id == *id))
        .map(str::to_owned);
    Saved::Profiles { profiles, selected }
}

/// What the Workspace that answered lets this app do with the address.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Opening {
    /// Open it, and record this identity for the profile. `None` when the
    /// Core named none and nothing was saved for the address either: an
    /// older Core still connects, and nothing is claimed about it.
    Open(Option<String>),
    /// A different Workspace at this profile's address. A name and an
    /// address are this person's labels; the Workspace is what answered, and
    /// another one's conversations, drafts and reading places are not this
    /// one's.
    Changed,
    /// The address is bound to a Workspace and the Core named none, so there
    /// is nothing to check the saved one against.
    ///
    /// This is not `Open`. Treating "cannot be checked" as "nothing to
    /// compare, go ahead" is how a bound address was opened on an answer
    /// that proves nothing: a Core that simply does not say which Workspace
    /// it is was enough to pass the refusal and reach the origin whose
    /// stored drafts the refusal exists to keep apart. An address bound to
    /// nothing is a different matter -- there is nothing to contradict.
    Unverified,
    /// The Core named one longer than this app keeps. Refused outright
    /// rather than treated as absent: storing it would make the saved record
    /// unreadable, and calling it absent would open an address whose answer
    /// cannot be checked. The record is left as it is.
    Unkeepable,
}

/// `known` is what the profile at this address recorded; `answered` is what
/// the Core just said, where a Core that names none says nothing at all.
///
/// The answer is classified here, not thinned out before it arrives: an
/// over-long identifier that is discarded on the way in becomes
/// indistinguishable from a Core that named none, which is the same
/// downgrade by a different route.
pub fn opening(known: Option<&str>, answered: &str) -> Opening {
    if answered.is_empty() {
        return match known {
            Some(_) => Opening::Unverified,
            None => Opening::Open(None),
        };
    }
    if answered.len() > WORKSPACE_LIMIT {
        return Opening::Unkeepable;
    }
    match known {
        Some(known) if known != answered => Opening::Changed,
        _ => Opening::Open(Some(answered.to_owned())),
    }
}

/// Why what was read cannot be used, when it cannot.
///
/// `Unreadable` answers no profiles, so nothing may be decided from it: not
/// whether this address is one of the saved Workspaces, not which Workspace
/// answered there before, and not what a list built from it would replace.
/// A connection is refused while that is so, rather than opening a Workspace
/// whose identity cannot be checked or writing one Workspace over a record
/// that still holds up to sixteen. The record is left exactly as it is,
/// byte for byte; a passing read error passes, and a record a newer build
/// wrote stays that build's to read.
///
/// `Never` is not this: nothing was ever saved, so there is nothing to check
/// against and nothing to lose, and the first Workspace is written normally.
pub fn unusable(saved: &Saved) -> Option<&str> {
    match saved {
        Saved::Unreadable(reason) => Some(reason),
        Saved::Never | Saved::Profiles { .. } => None,
    }
}

/// A name for a Workspace nobody has named yet: its host, which is what the
/// person typed and recognises.
pub fn name_for(url: &Url) -> String {
    let host = url.host_str().unwrap_or("Workspace");
    let name: String = host.chars().take(NAME_LIMIT).collect();
    if name.is_empty() { "Workspace".into() } else { name }
}

/// An identifier for a new profile that no profile in `profiles` has.
pub fn next_id(profiles: &[Profile]) -> String {
    (1..)
        .map(|n| format!("core-{n}"))
        .find(|id| profiles.iter().all(|profile| profile.id != *id))
        .expect("an unused profile id")
}

/// Saves `profiles` with `selected` as the one last opened. On an error
/// nothing is changed: the old record, if any, is still the one read.
pub fn save(path: &Path, profiles: &[Profile], selected: Option<&str>) -> io::Result<()> {
    save_with(path, profiles, selected, |staged, path| std::fs::rename(staged, path))
}

fn save_with(
    path: &Path,
    profiles: &[Profile],
    selected: Option<&str>,
    rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    if profiles.len() > PROFILE_LIMIT {
        return Err(io::Error::other(format!("this app keeps up to {PROFILE_LIMIT} Workspaces")));
    }
    let record = serde_json::json!({
        "version": 1,
        "profiles": profiles.iter().map(Profile::to_json).collect::<Vec<_>>(),
        "selected": selected,
    });
    let text = record.to_string();
    // Never write what this app could not read back. `read` would answer
    // Unreadable, and a later connect starts from no profiles at all and
    // writes only the Workspace it just opened, losing every other one.
    // Refusing leaves the old record, which is still the one read.
    if text.len() as u64 > LIMIT {
        return Err(io::Error::other("this record is larger than this app reads back"));
    }
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let staged = path.with_extension("json.new");
    let saved = std::fs::File::create(&staged)
        .and_then(|mut file| {
            file.write_all(text.as_bytes())?;
            file.sync_all()
        })
        .and_then(|()| rename(&staged, path));
    if saved.is_err() && staged.is_file() {
        let _ = std::fs::remove_file(&staged);
    }
    saved
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core(address: &str) -> Url {
        crate::core_url::parse(address).unwrap()
    }

    fn profile(id: &str, name: &str, address: &str, workspace: Option<&str>) -> Profile {
        Profile {
            id: id.into(),
            name: name.into(),
            url: core(address),
            workspace_id: workspace.map(str::to_owned),
        }
    }

    fn folder() -> (std::path::PathBuf, std::path::PathBuf) {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("yuzuno-ios-core-profiles-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data").join("core.json");
        (dir, path)
    }

    #[test]
    fn nothing_saved_yet_is_a_first_launch() {
        let (dir, path) = folder();
        assert_eq!(read(&path), Saved::Never);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn profiles_are_saved_and_read_back_with_which_one_was_open() {
        let (dir, path) = folder();
        let kept = vec![
            profile("core-1", "Home", "https://one.example.ts.net", Some("w-one")),
            profile("core-2", "Studio", "https://two.example.ts.net:8444", None),
        ];
        save(&path, &kept, Some("core-2")).unwrap();
        assert_eq!(read(&path), Saved::Profiles { profiles: kept, selected: Some("core-2".into()) });
        assert!(!path.with_extension("json.new").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn two_workspaces_may_share_a_name_and_stay_apart() {
        let (dir, path) = folder();
        // The same name on two addresses, and the same address under two
        // names: neither makes them one Workspace.
        let kept = vec![
            profile("core-1", "Home", "https://one.example.ts.net", Some("w-one")),
            profile("core-2", "Home", "https://two.example.ts.net", Some("w-two")),
            profile("core-3", "Home again", "https://one.example.ts.net", Some("w-one")),
        ];
        save(&path, &kept, None).unwrap();
        let Saved::Profiles { profiles, selected } = read(&path) else { panic!("{:?}", read(&path)) };
        assert_eq!(profiles, kept);
        assert_eq!(selected, None, "none was opened");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_record_one_address_at_a_time_is_read_as_one_profile_named_for_its_host() {
        let (dir, path) = folder();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"coreUrl":"https://one.example.ts.net/"}"#).unwrap();
        assert_eq!(
            read(&path),
            Saved::Profiles {
                profiles: vec![profile("core", "one.example.ts.net", "https://one.example.ts.net", None)],
                selected: Some("core".into()),
            },
            "an address saved by an older version is still offered, with no workspace known for it yet"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_save_that_cannot_write_keeps_the_old_record() {
        let (dir, path) = folder();
        let before_profiles = vec![profile("core-1", "Home", "https://one.example.ts.net", None)];
        save(&path, &before_profiles, Some("core-1")).unwrap();
        let before = std::fs::read(&path).unwrap();
        std::fs::create_dir(path.with_extension("json.new")).unwrap();
        assert!(save(&path, &[profile("core-2", "Other", "https://two.example.ts.net", None)], None).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(read(&path), Saved::Profiles { profiles: before_profiles, selected: Some("core-1".into()) });
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_save_whose_rename_fails_keeps_the_old_record_and_removes_what_it_staged() {
        let (dir, path) = folder();
        let before_profiles = vec![profile("core-1", "Home", "https://one.example.ts.net", None)];
        save(&path, &before_profiles, None).unwrap();
        let before = std::fs::read(&path).unwrap();
        let failed = save_with(&path, &[profile("core-2", "Other", "https://two.example.ts.net", None)], None, |staged, _| {
            assert!(staged.is_file(), "written whole before the rename");
            Err(io::Error::other("rename refused"))
        });
        assert_eq!(failed.unwrap_err().to_string(), "rename refused");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!path.with_extension("json.new").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn more_workspaces_than_this_app_keeps_are_refused_rather_than_cut() {
        let (dir, path) = folder();
        let many: Vec<Profile> = (0..PROFILE_LIMIT + 1)
            .map(|n| profile(&format!("core-{n}"), "Home", &format!("https://n{n}.example.ts.net"), None))
            .collect();
        let refused = save(&path, &many, None).unwrap_err();
        assert!(refused.to_string().contains("keeps up to"), "{refused}");
        assert_eq!(read(&path), Saved::Never, "nothing was written");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_largest_record_these_bounds_allow_still_reads_back() {
        let (dir, path) = folder();
        // Every field at its bound, as many profiles as this app keeps. What
        // matters is that this app cannot write a record it would then read
        // as Unreadable: that answer makes a later connect start from no
        // profiles and write only the Workspace it opened, losing the rest.
        let full: Vec<Profile> = (0..PROFILE_LIMIT)
            .map(|n| {
                profile(
                    &format!("core-{n}"),
                    &"n".repeat(NAME_LIMIT),
                    &format!("https://{}{n}.example.ts.net", "a".repeat(60)),
                    Some(&"w".repeat(WORKSPACE_LIMIT)),
                )
            })
            .collect();
        save(&path, &full, Some("core-0")).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() <= LIMIT, "written within what read accepts");
        assert_eq!(
            read(&path),
            Saved::Profiles { profiles: full, selected: Some("core-0".into()) },
            "read back whole, so no later connect starts from an empty list"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_workspace_name_longer_than_this_app_keeps_makes_that_entry_unusable() {
        let (dir, path) = folder();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let long = "w".repeat(WORKSPACE_LIMIT + 1);
        std::fs::write(
            &path,
            format!(
                "{{\"profiles\":[{{\"id\":\"core-1\",\"name\":\"Home\",\"url\":\"https://one.example.ts.net\",\"workspaceId\":\"{long}\"}}]}}"
            ),
        )
        .unwrap();
        assert_eq!(read(&path), Saved::Unreadable("one of its Workspaces is not one this app opens".into()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_record_that_cannot_be_used_is_not_a_first_launch_and_is_kept() {
        let (dir, path) = folder();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        for (record, why) in [
            ("{\"profiles\":", "it is not a saved Workspace record"),
            ("{\"core\":\"https://one.example.ts.net\"}", "it is not a saved Workspace record"),
            ("{\"coreUrl\":\"http://one.example.ts.net\"}", "its address is not one this app opens"),
            // One Workspace nobody can open makes the record unusable: a
            // saved Workspace is never quietly dropped.
            (
                "{\"profiles\":[{\"id\":\"core-1\",\"name\":\"Home\",\"url\":\"http://one.example.ts.net\"}]}",
                "one of its Workspaces is not one this app opens",
            ),
            (
                "{\"profiles\":[{\"id\":\"core-1\",\"url\":\"https://one.example.ts.net\"}]}",
                "one of its Workspaces is not one this app opens",
            ),
            // The same identifier twice: which one is selected would be
            // guesswork.
            (
                "{\"profiles\":[{\"id\":\"a\",\"name\":\"One\",\"url\":\"https://one.example.ts.net\"},{\"id\":\"a\",\"name\":\"Two\",\"url\":\"https://two.example.ts.net\"}]}",
                "one of its Workspaces is not one this app opens",
            ),
        ] {
            std::fs::write(&path, record).unwrap();
            assert_eq!(read(&path), Saved::Unreadable(why.into()), "{record}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), record, "reading changes nothing");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_selected_workspace_no_longer_saved_is_simply_none() {
        let (dir, path) = folder();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            "{\"profiles\":[{\"id\":\"core-1\",\"name\":\"Home\",\"url\":\"https://one.example.ts.net\"}],\"selected\":\"gone\"}",
        )
        .unwrap();
        let Saved::Profiles { selected, .. } = read(&path) else { panic!("{:?}", read(&path)) };
        assert_eq!(selected, None, "the page asks which one, rather than opening a Workspace that is not there");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_empty_list_is_a_first_launch() {
        let (dir, path) = folder();
        save(&path, &[], None).unwrap();
        assert_eq!(read(&path), Saved::Never);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_record_that_cannot_be_read_says_so() {
        let (dir, path) = folder();
        std::fs::create_dir_all(&path).unwrap();
        let Saved::Unreadable(why) = read(&path) else { panic!("{:?}", read(&path)) };
        assert!(why.starts_with("it could not be read ("), "{why}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_bound_address_is_never_opened_on_an_answer_that_cannot_confirm_it() {
        assert_eq!(opening(Some("w-one"), "w-one"), Opening::Open(Some("w-one".into())));
        // The same address and the same name, a different Workspace.
        assert_eq!(opening(Some("w-one"), "w-two"), Opening::Changed);
        // Never opened here yet: there is nothing to contradict, so it opens
        // and the identity is recorded.
        assert_eq!(opening(None, "w-one"), Opening::Open(Some("w-one".into())));

        // The regression this exists for. A Core that names no Workspace at
        // an address already bound to one proves nothing, and used to be
        // let through as "unknown, go ahead".
        assert_eq!(opening(Some("w-one"), ""), Opening::Unverified);
        // An identifier longer than this keeps is refused, bound or not. It
        // must not be discarded into "named none" either: that is the same
        // downgrade arriving by another route.
        let long = "w".repeat(WORKSPACE_LIMIT + 1);
        assert_eq!(opening(Some("w-one"), &long), Opening::Unkeepable);
        assert_eq!(opening(None, &long), Opening::Unkeepable);
        // Exactly at the limit is kept, not refused.
        let edge = "w".repeat(WORKSPACE_LIMIT);
        assert_eq!(opening(None, &edge), Opening::Open(Some(edge.clone())));

        // An address bound to nothing, answered by a Core too old to name a
        // Workspace: this is the one case that still opens, and it records
        // nothing. The iPhone keeps WORKSPACE_LIMIT at 200, its own bound.
        assert_eq!(opening(None, ""), Opening::Open(None));
        assert_eq!(WORKSPACE_LIMIT, 200, "the iPhone's own bound, not the desktop's");
    }

    /// What `connect_core` does when the page names no profile: the saved
    /// Workspace at this same address, if one is saved there. Keyed on the id
    /// alone, a saved address typed by hand named no profile, so the identity
    /// check never ran and another profile was written for an address already
    /// saved.
    fn at_address<'a>(profiles: &'a [Profile], core: &Url) -> Option<&'a Profile> {
        profiles.iter().find(|kept| kept.url == *core)
    }

    #[test]
    fn a_saved_address_is_found_by_its_address_when_no_profile_is_named() {
        let kept = vec![
            profile("core-1", "Home", "https://one.example.ts.net", Some("w-one")),
            profile("core-2", "Studio", "https://two.example.ts.net:8444", Some("w-two")),
        ];
        // As the page sends it, with and without the trailing slash the app
        // writes: core_url::parse normalises both to the saved URL.
        for typed in ["https://one.example.ts.net", "https://one.example.ts.net/"] {
            let found = at_address(&kept, &core(typed)).expect(typed);
            assert_eq!(found.id, "core-1", "{typed}");
            assert_eq!(found.workspace_id.as_deref(), Some("w-one"), "so the identity check has something to compare");
        }
        // A port is part of the address: another port is another Workspace.
        assert_eq!(at_address(&kept, &core("https://two.example.ts.net:8444")).map(|p| &*p.id), Some("core-2"));
        assert!(at_address(&kept, &core("https://two.example.ts.net")).is_none());
        assert!(at_address(&kept, &core("https://three.example.ts.net")).is_none(), "an address not saved is new");
    }

    #[test]
    fn a_record_that_could_not_be_read_is_usable_for_nothing() {
        // Nothing may be decided from it: not whether an address is saved,
        // not which Workspace answered there, not what writing would replace.
        assert_eq!(
            unusable(&Saved::Unreadable("it could not be read (...)".into())),
            Some("it could not be read (...)")
        );
        // A first launch is not that: nothing saved, nothing to lose.
        assert_eq!(unusable(&Saved::Never), None);
        assert_eq!(
            unusable(&Saved::Profiles {
                profiles: vec![profile("core-1", "Home", "https://one.example.ts.net", None)],
                selected: None,
            }),
            None
        );
    }

    #[test]
    fn a_new_identifier_is_one_no_saved_workspace_uses() {
        let kept = vec![
            profile("core-1", "Home", "https://one.example.ts.net", None),
            profile("core-3", "Studio", "https://three.example.ts.net", None),
        ];
        assert_eq!(next_id(&kept), "core-2");
        assert_eq!(next_id(&[]), "core-1");
    }

    #[test]
    fn a_workspace_nobody_named_is_called_after_its_host() {
        assert_eq!(name_for(&core("https://one.example.ts.net")), "one.example.ts.net");
        assert_eq!(name_for(&core("https://two.example.ts.net:8444")), "two.example.ts.net");
    }

    #[test]
    fn the_page_reads_each_answer_and_is_never_told_a_workspace_is_reachable() {
        assert_eq!(Saved::Never.to_json(), serde_json::json!({"state":"never","profiles":[]}));
        assert_eq!(
            Saved::Unreadable("why".into()).to_json(),
            serde_json::json!({"state":"unreadable","reason":"why","profiles":[]})
        );
        let saved = Saved::Profiles {
            profiles: vec![
                profile("core-1", "Home", "https://one.example.ts.net", Some("w-one")),
                profile("core-2", "Studio", "https://two.example.ts.net", None),
            ],
            selected: Some("core-1".into()),
        };
        let json = saved.to_json();
        assert_eq!(
            json,
            serde_json::json!({
                "state": "saved",
                "selected": "core-1",
                "profiles": [
                    {"id":"core-1","name":"Home","url":"https://one.example.ts.net/","workspaceId":"w-one"},
                    {"id":"core-2","name":"Studio","url":"https://two.example.ts.net/"},
                ],
            })
        );
        let text = json.to_string();
        assert!(!text.contains("reachable"), "saved is not reachable: {text}");
    }
}
