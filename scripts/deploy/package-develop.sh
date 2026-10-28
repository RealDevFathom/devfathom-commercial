#!/usr/bin/env bash
# Explicit allowlist: never archive the checkout or exclude nested node_modules.
set -euo pipefail
root=$(realpath "${1:-.}")
output=$(realpath -m "${2:?usage: package-develop.sh ROOT OUTPUT.tar.gz}")
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
test -f "$root/.next/standalone/server.js"
test -d "$root/.next/static"
mkdir -p "$stage/.next" "$stage/scripts"
cp -a "$root/.next/standalone" "$stage/.next/standalone"
mkdir -p "$stage/.next/standalone/.next"
rm -rf "$stage/.next/standalone/.next/static" "$stage/.next/standalone/public"
cp -a "$root/.next/static" "$stage/.next/standalone/.next/static"
cp -a "$root/public" "$stage/.next/standalone/public"
rm -rf -- "$stage/.next/standalone/public/uploads"
cp "$root/scripts/start-standalone.mjs" "$stage/scripts/"
cp "$root/package.json" "$root/bun.lock" "$root/prisma.config.ts" "$stage/"
cp -a "$root/prisma" "$stage/prisma"
# Tracing can carry dotenv files from the build host; never distribute them.
find "$stage" -name '.env*' -exec rm -rf -- {} +
# Assets are complete; startup must not overwrite persistent uploads or recopy.
touch "$stage/.next/standalone/.assets-staged"
tar -czf "$output" -C "$stage" .
