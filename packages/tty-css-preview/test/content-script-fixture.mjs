// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

const EXTENSION_DIRECTORY = new URL("../extension/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", EXTENSION_DIRECTORY), "utf8"));
const scripts = await Promise.all(
  manifest.content_scripts[0].js.map(async (filename) => ({
    filename,
    source: await readFile(new URL(filename, EXTENSION_DIRECTORY), "utf8"),
  })),
);

/**
 * @typedef {{
 *   document: FixtureDocument,
 *   clock: FakeClock,
 *   polls: Array<{ message: unknown, resolve: (result: unknown) => void }>,
 *   observer: { deliver(records: unknown[]): void } | undefined,
 *   load: () => Promise<void>,
 *   dispatch: (type: string, event: unknown) => void,
 *   reply: (index: number, result: unknown) => Promise<void>
 * }} ContentScriptFixture
 */

class InlineStyle {
  #properties = new Map();

  /** @returns {string} */
  getPropertyValue(name) {
    return this.#properties.get(name)?.value ?? "";
  }

  /** @returns {string} */
  getPropertyPriority(name) {
    return this.#properties.get(name)?.priority ?? "";
  }

  /** @returns {void} */
  setProperty(name, value, priority = "") {
    this.#properties.set(name, { value: String(value), priority: String(priority) });
  }

  /** @returns {void} */
  removeProperty(name) {
    this.#properties.delete(name);
  }
}

class ComputedStyle {
  constructor(values = {}) {
    this.values = { ...values };
    this.overflowX = values.overflowX ?? "visible";
    this.overflowY = values.overflowY ?? "visible";
    this.direction = values.direction ?? "ltr";
    this.overscrollBehaviorX = values.overscrollBehaviorX ?? "auto";
    this.overscrollBehaviorY = values.overscrollBehaviorY ?? "auto";
  }

  /** @returns {string} */
  getPropertyValue(name) {
    const value = this.values[name];
    return value == null ? "" : String(value);
  }
}

function descendants(element) {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

export class FixtureElement {
  constructor(tagName, { computed = {}, metrics = {}, rect = {} } = {}) {
    this.tagName = tagName.toUpperCase();
    this.computed = new ComputedStyle(computed);
    this.style = new InlineStyle();
    this.children = [];
    this.parentElement = null;
    this.shadowRoot = null;
    this.shadowRootOwner = null;
    this.connected = false;
    Object.assign(this, {
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 0,
      clientWidth: 0,
      scrollHeight: 0,
      clientHeight: 0,
      ...metrics,
    });
    this.rect = { width: rect.width ?? 0, height: rect.height ?? 0 };
  }

  /** @returns {boolean} */
  get isConnected() {
    return this.connected;
  }

  /** @returns {FixtureElement | FixtureShadowRoot} */
  getRootNode() {
    if (this.shadowRootOwner) return this.shadowRootOwner;
    return this.parentElement?.getRootNode() ?? this;
  }

  /** @returns {FixtureElement[]} */
  querySelectorAll() {
    return descendants(this);
  }

  /** @returns {FixtureElement} */
  appendChild(element) {
    if (element.parentElement) element.parentElement.removeChild(element);
    this.children.push(element);
    element.parentElement = this;
    element.shadowRootOwner = null;
    element.setConnected(this.isConnected);
    return element;
  }

  /** @returns {FixtureElement} */
  removeChild(element) {
    const index = this.children.indexOf(element);
    if (index < 0) throw new Error("The element is not a child");
    this.children.splice(index, 1);
    element.parentElement = null;
    element.setConnected(false);
    return element;
  }

  /** @returns {void} */
  setConnected(connected) {
    this.connected = connected;
    for (const child of this.children) child.setConnected(connected);
    for (const child of this.shadowRoot?.children ?? []) child.setConnected(connected);
  }

  /** @returns {{ width: unknown, height: unknown }} */
  getBoundingClientRect() {
    return this.rect;
  }

  /** @returns {void} */
  scrollBy({ left = 0, top = 0 }) {
    this.scrollLeft += left;
    this.scrollTop += top;
  }
}

export class FixtureShadowRoot {
  constructor(host) {
    this.host = host;
    this.children = [];
    host.shadowRoot = this;
  }

  /** @returns {FixtureElement} */
  appendChild(element) {
    this.children.push(element);
    element.parentElement = null;
    element.shadowRootOwner = this;
    element.setConnected(this.host.isConnected);
    return element;
  }
}

class FixtureDocument {
  constructor() {
    this.documentElement = new FixtureElement("html", {
      computed: { "--ks-tty-cell-w": "8px", "--ks-tty-cell-h": "17px" },
    });
    this.documentElement.setConnected(true);
    this.body = this.documentElement.appendChild(new FixtureElement("body"));
    this.scrollingElement = this.documentElement;
  }

  /** @returns {FixtureElement[]} */
  querySelectorAll(selector) {
    const elements = [this.documentElement, ...descendants(this.documentElement)];
    if (selector === "*") return elements;
    const names = selector.split(",").map((name) => name.trim().toLowerCase());
    return elements.filter((element) => names.includes(element.tagName.toLowerCase()));
  }
}

class FakeClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  /** @returns {number} */
  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Math.max(0, Number(delay) || 0), callback });
    return id;
  }

  /** @returns {void} */
  clearTimeout(id) {
    this.timers.delete(id);
  }

  /** @returns {void} */
  advanceTo(time) {
    if (time < this.now) throw new RangeError("The clock cannot move backwards");
    while (true) {
      let next = null;
      for (const [id, timer] of this.timers) {
        if (!next || timer.at < next.at || (timer.at === next.at && id < next.id)) {
          next = { id, ...timer };
        }
      }
      if (!next || next.at > time) break;
      this.timers.delete(next.id);
      this.now = next.at;
      next.callback();
    }
    this.now = time;
  }

  /** @returns {void} */
  advanceBy(milliseconds) {
    this.advanceTo(this.now + milliseconds);
  }
}

/** @returns {ContentScriptFixture} */
export function createContentScriptFixture(testContext) {
  const document = new FixtureDocument();
  const clock = new FakeClock();
  const listeners = new Map();
  const observers = [];
  const polls = [];
  const consoleWarnings = [];
  const window = {
    addEventListener(type, listener) {
      const registered = listeners.get(type) ?? [];
      registered.push(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((current) => current !== listener),
      );
    },
  };
  const MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
    }

    deliver(records) {
      if (
        this.target !== document.documentElement ||
        this.options?.childList !== true ||
        this.options?.subtree !== true
      ) {
        throw new Error("The content script is not observing the document subtree");
      }
      this.callback(records, this);
    }
  };
  const context = createContext({
    document,
    window,
    Element: FixtureElement,
    ShadowRoot: FixtureShadowRoot,
    MutationObserver,
    chrome: {
      runtime: {
        sendMessage(message) {
          const serialized = JSON.parse(JSON.stringify(message));
          return new Promise((resolve) => polls.push({ message: serialized, resolve }));
        },
      },
    },
    getComputedStyle: (element) => element.computed,
    setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
    clearTimeout: (id) => clock.clearTimeout(id),
    innerWidth: 800,
    innerHeight: 600,
    console: {
      info() {},
      warn(...args) {
        consoleWarnings.push(args);
      },
    },
  });

  testContext.after(() => assert.deepEqual(consoleWarnings, []));

  return {
    document,
    clock,
    polls,
    get observer() {
      return observers[0];
    },
    async load() {
      for (const { filename, source } of scripts) {
        runInContext(source, context, { filename });
      }
    },
    dispatch(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    async reply(index, result) {
      const poll = polls[index];
      if (!poll) throw new Error(`No poll request at index ${index}`);
      poll.resolve(result);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}
