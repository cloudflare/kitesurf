// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

function assertCreatedList(html: string): void {
  expect(
    html.includes("item 0") && html.includes("item 2") && html.includes('id="list-1"'),
    "test1 createElement + appendChild round-trip: " + html,
  ).toBeTruthy();
}

function assertInsertedBefore(html: string): void {
  expect(
    html.indexOf("item -1") >= 0 && html.indexOf("item -1") < html.indexOf("item 0"),
    "test2 insertBefore: " + html,
  ).toBeTruthy();
}

function assertRemoved(ok: boolean, remaining: Array<string | null>, details: string): void {
  expect(
    ok && remaining.length === 3 && !remaining.includes("item 1"),
    "test3 removeChild: " + details,
  ).toBeTruthy();
}

function assertReplaced(
  ok: boolean,
  remaining: Array<string | null>,
  hasReplacedAttr: boolean,
  details: string,
): void {
  expect(
    ok && remaining.includes("item 99") && !remaining.includes("item 2") && hasReplacedAttr,
    "test4 replaceChild: " + details,
  ).toBeTruthy();
}

function assertRemovedElement(ok: boolean, before: number, after: number, details: string): void {
  expect(ok && after === before - 1, "test5 element.remove(): " + details).toBeTruthy();
}

function createList() {
  const ul = document.createElement("ul");
  ul.id = "list-1";
  document.body.appendChild(ul);
  for (let i = 0; i < 3; i++) {
    const li = document.createElement("li");
    li.textContent = "item " + i;
    ul.appendChild(li);
  }
  return document.querySelector("#list-1").outerHTML;
}

function insertItemBefore() {
  const ul = document.querySelector("#list-1");
  const newLi = document.createElement("li");
  newLi.textContent = "item -1";
  newLi.className = "first";
  ul.insertBefore(newLi, ul.firstChild);
  return ul.outerHTML;
}

function removeListItem() {
  const ul = document.querySelector("#list-1");
  const items = Array.from(ul.children);
  const target = items.find((el) => el.textContent === "item 1");
  if (!target) return { ok: false, reason: "couldn't find item 1" };
  ul.removeChild(target);
  return {
    ok: true,
    remaining: Array.from(ul.children).map((child) => child.textContent),
  };
}

function replaceListItem() {
  const ul = document.querySelector("#list-1");
  const old = Array.from(ul.children).find((child) => child.textContent === "item 2");
  if (!old) return { ok: false };
  const fresh = document.createElement("li");
  fresh.textContent = "item 99";
  fresh.setAttribute("data-replaced", "yes");
  ul.replaceChild(fresh, old);
  return {
    ok: true,
    remaining: Array.from(ul.children).map((child) => child.textContent),
    hasReplacedAttr: !!ul.querySelector('[data-replaced="yes"]'),
  };
}

function removeFirstListItem() {
  const ul = document.querySelector("#list-1");
  const first = ul.firstChild;
  if (!first) return { ok: false };
  const before = ul.children.length;
  first.remove();
  return { ok: true, before, after: ul.children.length };
}

function fixtureUrl(): string {
  return process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/events.html";
}

function listOrEmpty<T>(items: T[] | undefined): T[] {
  return items ?? [];
}

function booleanOrFalse(value: boolean | undefined): boolean {
  return value ?? false;
}

function numberOrZero(value: number | undefined): number {
  return value ?? 0;
}

test("dom-mutate2-demo", async ({ page }) => {
  await page.goto(fixtureUrl(), { timeout: 15000 });

  const test1 = await page.evaluate(createList);
  assertCreatedList(test1);

  const test2 = await page.evaluate(insertItemBefore);
  assertInsertedBefore(test2);

  const test3 = await page.evaluate(removeListItem);
  assertRemoved(test3.ok, listOrEmpty(test3.remaining), JSON.stringify(test3));

  const test4 = await page.evaluate(replaceListItem);
  assertReplaced(
    test4.ok,
    listOrEmpty(test4.remaining),
    booleanOrFalse(test4.hasReplacedAttr),
    JSON.stringify(test4),
  );

  const test5 = await page.evaluate(removeFirstListItem);
  assertRemovedElement(
    test5.ok,
    numberOrZero(test5.before),
    numberOrZero(test5.after),
    JSON.stringify(test5),
  );
});
