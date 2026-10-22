# Import 4/5 — pharmacy presets

## Scope and integration

This branch adds only the code-defined, read-only preset registry under
`src/lib/pharmacy/migration/presets`. It extends the existing migration module; it does not create
a second import pipeline, persistence model, migration, API route, or UI. **This branch is based on
`feat/import-2-entities` and will be rebased onto the parallel import-3 UI branch when that sibling
lands.** The UI should consume `listPresets`, `detectPreset`, `applyPreset`, and the exported header
synonym API from `presets/registry.ts`.

## Decisions

- Registry order is Generic, MediPOS, Tally, Marg, Busy, local Pakistan vendors, then QuickBooks.
  Tally and QuickBooks expose format/list variants because their fingerprints do not overlap.
- Detection scores a preset's documented fingerprint and uses registry order for equal scores. Less
  than half a fingerprint is deliberately reported as Generic rather than making a vendor claim.
- MediPOS, Tally, Generic, and QuickBooks definitions are `VERIFIED`. Marg, Busy, and the combined
  local-vendor definition are `PROVISIONAL`, carry the exact inference warning, and set
  `forceMappingReview`; consumers must not bypass review for these definitions.
- Synonym mapping preserves the original source-header spelling as the map key. Values are stable
  canonical field names. Unknown columns remain unmapped for explicit review.
- Parsers reuse the migration module's exact money (integer paisa), quantity, and tolerant expiry
  readers. Invalid data is omitted rather than defaulted, allowing the existing staged validation
  and all-or-nothing commit flow to raise row exceptions.
- The Tally XML parser intentionally reads only the documented `STOCKITEM` and
  `BATCHALLOCATIONS.LIST` subset. It does not execute entities, import vouchers, or commit data.
- No database migration or RBAC change is required for read-only presets. Import/commit/rollback
  remain governed by the existing server-side migration workflow and central capability checks.

## Follow-ups

1. Obtain consented, anonymised exports from Marg, Busy, Abuzar, PharmaSys, Mint, Moneypex,
   JPharmaPlus, CloudPOS, and Websol; replace inferred fingerprints and split local vendors only when
   real headers justify it.
2. Have import-3 show `status`, the provisional badge, `note`, and enforce `forceMappingReview`.
3. Feed parsed rows through the existing staged-review validator before commit; preset parsing is
   never evidence that a row is valid.
4. Confirm Tally alternate/base-unit conversion semantics from real exports before transforming
   quantities. Presets expose conversion columns but do not guess a multiplier.
5. Keep sales history out of these presets; migrate opening party balances and stock only unless a
   separately reviewed history importer is selected.
