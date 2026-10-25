//! This app's version, for the pages its window opens (T-191): the window
//! script that gives it to them as a read-only value (app_version.js).

/// The window's script with `version`, the version this app was built as,
/// put in as one JSON string. It defines a value and calls nothing of this
/// app's: a Core's pages are granted nothing by it.
pub fn script(version: &str) -> String {
    let quoted = serde_json::to_string(version).expect("a string is always JSON");
    include_str!("app_version.js").replacen("\"__YUZUNO_APP_VERSION__\"", &quoted, 1)
}

#[cfg(test)]
mod tests {
    use super::script;

    #[test]
    fn the_version_is_put_in_once_as_a_json_string() {
        assert_eq!(include_str!("app_version.js").matches("\"__YUZUNO_APP_VERSION__\"").count(), 1);
        let made = script("0.1.0");
        assert!(made.contains("const version = \"0.1.0\";"), "{made}");
        assert!(!made.contains("__YUZUNO_APP_VERSION__"), "{made}");
        // Whatever a version holds, it stays one string.
        let odd = script("1\";alert(1)//");
        assert!(odd.contains(r#"const version = "1\";alert(1)//";"#), "{odd}");
    }
}
