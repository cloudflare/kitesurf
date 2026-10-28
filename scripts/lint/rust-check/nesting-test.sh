#!/bin/sh
# Copyright (c) 2026 Cloudflare, Inc.
# Licensed under the Apache 2.0 license found in the LICENSE file or at:
# https://opensource.org/licenses/Apache-2.0

# Run the nesting checker over the runfiles source paths passed after the depth cap.
set -eu
checker=$1
depth=$2
shift 2
exec "$checker" --max-depth "$depth" "$@"
