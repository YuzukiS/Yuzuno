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
/// How many addresses this iPhone remembers the Workspace of once their
/// profile is gone. Reaching it refuses the change rather than forgetting
/// the oldest: dropping one would quietly give back an address whose stored
/// data it is protecting. `LIMIT` still bounds the whole record, so with
/// addresses and identifiers at their longest the record runs out of room
/// before this count does.
pub const REMEMBERED_LIMIT: usize = 128;

/// An address this iPhone remembers the Workspace of, with no profile saved
/// for it. Removing a profile took the address off the list, but what the
/// web view stored for that address stayed; this is the little needed to
/// keep a *different* Workspace from being opened onto it. The address and
/// the identity, and deliberately nothing else: no name, and none of the
/// stored data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Remembered {
    pub url: Url,
    pub workspace_id: String,
}

impl Remembered {
    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "url": self.url.as_str(), "workspaceId": self.workspace_id })
    }

    fn from_json(value: &serde_json::Value) -> Option<Self> {
        let url = crate::core_url::parse(value.get("url")?.as_str()?).ok()?;
        let workspace_id = value.get("workspaceId")?.as_str()?;
        if workspace_id.is_empty() || workspace_id.len() > WORKSPACE_LIMIT {
            return None;
        }
        Some(Self { url, workspace_id: workspace_id.to_owned() })
    }
}

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
    Profiles {
        profiles: Vec<Profile>,
        selected: Option<String>,
        /// Addresses with no profile whose Workspace is still remembered.
        remembered: Vec<Remembered>,
    },
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
            Saved::Profiles { profiles, selected, remembered } => serde_json::json!({
                "state": "saved",
                "profiles": profiles.iter().map(Profile::to_json).collect::<Vec<_>>(),
                "selected": selected,
                // Shown because they are why a connection there can be
                // refused, and a refusal with no visible cause looks like a
                // fault.
                "remembered": remembered.iter().map(Remembered::to_json).collect::<Vec<_>>(),
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

    pub fn remembered(&self) -> &[Remembered] {
        match self {
            Saved::Profiles { remembered, .. } => remembered,
            _ => &[],
        }
    }

    /// The Workspace this record knows for `url`: the profile saved at that
    /// address, or failing that the address this still remembers. One place
    /// answers it, so a removed profile cannot quietly leave the address
    /// unbound while its stored data is still there.
    pub fn workspace_for(&self, url: &Url) -> Option<&str> {
        // Any profile at this address, not the first one listed. Two
        // profiles may label one address ("Home" and "Home again"), and a
        // label that records no Workspace must not make the address look
        // unbound while another label at it knows better: that opened a
        // different Workspace onto the first one's stored data.
        //
        // Should two labels at one address disagree, the first that knows
        // one decides, so a different answer is refused rather than opened.
        // Refusing is the safe direction; `settle` keeps them in agreement.
        if self.profiles().iter().any(|profile| profile.url == *url) {
            return self
                .profiles()
                .iter()
                .filter(|profile| profile.url == *url)
                .find_map(|profile| profile.workspace_id.as_deref());
        }
        self.remembered()
            .iter()
            .find(|known| known.url == *url)
            .map(|known| known.workspace_id.as_str())
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
    read_bytes(&bytes)
}

/// The record, from the bytes of one. Split out from [`read`] so a save can
/// be checked by reading back what it is about to write, through this very
/// reader rather than through a second copy of its rules kept in step with
/// it by hand.
pub fn read_bytes(bytes: &[u8]) -> Saved {
    if bytes.len() as u64 > LIMIT {
        return Saved::Unreadable("it is not a saved Workspace record".into());
    }
    let Ok(record) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return Saved::Unreadable("it is not a saved Workspace record".into());
    };
    // The record one address at a time, from before this app kept names.
    if record.get("profiles").is_none() {
        return match record.get("coreUrl").and_then(serde_json::Value::as_str) {
            Some(address) => match crate::core_url::parse(address) {
                Ok(url) => {
                    let profile = Profile { id: "core".into(), name: name_for(&url), url, workspace_id: None };
                    let selected = Some(profile.id.clone());
                    // The one-address record had nowhere to remember an
                    // address it no longer listed, so there is none to read.
                    Saved::Profiles { profiles: vec![profile], selected, remembered: Vec::new() }
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
    let mut remembered: Vec<Remembered> = Vec::new();
    match record.get("remembered") {
        None | Some(serde_json::Value::Null) => {}
        Some(listed) => {
            let Some(listed) = listed.as_array() else {
                return Saved::Unreadable("it is not a saved Workspace record".into());
            };
            if listed.len() > REMEMBERED_LIMIT {
                return Saved::Unreadable("it remembers more addresses than this app keeps".into());
            }
            for value in listed {
                match Remembered::from_json(value) {
                    // One address this cannot use makes the record unusable,
                    // as a listed Workspace does: dropping it would hand back
                    // an address whose stored data it was keeping apart.
                    None => return Saved::Unreadable("one of the addresses it remembers is not one this app opens".into()),
                    Some(known) if remembered.iter().any(|kept: &Remembered| kept.url == known.url) => {
                        return Saved::Unreadable("it remembers one address twice".into())
                    }
                    // An address is listed or remembered, never both: two
                    // records of one address could disagree about which
                    // Workspace is there, and nothing may choose between them.
                    Some(known) if profiles.iter().any(|profile| profile.url == known.url) => {
                        return Saved::Unreadable("it remembers a Workspace for an address it also lists".into())
                    }
                    Some(known) => remembered.push(known),
                }
            }
        }
    }
    // A remembered address is something saved, so this is no first launch.
    if profiles.is_empty() && remembered.is_empty() {
        return Saved::Never;
    }
    let selected = record
        .get("selected")
        .and_then(serde_json::Value::as_str)
        .filter(|id| profiles.iter().any(|profile| profile.id == *id))
        .map(str::to_owned);
    Saved::Profiles { profiles, selected, remembered }
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

/// What the list and the remembered addresses become after a change: one
/// rule, in one place -- **an address never loses the Workspace it was known
/// to hold.**
///
/// Why it exists: removing a profile used to drop its `workspaceId` with it,
/// leaving the address bound to nothing while what the web view stored for
/// it stayed. The next Core to answer there -- any Core -- was then opened
/// onto the previous Workspace's conversations, drafts and reading places.
///
/// Two profiles may label one address, so "removed" is not the same as "no
/// longer listed". Both cases are handled, and they differ:
///
/// * **No label left at the address.** It is remembered: the address and the
///   identifier, nothing else.
/// * **A label is still there.** The address stays listed, so it cannot also
///   be remembered -- the record would then hold two answers for one
///   address. Instead a label that records no Workspace takes the one the
///   address is known to hold. Removing the label that happened to carry it
///   therefore does not leave the address unbound, and the labels at one
///   address stay in agreement.
///
/// Nothing is cleared to pay for any of this.
pub fn settle(before: &Saved, profiles: &[Profile]) -> (Vec<Profile>, Vec<Remembered>) {
    let mut profiles = profiles.to_vec();
    let mut remembered = before.remembered().to_vec();

    // Every address the record knew a Workspace for, as it was. A profile
    // that recorded one speaks for its address; so does a remembered one.
    let mut knew: Vec<(Url, String)> = Vec::new();
    let note = |url: &Url, workspace: &str, knew: &mut Vec<(Url, String)>| {
        if !knew.iter().any(|(at, _)| at == url) {
            knew.push((url.clone(), workspace.to_owned()));
        }
    };
    for profile in before.profiles() {
        if let Some(workspace) = profile.workspace_id.as_deref() {
            note(&profile.url, workspace, &mut knew);
        }
    }
    for known in before.remembered() {
        note(&known.url, &known.workspace_id, &mut knew);
    }

    for (url, workspace) in knew {
        let still_listed: Vec<usize> = profiles
            .iter()
            .enumerate()
            .filter(|(_, profile)| profile.url == url)
            .map(|(at, _)| at)
            .collect();
        if still_listed.is_empty() {
            match remembered.iter_mut().find(|kept| kept.url == url) {
                // An address already remembered is updated in place: it
                // takes no further room.
                Some(kept) => kept.workspace_id = workspace,
                None => remembered.push(Remembered { url, workspace_id: workspace }),
            }
            continue;
        }
        for at in still_listed {
            if profiles[at].workspace_id.is_none() {
                profiles[at].workspace_id = Some(workspace.clone());
            }
        }
    }
    // An address is listed or remembered, never both.
    remembered.retain(|known| !profiles.iter().any(|profile| profile.url == known.url));
    (profiles, remembered)
}

/// Forget what this remembers about one address, and only that. `None` when
/// the address is not remembered, so the caller says so rather than
/// reporting a change it did not make.
///
/// What is forgotten is the record of which Workspace was there. Nothing
/// stored for the address is read, moved or cleared by this -- it cannot be,
/// from here -- so a Workspace opened there afterwards may still find the
/// previous one's drafts. That is what makes this a deliberate step of its
/// own rather than part of removing a profile.
pub fn forgetting(remembered: &[Remembered], url: &Url) -> Option<Vec<Remembered>> {
    if !remembered.iter().any(|known| known.url == *url) {
        return None;
    }
    Some(remembered.iter().filter(|known| known.url != *url).cloned().collect())
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
pub fn save(
    path: &Path,
    profiles: &[Profile],
    selected: Option<&str>,
    remembered: &[Remembered],
) -> io::Result<()> {
    save_with(path, profiles, selected, remembered, |staged, path| std::fs::rename(staged, path))
}

fn save_with(
    path: &Path,
    profiles: &[Profile],
    selected: Option<&str>,
    remembered: &[Remembered],
    rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    if profiles.len() > PROFILE_LIMIT {
        return Err(io::Error::other(format!("this app keeps up to {PROFILE_LIMIT} Workspaces")));
    }
    if remembered.len() > REMEMBERED_LIMIT {
        return Err(io::Error::other(format!(
            "this app remembers the Workspace of up to {REMEMBERED_LIMIT} addresses it no longer lists. Nothing was changed. Forget an address it remembers to make room, which forgets only that record of which Workspace was there."
        )));
    }
    if let Some(both) = remembered.iter().find(|known| profiles.iter().any(|profile| profile.url == known.url)) {
        return Err(io::Error::other(format!(
            "\u{201C}{}\u{201D} would be both listed and remembered, and the two could disagree about which Workspace is there",
            both.url
        )));
    }
    let record = serde_json::json!({
        "version": 1,
        "profiles": profiles.iter().map(Profile::to_json).collect::<Vec<_>>(),
        "selected": selected,
        "remembered": remembered.iter().map(Remembered::to_json).collect::<Vec<_>>(),
    });
    let text = record.to_string();
    // Never write what this app could not read back. `read` would answer
    // Unreadable, and a later connect starts from no profiles at all and
    // writes only the Workspace it just opened, losing every other one.
    // Refusing leaves the old record, which is still the one read.
    if text.len() as u64 > LIMIT {
        return Err(io::Error::other("this record is larger than this app reads back"));
    }
    // And checked by doing it, through `read_bytes` -- the very reader a
    // later launch uses -- rather than by restating that reader's rules
    // here and keeping the two in step by hand. The size rule above was
    // copied here while the rest were not, which is how a record this app
    // could write but not read stayed reachable.
    match read_bytes(text.as_bytes()) {
        Saved::Profiles { .. } | Saved::Never => {}
        Saved::Unreadable(reason) => {
            return Err(io::Error::other(format!("this app could not read back what it was about to save ({reason})")))
        }
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
        save(&path, &kept, Some("core-2"), &[]).unwrap();
        assert_eq!(read(&path), Saved::Profiles { profiles: kept, selected: Some("core-2".into()), remembered: Vec::new() });
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
        save(&path, &kept, None, &[]).unwrap();
        let Saved::Profiles { profiles, selected, .. } = read(&path) else { panic!("{:?}", read(&path)) };
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
                remembered: Vec::new(),
            },
            "an address saved by an older version is still offered, with no workspace known for it yet"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_save_that_cannot_write_keeps_the_old_record() {
        let (dir, path) = folder();
        let before_profiles = vec![profile("core-1", "Home", "https://one.example.ts.net", None)];
        save(&path, &before_profiles, Some("core-1"), &[]).unwrap();
        let before = std::fs::read(&path).unwrap();
        std::fs::create_dir(path.with_extension("json.new")).unwrap();
        assert!(save(&path, &[profile("core-2", "Other", "https://two.example.ts.net", None)], None, &[]).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(read(&path), Saved::Profiles { profiles: before_profiles, selected: Some("core-1".into()), remembered: Vec::new() });
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_save_whose_rename_fails_keeps_the_old_record_and_removes_what_it_staged() {
        let (dir, path) = folder();
        let before_profiles = vec![profile("core-1", "Home", "https://one.example.ts.net", None)];
        save(&path, &before_profiles, None, &[]).unwrap();
        let before = std::fs::read(&path).unwrap();
        let failed = save_with(&path, &[profile("core-2", "Other", "https://two.example.ts.net", None)], None, &[], |staged, _: &Path| {
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
        let refused = save(&path, &many, None, &[]).unwrap_err();
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
        save(&path, &full, Some("core-0"), &[]).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() <= LIMIT, "written within what read accepts");
        assert_eq!(
            read(&path),
            Saved::Profiles { profiles: full, selected: Some("core-0".into()), remembered: Vec::new() },
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
        save(&path, &[], None, &[]).unwrap();
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

    fn known(address: &str, workspace: &str) -> Remembered {
        Remembered { url: crate::core_url::parse(address).unwrap(), workspace_id: workspace.into() }
    }

    #[test]
    fn removing_a_profile_leaves_its_address_remembered() {
        let (dir, path) = folder();
        let home = profile("core-1", "Home", "https://one.example.ts.net", Some("w-one"));
        save(&path, &[home], Some("core-1"), &[]).unwrap();
        let before = read(&path);

        // The failure this exists for: the profile went, its workspaceId went
        // with it, and the address was bound to nothing -- while what the web
        // view stored for it stayed.
        let (_, after) = settle(&before, &[]);
        assert_eq!(after, vec![known("https://one.example.ts.net", "w-one")]);
        save(&path, &[], None, &after).unwrap();
        let saved = read(&path);
        assert_eq!(saved.profiles(), &[]);
        assert_eq!(saved.workspace_for(&crate::core_url::parse("https://one.example.ts.net").unwrap()), Some("w-one"));
        // A remembered address is not a first launch: Never here would offer
        // to save the first Workspace that answers.
        assert!(!matches!(saved, Saved::Never));

        // And it is no way around the refusal: another Workspace at that
        // address is still refused, one that cannot be checked still is, and
        // the one that was there still opens.
        let address = crate::core_url::parse("https://one.example.ts.net").unwrap();
        assert_eq!(opening(saved.workspace_for(&address), "w-two"), Opening::Changed);
        assert_eq!(opening(saved.workspace_for(&address), ""), Opening::Unverified);
        assert_eq!(opening(saved.workspace_for(&address), "w-one"), Opening::Open(Some("w-one".into())));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn two_labels_at_one_address_cannot_make_it_look_unbound() {
        let (dir, path) = folder();
        // "Home again" is a second label for one address, which this app
        // allows. Only one of them records the Workspace.
        let unnamed = profile("core-1", "Home", "https://one.example.ts.net", None);
        let named = profile("core-2", "Home again", "https://one.example.ts.net", Some("w-one"));
        save(&path, &[unnamed.clone(), named.clone()], Some("core-2"), &[]).unwrap();
        let saved = read(&path);
        let address = crate::core_url::parse("https://one.example.ts.net").unwrap();

        // The regression: the label without a Workspace was listed first, so
        // the address looked unbound and a different Workspace opened onto
        // the stored data of the one that is there.
        assert_eq!(saved.workspace_for(&address), Some("w-one"), "any label at the address, not the first");
        assert_eq!(opening(saved.workspace_for(&address), "w-two"), Opening::Changed);
        assert_eq!(opening(saved.workspace_for(&address), ""), Opening::Unverified);

        // And removing the label that carried it does not lose it: the
        // address is still listed, so it cannot be remembered, and the
        // remaining label takes the Workspace the address is known to hold.
        let (profiles, remembered) = settle(&saved, &[unnamed]);
        assert_eq!(remembered, vec![], "still listed, so not remembered");
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].workspace_id.as_deref(), Some("w-one"), "the address kept its Workspace");
        // Written and read back, so this is what a later launch sees.
        save(&path, &profiles, Some("core-1"), &remembered).unwrap();
        let left = read(&path);
        assert_eq!(left.workspace_for(&address), Some("w-one"));
        assert_eq!(opening(left.workspace_for(&address), "w-two"), Opening::Changed);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_address_nobody_named_leaves_nothing_remembered() {
        let (dir, path) = folder();
        let home = profile("core-1", "Home", "https://one.example.ts.net", None);
        save(&path, &[home], Some("core-1"), &[]).unwrap();
        // No Core there ever said which Workspace it was, so there is nothing
        // to protect and nothing is claimed about the address.
        assert_eq!(settle(&read(&path), &[]).1, vec![]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_address_is_listed_or_remembered_and_never_both_on_this_iphone() {
        let (dir, path) = folder();
        let home = profile("core-1", "Home", "https://one.example.ts.net", Some("w-one"));
        let same = vec![known("https://one.example.ts.net", "w-two")];
        // Writing both is refused: the two could disagree about which
        // Workspace is there, and nothing may choose between them.
        let refused = save(&path, &[home.clone()], Some("core-1"), &same).unwrap_err().to_string();
        assert!(refused.contains("both listed and remembered"), "{refused}");
        assert_eq!(read(&path), Saved::Never, "nothing was written");

        // Reading such a record refuses it rather than preferring one side.
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            br#"{"version":1,"profiles":[{"id":"core-1","name":"Home","url":"https://one.example.ts.net/","workspaceId":"w-one"}],"selected":"core-1","remembered":[{"url":"https://one.example.ts.net/","workspaceId":"w-two"}]}"#,
        )
        .unwrap();
        assert_eq!(read(&path), Saved::Unreadable("it remembers a Workspace for an address it also lists".into()));

        // A profile taking a remembered address takes the record with it.
        let (dir2, path2) = folder();
        save(&path2, &[], None, &same).unwrap();
        assert_eq!(settle(&read(&path2), &[home]).1, vec![]);
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(dir2).unwrap();
    }

    #[test]
    fn forgetting_an_address_on_this_iphone_forgets_only_that_one() {
        let (dir, path) = folder();
        let two = vec![known("https://one.example.ts.net", "w-one"), known("https://two.example.ts.net", "w-two")];
        let left = forgetting(&two, &crate::core_url::parse("https://one.example.ts.net").unwrap())
            .expect("it was remembered");
        assert_eq!(left, vec![known("https://two.example.ts.net", "w-two")]);
        // An address this does not remember is not a silent success.
        assert_eq!(forgetting(&two, &crate::core_url::parse("https://three.example.ts.net").unwrap()), None);
        // Afterwards the address is unknown again -- the whole effect.
        save(&path, &[], None, &left).unwrap();
        assert_eq!(read(&path).workspace_for(&crate::core_url::parse("https://one.example.ts.net").unwrap()), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remembering_more_addresses_than_this_iphone_keeps_changes_nothing() {
        let (dir, path) = folder();
        let full: Vec<Remembered> = (0..REMEMBERED_LIMIT)
            .map(|n| known(&format!("https://a{n}.example.ts.net"), &format!("w-{n}")))
            .collect();
        save(&path, &[], None, &full).expect("the limit itself fits");
        let before = std::fs::read(&path).unwrap();

        let mut over = full.clone();
        over.push(known("https://over.example.ts.net", "w-over"));
        let refused = save(&path, &[], None, &over).unwrap_err().to_string();
        assert!(refused.contains(&REMEMBERED_LIMIT.to_string()), "{refused}");
        // Refused, not evicted: dropping the oldest would hand back an
        // address whose stored data it was keeping apart.
        assert!(refused.contains("Nothing was changed"), "{refused}");
        assert!(refused.contains("forgets only that record"), "{refused}");
        assert_eq!(std::fs::read(&path).unwrap(), before, "the record is as it was");

        // An address already remembered is updated in place and takes no
        // further room, even at the limit.
        let mut again = full.clone();
        again[0] = known("https://a0.example.ts.net", "w-moved");
        assert_eq!(again.len(), REMEMBERED_LIMIT);
        save(&path, &[], None, &again).expect("an update takes no further room");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_save_is_checked_by_reading_it_back_through_the_same_reader() {
        let (dir, path) = folder();
        // A remembered identifier the reader would reject is refused by the
        // writer, because the writer asks the reader rather than keeping its
        // own copy of the rules.
        let bad = vec![Remembered {
            url: crate::core_url::parse("https://one.example.ts.net").unwrap(),
            workspace_id: "w".repeat(WORKSPACE_LIMIT + 1),
        }];
        let refused = save(&path, &[], None, &bad).unwrap_err().to_string();
        assert!(refused.contains("could not read back"), "{refused}");
        assert_eq!(read(&path), Saved::Never, "nothing was written");
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
                remembered: Vec::new(),
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
            remembered: vec![Remembered {
                url: crate::core_url::parse("https://gone.example.ts.net").unwrap(),
                workspace_id: "w-gone".into(),
            }],
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
                // The page is told which addresses are remembered, because
                // they are why a connection there can be refused.
                "remembered": [
                    {"url":"https://gone.example.ts.net/","workspaceId":"w-gone"},
                ],
            })
        );
        let text = json.to_string();
        assert!(!text.contains("reachable"), "saved is not reachable: {text}");
    }
}
