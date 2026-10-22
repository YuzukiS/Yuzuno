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

/// What is kept of the Core last connected from the connection page, and
/// where it is installed in WSL when it said so (T-171).
pub fn saved_record(core: &Url, start: Option<&StartProfile>) -> String {
    let mut record = serde_json::json!({ "coreUrl": core.as_str() });
    if let Some(start) = start {
        record["start"] = serde_json::json!({
            "wslDistro": start.wsl_distro,
            "user": start.user,
            "installDir": start.install_dir,
            "workspaceId": start.workspace_id,
            "confirmed": start.confirmed,
        });
    }
    record.to_string()
}

fn saved_json(bytes: &[u8]) -> Option<serde_json::Value> {
    if bytes.len() > 4096 {
        return None;
    }
    serde_json::from_slice(bytes).ok()
}

/// The Core in a saved record, if it is one this app would accept now.
pub fn saved_core(bytes: &[u8]) -> Option<Url> {
    parse_core_url(saved_json(bytes)?["coreUrl"].as_str()?).ok()
}

/// The saved Core's start profile, checked again as when it was saved. A
/// record without `confirmed` (from before it) is not confirmed.
pub fn saved_start(bytes: &[u8]) -> Option<StartProfile> {
    let record = saved_json(bytes)?;
    let core = parse_core_url(record["coreUrl"].as_str()?).ok()?;
    let start = &record["start"];
    let profile = StartProfile::new(
        &core,
        start["wslDistro"].as_str()?,
        start["user"].as_str()?,
        start["installDir"].as_str()?,
        start["workspaceId"].as_str()?,
    )?;
    Some(StartProfile { confirmed: start["confirmed"] == true, ..profile })
}

/// Where a Core says it is installed in WSL (`/api/desktop/start-profile`),
/// as it said when the user connected to it, so the connection page can
/// start it again (T-171). Only a loopback Core has one; each part is
/// checked, since it becomes part of one fixed `wsl.exe` command.
///
/// A loopback address does not show that the Core is on this computer: an
/// SSH tunnel's local port may lead to another computer's Core, which says
/// where it is installed there. So a profile starts out not `confirmed`,
/// and only a start that this computer's own start entry accepted for this
/// installation confirms it ([`settle`]). A confirmation is kept until the
/// Core says something else: it is not tied to a boot, so it holds after
/// Windows or WSL restarts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartProfile {
    /// The Core's origin; its port is the one the Core starts on.
    pub core: Url,
    pub wsl_distro: String,
    pub user: String,
    pub install_dir: String,
    pub workspace_id: String,
    /// This computer's start entry has accepted this installation.
    pub confirmed: bool,
}

impl StartProfile {
    pub fn new(core: &Url, wsl_distro: &str, user: &str, install_dir: &str, workspace_id: &str) -> Option<Self> {
        let named = |text: &str, max: usize, more: &[char]| {
            !text.is_empty()
                && text.len() <= max
                && text.chars().all(|c| c.is_ascii_alphanumeric() || more.contains(&c))
        };
        let path_ok = install_dir.starts_with('/')
            && install_dir.len() <= 512
            && install_dir.chars().all(|c| c.is_ascii_alphanumeric() || "._-+@/".contains(c))
            && install_dir[1..].split('/').all(|part| !matches!(part, "" | "." | ".."))
            // Windows folders seen from WSL: not a Linux installation.
            && !install_dir.starts_with("/mnt/");
        let ok = is_loopback(core)
            && core.port_or_known_default().is_some()
            && named(wsl_distro, 64, &['.', '_', '-'])
            && !wsl_distro.starts_with(['-', '.'])
            && named(user, 32, &['_', '-'])
            && !user.starts_with('-')
            && path_ok
            && named(workspace_id, 64, &['-', '_']);
        ok.then(|| Self {
            core: core.clone(),
            wsl_distro: wsl_distro.into(),
            user: user.into(),
            install_dir: install_dir.into(),
            workspace_id: workspace_id.into(),
            confirmed: false,
        })
    }

    /// The same Core, installation and Workspace, confirmed or not.
    pub fn same_target(&self, other: &Self) -> bool {
        self.core == other.core
            && self.wsl_distro == other.wsl_distro
            && self.user == other.user
            && self.install_dir == other.install_dir
            && self.workspace_id == other.workspace_id
    }

    /// From a Core's start-profile answer, for the Core at `core` whose
    /// health named `workspace_id`; None when it offers none or it differs.
    pub fn offered(core: &Url, workspace_id: &str, profile: &serde_json::Value) -> Option<Self> {
        if profile["available"] != true
            || profile["workspaceId"] != workspace_id
            || profile["port"].as_u64() != core.port_or_known_default().map(u64::from)
        {
            return None;
        }
        Self::new(
            core,
            profile["wslDistro"].as_str()?,
            profile["user"].as_str()?,
            profile["installDir"].as_str()?,
            workspace_id,
        )
    }

    /// The arguments to `wsl.exe`: run this installation's start entry as
    /// its user, in its distribution, with nothing else.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn wsl_arguments(&self) -> Vec<String> {
        let port = self.core.port_or_known_default().unwrap_or(4317).to_string();
        let entry = format!("{}/updates/start", self.install_dir);
        let arguments: [&str; 13] = [
            "--distribution",
            &self.wsl_distro,
            "--user",
            &self.user,
            "--exec",
            &entry,
            "start",
            "--install-dir",
            &self.install_dir,
            "--port",
            &port,
            "--workspace-id",
            &self.workspace_id,
        ];
        arguments.map(str::to_owned).to_vec()
    }
}

/// What a Core offers now, given what was saved: a confirmation stays only
/// for the very same target; anything new or changed starts unconfirmed.
pub fn merge_offered(previous: Option<&StartProfile>, offered: StartProfile) -> StartProfile {
    let confirmed = previous.is_some_and(|previous| previous.confirmed && previous.same_target(&offered));
    StartProfile { confirmed, ..offered }
}

/// What a start in WSL came to, as the start entry said it, or that it said
/// nothing in time.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum StartOutcome {
    /// The entry accepted this computer's installation (its folder, the
    /// recorded Workspace and port), started its Core, and the Core answered.
    Started,
    /// Accepted and started as above; the Core has not answered yet.
    Starting,
    /// The entry accepted the installation, then found the Workspace's Core
    /// already answering on its port and started nothing. What answers
    /// there may not be this installation's Core.
    Running,
    /// The entry refused: this computer's WSL has no installation there, it
    /// recorded no start, or it recorded another Workspace or port.
    NotHere(String),
    /// Anything else, with what was said: WSL could not run the entry, a
    /// permission, the port, Core exiting, …
    Failed(String),
    /// No result came within the wait. Nothing is known; nothing was stopped.
    Unanswered,
}

impl StartOutcome {
    /// The entry checked this installation and started its Core.
    pub fn confirms(&self) -> bool {
        matches!(self, Self::Started | Self::Starting)
    }
}

/// A start the page asked for: Core already answered (nothing ran in WSL),
/// or the start entry ran.
#[derive(Debug, PartialEq, Eq)]
pub enum Attempt {
    Answering,
    Ran(StartOutcome),
}

/// What becomes of the saved profile after an attempt.
#[derive(Debug, PartialEq, Eq)]
pub enum Settle {
    Keep,
    Confirm,
    /// Not confirmed and refused as not installed here: offered no more
    /// until the Core says again where it is.
    Forget,
}

/// Only the entry's own acceptance of this installation confirms a
/// profile, and only its definite refusal forgets an unconfirmed one. A Core
/// that answered over HTTP, the entry finding one already answering, no
/// result, and every other failure change nothing.
pub fn settle(profile: &StartProfile, attempt: &Attempt) -> Settle {
    match attempt {
        Attempt::Ran(outcome) if outcome.confirms() && !profile.confirmed => Settle::Confirm,
        Attempt::Ran(StartOutcome::NotHere(_)) if !profile.confirmed => Settle::Forget,
        _ => Settle::Keep,
    }
}

/// The start entry's one-line JSON result (`yuzuno-update-helper start`),
/// if `line` is it. The entry prints it as soon as it knows, then may stay
/// while Core runs, so the result is read before `wsl.exe` ends.
pub fn start_result_line(line: &str) -> Option<serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(line.trim()).ok().filter(|v| v["state"].is_string())
}

/// Reads the start entry's result, or says why WSL did not run it.
/// `output` is what `wsl.exe` printed. Only the entry's typed result counts;
/// WSL's own words are shown, never read for a cause.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn start_result(profile: &StartProfile, output: &str) -> StartOutcome {
    let result = output.lines().rev().find_map(start_result_line);
    let Some(result) = result else {
        let said = output.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("no output");
        // WSL's own log lines begin with a syslog level, such as "<3>".
        let said = said
            .strip_prefix('<')
            .and_then(|rest| rest.split_once('>'))
            .filter(|(level, _)| !level.is_empty() && level.chars().all(|c| c.is_ascii_digit()))
            .map_or(said, |(_, rest)| rest.trim());
        let said = said.trim_end_matches('.');
        return StartOutcome::Failed(format!(
            "WSL could not run Yuzuno's start in {}: {}. Start Core in WSL yourself, or check that the distribution and installation still exist.",
            profile.wsl_distro,
            shortened(said, 240)
        ));
    };
    let message = shortened(result["message"].as_str().unwrap_or(""), 300);
    let code = result["code"].as_str().unwrap_or("");
    match result["state"].as_str().unwrap_or("") {
        "started" => StartOutcome::Started,
        "starting" => StartOutcome::Starting,
        "running" => StartOutcome::Running,
        "refused" if code == "noRecord" => StartOutcome::NotHere(format!("{message} Then this button can start it.")),
        "refused" if matches!(code, "notInstalled" | "otherWorkspace" | "otherPort") => StartOutcome::NotHere(message),
        "failed" if code == "exited" => {
            let log = result["log"].as_str().unwrap_or("").trim();
            let last = log.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("");
            StartOutcome::Failed(format!("Core stopped while starting. {}", shortened(last, 300)).trim_end().to_owned())
        }
        _ => StartOutcome::Failed(if message.is_empty() { "Core could not be started.".into() } else { message }),
    }
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

    fn profile() -> StartProfile {
        StartProfile::new(
            &parse_core_url("http://127.0.0.1:4317").unwrap(),
            "Ubuntu-24.04",
            "ada",
            "/home/ada/.local/share/yuzuno-core",
            "4f9c2a1e-0b7d-4c55-9a51-2e0f6f1c3b8d",
        )
        .unwrap()
    }

    #[test]
    fn a_start_profile_is_kept_only_for_a_core_on_this_computer_that_offered_one() {
        let core = parse_core_url("http://127.0.0.1:4317").unwrap();
        let workspace = "4f9c2a1e-0b7d-4c55-9a51-2e0f6f1c3b8d";
        let offered = serde_json::json!({"available":true,"wslDistro":"Ubuntu-24.04","user":"ada",
            "installDir":"/home/ada/.local/share/yuzuno-core","port":4317,"workspaceId":workspace});
        assert_eq!(StartProfile::offered(&core, workspace, &offered), Some(profile()));
        // Saved and read back with the Core it belongs to.
        let saved = saved_record(&core, Some(&profile()));
        assert_eq!(saved_start(saved.as_bytes()), Some(profile()));
        assert_eq!(saved_core(saved.as_bytes()).as_ref(), Some(&core));
        // Older records and Cores without one.
        assert_eq!(saved_start(saved_record(&core, None).as_bytes()), None);
        assert_eq!(saved_start(br#"{"coreUrl":"http://127.0.0.1:4317"}"#), None);
        let mut refused = Vec::new();
        for (name, change) in [
            ("unavailable", serde_json::json!({"available":false})),
            ("another workspace", serde_json::json!({"workspaceId":"other"})),
            ("another port", serde_json::json!({"port":4318})),
            ("an option as distro", serde_json::json!({"wslDistro":"--system"})),
            ("a spaced distro", serde_json::json!({"wslDistro":"My Distro"})),
            ("an option as user", serde_json::json!({"user":"-root"})),
            ("a relative folder", serde_json::json!({"installDir":"home/ada/core"})),
            ("a parent folder", serde_json::json!({"installDir":"/home/ada/../root/core"})),
            ("a doubled slash", serde_json::json!({"installDir":"/home/ada//core"})),
            ("a shell character", serde_json::json!({"installDir":"/home/ada/core;rm"})),
            ("a space", serde_json::json!({"installDir":"/home/ada/my core"})),
            ("a Windows folder", serde_json::json!({"installDir":"/mnt/c/Users/Public/core"})),
        ] {
            let mut profile = offered.clone();
            for (key, value) in change.as_object().unwrap() {
                profile[key] = value.clone();
            }
            if StartProfile::offered(&core, workspace, &profile).is_none() {
                refused.push(name);
            }
        }
        assert_eq!(refused.len(), 12, "{refused:?}");
        // A Core reached at another address never gets one.
        let tunnel = parse_core_url("https://core.example.com").unwrap();
        assert_eq!(StartProfile::offered(&tunnel, workspace, &offered), None);
        // A saved profile that would not be accepted now is not used.
        let mut stale: serde_json::Value = serde_json::from_str(&saved).unwrap();
        stale["start"]["installDir"] = "/mnt/c/core".into();
        assert_eq!(saved_start(stale.to_string().as_bytes()), None);
    }

    #[test]
    fn the_start_runs_one_fixed_command_in_the_cores_distribution() {
        assert_eq!(
            profile().wsl_arguments(),
            [
                "--distribution", "Ubuntu-24.04", "--user", "ada", "--exec",
                "/home/ada/.local/share/yuzuno-core/updates/start", "start",
                "--install-dir", "/home/ada/.local/share/yuzuno-core",
                "--port", "4317", "--workspace-id", "4f9c2a1e-0b7d-4c55-9a51-2e0f6f1c3b8d",
            ]
        );
    }

    #[test]
    fn the_start_result_is_read_from_its_json_line() {
        let p = profile();
        use StartOutcome::*;
        assert_eq!(start_result(&p, r#"{"state":"started","pid":12,"releaseId":"r"}"#), Started);
        assert_eq!(start_result(&p, "noise\n{\"state\":\"running\"}\n"), Running);
        assert_eq!(start_result(&p, r#"{"state":"starting","pid":12}"#), Starting);
        // The line is recognized as it arrives, before wsl.exe ends.
        assert!(start_result_line("{\"state\":\"started\",\"pid\":12}\r").is_some());
        for line in ["", "Starting…", "{\"pid\":12}", "[1,2]", "{\"state\":3}"] {
            assert!(start_result_line(line).is_none(), "{line}");
        }
        // Not installed here, by the entry's own codes only.
        for (code, message) in [
            ("notInstalled", "No Yuzuno installation is at /home/ada/core."),
            ("otherWorkspace", "This installation's Core last opened another Workspace."),
            ("otherPort", "This installation's Core last ran on port 4318, not 4317."),
        ] {
            let line = serde_json::json!({"state":"refused","code":code,"message":message}).to_string();
            assert_eq!(start_result(&p, &line), NotHere(message.into()), "{code}");
        }
        let no_record = start_result(&p, r#"{"state":"refused","code":"noRecord","message":"This installation has not recorded how its Core starts. Start Core in WSL once with this version."}"#);
        assert!(matches!(&no_record, NotHere(message) if message.ends_with("Then this button can start it.")), "{no_record:?}");
        // Everything else is a failure with its words, never "not installed".
        let failed = |output: &str| match start_result(&p, output) {
            Failed(message) => message,
            other => panic!("{output}: {other:?}"),
        };
        for (code, state) in [("portInUse", "refused"), ("unsafeInstall", "refused"), ("busy", "refused"),
                              ("updating", "refused"), ("missingRelease", "failed"), ("spawn", "failed")] {
            let line = serde_json::json!({"state":state,"code":code,"message":"said"}).to_string();
            assert_eq!(failed(&line), "said", "{code}");
        }
        let exited = failed(r#"{"state":"failed","code":"exited","message":"Core exited before it answered (exit status: 1).","log":"loading\nError: Cannot bind Core's loopback port\n"}"#);
        assert_eq!(exited, "Core stopped while starting. Error: Cannot bind Core's loopback port");
        // WSL itself could not run it: its own words, shortened, and not
        // taken as "not installed", whatever they say.
        let missing = failed("There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n");
        assert!(missing.contains("Ubuntu-24.04: There is no distribution with the supplied name. Start"), "{missing}");
        let gone = failed("<3>WSL (812 - Relay) ERROR: CreateProcessCommon:818: execvpe(/home/ada/core/updates/start) failed: No such file or directory\n");
        assert!(gone.contains("Ubuntu-24.04: WSL (812 - Relay) ERROR: CreateProcessCommon:818: execvpe(/home/ada/core/updates/start) failed: No such file or directory. Start"), "{gone}");
        assert!(failed("").contains("no output"));
        assert!(failed(&"x".repeat(1000)).len() < 600);
    }

    #[test]
    fn only_the_start_entry_accepting_this_installation_confirms_a_profile() {
        use StartOutcome::*;
        let unconfirmed = profile();
        let confirmed = StartProfile { confirmed: true, ..profile() };
        assert!(!unconfirmed.confirmed, "a new profile is not confirmed");
        // The entry checked this installation and started its Core.
        for outcome in [Started, Starting] {
            assert_eq!(settle(&unconfirmed, &Attempt::Ran(outcome)), Settle::Confirm);
        }
        // Core answered over HTTP before anything ran in WSL, or the entry
        // found one already answering: no evidence about where it runs.
        assert_eq!(settle(&unconfirmed, &Attempt::Answering), Settle::Keep);
        assert_eq!(settle(&unconfirmed, &Attempt::Ran(Running)), Settle::Keep);
        // No result, and failures that are not "not installed here", keep
        // the profile as it was, confirmed or not.
        for outcome in [Unanswered, Failed("WSL could not run Yuzuno's start in Ubuntu-24.04: Access is denied".into())] {
            assert_eq!(settle(&unconfirmed, &Attempt::Ran(outcome)), Settle::Keep);
        }
        // Refused as not installed here: an unconfirmed profile goes, a
        // confirmed one stays (it was this computer's; the error is shown).
        let not_here = || Attempt::Ran(NotHere("This installation's Core last opened another Workspace.".into()));
        assert_eq!(settle(&unconfirmed, &not_here()), Settle::Forget);
        assert_eq!(settle(&confirmed, &not_here()), Settle::Keep);
        // A confirmed profile is never confirmed again or forgotten by these.
        for outcome in [Started, Starting, Running, Unanswered] {
            assert_eq!(settle(&confirmed, &Attempt::Ran(outcome)), Settle::Keep);
        }
    }

    #[test]
    fn a_confirmation_stays_only_with_the_same_target_and_outlasts_a_restart() {
        let confirmed = StartProfile { confirmed: true, ..profile() };
        // The same Core offers the same again: still confirmed.
        assert!(merge_offered(Some(&confirmed), profile()).confirmed);
        // Anything that changed makes it a new, unconfirmed profile.
        let changed = [
            StartProfile { wsl_distro: "Debian".into(), ..profile() },
            StartProfile { user: "grace".into(), ..profile() },
            StartProfile { install_dir: "/home/ada/other-core".into(), ..profile() },
            StartProfile { workspace_id: "5a0d3b2c-1e4f-4a6b-8c9d-0e1f2a3b4c5d".into(), ..profile() },
            StartProfile { core: parse_core_url("http://localhost:4317").unwrap(), ..profile() },
        ];
        for offered in changed {
            assert!(!merge_offered(Some(&confirmed), offered.clone()).confirmed, "{offered:?}");
        }
        assert!(!merge_offered(None, profile()).confirmed);
        assert!(!merge_offered(Some(&profile()), profile()).confirmed);
        // Saved and read back, as after the app, Windows or WSL restarts:
        // the confirmation is kept, with nothing tied to a boot.
        let core = parse_core_url("http://127.0.0.1:4317").unwrap();
        let saved = saved_record(&core, Some(&confirmed));
        assert_eq!(saved_start(saved.as_bytes()), Some(confirmed.clone()));
        assert_eq!(saved_start(saved_record(&core, Some(&profile())).as_bytes()), Some(profile()));
        // A record from before confirmation (no field), or anything but
        // true, is not confirmed: it is confirmed again by a start.
        let mut old: serde_json::Value = serde_json::from_str(&saved).unwrap();
        old["start"].as_object_mut().unwrap().remove("confirmed");
        assert_eq!(saved_start(old.to_string().as_bytes()), Some(profile()));
        old["start"]["confirmed"] = "true".into();
        assert_eq!(saved_start(old.to_string().as_bytes()), Some(profile()));
    }

    #[test]
    fn the_core_last_connected_opens_unless_the_launch_names_one() {
        let saved =
            saved_core(saved_record(&parse_core_url("http://127.0.0.1:5317").unwrap(), None).as_bytes());
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
