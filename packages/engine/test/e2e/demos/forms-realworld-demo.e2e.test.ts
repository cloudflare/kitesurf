// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

declare global {
  interface Window {
    __submissions?: Array<Record<string, unknown>>;
  }
}

function firstSubmission(submissions: Window["__submissions"]): Record<string, unknown> {
  return submissions?.[0] ?? {};
}

test("forms-realworld-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <form id="form">
          <label>Name <input name="name" required minlength="2"></label>
          <label>Email <input name="email" type="email" required></label>
          <label>Color
            <select name="color" required>
              <option value="">Choose</option>
              <option value="red">Red</option>
              <option value="green">Green</option>
              <option value="blue">Blue</option>
            </select>
          </label>
          <fieldset>
            <legend>Newsletter</legend>
            <label><input name="newsletter" type="checkbox" value="weekly"> Weekly</label>
            <label><input name="newsletter" type="checkbox" value="monthly" checked> Monthly</label>
          </fieldset>
          <label>Plan
            <input type="radio" name="plan" value="free" checked> Free
            <input type="radio" name="plan" value="pro"> Pro
          </label>
          <textarea name="bio" maxlength="200"></textarea>
          <button id="submit-btn">Submit</button>
        </form>
        <output id="result"></output>
        <script>
          window.__submissions = [];
          const form = document.getElementById("form");
          form.addEventListener("submit", (e) => {
            e.preventDefault();
            if (!form.checkValidity()) {
              window.__submissions.push({ validationFailed: true });
              return;
            }
            const data = new FormData(form, e.submitter);
            const obj = {};
            for (const [k, v] of data.entries()) {
              if (k in obj) {
                if (!Array.isArray(obj[k])) obj[k] = [obj[k]];
                obj[k].push(v);
              } else {
                obj[k] = v;
              }
            }
            window.__submissions.push(obj);
          });
        </script>
      </body></html>`),
  );

  await page.click("#submit-btn");
  let subs = await page.evaluate(() => window.__submissions);
  expect(
    firstSubmission(subs).validationFailed,
    "empty form rejected by checkValidity",
  ).toBeTruthy();

  await page.evaluate(() => {
    window.__submissions = [];
  });
  await page.type('input[name="name"]', "Alice");
  await page.type('input[name="email"]', "alice@example.com");
  await page.evaluate(() => {
    document.querySelector<HTMLSelectElement>('select[name="color"]').value = "green";
    document.querySelector<HTMLTextAreaElement>('textarea[name="bio"]').value =
      "Hello from kitesurf!";
  });

  await page.click("#submit-btn");
  subs = await page.evaluate(() => window.__submissions);
  expect(firstSubmission(subs).name, "name not Alice").toBe("Alice");
  expect(firstSubmission(subs).email, "email wrong").toBe("alice@example.com");
  expect(firstSubmission(subs).color, "color wrong").toBe("green");
  expect(firstSubmission(subs).plan, "plan wrong").toBe("free");
  expect(firstSubmission(subs).newsletter, "newsletter wrong").toBe("monthly");

  await page.evaluate(() => {
    window.__submissions = [];
  });
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('input[name="plan"][value="pro"]').checked = true;
  });
  await page.click("#submit-btn");
  subs = await page.evaluate(() => window.__submissions);
  expect(firstSubmission(subs).plan, "plan should be pro").toBe("pro");

  await page.evaluate(() => {
    window.__submissions = [];
  });
  await page.focus('input[name="name"]');
  await page.keyboard.press("Enter");
  await page
    .waitForFunction("(window.__submissions || []).length >= 1", {
      timeout: 10000,
    })
    .catch(() => {});
  subs = await page.evaluate(() => window.__submissions);
  expect(firstSubmission(subs).name, "enter submit didn't fire correctly").toBe("Alice");

  await page.evaluate(() => {
    const form = document.getElementById("form") as HTMLFormElement;
    form.reset();
  });
  const afterReset = await page.evaluate(() => ({
    name: document.querySelector<HTMLInputElement>('input[name="name"]').value,
    email: document.querySelector<HTMLInputElement>('input[name="email"]').value,
    bio: document.querySelector("textarea").value,
    plan: document.querySelector<HTMLInputElement>('input[name="plan"]:checked')?.value || "none",
  }));
  expect(afterReset.name, "reset clears name").toBe("");
  expect(afterReset.email, "reset clears email").toBe("");
  expect(afterReset.plan, "plan should restore to default 'free'").toBe("free");
});
