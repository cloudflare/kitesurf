// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderTypes } from "./webidl-ts-types.mjs";

function attribute(name) {
  return {
    type: "attribute",
    name,
    readonly: true,
    idlType: { idlType: "DOMString" },
  };
}

function definitions() {
  return [
    [
      {
        type: "interface",
        name: "Node",
        inheritance: null,
        partial: false,
        members: [attribute("baseURI"), attribute("nodeName")],
      },
      {
        type: "interface",
        name: "Attr",
        inheritance: "Node",
        partial: false,
        members: [attribute("name")],
      },
      {
        type: "interface",
        name: "Element",
        inheritance: "Node",
        partial: false,
        members: [],
      },
    ],
  ];
}

function gaps(member, reason) {
  return {
    missing: new Map(),
    omit: new Map([["Attr", new Map([[member, reason]])]]),
    parent: new Map(),
  };
}

test("omits one inherited member without weakening its parent or sibling", () => {
  const reason = "the getter fallback returns null when no base URI is available";
  const output = renderTypes(definitions(), gaps("baseURI", reason));

  assert.ok(
    output.includes(
      "export interface Node {\n  readonly baseURI: string;\n  readonly nodeName: string;\n}",
    ),
  );
  assert.ok(
    output.includes(
      'export interface Attr extends Omit<Node, "baseURI"> {\n' +
        "  // Omitted inherited member baseURI.\n" +
        `  // Reason: ${reason}\n` +
        "  readonly name: string;\n}",
    ),
  );
  assert.ok(output.includes("export interface Element extends Node {\n}"));
});

test("rejects an omission that is neither declared nor inherited", () => {
  assert.throws(() => renderTypes(definitions(), gaps("notAnInheritedMember", "invalid gap")), {
    message: "type gap Attr.notAnInheritedMember: no such member",
  });
});
