# Diagnose

Find the root cause of a reproduced bug in the Kitesurf source.

**CRITICAL: Always read `report.md` and append to it before you finish,
whatever the outcome.**

**SCOPE: Diagnosis only. No fix. Don't spawn subagents.**

## Prerequisites

- **`triageDir`**, **`issueDetails`**, and `report.md` from the reproduce step.

## Step 1: Read the reproduction

Read `report.md`. If the bug was not reproduced or was skipped, append
`DIAGNOSIS SKIPPED: no reproduction` and return `confidence: null`.

Read `AGENTS.md` "Architecture" and "Platform quirks with in-tree
mitigations". Then read the comments at the top of the files that own the
area you are in. Kitesurf keeps the "why is it built like this" answers
in code comments next to the code.

## Step 2: Find the layer

A request goes through these layers. Use the error text, stack frames and
the kind of difference to pick a starting layer:

| Symptom                                                                                                                                                                                | Start in                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Wrong CDP reply, missing or out-of-order event, session or target bugs, a race between commands                                                                                        | `packages/engine/src/cdp/` (one file per domain), `packages/engine/src/index.ts` (routing)                   |
| Subresource fetch, CORS, cookies, headers, redirects                                                                                                                                   | `packages/engine/src/eval/`                                                                                  |
| Navigate, script loading and order, module graphs, timers, page lifecycle                                                                                                              | `packages/page-script/src/`                                                                                  |
| A DOM API returns the wrong value, events, CSSOM, forms, `element.style`                                                                                                               | `packages/dom-shim/src/`                                                                                     |
| JS that runs after navigate or through `Runtime.evaluate` behaves differently from inline scripts; `ReferenceError` from boa frames; values that change when they cross between realms | the boa ↔ V8 bridge in `packages/core/src/js/` (`AGENTS.md` "Architecture", first bullet)                    |
| Wrong style, layout, text wrap, fonts, paint, opacity, images                                                                                                                          | `packages/core/src/` and the vendored crates (below)                                                         |
| Screenshot or screencast frame wrong while the DOM and layout are right                                                                                                                | `packages/page-renderer/src/`, `packages/renderer-core/`, the scene protocol in `packages/engine/src/rbi.ts` |
| CSP, SRI, MIME or mixed-content blocks a script                                                                                                                                        | `packages/script-gate/`                                                                                      |
| `new Worker()`                                                                                                                                                                         | `packages/worker-script/`                                                                                    |
| Terminal / `kitesurf-cli` output                                                                                                                                                       | `packages/kitesurf-cli/`, `packages/engine/src/tty/`                                                         |

### Our code or a third-party crate?

Style, layout, text and paint come from patched third-party crates:
Blitz (`blitz-dom`, `blitz-paint`), Stylo (style), Taffy (box layout),
Parley (text layout), vello_cpu (raster), usvg (SVG) and Boa (the JS
interpreter). The pristine sources are materialised under
`packages/core/target/vendor-patched/<crate>-<version>/` by
`pnpm run vendor:apply`. Our changes to them are the patch series in
`scripts/patches/<crate>-<version>/` (`AGENTS.md` "Vendored crate
patches").

Point at a crate when the wrong value comes out of that crate's own
logic with correct input from us. Examples: Parley removes a white-space
span at an inline edge, or Taffy sizes a table caption from its
max-content width. Point at our code when we pass the crate wrong
input, call it in the wrong order, or miss a feature it already has.
Check our patch series first: a lot of crate behaviour is already ours.

Also check `AGENTS.md` "Platform quirks with in-tree mitigations". Some
bugs live in the runtime underneath us (workerd, Stylo on wasm32). Two
cases:

- **A platform quirk** (scheduling, I/O, a crash, a single-subtest
  delta): layer `upstream:workerd`. These need a pin and an upstream
  report, not a shim.
- **A Web API that pages call, where workerd's native answer breaks the
  spec** (wrong error type, wrong `constructor`, a legacy extension real
  browsers reject) and real pages or a whole WPT file hit it: layer
  `page-script`. Kitesurf owns the page-facing surface, and
  `installGlobals` in `packages/page-script/src/globals.ts` already wraps
  natives this way (the `DOMException` shim, `SubtleCrypto.generateKey`
  pre-validation). Still note the upstream report.

## Step 3: Instrument

`console.log` in the page isolate code shows up as CDP
`Runtime.consoleAPICalled`, and the repro-diff script records it.
`console.log` in `packages/engine/src` goes to `engine.log`.

- Edits to `packages/engine/src` hot-reload.
- Edits to `dom-shim`, `page-script`, `page-renderer` or `worker-script`
  need a restart of `pnpm run dev`, which rebuilds them with Bazel.
- Edits to Rust in `packages/core/` also need a restart, and the wasm
  rebuild is slow, so read the Rust code first and instrument it last.
- Bazel builds only committed vendor patch files. An edit inside
  `packages/core/target/vendor-patched/` is invisible to `pnpm run dev`
  until you commit it there and run `pnpm run vendor:regen -- <crate>`.

Iterate until you know which code path runs, what data it gets, and where
it goes wrong.

**Then remove all instrumentation.** Debug output must not leak into
later steps. Remove only the lines you added (`git diff` shows them);
`git checkout -- <file>` also throws away a maintainer's uncommitted
edits when the skill runs on their machine.

## Step 4: Name the root cause

Write down:

1. The file(s) and line numbers.
2. What the code does wrong.
3. Why that produces the reported behaviour.
4. The shape of a fix.
5. Whether it is a regression. Use `git log -L` or `git log -S` on the
   lines involved.
6. Other inputs that hit the same path.

Describe it plainly. Don't call something "critical" or "fundamentally
broken" unless the evidence says so.

## Step 5: Append to `report.md`

- Root cause, files and line numbers.
- `layer`: one of `engine`, `page-script`, `dom-shim`, `boa-bridge`,
  `core`, `page-renderer`, `script-gate`, `worker-script`, `cli`, or
  `upstream:<crate>` / `upstream:workerd`.
- Suggested fix.
- Confidence (`high`, `medium`, `low`) and caveats.
