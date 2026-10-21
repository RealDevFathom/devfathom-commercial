# Blocked: WhatsApp drug guard follow-up

Stopped after the second failed focused test attempt, as requested. All work is confined to fix/wa-drug-guard-2 in this worktree, starting at 8705cb0a.

## Checks

- `bun install`: passed; Prisma client generated.
- Focused Vitest attempt 1: failed (Unicode JSON transform, generated Prisma scan, and platform worker SQL mock).
- Focused Vitest attempt 2: 147 passed, 3 failed, 5 skipped. No third attempt was made.
- PostgreSQL tests skipped because TEST_DATABASE_URL is not configured. The new migration has not been applied to a database.
- `git diff --check`: passed.
- Typecheck started with `TMPDIR=/tmp NODE_OPTIONS=--max-old-space-size=6144 bun run typecheck`; result recorded below when available.

## Remaining failures

1. `src/lib/growth/drug-security.test.ts`: `MS Contin` no longer matches. Unicode skeleton casing/expansion needs consistent handling on copy and list sides. This is a security regression; do not merge this branch as-is.
2. `src/lib/growth/whatsapp/queue.test.ts`: “stops retrying a row after three failures” still omits the now-required copy-check callback, so the row correctly fails closed before retry behavior can be exercised.
3. The same file's “leaves a claimed row sending when the sent mark rolls back” also omits the callback, so it never reaches the provider/sent-mark path.

## Work saved

- Outbound drain checks independent of campaignId, fixed order-ready body comparison, stronger source enforcement, runtime inbound-only store guard.
- Complete vendored Unicode mapping and policy folds, aliases, device-context exceptions and regression cases.
- Minimal consent archive fields, 365-day TTL/index and scheduled worker cleanup. Migration discards historical overbroad archives; review that data-loss choice before deployment.

Further corpus coverage, database verification, and all passing checks remain required. No ready PR was opened because verification failed. Branch is pushed for continuation; no merge or production push was performed.

Typecheck completed successfully (exit 0) with the required 6144 MB heap limit.
