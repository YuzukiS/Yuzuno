//! Sending one message to a push service: Core's only HTTPS client. It
//! trusts the roots webpki-roots carries (the push services' certificates
//! chain to them), follows no redirect and waits a bounded time.
use anyhow::{Context, Result};
use axum::{body::Bytes, http};
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use std::{sync::Arc, time::Duration};

const WAIT: Duration = Duration::from_secs(15);
/// What is read of an answer's body: enough for a push service's reason.
const ANSWER_BYTES: usize = 1024;

pub(super) type Https = Client<hyper_rustls::HttpsConnector<HttpConnector>, Full<Bytes>>;

pub(super) fn client() -> Result<Https> {
    let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .context("TLS for push notifications")?
        .with_root_certificates(roots)
        .with_no_client_auth();
    let https = hyper_rustls::HttpsConnectorBuilder::new().with_tls_config(tls).https_only().enable_http1().build();
    Ok(Client::builder(hyper_util::rt::TokioExecutor::new()).build(https))
}

/// One message as the push service gets it (RFC 8030 §5, RFC 8292 §3).
#[derive(Clone, Debug)]
pub(super) struct Outgoing {
    pub endpoint: String,
    pub authorization: String,
    pub ttl: u32,
    pub urgency: &'static str,
    pub topic: String,
    pub body: Vec<u8>,
}

/// What a push service answered.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Answer {
    Accepted,
    /// The subscription is gone (404, 410): never sent to again.
    Gone(u16),
    /// Refused for good (a bad token or key, too large, any other answer):
    /// sending the same again would be refused again.
    Refused(u16, String),
    /// Maybe another time (429, 5xx, no answer): counted, not retried.
    Unanswered(String),
}

pub(super) fn answer(status: u16, said: &str) -> Answer {
    match status {
        200..=299 => Answer::Accepted,
        404 | 410 => Answer::Gone(status),
        429 | 500..=599 => Answer::Unanswered(format!("HTTP {status}")),
        _ => Answer::Refused(status, reason(said)),
    }
}

/// A push service's reason, as plain short text: Apple's `{"reason":…}`, or
/// the body's first characters.
fn reason(said: &str) -> String {
    let text = serde_json::from_str::<serde_json::Value>(said).ok()
        .and_then(|v| v["reason"].as_str().map(str::to_owned))
        .unwrap_or_else(|| said.to_owned());
    text.chars().filter(|c| !c.is_control()).take(120).collect::<String>().trim().to_owned()
}

pub(super) async fn post(client: &Https, out: &Outgoing) -> Answer {
    let request = http::Request::post(&out.endpoint)
        .header("TTL", out.ttl)
        .header("Urgency", out.urgency)
        .header("Topic", &out.topic)
        .header(http::header::CONTENT_ENCODING, "aes128gcm")
        .header(http::header::CONTENT_TYPE, "application/octet-stream")
        .header(http::header::AUTHORIZATION, &out.authorization)
        .body(Full::new(Bytes::from(out.body.clone())));
    let request = match request {
        Ok(request) => request,
        Err(error) => return Answer::Refused(0, format!("not sent: {error}")),
    };
    match tokio::time::timeout(WAIT, async {
        let response = client.request(request).await?;
        let status = response.status().as_u16();
        let said = Limited::new(response.into_body(), ANSWER_BYTES).collect().await
            .map(|body| String::from_utf8_lossy(&body.to_bytes()).into_owned())
            .unwrap_or_default();
        Ok::<_, hyper_util::client::legacy::Error>((status, said))
    }).await {
        Ok(Ok((status, said))) => answer(status, &said),
        Ok(Err(error)) => Answer::Unanswered(format!("not delivered: {error}")),
        Err(_) => Answer::Unanswered(format!("no answer within {} s", WAIT.as_secs())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_are_read_as_rfc8030_and_apple_give_them() {
        assert_eq!(answer(201, ""), Answer::Accepted);
        assert_eq!(answer(410, ""), Answer::Gone(410));
        assert_eq!(answer(404, ""), Answer::Gone(404));
        assert_eq!(answer(403, r#"{"reason":"BadJwtToken"}"#), Answer::Refused(403, "BadJwtToken".into()));
        assert_eq!(answer(413, "too\nlarge"), Answer::Refused(413, "toolarge".into()));
        assert_eq!(answer(301, ""), Answer::Refused(301, String::new()), "a redirect is not followed");
        assert_eq!(answer(429, ""), Answer::Unanswered("HTTP 429".into()));
        assert_eq!(answer(503, ""), Answer::Unanswered("HTTP 503".into()));
        assert_eq!(reason(&"x".repeat(500)).len(), 120);
    }

    #[tokio::test]
    async fn plain_http_is_never_used() {
        let client = client().unwrap();
        let out = Outgoing { endpoint: "http://127.0.0.1:9/x".into(), authorization: "vapid t=x, k=y".into(),
            ttl: 60, urgency: "normal", topic: "t".into(), body: vec![] };
        let Answer::Unanswered(why) = post(&client, &out).await else { panic!("sent over plain HTTP") };
        assert!(why.contains("not delivered"), "{why}");
    }
}
