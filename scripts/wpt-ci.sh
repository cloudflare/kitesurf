#!/bin/bash
# Copyright (c) 2026 Cloudflare, Inc.
# Licensed under the Apache 2.0 license found in the LICENSE file or at:
# https://opensource.org/licenses/Apache-2.0

# CI's wpt job: build the merged WPT buckets, redraw each retry candidate of the gate in fresh
# actions, then judge the lot against tests/wpt-expectations.json. Arguments go to every Bazel
# command; run it locally as `scripts/wpt-ci.sh --config=bazelflare`.
set -euo pipefail
cd "$(dirname "$0")/.."

bazel build "$@" //tests/wpt:merged
# The output path depends on the configuration and on whether this tree is the main repository.
quiet=(--noshow_progress --ui_event_filters=-info)
merged=$(bazel cquery "$@" "${quiet[@]}" --output=files //tests/wpt:merged |
  grep '/wpt-results\.json$')
merged="$(bazel info "$@" "${quiet[@]}" execution_root)/$merged"

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
# Past the retry cap this writes no candidates, and the gate below fails on the first results.
node scripts/wpt-gate.mjs --results "$merged" --retry-candidates "$out/retry.json"

# A new nonce per run keeps the draws out of every cache.
retry=("--//tests/wpt:retry_nonce=${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-$(date +%s)-$$}")
while IFS= read -r test; do
  retry+=("--//tests/wpt:retry_test=$test")
done < <(node -e 'for (const test of require(process.argv[1])) console.log(test)' "$out/retry.json")

bazel test "$@" --test_output=errors "${retry[@]}" //tests/wpt:expectations_test
