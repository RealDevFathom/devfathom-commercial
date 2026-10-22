# Issue #293 — already fixed on `main`

Verified on 2026-10-22 against `main` at `16a2a3705a0bdd287f09ef4d1a42c0ac7cbbb4ca`.

The reported Goods-in access checkbox is not present in the current organization administration
surface. In particular, `src/app/(app)/organization/organization-admin-content.tsx` contains no
`defaultChecked` input and no Goods-in or procurement grant control, so the stale uncontrolled
checkbox state described in the issue cannot be reproduced on `main`.

The only checkbox in the People and access section is the unchecked branch selector used while
adding a staff member. It is reset only after a successful create-member mutation and is unrelated
to per-staff procurement grants.

Static verification commands (no tests were run, as requested):

```text
git branch --show-current
rg -n "defaultChecked|Goods-in|goods-in|procurement" src/app/\(app\)/organization/organization-admin-content.tsx
rg -n 'type="checkbox"' src/app/\(app\)/organization/organization-admin-content.tsx
```

The first command reported `main`; the second reported no matches; and the third reported the
new-staff branch selector plus the unrelated primary-domain checkbox. Neither checkbox has a
checked default or represents a per-staff procurement grant.
