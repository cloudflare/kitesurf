// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const URL = "http://127.0.0.1:8787/__fixtures/media-texttracks.html";

test("video.textTracks reflects the <track> children", async ({ page }) => {
  await page.goto(URL, { waitUntil: "load", timeout: 30000 });

  const shape = await page.evaluate(() => {
    const v = document.getElementById("v") as HTMLVideoElement;
    const list = v.textTracks;
    const t = list[0];
    return {
      length: list.length,
      kind: t?.kind,
      label: t?.label,
      language: t?.language,
      mode: t?.mode,
      bare: (document.getElementById("bare") as HTMLVideoElement).textTracks.length,
    };
  });
  expect(shape).toStrictEqual({
    length: 1,
    kind: "captions",
    label: "English",
    language: "en",
    mode: "showing",
    bare: 0,
  });

  const written = await page.evaluate(() => {
    const v = document.getElementById("v") as HTMLVideoElement;
    const el = document.getElementById("t") as HTMLTrackElement;
    const track = v.textTracks[0] as TextTrack;
    track.mode = "hidden";
    return { viaTrackEl: el.track.mode, identity: el.track === v.textTracks[0] };
  });
  expect(written).toStrictEqual({ viaTrackEl: "hidden", identity: true });
});
