//! The size a kept image is drawn at, read from its header alone (T-19
//! HM:B14), so Home can give it its shape before it loads.
//!
//! Read here, not through an image decoder: a decoder sizes what it reads by
//! what the file says, and a few bytes can say an EXIF chunk of gigabytes
//! (WebP) or an ICC profile that inflates to hundreds of megabytes (PNG).
//! This reads only the bytes Core already holds, in place: it allocates
//! nothing, every range is checked against them with checked arithmetic, it
//! inflates nothing, and it looks at no more than HEADS_BUDGET chunk or
//! segment heads and EXIF_BUDGET bytes of EXIF. Anything past those, or any
//! range past the end, gives no size; the image is kept all the same.
//!
//! A size read here says only that the header gives one: not that the rest
//! of the image is whole, or that a browser can draw it.

/// The longest side Core gives a kept image a size for.
pub(super) const IMAGE_SIDE: u32 = 65_535;
/// The most bytes of one EXIF block read for its orientation: a JPEG's
/// APP1 segment cannot be longer.
pub(super) const EXIF_BUDGET: usize = 64 * 1024;
/// The most chunk (PNG, WebP) or segment (JPEG) heads read before the
/// image data; past that, no size.
pub(super) const HEADS_BUDGET: usize = 256;

/// The size an image of `bytes` is drawn at, as wide and high, or None:
/// - for a format Core reads no size of (only PNG, JPEG and WebP are read);
/// - for a header that is not one, or a range it gives past the bytes;
/// - for a side of 0 or past IMAGE_SIDE;
/// - past a budget above, a JPEG's heads included: its size counts only once
///   its scan (or end) is reached, so no later EXIF is missed;
/// - for EXIF whose orientation cannot be read for certain: not a TIFF, cut
///   short, or an Orientation entry that is not one SHORT from 1 to 8;
/// - for a PNG or WebP whose EXIF says to turn it a quarter, which browsers
///   do not all do.
///
/// A JPEG its EXIF turns a quarter is as wide as it is stored high.
pub(super) fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let is_jpeg = bytes.starts_with(&[0xFF, 0xD8, 0xFF]);
    let (width, height, quarter) = if bytes.starts_with(PNG) {
        png(bytes)?
    } else if is_jpeg {
        jpeg(bytes)?
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        webp(bytes)?
    } else {
        return None;
    };
    if !(1..=IMAGE_SIDE).contains(&width) || !(1..=IMAGE_SIDE).contains(&height) {
        return None;
    }
    match (quarter, is_jpeg) {
        (false, _) => Some((width, height)),
        (true, true) => Some((height, width)),
        (true, false) => None,
    }
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";

/// `len` bytes from `at`, if they are all there.
fn take(bytes: &[u8], at: usize, len: usize) -> Option<&[u8]> {
    bytes.get(at..at.checked_add(len)?)
}
fn be16(bytes: &[u8], at: usize) -> Option<u16> {
    take(bytes, at, 2).map(|b| u16::from_be_bytes([b[0], b[1]]))
}
fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    take(bytes, at, 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}
fn le16(bytes: &[u8], at: usize) -> Option<u16> {
    take(bytes, at, 2).map(|b| u16::from_le_bytes([b[0], b[1]]))
}
fn le24(bytes: &[u8], at: usize) -> Option<u32> {
    take(bytes, at, 3).map(|b| u32::from_le_bytes([b[0], b[1], b[2], 0]))
}
fn le32(bytes: &[u8], at: usize) -> Option<u32> {
    take(bytes, at, 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// IHDR, which must come first, then the chunks before the image data,
/// for an eXIf. Nothing is inflated: an iCCP, a zTXt or any other chunk is
/// passed by its length.
fn png(bytes: &[u8]) -> Option<(u32, u32, bool)> {
    if be32(bytes, 8)? != 13 || take(bytes, 12, 4)? != b"IHDR" {
        return None;
    }
    let (width, height) = (be32(bytes, 16)?, be32(bytes, 20)?);
    let mut at = 8 + 12 + 13;
    for _ in 0..HEADS_BUDGET {
        let len = usize::try_from(be32(bytes, at)?).ok()?;
        let kind = take(bytes, at + 4, 4)?;
        let data = take(bytes, at + 8, len)?;
        take(bytes, at + 8 + len, 4)?;
        match kind {
            b"IDAT" | b"IEND" => return Some((width, height, false)),
            b"eXIf" => return Some((width, height, quarter(budgeted(data)?)?)),
            _ => at += 12 + len,
        }
    }
    None
}

/// The segments before the scan: the frame's size (SOF) and the first
/// APP1 Exif's orientation. Only a scan (or the end) reached within the
/// budget makes them the image's: past it, a later EXIF may say otherwise.
fn jpeg(bytes: &[u8]) -> Option<(u32, u32, bool)> {
    let mut at = 2;
    let (mut size, mut turned, mut exif, mut reached) = (None, false, false, false);
    for _ in 0..HEADS_BUDGET {
        if *bytes.get(at)? != 0xFF {
            return None;
        }
        // A marker may follow any number of fill bytes.
        while *bytes.get(at + 1)? == 0xFF {
            at += 1;
        }
        let marker = bytes[at + 1];
        at += 2;
        match marker {
            0x01 | 0xD0..=0xD8 => continue,
            0xD9 | 0xDA => {
                reached = true;
                break;
            }
            _ => {}
        }
        let len = usize::from(be16(bytes, at)?);
        let segment = take(bytes, at + 2, len.checked_sub(2)?)?;
        match marker {
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                size = Some((u32::from(be16(segment, 3)?), u32::from(be16(segment, 1)?)));
            }
            0xE1 if !exif && segment.starts_with(b"Exif\0\0") => {
                exif = true;
                turned = quarter(&segment[6..])?;
            }
            _ => {}
        }
        at += len;
    }
    if !reached {
        return None;
    }
    let (width, height) = size?;
    Some((width, height, turned))
}

/// The first chunk: VP8, VP8L, or VP8X and then its chunks, for an image
/// one and, if VP8X says there is one, the EXIF.
fn webp(bytes: &[u8]) -> Option<(u32, u32, bool)> {
    // The RIFF's own extent, as far as the bytes go.
    let end = bytes.len().min(usize::try_from(le32(bytes, 4)?).ok()?.checked_add(8)?);
    let bytes = &bytes[..end];
    let (kind, data, mut at) = riff_chunk(bytes, 12)?;
    match kind {
        b"VP8 " => {
            // A key frame's tag, then its start code and size.
            if data.first()? & 1 != 0 || take(data, 3, 3)? != [0x9D, 0x01, 0x2A] {
                return None;
            }
            Some((u32::from(le16(data, 6)? & 0x3FFF), u32::from(le16(data, 8)? & 0x3FFF), false))
        }
        b"VP8L" => {
            if *data.first()? != 0x2F {
                return None;
            }
            let bits = le32(data, 1)?;
            Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1, false))
        }
        b"VP8X" => {
            let says_exif = data.first()? & 0x08 != 0;
            let (width, height) = (le24(data, 4)? + 1, le24(data, 7)? + 1);
            let (mut image, mut exif) = (false, None);
            for _ in 0..HEADS_BUDGET {
                if at >= bytes.len() {
                    break;
                }
                let (kind, data, next) = riff_chunk(bytes, at)?;
                match kind {
                    b"VP8 " | b"VP8L" | b"ANMF" => image = true,
                    b"EXIF" if exif.is_none() => exif = Some(data),
                    _ => {}
                }
                at = next;
            }
            if !image || at < bytes.len() || (says_exif && exif.is_none()) {
                return None;
            }
            let turned = match exif {
                Some(data) => quarter(budgeted(data)?)?,
                None => false,
            };
            Some((width, height, turned))
        }
        _ => None,
    }
}

/// The RIFF chunk at `at`: its kind, its data, and where the next starts
/// (after a pad byte, for odd data). None if its data runs past the bytes.
fn riff_chunk(bytes: &[u8], at: usize) -> Option<(&[u8], &[u8], usize)> {
    let len = usize::try_from(le32(bytes, at.checked_add(4)?)?).ok()?;
    let data = take(bytes, at + 8, len)?;
    Some((take(bytes, at, 4)?, data, at + 8 + len + (len & 1)))
}

/// An EXIF block, if it is within EXIF_BUDGET.
fn budgeted(exif: &[u8]) -> Option<&[u8]> {
    (exif.len() <= EXIF_BUDGET).then_some(exif)
}

/// Whether EXIF `exif` (a TIFF, after an `Exif\0\0` some writers put first)
/// says to turn the image a quarter (orientation 5 to 8: Some(true)) or not
/// (1 to 4, or no Orientation entry: Some(false)). None when that cannot be
/// read for certain: not a TIFF, IFD0 inside its header or its entries past
/// the end, or an Orientation entry that is not one SHORT from 1 to 8.
fn quarter(exif: &[u8]) -> Option<bool> {
    let tiff = exif.strip_prefix(b"Exif\0\0").unwrap_or(exif);
    let big = match take(tiff, 0, 4)? {
        b"MM\0*" => true,
        b"II*\0" => false,
        _ => return None,
    };
    let u16_at = |at: usize| if big { be16(tiff, at) } else { le16(tiff, at) };
    let u32_at = |at: usize| if big { be32(tiff, at) } else { le32(tiff, at) };
    let ifd = usize::try_from(u32_at(4)?).ok()?;
    if ifd < 8 {
        return None;
    }
    let count = usize::from(u16_at(ifd)?);
    // Every entry of IFD0 is there.
    take(tiff, ifd.checked_add(2)?, count.checked_mul(12)?)?;
    for entry in 0..count {
        let at = ifd + 2 + entry * 12;
        if u16_at(at)? == 0x0112 {
            let value = u16_at(at + 8)?;
            if u16_at(at + 2)? != 3 || u32_at(at + 4)? != 1 || !(1..=8).contains(&value) {
                return None;
            }
            return Some(value >= 5);
        }
    }
    Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(format: image::ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(vec![]);
        image::RgbImage::from_pixel(width, height, image::Rgb([90, 130, 170])).write_to(&mut bytes, format).unwrap();
        bytes.into_inner()
    }
    /// A TIFF with one entry, orientation `value`, big- or little-endian.
    fn tiff(value: u16, big: bool) -> Vec<u8> {
        let (u16b, u32b): (fn(u16) -> [u8; 2], fn(u32) -> [u8; 4]) =
            if big { (u16::to_be_bytes, u32::to_be_bytes) } else { (u16::to_le_bytes, u32::to_le_bytes) };
        let mut out = if big { b"MM\0*".to_vec() } else { b"II*\0".to_vec() };
        out.extend(u32b(8));
        out.extend(u16b(1));
        out.extend(u16b(0x0112));
        out.extend(u16b(3));
        out.extend(u32b(1));
        out.extend(u16b(value));
        out.extend([0, 0]);
        out.extend(u32b(0));
        out
    }
    fn png_chunk(kind: &[u8], data: &[u8]) -> Vec<u8> {
        let mut out = u32::try_from(data.len()).unwrap().to_be_bytes().to_vec();
        out.extend(kind);
        out.extend(data);
        out.extend([0; 4]);
        out
    }
    /// `png` with `chunk` after its IHDR.
    fn after_ihdr(png: &[u8], chunk: &[u8]) -> Vec<u8> {
        [&png[..33], chunk, &png[33..]].concat()
    }
    fn riff(chunks: &[Vec<u8>]) -> Vec<u8> {
        let body: Vec<u8> = [b"WEBP".to_vec(), chunks.concat()].concat();
        [b"RIFF".to_vec(), u32::try_from(body.len()).unwrap().to_le_bytes().to_vec(), body].concat()
    }
    fn webp_chunk(kind: &[u8], declared: u32, data: &[u8]) -> Vec<u8> {
        let mut out = kind.to_vec();
        out.extend(declared.to_le_bytes());
        out.extend(data);
        if data.len() % 2 == 1 && usize::try_from(declared).unwrap() == data.len() {
            out.push(0);
        }
        out
    }
    fn sized(kind: &[u8], data: &[u8]) -> Vec<u8> {
        webp_chunk(kind, u32::try_from(data.len()).unwrap(), data)
    }
    /// A VP8X header for a `width` x `height` canvas, `flags` as given.
    fn vp8x(flags: u8, width: u32, height: u32) -> Vec<u8> {
        let mut data = vec![flags, 0, 0, 0];
        data.extend(&(width - 1).to_le_bytes()[..3]);
        data.extend(&(height - 1).to_le_bytes()[..3]);
        sized(b"VP8X", &data)
    }
    /// The VP8L chunk of a lossless WebP the image crate writes, `width` x `height`.
    fn vp8l(width: u32, height: u32) -> Vec<u8> {
        picture(image::ImageFormat::WebP, width, height)[12..].to_vec()
    }

    #[test]
    fn png_jpeg_and_webp_sizes_are_read_from_their_headers() {
        assert_eq!(image_size(&picture(image::ImageFormat::Png, 40, 20)), Some((40, 20)));
        assert_eq!(image_size(&picture(image::ImageFormat::Jpeg, 40, 20)), Some((40, 20)));
        let lossless = picture(image::ImageFormat::WebP, 40, 20);
        assert_eq!(image_size(&lossless), Some((40, 20)));
        assert_eq!(image_size(&riff(&[vp8x(0, 40, 20), vp8l(40, 20)])), Some((40, 20)));
        // A lossy key frame's header: tag, start code, 14-bit sides.
        let mut lossy = vec![0x50, 0x02, 0x00, 0x9D, 0x01, 0x2A];
        lossy.extend(30u16.to_le_bytes());
        lossy.extend(12u16.to_le_bytes());
        assert_eq!(image_size(&riff(&[sized(b"VP8 ", &lossy)])), Some((30, 12)));
        // Not one of them, or not a header.
        assert_eq!(image_size(b"GIF89a\x10\x00\x10\x00\x00\x00\x00;"), None);
        assert_eq!(image_size(b"\x89PNG\r\n\x1a\nnot a picture"), None);
        assert_eq!(image_size(&picture(image::ImageFormat::Png, 1, 70_000)), None);
    }

    #[test]
    fn exif_turns_a_jpeg_and_withholds_a_turned_png_or_webp() {
        let jpeg = picture(image::ImageFormat::Jpeg, 40, 20);
        let with_exif = |value: u16, big: bool| {
            let exif = [b"Exif\0\0".to_vec(), tiff(value, big)].concat();
            let mut app1 = vec![0xFF, 0xE1];
            app1.extend(u16::try_from(exif.len() + 2).unwrap().to_be_bytes());
            app1.extend(exif);
            [&jpeg[..2], &app1, &jpeg[2..]].concat()
        };
        assert_eq!(image_size(&with_exif(6, true)), Some((20, 40)));
        assert_eq!(image_size(&with_exif(8, false)), Some((20, 40)));
        assert_eq!(image_size(&with_exif(1, true)), Some((40, 20)));
        assert_eq!(image_size(&with_exif(3, false)), Some((40, 20)));
        let png = picture(image::ImageFormat::Png, 40, 20);
        assert_eq!(image_size(&after_ihdr(&png, &png_chunk(b"eXIf", &tiff(6, true)))), None);
        assert_eq!(image_size(&after_ihdr(&png, &png_chunk(b"eXIf", &tiff(1, true)))), Some((40, 20)));
        let webp = |value: u16| riff(&[vp8x(0x08, 40, 20), vp8l(40, 20), sized(b"EXIF", &tiff(value, false))]);
        assert_eq!(image_size(&webp(6)), None);
        assert_eq!(image_size(&webp(1)), Some((40, 20)));
    }

    /// A TIFF whose IFD0 holds `entries`, each (tag, type, count, value as
    /// it is stored in the entry's last four bytes), big-endian.
    fn tiff_of(entries: &[(u16, u16, u32, [u8; 4])]) -> Vec<u8> {
        let mut out = b"MM\0*".to_vec();
        out.extend(8u32.to_be_bytes());
        out.extend(u16::try_from(entries.len()).unwrap().to_be_bytes());
        for (tag, kind, count, value) in entries {
            out.extend(tag.to_be_bytes());
            out.extend(kind.to_be_bytes());
            out.extend(count.to_be_bytes());
            out.extend(value);
        }
        out.extend(0u32.to_be_bytes());
        out
    }
    /// A 40 x 20 JPEG with `exif` in an APP1 segment, after its SOI.
    fn jpeg_with(exif: &[u8]) -> Vec<u8> {
        let jpeg = picture(image::ImageFormat::Jpeg, 40, 20);
        let body = [b"Exif\0\0".as_slice(), exif].concat();
        let mut app1 = vec![0xFF, 0xE1];
        app1.extend(u16::try_from(body.len() + 2).unwrap().to_be_bytes());
        app1.extend(body);
        [&jpeg[..2], &app1, &jpeg[2..]].concat()
    }
    /// An APP segment of `marker` with `len` bytes of data.
    fn app(marker: u8, len: usize) -> Vec<u8> {
        let mut out = vec![0xFF, marker];
        out.extend(u16::try_from(len + 2).unwrap().to_be_bytes());
        out.extend(vec![0; len]);
        out
    }

    #[test]
    fn a_jpeg_whose_heads_run_out_before_its_scan_gives_no_size() {
        // Its SOF read, then more segments than the budget before the scan.
        let jpeg = picture(image::ImageFormat::Jpeg, 40, 20);
        let sof = jpeg.windows(2).position(|w| w == [0xFF, 0xC0]).unwrap();
        let many: Vec<u8> = (0..HEADS_BUDGET).flat_map(|_| app(0xE2, 4)).collect();
        let late = [&jpeg[..sof], &jpeg[sof..sof + 2 + 17], &many[..], &jpeg[sof + 2 + 17..]].concat();
        assert_eq!(image_size(&late), None);
    }

    #[test]
    fn a_jpeg_exif_after_many_heads_within_the_budget_still_turns_it() {
        let jpeg = jpeg_with(&tiff(6, true));
        let many: Vec<u8> = (0..HEADS_BUDGET - 20).flat_map(|_| app(0xE2, 4)).collect();
        assert_eq!(image_size(&[&jpeg[..2], &many[..], &jpeg[2..]].concat()), Some((20, 40)));
    }

    #[test]
    fn an_orientation_entry_of_the_wrong_count_or_type_gives_no_size() {
        // Two SHORTs, value 6 first; one LONG of 6.
        assert_eq!(image_size(&jpeg_with(&tiff_of(&[(0x0112, 3, 2, [0, 6, 0, 6])]))), None);
        assert_eq!(image_size(&jpeg_with(&tiff_of(&[(0x0112, 4, 1, [0, 0, 0, 6])]))), None);
    }

    #[test]
    fn an_orientation_value_out_of_range_gives_no_size() {
        assert_eq!(image_size(&jpeg_with(&tiff_of(&[(0x0112, 3, 1, [0, 0, 0, 0])]))), None);
        assert_eq!(image_size(&jpeg_with(&tiff_of(&[(0x0112, 3, 1, [0, 9, 0, 0])]))), None);
    }

    #[test]
    fn a_cut_or_unreadable_tiff_gives_no_size() {
        // IFD0 says three entries; one is there.
        let mut cut = tiff_of(&[(0x010F, 2, 4, *b"Cam\0")]);
        cut[9] = 3;
        assert_eq!(image_size(&jpeg_with(&cut)), None);
        // Not a TIFF, in a JPEG, a PNG and a WebP.
        assert_eq!(image_size(&jpeg_with(b"no tiff here")), None);
        let png = picture(image::ImageFormat::Png, 40, 20);
        assert_eq!(image_size(&after_ihdr(&png, &png_chunk(b"eXIf", b"no tiff here"))), None);
        assert_eq!(image_size(&riff(&[vp8x(0x08, 40, 20), vp8l(40, 20), sized(b"EXIF", b"no tiff here")])), None);
    }

    #[test]
    fn exif_without_an_orientation_keeps_the_size() {
        let make = tiff_of(&[(0x010F, 2, 4, *b"Cam\0")]);
        assert_eq!(image_size(&jpeg_with(&make)), Some((40, 20)));
        let png = picture(image::ImageFormat::Png, 40, 20);
        assert_eq!(image_size(&after_ihdr(&png, &png_chunk(b"eXIf", &make))), Some((40, 20)));
    }

    #[test]
    fn a_range_past_the_bytes_or_past_a_budget_gives_no_size() {
        // A WebP EXIF chunk that says it is 4 GiB long, in a file of a few hundred bytes.
        let declared = riff(&[vp8x(0x08, 40, 20), vp8l(40, 20), webp_chunk(b"EXIF", 0xFFFF_FFF0, &tiff(1, false))]);
        assert_eq!(image_size(&declared), None);
        // Cut short: the EXIF chunk says 1,000 bytes, ten are there.
        let short = riff(&[vp8x(0x08, 40, 20), vp8l(40, 20), webp_chunk(b"EXIF", 1_000, &[0; 10])]);
        assert_eq!(image_size(&short), None);
        // VP8X says there is EXIF and there is none; or there is no image chunk.
        assert_eq!(image_size(&riff(&[vp8x(0x08, 40, 20), vp8l(40, 20)])), None);
        assert_eq!(image_size(&riff(&[vp8x(0, 40, 20)])), None);
        // EXIF there, but past the budget.
        let mut long = tiff(1, false);
        long.resize(EXIF_BUDGET + 1, 0);
        assert_eq!(image_size(&riff(&[vp8x(0x08, 40, 20), vp8l(40, 20), sized(b"EXIF", &long)])), None);
        let png = picture(image::ImageFormat::Png, 40, 20);
        assert_eq!(image_size(&after_ihdr(&png, &png_chunk(b"eXIf", &long))), None);
        // A PNG chunk that says it runs past the end, before the image data.
        let mut past = 0xFFFF_FFF0u32.to_be_bytes().to_vec();
        past.extend(b"iCCP");
        assert_eq!(image_size(&[&png[..33], &past[..], &[0u8; 16][..]].concat()), None);
        // More chunk heads than the budget before the image data.
        let many: Vec<u8> = (0..HEADS_BUDGET).flat_map(|_| png_chunk(b"tEXt", b"k\0v")).collect();
        assert_eq!(image_size(&after_ihdr(&png, &many)), None);
        // A JPEG segment cut short.
        let jpeg = picture(image::ImageFormat::Jpeg, 40, 20);
        assert_eq!(image_size(&jpeg[..40]), None);
    }

    #[test]
    fn a_png_is_sized_without_inflating_its_icc_profile_or_text() {
        // An iCCP whose compressed profile is not even inflatable, and a zTXt.
        let png = picture(image::ImageFormat::Png, 40, 20);
        let iccp = png_chunk(b"iCCP", b"profile\0\0\x78\x9c not deflate");
        let ztxt = png_chunk(b"zTXt", b"Comment\0\0\x78\x9c also not");
        assert_eq!(image_size(&after_ihdr(&png, &[iccp, ztxt].concat())), Some((40, 20)));
    }
}
