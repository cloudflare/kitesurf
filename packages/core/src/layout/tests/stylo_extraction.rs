// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

#[test]
fn inline_li_with_display_inline_should_not_emit_fragment() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
ul.filters { display: flex; list-style: none; }
ul.filters li { display: inline; }
ul.filters li a {
  padding: 3px 7px;
  border: 1px solid transparent;
  border-radius: 3px;
  text-decoration: none;
  color: inherit;
}
ul.filters li a.selected {
  border-color: rgba(175, 47, 47, 0.2);
}
</style></head>
<body>
<footer>
  <span class="todo-count">1 item left!</span>
  <ul class="filters">
    <li><a class="selected" href="#/">All</a></li>
    <li><a href="#/active">Active</a></li>
    <li><a href="#/completed">Completed</a></li>
  </ul>
</footer>
</body></html>"##;

    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();

    let report = dom.debug_dump_inline_layouts();

    eprintln!("=== inline-layout report ===\n{}", report);

    let fragments: Vec<&str> = report
        .lines()
        .filter(|line| line.contains("frag:"))
        .collect();
    assert!(
        fragments.iter().all(|line| line.ends_with("<a>")),
        "every fragment should belong to an anchor:\n{}",
        fragments.join("\n"),
    );
    assert_eq!(
        fragments.len(),
        3,
        "expected one fragment per anchor; got {}:\n{}",
        fragments.len(),
        report
    );

    for line in fragments {
        let width = line
            .split_once("width=")
            .expect("fragment has width")
            .1
            .split_once(',')
            .expect("fragment width separator")
            .0
            .parse::<f32>()
            .expect("fragment width is numeric");
        assert!(width < 200.0, "fragment too wide ({} px): {}", width, line);
    }
}

#[test]
fn todomvc_footer_centers_filter_pills_inline() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 550px; }
.footer {
  border-top: 1px solid #e6e6e6;
  font-size: 15px;
  height: 20px;
  padding: 10px 15px;
  text-align: center;
  position: relative;
}
.todo-count { float: left; }
.filters {
  left: 0;
  list-style: none;
  margin: 0;
  padding: 0;
  position: absolute;
  right: 0;
}
.filters li { display: inline; }
.filters li a {
  border: 1px solid transparent;
  border-radius: 3px;
  margin: 3px;
  padding: 3px 7px;
  text-decoration: none;
}
.filters li a.selected { border-color: #ce4646; }
.clear-completed { float: right; }
</style></head>
<body>
<footer class="footer">
  <span class="todo-count"><strong>1</strong> item left!</span>
  <ul class="filters">
    <li><a class="selected" href="#/">All</a></li>
    <li><a href="#/active">Active</a></li>
    <li><a href="#/completed">Completed</a></li>
  </ul>
  <button class="clear-completed">Clear completed</button>
</footer>
</body></html>"##;

    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let report = dom.debug_dump_inline_layouts();
    eprintln!(
        "=== todomvc_footer_centers_filter_pills_inline report ===\n{}",
        report
    );

    let pill_lines: Vec<&str> = report
        .lines()
        .skip_while(|line| !(line.contains("<ul>") && line.contains("3 fragment(s)")))
        .take(4)
        .collect();
    assert!(
        pill_lines.len() >= 4,
        "expected to find an inline-root with 3 fragments; report:\n{}",
        report
    );

    let header = pill_lines[0];
    eprintln!("pill-host header: {}", header);

    let frag0 = pill_lines[1];
    let frag2 = pill_lines[3];

    fn extract(line: &str, key: &str) -> f32 {
        let after = line.split_once(key).expect("reported coordinate").1;
        let num = after
            .trim_start()
            .split(|c: char| !c.is_ascii_digit() && c != '.' && c != '-')
            .next()
            .expect("coordinate value");
        num.parse().expect("coordinate is numeric")
    }
    let x0_start = extract(frag0, "x_start=");
    let x2_end = extract(frag2, "x_end=");
    let total_pill_span = x2_end - x0_start;

    eprintln!(
        "pill #0 starts at x={}, pill #2 ends at x={}, span={}",
        x0_start, x2_end, total_pill_span
    );

    let host_width = {
        let after = header.split_once("@ (").expect("layout position").1;
        let after = after.split_once(") ").expect("layout size").1;
        let w = after.split_once('x').expect("layout width").0;
        w.parse::<f32>().expect("layout width is numeric")
    };
    eprintln!("host inline-root width: {}", host_width);

    let expected_left_padding = (host_width - total_pill_span) / 2.0;

    let offsets = dom.debug_dump_line_offsets();
    eprintln!("=== line offsets ===\n{}", offsets);

    let ul_offset_line = offsets
        .lines()
        .find(|line| line.contains("<ul>"))
        .expect("line offsets include the filter list");
    let ul_offset = extract(ul_offset_line, "offset=");
    eprintln!(
        "ul line offset = {}, expected ≈ {}",
        ul_offset, expected_left_padding
    );

    assert!(
        (ul_offset - expected_left_padding).abs() < 10.0,
        "<ul.filters> line should have offset ≈ {} for center alignment; got {}. \
         Combined with the first fragment's x_start, the painter renders the first \
         pill at x={} when it should be at x≈{}.",
        expected_left_padding,
        ul_offset,
        x0_start + ul_offset,
        expected_left_padding
    );
}

#[test]
fn pill_selected_border_color_is_uniform_across_all_edges() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
.filters li a {
  border: 1px solid transparent;
  border-radius: 3px;
  margin: 3px;
  padding: 3px 7px;
  text-decoration: none;
}
.filters li a.selected { border-color: #ce4646; }
</style></head>
<body>
<ul class="filters">
  <li><a class="selected" href="#/">All</a></li>
</ul>
</body></html>"##;

    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let report = dom.debug_dump_inline_layouts();

    let a_node_id: u32 = report
        .lines()
        .find(|l| l.contains("style_node_id=") && l.contains("<a>"))
        .and_then(|l| {
            let after = l.split("style_node_id=").nth(1)?;
            let num = after.split_whitespace().next()?;
            num.parse().ok()
        })
        .expect("should find an <a> fragment");

    let colors = dom.debug_dump_border_colors(a_node_id);
    eprintln!("=== border colors ===\n{}", colors);

    fn extract_components(line: &str) -> Option<(f32, f32, f32)> {
        let after = line.split("ColorComponents(").nth(1)?;
        let inside = after.split(')').next()?;
        let mut parts = inside.split(',').map(str::trim);
        let r = parts.next()?.parse().ok()?;
        let g = parts.next()?.parse().ok()?;
        let b = parts.next()?.parse().ok()?;
        Some((r, g, b))
    }
    let mut comps: Vec<(f32, f32, f32)> = Vec::new();
    for line in colors.lines() {
        if line.trim_start().starts_with("top")
            || line.trim_start().starts_with("right")
            || line.trim_start().starts_with("bottom")
            || line.trim_start().starts_with("left")
        {
            if let Some(c) = extract_components(line) {
                comps.push(c);
            }
        }
    }
    assert_eq!(
        comps.len(),
        4,
        "should have parsed 4 edge colors; got {:?}",
        comps
    );
    let (r0, g0, b0) = comps[0];
    for (i, c) in comps.iter().enumerate() {
        assert!(
            (c.0 - r0).abs() < 0.01 && (c.1 - g0).abs() < 0.01 && (c.2 - b0).abs() < 0.01,
            "edge {}'s color {:?} differs from edge 0's {:?}",
            i,
            c,
            comps[0]
        );
    }
    assert!(
        (r0 - 0.808).abs() < 0.01 && (g0 - 0.275).abs() < 0.02 && (b0 - 0.275).abs() < 0.02,
        "expected red (#ce4646 ≈ 0.808,0.275,0.275); got {:?}",
        comps[0]
    );
}

#[test]
fn block_label_does_not_extract_padding_into_inline_decorations() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
li label {
  display: block;
  padding: 15px 15px 15px 60px;
}
</style></head>
<body>
<ul><li><label>milk</label></li></ul>
</body></html>"##;

    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let report = dom.debug_dump_inline_layouts();
    eprintln!("=== block-label-padding report ===\n{}", report);

    let label_fragments: Vec<&str> = report
        .lines()
        .filter(|l| l.contains("<label>") && l.contains("fragment(s)"))
        .collect();
    let label_with_frag: Vec<&str> = label_fragments
        .iter()
        .copied()
        .filter(|l| !l.contains("0 fragment(s)"))
        .collect();
    assert!(
        label_with_frag.is_empty(),
        "<label> with display:block should not emit any fragment for itself; \
         got these label-with-fragment lines:\n{}\nFull report:\n{}",
        label_with_frag.join("\n"),
        report
    );
}

#[test]
fn float_in_first_sibling_does_not_leak_into_second_sibling_inline_layout() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { margin: 0 auto; max-width: 550px; }
.todoapp { margin: 130px 0 40px; background: #fff; min-height: 166px; }
.todoapp .footer { height: 20px; padding: 10px 15px; }
.todoapp .todo-count { float: left; width: 72px; }
.info { margin: 65px auto 0; text-align: center; font-size: 11px; }
.info p { line-height: 1; }
</style></head>
<body>
<section class="todoapp">
  <div class="footer">
    <span class="todo-count">1 item left!</span>
  </div>
</section>
<footer class="info">
  <p>Double-click to edit a todo</p>
  <p>Created by the TodoMVC Team</p>
  <p>Part of TodoMVC</p>
</footer>
</body></html>"##;

    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let report = dom.debug_dump_line_offsets();
    eprintln!("=== float-leak line offsets ===\n{}", report);

    let p_lines: Vec<&str> = report
        .lines()
        .filter(|l| l.contains("<p>") && l.contains("line#"))
        .collect();
    assert!(
        p_lines.len() >= 3,
        "expected at least 3 <p> lines (the three .info paragraphs); got {}:\n{}",
        p_lines.len(),
        report
    );
    for line in &p_lines {
        let key = "inline_min_coord=";
        let start = line.find(key).expect("malformed dump line") + key.len();
        let rest = &line[start..];
        let end = rest.find(',').unwrap_or(rest.len());
        let val: f32 = rest[..end].trim().parse().expect("parse inline_min_coord");
        assert!(
            val.abs() < 0.5,
            "expected inline_min_coord==0 (no float exclusion) for {}; got {}.\n\
             A non-zero value means a float in a previous body-child leaked \
             across the BFC and pushed this paragraph's line-x to the right.\n\
             Full report:\n{}",
            line,
            val,
            report
        );
    }
}

#[test]
fn list_item_li_does_not_emit_fragment() {
    let html = r##"<!DOCTYPE html>
<html><head><style>
* { margin: 0; padding: 0; }
ul.filters li a {
  padding: 3px 7px;
  border: 1px solid red;
}
</style></head>
<body>
<ul class="filters">
  <li><a href="#/">All</a></li>
</ul>
</body></html>"##;

    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let report = dom.debug_dump_inline_layouts();
    eprintln!("=== list-item-li report ===\n{}", report);

    let frag_count = report.matches("frag:").count();
    assert!(
        frag_count >= 1,
        "expected at least one fragment for the <a>; got {}: report:\n{}",
        frag_count,
        report
    );
}
