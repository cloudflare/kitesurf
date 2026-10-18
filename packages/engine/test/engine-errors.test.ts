// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { classifyOrigin, parseKsErrLine } from "../src/engine-errors.ts";

describe("classifyOrigin", () => {
  it("attributes by wasm panic surface and module names", () => {
    expect(classifyOrigin("RuntimeError", "unreachable")).toBe("wasm");
    expect(classifyOrigin("Error", "panicked at 'index out of bounds'")).toBe("wasm");
    expect(classifyOrigin("Error", "x", "Error: x\n    at f (core_bg.wasm:1:2)")).toBe("wasm");
    expect(classifyOrigin("TypeError", "x", "TypeError: x\n    at get (dom-shim.js:9:1)")).toBe(
      "shim",
    );
    expect(classifyOrigin("Error", "x", "Error: x\n    at nav (page.js:44:3)")).toBe("runtime");
    expect(classifyOrigin("Error", "x", "Error: x")).toBe("unknown");
  });

  it("flags page frames as a chokepoint leak", () => {
    expect(
      classifyOrigin(
        "TypeError",
        "x is not a function",
        "TypeError: x\n    at run (__ks_user_module_2.js:1:1)\n    at (page.js:5:1)",
      ),
    ).toBe("page");
  });
});

describe("parseKsErrLine", () => {
  it("rejects malformed lines and page origins", () => {
    expect(parseKsErrLine("[ks-err] not json", "tok")).toBeNull();
    expect(parseKsErrLine("plain line", "tok")).toBeNull();
    expect(
      parseKsErrLine('[ks-err] {"token":"tok","origin":"page","message":"m"}', "tok"),
    ).toBeNull();
    expect(parseKsErrLine('[ks-err] {"token":"tok","origin":"shim"}', "tok")).toBeNull();
  });

  it("drops spoofed lines: bad, missing, or unknowable token", () => {
    const spoof = '[ks-err] {"origin":"wasm","message":"pwned"}';
    // Page JS can emit the prefix but can never read the env-carried
    // token, so its lines fail the comparison (or the channel is off).
    expect(parseKsErrLine(spoof, "tok")).toBeNull();
    expect(
      parseKsErrLine('[ks-err] {"token":"guess","origin":"wasm","message":"pwned"}', "tok"),
    ).toBeNull();
    expect(parseKsErrLine(spoof, undefined)).toBeNull();
  });

  it("accepts an authenticated engine error", () => {
    expect(
      parseKsErrLine(
        '[ks-err] {"token":"tok","origin":"wasm","message":"panicked at stylo","pageUrl":"https://example.com/"}',
        "tok",
      ),
    ).toEqual({
      origin: "wasm",
      name: "Error",
      message: "panicked at stylo",
      stack: undefined,
      pageUrl: "https://example.com/",
    });
  });

  it("caps attacker-lengthable fields", () => {
    const rep = parseKsErrLine(
      "[ks-err] " +
        JSON.stringify({
          token: "tok",
          origin: "shim",
          name: "N".repeat(500),
          message: "m".repeat(5000),
          stack: "s".repeat(50000),
          pageUrl: "https://x.example/" + "p".repeat(2000),
        }),
      "tok",
    );
    expect(rep!.name.length).toBeLessThanOrEqual(64);
    expect(rep!.message.length).toBeLessThanOrEqual(1024);
    expect(rep!.stack!.length).toBeLessThanOrEqual(8192);
    expect(rep!.pageUrl!.length).toBeLessThanOrEqual(512);
  });
});
