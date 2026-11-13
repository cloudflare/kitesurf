// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { registerDispatchConsumer, serializeCdpPayload } from "../src/cdp/connection.ts";
import { RawJsonResult, type CdpRequest, type CdpResponse } from "../src/cdp/types.ts";

describe("raw JSON CDP results", () => {
  // Both sides of the comparison share this shape, so their key order matches.
  const envelope = (id: number, sessionId: string | undefined, result: unknown) => ({
    id,
    result,
    ...(sessionId === undefined ? {} : { sessionId }),
  });

  it("matches JSON.stringify of the parsed envelope for tested IDs and sessions", () => {
    const pieces = ['{"nodes":[{"nodeId":"1","name":{"value":"café 😀"}}]}'];
    const parsed: unknown = JSON.parse(pieces.join(""));

    for (const [id, sessionId] of [
      [1, undefined],
      [-1, "session-raw-json"],
      [42, "session-test"],
    ] as const) {
      expect(serializeCdpPayload(envelope(id, sessionId, new RawJsonResult(pieces)))).toBe(
        JSON.stringify(envelope(id, sessionId, parsed)),
      );
    }
  });

  it("gives Accessibility onDispatch consumers a parsed plain object", async () => {
    const request = {
      id: 7,
      method: "Accessibility.getFullAXTree",
    } satisfies CdpRequest;
    const pieces = ['{"nodes":[{"nodeId":"1"}]}'];
    let registeredDispatch: ((request: CdpRequest) => Promise<CdpResponse>) | undefined;
    registerDispatchConsumer(
      (dispatch) => {
        registeredDispatch = dispatch;
      },
      async (dispatched) => {
        expect(dispatched.method).toBe("Accessibility.getFullAXTree");
        return { id: dispatched.id, result: new RawJsonResult(pieces) };
      },
    );
    if (!registeredDispatch) throw new Error("onDispatch consumer was not registered");

    const response = await registeredDispatch(request);
    if (!("result" in response)) throw new Error("Accessibility dispatch returned a CDP error");
    const result: unknown = response.result;
    expect(result).toEqual({ nodes: [{ nodeId: "1" }] });
    expect(result).not.toBeInstanceOf(RawJsonResult);
    if (typeof result !== "object" || result === null) {
      throw new Error("Accessibility result was not an object");
    }
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("preserves escaped lone surrogates in the raw Accessibility frame", () => {
    const payload = {
      id: 9,
      result: new RawJsonResult(['{"nodes":[{"value":"a\\ud800b"}]}']),
    };

    expect(serializeCdpPayload(payload)).toBe(
      '{"id":9,"result":{"nodes":[{"value":"a\\ud800b"}]}}',
    );
  });
});
