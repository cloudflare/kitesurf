// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Draws and manages the terminal browser's URL bar, navigation controls, and loading state.

use wasm_bindgen::prelude::*;

use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Paragraph, Widget};
use tui_input::{Input, InputRequest};
use unicode_width::UnicodeWidthChar;

use crate::tty::ansi::row_to_ansi;

const DONE_LINGER_TICKS: u8 = 5;
const MAX_OMNIBOX_INPUT_CHARS: usize = 2000;

const FIELD: Color = Color::DarkGray;

struct Chrome {
    back: Rect,
    fwd: Rect,
    reload: Rect,
    url: Rect,
}

impl Chrome {
    fn of(area: Rect) -> Self {
        let [_gap, back, fwd, reload, _gap2, url] = Layout::horizontal([
            Constraint::Length(1),
            Constraint::Length(2),
            Constraint::Length(2),
            Constraint::Length(2),
            Constraint::Length(1),
            Constraint::Min(0),
        ])
        .areas(area);
        Chrome {
            back,
            fwd,
            reload,
            url,
        }
    }
}

fn row_area(cols: usize) -> Rect {
    Rect::new(
        0,
        0,
        cols.saturating_sub(1).min(u16::MAX as usize) as u16,
        1,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hit {
    Back,
    Forward,
    Reload,
    Url,
}

#[wasm_bindgen]
pub struct Omni {
    url: String,
    can_back: bool,
    can_fwd: bool,
    loading: bool,
    editing: Option<Input>,
    hover: Option<Hit>,
    progress: f32,
    done_ticks: u8,
    painted_while_loading: bool,
}

#[wasm_bindgen]
impl Omni {
    #[wasm_bindgen(constructor)]
    pub fn new(url: &str) -> Self {
        Omni {
            url: url.to_string(),
            can_back: false,
            can_fwd: false,
            loading: true,
            editing: None,
            hover: None,
            progress: 0.05,
            done_ticks: 0,
            painted_while_loading: false,
        }
    }

    #[wasm_bindgen(js_name = "notePainted")]
    pub fn note_painted(&mut self) {
        if self.loading {
            self.painted_while_loading = true;
        } else if self.progress < 1.0 {
            self.finish();
        }
    }

    fn finish(&mut self) {
        self.progress = 1.0;
        self.done_ticks = DONE_LINGER_TICKS;
    }

    pub fn tick(&mut self) -> bool {
        if self.done_ticks > 0 {
            self.done_ticks -= 1;
            if self.done_ticks == 0 {
                self.progress = 0.0;
                return true;
            }
        }
        if !self.loading {
            return false;
        }
        self.progress += (0.9 - self.progress) * 0.08;
        true
    }

    #[wasm_bindgen(js_name = "renderRule")]
    pub fn render_rule(&self, cols: usize) -> String {
        let area = Rect::new(0, 0, cols.min(u16::MAX as usize) as u16, 1);
        let mut buf = Buffer::empty(area);
        ProgressRule {
            ratio: self.progress,
        }
        .render(area, &mut buf);
        row_to_ansi(&buf, 0)
    }

    pub fn hover_at(&mut self, col: usize, cols: usize) -> bool {
        let h = self.hit(col, cols);
        let changed = self.hover != h;
        self.hover = h;
        changed
    }

    pub fn clear_hover(&mut self) -> bool {
        let had = self.hover.is_some();
        self.hover = None;
        had
    }

    #[wasm_bindgen(js_name = "hitName")]
    pub fn hit_name(&self, col: usize, cols: usize) -> String {
        name_of(self.hit(col, cols))
    }

    #[wasm_bindgen(js_name = "isEditing")]
    pub fn is_editing(&self) -> bool {
        self.editing.is_some()
    }

    #[wasm_bindgen(js_name = "currentUrl")]
    pub fn current_url(&self) -> String {
        self.url.clone()
    }

    #[wasm_bindgen(js_name = "canBack")]
    pub fn can_back(&self) -> bool {
        self.can_back
    }

    #[wasm_bindgen(js_name = "canForward")]
    pub fn can_forward(&self) -> bool {
        self.can_fwd
    }

    #[wasm_bindgen(js_name = "isLoading")]
    pub fn is_loading(&self) -> bool {
        self.loading
    }

    #[wasm_bindgen(js_name = "setLoading")]
    pub fn set_loading(&mut self, v: bool) {
        self.apply_loading(v);
    }

    #[wasm_bindgen(js_name = "setNav")]
    pub fn set_nav(&mut self, url: &str, can_back: bool, can_fwd: bool, loading: bool) -> bool {
        let changed = url != self.url
            || can_back != self.can_back
            || can_fwd != self.can_fwd
            || loading != self.loading;
        if !url.is_empty() {
            self.url = url.to_string();
        }
        self.can_back = can_back;
        self.can_fwd = can_fwd;
        self.apply_loading(loading);
        changed
    }

    fn apply_loading(&mut self, loading: bool) {
        if loading && !self.loading {
            self.progress = 0.05;
            self.done_ticks = 0;
            self.painted_while_loading = false;
        }
        if !loading && self.loading {
            if std::mem::take(&mut self.painted_while_loading) {
                self.finish();
            } else {
                self.progress = self.progress.max(0.7);
            }
        }
        self.loading = loading;
    }

    fn hit(&self, col: usize, cols: usize) -> Option<Hit> {
        let c = Chrome::of(row_area(cols));
        let x = u16::try_from(col).ok()?;
        let in_rect = |r: Rect| r.width > 0 && x >= r.x && x < r.x + r.width;
        if in_rect(c.back) {
            Some(Hit::Back)
        } else if in_rect(c.fwd) {
            Some(Hit::Forward)
        } else if in_rect(c.reload) {
            Some(Hit::Reload)
        } else if in_rect(c.url) {
            Some(Hit::Url)
        } else {
            None
        }
    }

    #[wasm_bindgen(js_name = "beginEdit")]
    pub fn begin_edit(&mut self) {
        self.editing = Some(Input::new(self.url.clone()));
    }

    #[wasm_bindgen(js_name = "cancelEdit")]
    pub fn cancel_edit(&mut self) {
        self.editing = None;
    }

    #[wasm_bindgen(js_name = "commitEdit")]
    pub fn commit_edit(&mut self) -> Option<String> {
        let buf = self.editing.take()?;
        let buf = buf.value().to_string();
        let t = buf.trim();
        if t.is_empty() {
            return None;
        }
        Some(if t.contains("://") {
            t.to_string()
        } else {
            format!("https://{t}")
        })
    }

    #[wasm_bindgen(js_name = "pushText")]
    pub fn push_text(&mut self, s: &str) {
        for c in s.chars() {
            self.push_char(c);
        }
    }

    pub fn push_char(&mut self, c: char) {
        if let Some(b) = self.editing.as_mut() {
            if !c.is_control() && b.value().chars().count() < MAX_OMNIBOX_INPUT_CHARS {
                b.handle(InputRequest::InsertChar(c));
            }
        }
    }

    #[wasm_bindgen(js_name = "pressAt")]
    pub fn press_at(&mut self, col: usize, cols: usize, on_chrome: bool) -> PressOutcome {
        let hit = if on_chrome { self.hit(col, cols) } else { None };
        if hit != Some(Hit::Url) {
            let had = self.editing.take().is_some();
            return PressOutcome {
                hit: name_of(hit),
                redraw: had,
            };
        }
        let url = Chrome::of(row_area(cols)).url;
        if self.editing.is_none() {
            self.begin_edit();
        }
        if let Some(input) = self.editing.as_mut() {
            let scroll = input.visual_scroll(url.width.saturating_sub(1) as usize);
            let want = scroll + (col.saturating_sub(url.x as usize));
            let idx = char_index_at_col(input.value(), want);
            input.handle(InputRequest::SetCursor(idx));
        }
        PressOutcome {
            hit: "url".into(),
            redraw: true,
        }
    }

    #[wasm_bindgen(js_name = "handleKey")]
    pub fn handle_key(&mut self, key: &str, text: &str, alt: bool, ctrl: bool) -> KeyOutcome {
        if self.editing.is_none() {
            return KeyOutcome {
                handled: false,
                redraw: false,
                navigate: None,
            };
        }
        let done = |redraw| KeyOutcome {
            handled: true,
            redraw,
            navigate: None,
        };
        match key {
            "Escape" => {
                self.cancel_edit();
                return done(true);
            }
            "Enter" => {
                let navigate = self.commit_edit();
                return KeyOutcome {
                    handled: true,
                    redraw: true,
                    navigate,
                };
            }
            _ => {}
        }
        if ctrl && key == "c" {
            self.cancel_edit();
            return done(true);
        }
        let req = match key {
            "Backspace" if alt || ctrl => Some(InputRequest::DeletePrevWord),
            "Backspace" => Some(InputRequest::DeletePrevChar),
            "Delete" if alt || ctrl => Some(InputRequest::DeleteNextWord),
            "Delete" => Some(InputRequest::DeleteNextChar),
            "ArrowLeft" if alt || ctrl => Some(InputRequest::GoToPrevWord),
            "ArrowLeft" => Some(InputRequest::GoToPrevChar),
            "ArrowRight" if alt || ctrl => Some(InputRequest::GoToNextWord),
            "ArrowRight" => Some(InputRequest::GoToNextChar),
            "Home" => Some(InputRequest::GoToStart),
            "End" => Some(InputRequest::GoToEnd),
            "a" if ctrl => Some(InputRequest::GoToStart),
            "e" if ctrl => Some(InputRequest::GoToEnd),
            "b" if ctrl => Some(InputRequest::GoToPrevChar),
            "f" if ctrl => Some(InputRequest::GoToNextChar),
            "b" if alt => Some(InputRequest::GoToPrevWord),
            "f" if alt => Some(InputRequest::GoToNextWord),
            "d" if alt => Some(InputRequest::DeleteNextWord),
            "d" if ctrl => Some(InputRequest::DeleteNextChar),
            "w" if ctrl => Some(InputRequest::DeletePrevWord),
            "u" if ctrl => Some(InputRequest::DeleteLine),
            "k" if ctrl => Some(InputRequest::DeleteTillEnd),
            _ => None,
        };
        if let Some(req) = req {
            let changed = self.editing.as_mut().and_then(|i| i.handle(req)).is_some();
            return done(changed);
        }
        if text.is_empty() || ctrl || alt {
            return done(false);
        }
        self.push_text(text);
        done(true)
    }

    #[wasm_bindgen(js_name = "editText")]
    pub fn edit_text(&self) -> String {
        self.editing
            .as_ref()
            .map(|i| i.value().to_string())
            .unwrap_or_default()
    }

    #[wasm_bindgen(js_name = "editCursor")]
    pub fn edit_cursor(&self) -> u32 {
        self.editing
            .as_ref()
            .map(|i| i.visual_cursor() as u32)
            .unwrap_or(0)
    }

    #[wasm_bindgen(js_name = "cursorCol")]
    pub fn cursor_col(&self, cols: usize) -> Option<u32> {
        let input = self.editing.as_ref()?;
        let url = Chrome::of(row_area(cols)).url;
        if url.width == 0 {
            return None;
        }
        let caret = input
            .visual_cursor()
            .saturating_sub(field_scroll(input, url.width));
        Some(url.x as u32 + caret.min(url.width.saturating_sub(1) as usize) as u32)
    }

    pub fn render(&self, cols: usize) -> String {
        let area = row_area(cols);
        let mut buf = Buffer::empty(area);
        let c = Chrome::of(area);
        let plain = Style::new().fg(Color::Reset).bg(Color::Reset);
        buf.set_style(area, plain);

        let button = |buf: &mut Buffer, r: Rect, hit: Hit, on: bool, ch: char| {
            let hot = self.hover == Some(hit) && on;
            let mut st = plain;
            if hot {
                st = st.bg(FIELD);
            }
            st = st.add_modifier(if on { Modifier::BOLD } else { Modifier::DIM });
            buf.set_style(r, st);
            buf.set_string(r.x, r.y, ch.to_string(), st);
        };
        button(&mut buf, c.back, Hit::Back, self.can_back, '←');
        button(&mut buf, c.fwd, Hit::Forward, self.can_fwd, '→');
        button(&mut buf, c.reload, Hit::Reload, true, '⟳');

        let field = plain.bg(FIELD);
        buf.set_style(c.url, field);
        match &self.editing {
            Some(input) => {
                let scroll = field_scroll(input, c.url.width);
                Paragraph::new(input.value())
                    .style(field)
                    .scroll((0, scroll as u16))
                    .render(c.url, &mut buf);
            }
            None => {
                Paragraph::new(self.url.as_str())
                    .style(field)
                    .render(c.url, &mut buf);
            }
        }
        row_to_ansi(&buf, 0)
    }
}

fn field_scroll(input: &Input, width: u16) -> usize {
    input.visual_scroll(width.saturating_sub(1) as usize)
}

fn char_index_at_col(s: &str, col: usize) -> usize {
    let mut w = 0usize;
    for (i, ch) in s.chars().enumerate() {
        let cw = UnicodeWidthChar::width(ch).unwrap_or(0);
        if w + cw > col {
            return i;
        }
        w += cw;
    }
    s.chars().count()
}

fn name_of(h: Option<Hit>) -> String {
    match h {
        Some(Hit::Back) => "back",
        Some(Hit::Forward) => "forward",
        Some(Hit::Reload) => "reload",
        Some(Hit::Url) => "url",
        None => "",
    }
    .to_string()
}

#[wasm_bindgen]
pub struct PressOutcome {
    hit: String,
    redraw: bool,
}

#[wasm_bindgen]
impl PressOutcome {
    #[wasm_bindgen(getter)]
    pub fn hit(&self) -> String {
        self.hit.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn redraw(&self) -> bool {
        self.redraw
    }
}

#[wasm_bindgen]
pub struct KeyOutcome {
    handled: bool,
    redraw: bool,
    navigate: Option<String>,
}

#[wasm_bindgen]
impl KeyOutcome {
    #[wasm_bindgen(getter)]
    pub fn handled(&self) -> bool {
        self.handled
    }

    #[wasm_bindgen(getter)]
    pub fn redraw(&self) -> bool {
        self.redraw
    }

    #[wasm_bindgen(getter)]
    pub fn navigate(&self) -> Option<String> {
        self.navigate.clone()
    }
}

struct ProgressRule {
    ratio: f32,
}

impl Widget for ProgressRule {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let fill = if self.ratio <= 0.0 {
            0
        } else {
            (self.ratio.clamp(0.0, 1.0) * area.width as f32).round() as u16
        };
        for x in area.left()..area.right() {
            let done = x - area.left() < fill;
            let (ch, st) = if done {
                ("\u{2501}", Style::new().fg(Color::Rgb(66, 133, 244)))
            } else {
                (
                    "\u{2500}",
                    Style::new().fg(Color::Reset).add_modifier(Modifier::DIM),
                )
            };
            buf[(x, area.y)].set_symbol(ch).set_style(st);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const COLS: usize = 80;
    const URL_X: usize = 8;

    fn width(s: &str) -> usize {
        use unicode_width::UnicodeWidthStr;
        let mut out = String::new();
        let mut it = s.chars();
        while let Some(c) = it.next() {
            if c == '\u{1b}' {
                for c2 in it.by_ref() {
                    if c2.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                out.push(c);
            }
        }
        UnicodeWidthStr::width(out.as_str())
    }

    fn plain(s: &str) -> String {
        let mut out = String::new();
        let mut it = s.chars();
        while let Some(c) = it.next() {
            if c == '\u{1b}' {
                for c2 in it.by_ref() {
                    if c2.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                out.push(c);
            }
        }
        out
    }

    fn highlighted_control_width(row: &str) -> usize {
        let controls = &row[..row.find("https").unwrap_or(row.len())];
        controls
            .split("\x1b[100m")
            .nth(1)
            .map(|run| width(run.split("\x1b[").next().unwrap_or_default()))
            .unwrap_or(0)
    }

    fn has_bold_dim_overlap(s: &str) -> bool {
        let mut bold = false;
        let mut dim = false;
        for sequence in s.split("\x1b[").skip(1) {
            let Some(end) = sequence.find('m') else {
                continue;
            };
            let codes: Vec<_> = sequence[..end].split(';').collect();
            let mut i = 0;
            while i < codes.len() {
                match codes[i] {
                    "0" | "22" => {
                        bold = false;
                        dim = false;
                    }
                    "1" => bold = true,
                    "2" => dim = true,
                    "38" | "48" => {
                        i += match codes.get(i + 1) {
                            Some(&"2") => 4,
                            Some(&"5") => 2,
                            _ => 0,
                        };
                    }
                    _ => {}
                }
                if bold && dim {
                    return true;
                }
                i += 1;
            }
        }
        false
    }

    #[test]
    fn the_bar_stops_one_cell_short_of_the_terminal() {
        let o = Omni::new("https://example.com");
        assert_eq!(width(&o.render(COLS)), COLS - 1);
    }

    #[test]
    fn a_wide_url_still_fits_the_row() {
        let o = Omni::new(&format!(
            "https://{}.example/{}",
            "例".repeat(40),
            "字".repeat(40)
        ));
        assert_eq!(
            width(&o.render(COLS)),
            COLS - 1,
            "wide glyphs overflowed the row"
        );
    }

    #[test]
    fn an_emoji_url_still_fits_the_row() {
        let o = Omni::new(&format!("https://example.com/{}", "🎉".repeat(60)));
        assert_eq!(width(&o.render(COLS)), COLS - 1);
    }

    #[test]
    fn editing_keeps_the_tail_of_a_wide_string_visible() {
        let mut o = Omni::new("");
        o.begin_edit();
        o.push_text(&"例".repeat(60));
        o.push_text("ZZ");
        let row = o.render(COLS);
        assert_eq!(width(&row), COLS - 1, "scrolled field overflowed");
        let shown = plain(&row).trim_end().to_string();
        assert!(shown.ends_with("ZZ"), "tail not visible: {shown:?}");
    }

    #[test]
    fn every_column_hits_what_it_looks_like() {
        let mut o = Omni::new("https://example.com");
        o.set_nav("https://example.com", true, true, false);
        for col in 0..COLS {
            let name = o.hit_name(col, COLS);
            let expect = match col {
                0 => "",
                1 | 2 => "back",
                3 | 4 => "forward",
                5 | 6 => "reload",
                7 => "",
                c if c == COLS - 1 => "",
                _ => "url",
            };
            assert_eq!(name, expect, "column {col}");
        }
    }

    #[test]
    fn the_last_column_is_the_wrap_gutter_and_hits_nothing() {
        let o = Omni::new("https://example.com");
        assert_eq!(o.hit_name(COLS - 1, COLS), "", "gutter is drawable");
    }

    #[test]
    fn hovering_a_button_highlights_the_whole_hit_target() {
        let mut o = Omni::new("https://example.com");
        o.set_nav("https://example.com", true, false, false);
        assert!(o.hover_at(2, COLS), "column 2 is part of the back button");
        let row = o.render(COLS);
        assert_eq!(highlighted_control_width(&row), 2);
    }

    #[test]
    fn the_controls_are_bold_when_live_and_dim_when_not() {
        let mut o = Omni::new("https://example.com");
        o.set_nav("https://example.com", true, true, false);
        let row = o.render(COLS);
        assert!(row.contains("\x1b[1m"), "live controls are not bold");
        let head: String = row
            .chars()
            .take(row.find("https").unwrap_or(row.len()))
            .collect();
        assert!(!head.contains("\x1b[2m"), "a live control was dimmed");

        o.set_nav("https://example.com", false, false, false);
        let row = o.render(COLS);
        assert!(row.contains("\x1b[2m"), "dead controls are not dimmed");
    }

    #[test]
    fn a_control_is_never_bold_and_dim_at_once() {
        assert!(has_bold_dim_overlap("\x1b[1m\x1b[2m"));
        assert!(!has_bold_dim_overlap("\x1b[1m\x1b[22m\x1b[2m"));

        let mut o = Omni::new("https://example.com");
        o.set_nav("https://example.com", true, false, false);
        let row = o.render(COLS);
        assert!(
            !has_bold_dim_overlap(&row),
            "simultaneous SGR 1 and 2: {row:?}"
        );
        assert!(row.contains("\x1b[1m"), "live controls are not bold");
        assert!(row.contains("\x1b[2m"), "disabled controls are not dim");
    }

    #[test]
    fn a_disabled_button_does_not_light_up() {
        let mut o = Omni::new("https://example.com");
        o.set_nav("https://example.com", false, false, false);
        o.hover_at(1, COLS);
        let row = o.render(COLS);
        assert_eq!(highlighted_control_width(&row), 0);
        assert!(row.contains("\u{1b}[2m"), "disabled button not dimmed");
    }

    #[test]
    fn the_cursor_sits_after_the_typed_text() {
        let mut o = Omni::new("");
        o.begin_edit();
        o.push_text("abc");
        assert_eq!(o.cursor_col(COLS), Some((URL_X + 3) as u32));
    }

    #[test]
    fn the_cursor_accounts_for_double_width_glyphs() {
        let mut o = Omni::new("");
        o.begin_edit();
        o.push_text("例例");
        assert_eq!(
            o.cursor_col(COLS),
            Some((URL_X + 4) as u32),
            "caret placed by chars, not columns"
        );
    }

    #[test]
    fn there_is_no_cursor_when_not_editing() {
        let o = Omni::new("https://example.com");
        assert_eq!(o.cursor_col(COLS), None);
    }

    #[test]
    fn the_caret_stays_inside_the_field_when_it_is_full() {
        let mut o = Omni::new("");
        o.begin_edit();
        o.push_text(&"x".repeat(400));
        let c = o.cursor_col(COLS).unwrap() as usize;
        assert!(c < COLS - 1, "caret {c} escaped the row");
    }

    #[test]
    fn the_rule_spans_the_full_width() {
        let o = Omni::new("https://example.com");
        assert_eq!(width(&o.render_rule(COLS)), COLS);
    }

    #[test]
    fn progress_fills_the_rule_from_the_left() {
        let mut o = Omni::new("https://example.com");
        o.set_nav("https://example.com", false, false, true);
        for _ in 0..40 {
            o.tick();
        }
        let p = plain(&o.render_rule(COLS));
        let filled = p.chars().filter(|c| *c == '━').count();
        assert!(filled > 0 && filled < COLS, "no partial fill: {filled}");
        let head: String = p.chars().take(filled).collect();
        assert!(
            head.chars().all(|c| c == '━'),
            "fill is not contiguous from the left"
        );
    }

    #[test]
    fn a_frame_painted_mid_navigate_finishes_the_bar_when_it_resolves() {
        let mut o = Omni::new("https://example.com");
        o.note_painted();
        assert!(o.set_nav("https://example.com", false, false, false));
        assert_eq!(o.progress, 1.0, "bar stalled after the only frame");
        for _ in 0..DONE_LINGER_TICKS {
            o.tick();
        }
        assert_eq!(o.progress, 0.0, "a finished bar should clear");
    }

    #[test]
    fn a_frame_from_the_previous_navigate_does_not_finish_the_next() {
        let mut o = Omni::new("https://example.com");
        o.note_painted();
        o.set_nav("https://example.com", false, false, false);
        o.set_loading(true);
        o.set_nav("https://example.org", true, false, false);
        assert!(o.progress < 1.0, "a stale paint finished the next load");
    }

    #[test]
    fn styles_are_emitted_per_run_not_per_character() {
        let o = Omni::new("https://example.com/some/reasonably/long/path");
        let row = o.render(COLS);
        let escapes = row.matches('\u{1b}').count();
        assert!(escapes < 20, "{escapes} escape sequences for one row");
        assert!(row.len() < 200, "row is {} bytes", row.len());
    }

    #[test]
    fn a_narrow_terminal_does_not_panic_or_overflow() {
        for cols in 0..14usize {
            let mut o = Omni::new("https://example.com");
            o.begin_edit();
            o.push_text("abc");
            let row = o.render(cols);
            assert!(
                width(&row) <= cols.saturating_sub(1),
                "overflow at {cols} cols"
            );
            let _ = o.render_rule(cols);
            let _ = o.hit_name(0, cols);
            let _ = o.cursor_col(cols);
        }
    }

    #[test]
    fn loading_does_not_change_the_bar() {
        let mut o = Omni::new("https://example.com");
        let loading = o.render(COLS);
        o.set_loading(false);
        let idle = o.render(COLS);
        assert_eq!(
            loading, idle,
            "the progress rule is the only loading indicator"
        );
    }

    fn editing(url: &str) -> Omni {
        let mut o = Omni::new(url);
        o.begin_edit();
        o
    }

    fn key(o: &mut Omni, k: &str) -> bool {
        o.handle_key(k, "", false, false).redraw()
    }
    fn alt(o: &mut Omni, k: &str) -> bool {
        o.handle_key(k, "", true, false).redraw()
    }
    fn ctrl(o: &mut Omni, k: &str) -> bool {
        o.handle_key(k, "", false, true).redraw()
    }
    fn typed(o: &mut Omni, t: &str) {
        o.handle_key(t, t, false, false);
    }

    fn field(o: &Omni) -> String {
        plain(&o.render(COLS))
            .chars()
            .skip(URL_X)
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    #[test]
    fn option_delete_removes_one_url_segment_at_a_time() {
        let mut o = editing("https://en.wikipedia.org/wiki/Wyoming");
        alt(&mut o, "Backspace");
        assert_eq!(field(&o), "https://en.wikipedia.org/wiki/");
        alt(&mut o, "Backspace");
        assert_eq!(field(&o), "https://en.wikipedia.org/");
        alt(&mut o, "Backspace");
        assert_eq!(field(&o), "https://en.wikipedia.");
    }

    #[test]
    fn ctrl_backspace_and_ctrl_w_also_delete_a_word() {
        let mut o = editing("https://example.com/path");
        ctrl(&mut o, "Backspace");
        assert_eq!(field(&o), "https://example.com/");
        let mut o = editing("https://example.com/path");
        ctrl(&mut o, "w");
        assert_eq!(field(&o), "https://example.com/");
    }

    #[test]
    fn plain_backspace_still_removes_one_character() {
        let mut o = editing("abc");
        key(&mut o, "Backspace");
        assert_eq!(field(&o), "ab");
    }

    #[test]
    fn the_caret_moves_and_text_inserts_where_it_is() {
        let mut o = editing("ac");
        key(&mut o, "ArrowLeft");
        typed(&mut o, "b");
        assert_eq!(field(&o), "abc");
    }

    #[test]
    fn word_motion_walks_url_segments() {
        let mut o = editing("https://example.com/a/b");
        alt(&mut o, "ArrowLeft");
        alt(&mut o, "ArrowLeft");
        typed(&mut o, "Z");
        assert_eq!(field(&o), "https://example.com/Za/b");
    }

    #[test]
    fn home_and_end_and_their_emacs_chords_agree() {
        for (k, c) in [("Home", "a"), ("End", "e")] {
            let mut o = editing("abc");
            key(&mut o, k);
            let by_key = field(&o);
            let mut o2 = editing("abc");
            ctrl(&mut o2, c);
            assert_eq!(by_key, field(&o2), "{k} and ctrl+{c} disagree");
        }
        let mut o = editing("bc");
        key(&mut o, "Home");
        typed(&mut o, "a");
        assert_eq!(field(&o), "abc");
    }

    #[test]
    fn ctrl_u_clears_and_ctrl_k_kills_to_the_end() {
        let mut o = editing("https://example.com");
        ctrl(&mut o, "u");
        assert_eq!(field(&o), "");
        let mut o = editing("abcdef");
        key(&mut o, "Home");
        for _ in 0..3 {
            key(&mut o, "ArrowRight");
        }
        ctrl(&mut o, "k");
        assert_eq!(field(&o), "abc");
    }

    #[test]
    fn alt_d_deletes_the_word_ahead_of_the_caret() {
        let mut o = editing("https://example.com/a");
        key(&mut o, "Home");
        alt(&mut o, "d");
        assert_eq!(field(&o), "example.com/a");
    }

    #[test]
    fn forward_delete_removes_the_character_ahead() {
        let mut o = editing("abc");
        key(&mut o, "Home");
        key(&mut o, "Delete");
        assert_eq!(field(&o), "bc");
    }

    #[test]
    fn escape_cancels_and_enter_commits() {
        let mut o = editing("example.com");
        assert!(key(&mut o, "Escape"));
        assert!(!o.is_editing());

        let mut o = editing("");
        typed(&mut o, "example.com");
        let r = o.handle_key("Enter", "", false, false);
        assert_eq!(r.navigate().as_deref(), Some("https://example.com"));
        assert!(!o.is_editing());
    }

    #[test]
    fn ctrl_c_abandons_the_edit() {
        let mut o = editing("example.com");
        assert!(o.handle_key("c", "c", false, true).handled());
        assert!(!o.is_editing());
    }

    #[test]
    fn a_chord_never_types_its_letter() {
        let mut o = editing("");
        o.handle_key("u", "u", false, true);
        o.handle_key("b", "b", true, false);
        assert_eq!(field(&o), "", "a chord leaked text into the field");
    }

    #[test]
    fn keys_are_not_handled_when_the_field_has_no_focus() {
        let mut o = Omni::new("https://example.com");
        let r = o.handle_key("a", "a", false, false);
        assert!(!r.handled(), "the page's keystroke was swallowed");
    }

    #[test]
    fn a_pure_cursor_move_that_does_nothing_asks_for_no_redraw() {
        let mut o = editing("abc");
        key(&mut o, "Home");
        assert!(!key(&mut o, "ArrowLeft"), "redrew for a no-op move");
    }

    #[test]
    fn the_view_scrolls_back_when_the_caret_leaves_the_left_edge() {
        let mut o = editing(&format!("https://example.com/{}", "a".repeat(200)));
        assert!(
            !field(&o).starts_with("https://"),
            "long url is not scrolled"
        );
        key(&mut o, "Home");
        assert!(
            field(&o).starts_with("https://"),
            "view did not follow the caret home"
        );
        assert_eq!(
            o.cursor_col(COLS),
            Some(URL_X as u32),
            "caret not at the field's left edge"
        );
    }

    #[test]
    fn the_caret_tracks_display_columns_through_a_word_delete() {
        let mut o = editing("");
        typed(&mut o, "例え/ab");
        assert_eq!(o.cursor_col(COLS), Some((URL_X + 7) as u32));
        alt(&mut o, "Backspace");
        assert_eq!(
            o.cursor_col(COLS),
            Some((URL_X + 5) as u32),
            "caret counted chars, not columns"
        );
    }

    const IN_FIELD: usize = 20;

    #[test]
    fn clicking_the_page_releases_the_url_field() {
        let mut o = Omni::new("https://example.com");
        o.press_at(IN_FIELD, COLS, true);
        assert!(o.is_editing());
        let p = o.press_at(0, COLS, false);
        assert!(!o.is_editing(), "page click left the field focused");
        assert!(p.redraw(), "blur did not ask for a repaint");
        assert_eq!(p.hit(), "");
    }

    #[test]
    fn a_blurred_field_hands_keys_back_to_the_page() {
        let mut o = Omni::new("https://example.com");
        o.press_at(IN_FIELD, COLS, true);
        o.press_at(0, COLS, false);
        assert!(
            !o.handle_key("a", "a", false, false).handled(),
            "keystroke swallowed"
        );
    }

    #[test]
    fn clicking_another_control_releases_the_field_too() {
        for col in [1usize, 3, 5] {
            let mut o = Omni::new("https://example.com");
            o.set_nav("https://example.com", true, true, false);
            o.press_at(IN_FIELD, COLS, true);
            let p = o.press_at(col, COLS, true);
            assert!(!o.is_editing(), "column {col} kept focus");
            assert!(p.redraw());
            assert_ne!(p.hit(), "", "column {col} lost its hit");
        }
    }

    #[test]
    fn a_press_that_changes_nothing_asks_for_no_repaint() {
        let mut o = Omni::new("https://example.com");
        assert!(
            !o.press_at(0, COLS, false).redraw(),
            "repainted an idle blur"
        );
    }

    #[test]
    fn clicking_the_field_again_keeps_what_was_typed() {
        let mut o = Omni::new("https://example.com");
        o.press_at(IN_FIELD, COLS, true);
        o.handle_key("u", "u", false, true);
        o.handle_key("abc", "abc", false, false);
        o.press_at(IN_FIELD, COLS, true);
        assert_eq!(field(&o), "abc", "second click wiped the edit");
    }

    #[test]
    fn clicking_in_the_field_puts_the_caret_there() {
        let mut o = Omni::new("abcdef");
        o.press_at(URL_X + 3, COLS, true);
        assert_eq!(o.cursor_col(COLS), Some((URL_X + 3) as u32));
        o.handle_key("Z", "Z", false, false);
        assert_eq!(field(&o), "abcZdef");
    }

    #[test]
    fn clicking_past_the_end_of_the_text_lands_after_it() {
        let mut o = Omni::new("ab");
        o.press_at(URL_X + 40, COLS, true);
        o.handle_key("Z", "Z", false, false);
        assert_eq!(field(&o), "abZ");
    }

    #[test]
    fn a_click_on_a_wide_glyph_lands_on_one_caret_stop() {
        let mut o = Omni::new("例え");
        o.press_at(URL_X + 2, COLS, true);
        let a = o.cursor_col(COLS);
        let mut o2 = Omni::new("例え");
        o2.press_at(URL_X + 3, COLS, true);
        assert_eq!(a, o2.cursor_col(COLS), "halves of a wide glyph disagree");
        o.handle_key("Z", "Z", false, false);
        assert_eq!(field(&o), "例Zえ");
    }

    #[test]
    fn focus_survives_a_press_that_stays_in_the_field() {
        let mut o = Omni::new("https://example.com");
        o.press_at(IN_FIELD, COLS, true);
        let p = o.press_at(IN_FIELD + 1, COLS, true);
        assert!(o.is_editing());
        assert_eq!(p.hit(), "url");
    }

    #[test]
    fn the_field_runs_to_the_right_edge() {
        let mut o = Omni::new("https://example.com/");
        let cols = 60usize;
        assert_eq!(o.hit_name(cols - 2, cols), "url");
        assert!(!o.render(cols).contains('⚙'), "no settings button");
        assert_eq!(o.press_at(cols - 2, cols, true).hit(), "url");
    }

    #[test]
    fn a_narrow_bar_still_reports_something_sane() {
        let mut o = Omni::new("https://example.com/");
        for cols in [1usize, 2, 4, 8, 12] {
            let _ = o.render(cols);
            let _ = o.press_at(cols.saturating_sub(1), cols, true);
        }
    }
}
