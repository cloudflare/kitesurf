// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

declare module "*.wasm" {
  const value: WebAssembly.Module;
  export default value;
}

declare module "*.glue.js" {
  const value: string;
  export default value;
}
