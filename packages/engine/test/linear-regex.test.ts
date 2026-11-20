// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { compileOutboundFilters, shouldBlock } from "../src/cdp/outbound-filter-registry.ts";
import { compileLinearRegex, type LinearRegex } from "../src/cdp/linear-regex.ts";

function matcher(source: string): LinearRegex {
  const compiled = compileLinearRegex(source);
  if (!compiled.ok) throw new Error(compiled.error);
  return compiled.regex;
}

describe("linear outbound filter matcher", () => {
  it.each([
    { source: "(a+)+$", long: false },
    { source: "(a|aa)+$", long: false },
    { source: "a*a*a*a*$", long: true },
  ])("matches $source without backtracking", ({ source, long }) => {
    const regex = matcher(source);
    expect(regex.test("aaa")).toBe(new RegExp(source).test("aaa"));
    const started = performance.now();
    expect(regex.test(`${"a".repeat(5000)}!`)).toBe(long);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("keeps 32 filters over an 8 KB URL fast", () => {
    const plausible = [
      "(?:https?|wss?)://[^/]*\\.example\\.(?:com|net|org)",
      "\\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff)(?:\\?|#|$)",
      "[?&](?:utm_|gclid|fbclid|mc_|_ga)",
      "(?:^|/)(?:ads?|banners?|tracking|pixel|beacon)(?:/|\\.|$)",
      "^https://[a-z0-9-]{1,63}(?:\\.[a-z0-9-]{1,63}){1,4}/assets/",
    ];
    const sources = [
      ...plausible,
      ...plausible,
      ...plausible,
      ...plausible,
      ...plausible,
      ...plausible,
      ...plausible,
    ].slice(0, 32);
    const filters = sources.map((source, i) =>
      matcher(source.replace("example", `e${i}`).replace("assets", `a${i}`)),
    );
    const url = "https://cdn.example.com/assets/2026/11/11/bundle.min.js?" + "k=v&".repeat(2048);
    const started = performance.now();
    for (const filter of filters) filter.test(url);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("stops a start-anchored mismatch without scanning the rest of the URL", () => {
    const regex = matcher("^https://a/");
    const long = "x".repeat(32 * 1024 * 1024);
    // Flatten the rope first: the first charCodeAt pays for the whole string.
    expect(long.charCodeAt(0)).toBe(0x78);
    const started = performance.now();
    expect(regex.test(long)).toBe(false);
    expect(performance.now() - started).toBeLessThan(10);
  });

  it("bounds nested repeats of an empty body", () => {
    const started = performance.now();
    const compiled = compileLinearRegex("(?:(?:(?:(?:){1000}){1000}){1000}){1000}");
    expect(compiled.ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
    expect(compiled.ok && compiled.regex.test("")).toBe(true);
  });

  it("refuses a nested repeat that expands past the program bound", () => {
    expect(compileLinearRegex("(?:(?:a{1000}){1000}){1000}")).toEqual({
      ok: false,
      error: expect.stringContaining("expands past"),
    });
  });

  it("rejects constructs it cannot match in linear time", () => {
    const unsupported = ["(a)\\1", "(?=a)", "(?!a)", "(?<=a)", "(?<!a)", "\\b+", "\\01"];
    for (const source of unsupported) {
      expect(compileLinearRegex(source).ok).toBe(false);
    }
    expect(compileLinearRegex("a{1001}").ok).toBe(false);
    expect(compileLinearRegex("(").ok).toBe(false);
    // A digit escape is a backreference for \1-\7; \8 and \9 are letters, \0 is NUL, \01 octal.
    expect(compileLinearRegex("(a)\\1")).toEqual({
      ok: false,
      error: expect.stringContaining("backreference"),
    });
    expect(compileLinearRegex("\\01")).toEqual({
      ok: false,
      error: expect.not.stringContaining("backreference"),
    });
    expect(compileLinearRegex("(?<n>a)\\k<n>")).toEqual({
      ok: false,
      error: expect.stringContaining("backreference"),
    });
  });

  const annexB = [
    // \cX is a control escape only before a letter outside a class, or a letter, digit or `_`
    // inside one; Annex B makes any other \c the literal backslash.
    { source: "\\cA", input: "\x01", miss: "A" },
    { source: "\\c1", input: "\\c1", miss: "\x01" },
    { source: "\\c", input: "\\c", miss: "c" },
    { source: "[\\c1]", input: "\x11", miss: "1" },
    { source: "[\\c]", input: "c", miss: "\x03" },
    // Named groups are plain groups: the matcher has no captures, but \k is still refused.
    { source: "(?<name>a)b", input: "ab", miss: "b" },
    // Annex B: a range endpoint that is a class escape leaves the `-` literal.
    { source: "[\\w-.]", input: "-", miss: "!" },
    { source: "[.-\\d]", input: "-", miss: "a" },
    { source: "[a-\\d]", input: "-", miss: "b" },
    // A malformed \x or \u is the literal letter, so a quantifier binds to that letter.
    { source: "\\x4", input: "x4", miss: "\x04" },
    { source: "\\u{2}", input: "uu", miss: "u" },
    // Remaining identity escapes V8 accepts without the unicode flag.
    { source: "\\a", input: "a", miss: "b" },
    { source: "[\\B]", input: "B", miss: "b" },
  ];

  it("agrees with RegExp.prototype.test on Annex B escapes and class ranges", () => {
    for (const { source, input, miss } of annexB) {
      const regex = matcher(source);
      const native = new RegExp(source);
      expect([source, regex.test(input), native.test(input)]).toEqual([source, true, true]);
      expect([source, regex.test(miss), native.test(miss)]).toEqual([source, false, false]);
    }
  });

  it("matches \\b and \\B word boundaries", () => {
    const regex = matcher("\\bword");
    expect(regex.test("word")).toBe(true);
    expect(regex.test("sword")).toBe(false);
    expect(regex.test("wordy")).toBe(true);
    expect(compileOutboundFilters({ rejectRequestPattern: ["\\bword"] }).ok).toBe(true);
  });

  it("applies \\b to outbound reject filters", () => {
    const compiled = compileOutboundFilters({ rejectRequestPattern: ["\\bads\\b"] });
    if (!compiled.ok) throw new Error(compiled.error);
    expect(shouldBlock(compiled.filters, "https://cdn.test/ads/x", "Script").blocked).toBe(true);
    expect(shouldBlock(compiled.filters, "https://cdn.test/adsy/x", "Script").blocked).toBe(false);
  });

  const assertionPatterns = [
    "\\bads\\b",
    "\\Bfoo",
    "^\\b",
    "\\b$",
    "a\\b",
    "(?:x|\\b)+",
    "(?:)*",
    "(?:){2,3}",
    "[\\b]",
    "\\f",
    "\\v",
    "\\0",
    "[^a]z",
    ".x",
    "(?:.|\\n)x",
    "^|a",
    "(?:foo|bar|baz)",
  ];
  const assertionInputs = [
    "/ads/x",
    "/adsy/x",
    "ads",
    "ads ",
    " ads ",
    "xads",
    "foo",
    "xfoo",
    " foo",
    "a",
    "a ",
    "ab",
    "",
    "x",
    "!",
    "\b",
    "b",
    "\f",
    " ",
    "\v",
    "\t",
    "\0",
    "0",
    "\n",
    "aaaabz",
    "aaaz",
    "xxbar",
    "qux",
    "\nx",
  ];

  it("agrees with RegExp.prototype.test on assertions and escapes", () => {
    for (const source of assertionPatterns) {
      const regex = matcher(source);
      for (const input of assertionInputs) {
        expect([source, input, regex.test(input)]).toEqual([
          source,
          input,
          new RegExp(source).test(input),
        ]);
      }
    }
  });

  const patterns = [
    "^https?://(www\\.)?example\\.com/",
    "\\.(png|jpe?g|gif|webp)$",
    "ads?\\d+",
    "[^/]+\\.tracker\\.",
    "(^|/)analytics(/|\\.|$)",
    "\\.(js|mjs)(\\?|$)",
    "^wss?://",
    "[0-9]{3,4}x[0-9]{3,4}",
    "^https://[a-z0-9-]+\\.example\\.org/",
    "\\.(?:com|org)/$",
    "[?&]utm_",
    "^[^?#]*\\.json$",
    "[\\w-]+@[\\w-]+\\.\\w+",
    "(?:foo|bar)+baz",
    "a{2,4}$",
    "\\x41\\x42",
    "\\u00e9",
    "^\\^caret",
    "x?y*z+",
    "(a*)*b",
    "\\s*$",
    "[^]",
  ];
  const urls = [
    "https://www.example.com/a.js?x=1",
    "http://cdn.example.net/img.png",
    "https://cdn.tracker.example/ads123.jpg",
    "https://sub.example.org/pagead/collect?utm_source=x",
    "wss://socket.example.com/echo",
    "https://example.com/data.json#frag",
    "AB-123 é",
    "foo@bar.com",
    "aabbbbbaz",
    "",
    "line\nbreak",
    "  ",
  ];

  it("agrees with RegExp.prototype.test", () => {
    for (const source of patterns) {
      const regex = matcher(source);
      for (const url of urls) {
        expect([source, url, regex.test(url)]).toEqual([source, url, new RegExp(source).test(url)]);
      }
    }
  });
});
