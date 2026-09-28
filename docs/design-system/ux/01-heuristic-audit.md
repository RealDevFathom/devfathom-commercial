# UX heuristic audit: POS, KDS, drawer/day-close, receiving, pharmacy counter

Status: findings for board review (WHA-1574)
Baseline: `d9957a9a` (`codex/restaurant-release-20260911`) · Method: code walk plus task analysis
Evidence: every finding cites `file:line` under `src/` at the baseline.

## How to read this

**Method**

- Each finding was derived from the rendered JSX, the Tailwind classes, and the handlers at the
  baseline.
- The baseline has no browser screenshots. No disposable DB lane was started, because the
  structure is fully determinable from code. Screenshot verification is part of each fix
  ticket's QA recipe (spec §8).
- Tap counts assume a trained cashier on a 1024×768 tablet with default channel DINE_IN and one
  published menu.

**Heuristics (Nielsen)**

| Code | Heuristic                       |
| ---- | ------------------------------- |
| H1   | Visibility of system status     |
| H2   | Match with the real world       |
| H3   | User control and freedom        |
| H4   | Consistency and standards       |
| H5   | Error prevention                |
| H6   | Recognition rather than recall  |
| H7   | Flexibility and efficiency      |
| H8   | Aesthetic and minimalist design |
| H9   | Error recovery                  |
| H10  | Help                            |

**Severity**

| Level | Meaning                                  |
| ----- | ---------------------------------------- |
| 4     | Blocks speed or causes money/stock error |
| 3     | Major slowdown or likely mistake         |
| 2     | Minor, frequent                          |
| 1     | Cosmetic                                 |

---

## 0. Cashier task analysis (summary)

| Task                                       | Surface          | Today (taps / typed fields / scrolls)                                                                                                                                                                                                                                                                                                                  | Reference café POS | Spec target              |
| ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------ |
| First item in cart                         | Restaurant POS   | **2 taps + 1 scroll**. Tile selects (`menu-grid.tsx:149`), then **Add to order**, which is below _every_ menu section (`menu-grid.tsx:169-275`)                                                                                                                                                                                                        | 1                  | 1                        |
| First item, dine-in with table             | Restaurant POS   | 3 taps + 2 scrolls. The table checkbox is in the _Open order_ card (`order-pad.tsx:1520-1554`); the menu is in another column                                                                                                                                                                                                                          | 2                  | 2                        |
| Takeaway, 1 item, cash exact, settled      | Restaurant POS   | **7 taps + 1–2 scrolls**. Tile → Add to order → Send order (`:1595`) → find the order in _Open orders_ (`:1679`), because the sent order does not become active (the queued path never calls `loadDetail`, `:916-938`) → Close order (`order-ticket-panel.tsx:420`) → Cut single bill (`checkout-panel.tsx:686`) → Apply tender (`tender-pad.tsx:203`) | 3                  | 3                        |
| Change qty to 3                            | Restaurant POS   | Type into a number field _before_ adding (`menu-grid.tsx:175`). After adding there is no qty edit: only Remove (draft) or Void (sent)                                                                                                                                                                                                                  | + +                | + +                      |
| Recover from a wrong item (unsent)         | Restaurant POS   | 1 tap (Remove). No undo                                                                                                                                                                                                                                                                                                                                | 1                  | 1 + undo                 |
| Recover from a wrong item (sent, pre-prep) | Restaurant POS   | Void → typed reason → Confirm (3 + typing)                                                                                                                                                                                                                                                                                                             | 2                  | 2–3                      |
| Bump a 5-item ticket                       | KDS              | **10 taps** (Start + Mark ready per item, `kds-board.tsx:70-73`)                                                                                                                                                                                                                                                                                       | 1                  | 1 (ticket bump)          |
| Close drawer                               | POS → Drawer     | Open dialog → type count → Close drawer (no confirm; label collides with _Close drawer panel_, `drawer-panel.tsx:314` vs `:329`)                                                                                                                                                                                                                       | —                  | count → review → confirm |
| First item                                 | Pharmacy counter | Type → Enter → Tab past Branch → Enter → **F6**. A barcode exact match never auto-adds (`counter-console.tsx:636`)                                                                                                                                                                                                                                     | —                  | scan = add               |
| To payment                                 | Pharmacy counter | F9 focuses the _container_, not an input (`counter-console.tsx:1059`), then about 6 Tabs                                                                                                                                                                                                                                                               | —                  | F9 → amount input        |

**Offline cues.**

- Restaurant POS: good coverage but disruptive. A pill in the header plus a full SectionCard
  that pushes the menu down (`order-pad.tsx:1214-1274`).
- KDS: good. _Last synced_ plus _Retry now_ (`kds-board.tsx:554-592`).
- Pharmacy counter: **none**. There is no `navigator.onLine` or offline state anywhere in
  `components/pharmacy/counter/`.

---

## 1. Restaurant POS (`/pos` → `order-pad.tsx`, `menu-grid.tsx`, `order-ticket-panel.tsx`, `checkout-panel.tsx`)

| ID   | Sev | H     | Finding                                                                                                                                                                                    | Evidence                                                     | Fix (ticket)                                                    |
| ---- | --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------- |
| P-1  | 4   | H7 H8 | The page scrolls. Five stacked cards (Open order, Composed order, Open orders, Menu, Ticket) sit inside `overflow-y-auto` main, and the primary controls end up below the fold at 1024×768 | `order-pad.tsx:1277-1795`, `:1847`                           | Single-screen frame (POS-UX-2)                                  |
| P-2  | 4   | H7    | Adding an item is two steps: select, then submit a form placed after all sections                                                                                                          | `menu-grid.tsx:149-153`, `:169-275`                          | One-tap tiles (POS-UX-3)                                        |
| P-3  | 4   | H1 H7 | After **Send order** the order is not made active; the cashier must find it in _Open orders_ to pay                                                                                        | `order-pad.tsx:916-938` (no `loadDetail` on the queued path) | Draft stays in cart and becomes the active order (POS-UX-5)     |
| P-4  | 3   | H4    | Two different "Send" buttons. **Send order** (persists and fires via the queue) vs **Send whole order** (fires an open order)                                                              | `order-pad.tsx:1612`, `order-ticket-panel.tsx:185`           | One **Send** (POS-UX-4)                                         |
| P-5  | 3   | H4 H2 | "Hold" means _course hold_ (kitchen pacing). The reference POS (and cashier vocabulary) uses Hold to mean _park the order_                                                                 | `order-ticket-panel.tsx:222-230`                             | Hold = park; course hold goes to the overflow menu (POS-UX-4/5) |
| P-6  | 3   | H6 H7 | Qty, course and seat are typed `type=number` inputs. There is no qty stepper on lines                                                                                                      | `menu-grid.tsx:173-211`, `order-pad.tsx:1624-1646`           | Steppers (POS-UX-3/4)                                           |
| P-7  | 3   | H1    | A single global `pending` string disables **every** control and shows "Request pending. Controls are paused." for any request, including a menu refresh                                    | `order-pad.tsx:226`, `:958`, `:1208-1209`                    | Per-intent pending (POS-UX-1)                                   |
| P-8  | 3   | H8    | Order setup is a form (Channel `<select>`, table checkboxes, covers, section select) that must be completed before the menu matters                                                        | `order-pad.tsx:1279-1615`                                    | Rail tiles + table sheet (POS-UX-2)                             |
| P-9  | 3   | H1    | Totals are one mono line at the bottom of the scrolling ticket (`Subtotal x · Tax y · Service z`). They are not pinned and there is no grand total                                         | `order-ticket-panel.tsx:413-419`                             | Pinned totals with a Total figure (POS-UX-4)                    |
| P-10 | 3   | H7    | Payment always requires **Cut single bill** before any tender, even with no split                                                                                                          | `checkout-panel.tsx:677-700`                                 | Auto-cut single bill (POS-UX-4)                                 |
| P-11 | 3   | H7    | Tender type is a `<select>`. Cash needs two typed fields (amount + received); there are no quick-cash buttons                                                                              | `tender-pad.tsx:125-165`                                     | Segmented tender + quick-cash (POS-UX-4)                        |
| P-12 | 2   | H2    | Unavailable items show **86** (kitchen slang) as the price                                                                                                                                 | `menu-grid.tsx:158`                                          | "Sold out" (POS-UX-3)                                           |
| P-13 | 2   | H8    | Every success prints a page-top Notice that shifts the layout, e.g. _"Chai added locally. No request was sent."_ (developer voice)                                                         | `order-pad.tsx:1721-1724`, `:1210`                           | Toasts + tile qty badge (POS-UX-3)                              |
| P-14 | 3   | H5 H3 | **Discard draft** and **Discard queued order** have no confirmation and no undo                                                                                                            | `order-pad.tsx:1647-1655`, `:1259-1268`                      | Confirm or 5s undo (POS-UX-4/5)                                 |
| P-15 | 2   | H1    | The ticket shows `channel.replaceAll('_',' ')` (DINE IN) and the raw status enum pills (PAYMENT_PENDING, REMAKE_REQUESTED)                                                                 | `order-ticket-panel.tsx:178`, `:182`, `:259`                 | Human status labels (POS-UX-4)                                  |
| P-16 | 2   | H8    | The header action row holds 3 status pills, operator switch, Drawer, Day close, Refund and Lock. These are money actions competing with the sale surface                                   | `order-pad.tsx:1127-1204`                                    | Register menu (POS-UX-2)                                        |
| P-17 | 2   | H6    | There is no customer search except inside Delivery. Loyalty is only in checkout                                                                                                            | `order-pad.tsx:1342-1437`, `checkout-panel.tsx:755`          | Customer strip (POS-UX-6)                                       |
| P-18 | 2   | H7    | Keyboard use: there are no shortcuts, and no search across the menu                                                                                                                        | — (no key handlers in `order-pad.tsx`)                       | Keymap + search (POS-UX-3)                                      |
| P-19 | 2   | H1    | The locked screen uses a `<select>` for the operator. A shared-device register should show operator tiles and a PIN pad                                                                    | `order-pad.tsx:1045-1099`                                    | PIN pad (POS-UX-2)                                              |
| P-20 | 1   | H4    | Money is printed as raw API strings with no grouping or currency (`1450.00`)                                                                                                               | throughout                                                   | Shared money formatter (POS-UX-4)                               |

**What works and must be kept:**

- idempotency keys per intent
- stale-response epoch guards
- a truthful offline policy (connected-only for money), with copy that already names what is
  unavailable (`order-pad.tsx:1220`)
- void rules (reason, and manager PIN post-prep, with no self-approval; `order-ticket-panel.tsx:128-136`)
- `aria-pressed` on toggles
- a skip link
- 44px targets on most controls

---

## 2. KDS (`/kds` → `components/restaurant/kds/kds-board.tsx`, `delivery-board.tsx`)

| ID   | Sev | H     | Finding                                                                                                                                                                                                        | Evidence                                                                                      |
| ---- | --- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| K-1  | 4   | H7    | Actions are per item. There is no **bump ticket**, so a 5-item ticket takes 10 taps                                                                                                                            | `kds-board.tsx:70-73`, `:741-751`                                                             |
| K-2  | 3   | H1    | Age is grey `text-xs` text with no colour escalation or SLA threshold, and it only refreshes when polling re-renders                                                                                           | `kds-board.tsx:121-126`, `:695-698`                                                           |
| K-3  | 3   | H1    | There are no audio or visual cues for new tickets                                                                                                                                                              | (no Audio/vibrate in the file)                                                                |
| K-4  | 3   | H2    | Modifiers, course/seat and **HOLD — DO NOT FIRE** are in 11px grey mono. They are unreadable at kitchen distance, and HOLD has a neutral tone                                                                  | `kds-board.tsx:59`, `:724-730`                                                                |
| K-5  | 3   | H8    | The Delivery handoff card sits above the lanes and pushes tickets down. The main area scrolls                                                                                                                  | `kds-board.tsx:604-610`, `:813`                                                               |
| K-6  | 2   | H7    | There is no station filter. The header shows the raw `station {stationId}`                                                                                                                                     | `kds-board.tsx:528`                                                                           |
| K-7  | 2   | H7    | No bump-bar or keyboard support                                                                                                                                                                                | (no key handlers)                                                                             |
| K-8  | 2   | H3    | Recall is one tap with no undo. Every button on the board disables while one action runs                                                                                                                       | `kds-board.tsx:334`, `:645`, `:745`                                                           |
| K-9  | 2   | H2    | Jargon: lane titles in raw enum caps, "bounded 50-ticket view… authoritative window", "Confirm transition", "server-confirmed handoff state", "verify the device secret", raw status words in the top-bar pill | `kds-board.tsx:117`, `:414-420`, `:472`, `:594-601`, `:630`; `delivery-board.tsx:217`, `:240` |
| K-10 | 2   | H3 H5 | **Disconnect** logs out in one tap with no confirmation                                                                                                                                                        | `kds-board.tsx:541-549`                                                                       |

**Keep:**

- the backoff polling
- _Last synced_ + _Retry now_
- skeleton loading
- a lane count per lane

**Direction:**

- tickets as columns ordered by age
- whole-ticket bump
- item-level strike on tap
- age colour at owner-set thresholds (e.g. 8/12 min), using warning then destructive tokens
  plus a text label
- new-ticket chime (setting)
- station switcher
- bump-bar keys (1–9 select, Enter bump, R recall)
- delivery handoff in its own lane or tab

---

## 3. Drawer and day close (`drawer-panel.tsx`, `day-close-panel.tsx`, `refund-panel.tsx`, `operator-switch.tsx`)

| ID  | Sev | H     | Finding                                                                                                                                                                        | Evidence                                               |
| --- | --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| D-1 | 4   | H5    | **Close drawer** has no confirmation, and its label is nearly identical to the footer **Close drawer panel**                                                                   | `drawer-panel.tsx:314`, `:329`                         |
| D-2 | 4   | H5    | **Close business day** has no final confirmation, after a 3-step flow                                                                                                          | `day-close-panel.tsx:273-279`                          |
| D-3 | 3   | H1    | Variance appears only _after_ closing, as plain mono text with no over/short wording or colour. The result lives in component state only, so it is lost when the dialog closes | `drawer-panel.tsx:210-223`                             |
| D-4 | 3   | H1 H6 | Day-close preview fetches `netSales` and `cashVariance` but does not show them. "Resolve N open orders and M open drawers" has no link to those orders                         | `day-close-panel.tsx:33`, `:37`, `:204-233`            |
| D-5 | 2   | H2    | The raw `drawerSessionId` is shown. The movement type "Drop" is unexplained. Error copy reads like a validator ("non-negative decimal with at most two places")                | `drawer-panel.tsx:78`, `:105`, `:136`, `:248`          |
| D-6 | 2   | H1    | There is no list of cash movements and no running expected balance during the shift                                                                                            | `drawer-panel.tsx:254-296`                             |
| D-7 | 2   | H4    | Day close: the business-date field is always disabled but drawn as editable. The correction reason and PIN inputs are 32px (`h-8`), and the PIN has no numeric keypad          | `day-close-panel.tsx:173`, `:242-268`                  |
| D-8 | 2   | H2 H4 | Refund: many controls are 32px. The copy "Confirm destructive refund… Frozen tax allocation is finalized by the server" is jargon. Tender type shows as the raw enum           | `refund-panel.tsx:286`, `:314-329`, `:343`, `:368-448` |

**Keep:**

- the blind count (expected is hidden until the count is entered; this is correct cash-control
  practice)
- manager co-auth for corrections and refunds
- the refund review → confirm step

**Direction:**

- A **three-step close sheet**: Count, then Review (expected, counted, variance labelled
  _Over 120.00_ / _Short 45.00_ with tone and text), then Confirm. The summary is printable and
  persisted.
- A movement log with a running total.
- Denomination counting (optional quick-count grid) for cash.

---

## 4. Inventory receiving (pharmacy `purchasing/receiving/page.tsx`; restaurant `purchasing/page.tsx` + `receiving-form.tsx`)

| ID  | Sev | H   | Finding                                                                                                                                                                              | Evidence                                                                                            |
| --- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| R-1 | 3   | H8  | Pharmacy receiving is one 1,274-line page: stats, exceptions, receive-against-PO, direct purchase (always 3 × 14 fields + 8 header fields) and receipts, all on one long scroll      | `app/(app)/pharmacy/purchasing/receiving/page.tsx:423-846`, `:74`, `:759-778`                       |
| R-2 | 3   | H5  | **Post into stock** and **Reverse posting** have no confirmation                                                                                                                     | `receiving/page.tsx:1161`, `:1182`                                                                  |
| R-3 | 3   | H5  | Rejected goods are entered in **units** while receipt quantities are in **packs**. This invites stock errors                                                                         | `receiving/page.tsx:959`, `:1016`                                                                   |
| R-4 | 3   | H9  | The batch-required error targets `field: 'batchNumber'`, but the inputs are `batchNumber:<lineId>`, so focus never reaches the offending line                                        | `receiving/page.tsx:218`, `:927`; `app/(app)/pharmacy/purchasing/_components/action-form.tsx:68-74` |
| R-5 | 3   | H3  | Scan or search reloads via GET, and the capture fields are uncontrolled `defaultValue`s, so a scan mid-entry likely drops unsaved typing (inferred from code; verify in the browser) | `receiving/page.tsx:556-566`, `:630-632`                                                            |
| R-6 | 2   | H2  | Requirement codes are shown to users as eyebrows: PUR-01/02/04/05                                                                                                                    | `receiving/page.tsx:440`, `:529`, `:670`, `:788`; `suppliers/page.tsx:217`                          |
| R-7 | 3   | H1  | Restaurant: the discrepancy's expected quantity uses `orderedQuantity`, not the outstanding balance. Wrong on a second partial delivery                                              | `app/(app)/restaurant/purchasing/receiving-form.tsx:481`                                            |
| R-8 | 2   | H2  | Restaurant: raw IDs appear (`order.reference \|\| order.id`, `stockItemId` fallback), and the Received column has no unit                                                            | `restaurant/purchasing/page.tsx:767`, `:805`, `:859`, `:865`, `:882`, `:918`                        |
| R-9 | 2   | H7  | Restaurant receiving has no scan, no outstanding-balance display, and quantity defaults to "0"                                                                                       | `restaurant/purchasing/page.tsx:893`                                                                |

**Keep:**

- plain-language validation that names the fix
- pre-filled outstanding packs
- idempotent "Retry same receipt" with entries preserved (restaurant, `receiving-form.tsx:91-100`, `:255`)
- automatic exception detection on post

**Direction:**

- A **receiving workbench**: pick a PO (or scan the invoice or a barcode), then a line table
  with inline batch/expiry/MRP/qty cells (keyboard grid: Tab across, Enter down), then review
  variances, then confirm post.
- Direct purchase is a separate route with "+ Add line".
- One unit selector per line.

---

## 5. Pharmacy dispensing counter (`/pharmacy/counter` → `components/pharmacy/counter/counter-console.tsx`)

| ID   | Sev | H     | Finding                                                                                                                                        | Evidence                                                                        |
| ---- | --- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| C-1  | 4   | H1    | There is **no offline indicator** anywhere on the counter                                                                                      | (no `onLine`/offline state in `components/pharmacy/counter/`)                   |
| C-2  | 4   | H5 H3 | **Void** is keyboard-only (Shift+F4), with no button, no confirmation, and a hard-coded reason "Voided from the counter."                      | `counter-console.tsx:1071`; `lib/pharmacy/counter-keymap.ts:86`                 |
| C-3  | 3   | H7    | An exact barcode or EAN match does not auto-add. Results have no arrow-key navigation. F9 focuses the tender container, not the amount input   | `counter-console.tsx:636`, `:1059`; `counter-search-results.tsx:121`            |
| C-4  | 3   | H3 H6 | The Rx panel is read-only. Tender says "Resolve it in the prescription panel", but the panel has no action and no link to the pharmacist queue | `counter-rx-panel.tsx:207-222`; `counter-tender-panel.tsx:221-226`              |
| C-5  | 3   | H1    | Only **one** held bill is tracked. Holding a second replaces the first in the UI                                                               | `counter-console.tsx:222`, `:711`                                               |
| C-6  | 3   | H8    | Three columns only at `xl`. Below that, Tender stacks under four cards. The permanent "Workflow map" keymap legend takes space                 | `counter-console.tsx:1313`, `:1440-1449`                                        |
| C-7  | 2   | H7    | Substitution **Choose** re-runs the search instead of staging the substitute                                                                   | `counter-console.tsx:1395-1399`                                                 |
| C-8  | 2   | H5    | Card and Wallet are offered, then refused by the server ("Require a certified payment provider")                                               | `counter-tender-panel.tsx:14-18`, `:259-263`                                    |
| C-9  | 2   | H5    | **Open drawer** posts a float of 0 with no input and no confirmation                                                                           | `counter-console.tsx:1265-1289`                                                 |
| C-10 | 1   | H2    | Requirement codes as eyebrows (POS-02, AI-05 · RX-04, CRM-L01, POS-09). The notice reads "Bill hold." / "Bill resume."                         | `counter-console.tsx:722`, `:1315`, `:1382`, `:1407`, `:1454`, `:1564`, `:1647` |

**Keep:**

- a keyboard-first design with a configurable keymap (F3/F4/F5 unit toggle)
- the FEFO allocation shown per line
- restriction pills (Controlled, Rx, High alert, Look-alike, Cold chain)
- non-bypassable safety blocks
- live change calculation
- the unknown-outcome "Check payment outcome" recovery

The counter principles for the next lane are in `04-pharmacy-counter-principles.md`.

---

## 6. Cross-cutting

| ID  | Sev | Finding                                                                                                                                                                         | Evidence                                                                    |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| X-1 | 3   | There is no shared money formatter on terminal surfaces. API strings are rendered raw                                                                                           | POS, drawer, refund, receiving                                              |
| X-2 | 2   | `Button` hard-codes `rounded-[3px]` and a default `h-8` (32px), against the contract (control radius 12px, ≥44px touch). Any control without an explicit `h-11` is under target | `src/components/ui/button.tsx:7`, `:25`; `input.tsx:12`                     |
| X-3 | 2   | Internal requirement codes (PUR-0x, POS-0x, RX-0x, AI-0x, CRM-x) leak into the UI as eyebrows                                                                                   | pharmacy pages                                                              |
| X-4 | 2   | Status enums are rendered raw (`replaceAll('_',' ')`) instead of through a label map                                                                                            | POS ticket, KDS lanes, platform lifecycle                                   |
| X-5 | 2   | Irreversible actions have inconsistent confirmation: some have none, some use a browser `window.confirm`, some have a proper review step                                        | see D-1, D-2, R-2, C-2; `components/platform/platform-command-form.tsx:515` |
| X-6 | 2   | `offline-queue-status.tsx` is built and tested but not mounted anywhere                                                                                                         | `components/restaurant/pos/offline-queue-status.tsx`                        |

**Recommended shared fixes (small, high leverage):**

1. `formatMoney(minor|string, currency)` plus a `<Money>` component.
2. `statusLabel(enum)` maps for order, item, bill and lifecycle statuses.
3. A `ConfirmAction` dialog recipe with three variants: _review → confirm_, _typed-name_
   (destructive/irreversible), and _undo toast_ (reversible).
4. A `Button size="touch"` (h-11) and `size="xl"` (h-14/16) for terminals.
5. Remove requirement codes from eyebrows.
