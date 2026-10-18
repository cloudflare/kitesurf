// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("page code cannot forge or preserve trusted events", async ({ page }) => {
  await setContent(page, '<button id="button">click</button><form id="form"></form>');

  const forged = await page.evaluate(() => {
    let symbolReads = 0;
    const init = new Proxy(
      {},
      {
        get(target, key, receiver) {
          if (typeof key === "symbol") {
            symbolReads++;
            return true;
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const event = new Event("forged", init);
    document.body.dispatchEvent(event);
    return { isTrusted: event.isTrusted, symbolReads };
  });
  expect(forged).toEqual({ isTrusted: false, symbolReads: 0 });

  await page.evaluate(() => {
    const button = document.querySelector("#button") as HTMLButtonElement;
    (window as any).trustedClick = null;
    (window as any).interceptedClickTrust = [];
    button.addEventListener(
      "click",
      (event) => {
        (window as any).trustedClick = event;
        (event as any)._inFlight = false;
        try {
          document.body.dispatchEvent(event);
        } catch (error) {
          (window as any).reentrantDispatchError = (error as Error).name;
        }
        (window as any).trustedAfterReentrantAttempt = event.isTrusted;
      },
      { once: true },
    );
    button.dispatchEvent = (event) => {
      (window as any).interceptedClickTrust.push(event.isTrusted);
      return true;
    };
  });
  await page.click("#button");

  const click = await page.evaluate(() => {
    const button = document.querySelector("#button") as HTMLButtonElement;
    delete (button as any).dispatchEvent;
    const event = (window as any).trustedClick as Event;
    const initiallyTrusted = event.isTrusted;
    let trustedDuringRedispatch: boolean | null = null;
    document.body.addEventListener(
      "click",
      (redispatched) => {
        trustedDuringRedispatch = redispatched.isTrusted;
      },
      { once: true },
    );
    document.body.dispatchEvent(event);
    return {
      initiallyTrusted,
      interceptedTrust: (window as any).interceptedClickTrust,
      trustedDuringRedispatch,
      trustedAfterRedispatch: event.isTrusted,
      reentrantDispatchError: (window as any).reentrantDispatchError,
      trustedAfterReentrantAttempt: (window as any).trustedAfterReentrantAttempt,
    };
  });
  expect(click).toMatchObject({
    initiallyTrusted: true,
    trustedDuringRedispatch: false,
    trustedAfterRedispatch: false,
    reentrantDispatchError: "InvalidStateError",
    trustedAfterReentrantAttempt: true,
  });
  expect(click.interceptedTrust.length).toBeGreaterThan(0);
  expect(click.interceptedTrust.every((trusted: boolean) => !trusted)).toBe(true);

  const exceptionalDispatch = await page.evaluate(() => {
    const event = new MouseEvent("exceptional");
    Object.defineProperty(event, "relatedTarget", {
      configurable: true,
      get() {
        throw new Error("blocked relatedTarget read");
      },
    });
    let firstError = "";
    try {
      document.body.dispatchEvent(event);
    } catch (error) {
      firstError = (error as Error).message;
    }
    Object.defineProperty(event, "relatedTarget", {
      configurable: true,
      value: null,
    });
    return {
      firstError,
      redispatchResult: document.body.dispatchEvent(event),
    };
  });
  expect(exceptionalDispatch).toEqual({
    firstError: "blocked relatedTarget read",
    redispatchResult: true,
  });

  const accessorReentrancy = await page.evaluate(() => {
    const event = new Event("locked");
    const body = document.body as any;
    const originalId = body._id;
    let listenerCalls = 0;
    let nestedError = "";
    let targetNestedError = "";
    document.body.addEventListener(
      "locked",
      () => {
        listenerCalls++;
      },
      { once: true },
    );
    Object.defineProperty(event, "relatedTarget", {
      configurable: true,
      get() {
        try {
          document.body.dispatchEvent(event);
        } catch (error) {
          nestedError = (error as Error).name;
        }
        return null;
      },
    });
    Object.defineProperty(event, "defaultPrevented", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(event, "_defaultPrevented", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(body, "_id", {
      configurable: true,
      get() {
        try {
          body.dispatchEvent(event);
        } catch (error) {
          targetNestedError = (error as Error).name;
        }
        return originalId;
      },
    });
    let dispatchResult = false;
    try {
      dispatchResult = body.dispatchEvent(event);
    } finally {
      Object.defineProperty(body, "_id", {
        configurable: true,
        value: originalId,
        writable: true,
      });
    }
    return {
      dispatchResult,
      listenerCalls,
      nestedError,
      targetNestedError,
    };
  });
  expect(accessorReentrancy).toEqual({
    dispatchResult: true,
    listenerCalls: 1,
    nestedError: "InvalidStateError",
    targetNestedError: "InvalidStateError",
  });

  const reset = await page.evaluate(() => {
    const form = document.querySelector("#form") as HTMLFormElement;
    let event: Event | null = null;
    let intercepted = false;
    form.addEventListener(
      "reset",
      (resetEvent) => {
        event = resetEvent;
      },
      { once: true },
    );
    form.dispatchEvent = () => {
      intercepted = true;
      return true;
    };
    form.reset();
    delete (form as any).dispatchEvent;
    const initiallyTrusted = event!.isTrusted;
    form.dispatchEvent(event!);
    return {
      initiallyTrusted,
      intercepted,
      trustedAfterRedispatch: event!.isTrusted,
    };
  });
  expect(reset).toEqual({
    initiallyTrusted: true,
    intercepted: false,
    trustedAfterRedispatch: false,
  });

  const forgedType = await page.evaluate(() => {
    const form = document.querySelector("#form") as HTMLFormElement;
    const descriptor = Object.getOwnPropertyDescriptor(Event.prototype, "type")!;
    let forgedListenerCalled = false;
    let resetListenerCalled = false;
    form.addEventListener("forged-reset", () => {
      forgedListenerCalled = true;
    });
    form.addEventListener(
      "reset",
      () => {
        resetListenerCalled = true;
      },
      { once: true },
    );
    Object.defineProperty(Event.prototype, "type", {
      configurable: true,
      get: () => "forged-reset",
    });
    try {
      form.reset();
    } finally {
      Object.defineProperty(Event.prototype, "type", descriptor);
    }
    return { forgedListenerCalled, resetListenerCalled };
  });
  expect(forgedType).toEqual({
    forgedListenerCalled: false,
    resetListenerCalled: true,
  });

  const borrowedReset = await page.evaluate(() => {
    const button = document.querySelector("#button") as HTMLButtonElement;
    let listenerCalled = false;
    button.addEventListener("reset", () => {
      listenerCalled = true;
    });
    let errorName = "";
    try {
      HTMLFormElement.prototype.reset.call(button);
    } catch (error) {
      errorName = (error as Error).name;
    }
    return { errorName, listenerCalled };
  });
  expect(borrowedReset).toEqual({
    errorName: "TypeError",
    listenerCalled: false,
  });

  const namespacedReset = await page.evaluate(() => {
    const form = document.createElementNS("urn:example", "form");
    let listenerCalled = false;
    form.addEventListener("reset", () => {
      listenerCalled = true;
    });
    let errorName = "";
    try {
      HTMLFormElement.prototype.reset.call(form);
    } catch (error) {
      errorName = (error as Error).name;
    }
    return { errorName, listenerCalled };
  });
  expect(namespacedReset).toEqual({
    errorName: "TypeError",
    listenerCalled: false,
  });

  const spoofedTarget = await page.evaluate(() => {
    const button = document.querySelector("#button") as any;
    const form = document.querySelector("#form") as any;
    const originalId = form._id;
    let victimTriggered = false;
    button.addEventListener("reset", () => {
      victimTriggered = true;
    });
    form._id = button._id;
    let errorName = "";
    try {
      form.reset();
    } catch (error) {
      errorName = (error as Error).name;
    } finally {
      form._id = originalId;
    }
    return { errorName, victimTriggered };
  });
  expect(spoofedTarget).toEqual({
    errorName: "TypeError",
    victimTriggered: false,
  });
});
