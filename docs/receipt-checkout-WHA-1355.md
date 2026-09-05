# WHA-1355 Restaurant receipt checkout dispatch

## Authorized consumer correction — September 5

This section supersedes the earlier Unicode, runtime typing and fake-TCP failures below.
Board authorized one private correction in comment `66105b3e-cd4f-4ac4-88b8-76243bdbbfd1`.
Starting assigned branch/clean HEAD: `2d90ac2b1a48ed56ffe4194feba67daf34ba9bf2`.
Studio contract read in full; installed Next route/client guidance from the preceding pass
remains applicable. Existing Studio buttons, inputs, semantic tokens, wrapping and status
semantics reused. No shared/runtime source was edited by the owned correction.

Producer parents/scopes verified before applying these exact corrections, in order:

| Original producer correction               | Private cherry-pick                        | Private parent                             |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| `bdea63a2cd3d35eab300dc585e7e1352cf64c4e4` | `aaae082b745a88b53ce3bbc66ad48bae4653484c` | `2d90ac2b1a48ed56ffe4194feba67daf34ba9bf2` |
| `513d05ad34f3268c2229c2ea5703786726e7ccde` | `a902808a9271bc617c83f17a8301f20910303f02` | `aaae082b745a88b53ce3bbc66ad48bae4653484c` |
| `5c222a54ef24993693b4c07d4066c89a2ac5fb9b` | `5baea4db89c494e9183989f306cc5ab984a03c5e` | `a902808a9271bc617c83f17a8301f20910303f02` |
| `ceed2f40a78bafbc24d68506f010218c30a0a6fe` | `f0f0fed35181327db506f4bf622a9ab7cf953c24` | `5baea4db89c494e9183989f306cc5ab984a03c5e` |

Original parents respectively: `411306de8d88b8eea574caa93750a972afa028d7`,
`bdea63a2cd3d35eab300dc585e7e1352cf64c4e4`,
`bc0693705163c618c3445ffcc7c8b89f13ac8024`,
`655c7f9a1668c122b6319a5fea33910564b9cfa7`.
The runtime correction was delivered during this pass in WHA-1356 comment
`0ead2968-b94e-4a96-8812-a5497c04b27b`; the Board explicitly permitted consuming that
single subsequent artifact. All cherry-picks applied cleanly; no original producer commits
were repeated. The wider semantic schema and matching queue guard were applied together
before verification. Earlier prerequisite ancestry is recorded in the next section.

Owned correction-only parent: `f0f0fed35181327db506f4bf622a9ab7cf953c24`.
Exact correction SHA is recorded in the completion comment. A composer with prerequisites
already present should take only this owned correction after the prior owned integration.

### Changed paths and resulting behavior

- `src/app/api/restaurant/checkout/receipt/receipt-dispatch.ts`
- `src/app/api/restaurant/checkout/receipt/route.test.ts`
- `src/app/api/restaurant/checkout/receipt/receipt-dispatch.db.test.ts`
- `src/components/restaurant/pos/receipt-browser-print.ts`
- `src/components/restaurant/pos/receipt-print-controls.tsx`
- `src/components/restaurant/pos/receipt-print-controls.test.tsx`
- `docs/receipt-checkout-WHA-1355.md`

Browser output now uses only the shared safe-Unicode `buildReceiptPreview` via inert
`textContent` and `white-space: pre-wrap`. Urdu business/header/footer/item text, combining
characters, supplementary characters and joining sequences are preserved. The temporary
plain-text renderer and consumer ASCII regex are removed. Existing ASCII golden output,
canonical financial facts, captured job layout/width, original/reprint idempotency, branch/payment
guards, queue/event/outbox atomicity and settings routing/designer entry remain covered.

New raw jobs use `validateRawPrintDocument`; shared enqueue independently enforces the same
boundary. Dedicated caller returns HTTP 422 with the safe `RawPrintValidationError` fields:
`UNSUPPORTED_PRINT_TEXT` / `fallback: BROWSER_OS` permits the shared browser receipt;
`INVALID_PRINT_DOCUMENT` / `fallback: null` permits no print fallback. Neither persists a new
job or event. Corrupt semantic data yields no browser preview; a missing preview cannot fall
through to an unvalidated plain renderer. Typed refusals do not claim uncertain delivery;
network failures retain existing same-request retry and duplicate-copy checks.

The existing TerminalRequest adapter exposes only status and safe message on errors. The UI
recognizes the shared unsupported-text constant for 422; other 422 responses fail closed as
invalid, without matching arbitrary payload text. GET also supplies structured preview validation.
Browser rendering requires valid text and an allowed fallback, while still enforcing duplicate-copy
acknowledgement for existing or uncertain jobs. Browser dialog closure never proves printing.
No new polling, feature policy, schema, dependency, palette or motion system was introduced.

### Exact checks and results

- First caller/UI check: **36 passed, 0 failed, 0 skipped**, two files.
- Combined final check: **207 passed, 0 failed, 0 skipped**, 18 files. This includes **24 DB
  cases**: caller 5, queue/current-claim 11, legacy printing/fake TCP 4, persisted layout 4.
  Remaining 183 cases cover caller/controls, layouts, shared renderer/goldens, route permissions,
  station-route preservation, and 60 runtime tests with synthetic transport/native-process seams.
- Runtime-inclusive scoped TypeScript: **exit 0, 0 diagnostics**, actual Next ambient types and
  transitive imports, including producer service/renderer/API and runtime/tests. Both former
  runtime TS2352 findings are resolved in this composition by the producer correction.
- Scoped ESLint, formatting and diff checks: **exit 0**, no lint warnings/errors.
- No test or typecheck failures occurred during this correction. No full build/typecheck,
  local app/browser service, visual screenshots or physical/native printer execution.

New database `wha1355_disposable_31b07959a9` was provisioned using the previously documented
WHA-1354 pattern on the identity-verified WHA-1350 PG16.15 cluster, `127.0.0.1:52027`.
No existing test database was used. Dedicated runtime had NOSUPERUSER, NOBYPASSRLS,
NOCREATEDB, NOCREATEROLE, NOINHERIT, and owned **0 application tables**. Branch/job/bill
tables had ENABLE/FORCE RLS. **105 migrations, 0 unsuccessful, 0 checksum mismatches**.
No schema change required client regeneration. Provisioning, extension preparation, migrations,
scoped grants and evidence checks succeeded. After evidence capture, identity-checked cleanup
removed only this new database and its dedicated owner/runtime roles, without FORCE, stopping
the shared cluster, or terminating another session. Private credentials/scripts stayed in run scratch.

Commands, with owner/runtime URLs sourced privately and reports retained in run scratch:

```sh
node "$PAPERCLIP_RUN_SCRATCH_DIR/provision.cjs"
EXTENSION_ADMIN_DATABASE_URL="$OWNER_DATABASE_URL" node --import tsx prisma/prepare-extensions.ts
node node_modules/prisma/build/index.js migrate deploy --config "$WHA1355_ENV_DIR/migration.config.mjs"
node "$PAPERCLIP_RUN_SCRATCH_DIR/db-control.cjs" grant
node node_modules/vitest/vitest.mjs run src/app/api/restaurant/checkout/receipt/route.test.ts src/components/restaurant/pos/receipt-print-controls.test.tsx --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile="$PAPERCLIP_RUN_SCRATCH_DIR/caller-tests.json"
node node_modules/vitest/vitest.mjs run src/app/api/restaurant/checkout/receipt src/components/restaurant/pos/receipt-print-controls.test.tsx src/components/restaurant/pos/receipt-view.test.tsx src/components/restaurant/restaurant-devices-console.test.tsx 'src/app/(app)/settings/settings-entitlements.test.tsx' src/lib/restaurant/checkout-routes.test.ts src/lib/restaurant/printing src/lib/receipts src/components/receipts/receipt-designer.test.tsx src/app/api/restaurant/receipt-layout/route.test.ts src/app/api/restaurant/print-bridge/route.test.ts tests/print-bridge.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile="$WHA1355_ENV_DIR/combined-tests.json"
node node_modules/typescript/bin/tsc --noEmit -p "$PAPERCLIP_RUN_SCRATCH_DIR/correction-tsconfig.json"
node node_modules/eslint/bin/eslint.js src/app/api/restaurant/checkout/receipt/{receipt-dispatch.ts,route.test.ts,receipt-dispatch.db.test.ts} src/components/restaurant/pos/{receipt-browser-print.ts,receipt-print-controls.tsx,receipt-print-controls.test.tsx}
node node_modules/prettier/bin/prettier.cjs --check src/app/api/restaurant/checkout/receipt/{receipt-dispatch.ts,route.test.ts,receipt-dispatch.db.test.ts} src/components/restaurant/pos/{receipt-browser-print.ts,receipt-print-controls.tsx,receipt-print-controls.test.tsx} docs/receipt-checkout-WHA-1355.md
node "$PAPERCLIP_RUN_SCRATCH_DIR/db-control.cjs" evidence
node "$PAPERCLIP_RUN_SCRATCH_DIR/db-control.cjs" cleanup
git diff --check
```

`correction-tsconfig.json` extends this checkout's absolute `tsconfig.json`, sets
`incremental: false` and `noEmit: true`, excludes `node_modules`, and includes these patterns
resolved to absolute paths (no stubs or suppressed dependency diagnostics):

```json
[
  "next-env.d.ts",
  "src/types/**/*.d.ts",
  "vitest.setup.ts",
  "src/app/api/restaurant/checkout/receipt/**/*.ts",
  "src/components/restaurant/pos/receipt-browser-print.ts",
  "src/components/restaurant/pos/receipt-print-controls.tsx",
  "src/components/restaurant/pos/receipt-print-controls.test.tsx",
  "src/lib/restaurant/printing/**/*.ts",
  "src/lib/receipts/**/*.ts",
  "src/app/api/restaurant/print-bridge/**/*.ts",
  "src/app/api/restaurant/receipt-layout/**/*.ts",
  "src/components/receipts/**/*.tsx",
  "src/app/(app)/settings/receipts/page.tsx",
  "scripts/print-bridge.ts",
  "tests/print-bridge.test.ts"
]
```

### Remaining acceptance and recovery

Private correction evidence is complete; release acceptance is **blocked** on Board/assigned
WHA-1362 independent combined review and authoritative composition, Verification Engineer's
approved staging build/full Studio matrix, and Saad/hardware owner's explicit supported-host,
driver/connection and physical printer targets. Passing synthetic TCP/native subprocess tests
does not establish Windows/macOS execution, glyph metrics, paper/cut behavior or physical
delivery. Windows98/Vista/7 remain unsupported modern runtime hosts. No universal compatibility,
native Unicode ESC/POS or physical exactly-once guarantee is claimed.

No extra worker/review, nested CLI, push, merge, staging or deployment was started. Rollback
before composition: omit this owned correction and its prerequisites as a coordinated set;
never deploy widened semantic validation without the queue guard. Retain captured jobs and
attempt state; inspect uncertain deliveries before manual copies. Additive database data must
not be destroyed to undo this caller-only correction.

## Authorized private development integration — September 5

This section supersedes the initial-pass snapshot/DB limitations below. It is **private
development only**, not authoritative WHA-1116 composition, producer independent review,
staging approval, or physical printer acceptance. Final disposition remains **blocked**.
Supervisor authorization: comment `84ef8978-798f-4444-b8c3-5a6a122d1fe3`.

Clean assigned branch and HEAD `74bb5b3c4e5e520845304d9200c6a37fe6d556e0` verified before
mutation. Producer parent/scope inspection completed before cherry-picking. None was an exact
ancestor, so all four were applied in the authorized order. No conflicts; Git automatically
preserved the designer navigation alongside the existing routing changes. The existing settings
regression passed after composition. No other candidate commits were added.

| Original producer                          | Private cherry-pick                        | Private parent                             |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| `806f1138395c595ca27e3eb086581b9961fb441e` | `4cb05b80a8bbc69efca2aa0abaefa2fc046433de` | `74bb5b3c4e5e520845304d9200c6a37fe6d556e0` |
| `411306de8d88b8eea574caa93750a972afa028d7` | `43b7b8d48a9720c23c3a1b2d26489115e1cdfd05` | `4cb05b80a8bbc69efca2aa0abaefa2fc046433de` |
| `bc0693705163c618c3445ffcc7c8b89f13ac8024` | `f0685b7dcae1dd022dc62657e0c1079c53c35169` | `43b7b8d48a9720c23c3a1b2d26489115e1cdfd05` |
| `655c7f9a1668c122b6319a5fea33910564b9cfa7` | `7562dde3057554278d73b35fc66c6e91a80ed68a` | `f0685b7dcae1dd022dc62657e0c1079c53c35169` |

The integration-only commit has parent `7562dde3057554278d73b35fc66c6e91a80ed68a`;
its exact SHA is in the issue completion comment. The original caller commit's parent remains
`fe1e3e383c8b966cdb68669ba5366db00fe2320a`. An authoritative composer that already applied
the producers should take only the new integration commit after the original caller patch;
do not repeat the producer cherry-picks.

### Integration-only paths and behavior

- `src/app/api/restaurant/checkout/receipt/receipt-dispatch.ts`
- `src/app/api/restaurant/checkout/receipt/route.ts`
- `src/app/api/restaurant/checkout/receipt/route.test.ts`
- `src/app/api/restaurant/checkout/receipt/receipt-dispatch.db.test.ts`
- `src/components/restaurant/pos/receipt-browser-print.ts`
- `src/components/restaurant/pos/receipt-print-controls.tsx`
- `src/components/restaurant/pos/receipt-print-controls.test.tsx`
- `docs/receipt-checkout-WHA-1355.md`

New receipt jobs now consume `getRestaurantReceiptLayout` with the authorized organization and
device branch and persist `PrintDocument.receiptSnapshot = { layout, facts }`. Shared
`ReceiptPreviewFacts` carries saved identity, dates, quantities, unit prices, line subtotal/comp/
tax/service/total, bill discount/fees/tax/rounding/total, fractional splits, every tender/tip/change/
cash-received value, service rate/basis/tax treatment, and any original saved tax snapshot currency,
rate buckets and discount allocations. No totals are recalculated, truncated, or accepted from
the client. No card credentials or arbitrary fiscal evidence JSON is exposed.

Settings changes affect subsequent jobs, including explicit new reprints. Existing jobs and
idempotent retries retain captured layout/facts; browser copies of snapshot jobs use exactly
`buildReceiptPreview` text and captured paper width. The UI no longer overrides that width with
an independent selector. Reprint identity and the reason are included in the rendered facts;
new snapshot retries compare the entire original reason, including multiline input.

The shared schema cannot represent Unicode or oversized receipts. Enqueue returns 422, never
question marks. GET preserves complete original facts in inert plain browser text and labels the
layout limitation. **Unicode fallback is deliberately plain, not identical shared layout**:
`ReceiptPreviewFactsSchema` rejects Unicode before shared browser rendering. WHA-1354 owns
the required schema/preview distinction; no shared validation bypass or renderer edit was made.
Corrupt persisted layouts fail closed. Browser output still says “Print dialog requested,” uses
`textContent`, preserves CSP nonce handling, and makes no physical-success inference.

Existing POS/unlocked-operator/`payments:collect` gates, strict input, exact branch restriction,
bill-level lock, idempotency, queue/event/outbox transaction, duplicate-copy acknowledgement,
Studio components/tokens and KOT behavior remain. No shared service, renderer, runtime, schema,
designer, or producer test was edited by the integration-only patch.

### Verification and failures

New isolated database `wha1355_disposable_104c8930dc` was created on the verified disposable
PG16.15 cluster at `127.0.0.1:52027`, using WHA-1354's provisioning pattern and WHA-1350's
private admin configuration. Admin connected only to maintenance `postgres` for identity and
bootstrap. `data_directory` matched the known disposable cluster. No existing test database was
connected to or migrated. Owner/runtime were dedicated NOSUPERUSER, NOBYPASSRLS,
NOCREATEDB, NOCREATEROLE, NOINHERIT roles; runtime owned **0 tables**. Branch, print job,
and bill tables all had ENABLE/FORCE RLS. **105 migrations, 0 unsuccessful, 0 checksum
mismatches**. Extension preparation, migration deploy, local Prisma generation, grants and
evidence checks exited 0. Dependencies/generated client were local directories, not shared links.

Database command below produced **19 passed, 1 failed, 0 skipped**: caller **4/4**, designer
**4/4**, current-claim **8/8**, existing printing **3/4**. Caller tests prove persisted settings,
captured preview/ESC-POS parity, unchanged queued snapshots, new-job settings, tenant/branch
denial, concurrent deduplication, and queue/event/outbox rollback. These exercise the real
database/service with a constructed terminal context; route permissions are tested separately.
The later reason-comparison correction is covered by the unit run, not a repeated DB run.

The existing synthetic TCP case fails at `printing.db.test.ts:158` because it supplies only two
arguments to WHA-1356's now-three-argument `writeToPrinter`; `scripts/print-bridge.ts:198`
throws `TypeError: Cannot read properties of undefined (reading 'includes')` while reading the
required allowlist. No physical device test occurred. Failure reported directly to WHA-1356
and WHA-1360, whose runtime/test lanes were left unchanged. The failing case was not repeated.

Unit command below: **83 passed, 0 failed, 0 skipped**, ten files. After adding the explicit
saved-tax-allocation regression, the receipt route file alone passed **20/20**; other nine files'
unchanged evidence reused, giving **84 unique unit cases**. Initial two-file run had **26 pass,
1 fail** because an assertion ignored 32-column wrapping; assertion corrected to compare
whitespace-normalized preview. No product fact was removed to satisfy that assertion.

Integrated scoped TypeScript (15 source/test roots plus ambient declarations, real transitive
imports): **2 errors**, both producer-owned `scripts/print-bridge.ts:128,144` TS2352 environment
casts missing Next's required `ProcessEnv.NODE_ENV`. Reported directly to WHA-1356. No
`as unknown`, stub, ambient weakening or runtime edit was introduced. The same scoped command
without the runtime root, covering caller plus shared layout/contract/renderer/service and generic
bridge API, exited **0 with no diagnostics**. This narrower pass does not clear the integrated
runtime failure. No full workspace typecheck/build or repeated failing integrated command.

Scoped ESLint: exit 0, no warnings/errors. Source formatting and integration diff-check: exit 0.
The earlier documentation EOF blank line is removed in this documentation update.

Exact verification commands (URLs supplied privately, never printed):

```sh
node "$PAPERCLIP_RUN_SCRATCH_DIR/provision.cjs"
EXTENSION_ADMIN_DATABASE_URL="$OWNER_DATABASE_URL" node --import tsx prisma/prepare-extensions.ts
node node_modules/prisma/build/index.js migrate deploy --config "$WHA1355_ENV_DIR/migration.config.mjs"
node node_modules/prisma/build/index.js generate
node "$PAPERCLIP_RUN_SCRATCH_DIR/grant.cjs"
node node_modules/vitest/vitest.mjs run src/app/api/restaurant/checkout/receipt/receipt-dispatch.db.test.ts src/lib/restaurant/printing/printing.db.test.ts src/lib/restaurant/printing/claim.db.test.ts src/lib/receipts/restaurant-settings.db.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile="$WHA1355_ENV_DIR/db-tests.json"
node node_modules/vitest/vitest.mjs run src/app/api/restaurant/checkout/receipt/route.test.ts src/components/restaurant/pos/receipt-view.test.tsx src/components/restaurant/pos/receipt-print-controls.test.tsx src/components/restaurant/restaurant-devices-console.test.tsx 'src/app/(app)/settings/settings-entitlements.test.tsx' src/lib/restaurant/checkout-routes.test.ts src/lib/restaurant/printing/printing.test.ts src/lib/restaurant/printing/receipt-snapshot.test.ts src/lib/receipts/configuration.test.ts src/app/api/restaurant/print-bridge/route.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile="$PAPERCLIP_RUN_SCRATCH_DIR/integration-unit-tests.json"
node node_modules/vitest/vitest.mjs run src/app/api/restaurant/checkout/receipt/route.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile="$PAPERCLIP_RUN_SCRATCH_DIR/final-route-tests.json"
node node_modules/typescript/bin/tsc --noEmit -p "$PAPERCLIP_RUN_SCRATCH_DIR/integration-tsconfig.json"
node node_modules/typescript/bin/tsc --noEmit -p "$PAPERCLIP_RUN_SCRATCH_DIR/caller-tsconfig.json"
node node_modules/eslint/bin/eslint.js src/app/api/restaurant/checkout/receipt/{receipt-dispatch.ts,route.ts,route.test.ts,receipt-dispatch.db.test.ts} src/components/restaurant/pos/{receipt-browser-print.ts,receipt-print-controls.tsx,receipt-print-controls.test.tsx}
node node_modules/prettier/bin/prettier.cjs --check src/app/api/restaurant/checkout/receipt/{receipt-dispatch.ts,route.ts,route.test.ts,receipt-dispatch.db.test.ts} src/components/restaurant/pos/{receipt-browser-print.ts,receipt-print-controls.tsx,receipt-print-controls.test.tsx}
node "$PAPERCLIP_RUN_SCRATCH_DIR/db-evidence.cjs"
node "$PAPERCLIP_RUN_SCRATCH_DIR/cleanup.cjs"
git diff --check
```

Recreate the scoped typecheck configurations without stubs:

```python
import json, os
from pathlib import Path
root = Path.cwd()
scratch = Path(os.environ['PAPERCLIP_RUN_SCRATCH_DIR'])
files = [
    *['src/app/api/restaurant/checkout/receipt/' + f for f in
      ['receipt-dispatch.ts', 'route.ts', 'route.test.ts', 'receipt-dispatch.db.test.ts']],
    *['src/components/restaurant/pos/' + f for f in
      ['receipt-browser-print.ts', 'receipt-print-controls.tsx', 'receipt-print-controls.test.tsx']],
    *['src/lib/receipts/' + f for f in ['configuration.ts', 'preview.ts', 'restaurant-settings.ts']],
    *['src/lib/restaurant/printing/' + f for f in ['contract.ts', 'service.ts', 'esc-pos.ts']],
    'src/app/api/restaurant/print-bridge/route.ts', 'scripts/print-bridge.ts',
]
config = {'extends': str(root / 'tsconfig.json'),
          'compilerOptions': {'incremental': False, 'noEmit': True},
          'include': [str(root / f) for f in files] + [str(root / f) for f in
                      ['next-env.d.ts', 'src/types/**/*.d.ts', 'vitest.setup.ts']],
          'exclude': ['node_modules']}
(scratch / 'integration-tsconfig.json').write_text(json.dumps(config))
config['include'] = [f for f in config['include'] if not f.endswith('/scripts/print-bridge.ts')]
(scratch / 'caller-tsconfig.json').write_text(json.dumps(config))
```

After evidence capture, cleanup reverified cluster identity and removed **only** this new
database and its two dedicated roles, without FORCE or terminating sessions. Shared cluster,
WHA-1350/WHA-1354 databases and other workers' environments remain. Credentials and temporary
scripts were held only in run-owned scratch, not committed. Reproduction needs another new
disposable database provisioned using the same documented restricted owner/runtime pattern.

### Remaining named gates

WHA-1354 owns shared Unicode browser-preview parity. WHA-1356 owns its two integrated runtime
type errors; WHA-1360 and WHA-1356 coordinate the explicit allowlist fixture mismatch. WHA-1362
and producer reviewers own independent review. Board/authoritative composer owns the accepted
WHA-1116 composition. Verification Engineer owns approved staging build and the full Studio
visual/accessibility matrix; Saad/hardware owner supplies configured targets and physical checks.
No local app/browser/hardware service, extra agent, nested Codex, push, merge, stage deployment,
or release-completion claim. No universal printer/OS compatibility claim.

Recovery: omit the integration-only commit from the authoritative composition, or revert it there
under its owner's change process. Never remove additive schema/data to undo this caller change;
captured or attempted jobs require inspection before any manual copy.

## Initial private caller pass (historical evidence)

Bounded implementation artifact; acceptance **blocked** pending composition and staging.

Base/parent: `fe1e3e383c8b966cdb68669ba5366db00fe2320a`.
Branch: `WHA-1355-hw-p0-restaurant-receipt-checkout-dispatch-and-printer-setup-controls`.
Initial checkout clean; no branch switch, remote synchronization, dependency manifest change,
schema edit, migration execution, app/browser service, hardware access, push, merge, or deployment.
The private commit SHA is recorded in the issue completion comment (the commit contains this report).

## Behavior and boundaries

Previously, settled Restaurant receipts only displayed. GET now also supplies the authenticated
register identity, branch receipt route and latest durable job status, with no-store caching.
POST uses the existing terminal transaction, unlocked operator and payments:collect gates, plus
POS-only and settled bill/branch checks. The client cannot supply routing, money or documents.
Saved line amounts, totals, comp, tax, delivery/service charges, rounding, tenders, tips and change
are carried intact into the existing RECEIPT document. Unsupported size/glyphs fail with 422;
they are never silently truncated or transliterated by this caller.

A bill-level advisory lock and deterministic original-print key prevent repeat original submissions
from different transport keys. Reprints require an acknowledged prior receipt, an explicit reason
and a UUID retained across ambiguous client retries. Reusing that UUID with a different reason
fails. New jobs and attributed order event/outbox records use the owning terminal transaction.
The service, renderer, queue ACK protocol and KOT flows are unchanged.

UI reports queued, offline/failed, uncertain and bridge-acknowledged delivery. Acknowledgement
means the bridge reported delivery to its sink; it does not prove paper output. No automatic
status polling or print retries were added. Browser fallback creates inert DOM text (including
Unicode), uses a 54/76 mm content width plus 2 mm margins for 58/80 mm paper, and asks the user
to choose matching OS paper. CSS page size stays auto: custom-width/auto-height is not valid CSS.
It says “Print dialog requested”; afterprint never records physical success. Existing/uncertain
jobs require a duplicate-copy acknowledgement before the fallback.

Devices links the existing Settings screen. Printer settings adds an explicit synthetic RECEIPT
test using the saved branch route and stable retry key, disabled for unsaved/no-printer states.
Editing one route now preserves sibling station routes instead of deleting all routes of that type.
Existing Studio Button/Input and semantic text/surface/border tokens are reused. No shell,
palette, fonts, animations or authentication mechanics changed.

## Changed files

- src/app/api/restaurant/checkout/receipt/route.ts
- src/app/api/restaurant/checkout/receipt/receipt-dispatch.ts
- src/app/api/restaurant/checkout/receipt/route.test.ts
- src/components/restaurant/pos/receipt-view.tsx
- src/components/restaurant/pos/receipt-print-controls.tsx
- src/components/restaurant/pos/receipt-print-controls.test.tsx
- src/components/restaurant/pos/receipt-browser-print.ts
- src/components/restaurant/restaurant-devices-console.tsx
- src/app/(app)/settings/settings-content.tsx
- src/app/(app)/settings/settings-entitlements.test.tsx
- docs/receipt-checkout-WHA-1355.md

## Executed verification

Installed only existing frozen dependencies with `bun install --frozen-lockfile --ignore-scripts`
(exit 0), then `bunx prisma generate` (exit 0). Installed Next 16.2.12 route-handler and use-client
docs read before edits. Claude-Mem, Codebase Memory, Ponytail and rg unavailable; narrow fallback
used once, no repair effort or nested Codex. No agents spawned.

Final focused run, exit 0: **48 passed, 0 failed, 4 skipped**, 7 test files passed / 1 DB file skipped.
The four existing queue DB tests skip without TEST_DATABASE_URL. Unit route tests exercise the
real money capability/body gates and real enqueue service against doubles; authentication, DB
and event append are seams. This is not proof of live RLS, transaction rollback or concurrent DB locks.

```sh
bunx vitest run src/app/api/restaurant/checkout/receipt/route.test.ts src/components/restaurant/pos/receipt-view.test.tsx src/components/restaurant/pos/receipt-print-controls.test.tsx src/components/restaurant/restaurant-devices-console.test.tsx 'src/app/(app)/settings/settings-entitlements.test.tsx' src/lib/restaurant/checkout-routes.test.ts src/lib/restaurant/printing/printing.test.ts src/lib/restaurant/printing/printing.db.test.ts
bunx eslint src/app/api/restaurant/checkout/receipt/{route.ts,route.test.ts,receipt-dispatch.ts} src/components/restaurant/pos/{receipt-view.tsx,receipt-print-controls.tsx,receipt-print-controls.test.tsx,receipt-browser-print.ts} src/components/restaurant/restaurant-devices-console.tsx 'src/app/(app)/settings/settings-content.tsx' 'src/app/(app)/settings/settings-entitlements.test.tsx'
bunx prettier --check src/app/api/restaurant/checkout/receipt/{route.ts,route.test.ts,receipt-dispatch.ts} src/components/restaurant/pos/{receipt-view.tsx,receipt-print-controls.tsx,receipt-print-controls.test.tsx,receipt-browser-print.ts} src/components/restaurant/restaurant-devices-console.tsx 'src/app/(app)/settings/settings-content.tsx' 'src/app/(app)/settings/settings-entitlements.test.tsx'
git diff --check
```

ESLint: exit 0, no errors/warnings. Prettier: exit 0, all 10 source/test files formatted.
Diff check: exit 0. Initial focused run: 47 passed / 0 failed / 4 skipped; sibling-route regression
added afterwards. Initial ESLint found 9 render-time-ref errors and 1 unused-variable warning;
corrected using state for visible retry information and explicit job serialization.

Full `bunx tsc --noEmit --incremental false` failed, exit 134:
`FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`.
It was not repeated with a larger heap. Scoped TypeScript API validation checks all 10 changed
source/test files against real imports, without stubs: **0 diagnostics**, exit 0. Dependency-only
diagnostics are excluded. Initial scoped configuration omitted ambient declarations/Vitest setup;
corrected; three invalid Testing Library exact options also removed. Reproduce the final scope:

```sh
node <<'NODE'
const ts = require(process.cwd() + '/node_modules/typescript');
const path = require('node:path');
const files = [
  'src/app/api/restaurant/checkout/receipt/route.ts',
  'src/app/api/restaurant/checkout/receipt/route.test.ts',
  'src/app/api/restaurant/checkout/receipt/receipt-dispatch.ts',
  'src/components/restaurant/pos/receipt-view.tsx',
  'src/components/restaurant/pos/receipt-print-controls.tsx',
  'src/components/restaurant/pos/receipt-print-controls.test.tsx',
  'src/components/restaurant/pos/receipt-browser-print.ts',
  'src/components/restaurant/restaurant-devices-console.tsx',
  'src/app/(app)/settings/settings-content.tsx',
  'src/app/(app)/settings/settings-entitlements.test.tsx',
].map(file => path.resolve(file));
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const roots = [...files, ...parsed.fileNames.filter(file => file.endsWith('.d.ts')), path.resolve('vitest.setup.ts')];
const program = ts.createProgram(roots, { ...parsed.options, incremental: false, noEmit: true });
const diagnostics = [...parsed.errors, ...program.getOptionsDiagnostics()];
for (const file of files) {
  const source = program.getSourceFile(file);
  if (!source) throw new Error('Source missing: ' + file);
  diagnostics.push(...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source));
}
console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getCanonicalFileName: file => file,
  getNewLine: () => '\n',
}));
console.log(`Scoped typecheck: ${files.length} files, ${diagnostics.length} diagnostics; real transitive imports, no stubs. Dependency-only diagnostics are outside this check.`);
process.exitCode = diagnostics.length ? 1 : 0;
NODE
```

## Pending acceptance and named handoffs

1. **WHA-1354 / shared layout owner and Chief of Staff:** compose published design/schema commit
   806f1138395c595ca27e3eb086581b9961fb441e and its pending receiptSnapshot contract/renderer extension.
   The assigned fe1e3e3 checkout has none of those modules/schema fields. No other lane was copied
   or imported silently. Then assign a bounded caller integration pass to load
   getRestaurantReceiptLayout with the authenticated tenant/branch, map saved facts to
   ReceiptPreviewFacts, enqueue an immutable layout/facts snapshot, and use the shared browser
   preview. Current baseline does not consume designer settings. The designer commit also touches
   settings-content.tsx for navigation; the composition owner must preserve both changes.
2. **WHA-1360 / queue-security owner:** compose branch restrictions and device/current-claim ACK
   ownership before accepting real dispatch. The assigned base allows unsafe unclaimed ACK and
   retries uncertain jobs. This caller does not repair shared-service security; do not ship it
   without that repair. OFFLINE/attempted PENDING receipts are intentionally held; operator
   recovery after uncertain delivery still needs the composed queue-owner policy.
3. **WHA-1356 / transport owner:** compose destination allowlist, supported-host transports and
   claim-token echo. Saad/hardware owner supplies explicit configured printer/driver/connection
   targets. No discovery, credential guessing or real network/device use performed.
4. **Chief of Staff / Verification Engineer:** provide isolated migrated TEST_DATABASE_URL with
   enforcing RLS role for cross-tenant/branch, concurrency and rollback evidence; provide an
   approved staging revision for production build, browser/hardware acceptance and independent
   review. Local app/browser services were explicitly prohibited.

Studio visual matrix is **pending**, not mocked as complete: 375/768/1024/1440 widths; light/dark;
normal/reduced motion; keyboard/focus; overflow/reflow; loading/empty/error/disabled states;
console/hydration/client-fetch errors; printer dialog behavior/screenshots. Unit assertions prove
labels, disabled states, stable dispatch, status semantics, Unicode inertness and width styles only.

Windows 98/Vista/7 are not supported hosts for the modern browser/Node stack. Use a supported host
with a validated driver/transport. No universal printer/OS compatibility or physical print claim.

Recovery: this is a private patch only. Before rollout, the composition owner can omit/revert this
commit. If ever deployed, disable the receipt route on the approved host and inspect existing
queued/attempted jobs before any manual copy; removing UI never cancels already queued jobs.
