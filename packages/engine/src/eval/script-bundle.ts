// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds classic-script bundles, module tables, and source maps for PageScript.

import type { ParentScriptDescriptor } from "../wasm.ts";
import {
  extractTopLevelDecls,
  hasUseStrictDirective,
  predeclareVarsHead,
  scriptSourceDigest,
} from "@kitesurf/script-gate";
import { type BakedModule, FALLBACK_MODULE_RESOLVER_SOURCE } from "./walk-module-graph.ts";

const INLINE_SCRIPT_BODY_KEY_PREFIX_CHARS = 120;

const VLQ_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeVLQ(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 0b11111;
    v >>>= 5;
    if (v > 0) digit |= 0b100000;
    out += VLQ_ALPHABET[digit];
  } while (v > 0);
  return out;
}

function countLines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0x0a) n++;
  return n;
}

interface ClassicSegment {
  source: string;
  generatedLine: number;
  lineCount: number;
}

function buildClassicSourceMap(segments: ClassicSegment[], totalLines: number): string {
  if (segments.length === 0) return "";
  const sources = segments.map((s) => s.source);
  const lineSegments: string[] = new Array(totalLines).fill("");
  let prevSourceIdx = 0;
  let prevOrigLine = 0;
  for (const [sourceIdx, seg] of segments.entries()) {
    const dSource = sourceIdx - prevSourceIdx;
    for (let j = 0; j < seg.lineCount; j++) {
      const genLine = seg.generatedLine + j;
      if (genLine >= totalLines) break;
      const dOrigLine = j - prevOrigLine;
      lineSegments[genLine] =
        encodeVLQ(0) + encodeVLQ(j === 0 ? dSource : 0) + encodeVLQ(dOrigLine) + encodeVLQ(0);
      prevOrigLine = j;
    }
    prevSourceIdx = sourceIdx;
    prevOrigLine = 0;
  }
  const mappings = lineSegments.join(";");
  const map = {
    version: 3,
    file: "",
    sources,
    sourcesContent: segments.map(() => null),
    names: [] as string[],
    mappings,
  };
  const json = JSON.stringify(map);
  let b64: string;
  try {
    b64 = btoa(json);
  } catch {
    b64 = btoa(unescape(encodeURIComponent(json)));
  }
  return `data:application/json;base64,${b64}`;
}

export interface ScriptBundle {
  classicRegularSource: string | null;
  classicAsyncSource: string | null;
  moduleScriptUrls: string[];
  additionalModules: Record<string, BakedModule>;
  importMapModuleSource: string;
  classicRegularSourceMapURL?: string;
  classicAsyncSourceMapURL?: string;
  insertedModules: Record<string, string>;
  insertedManifest: InsertedBakeEntry[];
}

export interface InsertedBakeEntry {
  url: string;
  module: string;
  digest: string;
}

export async function insertedSourceDigests(
  bake: readonly ParentScriptDescriptor[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    bake.map(async (d) => {
      const url = d.resolvedSrc ?? d.src;
      if (url && typeof d.prefetchedSource === "string")
        out.set(url, await scriptSourceDigest(d.prefetchedSource));
    }),
  );
  return out;
}

function buildClassicSegment(
  d: ParentScriptDescriptor,
  index: number,
  opts: { currentScript?: boolean } = {},
): { source: string; sourceLineOffset: number } {
  const label = d.src ? d.src : `inline#${index}`;
  if (d.blocked) {
    return {
      source: `console.error(${JSON.stringify(d.blocked.message)});\n`,
      sourceLineOffset: 0,
    };
  }
  if (d.prefetchError) {
    return {
      source: `console.error(${JSON.stringify(`[${label}] prefetch failed: ${d.prefetchError}`)});\n`,
      sourceLineOffset: 0,
    };
  }
  const source = d.src ? (d.prefetchedSource ?? "") : (d.body ?? "");
  if (!source.trim()) return { source: "", sourceLineOffset: 0 };

  const currentScriptUrl = d.resolvedSrc ?? d.src ?? "";
  const domIdx = typeof d.scriptDomIndex === "number" ? d.scriptDomIndex : -1;
  const bodyKey = !d.src ? (d.body || "").trim().slice(0, INLINE_SCRIPT_BODY_KEY_PREFIX_CHARS) : "";
  const rawSrc = d.src ?? "";
  const bracket = opts.currentScript !== false;
  const setCurrent = !bracket
    ? ""
    : `__ks_state_local.setCurrentScript(${JSON.stringify(currentScriptUrl)}, ${domIdx}, ${JSON.stringify(bodyKey)}, ${JSON.stringify(rawSrc)});
`;
  const clearCurrent = !bracket
    ? ""
    : "if (__ks_state_local.endClassicScript) { await __ks_state_local.endClassicScript(); } else { __ks_state_local.setCurrentScript(null); }\n";

  const scan = extractTopLevelDecls(source);
  const blockedNames = new Set(["module", "exports", "require"]);
  let bodySource = source;
  if (scan.varSites.length > 0) {
    const parts: string[] = [];
    let last = 0;
    for (const kwStart of scan.varSites) {
      parts.push(bodySource.slice(last, kwStart), "   ");
      last = kwStart + 3;
    }
    parts.push(bodySource.slice(last));
    bodySource = parts.join("");
  }
  const liveVarNames = scan.varNames.filter((n) => !blockedNames.has(n));
  const predeclareHead =
    liveVarNames.length === 0
      ? ""
      : `// === ${label} (live-globalize top-level vars) ===\n${predeclareVarsHead(liveVarNames, "globalThis")}\n`;
  const liveVarSet = new Set(liveVarNames);
  const topDecls = scan.names.filter((n) => !liveVarSet.has(n));
  let promoteTail = "";
  if (topDecls.length > 0) {
    const lines: string[] = [];
    for (const n of topDecls) {
      if (blockedNames.has(n)) continue;
      lines.push(`try { if (typeof ${n} !== "undefined") globalThis.${n} = ${n}; } catch (e) {}`);
    }
    if (lines.length > 0) {
      promoteTail = `// === ${label} (promote top-level decls to globalThis) ===
${lines.join("\n")}
`;
    }
  }
  const prefix = `// === ${label} ===\n${predeclareHead}if (typeof globalThis.require !== "undefined") require = globalThis.require;\n${setCurrent}`;
  return {
    source: `${prefix}${bodySource}\n${promoteTail}${clearCurrent}\n`,
    sourceLineOffset: countLines(prefix),
  };
}

export interface BuildScriptBundleOptions {
  cdpDebug?: boolean;
  additionalModules?: Record<string, BakedModule>;
  importMapModuleSource?: string;
  insertedBake?: ParentScriptDescriptor[];
  insertedDigests?: ReadonlyMap<string, string>;
}

export function buildScriptBundle(
  descriptors: ParentScriptDescriptor[],
  options: BuildScriptBundleOptions = {},
): ScriptBundle {
  const cdpDebug = options.cdpDebug === true;
  const regularInline: ParentScriptDescriptor[] = [];
  const regularDeferred: ParentScriptDescriptor[] = [];
  const asyncBucket: ParentScriptDescriptor[] = [];
  const moduleBucket: ParentScriptDescriptor[] = [];
  for (const d of descriptors) {
    if (d.kind === "module") {
      moduleBucket.push(d);
      continue;
    }
    if (d.async && d.src) {
      asyncBucket.push(d);
    } else if (d.defer && d.src) {
      regularDeferred.push(d);
    } else {
      regularInline.push(d);
    }
  }

  const regularAcc = { parts: [] as string[], lines: 0 };
  const asyncAcc = { parts: [] as string[], lines: 0 };
  const moduleScriptUrls: string[] = [];
  const additionalModules: Record<string, BakedModule> = {
    ...(options.additionalModules ?? {}),
  };
  const walkerSupplied = options.additionalModules != null;
  const regularSegMeta: ClassicSegment[] = [];
  const asyncSegMeta: ClassicSegment[] = [];
  let regularIdx = 0;
  if (cdpDebug) {
    console.log(
      `[kitesurf-nav] bucketize: regularInline=${regularInline.length} ` +
        `regularDeferred=${regularDeferred.length} ` +
        `async=${asyncBucket.length} modules=${moduleBucket.length}`,
    );
  }
  const pushSegment = (
    acc: { parts: string[]; lines: number },
    seg: string,
    sourceLineOffset: number,
    label: string,
    sourceBody: string,
    metaList: ClassicSegment[],
  ): void => {
    if (!seg) return;
    const sourceLines = countLines(sourceBody) + 1;
    metaList.push({
      source: label,
      generatedLine: acc.lines + sourceLineOffset,
      lineCount: sourceLines,
    });
    acc.parts.push(seg);
    acc.lines += countLines(seg);
  };
  const segLabel = (d: ParentScriptDescriptor, idx: number): string =>
    d.src ? d.src : `inline#${idx}`;
  const segSourceBody = (d: ParentScriptDescriptor): string =>
    d.prefetchError || d.blocked ? "" : d.src ? (d.prefetchedSource ?? "") : (d.body ?? "");
  for (const d of regularInline) {
    const segment = buildClassicSegment(d, regularIdx);
    pushSegment(
      regularAcc,
      segment.source,
      segment.sourceLineOffset,
      segLabel(d, regularIdx),
      segSourceBody(d),
      regularSegMeta,
    );
    if (cdpDebug) {
      console.log(
        `[kitesurf-nav] segment regularInline#${regularIdx} ` +
          `src=${JSON.stringify(d.src)} added=${segment.source.length}chars`,
      );
    }
    regularIdx++;
  }
  for (const d of regularDeferred) {
    const segment = buildClassicSegment(d, regularIdx);
    pushSegment(
      regularAcc,
      segment.source,
      segment.sourceLineOffset,
      segLabel(d, regularIdx),
      segSourceBody(d),
      regularSegMeta,
    );
    if (cdpDebug) {
      console.log(
        `[kitesurf-nav] segment regularDeferred#${regularIdx} ` +
          `src=${JSON.stringify(d.src)} added=${segment.source.length}chars`,
      );
    }
    regularIdx++;
  }
  let asyncIdx = 0;
  for (const d of asyncBucket) {
    const segment = buildClassicSegment(d, asyncIdx);
    pushSegment(
      asyncAcc,
      segment.source,
      segment.sourceLineOffset,
      segLabel(d, asyncIdx),
      segSourceBody(d),
      asyncSegMeta,
    );
    asyncIdx++;
  }
  for (const [mi, d] of moduleBucket.entries()) {
    if (d.blocked) {
      const errorUrl = `https://kitesurf-error.invalid/module-${mi}.js`;
      additionalModules[errorUrl] =
        `console.error(${JSON.stringify(d.blocked.message)});\nexport {};\n`;
      moduleScriptUrls.push(errorUrl);
      continue;
    }
    if (d.prefetchError) {
      const errorUrl = `https://kitesurf-error.invalid/module-${mi}.js`;
      additionalModules[errorUrl] = `console.error(${JSON.stringify(
        `[${d.src || "inline-module"}] module prefetch failed: ${d.prefetchError}`,
      )});\nexport {};\n`;
      moduleScriptUrls.push(errorUrl);
      continue;
    }
    const src = d.src ? (d.prefetchedSource ?? "") : (d.body ?? "");
    if (!src.trim()) continue;
    let url = d.resolvedSrc ?? null;
    if (!url) {
      url = d.src
        ? `https://kitesurf-fallback.invalid/external-${mi}.js`
        : `https://kitesurf-fallback.invalid/inline-${mi}.js`;
    }
    if (!walkerSupplied || additionalModules[url] === undefined) {
      additionalModules[url] = src;
    }
    moduleScriptUrls.push(url);
  }

  const regularBody = regularAcc.parts.join("");
  const asyncBody = asyncAcc.parts.join("");

  const umdShadow = "var module=undefined,exports=undefined,require=undefined;\n";
  const stateLocalDecl =
    'var __ks_state_local = (await import("./internal-state.js")).getInternalState();\n';
  const prodWrap = (body: string, strict = false): string =>
    `module.exports.run = async function () {
${strict ? '"use strict"; ' : ""}${stateLocalDecl}${umdShadow}${body}
};
`;
  const debugWrap = (body: string): string =>
    `module.exports.run = async function () {
${stateLocalDecl}${umdShadow}var __ks_diag = __ks_state_local.bundleDiag = {
  entered: true,
  exited: false,
  bodyChars: ${JSON.stringify(body.length)},
  entryDom: null,
  exitDom: null,
};
console.log('[kitesurf-debug] bundle body entered, bodyChars=' + ${JSON.stringify(body.length)});
try {
  var __ks_doc = (typeof document !== 'undefined') ? document : null;
  var __ks_root = __ks_doc && __ks_doc.getElementById ? __ks_doc.getElementById('root') : null;
  var __ks_body = __ks_doc ? __ks_doc.body : null;
  var __ks_entry = {
    hasDocument: !!__ks_doc,
    hasBody: !!__ks_body,
    bodyChildCount: __ks_body && __ks_body.children ? __ks_body.children.length : -1,
    rootExists: !!__ks_root,
    rootTag: __ks_root && __ks_root.tagName ? __ks_root.tagName : null,
    rootChildCount: __ks_root && __ks_root.children ? __ks_root.children.length : -1
  };
  __ks_diag.entryDom = __ks_entry;
  console.log('[kitesurf-debug] entryDom', JSON.stringify(__ks_entry));
} catch (e) {
  __ks_diag.entryDom = { error: String(e && e.message || e) };
  console.log('[kitesurf-debug] entryDom snapshot threw:', String(e && e.message || e));
}
${body}
console.log('[kitesurf-debug] bundle body completed (last user statement returned)');
try {
  var __ks_doc2 = (typeof document !== 'undefined') ? document : null;
  var __ks_root2 = __ks_doc2 && __ks_doc2.getElementById ? __ks_doc2.getElementById('root') : null;
  var __ks_body2 = __ks_doc2 ? __ks_doc2.body : null;
  var __ks_exit = {
    bodyChildCount: __ks_body2 && __ks_body2.children ? __ks_body2.children.length : -1,
    rootChildCount: __ks_root2 && __ks_root2.children ? __ks_root2.children.length : -1,
    rootTextLen: __ks_root2 && typeof __ks_root2.textContent === 'string' ? __ks_root2.textContent.length : -1
  };
  __ks_diag.exitDom = __ks_exit;
  console.log('[kitesurf-debug] exitDom', JSON.stringify(__ks_exit));
} catch (e) {
  __ks_diag.exitDom = { error: String(e && e.message || e) };
  console.log('[kitesurf-debug] exitDom snapshot threw:', String(e && e.message || e));
}
__ks_diag.exited = true;
};
`;
  const wrap = cdpDebug ? debugWrap : prodWrap;

  const wrapEmpty = wrap("");
  const wrapHeaderLines =
    wrapEmpty.indexOf("\n};\n") >= 0
      ? countLines(wrapEmpty.slice(0, wrapEmpty.indexOf("\n};\n")))
      : countLines(wrapEmpty);

  const finalize = (
    body: string,
    bundleUrl: string,
    segments: ClassicSegment[],
  ): { source: string; sourceMapURL: string } => {
    const wrapped = wrap(body);
    const shifted = segments.map((s) => ({
      ...s,
      generatedLine: s.generatedLine + wrapHeaderLines,
    }));
    const totalLines = countLines(wrapped) + 1;
    const sourceMapURL = buildClassicSourceMap(shifted, totalLines);
    const directives =
      `\n//# sourceURL=${bundleUrl}\n` +
      (sourceMapURL ? `//# sourceMappingURL=${sourceMapURL}\n` : "");
    return { source: wrapped + directives, sourceMapURL };
  };

  let classicRegularSource: string | null = null;
  let classicRegularSourceMapURL = "";
  if (regularBody.length > 0) {
    const r = finalize(regularBody, "/__ks_user_classic_regular.js", regularSegMeta);
    classicRegularSource = r.source;
    classicRegularSourceMapURL = r.sourceMapURL;
  }
  let classicAsyncSource: string | null = null;
  let classicAsyncSourceMapURL = "";
  if (asyncBody.length > 0) {
    const r = finalize(asyncBody, "/__ks_user_classic_async.js", asyncSegMeta);
    classicAsyncSource = r.source;
    classicAsyncSourceMapURL = r.sourceMapURL;
  }

  const insertedModules: Record<string, string> = {};
  const insertedManifest: InsertedBakeEntry[] = [];
  for (const [i, d] of (options.insertedBake ?? []).entries()) {
    const source = d.prefetchedSource;
    const url = d.resolvedSrc ?? d.src;
    const digest = url ? options.insertedDigests?.get(url) : undefined;
    if (typeof source !== "string" || !source.trim() || !url || !digest) continue;
    const module = `__ks_inserted_${i}.js`;
    insertedModules[module] =
      prodWrap(
        buildClassicSegment(d, i, { currentScript: false }).source,
        hasUseStrictDirective(source),
      ) + `\n//# sourceURL=${url}\n`;
    insertedManifest.push({ url, module, digest });
  }

  return {
    insertedModules,
    insertedManifest,
    classicRegularSource,
    classicAsyncSource,
    moduleScriptUrls,
    additionalModules,
    importMapModuleSource: options.importMapModuleSource ?? FALLBACK_MODULE_RESOLVER_SOURCE,
    classicRegularSourceMapURL,
    classicAsyncSourceMapURL,
  };
}
