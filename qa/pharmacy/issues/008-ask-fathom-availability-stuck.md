[QA][Pharmacy][SEV3] Ask Fathom stays on “availability is being checked”
Labels: qa, pharmacy, sev3-minor, ux

## Environment

- Branch: `qa/pharmacy-restaurants-agencies`
- Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`
- Date: 2026-10-21
- Tenants: `qa-clifton.localhost` (Pharmacy Professional, Ask Fathom saved as on) and `qa-rival.localhost` (Pharmacy Essentials)
- Users: `owner@qa-clifton.test`, `owner@qa-rival.test`

## Test case

PH-UX-02

## Steps

1. Sign in to Clifton and open `/pharmacy/counter/close`, `/pharmacy/purchasing`, and `/pharmacy/orders`.
2. On `/organization`, read Ask Fathom chat. The saved setting says chat is on.
3. Sign in to Rival and open `/pharmacy/inventory`.

## Expected

Ask Fathom either opens or shows a finished unavailable state (disabled, unlicensed, or a named error). It does not sit on a checking message across pages and tenants.

## Actual

The sidebar line is “Ask Fathom chat availability is being checked. Try again shortly.” on:

- Clifton day close
- Clifton purchasing
- Clifton customer orders
- Rival inventory

The organization card says “Saved setting: chat on” and the control is “Enable Ask Fathom chat”. The checking line does not resolve on the pages above.

## Evidence

- `qa/pharmacy/evidence/fu-_pharmacy_counter_close.txt`
- `qa/pharmacy/evidence/fu-_pharmacy_purchasing.txt`
- `qa/pharmacy/evidence/fu-_pharmacy_orders.txt`
- `qa/pharmacy/evidence/fu-_organization.txt` (Ask Fathom chat card)
- `qa/pharmacy/evidence/mt-01-rival-inventory.txt`

## Suggested code area

Sidebar Ask Fathom status (`src/components/layout/sidebar.tsx` and the chat-availability query it calls).

No fix is proposed here.
