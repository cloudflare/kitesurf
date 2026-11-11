// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Re-exports the shared script-execution gate and Referrer Policy helpers.

export {
  buildScriptGateContext,
  checkScriptBeforeFetch,
  checkScriptRedirect,
  checkScriptResponse,
  scriptGateIsNoop,
  type ScriptBlockReason,
  type ScriptGateContext,
  type ScriptGateDecision,
  type ScriptGateRequest,
  type ScriptGateSources,
  type ScriptResponseFacts,
} from "./gate.ts";
export {
  cspAllowsInlineHandler,
  cspAllowsScript,
  inlineHashAlgorithms,
  parseCspPolicies,
  scriptSourceList,
  type CspPolicy,
  type CspScriptRequest,
  type CspVerdict,
} from "./csp.ts";
export {
  committedOriginOfUrl,
  embeddingPolicyVerdict,
  sameCommittedOrigin,
  type EmbeddingPolicyInput,
  type EmbeddingPolicyVerdict,
} from "./frame-policy.ts";
export {
  blockedByNosniff,
  hasNosniff,
  isJavaScriptMime,
  isJsonMime,
  isModuleMime,
  mimeEssence,
  type ModuleType,
} from "./mime.ts";
export {
  KITESURF_CORS_VERDICT_HEADER,
  KITESURF_NOSNIFF_HEADER,
  responseIsOpaque,
} from "./gateway-headers.ts";
export {
  digestBase64,
  integrityMatches,
  parseIntegrity,
  type SriAlgorithm,
  type SriMetadataEntry,
} from "./sri.ts";
export { scriptSourceDigest } from "./digest.ts";
export {
  extractTopLevelDecls,
  hasUseStrictDirective,
  predeclareVarsHead,
  type TopLevelDeclScan,
} from "./classic-scan.ts";
export {
  SANDBOX_ALLOW_ALL,
  intersectSandbox,
  parseSandboxAttribute,
  type SandboxRestrictions,
} from "./sandbox.ts";
