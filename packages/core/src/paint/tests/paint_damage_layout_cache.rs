// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use taffy::{AvailableSpace, LayoutInput, LayoutOutput, Line, RequestedAxis, RunMode, SizingMode, Size};

use crate::DomHandle;

const PAGE: &str = r#"<!DOCTYPE html>
<html><head><style>
  body { margin: 0; font: 16px/1.2 monospace; }
  #g { display: grid; grid-template-columns: repeat(4, auto); }
</style></head><body>
<div id="g">
  <div>one</div><div>two</div><div>three</div>
  <div><span id="dot" style="display:inline-block; transform: translate(0px); opacity: .3">x</span></div>
</div>
</body></html>"#;

const PLANTED: LayoutInput = LayoutInput {
    run_mode: RunMode::ComputeSize,
    sizing_mode: SizingMode::InherentSize,
    axis: RequestedAxis::Both,
    known_dimensions: Size {
        width: Some(12345.0),
        height: None,
    },
    known_dimensions_are_definite: Size {
        width: true,
        height: true,
    },
    parent_size: Size::NONE,
    available_space: Size {
        width: AvailableSpace::MaxContent,
        height: AvailableSpace::MaxContent,
    },
    vertical_margins_are_collapsible: Line::FALSE,
};

fn setup() -> (DomHandle, u32, u32) {
    let dom = DomHandle::new(PAGE, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.doc.borrow_mut().as_mut().set_incremental_layout(true);
    dom.resolve_layout();
    let grid = dom.query_selector("#g").unwrap() as u32;
    let dot = dom.query_selector("#dot").unwrap() as u32;
    let mut doc = dom.doc.borrow_mut();
    let node = doc
        .as_mut()
        .get_node_mut(crate::blitz_node_id(grid))
        .unwrap();
    node.cache_mut().store(
        &PLANTED,
        LayoutOutput::from_outer_size(Size {
            width: 7.0,
            height: 7.0,
        }),
    );
    drop(doc);
    (dom, grid, dot)
}

fn planted_survives(dom: &DomHandle, grid: u32) -> bool {
    let mut doc = dom.doc.borrow_mut();
    let node = doc
        .as_mut()
        .get_node_mut(crate::blitz_node_id(grid))
        .unwrap();
    let hit = node.cache_mut().get(&PLANTED).is_some();
    drop(doc);
    hit
}

#[test]
fn transform_and_opacity_keep_the_grid_cache() {
    let (dom, grid, dot) = setup();
    dom.set_attribute(
        dot,
        "style",
        "display:inline-block; transform: translate(3px, 2px); opacity: .6",
    );
    dom.resolve_layout();
    assert!(
        planted_survives(&dom, grid),
        "paint-only damage cleared the grid's layout cache"
    );
}

#[test]
fn width_change_clears_the_grid_cache() {
    let (dom, grid, dot) = setup();
    dom.set_attribute(dot, "style", "display:inline-block; width: 90px");
    dom.resolve_layout();
    assert!(
        !planted_survives(&dom, grid),
        "relayout damage kept a stale grid cache"
    );
}
