// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { nextRouteChunkUrls, parseBuildManifest } from "../src/eval/next-route-chunks.ts";
import type { ParentScriptDescriptor } from "../src/wasm.ts";

const MANIFEST = `self.__BUILD_MANIFEST=function(a,c,x,n){return{__rewrites:{afterFiles:[],beforeFiles:[],fallback:[]},__routerFilterStatic:{numItems:0,errorRate:1e-4,numBits:0,numHashes:n,bitArray:[]},"/":[a,c,"static/chunks/pages/index-1.js"],"/input":[a,c,x,"static/chunks/pages/input-2.js"],"/pro":[a,"static/chunks/pages/pro-3.js"],"/w/[slug]":[a,"static/chunks/pages/w/[slug]-4.js"],"/_error":[a,"static/chunks/pages/_error-5.js"],sortedPages:["/","/_app"]}}("static/chunks/shared-a.js","static/chunks/shared-c.js","static/chunks/9764-x.js",7),self.__BUILD_MANIFEST_CB&&self.__BUILD_MANIFEST_CB();`;

const ext = (src: string, body: string): ParentScriptDescriptor => ({
  src,
  kind: "classic",
  defer: true,
  async: false,
  body: "",
  prefetchedSource: body,
});

describe("next route chunks", () => {
  it("resolves shared-chunk parameters and dynamic route paths", () => {
    const routes = parseBuildManifest(MANIFEST)!;
    expect(routes.get("/input")).toEqual([
      "static/chunks/shared-a.js",
      "static/chunks/shared-c.js",
      "static/chunks/9764-x.js",
      "static/chunks/pages/input-2.js",
    ]);
    expect(routes.get("/w/[slug]")).toEqual([
      "static/chunks/shared-a.js",
      "static/chunks/pages/w/[slug]-4.js",
    ]);
    expect(parseBuildManifest("var x = 1;")).toBeNull();
  });

  it("bakes the not-yet-loaded chunks of the routes the page's chunks mention most", () => {
    const page = "https://h.test/";
    const urls = nextRouteChunkUrls(
      [
        ext("/_next/static/chunks/shared-a.js", ""),
        ext("/_next/static/chunks/shared-c.js", ""),
        ext(
          "/_next/static/chunks/pages/index-1.js",
          `router.push("/input?i="+q);link("/input");go('/pro')`,
        ),
        ext("/_next/static/BUILD/_buildManifest.js", MANIFEST),
      ],
      page,
    );
    expect(urls).toEqual([
      "https://h.test/_next/static/chunks/9764-x.js",
      "https://h.test/_next/static/chunks/pages/input-2.js",
      "https://h.test/_next/static/chunks/pages/pro-3.js",
    ]);
    expect(nextRouteChunkUrls([ext("/app.js", "go('/input')")], page)).toEqual([]);
  });

  it("builds the URL Next inserts for a dynamic route on a dpl deployment", () => {
    const urls = nextRouteChunkUrls(
      [
        ext("/_next/static/chunks/shared-a.js?dpl=dpl_1", ""),
        ext(
          "/_next/static/chunks/pages/index-1.js?dpl=dpl_1",
          `router.push({pathname:"/w/[slug]",query:q})`,
        ),
        ext("/_next/static/BUILD/_buildManifest.js?dpl=dpl_1", MANIFEST),
      ],
      "https://h.test/",
    );
    expect(urls).toEqual(["https://h.test/_next/static/chunks/pages/w/%5Bslug%5D-4.js?dpl=dpl_1"]);
  });
});
