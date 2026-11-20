// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { FrameBitmapParams, FrameBitmapReply } from "@kitesurf/jsrpc-types/page-script";

type ApplyFrameBitmap = (params: FrameBitmapParams) => FrameBitmapReply;

interface PendingDelivery {
  params: FrameBitmapParams;
  resolve: (reply: FrameBitmapReply) => void;
  reject: (error: unknown) => void;
}

export interface FrameBitmapDeliveryGate {
  deliver(params: FrameBitmapParams): Promise<FrameBitmapReply>;
  // Holds deliveries until the returned release runs. A release is idempotent.
  hold(): () => void;
}

// OOPIF bitmaps may only be applied while nothing else holds the paint dom, so a reader that
// spans turns (the PDF stream) holds them and they replay in arrival order on release.
export function createFrameBitmapDeliveryGate(apply: ApplyFrameBitmap): FrameBitmapDeliveryGate {
  let holdCount = 0;
  let pending: PendingDelivery[] = [];

  const flushPending = (): void => {
    const deliveries = pending;
    pending = [];
    for (const delivery of deliveries) {
      try {
        delivery.resolve(apply(delivery.params));
      } catch (error) {
        delivery.reject(error);
      }
    }
  };

  return {
    deliver(params) {
      if (holdCount === 0) return Promise.resolve(apply(params));
      return new Promise((resolve, reject) => pending.push({ params, resolve, reject }));
    },
    hold() {
      holdCount++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holdCount--;
        if (holdCount === 0) flushPending();
      };
    },
  };
}
