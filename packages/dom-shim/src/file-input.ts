// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stores file-input selections and implements the File, FileList, and DataTransfer wrappers.

// Multipart encoding is synchronous, so wrapped Files snapshot readable parts at construction.
// Opaque Blobs submit an empty body but keep their name and type.

import type * as Idl from "./idl/types.generated.js";
import { ksGlobal } from "./state.js";
import { finalizeInterface, idlInterfaceMeta } from "./webidl.js";

export const fileInputFiles: Map<number, File[]> = new Map();

const FILELIST_GUARD = Symbol("kitesurf-filelist-guard");

// FileList is a FileAPI interface, which the pinned IDL model leaves out.
export class KsFileList {
  declare readonly length: number;
  // The constructor stores the files as own index properties.
  readonly [index: number]: File;
  constructor(guard: symbol, files: File[]) {
    if (guard !== FILELIST_GUARD) {
      throw new TypeError("Illegal constructor");
    }
    Object.assign(this, files);
    Object.defineProperty(this, "length", {
      value: files.length,
      writable: false,
      enumerable: false,
    });
  }
  item(index: number): File | null {
    const i = Number(index) >>> 0;
    return i < this.length ? this[i] : null;
  }
  [Symbol.iterator](): Iterator<File, undefined> {
    let i = 0;
    return {
      next: () =>
        i < this.length ? { value: this[i++], done: false } : { value: undefined, done: true },
    };
  }
  get [Symbol.toStringTag](): string {
    return "FileList";
  }
}

function makeFileList(files: File[]): KsFileList {
  return new KsFileList(FILELIST_GUARD, files.slice());
}

// input.files returns the same FileList until the selection changes.
// setInputFiles always installs a fresh array, so caching per array
// tracks selection changes.
const listCache: WeakMap<File[], KsFileList> = new WeakMap();

export function fileListFor(files: File[]): KsFileList {
  let list = listCache.get(files);
  if (!list) {
    list = makeFileList(files);
    listCache.set(files, list);
  }
  return list;
}

export function getInputFiles(nodeId: number): File[] {
  let arr = fileInputFiles.get(nodeId);
  if (!arr) {
    arr = [];
    fileInputFiles.set(nodeId, arr);
  }
  return arr;
}

export function setInputFiles(nodeId: number, files: File[]): void {
  fileInputFiles.set(nodeId, files.slice());
  fileInputLists.delete(nodeId);
}

// `input.files = list` keeps the list's identity (WPT files.html: "FileList
// should not be copied"). The parallel array feeds the submission encoders.
export const fileInputLists = new Map<number, KsFileList>();

export function setInputFileList(nodeId: number, list: KsFileList): void {
  const files: File[] = [];
  for (let i = 0; i < list.length; i++) files.push(list[i]);
  fileInputFiles.set(nodeId, files);
  fileInputLists.set(nodeId, list);
}

export function isKsFileList(v: unknown): v is KsFileList {
  return v instanceof KsFileList;
}

// Capture File and TextEncoder before page code can replace the globals.
// The wrapper below keeps File's prototype chain, so native methods work.
const NativeFile: typeof File = ksGlobal.File;
const encoder: TextEncoder = new ksGlobal.TextEncoder();

type BlobParts = ConstructorParameters<typeof Blob>[0];

// Blob parts cross the page boundary as values with a dynamic iterator.
const isIterable = (v: unknown): v is Iterable<unknown> =>
  v != null && typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";

// Returns the parts as a Latin-1 binary string, or null when a part is an
// opaque Blob whose content can only be read asynchronously. Every code
// unit must be at most 0xFF because the parent decodes the string byte by
// byte, so string parts go through UTF-8 first.
function snapshotBits(bits: unknown): string | null {
  if (!isIterable(bits)) return "";
  let out = "";
  for (const part of bits) {
    const snapshot = snapshotPart(part);
    if (snapshot === null) return null;
    out += snapshot;
  }
  return out;
}

function snapshotPart(part: unknown): string | null {
  if (typeof part === "string") return binaryString(encoder.encode(part));
  if (part instanceof ArrayBuffer) return binaryString(new Uint8Array(part));
  return snapshotViewOrNestedPart(part);
}

function snapshotViewOrNestedPart(part: unknown): string | null {
  if (ArrayBuffer.isView(part)) {
    return binaryString(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
  }
  // Wrapped KsFile instances carry their synchronous snapshot under this key.
  const nested = part ? (part as { __ksBits?: unknown }).__ksBits : undefined;
  return typeof nested === "string" ? nested : null;
}

const BINARY_STRING_CHUNK = 32 * 1024;
// Reflect.apply takes the typed array as an array-like of char codes.
export function binaryString(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += BINARY_STRING_CHUNK) {
    s += Reflect.apply(String.fromCharCode, null, u8.subarray(i, i + BINARY_STRING_CHUNK));
  }
  return s;
}

// jsg checks blob parts with V8 IsArray(), which does not unwrap Boa's
// lazy array proxies. Materialize them before passing them to jsg.
function materializeParts(bits: BlobParts): BlobParts {
  return Array.isArray(bits) ? Array.from(bits) : bits;
}

export class KsFile extends NativeFile {
  declare readonly __ksBits: string | null;
  // A File minted by the runtime itself must still pass `instanceof File`
  // in page code.
  static [Symbol.hasInstance](v: unknown): boolean {
    return v instanceof NativeFile;
  }
  constructor(bits: BlobParts, name: string, options?: ConstructorParameters<typeof File>[2]) {
    bits = materializeParts(bits);
    super(bits, name, options);
    // null: the content is not readable synchronously.
    Object.defineProperty(this, "__ksBits", {
      value: snapshotBits(bits),
      writable: false,
      enumerable: false,
      configurable: true,
    });
  }
}

// A minimal DataTransfer for the `input.files = dt.files` pattern
// (drag-and-drop and paste polyfills, WPT file-upload tests).
// DataTransferItem and DataTransferItemList have no IDL constructor; only
// this module, which holds the token, makes them.
const DATA_TRANSFER_TOKEN = Symbol("kitesurf-data-transfer");

class KsDataTransferItem implements Idl.DataTransferItem {
  readonly #type: string;
  readonly #data: string | File;
  constructor(token: symbol, type: string, data: string | File) {
    if (token !== DATA_TRANSFER_TOKEN) throw new TypeError("Illegal constructor");
    this.#type = type;
    this.#data = data;
  }
  get kind() {
    return typeof this.#data === "string" ? "string" : "file";
  }
  get type() {
    return this.#type;
  }
  getAsFile() {
    return typeof this.#data === "string" ? null : this.#data;
  }
  getAsString(callback: Idl.FunctionStringCallback | null) {
    const data = this.#data;
    if (typeof data === "string" && typeof callback === "function") {
      queueMicrotask(() => callback(data));
    }
  }
}

// Items are only reachable by iteration (idl/type-gaps.json).
class KsDataTransferItemList implements Idl.DataTransferItemList {
  readonly #items: KsDataTransferItem[] = [];
  constructor(token: symbol) {
    if (token !== DATA_TRANSFER_TOKEN) throw new TypeError("Illegal constructor");
  }
  get length() {
    return this.#items.length;
  }
  // The IDL overloads by argument count: add(data, type) adds a string,
  // add(file) a File, and anything else fails the conversion to File.
  add(...args: unknown[]): KsDataTransferItem {
    const [data, type] = args;
    let item: KsDataTransferItem;
    if (args.length >= 2) {
      item = new KsDataTransferItem(DATA_TRANSFER_TOKEN, String(type), String(data));
    } else if (data instanceof NativeFile) {
      item = new KsDataTransferItem(DATA_TRANSFER_TOKEN, data.type, data);
    } else {
      throw new TypeError(
        "Failed to execute 'add' on 'DataTransferItemList': parameter 1 is not of type 'File'.",
      );
    }
    this.#items.push(item);
    return item;
  }
  remove(index: number) {
    const i = Number(index) | 0;
    if (i >= 0 && i < this.#items.length) this.#items.splice(i, 1);
  }
  clear() {
    this.#items.length = 0;
  }
  [Symbol.iterator](): IterableIterator<KsDataTransferItem> {
    return this.#items[Symbol.iterator]();
  }
}

export class KsDataTransfer implements Idl.DataTransfer {
  readonly #items = new KsDataTransferItemList(DATA_TRANSFER_TOKEN);
  readonly #data = new Map<string, string>();
  #filesCache: KsFileList | undefined;
  // The setters neither convert nor check the value; the spec ignores
  // values that are not one of the effect keywords.
  #dropEffect = "none";
  #effectAllowed = "uninitialized";
  get items() {
    return this.#items;
  }
  get dropEffect() {
    return this.#dropEffect;
  }
  set dropEffect(v: string) {
    this.#dropEffect = v;
  }
  get effectAllowed() {
    return this.#effectAllowed;
  }
  set effectAllowed(v: string) {
    this.#effectAllowed = v;
  }
  get files(): KsFileList {
    const files = collectFiles(this.#items);
    // WPT files.html reads dt.files more than once and assigns it to
    // input.files, so the list keeps its identity while the files match.
    const cached = this.#filesCache;
    if (cached && sameFiles(cached, files)) return cached;
    return (this.#filesCache = makeFileList(files));
  }
  get types(): string[] {
    const types = [...this.#data.keys()];
    for (const item of this.#items) {
      if (item.kind === "file" && !types.includes("Files")) types.push("Files");
    }
    return types;
  }
  setData(format: string, data: string) {
    this.#data.set(normalizeFormat(format), String(data));
  }
  getData(format: string) {
    return this.#data.get(normalizeFormat(format)) || "";
  }
  clearData(format?: string) {
    if (format === undefined) this.#data.clear();
    else this.#data.delete(normalizeFormat(format));
  }
  setDragImage(_image: Idl.Element, _x: number, _y: number) {
    /* no drag UI */
  }
}

function collectFiles(items: KsDataTransferItemList): File[] {
  const files: File[] = [];
  for (const item of items) {
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function sameFiles(cached: KsFileList, files: File[]): boolean {
  return cached.length === files.length && files.every((file, index) => cached[index] === file);
}

function normalizeFormat(format: string): string {
  const f = String(format).toLowerCase();
  if (f === "text") return "text/plain";
  if (f === "url") return "text/uri-list";
  return f;
}

finalizeInterface(
  KsDataTransfer,
  idlInterfaceMeta("DataTransfer", { brandOps: true, brandAttrs: true }),
);
finalizeInterface(
  KsDataTransferItem,
  idlInterfaceMeta("DataTransferItem", {
    brandOps: true,
    brandAttrs: true,
  }),
);
finalizeInterface(
  KsDataTransferItemList,
  idlInterfaceMeta("DataTransferItemList", {
    brandOps: true,
    brandAttrs: true,
  }),
);

// The classes keep their Ks prefix in source; the exposed names match the
// platform for feature detection and idlharness.
Object.defineProperty(KsFile, "name", { value: "File" });
Object.defineProperty(KsFileList, "name", { value: "FileList" });

// Materialize bridged parts before calling the native Blob constructor.
// KsBlob reuses NativeBlob.prototype so Blob methods stay visible and
// native blobs keep their prototype identity when passed to the shim.
const NativeBlob: typeof Blob = ksGlobal.Blob;
function KsBlob(
  this: unknown,
  bits?: BlobParts,
  options?: ConstructorParameters<typeof Blob>[1],
): Blob {
  if (!new.target) throw new TypeError("Constructor Blob requires 'new'");
  // The native constructor supplies Blob's runtime brand at this boundary.
  return Reflect.construct(NativeBlob, [materializeParts(bits), options], new.target) as Blob;
}
// Match the native descriptor shapes: idlharness asserts that prototype is
// non-writable and that the interface object's length and name match the IDL.
Object.defineProperty(KsBlob, "prototype", {
  value: NativeBlob.prototype,
  writable: false,
});
Object.defineProperty(KsBlob, "length", { value: NativeBlob.length });
Object.defineProperty(NativeBlob.prototype, "constructor", {
  value: KsBlob,
  writable: true,
  enumerable: false,
  configurable: true,
});
Object.defineProperty(KsBlob, "name", { value: "Blob" });

ksGlobal.FileList = KsFileList;
ksGlobal.DataTransfer = KsDataTransfer;
ksGlobal.DataTransferItem = KsDataTransferItem;
ksGlobal.DataTransferItemList = KsDataTransferItemList;
ksGlobal.File = KsFile;
ksGlobal.Blob = KsBlob;
