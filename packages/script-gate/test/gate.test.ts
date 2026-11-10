// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  buildScriptGateContext,
  checkScriptBeforeFetch,
  checkScriptRedirect,
  checkScriptResponse,
} from "../src/gate.ts";
import { cspAllowsInlineHandler, cspAllowsScript, parseCspPolicies } from "../src/csp.ts";
import { blockedByNosniff, isJavaScriptMime, isModuleMime } from "../src/mime.ts";
import { digestBase64, integrityMatches, parseIntegrity } from "../src/sri.ts";

const DOC = "https://example.com/app/index.html";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function hashBase64(algorithm: "sha256" | "sha384", source: string): string {
  return createHash(algorithm).update(source).digest("base64");
}

function cspHash(algorithm: "sha256" | "sha384", source: string): string {
  return `'${algorithm}-${hashBase64(algorithm, source)}'`;
}

function sriFor(source: string): string {
  return `sha384-${hashBase64("sha384", source)}`;
}

test("integrity metadata narrows to the strongest algorithm", () => {
  const parsed = parseIntegrity("sha256-aaa sha512-bbb sha384-ccc sha512-ddd");
  assert.deepEqual(
    parsed.map((entry) => entry.algorithm),
    ["sha512", "sha512"],
  );
  assert.deepEqual(
    parsed.map((entry) => entry.digest),
    ["bbb", "ddd"],
  );
});

test("unrecognised algorithms parse to no requirement, not a block", () => {
  assert.equal(parseIntegrity("md5-abc").length, 0);
  assert.equal(parseIntegrity("").length, 0);
  assert.equal(parseIntegrity(null).length, 0);
});

test("a matching digest passes and a tampered body does not", async () => {
  const source = "console.log('hello')";
  const integrity = sriFor(source);

  const matchingResponse = await checkScriptResponse(
    { url: "https://cdn.example.com/a.js", integrity },
    { contentType: "text/javascript", bytes: bytes(source), opaque: false },
  );
  assert.equal(matchingResponse.allowed, true);

  const tampered = await checkScriptResponse(
    { url: "https://cdn.example.com/a.js", integrity },
    {
      contentType: "text/javascript",
      bytes: bytes("console.log('hello') /* + payload */"),
      opaque: false,
    },
  );
  assert.equal(tampered.allowed, false);
  assert.equal(tampered.reason, "sri-mismatch");
});

test("base64url digests compare equal to their base64 spelling", async () => {
  const source = "payload 0";
  const canonical = sriFor(source);
  assert.ok(canonical.includes("/"));
  const urlSafe = canonical.replace(/\+/g, "-").replace(/\//g, "_");
  const verdict = await checkScriptResponse(
    { url: "https://cdn.example.com/a.js", integrity: urlSafe },
    { contentType: "text/javascript", bytes: bytes(source), opaque: false },
  );
  assert.equal(verdict.allowed, true);
});

test("an opaque response can never satisfy integrity", async () => {
  const source = "console.log(1)";
  const verdict = await checkScriptResponse(
    { url: "https://cdn.example.com/a.js", integrity: sriFor(source) },
    { contentType: "text/javascript", bytes: bytes(source), opaque: true },
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "sri-opaque");
});

test("an opaque response with no integrity still runs", async () => {
  const verdict = await checkScriptResponse(
    { url: "https://cdn.example.com/a.js" },
    { contentType: "text/javascript", bytes: bytes("x"), opaque: true },
  );
  assert.equal(verdict.allowed, true);
});

test("integrity with no body to hash is refused, not waved through", async () => {
  const verdict = await checkScriptResponse(
    { url: "https://cdn.example.com/a.js", integrity: "sha384-abc" },
    { contentType: "text/javascript", bytes: null, opaque: false },
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "sri-no-bytes");
});

test("SRI hashes only the supplied byte view", async () => {
  const content = bytes("script bytes");
  const prefix = bytes("prefix");
  const suffix = bytes("suffix");
  const backing = new Uint8Array(prefix.length + content.length + suffix.length);
  backing.set(prefix);
  backing.set(content, prefix.length);
  backing.set(suffix, prefix.length + content.length);
  const view = backing.subarray(prefix.length, prefix.length + content.length);
  const integrity = sriFor("script bytes");

  assert.equal(await digestBase64(view, "sha384"), integrity);
  assert.deepEqual(
    await checkScriptResponse(
      { url: "https://cdn.example.com/a.js", integrity },
      { contentType: "text/javascript", bytes: view, opaque: false },
    ),
    { allowed: true },
  );
});

test("SRI fails closed without WebCrypto; empty metadata still matches", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  if (!descriptor?.configurable) {
    throw new Error("globalThis.crypto must be configurable for this test");
  }
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: undefined,
  });

  try {
    const source = bytes("script bytes");
    assert.equal(await integrityMatches(source, []), true);
    assert.equal(await integrityMatches(source, parseIntegrity(sriFor("script bytes"))), false);
    assert.equal(await digestBase64(source, "sha384"), null);
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});

test("SRI helpers fail closed when WebCrypto rejects a digest", async (testContext) => {
  testContext.mock.method(crypto.subtle, "digest", async () => {
    throw new Error("digest unavailable");
  });
  const source = bytes("script bytes");
  const metadata = parseIntegrity(sriFor("script bytes"));

  assert.equal(await integrityMatches(source, metadata), false);
  assert.equal(await digestBase64(source, "sha384"), null);
});

test("javascript MIME essences are recognised, data types are not", () => {
  assert.equal(isJavaScriptMime("text/javascript; charset=utf-8"), true);
  assert.equal(isJavaScriptMime("APPLICATION/JavaScript"), true);
  assert.equal(isJavaScriptMime("application/json"), false);
  assert.equal(isJavaScriptMime("text/plain"), false);
  assert.equal(isJavaScriptMime(null), false);
});

test("nosniff blocks a non-JS type and an absent type", () => {
  assert.equal(blockedByNosniff("application/json", "nosniff"), true);
  assert.equal(blockedByNosniff(null, "nosniff"), true);
  assert.equal(blockedByNosniff("text/javascript", "nosniff"), false);
  assert.equal(blockedByNosniff("application/json", null), false);
});

test("a nosniff JSON response is refused at the response gate", async () => {
  const verdict = await checkScriptResponse(
    { url: "https://example.com/api/data" },
    {
      contentType: "application/json",
      contentTypeOptions: "nosniff",
      bytes: bytes("{}"),
      opaque: false,
    },
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "nosniff");
});

test("the effective MIME type decides, and non-script data never runs", async () => {
  const cases: {
    contentType: string;
    contentTypeOptions?: string;
    module?: boolean;
    expected: [boolean, string | undefined];
  }[] = [
    // Fetch takes the last valid MIME type from a combined Content-Type header.
    {
      contentType: "text/javascript; charset=utf-8, text/plain",
      contentTypeOptions: "nosniff",
      expected: [false, "nosniff"],
    },
    {
      contentType: "text/javascript; charset=utf-8, text/plain",
      contentTypeOptions: "nosniff",
      module: true,
      expected: [false, "nosniff"],
    },
    {
      contentType: "text/plain, text/javascript",
      contentTypeOptions: "nosniff",
      expected: [true, undefined],
    },
    // Non-script data types are refused whether or not nosniff is present.
    { contentType: "image/png", expected: [false, "mime"] },
    { contentType: "audio/ogg", expected: [false, "mime"] },
    { contentType: "video/mp4", expected: [false, "mime"] },
    { contentType: "text/csv", expected: [false, "mime"] },
    // Malformed parameters never fail the parse; leading subtype whitespace does.
    { contentType: "image/png;", expected: [false, "mime"] },
    { contentType: 'text/csv; a="b"c; d; =e;;', expected: [false, "mime"] },
    { contentType: "text/javascript; charset=", module: true, expected: [true, undefined] },
    {
      contentType: "text/\tjavascript",
      contentTypeOptions: "nosniff",
      expected: [false, "nosniff"],
    },
    // A classic script on a non-JS type still runs without nosniff.
    { contentType: "text/javascript", expected: [true, undefined] },
    { contentType: "text/plain", expected: [true, undefined] },
    // A quoted MIME parameter may contain a comma.
    {
      contentType: 'text/javascript; charset="utf-8,utf-16"',
      module: true,
      expected: [true, undefined],
    },
  ];

  for (const entry of cases) {
    const verdict = await checkScriptResponse(
      { url: "https://example.com/x.js", module: entry.module === true },
      {
        contentType: entry.contentType,
        contentTypeOptions: entry.contentTypeOptions ?? null,
        bytes: bytes("x"),
        opaque: false,
      },
    );
    assert.deepEqual([verdict.allowed, verdict.reason], entry.expected, entry.contentType);
  }
});

const gateWith = (...csp: string[]) => buildScriptGateContext(DOC, { cspHeaders: csp });

test("'self' admits same-origin and refuses a third-party host", async () => {
  const gate = gateWith("script-src 'self'");
  assert.equal(
    (await checkScriptBeforeFetch(gate, { url: "https://example.com/a.js" })).allowed,
    true,
  );
  const cross = await checkScriptBeforeFetch(gate, {
    url: "https://evil.example.net/a.js",
  });
  assert.equal(cross.allowed, false);
  assert.equal(cross.reason, "csp");
});

test("a nonce policy is not defeated by a legacy 'unsafe-inline'", async () => {
  const gate = gateWith("script-src 'unsafe-inline' 'nonce-r4nd0m'");
  const withNonce = await checkScriptBeforeFetch(gate, {
    url: null,
    nonce: "r4nd0m",
    body: "run()",
  });
  assert.equal(withNonce.allowed, true);
  const injected = await checkScriptBeforeFetch(gate, {
    url: null,
    body: "steal()",
  });
  assert.equal(injected.allowed, false);
  assert.equal(injected.reason, "csp");
});

test("'strict-dynamic' turns off a legacy 'unsafe-inline' for inline scripts", async () => {
  const gate = gateWith("script-src 'strict-dynamic' 'unsafe-inline'");
  const inline = await checkScriptBeforeFetch(gate, { url: null, body: "steal()" });
  assert.equal(inline.allowed, false);
  assert.equal(inline.reason, "csp");
  const inserted = await checkScriptBeforeFetch(gate, {
    url: null,
    body: "steal()",
    runtimeInserted: true,
  });
  assert.equal(inserted.allowed, false);
});

test("a hash source admits exactly the inline body it names", async () => {
  const body = "alert(1)";
  const gate = gateWith(`script-src ${cspHash("sha256", body)}`);
  assert.equal((await checkScriptBeforeFetch(gate, { url: null, body })).allowed, true);
  assert.equal(
    (await checkScriptBeforeFetch(gate, { url: null, body: "alert(2)" })).allowed,
    false,
  );
});

test("'strict-dynamic' drops host sources for parser-found scripts", async () => {
  const gate = gateWith("script-src 'strict-dynamic' 'nonce-abc' https://cdn.example.com");
  assert.equal(
    (
      await checkScriptBeforeFetch(gate, {
        url: "https://cdn.example.com/a.js",
      })
    ).allowed,
    false,
  );
  assert.equal(
    (
      await checkScriptBeforeFetch(gate, {
        url: "https://cdn.example.com/a.js",
        nonce: "abc",
      })
    ).allowed,
    true,
  );
  assert.equal(
    (
      await checkScriptBeforeFetch(gate, {
        url: "https://cdn.example.com/a.js",
        runtimeInserted: true,
      })
    ).allowed,
    true,
  );
});

test("policies are conjunctive across header and meta", async () => {
  const gate = buildScriptGateContext(DOC, {
    cspHeaders: ["script-src https://cdn.example.com"],
    metaCsp: ["script-src 'self'"],
  });
  assert.equal(
    (
      await checkScriptBeforeFetch(gate, {
        url: "https://cdn.example.com/a.js",
      })
    ).allowed,
    false,
  );
  assert.equal(
    (await checkScriptBeforeFetch(gate, { url: "https://example.com/a.js" })).allowed,
    false,
  );
});

test("'none' refuses everything and default-src is the last fallback", () => {
  const none = parseCspPolicies(["script-src 'none'"]);
  assert.equal(
    cspAllowsScript(none, { url: "https://example.com/a.js", documentUrl: DOC }).allowed,
    false,
  );
  const fallback = parseCspPolicies(["default-src 'self'"]);
  assert.equal(
    cspAllowsScript(fallback, {
      url: "https://example.com/a.js",
      documentUrl: DOC,
    }).allowed,
    true,
  );
  const elem = parseCspPolicies(["default-src 'none'; script-src 'none'; script-src-elem 'self'"]);
  assert.equal(
    cspAllowsScript(elem, {
      url: "https://example.com/a.js",
      documentUrl: DOC,
    }).allowed,
    true,
  );
});

test("host-source wildcards, ports and path prefixes", () => {
  const policies = parseCspPolicies([
    "script-src *.cdn.example.com https://pinned.example.com:8443/js/",
  ]);
  const allows = (url: string) => cspAllowsScript(policies, { url, documentUrl: DOC }).allowed;
  assert.equal(allows("https://a.cdn.example.com/x.js"), true);
  assert.equal(allows("https://cdn.example.com/x.js"), false);
  assert.equal(allows("https://pinned.example.com:8443/js/app.js"), true);
  assert.equal(allows("https://pinned.example.com:8443/other/app.js"), false);
  assert.equal(allows("https://pinned.example.com/js/app.js"), false);
});

test("a document with no policy allows everything it is asked", async () => {
  const gate = buildScriptGateContext(DOC);
  assert.equal(
    (
      await checkScriptBeforeFetch(gate, {
        url: "https://anywhere.example.net/a.js",
      })
    ).allowed,
    true,
  );
  assert.equal((await checkScriptBeforeFetch(gate, { url: null, body: "run()" })).allowed, true);
});

test("a module script needs a JS or JSON MIME type even without nosniff", async () => {
  const asClassic = await checkScriptResponse(
    { url: "https://example.com/x.js" },
    { contentType: "text/plain", bytes: bytes("{}"), opaque: false },
  );
  assert.equal(asClassic.allowed, true);

  const asModule = await checkScriptResponse(
    { url: "https://example.com/x.js", module: true },
    { contentType: "text/plain", bytes: bytes("{}"), opaque: false },
  );
  assert.equal(asModule.allowed, false);
  assert.equal(asModule.reason, "mime");

  const asJson = await checkScriptResponse(
    { url: "https://example.com/x.js", module: true },
    { contentType: "application/json", bytes: bytes("{}"), opaque: false },
  );
  assert.equal(asJson.allowed, true);
  assert.equal(asJson.moduleType, "json");
});

test("a JSON MIME type makes a module response a JSON record, nosniff or not", async () => {
  const request = { url: "https://example.com/x.json", module: true };
  for (const contentType of ["application/json", "text/json", "application/ld+json"]) {
    const verdict = await checkScriptResponse(request, {
      contentType,
      contentTypeOptions: "nosniff",
      bytes: bytes("{}"),
      opaque: false,
    });
    assert.equal(verdict.allowed, true, contentType);
    assert.equal(verdict.moduleType, "json", contentType);
  }
  const script = await checkScriptResponse(request, {
    contentType: "text/javascript",
    bytes: bytes("{}"),
    opaque: false,
  });
  assert.equal(script.allowed, true);
  assert.equal(script.moduleType, "javascript");
  const classic = await checkScriptResponse(
    { url: "https://example.com/x.js" },
    { contentType: "text/javascript", bytes: bytes(""), opaque: false },
  );
  assert.equal(classic.moduleType, undefined);
  assert.equal(isModuleMime("json", "application/json+protobuf"), false);
});

test("'none' beside another source is ignored, not decisive", async () => {
  const gate = gateWith("script-src 'none' 'nonce-abc'");
  assert.equal((await checkScriptBeforeFetch(gate, { url: null, nonce: "abc" })).allowed, true);
  const sole = gateWith("script-src 'none'");
  assert.equal((await checkScriptBeforeFetch(sole, { url: null })).allowed, false);
});

test("a meta policy is one policy, commas and all", async () => {
  const gate = buildScriptGateContext(DOC, {
    metaCsp: ["script-src 'self'; report-uri /csp?a=1,2"],
  });
  assert.equal(gate.policies.length, 1);
  assert.equal(
    (await checkScriptBeforeFetch(gate, { url: "https://example.com/a.js" })).allowed,
    true,
  );
  const header = buildScriptGateContext(DOC, {
    cspHeaders: ["script-src 'self'; report-uri /csp?a=1,2"],
  });
  assert.equal(header.policies.length, 2);
});

test("report-only refuses without blocking, and says so", async () => {
  const gate = buildScriptGateContext(DOC, {
    cspReportOnlyHeaders: ["script-src 'none'"],
  });
  const verdict = await checkScriptBeforeFetch(gate, {
    url: "https://example.com/a.js",
  });
  assert.equal(verdict.allowed, true);
  assert.match(verdict.reportOnly ?? "", /^\[Report Only\] Refused to execute/);
});

test("report-only inline hashes use their own algorithms without blocking", async () => {
  const body = "alert(1)";
  const enforced256 = cspHash("sha256", body);
  const reportOnly384 = cspHash("sha384", body);
  const matchedDifferentAlgorithms = await checkScriptBeforeFetch(
    buildScriptGateContext(DOC, {
      cspHeaders: [`script-src ${enforced256}`],
      cspReportOnlyHeaders: [`script-src ${reportOnly384}`],
    }),
    { url: null, body },
  );
  assert.deepEqual(matchedDifferentAlgorithms, { allowed: true });

  const matchedSameAlgorithm = await checkScriptBeforeFetch(
    buildScriptGateContext(DOC, {
      cspHeaders: [`script-src ${enforced256}`],
      cspReportOnlyHeaders: [`script-src ${enforced256}`],
    }),
    { url: null, body },
  );
  assert.deepEqual(matchedSameAlgorithm, { allowed: true });

  const genuineViolation = await checkScriptBeforeFetch(
    buildScriptGateContext(DOC, {
      cspHeaders: [`script-src ${enforced256}`],
      cspReportOnlyHeaders: [`script-src ${cspHash("sha384", "alert(2)")}`],
    }),
    { url: null, body },
  );
  assert.equal(genuineViolation.allowed, true);
  assert.match(genuineViolation.reportOnly ?? "", /^\[Report Only\] Refused to execute/);
});

test("'strict-dynamic' admits a module reached through a trusted importer", async () => {
  const gate = gateWith("script-src 'strict-dynamic' 'sha384-whatever'");
  assert.equal(
    (
      await checkScriptBeforeFetch(gate, {
        url: "https://cdn.example.com/entry.js",
        module: true,
      })
    ).allowed,
    false,
  );
  assert.equal(
    (
      await checkScriptBeforeFetch(gate, {
        url: "https://cdn.example.com/dep.js",
        module: true,
        runtimeInserted: true,
      })
    ).allowed,
    true,
  );
});

test("an https document refuses a plaintext script", async () => {
  const gate = buildScriptGateContext(DOC);
  const verdict = await checkScriptBeforeFetch(gate, {
    url: "http://cdn.example.com/a.js",
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "mixed-content");
});

test("upgrade-insecure-requests upgrades instead of blocking", async () => {
  const gate = buildScriptGateContext(DOC, {
    cspHeaders: ["upgrade-insecure-requests"],
  });
  const verdict = await checkScriptBeforeFetch(gate, {
    url: "http://cdn.example.com/a.js",
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.upgradeTo, "https://cdn.example.com/a.js");
});

test("http://localhost is potentially trustworthy", async () => {
  const gate = buildScriptGateContext(DOC);
  assert.equal(
    (await checkScriptBeforeFetch(gate, { url: "http://localhost:3000/a.js" })).allowed,
    true,
  );
});

test("a blob: URL is as trustworthy as the origin it carries", async () => {
  const gate = buildScriptGateContext(DOC);
  const check = async (url: string) => (await checkScriptBeforeFetch(gate, { url })).allowed;
  assert.equal(await check("blob:https://example.com/0b6c"), true);
  assert.equal(await check("blob:http://localhost:3000/0b6c"), true);
  assert.equal(await check("blob:http://cdn.example.com/0b6c"), false);
  assert.equal(await check("blob:null/0b6c"), false);
});

test("a plain-http document is not held to mixed content", async () => {
  const gate = buildScriptGateContext("http://example.com/");
  assert.equal(
    (await checkScriptBeforeFetch(gate, { url: "http://cdn.example.com/a.js" })).allowed,
    true,
  );
});

test("inline event handlers follow script-src-attr, then script-src, then default-src", () => {
  const allowed = (...headers: string[]) =>
    cspAllowsInlineHandler(parseCspPolicies(headers)).allowed;
  assert.equal(allowed(), true);
  assert.equal(allowed("img-src 'self'"), true);
  assert.equal(allowed("script-src 'self' 'unsafe-inline'"), true);
  assert.equal(allowed("default-src 'unsafe-inline'"), true);
  assert.equal(allowed("script-src 'self'"), false);
  assert.equal(allowed("default-src 'none'"), false);
  // A nonce admits script elements, never handler attributes, and turns off 'unsafe-inline'.
  assert.equal(allowed("script-src 'nonce-abc' 'unsafe-inline'"), false);
  assert.equal(allowed(`script-src 'unsafe-inline' ${cspHash("sha256", "go()")}`), false);
  // 'strict-dynamic' turns off 'unsafe-inline' for handler attributes as well.
  assert.equal(allowed("script-src 'strict-dynamic' 'unsafe-inline'"), false);
  assert.equal(allowed("script-src-attr 'strict-dynamic' 'unsafe-inline'"), false);
  // script-src-attr takes precedence over script-src for attributes.
  assert.equal(allowed("script-src 'nonce-abc'; script-src-attr 'unsafe-inline'"), true);
  assert.equal(allowed("script-src 'unsafe-inline'; script-src-attr 'none'"), false);
  // Every enforced policy must allow it.
  assert.equal(allowed("script-src 'unsafe-inline'", "script-src 'self'"), false);
});

test("a redirect target is rechecked against the source list, ignoring paths", () => {
  const ctx = buildScriptGateContext(DOC, {
    cspHeaders: ["script-src https://cdn.example/lib/ 'nonce-abc'"],
  });
  const request = { url: "https://cdn.example/lib/a.js" };
  assert.equal(checkScriptRedirect(ctx, request, "https://cdn.example/elsewhere.js").allowed, true);
  assert.deepEqual(checkScriptRedirect(ctx, request, "https://evil.example/a.js").reason, "csp");
  // A nonce admits the script wherever it redirects, as for the initial request.
  assert.equal(
    checkScriptRedirect(ctx, { ...request, nonce: "abc" }, "https://evil.example/a.js").allowed,
    true,
  );
  assert.equal(
    checkScriptRedirect(ctx, request, "http://cdn.example/lib/a.js").reason,
    "mixed-content",
  );
});
