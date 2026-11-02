# Running findings log (scratch)

## NEW
- N1 [Sev3] Catalogue: Create pack accepts exact duplicate pack level (STRIP/10 twice on same presentation). owner. ev: qa-evidence/own-medicine-pack-created.png; API pharmacyMedicine.get packLevels cmvxpy8hn003t1xqr9az7aste (2026-11-01) + cmvzkrtdx01aw4oqrwe45y3zt (2026-11-02 18:11 UTC). Code TBD (createPackLevel no uniqueness).
- N2 [Sev4] /pharmacy/orders: React #418 hydration error for all roles (console pageerror). ev sweep desk results.
- N3 [Sev3/UX] Pack form says "Available from this date at midnight UTC" (owner-facing UTC). ev own-medicine-pack-created.png

## RE-VERIFIED (still reproduce)
- #1013/#1046 dashboard for cashier/manager/pharmacist: Owner command centre + "Branches could not be loaded" (403 pharmacyReports.branches/catalog/getPreferences). ev sweep cashier__dashboard.png
- #1018/#462/#979 nav shows Day close, Purchasing, Reports, Rx, Pharmacist queue, Substitution to cashier.
- #1010 createSupplier/recordSupplierLicence/setSupplierAuthorization/createPO/approvePO no capability check (code). LIVE TBD.
- #989/#1011 no pack ID/barcode/MRP in UI -> opening stock import dead end.
- #1022/#1210 dashboard shows raw "REPORTS:FINANCIAL", "Source: pharmacy_sales + pharmacy_sale_lines".
- #654 day close needs literal ADMIN: pharmacist sees "Sign in as a pharmacy administrator".
- N4 [Sev1] Counter: unassigned non-admin can create bill + addLine (stock deducted) but counterCart/tender/transition 403 "Branch is outside your scope" -> can't pay or void; contradictory UI (SUCCESS added + BILL OPEN 0 LINES + bill could not be read). Live: onHand 80->50 after manager/pharmacist/cashier create+addLine 23:2x PKT. Code pharmacy-sales.ts:162-168 scopeFor (no cap/assignment) used by create (967) addLine; requireCounterReceiptAccess (381+) used by counterCart (1815), transition (1364). #509 CLOSED but reproduces (manager w/o counter cap created sale+line). ev cash-sale-cart2.png, out/rbac-sale.json
- N5 [Sev3] Counter keyboard: Enter/ArrowDown in search can't select a result (counter-console.tsx:1910-1927 no arrow handling, Enter reruns search); F6 swallowed while focus in Quantity (counter-keymap.ts:286-309) -> silent no-op. ev cash-sale-selected.png
- N6 [Sev3] Counter layout 1440x900: "Sale unit and quantity" card clips quantity stepper under next card; POS-04 "Workflow map" squashed. ev cash-sale-cart.png
- N7 [Sev3] Goods-in: after "File receipt (draft)" no confirmation, form keeps values, button greys; draft only appears in Receipts list. ev mgr-grn-filed.png
- RE #1010/#507 LIVE: cashier createSupplier+recordSupplierLicence(verified:true)+setSupplierAuthorization+createPO+submit; pharmacist approvePO 200; cashier send 200. 2026-11-02 ~23:1x PKT. out/rbac-purch-QA-RBAC-mvzktau8.json
- RE #509 (closed) reproduces (see N4).
- RE #520 discount approval caller-supplied (sales.ts:161-177).
- Owner assigned cashier+pharmacist to MAIN at ~23:30 PKT (setup change).
- N8 [Sev1/2] Counter: open bill lost on reload/failed tender (React state only, counter-console.tsx:309) AND its stock allocation persists; no list/resume/void UI; day close ignores OPEN bills (day-close.ts:32). Live: 6 abandoned bills held 90/100 units of QA-B1 -> "SHORT BY 10 UNITS" while shelf full. #420 CLOSED (sev3) reproduces + worse. 60 units still locked in 3 UI bills (ids unknown) 23:15-23:22 PKT.
- N9 [Sev3] Drawer bound to browser-local device id (localStorage); new profile/incognito/other PC -> DRAWER_NOT_OPEN, old drawer left open; tender attempt fails only at payment, then whole counter locks incl. Open drawer until Refresh bill. ev cash-sale6-pay1.png. #1070 (one-click zero float) reproduces.
- N10 [Sev3] After payment change due not visible (only in receipt preview below fold). ev cash-sale8-paid.png
- N11 [Sev3] Printed receipt: "Tax breakdown unavailable in receipt source", "Canonical units: 10", "Invoice: Receipt 2", no pharmacy address/phone/licence/NTN/time/cashier. ev qa-evidence/cash-receipt-print-en.png(.html). Urdu: mixed English (Invoice/CASH/PKR), dev text translated, monospace font, bidi date flip. ev cash-receipt-print-ur.png
- N12 [Sev3] Returns: sold STRIP labelled "1 BOX"/"One sold box contains 10 base units"; raw lot id + raw device id "counter-<uuid>" shown; "Receipt numbers can repeat" (per-device numbering). ev cash-return-lines.png cash-return-recorded.png
- RE #1016 LIVE: cashier recorded return + CASH refund PKR 28.00 alone 23:3x PKT. ev cash-refund-done.png
- RE #654 UI half: day-close-console.tsx:50 requires ADMIN; server requireCloseAccess allows pharmacy:close (pharmacist closePreview 200).
- #1015 closeDay part FIXED (cashier/manager closePreview 403).
- FEFO + MRP per batch OK: QA-B2 (exp 2027-01) sold at its MRP 28.00, change correct.
- Concurrent tester on tenant: QA-20261102-FUNC-* + drawer device QA-20261102-FUNC-DEVICE using QA Cashier account (opened 23:12 PKT).
- N13 [Sev1] Rx: no code path creates PharmacyPrescriber (only generated client) and no UI calls createPatient -> Prescriptions page Patient/Prescriber selects empty -> capture impossible -> every rx line has SAFETY_BLOCK RX_WITHOUT_PRESCRIPTION (counter-alerts.ts:146-167) -> no Rx medicine can be sold. Pharmacist live: "BLOCKED QA Amoxicillin ... requires a prescription". ev pharm-rx-add.png, pharm-rx-page.png. Related #1039 (copy only).
- N14 [Sev3] Counter Rx panel shows controlled-drug PIN/register fields + "No independent pharmacist with an active staff PIN is available" for a NON-controlled Rx line (counter-console.tsx:2408-2418). ev pharm-rx-add.png
- Rx gate for cashier works (403 needs pharmacist dispensing) -> #410 appears fixed; but cashier dead end, no handoff.
- RE #1012 LIVE: cashier createMedicine saleable antibiotic flagged OTC (QA-RBAC Azithromycin 500mg, id cmvzld69001u54oqrrmp2w1rm) 23:27 PKT.
- N15 [Sev2] PII: exportPatient (module-only, no capability) returns full unmasked phone (+923001234567) to Procurement user AND cashier, while readPatient masks it (*********4567). Live 23:30 PKT out/rbac2.json. Code pharmacy-prescriptions.ts:407.
- N16 [Sev2] 500: pharmacyReports.createPharmacovigilanceReport returns INTERNAL_SERVER_ERROR for owner/pharmacist/cashier. Input {branchId, kind:ADVERSE_DRUG_REACTION, occurredAt:now, assertedDescription}. 2026-11-02 23:31:08 PKT. out/pv500.json. Code pharmacy-reports.ts:233-276.
- N17 [Sev2] Cost price exposed to cashier: pharmacyInventory.expiryBoardLots rows include unitCostMinor (110), valueAtRiskMinor; pharmacyPurchasing.lotsFromReceipt includes inventoryLot.unitCostMinor; suppliers creditLimitMinor/paymentTermsDays. No reports:financial check. Live 23:31 PKT.
- RE #412 LIVE: Procurement user openDrawer + PAID_IN/PAID_OUT 100 + closeDrawer 23:30 PKT.
- RE #1036 LIVE: Procurement user createPatient + recordConsent(MARKETING, WHATSAPP, granted) 23:30 PKT.
- RE #517 LIVE: Procurement user exportPharmacovigilanceDrap 200.
