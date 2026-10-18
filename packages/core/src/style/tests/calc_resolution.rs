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
