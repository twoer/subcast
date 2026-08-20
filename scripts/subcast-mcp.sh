#!/bin/sh
# SPDX-License-Identifier: Apache-2.0

set -eu

resources_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
app_contents="$(CDPATH='' cd -- "$resources_dir/.." && pwd)"

export ELECTRON_RUN_AS_NODE=1
exec "$app_contents/MacOS/Subcast" "$resources_dir/app.asar/desktop-dist/subcastMcp.js"
