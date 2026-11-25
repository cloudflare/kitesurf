// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Type tests for the reflection helpers. Nothing runs them: //packages/dom-shim:types fails on any
// type error here, and `vitest --typecheck.only` reports them by name.

import { describe, expectTypeOf, test } from "vitest";
import type * as Idl from "../src/idl/types.generated.js";
import {
  defineAttribute,
  defineClampedLong,
  defineReflectedBoolean,
  defineReflectedCrossOrigin,
  defineReflectedEnum,
  defineReflectedEnumWithDefaults,
  defineReflectedLimitedPositiveUnsignedLong,
  defineReflectedLimitedPositiveUnsignedLongFallback,
  defineReflectedLong,
  defineReflectedNonNegativeLong,
  defineReflectedNullableEnum,
  defineReflectedString,
  defineReflectedStringNullEmpty,
  defineReflectedUnsignedLong,
  defineReflectedUrl,
} from "../src/element/reflect.js";
import { HTMLElement } from "../src/element/html-element.js";
import {
  HTMLAnchorElement,
  HTMLAreaElement,
  HTMLDivElement,
  HTMLOListElement,
} from "../src/element/html-classes.js";
import { HTMLIFrameElement } from "../src/element/embedded.js";
import { HTMLImageElement } from "../src/element/image.js";
import { HTMLTextAreaElement } from "../src/element/forms/textarea.js";

// defineHTMLClass types this prototype from Idl.HTMLOListElement: reversed is a boolean, start a
// number and type a string, all writable.
const ol = HTMLOListElement.prototype;

describe("reflection keys", () => {
  test("a key must be an attribute the prototype's type declares", () => {
    defineReflectedString(HTMLAnchorElement.prototype, "href", "href");
    // @ts-expect-error no such attribute.
    defineReflectedString(HTMLAnchorElement.prototype, "hreff", "href");
    // @ts-expect-error a key must be a string.
    defineReflectedString(ol, 0, "start");
  });

  test("a key the IDL lacks does not compile", () => {
    // @ts-expect-error Idl.HTMLDivElement has no charset.
    defineReflectedString(HTMLDivElement.prototype, "charset", "charset");
    // html-classes.ts adds charset to area as a legacy extra.
    defineReflectedString(HTMLAreaElement.prototype, "charset", "charset");
  });

  test("an operation is not an attribute", () => {
    // @ts-expect-error click is an operation.
    defineReflectedString(HTMLElement.prototype, "click", "click");
  });

  test("the prototype must be an Element", () => {
    const notAnElement: { title: string } = { title: "" };
    // @ts-expect-error a plain object.
    defineReflectedString(notAnElement, "title", "title");
  });
});

describe("attribute kinds", () => {
  test("string reflections fit a string attribute only", () => {
    defineReflectedString(ol, "type", "type");
    defineReflectedStringNullEmpty(ol, "type", "type");
    defineReflectedUrl(ol, "type", "type");
    defineReflectedEnum(ol, "type", "type", ["1", "a"]);
    defineReflectedEnumWithDefaults(ol, "type", "type", ["1", "a"], "1", "1");
    // @ts-expect-error reversed is a boolean.
    defineReflectedString(ol, "reversed", "reversed");
    // @ts-expect-error start is a number.
    defineReflectedString(ol, "start", "start");
    // @ts-expect-error reversed is a boolean.
    defineReflectedStringNullEmpty(ol, "reversed", "reversed");
    // @ts-expect-error start is a number.
    defineReflectedUrl(ol, "start", "start");
    // @ts-expect-error reversed is a boolean.
    defineReflectedEnum(ol, "reversed", "reversed", []);
    // @ts-expect-error start is a number.
    defineReflectedEnumWithDefaults(ol, "start", "start", [], "", "");
  });

  test("the boolean reflection fits a boolean attribute only", () => {
    defineReflectedBoolean(ol, "reversed", "reversed");
    // @ts-expect-error type is a string.
    defineReflectedBoolean(ol, "type", "type");
    // @ts-expect-error start is a number.
    defineReflectedBoolean(ol, "start", "start");
  });

  test("number reflections fit a number attribute only", () => {
    defineReflectedLong(ol, "start", "start", 1);
    defineClampedLong(ol, "start", "start", 0, 10, 1);
    defineReflectedUnsignedLong(ol, "start", "start", 1);
    defineReflectedLimitedPositiveUnsignedLong(ol, "start", "start", 1);
    defineReflectedLimitedPositiveUnsignedLongFallback(ol, "start", "start", 1);
    defineReflectedNonNegativeLong(ol, "start", "start", 1);
    // @ts-expect-error type is a string.
    defineReflectedLong(ol, "type", "type", 1);
    // @ts-expect-error reversed is a boolean.
    defineClampedLong(ol, "reversed", "reversed", 0, 10, 1);
    // @ts-expect-error type is a string.
    defineReflectedUnsignedLong(ol, "type", "type", 1);
    // @ts-expect-error reversed is a boolean.
    defineReflectedLimitedPositiveUnsignedLong(ol, "reversed", "reversed", 1);
    // @ts-expect-error type is a string.
    defineReflectedLimitedPositiveUnsignedLongFallback(ol, "type", "type", 1);
    // @ts-expect-error reversed is a boolean.
    defineReflectedNonNegativeLong(ol, "reversed", "reversed", 1);
  });
});

describe("readonly attributes", () => {
  test("a reflection installs a setter, so a readonly IDL attribute does not compile", () => {
    expectTypeOf(HTMLAnchorElement.prototype.origin).toEqualTypeOf<string>();
    expectTypeOf(HTMLTextAreaElement.prototype.willValidate).toEqualTypeOf<boolean>();
    expectTypeOf(HTMLElement.prototype.offsetTop).toEqualTypeOf<number>();
    // @ts-expect-error Idl.HTMLAnchorElement declares origin readonly.
    defineReflectedString(HTMLAnchorElement.prototype, "origin", "origin");
    // @ts-expect-error Idl.HTMLTextAreaElement declares willValidate readonly.
    defineReflectedBoolean(HTMLTextAreaElement.prototype, "willValidate", "willvalidate");
    // @ts-expect-error Idl.HTMLElement declares offsetTop readonly.
    defineReflectedLong(HTMLElement.prototype, "offsetTop", "offsettop", 0);
  });

  test("a getter without a setter on a hand-written class counts as readonly", () => {
    expectTypeOf(HTMLTextAreaElement.prototype.type).toEqualTypeOf<string>();
    expectTypeOf(HTMLElement.prototype.isContentEditable).toEqualTypeOf<boolean>();
    // @ts-expect-error HTMLTextAreaElement defines type with a getter only.
    defineReflectedString(HTMLTextAreaElement.prototype, "type", "type");
    // @ts-expect-error HTMLElement defines isContentEditable with a getter only.
    defineReflectedBoolean(HTMLElement.prototype, "isContentEditable", "contenteditable");
  });
});

describe("crossOrigin", () => {
  test("the prototype must have a crossOrigin attribute", () => {
    defineReflectedCrossOrigin(HTMLImageElement.prototype);
    // @ts-expect-error Idl.HTMLDivElement has no crossOrigin.
    defineReflectedCrossOrigin(HTMLDivElement.prototype);
  });

  test("a readonly crossOrigin does not compile", () => {
    const proto = HTMLDivElement.prototype as typeof HTMLDivElement.prototype & {
      readonly crossOrigin: string | null;
    };
    // @ts-expect-error the reflection installs a setter.
    defineReflectedCrossOrigin(proto);
  });
});

describe("nullable and union attributes", () => {
  test("a non-null reflection does not fit a nullable attribute", () => {
    expectTypeOf<Idl.HTMLElement["popover"]>().toEqualTypeOf<string | null>();
    // @ts-expect-error the getter answers "" for a missing attribute, never null.
    defineReflectedEnumWithDefaults(HTMLElement.prototype, "popover", "popover", [], "", "");
    // @ts-expect-error crossOrigin is nullable.
    defineReflectedString(HTMLImageElement.prototype, "crossOrigin", "crossorigin");
  });

  test("the nullable enumeration fits a nullable string attribute only", () => {
    defineReflectedNullableEnum(HTMLElement.prototype, "popover", "popover", [], "", "");
    // @ts-expect-error type is never null.
    defineReflectedNullableEnum(ol, "type", "type", [], "", "");
  });

  test("a reflection of one member's type does not fit a union attribute", () => {
    expectTypeOf<Idl.HTMLElement["hidden"]>().toEqualTypeOf<boolean | number | string | null>();
    // @ts-expect-error hidden is a union.
    defineReflectedBoolean(HTMLElement.prototype, "hidden", "hidden");
    // @ts-expect-error hidden is a union.
    defineReflectedString(HTMLElement.prototype, "hidden", "hidden");
    // @ts-expect-error hidden is a union.
    defineReflectedLong(HTMLElement.prototype, "hidden", "hidden", 0);
    expectTypeOf<Idl.HTMLIFrameElement["srcdoc"]>().toEqualTypeOf<Idl.TrustedHTML | string>();
    // @ts-expect-error the setter also takes a TrustedHTML.
    defineReflectedString(HTMLIFrameElement.prototype, "srcdoc", "srcdoc");
  });

  test("a keyword union fits a string reflection of the same nullability", () => {
    type Mode = "open" | "closed";
    const proto = HTMLDivElement.prototype as typeof HTMLDivElement.prototype & {
      mode: Mode;
      nullableMode: Mode | null;
    };
    defineReflectedEnum(proto, "mode", "mode", ["open", "closed"]);
    defineReflectedNullableEnum(proto, "nullableMode", "mode", ["open", "closed"], null, null);
    // @ts-expect-error nullableMode is nullable.
    defineReflectedEnum(proto, "nullableMode", "mode", ["open", "closed"]);
    // @ts-expect-error mode is never null.
    defineReflectedNullableEnum(proto, "mode", "mode", ["open", "closed"], null, null);
  });
});

describe("defineAttribute", () => {
  test("the accessors see the prototype's type and the attribute's type", () => {
    defineAttribute(HTMLTextAreaElement.prototype, "selectionStart", {
      get() {
        expectTypeOf(this).toEqualTypeOf<HTMLTextAreaElement>();
        return 0;
      },
      set(value) {
        expectTypeOf(this).toEqualTypeOf<HTMLTextAreaElement>();
        expectTypeOf(value).toEqualTypeOf<number>();
      },
    });
  });

  test("the getter must return the attribute's type", () => {
    defineAttribute(HTMLTextAreaElement.prototype, "selectionStart", {
      // @ts-expect-error selectionStart is a number.
      get() {
        return "0";
      },
    });
  });

  test("the setter must take the attribute's type", () => {
    defineAttribute(HTMLTextAreaElement.prototype, "selectionDirection", {
      get: () => "none",
      // @ts-expect-error selectionDirection is a string.
      set(_value: number) {},
    });
  });

  test("a getter is required and a setter is optional", () => {
    defineAttribute(HTMLTextAreaElement.prototype, "validationMessage", { get: () => "" });
    // @ts-expect-error no getter.
    defineAttribute(HTMLTextAreaElement.prototype, "selectionStart", { set() {} });
  });

  test("the name must be a key the prototype's type declares", () => {
    // @ts-expect-error no such attribute.
    defineAttribute(HTMLTextAreaElement.prototype, "selectionStrat", { get: () => 0 });
  });

  test("a readonly attribute takes no setter", () => {
    defineAttribute(HTMLTextAreaElement.prototype, "validationMessage", {
      get: () => "",
      // @ts-expect-error Idl.HTMLTextAreaElement declares validationMessage readonly.
      set() {},
    });
  });
});
