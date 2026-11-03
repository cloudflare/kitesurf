// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const V8_SIDE = `<!doctype html>
<html><head><meta charset="utf-8" /></head><body>
<script>
  // A React.Component stand-in, baked into V8.
  function Component(props) { this.props = props; this.refs = {}; }
  Component.prototype.isReactComponent = {};
  Component.prototype.setState = function () {};
  globalThis.Component = Component;

  // V8-side consumer of a bridged boa function: bind/call/apply must be
  // V8's natives (not boa's reached through the proxy), instanceof must
  // hold for instances V8 constructed, and own statics must read through.
  globalThis.__ksProbeFn = function () {
    var K = globalThis.__K;
    var inst = new K(1);
    var B = K.bind(null);
    return {
      boundIsFn: typeof B === "function",
      boundNew: new B(9).v,
      called: K.call({}, 1) === undefined,
      isInstance: inst instanceof K,
      protoIdentity: Object.getPrototypeOf(inst) === K.prototype,
      tag: K.tag,
      hasCall: K.call === Function.prototype.call,
      hasBind: K.bind === Function.prototype.bind,
      toStringOk: typeof Function.prototype.toString.call(K) === "string",
    };
  };

  globalThis.__ksProbeFunctionPrototype = function (fp) {
    return {
      hasCall: fp.call === Function.prototype.call,
      hasApply: fp.apply === Function.prototype.apply,
      hasBind: fp.bind === Function.prototype.bind,
      hasToString: fp.toString === Function.prototype.toString,
    };
  };

  // Describe bridged functions' own \`prototype\` the way V8 sees it. The
  // gopd trap must mirror Boa's writability WITHOUT tripping V8's proxy
  // invariants (a non-writable report over a still-writable target slot
  // is a TypeError), and it runs here synchronously inside the boa->V8
  // excursion that minted the functions — a boa frame is live throughout.
  // Positional arguments on purpose: a function read OFF a bridged object
  // comes through as a receiver-bound method trampoline, not the proxy a
  // function crossing by itself gets.
  globalThis.__ksDescribeProto = function (names) {
    var out = {};
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var f = arguments[i + 1];
      try {
        var d = Object.getOwnPropertyDescriptor(f, "prototype");
        out[name] = {
          keys: Reflect.ownKeys(f).indexOf("prototype") >= 0,
          hasPrototype: "prototype" in f,
          writable: d.writable,
          configurable: d.configurable,
          value: d.value === undefined ? "undefined" : d.value === f.prototype ? "same-as-get" : "other",
        };
      } catch (e) {
        out[name] = { threw: String(e && e.message || e) };
      }
    }
    return out;
  };

  // A WebIDL-style V8 class (dom-shim's Typed OM shape): brand-checked
  // prototype method + accessor, and a constructor that calls them on
  // \`this\` — which, for a boa subclass, is the instance V8 built from
  // the subclass's bridged prototype.
  var isProtoOf = Object.prototype.isPrototypeOf;
  function Brand(v) {
    this._v = v;
    this.text = this.describe();
    this.value = v;
  }
  Brand.prototype.describe = function () {
    if (!isProtoOf.call(Brand.prototype, this)) throw new TypeError("Illegal invocation");
    return "brand:" + this._v;
  };
  Object.defineProperty(Brand.prototype, "value", {
    get: function () {
      if (!isProtoOf.call(Brand.prototype, this)) throw new TypeError("Illegal invocation");
      return this._v;
    },
    set: function (v) {
      if (!isProtoOf.call(Brand.prototype, this)) throw new TypeError("Illegal invocation");
      this._v = v;
      this.text = this.describe();
    },
    configurable: true,
  });
  globalThis.Brand = Brand;
  // V8-side reads on an instance of a boa subclass of Brand.
  globalThis.__ksReadInst = function (inst, Sub) {
    try {
      return {
        describe: inst.describe(),
        value: inst.value,
        extra: inst.extra(),
        ownKeys: Object.keys(inst),
        ctorIsSub: inst.constructor === Sub,
        isSub: inst instanceof Sub,
        isBrand: inst instanceof Brand,
        superIsBrand: Object.getPrototypeOf(Sub) === Brand,
      };
    } catch (e) {
      return { threw: String(e && e.message || e) };
    }
  };

  // A Closure-style base: the constructor sets the fields its prototype methods and
  // accessor read back through \`this\`, so a wrong receiver loses them.
  function Target() { this.listeners = {}; this.self = this; }
  Target.prototype.listen = function (type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  };
  Target.prototype.dispatch = function (type) {
    var ls = this.self.listeners[type] || [];
    for (var i = 0; i < ls.length; i++) ls[i]();
    return ls.length;
  };
  Target.prototype.whoAmI = function () { return this; };
  Object.defineProperty(Target.prototype, "selfGetter", {
    get: function () { return this; },
    configurable: true,
  });
  Target.whoAmI = function () { return this; };
  globalThis.Target = Target;
  globalThis.inheritsFrom = function (child, parent) {
    function T() {}
    T.prototype = parent.prototype;
    child.prototype = new T();
    child.prototype.constructor = child;
  };

  globalThis.__ksForIn = function (inst) {
    var out = [];
    for (var k in inst) out.push(k);
    return out;
  };

  // React's constructClassInstance + applyDerivedStateFromProps, roughly.
  globalThis.__ksMount = function (Ctor, props) {
    try {
      var isClass = !!(Ctor.prototype && Ctor.prototype.isReactComponent);
      var inst = new Ctor(props);
      var state = inst.state == null ? null : inst.state;
      var derived = typeof Ctor.getDerivedStateFromProps === "function"
        ? Ctor.getDerivedStateFromProps(props, state)
        : "none";
      return {
        isClass: isClass,
        stateKeys: state ? Object.keys(state) : null,
        instKeys: Object.keys(inst),
        protoKeysLeaked: Object.keys(Component.prototype),
        derived: derived,
        defaultProps: Ctor.defaultProps || null,
        displayName: Ctor.displayName || null,
        ownKeys: Reflect.ownKeys(Ctor).map(String),
        protoDescConfigurable: Object.getOwnPropertyDescriptor(Ctor, "prototype").configurable,
        protoDescWritable: Object.getOwnPropertyDescriptor(Ctor, "prototype").writable,
        called: Ctor === Component ? "UNWRAPPED-TO-SUPER" : "own",
      };
    } catch (e) {
      return { threw: String(e && e.message || e) };
    }
  };
</script>
</body></html>`;

const BOA_SIDE = `(() => {
  function _defineProperty(o, k, v) { if (k in o) Object.defineProperty(o, k, { value: v, enumerable: true, configurable: true, writable: true }); else o[k] = v; return o; }
  function _assertThisInitialized(s) { if (s === void 0) throw new ReferenceError("this hasn't been initialised"); return s; }
  function _setPrototypeOf(o, p) { return (_setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function (o, p) { o.__proto__ = p; return o; })(o, p); }
  function _getPrototypeOf(o) { return (_getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf.bind() : function (o) { return o.__proto__ || Object.getPrototypeOf(o); })(o); }
  function _inherits(sub, sup) { sub.prototype = Object.create(sup && sup.prototype, { constructor: { value: sub, writable: true, configurable: true } }); Object.defineProperty(sub, "prototype", { writable: false }); if (sup) _setPrototypeOf(sub, sup); }
  function _isNativeReflectConstruct() { try { var t = !Boolean.prototype.valueOf.call(Reflect.construct(Boolean, [], function () {})); } catch (t) {} return (_isNativeReflectConstruct = function () { return !!t; })(); }
  function _possibleConstructorReturn(self, call) { if (call && (typeof call === "object" || typeof call === "function")) return call; if (call !== void 0) throw new TypeError("Derived constructors may only return object or undefined"); return _assertThisInitialized(self); }
  function _createSuper(Derived) { var hasNative = _isNativeReflectConstruct(); return function () { var Super = _getPrototypeOf(Derived), result; if (hasNative) { var NewTarget = _getPrototypeOf(this).constructor; result = Reflect.construct(Super, arguments, NewTarget); } else { result = Super.apply(this, arguments); } return _possibleConstructorReturn(this, result); }; }
  var List = (function (_Component) {
    _inherits(List, _Component);
    var _super = _createSuper(List);
    function List() {
      var _this;
      for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) args[_key] = arguments[_key];
      _defineProperty(_assertThisInitialized(_this = _super.call.apply(_super, [this].concat(args))), "state", { keyEntities: [] });
      _defineProperty(_assertThisInitialized(_this), "removeKey", function (k) { return k; });
      return _this;
    }
    List.getDerivedStateFromProps = function (props, prevState) { return { keyEntities: prevState.keyEntities.length + props.keys.length }; };
    List.defaultProps = { component: "div" };
    List.displayName = "CSSMotionList";
    return List;
  })(Component);
  return __ksMount(List, { keys: [1, 2, 3] });
})()`;

test("a babel-transpiled boa subclass of a V8 class mounts like React expects", async ({
  page,
}) => {
  await setContent(page, V8_SIDE, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(BOA_SIDE)) as Record<string, unknown>;
  expect(out.threw).toBeUndefined();
  expect(out.called).toBe("own");
  expect(out.isClass).toBe(true);
  expect(out.stateKeys).toEqual(["keyEntities"]);
  expect(out.instKeys).toEqual(expect.arrayContaining(["props", "refs", "state", "removeKey"]));
  expect(out.protoKeysLeaked).toEqual(["isReactComponent", "setState"]);
  expect(out.derived).toEqual({ keyEntities: 3 });
  expect(out.defaultProps).toEqual({ component: "div" });
  expect(out.displayName).toBe("CSSMotionList");
  expect(out.ownKeys).toEqual(
    expect.arrayContaining(["prototype", "getDerivedStateFromProps", "defaultProps"]),
  );
  expect(out.protoDescConfigurable).toBe(false);
  expect(out.protoDescWritable).toBe(false);
});

test("a boa function with a V8 function as its [[Prototype]] is not unwrapped to it", async ({
  page,
}) => {
  await setContent(page, V8_SIDE, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`(() => {
    var r = {};
    function G() { r.ran = true; this.z = 1; }
    Object.setPrototypeOf(G, Component);
    var m = __ksMount(G, {});
    r.called = m.called; r.instKeys = m.instKeys; r.threw = m.threw;
    return r;
  })()`)) as Record<string, unknown>;
  expect(out.threw).toBeUndefined();
  expect(out.ran).toBe(true);
  expect(out.called).toBe("own");
  expect(out.instKeys).toEqual(["z"]);
});

test("a set through a bridged prototype lands on the receiver", async ({ page }) => {
  await setContent(page, V8_SIDE, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`(() => {
    var d = Object.create(Component.prototype);
    d.z = 1;
    d.z = 2;
    // An inherited V8 setter still runs, with the receiver as \`this\`.
    Object.defineProperty(Component.prototype, "viaSetter", { set: function (v) { this.setterSaw = v; }, configurable: true });
    d.viaSetter = "s";
    return {
      own: Object.keys(d),
      z: d.z,
      leaked: Object.keys(Component.prototype).filter((k) => k === "z" || k === "setterSaw"),
      setterSaw: d.setterSaw,
    };
  })()`)) as Record<string, unknown>;
  expect(out.own).toEqual(["z", "setterSaw"]);
  expect(out.z).toBe(2);
  expect(out.leaked).toEqual([]);
  expect(out.setterSaw).toBe("s");
});

test("a V8 method a boa object inherits runs with that object as `this`", async ({ page }) => {
  await setContent(page, V8_SIDE, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`(async () => {
    const t = (f) => { try { return f(); } catch (e) { return "threw: " + (e && e.message || e); } };
    function Sub() { Target.call(this); this.own = 1; }
    inheritsFrom(Sub, Target);
    const viaCall = new Sub();
    const viaCreate = Object.create(Target.prototype);
    Target.call(viaCreate);
    const r = {};
    for (const [name, inst] of [["call", viaCall], ["create", viaCreate]]) {
      let fired = 0;
      r[name] = {
        listen: t(() => inst.listen("x", () => fired++)),
        dispatched: t(() => inst.dispatch("x")),
        fired,
        self: t(() => inst.whoAmI() === inst),
        getter: t(() => inst.selfGetter === inst),
        explicit: t(() => Target.prototype.whoAmI.call(inst) === inst),
        hasOwn: t(() => inst.hasOwnProperty("listeners")),
        identity: t(() => inst.whoAmI === Object.getPrototypeOf(inst).whoAmI),
      };
    }
    r.timer = await new Promise((resolve) => setTimeout(() => resolve(t(() => viaCall.dispatch("x"))), 0));
    r.xhr = await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "http://127.0.0.1:8787/__fixtures/policy-script.js");
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) resolve(t(() => viaCreate.dispatch("x")));
      };
      xhr.onerror = () => resolve("xhr error");
      xhr.send();
    });
    function Static() {}
    Object.setPrototypeOf(Static, Target);
    r.staticSelf = t(() => Static.whoAmI() === Static);
    class Klass extends Target {}
    r.instanceOf = t(() => [new Klass() instanceof Klass, new Target() instanceof Klass]);
    r.global = await new Promise((resolve) => {
      addEventListener("ks-probe", () => resolve(true), { once: true });
      setTimeout(() => dispatchEvent(new Event("ks-probe")), 0);
    });
    return r;
  })()`)) as Record<string, unknown>;
  const inherited = {
    listen: undefined,
    dispatched: 1,
    fired: 1,
    self: true,
    getter: true,
    explicit: true,
    hasOwn: true,
    identity: true,
  };
  expect(out.call).toEqual(inherited);
  expect(out.create).toEqual(inherited);
  expect(out.timer).toBe(1);
  expect(out.xhr).toBe(1);
  expect(out.staticSelf).toBe(true);
  expect(out.instanceOf).toEqual([true, false]);
  expect(out.global).toBe(true);
});

test("V8 reads through a boa subclass prototype resolve on the V8 super with the receiver", async ({
  page,
}) => {
  await setContent(page, V8_SIDE, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`(() => {
    class Sub extends globalThis.Brand {
      extra() { return this.value * 2; }
    }
    const r = {};
    try {
      const inst = new Sub(21);
      r.text = inst.text;
      r.boaExtra = inst.extra();
      inst.value = 5;
      r.afterSet = [inst.value, inst._v, inst.text];
      r.v8 = __ksReadInst(inst, Sub);
      r.isSubBoa = inst instanceof Sub;
    } catch (e) {
      r.threw = String(e && e.message || e);
    }
    return r;
  })()`)) as Record<string, unknown>;
  expect(out.threw).toBeUndefined();
  expect(out.text).toBe("brand:21");
  expect(out.boaExtra).toBe(42);
  expect(out.afterSet).toEqual([5, 5, "brand:5"]);
  expect(out.v8).toEqual({
    describe: "brand:5",
    value: 5,
    extra: 10,
    ownKeys: ["_v", "text"],
    ctorIsSub: true,
    isSub: true,
    isBrand: true,
    superIsBrand: true,
  });
  expect(out.isSubBoa).toBe(true);
});

test("a bridged function's `prototype` descriptor mirrors Boa's writability", async ({ page }) => {
  await setContent(page, V8_SIDE, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`(() => {
    function Plain() {}
    class Klass { m() {} }
    const arrow = () => 1;
    async function asyncFn() {}
    const method = ({ m() {} }).m;
    function Dated() {}
    Object.setPrototypeOf(Dated, Date);
    Dated.prototype = Date.prototype;
    const r = __ksDescribeProto(["Plain", "Klass", "arrow", "asyncFn", "method", "Dated"], Plain, Klass, arrow, asyncFn, method, Dated);
    // Reading the descriptor changed nothing: the functions still work.
    r.after = { plain: new Plain() instanceof Plain, klass: new Klass().m === Klass.prototype.m, arrow: arrow() };
    return r;
  })()`)) as Record<string, Record<string, unknown>>;
  expect(out.Plain).toEqual({
    keys: true,
    hasPrototype: true,
    writable: true,
    configurable: false,
    value: "same-as-get",
  });
  expect(out.Klass).toEqual({
    keys: true,
    hasPrototype: true,
    writable: false,
    configurable: false,
    value: "same-as-get",
  });
  for (const name of ["arrow", "asyncFn", "method"]) {
    expect(out[name], name).toEqual({
      keys: true,
      hasPrototype: true,
      writable: false,
      configurable: false,
      value: "undefined",
    });
  }
  expect(out.Dated).toEqual({
    keys: true,
    hasPrototype: true,
    writable: true,
    configurable: false,
    value: "same-as-get",
  });
  expect(out.after).toEqual({ plain: true, klass: true, arrow: 1 });
});

test("Function.prototype methods and instanceof on a bridged boa function stay V8's", async ({
  page,
}) => {
  await setContent(page, V8_SIDE, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`(() => {
    function K(v) { this.v = v; }
    K.prototype.get = function () { return this.v; };
    K.tag = "static";
    globalThis.__K = K;
    return __ksProbeFn();
  })()`)) as Record<string, unknown>;
  expect(out).toEqual({
    boundIsFn: true,
    boundNew: 9,
    called: true,
    isInstance: true,
    protoIdentity: true,
    tag: "static",
    hasCall: true,
    hasBind: true,
    toStringOk: true,
  });

  const functionProto = (await page.evaluate(
    `__ksProbeFunctionPrototype(Function.prototype)`,
  )) as Record<string, unknown>;
  expect(functionProto).toEqual({
    hasCall: true,
    hasApply: true,
    hasBind: true,
    hasToString: true,
  });
});

test("V8 for-in sees Boa's real prototype enumerability", async ({ page }) => {
  await setContent(page, V8_SIDE, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`(() => {
    class Klass { constructor() { this.a = 1; } m() {} }
    Klass.prototype.p = 2;
    function Legacy() { this.a = 1; }
    Legacy.prototype.m = function () {};
    return {
      klass: __ksForIn(new Klass()),
      legacy: __ksForIn(new Legacy()),
    };
  })()`)) as Record<string, unknown>;
  expect(out).toEqual({ klass: ["a", "p"], legacy: ["a", "m"] });
});

test("boa class instances clone across every structured-clone boundary", async ({ page }) => {
  await setContent(page, V8_SIDE, { waitUntil: "domcontentloaded" });
  const out = (await page.evaluate(`(async () => {
    class K { constructor() { this.a = 1; } }
    const direct = structuredClone(new K());
    const nested = structuredClone([new K()]);

    const windowMessage = new Promise((resolve) => {
      window.addEventListener("message", (event) => resolve(event.data), { once: true });
      window.postMessage(new K(), "*");
    });
    const channelMessage = new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      channel.port2.postMessage(new K());
    });
    const broadcast = new BroadcastChannel("clone-probe");
    broadcast.postMessage(new K());
    broadcast.close();

    return {
      direct,
      nested,
      windowMessage: await windowMessage,
      channelMessage: await channelMessage,
      broadcast: "ok",
    };
  })()`)) as Record<string, unknown>;
  expect(out).toEqual({
    direct: { a: 1 },
    nested: [{ a: 1 }],
    windowMessage: { a: 1 },
    channelMessage: { a: 1 },
    broadcast: "ok",
  });
});
