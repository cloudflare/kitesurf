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

    function errorText(error: unknown): string {
      const value = error as Error;
      return String(value?.stack || value?.message || error);
    }

    function recordComputedStyle(
      style: CSSStyleDeclaration & {
        "background-color": string;
        parentRule: unknown;
        thisPropertyDoesNotExist: string;
      },
    ): void {
      out.color = style.color;
      out.backgroundColor = style.backgroundColor;
      out.fontSize = style.fontSize;
      out.display = style.display;
      out.kebab = style["background-color"];
      out.viaMethod = style.getPropertyValue("background-color");
      out.viaMethodCamel = style.getPropertyValue("backgroundColor");
      out.parentRule = style.parentRule;
      out.length = style.length;
      out.unknown = style.thisPropertyDoesNotExist;
    }

    function recordAssignmentFailure(style: CSSStyleDeclaration): void {
      try {
        style.color = "blue";
        out.assignThrew = false;
      } catch (error) {
        out.assignThrew = true;
        out.assignError = (error as Error)?.name;
      }
    }

    function recordSetPropertyFailure(style: CSSStyleDeclaration): void {
      try {
        style.setProperty("color", "blue");
        out.setPropertyThrew = false;
      } catch (error) {
        out.setPropertyThrew = true;
        out.setPropertyError = (error as Error)?.name;
      }
    }

    try {
      const target = document.getElementById("target");
      out.targetFound = !!target;
      const style = window.getComputedStyle(target!) as CSSStyleDeclaration & {
        "background-color": string;
        parentRule: unknown;
        thisPropertyDoesNotExist: string;
      };
      recordComputedStyle(style);

      const bodyStyle = window.getComputedStyle(document.body);
      out.bodyDisplay = bodyStyle.display;
      recordAssignmentFailure(style);
      recordSetPropertyFailure(style);
    } catch (error) {
      out.error = errorText(error);
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
