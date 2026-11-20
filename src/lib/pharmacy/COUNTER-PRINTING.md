# WHA-1358 Pharmacy browser printing evidence

## Authorized private consumer integration — September 5

Supervisor comment `32c4b49a-3067-462c-83bd-bbb143cd363c` authorized these exact
dependency copies solely for private development. Original base remains
`fe1e3e383c8b966cdb68669ba5366db00fe2320a`; clean starting HEAD was
`2cdef75b9f9bb85f9706ec113a13c3a6267d5183`, preserving its parent
`8fccc771aeb4fdd07141ada88e8a74e39459a588`.

| Source dependency                          | Local private copy                         |
| ------------------------------------------ | ------------------------------------------ |
| `c49b1afa252f20905269a044d09bdb0406eb7b60` | `0b7bca3a662f904ce55e7a70a5229a67bbe37c52` |
| `806f1138395c595ca27e3eb086581b9961fb441e` | `cab383313b1a661e74a5065bb5f599be2b24de9a` |
| `411306de8d88b8eea574caa93750a972afa028d7` | `120855488ed740aa448d702b9d0b33f5c188ef52` |
| `bdea63a2cd3d35eab300dc585e7e1352cf64c4e4` | `1e920422ed17ea8e8d6b422c151b495c50c16bd2` |
| `513d05ad34f3268c2229c2ea5703786726e7ccde` | `57cb2f0d77b7b4b68214797faf13ee52927599ca` |

All cherry-picks clean; consumer parent is the last local copy above. These are
not accepted compose/release artifacts. Consumer SHA is recorded in Paperclip.

Owned consumer paths:

- `src/lib/pharmacy/counter-receipt-presentation.ts`
- `src/lib/pharmacy/counter-browser-print.ts`
- `src/lib/pharmacy/counter-browser-print.test.ts`
- `src/components/pharmacy/counter/counter-receipt-view.tsx`
- `src/components/pharmacy/counter/counter-receipt-view.test.tsx`
- `src/lib/pharmacy/COUNTER-PRINTING.md`

Before: UI/browser receipt used singular batch/expiry fields and the UI details
preview used the old raw document envelope. After: issued identity and every
allocation's own batch, expiry and canonical units appear below ONE financial
line. Explicit UNAVAILABLE and legacy missing status show localized historical
identity unavailable; unverified live medicine/presentation/batch labels are not
used. Null allocation labels remain unavailable. No price/tax/total/refund
calculation changes. Existing cart refresh code/assertions have zero diff.

The presentation adapter calls shared `buildReceiptPreview`, which validates
`ReceiptLayoutSchema` and `ReceiptPreviewFactsSchema`. React text and escaped
browser text remain inert; `pre-wrap` preserves Unicode logical lines. Browser
58/80 mm and A4 output uses the same preview. The model has no tax breakdown;
an explicit localized unavailable message replaces any invented zero-tax fact.
This semantic preview does not assert raw-printer capability and enables no
queue. Saved layout read/write remains unconnected; only transient width/default
layout is used. Printing still requests the OS dialog without confirming paper.

Studio contract and bundled Next `use-client.md` read. Existing Button, Label,
StatusPill and semantic surface/text/border/focus classes reused. Existing
idle/loading/error/disabled/reprint controls retained; invalid shared semantic
input disables printing. No app/browser services under the explicit task limit.
Claude-Mem/Codebase Memory/Ponytail unavailable; narrow local fallback retained.

Exact focused verification (final source, before documentation-only changes):

```sh
node node_modules/vitest/vitest.mjs run src/lib/pharmacy/counter-browser-print.test.ts src/components/pharmacy/counter/counter-receipt-view.test.tsx src/lib/pharmacy/counter-query-refresh.test.ts src/lib/pharmacy/counter-receipt.test.ts
# exit 0; 4 files, 47 passed, 0 failed, 0 skipped
node node_modules/typescript/bin/tsc --noEmit --project "$PAPERCLIP_RUN_SCRATCH_DIR/tsconfig.receipt-consumer.json"
# exit 0; no diagnostics
node node_modules/eslint/bin/eslint.js src/lib/pharmacy/counter-receipt-presentation.ts src/lib/pharmacy/counter-browser-print.ts src/lib/pharmacy/counter-browser-print.test.ts src/components/pharmacy/counter/counter-receipt-view.tsx src/components/pharmacy/counter/counter-receipt-view.test.tsx
# exit 0; no diagnostics
node node_modules/prettier/bin/prettier.cjs --check src/lib/pharmacy/counter-receipt-presentation.ts src/lib/pharmacy/counter-browser-print.ts src/lib/pharmacy/counter-browser-print.test.ts src/components/pharmacy/counter/counter-receipt-view.tsx src/components/pharmacy/counter/counter-receipt-view.test.tsx
# exit 0; All matched files use Prettier code style!
git diff --check
# exit 0
```

Scoped config reproduces the earlier Python recipe: use the five consumer TS/TSX
paths above plus `src/types/next-auth.d.ts` and `vitest.setup.ts`; filename is
`tsconfig.receipt-consumer.json`, same compiler options. First test pass also had
47 passing tests; final pass followed centralizing existing amount validation in
the shared Pharmacy presentation adapter. No test failures. Format write ran on
the five consumer files. No full build/typecheck, database test/migration, browser
service, device access or independent reviewer launched. Parent dependency tests
are owner evidence only, not claimed as rerun here.

Remaining acceptance groups:

1. Board independent combined review and Restaurant-first composition; WHA-1354,
   WHA-1355, WHA-1356 and WHA-1360 retain their shared/transport responsibilities.
2. GitHub89 staff-to-branch/capability policy: Board/Saad decision and WHA-1364
   backend authorization repair. No permission workaround or settings write added.
3. Saved Pharmacy designer/settings adoption after authorized permission contract;
   source tax-breakdown contract remains unavailable, without invented money.
4. Board/Verification owner authorized staging Studio matrix and configured
   real-printer/OS output, Unicode fonts, 58/80 mm and A4, retry/cancel/margins.

Private consumer work is delivered; overall hardware acceptance stays blocked.
Rollback consumer application commit only; retain dependency snapshot events and
additive data. No migrations executed here. Older sections below are historical
evidence; backend live-label limitations are superseded by the copied #90 model,
while GitHub89 authorization and release gates remain unresolved.

Base / parent: `fe1e3e383c8b966cdb68669ba5366db00fe2320a`.
Owned branch: `WHA-1358-hw-p1-pharmacy-receipt-printing-and-shared-designer-settings-adoption-after-restaurant`.
Initial worktree clean. No remote synchronization, services, migrations, devices or network discovery.

## Delivered, pending composition

Previously the counter invoked `window.print()` on the full POS page, including adjacent
patient panels. The button and keyboard action now open an isolated, escaped receipt document.
Only explicit receipt fields are rendered; patient, prescription, clinical flags, arbitrary
extra properties and fiscal fields are excluded. Medicine sale lines remain on the receipt.
Printing reads supplied line amounts and totals without repricing or tax calculations.
Unsettled, missing, stale/refetching or failed receipt queries cannot invoke the print action.
Popup denial and print exceptions provide retry guidance. A dialog request never confirms
physical delivery. Reprint marking follows print attempts during the active sale session;
it is not a durable print audit and cancellation cannot be distinguished from delivery.

DEV-973: the isolated document is no longer written into a pop-up and printed from the counter.
That pop-up shared the counter's browsing-context group, so its print dialog froze the counter
while the pop-up sat behind it. Every browser print now opens `public/pharmacy/counter/print-window.html`
with `noopener` (its own group, on https and on a plain-http LAN address alike), hands it the
document over a per-window `BroadcastChannel`, and the print page prints itself, then closes when
its dialog closes. With `noopener` a blocked pop-up is the one whose page never announces itself
within 5 s. The counter never calls `print()` and shows one line while a print window is open.
The counter service worker keeps the print page for offline printing
(`src/lib/browser-print/print-window.ts`).

Transient 58/80 mm and A4 choices only. The OS dialog must select the matching printer and paper.
No persisted designer, printer configuration, queue, driver or server mutation was introduced.
The shared protocol preview remains available and is explicitly labeled as not queued.
Existing Studio Button, Label, StatusPill and semantic screen tokens are reused. Physical
print CSS uses black on white and millimetres, without external assets.

## Source trace and unresolved contracts

- `src/server/routers/pharmacy-sales.ts:counterReceipt` uses `protectedProcedure`, active-user
  authentication and the `pharmacy-counter` entitlement (`src/lib/module-catalog.ts`). It resolves
  organization from context and checks the branch belongs to that organization.
- `src/lib/pharmacy/counter.ts:saleInScope` predicates sale ID, organization ID and branch ID.
  The existing query does not add a dedicated POS capability or actor branch-membership guard.
  This change preserves existing access rules; it does not establish stronger authorization.
- `readCounterReceipt` derives totals from sold prices/discounts/tenders and reads current medicine
  names. This is not a verified immutable receipt snapshot. The renderer preserves its input,
  but immutable historical labels/totals require a source-owner decision.
- `src/lib/pharmacy/sales.ts:returnSaleLine` creates separate return/movement records without
  editing sold quantities. Receipt input has no return/refund adjustment contract. This renderer
  does not invent a net-of-return total or represent a refund receipt.
- `RestaurantPrintJob.branch` references `RestaurantBranch`. Pharmacy IDs must never be supplied.

Named unblock owners/actions:

1. WHA-1354 designer/schema owner: supply a shared saved-layout resolver and settings entry scoped
   by organization, Pharmacy branch and module; return versioned design and 58/80 mm selection.
   Define separate read/config-write permissions. No Pharmacy-local substitute schema.
2. WHA-1355 Restaurant owner: provide verified Restaurant composition revision before Pharmacy
   shared-contract acceptance. WHA-1356 transport / WHA-1360 durable-print owners: provide a
   Pharmacy-safe transport/queue scope if direct printing is enabled.
3. Current supervisor/board: resolve/assign immutable receipt-source and POS access-policy prerequisites;
   supply an authorized staging revision and browser/hardware acceptance owner.

## Verification

Existing locked dependencies installed using `bun install --frozen-lockfile --ignore-scripts`
(exit 0, 1293 packages). `bunx prisma generate` exited 0; generated client only, no database access.
Bundled Next 16.2.12 `use-client.md` read before client edits.

Commands and exact results:

```sh
bun run test -- src/lib/pharmacy/counter-browser-print.test.ts src/lib/pharmacy/counter-receipt.test.ts
# exit 0; 2 files passed, 28 tests passed, 0 failed, 0 skipped
bun run test -- src/components/pharmacy/counter/counter-receipt-view.test.tsx
# exit 0; 1 file passed, 6 tests passed, 0 failed, 0 skipped

bunx eslint src/lib/pharmacy/counter-browser-print.ts src/lib/pharmacy/counter-browser-print.test.ts src/components/pharmacy/counter/counter-receipt-view.tsx src/components/pharmacy/counter/counter-receipt-view.test.tsx src/components/pharmacy/counter/counter-console.tsx
# exit 0; no diagnostics
bunx prettier --check src/lib/pharmacy/counter-browser-print.ts src/lib/pharmacy/counter-browser-print.test.ts src/components/pharmacy/counter/counter-receipt-view.tsx src/components/pharmacy/counter/counter-receipt-view.test.tsx src/components/pharmacy/counter/counter-console.tsx
# exit 0; All matched files use Prettier code style!
git diff --check
# exit 0
```

Scoped typecheck includes the five changed TS/TSX files and their transitive imports. Reproduce:

```sh
python3 - <<'PY'
import json, os
from pathlib import Path
root = Path.cwd()
files = [
    'src/lib/pharmacy/counter-browser-print.ts',
    'src/lib/pharmacy/counter-browser-print.test.ts',
    'src/components/pharmacy/counter/counter-receipt-view.tsx',
    'src/components/pharmacy/counter/counter-receipt-view.test.tsx',
    'src/components/pharmacy/counter/counter-console.tsx',
    'src/types/next-auth.d.ts', 'vitest.setup.ts',
]
target = Path(os.environ['PAPERCLIP_RUN_SCRATCH_DIR']) / 'tsconfig.pharmacy-print.json'
target.write_text(json.dumps({
    'extends': str(root / 'tsconfig.json'),
    'compilerOptions': {'incremental': False, 'baseUrl': str(root)},
    'files': [str(root / file) for file in files], 'include': [], 'exclude': [],
}))
PY
bunx tsc --noEmit --project "$PAPERCLIP_RUN_SCRATCH_DIR/tsconfig.pharmacy-print.json"
# exit 0; 0 diagnostics
```

Initial scratch typecheck omitted existing auth/test declarations: exit 2, 722 diagnostics.
One configuration correction included those declarations; final check above passed. No source
casts or weakened compiler rules were added to silence failures. Unit/component evidence uses
jsdom and mocked browser APIs; it is not physical printing or visual acceptance.

Seven verification/setup runs when counting dependency install, generation, two targeted test
runs, consolidated lint/format and two scoped typechecks. No build, DB tests, full workspace
suite, local browser services, independent agents or hardware runs.

## Remaining acceptance gates (4 groups)

1. Saved-design/settings adoption and Restaurant-first composition described above.
2. Immutable source/returns semantics and owner-approved POS/config permissions.
3. Authorized staging visual matrix: 375/768/1024/1440 px, light/dark, reduced/normal motion,
   keyboard/focus, overflow, idle/loading/error/disabled/reprint states and console errors.
   No screenshots or browser results exist for this change.
4. Configured real printer/OS acceptance: 58/80 mm margins, long lines/pages, Urdu fonts,
   popup behavior, cancellation/retry, supported queue/driver delivery and actual paper output.

Windows 98/Vista/7 cannot host this modern browser/Node application. Use an independently
supported, maintained host/browser and vendor-supported printer driver or approved bridge;
legacy machines are not bridge hosts. Requested Windows 10/macOS support depends on maintained
OS/runtime versions, configured model and vendor driver validation. USB, serial, Bluetooth and
network connections are not universally supported by this browser fallback: an OS-visible queue
and compatible driver are prerequisites. No device compatibility was tested or promised.

Rollback: revert only this private commit after owner review; no data/schema changes to undo.

## POS-09 continuation — pending initial cart read

Continuation parent: `8fccc771aeb4fdd07141ada88e8a74e39459a588` (clean checkout).
Original assigned base remains `fe1e3e383c8b966cdb68669ba5366db00fe2320a`.
Board/WHA-1351 assigned synchronization correction to this existing Pharmacy lane.
The initial cart request starts when ensureSale activates the sale, before addLine commits.
Invalidation could reuse that pending empty read. The refresh helper now awaits cancellation
before invalidation, forcing a fresh read and preventing a late old response from replacing it.
Receipt invalidation follows the cart refresh. Existing mutation, alert and tender rules remain.

Exact continuation paths:

- `src/components/pharmacy/counter/counter-console.tsx`
- `src/lib/pharmacy/counter-query-refresh.ts`
- `src/lib/pharmacy/counter-query-refresh.test.ts`
- `src/lib/pharmacy/COUNTER-PRINTING.md`

Verification commands:

```sh
bun run test -- src/lib/pharmacy/counter-query-refresh.test.ts
# exit 0; 1 file, 3 passed, 0 failed, 0 skipped
bunx eslint src/lib/pharmacy/counter-query-refresh.ts src/lib/pharmacy/counter-query-refresh.test.ts src/components/pharmacy/counter/counter-console.tsx
# no diagnostics
bunx prettier --check src/lib/pharmacy/counter-query-refresh.ts src/lib/pharmacy/counter-query-refresh.test.ts src/components/pharmacy/counter/counter-console.tsx
# All matched files use Prettier code style!
bunx tsc --noEmit --project "$PAPERCLIP_RUN_SCRATCH_DIR/tsconfig.counter-refresh.json"
# no diagnostics
git diff --check
# exit 0
```

Recreate the scoped TypeScript config with the earlier Python recipe, replacing `files` with
the three continuation TS/TSX paths plus `src/types/next-auth.d.ts` and `vitest.setup.ts`, and
the target filename with `tsconfig.counter-refresh.json`. No compiler options changed.
Prettier `--write` ran on the same three paths before verification (exit 0).

Tests use installed QueryClient/QueryObserver with controlled promises. Both old-response
completion orders preserve the persisted line; settled cached carts also refresh. No server,
browser or physical device was used. Prior 34 receipt tests are unchanged evidence, not rerun.
Scoped diff inspection found no shared-lane changes. No independent reviewer was launched.
Claude-Mem/graph/Ponytail tools unavailable; narrow source fallback used without setup repair.
Bundled Next use-client guide and full Studio contract read; no visual geometry changed.

Remaining: the same four acceptance groups above, plus staging POS-09 cart/alert/refused-tender
verification by WHA-1351 after board-approved composition/push. Unit tests do not replace it.
WHA-1354 owns saved-layout/settings contract, WHA-1355 Restaurant composition, WHA-1356/1360
transport/queue scope; board owns source-policy decisions and staging/hardware authorization.
Overall issue remains blocked on those owners/actions. Rollback this continuation commit only;
no database or schema changes. Final private SHA is recorded in the issue comment.
