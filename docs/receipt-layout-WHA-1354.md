# WHA-1354 — shared receipt layout handoff

## Coordination follow-up, September 5

This section supersedes the initial-pass renderer/Pharmacy limitations below.
Follow-up base: `806f1138395c595ca27e3eb086581b9961fb441e`; original base:
`fe1e3e383c8b966cdb68669ba5366db00fe2320a`. Assigned branch and clean tree verified.

- `src/lib/restaurant/printing/contract.ts` adds required
  `ClaimedPrintJob.claimToken: string`. WHA-1360 signs/validates the opaque 64 lowercase
  hex HMAC; WHA-1356 echoes it. Stable AUTH_SECRET and ACK lease enforcement belong
  to those owners. This type alone supplies no security enforcement.
- The same file exports `ReceiptPrintSnapshotSchema` / `ReceiptPrintSnapshot` and
  optional `PrintDocument.receiptSnapshot: { layout, facts }`, restricted to RECEIPT.
  Fields use existing `ReceiptLayoutSchema` and `ReceiptPreviewFactsSchema`.
  Legacy document envelope fields remain required. With a snapshot, its complete
  settled facts are authoritative; legacy lines/title/footer are not rendered.
  Callers must construct the snapshot from authorized saved invoice facts and persist
  it with the job. Parsing copies the input; subsequent preference changes cannot
  affect the captured snapshot. Consumer integration remains pending.
- `src/lib/restaurant/printing/esc-pos.ts` validates input and renders snapshot
  text using `buildReceiptPreview`, at 32/48 columns for 58/80 mm. Legacy ASCII bytes
  retain the golden fixture. Unsupported glyphs and printer control characters now
  throw instead of becoming question marks. Owners must surface this failure and
  offer a browser/OS-rendered path for Urdu; that fallback is not implemented here.
  Existing initialization/cut behavior remains device-acceptance gated.
- `prisma/schema.prisma` and
  `prisma/migrations/20260905190000_pharmacy_receipt_layout/migration.sql` add
  `PharmacyBranch.receiptLayout Json?` and `receiptLayoutRevision Int @default(0)`
  on `pharmacy_branches`. No existing settings column was available. Constraints
  require object-or-SQL-NULL layout and nonnegative revision. Existing RLS policies
  remain unchanged; migration unexecuted. WHA-1358 owns the adapter: derive tenant
  and Pharmacy branch from authorization, enforce Pharmacy module/capabilities on
  read/write, use tenant/branch/active/revision-qualified atomic updates, increment
  revision, retain errors, and use `readReceiptLayout` (defaults only for SQL NULL).
- New tests: `src/lib/restaurant/printing/receipt-snapshot.test.ts`.

Follow-up verification (no source edits after these checks, apart from formatting):

- `bunx vitest run src/lib/restaurant/printing/receipt-snapshot.test.ts src/lib/restaurant/printing/printing.test.ts src/lib/receipts/configuration.test.ts`:
  **27 passed, 0 failed, 0 skipped**, 3 files passed. Covers exact preview bytes,
  both widths, mandatory facts, copied snapshots, legacy golden bytes, invalid
  document type, missing facts, commands and unsupported Unicode.
- `bunx prisma validate` and `bunx prisma generate`: exit 0.
- `bunx tsc --noEmit -p "$PAPERCLIP_RUN_SCRATCH_DIR/receipt-contract-tsconfig.json"`:
  exit 2, **1 error**: `service.ts(187,5): error TS2741: Property 'claimToken' is missing`.
  Scratch config extends repository tsconfig, disables incremental output, includes
  next-env, src/types, vitest.setup, changed printing TS and service.ts. Producer
  is exclusively WHA-1360-owned; blocked pending that owner's matching change.
- `bunx eslint src/lib/restaurant/printing/contract.ts src/lib/restaurant/printing/esc-pos.ts src/lib/restaurant/printing/receipt-snapshot.test.ts`:
  no diagnostics. `bunx prettier --check` with those same paths: all matched files
  formatted. `git diff --check`: exit 0. Prior unchanged UI evidence remains applicable;
  prior **4 skipped database tests** remain pending. No migration/database execution,
  full build, UI service, browser, real hardware or network discovery performed.

Chief of Staff must integrate WHA-1360's producer and WHA-1356's token echo together,
coordinate WHA-1355/WHA-1358 snapshot consumers, supply isolated migration/RLS tests
and assign independent review plus approved staging visual/build acceptance. Keep
issue blocked until these named owner actions occur. Revert the follow-up application
commit if needed; retain additive database columns/data. Do not deploy the required
token contract without its producer/consumer changes.

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
