// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const HTML: &str = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 800px; }
.footer {
  border-top: 1px solid #ccc;
  height: 41px;
  padding: 10px 15px;
  position: relative;
}
.todo-count { float: left; }
.filters {
  position: absolute;
  left: 0; right: 0;
  list-style: none;
}
.filters li { display: inline; }
.clear-completed {
  float: right;
  cursor: pointer;
}
</style></head>
<body>
<footer class="footer">
  <span class="todo-count">0 items left</span>
  <ul class="filters">
    <li><a href="#/">All</a></li>
    <li><a href="#/active">Active</a></li>
    <li><a href="#/completed">Completed</a></li>
  </ul>
  <button class="clear-completed">Clear Completed</button>
  <!-- trailing comment from Angular's @if else-slot -->
</footer>
</body></html>"##;

const HTML_NO_TRAILING_COMMENT: &str = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 800px; }
.footer {
  border-top: 1px solid #ccc;
  height: 41px;
  padding: 10px 15px;
  position: relative;
}
.todo-count { float: left; }
.filters {
  position: absolute;
  left: 0; right: 0;
  list-style: none;
}
.filters li { display: inline; }
.clear-completed {
  float: right;
  cursor: pointer;
}
</style></head>
<body>
<footer class="footer"><span class="todo-count">0 items left</span><ul class="filters"><li><a href="#/">All</a></li><li><a href="#/active">Active</a></li><li><a href="#/completed">Completed</a></li></ul><button class="clear-completed">Clear Completed</button></footer>
</body></html>"##;

fn count_button_filters_y(dom: &DomHandle) -> (f32, f32, f32) {
    let count_id = dom.query_selector("span.todo-count").unwrap() as u32;
    let btn_id = dom.query_selector("button.clear-completed").unwrap() as u32;
    let filters_id = dom.query_selector("ul.filters").unwrap() as u32;

    let parse_y = |dump: &str| -> f32 {
        let line = dump.lines().next().unwrap();
        let abs = line.split("absolute=(").nth(1).unwrap();
        let inner = abs.split(')').next().unwrap();
        let y_str = inner.split_once(',').unwrap().1.trim();
        y_str.parse().unwrap()
    };

    let dump_count = dom.debug_dump_node_layout(count_id);
    let dump_btn = dom.debug_dump_node_layout(btn_id);
    let dump_filters = dom.debug_dump_node_layout(filters_id);
    eprintln!("count: {}", dump_count.lines().next().unwrap());
    eprintln!("button: {}", dump_btn.lines().next().unwrap());
    eprintln!("filters: {}", dump_filters.lines().next().unwrap());

    (
        parse_y(&dump_count),
        parse_y(&dump_btn),
        parse_y(&dump_filters),
    )
}

#[test]
fn baseline_no_trailing_comment_aligns_floats_with_abs() {
    let dom = DomHandle::new(HTML_NO_TRAILING_COMMENT, "https://test.example/");
    dom.resolve_layout();
    let (count_y, btn_y, filters_y) = count_button_filters_y(&dom);
    let max_delta = (count_y - filters_y).abs().max((btn_y - filters_y).abs());
    assert!(
        max_delta < 2.0,
        "without trailing comment, count/button/filters should share y; \
         got count_y={} btn_y={} filters_y={} (max delta {})",
        count_y,
        btn_y,
        filters_y,
        max_delta,
    );
}

#[test]
fn trailing_comment_does_not_shift_floats() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    dom.resolve_layout();
    let (count_y, btn_y, filters_y) = count_button_filters_y(&dom);
    let max_delta = (count_y - filters_y).abs().max((btn_y - filters_y).abs());
    assert!(
        max_delta < 2.0,
        "trailing comment in footer must NOT shift floats vs abs: \
         count_y={} btn_y={} filters_y={} (max delta {}). \
         Likely cause: blitz treats `<footer>` as inline-formatting-\
         context root because its trailing comment registers as an \
         inline child, baselining the float-anchored line box and \
         pushing the floats down by line-height - padding-top.",
        count_y,
        btn_y,
        filters_y,
        max_delta,
    );
}
