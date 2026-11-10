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
  readonly cookieHeaderFor?: (url: string, method: "GET" | "POST") => string | null | undefined;
  readonly onSetCookie?: (url: string, resp: Response) => void;
  readonly onRedirect?: (hop: RedirectHop) => void;
  // Vets each redirect target before it is fetched: the url to fetch (an upgraded one, say), or
  // null to stop the walk with "redirect-blocked".
  readonly checkRedirect?: (url: string) => Promise<string | null>;
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
  | { readonly ok: false; readonly reason: "too-many-redirects" }
  | { readonly ok: false; readonly reason: "redirect-blocked"; readonly url: string };

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
export async function walkRedirects(opts: RedirectWalkOptions): Promise<RedirectWalkResult> {
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS;
  const headers: Record<string, string> = { ...opts.headers };
  let currentUrl = opts.url;
  let method: "GET" | "POST" = opts.method ?? "GET";
  let body = opts.body;
  let hops = 0;
  let originTainted = false;
  let callerCookie = firstHeader(headers, "cookie");

  for (;;) {
    opts.signal?.throwIfAborted?.();

    if (opts.cookieHeaderFor) {
      const cookie = opts.cookieHeaderFor(currentUrl, method);
      deleteHeader(headers, "cookie");
      if (cookie) headers.cookie = cookie;
      else if (callerCookie !== undefined) headers.cookie = callerCookie;
    }

    const sentHeaders = { ...headers };
    const resp = await opts.fetchHop(
      new Request(currentUrl, {
        method,
        body,
        redirect: "manual",
        signal: opts.signal,
        headers: sentHeaders,
      }),
    );

    const location = resp.headers.get("location");
    if (!REDIRECT_STATUSES.has(resp.status) || !location) {
      return {
        ok: true,
        response: resp,
        finalUrl: currentUrl,
        hops,
        referrer: firstHeader(sentHeaders, "referer") ?? "",
      };
    }

    // The walk never returns a redirect's body, whether it follows the hop or stops here.
    void resp.body?.cancel().catch(() => {});

    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      throw new InvalidRedirectError(location, "unparseable");
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new InvalidRedirectError(location, "non-http scheme");
    }

    if (hops + 1 > maxHops) return { ok: false, reason: "too-many-redirects" };
    hops += 1;

    // Store this hop's cookies before the next loop reads its jar header.
    opts.onSetCookie?.(currentUrl, resp);

    if (opts.checkRedirect) {
      const allowed = await opts.checkRedirect(next.toString());
      if (allowed === null) return { ok: false, reason: "redirect-blocked", url: next.toString() };
      next = new URL(allowed);
    }

    const fromOrigin = originOfUrl(currentUrl);
    const crossOriginHop = fromOrigin === null || next.origin !== fromOrigin;
    if (crossOriginHop) {
      deleteHeader(headers, "authorization");
      // Do not reuse the entry URL's caller Cookie as fallback after this origin change.
      callerCookie = undefined;
      if (hasHeader(headers, "sec-fetch-site")) {
        deleteHeader(headers, "sec-fetch-site");
        headers["sec-fetch-site"] = "cross-site";
      }
      const referer = firstHeader(headers, "referer");
      if (referer !== undefined) {
        const refOrigin = originOfUrl(referer);
        deleteHeader(headers, "referer");
        if (refOrigin !== null && refOrigin !== "null") {
          headers["referer"] = refOrigin + "/";
        }
      }
    }

    // Keep the initiator Origin until a cross-origin hop leaves a URL whose origin already
    // differs from it; once tainted, keep Origin null even if the chain returns.
    if (opts.taintOriginFrom !== undefined) {
      if (!originTainted && crossOriginHop && opts.taintOriginFrom !== fromOrigin) {
        originTainted = true;
      }
      if (originTainted) {
        deleteHeader(headers, "origin");
        deleteHeader(headers, "x-kitesurf-page-origin");
        headers["origin"] = "null";
        headers["x-kitesurf-page-origin"] = "null";
      }
    }

    if (method === "POST" && resp.status !== 307 && resp.status !== 308) {
      method = "GET";
      body = undefined;
      for (const name of [
        "content-encoding",
        "content-language",
        "content-length",
        "content-location",
        "content-type",
      ]) {
        deleteHeader(headers, name);
      }
    }

    const nextUrl = next.toString();
    opts.onRedirect?.({
      newUrl: nextUrl,
      method,
      headers: sentHeaders,
      status: resp.status,
      statusText: resp.statusText,
      responseHeaders: resp.headers,
      fromUrl: currentUrl,
    });
    currentUrl = nextUrl;
  }
}
