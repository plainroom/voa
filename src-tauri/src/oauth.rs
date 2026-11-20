use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

#[derive(Serialize)]
pub struct OAuthResult {
    pub code: String,
    pub state: String,
}

/// The sign-in waiting for its browser answer. A new one ends it, so a retry never finds the port held by
/// the attempt the user gave up on.
static WAITING: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

/// How long a port the previous sign-in is releasing gets before it counts as taken.
const RELEASE_TRIES: u32 = 10;
const RELEASE_WAIT: Duration = Duration::from_millis(50);

/// Listen on 127.0.0.1 and ::1 at one port. A busy IPv6 port means the port is split: taken.
/// A machine without IPv6 keeps the IPv4 listener.
async fn bind_port(p: u16) -> Option<(TcpListener, Option<TcpListener>)> {
    let v4 = TcpListener::bind(("127.0.0.1", p)).await.ok()?;
    match TcpListener::bind(("::1", p)).await {
        Ok(v6) => Some((v4, Some(v6))),
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => None,
        Err(_) => Some((v4, None)),
    }
}

/// The given port, waited for a moment while a previous sign-in releases it. With `fallback`, the next three
/// ports after it: only for a caller that puts the bound port in its redirect URI. Without it, a taken port
/// fails at once, since the browser would come back to a port no one here listens on.
async fn bind_loopback(port: u16, fallback: bool) -> Result<(TcpListener, Option<TcpListener>), String> {
    for attempt in 0..RELEASE_TRIES {
        if let Some(bound) = bind_port(port).await {
            return Ok(bound);
        }
        if attempt + 1 < RELEASE_TRIES {
            tokio::time::sleep(RELEASE_WAIT).await;
        }
    }
    if fallback {
        for p in port.saturating_add(1)..=port.saturating_add(3) {
            if let Some(bound) = bind_port(p).await {
                return Ok(bound);
            }
        }
    }
    Err(format!(
        "Port {} is in use by another app, so voa cannot receive the sign-in. Close that app and try again.",
        port
    ))
}

/// Binds to the given localhost port for the OAuth callback and waits for the browser to come back (5 minutes at
/// most), for a caller whose redirect URI names that port. A taken port fails at once. A newer sign-in ends this one.
#[tauri::command]
pub async fn start_oauth_server(port: u16, state: String) -> Result<OAuthResult, String> {
    serve(port, state, false, |_| Ok(())).await
}

/// The same, for a caller that puts the bound port in its redirect URI (Microsoft's public clients accept any
/// localhost port): it may take one of the next three ports when the given one is taken, and says which on
/// `on_listening` before waiting.
#[tauri::command]
pub async fn start_oauth_server_any_port(port: u16, state: String, on_listening: Channel<u16>) -> Result<OAuthResult, String> {
    serve(port, state, true, |bound| {
        on_listening
            .send(bound)
            .map_err(|e| format!("Failed to report the port: {}", e))
    })
    .await
}

/// Listens on IPv4 and IPv6 (`localhost` may be either), reports the port bound, and waits for the redirect.
async fn serve(
    port: u16,
    state: String,
    fallback: bool,
    on_bound: impl FnOnce(u16) -> Result<(), String>,
) -> Result<OAuthResult, String> {
    let (cancel, cancelled) = oneshot::channel();
    if let Some(previous) = WAITING.lock().map_err(|_| "OAuth state poisoned".to_string())?.replace(cancel) {
        let _ = previous.send(());
    }

    let (first, second) = bind_loopback(port, fallback).await?;
    let actual_port = first
        .local_addr()
        .map_err(|e| format!("Failed to get addr: {}", e))?
        .port();

    log::info!("OAuth callback server listening on port {}", actual_port);
    on_bound(actual_port)?;

    let accept = async move {
        match second {
            Some(second) => {
                tokio::select! {
                    result = first.accept() => result,
                    result = second.accept() => result,
                }
            }
            None => first.accept().await,
        }
    };

    let (mut stream, _) = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(300), accept) => result
            .map_err(|_| "OAuth timed out. Please try again.".to_string())?
            .map_err(|e| format!("Failed to accept: {}", e))?,
        _ = cancelled => return Err("A newer sign-in replaced this one.".to_string()),
    };

    // Read the HTTP request
    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read: {}", e))?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // Extract query string from GET request line
    let (code, returned_state) = parse_auth_code_and_state(&request)?;

    // Validate state parameter (CSRF protection)
    if returned_state != state {
        return Err("OAuth state mismatch: possible CSRF attack".to_string());
    }

    // Send a success response to the browser
    let html = r#"<!DOCTYPE html>
<html>
<head><title>voa</title></head>
<body style="font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0;">
<div style="text-align: center;">
<h1 style="margin-bottom: 8px;">Account Connected!</h1>
<p style="opacity: 0.7;">You can close this tab and return to voa.</p>
</div>
</body>
</html>"#;

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );

    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;

    Ok(OAuthResult { code, state: returned_state })
}

fn parse_auth_code_and_state(request: &str) -> Result<(String, String), String> {
    let first_line = request.lines().next().ok_or("Empty request")?;

    let path = first_line
        .split_whitespace()
        .nth(1)
        .ok_or("No path in request")?;

    if path.contains("error=") {
        let params = parse_query_string(path);
        let error = params.get("error").cloned().unwrap_or_default();
        return Err(format!("OAuth error: {}", error));
    }

    let params = parse_query_string(path);
    let code = params
        .get("code")
        .cloned()
        .ok_or_else(|| "No auth code in redirect".to_string())?;
    let state = params
        .get("state")
        .cloned()
        .ok_or_else(|| "No state in redirect".to_string())?;
    Ok((code, state))
}

fn parse_query_string(path: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    if let Some(query) = path.split('?').nth(1) {
        for pair in query.split('&') {
            let mut kv = pair.splitn(2, '=');
            if let (Some(key), Some(value)) = (kv.next(), kv.next()) {
                params.insert(key.to_string(), urlencoding_decode(value));
            }
        }
    }
    params
}

fn urlencoding_decode(s: &str) -> String {
    let mut result = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                &s[i + 1..i + 3],
                16,
            ) {
                result.push(byte);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            result.push(b' ');
        } else {
            result.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| s.to_string())
}

#[derive(Serialize, Deserialize)]
pub struct TokenExchangeResult {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
    pub token_type: String,
    pub scope: Option<String>,
    pub id_token: Option<String>,
}

/// Exchange an OAuth authorization code for tokens via Rust HTTP client (avoids CORS).
#[tauri::command]
pub async fn oauth_exchange_token(
    token_url: String,
    code: String,
    client_id: String,
    redirect_uri: String,
    code_verifier: Option<String>,
    client_secret: Option<String>,
    scope: Option<String>,
) -> Result<TokenExchangeResult, String> {
    let mut params = vec![
        ("code", code),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code".to_string()),
    ];
    if let Some(verifier) = code_verifier {
        params.push(("code_verifier", verifier));
    }
    if let Some(secret) = client_secret {
        if !secret.is_empty() {
            params.push(("client_secret", secret));
        }
    }
    if let Some(s) = scope {
        params.push(("scope", s));
    }

    let client = reqwest::Client::new();
    let response = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {}", e))?;

    if !response.status().is_success() {
        let error = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Token exchange failed: {}", error));
    }

    response
        .json::<TokenExchangeResult>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))
}

/// Refresh an OAuth token via Rust HTTP client (avoids CORS).
#[tauri::command]
pub async fn oauth_refresh_token(
    token_url: String,
    refresh_token: String,
    client_id: String,
    client_secret: Option<String>,
    scope: Option<String>,
) -> Result<TokenExchangeResult, String> {
    let mut params = vec![
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(secret) = client_secret {
        if !secret.is_empty() {
            params.push(("client_secret", secret));
        }
    }
    if let Some(s) = scope {
        params.push(("scope", s));
    }

    let client = reqwest::Client::new();
    let response = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {}", e))?;

    if !response.status().is_success() {
        let error = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        // A sign-in the provider no longer honours comes back as OAuth's own code: only a reconnect fixes it.
        if serde_json::from_str::<serde_json::Value>(&error).is_ok_and(|v| v["error"] == "invalid_grant") {
            log::warn!("Token refresh refused: {error}");
            return Err("invalid_grant".into());
        }
        return Err(format!("Token refresh failed: {}", error));
    }

    response
        .json::<TokenExchangeResult>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_taken_port_fails_at_once_without_fallback() {
        let holder = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = holder.local_addr().unwrap().port();
        let started = std::time::Instant::now();
        let err = bind_loopback(port, false).await.err().expect("the port is taken");
        assert!(err.contains(&port.to_string()));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn a_taken_port_moves_to_the_next_with_fallback() {
        let holder = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = holder.local_addr().unwrap().port();
        let (bound, _) = bind_loopback(port, true).await.expect("a next port is free");
        let actual = bound.local_addr().unwrap().port();
        assert!(actual > port && actual <= port + 3);
    }

    #[tokio::test]
    async fn a_newer_sign_in_ends_the_waiting_one_and_takes_its_port() {
        let free = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);

        let old = tokio::spawn(start_oauth_server(port, "old".into()));
        tokio::time::sleep(Duration::from_millis(100)).await;
        let new = tokio::spawn(start_oauth_server(port, "new".into()));

        let old = old.await.unwrap();
        assert_eq!(old.err().as_deref(), Some("A newer sign-in replaced this one."));

        let mut browser = None;
        for _ in 0..20 {
            if let Ok(stream) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
                browser = Some(stream);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let mut browser = browser.expect("the newer sign-in listens on the same port");
        browser
            .write_all(b"GET /?code=the-code&state=new HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let result = new.await.unwrap().expect("the newer sign-in gets the code");
        assert_eq!(result.code, "the-code");
    }
}
