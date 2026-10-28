// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// @ks-declaration-twin for the runtime-resolved sibling `./wasm-glue.js`
// Keep declarations in .ts so skipLibCheck cannot hide errors in this FFI surface.
// Worker Loader resolves the wasm-bindgen implementation from the modules map.

export declare function initSync(opts: { module: WebAssembly.Module }): unknown;

export declare function ks_eval(src: string, awaitPromise: boolean): Promise<string>;

export declare function ks_eval_cdp(
  src: string,
  awaitPromise: boolean,
  returnByValue: boolean,
): Promise<unknown>;
export declare function ks_call_cdp(
  fnSrc: string,
  thisV8: unknown,
  argsV8: unknown[],
  awaitPromise: boolean,
  returnByValue: boolean,
): Promise<unknown>;

export declare function ks_eval_page(src: string): unknown;
export declare function ks_run_page_jobs(): void;

export declare function font_families_json(): string;

export declare function ks_import(specifier: string, referrerUrl: string): Promise<unknown>;
export declare function ks_set_boa_strict(v: boolean): void;

export declare function ks_bridge_pins(): string;
export declare function ks_cycle_collect(idleSkip: boolean): number;
export declare function ks_cycle_stats(): string;
export declare function ks_boa_force_collect(): string;
export declare function ks_is_bridged(v: unknown): boolean;
export declare function ks_bridge_buffer_bytes(v: unknown): Uint8Array | undefined;
export declare function ks_bridge_install_desc_helpers(
  data: (value: unknown, flags: number) => object,
  accessor: (get: unknown, set: unknown, flags: number) => object,
): void;
// O(1) gate for the above: false until the page mints its first wrapper.
export declare function ks_bridge_ever_minted(): boolean;
export { DomHandle } from "../../core/pkg/kitesurf_core";

export declare function ks_parse_stylesheet_structured(css: string): {
  rules: Array<{
    selector_text: string;
    selector_specificities: number[];
    declarations: Array<{ name: string; value: string; important?: boolean }>;
    source_line: number;
    source_column: number;
  }>;
};

export declare function ks_parse_inline_style(css: string): Array<{
  name: string;
  value: string;
  important?: boolean;
}>;

export declare function ks_parse_typed_style_value(property: string, cssText: string): unknown;
export declare function ks_parse_typed_numeric_value(cssText: string): unknown;

export declare function ks_counter_style_rule(css: string, field: string, value: string): unknown;

export declare function ks_serialize_inline_style(css: string): string;

export declare function ks_get_property_value(css: string, property: string): string;

export declare function ks_canonicalize_page_selectors(prelude: string): string | undefined;

export declare function ks_encoding_name(label: string): string | undefined;
export declare function ks_percent_encode_after_encoding(
  encoding: string,
  input: string,
  set: number,
  spaceAsPlus: boolean,
): string;
export declare function ks_encode_html(encoding: string, input: string): Uint8Array;

export declare class RuleStyleDeclarationStore {
  constructor(
    context: "style" | "keyframe" | "font-face" | "page",
    cssText: string,
    baseUrl: string,
  );
  cssText(): string;
  cascadeText(): string;
  getPropertyValue(name: string): string;
  getPropertyPriority(name: string): string;
  setProperty(name: string, value: string, priority: string): boolean;
  hasProperty(name: string): boolean;
  removeProperty(name: string): string;
  length(): number;
  item(index: number): string;
  setCssText(cssText: string): void;
  free(): void;
}

export declare function ks_ua_stylesheet(): string;

export declare function register_ua_fonts(
  sans_bytes: Uint8Array,
  sans_italic_bytes: Uint8Array,
  serif_bytes: Uint8Array,
  mono_bytes: Uint8Array,
): boolean;
export declare function register_symbol_fonts(
  symbols_bytes: Uint8Array,
  symbols2_bytes: Uint8Array,
): boolean;
export declare function register_emoji_font(bytes: Uint8Array): boolean;

export declare function register_cjk_font(bytes: Uint8Array): boolean;

export declare function register_script_font(bytes: Uint8Array, script_tag: string): boolean;

export declare function setPixelFreeSession(enabled: boolean): void;

export declare function setFontShapingLazy(enabled: boolean): void;
export declare function pendingLazyFontPaths(): string[];
export declare function upgradeFontFace(path: string, fullBytes: Uint8Array): boolean;
export declare function upgradeAuthorFontFace(url: string, fullBytes: Uint8Array): boolean;
export declare function finishFontUpgrade(): boolean;

export declare function __setBridgeFetchResource(
  fn: (request_id: number, url: string, kind: string) => void,
): void;

// Called with the trap that poisoned the module; the TERMINATED-HOOK-MARKER-v1 post-pass in
// scripts/build-wasm.mjs adds it to the glue.
export declare function __setOnTerminated(fn: (err: unknown) => void): void;

export declare function set_ks_tracing(enabled: boolean): void;
export declare function set_ks_trace_parent(spanIdHex: string): void;
export declare function ks_set_emit_hook(f: ((rec: string) => void) | null): void;

export declare function ks_js_span_enter(op: string, bytes: number, detail: string): number;
export declare function ks_js_span_exit(slot: number): void;

export declare function setDimsOnlyImages(enabled: boolean): void;

export declare function setDarkColorScheme(dark: boolean): void;

export declare function monoAdvancePerEm(): number;

export declare function setTtyUaCss(css: string): void;

export declare function setTtyCellGrid(w: number, h: number): void;

// boa's code store (core boa_code_store.rs): an append log where put returns a key >= 0, or -1
// to keep the bytes resident; read returns exactly len bytes from that key's offset.
export declare function ks_set_code_store(
  minBytes: number,
  put: ((bytes: Uint8Array) => number) | null,
  read: ((key: number, offset: number, len: number) => Uint8Array | undefined) | null,
  release: ((key: number, len: number) => void) | null,
  flush: (() => void) | null,
): void;

/** Live wasm bytes past which an allocation forces a swap round; 0 turns it off. */
export declare function ks_set_swap_budget(bytes: number): void;

/** What compiled code retains by form, as JSON; the shape of `bridge.boaCode`. */
export declare function ks_code_stats(): string;

/** Live bytes, budget and forced rounds from the counting allocator, as JSON. */
export declare function ks_swap_alloc_stats(): string;
