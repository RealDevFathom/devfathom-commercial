#!/usr/bin/env bash
set -euo pipefail
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
export BUN_INSTALL="$HOME/.bun"; export PATH="$BUN_INSTALL/bin:$PATH"
grep -q '.bun/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc
bun install --frozen-lockfile
bunx prisma generate
