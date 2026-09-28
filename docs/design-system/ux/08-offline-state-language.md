# Offline-state language: POS, KDS and pharmacy counter

Status: proposed, for board review (WHA-1583) · Baseline: `13af3d1e` · Owner: UX consultant
Implements: OFF-UX-1..4 (see `09-ux02-acceptance-criteria.md`)
Extends: `02-pos-single-screen-spec.md` §5 (the offline banner and Pending sheet) and
`04-pharmacy-counter-principles.md` principle 8. This spec is the single source for connection
words, tones and rules on every terminal. Where `02` and this document differ, this one wins, and
POS-UX-5 picks up the change.

## 0. What exists today

| Terminal         | Runtime                                                                                                                                                                                                                                               | What the cashier sees                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restaurant POS   | `PosOfflineRuntime` (`src/lib/restaurant/pos-offline-runtime.ts:38`), used by `order-pad.tsx:612-621`. Queues **new orders only** (`OPEN_ORDER`, `ADD_ITEM`, `FIRE`; `pos-command-queue.ts:8-14, 53`), capped at 50                                   | Header pill Online/Offline, a queue pill, and a full "Offline queue" card that pushes the menu down (`order-pad.tsx:1116-1254`). `offline-queue-status.tsx` is built but mounted nowhere (audit X-6) |
| KDS              | Polling only, backing off 5 → 10 → 20 → 30 s (`kds-board.tsx:79, 206-236`); refreshes on `online` / `visibilitychange`                                                                                                                                | Pill `disconnected / loading / error / active`, a "Last synced HH:MM" strip with `degraded / synced`, and "Retry now" (`kds-board.tsx:414-425, 555-592`)                                             |
| Pharmacy counter | `PharmacyCounterRuntime` (`src/lib/pharmacy/counter-offline-runtime.ts:129`): signed snapshots, a safety lease, a 200-command queue, pre-reserved receipt numbers, per-counter stock quotas, and an action matrix (`offline-action-matrix.ts:72-158`) | **Nothing.** The runtime is only imported by its test. The counter has no offline indicator (audit C-1)                                                                                              |

There is no shared connection component, hook or label map. `StatusPill` has no tones for
connection words (`src/components/ui/status-pill.tsx:26-60`).
`src/components/terminal/terminal-state.ts:1-9` defines failure kinds (`network`, `unauthorized`,
`forbidden`, `locked`, `revoked`, `error`), which this spec builds on.

---

## 1. The five connection states

Every terminal reports exactly one **connection state** at a time. The words, tone and icon are
the same everywhere.

| State        | Means                                                                             | Badge (top bar, always shown)                  | Tone    | Icon (lucide)                                    |
| ------------ | --------------------------------------------------------------------------------- | ---------------------------------------------- | ------- | ------------------------------------------------ |
| **Online**   | Server reachable, last request succeeded, nothing waiting                         | `● Online`                                     | success | `Wifi`                                           |
| **Degraded** | Reachable but unreliable or partly broken. Some things may be slow or unavailable | `◐ Slow connection` or `◐ {thing} unavailable` | warning | `WifiLow`                                        |
| **Offline**  | Not reachable. Only offline-safe work is allowed; it's saved on this device       | `○ Offline`                                    | warning | `WifiOff`                                        |
| **Syncing**  | Back online and sending saved work. Counts down                                   | `↻ Sending 3…`                                 | info    | `RefreshCw` (spins; static under reduced motion) |
| **Conflict** | Some saved work couldn't be sent as-is and needs a person to decide               | `! 2 need review`                              | danger  | `AlertTriangle`                                  |

Terminal-level states take the same slot but aren't about the network. They reuse today's copy:

| State               | Badge               | Behaviour                                                                                |
| ------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| **Paused (unlock)** | `⏸ Paused · unlock` | Replay paused for re-auth (`PAUSED_REAUTH`). Lock screen shown (`order-pad.tsx:375-392`) |
| **Revoked**         | `✕ Device removed`  | Full-frame danger card with the count of discarded items. Nothing else is usable         |

**Rules for the badge**

- The badge is **always visible**, including `Online`. The absence of a warning is not a signal.
- It's a word plus an icon plus a tone. Colour is never the only signal (contract §9).
- Coral (`--accent-brand`) is never used for any of these states (`02` §7).
- Tapping the badge opens the **Connection sheet** (§6) with details and actions.

### 1.1 Precedence

When several apply, the badge and the banner show the highest one. Counts from lower states still
appear in the banner text.

`Revoked` > `Paused` > `Conflict` > `Offline` > `Syncing` > `Degraded` > `Online`

For example: offline, with 1 conflict and 4 queued → badge `! 1 needs review`, banner _"Offline ·
4 saved on this device · 1 needs review"_.

### 1.2 Detection and timing

| Transition                | Trigger                                                                                                                                                                                                                                                             | Timing                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| → Offline                 | `navigator.onLine === false`, **or** 2 consecutive requests fail with no response (status 0) or time out                                                                                                                                                            | Within **1 s** of the `offline` event; within the request timeout otherwise |
| → Degraded                | Any of: 2 of the last 5 requests failed or took > 3 s; KDS poll backed off to ≥ 20 s; a dependency is down (payment adapter, print bridge, fiscal submission); cached catalog/snapshot older than the terminal's threshold; counter safety lease ends within 30 min | Evaluated on every request and every 15 s                                   |
| Offline → Syncing         | One successful request (a lightweight `GET /api/ready`, every 10 s while offline) **and** something is queued                                                                                                                                                       | Immediate                                                                   |
| Offline/Degraded → Online | One successful request, nothing queued, and the condition has held for **5 s**                                                                                                                                                                                      | 5 s hysteresis, so the banner doesn't flap on a patchy connection           |
| Syncing → Online          | Queue empty                                                                                                                                                                                                                                                         | Toast _"All saved work sent"_ (2.5 s)                                       |
| Syncing → Conflict        | Replay returns REVIEW or QUARANTINE (`src/lib/retail-terminal/replay-outcome.ts:43-85`)                                                                                                                                                                             | Immediate, with a toast                                                     |

`navigator.onLine === true` alone is **not** trusted as online. Shops often have Wi-Fi with no
internet behind it during load-shedding, when the router's on UPS but the uplink isn't.

---

## 2. Components (new, shared)

All live in `src/components/terminal/` next to `terminal-state.ts`, so the POS, KDS and counter
import the same code.

| Component / hook             | Purpose                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection-state.ts`        | Types `TerminalConnectionState` (the 5 + 2 states), `ConnectionSnapshot` (`state`, `since`, `queued`, `sending`, `needsReview`, `degradedReasons[]`, `lastSyncAt`, `cacheAge`, `safetyLeaseUntil?`), the precedence function, and the **label map** (§3) |
| `use-terminal-connection.ts` | Takes an adapter per runtime (`PosOfflineRuntime`, `PharmacyCounterRuntime`, KDS poller) and returns a `ConnectionSnapshot`. It owns detection and hysteresis (§1.2). No JSX                                                                             |
| `connection-badge.tsx`       | The top-bar badge. 32px high, `StatusPill` with the tone from §1 and the icon. `aria-label` is the full sentence (e.g. _"Offline. 4 saved on this device."_)                                                                                             |
| `connection-banner.tsx`      | The 36px row under the top bar, shown for every state except Online. Evolves `offline-queue-status.tsx` (which is then deleted along with its test, or the test is moved)                                                                                |
| `connection-sheet.tsx`       | Details and actions (§6)                                                                                                                                                                                                                                 |
| `pending-row.tsx`            | One row for the Pending sheet on any terminal, with the status vocabulary in §5                                                                                                                                                                          |

`StatusPill` gets no new tones. The five states map onto the existing success / warning / info /
danger tones.

---

## 3. Words

### 3.1 Banner copy (English)

The banner always has three parts: **state word** · **what's happening to your work** · **what
needs a connection**. Then counts and one action button.

| State                 | POS                                                                                                                                                                         | KDS                                                                                                                        | Pharmacy counter                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Degraded              | **Slow connection** · Orders may take longer to reach the kitchen. · `[Details]`                                                                                            | **Slow connection** · Tickets may arrive late. Last update {hh:mm}. · `[Retry now]`                                        | **Slow connection** · Sales still work. Card payments may fail. · `[Details]`                                                                                                                                   |
| Degraded (dependency) | **Printer not connected** · Receipts and kitchen tickets won't print. Orders are still saved. · `[Details]`                                                                 | **Printer not connected** · —                                                                                              | **Card machine unavailable** · Take cash or khata. · `[Details]`                                                                                                                                                |
| Offline               | **Offline** · New orders are saved on this device and sent when you're back online. Payment, refunds, drawer and day close need a connection. · `Saved {n}` · `[Retry now]` | **Offline** · Showing tickets as of {hh:mm}. New orders may be missing. Bump and recall need a connection. · `[Retry now]` | **Offline** · Cash sales of non-prescription medicines are saved on this device. Prescription, controlled, card and refund need a connection. · `Safety data valid until {hh:mm}` · `Saved {n}` · `[Retry now]` |
| Syncing               | **Sending saved orders** · {k} of {n} sent. Keep this screen open.                                                                                                          | **Reconnected** · Updating tickets…                                                                                        | **Sending saved sales** · {k} of {n} sent. Keep this screen open.                                                                                                                                               |
| Conflict              | **{n} orders need review** · They weren't sent. Open Pending to decide. · `[Review]`                                                                                        | —                                                                                                                          | **{n} sales need review** · Money was taken; the manager must check them. · `[Review]`                                                                                                                          |
| Paused                | **Saved orders are paused** · Unlock to resume sending. (today's copy)                                                                                                      | —                                                                                                                          | **Saved sales are paused** · Unlock to resume sending.                                                                                                                                                          |

Copy rules:

- Use _saved_, never _queued_, _outbox_, _replay_, _snapshot_, _lease_ or _quarantine_ in
  cashier-facing text. Those words stay in logs and in the Connection sheet's technical section.
  (The POS e2e asserts `Queued 2`; POS-UX-5 updates that assertion to `Saved 2` in the same PR.)
- Say what **still works** before what doesn't. The cashier's next question is "can I keep
  selling?".
- Times are local `hh:mm`. Counts are digits.
- Never blame: _"Couldn't reach the server"_, not _"Your internet is down"_.

### 3.2 Urdu labels (terminal language setting)

Pakistani counters are often run in Urdu. When the terminal language is Urdu, the state word and
the one-line summary switch. Money, counts and receipt numbers stay in Latin digits (matching
printed receipts). These strings are **drafts for native-speaker review** before they ship.

| State    | Urdu state word             | Summary (counter)                                            |
| -------- | --------------------------- | ------------------------------------------------------------ |
| Online   | آن لائن                     | —                                                            |
| Degraded | کنکشن سست ہے                | فروخت جاری ہے، کارڈ ادائیگی ناکام ہو سکتی ہے                 |
| Offline  | آف لائن                     | نسخے کے بغیر دواؤں کی نقد فروخت اس ڈیوائس پر محفوظ ہو رہی ہے |
| Syncing  | محفوظ فروخت بھیجی جا رہی ہے | —                                                            |
| Conflict | جائزہ درکار                 | مینیجر سے چیک کروائیں                                        |

Urdu text renders `dir="rtl"` inside the banner, with the icon and action button keeping their
LTR positions so the layout never mirrors unexpectedly.

---

## 4. What the cashier may and may not do offline

`✓` allowed · `◐` allowed with a limit · `✕` needs a connection (shown **disabled with the
reason**, never hidden).

| Action                                 | POS | KDS | Counter | Reason / limit shown to the cashier                                                                                                                                                                   |
| -------------------------------------- | :-: | :-: | :-----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search, browse, scan                   |  ✓  |  —  |    ✓    | Uses the saved catalog. Toolbar chip `Saved menu · 3h` / `Saved catalog · 3h`                                                                                                                         |
| Start a new order / bill               |  ✓  |  —  |    ✓    | —                                                                                                                                                                                                     |
| Add to an order the server already has |  ✕  |  —  |    ✕    | _"This order is on the server. Changes need a connection."_ (`pos-command-queue.ts:10-13`)                                                                                                            |
| Send to kitchen                        |  ◐  |  —  |    —    | Saved and sent when back online. KDS won't show it until then: _"The kitchen will get this when you're back online."_                                                                                 |
| Hold / park                            |  ◐  |  —  |    ◐    | Kept on this device only (`On this device`)                                                                                                                                                           |
| Cash sale                              |  ✕  |  —  |    ◐    | Counter: non-prescription medicines only, within this counter's stock allowance, while safety data is valid (`CASH_OTC_SALE`, `offline-action-matrix.ts:88-94`). POS: payment is connected-only today |
| Khata / credit sale                    |  —  |  —  |    ◐    | Up to the customer's saved limit (`KHATA_SALE_WITHIN_CACHED_LIMIT`): _"Limit available offline: Rs 3,200"_                                                                                            |
| Card / wallet / bank                   |  ✕  |  —  |    ✕    | _"Card payments need a connection. Take cash, or save the bill."_                                                                                                                                     |
| Prescription (Rx) lines                |  —  |  —  |    ✕    | _"Prescription medicines need a connection so the pharmacist can check them."_ The matrix names unverified fills; anything not listed is denied (`offline-action-matrix.ts:151-157`)                  |
| Controlled medicines                   |  —  |  —  |    ✕    | _"Controlled medicines can't be sold offline."_ A signed rules snapshot can allow it (`:119-126`); then the line shows `Allowed offline by branch rules`                                              |
| Attach prescription (photo)            |  —  |  —  |    ✕    | _"Photos upload when you're back online."_ (06 §4.5: images are never stored for offline use)                                                                                                         |
| Discount                               |  ✕  |  —  |    ✕    | Needs approval and live prices                                                                                                                                                                        |
| Refund / return                        |  ✕  |  —  | ✕ (v1)  | _"Refunds need a connection."_ The counter matrix allows `PERMITTED_REFUND` offline; the counter keeps it connected-only in v1 (**D-O1**)                                                             |
| Open drawer, paid in/out               |  ✕  |  —  |    ✕    | _"Drawer changes need a connection."_                                                                                                                                                                 |
| Close drawer / day                     |  ✕  |  —  | ✕ (v1)  | The counter matrix allows `PROVISIONAL_CLOSE`; v1 keeps it connected-only (**D-O2**)                                                                                                                  |
| Reprint last receipt                   |  ✓  |  —  |    ✓    | From device memory                                                                                                                                                                                    |
| Bump / recall ticket                   |  —  |  ✕  |    —    | _"Bump needs a connection. Tickets shown as of {hh:mm}."_ There's no KDS queue today                                                                                                                  |
| Lock / switch operator                 |  ✓  |  ✓  |    ✓    | Uses saved staff data                                                                                                                                                                                 |
| Delivery orders                        |  ✕  |  —  |    —    | Connected-only; no delivery data is stored on the device (`order-pad.tsx:1336-1341`)                                                                                                                  |

### 4.1 Counter safety data (the lease)

The counter's offline sales depend on signed snapshots and a **safety lease** with an expiry
(`offline-safety-lease.ts`). The cashier sees it as _safety data_:

- Offline banner: `Safety data valid until 14:20`.
- 30 minutes before expiry, it turns Degraded even when online:
  _"Safety data needs refreshing by 14:20. Stay connected."_
- Expired while offline: cash sales stop. Banner: _"Safety data expired at 14:20. Medicines can't
  be sold until the connection is back."_ The primary action becomes **Save bill for later**.
- On reconnect, if a recall bulletin applies, it's installed **before the next sale** (runtime
  :276-299). The cashier sees a blocking dialog only if a line in the current bill is recalled:
  _"Batch A2291 of Augmentin 625mg has been recalled. Remove it from the bill."_

---

## 5. Held orders and pending tenders: one status vocabulary

Every terminal has a **Pending (n)** sheet (restaurant `held-orders-sheet` from `02`; the counter
equivalent from `04` principle 6). Rows use `pending-row.tsx` and these statuses, and no others:

| Status                    | Tone    | Where it comes from                                                                                           | Row action                                                                |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Held`                    | neutral | Parked on the server; visible on every terminal in the branch                                                 | Resume                                                                    |
| `On this device`          | neutral | Parked while offline; only this terminal has it                                                               | Resume                                                                    |
| `Saved · will send`       | warning | Offline order/sale waiting to send                                                                            | — (sends automatically) · `Retry now` in the banner                       |
| `Sending…`                | info    | Replay in flight                                                                                              | —                                                                         |
| `Needs review`            | danger  | Replay returned REVIEW (POS: price changed, item unavailable, channel closed, `pos-command-queue.ts:102-103`) | **Send anyway** / **Discard** (confirm)                                   |
| `Sale not recorded`       | danger  | Counter: an offline **cash sale** the server refused (QUARANTINED). Cash was already taken                    | **Show details** only. Manager resolves (§5.1)                            |
| `Awaiting pharmacist`     | info    | Counter: sent for verification                                                                                | Open (read-only until verified)                                           |
| `Verified`                | success | Counter: pharmacist signed                                                                                    | Resume                                                                    |
| `Payment pending`         | warning | Bill cut, not settled                                                                                         | Resume to Pay                                                             |
| `Payment outcome unknown` | danger  | A tender call's result is unknown (`tender-attempt-storage.ts`; POS equivalent)                               | **Check payment** (outcome lookup with the same key; never a new payment) |
| `Refund not paid`         | danger  | Counter: items returned but the refund didn't complete (`06` §2.3)                                            | **Retry refund** (same key)                                               |

- The Pending button's count badge counts everything above. It gets a danger dot when any row is
  danger-toned.
- Rows sort by tone (danger first), then age.
- A row's accessible name starts with `#{number} ·` (`03` POS-UX-5 AC 4 keeps this for e2e).
  Local items use their device number (`#D-3`), switching to the server number in place once
  it's assigned.
- **Close day is blocked** while any row is `Saved · will send`, `Sending…`, `Needs review`, `Sale
not recorded`, `Payment outcome unknown` or `Refund not paid` on this device.

### 5.1 When money has already moved

A restaurant needs-review order hasn't been paid yet, so **Discard** is safe. A counter offline
sale **has** been paid, the receipt number was final when printed (`counter-command-queue.ts:133-149`)
and the stock was taken from the counter's own allowance. So:

- There's no **Discard** on counter rows. The row shows `Sale not recorded` with the reason in
  words, e.g. _"Batch was recalled before this sale reached the server"_ or _"This counter's stock
  allowance ran out"_.
- The row stays until a manager resolves it in the back office. The cashier's only instruction:
  _"Keep the receipt copy and tell your manager. Don't refund the customer from the counter."_
- Resolution screens are back-office work and out of scope here. **D-O3** names the owner.

### 5.2 Receipts printed offline

- Counter receipt numbers are reserved in blocks and final (`counter-command-queue.ts:133-149`).
  The receipt prints normally, with a small line `Issued offline · {hh:mm}` under the number.
- POS doesn't print a receipt offline, because payment is connected-only.
- Fiscal (FBR/PRA) isn't live (`src/lib/pharmacy/fiscal.ts:1-7`). When it ships, offline receipts
  print _"Tax invoice number will follow"_, and the invoice number arrives by SMS or reprint.
  **D-O4**.

---

## 6. Connection sheet

Tapping the badge opens a right `Sheet` (420px):

1. **Now**: the state sentence, and since when (`Offline since 13:47 · 12 min`).
2. **Your saved work**: counts by status with **Open Pending**.
3. **What works now**: a short list derived from §4 for this terminal, with ✓ and ✕.
4. **Checks**: server (last success `13:46:58`), printer, card machine, safety data (counter),
   saved catalog age.
5. **Retry now** (primary) and **Copy details for support** (copies terminal ID, state, counts,
   last errors; no customer data).
6. A collapsed **Technical** section with the raw runtime values (replay state, lease status,
   command IDs) for support staff.

---

## 7. Layout and motion

- The banner sits in the reserved row of the terminal frame (`grid-rows-[auto_auto_1fr]`, `02`
  §2.1). It's 36px, and showing or hiding it **never moves the columns**. Only opacity animates
  (150 ms; none under reduced motion).
- KDS uses the same frame recipe (`02` §7.4), so the same banner row applies there. On KDS, the
  banner text is 18px for kitchen distance, and the board dims to 70% opacity while Offline so
  stale tickets look stale.
- Announcements from the platform (`07` §3.13) share the banner row but always sit **below** a
  connection banner.
- ARIA: the banner is `role="status"` (`aria-live="polite"`). Conflict, Revoked and
  safety-expired use `role="alert"`. State changes announce once, not on every count change.
- Optional sound (terminal setting, off by default on POS/counter, on by default on KDS): a short
  two-tone cue when going Offline and when back Online.

---

## 8. Owner decisions

| ID   | Decision                                                           | Recommended default                                                  |
| ---- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| D-O1 | Allow counter refunds offline (`PERMITTED_REFUND`)                 | No in v1. Revisit after OFF-UX-4 has run in one pilot branch         |
| D-O2 | Allow a provisional drawer/day close offline (`PROVISIONAL_CLOSE`) | No in v1. Load-shedding at closing time is common, so plan it for v2 |
| D-O3 | Who resolves `Sale not recorded` and where                         | Branch manager, in a back-office "Offline exceptions" list           |
| D-O4 | Offline receipts once FBR/PRA is live                              | Print "Tax invoice number will follow"; send the number by SMS       |
| D-O5 | Terminal language default for pharmacy counters                    | English, with Urdu available per terminal                            |
