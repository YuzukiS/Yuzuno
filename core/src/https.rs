//! Core's HTTPS client, shared by push notifications (T-200) and the public
//! release reads (YN-110): rustls with ring over HTTP/1.1, trusting only the
//! roots webpki-roots carries, never the host's certificate store. It follows
//! no redirect; a caller that follows one checks each itself.
use anyhow::{Context, Result};
use axum::{body::HttpBody, http::{HeaderValue, Uri}};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::{
    client::legacy::{connect::{proxy::Tunnel, HttpConnector}, Client},
    rt::TokioExecutor,
};
use std::sync::Arc;

/// Straight to the server.
pub(crate) type Direct<B> = Client<HttpsConnector<HttpConnector>, B>;
/// Through an HTTP proxy's CONNECT tunnel.
pub(crate) type Tunnelled<B> = Client<HttpsConnector<Tunnel<HttpConnector>>, B>;

/// The roots Core trusts: webpki-roots, built in.
pub(crate) fn roots() -> rustls::RootCertStore {
    rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() }
}

fn connector<C>(roots: rustls::RootCertStore, inner: C) -> Result<HttpsConnector<C>> {
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .context("TLS")?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(HttpsConnectorBuilder::new().with_tls_config(tls).https_only().enable_http1().wrap_connector(inner))
}

pub(crate) fn direct<B>(roots: rustls::RootCertStore) -> Result<Direct<B>>
where
    B: HttpBody + Send,
    B::Data: Send,
{
    let mut http = HttpConnector::new();
    // The HTTPS connector checks the scheme; this one only connects.
    http.enforce_http(false);
    Ok(Client::builder(TokioExecutor::new()).build(connector(roots, http)?))
}

/// TLS runs end to end inside the tunnel: the proxy sees the host and port it
/// is asked to connect to, and `auth` (the proxy's own sign-in, if its address
/// carried one), nothing else.
pub(crate) fn tunnelled<B>(roots: rustls::RootCertStore, proxy: Uri, auth: Option<HeaderValue>) -> Result<Tunnelled<B>>
where
    B: HttpBody + Send,
    B::Data: Send,
{
    let mut tunnel = Tunnel::new(proxy, HttpConnector::new());
    if let Some(auth) = auth {
        tunnel = tunnel.with_auth(auth);
    }
    Ok(Client::builder(TokioExecutor::new()).build(connector(roots, tunnel)?))
}
