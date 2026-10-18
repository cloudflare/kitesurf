// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

use std::panic::catch_unwind;

#[no_mangle]
pub extern "C" fn checked_div(a: i32, b: i32) -> i32 {
    catch_unwind(|| {
        if b == 0 {
            panic!("division by zero");
        }
        a / b
    })
    .unwrap_or(i32::MIN)
}
