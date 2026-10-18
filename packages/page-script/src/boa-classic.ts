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

// Mirror classic top-level declarations onto window so Boa inserts share the page global.
export function globalizeForBoa(source: string): string {
  const scan = extractTopLevelDecls(source);
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
  const hoistedVarNames = scan.varNames.filter(
    (name) => !BLOCKED_GLOBAL_NAMES.has(name) && !retainedNames.has(name),
  );
  let body = source;
  if (varKeywordStarts.length > 0) {
    const sourceParts: string[] = [];
    let copiedThrough = 0;
    for (const varKeywordStart of varKeywordStarts) {
      sourceParts.push(body.slice(copiedThrough, varKeywordStart), "   ");
      copiedThrough = varKeywordStart + 3;
    }
    sourceParts.push(body.slice(copiedThrough));
    body = sourceParts.join("");
  }
  const declarationPrelude =
    hoistedVarNames.length === 0
      ? ""
      : (hasUseStrictDirective(source) ? '"use strict"; ' : "") +
        predeclareVarsHead(hoistedVarNames, "window");
  const hoistedVarNameSet = new Set(hoistedVarNames);
  const declarationNames = scan.names.filter(
    (name) => !hoistedVarNameSet.has(name) && !BLOCKED_GLOBAL_NAMES.has(name),
  );
  const declarationTail =
    declarationNames.length === 0
      ? ""
      : "\n" +
        declarationNames
          .map(
            (name) =>
              `try { if (typeof ${name} !== "undefined") window.${name} = ${name}; } catch (e) {}`,
          )
          .join("\n") +
        "\n";
  return declarationPrelude + body + declarationTail;
}
