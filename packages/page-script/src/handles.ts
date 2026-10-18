// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stores generation-local CDP object handles and compiled-script entries.

const __handles = new Map<string, unknown>();
let __handleSeq = 0;

export function mintHandle(value: unknown): string {
  const id = "ps:" + ++__handleSeq;
  __handles.set(id, value);
  return id;
}

export function lookupHandle(id: unknown): unknown {
  if (typeof id !== "string") return undefined;
  return __handles.get(id);
}

export function releaseHandle(id: unknown): void {
  if (typeof id === "string") __handles.delete(id);
}

export interface CompiledScript {
  source: string;
  sourceURL: string;
}

const __compiledScripts = new Map<string, CompiledScript>();
let __compiledScriptSeq = 0;

export function compileScriptEntry(source: string, sourceURL: string): string {
  const scriptId = "cs:" + ++__compiledScriptSeq;
  __compiledScripts.set(scriptId, { source, sourceURL });
  return scriptId;
}

export function getCompiledScript(scriptId: unknown): CompiledScript | undefined {
  if (typeof scriptId !== "string") return undefined;
  return __compiledScripts.get(scriptId);
}
