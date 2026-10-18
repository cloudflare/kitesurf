// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { WEBIDL_MODEL } from "./model.generated.js";

export interface WebIdlMemberFlags {
  readonly unforgeable?: boolean;
  readonly secureContext?: boolean;
}

export interface WebIdlAttribute extends WebIdlMemberFlags {
  readonly readonly?: boolean;
  readonly putForwards?: string;
  readonly replaceable?: boolean;
  readonly lenientSetter?: boolean;
  readonly lenientThis?: boolean;
}

export interface WebIdlOperation extends WebIdlMemberFlags {
  readonly length: number;
  readonly promise?: boolean;
}

export interface WebIdlInterface {
  readonly name: string;
  readonly parent?: string;
  readonly spec: string;
  readonly callback?: boolean;
  readonly noInterfaceObject?: boolean;
  readonly global?: boolean;
  readonly secureContext?: boolean;
  readonly asyncIterable?: boolean;
  readonly windowAliases?: readonly string[];
  readonly factoryFunctions?: readonly string[];
  readonly constructible: boolean;
  readonly length: number;
  readonly constants?: Readonly<Record<string, number | boolean>>;
  readonly attributes?: Readonly<Record<string, WebIdlAttribute>>;
  readonly operations?: Readonly<Record<string, WebIdlOperation>>;
  readonly staticAttributes?: Readonly<Record<string, WebIdlAttribute>>;
  readonly staticOperations?: Readonly<Record<string, WebIdlOperation>>;
  readonly iterable?: "value" | "pair";
  readonly setlike?: { readonly readonly: boolean };
  readonly maplike?: { readonly readonly: boolean };
}

export interface WebIdlRuntimeInterface {
  readonly length: number;
  readonly parent?: string;
  readonly constants?: Readonly<Record<string, number | boolean>>;
  readonly methodLengths?: Readonly<Record<string, number>>;
  readonly staticMethodLengths?: Readonly<Record<string, number>>;
  readonly promiseOps?: readonly string[];
}

export type WebIdlName = keyof typeof WEBIDL_MODEL;
