//! Codex and Claude input images. Opaque, agent-scoped immutable files; no caller paths.
//! The existing browser boundary protects these routes. Images never enter SQLite,
//! SSE or draft JSON. Upload decoding and reads run off the async workers.
use crate::{model::Agent, workspace::Workspace};
use anyhow::{ensure, Context, Result};
use axum::{
    body::to_bytes,
    extract::{Path, Query, Request, State},
    http::header,
    response::{IntoResponse, Response},
    Json,
};
use image::{ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Write},
    path::{Path as FsPath, PathBuf},
    sync::{Arc, OnceLock},
};
use tokio::sync::Semaphore;
use tower::ServiceExt;

pub const MAX_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_IMAGES: usize = 8;
const MAX_TOTAL: u64 = 40 * 1024 * 1024;
// Serialize uploads before buffering or decoding, bounding concurrent memory and quota races.
static UPLOAD: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedImage {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
}

pub fn supported(agent: &Agent) -> Result<()> {
    ensure!(matches!(agent.harness.as_str(), "codex" | "claude"),
        "Images are supported by Codex and Claude Agents.");
    Ok(())
}
fn safe_agent(agent: &str) -> Result<()> {
    ensure!(
        !agent.is_empty()
            && agent.len() <= 100
            && agent
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-'),
        "Invalid image owner"
    );
    Ok(())
}
pub fn image_path(root: &FsPath, agent: &str, id: &str) -> Result<PathBuf> {
    safe_agent(agent)?;
    let (hash, ext) = id.split_once('.').context("Invalid image reference")?;
    ensure!(
        hash.len() == 64
            && hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            && ["png", "jpg", "webp"].contains(&ext),
        "Invalid image reference"
    );
    Ok(root.join("input-images").join(agent).join(id))
}
fn bounded_read(path: &FsPath, max: usize) -> Result<Vec<u8>> {
    use std::io::Read;
    let meta =
        std::fs::symlink_metadata(path).context("Saved image is missing; attach it again")?;
    ensure!(
        meta.is_file() && meta.len() <= max as u64,
        "Invalid or oversized saved image"
    );
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    std::fs::File::open(path)?
        .take((max + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= max, "Saved image exceeds 10 MiB");
    Ok(bytes)
}
fn save_new(path: &FsPath, bytes: &[u8]) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist_noclobber(path)?;
    Ok(())
}
fn upload(root: &FsPath, agent: &str, bytes: &[u8]) -> Result<UploadedImage> {
    safe_agent(agent)?;
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_BYTES,
        "Each image must be between 1 byte and 10 MiB"
    );
    let format = image::guess_format(bytes).context("Choose a valid PNG, JPEG or WebP image")?;
    let ext = match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpg",
        ImageFormat::WebP => "webp",
        _ => anyhow::bail!("Only PNG, JPEG and WebP images are supported"),
    };
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits.clone());
    let (width, height) = reader
        .into_dimensions()
        .context("Cannot read image dimensions (maximum 8192 px per side)")?;
    ensure!(
        width > 0
            && height > 0
            && width <= 8192
            && height <= 8192
            && u64::from(width) * u64::from(height) <= 24_000_000,
        "Images must be at most 8192 px per side and 24 megapixels"
    );
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let image = reader
        .decode()
        .context("Image is damaged or exceeds the decoding memory limit")?;
    let id = format!("{:x}.{ext}", Sha256::digest(bytes));
    let path = image_path(root, agent, &id)?;
    std::fs::create_dir_all(path.parent().unwrap())?;
    if !path.exists() {
        let used: u64 = std::fs::read_dir(path.parent().unwrap())?
            .filter_map(|e| e.ok())
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum();
        ensure!(
            used + bytes.len() as u64 + 1024 * 1024 <= 256 * 1024 * 1024,
            "This Agent's saved images reached the 256 MiB limit"
        );
    }
    let mut thumb = Cursor::new(Vec::new());
    image
        .thumbnail(width.min(320), height.min(320))
        .write_to(&mut thumb, ImageFormat::Png)?;
    ensure!(
        thumb.get_ref().len() <= 1024 * 1024,
        "Image thumbnail is too large"
    );
    save_new(
        &path.with_file_name(format!("{id}.thumb.png")),
        thumb.get_ref(),
    )?;
    save_new(&path, bytes)?;
    Ok(UploadedImage {
        id,
        width,
        height,
        bytes: bytes.len(),
    })
}

pub async fn upload_route(
    State(ws): State<Arc<Workspace>>,
    Path(agent): Path<String>,
    request: Request,
) -> Result<Json<UploadedImage>, crate::server::ApiError> {
    let _permit = ws.admission.enter_work()?;
    let owner = agent.clone();
    let info = ws.stored(move |store| store.agent(&owner)).await?;
    crate::model::ensure_agent_open(&info)?;
    supported(&info)?;
    let slot = UPLOAD
        .get_or_init(|| Arc::new(Semaphore::new(1)))
        .clone()
        .try_acquire_owned()
        .context("Another image is being saved. Try again shortly")?;
    let bytes = to_bytes(request.into_body(), MAX_BYTES)
        .await
        .context("Image exceeds the 10 MiB upload limit")?;
    let root = ws.data_dir.clone();
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            upload(&root, &agent, &bytes)
        })
        .await??,
    ))
}
#[derive(Deserialize)]
pub struct ImageQuery {
    #[serde(default)]
    thumb: bool,
}
pub async fn read_route(
    State(ws): State<Arc<Workspace>>,
    Path((agent, id)): Path<(String, String)>,
    Query(query): Query<ImageQuery>,
    request: Request,
) -> Result<Response, crate::server::ApiError> {
    let owner = agent.clone();
    ws.stored(move |store| store.agent(&owner)).await?; // Same live/archived Agent access boundary as other payloads.
    let path = image_path(&ws.data_dir, &agent, &id)?;
    let mime = if query.thumb || id.ends_with(".png") {
        "image/png"
    } else if id.ends_with(".jpg") {
        "image/jpeg"
    } else {
        "image/webp"
    };
    let path = if query.thumb {
        path.with_file_name(format!("{id}.thumb.png"))
    } else {
        path
    };
    let meta = tokio::fs::symlink_metadata(&path)
        .await
        .context("Saved image is missing; attach it again")?;
    if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
        return Err(anyhow::anyhow!("Invalid or oversized saved image").into());
    }
    // Stream originals rather than allocating one full image for every open preview.
    let mut response = tower_http::services::ServeFile::new(path)
        .oneshot(request)
        .await?
        .into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, mime.parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok(response)
}

/// Checks a message's images, one at a time: this Agent's own, unchanged
/// since upload, and within the per-message count and total.
fn each_owned(
    root: &FsPath,
    agent: &str,
    images: &[String],
    mut use_image: impl FnMut(&str, &FsPath, &[u8]) -> Result<()>,
) -> Result<()> {
    ensure!(
        images.len() <= MAX_IMAGES,
        "Attach at most 8 images per message"
    );
    let mut total = 0;
    let mut unique = std::collections::HashSet::new();
    for id in images {
        ensure!(unique.insert(id), "Duplicate image reference");
        let path = image_path(root, agent, id)?;
        let bytes = bounded_read(&path, MAX_BYTES)?;
        total += bytes.len() as u64;
        ensure!(
            total <= MAX_TOTAL,
            "Images in one message must total at most 40 MiB"
        );
        ensure!(
            id.starts_with(&format!("{:x}.", Sha256::digest(&bytes))),
            "Saved image changed; attach it again"
        );
        use_image(id, &path, &bytes)?;
    }
    Ok(())
}

pub fn native_input(root: &FsPath, agent: &str, text: &str, images: &[String]) -> Result<Value> {
    let mut items = vec![];
    if !text.is_empty() {
        items.push(json!({"type":"text", "text":text}));
    }
    each_owned(root, agent, images, |_, path, _| {
        items.push(json!({"type":"localImage", "path":path.canonicalize()?}));
        Ok(())
    })?;
    Ok(Value::Array(items))
}

/// Validated bytes, buffered only under the remote transfer admission slot.
/// Originals remain in Core; Claude sends the existing bounded fitted copy.
pub(crate) fn remote_copies(root: &FsPath, agent: &str, images: &[String], claude: bool) -> Result<Vec<crate::remote_images::Image>> {
    let mut copies = vec![];
    each_owned(root, agent, images, |id, path, bytes| {
        let data = if claude { bounded_read(&claude_fit(path, id, bytes)?, CLAUDE_MAX_BYTES)? }
            else { bytes.to_vec() };
        copies.push(crate::remote_images::Image::new(id, data)?);
        Ok(())
    })?;
    Ok(copies)
}

/// Yuzuno's budget for an image sent to Claude, kept apart from the limits
/// it rests on:
/// - The Claude API (vision docs, 2026-10-15), used directly, takes up to
///   10 MB base64 per image (5 MB on Amazon Bedrock and Google Cloud) and
///   8000 px a side, but only 2000 px once a request has more than 20
///   images, and 32 MB per request, which includes the resent history.
/// - The installed CLI (2.1.280) scales an image in a new prompt to at most
///   2000 px and recompresses it above 512,000 bytes. A message folded into
///   a running turn keeps its images as sent. Before every request, each
///   image in the conversation must be within its 5 MiB base64 default.
/// - This budget follows the CLI's new-prompt sizes and applies to every
///   Claude message, so a follow-up is sized like a new turn and history
///   stays far inside the API limits. It is Yuzuno's verified choice, not an
///   API limit, and its bytes need not match what the CLI would make.
///
/// An image over it is sent as a copy made once beside the original
/// (`<id>.claude.png` or `.jpg`); the conversation shows the original.
const CLAUDE_MAX_SIDE: u32 = 2000;
pub const CLAUDE_MAX_BYTES: usize = 512_000;
// One fitting decode at a time, bounding memory across Agents.
static FITTING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A message's images as Claude is given them: for each, the file the bridge
/// reads and encodes at the SDK boundary, never the image data itself.
pub fn claude_images(root: &FsPath, agent: &str, images: &[String]) -> Result<Vec<Value>> {
    let mut refs = vec![];
    each_owned(root, agent, images, |id, path, bytes| {
        let path = claude_fit(path, id, bytes)?;
        let data = bounded_read(&path, CLAUDE_MAX_BYTES)?;
        let media = match image::guess_format(&data)? {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::WebP => "image/webp",
            _ => anyhow::bail!("Unsupported image for Claude; attach it again"),
        };
        refs.push(json!({"path":path.canonicalize()?, "mediaType":media,
            "sha256":format!("{:x}", Sha256::digest(&data)), "bytes":data.len()}));
        Ok(())
    })?;
    Ok(refs)
}

/// The images of a sent message as its conversation item shows them: the
/// same managed references as a Codex message, read through the image route.
/// Like Codex's, the paths are canonical, also when Core runs with a relative
/// `--data-dir`: the web reads back only absolute managed paths. Blocking.
pub fn history_images(root: &FsPath, agent: &str, images: &[String]) -> Vec<Value> {
    if images.is_empty() {
        return vec![];
    }
    let root = root.canonicalize().or_else(|_| std::path::absolute(root)).unwrap_or_else(|_| root.to_owned());
    images.iter().filter_map(|id| image_path(&root, agent, id).ok())
        .map(|path| json!({"type":"localImage", "path":path})).collect()
}

/// The original if it is within Claude's budget, else a smaller copy made
/// once and kept beside it: scaled to fit, PNG if that is small enough, else
/// JPEG at the highest quality that fits.
fn claude_fit(path: &FsPath, id: &str, bytes: &[u8]) -> Result<PathBuf> {
    let format = image::guess_format(bytes)?;
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), format).into_dimensions()?;
    if width <= CLAUDE_MAX_SIDE && height <= CLAUDE_MAX_SIDE && bytes.len() <= CLAUDE_MAX_BYTES {
        return Ok(path.to_owned());
    }
    let fitted = |ext: &str| path.with_file_name(format!("{id}.claude.{ext}"));
    let _one = FITTING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(done) = ["png", "jpg"].map(fitted).into_iter().find(|p| p.exists()) {
        return Ok(done);
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let mut image = reader.decode().context("Image is damaged or exceeds the decoding memory limit")?;
    if width > CLAUDE_MAX_SIDE || height > CLAUDE_MAX_SIDE {
        image = image.resize(CLAUDE_MAX_SIDE, CLAUDE_MAX_SIDE, image::imageops::FilterType::Lanczos3);
    }
    if format == ImageFormat::Png {
        let mut png = Cursor::new(Vec::new());
        image.write_to(&mut png, ImageFormat::Png)?;
        if png.get_ref().len() <= CLAUDE_MAX_BYTES {
            save_new(&fitted("png"), png.get_ref())?;
            return Ok(fitted("png"));
        }
    }
    // JPEG has no alpha: transparent areas become white.
    let mut rgb = image::RgbImage::new(image.width(), image.height());
    for (out, pixel) in rgb.pixels_mut().zip(image.to_rgba8().pixels()) {
        let alpha = u16::from(pixel[3]);
        *out = image::Rgb([0, 1, 2].map(|c| ((u16::from(pixel[c]) * alpha + 255 * (255 - alpha)) / 255) as u8));
    }
    let jpeg = |quality: u8| -> Result<Vec<u8>> {
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality).encode_image(&rgb)?;
        Ok(out)
    };
    let (mut low, mut high, mut best) = (1u8, 90u8, None);
    while low <= high {
        let quality = (low + high) / 2;
        let data = jpeg(quality)?;
        if data.len() <= CLAUDE_MAX_BYTES {
            best = Some(data);
            low = quality + 1;
        } else {
            high = quality - 1;
        }
    }
    let data = best.context("This image cannot be made small enough for Claude. Resize it and attach it again")?;
    save_new(&fitted("jpg"), &data)?;
    Ok(fitted("jpg"))
}

pub fn check_model(models: &[Value], selected: &str) -> Result<()> {
    let model = models
        .iter()
        .find(|m| m["model"] == selected || m["id"] == selected)
        .or_else(|| {
            if selected.is_empty() {
                models.iter().find(|m| m["isDefault"] == true)
            } else {
                None
            }
        })
        .context(
            "Cannot confirm this model's image capability. Choose a model from the Codex catalog",
        )?;
    // Official compatibility rule for old catalogs: missing means text + image.
    ensure!(model.get("inputModalities").is_none() || model["inputModalities"].as_array().is_some_and(|m| m.iter().any(|v| v == "image")),
        "The selected Codex model does not support images. Choose an image-capable model; your draft is kept");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(width: u32, height: u32, color: u8) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        image::RgbImage::from_pixel(width, height, image::Rgb([color, 0, 0]))
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }
    #[test]
    fn upload_validates_content_and_limits_and_generates_a_small_preview() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = png(640, 480, 30);
        let image = upload(dir.path(), "a", &bytes).unwrap();
        assert_eq!((image.width, image.height), (640, 480));
        assert_eq!(upload(dir.path(), "a", &bytes).unwrap().id, image.id);
        let thumb = image_path(dir.path(), "a", &image.id)
            .unwrap()
            .with_file_name(format!("{}.thumb.png", image.id));
        assert_eq!(
            ImageReader::open(thumb).unwrap().into_dimensions().unwrap(),
            (320, 240)
        );
        assert!(upload(dir.path(), "a", b"<svg/>").is_err());
        assert!(upload(dir.path(), "a", &vec![0; MAX_BYTES + 1]).is_err());
        assert!(upload(dir.path(), "a", &png(8193, 1, 0))
            .unwrap_err()
            .to_string()
            .contains("8192"));
        assert!(upload(dir.path(), "a", &bytes[..30]).is_err());
    }
    #[test]
    fn native_input_uses_immutable_owned_images_and_allows_images_without_text() {
        let dir = tempfile::tempdir().unwrap();
        let a = upload(dir.path(), "a", &png(4, 4, 10)).unwrap();
        let b = upload(dir.path(), "a", &png(4, 4, 20)).unwrap();
        let images = vec![a.id.clone(), b.id.clone()];
        let input = native_input(dir.path(), "a", "Compare these", &images).unwrap();
        assert_eq!(input[0]["text"], "Compare these");
        assert_eq!(input[1]["type"], "localImage");
        assert_eq!(input[2]["type"], "localImage");
        assert_eq!(
            native_input(dir.path(), "a", "", &images)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(native_input(dir.path(), "b", "", &images).is_err());
        assert!(native_input(dir.path(), "../a", "", &images).is_err());
        assert!(image_path(dir.path(), "a", "../../secret.png").is_err());
        assert!(native_input(dir.path(), "a", "", &[a.id.clone(), a.id.clone()]).is_err());
        std::fs::write(image_path(dir.path(), "a", &a.id).unwrap(), b"tamper").unwrap();
        assert!(native_input(dir.path(), "a", "", &[a.id])
            .unwrap_err()
            .to_string()
            .contains("changed"));
    }
    #[test]
    fn claude_gets_small_originals_and_kept_copies_fitted_to_its_budget() {
        let dir = tempfile::tempdir().unwrap();
        let small = upload(dir.path(), "a", &png(4, 4, 10)).unwrap();
        let wide = upload(dir.path(), "a", &png(2400, 600, 80)).unwrap();
        // Noise PNGs compress badly, so this one needs JPEG; its alpha turns white.
        let mut seed = 7u32;
        let noisy = image::RgbaImage::from_fn(1200, 900, |x, _| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let [r, g, b, _] = seed.to_le_bytes();
            image::Rgba([r, g, b, if x < 32 { 0 } else { 255 }])
        });
        let mut bytes = Cursor::new(Vec::new());
        noisy.write_to(&mut bytes, ImageFormat::Png).unwrap();
        assert!(bytes.get_ref().len() > CLAUDE_MAX_BYTES);
        let noisy = upload(dir.path(), "a", bytes.get_ref()).unwrap();
        let ids = vec![small.id.clone(), wide.id.clone(), noisy.id.clone()];
        let refs = claude_images(dir.path(), "a", &ids).unwrap();
        let original = |id: &str| image_path(dir.path(), "a", id).unwrap().canonicalize().unwrap();
        assert_eq!(refs[0]["path"], json!(original(&small.id)), "already within the budget");
        let opened = |r: &Value| ImageReader::open(r["path"].as_str().unwrap()).unwrap().with_guessed_format().unwrap();
        assert_eq!((refs[1]["mediaType"].clone(), opened(&refs[1]).into_dimensions().unwrap()), (json!("image/png"), (2000, 500)));
        assert_eq!(refs[2]["mediaType"], "image/jpeg");
        let flattened = opened(&refs[2]).decode().unwrap().to_rgb8();
        assert!(flattened.get_pixel(0, 0).0.iter().all(|&c| c > 240), "transparent became white");
        for r in &refs {
            let data = std::fs::read(r["path"].as_str().unwrap()).unwrap();
            assert!(data.len() <= CLAUDE_MAX_BYTES && r["bytes"] == data.len());
            assert_eq!(r["sha256"], format!("{:x}", Sha256::digest(&data)));
        }
        // The copies are made once and kept; the originals are unchanged.
        assert_eq!(claude_images(dir.path(), "a", &ids).unwrap(), refs);
        assert!(native_input(dir.path(), "a", "", &ids).is_ok());
        assert!(claude_images(dir.path(), "b", &ids).is_err(), "another Agent's images");
        assert_eq!(history_images(dir.path(), "a", &ids[..1]),
            vec![json!({"type":"localImage","path":original(&small.id)})]);
    }
    /// T-31 R1: with a relative `--data-dir`, a Claude message's history
    /// still holds the canonical managed path the web reads back.
    #[test]
    fn claude_history_paths_are_canonical_under_a_relative_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        // The same folder, named relative to this process with `..` steps.
        let up = std::env::current_dir().unwrap().components().count() - 1;
        let relative = std::iter::repeat("..").take(up).collect::<PathBuf>()
            .join(dir.path().strip_prefix("/").unwrap());
        assert!(relative.is_relative());
        let image = upload(&relative, "a", &png(4, 4, 10)).unwrap();
        let canonical = image_path(&dir.path().canonicalize().unwrap(), "a", &image.id).unwrap();
        let shown = history_images(&relative, "a", &[image.id.clone()]);
        assert_eq!(shown, vec![json!({"type":"localImage","path":canonical})]);
        let path = PathBuf::from(shown[0]["path"].as_str().unwrap());
        assert!(path.components().all(|c| matches!(c, std::path::Component::RootDir | std::path::Component::Normal(_))),
            "no . or .. for the web to refuse: {path:?}");
        assert_eq!(claude_images(&relative, "a", &[image.id]).unwrap()[0]["path"], json!(canonical));
    }
    #[test]
    fn model_capability_is_checked_with_official_old_catalog_compatibility() {
        assert!(check_model(&[json!({"model":"m", "inputModalities":["text"]})], "m").is_err());
        assert!(check_model(
            &[json!({"model":"m", "inputModalities":["text", "image"]})],
            "m"
        )
        .is_ok());
        assert!(check_model(&[json!({"model":"m"})], "m").is_ok());
        assert!(check_model(&[json!({"model":"m"})], "unknown").is_err());
    }
}
