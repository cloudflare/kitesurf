// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { NodeBase } from "../src/node-base.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

export type InsertBeforeNodeParameters = Assert<
  Equal<Parameters<NodeBase["insertBefore"]>, [NodeBase, NodeBase | null]>
>;
export type InsertBeforeNodeResult = Assert<Equal<ReturnType<NodeBase["insertBefore"]>, NodeBase>>;
