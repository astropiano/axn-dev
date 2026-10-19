#!/bin/bash
# Builds all workspace packages (tsc -b) and links the axn-dev bin globally.
# The linked cli package resolves @axn-dev/core and discovers sibling
# packages/cmd-* as plugins — all in-repo commands are available.
set -e
pnpm build
chmod +x packages/cli/dist/main.js
(cd packages/cli && npm unlink -g @axn-dev/cli 2>/dev/null || true; npm link)
