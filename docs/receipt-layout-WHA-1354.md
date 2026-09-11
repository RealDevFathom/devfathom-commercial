# WHA-1354 — shared receipt layout handoff

## Board-authorized single correction pass

Base `bdea63a2cd3d35eab300dc585e7e1352cf64c4e4`; tracked tree clean before
correction, expected private DB review directory retained. Board rejection of
interaction `6f17eaff-95da-4764-bb0c-50b0c0877a46` explicitly authorized this pass.
This section supersedes earlier ASCII-only shared-preview descriptions.

`ReceiptLayoutSchema` and `ReceiptPreviewFactsSchema` now accept bounded Unicode
text, including Urdu, combining marks and joining sequences. `receiptTextSchema`
rejects C0 controls except LF, C1 controls, bidi overrides/isolates and unpaired
surrogates, before legacy field trimming. Layout text retains its markup rejection.
Facts remain inert text; consumers must use React text children/textContent, never
HTML interpolation. No normalization, substitution or monetary recalculation added.

`buildReceiptPreview(layout, facts)` remains the shared browser interface. ASCII
32/48-column wrapping is unchanged. Unicode logical lines stay intact for existing
browser `white-space: pre-wrap` wrapping; they are not measured as printer cells or
sliced through UTF-16/grapheme sequences. Existing designer already uses React text
children and pre-wrap. No UI implementation, routes, fonts or tokens changed.

`printing/contract.ts` exports:

- `validateRawPrintDocument(input: unknown): PrintDocument`: validates shape and
  encoding for both legacy envelope fields and complete snapshot layout/facts.
  Returns a parsed copy. Semantic `PrintDocumentSchema` alone is **not** raw queue
  acceptance validation.
- `RawPrintValidationError`: safe constant message, `code` is
  `INVALID_PRINT_DOCUMENT` (malformed/control input, `fallback: null`) or
  `UNSUPPORTED_PRINT_TEXT` (unsupported encoding, `fallback: 'BROWSER_OS'`).
  No receipt contents or validation payload included in errors.
- `renderEscPos` calls this same raw validator before emitting bytes, retaining
  defensive ASCII enforcement. Unicode remains browser-only, never question marks.

WHA-1360 must call raw validation before queue acceptance, including direct typed
service callers, map errors to actionable enqueue responses, and contain existing
invalid persisted jobs without starving later valid work or retrying uncertain
physical writes. This producer correction alone does **not** close GitHub91.
WHA-1355/1358 should reuse shared Unicode layout/facts/preview and render inert text;
they must not treat semantic schema success as raw printer capability.

Changed files: configuration.ts, preview.ts, configuration.test.ts under
`src/lib/receipts`; contract.ts, esc-pos.ts, receipt-snapshot.test.ts under
`src/lib/restaurant/printing`; `src/components/receipts/receipt-designer.test.tsx`;
this document. No service/API/runtime, schema/migrations or database environment edits.

Verification:

- Fail-before `node node_modules/vitest/vitest.mjs run src/lib/receipts/configuration.test.ts`:
  **2 failed / 14 passed**; both new 58/80 mm Unicode parity cases rejected by the
  original layout schema.
- Final `node node_modules/vitest/vitest.mjs run src/lib/receipts/configuration.test.ts src/lib/restaurant/printing/receipt-snapshot.test.ts src/lib/restaurant/printing/printing.test.ts src/components/receipts/receipt-designer.test.tsx src/lib/receipts/restaurant-settings.test.ts src/app/api/restaurant/receipt-layout/route.test.ts`:
  **59 passed, 0 failed, 0 skipped**, 6 files, exit 0. Covers actual designer Unicode
  textContent, escaped browser facts, combining/emoji integrity, raw legacy and
  snapshot rejection, safe typed errors, controls before trimming, and existing
  ASCII golden/width/facts/permission behavior. DOM tests are not visual acceptance.
- `node node_modules/typescript/bin/tsc --noEmit -p "$PAPERCLIP_RUN_SCRATCH_DIR/correction-tsconfig.json"`:
  exit 0. Scratch config extends repository config, disables incremental output,
  includes next-env, src/types, vitest.setup, all receipts TS, changed printing TS
  and designer test. Service/runtime integration is outside this scoped check.
- `node node_modules/eslint/bin/eslint.js` on the seven changed TS/TSX paths:
  exit 0, no diagnostics. Prettier and diff checks recorded in final handoff.
- Prior four isolated DB tests/105 migration checks remain historical evidence;
  not rerun for this pure text/encoding correction. Existing DB preserved for review.

Board owns combined recheck after WHA-1360/1356 corrections; three reviewed combined
TypeScript errors remain their lane. No extra independent agent/review run, build,
browser service, migration, deployment or physical hardware access. Staging visual,
consumer integration and real printer gates remain open. Rollback is application
commit reversion only; no database rollback required.

## Disposable database verification, September 5

This section supersedes earlier statements that the four Restaurant database tests
were skipped and that migrations had never been executed in an isolated environment.
Source tested: `411306de8d88b8eea574caa93750a972afa028d7`, parent
`806f1138395c595ca27e3eb086581b9961fb441e`, original base
`fe1e3e383c8b966cdb68669ba5366db00fe2320a`. Clean assigned branch verified before work.
No application, migration or test source changed in this verification heartbeat.

Supervisor explicitly authorized using the verified disposable PostgreSQL 16.15
cluster at `127.0.0.1:52027`. Admin connected only to its maintenance database for
identity/bootstrap; its data_directory matched the supplied WHA-1350 environment.
Created **new** `wha1354_disposable_b032106891`; no connection to or migration of
the existing `wha1350_disposable_test` database. First preflight stopped before
mutation because PostgreSQL rendered its address as `127.0.0.1/32`; corrected that
exact identity comparison, then bootstrap succeeded.

Dedicated owner `wha1354_owner_b032106891` and runtime
`wha1354_runtime_b032106891` both use NOSUPERUSER, NOBYPASSRLS, NOCREATEDB,
NOCREATEROLE, NOINHERIT. Runtime owns **0 application tables**. Restaurant and
Pharmacy branch tables both have ENABLE/FORCE RLS and the dedicated owner.
Canonical QA DML/sequence grants applied; no test ran as admin or owner.

Exact commands, run from this checkout with URLs sourced privately:

- `node "$PAPERCLIP_RUN_SCRATCH_DIR/provision.cjs"`: corrected preflight exit 0.
- `EXTENSION_ADMIN_DATABASE_URL="$OWNER_DATABASE_URL" node --import tsx prisma/prepare-extensions.ts`:
  exit 0, using the new database's restricted owner.
- `node node_modules/prisma/build/index.js migrate deploy --config "$WHA1354_ENV_DIR/migration.config.mjs"`:
  exit 0; **105 current migrations**, **0 unsuccessful**, **0 checksum mismatches**.
  Includes `20260905180000_receipt_layout` and `20260905190000_pharmacy_receipt_layout`.
- Owner `pg.Client` applied canonical QA runtime schema, table, sequence and default
  grants: success. No seed required; tests create their own synthetic fixtures.
- `node node_modules/vitest/vitest.mjs run src/lib/receipts/restaurant-settings.db.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile="$WHA1354_ENV_DIR/receipt-db-tests.json"`:
  exit 0; **4 passed, 0 failed, 0 pending/skipped**. Scope: **2 tenants, 3 Restaurant
  branches**. Verifies persisted branch isolation, forged tenant read/write denial,
  exactly one competing revision writer, reset and transaction rollback. Suite
  asserts runtime has neither SUPERUSER nor BYPASSRLS before fixtures/tests.
- `node "$PAPERCLIP_RUN_SCRATCH_DIR/evidence.cjs"`: exit 0; asserts runtime flags,
  zero table ownership, both branch tables' FORCE RLS, every migration checksum and
  successful finish, and all four test results. Sanitized evidence retained alongside
  raw JSON test report in the private environment.

Review environment: `.wha1354-verification-NSdov4/README.md` in this checkout.
Directory 0700, credential file 0600; URLs/passwords never printed or committed.
Environment and database preserved for independent review. WHA-1354 owns cleanup
after review: remove only its new database/roles and private directory; never stop
the shared disposable cluster or remove WHA-1350's data. Expected untracked private
environment remains; only this documentation is committed by the heartbeat.

WHA-1360 reported producer artifact `bc0693705163c618c3445ffcc7c8b89f13ac8024`
with 28/28 checks; acknowledged as owner evidence, not locally integrated/verified.
Existing local typecheck missing-token producer error therefore remains a composition
gate. Prior 27/27 snapshot/unit checks remain valid for unchanged source. No full
typecheck/build/lint rerun for this documentation-only update. Independent review,
Pharmacy adapter authorization/persistence acceptance, composed producer/runtime/POS
integration, staging visual/build acceptance and actual configured-printer acceptance
remain separate gates. No app/browser services, deployment or real-device access.

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
