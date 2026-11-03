# Contributing to Kitesurf

Thanks for your interest. Kitesurf is a proof-of-concept browser engine, and many
standards and behaviors are incomplete. Read the relevant code and its comments
before you assume a feature works.

## Read this first

We have limited review capacity. Opening a pull request does not oblige us to
review or merge it. We may close or defer it, ask for a smaller scope, or
implement the idea differently. Following this guide makes a pull request
eligible for review; it does not guarantee that it will be merged.

These rules apply to every open pull request, including drafts.

Focused bug fixes, web-compatibility fixes, reliability and performance
improvements, and documentation fixes are the most likely to be accepted.
Unrequested features, large rewrites, and unrelated cleanup are not.

Report bugs and propose features in
[issues](https://github.com/cloudflare/kitesurf/issues). Search existing issues
and the docs before you start.

## Get vouched before you open a pull request

Pull requests from contributors who are not on [`.github/VOUCHED.td`](.github/VOUCHED.td)
are closed automatically when they are opened or reopened. Issues stay open to
everyone.

1. **Open an issue.** For a bug, include a minimal reproduction, the expected
   result, and the actual result. For a feature or behavior change, describe the
   use case and the approach you have in mind.
2. **Wait for a maintainer to agree and vouch for you.** A maintainer adds your
   GitHub username to the vouched list. A vouch lets you open pull requests; it
   does not approve any code. Bots and collaborators with write access do not
   need an entry.
3. **Open a focused pull request** that links the issue.

If your pull request was closed before you were vouched, link it from the issue.
A maintainer can reopen it after vouching for you.

## Agree on the problem and scope first

Features and intentional behavior changes need a maintainer to approve the
direction and scope in an issue before you write the code. Link that approval in
the pull request. Calling a behavior change a bug fix does not remove this
requirement, and agreeing that a problem exists does not approve every way of
fixing it.

For a substantial bug fix, link an issue in which maintainers confirmed the
failure and the intended behavior.

Once you are vouched, you can send a small fix for an obvious bug without a new
issue. Explain the defect and why the fix is small and safe. There is no
line-count cutoff: we judge the purpose and the behavior change, not the size of
the diff.

## Solve one problem per pull request

Split a pull request that fixes several independent problems, even when each fix
is useful. Count the underlying problems, not the linked issues; several reports
can describe one defect.

Include everything that one problem needs: the code, the tests, and any
documentation it changes. An adjacent cleanup, refactor, or second fix belongs in
its own pull request. If your change alters an invariant, update the comment
that states it in the same commit.

## Show that the change works

Explain how you established the problem, how you checked the fix, and what you
saw. Give the reproduction steps, the commands you ran, and their results. Say
what you could not check. "Tests pass" on its own does not show that a change
works.

Match the evidence to the change:

- **Behavior changes** need a focused test. Prefer a hermetic e2e test with
  inline markup over a new fixture route.
- **Rendering changes** need before and after screenshots. Attach them to the
  pull request; do not commit them.
- **Web-compatibility changes** should name the Web Platform Tests or sites they
  affect.

Run the checks that cover what you changed rather than every lane in the repo.

## Development setup

- Node.js 22, which CI uses.
- pnpm 9.15.4, pinned through `packageManager` in the root `package.json`. Run
  `corepack enable` to use it.
- Bazelisk, installed as `bazel`. Bazel builds and tests everything, and fetches
  its own Rust toolchains, wasm-bindgen, and binaryen.
- On macOS, GNU tar (`brew install gnu-tar`).
- Rust through rustup, only for editing vendored crate patches.
  `rust-toolchain.toml` pins `nightly-2026-05-14` with the
  `wasm32-unknown-unknown` target, the same nightly Bazel uses.

```bash
pnpm install --frozen-lockfile
pnpm run build
```

`pnpm run build` builds the wasm modules and loaded-worker bundles with Bazel
and copies them into the source tree. Run `pnpm run dev` to build and serve the
engine locally and `pnpm run test:e2e <substring>` for a focused e2e subset.

Maintainers with a Cloudflare Access login can add `--config=bazelflare` to any
Bazel command on Linux x86-64. It runs every action on bazelflare, the remote
execution service CI builds on, and reads the cache main's CI writes. Log in
once with `cloudflared access login https://bazelflare.kitesurf.workers.dev`.
Everyone else builds locally, as above.

## Checks

Before you open a pull request, run:

```bash
pnpm run check
pnpm run test:e2e <file-substring>
```

Pass a file-name substring to `test:e2e` to run only the files you touched. For
Rust changes, also run `pnpm run test:rust` and `pnpm run lint:rust` (the Rust
gates as Bazel tests). CI runs
the build, the checks, the Rust host tests and the vitest suite. It does not run
the e2e, WPT or Playwright lanes, so run the ones your change touches. CI builds
on bazelflare, except for a pull request from a fork: GitHub gives its jobs no
token to authenticate with, so they build on the runner, which takes longer.

## Commits

- Keep one reason in each commit. The commit body explains why the change is
  correct.
- Use a subject of the form `scope: lowercase imperative summary`, about 70
  characters long.
- Do not edit generated files by hand. Regenerate them from their source.
- AI assistance is optional. If you use it, understand and verify every line of
  the patch before you submit it.

## Review and closure

A maintainer may close a pull request that does not meet this guide before a full
review. A policy-based closure names the rule, points to the evidence, and says
how to fix it: for example, which independent changes to split or which check is
missing. Fix the problem and ask for reconsideration, or open focused replacement
pull requests that link the original.

If we decline a proposed fix but the report shows a real problem, we keep the
issue open for that problem. Feedback stays specific and civil, and it is about
the change, not about how it was written.

## Contributions and licensing

Unless you state otherwise, any contribution you submit for inclusion is licensed
under the Apache License, Version 2.0, as described in Section 5 of that license.

Every commit must carry a [Developer Certificate of Origin](https://developercertificate.org/)
sign-off. By adding it, you certify that you wrote the change or otherwise have
the right to submit it under the project's license. Add the line with
`git commit -s`, or add it to existing commits with `git rebase --signoff main`:

```text
Signed-off-by: Your Name <you@example.com>
```

The email must match the commit author. The DCO workflow checks every commit in a
pull request with `scripts/check-dco.mjs`.
