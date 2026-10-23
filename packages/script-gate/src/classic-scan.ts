// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Scans classic scripts for top-level declarations used by the Boa globalizer.

export interface TopLevelDeclScan {
  names: string[];
  varSites: number[];
  varNames: string[];
  varSiteNames: string[][];
}

type TopLevelKeyword = "var" | "let" | "const" | "function" | "class";
type StringDelimiter = "" | '"' | "'" | "`";

const DECLARATION_KEYWORDS: ReadonlyMap<string, TopLevelKeyword> = new Map([
  ["var", "var"],
  ["let", "let"],
  ["const", "const"],
  ["function", "function"],
  ["class", "class"],
]);

const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
]);
const REGEX_CANNOT_FOLLOW = new Set([")", "]", '"', "'", "`"]);

interface InitializerState {
  position: number;
  braceDepth: number;
  parenDepth: number;
  bracketDepth: number;
  stringDelimiter: StringDelimiter;
  stopped: boolean;
}

// This bounded scan recognizes common top-level declarations; it is not a JavaScript parser.
class DeclarationScanner {
  private readonly source: string;
  private readonly sourceLength: number;
  private readonly names: string[] = [];
  private readonly seen = new Set<string>();
  private readonly varSites: number[] = [];
  private readonly varNames: string[] = [];
  private readonly varSeen = new Set<string>();
  private readonly varSiteNames: string[][] = [];
  private readonly identifierPattern = /[a-zA-Z_$][\w$]*/y;
  private sourceOffset = 0;
  private braceDepth = 0;
  private parenDepth = 0;
  private bracketDepth = 0;
  private stringDelimiter: StringDelimiter = "";
  private inLineComment = false;
  private inBlockComment = false;

  constructor(source: string) {
    this.source = source;
    this.sourceLength = source.length;
  }

  scan(): TopLevelDeclScan {
    while (this.sourceOffset < this.sourceLength) this.advanceSource();
    return {
      names: this.names,
      varSites: this.varSites,
      varNames: this.varNames,
      varSiteNames: this.varSiteNames,
    };
  }

  private advanceSource(): void {
    if (this.advanceNonCode()) return;
    if (this.advanceRegex()) return;
    if (this.advanceDelimiter()) return;
    if (this.advanceTopLevelDeclaration()) return;
    this.sourceOffset++;
  }

  private advanceNonCode(): boolean {
    if (this.advanceExistingNonCode()) return true;
    return this.advanceNonCodeStart();
  }

  private advanceExistingNonCode(): boolean {
    if (this.inLineComment) {
      if (this.source[this.sourceOffset] === "\n") this.inLineComment = false;
      this.sourceOffset++;
      return true;
    }
    if (this.inBlockComment) {
      this.advanceBlockComment();
      return true;
    }
    return this.advanceExistingString();
  }

  private advanceBlockComment(): void {
    if (this.source[this.sourceOffset] === "*" && this.source[this.sourceOffset + 1] === "/") {
      this.inBlockComment = false;
      this.sourceOffset += 2;
      return;
    }
    this.sourceOffset++;
  }

  private advanceExistingString(): boolean {
    if (!this.stringDelimiter) return false;
    const currentChar = this.source[this.sourceOffset];
    if (currentChar === "\\") {
      this.sourceOffset += 2;
      return true;
    }
    if (currentChar === this.stringDelimiter) this.stringDelimiter = "";
    this.sourceOffset++;
    return true;
  }

  private advanceNonCodeStart(): boolean {
    if (this.startStringLiteral()) return true;
    return this.startComment();
  }

  private startStringLiteral(): boolean {
    const character = this.source[this.sourceOffset];
    if (!isStringDelimiter(character)) return false;
    this.stringDelimiter = character;
    this.sourceOffset++;
    return true;
  }

  private startComment(): boolean {
    if (this.source[this.sourceOffset] !== "/") return false;
    if (this.source[this.sourceOffset + 1] === "/") {
      this.inLineComment = true;
      this.sourceOffset += 2;
      return true;
    }
    if (this.source[this.sourceOffset + 1] === "*") {
      this.inBlockComment = true;
      this.sourceOffset += 2;
      return true;
    }
    return false;
  }

  private advanceRegex(): boolean {
    if (this.source[this.sourceOffset] !== "/") return false;
    const end = this.regexEnd(this.sourceOffset);
    if (end < 0) return false;
    this.sourceOffset = end;
    return true;
  }

  private advanceDelimiter(): boolean {
    switch (this.source[this.sourceOffset]) {
      case "{":
        this.braceDepth++;
        break;
      case "}":
        if (this.braceDepth > 0) this.braceDepth--;
        break;
      case "(":
        this.parenDepth++;
        break;
      case ")":
        if (this.parenDepth > 0) this.parenDepth--;
        break;
      case "[":
        this.bracketDepth++;
        break;
      case "]":
        if (this.bracketDepth > 0) this.bracketDepth--;
        break;
      default:
        return false;
    }
    this.sourceOffset++;
    return true;
  }

  private advanceTopLevelDeclaration(): boolean {
    if (!this.isAtTopLevel()) return false;
    const keyword = this.declarationKeywordAt(this.sourceOffset);
    if (keyword === null) return false;
    const declarationEnd = this.consumeDeclaration(keyword, this.sourceOffset);
    if (declarationEnd === null) return false;
    this.sourceOffset = declarationEnd;
    return true;
  }

  private isAtTopLevel(): boolean {
    return this.braceDepth === 0 && this.parenDepth === 0 && this.bracketDepth === 0;
  }

  private isAtomStart(sourceIndex: number): boolean {
    return sourceIndex === 0 || !/[\w$]/.test(this.source.charAt(sourceIndex - 1));
  }

  private readIdentifier(startIndex: number): { name: string; end: number } | null {
    this.identifierPattern.lastIndex = startIndex;
    const match = this.identifierPattern.exec(this.source);
    if (!match || match.index !== startIndex) return null;
    return { name: match[0], end: startIndex + match[0].length };
  }

  private skipDeclarationTrivia(startIndex: number): number {
    let position = startIndex;
    while (position < this.sourceLength) {
      if (isDeclarationWhitespace(this.source[position])) {
        position++;
        continue;
      }
      const commentEnd = skipDeclarationComment(this.source, position, this.sourceLength);
      if (commentEnd === null) break;
      position = commentEnd;
    }
    return position;
  }

  private isPropertyName(wordStart: number): boolean {
    if (this.source.charAt(wordStart - 1) === "#") return true;
    let previousIndex = wordStart - 1;
    while (previousIndex >= 0 && /\s/.test(this.source.charAt(previousIndex))) previousIndex--;
    return (
      this.source.charAt(previousIndex) === "." && this.source.charAt(previousIndex - 1) !== "."
    );
  }

  private regexCanFollowWord(previousIndex: number): boolean {
    let previousWordStart = previousIndex;
    while (previousWordStart > 0 && /[\w$]/.test(this.source.charAt(previousWordStart - 1))) {
      previousWordStart--;
    }
    return (
      REGEX_AFTER_WORD.has(this.source.slice(previousWordStart, previousIndex + 1)) &&
      !this.isPropertyName(previousWordStart)
    );
  }

  private canStartRegex(slashIndex: number): boolean {
    let previousIndex = slashIndex - 1;
    while (previousIndex >= 0 && /\s/.test(this.source.charAt(previousIndex))) previousIndex--;
    if (previousIndex < 0) return true;
    const previousCharacter = this.source.charAt(previousIndex);
    if (/[\w$]/.test(previousCharacter)) return this.regexCanFollowWord(previousIndex);
    return !isRegexForbiddenAfterCharacter(this.source, previousCharacter, previousIndex);
  }

  private regexEnd(slashIndex: number): number {
    if (!this.canStartRegex(slashIndex)) return -1;
    const bodyEnd = this.scanRegexBody(slashIndex);
    if (bodyEnd < 0) return -1;
    return skipRegexFlags(this.source, bodyEnd, this.sourceLength);
  }

  private scanRegexBody(slashIndex: number): number {
    const state: RegexState = {
      position: slashIndex + 1,
      insideCharacterClass: false,
      hasClosingSlash: false,
    };
    while (state.position < this.sourceLength) {
      if (!this.advanceRegexCharacter(state)) return -1;
      if (state.hasClosingSlash) return state.position;
    }
    return -1;
  }

  private advanceRegexCharacter(state: RegexState): boolean {
    if (this.advanceRegexEscape(state)) return true;
    if (this.source.charAt(state.position) === "\n") return false;
    if (state.insideCharacterClass) return this.advanceRegexCharacterClass(state);
    return this.advanceRegexOutsideCharacterClass(state);
  }

  private advanceRegexEscape(state: RegexState): boolean {
    if (this.source.charAt(state.position) !== "\\") return false;
    state.position += 2;
    return true;
  }

  private advanceRegexCharacterClass(state: RegexState): boolean {
    if (this.source.charAt(state.position) === "]") state.insideCharacterClass = false;
    state.position++;
    return true;
  }

  private advanceRegexOutsideCharacterClass(state: RegexState): boolean {
    switch (this.source.charAt(state.position)) {
      case "[":
        state.insideCharacterClass = true;
        state.position++;
        return true;
      case "/":
        state.position++;
        state.hasClosingSlash = true;
        return true;
      default:
        state.position++;
        return true;
    }
  }

  private consumeKeywordAt(sourceIndex: number, keyword: string): boolean {
    if (this.source.slice(sourceIndex, sourceIndex + keyword.length) !== keyword) return false;
    if (!this.isAtomStart(sourceIndex)) return false;
    return !/[\w$]/.test(this.source.charAt(sourceIndex + keyword.length));
  }

  private addName(name: string): void {
    if (this.seen.has(name)) return;
    this.seen.add(name);
    this.names.push(name);
  }

  private skipInitializer(startIndex: number): number {
    const state: InitializerState = {
      position: startIndex,
      braceDepth: 0,
      parenDepth: 0,
      bracketDepth: 0,
      stringDelimiter: "",
      stopped: false,
    };
    while (state.position < this.sourceLength && !state.stopped) {
      if (!this.advanceInitializer(state)) break;
    }
    return state.position;
  }

  private advanceInitializer(state: InitializerState): boolean {
    if (this.advanceInitializerString(state)) return true;
    if (this.advanceInitializerTrivia(state)) return true;
    if (this.advanceInitializerRegex(state)) return true;
    const depth = this.advanceInitializerDepth(state);
    if (depth !== null) return depth;
    state.position++;
    return true;
  }

  private advanceInitializerString(state: InitializerState): boolean {
    if (state.stringDelimiter) {
      if (this.source[state.position] === "\\") {
        state.position += 2;
        return true;
      }
      if (this.source[state.position] === state.stringDelimiter) state.stringDelimiter = "";
      state.position++;
      return true;
    }
    const character = this.source[state.position];
    if (!isStringDelimiter(character)) return false;
    state.stringDelimiter = character;
    state.position++;
    return true;
  }

  private advanceInitializerTrivia(state: InitializerState): boolean {
    if (this.source[state.position] !== "/") return false;
    const commentEnd = skipInitializerComment(this.source, state.position, this.sourceLength);
    if (commentEnd === null) return false;
    state.position = commentEnd;
    return true;
  }

  private advanceInitializerRegex(state: InitializerState): boolean {
    if (this.source[state.position] !== "/") return false;
    const regexEndPosition = this.regexEnd(state.position);
    if (regexEndPosition <= 0) return false;
    state.position = regexEndPosition;
    return true;
  }

  private advanceInitializerDepth(state: InitializerState): boolean | null {
    switch (this.source[state.position]) {
      case "{":
        state.braceDepth++;
        break;
      case "}":
        if (state.braceDepth === 0) {
          state.stopped = true;
          return true;
        }
        state.braceDepth--;
        break;
      case "(":
        state.parenDepth++;
        break;
      case ")":
        state.parenDepth = decrementDepth(state.parenDepth);
        break;
      case "[":
        state.bracketDepth++;
        break;
      case "]":
        state.bracketDepth = decrementDepth(state.bracketDepth);
        break;
      default:
        if (isInitializerSeparator(state, this.source[state.position])) return false;
        return null;
    }
    state.position++;
    return true;
  }

  private scanVariableDeclaration(
    keyword: "var" | "let" | "const",
    keywordStart: number,
    startIndex: number,
  ): number {
    const canStripVarDeclaration = this.canStripVarDeclaration(keyword, startIndex);
    const namesAtVarSite: string[] = [];
    if (canStripVarDeclaration) {
      this.varSites.push(keywordStart);
      this.varSiteNames.push(namesAtVarSite);
    }
    let position = startIndex;
    while (position < this.sourceLength) {
      position = this.skipDeclarationTrivia(position);
      const identifier = this.readIdentifier(position);
      if (!identifier) break;
      this.addName(identifier.name);
      this.recordVarName(identifier.name, canStripVarDeclaration, namesAtVarSite);
      position = this.skipInitializer(identifier.end);
      if (this.source[position] !== ",") break;
      position++;
    }
    return position;
  }

  private canStripVarDeclaration(keyword: "var" | "let" | "const", startIndex: number): boolean {
    return keyword === "var" && this.readIdentifier(startIndex) !== null;
  }

  private recordVarName(
    name: string,
    canStripVarDeclaration: boolean,
    namesAtVarSite: string[],
  ): void {
    if (!canStripVarDeclaration) return;
    namesAtVarSite.push(name);
    if (this.varSeen.has(name)) return;
    this.varSeen.add(name);
    this.varNames.push(name);
  }

  private declarationKeywordAt(sourceIndex: number): TopLevelKeyword | null {
    for (const [keyword, kind] of DECLARATION_KEYWORDS) {
      if (this.consumeKeywordAt(sourceIndex, keyword)) return kind;
    }
    return null;
  }

  private consumeDeclaration(keyword: TopLevelKeyword, keywordStart: number): number | null {
    const position = this.declarationStart(keyword, keywordStart);
    if (isVariableKeyword(keyword))
      return this.scanVariableDeclaration(keyword, keywordStart, position);
    const identifier = this.readIdentifier(position);
    if (!identifier) return null;
    this.addName(identifier.name);
    return identifier.end;
  }

  private declarationStart(keyword: TopLevelKeyword, keywordStart: number): number {
    let position = this.skipDeclarationTrivia(keywordStart + keyword.length);
    if (keyword !== "function" || this.source[position] !== "*") return position;
    position++;
    return this.skipDeclarationTrivia(position);
  }
}

interface RegexState {
  position: number;
  insideCharacterClass: boolean;
  hasClosingSlash: boolean;
}

function isDeclarationWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function skipDeclarationComment(
  source: string,
  position: number,
  sourceLength: number,
): number | null {
  if (source[position] !== "/") return null;
  return readDeclarationCommentEnd(source, position, sourceLength);
}

function readDeclarationCommentEnd(
  source: string,
  position: number,
  sourceLength: number,
): number | null {
  if (source[position + 1] === "*") {
    const commentEnd = source.indexOf("*/", position + 2);
    return commentEnd < 0 ? sourceLength : commentEnd + 2;
  }
  if (source[position + 1] === "/") {
    const newlineIndex = source.indexOf("\n", position);
    return newlineIndex < 0 ? sourceLength : newlineIndex + 1;
  }
  return null;
}

function isRepeatedSign(source: string, previousIndex: number): boolean {
  const previousCharacter = source.charAt(previousIndex);
  return (
    (previousCharacter === "+" || previousCharacter === "-") &&
    source.charAt(previousIndex - 1) === previousCharacter
  );
}

function isRegexForbiddenAfterCharacter(
  source: string,
  previousCharacter: string,
  previousIndex: number,
): boolean {
  return REGEX_CANNOT_FOLLOW.has(previousCharacter) || isRepeatedSign(source, previousIndex);
}

function skipRegexFlags(source: string, position: number, sourceLength: number): number {
  while (position < sourceLength && /[a-z]/.test(source.charAt(position))) position++;
  return position;
}

function isVariableKeyword(keyword: TopLevelKeyword): keyword is "var" | "let" | "const" {
  return keyword === "var" || keyword === "let" || keyword === "const";
}

function skipInitializerComment(
  source: string,
  position: number,
  sourceLength: number,
): number | null {
  if (source[position + 1] === "/")
    return skipInitializerLineComment(source, position, sourceLength);
  if (source[position + 1] === "*")
    return skipInitializerBlockComment(source, position, sourceLength);
  return null;
}

function skipInitializerLineComment(
  source: string,
  position: number,
  sourceLength: number,
): number {
  const newlineIndex = source.indexOf("\n", position);
  return newlineIndex < 0 ? sourceLength : newlineIndex + 1;
}

function skipInitializerBlockComment(
  source: string,
  position: number,
  sourceLength: number,
): number {
  const commentEnd = source.indexOf("*/", position + 2);
  return commentEnd < 0 ? sourceLength : commentEnd + 2;
}

function isStringDelimiter(character: string | undefined): character is '"' | "'" | "`" {
  return character === '"' || character === "'" || character === "`";
}

function isInitializerSeparator(state: InitializerState, character: string | undefined): boolean {
  return isAtInitializerTopLevel(state) && isInitializerSeparatorCharacter(character);
}

function isAtInitializerTopLevel(state: InitializerState): boolean {
  return state.braceDepth === 0 && state.parenDepth === 0 && state.bracketDepth === 0;
}

function isInitializerSeparatorCharacter(character: string | undefined): boolean {
  return character === "," || character === ";" || character === "\n";
}

function decrementDepth(depth: number): number {
  return depth > 0 ? depth - 1 : depth;
}

export function extractTopLevelDecls(source: string): TopLevelDeclScan {
  return new DeclarationScanner(source).scan();
}

export function predeclareVarsHead(names: readonly string[], global: string): string {
  if (names.length === 0) return "";
  return `(function (names) { for (var gi = 0; gi < names.length; gi++) { try { var gn = names[gi]; var gd = Object.getOwnPropertyDescriptor(${global}, gn); if (!gd) { if (!(gn in ${global})) ${global}[gn] = undefined; continue; } var gSwallows = (gd.get || gd.set) ? !gd.set : gd.writable === false; if (gSwallows && gd.configurable) Object.defineProperty(${global}, gn, { value: ${global}[gn], writable: true, enumerable: true, configurable: true }); } catch (ge) {} } })(${JSON.stringify(names)});`;
}

interface DirectiveScanState {
  position: number;
  newline: boolean;
}

function isDirectiveLineTerminator(character: string): boolean {
  return (
    character === "\n" || character === "\r" || character === "\u2028" || character === "\u2029"
  );
}

function advanceDirectiveWhitespace(source: string, state: DirectiveScanState): boolean {
  const character = source.charAt(state.position);
  if (isDirectiveLineTerminator(character)) {
    state.newline = true;
    state.position++;
    return true;
  }
  if (!/\s/.test(character)) return false;
  state.position++;
  return true;
}

function skipDirectiveLineComment(source: string, state: DirectiveScanState): void {
  while (
    state.position < source.length &&
    !isDirectiveLineTerminator(source.charAt(state.position))
  ) {
    state.position++;
  }
}

function skipDirectiveBlockComment(source: string, state: DirectiveScanState): void {
  const commentEnd = source.indexOf("*/", state.position + 2);
  if (commentEnd < 0) {
    state.position = source.length;
    return;
  }
  if (/[\n\r\u2028\u2029]/.test(source.slice(state.position + 2, commentEnd))) state.newline = true;
  state.position = commentEnd + 2;
}

function skipDirectiveComment(source: string, state: DirectiveScanState): boolean {
  if (source.charAt(state.position) !== "/") return false;
  if (source.charAt(state.position + 1) === "/") {
    skipDirectiveLineComment(source, state);
    return true;
  }
  if (source.charAt(state.position + 1) === "*") {
    skipDirectiveBlockComment(source, state);
    return true;
  }
  return false;
}

function skipDirectiveTrivia(source: string, state: DirectiveScanState): void {
  state.newline = false;
  while (state.position < source.length) {
    if (advanceDirectiveWhitespace(source, state)) continue;
    if (skipDirectiveComment(source, state)) continue;
    break;
  }
}

function nextDirectiveStringEnd(source: string, quote: string, start: number): number | null {
  let position = start;
  while (position < source.length && source.charAt(position) !== quote) {
    const next = advanceDirectiveStringCharacter(source, position);
    if (next === null) return null;
    position = next;
  }
  return position;
}

function advanceDirectiveStringCharacter(source: string, position: number): number | null {
  const character = source.charAt(position);
  if (character === "\n" || character === "\r") return null;
  return character === "\\" ? position + 2 : position + 1;
}

function readDirectiveString(source: string, state: DirectiveScanState): string | null {
  const quote = source.charAt(state.position);
  if (quote !== '"' && quote !== "'") return null;
  const stringEndIndex = nextDirectiveStringEnd(source, quote, state.position + 1);
  if (stringEndIndex === null || stringEndIndex >= source.length) return null;
  const directive = source.slice(state.position + 1, stringEndIndex);
  state.position = stringEndIndex + 1;
  return directive;
}

function finishDirectiveStatement(source: string, state: DirectiveScanState): boolean {
  skipDirectiveTrivia(source, state);
  if (source.charAt(state.position) === ";") {
    state.position++;
    return true;
  }
  return (
    state.position >= source.length ||
    (state.newline && !continuesExpression(source, state.position))
  );
}

function nextDirective(source: string, state: DirectiveScanState): string | null {
  skipDirectiveTrivia(source, state);
  const directive = readDirectiveString(source, state);
  if (directive === null) return null;
  if (!finishDirectiveStatement(source, state)) return null;
  return directive;
}

export function hasUseStrictDirective(source: string): boolean {
  const state = { position: 0, newline: false };
  for (;;) {
    const directive = nextDirective(source, state);
    if (directive === null) return false;
    if (directive === "use strict") return true;
  }
}

function continuesExpression(source: string, position: number): boolean {
  const REGEX_CONTEXT_LOOKAHEAD_CHARACTERS = 11;
  const character = source.charAt(position);
  if (character === "!") return source.charAt(position + 1) === "=";
  if ("([.+-*/%,?=<>&|^`".includes(character)) return true;
  return /^(?:in|instanceof)(?![\w$])/.test(
    source.slice(position, position + REGEX_CONTEXT_LOOKAHEAD_CHARACTERS),
  );
}
