// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// @ks-declaration-twin

export interface EditingEngine {
  execCommand(command: string, showUi: boolean, value: string): boolean;
  queryCommandEnabled(command: string): boolean;
  queryCommandIndeterm(command: string): boolean;
  queryCommandState(command: string): boolean;
  queryCommandSupported(command: string): boolean;
  queryCommandValue(command: string): string;
}

export declare function createEditingEngine(
  document: unknown,
  getSelection: () => unknown,
  getComputedStyle: (element: unknown) => unknown,
  Node: Record<string, number>,
): EditingEngine;
