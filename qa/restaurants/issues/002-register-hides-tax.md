[QA][Restaurants][SEV1] Register summary omits tax and then shows nothing due while the bill stays open
Labels: qa, restaurants, sev1-critical

## Environment

Local VM. Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Bun 1.4.3, Next.js 16.2.12, PostgreSQL 16. Tenant `http://qa-karahi-house.localhost:3000`, organization QA Karahi House (`cmvhhcld5000g1yjsl1lp4a8v`), branch Clifton, business date 2026-10-21. Currency PKR. A custom Sindh profile was published before the tenders below: profile `cmvhkzf29003ichjsr73y6s70`, status PUBLISHED, effective 2026-10-01 00:00 Asia/Karachi, jurisdiction PK-SD, CASH/CARD/OTHER 15% exclusive, approval reference marked customer-supplied and not verified. Executed 2026-10-21.

## Test case

PAY-01 and PAY-03.

## Steps

1. Publish the 15% exclusive profile, then open a dine-in order, add Chicken Karahi (970.00), fire it, and cut the bill.
2. `GET /api/restaurant/checkout/summary?orderId=cmvhkt52y001cchjsuh40tmvw` before any tender.
3. Open a drawer on the enrolled register and tender cash of exactly the summary amount, 970.00, with cash received 5000.00.
4. Read the summary again, then tender the summary's new `remainingDue`.
5. Tender cash of 145.50 (the remainder the first tender returned) with cash received 200.00.
6. Separately, open a takeaway Garlic Naan (120.00), cut the bill, and tender card 120.00 plus tip 20.00.

## Expected

The summary discloses tax before the cashier collects money. The amount it shows as due is the amount that settles the bill. After a full tender the bill is settled, a receipt number is issued, and a later summary does not say 0.00 due while the bill is still open. A card sale of the menu price plus a tip either settles or shows the tax remainder before the card is charged.

## Actual

Before any tender the summary reported `grandTotal` 970.00 and `remainingDue` 970.00 and did not disclose tax. The cash tender of 970.00 returned HTTP 200 with `changeGiven` 4030.00, `settled` false, and `remainingDue` 145.50 (15% of 970). The bill stayed OPEN and the stored `taxTotal` was 0.00.

The summary after that partial tender reported `remainingDue` "0.00" while `settled` was false, `blocker` was `BILLS_OPEN`, and the bill status was OPEN. A follow-up tender of that displayed amount returned HTTP 400 "A tender amount must be positive."

An explicit cash tender of 145.50 then settled the bill: `settled` true, `receiptNumber` 1, `remainingDue` 0.00. Tender `cmvhl2h6d0086chjsvphdjk9v`, bill `cmvhkt5ds0027chjsijqnsxuk`, drawer `cmvhl2h4y0083chjsjh85r62z`.

The card takeaway behaved the same way. Summary `remainingDue` was 120.00. Card tender 120.00 plus tip 20.00 returned HTTP 200, `settled` false, `remainingDue` 18.00. Tender `cmvhkzgtr004mchjsxn4713ro`, payment `cmvhkzgtn004kchjsizsuu7nr`, bill `cmvhkzgrp004hchjs0bg2q17v`. That tax remainder was left open. The register read model and the tender quote disagree, so a cashier who collects the displayed total undercharges by the tax.

## Evidence

- `qa/restaurants/evidence/pos-settle.json` (`PAY-03` cash 970.00 leaving 145.50; card 120.00 leaving 18.00).
- `qa/restaurants/evidence/pos-finish.json` (`summary-after-partial` remainingDue 0.00 with `BILLS_OPEN`; `PAY-03b` HTTP 400 "A tender amount must be positive.").
- `qa/restaurants/evidence/pos-coauth.json` (`PAY-03c` cash 145.50, settled true, receipt 1).

## Suspected code

`GET /api/restaurant/checkout/summary` serialization in `src/lib/restaurant/checkout-routes.ts` versus `quoteTaxSettlement` inside `loadSettlementContext` in `src/lib/restaurant/tenders.ts`. The summary appears to report the stored bill total and does not include the live tax quote that tender recomputes. No fix is proposed here.
