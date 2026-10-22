#!/bin/bash
# Sets Alfred up on this Mac. Run it from Terminal, at the Mac itself:
#   git clone https://github.com/Heath114/alfred1 ~/.alfred/app && ~/.alfred/app/setup.sh
# Running it again is safe: it checks what's done and skips it.
set -euo pipefail
cd "$(dirname "$0")"

NODE_VERSION="v24.22.1" # LTS; Developer ID-signed by the Node.js Foundation
RUNTIME="$HOME/.alfred/runtime"
NAME="node-$NODE_VERSION-darwin-arm64"

if [[ "$(uname -s)" != "Darwin" ]]; then echo "Alfred's setup runs on a Mac."; exit 1; fi
if [[ "$(uname -m)" != "arm64" ]]; then echo "Alfred needs an Apple silicon Mac."; exit 1; fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "First, Apple's command line tools (a window opens; choose Install)."
  xcode-select --install || true
  echo "When that finishes, run this again."
  exit 1
fi

# Alfred runs on its own copy of Node, pinned and checksum-verified, so Homebrew or other updates
# never change it underneath the service.
if [[ ! -x "$RUNTIME/node/bin/node" ]] || [[ "$("$RUNTIME/node/bin/node" --version)" != "$NODE_VERSION" ]]; then
  echo "Downloading Node.js $NODE_VERSION..."
  mkdir -p "$RUNTIME"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$NAME.tar.gz" -o "$tmp/$NAME.tar.gz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $NAME.tar.gz\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || { echo "Node download failed its checksum."; exit 1; }
  tar -xzf "$tmp/$NAME.tar.gz" -C "$RUNTIME"
  ln -sfn "$RUNTIME/$NAME" "$RUNTIME/node"
fi

export PATH="$RUNTIME/node/bin:$PATH"
echo "Installing Alfred's packages..."
npm ci --no-audit --no-fund --loglevel=error
exec node --disable-warning=ExperimentalWarning scripts/setup.ts "$@"
