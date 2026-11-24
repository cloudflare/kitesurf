// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A FontFace the page loads itself registers with layout: after load() and
// document.fonts.add(), text in that family uses the face instead of the
// fallback.
// https://drafts.csswg.org/css-font-loading/#fontface-interface
import { expect, test } from "./harness";

test("a loaded FontFace applies to text", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/webfont-link.html", { waitUntil: "load" });
  const out = await page.evaluate(async () => {
    const measure = (family: string) => {
      const span = document.createElement("span");
      span.style.cssText = `font: 32px ${family}, sans-serif; display:inline-block`;
      span.textContent = "Hamburgefonstiv WWII";
      document.body.appendChild(span);
      return span;
    };
    const face = new FontFace("KsJsFace", 'url("/__fixtures/bungee.woff2?v=jsface")', {
      weight: "400",
      style: "normal",
    });
    const unloaded = face.status;
    // A face the set knows but that has not loaded is not usable yet.
    document.fonts.add(face);
    const checkBefore = document.fonts.check("32px KsJsFace");
    await face.load();
    const checkAfter = document.fonts.check("32px KsJsFace");
    const cross = measure("KsJsFace");
    const fallback = measure("sans-serif");
    const fallbackWidth = fallback.getBoundingClientRect().width;
    const deadline = Date.now() + 10_000;
    let delta = 0;
    while (delta < 30 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      delta = Math.abs(cross.getBoundingClientRect().width - fallbackWidth);
    }
    return {
      unloaded,
      checkBefore,
      checkAfter,
      status: face.status,
      delta,
      size: document.fonts.size,
      has: document.fonts.has(face),
    };
  });
  expect(out.unloaded).toBe("unloaded");
  expect(out.checkBefore).toBe(false);
  expect(out.checkAfter).toBe(true);
  expect(out.status).toBe("loaded");
  expect(out.delta).toBeGreaterThanOrEqual(30);
  expect(out.size).toBe(1);
  expect(out.has).toBe(true);
}, 60_000);

test("FontFace.load parses format(), tech(), and source lists and rejects local-only sources", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/webfont-link.html", { waitUntil: "load" });
  const requests: string[] = [];
  page.on("request", (req) => requests.push(req.url()));

  const result = await page.evaluate(async () => {
    const withFormat = new FontFace(
      "KsFmtFace",
      'url("/__fixtures/bungee.woff2?v=fmt") format("woff2")',
    );
    document.fonts.add(withFormat);
    await withFormat.load();

    const withList = new FontFace(
      "KsListFace",
      'local("NoSuchLocalFont"), url("/__fixtures/bungee.woff2?v=list") format("woff2") tech(variations)',
    );
    document.fonts.add(withList);
    await withList.load();

    const localOnly = new FontFace("KsLocalOnly", 'local("NoSuchLocalFont")');
    document.fonts.add(localOnly);
    let localErr = "";
    try {
      await localOnly.load();
    } catch (err) {
      localErr = err instanceof Error ? err.message : String(err);
    }

    // Quoted family names strip outer CSS quotes, numeric-weight check() parses
    // past the weight, and concurrent `.loaded` shares one promise.
    const quoted = new FontFace('"KsQuoted"', 'url("/__fixtures/bungee.woff2?v=quoted")');
    document.fonts.add(quoted);
    const checkWeightBefore = document.fonts.check('700 16px "KsQuoted"');
    const p1 = quoted.loaded;
    const p2 = quoted.loaded;
    await Promise.all([p1, p2]);
    const checkWeightAfter = document.fonts.check('700 16px "KsQuoted"');

    const withFallback = new FontFace(
      "KsFallback",
      'url("/__fixtures/no-such-font.woff2") format("woff2"), url("/__fixtures/bungee.woff2?v=fb") /* hint */ format("woff2")',
    );
    document.fonts.add(withFallback);
    await withFallback.load();

    // Multi-weight family: 400 loaded, 700 unloaded -> check("700 ...") stays false.
    const multiReg = new FontFace("KsMulti", 'url("/__fixtures/bungee.woff2?v=m400")', {
      weight: "400",
    });
    const multiBold = new FontFace("KsMulti", 'url("/__fixtures/bungee.woff2?v=m700")', {
      weight: "700",
    });
    document.fonts.add(multiReg);
    document.fonts.add(multiBold);
    await multiReg.load();
    const multiRegCheck = document.fonts.check("400 16px KsMulti");
    const multiBoldCheck = document.fonts.check("700 16px KsMulti");

    // Malformed long src rejects in linear time without quadratic backtracking.
    const t0 = performance.now();
    const malformed = new FontFace("KsBad", "url(" + " ".repeat(4000) + "x");
    try {
      await malformed.load();
    } catch {}
    const malformedMs = performance.now() - t0;

    return {
      fmtStatus: withFormat.status,
      fmtCheck: document.fonts.check("16px KsFmtFace"),
      listStatus: withList.status,
      listCheck: document.fonts.check("16px KsListFace"),
      localStatus: localOnly.status,
      localCheck: document.fonts.check("16px KsLocalOnly"),
      localErr,
      quotedFamily: quoted.family,
      checkWeightBefore,
      checkWeightAfter,
      fallbackStatus: withFallback.status,
      multiRegCheck,
      multiBoldCheck,
      malformedMs,
    };
  });

  expect(result.fmtStatus).toBe("loaded");
  expect(result.fmtCheck).toBe(true);
  expect(result.listStatus).toBe("loaded");
  expect(result.listCheck).toBe(true);
  expect(result.localStatus).toBe("error");
  expect(result.localCheck).toBe(false);
  expect(result.localErr).toContain("unsupported src");
  expect(result.quotedFamily).toBe("KsQuoted");
  expect(result.checkWeightBefore).toBe(false);
  expect(result.checkWeightAfter).toBe(true);
  expect(result.fallbackStatus).toBe("loaded");
  expect(result.multiRegCheck).toBe(true);
  expect(result.multiBoldCheck).toBe(false);
  expect(result.malformedMs).toBeLessThan(200);
  expect(requests.filter((u) => u.includes("?v=quoted")).length).toBe(1);
  expect(requests.some((u) => u.includes("NoSuchLocalFont"))).toBe(false);
}, 60_000);
