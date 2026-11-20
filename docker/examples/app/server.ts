// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The app under test of the examples: a todo list that loads its items from a JSON API.
// It keeps no state, so every test starts from the same two items.

import { createServer, type ServerResponse } from "node:http";

const PORT = Number(process.env.PORT ?? 3000);
const SEED = [
  { id: 1, title: "Buy milk" },
  { id: 2, title: "Walk the dog" },
];

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Todos</title>
    <style>
      body { font-family: sans-serif; max-width: 32rem; margin: 2rem auto; }
      li { padding: 0.25rem 0; }
    </style>
  </head>
  <body>
    <h1>Todos</h1>
    <form id="new-todo">
      <label for="title">New todo</label>
      <input id="title" name="title" autocomplete="off" />
      <button type="submit">Add</button>
    </form>
    <ul id="todos" aria-label="Todos"></ul>
    <p id="count"></p>
    <script src="/app.js"></script>
  </body>
</html>
`;

const SCRIPT = `const list = document.getElementById("todos");
const count = document.getElementById("count");
const add = (todo) => {
  const item = document.createElement("li");
  item.textContent = todo.title;
  list.append(item);
  count.textContent = list.children.length + " todos";
};
fetch("/api/todos")
  .then((response) => response.json())
  .then((todos) => todos.forEach(add));
document.getElementById("new-todo").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("title");
  const response = await fetch("/api/todos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: input.value }),
  });
  add(await response.json());
  input.value = "";
});
`;

const send = (response: ServerResponse, status: number, type: string, body: string): void => {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
};

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? "/", "http://app");
  if (request.method === "GET" && pathname === "/") return send(response, 200, "text/html", PAGE);
  if (request.method === "GET" && pathname === "/app.js") {
    return send(response, 200, "text/javascript", SCRIPT);
  }
  if (request.method === "GET" && pathname === "/api/todos") {
    return send(response, 200, "application/json", JSON.stringify(SEED));
  }
  if (request.method === "POST" && pathname === "/api/todos") {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk));
    request.on("end", () => {
      const { title } = JSON.parse(body) as { title: string };
      send(response, 201, "application/json", JSON.stringify({ id: Date.now(), title }));
    });
    return;
  }
  send(response, 404, "text/plain", "not found");
}).listen(PORT, "0.0.0.0", () => console.log(`app listening on :${PORT}`));
