// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession } from "@cloudflare/puppeteer";
import type { Protocol } from "devtools-protocol";

import { expect, test } from "./harness";

const ORIGIN = "https://ks.invalid";
const FIXTURE = `${ORIGIN}/__fixtures/webmcp-tools.html`;

type Added = Protocol.WebMCP.ToolsAddedEvent;
type Removed = Protocol.WebMCP.ToolsRemovedEvent;
type Invoked = Protocol.WebMCP.ToolInvokedEvent;
type Responded = Protocol.WebMCP.ToolRespondedEvent;

interface Journal {
  added: Added[];
  removed: Removed[];
  invoked: Invoked[];
  responded: Responded[];
}

function journal(session: CDPSession): Journal {
  const j: Journal = { added: [], removed: [], invoked: [], responded: [] };
  session.on("WebMCP.toolsAdded", (p) => j.added.push(p));
  session.on("WebMCP.toolsRemoved", (p) => j.removed.push(p));
  session.on("WebMCP.toolInvoked", (p) => j.invoked.push(p));
  session.on("WebMCP.toolResponded", (p) => j.responded.push(p));
  return j;
}

const namesOf = (events: Array<{ tools: Array<{ name: string }> }>) =>
  events.flatMap((e) => e.tools.map((t) => t.name)).sort();

test("WebMCP announces tools as deltas and invokes them", async ({ page, cdpSession }) => {
  const j = journal(cdpSession);
  await cdpSession.send("WebMCP.enable");
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await page.evaluate("window.__ready");

  await expect
    .poll(() => namesOf(j.added), { timeout: 10_000 })
    .toEqual(["boom", "echo", "readTitle"]);
  expect(j.added.every((e) => e.tools.length === 1)).toBe(true);
  expect(j.added.map((event) => event.tools[0]!.name)).toEqual(["echo", "readTitle", "boom"]);

  const frameId = j.added[0]!.tools[0]!.frameId;
  expect(frameId).toBeTruthy();

  const echo = j.added.flatMap((e) => e.tools).find((t) => t.name === "echo")!;
  expect(echo.description).toBe("Echo the message back");
  expect(echo.inputSchema).toMatchObject({
    type: "object",
    required: ["message"],
  });
  expect(echo.annotations).toEqual({
    readOnly: true,
    untrustedContent: false,
  });
  const readTitle = j.added.flatMap((e) => e.tools).find((t) => t.name === "readTitle")!;
  expect(readTitle.inputSchema).toBeUndefined();

  const { invocationId } = await cdpSession.send("WebMCP.invokeTool", {
    frameId,
    toolName: "echo",
    input: { message: "hi" },
  });
  expect(invocationId).toBeTruthy();
  expect(Object.keys(j.responded)).toHaveLength(0);

  await expect.poll(() => j.responded.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(j.invoked).toHaveLength(1);
  expect(j.invoked[0]).toMatchObject({
    toolName: "echo",
    frameId,
    invocationId,
    input: JSON.stringify({ message: "hi" }),
  });
  expect(j.responded[0]).toMatchObject({
    invocationId,
    status: "Completed",
  });
  expect(j.responded[0]!.output).toEqual({
    content: [{ type: "text", text: "echo: hi" }],
  });
  expect(await page.evaluate("window.__executeSignalAborted")).toBe(false);

  const boom = await cdpSession.send("WebMCP.invokeTool", { frameId, toolName: "boom", input: {} });
  await expect
    .poll(() => j.responded.find((r) => r.invocationId === boom.invocationId), { timeout: 10_000 })
    .toBeDefined();
  const boomReply = j.responded.find((r) => r.invocationId === boom.invocationId)!;
  expect(boomReply.status).toBe("Error");
  expect(boomReply.errorText).toContain("tool exploded");
  expect(boomReply.output).toBeUndefined();

  const nope = await cdpSession.send("WebMCP.invokeTool", { frameId, toolName: "nope", input: {} });
  await expect
    .poll(() => j.responded.find((r) => r.invocationId === nope.invocationId), { timeout: 10_000 })
    .toBeDefined();
  const nopeReply = j.responded.find((r) => r.invocationId === nope.invocationId)!;
  expect(nopeReply.status).toBe("Error");
  expect(nopeReply.errorText).toContain("no such tool");
  expect(nopeReply.output).toBeUndefined();

  await page.evaluate("void window.__registerCancellable()");
  await expect
    .poll(() => namesOf(j.added).includes("waitForCancel"), { timeout: 10_000 })
    .toBe(true);
  const waiting = await cdpSession.send("WebMCP.invokeTool", {
    frameId,
    toolName: "waitForCancel",
    input: {},
  });
  await expect
    .poll(() => j.invoked.some((e) => e.invocationId === waiting.invocationId), {
      timeout: 10_000,
    })
    .toBe(true);
  await cdpSession.send("WebMCP.cancelInvocation", {
    invocationId: waiting.invocationId,
  });
  await expect
    .poll(() => page.evaluate("window.__cancelSignalAborted"), {
      timeout: 10_000,
    })
    .toBe(true);
  await expect
    .poll(() => j.responded.find((r) => r.invocationId === waiting.invocationId)?.status, {
      timeout: 10_000,
    })
    .toBe("Canceled");

  await page.evaluate("void window.__registerLate()");
  await expect.poll(() => namesOf(j.added).includes("late"), { timeout: 10_000 }).toBe(true);
  await page.evaluate("window.__lateController.abort()");
  await expect.poll(() => namesOf(j.removed), { timeout: 10_000 }).toEqual(["late"]);
  expect(j.removed[0]!.tools[0]!.frameId).toBe(frameId);
}, 120_000);

test("WebMCP cancellation suppresses results before and after dispatch", async ({
  page,
  cdpSession,
}) => {
  const j = journal(cdpSession);
  await cdpSession.send("WebMCP.enable");
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await page.evaluate("window.__ready");
  await expect
    .poll(() => namesOf(j.added), { timeout: 10_000 })
    .toEqual(["boom", "echo", "readTitle"]);
  const frameId = j.added[0]!.tools[0]!.frameId;

  await page.evaluate(`
    (() => {
      window.__webmcpSideEffects = 0;
      window.__webmcpCompletions = 0;
      return document.modelContext.registerTool({
        name: "sideEffect",
        description: "Record that the tool ran",
        execute: async () => {
          window.__webmcpSideEffects++;
          await new Promise((resolve) => setTimeout(resolve, 500));
          window.__webmcpCompletions++;
          return {
            content: [{ type: "text", text: String(window.__webmcpSideEffects) }],
          };
        },
      });
    })()
  `);

  const queuedPromise = cdpSession.send("WebMCP.invokeTool", {
    frameId,
    toolName: "sideEffect",
    input: {},
  });
  await cdpSession.send("WebMCP.cancelInvocation", {
    invocationId: "webmcp-1",
  });
  const queued = await queuedPromise;
  expect(queued.invocationId).toBe("webmcp-1");
  await expect
    .poll(() => j.responded.find((r) => r.invocationId === queued.invocationId), {
      timeout: 10_000,
    })
    .toMatchObject({ status: "Canceled" });
  const queuedReply = j.responded.find((r) => r.invocationId === queued.invocationId)!;
  expect(queuedReply.output).toBeUndefined();
  expect(queuedReply.errorText).toBeUndefined();
  expect(j.invoked.some((e) => e.invocationId === queued.invocationId)).toBe(false);
  expect(await page.evaluate("window.__webmcpSideEffects")).toBe(0);

  const running = await cdpSession.send("WebMCP.invokeTool", {
    frameId,
    toolName: "sideEffect",
    input: {},
  });
  await expect
    .poll(() => j.invoked.some((e) => e.invocationId === running.invocationId), {
      timeout: 10_000,
    })
    .toBe(true);
  await expect
    .poll(() => page.evaluate("window.__webmcpSideEffects"), {
      timeout: 10_000,
    })
    .toBe(1);
  await cdpSession.send("WebMCP.cancelInvocation", {
    invocationId: running.invocationId,
  });
  expect(j.responded.some((r) => r.invocationId === running.invocationId)).toBe(false);
  await expect
    .poll(() => j.responded.find((r) => r.invocationId === running.invocationId), {
      timeout: 10_000,
    })
    .toMatchObject({ status: "Canceled" });
  const runningReply = j.responded.find((r) => r.invocationId === running.invocationId)!;
  expect(runningReply.output).toBeUndefined();
  expect(runningReply.errorText).toBeUndefined();
  expect(await page.evaluate("window.__webmcpSideEffects")).toBe(1);
  await expect
    .poll(() => page.evaluate("window.__webmcpCompletions"), {
      timeout: 10_000,
    })
    .toBe(1);
  expect(j.responded.filter((r) => r.invocationId === running.invocationId)).toHaveLength(1);
}, 120_000);

test("page WebMCP serializes results and propagates cancellation", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await page.evaluate("window.__ready");

  const result = JSON.parse(String(await page.evaluate("window.__cancellationScenario()")));

  expect(result).toEqual({
    annotations: {
      readOnlyHint: true,
      untrustedContentHint: false,
      consequentialHint: false,
    },
    callbackSignal: true,
    rejection: "stop",
    events: [
      "activated:abortAfterCompletionQueued",
      "activated:abortBeforeCancelTask",
      "activated:pageAbort",
      "rejected:stop",
      "signal-aborted",
      "cancel:pageAbort",
      "activated:pageCircular",
      "activated:pageObject",
      "activated:pageObject",
    ],
    objectResult: '{"ok":true}',
    abortAfterCompletionQueued: "queued completion abort",
    abortBeforeCancelTask: "abort before cancel task",
    circularError: "UnknownError",
    callbackError: "UnknownError",
    rejectionOrder: ["next-task", "rejected"],
    callbackRejectionOrder: ["next-task", "rejected"],
    resolutionOrder: ["next-task", "resolved"],
    resultWithoutTimer: '{"ok":true}',
    timerlessOrder: ["next-task", "resolved"],
  });
}, 120_000);

test("WebMCP replays tools on enable and retracts them on navigate", async ({
  page,
  cdpSession,
}) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await page.evaluate("window.__ready");

  const j = journal(cdpSession);
  await cdpSession.send("WebMCP.enable");
  await expect
    .poll(() => namesOf(j.added), { timeout: 10_000 })
    .toEqual(["boom", "echo", "readTitle"]);
  expect(j.added).toHaveLength(1);
  expect(j.added[0]!.tools.map((tool) => tool.name)).toEqual(["boom", "echo", "readTitle"]);

  await page.goto(`${ORIGIN}/__fixtures/lifecycle.html`, {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(() => namesOf(j.removed), { timeout: 10_000 })
    .toEqual(["boom", "echo", "readTitle"]);
}, 120_000);

test("WebMCP watches tools created on lazy about:blank", async ({ page, cdpSession }) => {
  const j = journal(cdpSession);
  await cdpSession.send("WebMCP.enable");

  await page.evaluate(`
    const form = document.createElement("form");
    form.setAttribute("toolname", "blank_form");
    form.setAttribute("tooldescription", "A tool created on about:blank");
    document.body.appendChild(form);
  `);

  await expect.poll(() => namesOf(j.added), { timeout: 10_000 }).toEqual(["blank_form"]);
}, 120_000);

test("WebMCP finds declarative tools after text churn skips rescans", async ({
  page,
  cdpSession,
}) => {
  const j = journal(cdpSession);
  await cdpSession.send("WebMCP.enable");
  await page.evaluate(`
    document.body.innerHTML = '<p id="t">0</p><form id="f"></form>';
    const t = document.getElementById("t");
    for (let i = 1; i <= 20; i++) t.textContent = String(i);
  `);

  await page.evaluate(`
    const f = document.getElementById("f");
    f.setAttribute("toolname", "late_attrs");
    f.setAttribute("tooldescription", "Tool attributes added later");
  `);
  await expect.poll(() => namesOf(j.added), { timeout: 10_000 }).toEqual(["late_attrs"]);

  await page.evaluate(`
    document.getElementById("t").textContent = "x";
    document.body.insertAdjacentHTML(
      "beforeend",
      '<form toolname="inserted" tooldescription="Inserted form"></form>',
    );
  `);
  await expect
    .poll(() => namesOf(j.added), { timeout: 10_000 })
    .toEqual(["inserted", "late_attrs"]);
}, 120_000);

test("WebMCP replays to a late session without re-announcing to the first", async ({
  page,
  cdpSession,
}) => {
  const first = journal(cdpSession);
  await cdpSession.send("WebMCP.enable");
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await page.evaluate("window.__ready");
  await expect
    .poll(() => namesOf(first.added), { timeout: 10_000 })
    .toEqual(["boom", "echo", "readTitle"]);
  const firstCountBefore = first.added.length;

  const second = await page.createCDPSession();
  try {
    const late = journal(second);
    await second.send("WebMCP.enable");
    await expect
      .poll(() => namesOf(late.added), { timeout: 10_000 })
      .toEqual(["boom", "echo", "readTitle"]);
    expect(first.added.length).toBe(firstCountBefore);

    await page.evaluate("void window.__registerLate()");
    await expect.poll(() => namesOf(late.added).includes("late"), { timeout: 10_000 }).toBe(true);
    await page.evaluate("window.__lateController.abort()");
    await expect.poll(() => namesOf(late.removed), { timeout: 10_000 }).toEqual(["late"]);
    await expect.poll(() => namesOf(first.removed), { timeout: 10_000 }).toEqual(["late"]);
  } finally {
    await second.detach();
  }
}, 120_000);

test("WebMCP cancellation belongs to the invoking session", async ({ page, cdpSession }) => {
  const second = await page.createCDPSession();
  try {
    const firstJournal = journal(cdpSession);
    await cdpSession.send("WebMCP.enable");
    await second.send("WebMCP.enable");
    await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
    await page.evaluate("window.__ready");
    await page.evaluate(`
      document.modelContext.registerTool({
        name: "slow",
        description: "Resolve after a delay",
        execute: () => new Promise((resolve) =>
          setTimeout(() => resolve("slow result"), 200)
        ),
      })
    `);
    await expect
      .poll(
        () =>
          firstJournal.added.flatMap((event) => event.tools).find((tool) => tool.name === "slow")
            ?.frameId,
        { timeout: 10_000 },
      )
      .toBeTruthy();
    const frameId = firstJournal.added
      .flatMap((event) => event.tools)
      .find((tool) => tool.name === "slow")!.frameId;

    const foreignCancel = await cdpSession.send("WebMCP.invokeTool", {
      frameId,
      toolName: "slow",
      input: {},
    });
    await second.send("WebMCP.cancelInvocation", {
      invocationId: foreignCancel.invocationId,
    });
    await expect
      .poll(
        () =>
          firstJournal.responded.find((event) => event.invocationId === foreignCancel.invocationId)
            ?.status,
        { timeout: 10_000 },
      )
      .toBe("Completed");

    const ownCancel = await cdpSession.send("WebMCP.invokeTool", {
      frameId,
      toolName: "slow",
      input: {},
    });
    await cdpSession.send("WebMCP.cancelInvocation", {
      invocationId: ownCancel.invocationId,
    });
    await expect
      .poll(
        () =>
          firstJournal.responded.find((event) => event.invocationId === ownCancel.invocationId)
            ?.status,
        { timeout: 10_000 },
      )
      .toBe("Canceled");
  } finally {
    await second.detach();
  }
}, 120_000);

test("WebMCP recovers tools registered at module-init scope", async ({ page, cdpSession }) => {
  const j = journal(cdpSession);
  await cdpSession.send("WebMCP.enable");
  await page.goto(`${ORIGIN}/__fixtures/webmcp-module.html`, {
    waitUntil: "load",
  });

  await expect.poll(() => namesOf(j.added), { timeout: 15_000 }).toEqual(["mod_one", "mod_two"]);
  expect(j.added.flatMap((event) => event.tools.map((tool) => tool.name))).toEqual([
    "mod_two",
    "mod_one",
  ]);
  const all = namesOf(j.added);
  expect(all).toEqual([...new Set(all)]);

  const frameId = j.added[0]!.tools[0]!.frameId;
  const { invocationId } = await cdpSession.send("WebMCP.invokeTool", {
    frameId,
    toolName: "mod_one",
    input: {},
  });
  await expect
    .poll(() => j.responded.find((r) => r.invocationId === invocationId), {
      timeout: 10_000,
    })
    .toBeDefined();
  expect(j.responded.find((r) => r.invocationId === invocationId)!.output).toEqual({
    content: [{ type: "text", text: "one" }],
  });
}, 120_000);

test("WebMCP exposes declarative form tools", async ({ page, cdpSession }) => {
  const j = journal(cdpSession);
  await cdpSession.send("WebMCP.enable");
  await page.goto(`${ORIGIN}/__fixtures/webmcp-declarative.html`, {
    waitUntil: "load",
  });

  await expect
    .poll(() => namesOf(j.added), { timeout: 15_000 })
    .toEqual(["complete_booking", "scan_url"]);
  expect(j.added.flatMap((event) => event.tools.map((tool) => tool.name))).toEqual([
    "scan_url",
    "complete_booking",
  ]);
  const announced = j.added.flatMap((event) => event.tools);
  const tool = announced.find(({ name }) => name === "complete_booking")!;
  expect(tool.backendNodeId).toBeGreaterThan(0);
  expect(tool.inputSchema).toEqual({
    type: "object",
    properties: {
      firstName: {
        type: "string",
        description: "The first name of the primary guest.",
      },
      email: {
        type: "string",
        format: "email",
        description: "The reservation confirmation email address.",
      },
      room: {
        type: "string",
        enum: ["standard", "suite"],
        description: "The room category.",
      },
    },
    required: ["firstName", "email", "room"],
  });

  await page.evaluate(`
    window.__declarativeEvents = [];
    const firstName = document.querySelector('[name="firstName"]');
    firstName.dispatchEvent = () => { throw new Error("dispatch failed"); };
    for (const name of ["email", "room"]) {
      const control = document.querySelector('[name="' + name + '"]');
      control.addEventListener("input", (event) => window.__declarativeEvents.push({
        name,
        type: event.type,
        isInputEvent: event instanceof InputEvent,
        hasData: "data" in event,
        hasInputType: "inputType" in event,
        isTrusted: event.isTrusted,
      }));
      control.addEventListener("change", (event) =>
        window.__declarativeEvents.push({ name, type: event.type }));
    }
  `);

  const isBookingFormActive = () =>
    page.evaluate(
      `document.querySelector('[toolname="complete_booking"]').matches(":tool-form-active")`,
    );
  const { invocationId } = await cdpSession.send("WebMCP.invokeTool", {
    frameId: tool.frameId,
    toolName: tool.name,
    input: { firstName: "Rui", email: "rui@example.com", room: "suite" },
  });
  await expect
    .poll(() => j.invoked.some((event) => event.invocationId === invocationId), {
      timeout: 10_000,
    })
    .toBe(true);
  await expect.poll(isBookingFormActive, { timeout: 10_000 }).toBe(true);
  expect(j.responded.some((event) => event.invocationId === invocationId)).toBe(false);
  expect(
    await page.evaluate(`JSON.stringify([
      document.querySelector('[name="firstName"]').value,
      document.querySelector('[name="email"]').value,
      document.querySelector('[name="room"]').value,
    ])`),
  ).toBe('["Rui","rui@example.com","suite"]');
  expect(
    JSON.parse(String(await page.evaluate("JSON.stringify(window.__declarativeEvents)"))),
  ).toEqual([
    {
      name: "email",
      type: "input",
      isInputEvent: true,
      hasData: true,
      hasInputType: true,
      isTrusted: true,
    },
    { name: "email", type: "change" },
    {
      name: "room",
      type: "input",
      isInputEvent: true,
      hasData: true,
      hasInputType: true,
      isTrusted: true,
    },
    { name: "room", type: "change" },
  ]);

  await page.click('[toolname="complete_booking"] button[type="submit"]');
  await expect
    .poll(() => j.responded.find((r) => r.invocationId === invocationId), {
      timeout: 10_000,
    })
    .toBeDefined();
  const bookingReply = j.responded.find((event) => event.invocationId === invocationId)!;
  expect(bookingReply.status).toBe("Completed");
  expect(bookingReply.output).toEqual({
    bookingId: "test-reservation",
    firstName: "Rui",
    room: "suite",
  });
  await expect.poll(isBookingFormActive, { timeout: 10_000 }).toBe(false);
  expect(await page.evaluate("window.__bookingAgentInvoked")).toBe(false);

  const canceledBooking = await cdpSession.send("WebMCP.invokeTool", {
    frameId: tool.frameId,
    toolName: tool.name,
    input: { firstName: "Rui", email: "rui@example.com", room: "suite" },
  });
  await expect
    .poll(() => j.invoked.some((event) => event.invocationId === canceledBooking.invocationId), {
      timeout: 10_000,
    })
    .toBe(true);
  await expect.poll(isBookingFormActive, { timeout: 10_000 }).toBe(true);
  expect(j.responded.some((event) => event.invocationId === canceledBooking.invocationId)).toBe(
    false,
  );
  await cdpSession.send("WebMCP.cancelInvocation", {
    invocationId: canceledBooking.invocationId,
  });
  await expect
    .poll(
      () =>
        j.responded.find((event) => event.invocationId === canceledBooking.invocationId)?.status,
      { timeout: 10_000 },
    )
    .toBe("Canceled");
  await expect.poll(isBookingFormActive, { timeout: 10_000 }).toBe(false);

  const scanTool = announced.find(({ name }) => name === "scan_url")!;
  expect(scanTool.annotations).toEqual({ autosubmit: true });
  const scanInvocation = await cdpSession.send("WebMCP.invokeTool", {
    frameId: scanTool.frameId,
    toolName: scanTool.name,
    input: { url: "https://example.com" },
  });
  await expect
    .poll(() => j.responded.find((r) => r.invocationId === scanInvocation.invocationId), {
      timeout: 10_000,
    })
    .toBeDefined();
  const scanState = (await page.evaluate(`({
    submitTrusted: window.__scanSubmitTrusted,
    agentInvoked: window.__scanAgentInvoked,
    submitter: window.__scanSubmitter,
  })`)) as {
    submitTrusted: unknown;
    agentInvoked: unknown;
    submitter: unknown;
  };
  expect(scanState.submitTrusted).toBe(true);
  expect(scanState.agentInvoked).toBe(true);
  expect(scanState.submitter).toBe("Scan");
  expect(j.responded.find((r) => r.invocationId === scanInvocation.invocationId)?.output).toBe(
    "Started a scan for https://example.com/. Report: /scan/test-id",
  );
  expect(page.url()).toBe(
    `${ORIGIN}/__fixtures/webmcp-declarative.html?scan=https%3A%2F%2Fexample.com`,
  );

  await page.evaluate(`
    window.__declarativeScans = 0;
    const querySelectorAll = document.querySelectorAll.bind(document);
    document.querySelectorAll = (selector) => {
      if (selector === "form[toolname][tooldescription]") window.__declarativeScans++;
      return querySelectorAll(selector);
    };
  `);
  await cdpSession.send("WebMCP.disable");
  await page.evaluate(
    `document.querySelector("form").setAttribute("tooldescription", "Updated description")`,
  );
  await page.evaluate("new Promise((resolve) => setTimeout(resolve, 0))");
  expect(await page.evaluate("window.__declarativeScans")).toBe(0);

  await Promise.all([cdpSession.send("WebMCP.enable"), cdpSession.send("WebMCP.disable")]);
  const afterRace = await page.evaluate("window.__declarativeScans");
  await page.evaluate(
    `document.querySelector("form").setAttribute("tooldescription", "Race settled")`,
  );
  await page.evaluate("new Promise((resolve) => setTimeout(resolve, 0))");
  expect(await page.evaluate("window.__declarativeScans")).toBe(afterRace);

  await cdpSession.send("WebMCP.enable");
  const second = await page.createCDPSession();
  await second.send("WebMCP.enable");
  await cdpSession.send("WebMCP.disable");
  const beforeActiveMutation = Number(await page.evaluate("window.__declarativeScans"));
  await page.evaluate(
    `document.querySelector("form").setAttribute("tooldescription", "Second session")`,
  );
  await page.evaluate("new Promise((resolve) => setTimeout(resolve, 0))");
  const afterActiveMutation = Number(await page.evaluate("window.__declarativeScans"));
  expect(afterActiveMutation).toBeGreaterThan(beforeActiveMutation);

  await second.detach();
  await page.evaluate(
    `document.querySelector("form").setAttribute("tooldescription", "No sessions")`,
  );
  await page.evaluate("new Promise((resolve) => setTimeout(resolve, 0))");
  expect(await page.evaluate("window.__declarativeScans")).toBe(afterActiveMutation);
}, 120_000);

test("registerTool rejects duplicates, empty fields and bad names", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await page.evaluate("window.__ready");

  const errorNameFor = (tool: string) => `
    document.modelContext.registerTool(${tool})
      .then(() => "resolved", (e) => e.name)
  `;

  expect(
    await page.evaluate(errorNameFor(`{ name: "echo", description: "dupe", execute: () => {} }`)),
  ).toBe("InvalidStateError");

  expect(
    await page.evaluate(errorNameFor(`{ name: "x", description: "", execute: () => {} }`)),
  ).toBe("InvalidStateError");

  expect(
    await page.evaluate(
      errorNameFor(`{
        name: "primitiveSchema", description: "d", inputSchema: 1,
        execute: () => {}
      }`),
    ),
  ).toBe("TypeError");

  expect(
    await page.evaluate(errorNameFor(`{ name: "bad name", description: "d", execute: () => {} }`)),
  ).toBe("InvalidStateError");

  expect(
    await page.evaluate(`
      (() => {
        const circular = {}; circular.self = circular;
        return document.modelContext.registerTool({
          name: "circ", description: "d", inputSchema: circular,
          execute: () => {},
        }).then(() => "resolved", (e) => e.name);
      })()
    `),
  ).toBe("TypeError");

  expect(
    await page.evaluate(`
      (() => {
        const c = new AbortController();
        c.abort();
        return document.modelContext.registerTool({
          name: "never", description: "d", execute: () => {},
        }, { signal: c.signal }).then(() => "resolved", (e) => e.name);
      })()
    `),
  ).toBe("AbortError");

  const listed = JSON.parse(
    String(
      await page.evaluate(
        `document.modelContext.getTools().then((t) =>
           JSON.stringify(t.map((x) => ({
             name: x.name, title: x.title, origin: x.origin,
             schemaType: typeof x.inputSchema,
           }))))`,
      ),
    ),
  ) as Array<Record<string, unknown>>;
  expect(listed.map((t) => t.name)).toEqual(["boom", "echo", "readTitle"]);
  expect(
    await page.evaluate(`(async () => {
      const tool = (await document.modelContext.getTools()).find((t) => t.name === "echo");
      return document.modelContext.executeTool(tool, JSON.stringify({ message: "page" }));
    })()`),
  ).toBe('{"content":[{"type":"text","text":"echo: page"}]}');
  expect(listed.find((t) => t.name === "echo")).toEqual({
    name: "echo",
    title: "Echo",
    origin: ORIGIN,
    schemaType: "object",
  });
  expect(
    await page.evaluate(`document.modelContext.getTools().then(async (tools) => {
      tools.find((tool) => tool.name === "echo").inputSchema.type = "changed";
      const fresh = await document.modelContext.getTools();
      return fresh.find((tool) => tool.name === "echo").inputSchema.type;
    })`),
  ).toBe("object");
}, 120_000);

// A control named "elements" overrides form.elements for page code only; the tool still sees
// every control, for its schema and when an agent fills it.
test("a declarative tool form with a control named elements keeps its schema", async ({
  page,
  cdpSession,
}) => {
  const j = journal(cdpSession);
  await cdpSession.send("WebMCP.enable");
  const doc = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
  doc.searchParams.set(
    "body",
    `<form toolname="lookup" tooldescription="Look up an item" onsubmit="event.preventDefault()">` +
      `<input name="q" required><input name="elements"><button>go</button></form>`,
  );
  await page.goto(doc.toString(), { waitUntil: "load" });
  await expect.poll(() => namesOf(j.added), { timeout: 15_000 }).toEqual(["lookup"]);
  const tool = j.added.flatMap((event) => event.tools).find(({ name }) => name === "lookup")!;
  expect(Object.keys(tool.inputSchema?.properties ?? {}).sort()).toEqual(["elements", "q"]);
  await cdpSession.send("WebMCP.invokeTool", {
    frameId: tool.frameId,
    toolName: "lookup",
    input: { q: "hat", elements: "two" },
  });
  await expect
    .poll(
      () => page.evaluate(() => (document.querySelector("[name=q]") as HTMLInputElement).value),
      {
        timeout: 10_000,
      },
    )
    .toBe("hat");
}, 60_000);
