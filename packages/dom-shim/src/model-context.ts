// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Owns page-local WebMCP tool registration, declarative forms, execution, and cancellation.

import type * as Idl from "./idl/types.generated.js";
import type { UpstreamMessage, WebMcpTool } from "@kitesurf/jsrpc-types/page-script";
import { sendUpstreamEvent } from "./internal-state.js";
import {
  KsEvent,
  KsInputEvent,
  KsSubmitEvent,
  KsToolActivatedEvent,
  KsToolCancelEvent,
  submitEventResponse,
} from "./events/event.js";
import { dispatchTrustedEvent, dispatchTrustedOnKey } from "./events/dispatch.js";
import { formBehindProxy, postMutationHooks } from "./registries.js";
import type { MutationHint } from "./mutations/seq.js";
import { DOCUMENT_NODE } from "./constants.js";
import { KsEventTarget } from "./node-base.js";

const DECLARATIVE_ATTRIBUTES = new Set(["toolname", "tooldescription"]);
const MAX_MODEL_CONTEXT_TOOL_NAME_LENGTH = 128;

type ToolAnnotations = Required<Idl.ToolAnnotations>;

// Idl.ToolExecuteCallback, with the platform's AbortSignal the execution controller makes.
type ToolExecute = (inputObject: object, options: { signal: AbortSignal }) => unknown;

// `id` names one registration, so a Tool from getTools() never runs a same-named successor.
interface ToolDefinition {
  id: object;
  name: string;
  title: string | null;
  description: string;
  inputSchema: string;
  outputSchema: string;
  execute: ToolExecute;
  annotations: ToolAnnotations | null;
}

export type CdpTool = WebMcpTool;

export interface ToolCallResult {
  content: unknown[];
  isError: boolean;
  rawOutput?: boolean;
  output?: unknown;
  error?: string;
  threw?: boolean;
  notFound?: boolean;
  canceled?: boolean;
}

interface ActiveExecution {
  controller: AbortControllerLike;
  name: string;
}

// The page API and CDP share this registry; createModelContext resets it per generation.
const tools = new Map<string, ToolDefinition>();
const activeToolExecutions = new Map<string, ActiveExecution>();

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
  id: object;
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
// Cancels a non-autosubmit execution that still waits for its form to be submitted.
let pendingFormCancels = new Map<DeclarativeForm, Set<() => void>>();
const declarativeCancels = new WeakSet<object>();

function domError(message: string, name: string): Error {
  const DE = (globalThis as { DOMException?: new (m: string, n: string) => Error }).DOMException;
  if (typeof DE === "function") return new DE(message, name);
  const err = new Error(message);
  err.name = name;
  return err;
}

const NAME_OK = /^[A-Za-z0-9_.\-]+$/;

interface ToolSlots {
  id: object;
  context: ModelContext;
  declarative: boolean;
  name: string;
  title: string;
  description: string;
  inputSchema: object | null;
  outputSchema: object | null;
  origin: string;
  annotations: object | null;
}

const toolSlots = new WeakMap<object, ToolSlots>();
let allowToolConstruct = false;

function slotsOf(tool: unknown): ToolSlots {
  const slots = isObjectLike(tool) ? toolSlots.get(tool) : undefined;
  if (!slots) throw new TypeError("Illegal invocation");
  return slots;
}

export class Tool implements Idl.Tool {
  constructor() {
    if (!allowToolConstruct) throw new TypeError("Illegal constructor");
    allowToolConstruct = false;
  }

  get name(): string {
    return slotsOf(this).name;
  }

  get title(): string {
    return slotsOf(this).title;
  }

  get description(): string {
    return slotsOf(this).description;
  }

  get inputSchema(): object | null {
    return slotsOf(this).inputSchema;
  }

  get outputSchema(): object | null {
    return slotsOf(this).outputSchema;
  }

  get source(): unknown {
    const { context } = slotsOf(this);
    if (!context._isFullyActive()) return null;
    return context._getWindow() ?? null;
  }

  get origin(): string {
    return slotsOf(this).origin;
  }

  get annotations(): object | null {
    return slotsOf(this).annotations;
  }
}

function mintTool(slots: ToolSlots): Tool {
  allowToolConstruct = true;
  // V8 cannot serialize a Proxy, so structuredClone(tool) throws DataCloneError, as it does for
  // any platform object that is not [Serializable].
  const tool = new Proxy(new Tool(), {});
  toolSlots.set(tool, slots);
  return tool;
}

function parseSchema(json: string): object | null {
  return json === "" ? null : (JSON.parse(json) as object);
}

function definitionSlots(def: ToolDefinition, context: ModelContext): ToolSlots {
  return {
    id: def.id,
    context,
    declarative: false,
    name: def.name,
    title: def.title ?? "",
    description: def.description,
    inputSchema: parseSchema(def.inputSchema),
    outputSchema: parseSchema(def.outputSchema),
    origin: getOrigin(),
    annotations: def.annotations === null ? null : { ...def.annotations },
  };
}

function declarativeSlots(entry: DeclarativeTool, context: ModelContext): ToolSlots {
  let inputSchema: object | null = null;
  if (entry.descriptor.inputSchema !== undefined) {
    try {
      inputSchema = JSON.parse(JSON.stringify(entry.descriptor.inputSchema)) as object;
    } catch {}
  }
  return {
    id: entry.id,
    context,
    declarative: true,
    name: entry.descriptor.name,
    title: entry.title,
    description: entry.descriptor.description,
    inputSchema,
    outputSchema: null,
    origin: getOrigin(),
    annotations: null,
  };
}

function toCdpTool(def: ToolDefinition): CdpTool {
  const out: CdpTool = { name: def.name, description: def.description };
  if (def.inputSchema !== "") {
    try {
      const schema: unknown = JSON.parse(def.inputSchema);
      out.inputSchema = schema;
    } catch {}
  }
  if (def.annotations !== null) {
    out.annotations = {
      readOnly: def.annotations.readOnlyHint,
      untrustedContent: def.annotations.untrustedContentHint,
      consequential: def.annotations.consequentialHint,
      debugging: def.annotations.debugging,
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
  // Off the form behind its proxy: a control named "elements" must not hide the controls.
  const elements = form ? formBehindProxy(form).elements : undefined;
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

function scanDeclarativeTools(
  previous: Map<string, DeclarativeTool>,
): Map<string, DeclarativeTool> {
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
    const before = previous.get(name);
    found.set(name, {
      id: before?.form === form ? before.id : {},
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
  const next = scanDeclarativeTools(previous);
  declarativeTools = next;
  for (const [name, entry] of previous) {
    if (next.get(name)?.id !== entry.id) cancelPendingFormExecutions(entry.form);
  }
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

function cancelPendingFormExecutions(form: DeclarativeForm): void {
  const cancels = pendingFormCancels.get(form);
  if (!cancels) return;
  pendingFormCancels.delete(form);
  for (const cancel of cancels) cancel();
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
    dispatchContextEvent(context, new KsEvent("toolchange"));
  });
}

function dispatchContextEvent(context: ModelContext, event: KsEvent): void {
  try {
    dispatchTrustedOnKey(context, event);
  } catch {}
}

function dispatchToolEvent(
  context: ModelContext,
  type: "toolactivated" | "toolcancel",
  toolName: string,
): void {
  const event =
    type === "toolactivated"
      ? new KsToolActivatedEvent(type, { toolName })
      : new KsToolCancelEvent(type, { toolName });
  dispatchContextEvent(context, event);
}

const eventHandlers = new WeakMap<ModelContext, Map<string, unknown>>();

function eventHandler(context: ModelContext, type: string): Idl.EventHandler {
  return (eventHandlers.get(context)?.get(type) ?? null) as Idl.EventHandler;
}

// The handler's listener is added on the first set and stays, so it keeps its place in the
// listener order. [LegacyTreatNonObjectAsNull] keeps a non-callable object, which does nothing.
function setEventHandler(context: ModelContext, type: string, handler: unknown): void {
  let slots = eventHandlers.get(context);
  if (!slots) {
    slots = new Map();
    eventHandlers.set(context, slots);
  }
  const first = !slots.has(type);
  slots.set(type, isObjectOrFunction(handler) ? handler : null);
  if (!first) return;
  const handlers = slots;
  context.addEventListener(type, (event: Idl.Event) => {
    const current = handlers.get(type);
    if (typeof current !== "function") return;
    const result: unknown = current.call(context, event);
    if (result === false) event.preventDefault();
  });
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

function isObjectOrFunction(v: unknown): v is Record<string, unknown> {
  return isObjectLike(v) || typeof v === "function";
}

// WebIDL's ToString, which throws for a Symbol where String() would not.
function toDomString(value: unknown, what: string): string {
  if (typeof value === "symbol") throw new TypeError(`${what} cannot be a Symbol`);
  return String(value);
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

function abortReason(signal: { readonly reason?: unknown }): unknown {
  return signal.reason ?? domError("aborted", "AbortError");
}

// Converts an options dictionary down to the AbortSignal member every WebMCP options type has.
function optionsDictionary(options: unknown, op: string): Record<string, unknown> {
  if (options === undefined || options === null) return {};
  if (!isObjectOrFunction(options)) throw new TypeError(`${op}: options is not an object`);
  return options;
}

function signalMember(options: Record<string, unknown>, op: string): AbortSignalLike | undefined {
  const signal = options.signal;
  if (signal === undefined) return undefined;
  if (!isAbortSignalLike(signal))
    throw new TypeError(`${op}: options.signal is not an AbortSignal`);
  return signal;
}

function originSequence(value: unknown, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${what} must be a sequence`);
  return value.map((origin) => toUSVString(toDomString(origin, what)));
}

let allowConstruct = false;
export class ModelContext implements Idl.ModelContext {
  declare _tools: Map<string, ToolDefinition>;
  declare _isMain: boolean;
  declare _getWindow: () => unknown;
  declare _isFullyActive: () => boolean;
  declare _changeQueued: boolean;
  // finalizeInterface makes EventTarget the parent, which supplies these.
  declare removeEventListener: Idl.EventTarget["removeEventListener"];
  declare dispatchEvent: Idl.EventTarget["dispatchEvent"];

  constructor() {
    if (!allowConstruct) {
      throw new TypeError("Illegal constructor");
    }
    allowConstruct = false;
  }

  get ontoolchange(): Idl.EventHandler {
    return eventHandler(this, "toolchange");
  }

  set ontoolchange(handler: Idl.EventHandler) {
    setEventHandler(this, "toolchange", handler);
  }

  get ontoolactivated(): Idl.EventHandler {
    return eventHandler(this, "toolactivated");
  }

  set ontoolactivated(handler: Idl.EventHandler) {
    setEventHandler(this, "toolactivated", handler);
  }

  get ontoolcancel(): Idl.EventHandler {
    return eventHandler(this, "toolcancel");
  }

  set ontoolcancel(handler: Idl.EventHandler) {
    setEventHandler(this, "toolcancel", handler);
  }

  addEventListener(
    type: string,
    listener: Idl.EventListener | null,
    options?: boolean | Idl.AddEventListenerOptions,
  ): void {
    if (this._isMain && String(type) === "toolchange") {
      markDeclarativeInterest();
    }
    KsEventTarget.prototype.addEventListener.call(this, type, listener, options);
  }

  registerTool(tool: unknown, options?: unknown): Promise<void> {
    let converted: ConvertedTool;
    let signal: AbortSignalLike | undefined;
    let exposedTo: string[] | undefined;
    try {
      converted = convertTool(tool);
      const opts = optionsDictionary(options, "registerTool");
      exposedTo = originSequence(opts.exposedTo, "registerTool: exposedTo");
      signal = signalMember(opts, "registerTool");
    } catch (err) {
      return Promise.reject(err);
    }
    if (!this._isFullyActive()) {
      return Promise.reject(inactiveDocumentError("registerTool"));
    }
    let def: ToolDefinition;
    try {
      def = validate(converted, this._tools);
    } catch (err) {
      return Promise.reject(err);
    }
    // Serializing a schema runs page code (toJSON), which can detach the document or register.
    if (!this._isFullyActive()) {
      return Promise.reject(inactiveDocumentError("registerTool"));
    }
    if (this._tools.has(def.name)) {
      return Promise.reject(duplicateToolError(def.name));
    }
    if (signal && signal.aborted === true) {
      return Promise.reject(abortReason(signal));
    }
    for (const origin of exposedTo ?? []) {
      if (!isTrustworthyOrigin(origin)) {
        return Promise.reject(
          domError(
            `registerTool: exposedTo origin "${origin}" is not a potentially-trustworthy origin`,
            "SecurityError",
          ),
        );
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
          reject(abortReason(signal));
        });
      }
      // Queue toolchange before resolving so awaiters observe the notification first.
      notifyChanged(context);
      queueMicrotask(() => resolve(undefined));
    });
  }

  executeTool(tool: unknown, inputObject?: unknown, options?: unknown): Promise<string> {
    const slots = isObjectLike(tool) ? toolSlots.get(tool) : undefined;
    if (!slots) {
      return Promise.reject(new TypeError("executeTool: tool is not a Tool"));
    }
    if (inputObject !== undefined && !isObjectOrFunction(inputObject)) {
      return Promise.reject(new TypeError("executeTool: inputObject is not an object"));
    }
    let signal: AbortSignalLike | undefined;
    try {
      signal = signalMember(optionsDictionary(options, "executeTool"), "executeTool");
    } catch (err) {
      return Promise.reject(err);
    }
    if (!this._isFullyActive()) {
      return Promise.reject(inactiveDocumentError("executeTool"));
    }
    let originOk = false;
    try {
      originOk = new URL(slots.origin).origin !== "null";
    } catch {
      originOk = false;
    }
    if (!originOk) {
      return Promise.reject(
        domError(
          `executeTool: tool origin "${slots.origin}" is not a supported origin`,
          "NotSupportedError",
        ),
      );
    }
    let inputArguments: string | undefined;
    try {
      inputArguments = JSON.stringify(inputObject === undefined ? {} : inputObject);
    } catch (err) {
      return Promise.reject(err);
    }
    if (inputArguments === undefined) {
      return Promise.reject(new TypeError("executeTool: inputObject is not JSON-serializable"));
    }
    const target = slots.context;
    if (!target._isFullyActive()) {
      return Promise.reject(
        domError("executeTool: the tool's document is not fully active", "InvalidStateError"),
      );
    }
    if (signal && signal.aborted === true) {
      return Promise.reject(abortReason(signal));
    }
    const exec = registeredExecute(target, slots);
    if (!exec) {
      return Promise.reject(
        domError(`executeTool: tool "${slots.name}" is not registered`, "NotFoundError"),
      );
    }
    const args: unknown = JSON.parse(inputArguments);
    if (!isObjectLike(args)) {
      return Promise.reject(domError("executeTool: the input is not an object", "DataError"));
    }
    return runExecution(target, slots.name, exec, args, signal);
  }

  getTools(options?: unknown): Promise<Tool[]> {
    let fromOrigins: string[] | undefined;
    try {
      fromOrigins = originSequence(
        optionsDictionary(options, "getTools").fromOrigins,
        "getTools: fromOrigins",
      );
    } catch (err) {
      return Promise.reject(err);
    }
    if (!this._isFullyActive()) {
      return Promise.reject(inactiveDocumentError("getTools"));
    }
    for (const origin of fromOrigins ?? []) {
      if (!isTrustworthyOrigin(origin)) {
        return Promise.reject(
          domError(
            `getTools: fromOrigins entry "${origin}" is not a potentially-trustworthy origin`,
            "SecurityError",
          ),
        );
      }
    }
    const found: ToolSlots[] = [];
    for (const def of this._tools.values()) found.push(definitionSlots(def, this));
    if (this._isMain) {
      markDeclarativeInterest();
      refreshDeclarativeTools(true);
      for (const entry of declarativeTools.values()) found.push(declarativeSlots(entry, this));
    }
    found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return Promise.resolve(found.map(mintTool));
  }
}

function inactiveDocumentError(op: string): Error {
  return domError(`${op}: the document is not fully active`, "InvalidStateError");
}

function duplicateToolError(name: string): Error {
  return domError(
    `registerTool: a tool named "${name}" is already registered`,
    "InvalidStateError",
  );
}

// Finds the registration a Tool names; a same-named tool registered since is a different one.
function registeredExecute(context: ModelContext, slots: ToolSlots): ToolExecute | null {
  if (!slots.declarative) {
    const def = context._tools.get(slots.name);
    return def !== undefined && def.id === slots.id ? def.execute : null;
  }
  if (!context._isMain) return null;
  markDeclarativeInterest();
  // A form can change before its queued mutation refresh, so rescan before the lookup.
  refreshDeclarativeTools(true);
  const entry = declarativeTools.get(slots.name);
  return entry !== undefined && entry.id === slots.id ? makeDeclarativeExec(entry) : null;
}

// Tool results reach the caller as a string; a string result passes through unquoted.
function serializeToolResult(value: unknown): string | null {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : json;
  } catch {
    return null;
  }
}

// WebIDL turns a callback's synchronous throw into a rejected promise.
function invokeExecute(execute: ToolExecute, args: object, signal: AbortSignal): unknown {
  try {
    return execute(args, { signal });
  } catch (err) {
    return Promise.reject(err);
  }
}

function runExecution(
  target: ModelContext,
  toolName: string,
  exec: ToolExecute,
  args: object,
  signal: AbortSignalLike | undefined,
): Promise<string> {
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
    const settleInTask = (settle: () => void) => {
      queueTask(() => {
        if (settled) return;
        settled = true;
        detach();
        settle();
      });
    };
    if (signal && signal.addEventListener) {
      onAbort = () => {
        if (settled) return;
        settled = true;
        detach();
        reject(abortReason(signal));
        if (callbackSettled) return;
        queueTask(() => {
          if (callbackSettled) return;
          try {
            execController.abort();
          } catch {}
          dispatchToolEvent(target, "toolcancel", toolName);
        });
      };
      signal.addEventListener("abort", onAbort);
    }
    Promise.resolve()
      .then(() => {
        const pending = invokeExecute(exec, args, execController.signal);
        dispatchToolEvent(target, "toolactivated", toolName);
        return pending;
      })
      .then(
        (value) => {
          callbackSettled = true;
          if (settled) return;
          const result = serializeToolResult(value);
          if (result === null) {
            settleInTask(() =>
              reject(
                domError("executeTool: the tool result is not JSON-serializable", "OperationError"),
              ),
            );
          } else {
            settleInTask(() => resolve(result));
          }
        },
        (err: unknown) => {
          callbackSettled = true;
          if (settled) return;
          if (isObjectLike(err) && declarativeCancels.has(err)) {
            settled = true;
            detach();
            reject(err);
            try {
              execController.abort();
            } catch {}
            queueTask(() => dispatchToolEvent(target, "toolcancel", toolName));
            return;
          }
          // The caller sees only the failure, never the tool's own exception.
          settleInTask(() =>
            reject(domError("executeTool: the tool's execute callback rejected", "OperationError")),
          );
        },
      );
  });
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
  const elements = formBehindProxy(form).elements;
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
  if (typeof formBehindProxy(form).dispatchEvent === "function") {
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

function makeDeclarativeExec(entry: DeclarativeTool): ToolExecute {
  return (input: object, options) => {
    const args = input as Record<string, unknown>;
    fillDeclarativeControls(entry.form, args);
    if (entry.autosubmit) {
      const submitted = dispatchToolSubmit(entry.form);
      const signal = options?.signal;
      if (!signal?.addEventListener) return Promise.resolve(submitted);
      return new Promise<unknown>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          signal.removeEventListener?.("abort", onAbort);
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(abortReason(signal));
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
      let cancels = pendingFormCancels.get(form);
      if (!cancels) {
        cancels = new Set();
        pendingFormCancels.set(form, cancels);
      }
      const cleanup = () => {
        activeToolForms.delete(entry.form);
        if (onSubmit && form.removeEventListener) {
          form.removeEventListener("submit", onSubmit);
        }
        if (onAbort && signal?.removeEventListener) {
          signal.removeEventListener("abort", onAbort);
        }
        cancels.delete(cancel);
        if (cancels.size === 0 && pendingFormCancels.get(form) === cancels) {
          pendingFormCancels.delete(form);
        }
      };
      // The form stopped being this tool before its submission: the execution is cancelled.
      const cancel = () => {
        cleanup();
        const err = domError("the declarative tool was unregistered", "AbortError");
        declarativeCancels.add(err);
        reject(err);
      };
      cancels.add(cancel);
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
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", onAbort);
      }
    });
  };
}

function fillDeclarativeControls(form: DeclarativeForm, args: Record<string, unknown>): void {
  const elements = form ? formBehindProxy(form).elements : undefined;
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

interface ConvertedTool {
  name: string;
  title: string | null;
  description: string;
  inputSchema: object | undefined;
  outputSchema: object | undefined;
  execute: ToolExecute;
  annotations: ToolAnnotations | null;
}

function convertAnnotations(value: unknown): ToolAnnotations | null {
  if (value === undefined) return null;
  if (value !== null && !isObjectOrFunction(value)) {
    throw new TypeError("registerTool: tool.annotations is not an object");
  }
  const a: Record<string, unknown> = isObjectOrFunction(value) ? value : {};
  return {
    consequentialHint: Boolean(a.consequentialHint),
    debugging: Boolean(a.debugging),
    readOnlyHint: Boolean(a.readOnlyHint),
    untrustedContentHint: Boolean(a.untrustedContentHint),
  };
}

function convertSchema(value: unknown, what: string): object | undefined {
  if (value === undefined) return undefined;
  if (!isObjectOrFunction(value)) throw new TypeError(`registerTool: ${what} is not an object`);
  return value;
}

// WebIDL dictionary conversion: members are read once, in lexicographic order.
function convertTool(tool: unknown): ConvertedTool {
  if (tool !== undefined && tool !== null && !isObjectOrFunction(tool)) {
    throw new TypeError("registerTool: tool is not an object");
  }
  const t: Record<string, unknown> = isObjectOrFunction(tool) ? tool : {};
  const annotations = convertAnnotations(t.annotations);
  const description = t.description;
  if (description === undefined) throw new TypeError("registerTool: tool.description is required");
  const descriptionString = toDomString(description, "registerTool: tool.description");
  const execute = t.execute;
  if (typeof execute !== "function") {
    throw new TypeError("registerTool: tool.execute must be a function");
  }
  const inputSchema = convertSchema(t.inputSchema, "tool.inputSchema");
  const name = t.name;
  if (name === undefined) throw new TypeError("registerTool: tool.name is required");
  const nameString = toDomString(name, "registerTool: tool.name");
  const outputSchema = convertSchema(t.outputSchema, "tool.outputSchema");
  const title = t.title;
  return {
    name: nameString,
    title: title === undefined ? null : toUSVString(toDomString(title, "registerTool: tool.title")),
    description: descriptionString,
    inputSchema,
    outputSchema,
    execute: execute as ToolExecute,
    annotations,
  };
}

function serializeSchema(schema: object | undefined, what: string): string {
  if (schema === undefined) return "";
  const json = JSON.stringify(schema);
  if (json === undefined) throw new TypeError(`registerTool: ${what} is not JSON-serializable`);
  return json;
}

function validate(tool: ConvertedTool, registry: Map<string, ToolDefinition>): ToolDefinition {
  const { name } = tool;
  if (registry.has(name)) throw duplicateToolError(name);
  if (name === "" || name.length > MAX_MODEL_CONTEXT_TOOL_NAME_LENGTH || !NAME_OK.test(name)) {
    throw domError(`registerTool: invalid tool name "${name}"`, "InvalidStateError");
  }
  if (tool.description === "") {
    throw domError("registerTool: the description must be non-empty", "InvalidStateError");
  }
  return {
    id: {},
    name,
    title: tool.title,
    description: tool.description,
    inputSchema: serializeSchema(tool.inputSchema, "inputSchema"),
    outputSchema: serializeSchema(tool.outputSchema, "outputSchema"),
    execute: tool.execute,
    annotations: tool.annotations,
  };
}

/** Starts a new document context, signals abort to active calls, and clears prior registrations. */
export function createModelContext(deps: {
  getWindow: () => unknown;
  getOrigin: () => string;
  getDocument: () => unknown;
}): ModelContext {
  for (const execution of activeToolExecutions.values()) execution.controller.abort();
  tools.clear();
  activeToolExecutions.clear();
  declarativeTools.clear();
  declarativeCandidates = 0;
  declarativeWatchActive = false;
  declarativeWatchRevision = 0;
  declarativeRefreshQueued = false;
  pageDeclarativeInterest = false;
  pendingFormCancels = new Map();
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
    const parsed: unknown = json === undefined ? null : JSON.parse(json);
    return parsed;
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
    output: JSON.parse(serialized) as unknown,
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
  const controller = createExecutionController();
  if (id !== "") {
    activeToolExecutions.set(id, { controller, name: key });
  }
  try {
    const args = isObjectLike(input) ? input : {};
    const pending = invokeExecute(execute, args, controller.signal);
    if (mainContext) dispatchToolEvent(mainContext, "toolactivated", key);
    const result = await pending;
    return returnsDeclarativeOutput ? declarativeResult(result) : normalizeResult(result);
  } catch (err) {
    if (isObjectLike(err) && declarativeCancels.has(err)) {
      const context = mainContext;
      if (context) queueTask(() => dispatchToolEvent(context, "toolcancel", key));
      return { content: [], isError: true, error: "tool canceled", canceled: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      error: message,
      threw: true,
    };
  } finally {
    if (activeToolExecutions.get(id)?.controller === controller) {
      activeToolExecutions.delete(id);
    }
  }
}

/** Signals abort for a running invocation; returns false for an unknown or inactive ID. */
export function cancelModelContextTool(invocationId: unknown): boolean {
  const id = typeof invocationId === "string" ? invocationId : "";
  if (id === "") return false;
  const execution = activeToolExecutions.get(id);
  if (!execution) return false;
  activeToolExecutions.delete(id);
  execution.controller.abort();
  if (mainContext) dispatchToolEvent(mainContext, "toolcancel", execution.name);
  return true;
}
