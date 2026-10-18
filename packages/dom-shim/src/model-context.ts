/// <reference types="webmcp-types" />

// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Owns page-local WebMCP tool registration, declarative forms, execution, and cancellation.

import type * as Idl from "./idl/types.generated.js";
import type { UpstreamMessage, WebMcpTool } from "@kitesurf/jsrpc-types/page-script";
import { sendUpstreamEvent } from "./internal-state.js";
import { KsEvent, KsInputEvent, KsSubmitEvent, submitEventResponse } from "./events/event.js";
import { dispatchTrustedEvent } from "./events/dispatch.js";
import { postMutationHooks } from "./registries.js";
import type { MutationHint } from "./mutations/seq.js";
import { DOCUMENT_NODE } from "./constants.js";

const DECLARATIVE_ATTRIBUTES = new Set(["toolname", "tooldescription"]);
const MAX_MODEL_CONTEXT_TOOL_NAME_LENGTH = 128;

interface ToolDefinition {
  name: string;
  title: string | null;
  description: string;
  inputSchema: string;
  execute: WebMCP.ToolExecuteCallback;
  annotations: ToolAnnotations | null;
}

type ToolAnnotations = Required<WebMCP.ToolAnnotations> & {
  consequentialHint: boolean;
};

export type SerializedTool = Omit<WebMCP.RegisteredTool, "window">;

export type CdpTool = WebMcpTool;

export interface ToolCallResult {
  content: unknown[];
  isError: boolean;
  rawOutput?: boolean;
  output?: unknown;
  error?: string;
  threw?: boolean;
  notFound?: boolean;
}

// The page API and CDP share this registry; createModelContext resets it per generation.
const tools = new Map<string, ToolDefinition>();
const activeToolExecutions = new Map<string, AbortControllerLike>();

let getWindow: () => unknown = () => undefined;
let getOrigin: () => string = () => "";
let getDocument: () => unknown = () => undefined;

interface DeclarativeOption extends Idl.HTMLOptionElement {}

interface DeclarativeControl extends Idl.HTMLElement {
  checked?: boolean;
  disabled?: boolean;
  max?: unknown;
  min?: unknown;
  multiple?: boolean;
  name?: unknown;
  options?: ArrayLike<DeclarativeOption>;
  required?: boolean;
  type?: unknown;
  value?: unknown;
}

interface DeclarativeForm extends Idl.HTMLElement {
  _id?: unknown;
  elements?: ArrayLike<DeclarativeControl>;
  __ksPerformSubmission?(submitter: DeclarativeControl | null): unknown;
  __ksFiringSubmit?(fire: () => void): void;
}

interface DeclarativeDocument {
  querySelectorAll?(selector: string): ArrayLike<DeclarativeForm>;
}

interface DeclarativeTool {
  descriptor: CdpTool;
  form: DeclarativeForm;
  title: string;
  autosubmit: boolean;
  sig: string;
}

let declarativeTools = new Map<string, DeclarativeTool>();
let declarativeCandidates = 0;
let declarativeWatchActive = false;
let declarativeWatchRevision = 0;
let declarativeRefreshQueued = false;
let declarativeHookInstalled = false;
let pageDeclarativeInterest = false;

function domError(message: string, name: string): Error {
  const DE = (globalThis as { DOMException?: new (m: string, n: string) => Error }).DOMException;
  if (typeof DE === "function") return new DE(message, name);
  const err = new Error(message);
  err.name = name;
  return err;
}

const NAME_OK = /^[A-Za-z0-9_.\-]+$/;

function serializeOne(def: ToolDefinition): SerializedTool {
  let inputSchema: object | undefined;
  if (def.inputSchema !== "") {
    inputSchema = JSON.parse(def.inputSchema) as object;
  }
  return {
    description: def.description,
    ...(inputSchema === undefined ? {} : { inputSchema }),
    name: def.name,
    ...(def.annotations !== null ? { annotations: { ...def.annotations } } : {}),
    origin: getOrigin(),
    title: def.title ?? "",
  };
}

function snapshot(registry: Map<string, ToolDefinition>): SerializedTool[] {
  const out: SerializedTool[] = [];
  for (const def of registry.values()) out.push(serializeOne(def));
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function toCdpTool(def: ToolDefinition): CdpTool {
  const out: CdpTool = { name: def.name, description: def.description };
  if (def.inputSchema !== "") {
    try {
      out.inputSchema = JSON.parse(def.inputSchema);
    } catch {}
  }
  if (def.annotations !== null) {
    out.annotations = {
      readOnly: def.annotations.readOnlyHint,
      untrustedContent: def.annotations.untrustedContentHint,
    };
  }
  return out;
}

export function listModelContextTools(watchRevision: unknown): CdpTool[] {
  const out: CdpTool[] = [];
  for (const def of tools.values()) out.push(toCdpTool(def));
  const revision = typeof watchRevision === "number" ? watchRevision : 0;
  if (revision >= declarativeWatchRevision) {
    declarativeWatchRevision = revision;
    declarativeWatchActive = true;
    refreshDeclarativeTools(false);
  }
  for (const entry of declarativeTools.values()) out.push(entry.descriptor);
  return out;
}

function declarativeSchema(form: DeclarativeForm): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required = new Set<string>();
  const elements = form?.elements;
  for (let i = 0; elements && i < elements.length; i++) {
    const control = elements[i];
    const name = String(control?.name ?? "");
    if (!name || control?.disabled === true) continue;
    const tag = String(control?.localName ?? "").toLowerCase();
    const type = String(control?.type ?? "").toLowerCase();
    if (
      tag === "button" ||
      type === "submit" ||
      type === "reset" ||
      type === "button" ||
      type === "image" ||
      type === "hidden"
    )
      continue;

    if (type === "file") continue;

    let property: Record<string, unknown> = { type: "string" };
    if (type === "checkbox") {
      property = { type: "boolean" };
    } else if (type === "number" || type === "range") {
      property = { type: "number" };
      if (control.min !== "" && Number.isFinite(Number(control.min))) {
        property.minimum = Number(control.min);
      }
      if (control.max !== "" && Number.isFinite(Number(control.max))) {
        property.maximum = Number(control.max);
      }
    } else if (type === "radio") {
      const current = properties[name];
      const values = Array.isArray(current?.enum) ? current.enum.slice() : [];
      const value = String(control.value ?? "on");
      if (!values.includes(value)) values.push(value);
      property = { type: "string", enum: values };
    } else if (tag === "select") {
      const values: string[] = [];
      const options = control.options;
      for (let j = 0; options && j < options.length; j++) {
        if (options[j]?.disabled !== true) values.push(String(options[j]?.value ?? ""));
      }
      const item: Record<string, unknown> = { type: "string" };
      if (values.length > 0) item.enum = values;
      property = control.multiple === true ? { type: "array", items: item } : item;
    } else if (type === "email") {
      property.format = "email";
    }

    const description = control?.getAttribute?.("toolparamdescription");
    if (description) property.description = description;
    properties[name] = property;
    if (control?.required === true) required.add(name);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.size > 0) schema.required = Array.from(required);
  return schema;
}

function scanDeclarativeTools(): Map<string, DeclarativeTool> {
  const found = new Map<string, DeclarativeTool>();
  // The host injects the live DOM shim Document through this internal callback.
  const doc = getDocument() as DeclarativeDocument | null | undefined;
  let forms: DeclarativeForm[] = [];
  try {
    forms = Array.from(doc?.querySelectorAll?.("form[toolname][tooldescription]") ?? []);
  } catch {
    return found;
  }
  declarativeCandidates = forms.length;
  for (const form of forms) {
    const name = String(form?.getAttribute?.("toolname") ?? "");
    const description = String(form?.getAttribute?.("tooldescription") ?? "");
    if (
      !name ||
      !description ||
      name.length > MAX_MODEL_CONTEXT_TOOL_NAME_LENGTH ||
      !NAME_OK.test(name) ||
      tools.has(name) ||
      found.has(name)
    )
      continue;
    const autosubmit = form?.getAttribute?.("toolautosubmit") != null;
    const descriptor: CdpTool = {
      name,
      description,
      inputSchema: declarativeSchema(form),
    };
    if (autosubmit) descriptor.annotations = { autosubmit: true };
    if (typeof form?._id === "number" && form._id > 0) {
      descriptor.backendNodeId = form._id;
    }
    const title = String(form?.getAttribute?.("tooltitle") ?? "");
    found.set(name, {
      descriptor,
      form,
      title,
      autosubmit,
      sig: JSON.stringify([descriptor, title, autosubmit]),
    });
  }
  return found;
}

function refreshDeclarativeTools(notify: boolean): void {
  const previous = declarativeTools;
  const next = scanDeclarativeTools();
  declarativeTools = next;
  // The first page or CDP read seeds existing forms instead of reporting additions.
  if (!notify) return;
  const removed: string[] = [];
  const added: CdpTool[] = [];
  for (const name of previous.keys()) {
    if (!next.has(name)) removed.push(name);
  }
  for (const [name, entry] of next) {
    const before = previous.get(name);
    if (!before || before.sig !== entry.sig) {
      if (before) removed.push(name);
      added.push(entry.descriptor);
    }
  }
  if (removed.length === 0 && added.length === 0) return;
  if (declarativeWatchActive) {
    if (removed.length > 0) {
      sendDelta({ event: "kitesurf.modelContextToolsRemoved", params: { names: removed } });
    }
    if (added.length > 0) {
      sendDelta({ event: "kitesurf.modelContextToolsAdded", params: { tools: added } });
    }
  }
  if (mainContext) notifyChanged(mainContext);
}

function scheduleDeclarativeRefresh(hint?: MutationHint): void {
  if ((!declarativeWatchActive && !pageDeclarativeInterest) || declarativeRefreshQueued) {
    return;
  }
  if (
    declarativeCandidates === 0 &&
    hint !== undefined &&
    (typeof hint === "string" || !DECLARATIVE_ATTRIBUTES.has(hint.attribute.toLowerCase()))
  ) {
    return;
  }
  declarativeRefreshQueued = true;
  queueMicrotask(() => {
    declarativeRefreshQueued = false;
    if (!declarativeWatchActive && !pageDeclarativeInterest) return;
    refreshDeclarativeTools(true);
  });
}

export function stopModelContextToolWatch(watchRevision: unknown): void {
  const revision = typeof watchRevision === "number" ? watchRevision : 0;
  if (revision < declarativeWatchRevision) return;
  declarativeWatchRevision = revision;
  declarativeWatchActive = false;
  declarativeRefreshQueued = false;
}

function sendDelta(
  message: UpstreamMessage<"kitesurf.modelContextToolsAdded" | "kitesurf.modelContextToolsRemoved">,
): void {
  // Early upstream deltas are best-effort; post-load reconciliation is the correctness path.
  sendUpstreamEvent(message);
}

function notifyChanged(context: ModelContext): void {
  if (context._changeQueued) return;
  context._changeQueued = true;
  queueMicrotask(() => {
    context._changeQueued = false;
    context.dispatchEvent(new KsEvent("toolchange"));
  });
}

// ModelContext has no node ID, so listeners cannot use the node-keyed DOM registry.
class ToolEventTarget {
  private _listeners = new Map<string, Array<(e: unknown) => void>>();

  addEventListener(type: unknown, listener: unknown, _options: unknown = undefined): void {
    if (typeof listener !== "function") return;
    const key = String(type);
    const list = this._listeners.get(key) ?? [];
    if (!list.includes(listener as (e: unknown) => void)) {
      list.push(listener as (e: unknown) => void);
    }
    this._listeners.set(key, list);
  }

  removeEventListener(type: unknown, listener: unknown): void {
    const list = this._listeners.get(String(type));
    if (!list) return;
    const at = list.indexOf(listener as (e: unknown) => void);
    if (at >= 0) list.splice(at, 1);
  }

  dispatchEvent(event: unknown): boolean {
    const ev = event as { type?: string };
    const list = this._listeners.get(String(ev?.type ?? ""));
    for (const listener of list ? list.slice() : []) {
      try {
        listener.call(this, event);
      } catch (err) {
        reportListenerError(err);
      }
    }
    return true;
  }
}

function reportListenerError(err: unknown): void {
  try {
    console.error("[kitesurf] modelContext listener threw:", err);
  } catch {}
}

type TaskScheduler = (fn: () => void, ms: number) => unknown;

const exposedSetTimeout = (globalThis as { setTimeout?: TaskScheduler }).setTimeout;
let taskScheduler: TaskScheduler | null =
  typeof exposedSetTimeout === "function" ? exposedSetTimeout.bind(globalThis) : null;

export function setModelContextTaskScheduler(scheduler: TaskScheduler): void {
  taskScheduler = scheduler;
}

function queueTask(callback: () => void): void {
  // PageScript installs its timer wheel here so WebMCP tasks share the page's task order.
  try {
    if (taskScheduler) {
      taskScheduler(callback, 0);
      return;
    }
  } catch {}
  queueMicrotask(() => queueMicrotask(callback));
}

function isTrustworthyOrigin(input: string): boolean {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return false;
  }
  if (u.origin === "null") return false;
  const scheme = u.protocol.toLowerCase();
  if (scheme === "https:" || scheme === "wss:") return true;
  if (scheme === "http:" || scheme === "ws:") {
    const host = u.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1" ||
      host.endsWith(".localhost")
    );
  }
  return false;
}

function toUSVString(s: string): string {
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}
type AbortSignalLike = {
  aborted?: boolean;
  reason?: unknown;
  addEventListener?: (type: string, listener: () => void, options?: unknown) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};
type AbortControllerLike = {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
};
function isAbortSignalLike(v: unknown): v is AbortSignalLike {
  return isObjectLike(v) && typeof v.addEventListener === "function";
}

function createExecutionController(): AbortControllerLike {
  const AbortControllerCtor = AbortController;
  if (typeof AbortControllerCtor !== "function") {
    throw new Error("WebMCP tool execution requires AbortController");
  }
  return new AbortControllerCtor();
}

function executionOptions(signal?: AbortSignal): WebMCP.ToolExecuteCallbackOptions {
  const executionSignal = signal ?? createExecutionController().signal;
  return { signal: executionSignal };
}

let allowConstruct = false;
export class ModelContext extends ToolEventTarget implements Idl.ModelContext {
  declare _tools: Map<string, ToolDefinition>;
  declare _isMain: boolean;
  declare _getWindow: () => unknown;
  declare _isFullyActive: () => boolean;
  declare _changeQueued: boolean;

  constructor() {
    super();
    if (!allowConstruct) {
      throw new TypeError("Illegal constructor");
    }
    allowConstruct = false;
  }
  private _ontoolchange: Idl.ModelContext["ontoolchange"] = null;

  get ontoolchange(): Idl.ModelContext["ontoolchange"] {
    return this._ontoolchange;
  }

  set ontoolchange(handler: Idl.ModelContext["ontoolchange"]) {
    if (this._isMain) markDeclarativeInterest();
    if (this._ontoolchange) {
      this.removeEventListener("toolchange", this._ontoolchange);
    }
    this._ontoolchange = typeof handler === "function" ? handler : null;
    if (this._ontoolchange) {
      this.addEventListener("toolchange", this._ontoolchange);
    }
  }

  addEventListener(type: unknown, listener: unknown, options?: unknown): void {
    if (this._isMain && String(type) === "toolchange") {
      markDeclarativeInterest();
    }
    super.addEventListener(type, listener, options);
  }

  registerTool(
    tool: Idl.ModelContextTool,
    options?: Idl.ModelContextRegisterToolOptions,
  ): Promise<void> {
    if (!this._isFullyActive()) {
      return Promise.reject(inactiveDocumentError("registerTool"));
    }
    let def: ToolDefinition;
    try {
      def = validate(tool, this._tools);
    } catch (err) {
      return Promise.reject(err);
    }

    const opts = isObjectLike(options) ? options : {};
    const signal = isAbortSignalLike(opts.signal) ? opts.signal : undefined;
    if (signal && signal.aborted === true) {
      return Promise.reject(signal.reason ?? domError("aborted", "AbortError"));
    }
    const exposedTo = opts.exposedTo;
    if (exposedTo !== undefined) {
      if (!Array.isArray(exposedTo)) {
        return Promise.reject(new TypeError("registerTool: exposedTo must be a sequence"));
      }
      for (const origin of exposedTo) {
        if (typeof origin !== "string" || !isTrustworthyOrigin(origin)) {
          return Promise.reject(
            domError(
              `registerTool: exposedTo origin "${String(origin)}" is not a potentially-trustworthy origin`,
              "SecurityError",
            ),
          );
        }
      }
    }

    const registry = this._tools;
    registry.set(def.name, def);
    if (this._isMain) {
      sendDelta({ event: "kitesurf.modelContextToolsAdded", params: { tools: [toCdpTool(def)] } });
    }

    const context = this;
    return new Promise<void>((resolve, reject) => {
      if (signal && signal.addEventListener) {
        signal.addEventListener("abort", () => {
          if (registry.get(def.name) === def) {
            registry.delete(def.name);
            if (context._isMain) {
              sendDelta({
                event: "kitesurf.modelContextToolsRemoved",
                params: {
                  names: [def.name],
                },
              });
            }
            notifyChanged(context);
          }
          reject(signal.reason ?? domError("aborted", "AbortError"));
        });
      }
      // Queue toolchange before resolving so awaiters observe the notification first.
      notifyChanged(context);
      queueMicrotask(() => resolve(undefined));
    });
  }

  executeTool(tool: unknown, inputObject?: unknown, options?: unknown): Promise<string> {
    if (!isObjectLike(tool)) {
      return Promise.reject(new TypeError("executeTool: tool must be a dictionary"));
    }
    if (typeof tool.origin !== "string") {
      return Promise.reject(new TypeError("executeTool: tool.origin is required"));
    }
    if (typeof tool.name !== "string" || tool.name === "") {
      return Promise.reject(new TypeError("executeTool: tool.name is required"));
    }
    if (!this._isFullyActive()) {
      return Promise.reject(inactiveDocumentError("executeTool"));
    }
    let originOk = false;
    try {
      originOk = new URL(tool.origin).origin !== "null";
    } catch {
      originOk = false;
    }
    if (!originOk) {
      return Promise.reject(
        domError(
          `executeTool: tool origin "${tool.origin}" is not a supported origin`,
          "NotSupportedError",
        ),
      );
    }
    const toolName = tool.name;
    const def = this._tools.get(toolName);
    let execFn: WebMCP.ToolExecuteCallback | null = def ? def.execute : null;
    if (!execFn && this._isMain) {
      markDeclarativeInterest();
      // A form can appear before its queued mutation refresh, so rescan before fallback lookup.
      refreshDeclarativeTools(true);
      const entry = declarativeTools.get(toolName);
      if (entry) execFn = makeDeclarativeExec(entry);
    }
    if (!execFn) {
      return Promise.reject(domError(`executeTool: no tool named "${toolName}"`, "UnknownError"));
    }
    const exec = execFn;
    let args: Record<string, unknown> = {};
    if (inputObject !== undefined && inputObject !== null) {
      let raw: string;
      if (typeof inputObject === "object" || typeof inputObject === "function") {
        let json: string | undefined;
        try {
          json = JSON.stringify(inputObject);
        } catch (err) {
          return Promise.reject(err);
        }
        if (json === undefined) {
          return Promise.reject(new TypeError("executeTool: inputObject is not JSON-serializable"));
        }
        raw = json;
      } else {
        raw = typeof inputObject === "string" ? inputObject : String(inputObject);
      }
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Promise.reject(domError(`executeTool: invalid JSON args: ${msg}`, "UnknownError"));
      }
      if (!isObjectLike(parsedArgs)) {
        return Promise.reject(domError("executeTool: args must be a JSON object", "UnknownError"));
      }
      args = parsedArgs;
    }
    const opts = isObjectLike(options) ? options : {};
    const signal = isAbortSignalLike(opts.signal) ? opts.signal : undefined;
    if (signal && signal.aborted === true) {
      return Promise.reject(signal.reason ?? domError("aborted", "AbortError"));
    }
    const win = this._getWindow();
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let callbackSettled = false;
      const execController = createExecutionController();
      let onAbort: (() => void) | null = null;
      const detach = () => {
        if (onAbort && signal && signal.removeEventListener) {
          signal.removeEventListener("abort", onAbort);
        }
        onAbort = null;
      };
      if (signal && signal.addEventListener) {
        onAbort = () => {
          if (settled) return;
          settled = true;
          detach();
          reject(signal.reason ?? domError("aborted", "AbortError"));
          if (!callbackSettled) {
            const fire = () => {
              if (callbackSettled) return;
              try {
                execController.abort();
              } catch {}
              dispatchWindowToolEvent(win, "toolcancel", toolName);
            };
            queueTask(fire);
          }
        };
        signal.addEventListener("abort", onAbort);
      }
      Promise.resolve()
        .then(() => {
          const p = exec(args, {
            signal: execController.signal,
          });
          dispatchWindowToolEvent(win, "toolactivated", toolName);
          return p;
        })
        .then(
          (v) => {
            callbackSettled = true;
            if (settled) return;
            if (v === undefined) {
              queueTask(() => {
                if (settled) return;
                settled = true;
                detach();
                resolve("");
              });
              return;
            }
            if (typeof v === "string") {
              queueTask(() => {
                if (settled) return;
                settled = true;
                detach();
                resolve(v);
              });
              return;
            }
            let json: string | undefined;
            try {
              json = JSON.stringify(v);
            } catch {
              json = undefined;
            }
            if (json === undefined) {
              queueTask(() => {
                if (settled) return;
                settled = true;
                detach();
                reject(
                  domError("executeTool: tool result is not JSON-serializable", "UnknownError"),
                );
              });
              return;
            }
            queueTask(() => {
              if (settled) return;
              settled = true;
              detach();
              resolve(json);
            });
          },
          (e) => {
            callbackSettled = true;
            if (settled) return;
            const msg = e instanceof Error ? e.message : String(e);
            queueTask(() => {
              if (settled) return;
              settled = true;
              detach();
              reject(domError(`executeTool: ${msg}`, "UnknownError"));
            });
          },
        );
    });
  }

  getTools(options?: WebMCP.ModelContextGetToolOptions): Promise<WebMCP.RegisteredTool[]> {
    if (!this._isFullyActive()) {
      return Promise.reject(inactiveDocumentError("getTools"));
    }
    const opts = isObjectLike(options) ? options : {};
    const fromOrigins = opts.fromOrigins;
    if (fromOrigins !== undefined) {
      if (!Array.isArray(fromOrigins)) {
        return Promise.reject(new TypeError("getTools: fromOrigins must be a sequence"));
      }
      for (const origin of fromOrigins) {
        if (typeof origin !== "string" || !isTrustworthyOrigin(origin)) {
          return Promise.reject(
            domError(
              `getTools: fromOrigins entry "${String(origin)}" is not a potentially-trustworthy origin`,
              "SecurityError",
            ),
          );
        }
      }
    }
    const win = this._getWindow() as WebMCP.RegisteredTool["window"];
    const out = snapshot(this._tools);
    if (this._isMain) {
      markDeclarativeInterest();
      refreshDeclarativeTools(true);
      for (const entry of declarativeTools.values()) {
        out.push(serializeDeclarative(entry));
      }
      out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    return Promise.resolve(out.map((tool) => ({ ...tool, window: win })));
  }
}

function inactiveDocumentError(op: string): Error {
  return domError(`${op}: the document is not fully active`, "InvalidStateError");
}

function serializeDeclarative(entry: DeclarativeTool): SerializedTool {
  const out: SerializedTool = {
    name: entry.descriptor.name,
    title: entry.title,
    description: entry.descriptor.description,
    origin: getOrigin(),
  };
  if (entry.descriptor.inputSchema !== undefined) {
    try {
      out.inputSchema = JSON.parse(JSON.stringify(entry.descriptor.inputSchema)) as object;
    } catch {}
  }
  return out;
}

function dispatchWindowToolEvent(win: unknown, type: string, toolName: string): void {
  try {
    if (win === null || (typeof win !== "object" && typeof win !== "function")) return;
    // `win` is page-owned; narrow only the EventTarget method this bridge needs.
    const dispatcher = win as Pick<Idl.EventTarget, "dispatchEvent">;
    if (typeof dispatcher.dispatchEvent !== "function") return;
    // WebMCP window notifications add page-visible fields to the shared Event.
    const event = new KsEvent(type) as KsEvent & { toolName: string; detail: string };
    event.toolName = toolName;
    event.detail = toolName;
    dispatcher.dispatchEvent(event);
  } catch {}
}

const activeToolForms = new Set<object>();

export function isToolFormActive(el: unknown): boolean {
  return !!el && typeof el === "object" && activeToolForms.has(el);
}

export function isToolSubmitActive(el: unknown): boolean {
  if (!isObjectLike(el)) return false;
  const button = el;
  if (String(button.type ?? "").toLowerCase() !== "submit") return false;
  return isToolFormActive(button.form);
}

function dispatchToolSubmit(form: DeclarativeForm): unknown {
  let submitter: DeclarativeControl | null = null;
  const elements = form.elements;
  for (let i = 0; elements && i < elements.length; i++) {
    const control = elements[i];
    const tag = String(control?.localName ?? "").toLowerCase();
    const type = String(control?.type ?? "").toLowerCase();
    if (
      control?.disabled !== true &&
      ((tag === "button" && type === "submit") ||
        (tag === "input" && (type === "submit" || type === "image")))
    ) {
      submitter = control;
      break;
    }
  }
  const ev = new KsSubmitEvent("submit", {
    bubbles: true,
    cancelable: true,
    agentInvoked: true,
    submitter,
  });
  if (typeof form.dispatchEvent === "function") {
    const fire = () => {
      dispatchTrustedEvent(form, ev);
    };
    // Reuse the form guard so a handler's requestSubmit cannot redispatch submit.
    if (typeof form.__ksFiringSubmit === "function") form.__ksFiringSubmit(fire);
    else fire();
  }
  if (!ev.defaultPrevented) {
    form.__ksPerformSubmission?.(submitter);
  }
  const responded = submitEventResponse(ev);
  if (responded && typeof responded.then === "function") {
    return responded;
  }
  return "";
}

function makeDeclarativeExec(entry: DeclarativeTool): WebMCP.ToolExecuteCallback {
  return (args: Record<string, unknown>, options) => {
    fillDeclarativeControls(entry.form, args);
    if (entry.autosubmit) {
      const submitted = dispatchToolSubmit(entry.form);
      const signal = options?.signal;
      if (!signal?.addEventListener) return submitted;
      return new Promise<unknown>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          signal.removeEventListener?.("abort", onAbort);
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(signal.reason ?? domError("aborted", "AbortError"));
        };
        signal.addEventListener?.("abort", onAbort);
        Promise.resolve(submitted).then(
          (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          },
          (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
          },
        );
      });
    }
    return new Promise<unknown>((resolve, reject) => {
      const form = entry.form;
      activeToolForms.add(entry.form);
      const signal = options?.signal;
      let onAbort: (() => void) | null = null;
      const cleanup = () => {
        activeToolForms.delete(entry.form);
        if (onSubmit && form.removeEventListener) {
          form.removeEventListener("submit", onSubmit);
        }
        if (onAbort && signal?.removeEventListener) {
          signal.removeEventListener("abort", onAbort);
        }
      };
      let onSubmit: ((e: unknown) => void) | null = (ev: unknown) => {
        cleanup();
        const responded = submitEventResponse(ev);
        if (responded && typeof responded.then === "function") {
          resolve(responded);
        } else {
          resolve("");
        }
      };
      if (form.addEventListener) {
        form.addEventListener("submit", onSubmit);
      } else {
        onSubmit = null;
      }
      if (signal?.addEventListener) {
        onAbort = () => {
          cleanup();
          reject(signal.reason ?? domError("aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort);
      }
    });
  };
}

function fillDeclarativeControls(form: DeclarativeForm, args: Record<string, unknown>): void {
  const elements = form?.elements;
  for (let i = 0; elements && i < elements.length; i++) {
    const control = elements[i];
    const field = String(control?.name ?? "");
    if (!field || !(field in args) || control?.disabled === true) continue;
    setControlValue(control, args[field]);
  }
}

interface SettableControl {
  readonly localName?: unknown;
  readonly type?: unknown;
  checked?: boolean;
  value?: unknown;
  readonly multiple?: boolean;
  readonly options?: ArrayLike<{ readonly value?: unknown; selected?: boolean }>;
}

export function setControlValue(control: SettableControl, value: unknown): boolean {
  const tag = String(control?.localName ?? "").toLowerCase();
  const type = String(control?.type ?? "").toLowerCase();
  if (type === "file") return false;
  let changed = false;
  try {
    if (type === "checkbox") {
      const want = value === true;
      if (control.checked !== want) {
        control.checked = want;
        changed = true;
      }
    } else if (type === "radio") {
      const want = String(control.value ?? "on") === String(value);
      if (control.checked !== want) {
        control.checked = want;
        changed = true;
      }
    } else if (tag === "select" && control.multiple === true && Array.isArray(value)) {
      const selected = new Set(value.map(String));
      const options = control.options;
      if (!options) return false;
      for (let j = 0; j < options.length; j++) {
        const opt = options[j];
        const want = selected.has(String(opt.value));
        if (opt.selected !== want) {
          opt.selected = want;
          changed = true;
        }
      }
    } else {
      const want = value == null ? "" : String(value);
      if (String(control.value ?? "") !== want) {
        control.value = want;
        changed = true;
      }
    }
  } catch {
    return false;
  }
  if (!changed) return false;
  try {
    dispatchTrustedEvent(
      control,
      new KsInputEvent("input", {
        bubbles: true,
        cancelable: false,
      }),
    );
  } catch {}
  try {
    dispatchTrustedEvent(
      control,
      new KsEvent("change", {
        bubbles: true,
        cancelable: false,
      }),
    );
  } catch {}
  return true;
}

function markDeclarativeInterest(): void {
  if (pageDeclarativeInterest) return;
  pageDeclarativeInterest = true;
  refreshDeclarativeTools(false);
}

function validate(tool: unknown, registry: Map<string, ToolDefinition>): ToolDefinition {
  if (!isObjectLike(tool)) {
    throw new TypeError("registerTool: tool must be an object");
  }
  const t = tool;
  const name = typeof t.name === "string" ? t.name : "";
  const description = typeof t.description === "string" ? t.description : "";
  if (name === "" || description === "") {
    throw domError(
      "registerTool: name and description are required and must be non-empty",
      "InvalidStateError",
    );
  }
  if (name.length > MAX_MODEL_CONTEXT_TOOL_NAME_LENGTH || !NAME_OK.test(name)) {
    throw domError(`registerTool: invalid tool name "${name}"`, "InvalidStateError");
  }
  if (registry.has(name)) {
    throw domError(
      `registerTool: a tool named "${name}" is already registered`,
      "InvalidStateError",
    );
  }
  if (typeof t.execute !== "function") {
    throw new TypeError(`registerTool: tool "${name}" has no execute()`);
  }

  let inputSchema = "";
  if (t.inputSchema !== undefined) {
    if (
      t.inputSchema === null ||
      (typeof t.inputSchema !== "object" && typeof t.inputSchema !== "function")
    ) {
      throw new TypeError(`registerTool: tool "${name}" inputSchema must be an object`);
    }
    const json = JSON.stringify(t.inputSchema);
    if (json === undefined) {
      throw new TypeError(`registerTool: tool "${name}" has an unserializable inputSchema`);
    }
    inputSchema = json;
  }

  const rawAnnotations = t.annotations;
  const annotations = isObjectLike(rawAnnotations)
    ? {
        readOnlyHint: rawAnnotations.readOnlyHint === true,
        untrustedContentHint: rawAnnotations.untrustedContentHint === true,
        consequentialHint: rawAnnotations.consequentialHint === true,
      }
    : null;

  return {
    name,
    title: typeof t.title === "string" ? toUSVString(t.title) : null,
    description,
    inputSchema,
    execute: t.execute as WebMCP.ToolExecuteCallback,
    annotations,
  };
}

/** Starts a new document context, signals abort to active calls, and clears prior registrations. */
export function createModelContext(deps: {
  getWindow: () => unknown;
  getOrigin: () => string;
  getDocument: () => unknown;
}): ModelContext {
  for (const controller of activeToolExecutions.values()) controller.abort();
  tools.clear();
  activeToolExecutions.clear();
  declarativeTools.clear();
  declarativeCandidates = 0;
  declarativeWatchActive = false;
  declarativeWatchRevision = 0;
  declarativeRefreshQueued = false;
  pageDeclarativeInterest = false;
  docContexts = new WeakMap();
  getWindow = deps.getWindow;
  getOrigin = deps.getOrigin;
  allowConstruct = true;
  getDocument = deps.getDocument;
  if (!declarativeHookInstalled) {
    postMutationHooks.push(scheduleDeclarativeRefresh);
    declarativeHookInstalled = true;
  }
  const context = new ModelContext();
  context._tools = tools;
  context._isMain = true;
  context._getWindow = () => getWindow();
  context._isFullyActive = () => true;
  context._changeQueued = false;
  mainContext = context;
  return context;
}

let mainContext: ModelContext | null = null;
let docContexts = new WeakMap<object, ModelContext>();

export function acquireModelContext(doc: unknown): ModelContext {
  if (!isObjectLike(doc) || doc.nodeType !== DOCUMENT_NODE) {
    throw new TypeError("Document.prototype.modelContext getter called on a non-Document receiver");
  }
  const d = doc;
  if (mainContext && d === getDocument()) return mainContext;
  const existing = docContexts.get(d);
  if (existing) return existing;
  allowConstruct = true;
  const context = new ModelContext();
  context._tools = new Map();
  context._isMain = false;
  context._getWindow = () => d.defaultView ?? undefined;
  context._isFullyActive = () => isChildDocumentFullyActive(d);
  context._changeQueued = false;
  docContexts.set(d, context);
  return context;
}

function isChildDocumentFullyActive(doc: object): boolean {
  try {
    const document = isObjectLike(doc) ? doc : null;
    if (!document) return false;
    const view = document.defaultView;
    if (!isObjectLike(view)) return false;
    const el = view.frameElement;
    if (!isObjectLike(el)) return false;
    return el.isConnected === true && el.contentDocument === doc;
  } catch {
    return false;
  }
}

function jsonSafe(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : JSON.parse(json);
  } catch {
    return null;
  }
}

function normalizeResult(out: unknown): ToolCallResult {
  if (out === undefined || out === null) return { content: [], isError: false };
  if (typeof out === "string") {
    return { content: [{ type: "text", text: out }], isError: false };
  }
  // Tool callbacks return page-owned values; inspect only the result envelope fields.
  const obj = out as { content?: unknown; isError?: unknown };
  if (Array.isArray(obj.content)) {
    return {
      // Normalize the page-provided content array before returning it.
      content: (jsonSafe(obj.content) as unknown[]) ?? [],
      isError: obj.isError === true,
    };
  }
  const safe = jsonSafe(out);
  return {
    content: [{ type: "text", text: safe === null ? String(out) : JSON.stringify(safe) }],
    isError: false,
  };
}

function declarativeResult(out: unknown): ToolCallResult {
  if (out === undefined) {
    return { content: [], isError: false, rawOutput: true };
  }
  const serialized = JSON.stringify(out);
  if (serialized === undefined) {
    throw new TypeError("WebMCP tool result is not JSON-serializable");
  }
  return {
    content: [],
    isError: false,
    rawOutput: true,
    output: JSON.parse(serialized),
  };
}

/** Returns missing-tool and callback failures in ToolCallResult instead of throwing. */
export async function callModelContextTool(
  name: unknown,
  input: unknown,
  invocationId?: unknown,
): Promise<ToolCallResult> {
  const key = typeof name === "string" ? name : String(name ?? "");
  const def = tools.get(key);
  let execute = def?.execute;
  let returnsDeclarativeOutput = false;
  if (!execute) {
    refreshDeclarativeTools(false);
    const declarative = declarativeTools.get(key);
    if (declarative) {
      execute = makeDeclarativeExec(declarative);
      returnsDeclarativeOutput = true;
    }
  }
  if (!execute) {
    return {
      content: [],
      isError: true,
      error: `no such tool: ${key}`,
      notFound: true,
    };
  }
  const id = typeof invocationId === "string" ? invocationId : "";
  const controller = id === "" ? null : createExecutionController();
  if (controller) {
    activeToolExecutions.set(id, controller);
  }
  try {
    const args = isObjectLike(input) ? input : {};
    const result = await execute(args, executionOptions(controller?.signal));
    return returnsDeclarativeOutput ? declarativeResult(result) : normalizeResult(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      error: message,
      threw: true,
    };
  } finally {
    if (controller && activeToolExecutions.get(id) === controller) {
      activeToolExecutions.delete(id);
    }
  }
}

/** Signals abort for a running invocation; returns false for an unknown or inactive ID. */
export function cancelModelContextTool(invocationId: unknown): boolean {
  const id = typeof invocationId === "string" ? invocationId : "";
  if (id === "") return false;
  const controller = activeToolExecutions.get(id);
  if (controller) {
    activeToolExecutions.delete(id);
    controller.abort();
    return true;
  }
  return false;
}
