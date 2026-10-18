// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

interface ComputedStyleProbe {
  targetFound?: boolean;
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
  display?: string;
  kebab?: string;
  viaMethod?: string;
  viaMethodCamel?: string;
  parentRule?: unknown;
  length?: number;
  unknown?: string;
  bodyDisplay?: string;
  assignThrew?: boolean;
  assignError?: string;
  setPropertyThrew?: boolean;
  setPropertyError?: string;
  error?: string;
}

test("window.getComputedStyle exposes values and stays read-only", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html>
    <html><head>
    <style>
      #target { color: rgb(255, 0, 0); background-color: rgb(0, 128, 255); font-size: 24px; display: block; }
      #parent { background-color: rgb(0, 200, 100); }
      #child { }
    </style>
    </head><body>
    <div id="target">styled</div>
    <div id="parent"><div id="child">child</div></div>
    </body></html>
  `,
  );

  const result = await page.evaluate(() => {
    const out: ComputedStyleProbe = {};
    try {
      const target = document.getElementById("target");
      out.targetFound = !!target;
      const s = window.getComputedStyle(target!) as CSSStyleDeclaration & {
        "background-color": string;
        parentRule: unknown;
        thisPropertyDoesNotExist: string;
      };
      out.color = s.color;
      out.backgroundColor = s.backgroundColor;
      out.fontSize = s.fontSize;
      out.display = s.display;
      out.kebab = s["background-color"];
      out.viaMethod = s.getPropertyValue("background-color");
      out.viaMethodCamel = s.getPropertyValue("backgroundColor");
      out.parentRule = s.parentRule;
      out.length = s.length;
      out.unknown = s.thisPropertyDoesNotExist;

      const bodyStyle = window.getComputedStyle(document.body);
      out.bodyDisplay = bodyStyle.display;

      try {
        s.color = "blue";
        out.assignThrew = false;
      } catch (e) {
        out.assignThrew = true;
        out.assignError = (e as Error)?.name;
      }
      try {
        s.setProperty("color", "blue");
        out.setPropertyThrew = false;
      } catch (e) {
        out.setPropertyThrew = true;
        out.setPropertyError = (e as Error)?.name;
      }
    } catch (err) {
      out.error = String((err as Error)?.stack || (err as Error)?.message || err);
    }
    return out;
  });

  expect(result.targetFound, "target element is present").toBe(true);
  expect(result.color, "color resolves to rgb(255, 0, 0)").toBe("rgb(255, 0, 0)");
  expect(result.backgroundColor, "backgroundColor resolves to rgb(0, 128, 255)").toBe(
    "rgb(0, 128, 255)",
  );
  expect(result.fontSize, "fontSize resolves to 24px").toBe("24px");
  expect(result.display, "display resolves to block").toBe("block");
  expect(result.kebab, "kebab indexed access reads background-color").toBe("rgb(0, 128, 255)");
  expect(result.viaMethod, "getPropertyValue accepts background-color").toBe("rgb(0, 128, 255)");
  expect(result.viaMethodCamel, "getPropertyValue rejects camel-case names").toBe("");
  expect(result.parentRule, "parentRule is null").toBe(null);
  expect(
    typeof result.length === "number" && result.length > 100,
    "computed style exposes more than 100 longhand properties",
  ).toBe(true);
  expect(result.unknown, "unknown property reads as an empty string").toBe("");
  expect(
    typeof result.bodyDisplay === "string" && result.bodyDisplay.length > 0,
    "computed style for body has a non-empty display value",
  ).toBe(true);
  expect(
    result.assignThrew === true && result.assignError === "NoModificationAllowedError",
    "assigning a computed property throws NoModificationAllowedError",
  ).toBe(true);
  expect(
    result.setPropertyThrew === true && result.setPropertyError === "NoModificationAllowedError",
    "setProperty on computed style throws NoModificationAllowedError",
  ).toBe(true);
});
