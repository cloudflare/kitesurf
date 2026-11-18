// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { APP_URL, expect, test } from "./fixtures.ts";

test("lists the todos from the API", async ({ page }) => {
  await page.goto(APP_URL);
  await expect(page).toHaveTitle("Todos");
  await expect(page.getByRole("heading", { name: "Todos" })).toBeVisible();
  await expect(page.locator("#todos li")).toHaveText(["Buy milk", "Walk the dog"]);
  await expect(page.locator("#count")).toHaveText("2 todos");
});

test("adds a todo", async ({ page }) => {
  await page.goto(APP_URL);
  await expect(page.locator("#todos li")).toHaveCount(2);
  await page.getByLabel("New todo").fill("Write tests");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator("#todos li").last()).toHaveText("Write tests");
  await expect(page.locator("#count")).toHaveText("3 todos");
  await expect(page.getByLabel("New todo")).toHaveValue("");
});

test("takes a screenshot", async ({ page }, testInfo) => {
  await page.goto(APP_URL);
  await expect(page.locator("#todos li")).toHaveCount(2);
  const path = testInfo.outputPath("todos.png");
  const image = await page.screenshot({ path });
  // A PNG starts with the bytes 0x89 "PNG".
  expect(image.subarray(1, 4).toString()).toBe("PNG");
});
