//! What a workspace page may hand to the system as a notification (T-188):
//! a title and a body, each bounded, with no control characters but the
//! body's line breaks. The page shortens its own text to these bounds; a
//! longer or odd one is refused here, not cut.

/// At most this many characters (Unicode scalar values) in a title.
pub const TITLE_MAX: usize = 120;
/// At most this many characters in a body.
pub const BODY_MAX: usize = 400;

/// The title and body as given, or why they are not handed on.
pub fn checked<'a>(title: &'a str, body: &'a str) -> Result<(&'a str, &'a str), String> {
    if title.trim().is_empty() {
        return Err("A notification needs a title.".into());
    }
    if title.chars().count() > TITLE_MAX {
        return Err(format!("A notification's title is at most {TITLE_MAX} characters."));
    }
    if body.chars().count() > BODY_MAX {
        return Err(format!("A notification's text is at most {BODY_MAX} characters."));
    }
    if title.chars().any(char::is_control) || body.chars().any(|c| c.is_control() && c != '\n') {
        return Err("A notification's title and text cannot hold control characters.".into());
    }
    Ok((title, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_and_body_within_bounds_are_handed_on_as_given() {
        assert_eq!(checked("Dev 1 needs you", "Asked:\nwhich branch?"), Ok(("Dev 1 needs you", "Asked:\nwhich branch?")));
        assert_eq!(checked("任务已完成", ""), Ok(("任务已完成", "")));
        let title = "界".repeat(TITLE_MAX);
        let body = "é".repeat(BODY_MAX);
        assert!(checked(&title, &body).is_ok(), "bounds are characters, not bytes");
    }

    #[test]
    fn an_empty_long_or_odd_one_is_refused_not_cut() {
        assert!(checked(" \n", "text").is_err());
        assert!(checked(&"a".repeat(TITLE_MAX + 1), "").is_err());
        assert!(checked("Title", &"a".repeat(BODY_MAX + 1)).is_err());
        assert!(checked("Two\nlines", "").is_err(), "a title is one line");
        assert!(checked("Title", "a\u{1b}[31mred").is_err());
        assert!(checked("Title", "a\rb").is_err());
    }
}
