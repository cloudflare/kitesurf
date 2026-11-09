// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import initialGoldens from "./fixtures/accessibility-golden.json";

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((hash) => typeof hash === "string")
  );
}

function readGoldens(value: unknown): Record<string, string> {
  if (!isStringRecord(value)) {
    throw new Error("Accessibility goldens must be an object of SHA-256 strings");
  }
  return value;
}

function canonicalJson(value: unknown, frameId: string): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Accessibility value is not JSON serializable");
  // The target frame ID is random per test run; canonicalize only its wire fields for stable
  // hashes.
  return json
    .replaceAll(`"frameId":${JSON.stringify(frameId)}`, `"frameId":"<frame>"`)
    .replaceAll(JSON.stringify(`root-${frameId}`), JSON.stringify("root-<frame>"));
}

const inputTypes = [
  "text",
  "email",
  "password",
  "tel",
  "url",
  "search",
  "number",
  "range",
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "image",
  "file",
  "color",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
  "hidden",
  " Hidden ",
];
const ariaValues = [
  "true",
  "false",
  "mixed",
  "",
  "1e1",
  " 0x10 ",
  "0b11",
  "-0",
  "1.5",
  "abc",
  "Infinity",
  "-Infinity",
  "+5",
  ".5",
  "5.",
  "1e",
  "\u00a01\u00a0",
];
const ariaAttributes = [
  "expanded",
  "disabled",
  "required",
  "readonly",
  "selected",
  "modal",
  "multiline",
  "multiselectable",
  "atomic",
  "busy",
  "checked",
  "pressed",
  "haspopup",
  "keyshortcuts",
  "roledescription",
  "autocomplete",
  "orientation",
  "live",
  "relevant",
  "placeholder",
  "valuetext",
  "valuemin",
  "valuemax",
  "valuenow",
  "setsize",
  "posinset",
  "colcount",
  "rowcount",
  "colindex",
  "rowindex",
  "colspan",
  "rowspan",
  "level",
];

// A 322-level document crashes during layout in the current e2e runtime; 321 was the largest
// depth that completed the isolated full-tree probe. The Rust-only test covers 5,000 levels.
const DEEP_DOCUMENT_DEPTH = 321;

const documents = [
  {
    name: "landmarks and form fixture defaults",
    html: `<!doctype html><html><head><meta charset="utf-8"><title>a11y</title></head><body>
      <header><h1>Site Title</h1></header><nav aria-label="Primary"><ul>
      <li><a href="/home">Home</a></li><li><a href="/about" aria-label="About us">About</a></li>
      </ul></nav><main><h2 id="form-heading">Sign up</h2><form aria-labelledby="form-heading">
      <label for="email">Email address</label><input id="email" type="email" required placeholder="you@example.com">
      <label for="pw">Password</label><input id="pw" type="password" required>
      <label><input type="checkbox" name="tos"> Accept terms</label><fieldset><legend>Plan</legend>
      <label><input type="radio" name="plan" value="free" checked>Free</label>
      <label><input type="radio" name="plan" value="pro">Pro</label></fieldset>
      <input type="range" name="vol" min="0" max="10" value="5">
      <button type="submit">Create account</button><button type="button" disabled>Cancel</button>
      </form><section aria-label="Gallery"><img src="/x.png" alt="A puppy"><img src="/y.png" alt="">
      <button aria-pressed="false" aria-label="Like"><img src="/heart.png" alt=""></button></section>
      <div role="alert" id="err">Something went wrong</div><div aria-describedby="err"><button>Retry</button></div>
      </main><footer><p>Footer text</p></footer></body></html>`,
  },
  {
    name: "landmarks and form fixture",
    html: `<!doctype html><html><head><meta charset="utf-8"><title>a11y</title></head><body>
      <header><h1>Site Title</h1></header><nav aria-label="Primary"><ul>
      <li><a href="/home">Home</a></li><li><a href="/about" aria-label="About us">About</a></li>
      </ul></nav><main><h2 id="form-heading">Sign up</h2><form aria-labelledby="form-heading">
      <label for="email">Email address</label><input id="email" type="email" required placeholder="you@example.com">
      <label for="pw">Password</label><input id="pw" type="password" required>
      <label><input type="checkbox" name="tos"> Accept terms</label><fieldset><legend>Plan</legend>
      <label><input type="radio" name="plan" value="free" checked>Free</label>
      <label><input type="radio" name="plan" value="pro">Pro</label></fieldset>
      <input type="range" name="vol" min="0" max="10" value="5">
      <button type="submit">Create account</button><button type="button" disabled>Cancel</button>
      </form><section aria-label="Gallery"><img src="/x.png" alt="A puppy"><img src="/y.png" alt="">
      <button aria-pressed="false" aria-label="Like"><img src="/heart.png" alt=""></button></section>
      <div role="alert" id="err">Something went wrong</div><div aria-describedby="err"><button>Retry</button></div>
      </main><footer><p>Footer text</p></footer></body></html>`,
    setup: `document.querySelector('#email').value='typed@example.com';
      document.querySelector('[name=tos]').checked=true; document.querySelector('[value=pro]').checked=true`,
  },
  {
    name: "visibility and semantics fixture",
    html: `<!doctype html><html><head><meta charset="utf-8"><title>a11y parity</title></head><body>
      <div id="gone" style="display:none"><button>never-emitted-1</button><a href="/x">never-emitted-2</a><p>never-emitted-3</p></div>
      <div id="invis" style="visibility:hidden"><button>also-hidden</button><button id="reshown" style="visibility:visible">climbs-back</button></div>
      <table id="layout"><tr><td>layout-cell-a</td><td>layout-cell-b</td></tr></table>
      <table id="data"><caption>Quarterly</caption><tr><th scope="col">Q</th><th scope="col">Revenue</th></tr><tr><td>Q1</td><td>100</td></tr></table>
      <div id="ah" aria-hidden="true"><button id="ah-child">inherited-hidden</button></div>
      <button id="pop" aria-haspopup="true">Open menu</button><button id="pop-listbox" aria-haspopup="listbox">Choose</button>
      <div id="plain"><span id="plainspan">generic text</span></div><p id="para">   <span>real text</span>   </p>
      <a id="rel" href="/relative/path?q=1">Relative link</a><a id="akey" href="/shortcut" accesskey="k">Shortcut link</a>
      <img id="relimg" src="/img/logo.png" alt="Logo"><ul><li id="outer">Outer item<ul><li id="inner">Inner item</li></ul></li></ul>
      <div id="tabdiv" tabindex="0">Focusable div</div><button id="offbtn" disabled>Disabled button</button></body></html>`,
  },
  {
    name: "partial fixture",
    html: "<!doctype html><div id=x style='display:none'>hidden</div><div id=y>bare</div>",
  },
  {
    name: "bridge fixture",
    html: "<div id='scope'><input value='old'><button>Save</button><div style='display:none'>Gone</div></div>",
    setup: "document.querySelector('input').value='live'",
  },
  {
    name: "live select fixture",
    html: `<!doctype html><title>Sort</title><form id="f">
      <select id="s"><option value="ann" selected>Announcement date</option><option value="sub">Submission date</option></select>
      <select id="m" multiple><option>Red</option><option selected>Green</option><option>Blue</option></select>
      <select id="d"><option value="x">First x</option><option value="x">Second x</option></select>
      <select id="p"><option>Plain one</option><option>Plain two</option></select></form>`,
  },
  {
    name: "live select mutations",
    html: `<!doctype html><title>Sort</title><form id="f">
      <select id="s"><option value="ann" selected>Announcement date</option><option value="sub">Submission date</option></select>
      <select id="m" multiple><option>Red</option><option selected>Green</option><option>Blue</option></select>
      <select id="d"><option value="x">First x</option><option value="x">Second x</option></select>
      <select id="p"><option>Plain one</option><option>Plain two</option></select></form>`,
    setup: `document.getElementById('s').selectedIndex=-1; document.getElementById('m').options[0].selected=true; document.getElementById('d').selectedIndex=1`,
  },
  {
    name: "select value mutation",
    html: `<!doctype html><title>Sort</title><form id="f">
      <select id="s"><option value="ann" selected>Announcement date</option><option value="sub">Submission date</option></select>
      <select id="m" multiple><option>Red</option><option selected>Green</option><option>Blue</option></select>
      <select id="d"><option value="x">First x</option><option value="x">Second x</option></select>
      <select id="p"><option>Plain one</option><option>Plain two</option></select></form>`,
    setup: `document.getElementById('s').value='sub'`,
  },
  {
    name: "select reset after mutations",
    html: `<!doctype html><title>Sort</title><form id="f">
      <select id="s"><option value="ann" selected>Announcement date</option><option value="sub">Submission date</option></select>
      <select id="m" multiple><option>Red</option><option selected>Green</option><option>Blue</option></select>
      <select id="d"><option value="x">First x</option><option value="x">Second x</option></select>
      <select id="p"><option>Plain one</option><option>Plain two</option></select></form>`,
    setup: `document.getElementById('s').selectedIndex=-1; document.getElementById('m').options[0].selected=true; document.getElementById('d').selectedIndex=1; document.getElementById('f').reset()`,
  },
  {
    name: "hidden select fixture",
    html: `<!doctype html><title>Hidden</title>
      <select id="menu"><option>Menu shown</option><option style="display:none">Menu inline hidden</option><option id="later">Menu script hidden</option></select>
      <select id="grouped"><optgroup label="Kept"><option>Group shown</option></optgroup><optgroup label="Dropped" style="display:none"><option>Group hidden</option></optgroup></select>
      <select id="list" size="3"><option>List shown</option><option style="color:red; display: none !important">List hidden</option></select>
      <select id="multi" multiple><option>Multi shown</option><option style="display:none">Multi hidden</option></select>`,
    setup: "document.getElementById('later').style.display='none'",
  },
  {
    name: "select markup defaults",
    html: `<select><option selected>One</option><option selected>Two</option></select>
      <select><optgroup label="G" disabled><option>Off</option></optgroup><option>On</option></select>
      <select size="3"><option>A</option><option>B</option></select><select size="4"><option>Four</option><option>Five</option></select>
      <select size="1"><option disabled>Nope</option><option>Yes</option></select>`,
  },
  {
    name: "inputs and labels",
    html: `<form>${inputTypes.map((type, i) => `<label for="input${i}">Label ${i}</label><input id="input${i}" type="${type}" value="5" placeholder="placeholder" min="-1" max="10">`).join("")}
      <label>Wrapped <input placeholder="wrapped"></label><label>Deep ${"<span>".repeat(9)}<input placeholder="deep">${"</span>".repeat(9)}</label>
      <label for="same">First label</label><label for="same">Second label</label><label for="missing">Missing</label><input id="same">
      <button>Button <span>inside</span></button><textarea placeholder="area">initial</textarea>
      <div contenteditable="true">editable</div><div contenteditable="false">fixed</div><div contenteditable="">empty</div><div contenteditable="plaintext-only">plain</div></form>`,
    setup: `document.querySelector('#input0').value='changed'; document.querySelector('#input8').checked=true; document.querySelector('textarea').value='changed area'`,
  },
  {
    name: "tables and lists",
    html: `<table summary="Data"><tr><td scope="row">scope</td><td>value</td></tr></table>
      <table><caption>Caption</caption><tr><th>heading</th><td>value</td></tr></table>
      <table><tr><td>outer<table><tr><th>nested data</th></tr></table></td></tr></table>
      <table role="table"><tr><td>explicit</td></tr></table>
      <ul><li>one<ol><li>two<ul><li aria-level="7">three</li></ul></li></ol></li></ul><menu><li>menu</li></menu>`,
  },
  {
    name: "visibility",
    html: `<div hidden><span>hidden</span></div><div aria-hidden="true"><span>aria hidden</span></div>
      <div style="display:none"><button>gone</button></div><div style="visibility:hidden"><span>invisible</span><span style="visibility:visible">visible</span></div>
      <input type=" Hidden "><select><option style="display:block;display:none !important;display:block">hidden option</option><option>shown</option></select>`,
  },
  {
    name: "aria properties and numbers",
    html: ariaValues
      .map(
        (value, i) =>
          `<div role="slider" aria-label="aria ${i}" ${ariaAttributes.map((attr) => `aria-${attr}="${value}"`).join(" ")}>item</div>`,
      )
      .join(""),
  },
  {
    name: "links and names with base",
    html: `<base href="https://example.test/a/b/"><base href="https://ignored.test/"><h1>One</h1><h2 aria-level="3">Two</h2>
      <a href="../target?q=1">relative</a><a href="https://example.org/a">absolute</a><a>no href</a>
      <img src="../i.png" alt="Image"><img alt=""><img src="https://example.org/i.png"><area href="/a" alt="area">
      <svg><title>Vector title</title><rect width="2" height="2"></rect></svg><figure><figcaption>Figure</figcaption></figure>
      <fieldset><legend>Legend</legend><input></fieldset><details open><summary>Summary</summary>Detail</details>`,
  },
  {
    name: "links without base",
    html: `<a href="/relative">relative</a><a href="https://example.org/a">absolute</a><img src="/a" alt="image">`,
  },
  {
    name: "names and descriptions",
    html: `<span id="dup">First</span><span id="dup">Last</span><span id="description">Description</span>
      <button aria-labelledby="missing dup description" aria-describedby="missing description dup">ignored</button>
      <button aria-label="  Label  " aria-description="  Details  ">contents</button>
      <div role="  button  switch " aria-label="Role">role</div><button title=" fallback "> </button>
      <label for="unknown">orphan</label><div aria-labelledby="missing">fallback</div>`,
  },
  {
    name: "shadow and frame",
    html: `<div id="open"><span slot="x">light</span><b>other</b></div><div id="closed">closed light</div><iframe srcdoc="&lt;button&gt;frame&lt;/button&gt;"></iframe>`,
    setup: `document.getElementById('open').attachShadow({mode:'open'}).innerHTML='<slot name="x"></slot><button>open shadow</button>'; document.getElementById('closed').attachShadow({mode:'closed'}).innerHTML='<span>closed shadow</span>'`,
  },
  {
    name: "text and escapes",
    html: `<p>Entities &amp; &quot; &lt; &gt; &#1; &#31; &nbsp; A\u00a0B\ufeffC\u2028D\tE "quoted" \\ slash 😀 漢字</p><div id="controls"></div>`,
    setup: String.raw`document.getElementById('controls').appendChild(document.createTextNode('\u0001\u001f\n\t"\\😀'))`,
  },
  {
    name: "deep document",
    html: `${"<div>".repeat(DEEP_DOCUMENT_DEPTH)}deep${"</div>".repeat(DEEP_DOCUMENT_DEPTH)}`,
  },
];

type Method =
  | "Accessibility.getFullAXTree"
  | "Accessibility.getRootAXNode"
  | "Accessibility.getPartialAXTree"
  | "Accessibility.getChildAXNodes"
  | "Accessibility.getAXNodeAndAncestors"
  | "Accessibility.queryAXTree";

// Regenerate with `KS_AX_GOLDEN_WRITE=1 pnpm run test:e2e accessibility-rust-parity`.
// These goldens were captured from the deleted TypeScript accessibility builder.
test("Rust accessibility JSON matches every accessibility method", async ({ page, cdpSession }) => {
  const regenerate = process.env.KS_AX_GOLDEN_WRITE === "1";
  const expectedGoldens = readGoldens(initialGoldens);
  const actualGoldens: Record<string, string> = {};
  const counts: Record<Method, number> = {
    "Accessibility.getFullAXTree": 0,
    "Accessibility.getRootAXNode": 0,
    "Accessibility.getPartialAXTree": 0,
    "Accessibility.getChildAXNodes": 0,
    "Accessibility.getAXNodeAndAncestors": 0,
    "Accessibility.queryAXTree": 0,
  };
  const mismatches: string[] = [];
  let documentName = "";
  let frameId = "";
  let completedDocuments = 0;
  const compare = (method: Method, params: object, result: unknown): void => {
    const goldenKey = `${documentName}|${method}|${canonicalJson(params, frameId)}`;
    const actualJson = JSON.stringify(result);
    if (actualJson === undefined) throw new Error("Accessibility result is not JSON serializable");
    const hash = createHash("sha256").update(canonicalJson(result, frameId)).digest("hex");
    actualGoldens[goldenKey] = hash;
    if (!regenerate && expectedGoldens[goldenKey] !== hash) {
      const preview = actualJson.length > 2048 ? `${actualJson.slice(0, 2048)}…` : actualJson;
      const mismatch = `key=${goldenKey}: golden SHA-256 expected ${expectedGoldens[goldenKey] ?? "missing"}, actual ${hash}; actual JSON=${preview}`;
      mismatches.push(mismatch);
      if (mismatches.length <= 10) console.error(mismatch);
    }
    counts[method]++;
  };

  try {
    for (const doc of documents) {
      documentName = doc.name;
      await setContent(page, doc.html);
      if ("setup" in doc && doc.setup) await page.evaluate(doc.setup);
      frameId = (await cdpSession.send("Page.getFrameTree")).frameTree.frame.id;
      const full = await cdpSession.send("Accessibility.getFullAXTree");
      if (doc.name === "deep document") {
        expect(full.nodes.length).toBeGreaterThanOrEqual(DEEP_DOCUMENT_DEPTH);
      }
      compare("Accessibility.getFullAXTree", {}, full);
      compare(
        "Accessibility.getRootAXNode",
        {},
        await cdpSession.send("Accessibility.getRootAXNode"),
      );
      const nodes = full.nodes.filter((node) => /^\d+$/.test(node.nodeId));
      const { root: domRoot } = await cdpSession.send("DOM.getDocument", { depth: 0 });
      const elementIds: number[] = [];
      for (const selector of ["html", "body", "body *"]) {
        const { nodeId } = await cdpSession.send("DOM.querySelector", {
          nodeId: domRoot.nodeId,
          selector,
        });
        expect(nodeId, `${doc.name}: ${selector}`).toBeGreaterThan(0);
        elementIds.push(nodeId);
      }
      for (const nodeId of elementIds) {
        for (const fetchRelatives of [true, false]) {
          const params = { nodeId, fetchRelatives };
          compare(
            "Accessibility.getPartialAXTree",
            params,
            await cdpSession.send("Accessibility.getPartialAXTree", params),
          );
        }
        const params = { nodeId };
        compare(
          "Accessibility.getAXNodeAndAncestors",
          params,
          await cdpSession.send("Accessibility.getAXNodeAndAncestors", params),
        );
      }
      compare(
        "Accessibility.getPartialAXTree",
        {},
        await cdpSession.send("Accessibility.getPartialAXTree", {}),
      );
      compare(
        "Accessibility.getAXNodeAndAncestors",
        {},
        await cdpSession.send("Accessibility.getAXNodeAndAncestors", {}),
      );
      const text = nodes.find((node) => node.role?.value === "StaticText");
      const root = full.nodes[0];
      if (!root || !text) throw new Error(`${doc.name}: expected root and text nodes`);
      for (const id of [root.nodeId, String(elementIds[1]), text.nodeId, "bogus", "05"]) {
        const params = { id };
        compare(
          "Accessibility.getChildAXNodes",
          params,
          await cdpSession.send("Accessibility.getChildAXNodes", params),
        );
      }
      const backendNodeId = elementIds[1];
      if (backendNodeId === undefined) throw new Error(`${doc.name}: missing scoped query id`);
      for (const params of [
        {},
        { backendNodeId },
        { role: "button" },
        { accessibleName: "" },
        { role: "" },
        { accessibleName: "Save" },
        { backendNodeId, role: "button", accessibleName: "" },
      ]) {
        compare(
          "Accessibility.queryAXTree",
          params,
          await cdpSession.send("Accessibility.queryAXTree", params),
        );
      }
      completedDocuments++;
    }
    if (regenerate) {
      writeFileSync(
        new URL("./fixtures/accessibility-golden.json", import.meta.url),
        `${JSON.stringify(actualGoldens, null, 2)}\n`,
      );
    } else {
      expect(Object.keys(actualGoldens).sort()).toEqual(Object.keys(expectedGoldens).sort());
    }
  } finally {
    console.log(
      `accessibility parity: ${completedDocuments}/${documents.length} documents; ${JSON.stringify(counts)}; mismatches=${mismatches.length}`,
    );
  }
  expect(mismatches, "accessibility golden hash mismatches").toEqual([]);
}, 600_000);
