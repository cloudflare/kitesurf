#!/bin/bash
# Copyright (c) 2026 Cloudflare, Inc.
# Licensed under the Apache 2.0 license found in the LICENSE file or at:
# https://opensource.org/licenses/Apache-2.0

# CI's wpt job: build the merged WPT buckets, redraw each retry candidate of the gate in fresh
# actions, then judge the lot against tests/wpt-expectations.json. Arguments go to every Bazel
# command; run it locally as `scripts/wpt-ci.sh --config=bazelflare`.
set -euo pipefail
cd "$(dirname "$0")/.."

no_results() {
  echo "::error title=WPT::$1"
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
    echo "## WPT expectations gate: no results; see the job log." >>"$GITHUB_STEP_SUMMARY"
  fi
}

bazel build "$@" //tests/wpt:merged
# The output path depends on the configuration and on whether this tree is the main repository.
quiet=(--noshow_progress --ui_event_filters=-info)
merged=$(bazel cquery "$@" "${quiet[@]}" --output=files //tests/wpt:merged |
  grep '/wpt-results\.json$') || merged=""
if [[ -z $merged ]]; then
  no_results "bazel cquery found no wpt-results.json for //tests/wpt:merged"
  exit 1
fi
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

status=0
bazel test "$@" --test_output=errors --nozip_undeclared_test_outputs "${retry[@]}" \
  //tests/wpt:expectations_test || status=$?

# The gate writes these into its undeclared test outputs; GitHub shows them on the run and the PR.
gate="$(bazel info "$@" "${quiet[@]}" bazel-testlogs)/scripts/wpt_expectations_test/test.outputs"
if [[ ! -f $gate/summary.md ]]; then
  no_results "the expectations gate wrote no summary"
else
  # Bazel shows the gate's own output only when it fails, so log the totals here.
  grep -E '^[0-9]+ (tests:|of [0-9]+ tests pass)' "$gate/summary.md" | sed 's/^/[wpt-gate] /' || true
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then cat "$gate/summary.md" >>"$GITHUB_STEP_SUMMARY"; fi
fi
if [[ ${GITHUB_ACTIONS:-} == true && -f $gate/annotations.txt ]]; then cat "$gate/annotations.txt"; fi
exit "$status"
