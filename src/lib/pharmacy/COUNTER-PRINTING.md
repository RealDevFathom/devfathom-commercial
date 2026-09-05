# WHA-1358 Pharmacy browser printing evidence

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
3. Chief of Staff: resolve/assign immutable receipt-source and POS access-policy prerequisites;
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
