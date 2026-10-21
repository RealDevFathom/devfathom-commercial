# Growth G5 blocked: dependency installation

Work was attempted only on `improve/ai-growth-g5` in `/workspace/wt/improve/ai-growth-g5`.

Dependency installation failed twice because required filesystem locations are read-only:

1. `bun install`: `bun is unable to write files to tempdir: EROFS`.
2. `TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/bun-growth-cache bun install`: the Prisma postinstall failed with `EROFS: read-only file system, utime '/home/box/.cache/prisma/master/e922089b7d7502aff4249d5da3420f6fa55fc6ad/debian-openssl-3.0.x/schema-engine'`.

The user requires stopping after two failures at the same problem. No further installation attempts, implementation, or checks were performed. Resume with writable Bun temporary and Prisma cache directories.

## Inspection findings

The existing tenant key is `organizationId`. G1 provides `Campaign`, `CampaignRecipient`, `CustomerMetrics`, `GrowthSettings`, and `MessageTemplate`, linked to `PharmacyCustomer`, `PharmacySale`, and `PharmacyMessageLog`. The growth router is empty; the tick currently only logs enabled organizations. G2/G4 metrics, consent, template renderer, and WhatsApp queue/provider modules are absent under `src/lib/growth`; implementation must provide minimal integration rather than import absent modules. Tenant scoping uses `withTenantDb`; FORCE RLS must remain intact.

## Checks and manual verification

- Dependency installation: failed twice as above.
- Typecheck, relevant tests, lint, full tests, build: not run because installation failed and the stop rule applied.
- Live WhatsApp send and demo POS redemption: skipped; no campaign implementation or configured live service was verified.
- No UI, schema, production, integration, or main-branch changes were made.
