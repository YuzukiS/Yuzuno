//! The files an OpenCode 2.2.5 patch names (YN-78 S4a; design v4 2.3.2
//! rule 3): a port of `Patch.parse` (packages/util/src/patch.ts, blob
//! cef1c313, in the fixed sources' PATCH-SUPPLEMENT.json) that keeps only
//! each hunk's paths.
//!
//! It follows the native parser step by step, so a line it reads as a
//! hunk's body (an indented `*** Update File:` in an update, say) names no
//! file, as natively: the heredoc wrapper, JavaScript's `trim` and its
//! white space, one `\r` per line, the Begin and End markers, a first
//! `*** Environment ID:` line, and each Add, Delete and Update hunk with an
//! update's `*** End of File` lines before its `*** Move to:`, and every
//! body rule that makes the native parser fail. A patch it can't parse is
//! None, and the caller refuses it: OpenCode then asks nothing either.
//!
//! The patch tool asks for each file's folder in this order (Add, Delete and
//! Update paths, and an Update's Move destination after it has derived the
//! update), each as `<folder>/*`; Core judges every one of them for each
//! request.

/// JavaScript's white space and line terminators (ECMA-262 `WhiteSpace`,
/// `LineTerminator`): what its `trim` and a regular expression's `\s` take.
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
        | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

fn trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

fn trim_end(text: &str) -> &str {
    text.trim_end_matches(js_space)
}

/// One hunk's files: its path, and an Update's Move destination.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Hunk {
    pub path: String,
    pub moved: Option<String>,
}

/// Every hunk of `patch` in order, as `Patch.parse` reads it; None when it
/// would fail.
pub(super) fn hunks(patch: &str) -> Option<Vec<Hunk>> {
    let text = strip_heredoc(trim(patch));
    let lines: Vec<&str> = text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
    if trim(lines[0]) != "*** Begin Patch" {
        return None;
    }
    let end = lines.len() - 1;
    if trim(lines[end]) != "*** End Patch" || end == 0 {
        return None;
    }
    let mut hunks = Vec::new();
    let mut index = 1;
    while index < end {
        let header = trim(lines[index]);
        if index == 1 && header.strip_prefix("*** Environment ID:").is_some_and(|rest| !trim(rest).is_empty()) {
            index += 1;
            continue;
        }
        if let Some(path) = header.strip_prefix("*** Add File: ") {
            // Each body line until the next boundary starts with `+`.
            index += 1;
            while index < end && !is_boundary(trim(lines[index])) {
                if !lines[index].starts_with('+') {
                    return None;
                }
                index += 1;
            }
            hunks.push(Hunk { path: trim(path).to_owned(), moved: None });
            continue;
        }
        if let Some(path) = header.strip_prefix("*** Delete File: ") {
            // No body: the next line is a boundary.
            if index + 1 < end && !is_boundary(trim(lines[index + 1])) {
                return None;
            }
            hunks.push(Hunk { path: trim(path).to_owned(), moved: None });
            index += 1;
            continue;
        }
        if let Some(path) = header.strip_prefix("*** Update File: ") {
            let mut next = index + 1;
            while lines.get(next).is_some_and(|line| trim_end(line) == "*** End of File") {
                next += 1;
            }
            let mut moved = None;
            if let Some(line) = lines.get(next).map(|line| trim_end(line)) {
                if line == "*** Move to:" || line.starts_with("*** Move to: ") {
                    let to = trim(line.get("*** Move to: ".len()..).unwrap_or_default());
                    if to.is_empty() {
                        return None;
                    }
                    moved = Some(to.to_owned());
                    next += 1;
                }
            }
            index = update(&lines, next, end)?;
            hunks.push(Hunk { path: trim(path).to_owned(), moved });
            continue;
        }
        return None;
    }
    Some(hunks)
}

/// `parseUpdate`: where an Update hunk's body ends, or None where the native
/// parser fails. Only each chunk's line counts matter for that.
fn update(lines: &[&str], start: usize, end: usize) -> Option<usize> {
    // (old lines, new lines) of each chunk.
    let mut chunks: Vec<(usize, usize)> = Vec::new();
    let empty = |chunk: Option<&(usize, usize)>| chunk.is_some_and(|&(old, new)| old == 0 && new == 0);
    let marker = |line: &str| line == "@@" || line.starts_with("@@ ");
    let mut index = start;
    let mut after_end_of_file = false;
    while index < end {
        let line = lines[index];
        let update_line = trim_end(line);
        if after_end_of_file {
            if update_line.is_empty() {
                index += 1;
                continue;
            }
            if marker(update_line) {
                after_end_of_file = false;
            } else if is_boundary(update_line) {
                break;
            } else {
                return None;
            }
        }
        if update_line == "*** End of File" {
            if empty(chunks.last()) {
                return None;
            }
            if !chunks.is_empty() {
                after_end_of_file = true;
            }
            index += 1;
            continue;
        }
        if is_boundary(update_line) {
            break;
        }
        if marker(update_line) {
            if empty(chunks.last()) {
                return None;
            }
            chunks.push((0, 0));
            index += 1;
            continue;
        }
        if chunks.is_empty() {
            chunks.push((0, 0));
        }
        let chunk = chunks.last_mut().expect("a chunk");
        if line.is_empty() || line.starts_with(' ') {
            *chunk = (chunk.0 + 1, chunk.1 + 1);
        } else if line.starts_with('-') {
            chunk.0 += 1;
        } else if line.starts_with('+') {
            chunk.1 += 1;
        } else {
            return None;
        }
        index += 1;
    }
    if chunks.is_empty() || empty(chunks.last()) {
        return None;
    }
    Some(index)
}

fn is_boundary(line: &str) -> bool {
    line == "*** End Patch" || line.starts_with("*** Add File: ") || line.starts_with("*** Delete File: ")
        || line.starts_with("*** Update File: ")
}

/// `stripHeredoc`: the body of `/^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/`
/// when `input` (already trimmed) matches it, else `input`. The delimiter is
/// the longest run of word characters, quoted alike on both sides or not at
/// all; it must end the text after a new line; and the body starts after the
/// last new line of the white space after the opening delimiter that leaves
/// room for that closing one, as the regular expression's greedy `\s*`
/// followed by its lazy body finds it.
fn strip_heredoc(input: &str) -> &str {
    let rest = match input.strip_prefix("cat") {
        Some(after) if after.starts_with(js_space) => after.trim_start_matches(js_space),
        _ => input,
    };
    let Some(rest) = rest.strip_prefix("<<") else { return input };
    let (quote, rest) = match rest.chars().next() {
        Some(q @ ('\'' | '"')) => (Some(q), &rest[1..]),
        _ => (None, rest),
    };
    let word = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(rest.len());
    if word == 0 {
        return input;
    }
    let (delimiter, mut rest) = rest.split_at(word);
    if let Some(q) = quote {
        let Some(after) = rest.strip_prefix(q) else { return input };
        rest = after;
    }
    // The closing delimiter: a new line, then the delimiter, at the end.
    let Some(before_close) = input.strip_suffix(delimiter).and_then(|before| before.strip_suffix('\n')) else { return input };
    let close = before_close.len();
    let open = input.len() - rest.len();
    let space = rest.len() - rest.trim_start_matches(js_space).len();
    // The last new line in that white space with the body's end at or after it.
    let Some(newline) = input[open..open + space].char_indices().filter(|&(at, c)| c == '\n' && open + at < close)
        .map(|(at, _)| open + at).last() else { return input };
    &input[newline + 1..close]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(patch: &str) -> Option<Vec<(String, Option<String>)>> {
        hunks(patch).map(|hunks| hunks.into_iter().map(|hunk| (hunk.path, hunk.moved)).collect())
    }

    fn of(items: &[(&str, Option<&str>)]) -> Option<Vec<(String, Option<String>)>> {
        Some(items.iter().map(|(path, moved)| ((*path).to_owned(), moved.map(str::to_owned))).collect())
    }

    /// Cases of 2.2.5's own packages/core/test/patch.test.ts, by the files
    /// they name, and its failures as None.
    #[test]
    fn patches_name_the_files_the_native_parser_does() {
        let add = "*** Begin Patch\n*** Add File: add.txt\n+added\n*** End Patch";
        assert_eq!(paths("*** Begin Patch\n*** Add File: add.txt\n+added\n*** Update File: update.txt\n@@ section\n-old\n+new\n*** Delete File: delete.txt\n*** End Patch"),
            of(&[("add.txt", None), ("update.txt", None), ("delete.txt", None)]));
        assert_eq!(paths("*** Begin Patch\n*** End Patch"), of(&[]));
        assert_eq!(paths("*** Begin Patch\n*** Environment ID: remote\n*** Add File: file.txt\n+content\n*** End Patch"), of(&[("file.txt", None)]));
        assert_eq!(paths("*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch"),
            of(&[("old.txt", Some("new.txt"))]));
        assert_eq!(paths(&format!("{add}\n \t\n")), of(&[("add.txt", None)]));
        for wrapped in [format!("cat <<'EOF'\n{add}\nEOF"), format!("<<EOF\n{add}\nEOF"), format!("<<\"EOF\"\n{add}\nEOF"),
            format!("cat \n <<EOF \n\n{add}\nEOF")] {
            assert_eq!(paths(&wrapped), of(&[("add.txt", None)]), "{wrapped:?}");
        }
        assert_eq!(paths("*** Begin Patch\n  *** Update File: foo.txt\n@@\n-old\n+new\n*** End Patch"), of(&[("foo.txt", None)]));
        assert_eq!(paths(" *** Begin Patch \n*** Update File: file.txt\n@@\n-one\n+two\n *** End Patch "), of(&[("file.txt", None)]));
        assert_eq!(paths("*** Begin Patch\n*** Add File: relative.txt\n+content\n*** Delete File: /tmp/delete.txt\n*** Update File: /tmp/update.txt\n@@\n-old\n+new\n*** End Patch"),
            of(&[("relative.txt", None), ("/tmp/delete.txt", None), ("/tmp/update.txt", None)]));
        assert_eq!(paths("*** Begin Patch\r\n*** Update File: file.txt\r\n@@\r\n-old\r\r\n+new\r\n*** End Patch\r\n"), of(&[("file.txt", None)]));
        assert_eq!(paths("*** Begin Patch\n*** Update File: file.txt\n@@\n+quux\n*** End of File\n\n*** End Patch"), of(&[("file.txt", None)]));
        assert_eq!(paths("*** Begin Patch\n*** Update File: old.txt\n*** End of File\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch"),
            of(&[("old.txt", Some("new.txt"))]));
        assert_eq!(paths("*** Begin Patch\n*** Update File: file.txt\n import foo\n+bar\n*** End Patch"), of(&[("file.txt", None)]));
        // An indented marker in an update is its context, not another file.
        assert_eq!(paths("*** Begin Patch\n*** Update File: a.txt\n@@\n-old a\n+new a\n *** Update File: b.txt\n@@\n-old b\n+new b\n*** End Patch"),
            of(&[("a.txt", None)]));
        assert_eq!(paths("*** Begin Patch\n*** Update File: file.txt\n@@\n before\n *** Move to: moved.txt\n *** End of File\n*** End Patch"),
            of(&[("file.txt", None)]));
        assert_eq!(paths("*** Begin Patch\n*** Update File: file.txt\n@@\n context before\n\n context after\n*** End Patch"), of(&[("file.txt", None)]));

        for failing in ["This is not a valid patch", "*** Begin Patch\n*** Add File: add.txt\n+added", "extra\n*** Begin Patch\n*** End Patch",
            "*** Begin Patch\n*** Add File: add.txt\n+added\n*** End Patch\nextra", "<<\"EOF'\n*** Begin Patch\n*** End Patch\nEOF",
            "<<EOF\n*** Begin Patch\n*** Add File: add.txt\n+added\nEOF", "*** Begin Patch\n*** Add File: file.txt\nbad\n*** End Patch",
            "*** Begin Patch\n*** Delete File: file.txt\nbad\n*** End Patch", "*** Begin Patch\n*** Delete File: file.txt\n*** Frobnicate File: next.txt\n*** End Patch",
            "*** Begin Patch\n*** Update File: file.txt\n*** End Patch", "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** Delete File: other.txt\n*** End Patch",
            "*** Begin Patch\n*** Update File: file.txt\n*** End of File\n*** End Patch", "*** Begin Patch\n*** Update File: file.txt\n@@\n*** End Patch",
            "*** Begin Patch\n*** Update File: file.txt\n@@\n*** End of File\n*** End Patch", "*** Begin Patch\n*** Update File: file.txt\n@@\n@@\n-old\n+new\n*** End Patch",
            "*** Begin Patch\n*** Update File: file.txt\n@@\n*** Update File: other.txt\n@@\n-old\n+new\n*** End Patch",
            "*** Begin Patch\n*** Update File: file.txt\n@@\nbad\n*** End Patch", "*** Begin Patch\n*** Update File: file.txt\n@@\n-old\nbad\n*** End Patch",
            "*** Begin Patch\n*** Update File: file.txt\n@@foo\n*** End Patch", "*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch",
            "*** Begin Patch\n*** Add File:\n*** End Patch", "*** Begin Patch\n*** Add File: \n*** End Patch", "*** Begin Patch\n*** Delete File: \n*** End Patch",
            "*** Begin Patch\n*** Update File: \n*** End Patch", "*** Begin Patch\n*** Update File: old.txt\n*** Move to: \n@@\n-old\n+new\n*** End Patch",
            "*** End Patch", ""] {
            assert_eq!(paths(failing), None, "{failing:?}");
        }
    }

    /// The heredoc wrapper and JavaScript's white space, exactly.
    #[test]
    fn the_wrapper_and_white_space_are_read_as_javascript_reads_them() {
        assert_eq!(strip_heredoc("<<EOF\nbody\nEOF"), "body");
        assert_eq!(strip_heredoc("<<EOF\n\nEOF"), "");
        assert_eq!(strip_heredoc("<<EOF\nEOF"), "<<EOF\nEOF", "no room for a body between two new lines");
        assert_eq!(strip_heredoc("<<EOF\n\n\nbody\nEOF"), "body", "the greedy space takes each new line before the body");
        assert_eq!(strip_heredoc("<<EOFX\nbody\nEOF"), "<<EOFX\nbody\nEOF", "another delimiter");
        assert_eq!(strip_heredoc("catt <<EOF\nbody\nEOF"), "catt <<EOF\nbody\nEOF");
        assert_eq!(strip_heredoc("<<'EOF\nbody\nEOF"), "<<'EOF\nbody\nEOF");
        assert_eq!(strip_heredoc("<<EOF x\nbody\nEOF"), "<<EOF x\nbody\nEOF");
        // U+FEFF is JavaScript white space; U+0085 isn't.
        assert_eq!(paths("\u{FEFF}*** Begin Patch\n*** Delete File: a\n*** End Patch"), of(&[("a", None)]));
        assert_eq!(paths("\u{85}*** Begin Patch\n*** Delete File: a\n*** End Patch"), None);
        assert_eq!(paths("*** Begin Patch\n*** Delete File: \u{3000}a b\u{A0}\n*** End Patch"), of(&[("a b", None)]));
    }
}
