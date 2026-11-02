# Business-analyst recommendations — DevFathom Pharmacy (Punjab launch)

Written after the QA pass in `qa-report.md` (SehatCart develop, 2026-11-02). It covers what small and mid-size Punjab pharmacies need before and after launch, based on what I saw while testing and on how such shops typically run.

**How to read it**

- **P1** = needed for launch · **P2** = within 3 months · **P3** = later.
- **Size:** S (days) · M (1–3 weeks) · L (more than 3 weeks). These are rough, for ordering only.
- **Evidence** is a QA observation (screenshot, `file:line`, or `qa-report.md` entry) or a labelled real-world practice. Statements about regulation or practice that I could not verify are marked **(guess / to confirm)**. No market sizes or competitor facts are used.
- Existing GitHub issues are linked instead of duplicated.

---

## 1. Daily workflows

### [P1] Counter: a keyboard-first bill that a cashier can run at rush hour without the mouse

- **Who / problem:** Cashier. At a busy counter the cashier types or scans, picks, sets quantity, takes cash and needs the change instantly. Today search results can't be picked with the keyboard, F6 is ignored in the quantity box, change disappears after payment, and the screen shows internal codes (POS-02, "canonical units").
- **Evidence:** `qa-report.md` keyboard, change-due and layout findings; `qa-evidence/cash-sale-selected.png`, `cash-sale8-paid.png`; open #1024, #1076.
- **Size:** M · **Change to existing feature.**

### [P1] Counter: parked bills that survive reloads, with an "open bills" list and auto-release

- **Who / problem:** Cashier, owner. Counters juggle several customers at once (one waiting for change, one for a pharmacist). Bills are lost on reload yet keep their stock reserved; in testing, 90 of 100 tablets became unsellable.
- **Evidence:** `qa-report.md` abandoned-bills Sev1; `src/components/pharmacy/counter/counter-console.tsx:309`; closed #420.
- **Size:** M · **Change.**

### [P1] Opening the shop: a "start of day" step (open drawer with counted float, yesterday's close, today's alerts)

- **Who / problem:** Cashier, owner. Today the drawer opens in one click with zero float, and the cashier only learns the drawer is required when payment fails. A start-of-day step makes cash accountable from the first sale.
- **Evidence:** `qa-evidence/cash-drawer-dialog.png`, `cash-sale6-pay1.png`; open #1070.
- **Size:** S · **Change.**

### [P1] Goods-in: receive from the distributor's paper invoice in one pass, without a purchase order

- **Who / problem:** Owner, manager. Many small shops order by phone or WhatsApp, or through the distributor's order-taker on visit, and reconcile when the delivery and paper invoice arrive _(common practice; guess on how widespread)_. Today the happy path is requisition → quote → PO → submit → approve → send → goods-in, about 15 fields per line, and "direct purchase" needs a reason plus a named approver.
- **Proposal:** Make "receive invoice" the default: supplier, invoice no., then lines of medicine, batch, expiry, MRP, trade price, bonus/scheme qty and discount. Prefill from a barcode or DataMatrix scan, and allow one confirmation by the owner.
- **Evidence:** `qa-evidence/mgr-goods-in.png`; open #1080/#1093 (14 phone screens per line), #415, #717 (DataMatrix).
- **Size:** M · **Change.**

### [P1] Sell loose tablets by default

- **Who / problem:** Cashier. Selling part of a strip (e.g. 4 tablets) is routine. In testing only "Pack (STRIP)" was offered, because loose sale needs a separate Unit pack level that the owner must think to create.
- **Proposal:** Create the unit level automatically from the presentation (e.g. "10 × 10"), and price loose units from the per-batch MRP.
- **Evidence:** counter sale-unit choices in `qa-evidence/cash-sale-cart.png`; `src/components/pharmacy/medicine-pack-setup.tsx`.
- **Size:** S · **Change.**

### [P1] Day close that fits real opening hours: business-day cut-off, reopen with a reason, open bills shown

- **Who / problem:** Owner. Late-night and 24-hour pharmacies are common _(guess on share)_. Today an early close blocks every sale until midnight, there is no reopen, and open bills are ignored.
- **Evidence:** `qa-report.md` day-close Sev2; `src/lib/pharmacy/day-close.ts:32`; `qa-evidence/cash-after-close-pay.png`.
- **Size:** M · **Change.**

### [P2] Stock counts by shelf with a phone camera, and a real second-person sign-off

- **Who / problem:** Manager, owner. Monthly or cycle counts are done shelf by shelf. Today the count and write-off forms sit inside one very long Inventory page, and the "co-authorising witness" is just a name from a dropdown.
- **Evidence:** `qa-evidence/own-inventory.png`, `own-writeoff-cashier-witness.png`; `qa-report.md` co-auth Sev2.
- **Size:** M · **Change.**

### [P2] Cash drawer per cashier shift, not per browser

- **Who / problem:** Owner. Two or three cashiers share one PC across shifts. Today the drawer belongs to a random browser device ID, and seven drawers were opened in one day of testing.
- **Evidence:** `qa/sehatcart-2026-11-02/api-evidence/close-preview.json`.
- **Size:** M · **Change.**

---

## 2. Missing features a real pharmacy expects

### [P1] Supplier ledger: what I owe each distributor, payments (cash, cheque, bank) and due dates

- **Who / problem:** Owner. Distributors give credit terms and collect by cheque or cash _(common practice)_. Owners need "how much do I owe Distributor X, which cheques are due this week". The command centre returns `accountsPayableMinor: null`.
- **Evidence:** `api-evidence/receipts-recon.json` (command-centre metrics); planned #677 (AP invoices, settlements, aging) and #749 (payables scheduling).
- **Size:** L · **New** (build on #677).

### [P1] Short-expiry returns to distributors that actually go through

- **Who / problem:** Owner, manager. Returning near-expiry stock within the distributor's window is real money. The expiry board already shows return windows, but the return-proposal path fails: expiry advice returns 500 and `proposeExpiryReturn` is broken.
- **Evidence:** `qa-report.md` (#1042/#1195 re-verified); open #744.
- **Size:** M · **Change.**

### [P1] Khata (customer credit) in every plan, with WhatsApp/SMS statements and reminders in Urdu

- **Who / problem:** Owner, cashier. Regular families buy on credit and settle monthly _(common practice)_. Khata exists, but reminders are English-only and the provider isn't configured.
- **Evidence:** open #385, #740, #722 (split tender cash + khata).
- **Size:** M · **Change.**

### [P1] Purchase suggestions as a ready order list per distributor

- **Who / problem:** Owner, manager. Owners reorder by memory and the distributor salesman's prompts. The current replenishment report asks for a medicine ID, history start date, origin date, horizon and a forecasting method, which is analyst language.
- **Proposal:** "What to order today" grouped by distributor (sales velocity, minimum stock, lost-sales events), one click to a draft PO or invoice.
- **Evidence:** input schema `src/lib/pharmacy/replenishment-report.ts:21-33`; open #1212, #736, #735.
- **Size:** M · **Change.**

### [P1] Barcodes and shelf stickers end to end

- **Who / problem:** Cashier, manager. Scanning is the fastest counter path, but the catalogue UI cannot add a barcode or show a pack ID, so no product in the test tenant could be scanned.
- **Evidence:** open #1011, #989, #719 (stickers for loose and unbarcoded stock).
- **Size:** M · **Change.**

### [P2] WhatsApp orders become a draft bill at the counter (with Rx photo)

- **Who / problem:** Owner, cashier. Customers already send orders and prescription photos on WhatsApp _(common practice)_.
- **Evidence:** customer orders page exists (`/pharmacy/orders`); open #754, #762, #761.
- **Size:** M · **Change.**

### [P2] Home delivery with rider and cash-on-delivery reconciled at day close

- **Who / problem:** Owner, cashier. Shops send a staff member with deliveries and collect cash on delivery _(common practice)_. Customer orders support "staff-runner delivery", but COD cash isn't part of drawer reconciliation.
- **Evidence:** `/pharmacy/orders` copy ("branch collection and staff-runner delivery").
- **Size:** M · **Change.**

### [P2] "Is it available at our other branch?" at the counter, plus a one-click transfer request

- **Who / problem:** Cashier (multi-branch owners). It saves a lost sale.
- **Evidence:** branch comparison report and transfers exist; open #746.
- **Size:** M · **New.**

### [P2] FBR integration for shops classed as Tier-1

- **Who / problem:** Owner of larger shops and chains. The FBR "Am I Tier-1?" self-check exists. Shops it classes as Tier-1 need FBR-integrated invoicing on receipts _(regulatory detail to confirm with a tax adviser)_.
- **Evidence:** `/pharmacy/regulatory/fbr-tier-1` page; closed #709.
- **Size:** L · **New** (integration).

---

## 3. Compliance gaps (Punjab)

### [P1] Prescription-only sales that a one-pharmacist shop can actually complete

- **Who / problem:** Pharmacist, owner. Most shops have one qualified person on duty _(guess on share)_. Today no prescriber or patient can be created, so no Rx sale can finish. Parts of the flow also expect an "independent" second pharmacist.
- **Proposal:** Quick-add patient and prescriber, capture a photo, let the duty pharmacist verify in one step with audit, and keep the second-person rule for controlled drugs only.
- **Evidence:** `qa-report.md` prescriptions Sev1; `qa-evidence/pharm-rx-add.png`, `pharm-rx-page.png`; open #1039, #725.
- **Size:** M · **Change.**

### [P1] Controlled-drug (narcotics/psychotropics) register in the Punjab format, with daily balance

- **Who / problem:** Pharmacist, owner. Inspectors check the register against stock _(practice)_. The register and PIN witness exist; the Punjab rule content is an open launch blocker.
- **Evidence:** `/pharmacy/controlled-register`; open #712 (Punjab rule set), #713 (emergency-supply cap). Exact register columns **to confirm** against the Punjab Drug Rules.
- **Size:** M · **Change.**

### [P1] Keep prescriptions for the required period and find them fast

- **Who / problem:** Pharmacist. Photo per Rx, searchable by patient, doctor or date, with retention enforced.
- **Evidence:** prescription image upload exists; open #714 (retention enforcement, launch blocker).
- **Size:** M · **Change.**

### [P1] Licence tracking with reminders: shop drug-sale licence, qualified person, distributor licences

- **Who / problem:** Owner. Expired licences risk sealing and fines _(practice)_, and distributor licence validity already gates ordering in the product.
- **Evidence:** branch regulatory profile page; supplier licence model; open #720.
- **Size:** S · **Change.**

### [P1] A receipt (cash memo) with the pharmacy's legal identity

- **Who / problem:** Owner, customer. Today the receipt shows only the branch name and developer text. Add name, address, phone, drug-sale licence no., NTN, date and time, cashier, batch and expiry. Exact Punjab requirements are **to confirm**; Sindh has its own mode (#708).
- **Evidence:** `qa-evidence/cash-receipt-print-en.png`; `src/lib/pharmacy/counter-receipt-presentation.ts:19-20`.
- **Size:** S · **Change.**

### [P2] One-click drug-inspector visit pack

- **Who / problem:** Owner. A single PDF with licence, qualified person, registers, purchase invoices with warranties, expiry and recall lists. An inspection-pack export already exists in code but isn't visible in the owner's UI.
- **Evidence:** `src/server/routers/pharmacy-safety.ts:240` (`createInspectionPack`).
- **Size:** S · **Change.**

---

## 4. Money and margins

### [P1] The owner's daily one-pager (app + WhatsApp, Urdu/English)

- **Who / problem:** Owner who isn't at the shop all day. They want to trust the numbers without opening ten screens:
  - sales; cash counted vs expected (variance); refunds and voids by cashier;
  - khata given and collected; supplier payments due;
  - margin; value expiring in 30/60/90 days; dead stock.
- Today the dashboard shows permission keys and table names, and margin reads "Not available in this release".
- **Evidence:** `qa-evidence/sweep-desk-owner-dashboard.png`; open #738, #1210.
- **Size:** M · **Change.**

### [P1] Flat discount below MRP on medicines, with a margin floor

- **Who / problem:** Owner, cashier. Many urban pharmacies compete with a flat % off MRP _(common practice; guess on share)_. Selling below MRP is lawful, above MRP is not _(to confirm)_. Today **any** discount on an Rx, restricted or controlled line is refused, and approvals are free-text names.
- **Evidence:** `src/lib/pharmacy/sales.ts:171-176` (`REGULATED_DISCOUNT_REFUSED`, approver free text); open #751, #520.
- **Size:** S · **Change.**

### [P2] True margin by product, supplier and same-salt brand

- **Who / problem:** Owner. Shows which brands and distributors make money once bonus schemes, freight and discounts are counted.
- **Evidence:** open #739, #745, #609 (freight and rebates dropped from lot cost).
- **Size:** M · **Change.**

### [P2] Dead-stock report with an action (return, transfer, discount, write off)

- **Who / problem:** Owner. Non-moving stock ties up cash. Nothing in the reports surface covers it today.
- **Evidence:** reports surface reviewed (`/pharmacy/reports`); no matching issue found.
- **Size:** S · **New.**

### [P2] Expiry loss tracking: returned and credited vs written off

- **Who / problem:** Owner. Shows how much expiry cost this month and how much distributors credited back.
- **Evidence:** write-offs and supplier credits exist; open #744, #644 (write-offs post no journal).
- **Size:** S · **Change.**

---

## 5. AI and growth

### [P1] Lead with advice that needs no AI provider; make the LLM features an add-on

- **Who / problem:** Owner. On develop the AI provider is off, so Ask Fathom answers 503 and growth insights say "UNAVAILABLE". The deterministic advisors are what save time: reorder list, expiry returns, khata reminders, cash variance. They should work on day one and not depend on the LLM.
- **Evidence:** `qa-report.md` (#1199/#1159 re-verified), `qa-evidence/own-marketing-generate2.png`.
- **Size:** S · **Change.**

### [P2] Ask Fathom for owners, in Urdu, once there are about 3 months of data

- **Who / problem:** Owner. Questions such as "aaj kitni sale hui?" or "which distributor do I owe most?" are useful only on accurate sales, cost and supplier data. Gate it behind data readiness. Keep the strict tool authorization reviewed in code (`src/lib/ai/tools/pharmacy-reports.ts`).
- **Evidence:** closed #748; open #1198 (Urdu only in one tool).
- **Size:** M · **Change.**

### [P2] Lost-sales capture with one tap ("not in stock / customer left")

- **Who / problem:** Cashier, owner. It's the cheapest growth data, and it feeds purchase suggestions and back-in-stock messages. A "capture shortfall" button already exists on the counter.
- **Evidence:** counter shows "Capture shortfall"; open #735, #736, #737.
- **Size:** M · **Change.**

### [P3] Defer basket-bundle analytics and AI marketing copy

- **Who / problem:** Owner. These read as gimmicks for a single shop. The screens ask for "minimum lift", "support" and "confidence", need completed UTC days, and gave no result on a real day's data. Keep consented refill and back-in-stock reminders, which are concrete revenue.
- **Evidence:** `qa-evidence/own-marketing.png`; open #1207, #752, #743, #737.
- **Size:** S (hide) · **Change.**

---

## 6. Onboarding and adoption

### [P1] A preloaded Pakistani medicine master so the owner doesn't build the catalogue by hand

- **Who / problem:** Owner. There is no "add medicine" form. The only route is uploading reference rows, then review and publish, then creating pack levels with no barcode, MRP or pack ID shown. A shop with thousands of SKUs can't go live in a day this way.
- **Proposal:** Ship a curated master (product, strength, form, pack sizes, barcodes where known) that owners pick from or import against. The availability and licensing of a DRAP-registered product data source are **to confirm**.
- **Evidence:** `qa-evidence/own-medicine-pack-created.png`, `own-import-dryrun.png`; open #1011, #989, #1029; closed #721 (Marg/Tally import presets).
- **Size:** L · **New.**

### [P1] A one-day go-live wizard

- **Who / problem:** Non-technical owner. The steps:
  1. Branch and licence.
  2. Staff, roles and **branch assignment** (missing today, so cashiers can't sell).
  3. Opening stock from the old system, with cost and MRP on the same basis and sanity checks.
  4. Printer test.
  5. A test sale and a test return.
  6. Day close.
- Today activation shows 12 jargon-heavy steps and stays BLOCKED.
- **Evidence:** `qa-evidence/sweep-desk-owner-onboarding.png`; `qa-report.md` branch-assignment Sev1 and opening-stock Sev2.
- **Size:** M · **Change.**

### [P1] Urdu interface for the counter, returns and day close first

- **Who / problem:** Cashier, pharmacist assistant. Many counter staff read Urdu more comfortably than English _(guess)_. Only receipts and labels have Urdu today.
- **Evidence:** `src/app/layout.tsx:217` (`lang="en"`), `qa-evidence/cash-settings.png`.
- **Size:** L · **New.**

### [P1] Plain-language copy sweep

- **Who / problem:** Everyone. Remove codes and developer wording: "POS-02", "PUR-01", "canonical units", "pro-rata ceiling", "UTC", raw table names, "Tax breakdown unavailable in receipt source".
- **Evidence:** open #1022, #1024, #1210, #1211, #1212.
- **Size:** M · **Change.**

### [P2] Training mode and Urdu cheat-sheets

- **Who / problem:** Owner training new cashiers. Practice bills that don't count, and a printable F-key card in Urdu.
- **Evidence:** keymap legend exists (`counter-keymap-legend.tsx`); no matching issue found.
- **Size:** S · **New.**

---

## 7. Pricing and packaging

### [P1] Put Rx dispensing and the controlled-drug register in the base plan

- **Who / problem:** Owner. "Pharmacy Essentials" includes counter, inventory, procurement, finance and reports but **not** `pharmacy-dispensing` or `pharmacy-safety`. Those hold prescriptions, the pharmacist queue and the controlled register, which every pharmacy legally needs.
- **Evidence:** `src/lib/vertical-catalog.ts:1456-1469`.
- **Size:** S · **Change.**

### [P2] Clear base-vs-add-on split

- **Who / problem:** Owner deciding to buy. A _guess_ at a sensible split (prices are not known to me):
  - **Base:** counter (incl. loose sale and khata), inventory, purchase invoices and supplier ledger, Rx and controlled register, day close, receipts, Urdu UI, owner daily one-pager.
  - **Add-ons:** multi-branch (transfers, central purchasing), WhatsApp reminders and marketing (usage-priced), AI assistant and briefings, CCTV cameras, FBR integration, accountant view (balance sheet, trial balance, journals).
- **Evidence:** module and plan model in `src/lib/vertical-catalog.ts:1456-1503`.
- **Size:** S · **Change.**

---

## Top 10 by impact on getting pharmacies to sign up and stay

1. **Rx sales that a one-pharmacist shop can complete** — without it the product can't sell most of a pharmacy's stock.
2. **Preloaded medicine master + barcodes/packs** — decides whether go-live takes a day or a month.
3. **Fast, reliable counter** — keyboard flow, parked bills, no stock leaks, change shown, offline banner. Cashiers judge the product here every minute.
4. **Urdu interface** for the counter, returns and day close.
5. **One-day go-live wizard** — staff and branch assignment, opening stock with sanity checks, test sale.
6. **Owner's daily one-pager on WhatsApp** — cash vs counted, margin, khata, payables, expiries. This is the reason to keep paying.
7. **Supplier ledger and payments + khata reminders** — money owed in and out, the two notebooks the owner keeps today.
8. **Purchase suggestions as a ready order list per distributor.**
9. **Compliance basics** — receipt with licence and NTN, controlled register in the Punjab format, licence reminders, inspector pack.
10. **Flat discount below MRP with a margin floor** — matches how urban shops compete.

## What to cut or simplify

- **Purchasing chain:** make "receive the distributor's invoice" the default path. Keep requisition → quote → approval as an optional setting for chains.
- **Second-person rules:** keep them for controlled drugs and large write-offs only, and make them a real PIN confirmation. Elsewhere, make them configurable for one- and two-person shops.
- **Hide for single-shop owners** (move to an "accountant" view or add-on): trial-balance control, journal evidence export, account activity bridge, cheque maturity, fiscal exceptions, classified cash-flow projection.
- **Marketing analytics:** hide basket lift/support/confidence settings and AI copy suggestions until there is enough data. Show plain outcomes ("customers who buy X often buy Y").
- **Cameras:** treat as an add-on, not part of the core pharmacy navigation.
- **Copy:** remove workflow codes (POS-xx, PUR-xx, INV-xx), "UTC" and developer phrasing from every staff-facing screen and every customer-facing paper.
