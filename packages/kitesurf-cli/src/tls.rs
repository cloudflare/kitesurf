// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// reqwest's no-provider Rustls feature needs the process-wide provider installed first.
pub fn client_builder() -> reqwest::ClientBuilder {
    #[cfg(target_os = "linux")]
    // install_default only fails when a provider has already been installed.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    reqwest::Client::builder()
}
