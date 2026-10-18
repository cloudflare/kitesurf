// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const FOOTER_HTML: &str = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 800px; }
footer.footer {
  position: relative;
  height: 40px;
  padding: 10px 15px;
  border-top: 1px solid #ccc;
}
.todo-count { float: left; }
.filters {
  position: absolute;
  left: 0; right: 0;
  list-style: none;
  text-align: center;
}
.filters li { display: inline; }
.filters li a { padding: 3px 7px; margin: 3px; }
.clear-completed {
  float: right;
  position: relative;
  cursor: pointer;
}
</style></head>
<body>
<footer class="footer">
  <span class="todo-count">1 item left!</span>
  <ul class="filters">
    <li><a href="#/">All</a></li>
    <li><a href="#/active">Active</a></li>
    <li><a href="#/completed">Completed</a></li>
  </ul>
  <button class="clear-completed">Clear completed</button>
</footer>
</body></html>"##;

#[test]
fn clear_completed_wins_over_filters_at_button_center() {
    let dom = DomHandle::new(FOOTER_HTML, "https://test.example/");
    dom.resolve_layout();

    let btn_id = dom
        .query_selector("button.clear-completed")
        .expect("query parses");
    assert!(btn_id > 0, "button.clear-completed must exist in test doc");
    let btn_id = btn_id as u32;

    let ul_id = dom.query_selector("ul.filters").expect("query parses");
    assert!(ul_id > 0, "ul.filters must exist in test doc");
    let ul_id = ul_id as u32;

    let dump = dom.debug_dump_node_layout(btn_id);
    eprintln!("button layout dump: {}", dump);
    let (x, y, w, h) = parse_absolute_box(&dump)
        .expect("debug_dump_node_layout output should match expected shape");
    eprintln!(
        "button bbox: x={} y={} w={} h={} (center=({}, {}))",
        x,
        y,
        w,
        h,
        x + w / 2.0,
        y + h / 2.0,
    );
    assert!(w > 0.0 && h > 0.0, "button must have non-zero box");

    let cx = x + w / 2.0;
    let cy = y + h / 2.0;
    let hit = dom.element_from_point(cx, cy);
    eprintln!(
        "hit-test ({}, {}) → node #{} (button=#{}, ul.filters=#{})",
        cx, cy, hit, btn_id, ul_id
    );

    let walk_to = |target: u32| -> bool {
        if hit < 0 {
            return false;
        }
        let mut cur = hit as u32;
        for _ in 0..16 {
            if cur == target {
                return true;
            }
            match dom.parent_id(cur) {
                p if p < 0 => return false,
                p => cur = p as u32,
            }
        }
        false
    };

    let hits_button = walk_to(btn_id);
    let hits_ul = walk_to(ul_id);

    assert!(
        hits_button && !hits_ul,
        "expected hit-test at button center to resolve to button #{} \
         (or descendant); resolved to node #{} \
         (hits_button={}, hits_ul.filters={}). \
         Likely cause: target/vendor-patched/blitz-dom-0.3.0-alpha.2/src/layout/damage.rs \
         `node_to_paint_order` ranks position:relative+float lower \
         than position:absolute, sorting `.clear-completed` before \
         `.filters` in paint_children, so .filters paints last and \
         wins the hit-test (line 957 of node/node.rs iterates \
         paint_children.rev()).",
        btn_id,
        hit,
        hits_button,
        hits_ul,
    );
}

fn parse_absolute_box(dump: &str) -> Option<(f32, f32, f32, f32)> {
    let line = dump.lines().next()?;
    let size_part = line.split("size=").nth(1)?;
    let size_token = size_part.split(',').next()?.trim();
    let (w_str, h_str) = size_token.split_once('x')?;
    let w: f32 = w_str.trim().parse().ok()?;
    let h: f32 = h_str.trim().parse().ok()?;
    let abs_part = line.split("absolute=(").nth(1)?;
    let abs_token = abs_part.split(')').next()?;
    let (x_str, y_str) = abs_token.split_once(',')?;
    let x: f32 = x_str.trim().parse().ok()?;
    let y: f32 = y_str.trim().parse().ok()?;
    Some((x, y, w, h))
}

const FOOTER_HTML_STATIC_FOOTER: &str = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 800px; }
.todoapp { position: relative; width: 550px; }
.main { height: 60px; }
footer.footer {
  height: 40px;
  padding: 10px 15px;
  border-top: 1px solid #ccc;
}
footer.footer:before {
  content: "";
  position: absolute;
  right: 0; bottom: 0; left: 0;
  height: 50px;
  overflow: hidden;
  box-shadow: 0 1px 1px rgba(0,0,0,0.2);
}
.todo-count { float: left; }
.filters {
  position: absolute;
  left: 0; right: 0; bottom: 10px;
  list-style: none;
  text-align: center;
}
.filters li { display: inline; }
.filters li a { padding: 3px 7px; margin: 3px; }
.clear-completed {
  float: right;
  position: relative;
  cursor: pointer;
}
</style></head>
<body>
<section class="todoapp">
  <div class="main"></div>
  <footer class="footer">
    <span class="todo-count">1 item left!</span>
    <ul class="filters">
      <li><a href="#/">All</a></li>
      <li><a href="#/active">Active</a></li>
      <li><a href="#/completed">Completed</a></li>
    </ul>
    <button class="clear-completed">Clear completed</button>
  </footer>
</section>
</body></html>"##;

#[test]
fn clear_completed_wins_when_footer_is_unpositioned() {
    let dom = DomHandle::new(FOOTER_HTML_STATIC_FOOTER, "https://test.example/");
    dom.resolve_layout();

    let btn_id = dom
        .query_selector("button.clear-completed")
        .expect("query parses");
    assert!(btn_id > 0, "button.clear-completed must exist in test doc");
    let btn_id = btn_id as u32;
    let ul_id = dom.query_selector("ul.filters").expect("query parses");
    assert!(ul_id > 0, "ul.filters must exist in test doc");
    let ul_id = ul_id as u32;

    let ul_dump = dom.debug_dump_node_layout(ul_id);
    eprintln!("ul.filters layout dump: {}", ul_dump);
    assert!(
        ul_dump.contains("position=Absolute"),
        "ul.filters must be abspos for this regression to apply: {}",
        ul_dump,
    );

    let dump = dom.debug_dump_node_layout(btn_id);
    eprintln!("button layout dump: {}", dump);
    let (x, y, w, h) = parse_absolute_box(&dump)
        .expect("debug_dump_node_layout output should match expected shape");
    assert!(w > 0.0 && h > 0.0, "button must have non-zero box");

    let cx = x + w / 2.0;
    let cy = y + h / 2.0;
    let hit = dom.element_from_point(cx, cy);
    eprintln!(
        "hit-test ({}, {}) → node #{} (button=#{}, ul.filters=#{})",
        cx, cy, hit, btn_id, ul_id
    );

    let walk_to = |target: u32| -> bool {
        if hit < 0 {
            return false;
        }
        let mut cur = hit as u32;
        for _ in 0..16 {
            if cur == target {
                return true;
            }
            match dom.parent_id(cur) {
                p if p < 0 => return false,
                p => cur = p as u32,
            }
        }
        false
    };

    assert!(
        walk_to(btn_id) && !walk_to(ul_id),
        "expected hit-test at button center to resolve to button #{}; \
         resolved to node #{}. The abspos .filters was re-anchored to \
         .todoapp for layout and must still paint at its DOM position \
         inside .footer (Node::paint_parent_override), otherwise it \
         paints above .clear-completed and eats the click.",
        btn_id,
        hit,
    );
}
