// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements FormData storage and builds entries from a form's successful controls.

import { KsEvent } from "./events/event.js";
import { fileInputFiles } from "./file-input.js";
import {
  HTMLFormElement,
  HTMLButtonElement,
  HTMLInputElement,
  HTMLTextAreaElement,
  HTMLSelectElement,
  HTMLFieldSetElement,
  HTMLObjectElement,
  HTMLOutputElement,
  inputTypeOf,
  isDisabledInFormContext,
  selectOptions,
} from "./element/index.js";
import type { HTMLOptionElement } from "./element/index.js";
import { ksGlobal } from "./state.js";
import type * as Idl from "./idl/types.generated.js";

type FormDataEntry = { name: string; value: string | File };

const BlobCtor: typeof Blob = ksGlobal.Blob;
const FileCtor: typeof File = ksGlobal.File;

function entryValue(value: unknown, filename: string | undefined): string | File {
  if (!(value instanceof BlobCtor)) return String(value);
  const isFile = value instanceof FileCtor;
  if (isFile && filename === undefined) return value;
  const name = filename !== undefined ? filename : isFile ? value.name : "blob";
  return new FileCtor([value], name, {
    type: value.type,
    lastModified: isFile ? value.lastModified : undefined,
  });
}

// The two-argument append and set take a USVString; with a filename, the
// value must be a Blob. Anything with a numeric size and a string type
// counts.
function requireBlobWithFilename(value: unknown, method: string): void {
  const isBlobLike =
    value !== null &&
    typeof value === "object" &&
    typeof Reflect.get(value, "size") === "number" &&
    typeof Reflect.get(value, "type") === "string";
  if (!isBlobLike) {
    throw new TypeError("FormData." + method + ": value must be a Blob when filename is provided");
  }
}

function appendFileEntries(entries: FormDataEntry[], name: string, files: File[]) {
  if (files.length === 0) {
    entries.push({ name, value: new FileCtor([], "") });
    return;
  }
  for (const file of files) entries.push({ name, value: file });
}

class FormData implements Idl.FormData {
  #entries: FormDataEntry[] = [];
  /**
   * Dispatches `formdata` before collecting fields.
   * Invalid forms or submitters throw a DOMException named `TypeError`, or an Error fallback.
   */
  constructor(form?: Idl.HTMLFormElement, submitter?: Idl.HTMLElement | null) {
    if (form == null) return;
    if (!(form instanceof HTMLFormElement)) {
      throw new (ksGlobal.DOMException || Error)(
        "FormData constructor: argument must be an HTMLFormElement",
        "TypeError",
      );
    }
    let submitterEl: HTMLInputElement | HTMLButtonElement | null = null;
    if (submitter !== undefined && submitter !== null) {
      const ok =
        (submitter instanceof HTMLButtonElement && submitter.type === "submit") ||
        (submitter instanceof HTMLInputElement &&
          (inputTypeOf(submitter) === "submit" || inputTypeOf(submitter) === "image"));
      if (!ok || submitter.form !== form) {
        throw new (ksGlobal.DOMException || Error)("FormData: invalid submitter", "TypeError");
      }
      submitterEl = submitter;
    }
    try {
      // FormDataEvent's pinned IDL omits the shim's formData property.
      const fdEv = new KsEvent("formdata", { bubbles: true, cancelable: false }) as KsEvent & {
        formData: FormData;
      };
      fdEv.formData = this;
      form.dispatchEvent(fdEv);
    } catch {}

    const els = form.elements;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const name = el.getAttribute && el.getAttribute("name");
      if (!name) continue;
      if (isDisabledInFormContext(el)) continue;
      if (el instanceof HTMLFieldSetElement) continue;
      if (el instanceof HTMLObjectElement) continue;
      if (el instanceof HTMLInputElement) {
        const t = inputTypeOf(el);
        if (t === "checkbox" || t === "radio") {
          if (!el.checked) continue;
          this.#entries.push({ name, value: el.value });
        } else if (t === "submit" || t === "image" || t === "reset" || t === "button") {
          if (el !== submitterEl) continue;
          this.#entries.push({ name, value: el.value });
        } else if (t === "hidden" && name.toLowerCase() === "_charset_") {
          this.#entries.push({ name, value: "UTF-8" });
        } else if (t === "file") {
          appendFileEntries(this.#entries, name, fileInputFiles.get(el._id) || []);
        } else {
          this.#entries.push({ name, value: el.value });
        }
        continue;
      }
      if (el instanceof HTMLTextAreaElement) {
        this.#entries.push({ name, value: el.value });
        continue;
      }
      if (el instanceof HTMLSelectElement) {
        const opts: HTMLOptionElement[] = selectOptions(el);
        for (const o of opts) {
          if (o.selected && !o.disabled) {
            this.#entries.push({ name, value: o.value });
          }
        }
        continue;
      }
      if (el instanceof HTMLButtonElement) {
        if (el !== submitterEl) continue;
        this.#entries.push({ name, value: el.value });
        continue;
      }
      if (el instanceof HTMLOutputElement) {
        continue;
      }
    }
  }
  append(name: string, value: unknown, filename?: string) {
    if (arguments.length >= 3) requireBlobWithFilename(value, "append");
    // WebIDL DOMString conversion: null and undefined become "null" and
    // "undefined".
    const fname = filename !== undefined ? String(filename) : undefined;
    this.#entries.push({ name: String(name), value: entryValue(value, fname) });
  }
  delete(name: string) {
    const n = String(name);
    this.#entries = this.#entries.filter((e) => e.name !== n);
  }
  get(name: string) {
    const n = String(name);
    for (const e of this.#entries) {
      if (e.name === n) return e.value;
    }
    return null;
  }
  getAll(name: string) {
    const n = String(name);
    return this.#entries.filter((e) => e.name === n).map((e) => e.value);
  }
  has(name: string) {
    const n = String(name);
    return this.#entries.some((e) => e.name === n);
  }
  set(name: string, value: unknown, filename?: string) {
    if (arguments.length >= 3) requireBlobWithFilename(value, "set");
    const n = String(name);
    const fname = filename !== undefined ? String(filename) : undefined;
    const e: FormDataEntry = { name: n, value: entryValue(value, fname) };
    const out: FormDataEntry[] = [];
    let replaced = false;
    for (const cur of this.#entries) {
      if (cur.name === n) {
        if (!replaced) {
          out.push(e);
          replaced = true;
        }
      } else {
        out.push(cur);
      }
    }
    if (!replaced) out.push(e);
    this.#entries = out;
  }
  *keys(): IterableIterator<string> {
    for (const e of this.#entries) yield e.name;
  }
  *values(): IterableIterator<string | File> {
    for (const e of this.#entries) yield e.value;
  }
  *entries(): IterableIterator<[string, string | File]> {
    for (const e of this.#entries) {
      const entry: [string, string | File] = [e.name, e.value];
      yield entry;
    }
  }
  forEach(
    callback: (value: string | File, key: string, parent: FormData) => void,
    thisArg?: unknown,
  ): void {
    for (const e of this.#entries) {
      callback.call(thisArg, e.value, e.name, this);
    }
  }
  [Symbol.iterator](): IterableIterator<[string, string | File]> {
    return this.entries();
  }
  get [Symbol.toStringTag](): "FormData" {
    return "FormData";
  }
}

export { FormData };
