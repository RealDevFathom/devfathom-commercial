# WHA-1354 — shared receipt layout handoff

Implementation prepared on the assigned private branch, based on
`fe1e3e383c8b966cdb68669ba5366db00fe2320a`. Initial working tree was clean.
No POS callers, ESC/POS renderer, bridge, transport, camera, or pharmacy sale code changed.

## Consumer interface

`src/lib/receipts/configuration.ts` exports `ReceiptLayoutSchema`, `ReceiptLayout`,
`DEFAULT_RECEIPT_LAYOUT`, `SaveReceiptLayoutSchema`, and `readReceiptLayout`.
Version 1 supports 58 mm/32 columns or 80 mm/48 columns, additional business text,
header/footer text, and optional order-number/channel labels. It has no switches for
invoice identity, items, tax, totals, tenders, or change. Business text supplements,
and cannot replace, the recorded business name.

`src/lib/receipts/preview.ts` exports `ReceiptPreviewFactsSchema`,
`buildReceiptPreview(layout, facts)`, and `receiptColumns(layout)`.
Callers supply complete, already-authorized settled facts as formatted strings:
business name, invoice number, issue time, item lines, tax lines, totals, and payments.
Include every mandatory fact, including applicable discounts, service/delivery fees,
rounding, tax registration data, tender/change and split details. There is no money
calculation here. Optional order/channel labels are the only suppressible facts.
Missing required groups fail validation. Sample data is explicitly synthetic.

POS/runtime owners should consume this same validated input for physical printing,
preserving every settled fact. **Existing printers do not consume the new settings yet.**
Do not treat the current quantity-only `PrintDocument` as a complete fiscal receipt,
or map away required facts to fit that transport. Coordinate that extension in the
runtime/POS lane. Pharmacy can reuse the pure schema/preview; pharmacy persistence
and callers are not implemented by this Restaurant-first change.

`getRestaurantReceiptLayout(db, organizationId, branchId)` reads one active branch.
The consumer must derive its organization and branch from its authorized session or
device. It must enforce its own receipt-read entitlement/capability first; this is a
server helper, not an authorization replacement. Missing/foreign branches fail;
only SQL NULL configuration yields defaults. Corrupt stored settings fail closed.

## Settings and persistence

Settings links to `/settings/receipts`. The Studio form supports branch selection,
live sample preview, validation, pending saves, permission/load failure, retry,
empty branches, discard draft, and reset-to-defaults followed by explicit save.
Failed saves preserve input. Unsaved edits prevent accidental branch switching.

`GET /api/restaurant/receipt-layout` returns active tenant branches with layout/revision.
`PUT` accepts `{ branchId, revision, layout }` and returns `{ layout, revision }`.
Both require a usable tenant session, matching resolved organization,
`restaurant-core` entitlement, and `restaurant:configure` permission. That existing
permission is organization-wide; this change adds no branch-manager privilege.
Writes require same-origin browser requests. Errors retain meaningful 400/401/403/409
statuses; unexpected internal errors receive generic 500 responses without payload logs.

No existing branch layout settings slot was available. One additive migration adds
nullable `receiptLayout` JSONB and nonnegative `receiptLayoutRevision` to
`restaurant_branches`, retaining its existing ENABLE/FORCE RLS policy. Atomic
organization/branch/revision-qualified updates reject stale writers and do not touch
other branches. Reset writes defaults through the same path. Migration deployment
must precede application rollout; no migration was executed during this heartbeat.
For recovery, revert the application commit and retain the additive columns/data;
do not destructively roll back the database to recover the old application.

## Verification evidence

Commands ran from the assigned checkout:

- `bun install --frozen-lockfile`: exit 0; restored existing dependencies and generated
  Prisma client. No lockfile/dependency change.
- `bunx prisma generate`: exit 0 after adding branch fields.
- Initial focused Vitest run: 29 passed, 0 failed.
- Final `bunx vitest run src/lib/receipts src/app/api/restaurant/receipt-layout/route.test.ts src/components/receipts/receipt-designer.test.tsx`:
  **30 passed, 0 failed, 4 skipped**, 4 test files passed, 1 skipped.
- `bunx tsc --noEmit -p "$PAPERCLIP_RUN_SCRATCH_DIR/receipt-tsconfig.json"`:
  initial check had 8 missing test-matcher type errors because the temporary include
  list omitted `vitest.setup.ts`; final exit 0 after including that existing setup.
  Configuration extends checkout `tsconfig.json`, disables incremental output, and
  includes `next-env.d.ts`, `src/types/**/*.d.ts`, `vitest.setup.ts`, all new receipt
  TS/TSX files, and `settings-content.tsx`. This checks their transitive imports too.
- `bunx eslint src/lib/receipts src/components/receipts src/app/api/restaurant/receipt-layout 'src/app/(app)/settings/receipts/page.tsx' 'src/app/(app)/settings/settings-content.tsx'`:
  exit 0, no diagnostics.
- `bunx prettier --check src/lib/receipts src/components/receipts src/app/api/restaurant/receipt-layout 'src/app/(app)/settings/receipts/page.tsx'`:
  exit 0, all matched files formatted. Existing shared settings file was changed only
  for the dedicated link, without broad reformatting.
- `bunx prisma validate`: exit 0, schema valid.
- `git diff --check`: exit 0.

Tests cover both widths, wrapping, malicious input, missing/corrupt configuration,
mandatory fact retention, scoped persistence arguments, unavailable branches,
propagated failures, session/tenant/permission/module/origin denial, draft preservation,
reset behavior, and invalid-field accessibility. Mocked tests are not RLS evidence.

One consolidated local review found the migration used the Prisma model name instead
of the physical table name; corrected to `restaurant_branches`. Independent review
has not occurred. No subagents or nested CLI sessions were started. Claude-Mem,
Codebase Memory, and Ponytail were unavailable; narrow local source reads were used.

## Blocking acceptance gates and owners

**Chief of Staff:** provide the isolated migrated test database and assign the
Verification Engineer an approved staging revision. The four skipped database tests
exercise persistence across transactions, cross-tenant RLS with forged organization
arguments, competing writers/reset, and rollback. They first assert that the runtime
role has neither SUPERUSER nor BYPASSRLS. Run the same final test command with
`TEST_DATABASE_URL` pointing only to the authorized isolated database.

**Verification Engineer:** independent review; production build in the approved
environment; Studio visual matrix at 375/768/1024/1440 px, light/dark, normal/reduced
motion, keyboard/focus, overflow and console checks, loading/empty/error/disabled
states. No app/browser services or screenshots were started here, per task restriction.

**POS/transport owners:** integrate persisted layout into their shared renderer path,
then verify actual paper, font, width, cut, retry and delivery on configured devices.
No real printer/network discovery or device access occurred. ASCII is deliberately
the current baseline: unsupported glyphs and control sequences fail validation;
Unicode/code-page support and logos need a separately verified renderer path.

**Hardware owner/Saad:** provide specific printer/connection/host targets. Use a
currently vendor-supported host for the modern application/bridge; Windows 98,
Vista and 7 cannot host this modern browser/Node stack. Windows 10/macOS versions,
drivers, interfaces, fonts and printable widths require explicit verification.
Legacy clients require an approved supported-host path, not disabled TLS/security
or universal compatibility claims. DVR work remains a separate camera lane.

This change is not accepted as complete while database, independent review and
staging visual gates remain unmet. No push, merge, deployment, production data
operation, build, or real hardware acceptance is claimed.
