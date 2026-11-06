[QA][Pharmacy][SEV2] Owner command centre shows financials as restricted and prints raw metric keys
Labels: qa, pharmacy, sev2-major, ux

## Environment

- Branch: `qa/pharmacy-restaurants-agencies`
- Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`
- Date: 2026-10-21
- Tenant: `http://qa-clifton.localhost:3000/dashboard`
- User: `owner@qa-clifton.test`, organization administrator, `ALLOW *`, `User.role=ADMIN`
- Branch that exists: Clifton Chemist (Karachi). Inventory, expiry, purchasing, and `/pharmacy/reports` all list it.

## Test cases

PH-ON-03, PH-RP-01, PH-UX-02

PH-ON-03 also expected a first-run checklist on `/dashboard` (branch and staff done, catalog, opening stock, and first sale still pending, with links to pharmacy routes). The page that rendered is the owner command centre. The twelve-step checklist is on `/pharmacy`, not on this dashboard.

## Steps

1. Sign in on `qa-clifton.localhost`. The session lands on `/dashboard`.
2. Read the owner command centre after `DOMContentLoaded`.
3. Open `/pharmacy/reports` in the same session and read the branch filter.

## Expected

The administrator who holds `ALLOW *` sees today’s trade and claims, or an explicit loading state while the command centre is still reading. Empty figures say they are empty. Metric names are the catalog labels. The branch filter lists Clifton Chemist. Copy does not say a reportable branch is missing while that branch exists.

## Actual

`qa/pharmacy/evidence/fu-_dashboard.png` shows:

- Branch filter: “All available” only.
- “Waiting for a reportable branch.”
- Today’s trade: RESTRICTED, “reports:financial is required. No protected values are shown.”
- Claims & aging: the same restriction.
- Stock, expiry, recalls, pharmacist coverage, and operational exceptions render raw keys (`OPENSTOCKSIGNALS`, `EXPIRYVALUEMINOR30`, `OPENRECALLS`, `PHARMACISTCOVERAGE`, `OPENRECEIVINGEXCEPTIONS`, and the other unspaced keys) with the value “—” and the subtitle “Not available in this release”.
- Branch comparison: “BRANCHES IN SCOPE 0”.

The same session’s reports page lists **Clifton Chemist** in the branch filter (`qa/pharmacy/evidence/fu-_pharmacy_reports.txt`).

`WidgetState` in `pharmacy-dashboard-content.tsx` treats a command-centre query with no `permissions.financial` as a permission denial, including when `query.data` is still absent. The command query is enabled only after `branches.data.branches.length` is truthy, and a disabled query is not `isLoading`, so the grid renders the denial and the raw keys instead of the loading skeleton. The header uses “Waiting for a reportable branch.” whenever `command.data` is absent. Catalog labels are replaced by the raw metric key when the catalog has not arrived (`contract?.label ?? item.metrics[index]`).

The settled command-centre response was not captured; the browser run later stalled. The screenshot is the frame the operator gets before that response, and that frame tells the owner they lack `reports:financial`.

## Evidence

- `qa/pharmacy/evidence/fu-_dashboard.png`
- `qa/pharmacy/evidence/fu-_dashboard.txt`
- `qa/pharmacy/evidence/fu-_pharmacy_reports.txt`
- `qa/pharmacy/evidence/fu-_pharmacy_reports.png`

## Suggested code area

- `src/app/(app)/dashboard/pharmacy-dashboard-content.tsx` (`WidgetState`, command query `enabled`, header copy)
- `src/server/routers/pharmacy-reports.ts` `commandCentre` / `catalog` `permissions.financial`
- `src/lib/abac/index.ts` `can()` for `reports:financial` (empty static policy; decision is the custom grant)

No fix is proposed here.
