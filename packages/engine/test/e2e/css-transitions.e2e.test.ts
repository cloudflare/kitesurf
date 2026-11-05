// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import html from "./html/css-transitions.html?raw";

function rgb(value: string): number[] {
  const m = value.match(/rgba?\(([^)]+)\)/);
  if (!m?.[1]) throw new Error(`not an rgb() value: ${value}`);
  return m[1].split(",").map((p) => Number(p.trim()));
}

test.for(["transition", "animation"])(
  "%s keeps its sampled time across synchronous style changes",
  async (kind, { page }) => {
    const sampleCount = 20;
    await setContent(
      page,
      `<!doctype html><style>
      #target { clip-path: inset(0px) }
      @keyframes clip { from { clip-path: inset(0px) } to { clip-path: inset(1000px) } }
    </style><div id="target"></div><div id="other"></div>`,
    );

    const samples = await page.evaluate(
      (kind, sampleCount) => {
        const target = document.getElementById("target");
        const other = document.getElementById("other");
        if (!target || !other) throw new Error("missing animation targets");
        getComputedStyle(target).clipPath;
        if (kind === "transition") {
          target.style.transition = "clip-path 100s -50s linear";
          target.style.clipPath = "inset(1000px)";
        } else {
          target.style.animation = "clip 100s -50s linear";
        }
        const samples = [];
        for (let i = 0; i < sampleCount; i++) {
          other.style.width = `${i}px`;
          other.getBoundingClientRect();
          samples.push(getComputedStyle(target).clipPath);
        }
        return samples;
      },
      kind,
      sampleCount,
    );

    expect(samples).toEqual(Array(sampleCount).fill("inset(500px)"));
  },
);

test("unchanged values under transition all do not start transitions", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><style>
    #target { opacity: 0.5; transition: all 100s linear }
    #target.same { opacity: 0.5 }
    #control { width: 0; transition: width 100s linear }
  </style><div id="target"></div><div id="control"></div>`,
  );

  const result = await page.evaluate(async () => {
    const target = document.getElementById("target");
    const control = document.getElementById("control");
    if (!target || !control) throw new Error("missing transition target");
    const events: string[] = [];
    target.addEventListener("transitionrun", (event) => events.push(event.type));
    const controlRun = new Promise<void>((resolve) => {
      control.addEventListener("transitionrun", () => resolve(), { once: true });
    });
    const before = getComputedStyle(target).opacity;
    getComputedStyle(control).width;
    target.classList.add("same");
    const after = getComputedStyle(target).opacity;
    control.style.width = "10px";
    getComputedStyle(control).width;
    await controlRun;
    return { values: [before, after], events };
  });

  expect(result).toEqual({ values: ["0.5", "0.5"], events: [] });
});

test.for(["normal", "allow-discrete"])(
  "transition-behavior %s controls discrete transitions",
  async (behavior, { page }) => {
    await setContent(
      page,
      `<!doctype html><style>
      #target {
        text-transform: none;
        transition: text-transform 100s linear;
        transition-behavior: ${behavior};
      }
      #control { opacity: 0; transition: opacity 100s linear }
    </style><div id="target"></div><div id="control"></div>`,
    );

    const result = await page.evaluate(async () => {
      const target = document.getElementById("target");
      const control = document.getElementById("control");
      if (!target || !control) throw new Error("missing transition target");
      const events: string[] = [];
      const record = (event: TransitionEvent) => {
        events.push(`${event.type}:${event.propertyName}`);
      };
      target.addEventListener("transitionrun", record);
      target.addEventListener("transitionstart", record);
      target.addEventListener("transitioncancel", record);
      target.addEventListener("transitionend", record);
      const controlRun = new Promise<void>((resolve) => {
        control.addEventListener("transitionrun", () => resolve(), { once: true });
      });
      const before = getComputedStyle(target).textTransform;
      getComputedStyle(control).opacity;
      target.style.textTransform = "uppercase";
      const after = getComputedStyle(target).textTransform;
      control.style.opacity = "1";
      getComputedStyle(control).opacity;
      await controlRun;
      return { values: [before, after], events };
    });

    expect(result).toEqual(
      behavior === "normal"
        ? { values: ["none", "uppercase"], events: [] }
        : {
            values: ["none", "none"],
            events: ["transitionrun:text-transform", "transitionstart:text-transform"],
          },
    );
  },
);

test("switching to normal cancels an active discrete transition without replacement", async ({
  page,
}) => {
  await setContent(
    page,
    `<!doctype html><style>
    #target {
      text-transform: none;
      transition: text-transform 100s linear;
      transition-behavior: allow-discrete;
    }
    #control { opacity: 0; transition: opacity 100s linear }
  </style><div id="target"></div><div id="control"></div>`,
  );

  const result = await page.evaluate(async () => {
    const target = document.getElementById("target");
    const control = document.getElementById("control");
    if (!target || !control) throw new Error("missing transition target");
    const events: string[] = [];
    for (const type of ["transitionrun", "transitionstart", "transitioncancel"]) {
      target.addEventListener(type, (event) => events.push(event.type));
    }
    const canceled = new Promise<void>((resolve) => {
      target.addEventListener("transitioncancel", () => resolve(), { once: true });
    });
    const controlRun = new Promise<void>((resolve) => {
      control.addEventListener("transitionrun", () => resolve(), { once: true });
    });
    getComputedStyle(target).textTransform;
    getComputedStyle(control).opacity;
    target.style.textTransform = "uppercase";
    const transitioning = getComputedStyle(target).textTransform;
    target.style.transitionBehavior = "normal";
    target.style.textTransform = "lowercase";
    const retargeted = getComputedStyle(target).textTransform;
    control.style.opacity = "1";
    getComputedStyle(control).opacity;
    await canceled;
    await controlRun;
    return { transitioning, retargeted, events };
  });

  expect(result).toEqual({
    transitioning: "none",
    retargeted: "lowercase",
    events: ["transitionrun", "transitionstart", "transitioncancel"],
  });
});

test("retargeting to the sampled current value cancels without replacement", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><style>
    #target { opacity: 0; transition: opacity 100s -50s linear }
  </style><div id="target"></div>`,
  );

  const result = await page.evaluate(async () => {
    const target = document.getElementById("target");
    if (!target) throw new Error("missing transition target");
    const events: string[] = [];
    for (const type of ["transitionrun", "transitionstart", "transitioncancel"]) {
      target.addEventListener(type, (event) => events.push(event.type));
    }
    const canceled = new Promise<void>((resolve) => {
      target.addEventListener("transitioncancel", () => resolve(), { once: true });
    });
    getComputedStyle(target).opacity;
    target.style.opacity = "1";
    const sampled = getComputedStyle(target).opacity;
    target.style.opacity = sampled;
    const retargeted = getComputedStyle(target).opacity;
    await canceled;
    return { sampled, retargeted, events };
  });

  expect(result).toEqual({
    sampled: "0.5",
    retargeted: "0.5",
    events: ["transitionrun", "transitionstart", "transitioncancel"],
  });
});

test("a transition interpolates instead of jumping to its target", async ({ page }) => {
  await setContent(page, html);

  const samples = (await page.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = [];
    globalThis.__ksGo();
    out.push(globalThis.__ksBg());
    for (let i = 0; i < 3; i++) { await wait(250); out.push(globalThis.__ksBg()); }
    return JSON.stringify(out);
  })()`)) as string;

  const values = JSON.parse(String(samples)) as string[];
  const channels = values.map(rgb);

  expect(channels[0], `first sample: ${values[0]}`).toEqual([255, 0, 0]);

  for (let i = 1; i < channels.length; i++) {
    const [r = -1, g = -1, b = -1] = channels[i] ?? [];
    const [prevR = -1] = channels[i - 1] ?? [];
    expect(g, `green stays 0 across red -> blue: ${values[i]}`).toBe(0);
    expect(
      r > 0 && r < 255 && b > 0 && b < 255,
      `sample ${i} must be mid-flight, got ${values[i]}`,
    ).toBe(true);
    expect(r < prevR, `the ramp must advance: ${values[i - 1]} -> ${values[i]}`).toBe(true);
  }
}, 120_000);

test("transition events fire on the clock, not all at once", async ({ page }) => {
  await setContent(page, html);

  const out = (await page.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    globalThis.__ksGo();
    await wait(400);
    const early = globalThis.__ksLog.slice();
    await wait(2200);
    return JSON.stringify({ early, late: globalThis.__ksLog.slice() });
  })()`)) as string;

  const { early, late } = JSON.parse(String(out)) as {
    early: string[];
    late: string[];
  };

  expect(early).toContain("transitionrun:background-color:0");
  expect(early).toContain("transitionstart:background-color:0");
  expect(
    early.filter((e) => e.startsWith("transitionend")),
    "a 2s transition must not report finishing 400ms in",
  ).toEqual([]);

  expect(late).toContain("transitionend:background-color:2");
  expect(late).toContain("transitionend:opacity:2");

  const bg = late.filter(
    (e) => e.endsWith(":background-color:0") || e.startsWith("transitionend:background-color"),
  );
  expect(bg).toEqual([
    "transitionrun:background-color:0",
    "transitionstart:background-color:0",
    "transitionend:background-color:2",
  ]);
}, 120_000);

test("a once transition handler can start the next transition after mutating", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><style>
    #box { width: 100px; transition: width 50ms linear }
    #box.go { width: 200px }
  </style><div id="box"></div>`,
  );

  const log = JSON.parse(
    String(
      await page.evaluate(`(async () => {
    const box = document.getElementById("box");
    const log = [];
    let step = 0;
    const next = () => {
      log.push(++step);
      box.classList.toggle("go");
      if (step < 4) box.addEventListener("transitionend", next, { once: true });
    };
    box.addEventListener("transitionend", next, { once: true });
    box.classList.add("go");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return JSON.stringify(log);
  })()`),
    ),
  ) as number[];

  expect(log).toEqual([1, 2, 3, 4]);
}, 120_000);

test("a retargeted transition cancels the run it replaced", async ({ page }) => {
  await setContent(page, html);

  const out = (await page.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    globalThis.__ksGo();
    await wait(400);
    globalThis.__ksLog.length = 0;
    globalThis.__ksRetarget();
    await wait(400);
    return JSON.stringify(globalThis.__ksLog.slice());
  })()`)) as string;

  const log = (JSON.parse(String(out)) as string[]).filter((e) => e.includes(":background-color:"));
  expect(log[0]).toMatch(/^transitioncancel:background-color:/);
  expect(log.slice(1, 3)).toEqual([
    "transitionrun:background-color:0",
    "transitionstart:background-color:0",
  ]);
  const cancelled = Number(log[0]?.split(":")[2]);
  expect(cancelled > 0 && cancelled < 2).toBe(true);
}, 120_000);

test("transition-property: all covers whatever actually changed", async ({ page }) => {
  await setContent(page, html);

  const out = (await page.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    globalThis.__ksAllGo();
    await wait(600);
    const mid = globalThis.__ksAllHeight();
    await wait(2000);
    return JSON.stringify({ mid, end: globalThis.__ksAllHeight(), log: globalThis.__ksAllLog.slice() });
  })()`)) as string;

  const { mid, end, log } = JSON.parse(String(out)) as {
    mid: string;
    end: string;
    log: string[];
  };
  const midPx = parseFloat(mid);
  expect(
    midPx > 50 && midPx < 150,
    `height must be mid-ramp 600ms into a 2s transition, got ${mid}`,
  ).toBe(true);
  expect(parseFloat(end)).toBe(150);
  expect(log).toContain("transitionrun:height:0");
  expect(log).toContain("transitionend:height:2");
}, 120_000);

test("a property with no transition still applies immediately", async ({ page }) => {
  await setContent(page, html);

  const value = await page.evaluate(`(() => {
    globalThis.__ksPlainGo();
    return getComputedStyle(document.getElementById("plain")).backgroundColor;
  })()`);
  expect(String(value)).toBe("rgb(4, 5, 6)");
}, 120_000);

test("a transition still fires while the page mutates nonstop", async ({ page }) => {
  await setContent(page, html);

  const out = (await page.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    globalThis.__ksStormStart();
    await wait(100);
    globalThis.__ksGo();
    await wait(400);
    const early = globalThis.__ksLog.slice();
    await wait(2200);
    const late = globalThis.__ksLog.slice();
    globalThis.__ksStormStop();
    return JSON.stringify({ early, late, ticks: globalThis.__ksStormN | 0 });
  })()`)) as string;

  const { early, late, ticks } = JSON.parse(String(out)) as {
    early: string[];
    late: string[];
    ticks: number;
  };

  expect(ticks, "the mutation storm never fired").toBeGreaterThan(20);
  expect(early).toContain("transitionrun:background-color:0");
  expect(late).toContain("transitionend:background-color:2");
}, 120_000);

test("the first transition listener at module top level does not throw", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setContent(
    page,
    `<!doctype html><style>
    #box { width: 100px; transition: width 50ms linear }
    #box.go { width: 200px }
  </style><div id="box"></div>
  <script type="module">
    globalThis.__ksLog = [];
    const box = document.getElementById("box");
    try {
      box.addEventListener("transitionend", (e) => {
        globalThis.__ksLog.push("transitionend:" + e.propertyName);
      });
      box.addEventListener("animationend", () => {});
      // A mutation while the drain is still waiting for handler scope
      // goes through the post-mutation hook, which re-arms.
      box.classList.add("go");
      globalThis.__ksModuleThrew = null;
    } catch (e) {
      globalThis.__ksModuleThrew = e.message;
    }
  </script>`,
  );

  const out = JSON.parse(
    String(
      await page.evaluate(`(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    document.getElementById("box").classList.remove("go");
    await new Promise((resolve) => setTimeout(resolve, 600));
    return JSON.stringify({
      threw: globalThis.__ksModuleThrew,
      log: globalThis.__ksLog,
    });
  })()`),
    ),
  ) as { threw: string | null | undefined; log: string[] };

  expect(errors).toEqual([]);
  expect(out.threw, "addEventListener threw at module top level").toBeNull();
  expect(out.log).toEqual(["transitionend:width"]);
}, 120_000);

test("animationcancel reaches listener and IDL handlers", async ({ page }) => {
  await setContent(
    page,
    `<!DOCTYPE html><style>
    @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
    #box.go { animation: 10s linear fade }
  </style><div id="box"></div>`,
  );

  const events = JSON.parse(
    String(
      await page.evaluate(`(async () => {
    const box = document.getElementById("box");
    const events = [];
    box.addEventListener("animationcancel", () => events.push("listener"));
    box.onanimationcancel = () => events.push("idl");
    box.classList.add("go");
    await new Promise((resolve) => setTimeout(resolve, 100));
    box.classList.remove("go");
    await new Promise((resolve) => setTimeout(resolve, 100));
    return JSON.stringify(events);
  })()`),
    ),
  ) as string[];

  expect(events).toEqual(["listener", "idl"]);
}, 120_000);

test("CSS events use captured constructors and the animation clock", async ({ page }) => {
  await setContent(
    page,
    `<!DOCTYPE html><style>
    @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
    #box { opacity: 0; width: 10px; transition: width 100ms linear }
    #box.go { animation: 100ms linear 0s 1 normal both fade; width: 20px }
  </style><div id="box"></div>`,
  );

  const out = (await page.evaluate(`(async () => {
    const box = document.getElementById("box");
    const NativeAnimationEvent = AnimationEvent;
    const NativeTransitionEvent = TransitionEvent;
    globalThis.__ksAnimationLog = [];
    globalThis.__ksTransitionEventIsNative = false;
    for (const type of ["animationstart", "animationend"]) {
      box.addEventListener(type, (event) => {
        globalThis.__ksAnimationLog.push({
          type: event.type,
          name: event.animationName,
          elapsed: event.elapsedTime,
          instance: event instanceof NativeAnimationEvent,
          // UA-generated events must stay trusted through the
          // dom-shim's closure-owned dispatch path.
          trusted: event.isTrusted,
        });
      });
    }
    box.addEventListener("transitionend", (event) => {
      globalThis.__ksTransitionEventIsNative = event instanceof NativeTransitionEvent;
    });
    globalThis.AnimationEvent = class {};
    globalThis.TransitionEvent = class {};
    // Resolve style first. Without a before-change style the width change
    // starts no transition, and nothing guarantees a resolve has run since
    // setContent: under CI load the animation events fired but transitionend
    // never did.
    getComputedStyle(box).width;
    box.classList.add("go");
    await new Promise((resolve) => setTimeout(resolve, 250));
    return JSON.stringify({
      animations: globalThis.__ksAnimationLog,
      transitionIsNative: globalThis.__ksTransitionEventIsNative,
    });
  })()`)) as string;
  const { animations: events, transitionIsNative } = JSON.parse(out) as {
    animations: Array<{
      type: string;
      name: string;
      elapsed: number;
      instance: boolean;
      trusted: boolean;
    }>;
    transitionIsNative: boolean;
  };
  expect(events.map((event) => event.type)).toEqual(["animationstart", "animationend"]);
  expect(events.every((event) => event.name === "fade" && event.instance)).toBe(true);
  expect(events.every((event) => event.trusted)).toBe(true);
  expect(events[1]?.elapsed).toBeCloseTo(0.1, 5);
  expect(transitionIsNative).toBe(true);
}, 120_000);
