# GitHub issue #8: already fixed

Issue #8 reported that a second `bun run db:seed` attempted to create the same
invoice numbers and failed with `P2002`. The current seed already prevents that
path:

- `prisma/seed.ts:38-58` looks up the canonical `INV-2026-001` seed invoice
  before any of the non-idempotent demo writes. When it exists, the seed only
  refreshes the eight seeded users' password hashes, logs that the seed data is
  already present, and returns.
- The unconditional invoice creation reported in the issue remains at
  `prisma/seed.ts:907-908`, but it is reachable only when that sentinel is
  absent.
- The sentinel check and all tenant demo writes run in the same Prisma
  transaction (`prisma/seed.ts:1497-1503` and `prisma/seed.ts:1640-1651`). A
  failed first run therefore cannot commit the sentinel while leaving the rest
  of this seed's demo data partially written.
- Platform-administrator provisioning remains on the repeat-run path:
  `prisma/seed.ts:1627-1640` explicitly upserts it before calling
  `seedTenantData`, whose already-seeded branch returns only from that helper.
- The separate enrichment seed documents its additive, re-runnable contract at
  `prisma/seed-demo.ts:1-25` and guards its sections with existing-row counts
  beginning at `prisma/seed-demo.ts:153-165`.

Consequently, the reported reproduction (a successful seed followed by the
same seed against that database) no longer reaches `tx.invoice.create` and does
not collide on `Invoice.invoiceNumber`. No production code change is required
for issue #8.
