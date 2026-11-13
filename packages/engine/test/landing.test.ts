// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { landingPage } from "../src/landing.ts";

const formAction = (base: string | null): string | undefined =>
  /form-action ([^;]+);/.exec(
    landingPage(new URL("https://ks.invalid/"), base).headers.get("content-security-policy") ?? "",
  )?.[1];

describe("landing page form-action", () => {
  it("allows the origin that the /?url= redirect resolves the frontend to", () => {
    expect(formAction("https://example.com/devtools/")).toBe("'self' https://example.com");
    expect(formAction("//example.com/inspector.html")).toBe("'self' https://example.com");
  });

  it("stays on this origin for a same-origin frontend or none", () => {
    expect(formAction("/inspector/inspector.html")).toBe("'self'");
    expect(formAction("https://ks.invalid/inspector/inspector.html")).toBe("'self'");
    expect(formAction(null)).toBe("'self'");
  });
});
