// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Public API for configuring and running a Kitesurf terminal playback session.

mod font_cache;
mod playback;
mod scene_host;
mod wasm;

use std::{error::Error, fmt, time::Duration};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub use font_cache::FontSource;
pub use playback::play;

pub type CdpSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub type PlaybackError = Box<dyn Error>;
pub type PlaybackResult<T> = std::result::Result<T, PlaybackError>;

pub(crate) type Result<T> = PlaybackResult<T>;
pub(crate) use playback::{cache_directory, cdp_call, Diagnostics};
pub(crate) use tokio_tungstenite::tungstenite::Message;

const MIN_FPS: u8 = 1;
const MAX_FPS: u8 = 60;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PlaybackMode {
    #[default]
    Kitty,
    Ansi,
}

impl PlaybackMode {
    pub fn parse(value: &str) -> std::result::Result<Self, String> {
        match value {
            "kitty" => Ok(Self::Kitty),
            "ansi" => Ok(Self::Ansi),
            _ => Err(format!("unknown mode: {value} (expected kitty or ansi)")),
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Self::Kitty => "kitty",
            Self::Ansi => "ansi",
        }
    }
}

#[derive(Debug)]
pub struct InvalidPlaybackFps(u8);

impl fmt::Display for InvalidPlaybackFps {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid fps {} (expected 1-60)", self.0)
    }
}

impl Error for InvalidPlaybackFps {}

/// Settings for one terminal playback session; use `new` to validate the frame rate.
#[derive(Debug)]
pub struct PlaybackOptions {
    pub(crate) url: String,
    pub(crate) mode: PlaybackMode,
    pub(crate) seconds: Option<Duration>,
    pub(crate) display: bool,
    pub(crate) debug: bool,
    pub(crate) fps: u8,
}

impl PlaybackOptions {
    /// Create playback settings.
    /// Returns `InvalidPlaybackFps` unless `fps` is in the inclusive range 1-60.
    pub fn new(
        url: impl Into<String>,
        mode: PlaybackMode,
        seconds: Option<Duration>,
        display: bool,
        debug: bool,
        fps: u8,
    ) -> std::result::Result<Self, InvalidPlaybackFps> {
        if !(MIN_FPS..=MAX_FPS).contains(&fps) {
            return Err(InvalidPlaybackFps(fps));
        }
        Ok(Self {
            url: url.into(),
            mode,
            seconds,
            display,
            debug,
            fps,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playback_options_validate_fps_at_the_public_boundary() {
        for fps in [0, 61, u8::MAX] {
            let error = PlaybackOptions::new(
                "https://example.com/",
                PlaybackMode::Kitty,
                None,
                false,
                false,
                fps,
            )
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                format!("invalid fps {fps} (expected 1-60)")
            );
        }

        assert!(PlaybackOptions::new(
            "https://example.com/",
            PlaybackMode::Ansi,
            None,
            false,
            false,
            MIN_FPS,
        )
        .is_ok());
        assert!(PlaybackOptions::new(
            "https://example.com/",
            PlaybackMode::Kitty,
            None,
            false,
            false,
            MAX_FPS,
        )
        .is_ok());
    }
}
