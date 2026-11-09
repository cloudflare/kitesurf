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
        if off + len > bytes.len() {
            return None;
        }
        if drop.contains(&tag) {
            continue;
        }
        kept.push(Entry {
            tag,
            checksum,
            data: off..off + len,
        });
    }
    if kept.is_empty() || kept.len() == num_tables {
        return None;
    }
    let n = kept.len();
    let mut entry_selector = 0u16;
    while (2usize << entry_selector) <= n {
        entry_selector += 1;
    }
    entry_selector -= 1;
    let search_range = 16u16 << entry_selector;
    let range_shift = (n as u16) * 16 - search_range;

    let mut out = Vec::with_capacity(
        SFNT_HEADER_BYTES
            + n * SFNT_TABLE_RECORD_BYTES
            + kept.iter().map(|e| (e.data.len() + 3) & !3).sum::<usize>(),
    );
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

const MAX_DECOMPRESSED_FONT_BYTES: u32 = 32 * 1024 * 1024;

fn declared_sfnt_size(bytes: &[u8]) -> Option<u32> {
    if bytes.len() < 20 {
        return None;
    }
    Some(u32::from_be_bytes(bytes[16..20].try_into().ok()?))
}

#[wasm_bindgen(js_name = "stripFontForShaping")]
pub fn strip_font_for_shaping(bytes: Vec<u8>) -> Option<Vec<u8>> {
    let compressed = bytes.len() >= 4 && (&bytes[0..4] == b"wOF2" || &bytes[0..4] == b"wOFF");
    if compressed {
        match declared_sfnt_size(&bytes) {
            Some(n) if n <= MAX_DECOMPRESSED_FONT_BYTES => {}
            _ => return None,
        }
    }
    let sfnt: Vec<u8> = if bytes.len() >= 4 && &bytes[0..4] == b"wOF2" {
        wuff::decompress_woff2(&bytes).ok()?
    } else if bytes.len() >= 4 && &bytes[0..4] == b"wOFF" {
        wuff::decompress_woff1(&bytes).ok()?
    } else {
        bytes
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
    if bytes.len() >= 4 && &bytes[0..4] == b"wOF2" {
        wuff::decompress_woff2(&bytes).unwrap_or(bytes)
    } else if bytes.len() >= 4 && &bytes[0..4] == b"wOFF" {
        wuff::decompress_woff1(&bytes).unwrap_or(bytes)
    } else {
        bytes
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

struct LazyBlobRecord {
    path: &'static str,
    svg_slot: Option<blitz_dom::util::SvgGenericSlot>,
    faces: Vec<LazyFaceRecord>,
}

thread_local! {
    static LAZY_REGISTERED: RefCell<Vec<LazyBlobRecord>> =
        const { RefCell::new(Vec::new()) };
}

fn record_lazy_registration(
    path: &'static str,
    svg_slot: Option<blitz_dom::util::SvgGenericSlot>,
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
            faces,
        });
    });
}

pub(crate) fn upgrade_recorded_face(
    font_ctx: &mut FontContext,
    path: &str,
    full_bytes: Vec<u8>,
) -> bool {
    let Some(record) = LAZY_REGISTERED.with(|c| {
        let mut recs = c.borrow_mut();
        recs.iter()
            .position(|r| r.path == path)
            .map(|i| recs.remove(i))
    }) else {
        return false;
    };
    if full_bytes.is_empty() || !has_outline_tables(&full_bytes) {
        LAZY_REGISTERED.with(|c| c.borrow_mut().push(record));
        return false;
    }
    for face in &record.faces {
        font_ctx
            .collection
            .unregister_font(face.family, face.width, face.style, face.weight);
    }
    note_font_asset(&full_bytes, record.path);
    let blob = Blob::from(full_bytes);
    blitz_dom::util::register_svg_font(Arc::new(blob.clone()), record.svg_slot);
    let registered = font_ctx.collection.register_fonts(blob, None);
    !registered.is_empty()
}

pub(crate) fn has_pending_lazy_faces() -> bool {
    LAZY_REGISTERED.with(|c| !c.borrow().is_empty())
}

pub(crate) fn pending_lazy_face_paths() -> Vec<String> {
    LAZY_REGISTERED.with(|c| c.borrow().iter().map(|r| r.path.to_string()).collect())
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
    EMOJI_IDS.with(|c| chain.extend(c.borrow().iter().copied()));
    SYMBOL_IDS.with(|c| chain.extend(c.borrow().iter().copied()));
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

/// Register Noto Sans CJK SC for Han, Hiragana, Katakana, and Hangul fallbacks.
/// Regional aliases, including Simplified Chinese variants, share one blob.
/// Add it after emoji in Common for ideographic spaces and fullwidth punctuation.
/// Returns true only on the first registration.
#[wasm_bindgen]
pub fn register_cjk_font(bytes: &[u8]) -> bool {
    let _ks_span =
        tracing::info_span!("wasm.font_register", kind = "cjk", bytes = bytes.len()).entered();
    if CJK_FONT_REGISTERED.with(|c| c.get()) {
        return false;
    }

    let mut opentype: Vec<u8> = wuff::decompress_woff2(bytes).unwrap_or_else(|_| bytes.to_vec());

    if crate::renderer_mode() {
        if let Some(stripped) = strip_sfnt_tables(&opentype, &OUTLINE_STRIP_TABLES) {
            opentype = stripped;
        }
    }

    note_font_asset(&opentype, "/fonts/NotoSansCJKsc-Regular.woff2");

    const ALIASES: [&str; 24] = [
        "PingFang SC",
        "Hiragino Sans GB",
        "Microsoft YaHei",
        "Microsoft YaHei UI",
        "SimHei",
        "SimSun",
        "Source Han Sans SC",
        "Noto Sans CJK SC",
        "Noto Sans SC",
        "PingFang TC",
        "Microsoft JhengHei",
        "PMingLiU",
        "Source Han Sans TC",
        "Noto Sans CJK TC",
        "Noto Sans TC",
        "Hiragino Sans",
        "Hiragino Kaku Gothic Pro",
        "Yu Gothic",
        "Meiryo",
        "MS Gothic",
        "Source Han Sans JP",
        "Noto Sans CJK JP",
        "Noto Sans JP",
        "Apple SD Gothic Neo",
    ];

    SHARED_FONT_CONTEXT.with(|cell| {
        let mut borrow = cell.borrow_mut();
        if borrow.is_none() {
            return;
        }
        let font_ctx = borrow.as_mut().unwrap();

        let blob_bytes: Arc<dyn AsRef<[u8]> + Send + Sync> = Arc::new(opentype);
        let blob = Blob::new(blob_bytes);

        let mut ids: Vec<FamilyId> = Vec::new();
        for alias in ALIASES {
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

        let han = Script::from_bytes(*b"Hani");
        let hira = Script::from_bytes(*b"Hira");
        let kana = Script::from_bytes(*b"Kana");
        let hang = Script::from_bytes(*b"Hang");
        font_ctx
            .collection
            .append_fallbacks(han, ids.iter().copied());
        font_ctx
            .collection
            .append_fallbacks(hira, ids.iter().copied());
        font_ctx
            .collection
            .append_fallbacks(kana, ids.iter().copied());
        font_ctx
            .collection
            .append_fallbacks(hang, ids.iter().copied());
        CJK_IDS.with(|c| {
            c.borrow_mut().clear();
            c.borrow_mut().extend(ids.iter().copied());
        });
        rebuild_common_fallbacks(font_ctx);
    });

    CJK_FONT_REGISTERED.with(|c| c.set(true));
    true
}

const SCRIPT_FONT_ASSETS: &[(&str, &str)] = &[
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
        record_lazy_registration(path, None, &result);
        let ids: Vec<FamilyId> = result.into_iter().map(|(id, _)| id).collect();
        font_ctx
            .collection
            .append_fallbacks(script, ids.iter().copied());
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

fn populate_ua_fonts(
    font_ctx: &mut FontContext,
    sans_bytes: Vec<u8>,
    sans_italic_bytes: Vec<u8>,
    serif_bytes: Vec<u8>,
    mono_bytes: Vec<u8>,
) {
    let register = |c: &mut Collection,
                    bytes: Vec<u8>,
                    slot: Option<blitz_dom::util::SvgGenericSlot>,
                    path: &'static str|
     -> Vec<_> {
        let svg_usable = has_outline_tables(&bytes);
        let blob = Blob::from(bytes);
        if svg_usable {
            blitz_dom::util::register_svg_font(Arc::new(blob.clone()), slot);
        }
        let result = c.register_fonts(blob, None);
        record_lazy_registration(path, slot, &result);
        result.into_iter().map(|(id, _)| id).collect()
    };

    let sans = register(
        &mut font_ctx.collection,
        sans_bytes,
        Some(blitz_dom::util::SvgGenericSlot::SansSerif),
        "/fonts/NotoSans.ttf",
    );
    let _sans_italic = register(
        &mut font_ctx.collection,
        sans_italic_bytes,
        None,
        "/fonts/NotoSans-Italic.ttf",
    );
    let serif: Vec<FamilyId> = if serif_bytes.is_empty() {
        Vec::new()
    } else {
        register(
            &mut font_ctx.collection,
            serif_bytes,
            Some(blitz_dom::util::SvgGenericSlot::Serif),
            "/fonts/NotoSerif.ttf",
        )
    };
    let serif_family: &[FamilyId] = if serif.is_empty() { &sans } else { &serif };
    let mono: Vec<FamilyId> = if mono_bytes.is_empty() {
        Vec::new()
    } else {
        if let Some(r) = measure_mono_advance_per_em(&mono_bytes) {
            MONO_ADVANCE_PER_EM.with(|c| c.set(r));
        }
        register(
            &mut font_ctx.collection,
            mono_bytes,
            Some(blitz_dom::util::SvgGenericSlot::Monospace),
            "/fonts/NotoSansMono.ttf",
        )
    };
    let mono_family: &[FamilyId] = if mono.is_empty() { &sans } else { &mono };

    let set = |c: &mut Collection, generic: GenericFamily, ids: &[&[FamilyId]]| {
        let flat: Vec<_> = ids.iter().flat_map(|s| s.iter().copied()).collect();
        c.set_generic_families(generic, flat.into_iter());
    };

    set(&mut font_ctx.collection, GenericFamily::SansSerif, &[&sans]);
    set(&mut font_ctx.collection, GenericFamily::SystemUi, &[&sans]);
    set(
        &mut font_ctx.collection,
        GenericFamily::UiSansSerif,
        &[&sans],
    );
    set(&mut font_ctx.collection, GenericFamily::UiRounded, &[&sans]);

    set(
        &mut font_ctx.collection,
        GenericFamily::Serif,
        &[serif_family],
    );
    set(
        &mut font_ctx.collection,
        GenericFamily::UiSerif,
        &[serif_family],
    );
    set(
        &mut font_ctx.collection,
        GenericFamily::FangSong,
        &[serif_family],
    );

    set(
        &mut font_ctx.collection,
        GenericFamily::Monospace,
        &[mono_family],
    );
    set(
        &mut font_ctx.collection,
        GenericFamily::UiMonospace,
        &[mono_family],
    );

    set(&mut font_ctx.collection, GenericFamily::Cursive, &[&sans]);
    set(&mut font_ctx.collection, GenericFamily::Fantasy, &[&sans]);
    set(&mut font_ctx.collection, GenericFamily::Math, &[&sans]);
    set(&mut font_ctx.collection, GenericFamily::Emoji, &[&sans]);

    let mut base: Vec<FamilyId> = Vec::new();
    base.extend(sans.iter().copied());
    base.extend(serif.iter().copied());
    base.extend(mono.iter().copied());
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
        record_lazy_registration(path, None, &result);
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

/// Register UA fonts before constructing a DomHandle. Sans and italic are
/// required; serif and mono are optional. Missing required bytes or duplicate
/// calls return false. Empty mono leaves the generic on its sans fallback.
#[wasm_bindgen]
pub fn register_ua_fonts(
    sans_bytes: Vec<u8>,
    sans_italic_bytes: Vec<u8>,
    serif_bytes: Vec<u8>,
    mono_bytes: Vec<u8>,
) -> bool {
    let _ks_span = tracing::info_span!("wasm.font_register", kind = "ua").entered();
    if UA_FONTS_REGISTERED.with(|c| c.get()) {
        return false;
    }
    if sans_bytes.is_empty() || sans_italic_bytes.is_empty() {
        return false;
    }

    let sans_bytes = maybe_strip_for_session(sans_bytes);
    let sans_italic_bytes = maybe_strip_for_session(sans_italic_bytes);
    let serif_bytes = maybe_strip_for_session(serif_bytes);
    let mono_bytes = maybe_strip_for_session(mono_bytes);

    note_font_asset(&sans_bytes, "/fonts/NotoSans.ttf");
    note_font_asset(&sans_italic_bytes, "/fonts/NotoSans-Italic.ttf");
    if !serif_bytes.is_empty() {
        note_font_asset(&serif_bytes, "/fonts/NotoSerif.ttf");
    }
    if !mono_bytes.is_empty() {
        note_font_asset(&mono_bytes, "/fonts/NotoSansMono.ttf");
    }

    SHARED_FONT_CONTEXT.with(|cell| {
        let mut borrow = cell.borrow_mut();
        if borrow.is_none() {
            *borrow = Some(make_empty_font_context());
        }
        let font_ctx = borrow.as_mut().unwrap();
        populate_ua_fonts(
            font_ctx,
            sans_bytes,
            sans_italic_bytes,
            serif_bytes,
            mono_bytes,
        );
    });

    UA_FONTS_REGISTERED.with(|c| c.set(true));
    true
}

#[cfg(test)]
pub fn make_font_context() -> FontContext {
    let mut font_ctx = make_empty_font_context();
    populate_ua_fonts(
        &mut font_ctx,
        NOTO_SANS_TEST_BYTES.to_vec(),
        NOTO_SANS_ITALIC_TEST_BYTES.to_vec(),
        NOTO_SERIF_TEST_BYTES.to_vec(),
        NOTO_SANS_MONO_TEST_BYTES.to_vec(),
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
        let cjk_woff2: &[u8] =
            include_bytes!("../../../engine/public/fonts/NotoSansCJKsc-Regular.woff2");
        let cjk = wuff::decompress_woff2(cjk_woff2).expect("woff2");
        let cjk_stripped = strip_sfnt_tables(&cjk, &OUTLINE_STRIP_TABLES).expect("strips");
        std::fs::write(
            format!("{out_dir}/NotoSansCJKsc-Regular.shaping.otf"),
            &cjk_stripped,
        )
        .unwrap();
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
            "cjk {} -> {} bytes, emoji {} -> {} bytes",
            cjk.len(),
            cjk_stripped.len(),
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
            strip_outline_tables(&sans_full).expect("strip sans"),
            strip_outline_tables(&italic_full).expect("strip italic"),
            Vec::new(),
            strip_outline_tables(&mono_full).expect("strip mono"),
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
        populate_ua_fonts(&mut ctx, stripped.clone(), stripped, Vec::new(), Vec::new());
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
                maybe_strip_for_session(sans.clone()),
                maybe_strip_for_session(sans),
                Vec::new(),
                Vec::new(),
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
}
