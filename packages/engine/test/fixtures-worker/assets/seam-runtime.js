
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

const rawToProxy = new WeakMap();
const proxyToRaw = new WeakMap();
const deps = new Map();
let activeEffect = null;

function track(raw, key) {
  if (!activeEffect) return;
  let m = deps.get(raw);
  if (!m) { m = new Map(); deps.set(raw, m); }
  let s = m.get(key);
  if (!s) { s = new Set(); m.set(key, s); }
  s.add(activeEffect);
}
function trigger(raw, key) {
  const m = deps.get(raw);
  const s = m && m.get(key);
  if (!s) return;
  for (const fn of Array.from(s)) fn();
}
export function reactive(obj) {
  if (proxyToRaw.has(obj)) return obj;
  const hit = rawToProxy.get(obj);
  if (hit) return hit;
  const p = new Proxy(obj, {
    get(t, k, r) { track(t, k); return Reflect.get(t, k, r); },
    set(t, k, v, r) { const ok = Reflect.set(t, k, v, r); trigger(t, k); return ok; },
  });
  rawToProxy.set(obj, p);
  proxyToRaw.set(p, obj);
  return p;
}
export function isReactive(v) { return proxyToRaw.has(v); }
export function toRaw(v) { return proxyToRaw.get(v) || v; }
export function effect(fn) {
  activeEffect = fn;
  try { fn(); } finally { activeEffect = null; }
}
const memory = new WeakMap();
export function remember(o) { memory.set(o, true); }
export function recall(o) { return memory.get(o) === true; }
let runCount = 0;
export function effectRunCount() { return runCount; }
const idMap = new WeakMap(); let idc = 0;
export function crossId(x) { if (!idMap.has(x)) idMap.set(x, ++idc); return idMap.get(x); }
export function watchSize(raw, el) {
  const p = reactive(raw);
  effect(function () { runCount++; el.setAttribute("data-size", String(p.size)); });
}
export function setSizeV8(p, v) { p.size = v; }
export function readSize(p) { return p.size; }
export function tagOf(x) { return proxyToRaw.has(x) ? "reactive" : "notreactive"; }
