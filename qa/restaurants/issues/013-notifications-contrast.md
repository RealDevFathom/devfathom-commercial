[QA][Restaurants][SEV3] Notifications page has a serious color-contrast violation
Labels: qa, restaurants, sev3-minor, a11y

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12. Tenant `http://qa-karahi-house.localhost:3000/restaurant/notifications`, signed in as the restaurant administrator. axe-core rules `wcag2a` and `wcag2aa`. Executed 2026-10-21.

## Test case

A11Y-01. Only the notifications page was scanned. Dashboard, catalog, orders, and the register were not part of this run.

## Steps

1. Sign in on the restaurant tenant and open `/restaurant/notifications`.
2. Run axe with tags `wcag2a` and `wcag2aa`.

## Expected

No serious or critical WCAG 2.0 A/AA violations on the notifications page.

## Actual

One serious `color-contrast` violation on one node: "Elements must meet minimum color contrast ratio thresholds." No other impact levels were recorded for this page.

Closed issue #71 tracked dark-theme contrast across a broad set of screens. This is a remaining instance on the restaurant notifications page, not a refile of that closed issue.

## Evidence

- `qa/restaurants/evidence/axe-notifications.json` (`color-contrast`, impact `serious`, `nodes` 1).
- `qa/restaurants/evidence/a11y-notifications.png`.

## Suspected code

The notifications page styles that use the shared color tokens. The failing node is the single contrast hit in the axe JSON. No fix is proposed here.
