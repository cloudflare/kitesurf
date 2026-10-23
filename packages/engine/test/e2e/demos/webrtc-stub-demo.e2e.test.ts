// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

test("WebRTC stubs expose a graceful no-transport surface", async ({ page }) => {
  await setContent(page, "<!doctype html><html><body></body></html>");

  const result = await page.evaluate(async () => {
    const g = globalThis as any;
    const out: Record<string, any> = {};

    function recordGlobalSurface() {
      out.hasPC = typeof g.RTCPeerConnection === "function";
      out.hasDC = typeof g.RTCDataChannel === "function";
      out.hasDesc = typeof g.RTCSessionDescription === "function";
      out.hasCand = typeof g.RTCIceCandidate === "function";
      out.hasErr = typeof g.RTCError === "function";
      out.hasMS = typeof g.MediaStream === "function";
      out.hasMST = typeof g.MediaStreamTrack === "function";
      out.hasWebkitPC = typeof g.webkitRTCPeerConnection === "function";
      out.hasErrorEvent = typeof g.RTCErrorEvent === "function";
      out.hasIceEvent = typeof g.RTCPeerConnectionIceEvent === "function";
      out.hasDataEvent = typeof g.RTCDataChannelEvent === "function";
      out.hasTrackEvent = typeof g.RTCTrackEvent === "function";
    }

    function createPeerConnection() {
      try {
        const pc = new g.RTCPeerConnection();
        out.ctorOk = true;
        return pc;
      } catch (error) {
        out.ctorOk = false;
        out.ctorErr = String(error);
        return null;
      }
    }

    function observeConnection(pc) {
      out.initialConnectionState = pc.connectionState;
      out.initialIceState = pc.iceConnectionState;
      out.initialSignalingState = pc.signalingState;

      let stateChanges = 0;
      let resolveFailure!: () => void;
      const connectionFailed = new Promise<void>((resolve) => {
        resolveFailure = resolve;
      });
      pc.onconnectionstatechange = () => {
        stateChanges++;
        if (pc.connectionState === "failed") resolveFailure();
      };
      return { connectionFailed, stateChanges: () => stateChanges };
    }

    async function captureCall<T>(
      call: () => Promise<T>,
      onSuccess: (value: T) => void,
      errorKey: string,
    ): Promise<void> {
      try {
        onSuccess(await call());
      } catch (error) {
        out[errorKey] = String(error);
      }
    }

    function hasMethod(value: object, name: "forEach" | "get"): boolean {
      return typeof Reflect.get(value, name) === "function";
    }

    function isStatsMapLike(value: unknown): boolean {
      if (value === null || value === undefined) return false;
      const stats = Object(value);
      return hasMethod(stats, "forEach") && hasMethod(stats, "get");
    }

    async function exercisePeerCalls(pc) {
      await captureCall(
        () => pc.setRemoteDescription({ type: "offer", sdp: "" }),
        () => {
          out.setRemoteDescOk = true;
        },
        "setRemoteDescErr",
      );
      await captureCall(
        () => pc.createAnswer(),
        (answer: unknown) => {
          out.createAnswerType = answer && Reflect.get(Object(answer), "type");
        },
        "createAnswerErr",
      );
      await captureCall(
        () => pc.setLocalDescription({ type: "answer", sdp: "" }),
        () => {
          out.setLocalDescOk = true;
        },
        "setLocalDescErr",
      );
      await captureCall(
        () => pc.addIceCandidate({ candidate: "" }),
        () => {
          out.addIceOk = true;
        },
        "addIceErr",
      );
      await captureCall(
        () => pc.getStats(),
        (stats: unknown) => {
          out.statsMapLike = isStatsMapLike(stats);
        },
        "statsErr",
      );
    }

    function addTrackAndDataChannel(pc) {
      const track = new g.MediaStreamTrack("video");
      const stream = new g.MediaStream([track]);
      const sender = pc.addTrack(track, stream);
      out.senderHasReplaceTrack = sender && typeof sender.replaceTrack === "function";

      let resolveChannelOpen!: () => void;
      const channelOpened = new Promise<void>((resolve) => {
        resolveChannelOpen = resolve;
      });
      const dc = pc.createDataChannel("test");
      out.dcLabel = dc.label;
      out.dcInitialReadyState = dc.readyState;
      dc.onopen = () => resolveChannelOpen();
      return { channelOpened, dc };
    }

    function recordStreamsAndTrack(pc) {
      pc.close();
      out.afterCloseConnectionState = pc.connectionState;
      out.afterCloseSignalingState = pc.signalingState;

      const stream = new g.MediaStream([
        new g.MediaStreamTrack("audio"),
        new g.MediaStreamTrack("video"),
      ]);
      out.streamTracks = stream.getTracks().length;
      out.audioTracks = stream.getAudioTracks().length;
      out.videoTracks = stream.getVideoTracks().length;
      out.cloneTracks = stream.clone().getTracks().length;

      const track = new g.MediaStreamTrack("video");
      let trackEnded = false;
      track.onended = () => {
        trackEnded = true;
      };
      track.stop();
      out.trackEndedReadyState = track.readyState;
      out.trackEndedFired = trackEnded;
    }

    async function captureGetUserMedia(mediaDevices) {
      try {
        await mediaDevices.getUserMedia({ video: true });
        out.gumResolved = true;
      } catch (error) {
        out.gumRejectedName = error && (error as any).name;
      }
    }

    async function captureEnumeratedDevices(mediaDevices) {
      try {
        const devices = await mediaDevices.enumerateDevices();
        out.enumDevicesIsArray = Array.isArray(devices) && devices.length === 0;
      } catch (error) {
        out.enumDevicesErr = String(error);
      }
    }

    async function recordMediaDevices() {
      const mediaDevices = g.navigator.mediaDevices;
      out.hasMediaDevices = !!(g.navigator && mediaDevices);
      out.hasGUM = typeof mediaDevices.getUserMedia === "function";
      await captureGetUserMedia(mediaDevices);
      await captureEnumeratedDevices(mediaDevices);
    }

    function recordDescriptionConstructors() {
      const desc = new g.RTCSessionDescription({ type: "offer", sdp: "v=0" });
      out.descType = desc.type;
      out.descSdp = desc.sdp;
      out.descJson = JSON.stringify(desc);

      const candidate = new g.RTCIceCandidate({
        candidate: "candidate:1 1 UDP 1 1.1.1.1 1 typ host",
      });
      out.candidate = candidate.candidate;
    }

    recordGlobalSurface();
    const pc = createPeerConnection();
    if (!pc) return out;

    const connection = observeConnection(pc);
    await exercisePeerCalls(pc);
    const channel = addTrackAndDataChannel(pc);
    await Promise.all([connection.connectionFailed, channel.channelOpened]);
    out.dcOpenedAfterTick = true;
    out.dcReadyStateAfterTick = channel.dc.readyState;
    out.connectionStateAfterTick = pc.connectionState;
    out.stateChangesAfterTick = connection.stateChanges();
    out.finalIceState = pc.iceConnectionState;

    recordStreamsAndTrack(pc);
    await recordMediaDevices();
    recordDescriptionConstructors();

    return out;
  });

  expect(result.hasPC, "typeof RTCPeerConnection === 'function'").toBe(true);
  expect(result.hasDC, "typeof RTCDataChannel === 'function'").toBe(true);
  expect(result.hasDesc, "typeof RTCSessionDescription === 'function'").toBe(true);
  expect(result.hasCand, "typeof RTCIceCandidate === 'function'").toBe(true);
  expect(result.hasErr, "typeof RTCError === 'function'").toBe(true);
  expect(result.hasMS, "typeof MediaStream === 'function'").toBe(true);
  expect(result.hasMST, "typeof MediaStreamTrack === 'function'").toBe(true);

  expect(result.hasWebkitPC, "webkitRTCPeerConnection aliased").toBe(true);

  expect(result.hasErrorEvent, "RTCErrorEvent exists").toBe(true);
  expect(result.hasIceEvent, "RTCPeerConnectionIceEvent exists").toBe(true);
  expect(result.hasDataEvent, "RTCDataChannelEvent exists").toBe(true);
  expect(result.hasTrackEvent, "RTCTrackEvent exists").toBe(true);

  expect(result.ctorOk, "new RTCPeerConnection() doesn't throw").toBe(true);

  expect(result.initialConnectionState === "new", "initial connectionState === 'new'").toBe(true);
  expect(result.initialIceState === "new", "initial iceConnectionState === 'new'").toBe(true);
  expect(result.initialSignalingState === "stable", "initial signalingState === 'stable'").toBe(
    true,
  );

  expect(result.setRemoteDescOk === true, "setRemoteDescription resolves").toBe(true);
  expect(result.createAnswerType === "answer", "createAnswer returns answer").toBe(true);
  expect(result.setLocalDescOk === true, "setLocalDescription resolves").toBe(true);
  expect(result.addIceOk === true, "addIceCandidate resolves").toBe(true);
  expect(result.statsMapLike === true, "getStats report exposes forEach and get").toBe(true);

  expect(result.senderHasReplaceTrack === true, "addTrack returns a sender shape").toBe(true);

  expect(result.dcLabel === "test", "createDataChannel keeps label").toBe(true);
  expect(
    result.dcInitialReadyState === "connecting",
    "dataChannel initial readyState === 'connecting'",
  ).toBe(true);

  expect(result.dcOpenedAfterTick === true, "dataChannel onopen fired after async transition").toBe(
    true,
  );
  expect(
    result.dcReadyStateAfterTick === "open",
    "dataChannel readyState === 'open' after transition",
  ).toBe(true);
  expect(
    result.connectionStateAfterTick === "failed",
    "connectionState transitions to 'failed' after async transitions",
  ).toBe(true);
  expect(result.stateChangesAfterTick >= 1, "onconnectionstatechange fired at least once").toBe(
    true,
  );
  expect(result.finalIceState === "failed", "iceConnectionState transitions to 'failed'").toBe(
    true,
  );

  expect(
    result.afterCloseConnectionState === "closed",
    "close() sets connectionState to 'closed'",
  ).toBe(true);
  expect(
    result.afterCloseSignalingState === "closed",
    "close() sets signalingState to 'closed'",
  ).toBe(true);

  expect(result.streamTracks === 2, "MediaStream getTracks length").toBe(true);
  expect(result.audioTracks === 1, "MediaStream getAudioTracks length").toBe(true);
  expect(result.videoTracks === 1, "MediaStream getVideoTracks length").toBe(true);
  expect(result.cloneTracks === 2, "MediaStream clone keeps tracks").toBe(true);

  expect(
    result.trackEndedReadyState === "ended",
    "MediaStreamTrack.stop sets readyState='ended'",
  ).toBe(true);
  expect(result.trackEndedFired === true, "MediaStreamTrack.stop fires onended").toBe(true);

  expect(result.hasMediaDevices, "navigator.mediaDevices exists").toBe(true);
  expect(result.hasGUM, "navigator.mediaDevices.getUserMedia is a function").toBe(true);
  expect(
    result.gumRejectedName === "NotAllowedError",
    "getUserMedia rejects with NotAllowedError",
  ).toBe(true);
  expect(result.enumDevicesIsArray === true, "enumerateDevices returns empty array").toBe(true);

  expect(
    result.descType === "offer" && result.descSdp === "v=0",
    "RTCSessionDescription holds type/sdp",
  ).toBe(true);
  expect(/"type":"offer"/.test(result.descJson), "RTCSessionDescription serializes via JSON").toBe(
    true,
  );
  expect(
    typeof result.candidate === "string" && result.candidate.length > 0,
    "RTCIceCandidate holds candidate string",
  ).toBe(true);
});
