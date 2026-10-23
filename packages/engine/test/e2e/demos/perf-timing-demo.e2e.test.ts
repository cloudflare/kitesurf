// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

test("supports User Timing and navigation timing APIs", async ({ page }) => {
  await setContent(page, "<p>timing</p>");

  const result = await page.evaluate(() => {
    const perf = performance as any;
    const out: Record<string, unknown> = {};

    function recordApiAvailability(): void {
      out.hasNow = typeof perf.now === "function";
      out.hasMark = typeof perf.mark === "function";
      out.hasMeasure = typeof perf.measure === "function";
      out.hasGetEntries = typeof perf.getEntries === "function";
      out.hasGetByName = typeof perf.getEntriesByName === "function";
      out.hasGetByType = typeof perf.getEntriesByType === "function";
      out.hasClearMarks = typeof perf.clearMarks === "function";
      out.hasClearMeasures = typeof perf.clearMeasures === "function";
      out.hasClearResources = typeof perf.clearResourceTimings === "function";
      out.hasTiming = !!perf.timing;
      out.hasNavigation = !!perf.navigation;
    }

    function recordStartMark(): void {
      perf.mark("start");
      perf.mark("end");

      const startEntries = perf.getEntriesByName("start");
      out.startCount = startEntries.length;
      out.startEntryType = startEntries[0] && startEntries[0].entryType;
      out.startHasStartTime = startEntries[0] && typeof startEntries[0].startTime === "number";
    }

    function recordNamedMeasure(): void {
      perf.measure("startToEnd", "start", "end");
      const measureEntries = perf.getEntriesByName("startToEnd");
      out.measureCount = measureEntries.length;
      out.measureEntryType = measureEntries[0] && measureEntries[0].entryType;
    }

    function recordOptionMeasure(): void {
      perf.measure("withOpts", {
        start: 100,
        end: 200,
        detail: { phase: "test" },
      });
      const opts = perf.getEntriesByName("withOpts");
      out.optsDuration = opts[0] && opts[0].duration;
      out.optsDetail = opts[0] && opts[0].detail && opts[0].detail.phase;
    }

    function recordDurationMeasure(): void {
      perf.measure("withDur", { start: 50, duration: 30 });
      const dur = perf.getEntriesByName("withDur");
      out.durDuration = dur[0] && dur[0].duration;
    }

    function recordEntryCollections(): void {
      const allMarks = perf.getEntriesByType("mark");
      out.markCount = allMarks.length;
      out.allMarksAreMarks = allMarks.every((entry) => entry.entryType === "mark");
      const allMeasures = perf.getEntriesByType("measure");
      out.measureCountTotal = allMeasures.length;

      const all = perf.getEntries();
      out.entriesTotal = all.filter(
        (entry) => entry.entryType === "mark" || entry.entryType === "measure",
      ).length;
      out.entriesIsArray = Array.isArray(all);
      all.push({ name: "garbage" });
      out.snapshotIsolated = perf.getEntries().length === all.length - 1;
    }

    function clearMarkEntries(): void {
      perf.clearMarks("start");
      out.afterClearStart = perf.getEntriesByName("start").length;
      out.afterClearEndStillThere = perf.getEntriesByName("end").length;
      perf.clearMarks();
      out.afterClearAllMarks = perf.getEntriesByType("mark").length;
    }

    function clearMeasureEntries(): void {
      out.beforeClearMeasures = perf.getEntriesByType("measure").length;
      perf.clearMeasures("startToEnd");
      out.afterClearOneMeasure = perf.getEntriesByName("startToEnd").length;
      perf.clearMeasures();
      out.afterClearAllMeasures = perf.getEntriesByType("measure").length;
    }

    function recordNavigationStartMeasure(): void {
      try {
        perf.measure("from-nav-start", "navigationStart");
        const entry = perf.getEntriesByName("from-nav-start")[0];
        out.navStartMeasureOk = entry && entry.entryType === "measure" && entry.startTime === 0;
      } catch (error) {
        out.navStartMeasureErr = String(error);
      }
    }

    function recordLoadMeasure(): void {
      try {
        perf.measure("dcl-to-load", "domContentLoadedEventEnd", "loadEventEnd");
        const entry = perf.getEntriesByName("dcl-to-load")[0];
        out.dclToLoadOk = entry && entry.entryType === "measure";
      } catch (error) {
        out.dclToLoadErr = String(error);
      }
    }

    function strictWriteProbe(): boolean | string {
      "use strict";
      try {
        perf.timeOrigin = 42;
        perf.now = () => 99;
        return perf.timeOrigin === 42 && perf.now() === 99;
      } catch (error) {
        return "threw: " + String(error);
      }
    }

    function recordTimingValues(): void {
      out.timingNavStart = typeof perf.timing.navigationStart === "number";
      out.navType = perf.navigation.type;
      out.nowIsNumber = typeof perf.now() === "number";
      out.timeOriginIsNumber = typeof perf.timeOrigin === "number";
      out.timeOriginNotNaN = !Number.isNaN(perf.timeOrigin);
      out.strictWriteOk = strictWriteProbe();
    }

    recordApiAvailability();
    recordStartMark();
    recordNamedMeasure();
    recordOptionMeasure();
    recordDurationMeasure();
    recordEntryCollections();
    clearMarkEntries();
    clearMeasureEntries();
    recordNavigationStartMeasure();
    recordLoadMeasure();
    recordTimingValues();

    return out;
  });

  expect(result.hasNow, "performance.now is a function").toBe(true);
  expect(result.hasMark, "performance.mark is a function").toBe(true);
  expect(result.hasMeasure, "performance.measure is a function").toBe(true);
  expect(result.hasGetEntries, "performance.getEntries is a function").toBe(true);
  expect(result.hasGetByName, "performance.getEntriesByName is a function").toBe(true);
  expect(result.hasGetByType, "performance.getEntriesByType is a function").toBe(true);
  expect(result.hasClearMarks, "performance.clearMarks is a function").toBe(true);
  expect(result.hasClearMeasures, "performance.clearMeasures is a function").toBe(true);
  expect(result.hasClearResources, "performance.clearResourceTimings is a function").toBe(true);
  expect(result.hasTiming, "performance.timing exists").toBe(true);
  expect(result.hasNavigation, "performance.navigation exists").toBe(true);

  expect(result.startCount, "mark records one entry").toBe(1);
  expect(result.startEntryType, "mark entryType is mark").toBe("mark");
  expect(result.startHasStartTime, "mark has a numeric startTime").toBe(true);

  expect(result.measureCount, "measure(start,end) records one entry").toBe(1);
  expect(result.measureEntryType, "measure entryType is measure").toBe("measure");

  expect(result.optsDuration, "measure(options.start/end) computes duration").toBe(100);
  expect(result.optsDetail, "measure(options.detail) preserves detail").toBe("test");
  expect(result.durDuration, "measure(options.duration) is honored").toBe(30);

  expect(result.markCount, "getEntriesByType(mark) returns two marks").toBe(2);
  expect(result.allMarksAreMarks, "getEntriesByType(mark) returns only marks").toBe(true);
  expect(result.measureCountTotal, "getEntriesByType(measure) returns three measures").toBe(3);

  expect(result.entriesIsArray, "getEntries returns an array").toBe(true);
  expect(result.entriesTotal, "getEntries returns two marks and three measures").toBe(5);
  expect(result.snapshotIsolated, "getEntries returns a snapshot").toBe(true);

  expect(result.afterClearStart, "clearMarks(start) removes that mark").toBe(0);
  expect(result.afterClearEndStillThere, "clearMarks(start) preserves end").toBe(1);
  expect(result.afterClearAllMarks, "clearMarks() removes all marks").toBe(0);

  expect(result.beforeClearMeasures, "three measures exist before clearing").toBe(3);
  expect(result.afterClearOneMeasure, "clearMeasures(startToEnd) removes that measure").toBe(0);
  expect(result.afterClearAllMeasures, "clearMeasures() removes all measures").toBe(0);

  expect(result.navStartMeasureOk, "navigationStart resolves to startTime zero").toBe(true);
  expect(result.dclToLoadOk, "domContentLoadedEventEnd to loadEventEnd measures").toBe(true);

  expect(result.timingNavStart, "performance.timing.navigationStart is numeric").toBe(true);
  expect(result.navType, "performance.navigation.type is zero").toBe(0);
  expect(result.nowIsNumber, "performance.now returns a number").toBe(true);
  expect(result.timeOriginIsNumber, "performance.timeOrigin is numeric").toBe(true);
  expect(result.timeOriginNotNaN, "performance.timeOrigin is not NaN").toBe(true);
  expect(result.strictWriteOk, "strict-mode writes to timeOrigin and now work").toBe(true);
});

test.fails("measure with a missing mark throws SyntaxError", async ({ page }) => {
  // Gap: the engine's performance.measure does not throw a SyntaxError for an unknown mark.
  await setContent(page, "<p>timing</p>");

  const threw = await page.evaluate(() => {
    try {
      performance.measure("bad", "nonexistent");
      return false;
    } catch (error) {
      return error instanceof SyntaxError;
    }
  });
  expect(threw, "measure with a missing mark throws SyntaxError").toBe(true);
});
