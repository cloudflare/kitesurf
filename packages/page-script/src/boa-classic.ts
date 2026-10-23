// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Adapts classic source for Boa by exposing top-level declarations on window.

import {
  extractTopLevelDecls,
  hasUseStrictDirective,
  predeclareVarsHead,
} from "@kitesurf/script-gate";

const BLOCKED_GLOBAL_NAMES = new Set([
  "module",
  "exports",
  "require",
  "window",
  "globalThis",
  "self",
]);

function collectVarNames(scan: ReturnType<typeof extractTopLevelDecls>): {
  retainedNames: Set<string>;
  varKeywordStarts: number[];
} {
  const retainedNames = new Set<string>();
  const varKeywordStarts: number[] = [];
  scan.varSites.forEach((site, siteIndex) => {
    const namesAtSite = scan.varSiteNames[siteIndex] ?? [];
    if (namesAtSite.some((name) => BLOCKED_GLOBAL_NAMES.has(name))) {
      namesAtSite.forEach((name) => retainedNames.add(name));
    } else {
      varKeywordStarts.push(site);
    }
  });
  return { retainedNames, varKeywordStarts };
}

function withoutBlockedVarNames(
  scan: ReturnType<typeof extractTopLevelDecls>,
  retainedNames: Set<string>,
): string[] {
  return scan.varNames.filter(
    (name) => !BLOCKED_GLOBAL_NAMES.has(name) && !retainedNames.has(name),
  );
}

function removeVarKeywords(source: string, starts: number[]): string {
  if (starts.length === 0) return source;
  const sourceParts: string[] = [];
  let copiedThrough = 0;
  for (const start of starts) {
    sourceParts.push(source.slice(copiedThrough, start), "   ");
    copiedThrough = start + 3;
  }
  sourceParts.push(source.slice(copiedThrough));
  return sourceParts.join("");
}

function declarationPrelude(source: string, names: string[]): string {
  if (names.length === 0) return "";
  const strictDirective = hasUseStrictDirective(source) ? '"use strict"; ' : "";
  return strictDirective + predeclareVarsHead(names, "window");
}

function declarationTail(names: string[], hoistedNames: string[]): string {
  const hoistedNameSet = new Set(hoistedNames);
  const declarationNames = names.filter(
    (name) => !hoistedNameSet.has(name) && !BLOCKED_GLOBAL_NAMES.has(name),
  );
  if (declarationNames.length === 0) return "";
  return (
    "\n" +
    declarationNames
      .map(
        (name) =>
          `try { if (typeof ${name} !== "undefined") window.${name} = ${name}; } catch (e) {}`,
      )
      .join("\n") +
    "\n"
  );
}

// Mirror classic top-level declarations onto window so Boa inserts share the page global.
export function globalizeForBoa(source: string): string {
  const scan = extractTopLevelDecls(source);
  const { retainedNames, varKeywordStarts } = collectVarNames(scan);
  const hoistedNames = withoutBlockedVarNames(scan, retainedNames);
  const body = removeVarKeywords(source, varKeywordStarts);
  return (
    declarationPrelude(source, hoistedNames) + body + declarationTail(scan.names, hoistedNames)
  );
}
