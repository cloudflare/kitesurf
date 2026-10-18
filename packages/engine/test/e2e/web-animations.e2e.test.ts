// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Element.animate against Chrome 155 (values taken with the chrome-devtools MCP). Pages read
// these computed values back and expect Blink's exact output, so close is not enough.

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PROBES = `<script>
  const mk = () => { const d = document.createElement("div"); document.body.appendChild(d); return d; };
  const probe = (kf, opts, t) => {
    const el = mk(); const a = el.animate(kf, opts); a.pause(); a.currentTime = t;
    const cs = getComputedStyle(el);
    return { color: cs.color, opacity: cs.opacity, width: cs.width, ps: a.playState, ct: a.currentTime,
      prog: a.effect.getComputedTiming().progress };
  };
  window.__probes = {
    xlike: probe({ color: ["#4a8e2c", "#c3d1f0"], transform: ["rotate(0deg)", "rotate(217deg)"],
      easing: "cubic-bezier(0.25,0.1,0.6,0.9)" }, 4096, 2050),
    opacityMid: probe([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, easing: "ease-in" }, 300),
    widthKeyframes: probe([{ width: "10px" }, { width: "50px", offset: 0.25 }, { width: "110px" }], 1000, 500),
    beforeNoFill: probe({ opacity: [0.2, 0.8] }, { duration: 1000, delay: 500 }, 100),
    beforeBackwards: probe({ opacity: [0.2, 0.8] }, { duration: 1000, delay: 500, fill: "backwards" }, 100),
    alternate: probe({ opacity: [0, 1] }, { duration: 1000, iterations: 3, direction: "alternate" }, 1250),
    afterForwards: probe({ opacity: [0, 1] }, { duration: 1000, fill: "forwards" }, 5000),
  };
</script>`;

test("paused animations compute the values Chrome computes", async ({ page }) => {
  await setContent(page, PROBES);
  const got = await page.evaluate(() => Reflect.get(globalThis, "__probes"));
  expect(got).toEqual({
    xlike: {
      color: "rgb(144, 180, 157)",
      opacity: "1",
      width: expect.any(String),
      ps: "paused",
      ct: 2050,
      prog: 0.50048828125,
    },
    opacityMid: {
      color: "rgb(0, 0, 0)",
      opacity: "0.129577",
      width: expect.any(String),
      ps: "paused",
      ct: 300,
      prog: expect.closeTo(0.12957676074547098, 6),
    },
    widthKeyframes: {
      color: "rgb(0, 0, 0)",
      opacity: "1",
      width: "70px",
      ps: "paused",
      ct: 500,
      prog: 0.5,
    },
    beforeNoFill: {
      color: "rgb(0, 0, 0)",
      opacity: "1",
      width: expect.any(String),
      ps: "paused",
      ct: 100,
      prog: null,
    },
    beforeBackwards: {
      color: "rgb(0, 0, 0)",
      opacity: "0.2",
      width: expect.any(String),
      ps: "paused",
      ct: 100,
      prog: 0,
    },
    alternate: {
      color: "rgb(0, 0, 0)",
      opacity: "0.75",
      width: expect.any(String),
      ps: "paused",
      ct: 1250,
      prog: 0.75,
    },
    afterForwards: {
      color: "rgb(0, 0, 0)",
      opacity: "1",
      width: expect.any(String),
      ps: "paused",
      ct: 5000,
      prog: 1,
    },
  });
});

test("a boa-run caller sees the same values", async ({ page }) => {
  await setContent(page, "<div id=t>x</div>");
  const got = await page.evaluate(() => {
    const el = document.getElementById("t");
    if (!el) throw new Error("missing #t");
    const a = el.animate(
      {
        color: ["#4a8e2c", "#c3d1f0"],
        transform: ["rotate(0deg)", "rotate(217deg)"],
        easing: "cubic-bezier(0.25,0.1,0.6,0.9)",
      },
      4096,
    );
    a.pause();
    a.currentTime = 2050;
    const color = getComputedStyle(el).color;
    a.cancel();
    return { color, after: getComputedStyle(el).color, listed: el.getAnimations().length };
  });
  expect(got).toEqual({ color: "rgb(144, 180, 157)", after: "rgb(0, 0, 0)", listed: 0 });
});

test("a running animation advances, finishes, and lets go of its effect", async ({ page }) => {
  await setContent(page, "<div id=t>x</div>");
  const got = await page.evaluate(async () => {
    const el = document.getElementById("t");
    if (!el) throw new Error("missing #t");
    const events: string[] = [];
    const a = el.animate([{ opacity: 0 }, { opacity: 1 }], 300);
    a.onfinish = (e) => events.push("finish:" + e.currentTime);
    const listed = document.getAnimations().length;
    const states = [a.playState];
    await new Promise((r) => setTimeout(r, 100));
    const mid = Number(getComputedStyle(el).opacity);
    const resolved = await a.finished;
    await new Promise((r) => setTimeout(r, 0));
    states.push(a.playState);
    return {
      listed,
      states,
      midInRange: mid > 0 && mid < 1,
      resolvedIsSelf: resolved === a,
      events,
      end: getComputedStyle(el).opacity,
      currentTime: a.currentTime,
      stillListed: el.getAnimations().length,
    };
  });
  expect(got).toEqual({
    listed: 1,
    states: ["running", "finished"],
    midInRange: true,
    resolvedIsSelf: true,
    events: ["finish:300"],
    end: "1",
    currentTime: 300,
    stillListed: 0,
  });
});

test("bad timing and keyframes throw what Chrome throws", async ({ page }) => {
  await setContent(page, "<div id=t>x</div>");
  const got = await page.evaluate(() => {
    const el = document.getElementById("t");
    if (!el) throw new Error("missing #t");
    // The shim throws V8 errors, which reach this boa code as bridged objects and fail
    // its instanceof Error, so read the name off the object instead.
    const name = (f: () => unknown) => {
      try {
        f();
        return "ok";
      } catch (e) {
        return typeof e === "object" && e !== null ? String(Reflect.get(e, "name")) : String(e);
      }
    };
    return {
      easing: name(() => el.animate({ opacity: [0, 1] }, { duration: 100, easing: "bogus" })),
      duration: name(() => el.animate({ opacity: [0, 1] }, { duration: -1 })),
      offsets: name(() =>
        el.animate(
          [
            { opacity: 0, offset: 0.8 },
            { opacity: 1, offset: 0.2 },
          ],
          100,
        ),
      ),
      fill: name(() =>
        Reflect.apply(el.animate, el, [{ opacity: [0, 1] }, { duration: 100, fill: "sideways" }]),
      ),
      ok: name(() => el.animate({ opacity: [0, 1] }, { duration: 100, easing: "steps(4, end)" })),
    };
  });
  expect(got).toEqual({
    easing: "TypeError",
    duration: "TypeError",
    offsets: "TypeError",
    fill: "TypeError",
    ok: "ok",
  });
});

const EFFECT_TARGET_CHANGES = [
  {
    name: "Animation.effect = null clears the old target",
    mutation: "clear-effect",
    nextOpacity: "1",
  },
  {
    name: "KeyframeEffect.target = null clears the old target",
    mutation: "clear-target",
    nextOpacity: "1",
  },
  {
    name: "Retargeting KeyframeEffect.target moves the effect to the new target",
    mutation: "retarget",
    nextOpacity: "0.5",
  },
  {
    name: "Replacing Animation.effect moves the effect to the new target",
    mutation: "replace",
    nextOpacity: "0.5",
  },
] as const;

for (const { name, mutation, nextOpacity } of EFFECT_TARGET_CHANGES) {
  test(name, async ({ page }) => {
    await setContent(page, "<div id=old></div><div id=new></div>");
    const got = await page.evaluate((mutation) => {
      const oldTarget = document.getElementById("old");
      const newTarget = document.getElementById("new");
      if (!oldTarget || !newTarget) throw new Error("missing animation target");

      const keyframes = [{ opacity: 0.2 }, { opacity: 0.8 }];
      const animation = oldTarget.animate(keyframes, { duration: 1000 });
      animation.pause();
      animation.currentTime = 500;
      const before = getComputedStyle(oldTarget).opacity;

      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect)) throw new Error("missing KeyframeEffect");
      switch (mutation) {
        case "clear-effect":
          animation.effect = null;
          break;
        case "clear-target":
          effect.target = null;
          break;
        case "retarget":
          effect.target = newTarget;
          break;
        case "replace":
          animation.effect = new KeyframeEffect(newTarget, keyframes, { duration: 1000 });
          break;
      }

      return {
        before,
        old: getComputedStyle(oldTarget).opacity,
        next: getComputedStyle(newTarget).opacity,
      };
    }, mutation);
    expect(got).toEqual({ before: "0.5", old: "1", next: nextOpacity });
  });
}
