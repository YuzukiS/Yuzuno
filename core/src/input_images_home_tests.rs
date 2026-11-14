//! YN-134 S1: a Project's images written on Home, checked and copied to the
//! Agent a message goes to, and the user's routes that keep and read them.
use super::*;
use axum::{
    body::Body,
    http::{Request as HttpRequest, StatusCode},
};
use std::{collections::BTreeMap, os::unix::fs::MetadataExt};

fn png(width: u32, height: u32, color: u8) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    image::RgbImage::from_pixel(width, height, image::Rgb([color, 0, 0]))
        .write_to(&mut out, ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

/// An image the user attached on Home in `project`.
fn home(root: &FsPath, project: &str, bytes: &[u8]) -> UploadedImage {
    upload_in(&home_dir(root, project).unwrap(), bytes, "full").unwrap()
}

/// The names directly in `dir`, sorted.
fn names(dir: &FsPath) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

fn with_thumbs(ids: &[&String]) -> Vec<String> {
    let mut names: Vec<String> = ids.iter().flat_map(|id| [id.to_string(), format!("{id}.thumb.png")]).collect();
    names.sort();
    names
}

#[test]
fn owners_are_plain_folder_names_and_images_plain_file_names() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    assert_eq!(home_dir(root, "p-1").unwrap(), root.join("home-images").join("p-1"));
    let long = "p".repeat(101);
    for owner in ["", ".", "..", "../p", "p/q", "/p", "p\\q", "p.q", "p q", long.as_str()] {
        assert!(home_dir(root, owner).is_err(), "{owner:?}");
        assert!(agent_dir(root, owner).is_err(), "{owner:?}");
        assert!(check_home(root, owner, &[]).is_err(), "{owner:?}");
        assert!(adopt(root, owner, "a", &[]).is_err(), "{owner:?}");
        assert!(adopt(root, "p", owner, &[]).is_err(), "{owner:?}");
    }
    let hash = "a".repeat(64);
    for id in [
        "../../secret.png".to_owned(),
        format!("../{hash}.png"),
        format!("{hash}.png/x"),
        format!("{hash}.svg"),
        format!("{}.png", "A".repeat(64)),
        "x.png".to_owned(),
    ] {
        let error = check_home(root, "p", &[id.clone()]).unwrap_err().to_string();
        assert!(error.contains("Invalid image reference"), "{id}: {error}");
    }
    assert!(!root.join("home-images").exists() && !root.join("input-images").exists(), "nothing was made");
}

#[test]
fn a_message_from_home_takes_at_most_eight_unchanged_images_of_40_mib_in_all() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let a = home(root, "p", &png(4, 4, 10));
    let b = home(root, "p", &png(4, 4, 20));
    check_home(root, "p", &[a.id.clone(), b.id.clone()]).unwrap();
    check_home(root, "p", &[]).unwrap();
    let error = |ids: &[String]| check_home(root, "p", ids).unwrap_err().to_string();
    assert!(error(&[a.id.clone(), a.id.clone()]).contains("Duplicate"));
    // Nine references: refused on the count, before any is read.
    let nine: Vec<String> = (0..9).map(|n| format!("{n:064x}.png")).collect();
    assert!(error(&nine).contains("at most 8"));
    // Another Project's image, or an Agent's own, is not this Project's.
    let other = home(root, "q", &png(4, 4, 30));
    assert!(error(&[other.id]).contains("missing"));
    let own = upload(root, "agent-a", &png(4, 4, 40)).unwrap();
    assert!(error(&[own.id]).contains("missing"));
    // Five files of 8.5 MiB, each named by its own hash: over 40 MiB together.
    let big: Vec<String> = (0..5u8)
        .map(|n| {
            let bytes = vec![n; 17 * 512 * 1024];
            let id = format!("{:x}.png", Sha256::digest(&bytes));
            std::fs::write(home_dir(root, "p").unwrap().join(&id), bytes).unwrap();
            id
        })
        .collect();
    check_home(root, "p", &big[..4]).unwrap();
    assert!(error(&big).contains("40 MiB"));
    // A file changed since its upload.
    std::fs::write(image_in(&home_dir(root, "p").unwrap(), &b.id).unwrap(), b"tamper").unwrap();
    assert!(error(&[a.id, b.id]).contains("changed"));
}

#[test]
fn adopt_copies_each_image_once_to_the_recipient_within_its_own_quota() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let a = home(root, "p", &png(640, 480, 10));
    let b = home(root, "p", &png(4, 4, 20));
    let ids = vec![a.id.clone(), b.id.clone()];
    let project = home_dir(root, "p").unwrap();
    adopt(root, "p", "agent-a", &ids).unwrap();
    let mine = agent_dir(root, "agent-a").unwrap();
    assert_eq!(names(&mine), with_thumbs(&[&a.id, &b.id]));
    for id in &ids {
        let (from, to) = (image_in(&project, id).unwrap(), image_path(root, "agent-a", id).unwrap());
        assert_eq!(std::fs::read(&to).unwrap(), std::fs::read(&from).unwrap(), "same ID, same bytes");
        assert_eq!(std::fs::read(thumb_of(&to, id)).unwrap(), std::fs::read(thumb_of(&from, id)).unwrap());
    }
    // Now the Agent's own: a message to it takes them as ones uploaded to it.
    assert_eq!(native_input(root, "agent-a", "", &ids).unwrap().as_array().unwrap().len(), 2);
    assert!(native_input(root, "agent-b", "", &ids).is_err(), "only the recipient has them");
    // Again, as a retry does: nothing is copied twice or rewritten.
    let inode = |id: &str| std::fs::metadata(image_path(root, "agent-a", id).unwrap()).unwrap().ino();
    let before = (inode(&a.id), inode(&b.id));
    adopt(root, "p", "agent-a", &ids).unwrap();
    assert_eq!(names(&mine), with_thumbs(&[&a.id, &b.id]));
    assert_eq!((inode(&a.id), inode(&b.id)), before);
    // The Project keeps its own for the next message.
    assert_eq!(names(&project), with_thumbs(&[&a.id, &b.id]));

    // The recipient's own 256 MiB: with 255 MiB saved, it takes no new image.
    let full = agent_dir(root, "agent-full").unwrap();
    std::fs::create_dir_all(&full).unwrap();
    std::fs::File::create(full.join("filler")).unwrap().set_len(255 * 1024 * 1024).unwrap();
    let error = adopt(root, "p", "agent-full", &[b.id.clone()]).unwrap_err().to_string();
    assert!(error.contains("256 MiB"), "{error}");
    assert_eq!(names(&full), ["filler"], "nothing was copied");
    // One it already has is not copied again, so it takes no more room.
    for name in with_thumbs(&[&b.id]) {
        std::fs::copy(project.join(&name), full.join(&name)).unwrap();
    }
    adopt(root, "p", "agent-full", &[b.id.clone()]).unwrap();

    // Checked as check_home checks: a changed or missing image goes nowhere.
    std::fs::write(image_in(&project, &b.id).unwrap(), b"tamper").unwrap();
    assert!(adopt(root, "p", "agent-c", &[b.id.clone()]).unwrap_err().to_string().contains("changed"));
    assert!(adopt(root, "p", "agent-c", &[format!("{:064x}.png", 7)]).unwrap_err().to_string().contains("missing"));
    assert!(!agent_dir(root, "agent-c").unwrap().exists());
}

/// A Workspace on disk next to the build (/tmp is memory here) with one Project.
fn lab() -> (tempfile::TempDir, Arc<Workspace>, String) {
    let parent = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
    std::fs::create_dir_all(parent).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused-harness".into()).unwrap();
    let project = ws.store.create_project("Code", BTreeMap::new()).unwrap().id;
    (dir, ws, project)
}

fn call(method: &str, path: &str, credential: bool, body: Vec<u8>) -> HttpRequest<Body> {
    let mut request = HttpRequest::builder().method(method).uri(path);
    if credential {
        request = request.header("authorization", "Bearer agent-token");
    }
    request.body(Body::from(body)).unwrap()
}

async fn answer(app: &axum::Router, request: HttpRequest<Body>) -> (StatusCode, String, Vec<u8>) {
    let answer = app.clone().oneshot(request).await.unwrap();
    let kind = answer.headers().get(header::CONTENT_TYPE).map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default();
    (answer.status(), kind, to_bytes(answer.into_body(), 16 << 20).await.unwrap().to_vec())
}

fn said(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body).unwrap()["error"].as_str().unwrap_or_default().to_owned()
}

#[tokio::test]
async fn the_users_routes_keep_and_read_a_projects_images_and_refuse_an_agent_credential() {
    let (_dir, ws, project) = lab();
    let app = crate::project_requests::router().with_state(ws.clone());
    let upload = format!("/api/projects/{project}/images");
    let bytes = png(640, 480, 10);
    // An Agent's credential is refused before anything is read or kept.
    for (method, path) in [("POST", upload.clone()), ("GET", format!("{upload}/{}.png", "a".repeat(64)))] {
        let (status, _, _) = answer(&app, call(method, &path, true, bytes.clone())).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
    }
    assert!(!ws.data_dir.join("home-images").exists(), "nothing kept");

    // The user's page keeps one, and reads it and its thumbnail back.
    let (status, _, body) = answer(&app, call("POST", &upload, false, bytes.clone())).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let kept: Value = serde_json::from_slice(&body).unwrap();
    let id = kept["id"].as_str().unwrap().to_owned();
    assert_eq!((kept["width"].as_u64(), kept["height"].as_u64(), kept["bytes"].as_u64()), (Some(640), Some(480), Some(bytes.len() as u64)));
    let folder = home_dir(&ws.data_dir, &project).unwrap();
    assert_eq!(names(&folder), with_thumbs(&[&id]));
    assert!(!ws.data_dir.join("input-images").exists(), "no Agent has it before a message takes it");
    let read = format!("{upload}/{id}");
    let (status, kind, original) = answer(&app, call("GET", &read, false, vec![])).await;
    assert_eq!((status, kind.as_str(), original == bytes), (StatusCode::OK, "image/png", true));
    let (status, kind, thumb) = answer(&app, call("GET", &format!("{read}?thumb=true"), false, vec![])).await;
    assert_eq!((status, kind.as_str()), (StatusCode::OK, "image/png"));
    let thumb = image::load_from_memory(&thumb).unwrap();
    assert_eq!((thumb.width(), thumb.height()), (320, 240));

    // Archived: nothing new is kept, and what is kept is still read.
    let archive = crate::projects::ProjectChange { name: None, key: None, default_dirs: BTreeMap::new(), archived: Some(true) };
    ws.store.update_project(&project, archive).unwrap();
    let (status, _, body) = answer(&app, call("POST", &upload, false, png(4, 4, 99))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(said(&body).starts_with("project_archived: Code is archived"), "{}", said(&body));
    assert_eq!(names(&folder), with_thumbs(&[&id]), "nothing new kept");
    let (status, _, again) = answer(&app, call("GET", &read, false, vec![])).await;
    assert_eq!((status, again == bytes), (StatusCode::OK, true));

    // No such Project, or not a plain name: refused, nothing made.
    let (status, _, body) = answer(&app, call("POST", "/api/projects/no-such-project/images", false, bytes.clone())).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(said(&body).starts_with("project_not_found"), "{}", said(&body));
    let (status, _, _) = answer(&app, call("GET", &format!("/api/projects/no-such-project/images/{id}"), false, vec![])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, _, body) = answer(&app, call("POST", "/api/projects/..%2Fescape/images", false, bytes.clone())).await;
    assert_eq!(said(&body), "Invalid image owner");
    let (_, _, body) = answer(&app, call("GET", &format!("{upload}/..%2F..%2Fworkspace.sqlite"), false, vec![])).await;
    assert_eq!(said(&body), "Invalid image reference");
    assert_eq!(names(&ws.data_dir.join("home-images")), [project.clone()]);
}

#[tokio::test]
async fn a_deleted_projects_images_go_with_it() {
    let (_dir, ws, project) = lab();
    let folder = home_dir(&ws.data_dir, &project).unwrap();
    home(&ws.data_dir, &project, &png(4, 4, 1));
    let kept = ws.store.create_project("Kept", BTreeMap::new()).unwrap().id;
    home(&ws.data_dir, &kept, &png(4, 4, 2));
    ws.delete_project(&project).await.unwrap();
    assert!(!folder.exists());
    assert_eq!(names(&home_dir(&ws.data_dir, &kept).unwrap()).len(), 2, "another Project's stay");
    // A Project that never had any is deleted as before.
    let empty = ws.store.create_project("Empty", BTreeMap::new()).unwrap().id;
    ws.delete_project(&empty).await.unwrap();
    assert_eq!(names(&ws.data_dir.join("home-images")), [kept]);
}
