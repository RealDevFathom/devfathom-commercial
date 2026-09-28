# Pharmacy dispensing counter: UX principles (next lane)

Status: proposed (WHA-1574) · Surface: `/pharmacy/counter` → `components/pharmacy/counter/*`
Evidence: `01-heuristic-audit.md` §5 (C-1..C-10)

A pharmacy counter is **not** a café POS. The café screen optimises speed per tap. The counter
has to be fast **and** safe:

- every line carries a batch and an expiry
- some lines carry a prescription
- a few carry legal controls

Keep the restaurant spec's frame (single screen, pinned totals, one primary action, offline
banner). Change the centre of gravity from _tiles_ to _search + scan_.

## 1. Layout: one screen, three zones (≥1024)

| Left: find (≈38%)                                                                                 | Centre: bill (≈38%)                                                                                                               | Right: safety + pay (≈24%)                                                             |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Search/scan field (always focused after an add); results list with arrow keys; substitutes inline | Lines: name · strength · form · **unit (Pack/Strip/Unit)** · qty stepper · batch + expiry chip (FEFO) · line total; pinned totals | Patient + Rx card, safety blocks, pharmacist status → **Take payment** (primary, 64px) |

- Below 1024, the right zone becomes a bottom bar: `Safety ✓ · Total · [Pay]`. The Rx card
  opens as a sheet.
- Remove the permanent keymap legend. `?` opens a cheat sheet (audit C-6).
- Remove requirement codes (POS-02, RX-04, CRM-L01…) from eyebrows (audit X-3).

## 2. Principles

1. **Scan is add.**
   - An exact GTIN/EAN/alias match adds 1 of the default sale unit immediately, with FEFO batch
     allocation.
   - An ambiguous match opens the result list with the first row focused. `↑/↓` moves, `Enter`
     adds, and search refocuses after every add (audit C-3).
2. **Units are explicit and sticky per line.**
   - The Pack/Strip/Unit toggle lives on the line, not in a global panel. F3/F4/F5 act on the
     focused line.
   - The line always shows the unit name next to the qty (`2 strips`), never a bare number.
   - Unit changes re-price live.
3. **Safety is visible, never skippable, and always actionable.**
   - A block names _what_, _why_ and _who can clear it_, and gives the action in place:
     - `Request pharmacist check` sends the item to the pharmacist queue
     - `Attach prescription` opens capture
     - `Swap to substitute` stages the alternative
   - Never say "resolve it in the panel" without a button (audit C-4). The existing rule that
     blocks cannot be acknowledged past (`counter-rx-panel.tsx:37-38`) stays.
4. **Pharmacist verification is a hand-off, not a dead end.**
   - The counter sends the bill to verification, then parks it as `Awaiting pharmacist`, and
     the cashier can serve the next customer.
   - When the bill returns verified it pings (toast + badge on Pending), and it resumes with one
     tap.
   - Controlled lines show the running register balance inline, read-only.
5. **Substitution is one decision.**
   - **Choose** replaces the line in place and keeps the qty and unit. It records the reason and
     requires patient consent where the rule set says so.
   - **Decline** closes the demand (today's behaviour).
   - Never re-run the search to substitute (audit C-7).
6. **Many held bills, clearly listed.**
   - `Pending (n)` sheet (the same component as restaurant `held-orders-sheet`) with patient
     name, age, status (`Held` / `Awaiting pharmacist` / `Verified`) and total.
   - Holding a second bill must not orphan the first (audit C-5).
7. **Destructive actions are confirmed and explained.**
   - Void has a visible button, a reason picker (Wrong item / Customer declined / Price dispute /
     Other + text) and a confirm step. It's reachable by keyboard (Shift+F4), with the same
     dialog (audit C-2).
   - Open drawer asks for the float (audit C-9).
8. **Offline is stated, and medicine sales fail closed where the rules require it.**
   - Offline shows the same 36px banner as the restaurant POS, plus the safety-lease state:
     `Offline · Safety data valid until 14:20 · Controlled and Rx lines disabled`.
   - Lines that can't be sold offline are disabled with the reason. Without a cue, cashiers
     trust stale stock (audit C-1).
9. **Only offer tenders that work.**
   - Card and Wallet are hidden until a certified provider is configured for the branch.
   - Khata/credit shows the customer's limit and balance before it can be picked (audit C-8).
10. **F9 means "pay", and pay is keyboard-complete.**
    - F9 focuses the amount input with the balance selected.
    - `Enter` means exact cash, or F-keys pick quick notes.
    - Change is shown at display size. `Enter` again completes and prints.
    - Target: **≤ 3 keys** from bill to paid for exact cash.

## 3. Measurable targets for the lane

| Task                                | Today                                    | Target                           |
| ----------------------------------- | ---------------------------------------- | -------------------------------- |
| Scan → line in bill                 | Type/scan → Enter → Tab → Enter → F6 (5) | 1 (scan)                         |
| Bill → paid (exact cash)            | F9 + ~6 Tabs/keys                        | ≤ 3 keys                         |
| Rx block → pharmacist request       | No path from the counter                 | 1 tap                            |
| Hold two bills and resume the first | Not possible (single slot)               | 2 taps                           |
| Void a line                         | Keyboard only, no confirm                | Button or key → reason → confirm |
| Offline visible                     | Never                                    | Always, within 1s of loss        |

## 4. Reuse from the restaurant redesign

- `pos-frame` (terminal recipe)
- `offline-banner`
- `held-orders-sheet`
- `customer-strip` (as the patient strip, with masked identifiers only)
- the `ConfirmAction` recipe
- the shared money formatter and `statusLabel` maps
- the keymap cheat-sheet dialog
