// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import { createTypeScriptContracts } from "./rules/typescript-contracts.ts";
import { noUnnecessaryUnknownRule } from "./rules/no-unnecessary-unknown.ts";

type RuleName =
  | "explicit-boundary-returns"
  | "no-chained-type-assertions"
  | "no-unnecessary-unknown"
  | "no-widen-then-assert";
type FixtureExtension = "ts" | "mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "kitesurf-lint-rules-"));
const configPath = join(temporaryDirectory, "oxlint.config.json");
const tsconfigPath = join(temporaryDirectory, "tsconfig.json");
const oxlintPath = resolve(repositoryRoot, "node_modules/oxlint/bin/oxlint");
const pluginPath = resolve(repositoryRoot, "scripts/lint/index.ts");
let fixtureNumber = 0;

await writeFile(
  configPath,
  JSON.stringify({
    jsPlugins: [{ name: "kitesurf", specifier: pluginPath }],
    rules: {
      "kitesurf/explicit-boundary-returns": "error",
      "kitesurf/no-chained-type-assertions": "error",
      "kitesurf/no-unnecessary-unknown": "error",
      "kitesurf/no-widen-then-assert": "error",
    },
  }),
);
await writeFile(
  tsconfigPath,
  JSON.stringify({
    compilerOptions: {
      exactOptionalPropertyTypes: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: "ES2023",
      types: [],
    },
    include: ["*.ts"],
  }),
);

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function lint(source: string, extension: FixtureExtension = "ts"): Promise<string> {
  const sourcePath = join(temporaryDirectory, `fixture-${fixtureNumber}.${extension}`);
  fixtureNumber += 1;
  await writeFile(sourcePath, source);

  const result = spawnSync(
    process.execPath,
    [oxlintPath, "--config", configPath, "--format=json", "--threads=1", sourcePath],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return `${result.stdout}\n${result.stderr}`;
}

function countRuleReports(output: string, ruleName: RuleName): number {
  return output.split(`kitesurf(${ruleName})`).length - 1;
}

const noUnnecessaryUnknownTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

noUnnecessaryUnknownTester.run("kitesurf/no-unnecessary-unknown", noUnnecessaryUnknownRule, {
  valid: [
    "declare const input: unknown; const forwarded: unknown = input;",
    "type Maybe = string | unknown; declare const input: Maybe; const value: Maybe = input;",
    "declare const input: unknown; const value: string | unknown = input;",
    "const refined: unknown & { id: number } = { id: 1 }; const value: unknown = refined;",
    "type UnknownValue = unknown; const value: UnknownValue = 1;",
    "const source = { id: 1 }; const record: Record<string, unknown> = source; const object: object = source;",
    "const values: unknown[] = [];",
    "declare const request: { json(): Promise<unknown> }; async function read() { const body: unknown = await request.json(); }",
    "declare const event: { data: unknown }; const message: unknown = event.data;",
    "declare const req: { params?: { cookies?: unknown[] } }; const params: unknown = req.params?.cookies;",
    'declare const target: object; const reflected: unknown = Reflect.get(target, "value");',
    "declare const wasm: { read(): unknown }; const result: unknown = wasm.read();",
    'const dynamic: unknown = new Function("return 1");',
    'declare const EventConstructor: new (type: string) => object; const event: unknown = new EventConstructor("x");',
    "let mutable: unknown = null; mutable = { value: 1 };",
    "let mutable: unknown = null as unknown;",
    "let mutable: unknown; mutable = 1 as unknown;",
    "function parameterDefault(value: unknown = 1 as unknown): void {}",
    'function isString(value: unknown): value is string { return true; } isString("known");',
    "function dynamicResult(): unknown { return 1; }",
    "function dynamicAssertion(): unknown { return 1 as unknown; }",
    "const published: unknown = 1; export { published }; export const directPublic: unknown = 2;",
    "const publicAssertion = [1] as unknown; export { publicAssertion };",
    `const first = second; const second = first; const cycle: unknown = first;`,
    `const value = 1; function shadow(value: unknown) { const kept: unknown = value; }`,
    "const known = 1; const chained = (known as unknown) as number;",
  ],
  invalid: [
    {
      code: "const value: unknown = 1;",
      errors: [{ messageId: "widening", line: 1 }],
    },
    {
      code: "const value: unknown = -1;",
      errors: [{ messageId: "widening", line: 1 }],
    },
    {
      code: "const value: unknown = { id: 1 };",
      errors: [{ messageId: "widening", line: 1 }],
    },
    {
      code: "const value: unknown = [1];",
      errors: [{ messageId: "widening", line: 1 }],
    },
    {
      code: "const source = { id: 1 };\nconst alias = source;\nconst value: unknown = alias;",
      errors: [{ messageId: "widening", line: 3 }],
    },
    {
      code: "const source = 1;\nconst value = source as unknown;",
      errors: [{ messageId: "assertion", line: 2 }],
    },
    {
      code: "const value = <unknown>[1];",
      errors: [{ messageId: "assertion", line: 1 }],
    },
  ],
});

test("chained assertions reject erasure while preserving boundary, reflection, and const cases", async () => {
  const output = await lint(`
type Shape = { id: number };
const chained = ({ id: 1 } as unknown) as Shape;
const angle = <Shape>(<unknown>{ id: 1 });
declare const input: unknown;
const parsed = input as Shape;
declare const target: object;
const reflected = Reflect.get(target, "value") as Shape;
const literal = ({ state: "ready" } as const) as const;
`);

  assert.equal(countRuleReports(output, "no-chained-type-assertions"), 2, output);
});

test("widen-then-assert only reports known immutable values in the same lexical boundary", async () => {
  const output = await lint(`
type Shape = { id: number };
const erased: unknown = { id: 1 };
const restored = erased as Shape;
declare const input: unknown;
const parsed = input as Shape;
const reflected: unknown = Reflect.get(globalThis, "candidate");
const fromReflection = reflected as Shape;
const known: unknown = 1;
function nested() {
  return known as number;
}
const literal = { state: "ready" } as const;
`);

  assert.equal(countRuleReports(output, "no-widen-then-assert"), 1, output);
});

test("no-unnecessary-unknown runs through the Oxlint CLI without widening boundaries", async () => {
  const output = await lint(`const source = [1];
const alias = source;
const erased: unknown = alias;
const requestValue: unknown = JSON.parse("[]");
const reflected: unknown = Reflect.get(globalThis, "value");
const dynamic: unknown = new Function("return 1");
declare const EventConstructor: new (type: string) => object;
const event: unknown = new EventConstructor("x");
let mutable: unknown = null;
mutable = requestValue;
let assertedMutable: unknown;
assertedMutable = 1 as unknown;
function shadowed(source: unknown) { const kept: unknown = source; }
`);

  assert.equal(countRuleReports(output, "no-unnecessary-unknown"), 1, output);
});

test("return contracts match exported and public boundaries without recursing into callbacks", async () => {
  await writeFile(
    join(temporaryDirectory, "external-api.ts"),
    `export namespace ExternalApi {
  export interface Surface {
    run(): string;
    get value(): number;
  }
}`,
  );
  const output = await lint(`
import type { ExternalApi } from "./external-api.js";
export function missing() { return 1; }
function exportedLater() { return 2; }
export { exportedLater as publicLater };
export default () => 3;
export const arrow = (value: string) => value;
export const functionExpression = function (value: string) { return value; };
export const typedFunctionExpression: (value: string) => string = function (value) {
  return value;
};
type Handler = (value: string) => number;
export const typedArrow: Handler = (value) => value.length;
export const typedCall: { (value: string): number } = (value) => value.length;
export function overloaded(value: string): string;
export function overloaded(value: unknown) { return String(value); }
export function withCallback(callback: (value: string) => void): void {
  [1].map((value) => callback(String(value)));
}
export function explicitAny(): any { return undefined; }
export function explicitUnknown(): unknown { return undefined; }
export function explicitTypeof(): typeof Math { return Math; }
function privateHelper() { return 1; }
class Surface {
  run() {}
  get value() { return 1; }
  private hidden() {}
  protected protectedMethod() {}
  #secret() {}
  constructor() {}
  set config(value: string) {}
  private helper() {}
}
class OverloadedSurface {
  method(value: string): string;
  method(value: unknown) { return String(value); }
}
interface ImplementedApi { run(): number; }
class Implemented implements ImplementedApi { run() { return 1; } }
interface GetterApi { readonly value: number; }
class ImplementedGetter implements GetterApi { get value() { return 1; } }
class ImportedSurface implements ExternalApi.Surface {
  run() { return "ok"; }
  get value() { return 1; }
  uncovered() {}
}
type AnyOwner = any;
class AnyOwnerSurface implements AnyOwner { run() {} }
class BroadOwner implements Record<string, unknown> { run() {} }
class UnresolvedOwner implements MissingOwner { run() {} }
interface EmptyOwner {}
class EmptyOwnerSurface implements EmptyOwner { run() {} }
class BaseSurface { inherited(): void {} }
class DerivedSurface extends BaseSurface { inherited() {} }
class StaticBase { static create(): number { return 1; } }
class StaticDerived extends StaticBase { static create() { return 1; } }
class WebElement extends HTMLElement { click() {} }
type ObjectApi = { run(): number; callback: (value: string) => string };
interface ContextualObjectApi { execute(): number; }
export const api = {
  run() { return 1; },
  callback: (value: string) => value,
  withCallback() { [1].map((value) => value); return 1; },
  nested: { hidden() {} },
};
export const typedApi: ObjectApi = {
  run() { return 1; },
  callback(value) { return value; },
};
export const handlers: {
  onEvent: (listener: (event: string) => void) => void;
} = {
  onEvent(listener) { listener((event) => event.length); },
};
export const contextualApi = {
  execute() { return 1; },
} satisfies ContextualObjectApi;
export const assertedUnknown = { run() {} } as unknown;
export const assertedApi = { run() {} } as { run(): void };
export const assertedCallable = (() => 1) as () => number;
export const satisfiesAny = { run() {} } satisfies any;
export default { direct() { return 1; } };
`);

  assert.equal(countRuleReports(output, "explicit-boundary-returns"), 18, output);
});

test("default function declarations require a return contract", async () => {
  const output = await lint("export default function namedDefault() { return 1; }");

  assert.equal(countRuleReports(output, "explicit-boundary-returns"), 1, output);
});

test("JavaScript return contracts accept typed JSDoc return and callable tags", async () => {
  const output = await lint(
    `
/** @returns {number} */
export function documented() { return 1; }
export function missing() { return 2; }
/** @return {number} */
export const documentedArrow = () => 3;
/** @type {() => number} */
export const typedArrow = () => 4;
export const missingArrow = () => 5;
export const methods = {
  /** @returns {string} */
  documentedMethod() { return "ok"; },
  missingMethod() { return "no"; },
};
`,
    "mjs",
  );

  assert.equal(countRuleReports(output, "explicit-boundary-returns"), 3, output);
});

test("JSDoc parsing accepts inline tags and complex types but rejects unbalanced types", async () => {
  const output = await lint(
    `
/** @param {string[]} extensions @returns {string[]} */
export function sourceFiles(extensions) { return extensions; }
/** @returns {Promise<{ surface: import("./external-api.js").ExternalApi.Surface }>} */
export function complexReturn() { return Promise.resolve({ surface: null }); }
/** @returns {Promise<{ surface: string }> */
export function malformedReturn() { return Promise.resolve({ surface: "bad" }); }
`,
    "mjs",
  );

  assert.equal(countRuleReports(output, "explicit-boundary-returns"), 1, output);
});

test("TypeScript source overrides invalidate the same-filename owner lookup", () => {
  const filename = join(temporaryDirectory, "virtual-owner.ts");
  const original = `interface Owner { run(): void; }
class Subject implements Owner { run() {} }
`;
  const changed = `interface Owner {}
class Subject implements Owner { run() {} }
`;
  const originalStart = original.indexOf("run() {}");
  const changedStart = changed.indexOf("run() {}");
  const originalContracts = createTypeScriptContracts(filename, repositoryRoot, original);
  assert.ok(originalContracts);
  assert.equal(originalContracts.hasClassMember(originalStart, "run", "method", false), true);

  const changedContracts = createTypeScriptContracts(filename, repositoryRoot, changed);
  assert.ok(changedContracts);
  assert.equal(changedContracts.hasClassMember(changedStart, "run", "method", false), false);
});
