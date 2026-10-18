// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Assembles element and form classes in dependency order and installs shared element behavior.

import { DOMRectReadOnly, DOMRect, DOMRectList } from "./rect.js";
import "./reflect.js";
import { installIdlHandlersOn } from "./event-handlers.js";
import {
  runCloneSteps,
  runCloneStepsDeep,
  inputStateOf,
  inputTypeOf,
  inputValueMode,
  uncheckSiblingRadios,
} from "./forms/input-state.js";
import {
  resolveFormOwner,
  isFormListed,
  isDisabledInFormContext,
  formListedDescendants,
} from "./forms/listed.js";
import { selectOptions, resyncSelectLabel } from "./forms/select-options.js";
import { supportsSelection, selectionStateOf, installSelectionMixin } from "./forms/selection.js";
import {
  isValidEmail,
  isValidUrl,
  computeValidity,
  willValidate,
  makeValidityState,
  ValidityStateImpl,
  installValidityMixin,
} from "./forms/validity.js";
import { isLabelable, labelsForControl } from "./forms/labelable.js";
import "./forms/submission.js";
import { notifyImageResults, notifyStylesheetResults } from "./load-events.js";
import { Element, parseFragmentInContext } from "./element.js";
import "./aria.js";
import { HTMLElement, defineHTMLClass, InternalElementCtorToken } from "./html-element.js";
import { HTMLInputElement } from "./forms/input.js";
import { HTMLTextAreaElement } from "./forms/textarea.js";
import { HTMLSelectElement, HTMLOptionElement, HTMLOptGroupElement } from "./forms/select.js";
import { HTMLButtonElement } from "./forms/button.js";
import { HTMLLabelElement } from "./forms/label.js";
import { HTMLFieldSetElement, HTMLLegendElement } from "./forms/fieldset.js";
import { HTMLOutputElement } from "./forms/output.js";
import { HTMLFormElement } from "./forms/form.js";
import { HTMLProgressElement, HTMLMeterElement } from "./forms/meter.js";
import {
  HTMLDataListElement,
  HTMLAnchorElement,
  HTMLAreaElement,
  HTMLPictureElement,
  HTMLSourceElement,
  HTMLDivElement,
  HTMLSpanElement,
  HTMLParagraphElement,
  HTMLHeadingElement,
  HTMLBodyElement,
  HTMLHtmlElement,
  HTMLHeadElement,
  HTMLTitleElement,
  HTMLScriptElement,
  HTMLLinkElement,
  HTMLMetaElement,
  HTMLStyleElement,
  HTMLBaseElement,
  HTMLBRElement,
  HTMLHRElement,
  HTMLPreElement,
  HTMLQuoteElement,
  HTMLUListElement,
  HTMLOListElement,
  HTMLLIElement,
  HTMLDListElement,
  HTMLMenuElement,
  HTMLTableCaptionElement,
  HTMLTableColElement,
  HTMLTemplateElement,
  HTMLTimeElement,
  HTMLDetailsElement,
  HTMLDialogElement,
  HTMLModElement,
  HTMLDataElement,
  HTMLMapElement,
  HTMLTrackElement,
  HTMLParamElement,
  HTMLDirectoryElement,
  HTMLFontElement,
  HTMLFrameElement,
  HTMLFrameSetElement,
  HTMLMarqueeElement,
  HTMLUnknownElement,
} from "./html-classes.js";
import { HTMLIFrameElement, HTMLEmbedElement, HTMLObjectElement } from "./embedded.js";
import "./svg.js";
import { HTMLMediaElement, HTMLAudioElement, HTMLVideoElement } from "./media.js";
import { HTMLImageElement } from "./image.js";
import {
  HTMLTableElement,
  HTMLTableSectionElement,
  HTMLTableRowElement,
  HTMLTableCellElement,
} from "./table.js";
import { HTMLCanvasElement } from "./canvas.js";
import { applyDeclarativeShadowRoots, HTMLSlotElement } from "./shadow.js";
import "./tag-attributes.js";
import { resolveElementClass } from "./resolve.js";

installIdlHandlersOn(Element.prototype);

export const HTML_ELEMENT_INTERFACES = {
  HTMLInputElement,
  HTMLTextAreaElement,
  HTMLSelectElement,
  HTMLOptionElement,
  HTMLOptGroupElement,
  HTMLButtonElement,
  HTMLLabelElement,
  HTMLFieldSetElement,
  HTMLLegendElement,
  HTMLOutputElement,
  HTMLDataListElement,
  HTMLProgressElement,
  HTMLMeterElement,
  HTMLFormElement,
  HTMLAnchorElement,
  HTMLAreaElement,
  HTMLImageElement,
  HTMLPictureElement,
  HTMLSourceElement,
  HTMLDivElement,
  HTMLSpanElement,
  HTMLParagraphElement,
  HTMLHeadingElement,
  HTMLBodyElement,
  HTMLHtmlElement,
  HTMLHeadElement,
  HTMLTitleElement,
  HTMLScriptElement,
  HTMLLinkElement,
  HTMLMetaElement,
  HTMLStyleElement,
  HTMLBaseElement,
  HTMLBRElement,
  HTMLHRElement,
  HTMLPreElement,
  HTMLQuoteElement,
  HTMLUListElement,
  HTMLOListElement,
  HTMLLIElement,
  HTMLDListElement,
  HTMLMenuElement,
  HTMLTableElement,
  HTMLTableRowElement,
  HTMLTableCellElement,
  HTMLTableSectionElement,
  HTMLTableCaptionElement,
  HTMLTableColElement,
  HTMLIFrameElement,
  HTMLVideoElement,
  HTMLAudioElement,
  HTMLMediaElement,
  HTMLCanvasElement,
  HTMLEmbedElement,
  HTMLObjectElement,
  HTMLTemplateElement,
  HTMLSlotElement,
  HTMLTimeElement,
  HTMLDetailsElement,
  HTMLDialogElement,
  HTMLModElement,
  HTMLDataElement,
  HTMLMapElement,
  HTMLTrackElement,
  HTMLParamElement,
  HTMLDirectoryElement,
  HTMLFontElement,
  HTMLFrameElement,
  HTMLFrameSetElement,
  HTMLMarqueeElement,
  HTMLUnknownElement,
} as const;

export {
  Element,
  HTMLElement,
  HTMLInputElement,
  HTMLTextAreaElement,
  HTMLSelectElement,
  HTMLOptionElement,
  HTMLOptGroupElement,
  HTMLButtonElement,
  HTMLLabelElement,
  HTMLFieldSetElement,
  HTMLOutputElement,
  HTMLProgressElement,
  HTMLMeterElement,
  HTMLFormElement,
  HTMLAnchorElement,
  HTMLAreaElement,
  HTMLImageElement,
  HTMLTitleElement,
  HTMLScriptElement,
  HTMLLinkElement,
  HTMLMetaElement,
  HTMLStyleElement,
  HTMLBaseElement,
  HTMLTableElement,
  HTMLTableRowElement,
  HTMLTableSectionElement,
  HTMLObjectElement,
  HTMLDetailsElement,
  HTMLDialogElement,
  resolveElementClass,
  defineHTMLClass,
  runCloneSteps,
  runCloneStepsDeep,
  inputStateOf,
  inputTypeOf,
  inputValueMode,
  uncheckSiblingRadios,
  resolveFormOwner,
  selectOptions,
  resyncSelectLabel,
  supportsSelection,
  selectionStateOf,
  installSelectionMixin,
  isValidEmail,
  isValidUrl,
  computeValidity,
  willValidate,
  makeValidityState,
  ValidityStateImpl,
  installValidityMixin,
  isLabelable,
  labelsForControl,
  isFormListed,
  isDisabledInFormContext,
  formListedDescendants,
  installIdlHandlersOn,
  InternalElementCtorToken,
  DOMRectReadOnly,
  DOMRect,
  DOMRectList,
  notifyImageResults,
  notifyStylesheetResults,
  applyDeclarativeShadowRoots,
  parseFragmentInContext,
};
