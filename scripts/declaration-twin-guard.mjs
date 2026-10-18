// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { readFileSync } from "node:fs";

export const TWIN_MARKER = "@ks-declaration-twin";

function twinError(path) {
  return (
    `${path} is a declaration twin (${TWIN_MARKER}) and must never be ` +
    "bundled: mark its specifier external or supply the real module."
  );
}

const isTwin = (path) =>
  /\.[cm]?ts$/.test(path) && readFileSync(path, "utf8").includes(TWIN_MARKER);

export const esbuildTwinGuard = {
  name: "declaration-twin-guard",
  /** @returns {void} */
  setup(build) {
    build.onLoad({ filter: /\.[cm]?ts$/ }, (args) =>
      isTwin(args.path) ? { errors: [{ text: twinError(args.path) }] } : undefined,
    );
  },
};

export const rollupTwinGuard = {
  name: "declaration-twin-guard",
  /** @returns {null} */
  load(id) {
    if (isTwin(id)) this.error(twinError(id));
    return null;
  },
};
