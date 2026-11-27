// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use ::style::typed_om::NumericBaseType;
use ::style::values::computed::length_percentage::{
    CalcNode, CalcPercentageLeaf, ComputedLeaf, LengthPercentage,
};
use ::style::values::computed::Length;
use ::style::values::generics::Optional;
use style_traits::values::specified::AllowedNumericType;

fn resolve(node: CalcNode) -> f32 {
    LengthPercentage::new_calc(node, AllowedNumericType::All)
        .resolve(Length::new(100.0))
        .px()
}

#[test]
fn malformed_calc_resolution_does_not_panic() {
    let empty_sum = CalcNode::Sum(Vec::new().into());
    assert_eq!(resolve(empty_sum), 0.0);

    let incompatible_sum = CalcNode::Sum(
        vec![
            CalcNode::Leaf(ComputedLeaf::Length(Length::new(10.0))),
            CalcNode::Leaf(ComputedLeaf::Number(1.0)),
        ]
        .into(),
    );
    assert_eq!(resolve(incompatible_sum), 0.0);

    let numeric_result = CalcNode::Sign(Box::new(CalcNode::Sum(
        vec![
            CalcNode::Leaf(ComputedLeaf::Length(Length::new(10.0))),
            CalcNode::Leaf(ComputedLeaf::Percentage(CalcPercentageLeaf::new(
                0.1,
                Optional::Some(NumericBaseType::Length),
            ))),
        ]
        .into(),
    )));
    assert_eq!(resolve(numeric_result), 1.0);
}

fn used_width(width: &str) -> Option<String> {
    let html = format!(
        r#"<!DOCTYPE html><body style="margin:0"><div style="width:200px">
        <div id="t" style="width:{width}"></div></div></body>"#
    );
    let dom = crate::DomHandle::new(&html, "https://example.com/");
    dom.set_viewport(800, 600);
    dom.resolve_layout();
    let node = crate::test_support::query_selector_id(&dom, "#t");
    dom.computed_style_value(node, "width")
}

#[test]
fn nan_in_clamp_censors_the_used_value_to_zero() {
    for width in [
        "clamp(50%, NaN * 1px, 100px)",
        "clamp(10px, 50%, NaN * 1px)",
        "clamp(NaN * 1px, 50%, 100px)",
        "min(50%, NaN * 1px)",
    ] {
        assert_eq!(used_width(width).as_deref(), Some("0px"), "{width}");
    }
    assert_eq!(
        used_width("clamp(10px, 50%, 120px)").as_deref(),
        Some("100px")
    );
}

#[test]
fn nan_producing_math_functions_censor_to_zero() {
    // NaN anywhere in a top-level calculation censors the whole width to 0px.
    for expr in [
        "pow(1, infinity)",
        "pow(-1, -infinity)",
        "pow(NaN, 0)",
        "pow(1, NaN)",
        "log(2, 1)",
        "log(2, 0)",
        "round(infinity, NaN)",
        "round(5, NaN)",
    ] {
        let width = format!("calc(10px + {expr} * 1px)");
        assert_eq!(used_width(&width).as_deref(), Some("0px"), "{width}");
    }
    assert_eq!(
        used_width("calc(1px / log(1, 0.5))").as_deref(),
        Some("3.40282e38px")
    );
    assert_eq!(
        used_width("calc(100px * pow(2, 3))").as_deref(),
        Some("800px")
    );
    assert_eq!(
        used_width("calc(10px * log(8, 2))").as_deref(),
        Some("30px")
    );
}
