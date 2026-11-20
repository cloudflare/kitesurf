// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Collects successful form controls and encodes URL-encoded or multipart submissions.

import { elementDocument, ksGlobal } from "../../state.js";
import {
  encodeHtmlBytes,
  urlencodedSerialize,
  encodingForLabel,
  outputEncoding,
  characterSetOf,
} from "../../text-encoding.js";
import { fileInputFiles, binaryString } from "../../file-input.js";
import { inputTypeOf } from "./input-state.js";
import { isDisabledInFormContext } from "./listed.js";
import { selectedOptionsOf, isOptionEffectivelyDisabled } from "./select-options.js";
import { type Element, elementAttributes } from "../element.js";
import { formBehindProxy } from "../../registries.js";
import type { HTMLFormElement } from "./form.js";
import type { HTMLInputElement } from "./input.js";
import { isHtmlTag } from "../html-tag.js";

type SubmissionFile = File & { __ksBits?: string };
type SubmissionEntry = [name: string, value: string | SubmissionFile];

function appendInputEntries(
  entries: SubmissionEntry[],
  name: string,
  input: HTMLInputElement,
  submitter: unknown,
  encoding: string,
) {
  const type = inputTypeOf(input);
  if (type === "checkbox" || type === "radio") {
    if (input.checked) entries.push([name, input.value]);
  } else if (type === "submit" || type === "image" || type === "reset" || type === "button") {
    if (input === submitter) entries.push([name, input.value]);
  } else if (type === "hidden" && name.toLowerCase() === "_charset_") {
    entries.push([name, encoding]);
  } else if (type === "file") {
    const files = fileInputFiles.get(input._id) || [];
    if (files.length === 0) entries.push([name, new ksGlobal.File([], "")]);
    else for (const file of files) entries.push([name, file]);
  } else {
    entries.push([name, input.value]);
  }
}

function collectFormEntries(
  form: HTMLFormElement,
  submitter: unknown,
  encoding: string,
): SubmissionEntry[] {
  const entries: SubmissionEntry[] = [];
  // The form behind the proxy: a control named "elements" must not hide the controls.
  const els = formBehindProxy(form).elements;
  for (let i = 0; i < els.length; i++) {
    const el: unknown = els[i];
    if (
      !isHtmlTag(el, "input") &&
      !isHtmlTag(el, "textarea") &&
      !isHtmlTag(el, "select") &&
      !isHtmlTag(el, "button")
    )
      continue;
    const name = el.getAttribute("name");
    if (typeof name !== "string" || !name || isDisabledInFormContext(el)) continue;
    if (isHtmlTag(el, "input")) {
      appendInputEntries(entries, name, el, submitter, encoding);
      continue;
    } else if (isHtmlTag(el, "textarea")) {
      entries.push([name, el.value]);
    } else if (isHtmlTag(el, "select")) {
      for (const o of selectedOptionsOf(el)) {
        if (!isOptionEffectivelyDisabled(o)) entries.push([name, o.value]);
      }
    } else if (isHtmlTag(el, "button")) {
      if (el === submitter) entries.push([name, el.value]);
    }
  }
  return entries;
}

const isFileEntry = (v: unknown): v is SubmissionFile =>
  typeof v === "object" &&
  v !== null &&
  "name" in v &&
  typeof v.name === "string" &&
  "size" in v &&
  typeof v.size === "number" &&
  "arrayBuffer" in v &&
  typeof v.arrayBuffer === "function";
function multipartEscape(s: unknown) {
  return String(s).replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
}
function sanitizeMimeType(t: unknown) {
  const s = String(t || "").replace(
    /[^\x21\x23-\x27\x2A\x2B\x2D-\x2E\x30-\x39\x41-\x5A\x5E-\x7E\/=; \t]/g,
    "",
  );
  return s || "application/octet-stream";
}
const _KsGetRandomValues = (() => {
  // Capture the page-mutable crypto method before page code can replace it.
  const c = ksGlobal.crypto;
  const fn = c && c.getRandomValues;
  return fn ? fn.bind(c) : null;
})();
function generateMultipartBoundary() {
  const bytes = new Uint8Array(18);
  if (_KsGetRandomValues) _KsGetRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return "----kitesurfFormBoundary" + hex;
}
// Capture TextEncoder before page code can replace the global constructor.
const _MPEncoder = new ksGlobal.TextEncoder();
function encodeFormBody(
  enctype: string,
  entries: readonly SubmissionEntry[],
  encoding: string,
): { body: string; contentType: string } {
  // The parent decodes this JSON string one code unit at a time to recover request bytes.
  const toLatin1Wire = (s: string): string =>
    binaryString(encodeHtmlBytes(encoding, s) ?? _MPEncoder.encode(s));
  if (enctype === "text/plain") {
    let body = "";
    for (const [n, v] of entries) {
      body += toLatin1Wire(`${n}=${isFileEntry(v) ? v.name : v}\r\n`);
    }
    return { body, contentType: "text/plain" };
  }
  if (enctype === "multipart/form-data") {
    const boundary = generateMultipartBoundary();
    let body = "";
    for (const [n, v] of entries) {
      if (isFileEntry(v)) {
        const bits = typeof v.__ksBits === "string" ? v.__ksBits : "";
        body += toLatin1Wire(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${multipartEscape(n)}"; filename="${multipartEscape(v.name)}"\r\n` +
            `Content-Type: ${sanitizeMimeType(v.type)}\r\n\r\n`,
        );
        body += bits;
        body += toLatin1Wire("\r\n");
      } else {
        body += toLatin1Wire(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${multipartEscape(n)}"\r\n\r\n` +
            `${v}\r\n`,
        );
      }
    }
    body += toLatin1Wire(`--${boundary}--\r\n`);
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
  }
  return {
    body: urlencodedSerialize(formStringEntries(entries), encoding),
    contentType: "application/x-www-form-urlencoded",
  };
}

function formStringEntries(entries: readonly SubmissionEntry[]): Array<[string, string]> {
  return entries.map(([n, v]) => [n, isFileEntry(v) ? v.name : v]);
}

function formEncoding(form: HTMLFormElement): string {
  const accept = elementAttributes.get.call(form, "accept-charset");
  if (accept) {
    for (const token of accept.split(/[\t\n\f\r ]+/)) {
      if (!token) continue;
      const encoding = encodingForLabel(token);
      if (encoding) return outputEncoding(encoding);
    }
  }
  return outputEncoding(characterSetOf(form));
}

function namedTargetIframe(form: HTMLFormElement, name: string): Element | null {
  const doc = elementDocument(form);
  if (typeof doc.getElementsByTagName !== "function") return null;
  const frames = doc.getElementsByTagName("iframe");
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame && frame.getAttribute("name") === name) return frame;
  }
  return null;
}

export { collectFormEntries, encodeFormBody, formEncoding, formStringEntries, namedTargetIframe };
