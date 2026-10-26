# Reproduce

Find out whether a Kitesurf bug report is valid and reproducible. Run the
repro in Kitesurf and in Chrome, and compare the two.

**CRITICAL: Always write `report.md` to the triage directory before you
finish, whatever the outcome. Downstream steps and the orchestrator read
it. If you finish without writing it, the pipeline fails silently.**

**SCOPE: Reproduction only. No diagnosis, no fix. Don't spawn subagents.**

## Prerequisites

- **`triageDir`**: working directory, e.g. `triage/gh-123`.
- **`issueDetails`**: the GitHub issue payload.

## Step 1: Read the report

Note:

- The repro: markup, a URL, or CDP / Puppeteer / Playwright calls.
- Expected and actual behaviour.
- The **entry point** from the issue form: CDP WebSocket
  (`/devtools/browser` or `/devtools/page`), scene stream
  (`kitesurf-cli`), or other.
- The Kitesurf commit or release, and where the engine ran (local
  `wrangler dev` or deployed on Workers).
- Any later comment that changes the picture.

## Step 2: Check for early exits

An early exit is valid only if no later comment cancels it. Write the
reason code in `report.md`.

### `not-actionable`

A feature request, question or discussion, not a bug report.

### `missing-details`

No repro you can run (no markup, no URL, no script), or no expected
result.

### `unsupported-feature`

The report depends on something Kitesurf does not support on purpose.
The list is `AGENTS.md` "Out of scope unless asked". Read the current
text, because it changes, and use only what it says. Today it includes:

- WebGL, WebGPU, WebAudio, WebRTC and MediaStream.
- Service workers and shared workers. Module workers and `importScripts`.
- Anti-bot fingerprinting, and sites that serve a bot challenge (you get
  the challenge HTML, not the page).
- Persistent state across navigations or connections: long logged-in
  sessions, cookies or storage that must survive a reconnect.
- Synchronous XHR.
- A live SVG DOM.
- WebDriver. Kitesurf speaks CDP.

`skipped` is final: the bot never looks at the issue again. If the list
does not clearly name the feature, do not use this exit.

**A partial-support area is not an early exit.** Iframes, ES modules,
SVG snapshots and dedicated workers work with documented limits. Read
those limits in `AGENTS.md` and the code comments, and continue if the report
falls inside what is supported.

### `live-site-only`

The repro is a live third-party URL that you can't reach, or whose
content changes between runs, and the report gives no markup. First try
to save the page (`curl -L` the HTML) and reduce it. Use this exit only
if that fails.

### `maintainer-override`

A maintainer (`authorAssociation` `MEMBER`, `COLLABORATOR` or `OWNER`)
said not to auto-triage this issue.

## Step 3: Set up the repro

Write the repro into `triageDir`:

- **Markup**: save it as `repro.html`. Keep the reporter's markup as
  given. Reduce it only after you have reproduced the bug.
- **URL**: use `--url`. If the page needs a real origin (subresources,
  headers, redirects), keep the URL. If it doesn't, save the HTML to
  `repro.html` so the run does not depend on the network.
- **Entry point**: reproduce through the entry point in the report. A
  `kitesurf-cli` report goes through the CLI and the route it calls
  (`packages/kitesurf-cli/`), not through
  `Page.navigate`. A CDP stand-in can fail for a different reason and
  send the diagnosis to the wrong layer.
- **Script**: put the reporter's steps into `repro.mjs`, with a default
  export `async (page, { browser, label }) => value`. Return the values
  the report is about (computed styles, bounding boxes, the error
  message, the event order). Catch exceptions inside the function and
  return them as values, so both browsers produce comparable output.

## Step 4: Start the engine

`pnpm run dev` runs the Bazel dev build (`bazel run
//packages/engine:dev_build`) and then `wrangler dev`. Bazel only rebuilds
what changed, so restarts are quick once the first build is done. The
first build compiles the Rust to wasm and is slow. In CI the workflow
runs `pnpm run build` before the skill, from the Bazel cache that
`ci.yml` saves on `main`.

```bash
source scripts/dev-ports.sh          # sets KITESURF_PORT for this worktree
pnpm run dev > "$triageDir/engine.log" 2>&1 &
echo $! > "$triageDir/engine.pid"
# wait until it answers
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$KITESURF_PORT/json/version" >/dev/null && break; sleep 2; done
```

If it does not answer after two starts, stop. Write `report.md` with the
tail of `engine.log`.

## Step 5: Run it in both browsers

```bash
node .agents/skills/triage/scripts/repro-diff.mjs --out "$triageDir/run" \
  --html "$triageDir/repro.html" [--script "$triageDir/repro.mjs"]
```

The script writes `kitesurf.png`, `chrome.png`, `diff.png`, one JSON file
per browser (output, console messages, page errors, load time), and
`summary.json` (pixel diff ratio, whether the outputs are equal).

Other flags: `--url <url>` instead of `--html`, `--width 1280`,
`--height 800`, `--settle-ms 250`, `--engine-only`. `--html` loads the file
through a data: URL in Kitesurf, the same way the e2e `setContent` helper
does, and from `http://localhost/` in Chrome, so Chrome sees a secure
context. Kitesurf is reached at
`ws://127.0.0.1:$KITESURF_PORT/devtools/browser`. Chrome is launched with
puppeteer-core from `$CHROME_PATH` or the usual install locations.

`--script` takes an ES module whose default export runs after load. Its
return value must be JSON-serialisable. Both outputs are compared with a
deep-equal:

```js
export default async function (page, { browser, label }) {
  return await page.evaluate(() => document.title);
}
```

Exit code 0 means every browser you asked for started; read
`summary.json` for the verdict. A Kitesurf crash after it connected is exit 0 with
`kitesurf.ok: false`: that is a finding. Exit code 2 means an
infrastructure failure: the engine did not answer, Chrome was not found
or would not start, or an argument is invalid. A `--script` that runs for over 60 seconds
fails that browser's run.

**The two documents have different origins.** With `--html`, Kitesurf
loads a `data:` URL and Chrome loads `http://localhost/__repro.html`. So
`location`, `document.URL`, `origin`, cookies, storage and relative URLs
differ by design. If the report depends on any of these, serve the page
from a real origin and use `--url` for both browsers, and say so in the
report.

Then decide:

1. **Does Kitesurf show the reported behaviour?** Compare against the
   report, not only against Chrome.
2. **Does Chrome differ?** If Chrome does the same thing, say so clearly.
   It is strong evidence for "not a bug", and the verify step needs it.
3. **Baseline check.** Remove the part of the markup or script that
   triggers the bug and run again. Kitesurf should now match Chrome. This
   guards against blaming the bug on an unrelated difference, such as
   fonts.
4. **Read pixel diffs with care.** Kitesurf ships Noto fonts, not the
   platform `system-ui` font, so text pixels always differ a little. Small
   diffs spread over all the text are font noise. A bug looks like a moved
   box, a missing element, wrong colour or opacity, text that does not
   wrap, or tofu boxes.
5. Also note engine-side errors in `engine.log`: wasm panics, `Disallowed
   operation called within global scope`, `exceeded memory limit`.

One reproduction run plus one baseline run is enough. More digging
belongs in the diagnose step.

### CDP-only bugs

Some bugs have nothing to see: a wrong CDP reply, a missing event, a race.
Use `--script` and return the CDP result from `page.target().createCDPSession()`.
For a race, run the repro 5 times and record how many runs fail. `AGENTS.md`
"Architecture" matters here: Puppeteer must use `/devtools/browser`.

## Step 6: Stop the engine

Killing the `pnpm` PID is not enough: `wrangler` and its `workerd`
children outlive it. Kill the process tree you started, children first,
then check that the port is free:

```bash
kill_tree() { [ -n "$1" ] || return 0; for c in $(pgrep -P "$1"); do kill_tree "$c"; done; kill "$1" 2>/dev/null; }
kill_tree "$(cat "$triageDir/engine.pid")"; sleep 2
lsof -ti:"$KITESURF_PORT" && echo "engine still running" || echo "port free"
```

Never run `pkill wrangler`, `pkill workerd` or a `pkill -f` on the
checkout path: a maintainer's own dev server, editor tooling and other
worktrees match them too. Do the same every time you restart the engine
in later steps.

## Step 7: Write `report.md`

This is context for the next step, not a human-facing message. Include:

- Issue title, the repro, and expected and actual behaviour.
- Entry point, Kitesurf commit (`git rev-parse HEAD`), Chrome version.
- Every command you ran and what happened.
- The `summary.json` values and paths to the screenshots.
- What Chrome did, and the baseline result.
- Exact error text and stack traces, from page and engine.
- The outcome: `reproduced`, `not-reproduced` or `skipped:<reason>`, and why.
