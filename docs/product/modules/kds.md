# Kitchen Display System (KDS) — Module PRD

Operator workflow: [Restaurant administrator guide](../restaurant-administrator-guide.md#7-open-the-terminal-drawer-and-kds).

**Status vocabulary:** IMPLEMENTED — present in the repository and covered by a cited verification or
source path. PLANNED — accepted design exists; implementation is not complete. MOCKED — exercised in
tests or simulation; no production hardware acceptance claimed.

**Evidence commit:** `03731baab29b29278165c7a169078d4fec897a10`

---

## 1. Purpose

The KDS module delivers a hardware-agnostic, browser-based kitchen display to every station that
needs real-time visibility into the open order queue. It replaces paper-ticket and verbal relay
workflows by surfacing a durable, server-derived view of kitchen tickets and exposing three
station-scoped actions (acknowledge, bump, recall) that advance items through the L1 item state
machine.

---

## 2. Personas

| Persona                        | Role                                | Primary concern                                                                                        |
| ------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Kitchen operator**           | Cook or expediter working a station | See only the tickets routed to my station; act on each line without mis-firing another station's items |
| **Shift manager / supervisor** | Floor supervisor                    | Confirm all stations are clearing tickets within target times; manage device enrollment                |
| **Platform / IT admin**        | Device enrollment and revocation    | Register a device as `KDS` kind and bind it to the correct station before service                      |

---

## 3. Non-goals

- **Browser and hardware acceptance** — source, jsdom, and database integration are evidenced; no
  browser compatibility matrix or production hardware acceptance has been run. Direct hardware I/O
  (bump bars and specialty KDS monitors) is not implemented or planned in this milestone.
- **Real-time push transport** — M4 deliberately omits SSE and WebSocket channels (see
  `src/lib/restaurant/kds.ts` comment, C2). The display is level-triggered bounded polling only.
- **Cross-station aggregation** — a single KDS device sees only its bound station's queue. A
  multi-station "expediter view" is not implemented.
- **Offline queue / IndexedDB** — the POS offline core (WHA-191) stores POS data offline. The KDS
  has no offline queue; if polling fails, it shows the last-known state with an alert.
- **Receipt or ticket printing** — outside the KDS module scope.
- **Customer-visible labels** — display-status labels (`NEW`, `COOKING`, `READY`, `RECALLED`) are
  system-defined and immutable in this milestone. Tenant relabelling is a future capability noted
  in the state machine comments (`src/lib/restaurant/order-state-machine.ts:153`).

---

## 4. Architecture summary

### 4.1 Transport — IMPLEMENTED

The KDS uses **bounded polling** with a sequence cursor and a gap flag
(`src/lib/restaurant/kds.ts`, `projectStationQueue`). There is no SSE or WebSocket channel (C2).

- `GET /api/restaurant/kds/queue` — returns the station's open ticket queue for the business date,
  a ticket-number high-water cursor, a `gap` flag (reconcile signal), and a `hasMore` flag when
  the open queue exceeds the `limit` parameter (default 50, max 200).
  Source: `src/app/api/restaurant/kds/queue/route.ts`
- Poll delays back off on failure: 5 s → 10 s → 20 s → 30 s
  (`src/components/restaurant/kds/kds-board.tsx`, `POLL_DELAYS`).
- Visibility and network `online` events trigger an immediate re-poll.

### 4.2 Queue projection — IMPLEMENTED

`projectStationQueue` is a pure function (no I/O). It filters tickets to those with at least one
non-cleared line (`SERVED`/`VOIDED` items are cleared), sorts oldest-first by ticket number (FIFO),
applies the bounded `limit`, and computes each ticket's rolled-up display status from the
least-advanced open line.

Source: `src/lib/restaurant/kds.ts`, `projectStationQueue`
Unit tests: `src/lib/restaurant/kds.test.ts`

### 4.3 Device gate — IMPLEMENTED

Every KDS route is guarded by two layers:

1. `withDeviceAuth` — validates the bearer device secret, checks the device is not revoked, and
   resolves the tenant DB scope via RLS (C1, C8).
   Source: `src/lib/restaurant/terminal-auth.ts`
2. `requireKdsStation` — asserts `device.kind === 'KDS'` and that the device has a non-null
   `stationId` binding. A POS device or an unbound KDS device receives a 403.
   Source: `src/lib/restaurant/kds.ts`, `requireKdsStation`

Device re-authorization happens on every route call; a revoked device is denied immediately, not
just at session establishment (C8).
DB test: `src/lib/restaurant/terminal-kds-routes.db.test.ts`

### 4.4 Business date — IMPLEMENTED

The business date defaults to the branch's configured timezone and `businessDayCutoff` as resolved
on the server at request time (DST-safe, C5). A client may supply an explicit `YYYY-MM-DD` to
query a prior date (e.g. for an overnight shift). The KDS display never trusts the client clock.

Source: `src/lib/restaurant/kds.ts`, `resolveStationBusinessDate`

### 4.5 Module / entitlement gate — IMPLEMENTED

The `/kds` route is gated by the `restaurant-pos` module key (same as POS and floor surfaces) via
`moduleForPath` in `src/lib/module-catalog.ts`. A tenant without the `restaurant-pos` module
receives a 403 before reaching any KDS handler.

The `kitchen` role bundle includes `kitchen:operate` + `orders:read` + `menu:read` + `sop:complete`
capabilities (`src/lib/vertical-catalog.ts`).

---

## 5. Item lifecycle and KDS display

### 5.1 Item-domain status → KDS display mapping — IMPLEMENTED

| Item-domain status | KDS display status | Meaning on screen                               |
| ------------------ | ------------------ | ----------------------------------------------- |
| `HELD`             | `HELD`             | Item is on hold — do not fire                   |
| `QUEUED`           | `NEW`              | Ticket just arrived at the station              |
| `FIRING`           | `COOKING`          | Kitchen has acknowledged and started cooking    |
| `PREPARED`         | `READY`            | Item is ready for service                       |
| `REMAKE_REQUESTED` | `RECALLED`         | Ready item was pulled back; needs re-fire       |
| `SERVED`           | `SERVED`           | Delivered to guest; cleared from the open queue |
| `VOIDED`           | `VOIDED`           | Voided; cleared from the open queue             |

The mapping is fixed in `src/lib/restaurant/order-state-machine.ts` (`KDS_DISPLAY_BY_ITEM_STATUS`)
and is included verbatim in every queue response payload (`displayMapping` field) so the console
can render labels against the domain without re-deriving the map client-side (C10).

### 5.2 KDS actions — IMPLEMENTED

| Action              | HTTP route                        | Target item-domain status | Source display states                             |
| ------------------- | --------------------------------- | ------------------------- | ------------------------------------------------- |
| Acknowledge (Start) | `POST /api/restaurant/kds/ack`    | `FIRING`                  | `NEW` (QUEUED)                                    |
| Bump (Mark ready)   | `POST /api/restaurant/kds/bump`   | `PREPARED`                | `COOKING` (FIRING), `RECALLED` (REMAKE_REQUESTED) |
| Recall              | `POST /api/restaurant/kds/recall` | `FIRING`                  | `READY` (PREPARED)                                |

Each action is a thin transport: it gates the KDS device + station binding (C8), requires an
idempotency key (C7), verifies the acting operator is `ACTIVE`, then delegates to the shared L2
`advanceItem` command which routes the transition through the L1 state machine and rejects illegal
edges with a 409.

Source: `src/lib/restaurant/kds.ts`, `kdsAdvanceRoute`
Action routes: `src/app/api/restaurant/kds/{ack,bump,recall}/route.ts`

### 5.3 Ticket roll-up — IMPLEMENTED

A ticket's displayed status is the least-advanced open line. Rank order (most urgent first):
`QUEUED` → `REMAKE_REQUESTED` → `FIRING` → `PREPARED`. A recalled line outranks a cooking line
so it draws attention. A ticket reads `READY` only once every open line is at least `PREPARED`.

Source: `src/lib/restaurant/kds.ts`, `ticketDisplayStatus` / `OPEN_ITEM_RANK`

### 5.4 Idempotency — IMPLEMENTED

KDS action routes require an `Idempotency-Key` header. The `(deviceId, key)` pair is deduplicated
at the L2 command layer; a replay returns the original result and creates nothing (C7).

The KDS board client generates a UUID per intent and reuses it on network retries, but clears the
key on a successful response so the next tap on the same item is treated as a fresh intent.

Source: `src/lib/restaurant/kds-board.tsx`, `keyFor` / `idempotencyKeys`
DB test: `src/lib/restaurant/terminal-kds-routes.db.test.ts` (idempotent replay assertions)

---

## 6. Station and display workflows

### 6.1 Connect flow

1. An administrator opens `/restaurant/devices` on the intended browser, chooses the branch, KDS
   kind, and named station, then confirms **Enroll this browser**. Administration signs out and the
   dedicated browser opens `/kds`.
2. KDS establishes the enrolled device automatically, loads eligible operators, and asks the
   operator to select their name and enter their individual PIN. The PIN is held only for unlock.
3. On unlock, the board begins polling `GET /api/restaurant/kds/queue`. A 401/403 response
   disconnects and clears credentials.

Source: `src/components/restaurant/kds/kds-board.tsx`, `connect` / `KdsBoard`

### 6.2 Direct-delivery handoff

The Delivery handoff board lists same-branch orders eligible for PREPAID or COD handoff. Once
kitchen work is ready, the operator confirms **Dispatch order**, then confirms **Mark delivered**
after completion. PREPAID must be paid before dispatch; COD retains collection due. Both transitions
are connected, authenticated, and idempotent, and rejected readiness/payment states remain visible.

Source: `src/components/restaurant/kds/delivery-board.tsx`,
`src/app/api/restaurant/kds/delivery/queue/route.ts`, and
`src/app/api/restaurant/kds/delivery/transition/route.ts`

### 6.3 Normal queue display

- The board renders four swimlane columns: **NEW**, **COOKING**, **READY**, **RECALLED**.
- Each ticket card shows: ticket number, order number, ticket age (minutes), line items with
  quantity, course, seat, and hold/fire status.
- A `HELD` item shows `HOLD — DO NOT FIRE` inline; no action button is rendered for `HELD` or
  cleared items.
- Each actionable item has a single context-sensitive action button (`Start`, `Mark ready`,
  `Recall`). Only one mutation can be in flight at a time; the board disables all action buttons
  while a request is pending.

Source: `src/components/restaurant/kds/kds-board.tsx`

### 6.4 Gap and overflow recovery

- **Cursor gap** — when the server returns `gap: true` (sequence regression or overflow), the
  client immediately performs a full reconcile poll (no `sinceCursor`). This makes the display
  level-triggered: it is always correct regardless of what the client's cursor holds.
- **Overflow** — when `hasMore: true` the board shows a warning banner: "Queue exceeds the bounded
  50-ticket view. Showing the authoritative window." Tickets are returned FIFO by ticket number
  (oldest first).
- **Network failure** — the board shows the last confirmed station state with a `degraded`
  StatusPill and a banner noting recovery in progress. A manual "Retry now" button is available.

Source: `src/components/restaurant/kds/kds-board.tsx`, `loadQueue`

### 6.4 Disconnect

The board's disconnect button increments an epoch counter, clears all state, and returns to the
credential form. A 401/403 on any poll or mutation triggers an automatic disconnect with an error
banner.

---

## 7. Permissions and branch isolation

### 7.1 RLS tenant scope — IMPLEMENTED

All KDS reads and writes are scoped by Postgres RLS to the device's organization. A device
belonging to tenant A cannot read or mutate tenant B's tickets, orders, or stations — the query
simply returns no rows (C1, C8).

DB test: `src/lib/restaurant/terminal-kds-routes.db.test.ts` (cross-tenant probe returns 404, not
leaked data)

### 7.2 Station isolation — IMPLEMENTED

`resolveStationOrderItem` verifies that an `orderItemId` was routed to the device's bound station
before any KDS action is permitted. A device cannot bump or acknowledge items on another station's
queue (C8).

Source: `src/lib/restaurant/kds.ts`, `resolveStationOrderItem`

### 7.3 Capability gate — IMPLEMENTED

The `kitchen:operate` capability is required for staff operating the KDS. The `kitchen` role bundle
is seeded with this capability. Platform routes run under `is_platform_admin = true` and bypass
tenant RLS as documented in the platform commands note in MEMORY; tenant-facing KDS routes do not
run under any bypass flag.

Source: `src/lib/vertical-catalog.ts`

### 7.4 Device revocation — IMPLEMENTED

A revoked device is rejected on every route call (device record is re-read, not cached).

Source: `src/lib/restaurant/terminal-auth.ts`

---

## 8. Accessibility and interaction states

- A skip-to-content link (`Skip to kitchen display`) is the first focusable element in the KDS
  shell (WCAG 2.4.1).
- Status banners use `role="alert"` or `role="status"` and `aria-live="polite"` as appropriate.
- The main content area carries `aria-busy` while a poll or mutation is in flight.
- Action buttons carry `aria-label` with item name and order number for screen reader context.
- The board is responsive: 1-column on mobile, 2-column on `md`, 4-column on `xl`.

Source: `src/components/restaurant/kds/kds-board.tsx`

---

## 9. User stories

| ID    | As a…            | I want to…                                                               | So that…                                                                       |
| ----- | ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| KDS-1 | Kitchen operator | See only my station's open tickets, sorted oldest-first                  | I process tickets in the order they arrived                                    |
| KDS-2 | Kitchen operator | Tap Start on a NEW item to move it to COOKING                            | The POS and floor staff know the item is being prepared                        |
| KDS-3 | Kitchen operator | Tap Mark ready when an item is plated                                    | The floor server can pick it up and the ticket clears once all lines are ready |
| KDS-4 | Kitchen operator | Recall a READY item to COOKING                                           | A plating error or delay is reflected immediately without a separate system    |
| KDS-5 | Kitchen operator | See a HOLD badge on held items and have no action button rendered        | I never inadvertently fire a held course                                       |
| KDS-6 | Kitchen operator | Have tapped actions idempotent on network retry                          | A double-tap or network hiccup does not create duplicate state transitions     |
| KDS-7 | Kitchen operator | See an error banner and last-known state on network failure              | I maintain situational awareness even when polling degrades                    |
| KDS-8 | Shift manager    | Revoke a device mid-service and have the screen reject all further calls | A compromised or repurposed device cannot continue acting as a KDS             |
| KDS-9 | Platform admin   | Bind a device to a specific station during enrollment                    | Only that station's queue is visible on this screen                            |

---

## 10. Acceptance criteria

| #    | Criterion                                                                                                                                            | Status      | Evidence                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| AC1  | `GET /api/restaurant/kds/queue` returns only the bound station's tickets, scoped by RLS to the device's organization                                 | IMPLEMENTED | `src/lib/restaurant/kds.ts:readStationQueue`; `tests/restaurant-m4-kitchen-flow.test.ts` line 395                     |
| AC2  | A POS device or an unbound KDS device receives 403 from all KDS routes                                                                               | IMPLEMENTED | `src/lib/restaurant/kds.ts:requireKdsStation`; `src/lib/restaurant/terminal-kds-routes.db.test.ts`                    |
| AC3  | `ACK` transitions `QUEUED → FIRING`; `BUMP` transitions `FIRING → PREPARED` or `REMAKE_REQUESTED → FIRING`; `RECALL` transitions `PREPARED → FIRING` | IMPLEMENTED | `src/lib/restaurant/kds.ts:KDS_ACTION_TRANSITIONS`; `src/lib/restaurant/order-state-machine.ts:128–130`               |
| AC4  | An out-of-order KDS action (e.g. bumping a QUEUED item) returns 409                                                                                  | IMPLEMENTED | `advanceItem` in `src/lib/restaurant/orders.ts` via `assertItemTransition`; DB test covers illegal-edge rejection     |
| AC5  | A revoked device is rejected on every call, not just at session establishment                                                                        | IMPLEMENTED | `src/lib/restaurant/terminal-auth.ts`; `src/lib/restaurant/terminal-kds-routes.db.test.ts` (revocation mid-flow test) |
| AC6  | An idempotent replay of `(deviceId, key)` returns the original result and creates nothing                                                            | IMPLEMENTED | `src/lib/restaurant/terminal-kds-routes.db.test.ts` (idempotent replay block)                                         |
| AC7  | The queue is level-triggered: a gap flag triggers a full reconcile, so the display is correct regardless of cursor state                             | IMPLEMENTED | `src/lib/restaurant/kds.ts:projectStationQueue`; `src/lib/restaurant/kds.test.ts` (gap tests)                         |
| AC8  | Business date defaults to branch timezone + cutoff resolved server-side (C5, DST-safe)                                                               | IMPLEMENTED | `src/lib/restaurant/kds.ts:resolveStationBusinessDate`                                                                |
| AC9  | `HELD` items show `HOLD — DO NOT FIRE` and have no action button                                                                                     | IMPLEMENTED | `src/components/restaurant/kds/kds-board.tsx` (`ACTIONS` map has no `HELD` entry)                                     |
| AC10 | A cross-tenant probe on KDS routes is indistinguishable from "not found"                                                                             | IMPLEMENTED | `src/lib/restaurant/terminal-kds-routes.db.test.ts` (cross-tenant assertions)                                         |
| AC11 | The board renders 4 swimlane columns responsive to viewport; skip-to-content link present                                                            | IMPLEMENTED | `src/components/restaurant/kds/kds-board.tsx` (CSS grid, KdsShell skip link)                                          |
| AC12 | Browser and production-hardware compatibility are not claimed                                                                                        | NOT CLAIMED | Current evidence is source, jsdom, and database integration; no browser/hardware matrix was run                       |

---

## 11. Known limitations and future work

| Item                                                                               | Status      | Notes                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SSE / WebSocket push                                                               | PLANNED     | M4 explicitly omits a push channel (C2). Level-triggered polling is the current transport. A future milestone may add SSE/WebSocket for lower latency. |
| Multi-station expediter view                                                       | PLANNED     | Not implemented; a future PRD would define a cross-station aggregate display.                                                                          |
| Offline queue                                                                      | PLANNED     | The POS offline core (WHA-191) covers POS; KDS has no offline queue.                                                                                   |
| Tenant-relabelled display statuses                                                 | PLANNED     | The state-machine comment (`src/lib/restaurant/order-state-machine.ts:153`) notes display strings may be relabelled; the feature is not implemented.   |
| Hardware bump-bar input                                                            | FUTURE      | No hardware integration exists or is planned in the current web scope.                                                                                 |
| Bump-bar / hardware confirmation that acceptance tests pass on production hardware | NOT CLAIMED | Tests use jsdom / real-DB integration only. No production hardware acceptance is claimed from simulations. See M9 preflight notes (WHA-126).           |

---

## 12. Document provenance

This PRD is reconciled against commit `03731baab29b29278165c7a169078d4fec897a10`.
Every IMPLEMENTED claim cites a source file, migration, test, or explicit owner decision at that
commit. PLANNED and FUTURE items are clearly distinguished. No browser, hardware, or network production
acceptance is claimed from simulation or integration-test results.

Last authored: 2026-08-28.
