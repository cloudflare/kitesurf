// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, expect, it, vi } from "vitest";
import { DocumentImpl } from "../src/document.js";
import { installWindow } from "../src/window.js";

const ORIGIN = "https://attacker.example";
const current = vi.hoisted(() => ({ url: "", documentUrl: "" }));
vi.mock("../src/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/state.js")>()),
  getCurrentUrl: () => current.url,
  getDocumentUrl: () => current.documentUrl || current.url,
}));

function historyWith(url = `${ORIGIN}/start`) {
  current.url = url;
  current.documentUrl = url;
  return installWindow(new DocumentImpl()).windowObj.history;
}
function attempt(
  history: ReturnType<typeof historyWith>,
  method: "pushState" | "replaceState",
  url: string | null | undefined,
) {
  try {
    history[method]({ marker: url }, "", url);
    return "success";
  } catch (error) {
    return error instanceof Error ? error.name : "unknown error";
  }
}
function failure(
  history: ReturnType<typeof historyWith>,
  method: "pushState" | "replaceState",
  url: string | null | undefined,
): { name: string; message: string } | null {
  try {
    history[method]({ marker: url }, "", url);
    return null;
  } catch (error) {
    const e = error as { name?: unknown; message?: unknown } | null;
    return { name: String(e?.name ?? ""), message: String(e?.message ?? "") };
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["pushState", "replaceState"] as const)("%s rejects cross-origin URLs", (method) => {
  const history = historyWith();
  vi.spyOn(URL.prototype, "origin", "get").mockReturnValue(ORIGIN);
  vi.stubGlobal("URL", URL.bind(null, `${ORIGIN}/`));
  expect(attempt(history, method, "https://victim.example/")).toBe("SecurityError");
  expect(history.length).toBe(1);
  expect(attempt(history, "pushState", "/next")).toBe("success");
});

it.each(["pushState", "replaceState"] as const)("%s rejects an invalid current URL", (method) => {
  const history = historyWith("not-a-url");
  expect(attempt(history, method, "https://victim.example/")).toBe("SecurityError");
});

it.each([
  ["pushState", 2],
  ["replaceState", 1],
] as const)("%s with no URL still succeeds when the document URL is empty", (method, length) => {
  const history = historyWith("");
  expect(attempt(history, method, undefined)).toBe("success");
  expect(history.length).toBe(length);
});

it.each(["pushState", "replaceState"] as const)(
  "%s names an invalid current URL before parsing the target",
  (method) => {
    const history = historyWith("not-a-url");
    const error = failure(history, method, "also-not-a-url");
    expect(error?.name).toBe("SecurityError");
    expect(error?.message).toContain("current document URL is invalid");
  },
);

it("validates against the committed document URL after a cross-origin navigation starts", () => {
  const history = historyWith("https://page.example/");
  // `location.href =` advances the page URL synchronously; the document URL
  // stays on the committed document until the navigation commits.
  current.url = "https://attacker.example/x";
  expect(attempt(history, "pushState", "https://attacker.example/x.js")).toBe("SecurityError");
  expect(history.length).toBe(1);
  expect(attempt(history, "pushState", "/next")).toBe("success");
  expect(history.length).toBe(2);
});
