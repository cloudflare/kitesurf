// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { dirname, resolve } from "node:path";
import ts from "typescript";

export type ContractMemberKind = "method" | "get";

export type TypeScriptContracts = {
  hasCallableType(start: number, end: number): boolean;
  hasMemberType(start: number, end: number, name: string, kind: ContractMemberKind): boolean;
  hasClassMember(
    memberStart: number,
    name: string,
    kind: ContractMemberKind,
    isStatic: boolean,
  ): boolean;
};

type SourceIndex = {
  readonly fileName: string;
  readonly classes: readonly ts.ClassLikeDeclaration[];
  readonly types: ReadonlyMap<string, ts.TypeNode>;
};

type CachedProgram = {
  readonly configPath: string;
  readonly configText: string;
  readonly optionsKey: string;
  readonly rootNamesKey: string;
  readonly fileSignature: string;
  readonly overridePath: string | null;
  readonly overrideText: string | null;
  readonly program: ts.Program;
  index: SourceIndex | null;
};

let cachedProgram: CachedProgram | null = null;

export function hasJSDocReturnContract(commentValue: string): boolean {
  if (!commentValue.includes("@return") && !commentValue.includes("@type")) return false;
  const sourceFile = ts.createSourceFile(
    "inline-jsdoc.js",
    `/**${commentValue}*/\nfunction __jsdocContract__() {}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = sourceFile.statements.find(ts.isFunctionDeclaration);
  if (declaration === undefined) return false;

  const returnTag = ts.getJSDocReturnTag(declaration);
  if (
    returnTag?.typeExpression !== undefined &&
    !ts.isJSDocUnknownType(returnTag.typeExpression.type) &&
    completeJSDocType(sourceFile, returnTag.typeExpression)
  ) {
    return true;
  }
  const typeTag = ts.getJSDocTypeTag(declaration);
  if (typeTag === undefined || !completeJSDocType(sourceFile, typeTag.typeExpression)) return false;
  const type = typeTag.typeExpression.type;
  return (
    ts.isFunctionTypeNode(type) || ts.isJSDocFunctionType(type) || ts.isConstructorTypeNode(type)
  );
}

function completeJSDocType(sourceFile: ts.SourceFile, expression: ts.JSDocTypeExpression): boolean {
  const text = sourceFile.text.slice(expression.getStart(sourceFile), expression.end).trim();
  return text.startsWith("{") && text.endsWith("}") && expression.type.end < expression.end;
}

function canonicalPath(fileName: string): string {
  const absolute = resolve(fileName);
  return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
}

function keyRange(start: number, end: number): string {
  return `${start}:${end}`;
}

function rootsKey(fileNames: readonly string[]): string {
  return fileNames.map(canonicalPath).sort().join("\n");
}

function sourceSignature(program: ts.Program): string {
  return [...new Set(program.getSourceFiles().map((file) => canonicalPath(file.fileName)))]
    .sort()
    .map((fileName) => {
      const modified = ts.sys.getModifiedTime?.(fileName)?.getTime() ?? -1;
      const size = ts.sys.getFileSize?.(fileName) ?? -1;
      return `${fileName}\0${modified}\0${size}`;
    })
    .join("\n");
}

function sourceFileFor(program: ts.Program, fileName: string): ts.SourceFile | undefined {
  const key = canonicalPath(fileName);
  return program.getSourceFiles().find((file) => canonicalPath(file.fileName) === key);
}

function createHost(
  fileName: string,
  sourceText: string,
  options: ts.CompilerOptions,
): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const sameFile = (candidate: string): boolean =>
    canonicalPath(candidate) === canonicalPath(fileName);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (candidate) => sameFile(candidate) || fileExists(candidate);
  host.readFile = (candidate) => (sameFile(candidate) ? sourceText : readFile(candidate));
  host.getSourceFile = (candidate, languageVersion, onError, createNew) =>
    sameFile(candidate)
      ? ts.createSourceFile(candidate, sourceText, languageVersion, true)
      : getSourceFile(candidate, languageVersion, onError, createNew);

  const getSourceFileByPath = host.getSourceFileByPath?.bind(host);
  if (getSourceFileByPath !== undefined) {
    host.getSourceFileByPath = (candidate, path, languageVersion, onError, createNew) =>
      sameFile(candidate)
        ? ts.createSourceFile(candidate, sourceText, languageVersion, true)
        : getSourceFileByPath(candidate, path, languageVersion, onError, createNew);
  }
  return host;
}

function indexSourceFile(sourceFile: ts.SourceFile): SourceIndex {
  const classes: ts.ClassLikeDeclaration[] = [];
  const types = new Map<string, ts.TypeNode>();
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) classes.push(node);
    if (ts.isTypeNode(node)) types.set(keyRange(node.getStart(sourceFile), node.end), node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { fileName: sourceFile.fileName, classes, types };
}

function memberName(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)
    ? name.expression.text
    : null;
}

function explicitReturn(signature: ts.Signature): boolean {
  return signature.getDeclaration()?.type !== undefined;
}

function broad(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0;
}

function explicitCallableType(checker: ts.TypeChecker, node: ts.TypeNode): boolean {
  const type = checker.getNonNullableType(checker.getTypeFromTypeNode(node));
  return (
    !broad(type) && checker.getSignaturesOfType(type, ts.SignatureKind.Call).some(explicitReturn)
  );
}

function declarationHasMemberContract(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  name: string,
  kind: ContractMemberKind,
): boolean {
  if (
    !ts.isMethodSignature(declaration) &&
    !ts.isMethodDeclaration(declaration) &&
    !ts.isGetAccessorDeclaration(declaration) &&
    !ts.isPropertySignature(declaration) &&
    !ts.isPropertyDeclaration(declaration)
  ) {
    return false;
  }
  if (memberName(declaration.name) !== name || declaration.type === undefined) return false;
  if (kind === "get") {
    return (
      ts.isGetAccessorDeclaration(declaration) ||
      ts.isPropertySignature(declaration) ||
      ts.isPropertyDeclaration(declaration)
    );
  }
  return ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)
    ? true
    : explicitCallableType(checker, declaration.type);
}

function memberContract(
  checker: ts.TypeChecker,
  ownerType: ts.Type,
  name: string,
  kind: ContractMemberKind,
): boolean {
  if (broad(ownerType)) return false;
  const property = checker.getPropertyOfType(ownerType, name);
  return (property?.getDeclarations() ?? []).some((declaration) =>
    declarationHasMemberContract(checker, declaration, name, kind),
  );
}

function sessionFor(cached: CachedProgram, sourceFile: ts.SourceFile): TypeScriptContracts {
  if (
    cached.index === null ||
    canonicalPath(cached.index.fileName) !== canonicalPath(sourceFile.fileName)
  ) {
    cached.index = indexSourceFile(sourceFile);
  }
  const index = cached.index;
  const checker = cached.program.getTypeChecker();
  const typeAt = (start: number, end: number): ts.TypeNode | undefined =>
    index.types.get(keyRange(start, end));
  const classAt = (position: number): ts.ClassLikeDeclaration | undefined => {
    let closest: ts.ClassLikeDeclaration | undefined;
    for (const candidate of index.classes) {
      const start = candidate.getStart(sourceFile);
      if (
        start <= position &&
        candidate.end >= position &&
        (closest === undefined ||
          candidate.end - start < closest.end - closest.getStart(sourceFile))
      ) {
        closest = candidate;
      }
    }
    return closest;
  };

  return {
    hasCallableType(start, end) {
      const node = typeAt(start, end);
      return node !== undefined && explicitCallableType(checker, node);
    },
    hasMemberType(start, end, name, kind) {
      const node = typeAt(start, end);
      return (
        node !== undefined && memberContract(checker, checker.getTypeFromTypeNode(node), name, kind)
      );
    },
    hasClassMember(memberStart, name, kind, isStatic) {
      const declaration = classAt(memberStart);
      for (const heritage of declaration?.heritageClauses ?? []) {
        for (const owner of heritage.types) {
          if (isStatic && heritage.token === ts.SyntaxKind.ImplementsKeyword) continue;
          const ownerType =
            isStatic && heritage.token === ts.SyntaxKind.ExtendsKeyword
              ? checker.getTypeAtLocation(owner.expression)
              : checker.getTypeFromTypeNode(owner);
          if (memberContract(checker, ownerType, name, kind)) return true;
        }
      }
      return false;
    },
  };
}

export function createTypeScriptContracts(
  filename: string,
  cwd: string,
  sourceText: string,
): TypeScriptContracts | null {
  const absoluteFilename = resolve(cwd, filename);
  const configPath = ts.findConfigFile(dirname(absoluteFilename), ts.sys.fileExists);
  if (configPath === undefined) return null;
  const configText = ts.sys.readFile(configPath);
  if (configText === undefined) return null;
  const config = ts.parseConfigFileTextToJson(configPath, configText);
  if (config.error !== undefined) return null;
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
    { noEmit: true },
    configPath,
  );
  if (parsed.errors.length > 0) return null;

  const rootNames = parsed.fileNames.map((fileName) => resolve(fileName));
  if (!rootNames.some((fileName) => canonicalPath(fileName) === canonicalPath(absoluteFilename))) {
    rootNames.push(absoluteFilename);
  }
  const projectRootKey = rootsKey(rootNames);
  const sourceOverride = ts.sys.readFile(absoluteFilename) === sourceText ? null : sourceText;
  const existing = cachedProgram;
  if (
    existing !== null &&
    canonicalPath(existing.configPath) === canonicalPath(configPath) &&
    existing.configText === configText &&
    existing.optionsKey === JSON.stringify(parsed.options) &&
    existing.rootNamesKey === projectRootKey &&
    existing.fileSignature === sourceSignature(existing.program) &&
    ((existing.overridePath === null && sourceOverride === null) ||
      (existing.overridePath !== null &&
        canonicalPath(existing.overridePath) === canonicalPath(absoluteFilename) &&
        existing.overrideText === sourceOverride))
  ) {
    const sourceFile = sourceFileFor(existing.program, absoluteFilename);
    if (sourceFile?.text === sourceText) return sessionFor(existing, sourceFile);
  }

  const host = createHost(absoluteFilename, sourceText, parsed.options);
  const program = ts.createProgram({
    rootNames,
    options: parsed.options,
    ...(parsed.projectReferences === undefined
      ? {}
      : { projectReferences: parsed.projectReferences }),
    host,
  });
  const sourceFile = sourceFileFor(program, absoluteFilename);
  if (sourceFile?.text !== sourceText) return null;

  const entry: CachedProgram = {
    configPath,
    configText,
    optionsKey: JSON.stringify(parsed.options),
    rootNamesKey: projectRootKey,
    fileSignature: sourceSignature(program),
    overridePath: sourceOverride === null ? null : absoluteFilename,
    overrideText: sourceOverride,
    program,
    index: null,
  };
  cachedProgram = entry;
  return sessionFor(entry, sourceFile);
}
