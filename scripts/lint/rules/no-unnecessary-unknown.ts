// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { defineRule } from "@oxlint/plugins";
import type { Context, ESTree, Variable } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;
type LocalUnknownCandidate = ESTree.VariableDeclarator & {
  readonly id: ESTree.BindingIdentifier;
  readonly init: ESTree.Expression;
  readonly parent: ESTree.VariableDeclaration & { readonly kind: "const" };
};

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
  const current = outermostExpressionParent(node);
  let parent = current.parent;
  return parent !== null && isTypeAssertion(parent) && parent.expression === current;
}

function isTransparentExpressionParent(parent: ESTree.Node, current: ESTree.Node): boolean {
  return (
    (parent.type === "ParenthesizedExpression" || parent.type === "TSNonNullExpression") &&
    parent.expression === current
  );
}

function outermostExpressionParent(node: ESTree.Node): ESTree.Node {
  let current = node;
  let parent = current.parent;
  while (parent !== null && isTransparentExpressionParent(parent, current)) {
    current = parent;
    parent = parent.parent;
  }
  return current;
}

function unwrapParenthesesAndNonNull(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (current.type === "ParenthesizedExpression" || current.type === "TSNonNullExpression") {
    current = current.expression;
  }
  return current;
}

function hasAssertionChild(node: TypeAssertion): boolean {
  const current = unwrapParenthesesAndNonNull(node.expression);
  return isTypeAssertion(current);
}

function hasAssertionChain(expression: ESTree.Expression): boolean {
  const current = unwrapParenthesesAndNonNull(expression);
  return isTypeAssertion(current) && (hasAssertionParent(current) || hasAssertionChild(current));
}

function isConciseArrowReturn(parent: ESTree.Node, current: ESTree.Node): boolean {
  return (
    parent.type === "ArrowFunctionExpression" &&
    parent.body.type !== "BlockStatement" &&
    parent.body === current
  );
}

function isFunctionBoundary(node: ESTree.Node): boolean {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "TSDeclareFunction" ||
    node.type === "TSEmptyBodyFunctionExpression"
  );
}

function isReturnExpression(node: ESTree.Node): boolean {
  let current = node;
  let parent = current.parent;
  while (parent !== null) {
    if (parent.type === "ReturnStatement" || isConciseArrowReturn(parent, current)) return true;
    if (isFunctionBoundary(parent)) return false;
    current = parent;
    parent = parent.parent;
  }
  return false;
}

function isParameterDefaultValue(node: ESTree.Node): boolean {
  const current = outermostExpressionParent(node);
  const parent = current.parent;
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

function hasUncertainAssertion(expression: ESTree.Expression): boolean {
  return hasBroadAssertion(expression) || hasAssertionChain(expression);
}

function hasKnownLiteralEvidence(expression: ESTree.Expression): boolean {
  return isKnownLiteral(expression) || isKnownObjectOrArray(expression);
}

function isConstInitializedIdentifier(
  declarator: ESTree.VariableDeclarator,
): declarator is LocalUnknownCandidate {
  return (
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const" &&
    declarator.id.type === "Identifier" &&
    declarator.init !== null
  );
}

function hasNonInitializationWrite(variable: Variable): boolean {
  return variable.references.some((reference) => reference.isWrite() && !reference.init);
}

function hasDisqualifyingAnnotation(annotation: ESTree.TSType | null | undefined): boolean {
  return (
    annotation !== null &&
    annotation !== undefined &&
    (containsTopLevelAnyOrUnknown(annotation) || unwrapType(annotation).type === "TSTypeReference")
  );
}

function hasDisqualifyingDeclaratorAnnotation(declarator: LocalUnknownCandidate): boolean {
  return hasDisqualifyingAnnotation(declarator.id.typeAnnotation?.typeAnnotation);
}

function knownEvidenceDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
  const declarator = variableDeclarator(variable);
  if (declarator === null) return null;
  if (!isConstInitializedIdentifier(declarator)) return null;
  if (hasNonInitializationWrite(variable)) return null;
  if (hasDisqualifyingDeclaratorAnnotation(declarator)) return null;
  return declarator;
}

function knownEvidenceForVariable(
  variable: Variable,
  variables: ReadonlyMap<string, Variable>,
  visited: ReadonlySet<Variable>,
): boolean {
  const declarator = knownEvidenceDeclarator(variable);
  if (declarator === null) return false;
  if (declarator.init === null) return false;
  const nextVisited = new Set(visited);
  nextVisited.add(variable);
  return knownValueEvidence(declarator.init, variables, nextVisited);
}

function knownEvidenceForIdentifier(
  expression: ESTree.Expression,
  variables: ReadonlyMap<string, Variable>,
  visited: ReadonlySet<Variable>,
): boolean {
  if (expression.type !== "Identifier") return false;
  const variable = variables.get(rangeKey(expression.start, expression.end));
  if (variable === undefined || visited.has(variable)) return false;
  return knownEvidenceForVariable(variable, variables, visited);
}

function knownValueEvidence(
  expression: ESTree.Expression,
  variables: ReadonlyMap<string, Variable>,
  visited: ReadonlySet<Variable> = new Set(),
): boolean {
  if (hasUncertainAssertion(expression)) return false;
  if (hasKnownLiteralEvidence(expression)) return true;
  return knownEvidenceForIdentifier(unwrapExpression(expression), variables, visited);
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
  if (!isLocalValueExport(statement)) return;
  for (const specifier of statement.specifiers) {
    const name = runtimeExportName(specifier);
    if (name !== null) names.add(name);
  }
}

function isLocalValueExport(statement: ESTree.ExportNamedDeclaration): boolean {
  return statement.exportKind !== "type" && statement.source === null;
}

function runtimeExportName(
  specifier: ESTree.ExportNamedDeclaration["specifiers"][number],
): string | null {
  if (specifier.exportKind === "type" || specifier.local.type !== "Identifier") return null;
  return specifier.local.name;
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
  return isDirectlyExported(owner) || isNamedProgramExport(owner, declarator.id.name, names);
}

function isDirectlyExported(owner: ESTree.Node): boolean {
  return owner.type === "ExportNamedDeclaration" || owner.type === "ExportDefaultDeclaration";
}

function isNamedProgramExport(
  owner: ESTree.Node,
  name: string,
  names: ReadonlySet<string>,
): boolean {
  return owner.type === "Program" && names.has(name);
}

function isMutableVariableDeclarationFlow(
  parent: ESTree.Node | null,
  current: ESTree.Node,
): boolean {
  return (
    parent?.type === "VariableDeclarator" &&
    parent.init === current &&
    isMutableVariableDeclarator(parent)
  );
}

function isMutableVariableDeclarator(declarator: ESTree.VariableDeclarator): boolean {
  return declarator.parent.type === "VariableDeclaration" && declarator.parent.kind !== "const";
}

function assignmentIdentifier(
  parent: ESTree.Node | null,
  current: ESTree.Node,
): ESTree.IdentifierReference | null {
  if (
    parent?.type !== "AssignmentExpression" ||
    parent.right !== current ||
    parent.left.type !== "Identifier"
  ) {
    return null;
  }
  return parent.left;
}

function isMutableAssignmentFlow(
  parent: ESTree.Node | null,
  current: ESTree.Node,
  variables: ReadonlyMap<string, Variable>,
): boolean {
  const identifier = assignmentIdentifier(parent, current);
  if (identifier === null) return false;
  const variable = variables.get(rangeKey(identifier.start, identifier.end));
  const declarator = variable === undefined ? null : variableDeclarator(variable);
  return declarator !== null && isMutableVariableDeclarator(declarator);
}

function isMutableVariableFlow(
  node: TypeAssertion,
  variables: ReadonlyMap<string, Variable>,
): boolean {
  const current = outermostExpressionParent(node);
  const parent = current.parent;
  return (
    isMutableVariableDeclarationFlow(parent, current) ||
    isMutableAssignmentFlow(parent, current, variables)
  );
}

function isInsideExportedBinding(node: ESTree.Node, names: ReadonlySet<string>): boolean {
  let current: ESTree.Node | null = node;
  while (current !== null) {
    if (current.type === "VariableDeclarator") {
      return isExportedModuleBinding(current, names);
    }
    if (isFunctionBoundary(current)) return false;
    current = current.parent;
  }
  return false;
}

function isLocalUnknownCandidate(
  node: ESTree.VariableDeclarator,
  exported: ReadonlySet<string>,
): node is LocalUnknownCandidate {
  if (node.id.type !== "Identifier") return false;
  if (node.init === null) return false;
  if (node.parent.type !== "VariableDeclaration") return false;
  if (node.parent.kind !== "const") return false;
  return !isExportedModuleBinding(node, exported);
}

function reportUnknownVariable(
  context: Context,
  node: ESTree.VariableDeclarator,
  variables: ReadonlyMap<string, Variable>,
  exported: ReadonlySet<string>,
): void {
  if (!isLocalUnknownCandidate(node, exported)) return;
  const annotation = node.id.typeAnnotation?.typeAnnotation;
  if (annotation == null) return;
  if (!hasUnknownTypeEvidence(annotation, node.init, variables)) return;
  context.report({
    node: unwrapType(annotation),
    messageId: "widening",
    data: { name: node.id.name },
  });
}

function hasUnknownTypeEvidence(
  annotation: ESTree.TSType,
  initializer: ESTree.Expression,
  variables: ReadonlyMap<string, Variable>,
): boolean {
  return isBareUnknown(annotation) && knownValueEvidence(initializer, variables);
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

    const reportVariable = (node: ESTree.VariableDeclarator): void =>
      reportUnknownVariable(context, node, variables, exported);

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
