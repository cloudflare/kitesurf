// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PAGE = `<!doctype html><html><head><title>XPath</title>
<link rel="stylesheet" href="/a.css"><link as="fetch" rel="preload" href="/maps/preview?pb=1">
<script>
  window.__init = document.evaluate("//link[@as='fetch' and @rel='preload']", document.head, null,
    XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue.getAttribute("href");
  try { document.evaluate("//li", document, null, XPathResult.NUMBER_TYPE, null).singleNodeValue; window.__native = "no error"; }
  catch (e) { window.__native = e.name; }
</script></head>
<body><h1 id="top">Title  here </h1>
<nav><a href="/one" id="b">One</a> <a HREF="/two" id="c">Two</a></nav>
<ul id="list"><li>1</li><li>2</li><li>3</li><li>4</li></ul>
<p>alpha<!-- note -->beta</p>
<svg><circle r="1"></circle></svg>
</body></html>`;

const PROBE = `(() => {
  const X = XPathResult;
  const ev = (e, t = 0, ctx = document) => document.evaluate(e, ctx, null, t, null);
  const snap = (e, ctx) => { const r = ev(e, X.ORDERED_NODE_SNAPSHOT_TYPE, ctx); return Array.from({ length: r.snapshotLength }, (_, i) => r.snapshotItem(i)); };
  const text = (nodes) => nodes.map((n) => n.nodeType === 2 ? n.value : n.textContent);
  const err = (f) => { try { f(); return "no error"; } catch (e) { return e.name; } };
  const it = ev("//li", X.ORDERED_NODE_ITERATOR_TYPE);
  const first = it.iterateNext().textContent;
  const second = it.iterateNext().textContent;
  document.getElementById("list").appendChild(document.createElement("li"));
  const invalid = it.invalidIteratorState;
  const afterMutation = err(() => it.iterateNext());
  document.getElementById("list").lastChild.remove();
  return {
    init: window.__init,
    nativeWrongAccessor: window.__native,
    globals: [typeof XPathResult, X.FIRST_ORDERED_NODE_TYPE, typeof XPathEvaluator, typeof XPathExpression],
    anyType: ev("//li").resultType,
    upperCase: snap("//LI").length,
    svgUnprefixed: snap("//svg").length,
    svgByLocalName: snap("//*[local-name()='svg']").length,
    positions: text(snap("//li[position() > 2]")),
    lastItem: text(snap("//li[last()]")),
    reverseAxis: text(snap("//li[3]/preceding-sibling::li[1]")),
    ancestor: snap("//a[1]/ancestor::*[1]")[0].localName,
    union: snap("//p | //h1").map((n) => n.localName),
    attrs: text(snap("//a/@href")),
    attrCaseInsensitive: text(snap("//a[@HREF='/two']")),
    textNodes: text(snap("//p/text()")),
    relative: text(snap("li[2]", document.getElementById("list"))),
    parent: snap("..", document.getElementById("list"))[0].localName,
    ids: text(snap("id('c b')")),
    count: ev("count(//li)", X.NUMBER_TYPE).numberValue,
    string: ev("string(//h1)", X.STRING_TYPE).stringValue,
    normalized: ev("normalize-space(//h1)", X.STRING_TYPE).stringValue,
    boolean: ev("boolean(//nav) and not(//table)", X.BOOLEAN_TYPE).booleanValue,
    substring: ev("substring('12345', 1.5, 2.6)", X.STRING_TYPE).stringValue,
    translate: ev("translate('bar', 'abc', 'ABC')", X.STRING_TYPE).stringValue,
    sum: ev("sum(//li)", X.NUMBER_TYPE).numberValue,
    arithmetic: ev("7 mod 3 + 2 * 3 div 4 - -1", X.NUMBER_TYPE).numberValue,
    infinity: ev("string(1 div 0)", X.STRING_TYPE).stringValue,
    bigNumber: ev("string(1000000 * 1000000 * 1000000000)", X.STRING_TYPE).stringValue,
    compareSets: ev("//li = 3", X.BOOLEAN_TYPE).booleanValue,
    expression: document.createExpression("//a").evaluate(document, X.ORDERED_NODE_SNAPSHOT_TYPE).snapshotLength,
    evaluator: new XPathEvaluator().evaluate("name(//nav/*[2])", document, null, X.STRING_TYPE, null).stringValue,
    iterator: [first, second, invalid, afterMutation],
    syntaxError: err(() => ev("//[")),
    namespaceError: err(() => ev("//x:y")),
    typeError: err(() => ev("count(//li)", X.ORDERED_NODE_SNAPSHOT_TYPE)),
    illegalConstructor: err(() => new XPathResult()),
  };
})()`;

test("document.evaluate answers as Chrome does, during parse and after", async ({ page }) => {
  await setContent(page, PAGE);
  const r = (await page.evaluate(PROBE)) as Record<string, unknown>;
  expect(r).toEqual({
    init: "/maps/preview?pb=1",
    nativeWrongAccessor: "TypeError",
    globals: ["function", 9, "function", "function"],
    anyType: 4,
    upperCase: 4,
    svgUnprefixed: 0,
    svgByLocalName: 1,
    positions: ["3", "4"],
    lastItem: ["4"],
    reverseAxis: ["2"],
    ancestor: "nav",
    union: ["h1", "p"],
    attrs: ["/one", "/two"],
    attrCaseInsensitive: ["Two"],
    textNodes: ["alpha", "beta"],
    relative: ["2"],
    parent: "body",
    ids: ["One", "Two"],
    count: 4,
    string: "Title  here ",
    normalized: "Title here",
    boolean: true,
    substring: "234",
    translate: "BAr",
    sum: 10,
    arithmetic: 3.5,
    infinity: "Infinity",
    bigNumber: "1000000000000000000000",
    compareSets: true,
    expression: 2,
    evaluator: "a",
    iterator: ["1", "2", true, "InvalidStateError"],
    syntaxError: "SyntaxError",
    namespaceError: "NamespaceError",
    typeError: "TypeError",
    illegalConstructor: "TypeError",
  });
}, 60_000);

test("document.evaluate reuses a supplied XPathResult", async ({ page }) => {
  await setContent(
    page,
    `<p id="first">first</p><p id="second">second</p>
    <script>
      window.__bigintXPathType = () => {
        try {
          document.evaluate("count(//p)", document, null, BigInt(1), null);
          return "";
        } catch (error) {
          return error.name;
        }
      };
    </script>`,
  );

  const actual = await page.evaluate(() => {
    const result = document.evaluate(
      "//p",
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    const reused = document.evaluate(
      "//p[@id='second']",
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      result,
    );
    let invalidResult = "";
    try {
      document.evaluate("//p", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, {} as never);
    } catch (error) {
      invalidResult = (error as Error).name;
    }
    const coercedTypes = [
      document.evaluate("count(//p)", document, null, 1.9 as never, null).resultType,
      document.evaluate("count(//p)", document, null, 65_536 as never, null).resultType,
    ];
    return {
      sameObject: reused === result,
      snapshotLength: result.snapshotLength,
      secondId: (result.snapshotItem(0) as Element | null)?.id ?? null,
      invalidResult,
      coercedTypes,
    };
  });

  const bigintType = await page.evaluate("window.__bigintXPathType()");
  expect({ ...actual, bigintType }).toEqual({
    sameObject: true,
    snapshotLength: 1,
    secondId: "second",
    invalidResult: "TypeError",
    bigintType: "TypeError",
    coercedTypes: [1, 1],
  });
}, 60_000);

test("XPathResult constants are read-only on the interface and its prototype", async ({ page }) => {
  await setContent(page, "<ul><li>1</li></ul>");
  const r = await page.evaluate(`(() => {
    const res = document.evaluate("//li", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    XPathResult.ANY_TYPE = 42;
    res.NUMBER_TYPE = 42;
    return [res.ORDERED_NODE_SNAPSHOT_TYPE, XPathResult.prototype.FIRST_ORDERED_NODE_TYPE, XPathResult.ANY_TYPE, res.NUMBER_TYPE];
  })()`);
  expect(r).toEqual([7, 9, 0, 1]);
}, 60_000);

test("XPathNSResolver preserves callback semantics and converts return values", async ({
  page,
}) => {
  await setContent(page, "<root></root>");

  const result = await page.evaluate(() => {
    let gets = 0;
    let calls = 0;
    let correctThis = true;
    let resolvedPrefix = "";
    const lookup = function (this: unknown, prefix: string) {
      calls++;
      correctThis = correctThis && this === resolver;
      resolvedPrefix = prefix;
      return "";
    };
    const resolver = {
      get lookupNamespaceURI() {
        gets++;
        return lookup;
      },
    };
    const evaluate = (namespaceResolver: unknown) =>
      document.evaluate(
        "/foo:bar",
        document.documentElement,
        namespaceResolver as never,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );

    const emptyNamespace = evaluate(resolver).snapshotLength;
    evaluate(resolver);
    const primitiveReturns = [0, false].map((value) => evaluate(() => value).resultType);
    const nullishErrors = [null, undefined].map((value) => {
      try {
        evaluate(() => value);
        return "no error";
      } catch (error) {
        return (error as DOMException).name;
      }
    });
    let symbolError = "";
    try {
      evaluate(() => Symbol("namespace"));
    } catch (error) {
      symbolError = (error as Error).name;
    }
    return {
      gets,
      calls,
      correctThis,
      resolvedPrefix,
      emptyNamespace,
      primitiveReturns,
      nullishErrors,
      symbolError,
    };
  });

  expect(result).toEqual({
    gets: 2,
    calls: 2,
    correctThis: true,
    resolvedPrefix: "foo",
    emptyNamespace: 0,
    primitiveReturns: [7, 7],
    nullishErrors: ["NamespaceError", "NamespaceError"],
    symbolError: "NamespaceError",
  });
}, 60_000);

test("XPath id() searches the parsed XML document tree", async ({ page }) => {
  await setContent(page, "<div></div>");
  const result = await page.evaluate(() => {
    const xml = new DOMParser().parseFromString(
      '<root><item id="first"></item><item id="second"></item></root>',
      "text/xml",
    );
    const selectIds = (expression: string) => {
      const result = xml.evaluate(
        expression,
        xml.documentElement,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      return Array.from({ length: result.snapshotLength }, (_, i) =>
        (result.snapshotItem(i) as Element | null)?.getAttribute("id"),
      );
    };
    return {
      contentType: xml.contentType,
      treeIds: selectIds("//item"),
      idIds: selectIds('id("first second")'),
    };
  });

  expect(result).toEqual({
    contentType: "text/xml",
    treeIds: ["first", "second"],
    idIds: ["first", "second"],
  });
}, 60_000);

test("DOMParser XPath resolvers resolve parsed namespace declarations", async ({ page }) => {
  await setContent(page, "<div></div>");

  const namespaces = await page.evaluate(() => {
    const xml = new DOMParser().parseFromString(
      '<html xmlns:p="urn:example"><body><item></item></body></html>',
      "text/xml",
    );
    const root = xml.documentElement;
    const item = xml.querySelector("item");
    if (!root || !item) throw new Error("Parsed XML document is missing its root or item");
    return [
      xml.createNSResolver(xml).lookupNamespaceURI("p"),
      xml.createNSResolver(root).lookupNamespaceURI("p"),
      xml.createNSResolver(item).lookupNamespaceURI("p"),
      xml.createNSResolver(item).lookupNamespaceURI("missing"),
    ];
  });

  expect(namespaces).toEqual(["urn:example", "urn:example", "urn:example", null]);
}, 60_000);

test("HTML-parsed SVG attributes retain their namespace in XPath", async ({ page }) => {
  await setContent(
    page,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><path id="target" xlink:href="#source"></path></svg>`,
  );
  const result = await page.evaluate(() => {
    const path = document.querySelector("path")!;
    const attr = path.getAttributeNode("xlink:href");
    const selected = document.evaluate(
      "//svg:path[@xlink:href]",
      document,
      (prefix) =>
        prefix === "xlink"
          ? "http://www.w3.org/1999/xlink"
          : prefix === "svg"
            ? "http://www.w3.org/2000/svg"
            : null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue;
    return {
      attr: attr && [attr.name, attr.prefix, attr.localName, attr.namespaceURI, attr.value],
      value: path.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
      selectedPath: selected === path,
    };
  });

  expect(result).toEqual({
    attr: ["xlink:href", "xlink", "href", "http://www.w3.org/1999/xlink", "#source"],
    value: "#source",
    selectedPath: true,
  });
}, 60_000);

test("an Object.prototype member name is not an XPath function", async ({ page }) => {
  await setContent(page, "<ul><li>1</li></ul>");
  const r =
    await page.evaluate(`["constructor()", "toString()", "hasOwnProperty('x')", "__proto__()"].map((e) => {
    try { document.evaluate(e, document, null, 0, null); return "no error"; }
    catch (err) { return err instanceof DOMException ? err.name : "not a DOMException: " + err; }
  })`);
  expect(r).toEqual(["SyntaxError", "SyntaxError", "SyntaxError", "SyntaxError"]);
}, 60_000);

test("an XPath iterator survives paint-only changes and dies on a tree change", async ({
  page,
}) => {
  await setContent(
    page,
    `<div style="height:3000px"><ul><li>1</li><li>2</li></ul><canvas></canvas><p id="p">text</p></div>`,
  );
  const iterator = (name: string) =>
    `window.${name} = document.evaluate("//li", document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null)`;
  await page.evaluate(`(() => {
    ${iterator("__it")};
    document.querySelector("canvas").getContext("2d").fillRect(0, 0, 10, 10);
    window.scrollTo(0, 200);
    getSelection().selectAllChildren(document.getElementById("p"));
  })()`);
  await page.setViewport({ width: 700, height: 500 });
  const paintOnly = await page.evaluate(`(() => {
    const invalid = __it.invalidIteratorState;
    try { return [invalid, __it.iterateNext().textContent]; } catch (e) { return [invalid, e.name]; }
  })()`);
  const treeChanges = await page.evaluate(`(() => {
    const p = document.getElementById("p");
    ${iterator("__attr")}; p.setAttribute("data-x", "1");
    ${iterator("__data")}; p.firstChild.data = "changed";
    ${iterator("__child")}; p.append("more");
    return [__attr.invalidIteratorState, __data.invalidIteratorState, __child.invalidIteratorState];
  })()`);
  expect({ paintOnly, treeChanges }).toEqual({
    paintOnly: [false, "1"],
    treeChanges: [true, true, true],
  });
}, 60_000);
