# Pharmacy operating mode verification

Validated the merged #683 PIN, enrollment, branch authorization and procurement paths with the operating mode feature on a fresh, fully migrated local PostgreSQL database.

- Pharmacy PIN enrollment and current-PIN-authenticated rotation work without Restaurant Core. Rotation rejects the old secret, preserves one active credential, and omits PINs from audit input.
- SOLO availability uses the shared pharmacy eligibility check. Independent authorized approvals continue to work when SOLO self-approval is unavailable.
- Returns and refunds submit fresh approval PINs and the STAFFED checker identity. Recovery retains the operation reference but never saves the PIN.
- Write-offs expose the independent witness PIN in STAFFED mode.
- All shared checker kinds and controlled purchase, sale, correction and restoration witnesses enforce branch access before approving.
- Procurement, PV, inventory, supplier-credit and migration fixtures persist their intended mode, role and branch assignments. Standalone 10-unit BOX and STRIP conversions retain their frozen conversion checks.

Verification:

| Gate | Result |
| --- | --- |
| Unit tests | 201 suites, 2,991 passed; 22 additional focused checks passed |
| Changed DB suites plus controlled receiving | 26 suites, 287 passed, no skips |
| Purchasing Playwright | 7 passed, including PIN enrollment and rotation |
| Lint | Zero errors and warnings |
| Production build | Passed with webpack, including TypeScript |
| Diff whitespace | Clean against develop, including printing target |

The database authorization suites use a restricted runtime role. The provisioning seed smoke test uses the dedicated local provisioning connection for its explicitly unscoped fixture inspection.

Visual QA covered PIN enrollment plus SOLO and STAFFED inventory write-offs and return/refund dialogs at 375, 768, 1024 and 1440 pixels, light/dark themes, and normal/reduced motion. Screenshots were captured. Checks passed for document overflow, visible PIN controls, keyboard focus, dialog Escape/focus restoration, offline disabled states, enrollment loading/validation/saving states, empty return history and clean browser consoles. Existing component tests cover mutation errors, ambiguous retries and permission refusals. Shared Studio components, tokens and shells remain the UI foundation.

## PR #734 review follow-up

- SOLO approvals now require the action's capability before PIN verification; stored role and user DENYs remain authoritative for every approval kind.
- Pharmacy system managers receive counter and inventory grants through the template and an additive migration. Replaying the migration preserves DENYs and leaves custom roles and other verticals untouched.
- An independently authenticated pharmacist can authorize a cashier's Rx line and prescription reference. Transactional evidence binds the approval to the cashier, sale, line, medicine, presentation and quantity. Payment and completion recheck the pharmacist's live permission, role and branch assignment; prescription fills name the pharmacist.
- An incorrect operating-mode PIN returns a local forbidden error and keeps the valid browser session in Settings. Operating mode is linked through the shared Studio navigation.
- FEFO, refund-cap, operating-mode and stock-ledger fixtures include the stored grants required to reach their original assertions.

Focused verification passed for the operating-mode policy and API, navigation, settings component, role catalog, Rx approval, FEFO override and refund-cap unit suites. PostgreSQL checks passed for operating mode, stock ledger, Rx sale gates, prescription references and the capability migration, using restricted runtime roles and a separate migration-test role. No full suite, build, typecheck, lint or Prisma migration command was run in this follow-up.

Browser checks covered 375, 768, 1024 and 1440 pixels, light/dark themes and normal/reduced motion. The new link is reachable, has the active-page state and a keyboard focus indicator, and introduces no document overflow. Screenshots were captured. A real incorrect-PIN submission stayed in Settings and the session remained usable after reload, with no page errors. The unchanged mobile shell closes on Escape but does not restore focus to its opener; this pre-existing shell limitation is outside these review fixes.

## PR #734 second review follow-up

- The operating-mode migrations are renamed to `20261101000100_*` and `20261101000200_*` so they sort after every #683 and develop migration. They no longer redefine `pharmacy_solo_owner_eligible`, so applying them after #683 cannot drop the "exactly one active user" rule. SOLO mode is still enforced by `soloOwnerEligible` and the `pharmacy_solo_mode_audit` triggers.
- #683's `20261101000000_pharmacy_solo_roster_advisory_lock` is included unchanged (same name, so it is never applied twice). Roster writes take a shared per-tenant advisory lock instead of locking and rewriting the organization row. SOLO approvals take the organization row and the exclusive roster lock. STAFFED approvals take neither, because the independent-checker rule holds in either mode, so counters no longer serialize on one tenant row.
- Rx eligibility uses the live `pharmacy:dispense` grant instead of the `pharmacist` role key, at approval, at payment recheck, and in the approver list. A dispense holder may approve their own STAFFED Rx line, as before operating modes. Cashiers still need an independent dispense holder with a PIN.
- First PIN enrollment requires the account password. It is rate-limited and never audited.
- Delegated checker PINs are throttled per requester and checker (3 per 15 minutes), below the checker's own 5-attempt window.
- `scripts/seed-demo-pharmacies.ts` refuses `DEPLOY_ENV=production`, `NODE_ENV=production` without `DEPLOY_ENV=staging`, and production-named database hosts or names.
- New database suites skip without `DATABASE_URL`, like the other database suites. The demo-seed suite reads fixtures inside the same RLS context the seed uses.
