// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("percentage/calc margin and padding resolve to used px values", async ({ page }) => {
  await setContent(
    page,
    `<div style="width:200px">
      <div id="target" style="width:0px;font-size:40px;
        margin-right:20%;padding-left:calc(10% + 40px)"></div>
    </div>`,
  );
  const result = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById("target")!);
    return { marginRight: s.marginRight, paddingLeft: s.paddingLeft };
  });
  expect(result.marginRight).toBe("40px");
  expect(result.paddingLeft).toBe("60px");
}, 60_000);

test("an explicit length margin survives an over-constrained box unchanged", async ({ page }) => {
  await setContent(
    page,
    `<div style="width:200px">
      <div id="target" style="width:0px;margin-left:0px;margin-right:20px"></div>
    </div>`,
  );
  const marginRight = await page.evaluate(
    () => getComputedStyle(document.getElementById("target")!).marginRight,
  );
  expect(marginRight).toBe("20px");
}, 60_000);

test("width/height auto and min-content/max-content resolve to the used size", async ({ page }) => {
  await setContent(
    page,
    `<div style="width:200px">
      <div id="target" style="width:0px;height:0px">
        <div id="child" style="width:60px;height:80px"></div>
      </div>
    </div>`,
  );
  const result = await page.evaluate(() => {
    const target = document.getElementById("target")!;
    target.style.width = "auto";
    const inlineAuto = getComputedStyle(target).width;
    target.style.width = "min-content";
    const minContent = getComputedStyle(target).width;
    return { inlineAuto, minContent };
  });
  expect(result.inlineAuto).toBe("200px");
  expect(result.minContent).toBe("60px");
}, 60_000);

test("Typed OM keeps the computed width while CSSOM exposes its used value", async ({ page }) => {
  await setContent(
    page,
    `<div style="width:200px"><div id="target" style="width:25%"></div></div>`,
  );
  const result = await page.evaluate(() => {
    const target = document.getElementById("target")!;
    const typed = (target as any).computedStyleMap().get("width");
    return {
      cssom: getComputedStyle(target).width,
      typed: [typed.value, typed.unit],
    };
  });
  expect(result).toEqual({ cssom: "50px", typed: [25, "percent"] });
}, 60_000);

test("used width respects border-box sizing and min/max constraints", async ({ page }) => {
  await setContent(
    page,
    `<div style="width:200px">
      <div id="border-box" style="box-sizing:border-box;width:50%;padding:10px;border:5px solid"></div>
      <div id="clamped" style="width:200px;max-width:100px"></div>
    </div>`,
  );
  const result = await page.evaluate(() => ({
    borderBox: getComputedStyle(document.getElementById("border-box")!).width,
    clamped: getComputedStyle(document.getElementById("clamped")!).width,
  }));
  expect(result).toEqual({ borderBox: "100px", clamped: "100px" });
}, 60_000);

test("non-replaced inline properties do not read zeroed layout fields", async ({ page }) => {
  await setContent(
    page,
    `<div style="width:200px"><span id="target" style="width:50%;margin-left:10%">x</span></div>`,
  );
  const result = await page.evaluate(() => {
    const style = getComputedStyle(document.getElementById("target")!);
    return { width: style.width, marginLeft: style.marginLeft };
  });
  expect(result).toEqual({ width: "50%", marginLeft: "10%" });
}, 60_000);

test("min-width/min-height auto resolves to 0px outside flex/grid", async ({ page }) => {
  await setContent(page, `<div id="target" style="min-width:auto;min-height:auto"></div>`);
  const result = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById("target")!);
    return { minWidth: s.minWidth, minHeight: s.minHeight };
  });
  expect(result).toEqual({ minWidth: "0px", minHeight: "0px" });
}, 60_000);

test("sticky insets resolve against the correct per-axis scrollport", async ({ page }) => {
  await setContent(
    page,
    `<div style="overflow:hidden;width:200px;height:150px">
      <div style="overflow:hidden clip;width:120px;height:80px">
        <div id="target" style="position:sticky;
          inset:50% calc(20% + 5px) calc(20% + 5px) 60%"></div>
      </div>
    </div>`,
  );
  const result = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById("target")!);
    return { top: s.top, right: s.right, bottom: s.bottom, left: s.left };
  });
  expect(result).toEqual({ top: "75px", right: "29px", bottom: "35px", left: "72px" });
}, 60_000);

test("computed style resolves layout-backed length percentages", async ({ page }) => {
  await setContent(
    page,
    `<div id="container" style="width: 400px">
      <div id="target" style="margin-left: min(20px, 10%); width: calc(60% - 20px)"></div>
    </div>
    <div style="width: 200px">
      <div id="auto-block"></div>
      <span id="inline" style="width: calc(50% - 10px)"></span>
      <p><span id="inline-margin" style="margin-left: 17px">inline</span>
      <span id="inline-block-margin" style="display: inline-block; margin-left: 19px">inline-block</span></p>
      <p><img id="float-margin" style="float: right; margin-left: 23px">float text</p>
    </div>
    <div style="display: table">
      <div id="table-row" style="display: table-row; margin-left: min(20px, 10%)"></div>
    </div>
    <div id="border-box" style="box-sizing: border-box; width: 100px; padding: 10px; border: 5px solid"></div>
    <div id="subpixel" style="width: 161.25px"></div>
    <div id="constrained" style="width: 200px; max-width: 100px"></div>
    <div id="contents" style="display: contents; width: auto"></div>
    <div id="hidden" style="display: none; margin-left: min(20px, 10%); width: calc(60% - 20px)"></div>`,
  );

  const result = await page.evaluate(() => {
    const container = document.getElementById("container");
    const target = document.getElementById("target");
    const autoBlock = document.getElementById("auto-block");
    const inline = document.getElementById("inline");
    const inlineMargin = document.getElementById("inline-margin");
    const inlineBlockMargin = document.getElementById("inline-block-margin");
    const floatMargin = document.getElementById("float-margin");
    const tableRow = document.getElementById("table-row");
    const borderBox = document.getElementById("border-box");
    const subpixel = document.getElementById("subpixel");
    const constrained = document.getElementById("constrained");
    const contents = document.getElementById("contents");
    const hidden = document.getElementById("hidden");
    if (
      !container ||
      !target ||
      !autoBlock ||
      !inline ||
      !inlineMargin ||
      !inlineBlockMargin ||
      !floatMargin ||
      !tableRow ||
      !borderBox ||
      !subpixel ||
      !constrained ||
      !contents ||
      !hidden
    ) {
      throw new Error("fixture elements missing");
    }

    const before = getComputedStyle(target);
    const initial = { marginLeft: before.marginLeft, width: before.width };
    container.style.width = "100px";
    const after = getComputedStyle(target);
    const hiddenStyle = getComputedStyle(hidden);

    return {
      initial,
      resized: { marginLeft: after.marginLeft, width: after.width },
      autoBlockWidth: getComputedStyle(autoBlock).width,
      inlineWidth: getComputedStyle(inline).width,
      inlineMargins: {
        inline: getComputedStyle(inlineMargin).marginLeft,
        inlineBlock: getComputedStyle(inlineBlockMargin).marginLeft,
        float: getComputedStyle(floatMargin).marginLeft,
      },
      tableRowMargin: getComputedStyle(tableRow).marginLeft,
      borderBoxWidth: getComputedStyle(borderBox).width,
      subpixelWidth: getComputedStyle(subpixel).width,
      constrainedWidth: getComputedStyle(constrained).width,
      contentsWidth: getComputedStyle(contents).width,
      typedWidths: {
        auto: (autoBlock as any).computedStyleMap().get("width").toString(),
        percentage: (() => {
          target.style.width = "25%";
          return (target as any).computedStyleMap().get("width").toString();
        })(),
      },
      hidden: {
        marginLeft: hiddenStyle.marginLeft,
        width: hiddenStyle.width,
      },
    };
  });

  expect(result.initial).toEqual({ marginLeft: "20px", width: "220px" });
  expect(result.resized).toEqual({ marginLeft: "10px", width: "40px" });
  expect(result.autoBlockWidth).toBe("200px");
  expect(result.inlineWidth).toBe("calc(50% - 10px)");
  expect(result.inlineMargins).toEqual({
    inline: "17px",
    inlineBlock: "19px",
    float: "23px",
  });
  expect(result.tableRowMargin).toBe("min(20px, 10%)");
  expect(result.borderBoxWidth).toBe("100px");
  expect(result.subpixelWidth).toBe("161.25px");
  expect(result.constrainedWidth).toBe("100px");
  expect(result.contentsWidth).toBe("auto");
  expect(result.typedWidths).toEqual({ auto: "auto", percentage: "25%" });
  expect(result.hidden).toEqual({
    marginLeft: "min(20px, 10%)",
    width: "calc(60% - 20px)",
  });
});
