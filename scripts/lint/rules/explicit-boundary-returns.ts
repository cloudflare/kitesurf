// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { defineRule } from "@oxlint/plugins";
import type { Context, ESTree } from "@oxlint/plugins";
import {
  createTypeScriptContracts,
  hasJSDocReturnContract as parseJSDocReturnContract,
  type ContractMemberKind,
  type TypeScriptContracts,
} from "./typescript-contracts.ts";

type CallableNode = ESTree.Function | ESTree.ArrowFunctionExpression;
type PropertyKey =
  | ESTree.ObjectProperty["key"]
  | ESTree.MethodDefinition["key"]
  | ESTree.TSMethodSignature["key"]
  | ESTree.TSPropertySignature["key"];
type TypeLiteralMember = ESTree.TSTypeLiteral["members"][number];
type TopLevelBinding =
  | { readonly kind: "function"; readonly node: ESTree.Function }
  | { readonly kind: "class"; readonly node: ESTree.Class }
  | { readonly kind: "variable"; readonly node: ESTree.VariableDeclarator };
type NamedDefaultDeclaration =
  | ESTree.Function
  | ESTree.Class
  | ESTree.IdentifierReference
  | ESTree.TSInterfaceDeclaration;
type FunctionCandidate =
  | ESTree.Declaration
  | ESTree.ExportDefaultDeclarationKind
  | ESTree.Program["body"][number];

const SEMANTIC_CONTRACT_TYPE_NODES = new Set([
  "TSTypeReference",
  "TSImportType",
  "TSTypeQuery",
  "TSUnionType",
  "TSIntersectionType",
  "TSConditionalType",
  "TSIndexedAccessType",
]);

function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (true) {
    switch (current.type) {
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion":
      case "TSNonNullExpression":
      case "TSInstantiationExpression":
        current = current.expression;
        break;
      default:
        return current;
    }
  }
}

function contextualTypes(expression: ESTree.Expression): ESTree.TSType[] {
  const types: ESTree.TSType[] = [];
  let current = expression;
  while (true) {
    switch (current.type) {
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion":
        types.push(current.typeAnnotation);
        current = current.expression;
        break;
      case "ParenthesizedExpression":
      case "TSNonNullExpression":
      case "TSInstantiationExpression":
        current = current.expression;
        break;
      default:
        return types;
    }
  }
}

function callableExpression(expression: ESTree.Expression): CallableNode | null {
  const unwrapped = unwrapExpression(expression);
  return unwrapped.type === "ArrowFunctionExpression" || unwrapped.type === "FunctionExpression"
    ? unwrapped
    : null;
}

function stringifyPropertyValue(
  value: string | number | bigint | boolean | null | RegExp,
): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function literalPropertyName(key: PropertyKey): string | null {
  if (key.type !== "Literal") return null;
  return stringifyPropertyValue(key.value);
}

function propertyName(key: PropertyKey, computed: boolean): string | null {
  if (!computed && key.type === "Identifier") return key.name;
  return literalPropertyName(key);
}

function isSemanticContractType(type: ESTree.TSType): boolean {
  return SEMANTIC_CONTRACT_TYPE_NODES.has(type.type);
}

function hasSemanticCallableOwnerContract(
  type: ESTree.TSType,
  contracts: () => TypeScriptContracts | null,
): boolean {
  return (
    isSemanticContractType(type) && (contracts()?.hasCallableType(type.start, type.end) ?? false)
  );
}

function hasSemanticMemberOwnerContract(
  type: ESTree.TSType,
  name: string,
  kind: ContractMemberKind,
  contracts: () => TypeScriptContracts | null,
): boolean {
  return (
    isSemanticContractType(type) &&
    (contracts()?.hasMemberType(type.start, type.end, name, kind) ?? false)
  );
}

function isCallableSignatureWithReturn(member: TypeLiteralMember): boolean {
  return member.type === "TSCallSignatureDeclaration" && member.returnType !== null;
}

function hasCallableOwnerContract(
  type: ESTree.TSType,
  contracts: () => TypeScriptContracts | null,
): boolean {
  if (type.type === "TSFunctionType" || type.type === "TSConstructorType") return true;
  if (type.type === "TSParenthesizedType") {
    return hasCallableOwnerContract(type.typeAnnotation, contracts);
  }
  if (type.type === "TSTypeLiteral") return type.members.some(isCallableSignatureWithReturn);
  return hasSemanticCallableOwnerContract(type, contracts);
}

function hasMemberOwnerContract(
  type: ESTree.TSType,
  name: string,
  kind: ContractMemberKind,
  contracts: () => TypeScriptContracts | null,
): boolean {
  if (type.type === "TSParenthesizedType") {
    return hasMemberOwnerContract(type.typeAnnotation, name, kind, contracts);
  }
  if (type.type === "TSTypeLiteral") {
    return type.members.some((member) => {
      if (member.type === "TSMethodSignature") {
        return (
          propertyName(member.key, member.computed) === name &&
          (kind === "get" ? member.kind === "get" : member.kind === "method") &&
          member.returnType !== null
        );
      }
      if (
        member.type !== "TSPropertySignature" ||
        propertyName(member.key, member.computed) !== name ||
        member.typeAnnotation === null
      ) {
        return false;
      }
      return (
        kind === "get" || hasCallableOwnerContract(member.typeAnnotation.typeAnnotation, contracts)
      );
    });
  }
  return hasSemanticMemberOwnerContract(type, name, kind, contracts);
}

function jsDocContract(comment: ESTree.Comment | null): boolean {
  if (comment === null || comment.type !== "Block") return false;
  return parseJSDocReturnContract(comment.value);
}

function firstCommentAfterNode(comments: readonly ESTree.Comment[], nodeStart: number): number {
  let low = 0;
  let high = comments.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const comment = comments[middle];
    if (comment !== undefined && comment.end <= nodeStart) low = middle + 1;
    else high = middle;
  }
  return low;
}

function isAdjacentJsDocComment(
  sourceText: string,
  comment: ESTree.Comment | undefined,
  node: ESTree.Node,
): comment is ESTree.Comment {
  if (comment === undefined || comment.type !== "Block") return false;
  if (!sourceText.slice(comment.start, comment.end).startsWith("/**")) return false;
  return sourceText.slice(comment.end, node.start).trim().length === 0;
}

function precedingJSDocComment(
  sourceText: string,
  comments: readonly ESTree.Comment[],
  node: ESTree.Node,
): ESTree.Comment | null {
  const comment = comments[firstCommentAfterNode(comments, node.start) - 1];
  return isAdjacentJsDocComment(sourceText, comment, node) ? comment : null;
}

function functionDocumentationNodes(fn: CallableNode): ESTree.Node[] {
  const nodes: ESTree.Node[] = [fn];
  let parent = fn.parent;
  while (true) {
    switch (parent.type) {
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion":
      case "TSNonNullExpression":
      case "TSInstantiationExpression":
      case "VariableDeclarator":
      case "VariableDeclaration":
        nodes.push(parent);
        parent = parent.parent;
        break;
      case "ExportDefaultDeclaration":
      case "ExportNamedDeclaration":
      case "MethodDefinition":
      case "Property":
        nodes.push(parent);
        return nodes;
      default:
        return nodes;
    }
  }
}

function hasJSDocContract(
  sourceText: string,
  comments: readonly ESTree.Comment[],
  fn: CallableNode,
): boolean {
  return functionDocumentationNodes(fn).some((node) =>
    jsDocContract(precedingJSDocComment(sourceText, comments, node)),
  );
}

function isFunctionNode(node: FunctionCandidate): node is ESTree.Function {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "TSDeclareFunction" ||
    node.type === "TSEmptyBodyFunctionExpression"
  );
}

function exportedLocalNames(statement: ESTree.ExportNamedDeclaration): string[] {
  if (!isLocalSpecifierExport(statement)) return [];
  const names: string[] = [];
  for (const specifier of statement.specifiers) {
    const name = localExportedName(specifier);
    if (name !== null) names.push(name);
  }
  return names;
}

function isLocalSpecifierExport(statement: ESTree.ExportNamedDeclaration): boolean {
  return (
    statement.exportKind !== "type" && statement.source === null && statement.declaration === null
  );
}

function localExportedName(
  specifier: ESTree.ExportNamedDeclaration["specifiers"][number],
): string | null {
  if (specifier.exportKind === "type" || specifier.local.type !== "Identifier") return null;
  return specifier.local.name;
}

type BoundaryAnalysis = {
  readonly context: Context;
  readonly sourceText: string;
  readonly comments: readonly ESTree.Comment[];
  readonly declarations: Map<string, TopLevelBinding[]>;
  readonly functions: Map<string, ESTree.Function[]>;
  readonly classes: ESTree.Class[];
  readonly exportedLocals: Set<string>;
  readonly analyzed: Set<ESTree.Node>;
  semanticContracts: TypeScriptContracts | null | undefined;
};

type ClassBodyElement = ESTree.Class["body"]["body"][number];
type ClassMethod = ESTree.MethodDefinition;
type ObjectProperty = ESTree.ObjectExpression["properties"][number];

function createBoundaryAnalysis(
  context: Context,
  sourceText: string,
  comments: readonly ESTree.Comment[],
): BoundaryAnalysis {
  return {
    context,
    sourceText,
    comments,
    declarations: new Map(),
    functions: new Map(),
    classes: [],
    exportedLocals: new Set(),
    analyzed: new Set(),
    semanticContracts: undefined,
  };
}

function semanticContracts(analysis: BoundaryAnalysis): TypeScriptContracts | null {
  if (analysis.semanticContracts === undefined) {
    analysis.semanticContracts = createTypeScriptContracts(
      analysis.context.filename,
      analysis.context.cwd,
      analysis.sourceText,
    );
  }
  return analysis.semanticContracts;
}

function appendMapValue<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}

function indexFunctionDeclaration(analysis: BoundaryAnalysis, declaration: ESTree.Function): void {
  if (declaration.id === null) return;
  appendMapValue(analysis.declarations, declaration.id.name, {
    kind: "function",
    node: declaration,
  });
  appendMapValue(analysis.functions, declaration.id.name, declaration);
}

function indexClassDeclaration(analysis: BoundaryAnalysis, declaration: ESTree.Class): void {
  analysis.classes.push(declaration);
  if (declaration.id === null) return;
  appendMapValue(analysis.declarations, declaration.id.name, { kind: "class", node: declaration });
}

function indexVariableDeclaration(
  analysis: BoundaryAnalysis,
  declaration: ESTree.VariableDeclaration,
): void {
  for (const variable of declaration.declarations) {
    if (variable.id.type === "Identifier") {
      appendMapValue(analysis.declarations, variable.id.name, { kind: "variable", node: variable });
    }
  }
}

function indexTopLevelDeclaration(
  analysis: BoundaryAnalysis,
  declaration: ESTree.Declaration,
): void {
  if (isFunctionNode(declaration)) {
    indexFunctionDeclaration(analysis, declaration);
    return;
  }
  if (declaration.type === "ClassDeclaration") {
    indexClassDeclaration(analysis, declaration);
    return;
  }
  if (declaration.type === "VariableDeclaration") {
    indexVariableDeclaration(analysis, declaration);
  }
}

function isIndexableTopLevelDeclaration(
  statement: ESTree.Program["body"][number],
): statement is ESTree.Declaration {
  return (
    isFunctionNode(statement) ||
    statement.type === "ClassDeclaration" ||
    statement.type === "VariableDeclaration"
  );
}

function indexExportedDeclaration(
  analysis: BoundaryAnalysis,
  statement: ESTree.ExportNamedDeclaration,
): void {
  if (statement.declaration !== null) indexTopLevelDeclaration(analysis, statement.declaration);
}

function indexTopLevelStatement(
  analysis: BoundaryAnalysis,
  statement: ESTree.Program["body"][number],
): void {
  if (statement.type === "ExportNamedDeclaration") {
    indexExportedDeclaration(analysis, statement);
    return;
  }
  if (isIndexableTopLevelDeclaration(statement)) {
    indexTopLevelDeclaration(analysis, statement);
  }
}

function indexTopLevelDeclarations(program: ESTree.Program, analysis: BoundaryAnalysis): void {
  for (const statement of program.body) indexTopLevelStatement(analysis, statement);
}

function functionHasReturnContract(
  analysis: BoundaryAnalysis,
  fn: CallableNode,
  ownerTypes: readonly ESTree.TSType[],
): boolean {
  return (
    (fn.returnType !== undefined && fn.returnType !== null) ||
    hasJSDocContract(analysis.sourceText, analysis.comments, fn) ||
    ownerTypes.some((type) => hasCallableOwnerContract(type, () => semanticContracts(analysis)))
  );
}

function functionOverloadName(fn: CallableNode): string | null {
  if (fn.type !== "FunctionDeclaration" && fn.type !== "TSDeclareFunction") return null;
  if (fn.id === null) return null;
  return fn.id.name;
}

function isMatchingFunctionOverload(
  analysis: BoundaryAnalysis,
  signature: ESTree.Function,
  fn: CallableNode,
): boolean {
  return (
    signature !== fn &&
    signature.body === null &&
    functionHasReturnContract(analysis, signature, [])
  );
}

function hasFunctionOverloadContract(analysis: BoundaryAnalysis, fn: CallableNode): boolean {
  const name = functionOverloadName(fn);
  if (name === null) return false;
  return (analysis.functions.get(name) ?? []).some((signature) =>
    isMatchingFunctionOverload(analysis, signature, fn),
  );
}

function hasFunctionReturnContract(
  analysis: BoundaryAnalysis,
  fn: CallableNode,
  ownerTypes: readonly ESTree.TSType[],
  contextualContract: boolean,
): boolean {
  return (
    contextualContract ||
    functionHasReturnContract(analysis, fn, ownerTypes) ||
    hasFunctionOverloadContract(analysis, fn)
  );
}

function reportFunction(
  analysis: BoundaryAnalysis,
  fn: CallableNode,
  ownerTypes: readonly ESTree.TSType[] = [],
  contextualContract = false,
): void {
  if (analysis.analyzed.has(fn)) return;
  analysis.analyzed.add(fn);
  if (hasFunctionReturnContract(analysis, fn, ownerTypes, contextualContract)) return;
  analysis.context.report({ node: fn, messageId: "missing" });
}

function isClassMethod(element: ClassBodyElement): element is ClassMethod {
  return element.type === "MethodDefinition" || element.type === "TSAbstractMethodDefinition";
}

function isAccessibleClassMethod(element: ClassMethod): boolean {
  return (
    element.accessibility !== "private" &&
    element.accessibility !== "protected" &&
    element.key.type !== "PrivateIdentifier"
  );
}

function isPublicReturnMethod(element: ClassBodyElement): element is ClassMethod {
  return (
    isClassMethod(element) &&
    element.kind !== "constructor" &&
    element.kind !== "set" &&
    isAccessibleClassMethod(element)
  );
}

function hasSameMethodSignature(
  candidate: ClassMethod,
  method: ClassMethod,
  name: string,
): boolean {
  return (
    candidate.kind === method.kind &&
    candidate.static === method.static &&
    propertyName(candidate.key, candidate.computed) === name
  );
}

function isMethodOverloadCandidate(
  element: ClassBodyElement,
  method: ClassMethod,
  name: string,
): element is ClassMethod {
  if (!isClassMethod(element)) return false;
  if (element === method) return false;
  return hasSameMethodSignature(element, method, name) && element.value.body === null;
}

function classMethodHasOverloadContract(
  analysis: BoundaryAnalysis,
  declaration: ESTree.Class,
  method: ClassMethod,
  name: string,
): boolean {
  for (const element of declaration.body.body) {
    if (
      isMethodOverloadCandidate(element, method, name) &&
      functionHasReturnContract(analysis, element.value, [])
    ) {
      return true;
    }
  }
  return false;
}

function hasDirectReturnContract(analysis: BoundaryAnalysis, fn: CallableNode): boolean {
  return (
    (fn.returnType !== undefined && fn.returnType !== null) ||
    hasJSDocContract(analysis.sourceText, analysis.comments, fn)
  );
}

function hasClassTypeOwner(declaration: ESTree.Class): boolean {
  return declaration.superClass !== null || (declaration.implements?.length ?? 0) > 0;
}

function classMethodOverloadContract(
  analysis: BoundaryAnalysis,
  declaration: ESTree.Class,
  method: ClassMethod,
  name: string | null,
  directContract: boolean,
): boolean {
  if (directContract || name === null) return false;
  return classMethodHasOverloadContract(analysis, declaration, method, name);
}

function hasSemanticClassMemberContract(
  analysis: BoundaryAnalysis,
  method: ClassMethod,
  name: string,
  kind: ContractMemberKind,
): boolean {
  return (
    semanticContracts(analysis)?.hasClassMember(method.start, name, kind, method.static) === true
  );
}

function classOwnerContract(
  analysis: BoundaryAnalysis,
  declaration: ESTree.Class,
  method: ClassMethod,
  name: string | null,
  kind: ContractMemberKind,
  directContract: boolean,
  overloadContract: boolean,
): boolean {
  if (directContract) return false;
  if (overloadContract) return false;
  if (!hasClassTypeOwner(declaration)) return false;
  if (name === null) return false;
  return hasSemanticClassMemberContract(analysis, method, name, kind);
}

function reportClassMethod(
  analysis: BoundaryAnalysis,
  declaration: ESTree.Class,
  element: ClassBodyElement,
): void {
  if (!isPublicReturnMethod(element)) return;
  const name = propertyName(element.key, element.computed);
  const kind: ContractMemberKind = element.kind === "get" ? "get" : "method";
  const directContract = hasDirectReturnContract(analysis, element.value);
  const overloadContract = classMethodOverloadContract(
    analysis,
    declaration,
    element,
    name,
    directContract,
  );
  const ownerContract = classOwnerContract(
    analysis,
    declaration,
    element,
    name,
    kind,
    directContract,
    overloadContract,
  );
  reportFunction(analysis, element.value, [], directContract || overloadContract || ownerContract);
}

function reportClass(analysis: BoundaryAnalysis, declaration: ESTree.Class): void {
  if (analysis.analyzed.has(declaration)) return;
  analysis.analyzed.add(declaration);
  for (const element of declaration.body.body) reportClassMethod(analysis, declaration, element);
}

function objectProperty(property: ObjectProperty): property is ESTree.ObjectProperty {
  return property.type === "Property" && property.kind !== "set";
}

function hasObjectOwnerContract(
  ownerTypes: readonly ESTree.TSType[],
  name: string | null,
  kind: ContractMemberKind,
  analysis: BoundaryAnalysis,
): boolean {
  return (
    name !== null &&
    ownerTypes.some((type) =>
      hasMemberOwnerContract(type, name, kind, () => semanticContracts(analysis)),
    )
  );
}

function reportObjectProperty(
  analysis: BoundaryAnalysis,
  property: ObjectProperty,
  ownerTypes: readonly ESTree.TSType[],
): void {
  if (!objectProperty(property)) return;
  const fn = callableExpression(property.value);
  if (fn === null) return;
  const name = propertyName(property.key, property.computed);
  const kind: ContractMemberKind = property.kind === "get" ? "get" : "method";
  const directContract = hasDirectReturnContract(analysis, fn);
  const contextualContract =
    !directContract && hasObjectOwnerContract(ownerTypes, name, kind, analysis);
  reportFunction(analysis, fn, contextualTypes(property.value), contextualContract);
}

function reportObject(
  analysis: BoundaryAnalysis,
  expression: ESTree.ObjectExpression,
  ownerTypes: readonly ESTree.TSType[],
): void {
  for (const property of expression.properties) {
    reportObjectProperty(analysis, property, ownerTypes);
  }
}

function reportVariableInitializer(
  analysis: BoundaryAnalysis,
  initializer: ESTree.Expression,
  ownerTypes: readonly ESTree.TSType[],
): void {
  const fn = callableExpression(initializer);
  if (fn !== null) {
    reportFunction(analysis, fn, ownerTypes);
    return;
  }
  const unwrapped = unwrapExpression(initializer);
  if (unwrapped.type === "ObjectExpression") reportObject(analysis, unwrapped, ownerTypes);
  else if (unwrapped.type === "ClassExpression") reportClass(analysis, unwrapped);
}

function reportVariable(analysis: BoundaryAnalysis, variable: ESTree.VariableDeclarator): void {
  if (variable.id.type !== "Identifier" || variable.init === null) return;
  const declaredType = variable.id.typeAnnotation?.typeAnnotation;
  const ownerTypes = [
    ...(declaredType === undefined ? [] : [declaredType]),
    ...contextualTypes(variable.init),
  ];
  reportVariableInitializer(analysis, variable.init, ownerTypes);
}

function reportDeclaration(analysis: BoundaryAnalysis, declaration: ESTree.Declaration): void {
  if (isFunctionNode(declaration)) {
    reportFunction(analysis, declaration);
  } else if (declaration.type === "ClassDeclaration") {
    reportClass(analysis, declaration);
  } else if (declaration.type === "VariableDeclaration") {
    for (const variable of declaration.declarations) reportVariable(analysis, variable);
  }
}

function reportNamedExport(
  analysis: BoundaryAnalysis,
  statement: ESTree.ExportNamedDeclaration,
): void {
  if (statement.exportKind === "type") return;
  if (statement.declaration !== null) reportDeclaration(analysis, statement.declaration);
  for (const name of exportedLocalNames(statement)) analysis.exportedLocals.add(name);
}

function reportNamedDefaultDeclaration(
  analysis: BoundaryAnalysis,
  declaration: ESTree.ExportDefaultDeclarationKind,
): declaration is NamedDefaultDeclaration {
  if (isFunctionNode(declaration)) {
    reportFunction(analysis, declaration);
    return true;
  }
  if (declaration.type === "ClassDeclaration" || declaration.type === "ClassExpression") {
    reportClass(analysis, declaration);
    return true;
  }
  if (declaration.type === "Identifier") {
    analysis.exportedLocals.add(declaration.name);
    return true;
  }
  return declaration.type === "TSInterfaceDeclaration";
}

function reportDefaultExport(
  analysis: BoundaryAnalysis,
  declaration: ESTree.ExportDefaultDeclarationKind,
): void {
  if (reportNamedDefaultDeclaration(analysis, declaration)) return;
  const fn = callableExpression(declaration);
  if (fn !== null) {
    reportFunction(analysis, fn, contextualTypes(declaration));
    return;
  }
  const unwrapped = unwrapExpression(declaration);
  if (unwrapped.type === "ObjectExpression") {
    reportObject(analysis, unwrapped, contextualTypes(declaration));
  }
}

function reportExportStatement(
  analysis: BoundaryAnalysis,
  statement: ESTree.Program["body"][number],
): void {
  if (statement.type === "ExportNamedDeclaration") {
    reportNamedExport(analysis, statement);
    return;
  }
  if (statement.type === "ExportDefaultDeclaration") {
    reportDefaultExport(analysis, statement.declaration);
  }
}

function reportProgramExports(program: ESTree.Program, analysis: BoundaryAnalysis): void {
  for (const statement of program.body) reportExportStatement(analysis, statement);
}

function reportLocalBinding(analysis: BoundaryAnalysis, declaration: TopLevelBinding): void {
  if (declaration.kind === "function") reportFunction(analysis, declaration.node);
  else if (declaration.kind === "class") reportClass(analysis, declaration.node);
  else reportVariable(analysis, declaration.node);
}

function reportExportedLocalBindings(analysis: BoundaryAnalysis): void {
  for (const name of analysis.exportedLocals) {
    for (const declaration of analysis.declarations.get(name) ?? []) {
      reportLocalBinding(analysis, declaration);
    }
  }
}

function reportTopLevelClasses(analysis: BoundaryAnalysis): void {
  for (const declaration of analysis.classes) reportClass(analysis, declaration);
}

function analyzeProgram(context: Context, sourceText: string, program: ESTree.Program): void {
  const comments = [...context.sourceCode.getAllComments()].sort(
    (left, right) => left.start - right.start,
  );
  const analysis = createBoundaryAnalysis(context, sourceText, comments);
  indexTopLevelDeclarations(program, analysis);
  reportProgramExports(program, analysis);
  reportExportedLocalBindings(analysis);
  reportTopLevelClasses(analysis);
}

export const explicitBoundaryReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require explicit return contracts on exported functions and public class methods and getters.",
    },
    messages: {
      missing: "Add an explicit return type or callable owner contract at this public boundary.",
    },
  },
  create(context: Context) {
    const sourceCode = context.sourceCode;
    return {
      Program(program) {
        analyzeProgram(context, sourceCode.text, program);
      },
    };
  },
});
