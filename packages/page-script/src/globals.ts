// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Installs browser-facing globals and adapters in the PageScript realm.

import { resolveImportMap, resolveModuleRegistryUrl } from "./__ks_import_map.js";
import type { BuildDocumentResult, ShimDocument, ShimNavigator, ShimWindow } from "./types.ts";
import {
  ks_bridge_buffer_bytes,
  ks_bridge_ever_minted,
  ks_eval_page,
  ks_import,
  ks_is_bridged,
  ks_parse_inline_style,
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
  ksGlobalByKey,
  shimEventCtor,
  state,
  type ShimEventCtors,
} from "./state.ts";
import { ensurePaintDom, invalidatePaintDom } from "./paint.ts";
import { fetchGatedModuleSource } from "./inserted-scripts.ts";
import { trustedFetch } from "./trusted-fetch.ts";
import { indexedDbGlobals } from "./indexeddb.ts";
import { createScheduler } from "./scheduler.ts";
import { installIdleCallbackGlobals, installPageTaskGlobals, queuePortTask } from "./page-tasks.ts";
import { getBlobMimeType, normalizeBlobType, setBlobMimeType } from "./mime-type.ts";
import { ksInternals } from "./internals.ts";

const MAX_IMAGE_DATA_PIXELS = 4096 * 4096;

type PageNavigator = ShimNavigator & {
  userAgentData?: unknown;
  webdriver?: unknown;
};

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
  let label = "utf-8";
  if (responseType === "json") {
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = "utf-8";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le";
  else label = charsetOf(overrideMime) ?? charsetOf(responseMime) ?? "utf-8";
  try {
    return new NativeTextDecoder(label).decode(bytes);
  } catch {
    return new NativeTextDecoder("utf-8").decode(bytes);
  }
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
    if (webAssembly && typeof webAssembly.instantiate === "function") {
      const NativeModule = webAssembly.Module;
      const nativeInstantiate = webAssembly.instantiate.bind(webAssembly);
      const nativeCompile =
        typeof webAssembly.compile === "function" ? webAssembly.compile.bind(webAssembly) : null;

      webAssembly.instantiate = stampFunction(
        function (source: any, imports?: any) {
          try {
            if (NativeModule && source instanceof NativeModule) {
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

      if (typeof NativeModule === "function") {
        const ModuleShim: any = function Module(bytes: any) {
          const module = matchWasmByBytesSync(bytes);
          if (module) return module;
          return new NativeModule(bytes);
        };
        try {
          Object.defineProperty(ModuleShim, "prototype", {
            value: NativeModule.prototype,
            writable: false,
            enumerable: false,
            configurable: false,
          });
          Object.defineProperty(NativeModule.prototype, "constructor", {
            value: ModuleShim,
            writable: true,
            enumerable: false,
            configurable: true,
          });
        } catch {
          ModuleShim.prototype = NativeModule.prototype;
        }
        try {
          Object.setPrototypeOf(ModuleShim, Object.getPrototypeOf(NativeModule));
        } catch {}
        for (const [methodName, length] of [
          ["exports", 1],
          ["imports", 1],
          ["customSections", 2],
        ] as Array<[string, number]>) {
          installWebAssemblyModuleStaticMethod(NativeModule, ModuleShim, methodName, length);
        }
        stampFunction(ModuleShim, "Module", 1);
        webAssembly.Module = ModuleShim;
      }
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
    }
  } catch {}
}

// installGlobals runs again on teardown; Function and eval are patched once.
let functionPatched = false;
let evalPatched = false;
// Reverse registry (ctor to defined tag), filled by customElements.define() and read by the
// HTMLElement constructor. Module-level: only the first installGlobals defines customElements,
// but every call re-wraps HTMLElement, so both must see the same map.
const ctorTagNames = new WeakMap<object, string>();

export function installGlobals(
  doc: ShimDocument | null,
  win: ShimWindow | null,
  built: BuildDocumentResult | Record<string, never>,
): void {
  const handlerNames = (key: "global" | "window" | "all"): unknown => {
    const bag = built ? built.eventHandlerNames : undefined;
    return bag && typeof bag === "object" ? Reflect.get(bag, key) : undefined;
  };
  const copyHandlerAccessors = (proto: object | undefined, names: unknown) => {
    if (!proto || !Array.isArray(names)) return;
    const preserveFunctionShape = (wrapped: Function, originalFunction: Function): void => {
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
    };
    const rewrapGetter = (originalFunction: PropertyDescriptor["get"]) => {
      if (typeof originalFunction !== "function") return undefined;
      const wrapped: NonNullable<PropertyDescriptor["get"]> = function (this: unknown) {
        const getter: Function = originalFunction;
        return getter.apply(this, arguments);
      };
      preserveFunctionShape(wrapped, originalFunction);
      return wrapped;
    };
    const rewrapSetter = (originalFunction: PropertyDescriptor["set"]) => {
      if (typeof originalFunction !== "function") return undefined;
      const wrapped: NonNullable<PropertyDescriptor["set"]> = function (this: unknown) {
        const setter: Function = originalFunction;
        return setter.apply(this, arguments);
      };
      preserveFunctionShape(wrapped, originalFunction);
      return wrapped;
    };
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(proto, name)) continue;
      let prototype = Object.getPrototypeOf(proto);
      let descriptor: PropertyDescriptor | undefined;
      while (prototype && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (!descriptor) prototype = Object.getPrototypeOf(prototype);
      }
      if (descriptor && (descriptor.get || descriptor.set)) {
        const copy: PropertyDescriptor = {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          get: rewrapGetter(descriptor.get),
          set: rewrapSetter(descriptor.set),
        };
        try {
          Object.defineProperty(proto, name, copy);
        } catch {}
      }
    }
  };
  // Keep React on MessageChannel; inherited workerd setImmediate can prevent Suspense retries.
  for (const name of ["setImmediate", "clearImmediate"]) {
    for (let o: object | null = globalThis; o; o = Object.getPrototypeOf(o)) {
      if (!Object.prototype.hasOwnProperty.call(o, name)) continue;
      try {
        delete (o as Record<string, unknown>)[name];
      } catch {}
    }
    if (typeof ksGlobalByKey[name] !== "undefined") {
      try {
        Object.defineProperty(globalThis, name, {
          value: undefined,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      } catch {}
    }
  }
  if (!functionPatched) {
    functionPatched = true;
    const NativeFunction = globalThis.Function;
    const Patched: any = function (this: any, ...args: any[]) {
      try {
        return NativeFunction.apply(this, args);
      } catch (e: any) {
        if (
          e &&
          e.name === "EvalError" &&
          typeof e.message === "string" &&
          e.message.includes("Code generation from strings disallowed")
        ) {
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
  // Forward the call receiver; construction uses Boa's separate [[Construct]] path.
  if (!ksInternals.wrapBoaFunction) {
    ksInternals.wrapBoaFunction = function (call, ctor, handle) {
      return function (this: any) {
        if (new.target !== undefined) {
          return ctor(handle, Array.prototype.slice.call(arguments));
        }
        return call(handle, this, Array.prototype.slice.call(arguments));
      };
    };
  }
  if (!ksInternals.wrapBoaMethod) {
    ksInternals.wrapBoaMethod = function (call, fnHandle, recvHandle) {
      return function () {
        return call(fnHandle, recvHandle, Array.prototype.slice.call(arguments));
      };
    };
  }
  if (!ksGlobal.__ks_resolve_import_map) {
    ksGlobal.__ks_resolve_import_map = function (spec: unknown, referrerUrl?: string): string {
      return resolveImportMap(spec, referrerUrl || ksGlobal.location?.href || "about:blank");
    };
  }
  if (!ksGlobal.__ks_import) {
    ksGlobal.__ks_import = function (spec: unknown, referrerUrl?: string): unknown {
      return ks_import(String(spec), referrerUrl || ksGlobal.location?.href || "about:blank");
    };
  }
  if (!ksInternals.nativeImport) {
    ksInternals.nativeImport = function (url) {
      return import(resolveModuleRegistryUrl(url));
    };
  }
  if (!ksInternals.fetchModuleSource) {
    ksInternals.fetchModuleSource = function (url) {
      return fetchGatedModuleSource(String(url));
    };
  }
  if (!evalPatched) {
    evalPatched = true;
    const nativeEval = globalThis.eval;
    globalThis.eval = function (src: unknown): unknown {
      if (typeof src !== "string") return src;
      try {
        return nativeEval(src);
      } catch (e: any) {
        if (
          e &&
          e.name === "EvalError" &&
          typeof e.message === "string" &&
          e.message.includes("Code generation from strings disallowed")
        ) {
          return ks_eval_page(src);
        }
        throw e;
      }
    };
  }
  if (doc && win) {
    globalThis.document = doc;
    globalThis.window = win;
    globalThis.location = win.location;
    ksGlobal.navigator = win.navigator;
    try {
      const queryString = String((win.location && win.location.search) || "");
      if (/[?&]ks_boa_lenient=1(&|$)/.test(queryString)) {
        ks_set_boa_strict(false);
        console.log("[kitesurf] boa lenient mode ON (boa exceptions swallowed)");
      } else if (/[?&]ks_boa_strict=1(&|$)/.test(queryString)) {
        ks_set_boa_strict(true);
      }
    } catch {}
    globalThis.history = win.history;
    ksGlobal.self = win;
    try {
      ksGlobal.postMessage = function (...a: any[]) {
        return (win as any).postMessage(...a);
      };
    } catch {}
    globalThis.top = (win as any).top ?? win;
    globalThis.parent = (win as any).parent ?? win;
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
    globalThis.frameElement = null;
    globalThis.opener = null;
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
    // Publish through the shim-global view, not WorkerGlobalScope's typed event methods.
    ksGlobalByKey.addEventListener = win.addEventListener.bind(win);
    ksGlobalByKey.removeEventListener = win.removeEventListener.bind(win);
    ksGlobalByKey.dispatchEvent = win.dispatchEvent.bind(win);

    // Workerd host methods can reject detached calls, so page globals need bound receiver shadows.
    const __ks_boundCache = new WeakMap<Function, Function>();
    const installBoundShadow = (target: any, name: string, thisArg: any = target): void => {
      const method = target[name];
      if (typeof method !== "function") return;
      try {
        if (
          method.prototype !== undefined &&
          method.prototype !== null &&
          typeof method.prototype === "object" &&
          method.prototype.constructor === method
        ) {
          return;
        }
      } catch {}
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
      try {
        target[name] = bound;
      } catch {}
    };

    installBoundShadow(globalThis, "setTimeout");
    installBoundShadow(globalThis, "setInterval");
    installBoundShadow(globalThis, "clearTimeout");
    installBoundShadow(globalThis, "clearInterval");
    installBoundShadow(globalThis, "queueMicrotask");

    installBoundShadow(globalThis, "fetch");

    installBoundShadow(globalThis, "atob");
    installBoundShadow(globalThis, "btoa");
    installBoundShadow(globalThis, "structuredClone");

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
        const containsBridged = (value: unknown, seen: WeakSet<object>): boolean => {
          if (value === null || typeof value !== "object") return false;
          const objectValue = value as Record<string, unknown>;
          if (seen.has(objectValue)) return false;
          seen.add(objectValue);
          if (isBridged(objectValue)) return true;
          if (!isContainer(objectValue)) return false;
          for (const key of Object.keys(objectValue)) {
            if (containsBridged(objectValue[key], seen)) return true;
          }
          return false;
        };
        const materialize = (value: unknown, seen: WeakMap<object, unknown>): unknown => {
          if (value === null || typeof value !== "object") return value;
          const objectValue = value as Record<string, unknown>;
          if (seen.has(objectValue)) return seen.get(objectValue);
          if (Array.isArray(objectValue)) {
            const out = new Array(objectValue.length) as unknown[] & Record<string, unknown>;
            seen.set(objectValue, out);
            for (const key of Object.keys(objectValue)) {
              out[key] = materialize(objectValue[key], seen);
            }
            return out;
          }
          const proto: object | null = Object.getPrototypeOf(objectValue);
          if (
            proto === Object.prototype ||
            proto === null ||
            (isBridged(objectValue) && isBridged(proto))
          ) {
            const out: Record<string, unknown> = {};
            seen.set(objectValue, out);
            for (const key of Object.keys(objectValue)) {
              out[key] = materialize(objectValue[key], seen);
            }
            return out;
          }
          return objectValue;
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

    // jsg's decode rejects a boa typed array, which reaches V8 as our proxy;
    // decode a copy of the bytes it views instead (protobuf runtimes on boa).
    {
      const proto: unknown = NativeTextDecoder?.prototype;
      const nativeDecode: unknown =
        typeof proto === "object" && proto !== null ? Reflect.get(proto, "decode") : undefined;
      if (typeof proto === "object" && proto !== null && typeof nativeDecode === "function") {
        Reflect.set(
          proto,
          "decode",
          function decode(this: unknown, input?: unknown, options?: unknown): unknown {
            if (
              typeof input === "object" &&
              input !== null &&
              !ArrayBuffer.isView(input) &&
              !(input instanceof ArrayBuffer)
            ) {
              const bytes = ks_bridge_buffer_bytes(input);
              if (bytes !== undefined) input = bytes;
            }
            return Reflect.apply(nativeDecode, this, [input, options]);
          },
        );
      }
    }

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

    if (typeof ksGlobal.crypto === "object" && ksGlobal.crypto !== null) {
      const cryptoObj: any = ksGlobal.crypto;
      installBoundShadow(cryptoObj, "getRandomValues", cryptoObj);
      installBoundShadow(cryptoObj, "randomUUID", cryptoObj);
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
          Object.defineProperty(subtle, "generateKey", {
            value: async function generateKey(
              algorithm: unknown,
              ...rest: unknown[]
            ): Promise<unknown> {
              const name = algName(algorithm).toUpperCase();
              const entry = GEN_SUPPORTED_UC.get(name);
              if (!entry) {
                if (GEN_PASSTHROUGH.has(name)) {
                  return nativeGenerateKey(algorithm, ...rest);
                }
                throw new DOMException(
                  `Unrecognized or unsupported generateKey algorithm '${algName(algorithm)}'.`,
                  "NotSupportedError",
                );
              }
              if (entry.hash) {
                const hash = (algorithm as { hash?: unknown }).hash;
                if (hash !== undefined) {
                  const hashName = algName(hash).toUpperCase();
                  if (!DIGESTS.has(hashName)) {
                    throw new DOMException(
                      `Unrecognized hash algorithm '${algName(hash)}'.`,
                      "NotSupportedError",
                    );
                  }
                }
              }
              return nativeGenerateKey(algorithm, ...rest);
            },
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
      }
    }

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

    {
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
          private _ensure(): AbortController | null {
            if (this._real) return this._real;
            try {
              const controller = new NativeAbortController();
              for (const [type, listener, options] of this._listeners) {
                try {
                  controller.signal.addEventListener(type, listener, options);
                } catch {}
              }
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
          abort(reason?: unknown) {
            if (this._real) return this._real.abort(reason as any);
            if (this._aborted) return;
            this._aborted = true;
            this._reason = reason ?? new DOMException("The operation was aborted.", "AbortError");
            const event = { type: "abort", target: this._fakeSignal };
            for (const [type, listener] of this._listeners) {
              if (type !== "abort") continue;
              try {
                listener.call(this._fakeSignal, event);
              } catch {}
            }
            if (this._fakeSignal && typeof this._fakeSignal.onabort === "function") {
              try {
                this._fakeSignal.onabort(event);
              } catch {}
            }
          }
        }
        try {
          ksGlobal.AbortController = LazyAbortController;
        } catch {}
      }

      const realCrypto: Crypto | undefined = ksGlobal.crypto;
      if (
        realCrypto &&
        typeof realCrypto.getRandomValues === "function" &&
        !(realCrypto as any).__ks_wrapped
      ) {
        let fallbackCounter = 0;
        const isDisallowed = (error: unknown): boolean => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return errorMessage.includes("Disallowed operation called within global scope");
        };
        const realGetRandomValues = realCrypto.getRandomValues.bind(realCrypto);
        const realRandomUUID =
          typeof realCrypto.randomUUID === "function"
            ? realCrypto.randomUUID.bind(realCrypto)
            : null;
        const wrappedCrypto = new Proxy(realCrypto, {
          get(target, prop) {
            if (prop === "getRandomValues") {
              return function (view: any) {
                if (view && !ArrayBuffer.isView(view) && typeof view.length === "number") {
                  const byteLength = view.length >>> 0;
                  const bytes = new Uint8Array(byteLength);
                  try {
                    realGetRandomValues(bytes);
                  } catch (error) {
                    if (!isDisallowed(error)) throw error;
                    let randomState = ++fallbackCounter;
                    for (let i = 0; i < byteLength; i++) {
                      randomState = (randomState * 1103515245 + 12345) & 0x7fffffff;
                      bytes[i] = randomState & 0xff;
                    }
                  }
                  for (let i = 0; i < byteLength; i++) view[i] = bytes[i];
                  return view;
                }
                try {
                  return realGetRandomValues(view);
                } catch (error) {
                  if (!isDisallowed(error)) throw error;
                  if (view && typeof view.length === "number") {
                    let randomState = ++fallbackCounter;
                    for (let i = 0; i < view.length; i++) {
                      randomState = (randomState * 1103515245 + 12345) & 0x7fffffff;
                      view[i] = randomState & 0xff;
                    }
                  }
                  return view;
                }
              };
            }
            if (prop === "randomUUID" && realRandomUUID) {
              return function () {
                try {
                  return realRandomUUID();
                } catch (e) {
                  if (!isDisallowed(e)) throw e;
                  const uuidSuffix = (++fallbackCounter).toString(16).padStart(12, "0");
                  return "00000000-0000-4000-8000-" + uuidSuffix.slice(-12);
                }
              };
            }
            const propertyValue = (target as any)[prop];
            return typeof propertyValue === "function" ? propertyValue.bind(target) : propertyValue;
          },
        });
        (wrappedCrypto as any).__ks_wrapped = true;
        try {
          ksGlobal.crypto = wrappedCrypto;
        } catch {
          try {
            Object.defineProperty(globalThis, "crypto", {
              value: wrappedCrypto,
              writable: true,
              configurable: true,
              enumerable: true,
            });
          } catch {}
        }
      }
    }

    if (
      typeof globalThis.BroadcastChannel !== "function" ||
      !(globalThis.BroadcastChannel.prototype as any)?.postMessage
    ) {
      const EventTargetConstructor = ksGlobal.EventTarget;
      if (typeof EventTargetConstructor === "function") {
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
        try {
          ksGlobal.BroadcastChannel = BroadcastChannel;
        } catch {}
      }
    }

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
      if (typeof NativeDOMException === "function") {
        try {
          Object.setPrototypeOf(NativeDOMException.prototype, DOMException.prototype);
          Object.defineProperty(NativeDOMException.prototype, "constructor", {
            value: DOMException,
            writable: true,
            enumerable: false,
            configurable: true,
          });
        } catch {}
      }
      try {
        (globalThis as any).DOMException = DOMException;
      } catch {}
    }

    installMessageChannel(ksGlobal, () => ksEventCtors.MessageEvent, queuePortTask);

    for (const eventName of Object.keys(built)) {
      if (eventName === "Event" || eventName.endsWith("Event")) {
        ksEventCtors[eventName] = (built as Record<string, unknown>)[eventName];
      }
    }
    if (built.Event) ksGlobal.Event = built.Event;
    if (built.CustomEvent) ksGlobal.CustomEvent = built.CustomEvent;
    if (built.SubmitEvent) globalThis.SubmitEvent = built.SubmitEvent;
    if (built.FormData) ksGlobal.FormData = built.FormData;
    if (built.UIEvent) globalThis.UIEvent = built.UIEvent;
    if (built.FocusEvent) globalThis.FocusEvent = built.FocusEvent;
    if (built.WheelEvent) globalThis.WheelEvent = built.WheelEvent;
    if (built.CompositionEvent) globalThis.CompositionEvent = built.CompositionEvent;
    if (built.InputEvent) globalThis.InputEvent = built.InputEvent;
    if (built.MouseEvent) globalThis.MouseEvent = built.MouseEvent;
    if (built.PointerEvent) globalThis.PointerEvent = built.PointerEvent;
    if (built.KeyboardEvent) globalThis.KeyboardEvent = built.KeyboardEvent;
    if (built.HashChangeEvent) globalThis.HashChangeEvent = built.HashChangeEvent;
    if (built.PopStateEvent) globalThis.PopStateEvent = built.PopStateEvent;
    if (built.PageTransitionEvent) globalThis.PageTransitionEvent = built.PageTransitionEvent;
    if (built.TransitionEvent) globalThis.TransitionEvent = built.TransitionEvent;
    if (built.AnimationEvent) globalThis.AnimationEvent = built.AnimationEvent;
    if (built.Animation) ksGlobal.Animation = built.Animation;
    if (built.AnimationEffect) ksGlobal.AnimationEffect = built.AnimationEffect;
    if (built.KeyframeEffect) ksGlobal.KeyframeEffect = built.KeyframeEffect;
    if (built.AnimationTimeline) ksGlobal.AnimationTimeline = built.AnimationTimeline;
    if (built.DocumentTimeline) ksGlobal.DocumentTimeline = built.DocumentTimeline;
    if (built.AnimationPlaybackEvent)
      ksGlobal.AnimationPlaybackEvent = built.AnimationPlaybackEvent;
    if (built.BeforeUnloadEvent) globalThis.BeforeUnloadEvent = built.BeforeUnloadEvent;
    if (built.DeviceMotionEvent) globalThis.DeviceMotionEvent = built.DeviceMotionEvent;
    if (built.DeviceMotionEventAcceleration)
      globalThis.DeviceMotionEventAcceleration = built.DeviceMotionEventAcceleration;
    if (built.DeviceMotionEventRotationRate)
      globalThis.DeviceMotionEventRotationRate = built.DeviceMotionEventRotationRate;
    if (built.DeviceOrientationEvent)
      globalThis.DeviceOrientationEvent = built.DeviceOrientationEvent;
    if (built.DragEvent) globalThis.DragEvent = built.DragEvent;
    if (built.MessageEvent) ksGlobal.MessageEvent = built.MessageEvent;
    if (built.StorageEvent) globalThis.StorageEvent = built.StorageEvent;
    if (built.TextEvent) globalThis.TextEvent = built.TextEvent;
    if (built.TouchEvent) globalThis.TouchEvent = built.TouchEvent;
    if (built.ErrorEvent) ksGlobal.ErrorEvent = built.ErrorEvent;
    if (built.PromiseRejectionEvent) ksGlobal.PromiseRejectionEvent = built.PromiseRejectionEvent;
    if (built.Element) globalThis.Element = built.Element;
    if (built.HTMLElement) globalThis.HTMLElement = built.HTMLElement;
    if (built.Node) globalThis.Node = built.Node;
    if (built.Window) globalThis.Window = built.Window;
    if (built.ModelContext) globalThis.ModelContext = built.ModelContext;
    for (const [name, cls] of Object.entries(built.htmlElementInterfaces ?? {})) {
      Reflect.set(globalThis, name, cls);
    }
    try {
      const builtSvg: unknown = built ? Reflect.get(built, "SVGElement") : undefined;
      const builtElement: unknown = built ? Reflect.get(built, "Element") : undefined;
      const __svgBase =
        typeof builtSvg === "function"
          ? builtSvg
          : class SVGElement extends ((typeof builtElement === "function"
              ? builtElement
              : Object) as any) {};
      copyHandlerAccessors(__svgBase.prototype, handlerNames("all"));
      Reflect.set(globalThis, "SVGElement", __svgBase);
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
          Reflect.set(globalThis, constructorName, class extends (__svgBase as any) {});
        }
      }
      const svgRoot = Reflect.get(globalThis, "SVGSVGElement");
      copyHandlerAccessors(
        typeof svgRoot === "function" ? svgRoot.prototype : undefined,
        handlerNames("window"),
      );
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
    } catch (error) {
      console.warn("[kitesurf] SVG constructor install failed:", error);
    }
    if (built.EventTarget) {
      const shimProto = built.EventTarget.prototype;
      let shimMethods = shimEventTargetMethods.get(shimProto);
      if (!shimMethods) {
        const addEventListener = shimProto.addEventListener;
        const removeEventListener = shimProto.removeEventListener;
        if (typeof addEventListener === "function" && typeof removeEventListener === "function") {
          shimMethods = { addEventListener, removeEventListener };
          shimEventTargetMethods.set(shimProto, shimMethods);
        }
      }
      // Native receivers keep workerd's listener store; shim receivers use the page implementation.
      for (const name of ["addEventListener", "removeEventListener"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(shimProto, name);
        const shimMethod = shimMethods?.[name];
        const nativeMethod =
          name === "addEventListener" ? nativeEventTargetAdd : nativeEventTargetRemove;
        if (typeof shimMethod !== "function" || typeof nativeMethod !== "function") continue;
        const bridge =
          name === "addEventListener"
            ? function addEventListener(this: unknown, _type: unknown, _listener: unknown) {
                return Reflect.apply(
                  nativeEventTargetPrototype &&
                    objectIsPrototypeOf.call(nativeEventTargetPrototype, this as object)
                    ? nativeMethod
                    : shimMethod,
                  this,
                  arguments,
                );
              }
            : function removeEventListener(this: unknown, _type: unknown, _listener: unknown) {
                return Reflect.apply(
                  nativeEventTargetPrototype &&
                    objectIsPrototypeOf.call(nativeEventTargetPrototype, this as object)
                    ? nativeMethod
                    : shimMethod,
                  this,
                  arguments,
                );
              };
        Object.defineProperty(shimProto, name, { ...descriptor, value: bridge });
      }
      ksGlobal.EventTarget = built.EventTarget;
    }
    if (built.Text) globalThis.Text = built.Text;
    if (built.Comment) globalThis.Comment = built.Comment;
    if (built.CharacterData) globalThis.CharacterData = built.CharacterData;
    if (built.ProcessingInstruction) globalThis.ProcessingInstruction = built.ProcessingInstruction;
    if (built.CDATASection) globalThis.CDATASection = built.CDATASection;
    if (built.DOMParser) globalThis.DOMParser = built.DOMParser;
    if (built.CSSStyleSheet) globalThis.CSSStyleSheet = built.CSSStyleSheet;
    if (built.CSSRule) globalThis.CSSRule = built.CSSRule;
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
      if (built[constructorName]) ksGlobalByKey[constructorName] = built[constructorName];
    }
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
      if (built[constructorName]) ksGlobalByKey[constructorName] = built[constructorName];
    }
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
    if (built.AbstractRange) globalThis.AbstractRange = built.AbstractRange;
    if (built.Range) globalThis.Range = built.Range;
    if (built.StaticRange) globalThis.StaticRange = built.StaticRange;
    if (built.Selection) globalThis.Selection = built.Selection;
    if (built.ValidityState) ksGlobal.ValidityState = built.ValidityState;
    if (built.CanvasRenderingContext2D)
      ksGlobal.CanvasRenderingContext2D = built.CanvasRenderingContext2D;
    if (built.CanvasGradient) ksGlobal.CanvasGradient = built.CanvasGradient;
    if (built.CanvasPattern) ksGlobal.CanvasPattern = built.CanvasPattern;
    if (built.getSelection) globalThis.getSelection = built.getSelection;
    {
      const __nativePerf: Pick<Performance, "now" | "timeOrigin"> | undefined =
        ksGlobal.performance;
      const __nativeNow =
        __nativePerf && typeof __nativePerf.now === "function"
          ? __nativePerf.now.bind(__nativePerf)
          : () => Date.now();
      const __nativeTimeOrigin =
        __nativePerf && typeof __nativePerf.timeOrigin === "number"
          ? __nativePerf.timeOrigin
          : Date.now();

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
          const options = markOptions && typeof markOptions === "object" ? markOptions : {};
          const startTime =
            typeof options.startTime === "number" ? options.startTime : __nativeNow();
          if (startTime < 0) {
            throw new (ksGlobal.DOMException || TypeError)(
              "Failed to construct 'PerformanceMark': '" +
                markName +
                "' cannot have negative startTime.",
              "SyntaxError",
            );
          }
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

      type PerfEntryRecord = {
        name: string;
        entryType: string;
        startTime: number;
        duration: number;
        [field: string]: unknown;
      };
      const __perfEntries: Array<PerformanceEntry | PerfEntryRecord> = [];

      try {
        const __pageUrl =
          win && win.location && typeof win.location.href === "string" ? win.location.href : "";
        __perfEntries.push({
          name: __pageUrl,
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

      const __resolveMark = (markName) => {
        if (typeof markName !== "string") return null;
        for (let i = __perfEntries.length - 1; i >= 0; i--) {
          const entry = __perfEntries[i];
          if (entry.entryType === "mark" && entry.name === markName) return entry;
        }
        if (__navigationTimingMarks.has(markName)) {
          return { entryType: "mark", name: markName, startTime: 0, duration: 0 };
        }
        return null;
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
          let startTime = 0;
          let endTime = __nativeNow();
          let detail = null;
          if (typeof startOrOptions === "object" && startOrOptions !== null) {
            if (typeof startOrOptions.start === "number") {
              startTime = startOrOptions.start;
            } else if (typeof startOrOptions.start === "string") {
              const mark = __resolveMark(startOrOptions.start);
              if (!mark)
                throw new SyntaxError(
                  "Failed to execute 'measure' on 'Performance': The mark '" +
                    startOrOptions.start +
                    "' does not exist.",
                );
              startTime = mark.startTime;
            }
            if (typeof startOrOptions.end === "number") {
              endTime = startOrOptions.end;
            } else if (typeof startOrOptions.end === "string") {
              const mark = __resolveMark(startOrOptions.end);
              if (!mark)
                throw new SyntaxError(
                  "Failed to execute 'measure' on 'Performance': The mark '" +
                    startOrOptions.end +
                    "' does not exist.",
                );
              endTime = mark.startTime;
            } else if (typeof startOrOptions.duration === "number") {
              endTime = startTime + startOrOptions.duration;
            }
            if (startOrOptions.detail !== undefined) detail = startOrOptions.detail;
          } else {
            if (typeof startOrOptions === "string") {
              const mark = __resolveMark(startOrOptions);
              if (!mark)
                throw new SyntaxError(
                  "Failed to execute 'measure' on 'Performance': The mark '" +
                    startOrOptions +
                    "' does not exist.",
                );
              startTime = mark.startTime;
            }
            if (typeof endMark === "string") {
              const mark = __resolveMark(endMark);
              if (!mark)
                throw new SyntaxError(
                  "Failed to execute 'measure' on 'Performance': The mark '" +
                    endMark +
                    "' does not exist.",
                );
              endTime = mark.startTime;
            }
          }
          const entry = new PerformanceMeasure(
            String(name),
            startTime,
            Math.max(0, endTime - startTime),
            detail,
          );
          __perfEntries.push(entry);
          return entry;
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
      try {
        ksGlobal.performance = __perfShim;
      } catch {
        try {
          Object.defineProperty(globalThis, "performance", {
            value: __perfShim,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        } catch {}
      }
    }
    globalThis.getComputedStyle = (el, pseudo) => (win as any).getComputedStyle(el, pseudo);
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
      // A poll on a clean layout reads the committed boxes, since a resolve
      // re-cascades every running animation. Every 4th poll on an animating
      // page resolves anyway, so a size only an animation moves lands within
      // about 1 s. A mutation dirties the layout and lands on the next poll.
      const RESIZE_OBSERVER_ANIMATING_RESOLVE_EVERY = 4;
      const activeResizeObservers = new Set<ResizeObserverShim>();
      let resizeObserverPollTimer: number | null = null;
      let resizeObserverPolledEpoch = -1;
      let resizeObserverResolveWarned = false;
      let resizeObserverPolls = 0;
      const pollResizeObservers = () => {
        if (activeResizeObservers.size === 0) {
          if (resizeObserverPollTimer !== null) {
            try {
              globalThis.clearInterval(resizeObserverPollTimer);
            } catch {}
            resizeObserverPollTimer = null;
          }
          return;
        }
        // A box only resizes through a resolve, and a running CSS animation only advances
        // when someone resolves, so skip only an idle page that nothing relaid out since.
        const dom = state.dom;
        const animating = dom?.isAnimating() === true;
        if (
          resizeObserverLayoutCommitted() &&
          !animating &&
          dom?.layoutEpoch() === resizeObserverPolledEpoch
        )
          return;
        resizeObserverPolledEpoch = -1;
        resizeObserverPolls++;
        const measuredEpoch = pollResizeTargets(
          animating && resizeObserverPolls % RESIZE_OBSERVER_ANIMATING_RESOLVE_EVERY === 0,
        );
        // A callback that relaid out may have moved boxes measured before it
        // ran, so only an epoch nothing advanced past lets the next poll skip.
        const settled =
          measuredEpoch !== -1 &&
          dom?.layoutClean() === true &&
          dom.layoutEpoch() === measuredEpoch;
        resizeObserverPolledEpoch = settled ? measuredEpoch : -1;
      };
      // Returns the layout epoch the measurements read, or -1 if unknown. The
      // first measurement resolves if anything is pending, so the epoch read
      // right after it is the layout every later measurement must match.
      const pollResizeTargets = (forceResolve: boolean): number => {
        let measuredEpoch: number | undefined;
        for (const observer of activeResizeObservers) {
          const changed: ResizeObserverSizes[] = [];
          for (const target of observer._targets) {
            const sizes = measureResizeObserverTarget(target, forceResolve);
            forceResolve = false;
            if (measuredEpoch === undefined) {
              const dom = state.dom;
              measuredEpoch = dom?.layoutClean() === true ? dom.layoutEpoch() : -1;
            }
            const lastSize = observer._last.get(target);
            // Watch BOTH boxes: a padding-only change moves the border box
            // while the content box stands still, and vice versa.
            const moved =
              !lastSize ||
              Math.abs(lastSize.w - sizes.w) > RESIZE_OBSERVER_SIZE_TOLERANCE_PX ||
              Math.abs(lastSize.h - sizes.h) > RESIZE_OBSERVER_SIZE_TOLERANCE_PX ||
              Math.abs(lastSize.bw - sizes.bw) > RESIZE_OBSERVER_SIZE_TOLERANCE_PX ||
              Math.abs(lastSize.bh - sizes.bh) > RESIZE_OBSERVER_SIZE_TOLERANCE_PX;
            if (moved) {
              observer._last.set(target, sizes);
              changed.push(sizes);
            }
          }
          if (changed.length) {
            try {
              observer._cb(changed.map(resizeObserverEntry), observer);
            } catch {}
          }
        }
        return measuredEpoch ?? -1;
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
      interface ResizeObserverSizes {
        target: unknown;
        w: number;
        h: number;
        bw: number;
        bh: number;
      }
      interface ResizeObserverShim {
        _cb: (entries: unknown[], observer: ResizeObserverShim) => void;
        _targets: Set<unknown>;
        _last: Map<unknown, ResizeObserverSizes>;
      }
      const ResizeObserverStub = function (this: ResizeObserverShim, callback) {
        this._cb = callback;
        this._targets = new Set();
        this._last = new Map();
      };
      // One wasm read per target. The CSSOM path below is only the fallback
      // for a target the layout cannot answer for. A clean layout at the
      // current viewport is read as committed unless the caller forces a
      // resolve; a callback that mutated the DOM dirties it again.
      const resizeObserverLayoutCommitted = () =>
        state.dom?.layoutClean() === true &&
        state.paintCacheViewportW === state.paintViewportW &&
        state.paintCacheViewportH === state.paintViewportH;
      const measureResizeObserverTarget = (
        target: unknown,
        forceResolve: boolean,
      ): ResizeObserverSizes => {
        const nodeId: unknown =
          typeof target === "object" && target !== null ? Reflect.get(target, "_id") : undefined;
        if (typeof nodeId === "number") {
          const resolve = forceResolve || !resizeObserverLayoutCommitted();
          try {
            const dom = resolve ? ensurePaintDom() : state.dom;
            const [w, h, bw, bh] = dom?.resizeObserverBoxes(nodeId, resolve) ?? [];
            if (w !== undefined && h !== undefined && bw !== undefined && bh !== undefined) {
              return { target, w, h, bw, bh };
            }
          } catch (error) {
            // A panicked resolve has already recovered; the CSSOM read below
            // measures what it left. Warn once so a broken poll is not silent.
            if (!resizeObserverResolveWarned)
              console.warn("[kitesurf] ResizeObserver poll: layout failed", error);
            resizeObserverResolveWarned = true;
            invalidatePaintDom();
          }
        }
        return measureResizeObserverTargetFromCssom(target);
      };
      interface ResizeObserverCssomTarget {
        getBoundingClientRect(): { width: number; height: number };
        clientWidth?: unknown;
        clientHeight?: unknown;
      }
      const isResizeObserverCssomTarget = (target: unknown): target is ResizeObserverCssomTarget =>
        typeof target === "object" &&
        target !== null &&
        typeof Reflect.get(target, "getBoundingClientRect") === "function";
      // A border-box request must not receive content-box numbers.
      const measureResizeObserverTargetFromCssom = (target: unknown): ResizeObserverSizes => {
        let borderWidth = 0;
        let borderHeight = 0;
        let width = 0;
        let height = 0;
        if (!isResizeObserverCssomTarget(target)) {
          return { target, w: width, h: height, bw: borderWidth, bh: borderHeight };
        }
        try {
          const rect = target.getBoundingClientRect();
          borderWidth = rect.width;
          borderHeight = rect.height;
          width = borderWidth;
          height = borderHeight;
          // contentRect is the content box; clientWidth and clientHeight are the
          // padding box, so take the padding back off.
          const computedStyle = globalThis.getComputedStyle
            ? globalThis.getComputedStyle(target)
            : null;
          const parsePixels = (value) => (value ? parseFloat(value) || 0 : 0);
          if (computedStyle && typeof target.clientWidth === "number" && target.clientWidth > 0) {
            width = Math.max(
              0,
              target.clientWidth -
                parsePixels(computedStyle.paddingLeft) -
                parsePixels(computedStyle.paddingRight),
            );
            height = Math.max(
              0,
              Number(target.clientHeight) -
                parsePixels(computedStyle.paddingTop) -
                parsePixels(computedStyle.paddingBottom),
            );
          }
        } catch {}
        return { target, w: width, h: height, bw: borderWidth, bh: borderHeight };
      };
      const resizeObserverEntry = ({
        target,
        w: width,
        h: height,
        bw,
        bh,
      }: ResizeObserverSizes) => {
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
          borderBoxSize: [{ inlineSize: bw, blockSize: bh }],
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
            const sizes = measureResizeObserverTarget(target, true);
            observer._last.set(target, sizes);
            try {
              observer._cb([resizeObserverEntry(sizes)], observer);
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
    if (typeof globalThis.Image !== "function") {
      const Image = function Image(width, height) {
        if (new.target === undefined) {
          throw new TypeError("Failed to construct 'Image': Please use the 'new' operator");
        }
        const imageElement = document.createElement("img");
        if (width !== undefined) {
          try {
            imageElement.width = width;
          } catch {}
        }
        if (height !== undefined) {
          try {
            imageElement.height = height;
          } catch {}
        }
        return imageElement;
      };
      const HTMLImageElement = ksGlobal.HTMLImageElement;
      if (HTMLImageElement && HTMLImageElement.prototype) {
        Object.defineProperty(Image, "prototype", {
          value: HTMLImageElement.prototype,
          writable: false,
          enumerable: false,
          configurable: false,
        });
      }
      globalThis.Image = Image;
    }
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
    if (typeof globalThis.Option !== "function") {
      const Option = function Option(text, value, defaultSelected, selected) {
        const option = document.createElement("option");
        if (text !== undefined) {
          try {
            option.text = String(text);
          } catch {}
        }
        if (value !== undefined) {
          try {
            option.setAttribute("value", String(value));
          } catch {}
        }
        if (defaultSelected) {
          try {
            option.setAttribute("selected", "");
          } catch {}
        }
        try {
          (option as any).__ksSetSelectednessUndirty(!!selected);
        } catch {}
        return option;
      };
      globalThis.Option = Option;
    }
    if (
      typeof ksGlobal.OffscreenCanvas !== "function" ||
      typeof ksGlobal.OffscreenCanvas?.prototype?.getContext !== "function"
    ) {
      const OffscreenCanvas = function OffscreenCanvas(this: object, width: any, height: any) {
        if (new.target === undefined) {
          throw new TypeError(
            "Failed to construct 'OffscreenCanvas': Please use the 'new' operator",
          );
        }
        if (arguments.length < 2) {
          throw new TypeError(
            "Failed to construct 'OffscreenCanvas': 2 arguments required, but only " +
              arguments.length +
              " present.",
          );
        }
        const canvas = document.createElement("canvas");
        try {
          canvas.width = Number(width) || 0;
        } catch {}
        try {
          canvas.height = Number(height) || 0;
        } catch {}
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
    const ksCanonicalize = (css: string) => {
      try {
        return ks_parse_inline_style(css);
      } catch {
        return [];
      }
    };
    const declSupported = (name: string, value: string): boolean => {
      try {
        const decls = ksCanonicalize(`${name}: ${value}`);
        if (Array.isArray(decls) && decls.length > 0) return true;
        return name.startsWith("--") && value.trim() !== "";
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
    const matchParen = (text: string, openParenIndex: number): number => {
      let depth = 0;
      let quote: string | null = null;
      for (let index = openParenIndex; index < text.length; index++) {
        const character = text[index];
        if (quote) {
          if (character === "\\") index++;
          else if (character === quote) quote = null;
          continue;
        }
        if (character === '"' || character === "'") quote = character;
        else if (character === "(") depth++;
        else if (character === ")") {
          depth--;
          if (depth === 0) return index + 1;
        }
      }
      return -1;
    };
    type Tri = boolean | "unknown";
    const evalCondition = (condition: string): Tri | null => {
      let cursor = 0;
      const skipWhitespace = () => {
        while (cursor < condition.length && /\s/.test(condition[cursor])) cursor++;
      };
      const parseInParens = (): Tri | null => {
        skipWhitespace();
        const remainingCondition = condition.slice(cursor);
        const functionMatch = /^([a-zA-Z][a-zA-Z0-9-]*)\(/.exec(remainingCondition);
        if (functionMatch) {
          const openParenIndex = cursor + functionMatch[1].length;
          const endIndex = matchParen(condition, openParenIndex);
          if (endIndex < 0) return null;
          const innerCondition = condition.slice(openParenIndex + 1, endIndex - 1);
          cursor = endIndex;
          if (functionMatch[1].toLowerCase() === "selector") {
            return selectorSupported(innerCondition);
          }
          return "unknown";
        }
        if (condition[cursor] !== "(") return null;
        const endIndex = matchParen(condition, cursor);
        if (endIndex < 0) return null;
        const innerCondition = condition.slice(cursor + 1, endIndex - 1);
        cursor = endIndex;
        const nested = evalCondition(innerCondition);
        if (nested !== null) return nested;
        const colon = innerCondition.indexOf(":");
        if (colon > 0) {
          const name = innerCondition.slice(0, colon).trim();
          if (/^-{0,2}[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
            return declSupported(name, innerCondition.slice(colon + 1).trim());
          }
        }
        return "unknown";
      };
      skipWhitespace();
      if (/^not(?![a-zA-Z0-9_-])/i.test(condition.slice(cursor))) {
        cursor += 3;
        const conditionValue = parseInParens();
        if (conditionValue === null) return null;
        skipWhitespace();
        if (cursor < condition.length) return null;
        return conditionValue === "unknown" ? "unknown" : !conditionValue;
      }
      let result = parseInParens();
      if (result === null) return null;
      skipWhitespace();
      let combinator: "and" | "or" | null = null;
      while (cursor < condition.length) {
        const keywordMatch = /^(and|or)(?![a-zA-Z0-9_-])/i.exec(condition.slice(cursor));
        if (!keywordMatch) return null;
        const keyword = keywordMatch[1].toLowerCase() as "and" | "or";
        if (combinator && keyword !== combinator) return null;
        combinator = keyword;
        cursor += keyword.length;
        const conditionValue = parseInParens();
        if (conditionValue === null) return null;
        if (keyword === "and") {
          if (result === false || conditionValue === false) result = false;
          else if (result === "unknown" || conditionValue === "unknown") result = "unknown";
        } else {
          if (result === true || conditionValue === true) result = true;
          else if (result === "unknown" || conditionValue === "unknown") result = "unknown";
        }
        skipWhitespace();
      }
      return result;
    };
    ksGlobal.CSS = {
      escape(identifier: any) {
        return String(identifier).replace(/[^a-zA-Z0-9_-]/g, (character) => "\\" + character);
      },
      supports(propertyOrCondition: any, value?: any) {
        if (typeof propertyOrCondition === "string" && typeof value === "string") {
          return declSupported(propertyOrCondition, value);
        }
        if (typeof propertyOrCondition === "string") {
          const conditionResult = evalCondition(propertyOrCondition);
          if (conditionResult !== null) return conditionResult === true;
          const colon = propertyOrCondition.indexOf(":");
          if (colon > 0) {
            return declSupported(
              propertyOrCondition.slice(0, colon).trim(),
              propertyOrCondition.slice(colon + 1).trim(),
            );
          }
        }
        return false;
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
      ksGlobal.CSS[unit] = (value: number) => new built.CSSUnitValue(value, unit);
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
    if (typeof globalThis.matchMedia !== "function") {
      const MEDIA_QUERY_EM_REFERENCE_PX = 16;
      const MEDIA_QUERY_PERCENT_SCALE = 100;
      const MEDIA_QUERY_DPI_PER_DPPX = 96;
      const MEDIA_QUERY_DPCM_PER_DPPX = 37.7953;
      const mediaState = {
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
          return state.darkColorScheme ? "dark" : "light";
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
            return (numericValue / MEDIA_QUERY_PERCENT_SCALE) * mediaState.width;
          case "vh":
            return (numericValue / MEDIA_QUERY_PERCENT_SCALE) * mediaState.height;
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
        const widthMatch = name.match(/^(min-|max-)?(device-)?width$/);
        if (widthMatch) {
          const requestedWidth = parseLength(value);
          if (isNaN(requestedWidth)) return false;
          if (name.startsWith("min-")) return mediaState.width >= requestedWidth;
          if (name.startsWith("max-")) return mediaState.width <= requestedWidth;
          return mediaState.width === requestedWidth;
        }
        const heightMatch = name.match(/^(min-|max-)?(device-)?height$/);
        if (heightMatch) {
          const requestedHeight = parseLength(value);
          if (isNaN(requestedHeight)) return false;
          if (name.startsWith("min-")) return mediaState.height >= requestedHeight;
          if (name.startsWith("max-")) return mediaState.height <= requestedHeight;
          return mediaState.height === requestedHeight;
        }
        if (name === "orientation") {
          const portrait = mediaState.height >= mediaState.width;
          return value === "portrait" ? portrait : value === "landscape" ? !portrait : false;
        }
        if (name === "prefers-color-scheme") {
          return value === mediaState.colorScheme;
        }
        if (name === "prefers-reduced-motion") {
          return value === mediaState.reducedMotion;
        }
        if (name === "prefers-contrast") {
          return value === mediaState.contrast;
        }
        if (name === "hover" || name === "any-hover") {
          return value === mediaState.hover;
        }
        if (name === "pointer" || name === "any-pointer") {
          return value === mediaState.pointer;
        }
        if (/^(min-|max-)?resolution$/.test(name)) {
          const resolution = parseResolution(value);
          if (isNaN(resolution)) return false;
          if (name.startsWith("min-")) return mediaState.dpr >= resolution;
          if (name.startsWith("max-")) return mediaState.dpr <= resolution;
          return mediaState.dpr === resolution;
        }
        if (name === "display-mode") return value === mediaState.displayMode;
        if (name === "forced-colors") return value === mediaState.forcedColors;
        if (/^(min-|max-)?color$/.test(name)) {
          const colorBits = parseInt(value, 10);
          if (isNaN(colorBits)) return mediaState.colorBits > 0;
          if (name.startsWith("min-")) return mediaState.colorBits >= colorBits;
          if (name.startsWith("max-")) return mediaState.colorBits <= colorBits;
          return mediaState.colorBits === colorBits;
        }
        return false;
      };

      const evalMediaType = (mediaType: string): boolean => {
        if (mediaType === "all") return true;
        if (mediaType === mediaState.mediaType) return true;
        return false;
      };

      const evalQuery = (querySource: string): boolean => {
        let query = querySource.trim().toLowerCase();
        if (!query) return true;
        let negated = false;
        if (query.startsWith("not ")) {
          negated = true;
          query = query.slice(4).trim();
        } else if (query.startsWith("only ")) {
          query = query.slice(5).trim();
        }
        const parts: string[] = [];
        let depth = 0,
          partStart = 0;
        for (let i = 0; i < query.length; i++) {
          const character = query[i];
          if (character === "(") depth++;
          else if (character === ")") depth--;
          else if (depth === 0 && query.startsWith(" and ", i)) {
            parts.push(query.slice(partStart, i).trim());
            i += 4;
            partStart = i + 1;
          }
        }
        parts.push(query.slice(partStart).trim());

        let result = true;
        for (const part of parts) {
          if (!part) continue;
          if (part.startsWith("(") && part.endsWith(")")) {
            if (!evalFeature(part)) {
              result = false;
              break;
            }
          } else {
            if (!evalMediaType(part)) {
              result = false;
              break;
            }
          }
        }
        return negated ? !result : result;
      };

      const evalQueryList = (queryList: string): boolean => {
        const queries: string[] = [];
        let depth = 0,
          partStart = 0;
        for (let i = 0; i < queryList.length; i++) {
          const character = queryList[i];
          if (character === "(") depth++;
          else if (character === ")") depth--;
          else if (character === "," && depth === 0) {
            queries.push(queryList.slice(partStart, i));
            partStart = i + 1;
          }
        }
        queries.push(queryList.slice(partStart));
        for (const query of queries) if (evalQuery(query)) return true;
        return false;
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
    if (typeof globalThis.HTMLElement === "function") {
      const Base = globalThis.HTMLElement;
      const upgradeTargets: Array<{ target: any; consumed: boolean }> = [];
      const htmlInterfaces: readonly unknown[] = Object.values(built.htmlElementInterfaces ?? {});
      const shimElementClasses = new WeakSet<object>(
        htmlInterfaces.filter((cls): cls is object => typeof cls === "function"),
      );
      const Patched = class extends Base {
        constructor(...args: unknown[]) {
          if (shimElementClasses.has(new.target)) {
            super(...args);
            return;
          }
          const frame = upgradeTargets[upgradeTargets.length - 1];
          if (frame && !frame.consumed) {
            frame.consumed = true;
            return frame.target;
          }
          const tag = ctorTagNames.get(new.target);
          const mint = ksInternals.createElementNoUpgrade;
          if (tag && typeof mint === "function") {
            const element = mint(tag);
            if (element) {
              Object.setPrototypeOf(element, new.target.prototype);
              return element;
            }
          }
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
      copyHandlerAccessors(Patched.prototype, handlerNames("all"));
      for (const cls of htmlInterfaces) {
        if (typeof cls !== "function") continue;
        if (Object.getPrototypeOf(cls) === Base) Object.setPrototypeOf(cls, Patched);
        if (Object.getPrototypeOf(cls.prototype) === Base.prototype) {
          Object.setPrototypeOf(cls.prototype, Patched.prototype);
        }
      }
      globalThis.HTMLElement = Patched;
    }
    if (typeof globalThis.customElements !== "object") {
      const registry = new Map();
      const observedAttributes = new WeakMap<object, Set<string>>();
      const attributeChangedCallbacks = new WeakMap<object, Function>();
      const upgradingElements = new WeakSet<object>();
      const failedElements = new WeakSet<object>();
      const queuedAttributeChanges = new WeakMap<object, any[][]>();
      const whenDefinedResolvers = new Map();
      const upgradeCustomElement = (
        element: any,
        customElementConstructor: any,
        options: { tagName?: string; fireConnectedCallback?: boolean } = {},
      ): void => {
        const tagName = options.tagName ?? "?";
        try {
          if (customElementConstructor.prototype.isPrototypeOf(element)) return;
          const initialAttributes = (Array.from(element.attributes || []) as any[]).map((attr) => ({
            name: String(attr.localName || attr.name || ""),
            value: String(attr.value),
            namespace: attr.namespaceURI ?? null,
          }));
          Object.setPrototypeOf(element, customElementConstructor.prototype);
          const htmlElementConstructor = globalThis.HTMLElement;
          let constructed = true;
          upgradingElements.add(element);
          if (htmlElementConstructor && "_upgradeTarget" in htmlElementConstructor) {
            (htmlElementConstructor as any)._upgradeTarget = element;
            try {
              new customElementConstructor();
            } catch (error) {
              constructed = false;
              console.warn(
                "[kitesurf] custom-element constructor for " + tagName + " threw",
                error,
              );
            } finally {
              (htmlElementConstructor as any)._upgradeTarget = null;
            }
          } else {
            try {
              customElementConstructor.call(element);
            } catch {
              try {
                customElementConstructor.prototype.constructor.call(element);
              } catch {
                constructed = false;
              }
            }
          }
          upgradingElements.delete(element);
          if (!constructed) {
            failedElements.add(element);
            queuedAttributeChanges.delete(element);
            return;
          }
          const observed = observedAttributes.get(customElementConstructor);
          const attributeChanged = attributeChangedCallbacks.get(customElementConstructor);
          if (observed && attributeChanged) {
            for (const attr of initialAttributes) {
              if (!observed.has(attr.name)) continue;
              try {
                attributeChanged.call(element, attr.name, null, attr.value, attr.namespace);
              } catch (error) {
                console.warn(
                  "[kitesurf] attributeChangedCallback for " + tagName + " threw",
                  error,
                );
              }
            }
            for (const args of queuedAttributeChanges.get(element) || []) {
              try {
                attributeChanged.call(element, ...args);
              } catch (error) {
                console.warn(
                  "[kitesurf] attributeChangedCallback for " + tagName + " threw",
                  error,
                );
              }
            }
          }
          queuedAttributeChanges.delete(element);
          if (options.fireConnectedCallback && typeof element.connectedCallback === "function") {
            try {
              element.connectedCallback();
            } catch (error) {
              console.warn("[kitesurf] connectedCallback for " + tagName + " threw", error);
            }
          }
        } catch (error) {
          console.warn("[kitesurf] custom element upgrade failed for " + tagName, error);
        }
      };
      ksInternals.upgradeCustomElement = (element: any, tagName: string): void => {
        const customElementConstructor = registry.get(tagName);
        if (typeof customElementConstructor !== "function") return;
        upgradeCustomElement(element, customElementConstructor, {
          tagName,
          fireConnectedCallback: false,
        });
      };
      ksInternals.notifyCustomElementAttributeChanged = (
        element: any,
        name: string,
        oldValue: string | null,
        newValue: string | null,
        namespace: string | null,
      ): void => {
        const tagName = String(element?.localName || "");
        const customElementConstructor = registry.get(tagName);
        const observed =
          customElementConstructor && observedAttributes.get(customElementConstructor);
        const attributeChanged =
          customElementConstructor && attributeChangedCallbacks.get(customElementConstructor);
        if (
          !observed?.has(name) ||
          !customElementConstructor?.prototype.isPrototypeOf(element) ||
          !attributeChanged ||
          failedElements.has(element)
        ) {
          return;
        }
        if (upgradingElements.has(element)) {
          const queued = queuedAttributeChanges.get(element) || [];
          queued.push([name, oldValue, newValue, namespace]);
          queuedAttributeChanges.set(element, queued);
          return;
        }
        try {
          attributeChanged.call(element, name, oldValue, newValue, namespace);
        } catch (error) {
          console.warn("[kitesurf] attributeChangedCallback for " + tagName + " threw", error);
        }
      };
      ksInternals.customElementObservesAttribute = (element: any, name: string): boolean => {
        const customElementConstructor = registry.get(String(element?.localName || ""));
        return !!(
          customElementConstructor &&
          observedAttributes.get(customElementConstructor)?.has(name) &&
          customElementConstructor.prototype.isPrototypeOf(element) &&
          !failedElements.has(element)
        );
      };
      const MAX_CUSTOM_ELEMENT_SHADOW_DEPTH = 16;
      const MAX_CUSTOM_ELEMENT_CONNECTION_DEPTH = 64;
      const pendingUpgrades: Array<{
        tagName: string;
        customElementConstructor: any;
      }> = [];
      const collectCustomElements = (tagName: string): any[] => {
        const elements: any[] = [];
        const visitRoot = (root: any, shadowDepth: number) => {
          if (shadowDepth > MAX_CUSTOM_ELEMENT_SHADOW_DEPTH || !root?.querySelectorAll) {
            return;
          }
          try {
            for (const element of root.querySelectorAll(tagName)) elements.push(element);
            for (const element of root.querySelectorAll("*")) {
              if (element.shadowRoot) {
                visitRoot(element.shadowRoot, shadowDepth + 1);
              }
            }
          } catch {}
        };
        visitRoot(document, 0);
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
      state.drainCustomElementUpgrades = drainUpgrades;
      ksInternals.notifyConnected = (rootElement: any) => {
        try {
          if (registry.size === 0) return;
          if (!rootElement || rootElement.nodeType !== 1 || !rootElement.isConnected) return;
          const visit = (element: any, depth: number) => {
            if (depth > MAX_CUSTOM_ELEMENT_CONNECTION_DEPTH) return;
            const tagName = String(element.localName || "");
            if (tagName.indexOf("-") >= 0 && registry.has(tagName)) {
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
            }
            const children = element.children;
            if (children && children.length) {
              for (const child of Array.from(children)) visit(child, depth + 1);
            }
          };
          visit(rootElement, 0);
        } catch {}
      };
      globalThis.customElements = {
        define(tagName, customElementConstructor) {
          if (registry.has(tagName)) return;
          const observedAttributeNames = new Set<string>();
          if (typeof customElementConstructor?.prototype?.attributeChangedCallback === "function") {
            for (const attribute of Array.from(customElementConstructor.observedAttributes || [])) {
              observedAttributeNames.add(String(attribute));
            }
            attributeChangedCallbacks.set(
              customElementConstructor,
              customElementConstructor.prototype.attributeChangedCallback,
            );
          }
          registry.set(tagName, customElementConstructor);
          observedAttributes.set(customElementConstructor, observedAttributeNames);
          try {
            ctorTagNames.set(customElementConstructor, String(tagName));
          } catch {}
          pendingUpgrades.push({ tagName, customElementConstructor });
          const resolvers = whenDefinedResolvers.get(tagName);
          if (resolvers) {
            resolvers.forEach((resolve) => resolve(customElementConstructor));
            whenDefinedResolvers.delete(tagName);
          }
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
    installIdleCallbackGlobals();
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

    if (typeof globalThis.RTCPeerConnection !== "function") {
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
          this._config = configuration || {};
          this._localDescription = null;
          this._remoteDescription = null;
          this._tracks = [];
          this._iceCandidates = [];
          this._dataChannels = [];
          this.connectionState = "new";
          this.iceConnectionState = "new";
          this.iceGatheringState = "new";
          this.signalingState = "stable";
          this.canTrickleIceCandidates = null;
          this.sctp = null;
          this.onconnectionstatechange = null;
          this.oniceconnectionstatechange = null;
          this.onicegatheringstatechange = null;
          this.onsignalingstatechange = null;
          this.onicecandidate = null;
          this.onicecandidateerror = null;
          this.onnegotiationneeded = null;
          this.ontrack = null;
          this.ondatachannel = null;
          const peerConnection = this;
          try {
            setTimeout(() => {
              peerConnection._setConnectionState("connecting");
              setTimeout(() => peerConnection._setConnectionState("failed"), 0);
            }, 0);
          } catch {}
        }
        _fire(name, event?) {
          const handler = this[name];
          if (typeof handler === "function") {
            try {
              handler.call(this, event || new Event(name.slice(2)));
            } catch {}
          }
          const listeners = this._listeners && this._listeners[name.slice(2)];
          if (Array.isArray(listeners)) {
            for (const listener of listeners) {
              try {
                listener.call(this, event || new Event(name.slice(2)));
              } catch {}
            }
          }
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
          init = init || {};
          this.candidate = init.candidate || "";
          this.sdpMid = init.sdpMid || null;
          this.sdpMLineIndex = init.sdpMLineIndex ?? null;
          this.foundation = init.foundation || "";
          this.component = init.component || null;
          this.priority = init.priority || 0;
          this.address = init.address || null;
          this.protocol = init.protocol || null;
          this.port = init.port || 0;
          this.type = init.type || null;
          this.tcpType = init.tcpType || null;
          this.relatedAddress = init.relatedAddress || null;
          this.relatedPort = init.relatedPort || 0;
          this.usernameFragment = init.usernameFragment || null;
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
          this.errorDetail = (init && init.errorDetail) || "";
          this.sdpLineNumber = (init && init.sdpLineNumber) ?? null;
          this.httpRequestStatusCode = (init && init.httpRequestStatusCode) ?? null;
          this.sctpCauseCode = (init && init.sctpCauseCode) ?? null;
          this.receivedAlert = (init && init.receivedAlert) ?? null;
          this.sentAlert = (init && init.sentAlert) ?? null;
        }
      }

      globalThis.RTCPeerConnection = RTCPeerConnectionStub;
      globalThis.webkitRTCPeerConnection = RTCPeerConnectionStub;
      globalThis.mozRTCPeerConnection = RTCPeerConnectionStub;
      globalThis.RTCDataChannel = RTCDataChannelStub;
      globalThis.RTCSessionDescription = RTCSessionDescriptionStub;
      globalThis.RTCIceCandidate = RTCIceCandidateStub;
      globalThis.RTCError = RTCErrorStub;
      if (typeof globalThis.RTCErrorEvent !== "function") {
        globalThis.RTCErrorEvent = class extends Event {
          declare error: any;
          constructor(type, init) {
            super(type, init);
            this.error = (init && init.error) || null;
          }
        };
      }
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
      if (typeof globalThis.RTCDataChannelEvent !== "function") {
        globalThis.RTCDataChannelEvent = class extends Event {
          declare channel: any;
          constructor(type, init) {
            super(type, init);
            this.channel = (init && init.channel) || null;
          }
        };
      }
      if (typeof globalThis.RTCTrackEvent !== "function") {
        globalThis.RTCTrackEvent = class extends Event {
          declare receiver: any;
          declare streams: any;
          declare track: any;
          declare transceiver: any;
          constructor(type, init) {
            super(type, init);
            this.receiver = (init && init.receiver) || null;
            this.track = (init && init.track) || null;
            this.streams = (init && init.streams) || [];
            this.transceiver = (init && init.transceiver) || null;
          }
        };
      }
    }

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
          this._tracks = [];
          if (Array.isArray(initOrTracks)) {
            for (const track of initOrTracks) {
              if (track) this._tracks.push(track);
            }
          } else if (initOrTracks && typeof initOrTracks.getTracks === "function") {
            for (const track of initOrTracks.getTracks()) {
              this._tracks.push(track.clone());
            }
          }
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

    try {
      const navigator: PageNavigator | null | undefined = ksGlobal.navigator;
      // User-Agent Client Hints only exist in Chromium, and must agree with the UA string.
      const ua = typeof navigator?.userAgent === "string" ? navigator.userAgent : "";
      const chromeMajor = /\bChrome\/(\d+)/.exec(ua)?.[1];
      if (navigator && !navigator.userAgentData && chromeMajor) {
        const platform = /\bAndroid\b/.test(ua)
          ? "Android"
          : /\bWindows\b/.test(ua)
            ? "Windows"
            : /\bMac OS X\b|\bMacintosh\b/.test(ua)
              ? "macOS"
              : /\bCrOS\b/.test(ua)
                ? "Chrome OS"
                : /\bLinux\b/.test(ua)
                  ? "Linux"
                  : "";
        const mobile = /\bMobile\b/.test(ua);
        const arm = /\b(arm|aarch64)/i.test(ua);
        const fullVersion = /\bChrome\/([\d.]+)/.exec(ua)?.[1] ?? `${chromeMajor}.0.0.0`;
        const userAgentData = {
          brands: [
            { brand: "Chromium", version: chromeMajor },
            { brand: "Not?A_Brand", version: "24" },
          ],
          mobile,
          platform,
          async getHighEntropyValues(hints: string[]) {
            const full: Record<string, unknown> = {
              brands: this.brands,
              mobile: this.mobile,
              platform: this.platform,
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
            const out: Record<string, unknown> = {
              brands: this.brands,
              mobile: this.mobile,
              platform: this.platform,
            };
            if (Array.isArray(hints)) {
              for (const hint of hints) {
                if (hint in full) out[hint] = full[hint];
              }
            }
            return out;
          },
          toJSON() {
            return { brands: this.brands, mobile: this.mobile, platform: this.platform };
          },
        };
        defineOrAssignFallback(navigator, "userAgentData", {
          value: userAgentData,
          writable: false,
          configurable: true,
          enumerable: true,
        });
      }
    } catch {}

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

    if (built.Element) {
      const ElementBase = built.Element;

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
      if (typeof globalThis.SVGElement !== "function") {
        globalThis.SVGElement = class SVGElement {};
      }
      if (typeof globalThis.SVGSVGElement !== "function") {
        globalThis.SVGSVGElement = class SVGSVGElement {};
      }
    }
    if (built && typeof built.ShadowRoot === "function") {
      globalThis.ShadowRoot = built.ShadowRoot;
    } else if (typeof globalThis.ShadowRoot !== "function") {
      globalThis.ShadowRoot = class {};
    }
    if (built && typeof built.NodeList === "function") {
      globalThis.NodeList = built.NodeList;
    } else if (typeof globalThis.NodeList !== "function") {
      globalThis.NodeList = class {};
    }
    if (built && typeof built.DocumentFragment === "function") {
      globalThis.DocumentFragment = built.DocumentFragment;
    } else if (typeof globalThis.DocumentFragment !== "function") {
      globalThis.DocumentFragment = class {};
    }
    if (built && typeof built.HTMLCollection === "function") {
      globalThis.HTMLCollection = built.HTMLCollection;
    } else if (typeof globalThis.HTMLCollection !== "function") {
      globalThis.HTMLCollection = class {};
    }
    if (built && typeof built.HTMLFormControlsCollection === "function") {
      globalThis.HTMLFormControlsCollection = built.HTMLFormControlsCollection;
    }
    // select.options uses this WebIDL collection constructor.
    if (built && typeof built.HTMLOptionsCollection === "function") {
      globalThis.HTMLOptionsCollection = built.HTMLOptionsCollection;
    }
    if (built && typeof built.RadioNodeList === "function") {
      globalThis.RadioNodeList = built.RadioNodeList;
    }
    if (built && typeof built.DOMTokenList === "function") {
      globalThis.DOMTokenList = built.DOMTokenList;
    } else if (typeof globalThis.DOMTokenList !== "function") {
      globalThis.DOMTokenList = class {};
    }
    if (built && typeof built.NamedNodeMap === "function") {
      globalThis.NamedNodeMap = built.NamedNodeMap;
    } else if (typeof globalThis.NamedNodeMap !== "function") {
      globalThis.NamedNodeMap = class {};
    }
    if (built && typeof built.Attr === "function") {
      globalThis.Attr = built.Attr;
    } else if (typeof globalThis.Attr !== "function") {
      globalThis.Attr = class {};
    }
    if (built && typeof built.Document === "function") {
      globalThis.Document = built.Document;
    } else if (typeof globalThis.Document !== "function") {
      globalThis.Document = class {};
    }
    if (typeof ksGlobal.HTMLDocument !== "function") {
      ksGlobal.HTMLDocument = globalThis.Document;
    }
    if (built && typeof built.XMLDocument === "function") {
      globalThis.XMLDocument = built.XMLDocument;
    } else if (typeof globalThis.XMLDocument !== "function") {
      globalThis.XMLDocument = class {};
    }
    if (built && typeof built.DocumentType === "function") {
      globalThis.DocumentType = built.DocumentType;
    } else if (typeof globalThis.DocumentType !== "function") {
      globalThis.DocumentType = class {};
    }
    if (built && typeof built.DOMImplementation === "function") {
      globalThis.DOMImplementation = built.DOMImplementation;
    } else if (typeof globalThis.DOMImplementation !== "function") {
      globalThis.DOMImplementation = class {};
    }
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
    if (built && typeof built.MutationRecord === "function") {
      globalThis.MutationRecord = built.MutationRecord;
    }
    if (built && built.NodeFilter) globalThis.NodeFilter = built.NodeFilter;
    if (built && typeof built.TreeWalker === "function") {
      globalThis.TreeWalker = built.TreeWalker;
    }
    if (built && typeof built.NodeIterator === "function") {
      globalThis.NodeIterator = built.NodeIterator;
    }
    for (const name of ["XPathResult", "XPathExpression", "XPathEvaluator"]) {
      const constructor: unknown = built ? Reflect.get(built, name) : undefined;
      if (typeof constructor === "function") ksGlobalByKey[name] = constructor;
    }
    installBlobMimeTypeSerialization();
    try {
      installWebSocketFacade();
    } catch {}
    installWorker();
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
          let event: InstanceType<ShimEventCtors["Event"]> | null = null;
          try {
            event = new (shimEventCtor("Event"))(name);
          } catch {}
          const handler = (this as any)["on" + name];
          if (typeof handler === "function") {
            try {
              handler.call(this, event);
            } catch (error) {
              try {
                console.error("XHR on" + name + " threw:", error);
              } catch {}
            }
          }
          if (event) {
            try {
              (this as any).dispatchEvent(event);
            } catch {}
          }
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
          const responseType = this._responseType;
          if (responseType === "" || responseType === "text") return this._text;
          if (this.readyState !== 4) return null;
          if (responseType === "arraybuffer") return this._buf;
          if (responseType === "blob") {
            if (this._blobCache === undefined) {
              const BlobCtor = ksGlobal.Blob;
              this._blobCache =
                this._buf && typeof BlobCtor === "function"
                  ? new BlobCtor([this._buf], { type: this._mimeFor() })
                  : null;
            }
            return this._blobCache;
          }
          if (responseType === "json") {
            if (this._jsonCache === undefined) {
              try {
                this._jsonCache = JSON.parse(this._text);
              } catch {
                this._jsonCache = null;
              }
            }
            return this._jsonCache;
          }
          return null;
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
          const requestMethod = String(method == null ? "" : method).toUpperCase();
          if (
            requestMethod === "CONNECT" ||
            requestMethod === "TRACE" ||
            requestMethod === "TRACK"
          ) {
            throw new ksGlobal.DOMException(
              "XMLHttpRequest.open: forbidden method " + requestMethod,
              "SecurityError",
            );
          }
          const raw = url == null || url === "" ? "about:blank" : String(url);
          let base: string | undefined;
          try {
            base = ksGlobal.document?.baseURI;
          } catch {}
          let resolved;
          try {
            resolved = new URL(raw, base);
          } catch {
            throw new ksGlobal.DOMException(
              "XMLHttpRequest.open: '" + raw + "' is not a valid URL.",
              "SyntaxError",
            );
          }
          try {
            this._ctrl?.abort();
          } catch {}
          this._gen = (this._gen | 0) + 1;
          this._method = requestMethod;
          this._url = resolved.toString();
          this._async = async_ !== false;
          this._reqHeaders = [];
          this._sent = false;
          this._abortedFlag = false;
          this._timedOut = false;
          this.status = 0;
          this.statusText = "";
          this._text = "";
          this._buf = null;
          this._resHeaders = null;
          this._blobCache = undefined;
          this._jsonCache = undefined;
          this._rsc(1);
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
          if (this.readyState !== 1 || this._sent) {
            throw new ksGlobal.DOMException(
              "XMLHttpRequest.send: state is not OPENED",
              "InvalidStateError",
            );
          }
          // Sync XHR cannot be supported: workerd has no primitive that blocks the JS thread on
          // network I/O (no Atomics.wait, threads or nested event loop). The sync WPTs are SKIP.
          if (!this._async) {
            this._sent = true;
            try {
              console.warn("[kitesurf] sync XHR is not supported; send() ignored");
            } catch {}
            return;
          }
          this._sent = true;
          const gen = (this._gen = (this._gen | 0) + 1);
          const live = () => this._gen === gen;
          const url = this._url;
          const method = this._method || "GET";
          this._fire("loadstart");
          const finishError = (kind) => {
            if (!live()) return;
            this.status = 0;
            this._rsc(4);
            this._fire(kind);
            this._fire("loadend");
          };
          if (url && url.slice(0, 5) === "blob:") {
            const blob = state.blobUrls.get(url);
            (async () => {
              try {
                if (!blob || method !== "GET") {
                  finishError("error");
                  return;
                }
                const buf = await blob.arrayBuffer();
                const txt = this._wantsText() ? await blob.text() : "";
                if (!live()) return;
                this.status = 200;
                this.statusText = "OK";
                this.responseURL = url;
                this._resHeaders = new Headers({
                  "content-type": blob.type || "",
                  "content-length": String(blob.size ?? 0),
                });
                this._rsc(2);
                this._rsc(3);
                this._buf = buf;
                this._text = txt;
                this._rsc(4);
                this._fire("load");
                this._fire("loadend");
              } catch {
                finishError("error");
              }
            })();
            return;
          }
          let created: AbortController | null = null;
          try {
            created = new ksGlobal.AbortController();
          } catch {}
          const ctrl = created;
          this._ctrl = ctrl;
          let timeoutTimer: number | null = null;
          if (this.timeout > 0 && ctrl) {
            try {
              timeoutTimer = setTimeout(() => {
                this._timedOut = true;
                try {
                  ctrl.abort();
                } catch {}
              }, this.timeout);
            } catch {}
          }
          const headers = new Headers();
          for (const [n, v] of this._reqHeaders || []) {
            try {
              headers.append(n, v);
            } catch {}
          }
          headers.set("x-kitesurf-credentials", this.withCredentials ? "include" : "same-origin");
          const init = { method, headers };
          if (method !== "GET" && method !== "HEAD" && body != null) {
            (init as any).body = body;
          }
          if (ctrl) (init as any).signal = ctrl.signal;
          (async () => {
            try {
              const response = await trustedFetch(url, init, {
                resourceType: "XHR",
                initiator: "script",
              });
              const wantsBinary =
                this._responseType === "arraybuffer" || this._responseType === "blob";
              const responseBuffer = wantsBinary ? await response.arrayBuffer() : null;
              const responseText = wantsBinary
                ? ""
                : xhrTextResponse(
                    await response.arrayBuffer(),
                    this._responseType,
                    this._overrideMimeType,
                    response.headers.get("content-type"),
                  );
              if (timeoutTimer) clearTimeout(timeoutTimer);
              if (!live()) return;
              this.status = response.status;
              this.statusText = response.statusText || "";
              this.responseURL = response.url || url;
              this._resHeaders = response.headers;
              this._rsc(2);
              this._rsc(3);
              if (wantsBinary) this._buf = responseBuffer;
              else this._text = responseText;
              this._rsc(4);
              this._fire("load");
              this._fire("loadend");
            } catch {
              if (timeoutTimer) clearTimeout(timeoutTimer);
              if (!live()) return;
              if (this._abortedFlag) return;
              finishError(this._timedOut ? "timeout" : "error");
            }
          })();
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
      const XHR_CONSTS = { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 };
      for (const [name, value] of Object.entries(XHR_CONSTS)) {
        (XMLHttpRequestCls as any)[name] = value;
        (XMLHttpRequestCls.prototype as any)[name] = value;
      }
      try {
        Object.defineProperty(XMLHttpRequestCls, "name", { value: "XMLHttpRequest" });
      } catch {}
      globalThis.XMLHttpRequest = XMLHttpRequestCls;
      if (typeof globalThis.XMLHttpRequestEventTarget !== "function") {
        globalThis.XMLHttpRequestEventTarget = EventTargetConstructor;
      }
      if (typeof ksGlobal.XMLHttpRequestUpload !== "function") {
        ksGlobal.XMLHttpRequestUpload = EventTargetConstructor;
      }
    }
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
          let event: any;
          try {
            event = new (shimEventCtor("Event"))(type, { bubbles: false, cancelable: false });
            if (detail) Object.assign(event, detail);
          } catch {
            event = { type, ...detail };
          }
          const handler = (this as any)["on" + type];
          if (typeof handler === "function") {
            try {
              handler.call(this, event);
            } catch {}
          }
          try {
            (this as any).dispatchEvent(event);
          } catch {}
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
              let result: any;
              if (readType === "arrayBuffer") {
                result = buffer;
              } else if (readType === "text") {
                try {
                  const decoder = new TextDecoder(encoding || "utf-8");
                  result = decoder.decode(bytes);
                } catch {
                  result = "";
                }
              } else if (readType === "binaryString") {
                let binaryString = "";
                for (let i = 0; i < bytes.length; i++)
                  binaryString += String.fromCharCode(bytes[i]);
                result = binaryString;
              } else {
                let binaryString = "";
                for (let i = 0; i < bytes.length; i++)
                  binaryString += String.fromCharCode(bytes[i]);
                const base64 = ksGlobal.btoa ? ksGlobal.btoa(binaryString) : "";
                const mediaType = (blob.type && String(blob.type)) || "application/octet-stream";
                result = "data:" + mediaType + ";base64," + base64;
              }
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
      globalThis.FileReader = FileReaderStub as any;
    }
    try {
      const URLConstructor: any = ksGlobal.URL;
      if (URLConstructor && typeof URLConstructor.createObjectURL === "function") {
        const blobOrigin = (() => {
          try {
            const document = ksGlobal.document;
            const documentUrl = document?.URL ? new URLConstructor(document.URL) : null;
            if (!documentUrl || !documentUrl.origin || documentUrl.origin === "null") {
              return "null";
            }
            return documentUrl.origin;
          } catch {
            return "null";
          }
        })();
        URLConstructor.createObjectURL = function (blob: any) {
          if (blob == null || typeof blob !== "object") {
            throw new TypeError("URL.createObjectURL: argument is not a Blob/MediaSource");
          }
          let uuid: string;
          const cryptoObj = ksGlobal.crypto;
          if (typeof cryptoObj?.randomUUID === "function") {
            uuid = cryptoObj.randomUUID();
          } else {
            const randomBytes = new Uint8Array(16);
            cryptoObj?.getRandomValues?.(randomBytes) ??
              (() => {
                for (let i = 0; i < 16; i++) {
                  randomBytes[i] = Math.floor(Math.random() * 256);
                }
              })();
            randomBytes[6] = ((randomBytes[6] as number) & 0x0f) | 0x40;
            randomBytes[8] = ((randomBytes[8] as number) & 0x3f) | 0x80;
            const hex = Array.from(randomBytes)
              .map((byte) => (byte as number).toString(16).padStart(2, "0"))
              .join("");
            uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
          }
          const url = `blob:${blobOrigin === "null" ? "" : blobOrigin + "/"}${uuid}`;
          state.blobUrls.set(url, blob);
          return url;
        };
        URLConstructor.revokeObjectURL = function (url: any) {
          state.blobUrls.delete(String(url));
        };
      }
    } catch {}
    installWebAssemblyShim();
    installPageTaskGlobals(win, defineEnumerableProto);

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
      clientInformation: ksGlobal.navigator,
    };
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

    try {
      Object.defineProperty(globalThis, "scheduler", {
        value: createScheduler(ksGlobal.setTimeout.bind(globalThis)),
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch {}
    for (const [name, value] of Object.entries(indexedDbGlobals)) {
      if (typeof ksGlobalByKey[name] !== "undefined") continue;
      try {
        Object.defineProperty(globalThis, name, {
          value,
          writable: true,
          configurable: true,
          enumerable: name === "indexedDB",
        });
      } catch {}
    }

    try {
      const originDesc = Object.getOwnPropertyDescriptor(globalThis, "origin");
      if (originDesc && originDesc.writable === false && originDesc.configurable) {
        Object.defineProperty(globalThis, "origin", {
          value: winMiscDefaults.origin || ksGlobal.origin,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
    } catch {}

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
    for (const name of ownConstructorNames) {
      const constructor = ksGlobalByKey[name];
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

    if (typeof ksGlobal.ImageData === "undefined") {
      class ImageData {
        width: number;
        height: number;
        data: Uint8ClampedArray;
        colorSpace: string;
        constructor(dataOrWidth: any, widthOrHeight: any, height?: any) {
          if (
            typeof dataOrWidth === "object" &&
            dataOrWidth &&
            typeof dataOrWidth.length === "number"
          ) {
            const data = dataOrWidth as Uint8ClampedArray;
            const width = widthOrHeight >>> 0;
            if (width === 0 || data.length % 4 !== 0 || (data.length / 4) % width !== 0) {
              throw new ksGlobal.DOMException("invalid dimensions", "IndexSizeError");
            }
            const resolvedHeight = height === undefined ? data.length / 4 / width : height >>> 0;
            if (resolvedHeight === 0 || data.length !== width * resolvedHeight * 4) {
              throw new ksGlobal.DOMException("invalid dimensions", "IndexSizeError");
            }
            this.width = width;
            this.height = resolvedHeight;
            this.data = data;
          } else {
            const width = dataOrWidth >>> 0;
            const height = widthOrHeight >>> 0;
            if (width === 0 || height === 0) {
              throw new ksGlobal.DOMException("invalid dimensions", "IndexSizeError");
            }
            if (width * height > MAX_IMAGE_DATA_PIXELS) {
              throw new RangeError("ImageData size exceeds the supported range");
            }
            this.width = width;
            this.height = height;
            this.data = new Uint8ClampedArray(width * height * 4);
          }
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
    for (const name of idlStubs) {
      if (typeof ksGlobalByKey[name] !== "undefined") continue;
      const cls = unconstructible.has(name)
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
    for (const k of mirrorKeys) {
      const globalValue = ksGlobalByKey[k];
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
  } else {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.location;
    delete ksGlobalByKey.navigator;
    delete globalThis.history;
    if (ksGlobal.self === win) delete ksGlobalByKey.self;
    if (globalThis.top === win) delete globalThis.top;
    if (globalThis.parent === win) delete globalThis.parent;
    if (globalThis.frames === win) delete globalThis.frames;
    delete globalThis.frameElement;
    delete globalThis.opener;
    delete ksGlobalByKey.Event;
    delete globalThis.MouseEvent;
    delete globalThis.KeyboardEvent;
    delete globalThis.Element;
    delete globalThis.HTMLElement;
    delete globalThis.Node;
    delete ksGlobalByKey.EventTarget;
    delete globalThis.getComputedStyle;
  }
}

function installBlobMimeTypeSerialization(): void {
  const blobConstructor = ksGlobal.Blob;
  if (typeof blobConstructor !== "function") return;

  for (const constructor of [blobConstructor, ksGlobal.File]) {
    if (typeof constructor !== "function") continue;
    const prototype = constructor.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "type");
    const getType = descriptor?.get;
    if (getType && descriptor?.configurable) {
      Object.defineProperty(prototype, "type", {
        ...descriptor,
        get(this: object) {
          const mimeType = getBlobMimeType(this);
          if (mimeType !== undefined) return mimeType;
          return normalizeBlobType(String(getType.call(this)));
        },
      });
    }
  }

  const wrapConstructor = (name: "Blob" | "File", optionsIndex: number) => {
    const nativeConstructor = ksGlobal[name];
    if (typeof nativeConstructor !== "function") return;

    const constructor = new Proxy(nativeConstructor, {
      construct(target, args, newTarget) {
        const constructorArgs = args.slice();
        let mimeType = "";
        const options = args[optionsIndex];
        if (
          options !== null &&
          options !== undefined &&
          (typeof options === "object" || typeof options === "function")
        ) {
          const dictionary = options;
          let typeWasRead = false;
          constructorArgs[optionsIndex] = new Proxy(Object.create(null), {
            get(_target, property) {
              if (property === "type") {
                if (!typeWasRead) {
                  const inputType = Reflect.get(dictionary, property, dictionary);
                  if (typeof inputType === "symbol") {
                    throw new TypeError("Cannot convert a Symbol value to a string");
                  }
                  mimeType = normalizeBlobType(inputType === undefined ? "" : String(inputType));
                  typeWasRead = true;
                }
                return mimeType;
              }
              return Reflect.get(dictionary, property, dictionary);
            },
          });
        }

        const instance = Reflect.construct(target, constructorArgs, newTarget);
        setBlobMimeType(instance, mimeType);
        return instance;
      },
    });

    try {
      Object.defineProperty(nativeConstructor.prototype, "constructor", {
        value: constructor,
        configurable: true,
        writable: true,
      });
    } catch (error) {
      console.warn("[kitesurf-blob] failed to set prototype constructor", {
        interfaceName: name,
        error,
      });
    }
    ksGlobalByKey[name] = constructor;
  };

  wrapConstructor("Blob", 1);
  wrapConstructor("File", 2);
}
