// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

const orig = window.requestAnimationFrame;
globalThis.requestAnimationFrame = (cb) => orig(cb);
export default function run(el) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { el.setAttribute('data-status', 'raf-timeout'); resolve('timeout'); }, 8000);
    try {
      requestAnimationFrame(() => {
        clearTimeout(t);
        el.setAttribute('data-status', 'raf-fired');
        resolve('ok');
      });
    } catch (e) {
      clearTimeout(t);
      el.setAttribute('data-status', 'raf-threw');
      el.setAttribute('data-error', String((e && e.message) || e).slice(0, 200));
      resolve('threw: ' + String((e && e.message) || e).slice(0, 120));
    }
  });
}
