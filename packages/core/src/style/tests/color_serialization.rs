// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use style::context::QuirksMode;
use style::properties::PropertyId;
use style::properties::declaration_block::parse_style_attribute;
use style::stylesheets::{CssRuleType, UrlExtraData};
use style::values::resolved::Context;
use style_traits::ToCss as StyleToCss;

use crate::DomHandle;
use crate::style::cssom::init_style_prefs;

fn specified(property: &str, value: &str) -> String {
    init_style_prefs();
    let url = UrlExtraData::from(url::Url::parse("about:kitesurf-test").unwrap());
    let block = parse_style_attribute(
        &format!("{}: {}", property, value),
        &url,
        None,
        QuirksMode::NoQuirks,
        CssRuleType::Style,
    );
    let mut out = String::new();
    if let Some((decl, _)) = block.declaration_importance_iter().next() {
        if decl.to_css(&mut out).is_err() {
            return String::new();
        }
        return out;
    }
    String::new()
}

fn color(value: &str) -> String {
    specified("color", value)
}

fn computed_color(value: &str) -> String {
    use style::properties::PropertyDeclaration;
    init_style_prefs();
    let url = UrlExtraData::from(url::Url::parse("about:kitesurf-test").unwrap());
    let block = parse_style_attribute(
        &format!("color: {}", value),
        &url,
        None,
        QuirksMode::NoQuirks,
        CssRuleType::Style,
    );
    for (decl, _) in block.declaration_importance_iter() {
        if let PropertyDeclaration::Color(ref v) = *decl {
            let Ok(c) = v.0.to_computed_color(None) else {
                return String::new();
            };
            let mut out = String::new();
            if c.to_css(&mut style_traits::CssWriter::new(&mut out))
                .is_ok()
            {
                return out;
            }
        }
    }
    String::new()
}

fn cascade_computed_color(value: &str) -> String {
    use style::properties::LonghandId;
    init_style_prefs();
    let html = format!(
        r#"<!DOCTYPE html><html><body><div id="t" style="color: {}">x</div></body></html>"#,
        value
    );
    let dom = DomHandle::new(&html, "https://test.example/");
    dom.resolve_layout();
    let id = dom.query_selector("#t").unwrap();
    assert!(id >= 0, "#t not found");
    let doc = dom.doc.borrow();
    let node = doc.get_node(crate::blitz_node_id(id as u32)).unwrap();
    let styles = node.primary_styles().unwrap();
    let mut out = String::new();
    let mut ctx = Context {
        style: &styles,
        for_property: PropertyId::NonCustom(LonghandId::Color.into()),
        current_longhand: None,
    };
    styles
        .computed_or_resolved_value(LonghandId::Color, Some(&mut ctx), &mut out)
        .unwrap();
    out
}

#[test]
fn cascade_rgb_none_relative_carries_none() {
    assert_eq!(
        cascade_computed_color("rgb(from rgb(none none none) r g b)"),
        "color(srgb none none none)"
    );
    assert_eq!(
        cascade_computed_color("rgb(from rgb(20% none 60%) r g b)"),
        "color(srgb 0.2 none 0.6)"
    );
}

#[test]
fn cascade_direct_none_forms() {
    assert_eq!(
        cascade_computed_color("rgb(none none none)"),
        "color(srgb none none none)"
    );
    assert_eq!(
        cascade_computed_color("hsl(120 80% none)"),
        "hsl(120 80% none)"
    );
}

#[test]
fn cascade_cqw_resolves_against_container() {
    use style::properties::LonghandId;
    init_style_prefs();
    let html = r#"<!DOCTYPE html><html><body>
      <div style="container-type: inline-size; width: 1000px">
        <div id="t">x</div>
      </div></body></html>"#;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let id = dom.query_selector("#t").unwrap();
    assert!(id >= 0);
    dom.set_attribute(
        id as u32,
        "style",
        "color: hsla(calc(50deg + (sign(2cqw - 10px) * 10deg)), 100%, 37.5%, 52%)",
    );
    dom.resolve_layout();
    let doc = dom.doc.borrow();
    let node = doc.get_node(crate::blitz_node_id(id as u32)).unwrap();
    let styles = node.primary_styles().unwrap();
    let mut out = String::new();
    let mut ctx = Context {
        style: &styles,
        for_property: PropertyId::NonCustom(LonghandId::Color.into()),
        current_longhand: None,
    };
    styles
        .computed_or_resolved_value(LonghandId::Color, Some(&mut ctx), &mut out)
        .unwrap();
    assert_eq!(out, "rgba(191, 191, 0, 0.52)");
}

#[test]
fn p1_colormix_keeps_complement_percentage() {
    assert_eq!(
        color("color-mix(in hsl, red 60%, blue 40%)"),
        "color-mix(in hsl, red 60%, blue 40%)"
    );
    assert_eq!(
        color("color-mix(in hsl, hsl(120deg 10% 20%) 25%, hsl(30deg 30% 40%))"),
        "color-mix(in hsl, rgb(46, 56, 46) 25%, rgb(133, 102, 71) 75%)"
    );
    assert_eq!(
        color("color-mix(in hsl, hsl(120deg 10% 20%), 25% hsl(30deg 30% 40%))"),
        "color-mix(in hsl, rgb(46, 56, 46) 75%, rgb(133, 102, 71) 25%)"
    );
    assert_eq!(
        color("color-mix(in hsl, hsl(120deg 10% 20%) 0%, hsl(30deg 30% 40%))"),
        "color-mix(in hsl, rgb(46, 56, 46) 0%, rgb(133, 102, 71) 100%)"
    );
}

#[test]
fn p1_colormix_still_omits_double_50() {
    assert_eq!(
        color("color-mix(in hsl, red, blue)"),
        "color-mix(in hsl, red, blue)"
    );
    assert_eq!(
        color("color-mix(in hsl, red 50%, blue)"),
        "color-mix(in hsl, red, blue)"
    );
}

#[test]
fn p3_hsl_none_preserved() {
    assert_eq!(color("hsl(none none none)"), "hsl(none none none)");
    assert_eq!(
        color("hsl(none none none / none)"),
        "hsl(none none none / none)"
    );
    assert_eq!(color("hsl(120 none none)"), "hsl(120 none none)");
    assert_eq!(color("hsl(120 80% none)"), "hsl(120 80 none)");
    assert_eq!(color("hsl(120 none 50%)"), "hsl(120 none 50)");
    assert_eq!(color("hsl(120 100% 50% / none)"), "hsl(120 100 50 / none)");
    assert_eq!(color("hsl(none 100% 50%)"), "hsl(none 100 50)");
    assert_eq!(color("hsl(120 none 50 / 0.5)"), "hsl(120 none 50 / 0.5)");
}

#[test]
fn p3_hwb_none_preserved() {
    assert_eq!(color("hwb(none none none)"), "hwb(none none none)");
    assert_eq!(color("hwb(120 80% none)"), "hwb(120 80 none)");
    assert_eq!(color("hwb(120 30 50 / none)"), "hwb(120 30 50 / none)");
}

#[test]
fn p3_rgb_none_specified_is_legacy_with_zeros() {
    assert_eq!(color("rgb(none none none)"), "rgb(0, 0, 0)");
    assert_eq!(color("rgb(128 none none)"), "rgb(128, 0, 0)");
    assert_eq!(color("rgb(128 none none / none)"), "rgba(128, 0, 0, 0)");
    assert_eq!(color("rgb(20% none none)"), "rgb(51, 0, 0)");
    assert_eq!(color("rgb(none none none / .5)"), "rgba(0, 0, 0, 0.5)");
}

#[test]
fn p3_rgb_none_computed_goes_modern() {
    assert_eq!(
        computed_color("rgb(none none none)"),
        "color(srgb none none none)"
    );
    assert_eq!(
        computed_color("rgb(20% none none)"),
        "color(srgb 0.2 none none)"
    );
    assert_eq!(
        computed_color("rgb(none none none / .5)"),
        "color(srgb none none none / 0.5)"
    );
}

#[test]
fn p3_hsl_none_computed_keeps_percent() {
    assert_eq!(computed_color("hsl(120 80% none)"), "hsl(120 80% none)");
    assert_eq!(computed_color("hsl(none none none)"), "hsl(none none none)");
    assert_eq!(
        computed_color("hwb(120 30% 50% / none)"),
        "hwb(120 30% 50% / none)"
    );
    assert_eq!(computed_color("hsl(120 30% 50%)"), "rgb(89, 166, 89)");
}

#[test]
fn p3_no_none_keeps_legacy_rgb() {
    assert_eq!(color("hsl(120 100% 50%)"), "rgb(0, 255, 0)");
    assert_eq!(color("hwb(120 30% 50%)"), "rgb(77, 128, 77)");
    assert_eq!(color("rgb(1 2 3)"), "rgb(1, 2, 3)");
}

#[test]
fn p3_relative_specified_stays_symbolic_with_zeros() {
    assert_eq!(
        color("rgb(from rgb(none none none) r g b)"),
        "rgb(from rgb(0, 0, 0) r g b)"
    );
    assert_eq!(
        color("rgb(from rgb(20% none 60%) r g b)"),
        "rgb(from rgb(51, 0, 153) r g b)"
    );
}

#[test]
fn p3_relative_origin_with_none_serializes_legacy() {
    assert_eq!(
        color("hsl(from hsl(none none none) h s l)"),
        "hsl(from rgb(0, 0, 0) h s l)"
    );
    assert_eq!(
        color("hsl(from hsl(120deg none 50% / .5) h s l)"),
        "hsl(from rgba(128, 128, 128, 0.5) h s l)"
    );
    assert_eq!(
        color("hsl(from hsl(120deg 20% 50% / none) h s l / alpha)"),
        "hsl(from rgba(102, 153, 102, 0) h s l / alpha)"
    );
    assert_eq!(
        computed_color("hsl(from hsl(none none none) h s l)"),
        "hsl(none none none)"
    );
}

#[test]
fn p3_relative_channel_keyword_carries_none_computed() {
    assert_eq!(
        computed_color("rgb(from rgb(none none none) r g b)"),
        "color(srgb none none none)"
    );
    assert_eq!(
        computed_color("rgb(from rgb(20% none 60%) r g b)"),
        "color(srgb 0.2 none 0.6)"
    );
    assert_eq!(
        computed_color("rgb(from rgb(none none none / none) r g b / alpha)"),
        "color(srgb none none none / none)"
    );
}

#[test]
fn p3_relative_channel_keyword_in_calc_is_zero() {
    assert_eq!(
        computed_color("rgb(from rgb(none none none) calc(r) calc(g) calc(b))"),
        "color(srgb 0 0 0)"
    );
}

#[test]
fn p2_contrast_color_computed_resolves() {
    assert_eq!(computed_color("contrast-color(white)"), "rgb(0, 0, 0)");
    assert_eq!(
        computed_color("contrast-color(black)"),
        "rgb(255, 255, 255)"
    );
    assert_eq!(computed_color("contrast-color(pink)"), "rgb(0, 0, 0)");
    assert_eq!(
        computed_color("contrast-color(contrast-color(pink))"),
        "rgb(255, 255, 255)"
    );
    assert_eq!(
        computed_color("rgb(from contrast-color(blue) r g b)"),
        "color(srgb 1 1 1)"
    );
}

#[test]
fn p2_contrast_color_currentcolor_stays_symbolic() {
    assert_eq!(
        computed_color("contrast-color(currentcolor)"),
        "contrast-color(currentcolor)"
    );
}

#[test]
fn p4_colormix_zero_sum_parses() {
    assert_eq!(
        color("color-mix(in hsl, hsl(120deg 10% 20%) 0%, hsl(30deg 30% 40%) 0%)"),
        "color-mix(in hsl, rgb(46, 56, 46) 0%, rgb(133, 102, 71) 0%)"
    );
    let c = computed_color("color-mix(in hsl, hsl(120deg 10% 20%) 0%, hsl(30deg 30% 40%) 0%)");
    assert!(
        c.starts_with("color(srgb 0.3") && c.ends_with("/ 0)"),
        "zero-sum mix computed: {}",
        c
    );
}

#[test]
fn p4_colormix_single_item_parses_modern() {
    assert_eq!(
        computed_color("color-mix(in srgb, red)"),
        "color(srgb 1 0 0)"
    );
    assert_eq!(
        computed_color("color-mix(in srgb, red 50%)"),
        "color(srgb 1 0 0 / 0.5)"
    );
}

#[test]
fn p4_colormix_none_inputs_carry_forward() {
    assert_eq!(
        computed_color("color-mix(in hsl, hsl(none none none), hsl(none none none))"),
        "hsl(none none none)"
    );
    let c = computed_color("color-mix(in hsl, hsl(none none none), hsl(30deg 40% 80%))");
    assert!(c.starts_with("color(srgb 0.88"), "carry-forward mix: {}", c);
}

#[test]
fn f1_relative_and_mix_hsl_none_serialize_numbers() {
    assert_eq!(
        computed_color("hsl(from rebeccapurple h s none)"),
        "hsl(270 50 none)"
    );
    assert_eq!(
        computed_color("hwb(from hwb(120deg 20% 50%) h w none)"),
        "hwb(120 20 none)"
    );
    assert_eq!(
        computed_color("color-mix(in hsl, hsl(120deg 40% 40% / none), hsl(0deg 40% 40% / none))"),
        "hsl(60 40 40 / none)"
    );
    assert_eq!(computed_color("hsl(120 80% none)"), "hsl(120 80% none)");
    assert_eq!(computed_color("hsl(270 50 none)"), "hsl(270 50 none)");
    assert_eq!(
        computed_color("hwb(120 20 none / 0.5)"),
        "hwb(120 20 none / 0.5)"
    );
}

#[test]
fn f2_lab_family_channel_keyword_none_is_zero() {
    assert_eq!(
        computed_color("lch(from lch(none none none) l c h)"),
        "lch(0 0 0)"
    );
    // lab()/oklab() CARRY keyword none (WPT FIXME rows differ per family).
    assert_eq!(
        computed_color("lab(from lab(none none none) l a b)"),
        "lab(none none none)"
    );
    assert_eq!(
        computed_color("lab(from lab(25 none 50) l a b)"),
        "lab(25 none 50)"
    );
    assert_eq!(
        computed_color("lch(from lch(0.7 none 30) l c h)"),
        "lch(0.7 0 30)"
    );
    assert_eq!(
        computed_color("lch(from lch(0.7 45 30) l c none)"),
        "lch(0.7 45 none)"
    );
    assert_eq!(
        computed_color("color(from color(xyz-d65 none none none) xyz-d65 x y z)"),
        "color(xyz-d65 0 0 0)"
    );
    assert_eq!(
        computed_color("rgb(from rgb(none none none) r g b)"),
        "color(srgb none none none)"
    );
}

#[test]
fn f3_colormix_items_with_none_serialize_legacy() {
    assert_eq!(
        color("color-mix(in hsl, hsl(none none none), hsl(none none none))"),
        "color-mix(in hsl, rgb(0, 0, 0), rgb(0, 0, 0))"
    );
    assert_eq!(
        color("color-mix(in hsl, hsl(120deg 20% none), hsl(30deg 40% 60%))"),
        "color-mix(in hsl, rgb(0, 0, 0), rgb(194, 153, 112))"
    );
}

#[test]
fn f4_colormix_zero_sum_three_items_folds_pairwise() {
    let c = computed_color("color-mix(in srgb, red 0%, green 0%, blue 0%)");
    assert!(
        c.starts_with("color(srgb 0.25 0.12") && c.ends_with("/ 0)"),
        "3-item zero-sum: {}",
        c
    );
}

#[test]
fn p5_cqw_parses_in_calc() {
    let got = color("lab(calc(50 + (sign(2cqw - 10px) * 10)) 30 50 / 0.51)");
    assert!(
        !got.is_empty(),
        "cqw inside sign() must parse (got dropped declaration)"
    );
}

#[test]
fn f5_opacity_minmax_clamp_folds() {
    assert_eq!(specified("opacity", "min(50%, 0%)"), "calc(0%)");
    assert_eq!(specified("opacity", "max(0%, 50%)"), "calc(50%)");
    assert_eq!(specified("opacity", "min(-40%, 50%)"), "calc(-40%)");
    assert_eq!(specified("opacity", "clamp(50%, 0%, 70%)"), "calc(50%)");
    assert_eq!(specified("opacity", "clamp(50%, 80%, 70%)"), "calc(70%)");
    assert_eq!(specified("opacity", "clamp(50%, 60%, 70%)"), "calc(60%)");
}

#[test]
fn p6_calc_product_numeric_first() {
    assert_eq!(
        specified("opacity", "calc(0.5 + (sign(1em - 10px) * 0.1))"),
        "calc(0.5 + (0.1 * sign(1em - 10px)))"
    );
}

#[test]
fn p6_unresolvable_rgb_canonicalizes() {
    assert_eq!(
        color("rgb(calc(50% + (sign(1em - 10px) * 10%)), 0%, 0%, 50%)"),
        "rgb(calc(50% + (10% * sign(1em - 10px))) 0 0 / 0.5)"
    );
    assert_eq!(
        color("hsl(0deg, 0%, 0%, calc(50% + (sign(1em - 10px) * 10%)))"),
        "hsl(0 0 0 / calc(50% + (10% * sign(1em - 10px))))"
    );
    assert_eq!(
        color("hwb(calc(110deg + (sign(1em - 10px) * 10deg)) 30% 50% / 50%)"),
        "hwb(calc(110deg + (10deg * sign(1em - 10px))) 30 50 / 0.5)"
    );
}

#[test]
fn cascade_theme_attribute_flip_updates_var_color() {
    use style::properties::LonghandId;
    init_style_prefs();
    let html = r#"<!DOCTYPE html><html><head><style>
      html { --bg: oklch(0.96 0 0); }
      html[data-theme=dark] { --bg: oklch(0.2 0 0); }
      body { background-color: var(--bg); }
    </style></head><body>x</body></html>"#;
    let dom = DomHandle::new(html, "https://test.example/");
    dom.resolve_layout();
    let read = |dom: &DomHandle| {
        let bid = dom.query_selector("body").unwrap();
        let doc = dom.doc.borrow();
        let node = doc.get_node(crate::blitz_node_id(bid as u32)).unwrap();
        let styles = node.primary_styles().unwrap();
        let mut out = String::new();
        let mut ctx = Context {
            style: &styles,
            for_property: PropertyId::NonCustom(LonghandId::BackgroundColor.into()),
            current_longhand: None,
        };
        styles
            .computed_or_resolved_value(LonghandId::BackgroundColor, Some(&mut ctx), &mut out)
            .unwrap();
        out
    };
    let before = read(&dom);
    let hid = dom.query_selector("html").unwrap();
    dom.set_attribute(hid as u32, "data-theme", "dark");
    dom.resolve_layout();
    let after = read(&dom);
    eprintln!("THEME {} -> {}", before, after);
    assert_ne!(before, after);
}
