//! `voa-img`: the images of a mail, fetched by the app instead of the mail's web view. A browser
//! obeys rules a sender set for browsers (`Cross-Origin-Resource-Policy: same-origin` on claude.ai's
//! logo hid it); the app is not a browser, so the mail looks as its sender drew it, as in Gmail,
//! whose servers fetch every image. The reader asks `voa-img://localhost/<base64url of the URL>`
//! (`convertFileSrc`), only for images it would load anyway (blocking stays the reader's).
//!
//! Every URL comes from a mail, so from anyone: only http and https, only a host whose every address
//! is public (never this Mac, the router or the local network), connected to the address checked
//! (so a second lookup cannot point elsewhere), each redirect checked the same way, at most 5 of
//! them, 15 s, 10 MB, and only what says it is an image. No cookies are sent.

use base64::Engine;
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tauri::http::{header, Response, StatusCode};

const MAX_BYTES: usize = 10 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
// What the web view sent before: a sender sees the same client.
const AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/// An address no mail may make the app reach: this Mac, a private network, link-local, the like.
fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0
                || (a == 100 && (64..128).contains(&b)) // shared address space (carrier NAT)
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00 // unique local
                || (first & 0xffc0) == 0xfe80) // link-local
        }
    }
}

/// The URL a `voa-img` request carries: its path is the image's URL in base64url.
fn target(path: &str) -> Option<reqwest::Url> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(path.trim_start_matches('/')).ok()?;
    let url = reqwest::Url::parse(std::str::from_utf8(&bytes).ok()?).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

/// One address of the URL's host to connect to, when every address it has is public.
async fn address(url: &reqwest::Url) -> Result<SocketAddr, String> {
    let host = url.host_str().ok_or("no host")?;
    let port = url.port_or_known_default().ok_or("no port")?;
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port)).await.map_err(|e| e.to_string())?.collect();
    if addrs.is_empty() || !addrs.iter().all(|a| public(a.ip())) {
        return Err(format!("{host} is not a public address"));
    }
    Ok(addrs[0])
}

/// The image's bytes and type, following redirects itself so each one is checked.
async fn fetch(mut url: reqwest::Url) -> Result<(Vec<u8>, String), String> {
    for _ in 0..=MAX_REDIRECTS {
        let at = address(&url).await?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .resolve(url.host_str().unwrap_or_default(), at)
            .timeout(Duration::from_secs(15))
            .user_agent(AGENT)
            .build()
            .map_err(|e| e.to_string())?;
        let mut res = client.get(url.clone()).header(header::ACCEPT, "image/*").send().await.map_err(|e| e.to_string())?;
        if res.status().is_redirection() {
            let next = res.headers().get(header::LOCATION).and_then(|l| l.to_str().ok()).ok_or("redirect without a location")?;
            url = url.join(next).map_err(|e| e.to_string())?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err("redirect to another scheme".into());
            }
            continue;
        }
        if !res.status().is_success() {
            return Err(format!("status {}", res.status()));
        }
        let kind = res.headers().get(header::CONTENT_TYPE).and_then(|t| t.to_str().ok()).unwrap_or("").to_owned();
        if !kind.to_ascii_lowercase().starts_with("image/") {
            return Err(format!("not an image: {kind}"));
        }
        let mut body = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
            if body.len() + chunk.len() > MAX_BYTES {
                return Err("image too large".into());
            }
            body.extend_from_slice(&chunk);
        }
        return Ok((body, kind));
    }
    Err("too many redirects".into())
}

/// The protocol's answer: the image, or an empty error the web view shows as a missing image.
pub async fn serve(path: String) -> Response<Vec<u8>> {
    let done = match target(&path) {
        None => Err("not an image URL".to_owned()),
        Some(url) => fetch(url).await,
    };
    match done {
        Ok((body, kind)) => Response::builder()
            .header(header::CONTENT_TYPE, kind)
            // Kept by the web view for the session: reopening a mail does not fetch its images again.
            .header(header::CACHE_CONTROL, "private, max-age=86400")
            .body(body)
            .unwrap(),
        Err(why) => {
            log::debug!("voa-img: {why}");
            Response::builder().status(StatusCode::BAD_GATEWAY).body(Vec::new()).unwrap()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_addresses() {
        for private in ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:192.168.1.1"] {
            assert!(!public(private.parse().unwrap()), "{private}");
        }
        for open in ["104.18.32.7", "8.8.8.8", "2606:4700::6810:84e5"] {
            assert!(public(open.parse().unwrap()), "{open}");
        }
    }

    #[test]
    fn reads_only_http_urls() {
        let enc = |s: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s);
        assert_eq!(target(&format!("/{}", enc("https://claude.ai/a.png?x=1&y=2"))).unwrap().as_str(), "https://claude.ai/a.png?x=1&y=2");
        assert!(target(&format!("/{}", enc("file:///etc/passwd"))).is_none());
        assert!(target("/not base64!").is_none());
    }
}
