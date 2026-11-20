// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use std::time::Duration;
pub use kitesurf_playback::PlaybackMode as Mode;

const MIN_FPS: u8 = 1;
const MAX_FPS: u8 = 60;

pub const HELP: &str =
    "Usage: kitesurf URL [--mode=kitty|ansi] [--fps N] [--seconds N] [--no-display] [--debug]
       kitesurf login | logout

Open a website in an interactive terminal browser using Cloudflare Browser Run.

Authentication:
  Opening a URL without a saved login starts Cloudflare OAuth in your browser.
  After you authorize Kitesurf and select an account, the requested page opens.
  Credentials are saved in the OS keyring and refreshed before new connections.
  A rejected OAuth login starts browser sign-in, then opens the requested page.
  login         Sign in to Cloudflare in your browser and select an account.
  logout        Revoke saved OAuth credentials and remove them from the OS keyring.
  Login uses http://localhost:8976/oauth/callback and waits up to five minutes.
  On Linux, login needs an unlocked Secret Service keyring and a D-Bus session.

Options:
  --playground  Connect directly to kitesurf.dev without Browser Run credentials.
  --mode MODE   Rendering protocol: kitty (default) or ansi (for any terminal).
  --fps N       Maximum scene frames per second (1-60, default 60).
  --seconds N   Stop replay after N seconds and print measurements.
  --no-display  Measure replay without terminal output (800x600 Kitty, 800x595 ANSI).
  --debug       Log connection, downloads and scene-stream events (also --verbose).
  --version     Print the version.
  -h, --help    Show this help.

Environment:
  CLOUDFLARE_ACCOUNT_ID  Select a Cloudflare account; overrides the saved account.
  KITESURF_API_TOKEN     Use an API token instead of OAuth (requires an account ID).
                        The token needs Browser Rendering - Edit permission.
  KITESURF_OAUTH_CLIENT_ID  Override the official OAuth client (for example, staging).
  KITESURF_SERVER        Connect directly to a local or custom engine.
  CF_ACCESS_TOKEN       Cloudflare Access token for a direct engine.

Examples:
  kitesurf https://example.com/
  kitesurf --mode=ansi https://example.com/
  kitesurf --playground https://example.com/
  KITESURF_SERVER=http://127.0.0.1:8799 kitesurf https://example.com/

Kitesurf CLI is still experimental, do not use in a production environment.

Press Ctrl-B when a page is open to toggle a stats bar with accounted server memory.

Go to https://kitesurf.dev/ to learn more.
";

#[derive(Debug, PartialEq)]
pub struct Options {
    pub mode: Mode,
    pub url: String,
    pub backend: Backend,
    pub seconds: Option<Duration>,
    pub display: bool,
    pub debug: bool,
    pub fps: u8,
}

pub const PLAYGROUND: &str = "https://kitesurf.dev";

#[derive(Debug, PartialEq)]
pub enum Backend {
    BrowserRun,
    Direct(reqwest::Url),
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
    let mut playground = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(None),
            "--playground" => playground = true,
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
    if playground && server_env.is_some() {
        return Err("--playground cannot be combined with KITESURF_SERVER".into());
    }
    let backend = match server_env.or(playground.then_some(PLAYGROUND)) {
        Some(server) => Backend::Direct(parse_server(server)?),
        None => Backend::BrowserRun,
    };
    Ok(Some(Options {
        mode,
        url,
        backend,
        seconds,
        display,
        debug,
        fps,
    }))
}

fn parse_server(server: &str) -> Result<reqwest::Url, String> {
    let server =
        reqwest::Url::parse(server).map_err(|error| format!("invalid KITESURF_SERVER: {error}"))?;
    if !matches!(server.scheme(), "http" | "https") {
        return Err("server must use http or https".into());
    }
    if !server.username().is_empty()
        || server.password().is_some()
        || server.query().is_some()
        || server.fragment().is_some()
    {
        return Err("KITESURF_SERVER must not contain credentials, a query, or a fragment".into());
    }
    if server.scheme() == "http"
        && !matches!(server.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    {
        return Err("remote KITESURF_SERVER must use https".into());
    }
    Ok(server)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_server_override_preserve_url() {
        let named = parse(["https://example.com/?x=1&y=2"].map(str::to_owned), None)
            .unwrap()
            .unwrap();
        assert_eq!(named.url, "https://example.com/?x=1&y=2");
        assert_eq!(named.backend, Backend::BrowserRun);
        let overridden = parse(
            ["https://example.com"].map(str::to_owned),
            Some("http://127.0.0.1:9001"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(overridden.url, "https://example.com");
        assert_eq!(
            overridden.backend,
            Backend::Direct(reqwest::Url::parse("http://127.0.0.1:9001/").unwrap())
        );
        assert!(parse(
            ["https://example.com".to_owned()],
            Some("http://example.com")
        )
        .is_err());
        assert!(parse(
            ["https://example.com".to_owned()],
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
            ["--seconds", "30", "https://example.com"].map(str::to_owned),
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(options.seconds, Some(Duration::from_secs(30)));
        assert_eq!(options.url, "https://example.com");
        assert_eq!(options.backend, Backend::BrowserRun);
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
            ["--mode=ansi", "https://example.com"].map(str::to_owned),
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(local.mode, Mode::Ansi);
        let split = parse(
            ["--mode", "ansi", "https://example.com"].map(str::to_owned),
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
                ["--fps", "15", "https://example.com"].map(str::to_owned),
                None
            )
            .unwrap()
            .unwrap()
            .fps,
            15
        );
        assert_eq!(
            parse(["https://example.com".to_owned()], None)
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
            !parse(["https://example.com".to_owned()], None)
                .unwrap()
                .unwrap()
                .debug
        );
        assert!(
            parse(["--debug", "https://example.com"].map(str::to_owned), None)
                .unwrap()
                .unwrap()
                .debug
        );
        assert!(
            parse(
                ["--verbose", "https://example.com"].map(str::to_owned),
                None
            )
            .unwrap()
            .unwrap()
            .debug
        );
    }

    #[test]
    fn playground_is_an_explicit_direct_connection() {
        let options = parse(
            ["--playground", "https://example.com"].map(str::to_owned),
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            options.backend,
            Backend::Direct(reqwest::Url::parse(PLAYGROUND).unwrap())
        );
        assert!(parse(
            ["--playground", "https://example.com"].map(str::to_owned),
            Some("http://localhost:8799")
        )
        .is_err());
        for server in [
            "https://secret@example.com",
            "https://example.com?token=secret",
            "https://example.com#fragment",
        ] {
            assert!(parse(["https://example.com".into()], Some(server)).is_err());
        }
    }
}
