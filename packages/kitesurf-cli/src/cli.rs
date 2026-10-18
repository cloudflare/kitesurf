// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Parses CLI arguments into server and playback settings, and defines the help text.

use std::time::Duration;
pub use kitesurf_playback::PlaybackMode as Mode;

const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:8787";
const MIN_FPS: u8 = 1;
const MAX_FPS: u8 = 60;

pub const HELP: &str =
    "Usage: kitesurf URL [--mode=kitty|ansi] [--fps N] [--seconds N] [--no-display] [--debug]

Open a website in an interactive terminal browser.

Options:
  --mode MODE   Rendering protocol: kitty (default) or ansi (for any terminal).
  --fps N       Maximum scene frames per second (1-60, default 60).
  --seconds N   Stop replay after N seconds and print measurements.
  --no-display  Measure replay without terminal output (800x600 Kitty, 800x595 ANSI).
  --debug       Log connection, downloads and scene-stream events (also --verbose).
  --version     Print the version.
  -h, --help    Show this help.

Kitesurf CLI is still experimental, do not use in a production environment.

Press Ctrl-B when a page is open to toggle a stats bar with accounted server memory.

KITESURF_SERVER selects the engine (default http://127.0.0.1:8787).
See https://github.com/cloudflare/kitesurf for setup instructions.
";

#[derive(Debug, PartialEq)]
pub struct Options {
    pub mode: Mode,
    pub url: String,
    pub server: reqwest::Url,
    pub seconds: Option<Duration>,
    pub display: bool,
    pub debug: bool,
    pub fps: u8,
}

pub fn parse(
    args: impl IntoIterator<Item = String>,
    server_env: Option<&str>,
) -> Result<Option<Options>, String> {
    let mut args = args.into_iter();
    let mut mode = Mode::default();
    let mut url = None;
    let mut seconds = None;
    let mut display = true;
    let mut debug = false;
    let mut fps = MAX_FPS;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(None),
            "--mode" => mode = Mode::parse(&args.next().ok_or("--mode requires a value")?)?,
            argument if argument.starts_with("--mode=") => mode = Mode::parse(&argument[7..])?,
            "--fps" => {
                let value = args.next().ok_or("--fps requires a number")?;
                fps = value
                    .parse::<u8>()
                    .map_err(|_| "invalid fps (expected 1-60)")?;
                if !(MIN_FPS..=MAX_FPS).contains(&fps) {
                    return Err("invalid fps (expected 1-60)".into());
                }
            }
            "--seconds" => {
                let value = args.next().ok_or("--seconds requires a number")?;
                seconds = Some(Duration::from_secs(
                    value.parse::<u64>().map_err(|_| "invalid seconds")?,
                ));
            }
            "--no-display" => display = false,
            "--debug" | "--verbose" => debug = true,
            argument if argument.starts_with('-') => {
                return Err(format!("unknown option: {argument}"))
            }
            _ if url.is_some() => return Err("only one URL is supported".into()),
            _ => url = Some(arg),
        }
    }
    let Some(url) = url else { return Ok(None) };
    let server = server_env.unwrap_or(DEFAULT_SERVER_URL);
    let server =
        reqwest::Url::parse(server).map_err(|error| format!("invalid KITESURF_SERVER: {error}"))?;
    if !matches!(server.scheme(), "http" | "https") {
        return Err("server must use http or https".into());
    }
    if server.scheme() == "http"
        && !matches!(server.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    {
        return Err("remote KITESURF_SERVER must use https".into());
    }
    Ok(Some(Options {
        mode,
        url,
        server,
        seconds,
        display,
        debug,
        fps,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_server_override_preserve_url() {
        let named = parse(["https://example.org/?x=1&y=2"].map(str::to_owned), None)
            .unwrap()
            .unwrap();
        assert_eq!(named.url, "https://example.org/?x=1&y=2");
        assert_eq!(named.server.as_str(), "http://127.0.0.1:8787/");
        let overridden = parse(
            ["https://example.org"].map(str::to_owned),
            Some("http://127.0.0.1:9001"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(overridden.url, "https://example.org");
        assert_eq!(overridden.server.as_str(), "http://127.0.0.1:9001/");
        assert!(parse(
            ["https://example.org".to_owned()],
            Some("http://example.com")
        )
        .is_err());
        assert!(parse(
            ["https://example.org".to_owned()],
            Some("http://[::1]:9001")
        )
        .is_ok());
    }

    #[test]
    fn missing_url_shows_help_without_validating_server() {
        assert_eq!(parse([], None).unwrap(), None);
        assert_eq!(parse([], Some("invalid")).unwrap(), None);
        assert_eq!(parse(["--mode=ansi".to_owned()], None).unwrap(), None);
    }

    #[test]
    fn local_replay_accepts_options_in_any_order() {
        let options = parse(
            ["--seconds", "30", "https://example.org"].map(str::to_owned),
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(options.seconds, Some(Duration::from_secs(30)));
        assert_eq!(options.url, "https://example.org");
        assert_eq!(options.server.as_str(), "http://127.0.0.1:8787/");
        assert!(parse(["--remote".to_owned()], None).is_err());
        assert!(parse(
            ["--server", "http://127.0.0.1:9001"].map(str::to_owned),
            None
        )
        .is_err());
    }

    #[test]
    fn ansi_mode_is_explicit() {
        let local = parse(
            ["--mode=ansi", "https://example.org"].map(str::to_owned),
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(local.mode, Mode::Ansi);
        let split = parse(
            ["--mode", "ansi", "https://example.org"].map(str::to_owned),
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(split.mode, Mode::Ansi);
        assert!(parse(["--mode=other".to_owned()], None).is_err());
    }

    #[test]
    fn scene_rate_is_bounded() {
        assert_eq!(
            parse(
                ["--fps", "15", "https://example.org"].map(str::to_owned),
                None
            )
            .unwrap()
            .unwrap()
            .fps,
            15
        );
        assert_eq!(
            parse(["https://example.org".to_owned()], None)
                .unwrap()
                .unwrap()
                .fps,
            60
        );
        for value in ["0", "61", "abc"] {
            assert!(parse(["--fps", value].map(str::to_owned), None).is_err());
        }
    }

    #[test]
    fn debug_flag_is_opt_in() {
        assert!(
            !parse(["https://example.org".to_owned()], None)
                .unwrap()
                .unwrap()
                .debug
        );
        assert!(
            parse(["--debug", "https://example.org"].map(str::to_owned), None)
                .unwrap()
                .unwrap()
                .debug
        );
        assert!(
            parse(
                ["--verbose", "https://example.org"].map(str::to_owned),
                None
            )
            .unwrap()
            .unwrap()
            .debug
        );
    }
}
