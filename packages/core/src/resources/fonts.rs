// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

//! Creates the shared font context and registers embedded or fetched fonts for layout and paint.

use std::cell::Cell;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use linebender_resource_handle::Blob;
use parley::fontique::{
    Collection, CollectionOptions, FamilyId, FontInfoOverride, GenericFamily, Script, SourceCache,
};
use parley::FontContext;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::paint::font_container::{inflate_font_container, FontContainer, MAX_DECOMPRESSED_FONT_BYTES};
use crate::paint::scene_record::{font_data_key, fx_hash_u64};

thread_local! {
    static SHARED_FONT_CONTEXT: RefCell<Option<FontContext>> = const { RefCell::new(None) };

    static UA_FONTS_REGISTERED: Cell<bool> = const { Cell::new(false) };

    static EMOJI_FONT_REGISTERED: Cell<bool> = const { Cell::new(false) };

    static SYMBOL_FONTS_REGISTERED: Cell<bool> = const { Cell::new(false) };

    static CJK_FONT_REGISTERED: Cell<bool> = const { Cell::new(false) };

    static SCRIPT_FONTS_REGISTERED: RefCell<std::collections::HashSet<String>> =
        RefCell::new(std::collections::HashSet::new());

    static BASE_COMMON_IDS: RefCell<Vec<FamilyId>> =
        const { RefCell::new(Vec::new()) };
    static SYMBOL_IDS: RefCell<Vec<FamilyId>> =
        const { RefCell::new(Vec::new()) };
    static EMOJI_IDS: RefCell<Vec<FamilyId>> =
        const { RefCell::new(Vec::new()) };
    static CJK_IDS: RefCell<Vec<FamilyId>> =
        const { RefCell::new(Vec::new()) };
    static CJK_JP_IDS: RefCell<Vec<FamilyId>> =
        const { RefCell::new(Vec::new()) };
    static CJK_TC_IDS: RefCell<Vec<FamilyId>> =
        const { RefCell::new(Vec::new()) };
    // Noto Sans as the `Latn` script face, in profiles whose UA faces lack some Latin codepoints.
    static LATIN_FALLBACK_IDS: RefCell<Vec<FamilyId>> =
        const { RefCell::new(Vec::new()) };
    static UA_FONT_PROFILE: Cell<Option<&'static UaFontProfile>> = const { Cell::new(None) };

    static FONT_ASSET_HASHES: RefCell<HashMap<u64, &'static str>> =
        RefCell::new(HashMap::new());
}

const SFNT_HEADER_BYTES: usize = 12;
const SFNT_TABLE_RECORD_BYTES: usize = 16;

pub(crate) fn strip_sfnt_tables(bytes: &[u8], drop: &[[u8; 4]]) -> Option<Vec<u8>> {
    if bytes.len() < SFNT_HEADER_BYTES {
        return None;
    }
    let sfnt_version = &bytes[0..4];
    if sfnt_version != [0x00, 0x01, 0x00, 0x00] && sfnt_version != b"OTTO" {
        return None;
    }
    let num_tables = u16::from_be_bytes([bytes[4], bytes[5]]) as usize;
    if SFNT_HEADER_BYTES + num_tables * SFNT_TABLE_RECORD_BYTES > bytes.len() {
        return None;
    }
    struct Entry {
        tag: [u8; 4],
        checksum: [u8; 4],
        data: std::ops::Range<usize>,
    }
    let mut kept: Vec<Entry> = Vec::with_capacity(num_tables);
    for i in 0..num_tables {
        let e = SFNT_HEADER_BYTES + i * SFNT_TABLE_RECORD_BYTES;
        let tag: [u8; 4] = bytes[e..e + 4].try_into().ok()?;
        let checksum: [u8; 4] = bytes[e + 4..e + 8].try_into().ok()?;
        let off = u32::from_be_bytes(bytes[e + 8..e + 12].try_into().ok()?) as usize;
        let len = u32::from_be_bytes(bytes[e + 12..e + 16].try_into().ok()?) as usize;
        // usize is 32 bits on wasm32, so an unchecked sum can wrap past the bound.
        let end = off.checked_add(len).filter(|&end| end <= bytes.len())?;
        if drop.contains(&tag) {
            continue;
        }
        kept.push(Entry {
            tag,
            checksum,
            data: off..end,
        });
    }
    if kept.is_empty() || kept.len() == num_tables {
        return None;
    }
    let n = kept.len();
    let n_records = u16::try_from(n * SFNT_TABLE_RECORD_BYTES).ok()?;
    let entry_selector = n.ilog2().saturating_sub(1) as u16;
    let search_range = 16u16 << entry_selector;
    let range_shift = n_records - search_range;

    let max_output = bytes.len().checked_add(n.checked_mul(3)?)?;
    let mut output_size = SFNT_HEADER_BYTES.checked_add(n.checked_mul(SFNT_TABLE_RECORD_BYTES)?)?;
    for entry in &kept {
        let padded = entry.data.len().checked_add(3)? & !3;
        output_size = output_size.checked_add(padded)?;
        if output_size > max_output {
            return None;
        }
    }
    let mut out = Vec::with_capacity(output_size);
    out.extend_from_slice(sfnt_version);
    out.extend_from_slice(&(n as u16).to_be_bytes());
    out.extend_from_slice(&search_range.to_be_bytes());
    out.extend_from_slice(&entry_selector.to_be_bytes());
    out.extend_from_slice(&range_shift.to_be_bytes());
    let mut offset = SFNT_HEADER_BYTES + n * SFNT_TABLE_RECORD_BYTES;
    for e in &kept {
        out.extend_from_slice(&e.tag);
        out.extend_from_slice(&e.checksum);
        out.extend_from_slice(&(offset as u32).to_be_bytes());
        out.extend_from_slice(&(e.data.len() as u32).to_be_bytes());
        offset += (e.data.len() + 3) & !3;
    }
    for e in &kept {
        out.extend_from_slice(&bytes[e.data.clone()]);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    Some(out)
}

pub(crate) const EMOJI_STRIP_TABLES: [[u8; 4]; 8] = [
    *b"CBDT", *b"CBLC", *b"COLR", *b"CPAL", *b"sbix", *b"SVG ", *b"glyf", *b"loca",
];

pub(crate) const OUTLINE_STRIP_TABLES: [[u8; 4]; 5] =
    [*b"CFF ", *b"CFF2", *b"VORG", *b"glyf", *b"loca"];

const OUTLINE_STRIP_TABLES_WITH_GVAR: [[u8; 4]; 6] =
    [*b"CFF ", *b"CFF2", *b"VORG", *b"glyf", *b"loca", *b"gvar"];

fn sfnt_has_table(bytes: &[u8], tag: &[u8; 4]) -> bool {
    if bytes.len() < SFNT_HEADER_BYTES {
        return false;
    }
    let sfnt_version = &bytes[0..4];
    if sfnt_version != [0x00, 0x01, 0x00, 0x00] && sfnt_version != b"OTTO" {
        return false;
    }
    let num_tables = u16::from_be_bytes([bytes[4], bytes[5]]) as usize;
    if SFNT_HEADER_BYTES + num_tables * SFNT_TABLE_RECORD_BYTES > bytes.len() {
        return false;
    }
    (0..num_tables).any(|i| {
        let e = SFNT_HEADER_BYTES + i * SFNT_TABLE_RECORD_BYTES;
        bytes[e..e + 4] == tag[..]
    })
}

pub(crate) fn has_outline_tables(bytes: &[u8]) -> bool {
    sfnt_has_table(bytes, b"glyf")
        || sfnt_has_table(bytes, b"CFF ")
        || sfnt_has_table(bytes, b"CFF2")
}

pub(crate) fn strip_outline_tables(bytes: &[u8]) -> Option<Vec<u8>> {
    if sfnt_has_table(bytes, b"gvar") && sfnt_has_table(bytes, b"HVAR") {
        strip_sfnt_tables(bytes, &OUTLINE_STRIP_TABLES_WITH_GVAR)
    } else {
        strip_sfnt_tables(bytes, &OUTLINE_STRIP_TABLES)
    }
}

#[wasm_bindgen(js_name = "stripFontForShaping")]
pub fn strip_font_for_shaping(bytes: Vec<u8>) -> Option<Vec<u8>> {
    let sfnt: Vec<u8> = match inflate_font_container(&bytes) {
        FontContainer::Sfnt => bytes,
        FontContainer::Inflated(sfnt) => sfnt,
        FontContainer::Refused => return None,
    };
    if sfnt.len() > MAX_DECOMPRESSED_FONT_BYTES as usize {
        return None;
    }
    if !sfnt_has_table(&sfnt, b"head") {
        return None;
    }
    let drop = shaping_strip_tables(&sfnt);
    if !drop.iter().any(|tag| sfnt_has_table(&sfnt, tag)) {
        return Some(sfnt);
    }
    strip_sfnt_tables(&sfnt, &drop)
}

fn shaping_strip_tables(sfnt: &[u8]) -> Vec<[u8; 4]> {
    let mut drop = OUTLINE_STRIP_TABLES.to_vec();
    if sfnt_has_table(sfnt, b"gvar") && sfnt_has_table(sfnt, b"HVAR") {
        drop.push(*b"gvar");
    }
    for tag in EMOJI_STRIP_TABLES {
        if !drop.contains(&tag) {
            drop.push(tag);
        }
    }
    drop
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum FontMode {
    Full,
    PixelFree,
    Lazy,
}

thread_local! {
    static FONT_MODE: Cell<FontMode> = const { Cell::new(FontMode::Full) };
}

pub(crate) fn font_mode() -> FontMode {
    FONT_MODE.with(|m| m.get())
}

pub(crate) fn set_font_mode(mode: FontMode) {
    FONT_MODE.with(|m| m.set(mode));
}

/// Pixel-free sessions: no pixel ever leaves the connection, so
/// glyph outlines are dead weight. Distinct from renderer_mode().
#[wasm_bindgen(js_name = "setPixelFreeSession")]
pub fn set_pixel_free_session(enabled: bool) {
    set_font_mode(if enabled {
        FontMode::PixelFree
    } else {
        FontMode::Full
    });
}

/// Lazy paint sessions: shaping-only faces until the first in-isolate
/// outline consumer (canvas text, svg <text>, printToPDF) upgrades.
#[wasm_bindgen(js_name = "setFontShapingLazy")]
pub fn set_font_shaping_lazy(enabled: bool) {
    set_font_mode(if enabled {
        FontMode::Lazy
    } else {
        FontMode::Full
    });
}

fn maybe_strip_for_session(bytes: Vec<u8>) -> Vec<u8> {
    if font_mode() == FontMode::Full {
        return bytes;
    }
    strip_outline_tables(&bytes).unwrap_or(bytes)
}

pub(crate) fn strip_fetched_font_for_session(
    bytes: Vec<u8>,
    url: &str,
    engine_key: u64,
) -> Vec<u8> {
    let key = if engine_key == 0 {
        None
    } else {
        remember_engine_key(url, engine_key);
        Some(engine_key.to_string())
    };
    match font_mode() {
        FontMode::Full => bytes,
        FontMode::PixelFree => strip_fetched_font(bytes),
        FontMode::Lazy => {
            let out = strip_fetched_font(bytes);
            if is_plain_sfnt(&out) && !has_outline_tables(&out) {
                note_font_url(&out, url);
                if let Some(key) = key.as_deref() {
                    note_font_engine_key(&out, key);
                }
            }
            out
        }
    }
}

thread_local! {
    static FONT_URL_HASHES: RefCell<HashMap<u64, String>> =
        RefCell::new(HashMap::new());
    static FONT_ENGINE_KEY_HASHES: RefCell<HashMap<u64, String>> =
        RefCell::new(HashMap::new());
    static FONT_ENGINE_KEYS: RefCell<HashMap<String, String>> =
        RefCell::new(HashMap::new());
}

fn blob_key(bytes: &[u8]) -> u64 {
    font_data_key(fx_hash_u64(bytes), 0)
}

fn note_font_url(bytes: &[u8], url: &str) {
    let h = blob_key(bytes);
    FONT_URL_HASHES.with(|c| {
        c.borrow_mut().insert(h, url.to_string());
    });
}

fn note_font_engine_key(bytes: &[u8], key: &str) {
    let h = blob_key(bytes);
    FONT_ENGINE_KEY_HASHES.with(|c| {
        c.borrow_mut().insert(h, key.to_string());
    });
}

pub(crate) fn font_engine_key_for_hash(hash: u64) -> Option<String> {
    FONT_ENGINE_KEY_HASHES.with(|c| c.borrow().get(&hash).cloned())
}

fn remember_engine_key(url: &str, key: u64) {
    FONT_ENGINE_KEYS.with(|c| {
        c.borrow_mut().insert(url.to_string(), key.to_string());
    });
}

fn engine_key_for_url(url: &str) -> Option<String> {
    FONT_ENGINE_KEYS.with(|c| c.borrow().get(url).cloned())
}

pub(crate) fn font_url_for_hash(hash: u64) -> Option<String> {
    FONT_URL_HASHES.with(|c| c.borrow().get(&hash).cloned())
}

thread_local! {
    static AUTHOR_LAZY: RefCell<Vec<(String, Vec<LazyFaceRecord>)>> =
        const { RefCell::new(Vec::new()) };
}

pub(crate) fn stash_author_upgrades(regs: Vec<blitz_dom::AuthorFontRegistration>) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    AUTHOR_LAZY.with(|c| {
        let mut stash = c.borrow_mut();
        for reg in regs {
            let h = font_data_key(fx_hash_u64(reg.bytes.data()), 0);
            let Some(url) = font_url_for_hash(h) else {
                continue;
            };
            let face = LazyFaceRecord {
                family: reg.family,
                width: reg.width,
                style: reg.style,
                weight: reg.weight,
            };
            if let Some((_, faces)) = stash.iter_mut().find(|(u, _)| *u == url) {
                faces.push(face);
            } else {
                stash.push((url.clone(), vec![face]));
                urls.push(url);
            }
        }
    });
    urls
}

/// JS-callable: swap one author face set to its full file (custody
/// or re-fetched bytes). Decompresses the woff container, then
/// unregister + re-register under the SAME family name/attrs so the
/// FamilyId — and every style rule resolving it — survives.
#[wasm_bindgen(js_name = "upgradeAuthorFontFace")]
pub fn upgrade_author_font_face(url: String, full_bytes: Vec<u8>) -> bool {
    let Some((_, faces)) = AUTHOR_LAZY.with(|c| {
        let mut stash = c.borrow_mut();
        stash
            .iter()
            .position(|(u, _)| *u == url)
            .map(|i| stash.remove(i))
    }) else {
        return false;
    };
    let processed: Vec<u8> = strip_woff_container(full_bytes);
    if processed.is_empty() || !has_outline_tables(&processed) {
        return false;
    }
    note_font_url(&processed, &url);
    if let Some(key) = engine_key_for_url(&url) {
        note_font_engine_key(&processed, &key);
    }
    SHARED_FONT_CONTEXT.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let Some(font_ctx) = borrow.as_mut() else {
            return false;
        };
        let blob = Blob::from(processed);
        let mut any = false;
        for face in &faces {
            let family_name = font_ctx
                .collection
                .family_name(face.family)
                .map(|n| n.to_string());
            font_ctx
                .collection
                .unregister_font(face.family, face.width, face.style, face.weight);
            let override_info = parley::fontique::FontInfoOverride {
                family_name: family_name.as_deref(),
                width: Some(face.width),
                style: Some(face.style),
                weight: Some(face.weight),
                ..Default::default()
            };
            let registered = font_ctx
                .collection
                .register_fonts(blob.clone(), Some(override_info));
            any = any || !registered.is_empty();
        }
        any
    })
}

fn is_plain_sfnt(bytes: &[u8]) -> bool {
    bytes.len() >= SFNT_HEADER_BYTES
        && (bytes[0..4] == [0x00, 0x01, 0x00, 0x00] || &bytes[0..4] == b"OTTO")
}

fn strip_woff_container(bytes: Vec<u8>) -> Vec<u8> {
    match inflate_font_container(&bytes) {
        FontContainer::Inflated(sfnt) => sfnt,
        FontContainer::Sfnt | FontContainer::Refused => bytes,
    }
}

fn strip_fetched_font(bytes: Vec<u8>) -> Vec<u8> {
    let decompressed = strip_woff_container(bytes);
    strip_outline_tables(&decompressed).unwrap_or(decompressed)
}

struct LazyFaceRecord {
    family: FamilyId,
    width: parley::fontique::FontWidth,
    style: parley::fontique::FontStyle,
    weight: parley::fontique::FontWeight,
}

// One record per registration. A blob registered under N family-name aliases leaves N records on
// one path; `family_name` is None for the font's own name.
struct LazyBlobRecord {
    path: &'static str,
    svg_slot: Option<blitz_dom::util::SvgGenericSlot>,
    family_name: Option<&'static str>,
    faces: Vec<LazyFaceRecord>,
}

thread_local! {
    static LAZY_REGISTERED: RefCell<Vec<LazyBlobRecord>> =
        const { RefCell::new(Vec::new()) };
}

fn record_lazy_registration(
    path: &'static str,
    svg_slot: Option<blitz_dom::util::SvgGenericSlot>,
    family_name: Option<&'static str>,
    result: &[(FamilyId, Vec<parley::fontique::FontInfo>)],
) {
    if font_mode() != FontMode::Lazy || result.is_empty() {
        return;
    }
    let faces = result
        .iter()
        .flat_map(|(family, fonts)| {
            let family = *family;
            fonts.iter().map(move |f| LazyFaceRecord {
                family,
                width: f.width(),
                style: f.style(),
                weight: f.weight(),
            })
        })
        .collect();
    LAZY_REGISTERED.with(|c| {
        c.borrow_mut().push(LazyBlobRecord {
            path,
            svg_slot,
            family_name,
            faces,
        });
    });
}

pub(crate) fn upgrade_recorded_face(
    font_ctx: &mut FontContext,
    path: &str,
    full_bytes: Vec<u8>,
) -> bool {
    let records: Vec<LazyBlobRecord> =
        LAZY_REGISTERED.with(|c| c.borrow_mut().extract_if(.., |r| r.path == path).collect());
    let Some(first) = records.first() else {
        return false;
    };
    if full_bytes.is_empty() || !has_outline_tables(&full_bytes) {
        LAZY_REGISTERED.with(|c| c.borrow_mut().extend(records));
        return false;
    }
    for face in records.iter().flat_map(|r| &r.faces) {
        font_ctx
            .collection
            .unregister_font(face.family, face.width, face.style, face.weight);
    }
    note_font_asset(&full_bytes, first.path);
    let blob = Blob::from(full_bytes);
    let svg_slot = records.iter().find_map(|r| r.svg_slot);
    blitz_dom::util::register_svg_font(Arc::new(blob.clone()), svg_slot);
    let mut registered = false;
    for record in &records {
        let info = record.family_name.map(|name| FontInfoOverride {
            family_name: Some(name),
            ..Default::default()
        });
        registered |= !font_ctx
            .collection
            .register_fonts(blob.clone(), info)
            .is_empty();
    }
    registered
}

pub(crate) fn has_pending_lazy_faces() -> bool {
    LAZY_REGISTERED.with(|c| !c.borrow().is_empty())
}

pub(crate) fn pending_lazy_face_paths() -> Vec<String> {
    LAZY_REGISTERED.with(|c| {
        let mut paths: Vec<String> = Vec::new();
        for record in c.borrow().iter() {
            if !paths.iter().any(|p| p == record.path) {
                paths.push(record.path.to_string());
            }
        }
        paths
    })
}

/// JS-callable: asset paths awaiting the full-file swap, in
/// registration order. Empty array outside Lazy mode.
#[wasm_bindgen(js_name = "pendingLazyFontPaths")]
pub fn pending_lazy_font_paths_js() -> Vec<String> {
    if font_mode() != FontMode::Lazy {
        return Vec::new();
    }
    pending_lazy_face_paths()
}

/// JS-callable: swap one recorded face to its full file. Returns
/// true when the swap happened (see upgrade_recorded_face).
#[wasm_bindgen(js_name = "upgradeFontFace")]
pub fn upgrade_font_face(path: String, full_bytes: Vec<u8>) -> bool {
    let _ks_span = tracing::info_span!(
        "wasm.font_upgrade",
        path = %path,
        bytes = full_bytes.len(),
    )
    .entered();
    if font_mode() != FontMode::Lazy {
        return false;
    }
    SHARED_FONT_CONTEXT.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let Some(font_ctx) = borrow.as_mut() else {
            return false;
        };
        upgrade_recorded_face(font_ctx, &path, full_bytes)
    })
}

/// JS-callable: flip Lazy→Full once every recorded face has been
/// swapped, so later lazy registrations fetch full files directly.
#[wasm_bindgen(js_name = "finishFontUpgrade")]
pub fn finish_font_upgrade() -> bool {
    if font_mode() == FontMode::Lazy && !has_pending_lazy_faces() {
        set_font_mode(FontMode::Full);
        return true;
    }
    false
}

fn note_font_asset(bytes: &[u8], path: &'static str) {
    let h = font_data_key(fx_hash_u64(bytes), 0);
    FONT_ASSET_HASHES.with(|c| {
        c.borrow_mut().insert(h, path);
    });
}

pub(crate) fn font_asset_name_for_hash(hash: u64) -> Option<&'static str> {
    FONT_ASSET_HASHES.with(|c| c.borrow().get(&hash).copied())
}

fn rebuild_common_fallbacks(font_ctx: &mut FontContext) {
    let mut chain: Vec<FamilyId> = Vec::new();
    BASE_COMMON_IDS.with(|c| chain.extend(c.borrow().iter().copied()));
    LATIN_FALLBACK_IDS.with(|c| chain.extend(c.borrow().iter().copied()));
    EMOJI_IDS.with(|c| chain.extend(c.borrow().iter().copied()));
    SYMBOL_IDS.with(|c| chain.extend(c.borrow().iter().copied()));
    // Fullwidth punctuation and ideographic spaces are Common. A regional face, loaded only for
    // its language, wins over SC.
    CJK_JP_IDS.with(|c| chain.extend(c.borrow().iter().copied()));
    CJK_TC_IDS.with(|c| chain.extend(c.borrow().iter().copied()));
    CJK_IDS.with(|c| chain.extend(c.borrow().iter().copied()));
    font_ctx
        .collection
        .set_fallbacks(Script::COMMON, chain.iter().copied());
    let latn = Script::from_bytes(*b"Latn");
    font_ctx
        .collection
        .set_fallbacks(latn, chain.iter().copied());
}

/// Register fetched WOFF2 or raw OpenType emoji bytes in the shared context.
/// Aliases share one Blob and join Common fallback, so CSS need not name an
/// emoji family.
/// Returns true on the first call and false thereafter.
#[wasm_bindgen]
pub fn register_emoji_font(bytes: &[u8]) -> bool {
    let _ks_span =
        tracing::info_span!("wasm.font_register", kind = "emoji", bytes = bytes.len()).entered();
    if EMOJI_FONT_REGISTERED.with(|c| c.get()) {
        return false;
    }

    let aliases = [
        "Apple Color Emoji",
        "Segoe UI Emoji",
        "Segoe UI Symbol",
        "Noto Color Emoji",
        "EmojiOne",
        "Twemoji Mozilla",
        "Kitesurf Emoji",
    ];

    let mut opentype_bytes: Vec<u8> =
        wuff::decompress_woff2(bytes).unwrap_or_else(|_| bytes.to_vec());

    if crate::renderer_mode() {
        if let Some(stripped) = strip_sfnt_tables(&opentype_bytes, &EMOJI_STRIP_TABLES) {
            opentype_bytes = stripped;
        }
    }

    note_font_asset(&opentype_bytes, "/fonts/noto-color-emoji.woff2");

    SHARED_FONT_CONTEXT.with(|cell| {
        let mut borrow = cell.borrow_mut();
        if borrow.is_none() {
            *borrow = Some(make_empty_font_context());
        }
        let font_ctx = borrow.as_mut().unwrap();
        let blob_bytes: Arc<dyn AsRef<[u8]> + Send + Sync> = Arc::new(opentype_bytes);
        let blob = Blob::new(blob_bytes);

        let mut registered_family_ids: Vec<FamilyId> = Vec::new();
        for alias in aliases {
            let override_info = FontInfoOverride {
                family_name: Some(alias),
                ..Default::default()
            };
            let result = font_ctx
                .collection
                .register_fonts(blob.clone(), Some(override_info));
            for (family_id, _) in result {
                registered_family_ids.push(family_id);
            }
        }

        EMOJI_IDS.with(|c| {
            c.borrow_mut().clear();
            c.borrow_mut().extend(registered_family_ids.iter().copied());
        });
        rebuild_common_fallbacks(font_ctx);
    });

    EMOJI_FONT_REGISTERED.with(|c| c.set(true));
    true
}

/// CJK faces by region. SC is the Han default; JP and TC take Han in `lang="ja"` and
/// `lang="zh-TW"` (or HK, MO) text, where the same codepoints have regional glyph forms, and
/// kana prefers JP. Each face carries the CSS family names of its region's platform fonts.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CjkRegion {
    Sc,
    Jp,
    Tc,
}

impl CjkRegion {
    fn path(self) -> &'static str {
        match self {
            Self::Sc => "/fonts/NotoSansCJKsc-Regular.woff2",
            Self::Jp => "/fonts/NotoSansCJKjp-Regular.woff2",
            Self::Tc => "/fonts/NotoSansCJKtc-Regular.woff2",
        }
    }

    fn aliases(self) -> &'static [&'static str] {
        match self {
            // Korean has its Hangul script face; its Hanja come from SC.
            Self::Sc => &[
                "PingFang SC",
                "Hiragino Sans GB",
                "Microsoft YaHei",
                "Microsoft YaHei UI",
                "SimHei",
                "SimSun",
                "Source Han Sans SC",
                "Noto Sans CJK SC",
                "Noto Sans SC",
                "Apple SD Gothic Neo",
            ],
            Self::Jp => &[
                "Hiragino Sans",
                "Hiragino Kaku Gothic Pro",
                "Hiragino Kaku Gothic ProN",
                "Yu Gothic",
                "YuGothic",
                "Meiryo",
                "MS Gothic",
                "MS PGothic",
                "Source Han Sans JP",
                "Noto Sans CJK JP",
                "Noto Sans JP",
            ],
            Self::Tc => &[
                "PingFang TC",
                "PingFang HK",
                "Microsoft JhengHei",
                "PMingLiU",
                "Source Han Sans TC",
                "Noto Sans CJK TC",
                "Noto Sans TC",
            ],
        }
    }

    fn ids(self) -> &'static std::thread::LocalKey<RefCell<Vec<FamilyId>>> {
        match self {
            Self::Sc => &CJK_IDS,
            Self::Jp => &CJK_JP_IDS,
            Self::Tc => &CJK_TC_IDS,
        }
    }
}

/// Rebuild the Han, kana and Common chains from whichever CJK faces are registered, so the
/// order holds whatever order they arrive in. fontique appends the default Han list to every
/// query, so a locale list needs only its own face.
fn rebuild_cjk_fallbacks(font_ctx: &mut FontContext) {
    let ids = |region: CjkRegion| region.ids().with(|c| c.borrow().clone());
    let (sc, jp, tc) = (ids(CjkRegion::Sc), ids(CjkRegion::Jp), ids(CjkRegion::Tc));
    let han = Script::from_bytes(*b"Hani");
    let c = &mut font_ctx.collection;
    c.set_fallbacks(han, sc.iter().copied());
    c.set_fallbacks((han, "ja"), jp.iter().copied());
    for locale in ["zh-TW", "zh-HK", "zh-MO"] {
        c.set_fallbacks((han, locale), tc.iter().copied());
    }
    for kana in [*b"Hira", *b"Kana"] {
        c.set_fallbacks(Script::from_bytes(kana), jp.iter().chain(&sc).copied());
    }
    rebuild_common_fallbacks(font_ctx);
}

/// Register a fetched CJK face (WOFF2 or raw OpenType) under its region's aliases. Returns
/// false when the region is already registered or there is no shared context yet.
fn register_cjk_region(bytes: &[u8], region: CjkRegion) -> bool {
    if region.ids().with(|c| !c.borrow().is_empty()) {
        return false;
    }
    let mut opentype: Vec<u8> = wuff::decompress_woff2(bytes).unwrap_or_else(|_| bytes.to_vec());
    if crate::renderer_mode() {
        if let Some(stripped) = strip_sfnt_tables(&opentype, &OUTLINE_STRIP_TABLES) {
            opentype = stripped;
        }
    }
    SHARED_FONT_CONTEXT.with(|cell| {
        let mut borrow = cell.borrow_mut();
        // PageScript registers the UA faces, and with them the context, before any CJK face.
        let Some(font_ctx) = borrow.as_mut() else {
            return false;
        };
        note_font_asset(&opentype, region.path());
        let blob_bytes: Arc<dyn AsRef<[u8]> + Send + Sync> = Arc::new(opentype);
        let blob = Blob::new(blob_bytes);
        let mut ids: Vec<FamilyId> = Vec::new();
        for alias in region.aliases() {
            let override_info = FontInfoOverride {
                family_name: Some(alias),
                ..Default::default()
            };
            for (id, _) in font_ctx
                .collection
                .register_fonts(blob.clone(), Some(override_info))
            {
                ids.push(id);
            }
        }
        if region == CjkRegion::Sc {
            // Hangul text still needs SC for Hanja and CJK punctuation.
            font_ctx
                .collection
                .append_fallbacks(Script::from_bytes(*b"Hang"), ids.iter().copied());
        }
        region.ids().with(|c| *c.borrow_mut() = ids);
        rebuild_cjk_fallbacks(font_ctx);
        true
    })
}

/// Register Noto Sans CJK SC, the Han default, when content needs CJK. It has no Hangul
/// syllables, which come from the `Hang` script face; Korean text still needs it for Hanja.
/// Returns true only on the first registration.
#[wasm_bindgen]
pub fn register_cjk_font(bytes: &[u8]) -> bool {
    let _ks_span =
        tracing::info_span!("wasm.font_register", kind = "cjk", bytes = bytes.len()).entered();
    if CJK_FONT_REGISTERED.with(|c| c.get()) {
        return false;
    }
    let ok = register_cjk_region(bytes, CjkRegion::Sc);
    if ok {
        CJK_FONT_REGISTERED.with(|c| c.set(true));
    }
    ok
}

/// Register the Japanese (`"JP"`) or Traditional Chinese (`"TC"`) face. Han in text of that
/// language, and kana for JP, prefer it over SC. Unknown regions and repeat calls return false.
#[wasm_bindgen]
pub fn register_cjk_region_font(bytes: &[u8], region: &str) -> bool {
    let _ks_span = tracing::info_span!(
        "wasm.font_register",
        kind = "cjk",
        region,
        bytes = bytes.len()
    )
    .entered();
    let region = match region {
        "JP" => CjkRegion::Jp,
        "TC" => CjkRegion::Tc,
        _ => return false,
    };
    register_cjk_region(bytes, region)
}

const SCRIPT_FONT_ASSETS: &[(&str, &str)] = &[
    // Only for a profile with `latin_fallback`; it joins the rebuilt Common and Latin chains.
    ("Latn", "/fonts/NotoSans.ttf"),
    ("Arab", "/fonts/NotoSansArabic.ttf"),
    ("Hebr", "/fonts/NotoSansHebrew.ttf"),
    ("Deva", "/fonts/NotoSansDevanagari.ttf"),
    ("Thai", "/fonts/NotoSansThai.ttf"),
    ("Beng", "/fonts/NotoSansBengali.ttf"),
    ("Taml", "/fonts/NotoSansTamil.ttf"),
    ("Ethi", "/fonts/NotoSansEthiopic.ttf"),
    ("Guru", "/fonts/NotoSansGurmukhi.ttf"),
    ("Gujr", "/fonts/NotoSansGujarati.ttf"),
    ("Knda", "/fonts/NotoSansKannada.ttf"),
    ("Mlym", "/fonts/NotoSansMalayalam.ttf"),
    ("Telu", "/fonts/NotoSansTelugu.ttf"),
    ("Sinh", "/fonts/NotoSansSinhala.ttf"),
    ("Mymr", "/fonts/NotoSansMyanmar.ttf"),
    ("Khmr", "/fonts/NotoSansKhmer.ttf"),
    ("Laoo", "/fonts/NotoSansLao.ttf"),
    ("Geor", "/fonts/NotoSansGeorgian.ttf"),
    ("Armn", "/fonts/NotoSansArmenian.ttf"),
    // The CJK asset is the Noto Sans SC subset, which has no Hangul syllables.
    ("Hang", "/fonts/NotoSansKR.ttf"),
];

/// Register a fetched Noto face in its script fallback chain. Idempotent per tag.
/// Empty bytes or non-four-byte tags return false. Unknown tags also return false
/// because the renderer needs a matching asset path.
#[wasm_bindgen]
pub fn register_script_font(bytes: Vec<u8>, script_tag: String) -> bool {
    let _ks_span = tracing::info_span!(
        "wasm.font_register",
        kind = "script",
        script = %script_tag,
        bytes = bytes.len(),
    )
    .entered();
    if bytes.is_empty() || script_tag.len() != 4 {
        return false;
    }
    let Some(path) = SCRIPT_FONT_ASSETS
        .iter()
        .find(|(t, _)| *t == script_tag)
        .map(|(_, p)| *p)
    else {
        return false;
    };
    if SCRIPT_FONTS_REGISTERED.with(|c| c.borrow().contains(&script_tag)) {
        return false;
    }
    let latin = script_tag == "Latn";
    if latin
        && !UA_FONT_PROFILE
            .with(|c| c.get())
            .is_some_and(|p| p.latin_fallback)
    {
        return false;
    }
    let Ok(tag_bytes) = <[u8; 4]>::try_from(script_tag.as_bytes()) else {
        return false;
    };
    let script = Script::from_bytes(tag_bytes);
    let bytes = maybe_strip_for_session(bytes);
    note_font_asset(&bytes, path);

    SHARED_FONT_CONTEXT.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let font_ctx = borrow.get_or_insert_with(make_empty_font_context);
        let blob = Blob::from(bytes);
        let result = font_ctx.collection.register_fonts(blob, None);
        record_lazy_registration(path, None, None, &result);
        let ids: Vec<FamilyId> = result.into_iter().map(|(id, _)| id).collect();
        if latin {
            // rebuild_common_fallbacks owns the Latin chain and would drop an appended entry.
            LATIN_FALLBACK_IDS.with(|c| *c.borrow_mut() = ids);
            rebuild_common_fallbacks(font_ctx);
        } else {
            font_ctx
                .collection
                .append_fallbacks(script, ids.iter().copied());
        }
    });

    SCRIPT_FONTS_REGISTERED.with(|c| {
        c.borrow_mut().insert(script_tag);
    });
    true
}

pub fn get_or_init_font_context() -> FontContext {
    SHARED_FONT_CONTEXT.with(|cell| {
        let mut borrow = cell.borrow_mut();
        if borrow.is_none() {
            #[cfg(test)]
            {
                *borrow = Some(make_font_context());
            }
            #[cfg(not(test))]
            {
                *borrow = Some(make_empty_font_context());
            }
        }
        borrow.as_ref().unwrap().clone()
    })
}

/// Return each registered family and its face attributes as JSON.
#[wasm_bindgen]
pub fn font_families_json() -> String {
    let mut ctx = get_or_init_font_context();
    let names: Vec<String> = ctx
        .collection
        .family_names()
        .map(|s| s.to_string())
        .collect();
    let mut families = Vec::with_capacity(names.len());
    for name in names {
        let Some(info) = ctx.collection.family_by_name(&name) else {
            continue;
        };
        let faces: Vec<serde_json::Value> = info
            .fonts()
            .iter()
            .map(|f| {
                serde_json::json!({
                    "weight": f.weight().value(),
                    "style": format!("{:?}", f.style()),
                    "width": f.width().ratio(),
                    "hasWghtAxis": f.has_weight_axis(),
                    "axisCount": f.axes().len(),
                })
            })
            .collect();
        families.push(serde_json::json!({
            "family": name,
            "faceCount": faces.len(),
            "faces": faces,
        }));
    }
    serde_json::json!(families).to_string()
}

#[cfg(test)]
const NOTO_SANS_TEST_BYTES: &[u8] = include_bytes!("../../../engine/public/fonts/NotoSans.ttf");
#[cfg(test)]
const NOTO_SANS_ITALIC_TEST_BYTES: &[u8] =
    include_bytes!("../../../engine/public/fonts/NotoSans-Italic.ttf");
#[cfg(test)]
const NOTO_SERIF_TEST_BYTES: &[u8] = include_bytes!("../../../engine/public/fonts/NotoSerif.ttf");
#[cfg(test)]
const NOTO_SANS_MONO_TEST_BYTES: &[u8] =
    include_bytes!("../../../engine/public/fonts/NotoSansMono.ttf");
#[cfg(test)]
const NOTO_SANS_SYMBOLS_TEST_BYTES: &[u8] =
    include_bytes!("../../../engine/public/fonts/NotoSansSymbols.ttf");
#[cfg(test)]
const NOTO_SANS_SYMBOLS2_TEST_BYTES: &[u8] =
    include_bytes!("../../../engine/public/fonts/NotoSansSymbols2.ttf");

fn make_empty_font_context() -> FontContext {
    FontContext {
        source_cache: SourceCache::new_shared(),
        collection: Collection::new(CollectionOptions {
            shared: true,
            system_fonts: false,
        }),
    }
}

/// The UA faces a font profile registers, as the asset paths page-script fetches and the renderer
/// paints from, in `register_ua_fonts` argument order, and the platform family names each family
/// answers to. An empty path leaves its slot out. The engine's `cdp/font-profile.ts` validates
/// profile names against this table.
pub(crate) struct UaFontProfile {
    pub name: &'static str,
    /// Upright, italic. Behind sans-serif; also behind system-ui when `system` is empty.
    pub sans: [&'static str; 2],
    /// Upright, italic. Behind system-ui, ui-sans-serif and ui-rounded.
    pub system: [&'static str; 2],
    /// Regular, bold, italic. Behind serif.
    pub serif: [&'static str; 3],
    /// Upright, italic. Named only through `georgia_aliases`.
    pub georgia: [&'static str; 2],
    pub sans_aliases: &'static [&'static str],
    pub system_aliases: &'static [&'static str],
    pub serif_aliases: &'static [&'static str],
    pub georgia_aliases: &'static [&'static str],
    /// page-script fetches the serif faces only for pages that name a serif family.
    pub serif_on_demand: bool,
    /// Noto Sans loads as the `Latn` script face for the Latin codepoints the UA faces lack.
    pub latin_fallback: bool,
}

impl UaFontProfile {
    fn paths(&self) -> [&'static str; 9] {
        let [sans, sans_italic] = self.sans;
        let [system, system_italic] = self.system;
        let [serif, serif_bold, serif_italic] = self.serif;
        let [georgia, georgia_italic] = self.georgia;
        [
            sans,
            sans_italic,
            system,
            system_italic,
            serif,
            serif_bold,
            serif_italic,
            georgia,
            georgia_italic,
        ]
    }
}

const MONO_PATH: &str = "/fonts/NotoSansMono.ttf";

/// `noto`, the default: Noto Sans behind every sans generic, Noto Serif for pages that name a
/// serif family, and no platform family names.
const NOTO_PROFILE: UaFontProfile = UaFontProfile {
    name: "noto",
    sans: ["/fonts/NotoSans.ttf", "/fonts/NotoSans-Italic.ttf"],
    system: ["", ""],
    serif: ["/fonts/NotoSerif.ttf", "", ""],
    georgia: ["", ""],
    sans_aliases: &[],
    system_aliases: &[],
    serif_aliases: &[],
    georgia_aliases: &[],
    serif_on_demand: true,
    latin_fallback: false,
};

/// `macos`: families resolve as in Chrome on macOS. Arimo, Tinos and Gelasio match Arial,
/// Times New Roman and Georgia advance for advance, so lines break where Chrome's do; Inter
/// stands in for SF Pro. Segoe UI stays unaliased, so a stack naming it moves on, as on a Mac.
const MACOS_PROFILE: UaFontProfile = UaFontProfile {
    name: "macos",
    sans: ["/fonts/Arimo.ttf", "/fonts/Arimo-Italic.ttf"],
    system: [
        "/fonts/InterVariable.ttf",
        "/fonts/InterVariable-Italic.ttf",
    ],
    serif: [
        "/fonts/Tinos-Regular.ttf",
        "/fonts/Tinos-Bold.ttf",
        "/fonts/Tinos-Italic.ttf",
    ],
    georgia: ["/fonts/Gelasio.ttf", "/fonts/Gelasio-Italic.ttf"],
    sans_aliases: &["Arial", "Helvetica", "Helvetica Neue", "Liberation Sans"],
    // Blitz maps -apple-system to system-ui only on Apple targets, never in wasm.
    system_aliases: &[
        "-apple-system",
        "BlinkMacSystemFont",
        "SF Pro",
        "SF Pro Text",
        "SF Pro Display",
    ],
    serif_aliases: &["Times", "Times New Roman", "Liberation Serif"],
    georgia_aliases: &["Georgia"],
    serif_on_demand: false,
    latin_fallback: true,
};

const UA_FONT_PROFILES: [&UaFontProfile; 2] = [&NOTO_PROFILE, &MACOS_PROFILE];

fn ua_font_profile(name: &str) -> Option<&'static UaFontProfile> {
    UA_FONT_PROFILES.into_iter().find(|p| p.name == name)
}

/// JS-callable: the profile's UA faces as JSON, `{faces, serifOnDemand, latinFallback}` with
/// `faces` in `register_ua_fonts` order ("" = none), so page-script fetches exactly what
/// registration records. Empty for an unknown profile.
#[wasm_bindgen(js_name = "uaFontProfile")]
pub fn ua_font_profile_json(profile: &str) -> String {
    ua_font_profile(profile)
        .map(|p| {
            serde_json::json!({
                "faces": p.paths(),
                "serifOnDemand": p.serif_on_demand,
                "latinFallback": p.latin_fallback,
            })
            .to_string()
        })
        .unwrap_or_default()
}

/// UA face bytes in `UaFontProfile` slot order. Sans is required; an empty face is skipped and
/// its generics fall back to sans.
#[derive(Default)]
pub(crate) struct UaFontBytes {
    pub sans: [Vec<u8>; 2],
    pub system: [Vec<u8>; 2],
    pub serif: [Vec<u8>; 3],
    pub georgia: [Vec<u8>; 2],
    pub mono: Vec<u8>,
}

/// Register one family's faces, each under the font's own name and every alias, all on the
/// same Blob. Italic and bold files carry their upright's family name, so they share its
/// FamilyId and `font-style: italic` finds a real italic. Returns the family's ids.
fn register_ua_family<const N: usize>(
    c: &mut Collection,
    faces: [Vec<u8>; N],
    paths: [&'static str; N],
    slot: Option<blitz_dom::util::SvgGenericSlot>,
    aliases: &[&'static str],
) -> Vec<FamilyId> {
    let mut ids: Vec<FamilyId> = Vec::new();
    for (i, (bytes, path)) in faces.into_iter().zip(paths).enumerate() {
        if bytes.is_empty() || path.is_empty() {
            continue;
        }
        // usvg's generic slot goes to the first face; it has no system fonts under wasm.
        let slot = if i == 0 { slot } else { None };
        // Outline-less faces stay out of usvg, which would drop their text instead of falling
        // back to a face it can paint.
        let svg_usable = has_outline_tables(&bytes);
        let blob = Blob::from(bytes);
        if svg_usable {
            blitz_dom::util::register_svg_font(Arc::new(blob.clone()), slot);
        }
        let result = c.register_fonts(blob.clone(), None);
        record_lazy_registration(path, slot, None, &result);
        for alias in aliases {
            let info = FontInfoOverride {
                family_name: Some(alias),
                ..Default::default()
            };
            let aliased = c.register_fonts(blob.clone(), Some(info));
            record_lazy_registration(path, None, Some(alias), &aliased);
        }
        for (id, _) in result {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

fn populate_ua_fonts(font_ctx: &mut FontContext, profile: &UaFontProfile, faces: UaFontBytes) {
    use blitz_dom::util::SvgGenericSlot;
    let c = &mut font_ctx.collection;
    let sans = register_ua_family(
        c,
        faces.sans,
        profile.sans,
        Some(SvgGenericSlot::SansSerif),
        profile.sans_aliases,
    );
    let system = register_ua_family(
        c,
        faces.system,
        profile.system,
        None,
        profile.system_aliases,
    );
    let serif = register_ua_family(
        c,
        faces.serif,
        profile.serif,
        Some(SvgGenericSlot::Serif),
        profile.serif_aliases,
    );
    register_ua_family(
        c,
        faces.georgia,
        profile.georgia,
        None,
        profile.georgia_aliases,
    );
    if !faces.mono.is_empty() {
        if let Some(r) = measure_mono_advance_per_em(&faces.mono) {
            MONO_ADVANCE_PER_EM.with(|c| c.set(r));
        }
    }
    let mono = register_ua_family(
        c,
        [faces.mono],
        [MONO_PATH],
        Some(SvgGenericSlot::Monospace),
        &[],
    );
    let or_sans = |ids: &[FamilyId]| {
        if ids.is_empty() {
            sans.clone()
        } else {
            ids.to_vec()
        }
    };
    let system_family = or_sans(&system);
    let serif_family = or_sans(&serif);
    let mono_family = or_sans(&mono);

    // ui-sans-serif and ui-rounded are SF on macOS, so they follow system-ui.
    for (generic, ids) in [
        (GenericFamily::SansSerif, &sans),
        (GenericFamily::SystemUi, &system_family),
        (GenericFamily::UiSansSerif, &system_family),
        (GenericFamily::UiRounded, &system_family),
        (GenericFamily::Serif, &serif_family),
        (GenericFamily::UiSerif, &serif_family),
        (GenericFamily::FangSong, &serif_family),
        (GenericFamily::Monospace, &mono_family),
        (GenericFamily::UiMonospace, &mono_family),
        (GenericFamily::Cursive, &sans),
        (GenericFamily::Fantasy, &sans),
        (GenericFamily::Math, &sans),
        (GenericFamily::Emoji, &sans),
    ] {
        c.set_generic_families(generic, ids.iter().copied());
    }

    let mut base: Vec<FamilyId> = Vec::new();
    for id in [&sans, &system, &serif, &mono].into_iter().flatten() {
        if !base.contains(id) {
            base.push(*id);
        }
    }
    BASE_COMMON_IDS.with(|c| {
        c.borrow_mut().clear();
        c.borrow_mut().extend(base.iter().copied());
    });
    rebuild_common_fallbacks(font_ctx);
}

fn add_symbol_fonts(font_ctx: &mut FontContext, symbols_bytes: Vec<u8>, symbols2_bytes: Vec<u8>) {
    let mut blobs = vec![(symbols_bytes, "/fonts/NotoSansSymbols.ttf")];
    if !symbols2_bytes.is_empty() {
        blobs.push((symbols2_bytes, "/fonts/NotoSansSymbols2.ttf"));
    }
    let mut ids: Vec<FamilyId> = Vec::new();
    for (bytes, path) in blobs {
        let result = font_ctx.collection.register_fonts(Blob::from(bytes), None);
        record_lazy_registration(path, None, None, &result);
        for (id, _) in result {
            ids.push(id);
        }
    }
    SYMBOL_IDS.with(|c| {
        c.borrow_mut().clear();
        c.borrow_mut().extend(ids.iter().copied());
    });
    rebuild_common_fallbacks(font_ctx);
}

/// Lazily register symbol fallback faces. Symbols bytes are required; Symbols 2
/// is optional. Later calls return false.
#[wasm_bindgen]
pub fn register_symbol_fonts(symbols_bytes: Vec<u8>, symbols2_bytes: Vec<u8>) -> bool {
    let _ks_span = tracing::info_span!(
        "wasm.font_register",
        kind = "symbols",
        bytes = symbols_bytes.len() + symbols2_bytes.len()
    )
    .entered();
    if SYMBOL_FONTS_REGISTERED.with(|c| c.get()) {
        return false;
    }
    if symbols_bytes.is_empty() {
        return false;
    }
    let symbols_bytes = maybe_strip_for_session(symbols_bytes);
    let symbols2_bytes = maybe_strip_for_session(symbols2_bytes);
    note_font_asset(&symbols_bytes, "/fonts/NotoSansSymbols.ttf");
    if !symbols2_bytes.is_empty() {
        note_font_asset(&symbols2_bytes, "/fonts/NotoSansSymbols2.ttf");
    }
    SHARED_FONT_CONTEXT.with(|cell| {
        let mut borrow = cell.borrow_mut();
        if borrow.is_none() {
            *borrow = Some(make_empty_font_context());
        }
        let font_ctx = borrow.as_mut().unwrap();
        add_symbol_fonts(font_ctx, symbols_bytes, symbols2_bytes);
    });
    SYMBOL_FONTS_REGISTERED.with(|c| c.set(true));
    true
}

thread_local! {
    static MONO_ADVANCE_PER_EM: std::cell::Cell<f32> =
        const { std::cell::Cell::new(0.0) };
}

fn measure_mono_advance_per_em(bytes: &[u8]) -> Option<f32> {
    use skrifa::raw::TableProvider;
    use skrifa::{FontRef, MetadataProvider};
    let font = FontRef::new(bytes).ok()?;
    let upem = font.head().ok()?.units_per_em() as f32;
    if upem <= 0.0 {
        return None;
    }
    let gid = font.charmap().map('M')?;
    let advance = font.hmtx().ok()?.advance(gid)? as f32;
    if advance <= 0.0 {
        return None;
    }
    Some(advance / upem)
}

/// Return the registered mono advance per em, or zero when unavailable.
#[wasm_bindgen(js_name = "monoAdvancePerEm")]
pub fn mono_advance_per_em() -> f32 {
    MONO_ADVANCE_PER_EM.with(|c| c.get())
}

/// Register the profile's UA fonts before constructing a DomHandle. Each argument is the face at
/// the matching `uaFontProfile` path ("" paths take empty bytes). Sans and its italic are
/// required; an empty optional face leaves its generics on sans. An unknown profile, missing
/// required bytes or a repeat call returns false.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn register_ua_fonts(
    sans_bytes: Vec<u8>,
    sans_italic_bytes: Vec<u8>,
    system_bytes: Vec<u8>,
    system_italic_bytes: Vec<u8>,
    serif_bytes: Vec<u8>,
    serif_bold_bytes: Vec<u8>,
    serif_italic_bytes: Vec<u8>,
    georgia_bytes: Vec<u8>,
    georgia_italic_bytes: Vec<u8>,
    mono_bytes: Vec<u8>,
    profile: &str,
) -> bool {
    let _ks_span = tracing::info_span!("wasm.font_register", kind = "ua", profile).entered();
    if UA_FONTS_REGISTERED.with(|c| c.get()) {
        return false;
    }
    let Some(profile) = ua_font_profile(profile) else {
        return false;
    };
    if sans_bytes.is_empty() || sans_italic_bytes.is_empty() {
        return false;
    }

    let strip = maybe_strip_for_session;
    let faces = UaFontBytes {
        sans: [strip(sans_bytes), strip(sans_italic_bytes)],
        system: [strip(system_bytes), strip(system_italic_bytes)],
        serif: [
            strip(serif_bytes),
            strip(serif_bold_bytes),
            strip(serif_italic_bytes),
        ],
        georgia: [strip(georgia_bytes), strip(georgia_italic_bytes)],
        mono: strip(mono_bytes),
    };

    // The hash covers the exact bytes the Blob will carry.
    let face_bytes = faces
        .sans
        .iter()
        .chain(&faces.system)
        .chain(&faces.serif)
        .chain(&faces.georgia)
        .chain(std::iter::once(&faces.mono));
    for (bytes, path) in face_bytes.zip(profile.paths().into_iter().chain([MONO_PATH])) {
        if !bytes.is_empty() && !path.is_empty() {
            note_font_asset(bytes, path);
        }
    }

    SHARED_FONT_CONTEXT.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let font_ctx = borrow.get_or_insert_with(make_empty_font_context);
        populate_ua_fonts(font_ctx, profile, faces);
    });

    UA_FONT_PROFILE.with(|c| c.set(Some(profile)));
    UA_FONTS_REGISTERED.with(|c| c.set(true));
    true
}

#[cfg(test)]
pub fn make_font_context() -> FontContext {
    let mut font_ctx = make_empty_font_context();
    populate_ua_fonts(
        &mut font_ctx,
        &NOTO_PROFILE,
        UaFontBytes {
            sans: [
                NOTO_SANS_TEST_BYTES.to_vec(),
                NOTO_SANS_ITALIC_TEST_BYTES.to_vec(),
            ],
            serif: [NOTO_SERIF_TEST_BYTES.to_vec(), Vec::new(), Vec::new()],
            mono: NOTO_SANS_MONO_TEST_BYTES.to_vec(),
            ..Default::default()
        },
    );
    add_symbol_fonts(
        &mut font_ctx,
        NOTO_SANS_SYMBOLS_TEST_BYTES.to_vec(),
        NOTO_SANS_SYMBOLS2_TEST_BYTES.to_vec(),
    );
    font_ctx
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::font_container::declared_sfnt_size;

    // A cluster may need a family face other than the best/default match.
    // Verify that the query offers every registered subset face.
    #[test]
    fn query_offers_all_same_attribute_family_faces() {
        use parley::fontique::{QueryFamily, QueryStatus};

        let mut ctx = make_empty_font_context();
        for _ in 0..3 {
            let registered = ctx.collection.register_fonts(
                Blob::from(NOTO_SANS_TEST_BYTES.to_vec()),
                Some(FontInfoOverride {
                    family_name: Some("RangeFont"),
                    ..Default::default()
                }),
            );
            assert!(!registered.is_empty(), "face registered");
        }

        let mut query = ctx.collection.query(&mut ctx.source_cache);
        query.set_families([QueryFamily::Named("RangeFont")]);
        let mut offered = 0usize;
        let mut latin_covered = false;
        query.matches_with(|font| {
            offered += 1;
            if let Some(charmap) = font.charmap() {
                if charmap.map('H').is_some_and(|g| g != 0) {
                    latin_covered = true;
                }
            }
            QueryStatus::Continue
        });
        assert_eq!(offered, 3, "all three family faces offered");
        assert!(latin_covered, "offered faces cover latin");
    }

    #[test]
    fn register_emoji_font_short_circuits_repeated_calls() {
        EMOJI_FONT_REGISTERED.with(|c| c.set(false));

        let fake_bytes: Vec<u8> = vec![0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0];

        let first = register_emoji_font(&fake_bytes);
        let second = register_emoji_font(&fake_bytes);
        assert!(first, "first registration should return true");
        assert!(!second, "second registration should be a no-op");

        EMOJI_FONT_REGISTERED.with(|c| c.set(false));
    }

    fn sfnt_tags(bytes: &[u8]) -> Vec<[u8; 4]> {
        let n = u16::from_be_bytes([bytes[4], bytes[5]]) as usize;
        (0..n)
            .map(|i| bytes[12 + i * 16..12 + i * 16 + 4].try_into().unwrap())
            .collect()
    }

    fn num_glyphs(bytes: &[u8]) -> u16 {
        let n = u16::from_be_bytes([bytes[4], bytes[5]]) as usize;
        for i in 0..n {
            let e = 12 + i * 16;
            if &bytes[e..e + 4] == b"maxp" {
                let off = u32::from_be_bytes(bytes[e + 8..e + 12].try_into().unwrap()) as usize;
                return u16::from_be_bytes([bytes[off + 4], bytes[off + 5]]);
            }
        }
        0
    }

    #[test]
    fn strip_sfnt_tables_drops_render_tables_keeps_shaping() {
        let src = NOTO_SANS_SYMBOLS2_TEST_BYTES;
        let tags_before = sfnt_tags(src);
        assert!(tags_before.contains(b"post"));
        let stripped = strip_sfnt_tables(src, &[*b"post"]).expect("strips");
        let tags_after = sfnt_tags(&stripped);
        assert!(!tags_after.contains(b"post"));
        assert!(tags_after.contains(b"cmap"));
        assert!(tags_after.contains(b"hmtx"));
        assert_eq!(tags_after.len(), tags_before.len() - 1);
        assert_eq!(num_glyphs(src), num_glyphs(&stripped));
        assert!(stripped.len() < src.len());

        let mut ctx = make_empty_font_context();
        let blob = Blob::new(Arc::new(stripped) as Arc<dyn AsRef<[u8]> + Send + Sync>);
        let fams = ctx.collection.register_fonts(blob, None);
        assert!(!fams.is_empty(), "fontique rejects stripped sfnt");
    }

    fn synthetic_sfnt(tables: &[([u8; 4], u32, u32)], body: usize) -> Vec<u8> {
        let mut out = vec![0x00, 0x01, 0x00, 0x00];
        out.extend_from_slice(&(tables.len() as u16).to_be_bytes());
        out.extend_from_slice(&[0; 6]);
        for (tag, off, len) in tables {
            out.extend_from_slice(tag);
            out.extend_from_slice(&[0; 4]);
            out.extend_from_slice(&off.to_be_bytes());
            out.extend_from_slice(&len.to_be_bytes());
        }
        out.resize(out.len() + body, 0);
        out
    }

    #[test]
    fn strip_sfnt_tables_refuses_a_wrapping_table_range() {
        let font = synthetic_sfnt(
            &[(*b"cmap", 44, 4), (*b"post", 0x8000_0000, 0x8000_0010)],
            8,
        );
        assert!(strip_sfnt_tables(&font, &[*b"post"]).is_none());
    }

    #[test]
    fn strip_sfnt_tables_bounds_rebuild_of_overlapping_tables() {
        let mut font = synthetic_sfnt(
            &[(*b"cmap", 60, 8), (*b"post", 68, 4), (*b"name", 72, 0)],
            12,
        );
        font[60..68].copy_from_slice(b"payload!");
        let out = strip_sfnt_tables(&font, &[*b"post"]).expect("disjoint tables fit the bound");
        assert_eq!(sfnt_tags(&out), vec![*b"cmap", *b"name"]);
        assert_eq!(&out[44..], b"payload!");
        assert_eq!(&out[36..44], &[0, 0, 0, 52, 0, 0, 0, 0]);

        let font = synthetic_sfnt(
            &[
                (*b"cmap", 92, 60),
                (*b"post", 92, 60),
                (*b"name", 92, 60),
                (*b"head", 92, 60),
                (*b"hhea", 92, 60),
            ],
            60,
        );
        assert!(strip_sfnt_tables(&font, &[*b"post"]).is_none());
    }

    #[test]
    fn strip_sfnt_tables_writes_search_fields_for_one_table() {
        let font = synthetic_sfnt(&[(*b"cmap", 44, 4), (*b"post", 48, 4)], 8);
        let out = strip_sfnt_tables(&font, &[*b"post"]).expect("strips");
        assert_eq!(&out[4..12], &[0, 1, 0, 16, 0, 0, 0, 0]);
    }

    #[test]
    fn strip_sfnt_tables_none_when_nothing_to_drop() {
        assert!(strip_sfnt_tables(NOTO_SANS_SYMBOLS2_TEST_BYTES, &[*b"CBDT", *b"COLR"]).is_none());
        assert!(strip_sfnt_tables(b"ttcf1234", &EMOJI_STRIP_TABLES).is_none());
        assert!(strip_sfnt_tables(&[0u8; 4], &EMOJI_STRIP_TABLES).is_none());
    }

    #[test]
    fn strip_real_emoji_font_drops_bitmap_bulk() {
        let woff2: &[u8] = include_bytes!("../../../engine/public/fonts/noto-color-emoji.woff2");
        let full = wuff::decompress_woff2(woff2).expect("asset is woff2");
        let tags = sfnt_tags(&full);
        assert!(
            tags.contains(b"CBDT") || tags.contains(b"COLR"),
            "emoji asset carries color/bitmap tables"
        );
        let stripped = strip_sfnt_tables(&full, &EMOJI_STRIP_TABLES).expect("strips");
        let tags_after = sfnt_tags(&stripped);
        assert!(!tags_after.contains(b"CBDT"));
        assert!(!tags_after.contains(b"CBLC"));
        assert!(!tags_after.contains(b"COLR"));
        assert!(tags_after.contains(b"cmap"));
        assert_eq!(num_glyphs(&full), num_glyphs(&stripped));
        assert!(!tags_after.contains(b"glyf"));
        assert!(
            stripped.len() * 10 < full.len(),
            "expected >=10x shrink, got {} -> {}",
            full.len(),
            stripped.len()
        );
        let mut ctx = make_empty_font_context();
        let blob = Blob::new(Arc::new(stripped) as Arc<dyn AsRef<[u8]> + Send + Sync>);
        assert!(!ctx.collection.register_fonts(blob, None).is_empty());
    }

    #[test]
    fn strip_real_cjk_font_drops_outline_bulk() {
        let woff2: &[u8] =
            include_bytes!("../../../engine/public/fonts/NotoSansCJKsc-Regular.woff2");
        let full = wuff::decompress_woff2(woff2).expect("asset is woff2");
        let tags = sfnt_tags(&full);
        assert!(
            tags.contains(b"CFF ") || tags.contains(b"glyf"),
            "cjk asset carries outline tables"
        );
        let stripped = strip_sfnt_tables(&full, &OUTLINE_STRIP_TABLES).expect("strips");
        let tags_after = sfnt_tags(&stripped);
        assert!(!tags_after.contains(b"CFF "));
        assert!(!tags_after.contains(b"glyf"));
        assert!(tags_after.contains(b"cmap"));
        assert!(tags_after.contains(b"hmtx"));
        assert_eq!(num_glyphs(&full), num_glyphs(&stripped));
        assert!(
            stripped.len() * 4 < full.len(),
            "expected >=4x shrink, got {} -> {}",
            full.len(),
            stripped.len()
        );
        let mut ctx = make_empty_font_context();
        let blob = Blob::new(Arc::new(stripped) as Arc<dyn AsRef<[u8]> + Send + Sync>);
        assert!(!ctx.collection.register_fonts(blob, None).is_empty());
    }

    // Generate the shaping assets with `cargo test -- --ignored generate_shaping_assets`.
    // They avoid a 24 MiB CJK WOFF2 transient in Wasm, whose linear memory never shrinks.
    // Raw SFNT files are smaller than WOFF2 and pass through register_* unchanged.
    #[test]
    #[ignore]
    fn generate_shaping_assets() {
        let out_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../engine/public/fonts");
        let mut cjk_sizes = Vec::new();
        for region in ["sc", "jp", "tc"] {
            let name = format!("NotoSansCJK{region}-Regular");
            let woff2 = std::fs::read(format!("{out_dir}/{name}.woff2"))
                .unwrap_or_else(|e| panic!("read {name}.woff2: {e}"));
            let cjk = wuff::decompress_woff2(&woff2).expect("woff2");
            let stripped = strip_sfnt_tables(&cjk, &OUTLINE_STRIP_TABLES).expect("strips");
            std::fs::write(format!("{out_dir}/{name}.shaping.otf"), &stripped).unwrap();
            cjk_sizes.push((name, cjk.len(), stripped.len()));
        }
        let emoji_woff2: &[u8] =
            include_bytes!("../../../engine/public/fonts/noto-color-emoji.woff2");
        let emoji = wuff::decompress_woff2(emoji_woff2).expect("woff2");
        let emoji_stripped = strip_sfnt_tables(&emoji, &EMOJI_STRIP_TABLES).expect("strips");
        std::fs::write(
            format!("{out_dir}/noto-color-emoji.shaping.otf"),
            &emoji_stripped,
        )
        .unwrap();
        println!(
            "cjk {cjk_sizes:?}, emoji {} -> {} bytes",
            emoji.len(),
            emoji_stripped.len()
        );

        for name in UA_TTF_FACES {
            let full = std::fs::read(format!("{out_dir}/{name}.ttf"))
                .unwrap_or_else(|e| panic!("read {name}.ttf: {e}"));
            assert!(
                !sfnt_has_table(&full, b"gvar") || sfnt_has_table(&full, b"HVAR"),
                "{name}: gvar without HVAR — strip would move advances"
            );
            let stripped =
                strip_outline_tables(&full).unwrap_or_else(|| panic!("{name}: nothing stripped"));
            assert!(!has_outline_tables(&stripped));
            assert!(!sfnt_has_table(&stripped, b"gvar"));
            assert_eq!(num_glyphs(&full), num_glyphs(&stripped));
            std::fs::write(format!("{out_dir}/{name}.shaping.otf"), &stripped).unwrap();
            println!("{name} {} -> {} bytes", full.len(), stripped.len());
        }
    }

    const UA_TTF_FACES: &[&str] = &[
        "NotoSans",
        "NotoSans-Italic",
        "NotoSerif",
        "Arimo",
        "Arimo-Italic",
        "InterVariable",
        "InterVariable-Italic",
        "Tinos-Regular",
        "Tinos-Bold",
        "Tinos-Italic",
        "Gelasio",
        "Gelasio-Italic",
        "NotoSansMono",
        "NotoSansSymbols",
        "NotoSansSymbols2",
        "NotoSansArabic",
        "NotoSansHebrew",
        "NotoSansDevanagari",
        "NotoSansThai",
        "NotoSansBengali",
        "NotoSansTamil",
        "NotoSansEthiopic",
        "NotoSansGurmukhi",
        "NotoSansGujarati",
        "NotoSansKannada",
        "NotoSansMalayalam",
        "NotoSansTelugu",
        "NotoSansSinhala",
        "NotoSansMyanmar",
        "NotoSansKhmer",
        "NotoSansLao",
        "NotoSansGeorgian",
        "NotoSansArmenian",
        "NotoSansKR",
    ];

    #[test]
    fn strip_outline_tables_handles_variable_fonts() {
        let full = read_asset("NotoSans.ttf");
        assert!(sfnt_has_table(&full, b"gvar"));
        assert!(sfnt_has_table(&full, b"HVAR"));
        let stripped = strip_outline_tables(&full).expect("strips");
        assert!(!sfnt_has_table(&stripped, b"glyf"));
        assert!(!sfnt_has_table(&stripped, b"gvar"));
        assert!(!has_outline_tables(&stripped));
        assert!(sfnt_has_table(&stripped, b"HVAR"));
        assert!(sfnt_has_table(&stripped, b"cmap"));
        assert!(sfnt_has_table(&stripped, b"hmtx"));
        assert!(sfnt_has_table(&stripped, b"GPOS"));
        assert!(sfnt_has_table(&stripped, b"GSUB"));
        assert_eq!(num_glyphs(&full), num_glyphs(&stripped));
        assert!(
            stripped.len() * 2 < full.len(),
            "expected >=2x shrink, got {} -> {}",
            full.len(),
            stripped.len()
        );
        let mut ctx = make_empty_font_context();
        let blob = Blob::new(Arc::new(stripped) as Arc<dyn AsRef<[u8]> + Send + Sync>);
        assert!(!ctx.collection.register_fonts(blob, None).is_empty());
    }

    #[test]
    fn strip_font_for_shaping_accepts_every_font_container() {
        let full = read_asset("NotoSans.ttf");
        let out = strip_font_for_shaping(full.clone()).expect("ttf strips");
        assert!(!has_outline_tables(&out));
        assert!(sfnt_has_table(&out, b"cmap"));
        assert_eq!(num_glyphs(&full), num_glyphs(&out));

        let woff2 = read_asset("noto-color-emoji.woff2");
        let out = strip_font_for_shaping(woff2).expect("woff2 strips");
        assert!(!has_outline_tables(&out));
        assert!(sfnt_has_table(&out, b"head"));
    }

    #[test]
    fn strip_font_for_shaping_accepts_bytes_after_the_brotli_stream() {
        // Some woff2 files (FontAwesome 6) count alignment padding in totalCompressedSize, so
        // bytes follow brotli's end of stream. wuff before 0.2.9 panicked on them. Rebuild that
        // shape from a shipped font: 4 trailing bytes counted in the block keep it 4-aligned.
        let mut woff2 = read_asset("inter-latin-variable.woff2");
        let be32 = |b: &[u8], at: usize| u32::from_be_bytes(b[at..at + 4].try_into().unwrap());
        assert_eq!(
            be32(&woff2, 8) as usize,
            woff2.len(),
            "no metadata or private block may follow the compressed data"
        );
        let length = be32(&woff2, 8) + 4;
        let compressed = be32(&woff2, 20) + 4;
        woff2.extend_from_slice(&[0; 4]);
        woff2[8..12].copy_from_slice(&length.to_be_bytes());
        woff2[20..24].copy_from_slice(&compressed.to_be_bytes());

        let out = strip_font_for_shaping(woff2).expect("padded woff2 strips");
        assert!(sfnt_has_table(&out, b"cmap"));
        assert!(!has_outline_tables(&out));
    }

    #[test]
    fn strip_font_for_shaping_refuses_a_declared_inflation_bomb() {
        let real = read_asset("noto-color-emoji.woff2");
        assert!(strip_font_for_shaping(real.clone()).is_some());
        let declared = declared_sfnt_size(&real).expect("woff2 header");
        assert!(
            declared <= MAX_DECOMPRESSED_FONT_BYTES,
            "real face must pass"
        );

        let mut bomb = real.clone();
        bomb[16..20].copy_from_slice(&(1024u32 * 1024 * 1024).to_be_bytes());
        assert!(
            strip_font_for_shaping(bomb).is_none(),
            "bomb must be refused"
        );

        assert!(strip_font_for_shaping(b"wOF2\x00\x01\x00\x00".to_vec()).is_none());
    }

    #[test]
    fn strip_font_for_shaping_fails_closed_on_anything_else() {
        for (label, body) in [
            ("json", &b"{\"secret\":\"value\"}"[..]),
            ("html", &b"<!doctype html><p>secret</p>"[..]),
            ("png", &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a][..]),
            ("empty", &[][..]),
            ("short", &[0x00, 0x01, 0x00][..]),
            ("lying woff2", &b"wOF2 not really a font at all"[..]),
            ("ttc", &b"ttcf\x00\x01\x00\x00\x00\x00\x00\x02"[..]),
            (
                "truncated sfnt",
                &[0x00, 0x01, 0x00, 0x00, 0x00, 0x20, 0, 0, 0, 0, 0, 0][..],
            ),
        ] {
            assert!(
                strip_font_for_shaping(body.to_vec()).is_none(),
                "{label} must fail closed"
            );
        }
    }

    #[test]
    fn strip_font_for_shaping_reproduces_the_checked_in_shaping_assets() {
        for (src, asset) in [
            ("NotoSans.ttf", "NotoSans.shaping.otf"),
            ("NotoSansMono.ttf", "NotoSansMono.shaping.otf"),
            ("noto-color-emoji.woff2", "noto-color-emoji.shaping.otf"),
        ] {
            let full = read_asset(src);
            let expected = read_asset(asset);
            let got = strip_font_for_shaping(full).expect("strips");
            assert_eq!(got, expected, "{src} -> {asset} diverged");
        }
    }

    #[test]
    fn strip_font_for_shaping_drops_colour_payload_not_just_outlines() {
        let emoji = read_asset("noto-color-emoji.woff2");
        let full = wuff::decompress_woff2(&emoji).expect("woff2");
        assert!(sfnt_has_table(&full, b"COLR"));
        assert!(sfnt_has_table(&full, b"CPAL"));
        let out = strip_font_for_shaping(emoji).expect("strips");
        for tag in [b"COLR", b"CPAL", b"CBDT", b"CBLC", b"sbix"] {
            assert!(!sfnt_has_table(&out, tag), "{:?} survived", tag);
        }
        assert!(sfnt_has_table(&out, b"cmap"));
        assert_eq!(num_glyphs(&full), num_glyphs(&out));
        assert!(
            out.len() * 8 < full.len(),
            "{} -> {}",
            full.len(),
            out.len()
        );
    }

    #[test]
    fn strip_font_for_shaping_passes_an_outline_free_face_through() {
        let full = read_asset("NotoSans.ttf");
        let once = strip_font_for_shaping(full).expect("strips");
        let twice = strip_font_for_shaping(once.clone()).expect("idempotent");
        assert_eq!(once, twice);
    }

    #[test]
    fn strip_outline_tables_keeps_gvar_without_hvar() {
        let full = read_asset("NotoSans.ttf");
        let no_hvar = strip_sfnt_tables(&full, &[*b"HVAR"]).expect("drops HVAR");
        let stripped = strip_outline_tables(&no_hvar).expect("strips");
        assert!(sfnt_has_table(&stripped, b"gvar"));
        assert!(!sfnt_has_table(&stripped, b"glyf"));
    }

    fn read_asset(name: &str) -> Vec<u8> {
        let path = crate::test_assets::engine_dir()
            .join("public/fonts")
            .join(name);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    fn family_blobs_have_outlines(ctx: &mut FontContext, family: &str) -> Vec<bool> {
        let fam = ctx
            .collection
            .family_by_name(family)
            .unwrap_or_else(|| panic!("family {family} missing"));
        fam.fonts()
            .iter()
            .map(|f| match &f.source().kind {
                parley::fontique::SourceKind::Memory(b) => has_outline_tables(b.as_ref()),
                _ => false,
            })
            .collect()
    }

    #[test]
    fn lazy_upgrade_swaps_faces_and_preserves_wiring() {
        set_font_mode(FontMode::Lazy);
        let sans_full = read_asset("NotoSans.ttf");
        let italic_full = read_asset("NotoSans-Italic.ttf");
        let mono_full = read_asset("NotoSansMono.ttf");

        let mut ctx = make_empty_font_context();
        populate_ua_fonts(
            &mut ctx,
            &NOTO_PROFILE,
            UaFontBytes {
                sans: [
                    strip_outline_tables(&sans_full).expect("strip sans"),
                    strip_outline_tables(&italic_full).expect("strip italic"),
                ],
                mono: strip_outline_tables(&mono_full).expect("strip mono"),
                ..Default::default()
            },
        );

        let sans_id_before = ctx
            .collection
            .family_by_name("Noto Sans")
            .expect("sans")
            .id();
        assert!(
            family_blobs_have_outlines(&mut ctx, "Noto Sans")
                .iter()
                .all(|has| !has),
            "stripped faces must have no outlines"
        );
        assert!(has_pending_lazy_faces());
        assert_eq!(
            pending_lazy_face_paths(),
            vec![
                "/fonts/NotoSans.ttf".to_string(),
                "/fonts/NotoSans-Italic.ttf".to_string(),
                "/fonts/NotoSansMono.ttf".to_string(),
            ]
        );

        assert!(upgrade_recorded_face(
            &mut ctx,
            "/fonts/NotoSans.ttf",
            sans_full,
        ));
        assert!(upgrade_recorded_face(
            &mut ctx,
            "/fonts/NotoSans-Italic.ttf",
            italic_full,
        ));
        assert!(upgrade_recorded_face(
            &mut ctx,
            "/fonts/NotoSansMono.ttf",
            mono_full,
        ));
        assert!(!has_pending_lazy_faces());

        let fam = ctx.collection.family_by_name("Noto Sans").expect("sans");
        assert_eq!(fam.id(), sans_id_before);
        assert_eq!(fam.fonts().len(), 2);
        assert!(family_blobs_have_outlines(&mut ctx, "Noto Sans")
            .iter()
            .all(|has| *has));
        assert!(family_blobs_have_outlines(&mut ctx, "Noto Sans Mono")
            .iter()
            .all(|has| *has));
        let generic_sans: Vec<_> = ctx
            .collection
            .generic_families(parley::fontique::GenericFamily::SansSerif)
            .collect();
        assert!(generic_sans.contains(&sans_id_before));
        set_font_mode(FontMode::Full);
    }

    #[test]
    fn upgrade_rejects_unusable_bytes_and_keeps_the_record() {
        set_font_mode(FontMode::Lazy);
        let sans_full = read_asset("NotoSans.ttf");
        let stripped = strip_outline_tables(&sans_full).expect("strip");
        let mut ctx = make_empty_font_context();
        populate_ua_fonts(
            &mut ctx,
            &NOTO_PROFILE,
            UaFontBytes {
                sans: [stripped.clone(), stripped],
                ..Default::default()
            },
        );
        assert!(!upgrade_recorded_face(
            &mut ctx,
            "/fonts/NotoSans.ttf",
            b"garbage".to_vec(),
        ));
        assert!(has_pending_lazy_faces());
        assert!(!upgrade_recorded_face(
            &mut ctx,
            "/fonts/NotoSans.ttf",
            Vec::new(),
        ));
        assert!(upgrade_recorded_face(
            &mut ctx,
            "/fonts/NotoSans.ttf",
            sans_full,
        ));
        assert!(!upgrade_recorded_face(
            &mut ctx,
            "/fonts/Nope.ttf",
            read_asset("NotoSans.ttf"),
        ));
        set_font_mode(FontMode::Full);
    }

    #[test]
    fn fetched_font_strip_handles_every_container_and_gates_on_mode() {
        let woff2 = read_asset("NotoSansCJKsc-Regular.woff2");
        let ttf = read_asset("NotoSans.ttf");

        set_font_mode(FontMode::Full);
        assert_eq!(
            strip_fetched_font_for_session(ttf.clone(), "u", 0),
            ttf,
            "Full mode must pass bytes through untouched"
        );

        set_font_mode(FontMode::PixelFree);
        let out = strip_fetched_font_for_session(woff2.clone(), "u", 0);
        assert_ne!(out, woff2);
        assert!(!has_outline_tables(&out));
        assert!(sfnt_has_table(&out, b"cmap"));
        assert!(sfnt_has_table(&out, b"hmtx"));
        assert!(out.len() * 4 < woff2.len() * 10, "stripped stays small");
        let out = strip_fetched_font_for_session(ttf.clone(), "u", 0);
        assert!(!has_outline_tables(&out));
        assert!(sfnt_has_table(&out, b"HVAR"), "variable advances kept");
        assert_eq!(
            strip_fetched_font_for_session(b"garbage".to_vec(), "u", 0),
            b"garbage".to_vec()
        );
        assert_eq!(
            strip_fetched_font_for_session(Vec::new(), "u", 0),
            Vec::<u8>::new()
        );
        let truncated = woff2[..16].to_vec();
        assert_eq!(
            strip_fetched_font_for_session(truncated.clone(), "u", 0),
            truncated
        );

        set_font_mode(FontMode::Lazy);
        let url = "https://fonts.test/author.woff2";
        let out = strip_fetched_font_for_session(woff2.clone(), url, 0);
        assert!(!has_outline_tables(&out));
        let h = font_data_key(fx_hash_u64(&out), 0);
        assert_eq!(font_url_for_hash(h), Some(url.to_string()));
        let garbage = strip_fetched_font_for_session(b"garbage".to_vec(), "g", 0);
        let gh = font_data_key(fx_hash_u64(&garbage), 0);
        assert_eq!(font_url_for_hash(gh), None);
        set_font_mode(FontMode::Full);
    }

    #[test]
    fn author_font_upgrade_swaps_family_in_place() {
        set_font_mode(FontMode::Lazy);
        let full = read_asset("NotoSansMono.ttf");
        let url = "https://fonts.test/brand.ttf";
        let stripped = strip_fetched_font_for_session(full.clone(), url, 0);
        assert!(!has_outline_tables(&stripped));

        let blob = Blob::from(stripped);
        let (family, faces) = SHARED_FONT_CONTEXT.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let ctx = borrow.get_or_insert_with(make_empty_font_context);
            let over = parley::fontique::FontInfoOverride {
                family_name: Some("BrandFont"),
                ..Default::default()
            };
            let result = ctx.collection.register_fonts(blob.clone(), Some(over));
            assert_eq!(result.len(), 1);
            let (family, fonts) = &result[0];
            (*family, fonts.len())
        });
        assert_eq!(faces, 1);
        let regs = vec![blitz_dom::AuthorFontRegistration {
            bytes: blob,
            family,
            width: parley::fontique::FontWidth::default(),
            style: parley::fontique::FontStyle::default(),
            weight: parley::fontique::FontWeight::default(),
        }];
        assert_eq!(stash_author_upgrades(regs), vec![url.to_string()]);

        assert!(upgrade_author_font_face(url.to_string(), full));
        SHARED_FONT_CONTEXT.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let ctx = borrow.as_mut().expect("ctx");
            let fam = ctx
                .collection
                .family_by_name("BrandFont")
                .expect("family survives");
            assert_eq!(fam.id(), family, "FamilyId stable across the swap");
            assert_eq!(fam.fonts().len(), 1, "no duplicate faces");
            let has = match &fam.fonts()[0].source().kind {
                parley::fontique::SourceKind::Memory(b) => has_outline_tables(b.as_ref()),
                _ => false,
            };
            assert!(has, "swapped face carries outlines");
        });
        assert!(!upgrade_author_font_face(
            "https://fonts.test/nope.ttf".to_string(),
            read_asset("NotoSans.ttf"),
        ));
        set_font_mode(FontMode::Full);
    }

    #[test]
    fn full_and_pixel_free_modes_never_record() {
        for mode in [FontMode::Full, FontMode::PixelFree] {
            set_font_mode(mode);
            let sans = read_asset("NotoSans.ttf");
            let mut ctx = make_empty_font_context();
            populate_ua_fonts(
                &mut ctx,
                &NOTO_PROFILE,
                UaFontBytes {
                    sans: [
                        maybe_strip_for_session(sans.clone()),
                        maybe_strip_for_session(sans),
                    ],
                    ..Default::default()
                },
            );
            assert!(!has_pending_lazy_faces(), "{mode:?} must not record");
            let outlined = family_blobs_have_outlines(&mut ctx, "Noto Sans");
            match mode {
                FontMode::Full => assert!(outlined.iter().all(|h| *h)),
                _ => assert!(outlined.iter().all(|h| !h)),
            }
        }
        set_font_mode(FontMode::Full);
    }

    fn profile_bytes(profile: &UaFontProfile) -> UaFontBytes {
        let read = |path: &str| {
            if path.is_empty() {
                Vec::new()
            } else {
                read_asset(path.trim_start_matches("/fonts/"))
            }
        };
        UaFontBytes {
            sans: profile.sans.map(read),
            system: profile.system.map(read),
            serif: profile.serif.map(read),
            georgia: profile.georgia.map(read),
            mono: read(MONO_PATH),
        }
    }

    #[test]
    fn profile_table_names_existing_assets() {
        for profile in UA_FONT_PROFILES {
            for path in profile.paths().into_iter().filter(|p| !p.is_empty()) {
                let shaping = path.replace(".ttf", ".shaping.otf");
                for asset in [path, shaping.as_str()] {
                    read_asset(asset.trim_start_matches("/fonts/"));
                }
            }
            let json: serde_json::Value =
                serde_json::from_str(&ua_font_profile_json(profile.name)).expect("json");
            assert_eq!(json["faces"], serde_json::json!(profile.paths()));
        }
        assert_eq!(ua_font_profile_json("Noto"), "");
        assert!(!register_ua_fonts(
            read_asset("NotoSans.ttf"),
            read_asset("NotoSans-Italic.ttf"),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            "nope",
        ));
    }

    #[test]
    fn macos_profile_resolves_families_like_chrome_on_macos() {
        let mut ctx = make_empty_font_context();
        populate_ua_fonts(&mut ctx, &MACOS_PROFILE, profile_bytes(&MACOS_PROFILE));
        let [arimo, inter, tinos] = ["Arimo", "Inter Variable", "Tinos"].map(|name| {
            ctx.collection
                .family_by_name(name)
                .unwrap_or_else(|| panic!("{name} missing"))
                .id()
        });
        for (generic, want) in [
            (GenericFamily::SansSerif, arimo),
            (GenericFamily::SystemUi, inter),
            (GenericFamily::UiSansSerif, inter),
            (GenericFamily::UiRounded, inter),
            (GenericFamily::Serif, tinos),
            (GenericFamily::UiSerif, tinos),
        ] {
            let ids: Vec<_> = ctx.collection.generic_families(generic).collect();
            assert_eq!(ids, vec![want], "{generic:?}");
        }
        // Each alias carries the whole family: upright and italic share one family, and serif
        // adds its bold.
        for (aliases, faces) in [
            (MACOS_PROFILE.sans_aliases, 2),
            (MACOS_PROFILE.system_aliases, 2),
            (MACOS_PROFILE.serif_aliases, 3),
            (MACOS_PROFILE.georgia_aliases, 2),
        ] {
            for name in aliases {
                let fam = ctx.collection.family_by_name(name).expect(name);
                assert_eq!(fam.fonts().len(), faces, "{name}");
            }
        }
        assert!(ctx.collection.family_by_name("Segoe UI").is_none());
        // Noto Sans waits for text that needs it.
        assert!(ctx.collection.family_by_name("Noto Sans").is_none());
        let base = BASE_COMMON_IDS.with(|c| c.borrow().clone());
        assert_eq!(&base[..3], &[arimo, inter, tinos]);
    }

    #[test]
    fn noto_profile_keeps_noto_sans_behind_every_sans_generic() {
        let mut ctx = make_empty_font_context();
        populate_ua_fonts(&mut ctx, &NOTO_PROFILE, profile_bytes(&NOTO_PROFILE));
        let noto = ctx.collection.family_by_name("Noto Sans").expect("noto");
        assert_eq!(noto.fonts().len(), 2);
        let noto = noto.id();
        for generic in [
            GenericFamily::SansSerif,
            GenericFamily::SystemUi,
            GenericFamily::UiSansSerif,
            GenericFamily::UiRounded,
        ] {
            let ids: Vec<_> = ctx.collection.generic_families(generic).collect();
            assert_eq!(ids, vec![noto], "{generic:?}");
        }
        for name in ["Arial", "Arimo", "Tinos", "Georgia", "-apple-system"] {
            assert!(ctx.collection.family_by_name(name).is_none(), "{name}");
        }
    }

    #[test]
    fn lazy_upgrade_swaps_every_alias_of_a_path() {
        set_font_mode(FontMode::Lazy);
        let sans_full = read_asset("Arimo.ttf");
        let italic_full = read_asset("Arimo-Italic.ttf");
        let mut ctx = make_empty_font_context();
        populate_ua_fonts(
            &mut ctx,
            &MACOS_PROFILE,
            UaFontBytes {
                sans: [
                    strip_outline_tables(&sans_full).expect("strip sans"),
                    strip_outline_tables(&italic_full).expect("strip italic"),
                ],
                ..Default::default()
            },
        );
        let ids_before =
            ["Arimo", "Arial"].map(|f| ctx.collection.family_by_name(f).expect(f).id());
        assert_eq!(
            pending_lazy_face_paths(),
            MACOS_PROFILE.sans.map(String::from)
        );
        let [sans_path, italic_path] = MACOS_PROFILE.sans;
        assert!(upgrade_recorded_face(&mut ctx, sans_path, sans_full));
        assert!(upgrade_recorded_face(&mut ctx, italic_path, italic_full));
        assert!(!has_pending_lazy_faces());
        for (family, id) in ["Arimo", "Arial"].into_iter().zip(ids_before) {
            let fam = ctx.collection.family_by_name(family).expect(family);
            assert_eq!(fam.id(), id, "{family}");
            assert_eq!(fam.fonts().len(), 2, "{family}");
            assert!(family_blobs_have_outlines(&mut ctx, family)
                .iter()
                .all(|has| *has));
        }
        set_font_mode(FontMode::Full);
    }

    #[test]
    fn latin_script_face_needs_a_profile_that_asks_for_it() {
        let _ = get_or_init_font_context();
        // The test context is noto, whose sans face is already Noto Sans.
        assert!(!register_script_font(
            read_asset("NotoSans.ttf"),
            "Latn".into()
        ));
        SHARED_FONT_CONTEXT.with(|cell| {
            let mut ctx = make_empty_font_context();
            populate_ua_fonts(&mut ctx, &MACOS_PROFILE, profile_bytes(&MACOS_PROFILE));
            *cell.borrow_mut() = Some(ctx);
        });
        UA_FONT_PROFILE.with(|c| c.set(Some(&MACOS_PROFILE)));
        assert!(register_script_font(
            read_asset("NotoSans.ttf"),
            "Latn".into()
        ));
        // A later rebuild, as any symbol or emoji registration triggers, keeps it.
        assert!(register_symbol_fonts(
            NOTO_SANS_SYMBOLS_TEST_BYTES.to_vec(),
            Vec::new()
        ));
        SHARED_FONT_CONTEXT.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let ctx = borrow.as_mut().expect("shared context");
            let noto = ctx
                .collection
                .family_by_name("Noto Sans")
                .expect("noto")
                .id();
            let base = BASE_COMMON_IDS.with(|c| c.borrow().clone());
            for script in [Script::COMMON, Script::from_bytes(*b"Latn")] {
                let chain: Vec<_> = ctx
                    .collection
                    .fallback_families(parley::fontique::FallbackKey::new(script, None))
                    .collect();
                assert_eq!(chain[base.len()], noto, "{script:?}");
            }
        });
    }

    #[test]
    fn regional_cjk_faces_take_han_for_their_language_and_kana_for_jp() {
        let _ = get_or_init_font_context();
        // JP lands before SC here; the chains must not depend on the order.
        assert!(register_cjk_region_font(
            &read_asset("NotoSansCJKjp-Regular.shaping.otf"),
            "JP"
        ));
        assert!(register_cjk_font(&read_asset(
            "NotoSansCJKsc-Regular.shaping.otf"
        )));
        assert!(register_cjk_region_font(
            &read_asset("NotoSansCJKtc-Regular.shaping.otf"),
            "TC"
        ));
        assert!(!register_cjk_region_font(&[], "KR"));
        SHARED_FONT_CONTEXT.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let ctx = borrow.as_mut().expect("shared context");
            let mut id = |name: &str| ctx.collection.family_by_name(name).expect(name).id();
            let [sc, jp, tc] =
                [CjkRegion::Sc, CjkRegion::Jp, CjkRegion::Tc].map(|region| id(region.aliases()[0]));
            let han = Script::from_bytes(*b"Hani");
            let first = |ctx: &mut FontContext, key: parley::fontique::FallbackKey| {
                ctx.collection.fallback_families(key).next()
            };
            let lang = |tag: &str| parley::fontique::Language::parse(tag).unwrap();
            for (tag, want) in [
                ("ja", jp),
                ("zh-TW", tc),
                ("zh-Hant", tc),
                ("zh-HK", tc),
                ("zh-CN", sc),
                ("en", sc),
            ] {
                let key = parley::fontique::FallbackKey::new(han, Some(&lang(tag)));
                assert_eq!(first(ctx, key), Some(want), "Hani {tag}");
            }
            assert_eq!(
                first(ctx, parley::fontique::FallbackKey::new(han, None)),
                Some(sc)
            );
            let hira = parley::fontique::FallbackKey::new(Script::from_bytes(*b"Hira"), None);
            assert_eq!(first(ctx, hira), Some(jp));
        });
    }
}
