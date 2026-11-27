// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// `document.fonts.load()` must start the faces `document.fonts.add()` accepted, so a
// subsequent `check()` sees them as available.
// https://drafts.csswg.org/css-font-loading/#dom-fontfaceset-load
import { expect, it } from "vitest";
import { DocumentImpl } from "../src/document.js";

interface FakeFace {
  family: string;
  status: string;
  weight: string;
  style: string;
  load(): Promise<FakeFace>;
}

function fakeFace(family: string): FakeFace {
  const face: FakeFace = {
    family,
    status: "unloaded",
    weight: "400",
    style: "normal",
    load() {
      face.status = "loaded";
      return Promise.resolve(face);
    },
  };
  return face;
}

it("load() loads matching faces so check() passes", async () => {
  const fonts = new DocumentImpl().fonts;
  const matching = fakeFace("KsSetLoad");
  const other = fakeFace("KsSetOther");
  fonts.add(matching);
  fonts.add(other);
  expect(fonts.check("16px KsSetLoad")).toBe(false);
  await fonts.load("16px KsSetLoad");
  expect(matching.status).toBe("loaded");
  expect(other.status).toBe("unloaded");
  expect(fonts.check("16px KsSetLoad")).toBe(true);
});

it("load() rejects with NetworkError when a matching face fails", async () => {
  const fonts = new DocumentImpl().fonts;
  const failing = fakeFace("KsSetBad");
  failing.load = () => {
    failing.status = "error";
    return Promise.reject(new TypeError("fetch failed"));
  };
  fonts.add(failing);
  await expect(fonts.load("16px KsSetBad")).rejects.toMatchObject({ name: "NetworkError" });
  expect(failing.status).toBe("error");
  expect(fonts.check("16px KsSetBad")).toBe(false);
});
