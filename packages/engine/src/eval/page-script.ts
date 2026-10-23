// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Loads each page generation's PageScript isolate and wires its RPC, egress, and tails.

import type Protocol from "devtools-protocol";
import wasmGlueSource from "../../../core/pkg/kitesurf_core.glue.js";
import { DOM_SHIM_SOURCE } from "@kitesurf/dom-shim";
import { INTERNAL_STATE_SOURCE, PAGE_SCRIPT_SOURCE } from "@kitesurf/page-script";
import type { RenderPortStub } from "@kitesurf/jsrpc-types/page-renderer";
import type {
  PageScriptEntrypoint,
  PageScriptEntrypointStub,
  PageScriptSession,
  ReceivedUpstreamParams,
  SessionOutbound,
  UpstreamEventName,
} from "@kitesurf/jsrpc-types/page-script";

export type UpstreamEventHandler = (
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
) => void;
import type {
  ConsoleEntry,
  ExceptionEntry,
  PackedException,
  PackedResult,
} from "@kitesurf/jsrpc-types/shared";
import type { OutboundProps } from "./outbound.ts";
import {
  openPageScriptRpcSession,
  type RpcSessionCallable,
  type RpcSessionEntrypoint,
} from "./page-script-rpc-session.ts";
import { traceSpan, type Tracer } from "../tracing.ts";
import { localTraceParentProps } from "../tracing-local.ts";
import { attributionTails, type AttributionTailExports } from "./attribution-tail.ts";
import { makeWallClock, type HostClock } from "./host-clock.ts";
import type { SandboxOutboundOverride } from "./outbound.ts";
import fs from "node:fs";
import type { ParentScriptDescriptor } from "../wasm.ts";
import type { ScriptBundle } from "./script-bundle.ts";
import { FALLBACK_MODULE_RESOLVER_SOURCE } from "./walk-module-graph.ts";
import type { WasmBake } from "./prefetch-wasm.ts";

const cachedWasmBytes = new Map<string, ArrayBuffer>();
export function loadWasmBytesFromVfs(filename = "kitesurf_core_bg.wasm"): ArrayBuffer {
  const cached = cachedWasmBytes.get(filename);
  if (cached) return cached;
  const entries = fs.readdirSync("/bundle");
  const name = entries.find((n) => n.endsWith(`-${filename}`) || n === filename);
  if (!name) {
    throw new Error(
      `page-script: could not find ${filename} in /bundle. Entries: ${entries.join(", ")}`,
    );
  }
  const buf = fs.readFileSync(`/bundle/${name}`);
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  cachedWasmBytes.set(filename, out);
  return out;
}

export interface PageScriptStub extends PageScriptSession {
  close?(reason?: string): void;
  killIsolate?(reason?: string): Promise<unknown> | void;
  setUpstreamEventHandler?(handler: UpstreamEventHandler | null): void;
  armAwaitLoad?(): void;
  getRenderPort(): Promise<RenderPortStub>;
}

type CtxWithExports = ExecutionContext & {
  exports: AttributionTailExports & {
    SandboxOutbound(opts: { props: OutboundProps }): Fetcher;
    PageScriptTail(opts: {
      props: {
        scriptName: string;
        pageDomain?: string;
        ksErrToken?: string;
        sessionId?: string;
      };
    }): Fetcher;
    SpanSink(opts: { props: { kind: string } }): unknown;
  };
};

export const PAGE_SCRIPT_COMPAT_DATE = "2026-09-11";
export const PAGE_SCRIPT_COMPAT_FLAGS: readonly string[] = [
  "new_module_registry",
  "no_nodejs_compat",
  "no_nodejs_compat_v2",
];

export const PAGE_SCRIPT_SUBREQUEST_CAP = 10_000;

const PAGE_SCRIPT_CPU_TIME_MS_CAP = 300_000;

export interface PageIsolateCapOverrides {
  cpuMs?: number;
  wallMs?: number;
}

// Effective per-page-isolate budgets. cpuMs always > 0 (defaults to
// the plan maximum); wallMs 0 = uncapped (the default without a deployment cap).
export interface PageIsolateCaps {
  cpuMs: number;
  wallMs: number;
}

// Env-tunable isolate caps (a deployment may set both): CPU rides
// the Worker Loader's limits.cpuMs, wall arms the session kill timer.
export function pageIsolateCaps(
  env: {
    KITESURF_PAGE_CPU_MS_CAP?: string;
    KITESURF_PAGE_WALL_MS_CAP?: string;
  },
  overrides?: PageIsolateCapOverrides,
): PageIsolateCaps {
  const envCpu = parseCapMs(env.KITESURF_PAGE_CPU_MS_CAP);
  const envWall = parseCapMs(env.KITESURF_PAGE_WALL_MS_CAP);
  return {
    cpuMs: minCap(envCpu || PAGE_SCRIPT_CPU_TIME_MS_CAP, overrides?.cpuMs),
    wallMs: minCap(envWall, overrides?.wallMs),
  };
}

function parseCapMs(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function positiveOverride(override: number | undefined): number {
  return override && override > 0 ? Math.floor(override) : 0;
}

function minCap(configured: number, override: number | undefined): number {
  const o = positiveOverride(override);
  if (configured > 0 && o > 0) return Math.min(configured, o);
  return configured > 0 ? configured : o;
}

export interface PageScriptKey {
  connectionId: string;
  targetId: string;
  cookieKey?: string;
  navigateGeneration: number;
  lazy?: boolean;
  frameId?: string;
}

const PAGE_SCRIPT_FRAME_ID_KEY_PREFIX_CHARS = 8;

export function pageScriptCacheKey(k: PageScriptKey): string {
  const lazySuffix = k.lazy ? "-lazy" : "";
  const frameSuffix = k.frameId
    ? `-oopif-${k.frameId.slice(0, PAGE_SCRIPT_FRAME_ID_KEY_PREFIX_CHARS)}`
    : "";
  return `page-${k.connectionId}-${k.targetId}-${k.navigateGeneration}${lazySuffix}${frameSuffix}`;
}

export interface PageScriptStartupInput {
  html: string | null;
  url: string | null;
  cookies: string;
  scriptDescriptors: ParentScriptDescriptor[];
  scriptBundle: ScriptBundle | null;
  wasmBake: WasmBake | null;
  userAgent: string | null;
  referrerPolicy?: string | null;
  referrer?: string | null;
  csp?: string[];
  metaCsp?: string[];
  cdpDebug: boolean;
  pixelFree: boolean;
  fontDefer?: boolean;
}

function emptyWasmBytes(): ArrayBuffer {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]).buffer;
}

interface GetOrCreatePageScriptOptions {
  env: {
    LOADER: WorkerLoader;
    KITESURF_SIMULATE_PROD_EVAL?: string;
    KITESURF_RESOURCE_DRAIN_QUIET_TURNS?: string;
    KITESURF_LAG_WATCHDOG?: string;
    KITESURF_PAGE_CPU_MS_CAP?: string;
    KITESURF_PAGE_WALL_MS_CAP?: string;
    HOST_TRACER?: Tracer;
    HOST_CLOCK?: HostClock;
  };
  ctx: ExecutionContext;
  key: PageScriptKey;
  pageOrigin: string;
  startupInput?: Partial<PageScriptStartupInput>;
  attributionHeaders?: Record<string, string>;
  mainLoaderId?: string;
  extraHeaders?: Record<string, string>;
  initTimings: PageScriptInitTimings | undefined;
  capOverrides: PageIsolateCapOverrides | undefined;
  sandboxOutbound: SandboxOutboundOverride;
}

type StartupScriptDescriptor = Omit<ParentScriptDescriptor, "prefetchedSource"> & {
  prefetchedLength?: number;
};

type PageScriptModule =
  | string
  | { wasm: ArrayBuffer }
  | { cjs: string }
  | { js: string }
  | { json: unknown };

type PageScriptModuleMap = Record<string, PageScriptModule>;

type PageScriptEnvironment = GetOrCreatePageScriptOptions["env"];

type RpcOpenWrapper = (open: () => Promise<RpcSessionCallable>) => Promise<RpcSessionCallable>;

interface NormalizedPageScriptStartup {
  html: string | null;
  url: string | null;
  cookies: string;
  scriptDescriptors: StartupScriptDescriptor[];
  userAgent: string | null;
  referrer: string;
  referrerPolicy: string;
  cdpDebug: boolean;
  pixelFree: boolean;
  fontDefer: boolean;
  resourceDrainQuietTurns: number;
  lagWatchdog: boolean;
  scriptBundle: ScriptBundle | null;
  wasmBake: WasmBake | null;
  moduleScriptUrls: string[];
  moduleScriptCount: number;
  hasClassicRegular: boolean;
  hasClassicAsync: boolean;
  csp: string[];
  metaCsp: string[];
  insertedBaked: ScriptBundle["insertedManifest"];
}

function startupStringOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function startupStringOrEmpty(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

function startupNonemptyStringOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value ? value : null;
}

function startupDescriptors(
  descriptors: ParentScriptDescriptor[] | undefined,
): StartupScriptDescriptor[] {
  const source = Array.isArray(descriptors) ? descriptors : [];
  return source.map(({ prefetchedSource, ...descriptor }) =>
    typeof prefetchedSource === "string"
      ? { ...descriptor, prefetchedLength: prefetchedSource.length }
      : descriptor,
  );
}

function startupStringArray(values: string[] | undefined): string[] {
  return Array.isArray(values) ? values : [];
}

function quietTurnsFromEnv(raw: string | undefined): number {
  const configured = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(configured) ? Math.max(1, configured) : 1;
}

function insertedBakedModules(bundle: ScriptBundle | null): ScriptBundle["insertedManifest"] {
  return bundle?.insertedManifest ?? [];
}

function classicSourcePresence(bundle: ScriptBundle | null): {
  regular: boolean;
  async: boolean;
} {
  if (!bundle) return { regular: false, async: false };
  return {
    regular: !!bundle.classicRegularSource,
    async: !!bundle.classicAsyncSource,
  };
}

function normalizePageScriptStartup(
  input: Partial<PageScriptStartupInput>,
  env: PageScriptEnvironment,
): NormalizedPageScriptStartup {
  const scriptBundle = input.scriptBundle ?? null;
  const wasmBake = input.wasmBake ?? null;
  const cdpDebug = input.cdpDebug === true;
  const moduleScriptUrls = scriptBundle ? scriptBundle.moduleScriptUrls : [];
  const classicSources = classicSourcePresence(scriptBundle);
  return {
    html: startupStringOrNull(input.html),
    url: startupStringOrNull(input.url),
    cookies: startupStringOrEmpty(input.cookies),
    scriptDescriptors: startupDescriptors(input.scriptDescriptors),
    userAgent: startupNonemptyStringOrNull(input.userAgent),
    referrer: startupStringOrEmpty(input.referrer),
    referrerPolicy: startupStringOrEmpty(input.referrerPolicy),
    cdpDebug,
    pixelFree: input.pixelFree === true,
    fontDefer: input.fontDefer === true,
    resourceDrainQuietTurns: quietTurnsFromEnv(env.KITESURF_RESOURCE_DRAIN_QUIET_TURNS),
    lagWatchdog: cdpDebug || env.KITESURF_LAG_WATCHDOG === "1",
    scriptBundle,
    wasmBake,
    moduleScriptUrls,
    moduleScriptCount: moduleScriptUrls.length,
    hasClassicRegular: classicSources.regular,
    hasClassicAsync: classicSources.async,
    csp: startupStringArray(input.csp),
    metaCsp: startupStringArray(input.metaCsp),
    insertedBaked: insertedBakedModules(scriptBundle),
  };
}

function startupInputModuleSource(startup: NormalizedPageScriptStartup): string {
  return `// AUTO-GENERATED per navigate by getOrCreatePageScript.
// Carries parent-extracted, parent-pre-fetched per-navigate
// inputs into the loaded worker's module-init phase.
export const html = ${JSON.stringify(startup.html)};
export const url = ${JSON.stringify(startup.url)};
export const cookies = ${JSON.stringify(startup.cookies)};
export const scriptDescriptors = ${JSON.stringify(startup.scriptDescriptors)};
export const userAgent = ${JSON.stringify(startup.userAgent)};
export const referrer = ${JSON.stringify(startup.referrer)};
export const referrerPolicy = ${JSON.stringify(startup.referrerPolicy)};
export const hasClassicRegular = ${JSON.stringify(startup.hasClassicRegular)};
export const hasClassicAsync = ${JSON.stringify(startup.hasClassicAsync)};
export const moduleScriptCount = ${JSON.stringify(startup.moduleScriptCount)};
export const moduleScriptUrls = ${JSON.stringify(startup.moduleScriptUrls)};
export const cdpDebug = ${JSON.stringify(startup.cdpDebug)};
export const lagWatchdog = ${JSON.stringify(startup.lagWatchdog)};
export const pixelFree = ${JSON.stringify(startup.pixelFree)};
export const fontDefer = ${JSON.stringify(startup.fontDefer)};
export const resourceDrainQuietTurns = ${JSON.stringify(startup.resourceDrainQuietTurns)};
export const csp = ${JSON.stringify(startup.csp)};
export const metaCsp = ${JSON.stringify(startup.metaCsp)};
export const insertedBaked = ${JSON.stringify(startup.insertedBaked)};
`;
}

function addClassicSource(modules: PageScriptModuleMap, key: string, source: string | null): void {
  if (source) modules[key] = { cjs: source };
}

function addClassicBundleSources(modules: PageScriptModuleMap, bundle: ScriptBundle | null): void {
  if (!bundle) return;
  addClassicSource(modules, "__ks_user_classic_regular.js", bundle.classicRegularSource);
  addClassicSource(modules, "__ks_user_classic_async.js", bundle.classicAsyncSource);
}

function addInsertedBundleModules(modules: PageScriptModuleMap, bundle: ScriptBundle | null): void {
  if (!bundle) return;
  for (const [name, cjs] of Object.entries(bundle.insertedModules)) {
    modules[name] = { cjs };
  }
}

function addAdditionalBundleModules(
  modules: PageScriptModuleMap,
  bundle: ScriptBundle | null,
): void {
  if (!bundle) return;
  for (const [url, baked] of Object.entries(bundle.additionalModules)) {
    if (Object.prototype.hasOwnProperty.call(modules, url)) continue;
    modules[url] = typeof baked === "string" ? { js: baked } : baked;
  }
}

function addBundleModules(modules: PageScriptModuleMap, bundle: ScriptBundle | null): void {
  addClassicBundleSources(modules, bundle);
  addInsertedBundleModules(modules, bundle);
  addAdditionalBundleModules(modules, bundle);
}

function addBakedWasmModules(modules: PageScriptModuleMap, wasmBake: WasmBake | null): void {
  const registryImports: string[] = ['import __ksEmpty from "./__ks_empty.wasm";'];
  const registryEntries: string[] = [];
  if (wasmBake) {
    let index = 0;
    for (const [url, bytes] of Object.entries(wasmBake.modules)) {
      const key = `__ks_baked_wasm_${index}.wasm`;
      modules[key] = { wasm: bytes };
      registryImports.push(`import __w${index} from ${JSON.stringify(`./${key}`)};`);
      registryEntries.push(`  ${JSON.stringify(url)}: __w${index},`);
      index++;
    }
  }
  modules["__ks_wasm_registry.js"] = `// AUTO-GENERATED per navigate by getOrCreatePageScript.
// Parent-baked wasm modules; matching in wasm-baked.ts.
${registryImports.join("\n")}
export const emptyModule = __ksEmpty;
export const bakedWasm = {
${registryEntries.join("\n")}
};
export const manifest = ${JSON.stringify(wasmBake ? wasmBake.manifest : {})};
`;
}

function createPageScriptModules(
  startupModule: string,
  startup: NormalizedPageScriptStartup,
): PageScriptModuleMap {
  const modules: PageScriptModuleMap = {
    "page.js": PAGE_SCRIPT_SOURCE,
    "dom-shim.js": DOM_SHIM_SOURCE,
    "internal-state.js": INTERNAL_STATE_SOURCE,
    "wasm-glue.js": wasmGlueSource,
    "core_bg.wasm": { wasm: loadWasmBytesFromVfs() },
    "__ks_startup_probe_input.js": startupModule,
    "__ks_import_map.js":
      startup.scriptBundle?.importMapModuleSource ?? FALLBACK_MODULE_RESOLVER_SOURCE,
  };
  addBundleModules(modules, startup.scriptBundle);
  modules["__ks_empty.wasm"] = { wasm: emptyWasmBytes() };
  addBakedWasmModules(modules, startup.wasmBake);
  return modules;
}

function outboundReferrerPolicy(value: string | null | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pageOutboundProps(
  key: PageScriptKey,
  pageOrigin: string,
  url: string | null,
  referrerPolicy: string | null | undefined,
  mainLoaderId: string,
  extraHeaders: Record<string, string>,
  pixelFree: boolean,
): OutboundProps {
  return {
    ...localTraceParentProps(),
    pageOrigin,
    pageUrl: url ?? undefined,
    referrerPolicy: outboundReferrerPolicy(referrerPolicy),
    mainFrameId: key.frameId ?? key.targetId,
    mainLoaderId,
    extraHeaders,
    connectionId: key.connectionId,
    cookieKey: key.cookieKey ?? "",
    pixelFree,
  };
}

interface PageScriptWorkerLoadInput {
  env: PageScriptEnvironment;
  ctxExports: CtxWithExports;
  key: PageScriptKey;
  name: string;
  tailToken: string;
  caps: PageIsolateCaps;
  startup: NormalizedPageScriptStartup;
  modules: PageScriptModuleMap;
  outboundProps: OutboundProps;
  attributionHeaders: Record<string, string>;
  sandboxOutbound: SandboxOutboundOverride;
}

function pageScriptWorkerEnv(
  ctxExports: CtxWithExports,
  tailToken: string,
  tracer: Tracer | undefined,
): Record<string, unknown> {
  return {
    KS_TAIL_TOKEN: tailToken,
    ...(tracer
      ? {
          KS_SPAN_SINK: ctxExports.exports.SpanSink({
            props: { kind: "pagescript", ...localTraceParentProps() },
          }),
        }
      : {}),
  };
}

function pageScriptWorkerLimits(caps: PageIsolateCaps): { cpuMs: number; subRequests: number } {
  return { cpuMs: caps.cpuMs, subRequests: PAGE_SCRIPT_SUBREQUEST_CAP };
}

function loadPageScriptEntrypoint(input: PageScriptWorkerLoadInput): PageScriptEntrypointStub {
  const { env, ctxExports, key, name, tailToken, caps, startup, modules } = input;
  const stub = env.LOADER.load({
    compatibilityDate: PAGE_SCRIPT_COMPAT_DATE,
    compatibilityFlags: [...PAGE_SCRIPT_COMPAT_FLAGS],
    mainModule: "page.js",
    modules,
    env: pageScriptWorkerEnv(ctxExports, tailToken, env.HOST_TRACER),
    globalOutbound: input.sandboxOutbound.loaded(input.outboundProps),
    tails: [
      ctxExports.exports.PageScriptTail({
        props: {
          scriptName: name,
          // Navigate-time domain for error reports; a
          // [ks-err] report's live pageUrl wins over it (SPA routing).
          pageDomain: hostnameOf(startup.url ?? ""),
          ksErrToken: tailToken,
          sessionId: key.connectionId,
        },
      }),
      ...attributionTails(ctxExports.exports, input.attributionHeaders, "kitesurf-page-script"),
    ],
    limits: pageScriptWorkerLimits(caps),
  });
  return stub.getEntrypoint<PageScriptEntrypoint>("PageScript");
}

function pageScriptSpanWrap(tracer: Tracer | undefined): RpcOpenWrapper | undefined {
  return tracer ? (open) => traceSpan(tracer, "init.ws_upgrade", () => open()) : undefined;
}

function pageScriptTimedOpen(
  initTimings: PageScriptInitTimings | undefined,
  wall: () => number,
  spanWrap: RpcOpenWrapper | undefined,
): RpcOpenWrapper | undefined {
  if (!initTimings) return spanWrap;
  return async (open) => {
    const t0 = wall();
    try {
      return await (spanWrap ? spanWrap(open) : open());
    } finally {
      initTimings.wsUpgradeMs = wall() - t0;
    }
  };
}

function pageScriptTraceParent(tracer: Tracer | undefined): (() => string | null) | undefined {
  if (!tracer) return undefined;
  return () => tracer.getSpanContext()?.spanId ?? null;
}

function pageScriptWallCap(caps: PageIsolateCaps): number | undefined {
  return caps.wallMs > 0 ? caps.wallMs : undefined;
}

interface PageScriptSessionInput {
  entrypoint: PageScriptEntrypointStub;
  env: PageScriptEnvironment;
  name: string;
  caps: PageIsolateCaps;
  initTimings: PageScriptInitTimings | undefined;
  wall: () => number;
  outbound: SessionOutbound;
}

function openLoadedPageScriptSession(input: PageScriptSessionInput): PageScriptStub {
  // SAFETY: WorkerLoader follows the PageScript JSRPC contract, but Rpc.Provider loses generic
  // call/reply correlation and annotates cloneable reply objects with Disposable.
  // Runtime replies remain PageScriptReply data.
  // Verified by: packages/engine/test/e2e/demos/page-script-demo.e2e.test.ts.
  const entrypoint = input.entrypoint as RpcSessionEntrypoint;
  const tracer = input.env.HOST_TRACER;
  const spanWrap = pageScriptSpanWrap(tracer);
  const wrapOpen = pageScriptTimedOpen(input.initTimings, input.wall, spanWrap);
  return openPageScriptRpcSession(entrypoint, {
    now: makeWallClock(input.env),
    outbound: input.outbound,
    wallCapMs: pageScriptWallCap(input.caps),
    scriptName: input.name,
    getTraceParent: pageScriptTraceParent(tracer),
    wrapOpen,
  });
}

type PageScriptGenerationInput = Omit<
  GetOrCreatePageScriptOptions,
  "startupInput" | "attributionHeaders" | "mainLoaderId" | "extraHeaders"
> & {
  startupInput: Partial<PageScriptStartupInput>;
  attributionHeaders: Record<string, string>;
  mainLoaderId: string;
  extraHeaders: Record<string, string>;
};

function createPageScriptForGeneration(input: PageScriptGenerationInput): PageScriptStub {
  const {
    env,
    ctx,
    key,
    pageOrigin,
    startupInput,
    attributionHeaders,
    mainLoaderId,
    extraHeaders,
    initTimings,
    capOverrides,
    sandboxOutbound,
  } = input;
  const ctxExports = ctx as CtxWithExports;
  const wall = makeWallClock(env);
  const name = pageScriptCacheKey(key);
  const caps = pageIsolateCaps(env, capOverrides);
  const tailToken = crypto.randomUUID();
  const startup = normalizePageScriptStartup(startupInput, env);
  const startupModule = startupInputModuleSource(startup);
  const modules = createPageScriptModules(startupModule, startup);
  const outboundProps = pageOutboundProps(
    key,
    pageOrigin,
    startup.url,
    startupInput.referrerPolicy,
    mainLoaderId,
    extraHeaders,
    startup.pixelFree,
  );
  const entrypoint = loadPageScriptEntrypoint({
    env,
    ctxExports,
    key,
    name,
    tailToken,
    caps,
    startup,
    modules,
    outboundProps,
    attributionHeaders,
    sandboxOutbound,
  });
  return openLoadedPageScriptSession({
    entrypoint,
    env,
    name,
    caps,
    initTimings,
    wall,
    outbound: sandboxOutbound.session(outboundProps),
  });
}

/** Loads one PageScript worker for the supplied target generation and returns its RPC adapter. */
export function getOrCreatePageScript({
  env,
  ctx,
  key,
  pageOrigin,
  startupInput = {},
  attributionHeaders = {},
  mainLoaderId = "",
  extraHeaders = {},
  initTimings,
  capOverrides,
  sandboxOutbound,
}: GetOrCreatePageScriptOptions): PageScriptStub {
  return createPageScriptForGeneration({
    env,
    ctx,
    key,
    pageOrigin,
    startupInput,
    attributionHeaders,
    mainLoaderId,
    extraHeaders,
    initTimings,
    capOverrides,
    sandboxOutbound,
  });
}

export interface PageScriptInitTimings {
  wsUpgradeMs?: number;
}

export function spawnFramePageScript(
  env: {
    LOADER: WorkerLoader;
    KITESURF_SIMULATE_PROD_EVAL?: string;
    KITESURF_LAG_WATCHDOG?: string;
  },
  ctx: ExecutionContext,
  args: {
    connectionId: string;
    targetId: string;
    frameId: string;
    frameLoaderId: string;
    frameUrl: string;
    extraHeaders?: Record<string, string>;
    attributionHeaders?: Record<string, string>;
    sandboxOutbound: SandboxOutboundOverride;
  },
): PageScriptStub {
  const pageOrigin = originOf(args.frameUrl);
  const key: PageScriptKey = {
    connectionId: args.connectionId,
    targetId: args.targetId,
    navigateGeneration: Date.now(),
    frameId: args.frameId,
  };
  return getOrCreatePageScript({
    env,
    ctx,
    key,
    pageOrigin,
    startupInput: {},
    attributionHeaders: args.attributionHeaders ?? {},
    mainLoaderId: args.frameLoaderId,
    extraHeaders: args.extraHeaders ?? {},
    initTimings: undefined,
    capOverrides: undefined,
    sandboxOutbound: args.sandboxOutbound,
  });
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function originOf(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (!isHttpProtocol(u.protocol)) return "";
    if (!u.host) return "";
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function exceptionResultToCdp(res: PackedException): Protocol.Runtime.EvaluateResponse {
  return {
    result: {
      type: "object",
      subtype: "error",
      className: res.exception.className,
      description: res.exception.message,
    },
    exceptionDetails: {
      exceptionId: 1,
      text: res.exception.text,
      lineNumber: 0,
      columnNumber: 0,
      exception: {
        type: "object",
        subtype: "error",
        className: res.exception.className,
        description: res.exception.stack || res.exception.message,
      },
    },
  };
}

const PRIMITIVE_RESULT_TYPES = new Set(["string", "number", "boolean", "bigint", "undefined"]);

const NODE_OBJECT_DESCRIPTIONS = new Set([
  "Element",
  "HTMLElement",
  "DocumentImpl",
  "Document",
  "XMLDocument",
  "TextNode",
  "Text",
  "CommentNode",
  "Comment",
  "CharacterData",
  "DocumentFragmentImpl",
  "DocumentFragment",
  "ShadowRoot",
  "DocumentTypeNode",
  "DocumentType",
  "Attr",
  "Node",
]);

function copyPackedMetadata(remote: Protocol.Runtime.RemoteObject, packed: PackedResult): void {
  if (packed.subtype) remote.subtype = packed.subtype;
  if (packed.className) remote.className = packed.className;
}

function copyPackedValue(
  remote: Protocol.Runtime.RemoteObject,
  packed: PackedResult,
  includeValue: boolean,
): void {
  if (includeValue && packed.valueJson !== undefined) {
    try {
      remote.value = JSON.parse(packed.valueJson);
    } catch {}
  }
  if (packed.subtype === "null") remote.value = null;
}

function ensureRemoteObjectId(remote: Protocol.Runtime.RemoteObject, packed: PackedResult): void {
  if (!("value" in remote) && (packed.type === "object" || packed.type === "function")) {
    remote.objectId = packed.objectId ?? `eval:${crypto.randomUUID()}`;
  }
}

function isNodeObjectDescription(description: string): boolean {
  return (
    NODE_OBJECT_DESCRIPTIONS.has(description) || /^HTML[A-Z][A-Za-z0-9]*Element$/.test(description)
  );
}

function markRemoteNode(remote: Protocol.Runtime.RemoteObject, packed: PackedResult): void {
  if (remote.type !== "object" || remote.subtype || typeof packed.description !== "string") {
    return;
  }
  if (isNodeObjectDescription(packed.description)) remote.subtype = "node";
}

export function pageScriptResultToCdp(
  res: PackedResult | PackedException,
  returnByValue: boolean,
): Protocol.Runtime.EvaluateResponse {
  if (!res.ok) {
    return exceptionResultToCdp(res);
  }

  const remote: Protocol.Runtime.RemoteObject = { type: res.type };
  copyPackedMetadata(remote, res);
  if (res.description) remote.description = res.description;
  copyPackedValue(remote, res, PRIMITIVE_RESULT_TYPES.has(res.type) || returnByValue);
  ensureRemoteObjectId(remote, res);
  markRemoteNode(remote, res);

  return { result: remote };
}

function consoleArgToRemote(arg: PackedResult): Protocol.Runtime.RemoteObject {
  const remote: Protocol.Runtime.RemoteObject = { type: arg.type };
  copyPackedMetadata(remote, arg);
  if (arg.description !== undefined) remote.description = arg.description;
  copyPackedValue(remote, arg, true);
  return remote;
}

function levelToCdpType(level: string): Protocol.Runtime.ConsoleAPICalledEvent["type"] {
  switch (level) {
    case "log":
    case "info":
    case "warning":
    case "error":
    case "debug":
    case "trace":
    case "dir":
    case "table":
      return level;
    default:
      return "log";
  }
}

function parseTopFrame(
  stack: string,
  preferUrl: string,
): { url: string; line: number; col: number } | null {
  let fallback: { url: string; line: number; col: number } | null = null;
  for (const line of stack.split("\n")) {
    const frame = parseStackFrame(line);
    if (!frame) continue;
    if (matchesPreferredUrl(frame, preferUrl)) return frame;
    if (!fallback) fallback = frame;
  }
  return fallback;
}

function parseStackFrame(line: string): { url: string; line: number; col: number } | null {
  const match = /\bat\s+(?:.*?\s+\()?([^\s()]+):(\d+):(\d+)\)?\s*$/.exec(line);
  if (!match) return null;
  return { url: match[1]!, line: Number(match[2]!), col: Number(match[3]!) };
}

function matchesPreferredUrl(frame: { url: string }, preferUrl: string): boolean {
  return preferUrl !== "" && frame.url === preferUrl;
}

export function exceptionEntryToCdpEvent(
  entry: ExceptionEntry,
  exceptionId: number,
  executionContextId?: number,
): {
  method: "Runtime.exceptionThrown";
  params: Protocol.Runtime.ExceptionThrownEvent;
} {
  const top = parseTopFrame(entry.stack, entry.url);
  const lineNumber = top ? Math.max(0, top.line - 1) : 0;
  const columnNumber = top ? Math.max(0, top.col - 1) : 0;
  return {
    method: "Runtime.exceptionThrown",
    params: {
      timestamp: entry.timestamp,
      exceptionDetails: {
        exceptionId,
        text: entry.text,
        lineNumber,
        columnNumber,
        scriptId: entry.scriptId,
        url: entry.url,
        executionContextId: executionContextId ?? 1,
        exception: {
          type: "object",
          subtype: "error",
          className: entry.className,
          description: entry.stack || entry.message,
        },
        stackTrace: {
          callFrames: [
            {
              functionName: "",
              scriptId: entry.scriptId,
              url: entry.url,
              lineNumber,
              columnNumber,
            },
          ],
        },
      },
    },
  };
}

export function consoleEntryToCdpEvent(
  entry: ConsoleEntry,
  executionContextId?: number,
): {
  method: "Runtime.consoleAPICalled";
  params: Protocol.Runtime.ConsoleAPICalledEvent;
} {
  return {
    method: "Runtime.consoleAPICalled",
    params: {
      type: levelToCdpType(entry.level),
      args: entry.args.map(consoleArgToRemote),
      executionContextId: executionContextId ?? 1,
      timestamp: entry.timestamp,
      stackTrace: { callFrames: [] },
    },
  };
}
