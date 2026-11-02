# UI run log excerpts (step-runner output)

Captured on 2026-11-02 (PKT) from the console output of `qa/sehatcart-2026-11-02/harness/steps.mjs` during the live runs. After each step the runner prints the alert and status texts visible on the page (`alerts`) and every HTTP response with status ≥ 400 and its time (`HTTP-ERRORS`). These outputs were not written to files at the time; the excerpts below are copied verbatim from the session log (URLs shortened to the procedure path, field inputs omitted).

## 1. Unassigned cashier adds a line (report finding 1; #1227)

Steps: Counter → search "panadol" → quantity 2 → Add to cart, as qa.cashier before any branch assignment. Screenshot: `qa-evidence/cash-sale-cart2.png`.

Runner output logged at 2026-11-02T18:16:46.965Z (UTC).

Alerts on the page:

- SUCCESS 2 × Paracetamol 500mg Tablets added.
- CANONICAL UNITS 20 UNIT PRICE 25.00 PRO-RATA CEILING 25.00 LINE TOTAL 50.00 COVERED · 100 UNITS ON HAND
- Branch is outside your scope. Retry
- The bill balance could not be verified. Retry the bill read before taking payment.
- This bill could not be read. Check your access and refresh this bill before taking payment.
- Focus scan and search: F2

HTTP errors:

- `403 GET /api/trpc/pharmacySales.counterCart → "Branch is outside your scope." at 2026-11-02 23:16:43 PKT`

## 2a. Cash payment on a counter with no open drawer (report finding 15; #1254)

Steps: Add 2 strips, enter cash, Take payment, as qa.cashier.

Runner output logged at 2026-11-02T18:19:40.191Z (UTC).

Alerts on the page:

- SUCCESS 2 × Paracetamol 500mg Tablets added.
- CANONICAL UNITS 20 UNIT PRICE 25.00 PRO-RATA CEILING 25.00 LINE TOTAL 50.00 COVERED · 30 UNITS ON HAND
- Payment was not accepted. Open the cash drawer for this counter before taking a payment.
- Refresh this bill to verify its current state.
- Focus scan and search: F2

HTTP errors:

- `400 POST /api/trpc/pharmacySales.tender → "DRAWER_NOT_OPEN" at 2026-11-02 23:19:23 PKT`

## 3. Short-by message while all 100 units were on the shelf (report finding 2; #1242)

Steps: Search "panadol", quantity 2, as qa.cashier after six bills had been abandoned (three by unassigned staff, three lost to reloads).

Runner output logged at 2026-11-02T18:20:36.167Z (UTC).

Alerts on the page:

- CANONICAL UNITS 20 UNIT PRICE 25.00 PRO-RATA CEILING 25.00 LINE TOTAL 50.00 SHORT BY 10 UNITS Only 10 safe units are on hand. Reduce the quantity or capture the shortfall as unfulfilled demand.
- SHORT BY 10 UNITS Only 10 safe units are on hand. Reduce the quantity or capture the shortfall as unfulfilled demand.
- Open a bill before taking payment.
- Focus scan and search: F2

## 2b. Second cash payment with no open drawer (report finding 15; #1254)

Steps: Same steps on a new browser profile (a new counter device).

Runner output logged at 2026-11-02T18:22:28.753Z (UTC).

Alerts on the page:

- SUCCESS 2 × Paracetamol 500mg Tablets added.
- CANONICAL UNITS 20 UNIT PRICE 25.00 PRO-RATA CEILING 25.00 LINE TOTAL 50.00 COVERED · 40 UNITS ON HAND
- Payment was not accepted. Open the cash drawer for this counter before taking a payment.
- Change 50.00
- Refresh this bill to verify its current state.
- Focus scan and search: F2

HTTP errors:

- `400 POST /api/trpc/pharmacySales.tender → "DRAWER_NOT_OPEN" at 2026-11-02 23:22:24 PKT`

## 4. Cashier adds a prescription-only medicine (report finding 3; #1245)

Steps: Add QA Amoxicillin 500mg (rx: true) as qa.cashier.

Runner output logged at 2026-11-02T18:28:04.200Z (UTC).

Alerts on the page:

- DANGER Selling a prescription-only or restricted medicine needs the pharmacist dispensing permission.
- CANONICAL UNITS 10 UNIT PRICE 300.00 PRO-RATA CEILING 300.00 LINE TOTAL 300.00 COVERED · 200 UNITS ON HAND
- This bill is not available for payment.
- Focus scan and search: F2

HTTP errors:

- `403 POST /api/trpc/pharmacySales.addLine → "Selling a prescription-only or restricted medicine needs the pharmacist dispensing permission." at 2026-11-02 23:28:01 PKT`

## 5. Pharmacist adds the prescription-only medicine (report finding 3; #1245)

Steps: Add QA Amoxicillin 500mg as qa.pharmacist. Screenshot: `qa-evidence/pharm-rx-add.png` (the BLOCKED alert is in the prescription panel below the visible area).

Runner output logged at 2026-11-02T18:28:45.289Z (UTC).

Alerts on the page:

- SUCCESS 1 × QA Amoxicillin 500mg Capsules added.
- CANONICAL UNITS 10 UNIT PRICE 300.00 PRO-RATA CEILING 300.00 LINE TOTAL 300.00 COVERED · 200 UNITS ON HAND
- This bill carries an unresolved safety block. Resolve it in the prescription panel before taking payment.
- No independent pharmacist with an active staff PIN is available. Ask your administrator to configure one.
- BLOCKED QA Amoxicillin 500mg Capsules requires a prescription before it can be dispensed. Attach a captured prescription and have a pharmacist verify it.
- Focus scan and search: F2

## 6. Payment after the day was closed at 23:48 (report finding 12; #1251)

Steps: Add 1 strip and take cash as qa.cashier. Screenshot: `qa-evidence/cash-after-close-pay.png`.

Runner output logged at 2026-11-02T18:49:07.243Z (UTC).

Alerts on the page:

- SUCCESS 1 × Paracetamol 500mg Tablets added.
- CANONICAL UNITS 10 UNIT PRICE 26.00 PRO-RATA CEILING 26.00 LINE TOTAL 26.00 COVERED · 590 UNITS ON HAND
- Payment was not accepted. This business day is closed. New payments and drawer changes are blocked. Use an open business day.
- Change 4.00
- Refresh this bill to verify its current state.
- COMMERCIALParacetamol 500mg Tablets dispenses from a batch expiring in 74 day(s).
- Focus scan and search: F2

## 7. Goods-in lists the duplicate pack twice (report finding 20; #1259)

Steps: as qa.manager (Procurement), open Goods-in (`/pharmacy/purchasing/receiving`) after the second identical STRIP = 10 pack was created at 23:11 PKT. The runner maps each form control with its options.

Runner output logged at 2026-11-02T18:13:19.898Z (UTC).

Options of the "Line 1 — medicine and pack" select in _Direct purchase — no purchase order_:

- Skip this line
- Amoxicillin 250mg Capsules — BOX (1 BOX = 100 units)
- Amoxicillin 250mg Capsules — STRIP (1 STRIP = 10 units)
- Amoxicillin 250mg Capsules — UNIT (1 unit)
- Paracetamol 500mg Tablets — STRIP (1 STRIP = 10 units)
- Paracetamol 500mg Tablets — STRIP (1 STRIP = 10 units)
- QA-20261102-FUNC-QA tablets — STRIP (1 STRIP = 10 units)
