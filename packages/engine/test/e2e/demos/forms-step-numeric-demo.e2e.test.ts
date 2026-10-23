// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("forms-step-numeric-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <input id="num" type="number" value="5" min="0" max="100" step="2">
        <input id="rng" type="range" value="50" min="0" max="100" step="10">
        <input id="dat" type="date" value="2024-06-15" min="2024-01-01" max="2024-12-31">
        <input id="tim" type="time" value="10:30" min="00:00" max="23:59" step="60">
        <input id="mon" type="month" value="2024-06">
        <input id="wk"  type="week"  value="2024-W25">
        <input id="dtl" type="datetime-local" value="2024-06-15T10:30">
        <input id="txt" type="text" value="hello">
        <input id="anystep" type="number" value="1" step="any">
        <select id="sel"><option>a</option><option>b</option></select>
      </body></html>`),
  );

  const r = await page.evaluate(() => {
    const checks: { label: string; ok: boolean; info?: string }[] = [];
    const add = (label: string, ok: boolean, info: any = "") =>
      checks.push({ label, ok, info: String(info) });
    const el = (id: string) => document.getElementById(id) as any;
    const dateConstructorName = (date: Date | null) => date?.constructor?.name;
    const dateTime = (date: Date | null) => date?.getTime();
    const dateSetterThrows = (): boolean => {
      let threw = false;
      try {
        el("num").valueAsDate = new Date();
      } catch {
        threw = true;
      }
      return threw;
    };
    const invalidStateOnStepUp = (id: string): boolean => {
      try {
        el(id).stepUp();
      } catch (error: any) {
        return !!error && error.name === "InvalidStateError";
      }
      return false;
    };

    const checkNumericValues = (): void => {
      add("number.valueAsNumber", el("num").valueAsNumber === 5);
      add("range.valueAsNumber", el("rng").valueAsNumber === 50);
      add("date.valueAsNumber ms UTC", el("dat").valueAsNumber === Date.UTC(2024, 5, 15));
      add(
        "time.valueAsNumber ms since midnight",
        el("tim").valueAsNumber === 10 * 3_600_000 + 30 * 60_000,
      );
      add(
        "month.valueAsNumber months since 1970-01",
        el("mon").valueAsNumber === (2024 - 1970) * 12 + 5,
      );
      add(
        "datetime-local.valueAsNumber",
        el("dtl").valueAsNumber === Date.UTC(2024, 5, 15, 10, 30),
      );
      add("text.valueAsNumber NaN", Number.isNaN(el("txt").valueAsNumber));
    };
    const checkDateValues = (): void => {
      const dDate = el("dat").valueAsDate;
      add("date.valueAsDate ctor name", dateConstructorName(dDate) === "Date");
      add("date.valueAsDate value", dateTime(dDate) === Date.UTC(2024, 5, 15));
      const monDate = el("mon").valueAsDate;
      add("month.valueAsDate ctor name", dateConstructorName(monDate) === "Date");
      add("dtl.valueAsDate is null (not applicable)", el("dtl").valueAsDate === null);
      add("number.valueAsDate is null (not applicable)", el("num").valueAsDate === null);
    };
    const checkDateSetters = (): void => {
      el("dat").valueAsDate = new Date(Date.UTC(2025, 0, 1));
      add("date.valueAsDate setter", el("dat").value === "2025-01-01");
      el("dat").valueAsDate = null;
      add("date.valueAsDate = null clears", el("dat").value === "");
      add("valueAsDate on number throws", dateSetterThrows());
    };
    const checkStepValues = (): void => {
      el("num").value = "10";
      el("num").stepUp();
      add("num.stepUp default n=1", el("num").value === "12");
      el("num").stepUp(3);
      add("num.stepUp(3)", el("num").value === "18");
      el("num").stepDown(5);
      add("num.stepDown(5)", el("num").value === "8");

      el("rng").value = "50";
      el("rng").stepUp();
      add("rng.stepUp step=10", el("rng").value === "60");

      el("dat").value = "2024-06-15";
      el("dat").stepUp();
      add("date.stepUp default 1 day", el("dat").value === "2024-06-16");
      el("dat").stepDown(30);
      add("date.stepDown 30", el("dat").value === "2024-05-17");

      el("tim").value = "10:30";
      el("tim").stepUp();
      add("time.stepUp default 60s", el("tim").value === "10:31");

      el("mon").value = "2024-06";
      el("mon").stepUp();
      add("month.stepUp", el("mon").value === "2024-07");

      el("wk").value = "2024-W25";
      el("wk").stepUp();
      add("week.stepUp", el("wk").value === "2024-W26");

      el("num").value = "99";
      el("num").stepUp(10);
      const clamped = el("num").valueAsNumber;
      add("num clamped near max", clamped <= 100, clamped);
      add("step=any throws InvalidStateError", invalidStateOnStepUp("anystep"));
      add("text.stepUp throws", invalidStateOnStepUp("txt"));
    };
    const checkSelectLength = (): void => {
      const sel = el("sel");
      add("sel starts at length 2", sel.length === 2);
      sel.length = 5;
      add("sel grew to 5", sel.length === 5);
      add("appended are <option>", sel.options[4].tagName === "OPTION");
      sel.length = 1;
      add("sel shrunk to 1", sel.length === 1);
      sel.length = 0;
      add("sel empty", sel.length === 0);
    };

    checkNumericValues();
    checkDateValues();
    checkDateSetters();
    checkStepValues();
    checkSelectLength();

    return checks;
  });

  const failed = r.filter((c: any) => !c.ok);
  if (failed.length) {
    console.error("Failed checks:", JSON.stringify(failed, null, 2));
  }
  expect(failed).toEqual([]);
  expect(r.length).toBeGreaterThan(20);
});
