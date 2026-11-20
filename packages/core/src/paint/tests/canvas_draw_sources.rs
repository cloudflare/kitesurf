// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

#![cfg(test)]

use crate::DomHandle;

fn red(width: u32, height: u32) -> Vec<u8> {
    [255, 0, 0, 255].repeat((width * height) as usize)
}

fn draw(dom: &DomHandle, canvas: u32, source: u32) -> Vec<u8> {
    let ops = format!(
        r#"[{{"o":"resize","a":[2,1]}},{{"o":"drawImage","s":"img","id":{source},"oc":true,"a":[0,0,2,1,0,0,2,1]}}]"#
    );
    dom.canvas_apply_ops(canvas, &ops);
    dom.canvas_get_image_data(canvas, 0, 0, 1, 1)
}

#[test]
fn a_canvas_does_not_draw_an_iframe_framebuffer() {
    let dom = DomHandle::new(
        "<!doctype html><iframe width=2 height=1></iframe><canvas width=2 height=1></canvas>",
        "https://page.test/",
    );
    let iframe = dom.query_selector("iframe").unwrap() as u32;
    let canvas = dom.query_selector("canvas").unwrap() as u32;
    assert_eq!(dom.set_iframe_image(iframe, 2, 1, &red(2, 1)), 1);
    assert_eq!(draw(&dom, canvas, iframe), vec![0, 0, 0, 0]);
}

#[test]
fn a_canvas_still_draws_another_canvas() {
    let dom = DomHandle::new(
        "<!doctype html><canvas id=a width=2 height=1></canvas><canvas id=b width=2 height=1></canvas>",
        "https://page.test/",
    );
    let a = dom.query_selector("#a").unwrap() as u32;
    let b = dom.query_selector("#b").unwrap() as u32;
    dom.canvas_apply_ops(a, r#"[{"o":"resize","a":[2,1]},{"o":"fillStyle","g":{"k":"color","c":"red"}},{"o":"fillRect","a":[0,0,2,1]}]"#);
    let ops = format!(
        r#"[{{"o":"resize","a":[2,1]}},{{"o":"drawImage","s":"canvas","id":{a},"a":[0,0,2,1,0,0,2,1]}}]"#
    );
    dom.canvas_apply_ops(b, &ops);
    assert_eq!(
        dom.canvas_get_image_data(b, 0, 0, 1, 1),
        vec![255, 0, 0, 255]
    );
}
