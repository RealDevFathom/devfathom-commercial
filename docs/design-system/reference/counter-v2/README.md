# Pharmacy counter v2: owner-approved design reference

Approved by the owner on 20 Nov 2026 ("This is PAge 2. I want this counter design.").
Source: the Design canvas "Pharmacy Counter Redesign", page 2, 22 artboards.

All 22 artboards are ONE interactive prototype file that differs only in its title, its preview
size and the `INITIAL` state constant near the bottom. `counter-v2-prototype.dc.html` is the
"A1 Bill ready to pay" copy. To see another state, change `INITIAL` to the value in the table.

This folder is visual and interaction reference only. It is not application code, is not
imported anywhere, and its sample data (names, medicines, prices, phone numbers, "SehatCart")
is made up. `docs/design-system/DEVFATHOM-STUDIO.md` and the tokens in `src/app/globals.css`
remain the source of truth for colours, type and components: where the prototype's own CSS
(`cv-*` classes) differs from a Studio token or shared component, use the Studio one and match
the layout, hierarchy, sizes and behaviour.

| State | Preview size | INITIAL |
| --- | --- | --- |
| A1 Bill ready to pay | 1440 x 900 | `{"bill": "sale", "kbd": true, "notice": "Calpol 120 mg/5 ml added · 1 unit."}` |
| A2 Split payment: cash + JazzCash | 1440 x 900 | `{"bill": "sale", "overlay": "pay", "method": "JAZZ", "tenders": [{"method": "CASH", "amount": 600, "ref": "Cash"}], "ref": "4501", "kbd": true, "notice": "Rs 600.00 by cash added. Rs 294.00 still to pay.", "payer": "Ali Raza"}` |
| A3 Paid, change and receipt | 1440 x 900 | `{"bill": "sale", "settled": true, "tenders": [{"method": "CASH", "amount": 894, "ref": "Received Rs 1,000.00 · change Rs 106.00", "received": 1000}], "change": 106, "overlay": "receipt", "kbd": true, "notice": "Paid. Receipt 2-0419 sent to the printer."}` |
| A4 Discount with supervisor approval | 1440 x 900 | `{"bill": "sale", "overlay": "discount", "disc": {"target": 2, "kind": "DISCOUNT", "mode": "rs", "value": "20", "approver": "hina", "pin": "4821"}, "kbd": true}` |
| A5 Controlled medicine (pharmacist) | 1440 x 900 | `{"role": "pharmacist", "bill": "controlled", "patient": "ayesha", "overlay": "controlled", "kbd": true}` |
| A6 Search by brand or generic | 1440 x 900 | `{"bill": "sale", "query": "amox", "resultsOpen": true, "kbd": true}` |
| A7 Payment not confirmed | 1440 x 900 | `{"bill": "sale", "overlay": "pay", "method": "JAZZ", "tenders": [{"method": "CASH", "amount": 600, "ref": "Cash"}], "payUnknown": "unknown", "attempt": {"method": "JAZZ", "amount": 294, "payer": "Ali Raza", "ref": "4501"}, "kbd": true}` |
| B1 Khata over the limit | 1024 x 768 | `{"bill": "sale", "customer": "tariq", "overlay": "pay", "method": "KHATA", "kbd": true}` |
| B2 Offline, selling on the lease | 1024 x 768 | `{"conn": "offline", "banner": "offline", "bill": "offline", "query": "mi", "resultsOpen": true, "kbd": true}` |
| B3 Returns and refunds | 1024 x 768 | `{"bill": "empty", "overlay": "returns", "ret": {"no": "2-0412", "found": true, "done": false, "sel": [true, false, false, false], "qty": [1, 2, 1, 2]}, "kbd": true}` |
| B4 Pack check, not matched | 1024 x 768 | `{"bill": "sale", "overlay": "pack", "pack": {"code": "(01)06291107350019(21)A7Q2X9", "state": "nomatch"}, "kbd": true}` |
| B5 Search error | 1024 x 768 | `{"bill": "sale", "query": "risek", "resultsOpen": true, "searchState": "error", "kbd": true}` |
| B6 Loading | 1024 x 768 | `{"pageLoading": true, "kbd": true}` |
| B7 Customer asked for it | 1024 x 768 | `{"bill": "sale", "query": "amoxil 500", "overlay": "demand", "customer": "ayesha", "demand": {"id": "amx", "text": "Amoxil 500 mg Capsule", "reason": "STOCKOUT", "qty": 2, "notify": true, "channel": "WHATSAPP", "reserve": true}, "kbd": true}` |
| B8 Easypaisa not set up | 1024 x 768 | `{"bill": "sale", "overlay": "pay", "method": "EASY", "manualMissing": ["EASY"], "kbd": true}` |
| C1 Tablet, safety blocks | 768 x 1024 | `{"bill": "blocked", "kbd": false}` |
| C2 Tablet, sale | 768 x 1024 | `{"bill": "sale", "kbd": false}` |
| C3 Phone, sale | 375 x 812 | `{"bill": "sale", "kbd": false, "notice": "Calpol 120 mg/5 ml added · 1 unit."}` |
| C4 Phone, cash and change | 375 x 812 | `{"bill": "sale", "overlay": "pay", "method": "CASH", "cash": "1000", "kbd": false}` |
| C5 Phone, receipt | 375 x 812 | `{"bill": "sale", "settled": true, "tenders": [{"method": "CASH", "amount": 894, "ref": "Received Rs 1,000.00 · change Rs 106.00", "received": 1000}], "change": 106, "overlay": "receipt", "kbd": false}` |
| C6 Phone, no permission (cashier) | 375 x 812 | `{"bill": "sale", "customer": "ayesha", "overlay": "noperm", "np": {"title": "Ask a pharmacist to redeem points", "body": "Redeeming loyalty points needs the dispensing permission. The pharmacist on duty or the owner can redeem them on this till. The bill stays open.", "who": "Pharmacists and the owner", "ok": "Got it"}, "kbd": false}` |
| C7 Phone, offline | 375 x 812 | `{"conn": "offline", "banner": "offline", "bill": "offline", "kbd": false}` |
