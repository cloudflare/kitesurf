// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, test } from "vitest";
import {
  classifyRequest,
  getRequestBlocker,
  parseResourceType,
  registerRequestBlocker,
  unregisterRequestBlocker,
  type BlockableRequest,
  type RequestBlocker,
} from "../src/request-blocker.ts";

function recordingBlocker(): { blocker: RequestBlocker; seen: BlockableRequest[] } {
  const seen: BlockableRequest[] = [];
  return {
    seen,
    blocker: {
      classify(request) {
        seen.push(request);
        return request.url.hostname === "tracker.example"
          ? { matched: "tracker.example", reason: "request blocklist matched (tracker.example)" }
          : null;
      },
    },
  };
}

describe("classifyRequest", () => {
  test("passes normalized request facts to the host blocker", () => {
    const { blocker, seen } = recordingBlocker();
    const verdict = classifyRequest(
      blocker,
      "https://Tracker.Example./a.js",
      "WWW.Site.Example.",
      "Script",
    );
    expect(verdict).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.pageHost).toBe("www.site.example");
    expect(seen[0]?.thirdParty).toBe(true);
    expect(seen[0]?.resourceType).toBe("Script");
    expect(
      classifyRequest(blocker, "https://tracker.example/a.js", "site.example", "Image"),
    ).toEqual({
      matched: "tracker.example",
      reason: "request blocklist matched (tracker.example)",
    });
  });

  test("marks same-site requests as first party and opaque pages as third party", () => {
    const { blocker, seen } = recordingBlocker();
    classifyRequest(blocker, "https://cdn.site.example/x.js", "www.site.example", "Script");
    classifyRequest(blocker, "https://cdn.site.co.uk/x.js", "www.site.co.uk", "Script");
    classifyRequest(blocker, "https://cdn.site.example/x.js", "", "Script");
    expect(seen.map((r) => r.thirdParty)).toEqual([false, false, true]);
  });

  test("never blocks without a blocker, for non-http schemes or unparseable URLs", () => {
    const { blocker, seen } = recordingBlocker();
    expect(
      classifyRequest(undefined, "https://tracker.example/", "site.example", "Script"),
    ).toBeNull();
    expect(classifyRequest(blocker, "data:text/plain,hi", "site.example", "Script")).toBeNull();
    expect(
      classifyRequest(blocker, "blob:https://tracker.example/1", "site.example", "Script"),
    ).toBeNull();
    expect(classifyRequest(blocker, "not a url", "site.example", "Script")).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe("request blocker registry", () => {
  test("scopes blockers to their connection", () => {
    const { blocker } = recordingBlocker();
    registerRequestBlocker("conn-a", blocker);
    expect(getRequestBlocker("conn-a")).toBe(blocker);
    expect(getRequestBlocker("conn-b")).toBeUndefined();
    unregisterRequestBlocker("conn-a");
    expect(getRequestBlocker("conn-a")).toBeUndefined();
  });
});

test("parseResourceType accepts CDP names and maps anything else to Other", () => {
  expect(parseResourceType("Fetch")).toBe("Fetch");
  expect(parseResourceType("Document")).toBe("Document");
  expect(parseResourceType("fetch")).toBe("Other");
  expect(parseResourceType("")).toBe("Other");
  expect(parseResourceType(null)).toBe("Other");
});
