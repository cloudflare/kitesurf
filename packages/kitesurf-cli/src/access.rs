// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Builds authenticated HTTP clients and CDP WebSocket requests for the engine.

use crate::Result;
use std::time::Duration;
use reqwest::header::HeaderValue;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::Request};

const ACCESS_HEADER: &str = "Cf-Access-Token";

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ASSET_REDIRECTS: usize = 10;

pub fn token() -> Result<Option<HeaderValue>> {
    std::env::var("CF_ACCESS_TOKEN")
        .ok()
        .filter(|value| !value.is_empty())
        .map(|value| {
            HeaderValue::from_str(&value)
                .map_err(|_| "CF_ACCESS_TOKEN is not a valid HTTP header value".into())
        })
        .transpose()
}

pub fn font_client(server: &reqwest::Url, token: Option<&HeaderValue>) -> Result<reqwest::Client> {
    let origin = server.origin();
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(token) = token {
        headers.insert(ACCESS_HEADER, token.clone());
    }
    Ok(crate::tls::client_builder()
        .default_headers(headers)
        // Keep redirects on the configured origin to prevent forwarding the Access token.
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_ASSET_REDIRECTS {
                attempt.error("too many asset redirects")
            } else if attempt.url().origin() != origin {
                attempt.error("asset redirect left Kitesurf server origin")
            } else {
                attempt.follow()
            }
        }))
        .timeout(HTTP_TIMEOUT)
        .build()?)
}

pub fn websocket_request(url: &str, token: Option<&HeaderValue>) -> Result<Request<()>> {
    let mut request = url.into_client_request()?;
    if let Some(token) = token {
        request.headers_mut().insert(ACCESS_HEADER, token.clone());
    }
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[allow(
        clippy::result_large_err,
        reason = "Tungstenite's handshake callback returns its required HTTP Response type."
    )]
    #[tokio::test]
    async fn access_token_reaches_http_and_websocket_handshakes() {
        let token = HeaderValue::from_static("test.access.jwt");

        let http = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_url = format!(
            "http://{}/rbi/fonts/NotoSans.ttf",
            http.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            let (mut stream, _) = http.accept().await.unwrap();
            let mut data = Vec::new();
            while !data.ends_with(b"\r\n\r\n") {
                let mut chunk = [0; 4096];
                let bytes_read = stream.read(&mut chunk).await.unwrap();
                assert!(bytes_read > 0);
                data.extend_from_slice(&chunk[..bytes_read]);
            }
            let request = String::from_utf8_lossy(&data).to_ascii_lowercase();
            assert!(request.contains("cf-access-token: test.access.jwt\r\n"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
        });
        let url = reqwest::Url::parse(&http_url).unwrap();
        font_client(&url, Some(&token))
            .unwrap()
            .get(url.clone())
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        server.await.unwrap();

        let ws = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/devtools/browser", ws.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = ws.accept().await.unwrap();
            let socket =
                tokio_tungstenite::accept_hdr_async(stream, |request: &Request<()>, response| {
                    assert_eq!(
                        request.headers().get(ACCESS_HEADER).unwrap(),
                        "test.access.jwt"
                    );
                    Ok(response)
                })
                .await
                .unwrap();
            drop(socket);
        });
        let (socket, _) =
            tokio_tungstenite::connect_async(websocket_request(&ws_url, Some(&token)).unwrap())
                .await
                .unwrap();
        drop(socket);
        server.await.unwrap();
    }

    #[test]
    fn websocket_without_token_has_no_access_header() {
        let request = websocket_request("ws://localhost:8787/devtools/browser", None).unwrap();
        assert!(!request.headers().contains_key(ACCESS_HEADER));
    }

    #[tokio::test]
    async fn access_token_does_not_follow_cross_origin_redirects() {
        let source = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!(
            "http://{}/rbi/fonts/NotoSans.ttf",
            source.local_addr().unwrap()
        ))
        .unwrap();
        let redirect = format!("http://{}/stolen", destination.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = source.accept().await.unwrap();
            let mut request = [0; 4096];
            let bytes_read = stream.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..bytes_read])
                .to_ascii_lowercase()
                .contains("cf-access-token: test.access.jwt"));
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: {redirect}\r\nContent-Length: 0\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let token = HeaderValue::from_static("test.access.jwt");
        let error = font_client(&url, Some(&token))
            .unwrap()
            .get(url.clone())
            .send()
            .await
            .unwrap_err();
        assert!(error.is_redirect(), "{error:?}");
        server.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), destination.accept())
                .await
                .is_err()
        );
    }
}
