//! What this iPhone app may connect to and show: a Workspace Core's HTTPS
//! origin, and nothing else. No dependencies but `url`, so `cargo test`
//! checks it on any host.

use url::{Host, Url};

/// A Core's address as entered: an HTTPS origin, such as the Core's Tailnet
/// address (`https://core.example.ts.net`). A phone's loopback is the phone
/// itself, where no Core runs, so neither plain HTTP nor a loopback host is
/// a Core here (the desktop app accepts HTTP on loopback; desktop/README.md).
pub fn parse(input: &str) -> Result<Url, String> {
    let input = input.trim();
    if input.is_empty() || input.chars().any(char::is_control) || input.contains('\\') {
        return Err("Enter your Workspace's address, for example https://core.example.ts.net.".into());
    }
    let url = Url::parse(input).map_err(|_| "This address is not valid.".to_owned())?;
    if url.scheme() != "https" {
        return Err("Use your Workspace's HTTPS address. This app does not connect over plain HTTP.".into());
    }
    let loopback = match url.host() {
        None => true,
        Some(Host::Ipv4(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Some(Host::Ipv6(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Some(Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost")
        }
    };
    if loopback {
        return Err("That address is this iPhone itself. Enter the address of the computer your Workspace runs on.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("A Workspace address cannot contain a username or password.".into());
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("Enter only the Workspace's address (host and port), without a path, query, or fragment.".into());
    }
    if url.port() == Some(0) {
        return Err("The port must be between 1 and 65535.".into());
    }
    Ok(url)
}

/// Whether the window may go to `url`: this app's own pages, or the Core the
/// connection page connected to, by origin. Anything else stays unopened.
pub fn may_open(url: &Url, selected: Option<&Url>) -> bool {
    match url.scheme() {
        // The app's own pages: `tauri://localhost` on iOS and macOS.
        "tauri" => url.host_str() == Some("localhost"),
        "about" => url.as_str() == "about:blank",
        _ => selected.is_some_and(|core| core.origin() == url.origin()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_core_is_an_https_origin_off_this_phone() {
        assert_eq!(parse(" https://core.example.ts.net ").unwrap().as_str(), "https://core.example.ts.net/");
        assert_eq!(parse("https://core.example.ts.net:8443/").unwrap().as_str(), "https://core.example.ts.net:8443/");
        assert_eq!(parse("https://100.64.0.7").unwrap().as_str(), "https://100.64.0.7/");
        for refused in [
            "",
            "core.example.ts.net",
            "http://core.example.ts.net",
            "http://127.0.0.1:4317",
            "https://127.0.0.1:4317",
            "https://localhost",
            "https://LOCALHOST.",
            "https://tauri.localhost",
            "https://[::1]:4317",
            "https://0.0.0.0",
            "https://user:secret@core.example.ts.net",
            "https://core.example.ts.net/workspace",
            "https://core.example.ts.net/?shell=ios",
            "https://core.example.ts.net/#home",
            "https://core.example.ts.net:0",
            "https://core.example.ts.net\\",
            "https://core.example\n.ts.net",
        ] {
            assert!(parse(refused).is_err(), "{refused:?} was accepted");
        }
    }

    #[test]
    fn the_window_opens_only_this_app_and_the_connected_core() {
        let core = parse("https://core.example.ts.net").unwrap();
        let open = |url: &str, selected| may_open(&Url::parse(url).unwrap(), selected);
        assert!(open("tauri://localhost/index.html", None));
        assert!(open("about:blank", None));
        assert!(open("https://core.example.ts.net/", Some(&core)));
        assert!(open("https://core.example.ts.net/agents/a?x=1#y", Some(&core)));
        assert!(!open("https://core.example.ts.net/", None), "no Core connected yet");
        assert!(!open("https://core.example.ts.net:8443/", Some(&core)), "another port is another origin");
        assert!(!open("http://core.example.ts.net/", Some(&core)), "another scheme is another origin");
        assert!(!open("https://elsewhere.example/", Some(&core)));
        assert!(!open("tauri://elsewhere/", Some(&core)));
        assert!(!open("about:srcdoc", Some(&core)));
        assert!(!open("file:///etc/hosts", Some(&core)));
    }
}
