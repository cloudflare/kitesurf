// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Bounded woff and woff2 inflation for page-supplied fonts. Shared with the
//! renderer crates, so it depends only on `wuff` and `flate2`.

pub(crate) const MAX_DECOMPRESSED_FONT_BYTES: u32 = 32 * 1024 * 1024;

const SFNT_HEADER_BYTES: u64 = 12;
const SFNT_TABLE_RECORD_BYTES: u64 = 16;
const WOFF2_HEADER_BYTES: usize = 48;
const WOFF2_GLYF_INDEX: u8 = 10;
const WOFF2_LOCA_INDEX: u8 = 11;
const WOFF2_ARBITRARY_TAG_INDEX: u8 = 63;

pub(crate) enum FontContainer {
    /// Not a woff or woff2 container.
    Sfnt,
    Inflated(Vec<u8>),
    /// A container that does not decode, or would inflate past the cap.
    Refused,
}

/// Inflates woff and woff2 with no allocation past `MAX_DECOMPRESSED_FONT_BYTES`.
/// The decoder sizes its buffers from header and directory fields, so those are
/// checked (woff2) or bounded in the inflate hook (woff1) before any allocation.
pub(crate) fn inflate_font_container(bytes: &[u8]) -> FontContainer {
    let magic = bytes.get(0..4);
    let inflated = if magic == Some(b"wOF2") {
        if !woff2_fits(bytes, MAX_DECOMPRESSED_FONT_BYTES as u64) {
            return FontContainer::Refused;
        }
        wuff::decompress_woff2(bytes).ok()
    } else if magic == Some(b"wOFF") {
        inflate_woff1(bytes, MAX_DECOMPRESSED_FONT_BYTES as usize)
    } else {
        return FontContainer::Sfnt;
    };
    match inflated {
        Some(sfnt) if sfnt.len() <= MAX_DECOMPRESSED_FONT_BYTES as usize => {
            FontContainer::Inflated(sfnt)
        }
        _ => FontContainer::Refused,
    }
}

pub(crate) fn declared_sfnt_size(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?))
}

fn inflate_woff1(bytes: &[u8], cap: usize) -> Option<Vec<u8>> {
    match declared_sfnt_size(bytes) {
        Some(n) if n as usize <= cap => {}
        _ => return None,
    }
    // wuff passes each table's declared origLength as the buffer size; charge it first.
    let mut remaining = cap;
    let mut inflate = |data: &[u8], size: usize| -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        remaining = remaining
            .checked_sub(size)
            .ok_or("woff table over the inflate cap")?;
        let mut out = Vec::with_capacity(size);
        flate2::Decompress::new(true).decompress_vec(
            data,
            &mut out,
            flate2::FlushDecompress::Finish,
        )?;
        Ok(out)
    };
    wuff::decompress_woff1_with_custom_z(bytes, &mut inflate).ok()
}

/// Whether a woff2's declared output (header, directory and padded origLengths)
/// fits `cap`. Collections are refused; the shaping path accepts single faces only.
fn woff2_fits(bytes: &[u8], cap: u64) -> bool {
    woff2_declared_size(bytes).is_some_and(|n| n <= cap)
}

fn woff2_declared_size(bytes: &[u8]) -> Option<u64> {
    if bytes.len() < WOFF2_HEADER_BYTES || bytes[4..8] == *b"ttcf" {
        return None;
    }
    if declared_sfnt_size(bytes)? > MAX_DECOMPRESSED_FONT_BYTES {
        return None;
    }
    let num_tables = u64::from(u16::from_be_bytes([bytes[12], bytes[13]]));
    let mut total = SFNT_HEADER_BYTES + num_tables * SFNT_TABLE_RECORD_BYTES;
    let mut at = WOFF2_HEADER_BYTES;
    for _ in 0..num_tables {
        let flags = *bytes.get(at)?;
        at += 1;
        let index = flags & 0x3f;
        let glyf_or_loca = if index == WOFF2_ARBITRARY_TAG_INDEX {
            let tag = bytes.get(at..at + 4)?;
            at += 4;
            tag == b"glyf" || tag == b"loca"
        } else {
            index == WOFF2_GLYF_INDEX || index == WOFF2_LOCA_INDEX
        };
        let orig_length = u64::from(read_uint_base128(bytes, &mut at)?);
        total += (orig_length + 3) & !3;
        // glyf and loca carry a transformLength for transform 0; other tables for nonzero.
        let nonzero_transform = flags >> 6 != 0;
        if glyf_or_loca != nonzero_transform {
            read_uint_base128(bytes, &mut at)?;
        }
    }
    Some(total)
}

/// WOFF2 UIntBase128: at most five bytes, no leading zero byte, fits in u32.
fn read_uint_base128(bytes: &[u8], at: &mut usize) -> Option<u32> {
    let mut acc: u32 = 0;
    for i in 0..5 {
        let byte = *bytes.get(*at)?;
        *at += 1;
        if (i == 0 && byte == 0x80) || acc & 0xfe00_0000 != 0 {
            return None;
        }
        acc = (acc << 7) | u32::from(byte & 0x7f);
        if byte & 0x80 == 0 {
            return Some(acc);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTO_SANS: &[u8] = include_bytes!("../../../engine/public/fonts/NotoSans.ttf");

    /// Wraps an sfnt as woff1 with zlib-compressed tables. `orig_length_of` may
    /// override a table's declared origLength.
    fn woff1_from_sfnt(sfnt: &[u8], orig_length_of: impl Fn(&[u8], u32) -> u32) -> Vec<u8> {
        use std::io::Write as _;
        let be32 = |at: usize| u32::from_be_bytes(sfnt[at..at + 4].try_into().unwrap());
        let num_tables = u16::from_be_bytes([sfnt[4], sfnt[5]]) as usize;
        let mut dir = Vec::new();
        let mut data = Vec::new();
        let data_start = 44 + 20 * num_tables;
        for i in 0..num_tables {
            let rec = 12 + i * 16;
            let (tag, checksum) = (&sfnt[rec..rec + 4], be32(rec + 4));
            let (offset, length) = (be32(rec + 8) as usize, be32(rec + 12));
            let table = &sfnt[offset..offset + length as usize];
            let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
            z.write_all(table).unwrap();
            let packed = z.finish().unwrap();
            let stored = if packed.len() < table.len() {
                &packed[..]
            } else {
                table
            };
            dir.extend_from_slice(tag);
            dir.extend_from_slice(&((data_start + data.len()) as u32).to_be_bytes());
            dir.extend_from_slice(&(stored.len() as u32).to_be_bytes());
            dir.extend_from_slice(&orig_length_of(tag, length).to_be_bytes());
            dir.extend_from_slice(&checksum.to_be_bytes());
            data.extend_from_slice(stored);
            data.resize((data.len() + 3) & !3, 0);
        }
        let mut out = Vec::new();
        out.extend_from_slice(b"wOFF");
        out.extend_from_slice(&sfnt[0..4]);
        out.extend_from_slice(&((data_start + data.len()) as u32).to_be_bytes());
        out.extend_from_slice(&(num_tables as u16).to_be_bytes());
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(&(sfnt.len() as u32).to_be_bytes());
        out.extend_from_slice(&[0; 24]);
        out.extend_from_slice(&dir);
        out.extend_from_slice(&data);
        out
    }

    fn inflated(bytes: &[u8]) -> Option<Vec<u8>> {
        match inflate_font_container(bytes) {
            FontContainer::Inflated(sfnt) => Some(sfnt),
            _ => None,
        }
    }

    #[test]
    fn inflate_font_container_matches_wuff_for_real_fonts() {
        let woff2: &[u8] =
            include_bytes!("../../../engine/public/fonts/inter-latin-variable.woff2");
        assert_eq!(inflated(woff2), wuff::decompress_woff2(woff2).ok());
        let woff1 = woff1_from_sfnt(NOTO_SANS, |_, n| n);
        let sfnt = inflated(&woff1).expect("woff1 inflates");
        assert_eq!(Some(&sfnt), wuff::decompress_woff1(&woff1).ok().as_ref());
        assert_eq!(sfnt[0..4], NOTO_SANS[0..4]);
        assert!(matches!(
            inflate_font_container(NOTO_SANS),
            FontContainer::Sfnt
        ));
    }

    #[test]
    fn inflate_font_container_refuses_a_woff1_table_declared_past_the_cap() {
        // A small file whose glyf claims 1 GiB: wuff would reserve that before inflating.
        let woff1 = woff1_from_sfnt(NOTO_SANS, |tag, n| if tag == b"glyf" { 1 << 30 } else { n });
        assert!(matches!(
            inflate_font_container(&woff1),
            FontContainer::Refused
        ));
    }

    #[test]
    fn inflate_font_container_refuses_a_woff2_directory_past_the_cap() {
        let woff2 = |flavor: &[u8; 4], orig_length: &[u8]| {
            let mut b = vec![0u8; WOFF2_HEADER_BYTES];
            b[0..4].copy_from_slice(b"wOF2");
            b[4..8].copy_from_slice(flavor);
            b[12..14].copy_from_slice(&1u16.to_be_bytes());
            b[16..20].copy_from_slice(&64u32.to_be_bytes());
            b.push(1); // head, null transform
            b.extend_from_slice(orig_length);
            b
        };
        // origLength 0x7fff_ffff as UIntBase128.
        let huge = [0x87, 0xff, 0xff, 0xff, 0x7f];
        assert_eq!(
            woff2_declared_size(&woff2(&[0, 1, 0, 0], &huge)),
            Some(12 + 16 + 0x8000_0000)
        );
        assert!(matches!(
            inflate_font_container(&woff2(&[0, 1, 0, 0], &huge)),
            FontContainer::Refused
        ));
        assert_eq!(
            woff2_declared_size(&woff2(&[0, 1, 0, 0], &[54])),
            Some(12 + 16 + 56)
        );
        assert_eq!(woff2_declared_size(&woff2(b"ttcf", &[54])), None);
    }
}
