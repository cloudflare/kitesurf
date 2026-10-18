// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

const NUMERIC = new Set([
  "byte",
  "octet",
  "short",
  "unsigned short",
  "long",
  "unsigned long",
  "long long",
  "unsigned long long",
  "float",
  "unrestricted float",
  "double",
  "unrestricted double",
]);
const STRING = new Set(["DOMString", "USVString", "ByteString", "CSSOMString"]);
const RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "arguments",
  "eval",
  "interface",
  "implements",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "await",
]);

function key(name) {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function exposedOnWindow(node) {
  const exposed = (node.extAttrs || []).find((attr) => attr.name === "Exposed");
  if (!exposed?.rhs) return true;
  if (exposed.rhs.type === "*") return true;
  const names = Array.isArray(exposed.rhs.value)
    ? exposed.rhs.value.map((v) => v.value)
    : [exposed.rhs.value];
  return names.includes("Window");
}

// Gap maps record missing members, type differences, and parent overrides from the ledger.
/** @returns {string} */
export function renderTypes(
  definitionLists,
  gaps = { missing: new Map(), omit: new Map(), parent: new Map() },
) {
  const interfaces = new Map();
  const mixins = new Map();
  const dictionaries = new Map();
  const enums = new Map();
  const typedefs = new Map();
  const callbacks = new Map();
  const callbackInterfaces = new Map();
  const includes = [];

  const bucketFor = (map, name, init) => {
    if (!map.has(name)) map.set(name, init());
    return map.get(name);
  };
  for (const definitions of definitionLists) {
    for (const definition of definitions) {
      switch (definition.type) {
        case "interface": {
          const entry = bucketFor(interfaces, definition.name, () => ({
            parent: null,
            members: [],
          }));
          if (!definition.partial) entry.parent = definition.inheritance || null;
          entry.members.push(...definition.members.filter(exposedOnWindow));
          break;
        }
        case "interface mixin":
          bucketFor(mixins, definition.name, () => []).push(
            ...definition.members.filter(exposedOnWindow),
          );
          break;
        case "callback interface":
          callbackInterfaces.set(definition.name, definition);
          break;
        case "dictionary": {
          const entry = bucketFor(dictionaries, definition.name, () => ({
            parent: null,
            members: [],
          }));
          if (!definition.partial) entry.parent = definition.inheritance || null;
          entry.members.push(...definition.members);
          break;
        }
        case "enum":
          enums.set(
            definition.name,
            definition.values.map((value) => value.value),
          );
          break;
        case "typedef":
          typedefs.set(definition.name, definition.idlType);
          break;
        case "callback":
          callbacks.set(definition.name, definition);
          break;
        case "includes":
          includes.push(definition);
          break;
        default:
          break;
      }
    }
  }
  for (const statement of includes) {
    const target = interfaces.get(statement.target);
    const members = mixins.get(statement.includes);
    if (target && members) target.members.push(...members);
  }

  // Names outside selected IDLs stay unknown; the generator does not infer external shapes.
  const known = new Set([
    ...interfaces.keys(),
    ...dictionaries.keys(),
    ...enums.keys(),
    ...typedefs.keys(),
    ...callbacks.keys(),
    ...callbackInterfaces.keys(),
  ]);

  function type(idlType) {
    let out;
    if (idlType.union) {
      out = idlType.idlType.map(type).join(" | ");
      if (idlType.nullable) out = `(${out})`;
    } else if (idlType.generic) {
      const args = idlType.idlType.map(type);
      switch (idlType.generic) {
        case "Promise":
          out = `Promise<${args[0] === "undefined" ? "void" : args[0]}>`;
          break;
        case "sequence":
        case "ObservableArray":
          out = `Array<${args[0]}>`;
          break;
        case "FrozenArray":
          out = `ReadonlyArray<${args[0]}>`;
          break;
        case "record":
          out = `Record<string, ${args[1]}>`;
          break;
        default:
          out = "unknown";
      }
    } else {
      const name = idlType.idlType;
      if (STRING.has(name)) out = "string";
      else if (NUMERIC.has(name)) out = "number";
      else if (name === "boolean") out = "boolean";
      else if (name === "bigint") out = "bigint";
      else if (name === "any") out = "any";
      else if (name === "object") out = "object";
      else if (name === "undefined") out = "undefined";
      else if (known.has(name)) out = name;
      else out = "unknown";
    }
    return idlType.nullable ? `${out} | null` : out;
  }

  function params(args) {
    return args
      .map((arg) => {
        const name = RESERVED.has(arg.name) ? `${arg.name}_` : arg.name;
        if (arg.variadic) return `...${name}: Array<${type(arg.idlType)}>`;
        return `${name}${arg.optional ? "?" : ""}: ${type(arg.idlType)}`;
      })
      .join(", ");
  }

  function returnType(idlType) {
    const out = type(idlType);
    return out === "undefined" ? "void" : out;
  }

  // missing: Set of ledger gaps; typeGaps: the type gaps, keyed by member.
  function interfaceBody(members, missing, typeGaps) {
    const lines = [];
    const push = (name, declaration) => {
      lines.push(
        missing.has(name) || typeGaps.has(name) ? `  // ${declaration}` : `  ${declaration}`,
      );
    };
    for (const member of members) {
      switch (member.type) {
        case "const":
          break;
        case "attribute":
          if (member.special === "static") break;
          push(
            member.name,
            `${member.readonly ? "readonly " : ""}${key(member.name)}: ${type(member.idlType)};`,
          );
          if (member.special === "stringifier") push(member.name, "toString(): string;");
          break;
        case "operation":
          if (member.special === "static") break;
          if (
            member.special === "getter" &&
            member.arguments[0]?.idlType.idlType === "unsigned long"
          ) {
            push("[index]", `readonly [index: number]: ${returnType(member.idlType)};`);
          }
          if (member.name) {
            push(
              member.name,
              `${key(member.name)}(${params(member.arguments)}): ${returnType(member.idlType)};`,
            );
          } else if (member.special === "stringifier") {
            push("toString", "toString(): string;");
          }
          break;
        case "iterable": {
          const value =
            member.idlType.length === 2
              ? `[${type(member.idlType[0])}, ${type(member.idlType[1])}]`
              : type(member.idlType[0]);
          if (member.async) {
            push(
              "[Symbol.asyncIterator]",
              `[Symbol.asyncIterator](): AsyncIterableIterator<${value}>;`,
            );
          } else {
            push("[Symbol.iterator]", `[Symbol.iterator](): IterableIterator<${value}>;`);
          }
          break;
        }
        default:
          break;
      }
    }
    return lines;
  }

  const memberNames = (members) =>
    new Set(
      members
        .filter((member) => member.special !== "static")
        .map((member) =>
          member.type === "operation" && !member.name && member.special === "stringifier"
            ? "toString"
            : member.name,
        )
        .filter(Boolean),
    );
  function inheritedNames(name, seen = new Set()) {
    const entry = interfaces.get(name);
    if (!entry || seen.has(name)) return new Set();
    seen.add(name);
    const names = memberNames(entry.members);
    const parentName = effectiveParent(name, entry);
    if (parentName) for (const inherited of inheritedNames(parentName, seen)) names.add(inherited);
    return names;
  }
  function effectiveParent(name, entry) {
    const override = gaps.parent.get(name);
    return override ? override.name : entry.parent;
  }

  // Validate type gaps; the TS mapper doesn't render every runtime ledger gap.
  for (const [name, omitted] of gaps.omit) {
    const entry = interfaces.get(name);
    if (!entry) throw new Error(`type gap for unknown interface ${name}`);
    const declared = memberNames(entry.members);
    for (const member of entry.members) {
      if (member.type === "iterable")
        declared.add(member.async ? "[Symbol.asyncIterator]" : "[Symbol.iterator]");
      if (member.special === "getter" && member.arguments[0]?.idlType.idlType === "unsigned long")
        declared.add("[index]");
    }
    const parentName = effectiveParent(name, entry);
    const inherited = parentName ? inheritedNames(parentName) : new Set();
    for (const member of omitted.keys()) {
      if (!declared.has(member) && !inherited.has(member)) {
        throw new Error(`type gap ${name}.${member}: no such member`);
      }
    }
  }

  const out = [];
  const sorted = (map) => [...map.keys()].sort();
  for (const name of sorted(interfaces)) {
    const entry = interfaces.get(name);
    const typeGaps = gaps.omit.get(name) ?? new Map();
    const missing = gaps.missing.get(name) ?? new Set();
    const parentGap = gaps.parent.get(name);
    const parentName = effectiveParent(name, entry);
    let parent = "";
    let inheritedOmissionNotes = [];
    if (parentName && interfaces.has(parentName)) {
      const inherited = inheritedNames(parentName);
      const ownMembers = memberNames(entry.members);
      const redeclared = [...ownMembers].filter((member) => inherited.has(member)).sort();
      const inheritedOmissions = [...typeGaps].filter(
        ([member]) => !ownMembers.has(member) && inherited.has(member),
      );
      const omittedFromParent = [
        ...new Set([...redeclared, ...inheritedOmissions.map(([member]) => member)]),
      ].sort();
      inheritedOmissionNotes = inheritedOmissions.flatMap(([member, reason]) => [
        `  // Omitted inherited member ${member}.`,
        `  // Reason: ${reason}`,
      ]);
      // Omit inherited members whose local shape is intentionally different or absent.
      parent = omittedFromParent.length
        ? ` extends Omit<${parentName}, ${omittedFromParent.map((member) => JSON.stringify(member)).join(" | ")}>`
        : ` extends ${parentName}`;
    }
    const notes = parentGap
      ? [`  // Extends ${parentGap.name ?? "nothing"}, not ${entry.parent}: ${parentGap.reason}`]
      : [];
    out.push(
      `export interface ${name}${parent} {`,
      ...notes,
      ...inheritedOmissionNotes,
      ...interfaceBody(entry.members, missing, typeGaps),
      "}",
    );
  }
  for (const name of sorted(dictionaries)) {
    const entry = dictionaries.get(name);
    const parent = entry.parent && dictionaries.has(entry.parent) ? ` extends ${entry.parent}` : "";
    const fields = entry.members.map(
      (field) => `  ${key(field.name)}${field.required ? "" : "?"}: ${type(field.idlType)};`,
    );
    out.push(`export interface ${name}${parent} {`, ...fields, "}");
  }
  for (const name of sorted(enums)) {
    const values = enums.get(name);
    out.push(
      `export type ${name} = ${values.length ? values.map((value) => JSON.stringify(value)).join(" | ") : "never"};`,
    );
  }
  for (const name of sorted(typedefs)) {
    out.push(`export type ${name} = ${type(typedefs.get(name))};`);
  }
  for (const name of sorted(callbacks)) {
    const callback = callbacks.get(name);
    out.push(
      `export type ${name} = (${params(callback.arguments)}) => ${returnType(callback.idlType)};`,
    );
  }
  for (const name of sorted(callbackInterfaces)) {
    const definition = callbackInterfaces.get(name);
    const operation = definition.members.find((member) => member.type === "operation");
    const signature = `(${params(operation.arguments)}) => ${returnType(operation.idlType)}`;
    out.push(`export type ${name} = (${signature}) | { ${operation.name}: ${signature} };`);
  }
  return `${out.join("\n")}\n`;
}
