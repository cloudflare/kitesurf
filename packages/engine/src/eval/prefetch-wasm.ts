// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Finds and preloads bounded WebAssembly modules referenced by page scripts.

import type { SandboxOutboundOverride } from "./outbound.ts";
import { localTraceParentProps } from "../tracing-local.ts";
import { readCappedBytes, readCappedText } from "../read-capped.ts";
import { walkRedirects } from "./redirect-walk.ts";

export interface WasmBakeManifestEntry {
  size: number;
  sha256: string;
  head16: string;
  tail16: string;
  bytesB64?: string;
}

export interface WasmBake {
  modules: Record<string, ArrayBuffer>;
  manifest: Record<string, WasmBakeManifestEntry>;
  errors: Record<string, string>;
}

const MAX_WASM_URLS = 8;
const MAX_WASM_LITERAL_RESOLUTIONS = 256;
const MAX_TOTAL_WASM_BYTES = 48 * 1024 * 1024;
const PREFETCH_WASM_DEADLINE_MS = 10_000;
const MAX_SINGLE_WASM_BYTES = MAX_TOTAL_WASM_BYTES;
const TINY_MODULE_MAX_BYTES = 64;
const MAX_INLINE_WASM_LABEL_PREFIX_CHARS = 24;
const MAX_WASM_LITERAL_SPECIFIER_CHARS = 512;
const MAX_BLOCKED_MESSAGE_BYTES = 4 * 1024;

const WASM_LITERAL_RE = new RegExp(
  "[\"'`]([^\"'`\\s]{1," + MAX_WASM_LITERAL_SPECIFIER_CHARS + "}\\.wasm)[\"'`]",
  "g",
);

const INLINE_WASM_B64_PREFIX = "AGFzbQEAAAA";
const INLINE_WASM_B64_RE = new RegExp(
  "[\"'`](" + INLINE_WASM_B64_PREFIX + "[A-Za-z0-9+/]*={0,2})[\"'`]",
  "g",
);
const MIN_WASM_BYTES = 8;

function inlineWasmKey(sha256: string): string {
  return "inline-wasm:sha256:" + sha256;
}

export function scanForInlineWasm(sources: Array<{ body: string }>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const { body } of sources) {
    if (!body || body.indexOf("WebAssembly") === -1) continue;
    if (body.indexOf(INLINE_WASM_B64_PREFIX) === -1) continue;
    INLINE_WASM_B64_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INLINE_WASM_B64_RE.exec(body)) !== null) {
      const lit = m[1];
      if (!lit || seen.has(lit)) continue;
      seen.add(lit);
      found.push(lit);
      if (found.length >= MAX_WASM_URLS) return found;
    }
  }
  return found;
}

export async function bakeInlineWasm(literals: string[], bake: WasmBake): Promise<WasmBake> {
  let totalBytes = 0;
  for (const buf of Object.values(bake.modules)) totalBytes += buf.byteLength;
  for (const lit of literals) {
    const label = "inline-wasm@" + lit.slice(0, MAX_INLINE_WASM_LABEL_PREFIX_CHARS) + "…";
    if (Object.keys(bake.modules).length >= MAX_WASM_URLS) {
      bake.errors[label] = "skipped: wasm bake module-count cap reached";
      continue;
    }
    try {
      const bin = atob(lit);
      if (bin.length < MIN_WASM_BYTES) {
        bake.errors[label] = "skipped: shorter than the wasm preamble";
        continue;
      }
      if (bin.length > MAX_TOTAL_WASM_BYTES - totalBytes) {
        bake.errors[label] = "skipped: total .wasm bake budget exceeded";
        continue;
      }
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const buf = u8.buffer;
      try {
        if (
          typeof WebAssembly !== "undefined" &&
          typeof WebAssembly.validate === "function" &&
          !WebAssembly.validate(buf)
        ) {
          bake.errors[label] = "skipped: failed WebAssembly.validate";
          continue;
        }
      } catch {}
      const sha = await sha256Hex(buf);
      const key = inlineWasmKey(sha);
      if (Object.prototype.hasOwnProperty.call(bake.modules, key)) continue;
      const entry: WasmBakeManifestEntry = {
        size: buf.byteLength,
        sha256: sha,
        head16: b64(u8.subarray(0, 16)),
        tail16: b64(u8.subarray(Math.max(0, u8.length - 16))),
      };
      if (buf.byteLength <= TINY_MODULE_MAX_BYTES) entry.bytesB64 = b64(u8);
      bake.modules[key] = buf;
      bake.manifest[key] = entry;
      totalBytes += buf.byteLength;
    } catch (err) {
      bake.errors[label] = err instanceof Error ? err.message : String(err);
    }
  }
  return bake;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

function sha256Hex(buf: ArrayBuffer): Promise<string> {
  return crypto.subtle.digest("SHA-256", buf).then((d) => {
    const u8 = new Uint8Array(d);
    let hex = "";
    for (const byte of u8) hex += byte.toString(16).padStart(2, "0");
    return hex;
  });
}

export function scanForWasmUrls(sources: Array<{ body: string; baseUrl: string }>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let resolutions = 0;
  for (const { body, baseUrl } of sources) {
    if (!body || body.indexOf("WebAssembly") === -1) continue;
    const seenLiterals = new Set<string>();
    WASM_LITERAL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WASM_LITERAL_RE.exec(body)) !== null) {
      const literal = m[1];
      if (!literal || seenLiterals.has(literal)) continue;
      if (resolutions >= MAX_WASM_LITERAL_RESOLUTIONS) {
        console.warn(
          `[kitesurf-wasm] MAX_WASM_LITERAL_RESOLUTIONS=${MAX_WASM_LITERAL_RESOLUTIONS} reached; ` +
            `later .wasm literals not prefetched`,
        );
        return found;
      }
      seenLiterals.add(literal);
      resolutions++;
      let abs: string;
      try {
        abs = new URL(literal, baseUrl || undefined).toString();
      } catch {
        continue;
      }
      if (!/^https?:/.test(abs)) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      found.push(abs);
      if (found.length >= MAX_WASM_URLS) return found;
    }
  }
  return found;
}

interface PrefetchWasmModulesOptions {
  urls: string[];
  pageUrl: string;
  connectionId: string;
  mainFrameId?: string;
  mainLoaderId?: string;
  extraHeaders?: Record<string, string>;
  cookieKey: string;
  sandboxOutbound: SandboxOutboundOverride;
}

export async function prefetchWasmModules({
  urls,
  pageUrl,
  connectionId,
  mainFrameId = "",
  mainLoaderId = "",
  extraHeaders = {},
  cookieKey,
  sandboxOutbound,
}: PrefetchWasmModulesOptions): Promise<WasmBake> {
  const bake: WasmBake = { modules: {}, manifest: {}, errors: {} };
  if (urls.length === 0) return bake;

  let pageOrigin = "";
  try {
    const u = new URL(pageUrl);
    pageOrigin = u.protocol + "//" + u.host;
  } catch {
    for (const u of urls) bake.errors[u] = "unparsable page URL: " + pageUrl;
    return bake;
  }

  const outbound = sandboxOutbound.parent({
    ...localTraceParentProps(),
    pageOrigin,
    mainFrameId,
    mainLoaderId,
    extraHeaders,
    connectionId,
    cookieKey,
  });

  let totalBytes = 0;
  const deadlineCtrl = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineCtrl.abort(), PREFETCH_WASM_DEADLINE_MS);
  try {
    await Promise.all(
      urls.map(async (wasmUrl) => {
        const ctrl = new AbortController();
        const onDeadline = () => ctrl.abort();
        deadlineCtrl.signal.addEventListener("abort", onDeadline);
        try {
          const headers: Record<string, string> = {
            "x-kitesurf-resource-type": "Fetch",
            "x-kitesurf-initiator": "wasm-prefetch",
            "x-kitesurf-page-origin": pageOrigin,
          };
          if (connectionId) headers["x-kitesurf-connection-id"] = connectionId;
          if (mainFrameId) headers["x-kitesurf-frame-id"] = mainFrameId;
          let cross = false;
          try {
            cross = new URL(wasmUrl).origin !== new URL(pageUrl).origin;
          } catch {}
          if (cross) headers["origin"] = pageOrigin;
          const walk = await walkRedirects({
            url: wasmUrl,
            signal: ctrl.signal,
            headers,
            taintOriginFrom: pageOrigin || undefined,
            fetchHop: (hopReq) => outbound.fetch(hopReq),
          });
          if (!walk.ok) {
            bake.errors[wasmUrl] = ".wasm fetch too many redirects";
            return;
          }
          const res = walk.response;
          const blockedReason = res.headers.get("x-kitesurf-blocked");
          if (res.status === 403 && blockedReason) {
            const denial = await readCappedText(res, MAX_BLOCKED_MESSAGE_BYTES, connectionId);
            bake.errors[wasmUrl] = denial.ok ? denial.text : ".wasm fetch blocked";
            return;
          }
          if (!res.ok) {
            void res.body?.cancel().catch(() => {});
            bake.errors[wasmUrl] = ".wasm fetch returned HTTP " + res.status;
            return;
          }
          const remaining = MAX_TOTAL_WASM_BYTES - totalBytes;
          const clHeader = res.headers.get("content-length");
          const cl = clHeader ? parseInt(clHeader, 10) : NaN;
          if (Number.isFinite(cl) && cl > remaining) {
            void res.body?.cancel().catch(() => {});
            bake.errors[wasmUrl] =
              "skipped: total .wasm bake budget exceeded (" + cl + " bytes over cap)";
            return;
          }
          const capped = await readCappedBytes(
            res,
            Math.min(remaining, MAX_SINGLE_WASM_BYTES),
            connectionId,
            MAX_SINGLE_WASM_BYTES,
          );
          if (!capped.ok) {
            bake.errors[wasmUrl] =
              capped.failure === "error"
                ? "skipped: .wasm body failed mid-stream"
                : "skipped: exceeded .wasm bake byte budget mid-stream";
            return;
          }
          const buf = capped.bytes.buffer;
          try {
            if (
              typeof WebAssembly !== "undefined" &&
              typeof WebAssembly.validate === "function" &&
              !WebAssembly.validate(buf)
            ) {
              bake.errors[wasmUrl] = "skipped: failed WebAssembly.validate";
              return;
            }
          } catch {}
          // Reads run concurrently: re-check the live total, as a sibling may have been admitted
          // after this read's snapshot. The check and the charge below have no await between them.
          if (buf.byteLength > MAX_TOTAL_WASM_BYTES - totalBytes) {
            bake.errors[wasmUrl] =
              "skipped: total .wasm bake budget exceeded (" + buf.byteLength + " bytes over cap)";
            return;
          }
          totalBytes += buf.byteLength;
          const u8 = new Uint8Array(buf);
          const entry: WasmBakeManifestEntry = {
            size: buf.byteLength,
            sha256: await sha256Hex(buf),
            head16: b64(u8.subarray(0, 16)),
            tail16: b64(u8.subarray(Math.max(0, u8.length - 16))),
          };
          if (buf.byteLength <= TINY_MODULE_MAX_BYTES) entry.bytesB64 = b64(u8);
          bake.modules[wasmUrl] = buf;
          bake.manifest[wasmUrl] = entry;
        } catch (err) {
          bake.errors[wasmUrl] = deadlineCtrl.signal.aborted
            ? ".wasm prefetch exceeded the shared navigate deadline"
            : err instanceof Error
              ? err.message
              : String(err);
        } finally {
          deadlineCtrl.signal.removeEventListener("abort", onDeadline);
        }
      }),
    );
  } finally {
    clearTimeout(deadlineTimer);
  }
  return bake;
}
