// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Scrollable overflow uses a box's transformed border box rather than its
// pre-transform layout box per CSS Overflow 3 §2.2.
// https://drafts.csswg.org/css-overflow-3/#scrollable

use crate::DomHandle;

#[test]
fn centered_translatex_abspos_does_not_inflate_document_scroll_width() {
    let html = r#"<!doctype html><html><head><style>
      body { margin: 0; }
      #bg {
        position: absolute;
        left: 50%;
        top: 0;
        width: 1220px;
        height: 200px;
        transform: translateX(-50%);
      }
    </style></head><body><div id="bg"></div></body></html>"#;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(1280, 900);
    dom.resolve_layout();

    let root_id = dom.query_selector("html").expect("html") as u32;
    let info = dom.read_scroll_info(root_id).expect("root scroll info");
    assert!(
        info.scroll_width < 1.0,
        "centered translateX(-50%) box must not inflate document scroll_width; got {}",
        info.scroll_width
    );
}

#[test]
fn positive_translatex_contributes_to_scroll_width() {
    let html = r#"<!doctype html><html><head><style>
      body { margin: 0; }
      #scroller { width: 200px; height: 100px; overflow: auto; position: relative; }
      #shifted { width: 100px; height: 40px; transform: translateX(250px); }
    </style></head><body><div id="scroller"><div id="shifted"></div></div></body></html>"#;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let scroller_id = dom.query_selector("#scroller").expect("#scroller") as u32;
    let info = dom.read_scroll_info(scroller_id).expect("scroller info");
    // Box sits at x=250..350 inside a 200px container -> 150px excess scroll_width.
    assert!(
        (info.scroll_width - 150.0).abs() <= 2.0,
        "translateX(250px) 100px box in 200px container should have ~150px scroll_width; got {}",
        info.scroll_width
    );
}

#[test]
fn transformed_child_inside_overflow_hidden_does_not_leak_to_document() {
    let html = r#"<!doctype html><html><head><style>
      body { margin: 0; }
      #clip { width: 300px; height: 100px; overflow: hidden; }
      #wide { width: 200px; height: 40px; transform: translateX(1000px); }
    </style></head><body><div id="clip"><div id="wide"></div></div></body></html>"#;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let root_id = dom.query_selector("html").expect("html") as u32;
    let info = dom.read_scroll_info(root_id).expect("root scroll info");
    assert!(
        info.scroll_width < 1.0,
        "overflow:hidden must prevent transformed descendant from inflating document scroll_width; got {}",
        info.scroll_width
    );
}

#[test]
fn body_overflow_propagated_to_viewport_does_not_clip_document_scroll_height() {
    let html = r#"<!doctype html><html><head><style>
      html, body { margin: 0; height: 100%; }
      body { overflow-x: hidden; }
      #tall { height: 3000px; }
      #shifted { width: 40px; height: 40px; transform: translateX(10px); }
    </style></head><body><div id="shifted"></div><div id="tall"></div></body></html>"#;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();

    let root_id = dom.query_selector("html").expect("html") as u32;
    let info = dom.read_scroll_info(root_id).expect("root scroll info");
    assert!(
        (info.scroll_height - 2440.0).abs() <= 2.0,
        "body with overflow-x:hidden propagated to viewport must keep root scroll_height 2440; got {}",
        info.scroll_height
    );
}

#[test]
fn transformed_inline_block_preserves_inline_root_text_overflow() {
    let text = "a".repeat(80);
    let make_html = |transform: &str| {
        format!(
            r#"<!doctype html><html><head><style>
              body {{ margin: 0; font-family: sans-serif; font-size: 16px; }}
              #scroller {{ width: 200px; overflow-x: auto; white-space: nowrap; }}
              #icon {{ display: inline-block; width: 10px; height: 10px; {transform} }}
            </style></head><body><div id="scroller"><span id="icon"></span> {text}</div></body></html>"#
        )
    };
    let measure = |transform: &str| {
        let dom = DomHandle::new(&make_html(transform), "https://test.example/");
        dom.set_viewport(800, 600);
        dom.resolve_layout();
        let scroller_id = dom.query_selector("#scroller").expect("#scroller") as u32;
        dom.read_scroll_info(scroller_id)
            .expect("scroller info")
            .scroll_width
    };
    let without_transform = measure("");
    let with_transform = measure("transform: rotate(1deg);");
    assert!(
        without_transform > 200.0,
        "expected substantial text overflow without transform; got {without_transform}"
    );
    assert!(
        (with_transform - without_transform).abs() <= 4.0,
        "transformed inline-block must keep inline root text overflow ({without_transform}); got {with_transform}"
    );
}

fn scroll_size(html: &str, viewport: (u32, u32), selector: &str) -> (f64, f64) {
    let dom = DomHandle::new(html, "https://test.example/");
    dom.set_viewport(viewport.0, viewport.1);
    dom.resolve_layout();
    let id = dom.query_selector(selector).expect(selector) as u32;
    let info = dom.read_scroll_info(id).expect("scroll info");
    (info.scroll_width, info.scroll_height)
}

// `contain: layout` and `contain: paint` (and their `content`/`strict`
// shorthands) confine a box's scrollable overflow to its border box, exactly as
// Taffy scores it. A transform anywhere else must not reintroduce the confined
// child's overflow into the document.
#[test]
fn containment_keeps_overflowing_child_out_of_document_scroll() {
    for contain in ["paint", "layout", "content", "strict"] {
        let html = format!(
            r#"<!doctype html><html><head><style>
              body {{ margin: 0; }}
              #box {{ width: 100px; height: 100px; contain: {contain}; }}
              #wide {{ width: 3000px; height: 5000px; }}
              #shifted {{ width: 10px; height: 10px; transform: translateX(1px); }}
            </style></head><body><div id="box"><div id="wide"></div></div><div id="shifted"></div></body></html>"#
        );
        let (width, height) = scroll_size(&html, (800, 600), "html");
        assert!(
            width < 1.0 && height < 1.0,
            "contain: {contain} must keep the 3000x5000 child out of document scroll; got ({width}, {height})"
        );
    }
}

#[test]
fn without_containment_an_overflowing_child_still_widens_the_document() {
    // Negative control: the containment cases only pass because containment
    // clips, not because the fixture never overflows.
    let html = r#"<!doctype html><html><head><style>
      body { margin: 0; }
      #box { width: 100px; height: 100px; contain: none; }
      #wide { width: 3000px; height: 5000px; }
      #shifted { width: 10px; height: 10px; transform: translateX(1px); }
    </style></head><body><div id="box"><div id="wide"></div></div><div id="shifted"></div></body></html>"#;
    let (width, height) = scroll_size(html, (800, 600), "html");
    assert!(
        width >= 2200.0 && height >= 4400.0,
        "contain: none must let the 3000x5000 child widen the document; got ({width}, {height})"
    );
}

fn padded_scroller_size(transform: &str, padding: &str) -> (f64, f64) {
    let html = format!(
        r#"<!doctype html><html><head><style>
          body {{ margin: 0; }}
          #scroller {{ width: 200px; height: 100px; overflow: auto; padding: {padding}; }}
          #child {{ width: 400px; height: 300px; }}
          #shifted {{ width: 10px; height: 10px; transform: {transform}; }}
        </style></head><body><div id="scroller"><div id="child"></div><div id="shifted"></div></div></body></html>"#
    );
    scroll_size(&html, (800, 600), "#scroller")
}

// A scroll container's end padding is part of its scrollable overflow region,
// so the custom transform walk must add it to the child extents.
#[test]
fn scroll_container_end_padding_survives_a_transformed_child() {
    for transform in ["translateX(1px)", "rotate(1deg)"] {
        let padded = padded_scroller_size(transform, "0 30px 20px 0");
        let unpadded = padded_scroller_size(transform, "0");
        assert!(
            padded.0 >= 200.0,
            "{transform}: expected the 400px child's 200px horizontal overflow; got {}",
            padded.0
        );
        assert!(
            padded.1 >= 210.0,
            "{transform}: expected the 300px child's overflow plus end padding; got {}",
            padded.1
        );
        // Negative control: end padding must not shrink the scroll size below
        // the unpadded scroller's. Dropping the end-padding term would report
        // 170/190 here because the padding also widens the padding box.
        assert!(
            padded.0 >= unpadded.0 - 1.0 && padded.1 >= unpadded.1 - 1.0,
            "{transform}: end padding must not shrink scroll size ({unpadded:?} -> {padded:?})"
        );
    }
}

// Taffy measures horizontal scroll from the inline-start scroll origin and
// mirrors it for RTL. The transform walk must keep that mirroring instead of
// reading only the physical right edge.
#[test]
fn rtl_scroller_keeps_left_overflow_with_a_transformed_sibling() {
    let html = r#"<!doctype html><html><head><style>
      body { margin: 0; }
      #scroller { width: 200px; height: 100px; overflow: auto; direction: rtl; }
      #child { width: 600px; height: 40px; }
      #shifted { width: 10px; height: 10px; transform: translateX(1px); }
    </style></head><body><div id="scroller"><div id="child"></div><div id="shifted"></div></div></body></html>"#;
    let (width, _) = scroll_size(html, (800, 600), "#scroller");
    assert!(
        (width - 400.0).abs() <= 2.0,
        "RTL scroller with a 600px child must keep ~400px scroll_width; got {width}"
    );
}

#[test]
fn rtl_document_keeps_left_overflow_with_a_transformed_sibling() {
    let html = r#"<!doctype html><html dir="rtl"><head><style>
      body { margin: 0; }
      #child { width: 2000px; height: 40px; }
      #shifted { width: 10px; height: 10px; transform: translateX(1px); }
    </style></head><body><div id="child"></div><div id="shifted"></div></body></html>"#;
    let (width, _) = scroll_size(html, (800, 600), "html");
    assert!(
        (width - 1200.0).abs() <= 2.0,
        "RTL document with a 2000px child must keep ~1200px scroll_width; got {width}"
    );
}

#[test]
fn ltr_counterparts_keep_the_same_overflow() {
    // Negative controls for the RTL cases: the same content laid out LTR must
    // report the same reachable overflow.
    let scroller = r#"<!doctype html><html><head><style>
      body { margin: 0; }
      #scroller { width: 200px; height: 100px; overflow: auto; }
      #child { width: 600px; height: 40px; }
      #shifted { width: 10px; height: 10px; transform: translateX(1px); }
    </style></head><body><div id="scroller"><div id="child"></div><div id="shifted"></div></div></body></html>"#;
    let (width, _) = scroll_size(scroller, (800, 600), "#scroller");
    assert!(
        (width - 400.0).abs() <= 2.0,
        "LTR scroller with a 600px child must keep ~400px scroll_width; got {width}"
    );

    let document = r#"<!doctype html><html><head><style>
      body { margin: 0; }
      #child { width: 2000px; height: 40px; }
      #shifted { width: 10px; height: 10px; transform: translateX(1px); }
    </style></head><body><div id="child"></div><div id="shifted"></div></body></html>"#;
    let (width, _) = scroll_size(document, (800, 600), "html");
    assert!(
        (width - 1200.0).abs() <= 2.0,
        "LTR document with a 2000px child must keep ~1200px scroll_width; got {width}"
    );
}
