# QA report — SehatCart pharmacy tenant on develop

| | |
|---|---|
| Environment | `https://sehatcart.pharmacy.develop.devfathom.com` (develop deploy). Code references are to repo `develop` @ `47518cb`. |
| Test window | 2026-11-02, 22:55 – 23:55 PKT (UTC+5). All times below are PKT. |
| Accounts | qa.owner@example.com (Owner / Operator, tenant ADMIN) · qa.cashier@example.com (Cashier) · qa.manager@example.com (Procurement) · qa.pharmacist@example.com (Pharmacist + `pharmacy:safety` override) |
| Method | Live UI driven with Playwright (desktop 1440, tablet 768, phone 375, light/dark), direct tRPC calls as each role, axe-core scans, and code reading to confirm root causes. Harness and raw API evidence: `qa/sehatcart-2026-11-02/`. |
| Duplicate check | Every finding was checked against all 582 GitHub issues (open and closed) on 2026-11-02. New findings say "none found"; known problems are listed in [Existing issues re-verified](#existing-issues-re-verified-on-this-build) instead of being re-filed. |

## Test context and caveats

- **Single-branch tenant, not activated.** One branch (`MAIN`, Lahore). Onboarding shows 7/12 steps, activation BLOCKED. Selling still works, which open #623 already reports.
- **Another tester was active on the same tenant and the same QA Cashier account** (objects named `QA-20261102-FUNC-*`, `QA-20261102-CASHCHECK-*`). Their sales and refunds appear in drawers, receipts and report totals.
- **AI is switched off on develop.** `AI_PROVIDER` is not set, so Ask Fathom returns 503 and AI growth insights are unavailable (open #1159/#1199). AI accuracy could not be tested live (see [Not tested](#areas-not-tested-or-only-partly-tested)).
- **Changes QA made to the tenant:**
  - Assigned QA Cashier and QA Pharmacist to branch MAIN, about 23:20.
  - Created suppliers, POs, goods receipts, medicines (QA Amoxicillin, QA-RBAC Azithromycin), batches QA-B2…B5, sales, a return/refund, a write-off and a recall (closed again).
  - **Closed business day 2026-11-02 at 23:48** with a deliberate −4.00 variance.
- Severity scale used: **Sev1** security, data loss, money wrong or blocks selling · **Sev2** major feature broken · **Sev3** minor bug or misleading UX · **Sev4** polish.

Evidence paths: screenshots in `qa-evidence/`, raw API responses in `qa/sehatcart-2026-11-02/api-evidence/`, static authorization table in `qa/sehatcart-2026-11-02/rbac-static.tsv`.

---

## New findings

### [Sev1] Counter: staff without a branch assignment can start a bill and reserve stock, but can never pay, void or even see it

- **Severity:** Sev1. Blocks selling and leaks stock.
- **Role and account:** Cashier (qa.cashier) and Pharmacist (qa.pharmacist) before they were assigned to a branch. This is the tenant's starting state: `pharmacyBranchAssignments.list` returned `assignments: []`.
- **Steps:**
  1. As the owner, leave staff unassigned (Settings → Branch assignments is never part of onboarding).
  2. As the cashier, open Counter, search "panadol", pick the result, quantity 2, click **Add to cart (F6)**.
- **Expected:** Either the cashier is told up front "You are not assigned to this branch — ask the owner", or the sale works end to end.
- **Actual:**
  - The green toast "SUCCESS 2 × Paracetamol 500mg Tablets added." appears and the line is saved, which **reserves 20 units**.
  - The next read, `pharmacySales.counterCart`, returns **403 "Branch is outside your scope."** (23:16:43).
  - The screen then shows "BILL OPEN · 0 LINES", "Balance due Unavailable", "This bill could not be read. Check your access and refresh this bill before taking payment."
  - Take payment stays disabled. Void and hold use the same guard, so the cashier can't release the bill either.
- **Evidence:** `qa-evidence/cash-sale-cart2.png`; `api-evidence/rbac-sale.json`. Code:
  - `create` and `addLine` only call `scopeFor` (branch exists in the org) — `src/server/routers/pharmacy-sales.ts:162-168`, `:967-973`, `:974+`.
  - `counterCart`, `tender` and `transition` use `requireCounterReceiptAccess`, which requires an active branch assignment for non-admins — `pharmacy-sales.ts:381-481`, `:1364-1400`, `:1815-1825`.
- **Duplicate check:** none found for this behaviour. The same root cause sits under closed #509 (next-but-two entry).
- **Suggested fix:**
  - Apply one authorization helper to every counter procedure: create, addLine, cart, tender, transition.
  - Refuse to open a bill when the user has no assignment, with a message naming the remedy.
  - Add "assign staff to branches" as an onboarding step, and warn the owner on the Team page when an active member has no branch.

### [Sev1] Counter/stock: abandoned bills keep their stock reserved forever (reload, closed tab, failed payment, blocked Rx line, closed day)

- **Severity:** Sev1. Data integrity; stock silently disappears from sale.
- **Role and account:** Cashier (qa.cashier); also reproduced with the pharmacist and owner.
- **Steps:**
  1. Receive 100 units (batch QA-B1).
  2. As the cashier, add 2 strips to a bill, then reload the page, or let a payment fail (e.g. `DRAWER_NOT_OPEN`), or add an Rx item that is then blocked.
  3. Search the medicine again.
- **Expected:** An abandoned bill is restored on reload, or listed somewhere it can be resumed or voided, or its reservation expires. Day close should at least warn about open bills.
- **Actual:**
  - The open bill lives only in React state, so a reload starts a fresh empty counter. The old bill stays OPEN in the database with its stock reserved.
  - Six abandoned bills (from 23:15–23:22) held 90 of 100 units. The counter then refused a 2-strip sale: **"SHORT BY 10 UNITS — Only 10 safe units are on hand"** while all 100 units were physically on the shelf.
  - No screen lists open or held bills. The owner could free only the three bills whose IDs QA knew from API responses (stock went 10 → 40 available).
  - **60 units of QA-B1 are still locked** in bills nobody can find.
  - Day close counts only COMPLETED sales and closes without mentioning open bills.
- **Evidence:** `qa-evidence/cash-sale6-pay1.png` (bill lost after failed payment), `api-evidence/rbac-sale.json` (on-hand 80 → 50 after three `addLine` calls). Code:
  - `const [saleId, setSaleId] = useState(initialSaleId)` — `src/components/pharmacy/counter/counter-console.tsx:309` (`initialSaleId` comes only from customer orders, `src/app/(app)/pharmacy/counter/page.tsx:13`).
  - Day close reads only `status: 'COMPLETED'` — `src/lib/pharmacy/day-close.ts:32`.
  - No stale-bill release job exists (searched `src/lib/pharmacy`, `src/server`, `scripts`).
- **Duplicate check:** **closed #420** ("browser reload drops the open bill from the screen, sale stays OPEN in the DB", Sev3) still reproduces. It is worse than filed, because the stock reservation leaks with the bill. Recommend reopening at Sev1.
- **Suggested fix:**
  - Persist the active bill per counter device and restore it on load.
  - Add an "Open and held bills" list (owner and assigned staff) with void.
  - Expire unpaid reservations after a configurable time.
  - Make day close list and require resolving open bills.

### [Sev1] Prescriptions: no prescriber or patient can be added, so no prescription-only medicine can ever be sold

- **Severity:** Sev1. Blocks selling every Rx medicine, the bulk of a pharmacy's turnover.
- **Role and account:** Pharmacist (qa.pharmacist); Owner (qa.owner).
- **Steps:**
  1. As the owner, create an Rx medicine (QA Amoxicillin 500mg, `rx: true`) and receive 200 capsules.
  2. As the pharmacist, add it at the counter.
  3. Open **Prescriptions** to capture the prescription.
- **Expected:** The pharmacist can register the patient and the prescribing doctor, capture the prescription, verify it and sell.
- **Actual:**
  - The counter blocks the line: **"BLOCKED QA Amoxicillin 500mg Capsules requires a prescription before it can be dispensed. Attach a captured prescription and have a pharmacist verify it."**
  - On Prescriptions, the required **Patient** and **Prescriber** dropdowns are empty, and there is no "add patient" or "add prescriber" control anywhere.
  - No application code creates a `PharmacyPrescriber`, and no UI calls `createPatient`. The block can't be resolved, so the line can only be removed. (The cashier is correctly refused with 403, 23:28:01.)
- **Evidence:** `qa-evidence/pharm-rx-add.png`, `qa-evidence/pharm-rx-page.png`. Code:
  - Capture requires `prescriberId` — `src/server/routers/pharmacy-prescriptions.ts:297`.
  - The block is raised for every `rx`/`controlled`/`restricted` line without a verified prescription — `src/lib/pharmacy/counter-alerts.ts:146-167`.
  - Model `PharmacyPrescriber` (`prisma/schema.prisma:12266`) is only ever read.
- **Duplicate check:** none for the root cause. Open #1039 reports the disabled Capture button as a copy problem; a copy fix will not unblock selling.
- **Suggested fix:**
  - Add patient and prescriber creation inline on Prescriptions and in the counter Rx panel (name, PMDC number optional, phone).
  - Allow a pharmacist to capture and verify in one step in single-pharmacist shops, with an audit trail.
  - Seed the prescriber list from the shop's own history.

### [Sev1] Security: any signed-in staff member can open sales and reserve stock (closed #509 still reproduces)

- **Severity:** Sev1 (security / stock integrity).
- **Role and account:** Procurement user (qa.manager, no counter permission); Pharmacist; Cashier.
- **Steps:** As each user, call `pharmacySales.create {branchId}` and then `pharmacySales.addLine` (1 strip) directly.
- **Expected:** 403 for users without `pharmacy:counter` (or dispensing) permission and a branch assignment.
- **Actual:** 200 for all three at 23:17:59–23:18:00. Each call reserved 10 units (on-hand 80 → 50). None of them can pay or void the bill afterwards (`counterCart` 403).
- **Evidence:** `api-evidence/rbac-sale.json`; code `src/server/routers/pharmacy-sales.ts:162-168` (`scopeFor`), `:967-973`.
- **Duplicate check:** **closed #509** ("sale create and addLine need no pharmacy:counter capability or branch assignment") still reproduces. Please reopen.
- **Suggested fix:** Use `requireCounterReceiptAccess(ctx, branchId, true)` in `create` and `addLine` (and in the other `scopeFor`-only sales procedures listed in `rbac-static.tsv`).

### [Sev1] Privacy: any staff member can export a patient's full record, unmasked phone included

- **Severity:** Sev1 (security / patient privacy).
- **Role and account:** Procurement user (qa.manager) and Cashier (qa.cashier).
- **Steps:**
  1. As the Procurement user, call `pharmacyPrescriptions.createPatient` (test patient), then `readPatient`.
  2. Call `exportPatient` as the Procurement user and as the cashier.
- **Expected:** Patient export restricted to pharmacist or owner (`pharmacy:prescriptions`) and masked like the read view.
- **Actual:** `readPatient` masks the phone (`*********4567`), but **`exportPatient` returns `"+923001234567"` in full** to both the Procurement user and the cashier (23:30:50). The export includes consents, prescriptions and fills.
- **Evidence:** `api-evidence/rbac2.json`. Code: `exportPatient: auditedProtectedProcedure` with no capability check — `src/server/routers/pharmacy-prescriptions.ts:407` (`readPatient` at `:393` is equally unguarded but masks).
- **Duplicate check:** none found. Related open #1036 covers the missing checks on `createPatient`/`recordConsent` only.
- **Suggested fix:** Gate `readPatient` and `exportPatient` behind `pharmacy:prescriptions` (and branch scope), apply the same masking in export, and log exports.

### [Sev2] Safety reporting: recording an adverse drug reaction fails with a server error (500) for every role

- **Severity:** Sev2. A major compliance feature is broken.
- **Role and account:** Owner, Pharmacist, Cashier.
- **Steps:** Call `pharmacyReports.createPharmacovigilanceReport` with `{branchId: MAIN, kind: "ADVERSE_DRUG_REACTION", occurredAt: now, assertedDescription: "QA probe - please ignore"}`.
- **Expected:** A draft pharmacovigilance report is created (pharmacist or owner only).
- **Actual:** **HTTP 500 `INTERNAL_SERVER_ERROR` "Something went wrong on our side. Please try again."** for all three roles at **2026-11-02 23:31:08**. The DRAP export (`exportPharmacovigilanceDrap`) works but returns `reports: []`.
- **Evidence:** `api-evidence/pv500.json`. Code: `src/server/routers/pharmacy-reports.ts:233-276` (plain `ctx.db.pharmacyPharmacovigilanceReport.create`). The server hides the real error (`src/server/trpc.ts:93-104`), so the cause needs the server log for that timestamp. A database constraint or row-level security failure on `pharmacy_pharmacovigilance_reports` is likely.
- **Duplicate check:** none found (open #517/#518 cover missing permission checks on these procedures, not a failure).
- **Suggested fix:** Pull the server log for 23:31:08 PKT, fix the insert, add an integration test against a real database, and restrict creation to pharmacist or owner (#517).

### [Sev2] Financial data: cashiers can read purchase cost per unit, stock value at risk and supplier credit terms

- **Severity:** Sev2 (internal confidentiality of margins; no customer data).
- **Role and account:** Cashier (qa.cashier).
- **Steps:** As the cashier, call `pharmacyInventory.expiryBoardLots {branchId, withinDays:180}`, `pharmacyPurchasing.lotsFromReceipt {branchId, goodsReceiptId}` and `pharmacyPurchasing.suppliers`. The Expiry board page shows the same data.
- **Expected:** Cost, valuation and supplier credit need `reports:financial` (owner or finance).
- **Actual:** 200 with `unitCostMinor: 110` (PKR 1.10/tablet), `valueAtRiskMinor: 30800`, lot cost per batch, and supplier `creditLimitMinor`/`paymentTermsDays` (23:31).
- **Evidence:** `api-evidence/rbac2.json` (suppliers, lots), `api-evidence/cost-exposure-and-close-rbac.json` (expiry board rows with `unitCostMinor`, 23:57:58). Code: `src/server/routers/pharmacy-inventory.ts:1545` (`expiryBoardLots`, module check only), `pharmacy-purchasing.ts:1564`, `:1614`, `:1628`.
- **Duplicate check:** none found (open #1082 is about the Finance template being refused, the opposite direction).
- **Suggested fix:** Strip cost and valuation fields unless the caller has `reports:financial`, and check procurement permission on supplier reads.

### [Sev2] Inventory: the "co-authorising witness" is just a name picked from a list; the witness never confirms

- **Severity:** Sev2 (stock-loss control does not work).
- **Role and account:** Owner (qa.owner) recording; QA Cashier named as witness.
- **Steps:** Inventory → *Adjustments and write-off custody* → lot QA-B3, Units 10, Co-authorizing witness "QA Cashier", evidence and reason → **Record write-off**.
- **Expected:** The second person confirms with their own PIN or sign-in, as the controlled goods-in flow does with the pharmacist PIN.
- **Actual:**
  - The write-off posted (QA-B3 300 → 290, about 23:45). The cashier did nothing and was not notified.
  - The dropdown also offers people the server will refuse (QA Manager isn't assigned to the branch → `COAUTH_REQUIRED`, 23:45:52).
  - The app's message for that code says "This action needs a second authorised **pharmacist** to countersign", although a cashier was accepted.
- **Evidence:** `qa-evidence/own-writeoff-cashier-witness.png`, `api-evidence/writeoff-witness.json`. Code: witness is any active branch-assigned user ID supplied by the actor — `src/lib/pharmacy/inventory-operations.ts:331-347`; message in `src/lib/pharmacy/counter-messages.ts:35`.
- **Duplicate check:** related, not the same: open #430/#657 (witness ID not validated; it now is) and #415 (direct-purchase approver is a dropdown pick, same pattern).
- **Suggested fix:** Require the witness to authenticate (PIN as at controlled goods-in), list only eligible witnesses, and word the error to match the real rule.

### [Sev2] Opening stock import: the cost column is per tablet while MRP is per pack, and nothing checks cost against MRP

- **Severity:** Sev2. Wrong opening valuation and margins.
- **Role and account:** Owner (qa.owner).
- **Steps:** Inventory → Import opening stock → upload the template CSV with `MRP 27.00` (per strip of 10) and `Cost 10.50` (the strip's cost, as most shops record it) → Run dry-run diff.
- **Expected:** One unit basis for both columns, or a warning when the per-tablet cost exceeds the per-tablet MRP.
- **Actual:**
  - The template header just says "Cost", but it is mapped as **"Cost per base unit (PKR)"**, while MRP is "per pack".
  - The row is marked **READY** with "MRP PKR 27.00 per pack · Cost PKR 10.50 per base unit", i.e. a cost of 105.00 per strip against an MRP of 27.00. The dry run reports **PKR 819.00 opening valuation** for 78 tablets, about 10× the real value.
  - Formula-looking text (`=HYPERLINK(…)`, `=1+1`) is shown as plain text, and an unknown pack ID gets a clear error; both are good.
- **Evidence:** `qa-evidence/own-import-dryrun.png`; mapping label `src/lib/pharmacy/migration/owner-import-input.ts:11`.
- **Duplicate check:** none found (open #1029/#989 cover other import dead ends).
- **Suggested fix:** Take cost per pack (same basis as MRP) or show both side by side, and block or warn when cost per unit ≥ MRP per unit.

### [Sev2] Language: the application cannot be switched to Urdu; only receipts, labels and the Z-report have Urdu

- **Severity:** Sev2. A major feature in scope is missing.
- **Role and account:** all roles.
- **Steps:** Look for a language switch in the header, Settings (`/settings`) and the account menu.
- **Expected:** An Urdu/English switch for the staff interface, with right-to-left layout.
- **Actual:**
  - No language setting exists. The page is hard-coded `<html lang="en">` and there is no i18n library; every screen and error message is English.
  - Urdu exists only as a "Language" choice on receipts, the day-close Z-report and the medication card.
  - The Urdu receipt itself mixes English ("Invoice:", "CASH:", "PKR"), prints in a monospace fallback font, and flips ISO dates through bidi reordering (`2026-11-02` shows as `02-11-2026`).
- **Evidence:** `qa-evidence/cash-settings.png`, `qa-evidence/cash-receipt-print-ur.png`; `src/app/layout.tsx:217`.
- **Duplicate check:** none for the missing switch. Related open: #426 (RTL of specific components), #439 (Urdu digits on receipts), #1198 (AI tools ignore locale).
- **Suggested fix:** Add a per-user language preference that drives `lang`/`dir`, start with counter, returns and day close, and use an Urdu Naskh/Nastaliq web font.

### [Sev2] Day close: closing early blocks every sale until midnight; there is no reopen, and the counter only says so at payment

- **Severity:** Sev2. Blocks selling after an early close.
- **Role and account:** Owner closes; Cashier sells.
- **Steps:**
  1. As the owner, close and lock 2026-11-02 at 23:48.
  2. As the cashier, add Panadol to a bill and take payment (23:49:03).
- **Expected:** The counter shows the day is closed before items are added. The owner can reopen with a reason, or move the counter to the next business day (late-night and 24-hour pharmacies are common).
- **Actual:**
  - The bill opens and the line is added (stock reserved again).
  - Payment then fails with "This business day is closed. New payments and drawer changes are blocked. Use an open business day." (`DAY_CLOSED`); opening a drawer is refused too (23:49:27).
  - Nothing can be sold until 00:00 PKT, and no reopen exists in the router or UI.
- **Evidence:** `qa-evidence/own-dayclose-done.png`, `qa-evidence/cash-after-close-pay.png`, `api-evidence/afterclose-api.json`.
- **Duplicate check:** none. Open #1038 asks only that the lock step say whether it can be undone.
- **Suggested fix:** Show a closed-day banner on the counter and disable Add, add an owner "reopen day" with reason and audit, and support a configurable business-day cut-off (for example 04:00).

### [Sev2] Security: signing out does not invalidate the session token

- **Severity:** Sev2 (security hardening; needs a copied cookie).
- **Role and account:** Cashier (qa.cashier), fresh session.
- **Steps:**
  1. Sign in and copy the `__Secure-authjs.session-token` cookie.
  2. Sign out (`/api/auth/signout`).
  3. Replay the copied cookie against `pharmacySales.counterBranches` and `/api/auth/session`.
- **Expected:** 401 after sign-out.
- **Actual:** 200 and `sessionRevoked:false` after sign-out (23:40:04–06). Because Auth.js re-issues the token on every read, a copied token can be kept alive past the 8-hour limit.
- **Evidence:** `api-evidence/session-revoke.json`. Code: the sign-out event only writes an audit row (`src/lib/auth.ts:782-797`); only "Sign out everywhere" bumps `tokenVersion` (`src/server/routers/team.ts:840`).
- **Duplicate check:** none. Related open #331 (cookie re-issued on every read).
- **Suggested fix:** Bump `tokenVersion` (or store a revoked session ID) on sign-out, and add an absolute session lifetime for shared counter PCs.

### [Sev3] Counter: a keyboard-only cashier can't pick a search result, and F6 is silently ignored in the quantity box

- **Severity:** Sev3 (slows the counter rush).
- **Role and account:** Cashier.
- **Steps:**
  1. F2, type "panadol", press Enter. Then try ↓ and Enter.
  2. Click the result, type quantity 2 and press F6.
- **Expected:** As the hint says, "Enter adds the selected medicine": arrow keys move through results, Enter adds, and F6 works from the quantity box.
- **Actual:**
  - Enter just repeats the search; arrow keys do nothing. The only keyboard path is Tab past the branch picker to the result button.
  - F6 does nothing while focus is in Quantity, with no feedback.
  - Barcode + Enter would work, but no product here can carry a barcode (see #1011).
- **Evidence:** `qa-evidence/cash-sale-selected.png`. Code: `src/components/pharmacy/counter/counter-console.tsx:1910-1927` (Enter only acts with an active row; no arrow handling); F-keys are dropped in any input except the scan box — `src/lib/pharmacy/counter-keymap.ts:286-309`.
- **Duplicate check:** none found (#1076 is about legend labels).
- **Suggested fix:** Let ↑/↓ select results and Enter add the selected row, and allow F6/F9 from the quantity field.

### [Sev3] Counter: the cash drawer is tied to the browser, and "open the drawer first" is discovered only at payment

- **Severity:** Sev3.
- **Role and account:** Cashier.
- **Steps:** Use the counter in a new browser profile (another PC, incognito, or after clearing site data), add a line, enter cash and take payment.
- **Expected:** The counter asks for the opening float before the first bill, and the drawer follows the cashier's shift, not the browser.
- **Actual:**
  - Payment is refused with "Open the cash drawer for this counter before taking a payment" (`DRAWER_NOT_OPEN`, 23:19:23 and 23:22:24).
  - The whole counter then greys out, **including "Open drawer"**, until "Refresh bill" is clicked, and the bill is lost on refresh (see the abandoned-bills finding).
  - The drawer ID is a random value in `localStorage`, so the earlier drawer is left open; seven drawers were opened today.
  - "Open drawer" opens with a zero float in one click (open #1070).
- **Evidence:** `qa-evidence/cash-sale6-pay1.png`, `api-evidence/close-preview.json` (7 drawers).
- **Duplicate check:** none for the device binding or the late discovery; #1070 covers the zero-float click.
- **Suggested fix:** Prompt for the drawer and opening float when the counter opens, keep "Open drawer" usable after a refused payment, and tie the drawer to the signed-in counter session.

### [Sev3] Counter: the change due disappears the moment payment is recorded

- **Severity:** Sev3.
- **Role and account:** Cashier.
- **Steps:** Bill PKR 50.00, Cash received 100, Take payment.
- **Expected:** A large "Change PKR 50" stays visible until the next bill starts.
- **Actual:** "Change 50.00" shows only while typing. After "Payment recorded" the tender panel shows "Balance due 0.00 · SETTLED", and the change is visible only inside the receipt preview below the fold.
- **Evidence:** `qa-evidence/cash-sale8-paid.png`. Code: change is computed from the live form inputs, which reset after payment — `src/components/pharmacy/counter/counter-tender-panel.tsx:159-162`, `:555-562`.
- **Duplicate check:** none found.
- **Suggested fix:** Show the settled change in the success state of the tender panel.

### [Sev3] Receipt: the printed receipt carries developer text and lacks the pharmacy's identity, licence, NTN, time and cashier

- **Severity:** Sev3.
- **Role and account:** Cashier.
- **Steps:** Complete a cash sale, then Print receipt (Thermal 80 mm, English and Urdu).
- **Expected:** A customer receipt with pharmacy name, address, phone, drug-sale licence number, NTN, date and time, cashier, items, batch and expiry, totals and payment.
- **Actual:**
  - Printed text: "SehatCart Test Branch / Invoice: Receipt 2 / Date: 2026-11-02 / … / Batch: QA-B2 · Expiry: 2027-01-31 · **Canonical units: 10** / … / **Tax breakdown unavailable in receipt source** / PKR / Gross 28.00 … Change 2.00 / CASH: 28.00".
  - There is no address, phone, licence, NTN, time or cashier. The Urdu version translates the developer sentence and keeps "Invoice:"/"CASH:" in English.
- **Evidence:** `qa-evidence/cash-receipt-print-en.png` (+ `.html`), `qa-evidence/cash-receipt-print-ur.png`; strings in `src/lib/pharmacy/counter-receipt-presentation.ts:19-20`.
- **Duplicate check:** none for the developer text or missing identity. Related closed #530 (NTN/STRN) and open #439 (Urdu digits), #708 (Sindh cash memo).
- **Suggested fix:** Hide the tax line when there is no tax data, rename "Canonical units" to "Tablets/units", and add a receipt header block (name, address, phone, licence, NTN) plus time and cashier.

### [Sev3] Receipts: numbering restarts per counter device, so several "Receipt 1" exist per day and the paper doesn't say which counter

- **Severity:** Sev3.
- **Role and account:** Owner (lookup), Cashier (returns).
- **Steps:** `pharmacySales.lookupReceiptByNumber {receiptNumber: 1}`; then Counter → Returns & refunds → receipt 2.
- **Expected:** Receipt numbers unique per branch per day (or printed with a counter prefix).
- **Actual:**
  - Three different completed sales are each "Receipt 1" on 2026-11-02 (devices `QA-20261102-CASHCHECK-DEVICE`, `counter-bbd93263-…`, `QA-20261102-FUNC-DEVICE`).
  - The printed receipt has no counter identifier. The returns dialog says "Receipt numbers can repeat. Choose the matching date and counter" and lists counters by raw device ID (`counter-bbd93263-ccd1-4c8d-9f65-7011e1bf6a48`).
- **Evidence:** `api-evidence/receipts-recon.json`, `qa-evidence/cash-return-found.png`; `src/components/pharmacy/counter/counter-return-panel.tsx:431`.
- **Duplicate check:** none found (#554 is about offline sequence reuse).
- **Suggested fix:** Give counters friendly names, print a counter prefix (e.g. `C2-0001`), or use a branch-wide sequence.

### [Sev3] Returns: a strip is shown as "1 BOX", and raw lot and device IDs are shown to the cashier

- **Severity:** Sev3.
- **Role and account:** Cashier.
- **Steps:** Returns & refunds → receipt 2 → Sold line.
- **Expected:** The return shows exactly what was sold ("1 strip of 10").
- **Actual:**
  - Shows "Paracetamol 500mg Tablets · **1 BOX** · 10 units returnable" and "One sold **box** contains 10 base units", although a strip was sold and printed as "pack: 1 × 28.00".
  - The lot option reads "QA-B2 · cmvzl8u3u01pq4oqrosqy5nsi · 0 units remaining".
- **Evidence:** `qa-evidence/cash-return-lines.png`, `cash-return-recorded.png`. Code: `saleUnit === 'PACK' ? 'BOX'` in `src/components/pharmacy/counter/counter-return-panel.tsx:489`, `:535`.
- **Duplicate check:** none found.
- **Suggested fix:** Label with the pack level actually sold, and hide internal IDs.

### [Sev3] Catalogue: duplicate pack sizes are accepted and then appear twice, indistinguishable, at Goods-in

- **Severity:** Sev3 (data quality).
- **Role and account:** Owner.
- **Steps:** Medicine catalogue → Packs for receiving → Paracetamol → Strip, 10 units → Create pack, when a "STRIP = 10" pack already exists.
- **Expected:** A refusal or warning ("this pack already exists").
- **Actual:**
  - A second identical pack is created ("Packs available now: 1 STRIP = 10 units / 1 STRIP = 10 units").
  - Goods-in and the purchase-order line pickers then list "Paracetamol 500mg Tablets — STRIP (1 STRIP = 10 units)" twice with no way to tell them apart.
  - The form also says "Available from this date at midnight UTC".
- **Evidence:** `qa-evidence/own-medicine-pack-created.png`; packs `cmvxpy8hn003t1xqr9az7aste` (1 Nov) and `cmvzkrtdx01aw4oqrwe45y3zt` (2 Nov). Code: no uniqueness check in `createPackLevel` — `src/server/routers/pharmacy-medicine.ts:677-708`; UTC copy at `src/components/pharmacy/medicine-pack-setup.tsx:243`.
- **Duplicate check:** none found (#1012 covers who may call it, not duplicates).
- **Suggested fix:** Unique key on (presentation, level, units, active), and say "midnight Pakistan time".

### [Sev3] Counter: the prescription panel shows controlled-drug PIN and register fields, plus an alarming message, for ordinary Rx items

- **Severity:** Sev3 (misleading UX).
- **Role and account:** Pharmacist; Owner (dark-mode capture).
- **Steps:** As the pharmacist, add the non-controlled Rx item QA Amoxicillin.
- **Expected:** Only the prescription capture and attach controls.
- **Actual:**
  - "Controlled medicine authorization" appears with Patient address, "Emergency supply, no prescription", Approving pharmacist, Pharmacist PIN and "Register serial written on the prescription".
  - It also shows "**No independent pharmacist with an active staff PIN is available. Ask your administrator to configure one.**"
  - The owner sees the same panel with no Rx line in the bill at all.
- **Evidence:** `qa-evidence/pharm-rx-add.png`, `qa-evidence/dark-owner-pharmacy-counter.png`. Code: the panel is passed whenever the pharmacist list is readable, regardless of bill contents — `src/components/pharmacy/counter/counter-console.tsx:2408-2418`.
- **Duplicate check:** none found.
- **Suggested fix:** Render the controlled section only when the bill holds a controlled line.

### [Sev3] Counter layout at desktop 1440×900: the sale-unit card clips its own quantity and price row, and the Workflow map card collapses

- **Severity:** Sev3 (broken component).
- **Role and account:** Cashier, Owner.
- **Steps:** Counter at 1440×900 → select a medicine.
- **Expected:** The full sale-unit card (pack choice, quantity stepper, unit price and line total) is visible.
- **Actual:** The quantity stepper and the "Canonical units / Unit price / Line total" row are cut off by the next card. The "POS-04 Workflow map" card renders as a thin sliver. At 768 px the search box shrinks to about 135 px; at 375 px cards collapse.
- **Evidence:** `qa-evidence/cash-sale-cart.png`, `cash-sale8-paid.png`, `sweep-tablet-cashier-counter.png`, `sweep-phone-cashier-counter.png`.
- **Duplicate check:** the tablet/phone part is open #1032/#1069. The desktop clipping is not reported.
- **Suggested fix:** Remove the fixed heights or overflow clipping from the counter grid cells.

### [Sev3] Login: after 10 failed attempts the account is locked for 5 minutes but the user is told "Invalid email or password", and anyone can trigger it

- **Severity:** Sev3.
- **Role and account:** anonymous, using a non-existent address (`qa.ratelimit.probe.*@example.com`) so no real account was locked.
- **Steps:** POST 13 wrong passwords to `/api/auth/callback/credentials`.
- **Expected:** After the limit, "Too many attempts, try again in N minutes". Lockouts shouldn't be triggerable by anyone who knows an email address (add per-IP backoff or CAPTCHA).
- **Actual:** Attempts 1–10 take about 150 ms (password checked), attempts 11–13 about 40 ms (throttled), and every response is the same `CredentialsSignin` → "Invalid email or password" (23:39:38–40). A cashier whose colleague mistyped 10 times is locked out and told their correct password is wrong.
- **Evidence:** `api-evidence/ratelimit.json`. Code: `src/lib/auth.ts:183-195` (returns `null` when throttled; account key is the bare email); message in `src/app/login/login-form.tsx:114`.
- **Duplicate check:** none found.
- **Suggested fix:** Return a distinct "rate_limited" code with a retry time, and key on email + IP or add progressive delay.

### [Sev3] Counter: no offline indicator; the cashier just sees "Taking payment…" while the internet is down

- **Severity:** Sev3.
- **Role and account:** Cashier.
- **Steps:** With a bill open, cut the network (DevTools offline), enter cash and take payment, then restore the network.
- **Expected:** A clear "Offline — the sale will complete when the connection returns" banner.
- **Actual:**
  - Only "Taking payment… Keep this bill open." is shown; nothing says the connection is down.
  - The payment did complete once the network returned, which is good.
  - On a slow link (400 ms latency, 50 KB/s), search took 1.1 s and add-to-cart 1.9 s, which is acceptable.
- **Evidence:** `qa-evidence/cash-counter-offline-pay.png`, `cash-counter-back-online.png`, `api-evidence/offline.json`.
- **Duplicate check:** none found.
- **Suggested fix:** Add an online/offline banner and queue indicator on the counter.

### [Sev3] Accessibility: Settings has 18 toggles with no name and 3 unlabelled password fields

- **Severity:** Sev3.
- **Role and account:** Cashier.
- **Steps:** axe-core (WCAG 2.1 AA) on `/settings`.
- **Expected:** Every control has an accessible name.
- **Actual:**
  - `aria-toggle-field-name` × 18 (serious) and `label` × 3 (critical: the change-password fields).
  - The coral eyebrow labels fail contrast on every page at **2.64:1** (open #1081/#1092). Root cause: the tenant's saved brand colour `#ff684f` overrides `--accent-brand` (`src/app/globals.css:528-530`), and tenant colours are not contrast-checked.
  - The login page is clean.
- **Evidence:** `api-evidence/axe-light.json`, `qa-evidence/cash-settings.png`.
- **Duplicate check:** toggles and password labels: none found. Contrast: #1081/#1092. Counter scroll region not keyboard-reachable: #427.
- **Suggested fix:** Pass `aria-label`/`aria-labelledby` to the Base UI switches and labels to the password inputs; contrast-check tenant brand colours before use on text.

### [Sev4] Customer orders page throws a React hydration error (#418) on every load

- **Severity:** Sev4 (console error; page still renders).
- **Role and account:** all four roles.
- **Steps:** Open `/pharmacy/orders`.
- **Expected:** No console errors.
- **Actual:** `pageerror: Minified React error #418` (server/client text mismatch) on every role.
- **Evidence:** `api-evidence/sweep-desk-results.json` (route `/pharmacy/orders`, all roles). Suspected cause (not confirmed): locale-dependent `Intl.NumberFormat('en-PK', currency)`/`DateTimeFormat` output in `src/components/pharmacy/customer-ordering-console.tsx:23-33`, which differs between Node and Chromium ICU.
- **Duplicate check:** none found.
- **Suggested fix:** Format on the client only, or pin the formatter output.

### [Sev4] Near-expiry CSV export does not neutralise cells that start with TAB or CR

- **Severity:** Sev4.
- **Role and account:** code review (any staff member can create medicine names, see #1012).
- **Expected:** Same formula guard as the accounts exports.
- **Actual:** `src/components/pharmacy/inventory/expiry-board.tsx:98-101` checks only `^[=+\-@]`, while `src/lib/pharmacy/accounts/account-activity-bridge.ts:100-104` and `migration/staged-review.ts:99-103` also treat leading whitespace, TAB and CR. All other pharmacy exports were checked and are safe; uploads reject spreadsheet formulas.
- **Evidence:** code references above.
- **Duplicate check:** none (open #643 is the agency finance export).
- **Suggested fix:** Reuse one shared `spreadsheetCell` helper.

### [Sev4] A line split across two batches prints an averaged price that matches neither batch's MRP

- **Severity:** Sev4 (the total is correct).
- **Role and account:** Owner.
- **Steps:** Sell 2 strips when FEFO takes 1 from batch QA-B4 (MRP 26.00) and 1 from QA-B2 (MRP 28.00).
- **Expected:** Two receipt lines, or one line showing both MRPs.
- **Actual:** The line total is correct (**54.00**, not 2 × 28.00, so open #521/#636 look fixed), but the unit price reads `27.00`, which is neither printed MRP.
- **Evidence:** `api-evidence/concurrency-QA-CONC-mvzlu2kg.json` (line 1: `grossMinor 5400`, `unitPriceMinor 2700`).
- **Duplicate check:** none.
- **Suggested fix:** Print per-batch sub-lines.

### [Sev4] The cashier's Day close page has no page heading, and its message is vague

- **Severity:** Sev4.
- **Role and account:** Cashier.
- **Steps:** Open `/pharmacy/counter/close` as the cashier.
- **Expected:** A normal page header (H1) and a message naming who can close the day.
- **Actual:** No H1 at any width (desktop, tablet, phone, dark), just a card "Day close unavailable — Sign in as a pharmacy administrator…" (the same card blocks pharmacists, see #654 below).
- **Evidence:** `qa-evidence/sweep-desk-cashier-dayclose.png`; all four sweeps flag `NO-H1` for this route only.
- **Duplicate check:** none for the heading; the navigation exposure is #1018.

---

## Existing issues re-verified on this build

These still reproduce on 2026-11-02. They are not re-filed; live evidence is added here.

| Issue | Sev (as filed) | What I saw | Evidence |
|---|---|---|---|
| #1010 / #507 | Sev1 / Sev2 | **Live:** the cashier created a supplier, recorded a licence with `verified: true`, authorised the supplier, raised and submitted a PO; the **pharmacist approved it**; the cashier sent it (all 200, 23:12:19). Only self-approval is blocked. | `api-evidence/rbac-purch-QA-RBAC-mvzktau8.json` |
| #1012 | Sev2 → **suggest Sev1** | **Live:** the cashier created a *saleable* antibiotic (Azithromycin 500 mg) flagged **OTC** using self-accepted provenance (23:27). Any staff member can create a non-Rx copy of an Rx drug and bypass the pharmacist gate. | `api-evidence/rx-setup.json` (`medC`); medicine `cmvzld69001u54oqrrmp2w1rm` |
| #1016 | Sev2 | **Live:** the cashier recorded a return and paid out a **PKR 28.00 cash refund** with no manager or owner approval (about 23:27). | `qa-evidence/cash-refund-done.png` |
| #1036 | Sev3 | **Live:** the Procurement user created a patient and recorded **WhatsApp MARKETING consent** for them (23:30:50). | `api-evidence/rbac2.json` |
| #412 | Sev2/3 | **Live:** the Procurement user opened a drawer, recorded PAID_IN/PAID_OUT PKR 100 and closed it (23:30:50). | `api-evidence/rbac2.json` |
| #517 | Sev2 | **Live:** the Procurement user exported the DRAP pharmacovigilance file (23:30:50). | `api-evidence/rbac2.json` |
| #520 | Sev2 | Discount and FEFO-override approver are free text (`src/lib/pharmacy/sales.ts:161-177`). | code |
| #415 | Sev2 | The direct-purchase "Approved by" is a dropdown pick with no approver sign-in (Goods-in page). | `qa-evidence/mgr-goods-in.png` |
| #623 | Sev2 | Sales and refunds completed while the workspace activation is BLOCKED (onboarding 7/12). | `qa-evidence/sweep-desk-owner-onboarding.png` |
| #1013 / #1046 / #1218 | Sev2/3 | Cashier, Procurement user and pharmacist all land on "Owner command centre" → "Branches could not be loaded" (403 `pharmacyReports.branches/catalog/getPreferences`). | `qa-evidence/sweep-desk-cashier-dashboard.png` |
| #1018 / #462 / #979 | Sev2/3 | The cashier's nav shows Day close, Purchasing, Reports & Insights, Prescriptions, Pharmacist queue, Substitution. The cashier gets the full supplier register with "Add a supplier". | `qa-evidence/sweep-desk-cashier-suppliers.png` |
| #654 (UI half) | Sev2 | The server now lets `pharmacy:close` close the day (pharmacist `closePreview` 200), but the page still requires `role === 'ADMIN'` and tells pharmacists "Sign in as a pharmacy administrator" (`src/components/pharmacy/counter/day-close-console.tsx:50`). | `api-evidence/cost-exposure-and-close-rbac.json`; `qa-evidence/sweep-desk-cashier-dayclose.png` |
| #1070 | Sev2 | "Open drawer" opens with a zero float in one click. | `qa-evidence/cash-drawer-dialog.png` |
| #989 / #1011 / #1029 | Sev1/3 | The catalogue UI never shows a pack ID, barcode or MRP field, so the opening-stock import (which needs "Pack barcode or pack ID") can't be completed from the UI. Once a branch has traded, the import is blocked anyway. | `qa-evidence/own-medicine-pack-created.png`, `own-import-dryrun.png` |
| #1039 | Sev2 | Capture disabled. The root cause is the missing prescriber/patient creation (new Sev1 above). | `qa-evidence/pharm-rx-page.png` |
| #1042 / #1195 / #1196 | Sev2 | `pharmacyReports.expiryAdvice` → **500** for the owner (23:33:34). | `api-evidence/reports1.json` |
| #1199 / #1159 | Sev1 | Ask Fathom → 503 "currently unavailable" in about 260 ms; `AI_PROVIDER` unset (`src/lib/ai/provider.ts:16-28`). | `api-evidence/ask-owner-1793644310806.json` |
| #1207 / #1213 | Sev2/4 | Marketing: statistics jargon ("Minimum lift", "Exclusive cutoff (UTC)"); Generate insights and Find bundle proposals do nothing with empty dates; a period including today gives "Use a completed period". | `qa-evidence/own-marketing-generate2.png` |
| #1022 / #1024 / #1210 | Sev3 | Raw codes and jargon: "REPORTS:FINANCIAL", "Source: pharmacy_sales + pharmacy_sale_lines", "POS-02", "CANONICAL UNITS · PRO-RATA CEILING". | `qa-evidence/sweep-desk-owner-dashboard.png`, `cash-sale-cart.png` |
| #1032 / #1069 | Sev2/3 | Tablet: counter search box about 135 px, purchasing tabs cut off. Phone: counter cards collapse. (No page scrolls horizontally at 375/768.) | `qa-evidence/sweep-tablet-*.png`, `sweep-phone-*.png` |
| #1081 / #1092 | Sev4 | Eyebrow labels 2.64:1 on every page (tenant brand colour). | `api-evidence/axe-light.json` |
| #427 | Sev3 | Counter scroll region not keyboard-focusable (axe `scrollable-region-focusable`). | `api-evidence/axe-light.json` |
| #439 / #426 | Sev3 | Urdu receipt uses Western digits; RTL only on the receipt. | `qa-evidence/cash-receipt-print-ur.png` |

### Existing issues that look fixed on this build

| Issue | How checked | Result |
|---|---|---|
| #521 / #636 (mixed-lot line charged at highest MRP) | Live: 2 strips across QA-B4 (26.00) + QA-B2 (28.00) | Charged 54.00 — fixed |
| #410 (Rx sells with no pharmacist gate) | Live: cashier `addLine` on an Rx item | 403 "needs the pharmacist dispensing permission" — fixed |
| #1015 (closeDay not limited) — closeDay part | Live: cashier and Procurement `closePreview` | 403 — fixed (drawer part still open, see #412) |
| #654 — server part | Live: pharmacist `closePreview` | 200 — fixed (UI still blocks) |
| #508 — capability part | Static + live (cashier `createRecall` 403) | Inventory writes now need `pharmacy:inventory`; branch-assignment part still open |
| #409, #418, #515, #655 | Code only (`rbac-static.tsv`) | Look fixed; not re-tested live |
| Oversell under concurrency | Live: 4 parallel `addLine` (80 units) vs a 30-unit batch | No oversell; spill-over to the next batch is correct |
| XSS in names | Live: `<img onerror>` / `<svg onload>` in supplier, patient and ingredient names | Rendered as text everywhere checked; receipt print escapes HTML |
| Lock after day close | Live | Tenders and drawer opens refused with `DAY_CLOSED` |
| Recall | Live | Cashier 403; pharmacist recall → counter shows RECALLED, 0 sellable; acknowledge + close restores stock |
| Report accuracy (sales) | Live: 5 receipts rebuilt by hand | Command centre `salesMinor 50598` = 199.98 + 50.00 + 200.00 + 28.00 + 28.00 |
| Day-close cash maths | Live | Expected 104.00 = 50 + 28 + 28 + 26 − 28 (verified by hand); variance −4.00 recorded with note |

---

## Summary table (new findings, by severity)

| # | Severity | Area | Finding |
|---|---|---|---|
| 1 | Sev1 | Counter | Unassigned staff can start a bill and reserve stock but can't pay, void or see it |
| 2 | Sev1 | Counter / stock | Abandoned bills keep stock reserved forever; no list or release; day close ignores them (reopen #420) |
| 3 | Sev1 | Prescriptions | No way to add a prescriber or patient → no Rx medicine can be sold |
| 4 | Sev1 | Security | Any staff member can create sales and reserve stock (closed #509 reproduces) |
| 5 | Sev1 | Privacy | `exportPatient` gives any staff member the full, unmasked patient record |
| 6 | Sev2 | Safety reporting | Pharmacovigilance report creation → 500 for every role |
| 7 | Sev2 | Financial data | Cashier can read unit cost, stock value at risk and supplier credit terms |
| 8 | Sev2 | Inventory | Write-off "co-authorising witness" is a dropdown pick, never confirmed |
| 9 | Sev2 | Opening stock | Cost per tablet vs MRP per pack, no sanity check → 10× valuation marked READY |
| 10 | Sev2 | Language | No Urdu/English switch for the app; Urdu only on receipts and labels |
| 11 | Sev2 | Day close | Early close blocks all sales until midnight; no reopen; counter warns only at payment |
| 12 | Sev2 | Security | Sign-out does not invalidate the session token |
| 13 | Sev3 | Counter | Keyboard can't pick a search result; F6 ignored in quantity box |
| 14 | Sev3 | Counter | Drawer tied to the browser; "open drawer" found only at payment, then counter locks |
| 15 | Sev3 | Counter | Change due disappears after payment |
| 16 | Sev3 | Receipt | Developer text on receipt; no pharmacy identity, licence, NTN, time or cashier |
| 17 | Sev3 | Receipts | Receipt numbers repeat per device; paper doesn't show the counter |
| 18 | Sev3 | Returns | Strip shown as "1 BOX"; raw lot and device IDs shown |
| 19 | Sev3 | Catalogue | Duplicate pack sizes accepted and shown twice at Goods-in |
| 20 | Sev3 | Counter / Rx | Controlled-drug PIN/register panel shown for ordinary Rx items |
| 21 | Sev3 | Counter layout | Desktop sale-unit card clips quantity/price row; Workflow map collapsed |
| 22 | Sev3 | Login | Throttle says "Invalid email or password"; anyone can lock a known user out |
| 23 | Sev3 | Counter | No offline indicator |
| 24 | Sev3 | Accessibility | Settings: 18 unnamed toggles, 3 unlabelled password fields |
| 25 | Sev4 | Customer orders | React hydration error #418 on every load |
| 26 | Sev4 | CSV export | Expiry-board export misses TAB/CR formula guard |
| 27 | Sev4 | Receipt | Mixed-batch line shows averaged unit price |
| 28 | Sev4 | Day close | Cashier's Day close page has no heading |

Totals: **5 Sev1, 7 Sev2, 12 Sev3, 4 Sev4**, plus 23 existing issues re-verified as still reproducing (two of which I'd escalate: #1012 → Sev1, #420 → reopen at Sev1).

## Areas not tested or only partly tested

| Area | Why |
|---|---|
| Ask Fathom accuracy, cross-tenant refusal, refusal of actions the role can't do, prompt injection, hallucinated numbers, latency, Urdu answers | AI is disabled on develop (`AI_PROVIDER` unset → 503, #1159/#1199). I reviewed the tool layer in code instead: every pharmacy tool re-checks role/capability and binds queries to the session's organisation (`src/lib/ai/tools/pharmacy-reports.ts`); assistant output is rendered without raw HTML (`react-markdown`, no `rehype-raw`). |
| AI growth insights against data | Same: "UNAVAILABLE — No model output". Basket bundles need completed past days; all QA sales were today. |
| Tenant isolation with another tenant's IDs | No credentials or record IDs for another tenant. Cookies are host-only (`__Secure-`/`__Host-`, HttpOnly, SameSite=Lax), and every query reviewed uses the session organisation plus the tenant-scoped database client. |
| Cross-branch IDOR, inter-branch transfers, branch comparison | Single-branch tenant. The static audit lists `scopeFor`-only reads (`customerSnapshot`, `counterSearch`, `onHand`, `expiryBoardLots`, …) that accept any branch in the organisation: worth a live test once a second branch exists. |
| New-tenant onboarding, custom roles, inviting users | Would create real users and emails. Only branch assignment was exercised. |
| Billing and subscription | No billing or subscription screen exists in the tenant app (plans exist only in code: `pharmacy-essentials/professional/chain`). |
| Khata (credit customers), loyalty redemption, WhatsApp orders and reminders, FBR Tier-1 | Not reached in the time available. |
| Stock-count approval co-auth | Read in code only (`approveCount` refuses the creator); not run live. |
| Large catalogues and long lists (performance at scale) | The tenant has about 10 medicines. With this data every page settled in 2–3.9 s including idle waits, and no API call took over 2 s (search 60–300 ms; slow-link search 1.1 s). Open #1147 (slow counter search) could not be reproduced at this size. |
| Screen-reader walkthrough | Automated axe scans plus heading and landmark checks only. |
| Thermal printer hardware (ESC/POS) and label printing | No hardware; browser print output captured instead. |

## Go / no-go for a pharmacy launch

**No-go.** A Punjab pharmacy could not trade on this build without workarounds that break its own controls:

1. **Prescription-only medicines can't be sold** (no prescriber or patient creation).
2. **Stock silently disappears** into abandoned bills, and **unassigned staff are stuck** in bills they can't pay. Together these will cause false stock-outs on day one.
3. **Authorization holes** let a cashier run the whole purchasing chain (#1010), edit the medicine catalogue including Rx flags (#1012), refund cash without approval (#1016), export patient records and see cost prices.
4. **Compliance basics fail:** adverse-reaction reporting returns 500, there is no Urdu interface, and receipts lack pharmacy identity and licence.

**Minimum to reach "go":** fix the 5 new Sev1s and #1010/#1012/#1016; add manager approval for refunds; add a receipt header with licence and NTN; add Urdu for counter, returns and day close; then re-run this pass, including a two-branch tenant and an AI-enabled environment.
