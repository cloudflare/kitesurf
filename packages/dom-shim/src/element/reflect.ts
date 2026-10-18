// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines helpers that map element IDL properties to HTML content attributes.

import type { Element } from "./element.js";

type IfEquals<X, Y, A, B> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? A : B;

// Reflections require writable string keys whose types match the getter.
// The two-way match admits enum properties narrower than string.
// IfEquals rejects readonly IDL attributes because reflections install setters.
type ReflectKey<P, V> = {
  [K in keyof P]-?: K extends string
    ? [V] extends [P[K]]
      ? WritableKey<P, K>
      : [P[K]] extends [V]
        ? WritableKey<P, K>
        : never
    : never;
}[keyof P];
type WritableKey<P, K extends keyof P> = IfEquals<
  { [Q in K]: P[K] },
  { -readonly [Q in K]: P[K] },
  K,
  never
>;

// A hand-written IDL attribute: each half sees `this` as the prototype's
// type, the getter returns the attribute's type and the setter takes it.
interface AttributeAccessors<P, K extends keyof P> {
  get(this: P): P[K];
  set?(this: P, value: P[K]): void;
}

// Installs an attribute no reflection helper fits, in the shape they all
// install: an enumerable, configurable accessor. The name must be a key the
// prototype's type declares. On a class the module defines itself, write a
// class accessor instead; finalizeInterface gives it the same shape.
function defineAttribute<P extends object, K extends keyof P & string>(
  proto: P,
  name: K,
  accessors: AttributeAccessors<P, K>,
): void {
  Object.defineProperty(proto, name, {
    configurable: true,
    enumerable: true,
    get: accessors.get,
    set: accessors.set,
  });
}

// These helpers implement the common Web IDL reflection patterns. Each one
// takes the prototype and checks the property name against its type, so a
// typo or a reflection of the wrong kind fails to compile.
function defineReflectedString<P extends Element>(
  proto: P,
  propName: ReflectKey<P, string>,
  attrName: string,
): void {
  Object.defineProperty(proto, propName, {
    configurable: true,
    enumerable: true,
    get(this: Element) {
      const v = this.getAttribute(attrName);
      return v == null ? "" : v;
    },
    set(this: Element, value: unknown) {
      this.setAttribute(attrName, String(value));
    },
  });
}
// [LegacyNullToEmptyString] maps null to an empty string.
function defineReflectedStringNullEmpty<P extends Element>(
  proto: P,
  propName: ReflectKey<P, string>,
  attrName: string,
): void {
  Object.defineProperty(proto, propName, {
    configurable: true,
    enumerable: true,
    get(this: Element) {
      const v = this.getAttribute(attrName);
      return v == null ? "" : v;
    },
    set(this: Element, value: unknown) {
      if (value === null) {
        this.setAttribute(attrName, "");
        return;
      }
      this.setAttribute(attrName, String(value));
    },
  });
}
function defineReflectedBoolean<P extends Element>(
  proto: P,
  propName: ReflectKey<P, boolean>,
  attrName: string,
): void {
  Object.defineProperty(proto, propName, {
    configurable: true,
    enumerable: true,
    get(this: Element) {
      return this.hasAttribute(attrName);
    },
    set(this: Element, value: unknown) {
      if (value) this.setAttribute(attrName, "");
      else this.removeAttribute(attrName);
    },
  });
}
// The getter canonicalizes known keywords; the setter preserves the input.
// https://html.spec.whatwg.org/#reflecting-content-attributes-in-idl-attributes
function defineReflectedEnum<P extends Element>(
  proto: P,
  propName: ReflectKey<P, string>,
  attrName: string,
  keywords: readonly string[],
): void {
  defineReflectedEnumWithDefaults(proto, propName, attrName, keywords, "", "");
}
function defineReflectedEnumWithDefaults<P extends Element>(
  proto: P,
  propName: ReflectKey<P, string>,
  attrName: string,
  keywords: readonly string[],
  missingDefault: string,
  invalidDefault: string,
): void {
  const lookup = new Set(keywords.map(asciiLowercaseFast));
  Object.defineProperty(proto, propName, {
    configurable: true,
    enumerable: true,
    get(this: Element) {
      const v = this.getAttribute(attrName);
      if (v == null) return missingDefault;
      const lc = asciiLowercaseFast(String(v));
      return lookup.has(lc) ? lc : invalidDefault;
    },
    set(this: Element, value: unknown) {
      this.setAttribute(attrName, String(value));
    },
  });
}
function htmlParseInteger(raw: string): number | null {
  const m = /^[\t\n\f\r ]*([+-]?\d+)/.exec(raw);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < -2147483648 || n > 2147483647) {
    return null;
  }
  return n === 0 ? 0 : n;
}
function defineReflectedLong<P extends Element>(
  proto: P,
  propName: ReflectKey<P, number>,
  attrName: string,
  def: number,
): void {
  Object.defineProperty(proto, propName, {
    configurable: true,
    enumerable: true,
    get(this: Element) {
      const raw = this.getAttribute(attrName);
      if (raw == null) return def;
      const n = htmlParseInteger(raw);
      return n == null ? def : n;
    },
    set(this: Element, value) {
      const n = value | 0;
      this.setAttribute(attrName, String(n));
    },
  });
}
// Clamp parsed values to the element's allowed range.
function defineClampedLong<P extends Element>(
  proto: P,
  propName: ReflectKey<P, number>,
  attrName: string,
  min: number,
  max: number,
  def: number,
): void {
  Object.defineProperty(proto, propName, {
    configurable: true,
    enumerable: true,
    get(this: Element) {
      const raw = this.getAttribute(attrName);
      if (raw == null) return def;
      const m = /^[\t\n\f\r ]*([+-]?\d+)/.exec(raw);
      if (!m) return def;
      let n = parseInt(m[1], 10);
      if (!Number.isFinite(n)) return def;
      if (n === 0) n = 0;
      if (n < min) return def;
      if (n > max) return max;
      return n;
    },
    set(this: Element, value) {
      const u = value >>> 0;
      const n = u > 2147483647 ? def : u;
      this.setAttribute(attrName, String(n));
    },
  });
}
// URL getters resolve against baseURI but preserve invalid raw values.
// https://html.spec.whatwg.org/#reflecting-content-attributes-in-idl-attributes
function defineReflectedUrl<P extends Element>(
  proto: P,
  propName: ReflectKey<P, string>,
  attrName: string,
): void {
  Object.defineProperty(proto, propName, {
    configurable: true,
    enumerable: true,
    get(this: Element) {
      const raw = this.getAttribute(attrName);
      if (raw == null) return "";
      try {
        return new URL(raw, this.baseURI || undefined).toString();
      } catch {
        return raw;
      }
    },
    set(this: Element, value: unknown) {
      this.setAttribute(attrName, String(value));
    },
  });
}
// Unsigned getters map negative and invalid values to their default.
function defineReflectedUnsignedLong<P extends Element>(
  proto: P,
  propName: ReflectKey<P, number>,
  attrName: string,
  def: number,
): void {
  Object.defineProperty(proto, propName, {
    configurable: true,
    enumerable: true,
    get(this: Element) {
      const raw = this.getAttribute(attrName);
      if (raw == null) return def;
      const n = htmlParseInteger(raw);
      if (n == null || n < 0) return def;
      return n;
    },
    set(this: Element, value) {
      const u = value >>> 0;
      const n = u > 2147483647 ? def : u;
      this.setAttribute(attrName, String(n));
    },
  });
}

// Getters use the default for zero; setters reject it.
function defineReflectedLimitedPositiveUnsignedLong<P extends Element>(
  proto: P,
  propName: ReflectKey<P, number>,
  attrName: string,
  def: number,
): void {
  Object.defineProperty(proto, propName, {
    configurable: true,
    enumerable: true,
    get(this: Element) {
      const raw = this.getAttribute(attrName);
      if (raw == null) return def;
      const n = htmlParseInteger(raw);
      if (n == null || n <= 0 || n > 2147483647) return def;
      return n;
    },
    set(this: Element, value) {
      const u = value >>> 0;
      if (u === 0) {
        throw new DOMException(
          "Failed to set the '" +
            propName +
            "' property: The value " +
            "provided is 0, which is not a valid positive integer.",
          "IndexSizeError",
        );
      }
      const n = u > 2147483647 ? def : u;
      this.setAttribute(attrName, String(n));
    },
  });
}

// Textarea dimensions use the default instead of throwing on zero.
function defineReflectedLimitedPositiveUnsignedLongFallback<P extends Element>(
  proto: P,
  propName: ReflectKey<P, number>,
  attrName: string,
  def: number,
): void {
  Object.defineProperty(proto, propName, {
    configurable: true,
    enumerable: true,
    get(this: Element) {
      const raw = this.getAttribute(attrName);
      if (raw == null) return def;
      const n = htmlParseInteger(raw);
      if (n == null || n <= 0 || n > 2147483647) return def;
      return n;
    },
    set(this: Element, value) {
      const u = value >>> 0;
      const n = u === 0 || u > 2147483647 ? def : u;
      this.setAttribute(attrName, String(n));
    },
  });
}

// Non-negative long setters reject negative values.
function defineReflectedNonNegativeLong<P extends Element>(
  proto: P,
  propName: ReflectKey<P, number>,
  attrName: string,
  def: number,
): void {
  Object.defineProperty(proto, propName, {
    configurable: true,
    enumerable: true,
    get(this: Element) {
      const raw = this.getAttribute(attrName);
      if (raw == null) return def;
      const n = htmlParseInteger(raw);
      if (n == null || n < 0) return def;
      return n;
    },
    set(this: Element, value) {
      const n = value | 0;
      if (n < 0) {
        throw new DOMException(
          "Failed to set the '" +
            propName +
            "' property: The value provided (" +
            value +
            ") is negative.",
          "IndexSizeError",
        );
      }
      this.setAttribute(attrName, String(n));
    },
  });
}
function asciiLowercaseFast(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) | 0x20));
}

// The referrerpolicy attribute's keywords.
// https://w3c.github.io/webappsec-referrer-policy/#referrer-policies
const REFERRER_POLICY_KEYWORDS = [
  "no-referrer",
  "no-referrer-when-downgrade",
  "same-origin",
  "origin",
  "strict-origin",
  "origin-when-cross-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
] as const;

// crossorigin is nullable; unknown and empty values map to anonymous.
// https://html.spec.whatwg.org/#cors-settings-attribute
function defineReflectedCrossOrigin<P extends Element>(
  proto: P &
    ("crossOrigin" extends ReflectKey<P, string | null> ? unknown : { crossOrigin: string | null }),
): void {
  Object.defineProperty(proto, "crossOrigin", {
    configurable: true,
    enumerable: true,
    get(this: Element) {
      const v = this.getAttribute("crossorigin");
      if (v == null) return null;
      const lc = String(v).toLowerCase();
      if (lc === "use-credentials") return "use-credentials";
      return "anonymous";
    },
    set(this: Element, value: unknown) {
      if (value === null || value === undefined) {
        this.removeAttribute("crossorigin");
        return;
      }
      this.setAttribute("crossorigin", String(value));
    },
  });
}

export {
  defineAttribute,
  asciiLowercaseFast,
  defineClampedLong,
  defineReflectedBoolean,
  defineReflectedCrossOrigin,
  defineReflectedEnum,
  defineReflectedEnumWithDefaults,
  defineReflectedLimitedPositiveUnsignedLong,
  defineReflectedLimitedPositiveUnsignedLongFallback,
  defineReflectedLong,
  defineReflectedNonNegativeLong,
  defineReflectedString,
  defineReflectedStringNullEmpty,
  defineReflectedUnsignedLong,
  defineReflectedUrl,
  htmlParseInteger,
  REFERRER_POLICY_KEYWORDS,
};
