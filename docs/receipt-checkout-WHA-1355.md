# WHA-1355 Restaurant receipt checkout dispatch

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

