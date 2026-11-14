# Patches

**Vendor crate patches** — deltas against library crates that cargo
links into the wasm build. The provenance table lists all patched
crates.

Each crate's delta is a **git-format-patch series** in
`scripts/patches/<crate>-<version>/` — numbered `0001-*.patch`,
`0002-*.patch`, … applied in filename order. Every patch is a real
git commit (author, date, subject, message body), so `git log` in the
materialised tree reads like the crate's local history and each
logical change is reviewable on its own.

Each patch carries its real author. Only the materialiser's own
`vendor-base` commit and the committer field use the synthetic vendor
identity.

Materialised at build time by `scripts/get-patched-vendor-crates.mjs`
into `packages/core/target/vendor-patched/<crate>-<version>/`, where
the repo-root `Cargo.toml`'s `[patch.crates-io]` block picks them up
(cargo only honors patch tables in the workspace root manifest).

Historical: this directory previously held one monolithic
`<crate>-<version>.patch` per crate (and before that, a build-tool
patch against `wasm-bindgen-cli`, obsoleted by wasm-bindgen 0.2.122).
The monolithic patches were folded into each series' `0001` baseline
commit; new changes land as separate commits on top.

See the repo-root `Cargo.toml`'s `[patch.crates-io]` block for the
library wiring and `AGENTS.md` for the architectural background.

---

## How it works

Each series applies against the **registry tarball** for the named
crate at the named version. The pristine tarball is whatever
`~/.cargo/registry/src/index.crates.io-*/<crate>-<version>/`
contains after `cargo info --locked --registry crates-io <crate>@<version>`.

`scripts/get-patched-vendor-crates.mjs` materialises each crate into
`packages/core/target/vendor-patched/<crate>-<version>/` as a **real
git repo**:

1. copy the registry source verbatim (`chmod -R u+w` — registry
   sources are read-only),
2. `git init`; commit everything as the base commit, tagged
   **`vendor-base`** (fixed synthetic identity + epoch-ish date, so
   the base commit is byte-deterministic across machines),
3. `git am` the series — one commit per patch, preserving each
   patch's author, date, and message,
4. record the series sha8 in a `.patch-sha8` marker so subsequent
   runs no-op until any patch in the series changes.

Bazel does not read these trees. Its `patched_crate` repository rule
(`bazel/rust/crates.bzl`) applies the committed `.patch` files to the
registry source itself, so the trees are only for editing patches and
for direct `cargo` builds from `packages/core/`, which work as long as
the materialiser has run at least once since the last series change.

The materialised trees live under `target/` (gitignored), so nothing
patched (and no nested `.git`) ends up committed. Only the `.patch`
files in this directory carry the delta.

All plumbing git invocations run with `GIT_CONFIG_GLOBAL=/dev/null` /
`GIT_CONFIG_SYSTEM=/dev/null`, so user config (gpg signing, autocrlf,
`format.*`) can't leak into materialisation or regenerated patches.

## Provenance

| Crate                 | Version        | Upstream                                          | Source           |
| --------------------- | -------------- | ------------------------------------------------- | ---------------- |
| `parley`              | `0.12.0`       | `linebender/parley`, path `parley/`               | registry tarball |
| `parley_engine`       | `0.12.0`       | `linebender/parley`, path `parley_engine/`        | registry tarball |
| `blitz-dom`           | `0.3.0-beta.4` | `DioxusLabs/blitz`, path `packages/blitz-dom/`    | registry tarball |
| `blitz-paint`         | `0.3.0-beta.4` | `DioxusLabs/blitz`, path `packages/blitz-paint/`  | registry tarball |
| `blitz-html`          | `0.3.0-beta.4` | `DioxusLabs/blitz`, path `packages/blitz-html/`   | registry tarball |
| `blitz-traits`        | `0.3.0-beta.4` | `DioxusLabs/blitz`, path `packages/blitz-traits/` | registry tarball |
| `anyrender`           | `0.14.0`       | `DioxusLabs/anyrender`, path `crates/anyrender/`  | registry tarball |
| `anyrender_vello_cpu` | `0.18.0`       | `DioxusLabs/anyrender`                            | registry tarball |
| `taffy`               | `0.15.0`       | `DioxusLabs/taffy`                                | registry tarball |
| `stylo_taffy`         | `0.3.0-beta.4` | `DioxusLabs/blitz`, path `packages/stylo_taffy/`  | registry tarball |
| `stylo`               | `0.22.0`       | servo `stylo`                                     | registry tarball |
| `selectors`           | `0.41.0`       | servo `selectors`                                 | registry tarball |
| `boa_ast`             | `0.22.0`       | `boa-dev/boa`, path `core/ast/`                   | registry tarball |
| `boa_interner`        | `0.22.0`       | `boa-dev/boa`, path `core/interner/`              | registry tarball |
| `boa_gc`              | `0.22.0`       | `boa-dev/boa`, path `core/gc/`                    | registry tarball |
| `boa_engine`          | `0.22.0`       | `boa-dev/boa`, path `core/engine/`                | registry tarball |
| `boa_parser`          | `0.22.0`       | `boa-dev/boa`, path `core/parser/`                | registry tarball |
| `usvg`                | `0.48.1`       | `linebender/resvg`, path `crates/usvg/`           | registry tarball |
| `vello_common`        | `0.3.0`        | `linebender/vello`, path `vello_common/`          | registry tarball |
| `vello_cpu`           | `0.3.0`        | `linebender/vello`, path `vello_cpu/`             | registry tarball |
| `ratatui-image`       | `8.1.1`        | `benjajaja/ratatui-image`                         | registry tarball |
| `jpeg-encoder`        | `0.7.0`        | `vstroebel/jpeg-encoder`                          | registry tarball |

fontique is no longer patched: 0.12 offers every face with the best match's
attributes, which is what our unicode-range-subset patch did.

## What each series carries

**The commit messages are the documentation** — read them directly:

```bash
head -40 scripts/patches/<crate>-<version>/*.patch   # From/Subject/body
# or, after materialising:
git -C packages/core/target/vendor-patched/<crate>-<version> log
```

One-line orientation (see each series' patches for the full why):

- **parley** — inline-span box decorations (padding/border/background/
  radius on text spans) + the per-line span-fragment sidecar the
  painter consumes; tab-size stops, per-paragraph `dir=auto`,
  `first_strong_direction`, `truncate_lines` for line-clamp; compact layout
  buffers, font-family reuse, and replayable line-break summaries.
- **parley_engine** — the engine halves of the base-direction and tab
  patches: parley 0.12 moved analysis, bidi and shaping into this crate;
  packed character flags and compact shaped-text storage.
- **blitz-dom** — stylo→parley decoration extraction, driving stylo's
  relative-selector invalidator so `:has()` invalidates, + assorted layout
  and robustness fixes (placeholder polyfill, float paint-order gate,
  inline metrics/positioning, font loading, `clear_style_snapshots`
  cascade-panic recovery, …); compact node storage, offscreen inline-layout
  eviction and summary replay, release of hidden subtree box state, box-only
  derived child lists, and compact resident and evicted inline text state.
- **blitz-html** — the XHTML sniff stops at the first non-root start
  tag outside comments and quoted literals, so text later on a minified
  one-line page cannot route it to the XML parser (`core/src/dom/scan.rs`
  mirrors the rule); parser accessors for compact element names and attributes.
- **blitz-traits** — `NodeId` stored as two `u32` halves, so node storage
  is 4-byte aligned on wasm32 and node slots carry no padding.
- **blitz-paint** — paints the span-fragment decorations; canvas
  background propagation; SVG background-repeat tiling; and the
  `begin_part`/`end_part` markers a consumer needs to know what a rect
  is FOR (see `anyrender` below); accessors for compact element data,
  on-demand rebuilding of evicted inline layouts and box-only child-list
  accessors.
- **anyrender** — `PaintScene::begin_part`/`end_part`, defaulted to
  no-ops, so the painter can name which part of which element it is
  about to draw instead of the consumer inferring it back from
  geometry, plus the form-control state (`checked`) that pixels cannot
  reveal. Consumed by the scene wire (`scene_record.rs`). Also
  `push_clip_path`/`pop_clip_path`, defaulted to a clip layer, so a
  backend can clip each draw instead of compositing a group.
- **anyrender_vello_cpu** - implements `push_clip_path` with vello_cpu's
  clip paths. The scene replayer uses it for whole-pixel rect clips,
  where it gives the same pixels as a clip layer without the extra
  layer composite (`core/src/paint/scene_replay.rs`). Also skips premultiplying
  opaque images, such as canvas frames.
- **taffy** — layout fixes for floats, grid sizing, absolute grid
  placement, a host rounding step, lazy per-node cache allocation, and packed
  populated measurement-cache slots.
- **stylo_taffy** — map anchor-dependent values to their fallback (or
  the property's initial value) instead of panicking.
- **ratatui-image** — feature-gates the terminal-capability query
  (`query`, default-on) so the crate builds for wasm at all: rustix is
  declared unconditionally for `cfg(not(windows))`, and its errno dep
  hard-errors on `target_os = "unknown"`. Upstreamable as-is.
- **stylo** — `@page` descriptors for the servo build, which omits Gecko-only longhands,
  unstyled-snapshot invalidation tolerance, and a finished
  animation keeping its `animation-fill-mode: forwards` contribution.
- **boa_ast / boa_parser / boa_interner / boa_gc / boa_engine** —
  load-bearing fixes for the eval-less runtime path (runtime eval always runs on boa),
  plus interpreter speed and memory work (each patch's message carries
  its measurements).
- **jpeg-encoder** — wasm SIMD128 color conversion and fused block
  sampling, DCT, quantization and zigzag, plus portable Huffman writer
  speedups, plus even-pixel-only chroma conversion on 4:2:0 rows, for
  screencast JPEG encoding. Output stays byte-identical
  to upstream.
- **vello_common** — consecutive fills of one gradient share one colour
  lookup table, so the thousands of tiles blitz-paint draws for a
  repeating gradient do not each allocate their own.

## Editing vendor source and regenerating the series

The vendor-patched tree is a real git repo whose history is
`vendor-base` (pristine upstream) + one commit per patch. Iterate with
plain git:

```bash
# One-time (or after a series change): materialise the trees.
pnpm run vendor:apply

# Edit, e.g.:
$EDITOR packages/core/target/vendor-patched/blitz-dom-0.3.0-beta.4/src/document.rs

# Iterate: cargo picks up edits in place. Bazel does not, until the regen.
(cd packages/core && cargo check --target wasm32-unknown-unknown)

# Once the fix is good, COMMIT it in the vendor tree. The commit
# message becomes the patch — subject + body explaining why.
git -C packages/core/target/vendor-patched/blitz-dom-0.3.0-beta.4 add -A
git -C packages/core/target/vendor-patched/blitz-dom-0.3.0-beta.4 commit

# Write the series back out:
pnpm run vendor:regen                 # all crates
pnpm run vendor:regen -- blitz-dom    # one crate only

# Review and commit (in the kitesurf repo):
git diff -- scripts/patches/
```

Keep vendor-tree commits **atomic** — each becomes one numbered patch
in the series, and the series IS the reviewable delta we ship (and the
unit we'd upstream). Amending/squashing/reordering with `git rebase -i
vendor-base` is fine; regen renumbers the files.

`vendor:regen` refuses to run with uncommitted changes in the vendor
tree (uncommitted work can't be attributed to a patch). It runs
`git format-patch --zero-commit --no-signature -N vendor-base..HEAD`,
then **round-trip verifies**: a scratch repo is rebuilt from the
freshly-written series and diffed recursively against your tree —
any mismatch aborts non-zero. A successful regen is a guarantee that
the committed series reproduces exactly what you tested.

Note: the materialiser caches by series sha8. Editing any `.patch`
invalidates the cache and the next `vendor:apply` / `build:wasm`
re-materialises (wiping the repo, including unregenerated local
commits). Regen refreshes the stamp after writing, so the normal
edit → commit → regen loop keeps your repo (and its reflog) intact.
Run `vendor:regen` before any operation that might wipe the tree
(e.g. `rm -rf packages/core/target`).

## Bumping a vendor crate

When upstream releases a new version we want:

1. `cargo update -p parley` (or whichever crate) from the repo root
   to refresh the root `Cargo.lock` against the registry.
2. Rename the series dir to the new version, e.g.
   `git mv scripts/patches/parley-0.12.0 scripts/patches/parley-0.12.1`,
   and update the `CRATES` array in
   `scripts/get-patched-vendor-crates.mjs` plus the path in
   the repo-root `Cargo.toml`'s `[patch.crates-io]` block.
3. Run `pnpm run vendor:apply`. The series either applies cleanly (no
   further action needed) or `git am` stops at the first rejecting
   patch with the offending hunk on stderr.
4. For a rejected patch, resolve in the materialised repo like any
   `git am` conflict: `git apply --reject` the failed patch, hand-merge
   the `.rej` files, `git add -A`, `git am --continue` (repeat until
   the series lands), then `pnpm run vendor:regen -- <crate>` to write
   the rebased series back.
5. Check whether upstream absorbed any of our patches — if a commit
   becomes empty on the new base, drop it (note it in the kitesurf
   commit message) rather than shipping a no-op patch.
6. Update the provenance table above.
7. Smoke: `pnpm run test:e2e lifecycle-demo`, which builds from the
   regenerated series.

---

## Why this approach

- **Visibility**: the in-tree delta is small, and `git log` in any
  materialised tree tells the story commit by commit — subject, body,
  author, date. `git diff scripts/patches/` still shows the entire
  set of upstream modifications at a glance.
- **Incrementality**: one logical change = one commit = one patch
  file. Review, revert, and upstream each independently instead of
  re-reading one ever-growing monolithic diff.
- **No vendored bulk**: we don't commit pristine upstream source we
  don't own. The patch series replaced 2.6 MB of vendored source.
- **Cache by series sha**: changing any patch invalidates the matching
  materialised tree and, because the patch files are inputs of Bazel's
  patched crate repositories, the Bazel build of that crate.
- **Direct cargo still works**: `[patch.crates-io]` points at a stable
  in-tree path (`packages/core/target/vendor-patched/<crate>-<version>`),
  so `cargo build` from `packages/core/` works as long as the
  materialiser has run at least once since the last series change.
- **Each tree is its own cargo workspace**: the materialiser stamps an
  empty `[workspace]` table into the vendor-base commit, because the
  repo-root workspace's walk-up would otherwise claim the tree as a
  stray member (`workspace.exclude` can't cover the versioned paths).

## Why not contribute upstream

We will. Several fixes are marked "should land upstream" in their
commit messages (stylo invalidation, boa_ast scope analysis, boa_gc
worklist). The per-commit series makes that mechanical: each patch is
already a self-contained commit with rationale, ready to cherry-pick
onto an upstream clone. The parley inline-decoration work goes as a
follow-up to linebender/parley#208 ("Tracking: Features for Blitz")
with the algorithm spelled out in a design doc.
