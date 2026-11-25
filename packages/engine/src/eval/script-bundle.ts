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

export interface ClassicSourceAnalysis {
  scan: ReturnType<typeof extractTopLevelDecls>;
  lineCount: number;
}

export type ClassicAnalysisCache = Map<string, ClassicSourceAnalysis>;

// A script's declaration scan and line count depend only on its exact source.
// Fetch callbacks prime this cache as bodies arrive, so the bundle build does
// not rescan every byte after the last script lands. A walker rewrite is a
// different string and is analysed on its own.
export function analyzeClassicSource(
  cache: ClassicAnalysisCache | undefined,
  source: string,
): ClassicSourceAnalysis {
  const cached = cache?.get(source);
  if (cached !== undefined) return cached;
  const analysis: ClassicSourceAnalysis = {
    scan: extractTopLevelDecls(source),
    lineCount: countLines(source),
  };
  cache?.set(source, analysis);
  return analysis;
}

// A line terminator in a script URL would end the `//` comment or directive it is placed in.
function commentSafe(text: string): string {
  return text.replace(/[\n\r\u2028\u2029]/g, (c) => encodeURI(c));
}

interface ClassicSegment {
  source: string;
  generatedLine: number;
  lineCount: number;
}

// A page-provided script with many newlines would otherwise allocate and encode a source map
// line for each one before the page runs; above this many generated lines the map is omitted.
const MAX_CLASSIC_SOURCE_MAP_LINES = 50_000;

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
  preNavSource: string | null;
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
  analysisCache?: ClassicAnalysisCache,
): {
  source: string;
  sourceLineOffset: number;
  lineCount: number;
  lexicalNames: string[];
} {
  const label = commentSafe(d.src ? d.src : `inline#${index}`);
  const currentScriptUrl = d.resolvedSrc ?? d.src ?? "";
  const domIdx = typeof d.scriptDomIndex === "number" ? d.scriptDomIndex : -1;
  const rawSrc = d.src ?? "";
  const bracket = opts.currentScript !== false;
  // Only parser-inserted external scripts get load or error here; inserted bakes
  // (currentScript: false) get theirs from the insert path.
  const lifecycle = (ok: boolean): string =>
    !bracket || !d.src
      ? ""
      : `if (__ks_state_local.parserScriptLifecycle) { await __ks_state_local.parserScriptLifecycle(${domIdx}, ${JSON.stringify(rawSrc)}, ${JSON.stringify(currentScriptUrl)}, ${ok}); }\n`;
  if (d.blocked) {
    const source = `console.error(${JSON.stringify(d.blocked.message)});\n${lifecycle(false)}`;
    return { source, sourceLineOffset: 0, lineCount: countLines(source), lexicalNames: [] };
  }
  if (d.prefetchError) {
    const source = `console.error(${JSON.stringify(`[${label}] prefetch failed: ${d.prefetchError}`)});\n${lifecycle(false)}`;
    return { source, sourceLineOffset: 0, lineCount: countLines(source), lexicalNames: [] };
  }
  const source = d.src ? (d.prefetchedSource ?? "") : (d.body ?? "");
  if (!source.trim()) {
    const sourceText = lifecycle(true);
    return {
      source: sourceText,
      sourceLineOffset: 0,
      lineCount: countLines(sourceText),
      lexicalNames: [],
    };
  }

  const bodyKey = !d.src ? (d.body || "").trim().slice(0, INLINE_SCRIPT_BODY_KEY_PREFIX_CHARS) : "";
  const setCurrent = !bracket
    ? ""
    : `__ks_state_local.setCurrentScript(${JSON.stringify(currentScriptUrl)}, ${domIdx}, ${JSON.stringify(bodyKey)}, ${JSON.stringify(rawSrc)});
`;
  const clearCurrent = !bracket
    ? ""
    : "if (__ks_state_local.endClassicScript) { await __ks_state_local.endClassicScript(); } else { __ks_state_local.setCurrentScript(null); }\n";

  const analysis = analyzeClassicSource(analysisCache, source);
  const scan = analysis.scan;
  const blockedNames = new Set(["module", "exports", "require"]);
  let bodySource = source;
  // Top-level let/const/class share one global lexical scope across scripts.
  // https://html.spec.whatwg.org/multipage/webappapis.html#run-a-classic-script
  type SourceEdit = { start: number; end: number; text: string };
  const edits: SourceEdit[] = [];
  for (const start of scan.varSites) edits.push({ start, end: start + 3, text: "   " });
  // `var` is function-scoped, so a lexical declaration inside the segment's try block keeps
  // the binding the wrapper shares with later scripts. A destructuring pattern stays valid.
  for (const start of scan.lexicalSites) {
    const length = source.startsWith("const", start) ? 5 : 3;
    edits.push({ start, end: start + length, text: "var" + " ".repeat(length - 3) });
  }
  // `class Name {}` becomes `Name = class Name {};`. The trailing `;` stops a following
  // `(` or `[` from calling or indexing the class expression.
  for (let i = 0; i < scan.classSites.length; i++) {
    const start = scan.classSites[i];
    const end = scan.classEnds[i];
    const name = scan.classNames[i];
    if (start === undefined || end === undefined || name === undefined) continue;
    edits.push({ start, end: start, text: `${name} = ` });
    edits.push({ start: end, end, text: ";" });
  }
  // `function f` in the try block binds `f` in the block, so the script's own `f = ...` would
  // miss the wrapper binding other scripts read. See the web browser steps of
  // https://tc39.es/ecma262/#sec-functiondeclarationinstantiation
  // Renamed, each declaration is still hoisted to the block start, where `f` is pointed at it.
  const hoistedFunctions = new Map<string, string>();
  const renamedFunctions: { name: string; internal: string }[] = [];
  // A desynced scan can list a function that is not top-level, and the hoist line would
  // then reference a name that is out of scope and throw before the script starts. Leave
  // such a segment unrewritten; it keeps the pre-bundle behaviour instead.
  if (!scan.unreliable) {
    for (let i = 0; i < scan.functionNameSites.length; i++) {
      const start = scan.functionNameSites[i];
      const name = scan.functionNames[i];
      if (start === undefined || name === undefined || blockedNames.has(name)) continue;
      // One name per declaration: a strict block refuses two declarations of the same name.
      const internal = `__ks_fn${i}_${name}`;
      edits.push({ start, end: start + name.length, text: internal });
      // The last declaration of a name is the one the script sees, as at the top level.
      hoistedFunctions.set(name, internal);
      renamedFunctions.push({ name, internal });
    }
  }
  const hoistFunctions =
    [...hoistedFunctions].map(([name, internal]) => `${name} = ${internal}; `).join("") +
    renamedFunctions
      .map(
        ({ name, internal }) =>
          `__ks_define_property(${internal}, "name", { value: ${JSON.stringify(name)} }); ` +
          `__ks_state_local.markRenamed(${internal}, ${JSON.stringify(internal)}, ${JSON.stringify(name)}); `,
      )
      .join("");
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  for (const edit of edits) {
    bodySource = bodySource.slice(0, edit.start) + edit.text + bodySource.slice(edit.end);
  }
  const liveVarNames = scan.varNames.filter((n) => !blockedNames.has(n));
  const predeclareHead =
    liveVarNames.length === 0
      ? ""
      : `// === ${label} (live-globalize top-level vars) ===\n${predeclareVarsHead(liveVarNames, "globalThis", true)}\n`;
  const liveVarSet = new Set(liveVarNames);
  // Lexical names are hoisted for classic scripts and also copied to globalThis
  // so module scripts can see them; the spec keeps them off the global object.
  // https://html.spec.whatwg.org/multipage/webappapis.html#run-a-classic-script
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
  // The catch has to report the failure the way a rejected bucket did, or a pageerror
  // listener sees nothing for a script that threw.
  const reportException = `try { if (__ks_state_local.pushException) __ks_state_local.pushException(__ks_segment_error, { scriptId: "bundle:classic-regular", url: ${JSON.stringify(label)} }); } catch {}`;
  // Load still fires after the currentScript reset, as it did when the segment body ran
  // unwrapped, and a throw does not change that: the spec fires `error` only when the
  // fetch fails. https://html.spec.whatwg.org/multipage/scripting.html#execute-the-script-element
  const lifecycleDynamic =
    !bracket || !d.src
      ? ""
      : `if (__ks_state_local.parserScriptLifecycle) { await __ks_state_local.parserScriptLifecycle(${domIdx}, ${JSON.stringify(rawSrc)}, ${JSON.stringify(currentScriptUrl)}, true); }\n`;
  // hoistFunctions stays on the `try {` line, so the body keeps its line numbers.
  const segmentBody = `try { ${hoistFunctions}
${bodySource}
${promoteTail}} catch (__ks_segment_error) {
  ${reportException}
  console.error("classic script threw: " + String(__ks_segment_error && __ks_segment_error.message || __ks_segment_error));
} finally {
${clearCurrent}${lifecycleDynamic}}\n`;
  const generated = `${prefix}${segmentBody}`;
  return {
    source: generated,
    sourceLineOffset: countLines(prefix) + 1,
    lineCount: countLines(generated),
    // Function names join the hoisted bindings, since the block's first line assigns them.
    lexicalNames: [...scan.lexicalNames, ...hoistedFunctions.keys()],
  };
}

export interface BuildScriptBundleOptions {
  cdpDebug?: boolean;
  additionalModules?: Record<string, BakedModule>;
  importMapModuleSource?: string;
  insertedBake?: ParentScriptDescriptor[];
  insertedDigests?: ReadonlyMap<string, string>;
  analysisCache?: ClassicAnalysisCache;
}

export function buildScriptBundle(
  descriptors: ParentScriptDescriptor[],
  options: BuildScriptBundleOptions = {},
): ScriptBundle {
  const cdpDebug = options.cdpDebug === true;
  const preNav: ParentScriptDescriptor[] = [];
  const regularInline: ParentScriptDescriptor[] = [];
  const regularDeferred: ParentScriptDescriptor[] = [];
  const asyncBucket: ParentScriptDescriptor[] = [];
  const moduleBucket: ParentScriptDescriptor[] = [];
  for (const d of descriptors) {
    if (d.injected) {
      preNav.push(d);
      continue;
    }
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
  const regularLexical = new Set<string>();
  const asyncLexical = new Set<string>();
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
  const countSourceLines = (sourceBody: string): number => {
    if (!sourceBody) return 1;
    const cached = options.analysisCache?.get(sourceBody);
    return (cached ? cached.lineCount : countLines(sourceBody)) + 1;
  };
  const pushSegment = (
    acc: { parts: string[]; lines: number },
    segment: { source: string; sourceLineOffset: number; lineCount: number },
    label: string,
    sourceBody: string,
    metaList: ClassicSegment[],
  ): void => {
    if (!segment.source) return;
    metaList.push({
      source: label,
      generatedLine: acc.lines + segment.sourceLineOffset,
      lineCount: countSourceLines(sourceBody),
    });
    acc.parts.push(segment.source);
    acc.lines += segment.lineCount;
  };
  const segLabel = (d: ParentScriptDescriptor, idx: number): string =>
    d.src ? d.src : `inline#${idx}`;
  const segSourceBody = (d: ParentScriptDescriptor): string =>
    d.prefetchError || d.blocked ? "" : d.src ? (d.prefetchedSource ?? "") : (d.body ?? "");
  for (const d of regularInline) {
    const segment = buildClassicSegment(d, regularIdx, {}, options.analysisCache);
    for (const name of segment.lexicalNames) regularLexical.add(name);
    pushSegment(regularAcc, segment, segLabel(d, regularIdx), segSourceBody(d), regularSegMeta);
    if (cdpDebug) {
      console.log(
        `[kitesurf-nav] segment regularInline#${regularIdx} ` +
          `src=${JSON.stringify(d.src)} added=${segment.source.length}chars`,
      );
    }
    regularIdx++;
  }
  for (const d of regularDeferred) {
    const segment = buildClassicSegment(d, regularIdx, {}, options.analysisCache);
    for (const name of segment.lexicalNames) regularLexical.add(name);
    pushSegment(regularAcc, segment, segLabel(d, regularIdx), segSourceBody(d), regularSegMeta);
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
    const segment = buildClassicSegment(d, asyncIdx, {}, options.analysisCache);
    for (const name of segment.lexicalNames) asyncLexical.add(name);
    pushSegment(asyncAcc, segment, segLabel(d, asyncIdx), segSourceBody(d), asyncSegMeta);
    asyncIdx++;
  }
  // CDP addScriptToEvaluateOnNewDocument source is compiled into its own module so page
  // classic code cannot read it through its enclosing function's source text.
  let preNavBody = "";
  for (const [i, d] of preNav.entries()) preNavBody += buildClassicSegment(d, i).source;
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

  const regularLexicalDecl =
    regularLexical.size > 0 ? `var ${[...regularLexical].join(", ")};\n` : "";
  const asyncLexicalDecl = asyncLexical.size > 0 ? `var ${[...asyncLexical].join(", ")};\n` : "";
  const regularBody = regularLexicalDecl + regularAcc.parts.join("");
  const asyncBody = asyncLexicalDecl + asyncAcc.parts.join("");
  // Runs the pre-navigation module before any page classic source in the same realm.
  const preNavPrelude =
    preNavBody.length > 0
      ? 'await import("./__ks_user_pre_nav.js").then((m) => ((m.default && m.default.run) || m.run)());\n'
      : "";

  const umdShadow = "var module=undefined,exports=undefined,require=undefined;\n";
  // Taken before the first segment runs, so a page that replaces Object.defineProperty
  // does not see the calls that restore function names.
  const stateLocalDecl = `var __ks_define_property = Object.defineProperty;
var __ks_state_local = ((state) => Object.freeze({
  setCurrentScript: (...args) => state.setCurrentScript(...args),
  get endClassicScript() { return state.endClassicScript; },
  get parserScriptLifecycle() { return state.parserScriptLifecycle; },
  get pushException() { return state.pushException; },
  markRenamed: (...args) => { if (state.markRenamed) state.markRenamed(...args); },
  set bundleDiag(value) { state.bundleDiag = value; },
}))((await import("./internal-state.js")).getInternalState());
`;
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
    bodyLineOffset = 0,
  ): { source: string; sourceMapURL: string } => {
    const wrapped = wrap(body);
    const shifted = segments.map((s) => ({
      ...s,
      generatedLine: s.generatedLine + wrapHeaderLines + bodyLineOffset,
    }));
    const totalLines = countLines(wrapped) + 1;
    const sourceMapURL =
      totalLines <= MAX_CLASSIC_SOURCE_MAP_LINES ? buildClassicSourceMap(shifted, totalLines) : "";
    const directives =
      `\n//# sourceURL=${bundleUrl}\n` +
      (sourceMapURL ? `//# sourceMappingURL=${sourceMapURL}\n` : "");
    return { source: wrapped + directives, sourceMapURL };
  };

  let preNavSource: string | null = null;
  if (preNavBody.length > 0) {
    preNavSource = finalize(preNavBody, "/__ks_user_pre_nav.js", []).source;
  }
  let classicRegularSource: string | null = null;
  let classicRegularSourceMapURL = "";
  if (regularBody.length > 0 || preNavBody.length > 0) {
    const r = finalize(
      preNavPrelude + regularBody,
      "/__ks_user_classic_regular.js",
      regularSegMeta,
      countLines(preNavPrelude) + countLines(regularLexicalDecl),
    );
    classicRegularSource = r.source;
    classicRegularSourceMapURL = r.sourceMapURL;
  }
  let classicAsyncSource: string | null = null;
  let classicAsyncSourceMapURL = "";
  if (asyncBody.length > 0) {
    const r = finalize(
      asyncBody,
      "/__ks_user_classic_async.js",
      asyncSegMeta,
      countLines(asyncLexicalDecl),
    );
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
    const segment = buildClassicSegment(d, i, { currentScript: false }, options.analysisCache);
    const lexicalDecl =
      segment.lexicalNames.length > 0
        ? `var ${[...new Set(segment.lexicalNames)].join(", ")};\n`
        : "";
    insertedModules[module] =
      prodWrap(lexicalDecl + segment.source, hasUseStrictDirective(source)) +
      `\n//# sourceURL=${commentSafe(url)}\n`;
    insertedManifest.push({ url, module, digest });
  }

  return {
    insertedModules,
    insertedManifest,
    classicRegularSource,
    classicAsyncSource,
    preNavSource,
    moduleScriptUrls,
    additionalModules,
    importMapModuleSource: options.importMapModuleSource ?? FALLBACK_MODULE_RESOLVER_SOURCE,
    classicRegularSourceMapURL,
    classicAsyncSourceMapURL,
  };
}
