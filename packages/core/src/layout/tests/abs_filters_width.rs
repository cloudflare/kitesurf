// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

const HTML: &str = r##"<!DOCTYPE html>
<html><head><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 800px; margin: 0 auto; }
.todoapp {
  position: relative;
  width: 550px;
  margin: 130px auto 40px;
  background: #fff;
}
.new-todo {
  border: none;
  box-sizing: border-box;
  font-size: 24px;
  height: 65px;
  padding: 16px 16px 16px 60px;
  width: 100%;
}
.toggle-all-container {
  visibility: hidden;
}
.todo-list { list-style: none; margin: 0; padding: 0; }
.todo-list li { font-size: 24px; padding: 15px 60px; }
.footer {
  border-top: 1px solid #ccc;
  font-size: 15px;
  height: 50px;  /* matches angular's overridden height */
  padding: 10px 15px;
  text-align: center;
}
.footer::before {
  content: "";
  position: absolute;
  right: 0; bottom: 0; left: 0;
  height: 50px;
  overflow: hidden;
}
.todo-count { float: left; text-align: left; }
.filters {
  position: absolute;
  left: 0; right: 0;
  list-style: none;
  margin: 0; padding: 0;
}
.filters li { display: inline; }
.filters li a {
  border: 1px solid transparent;
  border-radius: 3px;
  color: inherit;
  margin: 3px;
  padding: 3px 7px;
  text-decoration: none;
}
</style></head>
<body>
<app-root>
<section class="todoapp">
  <app-todo-header>
    <header class="header">
      <h1>Todos</h1>
      <input autofocus placeholder="What needs to be done?" class="new-todo ng-untouched ng-valid ng-dirty" value="milk">
    </header>
  </app-todo-header>
  <app-todo-list>
    <main class="main">
      <div class="toggle-all-container">
        <input type="checkbox" class="toggle-all">
        <label htmlfor="toggle-all" class="toggle-all-label">Toggle All Input</label>
      </div>
      <ul class="todo-list">
        <app-todo-item>
          <li>
            <div class="view">
              <input type="checkbox" class="toggle">
              <label>milk</label>
              <button class="destroy"></button>
            </div>
          </li>
        </app-todo-item>
      </ul>
    </main>
  </app-todo-list>
  <app-todo-footer>
    <footer class="footer">
      <span class="todo-count"><strong>1</strong> item left</span>
      <ul class="filters">
        <li><a class="selected" href="#/">All</a></li>
        <li><a href="#/active">Active</a></li>
        <li><a href="#/completed">Completed</a></li>
      </ul>
    </footer>
  </app-todo-footer>
</section>
</app-root>
</body></html>"##;

#[test]
fn filters_stretches_in_real_angular_snapshot() {
    let html = include_str!("../../../tests_data/angular_snapshot.html");
    let dom = DomHandle::new(html, "https://todomvc.com/examples/angular/dist/browser/");
    dom.resolve_layout();

    let filters_id = dom.query_selector("ul.filters").expect("query parses");
    assert!(filters_id > 0, "ul.filters must exist");
    let dump = dom.debug_dump_node_layout(filters_id as u32);
    eprintln!("filters layout: {}", dump);
    let width = parse_width(&dump).expect("parse width");
    eprintln!("filters width: {}", width);

    assert!(
        width >= 500.0,
        "expected .filters to span containing block in real Angular markup; got w={}",
        width,
    );
}

#[test]
fn filters_stretches_to_containing_block_through_custom_element() {
    let dom = DomHandle::new(HTML, "https://test.example/");
    dom.resolve_layout();

    let filters_id = dom.query_selector("ul.filters").expect("query parses");
    assert!(filters_id > 0);
    let filters_id = filters_id as u32;

    let dump = dom.debug_dump_node_layout(filters_id);
    eprintln!("filters layout: {}", dump);

    let width = parse_width(&dump).expect("parse width");
    eprintln!("filters width: {}", width);

    assert!(
        width >= 500.0,
        "expected .filters width to span containing block (>= 500); got {}",
        width,
    );
}

fn parse_width(dump: &str) -> Option<f32> {
    let line = dump.lines().next()?;
    let size_part = line.split("size=").nth(1)?;
    let size_token = size_part.split(',').next()?.trim();
    let (w_str, _h_str) = size_token.split_once('x')?;
    w_str.trim().parse().ok()
}
