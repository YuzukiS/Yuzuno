use url::{Host, Url};

pub const DEFAULT_CORE_URL: &str = "http://127.0.0.1:4317";

/// The Core this launch names: `--core-url`, else `YUZUNO_CORE_URL`; None if
/// neither. CLI overrides the environment. A mistake is shown in the
/// connection page; it must not silently select a different Workspace.
pub fn launch_url(
    args: impl IntoIterator<Item = String>,
    env: Option<String>,
) -> Result<Option<Url>, String> {
    let mut args = args.into_iter();
    let mut argument = None;
    while let Some(arg) = args.next() {
        let value = if arg == "--core-url" {
            args.next().ok_or("--core-url needs a URL.")?
        } else if let Some(value) = arg.strip_prefix("--core-url=") {
            value.to_owned()
        } else if arg.starts_with("-psn_") {
            // macOS may pass the process serial number to an app opened
            // from the Finder; it names no Core.
            continue;
        } else {
            return Err("Use --core-url http://127.0.0.1:4317 to choose a Workspace.".into());
        };
        if argument.replace(value).is_some() {
            return Err("Specify --core-url only once.".into());
        }
    }
    argument.or(env).as_deref().map(parse_core_url).transpose()
}

/// The Core opened at startup: the one the launch names, else the one last
/// connected from the connection page, else the default.
pub fn startup_url(launch: Result<Option<Url>, String>, saved: Option<Url>) -> Result<Url, String> {
    launch.map(|named| {
        named
            .or(saved)
            .unwrap_or_else(|| DEFAULT_CORE_URL.parse().expect("valid default Core URL"))
    })
}

/// Startup's choice when nothing was saved (tests).
#[cfg(test)]
pub(crate) fn configured_url(
    args: impl IntoIterator<Item = String>,
    env: Option<String>,
) -> Result<Url, String> {
    startup_url(launch_url(args, env), None)
}

/// What is kept of the Core last connected from the connection page.
pub fn saved_record(core: &Url) -> String {
    serde_json::json!({ "coreUrl": core.as_str() }).to_string()
}

/// The Core in a saved record, if it is one this app would accept now.
pub fn saved_core(bytes: &[u8]) -> Option<Url> {
    if bytes.len() > 4096 {
        return None;
    }
    let record: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    parse_core_url(record["coreUrl"].as_str()?).ok()
}

pub fn parse_core_url(input: &str) -> Result<Url, String> {
    let input = input.trim();
    if input.is_empty() || input.chars().any(char::is_control) || input.contains('\\') {
        return Err("Enter a complete Core URL, for example http://127.0.0.1:4317.".into());
    }
    let url = Url::parse(input).map_err(|_| "This Core URL is not valid.".to_owned())?;
    if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback(&url)) {
        return Err("Use HTTP on localhost, or HTTPS for another host. A Windows-to-WSL connection normally uses localhost.".into());
    }
    if url.host_str().is_none() || url.host_str() == Some("tauri.localhost") {
        return Err("Choose the Core host, not the desktop application's local origin.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Core URLs cannot contain a username or password.".into());
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(
            "Enter only the Core origin (host and port), without a path, query, or fragment."
                .into(),
        );
    }
    if url.port() == Some(0) {
        return Err("The Core port must be between 1 and 65535.".into());
    }
    Ok(url)
}

/// A host on this computer.
pub fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(host)) => host == "localhost",
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

pub fn desktop_url(core: &Url) -> Url {
    let mut url = core.clone();
    url.set_query(Some("shell=desktop"));
    url
}

pub fn is_connection_page(url: &Url) -> bool {
    let local_origin = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http"
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none());
    // On macOS the window first opens `tauri://localhost`, whose path (not a
    // special scheme's) is empty rather than "/".
    local_origin
        && matches!(url.path(), "" | "/" | "/index.html")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

pub fn permits_navigation(url: &Url, selected_core: Option<&Url>) -> bool {
    is_connection_page(url) || selected_core.is_some_and(|core| url.origin() == core.origin())
}

/// Links the window does not open itself but hands to the system: web pages
/// and mail. Never local files, scripts or other app schemes.
pub fn opens_outside(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/// What became of a link the window does not open itself.
#[derive(Debug, PartialEq, Eq)]
pub enum Outside {
    /// Not a web page or mail address: never handed to the system.
    Kept,
    Opened,
    Failed(String),
}

/// Hands a web page or mail link to `open` once; anything else stays here.
pub fn hand_outside(url: &Url, open: impl FnOnce(&str) -> Result<(), String>) -> Outside {
    if !opens_outside(url) {
        return Outside::Kept;
    }
    match open(url.as_str()) {
        Ok(()) => Outside::Opened,
        Err(error) => Outside::Failed(error),
    }
}

/// A script that tells the page a link could not be opened. The message is
/// inserted as text, never as markup. A newer notice replaces an older one,
/// and it goes away by itself.
pub fn open_failure_notice(url: &Url, error: &str) -> String {
    let message = format!(
        "Yuzuno couldn't open {} in your browser: {}. Right-click the link to copy it.",
        shortened(url.as_str(), 160),
        shortened(error, 200)
    );
    let message = serde_json::to_string(&message).expect("a string serializes");
    format!(
        r##"(() => {{
  const id = "yuzuno-open-failure";
  document.getElementById(id)?.remove();
  const notice = document.createElement("div");
  notice.id = id;
  notice.setAttribute("role", "alert");
  Object.assign(notice.style, {{
    position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)",
    zIndex: "2147483647", maxWidth: "min(560px, calc(100vw - 32px))", display: "flex",
    gap: "12px", alignItems: "flex-start", padding: "12px 16px", borderRadius: "10px",
    background: "#3b2f1e", color: "#fffaf0", font: "13px/1.45 system-ui, sans-serif",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
  }});
  const text = document.createElement("div");
  text.textContent = {message};
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  Object.assign(dismiss.style, {{
    flex: "none", border: "0", borderRadius: "6px", padding: "2px 8px",
    background: "#fffaf0", color: "#3b2f1e", font: "inherit", cursor: "pointer",
  }});
  dismiss.addEventListener("click", () => notice.remove());
  notice.append(text, dismiss);
  document.body.append(notice);
  setTimeout(() => notice.remove(), 12000);
}})();"##
    )
}

fn shortened(text: &str, limit: usize) -> String {
    let mut chars = text.chars();
    let mut short: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        short.push('…');
    }
    short
}

pub fn permits_appearance(window_label: &str, url: &Url, selected_core: Option<&Url>) -> bool {
    window_label == "main" && permits_navigation(url, selected_core)
}

/// The selected workspace itself, not the connection page: desktop updates
/// are asked for from there.
pub fn permits_workspace(window_label: &str, url: &Url, selected_core: Option<&Url>) -> bool {
    window_label == "main" && selected_core.is_some_and(|core| url.origin() == core.origin())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_updates_are_asked_for_only_from_the_selected_workspace() {
        let core = Url::parse("http://127.0.0.1:4317").unwrap();
        let workspace = Url::parse("http://127.0.0.1:4317/?shell=desktop").unwrap();
        assert!(permits_workspace("main", &workspace, Some(&core)));
        assert!(!permits_workspace("other", &workspace, Some(&core)));
        assert!(!permits_workspace("main", &workspace, None));
        for url in ["http://tauri.localhost/index.html", "http://127.0.0.1:4318/", "https://example.com/"] {
            assert!(!permits_workspace("main", &Url::parse(url).unwrap(), Some(&core)), "{url}");
        }
        assert!(is_loopback(&core));
        assert!(is_loopback(&Url::parse("http://localhost:4321").unwrap()));
        assert!(is_loopback(&Url::parse("http://[::1]:4321").unwrap()));
        assert!(!is_loopback(&Url::parse("https://core.example.com").unwrap()));
    }

    #[test]
    fn windows_to_wsl_defaults_to_loopback_and_cli_overrides_environment() {
        assert_eq!(
            configured_url([], None).unwrap().as_str(),
            "http://127.0.0.1:4317/"
        );
        let url = configured_url(
            ["--core-url".into(), "http://localhost:4321".into()],
            Some("https://old.example".into()),
        )
        .unwrap();
        assert_eq!(
            desktop_url(&url).as_str(),
            "http://localhost:4321/?shell=desktop"
        );
        assert_eq!(
            configured_url(["--core-url=https://workspace.example".into()], None)
                .unwrap()
                .host_str(),
            Some("workspace.example")
        );
    }

    #[test]
    fn rejects_ambiguous_arguments_instead_of_opening_another_workspace() {
        for args in [
            vec!["--core-url"],
            vec!["--core-url="],
            vec!["--wat"],
            vec![
                "--core-url=http://localhost:1",
                "--core-url=http://localhost:2",
            ],
        ] {
            assert!(configured_url(args.into_iter().map(str::to_owned), None).is_err());
        }
        assert!(configured_url([], Some("".into())).is_err());
    }

    #[test]
    fn a_finder_launch_names_no_core() {
        assert_eq!(launch_url(["-psn_0_12345".into()], None), Ok(None));
        assert_eq!(
            launch_url(
                [
                    "-psn_0_12345".into(),
                    "--core-url=http://127.0.0.1:5317".into()
                ],
                None
            )
            .unwrap()
            .unwrap()
            .as_str(),
            "http://127.0.0.1:5317/"
        );
    }

    #[test]
    fn the_core_last_connected_opens_unless_the_launch_names_one() {
        let saved =
            saved_core(saved_record(&parse_core_url("http://127.0.0.1:5317").unwrap()).as_bytes());
        assert_eq!(
            saved.as_ref().map(Url::as_str),
            Some("http://127.0.0.1:5317/")
        );
        // Nothing named: the saved Core, else the default.
        assert_eq!(
            startup_url(launch_url([], None), saved.clone())
                .unwrap()
                .as_str(),
            "http://127.0.0.1:5317/"
        );
        assert_eq!(
            startup_url(launch_url([], None), None).unwrap().as_str(),
            "http://127.0.0.1:4317/"
        );
        // The launch and the environment come first.
        assert_eq!(
            startup_url(
                launch_url(["--core-url=http://localhost:4321".into()], None),
                saved.clone()
            )
            .unwrap()
            .as_str(),
            "http://localhost:4321/"
        );
        assert_eq!(
            startup_url(
                launch_url([], Some("http://localhost:4400".into())),
                saved.clone()
            )
            .unwrap()
            .as_str(),
            "http://localhost:4400/"
        );
        // A mistaken launch is shown, never replaced by the saved Core.
        assert!(startup_url(launch_url(["--wat".into()], None), saved).is_err());
        // A record this app would not accept now is not used.
        for bytes in [
            &b"not json"[..],
            br#"{"coreUrl":"http://192.168.1.10:4317"}"#,
            br#"{"coreUrl":"http://127.0.0.1:4317/agents"}"#,
            br#"{"other":"http://127.0.0.1:4317"}"#,
        ] {
            assert_eq!(
                saved_core(bytes),
                None,
                "{}",
                String::from_utf8_lossy(bytes)
            );
        }
        assert_eq!(saved_core(&vec![b' '; 5000]), None);
    }

    #[test]
    fn accepts_loopback_and_https_without_credentials_or_subpaths() {
        for input in [
            "http://localhost:4317",
            "http://127.0.0.1:4317",
            "http://[::1]:4317",
            "https://workspace.example",
            " https://workspace.example:4443/ ",
        ] {
            assert!(parse_core_url(input).is_ok(), "{input}");
        }
    }

    #[test]
    fn rejects_credentials_paths_lan_http_and_script_origins() {
        for input in [
            "javascript:alert(1)",
            "file:///tmp/index.html",
            "http://192.168.1.2:4317",
            "http://localhost.evil.example",
            "https://user:secret@example.com",
            "https://example.com/?token=secret",
            "https://example.com/#token",
            "https://example.com/workspace",
            "http://localhost:0",
            "https://tauri.localhost",
            "http://local\nhost",
            r"http://localhost\evil",
        ] {
            assert!(parse_core_url(input).is_err(), "{input}");
        }
    }

    #[test]
    fn native_commands_are_only_for_exact_embedded_connection_page() {
        for input in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
        ] {
            assert!(is_connection_page(&Url::parse(input).unwrap()), "{input}");
        }
        assert_eq!(Url::parse("tauri://localhost").unwrap().path(), "");
        for input in [
            "http://127.0.0.1:4317",
            "https://tauri.localhost/index.html",
            "http://tauri.localhost:123/index.html",
            "tauri://localhost/other.html",
            "tauri://localhost/index.html?x=1",
            "tauri://localhost?x=1",
            "tauri://localhost#x",
            "tauri://other",
        ] {
            assert!(!is_connection_page(&Url::parse(input).unwrap()), "{input}");
        }
    }

    #[test]
    fn navigation_stays_with_selected_workspace() {
        let core = parse_core_url("http://127.0.0.1:4317").unwrap();
        assert!(permits_navigation(&desktop_url(&core), Some(&core)));
        assert!(permits_navigation(
            &core.join("api/artifact?path=report.md").unwrap(),
            Some(&core)
        ));
        assert!(!permits_navigation(
            &Url::parse("http://127.0.0.1:4318/").unwrap(),
            Some(&core)
        ));
        assert!(!permits_navigation(
            &Url::parse("https://example.com").unwrap(),
            Some(&core)
        ));
        assert!(!permits_navigation(&core, None));
    }

    #[test]
    fn only_web_pages_and_mail_go_to_the_system() {
        for link in ["https://example.com/a?b#c", "http://127.0.0.1:4318/", "mailto:me@example.com"] {
            assert!(opens_outside(&Url::parse(link).unwrap()), "{link}");
        }
        for link in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "tauri://localhost/index.html",
            "data:text/html,hi",
        ] {
            assert!(!opens_outside(&Url::parse(link).unwrap()), "{link}");
        }
    }

    #[test]
    fn a_link_is_handed_to_the_system_once_or_not_at_all() {
        let mut calls = Vec::new();
        let page = Url::parse("https://example.com/a?b#c").unwrap();
        let opened = hand_outside(&page, |link| {
            calls.push(link.to_owned());
            Ok(())
        });
        assert_eq!((opened, calls), (Outside::Opened, vec![page.to_string()]));
        for kept in ["file:///C:/notes.md", "javascript:alert(1)", "tel:+15550100"] {
            let url = Url::parse(kept).unwrap();
            assert_eq!(hand_outside(&url, |_| panic!("{kept} was handed over")), Outside::Kept);
        }
        let mail = Url::parse("mailto:me@example.com").unwrap();
        assert_eq!(
            hand_outside(&mail, |_| Err("no mail app".into())),
            Outside::Failed("no mail app".into())
        );
    }

    #[test]
    fn a_failed_open_is_told_in_the_page_as_text() {
        let url = Url::parse("https://example.com/report").unwrap();
        let error = r#"Access is denied. "quoted" \ </div><img src=x onerror=alert(1)>"#;
        let script = open_failure_notice(&url, error);
        let message = format!(
            "Yuzuno couldn't open https://example.com/report in your browser: {error}. Right-click the link to copy it."
        );
        // The whole message is one JSON (and so JavaScript) string literal,
        // given to textContent: quotes, backslashes and markup stay text.
        let literal = serde_json::to_string(&message).unwrap();
        assert!(script.contains(&format!("text.textContent = {literal};")), "{script}");
        assert_eq!(script.matches("onerror").count(), 1);
        assert!(!script.contains("innerHTML") && !script.contains("insertAdjacentHTML"));
        assert!(script.contains(r#"setAttribute("role", "alert")"#));
        // Long URLs and errors are cut, so the notice stays small.
        let long = open_failure_notice(&Url::parse(&format!("https://e.com/{}", "a".repeat(400))).unwrap(), &"b".repeat(400));
        assert!(long.contains('…') && !long.contains(&"a".repeat(200)) && !long.contains(&"b".repeat(201)));
    }

    #[test]
    fn appearance_is_limited_to_main_and_current_selected_origin() {
        let core = parse_core_url("http://localhost:4321").unwrap();
        let previous = parse_core_url("http://localhost:4317").unwrap();
        let embedded = Url::parse("http://tauri.localhost/index.html").unwrap();
        assert!(permits_appearance("main", &desktop_url(&core), Some(&core)));
        assert!(permits_appearance("main", &embedded, None));
        assert!(!permits_appearance(
            "other",
            &desktop_url(&core),
            Some(&core)
        ));
        assert!(!permits_appearance(
            "main",
            &desktop_url(&previous),
            Some(&core)
        ));
        assert!(!permits_appearance("main", &desktop_url(&core), None));
        assert!(!permits_appearance(
            "main",
            &Url::parse("https://unselected.example").unwrap(),
            Some(&core)
        ));
    }
}
