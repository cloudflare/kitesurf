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
type TopLevelBinding =
  | { readonly kind: "function"; readonly node: ESTree.Function }
  | { readonly kind: "class"; readonly node: ESTree.Class }
  | { readonly kind: "variable"; readonly node: ESTree.VariableDeclarator };
type FunctionCandidate =
  | ESTree.Declaration
  | ESTree.ExportDefaultDeclarationKind
  | ESTree.Program["body"][number];

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

function propertyName(key: PropertyKey, computed: boolean): string | null {
  if (!computed && key.type === "Identifier") return key.name;
  if (key.type !== "Literal") return null;
  return typeof key.value === "string" ||
    typeof key.value === "number" ||
    typeof key.value === "bigint"
    ? String(key.value)
    : null;
}

function hasCallableOwnerContract(
  type: ESTree.TSType,
  contracts: () => TypeScriptContracts | null,
): boolean {
  if (type.type === "TSFunctionType" || type.type === "TSConstructorType") return true;
  if (type.type === "TSParenthesizedType") {
    return hasCallableOwnerContract(type.typeAnnotation, contracts);
  }
  if (type.type === "TSTypeLiteral") {
    return type.members.some(
      (member) => member.type === "TSCallSignatureDeclaration" && member.returnType !== null,
    );
  }
  switch (type.type) {
    case "TSTypeReference":
    case "TSImportType":
    case "TSTypeQuery":
    case "TSUnionType":
    case "TSIntersectionType":
    case "TSConditionalType":
    case "TSIndexedAccessType":
      return contracts()?.hasCallableType(type.start, type.end) ?? false;
    default:
      return false;
  }
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
  switch (type.type) {
    case "TSTypeReference":
    case "TSImportType":
    case "TSTypeQuery":
    case "TSUnionType":
    case "TSIntersectionType":
    case "TSConditionalType":
    case "TSIndexedAccessType":
      return contracts()?.hasMemberType(type.start, type.end, name, kind) ?? false;
    default:
      return false;
  }
}

function jsDocContract(comment: ESTree.Comment | null): boolean {
  if (comment === null || comment.type !== "Block") return false;
  return parseJSDocReturnContract(comment.value);
}

function precedingJSDocComment(
  sourceText: string,
  comments: readonly ESTree.Comment[],
  node: ESTree.Node,
): ESTree.Comment | null {
  let low = 0;
  let high = comments.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const comment = comments[middle];
    if (comment !== undefined && comment.end <= node.start) low = middle + 1;
    else high = middle;
  }

  const comment = comments[low - 1];
  if (
    comment === undefined ||
    comment.type !== "Block" ||
    !sourceText.slice(comment.start, comment.end).startsWith("/**") ||
    sourceText.slice(comment.end, node.start).trim().length > 0
  ) {
    return null;
  }
  return comment;
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
  if (
    statement.exportKind === "type" ||
    statement.source !== null ||
    statement.declaration !== null
  ) {
    return [];
  }
  const names: string[] = [];
  for (const specifier of statement.specifiers) {
    if (specifier.exportKind === "type" || specifier.local.type !== "Identifier") continue;
    names.push(specifier.local.name);
  }
  return names;
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
        const comments = [...sourceCode.getAllComments()].sort(
          (left, right) => left.start - right.start,
        );
        const declarations = new Map<string, TopLevelBinding[]>();
        const functions = new Map<string, ESTree.Function[]>();
        const classes: ESTree.Class[] = [];
        const exportedLocals = new Set<string>();
        const analyzed = new Set<ESTree.Node>();
        let semanticContracts: TypeScriptContracts | null | undefined;

        const getSemanticContracts = (): TypeScriptContracts | null => {
          if (semanticContracts === undefined) {
            semanticContracts = createTypeScriptContracts(
              context.filename,
              context.cwd,
              sourceCode.text,
            );
          }
          return semanticContracts;
        };

        const addDeclaration = (name: string, declaration: TopLevelBinding): void => {
          const existing = declarations.get(name);
          if (existing === undefined) declarations.set(name, [declaration]);
          else existing.push(declaration);
        };

        for (const statement of program.body) {
          const declaration =
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          if (declaration === null) continue;

          if (isFunctionNode(declaration)) {
            if (declaration.id === null) continue;
            addDeclaration(declaration.id.name, { kind: "function", node: declaration });
            const existing = functions.get(declaration.id.name);
            if (existing === undefined) functions.set(declaration.id.name, [declaration]);
            else existing.push(declaration);
          } else if (declaration.type === "ClassDeclaration") {
            classes.push(declaration);
            if (declaration.id !== null) {
              addDeclaration(declaration.id.name, { kind: "class", node: declaration });
            }
          } else if (declaration.type === "VariableDeclaration") {
            for (const variable of declaration.declarations) {
              if (variable.id.type === "Identifier") {
                addDeclaration(variable.id.name, { kind: "variable", node: variable });
              }
            }
          }
        }

        const functionHasReturnContract = (
          fn: CallableNode,
          ownerTypes: readonly ESTree.TSType[],
        ): boolean =>
          (fn.returnType !== undefined && fn.returnType !== null) ||
          hasJSDocContract(sourceCode.text, comments, fn) ||
          ownerTypes.some((type) => hasCallableOwnerContract(type, getSemanticContracts));

        const hasFunctionOverloadContract = (fn: CallableNode): boolean => {
          if (
            (fn.type !== "FunctionDeclaration" && fn.type !== "TSDeclareFunction") ||
            fn.id === null
          ) {
            return false;
          }
          return (functions.get(fn.id.name) ?? []).some(
            (signature) =>
              signature !== fn &&
              signature.body === null &&
              functionHasReturnContract(signature, []),
          );
        };

        const reportFunction = (
          fn: CallableNode,
          ownerTypes: readonly ESTree.TSType[] = [],
          contextualContract = false,
        ): void => {
          if (analyzed.has(fn)) return;
          analyzed.add(fn);
          if (
            contextualContract ||
            functionHasReturnContract(fn, ownerTypes) ||
            hasFunctionOverloadContract(fn)
          ) {
            return;
          }
          context.report({ node: fn, messageId: "missing" });
        };

        const classMethodHasOverloadContract = (
          declaration: ESTree.Class,
          method: ESTree.MethodDefinition,
          name: string,
        ): boolean =>
          declaration.body.body.some((element) => {
            if (
              (element.type !== "MethodDefinition" &&
                element.type !== "TSAbstractMethodDefinition") ||
              element === method ||
              element.kind !== method.kind ||
              element.static !== method.static ||
              propertyName(element.key, element.computed) !== name ||
              element.value.body !== null
            ) {
              return false;
            }
            return functionHasReturnContract(element.value, []);
          });

        const reportClass = (declaration: ESTree.Class): void => {
          if (analyzed.has(declaration)) return;
          analyzed.add(declaration);
          for (const element of declaration.body.body) {
            if (
              (element.type !== "MethodDefinition" &&
                element.type !== "TSAbstractMethodDefinition") ||
              element.kind === "constructor" ||
              element.kind === "set" ||
              element.accessibility === "private" ||
              element.accessibility === "protected" ||
              element.key.type === "PrivateIdentifier"
            ) {
              continue;
            }
            const name = propertyName(element.key, element.computed);
            const kind: ContractMemberKind = element.kind === "get" ? "get" : "method";
            const directContract =
              (element.value.returnType !== undefined && element.value.returnType !== null) ||
              hasJSDocContract(sourceCode.text, comments, element.value);
            const overloadContract =
              !directContract &&
              name !== null &&
              classMethodHasOverloadContract(declaration, element, name);
            const hasTypeOwners =
              declaration.superClass !== null || (declaration.implements?.length ?? 0) > 0;
            const ownerContract =
              !directContract &&
              !overloadContract &&
              hasTypeOwners &&
              name !== null &&
              getSemanticContracts()?.hasClassMember(element.start, name, kind, element.static) ===
                true;
            reportFunction(element.value, [], directContract || overloadContract || ownerContract);
          }
        };

        const reportObject = (
          expression: ESTree.ObjectExpression,
          ownerTypes: readonly ESTree.TSType[],
        ): void => {
          for (const property of expression.properties) {
            if (property.type !== "Property" || property.kind === "set") continue;
            const fn = callableExpression(property.value);
            if (fn === null) continue;
            const name = propertyName(property.key, property.computed);
            const kind: ContractMemberKind = property.kind === "get" ? "get" : "method";
            const directContract =
              (fn.returnType !== undefined && fn.returnType !== null) ||
              hasJSDocContract(sourceCode.text, comments, fn);
            const contextualContract =
              !directContract &&
              name !== null &&
              ownerTypes.some((type) =>
                hasMemberOwnerContract(type, name, kind, getSemanticContracts),
              );
            reportFunction(fn, contextualTypes(property.value), contextualContract);
          }
        };

        const reportVariable = (variable: ESTree.VariableDeclarator): void => {
          if (variable.id.type !== "Identifier" || variable.init === null) return;
          const declaredType = variable.id.typeAnnotation?.typeAnnotation;
          const ownerTypes = [
            ...(declaredType === undefined ? [] : [declaredType]),
            ...contextualTypes(variable.init),
          ];
          const fn = callableExpression(variable.init);
          if (fn !== null) {
            reportFunction(fn, ownerTypes);
            return;
          }
          const unwrapped = unwrapExpression(variable.init);
          if (unwrapped.type === "ObjectExpression") reportObject(unwrapped, ownerTypes);
          else if (unwrapped.type === "ClassExpression") reportClass(unwrapped);
        };

        const reportDeclaration = (declaration: ESTree.Declaration): void => {
          if (isFunctionNode(declaration)) {
            reportFunction(declaration);
          } else if (declaration.type === "ClassDeclaration") {
            reportClass(declaration);
          } else if (declaration.type === "VariableDeclaration") {
            for (const variable of declaration.declarations) reportVariable(variable);
          }
        };

        for (const statement of program.body) {
          if (statement.type === "ExportNamedDeclaration") {
            if (statement.exportKind === "type") continue;
            if (statement.declaration !== null) {
              reportDeclaration(statement.declaration);
            }
            for (const name of exportedLocalNames(statement)) exportedLocals.add(name);
            continue;
          }
          if (statement.type !== "ExportDefaultDeclaration") continue;

          const declaration = statement.declaration;
          if (isFunctionNode(declaration)) {
            reportFunction(declaration);
            continue;
          }
          if (declaration.type === "ClassDeclaration" || declaration.type === "ClassExpression") {
            reportClass(declaration);
            continue;
          }
          if (declaration.type === "Identifier") {
            exportedLocals.add(declaration.name);
            continue;
          }
          if (declaration.type === "TSInterfaceDeclaration") continue;

          const fn = callableExpression(declaration);
          if (fn !== null) {
            reportFunction(fn, contextualTypes(declaration));
            continue;
          }
          const unwrapped = unwrapExpression(declaration);
          if (unwrapped.type === "ObjectExpression") {
            reportObject(unwrapped, contextualTypes(declaration));
          }
        }

        for (const name of exportedLocals) {
          for (const declaration of declarations.get(name) ?? []) {
            if (declaration.kind === "function") reportFunction(declaration.node);
            else if (declaration.kind === "class") reportClass(declaration.node);
            else reportVariable(declaration.node);
          }
        }

        for (const declaration of classes) reportClass(declaration);
      },
    };
  },
});
