# Pharmacy counter: return/refund, drawer and day close, Rx capture

Status: proposed, for board review (WHA-1583) · Baseline: `13af3d1e` · Owner: UX consultant
Implements: PHC-UX-1..6 (see `09-ux02-acceptance-criteria.md`)
Builds on: `04-pharmacy-counter-principles.md` (layout, safety, units) and
`02-pos-single-screen-spec.md` (frame, Register menu, held-orders sheet, ConfirmAction). Offline
wording comes from `08-offline-state-language.md`.

The counter at `/pharmacy/counter` (`src/components/pharmacy/counter/counter-console.tsx`) can
sell, hold one bill, void an open bill and take payment. The server can do more than that, but
three money and safety flows have **no screen**:

| Flow                     | Server today                                                                                                                                                                                                                | UI today                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Customer return + refund | `pharmacySales.returnLine` (`src/server/routers/pharmacy-sales.ts:373-395` → `src/lib/pharmacy/sales.ts:273-334`) and `pharmacySales.refundTender` (`pharmacy-sales.ts:280-302` → `src/lib/pharmacy/settlement.ts:438-548`) | None. No component calls either procedure                                                                                              |
| Drawer close / day close | `openDrawer`, `drawerMovement`, `closeDrawer`, `dailyClose` (`pharmacy-sales.ts:201-265`; `settlement.ts:582-780`)                                                                                                          | Only **Open drawer**, and it always posts a float of 0 (`counter-console.tsx:1265-1289`; audit C-9)                                    |
| Prescription capture     | `pharmacyPrescriptions.capture` (`src/server/routers/pharmacy-prescriptions.ts:129-164`) takes `sourceFileRef` as a plain string; authenticated `/api/upload` and `/api/files/[name]` exist                                 | Back office only, and the file reference is faked as `capture://${file.name}` (`prescriptions-console.tsx:91`). Nothing on the counter |

This spec designs those three flows so the counter feels like the restaurant register: one
screen, a **Register menu** for money operations, sheets instead of page changes, one primary
action per step, and the same confirmation and offline language.

Where a flow needs a backend change, this document marks it **[P-API-n]** and lists it in §7.
Every flow has a **ships-without-the-API** default so UI work isn't blocked.

---

## 1. Shared frame for the three flows

### 1.1 Where they live

The counter uses the three-zone layout from `04` §1. Money and admin actions move out of the
page body into a **Register menu** (`⋯` in the 56px top bar, a `DropdownMenu`). It's the same
component and order as the restaurant `register-menu.tsx` (`02` §3.2):

| Register menu item   | Opens                       | Shortcut (devfathom preset) | Enabled when                               |
| -------------------- | --------------------------- | --------------------------- | ------------------------------------------ |
| Cash drawer          | Drawer sheet (§3.1)         | —                           | Always (shows Open or the live drawer)     |
| Return / refund      | Return sheet (§2)           | `Shift+F9`                  | Online, and the operator may refund (§2.6) |
| Close drawer         | Close-drawer sheet (§3.2)   | —                           | Online, and this device has an OPEN drawer |
| Close day            | Close-day sheet (§3.3)      | —                           | Online, and the operator may close the day |
| Reprint last receipt | Receipt view                | `F10` (unchanged)           | A receipt exists this session              |
| Controlled register  | Pending entries list (§4.6) | —                           | Pharmacist role                            |
| Lock terminal        | PIN pad                     | `Ctrl+L`                    | Always                                     |

- Offline, the money items stay **visible but disabled**, each with the reason inline (`08` §4).
  They are not hidden, so the cashier learns what's waiting for the connection.
- New keymap actions: `returnRefund` (`Shift+F9`) and `attachPrescription` (`Shift+F7`). They're
  added to both presets in `src/lib/pharmacy/counter-keymap.ts`. Neither preset binds these keys
  today (`counter-keymap.ts:75-114`). The existing keymap conflict check must pass.

### 1.2 Sheet grammar (all three flows)

- A right `Sheet`, **720px** at ≥1280 and **100% width** below 1024. The bill stays visible
  behind it at ≥1280 so the cashier doesn't lose context.
- **Stepper header** (48px): numbered steps with the current one filled. Back never loses input.
- **Footer** (64px, pinned): secondary action on the left (`Back` / `Cancel`), **one** primary
  action on the right, named for what it does (`Refund Rs 450`, `Close drawer`, `Save
prescription`). Never "Submit" or "Continue".
- `Esc` closes the sheet. If the sheet holds input, closing asks _"Discard this return?"_.
- Errors show inline next to the field and as a toast, in the format
  _what failed + what is safe + next action_ (`02` §5).
- Money uses the shared `<Money>` formatter (audit X-1): `Rs 1,250.00` in `font-mono
tabular-nums`. The server's integer minor units are never shown raw.
- Every step is fully keyboard operable. `Enter` activates the primary action when the step is
  valid.

### 1.3 Pack levels in every flow

A pharmacy quantity is meaningless without its unit. Everywhere in these flows:

- Show quantity **with the unit name and base units**: `2 strips (20 tablets)`,
  `1 box (3 strips · 30 tablets)`, `7 tablets`. The names come from the `PackLevel` chain labels
  (`prisma/schema.prisma:502-536`), not from the generic PACK/STRIP/UNIT enum.
- Steppers step in the **line's sale unit** by default. A unit switch (`Box | Strip | Tablet`,
  the same `counter-unit-toggle.tsx` control) lets the cashier return part of a strip as loose
  tablets.
- Conversion to `canonicalUnits` happens in the client with `src/lib/pharmacy/pack-conversion.ts`.
  The server only receives base units (`returnLine.canonicalUnits`).

### 1.4 Urdu aliases

- Counter search already matches `MedicineAlias` rows of type `URDU` by prefix
  (`src/lib/pharmacy/counter.ts:170-180`). The result row doesn't show which alias matched.
- Show the matched alias under the English name: `Panadol 500mg tablet` / `پیناڈول` (in a
  `<span lang="ur" dir="rtl">`, 16px, line-height 1.9 so Nastaliq glyphs don't clip). [P-API-1]
  returns the matched alias text with each search result. Until it ships, no alias line is shown.
- The same alias line appears on bill lines, return lines and the Rx line picker, so a cashier
  who searched in Urdu recognises the medicine in every flow.
- Directions can be captured in Urdu (§4.3). Printed receipts and return notes print Urdu
  directions when present.

---

## 2. Return and refund

### 2.1 What the server does today (and what the UI must respect)

- A return is **per sale line**, in base units, on a COMPLETED sale. Returning more than what's
  left gives `RETURN_EXCEEDS_SOLD` (`sales.ts:289-292`).
- Returned stock **always goes to quarantine** (`disposition: 'QUARANTINE'`, `sales.ts:304-318`).
  It is never put back on sale directly. That's the right rule for medicines, so the UI says it
  plainly and never offers "Back to shelf".
- The return is taken from **one** batch allocation that covers the whole quantity. It is not
  split across batches, and a quantity larger than any single allocation fails with
  `INVALID_QUANTITY` (`sales.ts:293-294`). See §2.5.
- `returnLine` moves **no money**. The refund is a separate `refundTender` call against one
  original tender. It can't exceed that tender's amount (`REFUND_EXCEEDS_TENDER`). Cash needs an
  open drawer on this device. Card and Wallet need a certified adapter, which the router never
  passes, so over tRPC they always fail (`settlement.ts:481-492`).
- **No procedure checks role or capability** (`pharmacy-sales.ts`, every procedure is
  `protectedProcedure`). There is no manager approval anywhere. [P-API-2]
- There is no sale lookup by receipt number, patient or date. `counterReceipt` only re-reads a
  known `saleId` (`pharmacy-sales.ts:640-663`). [P-API-3]

### 2.2 Flow (four steps in one sheet)

```
┌ Return / refund ─────────────────────────────────────────── 720px sheet ┐
│ ① Find sale ─ ② Items ─ ③ Condition ─ ④ Refund                         │
├─────────────────────────────────────────────────────────────────────────┤
│ ② Items to return · Receipt R-0412-00873 · 26 Sep 14:12 · Ayesha K.    │
│ Paid: Cash Rs 1,340 · Patient: M. Iqbal (••••4412)                      │
│ ┌──────────────────────────────────────────────────────────────────────┐│
│ │ [✓] Augmentin 625mg tablet   اگمنٹن                                 ││
│ │     Sold 2 strips (12 tab) · Batch A2291 · Exp 03/27  Rx             ││
│ │     Return [−] 1 [+]  strip ▾   = 6 tablets          Rs 540.00      ││
│ │ [ ] Panadol 500mg tablet                                             ││
│ │     Sold 1 strip (10 tab) · Batch P7710 · Exp 11/26                  ││
│ │ [ ] Tramadol 50mg capsule    ⚠ Controlled · can't return at counter ││
│ └──────────────────────────────────────────────────────────────────────┘│
│                                           Returning 6 tablets · Rs 540 │
├─────────────────────────────────────────────────────────────────────────┤
│ [Back]                                               [Next: condition] │
└─────────────────────────────────────────────────────────────────────────┘
```

**① Find sale**

- A single search field, focused on open: _Scan receipt barcode or type receipt number_. The
  scanner acts as a keyboard. An exact receipt match goes straight to ②.
- Secondary finders under it: **Patient** (masked search via `counterPatients`) and **Today's
  sales on this counter** (a list of the last 20, newest first: time, receipt #, total, tender).
- Result rows show: receipt #, date/time, cashier, total, tender(s), and a status pill
  (`Returnable` / `Partly returned` / `Fully returned` / `Outside return window`).
- Needs [P-API-3]. **Ships-without-API default:** only the _current session's_ sales are listed.
  The counter records the `saleId` of each sale it completes (it already reads receipts by
  `saleId` through `counterReceipt`), and lists those from session memory. The receipt-number field is shown but disabled with the hint _"Receipt lookup
  is coming — pick from today's sales on this counter"_.

**② Items**

- Every sold line, each with a checkbox, name + Urdu alias, sold qty with unit, batch + expiry,
  restriction pills (the existing `Rx`, `Controlled`, `High alert`, `Cold chain` pills), and
  _already returned_ when > 0 (`1 strip returned on 27 Sep`).
- Checking a line sets the return qty to **all that's left** of the line in its sale unit. The
  cashier lowers it with the stepper or switches units.
- The row shows the refund value for that qty, pro-rated from the line's price after discount
  (`unitPriceMinor`, `discountMinor`). Labelled **Estimate** until [P-API-4] returns the
  server-computed refundable amount.
- Lines that can't be returned are shown **disabled with the reason** (§2.4), never hidden.
- Footer summary: `Returning 6 tablets · Rs 540`. Primary: **Next: condition**.

**③ Condition** (one card per selected line)

- **Reason** (required, a radio list with 44px rows; maps to `returnLine.reason`):
  - Wrong medicine given
  - Doctor changed the prescription
  - Side effect / reaction _(also flags the line for pharmacist review, §2.4)_
  - Customer changed mind
  - Damaged or expired at sale
  - Other _(requires ≥ 10 characters of text)_
- **Pack condition** (required; maps to `returnLine.integrityDecision`):
  - Sealed, unopened
  - Strip intact, box opened
  - Opened / partly used
  - Cold chain unknown _(only shown for cold-chain lines)_
- A fixed notice for every line: _"Returned stock goes to quarantine for the pharmacist to
  check. It isn't put back on sale."_ The **quarantine location** is chosen automatically when
  the branch has exactly one. If there are several, a picker shows. If there are none, the step
  is blocked with _"No quarantine location at this branch — ask a manager to add one in
  Inventory"_ and a link. (The server doesn't check that the location is in this branch or is a
  quarantine location, see [P-API-5].)
- Primary: **Next: refund**.

**④ Refund**

- **Refund to** shows the original tender(s), with the refundable amount against each one
  (tender amount − already refunded):
  - `Cash Rs 1,340 · refundable Rs 1,340` → **Cash from drawer**. Needs an open drawer on this
    device. If none is open: _"Open the cash drawer first"_ with an **Open drawer** button that
    opens §3.1 in place and returns here.
  - `Khata (M. Iqbal) Rs 800` → **Credit back to khata**, showing the new balance.
  - `Loyalty 120 pts` → **Restore points**.
  - `Card` / `Wallet` → disabled with _"Card refunds need the card terminal. Give cash or khata
    credit instead, with the customer's agreement."_ The UI never lets the cashier pick a tender
    the server will refuse (principle 9 in `04`).
  - `Bank transfer` → **Record bank refund** (recorded only; the money moves outside the
    system). A reference text field is required.
- For a split-tender sale, the default split refunds **cash last**: khata first, then loyalty,
  then cash. The cashier can edit the amount per tender with steppers. The sum must equal the
  refund total. Owner decision **D-P3**.
- **Review block** (read-only, above the footer): `Return 6 tablets of Augmentin 625mg to
quarantine · Refund Rs 540 cash · Reason: Doctor changed the prescription`.
- **Approval** (§2.6): when needed, a PIN pad appears inline under the review block. It's the
  same 3×4 keypad as the lock screen. It's not a separate dialog.
- Primary: **Refund Rs 540** (destructive tone is **not** used; a refund is a normal money
  action). Cash refunds also show the display-size amount to hand back: `Give Rs 540.00`.

**Done state** (replaces the sheet body)

- `Returned and refunded` + the summary, **Print return note** (focused, `Enter` prints) and
  **Done**.
- The return note has the original receipt #, lines in unit language, the quarantine notice,
  the refund per tender, the cashier and the approver. It carries no directions, because it's not
  a dispensing document.
- The sale's status in ① becomes `Partly returned` or `Fully returned`.

### 2.3 Call order, idempotency and partial failure

1. For each selected line: `returnLine` with its own idempotency key
   (`return:{saleLineId}:{attemptId}`). The key is reused on retry and dropped after a definitive
   4xx (the same rule as the POS, `03` POS-UX-1 AC 4).
2. Then, for each tender in the refund plan: `refundTender` with key
   `refund:{originalTenderId}:{attemptId}`.
3. The plan (`attemptId`, lines, tenders, which calls have succeeded) is saved before the first
   call in the same device storage as `tender-attempt-storage.ts`. A reload or crash resumes
   where it stopped.

**Partial failure is a first-class state, not an error toast.** If the returns succeed and a
refund call fails, or its outcome is unknown:

- The sheet shows a warning panel: _"Items are back in quarantine. The refund of Rs 540 hasn't
  been paid yet. Don't hand over cash until this says Refunded."_
- **Retry refund** resends with the **same** key. The server's replay returns `replayed: true`
  if the first call had actually landed (`settlement.ts:453-461`), so a retry can never pay
  twice.
- An unfinished refund shows in the **Pending (n)** sheet as a row with status `Refund not
paid`, so it can't be forgotten when the sheet closes. Close day is blocked while one exists
  (§3.3).

Error copy map (the server codes are never shown raw):

| Server code                   | Cashier copy                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `RETURN_EXCEEDS_SOLD`         | _Only {n} {unit} left to return on this line ({m} already returned)._                                                    |
| `INVALID_QUANTITY`            | _This line came from two batches. Return up to {max} {unit} now, then return the rest as a second step._ (§2.5)          |
| `NOT_FOUND` on `returnLine`   | _This sale isn't completed, so it can't be returned. Void it from the bill instead._                                     |
| `REFUND_EXCEEDS_TENDER`       | _The refund is more than was paid by {tender}. Lower the amount or refund part to another tender._                       |
| `UNCERTIFIED_PROVIDER`        | (can't happen from the UI, because §2.2 ④ disables those tenders)                                                        |
| `DRAWER_NOT_OPEN` (500 today) | _No cash drawer is open on this counter. Open it, then retry the refund._ ([P-API-6] maps it to a 4xx)                   |
| `IDEMPOTENCY_CONFLICT`        | _This refund was already sent with different details. Close this sheet and check the sale's status before trying again._ |

### 2.4 Regulatory gating per line

| Line type                            | Counter behaviour                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OTC                                  | Returnable within the window                                                                                                                                                                                                                                                                                                  |
| Rx (`rx`)                            | Returnable. The return is also posted to the pharmacist queue as an FYI item (**[P-API-7]**; until then a toast tells the cashier to inform the pharmacist). The prescription's fill count is **not** credited back; owner decision **D-P4**                                                                                  |
| Controlled (`controlled`)            | **Not returnable at the counter** by default (**D-P1**). Disabled with _"Controlled medicines are returned by the pharmacist in charge, with a register entry."_ Pharmacist role: the line is enabled, and completing the return opens the controlled-register entry form prefilled (§4.6) as a required step before **Done** |
| Cold chain (`coldChain`)             | Returnable. Pack condition options change to _Cold chain kept (customer attests)_ / _Cold chain unknown_. The quarantine notice adds _"Likely to be written off"_                                                                                                                                                             |
| High alert (`highAlert`)             | Returnable, and requires approval (§2.6) regardless of amount                                                                                                                                                                                                                                                                 |
| Outside the return window (**D-P2**) | Disabled with _"Sold {n} days ago. Returns are accepted within {window} days."_ A manager can override with PIN and reason                                                                                                                                                                                                    |
| Fully returned                       | Disabled, _"Already returned on {date}"_                                                                                                                                                                                                                                                                                      |

### 2.5 Split-batch lines

When a line drew from two batches (FEFO allocation, `src/lib/pharmacy/stock-ledger.ts:418`), the
item row shows both: `Batch A2291 · 8 tab · Exp 03/27` and `Batch A2310 · 4 tab · Exp 05/27`.

- With [P-API-8] (`returnLine` accepts an optional `allocationId`), the cashier picks which batch
  is coming back. The default is the batch printed on the returned pack (the cashier confirms
  it by scanning the pack's barcode if it carries a GS1 lot).
- **Ships-without-API default:** the stepper's maximum is the largest single allocation. The
  over-limit message from §2.3 explains why, and the remaining qty can be returned in a second
  pass through the same sheet.

### 2.6 Who can refund

There's no server check today. [P-API-2] adds a `pharmacy:refund` capability plus an approval
threshold in branch settings. The UI rules, which are enforced client-side until then:

| Situation                                                                                      | Needs                                              |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Refund ≤ Rs 2,000 (**D-P5** threshold), OTC/Rx, within window, same business day, same cashier | Nothing extra                                      |
| Above the threshold, another cashier's sale, a previous business day, or any high-alert line   | Manager / pharmacist-in-charge PIN on step ④       |
| Outside the return window                                                                      | Manager PIN + override reason                      |
| Controlled line                                                                                | Pharmacist role (operator) + register entry (§4.6) |

The approver's name is shown on the review block and printed on the return note. Client-side
enforcement is labelled in the code as a stop-gap; the ticket is not accepted as a security
control.

---

## 3. Drawer and day close

The counter reuses the restaurant close pattern from audit §3 _Direction_ (`01-heuristic-audit.md`):
**Count → Review → Confirm**, a blind count, over/short language with tone and text, a
printable summary that survives the dialog closing, and a movement log.

### 3.1 Cash drawer sheet (open, movements)

- **Closed drawer:** _"No drawer open on this counter"_ + **Opening float** field (PKR note
  quick-buttons: `0`, `1,000`, `2,000`, `5,000`, plus a stepper field) + **Open drawer**. Fixes
  audit C-9 (today the float is always 0).
- **Open drawer:** header `Drawer open since 09:02 · Ayesha K. · Float Rs 2,000`.
  - **Movement log** (newest first): time, type in words (`Opening float`, `Cash sale R-00873`,
    `Cash refund R-00873`, `Paid in`, `Paid out`), amount with sign, actor. No running expected
    balance is shown while the drawer is open, so the blind count at close stays blind.
    [P-API-9] provides the movement list; until it ships, the log shows only this session's
    movements from the counter's own memory, labelled _"This session only"_.
  - **Paid in** / **Paid out** buttons open an inline form: amount (stepper + note buttons),
    reason picker (_Change top-up_, _Supplier cash payment_, _Utility / petty cash_, _Bank
    deposit_, _Other_ + text) → `drawerMovement`. Paid out above **D-P5** needs a manager PIN.
  - **Close drawer** → §3.2.

### 3.2 Close drawer (per device, end of shift)

```
① Count ──────── ② Confirm ──────── ③ Result
```

**① Count (blind).** The expected amount is never shown on this step.

- A **denomination grid** for PKR: notes 5,000 · 1,000 · 500 · 100 · 50 · 20 · 10 and coins 5 · 2
  · 1. Each row has a stepper and a typed field (the number keys work), and shows the row total.
  The grand total is pinned at display size.
- A toggle **Enter total only** replaces the grid with one amount field, for counters that count
  by hand.
- Denominations are a counting aid. The server takes only `countedCashMinor`. They're printed on
  the close slip and kept in device storage for that slip. [P-API-10] can store them later.
- Primary: **Next**.

**② Confirm.** A `ConfirmAction` review step:

- _"Close this drawer with **Rs 23,450** counted? This counter can't take cash after closing
  until a new drawer is opened."_
- If the branch sells controlled medicines and this is the last open drawer of the day, a
  reminder links to the controlled count (§3.3 ③). It does not block.
- Primary: **Close drawer** (with destructive tone, because it's irreversible for this session).
  This fixes audit D-1 for the counter.

**③ Result.** Shown from the `closeDrawer` response (`expectedCashMinor`, `varianceMinor`):

| Variance | Display                                                                                     |
| -------- | ------------------------------------------------------------------------------------------- |
| 0        | `Balanced` · `StatusPill tone="success"`                                                    |
| > 0      | `Over Rs 120.00` · `tone="warning"` · the text says **Over**, colour is not the only signal |
| < 0      | `Short Rs 450.00` · `tone="danger"`                                                         |

- Also shown: counted, expected, float, cash sales, cash refunds, paid in, paid out.
- **Print close slip** (focused) and **Done**. The result is kept in device storage until the
  next drawer opens, and **Reprint last close slip** appears in the drawer sheet. It's never
  lost when the sheet closes (fixes audit D-3 for the counter).
- **Recount.** Proper cash control allows one recount before committing when the variance is
  large. That needs a preview call that returns the variance without closing [P-API-11]. With
  it, ② gains _"Short Rs 450 — recount once?"_ when |variance| > **D-P6**, and both counts are
  logged. Without it, there's no recount; the variance is final and goes to the journal
  (`src/lib/pharmacy/finance-postings.ts:657-675`).

### 3.3 Close day (branch, once per business date)

```
① Check ──────── ② Review ──────── ③ Controlled count ──────── ④ Confirm
```

**① Check (preconditions).** A checklist; each row has a status and a fix action:

| Check                                       | Blocks?                  | Source                                                         | Fix action                                                                     |
| ------------------------------------------- | ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| All drawers closed                          | Yes                      | Server `OPEN_DRAWER` (`settlement.ts:698-780`); list [P-API-9] | `Close drawer` (this device) or the name of the device that still has one open |
| No unfinished refunds on this device (§2.3) | Yes                      | Device storage                                                 | `Open` → resumes the return sheet                                              |
| No queued offline sales on this device      | Yes                      | Counter queue (`08` §5)                                        | `Retry now`                                                                    |
| Held bills                                  | No (warning)             | Pending sheet                                                  | `Review held bills`                                                            |
| Bills awaiting pharmacist                   | No (warning)             | Pending sheet                                                  | `Open pharmacist queue`                                                        |
| Controlled register entries still to write  | Yes, if **D-P7** says so | §4.6 list                                                      | `Open register`                                                                |

Checks that can't be verified yet (because the API is missing) show as `Not checked` with the
reason, never as a green tick.

**② Review.** From the `dailyClose` preview figures [P-API-12]; see the fallback below.

- Gross sales, refunds, **net sales**, cash expected / counted / variance (over/short language as
  in §3.2), and the number of drawers.
- **By tender** (Cash · Khata · Bank · Loyalty) needs [P-API-12]; until then the row is omitted,
  not shown as zero.
- **Ships-without-API default:** `dailyClose` has no preview mode; it computes and commits in one
  call. So ② is skipped and ④ shows _"Close day for Sat 28 Sep? Figures are calculated when you
  close."_ The figures appear on the result screen.

**③ Controlled count** (pharmacist only; shown when the branch sold or received controlled
medicines that day).

- One row per controlled medicine moved today: name, register running balance, **Counted**
  stepper in base units, and the difference.
- Sent as `controlledCountHook` on `dailyClose` (the field already exists,
  `pharmacy-sales.ts:250-265`).
- A difference requires a note and is highlighted as a danger row. It does not block the close;
  it's a regulatory record.
- A cashier who isn't a pharmacist sees this step as _"Pharmacist count needed"_ with **Skip —
  pharmacist will count** when **D-P7** allows it.

**④ Confirm.** `ConfirmAction` with a manager PIN:

- _"Close business day **Sat 28 Sep** for **Gulberg branch**? Sales after this are dated **Sun
  29 Sep**."_
- Primary: **Close day**.

**Result:** the day-close summary (figures, sequence number, actor, time), **Print Z summary**
and **Done**.

**Already closed.** Opening Close day for a date that's closed shows
_"Closed at 22:14 by Ayesha K. · Close #1"_ with the summary and a secondary **Reopen and close
again**. That needs a reason (≥10 chars; the server requires `reopenReason`,
`REOPEN_REASON_REQUIRED`) and a manager PIN. It writes a new sequence that supersedes the old
one. Copy: _"This replaces close #1. The old figures stay in the history."_

**Sales after close.** The server doesn't stop them (`tender` and `addLine` don't check for a
close) and takes `businessDate` from the client. The counter therefore moves its business date
to the next day once the close succeeds. A 36px info banner (not warning) reads _"Day closed ·
new sales are dated Sun 29 Sep"_ for the rest of that session. [P-API-13] enforces this on the
server. Owner decision **D-P8** covers pharmacies that trade past midnight.

**Error mapping.** `dailyClose` and `closeDrawer` errors arrive as INTERNAL_SERVER_ERROR today
because they don't pass through `fail()` [P-API-6]. The UI maps the message text (`OPEN_DRAWER`,
`DRAWER_NOT_OPEN`, `REOPEN_REASON_REQUIRED`) to copy. Any other 500 shows _"Close didn't
finish. Nothing was changed. Retry, and call support if it happens again."_

---

## 4. Prescription capture

### 4.1 Entry points (all open the same Rx sheet)

1. **From a safety block.** A bill line with `Prescription needed` shows the action button
   **Attach prescription** in the block itself (principle 3 in `04`).
2. **Patient card** in the right zone: **+ Prescription**.
3. `Shift+F7` (`attachPrescription`) opens the sheet for the focused line, or the first blocked
   line.
4. Back office `/pharmacy/prescriptions` uses the same sheet component, so there's one capture
   UI, not two.

### 4.2 Flow (one sheet, four steps; typical path is 3 taps + typing)

```
┌ Attach prescription ────────────────────────────────── 720px sheet ┐
│ ① Photo ─ ② Patient & doctor ─ ③ Medicines ─ ④ Check & save      │
├────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────┐   Source                               │
│ │                          │   (●) Paper Rx at counter              │
│ │   [ live preview /       │   ( ) WhatsApp photo                   │
│ │     captured page 1 ]    │                                        │
│ │                          │   Pages: [1] [2] [+ Add page]          │
│ └──────────────────────────┘   [⟲ Rotate] [Retake]                  │
│ [ 📷 Take photo ]  [ ⬆ Upload file ]                                │
│ ☐ I can read the doctor's name, the date and every medicine        │
├────────────────────────────────────────────────────────────────────┤
│ [Cancel]                                        [Next: patient]    │
└────────────────────────────────────────────────────────────────────┘
```

**① Photo**

- **Take photo**: `<input type="file" accept="image/*" capture="environment">` on tablets and
  phones (opens the rear camera). On desktop, it opens a webcam capture dialog if a camera
  exists; otherwise the button is hidden and **Upload file** is primary.
- **Upload file**: images or PDF, the same allowlist and size cap as `/api/upload`.
- **Source**: `Paper Rx at counter` (→ `sourceKind: PAPER_IMAGE`) or `WhatsApp photo`
  (→ `WHATSAPP_PHOTO`). This is a required choice, defaulting to paper.
- **Pages**: up to 4. Multi-page prescriptions are common. The model stores one
  `sourceFileRef`, so [P-API-14] adds an attachment list. **Ships-without-API default:** pages
  are combined client-side into one PDF, and one file is uploaded.
- Rotate and retake per page. Images are downscaled to ≤2000px on the long edge and re-encoded
  as JPEG q≈0.8 before upload, to keep it quick on shop Wi-Fi or mobile data.
- **Legibility check** (required checkbox): _"I can read the doctor's name, the date and every
  medicine."_ Unreadable prescriptions are the main dispensing risk, and the check prompts a
  retake.
- Upload starts as soon as a page is captured, with a progress bar per page, so step ② isn't
  waiting. The file goes to `POST /api/upload` (authenticated, tenant-scoped; delivery through
  `GET /api/files/[name]` needs a session). The returned `/api/files/...` path becomes
  `sourceFileRef`. The fake `capture://` reference is removed.
- **No photo available** (the patient keeps the paper and won't leave it): a link **No photo —
  record details only** sets custody to `RETURNED_TO_PATIENT` and makes the legibility check
  about the paper the pharmacist has seen. Owner decision **D-P9**: whether this is allowed for
  Rx lines at all. The default is that it's allowed for Rx and **never** for controlled lines.

**② Patient & doctor**

- **Patient** is prefilled from the counter's patient strip. If none is attached: a search on
  `counterPatients` (≥ 2 characters; masked results) with **+ New patient** (name,
  phone, age or date of birth, CNIC optional and shown masked after entry).
- **Doctor** search on name or **PMDC registration number** (`PharmacyPrescriber.registrationNumber`
  is unique). **+ New doctor**: name, PMDC number, clinic/hospital, phone. A doctor typed with
  a PMDC number that already exists is matched, not duplicated.
- **Prescription date** (defaults to today; can't be in the future) and **Valid until**
  (defaults to prescription date + **D-P10** days, 30 by default). **Repeats allowed** stepper
  (default 0).

**③ Medicines**

- Prefilled with the bill's Rx lines that are blocked, each showing name, strength, form and Urdu
  alias.
- Per line: **Authorised quantity** in pack language (stepper + unit switch, stored as
  `authorizedCanonicalUnits`), and **Directions**.
- **Directions** has quick chips in English and Urdu, e.g. `1 × daily · روزانہ ایک`,
  `1 × twice daily · دن میں دو بار`, `1 × three times · دن میں تین بار`, `Before food · کھانے سے پہلے`,
  `After food · کھانے کے بعد`, `At night · رات کو`. Chips build the text. Free text is still
  allowed. The directions are printed on the label and receipt.
- **+ Add medicine from the prescription** adds a line that isn't on the bill (search as usual).
- A bill line that's not on the prescription stays blocked. Copy: _"Not on this prescription."_

**④ Check & save**

- A read-only summary: page thumbnails, patient, doctor + PMDC, dates, lines.
- **Custody**: `Keep paper at pharmacy` (→ `HELD_AT_PHARMACY`, the default for controlled lines)
  or `Returned to patient` (→ `RETURNED_TO_PATIENT`).
- Primary: **Save prescription** → `pharmacyPrescriptions.capture` with an idempotency key per
  sheet attempt.

### 4.3 After save: what changes on the bill

- Each covered line's block changes from `Prescription needed` (danger) to `Prescription attached
· awaiting pharmacist` (warning). The pharmacist `SIGN` decision is still the only thing that
  releases the sale (`schema.prisma:12163-12194`); capture never bypasses it.
- The bill goes to the pharmacist queue automatically, and is parked as `Awaiting pharmacist`
  (`04` principle 4). The cashier can serve the next customer.
- When the pharmacist signs, the block turns `Verified` (success) and the bill pings in Pending.
- A quantity on the bill above the authorised quantity keeps the line blocked:
  _"Prescription allows 2 strips (20 tablets). The bill has 3 strips."_ with **Set to 2 strips**
  as the action.

### 4.4 Existing prescriptions

- The patient card lists the patient's prescriptions on file (it already does, via
  `counterPatientPanel`). Each row adds **Use for this bill**, which attaches it without
  re-capturing, when its dates, remaining repeats and lines cover the bill.
- A thumbnail opens the image in a lightbox (pinch-zoom on tablets). The pharmacist verifies
  against the image, not the typed data.

### 4.5 Privacy

- A prescription is health data. Thumbnails are loaded only through `/api/files/...` with a
  session, never from a public URL.
- The counter shows patient identifiers masked (`••••4412`), as it does today.
- The image isn't cached by the service worker or device storage, and it isn't included in
  offline snapshots.

### 4.6 Controlled-drug register prompt

Today the register (`PharmacyControlledRegisterEntry`) is written **only by hand** through
`pharmacySafety.recordControlledEntry` (`src/server/routers/pharmacy-safety.ts:88-112`), with the
caller supplying the `serial` and `runningBalance`. A sale never writes an entry.

- **Target [P-API-15]:** the server writes the register entry in the same transaction as the
  sale (or return) that moves controlled stock, computing the serial and running balance. The
  counter then only shows the entry on the receipt view: `Register #0419 · balance 118 tablets`.
- **Ships-without-API default: a prompt, not silent automation.**
  - After a sale or return with a controlled line settles, a card appears in the right zone:
    _"Controlled register entry needed: Tramadol 50mg · 10 capsules · Batch T4410."_ Actions:
    **Write entry now** (pharmacist) or **Later** (it's added to the Register menu's
    _Controlled register (n)_ list).
  - **Write entry now** opens a sheet prefilled from the sale: prescription, patient,
    prescriber, batch, quantity. Serial and running balance are **suggested** from the last
    entry (read through `pharmacySafety.controlledRegister`, which
    `controlled-register-console.tsx` already uses) and editable, with
    the reason field required if edited. Witness: a second staff PIN when the rules require it.
  - The count of unwritten entries shows as a badge on the Register menu. Day close checks it
    (§3.3 ①).
- Controlled lines are **never** sold offline unless a signed rules snapshot allows it
  (`offline-action-matrix.ts:119-126`; see `08` §4).

---

## 5. States (all three flows)

| State                              | Where / how                                                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offline or degraded                | Money items in the Register menu disabled with the reason (`08` §4). An open sheet shows the banner row at its top and disables the primary action with _"Needs a connection · your entries are kept"_. Entered data stays in the sheet |
| Loading (sale lookup, preview)     | Skeleton rows in the step body. The footer stays interactive (Back, Cancel)                                                                                                                                                             |
| Request pending                    | Spinner in the primary button only, `aria-busy`. The rest of the sheet is read-only while money calls run                                                                                                                               |
| Outcome unknown (refund)           | §2.3 warning panel + **Retry refund** with the same key                                                                                                                                                                                 |
| Permission needed                  | Inline PIN pad under the review block (§2.6). Never a dead button                                                                                                                                                                       |
| Empty (no sales today, no drawers) | A one-line explanation and the next useful action, e.g. _"No sales on this counter today. Search by receipt number instead."_                                                                                                           |

---

## 6. Tokens and ergonomics

Everything follows `02` §6–§7: 44px minimum targets, 56–64px primary actions, steppers instead of
numeric inputs, semantic tokens only, money in `font-mono tabular-nums`, over/short in
warning/danger tone **plus** the word. Additions:

- Urdu text: `lang="ur" dir="rtl"`, 16px minimum, line-height 1.9, using the font stack in the
  contract with a Nastaliq-capable fallback (e.g. Noto Nastaliq Urdu). It's never used for
  money or quantities.
- The denomination grid and the PIN pad use the same 64px keypad component.
- The camera button is 64px on tablets and sits bottom-left in the photo step (thumb zone for a
  right hand holding the paper in the left).

---

## 7. API dependencies and owner decisions

| ID       | Item                                                                                                                      | Default until it ships                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| P-API-1  | `counterSearch` returns the matched alias (type + text)                                                                   | No Urdu line under results                                                             |
| P-API-2  | `pharmacy:refund`, `pharmacy:drawer:close`, `pharmacy:day:close` capabilities + approval threshold, checked on the server | Client-side PIN gating (§2.6), labelled as a stop-gap                                  |
| P-API-3  | `pharmacySales.findSale({ receiptNumber } \| { patientId, from, to } \| { deviceId, businessDate })` with return status   | Only this session's sales are listed                                                   |
| P-API-4  | Server-computed refundable amount per line/qty (pro-rated price, discount, tax)                                           | The client estimate, labelled **Estimate**                                             |
| P-API-5  | `returnLine` checks the quarantine location belongs to the branch and is a quarantine location                            | The UI only offers the branch's quarantine locations                                   |
| P-API-6  | `openDrawer`, `drawerMovement`, `closeDrawer`, `dailyClose` errors go through `fail()` (4xx with a code)                  | Message-text mapping (§3.3)                                                            |
| P-API-7  | Rx returns post an FYI item to the pharmacist queue                                                                       | A toast tells the cashier to inform the pharmacist                                     |
| P-API-8  | `returnLine.allocationId` (choose the batch)                                                                              | Qty capped at the largest single allocation; return the rest in a second pass          |
| P-API-9  | Drawer movement list + open drawers across the branch                                                                     | This session's movements only; the open-drawer check relies on the `OPEN_DRAWER` error |
| P-API-10 | Store denominations with the closing count                                                                                | Printed on the slip, kept on the device                                                |
| P-API-11 | Close-drawer preview (variance without closing), with the count attempts logged                                           | No recount                                                                             |
| P-API-12 | `dailyClose` preview mode + breakdown by tender                                                                           | ② Review skipped; figures appear after close; no tender breakdown                      |
| P-API-13 | `tender`/`addLine` refuse a business date that's already closed                                                           | The client moves its business date forward after a close                               |
| P-API-14 | Several attachments per prescription                                                                                      | Pages combined into one PDF client-side                                                |
| P-API-15 | Controlled register entry written by the server with the sale/return                                                      | The §4.6 prompt                                                                        |

| ID    | Decision                                                              | Recommended default                                                  |
| ----- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| D-P1  | Can a controlled medicine be returned at the counter?                 | Pharmacist only, with a register entry                               |
| D-P2  | Return window                                                         | 7 days; manager override with reason                                 |
| D-P3  | Refund order for split-tender sales                                   | Khata, then loyalty, then cash                                       |
| D-P4  | Does a returned Rx line credit the prescription's remaining quantity? | No (the medicine left the pharmacy; the pharmacist can re-authorise) |
| D-P5  | Approval threshold for refunds and paid-outs                          | Rs 2,000 (branch setting)                                            |
| D-P6  | Variance that triggers a recount (needs P-API-11)                     | Rs 500                                                               |
| D-P7  | Do unwritten controlled register entries block day close?             | Yes                                                                  |
| D-P8  | Business date for pharmacies open past midnight                       | The date moves at close, not at midnight                             |
| D-P9  | Rx capture without a photo                                            | Allowed for Rx, never for controlled                                 |
| D-P10 | Default prescription validity                                         | 30 days                                                              |
