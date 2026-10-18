// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

type IframeLoadWindow = typeof window & {
  __blobLoads?: string[];
  __blobSecondLoads?: string[];
  __blobRaceLoads?: string[];
  __iframeSawWindowLoaded?: boolean | null;
  __loadAt?: number | null;
};

test("a same-origin iframe's contentDocument is live in the page's load handler", async ({
  page,
}) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-load-order.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const atLoad = await page.evaluate(`window.__atLoad`);
  expect(atLoad).toBe("Child heading");
});

test("same-origin iframes load concurrent HTML Blob URLs in order", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const expected = Array.from({ length: 8 }, (_, index) => `blob child ${index}`);
  await page.evaluate(() => {
    const blobLoadsWindow = window as IframeLoadWindow & { __blobLoads: string[] };
    blobLoadsWindow.__blobLoads = [];
    for (let index = 0; index < 8; index++) {
      const frame = document.createElement("iframe");
      frame.id = `blob-frame-${index}`;
      const url = URL.createObjectURL(
        new Blob([`<!doctype html><p id=blob-child>blob child ${index}</p>`], {
          type: "text/html",
        }),
      );
      frame.onload = () => {
        blobLoadsWindow.__blobLoads[index] =
          frame.contentDocument?.getElementById("blob-child")?.textContent ?? "";
        URL.revokeObjectURL(url);
      };
      frame.src = url;
      document.body.appendChild(frame);
    }
  });

  await page.waitForFunction(
    () => {
      const loads = (window as IframeLoadWindow).__blobLoads;
      return !!loads && loads.length === 8 && loads.filter(Boolean).length === 8;
    },
    { timeout: 5_000 },
  );

  const loaded = await page.evaluate(() => (window as IframeLoadWindow).__blobLoads);
  expect(loaded).toEqual(expected);

  await page.evaluate(() => {
    const blobSecondLoadsWindow = window as IframeLoadWindow & {
      __blobSecondLoads: string[];
    };
    blobSecondLoadsWindow.__blobSecondLoads = [];
    for (let index = 0; index < 8; index++) {
      const frame = document.getElementById(`blob-frame-${index}`) as HTMLIFrameElement;
      const url = URL.createObjectURL(
        new Blob([`<!doctype html><p>blob child ${index} again</p>`], {
          type: "text/html",
        }),
      );
      frame.onload = () => {
        blobSecondLoadsWindow.__blobSecondLoads[index] =
          frame.contentDocument?.body?.textContent ?? "";
        URL.revokeObjectURL(url);
      };
      frame.src = url;
    }
  });
  await page.waitForFunction(
    () => {
      const loads = (window as IframeLoadWindow).__blobSecondLoads;
      return !!loads && loads.length === 8 && loads.filter(Boolean).length === 8;
    },
    { timeout: 5_000 },
  );
  const secondLoads = await page.evaluate(() => (window as IframeLoadWindow).__blobSecondLoads);
  expect(secondLoads).toEqual(expected.map((value) => `${value} again`));
});

test("a Blob navigation after insertion follows the about:blank load", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const url = await page.evaluate(() => {
    const frame = document.createElement("iframe");
    const loads: string[] = [];
    frame.onload = () => {
      loads.push(frame.contentDocument?.body?.textContent ?? "");
    };
    document.body.appendChild(frame);
    const blobUrl = URL.createObjectURL(new Blob(["<p>blob child</p>"], { type: "text/html" }));
    (window as IframeLoadWindow).__blobRaceLoads = loads;
    frame.src = blobUrl;
    return blobUrl;
  });

  try {
    await page.waitForFunction(
      () => (window as IframeLoadWindow).__blobRaceLoads?.includes("blob child") === true,
      { timeout: 5_000 },
    );
    const loads = await page.evaluate(() => (window as IframeLoadWindow).__blobRaceLoads);
    expect(loads).toEqual(["", "blob child"]);
  } finally {
    await page.evaluate((blobUrl) => URL.revokeObjectURL(blobUrl), url);
  }
});

test("a same-origin iframe can load successive HTML Blob documents", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const loaded = await page.evaluate(async () => {
    const frame = document.createElement("iframe");
    const results: { marker: string; normalizedText: string }[] = [];

    for (const marker of ["first", "second"]) {
      const blob = new Blob([`<p id=marker>${marker}</p>`], {
        type: "text/html",
      });
      const url = URL.createObjectURL(blob);
      const loadedDocument = new Promise<Document>((resolve, reject) => {
        frame.onload = () => {
          const child = frame.contentDocument;
          if (child) resolve(child);
          else reject(new Error("Blob iframe committed without a document"));
        };
        frame.src = url;
        if (frame.parentNode === null) document.body.appendChild(frame);
      });
      try {
        const child = await loadedDocument;
        const body = child.body;
        if (!body) throw new Error("Blob iframe document is missing body");
        body.appendChild(child.createTextNode("left"));
        body.appendChild(child.createTextNode(""));
        body.appendChild(child.createTextNode("right"));
        child.normalize();
        const textNodes = Array.from(body.childNodes).filter((node) => node.nodeType === 3);
        results.push({
          marker: child.getElementById("marker")?.textContent ?? "",
          normalizedText: String(textNodes[textNodes.length - 1]?.nodeValue ?? "").slice(-9),
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return results;
  });

  expect(loaded).toEqual([
    { marker: "first", normalizedText: "leftright" },
    { marker: "second", normalizedText: "leftright" },
  ]);
});

test("an empty HTML Blob navigation replaces the about:blank document", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const reusedDocument = await page.evaluate(async () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const placeholder = frame.contentDocument;
    if (!placeholder) throw new Error("about:blank document is missing");

    const url = URL.createObjectURL(new Blob([], { type: "text/html" }));
    try {
      const loadedDocument = new Promise<Document>((resolve, reject) => {
        frame.onload = () => {
          const committed = frame.contentDocument;
          if (committed) resolve(committed);
          else reject(new Error("empty Blob navigation lost its document"));
        };
        frame.src = url;
      });
      const committed = await loadedDocument;
      return committed === placeholder;
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  expect(reusedDocument).toBe(false);
});

test("HTML DOMParser keeps a leading processing instruction as a comment", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const tree = await page.evaluate(() => {
    const parsed = new DOMParser().parseFromString('<?xml version="1.0">Hi', "text/html");
    const children = Array.from(parsed.childNodes);
    const comment = children[0];
    if (!comment) throw new Error("HTML parser omitted the leading comment");
    comment.nodeValue = "changed comment";
    return {
      children: children.map((node) => ({
        nodeType: node.nodeType,
        nodeName: node.nodeName,
        nodeValue: node.nodeValue,
      })),
      commentValue: comment.nodeValue,
    };
  });

  expect(tree).toEqual({
    children: [
      { nodeType: 8, nodeName: "#comment", nodeValue: "changed comment" },
      { nodeType: 1, nodeName: "HTML", nodeValue: null },
    ],
    commentValue: "changed comment",
  });
});

test("a loading=lazy iframe does not delay the window load event", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-lazy-no-load-block.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const windowLoadAt = (await page.evaluate(`window.__windowLoadAt`)) as number | null;
  expect(typeof windowLoadAt).toBe("number");
  expect(windowLoadAt).toBeLessThan(1500);

  await page
    .waitForFunction(() => (window as IframeLoadWindow).__iframeSawWindowLoaded === true, {
      timeout: 6000,
    })
    .catch(() => {});
  const sawLoaded = (await page.evaluate(`window.__iframeSawWindowLoaded`)) as boolean | null;
  expect(sawLoaded).toBe(true);
});

test("an iframe detached mid-fetch does not hold the load event to the cap", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-detach-before-load.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const loadAt = (await page.evaluate(`window.__loadAt`)) as number | null;
  expect(typeof loadAt).toBe("number");
  expect(loadAt).toBeLessThan(3000);
});

test("setDocumentContent does not inherit an iframe gate from the outgoing document", async ({
  page,
}) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const session = await page.createCDPSession();
  const tree = (await session.send("Page.getFrameTree")) as {
    frameTree: { frame: { id: string } };
  };
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html:
      "<!doctype html><p id=replaced>no iframes here</p>" +
      "<script>window.__t0=Date.now();window.__loadAt=null;" +
      "addEventListener('load',function(){window.__loadAt=Date.now()-window.__t0;});</script>",
  });

  expect(await page.evaluate(`document.getElementById("replaced").textContent`)).toBe(
    "no iframes here",
  );

  await page
    .waitForFunction(() => typeof (window as IframeLoadWindow).__loadAt === "number", {
      timeout: 6000,
    })
    .catch(() => {});
  const loadAt = (await page.evaluate(`window.__loadAt`)) as number | null;
  expect(loadAt).not.toBeNull();
  expect(loadAt).toBeLessThan(3000);
});

test("an iframe without src fires its about:blank load before appendChild returns", async ({
  page,
}) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const order = await page.evaluate(() => {
    const events: string[] = [];
    const frame = document.createElement("iframe");
    frame.onload = () => {
      events.push(frame.contentDocument ? "load" : "load without document");
    };
    document.body.appendChild(frame);
    events.push("appendChild returned");
    return events;
  });

  expect(order).toEqual(["load", "appendChild returned"]);
});
