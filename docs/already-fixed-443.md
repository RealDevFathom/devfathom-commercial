# Issue #443: archived QA-299 work is already resolved

Issue #443 does not require another code change. The only valuable behavior from
`archive/fix/qa-299` that was missing from the main baseline has already been
ported on this branch:

- `prisma/prepare-runtime-role.ts:88-94` grants `devfathom_app` execute access
  to the exact `public.similarity_op(text,text)` overload. It does not restore a
  schema-wide function grant.
- `prisma/prepare-runtime-role.ts:112-115` executes that statement through the
  existing awaited grant loop, so a failed grant fails runtime-role preparation.
- `.github/workflows/promote-production.yml:47-48` requires extension
  preparation and migrations to finish before runtime-role preparation, while
  `prisma/migrations/20260902130000_pharmacy_medicine_catalog_review/migration.sql:1`
  creates `pg_trgm` if necessary.
- `tests/prepare-runtime-role.test.ts:56-65` checks the exact overload, fixed
  role, and absence of the supplied password from logs. Lines 77-93 also cover
  the permission-denied password path and verify that all grants still run
  without logging the secret.

## Archive disposition

Keep `archive/fix/qa-299` closed rather than reopening or merging its eight
commits wholesale. The archived changes were assessed as follows:

- **Ported:** the least-privilege pg_trgm runtime-role grant described above.
- **Skipped as already present:** canonical `pharmacy:counter` support is in
  `src/server/routers/pharmacy-sales.ts:275-283` and its regression coverage is
  in `src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts:305-314`.
- **Skipped as already present:** seat-default reconciliation preserves
  customized values and guards concurrent operator edits in
  `prisma/catalog-sync.ts:53-62` and `prisma/catalog-sync.ts:168-176`.
- **Skipped as non-product history:** the archive's merge commits, QA memory
  note, and inherited `BLOCKED.md` cleanup do not supply additional runtime
  behavior that should be replayed.

This focused disposition preserves the restricted runtime role and avoids
reviving unrelated historical changes.
