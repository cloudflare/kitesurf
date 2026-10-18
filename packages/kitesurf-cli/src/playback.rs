// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Runs terminal playback over CDP, rendering scene updates and forwarding user input.

use crate::font_cache::FontCache;
use crate::scene_host;
use crate::wasm::Raster;
#[cfg(test)]
use crate::{scene_host::Manifest, wasm};

use base64::Engine as _;
use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers, MouseEventKind},
    execute, terminal,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::{
    collections::VecDeque,
    io::{self, Write},
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use crate::{
    CdpSocket, FontSource, Message, PlaybackMode as Mode, PlaybackOptions, PlaybackResult, Result,
};

const CONNECTION_LOST: &str =
    "Connection to the Kitesurf server was lost. Check that it is still running, then try again.";
const SERVER_UNRESPONSIVE: &str =
    "Kitesurf server stopped responding. The Worker may have restarted or hit a resource limit; try reconnecting.";
const SCENE_STREAM_STALLED: &str =
    "Scene stream stopped responding. The server may have evicted or stalled an isolate; try reconnecting.";
const CDP_REPLY_TIMEOUT: Duration = Duration::from_secs(30);
// Servers without scene heartbeats get a `Browser.getVersion` probe this often; recent scene
// activity suppresses it, and a probe still needs a reply within `CDP_REPLY_TIMEOUT`.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const MEMORY_INTERVAL: Duration = Duration::from_secs(10);
// Applies only once a heartbeat-capable stream has shown activity. Buffered messages are read
// before deadlines are checked, so slow work does not turn queued heartbeats into stalls.
const SCENE_STALL_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn cache_directory() -> Result<PathBuf> {
    Ok(std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .ok_or("no cache directory")?
        .join("kitesurf"))
}

pub(crate) struct Diagnostics {
    enabled: bool,
    display: bool,
    pending: Vec<String>,
}

impl Diagnostics {
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            enabled,
            display: false,
            pending: Vec::new(),
        }
    }

    pub(crate) fn log(&mut self, message: impl Into<String>) {
        if !self.enabled {
            return;
        }
        let message = message.into();
        if self.display {
            self.pending.push(message);
        } else {
            eprintln!("kitesurf: debug: {message}");
        }
    }

    fn flush(&mut self) {
        let mut stderr = io::stderr().lock();
        for message in self.pending.drain(..) {
            let _ = writeln!(stderr, "kitesurf: debug: {message}");
        }
    }
}

impl Drop for Diagnostics {
    fn drop(&mut self) {
        self.flush();
    }
}

const MIN_VIEWPORT_WIDTH: u16 = 320;
const MIN_VIEWPORT_HEIGHT: u16 = 240;
const MAX_VIEWPORT_WIDTH: u16 = 2560;
const MAX_VIEWPORT_HEIGHT: u16 = 1440;
const NOMINAL_MAX_ANSI_CELL_PIXELS: u16 = 64;
const ANSI_DEFAULT_CELL_WIDTH_PX: u16 = 8;
const ANSI_DEFAULT_CELL_HEIGHT_PX: u16 = 17;
const ANSI_ZOOM_CELL_HEIGHT_PX: f64 = 24.0;
const ANSI_ZOOM_FACTOR: f64 = 2.0;

const KITTY_CHUNK_BYTES: usize = 4096;
const BASE64_INPUT_BYTES_PER_QUANTUM: usize = 3;
const BASE64_OUTPUT_BYTES_PER_QUANTUM: u64 = 4;
const BYTES_PER_KIB: f64 = 1024.0;
const BYTES_PER_MIB: u64 = 1024 * 1024;

const FRAME_HEADER_BYTES: usize = 11;
const PARTIAL_FRAME_HEADER_BYTES: usize = 31;
const RGBA_HEADER_BYTES: usize = 8;
const NO_BASE_SEQUENCE: i32 = -1;

const NO_MISSING_RESOURCES: [u8; 4] = [0; 4];

const INFO_MESSAGE: u8 = 2;
const SCENE_MESSAGE: u8 = 3;
const RESOURCE_MESSAGE: u8 = 4;
const PARTIAL_MESSAGE: u8 = 5;

const CDP_ALT_MODIFIER: u32 = 1;
const CDP_CONTROL_MODIFIER: u32 = 2;
const CDP_META_MODIFIER: u32 = 4;
const CDP_SHIFT_MODIFIER: u32 = 8;
const TEXT_SUPPRESSING_MODIFIERS: u32 = CDP_ALT_MODIFIER | CDP_CONTROL_MODIFIER | CDP_META_MODIFIER;

const MOUSE_WHEEL_DELTA: i32 = 80;

const INPUT_CHANNEL_CAPACITY: usize = 64;

const INPUT_POLL_INTERVAL: Duration = Duration::from_millis(50);
const RESIZE_TICK_INTERVAL: Duration = Duration::from_millis(200);
const RESIZE_RETRY_INTERVAL: Duration = Duration::from_secs(1);
const DEADLINE_POLL_INTERVAL: Duration = Duration::from_millis(100);
const FPS_WINDOW: Duration = Duration::from_secs(1);
const SCENE_HEARTBEAT_MS: u64 = 1_000;

const DEBUG_BAR_ROWS: u16 = 1;

const OP_PUT_RESOURCES: u32 = 1;
const OP_SCENE_MISSING_RESOURCES: u32 = 2;
const OP_RENDER_PNG: u32 = 3;
const OP_PENDING_FONTS: u32 = 5;
const OP_PUT_FONT: u32 = 6;
const OP_LAST_ERROR: u32 = 7;
const OP_PENDING_IMAGES: u32 = 8;
const OP_ABANDON_IMAGE: u32 = 9;
const OP_ENABLE_ANSI: u32 = 12;
const OP_RENDER_ANSI: u32 = 13;
const OP_RENDER_RGBA: u32 = 14;
const OP_RETAIN_FRAME: u32 = 15;
const OP_COMPOSITE_FRAME: u32 = 16;
const MIN_RAW_FILE_ABI: u32 = 4;

#[derive(Deserialize)]
struct FontAsset {
    path: String,
}

struct Frame {
    scene: Vec<u8>,
    seq: u32,
    partial: bool,
    width: u16,
    height: u16,
    x: i32,
    y: i32,
    base: i32,
}

#[derive(Clone, Copy)]
struct SceneStreamOptions {
    mode: Mode,
    cell: AnsiCell,
    fps: u8,
    allow_partial: bool,
}

struct DisplaySize {
    cell_w: f64,
    cell_h: f64,
    cols: u16,
    rows: u16,
}

#[derive(Clone, Copy)]
struct AnsiCell {
    w: u16,
    h: u16,
}

impl AnsiCell {
    fn new(size: &DisplaySize) -> Self {
        let zoom = if size.cell_h >= ANSI_ZOOM_CELL_HEIGHT_PX {
            ANSI_ZOOM_FACTOR
        } else {
            1.0
        };
        let page_rows = size.rows.saturating_sub(DEBUG_BAR_ROWS).max(1);
        let fit = |px: f64, cells: u16, min: u16, max: u16| {
            let min_cell = min.div_ceil(cells.max(1));
            (px / zoom).round().clamp(
                f64::from(min_cell),
                f64::from(
                    NOMINAL_MAX_ANSI_CELL_PIXELS
                        .min(max / cells.max(1))
                        .max(min_cell),
                ),
            ) as u16
        };
        Self {
            w: fit(
                size.cell_w,
                size.cols,
                MIN_VIEWPORT_WIDTH,
                MAX_VIEWPORT_WIDTH,
            ),
            h: fit(
                size.cell_h,
                page_rows,
                MIN_VIEWPORT_HEIGHT,
                MAX_VIEWPORT_HEIGHT,
            ),
        }
    }

    fn viewport(self, size: &DisplaySize) -> (u16, u16) {
        (
            size.cols
                .saturating_mul(self.w)
                .clamp(MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH),
            size.rows
                .saturating_sub(DEBUG_BAR_ROWS)
                .max(1)
                .saturating_mul(self.h)
                .clamp(MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT),
        )
    }
}

struct ResizeSync {
    awaiting: bool,
    sent_at: Instant,
}

#[derive(Default)]
struct DebugBar {
    visible: bool,
    painted_at: VecDeque<Instant>,
    mode: Mode,
    accounted_bytes: Option<u64>,
}

impl DebugBar {
    fn painted(&mut self) {
        self.discard_expired_timestamps();
        self.painted_at.push_back(Instant::now());
    }

    fn fps(&mut self) -> usize {
        self.discard_expired_timestamps();
        self.painted_at.len()
    }

    fn discard_expired_timestamps(&mut self) {
        while self
            .painted_at
            .front()
            .is_some_and(|at| at.elapsed() > FPS_WINDOW)
        {
            self.painted_at.pop_front();
        }
    }

    fn line(&mut self, wire_bytes: u64, frames: u64, w: u16, h: u16) -> String {
        let wire = if wire_bytes >= BYTES_PER_MIB {
            format!("{:.1} MiB", wire_bytes as f64 / BYTES_PER_MIB as f64)
        } else {
            format!("{:.1} KiB", wire_bytes as f64 / BYTES_PER_KIB)
        };
        format!(
            " FPS {} | wire {} | acct {} | mode {} | frames {} | {}x{}",
            self.fps(),
            wire,
            self.accounted_bytes
                .map_or("--".to_owned(), |bytes| format!(
                    "{:.1}MiB",
                    bytes as f64 / BYTES_PER_MIB as f64
                )),
            self.mode.slug(),
            frames,
            w,
            h
        )
    }

    fn paint(&mut self, wire_bytes: u64, frames: u64, w: u16, h: u16) -> io::Result<()> {
        if !self.visible {
            return Ok(());
        }
        let (cols, rows) = terminal::size()?;
        if rows <= DEBUG_BAR_ROWS {
            return Ok(());
        }
        let mut line = self.line(wire_bytes, frames, w, h);
        line.truncate(usize::from(cols));
        let line = format!("{line:<width$}", width = usize::from(cols));
        let mut out = io::stdout().lock();
        write!(
            out,
            "\x1b7\x1b[{};1H\x1b[?7l\x1b[48;5;236m\x1b[97m{}\x1b[0m\x1b[?7h\x1b8",
            rows, line
        )?;
        out.flush()
    }

    fn clear(&self) -> io::Result<()> {
        let (_, rows) = terminal::size()?;
        if rows < 2 {
            return Ok(());
        }
        let mut out = io::stdout().lock();
        write!(out, "\x1b7\x1b[{};1H\x1b[0m\x1b[2K\x1b8", rows)?;
        out.flush()
    }
}

#[derive(Default)]
struct KittyImages {
    displayed: Option<u32>,
    local_files: bool,
    raw_files: bool,
    temp_dir: Option<PathBuf>,
    file_seq: u64,
    last_bytes: u64,
}

impl KittyImages {
    fn temp_file(&mut self, pixels: &[u8], rgba: bool) -> io::Result<PathBuf> {
        if self.temp_dir.is_none() {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "tty-graphics-protocol-kitesurf-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir(&dir)?;
            self.temp_dir = Some(dir);
        }
        self.file_seq += 1;
        let path = self
            .temp_dir
            .as_ref()
            .expect("temp directory created above")
            .join(format!(
                "{}.{}",
                self.file_seq,
                if rgba { "rgba" } else { "png" }
            ));
        std::fs::write(&path, pixels)?;
        Ok(path)
    }
}

impl Drop for KittyImages {
    fn drop(&mut self) {
        if let Some(dir) = &self.temp_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

impl ResizeSync {
    fn new() -> Self {
        Self {
            awaiting: false,
            sent_at: Instant::now(),
        }
    }

    fn sent(&mut self) {
        self.awaiting = true;
        self.sent_at = Instant::now();
    }

    fn painted(&mut self, frame: &Frame) {
        // A resize stays pending until a full frame for the requested viewport arrives.
        if !frame.partial {
            self.awaiting = false;
        }
    }

    fn retry_due(&self) -> bool {
        self.awaiting && self.sent_at.elapsed() >= RESIZE_RETRY_INTERVAL
    }
}

enum ReplayResult {
    Skipped,
    MissingResources(Vec<u8>),
    Painted,
}

struct ReplayState {
    cell: AnsiCell,
    painted_seq: Option<u32>,
    pending: Option<Frame>,
    resize_sync: ResizeSync,
    kitty_images: KittyImages,
    debug: DebugBar,
    frames: u64,
    wire_bytes: u64,
    terminal_bytes: u64,
    raster_time: Duration,
    retained_frames: bool,
}

impl ReplayState {
    fn new(mode: Mode, cell: AnsiCell, kitty_images: KittyImages) -> Self {
        Self {
            cell,
            painted_seq: None,
            pending: None,
            resize_sync: ResizeSync::new(),
            kitty_images,
            debug: DebugBar {
                mode,
                ..DebugBar::default()
            },
            frames: 0,
            wire_bytes: 0,
            terminal_bytes: 0,
            raster_time: Duration::ZERO,
            retained_frames: false,
        }
    }

    fn paint(
        &mut self,
        raster: &mut Raster,
        frame: &Frame,
        w: u16,
        h: u16,
        display: bool,
        size: &DisplaySize,
    ) -> Result<ReplayResult> {
        if !can_paint(frame, self.painted_seq, w, h) {
            return Ok(ReplayResult::Skipped);
        }
        if frame.partial && (self.debug.mode != Mode::Kitty || !self.retained_frames) {
            return Ok(ReplayResult::Skipped);
        }

        let missing = raster.run(OP_SCENE_MISSING_RESOURCES, &frame.scene)?;
        if !missing.starts_with(&NO_MISSING_RESOURCES) {
            return Ok(ReplayResult::MissingResources(missing));
        }

        let started = Instant::now();
        let is_ansi = self.debug.mode == Mode::Ansi;
        let output = if is_ansi {
            render_ansi(raster, frame, size, self.cell)?
        } else {
            render(
                raster,
                frame,
                w,
                h,
                self.kitty_images.raw_files,
                self.retained_frames,
            )?
        };
        if output.is_empty() {
            // A failed composite drops its retained base. Reject subsequent patches
            // until a full frame establishes both the local and server baselines.
            self.painted_seq = None;
            return Ok(ReplayResult::Skipped);
        }
        self.raster_time += started.elapsed();
        if display {
            if is_ansi {
                display_ansi(&output)?;
            } else {
                // The rasterizer composites server patches locally. Ghostty needs
                // a complete image and does not implement Kitty's a=f patches.
                kitty(&output, &mut self.kitty_images, self.debug.visible)?;
            }
        }
        self.terminal_bytes += if is_ansi {
            output.len() as u64
        } else if display {
            self.kitty_images.last_bytes
        } else {
            output.len().div_ceil(BASE64_INPUT_BYTES_PER_QUANTUM) as u64
                * BASE64_OUTPUT_BYTES_PER_QUANTUM
        };
        self.painted_seq = Some(frame.seq);
        self.frames += 1;
        self.debug.painted();
        self.debug.paint(self.wire_bytes, self.frames, w, h)?;
        self.resize_sync.painted(frame);
        Ok(ReplayResult::Painted)
    }
}

impl DisplaySize {
    fn new() -> Self {
        let window = terminal::window_size().ok();
        let (cols, rows) = window
            .as_ref()
            .map_or((100, 35), |size| (size.columns, size.rows));
        let (reported_w, reported_h) = window
            .as_ref()
            .map_or((0, 0), |size| (size.width, size.height));
        let (cell_w, cell_h) = if reported_w > 0 && reported_h > 0 {
            (
                f64::from(reported_w) / f64::from(cols.max(1)),
                f64::from(reported_h) / f64::from(rows.max(1)),
            )
        } else {
            (
                f64::from(ANSI_DEFAULT_CELL_WIDTH_PX),
                f64::from(ANSI_DEFAULT_CELL_HEIGHT_PX),
            )
        };
        Self {
            cell_w,
            cell_h,
            cols,
            rows,
        }
    }

    fn pixels(&self, debug: bool) -> (u16, u16) {
        let zoom = if self.cell_h >= ANSI_ZOOM_CELL_HEIGHT_PX {
            ANSI_ZOOM_FACTOR
        } else {
            1.0
        };
        let w = (f64::from(self.cols) * self.cell_w / zoom)
            .round()
            .min(f64::from(u16::MAX)) as u16;
        let h = (f64::from(self.rows - u16::from(debug && self.rows > 1)) * self.cell_h / zoom)
            .round()
            .min(f64::from(u16::MAX)) as u16;
        viewport_size(self.cols, self.rows, w, h)
    }

    fn resize(&mut self, cols: u16, rows: u16, debug: bool) -> (u16, u16) {
        self.cols = cols;
        self.rows = rows;
        self.pixels(debug)
    }
}

fn viewport_size(cols: u16, rows: u16, width: u16, height: u16) -> (u16, u16) {
    let w = f64::from(if width > 0 {
        width
    } else {
        cols.saturating_mul(ANSI_DEFAULT_CELL_WIDTH_PX)
    });
    let h = f64::from(if height > 0 {
        height
    } else {
        rows.saturating_mul(ANSI_DEFAULT_CELL_HEIGHT_PX)
    });
    let max_scale = (f64::from(MAX_VIEWPORT_WIDTH) / w.max(1.0))
        .min(f64::from(MAX_VIEWPORT_HEIGHT) / h.max(1.0));
    let min_scale = (f64::from(MIN_VIEWPORT_WIDTH) / w.max(1.0))
        .max(f64::from(MIN_VIEWPORT_HEIGHT) / h.max(1.0));
    let scale = if min_scale <= max_scale {
        min_scale.max(1.0).min(max_scale)
    } else {
        max_scale.min(1.0)
    };
    (
        (w * scale)
            .round()
            .clamp(f64::from(MIN_VIEWPORT_WIDTH), f64::from(MAX_VIEWPORT_WIDTH)) as u16,
        (h * scale).round().clamp(
            f64::from(MIN_VIEWPORT_HEIGHT),
            f64::from(MAX_VIEWPORT_HEIGHT),
        ) as u16,
    )
}

fn kitty_to(
    out: &mut impl Write,
    output: &[u8],
    cols: u16,
    rows: Option<u16>,
    images: &mut KittyImages,
    rgba: bool,
) -> io::Result<()> {
    let id = if images.displayed == Some(1) { 2 } else { 1 };
    write!(out, "\x1b[1;1H")?;
    let (pixels, format) = if rgba {
        let header = output
            .get(..RGBA_HEADER_BYTES)
            .ok_or(io::ErrorKind::InvalidData)?;
        let width = u32::from_le_bytes(header[..4].try_into().expect("eight-byte RGBA header"));
        let height = u32::from_le_bytes(header[4..].try_into().expect("eight-byte RGBA header"));
        if width == 0
            || height == 0
            || usize::try_from(u64::from(width) * u64::from(height) * 4).ok()
                != Some(output.len() - RGBA_HEADER_BYTES)
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        (
            &output[RGBA_HEADER_BYTES..],
            format!("f=32,s={width},v={height}"),
        )
    } else {
        (output, "f=100".to_owned())
    };
    let placement = if let Some(rows) = rows {
        format!("a=T,{format},i={id},q=1,C=1,c={cols},r={rows}")
    } else {
        format!("a=T,{format},i={id},q=1,C=1,c={cols}")
    };
    if images.local_files {
        if let Ok(path) = images.temp_file(pixels, rgba) {
            let path = path.to_string_lossy();
            kitty_transmit_to(out, path.as_bytes(), &format!("{placement},t=t"))?;
            images.last_bytes = path.len().div_ceil(BASE64_INPUT_BYTES_PER_QUANTUM) as u64
                * BASE64_OUTPUT_BYTES_PER_QUANTUM;
        } else {
            kitty_transmit_to(out, pixels, &placement)?;
            images.last_bytes = pixels.len().div_ceil(BASE64_INPUT_BYTES_PER_QUANTUM) as u64
                * BASE64_OUTPUT_BYTES_PER_QUANTUM;
        }
    } else {
        kitty_transmit_to(out, pixels, &placement)?;
        images.last_bytes = pixels.len().div_ceil(BASE64_INPUT_BYTES_PER_QUANTUM) as u64
            * BASE64_OUTPUT_BYTES_PER_QUANTUM;
    }
    if let Some(old) = images.displayed {
        write!(out, "\x1b_Ga=d,d=I,i={old},q=1;\x1b\\")?;
    }
    out.flush()?;
    images.displayed = Some(id);
    Ok(())
}

fn kitty_transmit_to(out: &mut impl Write, payload: &[u8], first: &str) -> io::Result<()> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(payload);
    for (chunk_index, chunk) in encoded.as_bytes().chunks(KITTY_CHUNK_BYTES).enumerate() {
        let more = if (chunk_index + 1) * KITTY_CHUNK_BYTES < encoded.len() {
            1
        } else {
            0
        };
        if chunk_index == 0 {
            write!(out, "\x1b_G{first},m={more};")?;
        } else {
            // q=1 suppresses success replies; q=2 suppresses errors instead.
            // Continuation chunks may specify their own response policy.
            write!(out, "\x1b_Gm={more},q=1;")?;
        }
        out.write_all(chunk)?;
        out.write_all(b"\x1b\\")?;
    }
    Ok(())
}

fn intersects_viewport(frame: &Frame, w: u16, h: u16) -> bool {
    let x = i64::from(frame.x);
    let y = i64::from(frame.y);
    frame.width > 0
        && frame.height > 0
        && x < i64::from(w)
        && y < i64::from(h)
        && x + i64::from(frame.width) > 0
        && y + i64::from(frame.height) > 0
}

fn kitty(output: &[u8], images: &mut KittyImages, debug: bool) -> io::Result<()> {
    let (cols, rows) = terminal::size()?;
    let rgba = images.raw_files;
    kitty_to(
        &mut io::stdout().lock(),
        output,
        cols,
        debug.then_some(rows.saturating_sub(DEBUG_BAR_ROWS).max(1)),
        images,
        rgba,
    )
}

fn display_ansi(bytes: &[u8]) -> io::Result<()> {
    let text = bytes.strip_suffix(b"\r\n").unwrap_or(bytes);
    let mut out = io::stdout().lock();
    out.write_all(b"\x1b[1;1H")?;
    out.write_all(text)?;
    out.flush()
}

fn resize_view(
    size: &mut DisplaySize,
    cols: u16,
    rows: u16,
    debug: bool,
    mode: Mode,
    cell: AnsiCell,
) -> (u16, u16) {
    if mode == Mode::Kitty {
        size.resize(cols, rows, debug)
    } else {
        size.cols = cols;
        size.rows = rows;
        cell.viewport(size)
    }
}

fn key_message(key: event::KeyEvent) -> Option<(&'static str, serde_json::Value)> {
    let modifiers = (if key.modifiers.contains(KeyModifiers::ALT) {
        CDP_ALT_MODIFIER
    } else {
        0
    }) | (if key.modifiers.contains(KeyModifiers::CONTROL) {
        CDP_CONTROL_MODIFIER
    } else {
        0
    }) | (if key.modifiers.contains(KeyModifiers::SUPER) {
        CDP_META_MODIFIER
    } else {
        0
    }) | (if key.modifiers.contains(KeyModifiers::SHIFT) {
        CDP_SHIFT_MODIFIER
    } else {
        0
    });
    let (name, code, virtual_key_code, text) = match key.code {
        KeyCode::Char(c) => (
            c.to_string(),
            format!("Key{}", c.to_ascii_uppercase()),
            u32::from(c.to_ascii_uppercase()),
            c.to_string(),
        ),
        KeyCode::Enter => ("Enter".into(), "Enter".into(), 13, "\r".into()),
        KeyCode::Backspace => ("Backspace".into(), "Backspace".into(), 8, "".into()),
        KeyCode::Tab | KeyCode::BackTab => ("Tab".into(), "Tab".into(), 9, "".into()),
        KeyCode::Esc => ("Escape".into(), "Escape".into(), 27, "".into()),
        KeyCode::Up => ("ArrowUp".into(), "ArrowUp".into(), 38, "".into()),
        KeyCode::Down => ("ArrowDown".into(), "ArrowDown".into(), 40, "".into()),
        KeyCode::Left => ("ArrowLeft".into(), "ArrowLeft".into(), 37, "".into()),
        KeyCode::Right => ("ArrowRight".into(), "ArrowRight".into(), 39, "".into()),
        KeyCode::PageUp => ("PageUp".into(), "PageUp".into(), 33, "".into()),
        KeyCode::PageDown => ("PageDown".into(), "PageDown".into(), 34, "".into()),
        _ => return None,
    };
    let kind = if key.kind == KeyEventKind::Release {
        "keyUp"
    } else {
        "rawKeyDown"
    };
    let text = if modifiers & TEXT_SUPPRESSING_MODIFIERS != 0 {
        ""
    } else {
        text.as_str()
    };
    Some((
        "Input.dispatchKeyEvent",
        serde_json::json!({
            "type": kind,
            "key": name,
            "code": code,
            "windowsVirtualKeyCode": virtual_key_code,
            "text": text,
            "modifiers": modifiers,
        }),
    ))
}

fn input_event(
    ev: Event,
    w: u16,
    h: u16,
    grid: Option<(u16, u16)>,
    page_rows: Option<u16>,
    mouse_down: &mut bool,
) -> Option<(&'static str, serde_json::Value)> {
    match ev {
        Event::Key(key) => key_message(key),
        Event::Mouse(mouse) => {
            let (cols, rows) = grid?;
            let rows = page_rows.unwrap_or(rows);
            if mouse.row >= rows {
                return None;
            }
            let x = u32::from(mouse.column) * u32::from(w) / u32::from(cols.max(1));
            let y = u32::from(mouse.row) * u32::from(h) / u32::from(rows.max(1));
            let params = match mouse.kind {
                MouseEventKind::ScrollDown => serde_json::json!({
                    "type": "mouseWheel", "x": x, "y": y,
                    "deltaX": 0, "deltaY": MOUSE_WHEEL_DELTA,
                }),
                MouseEventKind::ScrollUp => serde_json::json!({
                    "type": "mouseWheel", "x": x, "y": y,
                    "deltaX": 0, "deltaY": -MOUSE_WHEEL_DELTA,
                }),
                MouseEventKind::Down(_) => {
                    *mouse_down = true;
                    serde_json::json!({
                        "type": "mousePressed", "x": x, "y": y,
                        "button": "left", "buttons": 1, "clickCount": 1,
                    })
                }
                MouseEventKind::Up(_) => {
                    *mouse_down = false;
                    serde_json::json!({
                        "type": "mouseReleased", "x": x, "y": y,
                        "button": "left", "buttons": 0, "clickCount": 1,
                    })
                }
                MouseEventKind::Drag(_) | MouseEventKind::Moved => serde_json::json!({
                    "type": "mouseMoved", "x": x, "y": y,
                    "button": if *mouse_down { "left" } else { "none" },
                    "buttons": if *mouse_down { 1 } else { 0 }, "clickCount": 1,
                }),
                _ => return None,
            };
            Some(("Input.dispatchMouseEvent", params))
        }
        _ => None,
    }
}

async fn cdp_send(
    ws: &mut CdpSocket,
    id: &mut u64,
    method: &str,
    params: serde_json::Value,
    session: Option<&str>,
) -> Result<u64> {
    *id += 1;
    let current = *id;
    let text = serde_json::json!({
        "id": current, "method": method, "params": params, "sessionId": session,
    })
    .to_string();
    tokio::time::timeout(CDP_REPLY_TIMEOUT, ws.send(Message::Text(text.into())))
        .await
        .map_err(|_| SERVER_UNRESPONSIVE)??;
    Ok(current)
}

pub(crate) async fn cdp_call(
    ws: &mut CdpSocket,
    id: &mut u64,
    method: &str,
    params: serde_json::Value,
    session: Option<&str>,
    queued: &mut VecDeque<Message>,
) -> Result<serde_json::Value> {
    let sent = cdp_send(ws, id, method, params, session).await?;
    let deadline = tokio::time::Instant::now() + CDP_REPLY_TIMEOUT;
    while let Some(message) = tokio::time::timeout_at(deadline, ws.next())
        .await
        .map_err(|_| SERVER_UNRESPONSIVE)?
    {
        let message = message?;
        if let Message::Text(text) = &message {
            let reply: serde_json::Value = serde_json::from_str(text)?;
            if reply["id"].as_u64() == Some(sent) {
                if !reply["error"].is_null() {
                    return Err(format!("{method}: {}", reply["error"]).into());
                }
                return Ok(reply["result"].clone());
            }
        }
        queued.push_back(message);
    }
    Err(CONNECTION_LOST.into())
}

fn acknowledge_probe(
    reply: &serde_json::Value,
    pending: &mut Option<(u64, Instant)>,
) -> Result<()> {
    if pending.is_some_and(|(id, _)| reply["id"].as_u64() == Some(id)) {
        if !reply["error"].is_null() {
            return Err(format!(
                "Kitesurf server rejected the liveness check: {}",
                reply["error"]
            )
            .into());
        }
        *pending = None;
    }
    Ok(())
}

fn scene_stall_deadline(last: Option<Instant>, heartbeat: bool) -> Option<tokio::time::Instant> {
    last.filter(|_| heartbeat)
        .map(|at| (at + SCENE_STALL_TIMEOUT).into())
}

async fn cdp_resize(
    ws: &mut CdpSocket,
    id: &mut u64,
    session: &str,
    w: u16,
    h: u16,
    options: SceneStreamOptions,
    queued: &mut VecDeque<Message>,
) -> Result<bool> {
    cdp_call(
        ws,
        id,
        "Emulation.setDeviceMetricsOverride",
        serde_json::json!({
            "width": w, "height": h, "deviceScaleFactor": 1, "mobile": false,
        }),
        Some(session),
        queued,
    )
    .await?;
    let started = cdp_call(
        ws,
        id,
        "Kitesurf.startSceneStream",
        serde_json::json!({
            "width": w, "height": h, "fps": options.fps,
            "text": options.mode == Mode::Ansi,
            "allowPartial": options.allow_partial,
            "terminal": true, "cellW": options.cell.w, "cellH": options.cell.h,
        }),
        Some(session),
        queued,
    )
    .await?;
    Ok(started["heartbeatMs"].as_u64() == Some(SCENE_HEARTBEAT_MS))
}

async fn cdp_ack(
    ws: &mut CdpSocket,
    id: &mut u64,
    session: &str,
    seq: u32,
    painted: bool,
) -> Result<()> {
    cdp_send(
        ws,
        id,
        "Kitesurf.sceneFrameAck",
        serde_json::json!({
            "seq": seq, "painted": painted,
        }),
        Some(session),
    )
    .await?;
    Ok(())
}

fn keyboard_flags() -> event::KeyboardEnhancementFlags {
    event::KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
        | event::KeyboardEnhancementFlags::REPORT_EVENT_TYPES
        | event::KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES
}

struct Terminal {
    keyboard_enhanced: bool,
}
impl Terminal {
    fn enter() -> Result<Self> {
        terminal::enable_raw_mode()?;
        let mut terminal = Self {
            keyboard_enhanced: false,
        };
        execute!(
            io::stdout(),
            terminal::EnterAlternateScreen,
            event::EnableMouseCapture,
            cursor::Hide
        )?;
        execute!(
            io::stdout(),
            event::PushKeyboardEnhancementFlags(keyboard_flags())
        )?;
        terminal.keyboard_enhanced = true;
        Ok(terminal)
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        if self.keyboard_enhanced {
            let _ = execute!(io::stdout(), event::PopKeyboardEnhancementFlags);
        }
        let _ = execute!(
            io::stdout(),
            event::DisableMouseCapture,
            cursor::Show,
            terminal::LeaveAlternateScreen
        );
        let _ = terminal::disable_raw_mode();
    }
}

async fn fonts(
    cache: &FontCache,
    raster: &mut Raster,
    diagnostics: &mut Diagnostics,
) -> Result<()> {
    let pending = raster.run(OP_PENDING_FONTS, &[])?;
    for asset in serde_json::from_slice::<Vec<FontAsset>>(&pending)? {
        if !asset.path.starts_with("/fonts/") || asset.path.contains("..") {
            continue;
        }
        let bytes = cache.get(&asset.path, diagnostics).await?;
        let path_len = u32::try_from(asset.path.len())?;
        diagnostics.log(format!(
            "loaded {} font bytes for {}",
            bytes.len(),
            asset.path
        ));
        let mut data = Vec::with_capacity(4 + asset.path.len() + bytes.len());
        data.extend_from_slice(&path_len.to_le_bytes());
        data.extend_from_slice(asset.path.as_bytes());
        data.extend_from_slice(&bytes);
        raster.run(OP_PUT_FONT, &data)?;
    }
    Ok(())
}

fn retire_unavailable_images(raster: &mut Raster) -> Result<()> {
    let pending: Vec<String> = serde_json::from_slice(&raster.run(OP_PENDING_IMAGES, &[])?)?;
    for key in pending {
        raster.run(OP_ABANDON_IMAGE, key.as_bytes())?;
    }
    Ok(())
}

fn parse_frame(bytes: &[u8]) -> Result<Frame> {
    if bytes.len() < FRAME_HEADER_BYTES {
        return Err("short RBI frame".into());
    }
    let partial = bytes[0] == PARTIAL_MESSAGE;
    if partial && bytes.len() < PARTIAL_FRAME_HEADER_BYTES {
        return Err("short partial frame".into());
    }
    let (x, y, base, offset) = if partial {
        (
            i32::from_le_bytes(bytes[11..15].try_into()?),
            i32::from_le_bytes(bytes[15..19].try_into()?),
            i32::from_le_bytes(bytes[27..31].try_into()?),
            PARTIAL_FRAME_HEADER_BYTES,
        )
    } else {
        (0, 0, NO_BASE_SEQUENCE, FRAME_HEADER_BYTES)
    };
    Ok(Frame {
        scene: bytes[offset..].to_vec(),
        seq: u32::from_le_bytes(bytes[3..7].try_into()?),
        partial,
        width: u16::from_le_bytes(bytes[7..9].try_into()?),
        height: u16::from_le_bytes(bytes[9..11].try_into()?),
        x,
        y,
        base,
    })
}

fn can_paint(frame: &Frame, painted_seq: Option<u32>, w: u16, h: u16) -> bool {
    if painted_seq.is_some_and(|painted_seq| frame.seq < painted_seq) {
        return false;
    }
    // A resize can land between the server's envelope snapshot and
    // the scene record. Trust the raster's own viewport as well as
    // the envelope before letting Ghostty scale it to the window.
    let dimensions_match = frame.scene.get(8..16).is_some_and(|dims| {
        (
            u32::from_le_bytes(dims[..4].try_into().expect("four-byte scene width")),
            u32::from_le_bytes(dims[4..].try_into().expect("four-byte scene height")),
        ) == (u32::from(frame.width), u32::from(frame.height))
    });
    dimensions_match
        && if frame.partial {
            painted_seq.is_some_and(|seq| frame.base.to_le_bytes() == seq.to_le_bytes())
                && intersects_viewport(frame, w, h)
        } else {
            (frame.width, frame.height) == (w, h)
        }
}

fn scene_version(scene: &[u8]) -> Option<u32> {
    scene
        .get(4..8)
        .and_then(|bytes| bytes.try_into().ok().map(u32::from_le_bytes))
}

/// Run a browser session in the terminal using a browser-level CDP WebSocket.
/// Takes ownership of `ws`; connection, font-fetch, Wasm, and terminal errors are returned.
pub async fn play(
    mut ws: CdpSocket,
    opts: PlaybackOptions,
    font_source: FontSource,
) -> PlaybackResult<()> {
    let PlaybackOptions {
        url: target,
        seconds,
        display,
        debug: verbose,
        mode,
        fps,
    } = opts;
    let mut diagnostics = Diagnostics::new(verbose);
    let font_cache = FontCache::new(font_source)?;
    diagnostics.log("CDP WebSocket connected");
    let mut next_id = 0;
    let mut queued = VecDeque::new();
    let (manifest, bytes) =
        scene_host::artifact(&mut ws, &mut next_id, &mut queued, &mut diagnostics).await?;
    let compile_start = Instant::now();
    diagnostics.log(format!(
        "compiling scene rasterizer ({} Wasm bytes)",
        bytes.len()
    ));
    let mut raster = Raster::new(&bytes)?;
    let partial_scenes = mode == Mode::Kitty && manifest.retained_frames;
    if mode == Mode::Ansi {
        raster.run(OP_ENABLE_ANSI, &[])?;
    }
    diagnostics.log(format!(
        "scene rasterizer ready ({}) in {:.1}s",
        mode.slug(),
        compile_start.elapsed().as_secs_f64()
    ));
    let mut display_size = display.then(DisplaySize::new);
    let fallback_size = DisplaySize {
        cell_w: f64::from(ANSI_DEFAULT_CELL_WIDTH_PX),
        cell_h: f64::from(ANSI_DEFAULT_CELL_HEIGHT_PX),
        cols: 100,
        rows: 36,
    };
    let size = display_size.as_ref().unwrap_or(&fallback_size);
    let cell = AnsiCell::new(size);
    let stream_options = SceneStreamOptions {
        mode,
        cell,
        fps,
        allow_partial: partial_scenes,
    };
    let (mut w, mut h) = if mode == Mode::Ansi {
        cell.viewport(size)
    } else {
        display_size
            .as_ref()
            .map_or((800, 600), |size| size.pixels(display))
    };
    let mut mouse_down = false;
    let targets = cdp_call(
        &mut ws,
        &mut next_id,
        "Target.getTargets",
        serde_json::json!({}),
        None,
        &mut queued,
    )
    .await?;
    let existing_page = targets["targetInfos"]
        .as_array()
        .and_then(|targets| targets.iter().find(|target| target["type"] == "page"))
        .and_then(|page| page["targetId"].as_str())
        .map(str::to_owned);
    let page_id = match existing_page {
        Some(id) => id,
        None => cdp_call(
            &mut ws,
            &mut next_id,
            "Target.createTarget",
            serde_json::json!({"url": "about:blank"}),
            None,
            &mut queued,
        )
        .await?["targetId"]
            .as_str()
            .ok_or("CDP target creation failed")?
            .to_owned(),
    };
    let attached = cdp_call(
        &mut ws,
        &mut next_id,
        "Target.attachToTarget",
        serde_json::json!({"targetId": page_id, "flatten": true}),
        None,
        &mut queued,
    )
    .await?;
    let session = attached["sessionId"]
        .as_str()
        .ok_or("CDP attach failed")?
        .to_owned();
    diagnostics.log(format!(
        "attached to page target {page_id}; starting scene stream at {w}x{h}, {fps} fps"
    ));
    let scene_heartbeat = cdp_resize(
        &mut ws,
        &mut next_id,
        &session,
        w,
        h,
        stream_options,
        &mut queued,
    )
    .await?;
    diagnostics.log(format!("navigating to {target}"));
    cdp_call(
        &mut ws,
        &mut next_id,
        "Page.navigate",
        serde_json::json!({"url": target}),
        Some(&session),
        &mut queued,
    )
    .await?;
    let _terminal = if display {
        Some(Terminal::enter()?)
    } else {
        None
    };
    diagnostics.display = display;
    let (tx, mut rx) = tokio::sync::mpsc::channel(INPUT_CHANNEL_CAPACITY);
    if display {
        let initial_grid = display_size.as_ref().map(|size| (size.cols, size.rows));
        std::thread::spawn(move || {
            let mut last_size = initial_grid;
            loop {
                match event::poll(INPUT_POLL_INTERVAL) {
                    Ok(true) => {
                        if let Ok(ev) = event::read() {
                            if tx.blocking_send(ev).is_err() {
                                break;
                            }
                        }
                    }
                    Ok(false) => {}
                    Err(_) => break,
                }
                if let Ok(size) = terminal::size() {
                    if last_size != Some(size) {
                        last_size = Some(size);
                        if tx.blocking_send(Event::Resize(size.0, size.1)).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    let start = Instant::now();
    let local_files = std::env::var("TERM_PROGRAM")
        .is_ok_and(|name| name.eq_ignore_ascii_case("ghostty"))
        && std::env::var_os("SSH_CONNECTION").is_none()
        && std::env::var_os("TMUX").is_none();
    let raw_files = local_files
        && manifest.abi >= MIN_RAW_FILE_ABI
        && std::env::var_os("KITESURF_KITTY_PNG").is_none();
    let mut kitty_images = KittyImages::default();
    kitty_images.local_files = local_files;
    kitty_images.raw_files = raw_files;
    let mut replay = ReplayState::new(mode, cell, kitty_images);
    replay.retained_frames = partial_scenes;
    replay.debug.visible = display;
    let shutdown = tokio::signal::ctrl_c();
    tokio::pin!(shutdown);
    let mut resize_tick = tokio::time::interval(RESIZE_TICK_INTERVAL);
    resize_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut heartbeat_tick = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut pending_probe: Option<(u64, Instant)> = None;
    let mut last_scene_activity: Option<Instant> = None;
    let mut memory_tick = tokio::time::interval(MEMORY_INTERVAL);
    memory_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut pending_memory: Option<(u64, Instant)> = None;
    let mut scenes = 0u64;
    let deadline = seconds.map(|duration| start + duration);
    loop {
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            break;
        }
        let scene_stall_at = scene_stall_deadline(last_scene_activity, scene_heartbeat);
        tokio::select! {
            biased;
            signal = &mut shutdown, if display => { signal?; break; }
            Some(ev) = rx.recv(), if display => {
                if matches!(&ev, Event::Key(key) if key.code == KeyCode::Char('c') &&
                    key.modifiers.contains(event::KeyModifiers::CONTROL)) { break; }
                if matches!(&ev, Event::Key(key) if key.code == KeyCode::Char('b') &&
                    key.modifiers.contains(KeyModifiers::CONTROL)) {
                    if matches!(&ev, Event::Key(key) if key.kind == KeyEventKind::Press) {
                        replay.debug.visible = !replay.debug.visible;
                        if replay.debug.visible {
                            replay.debug.accounted_bytes = None;
                            let id = cdp_send(&mut ws, &mut next_id, "Kitesurf.getMemoryStats",
                                serde_json::json!({}), None).await?;
                            pending_memory = Some((id, Instant::now()));
                        }
                        if mode == Mode::Kitty {
                            let size = display_size.as_ref().expect("display mode has terminal size");
                            (w, h) = size.pixels(replay.debug.visible);
                            replay.painted_seq = None;
                            replay.pending = None;
                            replay.resize_sync.sent();
                        }
                        if replay.debug.visible { replay.debug.paint(replay.wire_bytes, replay.frames, w, h)?; }
                        else { replay.debug.clear()?; }
                        if mode == Mode::Kitty {
                            cdp_resize(&mut ws, &mut next_id, &session, w, h, stream_options, &mut queued).await?;
                        }
                    }
                    continue;
                }
                if matches!(&ev, Event::Mouse(mouse) if replay.debug.visible &&
                    display_size.as_ref().is_some_and(|size| {
                        mouse.row >= size.rows.saturating_sub(DEBUG_BAR_ROWS)
                    })
                ) {
                    continue;
                }
                if let Event::Resize(cols, rows) = ev {
                    let (cols, rows) = terminal::size().unwrap_or((cols, rows));
                    let size = display_size.as_mut().expect("display mode has terminal size");
                    let grid_changed = (cols, rows) != (size.cols, size.rows);
                    let next = resize_view(size, cols, rows, replay.debug.visible, mode, cell);
                    if grid_changed || next != (w, h) {
                        (w, h) = next;
                        replay.painted_seq = None;
                        replay.pending = None;
                        replay.resize_sync.sent();
                        cdp_resize(&mut ws, &mut next_id, &session, w, h, stream_options, &mut queued).await?;
                    }
                } else {
                    let grid = if matches!(&ev, Event::Mouse(_)) {
                        terminal::size().ok()
                    } else {
                        None
                    };
                    if let Some((method, params)) = input_event(
                        ev,
                        w,
                        h,
                        grid,
                        (mode == Mode::Ansi).then(|| {
                            display_size
                                .as_ref()
                                .expect("display mode has terminal size")
                                .rows
                                .saturating_sub(DEBUG_BAR_ROWS)
                        }),
                        &mut mouse_down,
                    ) {
                        cdp_send(&mut ws, &mut next_id, method, params, Some(&session)).await?;
                    }
                }
            }
            msg = async {
                if let Some(message) = queued.pop_front() { Some(Ok(message)) }
                else { ws.next().await }
            } => {
                let Some(msg) = msg else {
                    diagnostics.log("CDP WebSocket disconnected");
                    return Err(CONNECTION_LOST.into());
                };
                let msg = msg?;
                if matches!(msg, Message::Close(_)) {
                    diagnostics.log("CDP WebSocket closed");
                    return Err(CONNECTION_LOST.into());
                }
                let Message::Text(text) = msg else { continue; };
                replay.wire_bytes += text.len() as u64;
                let event: serde_json::Value = serde_json::from_str(&text)?;
                acknowledge_probe(&event, &mut pending_probe)?;
                if pending_memory.is_some_and(|(id, _)| event["id"].as_u64() == Some(id)) {
                    pending_memory = None;
                    replay.debug.accounted_bytes = event["result"]["total"]["bytes"].as_u64();
                    replay.debug.paint(replay.wire_bytes, replay.frames, w, h)?;
                }
                if event["method"] != "Kitesurf.sceneFrame" {
                    if let Some(batch) = event["result"]["batchB64"].as_str() {
                        let resources = base64::engine::general_purpose::STANDARD.decode(batch)?;
                        raster.run(OP_PUT_RESOURCES, &resources)?;
                        retire_unavailable_images(&mut raster)?;
                        fonts(&font_cache, &mut raster, &mut diagnostics).await?;
                        if let Some(frame) = replay.pending.take() {
                            replay.paint(
                                &mut raster,
                                &frame,
                                w,
                                h,
                                display,
                                display_size.as_ref().unwrap_or(&fallback_size),
                            )?;
                        }
                    }
                    continue;
                }
                let Some(data) = event["params"]["data"].as_str() else { continue; };
                let bytes = base64::engine::general_purpose::STANDARD.decode(data)?;
                if bytes.len() < FRAME_HEADER_BYTES { continue; }
                if scene_heartbeat { last_scene_activity = Some(Instant::now()); }
                if let Some(size) = display_size.as_mut() {
                    if let Ok((cols, rows)) = terminal::size() {
                        if (cols, rows) != (size.cols, size.rows) {
                            (w, h) = resize_view(size, cols, rows, replay.debug.visible, mode, cell);
                            replay.painted_seq = None;
                            replay.pending = None;
                            replay.resize_sync.sent();
                            diagnostics.log(format!("terminal resized; requesting {w}x{h} scene stream"));
                            cdp_resize(&mut ws, &mut next_id, &session, w, h, stream_options, &mut queued).await?;
                        }
                    }
                }
                match bytes[0] {
                    INFO_MESSAGE => {
                        if serde_json::from_slice::<serde_json::Value>(
                            &bytes[FRAME_HEADER_BYTES..],
                        )?
                            .get("t").and_then(|value| value.as_str()) == Some("sceneReset") {
                            replay.painted_seq = None;
                            replay.pending = None;
                            diagnostics.log("scene stream reset after navigation");
                            last_scene_activity = None;
                        }
                    }
                    RESOURCE_MESSAGE => {
                        raster.run(OP_PUT_RESOURCES, &bytes[FRAME_HEADER_BYTES..])?;
                        retire_unavailable_images(&mut raster)?;
                        fonts(&font_cache, &mut raster, &mut diagnostics).await?;
                        if let Some(frame) = replay.pending.take() {
                            replay.paint(
                                &mut raster,
                                &frame,
                                w,
                                h,
                                display,
                                display_size.as_ref().unwrap_or(&fallback_size),
                            )?;
                        }
                    }
                    SCENE_MESSAGE | PARTIAL_MESSAGE => {
                        let frame = parse_frame(&bytes)?;
                        let seq = frame.seq;
                        scenes += 1;
                        if scenes == 1 {
                            diagnostics.log(format!("received first scene ({}x{}, seq {seq})", frame.width, frame.height));
                        }
                        let mut ok = false;
                        if scene_version(&frame.scene) != Some(manifest.wire_version) {
                            return Err(
                                "Scene wire version does not match the rasterizer supplied by the connected engine."
                                    .into(),
                            );
                        }
                        match replay.paint(
                            &mut raster,
                            &frame,
                            w,
                            h,
                            display,
                            display_size.as_ref().unwrap_or(&fallback_size),
                        )? {
                            ReplayResult::Painted => ok = true,
                            ReplayResult::MissingResources(missing) => {
                                replay.pending = Some(frame);
                                cdp_send(&mut ws, &mut next_id, "Kitesurf.getSceneResources", serde_json::json!({
                                    "missingB64": base64::engine::general_purpose::STANDARD.encode(missing),
                                }), Some(&session)).await?;
                            }
                            ReplayResult::Skipped => {}
                        }
                        cdp_ack(&mut ws, &mut next_id, &session, seq, ok).await?;
                    }
                    _ => {}
                }
            }
            _ = resize_tick.tick(), if display => {
                if let (Some(size), Ok((cols, rows))) = (display_size.as_mut(), terminal::size()) {
                    if (cols, rows) != (size.cols, size.rows) {
                        (w, h) = resize_view(size, cols, rows, replay.debug.visible, mode, cell);
                        replay.painted_seq = None;
                        replay.pending = None;
                        replay.resize_sync.sent();
                        cdp_resize(&mut ws, &mut next_id, &session, w, h, stream_options, &mut queued).await?;
                    } else if replay.resize_sync.retry_due() {
                        replay.resize_sync.sent();
                        cdp_resize(&mut ws, &mut next_id, &session, w, h, stream_options, &mut queued).await?;
                    }
                }
                replay.debug.paint(replay.wire_bytes, replay.frames, w, h)?;
            }
            _ = heartbeat_tick.tick() => {
                if pending_probe.is_none() &&
                    !last_scene_activity.is_some_and(|at| at.elapsed() < HEARTBEAT_INTERVAL) {
                    let id = cdp_send(&mut ws, &mut next_id, "Browser.getVersion",
                        serde_json::json!({}), None).await?;
                    pending_probe = Some((id, Instant::now()));
                }
            }
            _ = memory_tick.tick(), if replay.debug.visible => {
                if pending_memory.is_some_and(|(_, sent)| sent.elapsed() >= CDP_REPLY_TIMEOUT) {
                    pending_memory = None;
                    replay.debug.accounted_bytes = None;
                    replay.debug.paint(replay.wire_bytes, replay.frames, w, h)?;
                }
                if pending_memory.is_none() {
                    let id = cdp_send(&mut ws, &mut next_id, "Kitesurf.getMemoryStats",
                        serde_json::json!({}), None).await?;
                    pending_memory = Some((id, Instant::now()));
                }
            }
            _ = async {
                if let Some((_, sent)) = pending_probe {
                    tokio::time::sleep_until((sent + CDP_REPLY_TIMEOUT).into()).await;
                }
            }, if pending_probe.is_some() => return Err(SERVER_UNRESPONSIVE.into()),
            _ = async {
                if let Some(at) = scene_stall_at {
                    tokio::time::sleep_until(at).await;
                }
            }, if scene_stall_at.is_some() => return Err(SCENE_STREAM_STALLED.into()),
            _ = tokio::time::sleep(DEADLINE_POLL_INTERVAL), if deadline.is_some() => {}
        }
    }
    drop(_terminal);
    diagnostics.flush();
    eprintln!("scenes={scenes} displayed={} elapsed={:.2}s fps={:.1} scene_wire={}KB kitty_est={}KB raster={:.1}ms/frame",
        replay.frames, start.elapsed().as_secs_f64(),
        replay.frames as f64 / start.elapsed().as_secs_f64(),
        replay.wire_bytes / 1024, replay.terminal_bytes / 1024,
        replay.raster_time.as_secs_f64() * 1000.0 / replay.frames.max(1) as f64);
    Ok(())
}

fn render(
    raster: &mut Raster,
    frame: &Frame,
    w: u16,
    h: u16,
    raw_rgba: bool,
    retain: bool,
) -> Result<Vec<u8>> {
    let mut input = Vec::with_capacity(frame.scene.len() + 20);
    let operation = if retain {
        input.extend_from_slice(&frame.seq.to_le_bytes());
        if frame.partial {
            input.extend_from_slice(&frame.base.to_le_bytes());
            input.extend_from_slice(&frame.x.to_le_bytes());
            input.extend_from_slice(&frame.y.to_le_bytes());
        }
        input.extend_from_slice(&u32::from(raw_rgba).to_le_bytes());
        if frame.partial {
            OP_COMPOSITE_FRAME
        } else {
            OP_RETAIN_FRAME
        }
    } else if raw_rgba {
        OP_RENDER_RGBA
    } else {
        OP_RENDER_PNG
    };
    input.extend_from_slice(&frame.scene);
    let output = raster.run(operation, &input)?;
    if output.is_empty() {
        if retain && frame.partial {
            return Ok(output);
        }
        return Err(String::from_utf8_lossy(&raster.run(OP_LAST_ERROR, &[])?)
            .into_owned()
            .into());
    }
    if !raw_rgba && !output.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("scene replay returned a non-PNG frame".into());
    }
    let dimensions = if raw_rgba {
        output.get(..8)
    } else {
        output.get(16..24)
    };
    let decode: fn([u8; 4]) -> u32 = if raw_rgba {
        u32::from_le_bytes
    } else {
        u32::from_be_bytes
    };
    let dimensions = dimensions.and_then(|bytes| {
        let (width, rest) = bytes.split_first_chunk::<4>()?;
        let height = rest.first_chunk::<4>()?;
        Some((decode(*width), decode(*height)))
    });
    if dimensions != Some((u32::from(w), u32::from(h))) {
        return Err("scene replay returned an unexpected viewport".into());
    }
    Ok(output)
}

fn render_ansi(
    raster: &mut Raster,
    frame: &Frame,
    size: &DisplaySize,
    cell: AnsiCell,
) -> Result<Vec<u8>> {
    if frame.partial {
        return Err("ANSI requires a full scene".into());
    }
    let mut input = Vec::with_capacity(frame.scene.len() + 16);
    for dimension in [
        u32::from(size.cols),
        u32::from(size.rows.saturating_sub(DEBUG_BAR_ROWS).max(1)),
    ] {
        input.extend_from_slice(&dimension.to_le_bytes());
    }
    for cell_pixels in [f32::from(cell.w), f32::from(cell.h)] {
        input.extend_from_slice(&cell_pixels.to_le_bytes());
    }
    input.extend_from_slice(&frame.scene);
    let output = raster.run(OP_RENDER_ANSI, &input)?;
    if output.is_empty() {
        return Err("scene did not decode as ANSI".into());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::connect_async;

    #[test]
    fn liveness_probe_only_accepts_its_own_successful_reply() {
        let mut pending = Some((7, Instant::now()));
        acknowledge_probe(
            &serde_json::json!({"method": "Kitesurf.sceneFrame"}),
            &mut pending,
        )
        .unwrap();
        acknowledge_probe(&serde_json::json!({"id": 6, "result": {}}), &mut pending).unwrap();
        assert!(pending.is_some());
        assert!(acknowledge_probe(
            &serde_json::json!({"id": 7, "error": {"message": "failed"}}),
            &mut pending
        )
        .is_err());
        assert!(pending.is_some());
        acknowledge_probe(&serde_json::json!({"id": 7, "result": {}}), &mut pending).unwrap();
        assert!(pending.is_none());
    }

    #[test]
    fn scene_stall_requires_heartbeat_support_and_recent_stream_activity() {
        let stalled = Instant::now() - Duration::from_secs(6);
        assert!(scene_stall_deadline(Some(stalled), true).unwrap() <= tokio::time::Instant::now());
        assert!(
            scene_stall_deadline(Some(Instant::now()), true).unwrap() > tokio::time::Instant::now()
        );
        assert!(scene_stall_deadline(Some(stalled), false).is_none());
        assert!(scene_stall_deadline(None, true).is_none());
    }

    const CDP_MESSAGE_TIMEOUT: Duration = Duration::from_secs(5);
    const EXPIRED_PAINT_AGE: Duration = Duration::from_secs(2);

    fn full_frame(seq: u32, width: u16, height: u16) -> Frame {
        let mut scene = vec![0; 16];
        scene[8..12].copy_from_slice(&u32::from(width).to_le_bytes());
        scene[12..16].copy_from_slice(&u32::from(height).to_le_bytes());
        Frame {
            scene,
            seq,
            partial: false,
            width,
            height,
            x: 0,
            y: 0,
            base: -1,
        }
    }

    #[test]
    fn hidden_stats_discard_expired_paint_timestamps() {
        let mut debug = DebugBar::default();
        debug
            .painted_at
            .push_back(Instant::now() - EXPIRED_PAINT_AGE);
        assert_eq!(debug.fps(), 0);
        debug
            .painted_at
            .push_back(Instant::now() - EXPIRED_PAINT_AGE);
        assert!(!debug.visible);
        assert_eq!(debug.painted_at.len(), 1);

        debug.painted();

        assert_eq!(debug.painted_at.len(), 1);
        assert_eq!(debug.fps(), 1);
    }

    #[test]
    fn high_unsigned_scene_sequence_is_not_rejected() {
        let frame = full_frame(0x8000_0000, 320, 240);

        assert!(can_paint(&frame, None, 320, 240));
    }

    #[test]
    fn full_scene_older_than_high_painted_sequence_is_rejected() {
        let frame = full_frame(0x7fff_ffff, 320, 240);

        assert!(!can_paint(&frame, Some(0x8000_0000), 320, 240));
    }

    #[test]
    fn partial_scene_matches_high_sequence_wire_base() {
        let mut frame = full_frame(0x8000_0001, 20, 10);
        frame.partial = true;
        frame.base = i32::MIN;
        assert!(can_paint(&frame, Some(0x8000_0000), 320, 240));

        frame.base += 1;
        assert!(!can_paint(&frame, Some(0x8000_0000), 320, 240));
    }

    #[test]
    fn partial_scene_cannot_establish_a_base() {
        let mut frame = full_frame(0, 20, 10);
        frame.partial = true;
        frame.base = -1;
        assert!(!can_paint(&frame, None, 320, 240));
        frame.base = 0;
        assert!(!can_paint(&frame, None, 320, 240));
    }

    #[test]
    fn retained_replay_reports_corrupt_full_scenes() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../engine/public/rbi/scene_host.wasm"
        ))
        .unwrap();
        let mut raster = Raster::new(&bytes).unwrap();
        let size = DisplaySize {
            cols: 100,
            rows: 35,
            cell_w: 8.0,
            cell_h: 17.0,
        };
        let mut frame = full_frame(1, 320, 240);
        frame.scene = wasm::test_scene(320, 240, [0, 0, 255, 255]);
        frame.scene.truncate(frame.scene.len() - 3);
        for retained_frames in [false, true] {
            for raw_files in [false, true] {
                let mut images = KittyImages::default();
                images.raw_files = raw_files;
                let mut replay = ReplayState::new(Mode::Kitty, AnsiCell { w: 8, h: 17 }, images);
                replay.retained_frames = retained_frames;
                let error = replay
                    .paint(&mut raster, &frame, 320, 240, false, &size)
                    .err()
                    .expect(
                        "a corrupt full scene must fail instead of requesting another full scene",
                    );
                assert!(error.to_string().contains("scene truncated"), "{error}");
            }
        }
    }

    #[test]
    fn partial_replay_composites_without_a_display_and_recovers_a_lost_base() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../engine/public/rbi/scene_host.wasm"
        ))
        .unwrap();
        let mut raster = Raster::new(&bytes).unwrap();
        let mut replay = ReplayState::new(
            Mode::Kitty,
            AnsiCell { w: 8, h: 17 },
            KittyImages::default(),
        );
        replay.retained_frames = true;
        let size = DisplaySize {
            cols: 100,
            rows: 35,
            cell_w: 8.0,
            cell_h: 17.0,
        };
        let mut base = full_frame(1, 320, 240);
        base.scene = wasm::test_scene(320, 240, [0, 0, 255, 255]);
        assert!(matches!(
            replay
                .paint(&mut raster, &base, 320, 240, false, &size)
                .unwrap(),
            ReplayResult::Painted
        ));
        let mut patch = full_frame(2, 20, 10);
        patch.partial = true;
        patch.base = 1;
        patch.x = 30;
        patch.y = 40;
        patch.scene = wasm::test_scene(20, 10, [255, 0, 0, 255]);
        assert!(matches!(
            replay
                .paint(&mut raster, &patch, 320, 240, false, &size)
                .unwrap(),
            ReplayResult::Painted
        ));
        assert_eq!(replay.painted_seq, Some(2));

        // Simulate a rasterizer with no matching retained pixels despite the CLI's seq.
        render(&mut raster, &base, 320, 240, true, true).unwrap();
        patch.seq = 3;
        patch.base = 2;
        assert!(matches!(
            replay
                .paint(&mut raster, &patch, 320, 240, false, &size)
                .unwrap(),
            ReplayResult::Skipped
        ));
        assert_eq!(replay.painted_seq, None);
        assert!(matches!(
            replay
                .paint(&mut raster, &patch, 320, 240, false, &size)
                .unwrap(),
            ReplayResult::Skipped
        ));
        base.seq = 4;
        assert!(matches!(
            replay
                .paint(&mut raster, &base, 320, 240, false, &size)
                .unwrap(),
            ReplayResult::Painted
        ));
        patch.seq = 5;
        patch.base = 4;
        assert!(matches!(
            replay
                .paint(&mut raster, &patch, 320, 240, false, &size)
                .unwrap(),
            ReplayResult::Painted
        ));

        patch.seq = 6;
        patch.base = 5;
        patch.scene.truncate(patch.scene.len() - 3);
        assert!(matches!(
            replay
                .paint(&mut raster, &patch, 320, 240, false, &size)
                .unwrap(),
            ReplayResult::Skipped
        ));
        assert_eq!(replay.painted_seq, None);
        base.seq = 7;
        assert!(matches!(
            replay
                .paint(&mut raster, &base, 320, 240, false, &size)
                .unwrap(),
            ReplayResult::Painted
        ));
        patch.seq = 8;
        patch.base = 7;
        patch.scene = wasm::test_scene(20, 10, [255, 0, 0, 255]);
        assert!(matches!(
            replay
                .paint(&mut raster, &patch, 320, 240, false, &size)
                .unwrap(),
            ReplayResult::Painted
        ));
    }

    #[test]
    fn partial_replay_preserves_full_rgba_dimensions_and_terminal_placement() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../engine/public/rbi/scene_host.wasm"
        ))
        .unwrap();
        let mut raster = Raster::new(&bytes).unwrap();
        let mut base = full_frame(1, 320, 240);
        base.scene = wasm::test_scene(320, 240, [0, 0, 255, 255]);
        let mut images = KittyImages::default();
        let mut out = Vec::new();
        let full = render(&mut raster, &base, 320, 240, true, true).unwrap();
        kitty_to(&mut out, &full, 80, None, &mut images, true).unwrap();
        out.clear();
        let mut patch = full_frame(2, 20, 10);
        patch.partial = true;
        patch.base = 1;
        patch.x = 30;
        patch.y = 40;
        patch.scene = wasm::test_scene(20, 10, [255, 0, 0, 255]);
        let composite = render(&mut raster, &patch, 320, 240, true, true).unwrap();
        assert_eq!(composite.len(), 8 + 320 * 240 * 4);
        assert_eq!(
            &composite[8 + (45 * 320 + 35) * 4..8 + (45 * 320 + 36) * 4],
            [255, 0, 0, 255]
        );
        assert_eq!(&composite[8..12], [0, 0, 255, 255]);
        kitty_to(&mut out, &composite, 80, None, &mut images, true).unwrap();
        assert!(out.starts_with(b"\x1b[1;1H\x1b_Ga=T,f=32,s=320,v=240,i=2,"));
        assert!(out.ends_with(b"\x1b_Ga=d,d=I,i=1,q=1;\x1b\\"));
        assert!(!out.windows(4).any(|bytes| bytes == b"a=f,"));
    }

    #[test]
    fn retained_frame_capability_is_optional_for_older_manifests() {
        let mut value = serde_json::json!({ "abi": 4, "wireVersion": 13,
            "wasm": "scene_host.wasm", "sha256": "unused", "bytes": 1 });
        assert!(
            !serde_json::from_value::<Manifest>(value.clone())
                .unwrap()
                .retained_frames
        );
        value["retainedFrames"] = true.into();
        assert!(
            serde_json::from_value::<Manifest>(value)
                .unwrap()
                .retained_frames
        );
    }

    #[test]
    fn rbi_keys_preserve_modifiers_without_typing_control_shortcuts() {
        let (method, ctrl_d) = key_message(event::KeyEvent::new(
            KeyCode::Char('d'),
            KeyModifiers::CONTROL,
        ))
        .unwrap();
        assert_eq!(method, "Input.dispatchKeyEvent");
        assert_eq!(ctrl_d["type"], "rawKeyDown");
        assert_eq!(ctrl_d["modifiers"], 2);
        assert_eq!(ctrl_d["text"], "");

        let (method, shift_tab) =
            key_message(event::KeyEvent::new(KeyCode::Tab, KeyModifiers::SHIFT)).unwrap();
        assert_eq!(method, "Input.dispatchKeyEvent");
        assert_eq!(shift_tab["type"], "rawKeyDown");
        assert_eq!(shift_tab["modifiers"], 8);

        let (method, alt_meta) = key_message(event::KeyEvent::new(
            KeyCode::Char('x'),
            KeyModifiers::ALT | KeyModifiers::SUPER,
        ))
        .unwrap();
        assert_eq!(method, "Input.dispatchKeyEvent");
        assert_eq!(alt_meta["modifiers"], 5);
        assert_eq!(alt_meta["text"], "");

        let (method, plain) =
            key_message(event::KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE)).unwrap();
        assert_eq!(method, "Input.dispatchKeyEvent");
        assert_eq!(plain["type"], "rawKeyDown");
        assert_eq!(plain["text"], "j");
        assert_eq!(plain["modifiers"], 0);
        assert_eq!(plain["windowsVirtualKeyCode"], 74);
    }

    #[test]
    fn rbi_shift_tab_reaches_the_page() {
        let (method, message) =
            key_message(event::KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT))
                .expect("Shift-Tab must produce a CDP key event");
        assert_eq!(method, "Input.dispatchKeyEvent");
        assert_eq!(message["key"], "Tab");
        assert_eq!(message["code"], "Tab");
        assert_eq!(message["windowsVirtualKeyCode"], 9);
        assert_eq!(message["modifiers"], 8);
        assert_eq!(message["type"], "rawKeyDown");
    }

    #[test]
    fn rbi_key_release_clears_the_held_key() {
        use crossterm::Command as _;

        let mut enable = String::new();
        event::PushKeyboardEnhancementFlags(keyboard_flags())
            .write_ansi(&mut enable)
            .unwrap();
        assert_eq!(enable, "\x1b[>11u");
        let mut restore = String::new();
        event::PopKeyboardEnhancementFlags
            .write_ansi(&mut restore)
            .unwrap();
        assert_eq!(restore, "\x1b[<1u");

        let press =
            event::KeyEvent::new_with_kind(KeyCode::Up, KeyModifiers::NONE, KeyEventKind::Press);
        let release =
            event::KeyEvent::new_with_kind(KeyCode::Up, KeyModifiers::NONE, KeyEventKind::Release);
        let (press_method, press) = key_message(press).unwrap();
        let (release_method, release) = key_message(release).unwrap();
        let repeat =
            event::KeyEvent::new_with_kind(KeyCode::Up, KeyModifiers::NONE, KeyEventKind::Repeat);
        let (repeat_method, repeat) = key_message(repeat).unwrap();
        assert_eq!(press_method, "Input.dispatchKeyEvent");
        assert_eq!(release_method, "Input.dispatchKeyEvent");
        assert_eq!(repeat_method, "Input.dispatchKeyEvent");
        assert_eq!(press["type"], "rawKeyDown");
        assert_eq!(repeat["type"], "rawKeyDown");
        assert_eq!(release["type"], "keyUp");
        assert_eq!(release["code"], press["code"]);
    }

    #[tokio::test]
    async fn rbi_key_event_is_sent_as_a_cdp_command() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let message = tokio::time::timeout(CDP_MESSAGE_TIMEOUT, socket.next())
                .await
                .expect("CDP input should arrive")
                .unwrap()
                .unwrap();
            match message {
                Message::Text(text) => text.to_string(),
                message => panic!("expected CDP text, got {message:?}"),
            }
        });
        let (mut socket, _) = connect_async(format!("ws://{address}/devtools/browser"))
            .await
            .unwrap();
        let mut mouse_down = false;
        let (method, params) = input_event(
            Event::Key(event::KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE)),
            0,
            0,
            None,
            None,
            &mut mouse_down,
        )
        .unwrap();
        let mut id = 0;
        cdp_send(&mut socket, &mut id, method, params, Some("page"))
            .await
            .unwrap();
        drop(socket);

        let message: serde_json::Value = serde_json::from_str(&server.await.unwrap()).unwrap();
        assert_eq!(
            message,
            serde_json::json!({
                "id": 1,
                "method": "Input.dispatchKeyEvent",
                "params": {
                    "type": "rawKeyDown",
                    "key": "j",
                    "code": "KeyJ",
                    "windowsVirtualKeyCode": 74,
                    "text": "j",
                    "modifiers": 0,
                },
                "sessionId": "page",
            })
        );
    }

    #[test]
    fn rbi_mouse_input_preserves_held_buttons_and_wheel_deltas() {
        let mouse_event = |kind, column, row| {
            Event::Mouse(event::MouseEvent {
                kind,
                column,
                row,
                modifiers: KeyModifiers::NONE,
            })
        };
        let mut mouse_down = false;
        let (method, pressed) = input_event(
            mouse_event(MouseEventKind::Down(event::MouseButton::Left), 10, 5),
            1000,
            500,
            Some((100, 50)),
            None,
            &mut mouse_down,
        )
        .unwrap();
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(
            pressed,
            serde_json::json!({
                "type": "mousePressed", "x": 100, "y": 50,
                "button": "left", "buttons": 1, "clickCount": 1,
            })
        );

        let (method, moved) = input_event(
            mouse_event(MouseEventKind::Drag(event::MouseButton::Left), 11, 6),
            1000,
            500,
            Some((100, 50)),
            None,
            &mut mouse_down,
        )
        .unwrap();
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(
            moved,
            serde_json::json!({
                "type": "mouseMoved", "x": 110, "y": 60,
                "button": "left", "buttons": 1, "clickCount": 1,
            })
        );

        let (method, released) = input_event(
            mouse_event(MouseEventKind::Up(event::MouseButton::Left), 11, 6),
            1000,
            500,
            Some((100, 50)),
            None,
            &mut mouse_down,
        )
        .unwrap();
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(
            released,
            serde_json::json!({
                "type": "mouseReleased", "x": 110, "y": 60,
                "button": "left", "buttons": 0, "clickCount": 1,
            })
        );

        let (method, after_release) = input_event(
            mouse_event(MouseEventKind::Moved, 11, 6),
            1000,
            500,
            Some((100, 50)),
            None,
            &mut mouse_down,
        )
        .unwrap();
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(
            after_release,
            serde_json::json!({
                "type": "mouseMoved", "x": 110, "y": 60,
                "button": "none", "buttons": 0, "clickCount": 1,
            })
        );

        let (method, wheel_down) = input_event(
            mouse_event(MouseEventKind::ScrollDown, 10, 5),
            1000,
            500,
            Some((100, 50)),
            None,
            &mut mouse_down,
        )
        .unwrap();
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(
            wheel_down,
            serde_json::json!({
                "type": "mouseWheel", "x": 100, "y": 50,
                "deltaX": 0, "deltaY": 80,
            })
        );

        let (method, wheel_up) = input_event(
            mouse_event(MouseEventKind::ScrollUp, 10, 5),
            1000,
            500,
            Some((100, 50)),
            None,
            &mut mouse_down,
        )
        .unwrap();
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(
            wheel_up,
            serde_json::json!({
                "type": "mouseWheel", "x": 100, "y": 50,
                "deltaX": 0, "deltaY": -80,
            })
        );

        assert!(input_event(
            mouse_event(MouseEventKind::Moved, 10, 49),
            1000,
            500,
            Some((100, 50)),
            Some(49),
            &mut mouse_down,
        )
        .is_none());
    }

    #[test]
    fn kitty_placement_keeps_png_aspect_ratio() {
        let mut output = Vec::new();
        kitty_to(
            &mut output,
            b"png",
            120,
            None,
            &mut KittyImages::default(),
            false,
        )
        .unwrap();
        assert_eq!(
            output,
            b"\x1b[1;1H\x1b_Ga=T,f=100,i=1,q=1,C=1,c=120,m=0;cG5n\x1b\\"
        );
    }

    #[test]
    fn debug_bar_reserves_one_row_and_reports_the_scene_wire() {
        let size = DisplaySize {
            cell_w: 10.0,
            cell_h: 20.0,
            cols: 80,
            rows: 30,
        };
        assert_eq!(size.pixels(false), (800, 600));
        assert_eq!(size.pixels(true), (800, 580));
        let mut output = Vec::new();
        kitty_to(
            &mut output,
            b"png",
            80,
            Some(29),
            &mut KittyImages::default(),
            false,
        )
        .unwrap();
        assert!(output.starts_with(b"\x1b[1;1H\x1b_Ga=T,f=100,i=1,q=1,C=1,c=80,r=29,m=0;"));
        let line = DebugBar::default().line(2 * 1024 * 1024, 12, 800, 580);
        assert!(line.contains("wire 2.0 MiB | acct -- | mode kitty | frames 12 | 800x580"));
        let mut debug = DebugBar {
            accounted_bytes: Some(48 * 1024 * 1024),
            ..DebugBar::default()
        };
        let line = debug.line(2 * 1024 * 1024, 12_345, 800, 580);
        assert!(line.contains("acct 48.0MiB | mode kitty"));
        assert!(line.len() <= 80);
    }

    #[test]
    fn hidpi_uses_remote_zoom_with_or_without_debug_bar() {
        let size = DisplaySize {
            cell_w: 16.0,
            cell_h: 34.0,
            cols: 80,
            rows: 20,
        };
        assert_eq!(size.pixels(false), (640, 340));
        assert_eq!(size.pixels(true), (640, 323));
        let cell = AnsiCell::new(&size);
        assert_eq!((cell.w, cell.h), (8, 17));
        assert_eq!(cell.viewport(&size), (640, 323));
        let mut debug = DebugBar {
            mode: Mode::Ansi,
            ..DebugBar::default()
        };
        assert!(debug.line(0, 1, 640, 323).contains("mode ansi"));
    }

    #[test]
    fn each_repaint_places_the_new_image_before_deleting_the_old_one() {
        let mut output = Vec::new();
        let mut images = KittyImages::default();
        kitty_to(&mut output, b"old", 120, None, &mut images, false).unwrap();
        kitty_to(&mut output, b"new", 80, None, &mut images, false).unwrap();
        kitty_to(&mut output, b"next", 80, None, &mut images, false).unwrap();
        assert_eq!(
            output,
            b"\x1b[1;1H\x1b_Ga=T,f=100,i=1,q=1,C=1,c=120,m=0;b2xk\x1b\\\
              \x1b[1;1H\x1b_Ga=T,f=100,i=2,q=1,C=1,c=80,m=0;bmV3\x1b\\\
              \x1b_Ga=d,d=I,i=1,q=1;\x1b\\\
              \x1b[1;1H\x1b_Ga=T,f=100,i=1,q=1,C=1,c=80,m=0;bmV4dA==\x1b\\\
              \x1b_Ga=d,d=I,i=2,q=1;\x1b\\"
        );
    }

    #[test]
    fn partial_scene_requires_matching_dimensions_and_visible_intersection() {
        let mut patch = full_frame(2, 20, 10);
        patch.partial = true;
        patch.base = 1;
        for (x, y) in [(-1, 0), (90, 0), (0, -2)] {
            patch.x = x;
            patch.y = y;
            assert!(can_paint(&patch, Some(1), 100, 80));
        }
        for (x, y) in [(100, 0), (0, 80), (i32::MIN, 0), (0, i32::MAX)] {
            patch.x = x;
            patch.y = y;
            assert!(!can_paint(&patch, Some(1), 100, 80));
        }
        patch.x = 0;
        patch.y = 0;
        patch.width += 1;
        assert!(!can_paint(&patch, Some(1), 100, 80));
    }

    #[test]
    fn chunked_full_image_suppresses_success_replies_on_continuations() {
        let mut out = Vec::new();
        let png = vec![42; 3073];
        kitty_to(&mut out, &png, 80, None, &mut KittyImages::default(), false).unwrap();
        assert!(out.starts_with(b"\x1b[1;1H\x1b_Ga=T,f=100,i=1,q=1,C=1,c=80,m=1;"));
        assert!(out
            .windows(b"\x1b_Gm=0,q=1;".len())
            .any(|chunk| chunk == b"\x1b_Gm=0,q=1;"));
    }

    #[test]
    fn local_kitty_file_transmits_a_path_instead_of_png_chunks() {
        let png = vec![42; 3073];
        let mut images = KittyImages::default();
        images.local_files = true;
        let mut out = Vec::new();
        kitty_to(&mut out, &png, 80, None, &mut images, false).unwrap();
        let prefix = b"\x1b[1;1H\x1b_Ga=T,f=100,i=1,q=1,C=1,c=80,t=t,m=0;";
        assert!(out.starts_with(prefix));
        let encoded = out[prefix.len()..].strip_suffix(b"\x1b\\").unwrap();
        let path = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap(),
        )
        .unwrap();
        assert!(path.contains("tty-graphics-protocol"));
        assert_eq!(std::fs::read(&path).unwrap(), png);
        assert_eq!(images.last_bytes, encoded.len() as u64);
        drop(images);
        assert!(!std::path::Path::new(&path).exists());
    }

    #[test]
    fn local_kitty_file_transmits_uncompressed_rgba() {
        let mut images = KittyImages::default();
        images.local_files = true;
        let mut rgba = Vec::from([2, 0, 0, 0, 1, 0, 0, 0]);
        rgba.extend_from_slice(&[255, 0, 0, 255, 0, 255, 0, 255]);
        let mut out = Vec::new();
        kitty_to(&mut out, &rgba, 80, None, &mut images, true).unwrap();
        let prefix = b"\x1b[1;1H\x1b_Ga=T,f=32,s=2,v=1,i=1,q=1,C=1,c=80,t=t,m=0;";
        assert!(out.starts_with(prefix));
        let path = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(out[prefix.len()..].strip_suffix(b"\x1b\\").unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), rgba[8..]);
    }

    #[test]
    fn viewport_uses_all_rows_and_preserves_aspect_ratio_under_the_cap() {
        assert_eq!(viewport_size(120, 40, 1200, 800), (1200, 800));
        assert_eq!(viewport_size(120, 40, 0, 0), (960, 680));
        assert_eq!(viewport_size(200, 60, 3840, 2160), (2560, 1440));
        assert_eq!(viewport_size(25, 40, 250, 800), (320, 1024));
        assert_eq!(viewport_size(20, 10, 160, 170), (320, 340));
    }

    #[test]
    fn resize_uses_new_grid_when_terminal_pixel_fields_are_stale() {
        let mut size = DisplaySize {
            cell_w: 10.0,
            cell_h: 20.0,
            cols: 120,
            rows: 40,
        };
        assert_eq!(size.resize(80, 30, false), (800, 600));
        assert_eq!(size.resize(100, 35, false), (1000, 700));
    }

    #[test]
    fn stale_full_scene_cannot_replace_a_resized_viewport() {
        let mut bytes = vec![3, 1, 0];
        bytes.extend_from_slice(&7u32.to_le_bytes());
        bytes.extend_from_slice(&800u16.to_le_bytes());
        bytes.extend_from_slice(&600u16.to_le_bytes());
        bytes.extend_from_slice(b"KSC0");
        bytes.extend_from_slice(&11u32.to_le_bytes());
        bytes.extend_from_slice(&800u32.to_le_bytes());
        bytes.extend_from_slice(&600u32.to_le_bytes());
        let old = parse_frame(&bytes).unwrap();
        assert!(!can_paint(&old, None, 1000, 700));

        bytes[7..9].copy_from_slice(&1000u16.to_le_bytes());
        bytes[9..11].copy_from_slice(&700u16.to_le_bytes());
        assert!(!can_paint(&parse_frame(&bytes).unwrap(), None, 1000, 700));
        bytes[19..23].copy_from_slice(&1000u32.to_le_bytes());
        bytes[23..27].copy_from_slice(&700u32.to_le_bytes());
        let resized = parse_frame(&bytes).unwrap();
        assert!(can_paint(&resized, None, 1000, 700));
        assert!(!can_paint(&old, Some(resized.seq), 1000, 700));
    }

    #[test]
    fn resize_retries_until_a_full_scene_is_painted() {
        let mut sync = ResizeSync::new();
        sync.sent();
        sync.sent_at = Instant::now() - Duration::from_secs(2);
        assert!(sync.retry_due());
        sync.sent();
        assert!(!sync.retry_due());

        let mut frame = Frame {
            scene: vec![],
            seq: 1,
            partial: true,
            width: 0,
            height: 0,
            x: 0,
            y: 0,
            base: -1,
        };
        sync.painted(&frame);
        assert!(sync.awaiting);
        frame.partial = false;
        sync.painted(&frame);
        assert!(!sync.retry_due());
    }
}
