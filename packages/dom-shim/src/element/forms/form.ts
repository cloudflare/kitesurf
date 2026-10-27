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

interface SubmitterLike {
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
}

function resetInput(input: HTMLInputElement) {
  const type = inputTypeOf(input);
  if (type === "checkbox" || type === "radio") {
    const state = inputStateOf(input);
    state.checkedDirty = false;
    state.checked = false;
    try {
      dom.setCheckboxChecked(input._id, input.hasAttribute("checked"));
    } catch {}
  } else if (type !== "submit" && type !== "reset" && type !== "button" && type !== "image") {
    if (type === "file") {
      fileInputFiles.delete(input._id);
      fileInputLists.delete(input._id);
    }
    const state = inputStateOf(input);
    state.valueDirty = false;
    state.value = "";
    if (state.defaultValueAttr !== undefined) {
      ksPushInputText(input, state.defaultValueAttr);
    }
  }
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
    const matches: Element[] = [];
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      if (e.id === name || e.getAttribute("name") === name) {
        matches.push(e);
      }
    }
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
  __ksRequestSubmit(submitter?: SubmitterLike | null): string | null {
    if (formsFiringSubmit.has(this)) {
      return this.__ksPerformSubmission(submitter ?? null);
    }
    if (submitter !== null && submitter !== undefined) {
      const isButtonLike =
        (submitter instanceof HTMLButtonElement && submitter.type === "submit") ||
        (submitter instanceof HTMLInputElement &&
          (inputTypeOf(submitter) === "submit" || inputTypeOf(submitter) === "image"));
      if (!isButtonLike) {
        throw new (ksGlobal.DOMException || Error)(
          "requestSubmit: submitter must be a submit button",
          "TypeError",
        );
      }
      if (submitter.form !== this) {
        throw new DOMException(
          "requestSubmit: submitter is not associated with this form",
          "NotFoundError",
        );
      }
    }
    const ev = new KsSubmitEvent("submit", {
      bubbles: true,
      cancelable: true,
      submitter: submitter || null,
    });
    this.__ksFiringSubmit(() => this.dispatchEvent(ev));
    if (ev.defaultPrevented) return null;
    return this.__ksPerformSubmission(submitter || null);
  }
  __ksPerformSubmission(submitter: SubmitterLike | null): string | null {
    let targetFrame: Element | null = null;
    try {
      const targetAttr =
        submitter && submitter.hasAttribute && submitter.hasAttribute("formtarget")
          ? submitter.getAttribute("formtarget") || ""
          : this.getAttribute("target") || "";
      const keyword = targetAttr.toLowerCase();
      if (targetAttr && keyword !== "_self" && keyword !== "_top" && keyword !== "_parent") {
        if (keyword === "_blank") return null;
        targetFrame = namedTargetIframe(this, targetAttr);
        if (!targetFrame) return null;
      }
    } catch (error) {
      try {
        console.warn("[kitesurf-form] target resolution failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {}
    }
    try {
      const submitterHas = (attr: string) =>
        !!(submitter && submitter.hasAttribute && submitter.hasAttribute("form" + attr));
      const submitterAttr = (attr: string) =>
        submitter && submitter.getAttribute ? submitter.getAttribute("form" + attr) : null;
      const resolveMethod = (raw: string | null) => {
        const m = (raw || "").toLowerCase();
        return m === "get" || m === "post" || m === "dialog" ? m : "get";
      };
      const resolveEnctype = (raw: string | null) => {
        const e = (raw || "").toLowerCase();
        return e === "multipart/form-data" || e === "text/plain"
          ? e
          : "application/x-www-form-urlencoded";
      };
      const method = submitterHas("method")
        ? resolveMethod(submitterAttr("method"))
        : resolveMethod(this.getAttribute("method"));
      if (method === "dialog") return null;
      const base = (windowObj && windowObj.location && windowObj.location.href) || undefined;
      const actionAttr = submitterHas("action")
        ? submitterAttr("action")
        : this.getAttribute("action");
      const url = parseUrlForNode(
        this,
        actionAttr && actionAttr.length ? actionAttr : base || "about:blank",
        base,
      );
      const encoding = formEncoding(this);
      const entries = collectFormEntries(this, submitter || null, encoding);
      let navReq;
      let post: IframePost | undefined;
      if (method === "post") {
        const enctype = submitterHas("enctype")
          ? resolveEnctype(submitterAttr("enctype"))
          : resolveEnctype(this.getAttribute("enctype"));
        post = encodeFormBody(enctype, entries, encoding);
        navReq = { url: url.toString(), postData: post.body, postContentType: post.contentType };
      } else {
        url.search = urlencodedSerialize(formStringEntries(entries), encoding);
        navReq = { url: url.toString() };
      }
      if (targetFrame) {
        getInternalState().navigateIframe?.(targetFrame, navReq.url, post);
        return null;
      }
      const cs = getInternalState();
      if (cs.dispatchingUserEvent) {
        // Defer navigation until the trusted user event finishes, preserving default-action order.
        cs.pendingSubmitNav = navReq;
      } else if (typeof ksSendUpstreamEvent === "function") {
        ksSendUpstreamEvent({ event: "kitesurf.formSubmitNavigate", params: navReq });
      }
      return method === "post" ? null : navReq.url;
    } catch {
      return null;
    }
  }
  reset() {
    let info: { nodeName?: unknown } | null = null;
    try {
      info = dom.nodeInfo(this._id);
    } catch {}
    const namespace = elemNs.get(this._id);
    if (
      !info ||
      String(info.nodeName || "").toUpperCase() !== "FORM" ||
      (namespace && namespace.ns !== HTML_NS)
    ) {
      throw new TypeError("Illegal invocation");
    }
    const ev = new KsEvent("reset", { bubbles: true, cancelable: true });
    dispatchTrustedEvent(this, ev);
    if (ev.defaultPrevented) return;
    const els = this.elements;
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      if (e instanceof HTMLInputElement) {
        resetInput(e);
      } else if (e instanceof HTMLTextAreaElement) {
        resetTextArea(e);
      } else if (e instanceof HTMLSelectElement) {
        resetSelect(e);
      }
    }
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
