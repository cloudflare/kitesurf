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
const IGNORED_DECLARATIVE_CONTROL_TYPES = new Set([
  "submit",
  "reset",
  "button",
  "image",
  "hidden",
  "file",
]);
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
    addDeclarativeControlSchema(elements[i], properties, required);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.size > 0) schema.required = Array.from(required);
  return schema;
}

function isIgnoredDeclarativeControl(tag: string, type: string): boolean {
  return tag === "button" || IGNORED_DECLARATIVE_CONTROL_TYPES.has(type);
}

function isNumericControlType(type: string): boolean {
  return type === "number" || type === "range";
}

function numericBound(value: unknown): number | null {
  if (value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numericControlSchema(control: DeclarativeControl): Record<string, unknown> {
  const property: Record<string, unknown> = { type: "number" };
  const minimum = numericBound(control.min);
  const maximum = numericBound(control.max);
  if (minimum !== null) property.minimum = minimum;
  if (maximum !== null) property.maximum = maximum;
  return property;
}

function radioControlSchema(
  control: DeclarativeControl,
  name: string,
  properties: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const current = properties[name];
  const values = Array.isArray(current?.enum) ? current.enum.slice() : [];
  const value = String(control.value ?? "on");
  if (!values.includes(value)) values.push(value);
  return { type: "string", enum: values };
}

function selectOptionValues(options: ArrayLike<DeclarativeOption> | undefined): string[] {
  const values: string[] = [];
  if (!options) return values;
  for (let i = 0; i < options.length; i++) appendSelectOptionValue(values, options[i]);
  return values;
}

function appendSelectOptionValue(values: string[], option: DeclarativeOption): void {
  if (option?.disabled !== true) values.push(String(option?.value ?? ""));
}

function selectControlSchema(control: DeclarativeControl): Record<string, unknown> {
  const values = selectOptionValues(control.options);
  const item: Record<string, unknown> = { type: "string" };
  if (values.length > 0) item.enum = values;
  if (control.multiple !== true) return item;
  return { type: "array", items: item };
}

function scalarControlSchema(type: string): Record<string, unknown> {
  const property: Record<string, unknown> = { type: "string" };
  if (type === "email") property.format = "email";
  return property;
}

function controlSchemaProperty(
  control: DeclarativeControl,
  tag: string,
  type: string,
  name: string,
  properties: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  if (type === "checkbox") return { type: "boolean" };
  if (isNumericControlType(type)) return numericControlSchema(control);
  if (type === "radio") return radioControlSchema(control, name, properties);
  if (tag === "select") return selectControlSchema(control);
  return scalarControlSchema(type);
}

interface DeclarativeControlDetails {
  name: string;
  tag: string;
  type: string;
}

function declarativeControlName(control: DeclarativeControl): string {
  return String(control?.name ?? "");
}

function declarativeControlTag(control: DeclarativeControl): string {
  return String(control?.localName ?? "").toLowerCase();
}

function declarativeControlType(control: DeclarativeControl): string {
  return String(control?.type ?? "").toLowerCase();
}

function isDeclarativeControlDisabled(control: DeclarativeControl): boolean {
  return control?.disabled === true;
}

function declarativeControlDetails(control: DeclarativeControl): DeclarativeControlDetails | null {
  const name = declarativeControlName(control);
  if (!name || isDeclarativeControlDisabled(control)) return null;
  const tag = declarativeControlTag(control);
  const type = declarativeControlType(control);
  if (isIgnoredDeclarativeControl(tag, type)) return null;
  return { name, tag, type };
}

function addDeclarativeControlSchema(
  control: DeclarativeControl,
  properties: Record<string, Record<string, unknown>>,
  required: Set<string>,
): void {
  const details = declarativeControlDetails(control);
  if (!details) return;
  const property = controlSchemaProperty(
    control,
    details.tag,
    details.type,
    details.name,
    properties,
  );
  addDeclarativeControlDetails(control, details.name, property, properties, required);
}

function declarativeControlDescription(control: DeclarativeControl): string | null | undefined {
  return control?.getAttribute?.("toolparamdescription");
}

function declarativeControlRequired(control: DeclarativeControl): boolean {
  return control?.required === true;
}

function addDeclarativeControlDetails(
  control: DeclarativeControl,
  name: string,
  property: Record<string, unknown>,
  properties: Record<string, Record<string, unknown>>,
  required: Set<string>,
): void {
  const description = declarativeControlDescription(control);
  if (description) property.description = description;
  properties[name] = property;
  if (declarativeControlRequired(control)) required.add(name);
}

function declarativeForms(): DeclarativeForm[] {
  // The host injects the live DOM shim Document through this internal callback.
  const doc = getDocument() as DeclarativeDocument | null | undefined;
  try {
    return Array.from(doc?.querySelectorAll?.("form[toolname][tooldescription]") ?? []);
  } catch {
    return [];
  }
}

function validDeclarativeToolIdentity(
  name: string,
  description: string,
  found: Map<string, DeclarativeTool>,
): boolean {
  if (!hasDeclarativeToolIdentity(name, description)) return false;
  if (!isValidDeclarativeToolName(name)) return false;
  return !tools.has(name) && !found.has(name);
}

function hasDeclarativeToolIdentity(name: string, description: string): boolean {
  return name !== "" && description !== "";
}

function isValidDeclarativeToolName(name: string): boolean {
  return name.length <= MAX_MODEL_CONTEXT_TOOL_NAME_LENGTH && NAME_OK.test(name);
}

function readDeclarativeToolIdentity(
  form: DeclarativeForm,
  found: Map<string, DeclarativeTool>,
): { name: string; description: string } | null {
  const name = declarativeFormAttribute(form, "toolname");
  const description = declarativeFormAttribute(form, "tooldescription");
  if (!validDeclarativeToolIdentity(name, description, found)) return null;
  return { name, description };
}

function declarativeFormAttribute(form: DeclarativeForm, name: string): string {
  return String(form?.getAttribute?.(name) ?? "");
}

function declarativeAutosubmit(form: DeclarativeForm): boolean {
  return form?.getAttribute?.("toolautosubmit") != null;
}

function declarativeBackendNodeId(form: DeclarativeForm): number | undefined {
  const id = form?._id;
  return typeof id === "number" && id > 0 ? id : undefined;
}

function declarativeToolDescriptor(
  form: DeclarativeForm,
  name: string,
  description: string,
  autosubmit: boolean,
): CdpTool {
  const descriptor: CdpTool = { name, description, inputSchema: declarativeSchema(form) };
  if (autosubmit) descriptor.annotations = { autosubmit: true };
  const backendNodeId = declarativeBackendNodeId(form);
  if (backendNodeId !== undefined) descriptor.backendNodeId = backendNodeId;
  return descriptor;
}

function makeDeclarativeTool(
  form: DeclarativeForm,
  found: Map<string, DeclarativeTool>,
): DeclarativeTool | null {
  const identity = readDeclarativeToolIdentity(form, found);
  if (!identity) return null;
  const autosubmit = declarativeAutosubmit(form);
  const descriptor = declarativeToolDescriptor(
    form,
    identity.name,
    identity.description,
    autosubmit,
  );
  const title = String(form?.getAttribute?.("tooltitle") ?? "");
  return {
    descriptor,
    form,
    title,
    autosubmit,
    sig: JSON.stringify([descriptor, title, autosubmit]),
  };
}

function scanDeclarativeTools(): Map<string, DeclarativeTool> {
  const found = new Map<string, DeclarativeTool>();
  const forms = declarativeForms();
  declarativeCandidates = forms.length;
  for (const form of forms) {
    const entry = makeDeclarativeTool(form, found);
    if (entry) found.set(entry.descriptor.name, entry);
  }
  return found;
}

function refreshDeclarativeTools(notify: boolean): void {
  const previous = declarativeTools;
  const next = scanDeclarativeTools();
  declarativeTools = next;
  // The first page or CDP read seeds existing forms instead of reporting additions.
  if (!notify) return;
  notifyDeclarativeChanges(previous, next);
}

function removedDeclarativeNames(
  previous: Map<string, DeclarativeTool>,
  next: Map<string, DeclarativeTool>,
): string[] {
  const removed: string[] = [];
  for (const name of previous.keys()) {
    if (!next.has(name)) removed.push(name);
  }
  return removed;
}

function addedDeclarativeTools(
  previous: Map<string, DeclarativeTool>,
  next: Map<string, DeclarativeTool>,
  removed: string[],
): CdpTool[] {
  const added: CdpTool[] = [];
  for (const [name, entry] of next) {
    const before = previous.get(name);
    if (!before || before.sig !== entry.sig) {
      if (before) removed.push(name);
      added.push(entry.descriptor);
    }
  }
  return added;
}

function sendDeclarativeDeltas(removed: string[], added: CdpTool[]): void {
  if (!declarativeWatchActive) return;
  if (removed.length > 0) {
    sendDelta({ event: "kitesurf.modelContextToolsRemoved", params: { names: removed } });
  }
  if (added.length > 0) {
    sendDelta({ event: "kitesurf.modelContextToolsAdded", params: { tools: added } });
  }
}

function notifyDeclarativeChanges(
  previous: Map<string, DeclarativeTool>,
  next: Map<string, DeclarativeTool>,
): void {
  const removed = removedDeclarativeNames(previous, next);
  const added = addedDeclarativeTools(previous, next, removed);
  if (removed.length === 0 && added.length === 0) return;
  sendDeclarativeDeltas(removed, added);
  if (mainContext) notifyChanged(mainContext);
}

function scheduleDeclarativeRefresh(hint?: MutationHint): void {
  if (!declarativeRefreshNeeded()) return;
  if (!declarativeHintMayAddCandidate(hint)) return;
  declarativeRefreshQueued = true;
  queueMicrotask(() => {
    declarativeRefreshQueued = false;
    if (!declarativeInterestActive()) return;
    refreshDeclarativeTools(true);
  });
}

function declarativeInterestActive(): boolean {
  return declarativeWatchActive || pageDeclarativeInterest;
}

function declarativeRefreshNeeded(): boolean {
  return declarativeInterestActive() && !declarativeRefreshQueued;
}

function declarativeHintMayAddCandidate(hint?: MutationHint): boolean {
  return !(
    declarativeCandidates === 0 &&
    hint !== undefined &&
    (typeof hint === "string" || !DECLARATIVE_ATTRIBUTES.has(hint.attribute.toLowerCase()))
  );
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
    const list = this._listeners.get(toolEventType(event));
    for (const listener of list?.slice() ?? []) dispatchToolListener(this, event, listener);
    return true;
  }
}

function toolEventType(event: unknown): string {
  const ev = event as { type?: string };
  return String(ev?.type ?? "");
}

function dispatchToolListener(
  target: ToolEventTarget,
  event: unknown,
  listener: (event: unknown) => void,
): void {
  try {
    listener.call(target, event);
  } catch (error) {
    reportListenerError(error);
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
  return isSecureOriginScheme(scheme) || isLocalHttpOrigin(u, scheme);
}

function isSecureOriginScheme(scheme: string): boolean {
  return scheme === "https:" || scheme === "wss:";
}

function isLocalHttpOrigin(url: URL, scheme: string): boolean {
  if (scheme !== "http:" && scheme !== "ws:") return false;
  return isLoopbackHostname(url.hostname.toLowerCase());
}

function isLoopbackHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".localhost")
  );
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

type ToolValidationResult =
  | { ok: true; definition: ToolDefinition }
  | { ok: false; error: unknown };
type RegisterOptionsResult =
  | { ok: true; signal: AbortSignalLike | undefined }
  | { ok: false; error: unknown };

function tryValidateTool(
  tool: unknown,
  registry: Map<string, ToolDefinition>,
): ToolValidationResult {
  try {
    return { ok: true, definition: validate(tool, registry) };
  } catch (error) {
    return { ok: false, error };
  }
}

function untrustworthyOriginError(
  origins: unknown[],
  messageForOrigin: (origin: unknown) => string,
): Error | null {
  for (const origin of origins) {
    if (typeof origin !== "string" || !isTrustworthyOrigin(origin)) {
      return domError(messageForOrigin(origin), "SecurityError");
    }
  }
  return null;
}

function exposedToError(exposedTo: unknown): Error | null {
  if (exposedTo === undefined) return null;
  if (!Array.isArray(exposedTo)) {
    return new TypeError("registerTool: exposedTo must be a sequence");
  }
  return untrustworthyOriginError(
    exposedTo,
    (origin) =>
      `registerTool: exposedTo origin "${String(origin)}" is not a potentially-trustworthy origin`,
  );
}

function optionsRecord(options: unknown): Record<string, unknown> {
  return isObjectLike(options) ? options : {};
}

function optionAbortSignal(options: unknown): AbortSignalLike | undefined {
  const opts = optionsRecord(options);
  return isAbortSignalLike(opts.signal) ? opts.signal : undefined;
}

function abortSignalReason(signal: AbortSignalLike | undefined): unknown | null {
  if (!signal || signal.aborted !== true) return null;
  return signal.reason ?? domError("aborted", "AbortError");
}

function registerOptionsResult(options: unknown): RegisterOptionsResult {
  const signal = optionAbortSignal(options);
  const aborted = abortSignalReason(signal);
  if (aborted !== null) return { ok: false, error: aborted };
  const error = exposedToError(optionsRecord(options).exposedTo);
  if (error) return { ok: false, error };
  return { ok: true, signal };
}

function notifyToolRegistrationAdded(context: ModelContext, definition: ToolDefinition): void {
  if (context._isMain) {
    sendDelta({
      event: "kitesurf.modelContextToolsAdded",
      params: { tools: [toCdpTool(definition)] },
    });
  }
}

function removeAbortedRegistration(
  context: ModelContext,
  registry: Map<string, ToolDefinition>,
  definition: ToolDefinition,
  signal: AbortSignalLike,
  reject: (reason: unknown) => void,
): void {
  if (registry.get(definition.name) === definition) {
    registry.delete(definition.name);
    if (context._isMain) {
      sendDelta({
        event: "kitesurf.modelContextToolsRemoved",
        params: { names: [definition.name] },
      });
    }
    notifyChanged(context);
  }
  reject(signal.reason ?? domError("aborted", "AbortError"));
}

function waitForToolRegistration(
  context: ModelContext,
  registry: Map<string, ToolDefinition>,
  definition: ToolDefinition,
  signal: AbortSignalLike | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal && signal.addEventListener) {
      signal.addEventListener("abort", () =>
        removeAbortedRegistration(context, registry, definition, signal, reject),
      );
    }
    // Queue toolchange before resolving so awaiters observe the notification first.
    notifyChanged(context);
    queueMicrotask(() => resolve(undefined));
  });
}

type ExecuteRequestResult = { ok: true; name: string } | { ok: false; error: Error };

type ExecuteRequestFieldsResult =
  | { ok: true; name: string; origin: string }
  | { ok: false; error: Error };

function executeRequestFields(tool: unknown): ExecuteRequestFieldsResult {
  if (!isObjectLike(tool)) {
    return { ok: false, error: new TypeError("executeTool: tool must be a dictionary") };
  }
  if (typeof tool.origin !== "string") {
    return { ok: false, error: new TypeError("executeTool: tool.origin is required") };
  }
  if (typeof tool.name !== "string" || tool.name === "") {
    return { ok: false, error: new TypeError("executeTool: tool.name is required") };
  }
  return { ok: true, origin: tool.origin, name: tool.name };
}

function isSupportedToolOrigin(origin: string): boolean {
  try {
    return new URL(origin).origin !== "null";
  } catch {
    return false;
  }
}

function executeRequestResult(tool: unknown, isFullyActive: () => boolean): ExecuteRequestResult {
  const fields = executeRequestFields(tool);
  if (!fields.ok) return fields;
  if (!isFullyActive()) return { ok: false, error: inactiveDocumentError("executeTool") };
  if (!isSupportedToolOrigin(fields.origin)) {
    return {
      ok: false,
      error: domError(
        `executeTool: tool origin "${fields.origin}" is not a supported origin`,
        "NotSupportedError",
      ),
    };
  }
  return { ok: true, name: fields.name };
}

type ExecutionArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: unknown };
type SerializedExecutionInput = { ok: true; json: string } | { ok: false; error: unknown };

function isExecutionInputContainer(input: unknown): boolean {
  return typeof input === "object" || typeof input === "function";
}

function primitiveExecutionInputJson(input: unknown): string {
  return typeof input === "string" ? input : String(input);
}

function serializeContainerExecutionInput(input: unknown): SerializedExecutionInput {
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch (error) {
    return { ok: false, error };
  }
  if (json === undefined) {
    return {
      ok: false,
      error: new TypeError("executeTool: inputObject is not JSON-serializable"),
    };
  }
  return { ok: true, json };
}

function serializeExecutionInput(input: unknown): SerializedExecutionInput {
  if (!isExecutionInputContainer(input)) {
    return { ok: true, json: primitiveExecutionInputJson(input) };
  }
  return serializeContainerExecutionInput(input);
}

function parseExecutionJson(json: string): ExecutionArgsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: domError(`executeTool: invalid JSON args: ${message}`, "UnknownError"),
    };
  }
  if (!isObjectLike(parsed)) {
    return {
      ok: false,
      error: domError("executeTool: args must be a JSON object", "UnknownError"),
    };
  }
  return { ok: true, args: parsed };
}

function parseExecutionArgs(input: unknown): ExecutionArgsResult {
  if (input === undefined || input === null) return { ok: true, args: {} };
  const serialized = serializeExecutionInput(input);
  if (!serialized.ok) return serialized;
  return parseExecutionJson(serialized.json);
}

type ExecutionSignalResult =
  | { ok: true; signal: AbortSignalLike | undefined }
  | { ok: false; error: unknown };

function executionSignalResult(options: unknown): ExecutionSignalResult {
  const signal = optionAbortSignal(options);
  const aborted = abortSignalReason(signal);
  if (aborted !== null) return { ok: false, error: aborted };
  return { ok: true, signal };
}

function resolveToolExecutor(
  context: ModelContext,
  name: string,
): WebMCP.ToolExecuteCallback | null {
  const definition = context._tools.get(name);
  let execute = definition ? definition.execute : null;
  if (!execute && context._isMain) {
    markDeclarativeInterest();
    // A form can appear before its queued mutation refresh, so rescan before fallback lookup.
    refreshDeclarativeTools(true);
    const entry = declarativeTools.get(name);
    if (entry) execute = makeDeclarativeExec(entry);
  }
  return execute;
}

interface ToolExecutionState {
  readonly signal: AbortSignalLike | undefined;
  readonly controller: AbortControllerLike;
  readonly window: unknown;
  readonly toolName: string;
  readonly resolve: (value: string) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
  callbackSettled: boolean;
  onAbort: (() => void) | null;
}

type ToolOutput = { kind: "resolve"; value: string } | { kind: "unserializable" };

function detachToolAbortListener(state: ToolExecutionState): void {
  if (state.onAbort && state.signal && state.signal.removeEventListener) {
    state.signal.removeEventListener("abort", state.onAbort);
  }
  state.onAbort = null;
}

function settleToolOutput(state: ToolExecutionState, output: ToolOutput): void {
  if (state.settled) return;
  state.settled = true;
  detachToolAbortListener(state);
  if (output.kind === "resolve") state.resolve(output.value);
  else {
    state.reject(domError("executeTool: tool result is not JSON-serializable", "UnknownError"));
  }
}

function serializeToolOutput(value: unknown): ToolOutput {
  if (value === undefined) return { kind: "resolve", value: "" };
  if (typeof value === "string") return { kind: "resolve", value };
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  return json === undefined ? { kind: "unserializable" } : { kind: "resolve", value: json };
}

function handleToolOutput(state: ToolExecutionState, value: unknown): void {
  state.callbackSettled = true;
  if (state.settled) return;
  const output = serializeToolOutput(value);
  queueTask(() => settleToolOutput(state, output));
}

function handleToolError(state: ToolExecutionState, error: unknown): void {
  state.callbackSettled = true;
  if (state.settled) return;
  const message = error instanceof Error ? error.message : String(error);
  queueTask(() => {
    if (state.settled) return;
    state.settled = true;
    detachToolAbortListener(state);
    state.reject(domError(`executeTool: ${message}`, "UnknownError"));
  });
}

function fireToolCancellation(state: ToolExecutionState): void {
  if (state.callbackSettled) return;
  try {
    state.controller.abort();
  } catch {}
  dispatchWindowToolEvent(state.window, "toolcancel", state.toolName);
}

function handleToolAbort(state: ToolExecutionState): void {
  if (state.settled) return;
  state.settled = true;
  detachToolAbortListener(state);
  state.reject(state.signal?.reason ?? domError("aborted", "AbortError"));
  if (!state.callbackSettled) queueTask(() => fireToolCancellation(state));
}

function attachToolAbortListener(state: ToolExecutionState): void {
  if (!state.signal || !state.signal.addEventListener) return;
  state.onAbort = () => handleToolAbort(state);
  state.signal.addEventListener("abort", state.onAbort);
}

function invokeToolCallback(
  execute: WebMCP.ToolExecuteCallback,
  args: Record<string, unknown>,
  state: ToolExecutionState,
): unknown {
  const result = execute(args, { signal: state.controller.signal });
  dispatchWindowToolEvent(state.window, "toolactivated", state.toolName);
  return result;
}

function startToolCallback(
  execute: WebMCP.ToolExecuteCallback,
  args: Record<string, unknown>,
  state: ToolExecutionState,
): void {
  Promise.resolve()
    .then(() => invokeToolCallback(execute, args, state))
    .then(
      (value) => handleToolOutput(state, value),
      (error) => handleToolError(state, error),
    );
}

function runToolExecution(
  execute: WebMCP.ToolExecuteCallback,
  args: Record<string, unknown>,
  signal: AbortSignalLike | undefined,
  window: unknown,
  toolName: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const state: ToolExecutionState = {
      signal,
      controller: createExecutionController(),
      window,
      toolName,
      resolve,
      reject,
      settled: false,
      callbackSettled: false,
      onAbort: null,
    };
    attachToolAbortListener(state);
    startToolCallback(execute, args, state);
  });
}

function fromOriginsError(options: unknown): Error | null {
  const fromOrigins = optionsRecord(options).fromOrigins;
  if (fromOrigins === undefined) return null;
  if (!Array.isArray(fromOrigins)) return new TypeError("getTools: fromOrigins must be a sequence");
  return untrustworthyOriginError(
    fromOrigins,
    (origin) =>
      `getTools: fromOrigins entry "${String(origin)}" is not a potentially-trustworthy origin`,
  );
}

function contextTools(context: ModelContext): SerializedTool[] {
  const out = snapshot(context._tools);
  if (!context._isMain) return out;
  markDeclarativeInterest();
  refreshDeclarativeTools(true);
  for (const entry of declarativeTools.values()) out.push(serializeDeclarative(entry));
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
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
    const validation = tryValidateTool(tool, this._tools);
    if (!validation.ok) return Promise.reject(validation.error);
    const parsedOptions = registerOptionsResult(options);
    if (!parsedOptions.ok) return Promise.reject(parsedOptions.error);
    const def = validation.definition;
    const registry = this._tools;
    registry.set(def.name, def);
    notifyToolRegistrationAdded(this, def);
    return waitForToolRegistration(this, registry, def, parsedOptions.signal);
  }

  executeTool(tool: unknown, inputObject?: unknown, options?: unknown): Promise<string> {
    const request = executeRequestResult(tool, () => this._isFullyActive());
    if (!request.ok) return Promise.reject(request.error);
    const execute = resolveToolExecutor(this, request.name);
    if (!execute) {
      return Promise.reject(
        domError(`executeTool: no tool named "${request.name}"`, "UnknownError"),
      );
    }
    const parsedArgs = parseExecutionArgs(inputObject);
    if (!parsedArgs.ok) return Promise.reject(parsedArgs.error);
    const parsedOptions = executionSignalResult(options);
    if (!parsedOptions.ok) return Promise.reject(parsedOptions.error);
    return runToolExecution(
      execute,
      parsedArgs.args,
      parsedOptions.signal,
      this._getWindow(),
      request.name,
    );
  }

  getTools(options?: WebMCP.ModelContextGetToolOptions): Promise<WebMCP.RegisteredTool[]> {
    if (!this._isFullyActive()) {
      return Promise.reject(inactiveDocumentError("getTools"));
    }
    const error = fromOriginsError(options);
    if (error) return Promise.reject(error);
    const win = this._getWindow() as WebMCP.RegisteredTool["window"];
    const out = contextTools(this);
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
    if (!isWindowEventTarget(win)) return;
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

function isWindowEventTarget(win: unknown): win is object {
  return win !== null && (typeof win === "object" || typeof win === "function");
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
  const submitter = findDeclarativeSubmitter(form.elements);
  const ev = new KsSubmitEvent("submit", {
    bubbles: true,
    cancelable: true,
    agentInvoked: true,
    submitter,
  });
  dispatchDeclarativeSubmit(form, ev);
  if (!ev.defaultPrevented) {
    form.__ksPerformSubmission?.(submitter);
  }
  const responded = submitEventResponse(ev);
  if (responded && typeof responded.then === "function") {
    return responded;
  }
  return "";
}

function isDeclarativeSubmitter(control: DeclarativeControl): boolean {
  const tag = declarativeControlTag(control);
  const type = declarativeControlType(control);
  return (
    isEnabledDeclarativeSubmitter(control) &&
    (isSubmitButton(tag, type) || isSubmitInput(tag, type))
  );
}

function isEnabledDeclarativeSubmitter(control: DeclarativeControl): boolean {
  return control?.disabled !== true;
}

function isSubmitButton(tag: string, type: string): boolean {
  return tag === "button" && type === "submit";
}

function isSubmitInput(tag: string, type: string): boolean {
  return tag === "input" && (type === "submit" || type === "image");
}

function findDeclarativeSubmitter(
  elements: ArrayLike<DeclarativeControl> | undefined,
): DeclarativeControl | null {
  let submitter: DeclarativeControl | null = null;
  for (let i = 0; elements && i < elements.length; i++) {
    const control = elements[i];
    if (isDeclarativeSubmitter(control)) {
      submitter = control;
      break;
    }
  }
  return submitter;
}

function dispatchDeclarativeSubmit(form: DeclarativeForm, event: KsSubmitEvent): void {
  if (typeof form.dispatchEvent === "function") {
    const fire = () => {
      dispatchTrustedEvent(form, event);
    };
    // Reuse the form guard so a handler's requestSubmit cannot redispatch submit.
    if (typeof form.__ksFiringSubmit === "function") form.__ksFiringSubmit(fire);
    else fire();
  }
}

function makeDeclarativeExec(entry: DeclarativeTool): WebMCP.ToolExecuteCallback {
  return (args, options) => executeDeclarativeTool(entry, args, options);
}

function executeDeclarativeTool(
  entry: DeclarativeTool,
  args: Record<string, unknown>,
  options: WebMCP.ToolExecuteCallbackOptions,
): unknown {
  fillDeclarativeControls(entry.form, args);
  if (entry.autosubmit) return waitForAutomaticSubmission(entry, options);
  return waitForManualSubmission(entry, options);
}

interface SubmissionWaitState {
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
}

function finishSubmissionWait(
  state: SubmissionWaitState,
  outcome: { ok: true; value: unknown } | { ok: false; reason: unknown },
): void {
  if (state.settled) return;
  state.settled = true;
  state.signal.removeEventListener("abort", state.onAbort);
  if (outcome.ok) state.resolve(outcome.value);
  else state.reject(outcome.reason);
}

function waitForAutomaticSubmission(
  entry: DeclarativeTool,
  options: WebMCP.ToolExecuteCallbackOptions,
): unknown {
  const submitted = dispatchToolSubmit(entry.form);
  const signal = options?.signal;
  if (!signal || !signal.addEventListener) return submitted;
  return new Promise<unknown>((resolve, reject) => {
    const state: SubmissionWaitState = {
      signal,
      onAbort: () => {},
      resolve,
      reject,
      settled: false,
    };
    state.onAbort = () =>
      finishSubmissionWait(state, {
        ok: false,
        reason: signal.reason ?? domError("aborted", "AbortError"),
      });
    signal.addEventListener("abort", state.onAbort);
    Promise.resolve(submitted).then(
      (value) => finishSubmissionWait(state, { ok: true, value }),
      (reason) => finishSubmissionWait(state, { ok: false, reason }),
    );
  });
}

function manualSubmissionCleanup(
  entry: DeclarativeTool,
  form: DeclarativeForm,
  signal: AbortSignal | undefined,
  onSubmit: ((event: unknown) => void) | null,
  onAbort: (() => void) | null,
): void {
  activeToolForms.delete(entry.form);
  removeManualSubmitListener(form, onSubmit);
  removeManualAbortListener(signal, onAbort);
}

function removeManualSubmitListener(
  form: DeclarativeForm,
  listener: ((event: unknown) => void) | null,
): void {
  if (listener && form.removeEventListener) form.removeEventListener("submit", listener);
}

function removeManualAbortListener(
  signal: AbortSignal | undefined,
  listener: (() => void) | null,
): void {
  if (listener && signal?.removeEventListener) signal.removeEventListener("abort", listener);
}

function resolveManualSubmission(event: unknown, resolve: (value: unknown) => void): void {
  const responded = submitEventResponse(event);
  if (responded && typeof responded.then === "function") resolve(responded);
  else resolve("");
}

function waitForManualSubmission(
  entry: DeclarativeTool,
  options: WebMCP.ToolExecuteCallbackOptions,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const form = entry.form;
    activeToolForms.add(form);
    const signal = options?.signal;
    let onAbort: (() => void) | null = null;
    let onSubmit: ((event: unknown) => void) | null = (event: unknown) => {
      manualSubmissionCleanup(entry, form, signal, onSubmit, onAbort);
      resolveManualSubmission(event, resolve);
    };
    const cleanup = () => manualSubmissionCleanup(entry, form, signal, onSubmit, onAbort);
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
}

function fillDeclarativeControls(form: DeclarativeForm, args: Record<string, unknown>): void {
  const elements = form?.elements;
  for (let i = 0; elements && i < elements.length; i++) {
    fillDeclarativeControl(elements[i], args);
  }
}

function fillDeclarativeControl(control: DeclarativeControl, args: Record<string, unknown>): void {
  const field = String(control?.name ?? "");
  if (!canFillDeclarativeControl(control, field, args)) return;
  setControlValue(control, args[field]);
}

function canFillDeclarativeControl(
  control: DeclarativeControl,
  field: string,
  args: Record<string, unknown>,
): boolean {
  if (!field) return false;
  if (!(field in args)) return false;
  return control?.disabled !== true;
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
  const kind = settableControlKind(control);
  if (kind.type === "file") return false;
  const changed = applyControlValueSafely(control, kind.tag, kind.type, value);
  if (!changed) return false;
  dispatchControlChangeEvents(control);
  return true;
}

function settableControlKind(control: SettableControl): { tag: string; type: string } {
  return {
    tag: String(control?.localName ?? "").toLowerCase(),
    type: String(control?.type ?? "").toLowerCase(),
  };
}

function applyControlValueSafely(
  control: SettableControl,
  tag: string,
  type: string,
  value: unknown,
): boolean {
  try {
    return updateControlValue(control, tag, type, value);
  } catch {
    return false;
  }
}

function updateControlValue(
  control: SettableControl,
  tag: string,
  type: string,
  value: unknown,
): boolean {
  if (type === "checkbox") return setCheckboxValue(control, value);
  if (type === "radio") return setRadioValue(control, value);
  if (isMultipleSelectValue(control, tag, value)) return setMultipleSelectValue(control, value);
  return setScalarControlValue(control, value);
}

function setCheckboxValue(control: SettableControl, value: unknown): boolean {
  const want = value === true;
  if (control.checked === want) return false;
  control.checked = want;
  return true;
}

function setRadioValue(control: SettableControl, value: unknown): boolean {
  const want = String(control.value ?? "on") === String(value);
  if (control.checked === want) return false;
  control.checked = want;
  return true;
}

function isMultipleSelectValue(
  control: SettableControl,
  tag: string,
  value: unknown,
): value is unknown[] {
  return tag === "select" && control.multiple === true && Array.isArray(value);
}

function setMultipleSelectValue(control: SettableControl, value: unknown[]): boolean {
  const selected = new Set(value.map(String));
  const options = control.options;
  if (!options) return false;
  let changed = false;
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    const want = selected.has(String(option.value));
    if (option.selected !== want) {
      option.selected = want;
      changed = true;
    }
  }
  return changed;
}

function setScalarControlValue(control: SettableControl, value: unknown): boolean {
  const want = value == null ? "" : String(value);
  if (String(control.value ?? "") === want) return false;
  control.value = want;
  return true;
}

function dispatchControlChangeEvents(control: SettableControl): void {
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
}

function markDeclarativeInterest(): void {
  if (pageDeclarativeInterest) return;
  pageDeclarativeInterest = true;
  refreshDeclarativeTools(false);
}

function validateToolName(name: string): void {
  if (name.length > MAX_MODEL_CONTEXT_TOOL_NAME_LENGTH || !NAME_OK.test(name)) {
    throw domError(`registerTool: invalid tool name "${name}"`, "InvalidStateError");
  }
}

function validateToolRequiredFields(name: string, description: string): void {
  if (name === "" || description === "") {
    throw domError(
      "registerTool: name and description are required and must be non-empty",
      "InvalidStateError",
    );
  }
}

function validateToolAvailable(name: string, registry: Map<string, ToolDefinition>): void {
  if (registry.has(name)) {
    throw domError(
      `registerTool: a tool named "${name}" is already registered`,
      "InvalidStateError",
    );
  }
}

function validateToolExecutor(
  name: string,
  execute: unknown,
): asserts execute is WebMCP.ToolExecuteCallback {
  if (typeof execute !== "function") {
    throw new TypeError(`registerTool: tool "${name}" has no execute()`);
  }
}

function isSchemaObject(value: unknown): boolean {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function serializedInputSchema(name: string, schema: unknown): string {
  if (schema === undefined) return "";
  if (!isSchemaObject(schema)) {
    throw new TypeError(`registerTool: tool "${name}" inputSchema must be an object`);
  }
  const json = JSON.stringify(schema);
  if (json === undefined) {
    throw new TypeError(`registerTool: tool "${name}" has an unserializable inputSchema`);
  }
  return json;
}

function parseToolAnnotations(raw: unknown): ToolAnnotations | null {
  return isObjectLike(raw)
    ? {
        readOnlyHint: raw.readOnlyHint === true,
        untrustedContentHint: raw.untrustedContentHint === true,
        consequentialHint: raw.consequentialHint === true,
      }
    : null;
}

function validate(tool: unknown, registry: Map<string, ToolDefinition>): ToolDefinition {
  if (!isObjectLike(tool)) {
    throw new TypeError("registerTool: tool must be an object");
  }
  const t = tool;
  const name = typeof t.name === "string" ? t.name : "";
  const description = typeof t.description === "string" ? t.description : "";
  validateToolRequiredFields(name, description);
  validateToolName(name);
  validateToolAvailable(name, registry);
  validateToolExecutor(name, t.execute);
  const inputSchema = serializedInputSchema(name, t.inputSchema);
  const annotations = parseToolAnnotations(t.annotations);

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
  if (!isDocumentContextReceiver(doc)) {
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

function isDocumentContextReceiver(doc: unknown): doc is Record<string, unknown> {
  return isObjectLike(doc) && doc.nodeType === DOCUMENT_NODE;
}

function childFrameElement(doc: unknown): Record<string, unknown> | null {
  if (!isObjectLike(doc)) return null;
  const view = doc.defaultView;
  if (!isObjectLike(view)) return null;
  const element = view.frameElement;
  return isObjectLike(element) ? element : null;
}

function isChildDocumentFullyActive(doc: object): boolean {
  try {
    const element = childFrameElement(doc);
    return element !== null && element.isConnected === true && element.contentDocument === doc;
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
  return normalizeStructuredResult(out);
}

function normalizeStructuredResult(out: unknown): ToolCallResult {
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

interface CallToolExecutor {
  execute: WebMCP.ToolExecuteCallback;
  declarative: boolean;
}

function resolveCallToolExecutor(name: string): CallToolExecutor | null {
  const definition = tools.get(name);
  if (definition) return { execute: definition.execute, declarative: false };
  refreshDeclarativeTools(false);
  const entry = declarativeTools.get(name);
  if (!entry) return null;
  return { execute: makeDeclarativeExec(entry), declarative: true };
}

function createInvocationController(id: string): AbortControllerLike | null {
  return id === "" ? null : createExecutionController();
}

function addInvocationController(id: string, controller: AbortControllerLike | null): void {
  if (controller) activeToolExecutions.set(id, controller);
}

function removeInvocationController(id: string, controller: AbortControllerLike | null): void {
  if (controller && activeToolExecutions.get(id) === controller) activeToolExecutions.delete(id);
}

function modelContextToolResult(executor: CallToolExecutor, output: unknown): ToolCallResult {
  return executor.declarative ? declarativeResult(output) : normalizeResult(output);
}

function modelContextToolFailure(error: unknown): ToolCallResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: message,
    threw: true,
  };
}

async function runModelContextToolCall(
  executor: CallToolExecutor,
  input: unknown,
  id: string,
): Promise<ToolCallResult> {
  const controller = createInvocationController(id);
  addInvocationController(id, controller);
  try {
    const args = isObjectLike(input) ? input : {};
    const output = await executor.execute(args, executionOptions(controller?.signal));
    return modelContextToolResult(executor, output);
  } catch (error) {
    return modelContextToolFailure(error);
  } finally {
    removeInvocationController(id, controller);
  }
}

/** Returns missing-tool and callback failures in ToolCallResult instead of throwing. */
export async function callModelContextTool(
  name: unknown,
  input: unknown,
  invocationId?: unknown,
): Promise<ToolCallResult> {
  const key = typeof name === "string" ? name : String(name ?? "");
  const executor = resolveCallToolExecutor(key);
  if (!executor) {
    return {
      content: [],
      isError: true,
      error: `no such tool: ${key}`,
      notFound: true,
    };
  }
  const id = typeof invocationId === "string" ? invocationId : "";
  return runModelContextToolCall(executor, input, id);
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
