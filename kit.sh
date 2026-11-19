#!/usr/bin/env bash
# Memoir Kit entry point. Makes sure a suitable Node.js is available (downloading
# a private copy into ./.node if the computer doesn't have one – no installer, no
# admin password), installs dependencies, then runs a setup step.
#
#   ./kit.sh status                  # → node scripts/setup.js status
#   ./kit.sh seed mum                # → bash kit.sh seed mum
#   ./kit.sh npm run export -- mum   # run npm/npx/node with the kit's Node
set -euo pipefail
cd "$(dirname "$0")"
KIT="$PWD"
NEED_MAJOR=22; NEED_MINOR=12   # wrangler 4 needs Node >= 22.12

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v; v="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  local maj="${v%%.*}" rest="${v#*.}"; local min="${rest%%.*}"
  (( maj > NEED_MAJOR || (maj == NEED_MAJOR && min >= NEED_MINOR) ))
}

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  MINGW*|MSYS*|CYGWIN*) OS=win ;;
  *) echo "Unsupported system: $(uname -s)"; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) echo "Unsupported processor: $(uname -m)"; exit 1 ;;
esac

# Prefer the kit's private copy if present.
if [[ "$OS" == win ]]; then PRIV="$KIT/.node"; else PRIV="$KIT/.node/bin"; fi
[[ -x "$PRIV/node" || -x "$PRIV/node.exe" ]] && export PATH="$PRIV:$PATH"

if ! node_ok; then
  echo "Setting up a private copy of Node.js for this kit (one-time, ~30 MB)…"
  BASE="https://nodejs.org/dist"
  # Newest LTS release (index.json lists newest first, one release per line).
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "$BASE/index.json" -o "$TMP/index.json" || true
  VER="$(grep -m1 '"lts":"' "$TMP/index.json" 2>/dev/null | sed -E 's/.*"version":"(v[0-9.]+)".*/\1/')" || true
  [[ "$VER" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Could not look up the current Node.js version. Check the internet connection and try again."; exit 1; }
  if [[ "$OS" == win ]]; then FILE="node-$VER-win-$ARCH.zip"; else FILE="node-$VER-$OS-$ARCH.tar.gz"; fi
  curl -fsSL "$BASE/$VER/$FILE" -o "$TMP/$FILE"
  curl -fsSL "$BASE/$VER/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  WANT="$(grep " $FILE\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)"
  if command -v shasum >/dev/null; then GOT="$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)"; else GOT="$(sha256sum "$TMP/$FILE" | cut -d' ' -f1)"; fi
  [[ -n "$WANT" && "$WANT" == "$GOT" ]] || { echo "The Node.js download failed its integrity check – not using it. Try again."; exit 1; }
  rm -rf "$KIT/.node"; mkdir -p "$KIT/.node"
  if [[ "$OS" == win ]]; then
    powershell.exe -NoProfile -Command "Expand-Archive -LiteralPath '$(cygpath -w "$TMP/$FILE")' -DestinationPath '$(cygpath -w "$TMP")' -Force"
    mv "$TMP/${FILE%.zip}"/* "$KIT/.node/"
  else
    tar -xzf "$TMP/$FILE" -C "$KIT/.node" --strip-components=1
  fi
  export PATH="$PRIV:$PATH"
  node_ok || { echo "Node.js setup did not work."; exit 1; }
  echo "✓ Node.js $VER ready (kept inside this folder)."
fi

if [[ ! -d node_modules/wrangler ]]; then
  echo "Installing the kit's components (one-time, about a minute)…"
  npm install --silent --no-audit --no-fund
  echo "✓ Components installed."
fi

case "${1:-status}" in
  npm|npx|node) exec "$@" ;;
  *) exec node scripts/setup.js "$@" ;;
esac
