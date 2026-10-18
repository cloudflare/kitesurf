// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

test("validates control constraints and form validity", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><html><body>
      <form id="f">
        <input id="r" name="r" required>
        <input id="e" type="email" name="e">
        <input id="u" type="url" name="u">
        <input id="p" pattern="[A-Z]+" name="p">
        <input id="ml" maxlength="3" name="ml">
        <input id="mn" minlength="3" name="mn">
        <input id="num" type="number" min="0" max="10" step="2" name="num">
        <input id="cb" type="checkbox" required name="cb">
        <textarea id="ta" required name="ta"></textarea>
        <select id="sel" required name="sel">
          <option value="">--</option>
          <option value="a">A</option>
        </select>
        <input id="disabled" required name="dz" disabled>
        <input id="hidden" required name="hz" type="hidden">
        <input id="custom" name="cust">
      </form>
      <fieldset id="fs" disabled>
        <input id="in-fs" required name="in-fs">
      </fieldset>
    </body></html>`,
  );

  const results = await page.evaluate(() => {
    const checks: Record<string, boolean> = {};
    const el = (id: string) => document.getElementById(id) as HTMLInputElement;
    const form = document.getElementById("f") as HTMLFormElement;

    checks["required+empty fails"] = el("r").validity.valueMissing === true;
    checks["required+empty .valid false"] = el("r").validity.valid === false;
    el("r").value = "x";
    checks["required+filled passes"] = el("r").validity.valueMissing === false;
    checks[".valid true after fill"] = el("r").validity.valid === true;

    el("e").value = "not-an-email";
    checks["bad email typeMismatch"] = el("e").validity.typeMismatch === true;
    el("e").value = "a@b.com";
    checks["good email no typeMismatch"] = el("e").validity.typeMismatch === false;

    el("u").value = "not-a-url";
    checks["bad url typeMismatch"] = el("u").validity.typeMismatch === true;
    el("u").value = "https://ks.invalid";
    checks["good url no typeMismatch"] = el("u").validity.typeMismatch === false;

    el("p").value = "abc";
    checks["pattern mismatch lowercase"] = el("p").validity.patternMismatch === true;
    el("p").value = "ABC";
    checks["pattern matches uppercase"] = el("p").validity.patternMismatch === false;

    el("ml").value = "ab";
    checks["under max"] = el("ml").validity.tooLong === false;

    el("mn").value = "abc";
    checks["meets min"] = el("mn").validity.tooShort === false;

    el("num").value = "-1";
    checks["rangeUnderflow"] = el("num").validity.rangeUnderflow === true;
    el("num").value = "11";
    checks["rangeOverflow"] = el("num").validity.rangeOverflow === true;
    el("num").value = "3";
    checks["step mismatch"] = el("num").validity.stepMismatch === true;
    el("num").value = "4";
    checks["step ok"] = el("num").validity.stepMismatch === false;

    checks["required unchecked valueMissing"] = el("cb").validity.valueMissing === true;
    el("cb").checked = true;
    checks["checked clears valueMissing"] = el("cb").validity.valueMissing === false;

    checks["textarea required+empty"] = el("ta").validity.valueMissing === true;
    el("ta").value = "x";
    checks["textarea filled passes"] = el("ta").validity.valueMissing === false;

    checks["select required+empty"] = el("sel").validity.valueMissing === true;
    el("sel").value = "a";
    checks["select choose option"] = el("sel").validity.valueMissing === false;

    checks["disabled willValidate false"] = el("disabled").willValidate === false;
    checks["hidden willValidate false"] = el("hidden").willValidate === false;
    checks["regular willValidate true"] = el("r").willValidate === true;
    checks["fieldset disabled propagates"] = el("in-fs").willValidate === false;

    el("custom").setCustomValidity("oh no");
    checks["custom message"] = el("custom").validationMessage === "oh no";
    checks["custom error flag"] = el("custom").validity.customError === true;
    checks["custom not valid"] = el("custom").validity.valid === false;
    el("custom").setCustomValidity("");
    checks["clear custom"] = el("custom").validity.customError === false;

    el("r").value = "";
    let invalidCount = 0;
    el("r").addEventListener("invalid", () => {
      invalidCount++;
    });
    const valid = el("r").checkValidity();
    checks["checkValidity returns false"] = valid === false;
    checks["invalid event fired"] = invalidCount === 1;

    el("r").value = "x";
    el("e").value = "a@b.com";
    el("u").value = "https://ks.invalid";
    el("p").value = "ABC";
    el("ml").value = "ab";
    el("mn").value = "abc";
    el("num").value = "4";
    checks["form checkValidity all good"] = form.checkValidity() === true;

    el("e").value = "bad";
    checks["form fails on one invalid"] = form.checkValidity() === false;

    checks["validity toStringTag"] =
      Object.prototype.toString.call(el("r").validity) === "[object ValidityState]";

    return checks;
  });

  expect(results["required+empty fails"], "required+empty fails").toBe(true);
  expect(results["required+empty .valid false"], "required+empty .valid false").toBe(true);
  expect(results["required+filled passes"], "required+filled passes").toBe(true);
  expect(results[".valid true after fill"], ".valid true after fill").toBe(true);
  expect(results["bad email typeMismatch"], "bad email typeMismatch").toBe(true);
  expect(results["good email no typeMismatch"], "good email no typeMismatch").toBe(true);
  expect(results["bad url typeMismatch"], "bad url typeMismatch").toBe(true);
  expect(results["good url no typeMismatch"], "good url no typeMismatch").toBe(true);
  expect(results["pattern mismatch lowercase"], "pattern mismatch lowercase").toBe(true);
  expect(results["pattern matches uppercase"], "pattern matches uppercase").toBe(true);
  expect(results["under max"], "under max").toBe(true);
  expect(results["meets min"], "meets min").toBe(true);
  expect(results["rangeUnderflow"], "rangeUnderflow").toBe(true);
  expect(results["rangeOverflow"], "rangeOverflow").toBe(true);
  expect(results["step mismatch"], "step mismatch").toBe(true);
  expect(results["step ok"], "step ok").toBe(true);
  expect(results["required unchecked valueMissing"], "required unchecked valueMissing").toBe(true);
  expect(results["checked clears valueMissing"], "checked clears valueMissing").toBe(true);
  expect(results["textarea required+empty"], "textarea required+empty").toBe(true);
  expect(results["textarea filled passes"], "textarea filled passes").toBe(true);
  expect(results["select required+empty"], "select required+empty").toBe(true);
  expect(results["select choose option"], "select choose option").toBe(true);
  expect(results["disabled willValidate false"], "disabled willValidate false").toBe(true);
  expect(results["hidden willValidate false"], "hidden willValidate false").toBe(true);
  expect(results["regular willValidate true"], "regular willValidate true").toBe(true);
  expect(results["fieldset disabled propagates"], "fieldset disabled propagates").toBe(true);
  expect(results["custom message"], "custom message").toBe(true);
  expect(results["custom error flag"], "custom error flag").toBe(true);
  expect(results["custom not valid"], "custom not valid").toBe(true);
  expect(results["clear custom"], "clear custom").toBe(true);
  expect(results["checkValidity returns false"], "checkValidity returns false").toBe(true);
  expect(results["invalid event fired"], "invalid event fired once").toBe(true);
  expect(results["form checkValidity all good"], "form checkValidity all good").toBe(true);
  expect(results["form fails on one invalid"], "form fails on one invalid").toBe(true);
  expect(results["validity toStringTag"], "ValidityState toStringTag").toBe(true);
});

test.fails("a user-typed value over maxlength is capped at maxlength", async ({ page }) => {
  // Gap: the engine accepts typing past maxlength; Chrome stops at maxlength.
  await setContent(page, `<!doctype html><html><body><input id="ml" maxlength="3"></body></html>`);

  await page.type("#ml", "abcd");
  const value = await page.$eval("#ml", (el) => (el as HTMLInputElement).value);
  expect(value, "maxlength stops typing at 3 characters").toBe("abc");
});

test.fails("a user-typed value longer than maxlength is tooLong once maxlength drops", async ({
  page,
}) => {
  // Gap: the engine does not flag a user-edited value as tooLong after maxlength drops.
  await setContent(page, `<!doctype html><html><body><input id="ml" maxlength="3"></body></html>`);

  await page.type("#ml", "abc");
  await page.$eval("#ml", (el) => el.setAttribute("maxlength", "2"));
  const tooLong = await page.$eval("#ml", (el) => (el as HTMLInputElement).validity.tooLong);
  expect(tooLong, "a user-edited value longer than maxlength is tooLong").toBe(true);
});

test.fails("a user-typed value under minlength is tooShort", async ({ page }) => {
  // Gap: the engine does not flag a user-typed value as tooShort.
  await setContent(page, `<!doctype html><html><body><input id="mn" minlength="3"></body></html>`);

  await page.type("#mn", "ab");
  const tooShort = await page.$eval("#mn", (el) => (el as HTMLInputElement).validity.tooShort);
  expect(tooShort, "a user-typed value under minlength is tooShort").toBe(true);
});

test("a user-typed non-number in type=number is sanitized to an empty value", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><html><body><input id="num" type="number" min="0" max="10" step="2"></body></html>`,
  );

  await page.type("#num", "e");
  const value = await page.$eval("#num", (el) => (el as HTMLInputElement).value);
  expect(value, "the sanitized value is empty").toBe("");
});

test.fails("a user-typed non-number in type=number is badInput", async ({ page }) => {
  // Gap: the engine does not set badInput for user-typed text in a number input.
  await setContent(
    page,
    `<!doctype html><html><body><input id="num" type="number" min="0" max="10" step="2"></body></html>`,
  );

  await page.type("#num", "e");
  const badInput = await page.$eval("#num", (el) => (el as HTMLInputElement).validity.badInput);
  expect(badInput, "a typed non-number sets badInput").toBe(true);
});
