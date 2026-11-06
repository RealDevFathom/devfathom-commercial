[QA][Pharmacy][SEV2] Pharmacy owner cannot add a cashier or pharmacist in the workspace
Labels: qa, pharmacy, sev2-major, ux

## Environment

- Branch: `qa/pharmacy-restaurants-agencies`
- Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`
- Date: 2026-10-21
- Tenant: `http://qa-clifton.localhost:3000`
- User: `owner@qa-clifton.test`, organization administrator
- Package: Pharmacy Professional, seat limit 10, 1 seat occupied

## Test cases

PH-UR-01, PH-UR-02

## Steps

1. Sign in as the pharmacy owner.
2. Open `/team`.
3. Open `/organization` and read People and access, including the expanded owner row and Custom roles.

## Expected

The owner can add a cashier and a pharmacist, assign the pharmacy role template, and set a pharmacy department, without using the platform control desk. `/team` is either that surface or it points at it.

## Actual

`/team` renders “This module is not enabled” and names the `hr` module. The pharmacy package does not include HR. The link offered is “Open organization settings”.

`/organization` lists the one bootstrap user and can update that user’s system role, status, custom role, title, and password. There is no invite, add person, or add staff control on the page. `organization-admin-content.tsx` has no invite action.

The department select on the existing member is the agency list: LEADERSHIP, ENGINEERING, PRODUCT, QUALITY, MARKETING, DESIGN. There is no pharmacy, dispensary, or counter department.

Custom roles can be created, and the pharmacy templates are already installed, but they have no second member to attach to. Role isolation (cashier versus admin) could not be executed because the owner cannot create the user.

## Evidence

- `qa/pharmacy/evidence/fu-_team.txt`
- `qa/pharmacy/evidence/fu-_team.png`
- `qa/pharmacy/evidence/fu-_organization.txt`
- `qa/pharmacy/evidence/fu-_organization.png`

## Suggested code area

- `src/app/(app)/team/` module gate (`hr`)
- `src/app/(app)/organization/organization-admin-content.tsx` people card and department options
- Platform `organization.user` remains a control-desk action; this issue is the tenant workspace

No fix is proposed here.
