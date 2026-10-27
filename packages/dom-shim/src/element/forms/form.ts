// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements form ownership, associated-control collections, and submit/reset behavior.

import type * as Idl from "../../idl/types.generated.js";
import { HTML_NS } from "../../constants.js";
import {
  makeHtmlCollection,
  documentImpl as document,
  HTMLFormControlsCollectionCls,
  makeNodeList,
  ksGlobal,
  windowObj,
  dom,
} from "../../state.js";
import { parseUrlForNode, urlencodedSerialize } from "../../text-encoding.js";
import { dispatchTrustedEvent } from "../../events/dispatch.js";
import { elemNs, optionSelected } from "../../registries.js";
import {
  getInternalState,
  type IframePost,
  sendUpstreamEvent as ksSendUpstreamEvent,
} from "../../internal-state.js";
import { fileInputFiles, fileInputLists } from "../../file-input.js";
import { KsSubmitEvent, KsEvent } from "../../events/event.js";
import {
  defineReflectedString,
  defineReflectedEnumWithDefaults,
  defineReflectedBoolean,
} from "../reflect.js";
import { inputTypeOf, inputStateOf, ksPushInputText } from "./input-state.js";
import { formListedDescendants, isFormListed } from "./listed.js";
import { selectOptions, resyncSelectLabel } from "./select-options.js";
import {
  namedTargetIframe,
  formEncoding,
  collectFormEntries,
  encodeFormBody,
  formStringEntries,
} from "./submission.js";
import type { Element } from "../element.js";
import { HTMLElement } from "../html-element.js";
import { HTMLInputElement } from "./input.js";
import { HTMLTextAreaElement } from "./textarea.js";
import { HTMLSelectElement } from "./select.js";
import { HTMLButtonElement } from "./button.js";
import type {
  HTMLFormControlsCollectionCls as HTMLFormControlsCollection,
  NodeListCls,
} from "../../collections.js";

const elementsCollections = new WeakMap<object, HTMLFormControlsCollection>();
const formsFiringSubmit = new WeakSet<object>();

type ElementWithCheckValidity = Idl.Element & { checkValidity(): boolean };
type ElementWithReportValidity = Idl.Element & { reportValidity(): boolean };

function hasCheckValidity(element: Idl.Element): element is ElementWithCheckValidity {
  return typeof Reflect.get(element, "checkValidity") === "function";
}

function hasReportValidity(element: Idl.Element): element is ElementWithReportValidity {
  return typeof Reflect.get(element, "reportValidity") === "function";
}

function resetInput(input: HTMLInputElement) {
  const type = inputTypeOf(input);
  if (isCheckableType(type)) return resetCheckedInput(input);
  if (isButtonType(type)) return;
  resetInputValue(input, type);
}

function isCheckableType(type: string): boolean {
  return type === "checkbox" || type === "radio";
}

function isButtonType(type: string): boolean {
  return type === "submit" || type === "reset" || type === "button" || type === "image";
}

function resetCheckedInput(input: HTMLInputElement): void {
  const state = inputStateOf(input);
  state.checkedDirty = false;
  state.checked = false;
  try {
    const domHandle = dom;
    if (typeof domHandle.setCheckboxChecked === "function") {
      domHandle.setCheckboxChecked(input._id, input.hasAttribute("checked"));
    }
  } catch {}
}

function resetInputValue(input: HTMLInputElement, type: string): void {
  if (type === "file") {
    fileInputFiles.delete(input._id);
    fileInputLists.delete(input._id);
  }
  const state = inputStateOf(input);
  state.valueDirty = false;
  state.value = "";
  if (state.defaultValueAttr !== undefined) ksPushInputText(input, state.defaultValueAttr);
}

function resetTextArea(textarea: HTMLTextAreaElement) {
  const state = inputStateOf(textarea);
  state.valueDirty = false;
  state.value = "";
  if (state.defaultValueAttr !== undefined) {
    ksPushInputText(textarea, state.defaultValueAttr);
  }
}

function resetSelect(select: HTMLSelectElement) {
  const options = selectOptions(select);
  for (const option of options) {
    optionSelected.set(option._id, {
      selected: option.defaultSelected,
      dirty: false,
    });
  }
  if (!select.multiple) {
    let anySelected = false;
    for (const option of options) {
      if (optionSelected.get(option._id)?.selected) {
        anySelected = true;
        break;
      }
    }
    if (!anySelected) {
      for (const option of options) {
        if (option.disabled) continue;
        optionSelected.set(option._id, { selected: true, dirty: false });
        break;
      }
    }
  }
  resyncSelectLabel(select);
}

function isSubmitButton(
  submitter: Idl.HTMLElement,
): submitter is HTMLButtonElement | HTMLInputElement {
  return (
    (submitter instanceof HTMLButtonElement && submitter.type === "submit") ||
    (submitter instanceof HTMLInputElement &&
      (inputTypeOf(submitter) === "submit" || inputTypeOf(submitter) === "image"))
  );
}

function validateSubmitter(
  form: HTMLFormElement,
  submitter: Idl.HTMLElement | null | undefined,
): void {
  if (submitter === null || submitter === undefined) return;
  assertValidSubmitter(form, submitter);
}

function assertValidSubmitter(form: HTMLFormElement, submitter: Idl.HTMLElement): void {
  if (!isSubmitButton(submitter)) {
    throw new (ksGlobal.DOMException || Error)(
      "requestSubmit: submitter must be a submit button",
      "TypeError",
    );
  }
  if (submitter.form !== form) {
    throw new DOMException(
      "requestSubmit: submitter is not associated with this form",
      "NotFoundError",
    );
  }
}

function dispatchFormSubmit(
  form: HTMLFormElement,
  submitter: Idl.HTMLElement | null | undefined,
): string | null {
  const ev = new KsSubmitEvent("submit", {
    bubbles: true,
    cancelable: true,
    submitter: submitter || null,
  });
  form.__ksFiringSubmit(() => form.dispatchEvent(ev));
  if (ev.defaultPrevented) return null;
  return form.__ksPerformSubmission(submitter || null);
}

type SubmissionTargetResolution =
  | { cancelled: true }
  | { cancelled: false; targetFrame: Element | null };

function resolveSubmissionTarget(
  form: HTMLFormElement,
  submitter: Idl.HTMLElement | null,
): SubmissionTargetResolution {
  try {
    const targetAttr = submitterTargetAttribute(form, submitter);
    const keyword = targetAttr.toLowerCase();
    if (isDefaultTarget(targetAttr, keyword)) {
      return { cancelled: false, targetFrame: null };
    }
    if (keyword === "_blank") return { cancelled: true };
    const targetFrame = namedTargetIframe(form, targetAttr);
    if (!targetFrame) return { cancelled: true };
    return { cancelled: false, targetFrame };
  } catch (error) {
    warnTargetResolution(error);
    return { cancelled: false, targetFrame: null };
  }
}

function submitterTargetAttribute(
  form: HTMLFormElement,
  submitter: Idl.HTMLElement | null,
): string {
  if (!submitterHasTargetAttribute(submitter)) return form.getAttribute("target") || "";
  return submitter.getAttribute("formtarget") || "";
}

function submitterHasTargetAttribute(
  submitter: Idl.HTMLElement | null,
): submitter is Idl.HTMLElement {
  return !!(submitter && submitter.hasAttribute && submitter.hasAttribute("formtarget"));
}

function isDefaultTarget(targetAttr: string, keyword: string): boolean {
  return !targetAttr || keyword === "_self" || keyword === "_top" || keyword === "_parent";
}

function warnTargetResolution(error: unknown): void {
  try {
    console.warn("[kitesurf-form] target resolution failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {}
}

function submitterHasAttribute(submitter: Idl.HTMLElement | null, attr: string): boolean {
  return !!(submitter && submitter.hasAttribute && submitter.hasAttribute("form" + attr));
}

function submitterAttribute(submitter: Idl.HTMLElement | null, attr: string): string | null {
  return submitter && submitter.getAttribute ? submitter.getAttribute("form" + attr) : null;
}

function resolveFormMethod(raw: string | null): string {
  const method = (raw || "").toLowerCase();
  return method === "get" || method === "post" || method === "dialog" ? method : "get";
}

function resolveFormEnctype(raw: string | null): string {
  const enctype = (raw || "").toLowerCase();
  return enctype === "multipart/form-data" || enctype === "text/plain"
    ? enctype
    : "application/x-www-form-urlencoded";
}

function submissionMethod(form: HTMLFormElement, submitter: Idl.HTMLElement | null): string {
  return submitterHasAttribute(submitter, "method")
    ? resolveFormMethod(submitterAttribute(submitter, "method"))
    : resolveFormMethod(form.getAttribute("method"));
}

function submissionEnctype(form: HTMLFormElement, submitter: Idl.HTMLElement | null): string {
  return submitterHasAttribute(submitter, "enctype")
    ? resolveFormEnctype(submitterAttribute(submitter, "enctype"))
    : resolveFormEnctype(form.getAttribute("enctype"));
}

function submissionAction(form: HTMLFormElement, submitter: Idl.HTMLElement | null): string | null {
  return submitterHasAttribute(submitter, "action")
    ? submitterAttribute(submitter, "action")
    : form.getAttribute("action");
}

function submissionBase(): string | undefined {
  return (windowObj && windowObj.location && windowObj.location.href) || undefined;
}

function submissionUrl(
  form: HTMLFormElement,
  submitter: Idl.HTMLElement | null,
  base: string | undefined,
): URL {
  const actionAttr = submissionAction(form, submitter);
  return parseUrlForNode(
    form,
    actionAttr && actionAttr.length ? actionAttr : base || "about:blank",
    base,
  );
}

type FormNavigationRequest =
  | { url: string; postData: string; postContentType: string }
  | { url: string };

type FormNavigationPlan = { request: FormNavigationRequest; post: IframePost | undefined };

function formNavigationPlan(
  form: HTMLFormElement,
  submitter: Idl.HTMLElement | null,
  method: string,
  url: URL,
  entries: ReturnType<typeof collectFormEntries>,
  encoding: string,
): FormNavigationPlan {
  if (method === "post") {
    const post = encodeFormBody(submissionEnctype(form, submitter), entries, encoding);
    return {
      request: { url: url.toString(), postData: post.body, postContentType: post.contentType },
      post,
    };
  }
  url.search = urlencodedSerialize(formStringEntries(entries), encoding);
  return { request: { url: url.toString() }, post: undefined };
}

function dispatchFormNavigation(
  targetFrame: Element | null,
  plan: FormNavigationPlan,
  method: string,
): string | null {
  if (targetFrame) {
    getInternalState().navigateIframe?.(targetFrame, plan.request.url, plan.post);
    return null;
  }
  const state = getInternalState();
  if (state.dispatchingUserEvent) {
    // Defer navigation until the trusted user event finishes, preserving default-action order.
    state.pendingSubmitNav = plan.request;
  } else if (typeof ksSendUpstreamEvent === "function") {
    ksSendUpstreamEvent({ event: "kitesurf.formSubmitNavigate", params: plan.request });
  }
  const url = plan.request.url;
  return method === "post" ? null : url;
}

function performFormSubmission(
  form: HTMLFormElement,
  submitter: Idl.HTMLElement | null,
  targetFrame: Element | null,
): string | null {
  try {
    const method = submissionMethod(form, submitter);
    if (method === "dialog") return null;
    const base = submissionBase();
    const url = submissionUrl(form, submitter, base);
    const encoding = formEncoding(form);
    const entries = collectFormEntries(form, submitter || null, encoding);
    const plan = formNavigationPlan(form, submitter, method, url, entries, encoding);
    return dispatchFormNavigation(targetFrame, plan, method);
  } catch {
    return null;
  }
}

function formNodeInfo(id: number): { nodeName?: unknown } | null {
  let info: { nodeName?: unknown } | null = null;
  try {
    info = dom.nodeInfo(id);
  } catch {}
  return info;
}

function assertFormNode(id: number, info: { nodeName?: unknown } | null): void {
  const namespace = elemNs.get(id);
  if (!info) throw new TypeError("Illegal invocation");
  if (!isFormNodeInfo(info)) throw new TypeError("Illegal invocation");
  if (hasNonHtmlFormNamespace(namespace)) throw new TypeError("Illegal invocation");
}

function isFormNodeInfo(info: { nodeName?: unknown }): boolean {
  return String(info.nodeName || "").toUpperCase() === "FORM";
}

function hasNonHtmlFormNamespace(namespace: ReturnType<typeof elemNs.get>): boolean {
  return Boolean(namespace && namespace.ns !== HTML_NS);
}

function resetFormControls(elements: HTMLFormControlsCollection): void {
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (element instanceof HTMLInputElement) resetInput(element);
    else if (element instanceof HTMLTextAreaElement) resetTextArea(element);
    else if (element instanceof HTMLSelectElement) resetSelect(element);
  }
}

interface HTMLFormElement extends Pick<Idl.HTMLFormElement, "rel"> {}

class HTMLFormElement extends HTMLElement implements Idl.HTMLFormElement {
  get elements() {
    const cached = elementsCollections.get(this);
    if (cached) return cached;
    const form = this;
    const coll = makeHtmlCollection<HTMLFormControlsCollection>(() => {
      const out: Element[] = [];
      const seen = new Set<Element>();
      for (const control of formListedDescendants(form)) {
        if (control.form === form) {
          out.push(control);
          seen.add(control);
        }
      }
      if (form.id) {
        const doc = form.ownerDocument || document;
        try {
          const externals = doc.querySelectorAll(`[form="${form.id}"]`);
          for (const e of externals) {
            if (!seen.has(e) && isFormListed(e) && e.form === form) {
              out.push(e);
              seen.add(e);
            }
          }
        } catch {}
      }
      return out;
    }, HTMLFormControlsCollectionCls);
    elementsCollections.set(this, coll);
    return coll;
  }
  get length() {
    const els = this.elements;
    let n = 0;
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      if (e instanceof HTMLInputElement && inputTypeOf(e) === "image") continue;
      n++;
    }
    return n;
  }
  namedItem(name: string): Element | NodeListCls | null {
    if (!name) return null;
    const els = this.elements;
    const matches = namedFormElements(els, name);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    return makeNodeList(() => matches);
  }
  item(index: number): Element | null {
    const els = this.elements;
    const i = Number(index) | 0;
    return i >= 0 && i < els.length ? els[i] : null;
  }
  get action() {
    const raw = this.getAttribute("action");
    if (raw == null || raw === "") {
      try {
        const doc = ksGlobal.document;
        return String(doc?.URL || "");
      } catch {
        return "";
      }
    }
    try {
      return new URL(raw, this.baseURI || undefined).toString();
    } catch {
      return raw;
    }
  }
  set action(v) {
    this.setAttribute("action", String(v));
  }
  get method() {
    const raw = (this.getAttribute("method") || "").toLowerCase();
    if (raw === "post" || raw === "dialog") return raw;
    return "get";
  }
  set method(v) {
    this.setAttribute("method", String(v));
  }
  get enctype() {
    const raw = (this.getAttribute("enctype") || "").toLowerCase();
    if (raw === "multipart/form-data") return raw;
    if (raw === "text/plain") return raw;
    return "application/x-www-form-urlencoded";
  }
  set enctype(v) {
    this.setAttribute("enctype", String(v));
  }
  get encoding() {
    return this.enctype;
  }
  set encoding(v) {
    this.enctype = v;
  }
  get name() {
    return this.getAttribute("name") || "";
  }
  set name(v) {
    this.setAttribute("name", String(v));
  }
  get target() {
    return this.getAttribute("target") || "";
  }
  set target(v) {
    this.setAttribute("target", String(v));
  }
  get acceptCharset() {
    return this.getAttribute("accept-charset") || "";
  }
  set acceptCharset(v) {
    this.setAttribute("accept-charset", String(v));
  }
  get autocomplete() {
    const raw = (this.getAttribute("autocomplete") || "").toLowerCase();
    return raw === "off" ? "off" : "on";
  }
  set autocomplete(v) {
    this.setAttribute("autocomplete", String(v));
  }
  get noValidate() {
    return this.hasAttribute("novalidate");
  }
  set noValidate(v) {
    if (v) this.setAttribute("novalidate", "");
    else this.removeAttribute("novalidate");
  }
  submit() {
    this.__ksRequestSubmit(null);
  }
  requestSubmit(submitter?: Idl.HTMLElement | null) {
    this.__ksRequestSubmit(submitter);
    return undefined;
  }
  __ksFiringSubmit(fire: () => void): void {
    formsFiringSubmit.add(this);
    try {
      fire();
    } finally {
      formsFiringSubmit.delete(this);
    }
  }
  __ksRequestSubmit(submitter?: Idl.HTMLElement | null): string | null {
    if (formsFiringSubmit.has(this)) {
      return this.__ksPerformSubmission(submitter ?? null);
    }
    validateSubmitter(this, submitter);
    return dispatchFormSubmit(this, submitter);
  }
  __ksPerformSubmission(submitter: Idl.HTMLElement | null): string | null {
    const target = resolveSubmissionTarget(this, submitter);
    if (target.cancelled) return null;
    return performFormSubmission(this, submitter, target.targetFrame);
  }
  reset() {
    const info = formNodeInfo(this._id);
    assertFormNode(this._id, info);
    const ev = new KsEvent("reset", { bubbles: true, cancelable: true });
    dispatchTrustedEvent(this, ev);
    if (ev.defaultPrevented) return;
    resetFormControls(this.elements);
  }
  checkValidity() {
    const els = this.elements;
    let allValid = true;
    for (let i = 0; i < els.length; i++) {
      const c = els[i];
      if (hasCheckValidity(c)) {
        if (!c.checkValidity()) allValid = false;
      }
    }
    return allValid;
  }
  reportValidity() {
    const els = this.elements;
    let allValid = true;
    for (let i = 0; i < els.length; i++) {
      const c = els[i];
      if (hasReportValidity(c)) {
        if (!c.reportValidity()) allValid = false;
      }
    }
    return allValid;
  }
}

function namedFormElements(els: HTMLFormControlsCollection, name: string): Element[] {
  const matches: Element[] = [];
  for (let i = 0; i < els.length; i++) {
    const element = els[i];
    if (element.id === name || element.getAttribute("name") === name) matches.push(element);
  }
  return matches;
}

defineReflectedString(HTMLFormElement.prototype, "rel", "rel");
defineReflectedString(HTMLFormElement.prototype, "acceptCharset", "accept-charset");

defineReflectedEnumWithDefaults(
  HTMLFormElement.prototype,
  "enctype",
  "enctype",
  ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"],
  "application/x-www-form-urlencoded",
  "application/x-www-form-urlencoded",
);
defineReflectedEnumWithDefaults(
  HTMLFormElement.prototype,
  "method",
  "method",
  ["get", "post", "dialog"],
  "get",
  "get",
);
defineReflectedEnumWithDefaults(
  HTMLFormElement.prototype,
  "autocomplete",
  "autocomplete",
  ["on", "off"],
  "on",
  "on",
);
defineReflectedBoolean(HTMLFormElement.prototype, "noValidate", "novalidate");

export { HTMLFormElement };
