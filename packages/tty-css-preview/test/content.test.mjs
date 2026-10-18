// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  createContentScriptFixture,
  FixtureElement,
  FixtureShadowRoot,
} from "./content-script-fixture.mjs";

const CELL_WIDTH = 8;
const CELL_HEIGHT = 17;
const WHEEL_BATCH_MS = 33;
const TARGET_SWITCH_AT_MS = 10;
const ACTIVE_REPLY = {
  status: "updated",
  appliedCss: "preview css",
  appliedLevel: 1,
  showGrid: false,
};
const CURRENT_REPLY = {
  status: "current",
  appliedCss: "preview css",
  appliedLevel: 1,
  showGrid: false,
};
const OFF_REPLY = { status: "off", appliedCss: null, appliedLevel: 0, showGrid: false };

async function activate(fixture) {
  await fixture.load();
  assert.equal(fixture.polls.length, 1);
  await fixture.reply(0, ACTIVE_REPLY);
}

function verticalScroller(maximum, { position = 0, overflow = "auto", overscroll = "auto" } = {}) {
  return new FixtureElement("div", {
    computed: { overflowY: overflow, overscrollBehaviorY: overscroll },
    metrics: { scrollTop: position, scrollHeight: maximum },
  });
}

function horizontalScroller(maximum, { position = 0, direction = "ltr" } = {}) {
  return new FixtureElement("div", {
    computed: { overflowX: "auto", direction },
    metrics: { scrollLeft: position, scrollWidth: maximum },
  });
}

function setVerticalRange(element, maximum, position = 0) {
  element.scrollHeight = maximum;
  element.scrollTop = position;
}

function wheel(fixture, target, { deltaX = 0, deltaY = 0, path = [target] } = {}) {
  const event = {
    deltaX,
    deltaY,
    deltaMode: 0,
    shiftKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    composedPath: () => path,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  fixture.dispatch("wheel", event);
  return event;
}

function addSnapTargets(fixture, parent = fixture.document.body) {
  const media = new FixtureElement("img", { rect: { width: 172, height: 18 } });
  media.style.setProperty("width", "123px", "important");
  const inset = new FixtureElement("div", {
    computed: {
      "margin-top": "4px",
      "padding-left": "3px",
      "border-left-width": "1px",
    },
  });
  inset.style.setProperty("margin-top", "9px");
  parent.appendChild(media);
  parent.appendChild(inset);
  return { media, inset };
}

function assertInlineDeclaration(element, name, expectedValue, expectedPriority = "") {
  assert.equal(element.style.getPropertyValue(name), expectedValue);
  assert.equal(element.style.getPropertyPriority(name), expectedPriority);
}

function assertPreviewStyles({ media, inset }) {
  assertInlineDeclaration(media, "width", "176px", "important");
  assertInlineDeclaration(media, "height", "17px", "important");
  assertInlineDeclaration(inset, "margin-top", "0px", "important");
  assertInlineDeclaration(inset, "padding-left", "7px", "important");
}

function assertInitialStyles({ media, inset }) {
  assertInlineDeclaration(media, "width", "123px", "important");
  assertInlineDeclaration(media, "height", "");
  assertInlineDeclaration(inset, "margin-top", "9px");
  assertInlineDeclaration(inset, "padding-left", "");
}

test("target switching cancels the earlier wheel deadline", async (testContext) => {
  const fixture = createContentScriptFixture(testContext);
  const targetA = verticalScroller(68);
  const targetB = verticalScroller(68);
  fixture.document.body.appendChild(targetA);
  fixture.document.body.appendChild(targetB);
  await activate(fixture);

  assert.equal(wheel(fixture, targetA, { deltaY: CELL_HEIGHT }).defaultPrevented, true);
  fixture.clock.advanceBy(TARGET_SWITCH_AT_MS);
  assert.equal(wheel(fixture, targetB, { deltaY: CELL_HEIGHT }).defaultPrevented, true);
  assert.equal(targetA.scrollTop, CELL_HEIGHT);
  assert.equal(targetB.scrollTop, 0);

  fixture.clock.advanceTo(WHEEL_BATCH_MS);
  assert.equal(targetB.scrollTop, 0);
  fixture.clock.advanceTo(TARGET_SWITCH_AT_MS + WHEEL_BATCH_MS - 1);
  assert.equal(targetB.scrollTop, 0);
  fixture.clock.advanceTo(TARGET_SWITCH_AT_MS + WHEEL_BATCH_MS);
  assert.equal(targetB.scrollTop, CELL_HEIGHT);
});

test("wheel prefers a nested scroller over the document scrolling element", async (testContext) => {
  const fixture = createContentScriptFixture(testContext);
  const nested = verticalScroller(CELL_HEIGHT * 2);
  const target = new FixtureElement("span");
  nested.appendChild(target);
  fixture.document.body.appendChild(nested);
  setVerticalRange(fixture.document.scrollingElement, CELL_HEIGHT * 4);
  await activate(fixture);

  assert.equal(wheel(fixture, target, { deltaY: CELL_HEIGHT }).defaultPrevented, true);
  fixture.clock.advanceBy(WHEEL_BATCH_MS);

  assert.equal(nested.scrollTop, CELL_HEIGHT);
  assert.equal(fixture.document.scrollingElement.scrollTop, 0);
});

test("sub-cell space at a nested edge propagates a whole cell to its ancestor", async (testContext) => {
  const fixture = createContentScriptFixture(testContext);
  const nested = verticalScroller(20, { position: 10 });
  const target = new FixtureElement("span");
  nested.appendChild(target);
  fixture.document.body.appendChild(nested);
  setVerticalRange(fixture.document.scrollingElement, CELL_HEIGHT * 2);
  await activate(fixture);

  assert.equal(wheel(fixture, target, { deltaY: CELL_HEIGHT }).defaultPrevented, true);
  fixture.clock.advanceBy(WHEEL_BATCH_MS);

  assert.equal(nested.scrollTop, 10);
  assert.equal(fixture.document.scrollingElement.scrollTop, CELL_HEIGHT);
});

test("RTL wheel movement follows signed ranges for nested and root scrollers", async (testContext) => {
  const fixture = createContentScriptFixture(testContext);
  const nested = horizontalScroller(CELL_WIDTH * 4, { direction: "rtl" });
  fixture.document.body.appendChild(nested);
  await activate(fixture);

  wheel(fixture, nested, { deltaX: -CELL_WIDTH });
  fixture.clock.advanceBy(WHEEL_BATCH_MS);
  assert.equal(nested.scrollLeft, -CELL_WIDTH);

  wheel(fixture, nested, { deltaX: CELL_WIDTH });
  fixture.clock.advanceBy(WHEEL_BATCH_MS);
  assert.equal(nested.scrollLeft, 0);

  const root = fixture.document.scrollingElement;
  const target = new FixtureElement("span");
  root.scrollWidth = CELL_WIDTH * 4;
  root.computed.direction = "rtl";
  fixture.document.body.appendChild(target);

  wheel(fixture, target, { deltaX: -CELL_WIDTH });
  fixture.clock.advanceBy(WHEEL_BATCH_MS);
  assert.equal(root.scrollLeft, -CELL_WIDTH);

  wheel(fixture, target, { deltaX: CELL_WIDTH });
  fixture.clock.advanceBy(WHEEL_BATCH_MS);
  assert.equal(root.scrollLeft, 0);
});

test("overscroll containment keeps a wheel step from reaching the root", async (testContext) => {
  const fixture = createContentScriptFixture(testContext);
  const nested = verticalScroller(CELL_HEIGHT, {
    position: CELL_HEIGHT,
    overscroll: "contain",
  });
  const target = new FixtureElement("span");
  nested.appendChild(target);
  fixture.document.body.appendChild(nested);
  setVerticalRange(fixture.document.scrollingElement, CELL_HEIGHT * 2);
  await activate(fixture);

  assert.equal(wheel(fixture, target, { deltaY: CELL_HEIGHT }).defaultPrevented, true);
  fixture.clock.advanceBy(WHEEL_BATCH_MS);

  assert.equal(nested.scrollTop, CELL_HEIGHT);
  assert.equal(fixture.document.scrollingElement.scrollTop, 0);
});

test("horizontal and vertical wheel deltas can select different scrollers", async (testContext) => {
  const fixture = createContentScriptFixture(testContext);
  const horizontal = horizontalScroller(CELL_WIDTH * 2);
  fixture.document.body.appendChild(horizontal);
  setVerticalRange(fixture.document.scrollingElement, CELL_HEIGHT * 2);
  await activate(fixture);

  wheel(fixture, horizontal, { deltaX: CELL_WIDTH, deltaY: CELL_HEIGHT });
  fixture.clock.advanceBy(WHEEL_BATCH_MS);

  assert.equal(horizontal.scrollLeft, CELL_WIDTH);
  assert.equal(fixture.document.scrollingElement.scrollTop, CELL_HEIGHT);
});

for (const [name, where, overflow, expectedRootTop] of [
  ["wheel falls through to the document scrolling element", "root", "visible", CELL_HEIGHT],
  ["wheel respects root hidden overflow", "root", "hidden", 0],
  ["wheel respects root clip overflow", "root", "clip", 0],
  ["wheel respects body hidden overflow", "body", "hidden", 0],
  ["wheel respects body clip overflow", "body", "clip", 0],
]) {
  test(name, async (testContext) => {
    const fixture = createContentScriptFixture(testContext);
    const root = fixture.document.documentElement;
    const body = fixture.document.body;
    const target = new FixtureElement("span");
    body.appendChild(target);
    setVerticalRange(root, CELL_HEIGHT * 2);
    (where === "root" ? root : body).computed.overflowY = overflow;
    await activate(fixture);

    assert.equal(wheel(fixture, target, { deltaY: CELL_HEIGHT }).defaultPrevented, true);
    fixture.clock.advanceBy(WHEEL_BATCH_MS);

    assert.equal(root.scrollTop, expectedRootTop);
  });
}

test("wheel traversal crosses a shadow root to its host scroller", async (testContext) => {
  const fixture = createContentScriptFixture(testContext);
  const host = verticalScroller(CELL_HEIGHT * 2);
  fixture.document.body.appendChild(host);
  const shadowRoot = new FixtureShadowRoot(host);
  const target = shadowRoot.appendChild(new FixtureElement("span"));
  setVerticalRange(fixture.document.scrollingElement, CELL_HEIGHT * 2);
  await activate(fixture);

  wheel(fixture, target, { deltaY: CELL_HEIGHT, path: [target, host] });
  fixture.clock.advanceBy(WHEEL_BATCH_MS);

  assert.equal(host.scrollTop, CELL_HEIGHT);
  assert.equal(fixture.document.scrollingElement.scrollTop, 0);
});

test("resize refreshes connected media dimensions through the installed handler", async (testContext) => {
  const fixture = createContentScriptFixture(testContext);
  const targets = addSnapTargets(fixture);
  await activate(fixture);
  assertPreviewStyles(targets);

  targets.media.rect.width = 181;
  fixture.dispatch("resize", {});

  assertInlineDeclaration(targets.media, "width", "184px", "important");
  assertInlineDeclaration(targets.media, "height", "17px", "important");

  fixture.clock.advanceTo(500);
  await fixture.reply(1, OFF_REPLY);
  assertInitialStyles(targets);
});

test("subtree removal restores declarations for disconnected snapped elements", async (testContext) => {
  const fixture = createContentScriptFixture(testContext);
  const subtree = new FixtureElement("section");
  fixture.document.body.appendChild(subtree);
  const targets = addSnapTargets(fixture, subtree);
  await activate(fixture);
  assertPreviewStyles(targets);

  fixture.document.body.removeChild(subtree);
  assert.equal(targets.media.isConnected, false);
  assert.equal(targets.inset.isConnected, false);
  fixture.observer.deliver([
    {
      type: "childList",
      target: fixture.document.body,
      removedNodes: [subtree],
      addedNodes: [],
    },
  ]);

  assertInitialStyles(targets);
});

test("same-batch moves keep snapped overrides and restore their originals on Off", async (testContext) => {
  const fixture = createContentScriptFixture(testContext);
  const targets = addSnapTargets(fixture);
  await activate(fixture);
  assertPreviewStyles(targets);

  fixture.document.body.removeChild(targets.media);
  fixture.document.body.removeChild(targets.inset);
  fixture.document.body.appendChild(targets.media);
  fixture.document.body.appendChild(targets.inset);
  assert.equal(targets.media.isConnected, true);
  assert.equal(targets.inset.isConnected, true);
  fixture.observer.deliver([
    {
      type: "childList",
      target: fixture.document.body,
      removedNodes: [targets.media, targets.inset],
      addedNodes: [],
    },
    {
      type: "childList",
      target: fixture.document.body,
      removedNodes: [],
      addedNodes: [targets.media, targets.inset],
    },
  ]);
  assertPreviewStyles(targets);

  fixture.clock.advanceTo(500);
  await fixture.reply(1, OFF_REPLY);
  assertInitialStyles(targets);
});

test("later reinsertions resnap and restore declarations captured while detached", async (testContext) => {
  const fixture = createContentScriptFixture(testContext);
  const targets = addSnapTargets(fixture);
  await activate(fixture);
  assertPreviewStyles(targets);

  fixture.document.body.removeChild(targets.media);
  fixture.document.body.removeChild(targets.inset);
  fixture.observer.deliver([
    {
      type: "childList",
      target: fixture.document.body,
      removedNodes: [targets.media, targets.inset],
      addedNodes: [],
    },
  ]);
  assertInitialStyles(targets);

  targets.media.style.setProperty("width", "109px");
  targets.media.style.setProperty("height", "84px", "important");
  targets.inset.style.setProperty("margin-top", "2.5px", "important");
  targets.inset.style.setProperty("padding-left", "6px");
  targets.media.rect.width = 109;
  targets.media.rect.height = 84;
  fixture.document.body.appendChild(targets.media);
  fixture.document.body.appendChild(targets.inset);
  assert.equal(targets.media.isConnected, true);
  assert.equal(targets.inset.isConnected, true);
  fixture.observer.deliver([
    {
      type: "childList",
      target: fixture.document.body,
      removedNodes: [],
      addedNodes: [targets.media, targets.inset],
    },
  ]);

  assertInlineDeclaration(targets.media, "width", "109px");
  assertInlineDeclaration(targets.media, "height", "84px", "important");
  assertInlineDeclaration(targets.inset, "margin-top", "0px", "important");
  assertInlineDeclaration(targets.inset, "padding-left", "7px", "important");

  fixture.clock.advanceTo(500);
  assert.deepEqual(fixture.polls[1].message, {
    type: "poll",
    appliedCss: "preview css",
    appliedLevel: 1,
  });
  await fixture.reply(1, CURRENT_REPLY);
  assertInlineDeclaration(targets.media, "width", "112px", "important");
  assertInlineDeclaration(targets.media, "height", "85px", "important");

  fixture.clock.advanceTo(1000);
  await fixture.reply(2, OFF_REPLY);
  assertInlineDeclaration(targets.media, "width", "109px");
  assertInlineDeclaration(targets.media, "height", "84px", "important");
  assertInlineDeclaration(targets.inset, "margin-top", "2.5px", "important");
  assertInlineDeclaration(targets.inset, "padding-left", "6px");
});
