// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { defineRule } from "@oxlint/plugins";
import type { ESTree, Variable } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

function rangeKey(start: number, end: number): string {
  return `${start}:${end}`;
}

function isTypeAssertion(node: ESTree.Node): node is TypeAssertion {
  return node.type === "TSAsExpression" || node.type === "TSTypeAssertion";
}

function unwrapType(type: ESTree.TSType): ESTree.TSType {
  let current = type;
  while (current.type === "TSParenthesizedType") current = current.typeAnnotation;
  return current;
}

function isBareUnknown(type: ESTree.TSType | null | undefined): boolean {
  return type !== null && type !== undefined && unwrapType(type).type === "TSUnknownKeyword";
}

function containsTopLevelAnyOrUnknown(type: ESTree.TSType): boolean {
  const unwrapped = unwrapType(type);
  if (unwrapped.type === "TSAnyKeyword" || unwrapped.type === "TSUnknownKeyword") return true;
  return (
    (unwrapped.type === "TSUnionType" || unwrapped.type === "TSIntersectionType") &&
    unwrapped.types.some(containsTopLevelAnyOrUnknown)
  );
}

function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (true) {
    switch (current.type) {
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSTypeAssertion":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
        current = current.expression;
        break;
      default:
        return current;
    }
  }
}

function hasBroadAssertion(expression: ESTree.Expression): boolean {
  let current = expression;
  while (current.type === "ParenthesizedExpression" || current.type === "TSNonNullExpression") {
    current = current.expression;
  }
  return isTypeAssertion(current) && containsTopLevelAnyOrUnknown(current.typeAnnotation);
}

function hasAssertionParent(node: TypeAssertion): boolean {
  let current: ESTree.Node = node;
  let parent = current.parent;
  while (
    parent !== null &&
    (parent.type === "ParenthesizedExpression" || parent.type === "TSNonNullExpression") &&
    parent.expression === current
  ) {
    current = parent;
    parent = parent.parent;
  }
  return isTypeAssertion(parent) && parent.expression === current;
}

function hasAssertionChild(node: TypeAssertion): boolean {
  let current = node.expression;
  while (current.type === "ParenthesizedExpression" || current.type === "TSNonNullExpression") {
    current = current.expression;
  }
  return isTypeAssertion(current);
}

function hasAssertionChain(expression: ESTree.Expression): boolean {
  let current = expression;
  while (current.type === "ParenthesizedExpression" || current.type === "TSNonNullExpression") {
    current = current.expression;
  }
  return isTypeAssertion(current) && (hasAssertionParent(current) || hasAssertionChild(current));
}

function isReturnExpression(node: ESTree.Node): boolean {
  let current = node;
  let parent = current.parent;
  while (parent !== null) {
    if (parent.type === "ReturnStatement") return true;
    if (
      parent.type === "ArrowFunctionExpression" &&
      parent.body.type !== "BlockStatement" &&
      parent.body === current
    ) {
      return true;
    }
    if (
      parent.type === "ArrowFunctionExpression" ||
      parent.type === "FunctionDeclaration" ||
      parent.type === "FunctionExpression" ||
      parent.type === "TSDeclareFunction" ||
      parent.type === "TSEmptyBodyFunctionExpression"
    ) {
      return false;
    }
    current = parent;
    parent = parent.parent;
  }
  return false;
}

function isParameterDefaultValue(node: ESTree.Node): boolean {
  let current = node;
  let parent = current.parent;
  while (
    parent !== null &&
    (parent.type === "ParenthesizedExpression" || parent.type === "TSNonNullExpression") &&
    parent.expression === current
  ) {
    current = parent;
    parent = parent.parent;
  }
  return parent?.type === "AssignmentPattern" && parent.right === current;
}

function isKnownLiteral(expression: ESTree.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === "UnaryExpression") {
    return unwrapped.operator !== "delete" && isKnownLiteral(unwrapped.argument);
  }
  return (
    unwrapped.type === "Literal" ||
    (unwrapped.type === "TemplateLiteral" && unwrapped.expressions.length === 0)
  );
}

function isKnownObjectOrArray(expression: ESTree.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === "ObjectExpression") {
    return unwrapped.properties.every((property) => property.type !== "SpreadElement");
  }
  return (
    unwrapped.type === "ArrayExpression" &&
    unwrapped.elements.every((element) => element === null || element.type !== "SpreadElement")
  );
}

function variableDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
  if (variable.defs.length !== 1) return null;
  const [definition] = variable.defs;
  return definition?.type === "Variable" && definition.node.type === "VariableDeclarator"
    ? definition.node
    : null;
}

function knownValueEvidence(
  expression: ESTree.Expression,
  variables: ReadonlyMap<string, Variable>,
  visited: ReadonlySet<Variable> = new Set(),
): boolean {
  if (hasBroadAssertion(expression) || hasAssertionChain(expression)) return false;
  if (isKnownLiteral(expression) || isKnownObjectOrArray(expression)) return true;

  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type !== "Identifier") return false;
  const variable = variables.get(rangeKey(unwrapped.start, unwrapped.end));
  if (variable === undefined || visited.has(variable)) return false;

  const declarator = variableDeclarator(variable);
  if (
    declarator === null ||
    declarator.parent.type !== "VariableDeclaration" ||
    declarator.parent.kind !== "const" ||
    declarator.id.type !== "Identifier" ||
    declarator.init === null ||
    variable.references.some((reference) => reference.isWrite() && !reference.init)
  ) {
    return false;
  }

  const annotation = declarator.id.typeAnnotation?.typeAnnotation;
  if (annotation !== null && annotation !== undefined && containsTopLevelAnyOrUnknown(annotation)) {
    return false;
  }
  if (
    annotation !== null &&
    annotation !== undefined &&
    unwrapType(annotation).type === "TSTypeReference"
  ) {
    return false;
  }

  const nextVisited = new Set(visited);
  nextVisited.add(variable);
  return knownValueEvidence(declarator.init, variables, nextVisited);
}

function addExportedVariableNames(
  declaration: ESTree.Declaration | null,
  names: Set<string>,
): void {
  if (declaration?.type !== "VariableDeclaration") return;
  for (const variable of declaration.declarations) {
    if (variable.id.type === "Identifier") names.add(variable.id.name);
  }
}

function addExportSpecifierNames(
  statement: ESTree.ExportNamedDeclaration,
  names: Set<string>,
): void {
  if (statement.exportKind === "type" || statement.source !== null) return;
  for (const specifier of statement.specifiers) {
    if (specifier.exportKind !== "type" && specifier.local.type === "Identifier") {
      names.add(specifier.local.name);
    }
  }
}

function exportedNames(program: ESTree.Program): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "ExportNamedDeclaration") {
      addExportedVariableNames(statement.declaration, names);
      addExportSpecifierNames(statement, names);
    } else if (
      statement.type === "ExportDefaultDeclaration" &&
      statement.declaration.type === "Identifier"
    ) {
      names.add(statement.declaration.name);
    }
  }
  return names;
}

function isExportedModuleBinding(
  declarator: ESTree.VariableDeclarator,
  names: ReadonlySet<string>,
): boolean {
  if (declarator.id.type !== "Identifier" || declarator.parent.type !== "VariableDeclaration") {
    return false;
  }
  const owner = declarator.parent.parent;
  if (owner.type === "ExportNamedDeclaration" || owner.type === "ExportDefaultDeclaration") {
    return true;
  }
  return owner.type === "Program" && names.has(declarator.id.name);
}

function isMutableVariableFlow(
  node: TypeAssertion,
  variables: ReadonlyMap<string, Variable>,
): boolean {
  let current: ESTree.Node = node;
  let parent = current.parent;
  while (
    parent !== null &&
    (parent.type === "ParenthesizedExpression" || parent.type === "TSNonNullExpression") &&
    parent.expression === current
  ) {
    current = parent;
    parent = parent.parent;
  }

  if (parent?.type === "VariableDeclarator" && parent.init === current) {
    return parent.parent.type === "VariableDeclaration" && parent.parent.kind !== "const";
  }
  if (parent?.type !== "AssignmentExpression" || parent.right !== current) return false;
  if (parent.left.type !== "Identifier") return false;

  const variable = variables.get(rangeKey(parent.left.start, parent.left.end));
  const declarator = variable === undefined ? null : variableDeclarator(variable);
  return (
    declarator !== null &&
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind !== "const"
  );
}

function isInsideExportedBinding(node: ESTree.Node, names: ReadonlySet<string>): boolean {
  let current: ESTree.Node | null = node;
  while (current !== null) {
    if (current.type === "VariableDeclarator") {
      return isExportedModuleBinding(current, names);
    }
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "TSDeclareFunction" ||
      current.type === "TSEmptyBodyFunctionExpression"
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

export const noUnnecessaryUnknownRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow bare unknown on local const values with known literal, object, or array evidence.",
    },
    messages: {
      widening:
        'The bare "unknown" type on "{{name}}" discards known local value evidence; keep the inferred type.',
      assertion: "This assertion widens known local value evidence to bare unknown.",
    },
  },
  createOnce(context) {
    let variables = new Map<string, Variable>();
    let exported = new Set<string>();

    const indexVariables = (): void => {
      variables = new Map();
      for (const scope of context.sourceCode.scopeManager.scopes) {
        for (const reference of scope.references) {
          if (reference.resolved !== null) {
            variables.set(
              rangeKey(reference.identifier.start, reference.identifier.end),
              reference.resolved,
            );
          }
        }
      }
    };

    const reportVariable = (node: ESTree.VariableDeclarator): void => {
      if (
        node.id.type !== "Identifier" ||
        node.init === null ||
        node.parent.type !== "VariableDeclaration" ||
        node.parent.kind !== "const" ||
        isExportedModuleBinding(node, exported)
      ) {
        return;
      }
      const annotation = node.id.typeAnnotation?.typeAnnotation;
      if (annotation === null || annotation === undefined) return;
      if (!isBareUnknown(annotation) || !knownValueEvidence(node.init, variables)) return;

      context.report({
        node: unwrapType(annotation),
        messageId: "widening",
        data: { name: node.id.name },
      });
    };

    const reportAssertion = (node: TypeAssertion): void => {
      if (
        !isBareUnknown(node.typeAnnotation) ||
        hasAssertionParent(node) ||
        hasAssertionChild(node) ||
        isMutableVariableFlow(node, variables) ||
        isParameterDefaultValue(node) ||
        isReturnExpression(node) ||
        isInsideExportedBinding(node, exported) ||
        !knownValueEvidence(node.expression, variables)
      ) {
        return;
      }

      context.report({ node: unwrapType(node.typeAnnotation), messageId: "assertion" });
    };

    return {
      Program(program) {
        exported = new Set(exportedNames(program));
        indexVariables();
      },
      VariableDeclarator: reportVariable,
      TSAsExpression: reportAssertion,
      TSTypeAssertion: reportAssertion,
    };
  },
});
