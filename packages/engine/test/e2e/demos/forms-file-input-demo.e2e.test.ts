// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-file-input-idl", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><body>
        <input id="f" type="file">
        <input id="t" type="text">
      </body>`),
  );
  const r = await page.evaluate(() => {
    const checks: { label: string; ok: boolean; info?: string }[] = [];
    const add = (label: string, ok: boolean, info: any = "") =>
      checks.push({ label, ok, info: String(info) });
    const f = document.getElementById("f") as any;
    const t = document.getElementById("t") as any;

    add("files is FileList-shaped", !!f.files && typeof f.files.item === "function");
    add("files.length 0", f.files.length === 0);
    add("SameObject while unchanged", f.files === f.files);
    add("text input files is null", t.files === null);
    add("value empty", f.value === "");

    const dt = new (window as any).DataTransfer();
    dt.items.add(new File(["hello world"], "a.txt", { type: "text/plain" }));
    dt.items.add(new File(["binary"], "b.bin"));
    add("dt.files.length", dt.files.length === 2);
    add("dt.types includes Files", dt.types.includes("Files"));
    f.files = dt.files;
    add("assigned length", f.files.length === 2);
    add("file name", f.files[0].name === "a.txt");
    add("item()", f.files.item(1).name === "b.bin");
    add("iterable", [...f.files].length === 2);
    add(
      "fakepath value",
      f.value === "C:\\\\fakepath\\\\a.txt" || f.value === "C:\\fakepath\\a.txt",
      f.value,
    );
    add("instanceof File", f.files[0] instanceof File);

    const form = document.createElement("form");
    form.appendChild(f);
    f.setAttribute("name", "upload");
    const fd = new FormData(form);
    const got = fd.getAll("upload");
    add("FormData entries", got.length === 2, got.length);
    add("FormData entry name", (got[0] as any).name === "a.txt");

    f.value = "";
    add("cleared", f.files.length === 0);

    dt.setData("text/plain", "clip");
    add("getData round-trip", dt.getData("text") === "clip");

    return checks;
  });
  const failed = r.filter((c: any) => !c.ok);
  if (failed.length) console.error(JSON.stringify(failed, null, 1));
  expect(failed).toEqual([]);
});

test("forms-file-input-multipart-post", async ({ page }) => {
  // Served from the fixture host: an opaque (data:) document may not navigate to loopback.
  await page.goto(
    "http://127.0.0.1:8787/__fixtures/policy-doc.html?body=" +
      encodeURIComponent(`
        <form id="fm" method="post" enctype="multipart/form-data"
              action="http://127.0.0.1:8787/__fixtures/form-echo">
          <input type="file" name="doc">
          <input type="text" name="note" value="hi">
          <input id="s" type="submit">
        </form>
        <script>
          const dt = new DataTransfer();
          dt.items.add(new File(["file-content-123"], "report.txt", { type: "text/plain" }));
          document.querySelector('input[type=file]').files = dt.files;
        </script>
      </body>`),
  );
  await Promise.all([page.waitForNavigation(), page.click("#s")]);
  const echo = await page.evaluate(() => ({
    method: document.getElementById("method")?.textContent,
    ctype: document.getElementById("ctype")?.textContent,
    body: document.getElementById("body")?.textContent,
  }));
  expect(echo.method).toBe("POST");
  expect(echo.ctype).toContain("multipart/form-data; boundary=");
  expect(echo.body).toContain('name="doc"; filename="report.txt"');
  expect(echo.body).toContain("Content-Type: text/plain");
  expect(echo.body).toContain("file-content-123");
  expect(echo.body).toContain('name="note"');
  expect(echo.body).toContain("hi");
});
