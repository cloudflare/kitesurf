// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements media-element state and events plus the shim's text-track stand-ins.

import type * as Idl from "../idl/types.generated.js";
import { KsEvent } from "../events/event.js";
import {
  defineAttribute,
  defineReflectedEnumWithDefaults,
  defineReflectedString,
  defineReflectedBoolean,
  defineReflectedUnsignedLong,
  defineReflectedUrl,
} from "./reflect.js";
import type { Element } from "./element.js";
import { HTMLElement, checkInternalConstruct } from "./html-element.js";
import { HTMLTrackElement, HTMLSourceElement } from "./html-classes.js";

// TextTrack and TextTrackList stand-ins, not the IDL interfaces: a track's
// cues stay empty and its events never fire.
function newTextTrack(trackEl: Element) {
  const attr = (n: string) => trackEl.getAttribute(n) || "";
  return {
    __el: trackEl,
    kind: attr("kind") || "subtitles",
    label: attr("label"),
    language: attr("srclang"),
    id: attr("id"),
    // Limitation: no VTT loader populates cues or activeCues.
    mode: trackEl.hasAttribute("default") ? "showing" : "disabled",
    cues: null,
    activeCues: null,
    oncuechange: null,
    addCue() {},
    removeCue() {},
    getCueById() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  };
}
type TextTrackStub = ReturnType<typeof newTextTrack>;
const textTrackCache = new Map<number, TextTrackStub>();
type AddedTextTrackStub = {
  kind: string;
  label: string;
  language: string;
  mode: string;
  cues: unknown[];
  activeCues: unknown[];
  addCue(): void;
  removeCue(): void;
};

function makeTextTrack(trackEl: Element): TextTrackStub {
  const cached = textTrackCache.get(trackEl._id);
  if (cached && cached.__el === trackEl) return cached;
  const tt = newTextTrack(trackEl);
  textTrackCache.set(trackEl._id, tt);
  return tt;
}
function makeTextTrackList(mediaEl: Element) {
  const tracks: TextTrackStub[] = [];
  try {
    const kids = mediaEl.querySelectorAll("track");
    for (let i = 0; i < kids.length; i++) if (kids[i]) tracks.push(makeTextTrack(kids[i]));
  } catch {}
  const list: { [index: number]: TextTrackStub } & Record<string | symbol, unknown> = {
    length: tracks.length,
    getTrackById(id: string) {
      return tracks.find((t) => t.id === id) || null;
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
    onaddtrack: null,
    onremovetrack: null,
    onchange: null,
    [Symbol.iterator]() {
      return tracks[Symbol.iterator]();
    },
  };
  for (let i = 0; i < tracks.length; i++) list[i] = tracks[i];
  return list;
}
defineAttribute(HTMLTrackElement.prototype, "track", {
  get() {
    return makeTextTrack(this);
  },
});

const mediaPaused = new WeakMap<object, boolean>();

// Ranges with nothing in them: start() and end() throw for any index.
function emptyTimeRanges(): Idl.TimeRanges {
  const outOfRange = (): never => {
    throw new DOMException("Index out of range", "IndexSizeError");
  };
  return { length: 0, start: outOfRange, end: outOfRange };
}

// The reflections below the class install these, and tag-attributes.ts
// installs crossOrigin. mediaGroup is not in the IDL any more.
interface HTMLMediaElement extends Pick<
  Idl.HTMLMediaElement,
  "preload" | "loading" | "autoplay" | "loop" | "controls" | "defaultMuted" | "crossOrigin"
> {
  mediaGroup: string;
}

// The media element interfaces with nothing to play: playback state reads as
// an empty, paused element, play() and pause() only fire their events, and
// the setters accept and drop what they get. The track members return object
// stubs (idl/type-gaps.json).
class HTMLMediaElement extends HTMLElement implements Idl.HTMLMediaElement {
  constructor(nodeId: number, info: unknown, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLMediaElement");
  }
  get textTracks(): ReturnType<typeof makeTextTrackList> {
    return makeTextTrackList(this);
  }
  canPlayType(_type: string): Idl.CanPlayTypeResult {
    return "";
  }
  fastSeek(_time: number): void {
    /* no-op */
  }
  load(): void {
    /* no-op */
  }
  // Playback is unsupported, but play() and pause() still update state and fire events.
  // https://html.spec.whatwg.org/#dom-media-play
  play(): Promise<void> {
    if (mediaPaused.get(this) !== false) {
      mediaPaused.set(this, false);
      queueMicrotask(() => {
        try {
          this.dispatchEvent(new KsEvent("play", { bubbles: false, cancelable: false }));
        } catch {}
      });
    }
    return Promise.resolve();
  }
  pause(): void {
    if (mediaPaused.get(this) === false) {
      mediaPaused.set(this, true);
      queueMicrotask(() => {
        try {
          this.dispatchEvent(new KsEvent("pause", { bubbles: false, cancelable: false }));
        } catch {}
      });
    }
  }
  addTextTrack(_kind?: string, _label?: string, _lang?: string): AddedTextTrackStub {
    return {
      kind: String(_kind || "subtitles"),
      label: String(_label || ""),
      language: String(_lang || ""),
      mode: "hidden",
      cues: [],
      activeCues: [],
      addCue() {},
      removeCue() {},
    };
  }
  get currentSrc(): string {
    return this.getAttribute("src") || "";
  }
  get readyState(): number {
    return 0; /* HAVE_NOTHING */
  }
  get networkState(): number {
    return 0; /* NETWORK_EMPTY */
  }
  get duration(): number {
    return NaN;
  }
  get paused(): boolean {
    return mediaPaused.get(this) !== false;
  }
  get ended(): boolean {
    return false;
  }
  get seeking(): boolean {
    return false;
  }
  get muted(): boolean {
    return false;
  }
  set muted(_v: boolean) {}
  get volume(): number {
    return 1;
  }
  set volume(_v: number) {}
  get playbackRate(): number {
    return 1;
  }
  set playbackRate(_v: number) {}
  get defaultPlaybackRate(): number {
    return 1;
  }
  set defaultPlaybackRate(_v: number) {}
  get currentTime(): number {
    return 0;
  }
  set currentTime(_v: number) {}
  get buffered(): Idl.TimeRanges {
    return emptyTimeRanges();
  }
  get seekable(): Idl.TimeRanges {
    return emptyTimeRanges();
  }
  get played(): Idl.TimeRanges {
    return emptyTimeRanges();
  }
  get audioTracks(): ReturnType<typeof emptyTrackList> {
    return emptyTrackList();
  }
  get videoTracks(): ReturnType<typeof emptyTrackList> {
    return emptyTrackList();
  }
  get error(): Idl.MediaError | null {
    return null;
  }
}

function emptyTrackList() {
  return Object.assign([], {
    length: 0,
    getTrackById() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  });
}

// Audio and video extend HTMLElement here, not HTMLMediaElement as the IDL
// says, so each gets its own copy of the media members.
type MediaMembers = Omit<HTMLMediaElement, keyof HTMLElement>;
function copyMediaMembers(target: typeof HTMLElement): void {
  for (const key of Reflect.ownKeys(HTMLMediaElement.prototype)) {
    if (key === "constructor") continue;
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, key);
    if (desc) Object.defineProperty(target.prototype, key, desc);
  }
}

interface HTMLAudioElement extends MediaMembers {}
class HTMLAudioElement extends HTMLElement implements Idl.HTMLAudioElement {
  constructor(nodeId: number, info: unknown, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLAudioElement");
  }
}

// The reflections below install these.
interface HTMLVideoElement
  extends MediaMembers, Pick<Idl.HTMLVideoElement, "width" | "height" | "poster" | "playsInline"> {}
class HTMLVideoElement extends HTMLElement implements Idl.HTMLVideoElement {
  constructor(nodeId: number, info: unknown, token?: symbol) {
    super(nodeId, info);
    checkInternalConstruct(token, "HTMLVideoElement");
  }
}

// Media loading follows the eager/lazy reflection used by images and iframes.
// HTML leaves missing and invalid preload defaults to the UA; this uses metadata and auto.
// https://html.spec.whatwg.org/#attr-media-preload
defineReflectedEnumWithDefaults(
  HTMLMediaElement.prototype,
  "preload",
  "preload",
  ["none", "metadata", "auto"],
  "metadata",
  "auto",
);
defineReflectedEnumWithDefaults(
  HTMLMediaElement.prototype,
  "loading",
  "loading",
  ["eager", "lazy"],
  "eager",
  "eager",
);
defineReflectedString(HTMLMediaElement.prototype, "mediaGroup", "mediagroup");
defineReflectedBoolean(HTMLMediaElement.prototype, "autoplay", "autoplay");
defineReflectedBoolean(HTMLMediaElement.prototype, "loop", "loop");
defineReflectedBoolean(HTMLMediaElement.prototype, "controls", "controls");
defineReflectedBoolean(HTMLMediaElement.prototype, "defaultMuted", "muted");
copyMediaMembers(HTMLAudioElement);
copyMediaMembers(HTMLVideoElement);
defineReflectedUnsignedLong(HTMLVideoElement.prototype, "width", "width", 0);
defineReflectedUnsignedLong(HTMLVideoElement.prototype, "height", "height", 0);
defineReflectedUrl(HTMLVideoElement.prototype, "poster", "poster");
defineReflectedBoolean(HTMLVideoElement.prototype, "playsInline", "playsinline");

defineReflectedString(HTMLSourceElement.prototype, "media", "media");
defineReflectedString(HTMLSourceElement.prototype, "sizes", "sizes");
defineReflectedString(HTMLSourceElement.prototype, "srcset", "srcset");
defineReflectedString(HTMLSourceElement.prototype, "type", "type");
// width and height are unsigned long reflections, unlike iframe and embed.
// https://html.spec.whatwg.org/#dom-source-width
defineReflectedUnsignedLong(HTMLSourceElement.prototype, "width", "width", 0);
defineReflectedUnsignedLong(HTMLSourceElement.prototype, "height", "height", 0);
defineReflectedEnumWithDefaults(
  HTMLTrackElement.prototype,
  "kind",
  "kind",
  ["subtitles", "captions", "descriptions", "chapters", "metadata"],
  "subtitles",
  "metadata",
);
defineReflectedString(HTMLTrackElement.prototype, "srclang", "srclang");
defineReflectedString(HTMLTrackElement.prototype, "label", "label");
defineReflectedBoolean(HTMLTrackElement.prototype, "default", "default");

export { HTMLAudioElement, HTMLMediaElement, HTMLVideoElement };
