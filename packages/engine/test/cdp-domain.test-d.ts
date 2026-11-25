// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Type tests for the CDP domain maps. Nothing runs them: //packages/engine:types fails on any type
// error here, and `vitest --typecheck.only` reports them by name.

import type { Protocol } from "devtools-protocol";
import { assertType, describe, expectTypeOf, test } from "vitest";
import {
  defineDomain,
  stub,
  type CdpDomain,
  type CdpDomainName,
  type CdpHandler,
  type CdpMethodsIn,
} from "../src/cdp/domain.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import {
  RawJsonResult,
  type CdpReplyBody,
  type CdpRequest,
  type CdpRequestOf,
} from "../src/cdp/types.ts";

describe("protocol types", () => {
  test("a command with no result answers exactly {}", () => {
    expectTypeOf<CdpReplyBody<"DOM.enable">>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf<
      CdpReplyBody<"DOM.querySelector">
    >().toEqualTypeOf<Protocol.DOM.QuerySelectorResponse>();
  });

  test("a request carries its method and the protocol's params", () => {
    expectTypeOf<
      CdpRequestOf<"DOM.querySelector">["method"]
    >().toEqualTypeOf<"DOM.querySelector">();
    expectTypeOf<CdpRequestOf<"DOM.querySelector">["params"]>().toEqualTypeOf<
      Protocol.DOM.QuerySelectorRequest | undefined
    >();
  });

  test("a domain's methods are the protocol's methods with its prefix", () => {
    expectTypeOf<"Log.enable">().toExtend<CdpMethodsIn<"Log">>();
    expectTypeOf<"DOM.enable">().not.toExtend<CdpMethodsIn<"Log">>();
    // "DOMStorage" starts with "DOM", but the prefix includes the dot.
    expectTypeOf<"DOMStorage.enable">().not.toExtend<CdpMethodsIn<"DOM">>();
  });
});

describe("handler parameters", () => {
  test("a handler gets the DispatchCtx and its own method's request", () => {
    defineDomain("DOM", {
      methods: {
        "DOM.querySelector": (ctx, req) => {
          expectTypeOf(ctx).toEqualTypeOf<DispatchCtx>();
          expectTypeOf(req).toEqualTypeOf<CdpRequestOf<"DOM.querySelector">>();
          return { nodeId: 0 };
        },
      },
    });
  });

  test("a handler gets the value the domain's context builds", () => {
    defineDomain("Log", {
      context: (ctx, req) => {
        expectTypeOf(req).toEqualTypeOf<CdpRequestOf<CdpMethodsIn<"Log">>>();
        return { ctx, tag: "log" as const };
      },
      methods: {
        "Log.enable": (c) => {
          expectTypeOf(c).toEqualTypeOf<{ ctx: DispatchCtx; tag: "log" }>();
          return {};
        },
      },
    });
  });

  test("an async context gives handlers the resolved value", () => {
    defineDomain("Log", {
      context: async (ctx) => ({ ctx, ready: true }),
      methods: {
        "Log.enable": (c) => {
          expectTypeOf(c).toEqualTypeOf<{ ctx: DispatchCtx; ready: boolean }>();
          return {};
        },
      },
    });
  });

  test("a context takes what the caller passes to run after the request", () => {
    const domain = defineDomain("Log", {
      context: (ctx, _req, retries: number, label?: string) => ({ ctx, retries, label }),
      methods: {
        "Log.enable": (c) => {
          expectTypeOf(c).toEqualTypeOf<{
            ctx: DispatchCtx;
            retries: number;
            label: string | undefined;
          }>();
          return {};
        },
      },
    });
    expectTypeOf(domain).toEqualTypeOf<CdpDomain<[retries: number, label?: string]>>();
    expectTypeOf(domain.run).parameters.toEqualTypeOf<
      [DispatchCtx, CdpRequest, retries: number, label?: string]
    >();
    // @ts-expect-error run must pass the arguments the context takes.
    assertType(domain.run({} as DispatchCtx, {} as CdpRequest));
    // @ts-expect-error retries is a number.
    assertType(domain.run({} as DispatchCtx, {} as CdpRequest, "3"));
  });

  test("a handler reads params as the protocol types them", () => {
    defineDomain("DOM", {
      methods: {
        // @ts-expect-error selector is a string, not a node id.
        "DOM.querySelector": (_c, req) => ({ nodeId: req.params?.selector }),
      },
    });
  });

  test("a handler cannot read a field the context does not have", () => {
    defineDomain("Log", {
      context: (ctx) => ({ ctx }),
      methods: {
        "Log.enable": (c) => {
          // @ts-expect-error the context has no target.
          assertType(c.target);
          return {};
        },
      },
    });
  });
});

describe("handler results", () => {
  test("a result may be the body, raw JSON of the body, or a promise of either", () => {
    type Handler = CdpHandler<"DOM.getOuterHTML", unknown>;
    const raw = new RawJsonResult<Protocol.DOM.GetOuterHTMLResponse>(['{"outerHTML":""}']);
    assertType<Handler>(() => ({ outerHTML: "" }));
    assertType<Handler>(async () => ({ outerHTML: "" }));
    assertType<Handler>(() => raw);
    assertType<Handler>(async () => raw);
  });

  test("raw JSON built elsewhere must name the shape it encodes", () => {
    type Handler = CdpHandler<"DOM.getOuterHTML", unknown>;
    const untyped = new RawJsonResult(['{"outerHTML":""}']);
    // @ts-expect-error raw JSON of an unknown shape.
    assertType<Handler>(() => untyped);
    // @ts-expect-error raw JSON of another method's result.
    assertType<Handler>(() => new RawJsonResult<Protocol.DOM.QuerySelectorResponse>([]));
  });

  test("known gap: raw JSON built in the return takes the method's result shape", () => {
    // The constructor infers its shape from the handler's expected result, so nothing checks the
    // pieces. Only the code that writes them knows what they encode.
    assertType<CdpHandler<"DOM.getOuterHTML", unknown>>(() => new RawJsonResult(["{}"]));
  });

  test("a missing or mistyped result field does not compile", () => {
    // @ts-expect-error DOM.getDocument must answer a root.
    defineDomain("DOM", { methods: { "DOM.getDocument": () => ({}) } });
    // @ts-expect-error DOM.querySelector answers nodeId, not nodeIds.
    defineDomain("DOM", { methods: { "DOM.querySelector": () => ({ nodeIds: [1] }) } });
    // @ts-expect-error nodeId is a number.
    defineDomain("DOM", { methods: { "DOM.querySelector": () => ({ nodeId: "1" }) } });
    // @ts-expect-error the promise resolves to the wrong shape.
    defineDomain("DOM", { methods: { "DOM.querySelector": async () => ({ nodeIds: [1] }) } });
  });

  test("a command with no result answers {} and nothing else", () => {
    defineDomain("DOM", { methods: { "DOM.enable": () => ({}) } });
    // @ts-expect-error a field on a command with no result.
    defineDomain("DOM", { methods: { "DOM.enable": () => ({ enabled: true }) } });
  });

  test("known gap: an extra field on a result compiles", () => {
    // TypeScript does not check an arrow's returned literal for excess properties. If it starts
    // to, this line fails and the gap note on CdpDomainMethods can go.
    defineDomain("DOM", { methods: { "DOM.querySelector": () => ({ nodeId: 1, nodeIds: [1] }) } });
  });
});

describe("stubs", () => {
  test("a stub fits only a method with no result", () => {
    expectTypeOf(stub).toExtend<CdpHandler<"DOM.enable", unknown>>();
    expectTypeOf(stub).not.toExtend<CdpHandler<"DOM.getDocument", unknown>>();
    defineDomain("DOM", { methods: { "DOM.undo": stub } });
    // @ts-expect-error DOM.getDocument has a result, so a stub cannot answer it.
    defineDomain("DOM", { methods: { "DOM.getDocument": stub } });
  });
});

describe("method keys", () => {
  test("a key must be a method of the domain", () => {
    // @ts-expect-error no such method.
    defineDomain("DOM", { methods: { "DOM.enabel": stub } });
    // @ts-expect-error DOM.enable is not a Log method.
    defineDomain("Log", { methods: { "DOM.enable": stub } });
  });

  test("the name must be a domain the protocol defines", () => {
    expectTypeOf<"DOM">().toExtend<CdpDomainName>();
    expectTypeOf<"Kitesurf">().toExtend<CdpDomainName>();
    // @ts-expect-error a misspelled domain.
    defineDomain("Lgo", { methods: {} });
    const name: string = "Log";
    // @ts-expect-error a name TypeScript cannot pin to one domain would accept any method.
    defineDomain(name, { methods: { "DOM.enable": stub } });
  });

  test("the domain comes from the name, not from the methods", () => {
    const methods = { "DOM.enable": stub };
    // @ts-expect-error passing another domain's map through a variable does not widen the domain.
    defineDomain("Log", { methods });
  });

  test("a method appears at most once", () => {
    // @ts-expect-error a duplicate key.
    defineDomain("Log", { methods: { "Log.enable": stub, "Log.enable": stub } });
  });
});

describe("the defined domain", () => {
  test("run takes any request and erases the result type", () => {
    const domain = defineDomain("Log", { methods: {} });
    expectTypeOf(domain).toEqualTypeOf<CdpDomain>();
    expectTypeOf(domain.run).parameters.toEqualTypeOf<[DispatchCtx, CdpRequest]>();
    expectTypeOf(domain.run).returns.toEqualTypeOf<Promise<unknown>>();
  });
});
