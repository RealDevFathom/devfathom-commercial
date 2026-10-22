# Menu-import static-gap follow-up — 2026-10-22

## Verification and issue exclusion

The requested scope is the three highest-ranked **High/Medium** findings in
`docs/rgap-restaurant-menu-import-20261022.md` (findings 3, 4, and 5). Each was still present in the
current branch before this change:

1. The selected import detail and summary queries did not poll, so asynchronous extraction could
   leave the open console stale.
2. `EXTRACTION_FAILED` had no domain/router requeue operation or console action.
3. The review queue hid ingredients, variants, modifiers, and field confidence; commit consumed the
   unreviewed extracted variants.

No finding was already fixed, so none was skipped. No matching entry exists in the repository's
local issue registries (`TICKETS.md`, `BUGS.md`, `ENHANCEMENTS.md`, `IMPROVEMENTS.md`, or `.github/`).
A remote-only open GitHub issue could not be excluded because this checkout has no Git remote and
`gh auth status` reports no authenticated GitHub host. Therefore no finding was skipped as covered
by an open issue; this limitation is recorded rather than assuming that an unseen remote issue does
or does not exist.

## Changes

- Finding 3: the detail query now polls every two seconds only while an import is initially loading,
  pending extraction, or extracting, and stops in terminal/review states
  (`src/components/restaurant/menu-import/menu-import-console.tsx:299-308`).
- Finding 4: a capability-gated retry mutation was added to the existing `menu:import` router and is
  audited (`src/server/routers/restaurant-menu-import.ts:223-241`). The domain operation accepts only
  `EXTRACTION_FAILED`, requires a retained source, uses tenant-scoped reads/writes and enqueueing, and
  compare-and-sets the state so concurrent retries fail closed
  (`src/lib/restaurant/menu-import.ts:850-913`). The console exposes Retry extraction only for that
  failed state and resumes polling after requeue
  (`src/components/restaurant/menu-import/menu-import-console.tsx:368-376`,
  `src/components/restaurant/menu-import/menu-import-console.tsx:740-760`).
- Finding 5: review rows now show ingredients, variants, modifier-group count, and per-field
  confidence (`src/components/restaurant/menu-import/menu-import-console.tsx:858-886`). The editor
  supports correcting or removing individual variants before acceptance
  (`src/components/restaurant/menu-import/menu-import-console.tsx:1143-1201`). Reviewer-approved
  variants are stored separately from extraction evidence and are the only variant set used by
  commit when present (`prisma/schema.prisma:9856-9864`,
  `src/lib/restaurant/menu-import.ts:622-634`, `src/lib/restaurant/menu-import.ts:1040-1049`,
  `src/lib/restaurant/menu-import.ts:1082-1094`).

## Preserved invariants

All new server entry points retain the central `capabilityProcedure('menu:import')` gate. No
authorization allow-list or precedence logic was added, so the existing central `can()` and
DENY-over-ALLOW behavior remains authoritative. All retry and review persistence uses `ScopedDb`;
there is no unscoped organization or branch lookup. Commit continues to create only draft catalog,
menu, and pricing records and does not publish to a branch.

Per request, this was a code-only pass: no dependency installation, tests, typecheck, lint, build,
or browser/screenshot run was performed.
