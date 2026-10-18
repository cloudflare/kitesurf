// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

let lastStatus;
let appliedCss = null;
let appliedLevel = 0;
let gridHost = null;
let gridSignature = "";
const snappedMedia = new Map();
const snappedInsets = new Map();
const GRID_INSETS = [
  ["margin-top", "y", null],
  ["margin-right", "x", null],
  ["margin-bottom", "y", null],
  ["margin-left", "x", null],
  ["padding-top", "y", "border-top-width"],
  ["padding-right", "x", "border-right-width"],
  ["padding-bottom", "y", "border-bottom-width"],
  ["padding-left", "x", "border-left-width"],
  ["row-gap", "y", null],
  ["column-gap", "x", null],
];
const FALLBACK_CELL_WIDTH_PX = 8;
const FALLBACK_CELL_HEIGHT_PX = 17;
const SNAP_EPSILON_PX = 0.01;
const POLL_INTERVAL_MS = 500;
const WHEEL_FLUSH_MS = 33;
const wheel = {
  dx: 0,
  dy: 0,
  horizontal: null,
  horizontalStart: null,
  vertical: null,
  verticalStart: null,
  timer: 0,
};

function showGrid(visible) {
  if (gridHost && !gridHost.isConnected) {
    gridHost = null;
    gridSignature = "";
  }
  if (!visible) {
    gridHost?.remove();
    gridHost = null;
    gridSignature = "";
    return;
  }
  if (gridHost) {
    drawGrid();
    return;
  }

  const host = document.createElement("canvas");
  host.setAttribute("aria-hidden", "true");
  host.style.setProperty("all", "initial", "important");
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("inset", "0", "important");
  host.style.setProperty("width", "100vw", "important");
  host.style.setProperty("height", "100vh", "important");
  host.style.setProperty("z-index", "2147483647", "important");
  host.style.setProperty("pointer-events", "none", "important");
  document.documentElement.prepend(host);
  gridHost = host;
  drawGrid();
}

function drawGrid() {
  if (!gridHost) return;

  const width = window.innerWidth;
  const height = window.innerHeight;
  const scale = window.devicePixelRatio || 1;
  const cellWidth = cellPixels("--ks-tty-cell-w", FALLBACK_CELL_WIDTH_PX);
  const cellHeight = cellPixels("--ks-tty-cell-h", FALLBACK_CELL_HEIGHT_PX);
  const signature = `${width}:${height}:${scale}:${cellWidth}:${cellHeight}`;
  if (signature === gridSignature) return;

  gridHost.width = Math.ceil(width * scale);
  gridHost.height = Math.ceil(height * scale);

  const context = gridHost.getContext("2d");
  if (!context) return;
  gridSignature = signature;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.fillStyle = "rgba(164, 214, 94, 0.35)";
  for (let x = 0; x < width; x += cellWidth) context.fillRect(x, 0, 1, height);
  for (let y = 0; y < height; y += cellHeight) context.fillRect(0, y, width, 1);
}

function restoreMedia() {
  for (const [element, original] of snappedMedia) {
    restoreMediaElement(element, original);
  }
  snappedMedia.clear();
}

function restoreMediaElement(element, original) {
  for (const name of ["width", "height"]) {
    const property = original[name];
    if (property.value) {
      element.style.setProperty(name, property.value, property.priority);
    } else {
      element.style.removeProperty(name);
    }
  }
}

function restoreInsets() {
  for (const [element, originals] of snappedInsets) {
    restoreInsetsElement(element, originals);
  }
  snappedInsets.clear();
}

function restoreInsetsElement(element, originals) {
  for (const [name, property] of originals) {
    if (property.value) {
      element.style.setProperty(name, property.value, property.priority);
    } else {
      element.style.removeProperty(name);
    }
  }
}

function restoreDisconnectedSnaps() {
  for (const [element, original] of snappedMedia) {
    if (element.isConnected) continue;
    restoreMediaElement(element, original);
    snappedMedia.delete(element);
  }
  for (const [element, originals] of snappedInsets) {
    if (element.isConnected) continue;
    restoreInsetsElement(element, originals);
    snappedInsets.delete(element);
  }
}

function insetElements(root) {
  if (root instanceof Element) return [root, ...root.querySelectorAll("*")];
  return [...root.querySelectorAll("*")];
}

function snapInsetsIn(root) {
  if (appliedLevel === 0) return;
  const cellWidth = cellPixels("--ks-tty-cell-w", FALLBACK_CELL_WIDTH_PX);
  const cellHeight = cellPixels("--ks-tty-cell-h", FALLBACK_CELL_HEIGHT_PX);
  const plans = [];

  for (const element of insetElements(root)) {
    if (element === gridHost || snappedInsets.has(element)) continue;
    const style = getComputedStyle(element);
    const changes = [];
    for (const [name, axis, borderName] of GRID_INSETS) {
      const value = style.getPropertyValue(name);
      const cell = axis === "x" ? cellWidth : cellHeight;
      const snapped = borderName
        ? globalThis.ttyCssSnap.nearestContentInset(value, style.getPropertyValue(borderName), cell)
        : globalThis.ttyCssSnap.nearestCssPixel(value, cell);
      if (snapped === null || Math.abs(Number.parseFloat(value) - snapped) < SNAP_EPSILON_PX)
        continue;
      changes.push([name, `${snapped}px`]);
    }
    if (changes.length > 0) plans.push([element, changes]);
  }

  for (const [element, changes] of plans) {
    const originals = new Map();
    for (const [name, value] of changes) {
      originals.set(name, {
        value: element.style.getPropertyValue(name),
        priority: element.style.getPropertyPriority(name),
      });
      element.style.setProperty(name, value, "important");
    }
    snappedInsets.set(element, originals);
  }
}

function snapInsets(refresh = false) {
  if (refresh || appliedLevel === 0) restoreInsets();
  if (appliedLevel > 0) snapInsetsIn(document);
}

function snapMedia(refresh = false) {
  if (refresh) restoreMedia();
  if (appliedLevel === 0) {
    restoreMedia();
    return;
  }

  const cellWidth = cellPixels("--ks-tty-cell-w", FALLBACK_CELL_WIDTH_PX);
  const cellHeight = cellPixels("--ks-tty-cell-h", FALLBACK_CELL_HEIGHT_PX);
  for (const element of document.querySelectorAll("img, video, canvas, svg")) {
    if (element === gridHost || snappedMedia.has(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const width = globalThis.ttyCssSnap.nearestCell(rect.width, cellWidth);
    const height = globalThis.ttyCssSnap.nearestCell(rect.height, cellHeight);
    if (width === rect.width && height === rect.height) continue;

    snappedMedia.set(element, {
      width: {
        value: element.style.getPropertyValue("width"),
        priority: element.style.getPropertyPriority("width"),
      },
      height: {
        value: element.style.getPropertyValue("height"),
        priority: element.style.getPropertyPriority("height"),
      },
    });
    element.style.setProperty("width", `${width}px`, "important");
    element.style.setProperty("height", `${height}px`, "important");
  }
}

window.addEventListener("resize", () => {
  drawGrid();
  snapMedia(true);
  snapInsets(true);
});

const layoutObserver = new MutationObserver((records) => {
  if (appliedLevel === 0) return;
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element) snapInsetsIn(node);
    }
  }
  restoreDisconnectedSnaps();
});
layoutObserver.observe(document.documentElement, { childList: true, subtree: true });

function resetWheel() {
  if (wheel.timer !== 0) clearTimeout(wheel.timer);
  wheel.dx = 0;
  wheel.dy = 0;
  wheel.horizontal = null;
  wheel.horizontalStart = null;
  wheel.vertical = null;
  wheel.verticalStart = null;
  wheel.timer = 0;
}

function cellPixels(name, fallback) {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name),
  );
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parentElement(element) {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function scrollState(element, axis, delta) {
  const vertical = axis === "y";
  const style = getComputedStyle(element);
  const overflow = vertical ? style.overflowY : style.overflowX;
  if (!/^(auto|overlay|scroll)$/.test(overflow)) return { container: false, movable: false };

  const range = scrollRange(element, axis, delta, style);
  return {
    container: range.extent > 0,
    movable:
      range.extent > 0 &&
      globalThis.ttyCssScroll.canMove(range.position, range.minimum, range.maximum, delta),
    contains: (vertical ? style.overscrollBehaviorY : style.overscrollBehaviorX) !== "auto",
    available: range.available,
  };
}

function scrollRange(element, axis, delta, style) {
  const vertical = axis === "y";
  const position = vertical ? element.scrollTop : element.scrollLeft;
  const extent = vertical
    ? element.scrollHeight - element.clientHeight
    : element.scrollWidth - element.clientWidth;
  const rtl = !vertical && style.direction === "rtl";
  const minimum = rtl ? -extent : 0;
  const maximum = rtl ? 0 : extent;
  return {
    extent,
    position,
    minimum,
    maximum,
    available: delta < 0 ? position - minimum : maximum - position,
  };
}

function scrollTarget(start, axis, delta, cellPx) {
  for (let element = start; element; element = parentElement(element)) {
    const state = scrollState(element, axis, delta);
    if (state.movable && state.available >= cellPx) return element;
    if (state.container && state.contains) return null;
  }
  const root = document.scrollingElement;
  if (!root) return null;
  const rootStyle = getComputedStyle(root);
  const bodyStyle = document.body ? getComputedStyle(document.body) : null;
  const rootOverflow = axis === "y" ? rootStyle.overflowY : rootStyle.overflowX;
  const bodyOverflow = bodyStyle && (axis === "y" ? bodyStyle.overflowY : bodyStyle.overflowX);
  if (rootOverflow === "hidden" || rootOverflow === "clip") return null;
  if (bodyOverflow === "hidden" || bodyOverflow === "clip") return null;
  const range = scrollRange(root, axis, delta, rootStyle);
  return range.extent > 0 &&
    range.available >= cellPx &&
    globalThis.ttyCssScroll.canMove(range.position, range.minimum, range.maximum, delta)
    ? root
    : null;
}

function wholeCellMovement(element, axis, delta, cellPx) {
  if (!element || delta === 0) return 0;
  const style = getComputedStyle(element);
  const range = scrollRange(element, axis, delta, style);
  return globalThis.ttyCssScroll.limitToWholeCells(delta, range.available, cellPx);
}

function scrollWholeCells(start, axis, delta, cellPx) {
  let remaining = delta;
  let current = start;
  while (current && remaining !== 0) {
    const target = scrollTarget(current, axis, remaining, cellPx);
    if (!target) return;
    const movement = wholeCellMovement(target, axis, remaining, cellPx);
    if (movement === 0) return;
    if (axis === "x") target.scrollBy({ left: movement, behavior: "instant" });
    else target.scrollBy({ top: movement, behavior: "instant" });
    remaining -= movement;
    if (remaining === 0 || scrollState(target, axis, remaining).contains) return;
    current = parentElement(target);
  }
}

function flushWheel() {
  if (wheel.timer !== 0) clearTimeout(wheel.timer);
  wheel.timer = 0;
  if (wheel.dx === 0 && wheel.dy === 0) return;

  const cellW = cellPixels("--ks-tty-cell-w", FALLBACK_CELL_WIDTH_PX);
  const cellH = cellPixels("--ks-tty-cell-h", FALLBACK_CELL_HEIGHT_PX);
  const horizontalDelta = globalThis.ttyCssScroll.consumeDelta(wheel.dx, cellW);
  const verticalDelta = globalThis.ttyCssScroll.consumeDelta(wheel.dy, cellH);
  const dx = horizontalDelta.movement;
  const dy = verticalDelta.movement;
  const horizontalStart = wheel.horizontalStart;
  const verticalStart = wheel.verticalStart;
  wheel.dx = horizontalDelta.remainder;
  wheel.dy = verticalDelta.remainder;
  if (wheel.dx === 0) {
    wheel.horizontal = null;
    wheel.horizontalStart = null;
  }
  if (wheel.dy === 0) {
    wheel.vertical = null;
    wheel.verticalStart = null;
  }

  if (dx !== 0 && horizontalStart) scrollWholeCells(horizontalStart, "x", dx, cellW);
  if (dy !== 0 && verticalStart) scrollWholeCells(verticalStart, "y", dy, cellH);
}

function handleWheel(event) {
  if (
    appliedLevel === 0 ||
    event.defaultPrevented ||
    event.ctrlKey ||
    (!event.deltaX && !event.deltaY)
  )
    return;
  event.preventDefault();

  const cellW = cellPixels("--ks-tty-cell-w", FALLBACK_CELL_WIDTH_PX);
  const cellH = cellPixels("--ks-tty-cell-h", FALLBACK_CELL_HEIGHT_PX);
  const rawX = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
  const rawY = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
  const start = event.composedPath().find((node) => node instanceof Element) ?? null;
  const horizontal = start && rawX !== 0 ? scrollTarget(start, "x", rawX, cellW) : null;
  const vertical = start && rawY !== 0 ? scrollTarget(start, "y", rawY, cellH) : null;
  if (
    (rawX !== 0 && wheel.dx !== 0 && horizontal !== wheel.horizontal) ||
    (rawY !== 0 && wheel.dy !== 0 && vertical !== wheel.vertical)
  ) {
    flushWheel();
    wheel.dx = 0;
    wheel.dy = 0;
    wheel.horizontal = null;
    wheel.horizontalStart = null;
    wheel.vertical = null;
    wheel.verticalStart = null;
  }
  if (horizontal) {
    wheel.dx += globalThis.ttyCssScroll.deltaPixels(rawX, event.deltaMode, cellW, innerWidth);
    wheel.horizontal = horizontal;
    wheel.horizontalStart = start;
  }
  if (vertical) {
    wheel.dy += globalThis.ttyCssScroll.deltaPixels(rawY, event.deltaMode, cellH, innerHeight);
    wheel.vertical = vertical;
    wheel.verticalStart = start;
  }
  if ((wheel.dx !== 0 || wheel.dy !== 0) && wheel.timer === 0) {
    wheel.timer = setTimeout(flushWheel, WHEEL_FLUSH_MS);
  }
}

window.addEventListener("wheel", handleWheel, { passive: false });

function reportStatus(result) {
  if (!result || result.status === lastStatus) return;
  lastStatus = result.status;

  if (result.status === "offline" || result.status === "error") {
    console.warn(`[tty-css-preview] ${result.status}: ${result.message ?? "unknown error"}`);
  } else if (result.status === "updated") {
    console.info(`[tty-css-preview] Applied level ${result.appliedLevel}`);
  }
}

async function poll() {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "poll",
      appliedCss,
      appliedLevel,
    });
    if (result && Object.hasOwn(result, "appliedCss")) {
      appliedCss = result.appliedCss;
      appliedLevel = result.appliedLevel;
      if (appliedLevel === 0) resetWheel();
    }
    snapMedia(result?.status === "updated");
    snapInsets(result?.status === "updated");
    if (result && Object.hasOwn(result, "showGrid")) showGrid(result.showGrid === true);
    reportStatus(result);
  } catch (error) {
    console.warn("[tty-css-preview] The extension stopped polling", error);
    appliedLevel = 0;
    restoreMedia();
    restoreInsets();
    showGrid(false);
    resetWheel();
    window.removeEventListener("wheel", handleWheel);
    return;
  }

  setTimeout(poll, POLL_INTERVAL_MS);
}

void poll();
