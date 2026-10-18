// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  headerInsertionOffset,
  hasCopyrightLicenseHeader,
  isExportedSourceFile,
  renderCopyrightHeader,
} from "./check-license-headers.mjs";

const apache = [
  "// Copyright (c) 2026 Cloudflare, Inc.",
  "// Licensed under the Apache 2.0 license found in the LICENSE file or at:",
  "// https://opensource.org/licenses/Apache-2.0",
].join("\n");

test("checks first-party source files, including served fixtures", () => {
  assert.equal(isExportedSourceFile("packages/engine/src/index.ts"), true);
  assert.equal(isExportedSourceFile("packages/engine/test/fixtures-worker/assets/page.js"), true);
  assert.equal(isExportedSourceFile("packages/engine/test/fixtures-worker/assets/page.html"), true);
  assert.equal(isExportedSourceFile("packages/engine/tsconfig.json"), false);
});

test("accepts line, hash, block, and markup comment headers", () => {
  assert.equal(hasCopyrightLicenseHeader("src/app.ts", apache + "\n\nexport {}"), true);
  assert.equal(
    hasCopyrightLicenseHeader(
      "scripts/tool.sh",
      `#!/bin/sh\n${apache.replaceAll("// ", "# ")}\n\necho ok`,
    ),
    true,
  );
  assert.equal(
    hasCopyrightLicenseHeader(
      "src/style.css",
      "/*\n * Copyright (c) 2026 Cloudflare, Inc.\n * Licensed under the Apache 2.0 license found in the LICENSE file or at:\n * https://opensource.org/licenses/Apache-2.0\n */\n\nbody {}",
    ),
    true,
  );
  assert.equal(
    hasCopyrightLicenseHeader(
      "test/page.html",
      "<!--\nCopyright (c) 2026 Cloudflare, Inc.\nLicensed under the Apache 2.0 license found in the LICENSE file or at:\nhttps://opensource.org/licenses/Apache-2.0\n-->\n<!doctype html>",
    ),
    true,
  );
});

test("skips a shebang and XML declaration but not source before the header", () => {
  assert.equal(
    hasCopyrightLicenseHeader("scripts/tool.mjs", `#!/usr/bin/env node\n${apache}\n\n`),
    true,
  );
  assert.equal(
    hasCopyrightLicenseHeader(
      "test/page.xhtml",
      `<?xml version="1.0"?>\n<!--\nCopyright (c) 2026 Cloudflare, Inc.\nLicensed under the Apache 2.0 license found in the LICENSE file or at:\nhttps://opensource.org/licenses/Apache-2.0\n-->\n`,
    ),
    true,
  );
  assert.equal(
    hasCopyrightLicenseHeader("src/app.ts", `export const value = 1;\n${apache}`),
    false,
  );
});

test("requires copyright and license information in the leading comment", () => {
  assert.equal(
    hasCopyrightLicenseHeader("src/app.ts", "// Copyright Cloudflare\n// license later\n"),
    false,
  );
  assert.equal(hasCopyrightLicenseHeader("src/app.ts", "// Licensed under Apache 2.0\n"), false);
});

test("requires upstream attribution for the vendored and generated data files", () => {
  assert.equal(
    hasCopyrightLicenseHeader(
      "vendor/wasm-memprof/instrumentor/src/call_graph.rs",
      "// Copyright (c) 2024 Yuta Saito\n// Licensed under the MIT License; see LICENSE.\n",
    ),
    true,
  );
  assert.equal(
    hasCopyrightLicenseHeader(
      "vendor/wasm-memprof/instrumentor/src/lib.rs",
      "// Copyright (c) 2026 Cloudflare, Inc.\n// Copyright (c) 2024 Yuta Saito\n// Licensed under the MIT License; see LICENSE.\n",
    ),
    true,
  );
  for (const file of [
    "packages/dom-shim/src/idl/types.generated.ts",
    "packages/dom-shim/src/css-typed-om.webidl.generated.ts",
    "packages/core/tests_data/angular_snapshot.html",
  ]) {
    assert.equal(hasCopyrightLicenseHeader(file, apache), false, file);
    assert.equal(hasCopyrightLicenseHeader(file, renderCopyrightHeader(file)), true, file);
  }
});

test("renders the Apache header with the matching comment syntax", () => {
  assert.equal(renderCopyrightHeader("src/app.ts"), `${apache}\n\n`);
  assert.match(renderCopyrightHeader("src/style.css"), /^\/\*\n \* Copyright/);
  assert.match(renderCopyrightHeader("test/page.html"), /^<!--\nCopyright/);
  assert.match(renderCopyrightHeader("scripts/tool.sh"), /^# Copyright/);
});

test("preserves prologues before inserting a header", () => {
  const script = "#!/usr/bin/env node\n// @ts-check\n\nexport {};\n";
  const html = '<?xml version="1.0"?>\n<!doctype html>\n';
  const css = '@charset "utf-8";\nbody {}\n';
  assert.equal(
    script.slice(0, headerInsertionOffset("scripts/tool.mjs", script)),
    "#!/usr/bin/env node\n// @ts-check\n\n",
  );
  assert.equal(
    html.slice(0, headerInsertionOffset("test/page.xhtml", html)),
    '<?xml version="1.0"?>\n',
  );
  assert.equal(css.slice(0, headerInsertionOffset("src/style.css", css)), '@charset "utf-8";\n');
  assert.equal(
    hasCopyrightLicenseHeader(
      "src/style.css",
      `@charset "utf-8";\n${renderCopyrightHeader("src/style.css")}body {}`,
    ),
    true,
  );
});
