// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "vitest";
import { upgradedSocket } from "./connect";
import { engine } from "./harness";

test("retired terminal and binary scene endpoints return 404", async () => {
  for (const path of ["/tui", "/tui?wire=rbi", "/tui/", "/rbi/ws"]) {
    const url = `https://ks.invalid${path}`;
    expect((await engine.fetch(url)).status).toBe(404);
    expect(
      (
        await engine.fetch(url, {
          headers: { Upgrade: "websocket" },
        })
      ).status,
    ).toBe(404);
  }
});

test("RBI only serves CLI scene-host and font assets", async () => {
  for (const path of [
    "/rbi",
    "/rbi/",
    "/rbi/index.html",
    "/rbi/scene_client.js",
    "/rbi/scene_client_bg.wasm",
  ]) {
    expect((await engine.fetch(`https://ks.invalid${path}`)).status, path).toBe(404);
  }
  const manifest = await engine.fetch("https://ks.invalid/rbi/scene_host.json");
  expect(manifest.status).toBe(200);
  const data: unknown = await manifest.json();
  if (!data || typeof data !== "object" || !("wasm" in data) || typeof data.wasm !== "string") {
    throw new Error("invalid scene host manifest");
  }
  expect(data.wasm).toBe("scene_host.wasm");
  const wasm = await engine.fetch("https://ks.invalid/rbi/scene_host.wasm");
  expect(wasm.status).toBe(200);
  expect(wasm.headers.get("content-type")).toBe("application/wasm");
  const font = await engine.fetch("https://ks.invalid/rbi/fonts/NotoSans.ttf");
  expect(font.status).toBe(200);
});

test("scene stream rejects malformed CDP parameters and the retired splash command", async () => {
  const response = await engine.fetch("https://ks.invalid/devtools/browser", {
    headers: { Upgrade: "websocket" },
  });
  const ws = upgradedSocket(response);
  if (!ws) throw new Error(`CDP upgrade failed: ${response.status}`);
  ws.accept();
  let id = 0;
  const send = (params: Record<string, unknown>, method = "Kitesurf.startSceneStream") =>
    new Promise<{ error?: unknown }>((resolve) => {
      const requestId = ++id;
      const onMessage = (event: { data: string | ArrayBuffer }) => {
        if (typeof event.data !== "string") return;
        const reply = JSON.parse(event.data) as { id?: number; error?: unknown };
        if (reply.id !== requestId) return;
        ws.removeEventListener("message", onMessage);
        resolve(reply);
      };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
  try {
    expect(await send({}, "Kitesurf.getRbiStartUrl")).toHaveProperty("error");
    for (const params of [
      { width: "800", height: 600 },
      { width: 800, height: 600, fps: 60.5 },
      { width: 800, height: 600, terminal: "yes" },
      { width: 800, height: 600, cellW: 0 },
    ]) {
      expect(await send(params)).toHaveProperty("error");
    }
  } finally {
    ws.close();
  }
});

test("CDP scene stream preserves credit and resets after navigation", async () => {
  const response = await engine.fetch("https://ks.invalid/devtools/browser", {
    headers: { Upgrade: "websocket" },
  });
  const ws = upgradedSocket(response);
  if (!ws) throw new Error(`CDP upgrade failed: ${response.status}`);
  ws.accept();
  let id = 0;
  const replies = new Map<number, (value: Record<string, unknown>) => void>();
  const frames: Uint8Array[] = [];
  let sessionId: string | undefined;
  const waiters = new Set<() => void>();
  ws.addEventListener("message", (event: { data: string | ArrayBuffer }) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data) as {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message: string };
      method?: string;
      params?: { data: string };
      sessionId?: string;
    };
    if (message.id !== undefined) {
      const resolve = replies.get(message.id);
      if (resolve) {
        replies.delete(message.id);
        resolve(message.error ? { error: message.error.message } : (message.result ?? {}));
      }
    } else if (message.method === "Kitesurf.sceneFrame" && message.params?.data) {
      expect(message.sessionId).toBe(sessionId);
      const binary = atob(message.params.data);
      frames.push(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
      for (const notify of [...waiters]) notify();
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const requestId = ++id;
    return new Promise<Record<string, unknown>>((resolve) => {
      replies.set(requestId, resolve);
      ws.send(JSON.stringify({ id: requestId, method, params, sessionId }));
    });
  };
  const waitFor = (predicate: () => boolean, timeout = 12_000) =>
    new Promise<boolean>((resolve) => {
      if (predicate()) return resolve(true);
      const notify = () => {
        if (predicate()) done(true);
      };
      const done = (value: boolean) => {
        clearTimeout(timer);
        waiters.delete(notify);
        resolve(value);
      };
      const timer = setTimeout(() => done(predicate()), timeout);
      waiters.add(notify);
    });
  const scenes = () => frames.filter((frame) => frame[0] === 3 || frame[0] === 5);
  const sequence = (frame: Uint8Array) =>
    new DataView(frame.buffer, frame.byteOffset).getUint32(3, true);
  try {
    const targets = (await send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string }>;
    };
    const pageId = targets.targetInfos.find((t) => t.type === "page")?.targetId;
    expect(pageId).toBeTruthy();
    const attached = await send("Target.attachToTarget", { targetId: pageId, flatten: true });
    sessionId = attached.sessionId as string;
    expect(sessionId).toBeTruthy();
    expect(
      await send("Emulation.setDeviceMetricsOverride", {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    ).not.toHaveProperty("error");
    expect(
      await send("Kitesurf.startSceneStream", {
        width: 800,
        height: 600,
        fps: 60,
        allowPartial: false,
      }),
    ).toHaveProperty("heartbeatMs", 1000);
    expect(
      await send("Page.navigate", {
        url: "https://ks.invalid/__fixtures/rbi-credit-window.html",
      }),
    ).not.toHaveProperty("error");
    expect(await waitFor(() => scenes().length >= 2)).toBe(true);
    const stalled = scenes().length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(scenes().length).toBe(stalled);
    expect(stalled).toBe(2);
    const creditHeartbeatStart = frames.length;
    expect(
      await waitFor(
        () =>
          frames
            .slice(creditHeartbeatStart)
            .some(
              (frame) =>
                frame[0] === 2 &&
                JSON.parse(new TextDecoder().decode(frame.subarray(11))).t === "sceneAlive",
            ),
        5000,
      ),
    ).toBe(true);
    expect(scenes().length).toBe(stalled);
    expect((await send("Browser.getVersion")).product).toBe("Chrome/145.0.0.0");
    expect(await send("Kitesurf.sceneFrameAck", { seq: "0", painted: true })).not.toHaveProperty(
      "error",
    );
    expect(await send("Kitesurf.getSceneResources", { missingB64: 123 })).toHaveProperty("error");
    expect(await send("Kitesurf.sceneFrameAck", { seq: 99999, painted: true })).not.toHaveProperty(
      "error",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(scenes().length).toBe(stalled);
    expect(
      await send("Kitesurf.sceneFrameAck", { seq: sequence(scenes()[0]!), painted: false }),
    ).not.toHaveProperty("error");
    expect(await waitFor(() => scenes().length > stalled)).toBe(true);
    expect(scenes().at(-1)?.[0]).toBe(3);
    expect(scenes().every((frame) => frame[0] === 3)).toBe(true);
    const before = scenes().length;
    expect(
      await send("Page.navigate", { url: "https://ks.invalid/__fixtures/accessibility.html" }),
    ).not.toHaveProperty("error");
    expect(await waitFor(() => scenes().length > before)).toBe(true);
    expect(scenes().at(-1)?.[0]).toBe(3);
    expect(sequence(scenes().at(-1)!)).toBeGreaterThan(sequence(scenes()[before - 1]!));
    const resources = await send("Kitesurf.getSceneResources", { missingB64: "AAAAAA==" });
    expect(resources).not.toHaveProperty("error");
    expect(typeof resources.batchB64).toBe("string");
    expect(
      await send("Emulation.setDeviceMetricsOverride", {
        width: 640,
        height: 480,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    ).not.toHaveProperty("error");
    const beforeResize = scenes().length;
    expect(
      await send("Kitesurf.startSceneStream", { width: 640, height: 480, allowPartial: false }),
    ).not.toHaveProperty("error");
    expect(await waitFor(() => scenes().length > beforeResize)).toBe(true);
    const resized = scenes().at(-1)!;
    expect(resized[0]).toBe(3);
    expect(scenes().every((frame) => frame[0] === 3)).toBe(true);
    expect(new DataView(resized.buffer, resized.byteOffset).getUint16(7, true)).toBe(640);
    expect(new DataView(resized.buffer, resized.byteOffset).getUint16(9, true)).toBe(480);
    const heartbeatStart = frames.length;
    for (const frame of scenes().slice(beforeResize)) {
      await send("Kitesurf.sceneFrameAck", { seq: sequence(frame), painted: true });
    }
    expect(
      await waitFor(
        () =>
          frames
            .slice(heartbeatStart)
            .some(
              (frame) =>
                frame[0] === 2 &&
                JSON.parse(new TextDecoder().decode(frame.subarray(11))).t === "sceneAlive",
            ),
        5000,
      ),
    ).toBe(true);
  } finally {
    await send("Kitesurf.stopSceneStream");
    ws.close();
  }
});
