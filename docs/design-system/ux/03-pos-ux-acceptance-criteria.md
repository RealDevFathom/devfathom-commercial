# POS-UX-1..6: acceptance criteria

Status: proposed (WHA-1574) · Spec: `02-pos-single-screen-spec.md` · Audit: `01-heuristic-audit.md`

## Rules for every ticket

Each ticket lands as its own PR. The rules below apply to all six.

**Non-regression**

- No server contract changes unless the ticket names an [API] item.
- These behaviours stay exactly as they are:
  - idempotency keys
  - epoch guards
  - offline queue semantics
  - connected-only money actions
  - void/comp co-authorisation

**Verification to include in the PR comment (command + exit code + counts)**

- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` exits 0.
- `NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/restaurant/pos` has no
  new failures against the 106-failure repo baseline. Give the counts.
- The POS e2e specs listed under POS-UX-6 are green on a disposable PG lane (loopback
  55600-55699, owner/runtime NOSUPERUSER NOBYPASSRLS).
- Screenshots at 1024×768, 1366×768 and 768×1024, light and dark, stored under the ticket's
  evidence path.

**Scroll check (every UI ticket from POS-UX-2 on)**

- A Playwright check passes at 1024×768, 1280×800, 1366×768, 1920×1080 and 768×1024:
  `document.scrollingElement.scrollHeight <= window.innerHeight` and
  `scrollWidth <= innerWidth`.

**Design contract**

- DEVFATHOM-STUDIO §9 (accessibility) and §12 (QA matrix).
- Semantic tokens only, with no raw hex.

---

## POS-UX-1: Extract `use-pos-runtime` hook (no visible change)

**Scope.** Move the non-visual state and effects out of `order-pad.tsx` (1877 lines) into
`src/components/restaurant/pos/use-pos-runtime.ts`. That covers:

- establish, hydrate, lock, unlock and switch
- operators, catalog load/cache, open orders and layout
- the offline runtime, replay and queue snapshot
- `request`, `checkoutRequest`, `mutate` and `keyFor`
- `handleError` and the notice state

**Acceptance criteria**

1. `order-pad.tsx` renders identical DOM for every existing state:
   - checking, missing, unrecoverable, locked, unlocked
   - offline, queued, needs-review, revoked
   - the `order-pad.test.tsx` and `checkout-panel.test.tsx` suites pass unchanged, with the same
     test count before and after
2. The hook returns a typed API: `{ runtime, enrollmentState, operators, catalog, openOrders,
layout, queue, online, pending, notice, actions: { unlock, lock, switchOperator, openOrder,
addItem, mutate, replay, resolveReview, closeForPayment, loadDetail, loadMenu } }`. No JSX in
   the hook.
3. **Per-intent pending.** `pending` becomes `ReadonlySet<PendingIntent>` (or a map), with a
   `isPending(intent)` helper. The legacy `busy` boolean is derived as `pending.size > 0`, so the
   UI is unchanged in this ticket.
4. Idempotency: the same intent reuses its key after a network failure and drops it after a
   definitive 4xx. The existing tests prove this, and one new hook-level unit test covers a
   retry after a timeout.
5. Stale-response guards (`stateEpoch`, `runtimeBoundary`, `deliveryBoundaryIsCurrent`) are
   preserved. There is a unit test for a switch-operator-during-inflight-customer-search
   boundary.
6. `order-pad.tsx` is ≤ 900 lines after extraction. There is no behaviour change in the e2e
   suites listed in POS-UX-6.

---

## POS-UX-2: Frame + left rail + table-picker sheet

**Scope.**

- `pos-frame.tsx`: 56px top bar, offline-banner slot, three-column grid
- `order-type-rail.tsx`
- `table-picker-sheet.tsx`
- `category-list.tsx` (Categories only; Deals hidden until Q2)
- `register-menu.tsx`
- the lock-screen PIN pad
- the Terminal recipe in DEVFATHOM-STUDIO

**Acceptance criteria**

1. The frame is `h-dvh` with no document scroll at any viewport in the scroll check, and the
   Playwright assertion lives in `tests/e2e/restaurant-pos-layout.spec.ts`. At 1024×768 the
   rail, centre and cart are all visible without scroll.
2. Order-type tiles: three `button`s with `aria-pressed`. The accessible name includes the count,
   e.g. `Dine-in, 3 open`.
   - The count equals `open-orders` filtered by `channel` plus local queued drafts for that
     channel.
   - The count updates after open, close, settle and replay without a manual Refresh.
3. Switching order type with an unsent draft keeps the lines. Lines unavailable on the new
   channel trigger an inline confirm that names the items. Switching with a sent active order
   starts a new draft, and the sent order stays in Pending.
4. **Select table** (dine-in only) opens a left `Sheet`:
   - floors as tabs
   - table tiles ≥64px with code, capacity and state (Free / Occupied #n · age / Selected)
   - a covers stepper (1–20)
   - multi-select for joined tables
   - **Done** closes the sheet and the rail shows `T12 · 4 covers`
   - tapping an **occupied** table resumes its order into the cart
   - the sheet traps focus, closes on Esc and restores focus to the trigger
   - layout loading, error and denied states reuse today's copy (`order-pad.tsx:1501-1519`)
5. **Register menu** (`⋯`) contains Cash drawer, Close day, Refund, Reports (permission-gated),
   Reprint last receipt and Lock terminal. These existing dialogs open unchanged, and the
   trigger accessible names `Cash drawer` and `Refund` are preserved for e2e. Money items are
   disabled offline, and the reason is shown in the menu item description.
6. **Lock screen**:
   - operator tiles (64px, name + role) and a 3×4 numeric PIN pad with a masked 4–8 dot display
   - physical-keyboard digits and Backspace work
   - `Operator` and `Operator PIN` accessible labels and the `Unlock terminal` button name are
     preserved
   - a failed PIN clears the dots and shows an inline error
7. Top-bar pills: operator chip (opens operator-switch), connectivity pill (`Online` /
   `Offline`, text + dot) and queue pill (`Queued n`). The texts `Queued n` and `Online`/`Offline`
   are asserted by e2e and stay unchanged.
8. DEVFATHOM-STUDIO.md gains a §7 **Terminal recipe** (full-bleed, 56px bar, column-scoped
   scroll, toasts, ≥56px primary). It's in the same PR, per contract §13.
9. Keyboard: `Alt+1/2/3` switches order type, `F4` opens Select table, and `Ctrl+L` locks.
   Shortcuts don't fire while a text input has focus.

---

## POS-UX-3: Catalog, search, one-tap tiles, modifier dialog

**Scope.** `catalog-search.tsx` (Item scope), `catalog-grid.tsx` and `modifier-dialog.tsx`.
Retire the `menu-grid.tsx` selection form from the sale path.

**Acceptance criteria**

1. The grid is 4 columns at a centre width of 464–900px, 3 columns at 768 portrait and 5 at
   ≥1440 (optional).
   - Tiles are ≥72px tall and `rounded-sm`. The name is 2-line clamped and the price is
     `font-mono tabular-nums`.
   - The grid is `role="grid"` with roving tabindex. Arrow keys move, and Enter/Space adds.
2. **One tap adds** (qty 1, default course, no seat) for items with no modifier group where
   `minSelect > 0`. The cart line appears within 100ms, with no network wait for an unsent
   draft. The tap-count script shows **1 tap** from unlocked idle to the first cart line.
3. Tapping an item already in the unsent cart with an identical modifier set increments that
   line. The tile shows an in-cart qty badge that matches the cart.
4. Items with a required group show a `+ options` caption and open `modifier-dialog`.
   - The dialog validates min/max per group with the same rules and message format as
     `menu-grid.tsx:68-76`.
   - It holds qty, course and seat steppers. The confirm button reads `Add · {price}` with a
     live price.
   - Long-press (500ms) or `Shift+Enter` opens the dialog for any item.
   - `data-demo-modifier-item` stays on tiles and `data-demo-modifier-group` on groups, so the
     demo tour still works.
5. Unavailable items are disabled, with a struck-through name and a **Sold out** caption (not
   `86`). A null price is disabled with `No price`. A closed channel disables the grid and shows
   a centred notice.
6. Search (`/` or `F2`) filters across all categories by case-insensitive substring, and shows
   the result count. **Enter** adds the top result. **Esc** clears the search. An exact SKU or
   barcode match adds on Enter.
7. The `1`–`9` then `*` qty multiplier applies to the next add and shows as a toolbar chip.
8. Catalog loading shows 12 tile skeletons. A cached/stale catalog shows the toolbar chip
   `Cached menu · {age}` (warning tone).
9. `data-tour="pos-order"` moves to the catalog grid container. The demo tour e2e
   (`restaurant-demo-perspectives.spec.ts`) passes.
10. The success toast text `Item added.` is emitted for server-order adds, which keeps the e2e
    assertion.

---

## POS-UX-4: Cart column (lines, pinned totals, icon row, Pay/Send) + checkout fast path

**Scope.**

- `cart-column.tsx` and `cart-line.tsx`
- the cart header and overflow menu
- pinned totals and the icon row (Hold, Discount/Comp, Note [hidden until API-2], Print)
- the Pay/Send row
- the `checkout-panel` single-bill auto-cut
- `tender-pad` quick-tender
- decomposing `order-ticket-panel.tsx`

**Acceptance criteria**

1. The cart header shows `Order taker: {name}`, then `KOT #{latest}` / `Order #{n}` / `New
order`, then channel, table, covers and elapsed time. The `⋯` overflow menu holds Move table,
   Merge tables, Reprint KOT (one entry per ticket, accessible name `Reprint KOT {n}`),
   Hold/Fire course (only when there is more than one course) and Cancel order.
2. Lines are ≥56px with a qty stepper of 44×44 buttons.
   - Unsent lines: − decrements. At 0 the line is removed and a 5s **Undo** toast appears.
   - Sent lines: − opens the existing void dialog (reason required, manager PIN post-prep, no
     self-approval). All rules in `order-ticket-panel.tsx:125-154` are unchanged.
   - Sent lines show a status pill with a human label (Sent / Cooking / Ready / Served /
     Voided), never the raw enum.
3. Totals are **pinned**. They are never inside the lines' scroll region; with 30 lines the
   totals and Pay stay visible at 1024×768. They show Subtotal, Tax, Service (dine-in), Delivery
   fee (delivery), Comp (if any) and **Total** in `font-mono tabular-nums` at
   `--type-display-sm`. Draft totals are labelled `Estimate`.
4. The icon row has 4 × 56px buttons with icon + label, and each accessible name equals its
   label.
   - **Hold** parks the order (see POS-UX-5).
   - **Discount** opens the existing comp flow (manager co-auth) while API-3 is pending.
   - **Note** is hidden until API-2.
   - **Print** prints a pre-bill for the active order, or reprints the last receipt when the
     cart is empty.
   - No control is rendered that is dead or permanently disabled.
5. **Pay {total}** is 64px, the primary variant, and opens `checkout-panel`.
   - If no server order exists yet, Pay opens it, adds the lines, fires them (per D-3) and
     closes the order for payment before the dialog opens. Each step is idempotent and shows its
     progress in the button.
   - Offline, Pay is disabled with the inline reason `Payment needs a connection`.
6. **Send** (dine-in) replaces both `Send order` and `Send whole order`. It fires unsent lines
   and shows the toast `Order sent to kitchen.`. Update the e2e specs that click
   `Send whole order` / `Open order` in the same PR (see POS-UX-6 selector table).
7. Checkout fast path: when an order has 0 bills and unbilled items, and the operator didn't
   choose Split, the panel cuts a single bill automatically on open. **Split bill** remains one
   tap away. `Collect payment` (dialog name) and `data-tour="bill-settlement"` are preserved.
8. Tender pad:
   - Tender type is a 3-button segmented control (Cash / Card / Other) with the group labelled
     `Tender type`.
   - Cash shows quick buttons: **Exact**, the next two round notes above the due amount, and
     **Other amount** (reveals today's typed fields).
   - A takeaway cash exact sale reaches `Bill settled` in **3 taps** from idle (tile → Pay →
     Exact). This is asserted by the tap-count script.
9. Money is formatted by the shared formatter (grouping, 2 dp, currency from branch settings)
   in the cart, checkout and tender.
10. Discard of an unsent draft asks for confirmation when it has 3 or more lines. Otherwise
    Undo is offered.

---

## POS-UX-5: Draft on first tap, held orders, offline banner

**Scope.**

- local draft lifecycle
- `held-orders-sheet.tsx` (Pending orders)
- Hold/park
- `offline-banner.tsx` (reviving `offline-queue-status.tsx`)
- making the sent order active

**Acceptance criteria**

1. **Draft on first tap.** With no active order, the first tile tap creates a local draft
   carrying the channel, table, covers and customer from the rail and strip.
   - The draft is persisted to the POS client store (IndexedDB driver), so a reload or crash
     restores the cart.
   - No server request is made until Send, Hold or Pay.
   - The "Open order" form no longer exists.
2. After Send or Pay succeeds (online), the resulting server order becomes the **active order**
   in the cart. The cashier never has to find it in a list; this fixes audit P-3. When the
   order is queued offline, the cart shows it as `Queued · will send when online` until replay
   assigns the order number, then updates in place.
3. **Hold (park).**
   - Online, an unsent draft is opened on the server without firing (via `open` + `add-item`,
     with no `fire`). It's listed in Pending as `Held`, and the cart clears to a new draft.
   - Offline, it becomes a device-local parked draft labelled `On this device`.
   - Holding a sent order just clears the cart; it's still in Pending.
   - Resume restores lines, customer and table. Several held orders can coexist (see audit C-5
     for the counter-part anti-pattern).
4. **Pending orders (n)** opens a right `Sheet`.
   - Filters: All / Dine-in / Takeaway / Delivery / Offline queue / Needs review.
   - Each row shows `#n`, channel, table, item count, total, age and status (Held / Sent /
     Payment pending / Queued offline / Needs review). The accessible name starts with `#n ·`,
     which keeps the existing e2e regex `^#${orderNumber} ·`.
   - `n` = server open orders + parked + queued + needs-review.
   - The sheet refreshes on open and after replay. There is no manual Refresh button, but pull
     or refresh is still reachable from a retry affordance on error.
5. Needs-review rows show the server reason, **Send deliberately** and **Discard**. Discard
   requires confirmation (`Discard queued order #tmp-3? This can't be undone.`). A toast
   announces when a draft enters review, and the Pending button gets a warning dot.
6. **Offline banner**:
   - 36px, under the top bar, `role="status"`
   - `bg-warning/10 border-warning/30`, and the text starts with the word **Offline**
   - Copy: `Offline · New orders are saved on this device and sent when you're back online.
Payment, refunds, drawer and day close need a connection.`
   - shows the `Queued {n}` count and a **Retry now** button
   - it **never changes the height of the columns below** (the frame reserves the row with
     `grid-rows-[auto_auto_1fr]`, and the banner animates opacity only)
   - reauth-paused and revoked states reuse today's copy (`order-pad.tsx:375-394`)
7. The e2e texts `Queued 2` and `Network request failed. Retry this action.` are still
   satisfied. `Retry queued orders` is renamed **Retry now**; no e2e spec asserts the old text
   at `d9957a9a`, but update `order-pad.test.tsx` if it does.
8. Delivery stays connected-only. Offline, selecting Delivery shows an inline reason and no
   delivery data is stored locally (today's rule, `order-pad.tsx:1336-1341`).

---

## POS-UX-6: Customer strip + spec selectors (e2e migration)

**Scope.**

- `customer-strip.tsx`
- Customer search scope
- the delivery-details sheet
- migrating every POS e2e spec to the new selectors
- deleting dead code (`menu-grid` selection form, the open-order form)

**Acceptance criteria**

1. The strip is 44px.
   - Default: `Walk-in · + Add customer`.
   - Attached: `{name} · {masked identifier} · {points} pts` with **Change** and **Remove**.
     Only masked identifiers are displayed or stored.
   - Search stays connected-only, keeps the ≥2-character guard and rejects raw contact
     patterns (`order-pad.tsx:1356-1359`).
2. Attaching to a server order uses `orders/customer/attach`. On an unsent draft, the customer
   is held and attached at open. Loyalty in checkout pre-selects the attached customer.
3. Delivery:
   - The strip shows address, zone, fee, minimum and promise.
   - The existing delivery fieldset moves into `delivery-details-sheet` with identical
     validation and copy.
   - Pay/Send are disabled until customer, address and zone are set, with one inline reason
     naming what's missing.
   - The `restaurant-delivery.spec.ts` flow passes.
4. **Selector contract.** Keep these accessible names and labels, or migrate the specs in the
   same PR:

   | Selector used today (count)                                                                       | New home                                                | Action                                                        |
   | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
   | `getByLabel('Operator PIN')` (13), `getByLabel('Operator')` (11), `button 'Unlock terminal'` (11) | PIN pad lock screen                                     | keep                                                          |
   | `getByLabel('Channel')` (13)                                                                      | order-type rail (`radiogroup` labelled `Channel`)       | keep label, update interaction from `selectOption` to `click` |
   | `heading 'Order pad'` (10)                                                                        | frame `h1` (visually hidden)                            | keep                                                          |
   | `button 'Add to order'` (9)                                                                       | removed (one-tap)                                       | migrate to tile click, or `Add · …` in the modifier dialog    |
   | `button 'Open order'` (8)                                                                         | removed (draft on first tap)                            | migrate                                                       |
   | `button 'Send whole order'` (5)                                                                   | `button 'Send'`                                         | migrate                                                       |
   | `getByText('Item added.')` (6), `'Order sent to kitchen.'` (3+2)                                  | toasts                                                  | keep text                                                     |
   | `dialog 'Collect payment'` (5), `button 'Close checkout'` (2), `getByLabel('Tender type')` (3)    | checkout                                                | keep                                                          |
   | `button 'Cash drawer'` (3), `button 'Refund'` (2)                                                 | Register menu items                                     | keep names; add an "open menu" step                           |
   | `checkbox /Table 12/` (4)                                                                         | table-picker tiles (`role=checkbox`, name `Table 12 …`) | keep role and name pattern                                    |
   | `button /^#n ·/` (2)                                                                              | Pending sheet rows                                      | keep; add an "open Pending" step                              |
   | `getByText('Queued 2')` (2)                                                                       | top-bar queue pill + banner                             | keep                                                          |
   | `data-tour="pos-order"`, `data-tour="bill-settlement"`, `data-demo-modifier-*`                    | catalog grid, checkout, modifier dialog                 | keep                                                          |

   Counts come from `grep` over `tests/e2e/*.spec.ts` at `d9957a9a`.

5. These specs are green on a disposable lane:
   - `restaurant-pos-kds.spec.ts`
   - `restaurant-pos-kds-resilience.spec.ts`
   - `restaurant-foh-lifecycle-acceptance.spec.ts`
   - `restaurant-controls-final.spec.ts`
   - `restaurant-delivery.spec.ts`
   - `restaurant-input-recovery-acceptance.spec.ts`
   - `restaurant-integrated.spec.ts`
   - `restaurant-sales-demo.spec.ts`
   - `restaurant-demo-perspectives.spec.ts`
   - the new `restaurant-pos-layout.spec.ts`, with scroll and tap-count assertions for G1–G4
6. Dead code is removed: the `menu-grid.tsx` selection form, the open-order form and the
   "Composed order" and "Open orders" SectionCards. `order-pad.tsx` becomes a thin composition
   of the new components (≤ 250 lines).
