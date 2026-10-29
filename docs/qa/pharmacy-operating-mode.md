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
