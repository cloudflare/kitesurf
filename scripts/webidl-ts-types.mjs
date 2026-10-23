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

function exposedNames(exposed) {
  if (!exposed?.rhs) return ["Window"];
  if (exposed.rhs.type === "*") return ["Window"];
  return Array.isArray(exposed.rhs.value)
    ? exposed.rhs.value.map((value) => value.value)
    : [exposed.rhs.value];
}

function exposedOnWindow(node) {
  const exposed = (node.extAttrs || []).find((attr) => attr.name === "Exposed");
  return exposedNames(exposed).includes("Window");
}

const GENERIC_TYPE_RENDERERS = new Map([
  ["Promise", (args) => `Promise<${args[0] === "undefined" ? "void" : args[0]}>`],
  ["sequence", (args) => `Array<${args[0]}>`],
  ["ObservableArray", (args) => `Array<${args[0]}>`],
  ["FrozenArray", (args) => `ReadonlyArray<${args[0]}>`],
  ["record", (args) => `Record<string, ${args[1]}>`],
]);
const BUILTIN_TYPE_NAMES = new Map([
  ...[...STRING].map((name) => [name, "string"]),
  ...[...NUMERIC].map((name) => [name, "number"]),
  ["boolean", "boolean"],
  ["bigint", "bigint"],
  ["any", "any"],
  ["object", "object"],
  ["undefined", "undefined"],
]);

function genericType(generic, args) {
  const render = GENERIC_TYPE_RENDERERS.get(generic);
  return render ? render(args) : "unknown";
}

function namedType(name, known) {
  const builtin = BUILTIN_TYPE_NAMES.get(name);
  return builtin ?? (known.has(name) ? name : "unknown");
}

function unionType(idlType, recurse) {
  const out = idlType.idlType.map(recurse).join(" | ");
  return idlType.nullable ? `(${out})` : out;
}

function idlTypeValue(idlType, known, recurse) {
  if (idlType.union) return unionType(idlType, recurse);
  if (idlType.generic) return genericType(idlType.generic, idlType.idlType.map(recurse));
  return namedType(idlType.idlType, known);
}

function pushMember(context, name, declaration) {
  const isGap = context.missing.has(name) || context.typeGaps.has(name);
  context.lines.push(isGap ? `  // ${declaration}` : `  ${declaration}`);
}

function renderAttributeMember(member, context) {
  if (member.special === "static") return;
  pushMember(
    context,
    member.name,
    `${member.readonly ? "readonly " : ""}${key(member.name)}: ${context.type(member.idlType)};`,
  );
  if (member.special === "stringifier") pushMember(context, member.name, "toString(): string;");
}

function appendIndexSignature(member, context) {
  if (member.special === "getter" && member.arguments[0]?.idlType.idlType === "unsigned long") {
    pushMember(
      context,
      "[index]",
      `readonly [index: number]: ${context.returnType(member.idlType)};`,
    );
  }
}

function appendNamedOperation(member, context) {
  if (member.name) {
    pushMember(
      context,
      member.name,
      `${key(member.name)}(${context.params(member.arguments)}): ${context.returnType(member.idlType)};`,
    );
  } else if (member.special === "stringifier") {
    pushMember(context, "toString", "toString(): string;");
  }
}

function renderOperationMember(member, context) {
  if (member.special === "static") return;
  appendIndexSignature(member, context);
  appendNamedOperation(member, context);
}

function renderIterableMember(member, context) {
  const value =
    member.idlType.length === 2
      ? `[${context.type(member.idlType[0])}, ${context.type(member.idlType[1])}]`
      : context.type(member.idlType[0]);
  const symbol = member.async ? "[Symbol.asyncIterator]" : "[Symbol.iterator]";
  const iterator = member.async ? "AsyncIterableIterator" : "IterableIterator";
  pushMember(context, symbol, `${symbol}(): ${iterator}<${value}>;`);
}

const INTERFACE_MEMBER_RENDERERS = new Map([
  ["attribute", renderAttributeMember],
  ["operation", renderOperationMember],
  ["iterable", renderIterableMember],
]);

function renderMember(member, context) {
  const render = INTERFACE_MEMBER_RENDERERS.get(member.type);
  if (render) render(member, context);
}

function bucketFor(map, name, init) {
  if (!map.has(name)) map.set(name, init());
  return map.get(name);
}

function collectInterface(definition, buckets) {
  const entry = bucketFor(buckets.interfaces, definition.name, () => ({
    parent: null,
    members: [],
  }));
  if (!definition.partial) entry.parent = definition.inheritance || null;
  entry.members.push(...definition.members.filter(exposedOnWindow));
}

function collectMixin(definition, buckets) {
  bucketFor(buckets.mixins, definition.name, () => []).push(
    ...definition.members.filter(exposedOnWindow),
  );
}

function collectCallbackInterface(definition, buckets) {
  buckets.callbackInterfaces.set(definition.name, definition);
}

function collectDictionary(definition, buckets) {
  const entry = bucketFor(buckets.dictionaries, definition.name, () => ({
    parent: null,
    members: [],
  }));
  if (!definition.partial) entry.parent = definition.inheritance || null;
  entry.members.push(...definition.members);
}

function collectEnum(definition, buckets) {
  buckets.enums.set(
    definition.name,
    definition.values.map((value) => value.value),
  );
}

function collectTypedef(definition, buckets) {
  buckets.typedefs.set(definition.name, definition.idlType);
}

function collectCallback(definition, buckets) {
  buckets.callbacks.set(definition.name, definition);
}

function collectInclude(definition, buckets) {
  buckets.includes.push(definition);
}

const DEFINITION_COLLECTORS = new Map([
  ["interface", collectInterface],
  ["interface mixin", collectMixin],
  ["callback interface", collectCallbackInterface],
  ["dictionary", collectDictionary],
  ["enum", collectEnum],
  ["typedef", collectTypedef],
  ["callback", collectCallback],
  ["includes", collectInclude],
]);

function collectDefinitions(definitionLists) {
  const buckets = {
    interfaces: new Map(),
    mixins: new Map(),
    dictionaries: new Map(),
    enums: new Map(),
    typedefs: new Map(),
    callbacks: new Map(),
    callbackInterfaces: new Map(),
    includes: [],
  };
  for (const definitions of definitionLists) {
    for (const definition of definitions) {
      DEFINITION_COLLECTORS.get(definition.type)?.(definition, buckets);
    }
  }
  return buckets;
}

function applyInclude(interfaces, mixins, statement) {
  const target = interfaces.get(statement.target);
  const members = mixins.get(statement.includes);
  if (target && members) target.members.push(...members);
}

function applyIncludes(buckets) {
  for (const statement of buckets.includes) {
    applyInclude(buckets.interfaces, buckets.mixins, statement);
  }
}

// Gap maps record missing members, type differences, and parent overrides from the ledger.
/** @returns {string} */
export function renderTypes(
  definitionLists,
  gaps = { missing: new Map(), omit: new Map(), parent: new Map() },
) {
  const buckets = collectDefinitions(definitionLists);
  const { interfaces, dictionaries, enums, typedefs, callbacks, callbackInterfaces } = buckets;
  applyIncludes(buckets);

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
    const out = idlTypeValue(idlType, known, type);
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
    const context = { lines, missing, typeGaps, type, params, returnType };
    for (const member of members) renderMember(member, context);
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
  function addInheritedNames(names, parentName, seen) {
    if (!parentName) return names;
    for (const inherited of inheritedNames(parentName, seen)) names.add(inherited);
    return names;
  }

  function inheritedNames(name, seen = new Set()) {
    const entry = interfaces.get(name);
    if (!entry || seen.has(name)) return new Set();
    seen.add(name);
    const names = memberNames(entry.members);
    return addInheritedNames(names, effectiveParent(name, entry), seen);
  }
  function effectiveParent(name, entry) {
    const override = gaps.parent.get(name);
    return override ? override.name : entry.parent;
  }

  // Validate type gaps; the TS mapper doesn't render every runtime ledger gap.
  function addIterableName(declared, member) {
    if (member.type !== "iterable") return;
    declared.add(member.async ? "[Symbol.asyncIterator]" : "[Symbol.iterator]");
  }

  function addGetterName(declared, member) {
    if (member.special === "getter" && member.arguments[0]?.idlType.idlType === "unsigned long") {
      declared.add("[index]");
    }
  }

  function declaredMembers(entry) {
    const declared = memberNames(entry.members);
    for (const member of entry.members) {
      addIterableName(declared, member);
      addGetterName(declared, member);
    }
    return declared;
  }

  function assertOmittedMember(name, member, declared, inherited) {
    if (!declared.has(member) && !inherited.has(member)) {
      throw new Error(`type gap ${name}.${member}: no such member`);
    }
  }

  function validateGap(name, omitted) {
    const entry = interfaces.get(name);
    if (!entry) throw new Error(`type gap for unknown interface ${name}`);
    const declared = declaredMembers(entry);
    const parentName = effectiveParent(name, entry);
    const inherited = parentName ? inheritedNames(parentName) : new Set();
    for (const member of omitted.keys()) assertOmittedMember(name, member, declared, inherited);
  }

  function validateGaps() {
    for (const [name, omitted] of gaps.omit) validateGap(name, omitted);
  }

  validateGaps();

  const sorted = (map) => [...map.keys()].sort();

  function interfaceInheritance(name, entry, typeGaps) {
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
    return { parent, inheritedOmissionNotes };
  }

  function renderInterface(name) {
    const entry = interfaces.get(name);
    const typeGaps = gaps.omit.get(name) ?? new Map();
    const missing = gaps.missing.get(name) ?? new Set();
    const parentGap = gaps.parent.get(name);
    const { parent, inheritedOmissionNotes } = interfaceInheritance(name, entry, typeGaps);
    const notes = parentGap
      ? [`  // Extends ${parentGap.name ?? "nothing"}, not ${entry.parent}: ${parentGap.reason}`]
      : [];
    return [
      `export interface ${name}${parent} {`,
      ...notes,
      ...inheritedOmissionNotes,
      ...interfaceBody(entry.members, missing, typeGaps),
      "}",
    ];
  }

  function renderInterfaces() {
    const out = [];
    for (const name of sorted(interfaces)) out.push(...renderInterface(name));
    return out;
  }

  function renderDictionaries() {
    const out = [];
    for (const name of sorted(dictionaries)) {
      const entry = dictionaries.get(name);
      const parent =
        entry.parent && dictionaries.has(entry.parent) ? ` extends ${entry.parent}` : "";
      const fields = entry.members.map(
        (field) => `  ${key(field.name)}${field.required ? "" : "?"}: ${type(field.idlType)};`,
      );
      out.push(`export interface ${name}${parent} {`, ...fields, "}");
    }
    return out;
  }

  function renderEnums() {
    const out = [];
    for (const name of sorted(enums)) {
      const values = enums.get(name);
      out.push(
        `export type ${name} = ${values.length ? values.map((value) => JSON.stringify(value)).join(" | ") : "never"};`,
      );
    }
    return out;
  }

  function renderTypedefs() {
    return sorted(typedefs).map((name) => `export type ${name} = ${type(typedefs.get(name))};`);
  }

  function renderCallbacks() {
    return sorted(callbacks).map((name) => {
      const callback = callbacks.get(name);
      return `export type ${name} = (${params(callback.arguments)}) => ${returnType(callback.idlType)};`;
    });
  }

  function renderCallbackInterfaces() {
    return sorted(callbackInterfaces).map((name) => {
      const definition = callbackInterfaces.get(name);
      const operation = definition.members.find((member) => member.type === "operation");
      const signature = `(${params(operation.arguments)}) => ${returnType(operation.idlType)}`;
      return `export type ${name} = (${signature}) | { ${operation.name}: ${signature} };`;
    });
  }

  const out = [
    ...renderInterfaces(),
    ...renderDictionaries(),
    ...renderEnums(),
    ...renderTypedefs(),
    ...renderCallbacks(),
    ...renderCallbackInterfaces(),
  ];
  return `${out.join("\n")}\n`;
}
