[QA][Restaurants][SEV3] Menu import is not linked from restaurant navigation
Labels: qa, restaurants, sev3-minor, ux

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12, PostgreSQL 16. Tenant `http://qa-karahi-house.localhost:3000`, signed in as the restaurant administrator (Ayesha Khan). Executed 2026-10-21.

## Test case

MNU-04.

## Steps

1. Sign in on the restaurant tenant.
2. Read the restaurant sidebar from Dashboard through Settings.
3. Open `http://qa-karahi-house.localhost:3000/restaurant/menu-import` directly.

## Expected

Menu import is a labeled item in restaurant navigation, and that item opens the upload console.

## Actual

The direct URL returns HTTP 200 and renders the menu-import upload console. The sidebar has no Menu import link. An administrator who does not already know the path cannot reach the tool. The rest of the restaurant nav (catalog, menus, floor, orders, and settings) is present.

## Evidence

- `qa/restaurants/evidence/house-menu-import.png` (upload console at the direct URL).
- Sidebar markup in `src/components/layout/sidebar.tsx` has no `menu-import` entry.

## Suspected code

`src/components/layout/sidebar.tsx`. No fix is proposed here.
