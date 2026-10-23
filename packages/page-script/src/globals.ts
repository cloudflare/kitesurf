// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Installs browser-facing globals and adapters in the PageScript realm.

import { resolveImportMap, resolveModuleRegistryUrl } from "./__ks_import_map.js";
import type { BuildDocumentResult, ShimDocument, ShimWindow } from "./types.ts";
import {
  ks_bridge_buffer_bytes,
  ks_bridge_ever_minted,
  ks_eval_page,
  ks_import,
  ks_is_bridged,
  ks_set_boa_strict,
} from "./wasm-glue.js";
import { matchWasmByUrl, matchWasmByBytes, matchWasmByBytesSync } from "./wasm-baked.ts";
import { installWebSocketFacade } from "./websocket.ts";
import { installWorker } from "./dedicated-worker.ts";
import { installMessageChannel } from "./message-channel.ts";
import {
  DEFAULT_VIEWPORT_HEIGHT_PX,
  DEFAULT_VIEWPORT_WIDTH_PX,
  ksEventCtors,
  ksGlobal,
  state,
} from "./state.ts";
import { fetchGatedModuleSource } from "./inserted-scripts.ts";
import { trustedFetch } from "./trusted-fetch.ts";
import { indexedDbGlobals } from "./indexeddb.ts";
import { createScheduler } from "./scheduler.ts";
import { installIdleCallbackGlobals, installPageTaskGlobals, queuePortTask } from "./page-tasks.ts";
import { getBlobMimeType, normalizeBlobType, setBlobMimeType } from "./mime-type.ts";

const MAX_IMAGE_DATA_PIXELS = 4096 * 4096;

type PageNavigator = Navigator & {
  mediaDevices?: unknown;
  userAgentData?: unknown;
  webdriver?: unknown;
};

const USER_AGENT_PLATFORM_MATCHERS = [
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "Chrome OS"],
  [/\bLinux\b/, "Linux"],
] as const;

function userAgentPlatform(userAgent: string): string {
  for (const [matcher, platform] of USER_AGENT_PLATFORM_MATCHERS) {
    if (matcher.test(userAgent)) return platform;
  }
  return "";
}

// Capture workerd's branded methods before publishing the page EventTarget.
const nativeEventTargetPrototype = ksGlobal.EventTarget?.prototype;
const nativeEventTargetAdd = nativeEventTargetPrototype?.addEventListener;
const nativeEventTargetRemove = nativeEventTargetPrototype?.removeEventListener;
const objectIsPrototypeOf = Object.prototype.isPrototypeOf;
const NativeTextDecoder = ksGlobal.TextDecoder;

const charsetOf = (mime: string | null | undefined): string | null =>
  /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(mime || "")?.[1] ?? null;

function xhrTextResponse(
  buf: ArrayBuffer,
  responseType: string,
  overrideMime: string | undefined,
  responseMime: string | null,
): string {
  const bytes = new Uint8Array(buf);
  const label = xhrResponseCharset(bytes, responseType, overrideMime, responseMime);
  try {
    return new NativeTextDecoder(label).decode(bytes);
  } catch {
    return new NativeTextDecoder("utf-8").decode(bytes);
  }
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function hasUtf16BeBom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xfe && bytes[1] === 0xff;
}

function hasUtf16LeBom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xfe;
}

function xhrBomCharset(bytes: Uint8Array): string | null {
  switch (bytes[0]) {
    case 0xef:
      return hasUtf8Bom(bytes) ? "utf-8" : null;
    case 0xfe:
      return hasUtf16BeBom(bytes) ? "utf-16be" : null;
    case 0xff:
      return hasUtf16LeBom(bytes) ? "utf-16le" : null;
    default:
      return null;
  }
}

function xhrResponseCharset(
  bytes: Uint8Array,
  responseType: string,
  overrideMime: string | undefined,
  responseMime: string | null,
): string {
  if (responseType === "json") return "utf-8";
  const bomCharset = xhrBomCharset(bytes);
  if (bomCharset !== null) return bomCharset;
  return charsetOf(overrideMime) ?? charsetOf(responseMime) ?? "utf-8";
}

const shimEventTargetMethods = new WeakMap<
  object,
  {
    addEventListener: CallableFunction;
    removeEventListener: CallableFunction;
  }
>();

declare const document: any;

export function defineEnumerableProto(proto: object, methods: Record<string, Function>): void {
  for (const name of Object.keys(methods)) {
    Object.defineProperty(proto, name, {
      value: methods[name],
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
}

function defineOrAssignFallback(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor,
) {
  try {
    Object.defineProperty(target, property, descriptor);
  } catch {
    try {
      (target as Record<PropertyKey, unknown>)[property] = descriptor.value;
    } catch {}
  }
}

function stampFunction<F extends Function>(functionValue: F, name: string, length: number): F {
  try {
    Object.defineProperty(functionValue, "name", { value: name, configurable: true });
    Object.defineProperty(functionValue, "length", { value: length, configurable: true });
  } catch {}
  return functionValue;
}

function installWebAssemblyModuleStaticMethod(
  nativeModule: any,
  moduleShim: any,
  methodName: string,
  length: number,
): void {
  if (typeof nativeModule[methodName] !== "function") return;
  moduleShim[methodName] = stampFunction(
    function (...args: any[]) {
      return nativeModule[methodName](...args);
    },
    methodName,
    length,
  );
}

function installWebAssemblyShim(): void {
  try {
    const webAssembly: any = ksGlobal.WebAssembly;
    if (!webAssembly || typeof webAssembly.instantiate !== "function") return;
    const nativeModule = webAssembly.Module;
    const nativeInstantiate = webAssembly.instantiate.bind(webAssembly);
    const nativeCompile =
      typeof webAssembly.compile === "function" ? webAssembly.compile.bind(webAssembly) : null;

    const installInstantiation = function installInstantiation(): void {
      webAssembly.instantiate = stampFunction(
        function (source: any, imports?: any) {
          try {
            if (nativeModule && source instanceof nativeModule) {
              return Promise.resolve(new webAssembly.Instance(source, imports));
            }
            return matchWasmByBytes(source).then((module: any) => {
              if (module) {
                return {
                  module,
                  instance: new webAssembly.Instance(module, imports),
                };
              }
              return nativeInstantiate(source, imports);
            });
          } catch (error) {
            return Promise.reject(error);
          }
        },
        "instantiate",
        1,
      );
    };
    const installCompile = function installCompile(): void {
      webAssembly.compile = stampFunction(
        function (source: any) {
          try {
            return matchWasmByBytes(source).then((module: any) => {
              if (module) return module;
              if (nativeCompile) return nativeCompile(source);
              throw new TypeError("WebAssembly.compile is not available");
            });
          } catch (error) {
            return Promise.reject(error);
          }
        },
        "compile",
        1,
      );
    };
    const installStreaming = function installStreaming(): void {
      webAssembly.compileStreaming = stampFunction(
        async (source: any) => {
          const response = await Promise.resolve(source);
          const byUrl = matchWasmByUrl(response && response.url);
          if (byUrl) return byUrl;
          const bytes = await response.arrayBuffer();
          return webAssembly.compile(bytes);
        },
        "compileStreaming",
        1,
      );
      webAssembly.instantiateStreaming = stampFunction(
        async (source: any, importObject?: any) => {
          const response = await Promise.resolve(source);
          const byUrl = matchWasmByUrl(response && response.url);
          if (byUrl) {
            return {
              module: byUrl,
              instance: new webAssembly.Instance(byUrl, importObject),
            };
          }
          const bytes = await response.arrayBuffer();
          return webAssembly.instantiate(bytes, importObject);
        },
        "instantiateStreaming",
        1,
      );
    };
    const installModuleShim = function installModuleShim(): void {
      const ModuleShim: any = function Module(bytes: any) {
        const module = matchWasmByBytesSync(bytes);
        if (module) return module;
        return new nativeModule(bytes);
      };
      try {
        Object.defineProperty(ModuleShim, "prototype", {
          value: nativeModule.prototype,
          writable: false,
          enumerable: false,
          configurable: false,
        });
        Object.defineProperty(nativeModule.prototype, "constructor", {
          value: ModuleShim,
          writable: true,
          enumerable: false,
          configurable: true,
        });
      } catch {
        ModuleShim.prototype = nativeModule.prototype;
      }
      try {
        Object.setPrototypeOf(ModuleShim, Object.getPrototypeOf(nativeModule));
      } catch {}
      for (const [methodName, length] of [
        ["exports", 1],
        ["imports", 1],
        ["customSections", 2],
      ] as Array<[string, number]>) {
        installWebAssemblyModuleStaticMethod(nativeModule, ModuleShim, methodName, length);
      }
      stampFunction(ModuleShim, "Module", 1);
      webAssembly.Module = ModuleShim;
    };
    const freezeInstancePrototype = function freezeInstancePrototype(): void {
      try {
        const prototypeDescriptor = Object.getOwnPropertyDescriptor(
          webAssembly.Instance,
          "prototype",
        );
        if (prototypeDescriptor && prototypeDescriptor.writable) {
          Object.defineProperty(webAssembly.Instance, "prototype", {
            value: webAssembly.Instance.prototype,
            writable: false,
            enumerable: false,
            configurable: false,
          });
        }
      } catch {}
    };
    const installModuleIfAvailable = function installModuleIfAvailable(): void {
      if (typeof nativeModule === "function") installModuleShim();
    };

    installInstantiation();
    installCompile();
    installStreaming();
    installModuleIfAvailable();
    freezeInstancePrototype();
  } catch {}
}

function handlerNames(
  built: BuildDocumentResult | Record<string, never>,
  key: "global" | "window" | "all",
): unknown {
  const bag = built ? built.eventHandlerNames : undefined;
  return bag && typeof bag === "object" ? Reflect.get(bag, key) : undefined;
}

function preserveFunctionShape(wrapped: Function, originalFunction: Function): void {
  try {
    Object.defineProperty(wrapped, "name", {
      value: originalFunction.name,
      configurable: true,
    });
    Object.defineProperty(wrapped, "length", {
      value: originalFunction.length,
      configurable: true,
    });
  } catch {}
}

function rewrapHandlerAccessor(
  originalFunction: PropertyDescriptor["get"],
): PropertyDescriptor["get"];
function rewrapHandlerAccessor(
  originalFunction: PropertyDescriptor["set"],
): PropertyDescriptor["set"];
function rewrapHandlerAccessor(
  originalFunction: PropertyDescriptor["get"] | PropertyDescriptor["set"],
): PropertyDescriptor["get"] | PropertyDescriptor["set"] {
  if (typeof originalFunction !== "function") return undefined;
  const wrapped: NonNullable<PropertyDescriptor["get"]> = function (this: unknown) {
    const accessor: Function = originalFunction;
    return accessor.apply(this, arguments);
  };
  preserveFunctionShape(wrapped, originalFunction);
  return wrapped;
}

function findPrototypeDescriptor(proto: object, name: string): PropertyDescriptor | undefined {
  let prototype = Object.getPrototypeOf(proto);
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor) return descriptor;
    prototype = Object.getPrototypeOf(prototype);
  }
  return undefined;
}

function copyHandlerAccessors(proto: object | undefined, names: unknown): void {
  if (!proto || !Array.isArray(names)) return;
  for (const name of names) copyHandlerAccessor(proto, name);
}

function hasHandlerAccessor(descriptor: PropertyDescriptor): boolean {
  return Boolean(descriptor.get || descriptor.set);
}

function copyHandlerAccessor(proto: object, name: string): void {
  if (Object.prototype.hasOwnProperty.call(proto, name)) return;
  const descriptor = findPrototypeDescriptor(proto, name);
  if (!descriptor) return;
  if (!hasHandlerAccessor(descriptor)) return;
  const copy: PropertyDescriptor = {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get: rewrapHandlerAccessor(descriptor.get),
    set: rewrapHandlerAccessor(descriptor.set),
  };
  try {
    Object.defineProperty(proto, name, copy);
  } catch {}
}

export function installGlobals(
  doc: ShimDocument | null,
  win: ShimWindow | null,
  built: BuildDocumentResult | Record<string, never>,
): void {
  removeImmediateGlobals();
  installFunctionConstructorPatch();
  installBoaFunctionBridges();
  installImportGlobals();
  installGlobalEvalPatch();
  if (doc && win) {
    installWindowGlobals(doc, win, built);
  } else {
    removeWindowGlobals(win);
  }
}

function hideImmediateGlobalIfPresent(name: "setImmediate" | "clearImmediate"): void {
  if (typeof ksGlobal[name] === "undefined") return;
  try {
    Object.defineProperty(globalThis, name, {
      value: undefined,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {}
}

function removeImmediateProperty(name: "setImmediate" | "clearImmediate"): void {
  for (let o: object | null = globalThis; o; o = Object.getPrototypeOf(o)) {
    if (!Object.prototype.hasOwnProperty.call(o, name)) continue;
    try {
      delete (o as Record<string, unknown>)[name];
    } catch {}
  }
  hideImmediateGlobalIfPresent(name);
}

function removeImmediateGlobals(): void {
  for (const name of ["setImmediate", "clearImmediate"] as const) {
    removeImmediateProperty(name);
  }
}

function isCodeGenerationError(error: any): boolean {
  return Boolean(
    error &&
    error.name === "EvalError" &&
    typeof error.message === "string" &&
    error.message.includes("Code generation from strings disallowed"),
  );
}

function installFunctionConstructorPatch(): void {
  if (!ksGlobal.__ks_function_patched) {
    ksGlobal.__ks_function_patched = true;
    const NativeFunction = globalThis.Function;
    const Patched: any = function (this: any, ...args: any[]) {
      try {
        return NativeFunction.apply(this, args);
      } catch (e: any) {
        if (isCodeGenerationError(e)) {
          const body = args.length ? String(args[args.length - 1]) : "";
          const params = args.slice(0, -1).map(String).join(",");
          const generatedFunction = ks_eval_page("(function(" + params + "){" + body + "})");
          if (typeof generatedFunction === "function") return generatedFunction;
        }
        throw e;
      }
    };
    Patched.prototype = NativeFunction.prototype;
    Object.defineProperty(Patched, "name", { value: "Function", configurable: true });
    Object.defineProperty(Patched, "length", { value: 1, configurable: true });
    ksGlobal.Function = Patched;
  }
}

function installBoaFunctionBridges(): void {
  // Forward the call receiver; construction uses Boa's separate [[Construct]] path.
  if (!ksGlobal.__ks_thisfwd) {
    ksGlobal.__ks_thisfwd = function (call: any, ctor: any, handle: number) {
      return function (this: any) {
        if (new.target !== undefined) {
          return ctor(handle, Array.prototype.slice.call(arguments));
        }
        return call(handle, this, Array.prototype.slice.call(arguments));
      };
    };
  }
  if (!ksGlobal.__ks_argpack) {
    ksGlobal.__ks_argpack = function (call: any, fnHandle: number, recvHandle: number) {
      return function () {
        return call(fnHandle, recvHandle, Array.prototype.slice.call(arguments));
      };
    };
  }
}

function installImportMapGlobal(): void {
  if (!ksGlobal.__ks_resolve_import_map) {
    ksGlobal.__ks_resolve_import_map = function (spec: unknown, referrerUrl?: string): string {
      return resolveImportMap(spec, referrerUrl || ksGlobal.location?.href || "about:blank");
    };
  }
}

function installBoaImportGlobal(): void {
  if (!ksGlobal.__ks_import) {
    ksGlobal.__ks_import = function (spec: unknown, referrerUrl?: string): unknown {
      return ks_import(String(spec), referrerUrl || ksGlobal.location?.href || "about:blank");
    };
  }
}

function installNativeImportGlobal(): void {
  if (!ksGlobal.__ks_native_import) {
    ksGlobal.__ks_native_import = function (url: unknown): Promise<unknown> {
      return import(resolveModuleRegistryUrl(url));
    };
  }
}

function installModuleSourceGlobal(): void {
  if (!ksGlobal.__ks_module_source) {
    ksGlobal.__ks_module_source = function (url: unknown): Promise<string> {
      return fetchGatedModuleSource(String(url));
    };
  }
}

function installImportGlobals(): void {
  installImportMapGlobal();
  installBoaImportGlobal();
  installNativeImportGlobal();
  installModuleSourceGlobal();
}

function installGlobalEvalPatch(): void {
  if (!globalThis.__ks_eval_patched) {
    globalThis.__ks_eval_patched = true;
    const nativeEval = globalThis.eval;
    globalThis.eval = function (src: unknown): unknown {
      if (typeof src !== "string") return src;
      try {
        return nativeEval(src);
      } catch (e: any) {
        if (isCodeGenerationError(e)) {
          return ks_eval_page(src);
        }
        throw e;
      }
    };
  }
}

function boaModeQueryString(win: ShimWindow): string {
  return String((win.location && win.location.search) || "");
}

function configureBoaMode(win: ShimWindow): void {
  try {
    const queryString = boaModeQueryString(win);
    if (/[?&]ks_boa_lenient=1(&|$)/.test(queryString)) {
      ks_set_boa_strict(false);
      console.log("[kitesurf] boa lenient mode ON (boa exceptions swallowed)");
    } else if (/[?&]ks_boa_strict=1(&|$)/.test(queryString)) {
      ks_set_boa_strict(true);
    }
  } catch {}
}

function installWindowPostMessage(win: ShimWindow): void {
  try {
    ksGlobal.postMessage = function (...a: any[]) {
      return (win as any).postMessage(...a);
    };
  } catch {}
}

function installWindowFrames(win: ShimWindow): void {
  try {
    Object.defineProperty(globalThis, "frames", {
      configurable: true,
      get() {
        return win;
      },
    });
  } catch {
    ksGlobal.frames = win;
  }
}

function installWindowDimensions(win: ShimWindow): void {
  for (const propertyName of [
    "scrollX",
    "scrollY",
    "pageXOffset",
    "pageYOffset",
    "innerWidth",
    "innerHeight",
    "outerWidth",
    "outerHeight",
    "devicePixelRatio",
    "scrollTo",
    "scrollBy",
  ]) {
    try {
      Object.defineProperty(globalThis, propertyName, {
        configurable: true,
        get() {
          try {
            return (win as any)[propertyName];
          } catch {
            return undefined;
          }
        },
      });
    } catch {}
  }
}

function installScreenGlobal(win: ShimWindow): void {
  try {
    const screenStub = {
      get width() {
        return Number((win as any).innerWidth) || DEFAULT_VIEWPORT_WIDTH_PX;
      },
      get height() {
        return Number((win as any).innerHeight) || DEFAULT_VIEWPORT_HEIGHT_PX;
      },
      get availWidth() {
        return this.width;
      },
      get availHeight() {
        return this.height;
      },
      colorDepth: 24,
      pixelDepth: 24,
      orientation: {
        type: "landscape-primary",
        angle: 0,
        addEventListener() {},
        removeEventListener() {},
      },
    };
    Object.defineProperty(globalThis, "screen", {
      configurable: true,
      get() {
        return screenStub;
      },
    });
    try {
      (win as any).screen = screenStub;
    } catch {}
  } catch {}
}

function installWindowGlobalReferences(doc: ShimDocument, win: ShimWindow): void {
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.location = win.location;
  ksGlobal.navigator = win.navigator;
  configureBoaMode(win);
  globalThis.history = win.history;
  ksGlobal.self = win;
  installWindowPostMessage(win);
  globalThis.top = (win as any).top ?? win;
  globalThis.parent = (win as any).parent ?? win;
  installWindowFrames(win);
  installWindowDimensions(win);
  globalThis.frameElement = null;
  globalThis.opener = null;
  installScreenGlobal(win);
  // Publish through the shim-global view, not WorkerGlobalScope's typed event methods.
  ksGlobal.addEventListener = win.addEventListener.bind(win);
  ksGlobal.removeEventListener = win.removeEventListener.bind(win);
  ksGlobal.dispatchEvent = win.dispatchEvent.bind(win);
}

function installWindowGlobals(
  doc: ShimDocument,
  win: ShimWindow,
  built: BuildDocumentResult | Record<string, never>,
): void {
  installWindowGlobalReferences(doc, win);

  // Workerd host methods can reject detached calls, so page globals need bound receiver shadows.
  const __ks_boundCache = new WeakMap<Function, Function>();
  const isNativeConstructor = function isNativeConstructor(method: Function): boolean {
    try {
      return (
        method.prototype !== undefined &&
        method.prototype !== null &&
        typeof method.prototype === "object" &&
        method.prototype.constructor === method
      );
    } catch {
      return false;
    }
  };
  const assignBoundShadow = function assignBoundShadow(
    target: any,
    name: string,
    bound: Function,
  ): void {
    try {
      target[name] = bound;
    } catch {}
  };
  const cacheBoundShadow = function cacheBoundShadow(
    target: any,
    name: string,
    method: Function,
    thisArg: any,
  ): void {
    const cached = __ks_boundCache.get(method);
    if (cached) {
      target[name] = cached;
      return;
    }
    let bound: Function;
    try {
      bound = method.bind(thisArg);
    } catch {
      return;
    }
    __ks_boundCache.set(method, bound);
    assignBoundShadow(target, name, bound);
  };
  const installBoundShadow = (target: any, name: string, thisArg: any = target): void => {
    const method = target[name];
    if (typeof method !== "function") return;
    if (isNativeConstructor(method)) return;
    cacheBoundShadow(target, name, method, thisArg);
  };

  const installCoreBoundGlobals = function installCoreBoundGlobals(): void {
    installBoundShadow(globalThis, "setTimeout");
    installBoundShadow(globalThis, "setInterval");
    installBoundShadow(globalThis, "clearTimeout");
    installBoundShadow(globalThis, "clearInterval");
    installBoundShadow(globalThis, "queueMicrotask");

    installBoundShadow(globalThis, "fetch");

    installBoundShadow(globalThis, "atob");
    installBoundShadow(globalThis, "btoa");
    installBoundShadow(globalThis, "structuredClone");
  };
  installCoreBoundGlobals();

  const installStructuredCloneShim = function installStructuredCloneShim(): void {
    {
      type StructuredCloneFunction = (value: unknown, options?: unknown) => unknown;
      type StructuredCloneGlobal = Omit<typeof globalThis, "structuredClone"> & {
        structuredClone?: StructuredCloneFunction;
      };
      const pageGlobal = globalThis as StructuredCloneGlobal;
      const nativeSC = pageGlobal.structuredClone;
      if (typeof nativeSC === "function") {
        const isBridged = (v: object): boolean => {
          try {
            return ks_is_bridged(v);
          } catch {
            return false;
          }
        };
        const isContainer = (value: object): boolean => {
          if (Array.isArray(value)) return true;
          const proto: object | null = Object.getPrototypeOf(value);
          return (
            proto === Object.prototype || proto === null || (isBridged(value) && isBridged(proto))
          );
        };
        const isNonNullObject = (value: unknown): value is object =>
          typeof value === "object" && value !== null;
        const containsBridged = (value: unknown, seen: WeakSet<object>): boolean => {
          if (!isNonNullObject(value)) return false;
          const objectValue = value as Record<string, unknown>;
          if (seen.has(objectValue)) return false;
          seen.add(objectValue);
          if (isBridged(objectValue)) return true;
          if (!isContainer(objectValue)) return false;
          return Object.keys(objectValue).some((key) => containsBridged(objectValue[key], seen));
        };
        const materializeArray = function materializeArray(
          objectValue: unknown[] & Record<string, unknown>,
          seen: WeakMap<object, unknown>,
        ): unknown[] {
          const out = new Array(objectValue.length) as unknown[] & Record<string, unknown>;
          seen.set(objectValue, out);
          for (const key of Object.keys(objectValue)) {
            out[key] = materialize(objectValue[key], seen);
          }
          return out;
        };
        const materializeContainer = function materializeContainer(
          objectValue: Record<string, unknown>,
          seen: WeakMap<object, unknown>,
        ): unknown {
          if (!isContainer(objectValue)) return objectValue;
          const out: Record<string, unknown> = {};
          seen.set(objectValue, out);
          for (const key of Object.keys(objectValue)) {
            out[key] = materialize(objectValue[key], seen);
          }
          return out;
        };
        const materialize = (value: unknown, seen: WeakMap<object, unknown>): unknown => {
          if (!isNonNullObject(value)) return value;
          const objectValue = value as Record<string, unknown>;
          if (seen.has(objectValue)) return seen.get(objectValue);
          if (Array.isArray(objectValue)) {
            return materializeArray(objectValue, seen);
          }
          return materializeContainer(objectValue, seen);
        };
        // Native structuredClone cannot traverse Boa proxies; materialize bridged containers first.
        const wrapped: StructuredCloneFunction = function structuredClone(
          value: unknown,
          options?: unknown,
        ): unknown {
          let bridged = false;
          try {
            bridged = ks_bridge_ever_minted() && containsBridged(value, new WeakSet());
          } catch {
            bridged = containsBridged(value, new WeakSet());
          }
          const materializedValue = bridged ? materialize(value, new WeakMap()) : value;
          return options === undefined
            ? nativeSC(materializedValue)
            : nativeSC(materializedValue, options);
        };
        pageGlobal.structuredClone = wrapped;
      }
    }
  };
  installStructuredCloneShim();

  const installTextDecoderShim = function installTextDecoderShim(): void {
    // jsg's decode rejects a boa typed array, which reaches V8 as our proxy;
    // decode a copy of the bytes it views instead (protobuf runtimes on boa).
    {
      const proto: unknown = NativeTextDecoder?.prototype;
      if (typeof proto !== "object" || proto === null) return;
      const nativeDecode: unknown = Reflect.get(proto, "decode");
      if (typeof nativeDecode !== "function") return;
      const isBridgeDecodeInput = (input: unknown): input is object =>
        typeof input === "object" &&
        input !== null &&
        !ArrayBuffer.isView(input) &&
        !(input instanceof ArrayBuffer);
      Reflect.set(
        proto,
        "decode",
        function decode(this: unknown, input?: unknown, options?: unknown): unknown {
          if (isBridgeDecodeInput(input)) {
            const bytes = ks_bridge_buffer_bytes(input);
            if (bytes !== undefined) input = bytes;
          }
          return Reflect.apply(nativeDecode, this, [input, options]);
        },
      );
    }
  };
  installTextDecoderShim();

  const installConsoleAndIdleGlobals = function installConsoleAndIdleGlobals(): void {
    installBoundShadow(globalThis, "reportError");

    installBoundShadow(globalThis, "requestIdleCallback");
    installBoundShadow(globalThis, "cancelIdleCallback");

    if (typeof ksGlobal.console === "object" && ksGlobal.console !== null) {
      const consoleObj: any = ksGlobal.console;
      for (const methodName of [
        "log",
        "info",
        "warn",
        "error",
        "debug",
        "trace",
        "dir",
        "table",
        "group",
        "groupCollapsed",
        "groupEnd",
        "time",
        "timeEnd",
        "timeLog",
        "count",
        "countReset",
        "assert",
        "clear",
      ]) {
        installBoundShadow(consoleObj, methodName, consoleObj);
      }
    }
  };
  installConsoleAndIdleGlobals();

  const installCryptoGlobals = function installCryptoGlobals(): void {
    if (typeof ksGlobal.crypto === "object" && ksGlobal.crypto !== null) {
      const cryptoObj: any = ksGlobal.crypto;
      installBoundShadow(cryptoObj, "getRandomValues", cryptoObj);
      installBoundShadow(cryptoObj, "randomUUID", cryptoObj);
      const installSubtleCryptoGlobals = function installSubtleCryptoGlobals(): void {
        if (typeof cryptoObj.subtle === "object" && cryptoObj.subtle !== null) {
          const subtle = cryptoObj.subtle;
          for (const methodName of [
            "digest",
            "encrypt",
            "decrypt",
            "sign",
            "verify",
            "generateKey",
            "deriveKey",
            "deriveBits",
            "importKey",
            "exportKey",
            "wrapKey",
            "unwrapKey",
          ]) {
            installBoundShadow(subtle, methodName, subtle);
          }

          {
            const nativeGenerateKey = subtle.generateKey as (...a: unknown[]) => Promise<unknown>;
            const DIGESTS = new Set(["SHA-1", "SHA-256", "SHA-384", "SHA-512"]);

            const GEN_SUPPORTED = new Map<string, { hash: boolean }>([
              ["RSASSA-PKCS1-v1_5", { hash: true }],
              ["RSA-PSS", { hash: true }],
              ["RSA-OAEP", { hash: true }],
              ["HMAC", { hash: true }],
              ["ECDSA", { hash: false }],
              ["ECDH", { hash: false }],
              ["Ed25519", { hash: false }],
              ["X25519", { hash: false }],
              ["AES-CTR", { hash: false }],
              ["AES-CBC", { hash: false }],
              ["AES-GCM", { hash: false }],
              ["AES-KW", { hash: false }],
            ]);
            const GEN_SUPPORTED_UC = new Map(
              [...GEN_SUPPORTED].map(([k, v]) => [k.toUpperCase(), v]),
            );

            const GEN_PASSTHROUGH = new Set([
              "ED448",
              "X448",
              "ML-DSA-44",
              "ML-DSA-65",
              "ML-DSA-87",
              "ML-KEM-512",
              "ML-KEM-768",
              "ML-KEM-1024",
              "AES-OCB",
              "CHACHA20-POLY1305",
              "KMAC128",
              "KMAC256",
              "SLH-DSA",
            ]);
            const algName = (alg: unknown): string => {
              if (typeof alg !== "object" || alg === null) return String(alg);
              const name = (alg as { name?: unknown }).name;
              if (name === undefined) {
                throw new TypeError(
                  "Failed to execute 'generateKey' on 'SubtleCrypto': required member name is undefined.",
                );
              }
              return String(name);
            };
            const validateGenerateKeyHash = function validateGenerateKeyHash(
              algorithm: unknown,
              entry: { hash: boolean },
            ): void {
              if (!entry.hash) return;
              const hash = (algorithm as { hash?: unknown }).hash;
              if (hash === undefined) return;
              const hashName = algName(hash).toUpperCase();
              if (!DIGESTS.has(hashName)) {
                throw new DOMException(
                  `Unrecognized hash algorithm '${algName(hash)}'.`,
                  "NotSupportedError",
                );
              }
            };
            const validateGenerateKeyAlgorithm = function validateGenerateKeyAlgorithm(
              algorithm: unknown,
            ): void {
              const name = algName(algorithm).toUpperCase();
              const entry = GEN_SUPPORTED_UC.get(name);
              if (!entry) {
                if (GEN_PASSTHROUGH.has(name)) return;
                throw new DOMException(
                  `Unrecognized or unsupported generateKey algorithm '${algName(algorithm)}'.`,
                  "NotSupportedError",
                );
              }
              validateGenerateKeyHash(algorithm, entry);
            };
            Object.defineProperty(subtle, "generateKey", {
              value: async function generateKey(
                algorithm: unknown,
                ...rest: unknown[]
              ): Promise<unknown> {
                validateGenerateKeyAlgorithm(algorithm);
                return nativeGenerateKey(algorithm, ...rest);
              },
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
        }
      };
      installSubtleCryptoGlobals();
    }
  };
  installCryptoGlobals();

  const installPerformanceGlobals = function installPerformanceGlobals(): void {
    if (typeof ksGlobal.performance === "object" && ksGlobal.performance !== null) {
      const perfObj: any = ksGlobal.performance;
      installBoundShadow(perfObj, "now", perfObj);
      installBoundShadow(perfObj, "mark", perfObj);
      installBoundShadow(perfObj, "measure", perfObj);
      installBoundShadow(perfObj, "clearMarks", perfObj);
      installBoundShadow(perfObj, "clearMeasures", perfObj);
      installBoundShadow(perfObj, "getEntries", perfObj);
      installBoundShadow(perfObj, "getEntriesByName", perfObj);
      installBoundShadow(perfObj, "getEntriesByType", perfObj);
    }
  };
  installPerformanceGlobals();

  const installStringTimerGlobals = function installStringTimerGlobals(): void {
    try {
      const coerceStringTask = (callback: any): any => {
        if (typeof callback !== "string") return callback;
        const source = callback;
        return function ksStringTimerTask() {
          try {
            return ksGlobal.eval(source);
          } catch (error) {
            try {
              console.error("[kitesurf] setTimeout/setInterval string-task threw:", error);
            } catch {}
          }
        };
      };
      const _st = ksGlobal.setTimeout;
      if (typeof _st === "function") {
        ksGlobal.setTimeout = function (callback: any, delay?: any, ...args: any[]) {
          return _st(coerceStringTask(callback), delay, ...args);
        };
      }
      const _si = ksGlobal.setInterval;
      if (typeof _si === "function") {
        ksGlobal.setInterval = function (callback: any, delay?: any, ...args: any[]) {
          return _si(coerceStringTask(callback), delay, ...args);
        };
      }
    } catch {}
  };
  installStringTimerGlobals();

  const installAbortAndCryptoGlobals = function installAbortAndCryptoGlobals(): void {
    const canWrapCrypto = function canWrapCrypto(crypto: Crypto | undefined): crypto is Crypto {
      return Boolean(
        crypto && typeof crypto.getRandomValues === "function" && !(crypto as any).__ks_wrapped,
      );
    };
    const installAbortControllerGlobal = function installAbortControllerGlobal(): void {
      const RealAbortController: typeof AbortController | undefined = ksGlobal.AbortController;
      if (typeof RealAbortController === "function" && !(RealAbortController as any).__ks_lazy) {
        const NativeAbortController: typeof AbortController = RealAbortController;
        class LazyAbortController {
          private _real: AbortController | null = null;
          private _aborted = false;
          private _reason: unknown = undefined;
          private _listeners: Array<[string, (event: any) => void, any]> = [];
          private _fakeSignal: any = null;
          static __ks_lazy = true;
          private _attachListeners(controller: AbortController): void {
            for (const [type, listener, options] of this._listeners) {
              try {
                controller.signal.addEventListener(type, listener, options);
              } catch {}
            }
          }
          private _ensure(): AbortController | null {
            if (this._real) return this._real;
            try {
              const controller = new NativeAbortController();
              this._attachListeners(controller);
              if (this._aborted) controller.abort(this._reason as any);
              this._real = controller;
              return controller;
            } catch {
              return null;
            }
          }
          get signal(): any {
            const real = this._ensure();
            if (real) return real.signal;
            if (!this._fakeSignal) {
              const owner = this;
              this._fakeSignal = {
                get aborted() {
                  return owner._aborted;
                },
                get reason() {
                  return owner._reason;
                },
                throwIfAborted() {
                  if (owner._aborted) {
                    throw owner._reason ?? new DOMException("aborted", "AbortError");
                  }
                },
                addEventListener(type: string, listener: any, options?: any) {
                  owner._listeners.push([type, listener, options]);
                  if (owner._real) {
                    try {
                      owner._real.signal.addEventListener(type, listener, options);
                    } catch {}
                  }
                },
                removeEventListener(type: string, listener: any) {
                  owner._listeners = owner._listeners.filter(
                    ([eventType, registeredListener]) =>
                      !(eventType === type && registeredListener === listener),
                  );
                },
                dispatchEvent() {
                  return false;
                },
                onabort: null as any,
              };
            }
            return this._fakeSignal;
          }
          private _notifyAbortListeners(event: { type: string; target: any }): void {
            for (const [type, listener] of this._listeners) {
              if (type !== "abort") continue;
              try {
                listener.call(this._fakeSignal, event);
              } catch {}
            }
          }
          private _notifyOnAbortHandler(event: { type: string; target: any }): void {
            if (!this._fakeSignal || typeof this._fakeSignal.onabort !== "function") return;
            try {
              this._fakeSignal.onabort(event);
            } catch {}
          }
          abort(reason?: unknown) {
            if (this._real) return this._real.abort(reason as any);
            if (this._aborted) return;
            this._aborted = true;
            this._reason = reason ?? new DOMException("The operation was aborted.", "AbortError");
            const event = { type: "abort", target: this._fakeSignal };
            this._notifyAbortListeners(event);
            this._notifyOnAbortHandler(event);
          }
        }
        try {
          ksGlobal.AbortController = LazyAbortController;
        } catch {}
      }
    };
    installAbortControllerGlobal();

    const installCryptoFallback = function installCryptoFallback(): void {
      const realCrypto: Crypto | undefined = ksGlobal.crypto;
      if (!canWrapCrypto(realCrypto)) return;
      let fallbackCounter = 0;
      const isDisallowed = (error: unknown): boolean => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return errorMessage.includes("Disallowed operation called within global scope");
      };
      const realGetRandomValues = realCrypto.getRandomValues.bind(realCrypto);
      const realRandomUUID =
        typeof realCrypto.randomUUID === "function" ? realCrypto.randomUUID.bind(realCrypto) : null;
      const fillFallbackView = (view: any, length: number): void => {
        let randomState = ++fallbackCounter;
        for (let i = 0; i < length; i++) {
          randomState = (randomState * 1103515245 + 12345) & 0x7fffffff;
          view[i] = randomState & 0xff;
        }
      };
      const fillBytesFromCrypto = (bytes: Uint8Array): void => {
        try {
          realGetRandomValues(bytes);
        } catch (error) {
          if (!isDisallowed(error)) throw error;
          fillFallbackView(bytes, bytes.length);
        }
      };
      const getBridgeArrayRandomValues = (view: any): any => {
        const byteLength = view.length >>> 0;
        const bytes = new Uint8Array(byteLength);
        fillBytesFromCrypto(bytes);
        for (let i = 0; i < byteLength; i++) view[i] = bytes[i];
        return view;
      };
      const getNativeRandomValues = (view: any): any => {
        try {
          return realGetRandomValues(view);
        } catch (error) {
          if (!isDisallowed(error)) throw error;
          if (view && typeof view.length === "number") fillFallbackView(view, view.length);
          return view;
        }
      };
      const getRandomValues = function getRandomValues(view: any): any {
        if (view && !ArrayBuffer.isView(view) && typeof view.length === "number") {
          return getBridgeArrayRandomValues(view);
        }
        return getNativeRandomValues(view);
      };
      const getRandomUuid = realRandomUUID
        ? function getRandomUuid(): string {
            try {
              return realRandomUUID();
            } catch (error) {
              if (!isDisallowed(error)) throw error;
              const uuidSuffix = (++fallbackCounter).toString(16).padStart(12, "0");
              return "00000000-0000-4000-8000-" + uuidSuffix.slice(-12);
            }
          }
        : null;
      const wrappedCrypto = new Proxy(realCrypto, {
        get(target, prop) {
          if (prop === "getRandomValues") return getRandomValues;
          if (prop === "randomUUID" && getRandomUuid) return getRandomUuid;
          const propertyValue = (target as any)[prop];
          return typeof propertyValue === "function" ? propertyValue.bind(target) : propertyValue;
        },
      });
      (wrappedCrypto as any).__ks_wrapped = true;
      publishCryptoFallback(wrappedCrypto);
    };
    const publishCryptoFallback = function publishCryptoFallback(crypto: Crypto): void {
      try {
        ksGlobal.crypto = crypto;
      } catch {
        try {
          Object.defineProperty(globalThis, "crypto", {
            value: crypto,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        } catch {}
      }
    };
    installCryptoFallback();
  };
  installAbortAndCryptoGlobals();

  const installBroadcastChannelGlobal = function installBroadcastChannelGlobal(): void {
    if (
      typeof globalThis.BroadcastChannel === "function" &&
      (globalThis.BroadcastChannel.prototype as any)?.postMessage
    )
      return;
    const EventTargetConstructor: typeof EventTarget | undefined = ksGlobal.EventTarget;
    if (typeof EventTargetConstructor !== "function") return;
    class BroadcastChannel extends EventTargetConstructor {
      private _name: string;
      private _closed = false;
      onmessage: ((event: any) => void) | null = null;
      onmessageerror: ((event: any) => void) | null = null;
      constructor(name: string) {
        super();
        if (arguments.length === 0) {
          throw new TypeError(
            "Failed to construct 'BroadcastChannel': 1 argument required, but only 0 present.",
          );
        }
        this._name = String(name);
      }
      get name(): string {
        return this._name;
      }
      postMessage(message?: unknown): void {
        if (arguments.length === 0) {
          throw new TypeError(
            "Failed to execute 'postMessage' on 'BroadcastChannel': 1 argument required, but only 0 present.",
          );
        }
        if (this._closed) {
          throw new DOMException("BroadcastChannel is closed", "InvalidStateError");
        }
        if (typeof ksGlobal.structuredClone === "function") {
          ksGlobal.structuredClone(message);
        }
      }
      close(): void {
        this._closed = true;
      }
    }
    publishBroadcastChannel(BroadcastChannel);
  };
  const publishBroadcastChannel = function publishBroadcastChannel(channel: Function): void {
    try {
      ksGlobal.BroadcastChannel = channel;
    } catch {}
  };
  installBroadcastChannelGlobal();

  const installDomExceptionGlobal = function installDomExceptionGlobal(): void {
    {
      const NativeDOMException = (globalThis as any).DOMException as
        | (new (message?: string, name?: string) => Error)
        | undefined;
      const NAME_TO_CODE: Record<string, number> = {
        IndexSizeError: 1,
        HierarchyRequestError: 3,
        WrongDocumentError: 4,
        InvalidCharacterError: 5,
        NoModificationAllowedError: 7,
        NotFoundError: 8,
        NotSupportedError: 9,
        InUseAttributeError: 10,
        InvalidStateError: 11,
        SyntaxError: 12,
        InvalidModificationError: 13,
        NamespaceError: 14,
        InvalidAccessError: 15,
        TypeMismatchError: 17,
        SecurityError: 18,
        NetworkError: 19,
        AbortError: 20,
        URLMismatchError: 21,
        QuotaExceededError: 22,
        TimeoutError: 23,
        InvalidNodeTypeError: 24,
        DataCloneError: 25,
      };
      const CONSTANTS: Array<[string, number]> = [
        ["INDEX_SIZE_ERR", 1],
        ["DOMSTRING_SIZE_ERR", 2],
        ["HIERARCHY_REQUEST_ERR", 3],
        ["WRONG_DOCUMENT_ERR", 4],
        ["INVALID_CHARACTER_ERR", 5],
        ["NO_DATA_ALLOWED_ERR", 6],
        ["NO_MODIFICATION_ALLOWED_ERR", 7],
        ["NOT_FOUND_ERR", 8],
        ["NOT_SUPPORTED_ERR", 9],
        ["INUSE_ATTRIBUTE_ERR", 10],
        ["INVALID_STATE_ERR", 11],
        ["SYNTAX_ERR", 12],
        ["INVALID_MODIFICATION_ERR", 13],
        ["NAMESPACE_ERR", 14],
        ["INVALID_ACCESS_ERR", 15],
        ["VALIDATION_ERR", 16],
        ["TYPE_MISMATCH_ERR", 17],
        ["SECURITY_ERR", 18],
        ["NETWORK_ERR", 19],
        ["ABORT_ERR", 20],
        ["URL_MISMATCH_ERR", 21],
        ["QUOTA_EXCEEDED_ERR", 22],
        ["TIMEOUT_ERR", 23],
        ["INVALID_NODE_TYPE_ERR", 24],
        ["DATA_CLONE_ERR", 25],
      ];
      const brand = new WeakMap<object, { message: string; name: string }>();
      const DOMException = function (
        this: unknown,
        message: unknown = "",
        name: unknown = "Error",
      ): Error {
        if (!new.target) {
          throw new TypeError("Failed to construct 'DOMException': Please use the 'new' operator.");
        }
        const self = Reflect.construct(Error, [String(message)], new.target) as Error;
        delete (self as any).message;
        brand.set(self, { message: String(message), name: String(name) });
        return self;
      };
      Object.setPrototypeOf(DOMException.prototype, Error.prototype);
      Object.defineProperty(DOMException, "prototype", { writable: false });
      const defineGetter = (
        key: string,
        read: (exception: { message: string; name: string }) => unknown,
      ) => {
        Object.defineProperty(DOMException.prototype, key, {
          get(this: object) {
            const domExceptionState = brand.get(this);
            if (!domExceptionState) {
              throw new TypeError(
                `Illegal invocation: '${key}' getter called on an object that is not a DOMException`,
              );
            }
            return read(domExceptionState);
          },
          enumerable: true,
          configurable: true,
        });
      };
      defineGetter("message", (exception) => exception.message);
      defineGetter("name", (exception) => exception.name);
      defineGetter("code", (exception) => NAME_TO_CODE[exception.name] ?? 0);
      Object.defineProperty(DOMException.prototype, Symbol.toStringTag, {
        value: "DOMException",
        writable: false,
        enumerable: false,
        configurable: true,
      });
      const installLegacyConstants = function installLegacyConstants(): void {
        for (const [key, value] of CONSTANTS) {
          for (const target of [DOMException, DOMException.prototype]) {
            Object.defineProperty(target, key, {
              value,
              writable: false,
              enumerable: true,
              configurable: false,
            });
          }
        }
      };
      const linkNativeDomExceptionPrototype = function linkNativeDomExceptionPrototype(): void {
        if (typeof NativeDOMException !== "function") return;
        try {
          Object.setPrototypeOf(NativeDOMException.prototype, DOMException.prototype);
          Object.defineProperty(NativeDOMException.prototype, "constructor", {
            value: DOMException,
            writable: true,
            enumerable: false,
            configurable: true,
          });
        } catch {}
      };
      installLegacyConstants();
      linkNativeDomExceptionPrototype();
      try {
        (globalThis as any).DOMException = DOMException;
      } catch {}
    }

    installMessageChannel(ksGlobal, () => ksEventCtors.MessageEvent, queuePortTask);
  };
  installDomExceptionGlobal();

  const registerBuiltEventConstructors = function registerBuiltEventConstructors(): void {
    for (const eventName of Object.keys(built)) {
      if (eventName === "Event" || eventName.endsWith("Event")) {
        ksEventCtors[eventName] = (built as Record<string, unknown>)[eventName];
      }
    }
  };
  registerBuiltEventConstructors();

  const installBuiltBaseEventGlobals = function installBuiltBaseEventGlobals(): void {
    if (built.Event) ksGlobal.Event = built.Event;
    if (built.CustomEvent) ksGlobal.CustomEvent = built.CustomEvent;
    if (built.SubmitEvent) globalThis.SubmitEvent = built.SubmitEvent;
    if (built.FormData) ksGlobal.FormData = built.FormData;
  };
  installBuiltBaseEventGlobals();

  const installBuiltUiEventGlobals = function installBuiltUiEventGlobals(): void {
    if (built.UIEvent) globalThis.UIEvent = built.UIEvent;
    if (built.FocusEvent) globalThis.FocusEvent = built.FocusEvent;
    if (built.WheelEvent) globalThis.WheelEvent = built.WheelEvent;
    if (built.CompositionEvent) globalThis.CompositionEvent = built.CompositionEvent;
  };
  installBuiltUiEventGlobals();

  const installBuiltInputEventGlobals = function installBuiltInputEventGlobals(): void {
    if (built.InputEvent) globalThis.InputEvent = built.InputEvent;
    if (built.MouseEvent) globalThis.MouseEvent = built.MouseEvent;
    if (built.PointerEvent) globalThis.PointerEvent = built.PointerEvent;
    if (built.KeyboardEvent) globalThis.KeyboardEvent = built.KeyboardEvent;
  };
  installBuiltInputEventGlobals();

  const installBuiltNavigationEventGlobals = function installBuiltNavigationEventGlobals(): void {
    if (built.HashChangeEvent) globalThis.HashChangeEvent = built.HashChangeEvent;
    if (built.PopStateEvent) globalThis.PopStateEvent = built.PopStateEvent;
    if (built.PageTransitionEvent) globalThis.PageTransitionEvent = built.PageTransitionEvent;
    if (built.TransitionEvent) globalThis.TransitionEvent = built.TransitionEvent;
  };
  installBuiltNavigationEventGlobals();

  const installBuiltAnimationGlobals = function installBuiltAnimationGlobals(): void {
    if (built.AnimationEvent) globalThis.AnimationEvent = built.AnimationEvent;
    if (built.Animation) ksGlobal.Animation = built.Animation;
    if (built.AnimationEffect) ksGlobal.AnimationEffect = built.AnimationEffect;
    if (built.KeyframeEffect) ksGlobal.KeyframeEffect = built.KeyframeEffect;
  };
  installBuiltAnimationGlobals();

  const installBuiltTimelineGlobals = function installBuiltTimelineGlobals(): void {
    if (built.AnimationTimeline) ksGlobal.AnimationTimeline = built.AnimationTimeline;
    if (built.DocumentTimeline) ksGlobal.DocumentTimeline = built.DocumentTimeline;
    if (built.AnimationPlaybackEvent)
      ksGlobal.AnimationPlaybackEvent = built.AnimationPlaybackEvent;
    if (built.BeforeUnloadEvent) globalThis.BeforeUnloadEvent = built.BeforeUnloadEvent;
  };
  installBuiltTimelineGlobals();

  const installBuiltDeviceEventGlobals = function installBuiltDeviceEventGlobals(): void {
    if (built.DeviceMotionEvent) globalThis.DeviceMotionEvent = built.DeviceMotionEvent;
    if (built.DeviceMotionEventAcceleration)
      globalThis.DeviceMotionEventAcceleration = built.DeviceMotionEventAcceleration;
    if (built.DeviceMotionEventRotationRate)
      globalThis.DeviceMotionEventRotationRate = built.DeviceMotionEventRotationRate;
    if (built.DeviceOrientationEvent)
      globalThis.DeviceOrientationEvent = built.DeviceOrientationEvent;
  };
  installBuiltDeviceEventGlobals();

  const installBuiltTransferEventGlobals = function installBuiltTransferEventGlobals(): void {
    if (built.DragEvent) globalThis.DragEvent = built.DragEvent;
    if (built.MessageEvent) ksGlobal.MessageEvent = built.MessageEvent;
    if (built.StorageEvent) globalThis.StorageEvent = built.StorageEvent;
    if (built.TextEvent) globalThis.TextEvent = built.TextEvent;
  };
  installBuiltTransferEventGlobals();

  const installBuiltRemainingEventGlobals = function installBuiltRemainingEventGlobals(): void {
    if (built.TouchEvent) globalThis.TouchEvent = built.TouchEvent;
    if (built.ErrorEvent) ksGlobal.ErrorEvent = built.ErrorEvent;
    if (built.PromiseRejectionEvent) ksGlobal.PromiseRejectionEvent = built.PromiseRejectionEvent;
    if (built.Element) globalThis.Element = built.Element;
  };
  installBuiltRemainingEventGlobals();

  const installBuiltWindowClassGlobals = function installBuiltWindowClassGlobals(): void {
    if (built.HTMLElement) globalThis.HTMLElement = built.HTMLElement;
    if (built.Node) globalThis.Node = built.Node;
    if (built.Window) globalThis.Window = built.Window;
    if (built.ModelContext) globalThis.ModelContext = built.ModelContext;
  };
  installBuiltWindowClassGlobals();

  const installBuiltHtmlElementInterfaces = function installBuiltHtmlElementInterfaces(): void {
    for (const [name, cls] of Object.entries(built.htmlElementInterfaces ?? {})) {
      Reflect.set(globalThis, name, cls);
    }
  };
  installBuiltHtmlElementInterfaces();
  const createSvgBase = function createSvgBase(): Function {
    const builtSvg: unknown = built ? Reflect.get(built, "SVGElement") : undefined;
    const builtElement: unknown = built ? Reflect.get(built, "Element") : undefined;
    return typeof builtSvg === "function"
      ? builtSvg
      : class SVGElement extends ((typeof builtElement === "function"
          ? builtElement
          : Object) as any) {};
  };
  const installSvgElementConstructors = function installSvgElementConstructors(
    svgBase: Function,
  ): void {
    for (const constructorName of [
      "SVGAElement",
      "SVGSVGElement",
      "SVGGElement",
      "SVGPathElement",
      "SVGUseElement",
      "SVGRectElement",
      "SVGCircleElement",
      "SVGEllipseElement",
      "SVGLineElement",
      "SVGPolygonElement",
      "SVGPolylineElement",
      "SVGTextElement",
      "SVGTSpanElement",
      "SVGImageElement",
      "SVGDefsElement",
      "SVGSymbolElement",
      "SVGMarkerElement",
      "SVGClipPathElement",
      "SVGMaskElement",
      "SVGPatternElement",
      "SVGLinearGradientElement",
      "SVGRadialGradientElement",
      "SVGStopElement",
      "SVGForeignObjectElement",
      "SVGTitleElement",
      "SVGDescElement",
      "SVGStyleElement",
      "SVGScriptElement",
      "SVGGraphicsElement",
      "SVGGeometryElement",
    ]) {
      if (typeof Reflect.get(globalThis, constructorName) !== "function") {
        Reflect.set(globalThis, constructorName, class extends (svgBase as any) {});
      }
    }
  };
  const installSvgRootHandlerAccessors = function installSvgRootHandlerAccessors(): void {
    const svgRoot = Reflect.get(globalThis, "SVGSVGElement");
    copyHandlerAccessors(
      typeof svgRoot === "function" ? svgRoot.prototype : undefined,
      handlerNames(built, "window"),
    );
  };
  const installSvgRootInstanceCheck = function installSvgRootInstanceCheck(): void {
    try {
      Object.defineProperty(Reflect.get(globalThis, "SVGSVGElement"), Symbol.hasInstance, {
        value: (element: unknown) =>
          !!element &&
          typeof element === "object" &&
          Reflect.get(element, "nodeType") === 1 &&
          String(Reflect.get(element, "localName") || "").toLowerCase() === "svg",
        configurable: true,
      });
    } catch (error) {
      console.warn("[kitesurf] SVGSVGElement hasInstance override failed:", error);
    }
  };
  const installSvgConstructors = function installSvgConstructors(): void {
    try {
      const svgBase = createSvgBase();
      copyHandlerAccessors(svgBase.prototype, handlerNames(built, "all"));
      Reflect.set(globalThis, "SVGElement", svgBase);
      installSvgElementConstructors(svgBase);
      installSvgRootHandlerAccessors();
      installSvgRootInstanceCheck();
    } catch (error) {
      console.warn("[kitesurf] SVG constructor install failed:", error);
    }
  };
  installSvgConstructors();

  const eventTargetMethods = function eventTargetMethods(
    shimProto: BuildDocumentResult["EventTarget"]["prototype"],
  ):
    | {
        addEventListener: CallableFunction;
        removeEventListener: CallableFunction;
      }
    | undefined {
    let shimMethods = shimEventTargetMethods.get(shimProto);
    if (shimMethods) return shimMethods;
    const addEventListener = shimProto.addEventListener;
    const removeEventListener = shimProto.removeEventListener;
    if (typeof addEventListener !== "function" || typeof removeEventListener !== "function") {
      return undefined;
    }
    shimMethods = { addEventListener, removeEventListener };
    shimEventTargetMethods.set(shimProto, shimMethods);
    return shimMethods;
  };
  const createEventTargetMethodBridge = function createEventTargetMethodBridge(
    name: "addEventListener" | "removeEventListener",
    shimMethod: CallableFunction,
    nativeMethod: CallableFunction,
  ): Function {
    const methodForReceiver = (receiver: unknown): CallableFunction =>
      nativeEventTargetPrototype &&
      objectIsPrototypeOf.call(nativeEventTargetPrototype, receiver as object)
        ? nativeMethod
        : shimMethod;
    if (name === "addEventListener") {
      return function addEventListener(this: unknown, _type: unknown, _listener: unknown) {
        return Reflect.apply(methodForReceiver(this), this, arguments);
      };
    }
    return function removeEventListener(this: unknown, _type: unknown, _listener: unknown) {
      return Reflect.apply(methodForReceiver(this), this, arguments);
    };
  };
  const installEventTargetMethodBridge = function installEventTargetMethodBridge(
    shimProto: BuildDocumentResult["EventTarget"]["prototype"],
    name: "addEventListener" | "removeEventListener",
    shimMethods: { addEventListener: CallableFunction; removeEventListener: CallableFunction },
    nativeMethod: CallableFunction | undefined,
  ): void {
    const shimMethod = shimMethods[name];
    if (typeof shimMethod !== "function" || typeof nativeMethod !== "function") return;
    const descriptor = Object.getOwnPropertyDescriptor(shimProto, name);
    const bridge = createEventTargetMethodBridge(name, shimMethod, nativeMethod);
    Object.defineProperty(shimProto, name, { ...descriptor, value: bridge });
  };
  const installEventTargetBridge = function installEventTargetBridge(): void {
    const EventTargetConstructor = built.EventTarget;
    if (!EventTargetConstructor) return;
    const shimProto = EventTargetConstructor.prototype;
    const shimMethods = eventTargetMethods(shimProto);
    if (shimMethods) {
      // Native receivers keep workerd's listener store; shim receivers use the page implementation.
      installEventTargetMethodBridge(
        shimProto,
        "addEventListener",
        shimMethods,
        nativeEventTargetAdd,
      );
      installEventTargetMethodBridge(
        shimProto,
        "removeEventListener",
        shimMethods,
        nativeEventTargetRemove,
      );
    }
    ksGlobal.EventTarget = EventTargetConstructor;
  };
  installEventTargetBridge();

  const installTextNodeGlobals = function installTextNodeGlobals(): void {
    if (built.Text) globalThis.Text = built.Text;
    if (built.Comment) globalThis.Comment = built.Comment;
    if (built.CharacterData) globalThis.CharacterData = built.CharacterData;
  };
  const installProcessingInstructionGlobals = function installProcessingInstructionGlobals(): void {
    if (built.ProcessingInstruction) globalThis.ProcessingInstruction = built.ProcessingInstruction;
    if (built.CDATASection) globalThis.CDATASection = built.CDATASection;
  };
  installTextNodeGlobals();
  installProcessingInstructionGlobals();

  const installStylesheetGlobals = function installStylesheetGlobals(): void {
    if (built.DOMParser) globalThis.DOMParser = built.DOMParser;
    if (built.CSSStyleSheet) globalThis.CSSStyleSheet = built.CSSStyleSheet;
    if (built.CSSRule) globalThis.CSSRule = built.CSSRule;
  };
  installStylesheetGlobals();

  const installCssRuleConstructors = function installCssRuleConstructors(): void {
    for (const constructorName of [
      "CSSGroupingRule",
      "CSSConditionRule",
      "CSSMediaRule",
      "CSSSupportsRule",
      "CSSStyleRule",
      "CSSImportRule",
      "CSSFontFaceRule",
      "CSSFontPaletteValuesRule",
      "CSSFontFeatureValuesRule",
      "CSSLayerBlockRule",
      "CSSLayerStatementRule",
      "CSSNamespaceRule",
      "CSSPageRule",
      "CSSMarginRule",
      "CSSKeyframesRule",
      "CSSKeyframeRule",
      "CSSCounterStyleRule",
      "CSSStyleDeclaration",
      "MediaList",
      "StyleSheet",
    ] as const satisfies readonly (keyof BuildDocumentResult)[]) {
      if (built[constructorName]) ksGlobal[constructorName] = built[constructorName];
    }
  };
  installCssRuleConstructors();

  const installCssValueConstructors = function installCssValueConstructors(): void {
    for (const constructorName of [
      "CSSStyleValue",
      "CSSImageValue",
      "CSSKeywordValue",
      "CSSNumericValue",
      "CSSUnitValue",
      "CSSMathValue",
      "CSSMathSum",
      "CSSMathProduct",
      "CSSMathNegate",
      "CSSMathInvert",
      "CSSMathMin",
      "CSSMathMax",
      "CSSMathClamp",
      "CSSNumericArray",
      "CSSColorValue",
      "CSSRGB",
      "CSSHSL",
      "CSSHWB",
      "CSSLab",
      "CSSLCH",
      "CSSOKLab",
      "CSSOKLCH",
      "CSSColor",
      "CSSUnparsedValue",
      "CSSVariableReferenceValue",
      "StylePropertyMapReadOnly",
      "StylePropertyMap",
      "CSSTransformValue",
      "CSSTransformComponent",
      "CSSTranslate",
      "CSSRotate",
      "CSSScale",
      "CSSSkew",
      "CSSSkewX",
      "CSSSkewY",
      "CSSPerspective",
      "CSSMatrixComponent",
      "DOMMatrixReadOnly",
      "DOMMatrix",
      "Path2D",
      "DOMRectReadOnly",
      "DOMRect",
      "DOMRectList",
    ] as const satisfies readonly (keyof BuildDocumentResult)[]) {
      if (built[constructorName]) ksGlobal[constructorName] = built[constructorName];
    }
  };
  installCssValueConstructors();

  const installCssIterablePrototypes = function installCssIterablePrototypes(): void {
    ks_eval_page(`
      for (const valueConstructor of [
        CSSUnparsedValue,
        CSSNumericArray,
        CSSTransformValue,
      ]) {
        for (const name of ["entries", "keys", "values", "forEach"]) {
          Object.defineProperty(valueConstructor.prototype, name, {
            value: Array.prototype[name], writable: true, enumerable: true, configurable: true
          });
        }
        Object.defineProperty(valueConstructor.prototype, Symbol.iterator, {
          value: Array.prototype[Symbol.iterator], writable: true, enumerable: false, configurable: true
        });
      }
    `);
  };
  installCssIterablePrototypes();

  const installRangeGlobals = function installRangeGlobals(): void {
    if (built.AbstractRange) globalThis.AbstractRange = built.AbstractRange;
    if (built.Range) globalThis.Range = built.Range;
    if (built.StaticRange) globalThis.StaticRange = built.StaticRange;
    if (built.Selection) globalThis.Selection = built.Selection;
  };
  installRangeGlobals();

  const installValidityAndCanvasGlobals = function installValidityAndCanvasGlobals(): void {
    if (built.ValidityState) ksGlobal.ValidityState = built.ValidityState;
    if (built.CanvasRenderingContext2D)
      ksGlobal.CanvasRenderingContext2D = built.CanvasRenderingContext2D;
    if (built.CanvasGradient) ksGlobal.CanvasGradient = built.CanvasGradient;
    if (built.CanvasPattern) ksGlobal.CanvasPattern = built.CanvasPattern;
  };
  installValidityAndCanvasGlobals();

  const installSelectionGlobal = function installSelectionGlobal(): void {
    if (built.getSelection) globalThis.getSelection = built.getSelection;
  };
  installSelectionGlobal();

  type PerfEntryRecord = {
    name: string;
    entryType: string;
    startTime: number;
    duration: number;
    [field: string]: unknown;
  };
  interface PerformanceWindowLike {
    location?: { href?: unknown };
  }

  const installPerformanceApiShim = function installPerformanceApiShim(): void {
    {
      const __nativePerf: Performance | undefined = ksGlobal.performance;
      const __nativeNow = nativePerformanceNow(__nativePerf);
      const __nativeTimeOrigin = nativePerformanceTimeOrigin(__nativePerf);

      const markStartTime = (options: Record<string, unknown>): number => {
        return typeof options.startTime === "number" ? options.startTime : __nativeNow();
      };

      const assertNonNegativeMarkTime = (markName: unknown, startTime: number): void => {
        if (startTime < 0) {
          throw new (ksGlobal.DOMException || TypeError)(
            "Failed to construct 'PerformanceMark': '" +
              markName +
              "' cannot have negative startTime.",
            "SyntaxError",
          );
        }
      };

      class PerformanceEntry {
        declare duration: number;
        declare entryType: string;
        declare name: string;
        declare startTime: number;
        constructor(name, entryType, startTime, duration) {
          this.name = String(name);
          this.entryType = String(entryType);
          this.startTime = +startTime;
          this.duration = +duration;
        }
        toJSON() {
          return {
            name: this.name,
            entryType: this.entryType,
            startTime: this.startTime,
            duration: this.duration,
          };
        }
        get [Symbol.toStringTag]() {
          return "PerformanceEntry";
        }
      }
      class PerformanceMark extends PerformanceEntry {
        declare detail: unknown;
        constructor(markName, markOptions) {
          if (arguments.length < 1) {
            throw new TypeError(
              "Failed to construct 'PerformanceMark': 1 argument required, but only 0 present.",
            );
          }
          const options: Record<string, unknown> =
            markOptions && typeof markOptions === "object" ? markOptions : {};
          const startTime = markStartTime(options);
          assertNonNegativeMarkTime(markName, startTime);
          super(markName, "mark", startTime, 0);
          this.detail = options.detail !== undefined ? options.detail : null;
        }
        get [Symbol.toStringTag]() {
          return "PerformanceMark";
        }
      }
      class PerformanceMeasure extends PerformanceEntry {
        declare detail: unknown;
        constructor(name, startTime, duration, detail) {
          super(name, "measure", startTime, duration);
          this.detail = detail !== undefined ? detail : null;
        }
        get [Symbol.toStringTag]() {
          return "PerformanceMeasure";
        }
      }
      Object.defineProperty(PerformanceMark, "length", { value: 1, configurable: true });
      ksGlobal.PerformanceEntry = PerformanceEntry;
      ksGlobal.PerformanceMark = PerformanceMark;
      ksGlobal.PerformanceMeasure = PerformanceMeasure;

      const __perfEntries: Array<PerformanceEntry | PerfEntryRecord> = [];

      addNavigationPerformanceEntry(__perfEntries, win);

      const __navigationTimingMarks = new Set([
        "navigationStart",
        "fetchStart",
        "domainLookupStart",
        "domainLookupEnd",
        "connectStart",
        "connectEnd",
        "secureConnectionStart",
        "requestStart",
        "responseStart",
        "responseEnd",
        "domLoading",
        "domInteractive",
        "domContentLoadedEventStart",
        "domContentLoadedEventEnd",
        "domComplete",
        "loadEventStart",
        "loadEventEnd",
        "unloadEventStart",
        "unloadEventEnd",
        "redirectStart",
        "redirectEnd",
      ]);

      const __findPerformanceMark = (markName) => {
        for (let i = __perfEntries.length - 1; i >= 0; i--) {
          const entry = __perfEntries[i];
          if (entry.entryType === "mark" && entry.name === markName) return entry;
        }
        return null;
      };

      const __resolveMark = (markName) => {
        if (typeof markName !== "string") return null;
        const mark = __findPerformanceMark(markName);
        if (mark) return mark;
        return __navigationTimingMarks.has(markName)
          ? { entryType: "mark", name: markName, startTime: 0, duration: 0 }
          : null;
      };

      const resolveMeasureMark = (
        markName: unknown,
        options?: Record<string, unknown>,
        key?: "start" | "end",
      ): number => {
        const mark = __resolveMark(markName);
        if (mark) return mark.startTime;
        throw new SyntaxError(
          "Failed to execute 'measure' on 'Performance': The mark '" +
            (options && key ? options[key] : markName) +
            "' does not exist.",
        );
      };

      const measureStartTime = (options: Record<string, unknown>): number => {
        if (typeof options.start === "number") return options.start;
        if (typeof options.start === "string") {
          return resolveMeasureMark(options.start, options, "start");
        }
        return 0;
      };

      const measureEndTime = (
        options: Record<string, unknown>,
        startTime: number,
        fallback: number,
      ): number => {
        if (typeof options.end === "number") return options.end;
        if (typeof options.end === "string") {
          return resolveMeasureMark(options.end, options, "end");
        }
        return typeof options.duration === "number" ? startTime + options.duration : fallback;
      };

      const measureOptionsRange = (options: Record<string, unknown>, now: number) => {
        const startTime = measureStartTime(options);
        return {
          startTime,
          endTime: measureEndTime(options, startTime, now),
          detail: options.detail !== undefined ? options.detail : null,
        };
      };

      const measureArgumentsRange = (startOrOptions, endMark, now: number) => ({
        startTime: typeof startOrOptions === "string" ? resolveMeasureMark(startOrOptions) : 0,
        endTime: typeof endMark === "string" ? resolveMeasureMark(endMark) : now,
        detail: null,
      });

      const addMeasureEntry = (name, range) => {
        const entry = new PerformanceMeasure(
          String(name),
          range.startTime,
          Math.max(0, range.endTime - range.startTime),
          range.detail,
        );
        __perfEntries.push(entry);
        return entry;
      };

      const __perfShim = {
        now() {
          return __nativeNow();
        },
        timeOrigin: __nativeTimeOrigin,
        mark(name, options) {
          if (arguments.length < 1) {
            throw new TypeError(
              "Failed to execute 'mark' on 'Performance': 1 argument required, but only 0 present.",
            );
          }
          if (typeof name === "string" && __navigationTimingMarks.has(name)) {
            throw new (ksGlobal.DOMException || TypeError)(
              "Failed to execute 'mark' on 'Performance': '" +
                name +
                "' is part of the PerformanceTiming interface, and cannot be used as a mark name.",
              "SyntaxError",
            );
          }
          const entry = new PerformanceMark(name, options);
          __perfEntries.push(entry);
          return entry;
        },
        measure(name, startOrOptions, endMark) {
          if (arguments.length < 1) {
            throw new TypeError(
              "Failed to execute 'measure' on 'Performance': 1 argument required, but only 0 present.",
            );
          }
          const now = __nativeNow();
          const range = isMeasureOptions(startOrOptions)
            ? measureOptionsRange(startOrOptions, now)
            : measureArgumentsRange(startOrOptions, endMark, now);
          return addMeasureEntry(name, range);
        },
        getEntries() {
          return __perfEntries.slice();
        },
        getEntriesByName(name, entryType) {
          const want = String(name);
          return __perfEntries.filter(
            (e) => e.name === want && (entryType === undefined || e.entryType === entryType),
          );
        },
        getEntriesByType(entryType) {
          return __perfEntries.filter((e) => e.entryType === entryType);
        },
        clearMarks(name) {
          for (let i = __perfEntries.length - 1; i >= 0; i--) {
            const entry = __perfEntries[i];
            if (entry.entryType === "mark" && (name === undefined || entry.name === name)) {
              __perfEntries.splice(i, 1);
            }
          }
        },
        clearMeasures(name) {
          for (let i = __perfEntries.length - 1; i >= 0; i--) {
            const entry = __perfEntries[i];
            if (entry.entryType === "measure" && (name === undefined || entry.name === name)) {
              __perfEntries.splice(i, 1);
            }
          }
        },
        clearResourceTimings() {},
        // Resource timing entries are not stored, so sizing leaves marks and measures alone.
        setResourceTimingBufferSize(_size: unknown) {
          if (arguments.length < 1) {
            throw new TypeError(
              "Failed to execute 'setResourceTimingBufferSize' on 'Performance': 1 argument required, but only 0 present.",
            );
          }
        },
        timing: {
          connectStart: 0,
          connectEnd: 0,
          domComplete: 0,
          domContentLoadedEventEnd: 0,
          domContentLoadedEventStart: 0,
          domInteractive: 0,
          domLoading: 0,
          domainLookupEnd: 0,
          domainLookupStart: 0,
          fetchStart: 0,
          loadEventEnd: 0,
          loadEventStart: 0,
          navigationStart: 0,
          redirectEnd: 0,
          redirectStart: 0,
          requestStart: 0,
          responseEnd: 0,
          responseStart: 0,
          secureConnectionStart: 0,
          unloadEventEnd: 0,
          unloadEventStart: 0,
        },
        navigation: { type: 0, redirectCount: 0 },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        },
        toJSON() {
          return { timeOrigin: this.timeOrigin };
        },
      };
      installPerformanceShim(__perfShim);
    }
  };

  function nativePerformanceNow(perf: Performance | undefined): () => number {
    return perf && typeof perf.now === "function" ? perf.now.bind(perf) : () => Date.now();
  }

  function nativePerformanceTimeOrigin(perf: Performance | undefined): number {
    return perf && typeof perf.timeOrigin === "number" ? perf.timeOrigin : Date.now();
  }

  function addNavigationPerformanceEntry(
    entries: { push: (entry: PerfEntryRecord) => unknown },
    targetWindow: PerformanceWindowLike | null | undefined,
  ): void {
    try {
      const pageUrl =
        targetWindow && targetWindow.location && typeof targetWindow.location.href === "string"
          ? targetWindow.location.href
          : "";
      entries.push({
        name: pageUrl,
        entryType: "navigation",
        startTime: 0,
        duration: 0,
        type: "navigate",
        redirectCount: 0,
        initiatorType: "navigation",
        nextHopProtocol: "",
        workerStart: 0,
        redirectStart: 0,
        redirectEnd: 0,
        fetchStart: 0,
        domainLookupStart: 0,
        domainLookupEnd: 0,
        connectStart: 0,
        connectEnd: 0,
        secureConnectionStart: 0,
        requestStart: 0,
        responseStart: 0,
        responseEnd: 0,
        transferSize: 0,
        encodedBodySize: 0,
        decodedBodySize: 0,
        unloadEventStart: 0,
        unloadEventEnd: 0,
        domInteractive: 0,
        domContentLoadedEventStart: 0,
        domContentLoadedEventEnd: 0,
        domComplete: 0,
        loadEventStart: 0,
        loadEventEnd: 0,
        toJSON() {
          return { ...this };
        },
      });
    } catch {}
  }

  function isMeasureOptions(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function installPerformanceShim(performanceShim: object): void {
    try {
      ksGlobal.performance = performanceShim;
    } catch {
      try {
        Object.defineProperty(globalThis, "performance", {
          value: performanceShim,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch {}
    }
  }
  installPerformanceApiShim();

  globalThis.getComputedStyle = (el, pseudo) => (win as any).getComputedStyle(el, pseudo);
  const installObserverGlobals = function installObserverGlobals(): void {
    if (typeof globalThis.MutationObserver !== "function") {
      const MutationObserverStub = function (_callback) {};
      defineEnumerableProto(MutationObserverStub.prototype, {
        observe() {},
        disconnect() {},
        takeRecords() {
          return [];
        },
      });
      globalThis.MutationObserver = MutationObserverStub;
    }
    if (typeof globalThis.ResizeObserver !== "function") {
      const RESIZE_OBSERVER_POLL_INTERVAL_MS = 250;
      const RESIZE_OBSERVER_SIZE_TOLERANCE_PX = 0.5;
      const activeResizeObservers = new Set<any>();
      let resizeObserverPollTimer: number | null = null;
      let resizeObserverPolledEpoch = -1;
      let resizeObserverResolveWarned = false;
      const stopResizeObserverPoll = () => {
        if (resizeObserverPollTimer === null) return;
        try {
          globalThis.clearInterval(resizeObserverPollTimer);
        } catch {}
        resizeObserverPollTimer = null;
      };
      const shouldSkipResizeObserverPoll = (dom: typeof state.dom): boolean => {
        const idle = dom?.layoutClean() === true && dom.isAnimating() !== true;
        return idle && dom.layoutEpoch() === resizeObserverPolledEpoch;
      };
      const resolveResizeObserverLayout = (dom: typeof state.dom): void => {
        try {
          dom?.resolveLayout();
        } catch (error) {
          if (!resizeObserverResolveWarned) {
            console.warn("[kitesurf] ResizeObserver poll: layout failed", error);
          }
          resizeObserverResolveWarned = true;
        }
      };
      const cleanResizeObserverLayoutEpoch = (dom: typeof state.dom): number => {
        return dom?.layoutClean() === true ? dom.layoutEpoch() : -1;
      };
      const recordSettledResizeObserverEpoch = (
        dom: typeof state.dom,
        measuredEpoch: number,
      ): void => {
        const settled = dom?.layoutClean() === true && dom.layoutEpoch() === measuredEpoch;
        resizeObserverPolledEpoch = settled ? measuredEpoch : -1;
      };
      const pollResizeObservers = () => {
        if (activeResizeObservers.size === 0) {
          stopResizeObserverPoll();
          return;
        }
        // A box only resizes through a resolve, and a running CSS animation only advances
        // when someone resolves, so skip only an idle page that nothing relaid out since.
        const dom = state.dom;
        if (shouldSkipResizeObserverPoll(dom)) return;
        resizeObserverPolledEpoch = -1;
        resolveResizeObserverLayout(dom);
        const measuredEpoch = cleanResizeObserverLayoutEpoch(dom);
        pollResizeTargets();
        // A callback that relaid out may have moved boxes measured before it
        // ran, so only an epoch nothing advanced past lets the next poll skip.
        recordSettledResizeObserverEpoch(dom, measuredEpoch);
      };
      const resizeDimensionChanged = (previous: number, current: number): boolean => {
        return Math.abs(previous - current) > RESIZE_OBSERVER_SIZE_TOLERANCE_PX;
      };
      const resizeContentSizeChanged = (lastSize, width: number, height: number): boolean => {
        return (
          resizeDimensionChanged(lastSize.w, width) || resizeDimensionChanged(lastSize.h, height)
        );
      };
      const resizeBorderSizeChanged = (lastSize, width: number, height: number): boolean => {
        return (
          resizeDimensionChanged(lastSize.bw, width) || resizeDimensionChanged(lastSize.bh, height)
        );
      };
      const resizeObserverTargetMoved = (lastSize, entry): boolean => {
        return (
          !lastSize ||
          resizeContentSizeChanged(lastSize, entry.contentRect.width, entry.contentRect.height) ||
          resizeBorderSizeChanged(
            lastSize,
            entry.borderBoxSize[0].inlineSize,
            entry.borderBoxSize[0].blockSize,
          )
        );
      };
      const updateResizeObserverTarget = (observer, target, changedEntries): void => {
        const entry = observer._entryFor(target);
        const lastSize = observer._last.get(target);
        if (!resizeObserverTargetMoved(lastSize, entry)) return;
        observer._last.set(target, {
          w: entry.contentRect.width,
          h: entry.contentRect.height,
          bw: entry.borderBoxSize[0].inlineSize,
          bh: entry.borderBoxSize[0].blockSize,
        });
        changedEntries.push(entry);
      };
      const pollObserverTargets = (observer): void => {
        const changedEntries: unknown[] = [];
        for (const target of observer._targets) {
          updateResizeObserverTarget(observer, target, changedEntries);
        }
        if (changedEntries.length) {
          try {
            observer._cb(changedEntries, observer);
          } catch {}
        }
      };
      const pollResizeTargets = () => {
        for (const observer of activeResizeObservers) {
          pollObserverTargets(observer);
        }
      };
      const ensureResizeObserverPoll = () => {
        if (resizeObserverPollTimer === null && globalThis.setInterval) {
          try {
            resizeObserverPollTimer = globalThis.setInterval(
              pollResizeObservers,
              RESIZE_OBSERVER_POLL_INTERVAL_MS,
            );
          } catch {}
        }
      };
      interface ResizeObserverShim {
        _cb: (entries: unknown[], observer: ResizeObserverShim) => void;
        _targets: Set<unknown>;
        _last: Map<unknown, { w: number; h: number; bw: number; bh: number }>;
        _entryFor(target: unknown): ReturnType<typeof entryFor>;
      }
      const ResizeObserverStub = function (this: ResizeObserverShim, callback) {
        this._cb = callback;
        this._targets = new Set();
        this._last = new Map();
      };
      const parsePixels = (value) => (value ? parseFloat(value) || 0 : 0);
      const applyResizeContentBox = (target, computedStyle, measurements) => {
        if (!computedStyle || typeof target.clientWidth !== "number" || target.clientWidth <= 0) {
          return;
        }
        measurements.width = Math.max(
          0,
          target.clientWidth -
            parsePixels(computedStyle.paddingLeft) -
            parsePixels(computedStyle.paddingRight),
        );
        measurements.height = Math.max(
          0,
          target.clientHeight -
            parsePixels(computedStyle.paddingTop) -
            parsePixels(computedStyle.paddingBottom),
        );
      };
      const readResizeMeasurements = (target) => {
        const measurements = { borderWidth: 0, borderHeight: 0, width: 0, height: 0 };
        try {
          const rect = target.getBoundingClientRect();
          measurements.borderWidth = rect.width;
          measurements.borderHeight = rect.height;
          measurements.width = measurements.borderWidth;
          measurements.height = measurements.borderHeight;
          const computedStyle = globalThis.getComputedStyle
            ? globalThis.getComputedStyle(target)
            : null;
          applyResizeContentBox(target, computedStyle, measurements);
        } catch {}
        return measurements;
      };
      const entryFor = (target) => {
        const { borderWidth, borderHeight, width, height } = readResizeMeasurements(target);
        const devicePixelRatio = Number(globalThis.devicePixelRatio) || 1;
        return {
          target,
          contentRect: {
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            width,
            height,
            right: width,
            bottom: height,
          },
          borderBoxSize: [{ inlineSize: borderWidth, blockSize: borderHeight }],
          contentBoxSize: [{ inlineSize: width, blockSize: height }],
          devicePixelContentBoxSize: [
            {
              inlineSize: Math.round(width * devicePixelRatio),
              blockSize: Math.round(height * devicePixelRatio),
            },
          ],
        };
      };
      defineEnumerableProto(ResizeObserverStub.prototype, {
        observe(this: ResizeObserverShim, target) {
          if (!target) return;
          this._targets.add(target);
          activeResizeObservers.add(this);
          ensureResizeObserverPoll();
          const observer = this;
          ((globalThis.setTimeout || ((callback) => callback())) as any)(() => {
            if (!observer._targets.has(target)) return;
            const entry = observer._entryFor(target);
            observer._last.set(target, {
              w: entry.contentRect.width,
              h: entry.contentRect.height,
              bw: entry.borderBoxSize[0].inlineSize,
              bh: entry.borderBoxSize[0].blockSize,
            });
            try {
              observer._cb([entry], observer);
            } catch {}
          }, 0);
        },
        unobserve(this: ResizeObserverShim, target) {
          this._targets.delete(target);
          this._last.delete(target);
          if (this._targets.size === 0) activeResizeObservers.delete(this);
        },
        disconnect(this: ResizeObserverShim) {
          this._targets.clear();
          this._last.clear();
          activeResizeObservers.delete(this);
        },
        _entryFor(target) {
          return entryFor(target);
        },
      });
      globalThis.ResizeObserver = ResizeObserverStub;
    }
    if (typeof ksGlobal.PerformanceObserver !== "function") {
      const PerformanceObserverStub = function (_callback) {};
      defineEnumerableProto(PerformanceObserverStub.prototype, {
        observe() {},
        disconnect() {},
        takeRecords() {
          return [];
        },
      });
      (PerformanceObserverStub as any).supportedEntryTypes = Object.freeze(["mark", "measure"]);
      ksGlobal.PerformanceObserver = PerformanceObserverStub;
    }
  };
  installObserverGlobals();

  const installImageGlobal = function installImageGlobal(): void {
    if (typeof globalThis.Image !== "function") {
      const setImageDimension = (
        imageElement: any,
        dimension: "width" | "height",
        value: unknown,
      ): void => {
        if (value === undefined) return;
        try {
          imageElement[dimension] = value;
        } catch {}
      };
      const installImagePrototype = (Image: Function): void => {
        const HTMLImageElement = ksGlobal.HTMLImageElement;
        if (HTMLImageElement && HTMLImageElement.prototype) {
          Object.defineProperty(Image, "prototype", {
            value: HTMLImageElement.prototype,
            writable: false,
            enumerable: false,
            configurable: false,
          });
        }
      };
      const Image = function Image(width, height) {
        if (new.target === undefined) {
          throw new TypeError("Failed to construct 'Image': Please use the 'new' operator");
        }
        const imageElement = document.createElement("img");
        setImageDimension(imageElement, "width", width);
        setImageDimension(imageElement, "height", height);
        return imageElement;
      };
      installImagePrototype(Image);
      globalThis.Image = Image;
    }
  };
  installImageGlobal();

  const installAudioGlobal = function installAudioGlobal(): void {
    if (typeof globalThis.Audio !== "function") {
      const Audio = function Audio(src) {
        if (new.target === undefined) {
          throw new TypeError("Failed to construct 'Audio': Please use the 'new' operator");
        }
        const audioElement = document.createElement("audio");
        try {
          audioElement.setAttribute("preload", "auto");
        } catch {}
        if (src !== undefined) {
          try {
            audioElement.setAttribute("src", String(src));
          } catch {}
        }
        return audioElement;
      };
      const HTMLAudioElement = ksGlobal.HTMLAudioElement;
      if (HTMLAudioElement && HTMLAudioElement.prototype) {
        Object.defineProperty(Audio, "prototype", {
          value: HTMLAudioElement.prototype,
          writable: false,
          enumerable: false,
          configurable: false,
        });
      }
      globalThis.Audio = Audio;
    }
  };
  installAudioGlobal();

  const installOptionGlobal = function installOptionGlobal(): void {
    if (typeof globalThis.Option !== "function") {
      const setOptionText = (option, text): void => {
        if (text === undefined) return;
        try {
          option.text = String(text);
        } catch {}
      };
      const setOptionValue = (option, value): void => {
        if (value === undefined) return;
        try {
          option.setAttribute("value", String(value));
        } catch {}
      };
      const setOptionDefaultSelected = (option, defaultSelected): void => {
        if (!defaultSelected) return;
        try {
          option.setAttribute("selected", "");
        } catch {}
      };
      const setOptionSelectedness = (option, selected): void => {
        try {
          option.__ksSetSelectednessUndirty(!!selected);
        } catch {}
      };
      const Option = function Option(text, value, defaultSelected, selected) {
        const option = document.createElement("option");
        setOptionText(option, text);
        setOptionValue(option, value);
        setOptionDefaultSelected(option, defaultSelected);
        setOptionSelectedness(option, selected);
        return option;
      };
      globalThis.Option = Option;
    }
  };
  installOptionGlobal();

  const installOffscreenCanvasGlobal = function installOffscreenCanvasGlobal(): void {
    if (
      typeof ksGlobal.OffscreenCanvas !== "function" ||
      typeof ksGlobal.OffscreenCanvas?.prototype?.getContext !== "function"
    ) {
      const assertOffscreenCanvasConstructor = (
        isConstructorCall: boolean,
        argumentCount: number,
      ): void => {
        if (!isConstructorCall) {
          throw new TypeError(
            "Failed to construct 'OffscreenCanvas': Please use the 'new' operator",
          );
        }
        if (argumentCount < 2) {
          throw new TypeError(
            "Failed to construct 'OffscreenCanvas': 2 arguments required, but only " +
              argumentCount +
              " present.",
          );
        }
      };
      const setCanvasDimension = (canvas, dimension: "width" | "height", value: unknown): void => {
        try {
          canvas[dimension] = Number(value) || 0;
        } catch {}
      };
      const OffscreenCanvas = function OffscreenCanvas(this: object, width: any, height: any) {
        assertOffscreenCanvasConstructor(new.target !== undefined, arguments.length);
        const canvas = document.createElement("canvas");
        setCanvasDimension(canvas, "width", width);
        setCanvasDimension(canvas, "height", height);
        Object.defineProperty(this, "__ksBackingCanvas", { value: canvas, configurable: true });
      };
      OffscreenCanvas.prototype.getContext = function (contextType: any, attributes?: any) {
        return this.__ksBackingCanvas.getContext(contextType, attributes);
      };
      Object.defineProperty(OffscreenCanvas.prototype, "width", {
        configurable: true,
        enumerable: true,
        get() {
          return this.__ksBackingCanvas.width;
        },
        set(v) {
          this.__ksBackingCanvas.width = v;
        },
      });
      Object.defineProperty(OffscreenCanvas.prototype, "height", {
        configurable: true,
        enumerable: true,
        get() {
          return this.__ksBackingCanvas.height;
        },
        set(v) {
          this.__ksBackingCanvas.height = v;
        },
      });
      Object.defineProperty(OffscreenCanvas.prototype, Symbol.toStringTag, {
        value: "OffscreenCanvas",
        configurable: true,
      });
      ksGlobal.OffscreenCanvas = OffscreenCanvas;
    }
  };
  installOffscreenCanvasGlobal();
  const ksCanonicalize = ksGlobal.__ks_canonicalize_inline_style as
    | ((css: string) => Array<{ name: string; value: string }>)
    | undefined;
  const canonicalDeclarationSupported = (declarations: unknown): boolean => {
    return Array.isArray(declarations) && declarations.length > 0;
  };
  const customPropertySupported = (name: string, value: string): boolean => {
    return name.startsWith("--") && value.trim() !== "";
  };
  const declSupported = (name: string, value: string): boolean => {
    if (typeof ksCanonicalize !== "function") return false;
    try {
      return (
        canonicalDeclarationSupported(ksCanonicalize(`${name}: ${value}`)) ||
        customPropertySupported(name, value)
      );
    } catch {
      return false;
    }
  };
  const selectorSupported = (selector: string): boolean => {
    const document = ksGlobal.document;
    if (!document || typeof document.querySelector !== "function") return false;
    try {
      document.querySelector(selector);
      return true;
    } catch {
      return false;
    }
  };
  const advanceQuotedCharacter = (
    character: string,
    quote: string,
  ): { quote: string | null; skipNext: boolean } => {
    if (character === "\\") return { quote, skipNext: true };
    return { quote: character === quote ? null : quote, skipNext: false };
  };
  const advanceParenthesisDepth = (
    character: string,
    depth: number,
  ): { depth: number; matched: boolean } => {
    if (character === "(") return { depth: depth + 1, matched: false };
    if (character !== ")") return { depth, matched: false };
    const nextDepth = depth - 1;
    return { depth: nextDepth, matched: nextDepth === 0 };
  };
  const advanceParenScan = (
    character: string,
    depth: number,
    quote: string | null,
  ): {
    depth: number;
    quote: string | null;
    skipNext: boolean;
    handled: boolean;
    matched: boolean;
  } => {
    if (quote !== null) {
      const quoteState = advanceQuotedCharacter(character, quote);
      return {
        depth,
        quote: quoteState.quote,
        skipNext: quoteState.skipNext,
        handled: true,
        matched: false,
      };
    }
    if (character === '"' || character === "'") {
      return { depth, quote: character, skipNext: false, handled: true, matched: false };
    }
    const parenState = advanceParenthesisDepth(character, depth);
    return {
      depth: parenState.depth,
      quote,
      skipNext: false,
      handled: false,
      matched: parenState.matched,
    };
  };
  const matchParen = (text: string, openParenIndex: number): number => {
    let depth = 0;
    let quote: string | null = null;
    for (let index = openParenIndex; index < text.length; index++) {
      const state = advanceParenScan(text[index], depth, quote);
      depth = state.depth;
      quote = state.quote;
      if (state.skipNext) index++;
      if (state.handled) continue;
      if (state.matched) return index + 1;
    }
    return -1;
  };
  type Tri = boolean | "unknown";
  interface SupportsConditionParser {
    condition: string;
    cursor: number;
    combinator: "and" | "or" | null;
  }
  const skipConditionWhitespace = (parser: SupportsConditionParser): void => {
    while (parser.cursor < parser.condition.length && /\s/.test(parser.condition[parser.cursor])) {
      parser.cursor++;
    }
  };
  const parseConditionDeclaration = (condition: string): Tri => {
    const colon = condition.indexOf(":");
    if (colon <= 0) return "unknown";
    const name = condition.slice(0, colon).trim();
    if (!/^-{0,2}[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) return "unknown";
    return declSupported(name, condition.slice(colon + 1).trim());
  };
  const parseConditionFunction = (
    parser: SupportsConditionParser,
    functionMatch: RegExpExecArray,
  ): Tri | null => {
    const openParenIndex = parser.cursor + functionMatch[1].length;
    const endIndex = matchParen(parser.condition, openParenIndex);
    if (endIndex < 0) return null;
    const innerCondition = parser.condition.slice(openParenIndex + 1, endIndex - 1);
    parser.cursor = endIndex;
    return functionMatch[1].toLowerCase() === "selector"
      ? selectorSupported(innerCondition)
      : "unknown";
  };
  const parseConditionGroup = (parser: SupportsConditionParser): Tri | null => {
    if (parser.condition[parser.cursor] !== "(") return null;
    const endIndex = matchParen(parser.condition, parser.cursor);
    if (endIndex < 0) return null;
    const innerCondition = parser.condition.slice(parser.cursor + 1, endIndex - 1);
    parser.cursor = endIndex;
    const nested = evalCondition(innerCondition);
    return nested ?? parseConditionDeclaration(innerCondition);
  };
  const parseInParens = (parser: SupportsConditionParser): Tri | null => {
    skipConditionWhitespace(parser);
    const functionMatch = /^([a-zA-Z][a-zA-Z0-9-]*)\(/.exec(parser.condition.slice(parser.cursor));
    if (functionMatch) return parseConditionFunction(parser, functionMatch);
    return parseConditionGroup(parser);
  };
  const negatedCondition = (
    parser: SupportsConditionParser,
  ): { matched: boolean; result: Tri | null } => {
    if (!/^not(?![a-zA-Z0-9_-])/i.test(parser.condition.slice(parser.cursor))) {
      return { matched: false, result: null };
    }
    parser.cursor += 3;
    const value = parseInParens(parser);
    if (value === null) return { matched: true, result: null };
    skipConditionWhitespace(parser);
    if (parser.cursor < parser.condition.length) return { matched: true, result: null };
    return { matched: true, result: value === "unknown" ? "unknown" : !value };
  };
  const parseLogicalCondition = (
    parser: SupportsConditionParser,
  ): { operator: "and" | "or"; value: Tri } | null => {
    const keywordMatch = /^(and|or)(?![a-zA-Z0-9_-])/i.exec(parser.condition.slice(parser.cursor));
    if (!keywordMatch) return null;
    const operator = keywordMatch[1].toLowerCase() as "and" | "or";
    if (parser.combinator && operator !== parser.combinator) return null;
    parser.combinator = operator;
    parser.cursor += operator.length;
    const value = parseInParens(parser);
    return value === null ? null : { operator, value };
  };
  const combineAndConditions = (left: Tri, right: Tri): Tri => {
    if (left === false || right === false) return false;
    if (left === "unknown" || right === "unknown") return "unknown";
    return true;
  };
  const combineOrConditions = (left: Tri, right: Tri): Tri => {
    if (left === true || right === true) return true;
    if (left === "unknown" || right === "unknown") return "unknown";
    return false;
  };
  const combineConditions = (left: Tri, right: Tri, operator: "and" | "or"): Tri => {
    return operator === "and"
      ? combineAndConditions(left, right)
      : combineOrConditions(left, right);
  };
  const evalCondition = (condition: string): Tri | null => {
    const parser: SupportsConditionParser = { condition, cursor: 0, combinator: null };
    skipConditionWhitespace(parser);
    const negation = negatedCondition(parser);
    if (negation.matched) return negation.result;
    let result = parseInParens(parser);
    if (result === null) return null;
    skipConditionWhitespace(parser);
    while (parser.cursor < condition.length) {
      const next = parseLogicalCondition(parser);
      if (!next) return null;
      result = combineConditions(result, next.value, next.operator);
      skipConditionWhitespace(parser);
    }
    return result;
  };

  const supportsConditionString = (condition: string): boolean => {
    const conditionResult = evalCondition(condition);
    if (conditionResult !== null) return conditionResult === true;
    const colon = condition.indexOf(":");
    if (colon <= 0) return false;
    return declSupported(condition.slice(0, colon).trim(), condition.slice(colon + 1).trim());
  };
  const supports = (propertyOrCondition: unknown, value: unknown): boolean => {
    if (typeof propertyOrCondition !== "string") return false;
    if (typeof value === "string") return declSupported(propertyOrCondition, value);
    return supportsConditionString(propertyOrCondition);
  };
  ksGlobal.CSS = {
    escape(identifier: any) {
      return String(identifier).replace(/[^a-zA-Z0-9_-]/g, (character) => "\\" + character);
    },
    supports(propertyOrCondition: any, value?: any) {
      return supports(propertyOrCondition, value);
    },
    registerProperty(_opts: any) {},
  };
  for (const unit of [
    "number",
    "percent",
    "px",
    "cm",
    "mm",
    "Q",
    "in",
    "pt",
    "pc",
    "em",
    "ex",
    "ch",
    "cap",
    "ic",
    "rem",
    "lh",
    "rlh",
    "rcap",
    "rch",
    "rex",
    "ric",
    "vw",
    "vh",
    "vi",
    "vb",
    "vmin",
    "vmax",
    "svw",
    "svh",
    "svi",
    "svb",
    "svmin",
    "svmax",
    "lvw",
    "lvh",
    "lvi",
    "lvb",
    "lvmin",
    "lvmax",
    "dvw",
    "dvh",
    "dvi",
    "dvb",
    "dvmin",
    "dvmax",
    "cqw",
    "cqh",
    "cqi",
    "cqb",
    "cqmin",
    "cqmax",
    "deg",
    "grad",
    "rad",
    "turn",
    "s",
    "ms",
    "Hz",
    "kHz",
    "dpi",
    "dpcm",
    "dppx",
    "fr",
  ]) {
    ksGlobal.CSS[unit] = (value: unknown) => new built.CSSUnitValue(value, unit);
  }
  class Highlight extends Set<unknown> {
    priority = 0;
    type = "highlight";
    constructor(...ranges: unknown[]) {
      super(ranges);
    }
    get [Symbol.toStringTag]() {
      return "Highlight";
    }
  }
  class HighlightRegistry extends Map<string, Highlight> {
    set(name: string, highlight: Highlight) {
      if (!(highlight instanceof Highlight)) {
        throw new TypeError("HighlightRegistry.set: value is not a Highlight");
      }
      return super.set(String(name), highlight);
    }
    highlightsFromPoint() {
      return [];
    }
    get [Symbol.toStringTag]() {
      return "HighlightRegistry";
    }
  }
  ksGlobal.Highlight = Highlight;
  ksGlobal.HighlightRegistry = HighlightRegistry;
  ksGlobal.CSS.highlights = new HighlightRegistry();
  const installMediaQueryGlobals = function installMediaQueryGlobals(): void {
    if (typeof globalThis.matchMedia !== "function") {
      const MEDIA_QUERY_EM_REFERENCE_PX = 16;
      const MEDIA_QUERY_PERCENT_SCALE = 100;
      const MEDIA_QUERY_DPI_PER_DPPX = 96;
      const MEDIA_QUERY_DPCM_PER_DPPX = 37.7953;
      const __ksMediaState = {
        get width() {
          return Number(globalThis.innerWidth) || DEFAULT_VIEWPORT_WIDTH_PX;
        },
        get height() {
          return Number(globalThis.innerHeight) || DEFAULT_VIEWPORT_HEIGHT_PX;
        },
        get dpr() {
          return Number(globalThis.devicePixelRatio) || 1;
        },
        get colorScheme(): "light" | "dark" | "no-preference" {
          return ksGlobal.__ks_dark_scheme === true ? "dark" : "light";
        },
        reducedMotion: "no-preference" as "reduce" | "no-preference",
        contrast: "no-preference" as "more" | "less" | "no-preference",
        hover: "hover" as "hover" | "none",
        pointer: "fine" as "fine" | "coarse" | "none",
        displayMode: "browser" as string,
        forcedColors: "none" as "active" | "none",
        colorBits: 8,
        mediaType: "screen" as "screen" | "print" | "all",
      };
      ksGlobal.__ksMediaState = __ksMediaState;

      const parseLength = (valueText: string): number => {
        const match = /^(-?\d+(?:\.\d+)?)\s*(px|em|rem|vw|vh|%)?$/.exec(valueText.trim());
        if (!match) return NaN;
        const numericValue = parseFloat(match[1]);
        const unit = (match[2] || "px").toLowerCase();
        switch (unit) {
          case "px":
            return numericValue;
          case "em":
          case "rem":
            return numericValue * MEDIA_QUERY_EM_REFERENCE_PX;
          case "vw":
          case "%":
            return (numericValue / MEDIA_QUERY_PERCENT_SCALE) * __ksMediaState.width;
          case "vh":
            return (numericValue / MEDIA_QUERY_PERCENT_SCALE) * __ksMediaState.height;
          default:
            return NaN;
        }
      };
      const parseResolution = (valueText: string): number => {
        const match = /^(\d+(?:\.\d+)?)\s*(dpi|dppx|dpcm)$/.exec(valueText.trim());
        if (!match) return NaN;
        const numericValue = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        if (unit === "dppx") return numericValue;
        if (unit === "dpi") return numericValue / MEDIA_QUERY_DPI_PER_DPPX;
        if (unit === "dpcm") return numericValue / MEDIA_QUERY_DPCM_PER_DPPX;
        return NaN;
      };

      const compareMediaFeatureValue = (
        name: string,
        actual: number,
        requested: number,
      ): boolean => {
        if (name.startsWith("min-")) return actual >= requested;
        if (name.startsWith("max-")) return actual <= requested;
        return actual === requested;
      };
      const evaluateDimensionFeature = (
        name: string,
        value: string,
        dimension: "width" | "height",
        pattern: RegExp,
      ): boolean | null => {
        if (!pattern.test(name)) return null;
        const requested = parseLength(value);
        if (isNaN(requested)) return false;
        return compareMediaFeatureValue(name, __ksMediaState[dimension], requested);
      };
      const evaluateOrientationFeature = (name: string, value: string): boolean | null => {
        if (name !== "orientation") return null;
        const portrait = __ksMediaState.height >= __ksMediaState.width;
        return value === "portrait" ? portrait : value === "landscape" ? !portrait : false;
      };
      const simpleMediaFeatureKeys = new Map<string, keyof typeof __ksMediaState>([
        ["prefers-color-scheme", "colorScheme"],
        ["prefers-reduced-motion", "reducedMotion"],
        ["prefers-contrast", "contrast"],
        ["hover", "hover"],
        ["any-hover", "hover"],
        ["pointer", "pointer"],
        ["any-pointer", "pointer"],
        ["display-mode", "displayMode"],
        ["forced-colors", "forcedColors"],
      ]);
      const evaluateSimpleMediaFeature = (name: string, value: string): boolean | null => {
        const stateKey = simpleMediaFeatureKeys.get(name);
        return stateKey ? value === String(__ksMediaState[stateKey]) : null;
      };
      const evaluateResolutionFeature = (name: string, value: string): boolean | null => {
        if (!/^(min-|max-)?resolution$/.test(name)) return null;
        const requested = parseResolution(value);
        if (isNaN(requested)) return false;
        return compareMediaFeatureValue(name, __ksMediaState.dpr, requested);
      };
      const evaluateColorFeature = (name: string, value: string): boolean | null => {
        if (!/^(min-|max-)?color$/.test(name)) return null;
        const requested = parseInt(value, 10);
        if (isNaN(requested)) return __ksMediaState.colorBits > 0;
        return compareMediaFeatureValue(name, __ksMediaState.colorBits, requested);
      };
      const mediaFeatureEvaluators = [
        (name: string, value: string) =>
          evaluateDimensionFeature(name, value, "width", /^(min-|max-)?(device-)?width$/),
        (name: string, value: string) =>
          evaluateDimensionFeature(name, value, "height", /^(min-|max-)?(device-)?height$/),
        evaluateOrientationFeature,
        evaluateSimpleMediaFeature,
        evaluateResolutionFeature,
        evaluateColorFeature,
      ];
      const evaluateMediaFeature = (name: string, value: string): boolean => {
        for (const evaluate of mediaFeatureEvaluators) {
          const result = evaluate(name, value);
          if (result !== null) return result;
        }
        return false;
      };
      const evalFeature = (raw: string): boolean => {
        const inner = raw.replace(/^\(/, "").replace(/\)$/, "").trim();
        const colon = inner.indexOf(":");
        const name = (colon === -1 ? inner : inner.slice(0, colon)).trim().toLowerCase();
        const value =
          colon === -1
            ? ""
            : inner
                .slice(colon + 1)
                .trim()
                .toLowerCase();
        return evaluateMediaFeature(name, value);
      };

      const evalMediaType = (mediaType: string): boolean => {
        const mediaState = __ksMediaState;
        if (mediaType === "all") return true;
        if (mediaType === mediaState.mediaType) return true;
        return false;
      };

      const isTopLevelMediaSeparator = (
        query: string,
        index: number,
        depth: number,
        separator: string,
      ): boolean => depth === 0 && query.startsWith(separator, index);
      const splitTopLevelMediaQuery = (query: string, separator: string): string[] => {
        const parts: string[] = [];
        let depth = 0;
        let partStart = 0;
        for (let i = 0; i < query.length; i++) {
          const character = query[i];
          if (character === "(") depth++;
          else if (character === ")") depth--;
          else if (isTopLevelMediaSeparator(query, i, depth, separator)) {
            parts.push(query.slice(partStart, i));
            i += separator.length - 1;
            partStart = i + 1;
          }
        }
        parts.push(query.slice(partStart));
        return parts;
      };
      const normalizedMediaQuery = (querySource: string): { query: string; negated: boolean } => {
        let query = querySource.trim().toLowerCase();
        let negated = false;
        if (query.startsWith("not ")) {
          negated = true;
          query = query.slice(4).trim();
        } else if (query.startsWith("only ")) {
          query = query.slice(5).trim();
        }
        return { query, negated };
      };
      const evalMediaQueryPart = (part: string): boolean => {
        const trimmed = part.trim();
        if (!trimmed) return true;
        if (trimmed.startsWith("(") && trimmed.endsWith(")")) return evalFeature(trimmed);
        return evalMediaType(trimmed);
      };
      const evalMediaQueryParts = (parts: string[]): boolean => {
        for (const part of parts) {
          if (!evalMediaQueryPart(part)) return false;
        }
        return true;
      };
      const evalQuery = (querySource: string): boolean => {
        const normalized = normalizedMediaQuery(querySource);
        if (!normalized.query) return !normalized.negated;
        const parts = splitTopLevelMediaQuery(normalized.query, " and ");
        const matches = evalMediaQueryParts(parts);
        return normalized.negated ? !matches : matches;
      };

      const evalQueryList = (queryList: string): boolean => {
        return splitTopLevelMediaQuery(queryList, ",").some(evalQuery);
      };

      class MediaQueryList {
        media: string;
        onchange: any = null;
        constructor(media: string) {
          this.media = media;
        }
        get matches() {
          return evalQueryList(this.media);
        }
        addEventListener() {}
        removeEventListener() {}
        addListener() {}
        removeListener() {}
        dispatchEvent() {
          return false;
        }
        get [Symbol.toStringTag]() {
          return "MediaQueryList";
        }
      }
      ksGlobal.MediaQueryList = MediaQueryList;
      globalThis.matchMedia = (query: any) => {
        return new MediaQueryList(String(query || ""));
      };
    }
    if (typeof globalThis.MediaQueryListEvent !== "function") {
      const EventBase = ksGlobal.Event;
      class MediaQueryListEvent extends EventBase {
        media: string;
        matches: boolean;
        constructor(type: string, init: any = {}) {
          super(type, init);
          this.media = String(init.media ?? "");
          this.matches = Boolean(init.matches);
        }
      }
      ksGlobal.MediaQueryListEvent = MediaQueryListEvent;
    }
  };
  installMediaQueryGlobals();

  const installHtmlElementUpgradeGlobal = function installHtmlElementUpgradeGlobal(): void {
    if (typeof globalThis.HTMLElement === "function") {
      const Base = globalThis.HTMLElement;
      const ctorTagNames = new WeakMap();
      ksGlobal.__ks_ctorTagNames = ctorTagNames;
      const upgradeTargets: Array<{ target: any; consumed: boolean }> = [];
      const htmlInterfaces: readonly unknown[] = Object.values(built.htmlElementInterfaces ?? {});
      const installHtmlInterfacePrototypes = function installHtmlInterfacePrototypes(): void {
        for (const cls of htmlInterfaces) {
          if (typeof cls !== "function") continue;
          if (Object.getPrototypeOf(cls) === Base) Object.setPrototypeOf(cls, Patched);
          if (Object.getPrototypeOf(cls.prototype) === Base.prototype) {
            Object.setPrototypeOf(cls.prototype, Patched.prototype);
          }
        }
      };
      const shimElementClasses = new WeakSet<object>(
        htmlInterfaces.filter((cls): cls is object => typeof cls === "function"),
      );
      const consumeUpgradeTarget = () => {
        const frame = upgradeTargets[upgradeTargets.length - 1];
        if (!frame || frame.consumed) return null;
        frame.consumed = true;
        return frame;
      };
      const createTaggedElement = (tag, mint, prototype) => {
        if (!tag || typeof mint !== "function") return null;
        const element = mint(tag);
        if (!element) return null;
        Object.setPrototypeOf(element, prototype);
        return element;
      };
      const Patched = class extends Base {
        constructor(...args: unknown[]) {
          if (shimElementClasses.has(new.target)) {
            super(...args);
            return;
          }
          const frame = consumeUpgradeTarget();
          if (frame) return frame.target;
          const element = createTaggedElement(
            ctorTagNames.get(new.target),
            ksGlobal.__ks_createElementNoUpgrade,
            new.target.prototype,
          );
          if (element) return element;
          super(-1, { nodeType: 1, nodeName: "DIV", localName: "div" });
        }
      };
      Object.defineProperty(Patched, "_upgradeTarget", {
        get() {
          return upgradeTargets[upgradeTargets.length - 1]?.target ?? null;
        },
        set(value) {
          if (value == null) upgradeTargets.pop();
          else upgradeTargets.push({ target: value, consumed: false });
        },
        configurable: true,
      });
      Object.defineProperty(Patched, "name", {
        value: "HTMLElement",
        writable: false,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(Patched, Symbol.hasInstance, {
        value: function (this: unknown, v: unknown) {
          if (v == null) return false;
          if (typeof this === "function" && shimElementClasses.has(this)) {
            return Object.prototype.isPrototypeOf.call(this.prototype, v);
          }
          return Base.prototype.isPrototypeOf(v);
        },
        configurable: true,
      });
      copyHandlerAccessors(Patched.prototype, handlerNames(built, "all"));
      installHtmlInterfacePrototypes();
      globalThis.HTMLElement = Patched;
    }
  };
  installHtmlElementUpgradeGlobal();

  const installCustomElementsGlobal = function installCustomElementsGlobal(): void {
    if (typeof globalThis.customElements !== "object") {
      const registry = new Map();
      const observedAttributes = new WeakMap<object, Set<string>>();
      const attributeChangedCallbacks = new WeakMap<object, Function>();
      const upgradingElements = new WeakSet<object>();
      const failedElements = new WeakSet<object>();
      const queuedAttributeChanges = new WeakMap<object, any[][]>();
      const whenDefinedResolvers = new Map();
      const snapshotCustomElementAttributes = (element: any) => {
        return (Array.from(element.attributes || []) as any[]).map((attr) => ({
          name: String(attr.localName || attr.name || ""),
          value: String(attr.value),
          namespace: attr.namespaceURI ?? null,
        }));
      };
      const reportCustomElementConstructorFailure = (tagName: string, error: unknown): void => {
        console.warn("[kitesurf] custom-element constructor for " + tagName + " threw", error);
      };
      const constructWithUpgradeTarget = (
        htmlElementConstructor: any,
        element: any,
        customElementConstructor: any,
        tagName: string,
      ): boolean => {
        let constructed = true;
        htmlElementConstructor._upgradeTarget = element;
        try {
          new customElementConstructor();
        } catch (error) {
          constructed = false;
          reportCustomElementConstructorFailure(tagName, error);
        } finally {
          htmlElementConstructor._upgradeTarget = null;
        }
        return constructed;
      };
      const constructLegacyCustomElement = (
        element: any,
        customElementConstructor: any,
      ): boolean => {
        try {
          customElementConstructor.call(element);
          return true;
        } catch {
          try {
            customElementConstructor.prototype.constructor.call(element);
            return true;
          } catch {
            return false;
          }
        }
      };
      const constructCustomElement = (
        element: any,
        customElementConstructor: any,
        tagName: string,
      ): boolean => {
        const htmlElementConstructor = globalThis.HTMLElement;
        if (htmlElementConstructor && "_upgradeTarget" in htmlElementConstructor) {
          return constructWithUpgradeTarget(
            htmlElementConstructor,
            element,
            customElementConstructor,
            tagName,
          );
        }
        return constructLegacyCustomElement(element, customElementConstructor);
      };
      const reportAttributeChangedFailure = (tagName: string, error: unknown): void => {
        console.warn("[kitesurf] attributeChangedCallback for " + tagName + " threw", error);
      };
      const invokeAttributeChanged = (
        callback: Function,
        element: any,
        args: unknown[],
        tagName: string,
      ): void => {
        try {
          callback.call(element, ...args);
        } catch (error) {
          reportAttributeChangedFailure(tagName, error);
        }
      };
      const notifyInitialAttributeChanges = (
        element: any,
        attributes: any[],
        observed: Set<string>,
        callback: Function,
        tagName: string,
      ): void => {
        for (const attribute of attributes) {
          if (!observed.has(attribute.name)) continue;
          invokeAttributeChanged(
            callback,
            element,
            [attribute.name, null, attribute.value, attribute.namespace],
            tagName,
          );
        }
      };
      const notifyQueuedAttributeChanges = (
        element: any,
        callback: Function,
        tagName: string,
      ): void => {
        for (const args of queuedAttributeChanges.get(element) || []) {
          invokeAttributeChanged(callback, element, args, tagName);
        }
      };
      const notifyAttributeChangesOnUpgrade = (
        element: any,
        customElementConstructor: any,
        attributes: any[],
        tagName: string,
      ): void => {
        const observed = observedAttributes.get(customElementConstructor);
        const callback = attributeChangedCallbacks.get(customElementConstructor);
        if (!observed || !callback) return;
        notifyInitialAttributeChanges(element, attributes, observed, callback, tagName);
        notifyQueuedAttributeChanges(element, callback, tagName);
      };
      const notifyConnectedCallbackOnUpgrade = (
        element: any,
        options: { fireConnectedCallback?: boolean },
        tagName: string,
      ): void => {
        if (!options.fireConnectedCallback || typeof element.connectedCallback !== "function")
          return;
        try {
          element.connectedCallback();
        } catch (error) {
          console.warn("[kitesurf] connectedCallback for " + tagName + " threw", error);
        }
      };
      const recordCustomElementUpgradeFailure = (element: object): void => {
        failedElements.add(element);
        queuedAttributeChanges.delete(element);
      };
      const canNotifyCustomElementAttributeChange = (
        element: any,
        name: string,
        customElementConstructor: any,
        observed: Set<string> | undefined,
      ): boolean => {
        if (!observed?.has(name)) return false;
        if (!customElementPrototypeMatches(customElementConstructor, element)) return false;
        return !failedElements.has(element);
      };
      const customElementPrototypeMatches = (
        customElementConstructor: any,
        element: any,
      ): boolean => {
        return Boolean(customElementConstructor?.prototype.isPrototypeOf(element));
      };
      const queueCustomElementAttributeChange = (
        element: object,
        name: string,
        oldValue: string | null,
        newValue: string | null,
        namespace: string | null,
      ): boolean => {
        if (!upgradingElements.has(element)) return false;
        const queued = queuedAttributeChanges.get(element) || [];
        queued.push([name, oldValue, newValue, namespace]);
        queuedAttributeChanges.set(element, queued);
        return true;
      };
      const observedCustomElementAttribute = (
        element: any,
        name: string,
        customElementConstructor: any,
      ): boolean => {
        if (!customElementConstructor) return false;
        return Boolean(
          observedAttributes.get(customElementConstructor)?.has(name) &&
          customElementConstructor.prototype.isPrototypeOf(element) &&
          !failedElements.has(element),
        );
      };
      const isConnectedCustomElementRoot = (rootElement: any): boolean => {
        return Boolean(rootElement && rootElement.nodeType === 1 && rootElement.isConnected);
      };
      const notifyConnectedCustomElement = (element: any, tagName: string): void => {
        const customElementConstructor = registry.get(tagName);
        if (
          typeof customElementConstructor === "function" &&
          !customElementConstructor.prototype.isPrototypeOf(element)
        ) {
          upgradeCustomElement(element, customElementConstructor, {
            tagName,
            fireConnectedCallback: true,
          });
        } else if (typeof element.connectedCallback === "function") {
          try {
            element.connectedCallback();
          } catch (error) {
            console.warn("[kitesurf] connectedCallback for " + tagName + " threw", error);
          }
        }
      };
      const visitConnectedChildren = (
        element: any,
        depth: number,
        visit: (child: any, depth: number) => void,
      ): void => {
        const children = element.children;
        if (children && children.length) {
          for (const child of Array.from(children)) visit(child, depth + 1);
        }
      };
      const visitConnectedCustomElement = (element: any, depth: number): void => {
        if (depth > MAX_CUSTOM_ELEMENT_CONNECTION_DEPTH) return;
        const tagName = String(element.localName || "");
        if (tagName.indexOf("-") >= 0 && registry.has(tagName)) {
          notifyConnectedCustomElement(element, tagName);
        }
        visitConnectedChildren(element, depth, visitConnectedCustomElement);
      };
      const appendMatchingCustomElements = (root: any, tagName: string, elements: any[]): void => {
        for (const element of root.querySelectorAll(tagName)) elements.push(element);
      };
      const visitCustomElementShadowRoots = (root: any, visit: (shadowRoot: any) => void): void => {
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      };
      const visitCustomElementRootSafely = (
        root: any,
        tagName: string,
        depth: number,
        elements: any[],
      ): void => {
        if (depth > MAX_CUSTOM_ELEMENT_SHADOW_DEPTH || !root?.querySelectorAll) return;
        try {
          appendMatchingCustomElements(root, tagName, elements);
          visitCustomElementShadowRoots(root, (shadowRoot) =>
            visitCustomElementRootSafely(shadowRoot, tagName, depth + 1, elements),
          );
        } catch {}
      };
      const addObservedAttributeNames = (
        names: Set<string>,
        attributes: Iterable<unknown>,
      ): void => {
        for (const attribute of attributes) names.add(String(attribute));
      };
      const observedAttributesForConstructor = (customElementConstructor: any): Set<string> => {
        const names = new Set<string>();
        if (typeof customElementConstructor?.prototype?.attributeChangedCallback !== "function") {
          return names;
        }
        addObservedAttributeNames(
          names,
          Array.from(customElementConstructor.observedAttributes || []),
        );
        attributeChangedCallbacks.set(
          customElementConstructor,
          customElementConstructor.prototype.attributeChangedCallback,
        );
        return names;
      };
      const resolveWhenDefined = (tagName: string, customElementConstructor: any): void => {
        const resolvers = whenDefinedResolvers.get(tagName);
        if (!resolvers) return;
        resolvers.forEach((resolve) => resolve(customElementConstructor));
        whenDefinedResolvers.delete(tagName);
      };
      const registerCustomElement = (tagName: string, customElementConstructor: any): void => {
        if (registry.has(tagName)) return;
        const observedAttributeNames = observedAttributesForConstructor(customElementConstructor);
        registry.set(tagName, customElementConstructor);
        observedAttributes.set(customElementConstructor, observedAttributeNames);
        try {
          ksGlobal.__ks_ctorTagNames.set(customElementConstructor, String(tagName));
        } catch {}
        pendingUpgrades.push({ tagName, customElementConstructor });
        resolveWhenDefined(tagName, customElementConstructor);
      };
      const customElementUpgradeTagName = (options: { tagName?: string }): string => {
        return options.tagName ?? "?";
      };
      const upgradeCustomElement = (
        element: any,
        customElementConstructor: any,
        options: { tagName?: string; fireConnectedCallback?: boolean } = {},
      ): void => {
        const tagName = customElementUpgradeTagName(options);
        try {
          if (customElementPrototypeMatches(customElementConstructor, element)) return;
          const initialAttributes = snapshotCustomElementAttributes(element);
          Object.setPrototypeOf(element, customElementConstructor.prototype);
          upgradingElements.add(element);
          const constructed = constructCustomElement(element, customElementConstructor, tagName);
          upgradingElements.delete(element);
          if (!constructed) {
            recordCustomElementUpgradeFailure(element);
            return;
          }
          notifyAttributeChangesOnUpgrade(
            element,
            customElementConstructor,
            initialAttributes,
            tagName,
          );
          queuedAttributeChanges.delete(element);
          notifyConnectedCallbackOnUpgrade(element, options, tagName);
        } catch (error) {
          console.warn("[kitesurf] custom element upgrade failed for " + tagName, error);
        }
      };
      ksGlobal.__ks_upgradeCustomElement = (element: any, tagName: string): void => {
        const customElementConstructor = registry.get(tagName);
        if (typeof customElementConstructor !== "function") return;
        upgradeCustomElement(element, customElementConstructor, {
          tagName,
          fireConnectedCallback: false,
        });
      };
      const customElementTagName = (element: any): string => String(element?.localName || "");
      const customElementAttributeChangeContext = (element: any) => {
        const tagName = customElementTagName(element);
        const customElementConstructor = registry.get(tagName);
        return {
          tagName,
          customElementConstructor,
          observed: customElementConstructor && observedAttributes.get(customElementConstructor),
          attributeChanged:
            customElementConstructor && attributeChangedCallbacks.get(customElementConstructor),
        };
      };
      const notifyCustomElementAttributeChange = (
        element: any,
        name: string,
        oldValue: string | null,
        newValue: string | null,
        namespace: string | null,
      ): void => {
        const context = customElementAttributeChangeContext(element);
        if (
          !canNotifyCustomElementAttributeChange(
            element,
            name,
            context.customElementConstructor,
            context.observed,
          )
        )
          return;
        if (!context.attributeChanged) return;
        if (queueCustomElementAttributeChange(element, name, oldValue, newValue, namespace)) return;
        invokeAttributeChanged(
          context.attributeChanged,
          element,
          [name, oldValue, newValue, namespace],
          context.tagName,
        );
      };
      ksGlobal.__ks_notifyCustomElementAttributeChanged = (
        element: any,
        name: string,
        oldValue: string | null,
        newValue: string | null,
        namespace: string | null,
      ): void => {
        notifyCustomElementAttributeChange(element, name, oldValue, newValue, namespace);
      };
      ksGlobal.__ks_customElementObservesAttribute = (element: any, name: string): boolean => {
        const customElementConstructor = registry.get(customElementTagName(element));
        return observedCustomElementAttribute(element, name, customElementConstructor);
      };
      const MAX_CUSTOM_ELEMENT_SHADOW_DEPTH = 16;
      const MAX_CUSTOM_ELEMENT_CONNECTION_DEPTH = 64;
      const pendingUpgrades: Array<{
        tagName: string;
        customElementConstructor: any;
      }> = [];
      const collectCustomElements = (tagName: string): any[] => {
        const elements: any[] = [];
        visitCustomElementRootSafely(document, tagName, 0, elements);
        return elements;
      };
      const drainUpgrades = () => {
        if (pendingUpgrades.length === 0) return;
        const upgradesToDrain = pendingUpgrades.splice(0, pendingUpgrades.length);
        for (const pendingUpgrade of upgradesToDrain) {
          const { tagName, customElementConstructor } = pendingUpgrade;
          for (const element of collectCustomElements(tagName)) {
            upgradeCustomElement(element, customElementConstructor, {
              tagName,
              fireConnectedCallback: true,
            });
          }
        }
      };
      ksGlobal.__ks_drainCustomElementUpgrades = drainUpgrades;
      ksGlobal.__ks_notifyConnected = (rootElement: any) => {
        try {
          if (registry.size === 0 || !isConnectedCustomElementRoot(rootElement)) return;
          visitConnectedCustomElement(rootElement, 0);
        } catch {}
      };
      globalThis.customElements = {
        define(tagName, customElementConstructor) {
          registerCustomElement(tagName, customElementConstructor);
        },
        get(tagName) {
          return registry.get(tagName);
        },
        whenDefined(tagName) {
          if (registry.has(tagName)) return Promise.resolve(registry.get(tagName));
          return new Promise((resolve) => {
            const resolvers = whenDefinedResolvers.get(tagName) || [];
            resolvers.push(resolve);
            whenDefinedResolvers.set(tagName, resolvers);
          });
        },
        upgrade() {
          drainUpgrades();
        },
        polyfillWrapFlushCallback() {},
      };
    }
  };
  installCustomElementsGlobal();

  installIdleCallbackGlobals();

  const installStorageGlobal = function installStorageGlobal(): void {
    if (typeof globalThis.localStorage !== "object") {
      const makeStorage = () => {
        const data = Object.create(null);
        const api = {
          getItem(key) {
            return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
          },
          setItem(key, value) {
            data[String(key)] = String(value);
          },
          removeItem(key) {
            delete data[key];
          },
          clear() {
            for (const key of Object.keys(data)) delete data[key];
          },
          key(index) {
            const keys = Object.keys(data);
            return index >= 0 && index < keys.length ? keys[index] : null;
          },
          get length() {
            return Object.keys(data).length;
          },
        };
        return api;
      };
      globalThis.localStorage = makeStorage();
      globalThis.sessionStorage = makeStorage();
    }
  };
  installStorageGlobal();

  const installRtcGlobals = function installRtcGlobals(): void {
    const readRtcInitField = (init: unknown, field: string): unknown => {
      if (!init) return undefined;
      return Reflect.get(Object(init), field);
    };
    const rtcInitOrDefault = (init: unknown, field: string, fallback: unknown): unknown => {
      return readRtcInitField(init, field) || fallback;
    };
    const rtcInitNullishDefault = (init: unknown, field: string): unknown => {
      return readRtcInitField(init, field) ?? null;
    };
    if (typeof globalThis.RTCPeerConnection !== "function") {
      const installRtcErrorEvent = function installRtcErrorEvent(): void {
        if (typeof globalThis.RTCErrorEvent !== "function") {
          globalThis.RTCErrorEvent = class extends Event {
            declare error: any;
            constructor(type, init) {
              super(type, init);
              this.error = (init && init.error) || null;
            }
          };
        }
      };
      const installRtcIceEvent = function installRtcIceEvent(): void {
        if (typeof globalThis.RTCPeerConnectionIceEvent !== "function") {
          globalThis.RTCPeerConnectionIceEvent = class extends Event {
            declare candidate: any;
            declare url: any;
            constructor(type, init) {
              super(type, init);
              this.candidate = (init && init.candidate) || null;
              this.url = (init && init.url) || null;
            }
          };
        }
      };
      const installRtcDataChannelEvent = function installRtcDataChannelEvent(): void {
        if (typeof globalThis.RTCDataChannelEvent !== "function") {
          globalThis.RTCDataChannelEvent = class extends Event {
            declare channel: any;
            constructor(type, init) {
              super(type, init);
              this.channel = (init && init.channel) || null;
            }
          };
        }
      };
      const installRtcTrackEvent = function installRtcTrackEvent(): void {
        if (typeof globalThis.RTCTrackEvent !== "function") {
          globalThis.RTCTrackEvent = class extends Event {
            declare receiver: any;
            declare streams: any;
            declare track: any;
            declare transceiver: any;
            constructor(type, init) {
              super(type, init);
              this.receiver = rtcInitOrDefault(init, "receiver", null);
              this.track = rtcInitOrDefault(init, "track", null);
              this.streams = rtcInitOrDefault(init, "streams", []);
              this.transceiver = rtcInitOrDefault(init, "transceiver", null);
            }
          };
        }
      };
      const initializePeerConnectionStub = (
        peerConnection: RTCPeerConnectionStub,
        configuration: unknown,
      ): void => {
        peerConnection._config = configuration || {};
        peerConnection._localDescription = null;
        peerConnection._remoteDescription = null;
        peerConnection._tracks = [];
        peerConnection._iceCandidates = [];
        peerConnection._dataChannels = [];
        peerConnection.connectionState = "new";
        peerConnection.iceConnectionState = "new";
        peerConnection.iceGatheringState = "new";
        peerConnection.signalingState = "stable";
        peerConnection.canTrickleIceCandidates = null;
        peerConnection.sctp = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.oniceconnectionstatechange = null;
        peerConnection.onicegatheringstatechange = null;
        peerConnection.onsignalingstatechange = null;
        peerConnection.onicecandidate = null;
        peerConnection.onicecandidateerror = null;
        peerConnection.onnegotiationneeded = null;
        peerConnection.ontrack = null;
        peerConnection.ondatachannel = null;
      };
      const schedulePeerConnectionStubStateChanges = (
        peerConnection: RTCPeerConnectionStub,
      ): void => {
        try {
          setTimeout(() => {
            peerConnection._setConnectionState("connecting");
            setTimeout(() => peerConnection._setConnectionState("failed"), 0);
          }, 0);
        } catch {}
      };
      const dispatchPeerConnectionHandler = (peerConnection, name, event): void => {
        const handler = peerConnection[name];
        if (typeof handler !== "function") return;
        try {
          handler.call(peerConnection, event || new Event(name.slice(2)));
        } catch {}
      };
      const peerConnectionListeners = (peerConnection, name) => {
        return peerConnection._listeners && peerConnection._listeners[name.slice(2)];
      };
      const dispatchPeerConnectionListeners = (peerConnection, name, event): void => {
        const listeners = peerConnectionListeners(peerConnection, name);
        if (!Array.isArray(listeners)) return;
        for (const listener of listeners) {
          try {
            listener.call(peerConnection, event || new Event(name.slice(2)));
          } catch {}
        }
      };
      class RTCPeerConnectionStub {
        declare _config: any;
        declare _dataChannels: any;
        declare _iceCandidates: any;
        declare _listeners: any;
        declare _localDescription: any;
        declare _remoteDescription: any;
        declare _tracks: any;
        declare canTrickleIceCandidates: any;
        declare connectionState: any;
        declare iceConnectionState: any;
        declare iceGatheringState: any;
        declare onconnectionstatechange: any;
        declare ondatachannel: any;
        declare onicecandidate: any;
        declare onicecandidateerror: any;
        declare oniceconnectionstatechange: any;
        declare onicegatheringstatechange: any;
        declare onnegotiationneeded: any;
        declare onsignalingstatechange: any;
        declare ontrack: any;
        declare sctp: any;
        declare signalingState: any;
        constructor(configuration) {
          initializePeerConnectionStub(this, configuration);
          schedulePeerConnectionStubStateChanges(this);
        }
        _fire(name, event?) {
          dispatchPeerConnectionHandler(this, name, event);
          dispatchPeerConnectionListeners(this, name, event);
        }
        _setConnectionState(connectionState) {
          if (this.connectionState === connectionState) return;
          this.connectionState = connectionState;
          if (connectionState === "connecting") this.iceConnectionState = "checking";
          else if (connectionState === "failed") this.iceConnectionState = "failed";
          else if (connectionState === "closed") this.iceConnectionState = "closed";
          this._fire("onconnectionstatechange");
          this._fire("oniceconnectionstatechange");
        }
        addEventListener(type, listener) {
          if (typeof listener !== "function") return;
          this._listeners ||= {};
          this._listeners[type] ||= [];
          this._listeners[type].push(listener);
        }
        removeEventListener(type, listener) {
          if (!this._listeners || !this._listeners[type]) return;
          this._listeners[type] = this._listeners[type].filter(
            (registeredListener) => registeredListener !== listener,
          );
        }
        dispatchEvent() {
          return false;
        }
        async setRemoteDescription(description) {
          this._remoteDescription = description;
          this.signalingState =
            description && description.type === "offer" ? "have-remote-offer" : "stable";
          this._fire("onsignalingstatechange");
        }
        async setLocalDescription(description) {
          this._localDescription = description || { type: "answer", sdp: "" };
          this.signalingState = "stable";
          this._fire("onsignalingstatechange");
        }
        async createOffer(_opts) {
          return { type: "offer", sdp: "" };
        }
        async createAnswer(_opts) {
          return { type: "answer", sdp: "" };
        }
        async addIceCandidate(_candidate) {}
        addTrack(track, _stream) {
          return {
            track: track || null,
            replaceTrack: async (_t) => {},
            getStats: async () => new Map(),
            getParameters: () => ({ encodings: [] }),
            setParameters: async (_p) => {},
          };
        }
        removeTrack(_sender) {}
        addTransceiver(_kindOrTrack, _init) {
          return {
            mid: null,
            sender: { track: null, replaceTrack: async () => {} },
            receiver: { track: null, getStats: async () => new Map() },
            direction: "sendrecv",
            currentDirection: null,
            stop() {},
          };
        }
        getTransceivers() {
          return [];
        }
        getSenders() {
          return [];
        }
        getReceivers() {
          return [];
        }
        async getStats() {
          return new Map();
        }
        getConfiguration() {
          return this._config;
        }
        setConfiguration(configuration) {
          this._config = configuration || {};
        }
        createDataChannel(label, _opts) {
          const channel = new RTCDataChannelStub(label);
          this._dataChannels.push(channel);
          return channel;
        }
        close() {
          this._setConnectionState("closed");
          this.signalingState = "closed";
          this._fire("onsignalingstatechange");
        }
        get localDescription() {
          return this._localDescription;
        }
        get remoteDescription() {
          return this._remoteDescription;
        }
        get currentLocalDescription() {
          return this._localDescription;
        }
        get currentRemoteDescription() {
          return this._remoteDescription;
        }
        get pendingLocalDescription() {
          return null;
        }
        get pendingRemoteDescription() {
          return null;
        }
      }

      class RTCDataChannelStub {
        declare binaryType: any;
        declare bufferedAmount: any;
        declare id: any;
        declare label: any;
        declare maxPacketLifeTime: any;
        declare maxRetransmits: any;
        declare negotiated: any;
        declare onbufferedamountlow: any;
        declare onclose: any;
        declare onerror: any;
        declare onmessage: any;
        declare onopen: any;
        declare ordered: any;
        declare protocol: any;
        declare readyState: any;
        constructor(label) {
          this.label = String(label || "");
          this.readyState = "connecting";
          this.bufferedAmount = 0;
          this.binaryType = "blob";
          this.protocol = "";
          this.id = null;
          this.maxPacketLifeTime = null;
          this.maxRetransmits = null;
          this.negotiated = false;
          this.ordered = true;
          this.onopen = null;
          this.onclose = null;
          this.onerror = null;
          this.onmessage = null;
          this.onbufferedamountlow = null;
          try {
            setTimeout(() => {
              this.readyState = "open";
              if (typeof this.onopen === "function") {
                try {
                  this.onopen(new Event("open"));
                } catch {}
              }
            }, 0);
          } catch {}
        }
        send(_data) {
          if (this.readyState !== "open") {
            throw new DOMException("RTCDataChannel.send: channel is not open", "InvalidStateError");
          }
        }
        close() {
          this.readyState = "closed";
          if (typeof this.onclose === "function") {
            try {
              this.onclose(new Event("close"));
            } catch {}
          }
        }
        addEventListener() {}
        removeEventListener() {}
        dispatchEvent() {
          return false;
        }
      }

      class RTCSessionDescriptionStub {
        declare sdp: any;
        declare type: any;
        constructor(init) {
          this.type = (init && init.type) || "offer";
          this.sdp = (init && init.sdp) || "";
        }
        toJSON() {
          return { type: this.type, sdp: this.sdp };
        }
      }
      const assignIceCandidateIdentity = (candidate: RTCIceCandidateStub, init: unknown): void => {
        candidate.candidate = rtcInitOrDefault(init, "candidate", "");
        candidate.sdpMid = rtcInitOrDefault(init, "sdpMid", null);
        candidate.sdpMLineIndex = rtcInitNullishDefault(init, "sdpMLineIndex");
        candidate.foundation = rtcInitOrDefault(init, "foundation", "");
      };
      const assignIceCandidateNetworkFields = (
        candidate: RTCIceCandidateStub,
        init: unknown,
      ): void => {
        candidate.component = rtcInitOrDefault(init, "component", null);
        candidate.priority = rtcInitOrDefault(init, "priority", 0);
        candidate.address = rtcInitOrDefault(init, "address", null);
        candidate.protocol = rtcInitOrDefault(init, "protocol", null);
      };
      const assignIceCandidateTransportFields = (
        candidate: RTCIceCandidateStub,
        init: unknown,
      ): void => {
        candidate.port = rtcInitOrDefault(init, "port", 0);
        candidate.type = rtcInitOrDefault(init, "type", null);
        candidate.tcpType = rtcInitOrDefault(init, "tcpType", null);
        candidate.relatedAddress = rtcInitOrDefault(init, "relatedAddress", null);
      };
      const assignIceCandidateRelatedFields = (
        candidate: RTCIceCandidateStub,
        init: unknown,
      ): void => {
        candidate.relatedPort = rtcInitOrDefault(init, "relatedPort", 0);
        candidate.usernameFragment = rtcInitOrDefault(init, "usernameFragment", null);
      };
      const initializeIceCandidate = (candidate: RTCIceCandidateStub, init: unknown): void => {
        assignIceCandidateIdentity(candidate, init);
        assignIceCandidateNetworkFields(candidate, init);
        assignIceCandidateTransportFields(candidate, init);
        assignIceCandidateRelatedFields(candidate, init);
      };
      const initializeRtcErrorStub = (rtcError: RTCErrorStub, init: unknown): void => {
        rtcError.errorDetail = rtcInitOrDefault(init, "errorDetail", "");
        rtcError.sdpLineNumber = rtcInitNullishDefault(init, "sdpLineNumber");
        rtcError.httpRequestStatusCode = rtcInitNullishDefault(init, "httpRequestStatusCode");
        rtcError.sctpCauseCode = rtcInitNullishDefault(init, "sctpCauseCode");
        rtcError.receivedAlert = rtcInitNullishDefault(init, "receivedAlert");
        rtcError.sentAlert = rtcInitNullishDefault(init, "sentAlert");
      };
      class RTCIceCandidateStub {
        declare address: any;
        declare candidate: any;
        declare component: any;
        declare foundation: any;
        declare port: any;
        declare priority: any;
        declare protocol: any;
        declare relatedAddress: any;
        declare relatedPort: any;
        declare sdpMid: any;
        declare sdpMLineIndex: any;
        declare tcpType: any;
        declare type: any;
        declare usernameFragment: any;
        constructor(init) {
          initializeIceCandidate(this, init);
        }
        toJSON() {
          return {
            candidate: this.candidate,
            sdpMid: this.sdpMid,
            sdpMLineIndex: this.sdpMLineIndex,
            usernameFragment: this.usernameFragment,
          };
        }
      }
      class RTCErrorStub extends Error {
        declare errorDetail: any;
        declare httpRequestStatusCode: any;
        declare receivedAlert: any;
        declare sctpCauseCode: any;
        declare sdpLineNumber: any;
        declare sentAlert: any;
        constructor(init, message) {
          super(message || "RTCError");
          this.name = "RTCError";
          initializeRtcErrorStub(this, init);
        }
      }

      globalThis.RTCPeerConnection = RTCPeerConnectionStub;
      globalThis.webkitRTCPeerConnection = RTCPeerConnectionStub;
      globalThis.mozRTCPeerConnection = RTCPeerConnectionStub;
      globalThis.RTCDataChannel = RTCDataChannelStub;
      globalThis.RTCSessionDescription = RTCSessionDescriptionStub;
      globalThis.RTCIceCandidate = RTCIceCandidateStub;
      globalThis.RTCError = RTCErrorStub;
      installRtcErrorEvent();
      installRtcIceEvent();
      installRtcDataChannelEvent();
      installRtcTrackEvent();
    }
  };
  installRtcGlobals();

  const installMediaStreamGlobals = function installMediaStreamGlobals(): void {
    if (typeof globalThis.MediaStream !== "function") {
      class MediaStreamTrackStub {
        declare contentHint: any;
        declare enabled: any;
        declare id: any;
        declare kind: any;
        declare label: any;
        declare muted: any;
        declare onended: any;
        declare onmute: any;
        declare onunmute: any;
        declare readyState: any;
        constructor(kind) {
          this.kind = kind || "video";
          this.id = "mst-" + Math.random().toString(36).slice(2);
          this.label = "";
          this.enabled = true;
          this.muted = true;
          this.readyState = "live";
          this.contentHint = "";
          this.onended = null;
          this.onmute = null;
          this.onunmute = null;
        }
        stop() {
          this.readyState = "ended";
          if (typeof this.onended === "function") {
            try {
              this.onended(new Event("ended"));
            } catch {}
          }
        }
        clone() {
          return new MediaStreamTrackStub(this.kind);
        }
        getSettings() {
          return {};
        }
        getCapabilities() {
          return {};
        }
        getConstraints() {
          return {};
        }
        async applyConstraints(_c) {}
        addEventListener() {}
        removeEventListener() {}
        dispatchEvent() {
          return false;
        }
      }
      const includeTruthyMediaStreamTracks = (tracks: any[]): any[] => {
        const included: any[] = [];
        for (const track of tracks) {
          if (track) included.push(track);
        }
        return included;
      };
      const cloneMediaStreamSourceTracks = (source): any[] => {
        const clones: any[] = [];
        for (const track of source.getTracks()) clones.push(track.clone());
        return clones;
      };
      const initialMediaStreamTracks = (initOrTracks): any[] => {
        if (Array.isArray(initOrTracks)) return includeTruthyMediaStreamTracks(initOrTracks);
        if (initOrTracks && typeof initOrTracks.getTracks === "function") {
          return cloneMediaStreamSourceTracks(initOrTracks);
        }
        return [];
      };
      class MediaStreamStub {
        declare _tracks: any;
        declare active: any;
        declare id: any;
        declare onaddtrack: any;
        declare onremovetrack: any;
        constructor(initOrTracks) {
          this.id = "ms-" + Math.random().toString(36).slice(2);
          this.active = true;
          this.onaddtrack = null;
          this.onremovetrack = null;
          this._tracks = initialMediaStreamTracks(initOrTracks);
        }
        getTracks() {
          return this._tracks.slice();
        }
        getAudioTracks() {
          return this._tracks.filter((track) => track.kind === "audio");
        }
        getVideoTracks() {
          return this._tracks.filter((track) => track.kind === "video");
        }
        getTrackById(id) {
          return this._tracks.find((track) => track.id === id) || null;
        }
        addTrack(track) {
          if (track && this._tracks.indexOf(track) < 0) this._tracks.push(track);
        }
        removeTrack(track) {
          this._tracks = this._tracks.filter((currentTrack) => currentTrack !== track);
        }
        clone() {
          const cloned = this._tracks.map((track) => track.clone());
          return new MediaStreamStub(cloned);
        }
        addEventListener() {}
        removeEventListener() {}
        dispatchEvent() {
          return false;
        }
      }
      globalThis.MediaStream = MediaStreamStub;
      globalThis.MediaStreamTrack = MediaStreamTrackStub;
      globalThis.webkitMediaStream = MediaStreamStub;
    }
  };
  installMediaStreamGlobals();

  const installNavigatorMediaDevices = function installNavigatorMediaDevices(): void {
    try {
      const nav: PageNavigator | null | undefined = ksGlobal.navigator;
      if (nav && !nav.mediaDevices) {
        const mediaDevices = {
          async getUserMedia(_constraints) {
            throw new DOMException(
              "Permission denied: kitesurf has no media devices",
              "NotAllowedError",
            );
          },
          async getDisplayMedia(_constraints) {
            throw new DOMException(
              "Permission denied: kitesurf has no display capture",
              "NotAllowedError",
            );
          },
          async enumerateDevices() {
            return [];
          },
          getSupportedConstraints() {
            return {};
          },
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return false;
          },
          ondevicechange: null,
        };
        defineOrAssignFallback(nav, "mediaDevices", {
          value: mediaDevices,
          writable: false,
          configurable: true,
          enumerable: true,
        });
      }
    } catch {}
  };
  installNavigatorMediaDevices();

  const installNavigatorUserAgentData = function installNavigatorUserAgentData(): void {
    const userAgentDataContext = (navigator: PageNavigator | null | undefined) => {
      const ua = typeof navigator?.userAgent === "string" ? navigator.userAgent : "";
      const chromeMajor = /\bChrome\/(\d+)/.exec(ua)?.[1];
      return { ua, chromeMajor };
    };
    const highEntropyUserAgentValues = (
      userAgentData: { brands: unknown; mobile: unknown; platform: unknown },
      hints: unknown,
      fullVersion: string,
      arm: boolean,
    ): Record<string, unknown> => {
      const full: Record<string, unknown> = {
        brands: userAgentData.brands,
        mobile: userAgentData.mobile,
        platform: userAgentData.platform,
        platformVersion: "",
        architecture: arm ? "arm" : "x86",
        bitness: "64",
        model: "",
        uaFullVersion: fullVersion,
        fullVersionList: [
          { brand: "Chromium", version: fullVersion },
          { brand: "Not?A_Brand", version: "24.0.0.0" },
        ],
        wow64: false,
        formFactors: [],
      };
      const output: Record<string, unknown> = {
        brands: userAgentData.brands,
        mobile: userAgentData.mobile,
        platform: userAgentData.platform,
      };
      if (Array.isArray(hints)) {
        for (const hint of hints) {
          if (hint in full) output[hint] = full[hint];
        }
      }
      return output;
    };
    const createUserAgentData = (navigator: PageNavigator, ua: string, chromeMajor: string) => {
      const platform = userAgentPlatform(ua);
      const mobile = /\bMobile\b/.test(ua);
      const arm = /\b(arm|aarch64)/i.test(ua);
      const fullVersion = /\bChrome\/([\d.]+)/.exec(ua)?.[1] ?? `${chromeMajor}.0.0.0`;
      return {
        brands: [
          { brand: "Chromium", version: chromeMajor },
          { brand: "Not?A_Brand", version: "24" },
        ],
        mobile,
        platform,
        async getHighEntropyValues(hints: unknown) {
          return highEntropyUserAgentValues(this, hints, fullVersion, arm);
        },
        toJSON() {
          return { brands: this.brands, mobile: this.mobile, platform: this.platform };
        },
      };
    };
    try {
      const navigator: PageNavigator | null | undefined = ksGlobal.navigator;
      // User-Agent Client Hints only exist in Chromium, and must agree with the UA string.
      const { ua, chromeMajor } = userAgentDataContext(navigator);
      if (!navigator || navigator.userAgentData || !chromeMajor) return;
      const userAgentData = createUserAgentData(navigator, ua, chromeMajor);
      defineOrAssignFallback(navigator, "userAgentData", {
        value: userAgentData,
        writable: false,
        configurable: true,
        enumerable: true,
      });
    } catch {}
  };
  installNavigatorUserAgentData();

  const installNavigatorWebdriver = function installNavigatorWebdriver(): void {
    try {
      const nav: PageNavigator | null | undefined = ksGlobal.navigator;
      if (nav && nav.webdriver !== true) {
        defineOrAssignFallback(nav, "webdriver", {
          value: true,
          configurable: true,
          enumerable: true,
        });
      }
    } catch {}
  };
  installNavigatorWebdriver();

  const installBuiltElementGlobals = function installBuiltElementGlobals(): void {
    const installHtmlDiscriminatorClasses = function installHtmlDiscriminatorClasses(): void {
      const HTML_DISCRIMINATOR_TAGS = [
        "IFrame",
        "Form",
        "Anchor",
        "Input",
        "TextArea",
        "Select",
        "Button",
        "Option",
        "Label",
        "Canvas",
        "Video",
        "Audio",
        "Script",
        "Style",
        "Link",
        "Meta",
        "Object",
        "Embed",
        "Template",
        "Dialog",
      ];
      for (const tag of HTML_DISCRIMINATOR_TAGS) {
        const name = "HTML" + tag + "Element";
        if (typeof globalThis[name] !== "function") {
          const klass = class {};
          Reflect.defineProperty(klass, "name", { value: name, configurable: true });
          globalThis[name] = klass;
        }
      }
    };
    const installHtmlAliasClasses = function installHtmlAliasClasses(
      ElementBase: NonNullable<typeof built.Element>,
    ): void {
      const HTML_ALIAS_TAGS = [
        "Div",
        "Span",
        "Image",
        "Heading",
        "Paragraph",
        "List",
        "LI",
        "UList",
        "OList",
        "Table",
        "TableRow",
        "TableCell",
        "TableCaption",
        "TableSection",
        "TableCol",
        "Head",
        "Body",
        "Html",
        "Title",
        "BR",
        "HR",
        "Source",
        "Track",
        "Picture",
        "Slot",
        "Pre",
        "Code",
        "Quote",
        "Details",
        "Summary",
        "Map",
        "Area",
        "Param",
        "FieldSet",
        "Legend",
        "DataList",
        "Output",
        "Progress",
        "Meter",
        "Time",
        "Data",
        "Mod",
        "Menu",
        "Unknown",
      ];
      for (const tag of HTML_ALIAS_TAGS) {
        const name = "HTML" + tag + "Element";
        if (typeof globalThis[name] !== "function") {
          globalThis[name] = ElementBase;
        }
      }
    };
    const installSvgElementFallbacks = function installSvgElementFallbacks(): void {
      if (typeof globalThis.SVGElement !== "function") {
        globalThis.SVGElement = class SVGElement {};
      }
      if (typeof globalThis.SVGSVGElement !== "function") {
        globalThis.SVGSVGElement = class SVGSVGElement {};
      }
    };
    if (built.Element) {
      installHtmlDiscriminatorClasses();
      installHtmlAliasClasses(built.Element);
      installSvgElementFallbacks();
    }
  };
  installBuiltElementGlobals();

  const installDomInterfaceGlobals = function installDomInterfaceGlobals(): void {
    const installShadowRootGlobal = function installShadowRootGlobal(): void {
      if (built && typeof built.ShadowRoot === "function") {
        globalThis.ShadowRoot = built.ShadowRoot;
      } else if (typeof globalThis.ShadowRoot !== "function") {
        globalThis.ShadowRoot = class {};
      }
    };
    const installNodeListGlobal = function installNodeListGlobal(): void {
      if (built && typeof built.NodeList === "function") {
        globalThis.NodeList = built.NodeList;
      } else if (typeof globalThis.NodeList !== "function") {
        globalThis.NodeList = class {};
      }
    };
    const installDocumentFragmentGlobal = function installDocumentFragmentGlobal(): void {
      if (built && typeof built.DocumentFragment === "function") {
        globalThis.DocumentFragment = built.DocumentFragment;
      } else if (typeof globalThis.DocumentFragment !== "function") {
        globalThis.DocumentFragment = class {};
      }
    };
    const installHtmlCollectionGlobal = function installHtmlCollectionGlobal(): void {
      if (built && typeof built.HTMLCollection === "function") {
        globalThis.HTMLCollection = built.HTMLCollection;
      } else if (typeof globalThis.HTMLCollection !== "function") {
        globalThis.HTMLCollection = class {};
      }
    };
    const installFormCollectionGlobals = function installFormCollectionGlobals(): void {
      if (built && typeof built.HTMLFormControlsCollection === "function") {
        globalThis.HTMLFormControlsCollection = built.HTMLFormControlsCollection;
      }
      // select.options uses this WebIDL collection constructor.
      if (built && typeof built.HTMLOptionsCollection === "function") {
        globalThis.HTMLOptionsCollection = built.HTMLOptionsCollection;
      }
    };
    const installRadioNodeListGlobal = function installRadioNodeListGlobal(): void {
      if (built && typeof built.RadioNodeList === "function") {
        globalThis.RadioNodeList = built.RadioNodeList;
      }
    };
    const installDomTokenListGlobal = function installDomTokenListGlobal(): void {
      if (built && typeof built.DOMTokenList === "function") {
        globalThis.DOMTokenList = built.DOMTokenList;
      } else if (typeof globalThis.DOMTokenList !== "function") {
        globalThis.DOMTokenList = class {};
      }
    };
    const installNamedNodeMapGlobal = function installNamedNodeMapGlobal(): void {
      if (built && typeof built.NamedNodeMap === "function") {
        globalThis.NamedNodeMap = built.NamedNodeMap;
      } else if (typeof globalThis.NamedNodeMap !== "function") {
        globalThis.NamedNodeMap = class {};
      }
    };
    const installAttrGlobal = function installAttrGlobal(): void {
      if (built && typeof built.Attr === "function") {
        globalThis.Attr = built.Attr;
      } else if (typeof globalThis.Attr !== "function") {
        globalThis.Attr = class {};
      }
    };
    const installDocumentGlobal = function installDocumentGlobal(): void {
      if (built && typeof built.Document === "function") {
        globalThis.Document = built.Document;
      } else if (typeof globalThis.Document !== "function") {
        globalThis.Document = class {};
      }
      if (typeof ksGlobal.HTMLDocument !== "function") {
        ksGlobal.HTMLDocument = globalThis.Document;
      }
    };
    const installXmlDocumentGlobal = function installXmlDocumentGlobal(): void {
      if (built && typeof built.XMLDocument === "function") {
        globalThis.XMLDocument = built.XMLDocument;
      } else if (typeof globalThis.XMLDocument !== "function") {
        globalThis.XMLDocument = class {};
      }
    };
    const installDocumentTypeGlobal = function installDocumentTypeGlobal(): void {
      if (built && typeof built.DocumentType === "function") {
        globalThis.DocumentType = built.DocumentType;
      } else if (typeof globalThis.DocumentType !== "function") {
        globalThis.DocumentType = class {};
      }
    };
    const installDomImplementationGlobal = function installDomImplementationGlobal(): void {
      if (built && typeof built.DOMImplementation === "function") {
        globalThis.DOMImplementation = built.DOMImplementation;
      } else if (typeof globalThis.DOMImplementation !== "function") {
        globalThis.DOMImplementation = class {};
      }
    };
    const installMutationObserverGlobal = function installMutationObserverGlobal(): void {
      if (built && typeof built.MutationObserver === "function") {
        globalThis.MutationObserver = built.MutationObserver;
      } else if (typeof globalThis.MutationObserver !== "function") {
        globalThis.MutationObserver = class {
          observe() {}
          disconnect() {}
          takeRecords() {
            return [];
          }
        };
      }
    };
    const installMutationRecordAndNodeFilterGlobals =
      function installMutationRecordAndNodeFilterGlobals(): void {
        if (built && typeof built.MutationRecord === "function") {
          globalThis.MutationRecord = built.MutationRecord;
        }
        if (built && built.NodeFilter) globalThis.NodeFilter = built.NodeFilter;
      };
    const installTreeTraversalGlobals = function installTreeTraversalGlobals(): void {
      if (built && typeof built.TreeWalker === "function") {
        globalThis.TreeWalker = built.TreeWalker;
      }
      if (built && typeof built.NodeIterator === "function") {
        globalThis.NodeIterator = built.NodeIterator;
      }
    };
    const installXPathGlobals = function installXPathGlobals(): void {
      for (const name of ["XPathResult", "XPathExpression", "XPathEvaluator"]) {
        const constructor: unknown = built ? Reflect.get(built, name) : undefined;
        if (typeof constructor === "function") ksGlobal[name] = constructor;
      }
    };

    installShadowRootGlobal();
    installNodeListGlobal();
    installDocumentFragmentGlobal();
    installHtmlCollectionGlobal();
    installFormCollectionGlobals();
    installRadioNodeListGlobal();
    installDomTokenListGlobal();
    installNamedNodeMapGlobal();
    installAttrGlobal();
    installDocumentGlobal();
    installXmlDocumentGlobal();
    installDocumentTypeGlobal();
    installDomImplementationGlobal();
    installMutationObserverGlobal();
    installMutationRecordAndNodeFilterGlobals();
    installTreeTraversalGlobals();
    installXPathGlobals();
  };
  installDomInterfaceGlobals();

  installBlobMimeTypeSerialization();
  try {
    installWebSocketFacade();
  } catch {}
  installWorker();
  const installXMLHttpRequestGlobal = function installXMLHttpRequestGlobal(): void {
    if (typeof globalThis.XMLHttpRequest !== "function") {
      const EventTargetConstructor: typeof EventTarget =
        (ksGlobal.EventTarget as typeof EventTarget | null | undefined) ??
        class {
          addEventListener() {}
          removeEventListener() {}
          dispatchEvent() {
            return true;
          }
        };
      const installXhrEventTargetGlobals = function installXhrEventTargetGlobals(): void {
        if (typeof globalThis.XMLHttpRequestEventTarget !== "function") {
          globalThis.XMLHttpRequestEventTarget = EventTargetConstructor;
        }
        if (typeof ksGlobal.XMLHttpRequestUpload !== "function") {
          ksGlobal.XMLHttpRequestUpload = EventTargetConstructor;
        }
      };
      const isForbiddenResponseHeader = (name: string): boolean => {
        const normalizedName = name.toLowerCase();
        return normalizedName === "set-cookie" || normalizedName === "set-cookie2";
      };
      const FORBIDDEN_REQ_HEADERS = new Set([
        "accept-charset",
        "accept-encoding",
        "access-control-request-headers",
        "access-control-request-method",
        "connection",
        "content-length",
        "cookie",
        "cookie2",
        "date",
        "dnt",
        "expect",
        "host",
        "keep-alive",
        "origin",
        "referer",
        "set-cookie",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "via",
      ]);
      const isForbiddenRequestHeader = (name: string): boolean => {
        const normalizedName = name.toLowerCase();
        if (FORBIDDEN_REQ_HEADERS.has(normalizedName)) return true;
        return normalizedName.startsWith("proxy-") || normalizedName.startsWith("sec-");
      };
      class XMLHttpRequestCls extends EventTargetConstructor {
        declare readyState: number;
        declare status: number;
        declare statusText: string;
        declare responseURL: string;
        declare timeout: number;
        declare withCredentials: boolean;
        declare upload: unknown;
        declare _responseType: string;
        declare _text: string;
        declare _buf: ArrayBuffer | null;
        declare _resHeaders: Headers | null;
        declare _reqHeaders: Array<[string, string]>;
        declare _sent: boolean;
        declare _async: boolean;
        declare _abortedFlag: boolean;
        declare _timedOut: boolean;
        declare _method: string;
        declare _url: string;
        declare _overrideMimeType: string;
        declare _gen: number;
        declare _ctrl: AbortController | null | undefined;
        declare _jsonCache: unknown;
        declare _blobCache: unknown;
        constructor() {
          super();
          this.readyState = 0;
          this.status = 0;
          this.statusText = "";
          this.responseURL = "";
          this.timeout = 0;
          this.withCredentials = false;
          this.upload = new EventTargetConstructor();
          this._responseType = "";
          this._text = "";
          this._buf = null;
          this._resHeaders = null;
          this._sent = false;
        }
        _fire(name) {
          const event = createXhrEvent(name);
          callXhrEventHandler(this, name, event);
          dispatchXhrEvent(this, event);
        }
        _rsc(state) {
          this.readyState = state;
          this._fire("readystatechange");
        }
        get responseType() {
          return this._responseType;
        }
        set responseType(v) {
          if (this.readyState === 3 || this.readyState === 4) {
            throw new ksGlobal.DOMException(
              "XMLHttpRequest.responseType: state is LOADING or DONE",
              "InvalidStateError",
            );
          }
          const allowed = ["", "arraybuffer", "blob", "document", "json", "text"];
          if (allowed.indexOf(v) !== -1) this._responseType = v;
        }
        get response() {
          return xhrResponse(this);
        }
        get responseText() {
          const responseType = this._responseType;
          if (responseType !== "" && responseType !== "text") {
            throw new ksGlobal.DOMException(
              "XMLHttpRequest.responseText: responseType is '" + responseType + "'",
              "InvalidStateError",
            );
          }
          return this._text;
        }
        get responseXML() {
          return null;
        }
        _mimeFor() {
          if (this._overrideMimeType) return this._overrideMimeType;
          const responseHeaders = this._resHeaders;
          try {
            return (responseHeaders && responseHeaders.get("content-type")) || "";
          } catch {
            return "";
          }
        }
        open(method, url, async_) {
          const requestMethod = normalizeXhrMethod(method);
          assertAllowedXhrMethod(requestMethod);
          const requestUrl = resolveXhrRequestUrl(url);
          resetXhrForOpen(this, requestMethod, requestUrl, async_);
        }
        setRequestHeader(name, value) {
          if (this.readyState !== 1 || this._sent) {
            throw new ksGlobal.DOMException(
              "XMLHttpRequest.setRequestHeader: state is not OPENED",
              "InvalidStateError",
            );
          }
          // SAFETY: SandboxOutbound also blocks forged UA-owned request headers.
          if (this._reqHeaders && !isForbiddenRequestHeader(String(name))) {
            this._reqHeaders.push([String(name), String(value)]);
          }
        }
        send(body) {
          assertXhrCanSend(this);
          if (ignoreUnsupportedSyncXhr(this)) return;
          this._sent = true;
          const gen = (this._gen = (this._gen | 0) + 1);
          const live = () => this._gen === gen;
          const url = this._url;
          const method = this._method || "GET";
          this._fire("loadstart");
          if (isBlobXhrUrl(url)) {
            void sendXhrBlobRequest(this, url, method, live);
            return;
          }
          startXhrNetworkRequest(this, url, method, body, live);
        }
        _wantsText() {
          const responseType = this._responseType;
          return responseType === "" || responseType === "text" || responseType === "json";
        }
        abort() {
          this._abortedFlag = true;
          this._gen = (this._gen | 0) + 1;
          try {
            this._ctrl?.abort();
          } catch {}
          if (this._sent && this.readyState !== 4) {
            this.readyState = 4;
            this._fire("readystatechange");
            this._fire("abort");
            this._fire("loadend");
          }
          this.readyState = 0;
          this._sent = false;
          this.status = 0;
        }
        overrideMimeType(mime) {
          if (this.readyState === 3 || this.readyState === 4) {
            throw new ksGlobal.DOMException(
              "XMLHttpRequest.overrideMimeType: state is LOADING or DONE",
              "InvalidStateError",
            );
          }
          (this as any)._overrideMimeType = String(mime == null ? "" : mime);
        }
        getResponseHeader(name) {
          const responseHeaders = this._resHeaders;
          if (!responseHeaders) return null;
          if (isForbiddenResponseHeader(String(name))) return null;
          try {
            return responseHeaders.get(String(name));
          } catch {
            return null;
          }
        }
        getAllResponseHeaders() {
          const responseHeaders = this._resHeaders;
          if (!responseHeaders) return "";
          let out = "";
          try {
            for (const [headerName, headerValue] of responseHeaders.entries()) {
              if (isForbiddenResponseHeader(headerName)) continue;
              out += headerName + ": " + headerValue + "\r\n";
            }
          } catch {}
          return out;
        }
      }
      const createXhrEvent = function createXhrEvent(name: string): Event | null {
        try {
          return new ksEventCtors.Event(name);
        } catch {
          return null;
        }
      };
      const callXhrEventHandler = function callXhrEventHandler(
        xhr: XMLHttpRequestCls,
        name: string,
        event: Event | null,
      ): void {
        const handler = (xhr as any)["on" + name];
        if (typeof handler !== "function") return;
        try {
          handler.call(xhr, event);
        } catch (error) {
          try {
            console.error("XHR on" + name + " threw:", error);
          } catch {}
        }
      };
      const dispatchXhrEvent = function dispatchXhrEvent(
        xhr: XMLHttpRequestCls,
        event: Event | null,
      ): void {
        if (!event) return;
        try {
          xhr.dispatchEvent(event);
        } catch {}
      };
      const cachedXhrBlobResponse = function cachedXhrBlobResponse(
        xhr: XMLHttpRequestCls,
      ): unknown {
        if (xhr._blobCache === undefined) {
          const BlobCtor = ksGlobal.Blob;
          xhr._blobCache =
            xhr._buf && typeof BlobCtor === "function"
              ? new BlobCtor([xhr._buf], { type: xhr._mimeFor() })
              : null;
        }
        return xhr._blobCache;
      };
      const cachedXhrJsonResponse = function cachedXhrJsonResponse(
        xhr: XMLHttpRequestCls,
      ): unknown {
        if (xhr._jsonCache === undefined) {
          try {
            xhr._jsonCache = JSON.parse(xhr._text);
          } catch {
            xhr._jsonCache = null;
          }
        }
        return xhr._jsonCache;
      };
      const xhrResponseForType = function xhrResponseForType(
        xhr: XMLHttpRequestCls,
        responseType: string,
      ): unknown {
        if (responseType === "arraybuffer") return xhr._buf;
        if (responseType === "blob") return cachedXhrBlobResponse(xhr);
        if (responseType === "json") return cachedXhrJsonResponse(xhr);
        return null;
      };
      const xhrResponse = function xhrResponse(xhr: XMLHttpRequestCls): unknown {
        const responseType = xhr._responseType;
        if (responseType === "" || responseType === "text") return xhr._text;
        if (xhr.readyState !== 4) return null;
        return xhrResponseForType(xhr, responseType);
      };
      const normalizeXhrMethod = function normalizeXhrMethod(method: unknown): string {
        return String(method == null ? "" : method).toUpperCase();
      };
      const assertAllowedXhrMethod = function assertAllowedXhrMethod(method: string): void {
        if (method === "CONNECT" || method === "TRACE" || method === "TRACK") {
          throw new ksGlobal.DOMException(
            "XMLHttpRequest.open: forbidden method " + method,
            "SecurityError",
          );
        }
      };
      const xhrUrlInput = (url: unknown): string =>
        url == null || url === "" ? "about:blank" : String(url);
      const isBlobXhrUrl = (url: string): boolean => Boolean(url && url.slice(0, 5) === "blob:");
      const resolveXhrRequestUrl = function resolveXhrRequestUrl(url: unknown): string {
        const raw = xhrUrlInput(url);
        let base: string | undefined;
        try {
          base = ksGlobal.document?.baseURI;
        } catch {}
        try {
          return new URL(raw, base).toString();
        } catch {
          throw new ksGlobal.DOMException(
            "XMLHttpRequest.open: '" + raw + "' is not a valid URL.",
            "SyntaxError",
          );
        }
      };
      const resetXhrForOpen = function resetXhrForOpen(
        xhr: XMLHttpRequestCls,
        method: string,
        url: string,
        async_: unknown,
      ): void {
        try {
          xhr._ctrl?.abort();
        } catch {}
        xhr._gen = (xhr._gen | 0) + 1;
        xhr._method = method;
        xhr._url = url;
        xhr._async = async_ !== false;
        xhr._reqHeaders = [];
        xhr._sent = false;
        xhr._abortedFlag = false;
        xhr._timedOut = false;
        xhr.status = 0;
        xhr.statusText = "";
        xhr._text = "";
        xhr._buf = null;
        xhr._resHeaders = null;
        xhr._blobCache = undefined;
        xhr._jsonCache = undefined;
        xhr._rsc(1);
      };
      const assertXhrCanSend = function assertXhrCanSend(xhr: XMLHttpRequestCls): void {
        if (xhr.readyState === 1 && !xhr._sent) return;
        throw new ksGlobal.DOMException(
          "XMLHttpRequest.send: state is not OPENED",
          "InvalidStateError",
        );
      };
      const ignoreUnsupportedSyncXhr = function ignoreUnsupportedSyncXhr(
        xhr: XMLHttpRequestCls,
      ): boolean {
        // workerd cannot block the JS thread; synchronous XHR has no supported network primitive.
        if (xhr._async) return false;
        xhr._sent = true;
        try {
          console.warn("[kitesurf] sync XHR is not supported; send() ignored");
        } catch {}
        return true;
      };
      const finishXhrRequestError = function finishXhrRequestError(
        xhr: XMLHttpRequestCls,
        live: () => boolean,
        kind: string,
      ): void {
        if (!live()) return;
        xhr.status = 0;
        xhr._rsc(4);
        xhr._fire(kind);
        xhr._fire("loadend");
      };
      const xhrBlobResponseText = async function xhrBlobResponseText(
        xhr: XMLHttpRequestCls,
        blob: Blob,
      ): Promise<string> {
        if (!xhr._wantsText()) return "";
        return blob.text();
      };
      const finishXhrBlobResponse = function finishXhrBlobResponse(
        xhr: XMLHttpRequestCls,
        blob: Blob,
        buffer: ArrayBuffer,
        text: string,
        url: string,
      ): void {
        xhr.status = 200;
        xhr.statusText = "OK";
        xhr.responseURL = url;
        xhr._resHeaders = new Headers({
          "content-type": blob.type || "",
          "content-length": String(blob.size ?? 0),
        });
        xhr._rsc(2);
        xhr._rsc(3);
        xhr._buf = buffer;
        xhr._text = text;
        xhr._rsc(4);
        xhr._fire("load");
        xhr._fire("loadend");
      };
      const readXhrBlobResponse = async function readXhrBlobResponse(
        xhr: XMLHttpRequestCls,
        blob: Blob,
        url: string,
        live: () => boolean,
      ): Promise<void> {
        try {
          const buffer = await blob.arrayBuffer();
          const text = await xhrBlobResponseText(xhr, blob);
          if (!live()) return;
          finishXhrBlobResponse(xhr, blob, buffer, text, url);
        } catch {
          finishXhrRequestError(xhr, live, "error");
        }
      };
      const sendXhrBlobRequest = async function sendXhrBlobRequest(
        xhr: XMLHttpRequestCls,
        url: string,
        method: string,
        live: () => boolean,
      ): Promise<void> {
        const blob = state.blobUrls.get(url);
        if (!blob || method !== "GET") {
          finishXhrRequestError(xhr, live, "error");
          return;
        }
        await readXhrBlobResponse(xhr, blob, url, live);
      };
      const createXhrAbortController = function createXhrAbortController(): AbortController | null {
        try {
          return new ksGlobal.AbortController();
        } catch {
          return null;
        }
      };
      const startXhrTimeout = function startXhrTimeout(
        xhr: XMLHttpRequestCls,
        controller: AbortController | null,
      ): number | null {
        if (!(xhr.timeout > 0 && controller)) return null;
        try {
          return setTimeout(() => {
            xhr._timedOut = true;
            try {
              controller.abort();
            } catch {}
          }, xhr.timeout);
        } catch {
          return null;
        }
      };
      const createXhrRequestHeaders = function createXhrRequestHeaders(
        xhr: XMLHttpRequestCls,
      ): Headers {
        const headers = new Headers();
        for (const [name, value] of xhr._reqHeaders || []) {
          try {
            headers.append(name, value);
          } catch {}
        }
        headers.set("x-kitesurf-credentials", xhr.withCredentials ? "include" : "same-origin");
        return headers;
      };
      const xhrRequestHasBody = (method: string, body: unknown): boolean =>
        method !== "GET" && method !== "HEAD" && body != null;
      const createXhrRequestInit = function createXhrRequestInit(
        xhr: XMLHttpRequestCls,
        method: string,
        body: unknown,
        controller: AbortController | null,
      ): RequestInit & { body?: any } {
        const init: RequestInit & { body?: any } = {
          method,
          headers: createXhrRequestHeaders(xhr),
        };
        if (xhrRequestHasBody(method, body)) init.body = body;
        if (controller) init.signal = controller.signal;
        return init;
      };
      const isXhrBinaryResponse = (xhr: XMLHttpRequestCls): boolean =>
        xhr._responseType === "arraybuffer" || xhr._responseType === "blob";
      const readXhrNetworkResponseBody = async function readXhrNetworkResponseBody(
        xhr: XMLHttpRequestCls,
        response: Response,
      ): Promise<{ kind: "binary"; buffer: ArrayBuffer } | { kind: "text"; text: string }> {
        if (isXhrBinaryResponse(xhr)) {
          return { kind: "binary", buffer: await response.arrayBuffer() };
        }
        const buffer = await response.arrayBuffer();
        return {
          kind: "text",
          text: xhrTextResponse(
            buffer,
            xhr._responseType,
            xhr._overrideMimeType,
            response.headers.get("content-type"),
          ),
        };
      };
      const finishXhrNetworkResponse = function finishXhrNetworkResponse(
        xhr: XMLHttpRequestCls,
        response: Response,
        body: { kind: "binary"; buffer: ArrayBuffer } | { kind: "text"; text: string },
        requestUrl: string,
      ): void {
        xhr.status = response.status;
        xhr.statusText = response.statusText || "";
        xhr.responseURL = response.url || requestUrl;
        xhr._resHeaders = response.headers;
        xhr._rsc(2);
        xhr._rsc(3);
        if (body.kind === "binary") xhr._buf = body.buffer;
        else xhr._text = body.text;
        xhr._rsc(4);
        xhr._fire("load");
        xhr._fire("loadend");
      };
      const clearXhrTimeout = (timer: number | null): void => {
        if (timer) clearTimeout(timer);
      };
      const finishXhrNetworkFailure = function finishXhrNetworkFailure(
        xhr: XMLHttpRequestCls,
        live: () => boolean,
      ): void {
        if (!live()) return;
        if (xhr._abortedFlag) return;
        finishXhrRequestError(xhr, live, xhr._timedOut ? "timeout" : "error");
      };
      const runXhrNetworkRequest = async function runXhrNetworkRequest(
        xhr: XMLHttpRequestCls,
        url: string,
        init: RequestInit,
        timer: number | null,
        live: () => boolean,
      ): Promise<void> {
        try {
          const response = await trustedFetch(url, init, {
            resourceType: "XHR",
            initiator: "script",
          });
          const responseBody = await readXhrNetworkResponseBody(xhr, response);
          clearXhrTimeout(timer);
          if (!live()) return;
          finishXhrNetworkResponse(xhr, response, responseBody, url);
        } catch {
          clearXhrTimeout(timer);
          finishXhrNetworkFailure(xhr, live);
        }
      };
      const startXhrNetworkRequest = function startXhrNetworkRequest(
        xhr: XMLHttpRequestCls,
        url: string,
        method: string,
        body: unknown,
        live: () => boolean,
      ): void {
        const controller = createXhrAbortController();
        xhr._ctrl = controller;
        const timer = startXhrTimeout(xhr, controller);
        const init = createXhrRequestInit(xhr, method, body, controller);
        void runXhrNetworkRequest(xhr, url, init, timer, live);
      };
      const XHR_CONSTS = { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 };
      for (const [name, value] of Object.entries(XHR_CONSTS)) {
        (XMLHttpRequestCls as any)[name] = value;
        (XMLHttpRequestCls.prototype as any)[name] = value;
      }
      try {
        Object.defineProperty(XMLHttpRequestCls, "name", { value: "XMLHttpRequest" });
      } catch {}
      globalThis.XMLHttpRequest = XMLHttpRequestCls;
      installXhrEventTargetGlobals();
    }
  };
  installXMLHttpRequestGlobal();

  const installFileReaderGlobal = function installFileReaderGlobal(): void {
    if (typeof globalThis.FileReader !== "function") {
      const EventTargetConstructor: typeof EventTarget =
        (ksGlobal.EventTarget as typeof EventTarget | null | undefined) ??
        class {
          addEventListener() {}
          removeEventListener() {}
          dispatchEvent() {
            return true;
          }
        };
      class FileReaderStub extends EventTargetConstructor {
        static EMPTY = 0;
        static LOADING = 1;
        static DONE = 2;
        _gen: number = 0;
        constructor() {
          super();
          (this as any).readyState = 0;
          (this as any).result = null;
          (this as any).error = null;
          (this as any).onloadstart = null;
          (this as any).onprogress = null;
          (this as any).onload = null;
          (this as any).onabort = null;
          (this as any).onerror = null;
          (this as any).onloadend = null;
        }
        get EMPTY() {
          return 0;
        }
        get LOADING() {
          return 1;
        }
        get DONE() {
          return 2;
        }
        _fire(type: string, detail?: any) {
          const event = createFileReaderEvent(type, detail);
          callFileReaderEventHandler(this, type, event);
          dispatchFileReaderEvent(this, event);
        }
        _read(
          blob: any,
          readType: "text" | "arrayBuffer" | "dataURL" | "binaryString",
          encoding?: string,
        ) {
          const readGeneration = ++this._gen;
          const later = (callback: () => void) => {
            setTimeout(() => {
              if (this._gen !== readGeneration) return;
              callback();
            }, 0);
          };
          const fireLoadendLater = () => later(() => this._fire("loadend"));
          if (blob == null || typeof blob.arrayBuffer !== "function") {
            const error =
              typeof ksGlobal.DOMException === "function"
                ? new ksGlobal.DOMException("Argument is not a Blob", "TypeError")
                : new TypeError("FileReader: argument is not a Blob");
            (this as any).error = error;
            (this as any).readyState = 2;
            queueMicrotask(() => {
              if (this._gen !== readGeneration) return;
              this._fire("error");
              fireLoadendLater();
            });
            return;
          }
          (this as any).readyState = 1;
          (this as any).result = null;
          (this as any).error = null;
          queueMicrotask(() => {
            if (this._gen !== readGeneration) return;
            this._fire("loadstart");
          });
          Promise.resolve()
            .then(() => blob.arrayBuffer())
            .then((buffer: ArrayBuffer) => {
              if (this._gen !== readGeneration) return;
              const bytes = new Uint8Array(buffer);
              const result = fileReaderResult(blob, readType, encoding, buffer, bytes);
              this._fire("progress", {
                lengthComputable: true,
                loaded: bytes.length,
                total: bytes.length,
              });
              later(() => {
                (this as any).result = result;
                (this as any).readyState = 2;
                this._fire("load");
                fireLoadendLater();
              });
            })
            .catch((error: any) => {
              if (this._gen !== readGeneration) return;
              (this as any).error = error;
              (this as any).readyState = 2;
              this._fire("error");
              fireLoadendLater();
            });
        }
        readAsText(blob: any, encoding?: string) {
          this._read(blob, "text", encoding);
        }
        readAsArrayBuffer(blob: any) {
          this._read(blob, "arrayBuffer");
        }
        readAsDataURL(blob: any) {
          this._read(blob, "dataURL");
        }
        readAsBinaryString(blob: any) {
          this._read(blob, "binaryString");
        }
        abort() {
          if ((this as any).readyState === 0) {
            (this as any).result = null;
            return;
          }
          if ((this as any).readyState === 2) return;
          this._gen++;
          (this as any).readyState = 2;
          (this as any).result = null;
          this._fire("abort");
          this._fire("loadend");
        }
      }
      const createFileReaderEvent = function createFileReaderEvent(type: string, detail: any): any {
        try {
          const event = new ksEventCtors.Event(type, { bubbles: false, cancelable: false });
          if (detail) Object.assign(event, detail);
          return event;
        } catch {
          return { type, ...detail };
        }
      };
      const callFileReaderEventHandler = function callFileReaderEventHandler(
        reader: FileReaderStub,
        type: string,
        event: any,
      ): void {
        const handler = (reader as any)["on" + type];
        if (typeof handler !== "function") return;
        try {
          handler.call(reader, event);
        } catch {}
      };
      const dispatchFileReaderEvent = function dispatchFileReaderEvent(
        reader: FileReaderStub,
        event: any,
      ): void {
        try {
          (reader as any).dispatchEvent(event);
        } catch {}
      };
      const fileReaderTextResult = function fileReaderTextResult(
        bytes: Uint8Array,
        encoding: string | undefined,
      ): string {
        try {
          const decoder = new TextDecoder(encoding || "utf-8");
          return decoder.decode(bytes);
        } catch {
          return "";
        }
      };
      const fileReaderBinaryString = function fileReaderBinaryString(bytes: Uint8Array): string {
        let binaryString = "";
        for (let i = 0; i < bytes.length; i++) {
          binaryString += String.fromCharCode(bytes[i]);
        }
        return binaryString;
      };
      const fileReaderDataUrlResult = function fileReaderDataUrlResult(
        blob: any,
        bytes: Uint8Array,
      ): string {
        const binaryString = fileReaderBinaryString(bytes);
        const base64 = ksGlobal.btoa ? ksGlobal.btoa(binaryString) : "";
        const mediaType = (blob.type && String(blob.type)) || "application/octet-stream";
        return "data:" + mediaType + ";base64," + base64;
      };
      const fileReaderResult = function fileReaderResult(
        blob: any,
        readType: "text" | "arrayBuffer" | "dataURL" | "binaryString",
        encoding: string | undefined,
        buffer: ArrayBuffer,
        bytes: Uint8Array,
      ): any {
        if (readType === "arrayBuffer") return buffer;
        if (readType === "text") return fileReaderTextResult(bytes, encoding);
        if (readType === "binaryString") return fileReaderBinaryString(bytes);
        return fileReaderDataUrlResult(blob, bytes);
      };
      globalThis.FileReader = FileReaderStub as any;
    }
  };
  installFileReaderGlobal();

  const parseBlobDocumentUrl = function parseBlobDocumentUrl(URLConstructor: any): any {
    try {
      const document = ksGlobal.document;
      return document?.URL ? new URLConstructor(document.URL) : null;
    } catch {
      return null;
    }
  };
  const blobObjectUrlOrigin = function blobObjectUrlOrigin(URLConstructor: any): string {
    const documentUrl = parseBlobDocumentUrl(URLConstructor);
    if (!documentUrl || !documentUrl.origin || documentUrl.origin === "null") return "null";
    return documentUrl.origin;
  };
  const fillBlobUuidWithMathRandom = function fillBlobUuidWithMathRandom(
    randomBytes: Uint8Array,
  ): void {
    for (let i = 0; i < 16; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
  };
  const formatBlobUuid = function formatBlobUuid(randomBytes: Uint8Array): string {
    const hex = Array.from(randomBytes)
      .map((byte) => (byte as number).toString(16).padStart(2, "0"))
      .join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };
  const fallbackBlobUuid = function fallbackBlobUuid(cryptoObj: any): string {
    const randomBytes = new Uint8Array(16);
    const randomValues = cryptoObj?.getRandomValues?.(randomBytes);
    if (randomValues == null) fillBlobUuidWithMathRandom(randomBytes);
    randomBytes[6] = ((randomBytes[6] as number) & 0x0f) | 0x40;
    randomBytes[8] = ((randomBytes[8] as number) & 0x3f) | 0x80;
    return formatBlobUuid(randomBytes);
  };
  const blobObjectUrlUuid = function blobObjectUrlUuid(cryptoObj: any): string {
    if (typeof cryptoObj?.randomUUID === "function") return cryptoObj.randomUUID();
    return fallbackBlobUuid(cryptoObj);
  };
  const assertBlobObjectUrlArgument = function assertBlobObjectUrlArgument(blob: any): void {
    if (blob == null || typeof blob !== "object") {
      throw new TypeError("URL.createObjectURL: argument is not a Blob/MediaSource");
    }
  };
  const installBlobObjectUrlGlobals = function installBlobObjectUrlGlobals(): void {
    try {
      const URLConstructor: any = ksGlobal.URL;
      if (URLConstructor && typeof URLConstructor.createObjectURL === "function") {
        const blobOrigin = blobObjectUrlOrigin(URLConstructor);
        URLConstructor.createObjectURL = function (blob: any) {
          assertBlobObjectUrlArgument(blob);
          const uuid = blobObjectUrlUuid(ksGlobal.crypto);
          const url = `blob:${blobOrigin === "null" ? "" : blobOrigin + "/"}${uuid}`;
          state.blobUrls.set(url, blob);
          return url;
        };
        URLConstructor.revokeObjectURL = function (url: any) {
          state.blobUrls.delete(String(url));
        };
      }
    } catch {}
  };
  installBlobObjectUrlGlobals();

  installWebAssemblyShim();
  installPageTaskGlobals(win, defineEnumerableProto);

  const installWindowEventHandlerGlobals = function installWindowEventHandlerGlobals(): void {
    const winOnHandlers = [
      "onabort",
      "onafterprint",
      "onauxclick",
      "onbeforeinput",
      "onbeforematch",
      "onbeforeprint",
      "onbeforetoggle",
      "onbeforeunload",
      "onblur",
      "oncancel",
      "oncanplay",
      "oncanplaythrough",
      "onchange",
      "onclick",
      "onclose",
      "oncommand",
      "oncontextlost",
      "oncontextmenu",
      "oncontextrestored",
      "oncopy",
      "oncuechange",
      "oncut",
      "ondblclick",
      "ondrag",
      "ondragend",
      "ondragenter",
      "ondragleave",
      "ondragover",
      "ondragstart",
      "ondrop",
      "ondurationchange",
      "onemptied",
      "onended",
      "onerror",
      "onfocus",
      "onformdata",
      "oninput",
      "oninvalid",
      "onkeydown",
      "onkeypress",
      "onkeyup",
      "onlanguagechange",
      "onload",
      "onloadeddata",
      "onloadedmetadata",
      "onloadstart",
      "onmessage",
      "onmessageerror",
      "onmousedown",
      "onmouseenter",
      "onmouseleave",
      "onmousemove",
      "onmouseout",
      "onmouseover",
      "onmouseup",
      "onoffline",
      "ononline",
      "onpagehide",
      "onpagereveal",
      "onpageshow",
      "onpageswap",
      "onpaste",
      "onpause",
      "onplay",
      "onplaying",
      "onprogress",
      "onratechange",
      "onrejectionhandled",
      "onreset",
      "onresize",
      "onscrollend",
      "onsecuritypolicyviolation",
      "onseeked",
      "onseeking",
      "onselect",
      "onslotchange",
      "onstalled",
      "onstorage",
      "onsubmit",
      "onsuspend",
      "ontimeupdate",
      "ontoggle",
      "onunhandledrejection",
      "onunload",
      "onvolumechange",
      "onwaiting",
      "onwebkitanimationend",
      "onwebkitanimationiteration",
      "onwebkitanimationstart",
      "onwebkittransitionend",
      "onwheel",
    ];
    const hasAccessorOnPrototype = (objectValue: any, name: string): boolean => {
      let proto = Object.getPrototypeOf(objectValue);
      while (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        if (desc) {
          return typeof desc.get === "function" || typeof desc.set === "function";
        }
        proto = Object.getPrototypeOf(proto);
      }
      return false;
    };
    for (const name of winOnHandlers) {
      if (Object.prototype.hasOwnProperty.call(win, name)) continue;
      if (hasAccessorOnPrototype(win, name)) continue;
      try {
        Object.defineProperty(win, name, {
          value: null,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch {}
    }
  };
  installWindowEventHandlerGlobals();

  const installWindowMiscGlobals = function installWindowMiscGlobals(): void {
    const barPropStub = () => ({ visible: false });
    const storageStub = (): any => {
      const values = new Map<string, string>();
      return {
        get length() {
          return values.size;
        },
        key(index: number) {
          return [...values.keys()][index >>> 0] ?? null;
        },
        getItem(key: string) {
          return values.has(String(key)) ? values.get(String(key))! : null;
        },
        setItem(key: string, value: string) {
          values.set(String(key), String(value));
        },
        removeItem(key: string) {
          values.delete(String(key));
        },
        clear() {
          values.clear();
        },
      };
    };
    const winMiscDefaults: Record<string, any> = {
      closed: false,
      crossOriginIsolated: false,
      customElements: {
        define() {},
        get() {
          return undefined;
        },
        whenDefined() {
          return Promise.resolve();
        },
        upgrade() {},
      },
      external: {
        AddSearchProvider() {},
        IsSearchProviderInstalled() {
          return 0;
        },
      },
      isSecureContext: false,
      localStorage: storageStub(),
      sessionStorage: storageStub(),
      locationbar: barPropStub(),
      menubar: barPropStub(),
      personalbar: barPropStub(),
      scrollbars: { visible: true },
      statusbar: barPropStub(),
      toolbar: barPropStub(),
      name: "",
      status: "",
      origin: typeof ksGlobal.location?.origin === "string" ? ksGlobal.location.origin : "",
      originAgentCluster: false,
      navigation: {
        entries() {
          return [];
        },
        currentEntry: null,
      },
      clientInformation: ksGlobal.navigator,
    };
    const installWindowDefaultProperties = function installWindowDefaultProperties(): void {
      for (const [name, value] of Object.entries(winMiscDefaults)) {
        if (Object.prototype.hasOwnProperty.call(globalThis, name)) continue;
        try {
          Object.defineProperty(globalThis, name, {
            value,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        } catch {}
      }
    };
    installWindowDefaultProperties();

    const installSchedulerGlobal = function installSchedulerGlobal(): void {
      try {
        Object.defineProperty(globalThis, "scheduler", {
          value: createScheduler(ksGlobal.setTimeout.bind(globalThis)),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch {}
    };
    installSchedulerGlobal();

    const installIndexedDbGlobals = function installIndexedDbGlobals(): void {
      for (const [name, value] of Object.entries(indexedDbGlobals)) {
        if (typeof ksGlobal[name] !== "undefined") continue;
        try {
          Object.defineProperty(globalThis, name, {
            value,
            writable: true,
            configurable: true,
            enumerable: name === "indexedDB",
          });
        } catch {}
      }
    };
    installIndexedDbGlobals();

    const installOriginGlobal = function installOriginGlobal(): void {
      const originValue = function originValue(): unknown {
        return winMiscDefaults.origin || ksGlobal.origin;
      };
      try {
        const originDesc = Object.getOwnPropertyDescriptor(globalThis, "origin");
        if (originDesc && originDesc.writable === false && originDesc.configurable) {
          Object.defineProperty(globalThis, "origin", {
            value: originValue(),
            writable: true,
            configurable: true,
            enumerable: true,
          });
        }
      } catch {}
    };
    installOriginGlobal();

    const ownConstructorNames = [
      "ReadableStream",
      "ReadableStreamDefaultReader",
      "ReadableStreamBYOBReader",
      "ReadableStreamDefaultController",
      "ReadableByteStreamController",
      "ReadableStreamBYOBRequest",
      "WritableStream",
      "WritableStreamDefaultWriter",
      "WritableStreamDefaultController",
      "TransformStream",
      "TransformStreamDefaultController",
      "ByteLengthQueuingStrategy",
      "CountQueuingStrategy",
      "TextDecoderStream",
      "TextEncoderStream",
      "CompressionStream",
      "DecompressionStream",
      "CryptoKey",
      "SubtleCrypto",
      "Crypto",
      "structuredClone",
      "performance",
      "Performance",
      "PerformanceObserver",
      "PerformanceEntry",
      "PerformanceMark",
      "PerformanceMeasure",
      "PerformanceResourceTiming",
      "queueMicrotask",
      "reportError",
      "btoa",
      "atob",
      "WebAssembly",
    ];
    const installOwnConstructorGlobals = function installOwnConstructorGlobals(): void {
      for (const name of ownConstructorNames) {
        const constructor = ksGlobal[name];
        if (typeof constructor === "undefined") continue;
        if (Object.prototype.hasOwnProperty.call(globalThis, name)) continue;
        try {
          Object.defineProperty(globalThis, name, {
            value: constructor,
            writable: true,
            configurable: true,
            enumerable: false,
          });
        } catch {}
      }
    };
    installOwnConstructorGlobals();

    const isImageDataArrayLike = (value: any): boolean =>
      typeof value === "object" && value && typeof value.length === "number";
    const throwInvalidImageDataDimensions = function throwInvalidImageDataDimensions(): never {
      throw new ksGlobal.DOMException("invalid dimensions", "IndexSizeError");
    };
    const hasValidImageDataWidth = (data: Uint8ClampedArray, width: number): boolean =>
      width !== 0 && data.length % 4 === 0 && (data.length / 4) % width === 0;
    const imageDataHeight = (data: Uint8ClampedArray, width: number, height: any): number =>
      height === undefined ? data.length / 4 / width : height >>> 0;
    const imageDataFromArray = function imageDataFromArray(
      dataValue: any,
      widthValue: any,
      heightValue: any,
    ): { width: number; height: number; data: Uint8ClampedArray } {
      const data = dataValue as Uint8ClampedArray;
      const width = widthValue >>> 0;
      if (!hasValidImageDataWidth(data, width)) throwInvalidImageDataDimensions();
      const height = imageDataHeight(data, width, heightValue);
      if (height === 0 || data.length !== width * height * 4) {
        throwInvalidImageDataDimensions();
      }
      return { width, height, data };
    };
    const imageDataFromDimensions = function imageDataFromDimensions(
      widthValue: any,
      heightValue: any,
    ): { width: number; height: number; data: Uint8ClampedArray } {
      const width = widthValue >>> 0;
      const height = heightValue >>> 0;
      if (width === 0 || height === 0) throwInvalidImageDataDimensions();
      if (width * height > MAX_IMAGE_DATA_PIXELS) {
        throw new RangeError("ImageData size exceeds the supported range");
      }
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    };
    const createImageDataState = function createImageDataState(
      dataOrWidth: any,
      widthOrHeight: any,
      height: any,
    ): { width: number; height: number; data: Uint8ClampedArray } {
      if (isImageDataArrayLike(dataOrWidth)) {
        return imageDataFromArray(dataOrWidth, widthOrHeight, height);
      }
      return imageDataFromDimensions(dataOrWidth, widthOrHeight);
    };
    const installImageDataGlobal = function installImageDataGlobal(): void {
      if (typeof ksGlobal.ImageData === "undefined") {
        class ImageData {
          width: number;
          height: number;
          data: Uint8ClampedArray;
          colorSpace: string;
          constructor(dataOrWidth: any, widthOrHeight: any, height?: any) {
            const imageData = createImageDataState(dataOrWidth, widthOrHeight, height);
            this.width = imageData.width;
            this.height = imageData.height;
            this.data = imageData.data;
            this.colorSpace = "srgb";
          }
        }
        Object.defineProperty(globalThis, "ImageData", {
          value: ImageData,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      }
    };
    installImageDataGlobal();

    const installDomPointGlobals = function installDomPointGlobals(): void {
      if (typeof ksGlobal.DOMPoint === "undefined") {
        class DOMPointReadOnly {
          x: number;
          y: number;
          z: number;
          w: number;
          constructor(x?: any, y?: any, z?: any, w?: any) {
            this.x = Number(x ?? 0);
            this.y = Number(y ?? 0);
            this.z = Number(z ?? 0);
            this.w = w === undefined ? 1 : Number(w);
          }
          static fromPoint(p: any) {
            return new (this as any)(p?.x, p?.y, p?.z, p?.w);
          }
          toJSON() {
            return { x: this.x, y: this.y, z: this.z, w: this.w };
          }
        }
        class DOMPoint extends DOMPointReadOnly {}
        for (const [n, v] of [
          ["DOMPointReadOnly", DOMPointReadOnly],
          ["DOMPoint", DOMPoint],
        ] as const) {
          Object.defineProperty(globalThis, n, {
            value: v,
            writable: true,
            configurable: true,
            enumerable: false,
          });
        }
      }
    };
    installDomPointGlobals();

    const installFontFaceGlobal = function installFontFaceGlobal(): void {
      if (typeof ksGlobal.FontFace === "undefined") {
        class FontFace {
          family: string;
          status: string;
          constructor(family: any, _src?: any, _desc?: any) {
            this.family = String(family);
            this.status = "unloaded";
          }
          load() {
            this.status = "loaded";
            return Promise.resolve(this);
          }
          get loaded() {
            return Promise.resolve(this);
          }
        }
        Object.defineProperty(globalThis, "FontFace", {
          value: FontFace,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      }
    };
    installFontFaceGlobal();

    const idlStubs = [
      "AudioTrack",
      "AudioTrackList",
      "BarProp",
      "BroadcastChannel",
      "CanvasGradient",
      "CanvasPattern",
      "CanvasRenderingContext2D",
      "CloseWatcher",
      "CommandEvent",
      "CustomElementRegistry",
      "CustomStateSet",
      "DataTransfer",
      "DataTransferItem",
      "DataTransferItemList",
      "DOMStringList",
      "DOMStringMap",
      "ElementInternals",
      "EventSource",
      "External",
      "FormDataEvent",
      "History",
      "HTMLAllCollection",
      "HTMLFormControlsCollection",
      "HTMLOptionsCollection",
      "HTMLSelectedContentElement",
      "ImageBitmap",
      "ImageBitmapRenderingContext",
      "ImageData",
      "Location",
      "MediaError",
      "MessageChannel",
      "MessagePort",
      "MimeType",
      "MimeTypeArray",
      "NavigateEvent",
      "Navigation",
      "NavigationActivation",
      "NavigationCurrentEntryChangeEvent",
      "NavigationDestination",
      "NavigationHistoryEntry",
      "NavigationPrecommitController",
      "NavigationTransition",
      "Navigator",
      "NotRestoredReasonDetails",
      "NotRestoredReasons",
      "OffscreenCanvas",
      "OffscreenCanvasRenderingContext2D",
      "Origin",
      "PageRevealEvent",
      "PageSwapEvent",
      "Path2D",
      "Plugin",
      "PluginArray",
      "RadioNodeList",
      "SharedWorker",
      "Storage",
      "SVGElement",
      "SVGSVGElement",
      "TextMetrics",
      "TextTrack",
      "TextTrackCue",
      "TextTrackCueList",
      "TextTrackList",
      "TimeRanges",
      "ToggleEvent",
      "TrackEvent",
      "UserActivation",
      "ValidityState",
      "VideoTrack",
      "VideoTrackList",
      "VisibilityStateEntry",
      "WebGLRenderingContext",
      "WebGL2RenderingContext",
      "Worklet",
      "XMLSerializer",
    ];
    const unconstructible = new Set(["SharedWorker"]);
    const createIdlStub = function createIdlStub(name: string) {
      return unconstructible.has(name)
        ? {
            [name]: class {
              constructor() {
                throw new DOMException(
                  `Failed to construct '${name}': workers are not supported`,
                  "SecurityError",
                );
              }
            },
          }[name]
        : { [name]: class {} }[name];
    };
    const installIdlStubs = function installIdlStubs(): void {
      for (const name of idlStubs) {
        if (typeof ksGlobal[name] !== "undefined") continue;
        const cls = createIdlStub(name);
        try {
          Object.defineProperty(cls, "name", {
            value: name,
            writable: false,
            enumerable: false,
            configurable: true,
          });
          Object.defineProperty(cls.prototype, Symbol.toStringTag, {
            value: name,
            writable: false,
            enumerable: false,
            configurable: true,
          });
        } catch {}
        try {
          Object.defineProperty(globalThis, name, {
            value: cls,
            writable: true,
            configurable: true,
            enumerable: false,
          });
        } catch {}
      }
    };
    installIdlStubs();

    const mirrorKeys = [
      "document",
      "location",
      "navigator",
      "history",
      "frames",
      "frameElement",
      "opener",
      "top",
      "parent",
      "Event",
      "CustomEvent",
      "SubmitEvent",
      "UIEvent",
      "FocusEvent",
      "WheelEvent",
      "CompositionEvent",
      "InputEvent",
      "MouseEvent",
      "PointerEvent",
      "KeyboardEvent",
      "HashChangeEvent",
      "PopStateEvent",
      "PageTransitionEvent",
      "TransitionEvent",
      "AnimationEvent",
      "BeforeUnloadEvent",
      "DeviceMotionEvent",
      "DeviceMotionEventAcceleration",
      "DeviceMotionEventRotationRate",
      "DeviceOrientationEvent",
      "DragEvent",
      "MessageEvent",
      "StorageEvent",
      "TextEvent",
      "TouchEvent",
      "ErrorEvent",
      "PromiseRejectionEvent",
      "FormData",
      "Element",
      "HTMLElement",
      "Node",
      "Window",
      "EventTarget",
      "Text",
      "Comment",
      "CharacterData",
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "HTMLSelectElement",
      "HTMLOptionElement",
      "HTMLOptGroupElement",
      "HTMLButtonElement",
      "HTMLFormElement",
      "HTMLLabelElement",
      "HTMLFieldSetElement",
      "HTMLLegendElement",
      "HTMLOutputElement",
      "HTMLDataListElement",
      "HTMLProgressElement",
      "HTMLMeterElement",
      "HTMLAnchorElement",
      "HTMLAreaElement",
      "HTMLImageElement",
      "HTMLPictureElement",
      "HTMLSourceElement",
      "HTMLDivElement",
      "HTMLSpanElement",
      "HTMLParagraphElement",
      "HTMLHeadingElement",
      "HTMLBodyElement",
      "HTMLHtmlElement",
      "HTMLHeadElement",
      "HTMLTitleElement",
      "HTMLScriptElement",
      "HTMLLinkElement",
      "HTMLMetaElement",
      "HTMLStyleElement",
      "HTMLBaseElement",
      "HTMLBRElement",
      "HTMLHRElement",
      "HTMLPreElement",
      "HTMLQuoteElement",
      "HTMLUListElement",
      "HTMLOListElement",
      "HTMLLIElement",
      "HTMLDListElement",
      "HTMLMenuElement",
      "HTMLTableElement",
      "HTMLTableRowElement",
      "HTMLTableCellElement",
      "HTMLTableSectionElement",
      "HTMLTableCaptionElement",
      "HTMLTableColElement",
      "HTMLIFrameElement",
      "HTMLVideoElement",
      "HTMLAudioElement",
      "HTMLMediaElement",
      "HTMLCanvasElement",
      "HTMLEmbedElement",
      "HTMLObjectElement",
      "HTMLTemplateElement",
      "HTMLSlotElement",
      "HTMLTimeElement",
      "HTMLDetailsElement",
      "HTMLDialogElement",
      "HTMLModElement",
      "HTMLDataElement",
      "HTMLMapElement",
      "HTMLTrackElement",
      "HTMLParamElement",
      "HTMLDirectoryElement",
      "HTMLFontElement",
      "HTMLFrameElement",
      "HTMLFrameSetElement",
      "HTMLMarqueeElement",
      "HTMLUnknownElement",
      "DOMException",
      "DOMTokenList",
      "NamedNodeMap",
      "Attr",
      "CSSStyleValue",
      "CSSImageValue",
      "CSSKeywordValue",
      "CSSNumericValue",
      "CSSUnitValue",
      "CSSMathValue",
      "CSSMathSum",
      "CSSMathProduct",
      "CSSMathNegate",
      "CSSMathInvert",
      "CSSMathMin",
      "CSSMathMax",
      "CSSMathClamp",
      "CSSNumericArray",
      "CSSColorValue",
      "CSSRGB",
      "CSSHSL",
      "CSSHWB",
      "CSSLab",
      "CSSLCH",
      "CSSOKLab",
      "CSSOKLCH",
      "CSSColor",
      "CSSUnparsedValue",
      "CSSVariableReferenceValue",
      "StylePropertyMapReadOnly",
      "StylePropertyMap",
      "CSSTransformValue",
      "CSSTransformComponent",
      "CSSTranslate",
      "CSSRotate",
      "CSSScale",
      "CSSSkew",
      "CSSSkewX",
      "CSSSkewY",
      "CSSPerspective",
      "CSSMatrixComponent",
      "DOMMatrixReadOnly",
      "DOMMatrix",
      "DocumentType",
      "DocumentFragment",
      "Document",
      "ModelContext",
      "NodeList",
      "HTMLCollection",
      "Range",
      "StaticRange",
      "Selection",
      "AbstractRange",
      "MutationObserver",
      "MutationRecord",
      "DOMParser",
      "XMLSerializer",
      "URL",
      "URLSearchParams",
      "Blob",
      "File",
      "FileList",
      "FileReader",
      "AbortController",
      "AbortSignal",
      "TextEncoder",
      "TextDecoder",
      "TreeWalker",
      "NodeIterator",
      "NodeFilter",
      "XPathResult",
      "XPathExpression",
      "XPathEvaluator",
      "DOMRect",
      "DOMRectReadOnly",
      "DOMRectList",
      "DOMPoint",
      "DOMPointReadOnly",
      "DOMQuad",
      "DOMMatrix",
      "DOMMatrixReadOnly",
      "CSSStyleSheet",
      "CSSStyleDeclaration",
      "CSSRule",
      "CSSRuleList",
      "CSSCounterStyleRule",
      "Image",
      "Audio",
      "Option",
      "performance",
      "console",
      "getComputedStyle",
      "matchMedia",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "addEventListener",
      "removeEventListener",
      "dispatchEvent",
      "fetch",
      "Request",
      "Response",
      "Headers",
      ...idlStubs,
      ...ownConstructorNames,
      ...Object.keys(winMiscDefaults),
      "scheduler",
      ...Object.keys(indexedDbGlobals),
    ];
    const winOwnKeys = new Set(Reflect.ownKeys(win));
    const mirrorWindowProperties = function mirrorWindowProperties(): void {
      for (const k of mirrorKeys) {
        const globalValue = ksGlobal[k];
        if (globalValue === undefined) continue;
        if (winOwnKeys.has(k)) continue;
        try {
          Object.defineProperty(win, k, {
            value: globalValue,
            writable: true,
            configurable: true,
            enumerable: false,
          });
        } catch {}
      }
    };
    mirrorWindowProperties();
  };
  installWindowMiscGlobals();
}

function removeWindowGlobals(win: ShimWindow | null): void {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.location;
  delete ksGlobal.navigator;
  delete globalThis.history;
  if (ksGlobal.self === win) delete ksGlobal.self;
  if (globalThis.top === win) delete globalThis.top;
  if (globalThis.parent === win) delete globalThis.parent;
  if (globalThis.frames === win) delete globalThis.frames;
  delete globalThis.frameElement;
  delete globalThis.opener;
  delete ksGlobal.Event;
  delete globalThis.MouseEvent;
  delete globalThis.KeyboardEvent;
  delete globalThis.Element;
  delete globalThis.HTMLElement;
  delete globalThis.Node;
  delete ksGlobal.EventTarget;
  delete globalThis.getComputedStyle;
}
interface BlobOptionsCapture {
  proxy: object;
  mimeType(): string;
}

function installBlobTypeGetter(prototype: object): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "type");
  const getType = descriptor?.get;
  if (!getType || descriptor?.configurable !== true) return;
  Object.defineProperty(prototype, "type", {
    ...descriptor,
    get(this: object) {
      const mimeType = getBlobMimeType(this);
      if (mimeType !== undefined) return mimeType;
      return normalizeBlobType(String(getType.call(this)));
    },
  });
}

function installBlobTypeGetters(blobConstructor: unknown, fileConstructor: unknown): void {
  for (const constructor of [blobConstructor, fileConstructor]) {
    if (typeof constructor !== "function") continue;
    installBlobTypeGetter(constructor.prototype);
  }
}

function isBlobOptionsDictionary(options: unknown): options is object {
  return (
    options !== null &&
    options !== undefined &&
    (typeof options === "object" || typeof options === "function")
  );
}

function captureBlobOptions(dictionary: object): BlobOptionsCapture {
  let typeWasRead = false;
  let mimeType = "";
  const proxy = new Proxy(Object.create(null), {
    get(_target, property) {
      if (property !== "type") return Reflect.get(dictionary, property, dictionary);
      if (!typeWasRead) {
        const inputType = Reflect.get(dictionary, property, dictionary);
        if (typeof inputType === "symbol") {
          throw new TypeError("Cannot convert a Symbol value to a string");
        }
        mimeType = normalizeBlobType(inputType === undefined ? "" : String(inputType));
        typeWasRead = true;
      }
      return mimeType;
    },
  });
  return { proxy, mimeType: () => mimeType };
}

function captureBlobConstructorOptions(
  args: any[],
  optionsIndex: number,
): BlobOptionsCapture | null {
  const options = args[optionsIndex];
  if (!isBlobOptionsDictionary(options)) return null;
  return captureBlobOptions(options);
}

function setBlobPrototypeConstructor(
  nativeConstructor: Function,
  wrappedConstructor: Function,
  name: "Blob" | "File",
): void {
  try {
    Object.defineProperty(nativeConstructor.prototype, "constructor", {
      value: wrappedConstructor,
      configurable: true,
      writable: true,
    });
  } catch (error) {
    console.warn("[kitesurf-blob] failed to set prototype constructor", {
      interfaceName: name,
      error,
    });
  }
}

function wrapBlobConstructor(name: "Blob" | "File", optionsIndex: number): void {
  const nativeConstructor = ksGlobal[name];
  if (typeof nativeConstructor !== "function") return;
  const constructor = new Proxy(nativeConstructor, {
    construct(target, args, newTarget) {
      const constructorArgs = args.slice();
      const options = captureBlobConstructorOptions(args, optionsIndex);
      if (options) constructorArgs[optionsIndex] = options.proxy;
      const instance = Reflect.construct(target, constructorArgs, newTarget);
      setBlobMimeType(instance, options?.mimeType() ?? "");
      return instance;
    },
  });
  setBlobPrototypeConstructor(nativeConstructor, constructor, name);
  ksGlobal[name] = constructor;
}

function installBlobMimeTypeSerialization(): void {
  const blobConstructor = ksGlobal.Blob;
  if (typeof blobConstructor !== "function") return;
  installBlobTypeGetters(blobConstructor, ksGlobal.File);
  wrapBlobConstructor("Blob", 1);
  wrapBlobConstructor("File", 2);
}
