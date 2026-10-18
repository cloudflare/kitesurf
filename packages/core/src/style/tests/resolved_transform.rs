// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// getComputedStyle(el).transform's numbers, against Chrome 155's output for the same
// transforms (chrome-devtools MCP). Pages parse these numbers back, so close is not enough.

use crate::style::computed::css_number_g6;

#[test]
fn numbers_print_like_blinks_six_significant_digits() {
    let cases = [
        (0.8660254037844387, "0.866025"),
        (-0.5688148, "-0.568815"),
        (0.5, "0.5"),
        (100.0, "100"),
        (3.1234567, "3.12346"),
        (1234567.5, "1.23457e+06"),
        (0.0000123456, "1.23456e-05"),
        (0.0001, "0.0001"),
        (6.123233995736766e-17, "0"),
        (-0.0, "0"),
        (0.17632698070846498, "0.176327"),
    ];
    for (value, expected) in cases {
        assert_eq!(css_number_g6(value), expected, "{value}");
    }
}
