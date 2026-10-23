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
  if (value instanceof FileCtor) return entryFileValue(value, filename);
  return entryBlobValue(value, filename);
}

function entryFileValue(value: File, filename: string | undefined): File {
  if (filename === undefined) return value;
  return new FileCtor([value], filename, {
    type: value.type,
    lastModified: value.lastModified,
  });
}

function entryBlobValue(value: Blob, filename: string | undefined): File {
  const name = filename !== undefined ? filename : "blob";
  return new FileCtor([value], name, { type: value.type, lastModified: undefined });
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

type FormControl = NonNullable<HTMLFormElement["elements"][number]>;
type Submitter = HTMLInputElement | HTMLButtonElement;

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function isSubmitButton(value: unknown): value is HTMLButtonElement {
  return value instanceof HTMLButtonElement && value.type === "submit";
}

function isSubmitInput(value: unknown): value is HTMLInputElement {
  if (!(value instanceof HTMLInputElement)) return false;
  const type = inputTypeOf(value);
  return type === "submit" || inputTypeOf(value) === "image";
}

function resolveSubmitter(form: HTMLFormElement, value: unknown): Submitter | null {
  if (isAbsent(value)) return null;
  if (!isSubmitButton(value) && !isSubmitInput(value)) {
    throwInvalidSubmitter();
  }
  if (value.form !== form) {
    throwInvalidSubmitter();
  }
  return value;
}

function throwInvalidSubmitter(): never {
  throw new (ksGlobal.DOMException || Error)("FormData: invalid submitter", "TypeError");
}

function dispatchFormData(form: HTMLFormElement, formData: FormData): void {
  try {
    // FormDataEvent's pinned IDL omits the shim's formData property.
    const fdEv = new KsEvent("formdata", { bubbles: true, cancelable: false }) as KsEvent & {
      formData: FormData;
    };
    fdEv.formData = formData;
    form.dispatchEvent(fdEv);
  } catch {}
}

function collectFormEntries(
  form: HTMLFormElement,
  submitter: Submitter | null,
  entries: FormDataEntry[],
): void {
  const els = form.elements;
  for (let i = 0; i < els.length; i++) {
    appendControlEntries(entries, els[i], submitter);
  }
}

function successfulControlName(el: FormControl): string | null {
  const name = el.getAttribute && el.getAttribute("name");
  if (!name) return null;
  if (isDisabledInFormContext(el)) return null;
  if (isExcludedFormControl(el)) return null;
  return name;
}

function isExcludedFormControl(el: FormControl): boolean {
  return el instanceof HTMLFieldSetElement || el instanceof HTMLObjectElement;
}

function appendControlEntries(
  entries: FormDataEntry[],
  el: FormControl,
  submitter: Submitter | null,
): void {
  const name = successfulControlName(el);
  if (!name) return;
  if (el instanceof HTMLInputElement) {
    appendInputEntry(entries, name, el, submitter);
    return;
  }
  if (el instanceof HTMLTextAreaElement) {
    entries.push({ name, value: el.value });
    return;
  }
  appendRemainingControlEntries(entries, name, el, submitter);
}

function appendRemainingControlEntries(
  entries: FormDataEntry[],
  name: string,
  el: FormControl,
  submitter: Submitter | null,
): void {
  if (el instanceof HTMLSelectElement) {
    appendSelectEntries(entries, name, el);
    return;
  }
  if (el instanceof HTMLButtonElement) {
    if (el !== submitter) return;
    entries.push({ name, value: el.value });
    return;
  }
  if (el instanceof HTMLOutputElement) return;
}

function appendInputEntry(
  entries: FormDataEntry[],
  name: string,
  el: HTMLInputElement,
  submitter: Submitter | null,
): void {
  const type = inputTypeOf(el);
  switch (type) {
    case "checkbox":
    case "radio":
      if (el.checked) entries.push({ name, value: el.value });
      return;
    case "submit":
    case "image":
    case "reset":
    case "button":
      if (el === submitter) entries.push({ name, value: el.value });
      return;
    case "hidden":
      if (name.toLowerCase() === "_charset_") {
        entries.push({ name, value: "UTF-8" });
        return;
      }
      break;
    case "file":
      appendFileInputEntries(entries, name, el);
      return;
  }
  entries.push({ name, value: el.value });
}

function appendFileInputEntries(
  entries: FormDataEntry[],
  name: string,
  el: HTMLInputElement,
): void {
  appendFileEntries(entries, name, fileInputFiles.get(el._id) || []);
}

function appendSelectEntries(entries: FormDataEntry[], name: string, el: HTMLSelectElement): void {
  const options: HTMLOptionElement[] = selectOptions(el);
  for (const option of options) {
    if (option.selected && !option.disabled) entries.push({ name, value: option.value });
  }
}

function replaceEntry(entries: FormDataEntry[], entry: FormDataEntry): FormDataEntry[] {
  const out: FormDataEntry[] = [];
  let replaced = false;
  for (const current of entries) {
    if (current.name === entry.name) {
      if (!replaced) {
        out.push(entry);
        replaced = true;
      }
    } else {
      out.push(current);
    }
  }
  if (!replaced) out.push(entry);
  return out;
}

class FormData implements Idl.FormData {
  #entries: FormDataEntry[] = [];
  /**
   * Dispatches `formdata` before collecting fields.
   * Invalid forms or submitters throw a DOMException named `TypeError`, or an Error fallback.
   */
  constructor(form?: unknown, submitter?: unknown) {
    if (form == null) return;
    if (!(form instanceof HTMLFormElement)) {
      throw new (ksGlobal.DOMException || Error)(
        "FormData constructor: argument must be an HTMLFormElement",
        "TypeError",
      );
    }
    const submitterEl = resolveSubmitter(form, submitter);
    dispatchFormData(form, this);
    collectFormEntries(form, submitterEl, this.#entries);
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
    this.#entries = replaceEntry(this.#entries, e);
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
