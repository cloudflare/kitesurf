// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Locates `packages/engine` for tests that read its fonts and fixtures.

use std::path::PathBuf;

/// Bazel sets this to the runfiles path of `packages/engine/package.json`.
const ENGINE_PACKAGE_JSON_ENV: &str = "KITESURF_ENGINE_PACKAGE_JSON";

/// Returns the `packages/engine` directory. Bazel compiles `CARGO_MANIFEST_DIR` as `packages/core`,
/// which resolves only when this is the main repository, so the test target passes a runfiles path
/// that also works from an external module. Cargo runs leave the variable unset.
pub(crate) fn engine_dir() -> PathBuf {
    match std::env::var_os(ENGINE_PACKAGE_JSON_ENV) {
        Some(package_json) => PathBuf::from(package_json)
            .parent()
            .expect("package.json path has a parent directory")
            .to_path_buf(),
        None => PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../engine")),
    }
}
