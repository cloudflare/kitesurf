// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Follows HTTP redirects manually so each hop can apply cookie and request policy.

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const MAX_REDIRECT_HOPS = 20;

export interface RedirectHop {
  readonly newUrl: string;
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly status: number;
  readonly statusText: string;
  readonly responseHeaders: Response["headers"];
  readonly fromUrl: string;
}

export interface RedirectWalkOptions {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly body?: Uint8Array | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetchHop: (req: Request) => Promise<Response>;
  readonly signal?: AbortSignal | undefined;
  readonly maxHops?: number;
  readonly cookieHeaderFor?: (url: string) => string | null | undefined;
  readonly onSetCookie?: (url: string, resp: Response) => void;
  readonly onRedirect?: (hop: RedirectHop) => void;
  readonly taintOriginFrom?: string;
}

export type RedirectWalkResult =
  | {
      readonly ok: true;
      readonly response: Response;
      readonly finalUrl: string;
      readonly hops: number;
      /**
       * Terminal-hop Referer after cross-origin downgrade, or ""; this becomes
       * `document.referrer`.
       */
      readonly referrer: string;
    }
  | { readonly ok: false; readonly reason: "too-many-redirects" };

export class InvalidRedirectError extends Error {
  constructor(location: string, reason: string) {
    super(`kitesurf: invalid redirect Location (${reason}): ${location}`);
    this.name = "InvalidRedirectError";
  }
}

function originOfUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

function firstHeader(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v;
  }
  return undefined;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) delete headers[key];
  }
}

/**
 * Follows each redirect through `fetchHop`, applying cookie and redirect callbacks per hop.
 * Invalid locations throw `InvalidRedirectError`; exceeding `maxHops` returns `ok: false`.
 */
interface RedirectWalkState {
  headers: Record<string, string>;
  currentUrl: string;
  method: "GET" | "POST";
  body: Uint8Array | undefined;
  hops: number;
  originTainted: boolean;
  callerCookie: string | undefined;
}

type RedirectWalkStep = { kind: "continue" } | { kind: "done"; result: RedirectWalkResult };

interface RedirectRequestResult {
  response: Response;
  sentHeaders: Record<string, string>;
}

function createRedirectWalkState(opts: RedirectWalkOptions): RedirectWalkState {
  const headers = { ...opts.headers };
  return {
    headers,
    currentUrl: opts.url,
    method: opts.method ?? "GET",
    body: opts.body,
    hops: 0,
    originTainted: false,
    callerCookie: firstHeader(headers, "cookie"),
  };
}

function applyRedirectCookie(opts: RedirectWalkOptions, state: RedirectWalkState): void {
  if (!opts.cookieHeaderFor) return;
  const cookie = opts.cookieHeaderFor(state.currentUrl);
  deleteHeader(state.headers, "cookie");
  if (cookie) state.headers.cookie = cookie;
  else if (state.callerCookie !== undefined) state.headers.cookie = state.callerCookie;
}

async function fetchRedirectRequest(
  opts: RedirectWalkOptions,
  state: RedirectWalkState,
): Promise<RedirectRequestResult> {
  opts.signal?.throwIfAborted?.();
  applyRedirectCookie(opts, state);
  const sentHeaders = { ...state.headers };
  const response = await opts.fetchHop(
    new Request(state.currentUrl, {
      method: state.method,
      body: state.body,
      redirect: "manual",
      signal: opts.signal,
      headers: sentHeaders,
    }),
  );
  return { response, sentHeaders };
}

function redirectLocation(response: Response): string | null {
  const location = response.headers.get("location");
  if (!REDIRECT_STATUSES.has(response.status) || !location) return null;
  return location;
}

function finalRedirectResult(
  state: RedirectWalkState,
  response: Response,
  sentHeaders: Record<string, string>,
): RedirectWalkStep {
  return {
    kind: "done",
    result: {
      ok: true,
      response,
      finalUrl: state.currentUrl,
      hops: state.hops,
      referrer: firstHeader(sentHeaders, "referer") ?? "",
    },
  };
}

function parseRedirectTarget(location: string, currentUrl: string): URL {
  let next: URL;
  try {
    next = new URL(location, currentUrl);
  } catch {
    throw new InvalidRedirectError(location, "unparseable");
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new InvalidRedirectError(location, "non-http scheme");
  }
  return next;
}

function downgradeSecFetchSite(headers: Record<string, string>): void {
  if (!hasHeader(headers, "sec-fetch-site")) return;
  deleteHeader(headers, "sec-fetch-site");
  headers["sec-fetch-site"] = "cross-site";
}

function downgradeReferer(headers: Record<string, string>): void {
  const referer = firstHeader(headers, "referer");
  if (referer === undefined) return;
  const refOrigin = originOfUrl(referer);
  deleteHeader(headers, "referer");
  if (refOrigin !== null && refOrigin !== "null") {
    headers.referer = refOrigin + "/";
  }
}

function applyCrossOriginHeaders(
  headers: Record<string, string>,
  state: RedirectWalkState,
  next: URL,
  fromOrigin: string | null,
): boolean {
  const crossOriginHop = fromOrigin === null || next.origin !== fromOrigin;
  if (!crossOriginHop) return false;
  deleteHeader(headers, "authorization");
  // Do not reuse the entry URL's caller Cookie as fallback after this origin change.
  state.callerCookie = undefined;
  downgradeSecFetchSite(headers);
  downgradeReferer(headers);
  return true;
}

function shouldTaintRedirectOrigin(
  taintOriginFrom: string | undefined,
  state: RedirectWalkState,
  crossOriginHop: boolean,
  fromOrigin: string | null,
): boolean {
  return (
    taintOriginFrom !== undefined &&
    !state.originTainted &&
    crossOriginHop &&
    taintOriginFrom !== fromOrigin
  );
}

function taintRedirectOrigin(
  opts: RedirectWalkOptions,
  state: RedirectWalkState,
  crossOriginHop: boolean,
  fromOrigin: string | null,
): void {
  if (opts.taintOriginFrom === undefined) return;
  if (shouldTaintRedirectOrigin(opts.taintOriginFrom, state, crossOriginHop, fromOrigin)) {
    state.originTainted = true;
  }
  if (!state.originTainted) return;
  deleteHeader(state.headers, "origin");
  deleteHeader(state.headers, "x-kitesurf-page-origin");
  state.headers.origin = "null";
  state.headers["x-kitesurf-page-origin"] = "null";
}

function rewritePostRedirect(state: RedirectWalkState, response: Response): void {
  if (state.method !== "POST" || response.status === 307 || response.status === 308) {
    return;
  }
  state.method = "GET";
  state.body = undefined;
  for (const name of [
    "content-encoding",
    "content-language",
    "content-length",
    "content-location",
    "content-type",
  ]) {
    deleteHeader(state.headers, name);
  }
}

function tooManyRedirects(): RedirectWalkStep {
  return { kind: "done", result: { ok: false, reason: "too-many-redirects" } };
}

async function walkRedirectStep(
  opts: RedirectWalkOptions,
  state: RedirectWalkState,
  maxHops: number,
): Promise<RedirectWalkStep> {
  const { response, sentHeaders } = await fetchRedirectRequest(opts, state);
  const location = redirectLocation(response);
  if (location === null) return finalRedirectResult(state, response, sentHeaders);
  const fromUrl = state.currentUrl;
  const next = parseRedirectTarget(location, fromUrl);
  if (state.hops + 1 > maxHops) return tooManyRedirects();
  state.hops++;

  // Store this hop's cookies before the next loop reads its jar header.
  opts.onSetCookie?.(fromUrl, response);

  const fromOrigin = originOfUrl(fromUrl);
  const crossOriginHop = applyCrossOriginHeaders(state.headers, state, next, fromOrigin);
  taintRedirectOrigin(opts, state, crossOriginHop, fromOrigin);
  rewritePostRedirect(state, response);

  const nextUrl = next.toString();
  opts.onRedirect?.({
    newUrl: nextUrl,
    method: state.method,
    headers: sentHeaders,
    status: response.status,
    statusText: response.statusText,
    responseHeaders: response.headers,
    fromUrl,
  });
  state.currentUrl = nextUrl;
  return { kind: "continue" };
}

/**
 * Follows each redirect through `fetchHop`, applying cookie and redirect callbacks per hop.
 * Invalid locations throw `InvalidRedirectError`; exceeding `maxHops` returns `ok: false`.
 */
export async function walkRedirects(opts: RedirectWalkOptions): Promise<RedirectWalkResult> {
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS;
  const state = createRedirectWalkState(opts);
  for (;;) {
    const step = await walkRedirectStep(opts, state, maxHops);
    if (step.kind === "done") return step.result;
  }
}
