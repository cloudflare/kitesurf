#!/bin/sh
# Copyright (c) 2026 Cloudflare, Inc.
# Licensed under the Apache 2.0 license found in the LICENSE file or at:
# https://opensource.org/licenses/Apache-2.0

# The Docker image's entry point: sets the engine vars' defaults (env.sh) under any that the
# container's environment sets, then replaces itself with workerd, listening on KITESURF_PORT.
set -eu
. /opt/kitesurf/env.sh
echo "[kitesurf] starting Kitesurf ${KITESURF_VERSION} on port ${KITESURF_PORT:-8787}"
exec /usr/local/bin/workerd serve --experimental \
  --socket-addr "http=${KITESURF_HOST:-*}:${KITESURF_PORT:-8787}" \
  /opt/kitesurf/config.capnp "$@"
