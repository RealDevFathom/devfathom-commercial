#!/usr/bin/env bash
# Explicit allowlist: never archive the checkout or exclude nested node_modules.
set -euo pipefail
root=$(realpath "${1:-.}")
output=$(realpath -m "${2:?usage: package-develop.sh ROOT OUTPUT.tar.gz}")
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
test -f "$root/.next/standalone/server.js"
test -d "$root/.next/static"
test ! -L "$root/public"
mkdir -p "$stage/.next" "$stage/scripts"
cp -a "$root/.next/standalone" "$stage/.next/standalone"
mkdir -p "$stage/.next/standalone/.next"
rm -rf "$stage/.next/standalone/.next/static" "$stage/.next/standalone/public"
cp -a "$root/.next/static" "$stage/.next/standalone/.next/static"
cp -a "$root/public" "$stage/.next/standalone/public"
rm -rf -- "$stage/.next/standalone/public/uploads" \
  "$stage/.next/standalone/public/private-uploads" \
  "$stage/.next/standalone/private-uploads"
# Public aliases must never expose a persistent directory under another name.
find "$stage/.next/standalone/public" -type l -delete
find "$stage/.next/standalone/public" -mindepth 1 -type d \
  \( -name uploads -o -name private-uploads \) -prune -exec rm -rf -- {} +
cp "$root/scripts/start-standalone.mjs" "$stage/scripts/"
cp "$root/package.json" "$root/bun.lock" "$root/prisma.config.ts" "$root/tsconfig.json" "$stage/"
cp -a "$root/prisma" "$stage/prisma"
# Catalog reconciliation runs outside Next's traced server. Ship its local
# sources explicitly; postinstall generates src/generated/prisma on the host.
mkdir -p "$stage/src/lib"
cp "$root/src/lib/module-catalog.ts" "$root/src/lib/vertical-catalog.ts" "$stage/src/lib/"
# Tracing can carry dotenv files from the build host; never distribute them.
find "$stage" -name '.env*' -exec rm -rf -- {} +
# Assets are complete; startup must not overwrite persistent uploads or recopy.
touch "$stage/.next/standalone/.assets-staged"
tar -czf "$output" -C "$stage" .
