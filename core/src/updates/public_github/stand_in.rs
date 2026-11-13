//! A test-only GitHub for the public reader (YN-110): an HTTPS server on
//! 127.0.0.1 whose certificate is made for this run with ring (no key on disk
//! or in the repository), and an HTTP CONNECT proxy. Both keep the request
//! heads they were sent. Production readers never use either.
use super::PublicGithub;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::{
    io::{self, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

/// Where a test's reader goes instead of api.github.com, what it trusts there
/// and the environment it reads proxies from.
pub(crate) struct Host {
    pub base: String,
    pub root: CertificateDer<'static>,
    pub env: Vec<(&'static str, String)>,
}

/// The stand-in's answer to one request.
pub(crate) struct Answer {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
    pub wait: Duration,
}
impl Answer {
    pub fn status(status: u16) -> Self {
        Self { status, headers: Vec::new(), body: Vec::new(), wait: Duration::ZERO }
    }
    pub fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self { body: body.into(), ..Self::status(200) }
    }
    pub fn redirect(to: impl Into<String>) -> Self {
        Self::status(302).header("Location", to)
    }
    pub fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }
}

pub(crate) struct Server {
    pub port: u16,
    root: CertificateDer<'static>,
    seen: Arc<Mutex<Vec<String>>>,
}
impl Server {
    /// A reader of this stand-in, with `env` as its whole environment.
    pub fn reader(&self, env: &[(&'static str, &str)]) -> PublicGithub {
        PublicGithub {
            deadline: Duration::from_secs(5),
            test: Some(Host {
                base: format!("https://127.0.0.1:{}", self.port),
                root: self.root.clone(),
                env: env.iter().map(|(key, value)| (*key, value.to_string())).collect(),
            }),
        }
    }
    /// The request heads received so far, oldest first.
    pub fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

/// Serves each request with `answer(path, its own port)`, one request per
/// connection.
pub(crate) fn serve(answer: impl Fn(&str, u16) -> Answer + Send + Sync + 'static) -> Server {
    let (root, key) = certificate();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![root.clone()], key)
        .unwrap();
    let config = Arc::new(config);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let answer = Arc::new(answer);
    let kept = seen.clone();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (config, seen, answer) = (config.clone(), kept.clone(), answer.clone());
            thread::spawn(move || {
                let _ = one(stream, config, &seen, &|path| answer(path, port));
            });
        }
    });
    Server { port, root, seen }
}

fn one(stream: TcpStream, config: Arc<rustls::ServerConfig>, seen: &Mutex<Vec<String>>, answer: &dyn Fn(&str) -> Answer) -> io::Result<()> {
    let mut tls = rustls::StreamOwned::new(rustls::ServerConnection::new(config).map_err(io::Error::other)?, stream);
    let head = read_head(&mut tls)?;
    seen.lock().unwrap().push(head.clone());
    let answer = answer(head.split_whitespace().nth(1).unwrap_or_default());
    thread::sleep(answer.wait);
    let mut out = format!("HTTP/1.1 {} Stand-in\r\nContent-Length: {}\r\nConnection: close\r\n", answer.status, answer.body.len());
    for (name, value) in &answer.headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("\r\n");
    tls.write_all(out.as_bytes())?;
    tls.write_all(&answer.body)?;
    tls.conn.send_close_notify();
    tls.flush()
}

fn read_head(stream: &mut impl Read) -> io::Result<String> {
    let mut head = Vec::new();
    let mut byte = [0u8];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte)? == 0 || head.len() > 64 * 1024 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        head.push(byte[0]);
    }
    Ok(String::from_utf8_lossy(&head).into_owned())
}

pub(crate) struct Proxy {
    pub port: u16,
    seen: Arc<Mutex<Vec<String>>>,
}
impl Proxy {
    /// The CONNECT heads received so far, oldest first.
    pub fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

/// An HTTP proxy that tunnels CONNECT requests to the address they name.
pub(crate) fn proxy() -> Proxy {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let kept = seen.clone();
    thread::spawn(move || {
        for client in listener.incoming().flatten() {
            let seen = kept.clone();
            thread::spawn(move || {
                let _ = tunnel(client, &seen);
            });
        }
    });
    Proxy { port, seen }
}

fn tunnel(mut client: TcpStream, seen: &Mutex<Vec<String>>) -> io::Result<()> {
    let head = read_head(&mut client)?;
    seen.lock().unwrap().push(head.clone());
    let target = head.strip_prefix("CONNECT ").and_then(|rest| rest.split_whitespace().next()).ok_or(io::ErrorKind::InvalidData)?;
    let upstream = TcpStream::connect(target)?;
    client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")?;
    let (mut from, mut to) = (client.try_clone()?, upstream.try_clone()?);
    let forward = thread::spawn(move || {
        let _ = io::copy(&mut from, &mut to);
        let _ = to.shutdown(Shutdown::Write);
    });
    let (mut from, mut to) = (upstream, client);
    let _ = io::copy(&mut from, &mut to);
    let _ = to.shutdown(Shutdown::Both);
    let _ = forward.join();
    Ok(())
}

fn der(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    match content.len() {
        n if n < 0x80 => out.push(n as u8),
        n if n < 0x100 => out.extend([0x81, n as u8]),
        n => out.extend([0x82, (n >> 8) as u8, n as u8]),
    }
    out.extend_from_slice(content);
    out
}

/// A self-signed P-256 certificate for 127.0.0.1 and localhost, valid
/// 2000–2049, and its key; the reader trusts it as its one extra root.
fn certificate() -> (CertificateDer<'static>, PrivateKeyDer<'static>) {
    use ring::{
        rand::SystemRandom,
        signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING},
    };
    const ECDSA_WITH_SHA256: &[u8] = &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
    const EC_PUBLIC_KEY: &[u8] = &[0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
    const PRIME256V1: &[u8] = &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
    const COMMON_NAME: &[u8] = &[0x06, 0x03, 0x55, 0x04, 0x03];
    const SUBJECT_ALT_NAME: &[u8] = &[0x06, 0x03, 0x55, 0x1d, 0x11];
    let random = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &random).unwrap();
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &random).unwrap();
    let algorithm = der(0x30, ECDSA_WITH_SHA256);
    let name = der(0x30, &der(0x31, &der(0x30, &[COMMON_NAME, &der(0x0c, b"yuzuno stand-in")].concat())));
    let validity = der(0x30, &[der(0x17, b"000101000000Z"), der(0x17, b"491231235959Z")].concat());
    let public = der(0x30, &[der(0x30, &[EC_PUBLIC_KEY, PRIME256V1].concat()), der(0x03, &[&[0], pair.public_key().as_ref()].concat())].concat());
    let names = der(0x30, &[der(0x87, &[127, 0, 0, 1]), der(0x82, b"localhost")].concat());
    let extensions = der(0xa3, &der(0x30, &der(0x30, &[SUBJECT_ALT_NAME, &der(0x04, &names)].concat())));
    let version_and_serial: &[u8] = &[0xa0, 0x03, 0x02, 0x01, 0x02, 0x02, 0x01, 0x01];
    let signed = der(0x30, &[version_and_serial, &algorithm, &name, &validity, &name, &public, &extensions].concat());
    let signature = pair.sign(&random, &signed).unwrap();
    let certificate = der(0x30, &[&signed[..], &algorithm, &der(0x03, &[&[0], signature.as_ref()].concat())].concat());
    (CertificateDer::from(certificate), PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pkcs8.as_ref().to_vec())))
}
