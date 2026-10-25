//! The named Workspaces this computer keeps (T-195), in the same `core.json`
//! the one-address record lived in. An entry is a name this person gave it,
//! the address, the `workspaceId` the Core there last answered with, and --
//! for at most one of them -- the WSL start profile (T-171).
//!
//! **One entry may start a Core; the rest are addresses to connect to.** The
//! one-address record saved `coreUrl` at the top and rebuilt the start
//! profile's own `core` from it (`connection::saved_start`), so keeping one
//! start beside a list and pointing `coreUrl` at whichever entry is selected
//! would silently aim a confirmed start at another Core. A start therefore
//! belongs to its entry and names the address it was saved for, and a start
//! is offered only while the entry still has that address.
//!
//! What may put a start here is unchanged: a Core's own
//! `/api/desktop/start-profile` answer and this computer's start entry
//! accepting it (`connection::StartProfile`, `merge_offered`, `settle`).
//! Migration carries the old profile to the entry it was saved for and
//! nowhere else; inheriting it is not another Core authorizing it. An old
//! record that names no `workspaceId` keeps its start unverified -- never
//! rewritten as confirmed -- until a later connection learns the identity.
//!
//! Saved is not reachable: nothing here reaches a Core.

use serde_json::Value;
use url::Url;

use crate::connection::{parse_core_url, StartProfile};

/// More than any record this writes: sixteen entries of this shape fit well
/// inside it. The one-address record allowed 4 KiB; a list needs more.
pub const LIMIT: usize = 16_384;
/// How many Workspaces this keeps.
pub const ENTRY_LIMIT: usize = 16;
/// The longest name kept. Longer is refused rather than cut.
pub const NAME_LIMIT: usize = 60;
/// The longest `workspaceId` kept, as a Core's health answer may be large.
pub const WORKSPACE_LIMIT: usize = 64;
/// How many addresses this remembers the Workspace of once their entry is
/// gone. Reaching it refuses the change rather than forgetting the oldest:
/// dropping one would quietly give back the address whose stored data this
/// is protecting. [`LIMIT`] still bounds the whole file, so addresses and
/// identifiers at their longest run out of room before this count does.
pub const REMEMBERED_LIMIT: usize = 128;

/// An address this app remembers the Workspace of, with no entry listed for
/// it. Removing an entry took the address off the list, but what the web
/// view stored for that address stayed; this is the little that is needed to
/// keep a *different* Workspace from being opened onto it. It holds the
/// address and the identity, and deliberately nothing else -- no name, no
/// start profile, and none of the stored data itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Remembered {
    pub url: Url,
    pub workspace_id: String,
}

/// One named Workspace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// This app's own identifier, so a rename keeps which entry is selected
    /// and which one may start, and two entries may share a name.
    pub id: String,
    pub name: String,
    pub url: Url,
    /// What the Core there last answered with, once one has answered.
    pub workspace_id: Option<String>,
    /// The WSL start profile saved for *this* entry, at the address below.
    /// At most one entry in a record has one.
    pub start: Option<StartProfile>,
}

impl Entry {
    /// Whether this entry may be started now: it has a profile, and still
    /// has the address that profile was saved for. `StartProfile.core` is
    /// rebuilt from this entry's own address when read, so the two agree by
    /// construction; retargeting the entry drops the profile instead of
    /// carrying it (see [`read`]).
    pub fn startable(&self) -> bool {
        self.start.as_ref().is_some_and(|start| start.core == self.url)
    }
}

/// What the record says.
#[derive(Debug, PartialEq, Eq)]
pub enum Saved {
    /// Nothing was ever saved.
    Never,
    Entries {
        entries: Vec<Entry>,
        selected: Option<String>,
        /// Addresses with no entry whose Workspace is still remembered.
        remembered: Vec<Remembered>,
    },
    /// A record that cannot be used, and why. It is left exactly as it is.
    Unusable(String),
}

impl Saved {
    pub fn entries(&self) -> &[Entry] {
        match self {
            Saved::Entries { entries, .. } => entries,
            _ => &[],
        }
    }

    pub fn remembered(&self) -> &[Remembered] {
        match self {
            Saved::Entries { remembered, .. } => remembered,
            _ => &[],
        }
    }

    /// The Workspace this record knows for `url`: the entry listed at that
    /// address, or failing that the address this still remembers. One place
    /// answers it, so a removed entry cannot quietly leave the address
    /// unbound while its stored data is still there.
    pub fn workspace_for(&self, url: &Url) -> Option<&str> {
        if let Some(entry) = self.entries().iter().find(|entry| entry.url == *url) {
            return entry.workspace_id.as_deref();
        }
        self.remembered()
            .iter()
            .find(|known| known.url == *url)
            .map(|known| known.workspace_id.as_str())
    }

    /// The entry that may start a Core, when one may. Reading convenience
    /// for the checks here; the app asks each entry directly, where it has
    /// one in hand.
    #[cfg(test)]
    pub fn startable(&self) -> Option<&Entry> {
        self.entries().iter().find(|entry| entry.startable())
    }
}

/// Why a record may not be used, when it may not. Nothing may be decided
/// from such a record -- not which Workspace is at an address, not what a
/// list built from it would replace -- so a connection is refused while it
/// is so and the bytes are left alone.
pub fn unusable(saved: &Saved) -> Option<&str> {
    match saved {
        Saved::Unusable(reason) => Some(reason),
        Saved::Never | Saved::Entries { .. } => None,
    }
}

fn name_ok(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= NAME_LIMIT
}

fn workspace_ok(workspace: &str) -> bool {
    !workspace.is_empty() && workspace.len() <= WORKSPACE_LIMIT
}

/// What a Core's answer lets this do with the entry saved at its address.
#[derive(Debug, PartialEq, Eq)]
pub enum Opening {
    /// Open it, and record this identity for that entry. `None` when there
    /// is none to record and none was saved: nothing is claimed either way.
    Open(Option<String>),
    /// It named another Workspace than the one saved here.
    Changed,
    /// It named none, and this address is bound to one. The binding is not
    /// downgraded to unknown so the door can be opened: an answer that names
    /// nothing cannot show this is the same Workspace, and opening it anyway
    /// is the draft-sharing case this refuses. An entry bound to nothing is
    /// a different matter -- there is nothing to contradict.
    Unverified,
    /// It named one longer than this keeps. Refused outright rather than
    /// kept as absent: storing it would make the saved list unreadable, and
    /// treating it as absent would open an address whose answer this cannot
    /// check. The record is left as it is.
    Unkeepable,
}

/// `known` is what the entry at this address recorded; `answered` is what
/// the Core just said, where a Core that names none says nothing at all.
pub fn opening(known: Option<&str>, answered: &str) -> Opening {
    if answered.is_empty() {
        return match known {
            Some(_) => Opening::Unverified,
            None => Opening::Open(None),
        };
    }
    if !workspace_ok(answered) {
        return Opening::Unkeepable;
    }
    match known {
        Some(known) if known != answered => Opening::Changed,
        _ => Opening::Open(Some(answered.to_owned())),
    }
}





/// What to remember after a change to the list. Every address already
/// remembered stays; an entry that is gone leaves its address remembered,
/// when a Core there had named a Workspace; and an address an entry now has
/// is listed rather than remembered.
///
/// This is the whole of why it exists: removing an entry used to drop its
/// `workspaceId` with it, leaving the address bound to nothing while what
/// the web view stored for it stayed. The next Core to answer there -- any
/// Core -- was then opened onto the previous Workspace's conversations,
/// drafts and reading places. Remembering costs an address and an
/// identifier, and nothing is cleared to pay for it.
pub fn remembering(before: &Saved, entries: &[Entry]) -> Vec<Remembered> {
    let mut remembered = before.remembered().to_vec();
    for gone in before.entries() {
        if entries.iter().any(|entry| entry.url == gone.url) {
            continue;
        }
        let Some(workspace_id) = gone.workspace_id.clone() else {
            // Nothing was ever known about this address, so there is nothing
            // to protect and nothing to claim.
            continue;
        };
        let known = Remembered { url: gone.url.clone(), workspace_id };
        // An address already remembered is updated in place: it takes no
        // further room.
        match remembered.iter_mut().find(|kept| kept.url == known.url) {
            Some(kept) => *kept = known,
            None => remembered.push(known),
        }
    }
    remembered.retain(|known| !entries.iter().any(|entry| entry.url == known.url));
    remembered
}

/// Forget what this remembers about one address, and only that. `None` when
/// the address is not remembered, so the caller says so rather than
/// reporting a change it did not make.
///
/// What is forgotten is the record of which Workspace was there. Nothing
/// stored for the address is read, moved or cleared by this -- it cannot be,
/// from here -- so a Workspace opened there afterwards may still find the
/// previous one's drafts. That is what makes this a deliberate step of its
/// own rather than part of removing an entry.
pub fn forgetting(remembered: &[Remembered], url: &Url) -> Option<Vec<Remembered>> {
    if !remembered.iter().any(|known| known.url == *url) {
        return None;
    }
    Some(remembered.iter().filter(|known| known.url != *url).cloned().collect())
}

/// A name for a Workspace nobody has named: its host and port, which is what
/// was typed. A desktop Core is usually on loopback, where the port is what
/// tells two of them apart, so the port belongs in the name.
pub fn name_for(url: &Url) -> String {
    let host = url.host_str().unwrap_or("Workspace");
    let name = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    let name: String = name.chars().take(NAME_LIMIT).collect();
    if name.is_empty() { "Workspace".into() } else { name }
}

pub fn next_id(entries: &[Entry]) -> String {
    (1..)
        .map(|n| format!("core-{n}"))
        .find(|id| entries.iter().all(|entry| entry.id != *id))
        .expect("an unused entry id")
}

fn start_json(start: &StartProfile) -> Value {
    serde_json::json!({
        // The address this profile was saved for. An entry pointed somewhere
        // else no longer has it: it is not carried to the new address, and
        // never to another entry.
        "coreUrl": start.core.as_str(),
        "wslDistro": start.wsl_distro,
        "user": start.user,
        "installDir": start.install_dir,
        "workspaceId": start.workspace_id,
        "confirmed": start.confirmed,
    })
}

/// The start profile in `value`, for an entry whose address is `url`. `None`
/// when there is none, when it was saved for another address, or when any
/// part of it no longer passes the checks it passed when saved.
fn start_from_json(value: &Value, url: &Url) -> Option<StartProfile> {
    let start = value.get("start")?;
    if start.is_null() {
        return None;
    }
    // Saved for this entry's address, and no other. A record that says
    // otherwise does not have its start quietly re-aimed here.
    let saved_for = parse_core_url(start["coreUrl"].as_str()?).ok()?;
    if saved_for != *url {
        return None;
    }
    let profile = StartProfile::new(
        url,
        start["wslDistro"].as_str()?,
        start["user"].as_str()?,
        start["installDir"].as_str()?,
        start["workspaceId"].as_str()?,
    )?;
    // `confirmed` is only what was written. A record from before it, or one
    // that never earned it, stays unconfirmed: this never promotes it.
    Some(StartProfile { confirmed: start["confirmed"] == true, ..profile })
}

fn remembered_from_json(value: &Value) -> Option<Remembered> {
    let url = parse_core_url(value.get("url")?.as_str()?).ok()?;
    let workspace_id = value.get("workspaceId")?.as_str()?;
    if !workspace_ok(workspace_id) {
        return None;
    }
    Some(Remembered { url, workspace_id: workspace_id.to_owned() })
}

fn entry_from_json(value: &Value) -> Option<Entry> {
    let id = value.get("id")?.as_str()?;
    let name = value.get("name")?.as_str()?;
    let url = parse_core_url(value.get("url")?.as_str()?).ok()?;
    if id.is_empty() || id.len() > 64 || !name_ok(name) {
        return None;
    }
    let workspace_id = match value.get("workspaceId") {
        None | Some(Value::Null) => None,
        Some(workspace) => {
            let workspace = workspace.as_str()?;
            if !workspace_ok(workspace) {
                return None;
            }
            Some(workspace.to_owned())
        }
    };
    let start = start_from_json(value, &url);
    Some(Entry { id: id.to_owned(), name: name.to_owned(), url, workspace_id, start })
}

/// Reads the record. The one-address record (`{"coreUrl":…,"start":…}`) is
/// read as one entry named for its address, with its start profile bound to
/// that entry and to that address -- the entry migration made, and no other.
pub fn read(bytes: &[u8]) -> Saved {
    if bytes.len() > LIMIT {
        return Saved::Unusable("it is not a saved Workspace record".into());
    }
    let Ok(record) = serde_json::from_slice::<Value>(bytes) else {
        return Saved::Unusable("it is not a saved Workspace record".into());
    };
    if record.get("entries").is_none() {
        if record.get("coreUrl").and_then(Value::as_str).is_none() {
            return Saved::Unusable("it is not a saved Workspace record".into());
        }
        return match crate::connection::saved_core(bytes) {
            Some(url) => {
                {
                    // The one-address reader this app already had, so the
                    // old record is read here exactly as it was read before:
                    // its `start` is that `coreUrl`'s, and a record from
                    // before `confirmed` stays unconfirmed.
                    let start = crate::connection::saved_start(bytes);
                    let entry = Entry {
                        id: "core".into(),
                        name: name_for(&url),
                        url,
                        // The old record names no Workspace. The start keeps
                        // whatever it had; it is not rewritten as confirmed,
                        // and the identity stays unknown until a Core answers.
                        workspace_id: None,
                        start,
                    };
                    let selected = Some(entry.id.clone());
                    // The one-address record had nowhere to remember an
                    // address it no longer listed, so there is none to read.
                    Saved::Entries { entries: vec![entry], selected, remembered: Vec::new() }
                }
            }
            // Kept apart from "it is not a saved Workspace record" on
            // purpose: the two send a person to different places, so which
            // one it is was decided above.
            None => Saved::Unusable("its address is not one this app opens".into()),
        };
    }
    let Some(listed) = record.get("entries").and_then(Value::as_array) else {
        return Saved::Unusable("it is not a saved Workspace record".into());
    };
    if listed.len() > ENTRY_LIMIT {
        return Saved::Unusable("it holds more Workspaces than this app keeps".into());
    }
    let mut entries: Vec<Entry> = Vec::with_capacity(listed.len());
    for value in listed {
        match entry_from_json(value) {
            Some(entry) if entries.iter().all(|kept| kept.id != entry.id) => entries.push(entry),
            // One entry this cannot use makes the record unusable rather
            // than quietly dropping a Workspace someone saved.
            _ => return Saved::Unusable("one of its Workspaces is not one this app opens".into()),
        }
    }
    // One start, or none. Two would mean guessing which Core a start belongs
    // to, and this would rather refuse than start the wrong one.
    if entries.iter().filter(|entry| entry.start.is_some()).count() > 1 {
        return Saved::Unusable("more than one of its Workspaces is set to start a Core".into());
    }
    let mut remembered: Vec<Remembered> = Vec::new();
    match record.get("remembered") {
        None | Some(Value::Null) => {}
        Some(listed) => {
            let Some(listed) = listed.as_array() else {
                return Saved::Unusable("it is not a saved Workspace record".into());
            };
            if listed.len() > REMEMBERED_LIMIT {
                return Saved::Unusable("it remembers more addresses than this app keeps".into());
            }
            for value in listed {
                match remembered_from_json(value) {
                    // One address this cannot use makes the record unusable,
                    // as a listed Workspace does: dropping it would hand back
                    // an address whose stored data it was keeping apart.
                    None => return Saved::Unusable("one of the addresses it remembers is not one this app opens".into()),
                    Some(known) if remembered.iter().any(|kept: &Remembered| kept.url == known.url) => {
                        return Saved::Unusable("it remembers one address twice".into())
                    }
                    // An address is listed or remembered, never both. Two
                    // records of one address could disagree about which
                    // Workspace is there, and nothing may choose between them.
                    Some(known) if entries.iter().any(|entry| entry.url == known.url) => {
                        return Saved::Unusable("it remembers a Workspace for an address it also lists".into())
                    }
                    Some(known) => remembered.push(known),
                }
            }
        }
    }
    // A remembered address is something saved, so this is no first launch.
    if entries.is_empty() && remembered.is_empty() {
        return Saved::Never;
    }
    let selected = record
        .get("selected")
        .and_then(Value::as_str)
        .filter(|id| entries.iter().any(|entry| entry.id == *id))
        .map(str::to_owned);
    Saved::Entries { entries, selected, remembered }
}

/// The record to write. `Err` when it would not read back: writing one would
/// make the next read refuse, and a refused read must never be replaced by a
/// list built from it.
pub fn record(entries: &[Entry], selected: Option<&str>, remembered: &[Remembered]) -> Result<String, String> {
    if entries.len() > ENTRY_LIMIT {
        return Err(format!("this app keeps up to {ENTRY_LIMIT} Workspaces"));
    }
    if remembered.len() > REMEMBERED_LIMIT {
        return Err(format!(
            "this app remembers the Workspace of up to {REMEMBERED_LIMIT} addresses it no longer lists. Nothing was changed. Forget an address it remembers to make room, which forgets only that record of which Workspace was there."
        ));
    }
    if let Some(both) = remembered.iter().find(|known| entries.iter().any(|entry| entry.url == known.url)) {
        return Err(format!(
            "“{}” would be both listed and remembered, and the two could disagree about which Workspace is there",
            both.url
        ));
    }
    if entries.iter().filter(|entry| entry.startable()).count() > 1 {
        return Err("only one Workspace may start a Core".into());
    }
    let listed: Vec<Value> = entries
        .iter()
        .map(|entry| {
            let mut value = serde_json::json!({ "id": entry.id, "name": entry.name, "url": entry.url.as_str() });
            if let Some(workspace) = &entry.workspace_id {
                value["workspaceId"] = serde_json::json!(workspace);
            }
            // Only a profile still at this entry's address is written. One
            // left over from an address this entry no longer has goes with
            // that address, rather than following it somewhere new.
            if entry.startable() {
                value["start"] = start_json(entry.start.as_ref().expect("startable has a start"));
            }
            value
        })
        .collect();
    let known: Vec<Value> = remembered
        .iter()
        .map(|known| serde_json::json!({ "url": known.url.as_str(), "workspaceId": known.workspace_id }))
        .collect();
    let text = serde_json::json!({
        "version": 1,
        "entries": listed,
        "selected": selected,
        "remembered": known,
    })
    .to_string();
    if text.len() > LIMIT {
        return Err("this record is larger than this app reads back".into());
    }
    // Written only if this would read it back whole. A record this app can
    // write but not read leaves it refusing every connection, rename and
    // removal until the file is deleted by hand, so the one rule that must
    // hold is checked by doing it, not by keeping a second copy of the
    // reader's checks in step with it.
    match read(text.as_bytes()) {
        Saved::Entries { .. } | Saved::Never => Ok(text),
        Saved::Unusable(reason) => Err(format!("this app could not read back what it was about to save ({reason})")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core(address: &str) -> Url {
        parse_core_url(address).unwrap()
    }

    fn start_for(address: &str, workspace: &str) -> StartProfile {
        StartProfile::new(&core(address), "Ubuntu-24.04", "yuzuki", "/home/yuzuki/yuzuno", workspace)
            .expect("a start profile")
    }

    fn entry(id: &str, name: &str, address: &str, workspace: Option<&str>, start: Option<StartProfile>) -> Entry {
        Entry {
            id: id.into(),
            name: name.into(),
            url: core(address),
            workspace_id: workspace.map(str::to_owned),
            start,
        }
    }

    fn saved(entries: &[Entry], selected: Option<&str>) -> Saved {
        read(record(entries, selected, &[]).unwrap().as_bytes())
    }

    fn known(address: &str, workspace: &str) -> Remembered {
        Remembered { url: core(address), workspace_id: workspace.into() }
    }

    #[test]
    fn nothing_saved_yet_is_a_first_launch() {
        assert_eq!(read(b"{}"), Saved::Unusable("it is not a saved Workspace record".into()));
        assert_eq!(read(br#"{"entries":[]}"#), Saved::Never);
    }

    #[test]
    fn entries_are_written_and_read_back_with_the_one_that_may_start() {
        let kept = vec![
            entry("core-1", "Home", "http://127.0.0.1:4317", Some("w-one"), Some(start_for("http://127.0.0.1:4317", "w-one"))),
            entry("core-2", "Studio", "https://two.example.ts.net", Some("w-two"), None),
        ];
        let Saved::Entries { entries, selected, .. } = saved(&kept, Some("core-2")) else { panic!() };
        assert_eq!(entries, kept);
        assert_eq!(selected, Some("core-2".into()));
        assert_eq!(saved(&kept, Some("core-2")).startable().map(|e| &*e.id), Some("core-1"));
    }

    #[test]
    fn the_one_address_record_becomes_the_entry_its_start_was_saved_for() {
        // What the desktop wrote before: coreUrl at the top, one start.
        let old = br#"{"coreUrl":"http://127.0.0.1:4317/","start":{"wslDistro":"Ubuntu-24.04","user":"yuzuki","installDir":"/home/yuzuki/yuzuno","workspaceId":"w-one","confirmed":true}}"#;
        let Saved::Entries { entries, selected, .. } = read(old) else { panic!("{:?}", read(old)) };
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "core");
        assert_eq!(entries[0].name, "127.0.0.1:4317");
        assert_eq!(selected, Some("core".into()));
        let start = entries[0].start.as_ref().expect("the old start is kept");
        assert_eq!(start.core, core("http://127.0.0.1:4317"));
        assert!(start.confirmed, "a confirmation already earned is kept");
        assert!(entries[0].startable());
        // The old record names no Workspace for the entry itself: unknown
        // until a Core answers, not borrowed from the start profile.
        assert_eq!(entries[0].workspace_id, None);
    }

    #[test]
    fn an_old_record_that_was_never_confirmed_is_not_promoted() {
        let old = br#"{"coreUrl":"http://127.0.0.1:4317/","start":{"wslDistro":"Ubuntu-24.04","user":"yuzuki","installDir":"/home/yuzuki/yuzuno","workspaceId":"w-one"}}"#;
        let Saved::Entries { entries, .. } = read(old) else { panic!() };
        let start = entries[0].start.as_ref().expect("kept");
        assert!(!start.confirmed, "no confirmed field is not confirmed, and is never written as one");
    }

    #[test]
    fn a_start_is_never_aimed_at_an_address_it_was_not_saved_for() {
        // The hazard the one-address record had: one start beside a list,
        // with the address swapped to whichever entry is selected.
        let written = format!(
            r#"{{"version":1,"selected":"core-1","entries":[{{"id":"core-1","name":"Other","url":"http://127.0.0.1:4318/","start":{}}}]}}"#,
            start_json(&start_for("http://127.0.0.1:4317", "w-one"))
        );
        let Saved::Entries { entries, .. } = read(written.as_bytes()) else { panic!() };
        assert_eq!(entries[0].start, None, "saved for :4317, so it is not this :4318 entry's");
        assert!(!entries[0].startable(), "and nothing here may be started");
    }

    #[test]
    fn a_retargeted_entry_does_not_carry_its_start_to_the_new_address() {
        let before = entry("core-1", "Home", "http://127.0.0.1:4317", Some("w-one"), Some(start_for("http://127.0.0.1:4317", "w-one")));
        assert!(before.startable());
        // The same entry, pointed somewhere else: the profile it had was for
        // the old address, so it is not written, and not offered.
        let after = Entry { url: core("http://127.0.0.1:4318"), ..before.clone() };
        assert!(!after.startable());
        let Saved::Entries { entries, .. } = saved(&[after], Some("core-1")) else { panic!() };
        assert_eq!(entries[0].start, None, "it stayed with the address it was saved for");
    }

    #[test]
    fn removing_the_entry_that_may_start_leaves_no_start_behind() {
        let kept = vec![
            entry("core-1", "Home", "http://127.0.0.1:4317", Some("w-one"), Some(start_for("http://127.0.0.1:4317", "w-one"))),
            entry("core-2", "Studio", "https://two.example.ts.net", Some("w-two"), None),
        ];
        let left: Vec<Entry> = kept.into_iter().filter(|entry| entry.id != "core-1").collect();
        let after = saved(&left, None);
        assert_eq!(after.startable(), None, "it went with the entry, not to the other one");
        assert_eq!(after.entries().len(), 1);
        assert_eq!(after.entries()[0].start, None);
    }

    #[test]
    fn renaming_keeps_the_start_where_it_is() {
        let renamed = entry("core-1", "A new name", "http://127.0.0.1:4317", Some("w-one"), Some(start_for("http://127.0.0.1:4317", "w-one")));
        let after = saved(&[renamed], Some("core-1"));
        assert_eq!(after.startable().map(|e| &*e.id), Some("core-1"), "a name is a label, not a binding");
    }

    #[test]
    fn two_workspaces_may_share_a_name_and_stay_apart() {
        let kept = vec![
            entry("core-1", "Home", "http://127.0.0.1:4317", Some("w-one"), None),
            entry("core-2", "Home", "http://127.0.0.1:4318", Some("w-two"), None),
        ];
        assert_eq!(saved(&kept, None).entries(), kept);
    }

    #[test]
    fn more_than_one_startable_workspace_is_refused_both_ways() {
        let two = vec![
            entry("core-1", "Home", "http://127.0.0.1:4317", None, Some(start_for("http://127.0.0.1:4317", "w-one"))),
            entry("core-2", "Studio", "http://127.0.0.1:4318", None, Some(start_for("http://127.0.0.1:4318", "w-two"))),
        ];
        assert_eq!(record(&two, None, &[]).unwrap_err(), "only one Workspace may start a Core");
        // And a record that already holds two is not guessed at.
        let written = format!(
            r#"{{"version":1,"entries":[{{"id":"a","name":"A","url":"http://127.0.0.1:4317/","start":{}}},{{"id":"b","name":"B","url":"http://127.0.0.1:4318/","start":{}}}]}}"#,
            start_json(&start_for("http://127.0.0.1:4317", "w-one")),
            start_json(&start_for("http://127.0.0.1:4318", "w-two"))
        );
        assert_eq!(
            read(written.as_bytes()),
            Saved::Unusable("more than one of its Workspaces is set to start a Core".into())
        );
    }

    #[test]
    fn a_record_that_could_not_be_read_is_usable_for_nothing() {
        assert_eq!(unusable(&Saved::Unusable("why".into())), Some("why"));
        assert_eq!(unusable(&Saved::Never), None, "a first launch has nothing to lose");
        assert_eq!(unusable(&saved(&[entry("core-1", "Home", "http://127.0.0.1:4317", None, None)], None)), None);
    }

    #[test]
    fn one_unusable_workspace_refuses_the_record_rather_than_dropping_it() {
        for bad in [
            r#"{"entries":[{"id":"core-1","url":"http://127.0.0.1:4317/"}]}"#,
            r#"{"entries":[{"id":"core-1","name":"Home","url":"ftp://nope/"}]}"#,
            r#"{"entries":[{"id":"a","name":"A","url":"http://127.0.0.1:4317/"},{"id":"a","name":"B","url":"http://127.0.0.1:4318/"}]}"#,
        ] {
            assert_eq!(
                read(bad.as_bytes()),
                Saved::Unusable("one of its Workspaces is not one this app opens".into()),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_bound_address_is_never_opened_on_an_answer_that_cannot_confirm_it() {
        // Bound here, and the Core names none: unverifiable, not "unknown so
        // go ahead". This is the case a laxer reading of the earlier fix got
        // wrong -- it turned a refusal into an opening.
        assert_eq!(opening(Some("w-one"), ""), Opening::Unverified);
        // Bound here, and it names another: changed.
        assert_eq!(opening(Some("w-one"), "w-two"), Opening::Changed);
        // Bound here, and it names the same: open, and keep it.
        assert_eq!(opening(Some("w-one"), "w-one"), Opening::Open(Some("w-one".into())));
        // Nothing bound: an older Core that names none still opens, and
        // nothing is recorded for it.
        assert_eq!(opening(None, ""), Opening::Open(None));
        assert_eq!(opening(None, "w-one"), Opening::Open(Some("w-one".into())));
        // Longer than this keeps: refused either way, bound or not. Keeping
        // it would make the list unreadable; calling it absent would open an
        // address whose answer cannot be checked.
        let long = "w".repeat(WORKSPACE_LIMIT + 1);
        assert_eq!(opening(Some("w-one"), &long), Opening::Unkeepable);
        assert_eq!(opening(None, &long), Opening::Unkeepable);
    }

    #[test]
    fn nothing_is_written_that_could_not_be_read_back() {
        // The failure this guards: an entry written with a workspaceId the
        // reader rejects makes the whole record unusable, and a record that
        // cannot be read refuses every connection, rename and removal. This
        // is the write side, and `opening` does not stand in for it: that
        // decides whether to open at all, while this decides what may be
        // put on disk once something is being saved.
        for bad in ["", &"w".repeat(WORKSPACE_LIMIT + 1)] {
            let entries = vec![entry("core-1", "Home", "http://127.0.0.1:4317", Some(bad), None)];
            let refused = record(&entries, Some("core-1"), &[]).unwrap_err();
            assert!(refused.contains("could not read back"), "{refused}");
        }
        // A name beyond what the reader takes is refused the same way.
        let long = vec![entry("core-1", &"n".repeat(NAME_LIMIT + 1), "http://127.0.0.1:4317", None, None)];
        assert!(record(&long, None, &[]).unwrap_err().contains("could not read back"));
        // And what it does accept still writes.
        let fine = vec![entry("core-1", "Home", "http://127.0.0.1:4317", Some("w-one"), None)];
        assert!(record(&fine, Some("core-1"), &[]).is_ok());
    }

    #[test]
    fn removing_an_entry_leaves_its_address_remembered() {
        // The failure this exists for: the entry went, its workspaceId went
        // with it, and the address was bound to nothing -- while what the web
        // view stored for it stayed. Any Core answering there was then opened
        // onto the previous Workspace's drafts.
        let before = saved(&[entry("core-1", "Home", "http://127.0.0.1:4317", Some("w-one"), None)], Some("core-1"));
        let after = remembering(&before, &[]);
        assert_eq!(after, vec![known("http://127.0.0.1:4317", "w-one")]);
        // And the address still answers as bound, with no entry listed.
        let saved = read(record(&[], None, &after).unwrap().as_bytes());
        assert_eq!(saved.entries(), &[]);
        assert_eq!(saved.workspace_for(&core("http://127.0.0.1:4317")), Some("w-one"));
        // A remembered address is not a first launch: saying Never here would
        // offer to save the first Workspace that answers.
        assert!(!matches!(saved, Saved::Never));
    }

    #[test]
    fn a_removed_entry_is_no_way_around_the_refusal() {
        // Remove, then connect a different Workspace at the same address.
        // Without the remembered binding this opened and was recorded.
        let before = saved(&[entry("core-1", "Home", "http://127.0.0.1:4317", Some("w-one"), None)], Some("core-1"));
        let after = read(record(&[], None, &remembering(&before, &[])).unwrap().as_bytes());
        let address = core("http://127.0.0.1:4317");
        assert_eq!(opening(after.workspace_for(&address), "w-two"), Opening::Changed);
        // The one that was there still opens, and an answer that cannot be
        // checked is still refused rather than letting it through.
        assert_eq!(opening(after.workspace_for(&address), "w-one"), Opening::Open(Some("w-one".into())));
        assert_eq!(opening(after.workspace_for(&address), ""), Opening::Unverified);
        // An address nothing was ever known about is unaffected.
        assert_eq!(opening(after.workspace_for(&core("http://127.0.0.1:4318")), "w-two"), Opening::Open(Some("w-two".into())));
    }

    #[test]
    fn an_address_nobody_named_leaves_nothing_remembered() {
        // No Core there ever said which Workspace it was, so there is nothing
        // to protect and nothing is claimed about the address.
        let before = saved(&[entry("core-1", "Home", "http://127.0.0.1:4317", None, None)], Some("core-1"));
        assert_eq!(remembering(&before, &[]), vec![]);
    }

    #[test]
    fn an_address_is_listed_or_remembered_and_never_both() {
        let entries = vec![entry("core-1", "Home", "http://127.0.0.1:4317", Some("w-one"), None)];
        let same = vec![known("http://127.0.0.1:4317", "w-two")];
        // Writing both is refused: the two could disagree about which
        // Workspace is there, and nothing may choose between them.
        assert!(record(&entries, Some("core-1"), &same).unwrap_err().contains("both listed and remembered"));
        // Reading such a record refuses it rather than preferring one.
        let both = br#"{"version":1,"entries":[{"id":"core-1","name":"Home","url":"http://127.0.0.1:4317/","workspaceId":"w-one"}],"selected":"core-1","remembered":[{"url":"http://127.0.0.1:4317/","workspaceId":"w-two"}]}"#;
        assert_eq!(
            read(both),
            Saved::Unusable("it remembers a Workspace for an address it also lists".into())
        );
        // An entry taking a remembered address takes the record with it.
        let before = read(record(&[], None, &same).unwrap().as_bytes());
        assert_eq!(remembering(&before, &entries), vec![]);
    }

    #[test]
    fn forgetting_an_address_forgets_only_that_one() {
        let two = vec![known("http://127.0.0.1:4317", "w-one"), known("http://127.0.0.1:4318", "w-two")];
        let left = forgetting(&two, &core("http://127.0.0.1:4317")).expect("it was remembered");
        assert_eq!(left, vec![known("http://127.0.0.1:4318", "w-two")]);
        // An address this does not remember is not a silent success: the
        // caller says so rather than reporting a change it did not make.
        assert_eq!(forgetting(&two, &core("http://127.0.0.1:4319")), None);
        // Afterwards the address is unknown again -- which is the whole
        // effect. Nothing stored for it was reached by this.
        let saved = read(record(&[], None, &left).unwrap().as_bytes());
        assert_eq!(saved.workspace_for(&core("http://127.0.0.1:4317")), None);
    }

    #[test]
    fn remembering_more_addresses_than_this_keeps_changes_nothing() {
        let full: Vec<Remembered> = (0..REMEMBERED_LIMIT)
            .map(|n| known(&format!("http://127.0.0.1:{}", 4000 + n), &format!("w-{n}")))
            .collect();
        assert!(record(&[], None, &full).is_ok(), "the limit itself fits");
        let mut over = full.clone();
        over.push(known("http://127.0.0.1:9999", "w-over"));
        let refused = record(&[], None, &over).unwrap_err();
        assert!(refused.contains(&REMEMBERED_LIMIT.to_string()), "{refused}");
        // Refused, not evicted: dropping the oldest would hand back an
        // address whose stored data it was keeping apart.
        assert!(refused.contains("Nothing was changed"), "{refused}");
        assert!(refused.contains("forgets only that record"), "{refused}");
        // An address already remembered is updated in place and takes no
        // further room, even at the limit.
        let mut again = full.clone();
        again[0] = known("http://127.0.0.1:4000", "w-moved");
        assert_eq!(again.len(), REMEMBERED_LIMIT);
        assert!(record(&[], None, &again).is_ok());
    }

    #[test]
    fn one_address_this_cannot_use_refuses_the_remembered_list_rather_than_dropping_it() {
        for bad in [
            r#"{"version":1,"entries":[],"remembered":[{"url":"ftp://nope/","workspaceId":"w-one"}]}"#,
            r#"{"version":1,"entries":[],"remembered":[{"url":"http://127.0.0.1:4317/"}]}"#,
            r#"{"version":1,"entries":[],"remembered":[{"url":"http://127.0.0.1:4317/","workspaceId":""}]}"#,
        ] {
            assert!(matches!(read(bad.as_bytes()), Saved::Unusable(_)), "{bad}");
        }
        // The same address twice could disagree with itself.
        let twice = br#"{"version":1,"entries":[],"remembered":[{"url":"http://127.0.0.1:4317/","workspaceId":"w-one"},{"url":"http://127.0.0.1:4317/","workspaceId":"w-two"}]}"#;
        assert_eq!(read(twice), Saved::Unusable("it remembers one address twice".into()));
    }

    #[test]
    fn a_workspace_nobody_named_is_called_after_its_address_and_port() {
        assert_eq!(name_for(&core("http://127.0.0.1:4317")), "127.0.0.1:4317");
        assert_eq!(name_for(&core("http://127.0.0.1:4318")), "127.0.0.1:4318", "the port tells two local Cores apart");
    }

    #[test]
    fn the_largest_record_these_bounds_allow_still_reads_back() {
        let full: Vec<Entry> = (0..ENTRY_LIMIT)
            .map(|n| {
                entry(
                    &format!("core-{n}"),
                    &"n".repeat(NAME_LIMIT),
                    &format!("https://{}{n}.example.ts.net", "a".repeat(60)),
                    Some(&"w".repeat(WORKSPACE_LIMIT)),
                    None,
                )
            })
            .collect();
        let text = record(&full, Some("core-0"), &[]).expect("within what read accepts");
        assert!(text.len() <= LIMIT);
        assert_eq!(read(text.as_bytes()), Saved::Entries { entries: full, selected: Some("core-0".into()), remembered: Vec::new() });
    }
}
