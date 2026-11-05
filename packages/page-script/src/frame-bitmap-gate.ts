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

export function createFrameBitmapDeliveryGate(apply: ApplyFrameBitmap): {
  deliver(params: FrameBitmapParams): Promise<FrameBitmapReply>;
  hold(): () => void;
} {
  let holdDepth = 0;
  let pending: PendingDelivery[] = [];

  const flush = () => {
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
      if (holdDepth === 0) return Promise.resolve(apply(params));
      return new Promise((resolve, reject) => pending.push({ params, resolve, reject }));
    },
    hold() {
      holdDepth++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holdDepth--;
        if (holdDepth === 0) flush();
      };
    },
  };
}
