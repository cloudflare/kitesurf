// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Converts Ratatui buffer rows to ANSI output while emitting style changes between cells.

use ratatui::buffer::Buffer;
use ratatui::style::{Color, Modifier, Style};
use unicode_width::UnicodeWidthStr;

pub fn row_to_ansi(buf: &Buffer, y: u16) -> String {
    let mut out = String::with_capacity(buf.area.width as usize * 2 + 64);
    let mut cur: Option<Style> = None;
    let mut owned = 0u16;
    for x in buf.area.left()..buf.area.right() {
        if owned > 0 {
            owned -= 1;
            continue;
        }
        let cell = &buf[(x, y)];
        if cell.symbol().is_empty() {
            continue;
        }
        owned = UnicodeWidthStr::width(cell.symbol()).saturating_sub(1) as u16;
        let style = cell.style();
        if cur != Some(style) {
            emit_delta(&mut out, cur.as_ref(), &style);
            cur = Some(style);
        }
        out.push_str(cell.symbol());
    }
    out.push_str("\x1b[0m");
    out
}

fn emit_delta(out: &mut String, from: Option<&Style>, to: &Style) {
    let (old_mods, old_fg, old_bg) = match from {
        Some(s) => (s.add_modifier, s.fg, s.bg),
        None => (Modifier::empty(), None, None),
    };
    let gone = old_mods - to.add_modifier;
    if !gone.is_empty() {
        if gone.intersects(Modifier::BOLD | Modifier::DIM) {
            // SGR 22 clears both bold and dim; reapply whichever target modifier remains.
            out.push_str("\x1b[22m");
        }
        for (m, code) in [
            (Modifier::ITALIC, "23"),
            (Modifier::UNDERLINED, "24"),
            (Modifier::REVERSED, "27"),
            (Modifier::CROSSED_OUT, "29"),
        ] {
            if gone.contains(m) {
                out.push_str(&format!("\x1b[{code}m"));
            }
        }
    }
    let added = if gone.intersects(Modifier::BOLD | Modifier::DIM) {
        to.add_modifier
    } else {
        to.add_modifier - old_mods
    };
    for (m, code) in [
        (Modifier::BOLD, "1"),
        (Modifier::DIM, "2"),
        (Modifier::ITALIC, "3"),
        (Modifier::UNDERLINED, "4"),
        (Modifier::REVERSED, "7"),
        (Modifier::CROSSED_OUT, "9"),
    ] {
        if added.contains(m) {
            out.push_str(&format!("\x1b[{code}m"));
        }
    }
    if from.is_none() || old_fg != to.fg {
        out.push_str(&sgr_colour(to.fg.unwrap_or(Color::Reset), false));
    }
    if from.is_none() || old_bg != to.bg {
        out.push_str(&sgr_colour(to.bg.unwrap_or(Color::Reset), true));
    }
}

fn sgr_colour(c: Color, bg: bool) -> String {
    let base = if bg { 40 } else { 30 };
    let bright = if bg { 100 } else { 90 };
    let n = match c {
        Color::Reset => return format!("\x1b[{}m", if bg { 49 } else { 39 }),
        Color::Black => base,
        Color::Red => base + 1,
        Color::Green => base + 2,
        Color::Yellow => base + 3,
        Color::Blue => base + 4,
        Color::Magenta => base + 5,
        Color::Cyan => base + 6,
        Color::Gray => base + 7,
        Color::DarkGray => bright,
        Color::LightRed => bright + 1,
        Color::LightGreen => bright + 2,
        Color::LightYellow => bright + 3,
        Color::LightBlue => bright + 4,
        Color::LightMagenta => bright + 5,
        Color::LightCyan => bright + 6,
        Color::White => bright + 7,
        Color::Indexed(i) => return format!("\x1b[{};5;{i}m", base + 8),
        Color::Rgb(r, g, b) => return format!("\x1b[{};2;{r};{g};{b}m", base + 8),
    };
    format!("\x1b[{n}m")
}
