// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Runs the source-based legacy script plan and dispatches document lifecycle events.
// The normal path bundles classic scripts into one sloppy CJS module; this plan runs only when the
// parent supplied no bundle, and it is not script-gated.

import { AsyncFunction } from "./eval-helpers.ts";
import { ksEventCtors, state } from "./state.ts";
import { trustedFetch } from "./trusted-fetch.ts";

export interface ScriptDescriptor {
  src: string | null;
  kind: "classic" | "module";
  defer: boolean;
  async: boolean;
  body: string;
  _resolvedUrl?: string;
}

interface FetchResultOk {
  ok: true;
  source: string;
}
interface FetchResultErr {
  ok: false;
  error: string;
}
type FetchResult = FetchResultOk | FetchResultErr;

export interface ScriptPlan {
  regular: ScriptDescriptor[];
  deferred: ScriptDescriptor[];
  async_: ScriptDescriptor[];
  modules: ScriptDescriptor[];
  sourceCache: Map<string, Promise<FetchResult>>;
}

type ScriptDom = NonNullable<typeof state.dom>;

const supportedScriptTypes = new Set(["", "text/javascript", "application/javascript", "module"]);

function scriptAttributeValues(info: ReturnType<ScriptDom["nodeInfo"]>): unknown[] {
  if (!info) return [];
  return ((info as { attributes?: unknown[] }).attributes as unknown[]) || [];
}

function scriptNodeIds(dom: ScriptDom | null): ArrayLike<number> | null {
  if (!dom) return null;
  try {
    return dom.querySelectorAll("script");
  } catch {
    return null;
  }
}

function scriptAttributes(dom: ScriptDom, id: number): Record<string, string> | null {
  let info: ReturnType<ScriptDom["nodeInfo"]>;
  try {
    info = dom.nodeInfo(id);
  } catch {
    return null;
  }
  const flat = scriptAttributeValues(info);
  const attrs: Record<string, string> = {};
  for (let index = 0; index + 1 < flat.length; index += 2) {
    attrs[String(flat[index]).toLowerCase()] = String(flat[index + 1] ?? "");
  }
  return attrs;
}

function scriptBody(dom: ScriptDom, id: number, src: string): string {
  if (src) return "";
  try {
    return dom.textContent(id);
  } catch {
    return "";
  }
}

function isEmptyInlineScript(src: string, body: string): boolean {
  return !src && (!body || !body.trim());
}

function descriptorFromAttributes(
  dom: ScriptDom,
  id: number,
  attrs: Record<string, string>,
  rawType: string,
): ScriptDescriptor | null {
  const src = attrs.src ? String(attrs.src).trim() : "";
  const body = scriptBody(dom, id, src);
  if (isEmptyInlineScript(src, body)) return null;
  return {
    src: src || null,
    kind: rawType === "module" ? "module" : "classic",
    defer: "defer" in attrs,
    async: "async" in attrs,
    body,
  };
}

function scriptDescriptor(dom: ScriptDom, id: number): ScriptDescriptor | null {
  const attrs = scriptAttributes(dom, id);
  if (attrs === null) return null;
  const rawType = (attrs.type || "").trim().toLowerCase();
  if (!supportedScriptTypes.has(rawType)) return null;
  return descriptorFromAttributes(dom, id, attrs, rawType);
}

export function extractScripts(): ScriptDescriptor[] {
  const dom = state.dom;
  const ids = scriptNodeIds(dom);
  if (!dom || !ids) return [];
  const out: ScriptDescriptor[] = [];
  for (let index = 0; index < ids.length; index++) {
    const descriptor = scriptDescriptor(dom, ids[index]);
    if (descriptor) out.push(descriptor);
  }
  return out;
}

function resolveScriptUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  try {
    return state.pageUrl ? new URL(src, state.pageUrl).toString() : new URL(src).toString();
  } catch {
    return null;
  }
}

async function fetchScriptSource(url: string): Promise<string> {
  const response = await trustedFetch(
    url,
    { headers: { accept: "*/*" } },
    { resourceType: "Script", initiator: "parser" },
  );
  if (!response.ok) {
    throw new Error("<script src> fetch returned HTTP " + response.status + " for " + url);
  }
  return await response.text();
}

async function runOneClassic(source: string, label: string): Promise<void> {
  if (!source) return;
  try {
    if (/\bawait\b/.test(source)) {
      const scriptFunction = new AsyncFunction(source);
      await scriptFunction();
    } else {
      let src = source;
      const m =
        /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*("use strict"|'use strict')\s*;?\s*/.exec(src);
      if (m) src = src.slice(0, m.index) + src.slice(m.index + m[0].length);
      // eslint-disable-next-line no-eval
      (0, eval)(src);
    }
  } catch (err) {
    console.error("[" + label + "]", err);
  }
}

function classifyScript(script: ScriptDescriptor, plan: ScriptPlan): void {
  if (script.kind === "module") {
    plan.modules.push(script);
    return;
  }
  if (isExternalAsyncScript(script)) {
    plan.async_.push(script);
  } else if (isExternalDeferredScript(script)) {
    plan.deferred.push(script);
  } else {
    plan.regular.push(script);
  }
}

function isExternalAsyncScript(script: ScriptDescriptor): boolean {
  return script.async && !!script.src;
}

function isExternalDeferredScript(script: ScriptDescriptor): boolean {
  return script.defer && !!script.src;
}

function startScriptFetch(
  sourceCache: Map<string, Promise<FetchResult>>,
  url: string,
): Promise<FetchResult> {
  const existing = sourceCache.get(url);
  if (existing) return existing;
  const fetchPromise: Promise<FetchResult> = (async () => {
    try {
      const source = await fetchScriptSource(url);
      return { ok: true, source };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  })();
  sourceCache.set(url, fetchPromise);
  return fetchPromise;
}

function prefetchScript(
  scripts: ScriptDescriptor[],
  sourceCache: Map<string, Promise<FetchResult>>,
): void {
  for (const script of scripts) {
    if (!script.src) continue;
    const url = resolveScriptUrl(script.src);
    if (!url) {
      console.error("[kitesurf] cannot resolve <script src>: " + String(script.src));
      continue;
    }
    script._resolvedUrl = url;
    startScriptFetch(sourceCache, url);
  }
}

export function planScripts(scripts: ScriptDescriptor[]): ScriptPlan {
  const plan: ScriptPlan = {
    regular: [],
    deferred: [],
    async_: [],
    modules: [],
    sourceCache: new Map(),
  };
  for (const script of scripts) classifyScript(script, plan);
  prefetchScript(
    [...plan.regular, ...plan.deferred, ...plan.async_, ...plan.modules],
    plan.sourceCache,
  );

  return plan;
}

export async function runRegularPhase(plan: ScriptPlan): Promise<void> {
  for (const script of plan.regular) {
    await runRegularScript(script, plan.sourceCache);
  }
  for (const script of plan.deferred) {
    await runExternalScript(
      script,
      plan.sourceCache,
      "[kitesurf] deferred <script src> fetch failed for ",
    );
  }
}

async function runRegularScript(
  script: ScriptDescriptor,
  sourceCache: Map<string, Promise<FetchResult>>,
): Promise<void> {
  if (script.src) {
    await runExternalScript(script, sourceCache, "[kitesurf] <script src> fetch failed for ");
    return;
  }
  await runOneClassic(script.body, "<inline>");
}

async function runExternalScript(
  script: ScriptDescriptor,
  sourceCache: Map<string, Promise<FetchResult>>,
  failurePrefix: string,
): Promise<void> {
  const url = script._resolvedUrl;
  if (!url) return;
  const fetchResult = await sourceCache.get(url);
  if (!fetchResult || !fetchResult.ok) {
    console.error(failurePrefix + url + ": " + fetchErrorDetail(fetchResult));
    return;
  }
  await runOneClassic(fetchResult.source, url);
}

function fetchErrorDetail(result: FetchResult | undefined): string {
  if (!result) return "unknown";
  if (result.ok) return "unknown";
  return "error" in result ? result.error || "unknown" : "unknown";
}

export async function runAsyncPhase(plan: ScriptPlan): Promise<void> {
  await Promise.all(
    plan.async_.map((script) =>
      runExternalScript(
        script,
        plan.sourceCache,
        "[kitesurf] async <script src> fetch failed for ",
      ),
    ),
  );
}

type ModuleExports = Record<string, unknown>;

const moduleExportsCache = new Map<string, Promise<ModuleExports>>();

async function loadModule(spec: string, baseUrl: string): Promise<ModuleExports> {
  const url = (() => {
    try {
      return new URL(spec, baseUrl).toString();
    } catch {
      return null;
    }
  })();
  if (!url) {
    console.warn("[kitesurf] cannot resolve module specifier:", spec);
    return {};
  }
  const cached = moduleExportsCache.get(url);
  if (cached) return cached;
  const modulePromise: Promise<ModuleExports> = (async () => {
    let source: string;
    try {
      source = await fetchScriptSource(url);
    } catch (err) {
      console.warn("[kitesurf] module fetch failed for " + url, err);
      return {};
    }
    const exportsObj: ModuleExports = {};
    const { code, deps } = transpileModule(source);
    const depEntries = await Promise.all(
      deps.map(async (d) => [d.local, await loadModule(d.spec, url)] as const),
    );
    const depBindings: Record<string, ModuleExports> = {};
    for (const [name, ns] of depEntries) depBindings[name] = ns;
    try {
      const paramNames = ["__ks_exports", "__ks_baseUrl", ...Object.keys(depBindings)];
      const paramValues: unknown[] = [exportsObj, url, ...Object.values(depBindings)];
      const moduleFunction = new AsyncFunction(...paramNames, code);
      await moduleFunction(...paramValues);
    } catch (err) {
      console.warn("[kitesurf] module exec failed for " + url, err);
    }
    return exportsObj;
  })();
  moduleExportsCache.set(url, modulePromise);
  return modulePromise;
}

interface ModuleDep {
  local: string;
  spec: string;
}

function transpileModule(source: string): { code: string; deps: ModuleDep[] } {
  let out = source;
  const deps: ModuleDep[] = [];
  let depCounter = 0;
  const nextDepLocal = () => "__ks_dep_" + ++depCounter;

  out = out.replace(
    /\bimport\s*\*\s*as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*from\s*(['"])([^'"\n]+)\2\s*;?/g,
    (_, ns, _q, spec) => {
      const local = nextDepLocal();
      deps.push({ local, spec });
      return "const " + ns + " = " + local + ";";
    },
  );

  out = out.replace(
    /\bimport\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\3\s*;?/g,
    (_, def, named, _q, spec) => {
      const local = nextDepLocal();
      deps.push({ local, spec });
      return (
        "const " +
        def +
        " = " +
        local +
        ".default; " +
        "const {" +
        rewriteNamedBindings(named) +
        "} = " +
        local +
        ";"
      );
    },
  );

  out = out.replace(
    /\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\2\s*;?/g,
    (_, named, _q, spec) => {
      const local = nextDepLocal();
      deps.push({ local, spec });
      return "const {" + rewriteNamedBindings(named) + "} = " + local + ";";
    },
  );

  out = out.replace(
    /\bimport\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*from\s*(['"])([^'"\n]+)\2\s*;?/g,
    (_, def, _q, spec) => {
      const local = nextDepLocal();
      deps.push({ local, spec });
      return "const " + def + " = " + local + ".default;";
    },
  );

  out = out.replace(/\bimport\s*(['"])([^'"\n]+)\1\s*;?/g, (_, _q, spec) => {
    const local = nextDepLocal();
    deps.push({ local, spec });
    return "void " + local + ";";
  });

  out = out.replace(
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
    (_, _q, spec) => "__ks_loadModule(" + JSON.stringify(spec) + ", __ks_baseUrl)",
  );

  out = out.replace(
    /\bexport\s+(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g,
    "$1 $2 = __ks_exports.$2 =",
  );

  out = out.replace(
    /\bexport\s+(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    "$1function $2",
  );
  const funcExportNames: string[] = [];
  source.replace(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g, (_, name) => {
    funcExportNames.push(name);
    return "";
  });
  for (const name of funcExportNames) {
    out += "; __ks_exports." + name + " = " + name + ";";
  }

  const classExportNames: string[] = [];
  source.replace(/\bexport\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g, (_, name) => {
    classExportNames.push(name);
    return "";
  });
  out = out.replace(/\bexport\s+class\s+/g, "class ");
  for (const name of classExportNames) {
    out += "; __ks_exports." + name + " = " + name + ";";
  }

  out = out.replace(/\bexport\s*\{([^}]*)\}\s*;?/g, (_, body) => {
    const parts = body
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    return parts
      .map((p: string) => {
        const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(p);
        if (m) return "__ks_exports." + m[2] + " = " + m[1] + ";";
        const m2 = /^([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(p);
        if (m2) return "__ks_exports." + m2[1] + " = " + m2[1] + ";";
        return "";
      })
      .join(" ");
  });

  out = out.replace(/\bexport\s+default\s+/g, "__ks_exports.default = ");

  return { code: out, deps };
}

function rewriteNamedBindings(body: string): string {
  return body
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(p);
      return m ? m[1] + ": " + m[2] : p;
    })
    .join(", ");
}

export async function runModulePhase(plan: ScriptPlan): Promise<void> {
  for (const script of plan.modules) {
    const module = await moduleSource(script, plan.sourceCache);
    if (module) await executeModule(module.source, module.baseUrl, module.label);
  }
}

interface ModuleSource {
  source: string;
  baseUrl: string;
  label: string;
}

async function moduleSource(
  script: ScriptDescriptor,
  sourceCache: Map<string, Promise<FetchResult>>,
): Promise<ModuleSource | null> {
  if (!script.src) return inlineModuleSource(script.body);
  return externalModuleSource(script, sourceCache);
}

function inlineModuleSource(body: string): ModuleSource | null {
  const source = body || "";
  return source.trim() ? { source, baseUrl: state.pageUrl, label: "<inline-module>" } : null;
}

async function externalModuleSource(
  script: ScriptDescriptor,
  sourceCache: Map<string, Promise<FetchResult>>,
): Promise<ModuleSource | null> {
  const url = script._resolvedUrl;
  if (!url) {
    console.error("[kitesurf] cannot resolve module <script src>: " + String(script.src));
    return null;
  }
  const fetchResult = await sourceCache.get(url);
  return moduleFromFetchResult(url, fetchResult);
}

function moduleFromFetchResult(
  url: string,
  fetchResult: FetchResult | undefined,
): ModuleSource | null {
  if (!fetchResult || !fetchResult.ok) {
    console.error(
      "[kitesurf] module <script src> fetch failed for " + url,
      fetchErrorDetail(fetchResult) || "unknown fetch error",
    );
    return null;
  }
  return { source: fetchResult.source, baseUrl: url, label: url };
}

async function executeModule(source: string, baseUrl: string, label: string): Promise<void> {
  try {
    const exportsObj: ModuleExports = {};
    const { code, deps } = transpileModule(source);
    const depEntries = await Promise.all(
      deps.map(
        async (dependency) =>
          [dependency.local, await loadModule(dependency.spec, baseUrl)] as const,
      ),
    );
    const paramNames = ["__ks_exports", "__ks_baseUrl", ...depEntries.map(([name]) => name)];
    const paramValues: unknown[] = [exportsObj, baseUrl, ...depEntries.map(([, value]) => value)];
    const moduleFunction = new AsyncFunction(...paramNames, code);
    await moduleFunction(...paramValues);
  } catch (err) {
    console.error("[" + label + "]", err);
  }
}

export function dispatchLifecycle(
  target: { dispatchEvent?: (ev: unknown) => boolean } | null,
  type: string,
  init?: Record<string, unknown>,
): void {
  if (!hasLifecycleDispatcher(target)) return;
  const EventConstructor = ksEventCtors.Event;
  if (typeof EventConstructor !== "function") return;
  dispatchLifecycleEvent(target, type, init, EventConstructor);
}

function hasLifecycleDispatcher(
  target: { dispatchEvent?: (ev: unknown) => boolean } | null,
): target is { dispatchEvent: (ev: unknown) => boolean } {
  return !!target && typeof target.dispatchEvent === "function";
}

function dispatchLifecycleEvent(
  target: { dispatchEvent: (ev: unknown) => boolean },
  type: string,
  init: Record<string, unknown> | undefined,
  EventConstructor: unknown,
): void {
  try {
    const event = new (EventConstructor as new (
      type: string,
      init?: Record<string, unknown>,
    ) => unknown)(type, init || {});
    target.dispatchEvent(event);
  } catch (err) {
    console.error("[kitesurf] lifecycle " + type + " dispatch failed", err);
  }
}
