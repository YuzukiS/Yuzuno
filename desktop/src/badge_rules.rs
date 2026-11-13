//! What the badge shows for Home's "needs you" count (YN-43, YN-94), with
//! no dependencies, so CI checks it without building a desktop app (as
//! `health.rs`). `badge.rs` puts it on the Windows taskbar and the macOS
//! dock.
//!
//! The pictures are the ones the user approved (YN-43 S0): a soft speech
//! bubble whose tail points up-left at the character, drawn for the small
//! icon size at 100/125/150/200% (16, 20, 24 and 32 px), showing 1–9 and
//! then 9+. Nothing is drawn at run time. macOS uses no picture: the system
//! draws its own red number, whose words `dock_label` gives.

/// The largest count the desktop accepts from the page. Home never has this
/// many; anything above it, below 0 or not a whole number is refused.
pub const MAX_COUNT: i64 = 100_000;

/// The sizes the bubble is drawn at: the small icon size at 100, 125, 150
/// and 200% display scaling.
pub const SIZES: [u32; 4] = [16, 20, 24, 32];

/// What the bubble says: one digit, or "9+" for ten and more.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Label {
    Digit(u8),
    NinePlus,
}

/// The language of the overlay's text for screen readers: the page's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    En,
    Zh,
}

/// A count the page sent, if it is one the desktop accepts.
pub fn checked(count: i64) -> Result<u32, String> {
    if (0..=MAX_COUNT).contains(&count) {
        Ok(count as u32)
    } else {
        Err(format!("The badge count must be a whole number from 0 to {MAX_COUNT}."))
    }
}

/// The page's language name, if it is one this app has words for.
pub fn lang(name: &str) -> Result<Lang, String> {
    match name {
        "en" => Ok(Lang::En),
        "zh" => Ok(Lang::Zh),
        _ => Err("The badge language must be \"en\" or \"zh\".".into()),
    }
}

/// The bubble for a count; none at 0.
pub fn label(count: u32) -> Option<Label> {
    match count {
        0 => None,
        1..=9 => Some(Label::Digit(count as u8)),
        _ => Some(Label::NinePlus),
    }
}

/// What the macOS dock badge says: the same words as the bubble, 1–9 and
/// then 9+; none at 0. The system draws them as its own red number, so this
/// is the whole of the dock badge, with no picture of ours.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn dock_label(count: u32) -> Option<String> {
    label(count).map(|label| match label {
        Label::Digit(digit) => digit.to_string(),
        Label::NinePlus => "9+".to_string(),
    })
}

/// Which drawn size to use at a display scale (1.0 = 100%): the small icon
/// size there, 16 × scale, or the nearest size drawn (the larger one on a
/// tie). Windows scales it to its own size when none matches, as at 175%.
pub fn size_for_scale(scale: f64) -> u32 {
    if !scale.is_finite() || scale <= 0.0 {
        return SIZES[0];
    }
    let want = 16.0 * scale;
    let mut best = SIZES[0];
    for size in SIZES {
        // Later (larger) sizes win ties.
        if (size as f64 - want).abs() <= (best as f64 - want).abs() {
            best = size;
        }
    }
    best
}

/// What the overlay says to screen readers, with the exact count even when
/// the bubble shows 9+.
pub fn alt_text(count: u32, lang: Lang) -> String {
    match (lang, count) {
        (Lang::En, 1) => "1 item needs you".into(),
        (Lang::En, n) => format!("{n} items need you"),
        (Lang::Zh, n) => format!("{n} 项需要你处理"),
    }
}

/// The approved picture for a label at a size, as PNG bytes.
pub fn asset(label: Label, size: u32) -> Option<&'static [u8]> {
    let row = SIZES.iter().position(|&s| s == size)?;
    let column = match label {
        Label::Digit(d @ 1..=9) => d as usize - 1,
        Label::Digit(_) => return None,
        Label::NinePlus => 9,
    };
    Some(ASSETS[row][column])
}

macro_rules! row {
    ($size:literal) => {
        [
            include_bytes!(concat!("../icons/badge/badge-", $size, "-1.png")).as_slice(),
            include_bytes!(concat!("../icons/badge/badge-", $size, "-2.png")).as_slice(),
            include_bytes!(concat!("../icons/badge/badge-", $size, "-3.png")).as_slice(),
            include_bytes!(concat!("../icons/badge/badge-", $size, "-4.png")).as_slice(),
            include_bytes!(concat!("../icons/badge/badge-", $size, "-5.png")).as_slice(),
            include_bytes!(concat!("../icons/badge/badge-", $size, "-6.png")).as_slice(),
            include_bytes!(concat!("../icons/badge/badge-", $size, "-7.png")).as_slice(),
            include_bytes!(concat!("../icons/badge/badge-", $size, "-8.png")).as_slice(),
            include_bytes!(concat!("../icons/badge/badge-", $size, "-9.png")).as_slice(),
            include_bytes!(concat!("../icons/badge/badge-", $size, "-9plus.png")).as_slice(),
        ]
    };
}

/// Per size, the pictures for 1–9 and then 9+.
static ASSETS: [[&[u8]; 10]; 4] = [row!("16"), row!("20"), row!("24"), row!("32")];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_from_the_page_are_whole_numbers_in_range() {
        assert_eq!(checked(0), Ok(0));
        assert_eq!(checked(7), Ok(7));
        assert_eq!(checked(MAX_COUNT), Ok(MAX_COUNT as u32));
        for refused in [-1, MAX_COUNT + 1, i64::MIN, i64::MAX] {
            assert!(checked(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn only_known_languages_are_taken() {
        assert_eq!(lang("en"), Ok(Lang::En));
        assert_eq!(lang("zh"), Ok(Lang::Zh));
        for refused in ["", "EN", "zh-Hans", "fr", "en "] {
            assert!(lang(refused).is_err(), "{refused:?}");
        }
    }

    #[test]
    fn zero_shows_nothing_one_to_nine_a_digit_and_more_nine_plus() {
        assert_eq!(label(0), None);
        for n in 1..=9u32 {
            assert_eq!(label(n), Some(Label::Digit(n as u8)));
        }
        for n in [10, 12, 100, MAX_COUNT as u32] {
            assert_eq!(label(n), Some(Label::NinePlus), "{n}");
        }
    }

    #[test]
    fn the_dock_shows_a_digit_one_to_nine_and_nine_plus_above() {
        assert_eq!(dock_label(0), None);
        assert_eq!(dock_label(1).as_deref(), Some("1"));
        assert_eq!(dock_label(9).as_deref(), Some("9"));
        assert_eq!(dock_label(10).as_deref(), Some("9+"));
        assert_eq!(dock_label(MAX_COUNT as u32).as_deref(), Some("9+"));
    }

    #[test]
    fn the_size_follows_the_display_scale() {
        for (scale, size) in [(1.0, 16), (1.25, 20), (1.5, 24), (2.0, 32)] {
            assert_eq!(size_for_scale(scale), size, "{scale}");
        }
        // Between drawn sizes: the nearest, the larger on a tie; Windows
        // scales it the rest of the way.
        assert_eq!(size_for_scale(1.1), 16);
        assert_eq!(size_for_scale(1.125), 20);
        assert_eq!(size_for_scale(1.75), 32);
        // Beyond them: the largest or the smallest; nonsense: 100%.
        assert_eq!(size_for_scale(3.0), 32);
        assert_eq!(size_for_scale(0.5), 16);
        for nonsense in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(size_for_scale(nonsense), 16, "{nonsense}");
        }
    }

    #[test]
    fn screen_readers_hear_the_exact_count() {
        assert_eq!(alt_text(1, Lang::En), "1 item needs you");
        assert_eq!(alt_text(3, Lang::En), "3 items need you");
        assert_eq!(alt_text(12, Lang::En), "12 items need you");
        assert_eq!(alt_text(1, Lang::Zh), "1 项需要你处理");
        assert_eq!(alt_text(12, Lang::Zh), "12 项需要你处理");
    }

    /// Width and height from a PNG's IHDR chunk.
    fn png_size(bytes: &[u8]) -> (u32, u32) {
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "a PNG");
        assert_eq!(&bytes[12..16], b"IHDR");
        let word = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap());
        (word(16), word(20))
    }

    #[test]
    fn every_label_has_its_approved_picture_at_every_size() {
        let labels = (1..=9).map(Label::Digit).chain([Label::NinePlus]);
        for size in SIZES {
            for label in labels.clone() {
                let bytes = asset(label, size).unwrap_or_else(|| panic!("{label:?} at {size}"));
                assert_eq!(png_size(bytes), (size, size), "{label:?} at {size}");
            }
        }
        // Each picture is its own: no two labels or sizes share bytes.
        let all: Vec<&[u8]> = ASSETS.iter().flatten().copied().collect();
        for (i, a) in all.iter().enumerate() {
            assert!(all[i + 1..].iter().all(|b| b != a), "picture {i} repeats");
        }
        assert_eq!(asset(Label::Digit(0), 16), None);
        assert_eq!(asset(Label::Digit(10), 16), None);
        assert_eq!(asset(Label::Digit(1), 18), None);
    }
}
