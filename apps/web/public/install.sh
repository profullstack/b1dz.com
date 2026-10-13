#!/bin/sh
# Install b1dz, the b1dz.com terminal client (npm: @profullstack/b1dz).
#
#   curl -fsSL https://b1dz.com/install.sh | sh
#
# Uses bun if present, otherwise npm (Node >= 22). When the global npm prefix
# is not writable it installs into ~/.local instead of asking for sudo.
# Re-running it upgrades to the latest version.
#
# This script only installs the CLI. It never asks for, reads or writes
# exchange API keys, wallet keys or any other secret.
set -eu

PKG="@profullstack/b1dz"

say() { printf '%s\n' "$*"; }
die() { printf 'b1dz install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

say "Installing b1dz (b1dz.com terminal client)..."

if have bun; then
  bun add -g "$PKG@latest"
  BIN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"
elif have npm && have node; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 22 ] || die "Node >= 22 required (found $(node -v)). Upgrade Node or install bun: https://bun.sh"
  prefix=$(npm config get prefix)
  modules="$prefix/lib/node_modules"
  [ -d "$modules" ] || modules="$prefix/lib"
  if [ -w "$modules" ] && [ -w "$prefix/bin" ]; then
    npm install -g "$PKG@latest"
    BIN_DIR="$prefix/bin"
  else
    BIN_DIR="$HOME/.local/bin"
    say "npm prefix $prefix is not writable; installing into $HOME/.local"
    npm install -g --prefix "$HOME/.local" "$PKG@latest"
  fi
else
  die "needs bun (https://bun.sh) or Node >= 22 with npm (https://nodejs.org)"
fi

say ""
if have b1dz; then
  say "b1dz $(b1dz --version 2>/dev/null || echo '') installed."
else
  say "b1dz installed to $BIN_DIR, which is not on your PATH. Add it:"
  say "  export PATH=\"$BIN_DIR:\$PATH\""
fi
say ""
say "Next:"
say "  b1dz signup     # or: b1dz login"
say "  b1dz setup      # guided setup; you enter your own exchange keys"
say "  b1dz tui        # live dashboard"
say "  b1dz --help     # every command"
say ""
say "Setup guide: https://github.com/profullstack/b1dz.com/tree/master/apps/cli#readme"
