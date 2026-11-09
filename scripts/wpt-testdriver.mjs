// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

const PUA_KEYS = {
  "\uE000": ["Unidentified", "", 0, 0],
  "\uE001": ["Cancel", "Abort", 3, 0],
  "\uE002": ["Help", "Help", 6, 0],
  "\uE003": ["Backspace", "Backspace", 8, 0],
  "\uE004": ["Tab", "Tab", 9, 0],
  "\uE005": ["Clear", "Clear", 12, 0],
  "\uE006": ["Enter", "Enter", 13, 0],
  "\uE007": ["Enter", "NumpadEnter", 13, 3],
  "\uE008": ["Shift", "ShiftLeft", 16, 1],
  "\uE009": ["Control", "ControlLeft", 17, 1],
  "\uE00A": ["Alt", "AltLeft", 18, 1],
  "\uE00B": ["Pause", "Pause", 19, 0],
  "\uE00C": ["Escape", "Escape", 27, 0],
  "\uE00D": [" ", "Space", 32, 0],
  "\uE00E": ["PageUp", "PageUp", 33, 0],
  "\uE00F": ["PageDown", "PageDown", 34, 0],
  "\uE010": ["End", "End", 35, 0],
  "\uE011": ["Home", "Home", 36, 0],
  "\uE012": ["ArrowLeft", "ArrowLeft", 37, 0],
  "\uE013": ["ArrowUp", "ArrowUp", 38, 0],
  "\uE014": ["ArrowRight", "ArrowRight", 39, 0],
  "\uE015": ["ArrowDown", "ArrowDown", 40, 0],
  "\uE016": ["Insert", "Insert", 45, 0],
  "\uE017": ["Delete", "Delete", 46, 0],
  "\uE018": [";", "Semicolon", 186, 0],
  "\uE019": ["=", "Equal", 187, 0],
  "\uE01A": ["0", "Numpad0", 96, 3],
  "\uE01B": ["1", "Numpad1", 97, 3],
  "\uE01C": ["2", "Numpad2", 98, 3],
  "\uE01D": ["3", "Numpad3", 99, 3],
  "\uE01E": ["4", "Numpad4", 100, 3],
  "\uE01F": ["5", "Numpad5", 101, 3],
  "\uE020": ["6", "Numpad6", 102, 3],
  "\uE021": ["7", "Numpad7", 103, 3],
  "\uE022": ["8", "Numpad8", 104, 3],
  "\uE023": ["9", "Numpad9", 105, 3],
  "\uE024": ["*", "NumpadMultiply", 106, 3],
  "\uE025": ["+", "NumpadAdd", 107, 3],
  "\uE026": [",", "NumpadComma", 108, 3],
  "\uE027": ["-", "NumpadSubtract", 109, 3],
  "\uE028": [".", "NumpadDecimal", 110, 3],
  "\uE029": ["/", "NumpadDivide", 111, 3],
  "\uE031": ["F1", "F1", 112, 0],
  "\uE032": ["F2", "F2", 113, 0],
  "\uE033": ["F3", "F3", 114, 0],
  "\uE034": ["F4", "F4", 115, 0],
  "\uE035": ["F5", "F5", 116, 0],
  "\uE036": ["F6", "F6", 117, 0],
  "\uE037": ["F7", "F7", 118, 0],
  "\uE038": ["F8", "F8", 119, 0],
  "\uE039": ["F9", "F9", 120, 0],
  "\uE03A": ["F10", "F10", 121, 0],
  "\uE03B": ["F11", "F11", 122, 0],
  "\uE03C": ["F12", "F12", 123, 0],
  "\uE03D": ["Meta", "MetaLeft", 91, 1],
  "\uE040": ["ZenkakuHankaku", "Lang5", 0, 0],
  "\uE050": ["Shift", "ShiftRight", 16, 2],
  "\uE051": ["Control", "ControlRight", 17, 2],
  "\uE052": ["Alt", "AltRight", 18, 2],
  "\uE053": ["Meta", "MetaRight", 92, 2],
  "\uE054": ["PageUp", "Numpad9", 33, 3],
  "\uE055": ["PageDown", "Numpad3", 34, 3],
  "\uE056": ["End", "Numpad1", 35, 3],
  "\uE057": ["Home", "Numpad7", 36, 3],
  "\uE058": ["ArrowLeft", "Numpad4", 37, 3],
  "\uE059": ["ArrowUp", "Numpad8", 38, 3],
  "\uE05A": ["ArrowRight", "Numpad6", 39, 3],
  "\uE05B": ["ArrowDown", "Numpad2", 40, 3],
  "\uE05C": ["Insert", "Numpad0", 45, 3],
  "\uE05D": ["Delete", "NumpadDecimal", 46, 3],
};

const PUNCT = {
  "`": ["Backquote", 192],
  "~": ["Backquote", 192],
  "-": ["Minus", 189],
  _: ["Minus", 189],
  "=": ["Equal", 187],
  "+": ["Equal", 187],
  "[": ["BracketLeft", 219],
  "{": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "}": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  "|": ["Backslash", 220],
  ";": ["Semicolon", 186],
  ":": ["Semicolon", 186],
  "'": ["Quote", 222],
  '"': ["Quote", 222],
  ",": ["Comma", 188],
  "<": ["Comma", 188],
  ".": ["Period", 190],
  ">": ["Period", 190],
  "/": ["Slash", 191],
  "?": ["Slash", 191],
  " ": ["Space", 32],
  "!": ["Digit1", 49],
  "@": ["Digit2", 50],
  "#": ["Digit3", 51],
  $: ["Digit4", 52],
  "%": ["Digit5", 53],
  "^": ["Digit6", 54],
  "&": ["Digit7", 55],
  "*": ["Digit8", 56],
  "(": ["Digit9", 57],
  ")": ["Digit0", 48],
};

const SHIFTED = new Set([
  "~",
  "_",
  "+",
  "{",
  "}",
  "|",
  ":",
  '"',
  "<",
  ">",
  "?",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
]);

const MOD_ALT = 1;
const MOD_CTRL = 2;
const MOD_META = 4;
const MOD_SHIFT = 8;

const MODIFIER_BIT = {
  Alt: MOD_ALT,
  Control: MOD_CTRL,
  Meta: MOD_META,
  Shift: MOD_SHIFT,
};

/** @typedef {{
 * key: string, code: string, keyCode: number, location: number,
 * text: string, shifted: boolean
 * }} ResolvedKey */

/** @param {string} value
 * @returns {ResolvedKey} */
export function resolveKey(value) {
  const pua = PUA_KEYS[value];
  if (pua) {
    const [key, code, keyCode, location] = pua;
    // chromedriver sends Enter with the text "\r": that text is what makes Chrome fire a keypress
    // and run Enter's line break or implicit submission.
    const text = key === " " ? " " : key === "Enter" ? "\r" : "";
    return { key, code, keyCode, location, text, shifted: false };
  }
  const ch = value;
  if (ch >= "a" && ch <= "z") {
    return {
      key: ch,
      code: `Key${ch.toUpperCase()}`,
      keyCode: ch.toUpperCase().charCodeAt(0),
      location: 0,
      text: ch,
      shifted: false,
    };
  }
  if (ch >= "A" && ch <= "Z") {
    return {
      key: ch,
      code: `Key${ch}`,
      keyCode: ch.charCodeAt(0),
      location: 0,
      text: ch,
      shifted: true,
    };
  }
  if (ch >= "0" && ch <= "9") {
    return {
      key: ch,
      code: `Digit${ch}`,
      keyCode: ch.charCodeAt(0),
      location: 0,
      text: ch,
      shifted: false,
    };
  }
  const punct = PUNCT[ch];
  if (punct) {
    return {
      key: ch,
      code: punct[0],
      keyCode: punct[1],
      location: 0,
      text: ch,
      shifted: SHIFTED.has(ch),
    };
  }
  return { key: ch, code: "", keyCode: 0, location: 0, text: ch, shifted: false };
}

export const TESTDRIVER_BINDING = "__ks_testdriver";

export const TESTDRIVER_HOOK_SOURCE =
  String.raw`
(() => {
  const td = (globalThis.__ks_td = globalThis.__ks_td ||
    { seq: 0, queue: [], pending: {} });

  // Park a resolver, queue the request, ring the doorbell. The
  // binding may be absent (never registered) or refuse to send at
  // module-init scope — wpt-exec's poll drains the same queue.
  const request = (action, args) => {
    const id = ++td.seq;
    return new Promise((resolve, reject) => {
      td.pending[id] = { resolve, reject };
      td.queue.push({ id, action, args });
      try {
        const ring = globalThis.` +
  TESTDRIVER_BINDING +
  String.raw`;
        if (typeof ring === "function") ring(String(id));
      } catch (e) {}
    });
  };

  // WebDriver's "in view center point": the element's first client
  // rect intersected with the viewport, then floored. testdriver.js
  // computes the same thing for click(); we need it again here to
  // turn an Actions element origin into viewport coordinates.
  const centerPoint = (el) => {
    let rect = null;
    try {
      const rects = el.getClientRects ? el.getClientRects() : null;
      rect = rects && rects.length ? rects[0] : null;
      if (!rect && el.getBoundingClientRect) rect = el.getBoundingClientRect();
    } catch (e) { rect = null; }
    if (!rect) return null;
    const w = globalThis.innerWidth || 0;
    const h = globalThis.innerHeight || 0;
    const left = Math.max(0, Math.min(rect.x, rect.x + rect.width));
    const right = Math.min(w, Math.max(rect.x, rect.x + rect.width));
    const top = Math.max(0, Math.min(rect.y, rect.y + rect.height));
    const bottom = Math.min(h, Math.max(rect.y, rect.y + rect.height));
    return [
      Math.floor((left + right) / 2),
      Math.floor((top + bottom) / 2),
    ];
  };

  // Element origins can't cross the CDP boundary, so resolve them
  // here: an element origin becomes viewport coordinates offset by
  // the action's own x/y, exactly as WebDriver specifies. "pointer"
  // stays symbolic — the runner tracks the cursor.
  const resolveOrigins = (sources) => {
    const out = [];
    for (const src of sources || []) {
      const copy = {
        type: src.type,
        id: src.id,
        parameters: src.parameters,
        actions: [],
      };
      for (const action of src.actions || []) {
        const a = {};
        for (const k in action) a[k] = action[k];
        if (a.origin && typeof a.origin === "object") {
          const c = centerPoint(a.origin);
          if (!c) {
            throw new Error("action origin element has no client rect");
          }
          a.x = c[0] + (typeof a.x === "number" ? a.x : 0);
          a.y = c[1] + (typeof a.y === "number" ? a.y : 0);
          a.origin = "viewport";
        }
        copy.actions.push(a);
      }
      out.push(copy);
    }
    return out;
  };

  const install = (v) => {
    if (!v || typeof v !== "object") return;
    v.click = function (element, coords) {
      return request("click", {
        x: coords ? coords.x : 0,
        y: coords ? coords.y : 0,
      });
    };
    v.send_keys = function (element, keys) {
      // WebDriver's Element Send Keys focuses the element first. We
      // do it in-page because the runner has no element handle;
      // the key events then land on document.activeElement.
      try {
        if (element && typeof element.focus === "function") element.focus();
      } catch (e) {}
      return request("send_keys", { keys: String(keys) });
    };
    v.action_sequence = function (actions, context) {
      let resolved;
      try {
        resolved = resolveOrigins(actions);
      } catch (e) {
        return Promise.reject(e);
      }
      return request("actions", { sources: resolved });
    };
  };

  try {
    let internal;
    Object.defineProperty(globalThis, "test_driver_internal", {
      configurable: true,
      get() { return internal; },
      set(v) { internal = v; try { install(v); } catch (e) {} },
    });
  } catch (e) {}
})()`;

const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP = 2;

const MOVE_STEP_MS = 10;
const MOVE_MAX_STEPS = 32;

function buttonName(button) {
  switch (button) {
    case 1:
      return "middle";
    case 2:
      return "right";
    case 3:
      return "back";
    case 4:
      return "forward";
    default:
      return "left";
  }
}

function buttonMask(button) {
  switch (button) {
    case 1:
      return 4;
    case 2:
      return 2;
    case 3:
      return 8;
    case 4:
      return 16;
    default:
      return 1;
  }
}

/** @typedef {{
 * page: import("puppeteer-core").Page,
 * session: import("puppeteer-core").CDPSession
 * }} BridgeArgs */

/** @param {BridgeArgs} args
 * @returns {{drain: () => Promise<void>, reset: () => void}} */
export function createTestdriverBridge({ page, session }) {
  const state = {
    x: 0,
    y: 0,
    buttons: 0,
    modifiers: 0,
    heldKeys: new Set(),
    clickCount: 0,
    lastClickAt: 0,
    lastClickX: 0,
    lastClickY: 0,
  };
  let draining = false;
  let pendingWake = false;

  async function mouse(type, extra) {
    await session.send("Input.dispatchMouseEvent", {
      type,
      x: state.x,
      y: state.y,
      modifiers: state.modifiers,
      buttons: state.buttons,
      ...extra,
    });
  }

  async function pointerMove(x, y, duration) {
    const steps =
      duration > 0 ? Math.max(1, Math.min(MOVE_MAX_STEPS, Math.round(duration / MOVE_STEP_MS))) : 1;
    const fromX = state.x;
    const fromY = state.y;
    for (let i = 1; i <= steps; i++) {
      state.x = Math.round(fromX + ((x - fromX) * i) / steps);
      state.y = Math.round(fromY + ((y - fromY) * i) / steps);
      await mouse("mouseMoved", { button: "none", _kitesurfSyncMove: true });
    }
    state.x = x;
    state.y = y;
  }

  async function pointerDown(button) {
    const now = Date.now();
    const near =
      Math.abs(state.x - state.lastClickX) <= DOUBLE_CLICK_SLOP &&
      Math.abs(state.y - state.lastClickY) <= DOUBLE_CLICK_SLOP;
    state.clickCount =
      near && now - state.lastClickAt <= DOUBLE_CLICK_MS ? state.clickCount + 1 : 1;
    state.lastClickAt = now;
    state.lastClickX = state.x;
    state.lastClickY = state.y;
    state.buttons |= buttonMask(button);
    await mouse("mousePressed", {
      button: buttonName(button),
      clickCount: state.clickCount,
    });
  }

  async function pointerUp(button) {
    state.buttons &= ~buttonMask(button);
    await mouse("mouseReleased", {
      button: buttonName(button),
      clickCount: state.clickCount,
    });
  }

  async function wheelScroll(x, y, deltaX, deltaY) {
    state.x = x;
    state.y = y;
    await mouse("mouseWheel", { button: "none", deltaX, deltaY });
  }

  async function keyDown(value) {
    const k = resolveKey(value);
    const bit = MODIFIER_BIT[k.key];
    const repeat = state.heldKeys.has(value);
    state.heldKeys.add(value);
    if (bit) state.modifiers |= bit;
    const mods = state.modifiers | (k.shifted ? MOD_SHIFT : 0);
    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      location: k.location,
      modifiers: mods,
      autoRepeat: repeat,
      text: "",
    });
    const suppressed = (mods & (MOD_CTRL | MOD_META)) !== 0;
    if (k.text && !suppressed) {
      await session.send("Input.dispatchKeyEvent", {
        type: "char",
        key: k.key,
        code: k.code,
        windowsVirtualKeyCode: k.keyCode,
        location: k.location,
        modifiers: mods,
        text: k.text,
      });
    }
  }

  async function keyUp(value) {
    const k = resolveKey(value);
    const bit = MODIFIER_BIT[k.key];
    state.heldKeys.delete(value);
    if (bit) {
      let stillHeld = false;
      for (const held of state.heldKeys) {
        if (MODIFIER_BIT[resolveKey(held).key] === bit) {
          stillHeld = true;
          break;
        }
      }
      if (!stillHeld) state.modifiers &= ~bit;
    }
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      location: k.location,
      modifiers: state.modifiers | (k.shifted ? MOD_SHIFT : 0),
      text: "",
    });
  }

  async function sendKeys(keys) {
    const sticky = [];
    for (const ch of String(keys)) {
      const isModifier = MODIFIER_BIT[resolveKey(ch).key] !== undefined;
      if (!isModifier) {
        await keyDown(ch);
        await keyUp(ch);
        continue;
      }
      const at = sticky.indexOf(ch);
      if (at === -1) {
        sticky.push(ch);
        await keyDown(ch);
      } else {
        sticky.splice(at, 1);
        await keyUp(ch);
      }
    }
    for (let i = sticky.length - 1; i >= 0; i--) {
      await keyUp(sticky[i]);
    }
  }

  async function click(x, y) {
    await pointerMove(x, y, 0);
    await pointerDown(0);
    await pointerUp(0);
  }

  async function runActions(sources) {
    const ticks = sources.reduce((n, s) => Math.max(n, (s.actions || []).length), 0);
    for (let tick = 0; tick < ticks; tick++) {
      for (const source of sources) {
        const action = (source.actions || [])[tick];
        if (!action) continue;
        await runAction(source, action);
      }
    }
  }

  async function runAction(source, action) {
    switch (action.type) {
      case "pause":
        return;
      case "pointerDown":
        return pointerDown(action.button ?? 0);
      case "pointerUp":
        return pointerUp(action.button ?? 0);
      case "pointerMove": {
        const origin = action.origin ?? "viewport";
        const x = origin === "pointer" ? state.x + (action.x ?? 0) : (action.x ?? 0);
        const y = origin === "pointer" ? state.y + (action.y ?? 0) : (action.y ?? 0);
        return pointerMove(x, y, action.duration ?? 0);
      }
      case "keyDown":
        return keyDown(action.value);
      case "keyUp":
        return keyUp(action.value);
      case "scroll":
        return wheelScroll(action.x ?? 0, action.y ?? 0, action.deltaX ?? 0, action.deltaY ?? 0);
      default:
        throw new Error(`unsupported action type: ${action.type}`);
    }
  }

  async function perform(item) {
    const args = item.args || {};
    switch (item.action) {
      case "click":
        return click(args.x ?? 0, args.y ?? 0);
      case "send_keys":
        return sendKeys(args.keys ?? "");
      case "actions":
        return runActions(args.sources || []);
      default:
        throw new Error(`unknown testdriver action: ${item.action}`);
    }
  }

  const TAKE_QUEUE = `(() => {
    const t = globalThis.__ks_td;
    if (!t || !t.queue.length) return null;
    return JSON.stringify(t.queue.splice(0));
  })()`;

  function settleSource(id, error) {
    const tail = error ? `p.reject(new Error(${JSON.stringify(error)}))` : "p.resolve()";
    return `(() => {
      const t = globalThis.__ks_td;
      const p = t && t.pending[${id}];
      if (p) { delete t.pending[${id}]; ${tail}; }
    })()`;
  }

  async function drain() {
    // Serialize binding wakes and scrape-poll drains so input state cannot interleave.
    if (draining) {
      pendingWake = true;
      return;
    }
    draining = true;
    try {
      do {
        pendingWake = false;
        let raw;
        try {
          raw = await page.evaluate(TAKE_QUEUE);
        } catch {
          return;
        }
        if (!raw) continue;
        let items;
        try {
          items = JSON.parse(raw);
        } catch {
          continue;
        }
        for (const item of items) {
          let error = null;
          try {
            await perform(item);
          } catch (err) {
            error = `testdriver ${item.action} failed: ${String((err && err.message) || err).slice(
              0,
              200,
            )}`;
          }
          try {
            await page.evaluate(settleSource(item.id, error));
          } catch {}
        }
      } while (pendingWake);
    } finally {
      draining = false;
    }
  }

  function reset() {
    state.x = 0;
    state.y = 0;
    state.buttons = 0;
    state.modifiers = 0;
    state.heldKeys.clear();
    state.clickCount = 0;
    state.lastClickAt = 0;
  }

  return { drain, reset };
}

/** @param {import("puppeteer-core").CDPSession} session
 * @param {ReturnType<typeof createTestdriverBridge>} bridge
 * @returns {Promise<boolean>} */
export async function attachTestdriverBinding(session, bridge) {
  try {
    await session.send("Runtime.enable");
  } catch {}
  try {
    await session.send("Runtime.addBinding", { name: TESTDRIVER_BINDING });
  } catch {
    return false;
  }
  session.on("Runtime.bindingCalled", (event) => {
    if (event?.name !== TESTDRIVER_BINDING) return;
    void bridge.drain();
  });
  return true;
}
