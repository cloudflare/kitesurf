// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Command-line entry point that connects to the engine and starts playback.

mod access;
mod cli;
mod tls;

use kitesurf_playback::{play, FontSource, PlaybackOptions};
use std::{error::Error, time::Duration};
use tokio_tungstenite::{connect_async, tungstenite};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

fn user_error(error: &(dyn Error + 'static)) -> String {
    let mut cause = Some(error);
    while let Some(err) = cause {
        if let Some(ws) = err.downcast_ref::<tungstenite::Error>() {
            return match ws {
                tungstenite::Error::Protocol(
                    tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
                )
                | tungstenite::Error::ConnectionClosed => {
                    "Connection to the Kitesurf server was lost. Check that it is still running, then try again.".into()
                }
                tungstenite::Error::Io(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    "Could not reach the Kitesurf server. Check that it is running, then try again."
                        .into()
                }
                tungstenite::Error::Io(_) => {
                    "Connection to the Kitesurf server was lost. Check that it is still running, then try again.".into()
                }
                tungstenite::Error::Http(response) => format!(
                    "Kitesurf server rejected the connection (HTTP {}).",
                    response.status()
                ),
                _ => format!("Could not connect to the Kitesurf server: {ws}"),
            };
        }
        if let Some(request) = err.downcast_ref::<reqwest::Error>() {
            if request.is_connect() || request.is_timeout() {
                let mut detail: &(dyn Error + 'static) = request;
                while let Some(source) = detail.source() {
                    detail = source;
                }
                return format!("Could not connect to the Kitesurf server: {detail}");
            }
            if let Some(status) = request.status() {
                return format!("Kitesurf server returned HTTP {status}.");
            }
        }
        cause = err.source();
    }
    error.to_string()
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("kitesurf: {}", user_error(error.as_ref()));
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version") {
        println!("kitesurf {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let server_env = std::env::var("KITESURF_SERVER").ok();
    let opts = match cli::parse(args, server_env.as_deref()) {
        Ok(Some(opts)) => opts,
        Ok(None) => {
            print!("{}", cli::HELP);
            return Ok(());
        }
        Err(message) => {
            eprintln!("{message}\nTry 'kitesurf --help' for more information.");
            std::process::exit(2);
        }
    };
    let access_token = access::token()?;
    run_playback(opts, access_token.as_ref()).await
}

async fn run_playback(
    opts: cli::Options,
    access_token: Option<&reqwest::header::HeaderValue>,
) -> Result<()> {
    let cli::Options {
        url,
        server,
        seconds,
        display,
        debug,
        mode,
        fps,
    } = opts;
    if access_token.is_some() && server.scheme() == "http" {
        eprintln!("warning: CF_ACCESS_TOKEN will be sent over an unencrypted HTTP/WS connection");
    }
    if debug {
        eprintln!(
            "kitesurf: debug: server: {server} (Access token: {})",
            if access_token.is_some() {
                "present"
            } else {
                "absent"
            }
        );
    }
    let client = access::font_client(&server, access_token)?;
    let font_source = FontSource::new(server.clone(), client)?;
    let mut ws_url = server.join("devtools/browser")?;
    ws_url
        .set_scheme(if server.scheme() == "https" {
            "wss"
        } else {
            "ws"
        })
        .map_err(|_| "invalid scheme")?;
    if debug {
        eprintln!("kitesurf: debug: connecting CDP WebSocket to {ws_url}");
    }
    let request = access::websocket_request(ws_url.as_str(), access_token)?;
    let (ws, _) = tokio::time::timeout(WS_CONNECT_TIMEOUT, connect_async(request)).await??;
    let options = PlaybackOptions::new(url, mode, seconds, display, debug, fps)?;
    play(ws, options, font_source).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_websocket_has_a_readable_error() {
        let reset = tungstenite::Error::Protocol(
            tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
        );
        let message = user_error(&reset);
        assert!(message.contains("Connection to the Kitesurf server was lost"));
        assert!(!message.contains("Protocol"));

        let refused =
            tungstenite::Error::Io(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
        assert!(user_error(&refused).contains("Could not reach the Kitesurf server"));
    }
}
