
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

class FakeReactive extends HTMLElement {
  constructor() { super(); this._ctorRan = true; }
  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    queueMicrotask(() => this.render());
  }
}
const L10n = (B) => class extends B {
  l10n = (s) => "l10n:" + s;
};
const WithRender = (B) => class extends L10n(B) {
  #priv() { return "pm"; }
  render() {
    this.shadowRoot.innerHTML = "<b>" + this.#priv() + "-" + this.magic() + "-" + this.l10n("x") + "</b>";
    // Lit-style nested component: template-clone + insertBefore into
    // the shadow root. The nested element must upgrade at CONNECT
    // time (clone bypasses createElement's upgrade hook).
    const t = document.createElement("template");
    t.innerHTML = "<my-nested-widget></my-nested-widget>";
    const frag = document.importNode(t.content, true);
    this.shadowRoot.appendChild(frag);
  }
};
class MyNestedWidget extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = "<i>nested-up</i>";
  }
}
customElements.define("my-nested-widget", MyNestedWidget);
class Base extends FakeReactive {
  magic() { return "42"; }
}
export class MyMixedWidget extends WithRender(Base) {}
customElements.define("my-mixed-widget", MyMixedWidget);
