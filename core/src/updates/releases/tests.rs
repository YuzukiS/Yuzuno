use super::*;
use crate::{
    updates::{
        lifecycle::WorkspaceRuntime,
        state::{Launch, ReleaseRef},
    },
    workspace::Workspace,
};
use std::os::unix::fs::PermissionsExt;

const INDEX: &[u8] = include_bytes!("fixtures/yuzuno-core-linux-x86_64.json");
const SIGNATURE: &str = include_str!("fixtures/yuzuno-core-linux-x86_64.json.minisig");
const ARCHIVE: &[u8] = include_bytes!("fixtures/yuzuno-core-linux-x86_64.tar.gz");
fn config() -> Config {
    Config {
        repository: "owner/repo".into(),
        public_key: include_str!("fixtures/publisher.pub")
            .lines()
            .nth(1)
            .unwrap()
            .into(),
    }
}
fn descriptor() -> Descriptor {
    serde_json::from_slice(INDEX).unwrap()
}
fn job() -> Job {
    Job {
        cancelled: AtomicBool::new(false),
        wake: Notify::new(),
    }
}

#[test]
fn authentic_signature_binds_source_manifest_and_archive() {
    let d = descriptor();
    assert!(verify_descriptor(&config(), INDEX, SIGNATURE, &d.manifest).is_ok());
    let mut altered = INDEX.to_vec();
    altered[20] ^= 1;
    assert!(verify_descriptor(&config(), &altered, SIGNATURE, &d.manifest).is_err());
    let mut wrong = config();
    wrong.repository = "another/repo".into();
    assert!(verify_descriptor(&wrong, INDEX, SIGNATURE, &d.manifest).is_err());
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("archive");
    fs::write(&archive, ARCHIVE).unwrap();
    let bundle = unpack(&archive, dir.path(), &d, &job()).unwrap();
    assert_eq!(bundle.manifest.release_id, "signed-test");
    fs::write(&archive, b"corrupt").unwrap();
    assert!(unpack(&archive, dir.path(), &d, &job())
        .err()
        .unwrap()
        .to_string()
        .contains("signed checksum"));
}

#[test]
fn archives_never_materialize_links_or_traversal() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("malicious.tar.gz");
    let mut writer = tar::Builder::new(flate2::write::GzEncoder::new(
        File::create(&path).unwrap(),
        flate2::Compression::fast(),
    ));
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_size(0);
    header.set_mode(0o777);
    writer
        .append_link(&mut header, "escape", "../../outside")
        .unwrap();
    writer.into_inner().unwrap().finish().unwrap();
    let mut d = descriptor();
    d.archive_bytes = fs::metadata(&path).unwrap().len();
    d.archive_sha256 = package::sha256(&path).unwrap();
    assert!(unpack(&path, root.path(), &d, &job())
        .err()
        .unwrap()
        .to_string()
        .contains("only regular files"));
    assert!(!root.path().join("bundle/escape").exists());
}

fn fixture() -> (tempfile::TempDir, Arc<Controller>) {
    let dir = tempfile::tempdir().unwrap();
    // Running a release of the signed fixture's record format (an earlier
    // one, T-140): what is checked here is the download, not the format.
    let initial = package::fixture_records(&dir.path().join("initial"), "initial",
        package::Schema { writes: 1, reads_min: 0, reads_max: 1 });
    let root = dir.path().join("managed");
    catalog::register(
        &root,
        &initial.path,
        &initial.manifest_sha256,
        "Local test",
        true,
    )
    .unwrap();
    package::atomic_json(
        &root.join("release-source.json"),
        &json!({"repository":"owner/repo","publicKey":config().public_key}),
    )
    .unwrap();
    let layout = Layout::open(&root).unwrap();
    let running = layout.release(&ReleaseRef::from(&initial)).unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/fixture".into(), "unused".into()).unwrap();
    let mut controller = Controller::new(
        Some(layout),
        Some(running),
        Launch {
            port: 4492,
            data_dir: dir.path().join("data"),
            cwd: dir.path().into(),
            codex: "unused".into(),
        },
        Arc::new(WorkspaceRuntime(ws.clone())),
        ws.admission.clone(),
    )
    .unwrap();
    let files = [INDEX, SIGNATURE.as_bytes(), ARCHIVE];
    for (i, bytes) in files.into_iter().enumerate() {
        fs::write(dir.path().join(format!("asset-{}", i + 1)), bytes).unwrap();
    }
    let script = dir.path().join("gh-fixture.py");
    fs::write(&script, r#"#!/usr/bin/python3
import json,sys,time
from pathlib import Path
root=Path(__file__).parent
assert sys.argv[1:6] == ['api','--hostname','github.com','--method','GET']
if (root/'offline').exists():
 print('network unavailable secret diagnostic',file=sys.stderr);sys.exit(1)
endpoint=sys.argv[-1]
if endpoint.endswith('/releases?per_page=100'):
 names=['yuzuno-core-linux-x86_64.json','yuzuno-core-linux-x86_64.json.minisig','yuzuno-core-linux-x86_64.tar.gz']
 assets=[{'id':i+1,'name':n,'state':'uploaded','size':(root/f'asset-{i+1}').stat().st_size} for i,n in enumerate(names)]
 print(json.dumps([{'tag_name':'desktop-newer','draft':False,'prerelease':False,'published_at':'2026-10-15T00:00:00Z','assets':[]},{'tag_name':'core-test','draft':False,'prerelease':False,'published_at':'2026-10-14T00:00:00Z','assets':assets}]))
elif '/releases/assets/' in endpoint:
 number=endpoint.rsplit('/',1)[1]
 if number=='3' and (root/'slow').exists(): time.sleep(60)
 sys.stdout.buffer.write((root/f'asset-{number}').read_bytes())
else: raise AssertionError(endpoint)
"#).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    Arc::get_mut(&mut Arc::get_mut(&mut controller).unwrap().releases)
        .unwrap()
        .client
        .program = script.to_string_lossy().into();
    (dir, controller)
}
async fn wait(controller: &Controller, phase: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let s = controller.releases.status();
            if s["phase"] == phase {
                return;
            }
            assert_ne!(s["phase"], "failed", "{s}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn signed_download_registers_only_then_requires_manual_prepare() {
    let (dir, c) = fixture();
    Releases::check(&c).unwrap();
    Releases::check(&c).unwrap();
    wait(&c, "available").await;
    assert_eq!(c.releases.status()["candidate"]["releaseId"], "signed-test");
    Releases::download(&c, "signed-test").unwrap();
    Releases::download(&c, "signed-test").unwrap();
    wait(&c, "downloaded").await;
    c.check().await.unwrap();
    assert_eq!(
        c.status().await.unwrap()["candidates"][0]["releaseId"],
        "signed-test"
    );
    assert!(c
        .layout
        .as_ref()
        .unwrap()
        .journal()
        .unwrap()
        .operation
        .is_none());
    c.prepare("signed-test").await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while c.status().await.unwrap()["operation"]["phase"] != "prepared" {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(c.status().await.unwrap()["current"]["releaseId"], "initial");
    fs::write(dir.path().join("offline"), "offline").unwrap();
    Releases::check(&c).unwrap();
    wait(&c, "failed").await;
    let s = c.releases.status();
    assert_eq!(s["candidate"]["releaseId"], "signed-test");
    assert!(!s.to_string().contains("secret diagnostic"));
}

#[tokio::test]
async fn cancelled_download_leaves_no_candidate_and_releases_admission() {
    let (dir, c) = fixture();
    Releases::check(&c).unwrap();
    wait(&c, "available").await;
    fs::write(dir.path().join("slow"), "slow").unwrap();
    Releases::download(&c, "signed-test").unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    c.releases.cancel().unwrap();
    wait(&c, "cancelled").await;
    c.check().await.unwrap();
    assert!(c.status().await.unwrap()["candidates"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(c.admission.snapshot().in_flight, 0);
    assert!(!c
        .layout
        .as_ref()
        .unwrap()
        .updates()
        .join("release-download.json")
        .exists());
}

/// Opt-in transport acceptance only. A private Draft never enters production
/// discovery; call the same bounded gh reader, verifier and unpacker directly.
/// The host supplies a reviewed public key, exact Draft ID and disposable paths.
#[tokio::test]
#[ignore = "requires an explicitly authorized private Draft Release and isolated config"]
async fn private_draft_uses_real_gh_download_and_signature_verification() {
    let input = std::env::var("YUZUNO_RELEASE_ACCEPTANCE").expect("explicit acceptance config");
    let input: Value = serde_json::from_reader(File::open(input).unwrap()).unwrap();
    let value = |key: &str| input[key].as_str().unwrap();
    let root = Path::new(value("output"));
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    assert!(root.starts_with(checkout.join("target")));
    fs::create_dir(root).unwrap(); // never reuse a prior run
    let temporary = tempfile::Builder::new()
        .prefix("draft-")
        .tempdir_in(root)
        .unwrap();
    let config = Config {
        repository: value("repository").into(),
        public_key: value("publicKey").into(),
    };
    assert_eq!(
        crate::github::client::parse(&config.repository, false)
            .unwrap()
            .repo,
        config.repository
    );
    let initial = Bundle::verify(
        Path::new(value("initialBundle")),
        value("initialManifestSha256"),
    )
    .unwrap();
    let client = Client::default();
    let id = input["draftId"].as_u64().unwrap();
    let release = client
        .get(&format!("repos/{}/releases/{id}", config.repository))
        .await
        .unwrap();
    assert_eq!(
        release["draft"], true,
        "acceptance must not publish to the stable feed"
    );
    assert_eq!(release["tag_name"], value("tag"));
    let assets = release["assets"].as_array().unwrap();
    let prefix = format!("yuzuno-core-{}", package::platform());
    let progress = AtomicU64::new(0);
    let mut archive_size = 0;
    for (suffix, limit) in [
        ("json", MAX_DESCRIPTOR),
        ("json.minisig", 4096),
        ("tar.gz", MAX_ARCHIVE),
    ] {
        let (id, size) = asset(assets, &format!("{prefix}.{suffix}"), limit).unwrap();
        client
            .download(
                &format!("repos/{}/releases/assets/{id}", config.repository),
                &temporary.path().join(suffix),
                size,
                Duration::from_secs(300),
                &progress,
            )
            .await
            .unwrap();
        if suffix == "tar.gz" {
            archive_size = size;
        }
    }
    let descriptor = verify_descriptor(
        &config,
        &fs::read(temporary.path().join("json")).unwrap(),
        &fs::read_to_string(temporary.path().join("json.minisig")).unwrap(),
        &initial.manifest,
    )
    .unwrap();
    assert_eq!(descriptor.tag, value("tag"));
    assert_eq!(descriptor.archive_bytes, archive_size);
    let bundle = unpack(
        &temporary.path().join("tar.gz"),
        temporary.path(),
        &descriptor,
        &job(),
    )
    .unwrap();
    fs::write(root.join("receipt.json"), serde_json::to_vec_pretty(&json!({
        "passed":true,"transport":"official gh private draft","repository":config.repository,
        "draftId":id,"tag":descriptor.tag,"releaseId":bundle.manifest.release_id,
        "gitSha":bundle.manifest.git_sha,"archiveBytes":archive_size,
        "archiveSha256":descriptor.archive_sha256,"manifestSha256":bundle.manifest_sha256,
        "limits":"Direct bounded download/signature/unpack only; not stable discovery or application"
    })).unwrap()).unwrap();
}
