// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Type tests for defineHTMLClass. Nothing runs them: //packages/dom-shim:types fails on any type
// error here, and `vitest --typecheck.only` reports them by name.

import { assertType, describe, expectTypeOf, test } from "vitest";
import type * as Idl from "../src/idl/types.generated.js";
import type { WrapperInfo } from "../src/node-base.js";
import {
  type HTMLElement,
  InternalElementCtorToken,
  defineHTMLClass,
} from "../src/element/html-element.js";
import * as C from "../src/element/html-classes.js";

declare const info: WrapperInfo;

describe("IDL conformance", () => {
  test("each class's instances implement its IDL interface", () => {
    // The class is HTMLElement plus the members the interface adds, so this fails if an interface
    // narrows a member it inherits from HTMLElement.
    expectTypeOf<InstanceType<typeof C.HTMLAnchorElement>>().toExtend<Idl.HTMLAnchorElement>();
    expectTypeOf<InstanceType<typeof C.HTMLAreaElement>>().toExtend<Idl.HTMLAreaElement>();
    expectTypeOf<InstanceType<typeof C.HTMLBRElement>>().toExtend<Idl.HTMLBRElement>();
    expectTypeOf<InstanceType<typeof C.HTMLBaseElement>>().toExtend<Idl.HTMLBaseElement>();
    expectTypeOf<InstanceType<typeof C.HTMLBodyElement>>().toExtend<Idl.HTMLBodyElement>();
    expectTypeOf<InstanceType<typeof C.HTMLDListElement>>().toExtend<Idl.HTMLDListElement>();
    expectTypeOf<InstanceType<typeof C.HTMLDataElement>>().toExtend<Idl.HTMLDataElement>();
    expectTypeOf<InstanceType<typeof C.HTMLDataListElement>>().toExtend<Idl.HTMLDataListElement>();
    expectTypeOf<InstanceType<typeof C.HTMLDetailsElement>>().toExtend<Idl.HTMLDetailsElement>();
    expectTypeOf<InstanceType<typeof C.HTMLDialogElement>>().toExtend<Idl.HTMLDialogElement>();
    expectTypeOf<
      InstanceType<typeof C.HTMLDirectoryElement>
    >().toExtend<Idl.HTMLDirectoryElement>();
    expectTypeOf<InstanceType<typeof C.HTMLDivElement>>().toExtend<Idl.HTMLDivElement>();
    expectTypeOf<InstanceType<typeof C.HTMLFontElement>>().toExtend<Idl.HTMLFontElement>();
    expectTypeOf<InstanceType<typeof C.HTMLFrameElement>>().toExtend<Idl.HTMLFrameElement>();
    expectTypeOf<InstanceType<typeof C.HTMLFrameSetElement>>().toExtend<Idl.HTMLFrameSetElement>();
    expectTypeOf<InstanceType<typeof C.HTMLHRElement>>().toExtend<Idl.HTMLHRElement>();
    expectTypeOf<InstanceType<typeof C.HTMLHeadElement>>().toExtend<Idl.HTMLHeadElement>();
    expectTypeOf<InstanceType<typeof C.HTMLHeadingElement>>().toExtend<Idl.HTMLHeadingElement>();
    expectTypeOf<InstanceType<typeof C.HTMLHtmlElement>>().toExtend<Idl.HTMLHtmlElement>();
    expectTypeOf<InstanceType<typeof C.HTMLLIElement>>().toExtend<Idl.HTMLLIElement>();
    expectTypeOf<InstanceType<typeof C.HTMLLinkElement>>().toExtend<Idl.HTMLLinkElement>();
    expectTypeOf<InstanceType<typeof C.HTMLMapElement>>().toExtend<Idl.HTMLMapElement>();
    expectTypeOf<InstanceType<typeof C.HTMLMarqueeElement>>().toExtend<Idl.HTMLMarqueeElement>();
    expectTypeOf<InstanceType<typeof C.HTMLMenuElement>>().toExtend<Idl.HTMLMenuElement>();
    expectTypeOf<InstanceType<typeof C.HTMLMetaElement>>().toExtend<Idl.HTMLMetaElement>();
    expectTypeOf<InstanceType<typeof C.HTMLModElement>>().toExtend<Idl.HTMLModElement>();
    expectTypeOf<InstanceType<typeof C.HTMLOListElement>>().toExtend<Idl.HTMLOListElement>();
    expectTypeOf<
      InstanceType<typeof C.HTMLParagraphElement>
    >().toExtend<Idl.HTMLParagraphElement>();
    expectTypeOf<InstanceType<typeof C.HTMLParamElement>>().toExtend<Idl.HTMLParamElement>();
    expectTypeOf<InstanceType<typeof C.HTMLPictureElement>>().toExtend<Idl.HTMLPictureElement>();
    expectTypeOf<InstanceType<typeof C.HTMLPreElement>>().toExtend<Idl.HTMLPreElement>();
    expectTypeOf<InstanceType<typeof C.HTMLQuoteElement>>().toExtend<Idl.HTMLQuoteElement>();
    expectTypeOf<InstanceType<typeof C.HTMLScriptElement>>().toExtend<Idl.HTMLScriptElement>();
    expectTypeOf<InstanceType<typeof C.HTMLSourceElement>>().toExtend<Idl.HTMLSourceElement>();
    expectTypeOf<InstanceType<typeof C.HTMLSpanElement>>().toExtend<Idl.HTMLSpanElement>();
    expectTypeOf<InstanceType<typeof C.HTMLStyleElement>>().toExtend<Idl.HTMLStyleElement>();
    expectTypeOf<
      InstanceType<typeof C.HTMLTableCaptionElement>
    >().toExtend<Idl.HTMLTableCaptionElement>();
    expectTypeOf<InstanceType<typeof C.HTMLTableColElement>>().toExtend<Idl.HTMLTableColElement>();
    expectTypeOf<InstanceType<typeof C.HTMLTemplateElement>>().toExtend<Idl.HTMLTemplateElement>();
    expectTypeOf<InstanceType<typeof C.HTMLTimeElement>>().toExtend<Idl.HTMLTimeElement>();
    expectTypeOf<InstanceType<typeof C.HTMLTitleElement>>().toExtend<Idl.HTMLTitleElement>();
    expectTypeOf<InstanceType<typeof C.HTMLTrackElement>>().toExtend<Idl.HTMLTrackElement>();
    expectTypeOf<InstanceType<typeof C.HTMLUListElement>>().toExtend<Idl.HTMLUListElement>();
    expectTypeOf<InstanceType<typeof C.HTMLUnknownElement>>().toExtend<Idl.HTMLUnknownElement>();
  });

  test("an instance is an HTMLElement with the members its interface adds", () => {
    type Anchor = InstanceType<typeof C.HTMLAnchorElement>;
    expectTypeOf<Anchor>().toExtend<HTMLElement>();
    expectTypeOf<Anchor["href"]>().toEqualTypeOf<Idl.HTMLAnchorElement["href"]>();
    expectTypeOf<Anchor["relList"]>().toEqualTypeOf<Idl.HTMLAnchorElement["relList"]>();
    expectTypeOf<Anchor["toString"]>().toEqualTypeOf<Idl.HTMLAnchorElement["toString"]>();
  });

  test("the prototype has the instance's type", () => {
    expectTypeOf(C.HTMLAnchorElement.prototype).toEqualTypeOf<
      InstanceType<typeof C.HTMLAnchorElement>
    >();
  });

  test("an IDL readonly attribute stays readonly", () => {
    const anchor = C.HTMLAnchorElement.prototype;
    anchor.href = "";
    // @ts-expect-error Idl.HTMLAnchorElement declares origin readonly.
    anchor.origin = "";
  });

  test("a member the IDL lacks is absent", () => {
    // @ts-expect-error Idl.HTMLDivElement has no charset.
    assertType(C.HTMLDivElement.prototype.charset);
    // A gap in type-gaps.json or idl-gaps.json is commented out of the IDL type.
    // @ts-expect-error Idl.HTMLTrackElement leaves out readyState.
    assertType(C.HTMLTrackElement.prototype.readyState);
  });

  test("a legacy extra adds a member the IDL lacks", () => {
    expectTypeOf(C.HTMLAreaElement.prototype.charset).toEqualTypeOf<string>();
    expectTypeOf(C.HTMLAreaElement.prototype.rev).toEqualTypeOf<string>();
  });
});

describe("the name", () => {
  test("selects the IDL interface", () => {
    const OList = defineHTMLClass("HTMLOListElement");
    expectTypeOf(OList.prototype.start).toEqualTypeOf<Idl.HTMLOListElement["start"]>();
    expectTypeOf(OList.prototype).toExtend<Idl.HTMLOListElement>();
  });

  test("must name an HTML element interface", () => {
    // @ts-expect-error Element is not an HTML element interface.
    defineHTMLClass("Element");
    // @ts-expect-error no such interface.
    defineHTMLClass("HTMLDivElemnt");
    const name: string = "HTMLDivElement";
    // @ts-expect-error a name TypeScript cannot pin to one interface.
    defineHTMLClass(name);
  });

  test("an explicit interface must be the named one", () => {
    // @ts-expect-error the name is not HTMLDivElement.
    defineHTMLClass<"HTMLDivElement">("HTMLSpanElement");
  });

  test("extras add members the IDL lacks", () => {
    const Div = defineHTMLClass<"HTMLDivElement", { charset: string }>("HTMLDivElement");
    expectTypeOf(Div.prototype.charset).toEqualTypeOf<string>();
    expectTypeOf(Div.prototype.align).toEqualTypeOf<string>();
  });
});

describe("the constructor", () => {
  test("takes the internal token, so page code cannot construct an element", () => {
    assertType(new C.HTMLDivElement(1, info, InternalElementCtorToken));
    // @ts-expect-error no token.
    assertType(new C.HTMLDivElement(1, info));
    // @ts-expect-error another symbol.
    assertType(new C.HTMLDivElement(1, info, Symbol("kitesurfInternalElementCtor")));
  });

  test("returns an instance of the interface", () => {
    expectTypeOf(new C.HTMLDivElement(1, info, InternalElementCtorToken)).toEqualTypeOf<
      InstanceType<typeof C.HTMLDivElement>
    >();
  });

  test("keeps HTMLElement's statics", () => {
    expectTypeOf(C.HTMLDivElement[Symbol.hasInstance]).toEqualTypeOf<
      (typeof HTMLElement)[typeof Symbol.hasInstance]
    >();
  });
});
