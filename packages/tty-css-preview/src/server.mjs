// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Serves terminal user-agent styles over loopback HTTP for the live preview extension.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST = "127.0.0.1";
const PORT = 8765;
const CSS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../engine/src/tty");

async function loadTtyCss(level, cssDirectory) {
  if (level !== 1 && level !== 2) {
    throw new RangeError("The level must be 1 or 2");
  }

  const baseCss = await readFile(resolve(cssDirectory, "stylesheet.css"), "utf8");
  if (level === 1) return baseCss;

  const level2Css = await readFile(resolve(cssDirectory, "stylesheet-level2.css"), "utf8");
  return `${baseCss.trimEnd()}\n\n${level2Css}`;
}

function responseHeaders(contentType) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  };
}

/** @returns {import("node:http").Server} */
export function createPreviewServer(options = {}) {
  const cssDirectory = options.cssDirectory ?? CSS_DIRECTORY;

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? HOST}`);

    if (request.method === "OPTIONS") {
      response.writeHead(204, responseHeaders("text/plain; charset=utf-8"));
      response.end();
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, responseHeaders("text/plain; charset=utf-8"));
      response.end("Method not allowed\n");
      return;
    }

    if (url.pathname === "/health") {
      response.writeHead(200, responseHeaders("application/json; charset=utf-8"));
      response.end(request.method === "HEAD" ? undefined : '{"ok":true}\n');
      return;
    }

    if (url.pathname !== "/tty.css") {
      response.writeHead(404, responseHeaders("text/plain; charset=utf-8"));
      response.end("Not found\n");
      return;
    }

    const level = Number(url.searchParams.get("level") ?? "1");
    try {
      const css = await loadTtyCss(level, cssDirectory);
      response.writeHead(200, responseHeaders("text/css; charset=utf-8"));
      response.end(request.method === "HEAD" ? undefined : css);
    } catch (error) {
      if (error instanceof RangeError) {
        response.writeHead(400, responseHeaders("text/plain; charset=utf-8"));
        response.end(`${error.message}\n`);
        return;
      }

      console.error("[tty-css-preview] Failed to read the stylesheets", error);
      response.writeHead(500, responseHeaders("text/plain; charset=utf-8"));
      response.end("Failed to read the stylesheets\n");
    }
  });
}

function runServer() {
  const server = createPreviewServer();
  server.listen(PORT, HOST, () => {
    console.log(`[tty-css-preview] Serving ${CSS_DIRECTORY}`);
    console.log(`[tty-css-preview] CSS URL: http://${HOST}:${PORT}/tty.css?level=1`);
  });

  server.on("error", (error) => {
    console.error("[tty-css-preview] Server error", error);
    process.exitCode = 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runServer();
}
