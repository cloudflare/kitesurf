// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Where a page's PageScript generations run when a host gives the session a page host: each page
// is a Durable Object facet named by its target id, from the same loaded code. A navigate aborts
// the running facet, and the next facets.get() starts the new generation under the same name.
// The facet's database outlives the abort; closing the page deletes it.

import type { PageScriptFacetEntrypoint } from "@kitesurf/jsrpc-types/page-script";
import type { RpcSessionEntrypoint } from "./page-script-rpc-session.ts";

export interface PageScriptHost {
  /** The entrypoint of a new generation of page `targetId`. Retires the running one first. */
  entrypoint(
    targetId: string,
    worker: WorkerStub,
    options: { props: Record<string, unknown>; limits: workerdResourceLimits },
  ): RpcSessionEntrypoint;
  /** The page closed: retire it and delete its storage. */
  deletePage(targetId: string): void;
  /** Retire every page and delete its storage. */
  retireAll(reason: string): void;
  /** The database of each running page, by target id. */
  storageStats(): Promise<Record<string, PageStorageStats>>;
}

/** A page facet's database. */
export interface PageStorageStats {
  // The size of the database file.
  bytes: number;
}

/** The part of a Durable Object's `ctx.facets` the host uses. */
export type PageFacets = Pick<DurableObjectFacets, "get" | "abort" | "delete">;

// abortIsolate() inside a facet rejects the call but leaves the facet serving, so only the parent
// retires a generation, with facets.abort.
export function facetPageScriptHost(facets: PageFacets): PageScriptHost {
  // Pages whose facet storage exists, and the incarnation that runs each page now.
  const pages = new Set<string>();
  const running = new Map<string, number>();
  // The running facet of each page. Asking a page that is not running would start it.
  const stubs = new Map<string, Fetcher<PageScriptFacetEntrypoint>>();
  let incarnations = 0;

  const abort = (targetId: string, reason: string): void => {
    stubs.delete(targetId);
    if (!running.delete(targetId)) return;
    try {
      facets.abort(targetId, new Error(`kitesurf: ${reason}`));
    } catch {
      // The facet never started, or it is gone.
    }
  };

  const remove = (targetId: string, reason: string): void => {
    abort(targetId, reason);
    if (!pages.delete(targetId)) return;
    try {
      facets.delete(targetId);
    } catch {
      // Already gone.
    }
  };

  return {
    entrypoint(targetId, worker, options) {
      // facets.get() returns the running facet if there is one, with the old generation's code.
      abort(targetId, "superseded by a new generation");
      const incarnation = ++incarnations;
      running.set(targetId, incarnation);
      pages.add(targetId);
      const stub = facets.get<PageScriptFacetEntrypoint>(targetId, () => ({
        class: worker.getDurableObjectClass<PageScriptFacetEntrypoint>("PageScriptFacet", options),
      }));
      stubs.set(targetId, stub);
      // SAFETY: the facet runs PageScript's methods, so it keeps the entrypoint's JSRPC contract;
      // Rpc.Provider loses the reply correlation, as for the loaded worker's entrypoint.
      const entry = stub as RpcSessionEntrypoint;
      return {
        openSession: (init) => entry.openSession(init),
        killIsolate: (reason) => {
          // A generation's kill can arrive after its successor started under the same name.
          if (running.get(targetId) === incarnation) {
            abort(targetId, reason ?? "generation retired");
          }
          return Promise.resolve();
        },
      };
    },
    deletePage(targetId) {
      remove(targetId, "page closed");
    },
    retireAll(reason) {
      for (const targetId of Array.from(pages)) remove(targetId, reason);
    },
    async storageStats() {
      const out: Record<string, PageStorageStats> = {};
      await Promise.all(
        Array.from(stubs, async ([targetId, stub]) => {
          try {
            out[targetId] = await stub.storageStats();
          } catch {
            // The page is retiring.
          }
        }),
      );
      return out;
    },
  };
}
