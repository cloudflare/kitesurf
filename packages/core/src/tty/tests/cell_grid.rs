// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const CW: f32 = 8.0;
const CH: f32 = 17.0;
type NodeRect = (f32, f32, f32, f32);
type GeomRow = (&'static str, NodeRect);

fn sheet(extra: &str) -> String {
    format!(
        "*, ::before, ::after {{ font-family: monospace !important; \
         font-size: 13.333px !important; line-height: {CH}px !important; }}\n{extra}"
    )
}

fn layout(html: &str, extra_css: &str, snap: bool) -> Geom {
    crate::set_tty_ua_css(sheet(extra_css));
    if snap {
        crate::set_tty_cell_grid(CW, CH);
    }
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(400, 200);
    dom.resolve_layout();
    let mut out = Geom { rows: Vec::new() };
    for sel in ["#a", "#b", "#c"] {
        let id = dom.query_selector(sel).unwrap();
        if id >= 0 {
            out.rows
                .push((sel, rect(&dom.debug_dump_node_layout(id as u32))));
        }
    }
    crate::set_tty_ua_css(String::new());
    crate::set_tty_cell_grid(0.0, 0.0);
    out
}

struct Geom {
    rows: Vec<GeomRow>,
}

impl Geom {
    fn get(&self, sel: &str) -> (f32, f32, f32, f32) {
        self.rows
            .iter()
            .find(|(s, _)| *s == sel)
            .unwrap_or_else(|| panic!("no {sel}"))
            .1
    }
}

fn rect(dump: &str) -> (f32, f32, f32, f32) {
    let num = |s: &str| -> f32 { s.trim().parse().unwrap() };
    let size = dump.split("size=").nth(1).unwrap();
    let w = num(size.split('x').next().unwrap());
    let h = num(size.split('x').nth(1).unwrap().split(',').next().unwrap());
    let abs = dump.split("absolute=(").nth(1).unwrap();
    let x = num(abs.split(',').next().unwrap());
    let y = num(abs.split(',').nth(1).unwrap().split(')').next().unwrap());
    (x, y, w, h)
}

fn inset(dump: &str, key: &str) -> (f32, f32) {
    let at = dump.split(key).nth(1).unwrap().trim_start_matches('(');
    let mut it = at.split(',');
    let l: f32 = it.next().unwrap().trim().parse().unwrap();
    let t: f32 = it.nth(1).unwrap().trim().parse().unwrap();
    (l, t)
}

fn on_grid(v: f32, step: f32) -> bool {
    (v / step - (v / step).round()).abs() < 1e-3
}

#[test]
fn author_boxes_land_on_cell_boundaries() {
    let html = "<body><p id=a>one</p><p id=b>two</p></body>";

    let loose = layout(html, "", false);
    let (_, ay, _, _) = loose.get("#a");
    let (_, by, _, _) = loose.get("#b");
    assert!(
        !on_grid(ay, CH) || !on_grid(by, CH),
        "nothing to fix: unsnapped paragraphs were already on the grid \
         (a={ay}, b={by}) — the test no longer reproduces the bug"
    );

    let snapped = layout(html, "", true);
    for sel in ["#a", "#b"] {
        let (x, y, _, h) = snapped.get(sel);
        assert!(on_grid(y, CH), "{sel} top off-grid: y={y} (row {})", y / CH);
        assert!(
            on_grid(x, CW),
            "{sel} left off-grid: x={x} (col {})",
            x / CW
        );
        assert!(on_grid(h, CH), "{sel} height off-grid: h={h}");
    }
}

#[test]
fn snapping_leaves_no_gap_between_stacked_boxes() {
    let html = "<body style='margin:0'>\
        <div id=a style='height:20px'></div>\
        <div id=b style='height:20px'></div>\
        <div id=c style='height:20px'></div></body>";
    let g = layout(html, "", true);
    let (_, ay, _, ah) = g.get("#a");
    let (_, by, _, bh) = g.get("#b");
    let (_, cy, _, _) = g.get("#c");
    assert_eq!(ay + ah, by, "gap or overlap between #a and #b");
    assert_eq!(by + bh, cy, "gap or overlap between #b and #c");
}

#[test]
fn a_hairline_border_survives_cell_snapping() {
    let html = "<body style='margin:0'>\
        <div id=a style='border:1px solid #000; height:40px'></div></body>";
    crate::set_tty_ua_css(sheet(""));
    crate::set_tty_cell_grid(CW, CH);
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(400, 200);
    dom.resolve_layout();
    let dump = dom.debug_dump_node_layout(dom.query_selector("#a").unwrap() as u32);
    crate::set_tty_ua_css(String::new());
    crate::set_tty_cell_grid(0.0, 0.0);

    let (_, y, _, h) = rect(&dump);
    assert!(
        on_grid(y, CH) && on_grid(h, CH),
        "box not snapped: y={y} h={h}\n{dump}"
    );
    assert!(
        dump.contains("border=(1.0,1.0,1.0,1.0)"),
        "the hairline border was rounded away by cell snapping:\n{dump}"
    );
}

#[test]
fn the_content_origin_lands_on_the_grid_too() {
    let html = "<body style='margin:0'>\
        <div id=a style='padding:6px 0 0 5px'>text</div></body>";
    crate::set_tty_ua_css(sheet(""));
    crate::set_tty_cell_grid(CW, CH);
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(400, 200);
    dom.resolve_layout();
    let dump = dom.debug_dump_node_layout(dom.query_selector("#a").unwrap() as u32);
    crate::set_tty_ua_css(String::new());
    crate::set_tty_cell_grid(0.0, 0.0);

    let (x, y, _, _) = rect(&dump);
    let (bl, bt) = inset(&dump, "border=");
    let (pl, pt) = inset(&dump, "padding=");
    assert!(
        on_grid(x + bl + pl, CW),
        "content x off-grid: {}\n{dump}",
        x + bl + pl
    );
    assert!(
        on_grid(y + bt + pt, CH),
        "content y off-grid: {}\n{dump}",
        y + bt + pt
    );
}

#[test]
fn the_inset_snaps_without_eating_the_border() {
    let html = "<body style='margin:0'>\
        <div id=a style='border:1px solid #000; padding:6px'>text</div></body>";
    crate::set_tty_ua_css(sheet(""));
    crate::set_tty_cell_grid(CW, CH);
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(400, 200);
    dom.resolve_layout();
    let dump = dom.debug_dump_node_layout(dom.query_selector("#a").unwrap() as u32);
    crate::set_tty_ua_css(String::new());
    crate::set_tty_cell_grid(0.0, 0.0);

    let (x, y, _, _) = rect(&dump);
    let (bl, bt) = inset(&dump, "border=");
    let (pl, pt) = inset(&dump, "padding=");
    assert_eq!((bl, bt), (1.0, 1.0), "the border was rounded away:\n{dump}");
    assert!(on_grid(x + bl + pl, CW), "content x off-grid:\n{dump}");
    let off_by = ((y + bt + pt) / CH).fract() * CH;
    assert!(
        off_by <= bt,
        "content y is off-grid by {off_by}, more than the {bt}px border \
         that is allowed to cause it:\n{dump}"
    );
}

#[test]
fn lh_is_one_row_and_ch_is_one_column() {
    let html = "<body style='margin:0'><p id=a>one</p><p id=b>two</p></body>";
    let g = layout(html, "p { margin-block: 1lh !important; }", false);
    let (_, ay, _, _) = g.get("#a");
    let (_, by, _, _) = g.get("#b");
    assert_eq!(ay, CH, "1lh top margin should be exactly one row");
    assert_eq!(
        by - ay,
        CH * 2.0,
        "collapsed 1lh margins should stay whole rows"
    );

    let g = layout(
        "<body style='margin:0'><ul id=a><li id=b>x</li></ul></body>",
        "ul { padding-inline-start: 2ch !important; }",
        false,
    );
    let (ax, _, _, _) = g.get("#a");
    let (bx, _, _, _) = g.get("#b");
    assert_eq!(
        bx - ax,
        CW * 2.0,
        "2ch indent should be exactly two columns"
    );
}

#[test]
fn snapping_is_off_unless_asked_for() {
    let html = "<body><p id=a>one</p></body>";
    let (_, y, _, _) = layout(html, "", false).get("#a");
    assert!(
        !on_grid(y, CH),
        "expected the unsnapped, off-grid y; got {y}"
    );
}

#[test]
fn painted_text_origins_land_on_column_boundaries() {
    let html = "<body style='margin:0'>\
        <div style='padding-left:5px'>alpha</div>\
        <div style='padding-left:6px'>bravo</div>\
        <div style='padding-left:3px'><div style='padding-left:2px'>delta</div></div>\
        <div style='border-left:1px solid #000; padding-left:6px'>echo</div></body>";
    crate::set_tty_ua_css(sheet(""));
    crate::set_tty_cell_grid(CW, CH);
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(400, 200);
    dom.resolve_layout();
    let scene = dom.render_scene(0, 0, 0, 0, false, true);
    crate::set_tty_ua_css(String::new());
    crate::set_tty_cell_grid(0.0, 0.0);

    let runs = text_run_origins(&scene);
    assert!(runs.len() >= 3, "expected the three lines, got {runs:?}");
    let off: Vec<&(f32, f32, String)> = runs.iter().filter(|(x, _, _)| !on_grid(*x, CW)).collect();
    assert!(
        off.is_empty(),
        "these runs are painted off the column grid: {off:?} (all: {runs:?})"
    );
}

#[test]
fn text_flows_around_a_float_on_the_grid() {
    const FLOAT_W: f32 = 150.0;
    const WRAP_W: f32 = 301.0;
    let html = "<body style='margin:0'><div style='width:301px'>\
        <div id=a style='float:right; width:150px; height:400px'></div>\
        <p id=b>alpha bravo charlie delta echo foxtrot golf hotel india \
        juliett kilo lima mike november oscar papa quebec romeo</p>\
        </div></body>";
    crate::set_tty_ua_css(sheet("p { margin-block: 1lh !important; }"));
    crate::set_tty_cell_grid(CW, CH);
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(400, 600);
    dom.resolve_layout();
    let scene = dom.render_scene(0, 0, 0, 0, false, true);
    crate::set_tty_ua_css(String::new());
    crate::set_tty_cell_grid(0.0, 0.0);

    let limit = WRAP_W - FLOAT_W;
    let runs = text_run_origins(&scene);
    assert!(
        runs.len() >= 3,
        "expected the paragraph to wrap, got {runs:?}"
    );
    let over: Vec<(f32, &String)> = runs
        .iter()
        .map(|(x, _, t)| (x + t.trim_end().chars().count() as f32 * CW, t))
        .filter(|(right, _)| *right > limit + 0.5)
        .collect();
    assert!(
        over.is_empty(),
        "these runs cross into the float, which starts at x={limit}: \
         {over:?} (all: {runs:?})"
    );
}

#[test]
fn aria_expanded_paints_a_live_disclosure_marker() {
    // The margin needs a blockified marker: inline margins don't apply,
    // and blitz's UA sheet no longer makes buttons flex containers.
    let css = r#"
        button[aria-expanded] {
            align-items: center !important;
            display: inline-flex !important;
        }
        [aria-expanded="false"]::before {
            content: "\25b8" !important;
            margin-inline-end: 1ch !important;
        }
        [aria-expanded="true"]::before {
            content: "\25be" !important;
            margin-inline-end: 1ch !important;
        }
    "#;
    crate::set_tty_ua_css(sheet(css));
    crate::set_tty_cell_grid(CW, CH);
    let dom = DomHandle::new(
        "<body style='margin:0'><button id=a aria-expanded=false>History</button></body>",
        "https://test.example/",
    );
    dom.set_viewport(400, 200);
    dom.resolve_layout();

    let collapsed = text_run_origins(&dom.render_scene(0, 0, 0, 0, false, true));
    assert!(
        collapsed
            .iter()
            .any(|(_, _, text)| text.contains('\u{25b8}')),
        "{collapsed:?}"
    );
    assert!(
        !collapsed
            .iter()
            .any(|(_, _, text)| text.contains('\u{25be}')),
        "{collapsed:?}"
    );
    let marker_x = collapsed
        .iter()
        .find(|(_, _, text)| text.contains('\u{25b8}'))
        .unwrap()
        .0;
    let label_x = collapsed
        .iter()
        .find(|(_, _, text)| text.contains("History"))
        .unwrap()
        .0;
    assert_eq!(label_x - marker_x, CW * 2.0, "{collapsed:?}");

    let button = dom.query_selector("#a").unwrap() as u32;
    dom.set_attribute(button, "aria-expanded", "true");
    dom.resolve_layout();
    let expanded = text_run_origins(&dom.render_scene(0, 0, 0, 0, false, true));
    assert!(
        expanded
            .iter()
            .any(|(_, _, text)| text.contains('\u{25be}')),
        "{expanded:?}"
    );
    assert!(
        !expanded
            .iter()
            .any(|(_, _, text)| text.contains('\u{25b8}')),
        "{expanded:?}"
    );

    crate::set_tty_ua_css(String::new());
    crate::set_tty_cell_grid(0.0, 0.0);
}

#[test]
fn a_short_table_cell_is_centered_beside_three_lines() {
    let css = "table { border-spacing: 0; table-layout: fixed; width: 128px; } \
               td { padding: 0; vertical-align: middle; }";
    crate::set_tty_ua_css(sheet(css));
    crate::set_tty_cell_grid(CW, CH);
    let dom = DomHandle::new(
        "<body style='margin:0'><table><tr><td id=a>short</td>\
         <td id=b>top<br>middle<br>bottom</td></tr></table></body>",
        "https://test.example/",
    );
    dom.set_viewport(400, 200);
    dom.resolve_layout();
    let scene = dom.render_scene(0, 0, 0, 0, false, true);
    crate::set_tty_ua_css(String::new());
    crate::set_tty_cell_grid(0.0, 0.0);

    let runs = text_run_origins(&scene);
    let short_y = runs
        .iter()
        .find(|(_, _, text)| text.contains("short"))
        .unwrap()
        .1;
    let middle_y = runs
        .iter()
        .find(|(_, _, text)| text.contains("middle"))
        .unwrap()
        .1;
    assert_eq!(
        short_y, middle_y,
        "middle-aligned cell stayed at the row top: {runs:?}"
    );
}

#[test]
fn collapsed_table_borders_follow_the_snapped_cell_edges() {
    let css = "table { border-collapse: collapse; border: 1px solid rgb(255, 0, 0); \
                       table-layout: fixed; width: 257px; } \
               td { border: 1px solid rgb(255, 0, 0); height: 34px; padding: 0; }";
    crate::set_tty_ua_css(sheet(css));
    crate::set_tty_cell_grid(CW, CH);
    let dom = DomHandle::new(
        "<body style='margin:0'><div id=wrap style='margin-left:3px'><table>\
         <tr><td id=a></td><td id=b></td><td id=c></td></tr>\
         <tr><td id=d></td><td></td><td></td></tr>\
         <tr><td id=e></td><td></td><td></td></tr>\
         </table></div></body>",
        "https://test.example/",
    );
    dom.set_viewport(400, 200);
    dom.resolve_layout();

    let scene = dom.render_scene(0, 0, 0, 0, false, true);
    assert_table_borders_follow_edges(&dom, &scene);

    let wrapper = dom.query_selector("#wrap").unwrap() as u32;
    dom.set_attribute(wrapper, "style", "margin-left:0");
    dom.resolve_layout();
    let moved_scene = dom.render_scene(0, 0, 0, 0, false, true);
    assert_table_borders_follow_edges(&dom, &moved_scene);

    crate::set_tty_ua_css(String::new());
    crate::set_tty_cell_grid(0.0, 0.0);
}

fn assert_table_borders_follow_edges(dom: &DomHandle, scene: &[u8]) {
    let cell_edges: Vec<f32> = ["#b", "#c"]
        .into_iter()
        .map(|selector| {
            let id = dom.query_selector(selector).unwrap() as u32;
            rect(&dom.debug_dump_node_layout(id)).0
        })
        .collect();
    let row_edges: Vec<f32> = ["#d", "#e"]
        .into_iter()
        .map(|selector| {
            let id = dom.query_selector(selector).unwrap() as u32;
            rect(&dom.debug_dump_node_layout(id)).1
        })
        .collect();

    let vertical_borders: Vec<(f32, f32, f32, f32)> = solid_fill_bounds(scene, (255, 0, 0))
        .into_iter()
        .filter(|(x0, y0, x1, y1)| y1 - y0 > x1 - x0)
        .collect();
    for &edge in &cell_edges {
        assert!(on_grid(edge, CW), "cell edge is off-grid: x={edge}");
    }
    let missed_edges: Vec<f32> = cell_edges
        .into_iter()
        .filter(|edge| {
            !vertical_borders
                .iter()
                .any(|(x0, _, x1, _)| *x0 <= *edge && *edge <= *x1)
        })
        .collect();
    assert!(
        missed_edges.is_empty(),
        "collapsed borders miss snapped cell edges {missed_edges:?}; borders={vertical_borders:?}"
    );
    let horizontal_borders: Vec<(f32, f32, f32, f32)> = solid_fill_bounds(scene, (255, 0, 0))
        .into_iter()
        .filter(|(x0, y0, x1, y1)| x1 - x0 > y1 - y0)
        .collect();
    for &edge in &row_edges {
        assert!(on_grid(edge, CH), "row edge is off-grid: y={edge}");
    }
    let missed_edges: Vec<f32> = row_edges
        .into_iter()
        .filter(|edge| {
            !horizontal_borders
                .iter()
                .any(|(_, y0, _, y1)| *y0 <= *edge && *edge <= *y1)
        })
        .collect();
    assert!(
        missed_edges.is_empty(),
        "collapsed borders miss snapped row edges {missed_edges:?}; borders={horizontal_borders:?}"
    );
}

#[test]
fn collapsed_borders_survive_tracks_narrower_than_a_cell() {
    let css = "table { border-collapse: collapse; table-layout: fixed; width: 8px; } \
               td { border: 1px solid rgb(255, 0, 0); height: 17px; padding: 0; }";
    crate::set_tty_ua_css(sheet(css));
    crate::set_tty_cell_grid(CW, CH);
    let dom = DomHandle::new(
        "<body style='margin:0'><table><tr><td></td><td></td><td></td></tr></table></body>",
        "https://test.example/",
    );
    dom.set_viewport(400, 200);
    dom.resolve_layout();
    let scene = dom.render_scene(0, 0, 0, 0, false, true);
    crate::set_tty_ua_css(String::new());
    crate::set_tty_cell_grid(0.0, 0.0);

    let visible_vertical_borders = solid_fill_bounds(&scene, (255, 0, 0))
        .into_iter()
        .filter(|(x0, y0, x1, y1)| y1 - y0 > x1 - x0 && x1 - x0 > 0.5)
        .count();
    assert!(
        visible_vertical_borders >= 4,
        "two shared cell boundaries should each be painted from both cells; got {visible_vertical_borders}"
    );
}

#[test]
fn semantic_text_styles_reach_ansi() {
    crate::set_tty_ua_css(sheet(""));
    crate::set_tty_cell_grid(CW, CH);
    let dom = DomHandle::new(
        "<body style='margin:0'><strong>bold</strong> <em>italic</em> <u>under</u></body>",
        "https://test.example/",
    );
    dom.set_viewport(400, 200);
    dom.resolve_layout();

    let scene = dom.render_scene(0, 0, 0, 0, false, true);
    let ansi = crate::tty::grid::scene_to_ansi(&scene, 50, 4, CW, CH);
    assert!(
        ansi.contains("\x1b[1m"),
        "bold did not reach ANSI: {ansi:?}"
    );
    assert!(
        ansi.contains("\x1b[3m"),
        "italic did not reach ANSI: {ansi:?}"
    );
    assert!(
        ansi.contains("\x1b[4m"),
        "underline did not reach ANSI: {ansi:?}"
    );

    crate::set_tty_ua_css(String::new());
    crate::set_tty_cell_grid(0.0, 0.0);
}

fn text_run_origins(scene: &[u8]) -> Vec<(f32, f32, String)> {
    use crate::paint::scene_decode::{
        DecodedCap, DecodedFillRule, DecodedJoin, DecodedPaint, DecodedPathEl, DecodedTransform,
        SceneVisitor, decode,
    };

    #[derive(Default)]
    struct Runs(Vec<(f32, f32, String)>);

    impl SceneVisitor for Runs {
        fn on_text_run(
            &mut self,
            _font_id: u32,
            _font_size: f32,
            _coords: &[i16],
            t: DecodedTransform,
            _rgba: (u8, u8, u8, u8),
            start_x_q3: i16,
            start_y_q3: i16,
            text_utf8: &[u8],
            _kerns: &[(u16, i8)],
            _flags: u8,
        ) {
            let start_x = start_x_q3 as f32 / 8.0;
            let start_y = start_y_q3 as f32 / 8.0;
            let x = t.0[0] * start_x + t.0[2] * start_y + t.0[4];
            let y = t.0[1] * start_x + t.0[3] * start_y + t.0[5];
            let text = String::from_utf8_lossy(text_utf8).to_string();
            if !text.trim().is_empty() {
                self.0.push((x, y, text));
            }
        }
        fn on_push_layer(
            &mut self,
            _m: u8,
            _c: u8,
            _a: f32,
            _t: DecodedTransform,
            _p: &[DecodedPathEl],
        ) {
        }
        fn on_push_clip_layer(&mut self, _t: DecodedTransform, _p: &[DecodedPathEl]) {}
        fn on_pop_layer(&mut self) {}
        fn on_fill(
            &mut self,
            _r: DecodedFillRule,
            _t: DecodedTransform,
            _bt: Option<DecodedTransform>,
            _paint: DecodedPaint,
            _path: &[DecodedPathEl],
        ) {
        }
        #[allow(clippy::too_many_arguments)]
        fn on_stroke(
            &mut self,
            _w: f32,
            _m: f32,
            _c: DecodedCap,
            _j: DecodedJoin,
            _o: f32,
            _d: &[f32],
            _t: DecodedTransform,
            _bt: Option<DecodedTransform>,
            _paint: DecodedPaint,
            _path: &[DecodedPathEl],
        ) {
        }
        #[allow(clippy::too_many_arguments)]
        fn on_glyph_run(
            &mut self,
            _f: u32,
            _s: f32,
            _c: &[i16],
            _t: DecodedTransform,
            _p: DecodedPaint,
            _g: &[(u32, f32, f32)],
        ) {
        }
        #[allow(clippy::too_many_arguments)]
        fn on_box_shadow(
            &mut self,
            _t: DecodedTransform,
            _a: f32,
            _b: f32,
            _c: f32,
            _d: f32,
            _r: (u8, u8, u8, u8),
            _x: f32,
            _y: f32,
        ) {
        }
    }

    let mut v = Runs::default();
    decode(scene, &mut v).expect("decode");
    v.0
}

fn solid_fill_bounds(scene: &[u8], rgb: (u8, u8, u8)) -> Vec<(f32, f32, f32, f32)> {
    use crate::paint::scene_decode::{
        DecodedCap, DecodedFillRule, DecodedJoin, DecodedPaint, DecodedPathEl, DecodedTransform,
        SceneVisitor, decode,
    };

    struct Fills {
        rgb: (u8, u8, u8),
        bounds: Vec<(f32, f32, f32, f32)>,
    }

    impl SceneVisitor for Fills {
        fn on_text_run(
            &mut self,
            _font_id: u32,
            _font_size: f32,
            _coords: &[i16],
            _t: DecodedTransform,
            _rgba: (u8, u8, u8, u8),
            _start_x_q3: i16,
            _start_y_q3: i16,
            _text_utf8: &[u8],
            _kerns: &[(u16, i8)],
            _flags: u8,
        ) {
        }
        fn on_push_layer(
            &mut self,
            _m: u8,
            _c: u8,
            _a: f32,
            _t: DecodedTransform,
            _p: &[DecodedPathEl],
        ) {
        }
        fn on_push_clip_layer(&mut self, _t: DecodedTransform, _p: &[DecodedPathEl]) {}
        fn on_pop_layer(&mut self) {}
        fn on_fill(
            &mut self,
            _r: DecodedFillRule,
            t: DecodedTransform,
            _bt: Option<DecodedTransform>,
            paint: DecodedPaint,
            path: &[DecodedPathEl],
        ) {
            let DecodedPaint::Solid { r, g, b, a } = paint else {
                return;
            };
            if (r, g, b) != self.rgb || a == 0 {
                return;
            }

            let mut x0 = f32::MAX;
            let mut y0 = f32::MAX;
            let mut x1 = f32::MIN;
            let mut y1 = f32::MIN;
            let mut add = |x: f32, y: f32| {
                let [a, b, c, d, e, f] = t.0;
                let tx = a * x + c * y + e;
                let ty = b * x + d * y + f;
                x0 = x0.min(tx);
                y0 = y0.min(ty);
                x1 = x1.max(tx);
                y1 = y1.max(ty);
            };
            for el in path {
                match *el {
                    DecodedPathEl::Move { x, y } | DecodedPathEl::Line { x, y } => add(x, y),
                    DecodedPathEl::Quad { cx, cy, x, y } => {
                        add(cx, cy);
                        add(x, y);
                    }
                    DecodedPathEl::Curve {
                        c1x,
                        c1y,
                        c2x,
                        c2y,
                        x,
                        y,
                    } => {
                        add(c1x, c1y);
                        add(c2x, c2y);
                        add(x, y);
                    }
                    DecodedPathEl::Close => {}
                }
            }
            if x0 != f32::MAX {
                self.bounds.push((x0, y0, x1, y1));
            }
        }
        #[allow(clippy::too_many_arguments)]
        fn on_stroke(
            &mut self,
            _w: f32,
            _m: f32,
            _c: DecodedCap,
            _j: DecodedJoin,
            _o: f32,
            _d: &[f32],
            _t: DecodedTransform,
            _bt: Option<DecodedTransform>,
            _paint: DecodedPaint,
            _path: &[DecodedPathEl],
        ) {
        }
        #[allow(clippy::too_many_arguments)]
        fn on_glyph_run(
            &mut self,
            _f: u32,
            _s: f32,
            _c: &[i16],
            _t: DecodedTransform,
            _p: DecodedPaint,
            _g: &[(u32, f32, f32)],
        ) {
        }
        #[allow(clippy::too_many_arguments)]
        fn on_box_shadow(
            &mut self,
            _t: DecodedTransform,
            _a: f32,
            _b: f32,
            _c: f32,
            _d: f32,
            _r: (u8, u8, u8, u8),
            _x: f32,
            _y: f32,
        ) {
        }
    }

    let mut visitor = Fills {
        rgb,
        bounds: Vec::new(),
    };
    decode(scene, &mut visitor).expect("decode");
    visitor.bounds
}
