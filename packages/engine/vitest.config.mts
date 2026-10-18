// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "wrangler-text-modules",
      enforce: "pre",
      transform(code: string, id: string) {
        if (id.endsWith(".html")) {
          return {
            code: `export default ${JSON.stringify(code)};`,
            map: null,
          };
        }
      },
    },
    {
      name: "wrangler-wasm-and-glue-modules",
      enforce: "pre",
      load(id: string) {
        if (id.endsWith(".wasm")) return "export default {};";
      },
      transform(code: string, id: string) {
        if (id.endsWith(".glue.js")) {
          return { code: `export default ${JSON.stringify(code)};`, map: null };
        }
      },
    },
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-09-11",
        modulesRules: [{ type: "Text", include: ["*.css", "**/*.css"] }],
        workerLoaders: { LOADER: {} },
      },
    }),
  ],
  test: {
    include: ["test/*.test.ts"],
  },
});
