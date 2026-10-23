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

type ProjectConfiguration = {
  readonly configPath: string;
  readonly configText: string;
  readonly parsed: ts.ParsedCommandLine;
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
  if (!hasRelevantJSDocTag(commentValue)) return false;
  const sourceFile = ts.createSourceFile(
    "inline-jsdoc.js",
    `/**${commentValue}*/\nfunction __jsdocContract__() {}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = sourceFile.statements.find(ts.isFunctionDeclaration);
  if (declaration === undefined) return false;
  return (
    hasJSDocReturnTagContract(sourceFile, declaration) ||
    hasJSDocFunctionTypeTag(sourceFile, declaration)
  );
}

function hasRelevantJSDocTag(commentValue: string): boolean {
  return commentValue.includes("@return") || commentValue.includes("@type");
}

function hasJSDocReturnTagContract(
  sourceFile: ts.SourceFile,
  declaration: ts.FunctionDeclaration,
): boolean {
  const returnTag = ts.getJSDocReturnTag(declaration);
  return (
    returnTag?.typeExpression !== undefined &&
    !ts.isJSDocUnknownType(returnTag.typeExpression.type) &&
    completeJSDocType(sourceFile, returnTag.typeExpression)
  );
}

function isCallableJSDocType(type: ts.TypeNode): boolean {
  return (
    ts.isFunctionTypeNode(type) || ts.isJSDocFunctionType(type) || ts.isConstructorTypeNode(type)
  );
}

function hasJSDocFunctionTypeTag(
  sourceFile: ts.SourceFile,
  declaration: ts.FunctionDeclaration,
): boolean {
  const typeTag = ts.getJSDocTypeTag(declaration);
  return (
    typeTag !== undefined &&
    completeJSDocType(sourceFile, typeTag.typeExpression) &&
    isCallableJSDocType(typeTag.typeExpression.type)
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

function sourceModifiedTime(fileName: string): number {
  return ts.sys.getModifiedTime?.(fileName)?.getTime() ?? -1;
}

function sourceFileSize(fileName: string): number {
  return ts.sys.getFileSize?.(fileName) ?? -1;
}

function sourceFileSignature(fileName: string): string {
  return `${fileName}\0${sourceModifiedTime(fileName)}\0${sourceFileSize(fileName)}`;
}

function sourceSignature(program: ts.Program): string {
  return [...new Set(program.getSourceFiles().map((file) => canonicalPath(file.fileName)))]
    .sort()
    .map(sourceFileSignature)
    .join("\n");
}

function sourceFileFor(program: ts.Program, fileName: string): ts.SourceFile | undefined {
  const key = canonicalPath(fileName);
  return program.getSourceFiles().find((file) => canonicalPath(file.fileName) === key);
}

function classContainsPosition(
  candidate: ts.ClassLikeDeclaration,
  start: number,
  position: number,
): boolean {
  return start <= position && candidate.end >= position;
}

function candidateIsCloserClass(
  candidate: ts.ClassLikeDeclaration,
  start: number,
  closest: ts.ClassLikeDeclaration | undefined,
  sourceFile: ts.SourceFile,
): boolean {
  return (
    closest === undefined || candidate.end - start < closest.end - closest.getStart(sourceFile)
  );
}

function findClassAt(
  classes: readonly ts.ClassLikeDeclaration[],
  sourceFile: ts.SourceFile,
  position: number,
): ts.ClassLikeDeclaration | undefined {
  let closest: ts.ClassLikeDeclaration | undefined;
  for (const candidate of classes) {
    const start = candidate.getStart(sourceFile);
    if (
      classContainsPosition(candidate, start, position) &&
      candidateIsCloserClass(candidate, start, closest, sourceFile)
    ) {
      closest = candidate;
    }
  }
  return closest;
}

function shouldSkipStaticHeritage(heritage: ts.HeritageClause, isStatic: boolean): boolean {
  return isStatic && heritage.token === ts.SyntaxKind.ImplementsKeyword;
}

function inheritedOwnerType(
  checker: ts.TypeChecker,
  heritage: ts.HeritageClause,
  owner: ts.ExpressionWithTypeArguments,
  isStatic: boolean,
): ts.Type {
  return isStatic && heritage.token === ts.SyntaxKind.ExtendsKeyword
    ? checker.getTypeAtLocation(owner.expression)
    : checker.getTypeFromTypeNode(owner);
}

function heritageHasMemberContract(
  checker: ts.TypeChecker,
  heritage: ts.HeritageClause,
  name: string,
  kind: ContractMemberKind,
  isStatic: boolean,
): boolean {
  for (const owner of heritage.types) {
    if (shouldSkipStaticHeritage(heritage, isStatic)) continue;
    if (
      memberContract(checker, inheritedOwnerType(checker, heritage, owner, isStatic), name, kind)
    ) {
      return true;
    }
  }
  return false;
}

function classHasMemberContract(
  checker: ts.TypeChecker,
  classes: readonly ts.ClassLikeDeclaration[],
  sourceFile: ts.SourceFile,
  memberStart: number,
  name: string,
  kind: ContractMemberKind,
  isStatic: boolean,
): boolean {
  const declaration = findClassAt(classes, sourceFile, memberStart);
  for (const heritage of declaration?.heritageClauses ?? []) {
    if (heritageHasMemberContract(checker, heritage, name, kind, isStatic)) return true;
  }
  return false;
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

function hasDirectMemberText(
  name: ts.PropertyName,
): name is
  | ts.Identifier
  | ts.PrivateIdentifier
  | ts.StringLiteral
  | ts.NoSubstitutionTemplateLiteral
  | ts.NumericLiteral {
  return (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name) ||
    ts.isNumericLiteral(name)
  );
}

function memberName(name: ts.PropertyName): string | null {
  if (hasDirectMemberText(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return null;
  return ts.isStringLiteral(name.expression) ? name.expression.text : null;
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

type ContractMemberDeclaration =
  | ts.MethodSignature
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.PropertySignature
  | ts.PropertyDeclaration;

function isContractMemberDeclaration(
  declaration: ts.Declaration,
): declaration is ContractMemberDeclaration {
  return (
    ts.isMethodSignature(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isGetAccessorDeclaration(declaration) ||
    ts.isPropertySignature(declaration) ||
    ts.isPropertyDeclaration(declaration)
  );
}

function hasMatchingMemberNameAndType(
  declaration: ContractMemberDeclaration,
  name: string,
): boolean {
  return memberName(declaration.name) === name && declaration.type !== undefined;
}

function isGetterContractDeclaration(declaration: ContractMemberDeclaration): boolean {
  return (
    ts.isGetAccessorDeclaration(declaration) ||
    ts.isPropertySignature(declaration) ||
    ts.isPropertyDeclaration(declaration)
  );
}

function isMethodContractDeclaration(
  checker: ts.TypeChecker,
  declaration: ContractMemberDeclaration,
): boolean {
  if (ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)) return true;
  return declaration.type !== undefined && explicitCallableType(checker, declaration.type);
}

function declarationHasMemberContract(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  name: string,
  kind: ContractMemberKind,
): boolean {
  if (!isContractMemberDeclaration(declaration)) return false;
  if (!hasMatchingMemberNameAndType(declaration, name)) return false;
  return kind === "get"
    ? isGetterContractDeclaration(declaration)
    : isMethodContractDeclaration(checker, declaration);
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
      return classHasMemberContract(
        checker,
        index.classes,
        sourceFile,
        memberStart,
        name,
        kind,
        isStatic,
      );
    },
  };
}

function readProjectConfiguration(absoluteFilename: string): ProjectConfiguration | null {
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
  return { configPath, configText, parsed };
}

function projectRootNames(project: ProjectConfiguration, absoluteFilename: string): string[] {
  const rootNames = project.parsed.fileNames.map((fileName) => resolve(fileName));
  const absoluteKey = canonicalPath(absoluteFilename);
  const includesSource = rootNames.some((fileName) => canonicalPath(fileName) === absoluteKey);
  if (!includesSource) rootNames.push(absoluteFilename);
  return rootNames;
}

function cachedSettingsMatch(
  existing: CachedProgram,
  project: ProjectConfiguration,
  optionsKey: string,
  rootNamesKey: string,
): boolean {
  return (
    canonicalPath(existing.configPath) === canonicalPath(project.configPath) &&
    existing.configText === project.configText &&
    existing.optionsKey === optionsKey &&
    existing.rootNamesKey === rootNamesKey
  );
}

function cachedNoOverrideMatch(existing: CachedProgram, sourceOverride: string | null): boolean {
  return existing.overridePath === null && sourceOverride === null;
}

function cachedSourceOverrideMatch(
  existing: CachedProgram,
  absoluteFilename: string,
  sourceOverride: string | null,
): boolean {
  return (
    existing.overridePath !== null &&
    canonicalPath(existing.overridePath) === canonicalPath(absoluteFilename) &&
    existing.overrideText === sourceOverride
  );
}

function cachedOverrideMatch(
  existing: CachedProgram,
  absoluteFilename: string,
  sourceOverride: string | null,
): boolean {
  return (
    cachedNoOverrideMatch(existing, sourceOverride) ||
    cachedSourceOverrideMatch(existing, absoluteFilename, sourceOverride)
  );
}

function cachedProgramMatch(
  existing: CachedProgram,
  project: ProjectConfiguration,
  optionsKey: string,
  rootNamesKey: string,
  absoluteFilename: string,
  sourceOverride: string | null,
): boolean {
  if (!cachedSettingsMatch(existing, project, optionsKey, rootNamesKey)) return false;
  if (existing.fileSignature !== sourceSignature(existing.program)) return false;
  return cachedOverrideMatch(existing, absoluteFilename, sourceOverride);
}

function reusableProjectContracts(
  existing: CachedProgram,
  project: ProjectConfiguration,
  optionsKey: string,
  rootNamesKey: string,
  absoluteFilename: string,
  sourceOverride: string | null,
  sourceText: string,
): TypeScriptContracts | null {
  if (
    !cachedProgramMatch(
      existing,
      project,
      optionsKey,
      rootNamesKey,
      absoluteFilename,
      sourceOverride,
    )
  ) {
    return null;
  }
  const sourceFile = sourceFileFor(existing.program, absoluteFilename);
  if (sourceFile?.text !== sourceText) return null;
  return sessionFor(existing, sourceFile);
}

function createProgramContracts(
  absoluteFilename: string,
  sourceText: string,
  project: ProjectConfiguration,
  rootNames: string[],
  rootNamesKey: string,
  sourceOverride: string | null,
  optionsKey: string,
): TypeScriptContracts | null {
  const host = createHost(absoluteFilename, sourceText, project.parsed.options);
  const program = ts.createProgram({
    rootNames,
    options: project.parsed.options,
    ...(project.parsed.projectReferences === undefined
      ? {}
      : { projectReferences: project.parsed.projectReferences }),
    host,
  });
  const sourceFile = sourceFileFor(program, absoluteFilename);
  if (sourceFile?.text !== sourceText) return null;

  const entry: CachedProgram = {
    configPath: project.configPath,
    configText: project.configText,
    optionsKey,
    rootNamesKey,
    fileSignature: sourceSignature(program),
    overridePath: sourceOverride === null ? null : absoluteFilename,
    overrideText: sourceOverride,
    program,
    index: null,
  };
  cachedProgram = entry;
  return sessionFor(entry, sourceFile);
}

export function createTypeScriptContracts(
  filename: string,
  cwd: string,
  sourceText: string,
): TypeScriptContracts | null {
  const absoluteFilename = resolve(cwd, filename);
  const project = readProjectConfiguration(absoluteFilename);
  if (project === null) return null;
  const rootNames = projectRootNames(project, absoluteFilename);
  const projectRootKey = rootsKey(rootNames);
  const sourceOverride = ts.sys.readFile(absoluteFilename) === sourceText ? null : sourceText;
  const optionsKey = JSON.stringify(project.parsed.options);
  const existing = cachedProgram;
  if (existing !== null) {
    const reusable = reusableProjectContracts(
      existing,
      project,
      optionsKey,
      projectRootKey,
      absoluteFilename,
      sourceOverride,
      sourceText,
    );
    if (reusable !== null) return reusable;
  }
  return createProgramContracts(
    absoluteFilename,
    sourceText,
    project,
    rootNames,
    projectRootKey,
    sourceOverride,
    optionsKey,
  );
}
