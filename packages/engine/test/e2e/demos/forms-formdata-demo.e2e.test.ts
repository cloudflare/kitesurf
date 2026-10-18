// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-formdata-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <form id="f">
          <input name="user" value="alice">
          <input name="age" value="30">
          <input name="agree" type="checkbox" checked>
          <input name="optout" type="checkbox">
          <input name="color" type="radio" value="red" checked>
          <input name="color" type="radio" value="blue">
          <input name="disabled-field" value="hidden" disabled>
          <textarea name="bio">Hello world</textarea>
          <select name="size">
            <option value="s">Small</option>
            <option value="m" selected>Medium</option>
            <option value="l">Large</option>
          </select>
          <select name="tags" multiple>
            <option value="a" selected>A</option>
            <option value="b" selected>B</option>
            <option value="c">C</option>
          </select>
          <input name="submitter-only" type="submit" value="GO">
          <button id="btn" name="action" value="save">Save</button>
        </form>
      </body></html>`),
  );

  const r = await page.evaluate(() => {
    const checks = [];
    const add = (l, ok, info = "") => checks.push({ l, ok, info });
    const f = document.getElementById("f") as HTMLFormElement;

    const fd = new FormData(f);
    const entries = [...fd.entries()];

    add("8 entries", entries.length === 8, "got " + entries.length);

    add("user = alice", fd.get("user") === "alice");
    add("age = 30", fd.get("age") === "30");
    add("agree present", fd.has("agree"));
    add("optout missing", !fd.has("optout"));
    add("color = red (single radio)", fd.get("color") === "red");
    add("disabled-field skipped", !fd.has("disabled-field"));
    add("bio includes textarea value", fd.get("bio") === "Hello world");
    add("size = m (single select)", fd.get("size") === "m");
    add("tags has both selected", fd.getAll("tags").join(",") === "a,b");
    add("no submitter-only", !fd.has("submitter-only"));
    add("no action (no submitter)", !fd.has("action"));

    const fdWith = new FormData(f, document.getElementById("btn"));
    add("with submitter: action present", fdWith.has("action"));
    add("with submitter: action = save", fdWith.get("action") === "save");

    const m = new FormData();
    m.append("a", "1");
    m.append("a", "2");
    m.append("b", "3");
    add("append duplicates", m.getAll("a").join(",") === "1,2");

    m.set("a", "single");
    add("set replaces and removes dupes", m.getAll("a").join(",") === "single");

    m.delete("b");
    add("delete removes", !m.has("b"));

    const keys = [...m.keys()];
    add("keys iterator", keys.length === 1 && keys[0] === "a");

    let count = 0;
    m.append("c", "x");
    m.append("c", "y");
    m.forEach((_v, _k) => {
      count++;
    });
    add("forEach iterates each entry", count === 3);

    let receivedSubmitter = "MISSING";
    let isSubmitEvent = false;
    f.addEventListener(
      "submit",
      (e) => {
        receivedSubmitter = e.submitter ? e.submitter.id : "null";
        isSubmitEvent = e instanceof SubmitEvent;
        e.preventDefault();
      },
      { once: true },
    );
    f.requestSubmit(document.getElementById("btn"));
    add("SubmitEvent dispatched", isSubmitEvent);
    add("event.submitter = btn", receivedSubmitter === "btn");

    return checks;
  });

  for (const c of r) {
    expect(c.ok, c.info ? `${c.l} (${c.info})` : c.l).toBeTruthy();
  }
});
