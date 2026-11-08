//! Binary assets a release acknowledges (YN-52). A review round reads text
//! only: an image, icon or font a PR adds or changes stays `unsupported:
//! binary`, the round is incomplete and its conclusion `unknown`, which never
//! passes. The releasing lead, or the user, may acknowledge such files at
//! release, bound to their exact content. The round stays as it is; only the
//! queue's review gate admits it, and only when those files are its one gap:
//!
//! - `gap` reads the stored round: the reviewer said the patch is correct with
//!   no P0–P2 finding, and every changed path it did not cover is a binary
//!   file at the head, unread for that reason alone;
//! - `matches` holds the release's list to exactly those files, and once their
//!   content was read, to the blobs the round saw;
//! - `read`, at release, reads each file at the released head from Core's own
//!   object store: a regular file of at most `BYTES` whose SHA-256 is the one
//!   acknowledged and whose leading bytes are an image or font format.
use crate::workspace::Workspace;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// At most this many files, each of at most this many bytes.
pub(super) const FILES: usize = 64;
pub(super) const BYTES: usize = 2 * 1024 * 1024;
const NOTE: usize = 500;
/// The review policy whose reasons this reads (pr_review::policy, version 3).
const POLICY: u64 = 3;
/// The reasons a round whose only gap is unreadable files carries.
const REASONS: [&str; 2] = ["coverage_incomplete", "unsupported_source"];

/// One file as the release acknowledges it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Acknowledged {
    pub path: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub(super) fn validate(files: &[Acknowledged]) -> Result<()> {
    ensure!(!files.is_empty() && files.len() <= FILES, "invalid_input: acknowledgeBinaries lists 1–{FILES} files");
    let mut seen = std::collections::BTreeSet::new();
    for f in files {
        ensure!(
            !f.path.is_empty() && f.path.len() <= 4096 && !f.path.starts_with('/') && !f.path.chars().any(char::is_control),
            "invalid_input: acknowledgeBinaries names {:?}, which is not a repository path",
            f.path
        );
        ensure!(
            f.sha256.len() == 64 && f.sha256.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
            "invalid_input: the sha256 of {} must be 64 lowercase hexadecimal characters",
            f.path
        );
        ensure!(f.note.as_ref().is_none_or(|n| n.len() <= NOTE), "invalid_input: the note of {} must be at most {NOTE} bytes", f.path);
        ensure!(seen.insert(f.path.as_str()), "invalid_input: acknowledgeBinaries lists {} more than once", f.path);
    }
    Ok(())
}

/// A binary file the round left unread: its path and its blob at the head
/// the round reviewed.
#[derive(Debug, PartialEq)]
pub(super) struct Binary {
    pub path: String,
    pub blob: String,
}

/// The binary files of `round` when they are its only gap, or why they are not.
pub(super) fn gap(round: &Value) -> Result<Vec<Binary>, String> {
    let id = round["id"].as_str().unwrap_or("?");
    if round["status"] != "completed" {
        return Err(format!("review round {id} has not completed"));
    }
    let paths = round["scope"]["paths"].as_array();
    if round["policyVersion"] != POLICY || !round["coveragePolicyVersion"].as_u64().is_some_and(|v| v >= 3) || paths.is_none() {
        return Err(format!("review round {id} has no review scope (coverage policy 3), so Core cannot tell which paths it left unread"));
    }
    if round["nativeCorrectness"] != "patch is correct" {
        return Err(format!(
            "in review round {id} the reviewer did not say the patch is correct (it said {})",
            round["nativeCorrectness"].as_str().unwrap_or("nothing")
        ));
    }
    let blocking = round["findings"].as_array().into_iter().flatten().filter(|f| f["priority"].as_u64().is_some_and(|p| p <= 2)).count();
    if blocking > 0 {
        return Err(format!("review round {id} found {blocking} P0–P2 issue(s)"));
    }
    let reasons = round["reasonCodes"].as_array().into_iter().flatten();
    if let Some(other) = reasons.filter_map(Value::as_str).find(|r| !REASONS.contains(r)) {
        return Err(format!("review round {id} is incomplete for another reason too ({other})"));
    }
    if let Some(limit) = round["coverage"]["terminalLimit"].as_str() {
        return Err(format!("review round {id} stopped at a limit ({limit})"));
    }
    let mut binaries = Vec::new();
    for p in paths.into_iter().flatten() {
        let path = p["path"].as_str().unwrap_or("?");
        match p["state"].as_str() {
            Some("covered") => continue,
            Some("unsupported") if p["reason"] == "binary" => {}
            state => {
                let reason = p["reason"].as_str().map(|r| format!(", {r}")).unwrap_or_default();
                return Err(format!("{path} is {}{reason} in review round {id}, and only binary files can be acknowledged", state.unwrap_or("not read")));
            }
        }
        for fact in p["facts"].as_array().into_iter().flatten() {
            let only_binary = match fact["kind"].as_str() {
                Some("unsupported") => fact["reason"] == "binary",
                Some("not_read" | "not_checked_after_review") => true,
                Some("read_failed") => fact["requests"].as_array().into_iter().flatten().all(|r| r["kind"] == "unsupported_source"),
                _ => false,
            };
            if !only_binary {
                let what = [fact["kind"].as_str(), fact["reason"].as_str()].into_iter().flatten().collect::<Vec<_>>().join(", ");
                return Err(format!("{path} is binary in review round {id} but also {what}"));
            }
        }
        let blob = p["head"]["blobSha"].as_str().filter(|b| !b.is_empty());
        let Some(blob) = blob.filter(|_| p["status"] != "removed") else {
            return Err(format!("{path} is a binary file removed at the head in review round {id}; only files added or changed at the head can be acknowledged"));
        };
        binaries.push(Binary { path: path.to_owned(), blob: blob.to_owned() });
    }
    for failed in round["coverage"]["failedRequests"].as_array().into_iter().flatten().filter(|f| f["resolved"] != true) {
        let path = failed["requested"]["path"].as_str();
        if failed["kind"] != "unsupported_source" || !path.is_some_and(|p| binaries.iter().any(|b| b.path == p)) {
            return Err(format!(
                "review round {id} has an unresolved {} request (receipt {}){}",
                failed["kind"].as_str().unwrap_or("?"),
                failed["receipt"],
                path.map(|p| format!(" for {p}")).unwrap_or_default()
            ));
        }
    }
    if binaries.is_empty() {
        return Err(format!("review round {id} left no binary file unread"));
    }
    Ok(binaries)
}

/// The release's list names exactly the round's binary files, each once, and
/// each file read at the released head (`blobSha`, once read) is the blob the
/// round saw.
pub(super) fn matches(binaries: &[Binary], listed: &Value) -> Result<(), String> {
    let files = listed.as_array().map(Vec::as_slice).unwrap_or_default();
    for (n, f) in files.iter().enumerate() {
        let path = f["path"].as_str().unwrap_or("?");
        if files[..n].iter().any(|g| g["path"] == f["path"]) {
            return Err(format!("{path} is acknowledged more than once"));
        }
        let Some(b) = binaries.iter().find(|b| b.path == path) else {
            return Err(format!("{path} is acknowledged, but it is not a binary file the review round left unread"));
        };
        if let Some(blob) = f["blobSha"].as_str().filter(|blob| *blob != b.blob) {
            return Err(format!("{path} at the released head is blob {}, not the blob {} the review round saw", short(blob), short(&b.blob)));
        }
    }
    if let Some(b) = binaries.iter().find(|b| !files.iter().any(|f| f["path"] == b.path.as_str())) {
        return Err(format!("{} is a binary file the review round left unread, but the release does not acknowledge it", b.path));
    }
    Ok(())
}

fn short(sha: &str) -> &str {
    &sha[..12.min(sha.len())]
}

/// The asset format `bytes` start with, by their leading bytes alone: images,
/// icons and fonts. Anything else, executables and archives included, is none.
pub(super) fn format(bytes: &[u8]) -> Option<&'static str> {
    let at = |offset: usize, magic: &[u8]| bytes.get(offset..offset + magic.len()) == Some(magic);
    Some(match () {
        _ if at(0, b"\x89PNG\r\n\x1a\n") => "png",
        _ if at(0, b"\xff\xd8\xff") => "jpeg",
        _ if at(0, b"GIF87a") || at(0, b"GIF89a") => "gif",
        _ if at(0, b"RIFF") && at(8, b"WEBP") => "webp",
        // An icon directory: reserved 0, type 1, then at least one image.
        _ if at(0, b"\x00\x00\x01\x00") && bytes.get(4..6).is_some_and(|n| n != [0, 0]) => "ico",
        _ if at(0, b"icns") => "icns",
        _ if at(0, b"wOFF") => "woff",
        _ if at(0, b"wOF2") => "woff2",
        _ if at(0, b"\x00\x01\x00\x00") || at(0, b"true") => "ttf",
        _ if at(0, b"OTTO") => "otf",
        _ => return None,
    })
}

/// Each acknowledged file at the released `head`, read from Core's own object
/// store: a regular, non-executable file of at most `BYTES` bytes, whose
/// SHA-256 is the acknowledged one and whose format is an asset's. `Ok(Err)`
/// names the first file that is not, and why.
pub(super) async fn read(ws: &Arc<Workspace>, repo: &str, head: &str, files: &[Acknowledged]) -> Result<Result<Vec<Value>, String>> {
    let directory = tempfile::tempdir().context("A directory for reading the acknowledged files")?;
    let git = super::merges::store(ws, directory.path(), repo, &[head]).await?;
    let mut read = Vec::new();
    for f in files {
        let row = git.metadata(&["ls-tree", "-z", head, "--", &f.path]).await?;
        let row = String::from_utf8_lossy(&row);
        let Some((meta, path)) = row.trim_end_matches('\0').split_once('\t') else {
            return Ok(Err(format!("{} is not a file at the released head {}", f.path, short(head))));
        };
        let meta: Vec<&str> = meta.split(' ').collect();
        if path != f.path || meta.len() != 3 || meta[1] != "blob" {
            return Ok(Err(format!("{} is not a file at the released head {}", f.path, short(head))));
        }
        if meta[0] != "100644" {
            return Ok(Err(format!("{} has mode {} at the released head; only regular, non-executable files (100644) can be acknowledged", f.path, meta[0])));
        }
        let blob = meta[2];
        let size: usize = String::from_utf8(git.metadata(&["cat-file", "-s", blob]).await?)?.trim().parse().context("A blob size")?;
        if size > BYTES {
            return Ok(Err(format!("{} has {size} bytes; an acknowledged file has at most {BYTES}", f.path)));
        }
        let bytes = git.run(&["cat-file", "blob", blob], BYTES).await?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        if digest != f.sha256 {
            return Ok(Err(format!("{} has SHA-256 {digest} at the released head, not the acknowledged {}", f.path, f.sha256)));
        }
        let Some(kind) = format(&bytes) else {
            return Ok(Err(format!(
                "{} is not an image or font by its leading bytes ({}); only PNG, JPEG, GIF, WebP, ICO, ICNS, WOFF, WOFF2, TTF and OTF files can be acknowledged",
                f.path,
                bytes.iter().take(8).map(|b| format!("{b:02x}")).collect::<String>()
            )));
        };
        read.push(json!({"path":f.path,"sha256":digest,"note":f.note,"blobSha":blob,"bytes":bytes.len(),"format":kind}));
    }
    Ok(Ok(read))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob(c: char) -> String {
        std::iter::repeat_n(c, 40).collect()
    }
    fn binary(path: &str, c: char) -> Value {
        json!({"path":path,"status":"added","state":"unsupported","reason":"binary","head":{"blobSha":blob(c),"mode":"100644"},
            "facts":[{"kind":"unsupported","side":"head","reason":"binary","blobSha":blob(c),"contentSha256":"e".repeat(64),"found":"after_review"},
                     {"kind":"read_failed","requests":[{"receipt":4,"kind":"unsupported_source","tool":"read"}]},
                     {"kind":"not_read","remainingByteRanges":null,"totalDiffBytes":null}]})
    }
    /// A completed round that read src/a.rs and could not read two images:
    /// the reviewer said the patch is correct, with one P3 note.
    fn round() -> Value {
        json!({"id":"r1","status":"completed","conclusion":"unknown","policyVersion":3,"coveragePolicyVersion":3,
            "nativeCorrectness":"patch is correct","reasonCodes":["coverage_incomplete","unsupported_source"],
            "findings":[{"priority":3,"title":"nit"}],
            "coverage":{"terminalLimit":null,"unresolvedRequests":1,
                "failedRequests":[{"receipt":4,"kind":"unsupported_source","resolved":false,"requested":{"path":"icons/a.png"}},
                                  {"receipt":2,"kind":"invalid_range","resolved":true,"requested":{"path":"src/a.rs"}}]},
            "scope":{"paths":[
                {"path":"src/a.rs","status":"modified","state":"covered","head":{"blobSha":blob('c'),"mode":"100644"},"facts":[{"kind":"covered","evidenceKind":"complete_diff"}]},
                binary("icons/a.png", 'a'),
                binary("icons/b.png", 'b'),
            ]}})
    }
    fn gap_paths(round: &Value) -> Vec<Binary> {
        gap(round).unwrap()
    }

    #[test]
    fn the_gap_is_the_binary_files_when_they_are_a_correct_rounds_only_gap() {
        assert_eq!(
            gap_paths(&round()),
            [Binary { path: "icons/a.png".into(), blob: blob('a') }, Binary { path: "icons/b.png".into(), blob: blob('b') }]
        );
        // A modified image is binary on both sides; still only binary.
        let mut r = round();
        r["scope"]["paths"][1]["status"] = json!("modified");
        r["scope"]["paths"][1]["facts"].as_array_mut().unwrap().push(json!({"kind":"unsupported","side":"mergeBase","reason":"binary"}));
        assert_eq!(gap_paths(&r).len(), 2);
    }

    #[test]
    fn every_other_gap_or_verdict_refuses_and_names_it() {
        type Edit = fn(&mut Value);
        let text = |state: &str, reason: Option<&str>| {
            let mut p = json!({"path":"src/b.rs","status":"modified","state":state,"head":{"blobSha":blob('d'),"mode":"100644"},"facts":[{"kind":state}]});
            if let Some(reason) = reason {
                p["reason"] = json!(reason);
                p["facts"][0]["reason"] = json!(reason);
            }
            p
        };
        let push = |r: &mut Value, p: Value| r["scope"]["paths"].as_array_mut().unwrap().push(p);
        let cases: Vec<(Edit, &str)> = vec![
            (|r| r["status"] = json!("unknown"), "review round r1 has not completed"),
            (|r| r["scope"] = Value::Null, "has no review scope"),
            (|r| r["policyVersion"] = json!(2), "has no review scope"),
            (|r| r["coveragePolicyVersion"] = json!(2), "has no review scope"),
            (|r| r["nativeCorrectness"] = json!("patch is incorrect"), "did not say the patch is correct (it said patch is incorrect)"),
            (|r| r["nativeCorrectness"] = json!("unknown"), "did not say the patch is correct (it said unknown)"),
            (|r| r["findings"] = json!([{"priority":1},{"priority":3}]), "review round r1 found 1 P0–P2 issue(s)"),
            (|r| r["findings"] = json!([{"priority":2}]), "found 1 P0–P2 issue(s)"),
            (|r| r["reasonCodes"].as_array_mut().unwrap().push(json!("verdict_conflict")), "incomplete for another reason too (verdict_conflict)"),
            (|r| r["reasonCodes"].as_array_mut().unwrap().push(json!("invalid_report")), "another reason too (invalid_report)"),
            (|r| r["reasonCodes"].as_array_mut().unwrap().push(json!("scope_excluded")), "another reason too (scope_excluded)"),
            (|r| r["coverage"]["terminalLimit"] = json!("Review context budget exhausted"), "stopped at a limit (Review context budget exhausted)"),
            (|r| r["coverage"]["failedRequests"].as_array_mut().unwrap().push(json!({"receipt":7,"kind":"invalid_range","resolved":false,"requested":{"path":"src/a.rs"}})),
                "an unresolved invalid_range request (receipt 7) for src/a.rs"),
            (|r| r["coverage"]["failedRequests"].as_array_mut().unwrap().push(json!({"receipt":8,"kind":"unsupported_source","resolved":false,"requested":{"path":"lib/x.so"}})),
                "an unresolved unsupported_source request (receipt 8) for lib/x.so"),
            (|r| r["scope"]["paths"][1]["facts"].as_array_mut().unwrap().push(json!({"kind":"unsupported","side":"mergeBase","reason":"symlink"})),
                "icons/a.png is binary in review round r1 but also unsupported, symlink"),
            (|r| r["scope"]["paths"][1]["facts"].as_array_mut().unwrap().push(json!({"kind":"excluded","rule":"icons/**"})), "icons/a.png is binary in review round r1 but also excluded"),
            (|r| r["scope"]["paths"][1]["facts"][1]["requests"][0]["kind"] = json!("invalid_range"), "icons/a.png is binary in review round r1 but also read_failed"),
            (|r| {
                r["scope"]["paths"][2]["status"] = json!("removed");
                r["scope"]["paths"][2]["head"] = Value::Null;
            }, "icons/b.png is a binary file removed at the head"),
            (|r| {
                let covered = r["scope"]["paths"][0].clone();
                r["scope"]["paths"] = json!([covered]);
                r["coverage"]["failedRequests"] = json!([]);
            }, "review round r1 left no binary file unread"),
        ];
        for (n, (edit, words)) in cases.into_iter().enumerate() {
            let mut r = round();
            edit(&mut r);
            let refused = gap(&r).unwrap_err();
            assert!(refused.contains(words), "case {n}: {refused}");
        }
        let paths: Vec<(Value, &str)> = vec![
            (text("not_read", None), "src/b.rs is not_read in review round r1, and only binary files can be acknowledged"),
            (text("read_failed", None), "src/b.rs is read_failed in review round r1"),
            (text("budget_exhausted", Some("diff_exceeds_context")), "src/b.rs is budget_exhausted, diff_exceeds_context in review round r1"),
            (text("budget_exhausted", Some("context_exhausted")), "src/b.rs is budget_exhausted, context_exhausted"),
            (text("excluded", None), "src/b.rs is excluded in review round r1"),
            (text("unsupported", Some("symlink")), "src/b.rs is unsupported, symlink"),
            (text("unsupported", Some("submodule")), "src/b.rs is unsupported, submodule"),
            (text("unsupported", Some("special_file")), "src/b.rs is unsupported, special_file"),
            (text("unsupported", Some("not_utf8")), "src/b.rs is unsupported, not_utf8"),
        ];
        for (p, words) in paths {
            let mut r = round();
            push(&mut r, p);
            let refused = gap(&r).unwrap_err();
            assert!(refused.contains(words), "{words}: {refused}");
        }
    }

    #[test]
    fn the_list_must_name_exactly_the_rounds_binary_files_once_with_the_blobs_it_saw() {
        let gap = gap_paths(&round());
        let file = |path: &str| json!({"path":path,"sha256":"f".repeat(64)});
        assert_eq!(matches(&gap, &json!([file("icons/b.png"), file("icons/a.png")])), Ok(()), "in any order");
        let read = json!([{"path":"icons/a.png","blobSha":blob('a')},{"path":"icons/b.png","blobSha":blob('b')}]);
        assert_eq!(matches(&gap, &read), Ok(()), "with the blobs the round saw");
        let cases = [
            (json!([file("icons/a.png")]), "icons/b.png is a binary file the review round left unread, but the release does not acknowledge it"),
            (json!([file("icons/a.png"), file("icons/b.png"), file("icons/c.png")]), "icons/c.png is acknowledged, but it is not a binary file the review round left unread"),
            (json!([file("src/a.rs"), file("icons/a.png"), file("icons/b.png")]), "src/a.rs is acknowledged, but it is not a binary file"),
            (json!([file("icons/a.png"), file("icons/a.png"), file("icons/b.png")]), "icons/a.png is acknowledged more than once"),
            (json!([{"path":"icons/a.png","blobSha":blob('9')}, file("icons/b.png")]), "icons/a.png at the released head is blob 999999999999, not the blob aaaaaaaaaaaa the review round saw"),
            (json!([]), "icons/a.png is a binary file the review round left unread"),
        ];
        for (listed, words) in cases {
            let refused = matches(&gap, &listed).unwrap_err();
            assert!(refused.contains(words), "{listed}: {refused}");
        }
    }

    #[test]
    fn only_image_icon_and_font_formats_are_assets_by_their_leading_bytes() {
        let with = |head: &[u8]| {
            let mut b = head.to_vec();
            b.extend([0u8; 16]);
            b
        };
        let assets: [(&[u8], &str); 12] = [
            (b"\x89PNG\r\n\x1a\n", "png"),
            (b"\xff\xd8\xff\xe0", "jpeg"),
            (b"GIF87a", "gif"),
            (b"GIF89a", "gif"),
            (b"RIFF\x10\x00\x00\x00WEBPVP8 ", "webp"),
            (b"\x00\x00\x01\x00\x01\x00", "ico"),
            (b"icns", "icns"),
            (b"wOFF", "woff"),
            (b"wOF2", "woff2"),
            (b"\x00\x01\x00\x00", "ttf"),
            (b"true", "ttf"),
            (b"OTTO", "otf"),
        ];
        for (head, kind) in assets {
            assert_eq!(format(&with(head)), Some(kind), "{head:02x?}");
        }
        let others: [&[u8]; 12] = [
            b"MZ\x90\x00",               // Windows executable
            b"\x7fELF",                  // ELF executable
            b"\xcf\xfa\xed\xfe",         // Mach-O
            b"\xca\xfe\xba\xbe",         // universal binary / class file
            b"PK\x03\x04",               // zip, jar, docx
            b"\x1f\x8b\x08",             // gzip
            b"\x00asm\x01\x00\x00\x00",  // WebAssembly
            b"%PDF-1.7",                 // PDF
            b"RIFF\x10\x00\x00\x00WAVE", // audio, not WebP
            b"\x00\x00\x01\x00\x00\x00", // an icon directory with no image
            b"\x00\x00\x02\x00\x01\x00", // a cursor
            b"",
        ];
        for head in others {
            assert_eq!(format(&with(head)), None, "{head:02x?}");
        }
        assert_eq!(format(b"\x89PNG"), None, "a cut signature is no PNG");
    }

    #[test]
    fn the_release_list_is_validated_before_anything_is_read() {
        let file = |path: &str, sha: &str| Acknowledged { path: path.into(), sha256: sha.into(), note: None };
        let good = "a".repeat(64);
        assert!(validate(&[file("icons/a.png", &good)]).is_ok());
        let many: Vec<_> = (0..=FILES).map(|n| file(&format!("i/{n}.png"), &good)).collect();
        let long = Acknowledged { note: Some("x".repeat(501)), ..file("a.png", &good) };
        let cases: Vec<(Vec<Acknowledged>, &str)> = vec![
            (vec![], "lists 1–64 files"),
            (many, "lists 1–64 files"),
            (vec![file("a.png", &"A".repeat(64))], "the sha256 of a.png must be 64 lowercase hexadecimal characters"),
            (vec![file("a.png", "abc")], "the sha256 of a.png must be 64"),
            (vec![file("/etc/a.png", &good)], "is not a repository path"),
            (vec![file("", &good)], "is not a repository path"),
            (vec![file("a\n.png", &good)], "is not a repository path"),
            (vec![file("a.png", &good), file("a.png", &good)], "lists a.png more than once"),
            (vec![long], "the note of a.png must be at most 500 bytes"),
        ];
        for (files, words) in cases {
            let refused = validate(&files).unwrap_err().to_string();
            assert!(refused.starts_with("invalid_input") && refused.contains(words), "{refused}");
        }
    }
}
