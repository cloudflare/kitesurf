// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("compiles, runs, and replays persisted scripts", async ({ page }) => {
  await page.goto("about:blank", { waitUntil: "load" });
  const client = await page.createCDPSession();
  const sessions = [client];

  try {
    const parsed: any[] = [];
    client.on("Debugger.scriptParsed", (event) => parsed.push(event));
    await client.send("Debugger.enable");

    let result = await client.send("Runtime.compileScript", {
      expression: "1 + 1",
      sourceURL: "validate-only.js",
      persistScript: false,
    });
    expect(result.scriptId, "non-persistent compile omits scriptId").toBeUndefined();
    expect(result.exceptionDetails, "valid source omits exceptionDetails").toBeUndefined();

    result = await client.send("Runtime.compileScript", {
      expression: "function (",
      sourceURL: "broken.js",
      persistScript: true,
    });
    expect(result.scriptId, "syntax error omits scriptId").toBeUndefined();
    expect(result.exceptionDetails, "syntax error returns exceptionDetails").toBeTruthy();
    expect(result.exceptionDetails?.exception?.subtype, "syntax error subtype is error").toBe(
      "error",
    );

    const before = parsed.length;
    result = await client.send("Runtime.compileScript", {
      expression: "globalThis.__compiled_demo_value = 7 * 6; globalThis.__compiled_demo_value;",
      sourceURL: "answer.js",
      persistScript: true,
    });
    expect(result.scriptId, "persisted compile returns scriptId").toBeTruthy();
    expect(result.scriptId, "scriptId uses the cs:N format").toMatch(/^cs:/);
    await expect.poll(() => parsed.length > before, { timeout: 10_000 }).toBe(true);
    const event = parsed[parsed.length - 1];
    expect(event.scriptId, "scriptParsed carries the compiled scriptId").toBe(result.scriptId);
    expect(event.url, "scriptParsed carries the source URL").toBe("answer.js");
    expect(event.hasSourceURL, "scriptParsed marks an explicit sourceURL").toBe(true);
    expect(typeof event.hash === "string" && event.hash.length > 0, "scriptParsed has a hash").toBe(
      true,
    );
    expect(event.isLiveEdit, "compiled script is not a live edit").toBe(false);
    expect(event.executionContextId, "scriptParsed uses execution context one").toBe(1);

    const run = await client.send("Runtime.runScript", {
      scriptId: result.scriptId!,
      returnByValue: true,
    });
    expect(run.exceptionDetails, "runScript does not throw").toBeUndefined();
    expect(run.result.type, "runScript returns a number").toBe("number");
    expect(run.result.value, "runScript returns 42").toBe(42);

    const probe = await client.send("Runtime.evaluate", {
      expression: "globalThis.__compiled_demo_value",
      returnByValue: true,
    });
    expect(probe.result.value, "runScript side effect is visible to evaluate").toBe(42);

    const bogus = await client.send("Runtime.runScript", {
      scriptId: "cs:999999",
      returnByValue: true,
    });
    expect(bogus.exceptionDetails, "unknown scriptId returns exceptionDetails").toBeTruthy();

    result = await client.send("Runtime.compileScript", {
      expression: "Math.PI",
      sourceURL: "pi.js",
      persistScript: true,
    });
    const piId = result.scriptId!;

    const replay = await page.createCDPSession();
    sessions.push(replay);
    const replayParsed: any[] = [];
    replay.on("Debugger.scriptParsed", (event) => replayParsed.push(event));
    await replay.send("Debugger.enable");
    await expect
      .poll(() => replayParsed.some((event) => event.scriptId === piId), { timeout: 10_000 })
      .toBe(true);
  } finally {
    await Promise.all(sessions.map((session) => session.detach()));
  }
});

test.fails("a compile syntax error reports className SyntaxError", async ({ page }) => {
  // Gap: the engine reports className "Error" for a compile syntax error; Chrome says SyntaxError.
  await page.goto("about:blank", { waitUntil: "load" });
  const client = await page.createCDPSession();
  try {
    const result = await client.send("Runtime.compileScript", {
      expression: "function (",
      sourceURL: "broken.js",
      persistScript: true,
    });
    expect(
      result.exceptionDetails?.exception?.className,
      "syntax error className is SyntaxError",
    ).toBe("SyntaxError");
  } finally {
    await client.detach();
  }
});
