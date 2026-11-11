// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Maps decoded paint scenes, text, and image resources onto terminal cells.
//! Supplies the cell data used by the ANSI and Kitty rendering paths.

use std::collections::HashMap;
use std::rc::Rc;

#[cfg(not(feature = "native-host"))]
use wasm_bindgen::prelude::*;

use crate::paint::scene_decode::{
    ScenePart, DecodedCap, DecodedFillRule, DecodedJoin, DecodedPaint, DecodedPathEl,
    DecodedTransform, SceneVisitor,
};
use crate::paint::scene_record::Q3_UNITS_PER_PIXEL;
use crate::paint::scene_replay::{MISSING_RESOURCE_ENTRY_BYTES, RESOURCE_COUNT_BYTES};
use crate::tty::modes::ImageMode;

const BASELINE_ASCENT_FRAC: f32 = 0.8;

const CHECKBOX_ON: char = '\u{2611}';
const CHECKBOX_OFF: char = '\u{2610}';
const RADIO_ON: char = '\u{25C9}';
const RADIO_OFF: char = '\u{25CB}';

#[derive(Clone, Copy, PartialEq)]
struct Cell {
    bg: Option<[u8; 3]>,
    ch: char,
    fg: [u8; 3],
    bold: bool,
    italic: bool,
    underline: bool,
}

impl Default for Cell {
    fn default() -> Self {
        Cell {
            ch: ' ',
            fg: [0, 0, 0],
            bg: None,
            bold: false,
            italic: false,
            underline: false,
        }
    }
}

const BOLD_COORD_MIN: i16 = 3277;

const MAX_RULE_PX: f32 = 3.5;

pub struct KittyPlacement {
    pub col: usize,
    pub row: usize,
    pub cols: usize,
    pub rows: usize,
    pub key: String,
    img: Rc<GridImage>,
    crop: SrcRect,
    px_w: u32,
    px_h: u32,
}

impl KittyPlacement {
    pub fn png(&self) -> Option<Vec<u8>> {
        png_at(&self.img, self.crop, self.px_w, self.px_h)
    }
}

#[derive(Clone)]
pub struct GridImage {
    pub width: u32,
    pub height: u32,
    pub rgba: peniko::Blob<u8>,
}

pub struct TtyGrid {
    cols: usize,
    rows: usize,
    cell_w: f32,
    cell_h: f32,
    cells: Vec<Cell>,
    pub text_runs: u32,
    pub glyph_runs: u32,
    pub glyphs_dropped: u64,
    pub chars_placed: u64,
    pub chars_clipped: u64,
    pub page_bg: Option<[u8; 3]>,
    bg_coverage: f32,
    part: Vec<(u64, ScenePart)>,
    control_pending: Option<ScenePart>,
    pending_rules: Vec<(isize, isize, isize, [u8; 3])>,
    pending_table_bg: Option<(f32, f32, f32, f32, [u8; 3])>,
    pub cell_collisions: u64,
    images: HashMap<u64, Rc<GridImage>>,
    pub images_placed: u32,
    pub images_missing: u32,
    image_mode: ImageMode,
    pub placements: Vec<KittyPlacement>,
}

impl TtyGrid {
    pub fn new(cols: usize, rows: usize, cell_w: f32, cell_h: f32) -> Self {
        TtyGrid {
            control_pending: None,
            cols,
            rows,
            cell_w,
            cell_h,
            cells: vec![Cell::default(); cols * rows],
            text_runs: 0,
            glyph_runs: 0,
            glyphs_dropped: 0,
            chars_placed: 0,
            chars_clipped: 0,
            page_bg: None,
            bg_coverage: 0.0,
            part: Vec::new(),
            pending_rules: Vec::new(),
            pending_table_bg: None,
            cell_collisions: 0,
            images: HashMap::new(),
            images_placed: 0,
            images_missing: 0,
            image_mode: ImageMode::Halfblocks,
            placements: Vec::new(),
        }
    }

    pub fn set_image_mode(&mut self, m: ImageMode) {
        self.image_mode = m;
    }

    fn mark_image(&mut self, c0: usize, r0: usize, c1: usize, r1: usize) {
        for row in r0..r1.min(self.rows) {
            for col in c0..c1.min(self.cols) {
                let cell = &mut self.cells[row * self.cols + col];
                if cell.ch == ' ' {
                    cell.ch = '\u{2591}';
                    cell.fg = [128, 128, 128];
                }
            }
        }
    }

    pub fn set_images(&mut self, images: HashMap<u64, Rc<GridImage>>) {
        self.images = images;
    }

    fn draw_image(&mut self, content_hash: u64, t: &DecodedTransform, path: &[DecodedPathEl]) {
        #[cfg(not(feature = "native-host"))]
        use ratatui::{buffer::Buffer, layout::Rect, style::Color, widgets::Widget};
        #[cfg(not(feature = "native-host"))]
        use ratatui_image::Image;
        #[cfg(not(feature = "native-host"))]
        use ratatui_image::{
            Resize,
            picker::{Picker, ProtocolType},
        };

        let Some((x0, y0, x1, y1)) = path_bbox(t, path) else {
            return;
        };
        let (bc0, br0) = ((x0 / self.cell_w).round(), (y0 / self.cell_h).round());
        let (bc1, br1) = ((x1 / self.cell_w).round(), (y1 / self.cell_h).round());
        let c0 = bc0.max(0.0) as usize;
        let r0 = br0.max(0.0) as usize;
        let c1 = (bc1.max(0.0) as usize).min(self.cols);
        let r1 = (br1.max(0.0) as usize).min(self.rows);
        if c1 <= c0 || r1 <= r0 {
            return;
        }
        let Some(img) = self
            .images
            .get(&content_hash)
            .filter(|img| img.width > 0 && img.height > 0)
            .cloned()
        else {
            self.images_missing += 1;
            self.mark_image(c0, r0, c1, r1);
            return;
        };
        let (sx, sw) = visible_span(img.width, bc0, bc1, c0 as f32, c1 as f32);
        let (sy, sh) = visible_span(img.height, br0, br1, r0 as f32, r1 as f32);
        let crop = (sx, sy, sw, sh);
        if self.image_mode == ImageMode::Kitty {
            let pw = ((c1 - c0) as f32 * self.cell_w).round().max(1.0) as u32;
            let ph = ((r1 - r0) as f32 * self.cell_h).round().max(1.0) as u32;
            if u64::from(pw) * u64::from(ph) > MAX_PLACEMENT_PX {
                self.images_missing += 1;
                self.mark_image(c0, r0, c1, r1);
                return;
            }
            for row in r0..r1 {
                for col in c0..c1 {
                    self.cells[row * self.cols + col].ch = ' ';
                }
            }
            if image_view(&img).is_none() {
                self.images_missing += 1;
                self.mark_image(c0, r0, c1, r1);
                return;
            }
            self.placements.push(KittyPlacement {
                col: c0,
                row: r0,
                cols: c1 - c0,
                rows: r1 - r0,
                key: format!("{content_hash}:{sx},{sy},{sw},{sh}:{pw}x{ph}"),
                img,
                crop,
                px_w: pw,
                px_h: ph,
            });
            self.images_placed += 1;
            return;
        }
        let Some(buf_img) = image_view(&img).and_then(|v| {
            use image::GenericImage as _;
            let mut owned = image::RgbaImage::new(crop.2, crop.3);
            owned.copy_from(&*crop_view(&v, crop), 0, 0).ok()?;
            Some(owned)
        }) else {
            self.images_missing += 1;
            self.mark_image(c0, r0, c1, r1);
            return;
        };
        #[cfg(feature = "native-host")]
        {
            use image::imageops::{resize, FilterType};
            let cols = (c1 - c0) as u32;
            let rows = (r1 - r0) as u32;
            let pixels = resize(&buf_img, cols, rows * 2, FilterType::Triangle);
            for ry in 0..rows as usize {
                for rx in 0..cols as usize {
                    let upper = pixels.get_pixel(rx as u32, (ry * 2) as u32).0;
                    let lower = pixels.get_pixel(rx as u32, (ry * 2 + 1) as u32).0;
                    let dst = &mut self.cells[(r0 + ry) * self.cols + c0 + rx];
                    dst.ch = if upper[..3] == lower[..3] {
                        ' '
                    } else {
                        '\u{2580}'
                    };
                    dst.fg = [upper[0], upper[1], upper[2]];
                    dst.bg = Some([lower[0], lower[1], lower[2]]);
                }
            }
            self.images_placed += 1;
            #[cfg(not(feature = "native-host"))]
            return;
        }
        #[cfg(not(feature = "native-host"))]
        let area = Rect::new(0, 0, (c1 - c0) as u16, (r1 - r0) as u16);
        #[cfg(not(feature = "native-host"))]
        let mut picker =
            Picker::from_fontsize((self.cell_w.max(1.0) as u16, self.cell_h.max(1.0) as u16));
        #[cfg(not(feature = "native-host"))]
        picker.set_protocol_type(ProtocolType::Halfblocks);
        #[cfg(not(feature = "native-host"))]
        let Ok(proto) = picker.new_protocol(
            image::DynamicImage::ImageRgba8(buf_img),
            area,
            Resize::Fit(None),
        ) else {
            self.images_missing += 1;
            self.mark_image(c0, r0, c1, r1);
            return;
        };
        #[cfg(not(feature = "native-host"))]
        let mut buf = Buffer::empty(area);
        #[cfg(not(feature = "native-host"))]
        Image::new(&proto).render(area, &mut buf);
        #[cfg(not(feature = "native-host"))]
        let rgb = |c: Color| match c {
            Color::Rgb(r, g, b) => Some([r, g, b]),
            _ => None,
        };
        #[cfg(not(feature = "native-host"))]
        for ry in 0..area.height {
            for rx in 0..area.width {
                let cell = &buf[(rx, ry)];
                let Some(ch) = cell.symbol().chars().next() else {
                    continue;
                };
                let (fg, bg) = (rgb(cell.fg), rgb(cell.bg));
                if ch == ' ' && bg.is_none() {
                    continue;
                }
                let dst = &mut self.cells[(r0 + ry as usize) * self.cols + (c0 + rx as usize)];
                dst.ch = ch;
                if let Some(fg) = fg {
                    dst.fg = fg;
                }
                if let Some(bg) = bg {
                    dst.bg = Some(bg);
                }
            }
        }
        #[cfg(not(feature = "native-host"))]
        {
            self.images_placed += 1;
        }
    }

    fn current_part(&self) -> Option<ScenePart> {
        self.part.last().map(|(_, p)| *p)
    }

    fn take_control(&mut self, x0: f32, y0: f32, x1: f32, y1: f32) -> bool {
        let Some(part) = self.control_pending else {
            return false;
        };
        let glyph = match part {
            ScenePart::Checkbox { checked: true } => CHECKBOX_ON,
            ScenePart::Checkbox { checked: false } => CHECKBOX_OFF,
            ScenePart::Radio { checked: true } => RADIO_ON,
            ScenePart::Radio { checked: false } => RADIO_OFF,
            _ => return false,
        };
        self.control_pending = None;
        self.put_control(x0, y0, x1, y1, glyph);
        true
    }

    fn put_control(&mut self, x0: f32, _y0: f32, x1: f32, y1: f32, glyph: char) {
        let row = (y1 / self.cell_h).floor() as i64;
        if row < 0 || row >= self.rows as i64 {
            return;
        }
        let col = ((x0 + x1) / 2.0 / self.cell_w).floor() as i64;
        if col < 0 || col >= self.cols as i64 {
            return;
        }
        let cell = &mut self.cells[row as usize * self.cols + col as usize];
        cell.ch = glyph;
        cell.bold = true;
    }

    fn note_rule(
        &mut self,
        start: (f32, f32),
        end: (f32, f32),
        thickness: f32,
        color: [u8; 3],
        cover_intersected_cells: bool,
    ) {
        let (x0, y0) = start;
        let (x1, y1) = end;
        let (w, h) = (x1 - x0, y1 - y0);
        if w < self.cell_w {
            return;
        }
        if h > MAX_RULE_PX || thickness > MAX_RULE_PX {
            return;
        }
        let row = (y0 / self.cell_h).round() as isize - 1;
        let (c0, c1) = if cover_intersected_cells {
            (
                (x0 / self.cell_w).floor() as isize,
                (x1 / self.cell_w).ceil() as isize,
            )
        } else {
            (
                (x0 / self.cell_w).round() as isize,
                (x1 / self.cell_w).round() as isize,
            )
        };
        self.pending_rules.push((row, c0, c1, color));
    }

    fn apply_rules(&mut self) {
        let rules = std::mem::take(&mut self.pending_rules);
        for (row, c0, c1, color) in rules {
            if row < 0 || row as usize >= self.rows {
                continue;
            }
            for col in c0.max(0)..c1.min(self.cols as isize) {
                let cell = &mut self.cells[row as usize * self.cols + col as usize];
                cell.underline = true;
                if cell.ch == ' ' {
                    cell.fg = color;
                }
            }
        }
    }

    fn stamp_background(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, color: [u8; 3]) {
        let c0 = (x0 / self.cell_w).floor().max(0.0) as usize;
        let c1 = ((x1 / self.cell_w).ceil().max(0.0) as usize).min(self.cols);
        let r0 = (y0 / self.cell_h).round().max(0.0) as usize;
        let r1 = ((y1 / self.cell_h).round().max(0.0) as usize).min(self.rows);
        for row in r0..r1 {
            for col in c0..c1 {
                self.cells[row * self.cols + col].bg = Some(color);
            }
        }
    }

    fn flush_table_background_to(&mut self, end_y: f32) {
        let Some((x0, y0, x1, _y1, color)) = self.pending_table_bg.take() else {
            return;
        };
        self.stamp_background(x0, y0, x1, end_y, color);
    }

    fn note_table_background(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, color: [u8; 3]) {
        self.flush_table_background_to(y0);
        self.pending_table_bg = Some((x0, y0, x1, y1, color));
    }

    fn put(&mut self, col: isize, row: isize, ch: char, fg: [u8; 3], bold: bool, italic: bool) {
        if ch.is_control() {
            return;
        }
        if col < 0 || row < 0 || col as usize >= self.cols || row as usize >= self.rows {
            self.chars_clipped += 1;
            return;
        }
        let idx = row as usize * self.cols + col as usize;
        if self.cells[idx].ch != ' ' && self.cells[idx].ch != ch {
            self.cell_collisions += 1;
        }
        let underline = self.cells[idx].underline;
        let bg = self.cells[idx].bg;
        self.cells[idx] = Cell {
            ch,
            fg,
            bg,
            bold,
            italic,
            underline,
        };
        self.chars_placed += 1;
    }

    pub fn render_ansi(&mut self) -> String {
        self.apply_rules();
        let mut out = String::with_capacity(self.cols * self.rows * 2);
        let bg = self.page_bg.unwrap_or([255, 255, 255]);
        let bg_seq = format!("\x1b[48;2;{};{};{}m", bg[0], bg[1], bg[2]);
        let mut last_fg: Option<[u8; 3]> = None;
        let mut last_attr: Option<(bool, bool, bool)> = None;
        for row in 0..self.rows {
            let mut last_bg: Option<[u8; 3]>;
            out.push_str(&bg_seq);
            last_bg = Some(bg);
            let line = &self.cells[row * self.cols..(row + 1) * self.cols];
            let mut end = line.iter().rposition(|c| c.ch != ' ').map_or(0, |i| i + 1);
            if let Some(i) = line.iter().rposition(|c| c.bg.is_some() || c.underline) {
                end = end.max(i + 1);
            }
            for cell in &line[..end] {
                let want = cell.bg.unwrap_or(bg);
                if last_bg != Some(want) {
                    out.push_str(&format!("\x1b[48;2;{};{};{}m", want[0], want[1], want[2]));
                    last_bg = Some(want);
                }
                {
                    let attr = (
                        cell.bold && cell.ch != ' ',
                        cell.italic && cell.ch != ' ',
                        cell.underline,
                    );
                    if last_attr != Some(attr) {
                        out.push_str(if attr.0 { "\x1b[1m" } else { "\x1b[22m" });
                        out.push_str(if attr.1 { "\x1b[3m" } else { "\x1b[23m" });
                        out.push_str(if attr.2 { "\x1b[4m" } else { "\x1b[24m" });
                        last_attr = Some(attr);
                    }
                    if (cell.ch != ' ' || cell.underline) && last_fg != Some(cell.fg) {
                        out.push_str(&format!(
                            "\x1b[38;2;{};{};{}m",
                            cell.fg[0], cell.fg[1], cell.fg[2]
                        ));
                        last_fg = Some(cell.fg);
                    }
                }
                out.push(cell.ch);
            }
            if last_bg != Some(bg) {
                out.push_str(&bg_seq);
            }
            if last_attr.is_some_and(|a| a.2) {
                out.push_str("\x1b[24m");
            }
            out.push_str("\x1b[K\x1b[0m\r\n");
            last_fg = None;
            last_attr = None;
        }
        out
    }
}

fn path_bbox(t: &DecodedTransform, path: &[DecodedPathEl]) -> Option<(f32, f32, f32, f32)> {
    let (mut x0, mut y0) = (f32::MAX, f32::MAX);
    let (mut x1, mut y1) = (f32::MIN, f32::MIN);
    let mut seen = false;
    let add = |px: f32, py: f32, x0: &mut f32, y0: &mut f32, x1: &mut f32, y1: &mut f32| {
        let (tx, ty) = apply(t, px, py);
        *x0 = x0.min(tx);
        *y0 = y0.min(ty);
        *x1 = x1.max(tx);
        *y1 = y1.max(ty);
    };
    for el in path {
        match *el {
            DecodedPathEl::Move { x, y } | DecodedPathEl::Line { x, y } => {
                add(x, y, &mut x0, &mut y0, &mut x1, &mut y1);
                seen = true;
            }
            DecodedPathEl::Quad { cx, cy, x, y } => {
                add(cx, cy, &mut x0, &mut y0, &mut x1, &mut y1);
                add(x, y, &mut x0, &mut y0, &mut x1, &mut y1);
                seen = true;
            }
            DecodedPathEl::Curve {
                c1x,
                c1y,
                c2x,
                c2y,
                x,
                y,
            } => {
                add(c1x, c1y, &mut x0, &mut y0, &mut x1, &mut y1);
                add(c2x, c2y, &mut x0, &mut y0, &mut x1, &mut y1);
                add(x, y, &mut x0, &mut y0, &mut x1, &mut y1);
                seen = true;
            }
            DecodedPathEl::Close => {}
        }
    }
    if seen {
        Some((x0, y0, x1, y1))
    } else {
        None
    }
}

fn apply(t: &DecodedTransform, x: f32, y: f32) -> (f32, f32) {
    let c = t.0;
    (c[0] * x + c[2] * y + c[4], c[1] * x + c[3] * y + c[5])
}

impl SceneVisitor for TtyGrid {
    fn on_text_run(
        &mut self,
        _font_id: u32,
        font_size: f32,
        normalized_coords: &[i16],
        transform: DecodedTransform,
        rgba: (u8, u8, u8, u8),
        start_x_q3: i16,
        start_y_q3: i16,
        text_utf8: &[u8],
        _kerns: &[(u16, i8)],
        flags: u8,
    ) {
        self.text_runs += 1;
        let Ok(text) = std::str::from_utf8(text_utf8) else {
            return;
        };
        #[cfg(not(target_arch = "wasm32"))]
        if std::env::var("KS_TTY_COORDS").is_ok() {
            eprintln!(
                "run coords={:?} size={:.1} text={:?}",
                normalized_coords,
                font_size,
                text.chars().take(24).collect::<String>()
            );
        }
        let (bx, by) = apply(
            &transform,
            start_x_q3 as f32 / Q3_UNITS_PER_PIXEL,
            start_y_q3 as f32 / Q3_UNITS_PER_PIXEL,
        );
        let row = ((by - BASELINE_ASCENT_FRAC * font_size) / self.cell_h).round() as isize;
        let col0 = (bx / self.cell_w).round() as isize;
        let fg = [rgba.0, rgba.1, rgba.2];
        let bold = normalized_coords
            .first()
            .is_some_and(|c| *c >= BOLD_COORD_MIN);
        let italic = flags & 1 != 0;
        for (i, ch) in text.chars().enumerate() {
            if ch == ' ' {
                continue;
            }
            self.put(col0 + i as isize, row, ch, fg, bold, italic);
        }
    }

    fn on_glyph_run(
        &mut self,
        _font_id: u32,
        _size: f32,
        _coords: &[i16],
        _t: DecodedTransform,
        _paint: DecodedPaint,
        glyphs: &[(u32, f32, f32)],
    ) {
        self.glyph_runs += 1;
        self.glyphs_dropped += glyphs.len() as u64;
    }

    fn on_push_layer(
        &mut self,
        _mix: u8,
        _compose: u8,
        _alpha: f32,
        _t: DecodedTransform,
        _clip: &[DecodedPathEl],
    ) {
    }
    fn on_push_clip_layer(&mut self, _t: DecodedTransform, _clip: &[DecodedPathEl]) {}
    fn on_pop_layer(&mut self) {}
    fn on_part_begin(&mut self, node_id: u64, part: ScenePart) {
        if matches!(part, ScenePart::Checkbox { .. } | ScenePart::Radio { .. }) {
            self.control_pending = Some(part);
        }
        self.part.push((node_id, part));
    }

    fn on_part_end(&mut self) {
        if matches!(self.current_part(), Some(ScenePart::TableRowBackground)) {
            if let Some((_, _, _, y1, _)) = self.pending_table_bg {
                self.flush_table_background_to(y1);
            }
        }
        if let Some((_, p)) = self.part.last() {
            if matches!(p, ScenePart::Checkbox { .. } | ScenePart::Radio { .. }) {
                self.control_pending = None;
            }
        }
        self.part.pop();
    }

    fn on_fill(
        &mut self,
        _rule: DecodedFillRule,
        t: DecodedTransform,
        _bt: Option<DecodedTransform>,
        paint: DecodedPaint,
        path: &[DecodedPathEl],
    ) {
        if let DecodedPaint::Image { content_hash } = paint {
            self.draw_image(content_hash, &t, path);
            return;
        }
        let DecodedPaint::Solid { r, g, b, a } = paint else {
            return;
        };
        if a < 250 {
            return;
        }
        let Some((x0, y0, x1, y1)) = path_bbox(&t, path) else {
            return;
        };
        #[cfg(not(target_arch = "wasm32"))]
        if std::env::var("KS_TTY_FILLS").is_ok() {
            eprintln!(
                "fill  {:.0}x{:.0} at ({:.0},{:.0}) rgba=({r},{g},{b},{a})",
                x1 - x0,
                y1 - y0,
                x0,
                y0
            );
        }
        let (vw, vh) = (
            self.cols as f32 * self.cell_w,
            self.rows as f32 * self.cell_h,
        );
        if vw <= 0.0 || vh <= 0.0 {
            return;
        }
        match self.current_part() {
            Some(ScenePart::TableBorder) => {
                self.note_rule((x0, y0), (x1, y1), y1 - y0, [r, g, b], true);
                return;
            }
            Some(ScenePart::Border | ScenePart::Outline | ScenePart::TextDecoration) => {
                self.note_rule((x0, y0), (x1, y1), y1 - y0, [r, g, b], false);
                return;
            }
            Some(ScenePart::Marker) => {
                return;
            }
            Some(ScenePart::Checkbox { .. } | ScenePart::Radio { .. }) => {
                self.take_control(x0, y0, x1, y1);
                return;
            }
            Some(ScenePart::Background | ScenePart::TableRowBackground)
                if y1 - y0 < self.cell_h * 0.5 =>
            {
                self.note_rule((x0, y0), (x1, y1), y1 - y0, [r, g, b], false);
                return;
            }
            Some(ScenePart::Background | ScenePart::TableRowBackground) => {}
            _ => {}
        }
        if matches!(self.current_part(), None | Some(ScenePart::Unknown)) {
            self.note_rule((x0, y0), (x1, y1), y1 - y0, [r, g, b], false);
        }
        let cw = (x1.min(vw) - x0.max(0.0)).max(0.0);
        let ch = (y1.min(vh) - y0.max(0.0)).max(0.0);
        let coverage = (cw * ch) / (vw * vh);
        if coverage >= 0.6 && coverage >= self.bg_coverage {
            self.bg_coverage = coverage;
            self.page_bg = Some([r, g, b]);
            return;
        }
        if y1 - y0 < self.cell_h * 0.5 {
            return;
        }
        if matches!(self.current_part(), Some(ScenePart::TableRowBackground)) {
            self.note_table_background(x0, y0, x1, y1, [r, g, b]);
        } else {
            self.stamp_background(x0, y0, x1, y1, [r, g, b]);
        }
    }
    fn on_stroke(
        &mut self,
        stroke_w: f32,
        _m2: f32,
        _c: DecodedCap,
        _j: DecodedJoin,
        _do_: f32,
        _dashes: &[f32],
        t: DecodedTransform,
        _bt: Option<DecodedTransform>,
        paint: DecodedPaint,
        path: &[DecodedPathEl],
    ) {
        let Some((x0, y0, x1, y1)) = path_bbox(&t, path) else {
            return;
        };
        #[cfg(not(target_arch = "wasm32"))]
        if std::env::var("KS_TTY_FILLS").is_ok() {
            eprintln!(
                "strk  {:.0}x{:.0} at ({:.0},{:.0}) width={stroke_w:.1}",
                x1 - x0,
                y1 - y0,
                x0,
                y0
            );
        }
        if self.take_control(x0, y0, x1, y1) {
            return;
        }
        if matches!(
            self.current_part(),
            Some(ScenePart::Checkbox { .. } | ScenePart::Radio { .. })
        ) {
            return;
        }
        let color = match paint {
            DecodedPaint::Solid { r, g, b, .. } => [r, g, b],
            _ => [0, 0, 0],
        };
        self.note_rule((x0, y0), (x1, y1), stroke_w, color, false);
    }
    fn on_box_shadow(
        &mut self,
        _t: DecodedTransform,
        _x0: f32,
        _y0: f32,
        _x1: f32,
        _y1: f32,
        _rgba: (u8, u8, u8, u8),
        _radius: f32,
        _std_dev: f32,
    ) {
    }
}

const MAX_GRID_COLS: u32 = 1024;
const MAX_GRID_ROWS: u32 = 512;
const MIN_CELL_PX: f32 = 1.0;
const MAX_CELL_PX: f32 = 64.0;
const MAX_PLACEMENT_PX: u64 = 2560 * 1440;
const MAX_RESIZE_BYTES: u64 = 24 << 20;

fn grid_dims_ok(cols: u32, rows: u32, cell_w: f32, cell_h: f32) -> bool {
    (1..=MAX_GRID_COLS).contains(&cols)
        && (1..=MAX_GRID_ROWS).contains(&rows)
        && cell_w.is_finite()
        && cell_h.is_finite()
        && (MIN_CELL_PX..=MAX_CELL_PX).contains(&cell_w)
        && (MIN_CELL_PX..=MAX_CELL_PX).contains(&cell_h)
}

#[cfg(not(feature = "native-host"))]
#[wasm_bindgen(js_name = "sceneToAnsi")]
pub fn scene_to_ansi(scene: &[u8], cols: u32, rows: u32, cell_w: f32, cell_h: f32) -> String {
    let Some(mut grid) = decode_grid(scene, cols, rows, cell_w, cell_h) else {
        return String::new();
    };
    grid.render_ansi()
}

pub fn inline_images(scene: &[u8]) -> HashMap<u64, Rc<GridImage>> {
    use crate::paint::scene_decode::{parse_header, parse_resources};
    let Ok(header) = parse_header(scene) else {
        return HashMap::new();
    };
    let Ok(mut res) = parse_resources(scene, &header) else {
        return HashMap::new();
    };
    crate::paint::scene_replay::decode_inline_images(&mut res)
        .into_iter()
        .map(|(hash, img)| {
            (
                hash,
                Rc::new(GridImage {
                    width: img.width,
                    height: img.height,
                    rgba: img.data.clone(),
                }),
            )
        })
        .collect()
}

#[derive(Default)]
pub struct TtyImages {
    store: crate::paint::scene_replay::ResourceStore,
}

impl TtyImages {
    pub fn missing_images(&self, scene: &[u8]) -> Vec<u8> {
        let all = crate::paint::scene_replay::missing_resources(&self.store, scene);
        let n = if all.len() >= RESOURCE_COUNT_BYTES {
            u32::from_le_bytes([all[0], all[1], all[2], all[3]]) as usize
        } else {
            0
        };
        let mut kept: Vec<u8> = Vec::with_capacity(all.len());
        let mut count = 0u32;
        for i in 0..n {
            let off = RESOURCE_COUNT_BYTES + i * MISSING_RESOURCE_ENTRY_BYTES;
            if off + MISSING_RESOURCE_ENTRY_BYTES > all.len() {
                break;
            }
            if all[off] != crate::paint::scene_record::RBI_RESOURCE_KIND_IMAGE {
                continue;
            }
            kept.extend_from_slice(&all[off..off + MISSING_RESOURCE_ENTRY_BYTES]);
            count += 1;
        }
        let mut out = count.to_le_bytes().to_vec();
        out.extend_from_slice(&kept);
        out
    }

    pub fn put_resources(&mut self, batch: &[u8]) -> u32 {
        self.store.put_batch(batch)
    }

    pub fn pending_images(&self) -> Vec<String> {
        self.store
            .pending_image_keys()
            .iter()
            .map(|k| k.to_string())
            .collect()
    }

    pub fn put_image_bytes(&mut self, key: u64, bytes: &[u8]) -> u32 {
        self.store.put_image_bytes(key, bytes)
    }

    pub fn abandon_image(&mut self, key: u64) -> bool {
        self.store.abandon_image_key(key)
    }

    pub fn images_for(&self, scene: &[u8]) -> HashMap<u64, Rc<GridImage>> {
        let mut out: HashMap<u64, Rc<GridImage>> = self
            .store
            .images_iter()
            .map(|(hash, img)| {
                (
                    *hash,
                    Rc::new(GridImage {
                        width: img.width,
                        height: img.height,
                        rgba: img.data.clone(),
                    }),
                )
            })
            .collect();
        out.extend(inline_images(scene));
        out
    }

    pub fn scene_to_ansi(
        &mut self,
        scene: &[u8],
        cols: u32,
        rows: u32,
        cell_w: f32,
        cell_h: f32,
        images: ImageMode,
    ) -> Option<TtyGrid> {
        if !grid_dims_ok(cols, rows, cell_w, cell_h) {
            return None;
        }
        let mut grid = TtyGrid::new(cols as usize, rows as usize, cell_w, cell_h);
        grid.set_image_mode(images);
        grid.set_images(self.images_for(scene));
        crate::paint::scene_decode::decode(scene, &mut grid).ok()?;
        Some(grid)
    }
}

#[cfg(not(feature = "native-host"))]
#[wasm_bindgen]
#[derive(Default)]
pub struct TtyRenderer {
    inner: std::cell::RefCell<TtyImages>,
    last_placed: std::cell::Cell<u32>,
    last_missing: std::cell::Cell<u32>,
    last_collisions: std::cell::Cell<u32>,
    image_mode: std::cell::Cell<ImageMode>,
    placements: std::cell::RefCell<Vec<KittyPlacement>>,
}

#[cfg(not(feature = "native-host"))]
impl std::panic::RefUnwindSafe for TtyRenderer {}

#[cfg(not(feature = "native-host"))]
#[wasm_bindgen]
impl TtyRenderer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> TtyRenderer {
        TtyRenderer::default()
    }

    #[wasm_bindgen(js_name = "missingImages")]
    pub fn missing_images(&self, scene: &[u8]) -> Vec<u8> {
        self.inner.borrow().missing_images(scene)
    }

    #[wasm_bindgen(js_name = "putResources")]
    pub fn put_resources(&self, batch: &[u8]) -> u32 {
        self.inner.borrow_mut().put_resources(batch)
    }

    #[wasm_bindgen(js_name = "pendingImages")]
    pub fn pending_images(&self) -> Vec<String> {
        self.inner.borrow().pending_images()
    }

    #[wasm_bindgen(js_name = "putImageBytes")]
    pub fn put_image_bytes(&self, key: &str, bytes: &[u8]) -> u32 {
        let Ok(parsed) = key.parse::<u64>() else {
            return 0;
        };
        self.inner.borrow_mut().put_image_bytes(parsed, bytes)
    }

    #[wasm_bindgen(js_name = "abandonImage")]
    pub fn abandon_image(&self, key: &str) -> u32 {
        let Ok(parsed) = key.parse::<u64>() else {
            return 0;
        };
        u32::from(self.inner.borrow_mut().abandon_image(parsed))
    }

    #[wasm_bindgen(js_name = "sceneToAnsi")]
    pub fn scene_to_ansi(
        &self,
        scene: &[u8],
        cols: u32,
        rows: u32,
        cell_w: f32,
        cell_h: f32,
    ) -> String {
        let mut inner = self.inner.borrow_mut();
        let Some(mut grid) =
            inner.scene_to_ansi(scene, cols, rows, cell_w, cell_h, self.image_mode.get())
        else {
            return String::new();
        };
        self.last_placed.set(grid.images_placed);
        self.last_missing.set(grid.images_missing);
        self.last_collisions
            .set(grid.cell_collisions.min(u32::MAX as u64) as u32);
        *self.placements.borrow_mut() = std::mem::take(&mut grid.placements);
        grid.render_ansi()
    }

    #[wasm_bindgen(js_name = "setImageMode")]
    pub fn set_image_mode(&self, mode: &str) {
        self.image_mode
            .set(ImageMode::from_slug(mode).unwrap_or(ImageMode::Halfblocks));
    }

    #[wasm_bindgen(js_name = "placementMeta")]
    pub fn placement_meta(&self) -> String {
        let p = self.placements.borrow();
        let mut out = String::from("[");
        for (i, k) in p.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!(
                "{{\"col\":{},\"row\":{},\"cols\":{},\"rows\":{},\"key\":\"{}\"}}",
                k.col, k.row, k.cols, k.rows, k.key
            ));
        }
        out.push(']');
        out
    }

    #[wasm_bindgen(js_name = "placementPng")]
    pub fn placement_png(&self, i: usize) -> Vec<u8> {
        self.placements
            .borrow()
            .get(i)
            .and_then(KittyPlacement::png)
            .unwrap_or_default()
    }

    #[wasm_bindgen(js_name = "placementCount")]
    pub fn placement_count(&self) -> usize {
        self.placements.borrow().len()
    }

    #[wasm_bindgen(js_name = "cellCollisions")]
    pub fn cell_collisions(&self) -> u32 {
        self.last_collisions.get()
    }

    #[wasm_bindgen(js_name = "imagesPlaced")]
    pub fn images_placed(&self) -> u32 {
        self.last_placed.get()
    }

    #[wasm_bindgen(js_name = "imagesMissing")]
    pub fn images_missing(&self) -> u32 {
        self.last_missing.get()
    }
}

type SrcRect = (u32, u32, u32, u32);

type PixelView<'a> = image::ImageBuffer<image::Rgba<u8>, &'a [u8]>;

fn image_view(img: &GridImage) -> Option<PixelView<'_>> {
    image::ImageBuffer::from_raw(img.width, img.height, img.rgba.data())
}

fn crop_view<'a, 'b>(
    view: &'a PixelView<'b>,
    (x, y, w, h): SrcRect,
) -> image::SubImage<&'a PixelView<'b>> {
    image::imageops::crop_imm(view, x, y, w, h)
}

fn visible_span(len_px: u32, b0: f32, b1: f32, v0: f32, v1: f32) -> (u32, u32) {
    let len = len_px as f32;
    let at = |v: f32| (v - b0) / (b1 - b0) * len;
    let (start, end) = (at(v0).floor(), at(v1).ceil());
    if !(start.is_finite() && end.is_finite()) {
        return (0, len_px);
    }
    let start = start.clamp(0.0, len - 1.0);
    let end = end.clamp(start + 1.0, len);
    (start as u32, (end - start) as u32)
}

fn png_at(img: &GridImage, crop: SrcRect, w: u32, h: u32) -> Option<Vec<u8>> {
    use image::GenericImageView as _;
    let view = image_view(img)?;
    let src = crop_view(&view, crop);
    let filtered = u64::from(src.width()) * u64::from(h) * 16 + u64::from(w) * u64::from(h) * 4;
    let scaled = if filtered <= MAX_RESIZE_BYTES {
        image::imageops::resize(&*src, w, h, image::imageops::FilterType::Triangle)
    } else {
        image::imageops::thumbnail(&*src, w, h)
    };
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(scaled)
        .write_to(&mut out, image::ImageFormat::Png)
        .ok()?;
    Some(out.into_inner())
}

fn decode_grid(scene: &[u8], cols: u32, rows: u32, cell_w: f32, cell_h: f32) -> Option<TtyGrid> {
    if !grid_dims_ok(cols, rows, cell_w, cell_h) {
        return None;
    }
    let mut grid = TtyGrid::new(cols as usize, rows as usize, cell_w, cell_h);
    grid.set_images(inline_images(scene));
    crate::paint::scene_decode::decode(scene, &mut grid).ok()?;
    Some(grid)
}

pub fn osc52(text: &str) -> String {
    format!("\x1b]52;c;{}\x07", b64(text.as_bytes()))
}

fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut o = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        o.push(T[(n >> 18) as usize & 63] as char);
        o.push(T[(n >> 12) as usize & 63] as char);
        o.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        o.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    o
}

#[cfg(not(feature = "native-host"))]
#[wasm_bindgen(js_name = "osc52")]
pub fn osc52_js(text: &str) -> String {
    osc52(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::scene_decode::{
        DecodedFillRule, DecodedPaint, DecodedPathEl, DecodedTransform, ScenePart, SceneVisitor,
    };

    const CW: f32 = 8.0;
    const CH: f32 = 16.0;

    fn grid(cols: usize, rows: usize) -> TtyGrid {
        TtyGrid::new(cols, rows, CW, CH)
    }

    fn ident() -> DecodedTransform {
        DecodedTransform([1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    }

    fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<DecodedPathEl> {
        vec![
            DecodedPathEl::Move { x: x0, y: y0 },
            DecodedPathEl::Line { x: x1, y: y0 },
            DecodedPathEl::Line { x: x1, y: y1 },
            DecodedPathEl::Line { x: x0, y: y1 },
            DecodedPathEl::Close,
        ]
    }

    fn fill(g: &mut TtyGrid, x0: f32, y0: f32, x1: f32, y1: f32, rgba: (u8, u8, u8, u8)) {
        let (r, gr, b, a) = rgba;
        g.on_fill(
            DecodedFillRule::NonZero,
            ident(),
            None,
            DecodedPaint::Solid { r, g: gr, b, a },
            &rect(x0, y0, x1, y1),
        );
    }

    fn text(g: &mut TtyGrid, col: usize, row: usize, s: &str) {
        let size = CH;
        let bx = col as f32 * CW;
        let by = row as f32 * CH + 0.8 * size;
        g.on_text_run(
            1,
            size,
            &[],
            ident(),
            (0, 0, 0, 255),
            (bx * 8.0) as i16,
            (by * 8.0) as i16,
            s.as_bytes(),
            &[],
            0,
        );
    }

    fn bg_runs(ansi: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut rest = ansi;
        while let Some(i) = rest.find("\x1b[48;2;") {
            rest = &rest[i + 7..];
            let end = rest.find('m').unwrap_or(0);
            out.push(rest[..end].to_string());
            rest = &rest[end..];
        }
        out
    }

    #[test]
    fn a_full_page_fill_becomes_the_page_background() {
        let mut g = grid(10, 4);
        fill(&mut g, 0.0, 0.0, 80.0, 64.0, (20, 30, 40, 255));
        let ansi = g.render_ansi();
        assert!(bg_runs(&ansi).iter().all(|b| b == "20;30;40"));
    }

    #[test]
    fn white_is_assumed_when_the_page_never_says() {
        let mut g = grid(4, 1);
        text(&mut g, 0, 0, "hi");
        assert!(g.render_ansi().contains("\x1b[48;2;255;255;255m"));
    }

    #[test]
    fn a_band_over_part_of_the_grid_paints_only_those_cells() {
        let mut g = grid(10, 3);
        fill(&mut g, 0.0, 0.0, 80.0, 48.0, (255, 255, 255, 255));
        fill(&mut g, 16.0, 16.0, 40.0, 32.0, (0, 0, 255, 255));
        let ansi = g.render_ansi();
        let rows: Vec<&str> = ansi.split("\r\n").collect();
        assert!(
            !rows[0].contains("0;0;255"),
            "band leaked onto the row above"
        );
        assert!(
            rows[1].contains("\x1b[48;2;0;0;255m"),
            "band missing on its own row"
        );
        assert!(
            !rows[2].contains("0;0;255"),
            "band leaked onto the row below"
        );
    }

    #[test]
    fn a_thin_fill_is_a_rule_not_a_background() {
        let mut g = grid(10, 2);
        fill(&mut g, 0.0, 0.0, 80.0, 32.0, (255, 255, 255, 255));
        fill(&mut g, 0.0, 15.0, 80.0, 16.0, (0, 0, 0, 255));
        assert!(
            !g.render_ansi().contains("\x1b[48;2;0;0;0m"),
            "a 1px rule was painted as a cell background"
        );
    }

    #[test]
    fn a_translucent_wash_is_ignored() {
        let mut g = grid(6, 2);
        fill(&mut g, 0.0, 0.0, 48.0, 32.0, (255, 255, 255, 255));
        fill(&mut g, 0.0, 0.0, 48.0, 16.0, (255, 0, 0, 120));
        assert!(!g.render_ansi().contains("255;0;0"));
    }

    #[test]
    fn a_glyph_does_not_erase_the_background_under_it() {
        let mut g = grid(8, 1);
        fill(&mut g, 0.0, 0.0, 64.0, 16.0, (255, 255, 255, 255));
        fill(&mut g, 0.0, 0.0, 24.0, 16.0, (0, 128, 0, 255));
        text(&mut g, 0, 0, "abc");
        let ansi = g.render_ansi();
        assert!(
            ansi.contains("\x1b[48;2;0;128;0m"),
            "background lost under text"
        );
        assert!(ansi.contains('a'));
    }

    #[test]
    fn later_fills_win_because_the_list_is_in_paint_order() {
        let mut g = grid(6, 1);
        fill(&mut g, 0.0, 0.0, 48.0, 16.0, (255, 255, 255, 255));
        fill(&mut g, 0.0, 0.0, 24.0, 16.0, (10, 10, 10, 255));
        fill(&mut g, 0.0, 0.0, 24.0, 16.0, (20, 20, 20, 255));
        let ansi = g.render_ansi();
        assert!(ansi.contains("20;20;20"));
        assert!(!ansi.contains("10;10;10"));
    }

    #[test]
    fn a_row_erases_to_the_page_background_not_to_the_band() {
        let mut g = grid(10, 1);
        fill(&mut g, 0.0, 0.0, 80.0, 16.0, (255, 255, 255, 255));
        fill(&mut g, 40.0, 0.0, 80.0, 16.0, (0, 0, 255, 255));
        let ansi = g.render_ansi();
        let el = ansi.find("\x1b[K").expect("no erase-to-EOL");
        let before = &ansi[..el];
        let last = before.rfind("\x1b[48;2;").expect("no background set");
        assert!(
            before[last..].starts_with("\x1b[48;2;255;255;255m"),
            "row erased with the band's colour, not the page's"
        );
    }

    #[test]
    fn a_band_paints_its_blanks() {
        let mut g = grid(10, 1);
        fill(&mut g, 0.0, 0.0, 80.0, 16.0, (255, 255, 255, 255));
        text(&mut g, 0, 0, "hi");
        fill(&mut g, 0.0, 0.0, 64.0, 16.0, (0, 0, 255, 255));
        let ansi = g.render_ansi();
        let row = ansi.split("\r\n").next().unwrap();
        let painted = row.split("\x1b[K").next().unwrap();
        assert!(
            painted.matches(' ').count() >= 6,
            "band stopped at the text instead of covering its cells: {painted:?}"
        );
    }

    fn ul_spans(row: &str) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        let mut col = 0usize;
        let mut on: Option<usize> = None;
        let b = row.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if b[i] == 0x1b {
                let end = row[i..]
                    .find(|c: char| c.is_ascii_alphabetic())
                    .map(|k| i + k);
                let Some(e) = end else { break };
                let seq = &row[i..=e];
                if seq == "\x1b[4m" {
                    on = Some(col);
                } else if seq == "\x1b[24m" || seq == "\x1b[0m" {
                    if let Some(s) = on.take() {
                        out.push((s, col));
                    }
                }
                i = e + 1;
                continue;
            }
            col += 1;
            i += 1;
        }
        if let Some(s) = on {
            out.push((s, col));
        }
        out
    }

    #[test]
    fn a_rule_spans_its_block_not_just_the_text() {
        let mut g = grid(20, 1);
        text(&mut g, 8, 0, "hi");
        fill(&mut g, 0.0, 15.0, 160.0, 16.0, (0, 0, 0, 255));
        let ansi = g.render_ansi();
        let row = ansi.split("\r\n").next().unwrap();
        assert_eq!(ul_spans(row), vec![(0, 20)], "rule did not cover its span");
    }

    #[test]
    fn a_rule_stops_at_its_right_edge() {
        let mut g = grid(20, 1);
        text(&mut g, 0, 0, "hi");
        fill(&mut g, 0.0, 15.0, 32.0, 16.0, (0, 0, 0, 255));
        let ansi = g.render_ansi();
        let row = ansi.split("\r\n").next().unwrap();
        assert_eq!(ul_spans(row), vec![(0, 4)], "rule leaked past its edge");
    }

    #[test]
    fn a_rule_in_empty_space_still_draws() {
        let mut g = grid(10, 1);
        fill(&mut g, 0.0, 15.0, 80.0, 16.0, (0, 0, 0, 255));
        assert!(g.render_ansi().contains("\x1b[4m"));
    }

    #[test]
    fn underline_is_off_before_the_row_is_erased() {
        let mut g = grid(20, 1);
        fill(&mut g, 0.0, 15.0, 40.0, 16.0, (0, 0, 0, 255));
        let ansi = g.render_ansi();
        let el = ansi.find("\x1b[K").expect("no erase");
        let head = &ansi[..el];
        let last_on = head.rfind("\x1b[4m");
        let last_off = head.rfind("\x1b[24m").or_else(|| head.rfind("\x1b[0m"));
        assert!(
            last_off > last_on,
            "underline still on at erase-to-EOL: {head:?}"
        );
    }

    #[test]
    fn a_tall_fill_is_not_a_rule() {
        let mut g = grid(10, 2);
        fill(&mut g, 0.0, 0.0, 80.0, 16.0, (200, 200, 200, 255));
        assert!(!g.render_ansi().contains("\x1b[4m"));
    }

    #[test]
    fn a_rule_narrower_than_a_cell_is_ignored() {
        let mut g = grid(10, 1);
        fill(&mut g, 0.0, 15.0, 4.0, 16.0, (0, 0, 0, 255));
        assert!(!g.render_ansi().contains("\x1b[4m"));
    }

    #[test]
    fn bold_does_not_churn_across_blanks() {
        let mut g = grid(12, 1);
        g.on_text_run(
            1,
            CH,
            &[9995],
            ident(),
            (0, 0, 0, 255),
            0,
            ((0.8 * CH) * 8.0) as i16,
            b"ab",
            &[],
            0,
        );
        let ansi = g.render_ansi();
        assert_eq!(
            ansi.matches("\x1b[1m").count(),
            1,
            "bold re-emitted: {ansi:?}"
        );
    }

    #[test]
    fn a_rule_at_the_bottom_of_a_row_underlines_that_row() {
        let mut g = grid(6, 3);
        text(&mut g, 0, 1, "hi");
        fill(
            &mut g,
            0.0,
            2.0 * CH - 2.0,
            48.0,
            2.0 * CH - 1.0,
            (0, 0, 0, 255),
        );
        let ansi = g.render_ansi();
        let rows: Vec<&str> = ansi.split("\r\n").collect();
        assert!(
            rows[1].contains("\x1b[4m"),
            "underline not on the text's row"
        );
        assert!(
            !rows[2].contains("\x1b[4m"),
            "underline fell to the next row"
        );
    }

    #[test]
    fn a_rule_on_a_row_boundary_marks_the_row_above() {
        let mut g = grid(6, 3);
        fill(&mut g, 0.0, 2.0 * CH, 48.0, 2.0 * CH + 1.0, (0, 0, 0, 255));
        let ansi = g.render_ansi();
        let rows: Vec<&str> = ansi.split("\r\n").collect();
        assert!(
            rows[1].contains("\x1b[4m"),
            "border did not land on the row above"
        );
        assert!(!rows[2].contains("\x1b[4m"), "border drawn a cell too low");
    }

    #[test]
    fn a_rule_above_the_first_row_is_dropped() {
        let mut g = grid(6, 2);
        fill(&mut g, 0.0, 0.0, 48.0, 1.0, (0, 0, 0, 255));
        assert!(!g.render_ansi().contains("\x1b[4m"));
    }

    #[test]
    fn a_collapsed_table_rule_spans_a_multiline_row() {
        crate::set_tty_ua_css(
            "table { border-collapse: collapse; table-layout: fixed; width: 640px; } \
             td { border: 1px solid #a2a9b1; padding: 0; text-align: center; }"
                .to_string(),
        );
        crate::set_tty_cell_grid(CW, CH);
        let dom = crate::DomHandle::new(
            "<body style='margin:0'><table><tr><td>30 August<br>1980</td>\
             <td>Everton</td><td>H</td><td>4-0</td>\
             <td>Brazil,<br>Wark,<br>Butcher,<br>Mariner</td><td>20,879</td></tr>\
             <tr><td>6 September<br>1980</td><td>Aston Villa</td><td>H</td>\
             <td>1-0</td><td>Thijssen</td><td>23,192</td></tr></table></body>",
            "https://test.example/",
        );
        dom.set_viewport(640, 160);
        dom.resolve_layout();
        let scene = dom.render_scene(0, 0, 0, 0, false, true);
        crate::set_tty_ua_css(String::new());
        crate::set_tty_cell_grid(0.0, 0.0);

        let mut grid = decode_grid(&scene, 80, 10, CW, CH).expect("scene did not decode");
        grid.apply_rules();
        let next_row = (0..grid.rows)
            .find(|&row| {
                grid.cells[row * grid.cols..(row + 1) * grid.cols]
                    .iter()
                    .map(|cell| cell.ch)
                    .collect::<String>()
                    .contains("September")
            })
            .expect("second table row did not render");
        let delimiter = &grid.cells[(next_row - 1) * grid.cols..next_row * grid.cols];
        assert!(
            delimiter.iter().all(|cell| cell.underline),
            "delimiter below the multiline row covered columns {:?}",
            delimiter
                .iter()
                .enumerate()
                .filter_map(|(col, cell)| cell.underline.then_some(col))
                .collect::<Vec<_>>()
        );
        assert!(
            delimiter
                .iter()
                .filter(|cell| cell.ch == ' ')
                .all(|cell| cell.fg == [162, 169, 177]),
            "blank border cells did not retain the painted border color"
        );
        let ansi = grid.render_ansi();
        let delimiter = ansi.split("\r\n").nth(next_row - 1).unwrap();
        assert!(
            delimiter.contains("\x1b[38;2;162;169;177m"),
            "blank border prefix inherited the terminal foreground: {delimiter:?}"
        );
    }

    #[test]
    fn an_inline_table_header_break_does_not_add_a_row() {
        crate::set_tty_ua_css(
            "body { margin: 0; } table { border-collapse: collapse; } \
             th { border: 1px solid; padding: 0; } \
             th br { display: inline-block; width: 8px; height: 0; }"
                .to_string(),
        );
        crate::set_tty_cell_grid(CW, CH);
        let dom = crate::DomHandle::new(
            "<body><table><tr><th>Result<br>F-A</th></tr></table></body>",
            "https://test.example/",
        );
        dom.set_viewport(160, 64);
        dom.resolve_layout();
        let scene = dom.render_scene(0, 0, 0, 0, false, true);
        crate::set_tty_ua_css(String::new());
        crate::set_tty_cell_grid(0.0, 0.0);

        let grid = decode_grid(&scene, 20, 4, CW, CH).expect("scene did not decode");
        let text_rows = (0..grid.rows)
            .map(|row| {
                grid.cells[row * grid.cols..(row + 1) * grid.cols]
                    .iter()
                    .map(|cell| cell.ch)
                    .collect::<String>()
            })
            .filter(|row| row.contains("Result") || row.contains("F-A"))
            .collect::<Vec<_>>();
        assert_eq!(
            text_rows.len(),
            1,
            "header still occupied multiple rows: {text_rows:?}"
        );
        assert!(
            text_rows[0].contains("Result F-A"),
            "inline spacer missing: {text_rows:?}"
        );
    }

    fn marked(g: &mut TtyGrid, part: ScenePart, f: impl FnOnce(&mut TtyGrid)) {
        g.on_part_begin(1, part);
        f(g);
        g.on_part_end();
    }

    #[test]
    fn a_marked_border_is_a_rule_even_over_text() {
        let mut g = grid(10, 1);
        text(&mut g, 0, 0, "hello");
        marked(&mut g, ScenePart::Border, |g| {
            fill(g, 0.0, 15.0, 80.0, 16.0, (0, 0, 0, 255))
        });
        assert!(g.render_ansi().contains("\x1b[4m"));
    }

    #[test]
    fn a_marked_text_decoration_is_a_rule_over_blank_space() {
        let mut g = grid(10, 1);
        marked(&mut g, ScenePart::TextDecoration, |g| {
            fill(g, 0.0, 15.0, 80.0, 16.0, (0, 0, 0, 255))
        });
        assert!(g.render_ansi().contains("\x1b[4m"));
    }

    #[test]
    fn a_background_too_thin_for_a_cell_draws_as_a_rule() {
        let mut g = grid(10, 2);
        marked(&mut g, ScenePart::Background, |g| {
            fill(g, 0.0, 15.0, 80.0, 17.0, (0, 0, 255, 255))
        });
        assert!(
            g.render_ansi().contains("\x1b[4m"),
            "hairline background vanished"
        );
    }

    #[test]
    fn a_background_tall_enough_for_a_cell_is_a_band() {
        let mut g = grid(10, 2);
        marked(&mut g, ScenePart::Background, |g| {
            fill(g, 0.0, 0.0, 80.0, 16.0, (0, 0, 255, 255))
        });
        let ansi = g.render_ansi();
        assert!(ansi.contains("\x1b[48;2;0;0;255m"));
        assert!(!ansi.contains("\x1b[4m"), "band drawn as a rule");
    }

    #[test]
    fn sub_cell_space_between_backgrounds_does_not_expose_the_page() {
        let mut g = grid(3, 1);
        fill(&mut g, 0.0, 0.0, 24.0, 16.0, (255, 255, 255, 255));
        marked(&mut g, ScenePart::Background, |g| {
            fill(g, 0.0, 0.0, 11.5, 16.0, (200, 200, 200, 255))
        });
        marked(&mut g, ScenePart::Background, |g| {
            fill(g, 12.5, 0.0, 24.0, 16.0, (200, 200, 200, 255))
        });

        assert!(g.cells.iter().all(|cell| cell.bg == Some([200, 200, 200])));
    }

    #[test]
    fn adjacent_row_backgrounds_do_not_overlap() {
        let mut g = grid(1, 3);
        fill(&mut g, 0.0, 0.0, 8.0, 48.0, (255, 255, 255, 255));
        marked(&mut g, ScenePart::TableRowBackground, |g| {
            fill(g, 0.0, 0.0, 8.0, 24.0, (255, 200, 200, 255));
            fill(g, 0.0, 24.0, 8.0, 48.0, (200, 255, 200, 255));
        });

        assert_eq!(g.cells[0].bg, Some([255, 200, 200]));
        assert_eq!(g.cells[1].bg, Some([255, 200, 200]));
        assert_eq!(g.cells[2].bg, Some([200, 255, 200]));
    }

    #[test]
    fn a_rounded_table_gutter_belongs_to_the_preceding_row() {
        let mut g = grid(1, 4);
        fill(&mut g, 0.0, 0.0, 8.0, 64.0, (240, 240, 240, 255));
        marked(&mut g, ScenePart::TableRowBackground, |g| {
            fill(g, 0.0, 0.0, 8.0, 24.0, (255, 200, 200, 255));
            fill(g, 0.0, 40.0, 8.0, 64.0, (200, 255, 200, 255));
        });

        assert_eq!(g.cells[0].bg, Some([255, 200, 200]));
        assert_eq!(g.cells[1].bg, Some([255, 200, 200]));
        assert_eq!(g.cells[2].bg, Some([255, 200, 200]));
        assert_eq!(g.cells[3].bg, Some([200, 255, 200]));
    }

    #[test]
    fn a_marked_list_bullet_paints_no_band() {
        let mut g = grid(10, 1);
        marked(&mut g, ScenePart::Marker, |g| {
            fill(g, 0.0, 4.0, 8.0, 12.0, (0, 0, 0, 255))
        });
        let ansi = g.render_ansi();
        assert!(!ansi.contains("\x1b[4m"));
        assert!(!ansi.contains("\x1b[48;2;0;0;0m"));
    }

    #[test]
    fn an_unmarked_fill_still_uses_the_heuristics() {
        let mut g = grid(10, 1);
        fill(&mut g, 0.0, 15.0, 80.0, 16.0, (0, 0, 0, 255));
        assert!(g.render_ansi().contains("\x1b[4m"));
    }

    #[test]
    fn markers_nest_and_unwind() {
        let mut g = grid(10, 2);
        g.on_part_begin(1, ScenePart::Background);
        g.on_part_begin(2, ScenePart::Marker);
        fill(&mut g, 0.0, 0.0, 80.0, 16.0, (0, 0, 0, 255));
        g.on_part_end();
        fill(&mut g, 0.0, 16.0, 80.0, 32.0, (0, 128, 0, 255));
        g.on_part_end();
        let ansi = g.render_ansi();
        let rows: Vec<&str> = ansi.split("\r\n").collect();
        assert!(!rows[0].contains("48;2;0;0;0"), "bullet painted a band");
        assert!(rows[1].contains("\x1b[48;2;0;128;0m"), "outer marker lost");
    }

    #[test]
    fn an_unknown_marker_kind_falls_back_rather_than_dropping() {
        let mut g = grid(10, 1);
        marked(&mut g, ScenePart::Unknown, |g| {
            fill(g, 0.0, 15.0, 80.0, 16.0, (0, 0, 0, 255))
        });
        assert!(g.render_ansi().contains("\x1b[4m"));
    }

    fn bare(s: &str) -> String {
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

    fn control(part: ScenePart, w: f32, h: f32) -> String {
        let mut g = grid(20, 3);
        marked(&mut g, part, |g| {
            fill(g, 40.0, 17.0, 40.0 + w, 17.0 + h, (0, 0, 0, 255))
        });
        g.render_ansi()
    }

    #[test]
    fn a_checkbox_shows_its_state() {
        let on = control(ScenePart::Checkbox { checked: true }, 16.0, 16.0);
        let off = control(ScenePart::Checkbox { checked: false }, 16.0, 16.0);
        assert!(
            bare(&on).contains(CHECKBOX_ON),
            "checked box: {:?}",
            bare(&on)
        );
        assert!(
            bare(&off).contains(CHECKBOX_OFF),
            "unchecked box: {:?}",
            bare(&off)
        );
    }

    #[test]
    fn a_radio_is_round_so_it_reads_apart_from_a_checkbox() {
        let on = control(ScenePart::Radio { checked: true }, 16.0, 16.0);
        let off = control(ScenePart::Radio { checked: false }, 16.0, 16.0);
        assert!(bare(&on).contains(RADIO_ON));
        assert!(bare(&off).contains(RADIO_OFF));
    }

    #[test]
    fn a_control_is_exactly_one_cell() {
        use unicode_width::UnicodeWidthChar;
        for g in [CHECKBOX_ON, CHECKBOX_OFF, RADIO_ON, RADIO_OFF] {
            assert_eq!(
                UnicodeWidthChar::width(g),
                Some(1),
                "{g:?} is not one column"
            );
        }
        let s = bare(&control(ScenePart::Checkbox { checked: true }, 16.0, 16.0));
        let row = s.lines().find(|l| l.contains(CHECKBOX_ON)).unwrap();
        assert_eq!(row.matches(CHECKBOX_ON).count(), 1);
    }

    #[test]
    fn a_control_is_not_also_drawn_as_a_rule_or_a_band() {
        let a = control(ScenePart::Checkbox { checked: false }, 16.0, 2.0);
        assert!(!a.contains("\x1b[4m"), "thin checkbox became a rule");
        let b = control(ScenePart::Checkbox { checked: true }, 16.0, 16.0);
        assert!(
            !b.contains("\x1b[48;2;0;0;0m"),
            "checkbox became a background band"
        );
    }

    #[test]
    fn a_control_lands_on_the_row_it_is_painted_over() {
        let mut g = grid(20, 3);
        marked(&mut g, ScenePart::Checkbox { checked: true }, |g| {
            fill(g, 40.0, 20.0, 56.0, 28.0, (0, 0, 0, 255))
        });
        let ansi = g.render_ansi();
        let rows: Vec<&str> = ansi.split("\x1b[K\x1b[0m\r\n").collect();
        let which = rows.iter().position(|r| r.contains(CHECKBOX_ON));
        assert_eq!(which, Some(1), "control drawn on the wrong row");
    }

    #[test]
    fn a_control_narrower_than_a_cell_still_shows_its_state() {
        let s = bare(&control(ScenePart::Checkbox { checked: true }, 6.0, 16.0));
        assert!(
            s.contains(CHECKBOX_ON),
            "state lost on a narrow control: {s:?}"
        );
    }

    #[test]
    fn a_control_is_placed_by_its_bottom_edge() {
        let mut g = grid(20, 4);
        marked(&mut g, ScenePart::Checkbox { checked: true }, |g| {
            fill(g, 40.0, 12.0, 56.0, 20.0, (0, 0, 0, 255))
        });
        let ansi = g.render_ansi();
        let rows: Vec<&str> = ansi.split("\x1b[K\x1b[0m\r\n").collect();
        assert_eq!(
            rows.iter().position(|r| r.contains(CHECKBOX_ON)),
            Some(1),
            "control drawn a row above its line"
        );
    }

    #[test]
    fn a_control_off_the_grid_does_not_panic() {
        let mut g = grid(4, 2);
        marked(&mut g, ScenePart::Radio { checked: true }, |g| {
            fill(g, -50.0, -50.0, -30.0, -30.0, (0, 0, 0, 255))
        });
        marked(&mut g, ScenePart::Radio { checked: true }, |g| {
            fill(g, 9000.0, 9000.0, 9020.0, 9020.0, (0, 0, 0, 255))
        });
        let _ = g.render_ansi();
    }

    fn img_fill(g: &mut TtyGrid, hash: u64, x0: f32, y0: f32, x1: f32, y1: f32) {
        g.on_fill(
            DecodedFillRule::NonZero,
            ident(),
            None,
            DecodedPaint::Image { content_hash: hash },
            &rect(x0, y0, x1, y1),
        );
    }

    fn solid(w: u32, h: u32, px: [u8; 4]) -> Rc<GridImage> {
        let rgba: Vec<u8> = px
            .iter()
            .copied()
            .cycle()
            .take((w * h * 4) as usize)
            .collect();
        Rc::new(GridImage {
            width: w,
            height: h,
            rgba: peniko::Blob::from(rgba),
        })
    }

    #[test]
    fn wire_dimensions_are_bounded_before_the_grid_allocates() {
        assert!(grid_dims_ok(80, 24, 8.0, 17.0));
        assert!(grid_dims_ok(1, 1, 1.0, 1.0));
        assert!(grid_dims_ok(
            MAX_GRID_COLS,
            MAX_GRID_ROWS,
            MAX_CELL_PX,
            MAX_CELL_PX
        ));
        assert!(!grid_dims_ok(0, 24, 8.0, 17.0));
        assert!(!grid_dims_ok(80, 0, 8.0, 17.0));
        assert!(!grid_dims_ok(80, 24, 0.0, 17.0));
        assert!(!grid_dims_ok(70_000, 70_000, 8.0, 17.0));
        assert!(!grid_dims_ok(MAX_GRID_COLS + 1, 1, 8.0, 17.0));
        assert!(!grid_dims_ok(1, MAX_GRID_ROWS + 1, 8.0, 17.0));
        assert!(!grid_dims_ok(80, 24, 100_000.0, 17.0));
        assert!(!grid_dims_ok(80, 24, 8.0, f32::NAN));
        assert!(!grid_dims_ok(80, 24, f32::INFINITY, 17.0));
        assert!(!grid_dims_ok(80, 24, -8.0, 17.0));
    }

    #[test]
    fn a_missing_image_is_marked_rather_than_dropped() {
        let mut g = grid(6, 3);
        g.set_image_mode(ImageMode::Halfblocks);
        img_fill(&mut g, 42, 0.0, 0.0, 24.0, 32.0);
        assert_eq!(g.images_missing, 1, "the miss must be counted");
        assert!(
            g.render_ansi().contains('\u{2591}'),
            "a miss should still show the box"
        );
    }

    #[test]
    fn marking_never_overwrites_text() {
        let mut g = grid(8, 2);
        g.on_text_run(
            0,
            16.0,
            &[],
            ident(),
            (0, 0, 0, 255),
            0,
            (12.8_f32 * 8.0) as i16,
            b"hi",
            &[],
            0,
        );
        g.set_image_mode(ImageMode::Halfblocks);
        img_fill(&mut g, 1, 0.0, 0.0, 64.0, 16.0);
        let out = g.render_ansi();
        assert!(
            out.contains('h') && out.contains('i'),
            "text survives: {out:?}"
        );
    }

    #[test]
    fn halfblocks_draw_pixels_not_a_marker() {
        let mut g = grid(6, 3);
        g.set_image_mode(ImageMode::Halfblocks);
        let mut m = HashMap::new();
        m.insert(9u64, solid(8, 8, [200, 40, 40, 255]));
        g.set_images(m);
        img_fill(&mut g, 9, 0.0, 0.0, 24.0, 32.0);
        assert_eq!(g.images_placed, 1);
        assert_eq!(g.images_missing, 0);
        let out = g.render_ansi();
        assert!(!out.contains('\u{2591}'), "pixels, not a placeholder");
        assert!(out.contains("200;40;40"), "the image's colour should show");
    }

    #[test]
    fn halfblocks_letterbox_keeps_text_underneath() {
        let mut g = grid(8, 1);
        g.on_text_run(
            0,
            16.0,
            &[],
            ident(),
            (0, 0, 0, 255),
            (48.0_f32 * 8.0) as i16,
            (12.8_f32 * 8.0) as i16,
            b"hi",
            &[],
            0,
        );
        g.set_image_mode(ImageMode::Halfblocks);
        let mut m = HashMap::new();
        m.insert(9u64, solid(8, 8, [200, 40, 40, 255]));
        g.set_images(m);
        img_fill(&mut g, 9, 0.0, 0.0, 64.0, 16.0);
        assert_eq!(g.images_placed, 1);
        let out = g.render_ansi();
        assert!(
            out.contains("200;40;40"),
            "the picture itself is drawn: {out:?}"
        );
        assert!(
            out.contains('h') && out.contains('i'),
            "letterbox must not erase text: {out:?}"
        );
    }

    #[test]
    fn kitty_mode_records_a_placement_instead_of_drawing() {
        let mut g = grid(6, 3);
        g.set_image_mode(ImageMode::Kitty);
        let mut m = HashMap::new();
        m.insert(9u64, solid(8, 8, [10, 20, 30, 255]));
        g.set_images(m);
        img_fill(&mut g, 9, 0.0, 0.0, 24.0, 32.0);
        assert_eq!(g.images_placed, 1);
        assert_eq!(g.placements.len(), 1, "the front-end has nothing to place");
        let p = &g.placements[0];
        assert_eq!((p.col, p.row, p.cols, p.rows), (0, 0, 3, 2));
        assert!(
            p.png().unwrap().starts_with(&[0x89, b'P', b'N', b'G']),
            "not a PNG"
        );
        let out = g.render_ansi();
        assert!(!out.contains("10;20;30"), "drew the image itself");
        assert!(!out.contains('\u{2591}'), "placed images need no marker");
    }

    #[test]
    fn a_placement_key_names_exactly_what_its_png_depends_on() {
        let key = |y0: f32, w: f32| {
            let mut g = grid(12, 6);
            g.set_image_mode(ImageMode::Kitty);
            let mut m = HashMap::new();
            m.insert(9u64, solid(8, 8, [10, 20, 30, 255]));
            g.set_images(m);
            img_fill(&mut g, 9, 0.0, y0, w, y0 + 32.0);
            g.placements[0].key.clone()
        };
        assert_eq!(key(0.0, 24.0), key(16.0, 24.0));
        assert_ne!(key(0.0, 24.0), key(0.0, 48.0));
        assert_ne!(key(0.0, 24.0), key(-16.0, 24.0));
    }

    #[test]
    fn kitty_mode_still_marks_an_image_it_has_no_bytes_for() {
        let mut g = grid(6, 3);
        g.set_image_mode(ImageMode::Kitty);
        img_fill(&mut g, 5, 0.0, 0.0, 24.0, 32.0);
        assert!(g.placements.is_empty());
        assert_eq!(g.images_missing, 1);
        assert!(g.render_ansi().contains('\u{2591}'));
    }

    fn red_over_blue() -> Rc<GridImage> {
        let rgba: Vec<u8> = (0..64)
            .flat_map(|i| {
                if i < 32 {
                    [255, 0, 0, 255]
                } else {
                    [0, 0, 255, 255]
                }
            })
            .collect();
        Rc::new(GridImage {
            width: 8,
            height: 8,
            rgba: peniko::Blob::from(rgba),
        })
    }

    #[test]
    fn visible_span_is_the_part_on_screen() {
        assert_eq!(visible_span(8, 0.0, 3.0, 0.0, 3.0), (0, 8));
        assert_eq!(visible_span(8, -2.0, 2.0, 0.0, 2.0), (4, 4));
        assert_eq!(visible_span(100, 0.0, 8.0, 0.0, 2.0), (0, 25));
        assert_eq!(visible_span(2, -100.0, 1.0, 0.0, 1.0), (1, 1));
        assert_eq!(visible_span(8, f32::NEG_INFINITY, 3.0, 0.0, 3.0), (0, 8));
    }

    #[test]
    fn kitty_crops_an_image_cut_off_at_the_top() {
        let mut g = grid(6, 3);
        g.set_image_mode(ImageMode::Kitty);
        let mut m = HashMap::new();
        m.insert(9u64, red_over_blue());
        g.set_images(m);
        img_fill(&mut g, 9, 0.0, -32.0, 24.0, 32.0);
        let png = image::load_from_memory(&g.placements[0].png().unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!((png.width(), png.height()), (24, 32));
        assert_eq!(
            png.get_pixel(0, 0).0,
            [0, 0, 255, 255],
            "top of the placement"
        );
        assert_eq!(
            png.get_pixel(23, 31).0,
            [0, 0, 255, 255],
            "bottom of the placement"
        );
    }

    #[test]
    fn halfblocks_crops_an_image_cut_off_at_the_top() {
        let mut g = grid(2, 2);
        g.set_image_mode(ImageMode::Halfblocks);
        let mut m = HashMap::new();
        m.insert(9u64, red_over_blue());
        g.set_images(m);
        img_fill(&mut g, 9, 0.0, -16.0, 16.0, 16.0);
        assert_eq!(g.images_placed, 1);
        let out = g.render_ansi();
        assert!(
            out.contains("0;0;255"),
            "the visible half is drawn: {out:?}"
        );
        assert!(
            !out.contains("255;0;0"),
            "the half off screen is not: {out:?}"
        );
    }

    #[test]
    fn kitty_placement_is_capped_before_resize() {
        assert!(grid_dims_ok(200, 80, 64.0, 64.0));
        let mut g = TtyGrid::new(200, 80, 64.0, 64.0);
        g.set_image_mode(ImageMode::Kitty);
        let mut m = HashMap::new();
        m.insert(9u64, solid(8, 8, [10, 20, 30, 255]));
        g.set_images(m);
        img_fill(&mut g, 9, 0.0, 0.0, 12800.0, 5120.0);
        assert!(g.placements.is_empty());
        assert_eq!(g.images_missing, 1);
        assert!(g.render_ansi().contains('\u{2591}'), "refused, so marked");
    }

    #[test]
    fn png_at_falls_back_past_the_resize_budget() {
        let img = solid(8000, 2, [10, 20, 30, 255]);
        let (w, h) = (200, 400);
        assert!(8000 * u64::from(h) * 16 > MAX_RESIZE_BYTES);
        let png = png_at(&img, (0, 0, 8000, 2), w, h).expect("a PNG");
        let out = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!((out.width(), out.height()), (w, h));
        assert_eq!(out.get_pixel(100, 200).0, [10, 20, 30, 255]);
    }
}
