// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { defineRule } from "@oxlint/plugins";
import type { ESTree, Variable } from "@oxlint/plugins";

type BroadTypeKind = "top" | "object" | "record";

type KnownValueEvidence = {
  readonly type: ESTree.TSType | null;
};

type WidenableDeclarator = ESTree.VariableDeclarator & {
  readonly id: ESTree.BindingIdentifier;
  readonly init: ESTree.Expression;
  readonly parent: ESTree.VariableDeclaration & { readonly kind: "const" };
};

type ConstInitializer = ESTree.VariableDeclarator & {
  readonly init: ESTree.Expression;
  readonly parent: ESTree.VariableDeclaration & { readonly kind: "const" };
};

type ScopeIndex = readonly {
  readonly references: readonly {
    readonly identifier: ESTree.Node;
    readonly resolved: Variable | null;
  }[];
}[];

const functionBoundaryTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);

function unwrapExpressionParentheses(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (current.type === "ParenthesizedExpression") current = current.expression;
  return current;
}

function unwrapTypeParentheses(type: ESTree.TSType): ESTree.TSType {
  let current = type;
  while (current.type === "TSParenthesizedType") current = current.typeAnnotation;
  return current;
}

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isUnknownOrAnyType(type: ESTree.TSType): boolean {
  const unwrapped = unwrapTypeParentheses(type);
  return unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword";
}

function isPropertyKeyType(type: ESTree.TSType): boolean {
  return type.type === "TSTypeReference" && typeReferenceName(type) === "PropertyKey";
}

function isPrimitiveBroadRecordKeyType(type: ESTree.TSType): boolean {
  return (
    type.type === "TSStringKeyword" ||
    type.type === "TSNumberKeyword" ||
    type.type === "TSSymbolKeyword"
  );
}

function typeArguments(type: ESTree.TSTypeReference): ESTree.TSType[] {
  return type.typeArguments?.params ?? [];
}

function isBroadRecordKeyType(type: ESTree.TSType): boolean {
  const unwrapped = unwrapTypeParentheses(type);
  if (unwrapped.type === "TSUnionType") return unwrapped.types.every(isBroadRecordKeyType);
  return isPrimitiveBroadRecordKeyType(unwrapped) || isPropertyKeyType(unwrapped);
}

function isBroadRecordParameters(type: ESTree.TSTypeReference): boolean {
  const parameters = typeArguments(type);
  if (parameters.length !== 2) return false;
  const [key, value] = parameters;
  if (key === undefined) return false;
  if (value === undefined) return false;
  return isBroadRecordKeyType(key) && isUnknownOrAnyType(value);
}

function isReadonlyTypeReference(type: ESTree.TSTypeReference): boolean {
  return typeReferenceName(type) === "Readonly";
}

function isBroadReadonlyTypeReference(type: ESTree.TSTypeReference): boolean {
  const [inner] = type.typeArguments?.params ?? [];
  return inner !== undefined && isBroadRecordType(inner);
}

function isBroadRecordReference(type: ESTree.TSTypeReference): boolean {
  if (isReadonlyTypeReference(type)) return isBroadReadonlyTypeReference(type);
  return typeReferenceName(type) === "Record" && isBroadRecordParameters(type);
}

function isBroadRecordIndexParameter(
  member: Extract<ESTree.TSTypeLiteral["members"][number], { type: "TSIndexSignature" }>,
): boolean {
  const [parameter] = member.parameters;
  return (
    parameter !== undefined &&
    isBroadRecordKeyType(parameter.typeAnnotation.typeAnnotation) &&
    isUnknownOrAnyType(member.typeAnnotation.typeAnnotation)
  );
}

function isBroadRecordIndexSignature(
  member: ESTree.TSTypeLiteral["members"][number] | undefined,
): boolean {
  if (member?.type !== "TSIndexSignature") return false;
  if (member.parameters.length !== 1) return false;
  return isBroadRecordIndexParameter(member);
}

function isBroadRecordLiteral(type: ESTree.TSTypeLiteral): boolean {
  if (type.members.length !== 1) return false;
  return isBroadRecordIndexSignature(type.members[0]);
}

function isBroadRecordType(type: ESTree.TSType): boolean {
  const unwrapped = unwrapTypeParentheses(type);
  if (unwrapped.type === "TSTypeReference") return isBroadRecordReference(unwrapped);
  return unwrapped.type === "TSTypeLiteral" && isBroadRecordLiteral(unwrapped);
}

function broadTypeKind(type: ESTree.TSType): BroadTypeKind | null {
  const unwrapped = unwrapTypeParentheses(type);
  if (unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword") return "top";
  if (unwrapped.type === "TSObjectKeyword") return "object";
  return isBroadRecordType(unwrapped) ? "record" : null;
}

function assertedExpression(
  node: ESTree.TSAsExpression | ESTree.TSTypeAssertion,
): ESTree.Expression {
  return unwrapExpressionParentheses(node.expression);
}

function assertionFromExpression(
  expression: ESTree.Expression,
): ESTree.TSAsExpression | ESTree.TSTypeAssertion | null {
  const unwrapped = unwrapExpressionParentheses(expression);
  return unwrapped.type === "TSAsExpression" || unwrapped.type === "TSTypeAssertion"
    ? unwrapped
    : null;
}

function normalizedTypeText(sourceText: string, type: ESTree.TSType): string {
  return sourceText.slice(type.start, type.end).replaceAll(/\s+/gu, "");
}

function typesHaveSameSyntax(
  sourceText: string,
  left: ESTree.TSType | null,
  right: ESTree.TSType,
): boolean {
  return (
    left !== null &&
    normalizedTypeText(sourceText, unwrapTypeParentheses(left)) ===
      normalizedTypeText(sourceText, unwrapTypeParentheses(right))
  );
}

function isDefinitelyObjectType(type: ESTree.TSType): boolean {
  const unwrapped = unwrapTypeParentheses(type);
  switch (unwrapped.type) {
    case "TSArrayType":
    case "TSConstructorType":
    case "TSFunctionType":
    case "TSMappedType":
    case "TSObjectKeyword":
    case "TSTupleType":
      return true;
    case "TSTypeLiteral":
      return unwrapped.members.length > 0;
    case "TSIntersectionType":
      return unwrapped.types.every(isDefinitelyObjectType);
    case "TSTypeOperator":
      return unwrapped.operator === "readonly" && isDefinitelyObjectType(unwrapped.typeAnnotation);
    default:
      return false;
  }
}

function isNarrowRecordLiteral(type: ESTree.TSTypeLiteral): boolean {
  return type.members.some((member) => member.type !== "TSIndexSignature");
}

function isNarrowReadonlyTypeReference(type: ESTree.TSTypeReference): boolean {
  const [inner] = type.typeArguments?.params ?? [];
  return inner !== undefined && isDefinitelyNarrowerRecordType(inner);
}

function hasNarrowRecordValueType(type: ESTree.TSTypeReference): boolean {
  const parameters = type.typeArguments?.params ?? [];
  return (
    parameters.length === 2 && parameters[1] !== undefined && !isUnknownOrAnyType(parameters[1])
  );
}

function isNarrowRecordReference(type: ESTree.TSTypeReference): boolean {
  if (isReadonlyTypeReference(type)) return isNarrowReadonlyTypeReference(type);
  return typeReferenceName(type) === "Record" && hasNarrowRecordValueType(type);
}

function isDefinitelyNarrowerRecordType(type: ESTree.TSType): boolean {
  const unwrapped = unwrapTypeParentheses(type);
  if (unwrapped.type === "TSTypeLiteral") return isNarrowRecordLiteral(unwrapped);
  return unwrapped.type === "TSTypeReference" && isNarrowRecordReference(unwrapped);
}

function functionBoundary(node: ESTree.Node): ESTree.Node | null {
  let current = node.parent;
  while (current !== null && current.type !== "Program") {
    if (functionBoundaryTypes.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function resolvedVariableForIdentifier(
  scopes: ScopeIndex,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  for (const scope of scopes) {
    const reference = scope.references.find(
      (candidate) =>
        candidate.identifier.start === identifier.start &&
        candidate.identifier.end === identifier.end,
    );
    if (reference !== undefined) return reference.resolved;
  }
  return null;
}

function variableDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
  for (const definition of variable.defs) {
    if (definition.type === "Variable" && definition.node.type === "VariableDeclarator") {
      return definition.node;
    }
  }
  return null;
}

function isTypeAssertionExpression(
  expression: ESTree.Expression,
): expression is ESTree.TSAsExpression | ESTree.TSTypeAssertion {
  return expression.type === "TSAsExpression" || expression.type === "TSTypeAssertion";
}

function assertionEvidence(
  assertion: ESTree.TSAsExpression | ESTree.TSTypeAssertion,
): KnownValueEvidence | null {
  if (broadTypeKind(assertion.typeAnnotation) !== null) return null;
  return { type: assertion.typeAnnotation };
}

const VALUE_EVIDENCE_NODE_TYPES = new Set([
  "ArrayExpression",
  "ArrowFunctionExpression",
  "ClassExpression",
  "FunctionExpression",
  "NewExpression",
  "ObjectExpression",
]);

function hasKnownValueWithoutType(expression: ESTree.Expression): boolean {
  return (
    expression.type === "Literal" ||
    expression.type === "TemplateLiteral" ||
    VALUE_EVIDENCE_NODE_TYPES.has(expression.type)
  );
}

function isConstInitializer(declarator: ESTree.VariableDeclarator): declarator is ConstInitializer {
  return (
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const" &&
    declarator.init !== null
  );
}

function hasNoNonInitializationWrites(variable: Variable): boolean {
  return !variable.references.some((reference) => reference.isWrite() && !reference.init);
}

function evidenceFromAnnotation(
  identifier: ESTree.Node,
  annotation: ESTree.TSType,
  boundary: ESTree.Node | null,
): KnownValueEvidence | null {
  if (functionBoundary(identifier) !== boundary) return null;
  if (broadTypeKind(annotation) !== null) return null;
  return { type: annotation };
}

function evidenceFromConstInitializer(
  variable: Variable,
  boundary: ESTree.Node | null,
  scopes: ScopeIndex,
  visitedVariables: ReadonlySet<Variable>,
): KnownValueEvidence | null {
  const declarator = variableDeclarator(variable);
  if (declarator === null) return null;
  if (!isConstInitializer(declarator)) return null;
  if (!hasNoNonInitializationWrites(variable)) return null;
  if (functionBoundary(declarator) !== boundary) return null;
  return knownValueEvidence(
    declarator.init,
    scopes,
    boundary,
    new Set([...visitedVariables, variable]),
  );
}

function evidenceFromResolvedVariable(
  variable: Variable,
  boundary: ESTree.Node | null,
  scopes: ScopeIndex,
  visitedVariables: ReadonlySet<Variable>,
): KnownValueEvidence | null {
  const annotatedIdentifier = variable.identifiers.find(
    (identifier) => identifier.typeAnnotation !== null && identifier.typeAnnotation !== undefined,
  );
  const annotation = annotatedIdentifier?.typeAnnotation?.typeAnnotation;
  if (annotation !== undefined && annotatedIdentifier !== undefined) {
    return evidenceFromAnnotation(annotatedIdentifier, annotation, boundary);
  }
  return evidenceFromConstInitializer(variable, boundary, scopes, visitedVariables);
}

function evidenceFromIdentifier(
  expression: ESTree.Expression,
  scopes: ScopeIndex,
  boundary: ESTree.Node | null,
  visitedVariables: ReadonlySet<Variable>,
): KnownValueEvidence | null {
  if (expression.type !== "Identifier") return null;
  const variable = resolvedVariableForIdentifier(scopes, expression);
  if (variable === null) return null;
  if (visitedVariables.has(variable)) return null;
  return evidenceFromResolvedVariable(variable, boundary, scopes, visitedVariables);
}

function knownValueEvidence(
  expression: ESTree.Expression,
  scopes: ScopeIndex,
  boundary: ESTree.Node | null,
  visitedVariables: ReadonlySet<Variable>,
): KnownValueEvidence | null {
  const unwrapped = unwrapExpressionParentheses(expression);
  if (isTypeAssertionExpression(unwrapped)) return assertionEvidence(unwrapped);
  if (hasKnownValueWithoutType(unwrapped)) return { type: null };
  return evidenceFromIdentifier(unwrapped, scopes, boundary, visitedVariables);
}

function isWidenableDeclarator(
  declarator: ESTree.VariableDeclarator,
): declarator is WidenableDeclarator {
  if (declarator.parent.type !== "VariableDeclaration") return false;
  if (declarator.parent.kind !== "const") return false;
  if (declarator.id.type !== "Identifier") return false;
  if (declarator.init === null) return false;
  return true;
}

function widenableDeclarator(variable: Variable): WidenableDeclarator | null {
  const declarator = variableDeclarator(variable);
  if (declarator === null) return null;
  if (!isWidenableDeclarator(declarator)) return null;
  if (!hasNoNonInitializationWrites(variable)) return null;
  return declarator;
}

function initializerBroadKind(
  assertion: ESTree.TSAsExpression | ESTree.TSTypeAssertion | null,
): BroadTypeKind | null {
  return assertion === null ? null : broadTypeKind(assertion.typeAnnotation);
}

function originalInitializerExpression(
  initializer: ESTree.Expression,
  assertion: ESTree.TSAsExpression | ESTree.TSTypeAssertion | null,
  assertionBroadKind: BroadTypeKind | null,
): ESTree.Expression {
  if (assertion !== null && assertionBroadKind !== null) return assertedExpression(assertion);
  return initializer;
}

function widenedBinding(
  variable: Variable,
  scopes: ScopeIndex,
): {
  readonly broadKind: BroadTypeKind;
  readonly evidence: KnownValueEvidence;
  readonly declaredAt: number;
  readonly boundary: ESTree.Node | null;
} | null {
  const declarator = widenableDeclarator(variable);
  if (declarator === null) return null;
  const boundary = functionBoundary(declarator);
  const initializerAssertion = assertionFromExpression(declarator.init);
  const initializerBroad = initializerBroadKind(initializerAssertion);
  const broadKind = bindingBroadType(declarator, initializerBroad);
  if (broadKind === null) return null;
  const originalExpression = originalInitializerExpression(
    declarator.init,
    initializerAssertion,
    initializerBroad,
  );
  const evidence = knownValueEvidence(originalExpression, scopes, boundary, new Set([variable]));
  return evidence === null ? null : { broadKind, evidence, declaredAt: declarator.end, boundary };
}

function bindingBroadType(
  declarator: WidenableDeclarator,
  initializerBroad: BroadTypeKind | null,
): BroadTypeKind | null {
  const declaredType = declarator.id.typeAnnotation?.typeAnnotation;
  if (declaredType === undefined) return initializerBroad;
  return broadTypeKind(declaredType) ?? initializerBroad;
}

function assertionIsNarrower(
  sourceText: string,
  broadKind: BroadTypeKind,
  evidence: KnownValueEvidence,
  assertedType: ESTree.TSType,
): boolean {
  if (broadTypeKind(assertedType) !== null) return false;
  if (broadKind === "top") return true;
  if (typesHaveSameSyntax(sourceText, evidence.type, assertedType)) return true;
  if (broadKind === "object") return isDefinitelyObjectType(assertedType);
  return isDefinitelyNarrowerRecordType(assertedType);
}

function matchesWidenedBindingAssertion(
  sourceText: string,
  node: ESTree.TSAsExpression | ESTree.TSTypeAssertion,
  widened: NonNullable<ReturnType<typeof widenedBinding>>,
): boolean {
  if (node.start <= widened.declaredAt) return false;
  if (functionBoundary(node) !== widened.boundary) return false;
  return assertionIsNarrower(sourceText, widened.broadKind, widened.evidence, node.typeAnnotation);
}

export const noWidenThenAssertRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow local const flows that explicitly widen a known value before asserting the widened binding to a narrower type.",
    },
    messages: {
      widenThenAssert:
        'Binding "{{name}}" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.',
    },
  },
  createOnce(context) {
    let scopes: Parameters<typeof resolvedVariableForIdentifier>[0] = [];

    const checkAssertion = (node: ESTree.TSAsExpression | ESTree.TSTypeAssertion) => {
      const expression = assertedExpression(node);
      if (expression.type !== "Identifier") return;

      const variable = resolvedVariableForIdentifier(scopes, expression);
      if (variable === null) return;
      const widened = widenedBinding(variable, scopes);
      if (widened === null) return;
      if (!matchesWidenedBindingAssertion(context.sourceCode.text, node, widened)) return;

      context.report({
        node,
        messageId: "widenThenAssert",
        data: { name: expression.name },
      });
    };

    return {
      Program() {
        scopes = context.sourceCode.scopeManager.scopes;
      },
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
