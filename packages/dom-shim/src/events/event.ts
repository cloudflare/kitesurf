// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines Event classes and stores the private state used during dispatch.

import type * as Idl from "../idl/types.generated.js";
import { __ks_trustedFlags, __ks_isTrustedGetter } from "../trust.js";
import { finalizeInterface, idlInterfaceMeta, type IdlInterfaceName } from "../webidl.js";
import { dom, shadowRootModes } from "../state.js";
import { MAX_SHADOW_ROOT_HOPS } from "../constants.js";

function rootChainOf(nodeId: number): Set<number> {
  const chain = new Set<number>();
  if (isInvalidShadowNodeId(nodeId)) return chain;
  let cur = nodeId;
  for (let safety = 0; safety < MAX_SHADOW_ROOT_HOPS; safety++) {
    const rootId = shadowRootFor(cur);
    if (rootId < 0) break;
    chain.add(rootId);
    const host = shadowHostFor(rootId);
    if (host < 0) break;
    cur = host;
  }
  return chain;
}

function isInvalidShadowNodeId(nodeId: number): boolean {
  return nodeId == null || nodeId < 0;
}

function shadowRootFor(nodeId: number): number {
  try {
    return dom.shadowHostId(nodeId) >= 0 ? nodeId : dom.containingShadowRootId(nodeId);
  } catch {
    return -1;
  }
}

function shadowHostFor(nodeId: number): number {
  try {
    return dom.shadowHostId(nodeId);
  } catch {
    return -1;
  }
}

export interface EventState {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  composed: boolean;
  readonly timeStamp: number;
  target: Idl.EventTarget | null;
  currentTarget: Idl.EventTarget | null;
  relatedTarget: Idl.EventTarget | null;
  eventPhase: number;
  stopPropagation: boolean;
  stopImmediatePropagation: boolean;
  canceled: boolean;
  inPassiveListener: boolean;
  initialized: boolean;
  dispatched: boolean;
  path: Idl.EventTarget[] | null;
}

let stateOf!: (event: object) => EventState | undefined;

function maybeEventState(event: unknown): EventState | undefined {
  return typeof event === "object" && event !== null ? stateOf(event) : undefined;
}

export function eventState(event: unknown): EventState {
  const state = maybeEventState(event);
  if (!state) throw new TypeError("Illegal invocation");
  return state;
}

export function isEventDefaultPrevented(event: object): boolean {
  return maybeEventState(event)?.canceled === true;
}

export function isEventInPassiveListener(event: object): boolean {
  return maybeEventState(event)?.inPassiveListener === true;
}

export function setEventInPassiveListener(event: object, passive: boolean): void {
  const state = maybeEventState(event);
  if (state) state.inPassiveListener = passive;
}

export function setEventTarget(event: object, value: Idl.EventTarget | null | undefined): void {
  if (event) eventState(event).target = value ?? null;
}
export function setEventCurrentTarget(
  event: object,
  value: Idl.EventTarget | null | undefined,
): void {
  if (event) eventState(event).currentTarget = value ?? null;
}

function nodeIdOf(target: unknown): number {
  const id =
    typeof target === "object" && target !== null ? (target as { _id?: unknown })._id : undefined;
  return typeof id === "number" ? id : -1;
}

function domString(value: unknown, fallback: string): string {
  return value === undefined ? fallback : String(value);
}
function nullableDomString(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}
function unsignedLong(value: unknown): number {
  return value === undefined ? 0 : Number(value) >>> 0;
}

export class KsEvent implements Idl.Event {
  declare readonly isTrusted: boolean;
  #state: EventState;
  static {
    stateOf = (event) => (#state in event ? event.#state : undefined);
  }
  constructor(type: string, init?: Idl.EventInit | null) {
    if (arguments.length < 1) {
      throw new TypeError("Failed to construct 'Event': 1 argument required, but only 0 present.");
    }
    const i: Idl.EventInit = init || {};
    this.#state = {
      type: String(type),
      bubbles: !!i.bubbles,
      cancelable: !!i.cancelable,
      composed: !!i.composed,
      timeStamp: Date.now(),
      target: null,
      currentTarget: null,
      relatedTarget: null,
      eventPhase: 0,
      stopPropagation: false,
      stopImmediatePropagation: false,
      canceled: false,
      inPassiveListener: false,
      initialized: true,
      dispatched: false,
      path: null,
    };
    __ks_trustedFlags.set(this, false);
    Object.defineProperty(this, "isTrusted", {
      get: __ks_isTrustedGetter,
      set: undefined,
      enumerable: true,
      configurable: false,
    });
  }
  get type() {
    return this.#state.type;
  }
  get target() {
    return this.#state.target ?? null;
  }
  get srcElement() {
    return this.#state.target ?? null;
  }
  get currentTarget() {
    return this.#state.currentTarget ?? null;
  }
  get eventPhase() {
    return this.#state.eventPhase;
  }
  get bubbles() {
    return this.#state.bubbles;
  }
  get cancelable() {
    return this.#state.cancelable;
  }
  get composed() {
    return this.#state.composed;
  }
  get timeStamp() {
    return this.#state.timeStamp;
  }
  get defaultPrevented() {
    return this.#state.canceled;
  }
  get returnValue() {
    return !this.#state.canceled;
  }
  set returnValue(v: boolean) {
    if (v === false) this.preventDefault();
  }
  get cancelBubble() {
    return this.#state.stopPropagation;
  }
  set cancelBubble(v: boolean) {
    if (v) this.#state.stopPropagation = true;
  }
  initEvent(type: string, bubbles?: boolean, cancelable?: boolean) {
    if (arguments.length < 1) {
      throw new TypeError("Event.initEvent: type argument is required");
    }
    const s = this.#state;
    if (s.dispatched) return;
    s.type = String(type);
    s.bubbles = !!bubbles;
    s.cancelable = !!cancelable;
    s.canceled = false;
    s.stopPropagation = false;
    s.stopImmediatePropagation = false;
    s.target = null;
    s.initialized = true;
  }
  composedPath() {
    const full = this.#state.path ? this.#state.path.slice() : [];
    if (full.length === 0) return full;
    const visible = rootChainOf(nodeIdOf(this.currentTarget));
    return full.filter((t) => {
      const id = nodeIdOf(t);
      if (id < 0) return true;
      for (const rootId of rootChainOf(id)) {
        if (shadowRootModes.get(rootId) === "closed" && !visible.has(rootId)) {
          return false;
        }
      }
      return true;
    });
  }
  preventDefault() {
    const s = this.#state;
    if (s.inPassiveListener) return;
    if (s.cancelable) s.canceled = true;
  }
  stopPropagation() {
    this.#state.stopPropagation = true;
  }
  stopImmediatePropagation() {
    this.#state.stopPropagation = true;
    this.#state.stopImmediatePropagation = true;
  }
}

let submitResponseOf!: (event: object) => Promise<unknown> | undefined;
export class KsSubmitEvent extends KsEvent implements Idl.SubmitEvent {
  readonly #submitter: Idl.HTMLElement | null;
  readonly #agentInvoked: boolean;
  #response: Promise<unknown> | undefined;
  static {
    submitResponseOf = (event) => (#response in event ? event.#response : undefined);
  }
  constructor(type: string, init?: (Idl.SubmitEventInit & { agentInvoked?: boolean }) | null) {
    super(type, init);
    const i = init || {};
    this.#submitter = i.submitter === undefined ? null : i.submitter;
    this.#agentInvoked = i.agentInvoked === true;
  }
  get submitter() {
    return this.#submitter;
  }
  get agentInvoked(): boolean {
    return this.#agentInvoked;
  }
  respondWith(value: unknown): void {
    this.#response = Promise.resolve(value);
  }
}

export function submitEventResponse(event: unknown): Promise<unknown> | undefined {
  return typeof event === "object" && event !== null ? submitResponseOf(event) : undefined;
}

export class KsHashChangeEvent extends KsEvent implements Idl.HashChangeEvent {
  readonly #oldURL: string;
  readonly #newURL: string;
  constructor(type: string, init?: Idl.HashChangeEventInit | null) {
    super(type, init);
    const i = init || {};
    this.#oldURL = typeof i.oldURL === "string" ? i.oldURL : "";
    this.#newURL = typeof i.newURL === "string" ? i.newURL : "";
  }
  get oldURL() {
    return this.#oldURL;
  }
  get newURL() {
    return this.#newURL;
  }
}

export class KsPopStateEvent extends KsEvent implements Idl.PopStateEvent {
  readonly #historyState: unknown;
  readonly #hasUAVisualTransition: boolean;
  constructor(type: string, init?: Idl.PopStateEventInit | null) {
    super(type, init);
    const i = init || {};
    this.#historyState = i.state === undefined ? null : i.state;
    this.#hasUAVisualTransition =
      typeof i.hasUAVisualTransition === "boolean" ? i.hasUAVisualTransition : false;
  }
  get state() {
    return this.#historyState;
  }
  get hasUAVisualTransition() {
    return this.#hasUAVisualTransition;
  }
}

export class KsTransitionEvent extends KsEvent implements Idl.TransitionEvent {
  readonly #propertyName: string;
  readonly #elapsedTime: number;
  readonly #pseudoElement: string;
  constructor(type: string, init?: Idl.TransitionEventInit | null) {
    super(type, init);
    const i = init || {};
    this.#propertyName = i.propertyName != null ? String(i.propertyName) : "";
    this.#elapsedTime = typeof i.elapsedTime === "number" ? i.elapsedTime : 0;
    this.#pseudoElement = i.pseudoElement != null ? String(i.pseudoElement) : "";
  }
  get propertyName() {
    return this.#propertyName;
  }
  get elapsedTime() {
    return this.#elapsedTime;
  }
  get pseudoElement() {
    return this.#pseudoElement;
  }
}

export class KsAnimationEvent extends KsEvent implements Idl.AnimationEvent {
  readonly #animationName: string;
  readonly #elapsedTime: number;
  readonly #pseudoElement: string;
  constructor(type: string, init?: Idl.AnimationEventInit | null) {
    super(type, init);
    const i = init || {};
    this.#animationName = i.animationName != null ? String(i.animationName) : "";
    this.#elapsedTime = typeof i.elapsedTime === "number" ? i.elapsedTime : 0;
    this.#pseudoElement = i.pseudoElement != null ? String(i.pseudoElement) : "";
  }
  get animationName() {
    return this.#animationName;
  }
  get elapsedTime() {
    return this.#elapsedTime;
  }
  get pseudoElement() {
    return this.#pseudoElement;
  }
}

export class KsPageTransitionEvent extends KsEvent implements Idl.PageTransitionEvent {
  readonly #persisted: boolean;
  constructor(type: string, init?: Idl.PageTransitionEventInit | null) {
    super(type, init);
    const i = init || {};
    this.#persisted = !!i.persisted;
  }
  get persisted() {
    return this.#persisted;
  }
}

export class KsBeforeUnloadEvent extends KsEvent implements Idl.BeforeUnloadEvent {
  #returnValue = "";
  constructor(type: string, init?: (Idl.EventInit & { returnValue?: string }) | null) {
    super(type, init);
    const i = init || {};
    if (typeof i.returnValue === "string") this.#returnValue = i.returnValue;
  }
  // @ts-expect-error 2416
  get returnValue(): string {
    return this.#returnValue;
  }
  // @ts-expect-error 2416
  set returnValue(v: string) {
    this.#returnValue = String(v ?? "");
  }
}

const INTERNAL_CONSTRUCT = Symbol("kitesurfInternalConstruct");

function nullableDouble(value: unknown, member: string): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${member} is not a finite number.`);
  return n;
}

export class KsDeviceMotionEventAcceleration implements Idl.DeviceMotionEventAcceleration {
  readonly #x: number | null;
  readonly #y: number | null;
  readonly #z: number | null;
  constructor(token: symbol, init: Idl.DeviceMotionEventAccelerationInit) {
    if (token !== INTERNAL_CONSTRUCT) throw new TypeError("Illegal constructor");
    this.#x = nullableDouble(init.x, "x");
    this.#y = nullableDouble(init.y, "y");
    this.#z = nullableDouble(init.z, "z");
  }
  get x() {
    return this.#x;
  }
  get y() {
    return this.#y;
  }
  get z() {
    return this.#z;
  }
}

export class KsDeviceMotionEventRotationRate implements Idl.DeviceMotionEventRotationRate {
  readonly #alpha: number | null;
  readonly #beta: number | null;
  readonly #gamma: number | null;
  constructor(token: symbol, init: Idl.DeviceMotionEventRotationRateInit) {
    if (token !== INTERNAL_CONSTRUCT) throw new TypeError("Illegal constructor");
    this.#alpha = nullableDouble(init.alpha, "alpha");
    this.#beta = nullableDouble(init.beta, "beta");
    this.#gamma = nullableDouble(init.gamma, "gamma");
  }
  get alpha() {
    return this.#alpha;
  }
  get beta() {
    return this.#beta;
  }
  get gamma() {
    return this.#gamma;
  }
}

export class KsDeviceMotionEvent extends KsEvent implements Idl.DeviceMotionEvent {
  readonly #acceleration: KsDeviceMotionEventAcceleration | null = null;
  readonly #accelerationIncludingGravity: KsDeviceMotionEventAcceleration | null = null;
  readonly #rotationRate: KsDeviceMotionEventRotationRate | null = null;
  readonly #interval: number = 0;
  constructor(type: string, init?: Idl.DeviceMotionEventInit | null) {
    super(type, init);
    const values = deviceMotionEventValues(init);
    this.#acceleration = values.acceleration;
    this.#accelerationIncludingGravity = values.accelerationIncludingGravity;
    this.#rotationRate = values.rotationRate;
    this.#interval = values.interval;
  }
  get acceleration() {
    return this.#acceleration;
  }
  get accelerationIncludingGravity() {
    return this.#accelerationIncludingGravity;
  }
  get rotationRate() {
    return this.#rotationRate;
  }
  get interval() {
    return this.#interval;
  }
}

function deviceMotionEventValues(init?: Idl.DeviceMotionEventInit | null) {
  const i = init || {};
  return {
    acceleration:
      i.acceleration == null
        ? null
        : new KsDeviceMotionEventAcceleration(INTERNAL_CONSTRUCT, i.acceleration),
    accelerationIncludingGravity:
      i.accelerationIncludingGravity == null
        ? null
        : new KsDeviceMotionEventAcceleration(INTERNAL_CONSTRUCT, i.accelerationIncludingGravity),
    rotationRate:
      i.rotationRate == null
        ? null
        : new KsDeviceMotionEventRotationRate(INTERNAL_CONSTRUCT, i.rotationRate),
    interval: eventNumberFromInit(i, "interval", 0),
  };
}

export class KsDeviceOrientationEvent extends KsEvent implements Idl.DeviceOrientationEvent {
  readonly #alpha: number | null = null;
  readonly #beta: number | null = null;
  readonly #gamma: number | null = null;
  readonly #absolute: boolean;
  constructor(type: string, init?: Idl.DeviceOrientationEventInit | null) {
    super(type, init);
    const i = init || {};
    if (i.alpha != null) this.#alpha = i.alpha;
    if (i.beta != null) this.#beta = i.beta;
    if (i.gamma != null) this.#gamma = i.gamma;
    this.#absolute = !!i.absolute;
  }
  get alpha() {
    return this.#alpha;
  }
  get beta() {
    return this.#beta;
  }
  get gamma() {
    return this.#gamma;
  }
  get absolute() {
    return this.#absolute;
  }
}

let initPostMessage!: (event: KsMessageEvent, data: unknown) => void;
export class KsMessageEvent extends KsEvent implements Idl.MessageEvent {
  #data: unknown;
  #origin: string;
  #lastEventId: string;
  #source: Idl.MessageEventSource | null;
  #ports: readonly Idl.MessagePort[];
  static {
    initPostMessage = (event, data) => {
      event.#data = data;
      event.#ports = Object.freeze([...event.#ports]);
    };
  }
  constructor(type: string, init?: Idl.MessageEventInit | null) {
    super(type, init);
    const values = messageEventValues(init || {});
    this.#data = values.data;
    this.#origin = values.origin;
    this.#lastEventId = values.lastEventId;
    this.#source = values.source;
    this.#ports = values.ports;
  }
  get data() {
    return this.#data;
  }
  get origin() {
    return this.#origin;
  }
  get lastEventId() {
    return this.#lastEventId;
  }
  get source() {
    return this.#source;
  }
  get ports() {
    return this.#ports;
  }
  // eslint-disable-next-line max-params -- WebIDL requires this legacy positional signature.
  initMessageEvent(
    type: string,
    bubbles?: boolean,
    cancelable?: boolean,
    data?: unknown,
    origin?: string,
    lastEventId?: string,
    source?: Idl.MessageEventSource | null,
    ports?: Idl.MessagePort[],
  ) {
    if (eventState(this).dispatched) return;
    this.initEvent(type, bubbles, cancelable);
    this.#data = data === undefined ? null : data;
    this.#origin = domString(origin, "");
    this.#lastEventId = domString(lastEventId, "");
    this.#source = source ?? null;
    this.#ports = Array.isArray(ports) ? ports.slice() : [];
  }
}

function messageEventValues(i: Idl.MessageEventInit) {
  return {
    data: i.data === undefined ? null : i.data,
    origin: i.origin ? String(i.origin) : "",
    lastEventId: i.lastEventId ? String(i.lastEventId) : "",
    source: i.source === undefined ? null : i.source,
    ports: messageEventPorts(i),
  };
}

function messageEventPorts(i: Idl.MessageEventInit): Idl.MessagePort[] {
  return Array.isArray(i.ports) ? i.ports.slice() : [];
}

export function postMessageEvent(
  data: unknown,
  origin: string,
  source: Idl.MessageEventSource | null,
  ports: Idl.MessagePort[],
): KsMessageEvent {
  const event = new KsMessageEvent("message", { data, origin, source, ports });
  initPostMessage(event, data);
  return event;
}

export class KsStorageEvent extends KsEvent implements Idl.StorageEvent {
  #key: string | null;
  #oldValue: string | null;
  #newValue: string | null;
  #url: string;
  #storageArea: Idl.Storage | null;
  constructor(type: string, init?: Idl.StorageEventInit | null) {
    super(type, init);
    const values = storageEventValues(init || {});
    this.#key = values.key;
    this.#oldValue = values.oldValue;
    this.#newValue = values.newValue;
    this.#url = values.url;
    this.#storageArea = values.storageArea;
  }
  get key() {
    return this.#key;
  }
  get oldValue() {
    return this.#oldValue;
  }
  get newValue() {
    return this.#newValue;
  }
  get url() {
    return this.#url;
  }
  get storageArea() {
    return this.#storageArea;
  }
  // eslint-disable-next-line max-params -- WebIDL requires this legacy positional signature.
  initStorageEvent(
    type: string,
    bubbles?: boolean,
    cancelable?: boolean,
    key?: string | null,
    oldValue?: string | null,
    newValue?: string | null,
    url?: string,
    storageArea?: Idl.Storage | null,
  ) {
    if (eventState(this).dispatched) return;
    this.initEvent(type, bubbles, cancelable);
    this.#key = nullableDomString(key);
    this.#oldValue = nullableDomString(oldValue);
    this.#newValue = nullableDomString(newValue);
    this.#url = domString(url, "");
    this.#storageArea = storageArea ?? null;
  }
}

function storageEventValues(i: Idl.StorageEventInit) {
  return {
    key: i.key === undefined ? null : i.key,
    oldValue: i.oldValue === undefined ? null : i.oldValue,
    newValue: i.newValue === undefined ? null : i.newValue,
    url: i.url ? String(i.url) : "",
    storageArea: storageAreaFromInit(i),
  };
}

function storageAreaFromInit(i: Idl.StorageEventInit): Idl.Storage | null {
  return i.storageArea === undefined ? null : i.storageArea;
}

export class KsErrorEvent extends KsEvent implements Idl.ErrorEvent {
  readonly #message: string;
  readonly #filename: string;
  readonly #lineno: number;
  readonly #colno: number;
  readonly #error: unknown;
  constructor(type: string, init?: Idl.ErrorEventInit | null) {
    super(type, init);
    const values = errorEventValues(init || {});
    this.#message = values.message;
    this.#filename = values.filename;
    this.#lineno = values.lineno;
    this.#colno = values.colno;
    this.#error = values.error;
  }
  get message() {
    return this.#message;
  }
  get filename() {
    return this.#filename;
  }
  get lineno() {
    return this.#lineno;
  }
  get colno() {
    return this.#colno;
  }
  get error() {
    return this.#error;
  }
}

function errorEventValues(i: Idl.ErrorEventInit) {
  return {
    message: typeof i.message === "string" ? i.message : "",
    filename: typeof i.filename === "string" ? i.filename : "",
    lineno: (i.lineno as number) | 0 || 0,
    colno: (i.colno as number) | 0 || 0,
    error: errorFromInit(i),
  };
}

function errorFromInit(i: Idl.ErrorEventInit): unknown {
  return i.error === undefined ? null : i.error;
}

export class KsPromiseRejectionEvent extends KsEvent implements Idl.PromiseRejectionEvent {
  readonly #promise: object;
  readonly #reason: unknown;
  constructor(type: string, init: Idl.PromiseRejectionEventInit) {
    const promise: unknown = init == null ? undefined : (init as { promise?: unknown }).promise;
    if (promise === null || (typeof promise !== "object" && typeof promise !== "function")) {
      throw new TypeError(
        "Failed to construct 'PromiseRejectionEvent': the init dictionary needs a promise object.",
      );
    }
    super(type, init);
    this.#promise = promise;
    this.#reason = init.reason;
  }
  get promise() {
    return this.#promise;
  }
  get reason() {
    return this.#reason;
  }
}

export class KsCustomEvent extends KsEvent implements Idl.CustomEvent {
  #detail: unknown;
  constructor(type: string, init?: Idl.CustomEventInit | null) {
    super(type, init);
    const i = init || {};
    this.#detail = i.detail === undefined ? null : i.detail;
  }
  get detail() {
    return this.#detail;
  }
  initCustomEvent(type: string, bubbles?: boolean, cancelable?: boolean, detail?: unknown) {
    if (arguments.length < 1) {
      throw new TypeError("CustomEvent.initCustomEvent: type argument is required");
    }
    if (eventState(this).dispatched) return;
    this.initEvent(type, bubbles, cancelable);
    this.#detail = detail === undefined ? null : detail;
  }
}

let setUIEventWhich!: (event: KsUIEvent, which: number) => void;
export class KsUIEvent extends KsEvent implements Idl.UIEvent {
  readonly #sourceCapabilities: unknown;
  #view: Idl.Window | null;
  #detail: number;
  #which: number;
  static {
    setUIEventWhich = (event, which) => {
      event.#which = which;
    };
  }
  constructor(type: string, init?: (Idl.UIEventInit & { sourceCapabilities?: unknown }) | null) {
    super(type, init);
    const i = init || {};
    validateUIEventView(i);
    this.#view = i.view ?? null;
    this.#detail = eventNumberFromInit(i, "detail", 0);
    this.#sourceCapabilities = i.sourceCapabilities ?? null;
    this.#which = eventNumberFromInit(i, "which", 0);
  }
  get sourceCapabilities(): unknown {
    return this.#sourceCapabilities;
  }
  get view() {
    return this.#view;
  }
  get detail() {
    return this.#detail;
  }
  get which() {
    return this.#which;
  }
  initUIEvent(
    type: string,
    bubbles?: boolean,
    cancelable?: boolean,
    view?: Idl.Window | null,
    detail?: number,
  ) {
    if (eventState(this).dispatched) return;
    this.initEvent(type, bubbles, cancelable);
    this.#view = view ?? null;
    this.#detail = typeof detail === "number" ? detail : 0;
  }
}

function validateUIEventView(i: Idl.UIEventInit & { sourceCapabilities?: unknown }): void {
  if (i.view != null && typeof i.view !== "object") {
    throw new TypeError("UIEvent: view must be a Window or null");
  }
}

interface Modifiers {
  Alt: boolean;
  Control: boolean;
  Shift: boolean;
  Meta: boolean;
  AltGraph: boolean;
  CapsLock: boolean;
}

function readModifierInit(init: Idl.EventModifierInit): Modifiers {
  return {
    Alt: !!init.altKey,
    Control: !!init.ctrlKey,
    Shift: !!init.shiftKey,
    Meta: !!init.metaKey,
    AltGraph: !!init.modifierAltGraph,
    CapsLock: !!init.modifierCapsLock,
  };
}

function modifierState(modifiers: Modifiers, name: unknown): boolean {
  switch (name) {
    case "Alt":
      return modifiers.Alt;
    case "Control":
      return modifiers.Control;
    case "Shift":
      return modifiers.Shift;
    case "Meta":
      return modifiers.Meta;
    case "AltGraph":
      return modifiers.AltGraph;
    case "CapsLock":
      return modifiers.CapsLock;
    default:
      return false;
  }
}

// pageX, pageY, movementX and movementY are not MouseEventInit members
// in the pinned IDL, but PageScript's synthesized events pass them.
// movementX/movementY are Pointer Lock members.
type MouseEventShimInit = Idl.MouseEventInit & {
  pageX?: number;
  pageY?: number;
  movementX?: number;
  movementY?: number;
  pseudoTarget?: unknown;
};

function eventStringFromInit<T extends object, K extends keyof T>(init: T, key: K): string {
  return typeof init[key] === "string" ? init[key] : "";
}

function eventNumberFromInit<T extends object, K extends keyof T>(
  init: T,
  key: K,
  fallback: number,
): number {
  return typeof init[key] === "number" ? init[key] : fallback;
}

export class KsMouseEvent extends KsUIEvent implements Idl.MouseEvent {
  // pseudoTarget is not in the pinned IDL. PageScript sets it after
  // hit-testing the constructed event, so it keeps a setter.
  #pseudoTarget: unknown;
  readonly #modifiers: Modifiers;
  #button: number;
  readonly #buttons: number;
  #screenX: number;
  #screenY: number;
  #clientX: number;
  #clientY: number;
  readonly #pageX: number;
  readonly #pageY: number;
  readonly #movementX: number;
  readonly #movementY: number;
  constructor(type: string, init?: MouseEventShimInit | null) {
    super(type, init);
    const i: MouseEventShimInit = init || {};
    this.#button = eventNumberFromInit(i, "button", 0);
    this.#buttons = eventNumberFromInit(i, "buttons", 0);
    this.#screenX = eventNumberFromInit(i, "screenX", 0);
    this.#screenY = eventNumberFromInit(i, "screenY", 0);
    this.#clientX = eventNumberFromInit(i, "clientX", 0);
    this.#clientY = eventNumberFromInit(i, "clientY", 0);
    this.#pageX = eventNumberFromInit(i, "pageX", this.#clientX);
    this.#pageY = eventNumberFromInit(i, "pageY", this.#clientY);
    this.#movementX = eventNumberFromInit(i, "movementX", 0);
    this.#movementY = eventNumberFromInit(i, "movementY", 0);
    this.#modifiers = readModifierInit(i);
    eventState(this).relatedTarget = i.relatedTarget == null ? null : i.relatedTarget;
    this.#pseudoTarget = i.pseudoTarget == null ? null : i.pseudoTarget;
  }
  get pseudoTarget(): unknown {
    return this.#pseudoTarget;
  }
  set pseudoTarget(value: unknown) {
    this.#pseudoTarget = value;
  }
  get screenX() {
    return this.#screenX;
  }
  get screenY() {
    return this.#screenY;
  }
  get clientX() {
    return this.#clientX;
  }
  get clientY() {
    return this.#clientY;
  }
  get x() {
    return this.#clientX;
  }
  get y() {
    return this.#clientY;
  }
  get pageX() {
    return this.#pageX;
  }
  get pageY() {
    return this.#pageY;
  }
  get movementX(): number {
    return this.#movementX;
  }
  get movementY(): number {
    return this.#movementY;
  }
  get button() {
    return this.#button;
  }
  get buttons() {
    return this.#buttons;
  }
  get altKey() {
    return this.#modifiers.Alt;
  }
  get ctrlKey() {
    return this.#modifiers.Control;
  }
  get shiftKey() {
    return this.#modifiers.Shift;
  }
  get metaKey() {
    return this.#modifiers.Meta;
  }
  get relatedTarget() {
    return eventState(this).relatedTarget;
  }
  getModifierState(name: string) {
    return modifierState(this.#modifiers, name);
  }
  // eslint-disable-next-line max-params -- WebIDL requires this legacy positional signature.
  initMouseEvent(
    type: string,
    bubbles?: boolean,
    cancelable?: boolean,
    view?: Idl.Window | null,
    detail?: number,
    screenX?: number,
    screenY?: number,
    clientX?: number,
    clientY?: number,
    ctrlKey?: boolean,
    altKey?: boolean,
    shiftKey?: boolean,
    metaKey?: boolean,
    button?: number,
    relatedTarget?: Idl.EventTarget | null,
  ) {
    const state = eventState(this);
    if (state.dispatched) return;
    this.initUIEvent(type, bubbles, cancelable, view, detail);
    this.#setCoordinates(screenX, screenY, clientX, clientY);
    this.#modifiers.Control = !!ctrlKey;
    this.#modifiers.Alt = !!altKey;
    this.#modifiers.Shift = !!shiftKey;
    this.#modifiers.Meta = !!metaKey;
    this.#button = typeof button === "number" ? button : 0;
    state.relatedTarget = relatedTarget ?? null;
  }
  #setCoordinates(screenX?: number, screenY?: number, clientX?: number, clientY?: number): void {
    this.#screenX = typeof screenX === "number" ? screenX : 0;
    this.#screenY = typeof screenY === "number" ? screenY : 0;
    this.#clientX = typeof clientX === "number" ? clientX : 0;
    this.#clientY = typeof clientY === "number" ? clientY : 0;
  }
}

export class KsFocusEvent extends KsUIEvent implements Idl.FocusEvent {
  constructor(type: string, init?: Idl.FocusEventInit | null) {
    super(type, init);
    const i = init || {};
    eventState(this).relatedTarget = i.relatedTarget == null ? null : i.relatedTarget;
  }
  get relatedTarget() {
    return eventState(this).relatedTarget;
  }
}

const isProtoOf = Object.prototype.isPrototypeOf;
export function exposesRelatedTarget(event: object): boolean {
  return (
    isProtoOf.call(KsMouseEvent.prototype, event) || isProtoOf.call(KsFocusEvent.prototype, event)
  );
}

export class KsDragEvent extends KsMouseEvent implements Idl.DragEvent {
  readonly #dataTransfer: Idl.DataTransfer | null = null;
  constructor(type: string, init?: (Idl.DragEventInit & MouseEventShimInit) | null) {
    super(type, init);
    const i = init || {};
    if (i.dataTransfer != null) this.#dataTransfer = i.dataTransfer;
  }
  get dataTransfer() {
    return this.#dataTransfer;
  }
}

export class KsTextEvent extends KsUIEvent implements Idl.TextEvent {
  #data: string;
  constructor(type: string, init?: (Idl.UIEventInit & { data?: string }) | null) {
    super(type, init);
    const i = init || {};
    this.#data = i.data ? String(i.data) : "";
  }
  get data() {
    return this.#data;
  }
  initTextEvent(
    type: string,
    bubbles?: boolean,
    cancelable?: boolean,
    view?: Idl.Window | null,
    data?: string,
  ) {
    if (eventState(this).dispatched) return;
    this.initUIEvent(type, bubbles, cancelable, view, 0);
    this.#data = domString(data, "undefined");
  }
}

export class KsTouchEvent
  extends KsUIEvent
  implements Omit<Idl.TouchEvent, "touches" | "targetTouches" | "changedTouches">
{
  readonly #touches: Idl.Touch[];
  readonly #targetTouches: Idl.Touch[];
  readonly #changedTouches: Idl.Touch[];
  readonly #modifiers: Modifiers;
  constructor(type: string, init?: Idl.TouchEventInit | null) {
    super(type, init);
    const i = init || {};
    this.#touches = Array.isArray(i.touches) ? i.touches.slice() : [];
    this.#targetTouches = Array.isArray(i.targetTouches) ? i.targetTouches.slice() : [];
    this.#changedTouches = Array.isArray(i.changedTouches) ? i.changedTouches.slice() : [];
    this.#modifiers = readModifierInit(i);
  }
  get touches(): Idl.Touch[] {
    return this.#touches;
  }
  get targetTouches(): Idl.Touch[] {
    return this.#targetTouches;
  }
  get changedTouches(): Idl.Touch[] {
    return this.#changedTouches;
  }
  get altKey() {
    return this.#modifiers.Alt;
  }
  get ctrlKey() {
    return this.#modifiers.Control;
  }
  get shiftKey() {
    return this.#modifiers.Shift;
  }
  get metaKey() {
    return this.#modifiers.Meta;
  }
  getModifierState(name: string) {
    return modifierState(this.#modifiers, name);
  }
}

// Click-family events are PointerEvents by spec; PageScript emits the mouse compatibility stream.
export class KsPointerEvent extends KsMouseEvent implements Idl.PointerEvent {
  readonly #pointerId: number;
  readonly #width: number;
  readonly #height: number;
  readonly #pressure: number;
  readonly #tangentialPressure: number;
  readonly #tiltX: number;
  readonly #tiltY: number;
  readonly #twist: number;
  readonly #altitudeAngle: number;
  readonly #azimuthAngle: number;
  readonly #pointerType: string;
  readonly #isPrimary: boolean;
  readonly #persistentDeviceId: number;
  readonly #coalesced: Idl.PointerEvent[];
  readonly #predicted: Idl.PointerEvent[];
  constructor(type: string, init?: (Idl.PointerEventInit & MouseEventShimInit) | null) {
    super(type, init);
    const i = init || {};
    this.#pointerId = eventNumberFromInit(i, "pointerId", 0);
    this.#width = eventNumberFromInit(i, "width", 1);
    this.#height = eventNumberFromInit(i, "height", 1);
    this.#pressure = eventNumberFromInit(i, "pressure", 0);
    this.#tangentialPressure = eventNumberFromInit(i, "tangentialPressure", 0);
    this.#tiltX = eventNumberFromInit(i, "tiltX", 0);
    this.#tiltY = eventNumberFromInit(i, "tiltY", 0);
    this.#twist = eventNumberFromInit(i, "twist", 0);
    this.#altitudeAngle = eventNumberFromInit(i, "altitudeAngle", Math.PI / 2);
    this.#azimuthAngle = eventNumberFromInit(i, "azimuthAngle", 0);
    this.#pointerType = eventStringFromInit(i, "pointerType");
    this.#isPrimary = !!i.isPrimary;
    this.#persistentDeviceId = eventNumberFromInit(i, "persistentDeviceId", 0);
    this.#coalesced = Array.isArray(i.coalescedEvents) ? [...i.coalescedEvents] : [];
    this.#predicted = Array.isArray(i.predictedEvents) ? [...i.predictedEvents] : [];
  }
  get pointerId() {
    return this.#pointerId;
  }
  get width() {
    return this.#width;
  }
  get height() {
    return this.#height;
  }
  get pressure() {
    return this.#pressure;
  }
  get tangentialPressure() {
    return this.#tangentialPressure;
  }
  get tiltX() {
    return this.#tiltX;
  }
  get tiltY() {
    return this.#tiltY;
  }
  get twist() {
    return this.#twist;
  }
  get altitudeAngle() {
    return this.#altitudeAngle;
  }
  get azimuthAngle() {
    return this.#azimuthAngle;
  }
  get pointerType() {
    return this.#pointerType;
  }
  get isPrimary() {
    return this.#isPrimary;
  }
  get persistentDeviceId() {
    return this.#persistentDeviceId;
  }
  getCoalescedEvents() {
    return [...this.#coalesced];
  }
  getPredictedEvents() {
    return [...this.#predicted];
  }
}

// finalizeInterface installs the DOM_DELTA_* constants from the IDL.
export class KsWheelEvent extends KsMouseEvent implements Idl.WheelEvent {
  readonly #deltaX: number;
  readonly #deltaY: number;
  readonly #deltaZ: number;
  readonly #deltaMode: number;
  readonly #momentum: boolean;
  constructor(type: string, init?: (Idl.WheelEventInit & MouseEventShimInit) | null) {
    super(type, init);
    const i = init || {};
    this.#deltaX = eventNumberFromInit(i, "deltaX", 0);
    this.#deltaY = eventNumberFromInit(i, "deltaY", 0);
    this.#deltaZ = eventNumberFromInit(i, "deltaZ", 0);
    this.#deltaMode = eventNumberFromInit(i, "deltaMode", 0);
    this.#momentum = !!i.momentum;
  }
  get deltaX() {
    return this.#deltaX;
  }
  get deltaY() {
    return this.#deltaY;
  }
  get deltaZ() {
    return this.#deltaZ;
  }
  get deltaMode() {
    return this.#deltaMode;
  }
  get momentum() {
    return this.#momentum;
  }
}

export class KsCompositionEvent extends KsUIEvent implements Idl.CompositionEvent {
  #data: string;
  constructor(type: string, init?: Idl.CompositionEventInit | null) {
    super(type, init);
    const i = init || {};
    this.#data = typeof i.data === "string" ? i.data : "";
  }
  get data() {
    return this.#data;
  }
  initCompositionEvent(
    type: string,
    bubbles?: boolean,
    cancelable?: boolean,
    view?: Idl.Window | null,
    data?: string,
  ) {
    if (eventState(this).dispatched) return;
    this.initUIEvent(type, bubbles, cancelable, view, 0);
    this.#data = domString(data, "");
  }
}

export class KsInputEvent extends KsUIEvent implements Idl.InputEvent {
  readonly #data: string | null;
  readonly #isComposing: boolean;
  readonly #inputType: string;
  readonly #targetRanges: unknown[];
  constructor(type: string, init?: (Idl.InputEventInit & { targetRanges?: unknown[] }) | null) {
    super(type, init);
    const i = init || {};
    this.#data = inputEventDataFromInit(i);
    this.#isComposing = !!i.isComposing;
    this.#inputType = eventStringFromInit(i, "inputType");
    this.#targetRanges = Array.isArray(i.targetRanges) ? [...i.targetRanges] : [];
  }
  get data() {
    return this.#data;
  }
  get isComposing() {
    return this.#isComposing;
  }
  get inputType() {
    return this.#inputType;
  }
  getTargetRanges(): unknown[] {
    return [...this.#targetRanges];
  }
}

function inputEventDataFromInit(init: Idl.InputEventInit): string | null {
  return init.data === undefined ? null : init.data === null ? null : String(init.data);
}

export class KsKeyboardEvent extends KsUIEvent implements Idl.KeyboardEvent {
  #key: string;
  readonly #code: string;
  #location: number;
  #repeat: boolean;
  readonly #isComposing: boolean;
  readonly #modifiers: Modifiers;
  readonly #keyCode: number;
  readonly #charCode: number;
  constructor(type: string, init?: (Idl.KeyboardEventInit & { which?: number }) | null) {
    super(type, init);
    const i = init || {};
    this.#key = typeof i.key === "string" ? i.key : "";
    this.#code = typeof i.code === "string" ? i.code : "";
    this.#location = typeof i.location === "number" ? i.location : 0;
    this.#repeat = !!i.repeat;
    this.#isComposing = !!i.isComposing;
    this.#modifiers = readModifierInit(i);
    this.#keyCode = keyboardKeyCode(i, this.#key);
    setUIEventWhich(this, keyboardWhich(i, this.#keyCode));
    this.#charCode = keyboardCharCode(i, type, this.#key);
  }
  get key() {
    return this.#key;
  }
  get code() {
    return this.#code;
  }
  get location() {
    return this.#location;
  }
  get repeat() {
    return this.#repeat;
  }
  get isComposing() {
    return this.#isComposing;
  }
  get altKey() {
    return this.#modifiers.Alt;
  }
  get ctrlKey() {
    return this.#modifiers.Control;
  }
  get shiftKey() {
    return this.#modifiers.Shift;
  }
  get metaKey() {
    return this.#modifiers.Meta;
  }
  get keyCode() {
    return this.#keyCode;
  }
  get charCode() {
    return this.#charCode;
  }
  getModifierState(name: string) {
    return modifierState(this.#modifiers, name);
  }
  // eslint-disable-next-line max-params -- WebIDL requires this legacy positional signature.
  initKeyboardEvent(
    type: string,
    bubbles?: boolean,
    cancelable?: boolean,
    view?: Idl.Window | null,
    key?: string,
    location?: number,
    ctrlKey?: boolean,
    altKey?: boolean,
    shiftKey?: boolean,
    metaKey?: boolean,
  ) {
    if (eventState(this).dispatched) return;
    this.initUIEvent(type, bubbles, cancelable, view, 0);
    this.#key = domString(key, "");
    this.#location = unsignedLong(location);
    this.#modifiers.Control = !!ctrlKey;
    this.#modifiers.Alt = !!altKey;
    this.#modifiers.Shift = !!shiftKey;
    this.#modifiers.Meta = !!metaKey;
  }
}

function keyboardKeyCode(i: Idl.KeyboardEventInit & { which?: number }, key: string): number {
  if (typeof i.keyCode === "number") return i.keyCode;
  if (key && key.length === 1) return key.toUpperCase().charCodeAt(0);
  return 0;
}

function keyboardCharCode(
  i: Idl.KeyboardEventInit & { which?: number },
  type: string,
  key: string,
): number {
  if (typeof i.charCode === "number") return i.charCode;
  if (type === "keypress" && key && key.length === 1) return key.charCodeAt(0);
  return 0;
}

function keyboardWhich(i: Idl.KeyboardEventInit & { which?: number }, keyCode: number): number {
  return typeof i.which === "number" ? i.which : keyCode;
}

const EVENT_IFACES: Array<[Function, IdlInterfaceName]> = [
  [KsEvent, "Event"],
  [KsCustomEvent, "CustomEvent"],
  [KsSubmitEvent, "SubmitEvent"],
  [KsHashChangeEvent, "HashChangeEvent"],
  [KsPopStateEvent, "PopStateEvent"],
  [KsPageTransitionEvent, "PageTransitionEvent"],
  [KsTransitionEvent, "TransitionEvent"],
  [KsAnimationEvent, "AnimationEvent"],
  [KsBeforeUnloadEvent, "BeforeUnloadEvent"],
  [KsDeviceMotionEvent, "DeviceMotionEvent"],
  [KsDeviceMotionEventAcceleration, "DeviceMotionEventAcceleration"],
  [KsDeviceMotionEventRotationRate, "DeviceMotionEventRotationRate"],
  [KsDeviceOrientationEvent, "DeviceOrientationEvent"],
  [KsDragEvent, "DragEvent"],
  [KsMessageEvent, "MessageEvent"],
  [KsStorageEvent, "StorageEvent"],
  [KsTextEvent, "TextEvent"],
  [KsTouchEvent, "TouchEvent"],
  [KsErrorEvent, "ErrorEvent"],
  [KsPromiseRejectionEvent, "PromiseRejectionEvent"],
  [KsUIEvent, "UIEvent"],
  [KsMouseEvent, "MouseEvent"],
  [KsFocusEvent, "FocusEvent"],
  [KsPointerEvent, "PointerEvent"],
  [KsWheelEvent, "WheelEvent"],
  [KsCompositionEvent, "CompositionEvent"],
  [KsInputEvent, "InputEvent"],
  [KsKeyboardEvent, "KeyboardEvent"],
];
for (const [cls, name] of EVENT_IFACES) {
  finalizeInterface(cls, idlInterfaceMeta(name, { brandOps: true, brandAttrs: true }));
}
