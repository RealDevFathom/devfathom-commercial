# QA report — SehatCart pharmacy tenant on develop

| | |
|---|---|
| Environment | `https://sehatcart.pharmacy.develop.devfathom.com` (develop deploy). Code references are to repo `develop` @ `47518cb`. |
| Test window | 2026-11-02 22:55 PKT – 2026-11-03 01:00 PKT (UTC+5). All times below are PKT. |
| Accounts | qa.owner@example.com (Owner / Operator, tenant ADMIN) · qa.cashier@example.com (Cashier) · qa.manager@example.com (Procurement) · qa.pharmacist@example.com (Pharmacist + `pharmacy:safety` override) |
| Method | Live UI driven with Playwright (desktop 1440, tablet 768, phone 375, light and dark), direct tRPC calls as each role, axe-core scans, and code reading to confirm root causes. Harness and raw API evidence: `qa/sehatcart-2026-11-02/`. |
| Verification | After the first draft, each finding's code claims were re-checked by independent adversarial reviewers, and the corrections are applied here. Three new defects they raised were confirmed live. One finding was withdrawn after the review and one earlier after a re-test. |
| Duplicate check | Every finding was checked against all 582 GitHub issues (open and closed), by title and by body text. Known problems are listed in [Existing issues re-verified](#existing-issues-re-verified-on-this-build) instead of being re-filed. |

## Test context and caveats

- **Single-branch tenant, not activated.** One branch (`MAIN`, Lahore). Onboarding shows 7/12 steps, activation BLOCKED. Selling still works, which open #623 already reports.
- **Another tester was active on the same tenant and the same QA Cashier account** (objects named `QA-20261102-FUNC-*`, `QA-20261102-CASHCHECK-*`). Their sales and refunds appear in drawers, receipts and report totals.
- **AI is switched off on develop.** `AI_PROVIDER` is not set, so Ask Fathom returns 503 and AI growth insights are unavailable (open #1159/#1199). AI accuracy could not be tested live (see [Not tested](#areas-not-tested-or-only-partly-tested)).
- **Changes QA made to the tenant:**
  - Assigned QA Cashier and QA Pharmacist to branch MAIN, about 23:20.
  - Created suppliers, POs, goods receipts, medicines (QA Amoxicillin, QA-RBAC Azithromycin), batches QA-B2…B5, sales, returns and refunds, a write-off and a recall (closed again).
  - **Closed business day 2026-11-02 at 23:48** with a deliberate −4.00 variance.
  - The follow-up checks at 00:39 created two test sales (one dated 2026-11-05); both were returned and refunded in full.
  - Open bills from testing still hold about 80 units of QA Panadol and 10 of QA Amoxicillin, because no screen can release them (finding 2).
- Severity scale used: **Sev1** security, data loss, money wrong or blocks selling · **Sev2** major feature broken · **Sev3** minor bug or misleading UX · **Sev4** polish.

Evidence paths: screenshots in `qa-evidence/`, raw API responses in `qa/sehatcart-2026-11-02/api-evidence/` (shortened to `api-evidence/` below), static authorization table in `qa/sehatcart-2026-11-02/rbac-static.tsv`.

---

## New findings

### 1. [Sev1] Counter: staff without a branch assignment can start a bill and reserve stock, but can never pay, void or even see it

- **Severity:** Sev1. Blocks selling and leaks stock.
- **Role and account:** Cashier (qa.cashier) and Pharmacist (qa.pharmacist) before they were assigned to a branch. This is the tenant's starting state: `pharmacyBranchAssignments.list` returned `assignments: []`.
- **Steps:**
  1. As the owner, add staff without ticking a branch. Assignment isn't part of the 12-step onboarding checklist. It can be done on the Organization page while adding a member, or later in Settings → Branch assignments.
  2. As the cashier, open Counter, search "panadol", pick the result, quantity 2, click **Add to cart (F6)**.
- **Expected:** The cashier is told up front "You are not assigned to this branch — ask the owner", or the sale works end to end.
- **Actual:**
  - The green toast "SUCCESS 2 × Paracetamol 500mg Tablets added." appears and the line is saved, which **reserves 20 units**.
  - The next read, `pharmacySales.counterCart`, returns **403 "Branch is outside your scope."** (23:16:43).
  - The screen then shows "BILL OPEN · 0 LINES", "Balance due Unavailable", "This bill could not be read. Check your access and refresh this bill before taking payment."
  - Take payment stays disabled, and hold/void (`transition`) use the same guard.
- **Evidence:** `qa-evidence/cash-sale-cart2.png`; `api-evidence/rbac-sale.json`. Code:
  - `create` (`src/server/routers/pharmacy-sales.ts:967-973`) and `addLine` (`scopeFor` at `:1060`) check only that the branch exists in the org (`scopeFor`, `:162-168`).
  - `counterCart` (`:1815-1825`), `transition` (`:1364-1400`) and `tender` (`:818-881`, guard at `:827`) use `requireCounterReceiptAccess` (`:381-481`), which requires an active branch assignment for non-admins.
  - The onboarding checklist has no assignment step (`src/lib/pharmacy/onboarding.ts:58-126`). The member form offers optional "Pharmacy branches" checkboxes (`src/app/(app)/organization/organization-admin-content.tsx:549-565`), and nothing warns about members left without one.
- **Duplicate check:** none found for this behaviour. Root cause shared with closed #509 (finding 5).
- **Suggested fix:**
  - Apply one authorization helper to every counter procedure (create, addLine, cart, tender, transition).
  - Refuse to open a bill without an assignment, with a message naming the remedy.
  - Add branch assignment to onboarding, and warn on the Team page about active members with no branch.

### 2. [Sev1] Counter/stock: bills abandoned by a browser reload keep their stock reserved forever, and nothing can find or release them

- **Severity:** Sev1. Data integrity; stock silently disappears from sale.
- **Role and account:** Cashier (qa.cashier); also reproduced with the pharmacist and the Procurement user.
- **Steps:**
  1. Receive 100 units (batch QA-B1).
  2. As the cashier, add 2 strips to a bill, then reload the page (or close the tab, or move to another PC or profile).
  3. Search the medicine again.
- **Expected:** The bill is restored on reload, or listed somewhere it can be resumed or voided, or its reservation expires. Day close should at least warn about open bills.
- **Actual:**
  - Without a payment in flight, the open bill lives only in React state, so a reload starts an empty counter. The old bill stays OPEN in the database with its stock reserved.
  - Six bills nobody could return to (three created by unassigned staff, three lost to reloads; 23:15–23:22) held 90 of 100 units. The counter then refused a 2-strip sale: **"SHORT BY 10 UNITS — Only 10 safe units are on hand"** while all 100 units were physically on the shelf.
  - No screen lists open or held bills. The owner could free only the three bills whose IDs QA knew from API responses (10 → 40 units available). About 80 units are still locked in bills nobody can find.
  - Day close counts only COMPLETED sales and closes without mentioning open bills.
- **Not a trigger (corrected):** a *refused* payment does not lose the bill. "Refresh bill" re-reads it, and payment attempts in flight are kept in `localStorage` and restored.
- **Evidence:** `api-evidence/rbac-sale.json` (on-hand 80 → 50 after three `addLine` calls); `qa-evidence/cash-sale7-before-pay.png` (short-by message). Code:
  - `useState<string | null>(initialSaleId)` — `src/components/pharmacy/counter/counter-console.tsx:309`; `initialSaleId` is set only for customer orders (`src/app/(app)/pharmacy/counter/page.tsx:13`).
  - In-flight attempts only: `tender-attempt-storage.ts:54`, `counter-console.tsx:403-449, 1247`.
  - Day close reads `status: 'COMPLETED'` only — `src/lib/pharmacy/day-close.ts:32`. No stale-bill release job exists.
- **Duplicate check:** **closed #420** ("browser reload drops the open bill from the screen, sale stays OPEN in the DB", Sev3) still reproduces. It is worse than filed, because the stock reservation leaks with the bill.
- **Suggested fix:**
  - Persist the active bill per counter device and restore it on load.
  - Add an "Open and held bills" list (owner and assigned staff) with void.
  - Expire unpaid reservations after a configurable time, and make day close list open bills.

### 3. [Sev1] Prescriptions: no prescriber or patient can be added in the product, so no prescription-only medicine can be sold through the UI

- **Severity:** Sev1. Blocks selling every Rx medicine, the bulk of a pharmacy's turnover.
- **Role and account:** Pharmacist (qa.pharmacist); Owner (qa.owner).
- **Steps:**
  1. As the owner, create an Rx medicine (QA Amoxicillin 500mg, `rx: true`) and receive 200 capsules.
  2. As the pharmacist, add it at the counter.
  3. Open **Prescriptions** to capture the prescription.
- **Expected:** The pharmacist can register the patient and the prescribing doctor, capture and verify the prescription, and sell.
- **Actual:**
  - The counter shows **"BLOCKED QA Amoxicillin 500mg Capsules requires a prescription before it can be dispensed. Attach a captured prescription and have a pharmacist verify it."**
  - On Prescriptions, the required **Patient** and **Prescriber** dropdowns are empty, and there is no "add patient" or "add prescriber" control anywhere.
  - No application code creates a `PharmacyPrescriber` (only the E2E seed script does, for its own test org), and no UI calls `createPatient`. There is no per-line remove, so the bill can only be voided whole (Shift+F4).
  - The cashier is correctly refused at 23:28:01 with 403 "needs the pharmacist dispensing permission".
- **Second blocker:** a default Pharmacist cannot take payment at all (finding 4), so fixing data entry alone won't let a cashier-plus-pharmacist shop sell Rx items.
- **Evidence:** `qa-evidence/pharm-rx-add.png`, `qa-evidence/pharm-rx-page.png`. Code:
  - Capture requires `prescriberId` — `src/server/routers/pharmacy-prescriptions.ts:297`.
  - The block is a browser-side safety alert for every `rx`/`controlled`/`restricted` line without a verified prescription — `src/lib/pharmacy/counter-alerts.ts:146-167`.
  - `PharmacyPrescriber` (`prisma/schema.prisma:12266`) is only read by application code (`pharmacy-prescriptions.ts:142, 338`); `scripts/seed-pharmacy-e2e.ts:902` is the only writer.
- **Duplicate check:** none for the root cause. Open #1039 reports the disabled Capture button as a copy problem; a copy fix won't unblock selling.
- **Suggested fix:**
  - Inline "add patient" and "add prescriber" on Prescriptions and in the counter Rx panel.
  - Allow capture and verification by the duty pharmacist in one step (audited) in single-pharmacist shops.
  - Fix finding 4.

### 4. [Sev1] Roles: a default Pharmacist cannot take payment, and a cashier cannot take payment for a bill with an Rx line, so only the Owner/Operator can finish an Rx sale

- **Severity:** Sev1. Blocks selling prescription medicines in a normal cashier-plus-pharmacist shop.
- **Role and account:** Pharmacist (qa.pharmacist, assigned to MAIN); Cashier (code).
- **Steps:** As the pharmacist, open a drawer, sell one strip of OTC Panadol, and take cash.
- **Expected:** A pharmacist can complete their own dispensing sale; or a cashier can take payment for a bill the pharmacist prepared.
- **Actual:**
  - **`tender` → 403 "You do not have permission for this action."** (2026-11-03 00:39:59).
  - `tender` requires the canonical `pharmacy:counter` grant, which the Pharmacist template does not include.
  - Settlement re-checks `pharmacy:dispense` for the *payer* on every Rx line, which the Cashier template does not include. Only the Owner/Operator template has both.
- **Evidence:** `api-evidence/verify-followups-qa-verify-mvzny1qg.json` (T1). Code: `src/server/routers/pharmacy-sales.ts:827` (`requireCounterReceiptAccess(ctx, branchId, true)`), `:393-401`; Pharmacist template `src/lib/vertical-catalog.ts:799-804`; settlement `src/lib/pharmacy/settlement.ts:322-326`.
- **Duplicate check:** none found (closed #390 was the colon/dot spelling of the counter grant).
- **Suggested fix:** Add `pharmacy:counter` to the Pharmacist template, or let a cashier take payment for Rx lines that a pharmacist added and verified (with the pharmacist recorded as dispenser).

### 5. [Sev1] Security: any signed-in staff member can open sales and reserve stock (closed #509 still reproduces)

- **Severity:** Sev1 (security / stock integrity).
- **Role and account:** Procurement user (qa.manager, no counter permission); Pharmacist; Cashier.
- **Steps:** As each user, call `pharmacySales.create {branchId}` and then `pharmacySales.addLine` (1 strip of an OTC item) directly.
- **Expected:** 403 for users without `pharmacy:counter` permission and a branch assignment.
- **Actual:** 200 for all three at 23:17:59–23:18:00. Each call reserved 10 units (on-hand 80 → 50), and none of them can pay or void the bill (`counterCart` 403). Users without dispensing permission are refused Rx, restricted and controlled lines, so the leak is limited to OTC stock.
- **Evidence:** `api-evidence/rbac-sale.json`. Code: `scopeFor` (`src/server/routers/pharmacy-sales.ts:162-168`) is the only check in `create` (`:967-973`) and `addLine` (`:1060`). `protectedProcedure` adds no capability (`src/server/trpc.ts:312-315`).
- **Duplicate check:** **closed #509** ("sale create and addLine need no pharmacy:counter capability or branch assignment") still reproduces.
- **Suggested fix:** Use `requireCounterReceiptAccess(ctx, branchId, true)` in `create` and `addLine` (and in the other `scopeFor`-only sales procedures listed in `rbac-static.tsv`).

### 6. [Sev1] Privacy: any staff member can export a patient's full record, unmasked

- **Severity:** Sev1 (security / patient privacy).
- **Role and account:** Procurement user (qa.manager) and Cashier (qa.cashier).
- **Steps:**
  1. As the Procurement user, call `pharmacyPrescriptions.createPatient` (test patient), then `readPatient`.
  2. Call `exportPatient` as the Procurement user and as the cashier.
- **Expected:** Patient read and export restricted to pharmacist or owner (`pharmacy:prescriptions`), and masked like the read view.
- **Actual:**
  - `readPatient` masks the phone (`*********4567`), but **`exportPatient` returns `"+923001234567"` in full** to both users (23:30:50).
  - The export also returns CNIC, address and date of birth unmasked, plus consents, prescriptions and fills.
  - Exports are audited (`pharmacy.patient.export`), but nothing restricts who can run one.
- **Evidence:** `api-evidence/rbac2.json`. Code: `readPatient` (`src/server/routers/pharmacy-prescriptions.ts:393`) and `exportPatient` (`:407-423`) are `auditedProtectedProcedure` with no capability check. The only gate is the org-wide module (`src/server/trpc.ts:318-321`). Masking covers only CNIC and phone (`src/lib/pharmacy/patient-prescriptions.ts:74-76`).
- **Duplicate check:** none found. Related open #1036 covers `createPatient`/`recordConsent` only.
- **Suggested fix:** Gate both procedures behind `pharmacy:prescriptions` (patients are org-wide, so there's no branch to scope by), and apply masking in export or make the full export pharmacist/owner-only.

### 7. [Sev2] Safety reporting: recording an adverse drug reaction fails with a server error (500) for every role, and the DRAP export is always empty

- **Severity:** Sev2. A major compliance feature is broken.
- **Role and account:** Owner, Pharmacist, Cashier (API; no screen calls these procedures).
- **Steps:** Call `pharmacyReports.createPharmacovigilanceReport` with `{branchId: MAIN, kind: "ADVERSE_DRUG_REACTION", occurredAt: now, assertedDescription: "QA probe - please ignore"}`.
- **Expected:** A draft pharmacovigilance report is created (pharmacist or owner only).
- **Actual:**
  - **HTTP 500 `INTERNAL_SERVER_ERROR`** "Something went wrong on our side. Please try again." for all three roles at **2026-11-02 23:31:08**.
  - `exportPharmacovigilanceDrap` returns `reports: []`.
- **Root cause (from code):**
  - The table's row-level security policy `tenant_branch_isolation` requires `"branchId" = current_setting('app.current_branch_id')` with no fallback, and the table uses FORCE RLS. These procedures never set the branch, so every insert fails.
  - The same policy hides every row, so the DRAP export can never return a report, and transition and submission always answer "not found".
  - README advertises pharmacovigilance reports.
- **Evidence:** `api-evidence/pv500.json`. Code: `prisma/migrations/20260904200000_pharmacy_pharmacovigilance/migration.sql:32-35`; `src/server/routers/pharmacy-reports.ts:233-278` (create), `:279-315`, `:385-419`. Error text replaced at `src/server/trpc.ts:126, 134`; the original error is logged by the route's `onError` (`src/app/api/trpc/[trpc]/route.ts:313-319`).
- **Duplicate check:** none found (open #517/#518 cover missing permission checks on these procedures, not the failure).
- **Suggested fix:** Bind `app.current_branch_id` (as khata does with `bindKhataBranch`) before these queries, add a real-database test, restrict creation to pharmacist or owner (#517), and add a screen.

### 8. [Sev2] Financial data: cashiers can read purchase cost per unit, stock value at risk and supplier credit terms

- **Severity:** Sev2 (internal confidentiality of margins; no customer data).
- **Role and account:** Cashier (qa.cashier).
- **Steps:** As the cashier, call `pharmacyPurchasing.suppliers`, `pharmacyPurchasing.lotsFromReceipt {branchId, goodsReceiptId}` and `pharmacyInventory.expiryBoardLots {branchId, withinDays: 180}`.
- **Expected:** Cost, valuation and supplier credit need `reports:financial` (owner or finance), as the sibling `purchaseReturns`/`supplierCredits` reads already do.
- **Actual:**
  - 200 with supplier `creditLimitMinor`/`paymentTermsDays` and lot `unitCostMinor` (23:30:49).
  - The expiry board rows include `unitCostMinor: 105`/`110` and `valueAtRiskMinor` (23:57:58).
  - `returnableLots` leaks lot cost too.
  - The Expiry board page shows value at risk, and its server component passes every row, unit cost included, to the browser.
  - None of these reads check branch assignment either.
- **Evidence:** `api-evidence/rbac2.json`, `api-evidence/cost-exposure-and-close-rbac.json`. Code: `src/server/routers/pharmacy-inventory.ts:1545` (module check only; fields at `:1706-1711, 1741-1743`); `src/server/routers/pharmacy-purchasing.ts:1564, 1614, 1628-1630`; the existing financial gate `supplierFollowUpScope` at `:346-359`.
- **Duplicate check:** none found (open #1082 is about the Finance template being refused, the opposite direction).
- **Suggested fix:** Apply the `reports:financial` gate (or strip cost fields) on these reads, and check procurement permission and branch assignment on supplier and lot reads.

### 9. [Sev2] Inventory: the write-off "co-authorising witness" is a name picked from a list; the witness never confirms

- **Severity:** Sev2 (the stock-loss control does not work).
- **Role and account:** Owner (qa.owner) recording; QA Cashier named as witness.
- **Steps:** Inventory → *Adjustments and write-off custody* → lot QA-B3, Units 10, Co-authorizing witness "QA Cashier", evidence and reason → **Record write-off**.
- **Expected:** The second person confirms with their own PIN or sign-in, as the controlled goods-in flow does with the pharmacist PIN, and the list offers only eligible people.
- **Actual:**
  - The write-off posted (QA-B3 300 → 290, about 23:45). The cashier did nothing and was not notified.
  - The dropdown lists every active organization member except the actor, but the server accepts only active members assigned to the branch.
  - A direct API call naming the unassigned QA Manager was refused with `COAUTH_REQUIRED` (23:45:52), and the screen doesn't explain that rule.
  - Transfer short-receipt write-offs accept any active member as witness, with no assignment check and no PIN.
- **Evidence:** `qa-evidence/own-writeoff-cashier-witness.png`, `api-evidence/writeoff-witness.json`. Code: `src/lib/pharmacy/inventory-operations.ts:331-347` (witness = user ID supplied by the actor); witness list `src/app/(app)/pharmacy/inventory/page.tsx:213-217` (rendered `:812-820`); transfer path `src/server/routers/pharmacy-inventory.ts:529-538`.
- **Duplicate check:** related, not the same: open #430/#657 (witness ID not validated; it now is) and #415 (direct-purchase approver is a dropdown pick, same pattern).
- **Suggested fix:** Require the witness to authenticate (PIN, as at controlled goods-in), list only eligible witnesses, and apply the same rule to transfer write-offs.

### 10. [Sev2] Compliance: the "prescription required" rule is enforced only in the browser; the server sells Rx medicines without a prescription

- **Severity:** Sev2 (a legal control can be bypassed by anyone with dispensing rights).
- **Role and account:** Owner (qa.owner, Owner/Operator: dispense + counter).
- **Steps:** Through the API, create a bill, `addLine` one strip of QA Amoxicillin (`rx: true`) with no prescription, then `tender` cash.
- **Expected:** The server refuses an Rx line without an attached, verified prescription (or records an audited emergency exception).
- **Actual:** The sale **settled** (`settled: true`, receipt 1, 00:39:59). It was then returned and refunded for cleanup. In the UI the same line is blocked, but only by a browser-side alert.
- **Evidence:** `api-evidence/verify-followups-qa-verify-mvzny1qg.json` (T2), `api-evidence/verify-cleanup.json`. Code: `addLine` adds the line when no prescription is sent (`src/server/routers/pharmacy-sales.ts:1070-1072`); settlement checks only `pharmacy:dispense` (`src/lib/pharmacy/settlement.ts:322-326`); the block lives in `src/lib/pharmacy/counter-alerts.ts:146-167`, evaluated in the browser.
- **Duplicate check:** none found (closed #410 covered Rx sales with no pharmacist gate; the gate now exists, but the prescription check doesn't).
- **Suggested fix:** Enforce "verified prescription attached" for Rx lines in `addLine`/settlement on the server, with an audited emergency-supply path.

### 11. [Sev2] Money integrity: the server books sales, drawers and refunds on any business date the client sends

- **Severity:** Sev2 (cash can be moved out of the day being closed).
- **Role and account:** Owner (qa.owner) via API.
- **Steps:** Call `openDrawer` with `businessDate: 2026-11-05` (two days ahead), then `create`, `addLine` and `tender` with the same date.
- **Expected:** The server uses the branch's current business day (Asia/Karachi) and refuses other dates.
- **Actual:** The drawer opened and the sale **settled on 2026-11-05** (00:40:00); a refund on that date was also accepted. A cashier could book cash to a future (or still-open past) date so it never appears in today's expected cash. The counter UI always sends today, so this is an API path.
- **Evidence:** `api-evidence/verify-followups-qa-verify-mvzny1qg.json` (T3), `api-evidence/verify-cleanup.json`. Code: `businessDate: z.date()` from input in `tenderInput` (`src/server/routers/pharmacy-sales.ts:134`), `openDrawer` (`:732`), `refundTender`.
- **Duplicate check:** none found (closed #632 covered closing a future day; open #568 is the restaurant equivalent).
- **Suggested fix:** Derive the business date on the server from the branch time zone, and accept a client date only for audited offline replay.

### 12. [Sev2] Day close: closing before trading ends blocks every sale until midnight; nothing reopens the day, and the counter only says so at payment

- **Severity:** Sev2. Blocks selling after an early close.
- **Role and account:** Owner closes; Cashier sells.
- **Steps:**
  1. As the owner, close and lock 2026-11-02 at 23:48.
  2. As the cashier, add Panadol to a bill and take payment (23:49:03).
- **Expected:** The counter shows the day is closed before items are added, and an owner can reopen the day for trading with a reason. (Shops open after midnight can already close yesterday's date from the date picker.)
- **Actual:**
  - The bill opens and the line is added, reserving stock again.
  - Payment fails with "This business day is closed. New payments and drawer changes are blocked. Use an open business day." (`DAY_CLOSED`); opening a drawer is refused too (23:49:27).
  - The router can **re-cut** a close with a reason (`pharmacySales.dailyClose` + `reopenReason` appends a superseding close), but no screen offers it, and any close row keeps the date blocked for trading.
  - Nothing can be sold through the counter until 00:00 PKT.
- **Evidence:** `qa-evidence/own-dayclose-done.png`, `qa-evidence/cash-after-close-pay.png`, `api-evidence/afterclose-api.json`. Code: `requirePharmacyDayOpen` blocks on any close row (`src/lib/pharmacy/settlement.ts:252-258`); re-cut path `:879-888`, `src/server/routers/pharmacy-sales.ts:787-807`; bills and lines never check the close (`src/lib/pharmacy/sales.ts`); `counterBranches` returns no closed-day flag (`pharmacy-sales.ts:1708-1730`).
- **Duplicate check:** none. Open #1038 asks only that the lock step say whether it can be undone.
- **Suggested fix:** Show a closed-day banner on the counter and disable Add; add an owner "reopen day for trading" with reason and audit; consider a configurable business-day cut-off.

### 13. [Sev2] Security: signing out does not invalidate the session token

- **Severity:** Sev2 (security hardening; needs a copied HttpOnly cookie).
- **Role and account:** Cashier (qa.cashier), fresh session.
- **Steps:**
  1. Sign in and copy the `__Secure-authjs.session-token` cookie.
  2. Sign out (`/api/auth/signout`).
  3. Wait **75 s** (past the 60 s revalidation window), then replay the copied cookie against `pharmacySales.counterBranches` and `/api/auth/session`.
- **Expected:** 401 after sign-out.
- **Actual:** 200 and `sessionRevoked:false` 75 s after sign-out (00:40:40 → 00:41:55).
- **Evidence:** `api-evidence/session-revoke-75s.json` (and the earlier 2 s replay, `api-evidence/session-revoke.json`). Code:
  - The sign-out event only writes an audit row (`src/lib/auth.ts:782-797`).
  - `tokenVersion` is bumped by "Sign out everywhere" (`src/server/routers/team.ts:840`), password change (`:828`), admin reset (`:1018`), deactivation (`:1089`), password reset and SCIM, but never by a normal sign-out.
  - Auth.js re-issues the token with a fresh 8-hour expiry on each session read (`src/lib/auth.ts:805-807`), so a copied token can be kept alive (inferred from code, not tested live).
- **Duplicate check:** none. Related open #331 (cookie re-issued on every read).
- **Suggested fix:** Bump `tokenVersion` (or store a revoked session ID) on sign-out, and add an absolute session lifetime for shared counter PCs.

### 14. [Sev3] Counter: a keyboard-only cashier can't pick a search result, and F6 is ignored in the quantity box

- **Severity:** Sev3 (slows the counter rush).
- **Role and account:** Cashier.
- **Steps:**
  1. F2, type "panadol", press Enter. Then try ↓ and Enter.
  2. Click the result, type quantity 2 and press F6.
- **Expected:** As the hint says, "Enter adds the selected medicine": arrow keys move through results, Enter adds, and F6 works from the quantity box.
- **Actual:**
  - Enter just repeats the search and arrow keys do nothing; the only keyboard path is Tab past the branch picker to the result button.
  - The app ignores F6 while focus is in Quantity. The browser's own F6 is not suppressed, so in Chrome or Edge focus may jump to the address bar.
  - Barcode + Enter would work, but no product in this tenant has a barcode: the catalogue's Create pack form can't add one, only the admin reference import or the API can.
- **Evidence:** `qa-evidence/cash-sale-selected.png`. Code: `src/components/pharmacy/counter/counter-console.tsx:1910-1927` (Enter acts only with an active row; no arrow handling); F-keys dropped in any input except the scan box — `src/lib/pharmacy/counter-keymap.ts:286-309`, `counter-console.tsx:1614-1620`.
- **Duplicate check:** none found (#1076 is about legend labels).
- **Suggested fix:** Let ↑/↓ select results and Enter add the selected row; allow F6/F9 from the quantity field (and suppress the browser default).

### 15. [Sev3] Counter: a refused cash payment locks the whole counter (even "Open drawer") until "Refresh bill", and nothing says cash needs an open drawer

- **Severity:** Sev3.
- **Role and account:** Cashier.
- **Steps:** On a counter device with no open drawer, add a line, enter cash and take payment.
- **Expected:** The counter tells the cashier before payment that cash needs an open drawer with a counted float, and "Open drawer" stays usable after a refusal.
- **Actual:**
  - Payment is refused with "Open the cash drawer for this counter before taking a payment" (`DRAWER_NOT_OPEN`, cash only; 23:19:23 and 23:22:24).
  - The whole counter then greys out, **including "Open drawer"**, until the cashier finds "Refresh bill".
  - The "Open drawer" button is visible from page load but nothing explains it, and it opens with a zero float in one click (open #1070).
  - The drawer belongs to a per-browser device ID in `localStorage`, so a new browser profile or PC is a new counter with its own drawer. Three drawers opened through the counter UI are still open.
- **Evidence:** `qa-evidence/cash-sale6-pay1.png`, `api-evidence/close-preview.json`. Code: `tenderReadRequired` set at `src/components/pharmacy/counter/counter-console.tsx:1214` and not cleared on refusal (`:1271-1293`), which disables Open drawer (`:1816`) until Refresh bill (`counter-tender-panel.tsx:351-355`); device ID `counter-console.tsx:108-115`; drawer lookup by device and date `src/lib/pharmacy/settlement.ts:377-391`.
- **Duplicate check:** none for the lock-up; #1070 covers the zero-float click.
- **Suggested fix:** Prompt for drawer and float when the counter opens, keep "Open drawer" enabled after a refusal, and show why payment was refused next to the button.

### 16. [Sev3] Counter: the change due disappears the moment payment is recorded

- **Severity:** Sev3.
- **Role and account:** Cashier.
- **Steps:** Bill PKR 50.00, Cash received 100, Take payment.
- **Expected:** A large "Change PKR 50" stays visible until the next bill starts.
- **Actual:** "Change 50.00" shows only while typing. After "Payment recorded" the tender panel shows "Balance due 0.00 · SETTLED", and the change is visible only inside the receipt preview below the fold.
- **Evidence:** `qa-evidence/cash-sale8-paid.png`. Code: change is computed from the live form inputs, which reset after payment — `src/components/pharmacy/counter/counter-tender-panel.tsx:159-162, 555-562`.
- **Duplicate check:** none found.
- **Suggested fix:** Show the settled change in the tender panel's success state.

### 17. [Sev3] Receipt: the printed receipt carries developer text and lacks the pharmacy's address, licence number, time and cashier

- **Severity:** Sev3.
- **Role and account:** Cashier.
- **Steps:** Complete a cash sale, then Print receipt (Thermal 80 mm, English and Urdu).
- **Expected:** A customer receipt with pharmacy name, address, phone, drug-sale licence number, NTN, date and time, cashier, items, batch and expiry, totals and payment.
- **Actual:**
  - Printed text: "SehatCart Test Branch / Invoice: Receipt 2 / Date: 2026-11-02 / … / Batch: QA-B2 · Expiry: 2027-01-31 · **Canonical units: 10** / … / **Tax breakdown unavailable in receipt source** / PKR / Gross 28.00 … Change 2.00 / CASH: 28.00".
  - No address, phone, licence, time or cashier is printed.
  - NTN/STRN do print when the branch regulatory profile has them; this tenant's profile has none.
  - The licence number and premises address are stored on that profile but never printed.
  - The Urdu version translates the developer sentence and keeps "Invoice:", "CASH" and "PKR" in English.
- **Evidence:** `qa-evidence/cash-receipt-print-en.png` (+ `.html`), `qa-evidence/cash-receipt-print-ur.png`. Code:
  - `src/lib/pharmacy/counter-receipt-presentation.ts:19-20` (labels; tax sentence always added at `:147`; raw tender enum at `:158`).
  - `Invoice:` hard-coded at `src/lib/receipts/preview.ts:54`.
  - Tax identity reads only `ntn`/`strn` (`src/lib/pharmacy/receipt-print.ts:210-226`), while the licence and address fields exist (`prisma/schema.prisma:159-161`).
- **Duplicate check:** none for the developer text or the missing licence and address. Related closed #530 (NTN/STRN) and open #439 (Urdu digits), #708 (Sindh cash memo).
- **Suggested fix:** Hide the tax line when there is no tax data; rename "Canonical units" to "Tablets/units"; print name, address, phone, licence and NTN from the regulatory profile, plus time and cashier; translate tender names.

### 18. [Sev3] Receipts: each counter device has its own receipt sequence, so several "Receipt 1" exist per branch and the paper doesn't say which counter

- **Severity:** Sev3.
- **Role and account:** Owner (lookup), Cashier (returns).
- **Steps:** `pharmacySales.lookupReceiptByNumber {branchId, receiptNumber: 1}`; then Counter → Returns & refunds → receipt 2.
- **Expected:** Receipt numbers unique per branch (or printed with a counter prefix).
- **Actual:**
  - Three different completed sales are each "Receipt 1" on 2026-11-02 (`counter-bbd93263-…` from the UI, plus two device IDs sent by API test traffic).
  - Each device ID keeps its own lifetime sequence starting at 1. The counter's device ID is per browser, so every PC or profile starts again at 1, and the server accepts any device ID a client sends.
  - The printed receipt has no counter identifier. The returns dialog says "Choose the matching date and counter. Receipt numbers can repeat." and lists counters by raw device ID (`counter-bbd93263-ccd1-4c8d-9f65-7011e1bf6a48`).
- **Evidence:** `api-evidence/receipts-recon.json`, `qa-evidence/cash-return-found.png`. Code: sequence keyed on (organization, branch, deviceId) — `src/lib/pharmacy/sale-completion.ts:44-50`, `prisma/schema.prisma:1428-1440`; dialog `src/components/pharmacy/counter/counter-return-panel.tsx:431, 446-447`.
- **Duplicate check:** none found (#554 is about offline sequence reuse).
- **Suggested fix:** Use a branch-wide sequence (or a short counter prefix such as `C2-0001`), name counters, and don't accept arbitrary device IDs.

### 19. [Sev3] Returns: a strip is shown as "1 BOX", and raw lot and device IDs are shown to the cashier

- **Severity:** Sev3.
- **Role and account:** Cashier.
- **Steps:** Returns & refunds → receipt 2 → Sold line.
- **Expected:** The return shows exactly what was sold ("1 strip of 10").
- **Actual:**
  - Shows "Paracetamol 500mg Tablets · **1 BOX** · 10 units returnable" and "One sold **box** contains 10 base units", although a strip was sold and printed as "pack: 1 × 28.00".
  - The lot option reads "QA-B2 · cmvzl8u3u01pq4oqrosqy5nsi · 0 units remaining".
- **Evidence:** `qa-evidence/cash-return-lines.png`, `cash-return-recorded.png`. Code: a standalone STRIP pack is sold as kind `PACK` (`src/lib/pharmacy/counter-pricing.ts:107-118`), and the return panel maps `PACK` → "BOX" (`src/components/pharmacy/counter/counter-return-panel.tsx:489, 535`); lot ID at `:508`, device ID at `:446-447`.
- **Duplicate check:** none found.
- **Suggested fix:** Label with the pack level actually sold, and hide internal IDs.

### 20. [Sev3] Catalogue: duplicate pack sizes are accepted and then appear twice, indistinguishable, at Goods-in

- **Severity:** Sev3 (data quality).
- **Role and account:** Owner.
- **Steps:** Medicine catalogue → Packs for receiving → Paracetamol → Strip, 10 units → Create pack, when a "STRIP = 10" pack already exists.
- **Expected:** A refusal or warning ("this pack already exists").
- **Actual:**
  - A second identical pack is created ("Packs available now: 1 STRIP = 10 units / 1 STRIP = 10 units").
  - Goods-in and the PO line pickers then list "Paracetamol 500mg Tablets — STRIP (1 STRIP = 10 units)" twice.
  - The form also says "Available from this date at midnight UTC".
- **Evidence:** `qa-evidence/own-medicine-pack-created.png`; packs `cmvxpy8hn003t1xqr9az7aste` (1 Nov) and `cmvzkrtdx01aw4oqrwe45y3zt` (2 Nov). Code: `createPackLevel` (`src/server/routers/pharmacy-medicine.ts:677-707`) checks only that the presentation and parent exist; the UTC copy is at `src/components/pharmacy/medicine-pack-setup.tsx:243`.
- **Duplicate check:** none found (#1012 covers who may call it, not duplicates).
- **Suggested fix:** A partial unique index on (organization, presentation, parent, level, unitsPerParent) where `effectiveTo IS NULL`, and say "midnight Pakistan time".

### 21. [Sev3] Counter: the controlled-drug authorisation panel shows on every bill, with an alarming message, even when nothing controlled is involved

- **Severity:** Sev3 (misleading UX).
- **Role and account:** Pharmacist; Owner (dark-mode capture).
- **Steps:** As the pharmacist, open the counter (empty bill) or add the non-controlled Rx item QA Amoxicillin.
- **Expected:** The controlled authorisation fields appear only when a controlled medicine is selected or already on the bill.
- **Actual:**
  - "Controlled medicine authorization" shows with Patient address, "Emergency supply, no prescription", Approving pharmacist, Pharmacist PIN and "Register serial written on the prescription".
  - It also shows "**No independent pharmacist with an active staff PIN is available. Ask your administrator to configure one.**" That message is accurate for a single PIN holder, but irrelevant here.
  - It renders for anyone with dispensing or safety permission while Pharmacy Safety is licensed, including on an empty bill.
- **Evidence:** `qa-evidence/pharm-rx-add.png`, `qa-evidence/dark-owner-pharmacy-counter.png`. Code: panel passed unless Safety is unlicensed or the pharmacist read is FORBIDDEN — `src/components/pharmacy/counter/counter-console.tsx:323-325, 2408-2418`; the authorisation must be entered **before** a controlled line is added (`:909-931`).
- **Duplicate check:** none found.
- **Suggested fix:** Show the controlled section when the *selected* (staged) medicine or any bill line is controlled. Hiding it until a controlled line exists would make controlled items impossible to add.

### 22. [Sev3] Counter layout at desktop 1440×900: the sale-unit card clips its own quantity and price row, and the Cart card collapses to a sliver

- **Severity:** Sev3 (broken component).
- **Role and account:** Cashier, Owner.
- **Steps:** Counter at 1440×900 → select a medicine; then complete a payment.
- **Expected:** The full sale-unit card (pack choice, quantity stepper, and the Canonical units / Unit price / Pro-rata ceiling / Line total preview) and the cart are visible.
- **Actual:**
  - The left column is two independent scroll panes that split the height, about 300 px each at 900 px, so the stepper and preview row are clipped at the bottom of their pane.
  - In the right column, the "POS-03 Cart and FEFO allocation" card shrinks to a thin sliver beside the Tender and Receipt cards.
  - At 768 px the search box is about 135 px wide; at 375 px cards collapse.
- **Evidence:** `qa-evidence/cash-sale-cart.png`, `cash-sale8-paid.png`, `sweep-tablet-cashier-counter.png`, `sweep-phone-cashier-counter.png`. Code: viewport-locked grid `src/components/pharmacy/counter/counter-console.tsx:1885-1886, 2291`; cart pane `:2127-2133` against `shrink-0` Tender (`:2172`) and `max-h-24` Receipt (`:2248`); preview fields `counter-unit-toggle.tsx:156-212`.
- **Duplicate check:** the tablet/phone part is open #1032/#1069. The desktop clipping is not reported.
- **Suggested fix:** Explicit grid rows (or a single left scroll pane) and a minimum height for the Cart card.

### 23. [Sev3] Login: on tenant hosts, a throttled sign-in says "Invalid email or password" even for the right password, and anyone can lock a known user out

- **Severity:** Sev3.
- **Role and account:** anonymous, using a non-existent address (`qa.ratelimit.probe.*@example.com`) so no real account was locked.
- **Steps:** POST 13 wrong passwords to `/api/auth/callback/credentials` on the tenant host.
- **Expected:** "Too many attempts, try again in N minutes" (the shared-host login already does this), and lockouts that can't be triggered by anyone who knows an email address.
- **Actual:**
  - Attempts 1–10 take about 150 ms (password checked) and attempts 11–13 about 40 ms (throttled). Every response is the same `CredentialsSignin` → "Invalid email or password" (23:39:38–40).
  - The account bucket is keyed on the bare email across all tenants and is shared with the shared-host login. It lasts up to 5 minutes from the first counted attempt.
  - A per-IP limit (30 per 5 minutes) exists but does not prevent targeted lockouts.
- **Evidence:** `api-evidence/ratelimit.json`. Code: `src/lib/auth.ts:183-196` (per-host credentials provider returns `null` when throttled); fixed window `src/lib/rate-limit.ts:25-39`; the shared host's 429 and message at `src/app/api/login/route.ts:116-128`, `src/app/login/shared-login-form.tsx:46-50`; message key `src/app/login/login-errors.ts:16-17`.
- **Duplicate check:** none found.
- **Suggested fix:** Return the existing `rate-limited` code from the tenant-host provider, and key the account bucket on email + organization (or add progressive delay).

### 24. [Sev3] Counter: no offline indicator; the cashier just sees "Taking payment…" while the internet is down

- **Severity:** Sev3.
- **Role and account:** Cashier.
- **Steps:** With a bill open, cut the network (DevTools offline), enter cash and take payment, then restore the network.
- **Expected:** A clear "Offline — the sale will complete when the connection returns" banner.
- **Actual:**
  - Only "Taking payment… Keep this bill open." is shown; nothing says the connection is down.
  - The payment completed once the network returned, which is good.
  - On a slow link (400 ms latency, 50 KB/s), search took 1.1 s and add-to-cart 1.9 s.
- **Evidence:** `qa-evidence/cash-counter-offline-pay.png`, `cash-counter-back-online.png`, `api-evidence/offline.json`.
- **Duplicate check:** none found.
- **Suggested fix:** Add an online/offline banner and a queue indicator on the counter.

### 25. [Sev3] Accessibility: Settings has 18 unnamed toggles and 3 unlabelled password fields, and the default tenant accent colour fails contrast on page eyebrows

- **Severity:** Sev3.
- **Role and account:** Cashier (`/settings`); Owner and Cashier (other pages).
- **Steps:** axe-core (WCAG 2.1 AA) on `/settings` and the main pharmacy pages, light and dark.
- **Expected:** Every control has an accessible name; text meets 4.5:1.
- **Actual:**
  - `/settings`: `aria-toggle-field-name` × 18 (serious) and `label` × 3 (critical: the change-password fields) (00:43:28).
  - Coral eyebrow labels fail at **2.64:1** on 6 of 8 scanned light-mode pages (not in dark).
  - `#FF684F` is the **schema default** `accentColor` for every tenant, applied inline over `--accent-brand`, so every tenant starts with this failure.
  - Day close (dark) also has an `aria-label` on a plain `div` (`aria-prohibited-attr`), and the counter scroll region isn't keyboard-focusable (#427).
  - The login page is clean.
- **Evidence:** `api-evidence/axe-settings.json`, `api-evidence/axe-light.json`, `api-evidence/axe-dark.json`, `qa-evidence/cash-settings.png`. Code: `src/lib/tenant-brand.ts:74-80`, applied at `src/components/layout/app-shell.tsx:190, 211`; default `prisma/schema.prisma:11286`.
- **Duplicate check:** toggles and password labels: none found. Contrast: #1081/#1092 (now with root cause). Scroll region: #427.
- **Suggested fix:** Name the Base UI switches and label the password inputs; contrast-check tenant colours before using them on text, or use the contract token for small text.

### 26. [Sev3] Dark mode: the tenant's brand colours are applied unchanged in dark mode, making primary links and buttons nearly invisible (1.21:1)

- **Severity:** Sev3.
- **Role and account:** Owner, Cashier (dark theme).
- **Steps:** Switch to dark (header moon button), open Onboarding, Goods-in and Settings.
- **Expected:** Primary text stays readable in dark mode.
- **Actual:**
  - Every `text-primary` element renders `#111110` on `#242422` (**1.21:1**): onboarding step links ("Open regulatory profile", "Go to this step"), "Show resolved" on Goods-in, and the Settings buttons ("Edit", "Dark", "Default", "Quiet").
  - Dark mode itself defines `--primary: #f7f7f4`, but the app shell sets `--primary:#111110` inline from the tenant brand in both themes.
  - The purchasing tab codes ("PUR-01"…) use `opacity-70`, giving 4.24:1 in dark; the design contract forbids dimming text with opacity.
- **Evidence:** `qa-evidence/dark-owner-goods-in-primary-link.png`, `api-evidence/axe-dark.json`, `api-evidence/sweep-desk-dark-results.json` (34/34 pages rendered `data-theme=dark`). Code: `src/components/layout/app-shell.tsx:190, 211` (`tenantBrandTokens`), `src/app/globals.css:1027`; contract `docs/design-system/DEVFATHOM-STUDIO.md:94-96`.
- **Duplicate check:** related open #1034 (dark-mode hard-coded colours; it left an "unconfirmed dark-mode link" out of scope, which this confirms and explains) and #1081/#1092 (same override in light mode).
- **Suggested fix:** Emit theme-specific brand tokens (or skip `--primary` overrides in dark), and remove `opacity-*` from text.

### 27. [Sev3] Opening stock import: the template's "Cost" column means cost per tablet while MRP is per pack, and nothing checks cost against MRP

- **Severity:** Sev3 (misleading template plus a missing plausibility check; works as documented on screen).
- **Role and account:** Owner.
- **Steps:** Inventory → Import opening stock → upload the template CSV with `MRP 27.00` (per strip of 10) and `Cost 10.50` (the strip's cost, as shops usually record it) → Run dry-run diff.
- **Expected:** One unit basis for both columns, or a warning when cost per tablet exceeds MRP per tablet.
- **Actual:**
  - The template header just says "Cost". The mapping step calls it "Cost per base unit (PKR)", and the page says "Counts and costs use individual base units; printed MRP is per selected pack".
  - Rows are marked **READY** with "MRP PKR 27.00 per pack · Cost PKR 10.50 per base unit", i.e. a cost of 105 per strip against an MRP of 27.
  - The headline "3 rows · 78 counted base units · PKR 819.00 opening valuation" also counts the 20 units of the row the dry run itself rejected.
  - Commit was blocked here because the branch had already traded.
  - Formula-looking text (`=HYPERLINK(…)`, `=1+1`) is shown as plain text, and an unknown pack ID gets a clear error; both are good.
- **Evidence:** `qa-evidence/own-import-dryrun-diff.png`, `api-evidence/opening-import-dryrun.txt`, `api-evidence/opening-import.csv`. Code: template header `src/lib/pharmacy/migration/owner-import-input.ts:11, 42, 49`; page copy `src/components/pharmacy/owner-import-wizard.tsx:87`; valuation `src/lib/pharmacy/migration/owner-import.ts:156-159`.
- **Duplicate check:** none found (open #1029/#989 cover other import dead ends).
- **Suggested fix:** Rename the template column "Cost per tablet/unit", warn when cost per unit ≥ MRP per unit, and exclude rejected rows from the valuation.

### 28. [Sev3] Language: there is no Urdu/English switch for staff screens, and the workspace "Locale" setting has no effect

- **Severity:** Sev3 (no in-repo requirement yet for an Urdu staff UI; see `ba-recommendations.md` for why it matters for launch).
- **Role and account:** all roles.
- **Steps:** Look for a language switch in the header, Settings and the account menu; set the Organization "Locale".
- **Expected:** An Urdu/English switch for the staff interface, with right-to-left layout.
- **Actual:**
  - Every screen and error message is English, and the page is hard-coded `<html lang="en">`.
  - A free-text "Locale" field exists on `/organization`, but nothing reads it.
  - Urdu is offered only as a choice on the receipt and the day-close Z-report; medication cards are always bilingual.
  - The Urdu receipt mixes English ("Invoice:", "CASH", "PKR"), prints in a monospace fallback font, and flips ISO dates through bidi reordering (`2026-11-02` shows as `02-11-2026`).
- **Evidence:** `qa-evidence/cash-settings.png`, `qa-evidence/cash-receipt-print-ur.png`. Code: `src/app/layout.tsx:217`; locale field `src/app/(app)/organization/organization-admin-content.tsx:412-413` (`prisma/schema.prisma:4894`); receipt font `src/lib/pharmacy/counter-browser-print.ts:99-103`.
- **Duplicate check:** none for the missing switch or the unused locale. Related open #426 (RTL of specific components), #439 (Urdu digits on receipts), #1198 (AI tools ignore locale).
- **Suggested fix:** Drive `lang`/`dir` and translations from a per-user preference (falling back to the workspace locale), starting with counter, returns and day close, and use an Urdu Naskh/Nastaliq web font.

### 29. [Sev4] Customer orders page throws a React hydration error (#418) on every load

- **Severity:** Sev4 (console error; the page still renders).
- **Role and account:** all four roles.
- **Steps:** Open `/pharmacy/orders`.
- **Expected:** No console errors.
- **Actual:** `pageerror: Minified React error #418` (server/client text mismatch) for every role.
- **Evidence:** `api-evidence/sweep-desk-results.json` (route `/pharmacy/orders`). Likely cause: the only locale-dependent server-rendered text is the basket total, `money(totalMinor, currency)` with `Intl.NumberFormat('en-PK', {style:'currency'})` (`src/components/pharmacy/customer-ordering-console.tsx:24`, rendered at `:629`). Node 22 locally gives "Rs 0" like the browser, so the develop server runtime's currency data probably differs. Not confirmed.
- **Duplicate check:** none found.
- **Suggested fix:** Render the total client-side only (or format without locale currency symbols on the server).

### 30. [Sev4] Near-expiry CSV export doesn't quote values containing a bare carriage return

- **Severity:** Sev4.
- **Role and account:** code review.
- **Expected:** The same quoting and formula guard as the accounts exports.
- **Actual:**
  - `csvCell` in the expiry board quotes only values containing `"`, `,` or `\n`, so a medicine name containing a bare `\r` (which survives the server's `.trim()`) is written unquoted.
  - A spreadsheet that treats CR as a row break then starts a row whose first cell is an un-neutralised formula (e.g. `X\r=1+1`).
  - Leading TAB/space can't reach this export, because writers trim. All other pharmacy exports were checked.
- **Evidence:** `src/components/pharmacy/inventory/expiry-board.tsx:98-102`; compare `src/lib/pharmacy/migration/staged-review.ts:99-104`.
- **Duplicate check:** none (open #643 is the agency finance export).
- **Suggested fix:** Reuse the staged-review `spreadsheetCell` helper (also used by the accounts bridge).

### 31. [Sev4] Category growth report undercounts sales on lines split across batches

- **Severity:** Sev4 (paisa-level report inaccuracy).
- **Role and account:** code review (mixed-batch pricing verified live in the concurrency test).
- **Expected:** Category revenue equals the sum of line gross amounts.
- **Actual:**
  - The report computes `quantity × unitPriceMinor − discountMinor`, but `unitPriceMinor` is `floor(gross / quantity)`.
  - So a 3-strip line priced 26 + 26 + 28 = 80.00 is counted as 3 × 26.66 = 79.98.
  - Receipts and line totals are correct.
- **Evidence:** `src/lib/pharmacy/category-growth-report.ts:103, 108`; `src/lib/pharmacy/sales.ts:198`.
- **Duplicate check:** none found.
- **Suggested fix:** Sum the stored line gross (`grossMinor`) instead.

### 32. [Sev4] Cashier and other non-admin roles get pages with no page heading, and Day close tells a signed-in user to "Sign in"

- **Severity:** Sev4.
- **Role and account:** Cashier, Procurement user, Pharmacist.
- **Steps:** Open `/pharmacy/counter/close` and `/organization` as a non-admin.
- **Expected:** A normal page header (H1) and a message naming who can close the day.
- **Actual:**
  - Both pages render only a card ("Day close unavailable — Sign in as a pharmacy administrator…" / the organization denial) with no H1, at every width and theme.
  - The Day close card tells an already signed-in user to sign in, and it is gated on `role === 'ADMIN'` while the server lets `pharmacy:close` holders close (the pharmacist template has it; see #654 below).
- **Evidence:** `qa-evidence/sweep-desk-cashier-dayclose.png`; `api-evidence/sweep-desk-results.json`. Code: `src/components/pharmacy/counter/day-close-console.tsx:49-64` (`SectionCard` renders an h2), H1 only in `DayCloseBranches` (`:82-86`); `src/app/(app)/organization/organization-admin-content.tsx:285-292`.
- **Duplicate check:** none for the headings; navigation exposure is #1018.

### Withdrawn after re-checking

- *Goods-in gives no confirmation after filing a draft.* A re-test showed the notice "Receipt … drafted. Nothing is in stock until you post it." at the top of the page (`qa-evidence/mgr-grn-filed-recheck.png`).
- *A mixed-batch line prints an averaged unit price.* Receipts print one price per batch (`src/lib/pharmacy/counter-receipt-presentation.ts:53-93`); the averaged value is only a stored field. Its real consequence is finding 31.

---

## Existing issues re-verified on this build

These still reproduce on 2026-11-02/03. They are not re-filed; live evidence is added here.

| Issue | Sev (as filed) | What I saw | Evidence |
|---|---|---|---|
| #1010 / #507 | Sev1 / Sev2 | **Live:** the cashier created a supplier, recorded a licence with `verified: true`, authorised the supplier, raised and submitted a PO; the **pharmacist approved it**; the cashier sent it (all 200, 23:12:19). Only self-approval is blocked. | `api-evidence/rbac-purch-QA-RBAC-mvzktau8.json` |
| #1012 | Sev2 → **suggest Sev1** | **Live:** the cashier created a *saleable* antibiotic (Azithromycin 500 mg) flagged **OTC** using self-accepted provenance (23:27). Any staff member can create a non-Rx copy of an Rx drug and bypass the pharmacist gate. | `api-evidence/rx-setup.json` (`medC`) |
| #1016 | Sev2 | **Live:** the cashier recorded a return and paid out a **PKR 28.00 cash refund** with no manager or owner approval (about 23:27). | `qa-evidence/cash-refund-done.png` |
| #1036 | Sev3 | **Live:** the Procurement user created a patient and recorded **WhatsApp MARKETING consent** for them (23:30:50). | `api-evidence/rbac2.json` |
| #412 | Sev2/3 | **Live:** the Procurement user opened a drawer, recorded PAID_IN/PAID_OUT PKR 100 and closed it (23:30:50). | `api-evidence/rbac2.json` |
| #517 | Sev2 | **Live:** the Procurement user ran the DRAP pharmacovigilance export (23:30:50); see finding 7 for why it is always empty. | `api-evidence/rbac2.json` |
| #520 | Sev2 | Discount and FEFO-override approver are free text (`src/lib/pharmacy/sales.ts:161-177`). | code |
| #415 | Sev2 | Direct-purchase "Approved by" is a dropdown pick with no approver sign-in (Goods-in page). | `qa-evidence/mgr-goods-in.png` |
| #623 | Sev2 | Sales and refunds completed while workspace activation is BLOCKED (onboarding 7/12). | `qa-evidence/sweep-desk-owner-onboarding.png` |
| #1013 / #1046 / #1218 | Sev2/3 | Cashier, Procurement user and pharmacist all land on "Owner command centre" → "Branches could not be loaded" (403 `pharmacyReports.branches/catalog/getPreferences`). | `qa-evidence/sweep-desk-cashier-dashboard.png` |
| #1018 / #462 / #979 | Sev2/3 | The cashier's nav shows Day close, Purchasing, Reports & Insights, Prescriptions, Pharmacist queue, Substitution. The cashier gets the full supplier register with "Add a supplier". | `qa-evidence/sweep-desk-cashier-suppliers.png` |
| #654 (UI half) | Sev2 | The server lets `pharmacy:close` close the day (pharmacist `closePreview` 200), but the page still requires `role === 'ADMIN'` (`src/components/pharmacy/counter/day-close-console.tsx:52`). | `api-evidence/cost-exposure-and-close-rbac.json`; `qa-evidence/sweep-desk-cashier-dayclose.png` |
| #1070 | Sev2 | "Open drawer" opens with a zero float in one click. | `qa-evidence/cash-drawer-dialog.png` |
| #989 / #1011 / #1029 | Sev1/3 | The catalogue's Create pack form never shows a pack ID, barcode or MRP. The opening-stock import needs "Pack barcode or pack ID", and is blocked once a branch has traded. | `qa-evidence/own-medicine-pack-created.png`, `own-import-dryrun-diff.png` |
| #1039 | Sev2 | Capture disabled; root cause is the missing prescriber/patient creation (finding 3). | `qa-evidence/pharm-rx-page.png` |
| #1042 / #1195 / #1196 | Sev2 | `pharmacyReports.expiryAdvice` → **500** for the owner (23:33:34). | `api-evidence/reports1.json` |
| #1199 / #1159 | Sev1 | Ask Fathom → 503 "currently unavailable" in about 260 ms; `AI_PROVIDER` unset (`src/lib/ai/provider.ts:16-28`). | `api-evidence/ask-owner-1793644310806.json` |
| #1207 / #1213 | Sev2/4 | Marketing: statistics jargon ("Minimum lift", "Exclusive cutoff (UTC)"); Generate insights and Find bundle proposals do nothing with empty dates; a period including today gives "Use a completed period". | `qa-evidence/own-marketing-generate2.png` |
| #1022 / #1024 / #1210 | Sev3 | Raw codes and jargon: "REPORTS:FINANCIAL", "Source: pharmacy_sales + pharmacy_sale_lines", "POS-02", "CANONICAL UNITS · PRO-RATA CEILING". | `qa-evidence/sweep-desk-owner-dashboard.png`, `cash-sale-cart.png` |
| #1032 / #1069 | Sev2/3 | Tablet: counter search box about 135 px, purchasing tabs cut off. Phone: counter cards collapse. (No page scrolls horizontally at 375/768.) | `qa-evidence/sweep-tablet-*.png`, `sweep-phone-*.png` |
| #1081 / #1092 | Sev4 | Eyebrow labels 2.64:1 in light mode; root cause is the default tenant accent colour (finding 25). | `api-evidence/axe-light.json` |
| #427 | Sev3 | Counter scroll region not keyboard-focusable (axe `scrollable-region-focusable`, light and dark). | `api-evidence/axe-light.json`, `axe-dark.json` |
| #439 / #426 | Sev3 | Urdu receipt uses Western digits; RTL only on the receipt. | `qa-evidence/cash-receipt-print-ur.png` |

### Existing issues that look fixed on this build

| Issue | How checked | Result |
|---|---|---|
| #521 / #636 (mixed-lot line charged at highest MRP) | Live: 2 strips across QA-B4 (26.00) + QA-B2 (28.00) | Charged 54.00 — fixed |
| #410 (Rx sells with no pharmacist gate) | Live: cashier `addLine` on an Rx item | 403 "needs the pharmacist dispensing permission" — fixed (the prescription check itself is still browser-only, finding 10) |
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
| Dark mode rendering | Live: 34 pages after fixing the harness | All rendered dark, no errors or overflow (contrast issues in finding 26) |

---

## Summary table (new findings, by severity)

| # | Severity | Area | Finding |
|---|---|---|---|
| 1 | Sev1 | Counter | Unassigned staff can start a bill and reserve stock but can't pay, void or see it |
| 2 | Sev1 | Counter / stock | Bills lost to a reload keep stock reserved forever; nothing lists or releases them (reopen #420) |
| 3 | Sev1 | Prescriptions | No way to add a prescriber or patient → no Rx medicine can be sold through the UI |
| 4 | Sev1 | Roles | Default Pharmacist can't take payment; cashier can't pay for Rx bills → only Owner/Operator can sell Rx |
| 5 | Sev1 | Security | Any staff member can create sales and reserve stock (closed #509 reproduces) |
| 6 | Sev1 | Privacy | `exportPatient` gives any staff member the full, unmasked patient record |
| 7 | Sev2 | Safety reporting | Pharmacovigilance create → 500 for every role (RLS branch setting missing); DRAP export always empty |
| 8 | Sev2 | Financial data | Cashier can read unit cost, stock value at risk and supplier credit terms |
| 9 | Sev2 | Inventory | Write-off "co-authorising witness" is a dropdown pick, never confirmed |
| 10 | Sev2 | Compliance | Prescription requirement enforced only in the browser; API sells Rx without one |
| 11 | Sev2 | Money integrity | Server accepts any business date from the client (sale booked to a future day) |
| 12 | Sev2 | Day close | Early close blocks sales until midnight; no reopen for trading; counter warns only at payment |
| 13 | Sev2 | Security | Sign-out does not invalidate the session token (still valid after 75 s) |
| 14 | Sev3 | Counter | Keyboard can't pick a search result; F6 ignored in the quantity box |
| 15 | Sev3 | Counter | Refused cash payment locks the counter (incl. Open drawer) until "Refresh bill" |
| 16 | Sev3 | Counter | Change due disappears after payment |
| 17 | Sev3 | Receipt | Developer text on receipt; no address, licence, time or cashier |
| 18 | Sev3 | Receipts | Receipt numbers are per device; several "Receipt 1" per branch |
| 19 | Sev3 | Returns | Strip shown as "1 BOX"; raw lot and device IDs shown |
| 20 | Sev3 | Catalogue | Duplicate pack sizes accepted and shown twice at Goods-in |
| 21 | Sev3 | Counter / Rx | Controlled-drug panel shown on every bill with an alarming message |
| 22 | Sev3 | Counter layout | Desktop sale-unit card clips its preview row; Cart card collapses |
| 23 | Sev3 | Login | Tenant-host throttle says "Invalid email or password"; anyone can lock a user out |
| 24 | Sev3 | Counter | No offline indicator |
| 25 | Sev3 | Accessibility | Settings: 18 unnamed toggles, 3 unlabelled fields; default accent colour fails contrast |
| 26 | Sev3 | Dark mode | Tenant brand colours kept in dark → primary links 1.21:1 |
| 27 | Sev3 | Opening stock | "Cost" means per tablet while MRP is per pack; no cost-vs-MRP check; valuation counts rejected rows |
| 28 | Sev3 | Language | No Urdu/English switch for staff screens; workspace "Locale" has no effect |
| 29 | Sev4 | Customer orders | React hydration error #418 on every load |
| 30 | Sev4 | CSV export | Expiry-board export doesn't quote values containing a bare CR |
| 31 | Sev4 | Reports | Category growth report undercounts mixed-batch lines |
| 32 | Sev4 | Headings | Day close and Organization pages have no H1 for non-admins |

Totals: **6 Sev1, 7 Sev2, 15 Sev3, 4 Sev4** (32 new findings), plus 23 existing issues re-verified as still reproducing. I'd escalate two of those: #1012 → Sev1, and reopen #420 at Sev1.

## Areas not tested or only partly tested

| Area | Why |
|---|---|
| Ask Fathom accuracy, cross-tenant refusal, refusal of actions the role can't do, prompt injection, hallucinated numbers, latency, Urdu answers | AI is disabled on develop (`AI_PROVIDER` unset → 503, #1159/#1199). I reviewed the tool layer in code instead: every pharmacy tool re-checks role/capability and binds queries to the session's organisation (`src/lib/ai/tools/pharmacy-reports.ts`); assistant output is rendered without raw HTML (`react-markdown`, no `rehype-raw`). |
| AI growth insights against data | Same: "UNAVAILABLE — No model output". Basket bundles need completed past days; all QA sales were today. |
| Tenant isolation with another tenant's IDs | No credentials or record IDs for another tenant. Cookies are host-only (`__Secure-`/`__Host-`, HttpOnly, SameSite=Lax), and every query reviewed uses the session organisation plus the tenant-scoped database client. |
| Cross-branch IDOR, inter-branch transfers, branch comparison | Single-branch tenant. The static audit lists `scopeFor`-only reads (`customerSnapshot`, `counterSearch`, `onHand`, `expiryBoardLots`, …) that accept any branch in the organisation: worth a live test once a second branch exists. |
| Counter price preview for lines split across batches | Code review suggests the pre-add preview prices the whole quantity at the first batch's MRP (`counter-console.tsx:213-227`). Not reproduced live (no second batch was free at the time). |
| New-tenant onboarding, custom roles, inviting users | Would create real users and emails. Only branch assignment was exercised. |
| Billing and subscription | No billing or subscription screen exists in the tenant app (plans exist only in code: `pharmacy-essentials/professional/chain`). |
| Khata (credit customers), loyalty redemption, WhatsApp orders and reminders, FBR Tier-1 | Not reached in the time available. |
| Stock-count approval co-auth | Read in code only (`approveCount` refuses the creator); not run live. |
| Large catalogues and long lists (performance at scale) | The tenant has about 10 medicines. With this data every page settled in 2–3.9 s including idle waits, and no API call took over 2 s (search 60–300 ms; slow-link search 1.1 s). Open #1147 (slow counter search) could not be reproduced at this size. |
| Screen-reader walkthrough | Automated axe scans plus heading and landmark checks only. |
| Thermal printer hardware (ESC/POS) and label printing | No hardware; browser print output captured instead. |

## Go / no-go for a pharmacy launch

**No-go.** A Punjab pharmacy could not trade on this build without workarounds that break its own controls:

1. **Prescription-only medicines can't be sold** through the product: there's no prescriber or patient creation, and only the Owner/Operator can take payment for an Rx bill. Meanwhile the API sells Rx items with no prescription at all.
2. **Stock silently disappears** into abandoned bills, and **unassigned staff are stuck** in bills they can't pay. Together these will cause false stock-outs on day one.
3. **Authorization and money-integrity holes:**
   - a cashier can run the whole purchasing chain (#1010) and edit the medicine catalogue, including Rx flags (#1012);
   - refunds need no approval (#1016);
   - patient records can be exported and cost prices read;
   - sales can be booked to another business date.
4. **Compliance basics fail:** adverse-reaction reporting returns 500, receipts lack the pharmacy's address and licence, and there is no Urdu interface.

**Minimum to reach "go":**
- fix the 6 new Sev1s and #1010/#1012/#1016;
- enforce prescriptions and the business date on the server;
- add manager approval for refunds and a receipt header with licence and address;
- add Urdu for counter, returns and day close;
- then re-run this pass, including a two-branch tenant and an AI-enabled environment.
