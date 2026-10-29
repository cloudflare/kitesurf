// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use crate::Result;
use std::time::Duration;
use reqwest::header::HeaderValue;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, http::Request};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const ACCESS_HEADER: &str = "Cf-Access-Token";

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_ASSET_REDIRECTS: usize = 10;

pub struct Connection {
    pub websocket: reqwest::Url,
    pub font_server: reqwest::Url,
    access_token: Option<HeaderValue>,
    bearer_token: Option<HeaderValue>,
    saved_oauth: bool,
}

pub type CdpSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

impl Connection {
    pub async fn resolve(backend: crate::cli::Backend) -> Result<Self> {
        match backend {
            crate::cli::Backend::Direct(server) => Self::direct(server, token()?),
            crate::cli::Backend::BrowserRun => {
                Self::browser_run_from_env(
                    |name| std::env::var(name).ok(),
                    crate::oauth::credentials(),
                )
                .await
            }
        }
    }

    async fn browser_run_from_env(
        env: impl Fn(&str) -> Option<String>,
        saved: impl std::future::Future<Output = Result<(String, String)>>,
    ) -> Result<Self> {
        let account = env("CLOUDFLARE_ACCOUNT_ID");
        if let Some(id) = &account {
            crate::oauth::validate_account_id(id)?;
        }
        let api_token = env("KITESURF_API_TOKEN");
        let saved_oauth = api_token.is_none();
        let (id, token) = match api_token {
            Some(token) => (
                account.ok_or("KITESURF_API_TOKEN requires CLOUDFLARE_ACCOUNT_ID")?,
                token,
            ),
            None => {
                let (saved_account, token) = saved.await?;
                (account.unwrap_or(saved_account), token)
            }
        };
        let mut connection = Self::browser_run(&id, &token)?;
        connection.saved_oauth = saved_oauth;
        Ok(connection)
    }

    fn direct(server: reqwest::Url, access_token: Option<HeaderValue>) -> Result<Self> {
        let mut websocket = server.join("devtools/browser")?;
        websocket
            .set_scheme(if server.scheme() == "https" {
                "wss"
            } else {
                "ws"
            })
            .map_err(|_| "invalid WebSocket scheme")?;
        Ok(Self {
            websocket,
            font_server: server,
            access_token,
            bearer_token: None,
            saved_oauth: false,
        })
    }

    fn browser_run(account: &str, token: &str) -> Result<Self> {
        crate::oauth::validate_account_id(account)?;
        Ok(Self {
            websocket: reqwest::Url::parse(&format!("wss://api.cloudflare.com/client/v4/accounts/{account}/browser-run/devtools/browser?browser=kitesurf"))?,
            font_server: reqwest::Url::parse(crate::cli::PLAYGROUND)?,
            access_token: None,
            bearer_token: Some(bearer(token)?),
            saved_oauth: false,
        })
    }

    pub async fn connect(&mut self) -> Result<CdpSocket> {
        self.connect_with_login(Self::browser_run_from_env(
            |name| std::env::var(name).ok(),
            crate::oauth::login_credentials(),
        ))
        .await
    }

    async fn connect_with_login(
        &mut self,
        login: impl std::future::Future<Output = Result<Self>>,
    ) -> Result<CdpSocket> {
        match self.connect_once().await {
            Err(error)
                if self.saved_oauth
                    && matches!(
                        error.downcast_ref::<tungstenite::Error>(),
                        Some(tungstenite::Error::Http(response))
                            if response.status().as_u16() == 401
                    ) =>
            {
                eprintln!("Saved Cloudflare login was rejected; signing in again.");
                *self = login.await?;
                self.connect_once().await
            }
            result => result,
        }
    }

    async fn connect_once(&self) -> Result<CdpSocket> {
        let (socket, _) = tokio::time::timeout(
            WS_CONNECT_TIMEOUT,
            tokio_tungstenite::connect_async(self.websocket_request()?),
        )
        .await??;
        Ok(socket)
    }

    pub fn websocket_request(&self) -> Result<Request<()>> {
        let mut request = websocket_request(self.websocket.as_str(), self.access_token.as_ref())?;
        if let Some(token) = &self.bearer_token {
            request.headers_mut().insert("Authorization", token.clone());
        }
        Ok(request)
    }

    pub fn has_unencrypted_access_token(&self) -> bool {
        self.access_token.is_some() && self.websocket.scheme() == "ws"
    }

    pub fn font_client(&self) -> Result<reqwest::Client> {
        font_client(&self.font_server, self.access_token.as_ref())
    }
}

pub fn bearer(token: &str) -> Result<HeaderValue> {
    if token.is_empty() || token.bytes().any(|byte| byte.is_ascii_whitespace()) {
        return Err("Cloudflare bearer token is empty or contains whitespace".into());
    }
    let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "Cloudflare bearer token is not a valid HTTP header value")?;
    value.set_sensitive(true);
    Ok(value)
}

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

fn font_client(
    server: &reqwest::Url,
    access_token: Option<&HeaderValue>,
) -> Result<reqwest::Client> {
    let origin = server.origin();
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(token) = access_token {
        headers.insert(ACCESS_HEADER, token.clone());
    }
    Ok(crate::tls::client_builder()
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_ASSET_REDIRECTS {
                attempt.error("too many asset redirects")
            } else if attempt.url().origin() != origin {
                attempt.error("font redirect left the engine origin")
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
// The handshake servers' accept_hdr_async callbacks must return tungstenite's http::Response as
// their Err type, so the size lint has nothing to change.
#[allow(clippy::result_large_err)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[allow(
        clippy::result_large_err,
        reason = "Tungstenite's handshake callback returns its required HTTP Response type."
    )]
    async fn handshake_server(
        statuses: Vec<u16>,
    ) -> (reqwest::Url, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!(
            "ws://{}/devtools/browser",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            let mut tokens = Vec::new();
            for status in statuses {
                let (stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
                let result = tokio_tungstenite::accept_hdr_async(
                    stream,
                    |request: &Request<()>, response| {
                        tokens.push(
                            request
                                .headers()
                                .get("authorization")
                                .map_or(String::new(), |value| value.to_str().unwrap().to_owned()),
                        );
                        if status == 101 {
                            Ok(response)
                        } else {
                            Err(tungstenite::http::Response::builder()
                                .status(status)
                                .body(None)
                                .unwrap())
                        }
                    },
                )
                .await;
                if status == 101 {
                    assert!(result.is_ok());
                } else {
                    assert!(result.is_err());
                }
            }
            tokens
        });
        (url, server)
    }

    async fn oauth_connection(token: &str) -> Connection {
        Connection::browser_run_from_env(|_| None, async {
            Ok(("0123456789abcdef0123456789abcdef".into(), token.into()))
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn oauth_401_logs_in_and_retries_with_new_credentials() {
        let (url, server) = handshake_server(vec![401, 101]).await;
        let mut connection = oauth_connection("expired-token").await;
        connection.websocket = url.clone();
        let login_count = std::cell::Cell::new(0);
        let socket = connection
            .connect_with_login(async {
                login_count.set(login_count.get() + 1);
                let mut connection = Connection::browser_run_from_env(|_| None, async {
                    Ok((
                        "abcdef0123456789abcdef0123456789".into(),
                        "fresh-token".into(),
                    ))
                })
                .await?;
                assert!(connection
                    .websocket
                    .path()
                    .contains("abcdef0123456789abcdef0123456789"));
                connection.websocket = url;
                Ok(connection)
            })
            .await
            .unwrap();
        drop(socket);
        assert_eq!(login_count.get(), 1);
        assert_eq!(
            server.await.unwrap(),
            ["Bearer expired-token", "Bearer fresh-token"]
        );
        assert_eq!(
            connection.websocket_request().unwrap().headers()["authorization"],
            "Bearer fresh-token"
        );
    }

    #[tokio::test]
    async fn oauth_retry_rejection_does_not_repeat_login() {
        let (url, server) = handshake_server(vec![401, 401]).await;
        let mut connection = oauth_connection("expired-token").await;
        connection.websocket = url.clone();
        let login_count = std::cell::Cell::new(0);
        let error = connection
            .connect_with_login(async {
                login_count.set(login_count.get() + 1);
                let mut connection = oauth_connection("fresh-token").await;
                connection.websocket = url;
                Ok(connection)
            })
            .await
            .unwrap_err();
        assert!(matches!(error.downcast_ref::<tungstenite::Error>(),
            Some(tungstenite::Error::Http(response)) if response.status().as_u16() == 401));
        assert_eq!(login_count.get(), 1);
        assert_eq!(
            server.await.unwrap(),
            ["Bearer expired-token", "Bearer fresh-token"]
        );
    }

    #[tokio::test]
    async fn oauth_connection_preserves_login_failure() {
        let (url, server) = handshake_server(vec![401]).await;
        let mut connection = oauth_connection("expired-token").await;
        connection.websocket = url;
        let error = connection
            .connect_with_login(async { Err("Cloudflare authorization was denied".into()) })
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Cloudflare authorization was denied");
        assert_eq!(server.await.unwrap(), ["Bearer expired-token"]);
    }

    #[tokio::test]
    async fn connections_without_oauth_rejection_do_not_start_login() {
        for (saved_oauth, status) in [
            (true, 101),
            (true, 403),
            (true, 429),
            (true, 503),
            (false, 401),
        ] {
            let (url, server) = handshake_server(vec![status]).await;
            let mut connection = if saved_oauth {
                oauth_connection("oauth-token").await
            } else {
                Connection::browser_run_from_env(
                    |name| match name {
                        "KITESURF_API_TOKEN" => Some("api-token".into()),
                        "CLOUDFLARE_ACCOUNT_ID" => Some("0123456789abcdef0123456789abcdef".into()),
                        _ => None,
                    },
                    async { panic!("API tokens must not load OAuth credentials") },
                )
                .await
                .unwrap()
            };
            connection.websocket = url;
            let result = connection
                .connect_with_login(async {
                    panic!("only an OAuth HTTP 401 should start login");
                })
                .await;
            assert_eq!(result.is_ok(), status == 101);
            assert_eq!(server.await.unwrap().len(), 1);
        }
        let (url, server) = handshake_server(vec![401]).await;
        let mut connection = Connection::direct(url, None).unwrap();
        assert!(connection
            .connect_with_login(async {
                panic!("direct connections must not start OAuth login");
            })
            .await
            .is_err());
        assert_eq!(server.await.unwrap(), [""]);
    }

    #[tokio::test]
    async fn browser_run_bearer_reaches_only_the_api_websocket() {
        let account = "0123456789abcdef0123456789abcdef";
        let mut connection = Connection::browser_run(account, "api-secret").unwrap();
        assert_eq!(connection.websocket.as_str(), format!("wss://api.cloudflare.com/client/v4/accounts/{account}/browser-run/devtools/browser?browser=kitesurf"));
        let client = connection.font_client().unwrap();
        for path in [
            "/rbi/fonts/NotoSans.ttf",
            "/rbi/fonts/NotoSansCJKsc-Regular.woff2",
        ] {
            let request = client
                .get(connection.font_server.join(path).unwrap())
                .build()
                .unwrap();
            assert_eq!(request.url().host_str(), Some("kitesurf.dev"));
            assert!(!request.headers().contains_key("authorization"));
            assert!(!request.headers().contains_key(ACCESS_HEADER));
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        connection.websocket = reqwest::Url::parse(&format!(
            "ws://{}/devtools/browser?browser=kitesurf",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_hdr_async(stream, |request: &Request<()>, response| {
                assert_eq!(request.headers()["authorization"], "Bearer api-secret");
                assert!(!request.headers().contains_key(ACCESS_HEADER));
                assert_eq!(request.uri().query(), Some("browser=kitesurf"));
                Ok(response)
            })
            .await
            .unwrap()
        });
        let request = connection.websocket_request().unwrap();
        assert!(request.headers()["authorization"].is_sensitive());
        let (socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        drop(socket);
        drop(server.await.unwrap());
    }

    #[test]
    fn invalid_api_credentials_do_not_enter_urls_or_headers() {
        for account in [
            "",
            "bad/id",
            "../devtools",
            "0123456789abcdef0123456789abcdeg",
        ] {
            assert!(Connection::browser_run(account, "secret").is_err());
        }
        for token in ["", "secret\nInjected: header", " secret", "sec ret"] {
            assert!(bearer(token).is_err());
        }
        let direct = Connection::direct(
            reqwest::Url::parse("http://127.0.0.1:8799/").unwrap(),
            Some(HeaderValue::from_static("access-secret")),
        )
        .unwrap();
        let request = direct.websocket_request().unwrap();
        assert_eq!(request.uri(), "ws://127.0.0.1:8799/devtools/browser");
        assert_eq!(request.headers()[ACCESS_HEADER], "access-secret");
        assert!(!request.headers().contains_key("authorization"));
    }

    #[allow(
        clippy::result_large_err,
        reason = "Tungstenite's handshake callback returns its required HTTP Response type."
    )]
    #[tokio::test]
    async fn access_token_reaches_direct_websocket_handshake() {
        let token = HeaderValue::from_static("test.access.jwt");

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
    async fn font_download_does_not_follow_off_origin_redirects() {
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
                .contains("cf-access-token: access-secret"));
            assert!(!String::from_utf8_lossy(&request[..bytes_read])
                .to_ascii_lowercase()
                .contains("authorization:"));
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
        let error = font_client(&url, Some(&HeaderValue::from_static("access-secret")))
            .unwrap()
            .get(url)
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

    #[tokio::test]
    async fn wrangler_api_tokens_do_not_override_saved_oauth() {
        for account in [None, Some("abcdef0123456789abcdef0123456789")] {
            let connection = Connection::browser_run_from_env(
                |name| match name {
                    "CLOUDFLARE_API_TOKEN" => Some("wrangler-deploy-secret".into()),
                    "CLOUDFLARE_ACCOUNT_ID" => account.map(str::to_owned),
                    _ => None,
                },
                async {
                    Ok((
                        "0123456789abcdef0123456789abcdef".into(),
                        "oauth-secret".into(),
                    ))
                },
            )
            .await
            .unwrap();
            let request = connection.websocket_request().unwrap();
            assert_eq!(request.headers()["authorization"], "Bearer oauth-secret");
            assert!(request
                .uri()
                .path()
                .contains(account.unwrap_or("0123456789abcdef0123456789abcdef")));
        }
    }

    #[tokio::test]
    async fn explicit_kitesurf_token_requires_an_account_and_skips_oauth() {
        for account in [None, Some("0123456789abcdef0123456789abcdef")] {
            let result = Connection::browser_run_from_env(
                |name| match name {
                    "KITESURF_API_TOKEN" => Some("browser-run-secret".into()),
                    "CLOUDFLARE_ACCOUNT_ID" => account.map(str::to_owned),
                    _ => None,
                },
                async { panic!("explicit API tokens must not load OAuth credentials") },
            )
            .await;
            if account.is_some() {
                assert_eq!(
                    result.unwrap().websocket_request().unwrap().headers()["authorization"],
                    "Bearer browser-run-secret"
                );
            } else {
                assert!(result
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("KITESURF_API_TOKEN requires CLOUDFLARE_ACCOUNT_ID"));
            }
        }
    }

    #[tokio::test]
    async fn direct_fonts_use_the_engine_origin_and_access_token() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin =
            reqwest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let connection = Connection::direct(
            origin.clone(),
            Some(HeaderValue::from_static("access-secret")),
        )
        .unwrap();
        let server = tokio::spawn(async move {
            for (path, response) in [
                ("/rbi/fonts/NotoSans.ttf", "HTTP/1.1 302 Found\r\nLocation: /rbi/fonts/redirected.ttf\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                ("/rbi/fonts/redirected.ttf", "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nfont"),
            ] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") { request.push(stream.read_u8().await.unwrap()); }
                let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
                assert!(request.starts_with(&format!("get {} ", path.to_ascii_lowercase())));
                assert!(request.contains("cf-access-token: access-secret\r\n"));
                assert!(!request.contains("authorization:"));
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let url = connection
            .font_server
            .join("/rbi/fonts/NotoSans.ttf")
            .unwrap();
        assert_eq!(url.origin(), origin.origin());
        let response = connection
            .font_client()
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), "font");
        server.await.unwrap();
    }
}
