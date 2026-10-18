
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

function snapshot(label) {
  const r = { stage: label, sync: {}, asyncPending: {} };

  // setTimeout: sync return. Capture id + the timer's actual fire
  // as a Promise so the caller can await delivery.
  try {
    const p = new Promise((resolve) => {
      const id = setTimeout(() => resolve("fired"), 0);
      r.sync.setTimeout = "ok(id=" + id + ")";
    });
    r.asyncPending.setTimeout = p.catch((e) => "err:" + ((e && e.message) || e));
  } catch (e) { r.sync.setTimeout = String((e && e.message) || e); }

  // fetch: returns Promise<Response>.
  try {
    const p = fetch("data:text/plain,x").then((res) => "status=" + res.status);
    r.sync.fetch = "ok(Promise)";
    r.asyncPending.fetch = p.catch((e) => "err:" + ((e && e.message) || e));
  } catch (e) { r.sync.fetch = String((e && e.message) || e); }

  // getRandomValues: sync. Caller reads buf immediately.
  try {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    let sum = 0; for (const b of buf) sum += b;
    r.sync.getRandomValues = "ok(sum=" + sum + ")";
  } catch (e) { r.sync.getRandomValues = String((e && e.message) || e); }

  // subtle.digest: async.
  if (crypto && crypto.subtle && typeof crypto.subtle.digest === "function") {
    try {
      const p = crypto.subtle.digest("SHA-256", new Uint8Array(8))
        .then((buf) => "ok(bytes=" + buf.byteLength + ")");
      r.sync.subtleDigest = "ok(Promise)";
      r.asyncPending.subtleDigest = p.catch((e) => "err:" + ((e && e.message) || e));
    } catch (e) { r.sync.subtleDigest = String((e && e.message) || e); }
  }

  return r;
}

async function settleAsync(snap) {
  const out = { stage: snap.stage, sync: snap.sync, async: {} };
  for (const [k, p] of Object.entries(snap.asyncPending || {})) {
    out.async[k] = await p;
  }
  return out;
}

export const initSnapshot = snapshot("module-B-top-level");
export const settleInitSnapshot = () => settleAsync(initSnapshot);
export function checkPostInit() { return snapshot("module-B-post-init"); }
export const settlePostInit = (s) => settleAsync(s);
