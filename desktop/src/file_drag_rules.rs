//! What a drag of a kept file out of the desktop window may fetch, and what
//! its copy is called (YN-170), with no dependencies, so CI checks it without
//! building a desktop app (as `badge_rules.rs`). `file_drag.rs` fetches the
//! file from the selected Core and hands the copy to the system's drag.
//!
//! The page names a file, never an address or a path: its kind, its ids and
//! its name. Each part is checked by the rule Core itself serves it by, and
//! the path asked of Core is built here, every part percent-encoded as one
//! path segment, so only Core's three download routes can be reached.

/// Core keeps no Brief snapshot over 25 MiB (`SNAPSHOT_FILE_BYTES`,
/// core/src/project_brief/mod.rs), so none is served larger.
pub const SNAPSHOT_BYTES: u64 = 25 * 1024 * 1024;

/// A message carries at most 40 MiB of files (`MAX_TOTAL`,
/// core/src/input_files.rs), so no file of one is larger.
pub const FILE_BYTES: u64 = 40 * 1024 * 1024;

/// Copies older than this are removed: when the app starts and before each
/// drag. A copy that was dropped stays this long because the app it went to
/// may read it some time after the drop (an upload, a mail being written).
/// The same age `local_core/stage.sh` removes its temporary folders at.
pub const STALE_SECS: u64 = 60 * 60;

/// The longest path most Windows apps open: MAX_PATH less its closing NUL
/// (Microsoft, "Maximum Path Length Limitation").
pub const WINDOWS_PATH_UNITS: usize = 259;

/// The largest whole number the page can send exactly (JavaScript's
/// `Number.MAX_SAFE_INTEGER`).
const MAX_VERSION: u64 = (1 << 53) - 1;

// Core's file name limits (core/src/input_files.rs, `fit`).
const MAX_NAME_UNITS: usize = 200;
const MAX_NAME_BYTES: usize = 240;
const MAX_EXTENSION: usize = 16;

/// A file the page asks to drag out, as Core names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum File<'a> {
    /// A kept attachment of a Brief section version (Home and report cards).
    BriefAttachment { project: &'a str, section: &'a str, name: &'a str, version: u64 },
    /// A file a message to an Agent carried (a conversation).
    AgentFile { agent: &'a str, id: &'a str, name: &'a str },
    /// A file a Home reply or talk carried, kept on its Project.
    ProjectFile { project: &'a str, id: &'a str, name: &'a str },
}

/// What to ask of the selected Core for a file: a path to join to its
/// origin, the most it may answer, and the file's own name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fetch {
    pub path: String,
    pub limit: u64,
    pub name: String,
}

/// The fetch for `file`, or why it is not one Core serves.
pub fn fetch(file: &File) -> Result<Fetch, String> {
    match *file {
        File::BriefAttachment { project, section, name, version } => {
            owner(project, "a project")?;
            if !section_key(section) {
                return Err("That is not a section of this workspace.".into());
            }
            if !attachment_name(name) {
                return Err("That is not the name of a kept attachment.".into());
            }
            if !(1..=MAX_VERSION).contains(&version) {
                return Err("That is not a version of this section.".into());
            }
            Ok(Fetch {
                path: format!(
                    "api/projects/{}/brief/attachments/{}/{}?version={version}",
                    segment(project),
                    segment(section),
                    segment(name)
                ),
                limit: SNAPSHOT_BYTES,
                name: name.to_owned(),
            })
        }
        File::AgentFile { agent, id, name } => {
            owner(agent, "an Agent")?;
            sent_file(id, name)?;
            Ok(Fetch {
                path: format!("api/agents/{}/files/{}/{}", segment(agent), id, segment(name)),
                limit: FILE_BYTES,
                name: name.to_owned(),
            })
        }
        File::ProjectFile { project, id, name } => {
            owner(project, "a project")?;
            sent_file(id, name)?;
            Ok(Fetch {
                path: format!("api/projects/{}/files/{}/{}", segment(project), id, segment(name)),
                limit: FILE_BYTES,
                name: name.to_owned(),
            })
        }
    }
}

/// A Project's or Agent's id: Core makes them UUIDs; anything of letters,
/// digits, `-` and `_` up to 128 is accepted, nothing that could leave its
/// path segment.
fn owner(id: &str, what: &str) -> Result<(), String> {
    if (1..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        Ok(())
    } else {
        Err(format!("That is not {what} of this workspace."))
    }
}

/// A sent file: Core's content id and a name Core gave it
/// (core/src/input_files.rs, `file_path`).
fn sent_file(id: &str, name: &str) -> Result<(), String> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("That is not a file of this workspace.".into());
    }
    if !file_name(name) {
        return Err("That is not the name of a sent file.".into());
    }
    Ok(())
}

/// A section key, as Core checks one (core/src/project_brief/update.rs,
/// `valid_key`): one or two parts of `a-z0-9-`, each starting with a letter
/// or digit and at most 48 long.
pub fn section_key(key: &str) -> bool {
    let parts: Vec<&str> = key.split('/').collect();
    parts.len() <= 2
        && parts.iter().all(|part| {
            let bytes = part.as_bytes();
            !bytes.is_empty()
                && bytes.len() <= 48
                && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
                && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        })
}

/// An attachment name, as Core checks one (core/src/project_brief/update.rs,
/// `valid_attachment_name`): 1–80 of `A-Za-z0-9_.-`, never `.` or `..`.
pub fn attachment_name(name: &str) -> bool {
    (1..=80).contains(&name.len())
        && name != "."
        && name != ".."
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// A sent file's name: one Core's `safe_name` leaves as it is, which is
/// how Core serves it (`file_path`).
pub fn file_name(name: &str) -> bool {
    !name.is_empty() && safe_name(name) == name
}

/// Core's `safe_name` (core/src/input_files.rs): the last part of a path,
/// without control characters or `\/:*?"<>|` and backquote, trailing spaces
/// and dots, a leading `.` or `-`, and within the name limits.
fn safe_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let replaced: String = last
        .chars()
        .map(|c| if c.is_control() || "\\/:*?\"<>|`".contains(c) { '_' } else { c })
        .collect();
    let mut name = replaced.trim_end_matches([' ', '.']).to_owned();
    if name.is_empty() {
        return "file".into();
    }
    if name.starts_with(['.', '-']) {
        name.insert(0, '_');
    }
    let fitted = fit(&name, MAX_NAME_UNITS, MAX_NAME_BYTES);
    match fitted.trim_end_matches([' ', '.']) {
        "" => "file".into(),
        kept => kept.into(),
    }
}

/// `name` within `units` UTF-16 units and `bytes` bytes: the part before its
/// extension is cut, as Core's `fit` cuts it.
fn fit(name: &str, units: usize, bytes: usize) -> String {
    let count = |s: &str| s.encode_utf16().count();
    if count(name) <= units && name.len() <= bytes {
        return name.into();
    }
    let extension = name
        .rfind('.')
        .filter(|&at| at > 0 && name[at + 1..].chars().count() <= MAX_EXTENSION)
        .map_or("", |at| &name[at..]);
    let (mut units_left, mut bytes_left) = (
        units.saturating_sub(count(extension)),
        bytes.saturating_sub(extension.len()),
    );
    let mut kept = String::new();
    for c in name[..name.len() - extension.len()].chars() {
        if c.len_utf16() > units_left || c.len_utf8() > bytes_left {
            break;
        }
        units_left -= c.len_utf16();
        bytes_left -= c.len_utf8();
        kept.push(c);
    }
    kept + extension
}

/// One path segment: every byte but the unreserved ones (RFC 3986:
/// letters, digits, `-._~`) percent-encoded, so no `/`, `?`, `#` or `%`
/// of a part is read as more than that part.
pub fn segment(part: &str) -> String {
    let mut encoded = String::with_capacity(part.len());
    for byte in part.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// What the copy is called on disk: Core's own name. On Windows a name
/// Windows keeps for a device (CON, PRN, AUX, NUL, COM0–9, LPT0–9, COM¹–³,
/// LPT¹–³, CONIN$, CONOUT$; in any case, with any extension; Microsoft,
/// "Naming Files, Paths, and Namespaces") gets a leading `_`, and a name
/// that would make the path longer than `WINDOWS_PATH_UNITS` is cut before
/// its extension, as Core cuts a long name. `folder_units` is the length of
/// the folder it goes in, in UTF-16 units.
pub fn disk_name(name: &str, windows: bool, folder_units: usize) -> String {
    if !windows {
        return name.to_owned();
    }
    let stem = name.split('.').next().unwrap_or_default().trim_end_matches(' ');
    let device = {
        let upper = stem.to_ascii_uppercase();
        matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
            || ((upper.starts_with("COM") || upper.starts_with("LPT"))
                && upper.len() == 4
                && matches!(upper.as_bytes()[3], b'0'..=b'9'))
            || ((upper.starts_with("COM") || upper.starts_with("LPT"))
                && matches!(&upper[3..], "¹" | "²" | "³"))
    };
    let named = if device { format!("_{name}") } else { name.to_owned() };
    // The folder, its separator and the name.
    let room = WINDOWS_PATH_UNITS.saturating_sub(folder_units + 1);
    let cut = fit(&named, room.max(1), usize::MAX);
    if cut.is_empty() || cut.starts_with('.') {
        // No room for even a letter before the extension: the whole name, a
        // longer path than some apps open, rather than none at all.
        named
    } else {
        cut
    }
}

/// A folder of one drag's copy: 16 lowercase hexadecimal digits, the only
/// folders this app ever removes from its copies' folder.
pub fn copy_folder(name: &str) -> bool {
    name.len() == 16 && name.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The name of a new copy folder, from 64 bits nobody chose.
pub fn copy_folder_name(bits: u64) -> String {
    format!("{bits:016x}")
}

/// Where a copy came from, as a browser marks a download on Windows (the
/// `Zone.Identifier` stream, "Mark of the Web"): the Internet zone, so a
/// program or page an Agent made is opened from the copy with the same
/// warning as one downloaded in a browser.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn zone_identifier(host_url: &str) -> String {
    let url: String = host_url.chars().filter(|c| !c.is_control()).collect();
    format!("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={url}\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const PROJECT: &str = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

    #[test]
    fn each_kind_reaches_only_its_own_download_route() {
        let brief = fetch(&File::BriefAttachment { project: PROJECT, section: "round-12/review", name: "loss.csv", version: 7 }).unwrap();
        assert_eq!(brief.path, format!("api/projects/{PROJECT}/brief/attachments/round-12%2Freview/loss.csv?version=7"));
        assert_eq!(brief.limit, 25 * 1024 * 1024);
        assert_eq!(brief.name, "loss.csv");

        let agent = fetch(&File::AgentFile { agent: "a-1", id: ID, name: "季度 report #1.html" }).unwrap();
        assert_eq!(agent.path, format!("api/agents/a-1/files/{ID}/%E5%AD%A3%E5%BA%A6%20report%20%231.html"));
        assert_eq!(agent.limit, 40 * 1024 * 1024);
        assert_eq!(agent.name, "季度 report #1.html");

        let project = fetch(&File::ProjectFile { project: PROJECT, id: ID, name: "report.pdf" }).unwrap();
        assert_eq!(project.path, format!("api/projects/{PROJECT}/files/{ID}/report.pdf"));
        assert_eq!(project.limit, 40 * 1024 * 1024);
    }

    #[test]
    fn ids_that_could_leave_their_segment_are_refused() {
        for bad in ["", "..", "a/b", "a%2Fb", "a?b", "a#b", "a b", "a\\b", "ä", "x".repeat(129).as_str()] {
            assert!(fetch(&File::AgentFile { agent: bad, id: ID, name: "a.txt" }).is_err(), "{bad:?}");
            assert!(fetch(&File::ProjectFile { project: bad, id: ID, name: "a.txt" }).is_err(), "{bad:?}");
            assert!(
                fetch(&File::BriefAttachment { project: bad, section: "s", name: "a.txt", version: 1 }).is_err(),
                "{bad:?}"
            );
        }
        assert!(fetch(&File::AgentFile { agent: &"x".repeat(128), id: ID, name: "a.txt" }).is_ok());
    }

    #[test]
    fn a_file_needs_cores_own_content_id() {
        for bad in ["", "..", &ID[..63], format!("{ID}0").as_str(), ID.to_uppercase().as_str(), format!("{}g", &ID[..63]).as_str(), format!("../{}", &ID[3..]).as_str()] {
            assert!(fetch(&File::AgentFile { agent: "a", id: bad, name: "a.txt" }).is_err(), "{bad:?}");
            assert!(fetch(&File::ProjectFile { project: "p", id: bad, name: "a.txt" }).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_section_is_a_key_core_would_take() {
        for good in ["plan", "design/yn170-native-drag", "a", "a".repeat(48).as_str(), "0-topic/1"] {
            assert!(section_key(good), "{good:?}");
        }
        for bad in ["", "/", "a/", "/a", "a/b/c", "A", "-a", "a/-b", "a_b", "a.b", "..", "a/..", "a".repeat(49).as_str(), "a%2Fb", "a b"] {
            assert!(!section_key(bad), "{bad:?}");
            assert!(fetch(&File::BriefAttachment { project: "p", section: bad, name: "a.txt", version: 1 }).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn an_attachment_name_is_one_core_would_take() {
        for good in ["a", "loss.csv", "handoff_notes_v3.md", ".env", "-x", "a..b", "n".repeat(80).as_str()] {
            assert!(attachment_name(good), "{good:?}");
        }
        for bad in ["", ".", "..", "a/b", "a\\b", "a:b", "a b", "季度.csv", "a%2Fb", "a?b", "n".repeat(81).as_str()] {
            assert!(!attachment_name(bad), "{bad:?}");
            assert!(fetch(&File::BriefAttachment { project: "p", section: "s", name: bad, version: 1 }).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_sent_file_name_is_one_core_would_have_given() {
        for good in ["a.txt", "季度 report #1.html", "_.env", "notes (2).md", "a%2Fb.txt", "x"] {
            assert!(file_name(good), "{good:?}");
        }
        for bad in [
            "", ".", "..", ".env", "-rf", "a/b.txt", "..\\x", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a`b",
            "a\u{7}b", "a\nb", "trailing.", "trailing ", "file\u{0}",
        ] {
            assert!(!file_name(bad), "{bad:?}");
            assert!(fetch(&File::AgentFile { agent: "a", id: ID, name: bad }).is_err(), "{bad:?}");
        }
        // Longer than Core keeps: Core would have cut it.
        assert!(!file_name(&format!("{}.txt", "n".repeat(200))));
        assert!(file_name(&format!("{}.txt", "n".repeat(196))));
    }

    #[test]
    fn a_version_is_a_whole_number_the_page_can_send() {
        assert!(fetch(&File::BriefAttachment { project: "p", section: "s", name: "a", version: 0 }).is_err());
        assert!(fetch(&File::BriefAttachment { project: "p", section: "s", name: "a", version: MAX_VERSION }).is_ok());
        assert!(fetch(&File::BriefAttachment { project: "p", section: "s", name: "a", version: MAX_VERSION + 1 }).is_err());
    }

    #[test]
    fn a_segment_keeps_only_unreserved_bytes() {
        assert_eq!(segment("Az09-._~"), "Az09-._~");
        assert_eq!(segment("a/b?c#d%e f"), "a%2Fb%3Fc%23d%25e%20f");
        assert_eq!(segment("é"), "%C3%A9");
        assert_eq!(segment(".."), "..");
    }

    #[test]
    fn a_windows_device_name_gets_an_underscore() {
        let short = 40;
        for device in ["CON", "con.txt", "Nul.tar.gz", "AUX", "prn.md", "COM1.log", "lpt9", "CONIN$", "conout$.txt", "COM¹.txt", "CON .txt", "com0.txt", "LPT0"] {
            assert_eq!(disk_name(device, true, short), format!("_{device}"), "{device:?}");
        }
        for plain in ["CONSOLE.txt", "COMX.txt", "COM10.txt", "LPT.txt", "context.md", "nul_report.csv", "a.CON"] {
            assert_eq!(disk_name(plain, true, short), plain, "{plain:?}");
        }
        // Elsewhere the name is Core's, as it is.
        assert_eq!(disk_name("CON.txt", false, short), "CON.txt");
    }

    #[test]
    fn a_long_windows_path_is_cut_before_the_extension() {
        let folder = 80;
        let long = format!("{}.xlsx", "报".repeat(196));
        let cut = disk_name(&long, true, folder);
        assert!(cut.ends_with(".xlsx"), "{cut}");
        assert_eq!(folder + 1 + cut.encode_utf16().count(), WINDOWS_PATH_UNITS);
        // A name that fits is kept whole; on macOS a name is never cut.
        assert_eq!(disk_name("report.pdf", true, folder), "report.pdf");
        assert_eq!(disk_name(&long, false, folder), long);
        // No room left at all: the whole name rather than none.
        assert_eq!(disk_name("report.pdf", true, 400), "report.pdf");
    }

    #[test]
    fn only_a_copy_folder_is_ever_removed() {
        assert!(copy_folder(&copy_folder_name(0)));
        assert!(copy_folder(&copy_folder_name(u64::MAX)));
        assert_eq!(copy_folder_name(0xabc), "0000000000000abc");
        for other in ["", "0123456789abcde", "0123456789abcdef0", "0123456789ABCDEF", "0123456789abcdeg", "..", "EBWebView", "core.json"] {
            assert!(!copy_folder(other), "{other:?}");
        }
    }

    #[test]
    fn a_copy_is_marked_as_downloaded_from_the_internet() {
        assert_eq!(
            zone_identifier("http://127.0.0.1:4317/api/agents/a/files/x/a.txt"),
            "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=http://127.0.0.1:4317/api/agents/a/files/x/a.txt\r\n"
        );
        // No line of the address can add another.
        assert!(!zone_identifier("http://x/\r\nZoneId=0").contains("\nZoneId=0"));
    }
}
