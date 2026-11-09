// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Scans classic scripts for top-level declarations used by the Boa globalizer.

export interface TopLevelDeclScan {
  names: string[];
  varSites: number[];
  varNames: string[];
  varSiteNames: string[][];
  lexicalSites: number[];
  lexicalNames: string[];
  classSites: number[];
  classNames: string[];
  // Index just past each class body's closing brace, parallel to classSites.
  classEnds: number[];
  functionSites: number[];
  functionNames: string[];
  // Index just past each function body's closing brace, parallel to functionSites.
  functionEnds: number[];
}

type TopLevelKeyword = "var" | "let" | "const" | "function" | "class";

// This bounded scan recognizes common top-level declarations; it is not a JavaScript parser.
export function extractTopLevelDecls(source: string): TopLevelDeclScan {
  const names: string[] = [];
  const seen = new Set<string>();
  const varSites: number[] = [];
  const varNames: string[] = [];
  const varSeen = new Set<string>();
  const varSiteNames: string[][] = [];
  const lexicalSites: number[] = [];
  const lexicalNames: string[] = [];
  const classSites: number[] = [];
  const classNames: string[] = [];
  const classEnds: number[] = [];
  const functionSites: number[] = [];
  const functionNames: string[] = [];
  const functionEnds: number[] = [];
  const sourceLength = source.length;
  let sourceOffset = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let stringDelimiter: "" | '"' | "'" | "`" = "";
  let inLineComment = false;
  let inBlockComment = false;
  const identifierPattern = /[a-zA-Z_$][\w$]*/y;
  const ASCII_LOWERCASE_START_CHAR_CODE = 0x61;
  const ASCII_LOWERCASE_END_CHAR_CODE = 0x7a;
  const ASCII_UPPERCASE_START_CHAR_CODE = 0x41;
  const ASCII_UPPERCASE_END_CHAR_CODE = 0x5a;
  const ASCII_DIGIT_START_CHAR_CODE = 0x30;
  const ASCII_DIGIT_END_CHAR_CODE = 0x39;
  const ASCII_UNDERSCORE_CHAR_CODE = 0x5f;
  const ASCII_DOLLAR_SIGN_CHAR_CODE = 0x24;

  function isAtTopLevel() {
    return braceDepth === 0 && parenDepth === 0 && bracketDepth === 0;
  }
  function isAtomStart(sourceIndex: number): boolean {
    if (sourceIndex === 0) return true;
    const previousCharCode = source.charCodeAt(sourceIndex - 1);
    return !(
      (previousCharCode >= ASCII_LOWERCASE_START_CHAR_CODE &&
        previousCharCode <= ASCII_LOWERCASE_END_CHAR_CODE) ||
      (previousCharCode >= ASCII_UPPERCASE_START_CHAR_CODE &&
        previousCharCode <= ASCII_UPPERCASE_END_CHAR_CODE) ||
      (previousCharCode >= ASCII_DIGIT_START_CHAR_CODE &&
        previousCharCode <= ASCII_DIGIT_END_CHAR_CODE) ||
      previousCharCode === ASCII_UNDERSCORE_CHAR_CODE ||
      previousCharCode === ASCII_DOLLAR_SIGN_CHAR_CODE
    );
  }
  function readIdentifier(startIndex: number): { name: string; end: number } | null {
    identifierPattern.lastIndex = startIndex;
    const match = identifierPattern.exec(source);
    if (!match || match.index !== startIndex) return null;
    return { name: match[0], end: startIndex + match[0].length };
  }
  function skipDeclarationTrivia(startIndex: number): number {
    let position = startIndex;
    while (position < sourceLength) {
      const character = source[position];
      if (character === " " || character === "\t" || character === "\n" || character === "\r") {
        position++;
        continue;
      }
      if (character === "/" && source[position + 1] === "*") {
        const commentEnd = source.indexOf("*/", position + 2);
        if (commentEnd < 0) return sourceLength;
        position = commentEnd + 2;
        continue;
      }
      if (character === "/" && source[position + 1] === "/") {
        const newlineIndex = source.indexOf("\n", position);
        if (newlineIndex < 0) return sourceLength;
        position = newlineIndex + 1;
        continue;
      }
      break;
    }
    return position;
  }
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
  function isPropertyName(wordStart: number): boolean {
    if (source.charAt(wordStart - 1) === "#") return true;
    let previousIndex = wordStart - 1;
    while (previousIndex >= 0 && /\s/.test(source.charAt(previousIndex))) previousIndex--;
    return source.charAt(previousIndex) === "." && source.charAt(previousIndex - 1) !== ".";
  }
  function regexEnd(slashIndex: number): number {
    let previousIndex = slashIndex - 1;
    while (previousIndex >= 0 && /\s/.test(source.charAt(previousIndex))) previousIndex--;
    if (previousIndex >= 0) {
      const previousCharacter = source.charAt(previousIndex);
      if (/[\w$]/.test(previousCharacter)) {
        let previousWordStart = previousIndex;
        while (previousWordStart > 0 && /[\w$]/.test(source.charAt(previousWordStart - 1))) {
          previousWordStart--;
        }
        if (
          !REGEX_AFTER_WORD.has(source.slice(previousWordStart, previousIndex + 1)) ||
          isPropertyName(previousWordStart)
        ) {
          return -1;
        }
      } else if (
        previousCharacter === ")" ||
        previousCharacter === "]" ||
        previousCharacter === '"' ||
        previousCharacter === "'" ||
        previousCharacter === "`"
      ) {
        return -1;
      } else if (
        (previousCharacter === "+" || previousCharacter === "-") &&
        source.charAt(previousIndex - 1) === previousCharacter
      ) {
        return -1;
      }
    }
    let position = slashIndex + 1;
    let insideCharacterClass = false;
    let hasClosingSlash = false;
    while (position < sourceLength) {
      const character = source.charAt(position);
      if (character === "\\") {
        position += 2;
        continue;
      }
      if (character === "\n") return -1;
      if (insideCharacterClass) {
        if (character === "]") insideCharacterClass = false;
      } else if (character === "[") insideCharacterClass = true;
      else if (character === "/") {
        position++;
        hasClosingSlash = true;
        break;
      }
      position++;
    }
    if (!hasClosingSlash) return -1;
    while (position < sourceLength && /[a-z]/.test(source.charAt(position))) position++;
    return position;
  }
  function consumeKeywordAt(sourceIndex: number, keyword: string): boolean {
    if (source.slice(sourceIndex, sourceIndex + keyword.length) !== keyword) return false;
    if (!isAtomStart(sourceIndex)) return false;
    const nextCharacterCode = source.charCodeAt(sourceIndex + keyword.length);
    const nextIsIdentifierCharacter =
      (nextCharacterCode >= ASCII_LOWERCASE_START_CHAR_CODE &&
        nextCharacterCode <= ASCII_LOWERCASE_END_CHAR_CODE) ||
      (nextCharacterCode >= ASCII_UPPERCASE_START_CHAR_CODE &&
        nextCharacterCode <= ASCII_UPPERCASE_END_CHAR_CODE) ||
      (nextCharacterCode >= ASCII_DIGIT_START_CHAR_CODE &&
        nextCharacterCode <= ASCII_DIGIT_END_CHAR_CODE) ||
      nextCharacterCode === ASCII_UNDERSCORE_CHAR_CODE ||
      nextCharacterCode === ASCII_DOLLAR_SIGN_CHAR_CODE;
    return !nextIsIdentifierCharacter;
  }

  function addName(name: string): void {
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  }

  function skipInitializer(startIndex: number): number {
    let position = startIndex;
    let initializerBraceDepth = 0;
    let initializerParenDepth = 0;
    let initializerBracketDepth = 0;
    let initializerStringDelimiter: "" | '"' | "'" | "`" = "";
    while (position < sourceLength) {
      const character = source[position];
      if (initializerStringDelimiter) {
        if (character === "\\") {
          position += 2;
          continue;
        }
        if (character === initializerStringDelimiter) initializerStringDelimiter = "";
        position++;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        initializerStringDelimiter = character;
        position++;
        continue;
      }
      if (character === "/" && source[position + 1] === "/") {
        const newlineIndex = source.indexOf("\n", position);
        position = newlineIndex < 0 ? sourceLength : newlineIndex + 1;
        continue;
      }
      if (character === "/" && source[position + 1] === "*") {
        const commentEnd = source.indexOf("*/", position + 2);
        position = commentEnd < 0 ? sourceLength : commentEnd + 2;
        continue;
      }
      if (character === "/") {
        const regexEndPosition = regexEnd(position);
        if (regexEndPosition > 0) {
          position = regexEndPosition;
          continue;
        }
      }
      if (character === "{") {
        initializerBraceDepth++;
        position++;
        continue;
      }
      if (character === "}") {
        if (initializerBraceDepth > 0) initializerBraceDepth--;
        else break;
        position++;
        continue;
      }
      if (character === "(") {
        initializerParenDepth++;
        position++;
        continue;
      }
      if (character === ")") {
        if (initializerParenDepth > 0) initializerParenDepth--;
        position++;
        continue;
      }
      if (character === "[") {
        initializerBracketDepth++;
        position++;
        continue;
      }
      if (character === "]") {
        if (initializerBracketDepth > 0) initializerBracketDepth--;
        position++;
        continue;
      }
      if (
        initializerBraceDepth === 0 &&
        initializerParenDepth === 0 &&
        initializerBracketDepth === 0 &&
        (character === "," || character === ";" || character === "\n")
      ) {
        break;
      }
      position++;
    }
    return position;
  }

  function scanVariableDeclaration(
    keyword: "var" | "let" | "const",
    keywordStart: number,
    startIndex: number,
  ): number {
    const canStripVarDeclaration = keyword === "var" && readIdentifier(startIndex) !== null;
    // A lexical declaration becomes `var`, which keeps a destructuring pattern valid and
    // shares the binding with later scripts through the wrapper function.
    const isLexical = keyword !== "var";
    const namesAtVarSite: string[] = [];
    if (canStripVarDeclaration) {
      varSites.push(keywordStart);
      varSiteNames.push(namesAtVarSite);
    }
    if (isLexical) lexicalSites.push(keywordStart);
    let position = startIndex;
    while (position < sourceLength) {
      position = skipDeclarationTrivia(position);
      const identifier = readIdentifier(position);
      if (!identifier) break;
      addName(identifier.name);
      if (keyword !== "var") lexicalNames.push(identifier.name);
      if (canStripVarDeclaration) {
        namesAtVarSite.push(identifier.name);
        if (!varSeen.has(identifier.name)) {
          varSeen.add(identifier.name);
          varNames.push(identifier.name);
        }
      }
      position = skipInitializer(identifier.end);
      if (source[position] !== ",") break;
      position++;
    }
    return position;
  }

  // Index just past a class body's closing brace, so `class A {}` can become
  // `A = class A {};`: the semicolon keeps a following `(` from calling the class.
  function skipClassBody(startIndex: number): number {
    let position = startIndex;
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let delimiter: "" | '"' | "'" | "`" = "";
    while (position < sourceLength) {
      const character = source[position];
      if (delimiter) {
        if (character === "\\") {
          position += 2;
          continue;
        }
        if (character === delimiter) delimiter = "";
        position++;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        delimiter = character;
        position++;
        continue;
      }
      if (character === "/" && source[position + 1] === "/") {
        const newlineIndex = source.indexOf("\n", position);
        position = newlineIndex < 0 ? sourceLength : newlineIndex + 1;
        continue;
      }
      if (character === "/" && source[position + 1] === "*") {
        const commentEnd = source.indexOf("*/", position + 2);
        position = commentEnd < 0 ? sourceLength : commentEnd + 2;
        continue;
      }
      if (character === "/") {
        const regexEndPosition = regexEnd(position);
        if (regexEndPosition > 0) {
          position = regexEndPosition;
          continue;
        }
      }
      if (character === "(") parenDepth++;
      else if (character === ")") {
        if (parenDepth > 0) parenDepth--;
      } else if (character === "[") bracketDepth++;
      else if (character === "]") {
        if (bracketDepth > 0) bracketDepth--;
      } else if (character === "{") {
        // Heritage can hold an object literal (`extends mixin({})`); the body brace is
        // the first one outside any parentheses or brackets.
        if (parenDepth === 0 && bracketDepth === 0) braceDepth++;
      } else if (character === "}") {
        if (braceDepth > 0) {
          braceDepth--;
          position++;
          if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) return position;
          continue;
        }
      }
      position++;
    }
    return sourceLength;
  }

  function declarationKeywordAt(sourceIndex: number): TopLevelKeyword | null {
    if (consumeKeywordAt(sourceIndex, "var")) return "var";
    if (consumeKeywordAt(sourceIndex, "let")) return "let";
    if (consumeKeywordAt(sourceIndex, "const")) return "const";
    if (consumeKeywordAt(sourceIndex, "function")) return "function";
    if (consumeKeywordAt(sourceIndex, "class")) return "class";
    return null;
  }

  function consumeDeclaration(keyword: TopLevelKeyword, keywordStart: number): number | null {
    let position = skipDeclarationTrivia(keywordStart + keyword.length);
    if (keyword === "function" && source[position] === "*") {
      position++;
      position = skipDeclarationTrivia(position);
    }
    if (keyword === "var" || keyword === "let" || keyword === "const") {
      return scanVariableDeclaration(keyword, keywordStart, position);
    }
    const identifier = readIdentifier(position);
    if (!identifier) return null;
    addName(identifier.name);
    if (keyword === "class") {
      classSites.push(keywordStart);
      classNames.push(identifier.name);
      const bodyEnd = skipClassBody(identifier.end);
      classEnds.push(bodyEnd);
      return bodyEnd;
    }
    if (keyword === "function") {
      // The body end lets the bundle close the rewritten assignment with `;`.
      functionSites.push(keywordStart);
      functionNames.push(identifier.name);
      const bodyEnd = skipClassBody(identifier.end);
      functionEnds.push(bodyEnd);
      return bodyEnd;
    }
    return identifier.end;
  }

  while (sourceOffset < sourceLength) {
    const currentChar = source[sourceOffset];
    if (inLineComment) {
      if (currentChar === "\n") inLineComment = false;
      sourceOffset++;
      continue;
    }
    if (inBlockComment) {
      if (currentChar === "*" && source[sourceOffset + 1] === "/") {
        inBlockComment = false;
        sourceOffset += 2;
        continue;
      }
      sourceOffset++;
      continue;
    }
    if (stringDelimiter) {
      if (currentChar === "\\") {
        sourceOffset += 2;
        continue;
      }
      if (currentChar === stringDelimiter) stringDelimiter = "";
      sourceOffset++;
      continue;
    }
    if (currentChar === '"' || currentChar === "'" || currentChar === "`") {
      stringDelimiter = currentChar;
      sourceOffset++;
      continue;
    }
    if (currentChar === "/" && source[sourceOffset + 1] === "/") {
      inLineComment = true;
      sourceOffset += 2;
      continue;
    }
    if (currentChar === "/" && source[sourceOffset + 1] === "*") {
      inBlockComment = true;
      sourceOffset += 2;
      continue;
    }
    if (currentChar === "/") {
      const regexEndPosition = regexEnd(sourceOffset);
      if (regexEndPosition > 0) {
        sourceOffset = regexEndPosition;
        continue;
      }
    }
    if (currentChar === "{") {
      braceDepth++;
      sourceOffset++;
      continue;
    }
    if (currentChar === "}") {
      if (braceDepth > 0) braceDepth--;
      sourceOffset++;
      continue;
    }
    if (currentChar === "(") {
      parenDepth++;
      sourceOffset++;
      continue;
    }
    if (currentChar === ")") {
      if (parenDepth > 0) parenDepth--;
      sourceOffset++;
      continue;
    }
    if (currentChar === "[") {
      bracketDepth++;
      sourceOffset++;
      continue;
    }
    if (currentChar === "]") {
      if (bracketDepth > 0) bracketDepth--;
      sourceOffset++;
      continue;
    }
    if (isAtTopLevel()) {
      const keyword = declarationKeywordAt(sourceOffset);
      if (keyword !== null) {
        const declarationEnd = consumeDeclaration(keyword, sourceOffset);
        if (declarationEnd !== null) {
          sourceOffset = declarationEnd;
          continue;
        }
      }
    }
    sourceOffset++;
  }
  return {
    names,
    varSites,
    varNames,
    varSiteNames,
    lexicalSites,
    lexicalNames,
    classSites,
    classNames,
    classEnds,
    functionSites,
    functionNames,
    functionEnds,
  };
}

export function predeclareVarsHead(names: readonly string[], global: string): string {
  if (names.length === 0) return "";
  return `(function (names) { for (var gi = 0; gi < names.length; gi++) { try { var gn = names[gi]; var gd = Object.getOwnPropertyDescriptor(${global}, gn); if (!gd) { if (!(gn in ${global})) ${global}[gn] = undefined; continue; } var gSwallows = (gd.get || gd.set) ? !gd.set : gd.writable === false; if (gSwallows && gd.configurable) Object.defineProperty(${global}, gn, { value: ${global}[gn], writable: true, enumerable: true, configurable: true }); } catch (ge) {} } })(${JSON.stringify(names)});`;
}

export function hasUseStrictDirective(source: string): boolean {
  const sourceLength = source.length;
  let position = 0;
  let newline = false;
  const skipTrivia = (): void => {
    newline = false;
    while (position < sourceLength) {
      const character = source.charAt(position);
      if (
        character === "\n" ||
        character === "\r" ||
        character === "\u2028" ||
        character === "\u2029"
      ) {
        newline = true;
        position++;
        continue;
      }
      if (/\s/.test(character)) {
        position++;
        continue;
      }
      if (character === "/" && source.charAt(position + 1) === "/") {
        while (position < sourceLength && !/[\n\r\u2028\u2029]/.test(source.charAt(position))) {
          position++;
        }
        continue;
      }
      if (character === "/" && source.charAt(position + 1) === "*") {
        const commentEnd = source.indexOf("*/", position + 2);
        if (commentEnd < 0) {
          position = sourceLength;
          return;
        }
        if (/[\n\r\u2028\u2029]/.test(source.slice(position + 2, commentEnd))) newline = true;
        position = commentEnd + 2;
        continue;
      }
      return;
    }
  };
  for (;;) {
    skipTrivia();
    const quote = source.charAt(position);
    if (quote !== '"' && quote !== "'") return false;
    let stringEndIndex = position + 1;
    while (stringEndIndex < sourceLength && source.charAt(stringEndIndex) !== quote) {
      const character = source.charAt(stringEndIndex);
      if (character === "\n" || character === "\r") return false;
      stringEndIndex += character === "\\" ? 2 : 1;
    }
    if (stringEndIndex >= sourceLength) return false;
    const directive = source.slice(position + 1, stringEndIndex) === "use strict";
    position = stringEndIndex + 1;
    skipTrivia();
    const nextCharacter = source.charAt(position);
    if (nextCharacter === ";") position++;
    else if (position < sourceLength && !(newline && !continuesExpression(source, position))) {
      return false;
    }
    if (directive) return true;
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
