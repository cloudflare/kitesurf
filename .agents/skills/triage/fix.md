# Fix

Write a failing test, then make the smallest fix that turns it green.

**CRITICAL: Always read `report.md` and append to it before you finish,
whatever the outcome, including when the fix fails.**

**SCOPE: Don't spawn subagents. Don't commit or push.**

## Prerequisites

- **`triageDir`**, **`issueDetails`**, and `report.md` from the earlier steps.

## Step 1: Read the diagnosis

Read `report.md`.

- Not reproduced, or skipped: append `FIX SKIPPED: not reproduced` and
  return `fixed: false`.
- Verdict `intended-behavior` or `known-limitation`: append
  `FIX SKIPPED: <verdict>` and return `fixed: false`.
- **Low confidence, or no clear root cause:** don't change engine code.
  Write the failing test (Step 2) if you can, and add `// TRIAGE:`
  comments next to the most likely lines. Append your findings and return
  `fixed: false`.
- **Medium or high confidence:** continue.
- **Layer `upstream:workerd`:** don't shim around it. Pin the behaviour
  with a test, describe an upstream report in `report.md`, and return
  `fixed: false` (see "Platform quirks with in-tree mitigations" in
  `AGENTS.md`). This is for platform quirks only. A spec gap in a
  page-visible Web API is layer `page-script` (see
  [diagnose.md](diagnose.md)): fix it with a thin wrapper in
  `installGlobals` that validates input or fixes identity, and passes
  valid calls straight to the native. Never reimplement the API.

## Step 2: Write the failing test first

Write the test before you change any engine code. Run it and **confirm
that it fails for the reason in the report**. A test that passes before
the fix proves nothing.

Pick the test type:

1. **A hermetic e2e test**: the default. Add it to
   `packages/engine/test/e2e/<topic>.e2e.test.ts`. Put it in an existing
   file if one covers the topic. The harness boots the real engine in
   process and drives it over CDP:

   ```ts
   import { expect, test } from "./harness";
   import { setContent } from "./set-content";

   test("short description of the behaviour", async ({ page }) => {
     await setContent(page, `<p id=t style="tab-size:8">a\tb</p>`);
     // assert on the spec behaviour, not on a Chrome pixel value
   }, 120_000);
   ```

   Follow `AGENTS.md` "Tests" for markup: inline it with `setContent`, use
   `test/e2e/html/<name>.html?raw` if it is long, and add a
   `/__fixtures/*` route only if the page needs a real origin. Never test
   against a live site.

2. **A WPT test**: when the bug is a spec-conformance gap that an
   upstream WPT test already covers. If the test is not in
   `tests/wpt-tests.json`, enrol it with `pnpm run test:wpt --discover
   <prefix>` (add `--discover-pattern <regex>` to narrow it) instead of
   editing the file by hand. Run it with
   `pnpm run test:wpt --filter <path>`. If the fix makes a pinned test
   pass, rebaseline with `--update-expectations` as a separate change.

3. **A Rust unit test** in `packages/core/src/<area>/tests/<name>.rs`,
   declared in `<area>/tests.rs` (for example `layout/tests/`): for pure
   layout or text logic you can test without the engine. Add an e2e test
   as well when the bug is visible over CDP.

Assert what the spec says. When you need a number from Chrome (a
position, a width), record where it came from in a code comment, and
allow for font differences (Kitesurf ships Noto).

Run it on its own:

```bash
pnpm run test:e2e <file-substring>
pnpm run test:e2e <file-substring> -t "<test name>"
```

No `--` before the arguments (see `AGENTS.md`).

## Step 3: Make the fix

Keep it minimal:

- Change only what the fix needs. No refactors, no new features.
- Follow `AGENTS.md` "Code style". Put stateful engine work (layout,
  geometry, parsing, traversal) in Rust. Keep TypeScript for API wiring,
  lifecycle and callbacks.
- Vendored crates (Blitz, Stylo, Taffy, Parley, Boa): edit and
  `git commit` inside `packages/core/target/vendor-patched/<crate>/`, then
  run `pnpm run vendor:regen -- <crate>` to turn the commit into a patch
  file under `scripts/patches/`. Uncommitted vendor edits are lost
  (`AGENTS.md` "Vendored crate patches"). Commit on the tip of the
  vendor repo so the new patch gets the next number. If `git status`
  then shows existing patch files deleted or renamed, the commit went in
  the wrong place: fix that before you go on.
- Add a comment that explains the non-obvious _why_. If the bug came
  from a missing architectural fact, say so in `report.md`. A maintainer
  may add it to `AGENTS.md`.

## Step 4: Rebuild and check

1. Rebuild what you touched: restart `pnpm run dev`, which rebuilds the
   Rust and the in-isolate TS packages with Bazel. Run
   `pnpm run vendor:regen -- <crate>` first if you changed a vendored
   crate.
2. Run the new test. It must pass now.
3. Run the reproduce step's repro again with `repro-diff.mjs`, and
   compare it with the first run.
4. Choose the smallest checks that cover the change. Run related e2e
   files, and `pnpm run test:wpt --filter <dir>` for the spec area you
   touched. Never run a full suite.
5. Run `pnpm run check`. It must pass. A narrower typecheck does not
   replace it.
6. Read the workerd output. Green assertions don't count if workerd
   logs uncaught errors.

If you find a regression, change the fix. Don't loosen the test.

## Step 5: Clean up and record the diff

1. `git status`. Revert anything that is not part of the fix: debug
   logs, scratch files, build output. Leave `triageDir` alone, because
   it is gitignored.
2. Stop every engine you started (see the end of [reproduce.md](reproduce.md)).
3. `git diff` and save it in the report.

## Step 6: Append to `report.md`

- What changed and why.
- The full `git diff`.
- The test: file, name, what it asserts, and proof that it failed before
  the fix (the failure message).
- The checks you ran and their results.
- Whether the fix works: `fixed: true` / `false`.
- Other approaches you considered.
