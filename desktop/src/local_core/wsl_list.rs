//! Reads what `wsl.exe --list --verbose` printed (YN-107, design 4.2), with
//! no dependencies, so CI checks it without building the desktop app (as
//! `health.rs`). `wsl.rs` runs `wsl.exe` on Windows; this only reads bytes.
//!
//! What it prints (Job 513edea3, WSL 2.7.11): a header line, then one line
//! per distribution, with `*` before the default one. With `WSL_UTF8=1` that
//! is UTF-8 with CRLF; without it, or from a WSL too old to know that
//! variable, UTF-16LE without a byte order mark. The header and the state
//! column are translated, and a translated state can be several words; a
//! distribution's name has no spaces. So only each line's first field (the
//! name) and its last (the version) are read.

/// One distribution in the list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Distro {
    pub name: String,
    /// Its WSL version: 1 or 2.
    pub version: u32,
    pub is_default: bool,
}

/// The text `wsl.exe` printed: UTF-16LE when a byte at an odd offset is 0
/// (UTF-8 text never has a 0 byte; Rancher Desktop reads it the same way),
/// UTF-8 otherwise. Invalid sequences become U+FFFD; a byte order mark at
/// the start is dropped.
pub fn decode(bytes: &[u8]) -> String {
    let text = if bytes.iter().skip(1).step_by(2).any(|&byte| byte == 0) {
        let units = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]]));
        char::decode_utf16(units)
            .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_owned(),
        None => text,
    }
}

/// The distributions in `text`, in its order. The first line that is not
/// blank is the header. A line counts only if, after its first two
/// characters (the default mark and a space), it has a name and then, as its
/// last field, a version number; anything else WSL may print is skipped.
pub fn parse(text: &str) -> Vec<Distro> {
    let mut lines = text.lines().map(|line| line.trim_end_matches('\r')).filter(|line| !line.trim().is_empty());
    // The header, in the user's language.
    lines.next();
    lines
        .filter_map(|line| {
            let is_default = line.starts_with('*');
            let rest: String = line.chars().skip(2).collect();
            let mut fields = rest.split_whitespace();
            let name = fields.next()?;
            let version = fields.next_back()?;
            if !version.bytes().all(|byte| byte.is_ascii_digit()) || version.len() > 3 {
                return None;
            }
            Some(Distro { name: name.to_owned(), version: version.parse().ok()?, is_default })
        })
        .collect()
}

/// WSL's own first line, to show when it lists nothing or fails: without a
/// syslog level such as `<3>` before it (as `connection::start_result`
/// shows one) and without a trailing period, at most 240 characters.
pub fn first_line(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    let line = line
        .strip_prefix('<')
        .and_then(|rest| rest.split_once('>'))
        .filter(|(level, _)| !level.is_empty() && level.bytes().all(|byte| byte.is_ascii_digit()))
        .map_or(line, |(_, rest)| rest.trim());
    let line = line.trim_end_matches('.');
    if line.is_empty() {
        return None;
    }
    Some(line.chars().take(240).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    // What `wsl.exe --list --verbose` printed in Job 513edea3 (machine
    // windows, WSL 2.7.11, read-only), byte for byte: with WSL_UTF8=1
    // (117 bytes, sha256 d0b32964cc55526b324afa650cc945c4f479f02ea474107a3cc50e9709b9dee2)
    // and without it (234 bytes, sha256 ccf7ad873c67673ff500a5a2f714d5b9afa68199843189e6c08ea7b3fd00ad69).
    const LIST_UTF8: &[u8] = b"  NAME            STATE           VERSION\r\n* archlinux       Running         2\r\n  Ubuntu-24.04    Stopped         2\r\n";
    const LIST_UTF16LE: [&[u8]; 3] = [
        b" \0 \0N\0A\0M\0E\0 \0 \0 \0 \0 \0 \0 \0 \0 \0 \0 \0 \0S\0T\0A\0T\0E\0 \0 \0 \0 \0 \0 \0 \0 \0 \0 \0 \0V\0E\0R\0S\0I\0O\0N\0\r\0\n\0",
        b"*\0 \0a\0r\0c\0h\0l\0i\0n\0u\0x\0 \0 \0 \0 \0 \0 \0 \0R\0u\0n\0n\0i\0n\0g\0 \0 \0 \0 \0 \0 \0 \0 \0 \02\0\r\0\n\0",
        b" \0 \0U\0b\0u\0n\0t\0u\0-\02\04\0.\00\04\0 \0 \0 \0 \0S\0t\0o\0p\0p\0e\0d\0 \0 \0 \0 \0 \0 \0 \0 \0 \02\0\r\0\n\0",
    ];

    fn distro(name: &str, version: u32, is_default: bool) -> Distro {
        Distro { name: name.into(), version, is_default }
    }

    #[test]
    fn reads_the_real_utf8_list() {
        assert_eq!(LIST_UTF8.len(), 117);
        assert_eq!(
            parse(&decode(LIST_UTF8)),
            [distro("archlinux", 2, true), distro("Ubuntu-24.04", 2, false)]
        );
    }

    #[test]
    fn reads_the_real_utf16le_list_as_the_same_text() {
        let bytes = LIST_UTF16LE.concat();
        assert_eq!(bytes.len(), 234);
        assert_eq!(decode(&bytes), decode(LIST_UTF8));
        assert_eq!(
            parse(&decode(&bytes)),
            [distro("archlinux", 2, true), distro("Ubuntu-24.04", 2, false)]
        );
    }

    #[test]
    fn drops_a_byte_order_mark_and_an_odd_last_byte() {
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend(LIST_UTF16LE.concat());
        bytes.push(b'x');
        assert_eq!(decode(&bytes), decode(LIST_UTF8));
        assert_eq!(decode(b"\xef\xbb\xbfA"), "A");
    }

    #[test]
    fn reads_only_the_name_and_the_version() {
        // A translated header and a state of several words; WSL 1; no default.
        let text = "  NOM          ÉTAT                 VERSION\n  main-distro  En cours d'exécution  2\n  old.distro   Arrêté               1\n";
        assert_eq!(parse(text), [distro("main-distro", 2, false), distro("old.distro", 1, false)]);
    }

    #[test]
    fn skips_blank_lines_and_anything_without_a_version() {
        let text = "\r\n  NAME   STATE   VERSION\r\n\r\n* main-distro   Running   2\r\nsomething else WSL said\r\n  lonely\r\n  x  Running  12345\r\n";
        assert_eq!(parse(text), [distro("main-distro", 2, true)]);
        assert_eq!(parse(""), []);
        assert_eq!(parse("  NAME   STATE   VERSION\r\n"), []);
    }

    #[test]
    fn says_what_wsl_said_first() {
        assert_eq!(
            first_line("\r\n<3>WSL (12) ERROR: no distribution.\r\nmore").as_deref(),
            Some("WSL (12) ERROR: no distribution")
        );
        assert_eq!(first_line("Windows Subsystem for Linux has no installed distributions.\r\n").as_deref(), Some("Windows Subsystem for Linux has no installed distributions"));
        assert_eq!(first_line(" \r\n"), None);
        assert_eq!(first_line(&"x".repeat(500)).map(|line| line.len()), Some(240));
    }
}
