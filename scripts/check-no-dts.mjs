// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { resolve } from "node:path";
import { trackedFiles } from "./tracked-files.mjs";

const files = trackedFiles(resolve(import.meta.dirname, ".."), [
  "*.d.ts",
  "*.d.*.ts",
  ":(exclude)vendor/**",
]);

if (files.length) {
  console.error(
    "Hand-written declaration files are unchecked under skipLibCheck. " +
      "Rename them to .ts (see scripts/check-no-dts.mjs):\n" +
      files.map((f) => `  ${f}`).join("\n"),
  );
  process.exit(1);
}
