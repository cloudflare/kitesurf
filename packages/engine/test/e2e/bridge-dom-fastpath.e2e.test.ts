// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import type { Page } from "@cloudflare/puppeteer";
import { targetIdForSession } from "./connect";

interface FastpathStats {
  fastHits: number;
  brandChecks: number;
  revalidations: number;
  fallbacks: number;
  deoptMask: number;
  hitsByOp: number[];
}

async function fastpathStats(page: Page): Promise<FastpathStats> {
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  const stats = await session.send("Kitesurf.getMemoryStats", { targetId });
  await session.detach().catch(() => {});
  const fp = stats.domFastpath;
  if (!fp) throw new Error(`no domFastpath in ${JSON.stringify(stats).slice(0, 200)}`);
  return fp;
}

const FIXTURE = `
<div id="box" class="a b" data-x="1" title="T"><svg viewBox="0 0 10 10"><rect width="4"></rect></svg></div>
<div id="tree">t1<span id="s1"></span><!--c--><b id="s2"></b>t2</div>
<script>
  // Native-V8 truth snapshot, taken by a baked classic script. The boa
  // side must agree with THESE values, whatever they are — comparing
  // realms pins parity without pinning shim quirks (e.g. the camelCase
  // foreign-attr lookup miss) as spec.
  const box = document.getElementById("box");
  const svg = box.firstElementChild;
  window.__truth = JSON.stringify([
    box.tagName, box.nodeName, box.nodeType, box.id, box.className,
    box.getAttribute("data-x"), box.getAttribute("DATA-X"),
    box.getAttribute("nope"), box.hasAttribute("title"),
    box.hasAttribute("nope"),
    svg.tagName, svg.getAttribute("viewBox"), svg.getAttribute("viewbox"),
  ]);
  window.__patchByAssignment = () => {
    Element.prototype.getAttribute = function (n) { return "patched:" + n; };
  };
  window.__patchChildNodes = () => {
    Object.defineProperty(Element.prototype, "childNodes", {
      get() { return []; }, configurable: true,
    });
  };
  // Tree-shape truth: node-returning ops + contains, same probe the
  // boa side runs. Values don't matter — realm AGREEMENT does.
  window.__treeProbe = () => {
    const tree = document.getElementById("tree");
    const s1 = document.getElementById("s1");
    const s2 = document.getElementById("s2");
    const nn = (n) => (n ? n.nodeName : null);
    return JSON.stringify([
      nn(tree.firstChild), nn(tree.lastChild),
      nn(s1.nextSibling), nn(s1.previousSibling),
      nn(s1.nextElementSibling), nn(s2.previousElementSibling),
      nn(tree.parentNode), nn(s1.parentElement),
      tree.parentNode === document.body,
      s1.parentElement === tree,
      document.documentElement.parentNode === document,
      document.body.contains(s1),
      tree.contains(document.body),
      tree.contains(tree),
      tree.contains(tree.firstChild),
      tree.contains(null),
    ]);
  };
  window.__treeTruth = window.__treeProbe();
</script>`;

test("boa fast-path reads match native-V8 truth, and actually engage", async ({ page }) => {
  await setContent(page, FIXTURE);
  const boaSide = (await page.evaluate(`(() => {
		const box = document.getElementById("box");
		const svg = box.firstElementChild;
		return JSON.stringify([
			box.tagName, box.nodeName, box.nodeType, box.id, box.className,
			box.getAttribute("data-x"), box.getAttribute("DATA-X"),
			box.getAttribute("nope"), box.hasAttribute("title"),
			box.hasAttribute("nope"),
			svg.tagName, svg.getAttribute("viewBox"), svg.getAttribute("viewbox"),
		]);
	})()`)) as string;
  const truth = (await page.evaluate(`window.__truth`)) as string;
  expect(boaSide).toBe(truth);

  expect(
    await page.evaluate(
      `(() => { const b = document.getElementById("box"); return b.getAttribute === b.getAttribute; })()`,
    ),
  ).toBe(true);

  const stats = await fastpathStats(page);
  expect(stats.fastHits).toBeGreaterThan(0);
  expect(stats.deoptMask).toBe(0);
  expect(stats.revalidations).toBeGreaterThan(0);
});

test("node-returning ops + contains match native-V8 truth, with cross-path identity", async ({
  page,
}) => {
  await setContent(page, FIXTURE);
  const boaSide = (await page.evaluate(`(() => {
		const tree = document.getElementById("tree");
		const s1 = document.getElementById("s1");
		const s2 = document.getElementById("s2");
		const nn = (n) => (n ? n.nodeName : null);
		return JSON.stringify([
			nn(tree.firstChild), nn(tree.lastChild),
			nn(s1.nextSibling), nn(s1.previousSibling),
			nn(s1.nextElementSibling), nn(s2.previousElementSibling),
			nn(tree.parentNode), nn(s1.parentElement),
			tree.parentNode === document.body,
			s1.parentElement === tree,
			document.documentElement.parentNode === document,
			document.body.contains(s1),
			tree.contains(document.body),
			tree.contains(tree),
			tree.contains(tree.firstChild),
			tree.contains(null),
		]);
	})()`)) as string;
  const truth = (await page.evaluate(`window.__treeTruth`)) as string;
  expect(boaSide).toBe(truth);
  const stats = await fastpathStats(page);
  expect(stats.fastHits).toBeGreaterThan(0);
  expect(stats.deoptMask).toBe(0);
});

test("a patched dependency deopts its composite dependents", async ({ page }) => {
  await setContent(page, FIXTURE);
  const out = (await page.evaluate(`(() => {
		const tree = document.getElementById("tree");
		const before = tree.firstChild ? tree.firstChild.nodeName : null;
		// Patch childNodes (dep-only surface) from a V8 excursion — the
		// shim's firstChild reads this.childNodes, so the fast path must
		// hand firstChild back to the (patched) slow path.
		window.__patchChildNodes();
		const after = tree.firstChild;
		// And getAttribute → id: the composite id getter must reflect a
		// getAttribute patch even though "id" itself was never touched.
		window.__patchByAssignment();
		const id = tree.id;
		return JSON.stringify([before, after === null, id]);
	})()`)) as string;
  expect(out).toBe(JSON.stringify(["#text", true, "patched:id"]));
  const stats = await fastpathStats(page);
  expect(stats.deoptMask & (1 << 10)).toBeTruthy();
  expect(stats.deoptMask & (1 << 5)).toBeTruthy();
});

test("defineProperty patch from a native-V8 script deopts before any boa read", async ({
  page,
}) => {
  await setContent(
    page,
    `<div id="d" data-k="v"></div>
		 <script>
		   Object.defineProperty(Element.prototype, "getAttribute", {
		     value: function (n) { return "patched:" + n; },
		     writable: true, configurable: true,
		   });
		 </script>`,
  );
  expect(await page.evaluate(`document.getElementById("d").getAttribute("k")`)).toBe("patched:k");
  const stats = await fastpathStats(page);
  expect(stats.deoptMask & 1).toBe(1);
});

test("plain-assignment patch from a mid-eval V8 excursion deopts within the same activation", async ({
  page,
}) => {
  await setContent(page, FIXTURE);
  const out = (await page.evaluate(`(() => {
		const box = document.getElementById("box");
		const before = box.getAttribute("data-x");
		window.__patchByAssignment();
		const after = box.getAttribute("data-x");
		return JSON.stringify([before, after]);
	})()`)) as string;
  expect(out).toBe(JSON.stringify(["1", "patched:data-x"]));
  const stats = await fastpathStats(page);
  expect(stats.deoptMask & 1).toBe(1);
});

test("boa-side prototype patch deopts and sticks across evaluates", async ({ page }) => {
  await setContent(page, `<div id="d" data-k="v"></div>`);
  const first = (await page.evaluate(`(() => {
		Element.prototype.getAttribute = function (n) { return "boa:" + n; };
		return document.getElementById("d").getAttribute("k");
	})()`)) as string;
  expect(first).toBe("boa:k");
  expect(await page.evaluate(`document.getElementById("d").getAttribute("k")`)).toBe("boa:k");
});

test("createElementNS nodes bail to the slow path with correct semantics", async ({ page }) => {
  await setContent(page, `<p>x</p>`);
  const out = (await page.evaluate(`(() => {
		const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
		el.setAttribute("width", "5");
		const nullNs = document.createElementNS("", "Mixed");
		return JSON.stringify([el.tagName, el.getAttribute("width"), nullNs.tagName]);
	})()`)) as string;
  expect(out).toBe(JSON.stringify(["rect", "5", "Mixed"]));
});

test("the fast path looks up parsed attributes by qualified name", async ({ page }) => {
  await setContent(
    page,
    `<svg><g id="u" xlink:href="#legacy" href="#modern"></g></svg>
		 <script>
		   window.__v8QualifiedAttrs = () => {
		     const el = document.getElementById("u");
		     return JSON.stringify([
		       el.getAttribute("xlink:href"), el.hasAttribute("xlink:href"),
		       el.getAttribute("href"), el.hasAttribute("href"),
		     ]);
		   };
		 </script>`,
  );
  const expected = JSON.stringify(["#legacy", true, "#modern", true]);
  const boaSide = (await page.evaluate(`(() => {
		const el = document.getElementById("u");
		return JSON.stringify([
			el.getAttribute("xlink:href"), el.hasAttribute("xlink:href"),
			el.getAttribute("href"), el.hasAttribute("href"),
		]);
	})()`)) as string;
  expect(boaSide).toBe(expected);

  const stats = await fastpathStats(page);
  expect(stats.hitsByOp[0]).toBeGreaterThan(0);
  expect(stats.hitsByOp[1]).toBeGreaterThan(0);

  const v8Side = (await page.evaluate("window.__v8QualifiedAttrs()")) as string;
  expect(v8Side).toBe(expected);
});

// One probe, run twice: as a V8 script (truth) and on boa through the fast
// path. Node results compare by id, and === pins identity with slow-path reads.
const SELECTOR_PROBE = `(() => {
	const tree = document.getElementById("tree");
	const s1 = document.getElementById("s1");
	const nn = (n) => (n ? n.id || n.nodeName : null);
	const ids = (l) => Array.prototype.map.call(l, nn).join(",");
	const err = (f) => { try { f(); return "none"; } catch (e) { return e.name + ":" + (e instanceof DOMException); } };
	// Another document as the receiver, as DOMPurify calls captured methods.
	const other = document.implementation.createHTMLDocument("o");
	other.body.innerHTML = '<p id="o" class="k"><i></i></p>';
	const op = other.getElementById("o");
	return JSON.stringify([
		nn(document.body), nn(document.head),
		document.body === document.querySelector("body"),
		nn(document.getElementById("s2")), document.getElementById("") === null,
		document.getElementById("nope") === null, nn(document.getElementById(42)),
		nn(document.querySelector("#tree b")), nn(tree.querySelector("b")),
		tree.querySelector("div") === null, nn(tree.querySelector(":scope > b")),
		ids(document.querySelectorAll("#tree > *")), ids(tree.querySelectorAll("span, b")),
		document.querySelectorAll("#tree > *").length,
		s1.matches("#tree > span"), s1.matches("b"), nn(s1.closest("div")), s1.closest("p") === null,
		nn(document.querySelector("svg rect")),
		document.querySelector("span::before"), document.querySelectorAll("span::before").length,
		nn(document.querySelector({ toString() { return "#box"; } })),
		err(() => document.querySelector("[")), err(() => s1.matches("[")), err(() => s1.closest("[")),
		document.getElementById("s1") === tree.firstElementChild,
		tree.querySelector("b") === document.getElementById("s2"),
		nn(document.querySelector.call(other, "#o")), nn(document.getElementById.call(other, "o")),
		ids(document.querySelectorAll.call(other, "p, i")), nn(tree.querySelector.call(op, "i")),
		s1.matches.call(op, ".k"), nn(s1.closest.call(op, "body")), s1.getAttribute.call(op, "class"),
		s1.hasAttribute.call(op, "class"), tree.contains.call(op, op.firstChild),
	]);
})()`;

test("selector and document ops match native-V8 truth, with cross-path identity", async ({
  page,
}) => {
  await setContent(
    page,
    `<div id="box" class="a b"><svg viewBox="0 0 10 10"><rect id="r" width="4"></rect></svg></div>
		 <div id="tree">t1<span id="s1"></span><!--c--><b id="s2"></b>t2</div>
		 <script>window.__selTruth = ${SELECTOR_PROBE};</script>`,
  );
  const boaSide = await page.evaluate(SELECTOR_PROBE);
  expect(boaSide).toBe(await page.evaluate(`window.__selTruth`));
  const stats = await fastpathStats(page);
  // querySelector(All), matches, closest on elements and the document ops.
  for (const bit of [17, 18, 19, 20, 21, 22, 23, 24, 25]) {
    expect(stats.hitsByOp[bit], `op ${bit}`).toBeGreaterThan(0);
  }
  expect(stats.deoptMask).toBe(0);
});

test("a document method shadowed from V8 deopts the document ops", async ({ page }) => {
  await setContent(
    page,
    `<div id="d"></div>
		 <script>window.__shadowDoc = () => { document.getElementById = () => "patched"; };</script>`,
  );
  const out = await page.evaluate(`(() => {
		const before = document.getElementById("d").id;
		window.__shadowDoc();
		return JSON.stringify([before, document.getElementById("d")]);
	})()`);
  expect(out).toBe(JSON.stringify(["d", "patched"]));
  const stats = await fastpathStats(page);
  expect(stats.deoptMask & (1 << 21)).toBeTruthy();
});

test("an Element.prototype.matches patch from V8 reaches boa", async ({ page }) => {
  await setContent(
    page,
    `<p id="p"></p>
		 <script>window.__patchMatches = () => { Element.prototype.matches = () => "patched"; };</script>`,
  );
  const out = await page.evaluate(`(() => {
		const p = document.getElementById("p");
		const before = p.matches("p");
		window.__patchMatches();
		return JSON.stringify([before, p.matches("p")]);
	})()`);
  expect(out).toBe(JSON.stringify([true, "patched"]));
  const stats = await fastpathStats(page);
  expect(stats.deoptMask & (1 << 19)).toBeTruthy();
});

// A cached fast method kept the pin handle of the proxy it was first read from. After a
// GC released that pin, every fallback resolved it to undefined.
test("fast-path fallbacks still reach the real method after a GC releases the first proxy", async ({
  page,
}) => {
  await setContent(page, `<div id="a" class="c"><p id="42">x</p></div>`);
  await page.evaluate(() => {
    const a = document.getElementById("a");
    if (!a) throw new Error("missing #a");
    document.querySelector("#a");
    document.querySelectorAll("p");
    a.matches("div");
    a.closest("div");
    a.getAttribute("class");
  });
  const collect = async () => {
    const session = await page.createCDPSession();
    await session.send("Kitesurf.boaForceCollect");
    await session.detach().catch(() => {});
  };
  await collect();
  await page.evaluate(() => 0); // drains the released pins
  await collect();
  const after = await page.evaluate(() => {
    const name = (f: () => unknown) => {
      try {
        return ["value", String(f())];
      } catch (e) {
        // The DOM's errors are V8's: in boa they are bridged objects that fail
        // instanceof Error, so read the name off the object.
        return [
          "threw",
          typeof e === "object" && e !== null ? String(Reflect.get(e, "name")) : String(e),
        ];
      }
    };
    const a = () => {
      const el = document.getElementById("a");
      if (!el) throw new Error("missing #a");
      return el;
    };
    const byId = (id: unknown) => Reflect.apply(document.getElementById, document, [id]);
    return {
      invalidSelector: name(() => document.querySelector("[")),
      pseudoElement: name(() => document.querySelectorAll("div::before").length),
      numericId: name(() => byId(42)?.id),
      invalidMatches: name(() => a().matches("[")),
      objectClosest: name(() => Reflect.apply(a().closest, a(), [{ toString: () => "div" }])?.id),
    };
  });
  expect(after).toEqual({
    invalidSelector: ["threw", "SyntaxError"],
    pseudoElement: ["value", "0"],
    numericId: ["value", "42"],
    invalidMatches: ["threw", "SyntaxError"],
    objectClosest: ["value", "a"],
  });
}, 60_000);
