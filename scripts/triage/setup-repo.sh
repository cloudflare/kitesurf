#!/usr/bin/env bash
# Copyright (c) 2026 Cloudflare, Inc.
# Licensed under the Apache 2.0 license found in the LICENSE file or at:
# https://opensource.org/licenses/Apache-2.0

# Set up a GitHub repository for the issue-triage bot (scripts/triage/README.md).
# Running it twice is safe: it creates what is missing and resets the bot
# rulesets to the files in .github/rulesets.
#
#   scripts/triage/setup-repo.sh [owner/repo]            # labels, rulesets, checks
#   scripts/triage/setup-repo.sh [owner/repo] --enable   # ...then switch the bot on
#   scripts/triage/setup-repo.sh [owner/repo] --disable  # switch the bot off
#
# Needs the gh CLI, logged in as a repository admin.

set -euo pipefail

for tool in gh jq; do
  command -v "$tool" >/dev/null || {
    echo "needs $tool" >&2
    exit 2
  }
done

repo="cloudflare/kitesurf"
mode="setup"
for arg in "$@"; do
  case "$arg" in
    --enable) mode="enable" ;;
    --disable) mode="disable" ;;
    -h | --help)
      sed -n '6,14p' "$0"
      exit 0
      ;;
    */*) repo="$arg" ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rulesets_dir="$here/../../.github/rulesets"

if [[ "$mode" == "disable" ]]; then
  gh variable set TRIAGE_ENABLED --repo "$repo" --body false
  echo "triage bot off for $repo"
  exit 0
fi

echo "== labels ($repo)"
# name|color|description. The names are the triagebot-action defaults.
while IFS='|' read -r name color description; do
  gh label create "$name" --repo "$repo" --color "$color" --description "$description" --force >/dev/null
  echo "  $name"
done <<'LABELS'
triage: needs triage|d4c5f9|Waiting for the triage bot
triage: not actionable|cfd3d7|Not a bug report
triage: needs reproduction|fbca04|Missing a reproduction or the expected behavior
triage: skipped|cfd3d7|Cannot be triaged in CI (unsupported feature or host-specific)
triage: unable to reproduce|fef2c0|The bot tried and could not reproduce it
triage: unable to fix|f9d0c4|Reproduced and diagnosed, no fix found
triage: failed|b60205|The bot failed unexpectedly; a new comment retries it
triage: fix pending|0e8a16|A fix is waiting for the reporter to confirm
triage: fix rejected|e99695|The reporter says the fix does not work
triage: fix verified|0e8a16|Fix confirmed; a pull request is open
fix verified|0e8a16|Pull request opened by the triage bot
LABELS

echo "== bot rulesets"
# Match by name, and overwrite an existing one so edits to the JSON reach a
# repository that already ran this script.
existing="$(gh api --paginate "repos/$repo/rulesets" --jq '.[] | "\(.id) \(.name)"')"
for file in "$rulesets_dir"/*.json; do
  name="$(jq -r .name "$file")"
  id="$(awk -v n="$name" '{ i = $1; $1 = ""; sub(/^ /, ""); if ($0 == n) print i }' <<<"$existing")"
  if [[ -n "$id" ]]; then
    gh api --method PUT "repos/$repo/rulesets/$id" --input "$file" >/dev/null
    echo "  updated: $name"
  else
    gh api --method POST "repos/$repo/rulesets" --input "$file" >/dev/null
    echo "  created: $name"
  fi
done

missing=0
# The bot may only push triagebot/** branches; a maintainer must still review
# and merge its pull requests. The default-branch ruleset belongs to the
# maintainers, so check it rather than create it.
echo "== default branch protection"
default_branch="$(gh api "repos/$repo" --jq .default_branch)"
rules="$(gh api --paginate "repos/$repo/rules/branches/$default_branch" | jq -s 'add // []')"
# The app can submit reviews, so a plain approval could be its own. A
# code-owner review from a human team cannot.
if jq -e 'any(.[]; .type == "pull_request" and .parameters.required_approving_review_count >= 1 and .parameters.require_code_owner_review)' <<<"$rules" >/dev/null; then
  echo "  ok: $default_branch needs an approving code-owner review"
else
  echo "  MISSING: an active ruleset on $default_branch that needs an approving code-owner review"
  missing=1
fi
if gh api "repos/$repo/codeowners/errors" --silent 2>/dev/null; then
  echo "  ok: CODEOWNERS on the default branch (it must name people or a team, never the app)"
else
  echo "  MISSING: a CODEOWNERS file on the default branch"
  missing=1
fi
for id in $(jq -r '.[].ruleset_id // empty' <<<"$rules" | sort -u); do
  if ! app_bypass="$(gh api "repos/$repo/rulesets/$id" --jq '.bypass_actors // [] | any(.[]; .actor_type == "Integration")')"; then
    echo "  MISSING: could not read ruleset $id on $default_branch"
    missing=1
  elif [[ "$app_bypass" == "true" ]]; then
    echo "  MISSING: ruleset $id on $default_branch lets an app bypass it; remove that bypass"
    missing=1
  fi
done
for check in ci sign-off; do
  if jq -e --arg c "$check" 'any(.[]; .type == "required_status_checks" and any(.parameters.required_status_checks[]; .context == $c))' <<<"$rules" >/dev/null; then
    echo "  ok: $default_branch requires the $check check"
  else
    echo "  MISSING: an active ruleset on $default_branch that requires the $check check"
    missing=1
  fi
done

echo "== secrets and variables"
secrets="$(gh secret list --repo "$repo" --json name --jq '.[].name')"
for name in TRIAGE_BOT_PRIVATE_KEY TRIAGE_CF_AI_TOKEN TRIAGE_CF_ACCOUNT_ID; do
  if grep -qxF "$name" <<<"$secrets"; then echo "  ok: secret $name"; else echo "  MISSING: secret $name"; missing=1; fi
done
variables="$(gh variable list --repo "$repo" --json name --jq '.[].name')"
for name in TRIAGE_BOT_APP_ID TRIAGE_BOT_LOGIN; do
  if grep -qxF "$name" <<<"$variables"; then echo "  ok: variable $name"; else echo "  MISSING: variable $name"; missing=1; fi
done
# The workflow reads the skill from the default branch's checkout.
if gh api "repos/$repo/contents/.agents/skills/triage/SKILL.md" --silent 2>/dev/null; then
  echo "  ok: .agents/skills/triage on the default branch"
else
  echo "  MISSING: .agents/skills/triage/SKILL.md on the default branch"
  missing=1
fi

if [[ "$mode" == "enable" ]]; then
  if [[ "$missing" -ne 0 ]]; then
    echo "not enabling: fix the MISSING items first" >&2
    exit 1
  fi
  gh variable set TRIAGE_ENABLED --repo "$repo" --body true
  echo "triage bot on for $repo"
elif [[ "$missing" -eq 0 ]]; then
  echo "ready. Run again with --enable to switch the bot on."
fi
