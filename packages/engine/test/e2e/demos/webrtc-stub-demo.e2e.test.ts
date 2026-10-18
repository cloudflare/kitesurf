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

    let pc: any;
    try {
      pc = new g.RTCPeerConnection();
      out.ctorOk = true;
    } catch (e) {
      out.ctorOk = false;
      out.ctorErr = String(e);
    }
    if (!pc) return out;

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

    try {
      await pc.setRemoteDescription({ type: "offer", sdp: "" });
      out.setRemoteDescOk = true;
    } catch (e) {
      out.setRemoteDescErr = String(e);
    }
    try {
      const ans = await pc.createAnswer();
      out.createAnswerType = ans && ans.type;
    } catch (e) {
      out.createAnswerErr = String(e);
    }
    try {
      await pc.setLocalDescription({ type: "answer", sdp: "" });
      out.setLocalDescOk = true;
    } catch (e) {
      out.setLocalDescErr = String(e);
    }
    try {
      await pc.addIceCandidate({ candidate: "" });
      out.addIceOk = true;
    } catch (e) {
      out.addIceErr = String(e);
    }
    try {
      const stats = await pc.getStats();
      out.statsMapLike = typeof stats?.forEach === "function" && typeof stats?.get === "function";
    } catch (e) {
      out.statsErr = String(e);
    }

    const track = new g.MediaStreamTrack("video");
    const stream = new g.MediaStream([track]);
    const sender = pc.addTrack(track, stream);
    out.senderHasReplaceTrack = sender && typeof sender.replaceTrack === "function";

    let dcOpened = false;
    let resolveChannelOpen!: () => void;
    const channelOpened = new Promise<void>((resolve) => {
      resolveChannelOpen = resolve;
    });
    const dc = pc.createDataChannel("test");
    out.dcLabel = dc.label;
    out.dcInitialReadyState = dc.readyState;
    dc.onopen = () => {
      dcOpened = true;
      resolveChannelOpen();
    };

    await Promise.all([connectionFailed, channelOpened]);
    out.dcOpenedAfterTick = dcOpened;
    out.dcReadyStateAfterTick = dc.readyState;
    out.connectionStateAfterTick = pc.connectionState;
    out.stateChangesAfterTick = stateChanges;
    out.finalIceState = pc.iceConnectionState;

    pc.close();
    out.afterCloseConnectionState = pc.connectionState;
    out.afterCloseSignalingState = pc.signalingState;

    const stream2 = new g.MediaStream([
      new g.MediaStreamTrack("audio"),
      new g.MediaStreamTrack("video"),
    ]);
    out.streamTracks = stream2.getTracks().length;
    out.audioTracks = stream2.getAudioTracks().length;
    out.videoTracks = stream2.getVideoTracks().length;
    out.cloneTracks = stream2.clone().getTracks().length;

    const t = new g.MediaStreamTrack("video");
    let trackEnded = false;
    t.onended = () => {
      trackEnded = true;
    };
    t.stop();
    out.trackEndedReadyState = t.readyState;
    out.trackEndedFired = trackEnded;

    const mediaDevices = g.navigator.mediaDevices;
    out.hasMediaDevices = !!(g.navigator && mediaDevices);
    out.hasGUM = typeof mediaDevices.getUserMedia === "function";
    try {
      await mediaDevices.getUserMedia({ video: true });
      out.gumResolved = true;
    } catch (e) {
      out.gumRejectedName = e && (e as any).name;
    }
    try {
      const devices = await mediaDevices.enumerateDevices();
      out.enumDevicesIsArray = Array.isArray(devices) && devices.length === 0;
    } catch (e) {
      out.enumDevicesErr = String(e);
    }

    const desc = new g.RTCSessionDescription({ type: "offer", sdp: "v=0" });
    out.descType = desc.type;
    out.descSdp = desc.sdp;
    out.descJson = JSON.stringify(desc);

    const cand = new g.RTCIceCandidate({ candidate: "candidate:1 1 UDP 1 1.1.1.1 1 typ host" });
    out.candidate = cand.candidate;

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
