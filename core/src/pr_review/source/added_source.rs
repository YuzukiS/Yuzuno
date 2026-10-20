//! Coverage from delivered full contents of an added regular text file.
//! Neither requested ranges nor another revision/blob can fill a gap.
use super::missing;
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct AddedSources {
    files: HashMap<(String, String, String), ReadFile>,
}

struct ReadFile {
    mode: String,
    lines: usize,
    bytes: usize,
    ranges: Vec<(usize, usize)>,
    byte_ranges: Vec<(usize, usize)>,
    receipts: Vec<usize>,
}

impl AddedSources {
    pub(super) fn accept(&mut self, value: &Value, receipt: usize) {
        let Some((
            path,
            revision,
            blob,
            mode,
            lines,
            bytes,
            start,
            end,
            start_byte,
            end_byte,
            source,
        )) = fields(value)
        else {
            return;
        };
        if start_byte > end_byte || end_byte > bytes || end_byte - start_byte != source.len() {
            return;
        }
        // This manifest entry and its modes were part of the delivered read,
        // not merely discovered in an internal Git tree.
        let change = &value["change"];
        if change["status"] != "added"
            || change["oldMode"] != "000000"
            || change["path"] != path
            || change["sourceRevision"] != revision
            || change["sourceBlob"] != blob
            || change["modeAtHead"] != mode
            || !matches!(mode, "100644" | "100755")
        {
            return;
        }
        let interval = if lines == 0 {
            if start != 1 || end != 0 || bytes != 0 || !source.is_empty() {
                return;
            }
            (0, 0)
        } else {
            if start == 0
                || start > end
                || end > lines
                || source.lines().count() != end - start + 1
                || source.len() > bytes
                || (start == 1 && start_byte != 0)
                || (end == lines && end_byte != bytes)
            {
                return;
            }
            (start - 1, end)
        };
        let file = self
            .files
            .entry((path.into(), revision.into(), blob.into()))
            .or_insert_with(|| ReadFile {
                mode: mode.into(),
                lines,
                bytes,
                ranges: Vec::new(),
                byte_ranges: Vec::new(),
                receipts: Vec::new(),
            });
        if file.mode != mode || file.lines != lines || file.bytes != bytes {
            return;
        }
        file.ranges.push(interval);
        file.byte_ranges.push((start_byte, end_byte));
        file.receipts.push(receipt);
    }

    pub(super) fn complete(&self, manifest: &Value) -> Option<Value> {
        if manifest["status"] != "added" || manifest["oldMode"] != "000000" {
            return None;
        }
        let key = (
            manifest["path"].as_str()?.to_owned(),
            manifest["sourceRevision"].as_str()?.to_owned(),
            manifest["sourceBlob"].as_str()?.to_owned(),
        );
        let file = self.files.get(&key)?;
        if manifest["modeAtHead"] != file.mode
            || !missing(0, file.lines, &file.ranges).is_empty()
            || !missing(0, file.bytes, &file.byte_ranges).is_empty()
        {
            return None;
        }
        Some(json!({
            "path":key.0,"revision":key.1,"blobSha":key.2,
            "deliveredVia":"source_read","evidenceKind":"full_added_source",
            "mode":file.mode,"totalLines":file.lines,"sourceBytes":file.bytes,
            "receipts":file.receipts
        }))
    }
}

type Fields<'a> = (
    &'a str,
    &'a str,
    &'a str,
    &'a str,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    &'a str,
);
fn fields(value: &Value) -> Option<Fields<'_>> {
    let number = |key: &str| usize::try_from(value[key].as_u64()?).ok();
    Some((
        value["path"].as_str()?,
        value["revision"].as_str()?,
        value["blobSha"].as_str()?,
        value["mode"].as_str()?,
        number("totalLines")?,
        number("sourceBytes")?,
        number("startLine")?,
        number("endLine")?,
        number("startByte")?,
        number("endByte")?,
        value["source"].as_str()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(start: usize, end: usize) -> Value {
        json!({"path":"new.rs","revision":"a".repeat(40),"blobSha":"b".repeat(40),"mode":"100644",
            "startLine":start,"endLine":end,"totalLines":2,"sourceBytes":4,"source":"x\n",
            "startByte":(start-1)*2,"endByte":end*2,
            "change":{"path":"new.rs","status":"added","oldMode":"000000","modeAtHead":"100644",
                "sourceRevision":"a".repeat(40),"sourceBlob":"b".repeat(40)}})
    }

    #[test]
    fn missing_manifest_wrong_identity_and_truncated_content_cannot_cover_a_file() {
        let mut complete = page(1, 2);
        complete["source"] = json!("x\ny\n");
        let manifest = complete["change"].clone();
        for (field, wrong) in [
            ("revision", json!("c".repeat(40))),
            ("blobSha", json!("d".repeat(40))),
            ("mode", json!("120000")),
            ("source", json!("x\n")),
            ("source", json!("x\ny")),
            ("change", Value::Null),
        ] {
            let mut reads = AddedSources::default();
            let mut bad = complete.clone();
            bad[field] = wrong;
            reads.accept(&bad, 1);
            assert!(reads.complete(&manifest).is_none(), "{field}");
        }
    }

    #[test]
    fn different_blobs_or_revisions_never_fill_each_others_missing_ranges() {
        let first = page(1, 1);
        let second = page(2, 2);
        let manifest = first["change"].clone();
        let mut reads = AddedSources::default();
        reads.accept(&first, 1);
        for (outer, inner) in [("blobSha", "sourceBlob"), ("revision", "sourceRevision")] {
            let mut other = second.clone();
            other[outer] = json!("e".repeat(40));
            other["change"][inner] = other[outer].clone();
            reads.accept(&other, 2);
            assert!(reads.complete(&manifest).is_none());
        }
        reads.accept(&second, 4);
        assert_eq!(
            reads.complete(&manifest).unwrap()["receipts"],
            json!([1, 4])
        );
    }
}
