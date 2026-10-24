//! What this iPhone app may connect to and show, a Workspace Core's HTTPS
//! origin and nothing else, and which links it hands to Safari or Mail. No
//! dependencies but `url`, so `cargo test` checks it on any host.

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

/// Where a navigation of the window goes.
#[derive(Debug, PartialEq)]
pub enum Destination {
    /// The window shows it.
    Window,
    /// Safari or Mail opens this link; the window stays where it is.
    Outside(Url),
    /// Nothing opens it.
    Nowhere,
}

/// Where the window's navigation to `url` goes. The window shows this app's
/// own pages and the connected Core (`selected`); a web page or mail link
/// elsewhere opens in Safari or Mail. A link that asked for a new window
/// comes as a `yuzuno-open:` navigation (new_window_links.js): it never
/// opens in the window, and its link goes outside only by the same rule.
pub fn destination(url: &Url, selected: Option<&Url>) -> Destination {
    if url.scheme() == "yuzuno-open" {
        return requested_link(url).filter(opens_outside).map_or(Destination::Nowhere, Destination::Outside);
    }
    if may_open(url, selected) {
        Destination::Window
    } else if opens_outside(url) {
        Destination::Outside(url.clone())
    } else {
        Destination::Nowhere
    }
}

/// The link in a `yuzuno-open:` navigation, decoded once, if it is exactly
/// what new_window_links.js sends: `encodeURIComponent` of a URL. None for
/// any other character, a `%` without two hex digits, or text that is not
/// UTF-8; nor for a URL with space around it, or a control character or a
/// backslash in it.
fn requested_link(url: &Url) -> Option<Url> {
    let encoded = url.as_str().strip_prefix("yuzuno-open:")?;
    let encodes = |byte: u8| byte.is_ascii_alphanumeric() || b"-_.!~*'()%".contains(&byte);
    if !encoded.bytes().all(encodes) {
        return None;
    }
    let mut decoded = Vec::with_capacity(encoded.len());
    let mut rest = encoded.as_bytes();
    while let Some((&byte, tail)) = rest.split_first() {
        if byte == b'%' {
            let hex = tail.get(..2).filter(|hex| hex.iter().all(u8::is_ascii_hexdigit))?;
            decoded.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            rest = &tail[2..];
        } else {
            decoded.push(byte);
            rest = tail;
        }
    }
    let link = String::from_utf8(decoded).ok()?;
    if link.trim() != link || link.chars().any(|c| c.is_control() || c == '\\') {
        return None;
    }
    Url::parse(&link).ok()
}

/// Whether the window may go to `url`: this app's own pages, or the Core the
/// connection page connected to, by origin. Anything else stays unopened.
fn may_open(url: &Url, selected: Option<&Url>) -> bool {
    match url.scheme() {
        // The app's own pages: `tauri://localhost` on iOS and macOS.
        "tauri" => url.host_str() == Some("localhost"),
        "about" => url.as_str() == "about:blank",
        _ => selected.is_some_and(|core| core.origin() == url.origin()),
    }
}

/// A link the window does not open itself that is handed to the system
/// instead (Safari, Mail), as the desktop app hands it on: web pages and
/// mail only, never other schemes.
fn opens_outside(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
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

    #[test]
    fn each_navigation_goes_to_the_window_outside_or_nowhere() {
        let core = parse("https://core.example.ts.net").unwrap();
        let go = |url: &str| destination(&Url::parse(url).unwrap(), Some(&core));
        let outside = |url: &str| Destination::Outside(Url::parse(url).unwrap());
        assert_eq!(go("tauri://localhost/index.html"), Destination::Window);
        assert_eq!(go("https://core.example.ts.net/agents/a"), Destination::Window);
        assert_eq!(go("https://github.com/YuzukiS/Yuzuno"), outside("https://github.com/YuzukiS/Yuzuno"));
        assert_eq!(go("mailto:someone@example.com"), outside("mailto:someone@example.com"));
        assert_eq!(go("tel:+15555550100"), Destination::Nowhere);
        assert_eq!(go("file:///etc/hosts"), Destination::Nowhere);
    }

    #[test]
    fn a_new_window_link_opens_outside_or_nowhere_never_in_the_window() {
        let core = parse("https://core.example.ts.net").unwrap();
        let go = |url: &str| destination(&Url::parse(url).unwrap(), Some(&core));
        // As new_window_links.js sends them: `encodeURIComponent` of the link.
        for (request, link) in [
            // The Core's own attachment, decoded once: its %2F stays (decoded
            // twice, it would be a path).
            (
                "yuzuno-open:https%3A%2F%2Fcore.example.ts.net%2Fapi%2Fattachments%2Fa%252Fb%2520c.png",
                "https://core.example.ts.net/api/attachments/a%2Fb%20c.png",
            ),
            (
                "yuzuno-open:https%3A%2F%2Fgithub.com%2FYuzukiS%2FYuzuno%2Fpull%2F1%3Ftab%3Dfiles%23diff",
                "https://github.com/YuzukiS/Yuzuno/pull/1?tab=files#diff",
            ),
            ("yuzuno-open:http%3A%2F%2Fexample.com%2F", "http://example.com/"),
            ("yuzuno-open:mailto%3Asomeone%40example.com", "mailto:someone@example.com"),
        ] {
            assert_eq!(go(request), Destination::Outside(Url::parse(link).unwrap()), "{request}");
        }
        for refused in [
            "yuzuno-open:",
            "YUZUNO-OPEN:",
            // Not encoded, or with parts of its own.
            "yuzuno-open:https://example.com/",
            "yuzuno-open://example.com/",
            "yuzuno-open:https%3A%2F%2Fexample.com%2F?x",
            "yuzuno-open:https%3A%2F%2Fexample.com%2F#x",
            "yuzuno-open:https%3A%2F%2Fexample.com%2F+",
            // A request inside a request.
            "yuzuno-open:yuzuno-open%3Ahttps%253A%252F%252Fexample.com%252F",
            // Other schemes, the Core's own pages' and this app's included.
            "yuzuno-open:javascript%3Aalert(1)",
            "yuzuno-open:file%3A%2F%2F%2Fetc%2Fhosts",
            "yuzuno-open:tauri%3A%2F%2Flocalhost%2Findex.html",
            "yuzuno-open:tel%3A%2B15555550100",
            // Bad encoding.
            "yuzuno-open:https%3A%2F%2Fexample.com%2F%zz",
            "yuzuno-open:https%3A%2F%2Fexample.com%2F%2",
            "yuzuno-open:https%3A%2F%2Fexample.com%2F%",
            "yuzuno-open:https%3A%2F%2Fexample.com%2F%FF",
            // Space around, a control character or a backslash in it.
            "yuzuno-open:%20https%3A%2F%2Fexample.com%2F",
            "yuzuno-open:https%3A%2F%2Fexa%0Ample.com%2F",
            "yuzuno-open:https%3A%5C%5Cexample.com%5C",
            // Not a URL.
            "yuzuno-open:https%3A",
        ] {
            assert_eq!(go(refused), Destination::Nowhere, "{refused}");
        }
        // A link to the Core's own page opens outside too, not in the window.
        let own = "yuzuno-open:https%3A%2F%2Fcore.example.ts.net%2F";
        assert_eq!(go(own), Destination::Outside(core.clone()));
        assert_eq!(destination(&Url::parse(own).unwrap(), None), Destination::Outside(core.clone()));
    }

    #[test]
    fn only_web_pages_and_mail_are_handed_to_the_system() {
        for (url, outside) in [
            ("https://github.com/YuzukiS/Yuzuno", true),
            ("http://example.com/", true),
            ("mailto:someone@example.com", true),
            ("file:///etc/hosts", false),
            ("javascript:alert(1)", false),
            ("tel:+15555550100", false),
            ("shortcuts://run-shortcut", false),
        ] {
            assert_eq!(opens_outside(&Url::parse(url).unwrap()), outside, "{url}");
        }
    }
}
