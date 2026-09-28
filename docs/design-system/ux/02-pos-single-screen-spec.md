# POS single-screen design spec (restaurant register)

Status: proposed, for board review (WHA-1574)
Baseline: `d9957a9a` · Owner: UX consultant · Implements: POS-UX-1..6 (see `03-pos-ux-acceptance-criteria.md`)
Benchmark: the reference café POS the owner prefers. It is one screen with no page scroll. Left
rail: order types, table, categories. Centre: search, pending orders, one-tap text tiles. Right:
the cart, with pinned totals and one Payment button.

This spec changes the **layout and interaction model** of `/pos`. It does **not** change the
server contracts, the offline queue semantics, the idempotency model, or the connected-only rule
for checkout, drawer, refund and day close. Where a desired interaction needs a backend change,
this document marks it **[API]** and lists it in §9.

---

## 1. Design goals (measurable)

| #   | Goal                                                           | Today (d9957a9a)                                                                                                                          | Target                                                                                             |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| G1  | Page does not scroll at 1024×768 and above                     | `<main>` is `overflow-y-auto`, with five stacked cards (`order-pad.tsx:1847`)                                                             | `h-dvh` frame. Only the category list, tile grid and cart lines scroll, each inside its own column |
| G2  | Taps from unlocked idle to first item in the cart              | 2 taps plus a scroll: select tile, then scroll to **Add to order** below every menu section (`menu-grid.tsx:169`)                         | **1 tap** (item has no required modifiers)                                                         |
| G3  | Taps from unlocked idle to a settled 1-item takeaway cash sale | 7 taps and 1–2 scrolls: tile → Add to order → Send order → find the order in _Open orders_ → Close order → Cut single bill → Apply tender | **3 taps**: tile → Pay → Cash (exact)                                                              |
| G4  | Taps to the first item for dine-in at a free table             | Same as G2, plus a table checkbox that sits in a form card, far from the menu                                                             | 2 taps: Select table → table, then tile                                                            |
| G5  | Typed fields in the sale path                                  | Qty, course and seat are `type=number` inputs. Tender needs amount and cash-received inputs                                               | Zero for the common path. Qty uses a stepper. Cash uses quick-tender buttons                       |
| G6  | Offline status is visible                                      | A status pill in the header, plus a full SectionCard that pushes the menu down                                                            | A 36px banner that never moves the layout, plus a queued count on _Pending orders_                 |

---

## 2. Layout grid

### 2.1 Landscape frame (primary target: 1024×768 iPad landscape, 1280×800, 1366×768, 1920×1080)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ TOP BAR 56px  Fathom · Branch · Device │ ⚠ Offline banner (36px, only when needed) │
│               Operator ▾  · Online ●  · Queue n · ⋯ Register menu · Lock           │
├───────────────┬────────────────────────────────────────────┬─────────────────────────┤
│ RAIL          │ CENTRE                                      │ CART                    │
│ 184–224px     │ 1fr (min 464px)                             │ 320–384px               │
│               │ ┌ Search [Item|Customer] ─── Pending (4) ─ Reports ┐                   │
│ [Dine-in  3]  │ └────────────────────────────────────────────┘ │ Order taker · KOT #12 │
│ [Takeaway 1]  │ ┌ Customer strip 44px: Walk-in · + Add customer ┐│ Dine-in · T12 · 4 cov │
│ [Delivery 0]  │ └────────────────────────────────────────────┘ ├─────────────────────────┤
│               │ ┌──────┬──────┬──────┬──────┐                   │ 2 × Chai        [−][+]  │
│ [Select table]│ │Chai  │Latte │Mocha │Cortad│  ← 4 columns        │   less sugar     560.00 │
│  T12 · 4 cov  │ │280.00│450.00│520.00│390.00│    text tiles       │ 1 × Club sandw. [−][+]  │
│               │ ├──────┼──────┼──────┼──────┤    72px tall        │                 890.00 │
│ Categories|Dea│ │ …    │      │      │      │    (scrolls inside) │  (lines scroll inside) │
│ ▸ Hot drinks  │ │      │      │      │      │                     ├─────────────────────────┤
│   Cold drinks │ └──────┴──────┴──────┴──────┘                   │ Subtotal       1,450.00 │
│   Sandwiches  │                                                  │ Tax              232.00 │
│   Desserts    │                                                  │ Service           72.50 │
│  (scrolls)    │                                                  │ TOTAL          1,754.50 │
│               │                                                  │ [Hold][Disc][Note][Prt] │
│               │                                                  │ [Send]  [ PAY 1,754.50 ]│
└───────────────┴────────────────────────────────────────────┴─────────────────────────┘
```

CSS contract (for POS-UX-2):

- Frame: `h-dvh overflow-hidden grid grid-rows-[auto_auto_1fr]`. The rows are the top bar, the
  optional offline banner, and the body.
- Body: `grid grid-cols-[minmax(184px,224px)_minmax(464px,1fr)_minmax(320px,384px)] min-h-0`.
  Each column is `min-h-0 flex flex-col`, and only its designated list gets `overflow-y-auto`
  (with `overscroll-behavior: contain`).
- The rail column and cart column are `bg-surface-card`, with `border-border-subtle` hairlines
  between columns. The centre sits on `bg-surface-page` (the Studio "paper").
- Remove the fog gutter and 36px shell radius on `/pos` at every width. A register is a
  full-bleed terminal (DEVFATHOM-STUDIO §5 "Mobile and tablet" already allows this where space
  is constrained). Record this as a **Terminal recipe** in the contract (see §7.4).
- Top bar is **56px**, not 76px. This is a documented terminal exception, added to the contract
  in the same PR as POS-UX-2.
- Cart footer (totals, icon row, action row) is `sticky bottom-0` inside the cart column. It is
  **never** inside the scroll region.

### 2.2 Breakpoints

| Width                      | Rail                                                                                                                                        | Centre tiles              | Cart                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ≥ 1440                     | 224px, full labels                                                                                                                          | 5 columns (optional)      | 384px                                                                                                                                 |
| 1024–1439                  | 184–200px                                                                                                                                   | **4 columns** (reference) | 320–360px                                                                                                                             |
| 768–1023 (portrait tablet) | Collapses to a 56px **top strip**: order-type segmented control, a table chip, and horizontally scrolling category chips                    | 3 columns                 | Collapses to a **bottom summary bar** (64px: `3 items · 1,754.50 · [Pay]`). Tapping it opens the cart as a right `Sheet` at 90% width |
| < 768                      | Not a supported register size. Show the same layout as 768 with 2 tile columns, and a notice to rotate or use a larger device. Do not block | 2 columns                 | Bottom bar + sheet                                                                                                                    |

No breakpoint may introduce document scroll. Verify with the §8 check.

---

## 3. Component inventory

### 3.1 Keep and re-house (no behavioural rewrite)

| Existing component                                            | Role in the new screen                                                                                                                                                                                                               | Change needed                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout-panel.tsx`                                          | Opened by **Pay**. Stays a `Dialog`, connected-only                                                                                                                                                                                  | Add a **single-bill fast path**: when the order has no bills and no split was requested, cut `NONE` automatically on open [no API change; it already calls `cut({kind:'NONE'})`]. Keep `data-tour="bill-settlement"` and the `Collect payment` dialog name                              |
| `tender-pad.tsx`                                              | Inside checkout                                                                                                                                                                                                                      | Add quick-tender buttons: **Exact**, the next round notes (e.g. 2,000 / 5,000 for PKR), **Card**. Keep the typed fields as a fallback (`Other amount`). Replace the `<select>` for tender type with a 3-button segmented control. Keep the `Tender type` accessible label (used by e2e) |
| `split-bill-dialog.tsx`                                       | Opened from checkout ("Split bill")                                                                                                                                                                                                  | None                                                                                                                                                                                                                                                                                    |
| `receipt-view.tsx`, `receipt-print-controls.tsx`              | Post-settlement inside checkout. The **Print** icon in the cart prints a pre-bill / reprints the last receipt                                                                                                                        | None                                                                                                                                                                                                                                                                                    |
| `drawer-panel.tsx`, `day-close-panel.tsx`, `refund-panel.tsx` | Move out of the header action row into the **Register menu** (`⋯` in the top bar, a `DropdownMenu`). Each still opens its own dialog                                                                                                 | Keep trigger names `Cash drawer`, `Refund`, and the day-close trigger text so e2e selectors keep working. Audit items D-1..D-8 are fixed in their own tickets, not here                                                                                                                 |
| `operator-switch.tsx`                                         | The operator chip in the top bar (`Operator ▾`). Its popover holds the existing switch form                                                                                                                                          | None                                                                                                                                                                                                                                                                                    |
| `order-ticket-panel.tsx`                                      | **Split up.** Its responsibilities move into the cart column (lines, totals, send/pay) and the cart overflow menu (move table, merge, reprint KOT, course hold/fire). The void dialog is kept as-is and invoked from the line action | See POS-UX-4                                                                                                                                                                                                                                                                            |
| `menu-grid.tsx`                                               | **Replaced** by `catalog-grid` + `modifier-dialog`. The selection form (qty/course/seat inputs + "Add to order") is removed from the sale path                                                                                       | See POS-UX-3                                                                                                                                                                                                                                                                            |
| `offline-queue-status.tsx`                                    | Currently unused (only its test imports it). Revive it as the body of the offline banner + queue section in the Pending sheet                                                                                                        | Wire it in POS-UX-5                                                                                                                                                                                                                                                                     |

### 3.2 New components (all under `src/components/restaurant/pos/`)

| New                         | Built on                            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `use-pos-runtime.ts` (hook) | Extracted from `order-pad.tsx`      | Session, enrolment, lock/unlock/switch, catalog load and cache, open orders, layout, offline runtime, the request/idempotency helpers, and **per-intent pending** (replaces the single `pending` string). There is no UI in it. POS-UX-1                                                                                                                                                                                       |
| `pos-frame.tsx`             | `h-dvh` grid                        | Top bar, offline banner slot, and the three column slots                                                                                                                                                                                                                                                                                                                                                                       |
| `order-type-rail.tsx`       | `Button` (`aria-pressed`)           | Dine-in / Takeaway / Delivery tiles, each with a live count (open orders for that `channel` from `open-orders` + local queued drafts)                                                                                                                                                                                                                                                                                          |
| `table-picker-sheet.tsx`    | `Sheet` (side left)                 | Floors as tabs. Tables are a grid of 64px tiles showing the code, capacity, and a state of Free / Occupied (with order # + age) / Selected. Tapping an occupied table **resumes its order** (it does not select it as a new table). Covers is a stepper (1–20), not a typed input. Floor section is chosen automatically from the table if the layout provides the mapping, otherwise it's an optional chip row                |
| `category-list.tsx`         | `Tabs` (Categories \| Deals) + list | Menu sections, with an item count per section. The Deals tab only renders when the effective menu exposes deal/combo sections [API, see §9 Q2]. Otherwise the tab is hidden, not disabled                                                                                                                                                                                                                                      |
| `catalog-search.tsx`        | `Input` + segmented scope           | **Item** scope filters tiles client-side (name, then prefix/fuzzy, across all categories). **Customer** scope calls `orders/customer/search` (connected-only; masked identifiers only). It keeps the existing ≥2-character and no-raw-contact guard (`order-pad.tsx:1359`)                                                                                                                                                     |
| `catalog-grid.tsx`          | CSS grid of `button` tiles          | 4-column text tiles. See §4.2                                                                                                                                                                                                                                                                                                                                                                                                  |
| `modifier-dialog.tsx`       | `Dialog`                            | Opens only when the item has a group with `minSelect > 0`, or on long-press / `Shift+Enter`. Modifier groups are shown as large toggle chips (radio-style when `maxSelect === 1`). It also holds qty, course and seat steppers, and a note. The confirm button reads **Add · 560.00** with a live price. The per-group min/max validation from `menu-grid.tsx:68-76` moves here. Keep `data-demo-modifier-group` on each group |
| `cart-column.tsx`           | —                                   | Header, line list, pinned totals, icon row, action row. See §4.3                                                                                                                                                                                                                                                                                                                                                               |
| `cart-line.tsx`             | —                                   | Qty stepper, a status pill for sent lines, and tap-to-edit                                                                                                                                                                                                                                                                                                                                                                     |
| `held-orders-sheet.tsx`     | `Sheet` (side right)                | **Pending orders (n)**. Filters: All / Dine-in / Takeaway / Delivery / Offline queue / Needs review. Each row shows #, channel, table, item count, total, age, and status (Held · Sent · Payment pending · Queued offline · Needs review). Tapping a row resumes it into the cart. Needs-review rows carry **Send deliberately** / **Discard** (discard needs confirmation, see A-14)                                          |
| `customer-strip.tsx`        | —                                   | 44px strip. See §4.4                                                                                                                                                                                                                                                                                                                                                                                                           |
| `offline-banner.tsx`        | `offline-queue-status.tsx`          | See §5                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `register-menu.tsx`         | `DropdownMenu`                      | Cash drawer, Close day, Refund, Reports, Reprint last receipt, Lock terminal                                                                                                                                                                                                                                                                                                                                                   |

### 3.3 Shared primitives to use (DEVFATHOM-STUDIO §6)

`Button`, `Sheet`, `Dialog`, `Tabs`, `DropdownMenu`, `StatusPill`, `Input`, `sonner` toasts,
`ScrollArea`.

`Button`'s base class hard-codes `rounded-[3px]` (`src/components/ui/button.tsx:7`). The contract
says controls use `--radius-sm` (12px). POS tiles and big actions should use `rounded-sm`
explicitly, and the shared fix is logged as audit item X-2.

---

## 4. Columns in detail

### 4.1 Left rail

1. **Order-type tiles** (3 stacked, 64px each, full rail width).
   - Content: label, plus a count badge (`font-mono tabular-nums`).
   - Selected: `bg-primary text-primary-foreground`. Unselected: `bg-surface-card
border-border-default`.
   - Switching type while the cart holds an **unsent** draft keeps the lines, then re-prices them
     against that channel's effective menu. If any line is unavailable on the new channel, show
     an inline confirm: _"2 items aren't sold for Delivery — remove them?"_
   - Switching while a **sent** order is active starts a **new** draft. The sent order stays in
     Pending.
2. **Select table** (dine-in only; 56px). Label is `Select table`. Once chosen, it shows
   `T12 · 4 covers` with a change affordance. Opens `table-picker-sheet`. On takeaway, the slot
   shows `Takeaway` with no action. On delivery, it shows `Delivery details` and opens the
   delivery sheet (§4.4).
3. **Categories | Deals** segmented `Tabs` (44px).
4. **Category list**: 48px rows, with the name at left and the item count at right (mono,
   muted). The active row has a `bg-surface-sunken` fill and a 3px ink indicator; colour is not
   the only signal. The list scrolls inside the rail. The first category is selected by default.
   Selecting a category **filters** the grid (it does not scroll a long page).

### 4.2 Centre

1. **Toolbar** (56px):
   - Search field (`/` or `F2` to focus) with a `[Item | Customer]` scope toggle.
   - **Pending orders (n)**: a button with a count badge that opens `held-orders-sheet`. `n` =
     server open orders + local parked + queued offline + needs-review. It gets a warning dot if
     any are needs-review.
   - **Reports**: permission-gated. It is hidden (not disabled) when the operator lacks the
     reports capability. It opens the shift/X-report view in the Register menu flow (it does not
     leave `/pos`).
2. **Customer strip** (44px). See §4.4.
3. **Catalog grid**: `grid-cols-4 gap-2 p-3`. It scrolls inside the centre column.
   - Tile: 72px min height, `rounded-sm`, `bg-surface-card border border-border-default`.
     - Name: `text-sm font-semibold text-text-strong`, 2-line clamp.
     - Price: `font-mono text-[13px] tabular-nums text-text-muted`, bottom-left.
   - **One tap adds** qty 1, course 1 (or the item's default course), seat none.
   - Tapping an item already in the unsent cart with the identical modifier set **increments that
     line**; it does not add a duplicate line.
   - The tile shows an in-cart qty badge (top-right, `bg-primary text-primary-foreground`,
     pill). This gives the cashier confirmation without looking at the cart.
   - Items with required modifiers show a `+ options` caption and open `modifier-dialog`.
   - Unavailable: tile is disabled, the name is struck through, and the caption reads **Sold
     out**, not `86` (audit H2-3).
   - No price: disabled, caption `No price`.
   - Channel closed: the whole grid is disabled, with a centre notice _"Takeaway is closed right
     now"_ and the reason from `channelOpen`.
   - Pressed feedback: `active:scale-[0.98]` + `bg-surface-sunken` within 100ms. Motion ≤150ms,
     none under reduced-motion.
   - Search results replace the category filter while the query is non-empty and show a result
     count. **Enter** adds the top result.

### 4.3 Right cart column

1. **Header** (pinned, 64px):
   - Line 1: `Order taker: {operator.displayName}` and `KOT #{n}`. Before the first fire it reads
     `New order`. After open and before fire it reads `Order #{orderNumber}`. Show the latest
     kitchen ticket number when there are several.
   - Line 2: channel, table, covers, and elapsed time.
   - `⋯` overflow menu: Move table, Merge tables, Reprint KOT (per ticket), Hold/Fire course
     (when there is more than one course), Cancel order.
2. **Lines** (scroll region). Each line is ≥56px:
   - `{name}`, with modifiers and note on a second line (12px muted).
   - Qty stepper `[−] n [+]` with 44×44 buttons.
   - Line total, mono and right-aligned.
   - For sent lines, a `StatusPill` (Sent / Cooking / Ready / Served / Voided). Voided lines stay
     visible, struck through, for audit clarity.
   - Tapping the body of a line opens `modifier-dialog` in edit mode for unsent lines, or a line
     actions sheet for sent lines (Mark served, Request remake, Void).
   - **− on an unsent line** decrements it. At 0 the line is removed, with a 5s **Undo** toast.
   - **− on a sent line** opens the existing void dialog prefilled with qty 1. There is no
     line-quantity endpoint, see §9 [API-1]. Post-prep voids keep the manager PIN rule
     (`order-ticket-panel.tsx:128-136`).
   - **+ on a sent line** adds a new unsent line for the same item. It's sent with the next
     Send.
   - Courses: a course divider appears only when the order uses more than one course.
   - Empty cart: a centred hint, _"Tap an item to start an order"_, with a small keyboard hint
     (`/ to search`).
3. **Totals** (pinned). Subtotal, Tax, Service charge (dine-in), Delivery fee (delivery),
   Discount/Comp (when present), and **Total** (`--type-display-sm` 28px, `font-mono
tabular-nums text-text-strong`). Numbers are right-aligned (contract §6 Tables). Unsent draft
   totals are labelled `Estimate` until the server prices the order, because the local price is
   `quotedUnitPrice`.
4. **Icon row** (4 × 56px square, icon plus an 11px label, accessible name = label):
   - **Hold**: park the order. Unsent draft, online: the server opens the order _without firing_
     and it moves to Pending as `Held`. Offline: a local parked draft marked `On this device`.
     Sent order: removes it from the cart (it stays open in Pending). The cart clears to a new
     draft. Course hold/fire moves to the overflow menu; this removes today's clash of two
     meanings for "Hold" (audit H4-2).
   - **Discount**: opens a comp/discount dialog. Today only a full-item **comp** with manager
     co-authorisation exists (`api/restaurant/checkout/comp`). Percentage or amount discounts
     need [API-3]. Until then the button opens the comp flow, labelled `Comp`, and is only
     enabled when there is a bill.
   - **Note**: an order-level kitchen note. [API-2]: no order-note field exists. Until it ships,
     the button is hidden, not a dead control. Line notes go through the modifier dialog only if
     the menu has a free-text modifier.
   - **Print**: prints a pre-bill for the active order, or reprints the last receipt when the
     cart is empty. It uses `receipt-print-controls`.
5. **Action row** (64px):
   - **Pay {total}**: full width, or 2/3 width when Send is present. `bg-primary`. Opens
     `checkout-panel`. If the order isn't open yet, Pay opens it, adds the lines and fires them,
     then closes it for payment (reusing `closeForPayment`) before the dialog opens. Offline, Pay
     is disabled with the reason inline: _"Payment needs a connection · order will be saved"_.
   - **Send** (dine-in; 1/3 width, `variant=outline`): sends unsent lines to the kitchen. It
     replaces both "Send order" and "Send whole order" (audit H4-1).
   - Takeaway/delivery: Pay only. Whether Pay also fires the kitchen for takeaway is **owner
     decision D-3** (§9); the recommendation is yes.

### 4.4 Customer strip and delivery

- **Default**: `Walk-in · + Add customer` (ghost button, 44px). Tapping it focuses the search
  with the `Customer` scope.
- **Attached**: `{displayName} · {masked phone} · {points} pts`, with `Change` and `×` remove
  controls.
  - The mask is required: only masked identifiers ever reach the pad (see the comment at
    `checkout-panel.tsx:106`).
  - Attach uses `orders/customer/attach` on a server order. On an unsent draft, the customer
    is held in the draft and attached at open.
- **Delivery channel**: the strip becomes 2 rows and shows the address chip and zone chip, e.g.
  `Home · Gulberg · Fee 150 · Min 800 · 35 min`.
  - Tapping it opens `delivery-details-sheet`, which is the existing delivery fieldset
    (`order-pad.tsx:1328-1497`) moved into a `Sheet` unchanged.
  - Pay/Send stay disabled until customer, address and zone are set. A single inline reason
    says what is missing.
  - Delivery stays connected-only.

---

## 5. Interaction states

| State                                       | Where it shows                                                                                                             | Behaviour                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Checking / not enrolled / unrecoverable** | Full-frame centred card (keep today's copy)                                                                                | No change from today, beyond the frame                                                                                                                                                                                                                                                                                                                                |
| **Locked**                                  | Full-frame **PIN pad**: operator avatars as 64px tiles, then a 3×4 numeric keypad                                          | Replaces the `<select>` + password input. Keep the `Operator` and `Operator PIN` labels and the `Unlock terminal` button name (e2e)                                                                                                                                                                                                                                   |
| **Empty** (unlocked, no active order)       | Cart empty hint; rail on the last-used order type                                                                          | The first tile tap creates the draft (POS-UX-5)                                                                                                                                                                                                                                                                                                                       |
| **Loading catalog**                         | Tile skeletons (12) in the grid; the rail stays interactive                                                                | No global "Request pending. Controls are paused." block. Pending state is per intent                                                                                                                                                                                                                                                                                  |
| **Request pending**                         | Only on the control that was pressed (spinner in the button, `aria-busy`)                                                  | Tiles keep adding to an **unsent** draft while a server call runs. Server-order mutations queue in order                                                                                                                                                                                                                                                              |
| **Offline**                                 | `offline-banner` (36px, `bg-warning/10 border-b border-warning/30`) under the top bar, `role="status"`                     | Text: **Offline** · _New orders are saved on this device and sent when you're back online. Payment, refunds, drawer and day close need a connection._ · `Queued {n}` · `Retry now`. Pay, Discount and the Register-menu money items are disabled, each with the reason. Tiles work against the cached catalog, which is labelled `Cached menu · {age}` in the toolbar |
| **Stale catalog**                           | Toolbar chip `Cached menu · 3h` (warning)                                                                                  | Prices show `Estimate` in the cart                                                                                                                                                                                                                                                                                                                                    |
| **Held**                                    | Pending sheet row status `Held`; the cart clears                                                                           | Resume restores the lines and customer                                                                                                                                                                                                                                                                                                                                |
| **Queued offline**                          | Pending sheet `Offline queue` filter; badge count in the banner                                                            | Replay is automatic on reconnect. Manual `Retry now`                                                                                                                                                                                                                                                                                                                  |
| **Needs review / quarantined**              | Pending sheet row with a warning tone, the server's reason, and `Send deliberately` / `Discard` (confirm)                  | A toast when a draft enters review. The Pending badge gets a warning dot                                                                                                                                                                                                                                                                                              |
| **Reauth paused**                           | Banner switches to _"Queued orders are paused — unlock to resume"_ and the lock screen appears                             | Same as today (`order-pad.tsx:375-385`)                                                                                                                                                                                                                                                                                                                               |
| **Revoked**                                 | Full-frame danger card with the discarded count                                                                            | Same as today                                                                                                                                                                                                                                                                                                                                                         |
| **Error (mutation)**                        | Inline next to the control that failed, plus a toast. Never a page-top notice that shifts the layout                       | Message format: _what failed + what is safe + next action_, e.g. _"Item not added — the order is unchanged. Retry."_                                                                                                                                                                                                                                                  |
| **Permission denied**                       | The control is hidden if the capability is known up front. Otherwise inline _"Needs manager approval"_ with a co-auth path | —                                                                                                                                                                                                                                                                                                                                                                     |
| **Demo**                                    | `DemoToolbar` above the frame (unchanged). Keep `data-tour="pos-order"` on the catalog grid container                      | —                                                                                                                                                                                                                                                                                                                                                                     |

Success feedback moves from the page-top `Notice` to **toasts** (`sonner`, 2.5s,
`role="status"`) and to the tile qty badge. The texts `Item added.`, `Order sent to kitchen.` and
`Order {n} opened.` are asserted by e2e. Keep them as toast text, or update the specs in the same
PR (see POS-UX-6).

---

## 6. Keyboard and tablet ergonomics

### 6.1 Keyboard map (desktop / USB keyboard / scanner)

Shortcuts are ignored while focus is in a text input, except `Esc` and `Enter`. A `?` key opens a
cheat-sheet dialog.

| Key                  | Action                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/` or `F2`          | Focus search (Item scope). `Tab` toggles to Customer scope                                                     |
| `Enter` (in search)  | Add the top result. `Shift+Enter` opens its modifier dialog                                                    |
| Arrow keys (in grid) | Roving focus across tiles (`role="grid"`). `Enter`/`Space` adds                                                |
| `1`–`9` then `*`     | Qty multiplier for the next add (e.g. `3*` then a tile = qty 3). The multiplier shows as a chip in the toolbar |
| `+` / `-`            | Change the qty of the focused or last-added cart line                                                          |
| `Alt+1/2/3`          | Dine-in / Takeaway / Delivery                                                                                  |
| `F4` or `Alt+T`      | Select table                                                                                                   |
| `F6`                 | Pending orders                                                                                                 |
| `F7`                 | Hold (park)                                                                                                    |
| `F8`                 | Send to kitchen                                                                                                |
| `F9` or `Ctrl+Enter` | Pay                                                                                                            |
| `Esc`                | Close the top sheet/dialog. Otherwise clear the search                                                         |
| `Ctrl+L`             | Lock terminal                                                                                                  |

Barcode scanners that act as a keyboard work through the search field. On `Enter`, an exact SKU
or barcode match adds immediately.

### 6.2 Touch

- Minimum target is 44×44. Primary actions are 56–64px (Pay, Send, order-type tiles). Keep at
  least 8px between adjacent targets.
- Thumb zone: Pay/Send sit bottom-right. A **left-handed** register setting mirrors the rail and
  cart (a device preference in local storage; no server change).
- `touch-action: manipulation` on the frame (no double-tap zoom). `user-select: none` on tiles.
  No hover-only affordances.
- Long-press (500ms) on a tile opens the modifier dialog. Long-press on a line opens line
  actions.
- The steppers replace every numeric input in the sale path (qty, covers, seat, course).
- Visual feedback within 100ms of a tap. Never wait for the server before showing the line in an
  unsent draft.

---

## 7. Design-token usage

All values come from the Studio block of `src/app/globals.css` (l.895+) and DEVFATHOM-STUDIO.md.
No raw hex in components.

| Element                                       | Tokens / classes                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frame surround                                | `bg-surface-page` (no fog gutter on the terminal)                                                                                                     |
| Rail and cart columns                         | `bg-surface-card`, `border-border-subtle` hairline dividers                                                                                           |
| Tiles                                         | `bg-surface-card border-border-default rounded-sm`, hover/active `bg-surface-sunken`, focus `ring-3 ring-ring/50` (coral)                             |
| Selected order type / in-cart qty badge / Pay | `bg-primary text-primary-foreground`, hover `bg-primary-hover`                                                                                        |
| Active category                               | `bg-surface-sunken` + 3px `bg-primary` indicator + `aria-current="true"`                                                                              |
| Coral (`--accent-brand`)                      | **Only** for the focus ring and the brand mark. Not for counts, badges or warnings (contract §2 principle 5, §3 "never represent a state with coral") |
| Offline / stale / needs review                | `bg-warning/10 border-warning/30 text-text-body` + a `StatusPill tone="warning"`                                                                      |
| Void / remove / discard                       | `variant="destructive"` (`--destructive`)                                                                                                             |
| Sent / settled                                | `StatusPill tone="success"`                                                                                                                           |
| Names and body                                | Instrument Sans (`font-sans`), 14px/600 on tiles, 14px on lines                                                                                       |
| Money, qty, KOT #, counts                     | `font-mono tabular-nums` (IBM Plex Mono). Total at `--type-display-sm`                                                                                |
| Eyebrows (`ORDER TAKER`, `KOT`)               | mono 11px uppercase `tracking-[var(--tracking-caps)] text-text-muted`                                                                                 |
| Radii                                         | Tiles/controls `rounded-sm` (12px); sheets/dialogs `rounded-lg` (20px); columns square (full-bleed)                                                   |
| Elevation                                     | None at rest. Sheets and dialogs use `--shadow-md`                                                                                                    |
| Motion                                        | Tile press 120ms (`--duration-fast`); sheet 200–300ms; nothing under `prefers-reduced-motion`                                                         |
| Density                                       | Optional `data-density="compact"` on the frame for ≥1440 layouts with 5 columns. Don't use it on tablets                                              |
| Dark theme                                    | Works without extra code because only semantic tokens are used. Check it in the §8 QA matrix                                                          |

### 7.4 Contract change requested (lands with POS-UX-2)

Add a **"Terminal recipe"** to DEVFATHOM-STUDIO §7. It covers:

- full-bleed, no fog, no shell radius
- a 56px top bar
- no page scroll, with column-scoped scrolling
- toasts for success
- a minimum 56px primary action

Apply the same recipe to `/kds`.

---

## 8. Verification recipe (for every POS-UX PR)

- Playwright at 1024×768, 1280×800, 1366×768, 1920×1080 and 768×1024:
  - assert `document.scrollingElement.scrollHeight <= innerHeight`
  - assert `scrollWidth <= innerWidth`
  - take a screenshot for each viewport
- Tap-count scripts for G2/G3/G4 (count `click()` calls from unlocked idle to the target state).
- The existing POS e2e specs listed in POS-UX-6 stay green. Vitest runs with
  `NODE_OPTIONS=--no-experimental-webstorage`; 106 failures are the baseline. `tsc` runs with
  `NODE_OPTIONS=--max-old-space-size=8192`.
- Contract §12 QA matrix: light/dark, reduced motion, keyboard, and each of the §5 states.

---

## 9. Dependencies and owner decisions

| ID    | Item                                                                               | Default if not decided                                                                             |
| ----- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| API-1 | Line quantity decrement on sent lines (`orders/update-qty` or void-with-qty)       | − on a sent line opens the void dialog for the whole line, with the reason prefilled "Qty reduced" |
| API-2 | Order-level and line-level kitchen notes                                           | The Note button is hidden                                                                          |
| API-3 | Percentage/amount discounts with a manager cap                                     | The Discount button maps to the existing **Comp** flow                                             |
| Q2    | Deals/combos in the effective menu                                                 | The Deals tab is hidden                                                                            |
| D-3   | Should takeaway **Pay** also fire the kitchen?                                     | Yes: fire on Pay for takeaway/delivery, and show the KOT # in the receipt toast                    |
| D-4   | Should Hold create a server order (visible on all terminals) or stay device-local? | Server order online (not fired); device-local only when offline                                    |
| D-5   | Left-handed mirror setting                                                         | Ship it behind a device preference in POS-UX-2                                                     |
