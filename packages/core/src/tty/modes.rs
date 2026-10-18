// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Defines terminal display modes, image handling, and the mode picker.

use wasm_bindgen::prelude::*;

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Widget},
};

use crate::tty::ansi::row_to_ansi;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum ImageMode {
    #[default]
    Halfblocks,
    Kitty,
}

impl ImageMode {
    pub fn from_slug(s: &str) -> Option<ImageMode> {
        match s {
            "halfblocks" => Some(ImageMode::Halfblocks),
            "kitty" => Some(ImageMode::Kitty),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TermMode {
    Ansi,
    Kitty,
}

impl TermMode {
    pub const ALL: [TermMode; 2] = [TermMode::Ansi, TermMode::Kitty];

    pub fn slug(self) -> &'static str {
        match self {
            TermMode::Ansi => "ansi",
            TermMode::Kitty => "kitty",
        }
    }

    pub fn from_slug(s: &str) -> Option<TermMode> {
        match s {
            "ansi" => Some(TermMode::Ansi),
            "kitty" => Some(TermMode::Kitty),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            TermMode::Ansi => "ansi — terminal text",
            TermMode::Kitty => "kitty — full viewport",
        }
    }

    pub fn hint(self) -> &'static str {
        match self {
            TermMode::Ansi => "selectable text, any terminal",
            TermMode::Kitty => "pixel-exact, nothing selectable",
        }
    }
}

pub struct PickOutcome {
    pub handled: bool,
    pub redraw: bool,
    pub chosen: Option<TermMode>,
}

impl PickOutcome {
    fn ignored() -> Self {
        PickOutcome {
            handled: false,
            redraw: false,
            chosen: None,
        }
    }
    fn ate(redraw: bool) -> Self {
        PickOutcome {
            handled: true,
            redraw,
            chosen: None,
        }
    }
}

pub struct ModePicker {
    open: bool,
    sel: usize,
    current: TermMode,
}

const INNER_W: u16 = 52;
const BOX_H: u16 = TermMode::ALL.len() as u16 + 2;

impl ModePicker {
    pub fn new(current: TermMode) -> Self {
        ModePicker {
            open: false,
            sel: Self::index_of(current),
            current,
        }
    }

    fn index_of(m: TermMode) -> usize {
        TermMode::ALL.iter().position(|x| *x == m).unwrap_or(0)
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn current(&self) -> TermMode {
        self.current
    }

    pub fn set_current(&mut self, m: TermMode) {
        self.current = m;
        self.sel = Self::index_of(m);
    }

    pub fn open(&mut self) {
        self.open = true;
        self.sel = Self::index_of(self.current);
    }

    pub fn close(&mut self) {
        self.open = false;
    }

    fn commit_mode(&mut self, index: usize) -> PickOutcome {
        let mode = TermMode::ALL[index];
        self.open = false;
        self.sel = index;
        let changed = mode != self.current;
        self.current = mode;
        PickOutcome {
            handled: true,
            redraw: true,
            chosen: changed.then_some(mode),
        }
    }

    pub fn area(cols: usize, rows: usize) -> Rect {
        let w = INNER_W.min(cols.max(1) as u16);
        let h = BOX_H.min(rows.max(1) as u16);
        let x = (cols as u16).saturating_sub(w) / 2;
        let y = (rows as u16).saturating_sub(h) / 2;
        Rect::new(x, y, w, h)
    }

    pub fn handle_key(&mut self, key: &str) -> PickOutcome {
        if !self.open {
            return PickOutcome::ignored();
        }
        let n = TermMode::ALL.len();
        match key {
            "Escape" => {
                self.open = false;
                PickOutcome::ate(true)
            }
            "ArrowDown" | "Tab" => {
                self.sel = (self.sel + 1) % n;
                PickOutcome::ate(true)
            }
            "ArrowUp" => {
                self.sel = (self.sel + n - 1) % n;
                PickOutcome::ate(true)
            }
            "Home" => {
                self.sel = 0;
                PickOutcome::ate(true)
            }
            "End" => {
                self.sel = n - 1;
                PickOutcome::ate(true)
            }
            "Enter" => self.commit_mode(self.sel),
            d if d.len() == 1 => {
                let Some(i) = d
                    .chars()
                    .next()
                    .and_then(|c| c.to_digit(10))
                    .and_then(|v| (v >= 1 && (v as usize) <= n).then_some(v as usize - 1))
                else {
                    return PickOutcome::ate(false);
                };
                self.commit_mode(i)
            }
            _ => PickOutcome::ate(false),
        }
    }

    pub fn hit(&self, col: usize, row: usize, cols: usize, rows: usize) -> Option<usize> {
        if !self.open {
            return None;
        }
        let a = Self::area(cols, rows);
        let (c, r) = (col as u16, row as u16);
        if c <= a.x || c + 1 >= a.x + a.width || r <= a.y || r + 1 >= a.y + a.height {
            return None;
        }
        let i = (r - a.y - 1) as usize;
        (i < TermMode::ALL.len()).then_some(i)
    }

    pub fn press_at(&mut self, col: usize, row: usize, cols: usize, rows: usize) -> PickOutcome {
        if !self.open {
            return PickOutcome::ignored();
        }
        match self.hit(col, row, cols, rows) {
            Some(i) => self.commit_mode(i),
            None => {
                self.open = false;
                PickOutcome::ate(true)
            }
        }
    }

    pub fn render(&self, cols: usize, rows: usize) -> String {
        if !self.open {
            return String::new();
        }
        let a = Self::area(cols, rows);
        if a.width < 4 || a.height < 3 {
            return String::new();
        }
        let mut buf = Buffer::empty(a);
        Block::default()
            .borders(Borders::ALL)
            .title(" render mode ")
            .render(a, &mut buf);

        let inner_w = a.width.saturating_sub(2) as usize;
        for (i, m) in TermMode::ALL.iter().enumerate() {
            let y = a.y + 1 + i as u16;
            if y + 1 >= a.y + a.height {
                break;
            }
            let selected = i == self.sel;
            let running = *m == self.current;
            let mark = if running { '*' } else { ' ' };
            let line = format!("{mark}{} {}", i + 1, m.label());
            let style = if selected {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Gray)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            let padded: String = format!("{line:<inner_w$}").chars().take(inner_w).collect();
            buf.set_string(a.x + 1, y, &padded, style);

            let hint = m.hint();
            let want = line.chars().count() + 2 + hint.chars().count();
            if want <= inner_w {
                let hx = a.x + 1 + (inner_w - hint.chars().count()) as u16;
                let hs = if selected {
                    style
                } else {
                    Style::default().add_modifier(Modifier::DIM)
                };
                buf.set_string(hx, y, hint, hs);
            }
        }

        let mut out = String::with_capacity(a.height as usize * (a.width as usize * 8));
        for y in a.y..a.y + a.height {
            out.push_str(&format!("\x1b[{};{}H", y + 1, a.x + 1));
            out.push_str(&row_to_ansi(&buf, y));
        }
        out
    }
}

fn parse_or_default(slug: &str) -> TermMode {
    TermMode::from_slug(slug).unwrap_or(TermMode::Ansi)
}

#[wasm_bindgen]
pub struct PickResult {
    handled: bool,
    redraw: bool,
    chosen: String,
}

#[wasm_bindgen]
impl PickResult {
    #[wasm_bindgen(getter)]
    pub fn handled(&self) -> bool {
        self.handled
    }
    #[wasm_bindgen(getter)]
    pub fn redraw(&self) -> bool {
        self.redraw
    }
    #[wasm_bindgen(getter)]
    pub fn chosen(&self) -> String {
        self.chosen.clone()
    }
}

impl From<PickOutcome> for PickResult {
    fn from(o: PickOutcome) -> Self {
        PickResult {
            handled: o.handled,
            redraw: o.redraw,
            chosen: o.chosen.map(|m| m.slug().to_string()).unwrap_or_default(),
        }
    }
}

#[wasm_bindgen(js_name = "ModePicker")]
pub struct JsModePicker {
    inner: ModePicker,
}

#[wasm_bindgen(js_class = "ModePicker")]
impl JsModePicker {
    #[wasm_bindgen(constructor)]
    pub fn new(current: &str) -> JsModePicker {
        JsModePicker {
            inner: ModePicker::new(parse_or_default(current)),
        }
    }

    #[wasm_bindgen(js_name = "isOpen")]
    pub fn is_open(&self) -> bool {
        self.inner.is_open()
    }

    pub fn open(&mut self) {
        self.inner.open();
    }

    pub fn close(&mut self) {
        self.inner.close();
    }

    #[wasm_bindgen(js_name = "currentSlug")]
    pub fn current_slug(&self) -> String {
        self.inner.current().slug().to_string()
    }

    #[wasm_bindgen(js_name = "setCurrent")]
    pub fn set_current(&mut self, slug: &str) {
        self.inner.set_current(parse_or_default(slug));
    }

    #[wasm_bindgen(js_name = "handleKey")]
    pub fn handle_key(&mut self, key: &str) -> PickResult {
        self.inner.handle_key(key).into()
    }

    #[wasm_bindgen(js_name = "pressAt")]
    pub fn press_at(&mut self, col: usize, row: usize, cols: usize, rows: usize) -> PickResult {
        self.inner.press_at(col, row, cols, rows).into()
    }

    pub fn render(&self, cols: usize, rows: usize) -> String {
        self.inner.render(cols, rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(s: &str) -> String {
        let mut out = String::new();
        let mut it = s.chars().peekable();
        while let Some(c) = it.next() {
            if c != '\x1b' {
                out.push(c);
                continue;
            }
            if it.peek() == Some(&'[') {
                it.next();
                for c2 in it.by_ref() {
                    if c2.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        }
        out
    }

    #[test]
    fn slug_round_trips_for_every_mode() {
        for m in TermMode::ALL {
            assert_eq!(TermMode::from_slug(m.slug()), Some(m), "{}", m.slug());
        }
    }

    #[test]
    fn unknown_slug_is_none_so_callers_can_default() {
        assert_eq!(TermMode::from_slug("wat"), None);
        assert_eq!(TermMode::from_slug(""), None);
    }

    #[test]
    fn only_ansi_and_kitty_are_modes() {
        for gone in ["text", "text-kitty", "kitty-mono", "halfblocks", "dom"] {
            assert_eq!(TermMode::from_slug(gone), None, "{gone}");
        }
    }

    #[test]
    fn closed_picker_renders_nothing_and_eats_nothing() {
        let mut p = ModePicker::new(TermMode::Ansi);
        assert!(!p.is_open());
        assert_eq!(p.render(100, 30), "");
        let o = p.handle_key("ArrowDown");
        assert!(!o.handled);
        assert!(o.chosen.is_none());
    }

    #[test]
    fn open_starts_on_the_running_mode() {
        let mut p = ModePicker::new(TermMode::Kitty);
        p.open();
        assert!(p.is_open());
        let o = p.handle_key("Enter");
        assert!(o.handled);
        assert!(o.chosen.is_none(), "re-picking the running mode is a no-op");
        assert_eq!(p.current(), TermMode::Kitty);
    }

    #[test]
    fn open_rewinds_the_cursor_to_current() {
        let mut p = ModePicker::new(TermMode::Kitty);
        p.open();
        p.handle_key("ArrowDown");
        p.handle_key("Escape");
        p.open();
        let o = p.handle_key("Enter");
        assert!(o.chosen.is_none());
        assert_eq!(p.current(), TermMode::Kitty);
    }

    #[test]
    fn arrows_wrap_both_ways() {
        let mut p = ModePicker::new(TermMode::Ansi);
        p.open();
        p.handle_key("ArrowUp");
        let o = p.handle_key("Enter");
        assert_eq!(o.chosen, Some(TermMode::Kitty), "up from first wraps");

        p.open();
        for _ in 0..TermMode::ALL.len() {
            p.handle_key("ArrowDown");
        }
        let o = p.handle_key("Enter");
        assert!(o.chosen.is_none(), "a full cycle returns to the start");
    }

    #[test]
    fn digits_select_directly() {
        let mut p = ModePicker::new(TermMode::Ansi);
        p.open();
        let o = p.handle_key("2");
        assert!(o.handled);
        assert_eq!(o.chosen, Some(TermMode::Kitty));
        assert!(!p.is_open(), "a digit commits and closes");
    }

    #[test]
    fn out_of_range_digit_is_swallowed_not_applied() {
        let mut p = ModePicker::new(TermMode::Kitty);
        p.open();
        let o = p.handle_key("8");
        assert!(o.handled, "a modal must not leak keys to the page");
        assert!(o.chosen.is_none());
        assert!(p.is_open());
    }

    #[test]
    fn escape_closes_without_choosing() {
        let mut p = ModePicker::new(TermMode::Ansi);
        p.open();
        p.handle_key("ArrowDown");
        let o = p.handle_key("Escape");
        assert!(o.handled);
        assert!(o.chosen.is_none());
        assert!(!p.is_open());
        assert_eq!(p.current(), TermMode::Ansi, "cancel keeps the old mode");
    }

    #[test]
    fn unknown_keys_are_consumed_while_open() {
        let mut p = ModePicker::new(TermMode::Ansi);
        p.open();
        let o = p.handle_key("F5");
        assert!(o.handled, "keys must not reach the page behind a modal");
        assert!(p.is_open());
    }

    #[test]
    fn render_lists_every_mode_and_marks_the_running_one() {
        let mut p = ModePicker::new(TermMode::Ansi);
        p.open();
        let txt = strip(&p.render(100, 30));
        for m in TermMode::ALL {
            assert!(txt.contains(m.label()), "missing {}", m.label());
        }
        assert!(txt.contains(&format!("*1 {}", TermMode::Ansi.label())));
    }

    #[test]
    fn render_is_centred_and_positioned() {
        let mut p = ModePicker::new(TermMode::Ansi);
        p.open();
        let out = p.render(100, 30);
        let a = ModePicker::area(100, 30);
        assert!(out.contains(&format!("\x1b[{};{}H", a.y + 1, a.x + 1)));
        assert!(out.matches('\x1b').count() >= a.height as usize);
        assert!(a.x > 0 && a.y > 0, "should not be flush to the corner");
    }

    #[test]
    fn render_survives_a_terminal_too_small_for_the_box() {
        let mut p = ModePicker::new(TermMode::Ansi);
        p.open();
        assert_eq!(p.render(3, 2), "");
        let _ = p.render(1, 1);
        let _ = p.render(0, 0);
    }

    #[test]
    fn render_truncates_labels_by_char_not_byte() {
        let mut p = ModePicker::new(TermMode::Ansi);
        p.open();
        for cols in 4..=60 {
            let out = p.render(cols, 12);
            assert!(!out.is_empty(), "cols={cols} should draw a box");
        }
    }

    #[test]
    fn clicking_a_row_commits_it() {
        let mut p = ModePicker::new(TermMode::Ansi);
        p.open();
        let a = ModePicker::area(100, 30);
        let o = p.press_at(a.x as usize + 2, a.y as usize + 2, 100, 30);
        assert_eq!(o.chosen, Some(TermMode::Kitty));
        assert!(!p.is_open());
    }

    #[test]
    fn clicking_the_border_or_outside_dismisses_without_choosing() {
        let a = ModePicker::area(100, 30);
        for (col, row) in [
            (a.x as usize, a.y as usize + 2),
            (a.x as usize + 2, a.y as usize),
            (0, 0),
        ] {
            let mut p = ModePicker::new(TermMode::Kitty);
            p.open();
            let o = p.press_at(col, row, 100, 30);
            assert!(o.chosen.is_none(), "({col},{row}) should not commit");
            assert!(!p.is_open(), "({col},{row}) should dismiss");
            assert_eq!(p.current(), TermMode::Kitty);
        }
    }

    #[test]
    fn hit_is_none_when_closed() {
        let p = ModePicker::new(TermMode::Kitty);
        let a = ModePicker::area(100, 30);
        assert!(p.hit(a.x as usize + 2, a.y as usize + 1, 100, 30).is_none());
    }

    #[test]
    fn set_current_moves_the_cursor_too() {
        let mut p = ModePicker::new(TermMode::Ansi);
        p.set_current(TermMode::Kitty);
        p.open();
        let o = p.handle_key("Enter");
        assert!(o.chosen.is_none());
        assert_eq!(p.current(), TermMode::Kitty);
    }

    #[test]
    fn the_menu_fits_every_entry() {
        let mut p = ModePicker::new(TermMode::Ansi);
        p.open();
        let txt = strip(&p.render(100, 30));
        for m in TermMode::ALL {
            assert!(txt.contains(m.label()), "missing {}", m.label());
        }
        let last = char::from_digit(TermMode::ALL.len() as u32, 10).unwrap();
        let o = p.handle_key(&last.to_string());
        assert_eq!(o.chosen, Some(*TermMode::ALL.last().unwrap()));
    }
}
