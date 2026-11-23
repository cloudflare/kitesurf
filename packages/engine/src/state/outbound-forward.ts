// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A loaded worker's outbound traffic goes to a ctx.exports.SandboxOutbound loopback, which runs
// outside a stateful session's Durable Object: in another isolate, whose registries are empty, or
// in another I/O context, where DO SQLite throws. So the loopback hands a stateful session's
// request back to its object, which runs the same policy there (StatefulBrowser.fetch).

import { z } from "zod";
import type { OutboundProps } from "../eval/outbound.ts";
import type { StatefulBrowser } from "../stateful.ts";

// Written only by forwardToStatefulSession. The front door strips it from client requests.
export const OUTBOUND_FORWARD_HEADER = "x-kitesurf-stateful-outbound";

// The plain-data props the header carries: every key of OutboundProps but the stubs, so a field
// added to OutboundProps fails to compile here instead of being dropped on the way.
type ForwardedProps = Omit<OutboundProps, "externalOutbound" | "egress">;
const forwardedPropsShape = {
  pageOrigin: z.string(),
  cookieSiteOrigin: z.string().optional(),
  privateNetworkInitiator: z.string().optional(),
  engineIsolateId: z.string().optional(),
  localTraceParent: z
    .object({
      traceId: z.string(),
      spanId: z.string(),
      parentSpanId: z.string(),
      traceFlags: z.number(),
    })
    .optional(),
  mainFrameId: z.string().optional(),
  mainLoaderId: z.string().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  pageUrl: z.string().optional(),
  referrerPolicy: z.string().optional(),
  connectionId: z.string().optional(),
  statefulSessionId: z.string().optional(),
  interceptConnectionId: z.string().optional(),
  cookieKey: z.string().optional(),
  allowDocumentBypass: z.boolean().optional(),
  skipRequestBlocker: z.boolean().optional(),
  topLevelDocument: z.boolean().optional(),
  walksOwnRedirects: z.boolean().optional(),
  pixelFree: z.boolean().optional(),
  pageRealm: z.boolean().optional(),
} satisfies Record<keyof ForwardedProps, z.ZodType>;
const forwardedPropsSchema = z.object(forwardedPropsShape) satisfies z.ZodType<ForwardedProps>;

/** The StatefulBrowser namespace in `exports`, or null when the deploy does not declare it. */
export function statefulNamespace(exports: object): DurableObjectNamespace<StatefulBrowser> | null {
  const exported: unknown = Reflect.get(exports, "StatefulBrowser");
  return isStatefulNamespace(exported) ? exported : null;
}

// A ctx.exports entry is a callable loopback, and also a namespace when the class is a declared
// Durable Object.
function isStatefulNamespace(value: unknown): value is DurableObjectNamespace<StatefulBrowser> {
  return (
    (typeof value === "function" || (typeof value === "object" && value !== null)) &&
    typeof Reflect.get(value, "idFromString") === "function"
  );
}

/** Forwards `request` to the stateful session named in `props`, or null for a stateless one. */
export function forwardToStatefulSession(
  exports: object,
  props: OutboundProps | undefined,
  request: Request,
): Promise<Response> | null {
  const id = props?.statefulSessionId;
  if (!id) return null;
  const ns = statefulNamespace(exports);
  if (!ns) return null;
  const { externalOutbound: _external, egress: _egress, ...plain } = props;
  const headers = new Headers(request.headers);
  // Percent-encoded: a header value must be Latin-1, and the props carry page-chosen strings.
  headers.set(OUTBOUND_FORWARD_HEADER, encodeURIComponent(JSON.stringify(plain)));
  return ns.get(ns.idFromString(id)).fetch(new Request(request, { headers }));
}

/**
 * The props and the original request of a forwarded call: null when `request` is not one, and
 * "invalid" when the header does not parse.
 */
export function readForwardedOutbound(
  request: Request,
): { props: OutboundProps; request: Request } | "invalid" | null {
  const raw = request.headers.get(OUTBOUND_FORWARD_HEADER);
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(decodeURIComponent(raw));
  } catch (err) {
    json = err;
  }
  const parsed = forwardedPropsSchema.safeParse(json);
  if (!parsed.success) {
    // Only forwardToStatefulSession writes the header, so a bad one is an engine bug.
    console.warn(
      JSON.stringify({
        event: "stateful_outbound_forward_invalid",
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
      }),
    );
    return "invalid";
  }
  const headers = new Headers(request.headers);
  headers.delete(OUTBOUND_FORWARD_HEADER);
  return { props: parsed.data, request: new Request(request, { headers }) };
}
