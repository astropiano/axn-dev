#!/bin/bash
# Builds all workspace packages (tsc -b) and links the axn-dev bin globally.
#
# Neither `npm link` nor `pnpm link -g` is usable here: npm cannot resolve
# the pnpm `workspace:*` protocol, and pnpm 10 dropped `link --global`.
# Instead we symlink the compiled entrypoint into a bin dir on PATH
# (default: ~/.local/bin, override with AXN_DEV_BIN_DIR). Node resolves the
# symlink to the real file, so @axn-dev/* imports resolve via the package's
# own node_modules and sibling packages/* are discovered as plugins.
set -e
cd "$(dirname "$0")"

pnpm build
chmod +x packages/cli/dist/main.js

BIN_DIR="${AXN_DEV_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
ln -sfn "$PWD/packages/cli/dist/main.js" "$BIN_DIR/axn-dev"
echo "Linked $BIN_DIR/axn-dev -> $PWD/packages/cli/dist/main.js"

resolved=$(realpath "$(command -v axn-dev)" 2>/dev/null || readlink -f "$(command -v axn-dev)" 2>/dev/null || command -v axn-dev)
if ! command -v axn-dev >/dev/null 2>&1; then
  echo "Warning: 'axn-dev' is not on PATH. Add $BIN_DIR to your PATH."
elif [ "$resolved" != "$PWD/packages/cli/dist/main.js" ]; then
  echo "Warning: 'axn-dev' resolves to $(command -v axn-dev), which shadows this link."
fi
