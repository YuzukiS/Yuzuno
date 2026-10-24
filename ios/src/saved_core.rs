//! The Workspace last connected from the connection page, kept in
//! `core.json` in the app's data folder so the next launch can fill it in.
//! It is written whole and then renamed over the old record, as the desktop
//! app does (desktop/src/main.rs), so a failed save leaves the old record as
//! it was. Reading tells a record never saved apart from one that cannot be
//! read, so a damaged record is not taken for a first launch. No
//! dependencies but `std`, `serde_json`, `url` and `core_url`.

use std::io::{self, Write};
use std::path::Path;

use url::Url;

/// More than any record this app writes.
const LIMIT: u64 = 4096;

/// What the saved record says.
#[derive(Debug, PartialEq)]
pub enum Saved {
    /// Nothing was ever saved: the page asks for an address.
    Never,
    /// A Workspace this app would connect to now.
    Core(Url),
    /// A record that cannot be used, and why. It is left as it is; the next
    /// successful save replaces it.
    Unreadable(String),
}

impl Saved {
    /// As the connection page reads it.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Saved::Never => serde_json::json!({ "state": "never" }),
            Saved::Core(core) => serde_json::json!({ "state": "saved", "url": core.as_str() }),
            Saved::Unreadable(reason) => serde_json::json!({ "state": "unreadable", "reason": reason }),
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
        return Saved::Unreadable("it is not a saved Workspace address".into());
    }
    let address = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|record| record.get("coreUrl")?.as_str().map(str::to_owned));
    match address.map(|address| crate::core_url::parse(&address)) {
        Some(Ok(core)) => Saved::Core(core),
        Some(Err(_)) => Saved::Unreadable("its address is not one this app opens".into()),
        None => Saved::Unreadable("it is not a saved Workspace address".into()),
    }
}

/// Saves `core` as the Workspace to fill in next time. On an error nothing
/// is changed: the old record, if any, is still the one read.
pub fn save(path: &Path, core: &Url) -> io::Result<()> {
    save_with(path, core, |staged, path| std::fs::rename(staged, path))
}

fn save_with(path: &Path, core: &Url, rename: impl FnOnce(&Path, &Path) -> io::Result<()>) -> io::Result<()> {
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let staged = path.with_extension("json.new");
    let saved = std::fs::File::create(&staged)
        .and_then(|mut file| {
            file.write_all(serde_json::json!({ "coreUrl": core.as_str() }).to_string().as_bytes())?;
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

    fn folder() -> (std::path::PathBuf, std::path::PathBuf) {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("yuzuno-ios-saved-core-{}-{n}", std::process::id()));
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
    fn a_save_replaces_the_record_whole_and_leaves_nothing_staged() {
        let (dir, path) = folder();
        save(&path, &core("https://one.example.ts.net")).unwrap();
        assert_eq!(read(&path), Saved::Core(core("https://one.example.ts.net")));
        save(&path, &core("https://two.example.ts.net:8444")).unwrap();
        assert_eq!(read(&path), Saved::Core(core("https://two.example.ts.net:8444")));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"coreUrl":"https://two.example.ts.net:8444/"}"#);
        assert!(!path.with_extension("json.new").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_save_that_cannot_write_keeps_the_old_record() {
        let (dir, path) = folder();
        save(&path, &core("https://one.example.ts.net")).unwrap();
        let before = std::fs::read(&path).unwrap();
        // The staged file cannot be made: a folder is where it would go.
        std::fs::create_dir(path.with_extension("json.new")).unwrap();
        assert!(save(&path, &core("https://two.example.ts.net")).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(read(&path), Saved::Core(core("https://one.example.ts.net")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_save_whose_rename_fails_keeps_the_old_record_and_removes_what_it_staged() {
        let (dir, path) = folder();
        save(&path, &core("https://one.example.ts.net")).unwrap();
        let before = std::fs::read(&path).unwrap();
        let failed = save_with(&path, &core("https://two.example.ts.net"), |staged, _| {
            assert!(staged.is_file(), "written whole before the rename");
            Err(io::Error::other("rename refused"))
        });
        assert_eq!(failed.unwrap_err().to_string(), "rename refused");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!path.with_extension("json.new").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_save_without_a_folder_to_keep_it_in_fails_and_writes_nothing() {
        let (dir, path) = folder();
        // Where the data folder would be is a file.
        std::fs::write(path.parent().unwrap(), "").unwrap();
        assert!(save(&path, &core("https://one.example.ts.net")).is_err());
        assert!(std::fs::metadata(path.parent().unwrap()).unwrap().is_file());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_record_that_cannot_be_used_is_not_a_first_launch_and_is_kept() {
        let (dir, path) = folder();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        for (record, why) in [
            ("{\"coreUrl\":", "it is not a saved Workspace address"),
            ("{\"core\":\"https://one.example.ts.net\"}", "it is not a saved Workspace address"),
            ("{\"coreUrl\":\"http://one.example.ts.net\"}", "its address is not one this app opens"),
        ] {
            std::fs::write(&path, record).unwrap();
            assert_eq!(read(&path), Saved::Unreadable(why.into()), "{record}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), record, "reading changes nothing");
        }
        let long = format!("{{\"coreUrl\":\"https://one.example.ts.net\",\"x\":\"{}\"}}", "a".repeat(LIMIT as usize));
        std::fs::write(&path, &long).unwrap();
        assert_eq!(read(&path), Saved::Unreadable("it is not a saved Workspace address".into()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_record_that_cannot_be_read_says_so() {
        let (dir, path) = folder();
        // A folder where the record would be: opening it for reading fails.
        std::fs::create_dir_all(&path).unwrap();
        let Saved::Unreadable(why) = read(&path) else { panic!("{:?}", read(&path)) };
        assert!(why.starts_with("it could not be read ("), "{why}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_page_reads_each_answer() {
        assert_eq!(Saved::Never.to_json(), serde_json::json!({"state":"never"}));
        assert_eq!(
            Saved::Core(core("https://one.example.ts.net")).to_json(),
            serde_json::json!({"state":"saved","url":"https://one.example.ts.net/"})
        );
        assert_eq!(
            Saved::Unreadable("why".into()).to_json(),
            serde_json::json!({"state":"unreadable","reason":"why"})
        );
    }
}
