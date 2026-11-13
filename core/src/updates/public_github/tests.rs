use super::{
    stand_in::{self, Answer},
    *,
};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;

const LIST: &str = "repos/owner/repo/releases?per_page=100";
const WAIT: Duration = Duration::from_secs(5);

fn asset(id: u64) -> String {
    format!("repos/owner/repo/releases/assets/{id}")
}

/// A gh stand-in running `script`, which logs each call to `calls`.
fn gh(dir: &Path, name: &str, script: &str) -> Gh {
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\necho {name} >> \"$(dirname \"$0\")/calls\"\n{script}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    Gh { program: path.to_string_lossy().into(), deadline: WAIT, ..Default::default() }
}

#[test]
fn production_reads_only_api_github_com() {
    const _: () = assert!(matches!(API.as_bytes(), b"https://api.github.com"));
    let reader = PublicGithub::default();
    assert!(reader.test.is_none());
    assert_eq!(reader.base(), "https://api.github.com");
}

#[tokio::test]
async fn reads_a_list_and_follows_an_asset_to_another_https_host_without_credentials() {
    let github = stand_in::serve(|path, port| match path {
        "/repos/owner/repo/releases?per_page=100" => Answer::ok(r#"[{"tag_name":"core-test"}]"#),
        "/repos/owner/repo/releases/assets/7" => Answer::redirect(format!("https://localhost:{port}/cdn/7?signed=1")),
        "/cdn/7?signed=1" => Answer::ok("asset bytes"),
        _ => Answer::status(404),
    });
    let reader = github.reader(&[]);
    assert_eq!(reader.get_json(LIST).await.unwrap(), json!([{"tag_name":"core-test"}]));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("asset");
    let progress = AtomicU64::new(0);
    reader.download(&asset(7), &path, 64, WAIT, &progress).await.unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"asset bytes");
    assert_eq!(progress.load(Ordering::Relaxed), 11);
    let requests: Vec<_> = github.requests().iter().map(|head| head.to_ascii_lowercase()).collect();
    assert_eq!(requests.len(), 3, "{requests:?}");
    for head in &requests {
        assert!(head.contains("user-agent: yuzuno-core/") && head.contains("x-github-api-version: 2022-11-28"), "{head}");
        assert!(!head.contains("authorization") && !head.contains("cookie"), "{head}");
    }
    assert!(requests[0].contains("accept: application/vnd.github+json"), "{}", requests[0]);
    assert!(requests[1].contains("accept: application/octet-stream"), "{}", requests[1]);
    assert!(requests[2].starts_with("get /cdn/7?signed=1 ") && requests[2].contains("host: localhost:"), "{}", requests[2]);
}

#[tokio::test]
async fn redirects_are_followed_only_to_https_and_at_most_five_times() {
    // Asset <n> starts a chain of n redirects, alternately absolute and relative.
    let github = stand_in::serve(|path, port| {
        let Some(n) = path.strip_prefix("/repos/owner/repo/releases/assets/").or_else(|| path.strip_prefix("/hop/")) else {
            return Answer::status(404);
        };
        match n.parse::<u32>().unwrap() {
            0 => Answer::ok("arrived"),
            900 => Answer::redirect(format!("http://127.0.0.1:{port}/hop/0")),
            901 => Answer::redirect(format!("https://user:secret@127.0.0.1:{port}/hop/0")),
            902 => Answer::status(302),
            n if n % 2 == 0 => Answer::redirect(format!("/hop/{}", n - 1)),
            n => Answer::redirect(format!("https://127.0.0.1:{port}/hop/{}", n - 1)),
        }
    });
    let reader = github.reader(&[]);
    let dir = tempfile::tempdir().unwrap();
    let progress = AtomicU64::new(0);
    reader.download(&asset(5), &dir.path().join("5"), 64, WAIT, &progress).await.unwrap();
    assert_eq!(std::fs::read(dir.path().join("5")).unwrap(), b"arrived");
    assert_eq!(github.requests().len(), 6, "five redirects, then the answer");
    let refusals = [
        (6, "more than 5", 6),
        (900, "not plain HTTPS", 1),
        (901, "not plain HTTPS", 1),
        (902, "without an address", 1),
    ];
    for (id, said, requests) in refusals {
        let before = github.requests().len();
        let error = reader.download(&asset(id), &dir.path().join(id.to_string()), 64, WAIT, &progress).await.unwrap_err().to_string();
        assert!(error.starts_with("unavailable:") && error.contains(said), "{id}: {error}");
        assert_eq!(github.requests().len() - before, requests, "{id}: the refused address was never asked");
        assert!(!dir.path().join(id.to_string()).exists());
    }
}

#[tokio::test]
async fn size_limits_and_deadlines_hold() {
    let github = stand_in::serve(|path, _| match path {
        "/repos/owner/repo/releases/assets/1" => Answer::ok(vec![b'x'; 100]),
        "/repos/owner/repo/releases/assets/2" => Answer { wait: Duration::from_secs(3), ..Answer::ok("late") },
        "/repos/owner/repo/releases?per_page=100" => Answer { wait: Duration::from_secs(3), ..Answer::ok("[]") },
        "/repos/owner/large/releases?per_page=100" => Answer::ok(vec![b' '; MAX_JSON + 1]),
        _ => Answer::status(404),
    });
    let mut reader = github.reader(&[]);
    let dir = tempfile::tempdir().unwrap();
    let progress = AtomicU64::new(0);
    let error = reader.download(&asset(1), &dir.path().join("small"), 99, WAIT, &progress).await.unwrap_err();
    assert!(error.to_string().contains("exceeded its size limit"), "{error}");
    assert!(!dir.path().join("small").exists());
    reader.download(&asset(1), &dir.path().join("exact"), 100, WAIT, &progress).await.unwrap();
    assert_eq!(std::fs::metadata(dir.path().join("exact")).unwrap().len(), 100);
    let error = reader.download(&asset(2), &dir.path().join("late"), 64, Duration::from_millis(300), &progress).await.unwrap_err();
    assert!(error.to_string().starts_with("timeout:"), "{error}");
    reader.deadline = Duration::from_millis(300);
    let error = reader.get_json(LIST).await.unwrap_err();
    assert!(error.to_string().starts_with("timeout:"), "{error}");
    reader.deadline = WAIT;
    let error = reader.get_json("repos/owner/large/releases?per_page=100").await.unwrap_err();
    assert!(error.to_string().starts_with("response_too_large:"), "{error}");
}

#[tokio::test]
async fn refusals_keep_the_kinds_gh_reports() {
    let github = stand_in::serve(|path, _| match path.rsplit('/').next().unwrap_or_default() {
        "1" => Answer::status(403).header("x-ratelimit-remaining", "0"),
        "2" => Answer::status(429),
        "3" => Answer::status(404),
        "4" => Answer::status(403).header("x-ratelimit-remaining", "12"),
        "5" => Answer::status(502),
        _ => Answer::status(500),
    });
    let reader = github.reader(&[]);
    let dir = tempfile::tempdir().unwrap();
    let kinds = [(1, "rate_limited:"), (2, "rate_limited:"), (3, "not_found:"), (4, "forbidden:"), (5, "unavailable:")];
    for (id, kind) in kinds {
        let error = reader.download(&asset(id), &dir.path().join(id.to_string()), 64, WAIT, &AtomicU64::new(0)).await.unwrap_err().to_string();
        assert!(error.starts_with(kind), "{id}: {error}");
        assert!(id == 5 || error.contains("sign in with gh on the Core host"), "{id}: {error}");
    }
}

#[tokio::test]
async fn only_release_lists_and_release_assets_are_read() {
    let github = stand_in::serve(|_, _| Answer::ok("[]"));
    let reader = github.reader(&[]);
    let lists = [
        "repos/owner/repo/pulls",
        "repos/owner/repo/releases",
        "repos/owner/repo/releases?per_page=100&page=2",
        "repos/owner/repo/releases/assets/7",
        "user",
        "https://example.com/repos/owner/repo/releases?per_page=100",
        "/repos/owner/repo/releases?per_page=100",
        "repos/owner/../releases?per_page=100",
        "repos/owner/repo/x/releases?per_page=100",
        "repos/owner/repo.git/releases?per_page=100",
    ];
    for endpoint in lists {
        assert!(reader.get_json(endpoint).await.is_err(), "{endpoint}");
    }
    let dir = tempfile::tempdir().unwrap();
    let assets = [
        LIST,
        "repos/owner/repo/releases/assets/",
        "repos/owner/repo/releases/assets/07",
        "repos/owner/repo/releases/assets/7/x",
        "repos/owner/repo/releases/assets/-1",
        "repos/owner/repo/releases/assets/99999999999999999999",
        "repos/owner/repo.git/releases/assets/7",
        "repos/owner/repo/releases/assets/7?x=1",
    ];
    for endpoint in assets {
        assert!(reader.download(endpoint, &dir.path().join("a"), 64, WAIT, &AtomicU64::new(0)).await.is_err(), "{endpoint}");
    }
    assert!(github.requests().is_empty(), "refused before any request");
}

#[tokio::test]
async fn the_proxy_comes_only_from_https_proxy_and_no_proxy() {
    let github = stand_in::serve(|path, _| match path {
        "/repos/owner/repo/releases?per_page=100" => Answer::ok("[1]"),
        _ => Answer::status(404),
    });
    let proxy = stand_in::proxy();
    let address = format!("http://127.0.0.1:{}", proxy.port);
    for env in [[("HTTPS_PROXY", address.as_str())], [("https_proxy", address.as_str())]] {
        let before = proxy.requests().len();
        assert_eq!(github.reader(&env).get_json(LIST).await.unwrap(), json!([1]));
        let seen = proxy.requests();
        assert_eq!(seen.len(), before + 1);
        assert!(seen[before].starts_with(&format!("CONNECT 127.0.0.1:{} ", github.port)), "{}", seen[before]);
        assert!(!seen[before].to_ascii_lowercase().contains("authorization"), "{}", seen[before]);
    }
    // The proxy's own sign-in goes to the proxy only.
    let signed = format!("http://user:secret@127.0.0.1:{}", proxy.port);
    assert_eq!(github.reader(&[("HTTPS_PROXY", &signed)]).get_json(LIST).await.unwrap(), json!([1]));
    assert!(proxy.requests().last().unwrap().to_ascii_lowercase().contains("proxy-authorization: basic "));
    assert!(github.requests().iter().all(|head| !head.to_ascii_lowercase().contains("authorization")));
    // NO_PROXY naming the host, and any other variable, leave the proxy out.
    let before = proxy.requests().len();
    let direct: [&[(&'static str, &str)]; 3] = [
        &[("HTTPS_PROXY", &address), ("NO_PROXY", "localhost,127.0.0.1")],
        &[("HTTPS_PROXY", &address), ("no_proxy", "127.0.0.0/8")],
        &[("ALL_PROXY", &address), ("HTTP_PROXY", &address), ("http_proxy", &address), ("all_proxy", &address)],
    ];
    for env in direct {
        assert_eq!(github.reader(env).get_json(LIST).await.unwrap(), json!([1]), "{env:?}");
    }
    assert_eq!(proxy.requests().len(), before);
    // A proxy that is set but unusable stops the read instead of going around it.
    for value in ["socks5://127.0.0.1:1080", "https://127.0.0.1:3128", "not a proxy"] {
        let before = github.requests().len();
        let error = github.reader(&[("HTTPS_PROXY", value)]).get_json(LIST).await.unwrap_err().to_string();
        assert!(error.starts_with("unavailable:") && error.contains("HTTPS_PROXY"), "{value}: {error}");
        assert_eq!(github.requests().len(), before, "{value}");
    }
}

#[tokio::test]
async fn only_a_missing_or_signed_out_gh_sends_the_operation_the_public_way() {
    let github = stand_in::serve(|path, _| match path {
        "/repos/owner/repo/releases?per_page=100" => Answer::ok(r#"["public"]"#),
        "/repos/owner/repo/releases/assets/7" => Answer::ok("public bytes"),
        _ => Answer::status(404),
    });
    let public = github.reader(&[]);
    let dir = tempfile::tempdir().unwrap();
    let calls = || std::fs::read_to_string(dir.path().join("calls")).unwrap_or_default().lines().count();
    let missing = Gh { program: dir.path().join("no-gh").to_string_lossy().into(), deadline: WAIT, ..Default::default() };
    let signed_out = gh(dir.path(), "signed-out", "echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4");
    for (gh, ran) in [(&missing, 0), (&signed_out, 1)] {
        let before = (calls(), github.requests().len());
        let mut route = Route::new(gh, &public);
        assert_eq!(route.get(LIST).await.unwrap(), json!(["public"]));
        assert_eq!(route.via(), Via::Public);
        let path = dir.path().join(format!("asset-{ran}"));
        route.download(&asset(7), &path, 64, WAIT, &AtomicU64::new(0)).await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"public bytes");
        assert_eq!((calls(), github.requests().len()), (before.0 + ran, before.1 + 2), "gh is asked once per operation");
        // A download of its own asks gh first; a signed-out gh made the file it was refused for.
        let mut route = Route::new(gh, &public);
        let path = dir.path().join(format!("download-{ran}"));
        route.download(&asset(7), &path, 64, WAIT, &AtomicU64::new(0)).await.unwrap();
        assert_eq!((route.via(), std::fs::read(&path).unwrap()), (Via::Public, b"public bytes".to_vec()));
    }
    let signed_in = gh(dir.path(), "signed-in", r#"echo '["gh"]'"#);
    let mut route = Route::new(&signed_in, &public);
    assert_eq!(route.get(LIST).await.unwrap(), json!(["gh"]));
    assert_eq!(route.via(), Via::Gh);
    let refusals = [
        ("not-found", "echo 'gh: Not Found (HTTP 404)' >&2; exit 1", "not_found:"),
        ("forbidden", "echo 'gh: Resource not accessible (HTTP 403)' >&2; exit 1", "forbidden:"),
        ("rate-limited", "echo 'API rate limit exceeded' >&2; exit 1", "rate_limited:"),
        ("unavailable", "echo 'connection reset by peer' >&2; exit 1", "unavailable:"),
    ];
    let before = github.requests().len();
    for (name, script, kind) in refusals {
        let gh = gh(dir.path(), name, script);
        let mut route = Route::new(&gh, &public);
        let error = route.get(LIST).await.unwrap_err().to_string();
        assert!(error.starts_with(kind), "{name}: {error}");
        let error = route.download(&asset(7), &dir.path().join(format!("{name}.out")), 64, WAIT, &AtomicU64::new(0)).await.unwrap_err().to_string();
        assert!(error.starts_with(kind), "{name}: {error}");
        assert_eq!(route.via(), Via::Gh, "{name}");
    }
    assert_eq!(github.requests().len(), before, "gh's other errors never reach the public reader");
}
