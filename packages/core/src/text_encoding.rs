// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Provides text and percent-encoding helpers used by URL and form APIs.

use encoding_rs::{EncoderResult, Encoding, UTF_8};
use std::fmt::Write;
use wasm_bindgen::prelude::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PercentEncodeSet {
    SpecialQuery,
    FormUrlencoded,
}

impl PercentEncodeSet {
    fn from_wire(set: u8) -> Self {
        match set {
            1 => PercentEncodeSet::FormUrlencoded,
            _ => PercentEncodeSet::SpecialQuery,
        }
    }

    fn contains(self, byte: u8) -> bool {
        if !(0x20..=0x7E).contains(&byte) {
            return true;
        }
        match self {
            PercentEncodeSet::SpecialQuery => {
                matches!(byte, b' ' | b'"' | b'#' | b'<' | b'>' | b'\'')
            }
            PercentEncodeSet::FormUrlencoded => {
                !(byte.is_ascii_alphanumeric() || matches!(byte, b'*' | b'-' | b'.' | b'_'))
            }
        }
    }
}

fn output_encoding(label: &str) -> &'static Encoding {
    Encoding::for_label(label.trim().as_bytes())
        .unwrap_or(UTF_8)
        .output_encoding()
}

pub fn percent_encode_after_encoding(
    encoding: &'static Encoding,
    input: &str,
    set: PercentEncodeSet,
    space_as_plus: bool,
) -> String {
    let mut encoder = encoding.new_encoder();
    let mut out = String::with_capacity(input.len() * 3);
    let mut buf = [0u8; 1024];
    let mut rest = input;
    loop {
        let (result, read, written) =
            encoder.encode_from_utf8_without_replacement(rest, &mut buf, true);
        rest = &rest[read..];
        for &byte in &buf[..written] {
            if space_as_plus && byte == b' ' {
                out.push('+');
            } else if set.contains(byte) {
                let _ = write!(out, "%{byte:02X}");
            } else {
                out.push(byte as char);
            }
        }
        match result {
            EncoderResult::InputEmpty => return out,
            EncoderResult::OutputFull => {}
            EncoderResult::Unmappable(c) => {
                // Unmappable input becomes a percent-encoded numeric character reference.
                let _ = write!(out, "%26%23{}%3B", c as u32);
            }
        }
    }
}

#[wasm_bindgen]
pub fn ks_encoding_name(label: &str) -> Option<String> {
    Encoding::for_label(label.trim().as_bytes()).map(|e| e.name().to_string())
}

#[wasm_bindgen]
pub fn ks_percent_encode_after_encoding(
    encoding: &str,
    input: &str,
    set: u8,
    space_as_plus: bool,
) -> String {
    percent_encode_after_encoding(
        output_encoding(encoding),
        input,
        PercentEncodeSet::from_wire(set),
        space_as_plus,
    )
}

#[wasm_bindgen]
pub fn ks_encode_html(encoding: &str, input: &str) -> Vec<u8> {
    let (bytes, _, _) = output_encoding(encoding).encode(input);
    bytes.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(label: &str, input: &str) -> String {
        ks_percent_encode_after_encoding(label, input, 0, false)
    }

    fn form(label: &str, input: &str) -> String {
        ks_percent_encode_after_encoding(label, input, 1, true)
    }

    #[test]
    fn query_bytes_outside_the_set_stay_literal() {
        assert_eq!(query("gb18030", "\u{4E02}"), "%81@");
        assert_eq!(query("gb18030", "\u{20AC}"), "%A2%E3");
        assert_eq!(query("gb18030", "\u{1F4A9}"), "%949%DA3");
        assert_eq!(query("euc-kr", "\u{AC00}"), "%B0%A1");
        assert_eq!(query("shift_jis", "\u{3042}"), "%82%A0");
        assert_eq!(query("big5", "\u{4E00}"), "%A4@");
    }

    #[test]
    fn unmappable_code_points_become_percent_encoded_references() {
        assert_eq!(query("euc-kr", "\u{0100}"), "%26%23256%3B");
        assert_eq!(query("gb18030", "\u{E5E5}"), "%26%2358853%3B");
        assert_eq!(form("shift_jis", "\u{AC00}"), "%26%2344032%3B");
    }

    #[test]
    fn iso_2022_jp_returns_to_ascii_before_an_unmappable() {
        assert_eq!(
            query("iso-2022-jp", "\u{3042}\u{0100}"),
            "%1B$B$%22%1B(B%26%23256%3B"
        );
        assert_eq!(query("iso-2022-jp", "\u{1B}"), "%26%2365533%3B");
    }

    #[test]
    fn form_set_encodes_everything_but_alphanumerics() {
        assert_eq!(form("euc-kr", "a b*-._~!\u{AC00}"), "a+b*-._%7E%21%B0%A1");
        assert_eq!(form("utf-8", "\u{20AC}"), "%E2%82%AC");
    }

    #[test]
    fn output_encoding_maps_utf16_and_replacement_to_utf8() {
        assert_eq!(query("utf-16le", "\u{20AC}"), "%E2%82%AC");
        assert_eq!(query("iso-2022-kr", "\u{20AC}"), "%E2%82%AC");
        assert_eq!(query("no-such-label", "\u{20AC}"), "%E2%82%AC");
    }

    #[test]
    fn canonical_names() {
        assert_eq!(ks_encoding_name("sjis").as_deref(), Some("Shift_JIS"));
        assert_eq!(ks_encoding_name(" EUC-KR ").as_deref(), Some("EUC-KR"));
        assert_eq!(ks_encoding_name("latin1").as_deref(), Some("windows-1252"));
        assert_eq!(ks_encoding_name("bogus"), None);
    }

    #[test]
    fn html_error_mode_writes_literal_references() {
        assert_eq!(ks_encode_html("euc-kr", "a\u{0100}"), b"a&#256;".to_vec());
        assert_eq!(
            ks_encode_html("utf-16be", "\u{20AC}"),
            "\u{20AC}".as_bytes().to_vec()
        );
    }
}
