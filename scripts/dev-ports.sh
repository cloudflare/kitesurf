# Copyright (c) 2026 Cloudflare, Inc.
# Licensed under the Apache 2.0 license found in the LICENSE file or at:
# https://opensource.org/licenses/Apache-2.0

_ks_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
if [ "$_ks_branch" = "HEAD" ] || [ "$_ks_branch" = "detached" ]; then
  _ks_branch="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

if [ "$_ks_branch" = "main" ]; then
  _ks_base=8787
  _ks_inspector=9229
  _ks_wpt=8788
  _ks_bench=8789
else
  _ks_hash="$(printf '%s' "$_ks_branch" | cksum | awk '{print $1}')"
  _ks_base=$((10000 + (_ks_hash % 4000) * 10))
  _ks_inspector=$((_ks_base + 1))
  _ks_wpt=$((_ks_base + 2))
  _ks_bench=$((_ks_base + 3))
fi

export KITESURF_PORT="${KITESURF_PORT:-$_ks_base}"
export KITESURF_INSPECTOR_PORT="${KITESURF_INSPECTOR_PORT:-$_ks_inspector}"
export KITESURF_WPT_PORT="${KITESURF_WPT_PORT:-$_ks_wpt}"
export KITESURF_BENCH_PORT="${KITESURF_BENCH_PORT:-$_ks_bench}"
export KITESURF_ORIGIN="${KITESURF_ORIGIN:-http://127.0.0.1:${KITESURF_PORT}}"

unset _ks_branch _ks_hash _ks_base _ks_inspector _ks_wpt _ks_bench
