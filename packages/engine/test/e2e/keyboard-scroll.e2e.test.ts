// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { bbox, decodePng } from "./png";
import { setContent } from "./set-content";

test("terminal Vim keys, arrows, page keys and Space scroll unless editing or canceled", async ({
  page,
  cdpSession,
}) => {
  await page.setViewport({ width: 320, height: 170 });
  await page.goto("https://ks.invalid/__fixtures/events.html?ks_tty_css=1", {
    waitUntil: "domcontentloaded",
  });
  await page.evaluate(() => {
    document.body.innerHTML = `
      <input id="field"><div id="editor" contenteditable="true">edit me</div>
      <button id="button">press</button><div style="height:2400px">page</div>`;
    const button = document.querySelector<HTMLButtonElement>("#button");
    if (!button) throw new Error("Missing button");
    button.dataset.clicks = "0";
    button.addEventListener("click", () => {
      button.dataset.clicks = String(Number(button.dataset.clicks) + 1);
    });
    document.body.style.width = "1000px";
  });
  const press = async (key: string, modifiers = 0, text = "") => {
    await cdpSession.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      text,
      modifiers,
    });
    return page.evaluate(() => scrollY);
  };

  expect(await press("j")).toBe(17);
  expect(await press("k")).toBe(0);
  await press("l");
  expect(await page.evaluate(() => scrollX)).toBe(8);
  await press("h");
  expect(await page.evaluate(() => scrollX)).toBe(0);
  expect(await press("ArrowDown")).toBe(17);
  expect(await press("ArrowUp")).toBe(0);
  expect(await press("PageDown")).toBeGreaterThan(100);
  expect(await press("PageUp")).toBe(0);
  expect(await press(" ", 0, " ")).toBeGreaterThan(100);
  expect(await press(" ", 8)).toBe(0);
  expect(await press("f", 2)).toBeGreaterThan(100);
  expect(await press("b", 2)).toBe(0);
  expect(await press("d", 2)).toBe(85);
  expect(await press("u", 2)).toBe(0);

  await page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>("#field");
    if (!field) throw new Error("Missing field");
    field.focus();
  });
  expect(await press("j", 0, "j")).toBe(0);
  expect(await page.evaluate(() => document.querySelector<HTMLInputElement>("#field")?.value)).toBe(
    "j",
  );
  expect(await press("ArrowDown")).toBe(0);
  await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>("#editor");
    if (!editor) throw new Error("Missing editor");
    editor.focus();
  });
  expect(await press("j")).toBe(0);

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
  });
  expect(await press("j")).toBe(0);
  expect(await press("j")).toBe(17);
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("#button");
    if (!button) throw new Error("Missing button");
    button.focus();
  });
  expect(await press(" ")).toBe(17);
  await cdpSession.send("Input.dispatchKeyEvent", { type: "keyUp", key: " " });
  expect(
    await page.evaluate(() => document.querySelector<HTMLButtonElement>("#button")?.dataset.clicks),
  ).toBe("1");
  expect(
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", `<a href="#target" id="link">link</a>`);
      const link = document.querySelector<HTMLElement>("#link");
      if (!link) throw new Error("Missing link");
      link.focus();
      const css = getComputedStyle(link);
      return { display: css.display, background: css.backgroundColor };
    }),
  ).toEqual({ display: "inline", background: "rgb(40, 74, 154)" });
}, 120_000);

test("terminal link underlines preserve indented, wrapped and block link layout", async ({
  page,
  cdpSession,
}) => {
  await page.setViewport({ width: 400, height: 400 });
  await cdpSession.send("Kitesurf.startSceneStream", {
    width: 400,
    height: 400,
    fps: 1,
    terminal: true,
  });
  try {
    await setContent(
      page,
      `<style>
      body { margin: 0; background: white; font: 20px/30px monospace }
      a { color: #009dec; text-decoration: none; outline: none }
      nav { margin-left: 32px; width: 160px; overflow-x: hidden; overflow-y: auto }
      ul { list-style: none; margin: 0; padding: 0 }
      li { margin-left: 1em; text-indent: -1em }
      p { margin: 30px 32px; width: 140px }
      #block { display: block; margin: 30px 32px; width: 150px }
    </style><nav><ul><li><a id="about" href="#about">About</a></li>
      <li><a id="features" href="#features">Features</a></li></ul></nav>
    <p><a id="wrapped" href="#wrapped">one <span>two three</span> four five</a><span id="after"> end</span></p>
    <a id="block" href="#block">Block link</a>`,
    );
    const geometry = () =>
      page.evaluate(() => {
        return ["about", "features", "wrapped", "after", "block"].map((id) => {
          const element = document.getElementById(id);
          if (!element) throw new Error(`Missing ${id}`);
          const rect = element.getBoundingClientRect();
          return {
            id,
            display: getComputedStyle(element).display,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        });
      });
    const before = await geometry();
    const screenshot = async () =>
      decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
    const blue = (r: number, g: number, b: number) => r < 80 && g > 100 && b > 150;
    const red = (r: number, g: number, b: number) => r > 190 && g < 80 && b < 80;
    const original = await screenshot();
    const aboutText = bbox(original, 0, 30, blue);
    const boundsWidth = (bounds: ReturnType<typeof bbox>) => bounds?.w;
    const boundsHeight = (bounds: ReturnType<typeof bbox>) => bounds?.h;
    const activeId = () => page.evaluate(() => document.activeElement?.id);
    expect(boundsWidth(aboutText)).toBeGreaterThan(20);
    expect(bbox(original, 0, 400, red)).toBeNull();

    const assertUnderlineLine = (
      shot: Awaited<ReturnType<typeof screenshot>>,
      y: number,
      id: string,
    ) => {
      const line = bbox(shot, Math.floor(y), Math.ceil(y + 30), red);
      const text = bbox(shot, Math.floor(y), Math.ceil(y + 30), blue);
      expect(boundsWidth(line)).toBeGreaterThan(20);
      expect(boundsHeight(line)).toBeLessThanOrEqual(3);
      if (!line || !text) throw new Error(`Missing underline or text for ${id}`);
      expect(line.y).toBeGreaterThanOrEqual(text.y + text.h);
    };
    const assertFocusedLink = async (id: string) => {
      expect(await activeId()).toBe(id);
      expect(await geometry()).toEqual(before);
      const shot = await screenshot();
      const link = before.find((rect) => rect.id === id);
      if (!link) throw new Error(`Missing geometry for ${id}`);
      expect(
        boundsWidth(
          bbox(shot, Math.max(0, Math.floor(link.y - 3)), Math.ceil(link.y + link.height + 3), red),
        ),
      ).toBeGreaterThan(20);
      expect(bbox(shot, 0, 30, blue)).toEqual(aboutText);
      if (id === "wrapped") expect(link.height).toBeGreaterThan(30);
      for (let y = link.y; y < link.y + link.height; y += 30) {
        assertUnderlineLine(shot, y, id);
      }
      if (id !== "about") expect(bbox(shot, 0, 28, red)).toBeNull();
    };

    for (const [id, modifiers] of [
      ["about", 0],
      ["features", 0],
      ["wrapped", 0],
      ["block", 0],
      ["wrapped", 8],
    ] as const) {
      await cdpSession.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Tab",
        code: "Tab",
        modifiers,
      });
      await assertFocusedLink(id);
    }
  } finally {
    await cdpSession.send("Kitesurf.stopSceneStream");
  }
}, 120_000);

test("terminal focus underline reaches Wikipedia-style block labels", async ({
  page,
  cdpSession,
}) => {
  await page.setViewport({ width: 400, height: 300 });
  await cdpSession.send("Kitesurf.startSceneStream", {
    width: 400,
    height: 300,
    fps: 1,
    terminal: true,
  });
  try {
    await setContent(
      page,
      `<style>
      body { margin: 20px; background: white; font: 16px/24px sans-serif }
      .link-box { display: block; width: 156px; text-align: center; color: #36c;
        text-decoration: none; margin-bottom: 20px }
      .link-box strong { display: block }
      .link-box small { display: inline-block; color: #54595d; font-size: 13px }
    </style><a id="english" class="link-box" href="#english"><strong>English</strong>
      <small>7,249,000+ <span>articles</span></small></a>
    <a id="portuguese" class="link-box" href="#portuguese"><strong>Português</strong>
      <small>1,184,000+ <span>artigos</span></small></a>`,
    );
    const geometry = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("a, strong, small")].map((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }),
      );
    const before = await geometry();
    const red = (r: number, g: number, b: number) => r > 190 && g < 80 && b < 80;
    const assertLabelUnderline = (line: ReturnType<typeof bbox>, selected: boolean) => {
      if (selected) {
        expect(line?.w).toBeGreaterThan(30);
        expect(line?.h).toBeLessThanOrEqual(3);
      } else {
        expect(line).toBeNull();
      }
    };
    for (const id of ["english", "portuguese"]) {
      await cdpSession.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab" });
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(id);
      expect(await geometry()).toEqual(before);
      const labels = await page.evaluate(() =>
        [...document.querySelectorAll("strong")].map((element) => {
          const rect = element.getBoundingClientRect();
          return { y: rect.y, height: rect.height };
        }),
      );
      const shot = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
      for (const [index, label] of labels.entries()) {
        const line = bbox(shot, Math.floor(label.y), Math.ceil(label.y + label.height), red);
        assertLabelUnderline(line, index === (id === "english" ? 0 : 1));
      }
    }
  } finally {
    await cdpSession.send("Kitesurf.stopSceneStream");
  }
}, 120_000);

test("terminal focus underlines cross Wikipedia footer and flex/grid link containers", async ({
  page,
  cdpSession,
}) => {
  await page.setViewport({ width: 420, height: 500 });
  await cdpSession.send("Kitesurf.startSceneStream", {
    width: 420,
    height: 500,
    fps: 1,
    terminal: true,
  });
  try {
    await setContent(
      page,
      `<style>
      body { margin: 20px; background: white; font: 16px/24px sans-serif }
      a { display: inline-block; width: 320px; padding: 16px; text-decoration: none; color: #36c }
      .icon { display: inline-block; width: 50px; height: 47px; background: #eee }
      .text { display: inline-block; vertical-align: middle; max-width: 65% }
      .title, .tagline { display: block; text-decoration: none !important }
      .tagline { color: #54595d; font-size: 13px }
      #flex { display: flex }
      #grid { display: grid; grid-template-columns: 50px 1fr }
    </style><div><a id="commons" href="#commons"><span class="icon"></span>
      <div class="text"><span class="title">Commons</span><span class="tagline">Free media collection</span></div>
    </a></div><div><a id="wikibooks" href="#wikibooks"><span class="icon"></span>
      <div class="text"><span class="title">Wikibooks</span><span class="tagline">Free textbooks</span></div>
    </a></div><div><a id="flex" href="#flex"><span class="icon"></span>
      <div class="text"><span class="title">Flex link</span><span class="tagline">nested content</span></div>
    </a></div><div><a id="grid" href="#grid"><span class="icon"></span>
      <div class="text"><span class="title">Grid link</span><span class="tagline">nested content</span></div>
    </a></div>`,
    );
    const geometry = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("a, a *")].map((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }),
      );
    const before = await geometry();
    const screenshot = async () =>
      decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
    const red = (r: number, g: number, b: number) => r > 190 && g < 80 && b < 80;
    const ink = (r: number, g: number, b: number) => b > r && r < 130 && g < 130;
    const assertLabelUnderline = (line: ReturnType<typeof bbox>, selected: boolean) => {
      if (selected) {
        expect(line?.w).toBeGreaterThan(30);
        expect(line?.h).toBeLessThanOrEqual(3);
      } else {
        expect(line).toBeNull();
      }
    };
    const original = await screenshot();
    expect(bbox(original, 0, 500, red)).toBeNull();
    for (const [id, modifiers] of [
      ["commons", 0],
      ["wikibooks", 0],
      ["flex", 0],
      ["grid", 0],
      ["flex", 8],
    ] as const) {
      await cdpSession.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", modifiers });
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(id);
      expect(await geometry()).toEqual(before);
      const labels = await page.evaluate(() =>
        [...document.querySelectorAll(".title, .tagline")].map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            owner: element.closest("a")?.id,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        }),
      );
      const shot = await screenshot();
      for (const label of labels) {
        const top = Math.floor(label.y),
          bottom = Math.ceil(label.y + label.height);
        // Inter-box whitespace can have an underline on a different baseline.
        // Measure only the label when that baseline crosses its vertical band.
        const line = bbox(
          shot,
          top,
          bottom,
          red,
          Math.ceil(label.x),
          Math.floor(label.x + label.width),
        );
        expect(bbox(shot, top, bottom, ink)).toEqual(bbox(original, top, bottom, ink));
        assertLabelUnderline(line, label.owner === id);
      }
    }
  } finally {
    await cdpSession.send("Kitesurf.stopSceneStream");
  }
}, 120_000);

test("block decorations respect atomic and out-of-flow boundaries and parent opacity", async ({
  page,
}) => {
  await page.setViewport({ width: 400, height: 350 });
  await setContent(
    page,
    `<style>
    body { margin: 20px; background: white; font: 16px/24px sans-serif }
    section { text-decoration: underline solid red 2px; text-underline-offset: 2px; opacity: .5 }
    .row { height: 50px }
  </style><section>
    <div class="row"><div id="flow">in-flow block</div></div>
    <div class="row"><span id="atomic" style="display:inline-block">atomic inline</span></div>
    <div class="row"><span id="floating" style="float:left">floating text</span></div>
    <div class="row" style="position:relative"><span id="absolute" style="position:absolute">absolute text</span></div>
    <div class="row"><span id="own" style="display:inline-block;text-decoration:underline solid green 2px">own underline</span></div>
  </section>`,
  );
  const rects = await page.evaluate(() =>
    ["flow", "atomic", "floating", "absolute", "own"].map((id) => {
      const element = document.getElementById(id);
      if (!element) throw new Error(`Missing ${id}`);
      const rect = element.getBoundingClientRect();
      return { id, y: rect.y, height: rect.height };
    }),
  );
  const shot = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const inRange = (value: number, min: number, max: number) => value > min && value < max;
  const boundsWidth = (bounds: ReturnType<typeof bbox>) => bounds?.w;
  const boundsHeight = (bounds: ReturnType<typeof bbox>) => bounds?.h;
  const fadedRed = (r: number, g: number, b: number) =>
    r > 240 && g > 110 && g < 145 && b > 110 && b < 145;
  const fadedGreen = (r: number, g: number, b: number) =>
    inRange(r, 110, 145) && inRange(g, 175, 210) && inRange(b, 110, 145);
  const assertDecoration = (rect: (typeof rects)[number]) => {
    const line = bbox(shot, Math.floor(rect.y), Math.ceil(rect.y + rect.height + 4), fadedRed);
    if (rect.id === "flow") {
      expect(boundsWidth(line)).toBeGreaterThan(30);
      expect(boundsHeight(line)).toBeLessThanOrEqual(3);
    } else {
      expect(line).toBeNull();
    }
    if (rect.id === "own") {
      expect(
        boundsWidth(
          bbox(shot, Math.floor(rect.y), Math.ceil(rect.y + rect.height + 4), fadedGreen),
        ),
      ).toBeGreaterThan(30);
    }
  };
  for (const rect of rects) assertDecoration(rect);
}, 120_000);

test("Vim letters remain page keys without terminal mode", async ({ page, cdpSession }) => {
  await page.setViewport({ width: 320, height: 170 });
  await setContent(page, `<div style="height:2400px">page</div>`);
  const press = async (key: string) => {
    await cdpSession.send("Input.dispatchKeyEvent", { type: "keyDown", key });
    return page.evaluate(() => scrollY);
  };
  expect(await press("j")).toBe(0);
  expect(await press("ArrowDown")).toBeGreaterThan(0);
  expect(await press("ArrowUp")).toBe(0);
  expect(await press(" ")).toBeGreaterThan(0);
}, 120_000);

test("terminal scene stream keeps Vim scrolling and paints focused inline links", async ({
  browserFactory,
}) => {
  const browser = await browserFactory();
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  const session = await page.createCDPSession();
  try {
    await page.setViewport({ width: 320, height: 170 });
    await session.send("Kitesurf.startSceneStream", {
      width: 320,
      height: 240,
      fps: 1,
      terminal: true,
    });
    await setContent(
      page,
      `<style>a:focus { text-decoration: none !important }</style>
      <a id="link" href="#target">focused link</a><div style="height:2400px">page</div>`,
    );
    await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "j" });
    expect(await page.evaluate(() => scrollY)).toBe(40);
    await page.evaluate(() => scrollTo(0, 0));
    await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab" });
    expect(
      await page.evaluate(() => ({
        id: document.activeElement?.id,
        decoration: document.activeElement
          ? getComputedStyle(document.activeElement).textDecorationLine
          : null,
        color: document.activeElement
          ? getComputedStyle(document.activeElement).textDecorationColor
          : null,
      })),
    ).toEqual({ id: "link", decoration: "underline", color: "rgb(255, 0, 0)" });
    const shot = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
    expect(bbox(shot, 0, 50, (r, g, b) => r > 190 && g < 80 && b < 80)?.w).toBeGreaterThan(20);
  } finally {
    await session.send("Kitesurf.stopSceneStream");
  }
}, 120_000);
