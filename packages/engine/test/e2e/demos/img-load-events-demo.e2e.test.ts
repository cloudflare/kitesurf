// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

type ImgProbeWindow = Window & {
  __probe?: { events: string[]; loadDims?: [number, number]; emptyComplete?: boolean };
};

type ImageProbe = {
  events: string[];
  emptyComplete?: boolean;
  loadDims: [number, number] | null;
  frameLoaded: string;
  good: { complete: boolean; naturalWidth: number; naturalHeight: number; currentSrc: string };
  bad: { complete: boolean; naturalWidth: number; naturalHeight: number };
};

function eventOccurred(events: string[], name: string): boolean {
  return events.includes(name);
}

function imageEventsReady(): boolean {
  const probe = (window as ImgProbeWindow).__probe;
  const events = probe?.events;
  const frameLoaded = document.getElementById("frame")?.dataset.imageLoaded === "true";
  return (
    frameLoaded &&
    Array.isArray(events) &&
    ["good-load", "bad-error", "good-decoded"].every((name) => events.includes(name))
  );
}

function assertImageFrameLoaded(probe: ImageProbe, events: string[]): void {
  expect(
    probe.frameLoaded === "true",
    `placeholder frame revealed (data-image-loaded set): ${JSON.stringify({ frameLoaded: probe.frameLoaded, events })}`,
  ).toBeTruthy();
}

function assertLoadedImage(probe: ImageProbe, events: string[]): void {
  expect(
    eventOccurred(events, "good-load"),
    `load event fired on good img: ${JSON.stringify(events)}`,
  ).toBeTruthy();
  expect(
    probe.loadDims && probe.loadDims[0] === 7 && probe.loadDims[1] === 4,
    `naturalWidth/Height readable inside the load handler: ${JSON.stringify(probe.loadDims)}`,
  ).toBeTruthy();
  assertLoadedImageDimensions(probe);
  assertLoadedImageSource(probe);
}

function assertLoadedImageDimensions(probe: ImageProbe): void {
  expect(
    probe.good.complete === true && probe.good.naturalWidth === 7 && probe.good.naturalHeight === 4,
    `good img: complete=true, natural dims 7x4: ${JSON.stringify(probe.good)}`,
  ).toBeTruthy();
}

function assertLoadedImageSource(probe: ImageProbe): void {
  expect(
    typeof probe.good.currentSrc === "string" &&
      probe.good.currentSrc.endsWith("/__fixtures/tiny.png"),
    `good img: currentSrc reflects resolved src: ${JSON.stringify(probe.good.currentSrc)}`,
  ).toBeTruthy();
}

function assertBrokenImage(probe: ImageProbe, events: string[]): void {
  expect(
    eventOccurred(events, "bad-error") && !eventOccurred(events, "bad-load-UNEXPECTED"),
    `error event fired on 404 img (and no load event): ${JSON.stringify(events)}`,
  ).toBeTruthy();
  expect(
    probe.bad.complete === true && probe.bad.naturalWidth === 0 && probe.bad.naturalHeight === 0,
    `bad img: complete=true (terminal broken state), natural dims 0x0: ${JSON.stringify(probe.bad)}`,
  ).toBeTruthy();
}

function assertDecodedImage(events: string[]): void {
  expect(
    eventOccurred(events, "good-decoded"),
    `decode() resolved for the good img: ${JSON.stringify(events)}`,
  ).toBeTruthy();
}

test("img-load-events-demo", async ({ page }) => {
  const session = await page.target().createCDPSession();

  await session.send("Page.navigate", {
    url: "http://127.0.0.1:8787/__fixtures/img-load-events.html",
  });
  await page.waitForFunction(imageEventsReady, { timeout: 15_000 }).catch(() => {});

  const probe = (await page.evaluate(() => ({
    events: (window as ImgProbeWindow).__probe.events,
    emptyComplete: (window as ImgProbeWindow).__probe.emptyComplete,
    loadDims: (window as ImgProbeWindow).__probe.loadDims || null,
    frameLoaded: document.getElementById("frame").dataset.imageLoaded,
    good: (() => {
      const el = document.getElementById("good") as HTMLImageElement;
      return {
        complete: el.complete,
        naturalWidth: el.naturalWidth,
        naturalHeight: el.naturalHeight,
        currentSrc: el.currentSrc,
      };
    })(),
    bad: (() => {
      const el = document.getElementById("bad") as HTMLImageElement;
      return {
        complete: el.complete,
        naturalWidth: el.naturalWidth,
        naturalHeight: el.naturalHeight,
      };
    })(),
  }))) as ImageProbe;

  const ev = probe.events;

  assertImageFrameLoaded(probe, ev);
  assertLoadedImage(probe, ev);
  assertBrokenImage(probe, ev);

  expect(
    probe.emptyComplete === true,
    `src-less img: complete=true per HTML spec: ${JSON.stringify(probe.emptyComplete)}`,
  ).toBeTruthy();
  assertDecodedImage(ev);
});
